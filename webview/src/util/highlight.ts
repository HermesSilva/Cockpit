// Syntax highlight via highlight.js com um conjunto curado de linguagens.
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import python from 'highlight.js/lib/languages/python';
import csharp from 'highlight.js/lib/languages/csharp';
import java from 'highlight.js/lib/languages/java';
import go from 'highlight.js/lib/languages/go';
import rust from 'highlight.js/lib/languages/rust';
import json from 'highlight.js/lib/languages/json';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import bash from 'highlight.js/lib/languages/bash';
import shell from 'highlight.js/lib/languages/shell';
import powershell from 'highlight.js/lib/languages/powershell';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import ruby from 'highlight.js/lib/languages/ruby';
import cpp from 'highlight.js/lib/languages/cpp';
import c from 'highlight.js/lib/languages/c';
import ini from 'highlight.js/lib/languages/ini';

const LANGS: Record<string, (hljs: typeof import('highlight.js/lib/core').default) => unknown> = {
  javascript,
  typescript,
  python,
  csharp,
  java,
  go,
  rust,
  json,
  xml,
  css,
  bash,
  shell,
  powershell,
  sql,
  yaml,
  markdown,
  php,
  ruby,
  cpp,
  c,
  ini,
};
for (const [name, lang] of Object.entries(LANGS)) {
  hljs.registerLanguage(name, lang as never);
}

// Extensão -> linguagem hljs.
const EXT: Record<string, string> = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  py: 'python', pyw: 'python',
  cs: 'csharp', java: 'java', go: 'go', rs: 'rust',
  json: 'json', jsonc: 'json',
  html: 'xml', htm: 'xml', xml: 'xml', xaml: 'xml', svg: 'xml', vue: 'xml',
  css: 'css', scss: 'css', less: 'css',
  sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', psm1: 'powershell',
  sql: 'sql', yml: 'yaml', yaml: 'yaml',
  md: 'markdown', markdown: 'markdown',
  php: 'php', rb: 'ruby',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hxx: 'cpp', h: 'cpp', c: 'c',
  ini: 'ini', toml: 'ini', conf: 'ini', cfg: 'ini', env: 'ini',
};

const MAX = 200_000; // não destacar blobs gigantes

export function languageFromPath(p?: string): string | undefined {
  if (!p) return undefined;
  const clean = p.replace(/["']/g, '').trim();
  const ext = clean.split('.').pop()?.toLowerCase();
  return ext ? EXT[ext] : undefined;
}

export interface Highlighted {
  html: string;
  language?: string;
}

export function highlightCode(code: string, language?: string): Highlighted {
  if (!code) return { html: '' };
  if (code.length > MAX) return { html: escapeHtml(code) };
  try {
    if (language && hljs.getLanguage(language)) {
      return {
        html: hljs.highlight(code, { language, ignoreIllegals: true }).value,
        language,
      };
    }
    const auto = hljs.highlightAuto(code);
    return { html: auto.value, language: auto.language };
  } catch {
    return { html: escapeHtml(code) };
  }
}

/**
 * Detecta o formato `cat -n` (Read do CLI: "  12<TAB>conteúdo" ou "  12→ conteúdo")
 * e separa números de linha do conteúdo, para destacar o código limpo num gutter.
 * Retorna null se a maioria das linhas não tiver numeração.
 */
export function stripLineNumbers(text: string): { code: string; numbers: (number | null)[] } | null {
  const lines = text.split('\n');
  if (lines.length < 2) return null;
  const numbers: (number | null)[] = [];
  const out: string[] = [];
  let matched = 0;
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)(?:\t|→ ?)(.*)$/);
    if (m) {
      numbers.push(parseInt(m[1], 10));
      out.push(m[2]);
      matched++;
    } else {
      numbers.push(null);
      out.push(line);
    }
  }
  // descarta a última linha vazia comum (arquivo termina em \n)
  const effective = lines[lines.length - 1].trim() === '' ? lines.length - 1 : lines.length;
  if (matched < effective * 0.6) return null;
  return { code: out.join('\n'), numbers };
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Highlight markdown-aware p/ input e mensagem do usuário: destaca só blocos
 * cercados ``` ``` ``` (por linguagem, ou auto) e código inline `assim`; a prosa
 * fica em texto plano. O CONTEÚDO TEXTUAL do HTML é idêntico ao texto original
 * (markers ``` e ` permanecem como texto), garantindo alinhamento no overlay.
 */
// Relevância mínima do hljs p/ tratar um trecho SEM cerca como código (e não prosa).
const CODE_RELEVANCE = 6;

export function richHighlight(text: string): string {
  if (!text) return '';
  // Sem cercas: decide por relevância — código colore, prosa fica plana.
  if (!text.includes('```')) return autoOrPlain(text);

  const fence = /```([\w+#.-]*)([ \t]*\n)([\s\S]*?)```/g;
  let out = '';
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text))) {
    out += autoOrPlain(text.slice(last, m.index));
    const lang = m[1];
    const sep = m[2]; // espaços + \n após a linguagem
    const code = m[3];
    const hl = highlightCode(code, lang || undefined).html; // hljs resolve aliases (ts, js…)
    out +=
      `<span class="rt-fence">\`\`\`${escapeHtml(lang)}</span>${escapeHtml(sep)}` +
      `<span class="rt-code">${hl}</span>` +
      `<span class="rt-fence">\`\`\`</span>`;
    last = fence.lastIndex;
  }
  out += autoOrPlain(text.slice(last));
  return out;
}

// Auto-detecta: se o trecho "parece código" (relevância alta), destaca; senão
// trata como prosa (plano + código inline `assim`). Mantém o texto idêntico.
function autoOrPlain(s: string): string {
  if (!s) return '';
  if (s.length <= MAX && /\S/.test(s)) {
    try {
      const a = hljs.highlightAuto(s);
      if ((a.relevance ?? 0) >= CODE_RELEVANCE && a.value) return a.value;
    } catch {
      /* cai p/ prosa */
    }
  }
  return inlineRich(s);
}

function inlineRich(s: string): string {
  let out = '';
  let last = 0;
  const re = /`([^`\n]+)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    out += escapeHtml(s.slice(last, m.index));
    out += `<span class="rt-inline">\`${escapeHtml(m[1])}\`</span>`;
    last = re.lastIndex;
  }
  out += escapeHtml(s.slice(last));
  return out;
}
