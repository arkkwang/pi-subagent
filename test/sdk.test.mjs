import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Subagents } from '../manager.mjs';
import { sessionFactory } from '../sessions.mjs';

const entry = process.env.PI_SDK_ENTRY;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) { for (let i = 0; i < 400; i++) { if (fn()) return; await sleep(10); } throw new Error('condition timeout'); }

test('real SDK: isolated resources, streamed Last Output, read tool, steering, stop, resume, loader',
  { skip: !entry && 'Set PI_SDK_ENTRY to the installed Pi dist/index.js', timeout: 30000 }, async () => {
  const sdk = await import(pathToFileURL(path.resolve(entry)).href);
  const dir = await mkdtemp(path.join(tmpdir(), 'pi-subagent-sdk-'));
  const agentDir = path.join(dir, 'agent');
  const cwd = path.join(dir, 'project');
  await mkdir(agentDir); await mkdir(cwd);
  await writeFile(path.join(cwd, 'AGENTS.md'), 'PROJECT_SENTINEL: preserve project rules.');
  await writeFile(path.join(cwd, 'sample.txt'), 'fixture-content');
  const requests = [];
  const held = [];
  let behavior = 'read';
  function chunk(response, delta, finish_reason = null) {
    response.write(`data: ${JSON.stringify({ id: 'probe', object: 'chat.completion.chunk', created: 1, model: 'probe', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  function complete(response, text) {
    chunk(response, { role: 'assistant', content: text });
    chunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
  }
  const server = createServer(async (request, response) => {
    let raw = ''; for await (const data of request) raw += data;
    const body = JSON.parse(raw); requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (behavior === 'hold') {
      chunk(response, { role: 'assistant', content: 'partial' }); held.push(response); return;
    }
    if (behavior === 'read' && !body.messages.some(m => m.role === 'tool')) {
      chunk(response, { role: 'assistant', tool_calls: [{ index: 0, id: 'read1', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: 'sample.txt' }) } }] });
      chunk(response, {}, 'tool_calls'); response.end('data: [DONE]\n\n'); return;
    }
    complete(response, 'Keep old config?');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { probe: {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'test-only',
    models: [{ id: 'probe', name: 'Probe', reasoning: false, input: ['text'], contextWindow: 32768, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  } } }));
  await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 32 }, retry: { enabled: false }, cacheWarming: 'off',
  }));
  // Override only locations. Execution, auth, provider parser, tools and queues are real SDK code.
  const isolated = { ...sdk, getAgentDir: () => agentDir, ModelRuntime: {
    create: () => sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'), modelsPath: path.join(agentDir, 'models.json'), modelsStorePath: path.join(agentDir, 'catalog.json'), refreshOnCreate: false }),
  } };
  const sessions = [], notifications = [];
  const factory = sessionFactory(isolated);
  const m = new Subagents({ createSession: async (...args) => { const session = await factory(...args); sessions.push(session); return session; }, notify: r => notifications.push(r) });
  const context = { cwd, model: { provider: 'probe', id: 'probe' }, thinkingLevel: 'off', isProjectTrusted: () => true,
    sessionManager: { getSessionFile: () => undefined } };
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const first = await m.start({ name: '侧栏标题验证', task: 'Read sample.txt, then ask whether to keep config.', mode: 'foreground' }, context);
    assert.equal(first.mode, 'foreground');
    assert.equal(first.status, 'idle'); assert.equal(first.lastRunOutcome, 'ended', first.error);
    assert.equal(first.lastOutput, 'Keep old config?'); assert.equal(notifications.length, 0);
    assert.equal(requests.length, 2);
    assert(requests[1].messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes('fixture-content')));
    assert.match(sessions[0].systemPrompt, /PROJECT_SENTINEL/);
    assert.deepEqual(sessions[0].getActiveToolNames().sort(), ['bash', 'edit', 'read', 'write']);
    assert(first.sessionFile.startsWith(path.join(agentDir, 'sessions') + path.sep));
    assert.notEqual(path.dirname(first.sessionFile), path.join(agentDir, 'sessions')); // native cwd grouping
    const listed = await sdk.SessionManager.list(cwd);
    assert(listed.some(item => item.path === first.sessionFile), 'Default Pi session listing must discover child sessions');
    assert.equal(first.name, '侧栏标题验证');
    assert.equal(listed.find(item => item.path === first.sessionFile).name, first.name);
    assert.equal(sdk.SessionManager.open(first.sessionFile).getSessionName(), first.name);

    behavior = 'hold';
    let foregroundRun = m.send({ id: first.id, action: 'message', message: 'Start another check.' });
    await until(() => m.status({ id: first.id }).lastOutput === 'partial');
    assert.equal(m.status({ id: first.id }).status, 'running');
    await m.send({ id: first.id, action: 'message', message: 'Additional instruction.' });
    assert.equal(m.status({ id: first.id }).queuedMessages, 1);
    behavior = 'normal'; complete(held.shift(), ' done');
    await until(() => m.status({ id: first.id }).status === 'idle');
    assert(requests.at(-1).messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('Additional instruction.')));
    if (foregroundRun) assert.equal((await foregroundRun).status, 'idle');
    assert.equal(notifications.length, 0, 'foreground mode remains fixed');

    behavior = 'hold';
    foregroundRun = m.send({ id: first.id, action: 'message', message: 'Check until stopped.' });
    await until(() => held.length === 1);
    const stopped = await m.send({ id: first.id, action: 'stop' });
    assert.equal(stopped.status, 'idle'); assert.equal(stopped.lastRunOutcome, 'stopped');
    await foregroundRun;
    assert.equal(notifications.length, 0, 'foreground stop never emits a duplicate notification');
    behavior = 'normal';
    const resumed = await m.send({ id: first.id, action: 'message', message: 'Continue after stop.' });
    assert.equal(resumed.lastRunOutcome, 'ended'); assert.equal(resumed.lastOutputRun, 4);
    assert.equal(sdk.SessionManager.open(first.sessionFile).getSessionName(), first.name);
    const unnamed = await m.start({ task: 'Reply briefly.', mode: 'foreground' }, context);
    assert.equal(unnamed.lastRunOutcome, 'ended');
    assert.equal(sdk.SessionManager.open(unnamed.sessionFile).getSessionName(), undefined);

    // Background mode is fixed too: querying and explicitly stopping a run
    // cannot consume its notification; an idle send remains nonblocking.
    held.length = 0; behavior = 'hold';
    const background = await m.start({ task: 'Background check.' }, context);
    assert.equal(background.mode, 'background');
    await until(() => held.length === 1);
    assert.equal(m.status({ id: background.id }).status, 'running');
    const noticesBeforeStop = notifications.length;
    const backgroundStopped = await m.send({ id: background.id, action: 'stop' });
    assert.equal(backgroundStopped.lastRunOutcome, 'stopped');
    assert.equal(notifications.length, noticesBeforeStop + 1);
    assert.equal(notifications.at(-1).id, background.id);
    held.length = 0;
    const backgroundResumed = await m.send({ id: background.id, action: 'message', message: 'Resume background check.' });
    assert.equal(backgroundResumed.status, 'running');
    assert.equal(backgroundResumed.mode, 'background');
    await until(() => held.length === 1);
    behavior = 'normal'; complete(held.shift(), 'Background complete.');
    await until(() => m.status({ id: background.id }).status === 'idle');
    assert.equal(notifications.length, noticesBeforeStop + 2);
    assert.equal(notifications.at(-1).lastRunOutcome, 'ended');

    // Observe SDK lifecycle events without handing the instance to a host bridge.
    const beforeDirect = m.status({ id: first.id });
    const noticesBeforeDirect = notifications.length;
    held.length = 0; behavior = 'hold';
    const direct = sessions[0].prompt('SDK caller outside either wrapper.');
    await until(() => held.length === 1);
    assert.equal(m.status({ id: first.id }).status, 'running');
    assert.equal(m.status({ id: first.id }).run, beforeDirect.run + 1);
    await sessions[0].abort(); await direct;
    await until(() => m.status({ id: first.id }).status === 'idle');
    assert.equal(m.status({ id: first.id }).lastRunOutcome, 'stopped');
    assert.equal(notifications.length, noticesBeforeDirect);

    // The exact extension entry must load through Pi's real alias-aware loader.
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir,
      settingsManager: sdk.SettingsManager.inMemory({ packages: [] }),
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL('../index.js', import.meta.url))],
    });
    await loader.reload();
    assert.deepEqual(loader.getExtensions().errors, []);
    const registered = loader.getExtensions().extensions.flatMap(extension => [...extension.tools.keys()]);
    assert.deepEqual(registered.sort(), ['subagent_observe', 'subagent_send', 'subagent_start']);
  } finally {
    await m.close(); for (const response of held) response.destroy();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
