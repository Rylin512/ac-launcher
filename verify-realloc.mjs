#!/usr/bin/env node
// 「重新分配端口」的端到端验证。**自己起一个临时中枢与两个临时面板**，跑完自己收场，
// 所以直接 `node verify-realloc.mjs` 就行，不需要任何前置条件、不碰真实数据根、
// 不动任何真实进程。
//
// 为什么非要起真进程：这个功能的正确性几乎全部落在「跨文件的写顺序」上——
// panel.json 的三个端口、由 pgPort 派生的 databaseUrl、.env 里的 DATABASE_URL 与
// AGILECAMPUS_URL，四处必须一起改对。纯函数测试（verify-ports.mjs）能证明
// 「端口怎么挑」是对的，但证明不了「中枢在改成这一组之前停了什么、之后又拉回了什么」，
// 也证明不了「拒绝的时候磁盘真的一字未改」。
//
// 它是**在这个功能上真实抓到过 bug 的**：allocatePorts 的 exclude 参数原本写成
// 「把自己当前的端口从预约集合里去掉」，于是中枢把原样三个值当成建议值发回来，
// 界面一切正常、点了等于没点。verify-ports.mjs 当时那条用例也照着错语义写了，
// 两边一起错——只有真跑一遍才看得见。
//
// 顺带验证面板那两个「也能改端口」的写点确实收口了（AC_HUB=1 时严格、独立运行照旧），
// 那两条只在面板进程里，中枢侧的测试看不到。
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { portableDsn, pathsFor } from './lib/config.mjs';
import { pickFreePort } from './lib/sysinfo.mjs';
import { panelProcess, readPanelLock } from './lib/registry.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MAIN = path.join(HERE, 'main.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const ok = (name, cond, extra = '') => {
  if (cond) console.log('  ✓ ' + name);
  else {
    failures += 1;
    console.log('  ✕ ' + name + (extra ? '\n      ' + String(extra).slice(0, 400) : ''));
  }
};
const show = (r) => `HTTP ${r.status} ${JSON.stringify(r.data ?? r.text).slice(0, 300)}`;
const sec = (t) => console.log('\n' + t);

/* ---------------------------------------------------------------- 临时环境 */
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-verify-realloc-'));
const children = [];

/** 造一个「像仓库」的目录：looksLikeRepo 只认 package.json 或 .git。 */
function fakeRepo(name) {
  const d = path.join(ROOT, 'repos', name);
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ name, private: true }));
  return d;
}

/** 起一个进程，输出写进日志文件（失败时要靠它查因）。 */
function launch(name, args, env = {}) {
  const log = fs.openSync(path.join(ROOT, name + '.log'), 'a');
  const child = spawn(process.execPath, [MAIN, ...args], {
    env: { ...process.env, ...env },
    windowsHide: true,
    stdio: ['ignore', log, log],
  });
  fs.closeSync(log);
  children.push(child);
  return child;
}

/** 等一个 HTTP 端点开始应答。 */
async function waitUp(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.status) return true;
    } catch {}
    await sleep(250);
  }
  return false;
}

/** 令牌只在进程内从页面里读出来直接用，不落盘、不打印。 */
async function pageToken(base) {
  const html = await (await fetch(base + '/')).text();
  const m = /\bTOKEN\s*=\s*'([^']+)'/.exec(html);
  if (!m) throw new Error('页面里没有注入令牌：' + base);
  return m[1];
}

