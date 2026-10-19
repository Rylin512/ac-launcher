// 单文件 exe 的入口（SEA main）。
//
// 形态：本文件 + 全部面板/中枢源码**原样**作为 SEA assets 内嵌。
// 启动时把 assets 释放到 <运行目录>\engine\<内容哈希>\，然后**在同一个进程里**
// import() 那份 main.mjs。
//
// 为什么绕这一圈，而不是把面板代码直接编进 exe：
//   · 源码以 ESM 原样运行 → import.meta.url 正常 → panel.mjs 的 UI_DIR 一行都不用改
//   · 不需要 esbuild 把 ESM 转成 CJS（Node 24 的 SEA 还不支持 ESM 入口）
//   · 只需 postject 一个工具
//   代价只是磁盘上多一份释放出来的源码副本，而它顺带把面板变成了可读、可 diff 的。
//
// 这个文件必须是 CommonJS：Node 24 的 SEA 只接受 CJS 作为 main。
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

let sea = null;
try {
  sea = require('node:sea');
} catch {
  sea = null;
}

/** 认领文件的文件名。放在各自那份 engine 目录里，内容是 {hash, pid, at}。 */
const CLAIM_FILE = '.inuse';
/** 无人认领的 engine 目录要放多久才敢删。见 planEnginePrune 里的说明。 */
const UNCLAIMED_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** 名字里解析不出 pid 的 .tmp-* 目录要放多久才敢删。 */
const TMP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * 运行目录。**必须与 lib/config.mjs 的 resolveRuntimeDir 保持同一套优先级**。
 *
 * 这里刻意重写一遍而不去 import config.mjs：本文件的作用就是「在能 import 任何
 * 东西之前把源码释放出来」，所以它不能依赖被释放的源码。
 */
function dataRoot() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--runtime-dir');
  if (i !== -1 && argv[i + 1]) return path.resolve(argv[i + 1]);
  const fromEnv = process.env.AC_RUNTIME_DIR;
  if (fromEnv && fromEnv.trim()) return path.resolve(fromEnv.trim());
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'AgileCampus');
  }
  return path.join(os.homedir(), '.agilecampus');
}

/** pid 还在吗。EPERM 算「在」——进程存在，只是我无权给它发信号。 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/** `.tmp-<hash>-<pid>` 形态。 */
function isTmpName(name) {
  return name.startsWith('.tmp-');
}

/**
 * **纯函数**：给定 engine 目录下的一层条目，算出该删哪些、该留哪些。
 * 不做任何 I/O —— 目录列表、认领内容、pid 存活都由调用方喂进来（`isAlive` 也是）。
 *
 * 这么做是为了让这台机器上最不能出错的一段逻辑**可以被直接测**：
 * boot.cjs 只跑在打包后的 exe 里，没有这一步它就只能靠「跑一遍 exe 看看」来验。
 *
 * 判据（保守优先，每一条都宁可留着）：
 *   · 当前版本                        → 留
 *   · `.tmp-*` 且写它的 pid 还活着     → 留（别人正在释放）
 *   · `.tmp-*` 且 pid 已死/解析不出    → 删
 *   · 有认领且认领的 pid 还活着        → 留
 *   · 有认领但 pid 已死                → 删（上次没退干净）
 *   · 没有认领（本次改动之前留下的）    → 只有**放够 7 天**才删
 *
 * 最后一条为什么是 7 天而不是立刻：没有认领文件说明那个目录是**旧版本 exe** 释放的，
 * 而旧版本进程可能**此刻还在跑**。它随时可能 `await import('./lib/nodebin.mjs')`
 * （panel.mjs 里就有这么一处懒加载），把那目录删掉会让它当场 ERR_MODULE_NOT_FOUND。
 * 7 天是「还活着的概率已经可以忽略」的界线，而一个 engine 目录只有 ~400 KB，
 * 留着的代价远小于误删的代价。
 *
 * @param {{name: string, mtimeMs: number, claim: {pid?: number}|null}[]} entries
 * @param {{currentHash: string, isAlive: (pid: number) => boolean, now: number,
 *          unclaimedMaxAgeMs?: number, tmpMaxAgeMs?: number}} opts
 * @returns {{remove: string[], keep: {name: string, why: string}[]}}
 */
