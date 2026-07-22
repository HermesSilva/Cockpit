# CLAUDE.md — Project Directives

> Directives file read by Claude Code (and any agent) when working in this repository.
> Defines scope, architecture principles, conventions, and the feature catalog.

---

## 1. Product identity

| Field | Value |
|-------|-------|
| **Working name** | Tootega Cockpit for Claude Code *(working name — to be confirmed)* |
| **Authorship / Maintainer** | **Tootega Pesquisa e Inovação** |
| **Type** | Native **Visual Studio Code** extension (GUI) |
| **License** | **MIT** (open source) |
| **Nature** | Interface/tool that operates **through the Claude Code CLI** — it does not reimplement the agent |
| **Audience** | Developers who use Claude Code and want a rich GUI, consumption transparency, and fine-grained control |
| **Languages** | **Bilingual, mandatory**: pt-BR and **international English** (neutral, no US/UK regionalisms) |

### Founding principle

This UI is **only a presentation and control layer**. All orchestration — the agent loop, tool execution, subagents, todos, context management, compaction, permissions, MCP, hooks, skills — **lives in the Claude Code CLI**. The extension:

1. **Renders** the event stream the CLI emits.
2. **Captures** user input and implements the client side of the interactive protocols (permission approval, plan mode, answering questions).
3. **Never** reimplements the engine logic. If something about orchestration needs to change, that is the CLI's problem, not ours.

---

## 2. Architecture (summary)

```
┌────────────────────────────┐         stream-json (stdout)        ┌──────────────────────────────┐
│   Claude Code CLI          │ ──────────────────────────────────▶ │  VSCode Extension            │
│   (engine)                 │                                      │                              │
│   - agent loop             │ ◀────────────────────────────────── │  ┌────────────────────────┐  │
│   - tools, subagents       │      input + responses (stdin)       │  │ Webview (React)        │  │
│   - todos, context, cache  │                                      │  │ - chat / timeline      │  │
│   - permissions, MCP, hooks│                                      │  │ - stats panel          │  │
└────────────────────────────┘                                      │  │ - diff / checkpoints   │  │
                                                                    │  └────────────────────────┘  │
                                                                    │  ┌────────────────────────┐  │
                                                                    │  │ Extension host (TS)    │  │
                                                                    │  │ - process spawn        │  │
                                                                    │  │ - stream-json parser   │  │
                                                                    │  │ - native VSCode APIs   │  │
                                                                    │  └────────────────────────┘  │
                                                                    └──────────────────────────────┘
```

**Primary channel with the engine:** `claude` in headless/streaming mode:

```
claude -p --output-format stream-json --input-format stream-json --verbose
```

- `--output-format stream-json`: the CLI emits one JSON event per line (messages, tool_use, tool_result, usage, etc.).
- `--input-format stream-json`: allows sending messages and responses via stdin during the session.
- Resumable sessions via `--resume <session_id>` / `--continue`.

**Complementary data sources** (statistics/account), described in the execution plan:
- **Statusline** hook (JSON with `model`, `context_window`, `cost`, `rate_limits` — current format: `limits[]` with `kind` = `session` | `weekly_all` | `weekly_scoped` and `scope.model.display_name`; legacy `five_hour`/`seven_day`/`seven_day_<model>` still parsed as a fallback).
- `/usage`, `/context`, `/cost` commands (or their programmatic equivalents).
- Session/transcript files in `~/.claude/`.

> **Recorded architecture decision:** the channel is the **CLI**, not the Anthropic API/Agent SDK directly. This keeps automatic parity with the official engine (auth, billing, subscription limits, new features) without reimplementing anything.

---

## 3. Technical stack (target)

| Layer | Technology |
|--------|-----------|
| Extension (host) | TypeScript, VS Code Extension API |
| UI (webview) | React + Vite, CSS with VSCode theme tokens (`var(--vscode-*)`) |
| Webview ↔ host communication | `postMessage` / `acquireVsCodeApi()` |
| Host ↔ engine communication | `child_process` (spawning `claude`), NDJSON parser |
| Diffs | Native VSCode diff API + custom webview rendering when needed |
| Testing | Vitest (unit), `@vscode/test-electron` (integration) |
| Packaging | `vsce` / `ovsx` (Open VSX for forks) |

