// 应用进程的启停与「领养」。
//
// 核心原则：面板不假设自己是应用的父进程。应用以 detached + 文件 fd 启动，
// 所以关掉面板（或关掉启动它的那个 cmd 窗口）都不会影响应用继续运行；
// 重新打开面板时靠 run/app.json 里的 PID + 启动时间把它认回来。
import fs from 'node:fs';
import { spawn, execFile } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { pidAlive, processStartTime, portOpen, waitForPort, httpProbe } from './sysinfo.mjs';
import { readJson, writeJson, resolveServerJs } from './config.mjs';
import { nodeExe, withPath } from './nodebin.mjs';

const isWin = process.platform === 'win32';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

/**
 * 终止整棵进程树。Windows 用 taskkill /T（按父子关系递归）。
 *
 * `ok` 的含义是**「请求送达了」**，也就是退出码 0。这里有一个踩过的坑：
 * 从前写的是 `code === 0 || code === 128`，注释说「128 = 进程已不存在」。
 * **那句是猜的，而且猜错了。** 本机实测，128 对下面三种情况一视同仁：
 *
 *   · 一个根本不存在的 PID          → 128
 *   · 一个存在但**没有窗口**的进程   → 128   ← 请求被拒绝，进程原地不动
 *   · 一个刚被 /F 结束掉的进程       → 128
 *
 * 也就是说 128 不携带任何信息（detached 的进程还会报 255，同样无信息）。按老写法，
 * 一次**被拒绝**的软杀会被当成成功，调用方于是理直气壮地等一个永远不会发生的结果。
 * 想知道进程到底还在不在，问 `pidAlive` —— 它是确定的。
 */
async function taskkill(pid, force) {
  const args = ['/PID', String(pid), '/T'];
  if (force) args.push('/F');
  const r = await run('taskkill', args);
  return { ok: r.code === 0, code: r.code, out: `${r.stdout}${r.stderr}` };
}

/** 终止一棵进程树：先软后硬。可接受 ChildProcess 或裸 PID。 */
export async function killTree(target) {
  const pid = typeof target === 'number' ? target : target?.pid;
  if (!pid) return true;
  if (isWin) {
    await taskkill(pid, false);
    // 这 500ms 在 Windows 上同样是白等（同 stopApp 的说明：没窗口的进程收不到 WM_CLOSE），
    // 但这里**故意留着**：调用方常常刚发过一次 HTTP 优雅停机请求，目标可能正在收尾
    // （写日志、关 server），多给它半秒是礼貌，代价只有半秒。stopApp 那条则不同——
    // 那里是 8 秒，而且等的是「端口释放」这件不可能发生的事。
    await sleep(500);
    if (pidAlive(pid)) {
      await taskkill(pid, true);
      await sleep(300);
    }
    return !pidAlive(pid);
  }
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  await sleep(600);
  if (pidAlive(pid)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
  }
  return !pidAlive(pid);
}

// ------------------------------------------------------------- 应用状态文件

export function readAppState(P) {
  return readJson(P.appStateFile, null);
}

function writeAppState(P, st) {
  writeJson(P.appStateFile, st);
}

/**
 * 记录里的启动时间与真实启动时间是否吻合（防 PID 复用导致误杀无关进程）。
 *
 * 导出是给中枢用的：它在「优雅停机没生效、只能硬杀子面板」那条路上要问同一个问题。
 * 这条规则只该有一份——两份拷贝的后果是其中一份忘了检查，而代价是杀掉无关进程。
 */
export async function identityMatches(recorded, pid) {
  if (!recorded) return true; // 没记录过启动时间，只能退化为「PID 存活即认为是我们的人」
  const actual = await processStartTime(pid);
  if (actual === null) return true; // 拿不到（权限/命令缺失）时不阻断，交由上层提示
  return Math.abs(actual - recorded) < 5000;
}

// ------------------------------------------------------------- 启动 / 停止

