import test from 'node:test';
import assert from 'node:assert/strict';
import { Subagents } from '../manager.mjs';
import { registerSubagents } from '../extension.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
class Session {
  model = { provider: 'test', id: 'model' };
  sessionManager = { getCwd: () => '/project' };
  listeners = new Set();
  prompts = [];
  queue = [];
  isIdle = true;
  isCompacting = false;
  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  emit(e) { for (const fn of this.listeners) fn(e); }
  async prompt(text, options = {}) {
    // Like SDK prompt(): finish input preparation, THEN recheck streaming.
    if (this.input) await this.input(text, options);
    if (!this.isIdle) {
      assert.equal(options.streamingBehavior, 'steer');
      return this.steer(text);
    }
    this.prompts.push(text); this.pending = deferred(); this.isIdle = false;
    this.emit({ type: 'agent_start' }); await this.pending.promise;
  }
  async waitForIdle() { while (!this.isIdle) await this.pending.promise; }
  async steer(text) { this.queue.push(text); this.emit({ type: 'queue_update', steering: this.queue, followUp: [] }); return 'queued'; }
  clearQueue() { const steering = this.queue; this.queue = []; this.emit({ type: 'queue_update', steering: [], followUp: [] }); return { steering, followUp: [] }; }
  async abort() { if (!this.isIdle) this.finish('', 'aborted'); }
  dispose() { this.disposed = true; }
  finish(text = 'done', stopReason = 'stop', errorMessage) {
    this.emit({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text }], stopReason, errorMessage } });
    this.emit({ type: 'agent_end' }); this.isIdle = true; this.emit({ type: 'agent_settled' }); this.pending.resolve();
  }
}
function fixture(options = {}) {
  const sessions = [], notifications = [];
  const manager = new Subagents({ createSession: async () => { const s = new Session(); sessions.push(s); return s; }, notify: r => notifications.push(r), ...options });
  return { manager, sessions, notifications };
}
const ctx = { cwd: '/project' };

test('default concurrency admits 16 running sessions and rejects the next', async () => {
  const { manager: m } = fixture();
  try {
    for (let i = 0; i < 16; i++) await m.start({ task: 'task' }, ctx);
    await assert.rejects(m.start({ task: 'over capacity' }, ctx), /最多同时运行 16/);
  } finally {
    await m.close();
  }
});

test('default retention admits 1024 completed sessions and rejects the next', async () => {
  const { manager: m, sessions } = fixture();
  try {
    assert.equal(m.maxRunning, 16);
    for (let i = 0; i < 1024; i++) {
      await m.start({ task: 'short task' }, ctx);
      sessions[i].finish();
      await tick();
    }
    assert.equal(m.status().length, 1024);
    await assert.rejects(m.start({ task: 'over capacity' }, ctx), /最多保留 1024/);
  } finally {
    await m.close();
  }
  assert.equal(m.records.size, 0);
  assert.ok(sessions.every(s => s.disposed));
});

test('background returns immediately; agent_end alone is not idle; text/question is just output', async () => {
  const { manager: m, ...f } = fixture();
  const first = await m.start({ task: 'review' }, ctx);
  const s = f.sessions[0];
  assert.equal(first.status, 'running');
  s.emit({ type: 'agent_end' });
  assert.equal(m.status({ id: first.id }).status, 'running');
  s.emit({ type: 'message_start', message: { role: 'assistant' } });
  s.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Keep ' } });
  assert.equal(m.status({ id: first.id }).lastOutput, 'Keep ');
  s.finish('Keep old config?'); await tick();
  const final = m.status({ id: first.id });
  assert.equal(final.status, 'idle'); assert.equal(final.lastRunOutcome, 'ended');
  assert.equal(final.lastOutput, 'Keep old config?'); assert.equal(final.lastOutputRun, 1);
  assert.equal(f.notifications.length, 1);
  await m.close();
});

test('foreground returns output without duplicate notification, then resumes same context', async () => {
  const { manager: m, sessions, notifications } = fixture();
  const work = m.start({ task: 'review', mode: 'foreground' }, ctx);
  await tick(); sessions[0].finish('question?');
  const first = await work;
  assert.equal(first.status, 'idle'); assert.equal(notifications.length, 0);
  const next = m.send({ id: first.id, action: 'message', message: 'answer' });
  await tick();
  const running = m.status({ id: first.id });
  assert.equal(running.run, 2); assert.equal(running.lastOutputRun, 1);
  sessions[0].finish('resolved');
  assert.equal((await next).lastOutput, 'resolved');
  assert.deepEqual(sessions[0].prompts, ['review', 'answer']);
  assert.equal(notifications.length, 0); await m.close();
});

