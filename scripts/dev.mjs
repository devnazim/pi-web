#!/usr/bin/env node
import { spawn } from 'node:child_process';
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

const args = parseArgs(process.argv.slice(2));
const expose = Boolean(args.expose);
const host = String(args.host ?? (expose ? '0.0.0.0' : '127.0.0.1'));
const serverPort = Number(args.port ?? process.env.PI_WEB_PORT ?? 43110);
const webPort = Number(args.webPort ?? process.env.PI_WEB_DEV_PORT ?? 5173);
const env = {
  ...process.env,
  PI_WEB_PORT: String(serverPort),
};

const children = [
  spawn('tsx', ['watch', 'src/server/cli.ts', '--dev', ...process.argv.slice(2)], {
    env,
    stdio: 'inherit',
  }),
  spawn('vite', ['--host', host, '--port', String(webPort)], {
    env,
    stdio: 'inherit',
  }),
];

console.log('\npi-web dev mode');
console.log(`  API: ${host}:${serverPort}`);
console.log(`  Web: ${host}:${webPort}`);
console.log('  Open:');
for (const url of urlsForHost(host, webPort)) console.log(`    ${url}`);
console.log('');

let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exit(code);
}

for (const child of children) {
  child.on('exit', (code, signal) => {
    if (stopping) return;
    if (code === 0 || signal === 'SIGTERM') return;
    stop(code ?? 1);
  });
}

process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
