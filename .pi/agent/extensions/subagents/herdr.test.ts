import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { registerBridge, type WorkerState } from './src/herdr/bridge.ts';
import { HerdrTaskManager, summarizeTask, TaskStore, type SpawnOptions } from './src/herdr/manager.ts';
import { HostError, hostCommand, resolveMachine, shellQuote, Transport, type Endpoint, type HostTransport, type MachineProfile } from './src/herdr/transport.ts';
import { registerHerdrDelegation } from './src/herdr/index.ts';

const local: Extract<Endpoint, { kind: 'local' }> = { kind: 'local', label: 'local', socket: '/test/herdr.sock', binary: 'herdr' };
const profile: MachineProfile = { id: 'profile-base', label: 'base', target: 'user@example.test', session: 'agents', enabled: true };
const options: SpawnOptions = { toolCallId: 'call-1', name: 'review', prompt: 'Review only.', parentCwd: '/repo', parentWorkspace: 'w1', parentTrusted: true };
class FakeHost implements HostTransport {
  profiles = [profile];
  calls: { endpoint: Endpoint; request: Record<string, unknown> }[] = [];
  states = new Map<string, WorkerState>();
  results = new Map<string, WorkerState>();
  failPrompt = false;
  busyStarts = 0;
  disconnected = false;
  workspaces = [{ workspace_id: 'w1' }];
  async call<T>(endpoint: Endpoint, request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    this.calls.push({ endpoint, request });
    if (request.op === 'profiles') return this.profiles as T;
    if (this.disconnected) throw new Error('offline');
    const id = request.id as string;
    if (request.op === 'probe') return { home: '/home/test', cwd: request.cwd, piVersion: '0.84.2', workspaces: this.workspaces } as T;
    if (request.op === 'prepare') {
      this.states.set(id, { id, status: 'ready', updatedAt: Date.now() });
      return { dir: `/home/test/.pi/agent/herdr-delegation/workers/${id}` } as T;
    }
    if (request.op === 'read') return { state: this.states.get(id), result: this.results.get(id) } as T;
    if (request.op === 'cancel') return { requested: true } as T;
    const args = request.args as string[];
    if (args?.[0] === 'tab' && args[1] === 'create') return { tab: { tab_id: 'w1:t2' }, root_pane: { pane_id: 'w1:p2' } } as T;
    if (args?.[0] === 'agent' && args[1] === 'start' && this.busyStarts-- > 0) throw new HostError('shell starting', 'agent_pane_busy');
    if (args?.[0] === 'agent' && args[1] === 'prompt') {
      const taskId = args[3]!.replace('HERDR_TASK_', '');
      this.states.set(taskId, { id: taskId, status: 'running', updatedAt: Date.now() });
      if (this.failPrompt) throw new Error('ambiguous timeout after delivery');
    }
    return {} as T;
  }
}
function fixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-task-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new TaskStore(dir, 'parent-session');
  const host = new FakeHost();
  const manager = new HerdrTaskManager(store, 'parent-session', local, host, '// test bridge');
  return { dir, store, host, manager };
}

test('local spawn creates a no-focus tab, inherits cwd/trust, and is idempotent', async (t) => {
  const { manager, host } = fixture(t);
  const first = await manager.spawn({ ...options, model: 'provider/model', thinking: 'high' });
  const replay = await manager.spawn(options);
  assert.equal(first.id, replay.id);
  const creates = host.calls.filter((c) => (c.request.args as string[])?.[0] === 'tab');
  assert.equal(creates.length, 1);
  assert.ok((creates[0]!.request.args as string[]).includes('--no-focus'));
  const start = host.calls.find((c) => (c.request.args as string[])?.[1] === 'start')!.request.args as string[];
  assert.ok(start.includes('--approve'));
  assert.ok(start.includes('provider/model'));
  assert.equal(first.phase, 'submitted');
  assert.equal(first.cwd, '/repo');
});