/**
 * 启动应用。
 *
 * 四个要点缺一不可：
 *  1. detached: true —— 子进程不属于父控制台
 *  2. stdio 用「文件 fd」而不是 'pipe' —— 否则面板一退出，管道写端关闭，
 *     应用下次 console.log 就会 EPIPE 而退出。这正是「关掉启动窗口网站就停」的根因。
 *  3. unref() —— 不阻塞面板自身的退出
 *  4. windowsHide —— 不弹黑窗
 */
export function startApp(P, cfg, log = () => {}) {
  const envPath = P.envFile;
  // 入口必须解析而不是硬拼：Next 会把 standalone 产物按 tracingRoot 铺进嵌套目录，
  // 装配阶段虽会尽量摊平，但摊平遇到同名冲突会就地使用嵌套目录。
  // 直接拼 .next/standalone/server.js 的话，嵌套情况下会去执行一个不存在的文件
  // （曾经就是这里拼出了一个叫 undefined 的模块路径）。
  const { root, serverJs } = resolveServerJs(P);
  if (!fs.existsSync(serverJs)) {
    log(`警告：找不到应用入口 ${serverJs}，可能是还没构建。`);
  } else if (root !== P.standaloneDir) {
    log(`应用入口位于嵌套目录：${serverJs}`);
  }
  const outFd = fs.openSync(P.appLog, 'a');
  const errFd = fs.openSync(P.appErrLog, 'a');
  // 走 withPath，别改回 `PATH: ...` 的字面量：那样写会在 Windows 上（键名是 `Path`）
  // 把整条继承来的 PATH 丢掉，应用及其子进程就再也找不到 node。见 nodebin.withPath。
  const env = withPath(
    {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(cfg.appPort),
      HOSTNAME: '0.0.0.0',
    },
    P,
    P.pgBin,
  );
  // 中枢的监督令牌不能跟进**部署后的站点**——那是个绑 0.0.0.0、对局域网开放的
  // Next 服务，任何 dump env 的路径都会把它漏出去。
  delete env.AC_SUPERVISOR_TOKEN;
  delete env.AC_HUB;

  let child;
  try {
    // 必须是**真的** Node，不能是 process.execPath：打包成单文件 exe 之后后者是本 exe，
    // spawn 它会重跑面板并丢掉 serverJs 这个参数——结果是静默地又起一个面板而不是
    // 应用，而且不报任何错。这是这个改造里最坏的失败形态。
    child = spawn(nodeExe(P), [`--env-file-if-exists=${envPath}`, serverJs], {
      cwd: root,
      env,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', outFd, errFd],
    });
  } finally {
    fs.closeSync(outFd);
    fs.closeSync(errFd);
  }
  child.unref();
  log(`已拉起应用进程，PID ${child.pid}`);
  return child;
}

/**
 * 停掉应用：先软后硬，最终以「端口是否还有人监听」为准。
 *
 * **Windows 上没有「优雅关闭一个应用」这条路，别把它当成超时。** 不带 `/F` 的
 * `taskkill` 只给目标进程的**顶层窗口**发 WM_CLOSE，而这个应用是 detached +
 * windowsHide 起来的——**它没有窗口**，于是 taskkill 当场拒绝执行
 * （`只能强制终止此进程(带 /F 选项)`，退出码 255，实测耗时 ~160ms），
 * 进程一动不动，端口也一直握着。
 *
 * 从前这里不看返回值就 `waitForPort(…, timeout: 8000)`：那 8 秒**注定白等**，
 * 日志还把它记成「优雅退出超时」——读起来像应用退得慢，真相是这条信号在 Windows 上
 * 根本送不出去。没有窗口的进程只会收到「被结束」，收不到「请结束」。
 */
