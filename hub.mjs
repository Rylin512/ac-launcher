// 多项目中枢：把「已登记的仓库」列出来、持续监视、按需打开它们的控制面板。
//
// 这个文件里最重要的一个结构性判断是：**监视 N 个项目不需要 N 个面板进程**。
// 面板里的一切监视数据都是 (P, cfg) 的纯函数——appStatus、pgStatus、
// standaloneReady 都只要一个运行目录和一个配置对象。有状态的只是面板的
// server/route 那一层，而那一层只有在用户真的要操作某个项目时才需要。
//
// 于是中枢自己循环调用那些函数，子面板按需才拉起（--no-open，不弹标签页）。
// 三个项目全停着的时候，机器上只有一个中枢进程，而不是三个面板 + 一个中枢。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  PANEL_VERSION,
  resolveRuntimeDir,
  readJson,
  randomToken,
  looksLikeRepo,
  loadConfig,
  saveConfig,
  ensureEnvFile,
  normalizeDbConfig,
  writeJson,
} from './lib/config.mjs';
import { json, fail, readBody, sse, createGuard, tokenSet, openBrowser, request } from './lib/http.mjs';
import { lanIp, portFree, pickFreePort, processStartTime, pidAlive, httpProbe, tcpReachable, waitForPort } from './lib/sysinfo.mjs';
import { appStatus, readTail, touch, startApp, stopApp, recordStarted } from './lib/process.mjs';
import { pgStatus, startPortable, stopPortable } from './lib/pg.mjs';
import { standaloneReady } from './lib/deploy.mjs';
import { detachedJob } from './lib/jobs.mjs';
import { allocatePorts, validatePorts, offRangePorts, PORT_LABELS, PORT_KEYS } from './lib/ports.mjs';
import {
  loadRegistry,
  saveRegistry,
  migrateLegacy,
  dedupeProjects,
  addProject,
  removeProject,
  findProject,
  projectPaths,
  projectConfig,
  purgeProject,
  livePanel,
  panelProcess,
  stopPanel,
  loadHubSecret,
} from './lib/registry.mjs';
import { isSea, nodeExe, selfSpawn, ENGINE_DIR, MAIN_JS } from './lib/nodebin.mjs';

const argv = process.argv.slice(2);

/** 清盘要原样输入的短语。刻意与数据库重置的「重置数据库」不同，两个确认不该能互相顶替。 */
export const PURGE_PHRASE = '删除项目';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hub-ui');
const POLL_MS = 2000;

// ------------------------------------------------------------------ 运行目录

const runtimeDir = resolveRuntimeDir(argv);
for (const d of [runtimeDir, path.join(runtimeDir, 'config'), path.join(runtimeDir, 'logs'), path.join(runtimeDir, 'run')]) {
  fs.mkdirSync(d, { recursive: true });
}

