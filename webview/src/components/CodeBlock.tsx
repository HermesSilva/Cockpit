import { useMemo, useState } from 'react';
import { highlightCode } from '../util/highlight';

interface Props {
  code: string;
  language?: string;
  lineNumbers?: (number | null)[];
}

export function CodeBlock({ code, language, lineNumbers }: Props) {
  const { html, language: detected } = useMemo(
    () => highlightCode(code, language),
    [code, language],
  );
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    });
  };
  return (
    <pre className="md-code">
      <button type="button" className="code-copy" onClick={copy} title="Copy">
        {copied ? '✓' : '⧉'}
      </button>
      {detected && <span className="code-lang">{detected}</span>}
      <div className="code-row">
        {lineNumbers && lineNumbers.length > 0 && (
          <div className="code-gutter" aria-hidden="true">
            {lineNumbers.map((n, i) => (
              <span key={i}>{n ?? ''}</span>
            ))}
          </div>
        )}
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </div>
    </pre>
  );
}
