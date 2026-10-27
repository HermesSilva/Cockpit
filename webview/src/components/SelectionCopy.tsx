import { useEffect, useRef, useState } from 'react';
import type { Translator } from '../i18n';
import { Portal } from './Portal';

// Copy for text selected in the conversation, owned by the page rather than the host.
//
// Both hosts route copy out of the page and back in: VS Code catches Ctrl+C and the context
// menu in the webview's preload and replays them as an editor command; Visual Studio turns the
// browser's context menu off altogether. Either way the conversation's text could be selected
// and not copied. So the page answers Ctrl+C and right-click itself, in the capture phase
// (ahead of the host's own listeners), and only when there is a selection outside a text
// field — a field copies its own, and with nothing selected the host keeps its default.
function selectedText(): string {
  const ae = document.activeElement;
  if (ae instanceof HTMLTextAreaElement || ae instanceof HTMLInputElement) return '';
  const sel = window.getSelection();
  return sel && !sel.isCollapsed ? sel.toString() : '';
}

function writeClipboard(text: string): void {
  const viaCommand = () => {
    try {
      document.execCommand('copy');
    } catch {
      /* nothing left to try */
    }
  };
  if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text).catch(viaCommand);
  else viaCommand();
}

export function SelectionCopy({ t }: { t: Translator }) {
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return;
      if (e.key !== 'c' && e.key !== 'C') return;
      const text = selectedText();
      if (!text) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      writeClipboard(text);
    };
    const onContext = (e: MouseEvent) => {
      const text = selectedText();
      if (!text) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setMenu({ x: e.clientX, y: e.clientY, text });
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('contextmenu', onContext, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('contextmenu', onContext, true);
    };
  }, []);

  // Open menu: any click elsewhere, Escape, a scroll or leaving the window closes it.
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onDown = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', close, true);
    window.addEventListener('blur', close);
    return () => {
      document.removeEventListener('mousedown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('blur', close);
    };
  }, [menu]);

  if (!menu) return null;
  // Kept inside the viewport: the menu is ~120x30, opened at the pointer.
  const left = Math.min(menu.x, window.innerWidth - 130);
  const top = Math.min(menu.y, window.innerHeight - 40);
  return (
    <Portal>
      <div ref={menuRef} className="sel-menu" style={{ left, top }} role="menu">
        <button
          type="button"
          className="sel-menu-item"
          role="menuitem"
          onClick={() => {
            writeClipboard(menu.text);
            setMenu(null);
          }}
        >
          {t('common.copy')}
          <span className="sel-menu-key">Ctrl+C</span>
        </button>
      </div>
    </Portal>
  );
}
