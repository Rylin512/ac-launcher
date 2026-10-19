#!/usr/bin/env node
// 守 exe 释放出来的 engine 目录：**该清的清掉，正在用的一个都不许动**。
//
//   node verify-engine.mjs
//
// 背景：exe 每次换一个版本就把源码释放到 <数据根>\engine\<内容哈希>\，而它**只写不删**，
// 于是目录越堆越多（2026-09-28 时是 7 份、2.8 MB）。清掉它们看起来是纯赚，但这里有一条
// 真的会伤到人的边界：
//
//   panel.mjs 里有一处**运行期**的 `await import('./lib/nodebin.mjs')`。
//   把一个**正在运行**的进程的 engine 目录删掉，那个进程会当场 ERR_MODULE_NOT_FOUND。
//
// 光看目录是分不出「有人正在用」和「这是没人要的旧副本」的，所以引入了认领文件
// （<engine>\<hash>\.inuse，内容 {hash,pid,at}）。这个验证器守的就是那套判据：
// 每一条**宁可留着**的理由都有对应用例，删错的那一侧则由最后那条「绝不越界」兜着。
//
// boot.cjs 平时只跑在打包后的 exe 里（`node boot.cjs` 会直接拒绝），所以它把纯函数
// 与 pruneEngines 都导出来给这里用——见文件底部那段分发的注释。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const boot = require('./boot.cjs');

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures += 1;
    console.log('  ✕ ' + name + (extra ? '\n      ' + extra : ''));
  }
};
const sec = (t) => console.log('\n' + t);
const ROOT = import.meta.dirname;
const DAY = 24 * 60 * 60 * 1000;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-engine-'));
const cleanup = () => {
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
};

