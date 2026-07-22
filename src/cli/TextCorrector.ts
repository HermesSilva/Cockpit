// Spelling/grammar correction of dictated text, via Haiku. Uses the reusable
// AiClient helper (direct Messages API, clean: only instruction + text, ~1.7s).
import { ask } from './AiClient';

// The instruction is in English; the ANSWER must stay in the user's language — stated
// explicitly so the model never translates the dictated text.
const SYSTEM =
  "Fix only spelling, accentuation and grammar mistakes in the user's text. " +
  'Keep exactly the same language, meaning and tone — never translate. ' +
  'Answer ONLY with the corrected text — no comments, no quotes, no prefixes.';

/**
 * Corrects the text. `hints` (from the dictation dictionary) steers the model to keep
 * terms/jargon and to apply replacements. Returns the corrected text, or undefined on
 * failure (keeps the original).
 */
export function correctText(text: string, hints?: string): Promise<string | undefined> {
  return ask({
    system: hints ? `${SYSTEM} ${hints}` : SYSTEM,
    prompt: text,
    maxTokens: Math.min(4096, Math.max(256, Math.ceil(text.length / 2) + 256)),
  });
}