function client(base, token) {
  return async (p, { method = 'GET', body = null, tok = token } = {}) => {
    const headers = {};
    if (tok) headers['x-ac-token'] = tok;
    if (body !== null) headers['content-type'] = 'application/json';
    const res = await fetch(base + p, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch {}
    return { status: res.status, data, text };
  };
}

const cfgOf = (rt) => JSON.parse(fs.readFileSync(path.join(rt, 'config', 'panel.json'), 'utf8'));
const writeCfg = (rt, patch) => {
  const file = path.join(rt, 'config', 'panel.json');
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), ...patch }, null, 1));
};
const envOf = (rt) => {
  const text = fs.readFileSync(path.join(rt, 'src', '.env'), 'utf8');
  return (k) => {
    const m = new RegExp('^\\s*' + k + '\\s*=\\s*(.*)$', 'm').exec(text);
    return m ? m[1].trim().replace(/^["']|["']$/g, '') : null;
  };
};

/** 占住一个端口（0.0.0.0，与应用一致），返回可关闭的句柄。 */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen({ host: '0.0.0.0', port }, () => resolve(srv));
  });
}
const release = (srv) => new Promise((r) => srv.close(r));

async function jobDone(api, id) {
  for (let i = 0; i < 80; i += 1) {
    const r = await api('/api/jobs/' + id);
    if (r.data && r.data.status !== 'running') return r.data;
    await sleep(250);
  }
  return null;
}

