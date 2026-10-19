// 多项目注册表：登记、端口预约、子面板的认领与停止。
//
// 三条规则贯穿本文件，每一条都对应一种会静默出错的失败：
//
//  1. **一个项目一个运行目录**。运行目录里装的是该项目的 src/、pgdata/、日志与
//     端口配置。两个项目共用一个运行目录，后果不是「有点乱」，而是 B 项目的
//     npm ci 覆盖 A 的 node_modules、B 的 drizzle push 打进 A 的库。
//  2. **端口只在加入时预约一次**，写进该项目自己的 config/panel.json，此后由
//     它自己做主。要改端口**只有一条路**：中枢的「重新分配端口」——它会停掉在跑的
//     应用与数据库、把三个端口与全部派生数据（databaseUrl / .env 的 DATABASE_URL
//     与 AGILECAMPUS_URL）一起改对、再按原状态拉回来。
//
//     为什么不能各改各的：portableDsn() 从 cfg.pgPort 推导 DATABASE_URL，事后单独
//     改写 pgPort 会让 DSN 与 POSTGRES_PASSWORD 静默失同步（config.mjs 的 writeEnv
//     注释里记着同一类事故的完整经过）。而 panel.mjs 的 opStart 另有它自己的问题
//     ——它只改 appPort（影响不到 DSN），但会从一张硬编码候选表里挑替代端口并落盘，
//     完全不知道别的项目预约了什么，于是可能**抢走别人的端口**。被中枢管着时这条路
//     已经堵掉（改为报错并指回中枢），独立跑面板时保留自动回退。
//  3. **停面板 ≠ 停服务**。面板是控制面，应用与数据库是被控制面。停止子面板
//     只关掉控制台窗口，pgdata 与跑着的站点一概不动。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathsFor, ensureDirs, loadConfig, saveConfig, readJson, writeJson, looksLikeRepo, randomToken, repoDirFromLock } from './config.mjs';
import { pidAlive, processStartTime, httpProbe } from './sysinfo.mjs';
import { allocatePorts } from './ports.mjs';
import { request } from './http.mjs';
import { killTree, identityMatches } from './process.mjs';

export const REGISTRY_VERSION = 1;

// 候选范围与预约集合住在 lib/ports.mjs —— 面板也要用同一张表（它得挑一个不撞别人
// 预约的替代端口），两处各写一份迟早漂移。这里只是把它转出去，保持既有 import 点
// （addProject 与它的调用方）不变。
export { allocatePorts };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 标识

/**
 * 由仓库路径推出稳定的 slug，用作运行目录名与注册表主键。
 *
 * 基名让人一眼认出是哪个项目，路径哈希保证**同一项目的两份检出不会互相覆盖**。
 * 这台机器上就有现成的例子：`agilecampus` 与 `agilecampus-master` 基名不同，
 * 但若哪天换成 `agilecampus` 与 `agilecampus-copy` 的备份目录，只有哈希能分开它们。
 */
export function slugify(repoDir) {
  const abs = path.resolve(repoDir);
  const base =
    path
      .basename(abs)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project';
  const h = crypto.createHash('sha1').update(abs.toLowerCase()).digest('hex').slice(0, 8);
  return `${base}-${h}`;
}

export function registryFile(dataRoot) {
  return path.join(dataRoot, 'projects.json');
}

// ------------------------------------------------------------ 读写与迁移

/**
 * 读注册表（纯读，不写盘）。
 *
 * 未知键一律保留：以后加字段不该让用户的列表掉东西。
 */
export function loadRegistry(dataRoot) {
  const raw = readJson(registryFile(dataRoot), null);
  const reg = {
    ...(raw && typeof raw === 'object' ? raw : {}),
    version: REGISTRY_VERSION,
    dataRoot: path.resolve(dataRoot),
    hub: { port: 8788, actualPort: null, ...((raw && raw.hub) || {}) },
    projects: Array.isArray(raw?.projects) ? raw.projects : [],
    // 用户明确移除过、不要再自动收编的仓库。见 removeProject 的说明。
    ignoredRepos: Array.isArray(raw?.ignoredRepos) ? raw.ignoredRepos : [],
  };
  return reg;
}

export function saveRegistry(dataRoot, reg) {
  const file = registryFile(dataRoot);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeJson(file, {
    version: REGISTRY_VERSION,
    dataRoot: path.resolve(dataRoot),
    hub: reg.hub,
    projects: reg.projects,
    // 这个键必须显式写出来：本函数写的是白名单，漏掉它等于每次保存都把用户的
    // 「别再把这条收编回来」擦掉，而那正好是下一次启动才发作的故障。
    ignoredRepos: reg.ignoredRepos || [],
  });
}

