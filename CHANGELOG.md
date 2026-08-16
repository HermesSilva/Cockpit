# Changelog

All notable changes to this extension are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
and the project adopts semantic versioning.

## [Unreleased]

## [1.0.253] - 2026-08-16

### Fixed
- **Ask questions recover flattened Unicode.** The model occasionally emits a tool_use input with
  the escape flattened (`u00f3` instead of `ó`) — valid JSON, so `JSON.parse` cannot fix it, and
  an `AskUserQuestion` header/option rendered as `su00f3` for `só`. The Ask card and modal now
  repair it on display via `decodeFlattenedUnicode` (`webview/src/util/decodeText.ts`), restricted
  to an orphan `uXXXX` in the Latin-1/Latin-Extended and common-punctuation ranges the model
  actually flattens. A real `\uXXXX` (already resolved by `JSON.parse`) and tokens like `u0000` or
  an out-of-range hex id are left untouched. Covered by `test/DecodeText.test.ts`.

### Changed
- **Sending from the local composer takes back Remote Control.** Typing and sending in the desktop
  composer while a remote device drives the conversation now turns Remote Control off first, so the
  wheel returns to the desktop instead of the local and remote inputs contending.

## [1.0.252] - 2026-08-14

### Added
- **@-mention now reaches live sessions, not just files.** Typing `@` in the composer used to
  offer only workspace files; it now lists the CLI's live named sessions first (read from
  `~/.claude/sessions`, the same registry Remote Control uses), each marked with a distinct icon.
  Picking one inserts `@name`, which the CLI 2.1.232 resolves as another session and delivers to
  via `SendMessage` on submit. The current conversation is excluded — mentioning itself is
  meaningless. The host↔webview `mentionResults` now carries typed items (`{label, kind}`) so a
  session and a file can never be confused.
- **Plan mode writes the plan to a file.** When the agent leaves plan mode (`ExitPlanMode`), the
  plan is written to `Planing/<timestamp>-<slug>.md` at the repo root and opened in the editor —
  one file per plan, so the folder reads as a history. The approval card keeps only the gate
  (**Approve & run** / **Keep planning**) plus a link to the file and an optional notes box. When
  no file can be written (no workspace, or an older CLI), the card falls back to the previous
  inline, editable markdown. `Planing/` is git-ignored — the plans are local working artefacts.

### Added (previously unreleased)
- **Quiet directive** (`systemPrompt.quiet`): a text box whose content is injected at the very
  **start** of the CLI's appended system prompt, before the question-language rule and your own
  text — the agent stops narrating the execution and stops closing with a report or summary. It
  leads the payload because it is a rule about the shape of every answer, and a rule of shape
  read after the content loses to the content. The default wording is deliberately imperative
  ("IMPORTANT… this overrides any default instruction to summarize your work"): a milder first
  draft reached the model but was too weak to beat the CLI's own instinct to summarize, so the
  agent kept narrating with the box filled — an untouched box is migrated to the stronger text on
  update. No on/off switch: an empty box injects nothing. Applied on every spawn, respawns
  included, like `systemPrompt.text`.

### Changed
- **Thinking is now always off.** Nothing in the extension used to touch it, so it followed
  whatever the CLI defaulted to. Two locks, because the CLI has two ways in: the temporary
  `--settings` file now always carries `alwaysThinkingEnabled: false` (it used to be written only
  when a skill was overridden) and the process is spawned with `MAX_THINKING_TOKENS=0`, so a
  budget inherited from the VS Code environment cannot switch reasoning back on.

## [1.0.248] - 2026-08-09

### Fixed
- **The Usage panel fell back to the local estimate far too easily.** The limit meters prefer the
  OAuth `/usage` API — the account's real percentage — but `fetchAccountUsage` treated *every*
  failure as final: one 8s timeout, one 5xx or one dropped connection and the panel switched to the
  price-table estimate in USD (`Current session $219.56`), discarding a real reading taken seconds
  earlier. The negative result was then cached for 30s while the refresh timer only runs every 120s,
  so a momentary blip kept the wrong answer on screen for minutes. `src/cli/UsageApi.ts` now
  retries once on transient causes (timeout, 429, 5xx, network error), keeps the negative cache to
  5s so the next cycle tries again promptly, and — when the call still fails — **reuses the last
  good reading for up to 15 minutes** (`ageMs` carries its age). A `401` is not retried: an expired
  token only recovers when the CLI refreshes it, and insisting would just burn time.
