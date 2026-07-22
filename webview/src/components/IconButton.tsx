import type { ReactNode } from 'react';

export interface Tip {
  icon: string;
  title: string;
  desc: string;
  accent?: string; // icon badge color (var(--vscode-charts-*))
}

interface Props {
  glyph: ReactNode;
  tip: Tip;
  onClick: () => void;
  variant?: 'default' | 'danger' | 'primary';
  active?: boolean;
  badge?: ReactNode;
}

export function IconButton({ glyph, tip, onClick, variant = 'default', active, badge }: Props) {
  return (
    <div className="iconbtn-wrap">
      <button
        type="button"
        className={`iconbtn ${variant} ${active ? 'active' : ''}`}
        onClick={onClick}
        aria-label={tip.title}
      >
        {glyph}
        {badge != null && <span className="iconbtn-badge">{badge}</span>}
      </button>
      <div className="tip" role="tooltip">
        <div className="tip-head">
          <span
            className="tip-icon"
            style={tip.accent ? { background: `${tip.accent}22`, color: tip.accent } : undefined}
          >
            {tip.icon}
          </span>
          <span className="tip-title">{tip.title}</span>
        </div>
        <div className="tip-desc">{tip.desc}</div>
      </div>
    </div>
  );
}
