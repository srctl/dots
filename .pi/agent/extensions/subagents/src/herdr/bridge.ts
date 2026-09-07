// Standalone Pi extension copied to the selected host for one delegated task.
// Keep runtime imports to Node built-ins: remote Pi need not install this package.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';

export type WorkerStatus = 'ready' | 'running' | 'blocked' | 'done' | 'failed' | 'cancelled' | 'interrupted' | 'handed_off';
export interface WorkerState {
  id: string;
  status: WorkerStatus;
  updatedAt: number;
  sessionFile?: string;
  text?: string;
  error?: string;
}
export const terminalStatuses = new Set<WorkerStatus>(['done', 'failed', 'cancelled', 'interrupted', 'handed_off']);

export function registerBridge(pi: ExtensionAPI, dir: string): void {
  const task = JSON.parse(readFileSync(join(dir, 'task.json'), 'utf8')) as { id: string; prompt: string; name: string };
  const marker = `HERDR_TASK_${task.id}`;
  let state: WorkerState = { id: task.id, status: 'ready', updatedAt: Date.now() };
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastStop = '';
  let lastError: string | undefined;
  let cancelRequested = false;
  const atomic = (name: string, value: unknown) => {
    const file = join(dir, name);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(value), { mode: 0o600 });
    renameSync(temp, file);
  };
  const save = () => {
    state.updatedAt = Date.now();
    atomic('state.json', state);
  };
  const finish = (status: WorkerStatus, error?: string) => {
    if (terminalStatuses.has(state.status)) return;
    state.status = status;
    state.error = error;
    save();
    atomic('result.json', state);
  };
  const tick = async () => {
    if (!context || terminalStatuses.has(state.status)) return;
    if (!cancelRequested && existsSync(join(dir, 'cancel.json'))) {
      const control = JSON.parse(readFileSync(join(dir, 'cancel.json'), 'utf8'));
      if (control.id === task.id) {
        cancelRequested = true;
        if (state.status === 'ready' || context.isIdle()) finish('cancelled');
        else await context.abort();
      }
    }
    if (!terminalStatuses.has(state.status)) save();
  };
  pi.on('session_start', (_event, ctx) => {
    context = ctx;
    if (existsSync(join(dir, 'state.json'))) {
      state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
      if (!terminalStatuses.has(state.status) && state.status !== 'ready') {
        finish('interrupted', 'Worker reloaded or resumed. Task was not automatically replayed.');
      }
    }
    state.sessionFile = ctx.sessionManager.getSessionFile();
    pi.setSessionName(task.name);
    save();
    timer = setInterval(() => { void tick().catch((error) => {
      ctx.ui.notify(`Delegation bridge: ${String(error)}`, 'error');
    }); }, 1000);
    timer.unref();
  });
  pi.on('input', (event) => {
    if (event.text.trim() === marker) {
      if (state.status !== 'ready') return { action: 'handled' as const };
      if (existsSync(join(dir, 'cancel.json'))) {
        finish('cancelled');
        return { action: 'handled' as const };
      }
      state.status = 'running';
      save();
      return { action: 'transform' as const, text: task.prompt };
    }
    // Human input changes ownership; don't attribute their later answer to the task.
    if (!terminalStatuses.has(state.status)) finish('handed_off', 'Interactive input took over this child. Continue in its Herdr tab.');
    return { action: 'continue' as const };
  });
  pi.on('before_agent_start', (event) => ({
    systemPrompt: event.systemPrompt + '\n\nYou are a delegated Pi agent in a Herdr tab. Work only on the supplied task. Do not spawn further agents. Your final response is returned to the parent automatically. If blocked, explain what you need; do not bypass approvals.',
  }));
  pi.on('tool_call', (event) => {
    if (/^(subagent_|herdr_delegate|herdr_task)/.test(event.toolName)) {
      return { block: true, reason: 'Nested delegation is disabled in Herdr child agents.' };
    }
  });
  pi.on('message_end', (event) => {
    if (terminalStatuses.has(state.status) || state.status === 'ready' || event.message.role !== 'assistant') return;
    state.text = event.message.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    // Full output stays in the native session; bound state transfer over SSH.
    if (state.text.length > 128000) state.text = state.text.slice(0, 128000) + '\n[Truncated; see native session file.]';
    lastStop = event.message.stopReason;
    lastError = event.message.errorMessage;
    save();
  });
  // Unlike agent_end, this cannot report a transient auto-retry/compaction as done.
  pi.on('agent_settled', () => {
    if (state.status === 'ready' || terminalStatuses.has(state.status)) return;
    if (cancelRequested) finish('cancelled');
    else if (lastStop === 'aborted') finish('interrupted', lastError);
    else if (lastStop === 'error') finish('failed', lastError || 'Model request failed');
    else if (lastStop === 'stop') finish('done');
    else finish('failed', `Agent settled without a complete final response (${lastStop || 'no assistant message'}).`);
  });
  pi.on('session_shutdown', () => {
    if (timer) clearInterval(timer);
    context = undefined;
    finish('interrupted', 'Child session shut down; task was not automatically replayed.');
  });
}

export default function (pi: ExtensionAPI): void {
  const dir = process.env.PI_HERDR_TASK_DIR;
  if (!dir) throw new Error('PI_HERDR_TASK_DIR is required for the delegation bridge');
  registerBridge(pi, dir);
}