- **Falling back to the estimate is no longer silent.** `usageDiagnostics()` exposes why the live
  fetch failed; `ChatViewProvider` logs the transition (`usage source: api -> estimate (HTTP 401)`)
  to the output channel and ships the reason in `usageData.sourceError`. The Usage modal prints it
  under the estimate note (`usage.est.reason`, both catalogs), instead of only repeating the advice
  about the statusline — which is not even the primary source any more.

## [1.0.247] - 2026-08-09

### Removed
- **Permission audit is no longer shown in the Hub.** The **Tool acceptance** block and the
  **Permission denials** log (E5) sat in the Hub's context panel, between the cost numbers and the
  Model/Effort/Permission controls. They are per-conversation audit data on what is the entry
  screen: a row reading `PowerShell 0% (3)` followed by three `AUTO` refusals from an earlier
  session says nothing useful next to the "New session" button, and the `AUTO` entries are not even
  your decisions — they are the engine's own rule refusing the call. Both blocks are gone from
  `ContextInfo` (`webview/src/components/HubView.tsx`), along with the CSS that only they used.
  Nothing was removed from the pipeline: `StatsAggregator` still records `toolDecisions` and
  `denials`, `StatsStore` still persists them per session, and `toolAcceptance`/`recentDenials`
  still travel in the `StatsSnapshot` — the data is there for whichever surface displays it next.

## [1.0.246] - 2026-08-08

> Alignment with **Claude Code CLI 2.1.226** (sweep of the official changelog, 2.1.224 → 2.1.226;
> 2.1.226 is bug fixes only). Also carries the model-picker and peak-cache work done between
> 1.0.239 and 1.0.245, versions that were only packaging bumps and were never documented.

### Added
- **Visible compaction (S11).** Compaction used to be a silent pause: the turn stalled with no
  explanation and only the token graph, after the fact, showed that something had been condensed.
  The CLI reports both halves and neither was rendered — `system`/`status: "compacting"` while it
  runs (repeated every 30s) and `compact_boundary` to seal it, carrying `trigger`, `pre_tokens`,
  `post_tokens` and `duration_ms`. `compact_boundary` was even listed in `KNOWN_SYSTEM`, but only
  so it would not become a warning. Now the activity indicator says **"Compacting the context…"**
  instead of looking stuck, and the boundary becomes a blue band in the timeline with
  `before → after · −condensed · duration`. The numbers travel raw over the protocol and are
  translated in the webview — the host has no i18n layer for the timeline. 2.1.224 started showing
  the same two things to its own attached clients.
- **Sandbox denials on the Bash card.** From 2.1.224 the CLI annotates the tool result with the
  access the sandbox refused (`annotateStderrWithSandboxFailures`, keyed by `toolUseId`); before
  that a sandboxed command just failed with no stated reason. The denials now show in an amber
  band above the output — the cause, next to the effect. Recognised by **shape** (a line naming
  the sandbox next to a refusal verb), because the wording differs per platform and per release;
  a line we do not recognise stays in the output, where it always was.

### Changed
- **Remote Control says what is known, not what was hoped for.** Spawning the terminal was taken
  as proof that the handover worked: the button went green immediately, and a failed pairing left
  the tab claiming "connected" while the poll repainted a transcript that never moved. The state
  is now *confirmed* against the live-session registry the CLI keeps in
  `~/.claude/sessions/<pid>.json` (new [`SessionRegistry`](src/cli/SessionRegistry.ts), which also
  checks the pid is really alive — a hard kill leaves the file behind). Amber and pulsing while
  connecting, green once the process registers itself, **red and persistent** if it never appeared
  (45s) or disappeared after being up. A failure keeps the terminal open — it holds the reason —
  and the next click reconnects instead of toggling off. This is the same bug the official
  extension fixed in 2.1.224, and 2.1.224/2.1.225 also replaced its 8-second toast with a
  persistent indicator and a reconnect shortcut.

