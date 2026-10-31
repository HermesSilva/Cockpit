// Exports the timeline as a SELF-CONTAINED .html: a snapshot of what is on screen,
// not a re-rendering of it. The document is built from the live DOM — the same nodes the
// user is looking at — plus the stylesheet rules that style them and the theme variables
// resolved to their current values. Nothing is re-implemented here, so the export cannot
// drift from the component: whatever Timeline.tsx renders is what lands in the file.
//
// Images (user attachments as data URLs, the activity icon served by the host) are inlined
// as base64, so the result is one portable file with no companion folder.
//
// The snapshot is NOT inert. A handful of the panel's affordances still make sense to a
// reader in a browser — opening a tool card, "Show more" on a long prompt, copying a prompt,
// an answer or a code block, enlarging an attached image — so the document carries a small
// inline script (EXPORT_SCRIPT) that re-implements exactly those, and nothing that talks to
// the host. Everything else interactive is disarmed.

/** The timeline's root element. The export is meaningless without it. */
function timelineRoot(): HTMLElement | null {
  return document.querySelector('.timeline');
}

/**
 * Collects the CSS the export needs. The webview's bundle is a single `main.css` served
 * from the extension's dist, so `cssRules` is readable (same-origin); when a sheet is
 * cross-origin the browser throws on access and we skip it — that only costs styling for
 * sheets we do not own.
 *
 * @font-face rules pointing at host-served files are dropped: their URLs only resolve inside
 * the webview, so in a browser they are just failed requests.
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
    for (const rule of Array.from(rules)) {
      const text = rule.cssText;
      if (text.startsWith('@font-face') && /url\(\s*["']?(?!data:)/i.test(text)) continue;
      out.push(text);
    }
  }
  // A stray "</style" inside a rule (a content: string, say) would end the <style> element.
  return out.join('\n').replace(/<\/style/gi, '<\\/style');
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

// ---------------------------------------------------------------------------------------
// Capture: getting every collapsible's body into the DOM
// ---------------------------------------------------------------------------------------

/**
 * Heads of the collapsibles that are CLOSED right now. React only mounts a card's body
 * while it is open, so a closed card has nothing to export. The chevron is the card's own
 * statement of its state ("▸" closed, "▾" open) and is rendered from the same `open` value
 * that decides whether the body is mounted — the one signal that cannot disagree with it.
 */
