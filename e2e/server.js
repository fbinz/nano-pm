const { spawn } = require('child_process');
const { mkdtemp, rm } = require('fs/promises');
const { tmpdir } = require('os');
const path = require('path');
const readline = require('readline');

const cwd = path.resolve(__dirname, '..');

async function startServer(env, { initialize = true } = {}) {
  const args = ['run', 'python', '-u', 'e2e/serve.py'];
  if (!initialize) args.push('--serve-only');
  const child = spawn('uv', args, {
    cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const append = chunk => { logs = (logs + chunk).slice(-64000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  const closed = new Promise(resolve => child.once('close', resolve));
  const signal = name => {
    if (!child.pid) return;
    try {
      if (process.platform === 'win32') child.kill(name);
      else process.kill(-child.pid, name); // Stop uv AND its Python child.
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const onParentExit = () => signal('SIGTERM');
  process.once('exit', onParentExit);
  closed.then(() => process.removeListener('exit', onParentExit));
  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    signal('SIGTERM');
    let timer;
    try {
      await Promise.race([closed, new Promise(resolve => { timer = setTimeout(resolve, 3000); })]);
      signal('SIGKILL');
      await closed;
    } finally { clearTimeout(timer); }
  }
  const lines = readline.createInterface({ input: child.stdout });
  let timer;
  try {
    const url = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Django startup timed out:\n${logs}`)), 60000);
      child.once('error', reject);
      child.once('exit', (code, signal) => reject(new Error(`Django exited (${code ?? signal}):\n${logs}`)));
      lines.on('line', line => {
        if (line.startsWith('NANO_E2E_READY ')) {
          try { resolve(JSON.parse(line.slice('NANO_E2E_READY '.length)).url); }
          catch (error) { reject(error); }
        }
      });
    });
    return { url, env, stop, logs: () => logs };
  } catch (error) {
    await stop();
    throw error;
  } finally {
    clearTimeout(timer);
    lines.close();
  }
}

async function startWorkerServer() {
  const directory = await mkdtemp(path.join(tmpdir(), 'nano-pm-e2e-'));
  const env = {
    ...process.env,
    DJANGO_SETTINGS_MODULE: 'config.settings_e2e',
    DJANGO_DEBUG: 'true',
    DJANGO_ALLOWED_HOSTS: 'localhost,127.0.0.1',
    DJANGO_ENABLE_TEST_RESET: 'true',
    DJANGO_ALLOW_INSECURE_SEED: 'true',
    DJANGO_DB_PATH: path.join(directory, 'worker.e2e.sqlite3'),
  };
  try {
    const server = await startServer(env);
    return {
      ...server,
      stop: async () => {
        try { await server.stop(); }
        finally { await rm(directory, { recursive: true, force: true }); }
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { startServer, startWorkerServer };
