English | [简体中文](README.zh-CN.md)

# pi-subagent

An extension for the official Pi SDK that lets a main agent create independent sub-agent sessions, observe execution, send follow-up instructions, and stop tasks. Supports foreground results and background completion notifications.

Uses the official `@earendil-works/pi-coding-agent` package. The current verified SDK baseline is **1.0.0**; Node.js 22.19+ is required.

## Install

```bash
pi install npm:@arkkwang/pi-subagent
```

Or clone this repository and install the local package from its root:

```bash
pi install .
```

Restart Pi to load the extension. There is no standalone CLI, daemon, or second SDK installation: Pi's extension loader supplies the SDK.

## Agent usage

The three tools use `exposure: "deferred"`. Agents discover and load them through `tool_search`; tool definitions are not exposed by default, but the extension still initializes normally. Keep `tool_search` available; adding sub-agent tools to `defaultTools` is unnecessary.

```js
subagent_start({
  task: "Read-only review of src/cart.js and test/cart.test.js. Report defects, evidence, and missing tests. Do not modify files.",
  name: "Review", mode: "background"
})

subagent_observe({ id: "returned child ID" }) // Immediate snapshot
subagent_observe({ id: "...", timeoutSeconds: 60 }) // Wait up to 60 seconds

// Running: returns after steer acceptance. Idle: starts a new run in the fixed mode.
subagent_send({ id: "...", action: "message", message: "Check that quantity=0 is not treated as missing." })
subagent_send({ id: "...", action: "stop" })
```

- `start` requires `task`: provide context, constraints, and completion criteria. Optional `name` also sets the Pi session title; omitting it preserves Pi's first-message-based title behavior. `cwd` can be absolute or relative to the parent project. `model` uses `provider/modelId`. Defaults are the parent project/model and `mode: "background"`. Mode is fixed when the session is created and cannot be changed.
- `send` requires `id/action`; the `message` action requires `message`. `stop` does not accept a message. There is no `start.notify`, `send.mode`, or silent mode.
- `observe` without an ID lists all children of the current parent. Default output is the first 2000 characters of the latest assistant text. `detail: "output"` defaults to 16000 characters; paginate with `offset/limit` (maximum 32000 per call). A non-null `nextOffset` indicates more content.

`timeoutSeconds` defaults to 0. Waiting requires an ID and is capped at 240 seconds, shared by runtime validation and tool schema through `OBSERVE_MAX_TIMEOUT_SECONDS` in `manager.mjs`. Single-task observations include `timedOut`. Timeout or cancellation ends only the observation, not the child task. Waiting uses completion events and one timer, not polling.

Tool text is pure JSON, also exposed as `structuredContent`. Completion notifications are JSON with `event: "subagent_run_ended"`. For example, a partial result:

```json
{
  "status": "idle",
  "lastRunOutcome": "ended",
  "lastRunStopReason": "length",
  "lastOutput": "Current output..."
}
```

This means the last run hit the output limit and is no longer executing—not that the task succeeded.

## State and evidence

There are only two states:

- `running`: includes model work, tools, automatic retries, compaction, and accepted queued instructions while execution remains active.
- `idle`: nothing is currently executing; the user's goal may still be unmet.

| Field | Meaning |
| --- | --- |
| `mode` | Fixed foreground/background delivery policy |
| `lastOutput` | Latest assistant text, possibly partial while streaming; excludes thinking and tool logs |
| `lastOutputRun` / `run` | Output's source run / current run; output may still belong to the previous run |
| `lastOutputAt` | Latest text-update time |
| `lastActivity` | Latest text or tool activity |
| `queuedMessages` | SDK messages not yet consumed; not confirmation that instructions were fulfilled |
| `lastRunOutcome` / `lastRun` | Latest completed run and its outcome: `ended`, `failed`, or `stopped` |
| `lastRunStopReason` | Actual model termination reason, such as `stop`, `length`, `error`, or `aborted` |
| `error` | Latest execution error; a tool-level `isError` means the call itself failed |
| `stopRequested` | Stop was requested; if still running, do not assume tools or external processes have ended |
| `sessionFile` | Full child JSONL log for investigation |

A run is one continuous execution interval, not a model turn or every input submission. Tool submissions start counting at acceptance; other SDK activity starts at an observed `agent_start`. Instructions and adjacent continuations before settlement remain in the same run. Manual SDK compaction may show running without creating a new business run.

