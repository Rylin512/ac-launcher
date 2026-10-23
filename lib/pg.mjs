// PostgreSQL 的探测、便携版下载、初始化与启停。
//
// 「任何机器」的代价全在这个文件里：目标机器可能已经有一套 PG（就用它），
// 也可能什么都没有（下载 EDB 免安装 zip，以普通用户进程跑，全程不需要管理员）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isElevated, pidAlive, tcpReachable, waitForPort } from './sysinfo.mjs';
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

/**
 * 运行目录里是否已有可用的便携 Postgres。
 * 必须同时有 pg_ctl 与 initdb：只看 pg_ctl 的话，解压不完整（少了 initdb）
 * 会被当成「已安装」，后续每次部署都跳过安装、然后死在初始化那一步。
 */
export function portableInstalled(P) {
  return fs.existsSync(P.pgCtl) && fs.existsSync(P.initdb) && fs.existsSync(postgresExe(P));
}

function postgresExe(P) {
  return path.join(P.pgBin, isWin ? 'postgres.exe' : 'postgres');
}

// ------------------------------------------------ 兼容性与「可执行文件起不来」

/** 微软官方的 VC++ 2015-2022 运行库安装包。EDB 的免安装 zip 不带这套 DLL。 */
export const VC_RUNTIME_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';

/**
 * Windows 的退出码在 Node 里可能是负数，也可能是一串很大的正数。
 * 统一转成无符号 32 位，才能和 0xC0000135 这类常量比对。
 */
function unsignedExit(code) {
  return Number.isFinite(code) ? code >>> 0 : 0;
}

const WIN_LOADER_FAILURES = new Map([
  [0xc0000135, '系统找不到运行所需的 DLL（STATUS_DLL_NOT_FOUND）'],
  [0xc000007b, 'DLL 位数或版本不对（STATUS_INVALID_IMAGE_FORMAT）'],
  [0xc0000142, 'DLL 初始化失败（STATUS_DLL_INIT_FAILED）'],
]);

/**
 * 把「exe 根本起不来」翻译成人能照着做的下一步。
 *
 * 目标电脑上最常见的一种：EDB 的 windows-x64-binaries.zip 只打包 PostgreSQL
 * 本体，不带 vcruntime140.dll / msvcp140.dll。系统里没装 VC++ 运行库时，
 * initdb.exe 连第一行代码都执行不到，Windows 直接返回 0xC0000135。
 * 这种失败和「参数写错」「数据目录有问题」是两回事，必须先说清楚。
 */
export function describeBinaryFailure(name, r) {
  if (r.error) {
    return `${name} 无法启动：${r.error.message}\n` +
      '多半是文件被杀毒软件隔离，或解压不完整。请把运行目录加入杀毒软件白名单后重新部署。';
  }
  const code = unsignedExit(r.code);
  const hex = `0x${code.toString(16).toUpperCase()}`;
  // spawnInto 在超时强杀 / 拿不到退出码时也报 -1，但那种情况没有 r.error。
  if (r.code === -1) {
    return `${name} 没有正常结束（超时或被终止）。请查看任务日志；若反复出现，检查杀毒软件是否在扫描它。`;
  }
  if (WIN_LOADER_FAILURES.has(code)) {
    return (
      `${name} 无法启动（${WIN_LOADER_FAILURES.get(code)}）。\n` +
      'PostgreSQL 免安装包不自带 Microsoft Visual C++ 运行库；目标电脑缺这套 DLL 时，所有 PG 工具都会以这个错误退出。\n' +
      `请先安装「Microsoft Visual C++ 2015-2022 Redistributable (x64)」（需要管理员权限，装完不用重启）：${VC_RUNTIME_URL}\n` +
      '装好后回到面板重新部署即可。\n' +
      '如果已经装过运行库仍报这个错，多半是 pgsql\\bin 里的文件被杀毒软件隔离：把运行目录加入白名单，' +
      '删除运行目录下的 pgsql 文件夹后重新部署（pgdata 与里面的数据不受影响）。'
    );
  }
  const tail = (r.output || '').trim().split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
  return (
    `${name} 无法正常运行（退出码 ${hex}）。` +
    (tail ? `\n最近输出：\n${tail}` : '\n没有任何输出：多半被杀毒软件拦截，或压缩包解压不完整。')
  );
}

