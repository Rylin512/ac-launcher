#!/usr/bin/env node
// 把 hub-ui/index.html 里的脚本**真跑一遍**，喂给它真实形状的状态载荷。
//
//   node verify-hub-render.mjs              用内置夹具跑
//   node verify-hub-render.mjs --live       顺带用 http://127.0.0.1:8788 的真实载荷跑
//
// 为什么需要这个：中枢页的 render() 曾经在第 5 行就抛 undefined.length
// （写成 h.projects.length，而 hub 对象根本没有 projects 字段），于是**它后面的每一行
// 都没在浏览器里执行过** —— 画项目卡片、指纹去抖、空列表占位，全是未验证代码。
// 一个「从来没跑过的渲染路径」和「跑起来是对的」在外表上完全一样，静态检查也看不出来：
// verify-ui.mjs 只检查 report() 的调用点，看不懂一个属性读的是谁。
//
// 它证明的是「这段渲染逻辑不再抛异常、并且产出了预期的内容」，**不是**「长得好看」。
// 版式、CSS、真实浏览器的布局仍然只能靠眼睛。
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = path.join(HERE, 'hub-ui', 'index.html');

/* ---------------------------------------------------------------- DOM 桩
 * 只实现脚本真正用到的那点表面积（见文件末尾的清单）。刻意**不**追求还原浏览器：
 * 这里要抓的错误是「读了一个不存在的属性」，那种错误在任何忠实的实现里都会抛。 */
class Node {
  constructor(tag = 'div') {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.dataset = {};
    this.style = {};
    this._text = '';
    this._html = '';
    this.className = '';
    this.classList = {
      add: () => {},
      remove: () => {},
      contains: () => false,
      toggle: () => {},
    };
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  // 跟真实 DOM 一样把后代的文字算进来：日志视图正是靠 appendChild 一行行堆出来的，
  // 只回 _text 的话「日志渲染了没有」就永远断言不到。
  get textContent() {
    if (this.children.length) return this.children.map((c) => c.textContent).join('');
    return this._text;
  }
  set innerHTML(v) { this._html = String(v); }
  get innerHTML() { return this._html; }
  appendChild(c) { this.children.push(c); return c; }
  remove() {}
  // 真实 DOM 会解析 HTML 再返回节点。桩不解析，但**必须按选择器返回同一个节点**：
  // note() 是「createElement → innerHTML → querySelector('.ic').textContent = '✓'」这么
  // 写的，每次返回新节点的话那些字全落进一个没人引用的临时对象里，于是
  // host.textContent 永远读不出任何提示语——「报错有没有告诉用户」这件事就断言不到。
  // 同时把它挂进 children，好让 textContent 像真实 DOM 那样把后代的文字算进来。
  querySelector(sel) {
    if (!this._q) this._q = new Map();
    if (!this._q.has(sel)) {
      const n = new Node('span');
      this._q.set(sel, n);
      this.children.push(n);
    }
    return this._q.get(sel);
  }
  querySelectorAll() { return []; }
  addEventListener() {}
  removeEventListener() {}
  scrollIntoView() {}
  // 「重新分配端口」的弹窗在 await 之后要问一句「我是不是已经被关掉了」，
  // 桩里没有这个方法就会抛在 async 函数里——表现为那条断言莫名失败。
  contains(n) { return this === n || this.children.includes(n); }
  get offsetWidth() { return 0; }
}

function makeDocument() {
  const byId = new Map();
  const doc = {
    documentElement: new Node('html'),
    body: new Node('body'),
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, new Node('div'));
      return byId.get(id);
    },
    createElement: (tag) => new Node(tag),
    querySelector: () => new Node('div'),
  };
  // 脚本要读回写进这些容器的内容，所以得能拿到同一批节点。
  doc.__byId = byId;
  return doc;
}

