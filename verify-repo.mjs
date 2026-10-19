#!/usr/bin/env node
// 证明「原仓库未被改动」的小工具。
//
//   node verify-repo.mjs --repo <仓库> save <清单文件>    采集当前仓库的文件哈希清单
//   node verify-repo.mjs --repo <仓库> diff <清单文件>    与清单比对
//
// 选项
//   --repo <路径>       要取证的仓库（默认沿用 config.mjs 的解析结果）
//   --include-deploy    把 deploy/ 也纳入比对
//
// 默认清单文件：<运行目录>/verify/repo-before.txt
//
// 为什么 --include-deploy 是必需的而不是锦上添花：默认排除项里有 `deploy/`，
// 而在旧布局里启动器正是长在仓库内部的 deploy/。于是「仓库零改动」这句保证里
// **唯一有可能被我们写坏的那部分**，恰好是唯一没被检查的那部分。启动器搬到仓库外
// 之后这条依然要显式打开——deploy/ 现在是冻结的参考实现，证它没变才叫冻结。
import fs from 'node:fs';
import path from 'node:path';
import { REPO_DIR, REPO_DIR_PROBLEM, defaultRuntimeDir, humanBytes } from './lib/config.mjs';
import { manifest, serialize, parse, compare } from './lib/verify.mjs';
import { slugify } from './lib/registry.mjs';

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const opt = (name) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
};

const positional = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--repo' || argv[i] === '--runtime-dir') {
    i += 1;
    continue;
  }
  if (argv[i].startsWith('-')) continue;
  positional.push(argv[i]);
}

const cmd = positional[0] || 'diff';
const includeDeploy = flag('--include-deploy');
const repo = opt('--repo') ? path.resolve(opt('--repo')) : REPO_DIR;

// 默认清单文件名里**必须带仓库标识**。早先它是固定的 repo-before.txt，于是
// 「给 A 存基线、再给 B 存基线」会把 A 的基线静默覆盖掉，而之后 A 的 diff 拿到的
// 是 B 的清单——两边都会报「有差异」，或者更糟：文件数凑巧相同就报「完全一致」，
// 而那份一致是拿错了对象的。取证工具给出错的对象比不给更坏。
const defaultManifest = () =>
  path.join(defaultRuntimeDir(), 'verify', `${repo ? slugify(repo) : 'repo'}-before.txt`);
const file = positional[1] || defaultManifest();

// 仓库解析不到就直接退出：对一个 null 做 manifest 会得到空清单，
// 而空清单与「完全一致」在输出上无法区分——那是最坏的一种取证失败。
if (!repo) {
  console.error(`无法确定要取证的仓库。${REPO_DIR_PROBLEM || ''}`);
  console.error('请显式指定：node verify-repo.mjs --repo <仓库> ' + cmd);
  process.exit(2);
}
if (!fs.existsSync(repo)) {
  console.error(`仓库目录不存在：${repo}`);
  process.exit(2);
}

const rows = manifest(repo, { includeDeploy });

if (cmd === 'save') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, serialize(rows), 'utf8');
  const bytes = rows.reduce((s, r) => s + r.size, 0);
  console.log(`已采集 ${rows.length} 个文件（${humanBytes(bytes)}）`);
  console.log(`清单写入：${file}`);
  console.log(`仓库目录：${repo}${includeDeploy ? '（含 deploy/）' : '（已排除 deploy/）'}`);
  process.exit(0);
}

if (cmd !== 'diff') {
  console.error(`未知命令：${cmd}（可用：save / diff）`);
  process.exit(2);
}

if (!fs.existsSync(file)) {
  console.error(`找不到清单文件：${file}`);
  console.error(`先跑一次：node verify-repo.mjs --repo "${repo}"${includeDeploy ? ' --include-deploy' : ''} save`);
  process.exit(2);
}

const before = parse(fs.readFileSync(file, 'utf8'));

// 基线解析出 0 条 = 这个文件不是我们认识的格式。绝不能继续往下比：
// compare 会把当前仓库的每个文件都算成「新增」，输出一份看似权威的差异报告，
// 而真相是这个仓库可能一个字节都没被动过。宁可什么都不说。
if (before.size === 0) {
  console.error(`基线文件解析不出任何条目：${file}`);
  console.error('它可能不是本工具写的（或格式已变）。请重新采集：');
  console.error(`  node verify-repo.mjs --repo "${repo}"${includeDeploy ? ' --include-deploy' : ''} save`);
  process.exit(2);
}

const { added, removed, changed, beforeCount, afterCount } = compare(before, rows);

console.log(`清单：${file}`);
console.log(`仓库：${repo}${includeDeploy ? '（含 deploy/）' : '（已排除 deploy/）'}`);
console.log(`基线 ${beforeCount} 个文件，当前 ${afterCount} 个文件`);
console.log('');
if (!added.length && !removed.length && !changed.length) {
  console.log('✓ 完全一致：原仓库没有任何文件被新增、删除或修改。');
  process.exit(0);
}
if (added.length) console.log(`新增 ${added.length}：\n  ${added.join('\n  ')}`);
if (removed.length) console.log(`删除 ${removed.length}：\n  ${removed.join('\n  ')}`);
if (changed.length) console.log(`修改 ${changed.length}：\n  ${changed.join('\n  ')}`);
console.log('');
console.log('✗ 存在差异。');
process.exit(1);
