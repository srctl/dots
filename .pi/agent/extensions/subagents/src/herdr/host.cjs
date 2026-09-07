// Executed by Node locally or over SSH. JSON stdin keeps task text out of argv.
// No dependencies; compatible with Node 18 on remote machines.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');

function main(request) {
  const home = os.homedir();
  const fallback = path.join(home, '.local/bin/herdr');
  const binary = request.binary || (fs.existsSync(fallback) ? fallback : 'herdr');
  const env = { ...process.env };
  // Never let a remote helper inherit the parent's local socket context.
  if (request.session) {
    delete env.HERDR_SOCKET_PATH;
    delete env.HERDR_SESSION;
  } else if (request.socket) env.HERDR_SOCKET_PATH = request.socket;
  const herdr = (args) => {
    const output = cp.execFileSync(binary, [
      ...(request.session ? ['--session', request.session] : []), ...args,
    ], { env, encoding: 'utf8', timeout: 45000, maxBuffer: 2 * 1024 * 1024 });
    const response = JSON.parse(output);
    if (response.error) throw new Error(JSON.stringify(response.error));
    return response.result;
  };
  if (request.op === 'herdr') return herdr(request.args);
  if (request.op === 'profiles') {
    return JSON.parse(cp.execFileSync(binary, ['machine', 'list', '--json'], {
      env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024,
    }));
  }
  if (request.op === 'probe') {
    if (!path.isAbsolute(request.cwd) || !fs.statSync(request.cwd).isDirectory()) {
      throw new Error('working_dir must be an existing absolute directory on the target machine');
    }
    const piVersion = cp.execFileSync('pi', ['--version'], {
      env, encoding: 'utf8', timeout: 15000,
    }).trim();
    return { home, piVersion, cwd: fs.realpathSync(request.cwd), workspaces: herdr(['workspace', 'list']).workspaces };
  }
  if (!/^[a-f0-9]{32}$/.test(request.id || '')) throw new Error('Invalid task ID');
  const root = path.join(home, '.pi/agent/herdr-delegation/workers');
  const dir = path.join(root, request.id);
  const read = (name) => {
    try { return JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  };
  const atomic = (name, value) => {
    const file = path.join(dir, name);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  if (request.op === 'prepare') {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    // Exclusive creation: never overwrite a running worker or another payload.
    fs.mkdirSync(dir, { mode: 0o700 });
    fs.writeFileSync(path.join(dir, 'bridge.ts'), request.bridge, { mode: 0o600, flag: 'wx' });
    atomic('task.json', request.task);
    return { dir };
  }
  if (request.op === 'read') {
    const result = read('result.json');
    let agent;
    // Herdr supplies blocking-UI detection on older Pi versions without UI hooks.
    if (!result && request.paneId) {
      try { agent = herdr(['agent', 'get', request.paneId]).agent; }
      catch { /* Missing/replaced pane is not proof of task completion. */ }
    }
    return { state: read('state.json'), result, agent };
  }
  if (request.op === 'cancel') {
    atomic('cancel.json', { id: request.id });
    return { requested: true };
  }
  throw new Error('Unknown host operation');
}

try {
  process.stdout.write(JSON.stringify({ ok: true, value: main(JSON.parse(fs.readFileSync(0, 'utf8'))) }));
} catch (error) {
  let errorCode;
  try { errorCode = JSON.parse(String(error.stderr)).error.code; } catch { /* Not a Herdr API error. */ }
  process.stdout.write(JSON.stringify({ ok: false, errorCode, error: String(error.message || error).slice(0, 4000) }));
  process.exitCode = 1;
}
