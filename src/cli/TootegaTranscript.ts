// Reads the Tootega agent's transcript and turns it into timeline items.
//
// The agent writes the conversation to disk after every turn, because it exits
// when idle and the next message must find it. That file is also what lets a
// panel repaint: a hidden webview is destroyed by VSCode and re-mounts empty,
// so `replayTab` has to be able to answer with the real conversation. Answering
// with an empty list looks like the turn vanished.
//
// Shape on disk: the OpenAI message list the agent sends to the server —
// `[{role,content}, {role:'assistant',content,tool_calls:[...]}, {role:'tool',
// tool_call_id,content}, ...]`.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { HistoryItem } from '../../shared/protocol';

interface RawToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}
interface RawMessage {
  role?: string;
  content?: string;
  tool_calls?: RawToolCall[];
  tool_call_id?: string;
}

/** Same location the agent writes to. */
export function tootegaSessionsDir(): string {
  const base =
    process.platform === 'win32'
      ? (process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'))
      : os.homedir();
  return process.platform === 'win32'
    ? path.join(base, 'tootega', 'sessions')
    : path.join(base, '.tootega', 'sessions');
}

/** Timeline of a Tootega session. Empty when there is no transcript yet. */
export function loadTootegaTranscript(sessionId: string): HistoryItem[] {
  if (!sessionId) return [];
  let raw: RawMessage[];
  try {
    const text = fs.readFileSync(path.join(tootegaSessionsDir(), `${sessionId}.json`), 'utf8');
    raw = JSON.parse(text) as RawMessage[];
    if (!Array.isArray(raw)) return [];
  } catch {
    return []; // no transcript yet: a session that has not answered once
  }

  const items: HistoryItem[] = [];
  const byCallId = new Map<string, Extract<HistoryItem, { kind: 'tool' }>>();
  let seq = 0;

  for (const m of raw) {
    // The system prompt is ours, not the conversation: showing it would put a
    // wall of instructions at the top of every reopened tab.
    if (m.role === 'system') continue;

    if (m.role === 'user') {
      items.push({ kind: 'user', id: `h${seq++}`, text: m.content ?? '' });
      continue;
    }

    if (m.role === 'assistant') {
      // The reasoning is kept out of `text`, the same split the live stream does.
      const body = m.content ?? '';
      const close = body.indexOf('</think>');
      const thinking = close >= 0 ? body.slice(0, close) : '';
      let text = close >= 0 ? body.slice(close + 8) : body;
      // A turn that only called a tool carries the raw markup in `content`.
      const call = text.indexOf('<tool_call>');
      if (call >= 0) text = text.slice(0, call);
      text = text.trim();
      if (text || thinking.trim()) {
        items.push({ kind: 'assistant', id: `h${seq++}`, text, thinking: thinking.trim() });
      }
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {};
        try {
          input = JSON.parse(tc.function?.arguments ?? '{}');
        } catch {
          input = { arguments: tc.function?.arguments ?? '' };
        }
        const item: Extract<HistoryItem, { kind: 'tool' }> = {
          kind: 'tool',
          id: tc.id ?? `h${seq++}`,
          name: tc.function?.name ?? 'tool',
          input,
        };
        items.push(item);
        if (tc.id) byCallId.set(tc.id, item);
      }
      continue;
    }

    if (m.role === 'tool') {
      // The result goes INTO the card that asked for it, not as a loose item.
      const card = m.tool_call_id ? byCallId.get(m.tool_call_id) : undefined;
      if (card) card.result = m.content ?? '';
    }
  }

  return items;
}