/** 载入脚本，返回 { render, host }。host 用来读回渲染结果。 */
function boot() {
  const html = fs.readFileSync(UI, 'utf8');
  const m = /<script>([\s\S]*?)<\/script>/.exec(html);
  if (!m) {
    console.error('hub-ui/index.html 里找不到 <script> 块。');
    process.exit(2);
  }
  const doc = makeDocument();
  const sandbox = {
    document: doc,
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    setTimeout,
    clearTimeout,
    Node,
    console,
    EventSource: class { constructor() {} addEventListener() {} },
    // 路由表默认是空的：没配过的路径就抛，免得测试悄悄打真网络。
    fetch: (url, opts) => {
      const key = String(url).split('?')[0];
      const fn = sandbox.__routes[key];
      if (!fn) throw new Error('本测试没有为 ' + key + ' 配置响应');
      return fn(url, opts);
    },
    __routes: {},
    window: { open: () => {} },
    confirm: () => false,
    URL,
    Date,
  };
  sandbox.globalThis = sandbox;
  const ctx = vm.createContext(sandbox);
  try {
    vm.runInContext(m[1], ctx, { filename: 'hub-ui/index.html<script>' });
  } catch (e) {
    console.error('脚本在**载入期**就抛了：' + e.message);
    process.exit(2);
  }
  if (typeof ctx.render !== 'function') {
    console.error('脚本载入后拿不到 render()，无法继续。');
    process.exit(2);
  }
  return { ctx, render: ctx.render, doc, sandbox };
}

/* ---------------------------------------------------------------- 夹具 */
const project = (over = {}) => ({
  slug: 'demo-aaaaaaaa',
  name: 'demo',
  repoDir: 'C:\\demo',
  runtimeDir: 'C:\\demo-rt',
  legacy: false,
  // ports 是**显示缓存**（权威在那个项目自己的 config/panel.json 里），但卡片要读它。
  // 夹具最初漏了这个字段，于是测试在 projectCard 里炸成 undefined.panel ——
  // 算是这套夹具自己的价值演示：漏一个字段就是一次白屏。
  ports: { panel: 8800, app: 3080, pg: 55433 },
  addedAt: 1790000000000,
  lastOpenedAt: 1790000000001,
  repoOk: true,
  // 端口重分配是否进行中。夹具少了它就是 undefined.pending —— 和当初漏掉 ports
  // 那次是同一个形状的错：卡片整块画不出来，而静态检查看不出来。
  pending: null,
  panel: { running: false, port: 8800, pid: null, staleLock: false, url: null },
  app: { state: 'stopped', port: 3080, pid: null, uptimeSec: null, urlLocal: 'http://localhost:3080', urlLan: null, logTail: [] },
  db: { state: 'stopped', mode: 'portable', port: 55433, host: '127.0.0.1', version: null, pid: null, dsnLabel: 'portable :55433', portableInstalled: true },
  ready: { deps: false, env: false, built: false, repo: true },
  problems: [{ level: 'warn', code: 'NO_DEPS', text: '依赖未安装（打开面板 → 一键部署）' }],
  // 字段名对齐真实载荷（已 curl 核对）：config 有 dbMode / builtAt / sourceHash。
  config: { dbMode: 'portable', builtAt: 1790514067322, sourceHash: 'sha256:78ef68d9c24…' },
  ...over,
});

const state = (projects) => ({
  hub: {
    pid: 1, port: 8788, version: '0.1.0', mode: 'source',
    uptimeSec: 61, runtimeDir: 'C:\\rt', registryFile: 'C:\\rt\\projects.json', nodeVersion: 'v24.18.0',
  },
  net: { lanIp: '192.168.1.5' },
  projects,
  at: Date.now(),
});

/* ---------------------------------------------------------------- 断言 */
let failures = 0;
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
function pass(name, e) {
  if (e) {
    failures += 1;
    console.log('  ✕ ' + name + '\n      ' + e.message);
    if (process.env.AC_TRACE) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'));
  } else {
    console.log('  ✓ ' + name);
  }
}
function check(name, fn) {
  try { fn(); pass(name); } catch (e) { pass(name, e); }
}
async function checkAsync(name, fn) {
  try { await fn(); pass(name); } catch (e) { pass(name, e); }
}
/** api() 走的是 res.text() 再判 res.ok，桩要照这个顺序来。 */
const ok = (data) => ({ ok: true, status: 200, text: async () => JSON.stringify(data) });

