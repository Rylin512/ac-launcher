// PostgreSQL 的探测、便携版下载、初始化与启停。
//
// 「任何机器」的代价全在这个文件里：目标机器可能已经有一套 PG（就用它），
// 也可能什么都没有（下载 EDB 免安装 zip，以普通用户进程跑，全程不需要管理员）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pidAlive, tcpReachable, waitForPort } from './sysinfo.mjs';
import { spawnInto } from './jobs.mjs';
import { writeJson, humanBytes } from './config.mjs';
import { withPath } from './nodebin.mjs';

const isWin = process.platform === 'win32';
const UA = 'Mozilla/5.0 (compatible; AgileCampus-deploy-panel)';

/** 目标版本：优先 16.x（与 docker-compose.yml 的 postgres:16 对齐），退而求其次 17.x。 */
const PREFERRED_MAJORS = [16, 17];
const MAX_MINOR = 13;
export const MAX_PROBE = 24;

/**
 * 生成候选 zip 名。
 * build 后缀不可预测（16.5 只有 -1，16.4 有 -1 和 -2），所以两个都要试。
 * 顺序即优先级：版本越新越靠前。
 */
export function buildCandidates() {
  const out = [];
  for (const major of PREFERRED_MAJORS) {
    for (let minor = MAX_MINOR; minor >= 1; minor--) {
      for (const build of [1, 2]) out.push(`${major}.${minor}-${build}`);
    }
  }
  return out;
}

export function zipUrl(versionBuild) {
  return `https://get.enterprisedb.com/postgresql/postgresql-${versionBuild}-windows-x64-binaries.zip`;
}

/**
 * 探测某个 zip 是否真的存在，并返回它的字节数。
 *
 * 注意：该 CDN 对 HEAD 请求一律返回 200，所以只能靠 ranged GET 读取
 * Content-Range 里的总长度来判断；不存在的版本会返回 403。
 */
export async function probeZip(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Range: 'bytes=0-0' }, signal: ctl.signal });
    if (res.status >= 400) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const cr = res.headers.get('content-range');
    const total = cr ? Number(String(cr).split('/')[1]) : Number(res.headers.get('content-length'));
    await res.body?.cancel().catch(() => {});
    return Number.isFinite(total) && total > 0 ? total : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 依次探测候选，返回第一个可用者。找不到返回 null。 */
export async function findAvailableZip(job) {
  const candidates = buildCandidates().slice(0, MAX_PROBE);
  for (const v of candidates) {
    const size = await probeZip(zipUrl(v));
    if (size && size > 250 * 1024 * 1024) {
      job.line('out', `探测到可用版本：PostgreSQL ${v}（${humanBytes(size)}）`);
      return { versionBuild: v, url: zipUrl(v), size };
    }
  }
  return null;
}

/** 下载并显示进度。用内置 fetch 流式落盘，不依赖 curl。 */
export async function downloadZip(job, url, dest, sizeHint) {
  job.line('out', `开始下载 ${url}`);
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || sizeHint || 0;
  const out = fs.createWriteStream(dest);
  let got = 0;
  let lastReport = 0;
  try {
    for await (const chunk of res.body) {
      got += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      if (total && got - lastReport > 8 * 1024 * 1024) {
        lastReport = got;
        const pct = ((got / total) * 100).toFixed(1);
        job.stepDetail(job.currentStep, `下载中 ${pct}%（${humanBytes(got)} / ${humanBytes(total)}）`);
      }
    }
  } finally {
    await new Promise((r) => out.end(r));
  }
  if (total && got < total * 0.98) throw new Error(`下载不完整：只收到 ${humanBytes(got)}，期望 ${humanBytes(total)}`);
  job.line('out', `下载完成：${humanBytes(got)}`);
  return { bytes: got, total };
}

