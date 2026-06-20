// Converte a timeline num documento Markdown legível: a CONVERSA — o que se
// pediu, o que se pensou e o que o assistente respondeu (o que fez, por quê,
// como). Exclui o ruído técnico (cards de tool / comandos / resultados).
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

/** Monta o Markdown da conversa a partir dos itens da timeline. */
export function buildConversationMd(items: TimelineItem[], t: Translator, title?: string): string {
  const out: string[] = [];
  out.push(`# ${title?.trim() || t('export.docTitle')}`);
  out.push('');
  out.push(`_${t('export.generatedAt', new Date().toLocaleString())}_`);
  out.push('');

  for (const it of items) {
    if (it.kind === 'user') {
      const text = it.text?.trim();
      if (!text) continue;
      out.push('---', '', `### 🧑 ${t('export.you')}`, '', text, '');
    } else if (it.kind === 'assistant') {
      const think = it.thinking?.trim();
      const text = it.text?.trim();
      if (!think && !text) continue;
      out.push(`### 🤖 ${t('export.assistant')}`, '');
      if (think) {
        // Raciocínio recolhível (não polui a leitura, mas preserva "o que se pensou").
        out.push('<details>', `<summary>💭 ${t('export.thinking')}</summary>`, '', think, '', '</details>', '');
      }
      if (text) out.push(text, '');
    }
    // kind === 'tool': IGNORADO de propósito (comando/resultado = ruído técnico).
  }

  out.push('---', '');
  return out.join('\n');
}

/** Nome de arquivo sugerido (slug do título + data curta). */
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
