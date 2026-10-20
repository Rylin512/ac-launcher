#!/usr/bin/env node
// AgileCampus 部署与运控面板 —— 控制平面入口。
//
// 设计要点：
//  · 只用 Node 内置模块。面板必须在 npm ci 之前就能跑起来（它负责触发 npm ci），
//    任何第三方依赖都会变成「装不上就彻底没界面」的死锁。
//  · 只监听 127.0.0.1。控制平面不出本机。
//  · 对仓库目录全程只读，所有写入落在运行目录。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  PANEL_VERSION,
  resolveRuntimeDir,
  resolveRepoDir,
  REPO_DIR_PROBLEM,
  pathsFor,
  ensureDirs,
  loadConfig,
  saveConfig,
  randomToken,
  readEnvText,
  envToObject,
  writeEnv,
  writeJson,
  templatePlaceholders,
  SECRET_KEY_RE,
  // 端口 → 派生数据的三件套。实现在 lib/config.mjs，因为中枢的「重新分配端口」
  // 也要用同一份（端口一改，databaseUrl 与 .env 必须跟着改对）。下面有同名薄包装，
  // 所以本文件里那 ~15 个调用点一行都不用改。
  portableDsn as cfgPortableDsn,
  normalizeDbConfig as cfgNormalizeDbConfig,
  ensureEnvFile as cfgEnsureEnvFile,
} from './lib/config.mjs';
// HTTP 基础设施与三层护栏都从 lib/http.mjs 来，与中枢共用同一份实现。
import { json, fail, readBody, sse, openBrowser, createGuard, tokenSet } from './lib/http.mjs';
import {
  portFree,
  pickFreePort,
  waitForPort,
  httpProbe,
  systemCpuPercent,
  lanIp,
  interfaces,
  memInfo,
  diskInfo,
  pidAlive,
  processStartTime,
  processRss,
  processCpuSeconds,
  isElevated,
} from './lib/sysinfo.mjs';
import { JobRegistry, spawnInto, detachedJob } from './lib/jobs.mjs';
import {
  startApp,
  stopApp,
  restartApp,
  appStatus,
  readAppState,
  killTree,
  recordStarted,
  readTail,
  tailFile,
  touch,
} from './lib/process.mjs';
import * as pg from './lib/pg.mjs';
import * as dep from './lib/deploy.mjs';
import * as doctor from './lib/dbdoctor.mjs';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ui');
const argv = process.argv.slice(2);
const runtimeDir = resolveRuntimeDir(argv);

// 先解析仓库、**判空之后才建目录**。顺序反过来的话，一次 --repo 配错的启动
// 也会先凭空建出一整套运行目录，然后才拒绝干活。
const repoDir = resolveRepoDir(argv, runtimeDir);
if (!repoDir) {
  console.error('面板启动失败：' + (REPO_DIR_PROBLEM || '未指定项目仓库。'));
  process.exit(2);
}
const P = ensureDirs(pathsFor(runtimeDir, repoDir));
let cfg = loadConfig(P);
const registry = new JobRegistry();
/** 注入进 HTML、给浏览器用的令牌。 */
const TOKEN = randomToken(24);
/**
 * 护栏实际接受的令牌集合 = 上面那个 + 中枢下发的监督令牌（只走环境变量，绝不写进 HTML）。
 * 构造与检查都在 lib/http.mjs，安全策略只有那一处实现。
 */
const TOKENS = tokenSet(TOKEN);
const STARTED_AT = Date.now();

/**
 * 「退出面板」的停止阶段最多允许跑多久，到点就**先退出再说**。
 *
 * 它挡的是「永远」，不是「慢」：合法路径的最坏情况是把库停下来，
 * `pg_ctl -w -t 60` 最多 60 秒、等端口释放 10 秒、spawnInto 的超时 90 秒，
 * 所以 120 秒之内都算正常。真正要防的是等待一个**永远不会 settle 的 Promise**
 * （见 shutdown 分支里那段注释）——那会让面板变成杀不掉的僵尸，
 * 而界面早就告诉用户「面板已退出」了。
 *
 * 到点退出时会**照实写日志**说应用/数据库可能还在跑，不假装停干净了。
 */
const SHUTDOWN_DEADLINE_MS = 120000;

const logStream = fs.createWriteStream(P.panelLog, { flags: 'a' });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  logStream.write(line);
  if (process.env.AC_VERBOSE) process.stdout.write(line);
}
for (const f of [P.appLog, P.appErrLog, P.pgLog, P.buildLog, P.panelLog]) touch(f);

// 启动时先修一次历史配置：早期版本在便携模式下漏了派生连接串，
// 修好之后本机上已经建好的库可以直接继续用，不必重装。
if (normalizeDbConfig()) saveConfig(P, cfg);

// 把「这个运行目录属于哪个仓库」记进配置。
//
// 旧版面板从不写这个键——它的仓库是从自己的文件位置推出来的（deploy/ 长在仓库
// 内部，上溯两级就是仓库）。于是运行目录里唯一记着仓库的地方是 run/panel.lock，
// 而锁是易失的：删掉、覆盖、或被谁清理一次，这条线索就断了。写进配置之后它是
// 持久的，下一次不带 --repo 也认得路（resolveRepoDir 的第三层就读这里）。
if (cfg.repoDir !== P.repoDir) {
  cfg.repoDir = P.repoDir;
  saveConfig(P, cfg);
}

// 顺手把 .env 也修一遍。历史上「保存 .env」用仓库模板当骨架，会把没被改的键
// 打回模板占位值，而这条破坏路径完全无声：界面照常、日志只写「已更新 .env」，
// 唯一的表现是应用连不上库。这里提前治好，别让用户自己撞上。
// 只在 .env 已存在时做——没部署过就没有可修的东西。
// （注意：修完 .env 后要让用户重启应用才生效，界面上有专门提示。）
if (fs.existsSync(P.envFile)) {
  try {
    if (ensureEnvFile(false)) log('启动时修正了 .env 中与面板配置不一致的项，需重启应用生效。');
  } catch (e) {
    log('启动时修正 .env 失败：', e.message);
  }
}

// --------------------------------------------------------------- 状态采集缓存

const cache = {
  cpu: { at: 0, value: null },
  procCpu: { at: 0, pid: null, value: null, lastSeconds: null },
  deep: { at: 0, value: null },
  // 检修结果。诊断要起好几个 psql 子进程，不能进 2s 轮询，
  // 所以只在用户点「体检」时算一次，结果缓存下来给状态卡当徽标用。
  dbDoctor: { at: 0, value: null },
  disk: { at: 0, value: null },
  net: { at: 0, value: null },
  // 源码树哈希要遍历 100 多个文件，不能每 2 秒算一次
  srcHash: { at: 0, hash: null },
};
const dbDoctorCache = cache.dbDoctor;