/**
 * 解压 zip。Windows / macOS 用自带的 bsdtar，Linux 用 unzip。
 *
 * Windows 上必须用**绝对路径**指向 System32 里的 bsdtar：
 * 装了 Git for Windows / msys2 / Cygwin 的机器上，PATH 里的 GNU tar 会排在
 * 系统 bsdtar 前面，而 GNU tar 把 "C:\..." 当成 rsh 风格的「主机:路径」远程
 * 地址，直接以 "Cannot connect to C: resolve failed" 失败。实测踩过这个坑。
 */
export async function extractZip(job, zipPath, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const attempts = [];
  if (isWin) {
    const sysTar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
    if (fs.existsSync(sysTar)) attempts.push([sysTar, ['-xf', zipPath, '-C', destDir]]);
    attempts.push(['tar', ['-xf', zipPath, '-C', destDir]]);
    // System32 里万一没有 bsdtar，--force-local 能让 GNU tar 把 C:\ 当本地路径
    attempts.push(['tar', ['--force-local', '-xf', zipPath, '-C', destDir]]);
    attempts.push(['powershell', ['-NoProfile', '-Command', `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${destDir}' -Force`]]);
  } else if (process.platform === 'darwin') {
    attempts.push(['tar', ['-xf', zipPath, '-C', destDir]]);
  } else {
    attempts.push(['unzip', ['-o', '-q', zipPath, '-d', destDir]]);
    attempts.push(['tar', ['-xf', zipPath, '-C', destDir]]);
  }
  // 311 MB 的包解压要一两分钟，期间必须把步骤详情改掉，
  // 否则界面会一直停在「下载中 97.8%」这种已经过时的描述上。
  job.stepDetail(job.currentStep, '解压中（约需 1-2 分钟）…');
  for (const [cmd, args] of attempts) {
    const r = await spawnInto(job, cmd, args, { timeoutMs: 20 * 60 * 1000 });
    if (r.code === 0) return true;
  }
  return false;
}

/** 运行目录里是否已有可用的便携 Postgres。 */
export function portableInstalled(P) {
  return fs.existsSync(P.pgCtl);
}

/** 用户在 tmp 目录手工投放的 zip（离线兜底通道）。 */
export function findManualZip(P) {
  try {
    const hit = fs
      .readdirSync(P.tmpDir)
      .filter((f) => /^postgresql-\d.*windows-x64-binaries\.zip$/i.test(f))
      .map((f) => path.join(P.tmpDir, f))
      .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
    if (hit && fs.statSync(hit).size > 250 * 1024 * 1024) return hit;
  } catch {}
  return null;
}

/**
 * 安装便携 Postgres（幂等）。
 * 顺序：已装好 → 用户手工投放的 zip → 联网探测下载。
 * 全部失败时抛出带指引的错误，界面会把 URL 模板和投放路径显示出来。
 */
export async function installPortable(P, job) {
  if (portableInstalled(P)) {
    job.line('out', '便携 PostgreSQL 已存在，跳过安装。');
    return { already: true };
  }
  let zipPath = findManualZip(P);
  if (zipPath) {
    job.line('out', `发现手工投放的压缩包：${zipPath}`);
  } else {
    const found = await findAvailableZip(job);
    if (!found) {
      const e = new Error(
        '无法确定可下载的 PostgreSQL 版本（可能是网络不通或 CDN 变更）。\n' +
          '兜底做法：手动下载 https://get.enterprisedb.com/postgresql/postgresql-16.13-1-windows-x64-binaries.zip\n' +
          `放到 ${P.tmpDir} 目录后，回到面板点击「重试」。`
      );
      e.code = 'PG_DOWNLOAD_UNAVAILABLE';
      throw e;
    }
    zipPath = path.join(P.tmpDir, `postgresql-${found.versionBuild}-windows-x64-binaries.zip`);
    if (fs.existsSync(zipPath) && fs.statSync(zipPath).size > 250 * 1024 * 1024) {
      job.line('out', '压缩包已存在且完整，跳过下载。');
    } else {
      await downloadZip(job, found.url, zipPath, found.size);
    }
  }
  job.line('out', '正在解压…');
  const ok = await extractZip(job, zipPath, P.runtime);
  if (!ok) throw new Error('解压失败。可手工把压缩包解开，使 pgsql\\bin\\pg_ctl.exe 就位于运行目录下。');
  if (!portableInstalled(P)) {
    throw new Error(`解压后找不到 ${P.pgCtl}，压缩包结构可能与预期不符。`);
  }
  job.line('out', '便携 PostgreSQL 安装完成。');
  return { installed: true };
}

