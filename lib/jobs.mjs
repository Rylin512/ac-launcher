// 长任务注册表：串行互斥、分步进度、环形日志缓冲、订阅广播、取消。
// 所有耗时操作（下载 / npm ci / 构建 / 数据库初始化）都跑在这里，
// 界面通过 SSE 订阅同一条日志流，所以「进度条」和「日志滚动」看到的是同一份真相。
import { spawn } from 'node:child_process';
import { killTree } from './process.mjs';

const MAX_LINES = 2000;
const MAX_RECENT = 20;

let seqCounter = 0;

/** 步骤耗时的人类写法：12.3s / 3m05s。 */
function fmtDuration(ms) {
  const total = Math.max(0, ms);
  const secs = Math.round(total / 1000);
  if (secs < 60) return `${(total / 1000).toFixed(1)}s`;
  return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, '0')}s`;
}

export class Job {
  constructor(kind, title, stepTitles = []) {
    this.id = `j_${Date.now().toString(36)}_${(seqCounter++).toString(36)}`;
    this.kind = kind;
    this.title = title;
    this.status = 'running'; // running | succeeded | failed | cancelled
    this.startedAt = Date.now();
    this.endedAt = null;
    this.error = null;
    this.errorCode = null;
    this.steps = stepTitles.map((t) => ({ title: t, status: 'pending', detail: '', startedAt: null, endedAt: null }));
    this.currentStep = -1;
    this.lines = [];
    this.seq = 0;
    this.listeners = new Set();
    this.children = new Set();
  }

  /** 追加日志。按行切分，尾部的半行暂时留在缓冲区等下一次补齐。 */
  log(stream, chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    this.pending = (this.pending || '') + text;
    const parts = this.pending.split(/\r?\n/);
    this.pending = parts.pop();
    for (const line of parts) this.pushLine(stream, line);
    if (this.pending.length > 8192) {
      // 极端情况下（长时间无换行）避免缓冲区无限增长
      this.pushLine(stream, this.pending);
      this.pending = '';
    }
  }

  /**
   * 追加一整行**人工写好的**提示语。自动补换行。
   *
   * log() 是给进程原始输出用的，它必须把没有换行的尾巴留在缓冲里等下一段拼接
   * （否则一行会被拆成两条日志）。但人工消息天生是完整的，用 log() 写就会一直
   * 留在缓冲里，和下一条日志粘成一行——实测出现过「…srcstandalone 产物原本嵌套在…」
   * 这种两条消息糊在一起、读起来像是路径拼错了的假象。人工消息一律走这里。
   */
  line(stream, text) {
    const s = String(text);
    this.log(stream, s.endsWith('\n') ? s : `${s}\n`);
  }

  pushLine(stream, text) {
    if (text === '' && this.lines.length && this.lines[this.lines.length - 1].text === '') return;
    const entry = { seq: ++this.seq, ts: Date.now(), stream, text };
    this.lines.push(entry);
    if (this.lines.length > MAX_LINES) this.lines.splice(0, this.lines.length - MAX_LINES);
    this.emit({ type: 'log', entry });
  }

  /** 刷新尾部残留的半行（任务结束时调用）。 */
  flush() {
    if (this.pending) {
      this.pushLine('out', this.pending);
      this.pending = '';
    }
  }

  step(index, detail = '') {
    if (index >= 0 && index < this.steps.length) {
      const prev = this.steps[this.currentStep];
      if (prev && prev.status === 'running') {
        prev.status = 'done';
        prev.endedAt = Date.now();
        // 把每一步的耗时写进日志：总时长只有一个数字，看不出究竟是编译慢、
        // 装依赖慢还是启动慢。这行是给「为什么这次部署这么久」一个直接答案。
        this.line('out', `⏱ ${prev.title || '上一步'} 用时 ${fmtDuration(prev.endedAt - prev.startedAt)}`);
      }
      this.currentStep = index;
      const s = this.steps[index];
      s.status = 'running';
      s.startedAt = Date.now();
      if (detail) s.detail = detail;
      this.emit({ type: 'step', index, step: { ...s } });
    }
  }

  stepDetail(index, detail) {
    const s = this.steps[index];
    if (!s) return;
    s.detail = detail;
    this.emit({ type: 'step', index, step: { ...s } });
  }

  finish(status, error = null) {
    this.flush();
    for (const s of this.steps) {
      if (s.status === 'running') {
        s.status = status === 'succeeded' ? 'done' : 'failed';
        s.endedAt = Date.now();
        if (s.startedAt) this.line('out', `⏱ ${s.title || '最后一步'} 用时 ${fmtDuration(s.endedAt - s.startedAt)}`);
      }
    }
    this.status = status;
    this.error = error ? String(error.message || error) : null;
    // 错误码要跟着出去：界面靠它区分「这是需要用户确认的丢数据变更」
    // 还是「单纯失败了」，前者要给出一个确认按钮。
    this.errorCode = error?.code || null;
    this.endedAt = Date.now();
    if (this.error) this.pushLine('err', this.error);
    this.emit({ type: 'status', status, error: this.error, errorCode: this.errorCode });
    for (const cb of this.onFinish || []) {
      try {
        cb(this);
      } catch {}
    }
  }

  emit(ev) {
    for (const fn of this.listeners) {
      try {
        fn(ev);
      } catch {}
    }
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 快照，用于 GET /api/jobs/:id 与断线重连后的补齐。 */
  snapshot(sinceSeq = 0) {
    return {
      id: this.id,
      kind: this.kind,
      title: this.title,
      status: this.status,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      error: this.error,
      errorCode: this.errorCode || null,
      steps: this.steps.map((s) => ({ ...s })),
      currentStep: this.currentStep,
      seq: this.seq,
      lines: this.lines.filter((l) => l.seq > sinceSeq).map((l) => ({ ...l })),
    };
  }

  async cancel() {
    if (this.status !== 'running') return false;
    this.pushLine('err', '[面板] 收到取消请求，正在终止子进程…');
    for (const child of this.children) await killTree(child);
    this.finish('cancelled');
    return true;
  }
}

/**
 * 造一个**不占互斥名额**的任务对象，给只读探针用。
 *
 * 为什么不能自己写个 `{ log(){}, lines: [] }` 的空壳：spawnInto 会用到
 * job 的整整一组方法（log / line / flush / registry / stepDetail…），
 * 手写的壳每漏一个就在子进程收尾时炸一次。实测踩过这个坑——空壳漏了
 * flush()，spawnInto 的 `done()` 直接抛 "job.flush is not a function"，
 * 而它抛在 'close' 回调里，Promise 永远不 resolve，
 * 于是「检修」这个 HTTP 请求就一直挂着，看起来像面板卡死。
 *
 * 用真 Job 就没有这个问题：方法齐全，行为一致。
 * registry 留空即可绕过 register，也就绕过了「同一时刻只允许一个长任务」。
 */
export function detachedJob(kind, title, stepTitles = []) {
  return new Job(kind, title, stepTitles);
}

export class JobRegistry {
  constructor() {
    this.current = null;
    // 刚结束的那个任务对象。界面是「POST 拿到 jobId 之后」才去订阅 SSE 的，
    // 而「同步源码」这类任务可能在 POST 返回前就跑完了——不保留它，
    // 界面连上来只会拿到 404，看不到任何结果。
    this.lastFinished = null;
    this.recent = [];
  }

  /** 同一时刻只允许一个长任务，冲突时抛 409 语义的错误。 */
  create(kind, title, stepTitles) {
    if (this.current) {
      const e = new Error(`已有任务在进行中：${this.current.title}`);
      e.code = 'JOB_BUSY';
      e.runningJobId = this.current.id;
      throw e;
    }
    const job = new Job(kind, title, stepTitles);
    job.onFinish = [
      () => {
        this.recent.unshift({
          id: job.id,
          kind: job.kind,
          title: job.title,
          status: job.status,
          startedAt: job.startedAt,
          endedAt: job.endedAt,
          error: job.error,
        });
        this.recent = this.recent.slice(0, MAX_RECENT);
        if (this.current === job) this.current = null;
        this.lastFinished = job;
      },
    ];
    // 新任务开始时丢掉上一个，保证最多只额外留住一个任务的日志（内存有界）
    this.lastFinished = null;
    this.current = job;
    return job;
  }

  get(id) {
    if (this.current && this.current.id === id) return this.current;
    if (this.lastFinished && this.lastFinished.id === id) return this.lastFinished;
    return null;
  }

  /** 在任务上登记子进程，取消时统一按进程树杀掉。 */
  track(job, child) {
    job.children.add(child);
    child.once('exit', () => job.children.delete(child));
  }

  summary() {
    return {
      running: this.current ? { id: this.current.id, kind: this.current.kind, title: this.current.title } : null,
      // 供界面刷新后把「正在进行 / 刚刚结束」的任务面板重新画出来
      current: this.current ? this.current.snapshot(0) : null,
      lastFinished: this.lastFinished ? this.lastFinished.snapshot(0) : null,
      recent: this.recent.slice(0, 8),
    };
  }
}

/**
 * 跑一条命令并把 stdout/stderr 实时喂进 job 的日志流。
 * stdin 一律 'ignore'：这类工具（尤其 drizzle-kit）在检测到非 TTY 时若还等输入会挂死。
 */
export function spawnInto(job, cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, {
        cwd: opts.cwd,
        env: opts.env || process.env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      job.line('err', `无法启动 ${cmd}：${e.message}`);
      return resolve({ code: -1, error: e, output: '' });
    }
    job.registry?.track(job, child);
    // 末尾必须带换行：Job.log 会把没有换行的尾巴留在缓冲里等下一段拼接，
    // 而 Expand-Archive 这类命令会静默跑好几分钟——不换行的话界面上
    // 就一直显示上一条日志，看起来像卡死了。
    // quiet 用于探针类命令（pg_isready 这类每几百毫秒跑一次的），
    // 它们的输出由调用方自己翻译成人话，不需要把原始字节刷进界面。
    if (!opts.quiet) job.log('out', `$ ${cmd} ${args.join(' ')}\n`);
    let output = '';
    const collect = (d) => {
      // 只保留尾部，避免超长输出把内存吃掉；判定关键字只需要结尾部分
      output = (output + d.toString('utf8')).slice(-262144);
    };
    child.stdout?.on('data', (d) => {
      collect(d);
      if (!opts.quiet) job.log('out', d);
    });
    child.stderr?.on('data', (d) => {
      collect(d);
      if (!opts.quiet) job.log('err', d);
    });
    const timer = opts.timeoutMs
      ? setTimeout(async () => {
          job.line('err', `[面板] 超过 ${Math.round(opts.timeoutMs / 1000)}s 未结束，终止该命令。`);
          await killTree(child);
        }, opts.timeoutMs)
      : null;
    // 有些命令长时间不吐换行（进度条用 \r、或干脆静默）。定期把半行冲出去，
    // 界面才能看出命令还活着，而不是停在上一行日志上像卡死了。
    const flusher = setInterval(() => job.flush(), 4000);
    const done = () => {
      if (timer) clearTimeout(timer);
      clearInterval(flusher);
      job.flush();
    };
    child.once('error', (e) => {
      done();
      job.line('err', `${cmd} 启动失败：${e.message}\n`);
      resolve({ code: -1, error: e, output });
    });
    child.once('close', (code) => {
      done();
      resolve({ code: code === null ? -1 : code, output });
    });
  });
}
