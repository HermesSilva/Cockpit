# Tootega Cockpit for Claude Code

> A rich GUI for **Claude Code**, packaged as a native VS Code extension.
> The interface is **only a presentation and control layer over the Claude Code CLI** —
> all orchestration (the agent loop, tools, subagents, context, cache, compaction,
> permissions, MCP, hooks, skills) **lives in the CLI**. The extension renders the event
> stream the CLI emits and implements the client side of the interactive protocols.

| | |
|---|---|
| **Author** | Tootega Pesquisa e Inovação |
| **License** | MIT (open source) |
| **Type** | Visual Studio Code extension (React webview + TypeScript host) |
| **Extension version** | `1.0.99` |
| **Channel to the engine** | `claude` in headless/streaming mode (`stream-json`) |
| **Engine tested against** | Claude Code CLI **2.1.x** (screenshots show `2.1.177`) |
| **Languages** | pt-BR and international English (runtime switching) |

---

## Table of contents

- [Overview](#overview)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Install and configure the Claude Code CLI](#install-and-configure-the-claude-code-cli)
- [Install the extension](#install-the-extension)
- [Run in development (without installing)](#run-in-development-without-installing)
- [Build and packaging (.vsix)](#build-and-packaging-vsix)
- [Getting started](#getting-started)
- [Features](#features)
- [Cockpit-exclusive features](#cockpit-exclusive-features)
- [Models, effort, and sessions](#models-effort-and-sessions)
- [Plugins](#plugins)
- [Timeline verbosity](#timeline-verbosity)
- [Voice dictation](#voice-dictation)
- [Composer attachments](#composer-attachments)
- [Settings reference](#settings-reference)
- [Commands and keyboard shortcuts](#commands-and-keyboard-shortcuts)
- [Slash commands](#slash-commands)
- [Real account usage (statusline)](#real-account-usage-statusline)
- [Internationalization (i18n)](#internationalization-i18n)
- [Project structure](#project-structure)
- [Event stream and control protocol (developer deep-dive)](#event-stream-and-control-protocol-developer-deep-dive)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Non-goals](#non-goals)
- [Privacy and security](#privacy-and-security)
- [Contributing](#contributing)
- [License](#license)

---

## Overview

The Cockpit gives Claude Code users a complete GUI inside VS Code, focused on
**radical consumption transparency** and **fine-grained human control**:

- Chat with token-by-token streaming, *thinking* blocks, and a tool-call timeline.
- A meter for the **context window**, **cache** (hit-rate / read / write), **cost**, and
  **account limits** (5-hour and 7-day windows) always on screen.
- Permission approval, *plan mode*, composed questions (AskUserQuestion), and rendered
  diffs — all via the CLI's interactive protocol.
- A list of saved sessions (contexts) with resume, statistics, and deletion.
- A **model** and **effort** selector per session; runtime language switching.
- **Voice dictation** (speech-to-text) straight into the composer, with optional
  spelling/grammar correction — and other Cockpit-only differentiators (see
  [Cockpit-exclusive features](#cockpit-exclusive-features)).

It runs as an **editor tab** (resizable panel) and/or as a **view in the Activity Bar**
(the *Tootega Cockpit* container, view id `tootega.hub`).

| Main panel | Session statistics |
|---|---|
| ![Main panel](images/Main%20Panel.png) | ![Statistics](images/Session%20Statistics%20View.png) |

---

## Architecture

```
┌────────────────────────────┐        stream-json (stdout)         ┌──────────────────────────────┐
│   Claude Code CLI          │ ──────────────────────────────────▶ │  VS Code extension           │
│   (engine)                 │                                      │  ┌────────────────────────┐  │
│   - agent loop             │ ◀────────────────────────────────── │  │ Webview (React + Vite) │  │
│   - tools, subagents       │     input + responses (stdin)        │  │ chat · timeline · stats│  │
│   - todos, context, cache  │                                      │  └────────────────────────┘  │
│   - permissions, MCP, hooks│                                      │  ┌────────────────────────┐  │
└────────────────────────────┘                                      │  │ Extension host (TS)    │  │
                                                                    │  │ spawn · NDJSON parser  │  │
                                                                    │  └────────────────────────┘  │
                                                                    └──────────────────────────────┘
```

Primary channel with the engine — `claude` in headless/streaming mode. The actual command
the host spawns (see [`src/cli/CliProcessManager.ts`](src/cli/CliProcessManager.ts)):

```bash
claude -p \
  --output-format stream-json \
  --input-format stream-json \
  --include-partial-messages \
  --permission-prompt-tool stdio \
  --verbose \
  [--model <id>] [--effort <level>] [--permission-mode <mode>] [--resume <session_id>]
```

- `--output-format stream-json`: the CLI emits **one JSON object per line** (messages,
  `tool_use`, `tool_result`, `usage`, `control_request`, etc.).
- `--input-format stream-json`: lets the host send messages and control responses via
  stdin during the session.
- `--include-partial-messages`: enables token-by-token streaming (`stream_event`).
- `--permission-prompt-tool stdio`: routes permission decisions through the control
  protocol; without it, headless mode silently denies tools. This is also how
  **AskUserQuestion** reaches the UI.
- Resumable sessions via `--resume <session_id>`.

The stream parser ([`src/cli/StreamParser.ts`](src/cli/StreamParser.ts)) is
**version-tolerant**: unknown events are ignored without breaking the UI.

> **Architecture decision:** the channel is the **CLI**, not the Anthropic API / Agent SDK
> directly. This keeps automatic parity with the official engine (auth, billing,
> subscription limits, new features) without reimplementing anything.

---

## Prerequisites

| Requirement | Version | Note |
|---|---|---|
| VS Code | ≥ 1.90 | `engines.vscode` in the manifest |
| Node.js | ≥ 20 | Needed only for build/dev |
| Claude Code CLI | recent | `claude` on the `PATH`, **authenticated** |
| Git | any | Recommended for checkpoints (planned) |

Tested against Claude CLI **2.1.x** (the screenshots show `2.1.177`). The parser is
tolerant, but the event contract can vary between versions — see
[Known limitations](#known-limitations).

On **Windows**, `claude` is typically a `.cmd` shim. Node 22+ refuses to execute it
without a shell (CVE-2024-27980 mitigation), so the host spawns it with `shell: true`.
If the CLI was installed by the **native installer** into `~/.local/bin` (which is not
always on the `PATH` on Windows), the host probes that location automatically and uses the
first `claude` that answers `--version`.

---

## Install and configure the Claude Code CLI

The Cockpit **does not replace** the CLI — it pilots it. Install and authenticate the CLI
first.

1. **Install** Claude Code (follow Anthropic's official documentation for your OS).
2. **Verify** it is on the PATH:
   ```bash
   claude --version
   ```
3. **Authenticate** (once), by subscription or API key:
   ```bash
   claude            # starts an interactive session; log in when prompted
   # or, inside the Cockpit: the "Tootega: Sign in to Claude (CLI)" command
   ```
4. *(Optional)* Adjust CLI defaults in `~/.claude/settings.json` — for example
   `effortLevel`. The Cockpit honors these defaults when you leave the selector on
   *"CLI default"*.

If `claude` is not on the PATH, set the full path in **Settings → `tootega.claudePath`**.
On activation, if the CLI is missing, the extension offers to help.

---

## Install the extension

**From a `.vsix`** (recommended while there is no Marketplace publication):

```bash
code --install-extension tootega-cockpit-<version>.vsix
```

Or via the UI: *Extensions → ⋯ → Install from VSIX…*

To **build** the `.vsix`, see [Build and packaging](#build-and-packaging-vsix).

---

## Run in development (without installing)

Opens VS Code in an **Extension Development Host**, loading the extension straight from
source — nothing is installed permanently.

**Windows (PowerShell):**

```powershell
./run-dev.ps1
./run-dev.ps1 -OpenPath "C:\path\to\project"   # open pointing at a project
./run-dev.ps1 -Watch                           # recompile on save
```

**Windows (cmd):**

```bat
run-dev.cmd
run-dev.cmd C:\path\to\project
```

**Via VS Code:** open this folder and press `F5` (the *Run extension (dev)* configuration
in [`.vscode/launch.json`](.vscode/launch.json)).

In the test window, open the Cockpit with **Ctrl+Alt+C**, the **Cockpit** item in the
status bar, or the palette (`Ctrl+Shift+P` → *"Tootega: Open Cockpit"*).

---

## Build and packaging (.vsix)

```bash
npm install
npm run build        # compiles host + webview into dist/ (esbuild)
npm run typecheck    # type-checks both tsconfigs (host + webview)
npm test             # unit tests (Vitest)
npm run package      # bump patch + build + produce the .vsix (requires @vscode/vsce)
```

Available scripts ([`package.json`](package.json)):

| Script | Does |
|---|---|
| `build` | `node esbuild.mjs` — bundles `extension.js` + `webview/main.js` + CSS |
| `watch` | build in watch mode |
| `typecheck` | `tsc --noEmit` over both tsconfigs (host and webview) |
| `test` / `test:watch` | Vitest |
| `vscode:prepublish` | production build (`esbuild.mjs --production`) |
| `package` | `npm version patch` → build → `vsce package` |
| `vsix` | typecheck → bump → build → `vsce package` |

On Windows there are also `package-vsix.ps1` / `package-vsix.cmd` as shortcuts.
Build output lands in `dist/` (`extension.js`, `webview/main.js`, `webview/main.css`).
Packaging boundaries are controlled by [`.vscodeignore`](.vscodeignore) — only `dist/`,
`l10n/`, `media/`, `package.nls*.json`, `LICENSE`, and `README.md` ship in the `.vsix`.

---

## Getting started

1. Open a project folder in VS Code.
2. Open the Cockpit (Ctrl+Alt+C).
3. Confirm at the top: name, version, and the detected **Claude CLI version**.
4. If a login warning appears, use **Sign in**.
5. Choose **Model**, **Effort**, and **Permission** (or keep the defaults).
6. Type in the composer and send (**Enter** sends, **Shift+Enter** inserts a line break).

With `tootega.autoResumeLastSession` enabled (the default), opening the folder
automatically resumes the most recent session for that directory.

---

## Features

> Status legend: **✅ implemented** · **🟡 base/partial** · **⏳ planned**.
> The full requirements and priority catalog lives in [`CLAUDE.md`](CLAUDE.md) and
> [`Docs/`](Docs/).

### Conversation and agent core

| Feature | Status | How to use | Limitations |
|---|---|---|---|
| Token-by-token streaming chat | ✅ | Type and send; the answer appears incrementally | — |
| *Thinking* blocks with toggle | ✅ | Expand in the chat; default controlled by `tootega.showThinking` | Only appears if the model/effort emits thinking |
| Tool-call timeline (expandable cards) | ✅ | Click a card for input/output; default via `tootega.expandToolCards` | Inline diff in the editor not yet (rendered in the webview) |
| Interrupt the agent (Stop) | ✅ | **Stop** button or **Ctrl+Alt+.** | Stops by ending the CLI process; it respawns on the next send |
| Session history: list, resume, rename | ✅ | **Saved contexts** drawer; click to resume; **rename** button on the context card (updates the open webview title) | Advanced search partial |
| **Rewind** from a prompt | ✅ | Rewind button on a prompt — truncates the transcript at that point and re-arms `--resume` | Restores the conversation, not the files on disk (Git checkpoints still planned) |
| **Elapsed time** per turn | ✅ | Shown live on the gauge and again at the end of the turn | — |
| Subagents (parallel threads) | 🟡 | Rendered when the CLI emits them | A dedicated parallel view is planned |
| Message queue (follow-ups) | ⏳ | — | — |

**Rendered diff** (an edit expanded in the timeline):

![Expanded edit](images/Expanded%20Element%20View.png)

### Editing, diff, and human control

| Feature | Status | How to use | Limitations |
|---|---|---|---|
| Permission approval (Allow / Always / Deny) | ✅ | Per-tool modal with preview (Bash, Write, WebFetch, JSON); **Ctrl+Enter** = allow, **Esc** = deny | — |
| Permission modes (HITL ↔ auto) | ✅ | **Permission** dropdown (`default`, `plan`, `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`) | `bypassPermissions` disables approvals — use with care |
| **Plan mode** (view and approve a plan) | ✅ | `ExitPlanMode` arrives as a permission; **Approve and execute** / **Keep planning** | Editing the plan before approving is planned |
| Composed questions (AskUserQuestion) | ✅ | Modal with tabs per question, option cards, `multiSelect`, and an **Other** option (free text) | — |
| Side-by-side diff in the native editor | ⏳ | — | Today the diff is rendered in the webview |
| Accept/reject per file and per hunk | ⏳ | — | — |
| Agent Todos panel | 🟡 | The **Tasks** tab shows the live task list | Depends on the CLI emitting todos |

**Permission / composed question and the recorded answer:**

| Question (multi-select) | Recorded answer |
|---|---|
| ![Question](images/Question%20View.png) | ![Answer](images/Question%20Response.png) |

**Tasks (Todos) panel:**

![Tasks](images/Tasks%20View.png)

### Checkpoints and recovery

| Feature | Status | Note |
|---|---|---|
| Automatic checkpoint before large changes | ⏳ | Planned (Git) |
| Rewind from any message | 🟡 | Truncates the transcript and re-arms `--resume` (conversation rewind); file restore via Git still planned |
| Restore Files / Files Only / Files & Task | ⏳ | — |

### Statistics, context, cache, and consumption *(the heart of the product)*

| Feature | Status | How to use | Limitations |
|---|---|---|---|
| **Context window** meter (used / remaining / limit) | ✅ | Bar at the top, with color bands; 200K or 1M limit | Limit auto-derived from the active model |
| **Cache**: hit-rate, read, write | ✅ | **Cache** block in the panel | — |
| **Cost** per turn and session | 🟡 | Cost block ("estimated" label) | Estimate, not the official invoice |
| Tokens in / out / cache-create / cache-read | ✅/🟡 | **Tokens** block | Full breakdown partial |
| **Subscription limits** (5h and 7d, % used) | ✅ | Meters in the panel, fed by the real OAuth `/usage` API (same source as `/usage`) | Statusline complements it during low usage — see [statusline](#real-account-usage-statusline) |
| **Turn timing** segmented by (model, effort, type) | ✅ | Sample counts per segment; debounced flush with a cross-process lock (atomic merge) | — |
| Context-near-limit alert | ✅ | Automatic warning above ~85% | — |
| Context **breakdown** via `/context` | ⏳ | — | UI ready, data source pending |
| Historical consumption charts | ⏳ | — | — |
| Active model / effort / mode | ✅ | Dropdowns in the panel + status bar | — |

**Detailed session statistics (tooltip/hint):**

![Session hint](images/Session%20Hint%20View.png)

### Extensibility (surfacing what the CLI exposes)

| Feature | Status | Note |
|---|---|---|
| Slash commands (built-in + custom) with autocomplete | ✅/🟡 | Curated catalog (context, session, config, tools, account, info); the CLI exposes only names via `sessionInit`, descriptions are curated |
| **Plugins manager** (browse / install / remove / enable / disable / update + marketplaces) | ✅ | 🧩 **Plugins** in the Hub — see [Plugins](#plugins) |
| Skills: list / trigger | 🟡 | Via slash commands when exposed |
| Custom subagents: list / select | ⏳ | — |
| MCP servers: status / tools / connect | 🟡 | `/mcp` forwarded to the CLI |
| Hooks: view configured ones | 🟡 | `/hooks` forwarded to the CLI |
| `CLAUDE.md` / settings editor | ⏳ | — |

### Presentation and accessibility

| Feature | Status |
|---|---|
| Theme synced with VS Code (light/dark/high-contrast via `var(--vscode-*)`) | ✅ |
| Rich Markdown + syntax highlighting (highlight.js) | ✅ |
| Keyboard shortcuts | ✅ |
| **Bilingual i18n** pt-BR + English, runtime switching | ✅ |
| Configurable UI density | ⏳ |

### Prompt history

Browse previous prompts and the session stream directly in the panel:

![Prompt history](images/Prompt%20History%20View.png)

### Delete session

Deleting a session removes the transcript from disk — an **irreversible action**, guarded
by a confirmation:

![Delete session](images/Delete%20Session%20View.png)

---

## Cockpit-exclusive features

Differentiators that go **beyond surfacing the CLI** — the Cockpit's own value layer. Most
rely on a deliberately narrow exception to the "CLI-only" rule: a handful of **clean,
isolated** calls authenticated with the local Claude.ai OAuth token
(`~/.claude/.credentials.json`). These are **not** the agent loop — they send only what the
task needs (instruction + text), with **no** agent system prompt, tools, MCP, or project
context, and **never** write or log credentials.

| Feature | What it does | Channel |
|---|---|---|
| 🎙️ **Voice dictation** (speech-to-text) | Dictate straight into the composer — see [Voice dictation](#voice-dictation) | OAuth STT WebSocket (same service as the CLI's `/voice`); **no** token spend |
| ✍️ **Dictation correction** | Optional spelling/grammar pass after you stop dictating; a clean one-shot (instruction + text only, ~1.7 s) | Anthropic Messages API with the internal model (`tootega.internalModel`, default Haiku) |
| 🧠 **Internal AI utility helper** ([`AiClient`](src/cli/AiClient.ts)) | Shared, clean one-shot helper for the Cockpit's own utility calls (dictation correction, slash-command research). Avoids the CLI one-shot's ~5 s cold start + full system prompt/tools | Anthropic Messages API (OAuth), isolated |
| 🏷️ **Slash-command auto-research** ([`SlashCommandResearch`](src/cli/SlashCommandResearch.ts)) | Categorizes/labels **unknown** slash commands (category, short hint, detail) in the UI language; results cached globally in `~/.claude/tootega/` so each command is researched only once | Internal AI helper |
| 🧩 **Plugins manager** ([`PluginManager`](src/cli/PluginManager.ts)) | Browse/install/remove/enable/disable/update plugins + marketplaces; canonical URL and kind badge per plugin resolved once by the internal helper and cached — see [Plugins](#plugins) | CLI (`claude plugin …`) + internal AI helper for URL/kind |
| 🎚️ **Timeline verbosity** | Display-only filter (verbose / necessary / dialogo / quiet) that collapses tool noise — see [Timeline verbosity](#timeline-verbosity) | Local |
| 🚦 **Minimum-effort gate** ([`RepoDirectives`](src/session/RepoDirectives.ts)) | A folder can pin a minimum reasoning effort via a `CLAUDE.md` tag (`<!-- **enffort=max** -->`); on send, if the selected effort is below the folder's floor the Cockpit asks to confirm | Local (reads `CLAUDE.md`) |
| ⏪ **Prompt rewind** | Rewind to an earlier prompt: truncates the transcript and re-arms `--resume` | Local |
| ✏️ **Rename context** | Rename a saved session from its card; updates the open webview title | Local |
| ⏱️ **Per-turn elapsed time** | Live on the gauge and again at the end of each turn | Local |
| 📊 **Real account usage** | 5h / 7d meters fed by the real OAuth `/usage` API (no manual budgets) | OAuth `/usage`; **no** token spend |
| 🪟 **Statusline real-usage wrapper** | Reversible wrapper that caches `rate_limits` / `context_window` and re-invokes your original statusline — see [statusline](#real-account-usage-statusline) | Local (Windows) |

> **Why the exception is safe:** these calls are *clean and isolated* and sit outside agent
> orchestration. The agent loop, billing parity, and subscription limits stay 100% on the
> CLI. The OAuth token is **read-only**; `/usage` and STT spend **no** tokens, and the
> dictation correction spends only *minimal* subscription tokens (instruction + text). See
> [`CLAUDE.md`](CLAUDE.md) §6 for the recorded decision.

---

## Models, effort, and sessions

- **Model** and **Effort** are *session overrides* (they do not change global settings);
  switching restarts the CLI session.
- **Layered model discovery** (the CLI does not list models):
  1. always-valid aliases (`default` / `opus` / `sonnet` / `haiku`);
  2. the **active model** captured live from the `init` event (exact id/variant, e.g.
     `claude-opus-4-8[1m]`);
  3. **`/v1/models`** when an API credential is present (`tootega.apiKey` or
     `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN`);
  4. a **Custom…** field for any id (the CLI validates on spawn).
- **Subscription** accounts (no API key) use (1) + (2) + (4).
- The manifest ships a curated **Versions** list (e.g. `claude-opus-4-8[1m]`,
  `claude-sonnet-4-6[1m]`, `claude-haiku-4-5`, `claude-fable-5`) as the fallback when
  `/v1/models` is not reachable.
- **Effort** is a fixed CLI enum: `low / medium / high / xhigh / max`.

---

## Plugins

A full **plugins manager** ([`src/cli/PluginManager.ts`](src/cli/PluginManager.ts),
[`PluginsModal`](webview/src/components/PluginsModal.tsx)), opened from the 🧩 **Plugins**
entry in the Hub. Everything goes through the official CLI (`claude plugin …`) — the Cockpit
only surfaces it:

- **List** installed + available plugins (across configured marketplaces) and filter by
  **All / Installed / Available**; search by name; sort exposes install counts.
- **Actions:** install (with scope), uninstall, enable, disable, update.
- **Marketplaces:** add (URL, `owner/repo`, or local path) and remove.
- **Enrichment:** each plugin shows a **kind** badge (skills · agents · commands · MCP ·
  hooks · mixed) and a canonical **URL**. The kind of *installed* plugins is computed
  precisely from local components; URL + kind for the rest are resolved once by the internal
  AI helper (Haiku) and **cached** in `~/.claude/tootega/plugin-urls.json` (**Refresh** can
  force re-validation). Best-effort — failure keeps the derived values.

---

## Timeline verbosity

`tootega.verbosity` controls **how much of the timeline is shown — display only; it does not
change the agent or what the CLI does.** Modes:

| Mode | Shows |
|---|---|
| `verbose` (default) | Everything (as before) |
| `necessary` | Only edits and final explanations |
| `dialogo` | Only edits and what it's doing |
| `quiet` | Only final explanations |

In non-verbose modes the progress bar collapses several hidden tool calls into a single
turn/edit segment instead of one card per tool.

---

## Voice dictation

Dictate prompts straight into the composer. The **mic button** in the composer bar starts
and stops capture.

- **Transcription** runs over the OAuth **speech-to-text WebSocket**
  (`/api/ws/speech_to_text/voice_stream`) — the same service the CLI's `/voice` uses
  (`deepgram-nova3`, live interim results, endpointing). It spends **no** tokens.
- **Mic capture happens on the host** via **ffmpeg** (the webview blocks `getUserMedia`).
  Point `tootega.ffmpegPath` at your ffmpeg binary, or leave it empty to use `ffmpeg` from
  the `PATH`.
- **Optional correction:** with `tootega.voiceCorrect` on, when you stop, the text is sent
  to the **internal model** (`tootega.internalModel`, default Haiku) for a quick
  spelling/grammar pass — a clean, isolated one-shot (instruction + text only, ~1.7 s).
- **Language:** `tootega.voiceLanguage` sets the dictation language; empty follows the
  Cockpit UI language.
- **UX:** the input gets focus when dictation starts; on stop it goes read-only with a
  spinner while correcting; typing ends the dictation.

> Voice features use the OAuth exception (clean, isolated calls) — see
> [Cockpit-exclusive features](#cockpit-exclusive-features).

---

## Composer attachments

- **Paste image** (screenshot/bitmap without a path): attached as a base64 image block in
  the `user` message (`{type:'image',source:{type:'base64',media_type,data}}`); preview
  chips in the composer and thumbnails in the bubble.
- **Paste file** (with a path): inserts the **address** into the text — **relative** to the
  context cwd if inside it, otherwise **absolute** (resolved on the host with
  `path.relative`). The path comes from `File.path` (Electron) or `text/uri-list`
  (`file://…`) as a fallback.

---

## Settings reference

All under **Settings → Extensions → Tootega Cockpit** (prefix `tootega.`):

| Key | Type | Default | Description |
|---|---|---|---|
| `claudePath` | string | `claude` | Path to the Claude Code CLI executable |
| `language` | enum | `auto` | UI: `auto` (follows VS Code) / `pt-BR` / `en` |
| `model` | enum | `default` | Default model for new sessions; reflected in the panel dropdown |
| `effort` | enum | `default` | Default effort (`low`…`max`); `default` uses the CLI's `effortLevel` |
| `apiKey` | string | `""` | Optional API key, **only** to list models via `/v1/models`; never used in chat |
| `autoResumeLastSession` | boolean | `true` | On opening the folder, resume the most recent session for that directory |
| `permissionMode` | enum | `default` | Permission mode forwarded to the CLI; reflected in the dropdown |
| `notifyOnComplete` | boolean | `true` | Notify when the agent finishes and the panel is not visible |
| `showThinking` | boolean | `false` | Expand *thinking* blocks by default |
| `verbosity` | enum | `verbose` | Timeline display level — `verbose` / `necessary` / `dialogo` / `quiet` (display only; see [Timeline verbosity](#timeline-verbosity)) |
| `expandToolCards` | boolean | `false` | Expand tool cards by default in the timeline |
| `userName` | string | `""` | Name shown on your messages; empty = OS user |
| `internalModel` | enum | `claude-haiku-4-5` | Model for the Cockpit's internal AI calls (dictation correction, slash-command research) — clean, isolated calls; Haiku is fastest/cheapest |
| `voiceCorrect` | boolean | `true` | After stopping dictation, run a spelling/grammar pass with the internal model (clean one-shot) |
| `voiceLanguage` | string | `""` | Dictation language (speech-to-text); empty follows the UI language |
| `ffmpegPath` | string | `""` | Path to ffmpeg used for voice capture; empty = `ffmpeg` from PATH |

> The 5h / 7d meters now read **real** account usage via the OAuth `/usage` API
> (same source as the CLI's `/usage`), so no manual budgets are needed. The context
> meter limit is auto-derived from the active model (1M for `[1m]` variants, else 200K).

![Settings](images/Settings%20View.png)

---

## Commands and keyboard shortcuts

Commands (palette, **Tootega** category):

| Command | ID | Shortcut |
|---|---|---|
| Open Cockpit | `tootega.open` | **Ctrl+Alt+C** (mac: Cmd+Alt+C) |
| New session | `tootega.newSession` | **Ctrl+Alt+N** (in the panel) |
| Interrupt agent | `tootega.interrupt` | **Ctrl+Alt+.** |
| Sessions | `tootega.openSessions` | — |
| Settings | `tootega.settings` | — |
| Open in editor (resizable) | `tootega.openInEditor` | — |
| Sign in / Sign out to Claude (CLI) | `tootega.login` / `tootega.logout` | — |
| Toggle language (pt-BR / English) | `tootega.toggleLanguage` | — |
| Enable / Disable real usage tracking | `tootega.enableUsageTracking` / `...disableUsageTracking` | — |

In the composer: **Enter** sends · **Shift+Enter** new line · the **/** button opens the
slash-command menu · the **▾** button opens options.

URI handler: `vscode://tootega.tootega-cockpit/open` opens the Cockpit.

---

## Slash commands

Slash commands are surfaced from the CLI (which exposes only their **names** via
`sessionInit`); the Cockpit adds curated categories and descriptions
([`webview/src/slashCatalog.ts`](webview/src/slashCatalog.ts)). Commands **outside** the
curated catalog are auto-researched by the internal AI helper
([`SlashCommandResearch`](src/cli/SlashCommandResearch.ts)) — category, short hint, and
detail in the UI language, cached globally in `~/.claude/tootega/` so each one is researched
only once. Third-party plugin commands group under **Plugin**; anything still unresolved
falls under **Other**.

| Category | Commands |
|---|---|
| Session | `resume` |
| Context | `clear`, `compact`, `context`, `memory` |
| Config | `model`, `config`, `permissions` |
| Tools | `review`, `init`, `mcp`, `agents`, `hooks` |
| Account | `login`, `logout` |
| Info | `cost`, `usage`, `status`, `help`, `doctor` |
| Plugin | third-party plugin commands (auto-grouped) |
| Other | anything still unresolved after auto-research |

---

## Real account usage (statusline)

The 5h / 7d meters need real `rate_limits` data. The automatic channel
(`rate_limit_event` in the stream) already works; the **statusline** complements it during
low usage.

The **Enable real usage tracking** command installs a statusline *wrapper* that:

1. writes `rate_limits` and `context_window` to `~/.claude/.tootega-usage.json`;
2. **re-invokes your original statusline** (preserving, e.g., badges like the caveman one).

It is **reversible** (*Disable real usage tracking*). On first activation the extension
also offers it once via a notification. Today it is **Windows-only** (PowerShell). After
enabling, run an interactive `claude` session once to populate the cache.

> If editing `~/.claude/settings.json` fails (e.g. it contains comments), the extension
> warns you to edit it manually.

---

## Internationalization (i18n)

- **Every** visible string goes through i18n — no hardcoded text.
- Locales: **pt-BR** and **en** (international English, neutral).
- Default: follows `vscode.env.language`; falls back to `en` when the locale is not
  supported. Manual override in `tootega.language`. **Runtime switching** (no extension
  reload).
- Catalogs:
  - **Manifest:** `package.nls.json` (en base) + `package.nls.pt-br.json`.
  - **Host (runtime):** `l10n/bundle.l10n.json` + `l10n/bundle.l10n.pt-br.json`
    (`vscode.l10n`).
  - **Webview:** `webview/src/i18n/en.ts` + `pt-br.ts`, with `{0}` interpolation.

---

## Project structure

```
src/                  Extension host (TypeScript)
  extension.ts        Activation, commands, config listeners, URI handler, status bar
  cli/                Spawn, stream-json parser, model discovery, statusline, settings
  panel/              ChatViewProvider (host ↔ webview bridge; editor panel + hub view)
  session/            Session store (~/.claude/projects), usage aggregation
  stats/              Context/cache/cost/tokens aggregator
  i18n/               Host i18n
  util/               Logger
webview/              UI in React + Vite
  src/components/     Composer, Timeline, DiffView, modals, Todos, etc.
  src/i18n/           en / pt-BR catalogs
  src/store.ts        Webview state
  src/slashCatalog.ts Curated slash-command metadata
shared/               Event contract and host ↔ webview protocol
l10n/                 Runtime strings (vscode.l10n)
media/                Icons
package.nls*.json     Manifest strings
test/                 Vitest unit tests (StreamParser)
Docs/                 Planning, comparison with the official GUI, status
images/               Screenshots used in this README
```

Communication:
- **Webview ↔ host:** `postMessage` / `acquireVsCodeApi()` (protocol in
  [`shared/protocol.ts`](shared/protocol.ts)).
- **Host ↔ engine:** `child_process` (spawning `claude`) + NDJSON parser
  ([`shared/events.ts`](shared/events.ts)).

---

## Event stream and control protocol (developer deep-dive)

The host spawns `claude` once per session and speaks **stream-json** over stdin/stdout. The
parser ([`src/cli/StreamParser.ts`](src/cli/StreamParser.ts)) splits NDJSON and tolerates
noise; unknown event types are dropped rather than crashing the UI.

**Outbound (host → CLI)**, written one JSON object per line:

- Right after spawn, a control handshake enables interactive routing and returns the slash
  command list:
  ```json
  {"type":"control_request","request_id":"init","request":{"subtype":"initialize"}}
  ```
- A user turn:
  ```json
  {"type":"user","message":{"role":"user","content":[{"type":"text","text":"…"}]}}
  ```
  Pasted images add `{"type":"image","source":{"type":"base64","media_type":"…","data":"…"}}`
  blocks to `content`.
- A permission decision (reply to `can_use_tool`):
  ```json
  {"type":"control_response","response":{"subtype":"success","request_id":"…","response":{…}}}
  ```
  `allow` requires `updatedInput` (the CLI validates with Zod — replying just
  `{behavior:"allow"}` fails the union). "Always allow" returns `updatedPermissions` from
  the CLI's `permission_suggestions`. Deny sends `{behavior:"deny", message}`.

**Inbound (CLI → host)** event types the UI consumes: `system` (incl. `init` with the
active model), `assistant` / `user` messages, `result`, `stream_event` (partial tokens),
and `control_request` (`can_use_tool`, which carries both tool-permission prompts and
**AskUserQuestion**).

**Interrupt** ends the CLI process; on Windows (`shell: true`) the host uses
`taskkill /T` to kill the whole tree so the orphaned `node` child does not keep running.
The process respawns on the next send. **Resume** re-arms `--resume <session_id>` and
replays the transcript read from `~/.claude/projects/<encoded-cwd>/<id>.jsonl` (the cwd is
encoded by mapping `:` `\` `/` → `-`).

---

## Troubleshooting

| Symptom | Likely cause | Action |
|---|---|---|
| "CLI not found" on activation | `claude` not on the PATH | Set `tootega.claudePath`; confirm `claude --version` |
| Chat does not respond / auth error | CLI not authenticated | Run **Sign in** or `claude` in a terminal and log in |
| Model selector shows only aliases | Subscription account (no API key) | Expected — use an alias, the active model, or **Custom…** |
| 5h/7d meters empty | No real usage source | Enable **Real usage tracking** and run a `claude` session |
| Statusline does not update | `settings.json` has comments | Edit `~/.claude/settings.json` manually |
| New events do not render | The CLI version changed the contract | The parser ignores unknown ones; open an issue with the CLI version |
| Changed model/effort and the session restarted | Expected behavior (overrides restart) | — |

Host logs: *Output → Tootega Cockpit*.

---

## Known limitations

- **Inline diff in the native editor**, **editing a plan before approving**,
  **Git checkpoints / file-restore**, and the **context breakdown via `/context`** are still
  planned. **Rewind** today restores the *conversation* (transcript truncation + `--resume`),
  not the files on disk.
- **Cost** is an estimate ("estimated" label), not Anthropic's official invoice.
- **Statusline** real-usage wrapper is **Windows-only** for now (the OAuth `/usage` meters
  themselves are cross-platform); **voice capture** needs **ffmpeg** on the host.
- The **event contract** is not yet frozen against real fixtures of a target `claude`
  version; version changes may affect parts of the rendering (the parser degrades
  gracefully, ignoring unknown events).
- **Slash-command** categories/descriptions are curated, then auto-researched by the
  internal AI helper for anything outside the catalog (the CLI exposes only names).

See the detailed status in
[`Docs/status-implementacao.en.md`](Docs/status-implementacao.en.md).

---

## Non-goals

- Do not compete with the official extension at 1:1 parity — the differentiator is
  **consumption transparency and fine-grained control**.
- Do not talk to the Anthropic API directly **for the agent loop** — that channel is the
  **CLI**. The only exception is a few **clean, isolated** utility calls with the local OAuth
  token (real usage, voice STT, dictation correction); see
  [Cockpit-exclusive features](#cockpit-exclusive-features) and [`CLAUDE.md`](CLAUDE.md) §6.
- Do not implement our own billing — the account and limits are the user's subscription.
- Do not store user data off their machine.

---

## Privacy and security

- Credential content is **never** logged.
- The CLI's permission model is honored; approvals are not bypassed by the UI.
- The optional `apiKey` is used **only** to list models (`/v1/models`), never in chat.
- The local OAuth token (`~/.claude/.credentials.json`) is read **read-only** for the clean
  utility calls (real usage, voice STT, dictation correction); it is **never** written or
  logged, and those calls carry no agent context.
- Session data lives locally in `~/.claude/` (transcripts) — nothing leaves the machine.

---

## Contributing

- **Code/identifiers in English**; comments and repository documentation in **pt-BR**.
- Follow the neighboring file's pattern (naming, comment density, language).
- **Do not reimplement the engine.** If you are tempted to replicate orchestration, stop
  and surface what the CLI already does.
- Every visible string goes through i18n.
- Before a PR: `npm run typecheck && npm test && npm run build`.

Related documents: [`CLAUDE.md`](CLAUDE.md) ·
[`Docs/plano-de-execucao.en.md`](Docs/plano-de-execucao.en.md) ·
[`Docs/comparacao-gui-oficial.en.md`](Docs/comparacao-gui-oficial.en.md) ·
[`Docs/status-implementacao.en.md`](Docs/status-implementacao.en.md).

---

## License

© Tootega Pesquisa e Inovação — MIT License (see [`LICENSE`](LICENSE)).
