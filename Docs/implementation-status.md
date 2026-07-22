# Implementation status

Updated per the first build cycle. Tracks the [execution plan](execution-plan.md).

## Current state: **functional scaffold, compiling** ✅

`npm run typecheck` and `npm run build` pass clean. Output in `dist/`
(`extension.js`, `webview/main.js`, `webview/main.css`).

## What already exists

### Foundation (Phase 0) — complete
- Extension manifest (`package.json`), build with esbuild (host + webview), dual tsconfig.
- React scaffold in the webview; theme 100% via `var(--vscode-*)`.
- CLI presence/version detection with a clear warning.
- **Dev run scripts without installing**: `run-dev.ps1`, `run-dev.cmd`, `.vscode/launch.json` (F5).

### Contract and parser (Phase 1) — base
- `shared/events.ts`: schema of the `stream-json` events (system, assistant, user, result, stream_event, control_request).
- `shared/protocol.ts`: host↔webview protocol.
- `src/cli/StreamParser.ts`: NDJSON → events, tolerant of noise.
- *Pending:* freeze the contract with **real fixtures** from the target `claude` version.

### Conversation and timeline (Phase 2) — base
- Chat with token-by-token streaming; light markdown (code blocks + inline).
- Tool-call timeline (collapsible input/output cards).
- Thinking blocks with toggle.
- Stop/interrupt; new session.
- *Pending:* persisted session history/resume; @-mention; attachments.

### Model and effort selection (Phase 6 / M2) — implemented
- **Model** and **effort** selectors in the UI (`--model` / `--effort` of the CLI), applied as an
  in-memory session override (they do not alter global settings); the switch restarts the CLI session.
- **Models: layered discovery** (the CLI does not list models):
  1. always-valid aliases (`default`/`opus`/`sonnet`/`haiku`);
  2. **active model** captured live from the `init` event (exact id/variant, e.g., `claude-opus-4-7[1m]`);
  3. **`/v1/models`** when an API credential is present (`tootega.apiKey` or `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`);
  4. a **Custom…** field for any id (the CLI validates on spawn).
- **Subscription** accounts (`apiKeySource: none`) have no API key → use (1)+(2)+(4).
- Effort is a fixed CLI enum (`low/medium/high/xhigh/max`), validated against v2.1.143.

### Session list / "existing contexts" (Phase 2 / C8) — implemented
- `SessionStore` reads `~/.claude/projects/<encoded-cwd>/<id>.jsonl` (encode: `:` `\` `/` → `-`).
- **Sessions** drawer (☰ button): lists the title (first user message), date, and message count, most recent first.
- **Resume**: click → loads the transcript, renders the history (user/assistant/thinking/tools), and arms `--resume <id>` on the next send.
- **New session** (＋) clears resume + timeline.
- Validated against real data: encoding, ordering, and UTF-8 titles (correct accents).

### Model versions in the selector — implemented
- Grouped selector: **Aliases** (latest) + **Versions** (curated list of versioned ids) + discovered active + Custom.
- The curated list covers the fallback when `/v1/models` is not accessible (subscription). The CLI validates on spawn.

### Composer attachments: paste image and file (Phase 2 / C4-C5) — implemented
- **Paste image** (screenshot/bitmap without a path): attaches as a base64 image block in the `user` message
  (format `{type:'image',source:{type:'base64',media_type,data}}` — validated: the CLI accepts it, result success).
  Preview chips in the composer (remove with ✕) and thumbnails in the user bubble.
- **Paste file** (any extension, with a path): inserts the **address** into the text —
  **relative** to the context cwd if inside it, otherwise **absolute** (resolved on the host with `path.relative`).
  The path comes from `File.path` (Electron) or from `text/uri-list` (`file://…`) as a fallback.

### Permissions and interaction (Phase 3) — functional end to end
- **Enablement:** spawn with `--permission-prompt-tool stdio` + `initialize` handshake —
  this is what makes the CLI route `can_use_tool` instead of silently denying in headless.
- **Correct response:** `allow` requires `updatedInput` (the CLI validates with Zod); "always
  allow" returns `updatedPermissions` from the CLI's `permission_suggestions`.
- **Elegant permission modal**: icon per tool, preview per type (Bash command,
  Write file/content, WebFetch URL, generic JSON), Allow / Always allow / Deny,
  shortcuts (Ctrl+Enter / Esc).
- **AskUserQuestion** (questions/answers like the official GUI): arrives as `can_use_tool`;
  a window with **tabs per question**, options as cards, `multiSelect`, an **"Other"** option
  (free text); the answer returns via `updatedInput.answers` (keyed by the question text).
- **Plan mode (E6):** `ExitPlanMode` arrives as a permission — renders the plan in Markdown,
  "Approve and execute" / "Keep planning" buttons.
- The panel reveals itself when the agent requests interaction.
- *Pending:* side-by-side inline diff in the editor; editing the plan before approving; checkpoints.

### Statistics and consumption (Phase 4) — solid base
- `src/stats/StatsAggregator.ts`: context, cache, cost, tokens.
- Panel with: context meter (color bands), cache (hit-rate/read/write),
  cost (session/last turn, "estimated" label), tokens (in/out), account limits (5h/7d).
- Context > 85% alert.
- *Pending:* real breakdown via `/context`; 5h/7d limits via statusline/`/usage`
  (UI already ready, data source missing); historical charts.

### i18n — foundation (P0) complete
- Localized manifest: `package.nls.json` + `package.nls.pt-br.json`.
- Host runtime: `l10n/bundle.l10n.json` + `…pt-br.json` (`vscode.l10n`).
- Webview: `en` + `pt-BR` catalogs, runtime switching, `{0}` interpolation.
- "Switch language" command; follows `vscode.env.language` by default.

## How to run now

```powershell
./run-dev.ps1
```

Opens a VS Code test window with the extension loaded (without installing).
**Tootega Cockpit** icon in the sidebar. Requires `claude` on the PATH and authenticated.

## Next steps (suggested order)

1. Capture **real fixtures** of the `stream-json` and validate the parser end to end.
2. Wire the **account data source** (statusline hook → 5h/7d limits) — UI already waiting.
3. Real `/context` for the context **breakdown**.
4. Inline diff + plan mode + checkpoints (Phase 3/5).
5. Session persistence and resume.
