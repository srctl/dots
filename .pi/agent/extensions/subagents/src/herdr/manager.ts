import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { terminalStatuses, type WorkerState } from './bridge.ts';
import { HostError, resolveMachine, type Endpoint, type HostTransport, type MachineProfile } from './transport.ts';

export interface TaskRecord {
  version: 1;
  id: string;
  parentSession: string;
  name: string;
  createdAt: number;
  endpoint: Endpoint;
  cwd: string;
  workspaceId?: string;
  tabId?: string;
  paneId?: string;
  workerDir?: string;
  phase: 'preparing' | 'launching' | 'submitted' | 'uncertain';
  worker?: WorkerState;
  result?: WorkerState;
  connectionError?: string;
  setupError?: string;
  cancelRequested?: boolean;
  acknowledged?: boolean;
  detached?: boolean;
}
export interface SpawnOptions {
  toolCallId: string;
  name: string;
  prompt: string;
  machine?: string;
  workingDir?: string;
  workspaceId?: string;
  model?: string;
  thinking?: string;
  parentCwd: string;
  parentWorkspace: string;
  parentTrusted: boolean;
}
export interface Probe {
  home: string;
  piVersion: string;
  cwd: string;
  workspaces: { workspace_id: string; label?: string }[];
}

export class TaskStore {
  readonly dir: string;
  constructor(root: string, parentSession: string) {
    this.dir = join(root, createHash('sha256').update(parentSession).digest('hex'));
  }
  private path(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error('Invalid task ID');
    return join(this.dir, `${id}.json`);
  }
  list(): TaskRecord[] {
    let names: string[];
    try { names = readdirSync(this.dir); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error; }
    return names.filter((name) => /^[a-f0-9]{32}\.json$/.test(name)).map((name) => {
      const task = JSON.parse(readFileSync(join(this.dir, name), 'utf8')) as TaskRecord;
      if (task.version !== 1 || name !== `${task.id}.json`) throw new Error(`Invalid task record: ${name}`);
      return task;
    });
  }
  save(task: TaskRecord, exclusive = false): void {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const file = this.path(task.id);
    if (exclusive) {
      writeFileSync(file, JSON.stringify(task), { mode: 0o600, flag: 'wx' });
      return;
    }
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(task), { mode: 0o600 });
    renameSync(temp, file);
  }
}