/** 在真正拿它干活之前先跑一次 `--version`，确认二进制本身能加载。 */
export async function requireRunnable(P, job, label, exe) {
  if (!exe || !fs.existsSync(exe)) {
    throw new Error(
      `找不到 ${label}（${exe || '路径未定义'}）。便携 PostgreSQL 安装不完整，请重新部署，或使用已有的 PostgreSQL 实例。`
    );
  }
  const r = await spawnInto(job, exe, ['--version'], { env: pgEnv(P), timeoutMs: 20000, quiet: true });
  if (r.code !== 0) {
    const e = new Error(describeBinaryFailure(label, r));
    e.code = 'PG_BINARY_BROKEN';
    throw e;
  }
  return { version: (r.output || '').trim() };
}

/**
 * 探测便携 PG 的关键工具是否真的能执行。
 * 安装完成后立刻做一次，避免等到 initdb 才报一句看不懂的退出码。
 */
export async function probePgTools(P, job = { currentStep: 0, stepDetail() {}, line() {}, log() {}, flush() {}, lines: [] }) {
  const checks = [];
  for (const [label, exe] of [
    ['initdb', P.initdb],
    ['pg_ctl', P.pgCtl],
    ['postgres', postgresExe(P)],
  ]) {
    if (!fs.existsSync(exe)) {
      checks.push({ label, exe, ok: false, missing: true, detail: '文件不存在' });
      continue;
    }
    const r = await spawnInto(job, exe, ['--version'], { env: pgEnv(P), timeoutMs: 20000, quiet: true });
    checks.push({
      label,
      exe,
      ok: r.code === 0,
      code: r.code,
      detail: r.code === 0 ? (r.output || '').trim() : describeBinaryFailure(label, r),
    });
  }
  return { ok: checks.every((c) => c.ok), checks };
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
    await assertPgToolsRunnable(P, job);
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
  if (!ok) {
    throw new Error(
      '解压失败。可手工把压缩包解开，使 pgsql\\bin\\pg_ctl.exe 就位于运行目录下。\n' +
        '如果是「文件被占用」，请先在面板上停止数据库再重试。'
    );
  }
  if (!portableInstalled(P)) {
    throw new Error(`解压后找不到 ${P.pgCtl}，压缩包结构可能与预期不符。`);
  }
  job.line('out', '便携 PostgreSQL 安装完成。');
  await assertPgToolsRunnable(P, job);
  return { installed: true };
}

/**
 * 解压成功 ≠ 能执行。Windows 上缺 VC++ 运行库时，文件一个不少，但每个 exe
 * 一启动就以 0xC0000135 退出。这一步把那种情况在安装阶段就挑出来。
 */
async function assertPgToolsRunnable(P, job) {
  const probe = await probePgTools(P, job);
  if (!probe.ok) {
    const bad = probe.checks.find((c) => !c.ok) || probe.checks[0];
    const e = new Error(`PostgreSQL 文件已就位，但 ${bad.label} 无法运行：\n${bad.detail}`);
    e.code = 'PG_BINARY_BROKEN';
    throw e;
  }
  job.line('out', `工具链可执行：${probe.checks.map((c) => c.detail.split('\n')[0]).join('；')}`);
  return probe;
}

// ------------------------------------------------------------------ 数据簇

/**
 * PostgreSQL 工具链的环境。PATH 一律走 withPath —— `{ ...process.env, PATH: ... }`
 * 这种写法在 Windows 上（键名是 `Path`）会把整条继承来的 PATH 丢掉，
 * 子进程连 cmd.exe 之外的东西都找不到。经过见 nodebin.withPath。
 */
function pgEnv(P, extra = {}) {
  // LC_ALL/LANG=C 有两个好处：
  // 1) 中文 Windows 上 PG 的消息目录会输出本地化文本（GBK），Node 按 UTF-8
  //    解码就成乱码；固定成 C 之后日志是稳定的英文/ASCII，关键字匹配也不受系统语言影响。
  // 2) initdb 的排序/字符集判断不再受系统区域设置影响。
  // TMP/TEMP 指到运行目录：有些机器系统临时目录被组策略锁死或没有写权限，
  // initdb / 解压会在那里失败；运行目录一定是当前用户可写的。
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', ...extra };
  if (P.tmpDir) {
    env.TMP = P.tmpDir;
    env.TEMP = P.tmpDir;
  }
  return withPath(env, P, P.pgBin);
}

function readPidFile(file) {
  try {
    return Number(fs.readFileSync(file, 'utf8').split('\n')[0].trim());
  } catch {
    return null;
  }
}

