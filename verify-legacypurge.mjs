#!/usr/bin/env node
// 守「收编的旧部署能被删掉，但中枢自己不会被顺手端掉」这条不变式。
//
//   node verify-legacypurge.mjs           库层：清盘范围、注销、接线（打包门禁跑这个）
//   node verify-legacypurge.mjs --e2e     端到端：自起一个临时中枢，走真的 HTTP 路径
//
// 背景：旧部署的运行目录**就是数据根**，而中枢自己的 projects.json（注册表本身）、
// config/hub.secret、run/hub.lock、logs/hub.log、engine/、以及别的项目全跟它挤在
// 同一层。所以「删除并清盘」在它身上不能是 rm -rf 整个目录——那会把中枢自己删掉，
// 而且**现场没有任何东西会报错**：注册表就是被删掉的那个文件之一，下一个启动得到的
// 是一份全新的空注册表，看起来像「用户从没加过项目」。
//
// 这个文件里最要紧的几条都是**反证**，因为它们各自守着一种「测试其实没测到东西」：
//   · 普通项目走 purgeProject 必须真的把整个目录删掉——否则那一串「还在」只能证明
//     这个函数是个空操作。
//   · 移出列表之后 migrateLegacy 必须**不再**把它收编回来——不先证明「没有那一笔时
//     它确实会被收编」，那句 false 就分不清是修好了还是压根没走到。
//   · 端到端那一段里，所有请求都打在一个**真的在跑的中枢**上；它起来之后要等到
//     `run/hub.lock` 落盘才算就绪（那个文件是在 listen **之后**写的，中间还夹着一次
//     ~1–2 秒的 PowerShell 调用）。不等它，就会把「锁还没写」当成故障——这个坑在这份
//     文件里已经踩过一次了。
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  loadRegistry,
  saveRegistry,
  migrateLegacy,
  dedupeProjects,
  samePath,
  addProject,
  removeProject,
  purgeProject,
  isIgnoredRepo,
} from './lib/registry.mjs';

const HERE = import.meta.dirname;
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

/** 旧部署清盘该删掉的每一项。清单外的同层东西下面单独验「还在」。 */
const DEPLOYMENT_RELS = [
  'src', 'node', 'pgsql', 'pgdata', 'tmp',
  'config/panel.json',
  'run/panel.lock', 'run/app.json', 'run/pg.json', 'run/deps.json',
  'logs/app.log', 'logs/pg.log',
];
/** 中枢自己的东西，一样都不能少。 */
const HUB_RELS = [
  'projects.json',
  'config/hub.secret',
  'run/hub.lock',
  'logs/hub.log',
  'engine/abc123/main.mjs',
  'projects/other-deadbeef/src/package.json',
];

/**
 * 铺一份「数据根里长着一套旧部署，同时中枢自己也在用这个目录，另一个项目的运行目录
 * 还长在里面」的现场。`pgPort` 由调用方给：库层随便填，端到端层必须是个真空闲端口。
 */
function fixture(root, REPO, OTHER_REPO, pgPort) {
  const w = (rel, text = 'x') => {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  };
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  for (const d of [REPO, OTHER_REPO]) {
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'package.json'), '{"name":"stub"}');
  }

  // —— 旧部署自己的（清盘该删的就是这些）
  w(path.join('src', 'package.json'), '{"name":"legacy"}');
  w(path.join('src', '.env'), 'DATABASE_URL=stub');
  w(path.join('node', 'node.exe'), 'bin');
  w(path.join('pgsql', 'bin', 'pg_ctl.exe'), 'bin');
  w(path.join('pgdata', 'PG_VERSION'), '17');
  w(path.join('tmp', 'download.zip'), 'zip');
  w(path.join('config', 'panel.json'), JSON.stringify({
    repoDir: REPO, panelPort: 8800, appPort: 3000, pgPort, dbMode: 'portable',
  }));
  w(path.join('run', 'panel.lock'), JSON.stringify({ pid: 999999, port: 8800, repoDir: REPO }));
  w(path.join('run', 'app.json'), 'null');
  w(path.join('run', 'pg.json'), 'null');
  w(path.join('run', 'deps.json'), '{}');
  w(path.join('logs', 'app.log'), 'app');
  w(path.join('logs', 'pg.log'), 'pg');

  // —— 中枢自己的（一个字节都不许动）
  w('projects.json', JSON.stringify({
    version: 1,
    hub: { port: 8788, actualPort: null },
    projects: [{
      slug: 'other-deadbeef', name: 'other', repoDir: OTHER_REPO,
      runtimeDir: path.join(root, 'projects', 'other-deadbeef'), legacy: false,
      ports: { panel: 8801, app: 3001, pg: 55433 },
    }],
  }));
  w(path.join('config', 'hub.secret'), 'stub-secret');
  w(path.join('run', 'hub.lock'), '{"pid":1}');
  w(path.join('logs', 'hub.log'), 'hub');
  w(path.join('engine', 'abc123', 'main.mjs'), 'engine');

  // —— 另一个项目（它的运行目录长在数据根**里面**，最容易跟着一起没）
  w(path.join('projects', 'other-deadbeef', 'src', 'package.json'), '{"name":"other"}');
  w(path.join('projects', 'other-deadbeef', 'config', 'panel.json'), '{}');
}