// ------------------------------------------------------------------ 数据簇

/**
 * PostgreSQL 工具链的环境。PATH 一律走 withPath —— `{ ...process.env, PATH: ... }`
 * 这种写法在 Windows 上（键名是 `Path`）会把整条继承来的 PATH 丢掉，
 * 子进程连 cmd.exe 之外的东西都找不到。经过见 nodebin.withPath。
 */
function pgEnv(P, extra = {}) {
  return withPath({ ...process.env, ...extra }, P, P.pgBin);
}

function readPidFile(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').split('\n')[0].trim());
  } catch {
    return null;
  }
}

/** pgdata 目录里是否已经有东西（用于区分「空目录」与「有异物」）。 */
function pgDataNonEmpty(P) {
  try {
    return fs.readdirSync(P.pgData).length > 0;
  } catch {
    return false;
  }
}

/**
 * 初始化数据簇（幂等）。
 *
 * --locale=C 是必须的：中文 Windows 的默认 locale 是 Chinese (Simplified)_China.936，
 * 与 -E UTF8 不匹配会让 initdb 直接失败。代价是文本排序按字节序而非拼音，功能无损。
 *
 * --pwfile 而非交互输入：initdb 会读两次 stdin，非 TTY 下会挂死。
 *
 * 另外，Postgres 拒绝以管理员身份运行。本方案全程不需要管理员，正常情况下不会撞上。
 */