export async function stopApp(P, cfg, log = () => {}) {
  const st = readAppState(P);
  const port = st?.port ?? cfg.appPort;
  const pid = st?.pid;

  if (!pid || !pidAlive(pid)) {
    const open = await portOpen(port);
    if (open.ok) {
      const e = new Error(
        `端口 ${port} 上有进程在监听，但它不是本面板启动的（记录里的 PID ${pid || '无'} 已不存在）。` +
          `为避免误杀，面板不会自动处理它。可改用「换端口启动」，或手工排查占用该端口的进程。`
      );
      e.code = 'ORPHAN_PORT';
      throw e;
    }
    writeAppState(P, null);
    return { alreadyStopped: true };
  }

  if (!(await identityMatches(st.pidStartTime, pid))) {
    const e = new Error(`记录的 PID ${pid} 存在，但启动时间与记录不符（疑似 PID 被复用），已放弃终止以免误杀无关进程。`);
    e.code = 'PID_REUSED';
    throw e;
  }

  log(`正在停止应用（PID ${pid}）…`);
  const soft = await taskkill(pid, false);
  // 「请求真的送出去了吗」决定后面要不要等：`ok` 只认退出码 0（见 taskkill 的说明，
  // 128/255 都不携带信息），再用 pidAlive 把「它已经自己走了」那种情况排除掉。
  // 既然请求没送出去，等下去必然白等——直接落到下面强制终止。
  const refused = !soft.ok && pidAlive(pid);
  if (refused) {
    log('应用没有窗口，Windows 送不出关闭请求（taskkill 不带 /F 只能强制终止），跳过等待。');
  }
  if (!refused && (await waitForPort(port, false, { timeout: 8000, interval: 250 }))) {
    log('应用已正常退出。');
    writeAppState(P, null);
    return { stopped: true, graceful: true };
  }

  log(refused ? '改为强制终止…' : '等待超时，改为强制终止…');
  await taskkill(pid, true);
  if (await waitForPort(port, false, { timeout: 3000, interval: 250 })) {
    log('应用已被强制终止。');
    writeAppState(P, null);
    return { stopped: true, graceful: false };
  }

  const e = new Error(`端口 ${port} 仍被占用。可手工执行排查：netstat -ano | findstr :${port}`);
  e.code = 'PORT_STILL_BUSY';
  throw e;
}

/** 记录一次成功启动，写入 PID 与进程创建时间。 */
export async function recordStarted(P, cfg, pid) {
  const startedAt = await processStartTime(pid);
  writeAppState(P, {
    pid,
    pidStartTime: startedAt || Date.now(),
    port: cfg.appPort,
    startedAt: Date.now(),
    builtAt: cfg.builtAt || null,
    logPath: P.appLog,
  });
}

/** 等到应用真的能应答 HTTP。307 也算成功——那是 Next 在把未登录用户重定向到 /login。 */
export async function waitAppReady(cfg, log = () => {}, timeout = 90000) {
  const url = `http://127.0.0.1:${cfg.appPort}/`;
  const deadline = Date.now() + timeout;
  for (;;) {
    const r = await httpProbe(url, { timeout: 2500 });
    if (r.ok) return r;
    if (Date.now() > deadline) return r;
    await sleep(700);
  }
}

/** 停止后再启动，并等到端口就绪。部署流程的最后一步走这里。 */
export async function restartApp(P, cfg, log = () => {}) {
  await stopApp(P, cfg, log);
  const child = startApp(P, cfg, log);
  const ready = await waitForPort(cfg.appPort, true, { timeout: 60000, interval: 400 });
  if (!ready) {
    const e = new Error('应用进程已拉起，但端口在 60s 内没有就绪。请查看下方「应用错误日志」。');
    e.code = 'APP_NOT_READY';
    throw e;
  }
  await recordStarted(P, cfg, child.pid);
  const probe = await waitAppReady(cfg, log, 60000);
  if (probe.ok) log(`应用已就绪：HTTP ${probe.status}（${probe.ms}ms）`);
  else log('进程与端口都正常，但 HTTP 探针未通过；可能是首屏编译较慢，稍后会自动恢复。');
  return { pid: child.pid, httpStatus: probe.status, probeOk: probe.ok };
}