test('background failure and retry each notify once; pagination does not change delivery', async () => {
  const { manager: m, sessions, notifications } = fixture();
  const r = await m.start({ task: 'task' }, ctx);
  sessions[0].finish('abcdef', 'error', 'provider failed'); await tick();
  const status = m.status({ id: r.id, detail: 'output', offset: 2, limit: 2 });
  assert.equal(status.status, 'idle'); assert.equal(status.lastRunOutcome, 'failed');
  assert.equal(status.error, 'provider failed'); assert.equal(status.lastOutput, 'cd'); assert.equal(status.nextOffset, 4);
  await m.send({ id: r.id, action: 'message', message: 'retry' });
  await tick(); sessions[0].emit({ type: 'message_end', message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'temporary' } });
  sessions[0].finish('success');
  assert.equal((await m.get(r.id).work).lastRunOutcome, 'ended');
  assert.deepEqual(notifications.map(n => n.lastRunOutcome), ['failed', 'ended']); await m.close();
});

test('token-limit end is idle, not business success, and exposes the exact stop reason', async () => {
  const { manager: m, sessions } = fixture();
  const work = m.start({ task: 'long response', mode: 'foreground' }, ctx);
  await tick(); sessions[0].finish('partial answer', 'length');
  const r = await work;
  assert.equal(r.status, 'idle'); assert.equal(r.lastRunOutcome, 'ended');
  assert.equal(r.lastRunStopReason, 'length'); await m.close();
});

test('SDK prompt rechecks streaming after delayed input crosses completion boundary', async () => {
  const { manager: m, sessions, notifications } = fixture();
  const r = await m.start({ task: 'first' }, ctx);
  const gate = deferred();
  const s = sessions[0];
  s.input = async (_text, options) => {
    assert.equal(options.streamingBehavior, 'steer');
    assert.equal(options.expandPromptTemplates, false);
    await gate.promise;
  };
  const sent = m.send({ id: r.id, action: 'message', message: 'second' });
  s.finish('first result'); await tick();
  assert.equal(m.status({ id: r.id }).status, 'running');
  gate.resolve(); await tick();
  assert.deepEqual(s.prompts, ['first', 'second']);
  assert.equal(notifications.length, 0);
  s.finish('second result');
  await sent;
  assert.equal((await m.get(r.id).work).lastOutput, 'second result');
  assert.equal(notifications.length, 1); await m.close();
});

test('stop clears queue; foreground abort cancels, background signal is detached', async () => {
  const { manager: m, sessions, notifications } = fixture();
  const abort = new AbortController();
  const r = await m.start({ task: 'first' }, ctx, abort.signal);
  abort.abort(); await tick();
  assert.equal(m.status({ id: r.id }).status, 'running');
  await m.send({ id: r.id, action: 'message', message: 'queued' });
  const stopped = await m.send({ id: r.id, action: 'stop' });
  assert.equal(stopped.status, 'idle'); assert.equal(stopped.lastRunOutcome, 'stopped');
  assert.equal(sessions[0].prompts.length, 1); assert.equal(notifications.length, 1);
  const fgAbort = new AbortController();
  const work = m.start({ task: 'next', mode: 'foreground' }, ctx, fgAbort.signal);
  await tick(); fgAbort.abort();
  assert.equal((await work).lastRunOutcome, 'stopped'); await m.close();
});

test('stop timeout does not claim idle; cleanup can be retried', async () => {
  const { manager: m, sessions } = fixture({ stopTimeout: 5 });
  const r = await m.start({ task: 'task' }, ctx);
  sessions[0].abort = async () => {};
  const stopped = await m.send({ id: r.id, action: 'stop' });
  assert.equal(stopped.status, 'running'); assert.equal(stopped.stopRequested, true);
  await assert.rejects(m.close(), /尚未确认停止/);
  sessions[0].finish(); await tick(); await m.close();
});

test('bounded concurrency includes startup, unknown IDs fail, close suppresses events', async () => {
  const { manager: m, sessions, notifications } = fixture({ maxRunning: 1 });
  const pending = m.start({ task: 'one' }, ctx);
  await assert.rejects(m.start({ task: 'two' }, ctx), /最多同时运行/);
  const r = await pending;
  assert.throws(() => m.status({ id: 'other-parent' }), /没有子会话/);
  await m.close(); assert.equal(sessions[0].disposed, true); assert.equal(notifications.length, 0);
  assert.throws(() => m.status({ id: r.id }), /没有子会话/);
});