const HUB_LOG = path.join(runtimeDir, 'logs', 'hub.log');
const HUB_LOCK = path.join(runtimeDir, 'run', 'hub.lock');
touch(HUB_LOG);
const logStream = fs.createWriteStream(HUB_LOG, { flags: 'a' });
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.join(' ')}\n`;
  logStream.write(line);
  if (process.env.AC_VERBOSE) process.stdout.write(line);
}

const SECRET = loadHubSecret(runtimeDir);
const registry = loadRegistry(runtimeDir);

const TOKEN = randomToken(24);
const TOKENS = tokenSet(TOKEN);
const STARTED_AT = Date.now();
/** 命令行显式给的端口优先，否则用注册表里上次记下的，最后才是默认的 8788。 */
const wantPort = Number(argValue('--port')) || registry.hub.port || 8788;
let actualHubPort = wantPort;
let server = null;
let shuttingDown = false;

function argValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] || null : null;
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ------------------------------------------------------------------ 项目状态

/** 局域网 IP 只取一次：它要开 UDP socket，不该进 2 秒轮询。 */
let lanCache = { at: 0, value: null };
async function lan() {
  if (Date.now() - lanCache.at < 60000 && lanCache.value) return lanCache.value;
  lanCache = { at: Date.now(), value: await lanIp() };
  return lanCache.value;
}

/**
 * standalone 就绪与否的短时记忆。
 *
 * findStandaloneRoot 是一次广度优先遍历，正常情况下第一步就命中（`.next/standalone`
 * 自己就是根），或者因为目录不存在而立刻返回 null。但「装配到一半」的产物会让它
 * 走完一整棵树，而轮询是每 2 秒一次、永远在跑。加一层 5 秒的记忆把最坏情况兜住，
 * 代价只是状态最多晚 5 秒变绿——这个界面上没人会察觉。
 */
const readyCache = new Map();
function readyMemo(slug, fn) {
  const hit = readyCache.get(slug);
  if (hit && Date.now() - hit.at < 5000) return hit.value;
  const value = fn();
  readyCache.set(slug, { at: Date.now(), value });
  return value;
}

/**
 * 正在进行的端口重分配。**全局一个，不是 per-slug。**
 *
 * 必须是全局的：allocatePorts 的 used 集合是每次调用的局部量，两个项目同时重分配时
 * A 的集合里不含 B 即将拿到的新端口，两边可能挑到同一组——然后各自写自己的
 * panel.json 与 .env，还都不报错。串行化的代价在本功能的使用频率下等于零。
 *
 * 置位必须在 handler 的第一行、任何 await 之前**同步**完成，否则两个请求都能通过检查。
 */
let reallocInFlight = null;

/** 某个项目此刻是不是正在被重分配（供状态载荷与界面禁用按钮）。 */
function pendingFor(slug) {
  if (!reallocInFlight || reallocInFlight.slug !== slug) return null;
  return { kind: reallocInFlight.kind, startedAt: reallocInFlight.startedAt };
}

/**
 * 一个项目的完整状态。全部是纯读，绝不写仓库、也绝不写这个项目的运行目录。
 */
async function projectState(project) {
  const P = projectPaths(project);
  const cfg = projectConfig(project);

  // 面板在不在，看**进程**（panelProcess），不看它此刻答不答话。这一条是「卡片偶尔
  // 闪一下面板未运行」的根治：面板是单线程的，正在跑 npm ci / 构建 / 刷大段日志时
  // 1.5 秒不回一次 /api/state 是家常便饭，而这里每 2 秒就轮询一遍。用探针当判据
  // 等于把「忙」误报成「没开」，还会连带谎报「锁陈旧（进程已不在）」——进程明明活着。
  const panelLock = panelProcess(P);
  const [app, db] = await Promise.all([appStatus(P, cfg), pgStatus(P, cfg)]);
  // 只有「锁在、进程不在」才算陈旧。它现在是一句真话，所以可以照实显示。
  const staleLock = !panelLock && Boolean(readLockQuiet(P));

  const repoOk = looksLikeRepo(project.repoDir);
  const deps = fs.existsSync(path.join(P.srcDir, 'node_modules'));
  const envReady = fs.existsSync(P.envFile);
  const built = readyMemo(project.slug, () => fs.existsSync(path.join(P.srcDir, '.next')) && standaloneReady(P));

  const panelPort = panelLock?.port ?? cfg.panelPort ?? project.ports?.panel ?? null;
  const appPort = app.port ?? cfg.appPort ?? project.ports?.app ?? null;
  const net = await lan();

  // 问题清单是中枢存在的理由：光看「停着」不知道是没装、没构建、还是坏了。
  const problems = [];
  if (!repoOk) problems.push({ level: 'fail', code: 'REPO_MISSING', text: `仓库目录不存在或不再像仓库：${project.repoDir}` });
  if (repoOk && !deps) problems.push({ level: 'warn', code: 'NO_DEPS', text: '依赖未安装（打开面板 → 一键部署）' });
  if (repoOk && !envReady) problems.push({ level: 'warn', code: 'NO_ENV', text: '尚未生成 .env' });
  if (!db.mode || db.mode === 'unconfigured') problems.push({ level: 'warn', code: 'NO_DB', text: '数据库未配置' });
  if (db.postmasterPidStale) problems.push({ level: 'warn', code: 'PG_STALE_PID', text: '数据库的 postmaster.pid 是陈旧的（进程已不在）' });
  if (app.state === 'orphan') {
    problems.push({ level: 'warn', code: 'ORPHAN_PORT', text: `端口 ${app.port} 被一个不是本面板启动的进程占用` });
  }
  if (repoOk && deps && !built) problems.push({ level: 'info', code: 'NOT_BUILT', text: '尚未构建出可启动的产物' });
  if (staleLock) problems.push({ level: 'info', code: 'STALE_LOCK', text: '面板锁是陈旧的（面板进程已不在），下次打开会自愈' });

  return {
    slug: project.slug,
    name: project.name,
    repoDir: project.repoDir,
    runtimeDir: project.runtimeDir,
    legacy: Boolean(project.legacy),
    addedAt: project.addedAt ?? null,
    lastOpenedAt: project.lastOpenedAt ?? null,
    repoOk,
    // 重分配端口进行中。界面据此禁用按钮；它也是「界面上那一堆停着的服务是
    // 我们正在动的，不是坏了」的唯一线索。
    pending: pendingFor(project.slug),
    ports: { panel: panelPort, app: appPort, pg: db.port ?? cfg.pgPort ?? project.ports?.pg ?? null },
    config: { dbMode: cfg.dbMode ?? null, builtAt: cfg.builtAt ?? null, sourceHash: cfg.sourceHash ? `${cfg.sourceHash.slice(0, 18)}…` : null },
    panel: {
      running: Boolean(panelLock),
      staleLock,
      port: panelLock?.port ?? null,
      pid: panelLock?.pid ?? null,
      url: panelLock ? `http://127.0.0.1:${panelLock.port}/` : null,
    },
    app: {
      state: app.state,
      port: app.port,
      pid: app.pid,
      uptimeSec: app.uptimeSec,
      urlLocal: `http://localhost:${app.port}`,
      urlLan: net?.ip ? `http://${net.ip}:${app.port}` : null,
      logTail: readTail(P.appLog, 3).lines.map((l) => l.text),
    },
    db: {
      state: db.state,
      mode: db.mode,
      port: db.port,
      host: db.host,
      version: db.version,
      pid: db.pid,
      dsnLabel: db.dsnLabel,
      portableInstalled: db.portableInstalled,
    },
    ready: { deps, env: envReady, built: Boolean(built), repo: repoOk },
    problems,
  };
}

function readLockQuiet(P) {
  try {
    return JSON.parse(fs.readFileSync(P.lockFile, 'utf8'));
  } catch {
    return null;
  }
}

// -------------------------------------------------------------- 状态的共用缓存

/**
 * 一份被所有消费者共享的状态快照。
 *
 * 2 秒轮询、若干个 SSE 连接、以及每次 REST 查询，若各算各的，浏览器多开一个
 * 标签页就会让端口探测与数据库探活翻一倍。共享之后，无论多少消费者，每个周期
 * 只做一轮探测。
 */
