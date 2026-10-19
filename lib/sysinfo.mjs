// 系统与网络指标采集。只用 Node 内置模块 + 系统自带命令（tasklist / PowerShell），
// 不引入任何依赖，也不使用已在 Win11 上被弃用的 wmic。
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import dgram from 'node:dgram';
import http from 'node:http';
import { execFile } from 'node:child_process';

const isWin = process.platform === 'win32';

function exec(cmd, args, timeout = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: stdout || '', stderr: stderr || '', err });
    });
  });
}

// --------------------------------------------------------------- 端口与连通性

/** 端口是否空闲。用 0.0.0.0 试绑，因为应用监听的是全网卡而非仅回环。 */
export function portFree(port, host = '0.0.0.0') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen({ host, port, exclusive: true });
  });
}

/** 从 start 起依次试绑，返回第一个空闲端口。 */
export async function pickFreePort(candidates) {
  for (const p of candidates) {
    if (await portFree(p)) return p;
  }
  // 全被占：让内核分配一个临时端口，再释放掉当作候选
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen({ host: '0.0.0.0', port: 0 }, () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** 裸 TCP 连通性检查——不实现 PG 协议、不依赖 psql，用于「数据库在监听吗」。 */
export function tcpReachable(host, port, timeout = 1000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host, port });
    let done = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      sock.destroy();
      resolve({ ok, ms: Date.now() - t0, error: error ? String(error.code || error.message) : null });
    };
    sock.setTimeout(timeout);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false, 'TIMEOUT'));
    sock.once('error', (e) => finish(false, e));
  });
}

/** 固定端口是否有人在监听（用于判「应用起来了吗」）。 */
export function portOpen(port, host = '127.0.0.1', timeout = 800) {
  return tcpReachable(host, port, timeout);
}

/** 轮询等待端口变为期望状态。 */
export async function waitForPort(port, wantOpen, { timeout = 60000, interval = 250, host = '127.0.0.1' } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    const r = await portOpen(port, host, 800);
    if (r.ok === wantOpen) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r2) => setTimeout(r2, interval));
  }
}

// --------------------------------------------------------------- HTTP 探针

/** 一次性 HTTP GET，返回状态码与耗时。不跟随跳转——307 本身就是我们要的信号。 */
export function httpProbe(url, { timeout = 2500, headers = {} } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let done = false;
    const finish = (ok, status, error) => {
      if (done) return;
      done = true;
      resolve({ ok, status, ms: Date.now() - t0, error: error || null });
    };
    let req;
    try {
      req = http.request(url, { method: 'GET', timeout, headers }, (res) => {
        res.resume();
        res.once('end', () => finish(true, res.statusCode));
        res.once('error', (e) => finish(false, res.statusCode, String(e.message)));
      });
    } catch (e) {
      return finish(false, null, String(e.message));
    }
    req.once('timeout', () => {
      req.destroy();
      finish(false, null, 'TIMEOUT');
    });
    req.once('error', (e) => finish(false, null, String(e.code || e.message)));
    req.end();
  });
}

// --------------------------------------------------------------- 网络地址

/**
 * 局域网 IP：用 UDP socket connect 到外部地址（不发任何包）让内核挑出默认路由所在网卡。
 * 这天然排除 127.* 与 169.254.*（链路本地在无默认路由时根本连不上），
 * 也避开了「随便取第一个非 internal IPv4 会拿到断开的虚拟网卡」这个坑。
 */
export function lanIp(timeout = 1500) {
  return new Promise((resolve) => {
    const fallback = () => {
      for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
        for (const a of addrs || []) {
          if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) {
            return resolve({ ip: a.address, source: 'interface-scan', iface: name });
          }
        }
      }
      return resolve({ ip: null, source: 'none', iface: null });
    };
    let sock;
    try {
      sock = dgram.createSocket('udp4');
    } catch {
      return fallback();
    }
    const timer = setTimeout(() => {
      try {
        sock.close();
      } catch {}
      fallback();
    }, timeout);
    sock.once('error', () => {
      clearTimeout(timer);
      try {
        sock.close();
      } catch {}
      fallback();
    });
    try {
      sock.connect(53, '8.8.8.8', () => {
        clearTimeout(timer);
        const ip = sock.address().address;
        sock.close();
        resolve({ ip, source: 'default-route', iface: null });
      });
    } catch {
      clearTimeout(timer);
      fallback();
    }
  });
}

/** 列出全部网卡（界面上折叠展示，排查「为什么局域网连不上」时有用）。 */
export function interfaces() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4') out.push({ name, address: a.address, internal: a.internal });
    }
  }
  return out;
}

// --------------------------------------------------------------- 主机指标

/** 系统 CPU 占用率。保留上一次的 tick 快照求差，首次调用返回 null。 */
let lastCpu = null;
export function systemCpuPercent() {
  let idle = 0;
  let total = 0;
  for (const c of os.cpus()) {
    for (const t of Object.values(c.times)) total += t;
    idle += c.times.idle;
  }
  const prev = lastCpu;
  lastCpu = { idle, total };
  if (!prev) return null;
  const dTotal = total - prev.total;
  const dIdle = idle - prev.idle;
  if (dTotal <= 0) return null;
  return Math.max(0, Math.min(100, (1 - dIdle / dTotal) * 100));
}

export function memInfo() {
  return { totalBytes: os.totalmem(), freeBytes: os.freemem() };
}