---

## 4. Feature catalog

**Origin** legend: `Claude GUI` = official Claude Code extension · `CLI` = engine capability to surface in the UI · `Cline` / `Roo·Kilo` / `Windsurf·Cascade` = feature seen in other agents that is worth incorporating · `Tootega` = our own differentiator.
**Prio** legend: `P0` MVP · `P1` essential post-MVP · `P2` differentiator.

### 4.1. Conversation and agent core

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| C1 | Chat with token-by-token streaming | Claude GUI | P0 |
| C2 | Render thinking blocks with toggle | CLI | P1 |
| C3 | Tool-call timeline (cards per tool, collapsible input/output) | Claude GUI | P0 |
| C4 | @-mention of files, folders, symbols | Claude GUI | P0 |
| C5 | Attach images / paste screenshot into the prompt | Claude GUI | P1 |
| C6 | Interrupt the agent at any time (stop) | CLI | P0 |
| C7 | Message queue (send follow-ups without waiting for a response) | Cline | P1 |
| C8 | Session history: list, resume, search, rename | CLI | P0 |
| C9 | Sort/filter sessions by date, **cost**, **tokens** | Cline | P2 |
| C10 | Subagents: view parallel threads and their progress | CLI | P1 |

### 4.2. Editing, diff, and human control

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| E1 | Side-by-side inline diff before writing | Claude GUI | P0 |
| E2 | Accept/reject change per file and per hunk | Roo·Kilo | P1 |
| E3 | Permission approval (Allow/Deny + Allow-always) | CLI | P0 |
| E4 | HITL mode vs. Agent-first mode (configurable auto-approve) | Roo·Kilo | P1 |
| E5 | Tool and command allowlist/denylist per session/project | Roo·Kilo / CLI | P1 |
| E6 | Plan mode: view, **edit**, and approve the plan before executing | Claude GUI | P0 |
| E7 | Plan preview with numbered steps and per-step approval | Windsurf·Cascade | P2 |
| E8 | Agent Todos panel (live list, status per item) | CLI | P1 |

### 4.3. Checkpoints and recovery

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| K1 | Automatic checkpoint before large changes | Claude GUI / Cline | P0 |
| K2 | Rewind from any message | Claude GUI | P1 |
| K3 | Restore modes: **Restore Files** · **Restore Files Only** · **Restore Files & Task** | Cline | P1 |
| K4 | Snapshot view (what changed in the checkpoint) | Cline | P2 |

### 4.4. Statistics, context, cache, and consumption *(heart of the product)*

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| S1 | **Context window** meter: used / remaining / limit (200K · 1M) | CLI | P0 |
| S2 | **Context breakdown**: system prompt, tools, MCP, messages, files, todos, thinking | CLI (`/context`) | P1 |
| S3 | **Cache**: write tokens, read tokens, hit-rate, and estimated savings | CLI / API usage | P1 |
| S4 | **Cost**: per request, per session, and cumulative (tokens + $) | Cline / CLI (`/cost`) | P0 |
| S5 | Tokens per category: input, output, cache-create, cache-read | CLI | P1 |
| S6 | **Subscription limits**: 5h and 7d windows, % used, and reset time | CLI (`rate_limits`) | P0 |
| S7 | **Pacing** indicator (consumption rate vs. limit) | Statusline / Tootega | P2 |
| S8 | Active model, effort, mode (plan/normal), workspace | CLI (statusline) | P0 |
| S9 | Alerts: context near the limit, imminent compaction, plan limit | Tootega | P1 |
| S10 | Consumption history/charts over time (session and daily) | Cline / Tootega | P2 |
| S11 | Visible **compaction** event (how much was condensed) | CLI | P2 |

