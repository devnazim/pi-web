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

The published 2.13.5 package requires exact `1.0.2` peers for `pi-agent-core`, `pi-ai`, `pi-coding-agent`, and `pi-tui`, plus `typebox` at any version. This project now uses Pi `1.0.3`, which does not satisfy those declared peers. The isolated install deliberately omits peers and links this project's `1.0.3` packages to test runtime compatibility. It does not change the suite manifest or make a normal npm peer installation compatible.

The test checks the suite version, declared `1.0.2` peer requirements, installed `1.0.3` Pi versions, and shared peer paths before loading extensions. It rejects a suite with separate peer installations. It also prepends this project's `node_modules/.bin` to the child's PATH and checks that `pi` points to the CLI in the installed Pi package. A different global Pi version cannot satisfy the child check.

The test checks that all 26 published extension paths load without diagnostics, checks selected suite tools and RPC commands, stores `/agent SmokeAgent` state, and renders and closes the suite's `/agent` custom UI through a bridge socket. `/subagents` and `/usage` are TUI-only in this suite and are checked as absent in RPC mode.

The test also starts a real `SmokeChild` with the published `subagent_start` tool and waits for successful feedback with `subagent_wait`. Both Pi processes use a temporary `models.json` and a local OpenAI-compatible HTTP endpoint that returns `CHILD_SMOKE_DONE`. It checks the child's response and the endpoint request. The test creates and removes its own HOME, PI_CODING_AGENT_DIR, and PI_AGENT_SUITE_DIR under `/tmp`, restores PATH, closes the child through the bridge and shuts down the HTTP server. `PI_OFFLINE=1` prevents catalog requests. No real provider or credential file is used. Without `PI_WEB_SUITE_PATH`, `npm test` skips this smoke test and needs no package download or network for it. To check this default behavior, run `env -u PI_WEB_SUITE_PATH npm test`. TUI-only commands, editor insertion, and the footer remain outside this check.

## Release check

The [2.13.4](https://github.com/n-r-w/pi-agent-suite/releases/tag/v2.13.4) and [2.13.5](https://github.com/n-r-w/pi-agent-suite/releases/tag/v2.13.5) release notes link to changelogs only. The [changes since 2.13.3](https://github.com/n-r-w/pi-agent-suite/compare/v2.13.3...v2.13.5) add configurable child extension loading. Without a suite configuration, children now use normal extension discovery instead of `--no-extensions`; the suite still loads explicitly. The changes also add warnings for invalid agent definitions, keep the start of truncated tool output instead of the end, and update MCP connection handling and remote-image editor refresh. The published `package.json` requires exact Pi 1.0.2 peers.

As of 2026-10-05, npm and GitHub both list Pi [1.0.3](https://github.com/earendil-works/pi/releases/tag/v1.0.3) and Suite [2.13.5](https://github.com/n-r-w/pi-agent-suite/releases/tag/v2.13.5) as their latest releases. There is no newer Suite release to install.

Verified with the published 2.13.5 tarball and this project's Pi 1.0.3 packages. All 26 extensions loaded without diagnostics. The bridge command and custom UI checks passed. A real child using this project's Pi 1.0.3 CLI returned `CHILD_SMOKE_DONE` through the local provider, and the test observed one request to `/v1/chat/completions`. No application compatibility issue appeared in this isolated check, despite the suite's declared peer mismatch. It does not check normal peer installation, extra user-installed extensions, or the suite's new child extension modes. The extracted package stays under `/tmp`; remove `"$suite_root"` when it is no longer needed.

Pi 1.0.3 renames the Azure provider from `azure-openai-responses` to `azure`. Azure users must rename the provider key in `auth.json`, `models.json`, and settings such as `defaultProvider`, `enabledModels`, and `modelThinkingLevels`, or sign in again where applicable. `AZURE_OPENAI_*` environment variables are unchanged. Resuming an old Azure session can select another model and lose prompt-cache reuse. This dependency update does not edit user settings or credentials.
