// 源码同步 → 安装依赖 → 建表 → 构建 → 装配 standalone 产物 → 启动。
//
// 所有动作都发生在运行目录里的源码副本上，仓库目录只被读取。
import fs from 'node:fs';
import path from 'node:path';
import { spawnInto } from './jobs.mjs';
import { hashFile, hashTree, SYNC_EXCLUDES, findStandaloneRoot } from './config.mjs';
import { nodeExe, npmCliPath, withPath } from './nodebin.mjs';
import { healEnv, checks as envChecks, logChecks, FAIL } from './preflight.mjs';

// npm 的可执行入口。直接跑 JS 文件，避开 .cmd（Node 20.12+ 拒绝直接 spawn .cmd）。
// 实现已挪到 nodebin.mjs —— 它负责解析出一个**真的** Node，而不是假定 process.execPath
// 就是 Node（打包成单文件 exe 之后它不是）。这里原样转出去，老调用点一行都不用改。
export { npmCliPath };

/**
 * 构建期环境。
 *
 * 关键：必须删掉 NODE_ENV=production，否则 npm 会跳过 devDependencies，
 * 而 drizzle-kit / tailwindcss / typescript 全在 devDependencies 里，
 * 「推送表结构」和「构建」会双双失败。只有启动应用时才设 production。
 *
 * notes 是可选的口袋：自愈做了什么、为什么做，会写进这里，交给调用方去日志里说。
 * 不传就是纯粹不要那些说明（例如 dbdoctor 只想拿一份环境）。
 */
export function buildEnv(P, cfg, notes) {
  const env = { ...process.env };
  delete env.NODE_ENV;
  // 中枢下发的监督令牌绝不能外泄。这份 env 会被 npm / drizzle-kit / next build 继承，
  // 而它们跑的是**目标项目的代码**——任何一个 dump env 的环节都会把它漏出去，
  // 而它等于一把能停掉本机所有项目面板的钥匙。
  delete env.AC_SUPERVISOR_TOKEN;
  delete env.AC_HUB;
  // 必须走 withPath：**别**改回 `env.PATH = ...`。这里曾经因此把整条 PATH 丢掉，
  // 让五个 postinstall 的裸 `node` 全部失败、首次部署彻底跑不通。完整经过见
  // nodebin.mjs 的 withPath 注释。
  withPath(env, P, P.pgBin);
  // 再兜一层：withPath 管得住「node 与 pgsql 在不在」，管不住「继承来的那一段本身
  // 是不是坏的」。缺系统目录时 npm 连 cmd.exe 都起不来，而它报的错会指向别处。
  // 只增不减，见 preflight.mjs。
  healEnv(env, P, notes);
  if (cfg.databaseUrl) env.DATABASE_URL = cfg.databaseUrl;
  if (cfg.registry) env.npm_config_registry = cfg.registry;
  // Next 构建在内存紧张的机器上容易 OOM，给一个比默认更宽的上限
  env.NODE_OPTIONS = env.NODE_OPTIONS || '--max-old-space-size=4096';
  return env;
}

/**
 * 长任务开跑前的环境预检。**只查不改流程**：过了就往下走，没过就带着准确的原因停下。
 *
 * 为什么必须挡在 npm ci 前面：那一步要几分钟，而它失败时给出的结论是错的
 * （实测那次是「拉包失败 / 换个 registry 再试」，真相是六个 postinstall 找不到 node）。
 * 先花几十毫秒真起一个 cmd.exe 跑 `node -v`，把「环境是坏的」这件事在错误的结论
 * 产生之前就说清楚。
 *
 * 刻意**不重试**：重试只会把「环境坏了」藏得更深。
 */
export function preflight(P, cfg, job) {
  job.line('out', '环境预检（子进程能不能找到 node —— npm 的 postinstall 全靠它）…');
  const notes = [];
  const env = buildEnv(P, cfg, notes);
  for (const n of notes) job.line('warn', `已自愈：${n}`);
  const list = envChecks(P, env);
  logChecks(job, list);
  const bad = list.filter((c) => c.level === FAIL);
  if (bad.length) {
    const e = new Error(
      `环境预检未通过（${bad.length} 项：${bad.map((b) => b.title).join('、')}）。` +
        '已停在「安装依赖」之前——直接跑 npm ci 要几分钟，而它给出的大概率是「拉包失败」这类指向别处的结论。'
    );
    e.code = 'ENV_PREFLIGHT_FAILED';
    throw e;
  }
  return { env, checks: list };
}

