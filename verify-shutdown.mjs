#!/usr/bin/env node
// 守「退出面板」这条路：**它必须真的退出**，以及护栏的拒绝必须留痕。
//
//   node verify-shutdown.mjs
//
// 这个文件来自 2026-09-28 的一次真实故障：用户在面板上点「全部停止并退出面板」，
// 页面 6 秒后无条件换成「面板已退出」，而中枢那边一直显示「面板运行中」。
//
// 根因是一处**手写的 job 空壳**（panel.mjs 的 shutdown 分支）：
//
//   await pg.stopPortable(P, cfg, { log: () => {}, stepDetail: () => {}, lines: [] });
//
// 它缺 line() 与 flush()，后果分成两段：
//   · 库没在监听时，stopPortable 一进来就 `job.line(...)` 抛「job.line is not a function」
//     ——数据库**根本没被停**（日志里留着一行，但没人在意）；
//   · 库在监听时，spawnInto 收尾的 `job.flush()` 抛在 'close' 回调里、**在 resolve 之前**
//     ——那个 Promise 永不 settle，shutdown 分支永远卡在 await 上，**面板再也不会退出**。
//
// 于是就有了那个自相矛盾的现场。lib/jobs.mjs 的 detachedJob 注释里早写着这个坑，
// panel.mjs:899 是它唯一的漏网调用点。
//
// 为什么要有**反证**：「空壳会挂住」这一条是整件事的机理，不把它钉住，这个验证器
// 就分不清「修好了」和「压根没走到那段」。所以先证明空壳确实会挂，再证明真 Job 不会。
//
// 另外两条不变式也是这次故障的产物：
//   · 护栏的 onLog 从第一天起就在签名里、两个调用点也都传了 log，却**从没被调用过**
//     ——所以那次点击被 403 挡在门外时，日志里一个字都没留。现在它必须留痕，
//     而且**绝不能把令牌写进日志**。
//   · 全仓库不许再出现第二种手写的 job 空壳。
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathsFor } from './lib/config.mjs';
import { stopPortable, initCluster, startPortable } from './lib/pg.mjs';
import { detachedJob } from './lib/jobs.mjs';
import { createGuard } from './lib/http.mjs';
import { recordStarted } from './lib/process.mjs';
import { tcpReachable, waitForPort, pidAlive } from './lib/sysinfo.mjs';

/** 端到端那一层。要起进程、占端口、起真库，所以不进打包门禁。 */
const E2E = process.argv.includes('--e2e');

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
const ROOT = import.meta.dirname;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-shutdown-'));
const sockets = new Set();
const cleanup = () => {
  for (const s of sockets) {
    try {
      s.destroy();
    } catch {}
  }
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
};

/**
 * 一个只接**一次**连接的 TCP 服务，然后就不监听了。
 *
 * 那一次连接就是 stopPortable 开头的 `tcpReachable` 探活：它必须成功（否则会走
 * 「已经不在监听，无需停止」那条捷径，压根到不了 spawnInto，也就测不到这个 bug）。
 * 接完就撤，让后面等端口释放那一步几毫秒内就成功——整个验证器因此只花一两秒。
 */
function listenOnce() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer((sock) => {
      sockets.add(sock);
      sock.on('error', () => {});
      sock.on('close', () => sockets.delete(sock));
      srv.close();
    });
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

/** 手写的 job 空壳 —— 修复前 panel.mjs 喂给 stopPortable 的就是这个形状。 */
const fakeShell = { log() {}, stepDetail() {}, lines: [] };

