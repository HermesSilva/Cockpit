// Uma resposta do assistant pode virar VÁRIAS linhas no .jsonl (um bloco de
// texto, um bloco por tool_use). Todas repetem o MESMO objeto `usage` — somar
// linha a linha infla o total (medido: ~59% a mais em 7 dias). Contamos a usage
// uma vez por resposta, identificada por message.id + requestId.
//
// A duplicação é sempre dentro do mesmo arquivo (linhas consecutivas da mesma
// resposta), nunca entre arquivos — então um Set por arquivo basta.

/** Identidade da resposta p/ deduplicar `usage`. undefined = não deduplicar. */
export function usageKey(entry: any): string | undefined {
  const id = entry?.message?.id;
  const req = entry?.requestId;
  if (typeof id !== 'string' || !id) return undefined; // sem id: conta a linha
  return `${id}:${typeof req === 'string' ? req : ''}`;
}
