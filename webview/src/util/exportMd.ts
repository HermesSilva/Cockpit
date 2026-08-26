// Converts the timeline into a readable Markdown document: the CONVERSATION — what was
// asked, what was thought and what the assistant answered (what it did, why, how). Tool
// cards (commands / results) are included following the SAME expand state as the UI: when
// the timeline shows them expanded, the export carries their input and result; when they
// are collapsed, only the one-line header goes out.
import type { TimelineItem, ToolItem } from '../types';
import type { Translator } from '../i18n';

function fmtTs(ts?: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

/** Turns a tool's input/result into plain text for a fenced block, mirroring the
 *  timeline's generic renderer: strings stay as-is, everything else is JSON. */
function toBlockText(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export interface ExportOptions {
  /** Reasoning blocks are shown open (true) instead of collapsed <details> (false). */
  showThinking?: boolean;
  /** Tool cards carry their input/result (true) or just the header line (false). */
  expandTools?: boolean;
}

/** Builds the conversation's Markdown from the timeline items. The speaker
 *  names mirror the webview: user = `userName` (or role.user) and
 *  assistente = role.assistant ("Claude"). Tool cards follow `opts.expandTools`
 *  and reasoning follows `opts.showThinking`, so the document reflects what the
 *  user is actually looking at in the timeline. */
export function buildConversationMd(
  items: TimelineItem[],
  t: Translator,
  title?: string,
  userName?: string,
  opts?: ExportOptions,
): string {
  const userLabel = userName?.trim() || t('role.user');
  const assistantLabel = t('role.assistant');
  const showThinking = opts?.showThinking === true;
  const expandTools = opts?.expandTools === true;
  const out: string[] = [];
  out.push(`# ${title?.trim() || t('export.docTitle')}`);
  out.push('');
  out.push(`_${t('export.generatedAt', new Date().toLocaleString())}_`);
  out.push('');

  for (const it of items) {
    if (it.kind === 'user') {
      const text = it.text?.trim();
      if (!text) continue;
      out.push('---', '', `### 🧑 ${userLabel}`, '', text, '');
    } else if (it.kind === 'assistant') {
      const think = it.thinking?.trim();
      const text = it.text?.trim();
      if (!think && !text) continue;
      out.push(`### 🤖 ${assistantLabel}`, '');
      if (think) {
        if (showThinking) {
          // Expanded reasoning: the timeline is showing it, so the export shows it too.
          out.push(`> 💭 ${t('export.thinking')}`, '', think, '');
        } else {
          // Collapsed reasoning (it doesn't pollute the reading, but preserves "what was thought").
          out.push('<details>', `<summary>💭 ${t('export.thinking')}</summary>`, '', think, '', '</details>', '');
        }
      }
      if (text) out.push(text, '');
    } else if (it.kind === 'tool') {
      // Tool cards mirror the timeline's expand state: collapsed = header only.
      appendTool(out, it, t, expandTools);
    }
  }

  out.push('---', '');
  return out.join('\n');
}

/** Emits one tool card. Collapsed: a single header line. Expanded: header plus
 *  the input and (when present) the result in fenced blocks. */
function appendTool(out: string[], it: ToolItem, t: Translator, expand: boolean): void {
  const input = (it.input ?? {}) as Record<string, unknown>;
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  const header = filePath ? `${it.name} — \`${filePath}\`` : it.name;
  out.push(`#### 🔧 ${header}`, '');
  if (!expand) return;
  const inText = toBlockText(it.input);
  if (inText.trim()) {
    out.push(`_${t('export.toolInput')}_`, '', '```', inText, '```', '');
  }
  if (it.result !== undefined) {
    const resText = toBlockText(it.result);
    if (resText.trim()) {
      out.push(`_${t('export.toolResult')}_`, '', '```', resText, '```', '');
    }
  }
}

/** Suggested file name (title slug + short date). */
export function suggestedFileName(title?: string, ts = Date.now()): string {
  const slug = (title || 'conversa')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'conversa';
  let stamp = '';
  try {
    stamp = new Date(ts).toISOString().slice(0, 10);
  } catch {
    /* ignora */
  }
  return stamp ? `${slug}-${stamp}.md` : `${slug}.md`;
}
