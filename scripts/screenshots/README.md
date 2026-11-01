# Screenshots

The images in `images/` (shared by this repo and Cockpit4VS) are captured from the **real
webview bundle** (`dist/webview/main.js` + `main.css`), not from mock-ups. A headless Chrome
loads the bundle unmodified; `host.js` plays the extension host's side of the protocol
(`shared/protocol.ts`) and stages a session, and the driver clicks and types like a user.

| File | Role |
|---|---|
| `shots.mjs` | Driver: one stage per image group, PNGs at 2×, GIFs through ffmpeg |
| `cdp.mjs` | Minimal Chrome DevTools Protocol client (Node's built-in WebSocket) |
| `host.js` | Fake host: `init` answers, the staged turn, permission, questions, usage, export |
| `scenes.js` | The composed questions and the replayed history for the prompt rail |
| `page.html` | The webview page, with the defaults VS Code injects (body padding, font) |
| `theme.css` | The 909 `--vscode-*` variables of VS Code's **Dark+** theme, as VS Code sets them |
| `data.js` | Real repo content the turn shows (file, grep, diff) — the HTML-export fix of 31/10/2026 |
| `gen-data.mjs` | Regenerates `data.js` from git (`BEFORE`/`AFTER` commits inside) |

## Run

PowerShell, from the repo root, after `npm run build`:

```powershell
$env:FFMPEG = 'D:\Utils\ffmpeg\ffmpeg.exe'     # any ffmpeg; defaults to the one on PATH
$work = Join-Path $env:TEMP 'cockpit-shots'
New-Item -ItemType Directory -Force $work | Out-Null
node scripts/screenshots/shots.mjs $work . all  # or a list: hub,chat,ask,history,hero,export
Copy-Item "$work\out\*.png", "$work\out\*.gif" images\ -Force
```

`export` reads the HTML that the `chat` stage captured, so run `chat` first (or `all`).
`Settings View.png` is VS Code's own settings UI, not the webview, and is not produced here.

## Rules

- Every image shows **only the Cockpit panel**, no editor chrome, so the same file serves the
  VS Code listing and the Visual Studio one (workspace `CLAUDE.md` §5).
- Referenced from the READMEs by absolute `raw.githubusercontent.com` URL; `images/` is kept
  out of the `.vsix` (`.vscodeignore`).
