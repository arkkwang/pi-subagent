import path from 'node:path';
import { stat } from 'node:fs/promises';

/** Lazy SDK setup: loading the parent extension never scans resources or starts a model. */
export function sessionFactory(sdk) {
  let runtime;
  return async (args, ctx) => {
    const cwd = path.resolve(ctx.cwd, args.cwd ?? '.');
    if (!(await stat(cwd)).isDirectory()) throw new Error(`不是目录：${cwd}`);
    const agentDir = sdk.getAgentDir();
    runtime ??= sdk.ModelRuntime.create();
    let modelRuntime;
    try { modelRuntime = await runtime; }
    catch (error) { runtime = undefined; throw error; }
    let model;
    if (args.model) {
      const split = args.model.indexOf('/');
      if (split < 1) throw new Error('model 必须为 provider/modelId，例如 llama/iq3。');
      model = modelRuntime.getModel(args.model.slice(0, split), args.model.slice(split + 1));
    } else if (ctx.model) {
      model = modelRuntime.getModel(ctx.model.provider, ctx.model.id);
    }
    if (!model) throw new Error('无法解析子模型；请选择本机 Pi 配置中的 provider/modelId。');

    // Keep model/compaction settings and AGENTS/Skills, but never recursively load
    // parent extensions, package executables, external notifications or MCP servers.
    const trusted = cwd === path.resolve(ctx.cwd) && ctx.isProjectTrusted();
    const configured = sdk.SettingsManager.create(cwd, agentDir, { projectTrusted: trusted }).getSettings();
    const settingsManager = sdk.SettingsManager.inMemory({
      ...configured, packages: [], extensions: [], prompts: [], themes: [],
    }, { projectTrusted: trusted });
    const resourceLoader = new sdk.DefaultResourceLoader({
      cwd, agentDir, settingsManager, noExtensions: true, noPromptTemplates: true, noThemes: true,
      appendSystemPrompt: [
        'You are a sub-agent. Work on the delegated task using the supplied context and project rules. '
        + 'Your last text output is returned to the main agent. State results, evidence, limitations or questions clearly. '
        + 'You have an independent conversation but share the filesystem; do not assume file isolation. '
        + 'Do not launch other agents or send external notifications. Use only the permissions granted for the delegated task.',
      ],
    });
    await resourceLoader.reload();
    const sessionManager = sdk.SessionManager.create(cwd, undefined, {
      parentSession: ctx.sessionManager.getSessionFile(),
    });
    const { session } = await sdk.createAgentSession({
      cwd, agentDir, modelRuntime, model, thinkingLevel: ctx.thinkingLevel,
      settingsManager, resourceLoader, sessionManager,
      tools: ['read', 'bash', 'edit', 'write'],
    });
    if (args.name !== undefined) session.setSessionName(args.name);
    return session;
  };
}
