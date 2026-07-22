// Converts the timeline into a readable Markdown document: the CONVERSATION — what was
// asked, what was thought and what the assistant answered (what it did, why,
// how). It excludes the technical noise (tool cards / commands / results).
import type { TimelineItem } from '../types';
import type { Translator } from '../i18n';

function fmtTs(ts?: number): string {
  if (!ts) return '';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return '';
  }
}

/** Builds the conversation's Markdown from the timeline items. The speaker
 *  names mirror the webview: user = `userName` (or role.user) and
 *  assistente = role.assistant ("Claude"). */
export function buildConversationMd(
  items: TimelineItem[],
  t: Translator,
  title?: string,
  userName?: string,
): string {
  const userLabel = userName?.trim() || t('role.user');
  const assistantLabel = t('role.assistant');
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
        // Collapsible reasoning (it doesn't pollute the reading, but preserves "what was thought").
        out.push('<details>', `<summary>💭 ${t('export.thinking')}</summary>`, '', think, '', '</details>', '');
      }
      if (text) out.push(text, '');
    }
    // kind === 'tool': IGNORED on purpose (command/result = technical noise).
  }

  out.push('---', '');
  return out.join('\n');
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
