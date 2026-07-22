// Reads the sessions Claude Code persists in ~/.claude/projects/<cwd>/<id>.jsonl.
// Lists "existing contexts" and rebuilds the history for rendering.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SessionInfo, HistoryItem } from '../../shared/protocol';

/** Encodes the cwd in Claude Code's folder format (':' '\\' '/' -> '-'). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[:\\/]/g, '-');
}

function projectsDir(cwd: string): string {
  return path.join(os.homedir(), '.claude', 'projects', encodeCwd(cwd));
}

/** Removes BOM/zero-width and normalizes spaces (clean titles). */
function clean(s: string): string {
  return s.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim();
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: any) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b: any) => b.text)
      .join('');
  }
  return '';
}

function isMetaUserText(text: string): boolean {
  const t = clean(text);
  if (!t) return true;
  // skips command wrappers / system-reminders / background task
  // notifications (injected by the CLI itself) persisted in the transcript — they aren't
  // user messages and shouldn't become a "Hermes" bubble with raw XML.
  return (
    t.startsWith('<command-') ||
    t.startsWith('<local-command') ||
    t.startsWith('<system-reminder') ||
    t.startsWith('<task-notification')
  );
}

/** Lists the cwd's sessions, most recent first (default limit 50). */
export function listSessions(cwd: string, limit = 50): SessionInfo[] {
  const dir = projectsDir(cwd);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return [];
  }

  const out: SessionInfo[] = [];
  for (const file of files) {
    const full = path.join(dir, file);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(full);
    } catch {
      continue;
    }
    const id = file.replace(/\.jsonl$/, '');
    const s = summarize(full);
    const birth = stat.birthtimeMs && stat.birthtimeMs > 0 ? stat.birthtime : undefined;
    out.push({
      id,
      title: s.title,
      updatedAt: stat.mtime.toISOString(),
      messageCount: s.count,
      createdAt: birth ? birth.toISOString() : undefined,
      sizeBytes: stat.size,
      userCount: s.userCount,
      assistantCount: s.assistantCount,
      toolCount: s.toolCount,
      model: s.model,
    });
  }

  out.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  return out.slice(0, limit);
}

/** Id of the most recent session (by mtime) in the cwd, without reading the content. */
export function latestSessionId(cwd: string): string | undefined {
  const dir = projectsDir(cwd);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return undefined;
  }
  let best: { id: string; m: number } | undefined;
  for (const f of files) {
    try {
      const st = fs.statSync(path.join(dir, f));
      if (!best || st.mtimeMs > best.m) best = { id: f.replace(/\.jsonl$/, ''), m: st.mtimeMs };
    } catch {
      /* ignored */
    }
  }
  return best?.id;
}

/** Deletes a session's transcript. Returns true when removed. Irreversible. */
export function deleteSession(cwd: string, sessionId: string): boolean {
  const file = path.join(projectsDir(cwd), `${sessionId}.jsonl`);
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Rewinds the transcript: keeps only the lines BEFORE the one whose `uuid` matches
 * `uuid`, dropping the target prompt and everything after it. Writes atomically
 * (tmp + rename). Returns true when it cut. Irreversible.
 */
export function truncateTranscriptAt(cwd: string, sessionId: string, uuid: string): boolean {
  const file = path.join(projectsDir(cwd), `${sessionId}.jsonl`);
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return false;
  }
  const lines = content.split('\n');
  let cut = -1;
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    if (!ln.trim()) continue;
    try {
      if (JSON.parse(ln).uuid === uuid) {
        cut = i;
        break;
      }
    } catch {
      /* invalid line: ignored */
    }
  }
  if (cut < 0) return false;
  const kept = lines.slice(0, cut).join('\n').replace(/\n*$/, '\n');
  try {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, kept);
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/** Deletes every transcript (.jsonl) in the cwd. Returns how many were removed. Irreversible. */
export function deleteAllSessions(cwd: string): number {
  const dir = projectsDir(cwd);
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  } catch {
    return 0;
  }
  let removed = 0;
  for (const f of files) {
    try {
      fs.unlinkSync(path.join(dir, f));
      removed++;
    } catch {
      /* ignores locked/already removed files */
    }
  }
  return removed;
}

/**
 * Title and message count. Prefers the AI-generated title (`ai-title`, the most
 * recent wins) — the same one the /resume picker shows; falls back to the first user
 * message when the session is too short to have a title.
 */
interface Summary {
  title: string;
  count: number;
  userCount: number;
  assistantCount: number;
  toolCount: number;
  model?: string;
}

