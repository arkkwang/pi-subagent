import { Subagents, OBSERVE_MAX_TIMEOUT_SECONDS } from './manager.mjs';
import { sessionFactory } from './sessions.mjs';

const string = { type: 'string', minLength: 1 };
const mode = { type: 'string', enum: ['foreground', 'background'], description: '创建时固定交付模式，后续沿用：foreground 等待执行结束后由工具返回；background 立即返回，结束后通知主会话（默认）。' };
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const result = value => ({ content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value, details: value });

export function registerSubagents(pi, sdk, createFactory = sessionFactory) {
  let owner;
  let manager;
  let shutdownDrain;
  function current(ctx) {
    const id = ctx.sessionManager.getSessionId();
    if (!manager) {
      owner = id;
      manager = new Subagents({
        createSession: createFactory(sdk),
        notify: event => {
          const payload = { event: 'subagent_run_ended', ...event };
          pi.sendMessage({
            customType: 'subagent-result', display: true,
            content: JSON.stringify(payload),
            details: payload,
          }, { deliverAs: 'steer', triggerTurn: true });
        },
      });
    }
    if (owner !== id) throw new Error('子会话仍属于上一主会话，清理后才能继续。');
    return manager;
  }
  async function cleanup() {
    if (manager) await manager.close();
    shutdownDrain = undefined;
    manager = undefined;
    owner = undefined;
  }
  async function beforeSwitch(_event, ctx) {
    try { await cleanup(); }
    catch (error) { ctx.ui.notify(error.message, 'error'); return { cancel: true }; }
  }
  async function shutdown() {
    try { await cleanup(); }
    catch (error) {
      // A host may dispose the parent after its own shutdown deadline. Keep the
      // finalizer alive independently; release children only after work really ends.
      const closing = manager;
      if (closing && !shutdownDrain) {
        shutdownDrain = Promise.allSettled([...closing.records.values()].map(r => r.work))
          .then(() => { if (manager === closing) return cleanup(); })
          .catch(failure => console.error('[subagent] Deferred shutdown cleanup failed:', failure));
      }
      throw error;
    }
  }
  pi.on('session_before_switch', beforeSwitch);
  pi.on('session_before_fork', beforeSwitch);
  pi.on('session_shutdown', shutdown);
  pi.on('session_start', async (_event, ctx) => {
    if (manager && owner !== ctx.sessionManager.getSessionId()) await cleanup();
  });

  function tool(name, label, description, parameters, execute) {
    pi.registerTool({ name, label, description, parameters, exposure: 'deferred',
      async execute(_id, args, signal, _update, ctx) {
        try { return result(await execute(current(ctx), args, signal, ctx)); }
        catch (error) { return { ...result({ error: error.message }), isError: true }; }
      },
    });
  }
  tool('subagent_start', '启动子 Agent',
    '创建独立上下文的子会话；task 必须包含必要背景、范围与限制。共享文件系统，不是沙箱。'
    + '子会话仅有 read/bash/edit/write 和项目规则/本地 Skills，不继承主会话历史、MCP 或扩展。'
    + 'mode 在创建时确定，后续不切换。默认后台运行，真正结束本轮后通知主会话；主会话忙时在可处理边界送达，空闲时唤醒。前台通过工具返回结果，不额外通知。'
    + '返回 idle 只表示本轮结束，必须检查输出和 lastRunOutcome。并行任务避免修改同一文件。',
    schema({ task: string, name: string, cwd: string, model: { ...string, description: 'provider/modelId；默认沿用主 Agent 模型。' }, mode }, ['task']),
    (m, args, signal, ctx) => {
      if (!args.task.trim()) throw new Error('task 不能为空。');
      return m.start(args, ctx, signal);
    });
  tool('subagent_observe', '观察子 Agent',
    '观察子会话；默认立即返回，不传 id 列出当前主会话的子任务。状态只有 idle/running。'
    + `指定 id 和 timeoutSeconds 可等待本轮结束，最多 ${OBSERVE_MAX_TIMEOUT_SECONDS} 秒；超时返回 timedOut=true，不停止子任务。取消只退出观察。`
    + '等待期间结束则直接返回，不重复发后台通知；超时或取消后仍由后台通知交付。无其他工作时用等待观察，不要自行 sleep 轮询。'
    + 'lastOutput 是最近 assistant 正文，运行中可能不完整；lastOutputRun 标明来源轮次，可能来自上一轮。'
    + 'idle 不保证目标完成，检查 lastRunOutcome/error；lastRunStopReason=length 表示模型达到输出上限。输出展示截断时用 detail=output、offset/limit 续取。',
    schema({ id: string, timeoutSeconds: { type: 'number', minimum: 0, maximum: OBSERVE_MAX_TIMEOUT_SECONDS, default: 0, description: '最多等待秒数；0 立即返回，大于 0 必须指定 id。' }, detail: { type: 'string', enum: ['summary', 'output'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 32000 } }),
    (m, args, signal) => m.observeStatus(args, signal));
  tool('subagent_send', '指挥子 Agent',
    '向已有子会话发送 message 或 stop。running 时消息排队，到可处理点读取，不撤销已经发生的操作；'
    + 'idle 时保留上下文开始新一轮；停止后仍保留旧任务历史，改变目标时请明确说明。回复输出中的问题也使用 message，不需要专用回复动作。'
    + '运行中 message 受理后返回，不另行等待或改变交付模式；idle 时沿用创建时 mode：前台等待新一轮结果，后台立即返回、结束后通知。stop 取消执行和排队消息，不回滚文件，也不改变原有结果交付；'
    + '若仍为 running 且 stopRequested=true，表示尚未确认停止。',
    schema({ id: string, action: { type: 'string', enum: ['message', 'stop'] }, message: string }, ['id', 'action']),
    (m, args, signal) => {
      if (args.action === 'stop' && args.message !== undefined)
        throw new Error('stop 不接受 message。');
      return m.send(args, signal);
    });
}
