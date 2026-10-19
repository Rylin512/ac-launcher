#!/usr/bin/env node
// 守「交给子进程的环境里，node 一定跑得起来」这条不变式。
//
//   node verify-childenv.mjs
//
// 为什么需要它：`{ ...process.env }` 是**普通对象**，属性查找区分大小写，而 Windows
// 上 PATH 这个变量的键名是 `Path`（注册表里就是这么写的）。于是
//
//     env.PATH = `${P.pgBin};${env.PATH || ''}`
//
// 里那个 `env.PATH` 读到的是 undefined —— 整条继承来的 PATH 被丢掉，只剩 pgsql 的
// bin。子进程再也找不到 node，而 npm 的 postinstall 里有五处裸 `node xxx`
// （esbuild ×3、sharp、msw、unrs-resolver），于是「首次部署」在 npm ci 这一步全灭。
//
// **这个 bug 在开发机上永远复现不了**：从 git-bash 启动时键名恰好是 `PATH`
// （MSYS 显式设的），一切正常。只有从 Explorer / cmd.exe 起的才中招 —— 而那正是
// 用户双击 start.cmd 的方式。所以这个文件必须自己**构造** `Path` 大小写的环境来测，
// 不能依赖跑它的人碰巧用的哪个 shell。
//
// 最后一条用例是关键：它真的起一个 cmd.exe 去执行 `node -v`，也就是 npm 在
// postinstall 里做的那件事。「PATH 字符串看着对」和「子进程真能找到 node」不是同一句话。
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { withPath } from './lib/nodebin.mjs';

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures += 1;
    console.log('  ✕ ' + name + (extra ? '\n      ' + extra : ''));
  }
};
const sec = (t) => console.log('\n' + t);

/** 造一个「Windows 原生大小写」的环境：PATH 那个键叫 `Path`。 */
const nativeEnv = (pathValue) => ({ Path: pathValue, SystemRoot: process.env.SystemRoot || 'C:\\Windows' });
/** 造一个 git-bash 风格的环境：键名是大写 `PATH`。 */
const msysEnv = (pathValue) => ({ PATH: pathValue, SystemRoot: process.env.SystemRoot || 'C:\\Windows' });

const pathsOf = (env) => Object.keys(env).filter((k) => k.toUpperCase() === 'PATH');
const valueOf = (env) => env[pathsOf(env)[0]];
const parts = (env) => String(valueOf(env)).split(path.delimiter).filter(Boolean);

const SENTINEL = path.join('C:', 'sentinel-not-a-real-dir');

sec('键名大小写：两种情况都必须保住继承来的 PATH');
for (const [label, make] of [['`Path`（Windows 原生）', nativeEnv], ['`PATH`（git-bash）', msysEnv]]) {
  const env = withPath(make(`${SENTINEL};C:\\Windows\\System32`), null, 'C:\\pg\\bin');
  ok(`${label}：继承来的目录一个都没丢`, parts(env).includes(SENTINEL) && parts(env).includes('C:\\Windows\\System32'), valueOf(env));
  ok(`${label}：pg 的 bin 被加进去了`, parts(env).includes('C:\\pg\\bin'), valueOf(env));
  ok(`${label}：PATH 只剩一个键（不会同时存在 Path 与 PATH）`, pathsOf(env).length === 1, JSON.stringify(pathsOf(env)));
}

sec('node 自己所在的目录必须进 PATH（便携版 / --node 都不在任何 PATH 上）');
{
  // 跑这个脚本的 node 就是 nodeExe(null) 在 folder 模式下会解析到的那个
  // （非 SEA 时回退到 process.execPath），所以它的目录正是期望值。
  const want = path.dirname(process.execPath);
  const env = withPath(nativeEnv('C:\\Windows\\System32'), null, 'C:\\pg\\bin');
  ok('node 目录排在最前', parts(env)[0] === want, `期望 ${want}，实际 ${parts(env)[0]}`);
  ok('pg 的 bin 排在它后面', parts(env).indexOf('C:\\pg\\bin') === 1, valueOf(env));
}

