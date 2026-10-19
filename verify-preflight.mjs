#!/usr/bin/env node
// 守「部署用的那份子进程环境是可用的，坏了自己会补回来」这条不变式。
//
//   node verify-preflight.mjs
//
// 背景：「首次部署」真的栽过一次——六个 postinstall 全报「'node' 不是内部或外部命令」，
// 而界面上给出的结论是「依赖安装失败，可能是网络问题」。根因（PATH 被自己写丢）
// 已经修了，但那一类故障的性质是「结论指向别处 + 要跑完几分钟才撞上」。所以有了
// lib/preflight.mjs：会自愈的 PATH + 长任务开跑前真起 cmd.exe 验一次。
//
// 这个文件里最有说服力的两条，都是**真起子进程**跑出来的：
//   · 把环境弄坏（PATH 里没有系统目录）→ `cmd.exe /c node -v` 必须失败（反证）
//   · 同一份坏环境走一遍 buildEnv → 必须能跑起来（证明自愈真的救回来了）
// 只断言「PATH 字符串里有 C:\Windows\system32」是不够的：那只是拼对了字面量。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathsFor } from './lib/config.mjs';
import { checks, healEnv, logChecks, missingSystemDirs, nodeRunsIn, pathDirs, registryPathDirs } from './lib/preflight.mjs';
import { buildEnv } from './lib/deploy.mjs';
import { FIXES, FIX_ORDER } from './lib/dbdoctor.mjs';

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures += 1;
    console.log('  ✕ ' + name + (extra ? '\n      ' + extra : ''));
  }
};
const sec = (t) => console.log('\n' + t);
const WIN = process.platform === 'win32';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-preflight-'));
const P = pathsFor(path.join(root, 'proj'), path.join(root, 'repo'));
fs.mkdirSync(P.runDir, { recursive: true });

/** PATH 的键名（这台机器上是 Path 还是 PATH，随启动方式而变）。 */
const pathKeyOf = (env) => Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
const realPath = () => process.env[pathKeyOf(process.env)] || '';

