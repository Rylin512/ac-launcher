#!/usr/bin/env node
// 守「面板在不在」与「面板答不答话」是**两个问题**这条不变式。
//
//   node verify-panelstate.mjs
//
// 为什么需要它：这两件事曾经被合成一个判据（锁 + pid 存活 + 1.5 秒内应答
// /api/state），于是中枢每 2 秒轮询一次就有一次机会把「忙」误报成「没开」：
//
//   • 卡片闪「面板：未打开」，详情里还谎报「锁陈旧（进程已不在）」；
//   • 点「打开控制面板」会去起第二个面板，而端口被第一个占着，必然起不来。
//
// 而面板是单线程的，正在跑 npm ci / 构建 / 刷大段日志时 1.5 秒不回话是**常态**。
// 所以判据必须分层：panelProcess 管「在不在」，livePanel 才管「答不答话」。
//
// 这里最关键的一条是「忙碌面板」：它起一个**真的在监听但永不应答 HTTP** 的进程当
// 面板——这正是 npm ci 期间那个面板的样子。少了它，这个文件就分不出「分层修好了」
// 和「压根没测到东西」。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathsFor } from './lib/config.mjs';
import { panelProcess, livePanel, readPanelLock } from './lib/registry.mjs';
import { pidAlive } from './lib/sysinfo.mjs';

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures += 1;
    console.log('  ✕ ' + name + (extra ? '\n      ' + extra : ''));
  }
};
const sec = (t) => console.log('\n' + t);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-panelstate-'));
const children = [];
const cleanup = () => {
  for (const c of children) {
    try {
      c.kill();
    } catch {
      // 已经自己退了
    }
  }
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    // 临时目录，删不掉也不影响结论
  }
};

/** 一个「只监听、永不应答」的 TCP 服务 —— npm ci 期间那个面板就是这个样子。 */
function startSilentServer() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      // 收到连接就晾着，一个字都不回。httpProbe 会一直等到超时。
      sock.on('error', () => {});
    });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/** 造一个项目路径对象，只用到 lockFile。 */
const pathsOf = (dir, repoDir = null) => pathsFor(dir, repoDir);

try {
  const projDir = path.join(root, 'proj');
  fs.mkdirSync(path.join(projDir, 'run'), { recursive: true });
  const P = pathsOf(projDir, path.join(root, 'repo'));

  sec('没有锁：两个判断都得是「没有」，且不许抛');
  {
    ok('panelProcess → null', panelProcess(P) === null);
    ok('livePanel → null', (await livePanel(P)) === null);
  }

  sec('坏锁 / 半截锁不该被当成在跑');
  {
    // 半截 JSON 正是面板**非原子写锁文件**时可能留下的东西。中枢每 2 秒读一次，
    // 撞上它就会闪一下「未打开」——所以面板那边改成了 tmp+rename 原子写。
    fs.writeFileSync(P.lockFile, '{"pid": 1234, "po', 'utf8');
    ok('半截 JSON：panelProcess → null 且不抛', panelProcess(P) === null);
    fs.writeFileSync(P.lockFile, JSON.stringify({ port: 1234 }), 'utf8');
    ok('缺 pid 的锁：panelProcess → null', panelProcess(P) === null);
  }

  sec('死 pid：锁还在、进程不在 —— 这**就是** staleLock 的定义');
  {
    // 起一个立刻退出的进程，拿它那个已经死掉的 pid。这比手写 99999 可靠：它保证
    // 这个 pid 刚刚还有主，不是「碰巧不存在」。
    const dead = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true });
    ok('拿到一个刚刚死掉的 pid', Number.isInteger(dead.pid) && !pidAlive(dead.pid));
    fs.writeFileSync(P.lockFile, JSON.stringify({ pid: dead.pid, port: 1 }), 'utf8');
    ok('panelProcess → null（pid 死了就是没在跑）', panelProcess(P) === null);
    ok('但锁文件读得出来（中枢据此置 staleLock）', readPanelLock(P)?.pid === dead.pid);
    ok('livePanel 同样是 null', (await livePanel(P)) === null);
  }

  sec('忙碌面板：**在跑**，但答不上话 —— 分层的关键用例');
  {
    const { srv, port } = await startSilentServer();
    children.push({ kill: () => srv.close() });
    // 用**本进程**当那个「面板」：pid 活着，端口在监听，但没人应 HTTP。
    fs.writeFileSync(P.lockFile, JSON.stringify({ pid: process.pid, port }), 'utf8');

    const proc = panelProcess(P);
    ok('panelProcess 认得出它在跑（锁 + pid 活）', Boolean(proc) && proc.port === port);

    const t0 = Date.now();
    const live = await livePanel(P);
    const spent = Date.now() - t0;
    ok('livePanel → null：它确实没应答', live === null);
    // 这一条是「上面那个 null 不是因为它没在跑」的证据：真探过、真等过。
    ok('而且是真的等到了探针超时（不是立刻返回）', spent >= 1000, `只花了 ${spent}ms，说明没走探针`);
  }

  sec('反证：只判锁不判 pid 的话，死锁会被当成在跑');
  {
    const dead = spawnSync(process.execPath, ['-e', '0'], { windowsHide: true });
    fs.writeFileSync(P.lockFile, JSON.stringify({ pid: dead.pid, port: 1 }), 'utf8');
    // 修复前的形状（panel.mjs 的 findRunningPanel 只判锁）：
    const naive = readPanelLock(P) !== null;
    ok('「锁在就算在跑」确实会被死锁骗到（所以要核对 pid）', naive === true);
    ok('而 panelProcess 没被骗到', panelProcess(P) === null);
  }

  sec('调用点：中枢问「在不在」时用的必须是 panelProcess');
  {
    // 函数写对了但调用点没改，等于没改。projectState 里那一次是闪烁的正主，
    // openProject 的复用判据是「忙时点打开会起第二个面板」的正主。
    // 统一成 LF 再切函数体：Windows 上 core.autocrlf=true 检出的是 CRLF，
    // 下面那句 `indexOf('\n}\n')` 一个都找不到，于是整份文件都算进 projectState，
    // 顺带扫到别处的 livePanel 调用，构建门禁就永远红。
    const hub = fs
      .readFileSync(path.join(import.meta.dirname, 'hub.mjs'), 'utf8')
      .replace(/\r\n/g, '\n');
    const body = (name) => {
      const i = hub.indexOf(`function ${name}(`);
      if (i === -1) return '';
      // 粗略切到下一个顶层 }（这些函数都在模块顶层，缩进从 0 开始）
      const j = hub.indexOf('\n}\n', i);
      return hub.slice(i, j === -1 ? hub.length : j);
    };
    const stateBody = body('projectState');
    const openBody = body('openProject');
    ok('projectState 用 panelProcess，不再用 livePanel', /panelProcess\(/.test(stateBody) && !/livePanel\(/.test(stateBody));
    ok('openProject 的**复用**判据是 panelProcess', /panelProcess\(/.test(openBody));
    // 等新面板就绪那一步必须留着应答语义，否则会把没 listen 的地址交给用户
    ok('openProject 等就绪那一步仍在用 livePanel', /livePanel\(/.test(openBody));
    ok('删项目前的守卫也是 panelProcess（别让卡住的面板活着被清盘）', /panelProcess\(P\)\) return fail\(res, 409/.test(hub));
  }
} finally {
  cleanup();
}

console.log('');
if (failures) {
  console.log('✕ ' + failures + ' 项失败。');
  process.exit(1);
}
console.log('✓ 面板状态：「在不在」看进程，「答不答话」才看探针，两者不混用。');
