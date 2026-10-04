# Published suite smoke test

Run these commands from the pi-web root. They download the published package and install its runtime dependencies under `/tmp`, not in pi-web:

```sh
suite_root=$(mktemp -d /tmp/pi-web-suite-package.XXXXXX)
npm pack pi-agent-suite@2.13.5 --pack-destination "$suite_root" --cache /tmp/pi-web-suite-npm-cache
tar -xzf "$suite_root/pi-agent-suite-2.13.5.tgz" -C "$suite_root"
suite="$suite_root/package"
npm install --prefix "$suite" --omit=peer --legacy-peer-deps --ignore-scripts --no-audit --no-fund --cache /tmp/pi-web-suite-npm-cache
mkdir -p "$suite/node_modules/@earendil-works"
for name in pi-agent-core pi-ai pi-coding-agent pi-tui; do
  ln -sfn "$PWD/node_modules/@earendil-works/$name" "$suite/node_modules/@earendil-works/$name"
done
ln -sfn "$PWD/node_modules/typebox" "$suite/node_modules/typebox"
PI_WEB_SUITE_PATH="$suite" node --import tsx --test tests/server/piAgentSuiteSmoke.test.ts
```

The published 2.13.5 package requires exact `1.0.2` peers for `pi-agent-core`, `pi-ai`, `pi-coding-agent`, and `pi-tui`, plus `typebox` at any version. The symlinks make the suite and its child use this project's installed peers. The test checks the suite version, Pi peer requirements, installed Pi versions, and shared peer paths before it loads extensions. It rejects a suite with separate peer installations.

The test checks that all 26 published extension paths load without diagnostics, checks selected suite tools and RPC commands, stores `/agent SmokeAgent` state, and renders and closes the suite's `/agent` custom UI through a bridge socket. `/subagents` and `/usage` are TUI-only in this suite and are checked as absent in RPC mode.

The test also starts a real `SmokeChild` with the published `subagent_start` tool and waits for successful feedback with `subagent_wait`. Both Pi processes use a temporary `models.json` and a local OpenAI-compatible HTTP endpoint that returns `CHILD_SMOKE_DONE`. It checks the child's response and the endpoint request. The test creates and removes its own HOME, PI_CODING_AGENT_DIR, and PI_AGENT_SUITE_DIR under `/tmp`, closes the child through the bridge and shuts down the HTTP server. `PI_OFFLINE=1` prevents catalog requests. No real provider or credential file is used. Without `PI_WEB_SUITE_PATH`, `npm test` skips this smoke test and needs no package download or network for it. To check this default behavior, run `env -u PI_WEB_SUITE_PATH npm test`. TUI-only commands, editor insertion, and the footer remain outside this check.

## Release check

The [2.13.4](https://github.com/n-r-w/pi-agent-suite/releases/tag/v2.13.4) and [2.13.5](https://github.com/n-r-w/pi-agent-suite/releases/tag/v2.13.5) release notes link to changelogs only. The [changes since 2.13.3](https://github.com/n-r-w/pi-agent-suite/compare/v2.13.3...v2.13.5) add configurable child extension loading. Without a suite configuration, children now use normal extension discovery instead of `--no-extensions`; the suite still loads explicitly. The changes also add warnings for invalid agent definitions, keep the start of truncated tool output instead of the end, and update MCP connection handling and remote-image editor refresh. The published `package.json` requires exact Pi 1.0.2 peers.

Verified with the published 2.13.5 tarball and this project's Pi 1.0.2 peers. All 26 extensions loaded without diagnostics. The bridge command and custom UI checks passed. A real child returned `CHILD_SMOKE_DONE` through the local provider, and the test observed one request to `/v1/chat/completions`. No application compatibility issue appeared in this isolated check. It does not check extra user-installed extensions or the suite's new child extension modes. The extracted package stays under `/tmp`; remove `"$suite_root"` when it is no longer needed.
