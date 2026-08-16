// Defensive recovery for a model glitch: when the CLI's assistant emits a tool_use whose
// input has many non-ASCII characters, it OCCASIONALLY writes the escape flattened — `u00f3`
// instead of `ó`. The JSON is valid (the string literally holds the five chars `u`,`0`,
// `0`,`f`,`3`), so JSON.parse cannot fix it and the text shows up as `su00f3` for `só`.
// This is a generation artifact upstream (see the transcript audit: user input is clean,
// only some assistant blocks carry it); we cannot fix the source, so we repair on display.
//
// SAFETY: we only touch an orphan `uXXXX` — one NOT preceded by a backslash (a real `ó`
// never reaches here as text; JSON.parse already turned it into `ó`). We also restrict the
// code point to the ranges the model actually flattens in prose — Latin-1 Supplement, Latin
// Extended-A/B and common punctuation/dashes/quotes — so we never rewrite a legitimate token
// like `u0000` or a hex id that happens to sit in running text.

// `(^|[^\\])` keeps the char before the escape so a real `\uXXXX` is left alone.
const ORPHAN_UNICODE = /(^|[^\\])u([0-9a-fA-F]{4})/g;

function inRepairRange(cp: number): boolean {
  // Latin-1 Supplement + Latin Extended-A/B (accented letters, ç, etc.).
  if (cp >= 0x00a0 && cp <= 0x024f) return true;
  // General punctuation the model tends to flatten: dashes, curly quotes, ellipsis…
  if (cp >= 0x2010 && cp <= 0x2027) return true;
  return false;
}

/** Recovers flattened `uXXXX` escapes in text produced by the model. Idempotent and safe. */
export function decodeFlattenedUnicode(s: string): string {
  if (!s || s.indexOf('u') < 0) return s;
  return s.replace(ORPHAN_UNICODE, (m, pre: string, hex: string) => {
    const cp = parseInt(hex, 16);
    return inRepairRange(cp) ? pre + String.fromCharCode(cp) : m;
  });
}