try {
  sec('系统目录检测：哪些才算「缺」');
  {
    const sys = [path.join(process.env.SystemRoot || 'C:\\Windows', 'system32')];
    ok('一份带着系统目录的 PATH：不缺', missingSystemDirs({ Path: `${sys[0]};C:\\Windows` }).length === 0);
    const miss = missingSystemDirs({ Path: 'C:\\pg\\bin' });
    ok('只有 pgsql 的 bin：系统目录全判为缺', miss.length >= 2, JSON.stringify(miss));
    const missCase = missingSystemDirs({ Path: `${sys[0].toUpperCase()};${(process.env.SystemRoot || 'C:\\Windows').toUpperCase()}` });
    ok('大小写不同不算缺（Windows 的 PATH 不区分大小写）', missCase.length === 0, JSON.stringify(missCase));
  }

  sec('从注册表读一份可信的 PATH（进程自己那份正可能坏掉，问它等于自证）');
  if (WIN) {
    const dirs = registryPathDirs();
    ok('reg query 真读到了东西', dirs.length > 0, `读到 ${dirs.length} 条`);
    // `%DevEco Studio%` 这种是**真的存在**的：变量在本机没定义，Windows 展开不了，
    // 于是注册表里就留着这么一条死目录。留着它是对的（原样照搬 Windows 的行为），
    // 所以断言只要求「要么像个路径，要么是个没展开的 %引用%」。
    const odd = dirs.filter((d) => !/^[A-Za-z]:\\|^\\\\|^%[^%]+%/.test(d));
    ok('每一条要么是路径，要么是没展开的 %引用%', odd.length === 0, JSON.stringify(odd));
    // REG_EXPAND_SZ 存的是没展开的原文，必须自己展开一遍——本机上真的有一条
    // `%DevEco Studio%`，不展开就是一条死目录。
    ok('已知变量必须展开掉（不残留 %SystemRoot% 之类）', !dirs.some((d) => /%SystemRoot%/i.test(d)), JSON.stringify(dirs.filter((d) => /%/.test(d))));
    // 只作记录，不作断言：没展开的引用是注册表自己的事，不是缺陷
    const unexpanded = dirs.filter((d) => /%/.test(d));
    if (unexpanded.length) console.log(`    · 注册表里有 ${unexpanded.length} 条没展开的引用（本机没有那个变量）：${unexpanded.join('、')}`);

    // PATH 坏掉时**仍然要读得到注册表**。这一条是踩出来的：裸 'reg' 靠 PATH 解析，
    // 而 PATH 正是坏的那个——自愈会当场退化成「注册表读不到」，正好在最需要它的时候失效。
    const k = pathKeyOf(process.env);
    const saved = process.env[k];
    delete process.env[k];
    try {
      ok('PATH 里什么都没有时，reg query 仍然读得到（工具要走绝对路径）', registryPathDirs().length > 0);
    } finally {
      process.env[k] = saved;
    }
  } else {
    ok('非 Windows：跳过（这个项目只跑 Windows）', true);
  }

  sec('自愈：只增不减 —— 好的环境一个字节都不许动');
  {
    const good = { Path: `C:\\Windows\\System32;C:\\Windows;${path.dirname(process.execPath)}` };
    const before = good.Path;
    const notes = [];
    healEnv(good, P, notes);
    ok('好的环境：PATH 逐字节未变', good.Path === before, `${before}\n      → ${good.Path}`);
    ok('好的环境：不产生任何说明（没做就是没做）', notes.length === 0, JSON.stringify(notes));
  }
  {
    // 「上游把它弄坏了」的样子：只剩一个 pgsql bin。这正是用户那次部署的实际形态。
    const broken = { Path: 'C:\\pg\\bin' };
    const notes = [];
    healEnv(broken, P, notes);
    const dirs = pathDirs(broken);
    ok('坏环境：原来那条 C:\\pg\\bin 还在（只增不减）', dirs.includes('C:\\pg\\bin'));
    ok('坏环境：系统目录补上了', missingSystemDirs(broken).length === 0, JSON.stringify(dirs));
    ok('坏环境：node 自己的目录补上了', dirs.includes(path.dirname(process.execPath)), JSON.stringify(dirs.slice(0, 4)));
    ok('坏环境：说明里写清了「补了什么、为什么」', notes.length === 1 && /系统目录/.test(notes[0]), JSON.stringify(notes));
    ok('坏环境：PATH 仍然只有一个键（别补出个 Path + PATH 来）', Object.keys(broken).filter((k) => k.toUpperCase() === 'PATH').length === 1);
  }

  sec('决定性的一条：真起 cmd.exe 跑 node -v（npm 的 postinstall 就是这么干的）');
  if (WIN) {
    const healed = { Path: 'C:\\pg\\bin' };
    const counter = nodeRunsIn({ Path: 'C:\\pg\\bin' });
    ok('反证：坏环境里跑不起来 node（否则这个文件证明不了任何事）', !counter.ok, JSON.stringify(counter));
    // 报出来的原因必须是「node 找不到」，不能是「cmd.exe 找不到」——后者说明检查
    // 自己都没跑起来，那样报出来的 fail 是假的（工具走的是绝对路径就是为了这个）。
    ok('失败原因是「找不到 node」，不是「起不了 cmd.exe」', /node/i.test(counter.detail) && !/cmd\.exe/i.test(counter.detail), JSON.stringify(counter.detail));

    healEnv(healed, P);
    const after = nodeRunsIn(healed);
    ok('同一份坏环境走完自愈：跑得起来了', after.ok, JSON.stringify(after));
    ok('跑出来的是个版本号', /^v\d+\./.test(String(after.version || '')), JSON.stringify(after.version));

    const good = nodeRunsIn({ Path: realPath(), SystemRoot: process.env.SystemRoot });
    ok('真实 PATH（未自愈）本来就能跑起来', good.ok, JSON.stringify(good));
  } else {
    ok('非 Windows：跳过', true);
  }

  sec('buildEnv 真的会自愈（不是「函数写对了但没人用」）');
  {
    // 把**本进程**的 PATH 换成坏的那个样子，再让 buildEnv 去继承它——这就是用户
    // 那次的实际链路：坏 PATH 从上游传下来，部署拿它去跑 npm ci。
    const key = pathKeyOf(process.env);
    const saved = process.env[key];
    delete process.env[key];
    process.env.Path = 'C:\\pg\\bin';
    try {
      const notes = [];
      const env = buildEnv(P, {}, notes);
      ok('buildEnv 的结果里有系统目录', missingSystemDirs(env).length === 0, JSON.stringify(pathDirs(env).slice(0, 4)));
      ok('buildEnv 的结果里 node 目录在最前', pathDirs(env)[0] === path.dirname(process.execPath), pathDirs(env)[0]);
      ok('buildEnv 把自愈这件事说出来了（静默自愈是另一种撒谎）', notes.length === 1, JSON.stringify(notes));
      const run = nodeRunsIn(env);
      ok('拿 buildEnv 的结果能跑起 node —— 这是那次部署失败的完整复现与修复', run.ok, JSON.stringify(run));
      ok('监督令牌仍然被摘掉（别为了修 PATH 把这个弄丢）', env.AC_SUPERVISOR_TOKEN === undefined && env.AC_HUB === undefined);
    } finally {
      // 复原：这个进程接下来还要 spawn 子进程，PATH 不能留着坏的
      delete process.env.Path;
      process.env[key] = saved;
    }
    ok('本进程的 PATH 已复原', process.env[pathKeyOf(process.env)] === saved);
  }

  sec('预检清单：格式与「检修」一致，且坏环境会被判 fail');
  {
    const goodEnv = buildEnv(P, {});
    const list = checks(P, goodEnv);
    ok('清单非空', list.length >= 4, JSON.stringify(list.map((c) => c.id)));
    ok('每一项都有 id/title/level/detail（dbdoctor 的 add() 就吃这个形状）', list.every((c) => c.id && c.title && c.level && c.detail));
    ok('level 只用约定里的四种值', list.every((c) => ['ok', 'warn', 'fail', 'skip'].includes(c.level)), JSON.stringify(list.map((c) => c.level)));
    ok('好环境里没有 fail', list.filter((c) => c.level === 'fail').length === 0, JSON.stringify(list.filter((c) => c.level === 'fail')));
    ok('fixId 只指向真实存在的修复项', list.every((c) => c.fixId === null || Boolean(FIXES[c.fixId])), JSON.stringify(list.map((c) => c.fixId)));

    // 坏环境（未自愈）必须被判出问题：node 那条 fail，系统目录那条 warn
    const bad = checks(P, { Path: 'C:\\pg\\bin' });
    const byId = Object.fromEntries(bad.map((c) => [c.id, c]));
    ok('坏环境：`env-node` 判 fail（PATH 里没有 node 的目录）', byId['env-node'].level === 'fail', JSON.stringify(byId['env-node']));
    ok('坏环境：`env-sysdirs` 判 warn', byId['env-sysdirs'].level === 'warn', JSON.stringify(byId['env-sysdirs']));
    if (WIN) ok('坏环境：真跑那一条也判 fail 且说得出「这就是部署失败的样子」', byId['env-node-run'].level === 'fail' && /部署/.test(byId['env-node-run'].detail), JSON.stringify(byId['env-node-run']));

    const lines = [];
    logChecks({ line: (lvl, text) => lines.push(`${lvl}|${text}`) }, bad);
    ok('logChecks 把 fail 走 err 通道（界面才会标红）', lines.some((l) => l.startsWith('err|✗')), JSON.stringify(lines));
  }

  sec('接进「检修」：修复项、顺序、以及真的被诊断出来');
  {
    ok('FIXES 里有 env-path', Boolean(FIXES['env-path']));
    ok('它不丢数据（destructive: false）', FIXES['env-path']?.destructive === false);
    ok('FIX_ORDER 里它排在第一个（环境坏了，后面的修复自己也起不来）', FIX_ORDER[0] === 'env-path', JSON.stringify(FIX_ORDER));
    const doctor = fs.readFileSync(path.join(import.meta.dirname, 'lib', 'dbdoctor.mjs'), 'utf8');
    ok('diagnose 会把这批检查拼进去', /for \(const c of envChecks\(P, buildEnv\(P, cfg\)\)\)/.test(doctor));
    ok('repair 有 env-path 的分支', /id === 'env-path'/.test(doctor));
  }

  sec('预检真的挡在长任务前面（deployAll / rebuildAll）');
  {
    const deploy = fs.readFileSync(path.join(import.meta.dirname, 'lib', 'deploy.mjs'), 'utf8');
    for (const fn of ['deployAll', 'rebuildAll']) {
      const i = deploy.indexOf(`export async function ${fn}(`);
      const j = deploy.indexOf('\n}\n', i);
      const body = deploy.slice(i, j);
      const p = body.indexOf('preflight(P, cfg, job)');
      const s = body.indexOf('job.step(0)');
      ok(`${fn}：预检存在且排在第一步之前`, p !== -1 && s !== -1 && p < s, `preflight@${p} step(0)@${s}`);
    }
    ok('预检失败会抛错（不是只打印一行就继续）', /ENV_PREFLIGHT_FAILED/.test(deploy));
  }
} finally {
  for (const f of [P.lockFile, P.configFile]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {}
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {}
}

console.log('');
if (failures) {
  console.log('✕ ' + failures + ' 项失败。');
  process.exit(1);
}
console.log('✓ 子进程环境：坏的会被补回来，补不回来的会在 npm ci 之前就说清楚。');
