#!/usr/bin/env node
// 证明「界面里的反馈链路没有断」的小工具。
//
//   node verify-ui.mjs [页面路径]     默认检查 ui/index.html（面板）
//   node verify-ui.mjs hub-ui/index.html
//
// 为什么值得单独有一个工具：浮窗上那条「状态见『任务面板』→」是个**跳转**，
// 而跳转的失败方式是**静默的**——卡片 id 改了个字母、或者 report() 的宿主
// 写成了别的元素，页面加载不报错、按钮不报错、浮窗照弹，只是点了没反应，
// 或者提示条写到了一个看不见的地方。这类错误人眼review不出来，机器一秒就能查。
//
// 检查三件事：
//   1. WHERE 里每个跳转目标 id，在 HTML 里真有这个元素
//   2. 每处 report(hostId, …) 的 hostId 真存在，且按约定是个 *Notes 提示条容器
//   3. 每处 toast(…) 的 where 参数要么是 null，要么是 WHERE 里登记的键
// 外加：WHERE 里登记了却没人用的键（死条目）也报出来。
//
// 接受文件路径参数是必需的，不是顺手加的：中枢页要用**同一个**检查器裁决，
// 否则「两个页面共用一套约定」这句话就没有任何东西在保证。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI = process.argv[2] ? path.resolve(process.argv[2]) : path.join(HERE, 'ui', 'index.html');

let raw;
try {
  raw = fs.readFileSync(UI, 'utf8');
} catch (e) {
  console.error(`读不到页面：${UI}\n  ${e.message}`);
  process.exit(1);
}

/**
 * 把注释涂成空格，**保留全部偏移与换行**。
 *
 * 为什么必须这么做：面板页里有一处注释写着 `report()` 三个字（讲解 setNotes 为什么
 * 得同时接受元素和对象）。扫描器把它算成了一次真实调用，于是打印「46 项检查」而
 * README 写的是 45 —— 一个数字要靠解释才说得通的检查器没人会信。
 *
 * 只涂注释，**不涂字符串**：callSites 需要原样读到字符串字面量才能判断
 * report('xNotes', …) 的宿主名（literal() 就是靠引号解析的），而字符串本身干扰不到
 * 扫描 —— callSites 自己会跳过引号里的内容。
 *
 * 不认识正则字面量：`/…/` 里的 `//` 或 `/*` 会被误当注释。本仓库的页面里没有这种
 * 写法；真出现了也只会**少算**检查项，不会把坏代码判成好代码。
 */
function maskComments(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to && k < out.length; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; i += 1; continue; }
    if (c === '/' && src[i + 1] === '/') {
      // `https://` 里的那对斜杠不是注释开头——前面是冒号就不当注释
      if (src[i - 1] === ':') { i += 2; continue; }
      const e = src.indexOf('\n', i);
      blank(i, e === -1 ? src.length : e);
      i = e === -1 ? src.length : e;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const e = src.indexOf('*/', i + 2);
      const end = e === -1 ? src.length : e + 2;
      blank(i, end);
      i = end;
      continue;
    }
    i += 1;
  }
  return out.join('');
}

const html = maskComments(raw);
const problems = [];
const notes = [];
let checks = 0;

/** HTML 里是否有这个 id 的元素。只认标记里的 id=，不认 JS 里的 $('x')，否则会自我满足。 */
const hasId = (id) => new RegExp(`id\\s*=\\s*["']${id}["']`).test(html);

/**
 * 把 `name(...)` 的每次调用切出来，返回各参数原文。
 *
 * 要自己配平括号而不能用正则：参数里有 `(d.error || '')` 这种嵌套，
 * 还有跨行的模板串。所以扫字符、认引号、数深度。
 * 认到反引号就一路吞到配对的收尾反引号——模板串里的括弧不算数。
 */
function callSites(src, name) {
  const out = [];
  const re = new RegExp(`(?<![\\w$.])${name}\\s*\\(`, 'g');
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    const args = [];
    let start = i;
    let depth = 1;
    let quote = null;
    for (; i < src.length; i++) {
      const c = src[i];
      if (quote) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === "'" || c === '"' || c === '`') quote = c;
      else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        depth--;
        if (depth === 0) {
          args.push(src.slice(start, i));
          break;
        }
      } else if (c === ',' && depth === 1) {
        args.push(src.slice(start, i));
        start = i + 1;
      }
    }
    out.push({ index: m.index, line: src.slice(0, m.index).split('\n').length, args: args.map((a) => a.trim()) });
  }
  return out;
}

