// Explicit opt-in only: runs the existing loopback model, never part of npm test.
// PI_SDK_ENTRY=/path/to/pi/dist/index.js [PI_LOCAL_MODEL=llama/iq3] node test/local-smoke.mjs
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
import { pathToFileURL, fileURLToPath } from 'node:url';

if (!process.env.PI_SDK_ENTRY) throw new Error('Set PI_SDK_ENTRY');
const sdk = await import(pathToFileURL(path.resolve(process.env.PI_SDK_ENTRY)).href);
const selected = process.env.PI_LOCAL_MODEL ?? 'llama/iq3';
const slash = selected.indexOf('/');
const providerId = selected.slice(0, slash), modelId = selected.slice(slash + 1);
const config = JSON.parse(await readFile(path.join(sdk.getAgentDir(), 'models.json'), 'utf8'));
const provider = config.providers[providerId];
const configuredModel = provider?.models.find(m => m.id === modelId);
if (!configuredModel) throw new Error(`Missing local model ${selected}`);
if (![provider.baseUrl, configuredModel.baseUrl].filter(Boolean).every(url => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)))
  throw new Error('Smoke test permits loopback providers only');
const root = await mkdtemp(path.join(tmpdir(), 'pi-subagent-local-'));
const agentDir = path.join(root, 'agent'), cwd = path.join(root, 'project');
await mkdir(agentDir); await mkdir(cwd);
await writeFile(path.join(cwd, 'fixture.txt'), 'alpha=17\nbeta=25\n');
await writeFile(path.join(cwd, 'AGENTS.md'), 'This is an isolated test repository. Only edit files when the delegated task explicitly authorizes it. Never modify AGENTS.md, launch other agents, commit changes or access paths outside this directory. Use node --test for tests.');
await mkdir(path.join(cwd, 'src')); await mkdir(path.join(cwd, 'test'));
await writeFile(path.join(cwd, 'package.json'), JSON.stringify({ name: 'subagent-cart-demo', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2));
await writeFile(path.join(cwd, 'src/cart.js'), 'export function totalCents(items) {\n  return items.reduce((sum, item) => sum + item.priceCents, 0);\n}\n');
await writeFile(path.join(cwd, 'test/cart.test.js'), "import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { totalCents } from '../src/cart.js';\ntest('one item', () => assert.equal(totalCents([{ priceCents: 199, quantity: 1 }]), 199));\n");
await exec('git', ['init', '--quiet'], { cwd });
await exec('git', ['add', '.'], { cwd });
await exec('git', ['-c', 'user.name=Subagent Test', '-c', 'user.email=subagent-test@example.invalid', 'commit', '--quiet', '-m', 'Seed intentionally incomplete cart calculation'], { cwd });
await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: {
  [providerId]: { ...provider, models: [{ ...configuredModel, maxTokens: 2048 }] },
} }));
await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' }));
const oldDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const events = [], samples = [], parentToolCalls = [];
let workflow;
let parent, extension;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn, timeout = 120000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await fn()) return; await sleep(50); }
  throw new Error('Local model test timed out');
}
try {
  const modelRuntime = await sdk.ModelRuntime.create({ modelsStorePath: path.join(agentDir, 'catalog.json'), refreshOnCreate: false });
  const model = modelRuntime.getModel(providerId, modelId);
  const settingsManager = sdk.SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: 'off' });
  const loader = new sdk.DefaultResourceLoader({ cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [fileURLToPath(new URL('../index.js', import.meta.url))],
    systemPrompt: 'You coordinate sub-agents. When a subagent result arrives without a user request, acknowledge it briefly. For explicit user requests, use the available tools as requested. Do not send messages to any external service.',
  });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  extension = loader.getExtensions().extensions.find(e => e.tools.has('subagent_start'));
  ({ session: parent } = await sdk.createAgentSession({ cwd, agentDir, modelRuntime, model, thinkingLevel: 'off',
    settingsManager, resourceLoader: loader, sessionManager: sdk.SessionManager.inMemory(cwd),
    tools: ['subagent_start', 'subagent_observe', 'subagent_send'] }));
  await parent.bindExtensions({ onError: event => { throw new Error(event.error); } });
  parent.subscribe(event => {
    if (event.type === 'message_end' && event.message.role === 'custom' && event.message.customType === 'subagent-result')
      events.push(event.message.details ?? JSON.parse(event.message.content));
    if (event.type === 'tool_execution_start') parentToolCalls.push({ name: event.toolName, args: event.args });
  });
  const ctx = { cwd, model, thinkingLevel: 'off', isProjectTrusted: () => true, sessionManager: parent.sessionManager };
  async function call(name, args) {
    const start = performance.now();
    const result = await extension.tools.get(name).definition.execute('smoke-call', args, undefined, undefined, ctx);
    assert(!result.isError, JSON.stringify(result));
    samples.push({ tool: name, ms: Math.round(performance.now() - start), status: result.details.status });
    return result.details;
  }
  // Test-only polling: no wait parameter or foreground override in production send.
  async function waitForEnd(id) {
    let snapshot;
    await until(async () => {
      snapshot = await call('subagent_observe', { id });
      return snapshot.status === 'idle';
    });
    return snapshot;
  }
  async function waitForNotification(snapshot) {
    const matches = () => events.filter(event => event.id === snapshot.id && event.run === snapshot.run);
    await until(() => matches().length > 0 && parent.isIdle);
    assert.equal(matches().length, 1, 'Each background run must notify once, including after query or stop');
  }
  let r = await call('subagent_start', {
    task: 'Use the read tool to read fixture.txt in this working directory. Do not modify anything. Reply exactly SUM=42 if alpha+beta is 42, otherwise reply the actual sum. Do not call any other tool.',
    name: 'local-smoke', // Omitted mode must default to background.
  });
  assert.equal(r.status, 'running'); assert.equal(r.mode, 'background');
  const id = r.id;
  r = await waitForEnd(id);
  assert.equal(r.lastRunOutcome, 'ended', r.error); assert.match(r.lastOutput, /SUM\s*=\s*42/);
  const transcript = await readFile(r.sessionFile, 'utf8');
  assert.match(transcript, /"toolName":"read"/);
  await waitForNotification(r);
  assert(parent.getLastAssistantText()?.trim(), 'Notification must wake the parent model and produce a response');

  r = await call('subagent_send', { id, action: 'message', message: 'Using the values you already read, reply only DIFF=8 for beta-alpha. Do not call tools.' });
  assert.equal(r.status, 'running'); assert.equal(r.mode, 'background');
  r = await waitForEnd(id);
  assert.equal(r.lastRunOutcome, 'ended', r.error);
  assert.match(r.lastOutput, /DIFF\s*=\s*8/); assert.equal(r.lastOutputRun, 2);
  await waitForNotification(r);

  r = await call('subagent_send', { id, action: 'message', message: 'Without tools, produce a long numbered list of 500 short arithmetic facts. Start immediately and do not summarize.' });
  assert.equal(r.status, 'running');
  await until(async () => { r = await call('subagent_observe', { id }); return r.lastOutputRun === 3 || r.status === 'idle'; });
  assert.equal(r.status, 'running', 'Long response ended before cancellation could be checked');
  r = await call('subagent_send', { id, action: 'stop' });
  if (r.status === 'running') r = await waitForEnd(id);
  assert.equal(r.status, 'idle'); assert.equal(r.lastRunOutcome, 'stopped');
  await waitForNotification(r); // A direct stop result must not suppress background delivery.

  // Running send only acknowledges steer; explicitly wait for the final result.
  const resumed = await call('subagent_send', { id, action: 'message', message: 'The previous numbered-list task is CANCELLED. Do not continue the list or arithmetic. This is a NEW task: reply with only READY. Do not call tools.' });
  assert.equal(resumed.status, 'running');
  r = await call('subagent_send', { id, action: 'message', message: 'New instruction for the current READY task: reply with only STEER_OK. Do not resume any previous task, produce lists or call tools.' });
  assert.equal(r.status, 'running', 'Running send must acknowledge steering without waiting for completion');
  assert.equal(r.run, resumed.run); assert.equal(r.mode, 'background');
  r = await waitForEnd(id);
  assert.equal(r.lastRunOutcome, 'ended', r.error); assert.match(r.lastOutput, /STEER_OK/);
  await waitForNotification(r);

  const beforeForeground = events.length;
  const foreground = await call('subagent_start', { task: 'Reply only FOREGROUND_OK. Do not call tools.', mode: 'foreground' });
  assert.equal(foreground.status, 'idle'); assert.equal(foreground.mode, 'foreground');
  assert.equal(foreground.lastRunOutcome, 'ended', foreground.error); assert.match(foreground.lastOutput, /FOREGROUND_OK/);
  const final = await call('subagent_send', { id: foreground.id, action: 'message', message: 'Reply only FOREGROUND_CONTINUED. Do not call tools.' });
  assert.equal(final.status, 'idle'); assert.equal(final.mode, 'foreground');
  assert.equal(final.lastRunOutcome, 'ended', final.error); assert.match(final.lastOutput, /FOREGROUND_CONTINUED/);
  assert.equal(final.lastOutputRun, 2); assert.equal(events.length, beforeForeground);
  assert.equal(await readFile(path.join(cwd, 'fixture.txt'), 'utf8'), 'alpha=17\nbeta=25\n');
  // Real small-repository workflow: review -> implement + tests -> extra requirement -> independent review.
  const review = await call('subagent_start', { name: 'cart-review',
    task: 'Read src/cart.js, test/cart.test.js and package.json. Read-only review: totalCents should sum priceCents*quantity; quantity=0 contributes 0, missing quantity defaults to 1, empty cart returns 0, and input must not mutate. Identify defects and missing tests. Do not edit any files. Return a concise review with file references.', mode: 'background' });
  let reviewResult = await waitForEnd(review.id);
  await waitForNotification(reviewResult);
  reviewResult = await call('subagent_observe', { id: review.id, detail: 'output', limit: 32000 });
  assert.equal(reviewResult.lastRunOutcome, 'ended', reviewResult.error);
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd })).stdout, '', 'Reviewer must not modify the repository');
  const worker = await call('subagent_start', { name: 'cart-worker',
    task: 'Implement and test totalCents in this repository. It must sum priceCents*quantity; quantity=0 contributes 0; empty cart returns 0; input must not mutate. Edit ONLY src/cart.js and test/cart.test.js. Add regression tests and run node --test. Do not commit or edit other files. Return changed files and test results.', mode: 'background' });
  const active = await call('subagent_observe', { id: worker.id });
  assert.equal(active.status, 'running');
  const accepted = await call('subagent_send', { id: worker.id, action: 'message',
    message: 'Additional requirement: a missing quantity must default to 1. Add a regression test for this too. Keep quantity=0 as zero. Also test multiple items. Finish by running node --test and report results.' });
  assert.equal(accepted.status, 'running'); assert.equal(accepted.run, worker.run);
  const implemented = await waitForEnd(worker.id);
  await waitForNotification(implemented);
  assert.equal(implemented.lastRunOutcome, 'ended', implemented.error);
  const tests = await exec(process.execPath, ['--test'], { cwd });
  // Independently assert the business contract rather than trusting the model or its tests.
  const contract = await exec(process.execPath, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    import { totalCents } from './src/cart.js';
    const items = Object.freeze([Object.freeze({priceCents:199,quantity:3}),Object.freeze({priceCents:50,quantity:0}),Object.freeze({priceCents:100})]);
    assert.equal(totalCents(items),697); assert.equal(totalCents([]),0);
    assert.equal(totalCents([{priceCents:25,quantity:4},{priceCents:10,quantity:2}]),120);
    console.log('independent contract PASS');
  `], { cwd });
  const changed = (await exec('git', ['diff', '--name-only'], { cwd })).stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.deepEqual(changed.sort(), ['src/cart.js', 'test/cart.test.js']);
  const diff = (await exec('git', ['diff'], { cwd })).stdout;
  let reviewed = await call('subagent_send', { id: review.id, action: 'message',
    message: 'The implementation has changed. Independently re-read src/cart.js and test/cart.test.js and run node --test. Verify the original contract including missing quantity default=1. Do not edit any files. Report remaining issues, or explain which checks passed.' });
  assert.equal(reviewed.status, 'running');
  reviewed = await waitForEnd(review.id);
  await waitForNotification(reviewed);
  reviewed = await call('subagent_observe', { id: review.id, detail: 'output', limit: 32000 });
  assert.equal(reviewed.lastRunOutcome, 'ended', reviewed.error);
  assert.equal((await exec('git', ['diff'], { cwd })).stdout, diff, 'Final reviewer must not modify the patch');
  const naturalStart = parentToolCalls.length;
  const beforeNatural = events.length;
  await parent.prompt('请按顺序完成一次子 Agent 协作演练：1）调用 subagent_start，以 mode=foreground 创建一个只读审查子任务，检查当前仓库 src/cart.js 和 test/cart.test.js 是否实现 quantity 缺省为 1、0 保持为 0，不得修改任何文件。2）拿到子任务 ID 后调用 subagent_observe 查看状态与输出。3）再调用 subagent_send，以 action=message 要求同一个子会话（send 不传 mode，沿用创建时的 foreground）只用一句话总结是否符合上述两个要求。最后用中文简短汇总。只执行这一组步骤，不要创建额外子任务。');
  await parent.waitForIdle();
  const naturalCalls = parentToolCalls.slice(naturalStart);
  assert.equal(events.length, beforeNatural, 'Foreground workflow must not notify the parent');
  assert.equal(events.length, 7, 'Four background smoke runs, two review runs and one implementation run must notify');
  assert(!events.some(event => event.id === foreground.id), 'Foreground sessions must never notify');
  for (const call of naturalCalls) {
    assert(!Object.hasOwn(call.args, 'notify'), 'Removed notify parameter must not be used');
    if (call.name === 'subagent_start') assert.equal(call.args.mode, 'foreground');
    if (call.name === 'subagent_send') assert(!Object.hasOwn(call.args, 'mode'), 'send must inherit the session mode');
  }
  for (const name of ['subagent_start', 'subagent_observe', 'subagent_send'])
    assert(naturalCalls.some(call => call.name === name), `Main model did not call ${name}`);
  assert.equal((await exec('git', ['diff'], { cwd })).stdout, diff);
  workflow = { repository: cwd, naturalWorkflow: { calls: naturalCalls, response: parent.getLastAssistantText() }, review: reviewResult.lastOutput, implementation: implemented.lastOutput, finalReview: reviewed.lastOutput,
    tests: tests.stdout, independentContract: contract.stdout, diff };
  await writeFile(path.join(root, 'workflow-report.json'), JSON.stringify(workflow, null, 2));
  console.log(JSON.stringify({ model: selected, passed: true, repository: cwd, workflowReport: path.join(root, 'workflow-report.json'), notificationCount: events.length,
    output: { sum: 'SUM=42', continuation: 'DIFF=8', steering: r.lastOutput, foreground: final.lastOutput },
    calls: samples.filter(s => s.tool !== 'subagent_observe'), statusQueries: samples.filter(s => s.tool === 'subagent_observe').length,
    mainModelToolCalls: naturalCalls.map(call => call.name), mainModelResponse: parent.getLastAssistantText(),
  }, null, 2));
} finally {
  if (extension) for (const handler of extension.handlers.get('session_shutdown') ?? []) await handler();
  parent?.dispose();
  if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldDir;
  if (process.env.PI_KEEP_FIXTURE !== '1') await rm(root, { recursive: true, force: true });
  else console.log(`Kept isolated fixture: ${root}`);
}