let stateCache = null;
function hubState({ maxAgeMs = 1500 } = {}) {
  const now = Date.now();
  if (stateCache && now - stateCache.at < maxAgeMs) return stateCache.promise;
  const promise = (async () => {
    const projects = await Promise.all(registry.projects.map((p) => projectState(p).catch((e) => ({ slug: p.slug, name: p.name, error: e.message }))));
    const net = await lan();
    return {
      hub: {
        pid: process.pid,
        port: actualHubPort,
        version: PANEL_VERSION,
        mode: isSea() ? 'sea' : 'folder',
        uptimeSec: Math.floor((Date.now() - STARTED_AT) / 1000),
        runtimeDir,
        registryFile: path.join(runtimeDir, 'projects.json'),
        nodeVersion: process.version,
      },
      net: { lanIp: net?.ip || null, lanIpSource: net?.source || null },
      projects,
      at: Date.now(),
    };
  })();
  stateCache = { at: now, promise };
  promise.catch(() => {
    if (stateCache && stateCache.promise === promise) stateCache = null;
  });
  return promise;
}

/** 改动之后立刻让下一次查询重算，并在下一个节拍把它推给所有订阅者。 */
function invalidate() {
  stateCache = null;
  latest = null;
}

// ---------------------------------------------------------------- SSE 广播

const subscribers = new Set();
let latest = null;
let ticker = null;

function fanout(state) {
  latest = state;
  for (const api of subscribers) api.send('state', state);
}

async function tick() {
  try {
    fanout(await hubState({ maxAgeMs: 0 }));
  } catch (e) {
    log('轮询失败：' + (e.stack || e.message));
  }
}

function subscribe(api) {
  subscribers.add(api);
  if (latest) api.send('state', latest);
  if (!ticker) {
    tick();
    ticker = setInterval(tick, POLL_MS);
  }
}