/* ================================================================ 中枢侧 */
async function hubChecks() {
  const port = await pickFreePort(Array.from({ length: 40 }, (_, i) => 8860 + i));
  const dataRoot = path.join(ROOT, 'hub');
  fs.mkdirSync(dataRoot, { recursive: true });
  launch('hub', ['--port', String(port), '--runtime-dir', dataRoot, '--no-open']);
  const base = `http://127.0.0.1:${port}`;
  if (!(await waitUp(base + '/api/hub/state'))) {
    ok('临时中枢起来了', false, '看 ' + path.join(ROOT, 'hub.log'));
    return;
  }
  ok('临时中枢起来了（:' + port + '）', true);
  const api = client(base, await pageToken(base));

  sec('登记三个项目');
  const mk = async (name) => {
    const r = await api('/api/projects', { method: 'POST', body: { repoDir: fakeRepo(name), name } });
    if (r.status !== 200) throw new Error('登记 ' + name + ' 失败：' + show(r));
    return r.data.project;
  };
  const A = await mk('A');
  const B = await mk('B');
  const C = await mk('C');
  ok('三个项目都登记上了', Boolean(A.slug && B.slug && C.slug), JSON.stringify([A.slug, B.slug, C.slug]));
  const rtA = A.runtimeDir;
  const rtC = C.runtimeDir;

  // 夹具必须自己挑**空闲**端口，不能用配置默认值：默认正是本产品自己的范围
  // （app 3000 / pg 55432），而这台机器上真的跑着用户自己的 AgileCampus ——
  // 55432 上就有它的 postgres。撞上去的表现是 R2 那条保护正确地拒绝
  // （「这个库不是我起的」），但那时验的就不是重分配了，而是「保护有没有生效」。
  // 夹具自己挑，测试才对「这台机器上还跑着什么」免疫。
  const freePorts = async (i) => ({
    panelPort: await pickFreePort([8840 + i * 4, 8841 + i * 4, 8842 + i * 4, 8843 + i * 4]),
    appPort: await pickFreePort([3210 + i * 4, 3211 + i * 4, 3212 + i * 4, 3213 + i * 4]),
    pgPort: await pickFreePort([55450 + i * 4, 55451 + i * 4, 55452 + i * 4, 55453 + i * 4]),
  });
  writeCfg(A.runtimeDir, await freePorts(0));
  writeCfg(B.runtimeDir, await freePorts(1));
  writeCfg(rtC, await freePorts(2));

  // A 弄成「已部署过」的样子。刚 addProject 出来的项目 dbMode 还是 null，那个状态下
  // ensureEnvFile 既不会把新生成的密码落进 panel.json、也不会在 DATABASE_URL 已存在时
  // 更新它——拿它去断言「密码不变 / DSN 跟得上」验的是别的行为，不是本功能。
  // 真实要改端口的项目都是 portable 的。
  writeCfg(rtA, { dbMode: 'portable', pgPassword: 'verify-pw-' + Math.random().toString(36).slice(2, 10) });
  writeCfg(rtA, { databaseUrl: portableDsn(cfgOf(rtA)) });
  // C 是外部库：它的 databaseUrl 不是我们派生的，重分配绝不该碰它。
  writeCfg(rtC, { dbMode: 'external', databaseUrl: 'postgres://someone@db.example.invalid:6000/keepme' });

  sec('GET /ports（弹窗里预填的建议值）');
  const g = await api(`/api/projects/${A.slug}/ports`);
  ok('返回 current + suggested + portable', g.status === 200 && g.data?.current && g.data?.suggested, show(g));
  const cur = g.data?.current;
  const sug = g.data?.suggested;
  ok('建议的三个值都不同于当前值（否则点了等于没点）',
    ['panel', 'app', 'pg'].every((k) => sug[k] !== cur[k]), JSON.stringify({ cur, sug }));
  ok('建议值不撞另一个项目的预约',
    !Object.values(B.ports).some((n) => Object.values(sug).includes(n)),
    JSON.stringify({ B: B.ports, sug }));

  sec('提交前的拒绝路径（磁盘必须零改动）');
  const before = cfgOf(rtA);
  const bad1 = await api(`/api/projects/${A.slug}/ports`, { method: 'POST', body: { confirmDowntime: true, ports: { panel: B.ports.panel, app: 3111, pg: 55439 } } });
  ok('撞别人的预约 → 400 且点名那个项目', bad1.status === 400 && /B/.test(bad1.data?.error?.message || ''), show(bad1));
  const bad2 = await api(`/api/projects/${A.slug}/ports`, { method: 'POST', body: { confirmDowntime: true, ports: { panel: 3121, app: 3121, pg: 55439 } } });
  ok('三个端口互相重复 → 400', bad2.status === 400 && /互不相同/.test(bad2.data?.error?.message || ''), show(bad2));
  const bad3 = await api(`/api/projects/${A.slug}/ports`, { method: 'POST', body: { ports: sug } });
  ok('缺 confirmDowntime → 400（这个操作会停服务，不能靠 GET 触发）', bad3.status === 400, show(bad3));
  const bad4 = await api(`/api/projects/${A.slug}/ports`, { method: 'POST', body: { confirmDowntime: true, ports: { panel: 3122, app: 0, pg: 55439 } } });
  ok('非整数/越界端口 → 400', bad4.status === 400, show(bad4));
  const bad5 = await api('/api/projects/nope-00000000/ports', { method: 'POST', body: { confirmDowntime: true } });
  ok('不存在的项目 → 404', bad5.status === 404, show(bad5));
  const bad6 = await api(`/api/projects/${A.slug}/ports`, { method: 'POST', body: { confirmDowntime: true, ports: cur } });
  ok('原样提交当前值 → 400（而不是假装干了一次活）', bad6.status === 400, show(bad6));
  ok('一连串拒绝之后 panel.json 一字未改',
    JSON.stringify(cfgOf(rtA)) === JSON.stringify(before), JSON.stringify({ before, after: cfgOf(rtA) }));

  sec('真正重分配（本项目没有任何服务在跑，所以这条路最干净）');
  const run = await api(`/api/projects/${A.slug}/ports`, { method: 'POST', body: { confirmDowntime: true, ports: sug } });
  ok('200 成功', run.status === 200, show(run));
  ok('返回 before / after / durationMs / restarted / warnings',
    Boolean(run.data?.before && run.data?.after && typeof run.data.durationMs === 'number' && run.data.restarted && Array.isArray(run.data.warnings)), show(run));
  ok('before 是旧值、after 是新值',
    run.data?.before.panel === cur.panel && run.data?.after.panel === sug.panel, JSON.stringify({ b: run.data?.before, a: run.data?.after }));
  ok('什么都没在跑 → restarted 三个都是 false',
    run.data && !run.data.restarted.panel && !run.data.restarted.app && !run.data.restarted.pg, JSON.stringify(run.data?.restarted));
  ok('panel.json 三个端口 = 新值',
    ['panel', 'app', 'pg'].every((k) => cfgOf(rtA)[k + 'Port'] === sug[k]),
    JSON.stringify({ disk: cfgOf(rtA), sug }));

  sec('派生数据（这个功能的要害）');
  const ev1 = envOf(rtA);
  ok('.env 的 AGILECAMPUS_URL 跟上了新应用端口', ev1('AGILECAMPUS_URL') === `http://localhost:${sug.app}`, String(ev1('AGILECAMPUS_URL')));
  ok('.env 的 DATABASE_URL 跟着新数据库端口走', ev1('DATABASE_URL') === cfgOf(rtA).databaseUrl, '不一致');
  ok('AUTH_SECRET 已生成且不是模板占位值',
    Boolean(ev1('AUTH_SECRET')) && ev1('AUTH_SECRET') !== 'change-me-run-npx-auth-secret', '占位或为空');
  const pw1 = ev1('POSTGRES_PASSWORD');
  const as1 = ev1('AUTH_SECRET');

  // 再来一次：端口必须真的又变了，而**密码与密钥一个字节都不能动**。
  // 「换端口 = 换地址，不是换身份」这句话只有这样才验得出来。
  const g2 = await api(`/api/projects/${A.slug}/ports`);
  const run2 = await api(`/api/projects/${A.slug}/ports`, { method: 'POST', body: { confirmDowntime: true, ports: g2.data.suggested } });
  ok('第二次重分配也成功', run2.status === 200, show(run2));
  ok('第二次挑出来的端口仍然全新（avoid 真的生效）',
    ['panel', 'app', 'pg'].every((k) => run2.data?.after[k] !== run2.data?.before[k]),
    JSON.stringify(run2.data && { b: run2.data.before, a: run2.data.after }));
  const ev2 = envOf(rtA);
  ok('POSTGRES_PASSWORD 逐字节未变（本操作从不 ALTER ROLE）', ev2('POSTGRES_PASSWORD') === pw1, '变了');
  ok('AUTH_SECRET 逐字节未变', ev2('AUTH_SECRET') === as1, '变了');
  ok('databaseUrl 仍然等于由新 pgPort 派生的值（没有静默失同步）',
    cfgOf(rtA).databaseUrl === portableDsn(cfgOf(rtA)), '漂了');

  sec('显示缓存与界面载荷');
  const disk = { panel: cfgOf(rtA).panelPort, app: cfgOf(rtA).appPort, pg: cfgOf(rtA).pgPort };
  const st = await api('/api/hub/state');
  const sp = st.data.projects.find((p) => p.slug === A.slug);
  ok('状态载荷里的三个端口都是新值',
    sp.ports.panel === disk.panel && sp.ports.app === disk.app && sp.ports.pg === disk.pg,
    JSON.stringify({ state: sp.ports, disk }));
  ok('空闲时 pending 是 null（不是 undefined —— 界面据此禁用按钮）', sp.pending === null, JSON.stringify(sp.pending));
  const pa = JSON.parse(fs.readFileSync(path.join(dataRoot, 'projects.json'), 'utf8')).projects.find((p) => p.slug === A.slug);
  ok('projects.json 的 ports 缓存跟上了',
    pa.ports.panel === disk.panel && pa.ports.app === disk.app && pa.ports.pg === disk.pg, JSON.stringify(pa.ports));

  sec('外部库模式：只动 panel+app，绝不碰 pgPort / databaseUrl');
  const cBefore = cfgOf(rtC);
  const gC = await api(`/api/projects/${C.slug}/ports`);
  ok('portable 标记为 false', gC.data?.portable === false, show(gC));
  ok('建议值里不出现数据库端口（那不是我们的）', gC.data?.suggested.pg === cBefore.pgPort, JSON.stringify(gC.data?.suggested));
  const rC = await api(`/api/projects/${C.slug}/ports`, { method: 'POST', body: { confirmDowntime: true } });
  ok('重分配成功', rC.status === 200, show(rC));
  const cAfter = cfgOf(rtC);
  ok('数据库端口一字未动', cAfter.pgPort === cBefore.pgPort, `${cBefore.pgPort} → ${cAfter.pgPort}`);
  ok('databaseUrl 一字未动', cAfter.databaseUrl === cBefore.databaseUrl, cAfter.databaseUrl);
  ok('面板与应用端口确实换了',
    cAfter.panelPort !== cBefore.panelPort && cAfter.appPort !== cBefore.appPort,
    JSON.stringify({ panel: [cBefore.panelPort, cAfter.panelPort], app: [cBefore.appPort, cAfter.appPort] }));

  // 磁盘上的旧值必须真的避开了：那正是 exclude→avoid 那个 bug 的形状。
  ok('新端口组与三个项目的全部旧值都不相交',
    !Object.values(disk).includes(cAfter.panelPort) && !Object.values(disk).includes(cAfter.appPort),
    JSON.stringify({ disk, cAfter: [cAfter.panelPort, cAfter.appPort] }));
}