### Fixed
- **Blank bubble after `/clear`.** `message_start` always opened an assistant item, so a turn that
  produced no output — `/clear` and the other output-less commands, or a message whose blocks were
  all tool calls — ended as an empty bubble. It is now hidden once finished with no text and no
  thinking; while it is still streaming the empty item is the legitimate placeholder, and a
  cancelled one carries the "interrupted" mark, so both stay. `lastAssistId` skips them too —
  otherwise, in `quiet`/`necessary`, the "final text" resolved to the empty item and the timeline
  went blank. 2.1.224 fixed the same `(no content)` message for its remote and SDK clients.

### Added *(work carried from 1.0.240–1.0.245)*
- **Remove a model from the picker.** Entries observed or added by hand piled up with no way out;
  the row now has a remove action. Discovery recreates the official ones on the next sweep, so
  nothing real is lost.
- **Context size in the model combo.** The closed selector shows the window of the chosen model,
  not just its name (without repeating "1M · 1M" when the label already carries the suffix).
- **Cache at the context peak.** `peakCacheTokens` is persisted alongside `peakContextUsed`, and
  the Activity block shows the cache size at that turn. Sessions saved before this fall back to
  the current cache.
- **1M window for the `spark` and `muse-spark` models** in the context-limit derivation.

## [1.0.239] - 2026-08-06

> Alignment with **Claude Code CLI 2.1.223** (sweep of the official changelog, 2.1.221 → 2.1.223,
> looking for what we needed to implement, fix or stop guessing).

### Added
- **Engine warnings in the timeline.** The CLI started reporting mid-session facts that reach the
  user as *effects* with no cause: fast mode running out of usage credits (2.1.221) and a
  subagent whose model is restricted, so the parent's model answers instead (2.1.223). They come
  as `system` events with no `tool_use` to seal, so each becomes its own ⚠ banner, shown once per
  session at any verbosity. Recognised by **shape** (a warning-ish subtype or an explicit
  `warning` field), not by a pinned subtype — the next release's warning surfaces with no code
  change, and unknown events keep being ignored as the stream contract requires.
- **`/code-review` in the slash catalog.** 2.1.223 renamed `/review` (adding PR support and the
  `ultra` cloud review). The new name was landing in *Other*, with its description researched by
  AI; it is now a curated entry, and `review` stays as the legacy alias.
- **Maximize button in the plan review.** A long plan was unreadable inside a 540px card — the
  toggle gives the plan the whole panel, in both the read and the edit views.
- **A text editor per question in the Ask dialog.** Each tab (one per question) now has its own
  free-text box that is **added to** the choices of that question — a picked option rarely says
  everything, and the constraint that qualifies it had nowhere to go. Written text alone is a
  valid answer too. The answer travels with the choices on the first line and the text on the
  next, and the timeline card splits it back, so the chosen option still reads as chosen and the
  added text shows under it. **Enter sends** (like the button), Shift+Enter breaks the line.
- **Session kind in the Usage panel.** The CLI started reporting whether the session is
  *interactive*, *attached* or *unattended* (2.1.221). The statusline wrapper captures it when the
  payload carries it, and the panel shows it beside the other session flags — no field, no row.
- **Invisible characters exposed in the permission prompt.** Zero-width, bidi overrides,
  non-ASCII spaces, tab padding and C0 controls now show as a marked glyph (hover gives
  `U+XXXX NAME`), with a warning above the command. The CLI hardened its own prompts against the
  same trick in 2.1.221/2.1.223; here the approval is a person reading the command, so what is
  hidden has to be visible before the click, not after.

### Changed
- **Picking an option in the Ask dialog no longer jumps to the next question.** With a text box
  per question, the jump took what you were writing off the screen.

