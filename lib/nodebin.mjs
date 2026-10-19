// 找一个**真的** Node 可执行文件。
//
// 为什么必须有这一层：面板原本直接拿 process.execPath 当解释器用——算 npm-cli.js
// 的路径、起 standalone 的 server.js，全靠它。folder 模式下那就是启动它的 Node，
// 一切正常；但打包成单文件 exe 之后 process.execPath 变成**本 exe**，于是：
//
//   · dirname(exe)/node_modules/npm/bin/npm-cli.js 不存在
//     → npm ci / db:push / next build 全废
//   · spawn(exe, ['--env-file-if-exists=…', server.js]) 会**重跑本 exe 并丢掉
//     那个脚本参数** → 起不来应用，而且**一个错误都不报**（最坏的失败形态）
//
// 所以「单文件 exe」不等于「不再需要 Node」：它只是自己不再兼任解释器。
// 目标项目的 npm ci / 构建 / 启动仍然需要一个真 Node，那正是 start.cmd 早就在
// 下载的那个便携版。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const require_ = createRequire(import.meta.url);

/**
 * node:sea 是**可选**内置模块——Node 20.12 之前根本没有它，而 start.cmd 只保证
 * 装了 v20 或更高。所以容错导入，绝不让老 Node 因为这个 import 直接起不来。
 */
let sea = null;
try {
  sea = require_('node:sea');
} catch {
  sea = null;
}

/** 本进程是不是被打包成了单文件 exe。 */
export function isSea() {
  try {
    return Boolean(sea && typeof sea.isSea === 'function' && sea.isSea());
  } catch {
    return false;
  }
}

export { sea };

function noNode(message) {
  return Object.assign(new Error(message), { code: 'NO_NODE' });
}

/** 用 Node 自己报版本，别去解析字符串——和 start.cmd 的判定方式保持一致。 */
function nodeVersion(exe) {
  if (!exe) return null;
  try {
    if (!fs.statSync(exe).isFile()) return null;
  } catch {
    return null;
  }
  try {
    const r = spawnSync(exe, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.status !== 0) return null;
    const m = /^(\d+)\.\d+\.\d+/.exec(String(r.stdout).trim());
    return m ? { major: Number(m[1]), raw: m[0] } : null;
  } catch {
    return null;
  }
}

/** 可用 = 存在、能跑、主版本 >= 20。与 start.cmd 的 `>=20` 判定同义。 */
function usable(exe) {
  const v = nodeVersion(exe);
  return Boolean(v && v.major >= 20);
}

/** 在目录里找便携 Node：既认 start.cmd 的 `node-<ver>-win-x64/` 布局，也认平铺的。 */
function findPortableNode(dir) {
  if (!dir) return null;
  const flat = path.join(dir, process.platform === 'win32' ? 'node.exe' : 'bin/node');
  if (usable(flat)) return flat;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const cand = path.join(dir, e.name, process.platform === 'win32' ? 'node.exe' : 'bin/node');
    if (usable(cand)) return cand;
  }
  return null;
}

/** PATH 上的 Node，取它自己报出来的真实路径。 */
function nodeOnPath() {
  try {
    const r = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    if (r.status !== 0) return null;
    const p = String(r.stdout).trim();
    return usable(p) ? p : null;
  } catch {
    return null;
  }
}

function argValue(name) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] || null : null;
}

// 按运行目录缓存：中枢会在一个进程里为多个项目解析，各自可能有自己的便携 Node。
const cache = new Map();

/**
 * 解析顺序：
 *   --node / AC_NODE_EXE  >  <运行目录>/node/**  >  process.execPath（仅非 SEA）  >  PATH
 *
 * folder 模式下第二、三步通常一致（start.cmd 就是用那个便携 Node 起的面板），
 * 于是行为与改造前逐位相同。
 *
 * **SEA 模式下找不到就抛，绝不回退到 process.execPath**——回退等于让本 exe
 * 去扮演 Node，结果是静默地再起一个面板。抛出去的错会被 startJob 的 try/catch
 * 接住，变成一条可读的任务失败信息。
 */
export function nodeExe(P = null) {
  const key = (P && P.runtime) || '';
  const hit = cache.get(key);
  if (hit) {
    if (hit.error) throw hit.error;
    return hit.exe;
  }
  try {
    const exe = resolveNode(P);
    cache.set(key, { exe });
    return exe;
  } catch (e) {
    cache.set(key, { error: e });
    throw e;
  }
}

function resolveNode(P) {
  const explicit = argValue('--node') || process.env.AC_NODE_EXE;
  if (explicit) {
    const p = path.resolve(explicit);
    if (!usable(p)) throw noNode(`--node / AC_NODE_EXE 指向的不是可用的 Node（需要 v20 或更高）：${p}`);
    return p;
  }
  if (P && P.nodeDir) {
    const found = findPortableNode(P.nodeDir);
    if (found) return found;
  }
  if (!isSea() && usable(process.execPath)) return process.execPath;
  const onPath = nodeOnPath();
  if (onPath) return onPath;
  throw noNode(
    isSea()
      ? '找不到可用的 Node.js。目标项目的 npm ci / 构建 / 启动都需要它。请在面板里下载便携版，或用 --node <路径> 指定。'
      : '找不到可用的 Node.js（需要 v20 或更高）。',
  );
}