/**
 * 这个仓库在不在「别自动收编」的名单里。路径比较**不区分大小写**——Windows 上
 * `C:\Users\x` 与 `c:\users\x` 是同一个地方，注册表里两种写法都出现过。
 */
export function isIgnoredRepo(reg, repoDir) {
  const key = path.resolve(repoDir).toLowerCase();
  return (reg.ignoredRepos || []).some((r) => {
    try {
      return path.resolve(r).toLowerCase() === key;
    } catch {
      return false;
    }
  });
}

/** 把仓库从「别自动收编」名单里划掉（用户又把它加回来了）。返回是否真的划掉了。 */
export function clearIgnoredRepo(reg, repoDir) {
  const key = path.resolve(repoDir).toLowerCase();
  const kept = (reg.ignoredRepos || []).filter((r) => {
    try {
      return path.resolve(r).toLowerCase() !== key;
    } catch {
      return true;
    }
  });
  const changed = kept.length !== (reg.ignoredRepos || []).length;
  reg.ignoredRepos = kept;
  return changed;
}

/**
 * 把「数据根里已经有一套在用的单项目部署」这件事**原地收编**成注册表里的一条。
 *
 * 这在开发机上不是边缘情况而是常态：`%LOCALAPPDATA%\AgileCampus` 里躺着一个
 * 初始化好的 pgdata、下载好的 pgsql、同步好的 src，还有一份写着 databaseUrl 的
 * panel.json。**绝不搬动它**——几百 MB，而且 databaseUrl 里的路径与密码都绑着
 * 那个位置。所以这一条项目的运行目录就是数据根本身，只是打个 legacy 标记：
 * 清盘时它是唯一**不能整目录 rm -rf** 的那一条（见 purgeProject）。
 *
 * 返回 true 表示确实补进去了一条，调用方应随即 saveRegistry。
 */
export function migrateLegacy(dataRoot, reg) {
  const root = path.resolve(dataRoot);
  if (reg.projects.some((p) => p && p.runtimeDir && path.resolve(p.runtimeDir) === root)) return false;

  const cfg = readJson(path.join(root, 'config', 'panel.json'), null) || {};
  // 两个来源都要看：panel.json 里**通常没有** repoDir（旧版面板不写这个键，它的
  // 仓库是从 deploy/ 的文件位置推出来的），真正记着仓库的是锁文件。
  const repoDir = cfg.repoDir || repoDirFromLock(root);
  if (!repoDir) return false;
  // 指向的仓库已经不在了（或指错了）就别收编：让用户在中枢里手工加，好过把一条
  // 点开就报错的僵尸条目塞进列表。
  if (!looksLikeRepo(repoDir)) return false;
  const abs = path.resolve(repoDir);
  // 用户明确移除过它。**这一条不能省**：旧部署的条目就是「数据根里有一套部署」
  // 这件事本身，条目没了而文件还在，下次启动就会当场再收编一次，用户看到的是
  // 「删了又自己回来了」。想让TA回来，用「添加项目」加（addProject 会清掉这笔）。
  if (isIgnoredRepo(reg, abs)) return false;
  reg.projects.push({
    slug: slugify(abs),
    name: path.basename(abs),
    repoDir: abs,
    runtimeDir: root,
    legacy: true,
    autoStartPanel: false,
    addedAt: Date.now(),
    lastOpenedAt: null,
    // 仅作显示缓存；权威值在那个运行目录自己的 panel.json 里
    ports: { panel: cfg.panelPort ?? null, app: cfg.appPort ?? null, pg: cfg.pgPort ?? null },
    note: '由旧版单项目面板创建，运行目录就是数据根',
  });
  return true;
}

// ------------------------------------------------------------------ 端口
// allocatePorts 的实现在 lib/ports.mjs，本文件顶部转出。

// -------------------------------------------------------------- 项目读写

export function projectPaths(project) {
  return pathsFor(project.runtimeDir, project.repoDir);
}

export function projectConfig(project) {
  return loadConfig(projectPaths(project));
}

// ------------------------------------------------------------------ 清盘

