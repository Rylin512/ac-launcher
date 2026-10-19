// 「原仓库一个字节没动」这件事的取证工具。
//
// 这里只放**机制**（清单的采集与比对），命令行在 verify-repo.mjs。
// 分开是为了让「加了 --include-deploy」与「比对逻辑」各改各的：早先两者在一个文件里，
// 而 EXCLUDE_TOP 恰好排除了 deploy/，于是「仓库零改动」这句保证里最难证的那一半
// （我们自己新加的那个目录）从来没有被真正比对过。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 默认排除的顶层目录。
 *
 * `deploy/` 与 `ac-launcher/` 都在这份清单里，理由**只对旧布局成立**：它们曾经是
 * 「我们自己新增、且会被迭代修改」的目录，纳入比对只会产生自噪声。
 * 但启动器独立出去之后，`deploy/` 变成了**被冻结的参考实现**——它不该再变，
 * 于是它必须被纳入比对。这个矛盾由 `includeDeploy` 显式解决，而不是靠改这份默认值：
 * 默认保持兼容（老调用点行为不变），要证冻结的人明确说 --include-deploy。
 */
export const EXCLUDE_TOP = ['deploy', 'node_modules', '.next', '.git', 'coverage'];

/** 递归采集 {rel, size, hash}，按 rel 排序。rel 一律用正斜杠，跨平台可比。 */
export function manifest(root, { includeDeploy = false } = {}) {
  const skip = EXCLUDE_TOP.filter((n) => !(includeDeploy && n === 'deploy'));
  const rows = [];
  (function walk(dir, rel) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (rel === '' && skip.includes(e.name)) continue;
      const abs = path.join(dir, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) {
        // 与 config.mjs 的 listFiles 同一取向：读不到的文件不参与比对，而不是让整次
        // 取证崩掉。取证工具本身失败一次，这个保证就再没人跑了。
        let buf;
        try {
          buf = fs.readFileSync(abs);
        } catch {
          continue;
        }
        rows.push({ rel: r.replace(/\\/g, '/'), hash: crypto.createHash('sha256').update(buf).digest('hex'), size: buf.length });
      }
    }
  })(root, '');
  rows.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return rows;
}

export function serialize(rows) {
  return rows.map((r) => `${r.rel}|${r.size}|${r.hash}`).join('\n') + '\n';
}

export function parse(text) {
  const m = new Map();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // 两种分隔符都要认：本工具写竖线，而磁盘上真实存在一份**制表符**写的基线
    // （verify\freeze-before.txt，实施前手工采的）。只认竖线的话那一份会被解析成
    // 0 条，然后 compare 会把当前仓库的每个文件都报成「新增」—— 一份完全正确、
    // 逐字节没被碰过的仓库，被工具说成面目全非。取证工具最坏的失败不是报错，
    // 是给出一个自信的错答案。
    const parts = line.includes('|') ? line.split('|') : line.split('\t');
    if (parts.length !== 3) continue;
    if (/^[0-9a-f]{64}$/.test(parts[0])) m.set(parts[2], { size: Number(parts[1]), hash: parts[0] });
    else m.set(parts[0], { size: Number(parts[1]), hash: parts[2] });
  }
  return m;
}

/** 比对两份清单，返回分类后的差异。 */
export function compare(before, rows) {
  const after = new Map(rows.map((r) => [r.rel, { size: r.size, hash: r.hash }]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [rel, v] of after) {
    if (!before.has(rel)) added.push(rel);
    else if (before.get(rel).hash !== v.hash) changed.push(rel);
  }
  for (const rel of before.keys()) if (!after.has(rel)) removed.push(rel);
  return { added, removed, changed, beforeCount: before.size, afterCount: after.size };
}
