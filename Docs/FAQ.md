# Tootega Cockpit for Claude Code — Q&A

Questions and answers for the Visual Studio Marketplace **Q & A** tab and for anyone
evaluating the extension. Short, factual, no marketing. For the full picture see the
[README](../README.md) and [CLAUDE.md](../CLAUDE.md).

---

## What it is

### What is Tootega Cockpit?
A native VS Code extension that gives Claude Code a rich GUI: chat/timeline, inline diffs,
plan mode, permission prompts, and — the differentiator — **transparency over context, cache,
cost and subscription limits**. It is a **presentation and control layer only**; all
orchestration (the agent loop, tools, subagents, todos, context, compaction, permissions,
MCP, hooks, skills) lives in the Claude Code CLI.

### How is it different from Anthropic's official Claude Code extension?
The Cockpit does not aim for 1:1 parity with the official extension. It focuses on
**consumption transparency and fine-grained control**: context-window meter, cache hit-rate
and estimated savings, per-request/session/cumulative cost, 5h and 7d subscription windows,
pacing, per-model breakdown, and panels for MCP, skills and hooks. It talks to the same
engine (the CLI), so it inherits the official auth, billing and features automatically.

### Is it official / affiliated with Anthropic?
No. It is an independent, open-source (MIT) project by **Tootega Pesquisa e Inovação**. It
pilots the official `claude` CLI; it does not reimplement or replace it.

### Is it open source? What license?
Yes — **MIT**. Source and issues live in the
[GitHub repository](https://github.com/HermesSilva/Cockpit).

---

## Requirements & setup

### What do I need to run it?
- **VS Code ≥ 1.90**
- The **Claude Code CLI** (`claude`) on your `PATH`, **authenticated** (by subscription or
  API key)
- Node.js ≥ 20 is only needed to build from source, not to run the published extension

### Do I have to install the Claude Code CLI separately?
Yes. The Cockpit **pilots** the CLI; it does not bundle or replace it. Install and
authenticate the CLI first (`claude --version` to verify, `claude` once to log in). On
activation, if the CLI is missing, the extension offers to help. If `claude` is not on the
`PATH`, set the full path in **Settings → `tootega.claudePath`**.

### How do I sign in?
Authenticate the CLI once — run `claude` in a terminal and log in when prompted, or use the
**"Tootega: Sign in to Claude (CLI)"** command from inside the Cockpit. The Cockpit uses the
CLI's own login; it never asks for or stores your password.

### Which platforms are supported?
The extension runs where VS Code and the CLI run (Windows, macOS, Linux). Two features are
currently **Windows-only or host-dependent**: the **statusline real-usage wrapper** is
Windows-only for now (the OAuth `/usage` meters themselves are cross-platform), and **voice
dictation** needs `ffmpeg` on the host. On Windows the CLI is usually a `.cmd` shim, so the
host spawns it with a shell and probes `~/.local/bin` when it is off the `PATH`.

---

## Cost, tokens & privacy

### Does the extension cost anything?
The extension is **free**. It uses **your** Claude subscription or API credentials via the
CLI — the account and its limits are yours. The Cockpit does not add any billing of its own.

### Does using the Cockpit spend extra tokens?
Running the agent spends tokens exactly as the CLI does — the Cockpit adds no hidden agent
calls. A few **clean utility calls** are made outside the agent loop: reading real usage
(`/api/oauth/usage`, no token spend), listing models (`/v1/models`, no token spend), and, if
you enable dictation correction, a minimal Haiku call that sends only the instruction + text.
None of these load the agent system prompt, tools or project context.

### Is the "Cost" figure my real invoice?
No. Cost is an **estimate** (labelled *estimated*): the equivalent API price of the tokens.
A subscription does not charge you that — it is there for transparency and comparison, not
as an invoice.

### Where is my data stored? Do you send it anywhere?
Everything stays on your machine. The Cockpit does not store user data off-device and never
logs credential contents. Usage attribution is computed locally from your `~/.claude`
transcripts. The only network calls are to Anthropic (through the CLI, plus the clean utility
calls above).

---

## Features

### Which models does it support? Is Opus 5 available?
The model picker is **discovery-driven**: it lists the models your account actually has via
`/v1/models` (including **Opus 5**, the current default Opus on CLI 2.1.219+). "Default"
resolves to whatever the CLI itself picks when spawned with no `--model`. Price and context
columns come from live discovery (real context window) and the pricing docs.

### Why does "Default" show an older model instead of Opus 5?
"Default" reflects the engine's real default, observed from a session that ran with **no
per-tab model override**. If your tabs are pinned to a specific model, pick **Default** on an
un-pinned tab once and it re-observes correctly. Make sure the installed CLI is recent
(`claude --version`) — Opus 5 becomes the default on **2.1.219+**.

### What is "fast mode" in the Usage panel?
When the statusline wrapper is installed, the Usage panel surfaces session flags the CLI
reports — **fast mode**, model label, effort and output style. These come from your
**statusline** session (the same provenance as the real limits), labelled accordingly and
dimmed when the cached value is stale.

### How does it show subscription limits (5h / 7d)?
From, in order of trust: the OAuth `/usage` endpoint → the statusline wrapper's real
percentages → the stream's `rate_limit_event` → a local token estimate. It shows the used %,
reset time and, where available, per-model weekly windows.

### Does it show MCP servers, skills and hooks?
Yes. There is an **MCP panel** (status, exposed tools, servers pending approval, and servers
the CLI skipped at config validation), a **Skills panel** (listing cost, per-skill overrides,
and hook-injected context with per-event trigger hints), and hook injections surfaced in the
timeline. Everything reflects what the CLI reports; nothing is reimplemented.

### Can I see subagent activity?
Yes. With agents allowed, subagent narration forwarded by the CLI is shown inside the **Task**
card that launched it, kept out of the main conversation and out of the cost counters.

### Does it support plan mode, permissions and checkpoints?
Plan mode, permission approval (Allow / Deny / Allow-always) and the agent Todos are
supported today. **Rewind** currently restores the *conversation* (transcript truncation +
`--resume`), not files on disk. Inline native-editor diffs, editing a plan before approval,
and Git file-restore checkpoints are **planned** — see
[Docs/implementation-status.md](implementation-status.md).

### Is it bilingual?
Yes — **pt-BR** and **international English**, switchable at runtime, following the VS Code
locale by default.

---

## Troubleshooting

### The extension says the CLI is missing / not found.
Confirm `claude --version` works in a terminal. If it does but the extension can't find it,
set the absolute path in **Settings → `tootega.claudePath`**. On Windows, the native
installer may put `claude` in `~/.local/bin`, which isn't always on the `PATH`.

### Some numbers look off after a CLI update.
The stream event contract can vary between CLI versions. The parser is **version-tolerant** —
unknown events are ignored rather than breaking the UI — but a new version may shift parts of
the rendering. Update the extension and report a mismatch on GitHub with your `claude
--version`.

### A model I expected is missing from the picker.
The picker only offers models your account has, per `/v1/models` — there is no hardcoded list
to be out of date. If discovery is unavailable (offline / no credentials), it falls back to the
last answer it cached, and **Custom…** still accepts any id. Make sure you're signed in
(`claude --version`); setting the API key (**Tootega: Set Anthropic API key**) re-runs
discovery right away.

### Where do I report bugs or ask questions?
Open an issue in the [GitHub repository](https://github.com/HermesSilva/Cockpit). That is the
best place for anything extension-related (the Marketplace Q & A tab points there too).