/* ---------------------------------------------------------------- 跑 */
console.log('hub-ui 渲染冒烟测试：' + UI);
console.log('');

const { ctx, render, doc, sandbox } = boot();
const route = (key, fn) => { sandbox.__routes[key] = fn; };
const list = () => doc.getElementById('projectList').innerHTML;
const pill = () => doc.getElementById('hubPillText').textContent;

console.log('夹具：');
check('一个正常的项目能画出来', () => {
  render(state([project()]));
  assert(list().includes('demo-aaaaaaaa'), '项目卡片里没有 slug');
  assert(list().includes('项目详情') === false, 'sanity');
  assert(pill().includes('1 个项目'), '顶部计数不对：' + pill());
});
check('多个项目都在', () => {
  render(state([project({ slug: 'a-11111111', name: 'A' }), project({ slug: 'b-22222222', name: 'B' })]));
  assert(list().includes('a-11111111') && list().includes('b-22222222'), '两个项目没都画出来');
  assert(pill().includes('2 个项目'), '计数不对：' + pill());
});
check('旧部署标记会显示', () => {
  render(state([project({ legacy: true })]));
  assert(list().includes('收编的旧部署'), 'legacy 标记没出现');
});
check('读不到状态的项目走 error 分支', () => {
  render(state([project({ error: '仓库目录不存在' })]));
  assert(list().includes('读取状态失败'), 'error 分支没渲染');
  assert(list().includes('移出列表'), 'error 分支缺「移出列表」按钮');
});
check('problems 为空时显示「一切就绪」', () => {
  render(state([project({ problems: [] })]));
  assert(list().includes('一切就绪'), '空 problems 没走 good 分支');
});
check('项目列表为空时显示占位文案', () => {
  render(state([]));
  assert(list().includes('还没有登记任何项目'), '空列表没占位：' + list().slice(0, 80));
  assert(pill().includes('0 个项目'), '计数不对：' + pill());
});
check('projects 字段整个缺失也不该白屏', () => {
  const s = state([]);
  delete s.projects;
  render(s);
  assert(pill().includes('0 个项目'), '缺 projects 时不该抛：' + pill());
});
check('各种状态的标签都能渲染', () => {
  render(state([
    project({ app: { ...project().app, state: 'running', port: 3080, uptimeSec: 120 } }),
    project({ db: { ...project().db, state: 'running', pid: 5 } }),
    project({ panel: { ...project().panel, running: true, port: 8800 } }),
    project({ ready: { deps: true, env: true, built: true, repo: true } }),
  ]));
  assert(list().includes('运行中'), '没有渲染出运行中的标签');
});
check('指纹去抖：同一份数据重复渲染不重绘', () => {
  const s = state([project()]);
  render(s);
  const first = list();
  doc.getElementById('projectList').innerHTML = '哨兵';
  render(s); // 完全相同的输入
  assert(list() === '哨兵', '相同输入竟然重绘了（会打断鼠标悬停）');
  // 换个真的会改变长相的字段，应该重绘
  render(state([project({ app: { ...project().app, state: 'running' } })]));
  assert(list() !== '哨兵', '状态变了却不重绘');
  assert(first !== null, 'sanity');
});

console.log('');
console.log('重新分配端口：');
/** 从渲染结果里抠出那个按钮的整个标签，好断言它的属性。 */
const reallocTag = () => (/<button[^>]*data-act="realloc"[^>]*>/.exec(list()) || [''])[0];

