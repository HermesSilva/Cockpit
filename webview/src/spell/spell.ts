// Cliente do corretor ortográfico. A engine (hunspell-asm) roda no HOST; aqui só
// mantemos um cache de veredito por palavra e falamos com o host por mensagem.
// Fluxo: o overlay pergunta isMisspelled(palavra) ao pintar; palavras ainda
// desconhecidas entram numa fila, vão ao host em lote (debounced) e, quando a
// resposta chega, o cache é atualizado e o overlay re-renderiza (onSpellUpdate).
import { send } from '../vscodeApi';

const verdict = new Map<string, boolean>(); // palavra -> tem erro
const ignored = new Set<string>(); // ignoradas nesta sessão
const pending = new Set<string>(); // a checar no próximo flush
const inFlight = new Set<string>(); // já enviadas, aguardando resposta
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
      // Tudo que foi enviado e não voltou como "bad" é correto.
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

/** Inicia o cliente (idempotente). Não bloqueia: o host carrega em 2º plano. */
export function ensureSpell(): Promise<void> {
  ensureListener();
  return Promise.resolve();
}

// Host-backed: a marcação acontece conforme os vereditos chegam.
export function spellReady(): boolean {
  return true;
}

/** Registra callback p/ re-render do overlay quando chega veredito novo. */
export function onSpellUpdate(cb: () => void): () => void {
  updateCbs.add(cb);
  return () => updateCbs.delete(cb);
}

/** Erro conhecido? Palavra inédita entra na fila de checagem (retorna false até saber). */
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

/** Sugestões (assíncrono — vêm do host). */
export function suggest(word: string): Promise<Suggestions> {
  ensureListener();
  const requestId = `s${reqSeq++}`;
  return new Promise<Suggestions>((resolve) => {
    suggestWaiters.set(requestId, resolve);
    send({ kind: 'spellSuggest', requestId, word });
    // Falha-segura: se o host não responder, resolve vazio.
    setTimeout(() => {
      if (suggestWaiters.delete(requestId)) resolve({ pt: [], en: [] });
    }, 4000);
  });
}

// Distância de Levenshtein (limitada — só p/ decidir confiança).
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

// Replica o padrão de caixa da palavra original na sugestão.
function applyCase(word: string, cand: string): string {
  if (word === word.toUpperCase() && word !== word.toLowerCase()) return cand.toUpperCase();
  if (word[0] === word[0]?.toUpperCase()) return cand[0].toUpperCase() + cand.slice(1);
  return cand;
}

/**
 * Correção de ALTA CONFIANÇA p/ autocorreção ao teclar espaço/pontuação. Só
 * devolve a sugestão quando o erro é claro e o melhor candidato está a uma
 * distância mínima (1, ou 2 p/ palavras longas) — senão null (não mexe).
 */
export async function autoCorrection(word: string): Promise<string | null> {
  if (word.length < 4) return null; // curtas: risco de falso positivo
  if (!isMisspelled(word) || isIgnored(word)) return null;
  const sug = await suggest(word);
  const lower = word.toLowerCase();
  const maxDist = word.length >= 6 ? 2 : 1;
  let best: string | null = null;
  let bestDist = 99;
  // Considera os 2 primeiros de cada idioma (os mais prováveis do hunspell).
  for (const cand of [...sug.pt.slice(0, 2), ...sug.en.slice(0, 2)]) {
    if (!cand || /\s/.test(cand)) continue; // ignora sugestões multi-palavra
    const d = editDistance(lower, cand.toLowerCase());
    if (d < bestDist) {
      bestDist = d;
      best = cand;
    }
  }
  if (!best || bestDist > maxDist || best.toLowerCase() === lower) return null;
  return applyCase(word, best);
}

/** Adiciona ao dicionário do usuário (persistente no host) e desmarca já. */
export function addUserWord(word: string): void {
  send({ kind: 'spellAdd', word });
  ignored.add(word); // efeito imediato no overlay
  verdict.set(word, false);
}

// "Ignorar" persiste no dicionário do corretor (host) — assim a palavra fica
// gerenciável no modal e sobrevive entre sessões, como o usuário espera.
export function ignoreWord(word: string): void {
  send({ kind: 'spellAdd', word });
  ignored.add(word);
  verdict.set(word, false);
}

/** Zera os caches locais (após editar o dicionário do corretor no modal) p/ que
 *  o overlay re-consulte o host com o dicionário atualizado. */
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