test('remote targeting pins profile/session, requires target cwd, and never auto-trusts', async (t) => {
  const { manager, host } = fixture(t);
  await assert.rejects(manager.spawn({ ...options, machine: 'base' }), /absolute path/);
  assert.equal(host.calls.filter((c) => c.request.op !== 'profiles').length, 0);
  const task = await manager.spawn({ ...options, machine: 'base', workingDir: '/remote/repo' });
  assert.equal(task.endpoint.kind, 'ssh');
  assert.equal(task.cwd, '/remote/repo');
  const calls = host.calls.filter((c) => c.request.op !== 'profiles');
  assert.ok(calls.every((c) => c.endpoint.kind === 'ssh' && c.endpoint.session === 'agents'));
  const start = calls.find((c) => (c.request.args as string[])?.[1] === 'start')!.request.args as string[];
  assert.ok(start.includes('--no-approve'));
  assert.ok(!start.includes('--approve'));
  assert.deepEqual(Object.keys(host.calls.find((c) => c.request.op === 'prepare')!.request).sort(), ['bridge', 'id', 'op', 'task']);
});

test('remote multiple workspaces requires explicit selection before copying/launching', async (t) => {
  const { manager, host } = fixture(t);
  host.workspaces = [{ workspace_id: 'w1' }, { workspace_id: 'w2' }];
  await assert.rejects(manager.spawn({ ...options, machine: 'base', workingDir: '/remote' }), /workspace_id/);
  assert.ok(!host.calls.some((c) => c.request.op === 'prepare'));
});

test('machine resolution rejects disabled, ambiguous, unknown and option-like targets', () => {
  assert.throws(() => resolveMachine([{ ...profile, enabled: false }], 'base'), /disabled/);
  assert.throws(() => resolveMachine([profile, { ...profile, id: 'second' }], 'base'), /ambiguous/);
  assert.throws(() => resolveMachine([], 'base'), /missing/);
  assert.throws(() => resolveMachine([{ ...profile, target: '-oProxyCommand=bad' }], 'base'), /Unsafe/);
  assert.equal(resolveMachine([profile], profile.id).kind, 'ssh');
});

test('SSH transport quotes helper, enforces noninteractive SSH, and never embeds task data', () => {
  const endpoint = resolveMachine([profile], 'base');
  const command = hostCommand(endpoint, "console.log('safe')");
  assert.equal(command.command, 'ssh');
  assert.ok(command.args.includes('StrictHostKeyChecking=yes'));
  assert.ok(command.args.includes('BatchMode=yes'));
  assert.ok(command.args.includes('ForwardAgent=no'));
  assert.ok(command.args.includes('--'));
  assert.equal(shellQuote("a'b"), "'a'\\''b'");
});

test('persistent tasks reconnect and retrieve structured results', async (t) => {
  const { manager, host, store } = fixture(t);
  const task = await manager.spawn(options);
  const resumed = new HerdrTaskManager(store, 'parent-session', local, host, '');
  host.results.set(task.id, { id: task.id, status: 'done', text: 'Structured answer', updatedAt: Date.now() });
  const result = await resumed.refresh(task.id);
  assert.equal(result.result?.text, 'Structured answer');
  assert.equal(summarizeTask(result).status, 'done');
  resumed.acknowledge(task.id);
  assert.equal(new HerdrTaskManager(store, 'parent-session', local, host, '').get(task.id).acknowledged, true);
});

test('ambiguous prompt failure retains IDs and never duplicates work on replay', async (t) => {
  const { manager, host } = fixture(t);
  host.failPrompt = true;
  await assert.rejects(manager.spawn(options), /Retained for inspection/);
  const task = manager.list()[0]!;
  assert.equal(task.paneId, 'w1:p2');
  assert.equal(task.phase, 'uncertain');
  await manager.spawn(options);
  assert.equal(host.calls.filter((c) => (c.request.args as string[])?.[1] === 'prompt').length, 1);
  host.results.set(task.id, { id: task.id, status: 'done', text: 'Actually succeeded', updatedAt: Date.now() });
  assert.equal((await manager.refresh(task.id)).result?.text, 'Actually succeeded');
});

test('disconnection/stale heartbeat are never treated as completion', async (t) => {
  const { manager, host } = fixture(t);
  const task = await manager.spawn(options);
  host.disconnected = true;
  assert.equal(summarizeTask(await manager.refresh(task.id)).status, 'unreachable');
  assert.equal(task.result, undefined);
  host.disconnected = false;
  host.states.set(task.id, { id: task.id, status: 'running', updatedAt: Date.now() - 30000 });
  assert.equal(summarizeTask(await manager.refresh(task.id)).status, 'unresponsive');
});