### Fixed
- **The Remote Control button actually publishes the session.** It used to send
  `/remote-control` down the stream, and that command **only exists in an interactive
  session** — in our headless one (`-p --input-format stream-json`, which is what gives us the
  stream) the CLI answers *"/remote-control isn't available in this environment"*, and the
  command isn't even in that init's `slash_commands` (measured on 2.1.223). The button now hands
  the conversation over the way the CLI supports: it stops the tab's headless process — two
  processes owning one session would duplicate the context on disk — and opens a **visible**
  terminal with `claude --remote-control --resume <id>`, which continues *this* conversation and
  prints the pairing URL/QR. The timeline keeps following the same transcript while the remote
  session runs, so local and remote history show side by side; the composer steps aside and the
  button turns green. Clicking it again **turns Remote Control off** (same toggle as the official
  extension): it closes the terminal and the Cockpit drives the conversation again — nothing is
  lost, the next message resumes it. Closing the terminal by hand does the same.
- **The context meter no longer promises headroom the engine won't give.** With
  `CLAUDE_CODE_DISABLE_1M_CONTEXT` set, CLI 2.1.223 disables the 1M window for **every** model
  that has one and auto-compacts at 200K; we were still deriving 1M from the model (the `[1m]`
  suffix, the discovered window, or the Claude 5 family), so the bar showed 1M while the CLI
  compacted at a fifth of it. The switch is now read from the same places the CLI reads it — the
  process environment and the `env` block of the user/project settings — and caps the meter.

## [1.0.235] - 2026-08-03

### Added
- **A second engine: Tootega Code CLI (local model).** `tootega.engine` chooses between the
  Claude Code CLI (default) and the `tools/agent.exe` of a TootegaEngine build
  (`tootega.tootegaPath`), which talks to a local server (`tootega.tootegaServer`, default
  `127.0.0.1:8080`, started with `serve.cmd`). Both engines speak the **same process
  contract** — stream-json over stdin/stdout, the shapes in `shared/events.ts` — so the founding
  principle is untouched: the UI still does not reimplement orchestration, it spawns a different
  binary. `src/cli/Engine.ts` is the single place that knows which engine is active and what it
  offers: `engineCaps` states that the local engine has no account, no extensions and no cost, so
  those panels stay empty instead of failing (cost showing zero is not a gap — running locally
  costs nothing). Plan mode maps to `--no-tools`, bypass-permissions to `--yes`.
- **Engine combo in the control bar**, first from the left, before **Model** — it decides *who*
  answers, and the model list only makes sense inside the engine that offers it. Labels moved
  from beside each control to **above** it: with four combos in a row the inline labels doubled
  the width and the bar wrapped. The checkbox keeps its label beside it.
- **Engine per tab — N Claude tabs plus one Tootega tab.** The engine used to be one choice per
  window; it is now a per-tab override, the same pattern model and effort already use, so several
  Claude tabs and one local tab can be live at once as separate processes. Only **one** tab may
  sit on Tootega, and the guard says why: the local server answers one request at a time and
  keeps a single KV cache, so a second tab would queue behind the first and destroy its prefix
  cache every turn. Switching the global setting stops only the tabs *without* an override.
- **`tootega.tootegaEnabled` — one switch for the local engine** (off by default). Off, Tootega
  does not exist for the installation: nothing spawns `agent.exe`, `tootega.engine` is ignored,
  a tab still pinned to Tootega is unpinned, and the **Engine** combo disappears from the
  toolbar (the host offers a single engine, and the picker only renders when there is a choice).
  On, the combo and the per-tab override come back. The guard is in the host, not just the UI.
- **A diagnosable spawn log.** The spawn line now records engine, binary, full argument list and
  cwd; a non-zero exit records how long the process lived, how many events it emitted and the
  tail of its stderr — where an engine that dies at startup says why. With `tootega.debugLog` on,
  every event in and out is logged one per line, minus the `stream_event` flood.

### Changed
- **No hardcoded model data anywhere.** The curated `MODEL_LIST` / `BASE_OF_1M` tables and the
  `tootega.model` enum in the manifest are gone. The picker is built entirely from
  `/v1/models`: `display_name` is the label (no more titles guessed from the id),
  `max_input_tokens` gives the context column *and* decides the `[1m]` suffix (the suffix is a
  no-op on natively-1M models, verified on CLI 2.1.220, so no per-model table is needed), and
  `created_at` sets the order. A model released to your account shows up with no extension
  update. The last successful catalogue is cached, so offline no longer falls back to a stale
  list. The price multiplier is now anchored on **your default model** (1x) instead of a model
  pinned in the code.