/**
 * 收编的旧部署清盘时**按名字**删的那一份清单。
 *
 * 它的运行目录就是数据根，而中枢自己的东西全在同一层：`projects.json`（注册表
 * 本身）、`config/hub.secret`、`run/hub.lock`、`logs/hub.log`、`engine/`（正在被
 * import 的那份引擎副本，删了当场崩），还有别的项目长在 `projects/<slug>/`。
 * 所以这里是**白名单**：漏写一项只是少删一个文件（用户再点一次，或自己去资源
 * 管理器删），多写一项就是端掉整个注册表。
 *
 * 因此：**绝不写 `config` / `run` / `logs` / `projects` 这种目录名。** 那四个目录
 * 中枢自己也在用，写进去就是「删旧部署顺带删掉中枢」。同名的 `logs/` 与 `run/`
 * 只能按里面的文件名逐条列出——hub.log 与 hub.lock 必须留下，其余是部署的。
 */
const LEGACY_PURGE_RELS = [
  // 部署的四大块。node/ 是便携 node 的解包目录，tmp/ 是下载与解压的落脚点。
  'src',
  'node',
  'pgsql',
  'pgdata',
  'tmp',
  // 它自己的配置：端口、DSN、pgPassword 都在这里。删掉它才是真的注销——留着的话
  // migrateLegacy 下次启动会照它把这一条再收编回来。
  path.join('config', 'panel.json'),
  // 运行期的状态与锁（hub.lock 不在这里）
  path.join('run', 'panel.lock'),
  path.join('run', 'app.json'),
  path.join('run', 'pg.json'),
  path.join('run', 'deps.json'),
  // 它自己的日志（hub.log 不在这里）
  path.join('logs', 'app.log'),
  path.join('logs', 'app.err.log'),
  path.join('logs', 'build.log'),
  path.join('logs', 'pg.log'),
  path.join('logs', 'panel.log'),
];

/** 数据根里中枢自己在用的东西。只用来在返回里说清「这些没动」，不参与删除。 */
const LEGACY_KEEP_RELS = [
  'projects.json',
  path.join('config', 'hub.secret'),
  path.join('run', 'hub.lock'),
  path.join('logs', 'hub.log'),
  'engine',
  'projects',
];

/**
 * 清盘一个项目，返回 `{ mode, root, removed, kept }`。
 *
 * · 普通项目：整个运行目录都是它的（`projects/<slug>/`），一次 rm -rf 最省事。
 * · 收编的旧部署：只能按 `LEGACY_PURGE_RELS` 逐个名字删。**数据根本身永远不删。**
 *
 * 清完旧部署之后数据根会剩下中枢自己那几样东西，仍然是一个能用的中枢目录——所以
 * 这个函数不会把用户的中枢一起带走，也就该在界面上给他这个按钮，而不是让他去
 * 资源管理器里手工删（手工删恰恰是最容易把 projects.json 一起删掉的方式）。
 */
export function purgeProject(project) {
  const P = projectPaths(project);
  const root = path.resolve(P.runtime);

  if (!project.legacy) {
    fs.rmSync(root, { recursive: true, force: true });
    return { mode: 'whole', root, removed: [root], kept: [] };
  }

  const removed = [];
  for (const rel of LEGACY_PURGE_RELS) {
    const abs = path.resolve(root, rel);
    // 清单是常量、不含 `..`，这道断言理论上永远不会触发。但它守着一个 rm -rf 的
    // 入口，「理论上」三个字在这里不值钱：真被人改出一条 `..\..` 就是删整个盘。
    if (!abs.startsWith(root + path.sep)) {
      throw Object.assign(new Error(`清盘清单里有一条指向数据根之外：${rel}`), { code: 'PURGE_ESCAPE' });
    }
    if (!fs.existsSync(abs)) continue;
    fs.rmSync(abs, { recursive: true, force: true });
    removed.push(rel);
  }
  return { mode: 'scoped', root, removed, kept: LEGACY_KEEP_RELS };
}

export function findProject(reg, slug) {
  return (reg.projects || []).find((p) => p.slug === slug) || null;
}

/**
 * 登记一个新项目：分配运行目录与端口，并把端口写进它自己的 panel.json。
 *
 * 运行目录与端口都在**加入时**一次定好，该项目的 panel.json 从此是权威，
 * 注册表里的 ports 只是显示缓存。
 */