function unsubscribe(api) {
  subscribers.delete(api);
  if (!subscribers.size && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

// ---------------------------------------------------------------- 子面板

/**
 * 拉起一个项目的子面板。
 *
 * 关键在 selfSpawn：exe 模式下 process.execPath 是本 exe，**不能再补一个 main.mjs
 * 参数**——那会被当成位置参数（要监视的仓库目录），于是变成「对 main.mjs 这个文件
 * 起面板」并 exit 2。这个坑与 nodebin.mjs 里记的另外两处是同一个来源。
 */
function spawnPanel(project, P) {
  const { cmd, args } = selfSpawn(['--repo', project.repoDir, '--runtime-dir', project.runtimeDir, '--no-open']);
  const outFd = fs.openSync(path.join(P.logsDir, 'panel.console.log'), 'a');
  const errFd = fs.openSync(path.join(P.logsDir, 'panel.console.err.log'), 'a');
  let child;
  try {
    // detached + 文件 fd + unref 三件套的理由与 process.mjs 的 startApp 完全相同：
    // 面板不该因为中枢退出而被带走，也不该因为管道写端关闭而 EPIPE。
    const env = { ...process.env, AC_SUPERVISOR_TOKEN: SECRET, AC_HUB: '1' };
    child = spawn(cmd, args, { cwd: P.runtime, env, detached: true, windowsHide: true, stdio: ['ignore', outFd, errFd] });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  child.unref();
  log(`已拉起子面板 ${project.slug}（PID ${child.pid}，仓库 ${project.repoDir}）`);
  return child;
}

/**
 * 打开一个项目的面板：已有就复用，没有就拉起，然后等它真的应答。
 *
 * 返回的端口一律取自**子面板自己写的锁**，而不是注册表里的预约值——面板端口被占
 * 时会自己顺延（panel.mjs 的 +1..+32 回退），锁里那个才是事实。
 */
async function openProject(project) {
  const P = projectPaths(project);
  // 复用判据是**进程在不在**，不是「它此刻答不答话」。差别在「一键部署跑着的时候
  // 点打开」这个常见场景：面板忙着 npm ci，1.5 秒内不回话，旧判据会当场去起第二个
  // 面板——而端口被第一个占着，必然起不来，用户看到的是「打开」莫名其妙失败。
  // 复用它是对的：浏览器连上后，面板忙完自然会把页面渲染出来。
  const existing = panelProcess(P);
  if (existing) {
    project.lastOpenedAt = Date.now();
    saveRegistry(runtimeDir, registry);
    return { url: `http://127.0.0.1:${existing.port}/`, started: false };
  }

  // 从这里往下是新起的那个：必须等它**真的应答**再返回 URL，否则会把一个还没
  // listen 的地址交给用户（livePanel 在这里正是要的语义）。
  let lock = null;
  spawnPanel(project, P);
  for (let i = 0; i < 60 && !lock; i += 1) {
    await sleep(250);
    lock = await livePanel(P);
  }
  if (!lock) {
    const tail = readTail(path.join(P.logsDir, 'panel.console.err.log'), 8).lines.map((l) => l.text).join('\n');
    throw Object.assign(new Error(`子面板在 15 秒内没有就绪。控制台输出：\n${tail || '(空)'}`), { code: 'PANEL_NOT_READY' });
  }
  project.lastOpenedAt = Date.now();
  project.ports = { ...(project.ports || {}), panel: lock.port };
  saveRegistry(runtimeDir, registry);
  return { url: `http://127.0.0.1:${lock.port}/`, started: true, pid: lock.pid };
}

// ---------------------------------------------------------- 重新分配端口

/** 读 postmaster.pid 的第一行（PID）。读不到就 null。 */
function readPidNumber(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').split('\n')[0].trim()) || null;
  } catch {
    return null;
  }
}

/**
 * 重新分配一个项目的三个端口。**这是改端口的唯一正确路径。**
 *
 * 为什么值得做成一个中枢级的操作：事后单独改 pgPort 会让 databaseUrl 与 .env 里的
 * 派生值静默失同步（config.mjs 的 writeEnv 注释里记着同一类事故的完整经过），而改
 * appPort 会让 .env 的 AGILECAMPUS_URL 与下次启动时带的 PORT 各说各话。所以本函数
 * 一次性改对**全部**派生数据，并承认它会短暂停服：该停的按依赖序停掉，改完再按原先
 * 的状态拉回来。
 *
 * 事务边界是「配置 + .env 的这次提交」，不是进程生命周期：
 *   • 提交前（A–C）任何一步失败 → **磁盘零改动**。用户按原先那三个按钮就能一字不差
 *     地回到原世界，配置也仍然自洽。
 *   • 提交后（D–E）失败 → **不自动回滚**。端口组本身已经完全提交且自洽了，只是服务
 *     没起来；而用户点这个按钮的动机常常正是旧端口有问题，退回旧端口才是错的。
 *     改为如实汇报：200 + 逐条 warnings，让卡片显示真实状态。
 *
 * 不做的事（每一条都是有意的）：不 ALTER ROLE（pgPassword 一字节不动）、不 initdb、
 * 不删任何目录。它只改**地址**，从不动身份——这是它可以没有确认短语的原因
 * （对照 PURGE_PHRASE / RESET_PHRASE 守的那两件事，那两个会真的丢东西）。
 */
async function reallocatePorts(project, want = null) {
  const P = projectPaths(project);
  const t0 = Date.now();
  const warnings = [];
  const job = detachedJob('port-realloc', '重新分配端口');

  // 作业输出平时只活在内存里（本操作没有 SSE 订阅者），中枢日志里得留一份——
  // 否则「数据库为什么没起来」在中枢侧完全无迹可查。
  job.subscribe((ev) => {
    if (ev?.type === 'log' && ev.entry?.text) log(`[端口重分配 ${project.slug}] ${String(ev.entry.text).trim()}`);
  });

  /* ---------------------------------------------------------------- A. 只读预检 */
  // 这一段不写任何文件、不停任何进程。失败时磁盘与服务都还在原样。
  const cfg = projectConfig(project);
  const portable = cfg.dbMode !== 'external';
  const lock = panelProcess(P);
  const [appSt, dbSt] = await Promise.all([appStatus(P, cfg), pgStatus(P, cfg)]);

  // 面板正在跑长任务时不能停它：停面板会把 npm ci / next build 的子进程一起带走，
  // 留下半个 node_modules。而面板自己看不见这件事——它在被停的那一侧。
  if (lock) {
    const st = await request(`http://127.0.0.1:${lock.port}/api/state`, { token: SECRET, timeout: 2500 });
    const jobs = st.data?.jobs;
    // 问不到，就得当成「可能在忙」。面板是单线程的，正在跑 npm ci 时本来就可能答不上
    // 这一问，而**恰恰是这种时候**它肚子里有活——放行就等于把它连子进程一起杀掉。
    // 逃生口是卡片上的「停止」：那条路按 pid 走，不需要面板应答。
    if (!jobs) {
      throw Object.assign(
        new Error('控制面板正在运行，但没有应答（可能正忙）。为免打断它手上的事，端口没有改动。稍后重试；若它确实卡死了，先在卡片上「停止」它。'),
        { code: 'PANEL_UNREACHABLE' },
      );
    }
    if (jobs.running) {
      throw Object.assign(new Error(`该项目正在执行「${jobs.running.title}」，等它结束再来（端口没有改动）。`), {
        code: 'PANEL_BUSY',
      });
    }
  }

  const before = { panel: cfg.panelPort, app: cfg.appPort, pg: cfg.pgPort };
  const appWasRunning = appSt.state === 'running' || appSt.state === 'unhealthy';
  const dbWasRunning = portable && dbSt.state === 'running';
  const panelWasRunning = Boolean(lock);

  /* ---------------------------------------------------------------- B. 分配 */
  // 唯一分配点。avoid 传自己**当前的**三个值（取自 panel.json，权威）——它们必须被
  // 避开，否则挑出来的就是原来那组，按钮点了等于没点。顺带也保证刚腾出来的地址不会
  // 被立刻发回去（Windows 上它可能还在 TIME_WAIT）。
  let next;
  if (want) {
    if (!portable && Number(want.pg) !== Number(before.pg)) {
      throw Object.assign(new Error('这个项目用的是外部数据库，它的端口不由中枢分配，改不了。'), { code: 'BAD_PORTS' });
    }
    const why = await validatePorts(registry, project, want, { current: before });
    if (why) throw Object.assign(new Error(why), { code: 'BAD_PORTS' });
    next = { panel: want.panel, app: want.app, pg: portable ? want.pg : before.pg };
  } else {
    next = await allocatePorts(registry, { avoid: new Set(Object.values(before)) });
    // 候选表全被占时 pickFreePort 会向内核要一个临时端口。兜底不该去掉，但不该静默：
    // 那个值落在文档写明的范围之外，可能撞上防火墙或杀软的兴趣区间。
    for (const o of offRangePorts(portable ? next : { panel: next.panel, app: next.app })) {
      warnings.push(`${PORT_LABELS[o.key]}端口 ${o.port} 落在候选范围之外（候选表已满，用了内核临时端口）。`);
    }
  }
  if (PORT_KEYS.every((k) => next[k] === before[k])) {
    throw Object.assign(new Error('新端口与当前完全相同，没有可改的。'), { code: 'BAD_PORTS' });
  }

  /* ------------------------------------------------- C. 按依赖序停止 */
  // 顺序就是依赖的反序：应用连着库，库先停了应用只会刷一屏错误日志。一律用**旧的** cfg。
  if (appWasRunning) {
    job.line('out', `停止应用（端口 ${before.app}）…`);
    await stopApp(P, cfg, (m) => job.line('out', String(m)));
  } else {
    // stopped 与 orphan 两条路都**不能**调 stopApp：orphan 时端口上坐着一个不是我们
    // 起的进程，stopApp 会抛 ORPHAN_PORT——而「旧端口被别的程序长期占着」恰恰是用户
    // 点这个按钮的常见动机，那条路上不能失败。
    if (appSt.state === 'orphan') {
      warnings.push(`旧的应用端口 ${before.app} 上有一个不是本面板启动的进程，未去动它。`);
    }
    // 但 appStatus 优先信 run/app.json 里记的端口（那是**上次启动时**写死的）。不清掉它，
    // 改完 cfg.appPort 之后卡片上的应用端口会永远显示旧值——功能看起来像没生效。
    // stopApp 自己在这两个分支里也是这么做的（它写 null），我们绕过它时得自己补上。
    if (fs.existsSync(P.appStateFile)) writeJson(P.appStateFile, null);
  }

  if (dbWasRunning) {
    job.line('out', `停止数据库（端口 ${before.pg}）…`);
    await stopPortable(P, cfg, job);
    // pg_ctl 会等 checkpoint，但它失败时会退化成 taskkill。复核一次：cfg 一旦写下去
    // 就没有第二次机会了，而一个还活着的旧 postmaster 会一直占着旧端口。
    if ((await tcpReachable('127.0.0.1', before.pg, 800)).ok) {
      throw new Error(`数据库端口 ${before.pg} 上仍有 PostgreSQL 在监听，已中止（端口没有改动）。`);
    }
  }

  // 面板**必须**停掉：它的 cfg 是模块级单例（panel.mjs:80），saveConfig 散布在
  // opSetup / opRebuild / db-init / db-password / PUT /api/config 里。它活着时我们改
  // panel.json 是一次丢更新——它下一次任何操作都会把内存里的旧 cfg 整份写回去，无声无息。
  const stopRes = await stopPanel(P, SECRET, log);
  if (!stopRes.stopped && stopRes.reason === 'identity-mismatch') {
    throw new Error(
      `锁里的 PID ${stopRes.pid} 存在，但启动时间与记录不符（疑似 PID 被复用），已放弃终止以免误杀无关进程。端口没有改动。`
    );
  }
  // 这两处问的必须都是**进程**在不在：我们关心的是「有没有一个持旧 cfg 的活面板
  // 会把我们的改动覆盖回去」，而一个卡住不回话的面板同样会覆盖，只有 pid 死透了
  // 才安全。用应答当判据会在这里放行——那就正好放出丢更新。
  if (panelProcess(P)) {
    throw new Error('控制面板仍在运行，已中止（端口没有改动）。请先手动关掉它的窗口再试。');
  }

  /* ---------------------------------------------------------------- D. 提交 */
  // 写盘前最后再查一次：POST /open 是无锁的，若有人在这几毫秒里点了「打开控制面板」，
  // 就会起一个持旧 cfg 的面板，把我们的改动整份覆盖回去。宁可 409 让用户重试。
  // （不给 /open 加互斥：那会改变既有操作的行为，收益不抵这里的这一次复查。）
  if (panelProcess(P)) {
    throw Object.assign(new Error('控制面板刚刚又被启动了（可能有人点了「打开控制面板」），端口没有改动，请稍后重试。'), {
      code: 'PANEL_RACED',
    });
  }

  // 从磁盘重新读一遍，丢弃内存里的旧 cfg：C 步花掉的时间里它可能已经变了（比如
  // 面板刚写过的某项设置），而我们手上这份马上要整份落盘。
  const nextCfg = { ...loadConfig(P), panelPort: next.panel, appPort: next.app };
  if (portable) {
    nextCfg.pgPort = next.pg;
    // DSN 必须与新的 pgPort 在**同一次写盘**里生效，否则中间态就是那个静默故障。
    normalizeDbConfig(nextCfg);
  }
  saveConfig(P, nextCfg);
  try {
    ensureEnvFile(P, nextCfg, log, { appPortChanged: before.app });
  } catch (e) {
    // 补偿：把 panel.json 退回旧端口组。做不到按原字节回滚 .env，但能保住
    // 「panel.json 与 .env 描述同一组端口」这条不变式不破。
    saveConfig(P, cfg);
    throw Object.assign(new Error(`写 .env 失败，已把端口退回原值：${e.message}`), { code: 'ENV_WRITE_FAILED' });
  }

  /* ---------------------------------------------------------------- E. 收尾 */
  // 显示缓存先刷。整对象替换而不是逐键改：这样「某个角色这次没动」也不会留下旧值。
  project.ports = { panel: next.panel, app: next.app, pg: next.pg };
  try {
    saveRegistry(runtimeDir, registry);
  } catch (e) {
    warnings.push('端口已改好，但刷新列表缓存失败（只影响显示）：' + e.message);
  }

  const restarted = { pg: false, app: false, panel: false };
  let panelUrl = null;
  let dbOk = true;

  if (dbWasRunning) {
    job.line('out', `在新端口 ${next.pg} 上启动数据库…`);
    try {
      const r = await startPortable(P, nextCfg, job);
      // R2：我们**刚刚才停掉**自己的 postmaster。此时「已经有库在跑」意味着这个端口上
      // 坐着的是**别人的** PostgreSQL——候选范围 55432–55441 正是本产品的默认值，
      // 同一台机器上的另一个数据根极可能占着其中一个，而两个数据根看不见对方的预约。
      // 认领它会让应用连上一个陌生的簇（静默错库），所以绝不能当成功。
      const ourPid = readPidNumber(P.postmasterPid);
      if (r.already && !(ourPid && pidAlive(ourPid))) {
        dbOk = false;
        warnings.push(
          `数据库端口 ${next.pg} 上另有一个不是本项目的 PostgreSQL 在运行，为避免连错库，本项目数据库保持停止。排查：netstat -ano | findstr :${next.pg}`
        );
      } else {
        restarted.pg = true;
      }
    } catch (e) {
      dbOk = false;
      warnings.push(`数据库在新端口 ${next.pg} 上没能起来：${e.message}`);
    }
  }

  if (appWasRunning) {
    if (!dbOk) {
      // 库没起来就起应用 = 刷一屏「连不上数据库」，还可能把自己标成 unhealthy，
      // 而那会污染下一次的预检（appWasRunning 会凭空变成 true）。
      warnings.push('数据库没有就绪，应用未随之启动（免得刷一屏连不上库的错误）。');
    } else {
      job.line('out', `在新端口 ${next.app} 上启动应用…`);
      try {
        const child = startApp(P, nextCfg, (m) => job.line('out', String(m)));
        if (!(await waitForPort(nextCfg.appPort, true, { timeout: 60000, interval: 400 }))) {
          throw new Error(`端口 ${nextCfg.appPort} 在 60 秒内没有就绪`);
        }
        await recordStarted(P, nextCfg, child.pid);
        restarted.app = true;
      } catch (e) {
        warnings.push(`应用没能起来：${e.message}（细节见该项目的「应用错误日志」）`);
      }
    }
  }

  if (panelWasRunning) {
    try {
      const r = await openProject(project); // 面板没被打开过，--no-open 不弹标签页
      restarted.panel = true;
      panelUrl = r.url;
    } catch (e) {
      warnings.push('控制面板没能重新拉起：' + e.message);
    }
  }

  invalidate();
  if (warnings.length) log(`端口重分配 ${project.slug} 有 ${warnings.length} 条告警：\n- ${warnings.join('\n- ')}`);
  return { slug: project.slug, durationMs: Date.now() - t0, before, after: next, restarted, warnings, panelUrl };
}

// ---------------------------------------------------------------- 路由

const LOG_FILES = {
  panel: (P) => P.panelLog,
  app: (P) => P.appLog,
  apperr: (P) => P.appErrLog,
  pg: (P) => P.pgLog,
  build: (P) => P.buildLog,
  console: (P) => path.join(P.logsDir, 'panel.console.log'),
};

async function route(req, res, u) {
  const { pathname: p } = u;
  const method = req.method;

  if (p === '/' || p === '/index.html') return serveIndex(res);
  if (p === '/api/hub/state' && method === 'GET') return json(res, 200, await hubState({ maxAgeMs: 0 }));

  if (p === '/api/projects/stream' && method === 'GET') {
    const es = sse(req, res);
    subscribe(es);
    req.on('close', () => unsubscribe(es));
    return undefined;
  }

  if (p === '/api/projects' && method === 'POST') {
    const b = await readBody(req);
    const repoDir = String(b.repoDir || '').trim();
    if (!repoDir) return fail(res, 400, '请给出仓库目录。');
    try {
      const project = await addProject(registry, runtimeDir, repoDir, { name: b.name ? String(b.name).trim() : null });
      saveRegistry(runtimeDir, registry);
      invalidate();
      log(`已登记项目 ${project.slug} → ${project.runtimeDir}`);
      return json(res, 200, { ok: true, project });
    } catch (e) {
      if (e.code === 'DUPLICATE') return fail(res, 409, e.message);
      if (e.code === 'NOT_A_REPO') return fail(res, 400, e.message);
      throw e;
    }
  }

  const m = /^\/api\/projects\/([^/]+)(?:\/(open|stop|logs|ports))?$/.exec(p);
  if (m) {
    const project = findProject(registry, decodeURIComponent(m[1]));
    if (!project) return fail(res, 404, '列表里没有这个项目。');
    const P = projectPaths(project);
    const action = m[2] || '';

    if (!action && method === 'DELETE') {
      const purge = u.searchParams.get('purge') === '1';
      if (purge) {
        const b = await readBody(req);
        if (String(b.confirmText || '').trim() !== PURGE_PHRASE) {
          return fail(res, 400, `确认短语不正确。要连同运行目录一起删除，需要原样输入「${PURGE_PHRASE}」四个字。`);
        }
        // 问进程而不是问应答：清盘会删掉它的运行目录，一个卡住的活面板一样会当场
        // 精神错乱，只有 pid 死透了才能删。
        if (panelProcess(P)) return fail(res, 409, '面板还在运行，请先停止它再删除。');
        // 收编的旧部署还要多一关：它的清盘是**按名字**做的细活（见 lib/registry.mjs
        // 的 LEGACY_PURGE_RELS），不是 rm -rf 整个目录。postmaster 还占着 pgdata 时，
        // Windows 上会删到一半失败，留下一个「看着还在、其实已经缺了几个文件」的
        // 数据目录——那比当场拒绝难查得多。所以跑着的一律先停。
        // （普通项目走整目录删除，不存在这种「删一半」的形态，因此不加这一关。）
        if (project.legacy) {
          const cfg = projectConfig(project);
          const [appSt, dbSt] = await Promise.all([appStatus(P, cfg), pgStatus(P, cfg)]);
          if (dbSt.state === 'running' || dbSt.state === 'unhealthy') {
            return fail(res, 409, `数据库端口 ${dbSt.port} 上还有 PostgreSQL 在跑，请先停掉它再清盘。`);
          }
          if (appSt.state === 'running' || appSt.state === 'unhealthy') {
            return fail(res, 409, '应用还在运行，请先停掉它再清盘。');
          }
        }
      }
      // **先清盘、后注销**。反过来的话，清到一半失败（单个文件被占在 Windows 上是
      // 常态）时列表里已经没有这一条了，用户连重试的按钮都找不到。
      const wiped = purge ? purgeProject(project) : null;
      const removed = removeProject(registry, project.slug);
      saveRegistry(runtimeDir, registry);
      if (wiped) {
        log(
          wiped.mode === 'whole'
            ? `已删除项目 ${removed.slug} 及其运行目录 ${wiped.root}`
            : `已删除收编的旧部署 ${removed.slug}：清掉 ${wiped.removed.length} 项（${wiped.removed.join('、')}），保留 ${wiped.kept.join('、')}；数据根 ${wiped.root} 本身未删`,
        );
      } else {
        log(`已从列表移除 ${removed.slug}（运行目录保留在 ${P.runtime}）`);
      }
      invalidate();
      return json(res, 200, {
        ok: true,
        removed: removed.slug,
        purged: Boolean(purge),
        legacy: Boolean(project.legacy),
        // 界面要照着这个说实话：整目录删掉和「按名字删了 15 项、数据根还在」是两回事。
        purge: wiped,
      });
    }

    if (action === 'open' && method === 'POST') {
      if (!looksLikeRepo(project.repoDir)) return fail(res, 400, `仓库目录不存在或不再像仓库：${project.repoDir}`);
      const r = await openProject(project);
      invalidate();
      return json(res, 200, { ok: true, ...r });
    }

    if (action === 'stop' && method === 'POST') {
      const r = await stopPanel(P, SECRET, log);
      invalidate();
      if (!r.stopped && r.reason === 'identity-mismatch') {
        return fail(res, 409, `锁里的 PID ${r.pid} 存在，但启动时间与记录不符（疑似 PID 被复用），已放弃终止以免误杀无关进程。`);
      }
      return json(res, 200, { ok: true, ...r, appStillRunning: true });
    }

    if (action === 'logs' && method === 'GET') {
      const which = String(u.searchParams.get('file') || 'panel');
      const pick = LOG_FILES[which];
      if (!pick) return fail(res, 400, `未知的日志：${which}。可选：${Object.keys(LOG_FILES).join(' / ')}`);
      return json(res, 200, { file: which, ...readTail(pick(P), Number(u.searchParams.get('lines')) || 200) });
    }

    // 重新分配端口。GET 只读：探一遍候选端口拿建议值，不改任何状态、不停任何进程，
    // 所以照 http.mjs 的护栏设计**不需要令牌**（它只读）。
    if (action === 'ports' && method === 'GET') {
      const cfg = projectConfig(project);
      const current = { panel: cfg.panelPort, app: cfg.appPort, pg: cfg.pgPort };
      const portable = cfg.dbMode !== 'external';
      const suggested = await allocatePorts(registry, { avoid: new Set(Object.values(current)) });
      if (!portable) suggested.pg = current.pg; // 外部库的端口不是我们的，建议值里也不该出现
      return json(res, 200, { ok: true, current, suggested, portable, pending: pendingFor(project.slug) });
    }

    if (action === 'ports' && method === 'POST') {
      if (reallocInFlight) {
        return fail(res, 409, `正在为项目「${reallocInFlight.slug}」重新分配端口，请等它结束再试（同一时刻只允许一个）。`);
      }
      // 互斥必须在**任何 await 之前同步**置位：中枢是单线程的，只有同步置位才能保证
      // 第二个请求走到这行时一定看得见第一个。try/finally 清掉，否则一次异常会让这个
      // 功能永久锁死（界面上按钮一直是禁用的）。
      reallocInFlight = { slug: project.slug, kind: 'realloc', startedAt: Date.now() };
      invalidate();
      try {
        const b = await readBody(req);
        if (b.confirmDowntime !== true) {
          return fail(res, 400, '这个操作会先停掉正在运行的应用与数据库、改完再按原状态拉回来，需要明确确认。');
        }
        // 弹窗里那三个可编辑的输入框。不传就是「按中枢自动挑的那组来」。
        const want =
          b.ports && typeof b.ports === 'object'
            ? { panel: Number(b.ports.panel), app: Number(b.ports.app), pg: Number(b.ports.pg) }
            : null;
        const r = await reallocatePorts(project, want);
        return json(res, 200, { ok: true, ...r });
      } catch (e) {
        // 提交前的失败都是「磁盘零改动」，用户看懂原因就能自己处理，所以是 4xx；
        // 其余的（含提交后服务没起来）交给顶层：它会记完整堆栈并如实返回 500。
        if (e.code === 'BAD_PORTS') return fail(res, 400, e.message);
        if (e.code === 'PANEL_BUSY' || e.code === 'PANEL_RACED') return fail(res, 409, e.message);
        throw e;
      } finally {
        reallocInFlight = null;
        invalidate();
      }
    }

    return fail(res, 405, `这个项目不支持 ${method} ${p}`);
  }

  return fail(res, 404, `没有这个接口：${method} ${p}`);
}

function serveIndex(res) {
  let html;
  try {
    html = fs.readFileSync(path.join(UI_DIR, 'index.html'), 'utf8');
  } catch (e) {
    return fail(res, 500, `读不到中枢界面：${e.message}`);
  }
  const body = html.replaceAll('__AC_TOKEN__', TOKEN).replaceAll('__AC_HUB_PORT__', String(actualHubPort));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

// ---------------------------------------------------------------- 生命周期

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  log('中枢退出（各项目的应用、数据库与子面板都继续运行）。');
  try {
    fs.rmSync(HUB_LOCK, { force: true });
  } catch {}
  try {
    server?.close();
  } catch {}
  logStream.end();
  setTimeout(() => process.exit(0), 200).unref();
}

/** 已经有一个中枢在跑吗？在跑就直接把浏览器指过去。 */
async function findRunningHub() {
  const lock = readJson(HUB_LOCK, null);
  if (!lock?.pid || !lock?.port) return null;
  if (!pidAlive(lock.pid)) return null;
  if (lock.runtimeDir && path.resolve(lock.runtimeDir) !== path.resolve(runtimeDir)) return null;
  const r = await httpProbe(`http://127.0.0.1:${lock.port}/api/hub/state`, { timeout: 1500 });
  return r.ok ? lock : null;
}

async function main() {
  const existing = await findRunningHub();
  if (existing) {
    console.log(`检测到中枢已在运行（端口 ${existing.port}），直接打开它。`);
    openBrowser(`http://127.0.0.1:${existing.port}/`, log);
    process.exit(0);
  }

  // 注册表只在「本次确实要成为中枢进程」时才动。
  //
  // 这一段以前在模块顶层，于是第二次启动虽然马上就会发现已有中枢并退出，却已经先
  // 读—改—写了一遍 projects.json：在跑的那个进程刚写下的列表（包括 ignoredRepos
  // 与端口预约）会被这份陈旧副本覆盖回去。收编旧部署还必须幂等——路径写法不同
  // （大小写、junction、8.3 短名）不能被当成另一套部署，见 registry.mjs 的
  // samePath / dedupeProjects。
  const merged = dedupeProjects(registry);
  if (merged) log(`注册表里有 ${merged} 条重复的项目条目，已合并。`);
  if (migrateLegacy(runtimeDir, registry)) {
    log(`已把数据根里既有的单项目部署原地收编进列表（${registry.projects.length} 个项目）。`);
  }

  // 顺延范围只到 8799：新项目的预约从 8800 起，两者结构上不相交（见 registry.mjs）。
  if (!(await portFree(actualHubPort, '127.0.0.1'))) {
    const fallback = await pickFreePort(Array.from({ length: 12 }, (_, i) => actualHubPort + 1 + i));
    log(`中枢端口 ${actualHubPort} 被占用，改用 ${fallback}。`);
    actualHubPort = fallback;
  }
  registry.hub = { ...registry.hub, port: wantPort, actualPort: actualHubPort };
  saveRegistry(runtimeDir, registry);

  const guard = createGuard({ getPort: () => actualHubPort, tokens: TOKENS, onLog: log });
  server = http.createServer(async (req, res) => {
    const u = guard(req, res);
    if (!u) return;
    try {
      await route(req, res, u);
    } catch (e) {
      // 请求体坏掉是**客户端**的错，不是服务端出错。readBody 抛的这两个码要
      // 原样映射成 400，否则用户看到 500 会去翻中枢日志，而日志里什么都没有。
      if (e.code === 'BAD_JSON' || e.code === 'BODY_TOO_LARGE') {
        if (!res.headersSent) fail(res, 400, e.message);
        return;
      }
      log('处理请求出错：' + (e.stack || e.message));
      if (!res.headersSent) fail(res, 500, e.message);
    }
  });
  server.requestTimeout = 0;
  server.headersTimeout = 0;
  server.keepAliveTimeout = 72000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(actualHubPort, '127.0.0.1', resolve);
  });

  fs.writeFileSync(
    HUB_LOCK,
    JSON.stringify({ pid: process.pid, port: actualHubPort, runtimeDir, pidStartTime: await processStartTime(process.pid), startedAt: Date.now() }, null, 2),
  );

  const url = `http://127.0.0.1:${actualHubPort}/`;
  console.log('');
  console.log('  AgileCampus 中枢已启动');
  console.log(`  中枢地址   ${url}`);
  console.log(`  数据根     ${runtimeDir}`);
  console.log(`  已登记     ${registry.projects.length} 个项目`);
  for (const pr of registry.projects) console.log(`             ${pr.name}  ${pr.repoDir}${pr.legacy ? '（收编的旧部署）' : ''}`);
  console.log('');

  if (!argv.includes('--no-open')) openBrowser(url, log);

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  if (process.platform === 'win32') process.on('SIGBREAK', shutdown);
  process.on('uncaughtException', (e) => log('未捕获异常：' + (e.stack || e.message)));
  process.on('unhandledRejection', (e) => log('未处理的 Promise 拒绝：' + (e?.stack || e)));
}