// ------------------------------------------------------------------ 源码同步

function copyFileIfChanged(src, dest) {
  let srcStat;
  try {
    srcStat = fs.statSync(src);
  } catch {
    return false;
  }
  try {
    const destStat = fs.statSync(dest);
    if (destStat.size === srcStat.size && Math.abs(destStat.mtimeMs - srcStat.mtimeMs) < 1000) return false;
  } catch {}
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  // 保持时间戳一致，让下次同步能靠 mtime 快速跳过
  try {
    fs.utimesSync(dest, srcStat.atime, srcStat.mtime);
  } catch {}
  return true;
}

/**
 * 把仓库源码同步到运行目录。
 *
 * 排除 node_modules / .next / .env* —— 它们是运行目录自己的状态，
 * 绝不能被仓库的（可能不存在或过期的）版本覆盖。
 * 默认不删除目标端多余文件（保守，避免误删手工调整过的东西），mirror 为真时才做精确镜像。
 */
export function syncSource(P, job, { mirror = false } = {}) {
  const skip = new Set(SYNC_EXCLUDES);
  let copied = 0;
  let scanned = 0;
  const wanted = new Set();

  (function walk(dir, rel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (rel === '' && skip.has(e.name)) continue;
      // .env 系列：仓库里即便有，也不能带进运行目录，否则会覆盖本机生成的密钥
      if (e.name === '.env' || e.name.startsWith('.env.')) continue;
      if (e.name.endsWith('.tsbuildinfo')) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        scanned += 1;
        wanted.add(r.split('/').join(path.sep));
        if (copyFileIfChanged(abs, path.join(P.srcDir, r.split('/').join(path.sep)))) copied += 1;
      }
    }
  })(P.repoDir, '');

  let removed = 0;
  if (mirror) {
    (function prune(dir, rel) {
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (rel === '' && skip.has(e.name)) continue;
        if (e.name === '.env' || e.name.startsWith('.env.')) continue;
        const r = rel ? path.join(rel, e.name) : e.name;
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) prune(abs, r);
        else if (!wanted.has(r)) {
          fs.rmSync(abs, { force: true });
          removed += 1;
        }
      }
    })(P.srcDir, '');
  }

  job.line('out', `同步完成：扫描 ${scanned} 个文件，更新 ${copied} 个${mirror ? `，删除 ${removed} 个` : ''}。`);
  return { scanned, copied, removed };
}

// ------------------------------------------------------------------ 依赖安装

export async function installDeps(P, job, { force = false } = {}) {
  const lockFile = path.join(P.srcDir, 'package-lock.json');
  const lockHash = hashFile(lockFile);
  const modulesDir = path.join(P.srcDir, 'node_modules');
  // 标记必须放在 .next 之外：next.config.ts 里 cleanDistDir 是默认的 true，
  // 每次 next build 都会把 .next 整个清空。放在里面的话标记每轮都被抹掉，
  // 「依赖没变就跳过」永远不成立，每次部署都白跑一遍几分钟的 npm ci。
  // 放运行目录，构建与源码同步（含精确镜像）都碰不到它。
  const markerFile = path.join(P.runDir, 'deps.json');

  let marker = null;
  try {
    marker = JSON.parse(fs.readFileSync(markerFile, 'utf8'));
  } catch {}

  if (!force && marker && marker.lockHash === lockHash && fs.existsSync(modulesDir)) {
    job.line('out', '依赖未变化且 node_modules 已存在，跳过安装。');
    return { skipped: true };
  }
  if (!fs.existsSync(lockFile)) {
    throw new Error('运行目录里没有 package-lock.json，源码同步可能不完整。');
  }

  job.line('out', '执行 npm ci（首次约需几分钟）…');
  const r = await spawnInto(job, nodeExe(P), [npmCliPath(P), 'ci', '--no-audit', '--no-fund'], {
    cwd: P.srcDir,
    env: buildEnv(P, { registry: null }),
    timeoutMs: 30 * 60 * 1000,
  });
  if (r.code !== 0) {
    // 别把结论钉在网络上。这条路径上的失败原因里网络只占一部分，而 npm 自己的
    // 输出常常指向别处（实测：五个 postinstall 的裸 `node` 找不到解释器，npm 却
    // 只报 registry 相关的错）。原先把「切到 npmmirror」写成唯一的建议，用户照着
    // 切了源、再试一次，一字不差地再失败一次——错误信息把人引到了错误的方向。
    // 现在只负责说清「是什么失败了、失败到哪一步」，原因交回 npm 的原话。
    const e = new Error(
      `依赖安装失败（npm ci 退出码 ${r.code}）。原因以上面 npm 的原话为准；` +
        '若确实是拉包超时，可在「配置」里把 registry 切到 npmmirror 再试。'
    );
    e.code = 'NPM_CI_FAILED';
    throw e;
  }
  fs.mkdirSync(path.dirname(markerFile), { recursive: true });
  fs.writeFileSync(markerFile, JSON.stringify({ lockHash, at: Date.now() }));
  return { installed: true };
}

