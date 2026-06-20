import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const SHOW_DELAY_MS = 500; // ~ delay do tooltip nativo (atributo title)

export interface TooltipRow {
  label: string;
  value: string;
  accent?: boolean; // realça o valor em laranja (ex.: custo, erro)
}

// Rodapé de procedência: origem do dado + nível de confiança (cor por nível).
export interface TooltipMeta {
  originLabel: string; // ex.: "Origem"
  origin: string; // ex.: "Servidor (via CLI)"
  confidenceLabel: string; // ex.: "Confiança"
  confidence: 'high' | 'medium' | 'low'; // cor do chip
  confidenceText: string; // ex.: "Alta"
}

interface Props {
  title?: string; // cabeçalho colorido
  text?: string; // corpo simples (variante "simple")
  rows?: TooltipRow[]; // grade chave/valor (variante "rich")
  meta?: TooltipMeta; // rodapé origem/confiança (chips coloridos)
  children: ReactNode;
  className?: string;
  focusable?: boolean; // adiciona tabIndex quando o filho não é focável (ex.: texto)
}

interface Anchor {
  top: number;
  bottom: number;
  cx: number; // centro horizontal do elemento-âncora
}
interface Coord {
  left: number;
  top: number;
  below: boolean;
}

// Hint reusável: popover via portal (não sofre clip de overflow/scroll), abre em
// hover E foco (a11y). Mede o popover e empurra p/ o lado contrário à borda que
// estourou (horizontal) e abre abaixo quando falta espaço acima (vertical).
export function Tooltip({ title, text, rows, meta, children, className, focusable }: Props) {
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [coord, setCoord] = useState<Coord | null>(null);
  const wrapRef = useRef<HTMLSpanElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const timer = useRef<number | undefined>(undefined);

  // Delay antes de abrir, espelhando o tooltip nativo do navegador (atributo title).
  const show = () => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setAnchor({ top: r.top, bottom: r.bottom, cx: r.left + r.width / 2 });
    }, SHOW_DELAY_MS);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setAnchor(null);
    setCoord(null);
  };

  // Limpa o timer pendente se desmontar (ex.: item da timeline removido).
  useEffect(() => () => window.clearTimeout(timer.current), []);

  // Fase 2: com o popover montado (oculto), mede e clampeia dentro da viewport.
  useLayoutEffect(() => {
    const pop = popRef.current;
    if (!anchor || !pop) return;
    const pad = 8;
    const vw = window.innerWidth;
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const below = anchor.top - ph - pad < 0; // sem espaço acima → abaixo
    const top = below ? anchor.bottom + pad : anchor.top - pad;
    const half = pw / 2;
    let left = anchor.cx;
    if (left - half < pad) left = pad + half; // estourou à esquerda → empurra p/ direita
    else if (left + half > vw - pad) left = vw - pad - half; // estourou à direita → esquerda
    setCoord({ left, top, below });
  }, [anchor, title, text, rows, meta]);

  const hasBody = !!title || !!text || (rows && rows.length > 0) || !!meta;

  return (
    <span
      ref={wrapRef}
      className={`tt-wrap ${className ?? ''}`}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
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