async function sampleProcessCpu(pid) {
  const now = Date.now();
  if (!pid) return null;
  if (cache.procCpu.pid !== pid) cache.procCpu = { at: 0, pid, value: null, lastSeconds: null };
  if (now - cache.procCpu.at < 5000) return cache.procCpu.value;
  const seconds = await processCpuSeconds(pid);
  const prev = cache.procCpu.lastSeconds;
  let pct = null;
  if (seconds !== null && prev !== null) {
    const dt = (now - cache.procCpu.at) / 1000;
    // CPU 是累计处理器秒数，除以「墙钟时长 × 核心数」才是占用率
    if (dt > 0) pct = Math.max(0, Math.min(100, ((seconds - prev) / (dt * os.cpus().length)) * 100));
  }
  cache.procCpu = { at: now, pid, value: pct, lastSeconds: seconds };
  return pct;
}

/**
 * 深度探针：打 /api/agent/projects 并伪造一个「格式合法但无效」的 token。
 *
 * 为什么必须是 ac_ 前缀：verifyApiToken 对不以 ac_ 开头的串会在触库之前就返回 null，
 * 那样 401 就只能证明「应用收到了请求」，证明不了数据库可用。
 * 用合法格式的假 token，401 才意味着：应用活着 ∧ 数据库连得上 ∧ api_tokens 表存在。
 *
 * 绝不用 /api/cron/reminders 做探针——它会给真人发飞书提醒。
 */
async function deepProbe(force = false) {
  const now = Date.now();
  if (!force && now - cache.deep.at < 30000) return cache.deep.value;
  const app = await appStatus(P, cfg);
  if (app.state !== 'running') {
    cache.deep = { at: now, value: { ok: false, verdict: 'app-down', status: null, at: now } };
    return cache.deep.value;
  }
  const fake = `ac_${crypto.randomBytes(48).toString('base64url')}`;
  const r = await httpProbe(`http://127.0.0.1:${cfg.appPort}/api/agent/projects`, {
    timeout: 3500,
    headers: { Authorization: `Bearer ${fake}` },
  });
  let verdict = 'unexpected';
  if (r.status === 401) verdict = 'all-ok';
  else if (r.status === 500) verdict = 'db-error';
  else if (r.status === null) verdict = 'app-down';
  cache.deep = { at: now, value: { ok: verdict === 'all-ok', verdict, status: r.status, ms: r.ms, error: r.error, at: now } };
  return cache.deep.value;
}

async function collectState() {
  // 系统 CPU 占用率靠两次 tick 求差，所以每次采集都顺手采一次样
  cache.cpu.value = systemCpuPercent();
  const app = await appStatus(P, cfg);
  const [db, net] = await Promise.all([pg.pgStatus(P, cfg), lanIp()]);

  if (Date.now() - cache.net.at > 30000) cache.net = { at: Date.now(), value: net };
  const netVal = cache.net.value;

  const parsedDsn = cfg.databaseUrl ? pg.parseDsn(cfg.databaseUrl) : null;
  // 密码不进 /api/state：这个端点是只读的、不带令牌就能取，
  // 回明文等于把库口令散进界面 DOM、截图与任何 dump 状态的地方。
  // 界面要展示的是「连哪里、用什么账号」，口令本身另有专门的查看入口。
  const core = parsedDsn ? { ...parsedDsn, password: undefined, hasPassword: Boolean(parsedDsn.password) } : null;
  const deep = app.state === 'running' ? await deepProbe() : null;

  const appProbe = app.state === 'running' ? await httpProbe(`http://127.0.0.1:${cfg.appPort}/`, { timeout: 2500 }) : null;
  const rss = app.state === 'running' ? await processRss(app.pid) : null;
  const cpuPct = app.state === 'running' ? await sampleProcessCpu(app.pid) : null;

  if (Date.now() - cache.disk.at > 30000) {
    cache.disk = { at: Date.now(), value: await diskInfo(P.runtime) };
  }

  if (Date.now() - cache.srcHash.at > 30000) {
    cache.srcHash = { at: Date.now(), hash: dep.sourceChanged(P, cfg).hash };
  }

  const env = envToObject(readEnvText(P));
  const tmplEnv = templatePlaceholders(P);
  const warnings = [];
  if (/[^\x20-\x7e]/.test(P.runtime)) {
    warnings.push({ level: 'warn', code: 'NON_ASCII_PATH', text: `运行目录路径含非 ASCII 字符，PostgreSQL 在此类路径上偶发异常，建议改用 D:\\ac-runtime 这类纯 ASCII 路径。` });
  }
  if (app.state === 'orphan') {
    warnings.push({ level: 'warn', code: 'ORPHAN', text: `端口 ${app.port} 被一个不受本面板管理的进程占用。为免误杀，面板不会自动处理它。` });
  }
  if (cfg.databaseUrl && core && core.host !== '127.0.0.1' && core.host !== 'localhost') {
    warnings.push({ level: 'info', code: 'REMOTE_DB', text: `数据库位于 ${core.host}，请确认网络可达且防火墙放行。` });
  }
  if (!env.DEEPSEEK_API_KEY) warnings.push({ level: 'info', code: 'NO_AI', text: '未配置 DEEPSEEK_API_KEY，AI 助手功能不可用（其余功能不受影响）。' });
  if (!env.FEISHU_APP_ID || !env.FEISHU_APP_SECRET) warnings.push({ level: 'info', code: 'NO_FEISHU', text: '未配置飞书应用，飞书登录与消息提醒不可用。' });
  if (!dep.standaloneReady(P)) warnings.push({ level: 'warn', code: 'NOT_BUILT', text: '尚未构建。请在向导里完成首次部署。' });

  // .env 与面板配置脱节，是「应用连不上数据库、而面板一切显示正常」的经典成因：
  // 面板的端口浅检查的是 cfg.pgPort，应用读的却是 .env 里的连接串，两者可以
  // 各说各话。必须显式报警，否则只能靠人去猜。
  const envDsn = env.DATABASE_URL;
  if (cfg.dbMode === 'portable' && cfg.databaseUrl && envDsn !== cfg.databaseUrl) {
    const where = (d) => (d ? (() => { const x = pg.parseDsn(d); return x ? `${x.host}:${x.port}` : '无法解析'; })() : '空');
    warnings.push({
      level: 'fail',
      code: 'ENV_DSN_MISMATCH',
      text: `.env 里的 DATABASE_URL 指向 ${where(envDsn)}，而面板配置与便携数据库都在 ${where(cfg.databaseUrl)} —— 应用连不上数据库。用「检修数据库」一键修复，或「重启应用」前先确认 .env。`,
    });
  }
  if (env.AUTH_SECRET && tmplEnv.AUTH_SECRET && env.AUTH_SECRET === tmplEnv.AUTH_SECRET) {
    warnings.push({
      level: 'fail',
      code: 'AUTH_SECRET_PLACEHOLDER',
      text: 'AUTH_SECRET 仍是仓库 .env.example 里的公开占位值，任何人都能伪造会话。用「检修数据库」重新生成（会使现有登录失效）。',
    });
  }
  if (!env.AUTH_TRUST_HOST) {
    warnings.push({
      level: 'fail',
      code: 'NO_TRUST_HOST',
      text: '缺少 AUTH_TRUST_HOST=true，Auth.js 会拒绝非 localhost 的请求并报 UntrustedHost。用「检修数据库」一键补上。',
    });
  }
  warnings.push({ level: 'info', code: 'FIREWALL', text: '局域网访问需要 Windows 防火墙放行 node.exe；若局域网打不开，请检查系统弹窗授权。' });

  const mem = memInfo();
  return {
    panel: {
      pid: process.pid,
      port: actualPanelPort,
      version: PANEL_VERSION,
      uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
      runtimeDir: P.runtime,
      repoDir: P.repoDir,
      nodeVersion: process.version,
      elevated: await isElevated(),
    },
    app: {
      ...app,
      urlLocal: `http://localhost:${app.port}`,
      urlLan: netVal?.ip ? `http://${netVal.ip}:${app.port}` : null,
      httpStatus: appProbe?.status ?? null,
      httpMs: appProbe?.ms ?? null,
      probeOk: Boolean(appProbe?.ok),
      proc: { rssBytes: rss, cpuPercent: cpuPct },
      builtAt: cfg.builtAt,
      sourceHash: cfg.sourceHash ? `${cfg.sourceHash.slice(0, 18)}…` : null,
      sourceChanged: cfg.sourceHash ? cfg.sourceHash !== cache.srcHash.hash : null,
      logTail: readTail(P.appLog, 5).lines.map((l) => l.text),
    },
    db: { ...db, deep, core },
    // 上一次检修的结果（可能为 null = 从没检修过）。诊断很贵，不进轮询。
    dbDoctor: dbDoctorCache.value ? { ...dbDoctorCache.value, stale: Date.now() - dbDoctorCache.at > 120000 } : null,
    host: {
      platform: process.platform,
      cores: os.cpus().length,
      cpuPercent: cache.cpu.value,
      memTotalBytes: mem.totalBytes,
      memFreeBytes: mem.freeBytes,
      uptimeSec: os.uptime(),
      disk: cache.disk.value,
    },
    net: { lanIp: netVal?.ip || null, lanIpSource: netVal?.source || null, interfaces: interfaces() },
    ports: { appPort: cfg.appPort, pgPort: cfg.pgPort, panelPort: actualPanelPort },
    jobs: registry.summary(),
    config: {
      appPort: cfg.appPort,
      pgPort: cfg.pgPort,
      panelPort: cfg.panelPort,
      registry: cfg.registry,
      autoOpenBrowser: cfg.autoOpenBrowser,
      mirror: cfg.mirror,
      dbMode: cfg.dbMode,
      builtAt: cfg.builtAt,
      deepseekConfigured: Boolean(env.DEEPSEEK_API_KEY),
      feishuConfigured: Boolean(env.FEISHU_APP_ID && env.FEISHU_APP_SECRET),
      envPath: P.envFile,
    },
    warnings,
    serverTime: Date.now(),
  };
}