/** 磁盘容量。优先 fs.statfs（Node 18.15+），失败则退回 PowerShell Get-PSDrive。 */
export async function diskInfo(target) {
  try {
    if (typeof fs.statfs === 'function') {
      const st = await fs.promises.statfs(target);
      return { path: target, freeBytes: Number(st.bavail) * Number(st.bsize), totalBytes: Number(st.blocks) * Number(st.bsize) };
    }
  } catch {}
  if (isWin) {
    const drive = (path_drive(target) || 'C:').replace(':', '');
    const r = await exec('powershell', [
      '-NoProfile',
      '-Command',
      `Get-PSDrive -Name ${drive} | Select-Object Used,Free | ConvertTo-Json -Compress`,
    ]);
    try {
      const o = JSON.parse(r.stdout.trim());
      return { path: target, freeBytes: o.Free, totalBytes: (o.Used || 0) + (o.Free || 0) };
    } catch {}
  }
  return { path: target, freeBytes: null, totalBytes: null };
}

function path_drive(p) {
  const m = /^([A-Za-z]:)/.exec(String(p));
  return m ? m[1] : null;
}

// --------------------------------------------------------------- 进程指标

/** 进程是否存活。EPERM 表示存在但不属于当前用户，仍算存活。 */
export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

/**
 * 进程创建时间（毫秒时间戳）。用于防止 PID 复用导致误杀无关进程。
 * 拿不到时返回 null，调用方应把 null 当作「无法验证」而不是「不匹配」。
 *
 * ⚠️ 这里的正则必须容忍**反斜杠转义**，这不是洁癖而是本机上真实存在的形态：
 * ConvertTo-Json 输出的日期是 JSON 字符串，正斜杠会被转义，于是实际拿到的是
 *     {"value":"\/Date(1790513314923)\/","DateTime":"…"}
 * 收尾是 `)\/` 而不是 `)/`。早先只认未转义的 `/Date(…)/`，于是**每一台机器上
 * 每一次调用都返回 null**——而 null 在下游被当作「无法验证」直接放行，
 * 于是「按启动时间核对身份、防止 PID 复用误杀」这条保护一直是形同虚设的。
 * 它不会报错、不会写日志，只是从不生效；只有拿真实输出对着正则跑一遍才看得出来。
 */
const DATE_JSON_RE = /\\?\/Date\((\d+)\)\\?\//;

export async function processStartTime(pid) {
  if (!pid) return null;
  if (isWin) {
    const r = await exec('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate | ConvertTo-Json -Compress`,
    ]);
    const raw = r.stdout.trim().replace(/^"|"$/g, '');
    if (!raw || raw === 'null') return null;
    const m = DATE_JSON_RE.exec(raw);
    if (m) return Number(m[1]);
    const t = Date.parse(raw);
    return Number.isNaN(t) ? null : t;
  }
  const r = await exec('ps', ['-o', 'lstart=', '-p', String(pid)]);
  const t = Date.parse(r.stdout.trim());
  return Number.isNaN(t) ? null : t;
}

/** 进程 RSS（字节）。 */
export async function processRss(pid) {
  if (!pid) return null;
  if (isWin) {
    const r = await exec('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']);
    // "node.exe","1234","Console","1","123,456 K"
    const cols = r.stdout.trim().split('","');
    if (cols.length < 5) return null;
    const mem = cols[cols.length - 1].replace(/"/g, '').replace(/,/g, '').match(/(\d+)\s*K/i);
    return mem ? Number(mem[1]) * 1024 : null;
  }
  if (process.platform === 'linux') {
    try {
      const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ');
      return Number(statm[1]) * 4096;
    } catch {
      return null;
    }
  }
  const r = await exec('ps', ['-o', 'rss=', '-p', String(pid)]);
  const kb = Number(r.stdout.trim());
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/**
 * 进程累计 CPU 秒数。Windows 走 PowerShell Get-Process（一次拉全部 node 进程，
 * 调用方应节流到 ~5s 一次），Linux 读 /proc/<pid>/stat，macOS 用 ps。
 */
export async function processCpuSeconds(pid) {
  if (!pid) return null;
  if (isWin) {
    const r = await exec('powershell', [
      '-NoProfile',
      '-Command',
      `Get-Process -Name node -ErrorAction SilentlyContinue | Select-Object Id,CPU | ConvertTo-Json -Compress`,
    ]);
    const raw = r.stdout.trim();
    if (!raw) return null;
    let arr;
    try {
      arr = JSON.parse(raw);
    } catch {
      return null;
    }
    const list = Array.isArray(arr) ? arr : [arr];
    const hit = list.find((x) => Number(x.Id) === Number(pid));
    return hit && typeof hit.CPU === 'number' ? hit.CPU : null;
  }
  if (process.platform === 'linux') {
    try {
      const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const close = f.lastIndexOf(')');
      const rest = f.slice(close + 2).split(' ');
      const utime = Number(rest[11]);
      const stime = Number(rest[12]);
      return (utime + stime) / 100;
    } catch {
      return null;
    }
  }
  const r = await exec('ps', ['-o', 'time=', '-p', String(pid)]);
  const parts = r.stdout.trim().split(':').map(Number);
  if (parts.some(Number.isNaN)) return null;
  while (parts.length < 3) parts.unshift(0);
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}

/** 判断当前进程是否以管理员身份运行（Postgres 拒绝 elevated token）。 */
export async function isElevated() {
  if (!isWin) return typeof process.getuid === 'function' && process.getuid() === 0;
  const r = await exec('powershell', [
    '-NoProfile',
    '-Command',
    `([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)`,
  ]);
  return /true/i.test(r.stdout);
}
