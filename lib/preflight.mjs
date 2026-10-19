// 子进程环境的预检与自愈。
//
// 「首次部署」在这台机器上真的失败过一次，界面上的错却是 npm 报的一串 registry
// 相关错误——因为六个 postinstall（esbuild ×3 / sharp / msw / unrs-resolver）都要
// 起一个裸 `node xxx`，而它们继承到的 PATH 里没有 node。根因已经修了（nodebin.mjs
// 的 withPath），但**修的是那一处**；这一类故障的性质是「界面上的结论指向错误的方向，
// 而你只有跑完几分钟的 npm ci 才会撞上」。所以这里补两件事：
//
//   1. 自愈 —— 子进程要用的 PATH 里，系统目录（System32）必须有。npm 在 Windows 上
//      是**通过 cmd.exe** 跑生命周期脚本的，PATH 里没有 System32 它连 cmd.exe 都起不来。
//      withPath 只能保证 node 与 pgsql 的位置，管不了「继承来的那一段本身是不是坏的」。
//      坏掉时从注册表读一份「机器 + 用户」的 PATH 补上——**只增不减**，所以它不可能
//      把本来能用的情况弄坏。
//   2. 预检 —— 不去推理「PATH 字符串看着对不对」，而是真的起一个 cmd.exe 跑 `node -v`。
//      那正是 npm 干的事，也是唯一能证明问题的办法。长任务（部署 / 重建）开跑前先跑
//      它；同一批检查也进「检修」，所以既能被看到，也能被手动重跑。
//
// 刻意**没有**做自动重试：失败就带着准确的原因停下来。重试会把「环境是坏的」这件事
// 藏起来，而这一整类故障的全部代价就是它藏得太好。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { nodeExe, npmCliPath, withPath, pathKey } from './nodebin.mjs';

export const OK = 'ok';
export const WARN = 'warn';
export const FAIL = 'fail';
export const SKIP = 'skip';

const WIN = process.platform === 'win32';

/** env 里 PATH 的目录列表（键名大小写不敏感，见 nodebin.mjs 的那段教训）。 */
export function pathDirs(env) {
  return String(env[pathKey(env)] || '')
    .split(path.delimiter)
    .map((s) => s.trim())
    .filter(Boolean);
}

const sameDir = (a, b) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);

/** Windows 自己的系统目录。缺了它，子进程起不了 cmd.exe。 */
function systemDirs() {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return [path.join(root, 'system32'), root];
}

/**
 * 找 cmd.exe / reg.exe 的**绝对**路径。
 *
 * 必须绕开 PATH：这两个工具恰恰是拿来修 PATH 的，而「PATH 坏了」正是它们的用武之地。
 * 靠 PATH 去找它们就是自举——实测（把 PATH 换成一个 pgsql bin）`reg query` 直接
 * 解析不到 `reg`，于是自愈退化成「注册表读不到」，而命令行里真起 `cmd.exe` 也会
 * 变成 ENOENT，报出来的原因就成了「找不到 cmd.exe」而不是「找不到 node」。
 * 找不到绝对路径时退回裸名字（非标准安装位置，聊胜于无）。
 */
function sysExe(name) {
  const abs = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', name);
  try {
    if (fs.existsSync(abs)) return abs;
  } catch {}
  return name;
}

/** PATH 里缺了哪些系统目录（非 Windows 上恒为空）。 */
export function missingSystemDirs(env) {
  if (!WIN) return [];
  const have = new Set(pathDirs(env).map((d) => d.toLowerCase()));
  return systemDirs().filter((d) => !have.has(d.toLowerCase()));
}

/** `%NAME%` 展开。查不到的变量**原样留着**——Windows 自己也是这么做的。 */
function expandRefs(value) {
  return value.replace(/%([^%]+)%/g, (whole, name) => {
    const k = Object.keys(process.env).find((key) => key.toUpperCase() === name.toUpperCase());
    return k ? process.env[k] : whole;
  });
}

