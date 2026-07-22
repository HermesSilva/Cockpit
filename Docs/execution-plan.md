# Execution Plan

**Product:** Tootega Cockpit for Claude Code *(working name)*
**Authorship:** Tootega Pesquisa e Inovação · **License:** MIT
**Companion document:** [../CLAUDE.md](../CLAUDE.md)

---

## 0. Purpose of this document

Define **what**, **in which order**, and **with which definition of done** to build the extension. The target is not "one more AI chat in VSCode", but the **most transparent and controllable GUI** for Claude Code: everything the CLI knows about **context, cache, cost, and account limits** stays visible and actionable on screen.

---

## 1. Vision and principles

1. **The UI is a client of the CLI.** Zero reimplementation of orchestration (see CLAUDE.md §1).
2. **Radical consumption transparency.** Context, cache, cost, and limits are first-class citizens — not a footnote.
3. **Configurable human control.** From "I approve every step" to "let it run", the user chooses.
4. **Graceful degradation.** Different CLI versions must not break the UI; unknown events are ignored.
5. **Native to VSCode.** Theme, shortcuts, diff, and ergonomics follow the house style.
6. **Bilingual from day 1.** pt-BR and international English; i18n is foundation, not final polish (see §4.7).

---

## 2. Execution architecture

### 2.1. Process and channels

| Channel | Mechanism | Content |
|-------|-----------|----------|
| Engine → UI | `claude -p --output-format stream-json --verbose` (stdout NDJSON) | messages, thinking, tool_use, tool_result, usage, session events |
| UI → Engine | `--input-format stream-json` (stdin) | user messages, answers to questions, permission decisions |
| Session | `--resume <id>` / `--continue` | resume conversations |
| Stats/account | **statusline** hook (JSON) | `model`, `context_window`, `cost`, `rate_limits.limits[]` (`session`, `weekly_all`, `weekly_scoped`), `workspace` |
| On-demand stats | `/usage`, `/context`, `/cost` | context breakdown, cost, limits |
| Persistence | `~/.claude/` (sessions, settings, projects) | history, configs, CLAUDE.md |

### 2.2. Internal components

- **CliProcessManager** — spawn, lifecycle, retry, version/capability detection of `claude`.
- **StreamParser** — NDJSON → typed events; tolerant of unknowns.
- **SessionStore** — session state, history, message→checkpoint mapping.
- **StatsAggregator** — accumulates usage per turn/session; computes cache hit-rate, cost, pacing.
- **AccountPoller** — reads statusline/`/usage` for 5h/7d limits and plan.
- **PermissionBroker** — implements the client side of Allow/Deny and plan mode.
- **DiffService** — bridge to the VSCode diff API.
- **WebviewBridge** — typed `postMessage` between host and React.

### 2.3. Event contract (to be specified in Phase 1)

> Before coding, **map the real schema** of the `stream-json` events for the target `claude` version and freeze a versioned contract (`schemas/`). Everything the UI consumes goes through this contract.

---

## 3. Phased roadmap (milestones)

Each phase has **entry**, **deliverables**, and **definition of done (DoD)**.

### Phase 0 — Foundation *(P0)*

**Entry:** empty repository (current).
**Deliverables:**
- Extension scaffold (TS) + webview (React/Vite).
- **i18n infrastructure set up in the scaffold itself**: `vscode.l10n` on the host, an i18n layer in the webview, `l10n/` with `pt-BR` + `en` (base). Every string is born as a key.
- `CliProcessManager` spawns `claude` and captures stdout/stderr.
- "Hello world": send a prompt and render the response as plain text.
- Detection of CLI presence and version; clear message if absent.

**DoD:** a question goes to the CLI and the answer appears in the webview, with streaming; the initial UI already switches pt-BR/en with no hardcoded text.

---

### Phase 1 — Contract and parser *(P0)*

**Deliverables:**
- `schemas/` with the schema of the `stream-json` events (message, thinking, tool_use, tool_result, usage, session).
- `StreamParser` covering all known types + graceful fallback.
- Parsing tests with real fixtures captured from the CLI.

**DoD:** a full stream from a real session is parsed without losses and with 100% coverage of the mapped types.

