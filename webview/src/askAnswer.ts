// Formato da resposta de um AskUserQuestion: as escolhas, separadas por vírgula, seguidas do
// texto que o usuário acrescentou àquela pergunta. Um único lugar define o separador — o modal
// escreve, o card da timeline lê.

// As escolhas ficam na primeira linha; o texto acrescentado, nas seguintes.
export const ANSWER_NOTE_SEP = '\n';

/** Junta escolhas e texto acrescentado. Só o texto também é resposta válida. */
export function joinAnswer(choices: string, note: string): string {
  const n = note.trim();
  if (!n) return choices;
  return choices ? `${choices}${ANSWER_NOTE_SEP}${n}` : n;
}

/**
 * Desfaz o join. Só corta quando a primeira linha são de fato escolhas conhecidas: uma resposta
 * puramente escrita — mesmo com várias linhas — segue inteira (o card a mostra como "Outro").
 */
export function splitAnswerNote(ans: string, known: Set<string>): { core: string; note?: string } {
  const at = ans.indexOf(ANSWER_NOTE_SEP);
  if (at < 0) return { core: ans };
  const core = ans.slice(0, at).trim();
  const toks = core
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!toks.length || !toks.every((tk) => known.has(tk))) return { core: ans };
  return { core, note: ans.slice(at + ANSWER_NOTE_SEP.length).trim() };
}
