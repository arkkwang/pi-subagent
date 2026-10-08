import { randomUUID } from 'node:crypto';

// Shared by runtime validation and the tool schema (seconds).
export const OBSERVE_MAX_TIMEOUT_SECONDS = 240;

const textOf = message => (message?.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
const errorText = error => error instanceof Error ? error.message : String(error);
const now = () => new Date().toISOString();

/** One manager belongs to one parent session. SDK work, not model prose, owns status. */
export class Subagents {
  constructor({ createSession, notify, maxRunning = 16, maxSessions = 1024, stopTimeout = 5000 }) {
    Object.assign(this, { createSession, notify, maxRunning, maxSessions, stopTimeout });
    this.records = new Map();
    this.closed = false;
    this.starting = 0;
    this.creating = new Set();
  }

  isRunning(r) {
    return r.status === 'running' || !r.session.isIdle || r.session.isCompacting;
  }

  checkCapacity() {
    if (this.closed) throw new Error('子会话管理器已关闭。');
    if (this.starting + [...this.records.values()].filter(r => this.isRunning(r)).length >= this.maxRunning)
      throw new Error(`最多同时运行 ${this.maxRunning} 个子会话；请先等待或停止已有任务。`);
  }

  get(id) {
    const record = this.records.get(id);
    if (!record) throw new Error(`当前主会话没有子会话 ${id}。`);
    return record;
  }

  snapshot(r, { detail = 'summary', offset = 0, limit = detail === 'output' ? 16000 : 2000 } = {}) {
    limit = Math.min(Math.max(limit, 1), 32000);
    return {
      id: r.id, name: r.name, cwd: r.cwd,
      model: r.session.model ? `${r.session.model.provider}/${r.session.model.id}` : null,
      status: this.isRunning(r) ? 'running' : 'idle', run: r.run,
      mode: r.mode, startedAt: r.startedAt, endedAt: r.endedAt,
      lastActivity: r.lastActivity, queuedMessages: r.queuedMessages,
      lastOutput: r.lastOutput.slice(offset, offset + limit), lastOutputAt: r.lastOutputAt,
      lastOutputRun: r.lastOutputRun,
      outputOffset: offset, outputLength: r.lastOutput.length,
      nextOffset: offset + limit < r.lastOutput.length ? offset + limit : null,
      lastRunOutcome: r.lastRunOutcome, lastRun: r.lastRun, lastRunStopReason: r.lastRunStopReason,
      error: r.error, stopRequested: r.stopRequested,
      notificationError: r.notificationError,
      sessionFile: r.session.sessionFile ?? null,
    };
  }

  status(args = {}) {
    if (args.id) return this.snapshot(this.get(args.id), args);
    return [...this.records.values()].map(r => this.snapshot(r));
  }

  async observeStatus(args = {}, signal) {
    const { timeoutSeconds = 0 } = args;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > OBSERVE_MAX_TIMEOUT_SECONDS)
      throw new Error(`timeoutSeconds 必须在 0 到 ${OBSERVE_MAX_TIMEOUT_SECONDS} 秒之间。`);
    if (timeoutSeconds > 0 && !args.id) throw new Error('等待观察必须指定 id。');
    if (signal?.aborted) throw new Error('观察已取消；子任务继续运行。');
    if (!args.id) return this.status(args);
    const r = this.get(args.id);
    if (!timeoutSeconds || !this.isRunning(r)) return { ...this.snapshot(r, args), timedOut: false };
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        r.observers.delete(done);
        signal?.removeEventListener('abort', abort);
      };
      const done = (timedOut = false) => {
        cleanup();
        resolve({ ...this.snapshot(r, args), timedOut });
      };
      const abort = () => { cleanup(); reject(new Error('观察已取消；子任务继续运行。')); };
      r.observers.add(done);
      signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(() => done(true), timeoutSeconds * 1000);
      // Manual SDK compaction is busy but does not produce a manager run/finish.
      if (r.status !== 'running') r.session.waitForIdle().then(() => {
        if (r.observers.has(done) && !this.isRunning(r)) done();
      }, error => { if (r.observers.has(done)) { cleanup(); reject(error); } });
    });
  }

  async start(args, context, signal) {
    this.checkCapacity();
    if (this.records.size + this.starting >= this.maxSessions)
      throw new Error(`当前主会话最多保留 ${this.maxSessions} 个子会话。`);
    this.starting++;
    const creation = Promise.resolve().then(() => this.createSession(args, context));
    this.creating.add(creation);
    let session;
    try {
      session = await creation;
      if (this.closed || signal?.aborted) {
        session.dispose();
        throw new Error('子会话启动已取消。');
      }
    } finally {
      this.creating.delete(creation);
      this.starting--;
    }
    const r = {
      id: `sa-${randomUUID().slice(0, 8)}`, name: args.name ?? '子任务', session,
      cwd: session.sessionManager?.getCwd() ?? context.cwd,
      status: 'idle', run: 0, mode: args.mode ?? 'background',
      lastOutput: '', lastOutputAt: null, lastOutputRun: null,
      lastRunOutcome: null, lastRun: null, lastRunStopReason: null, error: null, notificationError: null,
      startedAt: null, endedAt: null, lastActivity: null, queuedMessages: 0,
      stopRequested: false, dispatches: new Set(), observers: new Set(),
    };
    r.unsubscribe = session.subscribe(event => this.onEvent(r, event));
    this.records.set(r.id, r);
    this.launch(r, args.task);
    return r.mode === 'foreground' ? this.wait(r, signal) : this.snapshot(r);
  }

  onEvent(r, event) {
    if (event.type === 'agent_start' && r.status !== 'running') {
      this.begin(r);
      // External callers own prompt(), but tool foreground/stop still need a work promise.
      const settled = new Promise(resolve => { r.settle = resolve; });
      // SDK settled listeners run BEFORE deferred continuations. Let those start,
      // then observe actual idle without taking ownership of the caller's queue.
      r.work = settled.then(() => new Promise(resolve => setImmediate(resolve)))
        .then(() => this.observe(r));
    }
    if (event.type === 'agent_settled') {
      r.settle?.();
      r.settle = null;
    }
    if (event.type === 'message_start' && event.message.role === 'assistant') r.partial = '';
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      r.partial = (r.partial ?? '') + event.assistantMessageEvent.delta;
      this.output(r, r.partial);
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const text = textOf(event.message);
      if (text) this.output(r, text);
      // Retried errors may be followed by a successful message. Only the latest counts.
      r.stopReason = event.message.stopReason;
      r.runError = event.message.errorMessage ?? null;
    }
    if (event.type === 'tool_execution_start') r.lastActivity = { type: 'tool', name: event.toolName, at: now() };
    if (event.type === 'queue_update') r.queuedMessages = event.steering.length + event.followUp.length;
    // agent_end is NOT completion: recovery, compaction and queued work may follow.
  }

  output(r, text) {
    r.lastOutput = text;
    r.lastOutputAt = now();
    r.lastOutputRun = r.run;
    r.lastActivity = { type: 'output', at: r.lastOutputAt };
  }

  begin(r) {
    r.status = 'running';
    r.run++;
    r.startedAt = now();
    r.endedAt = null;
    r.stopRequested = false;
    r.error = null;
    r.runError = null;
    r.stopReason = null;
    r.notificationError = null;
  }

  async observe(r, failure) {
    do {
      await r.session.waitForIdle();
      while (r.dispatches.size) await Promise.allSettled([...r.dispatches]);
    } while (!r.session.isIdle);
    return this.finish(r, failure);
  }

  launch(r, message) {
    this.begin(r);
    // Defer execution so callers can observe the accepted run before it settles.
    r.work = Promise.resolve().then(() => this.run(r, message));
  }

  async run(r, message) {
    let failure;
    try {
      if (!r.stopRequested)
        await r.session.prompt(message, { expandPromptTemplates: false });
    } catch (error) {
      failure = errorText(error);
    }
    return this.observe(r, failure);
  }

  finish(r, failure) {
    r.status = 'idle';
    r.endedAt = now();
    r.lastRun = r.run;
    r.lastRunStopReason = r.stopReason;
    r.lastRunOutcome = r.stopRequested || r.stopReason === 'aborted' ? 'stopped'
      : failure || r.stopReason === 'error' ? 'failed' : 'ended';
    r.error = r.lastRunOutcome === 'failed' ? failure || r.runError || '模型执行失败。' : null;
    const result = this.snapshot(r);
    const observed = r.observers.size > 0;
    for (const done of [...r.observers]) done();
    if (!this.closed && r.mode === 'background' && !observed) {
      try { this.notify(result); }
      catch (error) { r.notificationError = errorText(error); }
    }
    return result;
  }

  async send(args, signal) {
    const r = this.get(args.id);
    if (args.action === 'stop') return this.stop(r);
    if (this.closed) throw new Error('子会话管理器已关闭。');
    if (!args.message?.trim()) throw new Error('message 动作需要非空 message。');
    if (r.stopRequested && this.isRunning(r)) throw new Error('正在停止，确认 idle 后再发送消息。');
    if (signal?.aborted) throw new Error('发送已取消。');
    if (r.status === 'idle') {
      if (this.isRunning(r)) throw new Error('子会话正在处理 SDK 操作，请等待 idle 后再发送消息。');
      this.checkCapacity();
      this.launch(r, args.message);
      return r.mode === 'foreground' ? this.wait(r, signal) : this.snapshot(r);
    }
    // Supplement the active run; do not create another result consumer.
    const dispatch = r.session.prompt(args.message, { streamingBehavior: 'steer', expandPromptTemplates: false });
    r.dispatches.add(dispatch);
    try { await dispatch; }
    finally { r.dispatches.delete(dispatch); }
    return this.snapshot(r);
  }

  async wait(r, signal) {
    let onAbort;
    const cancelled = new Promise(resolve => {
      onAbort = () => { this.stop(r).then(resolve, error => resolve({ ...this.snapshot(r), error: errorText(error) })); };
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    try { return await Promise.race([r.work, cancelled]); }
    finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  async stop(r) {
    if (!this.isRunning(r)) return this.snapshot(r);
    if (!r.stopping) {
      if (r.status === 'running') r.stopRequested = true;
      r.session.clearQueue();
      r.stopping = (async () => {
        let timer;
        try {
          const stopped = Promise.resolve().then(async () => {
            await r.session.abort();
            await r.work;
          });
          await Promise.race([stopped, new Promise(resolve => { timer = setTimeout(resolve, this.stopTimeout); })]);
          return this.snapshot(r); // timeout retains running + stopRequested, never claims idle
        } finally { clearTimeout(timer); r.stopping = null; }
      })();
    }
    return r.stopping;
  }

  async close() {
    this.closed = true; // Suppress notifications into a different parent session.
    await Promise.allSettled([...this.creating]);
    await Promise.all([...this.records.values()].map(r => this.stop(r)));
    if ([...this.records.values()].some(r => this.isRunning(r)))
      throw new Error('部分子任务尚未确认停止；不能切换会话，请稍后重试。');
    for (const r of this.records.values()) { r.unsubscribe(); r.session.dispose(); }
    this.records.clear();
  }
}
