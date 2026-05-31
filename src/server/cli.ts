#!/usr/bin/env node
import { networkInterfaces } from 'node:os';
import { buildApp } from './app.js';
import { isLocalHost, parseArgs } from './util.js';

const args = parseArgs(process.argv.slice(2));
const expose = Boolean(args.expose);
const host = String(args.host ?? (expose ? '0.0.0.0' : '127.0.0.1'));
const port = Number(args.port ?? process.env.PI_WEB_PORT ?? 43110);
const password = String(args.password ?? process.env.PI_WEB_PASSWORD ?? '') || undefined;
const workspace = typeof args.workspace === 'string' ? args.workspace : undefined;
const dev = Boolean(args.dev) || process.env.NODE_ENV === 'development';

try {
  const app = await buildApp({ host, port, password, workspace, expose, dev });
  await app.listen({ host, port });

  const urls = new Set<string>();
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

  console.log(dev ? '\npi-web API is running' : '\npi-web is running');
  console.log(`  Listening: ${host}:${port}`);
  console.log(`  Auth: ${password ? 'enabled' : 'disabled'}`);
  console.log(dev ? '  API:' : '  Open:');
  for (const url of urls) console.log(`    ${url}`);
  if (dev) {
    console.log('  Dev UI is served by Vite, usually on port 5173. Use npm run dev to start both.');
  }
  if (isLocalHost(host)) {
    console.log('  LAN access: disabled; use --host 0.0.0.0 or --expose to allow other devices.');
  }
  console.log('');

  if (!isLocalHost(host)) {
    app.log.warn(password
      ? 'Remote access is enabled. Use a strong password and prefer a private network/reverse proxy.'
      : 'Remote access is enabled without a password. pi-web can read/write files and run agent tools; prefer a private network or reverse proxy.');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
