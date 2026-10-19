// 数据库检修：先诊断出「到底哪一环断了」，再按项修复。
//
// 为什么需要它：界面上那个「数据库」其实是好几个互相独立的信号拼出来的
// —— 进程存活 / 端口监听 / 接受连接 / 认证通过 / 库存在 / 表建好 / 应用能查到数据。
// 它们可以彼此矛盾，而且**矛盾时界面照样一片绿**。实测那次事故就是这样：
//
//   · 面板端口浅检查的是 cfg.pgPort = 55432 ── 通
//   · postgres 进程活着，pg_isready 退出码 0 ── 全好
//   · 应用读 .env 里的 DATABASE_URL (localhost:5432) ── ECONNREFUSED 500
//
// 起因是「保存 .env」当时用仓库的 .env.example 当骨架，只改一个键就会把其余键
// 打回模板占位值。三个信号各说各话，用户看到的只是「数据库好像有问题」。
// 所以这里的第 1 条检查就是「应用读的连接串和面板配置的是不是同一个库」——
// 它便宜、确定，而且正好能把上面那类断裂一句话说清。
//
// 诊断只读；修复要显式调用 repair()，危险项（清空重建）另需确认。
import fs from 'node:fs';
import path from 'node:path';
import { spawnInto } from './jobs.mjs';
import { readEnvText, envToObject, templatePlaceholders, writeEnv, randomToken } from './config.mjs';
import { httpProbe } from './sysinfo.mjs';
import * as pg from './pg.mjs';
import { withPath } from './nodebin.mjs';
// 部署期环境（npm / next / drizzle 继承的那一份）。**必须是同一个 buildEnv** ——
// 检修查一份、部署用另一份，是最没意义的错位。deploy.mjs 不反向依赖本模块
// （pg / proc 都是调用方注入的），所以这里没有环。
import { buildEnv } from './deploy.mjs';
import { checks as envChecks, logChecks, pathDirs } from './preflight.mjs';

const OK = 'ok';
const WARN = 'warn';
const FAIL = 'fail';
const SKIP = 'skip';

/**
 * 跑一条 SQL，回退出码与输出。
 *
 * quiet 默认 true：诊断类探针的输出由调用方翻译成人话即可。
 * 但**破坏性语句**一定要传 quiet:false —— 那是用户需要亲眼看到的服务端回应，
 * 不能让面板替他概括成「已重置」。
 */
function sql(P, cfg, password, text, job, { db = 'postgres', timeoutMs = 20000, quiet = true } = {}) {
  return spawnInto(
    job,
    P.psql,
    ['-h', '127.0.0.1', '-p', String(cfg.pgPort), '-U', 'agilecampus', '-d', db, '-tAc', text],
    {
      env: withPath({ ...process.env, PGPASSWORD: password }, P, P.pgBin),
      timeoutMs,
      quiet,
    }
  );
}

/** 试出能连上的那个密码（面板记录的优先，其次 .env 里的）。 */
async function findWorkingPassword(P, cfg, job) {
  const env = envToObject(readEnvText(P));
  const tries = cfg.dbMode === 'portable' ? [cfg.pgPassword, env.POSTGRES_PASSWORD] : [pg.parseDsn(cfg.databaseUrl)?.password, env.POSTGRES_PASSWORD];
  for (const pw of tries.filter(Boolean)) {
    const r = await sql(P, cfg, pw, 'select 1', job);
    if (r.code === 0) return pw;
  }
  return null;
}

async function scalar(P, cfg, password, text, job, opts) {
  const r = await sql(P, cfg, password, text, job, opts);
  return r.code === 0 ? (r.output || '').trim().split('\n').pop() : null;
}

/**
 * src/db/schema.ts 里声明了几张表。drizzle 用 pgTable("名字", …)，数它即可。
 *
 * 路径要按候选表找，不能拼死一个：仓库里是 `src/db/schema.ts`，
 * 而运行目录的源码副本下还有一层 `src`，即 `<srcDir>/src/db/schema.ts`。
 * 之前只试了 `<srcDir>/db/schema.ts`，于是永远读不到、永远返回 null，
 * 而调用方（表数量比对）把 null 当成「无法比对」静默跳过——
 * 一个写错的路径就这么伪装成了一次正常的跳过。
 */
const SCHEMA_CANDIDATES = ['src/db/schema.ts', 'db/schema.ts', 'src/lib/db/schema.ts'];