/** 参数是不是一个字面量字符串？是就返回内容，不是返回 undefined。 */
function literal(arg) {
  const m = /^(['"])(.*)\1$/s.exec(arg || '');
  return m ? m[2] : undefined;
}

// ---------- 取 WHERE 表 ----------
const whereBlock = /const\s+WHERE\s*=\s*\{([\s\S]*?)\n\};/.exec(html);
if (!whereBlock) {
  problems.push('找不到 `const WHERE = {…}`。跳转目标表没了，浮窗上的「状态见『…』」全部失效。');
} else {
  const where = {};
  for (const line of whereBlock[1].split('\n')) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*:\s*\[\s*(['"])(.*?)\2\s*,\s*(['"])(.*?)\4\s*\]\s*,?/.exec(line);
    if (m) where[m[1]] = { label: m[3], target: m[5] };
  }
  const keys = Object.keys(where);
  notes.push(`WHERE 登记了 ${keys.length} 个跳转目标：${keys.join('、')}`);

  // 1. 目标 id 必须存在
  for (const [k, v] of Object.entries(where)) {
    checks++;
    if (!hasId(v.target)) {
      problems.push(`WHERE.${k} 指向 "${v.target}"，但 HTML 里没有这个 id —— 浮窗上的「状态见『${v.label}』」点了不会有任何反应。`);
    }
  }

  // 2. report() 的宿主
  const used = new Set();
  for (const call of callSites(html, 'report')) {
    const host = literal(call.args[0]);
    const whereArg = literal(call.args[3]);
    checks++;
    if (host === undefined) {
      notes.push(`第 ${call.line} 行 report() 的宿主是个表达式而非字面量 id，跳过检查。`);
    } else if (!hasId(host)) {
      problems.push(`第 ${call.line} 行 report('${host}', …) 的宿主元素不存在 —— 浮窗会弹，但就地那条提示条会静默丢失。`);
    } else if (!/Notes$/.test(host)) {
      problems.push(`第 ${call.line} 行 report('${host}', …) 不像个提示条容器（按约定应以 Notes 结尾）—— 传错了元素的话 setNotes 会写进一块不该动的区域。`);
    }
    // report() 的第 4 个参数是 where 键，它被原样转交给 toast()。
    // 所以这里也要验，不能只验字面上的 toast(…) 调用——这一条是变异测试
    // （把 where 键改成 'helth'）逼出来的：那个错从一开始就溜过去了。
    if (whereArg === undefined) {
      notes.push(`第 ${call.line} 行 report() 的 where 是表达式，跳过检查。`);
    } else if (!(whereArg in where)) {
      problems.push(`第 ${call.line} 行 report(…, '${whereArg}') 的 where 不在 WHERE 表里 —— 那条浮窗会退化成纯文本，跳转没了。`);
    } else {
      used.add(whereArg);
    }
  }

  // 3. toast() 的 where 参数
  for (const call of callSites(html, 'toast')) {
    if (call.args.length < 3) {
      problems.push(`第 ${call.line} 行 toast() 只传了 ${call.args.length} 个参数，where 缺失。`);
      continue;
    }
    const whereArg = literal(call.args[2]);
    checks++;
    if (whereArg === undefined) {
      if (/^null$/.test(call.args[2])) continue; // 有意不指示去向，合法
      notes.push(`第 ${call.line} 行 toast() 的 where 是表达式，跳过检查。`);
    } else if (!(whereArg in where)) {
      problems.push(`第 ${call.line} 行 toast(…, '${whereArg}') 的 where 不在 WHERE 表里 —— 链接拼不出来，那条浮窗会退化成一个纯文本。`);
    } else {
      used.add(whereArg);
    }
  }

  // 4. 死条目
  for (const k of keys) {
    checks++;
    if (!new RegExp(`['"]${k}['"]`).test(html.replace(whereBlock[0], ''))) {
      problems.push(`WHERE.${k} 登记了却没有任何调用方在用 —— 多半是改代码时剩下来的，删掉或接上。`);
    }
  }
}

// ---------- 浮窗容器 ----------
checks++;
if (!hasId('toasts')) {
  problems.push('找不到浮窗容器 `id="toasts"` —— toast() 会朝一个不存在的节点里塞东西，全部反馈静默消失。');
}

// ---------- 输出 ----------
console.log(`检查 ${path.relative(process.cwd(), UI)}`);
for (const n of notes) console.log('  · ' + n);
console.log('');
for (const p of problems) console.log('  ✗ ' + p);
if (problems.length === 0) {
  console.log(`✓ 反馈链路完整：${checks} 项检查全部通过。`);
  process.exit(0);
} else {
  console.log(`\n✗ ${problems.length} 项有问题（共 ${checks} 项检查）。`);
  process.exit(1);
}
