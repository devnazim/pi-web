# pi-web app brief

Date: 2026-05-27

## Product goal

Build a public installable **pi web server**: a lightweight web UI for using the pi coding agent from desktop and mobile browsers without SSH or terminal access.

Primary use case:

- pi agent runs on a remote server.
- User connects from desktop or mobile browser.
- User manages projects/workspaces and sessions on that server.
- User uploads files/images/videos to the active workspace/session.
- User receives notifications when the agent finishes, needs approval/input, hits an error, or completes a long-running command.
- User reviews code changes with a VS Code/GitLens-like workflow.

## Core product model

```text
Project / Workspace
├─ Sessions
│  ├─ Chat view
│  ├─ Session tree view
│  └─ Review mode
├─ Files
├─ Git state
└─ Optional agents/personas
```

- **Project** maps naturally to a cwd/workspace on the server.
- **Session** maps to a pi JSONL session file.
- **Session tree** is first-class because pi sessions are trees, not only flat chats.
- **Review mode** is a full-screen code review workspace, not a chat split view.

## Chosen stack

### Backend

- Runtime: **Node.js**
- HTTP server: **Fastify**
- Pi integration: `@earendil-works/pi-coding-agent` SDK
- Streaming: WebSocket or SSE for agent events and live tool output
- APIs: REST/JSON endpoints for projects, sessions, files, Git, review data, settings, themes, uploads, notifications
- Security: local/remote auth and access control are required because the server can access files and run tools

### Frontend

- App: **SolidJS SPA**
- Build: **Vite**
- Styling: **Tailwind CSS**
- Server state: `@tanstack/solid-query`
- Virtualized lists/trees: `@tanstack/solid-virtual`
- Tables: `@tanstack/solid-table` only if needed
- Avoid TanStack Start for MVP; custom Fastify backend + Solid SPA fits long-running pi sessions and streaming better

### Editor/diff viewer

Decide during implementation:

- **CodeMirror 6**: lighter, more custom diff/review work
- **Monaco Editor**: heavier, best VS Code-like diff/editor behavior

Given the goal of a VS Code/GitLens-like review mode, Monaco may be worth using specifically for review/diff screens.

## Auth and remote access

Support an opencode-web-like protected remote access flow.

Requirements:

- Bind to localhost by default.
- Require explicit config to expose on LAN/public interfaces.
- Support password-based login.
- Use authenticated session cookie/token after login.
- Warn users before exposing publicly, because pi-web can read/write files and run agent tools.
- Later possible options: reverse-proxy auth, OAuth, Tailscale-only mode, one-time pairing links.

## Main UI modes

### Chat/session mode

Reference: opencode web style.

Desired layout:

- Left icon rail for projects/workspaces/global actions.
- Project sidebar with current project name/path.
- New session button.
- Session list with load-more pagination. Since Pi agent sessions are trees, this is a tree view.
- Main chat transcript with compact agent/tool summaries.
- Composer fixed near bottom.
- Top bar with project search and small actions.
- Optional agent/persona selector.

Composer:

- Real textarea/input, not only a custom canvas/editor.
- Attach/add button.
- Send button.
- Mode/model/thinking controls.
- Support image uploads and video uploads.
- Mobile upload flow should work from camera roll/files.

Tool/result summaries should be compact and expandable, e.g.:

### Review mode

Reference: VS Code Source Control + GitLens-like experience.

Important: review mode should use the **whole screen**. Do not keep the agent chat visible in review mode. Space should be dedicated to file review and diffs. User can return to the active agent/session through a sidebar/top-bar action or by clicking the session/agent.

Desired layout:

- Source Control style left panel.
- Commit message input and commit/stage actions.
- Changed files list with status badges (`M`, additions/deletions, file icons).
- GitLens-like sections for commits/history/graph.
- Main editor area with tabs.
- Side-by-side or inline diff viewer.
- Syntax highlighting.
- Line numbers.
- Minimap/scroll markers.
- Addition/removal highlights.
- File breadcrumb above editor.
- No persistent agent chat panel.