function readLogTail(file, lines = 20) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/**
 * 启动失败时把 postgres 自己的日志也带上。
 * pg_ctl 是用 detached + stdio:ignore 跑的，它和 postmaster 的输出不经过任务日志，
 * 只写进 -l 指定的文件；不带出来用户就只能看到「没有起来」。
 */
function startFailureHint(P, job) {
  const logTail = readLogTail(P.pgLog, 20);
  const jobTail = job.lines.slice(-10).map((l) => l.text).join('\n').trim();
  const parts = [];
  if (logTail) parts.push(`postgres 日志（${P.pgLog}）：\n${logTail}`);
  if (jobTail) parts.push(`面板输出：\n${jobTail}`);
  return `\n${parts.join('\n') || '（没有任何输出。多半是 pg_ctl 被杀毒软件拦截，或数据目录被其他进程占用。）'}`;
}

/** pgdata 目录里是否已经有东西（用于区分「空目录」与「有异物」）。 */
function pgDataNonEmpty(P) {
  try {
    return fs.readdirSync(P.pgData).length > 0;
  } catch {
    return false;
  }
}

/** pgdata 看起来是「上次 initdb 没做完」留下的残骸：有文件，但没有 PG_VERSION。 */
export function pgDataPartial(P) {
  return !fs.existsSync(P.pgVersionFile) && pgDataNonEmpty(P);
}

/**
 * 把未完成的数据目录整体改名挪到旁边，再建一个空的 pgdata。
 *
 * 为什么不直接删：那目录里可能是用户上一次部署没做完的现场，虽然按定义
 * 不是可用数据簇（没有 PG_VERSION），但保留一份比删掉更可逆。只保留最近两份，
 * 避免反复失败把磁盘塞满。
 */
export function movePartialClusterAside(P, job) {
  if (!pgDataNonEmpty(P)) return { moved: false, reason: 'empty' };
  if (fs.existsSync(P.pgVersionFile)) return { moved: false, reason: 'complete' };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = `${P.pgData}.broken-${stamp}`;
  try {
    fs.renameSync(P.pgData, dest);
  } catch (e) {
    const err = new Error(
      `数据目录 ${P.pgData} 里没有 PG_VERSION（不是可用的数据簇），但也没法把它挪走：${e.message}\n` +
        '通常是还有进程占用它（杀毒软件、旧的 postgres.exe），或当前用户没有改名权限。\n' +
        '请先关闭占用它的程序，或手动把这个目录改名后重试。'
    );
    err.code = 'PGDATA_DIRTY';
    throw err;
  }
  fs.mkdirSync(P.pgData, { recursive: true });
  job.line('warn', `数据目录里没有 PG_VERSION，不是可用的数据簇；已原样移到 ${dest}（保留，不删除）。`);
  pruneBrokenClusters(P);
  return { moved: true, dest };
}

/** 只保留最近两份 .broken-*，更早的清掉。 */
function pruneBrokenClusters(P) {
  try {
    const base = path.dirname(P.pgData);
    const prefix = `${path.basename(P.pgData)}.broken-`;
    const old = fs
      .readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name.startsWith(prefix))
      .map((e) => path.join(base, e.name))
      .sort()
      .reverse();
    for (const dir of old.slice(2)) fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // 清理旧残骸失败无所谓，不要因此挡住初始化
  }
}

/**
 * initdb 之前的所有「环境不对」检查。都在花几分钟下载/初始化之前做完，
 * 每一种失败都直接给出可执行的下一步。
 */
