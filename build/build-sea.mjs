// 打包成单个 exe：SEA 引导 + 内嵌源码。
//
// 流水线只有四步，因为**不需要 esbuild**：面板源码以 ESM 原样作为资源内嵌，
// 由 boot.cjs 释放到运行目录后再 import()。被编译成 CJS 的只有 boot.cjs 自己，
// 而它是手写的 CJS，本来就不需要转。
//
//   1. 资源门禁：verify-ui 检查每个 HTML（界面坏了就不该打包）
//   2. node --experimental-sea-config  生成 blob
//   3. 复制一份 node.exe 当宿主
//   4. postject 注入
//
// 用法：node build/build-sea.mjs
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');

/** 不进 exe 的东西：构建产物、依赖、以及只服务于 folder 模式的脚本。 */
const SKIP_TOP = new Set(['node_modules', 'dist', 'build', '.git', 'engine']);
const SKIP_FILE = new Set(['boot.cjs', 'package.json', 'package-lock.json', 'start.cmd', 'README.md']);

/** 需要内嵌的资源：跑起来要用到的源码与页面。 */
function collectAssets() {
  const out = {};
  const add = (rel) => {
    const abs = path.join(ROOT, rel);
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) out[rel.split(path.sep).join('/')] = abs;
  };
  const walk = (relDir) => {
    const absDir = path.join(ROOT, relDir);
    let entries;
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relDir ? path.join(relDir, e.name) : e.name;
      if (e.isDirectory()) {
        if (!relDir && SKIP_TOP.has(e.name)) continue;
        walk(rel);
      } else if (!SKIP_FILE.has(e.name)) {
        add(rel);
      }
    }
  };
  add('main.mjs');
  add('panel.mjs');
  add('hub.mjs');
  walk('lib');
  add(path.join('ui', 'index.html'));
  add(path.join('hub-ui', 'index.html'));
  return out;
}

/** 跑一条命令，失败就把输出原样抛出来——打包失败时的沉默最难查。 */
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', windowsHide: true, ...opts });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
}

/** 第 1 步：资源门禁。界面坏了就不该被打进 exe。 */
function uiGate(assets) {
  const verifier = path.join(ROOT, 'verify-ui.mjs');
  if (fs.existsSync(verifier)) {
    for (const rel of Object.keys(assets)) {
      if (!rel.endsWith('.html')) continue;
      const r = spawnSync(process.execPath, [verifier, path.join(ROOT, rel)], { stdio: 'inherit', windowsHide: true });
      if (r.status !== 0) throw new Error(`界面检查未通过：${rel}`);
    }
  }
  // verify-ui 只数 report() 的调用点，看不懂「一个属性读的是谁」—— 中枢页那次
  // h.projects.length 的崩溃它一个字都报不出来（那是 render() 第 5 行，后面整段
  // 画卡片的代码因此从没执行过）。所以中枢页要额外跑一遍**真的执行渲染**的冒烟测试。
  const renderCheck = path.join(ROOT, 'verify-hub-render.mjs');
  if (assets['hub-ui/index.html'] && fs.existsSync(renderCheck)) {
    run(process.execPath, [renderCheck]);
  }
  // 端口 → 派生数据的不变式横跨三个文件（panel.json / .env / projects.json），而且它
  // 漂移起来是**静默**的：界面一片正常，只有应用连不上库时才发作。这个验证器的纯层
  // 不碰网络也不碰磁盘，所以在任何构建机上都能跑，就该在门禁里跑。它的文件层
  // （--data-root）需要一份真实部署，只由人手动跑。
  const portCheck = path.join(ROOT, 'verify-ports.mjs');
  if (fs.existsSync(portCheck)) run(process.execPath, [portCheck]);
  // 子进程的 PATH。这条不变式同样横跨多个文件（deploy / process / pg / dbdoctor 各
  // 自拼一份），而且**在开发机上永远看不出问题**：从 git-bash 启动时 PATH 这个变量的
  // 键名就是 `PATH`，从 Explorer / cmd 启动时是 `Path`，而 `{...process.env}` 是普通
  // 对象，`env.PATH` 读不到后者——整条 PATH 被丢掉，npm 的 postinstall 全灭。
  // 它已经真的打穿过一次「首次部署」，所以进闸。
  const childEnvCheck = path.join(ROOT, 'verify-childenv.mjs');
  if (fs.existsSync(childEnvCheck)) run(process.execPath, [childEnvCheck]);
  // 「面板在不在」与「面板答不答话」必须分成两个判断。合成一个的话，面板忙着跑
  // npm ci 时中枢会把「忙」误报成「没开」（卡片闪一下），还会去起第二个面板撞端口。
  // 它起一个真的只监听、永不应答的进程来当那只忙碌的面板，所以能真的验到。
  const panelStateCheck = path.join(ROOT, 'verify-panelstate.mjs');
  if (fs.existsSync(panelStateCheck)) run(process.execPath, [panelStateCheck]);
  // 部署用的那份子进程环境。它上一次坏掉时，界面上的结论指向 registry，
  // 而真相是六个 postinstall 找不到 node —— 所以它进闸，且必须真起 cmd.exe 验。
  const preflightCheck = path.join(ROOT, 'verify-preflight.mjs');
  if (fs.existsSync(preflightCheck)) run(process.execPath, [preflightCheck]);
  // 收编的旧部署清盘。它错起来是**不可逆**的：清单里多写一个目录名（比如 `logs`），
  // 用户点一下「删除并清盘」，中枢自己的 hub.log / hub.lock / projects.json /
  // engine/ 就没了，而且现场一声不响——注册表正是被删掉的文件之一。这个验证器在
  // 临时目录里造一份「数据根里长着旧部署、中枢自己也在用」的现场，纯磁盘操作，
  // 不碰网络也不碰用户的数据根，所以在任何构建机上都能跑。
  const legacyCheck = path.join(ROOT, 'verify-legacypurge.mjs');
  if (fs.existsSync(legacyCheck)) run(process.execPath, [legacyCheck]);
  // exe 释放出来的 engine 目录。清理它本身很容易，难的是**分清「有人正在用」和
  // 「没人要的旧副本」**——panel.mjs 里有一处运行期的 `await import('./lib/nodebin.mjs')`，
  // 删错一个正在跑的进程的 engine 目录，那个进程会当场 ERR_MODULE_NOT_FOUND。
  // 所以它进闸：判据里每一条「宁可留着」的理由都得有用例钉着。
  const engineCheck = path.join(ROOT, 'verify-engine.mjs');
  if (fs.existsSync(engineCheck)) run(process.execPath, [engineCheck]);
  // 「全部停止并退出面板」。它出事的样子最气人：页面 6 秒后无条件说「面板已退出」，
  // 中枢那边却一直显示运行中——因为那处手写的 job 空壳会让 stopPortable 的 Promise
  // 永不 settle，面板卡在 await 上再也退不出去。这个验证器先证明空壳确实会挂住
  // （反证），再证明真 Job 不会，顺带钉住「护栏的拒绝必须留痕」那条。
  const shutdownCheck = path.join(ROOT, 'verify-shutdown.mjs');
  if (fs.existsSync(shutdownCheck)) run(process.execPath, [shutdownCheck]);
}