// ------------------------------------------------------------------ 建表

const DESTRUCTIVE_RE = /\b(DROP\s+(TABLE|COLUMN|CONSTRAINT|TYPE)|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN\s+\w+\s+(SET\s+NOT\s+NULL|TYPE))/i;

/**
 * 把 src/db/schema.ts 推到数据库。
 *
 * --force 会自动接受「丢数据」语句，所以不能无脑用。但 drizzle-kit 0.31
 * **没有 dry-run**（实测 `push --help` 只有 --verbose / --strict / --force，
 * 并没有 --explain），所以改用「不带 --force 先跑一次」来当护栏：
 *
 *   · spawnInto 已经把 stdin 设为 'ignore'。drizzle 碰到会丢数据的语句时
 *     拿不到确认，只能中止并把这些语句打印出来——破坏性变更就此被拦在应用之前。
 *   · 没有破坏性变更时，这一次就把改动正常应用了，不必再跑第二遍。
 *   · 首次部署（库里还没有表）没有数据可丢，直接 --force。
 *
 * 唯一残留的隐患是它可能不是「中止」而是「等待输入」；spawnInto 的 180s 超时
 * 与面板的「取消任务」都能兜住这种情况。
 */
export async function pushSchema(P, cfg, job, { confirmDestructive = false, firstRun = false } = {}) {
  const env = buildEnv(P, cfg);
  const npmCli = npmCliPath(P);

  if (!firstRun && !confirmDestructive) {
    job.stepDetail(job.currentStep, '检查表结构变更（不自动接受丢数据语句）…');
    const guard = await spawnInto(job, nodeExe(P), [npmCli, 'run', 'db:push', '--', '--verbose'], {
      cwd: P.srcDir,
      env,
      timeoutMs: 180000,
    });
    if (guard.code === 0) {
      job.line('out', '表结构已更新（没有出现需要确认的丢数据语句）。');
      return { pushed: true, applied: true };
    }
    const out = guard.output || '';
    const destructive = DESTRUCTIVE_RE.test(out);
    const e = new Error(
      destructive
        ? '检测到可能丢失数据的表结构变更，已停止执行。请核对下面的变更计划，确认无误后再执行一次。'
        : '表结构推送未能完成，已停止。请查看下面的原始输出。'
    );
    e.code = destructive ? 'SCHEMA_DESTRUCTIVE' : 'DB_PUSH_FAILED';
    e.plan = out.slice(-4000);
    throw e;
  }

  job.stepDetail(job.currentStep, confirmDestructive ? '推送表结构（已确认可丢数据）…' : '推送表结构…');
  const r = await spawnInto(job, nodeExe(P), [npmCli, 'run', 'db:push', '--', '--force'], {
    cwd: P.srcDir,
    env,
    timeoutMs: 300000,
  });
  if (r.code !== 0) {
    const e = new Error('表结构推送失败，请查看上方原始输出。');
    e.code = 'DB_PUSH_FAILED';
    e.plan = (r.output || '').slice(-4000);
    throw e;
  }
  return { pushed: true };
}