/**
 * 读注册表里的一份「机器 + 用户」PATH，展开后返回目录数组。
 *
 * 为什么是注册表而不是别处：进程自己那份 env 正是可能坏掉的那一份，问它等于自证。
 * 注册表是它在 Windows 上的来源。REG_EXPAND_SZ 存的是**没展开**的原文
 * （本机上真的有一条 `%DevEco Studio%\...`），所以要自己展开一遍。
 *
 * 读不到就返回 []（比如 reg.exe 不在、权限受限）——调用方会退回只用系统目录兜底。
 */
export function registryPathDirs() {
  if (!WIN) return [];
  const keys = [
    'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',
    'HKCU\\Environment',
  ];
  const out = [];
  for (const key of keys) {
    let r;
    try {
      r = spawnSync(sysExe('reg.exe'), ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
    } catch {
      continue;
    }
    if (r.status !== 0 || !r.stdout) continue;
    // 形如：    Path    REG_EXPAND_SZ    C:\Windows\system32;C:\Windows;...
    for (const line of String(r.stdout).split(/\r?\n/)) {
      const m = /^\s{4}Path\s+(REG_[A-Z_]+)\s+(.+?)\s*$/i.exec(line);
      if (!m) continue;
      const value = m[1].toUpperCase() === 'REG_EXPAND_SZ' ? expandRefs(m[2]) : m[2];
      out.push(...value.split(path.delimiter).map((s) => s.trim()).filter(Boolean));
      break;
    }
  }
  return out;
}

/**
 * 自愈：PATH 里缺系统目录（或解析得出的 Node 目录）时，补上它们。**只增不减。**
 *
 * 补的顺序走 withPath，也就是「Node 目录 → 新补的 → 继承来的」，Windows 从左往右
 * 找，所以补进来的那份会先被命中。已有目录全部保留——这个函数没有任何一条路径会
 * 让情况比调用前更糟，这是它敢在每次构env时都跑的前提。
 *
 * notes 里会写下「做了什么、为什么」，交给调用方去日志里说清楚。静默自愈是另一种
 * 撒谎：用户下次遇到同类故障时，手上会少一条线索。
 */
export function healEnv(env, P, notes = []) {
  if (!WIN) return env;
  const missing = missingSystemDirs(env);
  const dirs = pathDirs(env);

  let nodeDir = null;
  try {
    nodeDir = path.dirname(nodeExe(P));
  } catch {
    // 解析不出 Node 是另一类故障（NO_NODE），这里补不了，交给预检去报。
  }
  const needNode = Boolean(nodeDir) && !dirs.some((d) => sameDir(d, nodeDir));
  if (!missing.length && !needNode) return env;

  if (missing.length) {
    const extra = registryPathDirs();
    const from = extra.length ? '从注册表补齐' : '用系统目录兜底（注册表读不到）';
    withPath(env, P, ...(extra.length ? extra : systemDirs()));
    notes.push(
      `子进程的 PATH 里缺少系统目录 ${missing.join('、')}，已${from}。` +
        'npm 在 Windows 上是靠 cmd.exe 跑 postinstall 的，缺了它「安装依赖」会全灭，而 npm 报出来的往往是别的错。'
    );
  } else if (needNode) {
    notes.push(`子进程的 PATH 里没有 Node 自己的目录（${nodeDir}），已补在最前面。`);
    withPath(env, P);
  }
  return env;
}

/**
 * 真的起一个 cmd.exe 跑 `node -v`。
 *
 * 这是全部检查里唯一能证明问题的：前面那些只说明 PATH 字符串拼对了，而用户遇到的
 * 是「'node' 不是内部或外部命令」。npm 跑 postinstall 走的就是这条 exact 路径
 * （`cmd.exe /d /s /c node install.js`）。
 */
export function nodeRunsIn(env, { timeout = 20000 } = {}) {
  if (!WIN) return { ok: false, skip: true, detail: '非 Windows：npm 不经过 cmd.exe，这条检查不适用。' };
  let r;
  try {
    // 绝对路径，理由见 sysExe：PATH 坏了的时候，裸 'cmd.exe' 会解析不到，
    // 那会把「找不到 node」误报成「找不到 cmd.exe」。
    r = spawnSync(sysExe('cmd.exe'), ['/d', '/s', '/c', 'node -v'], { env, encoding: 'utf8', timeout, windowsHide: true });
  } catch (e) {
    return { ok: false, detail: `起 cmd.exe 就失败了：${e.message}` };
  }
  const out = String(r.stdout || '').trim();
  const err = String(r.stderr || '').trim();
  if (r.status === 0 && /^v\d+\./.test(out)) return { ok: true, version: out, detail: out };
  const why = err || out || (r.error ? String(r.error.message) : `退出码 ${r.status}`);
  return { ok: false, status: r.status, detail: why };
}

/**
 * 一份检查清单，格式与 dbdoctor 的一致（id / title / level / detail / fixId），
 * 所以「检修」可以直接把它拼进去。
 *
 * env 由调用方给（面板是 `buildEnv(P, cfg)`）——这里**不**自己构造，免得出现
 * 「检修查的是一份环境、部署用的是另一份」这种最没意义的错位。
 */
export function checks(P, env) {
  const out = [];
  const dirs = pathDirs(env);

  let nodeDir = null;
  let nodeErr = null;
  try {
    nodeDir = path.dirname(nodeExe(P));
  } catch (e) {
    nodeErr = e;
  }
  if (!nodeDir) {
    out.push({
      id: 'env-node',
      title: '找得到 Node 解释器',
      level: FAIL,
      detail:
        `解析不出 Node：${nodeErr?.message || '未知原因'}。` +
        '子进程的 PATH 里因此没有 node，npm 的 postinstall（esbuild / sharp / msw / unrs-resolver 共六处）会全部失败。' +
        '打包成 exe 运行时请确认运行目录下装好了便携 Node，或用 --node 指定一个。',
      fixId: null,
    });
  } else {
    const has = dirs.some((d) => sameDir(d, nodeDir));
    out.push({
      id: 'env-node',
      title: '子进程 PATH 里有 Node 自己的目录',
      level: has ? OK : FAIL,
      detail: has ? `${nodeDir}` : `缺 ${nodeDir} —— 便携版与 --node 指定的 Node 都不在任何 PATH 上，必须显式加进去。`,
      fixId: 'env-path',
    });
  }

  const missing = missingSystemDirs(env);
  out.push({
    id: 'env-sysdirs',
    title: '子进程 PATH 里有系统目录（cmd.exe 要靠它）',
    level: missing.length ? WARN : OK,
    detail: missing.length
      ? `缺 ${missing.join('、')}。继承来的 PATH 被上游弄坏了；缺了它 npm 连 cmd.exe 都起不来，而报出来的错会指向别处。`
      : '系统目录在。',
    fixId: 'env-path',
  });

  const run = nodeRunsIn(env);
  out.push({
    id: 'env-node-run',
    title: '真的起 cmd.exe 跑一次 `node -v`',
    level: run.skip ? SKIP : run.ok ? OK : FAIL,
    detail: run.ok
      ? `输出 ${run.version}。这正是 npm 跑 postinstall 的方式。`
      : run.skip
        ? run.detail
        : `失败：${run.detail}。这就是「首次部署」卡在「安装依赖」的样子——npm 会把原因说成拉包失败，其实根本没有解释器。`,
    fixId: run.ok ? null : 'env-path',
  });

  let npmPath = null;
  try {
    npmPath = npmCliPath(P);
  } catch (e) {
    out.push({ id: 'env-npm', title: '找得到 npm 入口', level: FAIL, detail: `解析不出 npm-cli.js：${e.message}`, fixId: null });
  }
  if (npmPath) {
    const exists = fs.existsSync(npmPath);
    out.push({
      id: 'env-npm',
      title: '找得到 npm 入口',
      level: exists ? OK : FAIL,
      detail: exists ? npmPath : `${npmPath} 不存在——通常意味着那份 Node 不完整（便携版解压中断过）。`,
      fixId: null,
    });
  }

  return out;
}

/** 把一串检查渲染成日志行。fail 走 err，warn 走 warn，其余走 out。 */
export function logChecks(job, list, indent = '') {
  for (const c of list) {
    const mark = c.level === OK ? '✓' : c.level === FAIL ? '✗' : c.level === SKIP ? '·' : '!';
    const level = c.level === FAIL ? 'err' : c.level === WARN ? 'warn' : 'out';
    job.line(level, `${indent}${mark} ${c.title}：${c.detail}`);
  }
}
