import { useEffect, useLayoutEffect, useRef, useState, type FocusEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const SHOW_DELAY_MS = 500; // ~ delay do tooltip nativo (atributo title)

export interface TooltipRow {
  label: string;
  value: string;
  accent?: boolean; // highlights the value in orange (e.g. cost, error)
}

// Provenance footer: source of the data + confidence level (color per level).
export interface TooltipMeta {
  originLabel: string; // ex.: "Origem"
  origin: string; // ex.: "Servidor (via CLI)"
  confidenceLabel: string; // ex.: "Confiança"
  confidence: 'high' | 'medium' | 'low'; // cor do chip
  confidenceText: string; // ex.: "Alta"
}

interface Props {
  title?: string; // colored header
  text?: string; // corpo simples (variante "simple")
  rows?: TooltipRow[]; // grade chave/valor (variante "rich")
  meta?: TooltipMeta; // source/confidence footer (colored chips)
  children: ReactNode;
  className?: string;
  focusable?: boolean; // adds tabIndex when the child isn't focusable (e.g. text)
}

interface Anchor {
  top: number;
  bottom: number;
  cx: number; // horizontal center of the anchor element
}
interface Coord {
  left: number;
  top: number;
  below: boolean;
}

// Only one hint is ever open. Tooltips nest (a whole timeline turn is a tooltip that holds
// other tooltips), so hovering an inner element used to open the outer one as well, and a
// hint whose element moved out from under a still cursor (streaming, scrolling) never got
// its mouseleave and stayed behind — leaving two or more on screen. Opening one now closes
// whichever was open; the inner one opens last (its mouseenter comes later), so it wins.
let closeActive: (() => void) | null = null;

// Reusable hint: a popover via portal (it isn't clipped by overflow/scroll), opening on
// hover AND keyboard focus (a11y). It measures the popover and pushes it away from the edge
// it overflowed (horizontal) and opens below when there is no room above (vertical).
export function Tooltip({ title, text, rows, meta, children, className, focusable }: Props) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [coord, setCoord] = useState<Coord | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  // Stable identity (it only touches setters and refs): the module-level `closeActive` slot
  // is compared against it, so a per-render closure would never match.
  const [hide] = useState(() => {
    const fn = () => {
      window.clearTimeout(timer.current);
      if (closeActive === fn) closeActive = null;
      setAnchor(null);
      setCoord(null);
    };
    return fn;
  });

  // Delay before opening, mirroring the browser's native tooltip (title attribute).
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const el = wrapRef.current;
      if (!el) return;
      // The element may have moved away from the cursor during the delay (new content
      // pushed it, the list scrolled): no hover and no keyboard focus → nothing to show.
      if (!el.matches(':hover') && !el.matches(':focus-visible')) return;
      if (closeActive && closeActive !== hide) closeActive();
      closeActive = hide;
      const r = el.getBoundingClientRect();
      setAnchor({ top: r.top, bottom: r.bottom, cx: r.left + r.width / 2 });
    }, SHOW_DELAY_MS);
  };

  // Focus opens the hint only for keyboard focus. A click also focuses a focusable block,
  // and that focus is restored when the panel regains focus — which popped a hint with the
  // mouse nowhere near it, one that only a later blur would close.
  const onFocus = (e: FocusEvent<HTMLSpanElement>) => {
    if (e.currentTarget.matches(':focus-visible')) show();
  };

  // While open: the anchor coordinates are a snapshot, so any scroll or losing the window
  // closes the hint instead of leaving it floating over unrelated content. The pointer leaving
  // the document closes it too: a webview is an iframe, and a quick exit from it (to the editor,
  // the title bar) often never delivers mouseleave to the element inside — the hint stayed up.
  useEffect(() => {
    if (!anchor) return;
    const close = () => hide();
    const out = (e: MouseEvent) => {
      if (!e.relatedTarget) hide(); // left the document, not just moved to another element
    };
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    document.addEventListener('mouseout', out);
    document.addEventListener('visibilitychange', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
      document.removeEventListener('mouseout', out);
      document.removeEventListener('visibilitychange', close);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor]);

  // Pending timer and the "active" slot are released on unmount (e.g. timeline item removed).
  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      if (closeActive === hide) closeActive = null;
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Phase 2: with the popover mounted (hidden), it measures and clamps within the viewport.
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const pad = 8;
    const vw = window.innerWidth;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const below = anchor.top - ph - pad < 0; // no room above → below
    const top = below ? anchor.bottom + pad : anchor.top - pad;
    const half = pw / 2;
    let left = anchor.cx;
    if (left - half < pad) left = pad + half; // overflowed on the left → push right
    else if (left + half > vw - pad) left = vw - pad - half; // overflowed on the right → left
    setCoord({ left, top, below });
  }, [anchor, title, text, rows, meta]);

  const hasBody = !!title || !!text || (rows && rows.length > 0) || !!meta;

  return (
    <span
      ref={wrapRef}
      className={`tt-wrap ${className ?? ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={onFocus}
      onBlur={hide}
      tabIndex={focusable ? 0 : undefined}
    >
      {children}
      {anchor &&
        hasBody &&
        createPortal(
          <div
            ref={popRef}
            className={`tt-pop ${coord?.below ? 'below' : 'above'}`}
            style={{
              left: coord?.left ?? anchor.cx,
              top: coord?.top ?? anchor.top,
              visibility: coord ? 'visible' : 'hidden',
            }}
            role="tooltip"
          >
            {title && <div className="tt-title">{title}</div>}
            {text && <div className="tt-text">{text}</div>}
            {rows && rows.length > 0 && (
              <div className="tt-rows">
                {rows.map((r, i) => (
                  <div className="tt-row" key={i}>
                    <span className="tt-k">{r.label}</span>
                    <span className={`tt-v ${r.accent ? 'accent' : ''}`}>{r.value}</span>
                  </div>
                ))}
              </div>
            )}
            {meta && (
              <div className="tt-meta">
                <span className="tt-fact tt-fact-origin">
                  <span className="tt-fact-k">{meta.originLabel}</span>
                  <span className="tt-fact-v">{meta.origin}</span>
                </span>
                <span className="tt-fact-sep" aria-hidden="true" />
                <span className={`tt-fact tt-fact-conf ${meta.confidence}`}>
                  <span className="tt-fact-k">{meta.confidenceLabel}</span>
                  <span className="tt-fact-v">{meta.confidenceText}</span>
                </span>
              </div>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
