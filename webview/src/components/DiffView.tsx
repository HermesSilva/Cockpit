import { useMemo } from 'react';
import { sideBySideDiff } from '../util/diff';

interface Props {
  oldText: string;
  newText: string;
  label?: string;
}

// Diff lado-a-lado (antes | depois) com numeração e realce add/del/change.
export function DiffView({ oldText, newText, label }: Props) {
  const diff = useMemo(() => sideBySideDiff(oldText, newText), [oldText, newText]);

  return (
    <div className="diff">
      <div className="diff-head">
        {label && <span className="diff-file">{label}</span>}
        <span className="diff-stat">
          <span className="diff-plus">+{diff.added}</span>
          <span className="diff-minus">−{diff.removed}</span>
        </span>
      </div>
      <div className="diff-grid">
        {diff.rows.map((r, i) => (
          <div key={i} className={`diff-row ${r.type}`}>
            <span className="diff-ln">{r.left?.num ?? ''}</span>
            <span className="diff-sign left">{r.type === 'del' || r.type === 'change' ? '−' : ''}</span>
            <code className="diff-code left">{r.left?.text ?? ''}</code>
            <span className="diff-ln diff-mid">{r.right?.num ?? ''}</span>
            <span className="diff-sign right">{r.type === 'add' || r.type === 'change' ? '+' : ''}</span>
            <code className="diff-code right">{r.right?.text ?? ''}</code>
          </div>
        ))}
      </div>
      {diff.truncated && <div className="diff-trunc">…</div>}
    </div>
  );
}