function closedHeads(root: HTMLElement): HTMLButtonElement[] {
  const heads = root.querySelectorAll<HTMLButtonElement>(
    '.tool-card > button.tool-head, .todo-inline > button.todo-inline-head',
  );
  return Array.from(heads).filter((h) => h.querySelector('.chevron')?.textContent?.trim() === '▸');
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/**
 * Opens every closed card by clicking its head — the same gesture the user makes, so it goes
 * through each card's own state and does not depend on how a global "expand all" propagates
 * (that route raced the cards' useEffect re-sync and shipped exports with every tool card
 * closed). Then waits, frame by frame, until no head reports itself closed. Returns the heads
 * it opened, so `closeAgain` can put the user's view back exactly as it was.
 */
async function openAll(root: HTMLElement): Promise<HTMLButtonElement[]> {
  const opened = closedHeads(root);
  for (const head of opened) head.click();
  for (let i = 0; i < 120 && closedHeads(root).length > 0; i++) await nextFrame();
  return opened;
}

function closeAgain(opened: HTMLButtonElement[]): void {
  for (const head of opened) {
    if (head.isConnected && head.querySelector('.chevron')?.textContent?.trim() === '▾') head.click();
  }
}

// ---------------------------------------------------------------------------------------
// Transform: live panel markup -> standalone document markup
// ---------------------------------------------------------------------------------------

/**
 * Re-homes each collapsible (tool card, thinking block, task checklist) into a native
 * <details>/<summary>: the header becomes the summary, the rest becomes the content, and the
 * browser does the toggling. Tool and thinking cards are written out CLOSED (a document that
 * opens with every tool call unrolled is unreadable); the checklist keeps the panel's default
 * of open.
 *
 * A card without a body (a tool still running, an empty result) is left as a plain header
 * and loses its chevron — a marker that reveals nothing would be a lie.
 */
function makeCollapsible(root: HTMLElement): void {
  const doc = root.ownerDocument;
  const convert = (card: HTMLElement, head: HTMLElement, open: boolean) => {
    const details = doc.createElement('details');
    details.className = card.className;
    if (open) details.open = true;
    const summary = doc.createElement('summary');
    summary.className = head.className;
    summary.innerHTML = head.innerHTML;
    // The live chevron is a character frozen at render time; the summary's ::after (see the
    // export CSS) replaces it and follows the real open state.
    for (const ch of Array.from(summary.querySelectorAll('.chevron'))) ch.remove();
    head.remove();
    details.appendChild(summary);
    // Everything else the card carried (the EndConversation banner, the body) keeps its order.
    while (card.firstChild) details.appendChild(card.firstChild);
    card.replaceWith(details);
  };

  for (const card of Array.from(root.querySelectorAll<HTMLElement>('.tool-card'))) {
    const head = card.querySelector<HTMLElement>(':scope > .tool-head');
    if (!head) continue;
    if (card.querySelector(':scope > .tool-body')) convert(card, head, false);
    else for (const ch of Array.from(head.querySelectorAll('.chevron'))) ch.remove();
  }
  for (const card of Array.from(root.querySelectorAll<HTMLElement>('.todo-inline'))) {
    const head = card.querySelector<HTMLElement>(':scope > .todo-inline-head');
    if (head && card.querySelector(':scope > .todos-list')) convert(card, head, true);
  }
}

/**
 * The copy buttons copy the SOURCE, not what is painted: a prompt's raw text, an answer's
 * Markdown. That text lives in React props, not in the DOM, so the caller hands it in by item
 * id and it is stamped on the button as `data-copy`, where the export script reads it.
 */
function wireCopy(root: HTMLElement, textOf?: (id: string) => string | undefined): void {
  for (const btn of Array.from(root.querySelectorAll<HTMLElement>('.msg-copy'))) {
    const owner = btn.closest<HTMLElement>('[data-item-id], .bubble.user[id^="msg-"]');
    const id = owner?.dataset.itemId ?? owner?.id.replace(/^msg-/, '');
    let text = id ? textOf?.(id) : undefined;
    // No source handed in: fall back to the text as painted, which is still the content.
    if (text === undefined) {
      text = (owner?.querySelector('pre.user-hl, .content .md') ?? owner)?.textContent ?? '';
    }
    btn.setAttribute('data-copy', text);
  }
}

/** "Show more"/"Show less" need both labels in the file; the live button only shows one. */
function wireToggles(root: HTMLElement, labels: ExportLabels): void {
  for (const btn of Array.from(root.querySelectorAll<HTMLElement>('.bubble-toggle'))) {
    btn.setAttribute('data-more', labels.showMore);
    btn.setAttribute('data-less', labels.showLess);
  }
}

/**
 * Links. External ones open in a new tab instead of replacing the document. File links in
 * the panel are workspace-relative paths the HOST resolves on click; in a file on disk they
 * would resolve against the file's own folder, so they are rebased onto the workspace root
 * (`linkBase` — the export knows where the host writes it) and absolute Windows paths become
 * file:/// URLs. The `#L12` line anchor is kept: harmless for a browser, useful to a reader.
 */
function fixLinks(root: HTMLElement, linkBase: string): void {
  for (const a of Array.from(root.querySelectorAll<HTMLAnchorElement>('a[href]'))) {
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[a-z]:[\\/]/i.test(href)) {
      if (/^(https?|mailto):/i.test(href)) {
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
      }
      continue;
    }
    const hash = href.indexOf('#');
    const path = hash < 0 ? href : href.slice(0, hash);
    const frag = hash < 0 ? '' : href.slice(hash);
    const slashed = path.replace(/\\/g, '/');
    const url = /^[a-z]:\//i.test(slashed)
      ? `file:///${slashed}`
      : slashed.startsWith('//')
        ? `file:${slashed}` // UNC
        : slashed.startsWith('/')
          ? `file://${slashed}`
          : `${linkBase}${slashed.replace(/^\.\//, '')}`;
    a.setAttribute('href', encodeURI(url) + frag);
  }
}

/**
 * Strips what only makes sense in a live panel. Buttons that talk to the host (rewind, the
 * file chips, "View") or that the export re-implements differently (image buttons) are
 * unwrapped into spans — keeping label and classes, so the layout is unchanged — or removed
 * when they would be pure noise. The buttons the export script drives stay buttons.
 */
const KEEP_BUTTONS = '.msg-copy, .code-copy, .bubble-toggle';

function neutralizeInteractive(root: HTMLElement): void {
  const doc = root.ownerDocument;
  // Host-only actions: rewind the conversation, open a file preview in the editor.
  for (const el of Array.from(root.querySelectorAll('.msg-rewind, .tool-view, .activity'))) el.remove();
  for (const el of Array.from(root.querySelectorAll('button'))) {
    if (el.matches(KEEP_BUTTONS)) {
      el.setAttribute('type', 'button');
      continue;
    }
    const span = doc.createElement('span');
    span.className = el.className;
    if (el.title) span.title = el.title;
    span.innerHTML = el.innerHTML;
    el.replaceWith(span);
  }
  for (const el of Array.from(root.querySelectorAll('input, textarea, select, script'))) el.remove();
  for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
    for (const attr of Array.from(el.attributes)) {
      // Event handlers cannot survive serialisation anyway; tabindex/role only made the
      // tooltip wrappers and the file chips focusable "links" to the host.
      if (attr.name.startsWith('on') || attr.name === 'tabindex' || attr.name === 'role') {
        el.removeAttribute(attr.name);
      }
    }
  }
  // The last prompt sticks to the top of the panel while its answer streams. In a document
  // read from the top it would sit over every turn after it.
  for (const el of Array.from(root.querySelectorAll('.pinned-wrap, .pinned'))) {
    el.classList.remove('pinned-wrap', 'pinned');
  }
  // The live "Claude ▋" caret blinks while a turn streams; frozen, it is just a stray glyph.
  for (const el of Array.from(root.querySelectorAll('.caret'))) el.remove();
}