const legacyOf = (root, REPO) => ({
  slug: 'legacy-00000000',
  name: 'legacy',
  repoDir: REPO,
  runtimeDir: root,
  legacy: true,
  ports: { panel: 8800, app: 3000, pg: 55432 },
});
const otherOf = (root, OTHER_REPO) => ({
  slug: 'other-deadbeef',
  name: 'other',
  repoDir: OTHER_REPO,
  runtimeDir: path.join(root, 'projects', 'other-deadbeef'),
  legacy: false,
  ports: { panel: 8801, app: 3001, pg: 55433 },
});

// ============================================================ 库层

async function libraryChecks() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-legacy-'));
  const root = path.join(base, 'data');
  const REPO = path.join(base, 'legacy-repo');
  const OTHER_REPO = path.join(base, 'other-repo');
  const OUTSIDE = path.join(base, 'outside.txt');
  fs.writeFileSync(OUTSIDE, '数据根**外面**的文件，绝不该被碰');
  const F = () => fixture(root, REPO, OTHER_REPO, 55432);

  sec('清盘旧部署：删该删的，留该留的');
  F();
  let wiped;
  try {
    wiped = purgeProject(legacyOf(root, REPO));
  } catch (e) {
    wiped = { error: e };
  }
  ok('purgeProject 没抛错', !wiped.error, String(wiped.error && wiped.error.message));
  ok('走的是 scoped（不是 rm -rf 整个目录）', wiped.mode === 'scoped', JSON.stringify(wiped.mode));
  // 反证之一：删 0 项的话，下面所有「还在」都是在拿一个空操作当证据。
  ok('确实删掉了东西（不是空操作）', (wiped.removed || []).length >= 10, JSON.stringify(wiped.removed));
  for (const rel of DEPLOYMENT_RELS) {
    ok('删掉了 ' + rel, !fs.existsSync(path.join(root, rel)));
  }
  ok('数据根本身还在（它是中枢的数据根，不是这一条项目的私产）', fs.existsSync(root) && fs.statSync(root).isDirectory());
  for (const rel of HUB_RELS) {
    ok('留住了 ' + rel, fs.existsSync(path.join(root, rel)));
  }
  ok('config/ 与 logs/ 目录本身还在（只删了里面的文件，没删目录）',
    fs.existsSync(path.join(root, 'config')) && fs.existsSync(path.join(root, 'logs')));
  ok('数据根**外面**的文件没被碰', fs.existsSync(OUTSIDE));
  ok('removed 里报出来的每一条都在数据根里（没有跑到外面去）',
    (wiped.removed || []).every((r) => path.resolve(root, r).startsWith(path.resolve(root) + path.sep)), JSON.stringify(wiped.removed));
  ok('kept 说得出中枢保住了什么', Array.isArray(wiped.kept) && wiped.kept.includes('projects.json'), JSON.stringify(wiped.kept));

  sec('清盘之后才算注销干净：migrateLegacy 也不该再认它');
  {
    const reg = loadRegistry(root);
    reg.projects = [otherOf(root, OTHER_REPO)];
    // panel.json 被删掉了，连仓库都推不出来——所以连「收编」这个动作都无从谈起。
    ok('不再被自动收编（config\\panel.json 已经没了）', migrateLegacy(root, reg) === false);
  }

  sec('反证：普通项目就是整个运行目录删掉');
  F();
  const o = otherOf(root, OTHER_REPO);
  const w2 = purgeProject(o);
  ok('普通项目走的是 whole', w2.mode === 'whole', JSON.stringify(w2.mode));
  ok('普通项目的运行目录整个没了（所以上面那串「还在」不是空操作撑起来的）', !fs.existsSync(o.runtimeDir));
  ok('同一个数据根里别的东西照样没动', fs.existsSync(path.join(root, 'projects.json')) && fs.existsSync(path.join(root, 'config', 'hub.secret')));

  sec('重启幂等：同一条旧部署不会被再收编一次');
  F();
  {
    const first = loadRegistry(root);
    first.projects = [otherOf(root, OTHER_REPO)];
    saveRegistry(root, first);
    const adopted = loadRegistry(root);
    ok('第一次启动收编（前置条件，否则下面那句 false 证明不了任何事）', migrateLegacy(root, adopted) === true);
    // 中枢在启动末尾会 saveRegistry。照做，然后模拟下一次启动。
    saveRegistry(root, adopted);
    const next = loadRegistry(root);
    ok('第二次启动不再收编（「每次启动多一条旧部署」的回归）', migrateLegacy(root, next) === false);
    saveRegistry(root, next);
    ok('落盘之后仍然只有一条旧部署', loadRegistry(root).projects.filter((p) => p.legacy).length === 1);
  }

  sec('同一目录的另一种写法不算第二套部署');
  F();
  {
    const alias = path.join(base, 'data-alias');
    let linked = false;
    try {
      fs.symlinkSync(root, alias, 'dir');
      linked = true;
    } catch {}
    if (linked) {
      const reg = loadRegistry(root);
      reg.projects = [{ ...legacyOf(root, REPO), runtimeDir: alias }];
      ok('符号链接 / junction 指向同一处时不再收编', migrateLegacy(root, reg) === false);
    } else {
      console.log('  · 跳过符号链接用例（当前环境不允许创建链接）');
    }
    if (process.platform === 'win32') {
      ok('大小写不同的同一路径被认作同一处', samePath(root, root.toUpperCase()));
    }
  }

  sec('历史上已经堆出来的重复条目：读出来就合并');
  F();
  {
    // saveRegistry 会先去重，所以这里直接写一份「坏」的 projects.json 模拟旧版本留下的现场。
    const dup = legacyOf(root, REPO);
    const raw = {
      version: 1,
      hub: { port: 8788, actualPort: null },
      projects: [dup, { ...dup }, { ...dup }, otherOf(root, OTHER_REPO)],
    };
    fs.writeFileSync(path.join(root, 'projects.json'), JSON.stringify(raw, null, 2));
    const loaded = loadRegistry(root);
    ok('文件里确实有 3 条旧部署（前置条件）', loaded.projects.filter((p) => p.legacy).length === 3);
    ok('合并掉 2 条', dedupeProjects(loaded) === 2);
    ok('只剩一条旧部署', loaded.projects.filter((p) => p.legacy).length === 1);
    ok('另一个项目没被顺手删掉', loaded.projects.some((p) => p.slug === 'other-deadbeef'));
    saveRegistry(root, loaded);
    ok('落盘之后仍然是 1 条', loadRegistry(root).projects.filter((p) => p.legacy).length === 1);
  }

  sec('仓库已经以普通项目登记：不再多收编一条旧部署');
  F();
  {
    const reg = loadRegistry(root);
    reg.projects = [{
      slug: 'legacy-00000000', name: 'legacy', repoDir: REPO,
      runtimeDir: path.join(root, 'projects', 'legacy-00000000'), legacy: false,
    }];
    saveRegistry(root, reg);
    ok('不再收编（同一仓库只该有一张卡片）', migrateLegacy(root, loadRegistry(root)) === false);
  }

  sec('移出列表：文件一个不动，但不会再自己回来');
  F();
  {
    // 反证之先：没有那一笔时，数据根里的旧部署**确实会被**收编。
    const fresh = loadRegistry(root);
    fresh.projects = [otherOf(root, OTHER_REPO)];
    saveRegistry(root, fresh);
    ok('先证明它本来会被收编（否则下面那句 false 证明不了任何事）', migrateLegacy(root, loadRegistry(root)) === true);
  }
  {
    const reg = loadRegistry(root);
    reg.projects = [legacyOf(root, REPO), otherOf(root, OTHER_REPO)];
    const removed = removeProject(reg, 'legacy-00000000');
    ok('移出返回的就是那条旧部署', removed.slug === 'legacy-00000000');
    ok('记下了「别再自动收编」', isIgnoredRepo(reg, REPO));
    // Windows 上同一个目录的大小写写法必须算同一处；POSIX 上则是两个不同的目录，
    // 这里刻意跟着平台走，而不是无条件小写化（那会把两个真实存在的仓库并成一个）。
    if (process.platform === 'win32') {
      ok('路径比较不区分大小写（注册表里两种写法都出现过）', isIgnoredRepo(reg, REPO.toUpperCase()));
    } else {
      ok('POSIX 上大小写不同就是不同路径（不做无条件小写化）', !isIgnoredRepo(reg, REPO.toUpperCase()));
    }
    saveRegistry(root, reg);
    // 关键：从磁盘读回来。saveRegistry 写的是**白名单**，漏掉这个键就白记。
    const back = loadRegistry(root);
    ok('这一笔真的落进了 projects.json', isIgnoredRepo(back, REPO), JSON.stringify(back.ignoredRepos));
    ok('于是不再被收编（这就是「删了又自己回来」的那个 bug）', migrateLegacy(root, back) === false);
    ok('而部署文件一个都没少', DEPLOYMENT_RELS.every((rel) => fs.existsSync(path.join(root, rel))));
  }
  {
    // 加回来 = 撤销那次移除。
    const reg = loadRegistry(root);
    const added = await addProject(reg, root, REPO, { name: 'legacy' });
    ok('添加项目把它加回来了', added.repoDir === REPO && added.legacy === false, JSON.stringify(added));
    ok('那一笔被划掉了（加回来就该等于没移除过）', !isIgnoredRepo(reg, REPO), JSON.stringify(reg.ignoredRepos));
  }

  sec('清盘清单本身的纪律（源码级：加错一条就是删注册表）');
  {
    const src = fs.readFileSync(path.join(HERE, 'lib', 'registry.mjs'), 'utf8');
    const block = /const LEGACY_PURGE_RELS = \[([\s\S]*?)\n\];/.exec(src);
    ok('找得到 LEGACY_PURGE_RELS', Boolean(block));
    const entries = [];
    for (const m of (block ? block[1] : '').matchAll(/path\.join\(\s*'([^']+)'\s*,\s*'([^']+)'\s*\)|'([^']+)'/g)) {
      entries.push(m[3] ?? path.join(m[1], m[2]));
    }
    ok('解析出了清单（正则没跟上写法的话下面全是空断言）', entries.length >= 12, JSON.stringify(entries));
    ok('每一条都是相对路径', entries.every((e) => !path.isAbsolute(e)), JSON.stringify(entries));
    ok('没有一条带 ..（一条 ..\\.. 就是删整个盘）', entries.every((e) => !e.split(/[\\/]/).includes('..')), JSON.stringify(entries));
    // 这一条是本文件的中心：中枢自己独占的名字，**一个都不许**作为整条出现在清单里。
    const HUB_OWNED = ['config', 'run', 'logs', 'projects', 'engine', 'projects.json'];
    const bad = entries.filter((e) => HUB_OWNED.includes(e));
    ok('没有把中枢自己的目录整个写进清单', bad.length === 0, JSON.stringify(bad));
    ok('清单里没有 projects/ 下面任何东西（别的项目长在那儿）',
      !entries.some((e) => e.split(/[\\/]/)[0].toLowerCase() === 'projects'), JSON.stringify(entries));
    // 这两条漏了，「注销」就不生效：下次启动 migrateLegacy 会照它们再收编回来。
    ok('清单里有 config/panel.json', entries.includes(path.join('config', 'panel.json')), JSON.stringify(entries));
    ok('清单里有 run/panel.lock（repoDirFromLock 也认它）', entries.includes(path.join('run', 'panel.lock')), JSON.stringify(entries));
    ok('越界断言还在（它守着一个 rm -rf 的入口）', /PURGE_ESCAPE/.test(src));
  }

  sec('中枢与界面的接线');
  {
    const hub = fs.readFileSync(path.join(HERE, 'hub.mjs'), 'utf8');
    ok('删旧部署不再被 400 挡住', !/它的运行目录就是数据根/.test(hub), '那句旧拒绝文案还在');
    ok('DELETE 走 purgeProject', /purgeProject\(project\)/.test(hub));
    const p = hub.indexOf('purgeProject(project)');
    const r = hub.indexOf('removeProject(registry, project.slug)');
    ok('先清盘、后注销（反过来：删一半失败时列表里已经没有它，用户连重试按钮都找不到）', p !== -1 && r !== -1 && p < r, `purge@${p} remove@${r}`);
    ok('旧部署清盘前先确认数据库不在跑', /dbSt\.state === 'running'/.test(hub));
    ok('也确认应用不在跑', /appSt\.state === 'running'/.test(hub));
    ok('响应里带上清盘明细（界面才能说实话）', /purge:\s*wiped/.test(hub));

    const ui = fs.readFileSync(path.join(HERE, 'hub-ui', 'index.html'), 'utf8');
    const i = ui.indexOf('data-act="purge"');
    const seg = i === -1 ? '' : ui.slice(i, ui.indexOf('删除并清盘', i));
    ok('清盘按钮不再因 legacy 禁用', i !== -1 && !/legacy/.test(seg), seg);
    const idxs = [...ui.matchAll(/data-act="forget"/g)].map((m) => m.index);
    ok('「移出列表」有两处：错误卡片一处 + 旧部署卡片一处', idxs.length === 2, String(idxs.length));
    ok('新加的那处在 p.legacy 的条件下', idxs.some((k) => /p\.legacy \?[^;]*$/.test(ui.slice(Math.max(0, k - 260), k))));
    ok('弹窗对旧部署说清了「数据根本身不会被删」', /数据根本身不会被删/.test(ui));
    ok('弹窗也说了仓库不动', /不会被改动/.test(ui));
    ok('清盘结果按实际形态分别汇报（整目录 vs 按名字）', /r\.purge\.mode === 'scoped'/.test(ui));
    ok('「移出列表」对旧部署说清不会自己回来', /不会自己回来/.test(ui));
    // 护栏对 /api/ 下的**所有**非 GET 都要求 application/json（哪怕没有 body），
    // 而 api() 只在 body 非 null 时才带这个头。曾经就是这么漏的：点了按钮什么都不
    // 发生，只有一条红字说「请求必须使用 application/json」——而移出列表是旧部署
    // 唯一一条不清盘的退路，它坏了就等于没有。
    const mutating = [...ui.matchAll(/api\([^\n]*?\{[^}]*method:\s*'(POST|DELETE|PUT)'[^}]*\}/g)].map((m) => m[0]);
    ok('改动型请求都带了 body（否则 415）', mutating.length >= 4 && mutating.every((c) => /body:/.test(c)), JSON.stringify(mutating));
  }

  fs.rmSync(base, { recursive: true, force: true });
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