Review requirements:

- View files and changed files during agent work.
- View working-tree changes.
- View staged changes.
- Clearly show what was already staged before/during the session.
- Clearly show new unstaged changes created by the agent while it works.
- Compare staged changes vs new working-tree changes.
- Eventually stage/unstage files or hunks from the review UI.
- Later support blame/history/commit graph.

### Session tree mode

Pi sessions are JSONL trees with `id` / `parentId`. The web UI should show this as a folder/tree-like structure.

Example:

```text
Session Tree
├─ user: Add auth
│  └─ assistant: ...
│     ├─ user: Use JWT
│     │  └─ assistant: ...
│     └─ user: Use OAuth
│        └─ assistant: ...
```

Useful controls:

- Search across entry text/tool names/file paths.
- Filter modes: default, no-tools, user-only, labeled/bookmarked-only, all.
- Labels/bookmarks shown inline.
- Active leaf highlighted.
- Branches collapsible/expandable like folders.
- Selecting a user message should allow editing/resubmitting from that point.
- Selecting assistant/tool/summary entry should allow continuing from that point.
- Support fork/clone actions from selected entries.

## Pi sessions and integration notes

Pi sessions are stored as JSONL files under:

```text
~/.pi/agent/sessions/--<path>--/<timestamp>_<uuid>.jsonl
```

Each session has a header and entries with tree structure:

```ts
interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}
```

Relevant entry/message types:

- `message`
- `model_change`
- `thinking_level_change`
- `compaction`
- `branch_summary`
- `custom`
- `custom_message`
- `label`
- `session_info`

Pi SDK APIs to use:

- `createAgentSession()` for a single session.
- `createAgentSessionRuntime()` for session replacement flows.
- `SessionManager.list(cwd)` for project sessions.
- `SessionManager.listAll()` for all sessions/projects.
- `SessionManager.open(path)` for existing sessions.
- `SessionManager.create(cwd)` for new persistent sessions.
- `AgentSession.subscribe()` for streaming events.
- `AgentSession.prompt()`, `steer()`, `followUp()`, `abort()`.
- `AgentSession.navigateTree()` for in-place tree navigation.
- `runtime.newSession()`, `runtime.switchSession()`, `runtime.fork()` for session replacement.

RPC mode is available, but SDK is preferred for a Node.js pi-web server because it gives type-safe direct access to sessions, events, tools, and runtime state.

## Optional agents/personas

Pi core does not ship first-class built-in opencode-style agents. Pi is intentionally minimal, but supports agents/subagents through extensions.

Official reference example:

```text
examples/extensions/subagent/
```

The subagent example:

- registers a `subagent` tool
- loads agent definitions from markdown files
- runs separate pi subprocesses for isolated context
- supports single, parallel, and chained subagents
- supports per-agent model/tools/system prompt

Agent markdown format:

```md
---
name: reviewer
description: Reviews code for bugs and regressions
tools: read, grep, find, ls, bash
model: claude-sonnet-4-5
---

You are a strict code reviewer...
```

Agent locations:

```text
~/.pi/agent/agents/*.md
.pi/agents/*.md
```

pi-web should make agents **optional**:

- If no agents are found, use `Default Pi` only or hide selector.
- If agents/subagent definitions are discovered, show choices like `Default Pi`, `Scout`, `Planner`, `Reviewer`, `Worker`.
- Do not require users to install agents for normal usage.
- For production, prefer a web-native agent registry compatible with pi agent markdown format instead of depending directly on the example extension.

## Voice input

For MVP, use system/OS dictation instead of custom browser speech recognition.

Requirement:

- Composer must use a real textarea/input so dictation works naturally.

Supported through OS/browser text input:

- Mobile keyboard mic dictation.
- macOS Dictation.
- Windows `Win+H` voice typing.

Do not require Web Speech API for MVP. Optional in-app microphone transcription can be considered later.

## Attachments and uploads