/**
 * 应用当前处于什么状态。
 * running  —— 我们记录的进程还活着，且端口在监听
 * orphan   —— 端口有人监听，但不是我们管的进程
 * stopped  —— 都没了
 * unhealthy—— 进程活着但端口没起来（多半是启动中或启动失败）
 */
export async function appStatus(P, cfg) {
  const st = readAppState(P);
  const port = st?.port ?? cfg.appPort;
  const procAlive = Boolean(st?.pid && pidAlive(st.pid));
  const portRes = await portOpen(port);

  let state = 'stopped';
  if (procAlive && portRes.ok) state = 'running';
  else if (procAlive) state = 'unhealthy';
  else if (portRes.ok) state = 'orphan';

  return {
    state,
    adopted: state === 'running' || state === 'unhealthy',
    pid: procAlive ? st.pid : null,
    port,
    startedAt: st?.startedAt ?? null,
    uptimeSec: procAlive && st?.startedAt ? Math.floor((Date.now() - st.startedAt) / 1000) : null,
    portListening: portRes.ok,
    logPath: P.appLog,
    errLogPath: P.appErrLog,
  };
}

// ----------------------------------------------------------------- 日志读取

/**
 * 从文件尾部按字节回读最后 N 行。
 * 用 StringDecoder 处理「多字节字符恰好被读取起点切断」的边界，
 * 否则中文日志会冒出替换符。
 */
export function readTail(file, lines = 200, maxBytes = 256 * 1024) {
  let fd;
  try {
    const st = fs.statSync(file);
    if (!st.size) return { file, size: 0, lines: [], mtime: st.mtimeMs };
    const start = Math.max(0, st.size - maxBytes);
    fd = fs.openSync(file, 'r');
    const len = st.size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    // 用 StringDecoder 收尾，保证多字节字符恰好被读取起点切断时也能还原
    const text = new StringDecoder('utf8').end(buf);
    // 从中间开始读时，第一行多半是残缺的，丢掉
    const trimmed = start > 0 ? text.replace(/^[^\n]*\n?/, '') : text;
    const all = trimmed.split(/\r?\n/);
    if (all.length && all[all.length - 1] === '') all.pop();
    return {
      file,
      size: st.size,
      truncated: start > 0,
      mtime: st.mtimeMs,
      lines: all.slice(-lines).map((text2, i) => ({ seq: i + 1, text: text2 })),
    };
  } catch {
    return { file, size: 0, lines: [], mtime: 0 };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * 跟踪一个日志文件的追加内容。
 * 用 fs.watchFile（stat 轮询）而不是 fs.watch：Windows 上文件被重开或轮转时 fs.watch 不可靠。
 */
export function tailFile(file, onLines, interval = 500) {
  let offset = 0;
  const decoder = new StringDecoder('utf8');
  let carry = '';

  const readFrom = (to) => {
    const len = to - offset;
    if (len <= 0) return;
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, offset);
    fs.closeSync(fd);
    offset = to;
    // carry 负责把上一次读到的半行接回来，避免长行被拆成两条日志
    const parts = (carry + decoder.write(buf)).split(/\r?\n/);
    carry = parts.pop();
    if (parts.length) onLines(parts);
  };

  const stat = () => {
    try {
      const st = fs.statSync(file);
      if (st.size < offset) offset = 0; // 文件被截断/重建
      if (st.size > offset) readFrom(st.size);
    } catch {
      // 文件还不存在，等下一轮
    }
  };

  // 初次：从末尾开始跟随，只把此刻之后的新内容推给订阅者
  try {
    offset = fs.statSync(file).size;
  } catch {
    offset = 0;
  }
  fs.watchFile(file, { interval }, stat);
  return () => fs.unwatchFile(file, stat);
}

/** 确保日志文件存在（应用还没启动过时屏幕上也该有个空文件可看）。 */
export function touch(file) {
  try {
    if (!fs.existsSync(file)) fs.writeFileSync(file, '');
  } catch {}
}