/** Escapes text going into the document's title/header. */
function esc(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The document's own behaviour, plain ES2017 with no dependencies. One delegated click
 * handler: copy (msg-copy → its data-copy; code-copy → the code block's text), "Show more",
 * and the image viewer. Clipboard: the async API where the page is a secure context (file://
 * is one in Chromium), else the execCommand fallback — the same pair SelectionCopy uses.
 */
const EXPORT_SCRIPT = `(function () {
  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.top = '-1000px';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove();
    if (!ok) throw new Error('copy failed');
  }
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).catch(function () { legacyCopy(text); });
    }
    return new Promise(function (resolve) { legacyCopy(text); resolve(); });
  }
  function flash(btn, ok) {
    if (!btn.hasAttribute('data-glyph')) btn.setAttribute('data-glyph', btn.textContent);
    btn.textContent = ok ? '\\u2713' : '\\u2717';
    btn.classList.add('export-copied');
    clearTimeout(btn.__t);
    btn.__t = setTimeout(function () {
      btn.textContent = btn.getAttribute('data-glyph');
      btn.classList.remove('export-copied');
    }, 1200);
  }
  function codeOf(btn) {
    var pre = btn.closest('pre.md-code');
    var code = pre && pre.querySelector('code');
    return code ? code.textContent : '';
  }
  function closeViewer() {
    var v = document.querySelector('.export-viewer');
    if (v) v.remove();
  }
  document.addEventListener('click', function (e) {
    var el = e.target;
    if (!(el instanceof Element)) return;
    var viewer = el.closest('.export-viewer');
    if (viewer) { closeViewer(); return; }
    var copy = el.closest('.msg-copy, .code-copy');
    if (copy) {
      e.preventDefault();
      e.stopPropagation();
      var text = copy.hasAttribute('data-copy') ? copy.getAttribute('data-copy') : codeOf(copy);
      copyText(text || '').then(function () { flash(copy, true); }, function () { flash(copy, false); });
      return;
    }
    var toggle = el.closest('.bubble-toggle');
    if (toggle) {
      var bubble = toggle.closest('.bubble');
      var pre = bubble && bubble.querySelector('pre.user-hl');
      if (pre) {
        var clamped = pre.classList.toggle('user-hl--clamp');
        toggle.textContent = toggle.getAttribute(clamped ? 'data-more' : 'data-less');
      }
      return;
    }
    var img = el.closest('.bubble-image');
    if (img) {
      closeViewer();
      var box = document.createElement('div');
      box.className = 'export-viewer';
      var big = document.createElement('img');
      big.src = img.getAttribute('src');
      big.alt = '';
      box.appendChild(big);
      document.body.appendChild(box);
    }
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeViewer();
  });
})();`;

const EXPORT_CSS = `
/* Snapshot-only: the panel is a fixed-height flex column sized by the editor. A document
   scrolls with the page instead, and the exported timeline gets a readable margin. */
html, body, #root, .app, .scroll { height: auto; overflow: visible; }
#root { border-left: none; }
body { padding: 16px 20px 40px; }
.export-header { margin: 0 0 20px; padding-bottom: 12px; border-bottom: 1px solid var(--vscode-panel-border, #353537); }
.export-header h1 { margin: 0 0 4px; font-size: 18px; font-weight: 600; }
.export-header .export-when { font-size: 12px; opacity: 0.7; }
/* The cards became <details>/<summary>. The head is display:flex, which suppresses the native
   marker in every engine, so the chevron is drawn back as a pseudo-element that follows the
   open state — the same two glyphs the panel uses. */
summary { list-style: none; cursor: pointer; }
summary::-webkit-details-marker { display: none; }
summary.tool-head::after { content: '\\25B8'; margin-left: auto; opacity: 0.6; }
details[open] > summary.tool-head::after { content: '\\25BE'; }
summary.todo-inline-head::after { content: '\\25B8'; margin-left: 8px; opacity: 0.6; }
details[open] > summary.todo-inline-head::after { content: '\\25BE'; }
/* A head with no body to reveal is not clickable. */
span.tool-head { cursor: default; }
span.tool-head:hover { background: transparent; }
/* File chips opened the file in the editor; here they are labels. */
.tool-file { cursor: default; }
.tool-file:hover { text-decoration: none; color: var(--vscode-foreground); }
/* A document is not a fixed-height panel: let the bodies run to their full length instead
   of opening an inner scrollbar the reader has to find. */
.tool-body { max-height: none; overflow: visible; }
/* Copy buttons appear on hover in the panel; keyboard and touch readers need them reachable. */
.msg-copy:focus-visible, .code-copy:focus-visible { opacity: 1; }
.msg-copy.export-copied { opacity: 1; }
.bubble-image { cursor: zoom-in; }
.export-viewer { position: fixed; inset: 0; z-index: 2000; display: flex; align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.8); cursor: zoom-out; }
.export-viewer img { max-width: 95vw; max-height: 95vh; object-fit: contain; }
@media print {
  .msg-copy, .code-copy, .bubble-toggle { display: none; }
  .user-hl--clamp { display: block; -webkit-line-clamp: unset; overflow: visible; }
}
`;

export interface ExportLabels {
  showMore: string;
  showLess: string;
}

export interface TimelineCaptureOptions {
  /** Names the document; also the visible header. */
  title: string;
  /** Caption under the title ("Exported on …"), already in the webview's language. */
  generatedAt: string;
  labels: ExportLabels;
  /** Source text of a user/assistant item by id — what the copy buttons copy. */
  textOf?: (id: string) => string | undefined;
  /**
   * Prefix that turns a workspace-relative path into one relative to the saved file:
   * '../../' for the auto-save under .cockpit/TimeLine/, '' for a file at the project root.
   */
  linkBase?: string;
}

/** Builds the document from an already prepared (fully opened) live timeline. */
async function buildDocument(root: HTMLElement, o: TimelineCaptureOptions): Promise<string> {
  const css = collectCss();
  const vars = collectThemeVars();
  const clone = root.cloneNode(true) as HTMLElement;
  makeCollapsible(clone); // before neutralize: it needs the headers still as <button>
  wireCopy(clone, o.textOf);
  wireToggles(clone, o.labels);
  fixLinks(clone, o.linkBase ?? '');
  neutralizeInteractive(clone);
  await inlineImages(clone);

  // The wrapper reproduces the panel's own nesting (#root > .app > .scroll) so the
  // selectors in styles.css that depend on those ancestors still apply.
  return `<!DOCTYPE html>
<html lang="${esc(document.documentElement.lang || 'en')}">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${esc(o.title)}</title>
<style>
:root {
${vars}
}
${css}
${EXPORT_CSS}
</style>
</head>
<body class="${esc(document.body.className)}">
<div id="root"><div class="app">
<header class="export-header">
<h1>${esc(o.title)}</h1>
<div class="export-when">${esc(o.generatedAt)}</div>
</header>
<div class="scroll">${clone.outerHTML}</div>
</div></div>
<script>
${EXPORT_SCRIPT}
</script>
</body>
</html>`;
}

// Captures are serialised: the auto-save at the end of a turn and a click on the export
// button can overlap, and the second one would see the first one's opened cards as the
// user's own state — and leave them open afterwards.
let queue: Promise<unknown> = Promise.resolve();

/**
 * Captures the timeline on screen as a standalone document. Opens every collapsed card for
 * the duration of the capture (a closed card has no body in the DOM to carry), then closes
 * exactly the ones it opened and restores the scroll position, so the user's view is left as
 * it was. Returns undefined when there is no timeline on screen.
 */
export function captureTimelineHtml(o: TimelineCaptureOptions): Promise<string | undefined> {
  const run = queue.then(async () => {
    const root = timelineRoot();
    if (!root) return undefined;
    const scroller = root.closest<HTMLElement>('.scroll');
    const top = scroller?.scrollTop;
    const opened = await openAll(root);
    try {
      return await buildDocument(root, o);
    } finally {
      closeAgain(opened);
      if (scroller && top !== undefined) {
        await nextFrame();
        scroller.scrollTop = top;
      }
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

/**
 * File name for the auto-saved timeline. Unlike `suggestedHtmlName`, this keeps the tab's
 * own title as the name (that is what the user sees on the tab) rather than a slug+date —
 * the file is overwritten each turn, so one stable, recognisable name per conversation is
 * the point. Only characters a file system cannot hold are stripped; spaces and case stay.
 */
export function timelineFileName(title?: string): string {
  const clean = (title || 'Conversa')
    // Windows forbids \ / : * ? " < > | and trailing dots/spaces; strip them and collapse runs.
    .replace(/[\\/:*?"<>|]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 80)
    .trim();
  return `${clean || 'Conversa'}.html`;
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