function planEnginePrune(entries, opts) {
  const { currentHash, isAlive, now } = opts;
  const unclaimedMaxAgeMs = opts.unclaimedMaxAgeMs ?? UNCLAIMED_MAX_AGE_MS;
  const tmpMaxAgeMs = opts.tmpMaxAgeMs ?? TMP_MAX_AGE_MS;
  const remove = [];
  const keep = [];

  for (const e of entries || []) {
    const name = String(e.name);
    const mtimeMs = Number(e.mtimeMs) || 0;
    const claimPid = e.claim && Number.isInteger(e.claim.pid) ? e.claim.pid : null;

    if (name === currentHash) {
      keep.push({ name, why: '当前版本' });
      continue;
    }
    if (isTmpName(name)) {
      // 名字尾部的 pid 是**写它那个进程**的。还活着就说明释放进行中。
      const m = /-(\d+)$/.exec(name);
      const pid = m ? Number(m[1]) : null;
      if (pid && isAlive(pid)) {
        keep.push({ name, why: `正在被 PID ${pid} 释放` });
        continue;
      }
      if (!pid && now - mtimeMs < tmpMaxAgeMs) {
        keep.push({ name, why: '解析不出 pid 的临时目录，刚建不久' });
        continue;
      }
      remove.push(name);
      continue;
    }
    if (claimPid) {
      if (isAlive(claimPid)) {
        keep.push({ name, why: `正被 PID ${claimPid} 使用` });
        continue;
      }
      remove.push(name);
      continue;
    }
    if (now - mtimeMs < unclaimedMaxAgeMs) {
      keep.push({ name, why: '无人认领，但还没放够时间' });
      continue;
    }
    remove.push(name);
  }

  return { remove, keep };
}

/**
 * 把内嵌资源释放到 <root>\engine\<内容哈希>\。
 *
 * 用**内容哈希**当目录名，于是：exe 换了版本就自动换一个目录（同一版本重复启动是
 * 零写入的快速路径）。先写临时目录再 rename，避免别的进程撞见一个只写了一半的 engine。
 *
 * 旧版本目录**不再永远留着**——见 pruneEngines / planEnginePrune。
 */