test('profile edits cannot silently retarget an existing remote task', async (t) => {
  const { manager, host } = fixture(t);
  const task = await manager.spawn({ ...options, machine: 'base', workingDir: '/remote' });
  host.profiles = [{ ...profile, target: 'different-host' }];
  const count = host.calls.filter((c) => c.request.op === 'read').length;
  const checked = await manager.refresh(task.id);
  assert.match(checked.connectionError!, /Refusing to retarget/);
  assert.equal(host.calls.filter((c) => c.request.op === 'read').length, count);
});

test('cancel uses task-scoped control, not terminal keys/close; blocked wait returns', async (t) => {
  const { manager, host } = fixture(t);
  const task = await manager.spawn(options);
  host.states.set(task.id, { id: task.id, status: 'blocked', updatedAt: Date.now() });
  assert.equal((await manager.wait(task.id, 10000)).worker?.status, 'blocked');
  await manager.cancel(task.id);
  assert.equal(task.cancelRequested, true);
  assert.equal(host.calls.at(-1)!.request.op, 'cancel');
  assert.ok(!host.calls.some((c) => (c.request.args as string[])?.includes('close')));
});

test('aborted wait does not cancel child', async (t) => {
  const { manager, host } = fixture(t);
  const task = await manager.spawn(options);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(manager.wait(task.id, 5000, controller.signal));
  assert.ok(!host.calls.some((c) => c.request.op === 'cancel'));
});

test('concurrent launches cap at four and same-call replay launches once', async (t) => {
  const { manager, host } = fixture(t);
  const tasks = await Promise.all(Array.from({ length: 4 }, (_, i) => manager.spawn({ ...options, toolCallId: `call-${i}` })));
  assert.equal(tasks.length, 4);
  await assert.rejects(manager.spawn({ ...options, toolCallId: 'fifth' }), /Four unresolved/);
  assert.equal(host.calls.filter((c) => (c.request.args as string[])?.[0] === 'tab').length, 4);
});

test('busy shell rejection is safely retried without creating another tab', async (t) => {
  const { manager, host } = fixture(t);
  host.busyStarts = 1;
  await manager.spawn(options);
  assert.equal(host.calls.filter((c) => (c.request.args as string[])?.[1] === 'start').length, 2);
  assert.equal(host.calls.filter((c) => (c.request.args as string[])?.[0] === 'tab').length, 1);
});

test('simultaneous replay of the same tool call creates only one child', async (t) => {
  const { manager, host } = fixture(t);
  const [first, second] = await Promise.all([manager.spawn(options), manager.spawn(options)]);
  assert.equal(first.id, second.id);
  assert.equal(host.calls.filter((c) => (c.request.args as string[])?.[0] === 'tab').length, 1);
});

test('wait deadline also bounds an existing slow poll', async (t) => {
  const { manager, host } = fixture(t);
  const task = await manager.spawn(options);
  const original = host.call.bind(host);
  let release!: () => void;
  host.call = async (endpoint, request, signal) => {
    if (request.op === 'read') await new Promise<void>((resolve) => { release = resolve; });
    return original(endpoint, request, signal);
  };
  const poll = manager.refresh(task.id);
  const keepAlive = setTimeout(() => release?.(), 1000);
  t.after(() => clearTimeout(keepAlive));
  const start = Date.now();
  const result = await manager.wait(task.id, 30);
  assert.equal(result.result, undefined);
  assert.ok(Date.now() - start < 500);
  release();
  await poll;
});

test('detach releases the concurrency slot without cancelling or closing anything', async (t) => {
  const { manager, host } = fixture(t);
  const task = await manager.spawn(options);
  const calls = host.calls.length;
  manager.detach(task.id);
  assert.equal(host.calls.length, calls);
  assert.equal(summarizeTask(task).status, 'detached');
  assert.equal(task.acknowledged, true);
});

