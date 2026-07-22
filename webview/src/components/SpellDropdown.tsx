import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Translator } from '../i18n';
import type { Suggestions } from '../spell/spell';

interface Props {
  t: Translator;
  word: string;
  sug: Suggestions;
  loading?: boolean;
  left: number;
  top: number; // y abaixo da palavra (preferido)
  anchorTop: number; // y do topo da palavra (p/ inverter pra cima)
  onPick: (s: string) => void;
  onAdd: () => void;
  onIgnore: () => void;
  onClose: () => void;
}

const MARGIN = 8;

// Correction dropdown anchored on the wrong word. Suggestions grouped by language
// (PT / EN), each group only shows when there are candidates. Closes on Esc / outside click.
// Opens below the word; when it doesn't fit, it flips up and clamps to the viewport.
export function SpellDropdown({ t, word, sug, loading, left, top, anchorTop, onPick, onAdd, onIgnore, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left, top });

  // Measures the already rendered menu and repositions it to fit the viewport.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    // Vertical: below by default; when it overflows at the bottom and there is room above, it flips.
    let ny = top;
    if (top + height > vh - MARGIN && anchorTop - height > MARGIN) ny = anchorTop - height - 2;
    ny = Math.max(MARGIN, Math.min(ny, vh - height - MARGIN));
    // Horizontal: clamps to the right.
    const nx = Math.max(MARGIN, Math.min(left, vw - width - MARGIN));
    setPos({ left: nx, top: ny });
  }, [left, top, anchorTop, sug, loading]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose]);

  const hasPt = sug.pt.length > 0;
  const hasEn = sug.en.length > 0;

  return (
    <div ref={ref} className="spell-menu" style={{ left: pos.left, top: pos.top }} role="listbox">
      {loading && <div className="spell-menu-empty">{t('spell.loading')}</div>}
      {!loading && !hasPt && !hasEn && <div className="spell-menu-empty">{t('spell.noSuggestions')}</div>}
      {hasPt && (
        <div className="spell-group">
          <div className="spell-group-head">{t('spell.pt')}</div>
          {sug.pt.map((s) => (
            <button type="button" key={`pt-${s}`} className="spell-item" onClick={() => onPick(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      {hasEn && (
        <div className="spell-group">
          <div className="spell-group-head">{t('spell.en')}</div>
          {sug.en.map((s) => (
            <button type="button" key={`en-${s}`} className="spell-item" onClick={() => onPick(s)}>
              {s}
            </button>
          ))}
        </div>
      )}
      <div className="spell-actions">
        <button type="button" className="spell-action" onClick={onAdd}>
          {t('spell.add')}
        </button>
        <button type="button" className="spell-action" onClick={onIgnore}>
          {t('spell.ignore')}
        </button>
      </div>
    </div>
  );
}