/** 用便携 psql 数一下库里有多少张表，用来判断是不是首次部署。 */
export async function tableCount(P, cfg, job) {
  if (!fs.existsSync(P.psql)) return null;
  const args = ['-h', '127.0.0.1', '-p', String(cfg.pgPort), '-U', 'agilecampus', '-d', 'agilecampus', '-tAc',
    "select count(*) from information_schema.tables where table_schema='public'"];
  const r = await spawnInto(job, P.psql, args, {
    env: { ...buildEnv(P, cfg), PGPASSWORD: cfg.pgPassword },
    timeoutMs: 30000,
  });
  const n = Number((r.output || '').trim().split('\n').pop());
  return Number.isFinite(n) ? n : null;
}

// ------------------------------------------------------------------ 构建

/**
 * 构建。**动手前先把正在运行的应用停掉**，这不是洁癖，是 Windows 的硬约束。
 *
 * 应用是 detached 起在 .next/standalone 里的，spawn 时 cwd 就设成了那个目录
 * （见 process.mjs 的 startApp；「应用入口位于嵌套目录」那条日志也在说同一件事）。
 * Windows 不允许删除任何**活进程的当前工作目录**，而 next build 会先把 .next
 * 整个清空 —— 清到 .next/standalone 这一步的 rmdir 必然 EBUSY，构建就此中断。
 * 用户看到的是「构建失败」，病因却在上一轮还开着的应用上，隔了两步，很难倒推。
 *
 * 别把被停掉的旧应用当成「被打断的正常服务」：此刻 .next 里的文件已被删掉，
 * 它只是还活在内存里，撑不过下一次重启 —— 停掉的是个已经作废的壳。
 *
 * 只停我们自己记录在案的应用（appStatus 的 adopted）。端口上坐着别人的进程时
 * 不插手，那是另一回事，留给启动那一步去报。
 */
export async function buildApp(P, cfg, job, proc) {
  const status = await proc.appStatus(P, cfg);
  if (status.adopted) {
    job.stepDetail(job.currentStep, `构建前先停止正在运行的应用（PID ${status.pid}）…`);
    await proc.stopApp(P, cfg, (m) => job.line('out', String(m)));
  }
  job.stepDetail(job.currentStep, '编译中（首次约需 1-3 分钟）…');
  const r = await spawnInto(job, nodeExe(P), [npmCliPath(P), 'run', 'build'], {
    cwd: P.srcDir,
    env: buildEnv(P, {}),
    timeoutMs: 30 * 60 * 1000,
  });
  if (r.code !== 0) {
    // 万一 appStatus 没认出来（比如状态文件丢了、应用是旧版面板起的），
    // 至少把 EBUSY 这条最可能的病因译成人话，别让用户对着一行 errno 猜。
    const locked = /EBUSY[\s\S]{0,200}?\.next/i.test(r.output || '');
    const e = new Error(
      locked
        ? '构建失败：.next 被占用（EBUSY）。多半是应用还在跑 —— 它的工作目录就是 ' +
          '.next/standalone，而 Windows 不允许删除活进程的工作目录。' +
          '请在面板点「停止应用」后重试。'
        : '构建失败，请查看上方原始输出。若提示内存不足，可尝试关闭其他程序后重试。',
    );
    e.code = 'BUILD_FAILED';
    throw e;
  }
  return { built: true };
}

// ------------------------------------------------------- standalone 产物装配

function copyDir(src, dest, job) {
  let n = 0;
  (function walk(from, to) {
    let entries;
    try {
      entries = fs.readdirSync(from, { withFileTypes: true });
    } catch {
      return;
    }
    fs.mkdirSync(to, { recursive: true });
    for (const e of entries) {
      const a = path.join(from, e.name);
      const b = path.join(to, e.name);
      if (e.isDirectory()) walk(a, b);
      else if (e.isFile()) {
        fs.copyFileSync(a, b);
        n += 1;
      }
    }
  })(src, dest);
  job?.log('out', `复制 ${src} → ${dest}（${n} 个文件）`);
  return n;
}

