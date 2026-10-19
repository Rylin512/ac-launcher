// 端口：候选范围、预约集合、以及一组端口的校验。**只有这一份定义。**
//
// 原先候选表住在 registry.mjs 里，只有「加项目」一个消费者。现在多了第二个消费者：
// 面板启动时遇到端口被占，要挑一个不撞别人预约的替代端口（被中枢管着时则直接报错）。
// 两个地方各写一份候选表迟早会漂移，而漂移的表现是「两个项目被分到同一张表里的
// 相邻端口，各自都觉得自己合规」——正是这套设计要防的那类静默冲突。
//
// 两条贯穿本文件的规则：
//
//  1. **端口按预约分配，不按「此刻是否在监听」。** portFree 只回答「现在有没有人
//     占着」，于是两个都停着的项目会被分到同一个端口——不报错，等到某天同时开跑
//     才炸。所以预约是持久的，写进每个项目自己的 config/panel.json。
//  2. **探测一律用 0.0.0.0。** 应用监听全网卡（process.mjs 的 HOSTNAME），面板与
//     Postgres 只绑 127.0.0.1。前者包含后者，所以两个进程不可能分别在
//     127.0.0.1:X 与 0.0.0.0:X 上共存——分配时必须按最宽的那个面去探。
//     portFree 的默认参数已经是 0.0.0.0，别「优化」成回环。
import { portFree, pickFreePort } from './sysinfo.mjs';

/**
 * 新项目的面板端口从这里起算。
 *
 * 起点是 8800 而不是紧随中枢默认端口 8788 的 8789：中枢端口自身被占时会顺延，
 * 顺延范围（8788–8799）必须与新项目的预约范围**结构上不相交**，否则一次顺延就
 * 可能与某个项目的预约撞车。留出这段空隙，这类冲突就不可能发生。
 */
export const PANEL_PORT_BASE = 8800;
export const PANEL_PORT_SPAN = 64;
/** 应用的候选端口：先试默认的 3000，再试 3080，最后在 3100–3199 里挑。 */
export const APP_PORT_CANDIDATES = [3000, 3080, ...Array.from({ length: 100 }, (_, i) => 3100 + i)];
/** 便携 Postgres 的候选端口。 */
export const PG_PORT_CANDIDATES = Array.from({ length: 10 }, (_, i) => 55432 + i);

/** 角色的中文名，报错文案里用。 */
export const PORT_LABELS = { panel: '面板', app: '应用', pg: '数据库' };
export const PORT_KEYS = ['panel', 'app', 'pg'];

export function panelPortCandidates() {
  return Array.from({ length: PANEL_PORT_SPAN }, (_, i) => PANEL_PORT_BASE + i);
}

/** 某个角色的候选表。报错文案与「候选耗尽」判定都要用它。 */
export function candidatesFor(key) {
  if (key === 'panel') return panelPortCandidates();
  if (key === 'app') return APP_PORT_CANDIDATES;
  if (key === 'pg') return PG_PORT_CANDIDATES;
  return [];
}

/**
 * 已被预约的端口集合（纯函数，无 I/O）。
 *
 * 含每个项目的 ports.*（三个角色一视同仁——只要有人占着，别人就不能拿）与中枢
 * 自己的端口。中枢端口与预约范围结构上不相交，但不能靠这个巧合吃饭。
 *
 * `avoid` 是**增量**参数：再额外避开这一组。重分配端口时传这个项目**当前的**端口。
 * 它与上面的 ports.* 不是重复：注册表里那份只是显示缓存，权威值是那个项目自己
 * `config/panel.json` 里的三个键，两者可能不一致。
 *
 * 这里曾经写成「把 avoid 里的端口从集合里**去掉**」（当时的名字还叫 exclude），
 * 理由是「从候选里让出自己，才挑得出不同的值」。正好相反——去掉之后它们立刻变成
 * 可选的，于是 allocatePorts 原样把它们发了回来，「重新分配」点了等于没点
 * （实测：current 与 suggested 三个值完全相同）。要挑出不同的值，唯一正确的做法是
 * 把旧值**一起避开**。不传 avoid 时行为与加项目那次分配逐字节一致。
 */