// ------------------------------------------------------------- 子进程的 PATH

/** 在 env 里找到表示 PATH 的那个键（大小写不敏感），找不到就返回 'PATH'。 */
export function pathKey(env) {
  return Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
}

/**
 * 给子进程的 env 拼 PATH：Node 自己所在的目录 + 调用方指定的目录 + 继承来的。
 *
 * **这里修过一个把「首次部署」整个打死的 bug，两个原因各自都够独立。**
 *
 * 1. **键名的大小写。** Windows 上这个变量的键名是 `Path`（注册表里就是这种写法），
 *    而 `{ ...process.env }` 得到的是**普通对象**，属性查找区分大小写 ——
 *    `env.PATH` 读的是另一个键，拿到 `undefined`。于是原来那句
 *
 *        env.PATH = `${P.pgBin}${path.delimiter}${env.PATH || ''}`
 *
 *    把**整条继承来的 PATH 丢掉**，只剩 pgsql 的 bin 一个目录。子进程于是找不到
 *    `node`：npm 的 postinstall 里有五处裸 `node xxx`（esbuild ×3、sharp、
 *    msw、unrs-resolver），全部报「'node' 不是内部或外部命令」。而 npm 自己把这
 *    报成网络问题，面板照着它提示「把 registry 切到 npmmirror」—— 用户切了再试，
 *    一字不差地再失败一次。
 *
 *    **从 git-bash 启动时键名恰好是 `PATH`**（MSYS 显式设的），所以这个 bug 在
 *    开发机上永远复现不了，只有从 Explorer / cmd.exe 起的才中招 —— 而那正是用户
 *    的启动方式。
 *
 * 2. **Node 可能根本不在 PATH 上。** `nodeExe()` 会解析到便携版
 *    （`<运行目录>\node\**`）或 `--node` 指定的路径，两者都不在任何 PATH 里。
 *    不把它所在目录加进去，同一批生命周期脚本照样全挂。`dirname(nodeExe(P))`
 *    才是「子进程也能跑 node」这件事的**唯一**可靠来源。
 *
 * 顺序：Node 目录 → 调用方给的目录 → 继承来的。同一个目录只留一个（Windows 上
 * 按小写比较）。
 */
export function withPath(env, P, ...dirs) {
  const key = pathKey(env);
  const prepend = [];
  try {
    prepend.push(path.dirname(nodeExe(P)));
  } catch {
    // 解析不出 Node 不该在这里抛：调用点各自有更准确的报错（NO_NODE 等）。
    // 但 PATH 的其余部分仍要保住 —— 抛出去就等于又制造一次「PATH 被清空」。
  }
  for (const d of dirs) if (d) prepend.push(d);

  const seen = new Set();
  const all = [...prepend, ...String(env[key] || '').split(path.delimiter)]
    .map((s) => String(s).trim())
    .filter(Boolean)
    .filter((s) => {
      const k = process.platform === 'win32' ? s.toLowerCase() : s;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  env[key] = all.join(path.delimiter);
  return env;
}

// ------------------------------------------------- 怎么把「本程序」再起一份

/**
 * 启动器自己的源码根目录。
 *
 * `import.meta.url` 在两种模式下都指对地方：folder 模式指向真实源码目录；
 * exe 模式下 boot.cjs 已经把源码释放到 <运行目录>\engine\<hash>\ 并从那里 import，
 * 所以这里算出来的是那个 engine 目录。**不需要 AC_ENGINE_DIR**，它只是给人看的。
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ENGINE_DIR = path.resolve(HERE, '..');
export const MAIN_JS = path.join(ENGINE_DIR, 'main.mjs');

/**
 * 用当前这套代码再起一个进程（中枢拉起子面板走这里）。
 *
 * 与 nodeExe 是同一类陷阱的第二个面：exe 模式下 process.execPath 是本 exe，
 * 多带一个 main.mjs 参数会被当成**位置参数**……也就是「要监视的仓库目录」，
 * 于是一个本来要起子面板的调用会变成「对 main.mjs 这个文件起面板」并 exit 2。
 * 所以 exe 模式下参数原样透传（exe 自己就是入口），folder 模式下才补上 main.mjs。
 */
export function selfSpawn(argv) {
  if (isSea()) return { cmd: process.execPath, args: argv };
  return { cmd: process.execPath, args: [MAIN_JS, ...argv] };
}

/** npm 的可执行入口。直接跑 JS 文件，避开 .cmd（Node 20.12+ 拒绝直接 spawn .cmd）。 */
export function npmCliPath(P = null) {
  const exe = nodeExe(P);
  const cli = path.join(path.dirname(exe), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!fs.existsSync(cli)) {
    throw noNode(
      `Node 找到了（${exe}），但它旁边没有 npm：${cli}\n` +
        '通常是这个 Node 安装被裁剪过。请下载便携版 Node，或用 --node 指向一个完整安装。',
    );
  }
  return cli;
}