// --------------------------------------------------------------- HTTP 基础设施
// json / fail / readBody / sse / openBrowser / createGuard 全部来自 lib/http.mjs，
// 与中枢共用同一份——护栏只要有两份拷贝，早晚有一份会漏掉某个检查。

// --------------------------------------------------------------- 长任务启动器

function startJob(kind, title, steps, fn, logFile = null) {
  let job;
  try {
    job = registry.create(kind, title, steps);
  } catch (e) {
    if (e.code === 'JOB_BUSY') {
      const err = new Error(e.message);
      err.code = 'JOB_BUSY';
      err.runningJobId = e.runningJobId;
      throw err;
    }
    throw e;
  }
  job.registry = registry; // spawnInto 靠它把子进程登记进来，取消时统一按进程树杀掉
  const sink = logFile ? fs.createWriteStream(logFile, { flags: 'a' }) : null;
  job.subscribe((ev) => {
    if (sink && ev.type === 'log') sink.write(`[${new Date(ev.entry.ts).toISOString()}] ${ev.entry.text}\n`);
  });
  log(`任务开始 ${job.id} ${title}`);
  (async () => {
    try {
      await fn(job);
      job.finish('succeeded');
      log(`任务成功 ${job.id}`);
    } catch (e) {
      job.log('err', `\n✗ ${e.message}`);
      if (e.plan) job.log('err', `\n变更计划：\n${e.plan}`);
      job.finish('failed', e);
      log(`任务失败 ${job.id}：${e.message}`);
    } finally {
      sink?.end();
    }
  })();
  return job;
}

// --------------------------------------------------------------- 业务动作

const deps = {
  pg,
  proc: { startApp, stopApp, restartApp, appStatus, readAppState, killTree },
  dep,
  sysinfo: { pidAlive },
  repoDir: P.repoDir,
};

/**
 * 给「只读诊断」用的 job。
 *
 * diagnose() 内部要用 spawnInto 跑 psql，而 spawnInto 需要一个 job 来收原始输出；
 * 但诊断是只读的、不该占用全局那个「同一时刻只允许一个长任务」的名额，
 * 否则用户点一下体检就会把正在跑的部署挡掉。
 * 所以用 detachedJob：真 Job 的行为，但不进 registry。
 */
function quietJob() {
  return detachedJob('db-doctor', '数据库检修（只读诊断）', ['检查']);
}

