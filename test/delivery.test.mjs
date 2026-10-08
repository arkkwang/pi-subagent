import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { registerSubagents } from '../extension.mjs';

const entry = process.env.PI_SDK_ENTRY;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  for (let i = 0; i < 500; i++) { if (fn()) return; await sleep(10); }
  throw new Error('delivery condition timeout');
}

// No external model: HTTP/SSE, provider parsing, extension tools, parent queues,
// child lifecycle and notification delivery all run through the installed SDK.
for (const scenario of ['busy', 'idle', 'foreground']) {
  test(`real SDK delivery: ${scenario} parent`, {
    skip: !entry && 'Set PI_SDK_ENTRY to the installed Pi dist/index.js', timeout: 30000,
  }, async t => {
    const sdk = await import(pathToFileURL(path.resolve(entry)).href);
    const dir = await mkdtemp(path.join(tmpdir(), 'pi-subagent-delivery-'));
    const agentDir = path.join(dir, 'agent');
    // SessionManager resolves its own default directory from the environment;
    // overriding sdk.getAgentDir in a facade does not isolate session storage.
    const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    t.after(async () => {
      try {
        await rm(dir, { recursive: true, force: true });
        await assert.rejects(stat(dir), { code: 'ENOENT' });
      } finally {
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
      }
    });
    // Fail before creating any sessions if the SDK does not honor isolation.
    assert.equal(sdk.getAgentDir(), agentDir);
    const cwd = path.join(dir, 'project');
    await mkdir(agentDir); await mkdir(cwd);
    const requests = [], notices = [], timeline = [], errors = [];
    let childResponse, parent, parentCalls = 0;
    function chunk(response, delta, finish_reason = null) {
      response.write(`data: ${JSON.stringify({ id: 'delivery', object: 'chat.completion.chunk', created: 1,
        model: 'probe', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    }
    function finish(response, text) {
      chunk(response, { role: 'assistant', content: text });
      chunk(response, {}, 'stop'); response.end('data: [DONE]\n\n');
    }
    function tool(response, name, args = {}, withTail = false) {
      const calls = [{ index: 0, id: `call-${parentCalls}`,
        type: 'function', function: { name, arguments: JSON.stringify(args) } }];
      if (withTail) calls.push({ index: 1, id: `tail-${parentCalls}`, type: 'function',
        function: { name: 'batch_tail', arguments: '{}' } });
      chunk(response, { role: 'assistant', tool_calls: calls });
      chunk(response, {}, 'tool_calls'); response.end('data: [DONE]\n\n');
    }
    const server = createServer(async (request, response) => {
      try {
        let raw = ''; for await (const data of request) raw += data;
        const body = JSON.parse(raw);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (body.model === 'child') {
          if (scenario === 'foreground') finish(response, 'CHILD_RESULT');
          else { chunk(response, { role: 'assistant', content: 'working' }); childResponse = response; }
          return;
        }
        requests.push(body); parentCalls++;
        const hasNotice = body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('subagent_run_ended'));
        timeline.push(hasNotice ? 'model-with-notice' : 'model-without-notice');
        if (parentCalls === 1) {
          tool(response, 'subagent_start', { task: 'Return CHILD_RESULT.', model: 'probe/child',
            ...(scenario === 'foreground' ? { mode: 'foreground' } : {}) });
        } else if (scenario === 'busy' && parentCalls === 2) {
          tool(response, 'controlled_work', {}, true);
        } else if (scenario === 'busy' && parentCalls === 3) {
          // Keep working regardless of delivery: a followUp regression cannot
          // pass by merely showing the notification after the final answer.
          tool(response, 'controlled_work');
        } else { timeline.push('parent-final'); finish(response, 'PARENT_FINAL'); }
      } catch (error) { errors.push(error); response.destroy(error); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { probe: {
      baseUrl: `http://127.0.0.1:${server.address().port}/v1`, api: 'openai-completions', apiKey: 'fixture',
      models: ['parent', 'child'].map(id => ({ id, name: id, reasoning: false, input: ['text'],
        contextWindow: 32768, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
    } } }));
    const settings = { packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' };
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify(settings));
    const runtime = await sdk.ModelRuntime.create({ authPath: path.join(agentDir, 'auth.json'),
      modelsPath: path.join(agentDir, 'models.json'), modelsStorePath: path.join(agentDir, 'catalog.json'), refreshOnCreate: false });
    const isolated = { ...sdk, ModelRuntime: { create: () => runtime } };
    const settingsManager = sdk.SettingsManager.inMemory(settings, { projectTrusted: true });
    let workCount = 0, tailCount = 0;
    const toolSignals = [];
    const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
      extensionFactories: [pi => {
        registerSubagents({ ...pi, sendMessage(message, options) {
          notices.push({ message, options }); timeline.push('notification');
          return pi.sendMessage(message, options);
        } }, isolated);
        pi.registerTool({ name: 'controlled_work', label: 'Controlled work', description: 'Perform fixture work.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          async execute(_id, _args, signal) {
            toolSignals.push(signal);
            timeline.push(`work-${++workCount}-start`);
            if (workCount === 1) {
              await until(() => childResponse);
              finish(childResponse, ' CHILD_RESULT');
              await until(() => notices.length === 1);
              assert.equal(signal.aborted, false, 'steer must not abort the executing tool');
            }
            timeline.push(`work-${workCount}-end`);
            return { content: [{ type: 'text', text: 'work complete' }], details: {} };
          },
        });
        pi.registerTool({ name: 'batch_tail', label: 'Batch tail', description: 'Second tool in the same batch.',
          parameters: { type: 'object', properties: {}, additionalProperties: false },
          async execute(_id, _args, signal) {
            tailCount++; toolSignals.push(signal); timeline.push('batch-tail');
            return { content: [{ type: 'text', text: 'BATCH_TAIL_COMPLETED' }], details: {} };
          },
        });
      }],
    });
    try {
      await loader.reload();
      assert.deepEqual(loader.getExtensions().errors, []);
      ({ session: parent } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime: runtime,
        model: runtime.getModel('probe', 'parent'), thinkingLevel: 'off', settingsManager,
        resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd),
        tools: ['subagent_start', 'controlled_work', 'batch_tail'],
      }));
      await parent.bindExtensions({ onError: error => errors.push(error) });
      await parent.prompt('Delegate a task, then continue your own work.');
      await parent.waitForIdle();
      if (scenario === 'idle') {
        assert.equal(parent.isIdle, true);
        assert.equal(notices.length, 0);
        assert.equal(parentCalls, 2);
        await until(() => childResponse);
        timeline.push('idle-release'); finish(childResponse, ' CHILD_RESULT');
        await until(() => parentCalls === 3);
        await parent.waitForIdle();
        assert(timeline.indexOf('idle-release') < timeline.indexOf('model-with-notice'));
      }
      assert.deepEqual(errors, []);
      const children = await sdk.SessionManager.list(cwd);
      assert.equal(children.length, 1, 'child session must be persisted in the isolated store');
      assert(children[0].path.startsWith(path.join(agentDir, 'sessions') + path.sep),
        `child session escaped the temporary agent directory: ${children[0].path}`);
      assert((await stat(children[0].path)).isFile());
      const delivered = parent.messages.filter(m => m.role === 'custom' && m.customType === 'subagent-result');
      if (scenario === 'foreground') {
        assert.equal(notices.length, 0);
        assert.equal(delivered.length, 0);
        assert.equal(parentCalls, 2, 'no duplicate notification turn');
        assert(requests[1].messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('CHILD_RESULT')));
      } else {
        assert.equal(notices.length, 1);
        assert.deepEqual(notices[0].options, { deliverAs: 'steer', triggerTurn: true });
        assert.equal(notices[0].message.details.lastRunOutcome, 'ended');
        assert.match(notices[0].message.details.lastOutput, /CHILD_RESULT/);
        assert.equal(delivered.length, 1);
        if (scenario === 'busy') {
          assert.equal(workCount, 2);
          assert.equal(tailCount, 1, 'steer must not skip the second tool in the current batch');
          assert(toolSignals.every(signal => !signal.aborted), 'no tool was cancelled by delivery');
          assert(requests[2].messages.some(m => m.role === 'tool' && JSON.stringify(m.content).includes('BATCH_TAIL_COMPLETED')),
            'the next model request includes the second tool result');
          assert(timeline.indexOf('work-1-start') < timeline.indexOf('notification'));
          assert(timeline.indexOf('notification') < timeline.indexOf('work-1-end'));
          assert(timeline.indexOf('model-with-notice') < timeline.indexOf('work-2-start'), timeline.join(', '));
          assert(timeline.indexOf('model-with-notice') < timeline.indexOf('parent-final'), timeline.join(', '));
          assert.equal(parentCalls, 4, 'notification is consumed within the ongoing tool loop, not a post-final turn');
        }
      }
    } finally {
      await parent?.extensionRunner.emit({ type: 'session_shutdown' });
      await parent?.abort(); parent?.dispose();
      childResponse?.destroy(); server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
}