test('closing during creation disposes the late session without starting it', async () => {
  const gate = deferred(); const session = new Session();
  const { manager: m } = fixture({ createSession: () => gate.promise });
  const start = m.start({ task: 'task' }, ctx);
  const rejected = assert.rejects(start, /启动已取消/);
  const close = m.close(); gate.resolve(session);
  await rejected; await close;
  assert.equal(session.disposed, true); assert.equal(session.prompts.length, 0);
});

test('synchronous prompt failure becomes visible failed outcome', async () => {
  const session = new Session(); session.prompt = async () => { throw new Error('missing auth'); };
  const { manager: m } = fixture({ createSession: async () => session });
  const r = await m.start({ task: 'task', mode: 'foreground' }, ctx);
  assert.equal(r.status, 'idle'); assert.equal(r.lastRunOutcome, 'failed'); assert.match(r.error, /auth/);
  await m.close();
});

test('extension exposes only start.mode, uses steer delivery and enforces ownership', async () => {
  const tools = new Map(), hooks = new Map(), messages = [], sessions = [];
  registerSubagents({ registerTool: t => tools.set(t.name, t), on: (e, fn) => hooks.set(e, fn), sendMessage: (...args) => messages.push(args) }, {},
    () => async () => { const s = new Session(); sessions.push(s); return s; });
  assert.deepEqual([...tools.keys()], ['subagent_start', 'subagent_observe', 'subagent_send']);
  for (const tool of tools.values()) assert.equal(tool.exposure, 'deferred');
  const context = { ...ctx, sessionManager: { getSessionId: () => 'parent-1' }, ui: { notify() {} } };
  const call = (name, args, c = context) => tools.get(name).execute('call', args, undefined, undefined, c);
  const started = await call('subagent_start', { task: 'review' });
  const r = started.details;
  assert.deepEqual(JSON.parse(started.content[0].text), r);
  assert.deepEqual(started.structuredContent, r);
  sessions[0].finish(); await tick();
  assert.equal(messages.length, 1); assert.deepEqual(messages[0][1], { deliverAs: 'steer', triggerTurn: true });
  assert.deepEqual(JSON.parse(messages[0][0].content), messages[0][0].details);
  assert.equal(messages[0][0].details.event, 'subagent_run_ended');
  assert.equal(messages[0][0].details.status, 'idle');
  const status = await call('subagent_observe', { id: r.id });
  assert.deepEqual(JSON.parse(status.content[0].text), status.structuredContent);
  const stopped = await call('subagent_send', { id: r.id, action: 'stop' });
  assert.deepEqual(JSON.parse(stopped.content[0].text), stopped.structuredContent);
  assert.equal((await call('subagent_send', { id: r.id, action: 'stop', message: 'invalid' })).isError, true);
  assert.equal(tools.get('subagent_start').parameters.properties.notify, undefined);
  assert.deepEqual(tools.get('subagent_start').parameters.properties.mode.enum, ['foreground', 'background']);
  assert.equal(tools.get('subagent_send').parameters.properties.mode, undefined);
  assert.equal(tools.get('subagent_start').parameters.additionalProperties, false);
  assert.equal(tools.get('subagent_send').parameters.additionalProperties, false);
  assert.equal(r.mode, 'background');
  assert.equal('notify' in r, false);
  assert.equal((await call('subagent_observe', {}, { ...context, sessionManager: { getSessionId: () => 'parent-2' } })).isError, true);
  await hooks.get('session_before_switch')({}, context);
  assert.equal(sessions[0].disposed, true);
  assert.deepEqual((await call('subagent_observe', {})).details, []);
});

test('external prompt/abort updates runs, output, capacity and notification without manager dispatch', async () => {
  const { manager: m, sessions, notifications } = fixture({ maxRunning: 1 });
  const first = await m.start({ task: 'first' }, ctx);
  const s = sessions[0]; s.finish(); await tick();
  s.model = { provider: 'changed', id: 'other-model' };
  assert.equal(m.status({ id: first.id }).model, 'changed/other-model');
  const direct = s.prompt('UI');
  assert.equal(m.status({ id: first.id }).run, 2);
  assert.equal(m.isRunning(m.get(first.id)), true);
  await assert.rejects(m.start({ task: 'over capacity' }, ctx), /最多同时运行/);
  s.finish('UI output'); await direct; await m.get(first.id).work;
  assert.equal(notifications.length, 2);
  assert.equal(notifications[1].lastOutputRun, 2);
  const aborted = s.prompt('cancel from UI'); await s.abort(); await aborted; await m.get(first.id).work;
  assert.equal(notifications.length, 3);
  assert.equal(notifications[2].lastRunOutcome, 'stopped');
  assert.equal(notifications[2].run, 3);
  assert.equal(m.status({ id: first.id }).status, 'idle');
  await m.close();
});

