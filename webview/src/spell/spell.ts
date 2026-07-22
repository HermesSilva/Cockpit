// Spell-checker client. The engine (hunspell-asm) runs in the HOST; here we only
// keep a per-word verdict cache and talk to the host by message.
// Flow: the overlay asks isMisspelled(word) while painting; words still
// unknown enter a queue, go to the host in a batch (debounced) and, when the
// answer arrives, the cache is updated and the overlay re-renders (onSpellUpdate).
import { send } from '../vscodeApi';

const verdict = new Map<string, boolean>(); // word -> is wrong
const ignored = new Set<string>(); // ignored in this session
const pending = new Set<string>(); // to check on the next flush
const inFlight = new Set<string>(); // already sent, awaiting an answer
let flushTimer: ReturnType<typeof setTimeout> | undefined;
const updateCbs = new Set<() => void>();
const suggestWaiters = new Map<string, (s: Suggestions) => void>();
let listening = false;
let reqSeq = 0;

export interface Suggestions {
  pt: string[];
  en: string[];
}

function ensureListener(): void {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (e: MessageEvent) => {
    const m = e.data;
    if (m?.kind === 'spellResult') {
      // Everything that was sent and didn't come back as "bad" is correct.
      const bad = new Set<string>(m.bad as string[]);
      for (const w of inFlight) verdict.set(w, bad.has(w));
      inFlight.clear();
      for (const cb of updateCbs) cb();
    } else if (m?.kind === 'spellSuggestResult') {
      const w = suggestWaiters.get(m.requestId);
      if (w) {
        suggestWaiters.delete(m.requestId);
        w({ pt: m.pt ?? [], en: m.en ?? [] });
      }
    }
  });
}

function flush(): void {
  flushTimer = undefined;
  if (pending.size === 0) return;
  const words = [...pending];
  pending.clear();
  for (const w of words) inFlight.add(w);
  send({ kind: 'spellCheck', words });
}

/** Starts the client (idempotent). Non-blocking: the host loads in the background. */
export function ensureSpell(): Promise<void> {
  ensureListener();
  return Promise.resolve();
}

// Host-backed: the marking happens as the verdicts arrive.
export function spellReady(): boolean {
  return true;
}

/** Registers a callback to re-render the overlay when a new verdict arrives. */
export function onSpellUpdate(cb: () => void): () => void {
  updateCbs.add(cb);
  return () => updateCbs.delete(cb);
}

/** Known error? An unseen word enters the check queue (returns false until known). */
export function isMisspelled(word: string): boolean {
  if (ignored.has(word)) return false;
  const v = verdict.get(word);
  if (v !== undefined) return v;
  if (!inFlight.has(word) && !pending.has(word)) {
    pending.add(word);
    if (!flushTimer) flushTimer = setTimeout(flush, 200);
  }
  return false;
}

/** Suggestions (asynchronous — they come from the host). */
export function suggest(word: string): Promise<Suggestions> {
  ensureListener();
  const requestId = `s${reqSeq++}`;
  return new Promise<Suggestions>((resolve) => {
    suggestWaiters.set(requestId, resolve);
    send({ kind: 'spellSuggest', requestId, word });
    // Fail-safe: when the host doesn't answer, it resolves empty.
    setTimeout(() => {
      if (suggestWaiters.delete(requestId)) resolve({ pt: [], en: [] });
    }, 4000);
  });
}

// Levenshtein distance (bounded — only to decide confidence).
function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > 3) return 99;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

// Replicates the case pattern of the original word in the suggestion.
function applyCase(word: string, cand: string): string {
  if (word === word.toUpperCase() && word !== word.toLowerCase()) return cand.toUpperCase();
  if (word[0] === word[0]?.toUpperCase()) return cand[0].toUpperCase() + cand.slice(1);
  return cand;
}

/**
 * HIGH-CONFIDENCE correction for autocorrect when typing space/punctuation. It only
 * returns the suggestion when the error is clear and the best candidate is within a
 * minimum distance (1, or 2 for long words) — otherwise null (it doesn't touch it).
 */
export async function autoCorrection(word: string): Promise<string | null> {
  if (word.length < 4) return null; // curtas: risco de falso positivo
  if (!isMisspelled(word) || isIgnored(word)) return null;
  const sug = await suggest(word);
  const lower = word.toLowerCase();
  const maxDist = word.length >= 6 ? 2 : 1;
  let best: string | null = null;
  let bestDist = 99;
  // Considers the first 2 of each language (hunspell's most likely).
  for (const cand of [...sug.pt.slice(0, 2), ...sug.en.slice(0, 2)]) {
    if (!cand || /\s/.test(cand)) continue; // ignores multi-word suggestions
    const d = editDistance(lower, cand.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  if (!best || bestDist > maxDist || best.toLowerCase() === lower) return null;
  return applyCase(word, best);
}

/** Adds it to the user dictionary (persistent in the host) and unmarks it right away. */
export function addUserWord(word: string): void {
  send({ kind: 'spellAdd', word });
  ignored.add(word); // efeito imediato no overlay
  verdict.set(word, false);
}

// "Ignore" persists in the spell-checker dictionary (host) — that way the word stays
// manageable in the modal and survives across sessions, as the user expects.
export function ignoreWord(word: string): void {
  send({ kind: 'spellAdd', word });
  ignored.add(word);
  verdict.set(word, false);
}

/** Clears the local caches (after editing the spell-checker dictionary in the modal) so
 *  the overlay re-queries the host with the updated dictionary. */
export function resetSpell(): void {
  verdict.clear();
  ignored.clear();
  pending.clear();
  inFlight.clear();
  for (const cb of updateCbs) cb();
}
export function isIgnored(word: string): boolean {
  return ignored.has(word);
}