async function opStart(P_, cfg_, job) {
  job.step(0);
  const st = await appStatus(P_, cfg_);
  if (st.state === 'running') {
    job.log('out', '应用已经在运行。');
    return;
  }
  const free = await portFree(cfg_.appPort);
  if (!free) {
    // 被中枢管着时不自己找替代端口。
    //
    // 原先这里从一张硬编码候选表里挑一个并持久化，而它**完全不知道别的项目预约了
    // 什么**——于是可能抢走别人的端口，且不留任何痕迹（registry.mjs head 的规则 2
    // 说的就是这个）。面板进程看不到注册表：它的运行目录是 <数据根>\projects\<slug>，
    // 预约集合在 <数据根>\projects.json，靠运行目录上溯两级去猜数据根是
    // config.mjs 明确拒绝的那类推断。所以正确的做法是把分配权交回唯一看得见注册表
    // 的那一方——中枢的「重新分配端口」。
    //
    // 独立跑面板（--repo，没有中枢）时保留旧的自动回退：那时没有中枢可回退，
    // 报错等于让用户只能去手改 panel.json，而那正是要消除的动作。
    if (process.env.AC_HUB === '1') {
      const e = new Error(
        `端口 ${cfg_.appPort} 被占用。端口由中枢统一分配，请回到中枢对这个项目执行「重新分配端口」` +
          `（它会挑一组空闲端口、同步全部派生数据并重启服务）。`
      );
      e.code = 'PORT_BUSY_MANAGED';
      throw e;
    }
    const alt = await pickFreePort([cfg_.appPort + 1, 3080, ...Array.from({ length: 20 }, (_, i) => 3100 + i)]);
    job.log('err', `端口 ${cfg_.appPort} 被占用，自动改用 ${alt}。（独立运行模式：这个改动绕过了中枢的端口预约）`);
    cfg_.appPort = alt;
    saveConfig(P_, cfg_);
  }
  if (!dep.standaloneReady(P_)) {
    const e = new Error('尚未构建，无法启动。请先执行「首次部署」。');
    e.code = 'NOT_BUILT';
    throw e;
  }
  const child = startApp(P_, cfg_, (m) => job.line('out', m));
  if (!(await waitForPort(cfg_.appPort, true, { timeout: 60000, interval: 400 }))) {
    throw new Error('端口在 60s 内没有就绪，请查看「应用错误日志」。');
  }
  await recordStarted(P_, cfg_, child.pid);
  const probe = await httpProbe(`http://127.0.0.1:${cfg_.appPort}/`, { timeout: 3000 });
  job.log('out', probe.ok ? `启动成功：HTTP ${probe.status}` : '端口已就绪，但 HTTP 探针未通过。');
}

async function opStop(P_, cfg_, job) {
  job.step(0);
  await stopApp(P_, cfg_, (m) => job.line('out', m));
  job.log('out', '应用已停止。');
}

async function opRebuild(P_, cfg_, job, body) {
  await dep.rebuildAll(P_, cfg_, job, deps, body);
  cfg.builtAt = Date.now();
  cfg.sourceHash = dep.sourceChanged(P_, cfg_).hash;
  saveConfig(P_, cfg);
  job.log('out', '重新部署完成。');
}

async function opSetup(P_, cfg_, job, body) {
  // 数据库模式先落定，deployAll 依赖它
  if (body.dbMode === 'external' && body.databaseUrl) {
    cfg.dbMode = 'external';
    cfg.databaseUrl = body.databaseUrl;
  } else {
    cfg.dbMode = 'portable';
    if (!cfg.pgPassword) cfg.pgPassword = randomToken(18);
    // 便携模式的连接串必须在这里派生出来。漏了它，后面 drizzle-kit 会因为
    // 拿不到 DATABASE_URL 而报「Either connection "url" ... are required」。
    normalizeDbConfig();
  }
  if (body.appPort) cfg.appPort = Number(body.appPort);
  if (body.registry !== undefined) cfg.registry = body.registry;
  saveConfig(P_, cfg);

  // .env 必须在 deployAll **之前**写：部署的第 7 步会把应用启动起来，而应用
  // 需要 AUTH_SECRET（Auth.js 没有它直接起不来）与 DATABASE_URL。放在 deployAll
  // 之后写等于让首次启动在一个没有 .env 的环境里裸跑——应用进程能拉起来，但
  // 连不上库、签不出会话，最后报成「端口 60s 内没有就绪」这种看不出病因的错。
  // 此刻 cfg.databaseUrl 已经派生好（便携模式走 normalizeDbConfig），依赖齐全。
  // 源码同步会跳过 .env 系列，所以先写也不会被覆盖。
  ensureEnvFile(true);

  await dep.deployAll(P_, cfg, job, deps, {
    mirror: Boolean(body.mirror),
    forceDeps: Boolean(body.forceDeps),
    confirmDestructive: Boolean(body.confirmDestructive),
    allowWipePgData: Boolean(body.allowWipePgData),
    skipStart: Boolean(body.skipStart),
  });

  cfg.builtAt = Date.now();
  cfg.sourceHash = dep.sourceChanged(P_, cfg).hash;
  saveConfig(P_, cfg);
  job.log('out', '首次部署完成。');
}

// 下面三个是 lib/config.mjs 里那三个函数的薄包装：把本文件的模块级 P/cfg/log 喂进去，
// 让既有调用点保持原样。实现只有一份，中枢与面板共用——端口一改，databaseUrl 与 .env
// 必须跟着改对，而两处各写一份「怎么从端口推派生数据」正是 writeEnv 注释里那次
// 事故的同源病因。
// 必须是 function 声明而非 const 箭头函数：下面第 101 行（模块顶层）就要调
// normalizeDbConfig()，而 const 有暂时性死区——写成箭头函数会在启动时直接
// "Cannot access 'normalizeDbConfig' before initialization"。函数声明的提升没有这个问题。
function portableDsn() {
  return cfgPortableDsn(cfg);
}
function normalizeDbConfig() {
  return cfgNormalizeDbConfig(cfg);
}
function ensureEnvFile(regenerate = false) {
  return cfgEnsureEnvFile(P, cfg, log, { regenerate });
}

// --------------------------------------------------------------- 路由

const LOG_FILES = { app: () => P.appLog, apperr: () => P.appErrLog, pg: () => P.pgLog, build: () => P.buildLog, panel: () => P.panelLog };

