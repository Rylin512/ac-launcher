#!/usr/bin/env node
// 守「端口 → 派生数据」这条不变式：panel.json 的 pgPort、它的 databaseUrl、
// .env 的 DATABASE_URL / POSTGRES_PASSWORD 必须永远互相一致。
//
//   node verify-ports.mjs                          纯逻辑层（构建时跑这个）
//   node verify-ports.mjs --data-root <数据根>      额外扫真实文件（人工跑）
//
// 为什么需要它：这条不变式横跨**三个文件**，而它漂移起来是静默的——界面一片正常，
// 只有应用连不上库的时候才发作。config.mjs 的 writeEnv 注释里记着一次真实事故：
// 只改了一个无关的键，DATABASE_URL 就被打回模板占位值。中枢的「重新分配端口」会
// 同时动这三个文件，所以它是这个不变式最需要被自动验证的地方。
//
// 纯逻辑层不碰网络也不碰磁盘，因此在任何构建机上都能跑；文件层需要一份真实部署，
// 所以只由人手动指定数据根时执行。
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { portableDsn, normalizeDbConfig } from './lib/config.mjs';
import { usedPorts, allocatePorts, offRangePorts, validatePorts } from './lib/ports.mjs';

let failures = 0;
function pass(name, e) {
  if (e) {
    failures += 1;
    console.log('  ✕ ' + name + '\n      ' + e.message);
    if (process.env.AC_TRACE) console.log(String(e.stack).split('\n').slice(0, 6).join('\n'));
  } else {
    console.log('  ✓ ' + name);
  }
}
const assert = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
async function check(name, fn) {
  try {
    await fn();
    pass(name);
  } catch (e) {
    pass(name, e);
  }
}

/** 造一个注册表夹具。 */
const reg = (over = {}) => ({
  hub: { port: 8788, actualPort: 8789 },
  projects: [
    { slug: 'a-11111111', name: 'A', ports: { panel: 8800, app: 3000, pg: 55432 } },
    { slug: 'b-22222222', name: 'B', ports: { panel: 8801, app: 3080, pg: 55433 } },
  ],
  ...over,
});

console.log('端口 → 派生数据不变式：');
console.log('');

console.log('portableDsn / normalizeDbConfig：');
await check('DSN 的拼法逐字符固定（端口与密码都在里面）', () => {
  assert(
    portableDsn({ pgPassword: 'p', pgPort: 1 }) === 'postgres://agilecampus:p@127.0.0.1:1/agilecampus',
    '拼出来是：' + portableDsn({ pgPassword: 'p', pgPort: 1 })
  );
});
await check('normalizeDbConfig 不动外部库模式', () => {
  const cfg = { dbMode: 'external', pgPassword: 'p', pgPort: 1, databaseUrl: 'postgres://elsewhere/db' };
  assert(normalizeDbConfig(cfg) === false, '外部库模式不该被改写');
  assert(cfg.databaseUrl === 'postgres://elsewhere/db', '外部库的 DSN 被动了：' + cfg.databaseUrl);
});
await check('normalizeDbConfig 在没密码时不动（还没初始化）', () => {
  const cfg = { dbMode: 'portable', pgPassword: '', pgPort: 1, databaseUrl: 'stale' };
  assert(normalizeDbConfig(cfg) === false, '没密码时不该派生');
  assert(cfg.databaseUrl === 'stale', 'DSN 被动了');
});
await check('normalizeDbConfig 把陈旧的 DSN 拉回与新端口一致', () => {
  const cfg = { dbMode: 'portable', pgPassword: 'p', pgPort: 55999, databaseUrl: 'postgres://agilecampus:p@127.0.0.1:55432/agilecampus' };
  assert(normalizeDbConfig(cfg) === true, '陈旧的 DSN 没被改正');
  assert(cfg.databaseUrl.includes(':55999/'), 'DSN 没跟上新端口：' + cfg.databaseUrl);
  assert(cfg.databaseUrl === portableDsn(cfg), '改完仍不等于派生值');
});
await check('normalizeDbConfig 对已经一致的 DSN 返回 false（不白写盘）', () => {
  const cfg = { dbMode: 'portable', pgPassword: 'p', pgPort: 55432, databaseUrl: portableDsn({ pgPassword: 'p', pgPort: 55432 }) };
  assert(normalizeDbConfig(cfg) === false, '一致时不该报改动');
});