export async function addProject(reg, dataRoot, repoDir, { name = null } = {}) {
  const abs = path.resolve(repoDir);
  if (!looksLikeRepo(abs)) {
    throw Object.assign(new Error(`这个目录不像项目仓库（没有 package.json 或 .git）：${abs}`), { code: 'NOT_A_REPO' });
  }
  const dup = (reg.projects || []).find((p) => p.repoDir && path.resolve(p.repoDir).toLowerCase() === abs.toLowerCase());
  if (dup) {
    throw Object.assign(new Error(`这个仓库已经在列表里了：${dup.name}（${dup.repoDir}）`), { code: 'DUPLICATE', project: dup });
  }

  // 用户又把它加回来了：把「别自动收编」那一笔划掉，否则下次启动 migrateLegacy
  // 仍会跳过它（虽然它已经在列表里，这一笔留着不影响；但用户随后若又移出列表，
  // 就会变成一个说不清的状态）。加回来 = 撤销那次移除，语义上就该一起清。
  clearIgnoredRepo(reg, abs);

  const runtimeDir = path.join(path.resolve(dataRoot), 'projects', slugify(abs));
  const ports = await allocatePorts(reg);

  // 先把面板配置落盘再返回：这样即便中枢马上被关掉，这个项目的端口归属也已经
  // 定下来了，不会在下次启动时被当成「没预约过」而被重新分配。
  const P = ensureDirs(pathsFor(runtimeDir, abs));
  saveConfig(P, { ...loadConfig(P), panelPort: ports.panel, appPort: ports.app, pgPort: ports.pg });

  const project = {
    slug: slugify(abs),
    name: name || path.basename(abs),
    repoDir: abs,
    runtimeDir,
    ports,
    legacy: false,
    autoStartPanel: false,
    addedAt: Date.now(),
    lastOpenedAt: null,
  };
  reg.projects.push(project);
  return project;
}

/**
 * 只从列表里摘掉。清盘是另一件事，见 purgeProject。
 *
 * 收编的旧部署要顺手记一笔「用户明确移除过它」。它的条目**就是**那次收编本身，
 * 而 migrateLegacy 的判断是「数据根里有没有一条 runtimeDir 等于数据根的条目」
 * ——部署文件还在原地、条目却没了，下次启动就会当场再收编一次。用户看到的是
 * 「删了又自己回来了」，而两次之间他什么都没做。
 *
 * 记这一笔**不动仓库、不动运行目录**：文件一个字节都不少，只是不再自动收编。
 */
export function removeProject(reg, slug) {
  const i = (reg.projects || []).findIndex((p) => p.slug === slug);
  if (i === -1) throw Object.assign(new Error('列表里没有这个项目。'), { code: 'NOT_FOUND' });
  const [p] = reg.projects.splice(i, 1);
  if (p.legacy && p.repoDir && !isIgnoredRepo(reg, p.repoDir)) {
    reg.ignoredRepos = [...(reg.ignoredRepos || []), path.resolve(p.repoDir)];
  }
  return p;
}

// -------------------------------------------------------- 子面板的认领与停止

/** 读子面板的锁文件（只判形状，不判死活）。 */
export function readPanelLock(P) {
  const lock = readJson(P.lockFile, null);
  if (!lock || !lock.pid || !lock.port) return null;
  return lock;
}

/**
 * 子面板的**进程**在不在：锁可读 + 锁里的 pid 真的活着。**不探 HTTP。**
 *
 * 这是「面板在跑吗」唯一可靠的判据。锁本身不能信（pid 16392 那种死锁在这台机器
 * 上真实存在），所以 pid 存活的核对不能省。
 *
 * 为什么不在这里顺带探一次 /api/state（曾经就是那么写的）：那是**另一个问题**
 * ——「它此刻听不听我说话」。两者混在一起会出事，因为面板是单线程的：正在跑
 * npm ci / 构建 / 刷大段日志时，一次 GC 就可能让它 1.5 秒不回话。于是
 *
 *   • 中枢卡片闪一下「面板：未打开」，详情里还谎报「锁陈旧（进程已不在）」；
 *   • 点「打开控制面板」会去起**第二个**面板，而端口被第一个占着，必然起不来。
 *
 * 所以：问「在不在」用这个；问「能不能复用 / 能不能问它问题」再单独探一次。
 */
export function panelProcess(P) {
  const lock = readPanelLock(P);
  if (!lock) return null;
  return pidAlive(lock.pid) ? lock : null;
}

/** 探一次面板的 /api/state。true = 它在应答（没在跑时一律 false）。 */
async function panelAnswers(lock, timeout = 1500) {
  if (!lock) return false;
  const r = await httpProbe(`http://127.0.0.1:${lock.port}/api/state`, { timeout });
  return r.ok;
}

/**
 * 真的有一个子面板在跑**且此刻应答**吗。
 *
 * 只用在「马上就要拿它的结果去用」的地方——典型是 openProject 等新面板就绪：
 * 那里必须先拿到能应答的锁，否则会把一个还没 listen 的 URL 交给用户。
 * 判断「有没有在跑」请用 panelProcess，理由见上。
 *
 * 与 panel.mjs 自己的 findRunningPanel 同义，**两个判断必须一致**：中枢若比面板
 * 更宽松，就会出现「中枢以为在跑、点开却又起一个」；更严格则会出现「明明在跑，
 * 中枢说没有」。
 */