async function route(req, res, u) {
  const p = u.pathname;
  const method = req.method;

  // ---- 静态界面
  if (method === 'GET' && (p === '/' || p === '/index.html')) {
    let html;
    try {
      html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
    } catch {
      return fail(res, 500, '找不到界面文件 deploy/ui/index.html');
    }
    html = html.replace('__AC_TOKEN__', TOKEN).replace('__AC_PANEL_PORT__', String(actualPanelPort));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(html);
  }

  // ---- 状态
  if (method === 'GET' && p === '/api/state') return json(res, 200, await collectState());

  if (method === 'GET' && p === '/api/stream') {
    const es = sse(req, res);
    let busy = false;
    const push = async () => {
      if (busy || es.closed) return;
      busy = true;
      try {
        es.send('state', await collectState());
      } catch {
      } finally {
        busy = false;
      }
    };
    push();
    const timer = setInterval(push, 2000);
    const offJob = registry.current ? registry.current.subscribe((ev) => es.send('job', ev)) : null;
    req.on('close', () => {
      clearInterval(timer);
      offJob?.();
    });
    return undefined;
  }

  if (method === 'GET' && p === '/api/health') {
    const st = await collectState();
    await deepProbe(true);
    const fresh = await collectState();
    return json(res, 200, {
      at: Date.now(),
      app: { state: fresh.app.state, httpStatus: fresh.app.httpStatus, httpMs: fresh.app.httpMs, probeOk: fresh.app.probeOk, pid: fresh.app.pid, port: fresh.app.port },
      db: { mode: fresh.db.mode, state: fresh.db.state, tcpReachable: fresh.db.tcpReachable, tcpMs: fresh.db.tcpMs, deep: fresh.db.deep, dsnLabel: fresh.db.dsnLabel },
      disk: fresh.host.disk,
      net: { lanIp: fresh.net.lanIp, lanIpSource: fresh.net.lanIpSource },
      warnings: st.warnings,
      errTail: readTail(P.appErrLog, 20).lines.map((l) => l.text),
      pgTail: readTail(P.pgLog, 20).lines.map((l) => l.text),
    });
  }

  // ---- 配置
  if (p === '/api/config') {
    if (method === 'GET') {
      return json(res, 200, {
        appPort: cfg.appPort,
        pgPort: cfg.pgPort,
        panelPort: cfg.panelPort,
        registry: cfg.registry,
        autoOpenBrowser: cfg.autoOpenBrowser,
        mirror: cfg.mirror,
        dbMode: cfg.dbMode,
        databaseUrl: cfg.databaseUrl ? cfg.databaseUrl.replace(/:[^:@/]*@/, ':****@') : '',
        runtimeDir: P.runtime,
        repoDir: P.repoDir,
      });
    }
    if (method === 'PUT') {
      const b = await readBody(req);
      const restartRequired = [];

      // 被中枢管着时，端口不在这里改。
      //
      // ui/index.html 的设置页有「应用端口 / 数据库端口」两个输入框，保存时发到这里。
      // 这个接口**无条件接受任意数字**：不查空闲、不查别的项目预约了什么、也不换面板
      // 端口（面板端口本来就不在表单里）。于是它能造出「两个项目预约了同一个端口」
      // 或「端口填成一个正在被占的值」这两种状态，而界面上不会显示任何异常。
      //
      // 为什么是 400 而不是「忽略端口、其余照存」：ui/index.html 与 deploy/ 的那份
      // 逐字节相同（README 的承诺），前端拿到 200 只会显示「配置已保存。」——
      // 忽略就等于**静默撒谎**，正是这套代码最反对的失败形态。代价是同一表单里的
      // registry / mirror 也一起没保存，所以文案里要说清怎么重试。
      // 独立跑面板（没有中枢）时保留原行为：那时没有中枢可回退。
      const portChanged = [];
      if (b.appPort && Number(b.appPort) !== cfg.appPort) portChanged.push('应用端口');
      if (b.pgPort && Number(b.pgPort) !== cfg.pgPort) portChanged.push('数据库端口');
      if (portChanged.length && process.env.AC_HUB === '1') {
        return fail(
          res,
          400,
          `端口由中枢统一分配，不能在这里改（${portChanged.join('、')}未生效）。` +
            `请回到中枢对该项目执行「重新分配端口」。同一表单里的其它设置这次也没有保存，` +
            `把两个端口改回原值再点保存即可。`
        );
      }

      if (b.appPort && Number(b.appPort) !== cfg.appPort) {
        cfg.appPort = Number(b.appPort);
        restartRequired.push('应用端口');
      }
      if (b.pgPort && Number(b.pgPort) !== cfg.pgPort) {
        cfg.pgPort = Number(b.pgPort);
        if (cfg.dbMode === 'portable') cfg.databaseUrl = portableDsn();
        restartRequired.push('数据库端口');
      }
      if (b.registry !== undefined) cfg.registry = String(b.registry || '');
      if (b.autoOpenBrowser !== undefined) cfg.autoOpenBrowser = Boolean(b.autoOpenBrowser);
      if (b.mirror !== undefined) cfg.mirror = Boolean(b.mirror);
      saveConfig(P, cfg);
      if (restartRequired.length) ensureEnvFile(false);
      return json(res, 200, { ok: true, restartRequired });
    }
  }

  // ---- 环境变量
  if (p === '/api/env') {
    if (method === 'GET') {
      const text = readEnvText(P);
      const entries = text
        .split(/\r?\n/)
        .map((line, i) => {
          const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
          if (!m) return null;
          const value = m[2].trim().replace(/^["']|["']$/g, '');
          // 键名像密钥就算敏感；另外 DATABASE_URL 这种键名不含关键字、
          // 但值里内嵌了密码（scheme://user:pass@host），必须一并打码。
          const secret = SECRET_KEY_RE.test(m[1]) || /:\/\/[^:@/\s]+:[^@/\s]+@/.test(value);
          return {
            key: m[1],
            value: secret && u.searchParams.get('reveal') !== '1' ? (value ? `${'•'.repeat(Math.max(0, Math.min(12, value.length - 4)))}${value.slice(-4)}` : '') : value,
            masked: secret,
            secret,
            present: Boolean(value),
            line: i,
          };
        })
        .filter(Boolean);
      return json(res, 200, { path: P.envFile, exists: Boolean(text), entries });
    }
    if (method === 'PUT') {
      const b = await readBody(req);
      const overrides = {};
      for (const [k, v] of Object.entries(b.set || {})) overrides[k] = String(v);
      for (const k of b.unset || []) overrides[k] = '';
      if (overrides.POSTGRES_PASSWORD !== undefined && overrides.POSTGRES_PASSWORD) {
        cfg.pgPassword = overrides.POSTGRES_PASSWORD;
        if (cfg.dbMode === 'portable') {
          cfg.databaseUrl = portableDsn();
          overrides.DATABASE_URL = cfg.databaseUrl;
        }
        saveConfig(P, cfg);
      }
      writeEnv(P, overrides);
      log(`已更新 ${P.envFile}：${Object.keys(overrides).join(', ') || '（无）'}`);
      return json(res, 200, { ok: true, restartRequired: Object.keys(overrides) });
    }
  }

  // ---- 日志
  if (method === 'GET' && p === '/api/logs') {
    const name = u.searchParams.get('file') || 'app';
    const lines = Math.min(2000, Number(u.searchParams.get('lines') || 200));
    const file = (LOG_FILES[name] || LOG_FILES.app)();
    return json(res, 200, { name, ...readTail(file, lines) });
  }
  if (method === 'GET' && p === '/api/logs/stream') {
    const name = u.searchParams.get('file') || 'app';
    const file = (LOG_FILES[name] || LOG_FILES.app)();
    const es = sse(req, res);
    es.send('hello', { name, file });
    const stop = tailFile(file, (lines) => es.send('log', { name, lines }), 500);
    req.on('close', stop);
    return undefined;
  }

  // ---- 任务
  if (method === 'GET' && p === '/api/jobs') return json(res, 200, registry.summary());

  const jobMatch = /^\/api\/jobs\/([^/]+)(\/stream|\/cancel)?$/.exec(p);
  if (jobMatch) {
    const job = registry.get(jobMatch[1]);
    if (!job) return fail(res, 404, '任务不存在（只保留最近一个已结束任务的日志）。');
    if (method === 'GET' && !jobMatch[2]) return json(res, 200, job.snapshot(0));
    if (method === 'GET' && jobMatch[2] === '/stream') {
      const since = Number(req.headers['last-event-id'] || u.searchParams.get('since') || 0);
      const es = sse(req, res);
      es.send('snapshot', job.snapshot(since));
      const off = job.subscribe((ev) => es.send(ev.type, ev, ev.entry?.seq ?? ev.index ?? undefined));
      req.on('close', off);
      return undefined;
    }
    if (method === 'POST' && jobMatch[2] === '/cancel') {
      await job.cancel();
      return json(res, 200, { ok: true });
    }
  }

  // ---- 运维动作
  if (method === 'POST' && p.startsWith('/api/ops/')) {
    const op = p.slice('/api/ops/'.length);
    const b = await readBody(req);
    try {
      switch (op) {
        case 'setup': {
          const job = startJob('setup', '首次部署', dep.DEPLOY_STEPS, (j) => opSetup(P, cfg, j, b), null);
          return json(res, 200, { jobId: job.id });
        }
        case 'start': {
          const job = startJob('start', '启动应用', ['启动'], (j) => opStart(P, cfg, j));
          return json(res, 200, { jobId: job.id });
        }
        case 'stop': {
          const job = startJob('stop', '停止应用', ['停止'], (j) => opStop(P, cfg, j));
          return json(res, 200, { jobId: job.id });
        }
        case 'restart': {
          const job = startJob('restart', '重启应用', ['重启'], async (j) => {
            j.step(0);
            await restartApp(P, cfg, (m) => j.line('out', m));
          });
          return json(res, 200, { jobId: job.id });
        }
        case 'rebuild': {
          const job = startJob('rebuild', '重新部署（同步源码并重建）', dep.DEPLOY_STEPS, (j) => opRebuild(P, cfg, j, b));
          return json(res, 200, { jobId: job.id });
        }
        case 'sync': {
          const job = startJob('sync', '同步源码', ['同步'], (j) => {
            j.step(0);
            dep.syncSource(P, j, { mirror: Boolean(b.mirror) });
          });
          return json(res, 200, { jobId: job.id });
        }
        case 'db-init': {
          const job = startJob('db-init', '初始化便携数据库', ['安装', '初始化', '启动', '建库'], async (j) => {
            cfg.dbMode = 'portable';
            if (!cfg.pgPassword) cfg.pgPassword = randomToken(18);
            if (cfg.dbMode === 'portable' && !cfg.databaseUrl) cfg.databaseUrl = portableDsn();
            saveConfig(P, cfg);
            j.step(0);
            await pg.installPortable(P, j);
            j.step(1);
            await pg.initCluster(P, cfg, j, { allowWipe: Boolean(b.allowWipe) });
            j.step(2);
            await pg.startPortable(P, cfg, j);
            j.step(3);
            await pg.ensureDatabase(P, cfg, j);
            ensureEnvFile(false);
          });
          return json(res, 200, { jobId: job.id });
        }
        case 'db-start': {
          const job = startJob('db-start', '启动数据库', ['启动'], async (j) => {
            j.step(0);
            await pg.startPortable(P, cfg, j);
          });
          return json(res, 200, { jobId: job.id });
        }
        case 'db-stop': {
          const job = startJob('db-stop', '停止数据库', ['停止'], async (j) => {
            j.step(0);
            await pg.stopPortable(P, cfg, j);
          });
          return json(res, 200, { jobId: job.id });
        }
        case 'db-password': {
          const next = String(b.password || '').trim() || randomToken(18);
          if (!/^[A-Za-z0-9_-]+$/.test(next)) {
            return fail(res, 400, '密码只能是字母、数字、下划线和连字符（它要拼进连接串，必须 URL-safe）。');
          }
          const job = startJob('db-password', '修改数据库密码', ['修改', '同步配置'], async (j) => {
            j.step(0);
            if (cfg.dbMode === 'portable' && fs.existsSync(P.psql)) {
              const r = await spawnInto(j, P.psql, [
                '-h', '127.0.0.1', '-p', String(cfg.pgPort), '-U', 'agilecampus', '-d', 'postgres', '-c',
                `ALTER USER agilecampus WITH PASSWORD '${next}';`,
              ], { env: { ...process.env, PGPASSWORD: cfg.pgPassword }, timeoutMs: 30000 });
              if (r.code !== 0) throw new Error('ALTER USER 失败，请查看上方输出。');
            } else {
              j.log('err', '非便携模式或找不到 psql，跳过 ALTER USER，仅更新连接串。');
            }
            cfg.pgPassword = next;
            cfg.databaseUrl = portableDsn();
            saveConfig(P, cfg);
            j.step(1);
            ensureEnvFile(false);
            j.log('out', '密码已更新，需重启应用生效。');
          });
          return json(res, 200, { jobId: job.id });
        }
        case 'db-doctor': {
          // 只读诊断。故意不起 job：它不该占用「同一时刻只允许一个长任务」的名额，
          // 否则用户点一下体检就会把正在跑的部署挡在门外。
          const r = await doctor.diagnose(P, cfg, deps, quietJob());
          const payload = {
            checks: r.checks,
            fixes: doctor.FIXES,
            summary: {
              ok: r.checks.filter((c) => c.level === 'ok').length,
              warn: r.checks.filter((c) => c.level === 'warn').length,
              fail: r.checks.filter((c) => c.level === 'fail').length,
              skipped: r.checks.filter((c) => c.level === 'skip').length,
            },
            at: Date.now(),
          };
          dbDoctorCache.value = payload;
          dbDoctorCache.at = Date.now();
          return json(res, 200, payload);
        }
        case 'db-repair': {
          const ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
          if (!ids.length) return fail(res, 400, '没有选中任何修复项。');
          const job = startJob(
            'db-repair',
            '检修数据库',
            ids.map((id) => doctor.FIXES[id]?.title || id),
            async (j) => {
              const r = await doctor.repair(P, cfg, j, deps, {
                ids,
                confirmDestructive: Boolean(b.confirmDestructive),
              });
              dbDoctorCache.at = 0; // 让下次 /api/state 立刻反映修复结果
              return r;
            }
          );
          return json(res, 200, { jobId: job.id });
        }
        case 'db-reset-preview': {
          // 只读清点，供二次确认界面把「将要删掉什么」摆出来。
          // 同样不起 job：它不该占长任务名额，也不该让用户在确认框前等排队。
          const p = await doctor.dbResetPreview(P, cfg, quietJob());
          return json(res, 200, { ...p, phrase: doctor.RESET_PHRASE });
        }
        case 'db-reset': {
          // 确认短语在这一层先挡一次，doctor.resetDatabase 里还会再挡一次。
          // 两次都要有：这里是为了给出干净的 400（不用等一个 job 跑起来再失败），
          // 那里是因为 job 体可以绕过 HTTP 层被别处调用，安全校验不能只挂在外围。
          if (String(b.confirmText || '').trim() !== doctor.RESET_PHRASE) {
            return fail(res, 400, `确认短语不正确。需要原样输入「${doctor.RESET_PHRASE}」四个字。`);
          }
          const job = startJob('db-reset', '重置数据库（清空所有业务数据）', ['停止应用', '删除并重建库', '推送表结构', '重启应用'], async (j) => {
            const r = await doctor.resetDatabase(P, cfg, j, deps, { confirmText: b.confirmText });
            dbDoctorCache.at = 0;
            return r;
          });
          return json(res, 200, { jobId: job.id });
        }
        case 'cron-reminders': {
          const secret = envToObject(readEnvText(P)).CRON_SECRET;
          if (!secret) return fail(res, 400, '未配置 CRON_SECRET，无法触发。');
          const job = startJob('cron', '触发提醒扫描（会真实发送飞书消息）', ['调用'], async (j) => {
            j.step(0);
            const r = await httpProbe(`http://127.0.0.1:${cfg.appPort}/api/cron/reminders`, {
              timeout: 60000,
              headers: { Authorization: `Bearer ${secret}` },
            });
            j.log(r.ok ? 'out' : 'err', `HTTP ${r.status}，耗时 ${r.ms}ms`);
            if (!r.ok) throw new Error('调用失败，请检查应用是否在运行。');
          });
          return json(res, 200, { jobId: job.id });
        }
        case 'open': {
          const target = b.target === 'login' ? '/login' : '/';
          // 用**点按钮这一刻**的局域网 IP，而不是 localhost。这不只是为了好看：
          // 飞书 OAuth 的 state cookie 绑在发起页的 host 上，从 localhost 发起却按
          // AGILECAMPUS_URL 回到局域网 IP 时，两个 host 不共享 cookie，用户只会看到
          // 「绑定校验失败」。lanIp() 不缓存，走动网路由实时取；拔网线/只有回环时
          // 退回 localhost，至少本机仍然可用。
          const net = await lanIp();
          const url = `http://${net?.ip || 'localhost'}:${cfg.appPort}${target}`;
          openBrowser(url);
          return json(res, 200, { ok: true, url });
        }
        case 'shutdown': {
          // 页面上的「全部停止并退出面板」。这条路径欠着两句真话：
          //   · 页面必须**探到**面板真的不再应答之后才敢说「已退出」（见 ui/index.html 的
          //     shutdownPanel）—— 从前它 6 秒后无条件宣布胜利，于是「页面说退了、中枢说在跑」
          //   · 响应必须**带着真实结果**回来。面板一消失，页面就再也拿不到任何信息了，
          //     所以这里是「做完再回话」，而不是回一句「已受理」然后埋头干活
          if (stopAllInFlight) return json(res, 200, { ok: false, alreadyStopping: true });
          stopAllInFlight = true;

          const wantApp = Boolean(b.alsoStopApp);
          // 外部库不归我们管，也绝不谎报停了它
          const wantDb = Boolean(b.alsoStopDb) && cfg.dbMode === 'portable';
          if (registry.current) {
            log(`注意：任务「${registry.current.title}」正在进行，退出会中止它。`);
          }

          const outcome = {
            stoppingApp: wantApp,
            stoppingDb: wantDb,
            stoppedApp: null,
            stoppedDb: null,
            errors: [],
          };

          // 硬超时兜底。它到点就退出，而**那时响应还没发出去** —— 页面会看到连接断开，
          // 据此显示「停止结果没能确认」。这是诚实的失败：假装停干净了才是撒谎。
          const deadline = setTimeout(() => {
            shutdown(
              `面板退出（退出超时：停止动作在 ${Math.round(SHUTDOWN_DEADLINE_MS / 1000)} 秒内没有结束，` +
                '应用或数据库可能仍在运行，请到中枢里核对它们的状态）。'
            );
          }, SHUTDOWN_DEADLINE_MS);

          setTimeout(async () => {
            // 顺序不能反：应用连着数据库，先停应用再停库，否则应用会刷一屏连接错误日志。
            if (wantApp) {
              try {
                await stopApp(P, cfg, (m) => log('[停止应用] ' + m));
                outcome.stoppedApp = true;
              } catch (e) {
                outcome.stoppedApp = false;
                outcome.errors.push('停止应用：' + e.message);
                log('停止应用失败：' + e.message);
              }
            }
            if (wantDb) {
              // **必须传一个真 Job**，不能手写 `{ log, stepDetail, lines }` 这种空壳。
              // 空壳缺 line() 与 flush()，后果是两段式的：前者让 stopPortable 一进来就抛
              // 「job.line is not a function」（于是**数据库根本没被停**），后者抛在
              // spawnInto 的 'close' 回调里、在 resolve 之前——Promise 永不 settle，
              // 这个 handler 就永远卡在 await 上，**面板再也不会退出**。
              // lib/jobs.mjs 的 detachedJob 注释里早写着这个坑，这里是它唯一的漏网调用点。
              const j = detachedJob('shutdown-db-stop', '停止数据库', ['停止']);
              j.step(0);
              try {
                await pg.stopPortable(P, cfg, j);
                outcome.stoppedDb = true;
              } catch (e) {
                outcome.stoppedDb = false;
                outcome.errors.push('停止数据库：' + e.message);
                log('停止数据库失败：' + e.message);
              }
            }
            clearTimeout(deadline);

            // 真实结果先回给页面 —— 它是页面在面板消失之后唯一能拿到的证据。
            try {
              json(res, 200, Object.assign({ ok: true }, outcome));
            } catch {}

            // 等这个响应真的写出去再退出。这个进程一走，页面就只剩「连接断了」一个信号。
            const done = [];
            if (wantApp) done.push(outcome.stoppedApp ? '应用已停止' : '应用未能停止');
            if (wantDb) done.push(outcome.stoppedDb ? '数据库已停止' : '数据库未能停止');
            setTimeout(
              () => shutdown(done.length ? `面板退出（${done.join('，')}）。` : undefined),
              400
            );
          }, 300);
          return undefined;
        }
        default:
          return fail(res, 404, `未知操作：${op}`);
      }
    } catch (e) {
      if (e.code === 'JOB_BUSY') return fail(res, 409, e.message, { runningJobId: e.runningJobId });
      return fail(res, 500, e.message);
    }
  }

  return fail(res, 404, `没有这个接口：${method} ${p}`);
}

// --------------------------------------------------------------- 浏览器与生命周期

let actualPanelPort = cfg.panelPort;
let server = null;
let shuttingDown = false;
/** 「全部停止并退出面板」是否已经在跑。见 shutdown 分支里的说明。 */
let stopAllInFlight = false;

/**
 * 退出面板。`note` 是**这次退出到底做了什么**的一句话，原样进日志。
 *
 * 从前这里无条件写「应用与数据库继续运行」。而在「全部停止并退出面板」那条路上，
 * 应用与数据库恰恰是**已经停了**——日志里的一句假话，正是上一轮排查那次「点了没反应」
 * 时最误导人的东西：`panel.log` 说库还在跑，而真相是库压根没被停掉。
 */
function shutdown(note = '面板退出（应用与数据库继续运行）。') {
  if (shuttingDown) return;
  shuttingDown = true;
  log(note);
  try {
    fs.rmSync(P.lockFile, { force: true });
  } catch {}
  try {
    server?.close();
  } catch {}
  logStream.end();
  setTimeout(() => process.exit(0), 200).unref();
}

/** 已有面板在跑吗？在跑就直接把浏览器指过去，不再起第二个。 */
async function findRunningPanel() {
  const lock = (() => {
    try {
      return JSON.parse(fs.readFileSync(P.lockFile, 'utf8'));
    } catch {
      return null;
    }
  })();
  if (!lock?.pid || !lock?.port) return null;
  if (!pidAlive(lock.pid)) return null;
  const r = await httpProbe(`http://127.0.0.1:${lock.port}/api/state`, { timeout: 1500 });
  return r.ok ? lock : null;
}

async function main() {
  const existing = await findRunningPanel();
  if (existing) {
    console.log(`检测到已有面板在运行（端口 ${existing.port}），直接打开它。`);
    openBrowser(`http://127.0.0.1:${existing.port}/`);
    process.exit(0);
  }
  if (!(await portFree(cfg.panelPort, '127.0.0.1'))) {
    actualPanelPort = await pickFreePort(Array.from({ length: 32 }, (_, i) => cfg.panelPort + 1 + i));
    log(`面板端口 ${cfg.panelPort} 被占用，改用 ${actualPanelPort}。`);
  } else {
    actualPanelPort = cfg.panelPort;
  }

  const guard = createGuard({ getPort: () => actualPanelPort, tokens: TOKENS, onLog: log });

  server = http.createServer(async (req, res) => {
    // 三层护栏（Host 校验 / OPTIONS 一律拒绝 / 改动型请求的 Origin + 令牌 + JSON）
    // 全在 createGuard 里。返回 null 表示请求已被它应答，直接收工。
    const u = guard(req, res);
    if (!u) return;

    try {
      await route(req, res, u);
    } catch (e) {
      log('处理请求出错：' + (e.stack || e.message));
      if (!res.headersSent) fail(res, 500, e.message);
    }
  });

  // SSE 是长连接，必须放宽超时，否则会被服务器自己掐掉
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 72000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(actualPanelPort, '127.0.0.1', resolve);
  });

  // pidStartTime / runtimeDir 是给中枢用的：它要在「优雅停机没生效、只能硬杀」时
  // 先核对身份。pid 会被系统复用，只认 pid 的话可能杀掉一个无关进程。
  //
  // 必须用 writeJson（tmp + rename）而不是原地 writeFileSync：中枢每 2 秒读一次
  // 这个文件，原地写有一个**真实存在**的窗口——读到半截 JSON，readPanelLock 判形状
  // 不过，卡片就闪一下「面板：未打开」。原子写让读到的要么是旧锁要么是新锁。
  writeJson(P.lockFile, {
    pid: process.pid,
    port: actualPanelPort,
    repoDir: P.repoDir,
    runtimeDir: P.runtime,
    pidStartTime: await processStartTime(process.pid),
    startedAt: Date.now(),
  });
  const url = `http://127.0.0.1:${actualPanelPort}/`;
  log(`面板已启动：${url}（运行目录 ${P.runtime}，仓库 ${P.repoDir}）`);

  const st = await appStatus(P, cfg);
  const net = await lanIp();
  console.log('');
  console.log('  AgileCampus 控制台已启动');
  console.log(`  面板地址   ${url}`);
  console.log(`  运行目录   ${P.runtime}`);
  if (st.state === 'running' && net.ip) console.log(`  站点地址   http://${net.ip}:${st.port}  （局域网）/ http://localhost:${st.port}`);
  console.log('');

  // --no-open：中枢拉起子面板时必须带上，否则每开一个项目就弹一个浏览器标签页。
  if (cfg.autoOpenBrowser && !argv.includes('--no-open')) openBrowser(url, log);

  // 包一层再转交：`process.on('SIGINT', shutdown)` 会把信号名当第一个参数传进去，
  // 而 shutdown() 的第一个参数现在是「这次退出做了什么」那句话。
  process.on('SIGINT', () => shutdown('面板退出（收到 SIGINT / Ctrl+C）。'));
  process.on('SIGTERM', () => shutdown('面板退出（收到 SIGTERM）。'));
  if (process.platform === 'win32') process.on('SIGBREAK', () => shutdown('面板退出（收到 SIGBREAK）。'));
  process.on('uncaughtException', (e) => log('未捕获异常：' + (e.stack || e.message)));
  process.on('unhandledRejection', (e) => log('未处理的 Promise 拒绝：' + (e?.stack || e)));
}