check('按钮在，且默认可用', () => {
  render(state([project({ pending: null })]));
  const tag = reallocTag();
  assert(tag.includes('data-slug="demo-aaaaaaaa"'), '按钮没带上 slug：' + tag);
  assert(!tag.includes('disabled'), '没有任务在跑，按钮不该禁用：' + tag);
  assert(list().includes('重新分配端口…'), '按钮文案不对：' + tag);
});
check('重分配进行中：按钮禁用 + 卡片上有说明', () => {
  render(state([project({ pending: { kind: 'realloc', startedAt: 1790000000000 } })]));
  const tag = reallocTag();
  assert(tag.includes('disabled'), '任务在跑，按钮该禁用：' + tag);
  // 服务会依次显示为「停着」，这条标签是唯一的线索：它是被我们停的，不是坏了。
  assert(list().includes('正在重新分配端口…'), '卡片上没有「进行中」的标记');
});
check('pending 变化会重绘、不变则不重绘', () => {
  const busy = state([project({ pending: { kind: 'realloc', startedAt: 1 } })]);
  render(busy);
  doc.getElementById('projectList').innerHTML = '哨兵';
  render(busy);
  assert(list() === '哨兵', '相同 pending 竟然重绘了');
  render(state([project({ pending: null })]));
  assert(list() !== '哨兵', 'pending 从有到无却不重绘（按钮会一直禁用着）');
});
check('ports.* 进了指纹：端口改了卡片就会跟着变', () => {
  // 卡片「端口」那行渲染的是 p.ports.*，而指纹原先收的是 p.panel.port / p.app.port，
  // 两者同源所以一直没暴露。重分配正好让它们变化——不并进指纹，改完端口卡片会一直
  // 显示旧数字，看起来像功能没生效。
  render(state([project({ ports: { panel: 8800, app: 3080, pg: 55433 } })]));
  doc.getElementById('projectList').innerHTML = '哨兵';
  render(state([project({ ports: { panel: 8801, app: 3100, pg: 55434 } })]));
  assert(list() !== '哨兵', 'ports 变了却不重绘');
  assert(list().includes('8801') && list().includes('3100') && list().includes('55434'), '卡片没显示新端口');
});

await checkAsync('弹窗能渲染出建议值、当前值与影响面', async () => {
  const busy = project({ app: { ...project().app, state: 'running', port: 3080 } });
  render(state([busy]));
  route('/api/projects/demo-aaaaaaaa/ports', () => ok({
    ok: true,
    current: { panel: 8800, app: 3080, pg: 55433 },
    suggested: { panel: 8801, app: 3100, pg: 55434 },
    portable: true,
    pending: null,
  }));
  await ctx.confirmRealloc(busy);
  const html = doc.body.children[doc.body.children.length - 1].innerHTML;
  assert(/value="8801"/.test(html) && /value="3100"/.test(html) && /value="55434"/.test(html), '建议值没填进输入框');
  assert(html.includes('当前 8800'), '没显示当前值，用户没法比较');
  for (const k of ['panel', 'app', 'pg']) assert(html.includes('data-port="' + k + '"'), '缺输入框：' + k);
  assert(html.includes('应用（:3080）'), '没列出会被停掉的服务');
  assert(html.includes('数据库里的数据不会被改动'), '没讲清数据不动——这是用户最怕的那件事');
  assert(html.includes('控制面板窗口会被关掉'), '没提醒面板窗口会被关');
});

await checkAsync('外部库模式下数据库端口是禁用的，并说明原因', async () => {
  render(state([project({ config: { dbMode: 'external', builtAt: null, sourceHash: null } })]));
  route('/api/projects/demo-aaaaaaaa/ports', () => ok({
    ok: true,
    current: { panel: 8800, app: 3080, pg: 5432 },
    suggested: { panel: 8801, app: 3100, pg: 5432 },
    portable: false,
    pending: null,
  }));
  await ctx.confirmRealloc(project());
  const html = doc.body.children[doc.body.children.length - 1].innerHTML;
  assert(/data-port="pg"[^>]*disabled/.test(html), '外部库的 pg 输入框该是禁用的');
  assert(html.includes('外部库，不由中枢分配'), '没说明为什么不能改');
});

