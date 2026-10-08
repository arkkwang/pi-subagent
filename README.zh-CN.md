[English](README.md) | 简体中文

# Pi Subagent

基于官方 Pi SDK 的子 Agent 扩展：创建独立会话、观察执行、追加消息或停止任务。支持前台结果返回与后台完成通知。

使用官方包 `@earendil-works/pi-coding-agent`，当前验证基线为 1.0.0。需要 Node.js 22.19+。

## 使用

三个工具统一注册为 `exposure: "deferred"`，不默认向模型暴露定义；通过 `tool_search` 按需发现、加载。插件仍正常初始化。这不要求将 subagent 工具加入 `defaultTools`；需保持 `tool_search` 可用。

```js
// 异步派发，执行结束后通知当前主会话。
subagent_start({
  task: "只读检查 src/cart.js 和 test/cart.test.js，报告缺陷、证据和缺失测试，不修改文件。",
  name: "审查", mode: "background"
})

subagent_observe({ id: "返回的子会话 ID" }) // 立即返回
subagent_observe({ id: "...", timeoutSeconds: 60 }) // 等本轮结束，最多 60 秒

// running：steer 受理后返回；idle：沿用创建时的 mode 开始下一轮。
subagent_send({ id: "...", action: "message", message: "重点检查 quantity=0，不得当作缺省值。" })

subagent_send({ id: "...", action: "stop" })
```

- `start`：必填 `task`，应包含必要背景、限制和完成依据；可选 `name`（同时写入 Pi 会话标题；不传时保留界面从首条消息生成的标题）、`cwd`（相对主项目或绝对路径）、`model`（`provider/modelId`）。默认当前项目、主 Agent 模型；`mode` 为 `foreground` / `background`（默认），创建时固定为会话属性，后续不可切换。
- `send`：必填 `id/action`；`message` 动作必填 `message`；`stop` 不接受消息。没有 `start.notify` 或 `send.mode` 参数，也没有 silent 模式。
- `observe`：不传 ID 列出当前主会话所有子任务；默认截取最近 assistant 正文前 2000 字符。用 `detail: "output"` 获取最多 16000 字符，`offset/limit` 分页，单次上限 32000。`nextOffset` 非 null 时还有内容。

`timeoutSeconds` 默认 0；大于 0 时必须指定 id，上限由 `manager.mjs` 的 `OBSERVE_MAX_TIMEOUT_SECONDS = 240` 统一配置，工具 schema 与运行时校验共用。单任务观察返回 `timedOut`；到期返回当前快照，不停止子任务。取消观察同样不停止子任务。等待使用结束事件与单个定时器，不轮询。

工具返回正文为纯 JSON，并同时提供 `structuredContent`；结束通知也是纯 JSON，额外带 `event: "subagent_run_ended"`，不混入自然语言前缀。字段示例（省略其余字段）：

```json
{
  "status": "idle",
  "lastRunOutcome": "ended",
  "lastRunStopReason": "length",
  "lastOutput": "当前输出……"
}
```

这表示当前未执行、上一轮达到输出上限，不表示任务已完成。

**只有两种状态：**

- `running`：包括模型执行、工具调用、自动重试、压缩和已接受的排队指令。
- `idle`：当前没有执行，不保证用户目标已经达成。

其他信息不作为状态：

| 字段 | 含义 |
| --- | --- |
| `mode` | 创建时固定的 `foreground` / `background`，决定 idle 续发的等待方式及每轮通知 |
| `lastOutput` | 最近 assistant 正文；流式执行时可能只是部分内容，不含思考或工具日志 |
| `lastOutputRun` / `run` | 输出来源轮次 / 当前轮次；新一轮尚未输出时，可能显示旧输出 |
| `lastOutputAt` | 最近正文更新时间 |
| `lastActivity` | 最近正文或工具活动 |
| `queuedMessages` | SDK 尚未消费的排队消息数，不是“要求已完成”的确认 |
| `lastRunOutcome` / `lastRun` | 最近结束的一轮及结果：`ended` / `failed` / `stopped` |
| `lastRunStopReason` | 模型实际结束原因，例如 `stop`、`length`、`error`、`aborted`；`length` 表示模型输出达到上限 |
| `error` | 最近运行错误；工具返回 `isError` 则表示调用自身未受理 |
| `stopRequested` | 已请求停止；仍 running 时不能假定工具或外部进程已结束 |
| `sessionFile` | 子会话完整 JSONL 记录，可供排查 |

`run` 记录一次连续执行区间，而非模型底层 turn 数或每次 UI 提交：工具提交从受理开始，外部 SDK 调用从可观察的 `agent_start` 开始，均到执行收束结束。期间加入的消息、收束前紧邻的续跑属于同一轮。SDK 手动压缩可以显示 running，但不额外增加业务轮次。

子 Agent 输出问题后正常结束也只是 idle。主 Agent 查看文本，自行判断是否通过 `message` 回答、追加要求或收取结果；没有 `ask`、`reply`、等待回复状态或文本分类器。

## 等待与通知