/**
 * --selftest：把 folder 模式与单文件 exe 模式之间**仅有的**两处行为差异一次性打出来，
 * 好让两者可以逐行对照：资源读取（UI 到底读没读到）与 Node 解析（找不找得到真 Node）。
 * 这是整套改造里性价比最高的一条测试——别的地方两种模式跑的是同一份代码。
 */
async function selftest() {
  const { isSea, nodeExe } = await import('./lib/nodebin.mjs');
  const uiPath = path.join(UI_DIR, 'index.html');
  let ui = { path: uiPath, bytes: 0, tokenPlaceholder: false, error: null };
  try {
    const html = fs.readFileSync(uiPath, 'utf8');
    ui.bytes = Buffer.byteLength(html);
    ui.tokenPlaceholder = html.includes('__AC_TOKEN__');
  } catch (e) {
    ui.error = e.message;
  }
  let node = { exe: null, error: null };
  try {
    node.exe = nodeExe(P);
  } catch (e) {
    node.error = `${e.code || 'ERROR'}: ${e.message}`;
  }
  const report = {
    mode: isSea() ? 'sea' : 'folder',
    execPath: process.execPath,
    panelVersion: PANEL_VERSION,
    runtimeDir: P.runtime,
    repoDir: P.repoDir,
    configFile: P.configFile,
    ui,
    node,
    nodeVersion: process.version,
  };
  console.log(JSON.stringify(report, null, 2));
  // UI 读不到 = 界面必 500；仓库读不到 = 启动早该报错了。两者任一失败即判不通过。
  const ok = !ui.error && ui.bytes > 0 && Boolean(P.repoDir);
  process.exit(ok ? 0 : 1);
}

if (argv.includes('--selftest')) {
  selftest().catch((e) => {
    console.error('自检失败：', e.message);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error('面板启动失败：', e.message);
    log('面板启动失败：' + (e.stack || e.message));
    process.exit(1);
  });
}