console.log('');
console.log('usedPorts（预约集合）：');
await check('三个角色的预约值都在集合里', () => {
  const u = usedPorts(reg());
  for (const n of [8800, 3000, 55432, 8801, 3080, 55433]) {
    assert(u.has(n), '预约值 ' + n + ' 不在集合里');
  }
});
await check('中枢自己的端口也在（不靠「范围不相交」这个巧合）', () => {
  const u = usedPorts(reg());
  assert(u.has(8788) && u.has(8789), '中枢端口没被占住');
});
await check('avoid 是增量：把传进来的端口也占住（而不是让出来）', () => {
  // 这一条曾经写反过。原实现叫 exclude，做的是「从集合里去掉」，理由是「让出自己的
  // 旧端口才挑得出不同的值」——正好相反：去掉之后它们立刻变成可选的，allocatePorts
  // 原样发了回来，于是「重新分配」点了等于没点（真实链路上 current 与 suggested
  // 三个值完全相同）。要挑出不同的值，唯一正确的做法是把旧值一起**避开**。
  const u = usedPorts(reg(), { avoid: new Set([3000, 12345]) });
  assert(u.has(3000), 'avoid 的端口没被占住，重分配会把原值发回来');
  assert(u.has(12345), 'avoid 里那个不在预约中的端口也没被占住');
  assert(u.has(8800) && u.has(55432), '原有预约被误删了');
});
await check('不传 avoid 时结果与加项目那次分配完全一致', () => {
  const a = [...usedPorts(reg())].sort((x, y) => x - y);
  assert(a.join(',') === '3000,3080,8788,8789,8800,8801,55432,55433', '预约集合变了：' + a.join(','));
});
await check('缺字段的项目不会炸', () => {
  const u = usedPorts({ hub: {}, projects: [{ slug: 'x' }, { slug: 'y', ports: {} }, null] });
  assert(u.size === 0, '空注册表应得到空集合，实际 ' + u.size);
});

console.log('');
console.log('allocatePorts / offRangePorts：');
await check('分配出的三个端口两两不同、且都不是已预约的值', async () => {
  const reserved = new Set([3000, 3080, 8800, 8801, 55432, 55433, 8788, 8789]);
  const got = await allocatePorts(reg());
  const vals = [got.panel, got.app, got.pg];
  assert(vals.every(Number.isInteger), '有非整数：' + JSON.stringify(got));
  assert(new Set(vals).size === 3, '三个端口有重复：' + JSON.stringify(got));
  for (const v of vals) assert(!reserved.has(v), '分配到了已预约的 ' + v);
  const off = offRangePorts(got);
  if (off.length) console.log('      （注意：候选表已满，回退到内核临时端口：' + JSON.stringify(off) + '）');
});
await check('重分配：avoid 传自己的当前端口，挑出来的三个都与旧值不同', async () => {
  // 这就是「重新分配」真正依赖的那条性质。少了它按钮点了等于没点，而界面上
  // 一切正常（端口「没变」在卡片上看不出是 bug 还是本来就没得改）。
  const before = { panel: 8800, app: 3000, pg: 55432 };
  const got = await allocatePorts(reg(), { avoid: new Set(Object.values(before)) });
  for (const k of ['panel', 'app', 'pg']) {
    assert(got[k] !== before[k], k + ' 拿到了旧值 ' + before[k] + '：' + JSON.stringify(got));
  }
  assert(new Set(Object.values(got)).size === 3, '挑出来的三个值有重复：' + JSON.stringify(got));
  // 而且不能撞到**别的**项目的预约
  for (const v of [got.panel, got.app, got.pg]) {
    assert(![8801, 3080, 55433, 8788, 8789].includes(v), '撞了别人的预约：' + v);
  }
});
await check('offRangePorts 认得出落在候选范围外的值', () => {
  assert(offRangePorts({ panel: 8800, app: 3000, pg: 55432 }).length === 0, '正常值被误判');
  const off = offRangePorts({ panel: 1, app: 3000, pg: 55432 });
  assert(off.length === 1 && off[0].key === 'panel' && off[0].port === 1, '没认出面板端口越界：' + JSON.stringify(off));
});