async function e2e() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-legacy-e2e-'));
  const root = path.join(base, 'data');
  const REPO = path.join(base, 'legacy-repo');
  const OTHER_REPO = path.join(base, 'other-repo');
  const PG_PORT = await freePort();
  const HUB_PORT = await freePort();
  const HUB = `http://127.0.0.1:${HUB_PORT}`;
  const children = [];
  let token = null;

  fixture(root, REPO, OTHER_REPO, PG_PORT);

  const startHub = () => {
    const child = spawn(process.execPath, [path.join(HERE, 'main.mjs'), '--runtime-dir', root, '--port', String(HUB_PORT), '--no-open'], {
      cwd: HERE,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    children.push(child);
    return { child, log: () => out };
  };

  /**
   * 起中枢 → 等它就绪 → 读令牌。
   *
   * 三个都要等，缺一个就会造出**假故障**：
   *  · HTTP 能应答不代表启动完了——`listen` 早于 `run\hub.lock` 的写入；
   *  · 那个写入中间夹着一次 ~1–2 秒的 `processStartTime`（PowerShell）。不等它，
   *    就会看到「中枢在跑但锁没写」这种根本不存在的故障；
   *  · 令牌每次启动都换，重启之后必须重读，否则所有改动型请求都是 403。
   */
  const bootHub = async () => {
    const hub = startHub();
    let up = false;
    for (let i = 0; i < 100 && !up; i += 1) {
      try {
        const r = await fetch(HUB + '/api/hub/state');
        if (r.status) up = true;
      } catch {}
      if (!up) await sleep(250);
    }
    if (!up) throw new Error('中枢没起来：\n' + hub.log());
    const lock = path.join(root, 'run', 'hub.lock');
    for (let i = 0; i < 80 && !fs.existsSync(lock); i += 1) await sleep(250);
    if (!fs.existsSync(lock)) throw new Error('中枢起来了但没写 run\\hub.lock：\n' + hub.log());
    const html = await (await fetch(HUB + '/')).text();
    const m = /\bTOKEN\s*=\s*'([^']+)'/.exec(html);
    if (!m) throw new Error('页面里没有注入令牌');
    token = m[1];
    return hub;
  };

  const call = async (p, { method = 'GET', body = null } = {}) => {
    const headers = { 'x-ac-token': token };
    if (body !== null) headers['content-type'] = 'application/json';
    const res = await fetch(HUB + p, { method, headers, body: body === null ? undefined : JSON.stringify(body) });
    const text = await res.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {}
    return { status: res.status, data, text };
  };
  const state = async () => (await call('/api/hub/state')).data;
  const slugs = (s) => (s.projects || []).map((p) => p.slug);

  try {
    sec('起一个临时中枢（临时数据根、随机端口，绝不碰用户那一份）');
    let hub = await bootHub();
    ok('中枢起来了，且 run\\hub.lock 已落盘', fs.existsSync(path.join(root, 'run', 'hub.lock')));

    sec('启动时把数据根里的旧部署收编进了列表');
    const s1 = await state();
    const legacy = (s1.projects || []).find((p) => p.legacy);
    ok('列表里有那条旧部署', Boolean(legacy), JSON.stringify(slugs(s1)));
    ok('它的运行目录就是数据根', legacy && path.resolve(legacy.runtimeDir) === path.resolve(root), legacy && legacy.runtimeDir);
    ok('另一个项目也在', slugs(s1).includes('other-deadbeef'));

    sec('重启中枢：同一条旧部署不会再被收编出一条');
    // 这条走的是真的启动路径（hub.mjs 的启动段），库层那条只测了 migrateLegacy 本身。
    hub.child.kill();
    await sleep(800);
    hub = await bootHub();
    const s1b = await state();
    ok('旧部署仍然只有一条', (s1b.projects || []).filter((p) => p.legacy).length === 1, JSON.stringify(slugs(s1b)));
    ok('文件里也只有一条', JSON.parse(fs.readFileSync(path.join(root, 'projects.json'), 'utf8')).projects.filter((p) => p.legacy).length === 1);

    sec('删除并清盘：短语与状态守卫');
    const del = `/api/projects/${legacy.slug}?purge=1`;
    const wrong = await call(del, { method: 'DELETE', body: { confirmText: '删了吧' } });
    ok('确认短语不对 → 400', wrong.status === 400, `${wrong.status} ${wrong.text}`);
    const noJson = await call(del, { method: 'DELETE', body: null });
    ok('没给 JSON body → 被护栏挡下（非 GET 必须 application/json）', noJson.status >= 400, String(noJson.status));

    // 让数据库「在跑」：占住它配置里的那个端口，看守卫认不认。**不是**去起真库。
    const occupied = net.createServer();
    await new Promise((resolve, reject) => {
      occupied.once('error', reject);
      occupied.listen({ host: '0.0.0.0', port: PG_PORT }, resolve);
    });
    const busy = await call(del, { method: 'DELETE', body: { confirmText: '删除项目' } });
    ok('数据库端口上有人在跑 → 409 拒绝（按名字清盘不容忍「删一半」）', busy.status === 409, `${busy.status} ${busy.text}`);
    ok('拒绝理由指名道姓说了是库', /数据库端口\s*\d+\s*上还有/.test(busy.text), busy.text);
    ok('被拒绝时磁盘一字未动',
      fs.existsSync(path.join(root, 'src', 'package.json')) && fs.existsSync(path.join(root, 'config', 'panel.json')));
    ok('被拒绝时列表里也还在', slugs(await state()).includes(legacy.slug));
    await new Promise((r) => occupied.close(r));

    sec('真的清盘');
    const done = await call(del, { method: 'DELETE', body: { confirmText: '删除项目' } });
    ok('200', done.status === 200, `${done.status} ${done.text}`);
    ok('响应标了 legacy', done.data && done.data.legacy === true, JSON.stringify(done.data));
    ok('响应标了 scoped', done.data && done.data.purge && done.data.purge.mode === 'scoped', JSON.stringify(done.data && done.data.purge));
    ok('报了删掉几项', done.data && done.data.purge.removed.length >= 8, JSON.stringify(done.data && done.data.purge.removed));

    sec('磁盘上：删该删的，留该留的');
    for (const rel of ['src', 'node', 'pgsql', 'pgdata', 'tmp', 'config/panel.json', 'run/panel.lock', 'run/app.json', 'logs/app.log']) {
      ok('删掉了 ' + rel, !fs.existsSync(path.join(root, rel)));
    }
    ok('数据根本身还在', fs.existsSync(root));
    for (const rel of ['projects.json', 'config/hub.secret', 'run/hub.lock', 'logs/hub.log', 'projects/other-deadbeef/src/package.json']) {
      ok('留住了 ' + rel, fs.existsSync(path.join(root, rel)));
    }
    ok('注册表里只剩另一个项目', slugs(await state()).join() === 'other-deadbeef', JSON.stringify(slugs(await state())));
    ok('而中枢自己还活着（还在应答）', (await call('/api/hub/state')).status === 200);

    sec('重启中枢：它不会自己回来');
    hub.child.kill();
    await sleep(800);
    const hub2 = await bootHub();
    ok('重启后列表里没有旧部署', !(await state()).projects.some((p) => p.legacy), JSON.stringify(slugs(await state())));
    ok('这一笔真的落进了 projects.json', (JSON.parse(fs.readFileSync(path.join(root, 'projects.json'), 'utf8')).ignoredRepos || []).length === 1);

    sec('把部署文件放回去再重启：仍然不回来');
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'package.json'), '{"name":"legacy"}');
    fs.mkdirSync(path.join(root, 'config'), { recursive: true });
    fs.writeFileSync(path.join(root, 'config', 'panel.json'), JSON.stringify({ repoDir: REPO, panelPort: 8800, appPort: 3000, pgPort: PG_PORT }));
    hub2.child.kill();
    await sleep(800);
    await bootHub();
    ok('文件放回去了，但它还是没有自己回来', !slugs(await state()).includes(legacy.slug), JSON.stringify(slugs(await state())));

    sec('用「添加项目」把它加回来：那一笔被撤销');
    const added = await call('/api/projects', { method: 'POST', body: { repoDir: REPO } });
    ok('添加成功', added.status === 200 && added.data.ok, `${added.status} ${added.text}`);
    ok('「别再自动收编」那一笔被划掉了', (JSON.parse(fs.readFileSync(path.join(root, 'projects.json'), 'utf8')).ignoredRepos || []).length === 0);
    const backSlug = added.data.project.slug;
    ok('列表里又有了，这次是普通项目（运行目录在 projects\\ 下）',
      (await state()).projects.some((p) => p.slug === backSlug && !p.legacy));

    sec('移出列表（不清盘）：文件一个不动');
    // body: {} 不是可有可无的：护栏对 /api/ 下所有非 GET 都要 application/json，
    // 界面曾经漏掉它，于是「移出列表」静默变成一条 415。这里照着修好后的界面发。
    const forget = await call(`/api/projects/${backSlug}`, { method: 'DELETE', body: {} });
    ok('200', forget.status === 200, `${forget.status} ${forget.text}`);
    ok('响应标了 legacy:false（普通项目）', forget.data && forget.data.legacy === false, JSON.stringify(forget.data));
    ok('运行目录还在', fs.existsSync(added.data.project.runtimeDir));
  } finally {
    for (const c of children) {
      try {
        c.kill();
      } catch {}
    }
    await sleep(400);
    try {
      fs.rmSync(base, { recursive: true, force: true });
    } catch {}
  }
}

if (E2E) await e2e();
else await libraryChecks();

console.log('');
if (failures) {
  console.log('✕ ' + failures + ' 项失败。');
  process.exit(1);
}
console.log(E2E
  ? '✓ 端到端：旧部署能从中枢里被清盘，而中枢自己、另一个项目、以及「删了又回来」那个坑都各就各位。'
  : '✓ 旧部署能删能清盘，而中枢自己的注册表、密钥、引擎与别的项目都还在。');