export class HerdrTaskManager {
  private readonly tasks = new Map<string, TaskRecord>();
  private readonly refreshing = new Map<string, Promise<TaskRecord>>();
  private reservations = 0;
  readonly store: TaskStore;
  readonly parentSession: string;
  readonly local: Extract<Endpoint, { kind: 'local' }>;
  readonly transport: HostTransport;
  readonly bridgeSource: string;
  constructor(
    store: TaskStore,
    parentSession: string,
    local: Extract<Endpoint, { kind: 'local' }>,
    transport: HostTransport,
    bridgeSource: string = readFileSync(new URL('./bridge.ts', import.meta.url), 'utf8'),
  ) {
    this.store = store;
    this.parentSession = parentSession;
    this.local = local;
    this.transport = transport;
    this.bridgeSource = bridgeSource;
    for (const task of store.list()) this.tasks.set(task.id, task);
  }
  list(): TaskRecord[] { return [...this.tasks.values()].sort((a, b) => a.createdAt - b.createdAt); }
  get(id: string): TaskRecord {
    const task = this.tasks.get(id);
    if (!task) throw new Error(`Unknown Herdr task: ${id}`);
    return task;
  }
  profiles(signal?: AbortSignal): Promise<MachineProfile[]> {
    return this.transport.call(this.local, { op: 'profiles' }, signal);
  }
  async endpoint(selector?: string, signal?: AbortSignal): Promise<Endpoint> {
    return !selector || selector === 'local' ? this.local : resolveMachine(await this.profiles(signal), selector);
  }
  async validateEndpoint(endpoint: Endpoint, signal?: AbortSignal): Promise<void> {
    if (endpoint.kind !== 'ssh') return;
    const current = resolveMachine(await this.profiles(signal), endpoint.profileId);
    if (current.kind !== 'ssh' || current.target !== endpoint.target || current.session !== endpoint.session) {
      throw new Error('Saved machine target/session changed. Refusing to retarget an existing task.');
    }
  }
  async workspaces(selector?: string, signal?: AbortSignal): Promise<unknown> {
    const endpoint = await this.endpoint(selector, signal);
    return this.herdr(endpoint, ['workspace', 'list'], signal);
  }
  private herdr<T>(endpoint: Endpoint, args: string[], signal?: AbortSignal): Promise<T> {
    return this.transport.call(endpoint, { op: 'herdr', args }, signal);
  }
  async spawn(options: SpawnOptions, signal?: AbortSignal): Promise<TaskRecord> {
    signal?.throwIfAborted();
    const id = createHash('sha256').update(`${this.parentSession}\0${options.toolCallId}`).digest('hex').slice(0, 32);
    // Tool replay must return the same task, never launch another agent.
    if (this.tasks.has(id)) return this.get(id);
    if (this.list().filter((task) => !task.result && !task.detached).length + this.reservations >= 4) {
      throw new Error('Four unresolved Herdr tasks already exist. Inspect/cancel them before spawning more.');
    }
    this.reservations++;
    let reserved = true;
    let task: TaskRecord | undefined;
    try {
      const endpoint = await this.endpoint(options.machine, signal);
      if (this.tasks.has(id)) return this.get(id);
      if (endpoint.kind === 'ssh' && (!options.workingDir || !options.workingDir.startsWith('/'))) {
        throw new Error('Remote delegation requires working_dir as an absolute path on the target machine. No repository or credentials are copied.');
      }
      const cwd = endpoint.kind === 'local' ? resolve(options.parentCwd, options.workingDir ?? '.') : options.workingDir!;
      task = { version: 1, id, parentSession: this.parentSession, name: options.name, createdAt: Date.now(), endpoint, cwd, phase: 'preparing' };
      this.store.save(task, true);
      this.tasks.set(id, task);
      this.reservations--;
      reserved = false;
      const probe = await this.transport.call<Probe>(endpoint, { op: 'probe', cwd }, signal);
      task.cwd = probe.cwd;
      const workspace = options.workspaceId ?? (endpoint.kind === 'local' ? options.parentWorkspace :
        probe.workspaces.length === 1 ? probe.workspaces[0]!.workspace_id : undefined);
      if (!workspace || !probe.workspaces.some((item) => item.workspace_id === workspace)) {
        throw new Error('Select an existing workspace_id on the target machine using herdr_machines. No focused workspace is assumed remotely.');
      }
      task.workspaceId = workspace;
      task.workerDir = join(probe.home, '.pi/agent/herdr-delegation/workers', id);
      this.store.save(task);
      await this.transport.call(endpoint, {
        op: 'prepare', id, bridge: this.bridgeSource,
        task: { id, name: options.name, prompt: options.prompt, parentSession: this.parentSession },
      }, signal);
      task.phase = 'launching';
      this.store.save(task);
      const created = await this.herdr<{ tab: { tab_id: string }; root_pane: { pane_id: string } }>(endpoint,
        ['tab', 'create', '--workspace', workspace, '--cwd', task.cwd, '--label', `delegate-${id.slice(0, 8)}: ${options.name}`,
          '--env', `PI_HERDR_TASK_DIR=${task.workerDir}`, '--no-focus'], signal);
      task.tabId = created.tab.tab_id;
      task.paneId = created.root_pane.pane_id;
      this.store.save(task);
      // Preserve normal host extensions/config, but never auto-trust a remote repo.
      const args = ['--extension', join(task.workerDir, 'bridge.ts'), '--session', join(task.workerDir, 'session.jsonl'),
        '--name', options.name, '--offline',
        endpoint.kind === 'local' && resolve(options.parentCwd) === resolve(task.cwd) && options.parentTrusted ? '--approve' : '--no-approve'];
      if (options.model) args.push('--model', options.model);
      if (options.thinking) args.push('--thinking', options.thinking);
      const shellDeadline = Date.now() + 20000;
      for (;;) {
        try {
          await this.herdr(endpoint, ['agent', 'start', `delegate-${id.slice(0, 16)}`, '--kind', 'pi', '--pane', task.paneId,
            '--timeout', '30000', '--', ...args], signal);
          break;
        } catch (error) {
          // A newly created shell may still be initializing. This specific rejection
          // guarantees no agent was launched; never retry timeouts or other errors.
          if (!(error instanceof HostError) || error.code !== 'agent_pane_busy' || Date.now() >= shellDeadline) throw error;
          await sleep(500, undefined, { signal });
        }
      }
      // Verify the bridge loaded before submitting anything; no terminal-output parsing.
      const ready = await this.transport.call<{ state: WorkerState | null }>(endpoint, { op: 'read', id }, signal);
      if (ready.state?.id !== id || ready.state.status !== 'ready') throw new Error('Child bridge did not become ready; inspect its tab. Prompt was not submitted.');
      task.worker = ready.state;
      // Persist intent before submission: any ambiguous transport failure is recoverable via check.
      task.phase = 'submitted';
      this.store.save(task);
      await this.herdr(endpoint, ['agent', 'prompt', task.paneId, `HERDR_TASK_${id}`], signal);
      return task;
    } catch (error) {
      if (task && this.tasks.get(id) === task) {
        task.phase = 'uncertain';
        task.setupError = error instanceof Error ? error.message : String(error);
        this.store.save(task);
        throw new Error(`Herdr task ${id}: ${task.setupError}. Retained for inspection; do not blindly respawn. ${task.tabId ? `Tab: ${task.tabId}` : ''}`);
      }
      throw error;
    } finally { if (reserved) this.reservations--; }
  }
  refresh(id: string, signal?: AbortSignal): Promise<TaskRecord> {
    const existing = this.refreshing.get(id);
    if (existing) return withAbort(existing, signal);
    const pending = this.refreshNow(id, signal).finally(() => this.refreshing.delete(id));
    this.refreshing.set(id, pending);
    return pending;
  }
  private async refreshNow(id: string, signal?: AbortSignal): Promise<TaskRecord> {
    const task = this.get(id);
    if (task.result || !task.workerDir) return task;
    try {
      await this.validateEndpoint(task.endpoint, signal);
      const update = await this.transport.call<{ state: WorkerState | null; result: WorkerState | null;
        agent?: { agent_status?: string; agent_session?: { value: string } };
      }>(task.endpoint, { op: 'read', id, paneId: task.paneId }, signal);
      for (const state of [update.state, update.result]) {
        if (state && (state.id !== id || !Number.isFinite(state.updatedAt))) throw new Error('Invalid worker task identity/state');
      }
      if (update.state) {
        task.worker = update.state;
        if (update.state.status === 'running' && update.agent?.agent_status === 'blocked' &&
          (!update.agent.agent_session || update.agent.agent_session.value === update.state.sessionFile)) {
          task.worker = { ...update.state, status: 'blocked' };
        }
      }
      if (update.result) {
        if (!terminalStatuses.has(update.result.status)) throw new Error('Worker returned a non-terminal result');
        task.result = update.result;
      }
      task.connectionError = undefined;
    } catch (error) {
      if (signal?.aborted) return task;
      task.connectionError = error instanceof Error ? error.message : String(error);
    }
    this.store.save(task);
    return task;
  }
  async cancel(id: string, signal?: AbortSignal): Promise<TaskRecord> {
    const task = await this.refresh(id, signal);
    signal?.throwIfAborted();
    if (task.result) return task;
    if (!task.workerDir) throw new Error('Worker was not prepared. Inspect the setup error; no cancellation was sent.');
    await this.validateEndpoint(task.endpoint, signal);
    // Cancellation is task-scoped, not a keypress into a possibly replaced pane.
    await this.transport.call(task.endpoint, { op: 'cancel', id }, signal);
    task.cancelRequested = true;
    this.store.save(task);
    return task;
  }
  async wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<TaskRecord> {
    const deadline = AbortSignal.timeout(timeoutMs);
    const bounded = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      for (;;) {
        bounded.throwIfAborted();
        const task = await withAbort(this.refresh(id, bounded), bounded);
        bounded.throwIfAborted();
        if (task.result || task.detached || task.connectionError || task.worker?.status === 'blocked' || task.phase === 'uncertain' ||
          (task.worker && Date.now() - task.worker.updatedAt > 15000)) return task;
        await sleep(1000, undefined, { signal: bounded });
      }
    } catch (error) {
      signal?.throwIfAborted();
      if (deadline.aborted) return this.get(id);
      throw error;
    }
  }
  detach(id: string): TaskRecord {
    const task = this.get(id);
    task.detached = true;
    task.acknowledged = true;
    this.store.save(task);
    return task;
  }
  acknowledge(id: string): void {
    const task = this.get(id);
    task.acknowledged = true;
    this.store.save(task);
  }
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function summarizeTask(task: TaskRecord, now = Date.now()): Record<string, unknown> {
  const stale = !task.result && task.worker && now - task.worker.updatedAt > 15000;
  return {
    id: task.id, name: task.name, machine: task.endpoint.label,
    status: task.detached ? 'detached' : task.result?.status ?? (task.connectionError ? 'unreachable' : stale ? 'unresponsive' : task.worker?.status ?? task.phase),
    cwd: task.cwd, workspace_id: task.workspaceId, tab_id: task.tabId, pane_id: task.paneId,
    cancel_requested: task.cancelRequested, setup_error: task.setupError, connection_error: task.connectionError,
    worker_dir: task.workerDir, session_file: task.result?.sessionFile ?? task.worker?.sessionFile,
    text: task.result?.text ?? task.worker?.text, error: task.result?.error,
  };
}