try {
  // ---------------------------------------------------------------- 护栏留痕
  sec('护栏拒绝必须留痕（onLog 曾经是个从不被调用的参数）');
  {
    const TOKEN = 'good-token-0123456789abcdef';
    const logged = [];
    const guard = createGuard({
      getPort: () => 1234,
      tokens: new Set([TOKEN]),
      onLog: (m) => logged.push(String(m)),
    });
    const mkRes = () => {
      const r = { codes: [], bodies: [] };
      r.writeHead = (c) => {
        r.codes.push(c);
        return r;
      };
      r.end = (b) => {
        if (b !== undefined) r.bodies.push(String(b));
      };
      return r;
    };
    const mkReq = (headers, method = 'POST', url = '/api/ops/shutdown') => ({
      method,
      url,
      headers: { host: '127.0.0.1:1234', ...headers },
    });

    let res = mkRes();
    ok('没有令牌 → 拒绝', guard(mkReq({ origin: 'http://127.0.0.1:1234' }), res) === null && res.codes[0] === 403);
    ok('而且**写了日志**（这正是那次故障缺的那一句）', logged.length === 1, JSON.stringify(logged));
    ok('日志里说得清是哪种拒绝', /没有带令牌/.test(logged[0] || ''), logged[0]);
    ok('日志里有方法、路径', /POST/.test(logged[0] || '') && /\/api\/ops\/shutdown/.test(logged[0] || ''));

    logged.length = 0;
    res = mkRes();
    guard(mkReq({ origin: 'http://127.0.0.1:1234', 'x-ac-token': 'stale-token-from-an-old-page' }), res);
    ok('令牌不匹配 → 也写日志', logged.length === 1 && /令牌不匹配/.test(logged[0] || ''), JSON.stringify(logged));
    ok('并指出「页面可能是旧的」这个可操作的结论', /刷新|旧/.test(logged[0] || ''), logged[0]);

    logged.length = 0;
    res = mkRes();
    guard(mkReq({ origin: 'http://127.0.0.1:1234', 'x-ac-token': TOKEN }), res);
    ok('令牌对但 Content-Type 不对 → 415 且留痕', res.codes[0] === 415 && logged.length === 1, JSON.stringify([res.codes, logged]));

    logged.length = 0;
    res = mkRes();
    const u = guard(mkReq({ origin: 'http://127.0.0.1:1234', 'x-ac-token': TOKEN, 'content-type': 'application/json' }), res);
    ok('一切正常 → 放行，且**不写日志**（否则每次操作都刷一行噪音）', Boolean(u) && logged.length === 0, JSON.stringify(logged));

    logged.length = 0;
    guard(mkReq({ host: '127.0.0.1:1234' }, 'GET', '/api/state'), mkRes());
    ok('GET 不需要令牌、也不留痕（面板每 2 秒轮询一次，留痕会淹掉日志）', logged.length === 0, JSON.stringify(logged));

    logged.length = 0;
    guard(mkReq({ origin: 'http://evil.example', 'x-ac-token': TOKEN, 'content-type': 'application/json' }), mkRes());
    ok('跨源 Origin → 拒绝且留痕', logged.length === 1 && /Origin/.test(logged[0] || ''), JSON.stringify(logged));

    logged.length = 0;
    guard(mkReq({ host: 'evil.example:1234', 'x-ac-token': TOKEN, 'content-type': 'application/json' }), mkRes());
    ok('Host 不是本机 → 拒绝且留痕', logged.length === 1, JSON.stringify(logged));

    const all = logged.join(' ');
    ok('日志里**绝不出现令牌值**', !all.includes(TOKEN) && !all.includes('stale-token-from-an-old-page'), all);
  }

  // ---------------------------------------------------------------- 那处空壳
  const rt = path.join(tmp, 'rt');
  fs.mkdirSync(path.join(rt, 'run'), { recursive: true });
  fs.mkdirSync(path.join(rt, 'pgsql', 'bin'), { recursive: true });
  const P = pathsFor(rt, path.join(tmp, 'repo'));
  // 故意**不**造 pg_ctl：spawn 直接 ENOENT，正好走到我们要的那条路上——
  // spawnInto 的 'error' 回调 → `done()` → `job.flush()`。空壳缺的就是这个方法，
  // 它抛在 resolve 之前，所以 Promise 永远不 settle。这就是那次故障的机理本身。
  ok('pg_ctl 不存在（这正是这次要测的收尾路径）', !fs.existsSync(P.pgCtl));

  const { port } = await listenOnce();
  const cfg = { pgPort: port, dbMode: 'portable' };

  sec('反证：喂一个手写空壳 —— 它确实会永远挂住（修复前就是这个形状）');
  {
    ok('空壳缺的正是 line/flush', typeof fakeShell.line !== 'function' && typeof fakeShell.flush !== 'function');
    // 面板进程里有个 uncaughtException 兜底（日志里那行「未捕获异常」就是它写的），
    // 所以那次抛错没有把面板带走——它**活着**，只是永远卡在 await 上。要复现「活着
    // 但卡死」这个状态，这里也得先把这个兜底装上，否则验证器自己会被炸掉。
    const caught = [];
    const swallow = (e) => caught.push(e);
    process.on('uncaughtException', swallow);
    let r;
    try {
      r = await Promise.race([
        stopPortable(P, cfg, fakeShell).then(
          () => 'settled',
          (e) => 'rejected:' + e.message
        ),
        sleep(3000).then(() => 'timeout'),
      ]);
    } finally {
      process.off('uncaughtException', swallow);
    }
    ok(
      '抛的正是 job.flush is not a function（与故障当天面板日志里那行一模一样）',
      caught.some((e) => /job\.flush is not a function/.test(e && e.message)),
      caught.map((e) => e && e.message).join(' | ')
    );
    ok('而它抛在 resolve 之前 —— Promise 3 秒内没有 settle（面板因此永不退出）', r === 'timeout', `实际：${r}`);
  }

  sec('修复：换成真 Job —— 一定会 settle');
  {
    const { port: port2 } = await listenOnce();
    const cfg2 = { pgPort: port2, dbMode: 'portable' };
    const j = detachedJob('shutdown-db-stop', '停止数据库', ['停止']);
    ok('真 Job 有 line/flush', typeof j.line === 'function' && typeof j.flush === 'function');
    j.step(0);
    const t0 = Date.now();
    const r = await Promise.race([
      stopPortable(P, cfg2, j).then(
        (v) => ({ how: 'settled', v }),
        (e) => ({ how: 'rejected', v: e.message })
      ),
      sleep(20000).then(() => ({ how: 'timeout' })),
    ]);
    ok('settle 了（面板这才可能退出）', r.how === 'settled', JSON.stringify(r));
    ok('而且很快', Date.now() - t0 < 15000, `花了 ${Date.now() - t0}ms`);
    ok('返回了正常结果', r.v && r.v.stopped === true, JSON.stringify(r.v));
    ok('step/日志都在真的 Job 上（不再是丢进黑洞）', j.lines.length >= 0 && j.steps[0].status !== 'pending');
  }

  // ---------------------------------------------------------------- 接线
  sec('调用点：退出路径必须是「真 Job + 硬超时兜底」');
  {
    const src = fs.readFileSync(path.join(ROOT, 'panel.mjs'), 'utf8');
    const i = src.indexOf("case 'shutdown':");
    const j = src.indexOf("case 'open':", i);
    const body = i === -1 ? '' : src.slice(i, j === -1 ? src.length : j);
    ok('找得到 shutdown 分支', body.length > 0);
    ok('停止数据库用的是 detachedJob（真 Job）', /detachedJob\(/.test(body));
    ok('不再有手写空壳的指纹', !/stepDetail:\s*\(\s*\)\s*=>\s*\{\s*\}/.test(body));
    ok('有硬超时兜底', /SHUTDOWN_DEADLINE_MS/.test(body) && /clearTimeout\(deadline\)/.test(body));
    ok('超时时照实说「可能还在运行」，不假装停干净了', /可能仍在运行/.test(src));
    ok('退出前会点名正在跑的任务（否则用户不知道自己的部署被中止了）', /正在进行，退出会中止它/.test(body));
  }

  // ------------------------------------------------- 做完才回话 + 页面不许再撒谎
  /** 把注释涂成空格。源码级断言必须看真代码，不能看注释里引用的旧写法。 */
  const mask = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, ' ')).replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  sec('响应顺序：做完才回话 —— 面板一消失，页面就只剩这一条证据了');
  {
    const src = fs.readFileSync(path.join(ROOT, 'panel.mjs'), 'utf8');
    const i = src.indexOf("case 'shutdown':");
    const j = src.indexOf("case 'open':", i);
    const body = i === -1 ? '' : mask(src.slice(i, j === -1 ? src.length : j));
    const iJson = body.indexOf('json(res, 200, Object.assign({ ok: true }, outcome))');
    const iApp = body.indexOf('await stopApp(P, cfg');
    const iDb = body.indexOf('await pg.stopPortable(P, cfg, j)');
    ok('两个停止动作都还在', iApp !== -1 && iDb !== -1);
    ok('结果响应排在两个停止动作**之后**', iJson !== -1 && iJson > iApp && iJson > iDb, `json@${iJson} app@${iApp} db@${iDb}`);
    ok('响应里带着真实结果，而不是一句「已受理」',
      /outcome\.stoppedApp\s*=/.test(body) && /outcome\.stoppedDb\s*=/.test(body) && /outcome\.errors\.push/.test(body));
    ok('页面重复点击有保护（否则会并发停两次）', /stopAllInFlight/.test(body));
    ok('硬超时兜底仍在，且它到点时**照实说**可能没停干净',
      /SHUTDOWN_DEADLINE_MS/.test(body) && /可能仍在运行/.test(body));

    // 反证：**修复前**的「抢先回话」形状必须被判为不合格 —— 否则上面那条什么也没证明。
    const before = mask(`case 'shutdown': {
      json(res, 200, { ok: true });
      await stopApp(P, cfg, () => {});
      await pg.stopPortable(P, cfg, job);
    }`);
    const bJson = before.indexOf('json(res, 200');
    ok('反证：修复前那种「先回话、再干活」的顺序会被这条判据判为不合格',
      bJson !== -1 && bJson < before.indexOf('await stopApp'), `json@${bJson}`);
  }

  sec('日志不再撒谎：退出那句话由调用方按**事实**给');
  {
    const src = fs.readFileSync(path.join(ROOT, 'panel.mjs'), 'utf8');
    ok('shutdown() 接受一句话，而不是自己写死一句', /function shutdown\(note = /.test(mask(src)));
    ok('退出前那句话是按真实结果拼的，且不喊成功也不讳言失败',
      /面板退出（\$\{done\.join/.test(src) && /应用已停止/.test(src) && /应用未能停止/.test(src));
    // `process.on('SIGINT', shutdown)` 会把信号名当成第一个参数传进去 —— 那样日志里
    // 就会出现一行「SIGINT」。这条钉住「包一层再转交」这个写法。
    ok('信号处理器包了一层再转交（信号名不会被当成「做了什么」那句话）',
      /process\.on\('SIGINT', \(\) => shutdown\(/.test(src));
    ok('反证：直接挂 shutdown 的写法会被判为不合格',
      !/process\.on\('SIGINT', \(\) => shutdown\(/.test(mask("process.on('SIGINT', shutdown);")));
  }

  sec('页面：只在**探到**面板不再应答之后才说「已退出」');
  {
    const raw = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
    const ui = mask(raw);

    // 1. 不许再有「定时器到点就宣布退出」——这正是用户看到的那一幕。
    const timerLie = /setTimeout\(\(\)\s*=>\s*\{[\s\S]{0,400}?document\.body\.(innerHTML|replaceChildren)/;
    ok('页面里没有「定时器到点就改写整页」的写法', !timerLie.test(ui));
    // 反证：修复前那三行必须被同一个正则命中，否则上面那条是空转
    ok('反证：该正则在修复前的写法上确实命中',
      timerLie.test("setTimeout(() => {\n  document.body.innerHTML = '<h1>面板已退出</h1>';\n}, 6000);"));

    // 2. 「已退出」这句话必须落在「探到退出了」那个分支里
    const iFn = ui.indexOf('async function shutdownPanel(');
    ok('找得到 shutdownPanel', iFn !== -1);
    const fnBody = iFn === -1 ? '' : ui.slice(iFn, ui.indexOf('\nfunction bind()', iFn));
    const iGuard = fnBody.indexOf('if (!gone) {');
    const iExited = fnBody.indexOf("title.textContent = '面板已退出'");
    ok('「面板已退出」排在「探不到就照实说还在跑」那个分支**之后**',
      iGuard !== -1 && iExited !== -1 && iExited > iGuard, `guard@${iGuard} exited@${iExited}`);
    ok('探不到时必须说「面板仍在运行」', /面板仍在运行/.test(fnBody));

    // 3. 探测本身：网络失败才算退出，主动放弃不算
    const iProbe = ui.indexOf('async function waitUntilPanelGone(');
    ok('找得到探测函数', iProbe !== -1);
    ok('探测走的是真请求（fetch /api/state）', /fetch\('\/api\/state'/.test(ui));
    ok('「主动放弃」与「真的连不上」分开（否则慢一拍的面板会被误判成已退出）',
      /AbortError/.test(ui.slice(iProbe, iFn === -1 ? ui.length : iFn)));

    // 4. 停没停必须来自**结果**，不能是写死的
    ok('「已停止」读的是响应里的 outcome，而不是写死的字符串',
      /outcome\.stoppedApp/.test(fnBody) && /outcome\.stoppedDb/.test(fnBody));
    ok('那句「网站与数据库已停止」已经不在页面里了（它从前是无条件说的）',
      !/网站与数据库已停止/.test(ui));
    ok('拿不到结果时照实说「没能确认」', /没能确认/.test(fnBody));
  }

  sec('全仓库：不许再有第二种手写 job 空壳');
  {
    const files = [];
    const walk = (dir, rel = '') => {
      for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
        if (d.name === 'node_modules' || d.name === 'dist' || d.name === '.git') continue;
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) walk(path.join(dir, d.name), r);
        else if (d.name.endsWith('.mjs') && !/^verify-/.test(d.name)) files.push(r);
      }
    };
    walk(ROOT);
    ok('扫到了源码文件', files.length > 10, String(files.length));
    const bad = files.filter((f) => /stepDetail:\s*\(\s*\)\s*=>\s*\{\s*\}/.test(fs.readFileSync(path.join(ROOT, f), 'utf8')));
    ok('没有任何文件再写这种空壳', bad.length === 0, bad.join(', '));
    // 反证：这个正则在**修复前的形状**上必须命中，否则上面那条什么也没证明
    ok(
      '反证：该正则在空壳的原始写法上确实命中',
      /stepDetail:\s*\(\s*\)\s*=>\s*\{\s*\}/.test(
        'await pg.stopPortable(P, cfg, { log: () => {}, stepDetail: () => {}, lines: [] });'
      )
    );
  }

  // ---------------------------------------------- 停止应用：不在送不出去的请求上白等
  sec('停止应用：不在 Windows 送不出去的请求上白等 8 秒');
  {
    const proc = mask(fs.readFileSync(path.join(ROOT, 'lib/process.mjs'), 'utf8'));
    const i = proc.indexOf('export async function stopApp(');
    const j = proc.indexOf('export async function recordStarted(', i);
    const body = i === -1 ? '' : proc.slice(i, j === -1 ? proc.length : j);
    ok('找得到 stopApp', body.length > 0);
    // `ok` 只认退出码 0。老写法是 `code === 0 || code === 128`，注释说「128 = 进程已不存在」
    // ——**那句话是错的**，而它正是 8 秒空等的源头：一次被拒绝的软杀被当成成功，
    // 调用方于是理直气壮地等一个永远不会发生的结果。下面那组反证就是把这句话钉死。
    const tk = proc.slice(proc.indexOf('async function taskkill('), proc.indexOf('export async function killTree('));
    ok('taskkill 的 ok 只认「请求送达」（退出码 0），128 不再被当成成功',
      /ok:\s*r\.code === 0[,}]/.test(tk) && !/code === 128/.test(tk));
    ok('软杀之后先问「请求送出去了没有」，而不是直接等',
      /const soft = await taskkill\(pid, false\)/.test(body) &&
        /const refused = !soft\.ok && pidAlive\(pid\)/.test(body));
    ok('那 8 秒的等待被 refused 守着（没送出去就一秒都不等）',
      /if \(!refused && \(await waitForPort\(port, false, \{ timeout: 8000/.test(body));
    ok('被拒绝时直说原因，不再把平台拒绝记成「超时」',
      /送不出关闭请求/.test(body) && !/优雅退出超时/.test(proc));
    ok('那句话排在强制终止之前（顺序反了就成了事后解释）',
      body.indexOf('送不出关闭请求') !== -1 &&
        body.indexOf('送不出关闭请求') < body.indexOf('改为强制终止'),
      `原因@${body.indexOf('送不出关闭请求')} 强制@${body.indexOf('改为强制终止')}`);

    // 反证：真去问一次 Windows 答不答应。上面几条只是「源码里写对了」，
    // 这一条证明的是**那 8 秒为什么注定白等** —— 没有它，将来有人把等待加回去，
    // 没有任何东西会拦住他，而现象（只是慢 8 秒）又小到不会被报上来。
    if (process.platform !== 'win32') {
      ok('（非 Windows：没有 taskkill，跳过这条反证）', true);
    } else {
      const spawnVictim = (opt) => {
        const v = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', ...opt });
        v.unref();
        return v;
      };
      const softKill = (v) => spawnSync('taskkill', ['/PID', String(v.pid), '/T'], { windowsHide: true, encoding: 'utf8' });

      // 两种形状都要问：**应用**是 detached + windowsHide 起的（形状甲），
      // 而别的调用点（比如作业里起的子进程）常常只是 windowsHide（形状乙）。
      // 它们的退出码不一样，而老写法只认了其中一种的猜测。
      const a = spawnVictim({ detached: true, windowsHide: true });
      await sleep(1200); // 等它真的起来，否则报的是「找不到进程」而不是「只能强制终止」
      const ra = softKill(a);
      ok('反证（形状甲：detached + 无窗口）：不带 /F 的 taskkill 被拒绝，进程原地不动',
        ra.status !== 0 && pidAlive(a.pid), `退出码 ${ra.status}，存活 ${pidAlive(a.pid)}`);

      const b = spawnVictim({ windowsHide: true });
      await sleep(1200);
      const rb = softKill(b);
      const bAlive = pidAlive(b.pid);
      ok('反证（形状乙：只有 windowsHide）：同样被拒绝，进程同样原地不动',
        rb.status !== 0 && bAlive, `退出码 ${rb.status}，存活 ${bAlive}`);

      // 退出码说明不了任何事：一个**不存在**的 PID 拿到的也是非 0。
      // （本机实测：形状甲 255、形状乙 128、不存在的 PID 128 —— 乙与「不存在」同码，
      //   所以 `128 = 进程已不存在` 那句猜测会正好把乙的**拒绝**读成**已停**。）
      const dead = spawnSync('taskkill', ['/PID', '999999', '/T'], { windowsHide: true, encoding: 'utf8' }).status;
      ok('退出码区分不了「被拒绝」与「不存在」，所以它不能用来判断进程在不在',
        dead !== 0, `不存在的 PID 拿到了 ${dead}，形状甲 ${ra.status}，形状乙 ${rb.status}`);
      ok('（想知道进程在不在，只能问 pidAlive —— 它现在确实说两具都还活着）',
        pidAlive(a.pid) && pidAlive(b.pid));

      for (const v of [a, b]) {
        spawnSync('taskkill', ['/PID', String(v.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      }
      await sleep(400);
      ok('对照组：只有 /F 才结束得来（这正是修复后立刻走的那一步）', !pidAlive(a.pid) && !pidAlive(b.pid));
    }
  }
} finally {
  cleanup();
}

// ========================================================== 端到端

/** 找一个空闲端口。**绝不能用配置里的默认值**——这台机器上真跑着用户的部署。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen({ host: '0.0.0.0', port: 0 }, () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

/** 借用户部署里那套便携版 PostgreSQL 的**二进制**（只执行，不写入）。 */
function findPgsql() {
  const root =
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || '', 'AgileCampus', 'projects')
      : path.join(os.homedir(), '.agilecampus', 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(root);
  } catch {
    return null;
  }
  const exe = process.platform === 'win32' ? 'pg_ctl.exe' : 'pg_ctl';
  for (const d of dirs) {
    const p = path.join(root, d, 'pgsql');
    if (fs.existsSync(path.join(p, 'bin', exe))) return p;
  }
  return null;
}

/**
 * 用户报的那件事本身：**应用和数据库都在跑的时候点「全部停止并退出面板」，
 * 三样（应用、数据库、面板）都得真的停。**
 *
 * 上面那些单元检查测不到这一层——它们只证明「真 Job 会 settle」。而真出问题的是这一层：
 * `pg_ctl` 到底停掉没有、面板到底退出没有、锁与状态文件到底清干净没有。
 * 所以它像 `verify-legacypurge --e2e` 一样**不进打包门禁**（要起进程、占端口、起真库）。
 *
 * 全程在系统临时目录里，用 `--runtime-dir` 指过去，**绝不碰用户的数据根**。
 * 唯一的例外是 PostgreSQL 的二进制：临时根里的 `pgsql\` 是一个**目录联接**指向它，
 * 只用来执行；`pgdata` 落在临时根里。收场时用 `rmdir` 摘掉联接（它只删链接本身），
 * 并且**断言用户那套二进制一个字节没少** —— 万一联接被当成普通目录递归删掉，
 * 那是一次不可逆的事故，所以这里两个动作都做，还要验一遍。
 */
async function e2e() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-shutdown-e2e-'));
  const rt = path.join(base, 'runtime');
  const repo = path.join(base, 'repo');
  const PANEL_PORT = await freePort();
  const APP_PORT = await freePort();
  const PG_PORT = await freePort();
  const BASE = `http://127.0.0.1:${PANEL_PORT}`;
  const kids = [];
  let appKid = null;
  let srcPgsql = null;
  let link = null;

  const killApp = () => {
    if (appKid && pidAlive(appKid.pid)) {
      try {
        spawnSync('taskkill', ['/PID', String(appKid.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } catch {}
    }
  };

  try {
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, 'package.json'), '{"name":"e2e-repo","private":true}', 'utf8');
    for (const d of ['config', 'src', 'node', 'pgdata', 'logs', 'run', 'tmp']) {
      fs.mkdirSync(path.join(rt, d), { recursive: true });
    }
    fs.writeFileSync(
      path.join(rt, 'config', 'panel.json'),
      JSON.stringify(
        {
          repoDir: repo,
          panelPort: PANEL_PORT,
          appPort: APP_PORT,
          pgPort: PG_PORT,
          dbMode: 'portable',
          autoOpenBrowser: false,
          pgPassword: 'e2e-' + Math.random().toString(36).slice(2),
          databaseUrl: '',
        },
        null,
        2
      ),
      'utf8'
    );

    const P = pathsFor(rt, repo);
    const cfg = JSON.parse(fs.readFileSync(P.configFile, 'utf8'));

    sec('端到端：起一个真的便携版数据库 + 一个真的「应用」（全在临时目录里）');
    srcPgsql = findPgsql();
    ok('借得到一套便携版 PostgreSQL 的二进制', Boolean(srcPgsql), '（用户的数据根里没有 projects\\*\\pgsql）');
    if (!srcPgsql) throw new Error('没有可借的 pgsql，跳过端到端');

    link = path.join(rt, 'pgsql');
    const mk = spawnSync('cmd', ['/c', 'mklink', '/J', link, srcPgsql], { windowsHide: true, encoding: 'utf8' });
    ok(
      '建好了目录联接（只借二进制执行，pgdata 落在临时根里）',
      fs.existsSync(path.join(link, 'bin')),
      (mk.stderr || '') + (mk.stdout || '')
    );
    if (!fs.existsSync(path.join(link, 'bin'))) throw new Error('目录联接没建起来，跳过端到端');

    const j1 = detachedJob('e2e-init', '初始化数据簇', ['initdb']);
    j1.step(0);
    await initCluster(P, cfg, j1);
    ok('数据簇建好了（PG_VERSION 在）', fs.existsSync(P.pgVersionFile), P.pgData);

    const j2 = detachedJob('e2e-start-db', '启动数据库', ['启动']);
    j2.step(0);
    await startPortable(P, cfg, j2);
    ok('数据库真的在监听', (await tcpReachable('127.0.0.1', PG_PORT, 1000)).ok, `:${PG_PORT}`);

    appKid = spawn(
      process.execPath,
      ['-e', `require('net').createServer().listen(${APP_PORT},'0.0.0.0');setInterval(()=>{},1000);`],
      { windowsHide: true, stdio: 'ignore' }
    );
    kids.push(appKid);
    const appUp = await waitForPort(APP_PORT, true, { timeout: 15000, interval: 200 });
    ok('「应用」在监听（一个哑进程，但面板认它）', appUp, `:${APP_PORT}`);
    await recordStarted(P, cfg, appKid.pid);
    ok('面板认得出它（run\\app.json 里有 PID）', JSON.parse(fs.readFileSync(P.appStateFile, 'utf8') || 'null')?.pid === appKid.pid);

    sec('起一个真面板，然后点「全部停止并退出面板」');
    const panel = spawn(
      process.execPath,
      [path.join(ROOT, 'main.mjs'), '--repo', repo, '--runtime-dir', rt, '--no-open'],
      { cwd: ROOT, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    kids.push(panel);
    let out = '';
    panel.stdout.on('data', (d) => { out += d; });
    panel.stderr.on('data', (d) => { out += d; });

    // 就绪 = HTTP 通 **且** run\panel.lock 落盘。少等一个就会造出假故障
    // （listen 早于写锁，而面板单线程时这两件事之间可能有几百毫秒）。
    let up = false;
    for (let i = 0; i < 120 && !up; i += 1) {
      try {
        const r = await fetch(BASE + '/api/state');
        if (r.status) up = true;
      } catch {}
      if (!up) await sleep(250);
    }
    ok('面板起来了', up, out.slice(-800));
    if (!up) throw new Error('面板没起来');
    for (let i = 0; i < 40 && !fs.existsSync(P.lockFile); i += 1) await sleep(200);
    ok('run\\panel.lock 已落盘', fs.existsSync(P.lockFile));

    const html = await (await fetch(BASE + '/')).text();
    const m = /\bTOKEN\s*=\s*'([^']+)'/.exec(html);
    ok('页面里注入了令牌', Boolean(m));
    const token = m ? m[1] : '';

    const before = JSON.parse(fs.readFileSync(P.appStateFile, 'utf8'));
    ok('停止之前两样都在跑', before.pid === appKid.pid && (await tcpReachable('127.0.0.1', PG_PORT, 800)).ok);

    const t0 = Date.now();
    const res = await fetch(BASE + '/api/ops/shutdown', {
      method: 'POST',
      headers: { 'x-ac-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ alsoStopApp: true, alsoStopDb: true }),
    });
    const data = await res.json().catch(() => null);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    ok(`响应带回了真实结果（等了 ${secs} 秒）`, Boolean(data && data.ok === true), JSON.stringify(data));
    ok('它说应用停了 —— 而且是真停', data && data.stoppedApp === true, JSON.stringify(data && data.errors));
    ok('它说数据库停了 —— 而且是真停', data && data.stoppedDb === true, JSON.stringify(data && data.errors));
    ok('没有任何一步失败', data && (data.errors || []).length === 0, JSON.stringify(data && data.errors));

    // 面板进程必须**真的退出**。这正是那次故障的核心：它卡在 await 上，再也没退出。
    let gone = false;
    for (let i = 0; i < 150 && !gone; i += 1) {
      gone = !pidAlive(panel.pid);
      if (!gone) await sleep(200);
    }
    ok('面板进程真的退出了', gone, '面板还活着：' + out.slice(-800));
    ok('run\\panel.lock 被清掉了', !fs.existsSync(P.lockFile));
    ok('两个端口都不再有人监听',
      !(await tcpReachable('127.0.0.1', APP_PORT, 800)).ok && !(await tcpReachable('127.0.0.1', PG_PORT, 800)).ok);
    ok('run\\app.json 与 run\\pg.json 都被置空（否则中枢会一直显示旧状态）',
      JSON.parse(fs.readFileSync(P.appStateFile, 'utf8') || 'null') === null &&
        JSON.parse(fs.readFileSync(P.pgStateFile, 'utf8') || 'null') === null);
    ok('数据库的数据**还在**（停的是进程，不是数据）', fs.existsSync(P.pgVersionFile));
    const plog = fs.readFileSync(P.panelLog, 'utf8');
    ok('日志里那句话与事实相符（不再无条件说「应用与数据库继续运行」）',
      /面板退出（应用已停止，数据库已停止）/.test(plog), plog.split('\n').slice(-6).join('\n'));
    // 应用是 headless 起的，所以这次停止必然走「Windows 送不出关闭请求」那条路。
    // 从前它在等一个永远不会发生的端口释放（8.3 秒），日志却把平台拒绝记成「超时」。
    ok('停止应用时不再空等，也不再谎报「超时」',
      /送不出关闭请求/.test(plog) && !/优雅退出超时/.test(plog), plog.split('\n').slice(-8).join('\n'));
    ok(`整轮停止没有那 8 秒的空等（本次 ${secs} 秒）`, Number(secs) < 6);
  } catch (e) {
    failures += 1;
    console.log('  ✕ 端到端抛了：' + (e && e.message));
  } finally {
    // 收场。顺序很要紧：**先摘联接，再删目录**。
    killApp();
    for (const k of kids) {
      try {
        k.kill();
      } catch {}
    }
    await sleep(500);
    if (link && fs.existsSync(link)) {
      // rmdir 只删链接本身，不碰目标。**绝不能用 rmSync(recursive)** ——
      // 万一它把联接当普通目录递归下去，删掉的就是用户那套 886 MB 的二进制。
      spawnSync('cmd', ['/c', 'rmdir', link], { windowsHide: true, stdio: 'ignore' });
    }
    if (srcPgsql) {
      const keep = fs.existsSync(path.join(srcPgsql, 'bin'));
      if (keep) console.log('\n  · 用户那套 pgsql 二进制完好（联接只删了链接本身）');
      else {
        failures += 1;
        console.log('\n  ✕ 用户那套 pgsql 不见了 —— 这是不可逆的事故，请立刻停下检查');
      }
    }
    // 真库里可能还留着 postmaster，别把它丢在临时目录里
    try {
      const pidFile = path.join(rt, 'pgdata', 'postmaster.pid');
      if (fs.existsSync(pidFile)) {
        const pid = Number(fs.readFileSync(pidFile, 'utf8').split('\n')[0]);
        if (pidAlive(pid)) spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      }
    } catch {}
    fs.rmSync(base, { recursive: true, force: true });
  }
}

if (E2E) await e2e();

console.log('');
if (failures) {
  console.log('✕ ' + failures + ' 项失败。');
  process.exit(1);
}
console.log(
  E2E
    ? '✓ 退出面板：停止动作一定 settle，护栏拒绝一定留痕；端到端确认应用、数据库、面板三样都真的停了。'
    : '✓ 退出面板：停止动作一定 settle，护栏拒绝一定留痕，两者都有反证守着。'
);