async function checkInitdbPrereqs(P, job) {
  // Postgres 明确拒绝以管理员/root 身份运行。这里提前失败，比 initdb 成功、
  // pg_ctl 启动时才报错更容易理解。
  if (await isElevated()) {
    const who = isWin ? '管理员' : 'root';
    const e = new Error(
      `当前以${who}身份运行，而 PostgreSQL 拒绝以${who}身份启动。\n` +
        (isWin
          ? '请关闭面板，改为普通用户双击启动——不要右键「以管理员身份运行」。'
          : '请用普通用户运行启动器。')
    );
    e.code = 'PG_ELEVATED';
    throw e;
  }

  try {
    const st = fs.statfsSync(P.runtime);
    const free = st.bsize * st.bavail;
    if (free < 150 * 1024 * 1024) {
      const e = new Error(
        `磁盘空间不足：运行目录所在磁盘只剩 ${humanBytes(free)}，初始化数据库至少需要约 150 MB。请清理磁盘后重试。`
      );
      e.code = 'PG_NO_SPACE';
      throw e;
    }
  } catch (e) {
    // statfs 在少数文件系统上不可用；空间不够最终会由 initdb 自己报出来。
    // 但上面主动抛出的那两个错误必须原样传出去。
    if (e.code === 'PG_NO_SPACE' || e.code === 'PG_ELEVATED') throw e;
  }

  fs.mkdirSync(P.pgData, { recursive: true });
  fs.mkdirSync(P.tmpDir, { recursive: true });
  try {
    const probe = path.join(P.pgData, '.ac-write-test');
    fs.writeFileSync(probe, 'ok');
    fs.rmSync(probe, { force: true });
  } catch (e) {
    const err = new Error(
      `数据目录不可写：${P.pgData}（${e.message}）。\n` +
        '请确认它不在只读盘/网络盘上，也没有被杀毒软件的「受控文件夹访问」保护；\n' +
        '也可以换一个更短的本地路径重新部署，例如 --runtime-dir D:\\ac-runtime。'
    );
    err.code = 'PGDATA_NOT_WRITABLE';
    throw err;
  }
  // Windows 的路径上限是 260 字符；pgdata 下面还会再叠几层，留出余量。
  if (isWin && P.pgData.length > 200) {
    job.line('warn', `数据目录路径长达 ${P.pgData.length} 个字符，接近 Windows 的 260 字符上限。若初始化失败，请用 --runtime-dir 换到更短的路径。`);
  }
}

