// One assistant response can become SEVERAL lines in the .jsonl (one text block,
// one block per tool_use). All of them repeat the SAME `usage` object — summing
// linha a linha infla o total (medido: ~59% a mais em 7 dias). Contamos a usage
// once per response, identified by message.id + requestId.
//
// The duplication is always within the same file (consecutive lines of the same
// response), never across files — so one Set per file is enough.

/** Response identity for deduplicating `usage`. undefined = do not deduplicate. */
export function usageKey(entry: any): string | undefined {
  const id = entry?.message?.id;
  const req = entry?.requestId;
  if (typeof id !== 'string' || !id) return undefined; // sem id: conta a linha
  return `${id}:${typeof req === 'string' ? req : ''}`;
}