console.log('');
console.log('validatePorts（手填那一组）：');
await check('非整数被拒', async () => {
  assert((await validatePorts(reg(), reg().projects[0], { panel: 8805, app: 'x', pg: 55440 })) !== null, '字符串端口该被拒');
  assert((await validatePorts(reg(), reg().projects[0], { panel: 8805, app: 0, pg: 55440 })) !== null, '0 该被拒');
  assert((await validatePorts(reg(), reg().projects[0], { panel: 8805, app: 70000, pg: 55440 })) !== null, '越界该被拒');
});
await check('三个端口互相重复被拒', async () => {
  const why = await validatePorts(reg(), reg().projects[0], { panel: 8805, app: 8805, pg: 55440 });
  assert(why !== null, '重复该被拒');
  assert(/互不相同/.test(why), '原因没说清是重复：' + why);
});
await check('撞中枢端口被拒，且指得出是中枢', async () => {
  const why = await validatePorts(reg(), reg().projects[0], { panel: 8805, app: 8788, pg: 55440 });
  assert(why !== null && /中枢/.test(why), '原因没指中枢：' + why);
});
await check('撞别的项目的预约被拒，且指名道姓', async () => {
  const why = await validatePorts(reg(), reg().projects[0], { panel: 8805, app: 3080, pg: 55440 });
  assert(why !== null, '撞了 B 的预约却没被拒');
  assert(/B/.test(why), '原因没指出是谁：' + why);
  assert(/预约/.test(why), '原因没说是预约：' + why);
});
await check('用自己的当前值不算冲突（只想改一个时另外两个保持原样）', async () => {
  // 这里不探网络：三个值里的前两个是「自己的当前值」，只有第三个要探，
  // 而 55440 这个值不在任何预约里。它此刻空闲与否由机器状态决定，所以这一步
  // 只断言「不是被预约/中枢/重复那几类原因驳回」——若要更严，见下面那条真实占用用例。
  const why = await validatePorts(reg(), reg().projects[0], { panel: 8800, app: 3000, pg: 55440 }, { current: { panel: 8800, app: 3000, pg: 55432 } });
  assert(why === null || /占用/.test(why), '自己的当前值被当成冲突了：' + why);
});
await check('真实被占用的端口被拒，并说「已被占用」', async () => {
  // 自己起一个监听，再让校验去撞它——这同时证明了空闲探测真的在做。
  const srv = net.createServer();
  const port = await new Promise((resolve) => {
    srv.listen({ host: '0.0.0.0', port: 0 }, () => resolve(srv.address().port));
  });
  try {
    const why = await validatePorts(reg(), reg().projects[0], { panel: port, app: 3000, pg: 55432 }, { current: { panel: 8800, app: 3000, pg: 55432 } });
    assert(why !== null, '占着的端口没被拒');
    assert(/已被占用/.test(why), '原因没说被占用：' + why);
  } finally {
    await new Promise((r) => srv.close(r));
  }
});