export async function livePanel(P) {
  const lock = panelProcess(P);
  if (!lock) return null;
  return (await panelAnswers(lock)) ? lock : null;
}

/**
 * 停掉一个子面板。**应用与数据库继续运行**——这正是这套设计里「关控制台」的定义。
 *
 * 两条路：
 *  1. 优雅 —— 用监督令牌调它的 shutdown，让面板自己清锁、关 server、flush 日志流。
 *  2. 降级硬杀 —— 优雅路径超时才走，且**必须先核对身份**。
 *
 * 硬杀为什么可以接受：应用是 detached + 文件 fd 起的（process.mjs 注释里讲清了
 * 那四个要点），Postgres 由 pg_ctl 独立起，面板自己只持有可自愈的锁与无关紧要的
 * 日志缓冲。所以杀面板与「用户直接关掉控制台窗口」等价，而那本来就是被支持的停止方式。
 *
 * **不删锁文件**：面板自己会把死 pid 的锁当作不存在，从外面删只是多一个竞态。
 */
export async function stopPanel(P, secret, log = () => {}) {
  const lock = readPanelLock(P);
  if (!lock) return { stopped: false, reason: 'no-lock' };
  if (!pidAlive(lock.pid)) return { stopped: false, reason: 'stale' };

  // 注意路径形态：操作名在**路径**里（POST /api/ops/<op>），不在请求体里。
  // 面板的开关就是拿路径尾部去做 switch 的（panel.mjs 的 `p.slice('/api/ops/'.length)`），
  // 所以 POST 到 /api/ops 会得到一个 404，然后被当成「优雅停机失败」降级成硬杀——
  // 能work，但每次都走最粗暴的那条路，而且看不出哪里不对。
  const r = await request(`http://127.0.0.1:${lock.port}/api/ops/shutdown`, {
    method: 'POST',
    token: secret,
    body: {},
    timeout: 4000,
  });
  if (r.ok) {
    for (let i = 0; i < 20 && pidAlive(lock.pid); i += 1) await sleep(250);
    if (!pidAlive(lock.pid)) return { stopped: true, graceful: true, pid: lock.pid };
    log(`子面板接受了优雅停机但 5 秒内没有退出（PID ${lock.pid}），改用硬杀。`);
  } else {
    // 这一行不是噪音：优雅停机失败会**静默降级**成硬杀，结果看起来一样（面板没了），
    // 于是没人会去查为什么。而两者的代价差很远——硬杀会丢掉面板的日志缓冲，
    // 也让「停面板」变得和「杀进程」等价，正是这套设计想避免的那种粗糙。
    log(`子面板优雅停机请求失败（HTTP ${r.status}${r.error ? '，' + (r.error.code || r.error.message) : ''}），改用硬杀。`);
  }

  // 身份核对：pid 会被系统复用。带上启动时间的锁才有资格被硬杀；锁里没记
  // （旧版本写的锁）时 identityMatches 会放行——它把 null 当「无法验证」而非
  // 「不匹配」，这一点在 process.mjs 里有明确说明。
  if (!(await identityMatches(lock.pidStartTime, lock.pid))) {
    return { stopped: false, reason: 'identity-mismatch', pid: lock.pid };
  }

  log(`子面板未响应优雅停机，强制终止 PID ${lock.pid}（应用与数据库继续运行）。`);
  await killTree(lock.pid);
  return { stopped: !pidAlive(lock.pid), graceful: false, pid: lock.pid };
}

// ------------------------------------------------------------ 中枢自己的密钥

/**
 * 中枢的监督令牌，持久化在 <数据根>\config\hub.secret。
 *
 * **为什么要落盘**：子面板把「启动时拿到的监督令牌」记在自己的可接受集合里。
 * 若中枢每次启动都换一个新令牌，重启之后它就无法优雅停掉上一轮自己起的面板，
 * 只能退化到硬杀。落盘让「重启中枢 → 重新接管」这条路径保持优雅。
 *
 * 信任级别与 config\panel.json 里明文存的 pgPassword 相同——两者都是本机
 * 文件系统级别的信任，都要在 README 的安全小节里写明，而不是留作隐含。
 */
export function loadHubSecret(dataRoot) {
  const file = path.join(path.resolve(dataRoot), 'config', 'hub.secret');
  try {
    const s = fs.readFileSync(file, 'utf8').trim();
    if (s.length >= 32) return s;
  } catch {}
  const s = randomToken(32);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s, 'utf8');
  return s;
}