---

### Phase 2 — Conversation and timeline *(P0)*

**Features:** C1, C3, C6, C8, P1, P2.
**Deliverables:**
- Chat with streaming, rich markdown, syntax highlight.
- Tool-call timeline (collapsible input/output cards).
- Stop/interrupt.
- Session list and resume.
- Theme synced with VSCode.

**DoD:** a real session can be driven end to end, watching tools run, interrupting, and resuming later.

---

### Phase 3 — Editing, diff, and permissions *(P0)*

**Features:** E1, E3, E6, K1.
**Deliverables:**
- Inline diff before writing (VSCode diff API).
- `PermissionBroker`: Allow/Deny/Allow-always rendered as a blocking modal.
- Plan mode: show and approve the plan.
- Automatic checkpoint before changes.

**DoD:** the agent edits files only after approval; the plan is reviewable; changes can be undone via checkpoint.

---

### Phase 4 — Statistics and consumption panel *(P0/P1) — central differentiator*

**Features:** S1, S4, S6, S8 (P0) → S2, S3, S5, S9 (P1).
**Deliverables:**
- **Context meter** always visible: used / remaining / limit, with color per band.
- **Context breakdown** (system, tools, MCP, messages, files, todos, thinking) — via `/context`.
- **Cache**: write, read, hit-rate, estimated savings.
- **Cost**: per request, session, and cumulative (tokens + $).
- **Account limits**: 5h and 7d windows, % used, reset time — via `rate_limits`.
- **Agent status bar**: model, effort, mode, workspace.
- **Alerts**: context near the limit, imminent compaction, plan limit close.

**DoD:** at any moment the user knows, without leaving the screen: how much context remains, how much was spent (tokens and $), how much of the cache was reused, and how long until the subscription limit resets.

---

### Phase 5 — Recovery and fine-grained control *(P1)*

**Features:** K2, K3, K4, E2, E4, E5, E8.
**Deliverables:**
- Rewind per message; 3 restore modes (Files / Files Only / Files & Task).
- Accept/reject per file and per hunk.
- HITL ↔ Agent-first mode (configurable auto-approve) + tool allow/denylist.
- Agent Todos panel.

**DoD:** the user moves freely between "review everything" and "let it run", and can return to any point in history with the right restore mode.

---

### Phase 6 — Extensibility *(P1)*

**Features:** X1, X2, X3, X4, X6, X7, M2.
**Deliverables:**
- Slash commands (built-in + custom) with autocomplete.
- Skills and subagents: list and trigger.
- MCP: status and tools per server.
- `CLAUDE.md`/settings editor with validation; persisted permission management.
- Model and effort selector.

**DoD:** everything the CLI exposes for extensibility is reachable from the GUI, without going to the terminal.

---

### Phase 7 — Differentiators and polish *(P2)*

**Features:** C7, C9, C10, E7, S7, S10, S11, M1, M3, M4, M5, M6, P3, P4, P5.
**Deliverables:**
- Message queue; subagent threads; sorting sessions by cost/token.
- Historical consumption charts; pacing indicator.
- Role-based modes; project memory; multiple tabs/sessions; worktrees.
- Full shortcuts; configurable density. *(i18n is already foundation since Phase 0 — see §4.7.)*

**DoD:** a "phenomenal" experience — the UI becomes the preferred way to use Claude Code, not a poor substitute for the terminal.

---

## 4. Detailed requirements — Statistics, Context, Cache, and Consumption

> This section expands the central ask: **everything** the CLI allows about consumption must be on screen.

### 4.1. Context window (S1, S2)

- **Primary indicator:** used/remaining bar with explicit limit (200K or 1M depending on the model), in tokens and %.
- **Breakdown** (from `/context`), one line per category with tokens and %:
  - System prompt · Tools/definitions · MCP servers · Messages (history) · Attached files · Todos · Thinking blocks · Reserved for response.
- **Visual states:** green < 60% · yellow 60–85% · red > 85% · pulses when compaction is imminent.

### 4.2. Cache (S3, S5)