function main() {
  const assets = collectAssets();
  const names = Object.keys(assets).sort();
  console.log(`内嵌资源 ${names.length} 个：`);
  for (const n of names) console.log(`  ${n}`);
  if (!names.includes('main.mjs') || !names.includes('ui/index.html')) {
    throw new Error('资源清单不完整：至少需要 main.mjs 与 ui/index.html。');
  }

  uiGate(assets);

  fs.mkdirSync(DIST, { recursive: true });

  // 第 2 步：生成准备 blob。
  const seaConfig = {
    main: path.join(ROOT, 'boot.cjs'),
    output: path.join(DIST, 'sea-prep.blob'),
    disableExperimentalSEAWarning: true,
    useSnapshot: false,
    // ⚠️ 必须是 false。Node 文档明写「import() does not work when useCodeCache is true」，
    // 而 boot.cjs 的全部工作就是 import() 释放出来的 main.mjs。
    useCodeCache: false,
    assets,
  };
  const cfgPath = path.join(DIST, 'sea-config.json');
  fs.writeFileSync(cfgPath, JSON.stringify(seaConfig, null, 2), 'utf8');
  console.log('\n生成 SEA blob …');
  run(process.execPath, ['--experimental-sea-config', cfgPath]);

  // 第 3 步：拿一份 node.exe 当宿主。blob 与宿主必须**同版本**。
  const exe = path.join(DIST, 'ac-launcher.exe');
  fs.copyFileSync(process.execPath, exe);
  console.log(`已复制宿主 ${process.execPath}（${(fs.statSync(exe).size / 1048576).toFixed(0)} MB）`);

  // 第 4 步：注入。哨兵 fuse 是 postject 定位注入点的方式，所有平台都要给；
  // --macho-segment-name 只在 macOS 需要，win32 传了反而出错。
  console.log('注入 blob …');
  // 注入后 node.exe 原本的 Authenticode 签名会失效（预期内，postject 会就此告警）。
  // 本机跑没问题；拷到别的机器可能触发 SmartScreen，也可能被杀软误伤。
  const injectArgs = [
    exe,
    'NODE_SEA_BLOB',
    path.join(DIST, 'sea-prep.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ];
  // 直接跑 postject 的 JS 入口，而不是 node_modules\.bin\postject.cmd —— 后者必须
  // 过 shell，参数不转义（Node 会就此发 DEP0190 告警），那是个真实但没必要的注入面。
  const postjectCli = path.join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js');
  if (fs.existsSync(postjectCli)) {
    run(process.execPath, [postjectCli, ...injectArgs]);
  } else {
    console.log('（未找到本地 postject，改用 npx。装它：npm i -D postject）');
    run('npx', ['--yes', 'postject', ...injectArgs], { shell: process.platform === 'win32' });
  }

  console.log(`\n完成：${exe}`);
  console.log('自检：');
  run(exe, ['--selftest', '--repo', process.argv[2] || path.join(ROOT, '..', 'agilecampus-master')]);
}

main();
