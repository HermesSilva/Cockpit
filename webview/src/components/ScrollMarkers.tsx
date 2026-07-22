import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type RefObject } from 'react';
import type { TimelineItem, UserItem } from '../types';

interface Props {
  scrollRef: RefObject<HTMLDivElement>;
  items: TimelineItem[];
}

interface Mark {
  id: string;
  index: number;
  pct: number; // vertical position on the rail (0..100)
  top: number; // px inside the content (scroll target)
  text: string;
  images?: string[]; // thumbnails of the images pasted into the prompt
}

export function ScrollMarkers({ scrollRef, items }: Props) {
  const [marks, setMarks] = useState<Mark[]>([]);
  const userItems = useMemo(
    () => items.filter((i): i is UserItem => i.kind === 'user'),
    [items],
  );

  const recompute = useCallback(() => {
    const c = scrollRef.current;
    if (!c) return;
    // Maps each prompt to the center of the thumb when it reaches the top, so
    // the marks stay within the thumb's travel range (between its two extremes),
    // not hidden behind it at the ends. minThumb 20px mirrors the thin scrollbar.
    const view = c.clientHeight; // rail height (= scrollable viewport)
    const scrollH = c.scrollHeight || 1;
    const maxScroll = Math.max(1, scrollH - view);
    const thumbH = Math.min(view, Math.max(20, (view * view) / scrollH));
    const travel = Math.max(0, view - thumbH);
    const cTop = c.getBoundingClientRect().top;
    const next: Mark[] = [];
    userItems.forEach((it, idx) => {
      const el = c.querySelector<HTMLElement>(`#msg-${CSS.escape(it.id)}`);
      if (!el) return;
      const top = el.getBoundingClientRect().top - cTop + c.scrollTop;
      const f = Math.max(0, Math.min(1, top / maxScroll));
      const center = thumbH / 2 + f * travel; // px dentro do trilho
      next.push({
        id: it.id,
        index: idx + 1,
        top,
        pct: view > 0 ? (center / view) * 100 : 0,
        text: it.text,
        images: it.images,
      });
    });
    setMarks(next);
  }, [userItems, scrollRef]);

  // Recomputed on every item change and on viewport/content resize (rAF-throttled).
  useLayoutEffect(() => {
    recompute();
  }, [recompute]);

  useEffect(() => {
    const c = scrollRef.current;
    if (!c) return;
    let raf = 0;
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(recompute);
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(c);
    if (c.firstElementChild) ro.observe(c.firstElementChild);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [recompute, scrollRef]);

  if (marks.length === 0) return null;

  const jump = (m: Mark) => {
    scrollRef.current?.scrollTo({ top: Math.max(0, m.top - 8), behavior: 'smooth' });
  };

  return (
    <div className="markers">
      {marks.map((m) => (
        <button
          key={m.id}
          type="button"
          className="marker"
          style={{ top: `${m.pct}%` }}
          onClick={() => jump(m)}
          aria-label={`#${m.index}`}
        >
          <span className="marker-tip">
            <span className="marker-tip-n">#{m.index}</span>
            {clip(m.text)}
            {m.images && m.images.length > 0 && (
              <span className="marker-tip-thumbs">
                {m.images.map((src, i) => (
                  <img key={i} className="marker-tip-thumb" src={src} alt="" />
                ))}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > 220 ? `${t.slice(0, 220)}…` : t;
}