await checkAsync('取建议值失败时如实报错，不静默', async () => {
  render(state([project()]));
  route('/api/projects/demo-aaaaaaaa/ports', () => ({ ok: false, status: 500, text: async () => JSON.stringify({ error: { message: '探不动' } }) }));
  await ctx.confirmRealloc(project());
  assert(doc.getElementById('opNotes').textContent.includes('探不动'), '失败没有反馈给用户');
});

console.log('');
console.log('点击之后才走到的分支（同样从未在浏览器里执行过）：');
await checkAsync('详情卡片能渲染', async () => {
  render(state([project()]));
  ctx.showDetail(project());
  const body = doc.getElementById('detailBody').innerHTML;
  for (const k of ['名称', '标识', '仓库目录', '运行目录', '源码哈希', '数据库', '最近打开']) {
    assert(body.includes(k), '详情卡片缺字段：' + k);
  }
  assert(body.includes('sha256:78ef68d9c24'), '源码哈希的值没渲染出来');
});
await checkAsync('详情卡片遇到「还没部署过」的项目不该炸', async () => {
  render(state([project()]));
  // 可达的那个边界不是「缺 panel/app/db」——showDetail 的入参来自 findProject()，
  // 而它只会在中枢的载荷里找，那份载荷每条都带 panel/app/db。真正会缺的是**部署过才会有**
  // 的那两个：config.sourceHash 与 config.builtAt（刚加进来的项目就是这样的）。
  ctx.showDetail(project({ config: { dbMode: null, builtAt: null, sourceHash: null }, lastOpenedAt: null }));
  const body = doc.getElementById('detailBody').innerHTML;
  assert(body.includes('未记录'), '缺 sourceHash 时应显示「未记录」');
  assert(body.includes('—'), '缺 builtAt 时应显示「—」');
});
await checkAsync('日志能渲染出行', async () => {
  render(state([project()]));
  route('/api/projects/demo-aaaaaaaa/logs', () => ok({
    file: 'panel', size: 42, truncated: false, mtime: 1,
    lines: [{ seq: 1, text: '正常一行' }, { seq: 2, text: 'ERROR 出错了' }],
  }));
  await ctx.loadLogs('demo-aaaaaaaa', 'panel');
  const t = doc.getElementById('logView').textContent;
  assert(t.includes('正常一行'), '日志正文没渲染：' + JSON.stringify(t));
  assert(t.includes('ERROR 出错了'), '第二行没渲染');
  assert(doc.getElementById('logLabel').textContent.includes('panel'), '日志标题没更新');
});
await checkAsync('空日志显示占位文案', async () => {
  render(state([project()]));
  route('/api/projects/demo-aaaaaaaa/logs', () => ok({ file: 'panel', size: 0, truncated: false, mtime: 0, lines: [] }));
  await ctx.loadLogs('demo-aaaaaaaa', 'panel');
  assert(doc.getElementById('logView').textContent.includes('这个日志还是空的'), '空日志没占位');
});

if (process.argv.includes('--live')) {
  console.log('');
  console.log('真实载荷：');
  check('当前运行中的中枢返回的载荷能渲染', () => {
    const out = execFileSync('curl', ['-s', 'http://127.0.0.1:8788/api/hub/state'], { encoding: 'utf8' });
    const live = JSON.parse(out);
    render(live);
    assert(pill().includes(live.projects.length + ' 个项目'), '真实载荷的计数不对：' + pill());
    for (const p of live.projects) assert(list().includes(p.slug), '卡片里缺 ' + p.slug);
    console.log('      （真实载荷里有 ' + live.projects.length + ' 个项目）');
  });
}

console.log('');
if (failures) {
  console.log('✕ ' + failures + ' 项失败。');
  process.exit(1);
}
console.log('✓ 渲染路径全部通过（这证明的是「不抛异常且内容对」，不是「长得好看」）。');
