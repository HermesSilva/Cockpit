// Markdown leve -> nós React (seguro, sem innerHTML para texto).
// Suporta: headers, listas (ul/ol), bold, itálico, código inline, links e
// blocos de código com syntax highlight.
import { Fragment, type ReactNode } from 'react';
import { CodeBlock } from './CodeBlock';

interface Props {
  text: string;
}

export function Markdown({ text }: Props) {
  return <div className="md">{renderBlocks(text)}</div>;
}

type Seg = { type: 'text'; content: string } | { type: 'code'; content: string; lang?: string };

function splitFences(src: string): Seg[] {
  const out: Seg[] = [];
  const re = /```([^\n]*)\n?([\s\S]*?)```/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ type: 'text', content: src.slice(last, m.index) });
    out.push({ type: 'code', content: m[2].replace(/\n$/, ''), lang: m[1].trim() || undefined });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ type: 'text', content: src.slice(last) });
  return out;
}

function renderBlocks(src: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  let key = 0;
  for (const seg of splitFences(src)) {
    if (seg.type === 'code') {
      nodes.push(<CodeBlock key={key++} code={seg.content} language={seg.lang} />);
    } else {
      nodes.push(...renderText(seg.content, () => key++));
    }
  }
  return nodes;
}

function renderText(text: string, nextKey: () => number): ReactNode[] {
  const lines = text.split('\n');
  const out: ReactNode[] = [];
  let para: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) {
      const content = para;
      out.push(
        <p key={nextKey()} className="md-p">
          {content.map((ln, i) => (
            <Fragment key={i}>
              {renderInline(ln)}
              {i < content.length - 1 ? <br /> : null}
            </Fragment>
          ))}
        </p>,
      );
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      const cur = list;
      const items = cur.items.map((it, i) => <li key={i}>{renderInline(it)}</li>);
      out.push(
        cur.ordered ? (
          <ol key={nextKey()} className="md-list">
            {items}
          </ol>
        ) : (
          <ul key={nextKey()} className="md-list">
            {items}
          </ul>
        ),
      );
      list = null;
    }
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];

    // Tabela GFM: linha com pipes seguida de separador |---|---|. Consome o
    // cabeçalho + separador + linhas de corpo (até linha em branco/não-tabela).
    if (isTableRow(line) && li + 1 < lines.length && isTableSep(lines[li + 1])) {
      flushPara();
      flushList();
      const aligns = parseAligns(lines[li + 1]);
      const header = splitRow(line);
      const body: string[][] = [];
      let j = li + 2;
      for (; j < lines.length && isTableRow(lines[j]); j++) body.push(splitRow(lines[j]));
      out.push(
        <table key={nextKey()} className="md-table">
          <thead>
            <tr>
              {header.map((c, ci) => (
                <th key={ci} style={alignStyle(aligns[ci])}>
                  {renderInline(c)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {body.map((row, ri) => (
              <tr key={ri}>
                {row.map((c, ci) => (
                  <td key={ci} style={alignStyle(aligns[ci])}>
                    {renderInline(c)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>,
      );
      li = j - 1; // o for incrementa
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const bullet = line.match(/^\s*[-*+]\s+(.*)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.*)$/);

    if (heading) {
      flushPara();
      flushList();
      const level = heading[1].length;
      const Tag = (`h${Math.min(level, 6)}` as 'h1');
      out.push(
        <Tag key={nextKey()} className={`md-h md-h${level}`}>
          {renderInline(heading[2])}
        </Tag>,
      );
    } else if (bullet) {
      flushPara();
      if (!list || list.ordered) {
        flushList();
        list = { ordered: false, items: [] };
      }
      list.items.push(bullet[1]);
    } else if (ordered) {
      flushPara();
      if (!list || !list.ordered) {
        flushList();
        list = { ordered: true, items: [] };
      }
      list.items.push(ordered[1]);
    } else if (line.trim() === '') {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushPara();
  flushList();
  return out;
}

// --- Tabela GFM ---
type Align = 'left' | 'center' | 'right' | undefined;

/** Linha de tabela: tem ao menos um `|` "de verdade" (não só no fim de prosa). */
function isTableRow(line: string): boolean {
  const t = line.trim();
  if (!t.includes('|')) return false;
  // Exige pipe interno (não apenas borda) p/ não confundir prosa com `texto |`.
  return /\|/.test(t.replace(/^\|/, '').replace(/\|$/, ''));
}

/** Separador de tabela: células só com - e : opcionais (ex.: |:--|--:|:-:|). */
function isTableSep(line: string): boolean {
  const t = line.trim();
  if (!t.includes('-') || !t.includes('|')) return false;
  return /^\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?$/.test(t);
}

/** Alinhamentos por coluna a partir do separador (:--, --:, :-:). */
function parseAligns(sep: string): Align[] {
  return splitRow(sep).map((c) => {
    const s = c.trim();
    const l = s.startsWith(':');
    const r = s.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : undefined;
  });
}

function alignStyle(a: Align): { textAlign: Align } | undefined {
  return a ? { textAlign: a } : undefined;
}

/** Divide uma linha em células: tira bordas e separa por `|` (respeita \|). */
function splitRow(line: string): string[] {
  const t = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return t
    .split(/(?<!\\)\|/)
    .map((c) => c.replace(/\\\|/g, '|').trim());
}

// Inline: links -> código -> ênfase (bold/itálico).
function renderInline(text: string): ReactNode[] {
  return splitLinks(text);
}

function splitLinks(text: string): ReactNode[] {
  const re = /\[([^\]]+)\]\(([^)\s]+)\)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(...splitCode(text.slice(last, m.index), `t${key}`));
    out.push(
      <a key={`a${key++}`} href={m[2]} className="md-link">
        {m[1]}
      </a>,
    );
    last = re.lastIndex;
  }
  if (last < text.length) out.push(...splitCode(text.slice(last), `t${key}`));
  return out;
}

function splitCode(text: string, prefix: string): ReactNode[] {
  return text.split(/(`[^`]+`)/g).map((p, i) =>
    p.startsWith('`') && p.endsWith('`') ? (
      <code key={`${prefix}c${i}`} className="md-inline">
        {p.slice(1, -1)}
      </code>
    ) : (
      <Fragment key={`${prefix}e${i}`}>{renderEmphasis(p)}</Fragment>
    ),
  );
}

function renderEmphasis(text: string): ReactNode[] {
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_)/g;
  const out: ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const bold = m[2] ?? m[3];
    const italic = m[4] ?? m[5];
    if (bold != null) out.push(<strong key={key++}>{bold}</strong>);
    else out.push(<em key={key++}>{italic}</em>);
    last = re.lastIndex;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