| 操作 | foreground 会话 | background 会话（默认） |
| --- | --- | --- |
| `start` | 等待本轮收束后返回 | 受理后返回 |
| idle 时 `send(message)` | 等待新一轮收束后返回 | 受理后返回 |
| running 时 `send(message)` | steer 受理后返回，不等待本轮 | steer 受理后返回，不等待本轮 |
| 每轮结束通知 | 不通知父会话 | 有等待观察者则通过观察返回，否则主动通知父会话 |

- running 消息使用 SDK `prompt(..., { streamingBehavior: 'steer' })`，不改变会话 mode。受理不代表消息已执行或任务已完成；需等结果或查询状态。
- 每轮真正收束统一走 `finish`；等待观察在收束时直接收到结果，避免重复后台通知。立即观察、超时或取消不抑制后续后台通知；`stop` 不改变交付，关闭会话的资源清理仍抑制通知。
- 插件通过 Pi `sendMessage(..., { deliverAs: 'steer', triggerTurn: true })` 交付结束事件：主 Agent 忙时在 SDK 可处理边界进入，空闲时唤醒。不依赖子模型调用通知工具。
- 前台启动或 idle 续发的等待调用取消时请求停止子任务；后台受理后及 running 消息受理后，不把已返回调用的取消信号绑定到子执行。
- 通知是进程内尽力交付，没有重启恢复和严格 exactly-once 保证；Pi API 的异步投递失败由 Pi 报告。可以随时通过 observe 取回结果。

停止不撤销文件修改，不删除已有上下文。停止后改变目标，应明确说明“旧任务已取消，接下来做……”。主模型仍需核对输出，不能把 `ended` 当成业务成功。

## 运行边界

- 本工具每个主会话最多受理 16 个并行子会话、保留 1024 个子会话。状态结合内存记录与 SDK 状态，查询不扫描磁盘或解析历史。
- 子会话只启用 `read/bash/edit/write`；加载目标项目的规则和本地发现的 Skills，不复制主会话聊天历史。
- 不加载主 Agent 的扩展、包资源、MCP 或通知工具，不自动注册递归派发工具。仅支持本机模型配置可解析的模型，不继承仅由主扩展临时注册的模型。
- **不是安全沙箱**：共享文件系统、进程权限和模型服务；不继承主会话扩展提供的确认/权限钩子。“只读”是任务约束，不是强制文件权限。并行写任务必须划分文件范围。需要依靠扩展强制审批的项目不应直接使用此默认工具集。
- 默认不跨主会话共享任务。切换、分叉、关闭会话时取消子执行并释放资源；5 秒内未确认停止则保留 running，切换/分叉会被取消，可稍后重试。
- 子会话记录使用 Pi 默认目录 `~/.pi/agent/sessions/<工作目录分组>/`（遵循 `PI_CODING_AGENT_DIR`），与普通会话相同，保留父会话关联，默认会话列表和 `pi-snap` 可直接发现。进程退出后不恢复后台执行或任务 ID。
- 模型服务只有一个推理 slot 时，多个 Agent 请求仍可能由服务端串行处理；后台执行不等于 GPU 并行推理。

## 会话发现与状态归属

子会话使用官方 SDK 默认的会话文件布局和父会话关联，供 Pi 会话列表或 `pi-snap` 发现。列表发现不等于接管执行：运行状态、消息、取消和结果交付由本扩展管理。

不注册 WebUI 共享 SDK 实例或主会话保活接口，不向上游交付运行时状态。上游如何刷新文件列表不属于本扩展职责。不要同时从其他进程恢复一个仍由本扩展执行的会话。

## 安装

从 npm 安装：

```bash
pi install npm:@arkkwang/pi-subagent
```

也可以克隆仓库后，在仓库目录内安装本地包：

```bash
pi install .
```

重启 Pi 后加载扩展。无独立 CLI、常驻服务或第二份 Pi SDK；SDK 由 Pi 扩展加载器提供。三个工具按需暴露，主 Agent 使用前需通过 `tool_search` 发现。

## 验证

```bash
npm ci
npm test
# 完整集成测试：实际 SDK + 本地模拟 HTTP 模型，不调用外部模型。
PI_SDK_ENTRY=/absolute/path/to/pi/dist/index.js npm test
PI_SDK_ENTRY=/absolute/path/to/pi/dist/index.js node test/benchmark.mjs
```

未设置 `PI_SDK_ENTRY` 时跳过真实 SDK 测试。`test/local-smoke.mjs` 是需要显式授权的真实本地模型演练，不包含在默认测试中。

Windows Git Bash / Node 22.23.2 / 官方 Pi 1.0.0 为本次验证环境；macOS/Linux 和其他 Pi 版本尚未实测。性能脚本对照带/不带扩展的资源加载，并测量大输出状态查询；不代表完整冷启动或模型推理耗时。

## 相关项目

- [pi-cron](https://github.com/arkkwang/pi-cron)：定时执行 Agent 任务。
- [pi-snap](https://github.com/arkkwang/pi-snap)：帮助人和 Agent 快速定位会话问题。

## License

[MIT](LICENSE)
