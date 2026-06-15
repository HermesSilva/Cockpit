import { useState, useRef, useEffect, type KeyboardEvent, type ClipboardEvent } from 'react';
import type { Translator } from '../i18n';
import type { ImageAttachment, SlashCmdMeta } from '../../../shared/protocol';
import { send } from '../vscodeApi';
import { richHighlight } from '../util/highlight';
import { useImageViewer } from './ImageViewer';
import { Tooltip } from './Tooltip';
import { SlashMenu } from './SlashMenu';

interface Props {
  t: Translator;
  busy: boolean;
  disabled: boolean;
  slashCommands: string[];
  slashMeta: Record<string, SlashCmdMeta>;
  slashBusy: boolean;
  allExpanded: boolean;
  onToggleExpandAll: () => void;
  onSend: (text: string, images: ImageAttachment[]) => void;
  onStop: () => void;
}

interface PendingImage {
  id: string;
  mediaType: string;
  data: string; // base64 sem prefixo
  url: string; // data URL para preview
}

let seq = 0;
const rid = () => `c_${Date.now()}_${seq++}`;

export function Composer({
  t,
  busy,
  disabled,
  slashCommands,
  slashMeta,
  slashBusy,
  allExpanded,
  onToggleExpandAll,
  onSend,
  onStop,
}: Props) {
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const openImage = useImageViewer();
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLPreElement>(null); // espelho com syntax highlight atrás do textarea
  const baseH = useRef(0); // altura padrão (rows=2), capturada na 1ª medição

  // Auto-expande a altura (até 4x) e atualiza o espelho de highlight.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!baseH.current) baseH.current = el.clientHeight; // 2 linhas, antes de qualquer height inline
    el.style.height = 'auto';
    const max = baseH.current * 4;
    el.style.height = `${Math.max(Math.min(el.scrollHeight, max), baseH.current)}px`;
    el.style.overflowY = el.scrollHeight > max ? 'auto' : 'hidden';
    const hl = hlRef.current;
    // \n final garante que a última linha (e quebras finais) tenham altura no espelho.
    if (hl) hl.innerHTML = `${richHighlight(text)}\n`;
  }, [text]);

  const syncScroll = () => {
    const el = ref.current;
    const hl = hlRef.current;
    if (el && hl) {
      hl.scrollTop = el.scrollTop;
      hl.scrollLeft = el.scrollLeft;
    }
  };

  // Menu de slash: aberto quando o texto é um único token "/..." e há matches.
  const slashQuery =
    !slashDismissed && /^\/[^\s]*$/.test(text) ? text.slice(1).toLowerCase() : null;
  const slashMatches =
    slashQuery !== null
      ? slashCommands.filter((c) => c.toLowerCase().includes(slashQuery)).slice(0, 8)
      : [];
  const slashOpen = slashMatches.length > 0;

  const pickSlash = (cmd: string) => {
    setText(`/${cmd} `);
    setSlashDismissed(true);
    requestAnimationFrame(() => ref.current?.focus());
  };
  // requestId -> contexto do paste (bitmaps p/ screenshot; directPaths p/ fallback não-Windows).
  const pending = useRef<Map<string, { bitmaps: File[]; directPaths: string[] }>>(new Map());

  // Resposta do host: tem caminho(s) -> insere; vazio -> fallback (bitmap ou directPaths).
  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data;
      if (m?.kind === 'resolvedPath' && pending.current.has(m.requestId)) {
        const ctx = pending.current.get(m.requestId) ?? { bitmaps: [], directPaths: [] };
        pending.current.delete(m.requestId);
        if (m.text) insertAtCaret(m.text); // host autoritativo (Windows): acentos OK
        else if (ctx.directPaths.length) requestPaths(ctx.directPaths); // não-Windows
        else ctx.bitmaps.forEach(attachImage); // foi screenshot
      }
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, []);

  const insertAtCaret = (s: string) => {
    const el = ref.current;
    setText((prev) => {
      if (!el) return prev ? `${prev} ${s}` : s;
      const start = el.selectionStart ?? prev.length;
      const end = el.selectionEnd ?? prev.length;
      const before = prev.slice(0, start);
      const after = prev.slice(end);
      const sep = before && !before.endsWith(' ') ? ' ' : '';
      const next = `${before}${sep}${s}${after}`;
      const pos = before.length + sep.length + s.length;
      requestAnimationFrame(() => {
        el.focus();
        el.selectionStart = el.selectionEnd = pos;
      });
      return next;
    });
  };

  const attachImage = (f: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      const comma = url.indexOf(',');
      const data = comma >= 0 ? url.slice(comma + 1) : '';
      setImages((prev) => [...prev, { id: rid(), mediaType: f.type || 'image/png', data, url }]);
    };
    reader.readAsDataURL(f);
  };

  const requestPaths = (absPaths: string[]) => {
    const requestId = rid();
    pending.current.set(requestId, { bitmaps: [], directPaths: [] });
    send({ kind: 'resolvePaths', requestId, absPaths });
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const cd = e.clipboardData;
    if (!cd) return;
    const fileItems = Array.from(cd.items || []).filter((it) => it.kind === 'file');
    if (fileItems.length === 0) return; // texto normal: cola direto

    e.preventDefault();

    // Fallbacks do webview (usados só se o host não retornar arquivos — ex.: não-Windows).
    const directPaths: string[] = [];
    const bitmaps: File[] = [];
    for (const it of fileItems) {
      const f = it.getAsFile();
      if (!f) continue;
      const p = (f as unknown as { path?: string }).path;
      if (p) directPaths.push(p);
      else if (f.type.startsWith('image/')) bitmaps.push(f);
    }
    if (directPaths.length === 0) {
      const uri = cd.getData('text/uri-list');
      for (const line of uri.split('\n').map((s) => s.trim())) {
        if (line.startsWith('file:')) directPaths.push(fileUriToPath(line));
      }
    }

    // Fonte autoritativa: host lê o FileDropList do SO (path Unicode exato, acentos OK).
    // Se vier vazio (foi screenshot ou SO não-Windows) -> bitmap/directPaths.
    const requestId = rid();
    pending.current.set(requestId, { bitmaps, directPaths });
    send({ kind: 'readClipboardFiles', requestId });
  };

  const submit = () => {
    const v = text.trim();
    if ((!v && images.length === 0) || disabled) return;
    onSend(
      v,
      images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
    );
    setText('');
    setImages([]);
    requestAnimationFrame(() => ref.current?.focus());
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashIdx((i) => (i + 1) % slashMatches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashIdx((i) => (i - 1 + slashMatches.length) % slashMatches.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickSlash(slashMatches[Math.min(slashIdx, slashMatches.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setSlashDismissed(true);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const canSend = !disabled && (!!text.trim() || images.length > 0);

  return (
    <div className="composer">
      {images.length > 0 && (
        <div className="attachments">
          {images.map((img) => (
            <div className="attachment" key={img.id}>
              <button
                type="button"
                className="attachment-thumb"
                title={t('attach.view')}
                onClick={() => openImage(img.url)}
              >
                <img src={img.url} alt="" />
              </button>
              <button
                type="button"
                className="attachment-remove"
                title={t('attach.remove')}
                onClick={() => setImages((prev) => prev.filter((x) => x.id !== img.id))}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
      {slashOpen && (
        <div className="slash-menu">
          {slashMatches.map((c, i) => (
            <button
              type="button"
              key={c}
              className={`slash-item ${i === slashIdx ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pickSlash(c);
              }}
            >
              /{c}
            </button>
          ))}
        </div>
      )}
      <div className="composer-row">
        <div className="composer-input-wrap">
          <pre className="composer-highlight hljs" ref={hlRef} aria-hidden="true" />
          <textarea
            ref={ref}
            className="composer-input"
            placeholder={t('composer.placeholder')}
            value={text}
            disabled={disabled}
            rows={2}
            onChange={(e) => {
              setText(e.target.value);
              setSlashDismissed(false);
              setSlashIdx(0);
            }}
            onKeyDown={onKey}
            onPaste={onPaste}
            onScroll={syncScroll}
          />
        </div>
        <div className="composer-side">
          <SlashMenu t={t} commands={slashCommands} meta={slashMeta} busy={slashBusy} onPick={pickSlash} />
          <Tooltip text={allExpanded ? t('composer.collapseAll') : t('composer.expandAll')}>
            <button
              type="button"
              className={`composer-side-btn ${allExpanded ? 'on' : ''}`}
              onClick={onToggleExpandAll}
            >
              {allExpanded ? '⏶' : '⏷'}
            </button>
          </Tooltip>
          {busy ? (
            <button type="button" className="btn stop" onClick={onStop}>
              {t('composer.stop')}
            </button>
          ) : (
            <button type="button" className="btn send" onClick={submit} disabled={!canSend}>
              {t('composer.send')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function fileUriToPath(uri: string): string {
  try {
    let p = decodeURIComponent(uri.replace(/^file:\/\//, ''));
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1).replace(/\//g, '\\'); // /C:/x -> C:\x
    return p;
  } catch {
    return uri;
  }
}