test('external run accepts tool steering; late dispatch stays in same round', async () => {
  const { manager: m, sessions, notifications } = fixture();
  const first = await m.start({ task: 'first' }, ctx);
  const s = sessions[0]; s.finish(); await tick(); notifications.length = 0;
  const external = s.prompt('UI');
  const gate = deferred();
  s.input = async (_text, options) => {
    assert.equal(options.streamingBehavior, 'steer');
    assert.equal(options.expandPromptTemplates, false);
    await gate.promise;
  };
  const sent = m.send({ id: first.id, action: 'message', message: 'tool steer' });
  s.finish('UI answer'); await external; await tick();
  assert.equal(m.status({ id: first.id }).status, 'running');
  gate.resolve(); await tick();
  assert.deepEqual(s.prompts, ['first', 'UI', 'tool steer']);
  s.finish('steered answer');
  await sent;
  const result = await m.get(first.id).work;
  assert.equal(result.lastOutput, 'steered answer'); assert.equal(result.run, 2);
  assert.equal(notifications.length, 1); await m.close();
});

test('external settled deferred continuation is not prematurely finalized', async () => {
  const { manager: m, sessions, notifications } = fixture();
  const first = await m.start({ task: 'first' }, ctx);
  const s = sessions[0]; s.finish(); await tick(); notifications.length = 0;
  const external = s.prompt('UI'); s.finish('before deferred');
  // SDK runs deferred settled actions after notifying public settled listeners.
  const continuation = s.prompt('deferred');
  await external; await tick(); await tick();
  assert.equal(m.status({ id: first.id }).status, 'running');
  assert.equal(notifications.length, 0);
  s.finish('after deferred'); await continuation; await m.get(first.id).work;
  assert.equal(notifications.length, 1); assert.equal(notifications[0].run, 2);
  assert.equal(notifications[0].lastOutput, 'after deferred'); await m.close();
});

test('external run overlapping owned input drain cannot be marked idle by older work', async () => {
  const { manager: m, sessions, notifications } = fixture();
  const first = await m.start({ task: 'first' }, ctx);
  const s = sessions[0], gate = deferred();
  s.input = async text => { if (text === 'slow input') await gate.promise; };
  const sent = m.send({ id: first.id, action: 'message', message: 'slow input' });
  s.finish('first result'); await tick();
  const external = s.prompt('UI'); gate.resolve(); await sent; await tick();
  assert.equal(m.status({ id: first.id }).status, 'running');
  assert.equal(notifications.length, 0);
  s.finish('external result'); await external; await m.get(first.id).work;
  assert.equal(notifications.length, 1); assert.equal(notifications[0].lastOutput, 'external result');
  await m.close();
});

test('manual compaction is busy without a business run; close waits and emits no result', async () => {
  const { manager: m, sessions, notifications } = fixture({ maxRunning: 1 });
  const first = await m.start({ task: 'first' }, ctx);
  const s = sessions[0]; s.finish(); await tick(); notifications.length = 0;
  s.isIdle = false; s.isCompacting = true; s.pending = deferred();
  const before = m.status({ id: first.id });
  assert.equal(before.status, 'running'); assert.equal(before.run, 1);
  assert.equal(m.isRunning(m.get(first.id)), true);
  await assert.rejects(m.start({ task: 'capacity' }, ctx), /最多同时运行/);
  await assert.rejects(m.send({ id: first.id, action: 'message', message: 'during compact' }), /SDK 操作/);
  s.abort = async () => { s.isCompacting = false; s.isIdle = true; s.pending.resolve(); };
  await m.close(); assert.equal(s.disposed, true); assert.equal(notifications.length, 0);
});