/* ================================================================ 面板侧 */
async function panelScenario(name, { hubManaged, panelPort }) {
  sec(`${name}：面板那两个「也能改端口」的写点（AC_HUB ${hubManaged ? '已设' : '未设'}）`);
  const appPort = await pickFreePort([3160, 3161, 3162, 3163, 3164]);
  const rt = path.join(ROOT, 'panel-' + name);
  fs.mkdirSync(path.join(rt, 'config'), { recursive: true });
  const repoDir = fakeRepo('repo-' + name);
  fs.mkdirSync(path.join(rt, 'src'), { recursive: true });
  fs.writeFileSync(path.join(rt, 'config', 'panel.json'), JSON.stringify({
    appPort, pgPort: 55440, panelPort, registry: '', autoOpenBrowser: false,
    mirror: false, dbMode: null, databaseUrl: '', builtAt: null, sourceHash: null, lockHash: null, repoDir,
  }, null, 1));

  const env = {};
  if (hubManaged) env.AC_HUB = '1';
  launch('panel-' + name, ['--repo', repoDir, '--runtime-dir', rt, '--no-open'], env);

  let lock = null;
  for (let i = 0; i < 80 && !lock; i += 1) {
    await sleep(250);
    try { lock = JSON.parse(fs.readFileSync(path.join(rt, 'run', 'panel.lock'), 'utf8')); } catch {}
  }
  if (!lock) return ok('面板起来了', false, '看 ' + path.join(ROOT, 'panel-' + name + '.log'));
  ok('面板起来了（:' + lock.port + '）', true);
  const api = client(`http://127.0.0.1:${lock.port}`, await pageToken(`http://127.0.0.1:${lock.port}`));
  const child = children[children.length - 1];

  // 锁本身。面板改成**原子写**（tmp + rename）之后，中枢每 2 秒一次的读取才不会
  // 读到半截 JSON —— 那正是「卡片偶尔闪一下面板未打开」的另一个来源。
  // 这里验的是「这份锁真的出自那个面板进程，并且判据认得出」。
  const P = pathsFor(rt, repoDir);
  ok('锁里的 pid 就是真面板的进程', lock.pid === child.pid, `锁 ${lock.pid} / 进程 ${child.pid}`);
  ok('readPanelLock 读得出来（形状完整）', readPanelLock(P)?.port === lock.port);
  ok('panelProcess 认得出它在跑（中枢据此说「运行中」，不看应答）', panelProcess(P)?.pid === child.pid);
  ok('没有留下 .tmp 残骸（原子写要能收干净）', !fs.existsSync(P.lockFile + '.tmp'));
  {
    // 直接守「别改回原地写」。上面的断言证明不了原子性（竞态测不到），
    // 但调用点用哪个函数是能验的。
    const panelSrc = fs.readFileSync(path.join(HERE, 'panel.mjs'), 'utf8');
    ok('面板写锁走的是 writeJson（tmp + rename），不是原地 writeFileSync', /writeJson\(\s*P\.lockFile/.test(panelSrc));
  }

  // ---- 写点 2：设置页（ui/index.html 冻结，前端只会显示「配置已保存。」）
  const r1 = await api('/api/config', {
    method: 'PUT',
    body: { appPort: appPort + 1, pgPort: 55440, registry: '', autoOpenBrowser: false, mirror: false },
  });
  if (hubManaged) {
    ok('改端口 → 400', r1.status === 400, show(r1));
    ok('文案指回了中枢', /中枢/.test(r1.data?.error?.message || ''), r1.data?.error?.message);
    ok('文案说清了「其余设置也没保存」', /没有保存/.test(r1.data?.error?.message || ''), r1.data?.error?.message);
    ok('磁盘上的 appPort 一字未改', cfgOf(rt).appPort === appPort, String(cfgOf(rt).appPort));
  } else {
    ok('独立运行：改端口照旧生效', r1.status === 200 && cfgOf(rt).appPort === appPort + 1, show(r1));
  }
  const r2 = await api('/api/config', {
    method: 'PUT',
    body: { appPort: cfgOf(rt).appPort, pgPort: 55440, registry: '', autoOpenBrowser: true, mirror: true },
  });
  ok('端口没变时，表单里其它设置正常保存（不连坐）', r2.status === 200 && cfgOf(rt).mirror === true, show(r2));

  // ---- 写点 1：启动时端口被占
  const busyPort = cfgOf(rt).appPort;
  const busy = await occupy(busyPort);
  let job;
  try {
    const s = await api('/api/ops/start', { method: 'POST', body: {} });
    job = await jobDone(api, s.data?.jobId);
  } finally {
    await release(busy);
  }
  const after = cfgOf(rt);
  if (hubManaged) {
    ok('端口被占 → 任务失败', job?.status === 'failed', JSON.stringify(job && { status: job.status, error: job.error }));
    ok('错误码是 PORT_BUSY_MANAGED', job?.errorCode === 'PORT_BUSY_MANAGED', String(job?.errorCode));
    ok('错误文案指回了中枢', /中枢/.test(job?.error || ''), job?.error);
    ok('**没有**偷偷换端口落盘（这正是原先的缺陷）', after.appPort === busyPort, `${busyPort} → ${after.appPort}`);
  } else {
    ok('独立运行：自动挑替代端口并落盘（保留旧行为）', after.appPort !== busyPort, `${busyPort} → ${after.appPort}`);
    const text = (job?.lines || []).map((l) => l.text).join('\n');
    ok('日志说明了这是独立运行模式的绕过', /独立运行模式/.test(text), text.slice(0, 200));
  }

  // 用面板自己的优雅停机收场（tokenSet 里本来就有它自己那枚）。
  await api('/api/ops/shutdown', { method: 'POST', body: {} });
  for (let i = 0; i < 24 && child.exitCode === null; i += 1) await sleep(250);
  ok('面板优雅退出', child.exitCode !== null, '还活着');
}

/* ------------------------------------------------------------------ 跑 */
console.log('「重新分配端口」端到端验证（临时环境：' + ROOT + '）');
try {
  await hubChecks();
  // 两个面板用互不相交的面板端口段，免得前一个刚关掉留下的端口影响后一个。
  await panelScenario('hub', { hubManaged: true, panelPort: await pickFreePort([8820, 8821, 8822]) });
  await panelScenario('solo', { hubManaged: false, panelPort: await pickFreePort([8830, 8831, 8832]) });
} catch (e) {
  failures += 1;
  console.log('\n✕ 验证过程本身抛了：' + (e.stack || e.message));
} finally {
  for (const c of children) {
    if (c.exitCode === null) {
      try { c.kill(); } catch {}
    }
  }
  await sleep(600);
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch {}
}

console.log('');
if (failures) {
  console.log('✕ ' + failures + ' 项失败。');
  process.exit(1);
}
console.log('✓ 重新分配端口：事务、拒绝路径、派生数据、以及面板那两个写点的收口都成立。');