export function expectedTableCount(P) {
  for (const rel of SCHEMA_CANDIDATES) {
    try {
      const text = fs.readFileSync(path.join(P.srcDir, ...rel.split('/')), 'utf8');
      const n = (text.match(/pgTable\s*\(/g) || []).length;
      if (n) return n;
    } catch {
      /* 试下一个候选 */
    }
  }
  return null;
}

const maskDsn = (dsn) => {
  if (!dsn) return '（空）';
  const x = pg.parseDsn(dsn);
  return x ? `${x.host}:${x.port}/${x.database}` : '无法解析';
};

/**
 * 端到端探针：给 /api/agent/projects 发一个**格式合法但伪造的** ac_ 令牌。
 *
 *  401 → 全链路通（应用活着 ∧ 数据库连得上 ∧ api_tokens 表真的建好了）
 *  500 → 应用活着，但数据库查询抛错
 * 无响应 → 应用挂了
 *
 * 必须带 ac_ 前缀：verifyApiToken 对不以 ac_ 开头的串会在触库**之前**就返回，
 * 那样 401 只证明「应用收到了请求」，证明不了数据库可用。
 */
async function e2eProbe(cfg) {
  const fake = `ac_${'A'.repeat(64)}`;
  const r = await httpProbe(`http://127.0.0.1:${cfg.appPort}/api/agent/projects`, {
    timeout: 15000,
    headers: { Authorization: `Bearer ${fake}` },
  });
  const verdict = r.status === 401 ? 'all-ok' : r.status === 500 ? 'db-error' : r.status === null ? 'app-down' : 'unexpected';
  return { verdict, status: r.status, ms: r.ms };
}

/**
 * 逐项体检。只读，不改任何东西。
 * 返回 { checks, candidates } —— candidates 是「试出来的可用旧密码」，
 * 供修复阶段复用（不写进返回给界面的对象里）。
 */
export async function diagnose(P, cfg, deps, job) {
  const { proc } = deps;
  const env = envToObject(readEnvText(P));
  const tmpl = templatePlaceholders(P);
  const checks = [];
  const add = (id, title, level, detail, fixId = null) => checks.push({ id, title, level, detail, fixId });
  const unset = (k) => !env[k] || (tmpl[k] !== undefined && env[k] === tmpl[k]);

  // ---------------------------------------------------------- A 配置一致性
  const portable = cfg.dbMode === 'portable';
  if (!portable) {
    add('env-dsn', '连接串来源', SKIP, `当前是外部数据库模式，连接串由你在配置里指定（${maskDsn(cfg.databaseUrl)}），不做自动比对。`);
  } else if (env.DATABASE_URL !== cfg.databaseUrl) {
    add(
      'env-dsn',
      '应用读的连接串与面板一致',
      FAIL,
      `.env 里是 ${maskDsn(env.DATABASE_URL)}，面板配置与便携数据库是 ${maskDsn(cfg.databaseUrl)}。` +
        '应用启动时读的是 .env，所以它连的是一个并不存在的库——而面板的端口探测查的是面板自己的端口，照样显示正常。',
      'env-sync'
    );
  } else {
    add('env-dsn', '应用读的连接串与面板一致', OK, `两边都是 ${maskDsn(cfg.databaseUrl)}。`);
  }

  if (portable && env.POSTGRES_PASSWORD !== cfg.pgPassword) {
    add(
      'env-password',
      '.env 的库密码与面板一致',
      FAIL,
      unset('POSTGRES_PASSWORD')
        ? '仍是从 .env.example 带过来的占位值 change-me-strong-password，与真实数据簇的密码不符。'
        : '与面板记录（也就是数据簇创建时用的那个）不一致，应用会被拒之门外。',
      'env-sync'
    );
  } else if (portable) {
    add('env-password', '.env 的库密码与面板一致', OK, '一致。');
  }

  const secretBad = unset('AUTH_SECRET');
  add(
    'env-secret',
    'AUTH_SECRET 不是仓库占位值',
    secretBad ? FAIL : OK,
    secretBad
      ? 'AUTH_SECRET 为空或仍是 .env.example 里的 change-me-run-npx-auth-secret——这是仓库里公开的串，等于用公开密钥签所有人的会话，任何拿到源码的人都能伪造登录。'
      : '已是本机生成的随机密钥。',
    secretBad ? 'env-sync' : null
  );

  add(
    'env-trusthost',
    'AUTH_TRUST_HOST 已设置',
    env.AUTH_TRUST_HOST ? OK : FAIL,
    env.AUTH_TRUST_HOST
      ? '已设为 true，Auth.js 不会因 Host 不受信而拒绝请求。'
      : '缺少这一项。Auth.js v5 自托管必须显式声明，否则日志里会满屏 UntrustedHost: Host must be trusted。',
    env.AUTH_TRUST_HOST ? null : 'env-sync'
  );

  add(
    'env-cron',
    'CRON_SECRET 已设置',
    unset('CRON_SECRET') ? WARN : OK,
    unset('CRON_SECRET') ? '为空，「定时提醒」的 cron 端点无法鉴权调用。与数据库无关，顺手报一下。' : '已设置。',
    unset('CRON_SECRET') ? 'env-sync' : null
  );

  // 「改了 .env 但没重启」——很常见，且症状与本节其它项一模一样
  const appSt = proc.readAppState(P);
  if (appSt?.startedAt && fs.existsSync(P.envFile)) {
    const envMtime = fs.statSync(P.envFile).mtimeMs;
    if (envMtime > appSt.startedAt + 1000) {
      add(
        'env-restart',
        '.env 修改后已重启应用',
        WARN,
        `.env 在 ${new Date(envMtime).toLocaleString('zh-CN')} 被改过，而应用是 ${new Date(appSt.startedAt).toLocaleString('zh-CN')} 启动的` +
          '——应用用的还是旧配置。.env 只在启动时读一次。',
        'app-restart'
      );
    } else {
      add('env-restart', '.env 修改后已重启应用', OK, '应用比 .env 新。');
    }
  }

  // ------------------------------------------------------------ B 数据库进程
  if (!portable) {
    add('pg-binary', '便携数据库', SKIP, '外部数据库模式，跳过便携版的检查。');
  } else if (!pg.portableInstalled(P)) {
    add('pg-binary', '便携数据库已就位', FAIL, `找不到 ${P.pgsqlDir} 里的可执行文件，需要重新下载。`, 'pg-install');
  } else {
    add('pg-binary', '便携数据库已就位', OK, `二进制在 ${P.pgsqlDir}。`);
  }

  const hasCluster = fs.existsSync(P.pgVersionFile);
  if (portable) {
    add(
      'pg-cluster',
      '数据簇已初始化',
      hasCluster ? OK : FAIL,
      hasCluster ? `PG_VERSION 存在（${P.pgData}）。` : `${P.pgData} 里没有 PG_VERSION，这个目录还不是一个可用的数据簇。`,
      hasCluster ? null : 'pg-reinit'
    );
  }

  const st = await pg.pgStatus(P, cfg);
  if (portable) {
    add(
      'pg-proc',
      '数据库进程与端口',
      st.state === 'running' ? OK : hasCluster ? FAIL : SKIP,
      st.state === 'running'
        ? `${st.host}:${st.port} 正在监听${st.pid ? `，postmaster PID ${st.pid}` : ''}。`
        : hasCluster
          ? `没有进程在监听 ${st.host}:${st.port}，数据库没在运行。`
          : '数据簇还没初始化，谈不上启动。',
      st.state === 'running' ? null : 'pg-restart'
    );
    if (st.postmasterPidStale) {
      add(
        'pg-stale-pid',
        'postmaster.pid 未陈旧',
        FAIL,
        '数据目录里留着上一次运行遗留的 postmaster.pid，而那个 PID 已经不存在。' +
          '它会让 pg_ctl 拒绝启动（"lock file exists"），必须先清掉。',
        'pg-stale-pid'
      );
    }

    // 「端口在监听」≠「能连」。崩溃恢复中的数据簇正在监听，但一律拒连。
    if (st.state === 'running' || st.tcpReachable) {
      let ready = null;
      if (fs.existsSync(P.pgIsReady)) {
        const r = await spawnInto(job, P.pgIsReady, ['-h', '127.0.0.1', '-p', String(cfg.pgPort), '-t', '5'], {
          timeoutMs: 10000,
          quiet: true,
        });
        ready = r.code === 0;
      }
      add(
        'pg-accept',
        '端口可以真正建立连接',
        ready === false ? FAIL : ready === null ? SKIP : OK,
        ready === false
          ? '端口在监听但拒绝连接，多半是在做崩溃恢复（上一次被强杀或断电）。' +
            '这种状态下任何连接都返回 FATAL: the database system is starting up，等它恢复完即可。'
          : ready === null
            ? '找不到 pg_isready，跳过这项判断。'
            : '接受连接。',
        ready === false ? 'pg-restart' : null
      );
    }
  }

  // ------------------------------------------------------- C 认证 / 库 / 表
  // 这一节会真的用凭据连一次。.env 里的密码也可能是「对的那个」——
  // 若两者不同，就把两个都试一遍，能通的那个记进 candidates，修复时直接复用。
  const candidates = [];
  if (portable && hasCluster && (st.state === 'running' || st.tcpReachable)) {
    for (const pw of [cfg.pgPassword, env.POSTGRES_PASSWORD].filter(Boolean)) {
      if (candidates.includes(pw)) continue;
      const v = await scalar(P, cfg, pw, 'select 1', job);
      if (v === '1') candidates.push(pw);
    }
    const which = candidates[0] === cfg.pgPassword ? '面板记录的密码' : candidates.length ? '.env 里的密码' : null;
    add(
      'pg-auth',
      '凭据能通过认证',
      candidates.length ? OK : FAIL,
      candidates.length
        ? `用${which}连接成功。`
        : '面板记录的密码和 .env 里的密码都连不上。数据簇是 scram-sha-256 认证，密码对不上就是连不了，与网络无关。',
      candidates.length ? null : 'pg-reset-password'
    );

    if (candidates.length) {
      const pw = candidates[0];
      const cdb = await scalar(P, cfg, pw, "select 1 from pg_database where datname='agilecampus'", job);
      add(
        'pg-database',
        'agilecampus 库存在',
        cdb === '1' ? OK : FAIL,
        cdb === '1' ? '库在。' : '数据簇是好的，但没有 agilecampus 这个库，应用连上去会报 database does not exist。',
        cdb === '1' ? null : 'pg-createdb'
      );

      if (cdb === '1') {
        const n = Number(
          await scalar(P, cfg, pw, "select count(*) from information_schema.tables where table_schema='public'", job, { db: 'agilecampus' })
        );
        const want = expectedTableCount(P);
        if (!Number.isFinite(n)) {
          add('pg-tables', '表结构已推送', SKIP, '数不出表数量（连接或权限问题）。');
        } else if (n === 0) {
          add(
            'pg-tables',
            '表结构已推送',
            FAIL,
            `public 里一张表都没有，而 src/db/schema.ts 声明了 ${want ?? '若干'} 张。drizzle-kit push 没跑过，或跑在了另一个库上。`,
            'pg-push-schema'
          );
        } else {
          add(
            'pg-tables',
            '表结构已推送',
            want && n < want ? WARN : OK,
            want ? `public 里有 ${n} 张表，schema.ts 声明 ${want} 张。` : `public 里有 ${n} 张表。`
          );
        }
      }
    }
  } else if (portable) {
    add('pg-auth', '凭据能通过认证', SKIP, '数据库没在运行，先让它起来再验。');
  }

  // ---------------------------------------------------------------- D 端到端
  const app = await proc.appStatus(P, cfg);
  if (app.state !== 'running') {
    add('e2e', '端到端（应用→数据库）', SKIP, '应用没在运行，无法验。');
  } else {
    const probe = await e2eProbe(cfg);
    add(
      'e2e',
      '端到端（应用→数据库）',
      probe.verdict === 'all-ok' ? OK : FAIL,
      probe.verdict === 'all-ok'
        ? '应用用格式合法但伪造的令牌查 api_tokens 表，返回 401 —— 整条链路（应用 ∧ 数据库 ∧ 表结构）都在。'
        : probe.verdict === 'db-error'
          ? '应用活着，但查数据库时报错了。请对照上面几项定位：多半是连接串、密码或表结构的问题。'
          : `探针返回 ${probe.status}，不是预期的 401。`,
      null
    );
  }

  // ------------------------------------------------------------------ E 容量
  try {
    const st2 = fs.statfsSync(P.runtime);
    const freeGb = (st2.bsize * st2.bavail) / 1024 ** 3;
    add(
      'disk',
      '运行目录所在磁盘空间',
      freeGb < 2 ? FAIL : freeGb < 5 ? WARN : OK,
      `剩余 ${freeGb.toFixed(1)} GB。数据簇与构建产物都在这块盘上。`,
      null
    );
  } catch {
    add('disk', '运行目录所在磁盘空间', SKIP, '读不到磁盘信息。');
  }

  // ------------------------------------------------- F 子进程环境（部署要用的那份）
  // 放在最后，因为它查的是**另一侧**：前面几条都在问「库这一侧通不通」，这一条问
  // 「跑 npm / next / drizzle 的那一侧找不找得到 node」。首次部署真的栽在它上面过
  // 一次，而在界面上它伪装成了「依赖安装失败，可能是网络问题」。
  //
  // 这里用的必须是 buildEnv 本人：检修看到的环境和部署实际拿到的环境，只能是同一份。
  try {
    for (const c of envChecks(P, buildEnv(P, cfg))) add(c.id, c.title, c.level, c.detail, c.fixId);
  } catch (e) {
    add('env-build', '能构造出部署用的子进程环境', FAIL, `构造失败：${e.message}`, null);
  }

  return { checks, candidates, env, app };
}

// ------------------------------------------------------------------ 修复

/** 一项修复的元信息。destructive 的必须显式确认。 */
export const FIXES = {
  'env-path': { title: '重算子进程的 PATH（从注册表兜底）并复验 node 可用', destructive: false },
  'env-sync': { title: '对齐 .env 与面板配置', destructive: false },
  'pg-install': { title: '下载并解压便携 PostgreSQL', destructive: false },
  'pg-stale-pid': { title: '清理陈旧的 postmaster.pid', destructive: false },
  'pg-restart': { title: '重启数据库（必要时先强杀）', destructive: false },
  'pg-createdb': { title: '创建 agilecampus 库', destructive: false },
  'pg-push-schema': { title: '推送表结构（drizzle-kit push）', destructive: false },
  'pg-reset-password': { title: '把数据簇密码重置为面板记录的值', destructive: false },
  'app-restart': { title: '重启应用', destructive: false },
  'pg-reinit': { title: '清空数据簇并重建（会丢掉所有数据）', destructive: true },
};

/**
 * 默认推荐顺序：先修环境，再修配置，再修进程，最后才动数据。
 *
 * 导出是为了能被验证（顺序本身是一条不变式：环境坏了的话，后面那些修复项自己
 * 也会起不来，还会各自报出一个不相干的错）。
 */
export const FIX_ORDER = [
  // 排在最前：后面那些修复项自己也要起 node（drizzle-kit 推表结构、重启应用），
  // 环境坏了它们会跟着一起失败，还会各自报出一个不相干的错。
  'env-path',
  'env-sync',
  'pg-install',
  'pg-stale-pid',
  'pg-restart',
  'pg-createdb',
  'pg-push-schema',
  'pg-reset-password',
  'app-restart',
  'pg-reinit',
];

/**
 * 把数据簇密码重置为 cfg.pgPassword。
 *
 * 先用「试出来的可用旧密码」ALTER；一个都不通才走 trust 兜底：
 * 临时把 pg_hba.conf 里回环那几行改成 trust、重启、ALTER、再改回来。
 * 这条路要动 pg_hba.conf，所以全程先备份，并在 finally 里恢复，
 * 免得留下一个「本地随便连」的库。
 */
async function resetPassword(P, cfg, job, candidates) {
  const target = cfg.pgPassword;
  for (const old of candidates) {
    if (old === target) continue;
    const r = await sql(P, cfg, old, `ALTER USER agilecampus WITH PASSWORD '${target}'`, job);
    if (r.code === 0) {
      job.line('out', '已用可用凭据把密码改成面板记录的值。');
      return { via: 'alter' };
    }
  }
  if (candidates.includes(target)) return { via: 'already' };

  const hba = path.join(P.pgData, 'pg_hba.conf');
  if (!fs.existsSync(hba)) throw new Error(`找不到 ${hba}，无法走 trust 兜底。`);
  const backup = `${hba}.ac-backup`;
  const original = fs.readFileSync(hba, 'utf8');
  fs.writeFileSync(backup, original, 'utf8');
  job.line('out', '现有凭据都连不上，临时把回环连接改成 trust 以重置密码（改完立即还原）…');
  try {
    await pg.stopPortable(P, cfg, job);
    // 只改回环那两行，其它行（尤其是外部网段）保持原样
    const patched = original
      .split(/\r?\n/)
      .map((l) => (/^\s*host\s+all\s+all\s+(127\.0\.0\.1\/32|::1\/128)\s+/.test(l) ? l.replace(/scram-sha-256\s*$/, 'trust') : l))
      .join('\n');
    fs.writeFileSync(hba, patched, 'utf8');
    await pg.startPortable(P, cfg, job);
    const r = await sql(P, cfg, '', `ALTER USER agilecampus WITH PASSWORD '${target}'`, job);
    if (r.code !== 0) throw new Error('trust 模式下 ALTER USER 仍然失败，请查看上方输出。');
    job.line('out', '密码已重置。');
  } finally {
    fs.writeFileSync(hba, original, 'utf8');
    fs.rmSync(backup, { force: true });
    await pg.stopPortable(P, cfg, job).catch(() => {});
    await pg.startPortable(P, cfg, job).catch((e) => job.line('err', `恢复 pg_hba.conf 后重启失败：${e.message}`));
  }
  return { via: 'trust' };
}

/** 清空数据簇重建。调用方必须已经拿到用户的显式确认。 */
async function reinitCluster(P, cfg, job, deps) {
  const { pg: pgmod } = deps;
  await pgmod.stopPortable(P, cfg, job).catch(() => {});
  if (fs.existsSync(P.pgData)) {
    for (const f of fs.readdirSync(P.pgData)) fs.rmSync(path.join(P.pgData, f), { recursive: true, force: true });
    job.line('out', `已清空 ${P.pgData}。`);
  }
  await pgmod.initCluster(P, cfg, job, { allowWipe: true });
  await pgmod.startPortable(P, cfg, job);
  await pgmod.ensureDatabase(P, cfg, job);
  return { reinitialized: true };
}

/**
 * 执行一批修复。只跑传进来的 ids，按 FIX_ORDER 排好序。
 * 每一项都是「重新诊断 → 只对该项动作」，所以顺序本身不敏感。
 */
export async function repair(P, cfg, job, deps, { ids = [], confirmDestructive = false } = {}) {
  const wanted = FIX_ORDER.filter((id) => ids.includes(id));
  const unknown = ids.filter((id) => !FIXES[id]);
  if (unknown.length) throw new Error(`未知的修复项：${unknown.join('、')}`);
  const destructive = wanted.filter((id) => FIXES[id].destructive);
  if (destructive.length && !confirmDestructive) {
    const e = new Error(`修复项「${destructive.map((d) => FIXES[d].title).join('、')}」会永久丢掉数据库里的数据，需要显式确认。`);
    e.code = 'CONFIRM_REQUIRED';
    e.destructive = destructive;
    throw e;
  }

  const before = await diagnose(P, cfg, deps, job);
  const { candidates } = before;
  const done = [];

  for (let i = 0; i < wanted.length; i += 1) {
    const id = wanted[i];
    job.step(i);
    job.stepDetail(i, FIXES[id].title);
    job.line('out', `—— ${FIXES[id].title} ——`);

    if (id === 'env-path') {
      // 自愈本身在 buildEnv 里（部署每次都会走），所以这一项做的不是「修」，而是
      // **把它逼出来给人看**：重算一遍、把补了什么说清楚、再复验一次 node 真跑得起来。
      // 这也是它 title 写「重算…并复验」而不是「修复」的原因。
      const notes = [];
      const childEnv = buildEnv(P, cfg, notes);
      if (notes.length) for (const n of notes) job.line('warn', n);
      else job.line('out', '继承来的 PATH 是好的，没有需要补的。');
      job.line('out', `子进程 PATH 共 ${pathDirs(childEnv).length} 个目录。`);
      const list = envChecks(P, childEnv);
      logChecks(job, list);
      const bad = list.filter((c) => c.level === 'fail');
      if (bad.length) {
        // 剩下的几项（解析不出 Node / 那份 Node 不完整）不是补 PATH 能解决的，
        // 说清楚它们各要什么，别让「点过修复了」变成一句空话。
        job.line('err', `仍有 ${bad.length} 项没解决，它们不是 PATH 能补上的：${bad.map((b) => b.title).join('、')}。`);
      }
    } else if (id === 'env-sync') {
      // 用上游修好的 writeEnv（骨架是当前 .env，不是仓库模板），只改该改的键
      const env = envToObject(readEnvText(P));
      const tmpl = templatePlaceholders(P);
      const unset = (k) => !env[k] || (tmpl[k] !== undefined && env[k] === tmpl[k]);
      const overrides = {};
      if (cfg.dbMode === 'portable') overrides.DATABASE_URL = cfg.databaseUrl;
      if (cfg.dbMode === 'portable') overrides.POSTGRES_PASSWORD = cfg.pgPassword;
      if (unset('AUTH_SECRET')) {
        overrides.AUTH_SECRET = randomToken(32);
        job.line('out', 'AUTH_SECRET 是仓库占位值，已重新生成随机密钥（现有登录会全部失效）。');
      }
      if (unset('CRON_SECRET')) overrides.CRON_SECRET = randomToken(32);
      overrides.AUTH_TRUST_HOST = 'true';
      writeEnv(P, overrides);
      job.line('out', `已按面板配置重写 ${P.envFile} 的：${Object.keys(overrides).join('、')}`);
    } else if (id === 'pg-install') {
      await deps.pg.installPortable(P, job);
    } else if (id === 'pg-stale-pid') {
      const pidFile = path.join(P.pgData, 'postmaster.pid');
      const pid = Number((fs.readFileSync(pidFile, 'utf8').split('\n')[0] || '').trim());
      if (pid && deps.sysinfo.pidAlive(pid)) {
        job.line('err', `PID ${pid} 还活着，这不是陈旧文件，改用「重启数据库」。`);
      } else {
        fs.rmSync(pidFile, { force: true });
        job.line('out', `已删除陈旧的 ${pidFile}。`);
      }
    } else if (id === 'pg-restart') {
      try {
        await deps.pg.startPortable(P, cfg, job);
      } catch (e) {
        job.line('err', `正常启动失败（${e.message}），按 postmaster.pid 强杀后重试…`);
        const pidFile = path.join(P.pgData, 'postmaster.pid');
        try {
          const pid = Number((fs.readFileSync(pidFile, 'utf8').split('\n')[0] || '').trim());
          if (pid) await deps.proc.killTree(pid);
        } catch {}
        fs.rmSync(pidFile, { force: true });
        await deps.pg.startPortable(P, cfg, job);
      }
    } else if (id === 'pg-createdb') {
      await deps.pg.ensureDatabase(P, cfg, job);
    } else if (id === 'pg-push-schema') {
      const pw = candidates[0] || cfg.pgPassword;
      const n = Number(await scalar(P, cfg, pw, "select count(*) from information_schema.tables where table_schema='public'", job, { db: 'agilecampus' }));
      await deps.dep.pushSchema(P, cfg, job, { firstRun: !Number.isFinite(n) || n === 0 });
    } else if (id === 'pg-reset-password') {
      await resetPassword(P, cfg, job, candidates);
    } else if (id === 'app-restart') {
      await deps.proc.restartApp(P, cfg, (m) => job.line('out', m));
    } else if (id === 'pg-reinit') {
      await reinitCluster(P, cfg, job, deps);
      job.line('out', '数据簇已重建，接下来需要推送表结构。');
    }

    job.line('out', `✓ ${FIXES[id].title}`);
    done.push(id);
  }

  // 修完再诊一次，让界面直接看到结果
  const after = await diagnose(P, cfg, deps, job);
  const bad = after.checks.filter((c) => c.level === FAIL);
  job.line('out', bad.length ? `修复完成，仍有 ${bad.length} 项未通过。` : '修复完成，全部通过。');
  return { done, checks: after.checks, remaining: bad.map((c) => c.id) };
}

// ------------------------------------------------------------------ 重置数据库

/**
 * 重置确认短语。
 *
 * 界面上那个二次确认是**给人看的**，不是安全边界：它拦的是手滑点错，
 * 拦不住绕过界面直接朝面板接口发 POST 的人。所以后端必须自己再验一遍，
 * 而且验的是「用户把这四个字原样打出来了」——这一步没有任何前端控件能代劳，
 * 也就没法被一个 `confirmed: true` 之类的布尔位冒充。
 */
export const RESET_PHRASE = '重置数据库';

/** 绝不允许被重置成「库」的系统库名。 */
const RESERVED_DBS = new Set(['postgres', 'template0', 'template1']);

/** 标识符要加引号，引号本身翻倍。库名来自配置，但仍按不可信输入处理。 */
const quoteIdent = (s) => `"${String(s).replace(/"/g, '""')}"`;

/**
 * 重置预览：把「将要被删掉的东西」逐表数出来，供确认界面显示。
 *
 * 只读。连不上库时如实返回 reachable:false 而不是抛错——库连不上恰恰是
 * 用户会想重置的场景之一，界面得能照常把对话框画出来、把原因写清楚。
 */
export async function dbResetPreview(P, cfg, job) {
  const dsn = pg.parseDsn(cfg.databaseUrl || '') || {};
  const database = dsn.database || 'agilecampus';
  const out = {
    reachable: false,
    mode: cfg.dbMode,
    external: cfg.dbMode !== 'portable',
    host: dsn.host || '127.0.0.1',
    port: cfg.pgPort,
    user: dsn.user || 'agilecampus',
    database,
    tables: [],
    totalRows: 0,
    expected: expectedTableCount(P),
  };

  const password = await findWorkingPassword(P, cfg, job);
  if (!password) return out;
  out.reachable = true;

  // 一条 SQL 数完所有表：query_to_xml 把 count(*) 的结果当作「行」取出来。
  // 逐表 count 要几十次进程往返，慢且会横跨一个不一致的时间窗——
  // 而这里给出的数字是要写进确认界面的，前后自相矛盾会直接毁掉信任。
  //
  // 底下这条语句有两处很容易写错的地方，都是踩过之后改对的：
  //   · `xpath(...)[1]` 是**语法错误**。下标只能作用在带括号的表达式上，
  //     必须写成 `(xpath(...))[1]`。
  //   · 不能带 `order by 2`。结果集只有一列（表名和行数拼成了一个串），
  //     而 `order by 2` 指的是「结果集第 2 列」，直接报
  //     "ORDER BY position 2 is not in select list"。
  //     （最初验证时那版 SELECT 了两列，所以能过；拼成一列后就失效了。
  //     排序本身也没必要——界面拿到后会自己按行数排。）
  const text =
    "select relname || '|' || coalesce((xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, relname), false, true, '')))[1]::text, '0') " +
    'from pg_stat_user_tables';
  const r = await sql(P, cfg, password, text, job, { db: database });
  if (r.code !== 0) {
    out.note = `连上了数据库，但统计行数失败（退出码 ${r.code}）。多半是表结构还没建。`;
    return out;
  }
  for (const line of (r.output || '').trim().split('\n')) {
    const [name, rows] = line.split('|');
    if (!name) continue;
    out.tables.push({ name: name.trim(), rows: Number(rows) || 0 });
  }
  out.totalRows = out.tables.reduce((s, t) => s + t.rows, 0);
  return out;
}

/**
 * 重置数据库：只把「库」推倒重来，不动数据簇。
 *
 * 与检修里那个 `pg-reinit` 的区别，界面上必须说清，否则用户会在两个
 * 都写着「会丢数据」的按钮之间瞎猜：
 *
 *   reset  → DROP + CREATE 同名库 + 重推表结构。
 *            数据簇、端口、密码、以及同一实例上的**其它库**全部原样保留。
 *   reinit → 清空整个 pgdata 目录重新 initdb。
 *            密码变了，实例上所有库一起没。
 *
 * 绝大多数「我想清空重来」的诉求只需要前者，而前者的破坏面小得多。
 *
 * 调用方必须已经拿到用户的显式确认，并把原话传进 confirmText——
 * 这里再验一次（见 RESET_PHRASE 的注释）。
 */
export async function resetDatabase(P, cfg, job, deps, { confirmText = '' } = {}) {
  if (String(confirmText).trim() !== RESET_PHRASE) {
    const e = new Error(`确认短语不正确。需要原样输入「${RESET_PHRASE}」四个字。`);
    e.code = 'CONFIRM_REQUIRED';
    throw e;
  }

  const dsn = pg.parseDsn(cfg.databaseUrl || '') || {};
  const database = dsn.database || 'agilecampus';
  if (RESERVED_DBS.has(database)) throw new Error(`拒绝对系统库 ${database} 执行重置。`);
  if (!/^[A-Za-z0-9_$-]+$/.test(database)) {
    // 不静默转义后照做：库名带怪字符多半说明配置本身有问题，让用户先看一眼
    throw new Error(`库名 ${JSON.stringify(database)} 含意料之外的字符，为安全起见拒绝执行。请先核对 DATABASE_URL。`);
  }

  const password = await findWorkingPassword(P, cfg, job);
  if (!password) {
    throw new Error('现有凭据都连不上数据库，无法重置。请先跑一次「检修」把连接修通。');
  }

  // 先把将被删掉的内容记进日志。日志是这个操作唯一的事后凭证：
  // 事后有人问「我那些数据呢」，这行就是答案。
  const before = await dbResetPreview(P, cfg, job);
  job.line('out', `即将删除：${dbPreviewLine(before)}`);

  job.step(0, '停止应用');
  await deps.proc.stopApp(P, cfg, (m) => job.line('out', m));
  job.line('out', '应用已停，不再有连接池占着这个库。');

  job.step(1, '删除并重建库');
  job.line('out', `删除并重建数据库 ${database}…`);
  // 必须连到 postgres 维护库去执行 —— 不能删自己正连着的那个库。
  // WITH (FORCE)（PG 13+）会踢掉残留连接；老版本没有这个子句，退回到手动终止。
  let r = await sql(P, cfg, password, `DROP DATABASE IF EXISTS ${quoteIdent(database)} WITH (FORCE)`, job, { quiet: false });
  if (r.code !== 0 && /syntax error|not supported/i.test(r.output || '')) {
    job.line('out', '当前 PostgreSQL 不支持 WITH (FORCE)，改用先终止连接再删除…');
    const term = await sql(
      P,
      cfg,
      password,
      `select pg_terminate_backend(pid) from pg_stat_activity where datname = '${database}' and pid <> pg_backend_pid()`,
      job,
      { quiet: false }
    );
    // 终止会话失败不直接判死：可能压根没有其它连接（那这条本来就无事可做），
    // 真正的判据是下面那句 DROP 能不能成。
    if (term.code !== 0) job.line('err', '终止残留连接时出错，继续尝试删除（DROP 会给出最终结论）。');
    r = await sql(P, cfg, password, `DROP DATABASE IF EXISTS ${quoteIdent(database)}`, job, { quiet: false });
  }
  if (r.code !== 0) throw new Error('DROP DATABASE 失败，请查看上方数据库的原始输出。');

  const c = await sql(P, cfg, password, `CREATE DATABASE ${quoteIdent(database)}`, job, { quiet: false });
  if (c.code !== 0) throw new Error('CREATE DATABASE 失败，请查看上方数据库的原始输出。');
  job.line('out', `数据库 ${database} 已是全新的空库。`);

  job.step(2, '推送表结构');
  await deps.dep.pushSchema(P, cfg, job, { firstRun: true });

  job.step(3, '重启应用');
  // 应用此时已经停了，restartApp 会走「没在跑就直接拉起」的分支，
  // 并复用它的端口就绪等待（不需要在这里另写一遍）。
  await deps.proc.restartApp(P, cfg, (m) => job.line('out', m));

  const after = await dbResetPreview(P, cfg, job);
  const probe = await e2eProbe(cfg).catch(() => null);
  job.line('out', `重置后：${dbPreviewLine(after)}`);
  job.line('out', probe?.verdict === 'all-ok' ? '端到端探针通过：应用已能正常查库。' : `注意：端到端探针返回 ${probe?.verdict || '无响应'}，请点「检修」复查。`);

  return { database, dropped: before, created: after, probe };
}

/** 把预览结果压成一行人话，日志与界面共用。 */
export function dbPreviewLine(p) {
  if (!p) return '（无信息）';
  if (!p.reachable) return `连不上数据库（${p.host}:${p.port}）`;
  if (!p.tables.length) return '库里没有任何表';
  return `${p.tables.length} 张表 / 共 ${p.totalRows} 行 —— ${p.tables.map((t) => `${t.name} ${t.rows}`).join('、')}`;
}
