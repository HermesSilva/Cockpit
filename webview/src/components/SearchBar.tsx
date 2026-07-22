import { useEffect, useRef, useState, type RefObject } from 'react';
import type { Translator } from '../i18n';

interface Props {
  t: Translator;
  scrollRef: RefObject<HTMLDivElement | null>;
  itemsKey: number; // changes when the timeline changes → re-search
  onClose: () => void;
}

type Scope = 'timeline' | 'prompts';

const HL = 'cockpit-search';
const HL_CUR = 'cockpit-search-current';

// Search bar (Ctrl+F): searches the whole Timeline or only the user's
// prompts. 250ms debounce; it highlights the matches (CSS Custom Highlight API, without touching
// the rendered DOM) and scrolls the current match into view. ↑/↓ or Enter navigate.
export function SearchBar({ t, scrollRef, itemsKey, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [scope, setScope] = useState<Scope>('timeline');
  const [count, setCount] = useState(0);
  const [idx, setIdx] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const ranges = useRef<Range[]>([]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    return () => clearHighlights();
  }, []);

  // 250ms debounce: re-searches when the query/scope changes or when the timeline changes.
  useEffect(() => {
    const id = setTimeout(() => runSearch(query, scope), 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, scope, itemsKey]);

  function clearHighlights(): void {
    const h = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
    h?.delete(HL);
    h?.delete(HL_CUR);
    ranges.current = [];
  }

  // Collects the text nodes inside the scope's roots and builds a Range per match.
  function collect(q: string): Range[] {
    const root = scrollRef.current;
    if (!root || !q) return [];
    const roots: Element[] =
      scope === 'prompts' ? Array.from(root.querySelectorAll('.bubble.user')) : [root];
    const needle = q.toLowerCase();
    const out: Range[] = [];
    for (const r of roots) {
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) =>
          n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT,
      });
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = (node.nodeValue ?? '').toLowerCase();
        let from = 0;
        let at = text.indexOf(needle, from);
        while (at !== -1) {
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, at + needle.length);
          out.push(range);
          from = at + needle.length;
          at = text.indexOf(needle, from);
        }
      }
    }
    return out;
  }

  function runSearch(q: string, _scope: Scope): void {
    clearHighlights();
    const found = q.trim().length >= 1 ? collect(q) : [];
    ranges.current = found;
    setCount(found.length);
    const H = (window as unknown as { Highlight?: typeof Highlight }).Highlight;
    const reg = (CSS as unknown as { highlights?: Map<string, Highlight> }).highlights;
    if (H && reg && found.length) {
      reg.set(HL, new H(...found));
      focusMatch(0, found);
    } else {
      setIdx(0);
    }
  }

  function focusMatch(i: number, list = ranges.current): void {
    if (!list.length) return;
    const ni = ((i % list.length) + list.length) % list.length;
    setIdx(ni);
    const H = (window as unknown as { Highlight?: typeof Highlight }).Highlight;
    const reg = (CSS as unknown as { highlights?: Map<string, Highlight> }).highlights;
    if (H && reg) reg.set(HL_CUR, new H(list[ni]));
    const el = list[ni].startContainer.parentElement;
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  function step(delta: number): void {
    if (ranges.current.length) focusMatch(idx + delta);
  }

  return (
    <div className="search-bar">
      <input
        ref={inputRef}
        className="search-input"
        type="text"
        placeholder={t('search.placeholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            step(e.shiftKey ? -1 : 1);
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
      />
      <div className="search-scope" role="tablist">
        <button
          type="button"
          className={`search-scope-btn ${scope === 'timeline' ? 'on' : ''}`}
          onClick={() => setScope('timeline')}
        >
          {t('search.timeline')}
        </button>
        <button
          type="button"
          className={`search-scope-btn ${scope === 'prompts' ? 'on' : ''}`}
          onClick={() => setScope('prompts')}
        >
          {t('search.prompts')}
        </button>
      </div>
      <span className="search-count">{count ? `${idx + 1}/${count}` : t('search.none')}</span>
      <button type="button" className="search-nav" title={t('search.prev')} onClick={() => step(-1)} disabled={!count}>
        ↑
      </button>
      <button type="button" className="search-nav" title={t('search.next')} onClick={() => step(1)} disabled={!count}>
        ↓
      </button>
      <button type="button" className="search-nav" title={t('search.close')} onClick={onClose}>
        ✕
      </button>
    </div>
  );
}