try {
  sec('require boot.cjs 不该做任何事（它必须只在 exe 里启动）');
  {
    ok('拿到了纯函数', typeof boot.planEnginePrune === 'function' && typeof boot.pruneEngines === 'function');
    ok('没建任何目录', fs.readdirSync(tmp).length === 0, fs.readdirSync(tmp).join(','));
    ok('认领文件名是 engine 目录里的隐藏文件', boot.CLAIM_FILE === '.inuse');
  }

  const plan = (entries, opts = {}) =>
    boot.planEnginePrune(entries, {
      currentHash: opts.currentHash ?? 'cur',
      isAlive: opts.isAlive ?? (() => false),
      now: opts.now ?? 1_800_000_000_000,
      ...opts,
    });
  const NOW = 1_800_000_000_000;

  sec('判据：每一条「宁可留着」');
  {
    let r = plan([{ name: 'cur', mtimeMs: NOW, claim: { pid: 999999 } }], { currentHash: 'cur' });
    ok('当前版本永远留（哪怕认领它的进程已经不在了）', r.remove.length === 0 && /当前版本/.test(r.keep[0].why));

    r = plan([{ name: 'a', mtimeMs: NOW, claim: { pid: 111 } }], { isAlive: (p) => p === 111 });
    ok('认领者还活着 → 留', r.remove.length === 0 && /PID 111/.test(r.keep[0].why), JSON.stringify(r));

    r = plan([{ name: 'x', mtimeMs: NOW, claim: null }]);
    ok('无人认领但**刚建不久** → 留（这是旧版本 exe 可能在跑的那一类）', r.remove.length === 0, JSON.stringify(r));
    ok('理由说得清是「还没放够时间」', /还没放够/.test(r.keep[0].why), r.keep[0].why);

    r = plan([{ name: '.tmp-abc-4242', mtimeMs: NOW, claim: null }], { isAlive: (p) => p === 4242 });
    ok('释放进行中的临时目录 → 留', r.remove.length === 0 && /PID 4242/.test(r.keep[0].why), JSON.stringify(r));
  }

  sec('判据：该清的');
  {
    let r = plan([{ name: 'old', mtimeMs: NOW, claim: { pid: 222 } }], { isAlive: () => false });
    ok('认领者已不在 → 删（上次没退干净）', r.remove.join() === 'old', JSON.stringify(r));

    r = plan([{ name: 'ancient', mtimeMs: NOW - 8 * DAY, claim: null }]);
    ok('无人认领且放了 8 天 → 删', r.remove.join() === 'ancient', JSON.stringify(r));

    r = plan([{ name: '.tmp-abc-333', mtimeMs: NOW, claim: null }], { isAlive: () => false });
    ok('临时目录、pid 已死 → 删', r.remove.join() === '.tmp-abc-333', JSON.stringify(r));

    r = plan([{ name: '.tmp-weird', mtimeMs: NOW - 2 * DAY, claim: null }]);
    ok('临时目录、名字里没有 pid 且已放 2 天 → 删', r.remove.join() === '.tmp-weird', JSON.stringify(r));
  }

  sec('边界：无人认领的宽限期必须够长（它是唯一挡着「删掉在跑的进程」的那道闸）');
  {
    const src = fs.readFileSync(path.join(ROOT, 'boot.cjs'), 'utf8');
    const m = /UNCLAIMED_MAX_AGE_MS\s*=\s*([^;]+);/.exec(src);
    ok('找得到那个常量', Boolean(m), m && m[1]);
    ok('至少 24 小时', /24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(m ? m[1] : ''), m && m[1]);
    ok('而且远长于一个部署的生命周期（7 天）', /7\s*\*\s*24/.test(m ? m[1] : ''), m && m[1]);
    // 边界两侧各来一发。
    const fresh = plan([{ name: 'p', mtimeMs: NOW - 6 * DAY, claim: null }]);
    const stale = plan([{ name: 'q', mtimeMs: NOW - 7 * DAY - 1000, claim: null }]);
    ok('6 天前留下的：留', fresh.remove.length === 0, JSON.stringify(fresh));
    ok('7 天零 1 秒前的：删', stale.remove.join() === 'q', JSON.stringify(stale));
  }

  sec('真磁盘：在一份真的 engine 目录上跑 pruneEngines');
  {
    const root = path.join(tmp, 'data');
    const engineRoot = path.join(root, 'engine');
    const dead = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true }).pid;
    ok('拿到一个刚刚死掉的 pid', Number.isInteger(dead) && !boot.pidAlive(dead));

    const mk = (hash, { claim = null, ageMs = 0 } = {}) => {
      const d = path.join(engineRoot, hash);
      fs.mkdirSync(d, { recursive: true });
      fs.writeFileSync(path.join(d, 'main.mjs'), '// ' + hash);
      if (claim) fs.writeFileSync(path.join(d, boot.CLAIM_FILE), JSON.stringify(claim));
      if (ageMs) {
        const t = new Date(Date.now() - ageMs);
        fs.utimesSync(d, t, t);
      }
      return d;
    };
    const cur = mk('cur', { claim: { pid: process.pid } }); // 本进程认领 = 正在用
    const live = mk('live', { claim: { pid: process.pid } });
    const deadOne = mk('dead', { claim: { pid: dead } });
    const ancient = mk('ancient', { ageMs: 8 * DAY });
    const fresh = mk('fresh');
    const tmpDead = path.join(engineRoot, `.tmp-zzz-${dead}`);
    fs.mkdirSync(tmpDead, { recursive: true });
    // engine/ 之外的邻居：删错它就是「顺手删掉用户别的东西」
    const neighbour = path.join(root, 'projects.json');
    fs.writeFileSync(neighbour, '{"projects":[]}');

    boot.pruneEngines(root, 'cur');

    ok('当前版本还在', fs.existsSync(path.join(cur, 'main.mjs')));
    ok('另一个进程正在用的目录还在', fs.existsSync(path.join(live, 'main.mjs')));
    ok('认领者已死的那个被清掉了', !fs.existsSync(deadOne));
    ok('放了 8 天、无人认领的被清掉了', !fs.existsSync(ancient));
    ok('刚建、无人认领的还在（不赌「没认领就是没人用」）', fs.existsSync(path.join(fresh, 'main.mjs')));
    ok('pid 已死的临时目录被清掉了', !fs.existsSync(tmpDead));
    ok('engine/ 之外的邻居一字未动', fs.readFileSync(neighbour, 'utf8') === '{"projects":[]}');
    ok('engine/ 目录本身还在', fs.existsSync(engineRoot));

    sec('认领文件：写得出、退出时抹得掉');
    {
      const d = path.join(tmp, 'claimtest');
      fs.mkdirSync(d, { recursive: true });
      boot.claimEngine(d, 'abcd1234');
      const c = JSON.parse(fs.readFileSync(path.join(d, boot.CLAIM_FILE), 'utf8'));
      ok('写下了 pid 与 hash', c.pid === process.pid && c.hash === 'abcd1234', JSON.stringify(c));
      // 退出时抹掉这一条靠的是 process.once('exit')，验证器还在跑，这里只证明它注册过。
      ok('注册了退出钩子（进程不走正常退出时留着也没关系——pid 一查就是陈旧的）', process.listenerCount('exit') >= 1);
    }
  }

  sec('调用顺序：先认领、再清理（顺序反了就会把自己的目录当成无人认领的）');
  {
    const src = fs.readFileSync(path.join(ROOT, 'boot.cjs'), 'utf8');
    // 找**调用**而不是函数名：定义一定在前面，拿名字找会永远通过。
    const iClaim = src.indexOf('claimEngine(engine, path.basename(engine))');
    const iPrune = src.indexOf('pruneEngines(root, path.basename(engine))');
    ok('两个调用都在', iClaim !== -1 && iPrune !== -1);
    ok('claimEngine 在 pruneEngines 之前', iClaim !== -1 && iPrune !== -1 && iClaim < iPrune);
    // 而且清理时把当前 hash 排除在外——双保险，认领文件写失败也不会误删自己
    const body = src.slice(src.indexOf('function planEnginePrune'), src.indexOf('function extractAssets'));
    ok('planEnginePrune 里显式排除当前版本', /name === currentHash/.test(body));
  }

  sec('删不掉时必须忍着（Windows 上正在被占用的目录删不掉）');
  {
    const src = fs.readFileSync(path.join(ROOT, 'boot.cjs'), 'utf8');
    const body = src.slice(src.indexOf('function pruneEngines'), src.indexOf('async function runFromExe'));
    ok('rmSync 包在 try 里', /try\s*\{[\s\S]*?rmSync[\s\S]*?\}\s*catch/.test(body));
    ok('删失败只是打印一行，不抛', /暂删不掉|catch \(e\)/.test(body) && !/throw/.test(body));
    ok('列目录失败也不抛（engine/ 还不存在时就是这条路）', /readdirSync[\s\S]*?\}\s*catch\s*\{[\s\S]*?return/.test(body));
  }
} finally {
  cleanup();
}

console.log('');
if (failures) {
  console.log('✕ ' + failures + ' 项失败。');
  process.exit(1);
}
console.log('✓ engine 目录：旧的会清掉，正在用的、以及 engine/ 之外的东西一个都不碰。');
