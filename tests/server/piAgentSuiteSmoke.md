# Published suite smoke test

Run these commands from the pi-web root. They download the published package and install its runtime dependencies under `/tmp`, not in pi-web:

```sh
suite_root=$(mktemp -d /tmp/pi-web-suite-package.XXXXXX)
npm pack pi-agent-suite@2.13.0 --pack-destination "$suite_root" --cache /tmp/pi-web-suite-npm-cache
tar -xzf "$suite_root/pi-agent-suite-2.13.0.tgz" -C "$suite_root"
suite="$suite_root/package"
npm install --prefix "$suite" --omit=peer --legacy-peer-deps --ignore-scripts --no-audit --no-fund --cache /tmp/pi-web-suite-npm-cache
mkdir -p "$suite/node_modules/@earendil-works"
for name in pi-agent-core pi-ai pi-coding-agent pi-tui; do
  ln -sfn "$PWD/node_modules/@earendil-works/$name" "$suite/node_modules/@earendil-works/$name"
done
ln -sfn "$PWD/node_modules/typebox" "$suite/node_modules/typebox"
PI_WEB_SUITE_PATH="$suite" node --import tsx --test tests/server/piAgentSuiteSmoke.test.ts
```

The symlinks make the published suite use this project's Pi 0.99.1 peers rather than installing the suite's exact 0.99.0 peers. The test checks that all 26 published extension paths load without diagnostics, checks selected suite tools and RPC commands, stores `/agent SmokeAgent` state, and renders and closes the suite's `/agent` custom UI through a bridge socket. `/subagents` and `/usage` are TUI-only in this suite and are checked as absent in RPC mode.

The test also starts a real `SmokeChild` with the published `subagent_start` tool and waits for successful feedback with `subagent_wait`. Both Pi processes use a temporary `models.json` and a local OpenAI-compatible HTTP endpoint that returns `CHILD_SMOKE_DONE`. It checks the child's response and the endpoint request. The test creates and removes its own HOME, PI_CODING_AGENT_DIR, and PI_AGENT_SUITE_DIR under `/tmp`, closes the child through the bridge and shuts down the HTTP server. `PI_OFFLINE=1` prevents catalog requests. No real provider or credential file is used. Without `PI_WEB_SUITE_PATH`, the test skips and needs no network. TUI-only commands, editor insertion, and the footer remain outside this check.