function extractAssets(root) {
  const keys = sea.getAssetKeys();
  if (!keys.length) throw new Error('exe 里没有内嵌任何资源，打包配置可能有误。');

  const files = keys.map((k) => [k, sea.getAsset(k, 'utf8')]);
  const h = crypto.createHash('sha256');
  for (const [k, v] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    h.update(k);
    h.update('\0');
    h.update(String(Buffer.byteLength(v)));
    h.update('\0');
    h.update(v);
    h.update('\n');
  }
  const hash = h.digest('hex').slice(0, 16);

  const engineRoot = path.join(root, 'engine');
  const dest = path.join(engineRoot, hash);
  const stamp = path.join(dest, '.ok');
  if (fs.existsSync(stamp)) return dest;

  const tmp = path.join(engineRoot, `.tmp-${hash}-${process.pid}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  for (const [k, v] of files) {
    const target = path.join(tmp, k);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, v, 'utf8');
  }
  fs.writeFileSync(path.join(tmp, '.ok'), hash, 'utf8');
  fs.mkdirSync(engineRoot, { recursive: true });
  try {
    fs.renameSync(tmp, dest);
  } catch (e) {
    // 另一个进程抢先释放了同一版本 —— 用它那份就好
    fs.rmSync(tmp, { recursive: true, force: true });
    if (!fs.existsSync(stamp)) throw e;
  }
  return dest;
}

/**
 * 在这份 engine 目录上盖个「我在用」的戳，进程正常退出时抹掉。
 *
 * 为什么需要它：光看目录是分不出「某个进程正在用这份源码」和「这是一份没人要的旧
 * 副本」的——而 panel.mjs 里有一处**运行期**的 `await import('./lib/nodebin.mjs')`，
 * 把正在被用的目录删掉会让那个进程当场炸掉。有认领文件才能安全地删。
 *
 * 进程被强杀时这个文件会留下，那没关系：认领里记着 pid，下次启动时
 * `pidAlive` 一查就知道它已经是陈旧的，照样能删。
 */
function claimEngine(dest, hash) {
  const file = path.join(dest, CLAIM_FILE);
  try {
    fs.writeFileSync(file, JSON.stringify({ hash, pid: process.pid, at: Date.now() }), 'utf8');
    process.once('exit', () => {
      try {
        fs.rmSync(file, { force: true });
      } catch {}
    });
  } catch (e) {
    // 认领失败只是「这份目录暂时删不掉」，绝不该影响启动
    console.error(`[engine] 写认领文件失败（不影响启动）：${e.message}`);
  }
}

/** 清掉 engine 目录下没人用的旧版本。删不掉的留着，绝不抛。 */
function pruneEngines(root, currentHash) {
  const engineRoot = path.join(root, 'engine');
  let dirents;
  try {
    dirents = fs.readdirSync(engineRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const entries = [];
  for (const d of dirents) {
    if (!d.isDirectory()) continue;
    const abs = path.join(engineRoot, d.name);
    let mtimeMs = 0;
    try {
      mtimeMs = fs.statSync(abs).mtimeMs;
    } catch {}
    let claim = null;
    try {
      claim = JSON.parse(fs.readFileSync(path.join(abs, CLAIM_FILE), 'utf8'));
    } catch {}
    entries.push({ name: d.name, mtimeMs, claim: claim && Number.isInteger(claim.pid) ? claim : null });
  }

  const { remove } = planEnginePrune(entries, {
    currentHash,
    isAlive: pidAlive,
    now: Date.now(),
  });

  for (const name of remove) {
    const abs = path.join(engineRoot, name);
    try {
      fs.rmSync(abs, { recursive: true, force: true });
      console.log(`[engine] 已清掉旧版本 ${name}`);
    } catch (e) {
      // Windows 上删不掉通常意味着有进程正占着那几个文件。留着就是了——
      // 下次启动还会再试一遍，而强行删一个正在被用的目录会毁掉那个进程。
      console.log(`[engine] 旧版本 ${name} 暂删不掉（${e.code || e.message}），留着下次再试`);
    }
  }
}

/** 释放 → 认领 → 清理旧版本 → 交给 main.mjs。**只允许在 exe 里跑。** */
async function runFromExe() {
  const root = dataRoot();
  const engine = extractAssets(root);
  claimEngine(engine, path.basename(engine));
  pruneEngines(root, path.basename(engine));
  // 让被释放的源码知道自己在哪，也便于 --selftest 打印出来对照
  process.env.AC_ENGINE_DIR = engine;
  await import(pathToFileURL(path.join(engine, 'main.mjs')).href);
}

// 分发。判据顺序刻意是「先看是不是 exe」，不是「先看是不是被 require」：
// 在 SEA 里 require.main 是什么形态没有保证，而 isSea() 是确定的。
// 万一判断反了，被 require 只是多导出几个纯函数，误判的另一侧却是启动器根本不启动。
const isSeaEnv = Boolean(sea && typeof sea.isSea === 'function' && sea.isSea());

if (isSeaEnv) {
  runFromExe().catch((e) => {
    console.error('启动失败：', (e && (e.stack || e.message)) || e);
    process.exit(1);
  });
} else if (require.main === module) {
  console.error('boot.cjs 只能在打包后的 exe 里运行。开发时请直接 `node main.mjs`。');
  process.exit(2);
} else {
  // 被验证器 require：只把函数交出去，绝不启动任何东西。
  // planEnginePrune / pruneEngines 是这里最要紧的两个——boot.cjs 平时只跑在 exe 里，
  // 没有这条出口，那段「删错一次就会毁掉一个正在运行的进程」的逻辑就只能靠人工验。
  module.exports = { planEnginePrune, pruneEngines, claimEngine, dataRoot, pidAlive, isTmpName, CLAIM_FILE };
}
