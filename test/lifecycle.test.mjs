import test from 'node:test';
import assert from 'node:assert/strict';
import { Subagents } from '../manager.mjs';
import { registerSubagents } from '../extension.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture() {
  let resolve;
  const listeners = new Set();
  const session = {
    sessionId: 'child', sessionFile: '/sessions/child.jsonl', prompts: [], disposed: false, isIdle: true,
    sessionManager: { getCwd: () => '/project' },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async prompt(message) {
      this.prompts.push(message); this.isIdle = false;
      const work = new Promise(done => { resolve = done; });
      for (const fn of listeners) fn({ type: 'agent_start' });
      await work;
    },
    async waitForIdle() {},
    async steer(message) { this.steered = message; },
    clearQueue() { return { steering: [], followUp: [] }; },
    async abort() { if (!this.isIdle) this.finish('aborted'); },
    finish(stopReason = 'stop') {
      for (const fn of listeners) fn({ type: 'message_end', message: { role: 'assistant', content: [], stopReason } });
      for (const fn of listeners) fn({ type: 'agent_end' });
      this.isIdle = true;
      for (const fn of listeners) fn({ type: 'agent_settled' });
      resolve();
    },
    dispose() { this.disposed = true; },
  };
  const manager = new Subagents({ createSession: async () => session, notify() {} });
  return { session, manager };
}

test('extension does not register sessions or liveness with host bridges', async t => {
  for (const name of ['@agegr/pi-web/external-sessions/v1', '@agegr/pi-web/session-liveness/v1']) {
    const key = Symbol.for(name), previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, get() { throw new Error('Must not access host bridge'); } });
    t.after(() => { if (previous) Object.defineProperty(globalThis, key, previous); else delete globalThis[key]; });
  }
  const { session } = fixture();
  const hooks = new Map(), tools = new Map();
  registerSubagents({ on: (name, fn) => hooks.set(name, fn), registerTool: tool => tools.set(tool.name, tool), sendMessage() {} }, {}, () => async () => session);
  const ctx = { cwd: '/project', sessionManager: { getSessionId: () => 'parent' } };
  const started = await tools.get('subagent_start').execute('call', { task: 'work' }, undefined, undefined, ctx);
  assert.equal(started.isError, undefined);
  await tick();
  await hooks.get('session_shutdown')();
  assert.equal(session.disposed, true);
});

test('parent shutdown timeout retains cleanup responsibility until child stops', async t => {
  const { session } = fixture();
  session.abort = async () => {}; // A tool ignores cancellation until it finishes.
  const hooks = new Map(), tools = new Map();
  registerSubagents({ on: (name, fn) => hooks.set(name, fn), registerTool: tool => tools.set(tool.name, tool), sendMessage() {} }, {}, () => async () => session);
  const ctx = { cwd: '/project', sessionManager: { getSessionId: () => 'parent', getSessionFile: () => '/parent.jsonl' } };
  const started = await tools.get('subagent_start').execute('call', { task: 'work' }, undefined, undefined, ctx);
  assert.equal(started.isError, undefined);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const shutdown = assert.rejects(hooks.get('session_shutdown')(), /尚未确认停止/);
  await tick(); t.mock.timers.tick(5001);
  await shutdown;
  t.mock.timers.reset();
  assert.equal(session.disposed, false);
  session.finish();
  await tick(); await tick();
  assert.equal(session.disposed, true);
});

test('closed manager still permits retrying Stop, but not a new message', async () => {
  const { manager, session } = fixture();
  manager.stopTimeout = 1;
  const first = await manager.start({ task: 'work' }, { cwd: '/project' });
  const abort = session.abort.bind(session);
  session.abort = async () => {};
  await assert.rejects(manager.close(), /尚未确认停止/);
  await assert.rejects(manager.send({ id: first.id, action: 'message', message: 'new' }), /已关闭/);
  session.abort = abort;
  assert.equal((await manager.send({ id: first.id, action: 'stop' })).status, 'idle');
  await manager.close();
});