### 4.5. Extensibility (surface what the CLI allows)

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| X1 | Slash commands (built-in + project/user custom) with autocomplete | CLI | P0 |
| X2 | Skills: list, describe, trigger | CLI | P1 |
| X3 | Custom subagents: list and select | CLI | P1 |
| X4 | MCP servers: status, exposed tools, connect/disconnect | CLI | P1 |
| X5 | Hooks: view configured ones and their triggers | CLI | P2 |
| X6 | `CLAUDE.md` / settings editor with validation | CLI | P1 |
| X7 | Persisted permission management (settings.json) | CLI | P1 |

### 4.6. Modes and productivity

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| M1 | Role-based modes (Code, Architect, Ask, Debug, Test) as presets | Roo·Kilo | P2 |
| M2 | Model and effort selector per session | CLI | P1 |
| M3 | Workspace awareness: open files, selection, terminal | Windsurf·Cascade | P2 |
| M4 | Project memory (persistent notes the agent consults) | Windsurf·Cascade | P2 |
| M5 | Multiple simultaneous sessions/tabs | Tootega | P2 |
| M6 | Git worktrees integration (session per branch) | Tootega | P2 |

### 4.7. Presentation and accessibility

| # | Feature | Origin | Prio |
|---|---------|--------|------|
| P1 | Theme synced with VSCode (light/dark/high-contrast) | Claude GUI | P0 |
| P2 | Rich Markdown + syntax highlighting in code blocks | Claude GUI | P0 |
| P3 | Keyboard shortcuts and full keyboard navigation | Claude GUI | P1 |
| P4 | **Bilingual i18n: pt-BR + international English**, runtime switching, follows the VSCode locale | Tootega | **P0** |
| P5 | Configurable UI density (compact/comfortable) | Tootega | P2 |

---

## 5. Code conventions

- **Language:** **English only** in the repository — identifiers, code, comments, documentation and commit messages. This is about the *source*; it does not affect the product, whose UI stays bilingual (see the i18n rule below).
- **Style:** follow the neighboring file's pattern (naming, comment density, language).
- **Do not reimplement the engine.** If you are tempted to replicate orchestration logic, stop — surface what the CLI already does.
- **Stream parsing:** version-tolerant — unknown events are ignored gracefully and never break the UI.
- **Security:** never log credential content; respect the CLI's permission model; do not bypass approval prompts.

### i18n (mandatory rule)

- **Every user-visible string goes through i18n.** No hardcoded text in the UI — use translation keys.
- **Supported locales:** `pt-BR` and `en` (**international** English, neutral — vocabulary and date/number formats without US/UK bias).
- **Default language:** follows `vscode.env.language`; falls back to `en` when the locale is not supported. Manual override available in settings.
- **Runtime switching** (no extension reload).
- Catalogs live in `l10n/` (`bundle.l10n.pt-br.json`, with `bundle.l10n.json` as the English base), via `vscode.l10n` on the host and an equivalent layer on the webview.
- Pluralization and interpolation are handled by the i18n layer, never by string concatenation.

---

## 6. Non-goals (out of scope)

- Do not replace or compete with the official extension at 1:1 parity — we aim for **consumption transparency and fine-grained control** as the differentiator.
- Do not talk to the Anthropic API directly for the **agent loop** (the channel is the CLI). **Exception:** isolated utility calls authenticated with the local Claude.ai OAuth token (`~/.claude/.credentials.json`) are allowed when they are *clean* (only what the task needs — no agent system prompt, no tools, no MCP, no project context) and not part of the agent orchestration. Examples: `GET /api/oauth/usage` (real usage, same as `/usage`, no token spend); the speech-to-text WebSocket (`/api/ws/speech_to_text/voice_stream`, no token spend); and dictation text correction via `POST /v1/messages` with Haiku (spends *minimal* subscription tokens, but sends only the instruction + text — far cleaner/faster than a CLI one-shot, which has ~5s cold start and loads the full system prompt + tools/MCP every call). Never write or log credentials.
- Do not implement our own billing/payment — the account and limits are those of the user's Claude subscription.
- Do not store user data outside their machine.

---

## 7. Related documents

- [Docs/execution-plan.md](Docs/execution-plan.md) — roadmap, milestones, and detailed requirements.