/* ------------------------------------------------------------ 文件层 */
if (process.argv.includes('--data-root')) {
  const root = process.argv[process.argv.indexOf('--data-root') + 1];
  console.log('');
  console.log('真实文件（' + root + '）：');
  if (!root || !fs.existsSync(root)) {
    console.log('  ✕ 数据根不存在：' + root);
    failures += 1;
  } else {
    // 注册表里的项目运行目录；外加收编的旧部署——它的运行目录**就是数据根**。
    const targets = [];
    try {
      const regFile = JSON.parse(fs.readFileSync(path.join(root, 'projects.json'), 'utf8'));
      for (const p of regFile.projects || []) if (p?.runtimeDir) targets.push({ label: p.name || p.slug, runtimeDir: p.runtimeDir, cached: p.ports || {} });
    } catch (e) {
      console.log('  ✕ 读不到 projects.json：' + e.message);
      failures += 1;
    }
    if (fs.existsSync(path.join(root, 'config', 'panel.json'))) {
      targets.push({ label: '（数据根自己的 panel.json，收编的旧部署）', runtimeDir: root, cached: null });
    }

    await check('扫到 ' + targets.length + ' 个运行目录', () => {
      assert(targets.length > 0, '没有可检查的运行目录');
    });

    for (const t of targets) {
      const cfgFile = path.join(t.runtimeDir, 'config', 'panel.json');
      const envFile = path.join(t.runtimeDir, 'src', '.env');
      const short = t.label;

      await check(short + '：databaseUrl 与 pgPort/pgPassword 一致', () => {
        let cfg;
        try {
          cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        } catch {
          return; // 没配置的项目跳过
        }
        if (cfg.dbMode !== 'portable') return;
        assert(cfg.databaseUrl === portableDsn(cfg), 'DSN 与端口/密码不一致\n      cfg  = ' + String(cfg.databaseUrl).replace(/:[^:@/]*@/, ':****@') + '\n      应为 = ' + portableDsn(cfg).replace(/:[^:@/]*@/, ':****@'));
      });
      await check(short + '：.env 的 DATABASE_URL 跟得上 cfg', () => {
        let cfg;
        try {
          cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        } catch {
          return;
        }
        if (cfg.dbMode !== 'portable') return;
        const env = fs.readFileSync(envFile, 'utf8');
        const m = /^\s*DATABASE_URL\s*=\s*(.*)$/m.exec(env);
        assert(m, '.env 里没有 DATABASE_URL');
        const val = m[1].trim().replace(/^["']|["']$/g, '');
        assert(val === cfg.databaseUrl, '.env 的 DATABASE_URL 与 cfg 不一致（端口或密码漂移了）');
      });
      await check(short + '：.env 的 POSTGRES_PASSWORD 与 cfg 一致', () => {
        let cfg;
        try {
          cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        } catch {
          return;
        }
        if (!cfg.pgPassword) return;
        const env = fs.readFileSync(envFile, 'utf8');
        const m = /^\s*POSTGRES_PASSWORD\s*=\s*(.*)$/m.exec(env);
        assert(m, '.env 里没有 POSTGRES_PASSWORD');
        const val = m[1].trim().replace(/^["']|["']$/g, '');
        assert(val === cfg.pgPassword, 'POSTGRES_PASSWORD 与 cfg 不一致');
      });
      await check(short + '：projects.json 的 ports 缓存与 cfg 一致（只是缓存，不一致仅提示）', () => {
        if (!t.cached) return;
        let cfg;
        try {
          cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
        } catch {
          return;
        }
        const pairs = [['panel', cfg.panelPort], ['app', cfg.appPort], ['pg', cfg.pgPort]];
        for (const [k, v] of pairs) {
          assert(t.cached[k] === v, `缓存 ${k}=${t.cached[k]} 而 cfg 里是 ${v}（显示会不一致，下次操作会刷新）`);
        }
      });
    }
  }
}

console.log('');
if (failures) {
  console.log('✕ ' + failures + ' 项失败。');
  process.exit(1);
}
console.log('✓ 端口 → 派生数据的不变式成立。');