export async function initCluster(P, cfg, job, { allowWipe = false } = {}) {
  if (fs.existsSync(P.pgVersionFile)) {
    job.line('out', '数据簇已存在，跳过初始化。');
    return { skipped: true };
  }
  if (pgDataNonEmpty(P)) {
    if (!allowWipe) {
      const e = new Error(`${P.pgData} 不是空目录，也没有 PG_VERSION，无法确认它是不是一个完整的数据簇。`);
      e.code = 'PGDATA_DIRTY';
      throw e;
    }
    job.line('err', `清空 ${P.pgData} …`);
    for (const f of fs.readdirSync(P.pgData)) {
      fs.rmSync(path.join(P.pgData, f), { recursive: true, force: true });
    }
  }
  fs.mkdirSync(P.pgData, { recursive: true });
  const pwFile = path.join(P.tmpDir, 'pg-init-pw.txt');
  fs.writeFileSync(pwFile, cfg.pgPassword, 'utf8');
  try {
    const r = await spawnInto(
      job,
      P.initdb,
      ['-D', P.pgData, '-U', 'agilecampus', '-E', 'UTF8', '--locale=C', '-A', 'scram-sha-256', `--pwfile=${pwFile}`],
      { env: pgEnv(P), timeoutMs: 300000 }
    );
    if (r.code !== 0) throw new Error('initdb 失败，请查看上方原始输出。');
  } finally {
    fs.rmSync(pwFile, { force: true });
  }
  return { initialized: true };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 问服务端「你现在接受连接吗」。
 *
 * `pg_ctl -w` 只保证 postmaster 起来了，**不保证崩溃恢复已经跑完**。上一次
 * 异常终止（被强杀 / 断电 / 任务管理器结束进程）会留下需要恢复的数据簇，
 * 此时 postmaster 已经在监听端口，但任何连接都被拒：
 *     FATAL:  the database system is starting up
 * 端口探测对这种状态完全无感——它会报「端口已就绪」，然后 createdb 撞墙。
 * pg_isready 恰好把这两种状态分开（退出码 0 = 正常接受连接，1 = 拒绝），
 * 所以「就绪」的判据必须是它，而不是端口。
 */
async function dbAccepting(P, cfg, job) {
  // quiet：这是每几百毫秒一次的探针，原始输出不该刷进界面，
  // 由调用方翻译成一句人话即可。
  if (fs.existsSync(P.pgIsReady)) {
    const r = await spawnInto(job, P.pgIsReady, ['-h', '127.0.0.1', '-p', String(cfg.pgPort), '-t', '5'], {
      env: pgEnv(P), timeoutMs: 10000, quiet: true,
    });
    return r.code === 0;
  }
  // 理论上用不到的兜底：某些精简发行版不带 pg_isready，改用 psql 发一条真查询。
  const r = await spawnInto(job, P.psql, [
    '-h', '127.0.0.1', '-p', String(cfg.pgPort), '-U', 'agilecampus', '-d', 'postgres', '-tAc', 'select 1',
  ], { env: pgEnv(P, { PGPASSWORD: cfg.pgPassword }), timeoutMs: 10000, quiet: true });
  return r.code === 0;
}

/** 等数据库真正可用（含崩溃恢复）。返回 false 表示等超时了。 */
export async function waitDbReady(P, cfg, job, { timeoutMs = 120000, interval = 800 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  for (;;) {
    if (await dbAccepting(P, cfg, job)) {
      if (announced) job.log('out', '数据库已完成恢复，开始接受连接。');
      return true;
    }
    if (Date.now() >= deadline) return false;
    if (!announced) {
      announced = true;
      job.stepDetail(job.currentStep, '等待数据库完成启动（正在崩溃恢复）…');
      job.line('out', '数据库尚未接受连接（多半还在崩溃恢复），继续等待…');
    }
    await sleep(interval);
  }
}

/** 建库（幂等）。库已存在视为成功。 */
export async function ensureDatabase(P, cfg, job, { timeoutMs = 120000 } = {}) {
  const args = ['-h', '127.0.0.1', '-p', String(cfg.pgPort), '-U', 'agilecampus', 'agilecampus'];
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 1; ; attempt += 1) {
    const r = await spawnInto(job, P.createdb, args, { env: pgEnv(P, { PGPASSWORD: cfg.pgPassword }), timeoutMs: 60000 });
    if (r.code === 0) return attempt === 1 ? { created: true } : { created: true, attempts: attempt };
    const recent = job.lines.slice(-40).map((l) => l.text).join('\n');
    if (/already exists/i.test(recent)) {
      job.line('out', '数据库 agilecampus 已存在，跳过创建。');
      return { skipped: true };
    }
    // 判断「是不是还没启动完」不能靠匹配错误文案：libpq 的消息是**本地化**的
    // （中文 Windows 上打的是「连接到"127.0.0.1"上的服务器,端口55432失败」），
    // 只有服务端已经能应答时才会出现英文的 FATAL 那句。所以改成反过来问
    // pg_isready：还没接受连接就继续等，已经在接受了还失败，那才是真错误
    // （密码不对、权限不足之类），立刻抛出，不白等两分钟。
    if (Date.now() >= deadline || !(await dbAccepting(P, cfg, job))) {
      throw new Error('创建数据库失败，请查看上方原始输出。');
    }
    job.stepDetail(job.currentStep, `数据库还在启动中，第 ${attempt + 1} 次重试…`);
    await sleep(1200);
  }
}

/**
 * 启动便携 Postgres。
 * 端口通过 pg_ctl -o 传入而不改 postgresql.conf —— 保持「端口」的唯一真相在面板配置里，
 * 也让数据簇与端口解耦，将来换端口不用重建簇。
 * listen_addresses 明确限定回环，是安全默认。
 */
export async function startPortable(P, cfg, job) {
  const portRes = await tcpReachable('127.0.0.1', cfg.pgPort, 800);
  if (portRes.ok) {
    job.line('out', `端口 ${cfg.pgPort} 上已有 PostgreSQL 在运行，跳过启动。`);
    // 跳过启动不等于跳过等待：上一轮面板可能正是在恢复途中退出的，
    // 这里同样要确认它真的在接受连接，否则调用方照样会撞「starting up」。
    if (!(await waitDbReady(P, cfg, job, { timeoutMs: 180000 }))) {
      throw new Error(`端口 ${cfg.pgPort} 上的 PostgreSQL 在 180s 内仍未接受连接（可能卡在崩溃恢复）。`);
    }
    return { already: true };
  }

  // 残留的 postmaster.pid 会让 pg_ctl 报 lock file exists
  if (fs.existsSync(P.postmasterPid)) {
    const stalePid = readPidFile(P.postmasterPid);
    if (stalePid && pidAlive(stalePid)) {
      job.line('out', `发现正在运行的 postmaster（PID ${stalePid}），直接复用。`);
      if (!(await waitDbReady(P, cfg, job, { timeoutMs: 180000 }))) {
        throw new Error(`复用的 postmaster（PID ${stalePid}）在 180s 内仍未接受连接（可能卡在崩溃恢复）。`);
      }
      return { already: true };
    }
    job.line('err', '发现残留的 postmaster.pid（进程已不存在），清理后继续。');
    fs.rmSync(P.postmasterPid, { force: true });
  }

  const args = [
    '-D', P.pgData,
    '-l', P.pgLog,
    '-w', '-t', '60',
    '-o', `-p ${cfg.pgPort} -c listen_addresses=127.0.0.1`,
    'start',
  ];
  job.line('out', `pg_ctl ${args.join(' ')}`);
  const child = spawn(P.pgCtl, args, { cwd: P.pgBin, env: pgEnv(P), detached: true, windowsHide: true, stdio: 'ignore' });
  child.unref();

  const up = await waitForPort(cfg.pgPort, true, { timeout: 60000, interval: 400 });
  if (!up) {
    const tail = job.lines.slice(-10).map((l) => l.text).join('\n');
    throw new Error(`PostgreSQL 在 60s 内没有起来。最近输出：\n${tail || '（无）'}`);
  }
  // 端口通 ≠ 能连。上次异常终止会留下要做崩溃恢复的簇，此时端口已在监听、
  // 连接全被拒（FATAL: the database system is starting up）。必须等 pg_isready
  // 说「接受连接」才算真的就绪，否则后续 createdb / drizzle-kit 会直接撞墙。
  if (!(await waitDbReady(P, cfg, job, { timeoutMs: 180000 }))) {
    const tail = job.lines.slice(-10).map((l) => l.text).join('\n');
    throw new Error(`PostgreSQL 端口已监听，但 180s 内仍未接受连接（可能卡在崩溃恢复）。\n最近输出：\n${tail || '（无）'}`);
  }
  const pid = readPidFile(P.postmasterPid);
  job.line('out', `PostgreSQL 已就绪，PID ${pid || '未知'}，端口 ${cfg.pgPort}。`);
  writeJson(P.pgStateFile, { pid, port: cfg.pgPort, dataDir: P.pgData, mode: 'portable', startedAt: Date.now() });
  return { started: true, pid };
}

/** 停止便携 Postgres。必须走 pg_ctl，它自己会读 postmaster.pid 并等 checkpoint 完成。 */
export async function stopPortable(P, cfg, job) {
  const res = await tcpReachable('127.0.0.1', cfg.pgPort, 800);
  if (!res.ok) {
    job.line('out', 'PostgreSQL 已经不在监听，无需停止。');
    writeJson(P.pgStateFile, null);
    return { alreadyStopped: true };
  }
  const args = ['-D', P.pgData, '-w', '-t', '60', '-m', 'fast', 'stop'];
  const r = await spawnInto(job, P.pgCtl, args, { env: pgEnv(P), timeoutMs: 90000 });
  const down = await waitForPort(cfg.pgPort, false, { timeout: 10000, interval: 400 });
  if (r.code !== 0 || !down) {
    const pid = readPidFile(P.postmasterPid);
    if (pid && pidAlive(pid)) {
      job.line('err', `pg_ctl 停止失败，退化为强制终止 PID ${pid}。`);
      await new Promise((resolve) => {
        const k = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        k.once('close', resolve);
      });
      fs.rmSync(P.postmasterPid, { force: true });
    }
  }
  writeJson(P.pgStateFile, null);
  return { stopped: true };
}

// ---------------------------------------------------------------- 探测外部库

/** 从 DSN 里拆出连接参数。不引第三方库，手写一个够用的解析。 */
export function parseDsn(url) {
  try {
    const u = new URL(url);
    return {
      host: u.hostname,
      port: Number(u.port || 5432),
      user: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
      database: u.pathname.replace(/^\//, '') || '',
    };
  } catch {
    return null;
  }
}

/**
 * 探测机器上已有的 PostgreSQL。
 * 只做只读探测，绝不擅自安装第二套——用户机器上已经有库时，多装一套是负担。
 */
export async function detectExisting(cfg) {
  const found = [];
  if (cfg.databaseUrl) {
    const dsn = parseDsn(cfg.databaseUrl);
    if (dsn) {
      const t = await tcpReachable(dsn.host, dsn.port, 1200);
      found.push({ source: 'panel-config', url: cfg.databaseUrl, ...dsn, reachable: t.ok, ms: t.ms });
    }
  }
  if (!found.length) {
    const t = await tcpReachable('127.0.0.1', 5432, 1200);
    if (t.ok) found.push({ source: 'localhost:5432', host: '127.0.0.1', port: 5432, reachable: true, ms: t.ms });
  }
  return found;
}

/** 数据目录体积（用于界面展示）。带文件数上限，避免超大库把面板拖住。 */
export function dirSize(dir, maxFiles = 20000) {
  let total = 0;
  let count = 0;
  (function walk(d) {
    if (count > maxFiles) return;
    let entries;
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (count > maxFiles) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) {
        count += 1;
        try {
          total += fs.statSync(p).size;
        } catch {}
      }
    }
  })(dir);
  return { bytes: total, files: count, truncated: count > maxFiles };
}