- Support image uploads.
- Support video file uploads.
- Mobile upload flow should work from camera roll/files.
- Uploaded files should be associated with the active project/session or copied into a safe upload area inside the workspace/server storage.
- Images can be sent to pi when supported by selected model/provider.
- Video can initially be stored/attached as a file reference; later add extraction/transcription/summarization if needed.

## Notifications

pi-web should notify user for:

- agent finished
- approval needed
- user input needed
- command completed
- long-running task completed
- errors/failures
- review ready / changes detected

Implementation options:

- in-app notifications first
- browser notifications when permission granted
- mobile-friendly notification UX
- optional webhook/push integrations later

## Design direction

- Modern terminal-inspired look.
- Simple, focused, lightweight.
- Clean borders and muted surfaces.
- Monospace/code-friendly spacing.
- Command-palette feel.
- Mobile-friendly responsive layouts.

`shadcn/ui` is a good design reference for:

- component proportions
- borders and muted surfaces
- light/dark theme style
- accessible controls
- clean minimal UI patterns

Use shadcn as visual/design reference. Do not copy implementation directly unless intentionally choosing compatible components.

## Themes

Initial theme targets:

- Classic Light
- Classic Dark
- Catppuccin Latte
- Catppuccin Frappe
- Catppuccin Macchiato
- Catppuccin Mocha

Use CSS variables so themes can switch without rebuild.

## Reference projects and licenses

| Project | Repo/package checked | License | Notes |
|---|---|---|---|
| opencode | https://github.com/anomalyco/opencode | MIT | Good reference for web agent sessions/workspaces/streaming architecture. `sst/opencode` redirects here. |
| VS Code / Code OSS | https://github.com/microsoft/vscode | MIT | Good reference for editor layout, diff editor, file explorer, SCM UI. Avoid Microsoft branding/services assumptions. |
| Monaco Editor | https://github.com/microsoft/monaco-editor | MIT | Browser editor/diff editor; useful but heavier. |
| GitLens | https://github.com/gitkraken/vscode-gitlens | Mixed | MIT except directories named `plus`, which use GitLens Pro License. Use mainly as UX reference; avoid copying `plus/` code. |
| T3Code | https://github.com/pingdotgg/t3code | MIT | Useful reference for modern AI coding app UX. |
| pi coding agent | npm `@earendil-works/pi-coding-agent` | MIT | Main SDK/package for integration. |

License guidance:

- MIT references are permissive but keep copyright/license notices if copying/vendoring code.
- Prefer studying architecture/UX and writing original code.
- Do not reuse project names, logos, icons, or branding from opencode, VS Code, GitLens, or T3Code.
- Treat `microsoft/vscode` as Code OSS reference; Microsoft distributed VS Code includes separate branding/services.
- GitLens: root MIT license excludes `plus/` directories. Avoid copying from `plus/`.

## Recommended reference usage

- **opencode**: projects, sessions, web layout, agent streaming UX.
- **VS Code / Monaco**: editor/diff UX, tabs, source control panel, file explorer.
- **GitLens**: Git review/history/blame/graph UX ideas only; avoid Pro code.
- **T3Code**: modern AI coding product UX.
- **Pi subagent example**: optional agent/persona/subagent reference.

## MVP exclusions / avoid for now

- Do not use TanStack Start for MVP.
- Do not require browser Web Speech API for voice.
- Do not use Codex CLI/realtime audio; keep this as pi-web built on Pi SDK.
- Do not require agents/subagents for baseline usage.
- Do not keep chat visible in review mode; review gets the full screen.

## Suggested initial server/app shape

```text
pi-web
├─ server
│  ├─ auth
│  ├─ project manager
│  ├─ session manager
│  ├─ pi runtime/session bridge
│  ├─ streaming events
│  ├─ file/upload API
│  ├─ git/review API
│  ├─ notification bridge
│  └─ settings/themes
└─ web
   ├─ SolidJS app
   ├─ project/session layout
   ├─ chat transcript
   ├─ composer
   ├─ session tree
   ├─ review mode
   ├─ file explorer
   └─ theme system
```
