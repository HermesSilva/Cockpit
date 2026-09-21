import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';
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

// A prompt's measured offset inside the scrollable content, plus the tooltip payload.
// This is the half that costs a DOM query and a layout read per prompt.
interface Measured {
  id: string;
  index: number;
  top: number;
  text: string;
  images?: string[];
}

export function ScrollMarkers({ scrollRef, items }: Props) {
  const [marks, setMarks] = useState<Mark[]>([]);
  // `items` is a fresh array on every stream delta, but a delta only ever replaces the
  // assistant item being written — the user items keep their identity. Keying the memo on
  // that identity (not on the array) means a delta no longer invalidates the measurement
  // pass, while a new prompt, a rewind or a tab switch still does.
  const filtered = items.filter((i): i is UserItem => i.kind === 'user');
  // The text is part of the key, not just the id: an optimistic local bubble keeps its id
  // when the host echoes the real message back, and the tooltip renders that text.
  const userKey = filtered.map((i) => `${i.id}\u0001${i.text}`).join('\u0000');
  const userItems = useMemo(
    () => filtered,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [userKey],
  );

  // The measurement is split from the projection on purpose.
  //
  // Measuring is the expensive half: one querySelector plus one getBoundingClientRect per
  // prompt, i.e. O(number of prompts) with a forced layout. Projecting a measured `top`
  // onto the rail is pure arithmetic over numbers we already hold.
  //
  // Typing only ever changes the SECOND half. Growing the composer by a line shrinks the
  // scroll viewport, which moves the thumb and therefore every mark — but it does not move
  // any prompt within the content, so `top` is still valid. Recomputing only the projection
  // is what keeps the keystroke off the O(n) path; before this split, every line the
  // composer gained re-measured the whole transcript.
  const measured = useRef<Measured[]>([]);

  const project = useCallback(() => {
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
    const next = measured.current.map((m) => {
      const f = Math.max(0, Math.min(1, m.top / maxScroll));
      const center = thumbH / 2 + f * travel; // px dentro do trilho
      return { ...m, pct: view > 0 ? (center / view) * 100 : 0 };
    });
    // Same positions as the last pass: keep the old array so React skips the re-render of
    // every marker. Without this the ResizeObserver repainted the whole rail each frame.
    setMarks((prev) => (sameMarks(prev, next) ? prev : next));
  }, [scrollRef]);

  const measure = useCallback(() => {
    const c = scrollRef.current;
    if (!c) return;
    const cTop = c.getBoundingClientRect().top;
    const next: Measured[] = [];
    userItems.forEach((it, idx) => {
      const el = c.querySelector<HTMLElement>(`#msg-${CSS.escape(it.id)}`);
      if (!el) return;
      next.push({
        id: it.id,
        index: idx + 1,
        top: el.getBoundingClientRect().top - cTop + c.scrollTop,
        text: it.text,
        images: it.images,
      });
    });
    measured.current = next;
    project();
  }, [userItems, project, scrollRef]);

  // The prompts changed (a new turn, a rewind, a tab switch): re-measure, then project.
  useLayoutEffect(() => {
    measure();
  }, [measure]);

  // Viewport or content resized: the prompts are where they were, only the rail's geometry
  // moved, so this is the cheap path. Throttled to one pass per frame.
  //
  // The observer is set up once and reaches `project` through a ref: `project` itself is
  // stable, but hanging this effect off a value derived from `items` would tear the
  // observer down and rebuild it on every stream delta.
  const projectRef = useRef(project);
  projectRef.current = project;
  useEffect(() => {
    const c = scrollRef.current;
    if (!c) return;
    let raf = 0;
    const schedule = () => {
      if (raf) return; // already queued for this frame
      raf = requestAnimationFrame(() => {
        raf = 0;
        projectRef.current();
      });
    };
    const ro = new ResizeObserver(schedule);
    ro.observe(c);
    if (c.firstElementChild) ro.observe(c.firstElementChild);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [scrollRef]);

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

// Compares only what a projection pass can change: the rail position and the scroll target.
// Text and images can only change along with `userKey`, which re-measures and rebuilds the
// list anyway, so they need no comparison here.
function sameMarks(a: Mark[], b: Mark[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id || a[i].pct !== b[i].pct || a[i].top !== b[i].top) return false;
  }
  return true;
}

function clip(s: string): string {
  const t = s.trim();
  return t.length > 220 ? `${t.slice(0, 220)}…` : t;
}
