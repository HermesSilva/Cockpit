// Correção ortográfica/gramatical do texto ditado, via Haiku. Usa o helper
// reusável AiClient (Messages API direta, limpa: só instrução + texto, ~1.7s).
import { ask } from './AiClient';

const SYSTEM =
  'Corrija apenas erros de ortografia, acentuação e gramática do texto do usuário. ' +
  'Mantenha exatamente a mesma língua, sentido e tom. ' +
  'Responda SOMENTE com o texto corrigido — sem comentários, sem aspas, sem prefixos.';

/**
 * Corrige o texto. `hints` (do dicionário de ditado) orienta o modelo a preservar
 * termos/jargão e aplicar substituições. Retorna o corrigido, ou undefined em
 * falha (mantém original).
 */
export function correctText(text: string, hints?: string): Promise<string | undefined> {
  return ask({
    system: hints ? `${SYSTEM} ${hints}` : SYSTEM,
    prompt: text,
    maxTokens: Math.min(4096, Math.max(256, Math.ceil(text.length / 2) + 256)),
  });
}