test('external preflight failure creates no run; foreground external run and close do not notify', async () => {
  const { manager: m, sessions, notifications } = fixture();
  const starting = m.start({ task: 'first', mode: 'foreground' }, ctx);
  await tick();
  const s = sessions[0]; s.finish();
  const first = await starting;
  const prompt = s.prompt;
  s.prompt = async () => { throw new Error('preflight failed'); };
  await assert.rejects(s.prompt('invalid'), /preflight/);
  assert.equal(m.status({ id: first.id }).run, 1);
  s.prompt = prompt;
  const external = s.prompt('UI foreground'); s.finish(); await external; await m.get(first.id).work;
  assert.equal(notifications.length, 0);
  const closing = s.prompt('close while external');
  await m.close(); await closing;
  assert.equal(s.disposed, true); assert.equal(notifications.length, 0);
});

test('pure external settled observation preserves SDK queues and never resubmits them', async () => {
  const { manager: m, sessions, notifications } = fixture();
  const first = await m.start({ task: 'first' }, ctx);
  const s = sessions[0]; s.finish(); await tick(); notifications.length = 0;
  const clearQueue = s.clearQueue;
  s.clearQueue = () => { throw new Error('observer must not clear SDK queue'); };
  const external = s.prompt('UI');
  await s.steer('UI owns this queued instruction');
  s.finish('UI done'); await external; await m.get(first.id).work;
  assert.deepEqual(s.prompts, ['first', 'UI']);
  assert.deepEqual(s.queue, ['UI owns this queued instruction']);
  assert.equal(m.status({ id: first.id }).queuedMessages, 1);
  assert.equal(m.status({ id: first.id }).status, 'idle');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].queuedMessages, 1);
  s.clearQueue = clearQueue; await m.close();
});

test('rejected streaming prompt does not take ownership of an external queue', async () => {
  const { manager: m, sessions } = fixture();
  const first = await m.start({ task: 'first' }, ctx);
  const s = sessions[0]; s.finish(); await tick();
  const external = s.prompt('UI'); await s.steer('UI queued');
  s.input = async () => { throw new Error('input rejected'); };
  await assert.rejects(m.send({ id: first.id, action: 'message', message: 'tool input' }), /input rejected/);
  s.finish(); await external; await m.get(first.id).work;
  assert.deepEqual(s.prompts, ['first', 'UI']);
  assert.deepEqual(s.queue, ['UI queued']);
  assert.equal(m.status({ id: first.id }).queuedMessages, 1);
  await m.close();
});

test('mixed UI image queue and tool streaming prompt are never cleared or replayed by manager', async () => {
  for (const externalOwner of [false, true]) {
    const { manager: m, sessions, notifications } = fixture();
    const first = await m.start({ task: 'first' }, ctx);
    const s = sessions[0];
    let external;
    if (externalOwner) {
      s.finish(); await tick(); notifications.length = 0;
      external = s.prompt('UI run');
    }
    const imageMessage = { text: 'inspect this image', images: [{ type: 'image', mimeType: 'image/png', data: 'image-data' }] };
    await s.steer(imageMessage);
    s.clearQueue = () => { throw new Error('must not clear shared image queue'); };
    await m.send({ id: first.id, action: 'message', message: 'tool instruction' });
    // Model a final SDK queue boundary: neither queued input was consumed.
    s.finish('boundary result'); await external;
    const result = await m.get(first.id).work;
    assert.equal(result.status, 'idle'); assert.equal(result.queuedMessages, 2);
    assert.equal(s.queue[0], imageMessage);
    assert.equal(s.queue[1], 'tool instruction');
    assert.deepEqual(s.prompts, externalOwner ? ['first', 'UI run'] : ['first']);
    assert.equal(notifications.length, 1);
    await m.close();
  }
});