function summarize(file: string): Summary {
  let aiTitle = '';
  let firstUser = '';
  let count = 0;
  let userCount = 0;
  let assistantCount = 0;
  let toolCount = 0;
  let model: string | undefined;
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return { title: '', count: 0, userCount: 0, assistantCount: 0, toolCount: 0 };
  }
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'ai-title' && typeof o.aiTitle === 'string' && clean(o.aiTitle)) {
      aiTitle = clean(o.aiTitle); // o último prevalece
    } else if (o.type === 'user' || o.type === 'assistant') {
      if (!o.isMeta) count++;
      if (o.type === 'user' && !o.isMeta) {
        userCount++;
        if (!firstUser) {
          const text = textOfContent(o.message?.content);
          if (!isMetaUserText(text)) firstUser = clean(text);
        }
      } else if (o.type === 'assistant') {
        assistantCount++;
        if (typeof o.message?.model === 'string') model = o.message.model;
        const c = o.message?.content;
        if (Array.isArray(c)) {
          for (const b of c) if (b?.type === 'tool_use') toolCount++;
        }
      }
    } else if (o.type === 'system' && o.subtype === 'init' && typeof o.model === 'string') {
      model = o.model;
    }
  }
  // Web-style title: prefers the `ai-title` generated by the CLI (same as the /resume
  // picker); without it, uses the first user prompt TRUNCATED — a raw prompt can
  // be a whole paragraph and doesn't work as a session label.
  const title = aiTitle || truncateTitle(firstUser);
  return { title, count, userCount, assistantCount, toolCount, model };
}

/** Cuts the fallback at the first sentence/line break and caps it at ~60 chars. */
function truncateTitle(s: string, max = 60): string {
  const t = clean(s);
  if (!t) return '';
  const head = t.split(/(?<=[.!?])\s|\n/)[0] ?? t;
  const base = head.length <= max ? head : t;
  return base.length <= max ? base : base.slice(0, max).replace(/\s+\S*$/, '') + '…';
}

/** Rebuilds the transcript items to render the history when resuming. */
export function loadTranscript(cwd: string, sessionId: string): HistoryItem[] {
  const file = path.join(projectsDir(cwd), `${sessionId}.jsonl`);
  let content: string;
  try {
    content = fs.readFileSync(file, 'utf8');
  } catch {
    return [];
  }

  const items: HistoryItem[] = [];
  const toolIndex = new Map<string, Extract<HistoryItem, { kind: 'tool' }>>();
  const assistantIndex = new Map<string, Extract<HistoryItem, { kind: 'assistant' }>>();

  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.isMeta) continue;

    if (o.type === 'user' && o.message) {
      const c = o.message.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'tool_result') {
            const tool = toolIndex.get(b.tool_use_id);
            if (tool) {
              tool.result = b.content;
              tool.isError = b.is_error;
            }
          }
        }
      }
      const imgs: string[] = [];
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b?.type === 'image' && b.source?.type === 'base64' && b.source.data) {
            imgs.push(`data:${b.source.media_type || 'image/png'};base64,${b.source.data}`);
          }
        }
      }
      // The user body preserves line breaks (clean() is only for titles).
      const text = textOfContent(c)
        .replace(/[​-‍﻿]/g, '')
        .trim();
      if ((text && !isMetaUserText(text)) || imgs.length) {
        items.push({
          kind: 'user',
          id: o.uuid ?? rid(),
          text: !isMetaUserText(text) ? text : '',
          images: imgs.length ? imgs : undefined,
          ts: tsOf(o),
        });
      }
    } else if (o.type === 'assistant' && o.message) {
      const id = o.message.id ?? o.uuid ?? rid();
      const blocks: any[] = Array.isArray(o.message.content) ? o.message.content : [];
      let item = assistantIndex.get(id);
      const ensure = () => {
        if (!item) {
          item = { kind: 'assistant', id, text: '', thinking: '' };
          assistantIndex.set(id, item);
          items.push(item);
        }
        return item;
      };
      for (const b of blocks) {
        if (b?.type === 'text') {
          ensure().text += b.text ?? '';
        } else if (b?.type === 'thinking') {
          ensure().thinking += b.thinking ?? '';
        } else if (b?.type === 'tool_use') {
          if (!toolIndex.has(b.id)) {
            const tool: Extract<HistoryItem, { kind: 'tool' }> = {
              kind: 'tool',
              id: b.id,
              name: b.name,
              input: b.input,
              ts: tsOf(o),
            };
            toolIndex.set(b.id, tool);
            items.push(tool);
          }
        }
      }
    }
  }
  return items;
}

let seq = 0;
function rid(): string {
  return `h_${seq++}`;
}

/** Epoch ms from the transcript line's `timestamp` field (ISO), when present. */
function tsOf(o: any): number | undefined {
  const t = o?.timestamp;
  if (typeof t !== 'string') return undefined;
  const n = Date.parse(t);
  return Number.isNaN(n) ? undefined : n;
}