### Fixed
- **Engine processes no longer survive a reload.** On Windows a child does not die with its
  parent, so every reload of the extension host left the previous engines running — up to seven
  `agent.exe` at once, each one a live conversation nobody could see. `dispose()` now stops every
  session, and the Tootega argument list passes `--resume <sessionId>`: the agent exits on its
  own when idle and the conversation comes back from disk with the next message.
- **The Tootega panel no longer sits on the spinner forever.** The webview waited for a `history`
  message that only ever came from a transcript under `~/.claude`; the local engine has none, so
  the loader hid everything, including the user's own bubble. Empty history is now announced at
  init, the moment the session id becomes known, and `clearConversation()` resets the flag.
- **The Tootega answer no longer goes missing.** VS Code destroys a hidden webview and drops the
  messages posted meanwhile; the repaint that should have recovered the timeline was replying
  with an empty list and wiping it instead, and nothing repainted at the end of a turn. The
  repaint now reads the transcript the agent writes after every turn
  (`%LOCALAPPDATA%\tootega\sessions\<id>.json`): the system prompt is skipped, `tool_calls`
  become cards with parsed input, each tool result goes **into** the card that asked for it, and
  a turn that only called a tool does not become a bubble of raw markup.
- **Context meter on the real window.** `system/init` may carry `context_window` and the session
  now uses it — the Tootega agent reports the server's window, without which the meter measured a
  16 384-token context against 200 000.
- ***Default (…)* no longer shows a stale model.** `~/.claude/settings.json` was read once, in
  the provider's constructor, so changing `model` outside VS Code (the CLI's own `/config`) kept
  showing the old default until the window was reloaded. It is now re-read on every session
  init — the moment the CLI resolves its default from that same file.

## [1.0.233] - 2026-07-24

### Added
- **Remote-control button in the composer.** A new button in the composer toolbar (next to
  the credentials vault) publishes the current session for **remote control**, making it
  visible on the remote client / phone app — the same action as the Hub card's remote button,
  now reachable while you type. Disabled until the session has a live id.

## [1.0.232] - 2026-07-24

### Added
- **FAQ / Q&A document** ([`Docs/FAQ.md`](Docs/FAQ.md)) — factual questions and answers for the
  Marketplace **Q & A** tab and for anyone evaluating the extension: what it is and how it
  differs from the official extension, requirements and setup, cost/tokens/privacy, models
  (Opus 5, discovery-driven picker, fast mode, limits, MCP/skills/hooks/subagents) and
  troubleshooting. Linked from the README.

## [1.0.231] - 2026-07-24

### Fixed
- **“Default” model no longer sticks to a pinned model.** The observed engine default was
  cached from any session whose `settings.model` was `default` — even when the tab pinned a
  concrete model (e.g. Opus 4.8 1M). The pinned id got recorded as the default, so
  *Default (…)* lied and never reflected the CLI's real default (Opus 5 on 2.1.219+). It is now
  cached only from a session that ran with **no per-tab override**. Pick *Default* on an
  un-pinned tab once and it re-observes correctly.

### Changed
- **The model picker is discovery-driven.** Curated model rows are now offered only when
  `/v1/models` confirms the account actually has them (matching undated aliases and dated
  snapshots alike); `Default` and Opus 5 are always valid. A genuinely nonexistent model can no
  longer sit in the list. Offline (no discovery), the full curated list stays as a fallback so
  the picker never collapses.

## [1.0.230] - 2026-07-24

Aligns the extension with **Claude Code CLI 2.1.219**, surfacing engine capabilities added
across the 2.1.208 → 2.1.219 releases.

### Added
- **Opus 5 in the model picker.** `claude-opus-5` is the default Opus since 2.1.219 — 1M
  context native (no `[1m]` variant, like Sonnet 5) and covered by fast mode. Price and
  context keep coming from live discovery (Models API + pricing docs), so nothing else is
  hard-coded.
- **MCP config-validation errors.** The `system/init` event now lists servers the CLI skipped
  at config validation (`mcp_server_errors`, 2.1.219). A tolerant parser attaches the reason to
  its server (forcing *failed*) — or adds a standalone row when the server has no name — and the
  **MCP panel** shows *“skipped by config validation: …”*.
