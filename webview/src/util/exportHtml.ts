// Exports the timeline as a SELF-CONTAINED .html: a snapshot of what is on screen,
// not a re-rendering of it. The document is built from the live DOM — the same nodes the
// user is looking at — plus the stylesheet rules that style them and the theme variables
// resolved to their current values. Nothing is re-implemented here, so the export cannot
// drift from the component: whatever Timeline.tsx renders is what lands in the file,
// including each card's expand/collapse state.
//
// Images (user attachments as data URLs, the activity icon served by the host) are inlined
// as base64, so the result is one portable file with no companion folder.

/** The timeline's root element. The export is meaningless without it. */
function timelineRoot(): HTMLElement | null {
  return document.querySelector('.timeline');
}

/**
 * Collects the CSS the export needs. The webview's bundle is a single `main.css` served
 * from the extension's dist, so `cssRules` is readable (same-origin); when a sheet is
 * cross-origin the browser throws on access and we skip it — that only costs styling for
 * sheets we do not own.
 */
function collectCss(): string {
  const out: string[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // cross-origin sheet: not ours, nothing to carry
    }
    for (const rule of Array.from(rules)) out.push(rule.cssText);
  }
  return out.join('\n');
}

/**
 * The theme, frozen. Every colour in styles.css reads a `--vscode-*` custom property through
 * var(), and those properties come from the host, not from the stylesheet — so the snapshot
 * has to carry their current values or the document opens unstyled.
 *
 * Where they live differs per host and both are covered: VS Code injects them as an inline
 * style on <html> (picked up here), while the Visual Studio port publishes them as a
 * `<style id="vs-theme">` element (already picked up by collectCss). Reading the inline
 * style rather than getComputedStyle keeps this to exactly the set the host defined,
 * without walking hundreds of unrelated properties.
 */
function collectThemeVars(): string {
  const style = document.documentElement.style;
  const decls: string[] = [];
  for (const name of Array.from(style)) {
    if (!name.startsWith('--')) continue;
    const value = style.getPropertyValue(name);
    if (value) decls.push(`  ${name}: ${value};`);
  }
  return decls.join('\n');
}

/** Reads a URL the webview can already fetch (host resource, blob, http) as a data URL. */
async function toDataUrl(url: string): Promise<string | undefined> {
  try {
    const res = await fetch(url);
    if (!res.ok) return undefined;
    const blob = await res.blob();
    return await new Promise<string | undefined>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : undefined);
      reader.onerror = () => resolve(undefined);
      reader.readAsDataURL(blob);
    });
  } catch {
    return undefined;
  }
}

/**
 * Inlines every <img> in the cloned tree. Attachments are already data URLs and pass
 * through untouched; host-served sources (the activity icon, `vscode-webview://…`) are
 * fetched and converted. An image that cannot be read is dropped rather than left as a
 * broken link pointing at a URL that only resolves inside the webview.
 */
async function inlineImages(root: HTMLElement): Promise<void> {
  const imgs = Array.from(root.querySelectorAll('img'));
  await Promise.all(
    imgs.map(async (img) => {
      const src = img.getAttribute('src') || '';
      if (!src || src.startsWith('data:')) return;
      const data = await toDataUrl(src);
      if (data) img.setAttribute('src', data);
      else img.remove();
    }),
  );
}

/**
 * Strips what only makes sense in a live panel. The snapshot is read-only, so interactive
 * affordances would be lies: buttons that do nothing and inputs the reader can type into.
 * Buttons are unwrapped into spans (keeping label and classes, so the layout is unchanged)
 * instead of removed — many of them ARE the card headers.
 */
function neutralizeInteractive(root: HTMLElement): void {
  for (const el of Array.from(root.querySelectorAll('button'))) {
    const span = document.createElement('span');
    span.className = el.className;
    span.innerHTML = el.innerHTML;
    el.replaceWith(span);
  }
  for (const el of Array.from(root.querySelectorAll('input, textarea, select'))) el.remove();
  // Event handlers cannot survive serialisation anyway; drop the attributes so the
  // exported markup carries no dead inline JS.
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    for (const attr of Array.from(el.attributes)) {
      if (attr.name.startsWith('on')) el.removeAttribute(attr.name);
    }
  }
}

/** Escapes text going into the document's title/header. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export interface HtmlExport {
  html: string;
  fileName: string;
}

/**
 * Builds the snapshot. `title` names the document and `generatedAt` is the caption under
 * it — both come from the caller so the wording stays in the webview's language.
 * Returns undefined when there is no timeline on screen to capture.
 */
export async function buildTimelineHtml(
  title: string,
  generatedAt: string,
): Promise<string | undefined> {
  const root = timelineRoot();
  if (!root) return undefined;

  const css = collectCss();
  const vars = collectThemeVars();
  const clone = root.cloneNode(true) as HTMLElement;
  neutralizeInteractive(clone);
  await inlineImages(clone);

  // The wrapper reproduces the panel's own nesting (#root > .app > .scroll) so the
  // selectors in styles.css that depend on those ancestors still apply.
  return `<!DOCTYPE html>
<html lang="${esc(document.documentElement.lang || 'en')}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(title)}</title>
<style>
:root {
${vars}
}
${css}
/* Snapshot-only: the panel is a fixed-height flex column sized by the editor. A document
   scrolls with the page instead, and the exported timeline gets a readable margin. */
html, body, #root, .app, .scroll { height: auto; overflow: visible; }
#root { border-left: none; }
body { padding: 16px 20px 40px; }
.export-header { margin: 0 0 20px; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border, #353537); }
.export-header h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
.export-header .export-when { font-size: 12px; opacity: 0.7; }
</style>
</head>
<body class="${esc(document.body.className)}">
<div id="root"><div class="app">
<header class="export-header">
<h1>${esc(title)}</h1>
<div class="export-when">${esc(generatedAt)}</div>
</header>
<div class="scroll">${clone.outerHTML}</div>
</div></div>
</body>
</html>`;
}

/** Suggested file name (title slug + short date), mirroring the Markdown export's shape. */
export function suggestedHtmlName(title?: string, ts = Date.now()): string {
  const slug =
    (title || 'conversa')
      .toLowerCase()
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'conversa';
  let stamp = '';
  try {
    stamp = new Date(ts).toISOString().slice(0, 10);
  } catch {
    /* ignora */
  }
  return stamp ? `${slug}-${stamp}.html` : `${slug}.html`;
}