- Per-turn fields (from `usage`): `cache_creation_input_tokens`, `cache_read_input_tokens`, `input_tokens`, `output_tokens`.
- **Derived metrics:** cache hit-rate `read / (read + write + input)` — writes are *misses* (recorded at ~1.25×), so they enter the denominator; estimated savings (read at ~0.1× vs. full input), write cost (~1.25×).
- Flag **cold cache** (0 repeated reads) as a possible silent invalidator.

### 4.3. Cost (S4)

- Per **request**, per **session**, and **cumulative** — in tokens and $ (estimated from the active model's pricing table).
- Detail per token category (input, output, cache-create, cache-read), since each has a distinct price.
- Source: aggregation of `usage` events + the `cost` field from the statusline.

### 4.4. Subscription / account limits (S6, S7)

- **Windows** from `limits[]` (statusline `rate_limits` / `/usage`): `session` (current session), `weekly_all` (weekly, all models), and `weekly_scoped` (weekly per model, labelled by `scope.model.display_name` — e.g. Fable). For each: % used, absolute value, and **reset time**. Legacy `five_hour`/`seven_day`/`seven_day_<model>` fields are still accepted as a fallback.
- **Pacing:** current consumption rate projected against the reset — alert if the user "will hit the ceiling" before the window turns over.
- Show the subscription **plan** when available.

### 4.5. Agent state (S8, S9, S11)

- Persistent bar: model, effort, mode (plan/normal), workspace/branch.
- Non-intrusive alerts: context > 85%, imminent/occurred compaction (how much was condensed — S11), plan limit close.

### 4.6. History (S10)

- Consumption chart per session and daily (tokens and $), reusing transcripts in `~/.claude/`.

> **Fidelity note:** all numbers come from the CLI/account; the UI **does not estimate** what it can read. Where only an estimate exists (e.g., $ from tokens), label it as an estimate.

### 4.7. Internationalization (i18n) — foundational requirement

- **Locales:** `pt-BR` and `en` (**international English**, neutral: no US or UK slang/regionalisms; dates, numbers, and currency formatted by locale).
- **Default language:** follows `vscode.env.language`; fallback `en` for unsupported locales; manual override in the extension settings.
- **Full coverage:** UI, error messages, tooltips, commands, notifications, consumption alerts, stats labels. Zero hardcoded strings.
- **Runtime switching** without reload.
- **Structure:** `l10n/bundle.l10n.json` (English base) + `l10n/bundle.l10n.pt-br.json`; host via `vscode.l10n.t()`, webview via an equivalent layer synced by `postMessage`.
- **Pluralization and interpolation** by the i18n layer — string concatenation forbidden.
- **i18n DoD:** an automated audit fails the build if there is a visible string without a key; both locales 100% covered.

---

## 5. Risks and mitigation

| Risk | Impact | Mitigation |
|-------|---------|-----------|
| `stream-json` schema changes between versions | Parsing breaks | Versioned contract + tolerant parser + tests with per-version fixtures |
| Account data (5h/7d limits) not exposed programmatically | Gap in S6 | Use the statusline hook as source; fallback to `/usage`; degrade with a warning |
| Imprecise $ cost | User trust | Label as estimate; base it on the active model's pricing table |
| Parity with the official extension (moving target) | Perpetual effort | Focus on the differentiator (consumption/control), not on cloning 1:1 |
| Permissions/security | Real risk | Never bypass prompts; respect the CLI model; do not log secrets |

---

## 6. Quality criteria (cross-cutting)

- **Performance:** fluid UI with long sessions (list virtualization, render throttling on streaming).
- **Resilience:** a `claude` process crash is detected and recoverable without losing history.
- **Accessibility:** 100% keyboard navigable; contrast respecting the theme.
- **Tests:** parser and aggregators covered by unit tests; critical flows by integration.
- **i18n:** pt-BR as the primary language.

---

## 7. Immediate next steps

1. Confirm the product **name** and the extension ID.
2. Capture **real fixtures** of the `stream-json` from the target `claude` version (entry for Phase 1).
3. Validate the programmatic availability of the **account/limits** fields (statusline vs. `/usage`).
4. Phase 0 scaffold.

> Open decisions should be recorded in this document as they are settled.