- **Session flags in the Usage panel.** The statusline wrapper now also captures `fast_mode`,
  `model.display_name`, `effort.level` and `output_style.name`. The Usage modal shows a
  **Session** block with fast mode / model / effort / output style, labelled *from statusline*
  and dimmed when the cache is stale. Same provenance as the real limits (the user's statusline
  session, not the Cockpit's headless run).
- **Subagent output on the Task card.** With agents allowed, the CLI is spawned with
  `--forward-subagent-text` (2.1.211): a subagent's narration arrives tagged with
  `parent_tool_use_id` and is rendered inside the **Task** card that launched it — kept out of the
  main bubble and out of the stats (subagent cost stays sourced from the authoritative turn
  total, so the live counters don't shift). Nested subagents attribute to their own launcher; a
  subagent's permission prompt (`control_request`) still reaches the normal handler.
- **Hook-trigger hints in the Skills panel.** Each hook injection now shows its event with a
  tooltip describing what it fires on, including the new **DirectoryAdded** trigger (after
  `/add-dir` or an SDK `register_repo_root`, 2.1.219). An unknown event falls back to a generic
  hint — the panel never breaks on a new trigger name.
- **EndConversation tool card.** The agent can end a session on its own with abusive users or
  jailbreak attempts (2.1.214); the timeline gives it a dedicated 🛑 card with the reason it gave.

## [1.0.228] - 2026-07-22

### Added
- **Skills loaded by a hook are now visible.** A hook (`SessionStart`, `UserPromptSubmit`, …)
  can inject a whole `SKILL.md` into the context without a `Skill` tool call and without
  `/name` — the panel showed the skill as `light` while its body was already weighing on every
  turn. The stream does carry `system/hook_response` with the injected text, but not the
  skill's name, so the link is made by **content**: the new
  [`SkillBodyIndex`](src/cli/SkillBodyIndex.ts) matches the injected text against the body of
  the `SKILL.md` files on disk (200-character normalised signature, frontmatter excluded) and
  marks the skill `⚡ loaded`, labelled *loaded by a hook* since it is an inference. Skills
  are also looked up on disk, not only in the `system/init` list: a `SessionStart` hook fires
  **before** the init, and the first injection is exactly the one that carries the full body.
- **Hook context in the Skills panel.** Matched to a skill or not, every `hook_response` is
  accounted for and grouped by hook, with the estimated injected size and the number of times
  it fired. Nothing is invented: a built-in skill has no file on disk and is therefore counted
  without a name.
- **Hook injections in the timeline.** A hook has no tool card to seal, so it gets its own thin
  band showing the hook, the recognised skill and the estimated size. It sits outside the
  bubbles — a `SessionStart` hook happens before the first prompt and belongs to no turn — and
  a hook that fires on every prompt is banded once, with the repetitions counted in the panel.

### Changed
- The `Skill` card's seal in the timeline now shows **which** skill was loaded
  (`⚡ keybindings-help · +3.0k tk loaded (est.)`), instead of the size alone.

## [1.0.226] - 2026-07-22

### Fixed
- **A built-in skill loaded without a token estimate.** The size of an activated skill was
  only measured when the injected body started with `Base directory for this skill:`, a
  header that exists only for skills with their own directory (user/plugin). A built-in
  ships the `SKILL.md` raw, so it showed up as active with no number — no `⚡ +N tk` seal in
  the timeline and no weight in the panel. The body is now taken by position (the first
  `text` block after `Launching skill:`), and the window closes on the next `assistant`
  message so a queued user message is never measured as a skill body.
  Measured against the real CLI: `keybindings-help` = ~3012 tk of body.

## [1.0.225] - 2026-07-22

### Fixed
- **Settings opened empty.** The *Settings* command (and the webview button) filtered the
  Settings editor by `@ext:tootega.tootega-cockpit`, an id that does not exist — the manifest
  publisher is `HermesSilva`, so the panel showed *No Settings Found*. The filter is now built
  from `context.extension.id`, which comes from the manifest and cannot drift again, and the
  webview reuses the `tootega.settings` command instead of repeating the string.

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
