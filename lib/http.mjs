// HTTP 基础设施与**三层护栏的唯一实现**。
//
// 面板与中枢共用这一份，理由很直接：安全策略只要有两份拷贝，早晚会漂移，
// 而漂移的方向通常是「其中一份忘了加检查」。所以护栏在这里只写一次。
//
// 只用 Node 内置模块——面板必须能在 npm ci 之前跑起来。
import http from 'node:http';
import { spawn } from 'node:child_process';

export function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

export function fail(res, code, message, extra = {}) {
  json(res, code, { error: { code, message, ...extra } });
}

export function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error('请求体不是合法 JSON'), { code: 'BAD_JSON' }));
      }
    });
    req.on('error', reject);
  });
}

/** SSE 长连接包装。 */
export function sse(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const beat = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {}
  }, 15000);
  let closed = false;
  const api = {
    send(event, data, id) {
      if (closed) return;
      try {
        if (id !== undefined) res.write(`id: ${id}\n`);
        res.write(`event: ${event}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        api.close();
      }
    },
    close() {
      if (closed) return;
      closed = true;
      clearInterval(beat);
      try {
        res.end();
      } catch {}
    },
    get closed() {
      return closed;
    },
  };
  req.on('close', () => {
    clearInterval(beat);
    closed = true;
  });
  return api;
}

/**
 * 可接受的令牌集合。
 *
 * 集合里有两个来源：
 *  · 本进程自己生成的随机令牌 —— 注入进发给浏览器的 HTML，浏览器用它调改动型接口。
 *  · 中枢下发的监督令牌（AC_SUPERVISOR_TOKEN）——**只走环境变量，绝不写进 HTML**。
 *    中枢是服务端客户端，需要在不读子面板 HTML 的前提下优雅停掉子面板。
 *
 * 长度下限是刻意的：环境变量可能被误设成空串或垃圾，不该因此把护栏放开。
 */
export function tokenSet(ownToken, supervisorToken = process.env.AC_SUPERVISOR_TOKEN) {
  const set = new Set([ownToken]);
  if (supervisorToken && supervisorToken.length >= 16) set.add(supervisorToken);
  return set;
}

/**
 * 三层护栏。返回一个 `(req, res) => URL | null`：
 *  · 返回 URL   —— 请求放行，调用方拿这个 URL 去路由
 *  · 返回 null  —— 已由护栏应答（403/415），调用方直接 return
 *
 * `getPort` 是函数而不是数字：实际监听端口在运行期才确定，且可能在回退后改变。
 */
export function createGuard({ getPort, tokens, onLog = () => {} }) {
  const allowed = tokens instanceof Set ? tokens : new Set([tokens].filter(Boolean));
  return (req, res) => {
    const port = getPort();

    /**
     * 每一次拒绝都留一行日志。
     *
     * `onLog` 从第一天起就在签名里、两个调用点（hub.mjs / panel.mjs）也都传了 `log`，
     * 但它**从来没有被调用过**——于是「点了按钮没反应」在日志里一个字都不留，
     * 2026-09-28 排查「全部停止并退出面板之后中枢还说面板在跑」时正是被这一点拖住的：
     * 前因后果全在日志里，唯独缺了「那次点击被护栏挡在门外」这一句。
     *
     * **绝对不写令牌值**，连前缀都不写：只写「带没带、匹配不匹配」。
     * 请求路径去查字符串，避免把查询串里的东西（可能含密钥）抄进日志。
     */
    const deny = (code, message, why) => {
      const path = String(req.url || '').split('?')[0];
      try {
        onLog(`护栏拒绝 ${req.method} ${path}（${why}）`);
      } catch {}
      fail(res, code, message);
      return null;
    };

    // 防 DNS rebinding：Host 必须是本机地址
    const host = String(req.headers.host || '');
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(host)) {
      try {
        onLog(`护栏拒绝 ${req.method} ${String(req.url || '').split('?')[0]}（Host 不是本机：${host}）`);
      } catch {}
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Forbidden: 仅允许本机访问');
      return null;
    }
    const u = new URL(req.url, `http://127.0.0.1:${port}`);
    const method = req.method;

    // 预检一律拒绝：本面板不提供任何跨源能力
    if (method === 'OPTIONS') {
      return deny(403, 'Forbidden: 不提供跨源能力。', 'OPTIONS 预检');
    }
    // 改动型请求三重护栏：自定义头 + JSON Content-Type + Origin 校验
    if (method !== 'GET' && method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
        return deny(403, 'Origin 不被信任。', `Origin 不被信任：${origin}`);
      }
      if (!allowed.has(req.headers['x-ac-token'])) {
        const sent = req.headers['x-ac-token'];
        return deny(
          403,
          '缺少或错误的面板令牌，请刷新页面后重试。',
          sent ? '令牌不匹配（页面可能是上一个面板进程留下的，刷新即可）' : '没有带令牌'
        );
      }
      if (u.pathname.startsWith('/api/') && !String(req.headers['content-type'] || '').includes('application/json')) {
        return deny(415, '请求必须使用 application/json。', 'Content-Type 不是 application/json');
      }
    }
    return u;
  };
}

export function openBrowser(url, log = () => {}) {
  try {
    if (process.platform === 'win32') {
      spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    log('打开浏览器失败：' + e.message);
  }
}

/**
 * 本机 HTTP 客户端。中枢用它调子面板的接口与服务端探活。
 *
 * `token` 会作为 x-ac-token 发出；不带 Origin —— 护栏只拒绝「存在且不匹配」的
 * Origin，服务端客户端天然通过。POST 一律带 application/json，否则会被 415 拦下。
 */
export function request(url, { method = 'GET', token = null, body = null, timeout = 5000 } = {}) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const payload = body === null ? null : JSON.stringify(body);
    const headers = {};
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    if (token) headers['x-ac-token'] = token;
    const req = http.request(u, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try {
          data = text ? JSON.parse(text) : null;
        } catch {
          data = null;
        }
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data, text });
      });
    });
    req.setTimeout(timeout, () => {
      req.destroy(Object.assign(new Error('请求超时'), { code: 'TIMEOUT' }));
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, data: null, text: '', error: e }));
    if (payload !== null) req.write(payload);
    req.end();
  });
}