A child that asks a question and finishes is simply idle. The main agent reads the output and decides whether to answer with `message`, add requirements, or accept the result. There is no separate ask/reply protocol, waiting-for-answer state, or prose classifier.

## Waiting and notifications

| Operation | Foreground session | Background session (default) |
| --- | --- | --- |
| `start` | Waits for the run to settle | Returns after acceptance |
| `send(message)` while idle | Waits for the new run | Returns after acceptance |
| `send(message)` while running | Returns after steer acceptance | Returns after steer acceptance |
| Run completion | No parent notification | Returns to waiting observers, or notifies the parent if none are waiting |

- Running messages use SDK `prompt(..., { streamingBehavior: 'steer' })` without changing mode. Acceptance is not execution or completion.
- Completion goes through one finish path. Waiting observers receive the result without an additional background notification. Immediate observations, expired waits, and cancelled waits do not suppress later notifications. `stop` keeps the delivery policy; shutdown cleanup suppresses notifications.
- Notifications use Pi `sendMessage(..., { deliverAs: 'steer', triggerTurn: true })`: delivery enters at a processable SDK boundary when the parent is busy and wakes it when idle. Children do not need a notification tool.
- Cancelling a foreground start or idle-send wait requests child cancellation. After background acceptance, or a running-message acceptance, the completed tool call's signal is not attached to the child execution.
- Notifications are best-effort, in-process delivery, with no restart recovery or exactly-once guarantee. Pi reports asynchronous delivery failures. Results remain available through observe.

Stopping does not undo file changes or erase context. When changing goals after a stop, explicitly cancel the old goal in your next instruction. The main agent must verify output; `ended` does not mean business success.

## Execution boundaries

- Each parent allows up to 16 concurrent and 1024 retained child sessions. State queries use memory and SDK state, not disk scans or history parsing.
- Children have only `read/bash/edit/write`, project rules, and locally discovered Skills. Parent chat history is not copied.
- Parent extensions, package resources, MCP servers, and notification tools are not loaded. Recursive delegation tools are not installed. Models must resolve from local Pi model configuration; models registered only temporarily by parent extensions are not inherited.
- **Not a security sandbox:** children share filesystem, process privileges, and model services. Parent-extension confirmation/permission hooks are not inherited. “Read-only” is an instruction, not enforced filesystem access control. Assign disjoint files for parallel writers. Do not use this default tool set where extension-enforced approval is required.
- Tasks are parent-scoped. Switching, forking, or closing cancels execution and releases resources. If stopping is unconfirmed after five seconds, state remains running; switching/forking is cancelled and can be retried.
- Session logs use Pi's normal `~/.pi/agent/sessions/<cwd group>/` layout, respecting `PI_CODING_AGENT_DIR`, and retain parent-session linkage. Pi's default session list and `pi-snap` can discover them. Background execution and task IDs are not restored after process exit.
- A single-slot model server may serialize requests. Background execution does not imply parallel GPU inference.

## Discovery versus ownership

Ordinary SDK session files and parent links support discovery by Pi and `pi-snap`. Discovery does not transfer execution ownership: this extension manages run state, messages, cancellation, and result delivery.

No WebUI shared-instance or parent-liveness bridges are registered, and runtime state is not handed to upstream. Upstream file-list refresh is outside this extension's responsibilities. Do not resume a still-active child from another process.

## Tests

```bash
npm ci
npm test
# Real SDK with a local mock HTTP model; no external model calls:
PI_SDK_ENTRY=/absolute/path/to/pi/dist/index.js npm test
PI_SDK_ENTRY=/absolute/path/to/pi/dist/index.js node test/benchmark.mjs
```

Without `PI_SDK_ENTRY`, real-SDK tests are skipped. `test/local-smoke.mjs` is a separately invoked real local-model exercise, not part of the default tests.

Validated locally with Windows Git Bash, Node 22.23.2, and official Pi 1.0.0. macOS/Linux and other Pi versions have not yet been locally tested. The benchmark compares resource loading with/without the extension and queries with large output; it does not measure full cold startup or model inference.

## Related projects

- [pi-cron](https://github.com/arkkwang/pi-cron): schedule agent tasks.
- [pi-snap](https://github.com/arkkwang/pi-snap): help humans and agents investigate session failures.

## License

[MIT](LICENSE)