for (const mode of ['foreground', 'background']) {
  test(`${mode}: running messages return on acceptance and keep one delivery owner`, async () => {
    const { manager: m, sessions, notifications } = fixture();
    let delivered = false;
    const starting = m.start({ task: 'first', mode }, ctx).then(result => { delivered = true; return result; });
    await tick();
    const [initial] = m.status();
    assert.equal(initial.mode, mode);
    assert.equal(delivered, mode === 'background');
    const signal = new AbortController();
    const one = await m.send({ id: initial.id, action: 'message', message: 'one' }, signal.signal);
    const two = await m.send({ id: initial.id, action: 'message', message: 'two' });
    assert.equal(one.status, 'running'); assert.equal(two.status, 'running');
    assert.equal(two.queuedMessages, 2); assert.equal(two.run, 1);
    assert.equal(two.mode, mode); assert.equal(delivered, mode === 'background');
    signal.abort(); // Supplementary input does not own/cancel the active run.
    assert.equal(m.status({ id: initial.id }).status, 'running');
    assert.equal(notifications.length, 0);
    sessions[0].clearQueue(); // Simulate the SDK consuming both instructions.
    sessions[0].finish('both handled');
    const final = await m.get(initial.id).work;
    const returned = await starting;
    assert.equal(final.lastOutput, 'both handled'); assert.equal(final.run, 1);
    if (mode === 'foreground') assert.equal(returned.lastOutput, 'both handled');
    assert.equal(notifications.length, mode === 'background' ? 1 : 0);
    m.status({ id: initial.id }); // Reading does not affect delivery.
    assert.equal(notifications.length, mode === 'background' ? 1 : 0);
    await m.close();
  });

  test(`${mode}: explicit stop leaves final delivery on the original channel`, async () => {
    const { manager: m, sessions, notifications } = fixture();
    const starting = m.start({ task: 'first', mode }, ctx);
    await tick();
    const [initial] = m.status();
    const stopped = await m.send({ id: initial.id, action: 'stop' });
    const returned = await starting;
    assert.equal(stopped.lastRunOutcome, 'stopped');
    if (mode === 'foreground') assert.equal(returned.lastRunOutcome, 'stopped');
    assert.equal(notifications.length, mode === 'background' ? 1 : 0);
    await m.send({ id: initial.id, action: 'stop' });
    assert.equal(notifications.length, mode === 'background' ? 1 : 0);
    assert.equal(sessions[0].prompts.length, 1);
    await m.close();
  });
}

test('background stop timeout still delivers once when execution really stops', async () => {
  const { manager: m, sessions, notifications } = fixture({ stopTimeout: 5 });
  const first = await m.start({ task: 'first' }, ctx);
  sessions[0].abort = async () => {};
  const stopping = await m.send({ id: first.id, action: 'stop' });
  assert.equal(stopping.status, 'running'); assert.equal(notifications.length, 0);
  sessions[0].finish('', 'aborted'); await m.get(first.id).work;
  assert.equal(notifications.length, 1); assert.equal(notifications[0].lastRunOutcome, 'stopped');
  await m.close();
});

test('observe defaults to snapshot, validates timeout and requires id for waiting', async () => {
  const { manager: m } = fixture();
  const r = await m.start({ task: 'task' }, ctx);
  assert.equal((await m.observeStatus({ id: r.id })).timedOut, false);
  assert.equal((await m.observeStatus()).length, 1);
  for (const timeoutSeconds of [-1, 241, Infinity, NaN, '1'])
    await assert.rejects(m.observeStatus({ id: r.id, timeoutSeconds }), /timeoutSeconds/);
  await assert.rejects(m.observeStatus({ timeoutSeconds: 1 }), /id/);
  await m.close();
});

test('observe waits for completion, paginates and avoids duplicate background delivery', async () => {
  const { manager: m, sessions, notifications } = fixture();
  const r = await m.start({ task: 'task' }, ctx);
  let returned = false;
  const waiting = m.observeStatus({ id: r.id, timeoutSeconds: 240, offset: 1, limit: 2 }).then(r => { returned = true; return r; });
  await tick(); assert.equal(returned, false);
  sessions[0].emit({ type: 'agent_end' }); await tick(); assert.equal(returned, false);
  sessions[0].finish('abcdef', 'error', 'failed');
  const result = await waiting;
  assert.equal(result.lastOutput, 'bc'); assert.equal(result.lastRunOutcome, 'failed');
  assert.equal(result.timedOut, false); assert.equal(notifications.length, 0);
  assert.equal((await m.observeStatus({ id: r.id, timeoutSeconds: 240 })).status, 'idle');
  assert.equal(m.get(r.id).observers.size, 0);
  await m.close();
});

test('observe timeout and cancellation leave child running and preserve later notification', async () => {
  for (const cancel of [false, true]) {
    const { manager: m, sessions, notifications } = fixture();
    const r = await m.start({ task: 'task' }, ctx);
    const controller = new AbortController();
    const waiting = m.observeStatus({ id: r.id, timeoutSeconds: cancel ? 240 : 0.01 }, controller.signal);
    if (cancel) { controller.abort(); await assert.rejects(waiting, /观察已取消/); }
    else assert.equal((await waiting).timedOut, true);
    assert.equal(m.status({ id: r.id }).status, 'running');
    assert.equal(m.get(r.id).observers.size, 0);
    sessions[0].finish(); await tick(); assert.equal(notifications.length, 1);
    await m.close();
  }
});
