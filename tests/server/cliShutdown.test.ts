import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';

async function waitUntil(check: () => boolean, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}

test('SIGINT exits after graceful shutdown even when an extension leaves a referenced handle', async () => {
  const child = spawn(process.execPath, [
    '--import',
    'tsx',
    '--import',
    'data:text/javascript,setInterval(()=>{},60000)',
    path.resolve('src/server/cli.ts'),
    '--host',
    '127.0.0.1',
    '--port',
    '0',
    '--log',
    'silent',
  ], {
    cwd: process.cwd(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += String(chunk); });
  child.stderr.on('data', (chunk) => { output += String(chunk); });

  try {
    assert.equal(await waitUntil(() => output.includes('pi-web is running') || child.exitCode !== null, 5_000), true, output);
    assert.equal(child.exitCode, null, output);
    child.kill('SIGINT');
    assert.equal(await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 3_000), true, output);
    assert.equal(child.exitCode, 0, output);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await waitUntil(() => child.exitCode !== null || child.signalCode !== null, 1_000);
  }
});