/** 把 initdb 的原始输出归类成一句「该怎么办」。 */
function classifyInitdbFailure(r) {
  const code = unsignedExit(r.code);
  if (r.error || WIN_LOADER_FAILURES.has(code)) return describeBinaryFailure('initdb', r);
  const out = r.output || '';
  if (/invalid locale|locale .* (not found|not supported)|could not find suitable text search/i.test(out)) {
    return 'initdb 因区域设置（locale）失败。程序已经用 --locale=C 兜底，仍然失败通常是系统区域配置异常：可在「设置 → 时间和语言 → 语言和区域 → 管理语言设置」里取消勾选「Beta: 使用 Unicode UTF-8 提供全球语言支持」后重试。';
  }
  if (/Permission denied|Access is denied|拒绝访问|权限不足|could not (create|open|write)/i.test(out)) {
    return 'initdb 写不了数据目录：被权限或杀毒软件拦截了。请确认运行目录属于当前用户，把运行目录加入杀毒软件白名单，并关闭 Defender 的「受控文件夹访问」后重试。';
  }
  if (/could not create directory|The system cannot find the path|No such file or directory|系统找不到指定的路径/i.test(out)) {
    return 'initdb 创建数据目录失败：路径不可写或包含了 PostgreSQL 不接受的字符。请用 --runtime-dir 换到一个更短的纯英文路径（例如 D:\\ac-runtime）后重试。';
  }
  if (/No space left|not enough space|磁盘空间|Disk full/i.test(out)) {
    return '磁盘空间不足，initdb 无法写入。请清理运行目录所在磁盘后重试。';
  }
  if (/directory .* exists but is not empty|not empty/i.test(out)) {
    return '数据目录里还有上一次留下的文件。再点一次「重新部署」即可——面板会自动把未完成的数据目录移到旁边。';
  }
  return `initdb 失败（退出码 0x${code.toString(16).toUpperCase()}）。`;
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

  // 先做所有不需要跑 initdb 就能判断的检查：权限、磁盘、可写性、二进制能否加载。
  await checkInitdbPrereqs(P, job);
  await requireRunnable(P, job, 'initdb', P.initdb);

  if (pgDataNonEmpty(P)) {
    if (allowWipe) {
      job.line('err', `清空 ${P.pgData} …`);
      for (const f of fs.readdirSync(P.pgData)) {
        fs.rmSync(path.join(P.pgData, f), { recursive: true, force: true });
      }
    } else {
      // 以前这里直接抛 PGDATA_DIRTY，而界面从不传 allowWipe，于是「上次
      // initdb 失败」会把后续每一次部署都永久卡死。现在改成自动把残骸挪走：
      // 没有 PG_VERSION 的目录按定义就不是可用的数据簇，原样保留只是为了可逆。
      movePartialClusterAside(P, job);
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
    if (r.code !== 0) {
      const tail = (r.output || '').trim().split(/\r?\n/).filter(Boolean).slice(-12).join('\n');
      let aside = '';
      try {
        const moved = movePartialClusterAside(P, job);
        if (moved.moved) aside = `\n未完成的文件已原样移到 ${moved.dest}，下次重试不会再被它挡住。`;
      } catch {
        // 挪不走就保持现场；原始错误更重要。
      }
      const e = new Error(
        classifyInitdbFailure(r) +
          (tail ? `\n\ninitdb 最后几行输出：\n${tail}` : '') +
          aside
      );
      e.code = 'INITDB_FAILED';
      throw e;
    }
  } finally {
    fs.rmSync(pwFile, { force: true });
  }

  // 退出码 0 也可能是假成功（例如被安全软件「清理」过刚写出的文件）。
  if (!fs.existsSync(P.pgVersionFile)) {
    const e = new Error(
      `initdb 报告成功，但 ${P.pgData} 里没有 PG_VERSION，数据簇并没有真正建好。\n` +
        '这通常意味着写入被安全软件拦截或磁盘异常。请把运行目录加入杀毒软件白名单后重试。'
    );
    e.code = 'INITDB_INCOMPLETE';
    throw e;
  }
  job.line('out', `数据簇初始化完成：${P.pgData}`);
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
  if (!fs.existsSync(P.pgVersionFile)) {
    const e = new Error(
      `数据簇还没初始化（${P.pgData} 里没有 PG_VERSION），数据库无法启动。请点「重新部署」，或先修复数据库。`
    );
    e.code = 'PG_NOT_INITIALIZED';
    throw e;
  }

  const portRes = await tcpReachable('127.0.0.1', cfg.pgPort, 800);
  if (portRes.ok) {
    job.line('out', `端口 ${cfg.pgPort} 上已有 PostgreSQL 在运行，跳过启动。`);
    // 跳过启动不等于跳过等待：上一轮面板可能正是在恢复途中退出的，
    // 这里同样要确认它真的在接受连接，否则调用方照样会撞「starting up」。
    if (!(await waitDbReady(P, cfg, job, { timeoutMs: 180000 }))) {
      throw new Error(`端口 ${cfg.pgPort} 上的 PostgreSQL 在 180s 内仍未接受连接（可能卡在崩溃恢复）。${startFailureHint(P, job)}`);
    }
    return { already: true };
  }

  // 残留的 postmaster.pid 会让 pg_ctl 报 lock file exists
  if (fs.existsSync(P.postmasterPid)) {
    const stalePid = readPidFile(P.postmasterPid);
    if (stalePid && pidAlive(stalePid)) {
      job.line('out', `发现正在运行的 postmaster（PID ${stalePid}），直接复用。`);
      if (!(await waitDbReady(P, cfg, job, { timeoutMs: 180000 }))) {
        throw new Error(`复用的 postmaster（PID ${stalePid}）在 180s 内仍未接受连接（可能卡在崩溃恢复）。${startFailureHint(P, job)}`);
      }
      return { already: true };
    }
    job.line('err', '发现残留的 postmaster.pid（进程已不存在），清理后继续。');
    fs.rmSync(P.postmasterPid, { force: true });
  }

  // 真正启动前确认工具能加载。缺 VC++ 运行库时 pg_ctl 会立刻静默退出，
  // 只等端口超时的话，用户看到的是一句没有任何线索的「60s 内没有起来」。
  if (await isElevated()) {
    const who = isWin ? '管理员' : 'root';
    const e = new Error(
      `当前以${who}身份运行，PostgreSQL 拒绝以${who}身份启动。请关闭面板，改为普通用户重新启动。`
    );
    e.code = 'PG_ELEVATED';
    throw e;
  }
  await requireRunnable(P, job, 'pg_ctl', P.pgCtl);
  await requireRunnable(P, job, 'postgres', postgresExe(P));

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
    throw new Error(`PostgreSQL 在 60s 内没有起来。${startFailureHint(P, job)}`);
  }
  // 端口通 ≠ 能连。上次异常终止会留下要做崩溃恢复的簇，此时端口已在监听、
  // 连接全被拒（FATAL: the database system is starting up）。必须等 pg_isready
  // 说「接受连接」才算真的就绪，否则后续 createdb / drizzle-kit 会直接撞墙。
  if (!(await waitDbReady(P, cfg, job, { timeoutMs: 180000 }))) {
    throw new Error(`PostgreSQL 端口已监听，但 180s 内仍未接受连接（可能卡在崩溃恢复）。${startFailureHint(P, job)}`);
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
