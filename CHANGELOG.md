# Changelog

All notable changes to this extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and the project adopts semantic versioning.

## [1.0.224] - 2026-07-22

### Added
- **Skill load is now visible in the timeline.** When a skill's `SKILL.md` body enters the
  context, its `Skill` card gets a `⚡ +N tk loaded (est.)` seal, so the cost shows up at the
  moment it happens instead of only in the panel. The seal appears as soon as the engine
  reports `Launching skill:` and gains the size once the injected body is measured.

### Fixed
- A `/skill-name` sent as the **first** message of a tab was never marked as loaded: the CLI
  only reveals which names are skills in the `init` event, which arrives *after* that first
  message. The command is now held and resolved when the list arrives (and discarded if the
  name turns out not to be a skill).

## [1.0.223] - 2026-07-22

### Added
- **Custom system-prompt text (settings).** `Tootega › System Prompt: Text` is a multi-line
  box whose content is appended to the CLI's system prompt, and
  `Tootega › System Prompt: Enabled` turns it on (off by default). It is applied on **every**
  CLI start, including the respawn that continues the same conversation — otherwise the
  directive would silently vanish mid-conversation after a model/effort change.
- The text is a **template validated against this machine**: `${defaultShell}`, `${psVersion}`,
  `${winPathStyle}`, `${projectPathWin}`, `${projectPathGitBash}`, `${projectPathWsl}`,
  `${wslRow}`, `${os}`, `${tempDir}`. A line whose placeholder refers to something that is not
  installed here (no WSL, no Git Bash) is **dropped whole** — telling the agent about a shell
  the machine does not have is worse than saying nothing. An unknown `${name}` is left as-is
  instead of being invented or blanked. Ships with a shell-discipline directive as the default.

### Fixed
- The text is handed to the CLI through `--append-system-prompt-file`, not as a command-line
  argument. Measured: passed inline, a multi-line text containing `|`, `$` or backticks is
  mangled by `cmd.exe` under `shell:true` on Windows and reaches the model **empty** (an
  injected sentinel came back `MISSING`); through a file it arrives intact. Also measured:
  repeating `--append-system-prompt` does **not** accumulate — the last one wins — so the
  AskUserQuestion language rule and your text are now merged into a single payload instead of
  one silently replacing the other.

## [1.0.222] - 2026-07-22

### Changed
- **Skills panel visuals.** Colour now carries meaning instead of decorating: one hue per
  **origin** (project · user · built-in · plugin) shared by the filter chip, the group header,
  the row's side rule and its origin badge, so a column reads at a glance. Each row gets a
  2px **weight bar** — how much that skill costs relative to the most expensive one in the
  listing. Header tiles get a thin accent stripe and tabular figures; the `loaded` tile stays
  dimmed until something is actually loaded. A row switched off is dimmed (and brightens on
  hover, so its old cost stays readable), while `⚠ off · resident` is never dimmed — an alert
  state must not fade away. All colours come from VS Code theme tokens (`--vscode-charts-*`).

## [1.0.221] - 2026-07-22

### Changed
- **Skills panel: configuration and observation are now two separate axes.** The dropdown
  keeps configuring what enters the listing; a new label beside it reports what is actually
  in the context — `light`, `⚡ loaded`, or `⚠ off · resident`. `resident` is the state that
  must not be hidden: the skill is off, so it will not be listed or triggered again, but the
  body already loaded stays until a new session or `/clear`.
- Header totals (`skills` · `metadata` · `loaded`), grouping by origin with filter chips, and
  a legend spelling out the three states and where the control lives.
- **Origin comes from the engine**, not guessed: `get_context_usage` reports
  `projectSettings` · `userSettings` · `built-in` (verified by creating a skill under
  `.claude/skills/`). An unknown origin falls back to a `plugin` group instead of vanishing.
- **Metadata tokens are measured, not estimated** — they come from the engine per skill, at no
  token cost. Only the loaded body is an estimate (from the size of the message the engine
  injected, not from the file on disk) and it is the only number labelled `est.`; with no such
  signal the panel says the size is not reported rather than showing a number.