/**
 * 把嵌套的 standalone 产物摊平到 .next/standalone 下。
 *
 * 不只是为了好看：重启应用、读它的日志、界面上显示「应用根在哪里」全都依赖一个
 * 可预期的固定位置。另外嵌套会白白吃掉几十个字符，node_modules 里的长路径很容易
 * 顶到 Windows 的 260 上限。
 *
 * 搬迁是安全的——生成的 server.js 用 `path.join(__dirname)` 与
 * `process.chdir(__dirname)` 定位自己，全是相对路径。同盘 renameSync 移动目录是
 * O(1)，不产生任何复制开销（node_modules 也不怕）。先做一遍同名冲突预检，
 * 只要目标位置没有同名项，搬迁就不会半途失败。
 */
function flattenStandalone(P, root, job) {
  if (root === P.standaloneDir) return root;
  let names;
  try {
    names = fs.readdirSync(root);
  } catch {
    return root;
  }
  const clash = names.filter((n) => fs.existsSync(path.join(P.standaloneDir, n)));
  if (clash.length) {
    job?.log('err', `standalone 产物嵌套在 ${root}，但摊平会与已有项冲突（${clash.join('、')}），就地使用该目录。`);
    return root;
  }
  try {
    for (const n of names) fs.renameSync(path.join(root, n), path.join(P.standaloneDir, n));
  } catch (e) {
    job?.log('err', `摊平 standalone 产物失败（${e.message}），就地使用 ${root}。`);
    return root;
  }
  // 清掉剩下的空壳目录链；遇到非空目录就停手
  let dir = path.dirname(root);
  while (dir !== P.standaloneDir && dir.startsWith(P.standaloneDir + path.sep)) {
    try {
      fs.rmdirSync(dir);
    } catch {
      break;
    }
    dir = path.dirname(dir);
  }
  job?.log('out', `standalone 产物原本嵌套在 ${root}，已摊平到 ${P.standaloneDir}。`);
  return P.standaloneDir;
}

/**
 * 把构建产物摆成能直接 node server.js 的样子。
 * 与 Dockerfile 第 31–33 行一一对应：standalone 就地生成，
 * static 与 public 必须手工搬进去，漏了会白屏。
 */
export function assembleStandalone(P, job) {
  const found = findStandaloneRoot(P);
  if (!found) {
    const e = new Error(
      `构建产物里找不到 server.js（${P.standaloneDir}）。` +
        '请确认 next.config.ts 里的 output: "standalone" 未被改动。'
    );
    e.code = 'NO_STANDALONE';
    throw e;
  }
  if (found !== P.standaloneDir) job.line('out', `应用根位于嵌套目录：${found}`);
  const root = flattenStandalone(P, found, job);
  if (fs.existsSync(P.staticDir)) {
    copyDir(P.staticDir, path.join(root, '.next', 'static'), job);
  } else {
    job.line('err', `警告：找不到 ${P.staticDir}，页面可能没有样式。`);
  }
  if (fs.existsSync(P.publicDir)) {
    copyDir(P.publicDir, path.join(root, 'public'), job);
  }
  // Next 有时会把 .env 复制进 standalone，留着会出现「两份真相」，删掉
  for (const f of fs.readdirSync(root)) {
    if (f === '.env' || f.startsWith('.env.')) {
      fs.rmSync(path.join(root, f), { force: true });
      job.line('out', `已移除 standalone 内的 ${f}（环境变量统一由 --env-file 传入）。`);
    }
  }
  return root;
}

/** 构建产物是否已经可以启动。 */
export function standaloneReady(P) {
  return Boolean(findStandaloneRoot(P));
}

// ------------------------------------------------------------------ 总编排

/**
 * process.mjs 里那几个函数（startApp / stopApp / restartApp / waitAppReady）的第三个
 * 参数是**日志函数**，不是 job 对象。这里桥一下。
 *
 * 别把 job 直接传进去：job 不是函数，第一行就会炸出 "log is not a function"，
 * 而且报错发生在「应用已经起来之前」，看起来像是启动失败，实际只是调用约定不匹配。
 */
function jobLogger(job) {
  return (m) => job.line('out', m);
}

