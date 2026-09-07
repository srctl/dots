import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

export interface MachineProfile {
  id: string;
  label: string;
  target: string;
  session: string;
  enabled: boolean;
}
export type Endpoint =
  | { kind: 'local'; label: 'local'; socket: string; binary: string }
  | { kind: 'ssh'; label: string; profileId: string; target: string; session: string };

export function resolveMachine(profiles: MachineProfile[], selector: string): Endpoint {
  const byId = profiles.filter((p) => p.id === selector);
  const matches = byId.length ? byId : profiles.filter((p) => p.label === selector);
  if (matches.length !== 1) throw new Error(`Machine ${JSON.stringify(selector)} is missing or ambiguous; use a saved profile ID.`);
  const profile = matches[0]!;
  if (!profile.enabled) throw new Error(`Machine ${profile.label} is disabled. Enable it explicitly in Herdr first.`);
  if (!profile.target || profile.target.startsWith('-') || /[\s\x00-\x1f]/.test(profile.target)) {
    throw new Error('Unsafe or unsupported SSH target in saved machine profile');
  }
  if (!profile.session) throw new Error('Saved machine must have an explicit session');
  return { kind: 'ssh', label: profile.label, profileId: profile.id, target: profile.target, session: profile.session };
}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export function hostCommand(endpoint: Endpoint, source: string): { command: string; args: string[] } {
  if (endpoint.kind === 'local') return { command: process.execPath, args: ['-e', source] };
  // No agent forwarding, host-key acceptance, password prompts, or raw shell targets.
  return {
    command: 'ssh',
    args: ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ForwardAgent=no',
      '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=2',
      '--', endpoint.target, `PATH="$HOME/.local/bin:$PATH" node -e ${shellQuote(source)}`],
  };
}

export class HostError extends Error {
  readonly code?: string;
  constructor(message: string, code?: string) { super(message); this.code = code; }
}

export interface HostTransport {
  call<T>(endpoint: Endpoint, request: Record<string, unknown>, signal?: AbortSignal): Promise<T>;
}

export class Transport implements HostTransport {
  private readonly source = readFileSync(new URL('./host.cjs', import.meta.url), 'utf8');
  async call<T>(endpoint: Endpoint, request: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const { command, args } = hostCommand(endpoint, this.source);
    const payload = {
      ...request,
      ...(endpoint.kind === 'local' ? { socket: endpoint.socket, binary: endpoint.binary } : { session: endpoint.session }),
    };
    return new Promise<T>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      let settled = false;
      const finish = (error?: Error, value?: T) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value as T);
      };
      const abort = () => {
        child.kill('SIGKILL');
        finish(new Error('Transport interrupted; a submitted operation may still have executed. Inspect the existing task; do not respawn blindly.'));
      };
      const timer = setTimeout(abort, 55000);
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      child.stdout.on('data', (data: Buffer) => {
        stdout += data.toString();
        if (Buffer.byteLength(stdout) > 2 * 1024 * 1024) {
          child.kill('SIGKILL');
          finish(new Error('Host response exceeded 2 MiB'));
        }
      });
      child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString()).slice(-4000); });
      child.on('error', (error) => finish(error));
      child.stdin.on('error', (error) => finish(error));
      child.on('close', (code) => {
        if (settled) return;
        try {
          const response = JSON.parse(stdout);
          if (code !== 0 || !response.ok) throw new HostError(response.error || stderr || `Host exited ${code}`, response.errorCode);
          finish(undefined, response.value as T);
        } catch (error) {
          finish(new HostError(`Herdr ${endpoint.label}: ${stderr || (error instanceof Error ? error.message : String(error))}`, error instanceof HostError ? error.code : undefined));
        }
      });
      child.stdin.end(JSON.stringify(payload));
    });
  }
}
