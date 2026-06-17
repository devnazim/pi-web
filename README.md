# pi-web

A lightweight Fastify + SolidJS web UI for using the `@earendil-works/pi-coding-agent` from desktop and mobile browsers.

## Goals

- Run Pi on a remote workstation/server and connect from a browser.
- Manage workspaces/projects and Pi session JSONL trees.
- Upload images/videos/files into the active workspace/session.
- Review working-tree and staged changes in a full-screen VS Code/GitLens-style review mode.
- Keep remote access protected by default.

## Development

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:5173>. The dev server proxies API/WebSocket traffic to Fastify on port `43110`.

Dev mode accepts the same server args, plus `--webPort` for Vite:

```bash
npm run dev -- --host 0.0.0.0 --port 43110 --webPort 5173
```

In dev mode, open the Vite URL (`5173` by default), not the API server port.

## Keyboard shortcuts

Pi Web includes configurable keyboard shortcuts under **Settings → Shortcuts**. Defaults use `Ctrl+.` as a chord prefix: press `Ctrl+.` then `1`-`9` to switch projects/workspaces, `[` / `]` to move to the previous/next project or workspace, and `T` to toggle light/dark theme. Theme mode shortcuts are also available by default: `Ctrl+.` then `S` for system, `L` for light, and `D` for dark.

To serve dev mode from a reverse-proxy subpath, pass `--base-path`:

```bash
npm run dev -- --base-path /pi-web-development
```

## Logging

`pi-web` defaults to quiet server logging: it prints the startup URLs plus warnings/errors, but not every HTTP/WebSocket request. Use `--log verbose` when you need request logs, `--log debug` for debug logs, or `--log silent` to disable Fastify logs entirely. The same setting is available as `PI_WEB_LOG`; `--quiet`, `--verbose`, `--debug`, and `--silent` are shorthands.

```bash
pi-web --log verbose
PI_WEB_LOG=silent pi-web
```

## Build and run

```bash
npm run build
npm start
# optionally seed a project explicitly:
npm start -- --workspace /path/to/project
```

## Remote access

The server binds to localhost by default. To expose it on your LAN/public interface, provide an explicit host. A password is strongly recommended:

```bash
PI_WEB_PASSWORD='use-a-strong-password' pi-web --host 0.0.0.0 --port 43110
# optionally seed a project explicitly:
PI_WEB_PASSWORD='use-a-strong-password' pi-web --host 0.0.0.0 --port 43110 --workspace /srv/project
```

`pi-web` can read/write workspace files and run Pi tools. If you expose it without `--password`/`PI_WEB_PASSWORD`, the server will warn but still start. Prefer a private network, Tailscale, or a trusted reverse proxy.

### Reverse proxy / Tailscale subpaths

By default, `pi-web` serves from `/`. Use `--base-path` or `PI_WEB_BASE_PATH` only when a reverse proxy maps a path prefix to this server:

```bash
pi-web --base-path /pi-web
```

For Tailscale Serve, map the external path to the same backend path:

```bash
tailscale serve --bg --set-path /pi-web http://127.0.0.1:43110/pi-web
```

Then open:

```text
https://your-device.your-tailnet.ts.net/pi-web
```

For dev mode behind Tailscale:

```bash
npm run dev -- --base-path /pi-web-development
tailscale serve --bg --set-path /pi-web-development http://127.0.0.1:5173/pi-web-development
```

Vite dev mode allows `*.ts.net` hosts by default. For other reverse-proxy hostnames, set `PI_WEB_ALLOWED_HOSTS=example.com,dev.example.com`.

### Platform file-safety note

Workspace file operations use file-descriptor-backed path checks on Linux when available. Other platforms fall back to `realpath`/`stat` validation, so symlink race protection is best-effort rather than equivalent to the Linux fd-backed path. File saves use a no-overwrite temp/backup flow and require hard-link support. Folder rename uses safe no-replace semantics on Linux when the trusted system `mv` path is available and best-effort no-overwrite checks elsewhere.

## Current MVP surface

- Password login/cookie auth.
- Project registry starts empty unless `--workspace` is provided; the browser restores previously opened projects.
- Pi session listing/parsing from `~/.pi/agent/sessions`.
- Chat shell with upload-aware composer and Pi SDK prompt bridge.
- Session tree view from JSONL `id`/`parentId` entries.
- Git status, diff, log, stage/unstage, and commit endpoints.
- Full-screen review UI; chat is hidden in review mode.
- Theme variables for Classic and Catppuccin-style themes.

See [APP.md](./APP.md) for the product brief.