export const DEPLOY_STEPS = ['同步源码', '安装依赖', '初始化数据库', '推送表结构', '构建前端', '装配产物', '启动应用'];

/**
 * 完整部署流程。任何一个环节抛错，任务即失败并把最后输出留在界面上。
 * deps 由调用方注入（panel.mjs），避免这里反向依赖 pg / process 模块。
 */
export async function deployAll(P, cfg, job, deps, opts = {}) {
  const { pg, proc } = deps;

  // 0 预检（不占 DEPLOY_STEPS 的编号：它是所有步骤的前提，不是其中一步）
  preflight(P, cfg, job);

  // 1 同步
  job.step(0);
  job.stepDetail(0, `同步 ${deps.repoDir} → ${P.srcDir}`);
  syncSource(P, job, { mirror: opts.mirror });

  // 2 依赖
  job.step(1);
  await installDeps(P, job, { force: opts.forceDeps });

  // 3 数据库
  job.step(2);
  if (cfg.dbMode === 'portable') {
    job.stepDetail(2, '检查便携 PostgreSQL…');
    await pg.installPortable(P, job);
    if (opts.allowWipePgData) job.log('out', '（已授权在数据目录异常时清空重建）');
    await pg.initCluster(P, cfg, job, { allowWipe: opts.allowWipePgData });
    await pg.startPortable(P, cfg, job);
    await pg.ensureDatabase(P, cfg, job);
  } else if (cfg.dbMode === 'external') {
    job.stepDetail(2, '使用外部数据库');
    const reach = await pg.detectExisting(cfg);
    if (!reach.length || !reach[0].reachable) {
      throw new Error(`外部数据库 ${cfg.databaseUrl} 无法连接，请检查地址、端口与网络。`);
    }
    job.line('out', `外部数据库可达：${cfg.databaseUrl.replace(/:[^:@/]*@/, ':****@')}`);
  } else {
    throw new Error('尚未选择数据库模式。请在向导里选择「使用本机便携数据库」或填写外部连接串。');
  }

  // 4 表结构
  job.step(3);
  const tables = cfg.dbMode === 'portable' ? await tableCount(P, cfg, job) : null;
  const firstRun = tables === null ? !cfg.builtAt : tables === 0;
  if (tables !== null) job.log('out', `当前库里有 ${tables} 张表。`);
  await pushSchema(P, cfg, job, { firstRun, confirmDestructive: opts.confirmDestructive });

  // 5 构建
  job.step(4);
  await buildApp(P, cfg, job, proc);

  // 6 装配
  job.step(5);
  assembleStandalone(P, job);

  // 7 启动
  job.step(6);
  if (opts.skipStart) {
    job.line('out', '按要求跳过启动。');
    return { skippedStart: true };
  }
  const started = await proc.restartApp(P, cfg, jobLogger(job));
  return { started };
}

/** 只同步 + 重建，不动数据库。用于「改了源码，重新部署」。 */
export async function rebuildAll(P, cfg, job, deps, opts = {}) {
  // 这一行曾经不存在，而下面第 7 步用了 proc.restartApp —— 于是「重新部署」每次
  // 都在**最后一步**炸成 "proc is not defined"：同步、装依赖、构建、装配全都白做，
  // 界面只留下一个看不出病因的错。deployAll 一直是对的，错的是这个孪生函数，
  // 所以照抄 deployAll 的那一行就够了。
  const { proc } = deps;

  preflight(P, cfg, job);

  job.step(0);
  syncSource(P, job, { mirror: opts.mirror });
  job.step(1);
  await installDeps(P, job, { force: opts.forceDeps });
  job.step(2);
  job.line('out', '跳过数据库（重建流程不动数据库）。');
  job.step(3);
  job.line('out', '跳过表结构推送。');
  job.step(4);
  await buildApp(P, cfg, job, proc);
  job.step(5);
  assembleStandalone(P, job);
  job.step(6);
  if (opts.skipStart) return { skippedStart: true };
  return { started: await proc.restartApp(P, cfg, jobLogger(job)) };
}

/** 源码树是否与上次构建时一致。 */
export function sourceChanged(P, cfg) {
  const h = hashTree(P.srcDir);
  return { changed: h !== cfg.sourceHash, hash: h };
}
