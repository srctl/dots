# Herdr delegation prototype

Pi-first, visible subagents with explicit local or saved SSH-machine placement.
This is additive: the existing `subagent_*` tools and `/btw` remain unchanged.
Reload Pi with `/reload` to discover the new tools.

## Tools

- `herdr_machines({})`: list saved Herdr machine profiles without connecting.
- `herdr_machines({ machine: "base" })`: inspect that machine's workspace IDs.
- `herdr_delegate({ name, prompt, machine?, working_dir?, workspace_id?, model?, reasoning_effort? })`:
  start a Pi child in a new unfocused Herdr tab and return its task ID.
- `herdr_task({ action: "list" })`: list this parent session's cached tasks.
- `herdr_task({ action: "check", id })`: refresh structured state/result.
- `herdr_task({ action: "wait", id, timeout_ms?: 60000 })`: wait, bounded to at
  most 300 seconds. Blocking UI, connection errors, uncertain startup, or a
  stale heartbeat return early. Aborting the wait does not cancel the child.
- `herdr_task({ action: "cancel", id })`: request interruption through the
  task's control file. Check again for acknowledgement. Never closes the tab.
- `herdr_task({ action: "detach", id })`: stop automatic tracking/delivery and
  release the concurrency slot without stopping the child. Useful for a task
  you took over or an abandoned setup failure. Does not delete its record.

Example local delegation:

```json
{
  "name": "Review parser",
  "prompt": "Review src/parser.ts for correctness. Do not edit files. Report actionable findings."
}
```

Example remote delegation (only when the user requests `base`):

```json
{
  "name": "Linux tests",
  "machine": "base",
  "working_dir": "/home/exedev/workspace/my-project",
  "workspace_id": "<ID returned by herdr_machines>",
  "prompt": "Run the parser tests in this checkout. Do not edit files. Report the command, result, and any failures."
}
```

The example remote directory must already exist; it is not created or synced.
If a remote session contains exactly one workspace, `workspace_id` is optional.
Otherwise it must be explicit. Local defaults are the caller's cwd/workspace.

## Requirements and safety

- The parent must run inside Herdr with its injected socket/workspace context.
- Both hosts need Herdr and Pi; remote automation also needs Node (18+).
- The selected host must already have a running compatible Herdr server and
  its own Pi provider/model configuration and credentials.
- Targets are saved, enabled Herdr profiles by exact label or opaque ID. No raw
  SSH hosts are accepted by the tool. Ambiguous labels fail closed.
- SSH uses OpenSSH configuration, batch mode, strict host-key checking, no agent
  forwarding, and bounded connection/operation timeouts. It does not install
  software, accept host keys, replace servers, or modify machine profiles.
- A task pins the profile ID, SSH target, and session. Later profile edits cannot
  silently redirect it to another machine/session. Disabling/removing its
  profile stops automatic remote access; it does not stop the remote process.
- Only a standalone bridge and task payload are transferred to the selected
  host. No repository, parent conversation, credentials, or user configuration
  is automatically copied. The prompt itself is stored on both machines only
  where their existing Pi/session machinery records it; the worker payload is
  stored on the selected machine.
- Remote project-local Pi resources are disabled with `--no-approve`. Global
  host configuration remains available. The same local cwd can inherit the
  live parent's trust decision; alternate local cwd is not auto-trusted.
- Model and thinking level default to the parent's selection. A missing model
  or authentication is a startup/task error, not permission to copy credentials.
- Four unresolved tasks per parent session. The legacy headless manager has its
  own separate cap. Detached and completed Herdr tasks do not consume a slot.

## Implementation

`src/herdr/index.ts` registers tools and manages parent-side result polling.
`manager.ts` owns persistent task identity and orchestration.
`transport.ts` invokes `host.cjs` locally or over SSH. Requests go over stdin,
not interpolated shell commands. `host.cjs` calls the target's Herdr CLI and
handles private worker files. `bridge.ts` is a dependency-free Pi extension
copied to each worker directory and explicitly loaded in that child.

Startup sequence:

1. Resolve and validate the endpoint, cwd, and existing workspace.
2. Persist a stable task ID derived from parent session + tool-call ID.
3. Copy the bridge/task into a private, exclusively created worker directory.
4. Create an unfocused tab and persist its returned opaque IDs.
5. Start interactive Pi with a dedicated native session file.
6. Verify the bridge's ready state, then submit an idempotent task marker.
7. The bridge transforms the marker into the actual prompt exactly once.
8. Parent reads task state/results, never terminal text as the final answer.

New shells can initially reject agent startup. Only the explicit
`agent_pane_busy` rejection is retried, for up to 20 seconds. Other startup or
submission failures retain the record and any known IDs. They are not replayed.
Use `check` to discover whether an ambiguous submission actually completed.

The bridge uses `message_end` plus `agent_settled`, not transient `agent_end`,
so retries/compaction cannot prematurely report completion. Only a successful
final assistant stop counts as done; model errors, aborts, and session shutdown
have distinct outcomes. Herdr's agent status supplies supplementary blocking-UI
information, but its seen-dependent `done` badge never determines task success.

Interactive user input hands the child over to the user and closes task
attribution as `handed_off`. The parent does not label the user's subsequent
work as its own task result. Nested delegation tools are blocked in the child;
the ordinary same-user tools are not an OS sandbox.

## Persistence and results

Parent records:

```text
<getAgentDir()>/herdr-delegation/parents/<hashed-parent-session>/<task-id>.json
```

On the selected host:

```text
~/.pi/agent/herdr-delegation/workers/<task-id>/
  bridge.ts
  task.json
  state.json
  result.json       # published only for a terminal task outcome
  cancel.json       # optional task-scoped cancellation request
  session.jsonl    # native Pi conversation
```

Directories are created with mode 0700 and files with 0600; state/result writes
use atomic rename. These contain prompts and model output: treat them as
sensitive session data. No automatic deletion/retention policy is implemented.
Tool responses are limited to 24 KB / 600 lines. Worker text snapshots are
bounded; the native session file retains the full transcript.

The parent polls about every five seconds, defers automatic result messages
until idle, and restores tasks on reload/resume of the same parent session.
Session message IDs prevent redelivery of results already present in the
conversation. Explicitly returning a completed result via check/wait consumes
its pending automatic delivery. This is not a distributed exactly-once queue;
a process crash at the delivery/persistence boundary can require inspection.

Parent shutdown/reload stops only its own polling/transport connections. Child
processes remain owned by Herdr. Detaching the Herdr UI also preserves them.
**Closing the child's tab kills its processes.** Normal completed tabs remain
available for inspection and follow-up conversation.

A lost SSH connection is `unreachable`; an old bridge heartbeat is
`unresponsive`. Neither is success or permission to launch a replacement.
The prototype does not automatically resume/replay a task after a Herdr server
restart. Native agent restoration may restore a conversation without this
explicit bridge; inspect the session and start a new task deliberately.

## Verification

```sh
cd ~/.pi/agent/extensions/subagents
npm run test:herdr
npm run check
npm test
```

Live smoke tests verified structured completion in a local tab and on the saved
`base` SSH machine (Herdr 0.9.0, remote Pi 0.81.1 / Node 18). The dedicated test
tabs were closed after verification; worker/session artifacts remain available.