/**
 * --selftest：与面板那份同义——把 folder 模式与单文件 exe 模式之间仅有的两处差异
 * （资源读取、Node 解析）打出来，外加中枢特有的注册表与引擎目录。
 */
async function selftest() {
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
    node.exe = nodeExe(null);
  } catch (e) {
    node.error = `${e.code || 'ERROR'}: ${e.message}`;
  }
  const report = {
    mode: isSea() ? 'sea' : 'folder',
    role: 'hub',
    execPath: process.execPath,
    panelVersion: PANEL_VERSION,
    runtimeDir,
    registryFile: path.join(runtimeDir, 'projects.json'),
    projects: registry.projects.map((p) => ({ slug: p.slug, repoDir: p.repoDir, runtimeDir: p.runtimeDir, legacy: Boolean(p.legacy) })),
    engine: { dir: ENGINE_DIR, mainJs: MAIN_JS, exists: fs.existsSync(MAIN_JS) },
    ui,
    node,
    nodeVersion: process.version,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(!ui.error && ui.bytes > 0 ? 0 : 1);
}

if (argv.includes('--selftest')) {
  selftest().catch((e) => {
    console.error('自检失败：', e.message);
    process.exit(1);
  });
} else {
  main().catch((e) => {
    console.error('中枢启动失败：', e.message);
    log('中枢启动失败：' + (e.stack || e.message));
    process.exit(1);
  });
}