test('parent resumes automatic results, deduplicates, and shutdown never cancels children', async (t) => {
  const { manager, host } = fixture(t);
  const task = await manager.spawn(options);
  const env = { HERDR_ENV: process.env.HERDR_ENV, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH, HERDR_WORKSPACE_ID: process.env.HERDR_WORKSPACE_ID };
  Object.assign(process.env, { HERDR_ENV: '1', HERDR_SOCKET_PATH: '/test', HERDR_WORKSPACE_ID: 'w1' });
  t.after(() => { for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const handlers = new Map<string, (...args: any[]) => any>();
  const messages: unknown[] = [];
  const pi = {
    on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn),
    registerTool: () => {}, sendMessage: (message: unknown) => messages.push(message),
  } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getEntries: () => [], getSessionId: () => 'parent-session' }, isIdle: () => true, ui: { notify: () => {} } } as unknown as ExtensionContext;
  registerHerdrDelegation(pi, { createManager: () => manager, pollIntervalMs: 10 });
  handlers.get('session_start')!({}, ctx);
  t.after(() => handlers.get('session_shutdown')!());
  host.results.set(task.id, { id: task.id, status: 'done', text: 'Result', updatedAt: Date.now() });
  await sleep(50);
  assert.equal(messages.length, 1);
  handlers.get('agent_settled')!();
  assert.equal(messages.length, 1);
  handlers.get('session_shutdown')!();
  assert.ok(!host.calls.some((c) => c.request.op === 'cancel' || (c.request.args as string[])?.includes('close')));
});

test('real host helper rejects unknown operations and unsafe task IDs', async () => {
  const transport = new Transport();
  await assert.rejects(transport.call(local, { op: 'read', id: '../escape' }), /Invalid task ID/);
});

function bridgeFixture(t: { after(fn: () => void): void }) {
  const dir = mkdtempSync(join(tmpdir(), 'herdr-bridge-test-'));
  const id = 'a'.repeat(32);
  writeFileSync(join(dir, 'task.json'), JSON.stringify({ id, name: 'test', prompt: 'Task body' }));
  const handlers = new Map<string, (...args: any[]) => any>();
  let aborts = 0;
  const pi = { on: (name: string, fn: (...args: any[]) => any) => handlers.set(name, fn), setSessionName: () => {} } as unknown as ExtensionAPI;
  const ctx = { sessionManager: { getSessionFile: () => '/session.jsonl' }, isIdle: () => false, abort: async () => { aborts++; }, ui: { notify: () => {} } } as unknown as ExtensionContext;
  registerBridge(pi, dir);
  const emit = (name: string, event: any = {}) => handlers.get(name)?.(event, ctx);
  emit('session_start');
  t.after(() => { emit('session_shutdown'); rmSync(dir, { recursive: true, force: true }); });
  const state = () => JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as WorkerState;
  const result = () => JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')) as WorkerState;
  const assistant = (stopReason = 'stop', text = 'Answer') => emit('message_end', { message: { role: 'assistant', content: [{ type: 'text', text }], stopReason } });
  return { dir, id, emit, state, result, assistant, aborts: () => aborts };
}

test('bridge transforms task marker once; waits for settled, not agent_end', (t) => {
  const f = bridgeFixture(t);
  assert.equal(f.state().status, 'ready');
  assert.deepEqual(f.emit('input', { text: `HERDR_TASK_${f.id}` }), { action: 'transform', text: 'Task body' });
  assert.deepEqual(f.emit('input', { text: `HERDR_TASK_${f.id}` }), { action: 'handled' });
  f.assistant('error');
  f.emit('agent_end');
  assert.equal(f.state().status, 'running');
  f.assistant('stop', 'Retried successfully');
  f.emit('agent_settled');
  assert.equal(f.result().text, 'Retried successfully');
  assert.equal(f.result().status, 'done');
});

test('bridge reports failures/interrupts and does not call them done', (t) => {
  const f = bridgeFixture(t);
  f.emit('input', { text: `HERDR_TASK_${f.id}` });
  f.assistant('aborted');
  f.emit('agent_settled');
  assert.equal(f.result().status, 'interrupted');
});

test('human takeover prevents later answers being attributed to delegated task', (t) => {
  const f = bridgeFixture(t);
  f.emit('input', { text: `HERDR_TASK_${f.id}` });
  f.emit('input', { text: 'Actually do something else' });
  f.assistant('stop', 'Different task');
  f.emit('agent_settled');
  assert.equal(f.result().status, 'handed_off');
  assert.equal(f.result().text, undefined);
});

test('bridge acknowledges task cancellation without exiting Pi', async (t) => {
  const f = bridgeFixture(t);
  f.emit('input', { text: `HERDR_TASK_${f.id}` });
  writeFileSync(join(f.dir, 'cancel.json'), JSON.stringify({ id: f.id }));
  await sleep(1150);
  assert.equal(f.aborts(), 1);
  f.assistant('aborted');
  f.emit('agent_settled');
  assert.equal(f.result().status, 'cancelled');
});
