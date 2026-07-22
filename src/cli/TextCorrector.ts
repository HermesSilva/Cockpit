// Spelling/grammar correction of dictated text, via Haiku. Uses the reusable
// AiClient helper (direct Messages API, clean: only instruction + text, ~1.7s).
import { ask } from './AiClient';

const SYSTEM =
  'Corrija apenas erros de ortografia, acentuação e gramática do texto do usuário. ' +
  'Mantenha exatamente a mesma língua, sentido e tom. ' +
  'Responda SOMENTE com o texto corrigido — sem comentários, sem aspas, sem prefixos.';

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