/** 数据库整体状态快照。 */
export async function pgStatus(P, cfg) {
  const mode = cfg.dbMode;
  const dsn = mode === 'external' ? parseDsn(cfg.databaseUrl) : null;
  const host = dsn?.host || '127.0.0.1';
  const port = mode === 'external' ? dsn.port : cfg.pgPort;
  const t = await tcpReachable(host, port, 1000);

  let version = null;
  try {
    if (mode !== 'external') version = fs.readFileSync(P.pgVersionFile, 'utf8').trim();
  } catch {}

  const pidFile = mode !== 'external' ? readPidFile(P.postmasterPid) : null;
  const state = !mode ? 'unconfigured' : t.ok ? 'running' : 'stopped';

  return {
    mode: mode || 'unconfigured',
    state,
    host,
    port,
    database: dsn?.database || 'agilecampus',
    user: dsn?.user || 'agilecampus',
    version,
    pid: pidFile && pidAlive(pidFile) ? pidFile : null,
    dataDir: mode !== 'external' ? P.pgData : null,
    tcpReachable: t.ok,
    tcpMs: t.ms,
    portableInstalled: portableInstalled(P),
    postmasterPidStale: mode !== 'external' && pidFile && !pidAlive(pidFile),
    dsnLabel: mode === 'external' ? `${host}:${port}/${dsn?.database || ''}` : `127.0.0.1:${port}/agilecampus`,
  };
}
