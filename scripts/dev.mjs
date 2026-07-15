#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import { networkInterfaces } from 'node:os';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const keyValue = arg.slice(2);
    const equalsIndex = keyValue.indexOf('=');
    if (equalsIndex !== -1) {
      out[keyValue.slice(0, equalsIndex)] = keyValue.slice(equalsIndex + 1);
      continue;
    }
    const key = keyValue;
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) {
      out[key] = true;
    } else {
      out[key] = next;
      i += 1;
    }
  }
  return out;
}

function urlsForHost(host, port) {
  const urls = new Set();
  if (host === '0.0.0.0' || host === '::') {
    urls.add(`http://127.0.0.1:${port}`);
    for (const interfaces of Object.values(networkInterfaces())) {
      for (const address of interfaces ?? []) {
        if (address.internal) continue;
        if (address.family === 'IPv4') urls.add(`http://${address.address}:${port}`);
        if (address.family === 'IPv6') urls.add(`http://[${address.address}]:${port}`);
      }
    }
  } else if (host.includes(':') && host !== 'localhost') {
    urls.add(`http://[${host}]:${port}`);
  } else {
    urls.add(`http://${host}:${port}`);
  }
  return [...urls];
}

function normalizeBasePath(value) {
  if (value === undefined || value === null || value === '') return '/';
  if (typeof value !== 'string') throw new Error('Base path must be a string, such as /pi-web.');

  let next = value.trim();

  try {
    next = new URL(next, 'http://pi-web.local').pathname;
  } catch {
    // Keep the original value and normalize it below.
  }

  next = next.replace(/\/+$/, '');
  if (!next || next === '.') return '/';
  return next.startsWith('/') ? next : `/${next}`;
}

function urlWithBasePath(url, basePath) {
  return basePath === '/' ? url : `${url}${basePath}`;
}

const args = parseArgs(process.argv.slice(2));
const expose = Boolean(args.expose);
const host = String(args.host ?? (expose ? '0.0.0.0' : '127.0.0.1'));
const serverPort = Number(args.port ?? process.env.PI_WEB_PORT ?? 43110);
const webPort = Number(args.webPort ?? process.env.PI_WEB_DEV_PORT ?? 5173);
const basePath = normalizeBasePath(args['base-path'] ?? args.basePath ?? process.env.PI_WEB_BASE_PATH);
const allowedHosts = args['allowed-hosts'] ?? args.allowedHosts ?? args['allowed-host'] ?? args.allowedHost ?? process.env.PI_WEB_ALLOWED_HOSTS;
const env = {
  ...process.env,
  PI_WEB_PORT: String(serverPort),
  PI_WEB_BASE_PATH: basePath,
  ...(typeof allowedHosts === 'string' && allowedHosts ? { PI_WEB_ALLOWED_HOSTS: allowedHosts } : {}),
};

const detached = process.platform !== 'win32';
const children = [
  spawn('tsx', ['watch', 'src/server/cli.ts', '--dev', ...process.argv.slice(2)], {
    env,
    stdio: 'inherit',
    detached,
  }),
  spawn('vite', ['--host', host, '--port', String(webPort)], {
    env,
    stdio: 'inherit',
    detached,
  }),
];

console.log('\npi-web dev mode');
console.log(`  API: ${host}:${serverPort}`);
console.log(`  Web: ${host}:${webPort}`);
console.log(`  Base path: ${basePath}`);
console.log('  Open:');
for (const url of urlsForHost(host, webPort)) console.log(`    ${urlWithBasePath(url, basePath)}`);
console.log('');

const configuredShutdownTimeout = Number(process.env.PI_WEB_DEV_SHUTDOWN_TIMEOUT_MS);
const configuredServerShutdownTimeout = Number(process.env.PI_WEB_SHUTDOWN_TIMEOUT_MS);
const serverShutdownTimeoutMs = Number.isFinite(configuredServerShutdownTimeout) && configuredServerShutdownTimeout > 0 ? configuredServerShutdownTimeout : 10_000;
const shutdownTimeoutMs = Number.isFinite(configuredShutdownTimeout) && configuredShutdownTimeout > 0 ? configuredShutdownTimeout : serverShutdownTimeoutMs + 6_000;
const childProcessSessionIds = new Set(detached ? children.flatMap((child) => child.pid ? [child.pid] : []) : []);
const processGroupSweepTimer = detached ? setInterval(() => {
  for (const sessionId of childProcessSessionIds) {
    if (!processGroupExists(sessionId) && !processGroupsForSessions([sessionId]).length) childProcessSessionIds.delete(sessionId);
  }
}, 1_000) : undefined;
processGroupSweepTimer?.unref();
let stopping = false;

function childRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

function processGroupsForSessions(sessionIds) {
  if (!detached || !sessionIds.length) return [];
  const targets = new Set(sessionIds);
  const result = spawnSync('ps', ['-eo', 'pgid=,sid='], { encoding: 'utf8', timeout: 1_000 });
  if (result.error || result.status !== 0) return [];
  const processGroups = new Set();
  for (const line of result.stdout.split('\n')) {
    const [processGroupId, sessionId] = line.trim().split(/\s+/).map(Number);
    if (processGroupId > 0 && targets.has(sessionId)) processGroups.add(processGroupId);
  }
  return [...processGroups];
}

function processGroupExists(processGroupId) {
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function signalProcessGroup(processGroupId, signal) {
  try { process.kill(-processGroupId, signal); } catch { /* Process group already exited. */ }
}

function signalChild(child, signal) {
  if (!childRunning(child)) return;
  try { child.kill(signal); } catch { /* Child already exited. */ }
}

async function waitForChildren(processGroupIds, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const groupsRunning = detached && processGroupIds.some(processGroupExists);
    const childrenRunning = !detached && children.some(childRunning);
    if (!groupsRunning && !childrenRunning) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  if (processGroupSweepTimer) clearInterval(processGroupSweepTimer);
  const processSessionIds = [...childProcessSessionIds];
  const processGroupIds = [...new Set([...processSessionIds, ...processGroupsForSessions(processSessionIds)])];
  for (const processGroupId of processGroupIds) signalProcessGroup(processGroupId, 'SIGTERM');
  if (!detached) for (const child of children) signalChild(child, 'SIGTERM');
  await waitForChildren(processGroupIds, shutdownTimeoutMs);
  const remainingProcessGroupIds = [...new Set([...processGroupIds, ...processGroupsForSessions(processSessionIds)])];
  for (const processGroupId of remainingProcessGroupIds) if (processGroupExists(processGroupId)) signalProcessGroup(processGroupId, 'SIGKILL');
  if (!detached) for (const child of children) signalChild(child, 'SIGKILL');
  await waitForChildren(remainingProcessGroupIds, 1_000);
  process.exit(code);
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (stopping || code === 0 || signal === 'SIGTERM') return;
    void stop(code ?? 1);
  });
}

process.on('SIGINT', () => void stop(0));
process.on('SIGTERM', () => void stop(0));