export function usedPorts(reg, { avoid = new Set() } = {}) {
  const used = new Set();
  for (const p of reg?.projects || []) {
    for (const n of Object.values(p?.ports || {})) if (Number.isInteger(n)) used.add(n);
  }
  for (const n of [reg?.hub?.port, reg?.hub?.actualPort]) if (Number.isInteger(n)) used.add(n);
  for (const n of avoid) if (Number.isInteger(n)) used.add(n);
  return used;
}

/**
 * 为**新**项目预约一组端口，或为**重新分配**挑一组新的。
 *
 * 每分配一个就并进 used 集合：同一次调用里的三个端口因此两两不同（否则三个角色
 * 会各自独立地挑中同一个空闲端口）。跨调用的互斥不在这里——那要靠调用方串行化，
 * 因为 used 是每次调用的局部集合。
 */
export async function allocatePorts(reg, { avoid = new Set() } = {}) {
  const used = usedPorts(reg, { avoid });
  const take = async (candidates) => {
    const avail = candidates.filter((p) => !used.has(p));
    const picked = await pickFreePort(avail); // 全被占时它会向内核要一个临时端口
    used.add(picked);
    return picked;
  };
  return {
    panel: await take(panelPortCandidates()),
    app: await take(APP_PORT_CANDIDATES),
    pg: await take(PG_PORT_CANDIDATES),
  };
}

/**
 * 这一组端口里有没有落在文档化候选范围之外的。
 *
 * pickFreePort 在候选全被占时会向内核要一个临时端口（sysinfo.mjs）——那确实是个
 * 空闲端口，也确实进了 used 集合，但它落在文档写明的范围之外，可能撞上防火墙或
 * 杀软的兴趣区间。兜底本身不该去掉，但**不能静默**：调用方拿到非空的返回值就该
 * 记一条 warning。
 */
export function offRangePorts(ports) {
  const out = [];
  for (const key of PORT_KEYS) {
    const n = ports?.[key];
    if (!Number.isInteger(n)) continue;
    if (!candidatesFor(key).includes(n)) out.push({ key, port: n });
  }
  return out;
}

/**
 * 校验用户手填的一组端口。返回 null 表示通过，否则返回一句人话。
 *
 * 校验顺序按「哪条更可能是用户的真实意图」排：先格式，再互相撞，再撞中枢，
 * 再撞别的项目的预约，最后才问「此刻空不空」（这一步要探网络，最慢）。
 * `current` 是这个项目**当前**的端口——没变的那一项不查空闲，否则「只想改一个、
 * 另外两个保持原样」会因为那两个正被自己占着而永远通不过。
 */
export async function validatePorts(reg, project, ports, { current = {} } = {}) {
  for (const key of PORT_KEYS) {
    const n = ports?.[key];
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return `${PORT_LABELS[key]}端口「${n === undefined || n === null ? '' : n}」不是 1–65535 之间的整数。`;
    }
  }
  if (new Set(PORT_KEYS.map((k) => ports[k])).size !== PORT_KEYS.length) {
    return '三个端口必须互不相同。';
  }

  const hubPorts = [reg?.hub?.port, reg?.hub?.actualPort].filter(Number.isInteger);
  for (const key of PORT_KEYS) {
    if (hubPorts.includes(ports[key])) {
      return `${PORT_LABELS[key]}端口 ${ports[key]} 是中枢自己在用的端口。`;
    }
  }

  // 别的项目的预约。那里是持久的——与那个项目此刻是否在跑无关。
  const theirs = new Map();
  for (const other of reg?.projects || []) {
    if (!other || other.slug === project?.slug) continue;
    for (const [role, n] of Object.entries(other.ports || {})) {
      if (Number.isInteger(n)) theirs.set(n, `${other.name || other.slug}（它的${PORT_LABELS[role] || role}）`);
    }
  }
  for (const key of PORT_KEYS) {
    const owner = theirs.get(ports[key]);
    if (owner) return `${PORT_LABELS[key]}端口 ${ports[key]} 已被项目「${owner}」预约。`;
  }

  for (const key of PORT_KEYS) {
    if (ports[key] === current[key]) continue;
    if (!(await portFree(ports[key]))) {
      return `${PORT_LABELS[key]}端口 ${ports[key]} 此刻已被占用。`;
    }
  }
  return null;
}