### Fixed
- Listing overrides are now stored **per workspace**. `.claude/skills/` belongs to the project
  (confirmed: `skillOverrides` in a project `.claude/settings.json` takes effect — listing
  1983 → 1601), so an override no longer leaks into other folders. They still live in the
  extension state, survive a VS Code restart, and are applied when the CLI starts —
  `~/.claude/settings.json` is never touched.

## [1.0.220] - 2026-07-22

### Added
- **Skills panel (🎯 Skills in the Hub): what each skill costs and which ones are loaded.**
  Per skill: source (built-in / user / plugin), **metadata tokens** (the listing cost paid on
  every turn), and whether its `SKILL.md` body is already in the context. The numbers come from
  the CLI control request `get_context_usage` — a **local** computation: no turn, no tokens, no
  line in the transcript (it answers even before the first message).
- **Per-skill listing control** — `On (full)` · `Name only` · `Only /command` · `Off`, mapped to
  the CLI's `skillOverrides`. The saving is real: on a 14-skill setup, turning three of them
  down took the listing from **1928 → 1027 tokens**. Overrides live in the Cockpit and are
  passed to the CLI at spawn; **`~/.claude/settings.json` is never touched**.
- Honest by construction: there is **no** "unload" button, because the engine offers no way to
  remove a single skill from a live context. On a loaded skill the override still prevents
  re-listing/re-triggering, and the panel says the body stays until a new session or `/clear`
  (measured: listing fell by exactly the skill's metadata tokens, `Messages` unchanged).
  Skills triggered by a hook, or by `/name` typed outside the Cockpit, are invisible to the
  stream and are not shown. Field notes: `Docs/pesquisa/skills-transparencia.md`.

## [1.0.219] - 2026-07-22

### Fixed
- **Garbled accents in PowerShell tool output (Windows).** The Cockpit runs the CLI
  headless (stdio over pipes, **no console attached**); without a console, .NET falls
  back to the system OEM code page (e.g. 437) instead of UTF-8, so `powershell`/`cmd`
  write their output in a legacy encoding and the CLI, which reads it as UTF-8, shows
  mojibake. Characters outside that code page are lost at write time, so no decoding fix
  can recover them. New commands **Tootega: Fix accents in PowerShell output** /
  **Remove the PowerShell UTF-8 hook** install a `PreToolUse` hook in
  `~/.claude/settings.json` that prefixes every PowerShell tool command with the UTF-8
  setup. It never blocks or denies a tool (any failure is a silent no-op), is idempotent,
  changes no system setting and needs no reboot. The Bash tool (Git Bash) is already
  UTF-8 and is untouched.

### Changed
- Repository documentation and code comments are now English-only. The bilingual
  **pt-BR / English UI** is unaffected — it is a product requirement and stays.

## [1.0.217] - 2026-07-15

> Alignment with **CLI 2.1.215** (changelog 2.1.211→2.1.215). Most of it is internal CLI
> fixes we don't touch; what was worth surfacing came from OTEL telemetry.

### Added
- **Reasoning effort per workflow run** in the Usage panel. CLI 2.1.214/215 started
  attaching the `effort` attribute (low…max) to the `cost.usage`/`token.usage` metrics —
  the two we already aggregate per run. The workflow card now shows the agents' effort
  level(s), ordered from lowest to highest (e.g. `deep-research · low · max`). Absent when
  the model does not support effort. Shape confirmed in Anthropic's official monitoring
  docs.

### Improved
- **Real workflow name** in the panel (no longer `custom`). Without
  `OTEL_LOG_TOOL_DETAILS=1` the CLI replaces user-authored workflow names with `custom` in
  the metrics; we now enable that flag in the local receiver. It is safe: the extra detail
  it exposes goes to `/v1/logs`, which we **discard entirely** — only the name reaches the
  metrics, no content is retained.

### Notes (CLI fixes that benefit us with no change on our side)
- Auto-mode denial reason truncation fixed in the CLI (2.1.212): the text we capture for
  the denial log now arrives complete.
- Double-counting of cumulative deltas in telemetry fixed in the CLI (2.1.214/215): the
  OTEL cost/tokens shown in Usage now match the source.

## [1.0.216] - 2026-07-15

> Adaptation to **CLI 2.1.210** (changelog 2.1.208→2.1.210). Most of these releases are
> internal CLI fixes we don't touch; only the MCP panel needed adjusting.

### Fixed
- **MCP panel: the `claude mcp list` format changed.** The CLI started appending the
  transport to the target of remote servers (`<url> (HTTP)` / `<url> (SSE)`) and the status
  glyph became `✔` (was `√`). We now split the `(HTTP)`/`(SSE)` off the URL — the card
  shows a clean URL plus a transport chip — and the status keeps being matched by **word**,
  not by symbol, so the glyph swap changes nothing.
- **Remote server without a URL** (CLI 2.1.208 labels it "not configured"): the card used
  to show a bogus target (`(HTTP)`); it now shows **"Not configured (no URL)"**.

> Alignment with **CLI 2.1.207** (sweep of the official CLI changelog, from 2.1.191 to
> 2.1.207, looking for what we needed to implement, improve or fix).

### Added
- **MCP panel (🔌 MCP in the Hub).** One card per server with its live state, the
  command/URL and **the tools it exposes** — collapsible. It merges the CLI's two sources,
  because neither is enough on its own: the session's `system/init` says *which tools* each
  server contributes (`mcp list` doesn't report that), and `claude mcp list` reveals what
  init never sees — servers from `.mcp.json` that are **not approved yet**
  (`⏸ Pending approval`, CLI 2.1.196), which the CLI refuses to start. Pending and failed
  ones show at the top, with an explanation of what to do. Approving/connecting is still
  the CLI's job (`/mcp`).
- **Warning for a login about to expire** (the CLI started warning in 2.1.203). The Usage
  panel shows the login validity and, under 7 days, an alert asking for `/login` — an
  expired login interrupts long sessions and background tasks. The validity comes from
  `refreshTokenExpiresAt` in `~/.claude/.credentials.json` (`auth status --json` doesn't
  expose it); the accessToken's `expiresAt` is **not** usable: it lasts hours and the CLI
  renews it by itself. Read-only — we never write or log credentials.
- **Denials made by the CLI itself** now enter the audit log (E5) with the **reason**,
  tagged with an `auto` chip so they aren't confused with the ones *you* denied in the
  modal. CLI 2.1.193 started explaining why auto mode denied: the `result` lists the turn's
  denials (`permission_denials[]`, without a reason) and the reason comes in the error
  `tool_result` — we cross-reference them by `tool_use_id`.
- **Workflow runs in the Usage panel** (OTEL telemetry, opt-in): **real** cost and tokens
  summed per run, reconstructed from the `workflow.run_id` / `workflow.name` attributes CLI
  2.1.202 started emitting. stream-json doesn't expose this breakdown.
- **Claude Sonnet 5** in the model selector and in the `tootega.model` setting. It has been
  the CLI default since 2.1.197, with a **native** 1M window — hence it is listed as
  `claude-sonnet-5`, without the `[1m]` variant.

### Security
- **OTEL telemetry no longer carries conversation content.** CLI 2.1.193 introduced the
  `claude_code.assistant_response` event with the **response text**, and it inherits
  `OTEL_LOG_USER_PROMPTS` when `OTEL_LOG_ASSISTANT_RESPONSES` is unset — anyone already
  logging prompts would start logging responses on upgrade. The local receiver already
  discarded `/v1/logs`; we now pin both variables to `0` at spawn, so the text **never
  leaves** the `claude` process.

## [1.0.214] - 2026-07-11

### Removed
- **DASE loses its special handling — it becomes a plain MCP.** DASE is now a standard MCP
  server (`dase-mcp` plugin), discovered by the CLI on its own. Removed: the per-session
  **DASE** checkbox, the `@DASE:` tag, per-window endpoint discovery, generation of a
  dedicated `--mcp-config`, automatic registration in `~/.claude.json`, and the
  `tootega.dase.enabled` / `dase.registerInCli` / `dase.model` settings. No loss of
  function: the `dase_*` tools remain available like any other MCP. Old `tootega.dase.*`
  settings become inert orphans (VS Code ignores unknown keys).

## [1.0.212] - 2026-07-10

### Improved
- **Web-style session titles.** The context card prefers the `ai-title` generated by the
  CLI (the same short label the `/resume` picker shows). When a session has no `ai-title`
  yet, the fallback now truncates the user's first prompt (first sentence/line, ~60 chars +
  `…`) instead of dumping the raw paragraph — the list reads like the history in the web
  version. No token spend: it only reflects what the CLI already produces.

## [1.0.211] - 2026-07-10

### Fixed
- **DASE MCP collided between VS Code windows.** Every window started the DASE MCP server
  on the same fixed port (`39100`) and wrote the same `mcp-endpoint.json`, so the second
  window failed with `EADDRINUSE` and the discovery file was overwritten. DASE now uses an
  ephemeral port (one per window) and writes a per-window discovery file tagged with the
  `workspacePath`; the Cockpit matches the endpoint against **its own window** (normalized —
  case-insensitive on Windows), falling back to the legacy file. Requires DASE with the
  corresponding change. `readDaseEndpoint` / `ensureDaseMcpConfig` / `registerDaseInClaudeCli`
  now take the `workspacePath`.

## [1.0.208] - 2026-07-10

### Fixed
- **A background task stayed "running" forever.** The *Running in the background* card and
  the turn spinner (chat and Hub) never switched off after a command launched with
  `run_in_background`. Tracking read the `<task-notification>` text from `user` messages,
  but when a task finishes **with a turn in flight** the CLI queues the notification and it
  never reaches stdout as a message — only as a `system` event. A task stopped by the agent
  (`TaskStop`) never notified either. State is now reconciled against
  `background_tasks_changed` (the full list of what is running now, emitted by the engine),
  with `task_started` / `task_updated` / `task_notification` as a complement; the key is now
  the engine's `task_id`.
- A turn started **by the CLI itself** to react to a background task finishing while the
  session was idle wasn't accounted for: with `busy` off, the `result` fell into the
  "stray/replay" discard and its tokens/cost vanished from the statistics.

## [1.0.207] - 2026-07-10

### Added
- The Cockpit now **registers the DASE MCP server in the Claude Code CLI user
  configuration** (`~/.claude.json`, user scope) as soon as it detects the DASE extension
  installed and the server up — equivalent to `claude mcp add --scope user`, without the
  CLI cold start. Before, DASE was only visible to Cockpit tabs with the toggle on (via
  `--mcp-config`); now the `dase_*` tools apply to any `claude` session, including the
  terminal and other workspaces. The entry is rewritten when the DASE server restarts with
  a new endpoint. The write is atomic, preserves the other keys and other MCP servers, and
  never logs the token. Controlled by the `tootega.dase.registerInCli` setting (on by
  default).

### Changed
- The DASE endpoint now accepts a **server without a token**: the `Authorization` header is
  only sent when `mcp-endpoint.json` carries one.

## [1.0.204] - 2026-07-10

### Added
- **Where the tokens went** section in the Usage modal: the share of usage generated with
  context above 150k, the share coming from subagents, cache effectiveness and **context
  injected per tool** (MCP servers grouped as `mcp:<server>`, skills as `skill:<name>`).
  `tool_result` tokens are estimated at ~4 characters per token; the `tool_use` →
  `tool_result` link only exists within the same transcript file, and whatever falls
  outside it is not attributed.
- A warning when the Claude Code CLI is older than **2.1.162**, the version that fixed Esc
  (interrupt) being dropped at the start of a turn in `stream-json` sessions — the
  Cockpit's channel. Below that, the stop button can fail silently.

### Fixed
- **Inflated local usage (~59% too high).** One assistant response becomes several lines in
  the `.jsonl` (one text block, one per `tool_use`) and all of them repeat the same `usage`
  object; summing line by line counted the same consumption up to 3–4 times. `usage` is now
  counted once per response (`message.id` + `requestId`). The daily token rollup was
  versioned to discard the already-inflated cache.
- Limit windows: the `/api/oauth/usage` API replaced the fixed fields
  `five_hour`/`seven_day`/`seven_day_opus`/`seven_day_sonnet` with a `limits[]` array with
  `kind` = `session` | `weekly_all` | `weekly_scoped` and the model name in
  `scope.model.display_name`. The old fields come back `null`, so the per-model weekly meter
  had disappeared from the interface. Scoped windows are now read from the array and
  **labelled by the server** (today, Fable). The legacy fields are still accepted as a
  fallback.

### Changed
- Meters renamed to follow current Claude Code naming: "Session (5h)" becomes **Current
  session** and "Weekly (7 days)" becomes **Weekly · all models**.
- The `default` permission mode is now displayed as **Manual**, following the rename made in
  the CLI (2.1.131). The internal value is still `default` (= no `--permission-mode` flag),
  compatible with older CLIs.
- In the per-model breakdown, the highlighted number is now **new tokens** (input + output +
  cache write). **Cache reads** — which alone account for ~97% of the total — appear on a
  secondary line, and the note makes it explicit that the USD figure is the equivalent API
  price, not a subscription charge.
- `<synthetic>` entries (the CLI's marker for turns without a real call) no longer show up
  as if they were a model in the breakdown.

## [1.0.202] - 2026-07-06

### Fixed
- The prompt box no longer loses focus when you come back from another application: the
  VS Code webview blurred the textarea right after the window-reactivation click. The
  composer now re-arms focus when the window returns — if the textarea was focused on the
  way out and the user hasn't focused another control.

## [1.0.198] - 2026-07-03

### Added
- User prompts in the timeline now start **collapsed** (header + 1 line), with a **Show
  more / Show less** button to expand and collapse.

### Fixed
- Background tasks (PowerShell/Bash with `run_in_background`, Workflow) no longer linger in
  the "Running in the background" list after finishing: the CLI's completion notification is
  now recognized when it arrives as a `text` block in an array or embedded in the `content`
  of a `tool_result` (only strings were handled before).
- The code-block copy button, along with the copy / rewind / show-more buttons in the
  header, are no longer covered by the tooltip title box, which blocked the copy click
  (raised above the tooltip in the stacking order).

## [1.0.190] - 2026-07-02

### Added
- MCP/plugin inventory: tools grouped per MCP server from the CLI's `system/init` event.
- **Tootega: Set/Remove Anthropic API key** commands to manage the model-discovery API key.

### Changed
- The model-discovery API key moved from the `tootega.apiKey` setting (plain text) to
  **SecretStorage** (the OS keychain). Automatic migration on first activation; the setting
  is removed.
- The **DASE (ORM)** checkbox now only appears when the `tootega.dase` extension is
  installed.

### Fixed
- Eliminates a ghost session that reappeared in the Hub after deleting contexts.
- Activates the DASE extension so the MCP server starts without a `.dsorm` in the workspace.
- Fixes an extension-host crash caused by a webview reload storm.

### Publishing
- Preparation for the VS Code Marketplace: non-affiliation notice regarding Anthropic, a
  lean `.vscodeignore` (drops dev scripts and internal notes from the package) and
  third-party license attribution (see `THIRD-PARTY-NOTICES.md`).

## [1.0.0] - 2026-06

### Added
- First public release: streaming chat, tool timeline, diffs, checkpoints,
  statistics/consumption panel, permissions, plan mode, voice dictation, bilingual
  spell-checker and pt-BR/en i18n.