sec('边界情况不炸');
{
  const env = withPath({ Path: '' }, null, null, undefined);
  ok('PATH 为空串时不抛，且至少还有 node 目录', parts(env).length >= 1, JSON.stringify(env));
  const env2 = withPath({}, null, 'C:\\pg\\bin');
  ok('env 里根本没有 PATH 时也能建出键来', parts(env2).includes('C:\\pg\\bin'), JSON.stringify(env2));
}
{
  // 解析不出 Node 时（例如 SEA 模式下找不到真 Node）不能抛 —— 抛出去等于又制造
  // 一次「PATH 被清空」，比原来的 bug 还糟。
  const env = withPath(nativeEnv(`${SENTINEL};C:\\Windows\\System32`), null, 'C:\\pg\\bin', {});
  ok('withPath 不因为 Node 解析失败而抛', parts(env).includes(SENTINEL), valueOf(env));
}
{
  const env = withPath(nativeEnv(`C:\\A;C:\\a;C:\\B`), null);
  const dup = parts(env).filter((p) => p.toLowerCase() === 'c:\\a').length;
  ok('Windows 上大小写不同但同一个目录只留一个', dup === 1, JSON.stringify(parts(env)));
}

sec('真实子进程：cmd.exe 里跑得起来 node（这就是 npm postinstall 干的事）');
{
  // 这一条是全部用例里唯一真正证明问题的。前面那些只说明 PATH 字符串拼对了；
  // 用户遇到的是「cmd.exe 说 'node' 不是内部或外部命令」。
  const env = withPath(nativeEnv(process.env.Path || process.env.PATH || 'C:\\Windows\\System32'), null);
  const r = spawnSync('cmd.exe', ['/d', '/s', '/c', 'node -v'], { env, encoding: 'utf8', windowsHide: true });
  ok(
    'cmd.exe 里跑得起来 node（这正是 postinstall 失败的样子）',
    r.status === 0 && /^v\d+\./.test(String(r.stdout).trim()),
    `status=${r.status} stdout=${JSON.stringify(String(r.stdout || '').trim())} stderr=${JSON.stringify(String(r.stderr || '').trim())}`
  );

  // 反证：用**修复前**的写法（env.PATH = ...），原生大小写下必然失败。
  // 少了这一条，上面那条用例在「bug 已经修好」和「这个测试根本没在测东西」
  // 之间分不出来。
  const broken = nativeEnv('C:\\Windows\\System32');
  broken.PATH = 'C:\\pg\\bin;' + (broken.PATH || '');
  const r2 = spawnSync('cmd.exe', ['/d', '/s', '/c', 'node -v'], { env: broken, encoding: 'utf8', windowsHide: true });
  ok(
    '反证：修复前的写法在原生大小写下确实找不到 node',
    r2.status !== 0 || !/^v\d+\./.test(String(r2.stdout || '').trim()),
    `反证没失败——说明这个环境里另有东西提供 node，本文件其余断言的说服力要打折：status=${r2.status} stdout=${JSON.stringify(String(r2.stdout || '').trim())}`
  );
}

sec('buildEnv 真的走了 withPath（不是「函数写对了但没人用」）');
{
  // withPath 单测再全，只要调用点还用着老写法就一点用没有 —— 这个文件存在的
  // 全部理由就是那个调用点。所以这里直接问 buildEnv 要结果。
  const { buildEnv } = await import('./lib/deploy.mjs');
  const env = buildEnv({ pgBin: 'C:\\pg\\bin' }, {});
  const keys = pathsOf(env);
  ok('buildEnv 之后 PATH 仍只有一个键', keys.length === 1, JSON.stringify(keys));
  ok('buildEnv 的结果里有 node 目录', parts(env).includes(path.dirname(process.execPath)), valueOf(env).slice(0, 200));
  ok('buildEnv 的结果里有 pgsql 的 bin', parts(env).includes('C:\\pg\\bin'), valueOf(env).slice(0, 200));
  ok('buildEnv 仍然把监督令牌摘掉了（别为了修 PATH 把这个弄丢）', env.AC_SUPERVISOR_TOKEN === undefined && env.AC_HUB === undefined);
  ok('buildEnv 仍然删掉了 NODE_ENV（否则装不到 devDependencies）', env.NODE_ENV === undefined);
}

console.log('');
if (failures) {
  console.log('✕ ' + failures + ' 项失败。');
  process.exit(1);
}
console.log('✓ 子进程环境：node 在其 PATH 上一定可用（大小写两种键名都验过）。');
