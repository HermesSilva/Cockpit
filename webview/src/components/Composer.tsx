import { useState, useRef, useEffect, type KeyboardEvent, type ClipboardEvent, type DragEvent } from 'react';
import type { Translator } from '../i18n';
import type { ImageAttachment, SlashCmdMeta } from '../../../shared/protocol';
import { send, saveState, readState } from '../vscodeApi';
import { richHighlight } from '../util/highlight';
import {
  ensureSpell,
  spellReady,
  suggest,
  addUserWord,
  ignoreWord,
  onSpellUpdate,
  type Suggestions,
} from '../spell/spell';
import { useImageViewer } from './ImageViewer';
import { SpellDropdown } from './SpellDropdown';
import { Tooltip } from './Tooltip';
import { SlashMenu } from './SlashMenu';

interface Props {
  t: Translator;
  locale: string;
  correctEnabled: boolean;
  spellCheck: boolean; // corretor ortográfico ao digitar (marca palavras no overlay)
  busy: boolean;
  disabled: boolean;
  slashCommands: string[];
  slashMeta: Record<string, SlashCmdMeta>;
  slashBusy: boolean;
  allExpanded: boolean;
  // Draft a restaurar no input (ex.: cancelou o gate de effort). Muda de ref p/ disparar.
  injectDraft?: { text: string; images: ImageAttachment[] } | null;
  onDraftInjected?: () => void;
  // Texto a inserir no input sem apagar o que já existe (ex.: valor de credencial
  // liberado pelo cofre). Muda de ref p/ disparar a inserção.
  injectText?: { text: string } | null;
  onTextInjected?: () => void;
  onToggleExpandAll: () => void;
  onSend: (text: string, images: ImageAttachment[], selection?: string) => void;
  selectionRef?: string; // @file#a-b da seleção ativa do editor
  onStop: () => void;
  onVoiceDict?: () => void; // abre o modal do dicionário de ditado
  onCredentials?: () => void; // abre o cofre de credenciais (TOTP 2FA)
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
  locale,
  correctEnabled,
  spellCheck,
  busy,
  disabled,
  slashCommands,
  slashMeta,
  slashBusy,
  allExpanded,
  injectDraft,
  onDraftInjected,
  injectText,
  onTextInjected,
  onToggleExpandAll,
  onSend,
  onStop,
  onVoiceDict,
  onCredentials,
  selectionRef,
}: Props) {
  const [includeSel, setIncludeSel] = useState(true);
  const [text, setText] = useState('');
  const [images, setImages] = useState<PendingImage[]>([]);
  const openImage = useImageViewer();
  const [slashIdx, setSlashIdx] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  // @-mention: token sendo digitado + resultados do host + índice selecionado.
  const [mention, setMention] = useState<{ start: number; query: string } | null>(null);
  const [mentionItems, setMentionItems] = useState<string[]>([]);
  const [mentionIdx, setMentionIdx] = useState(0);
  const mentionReq = useRef('');
  const ref = useRef<HTMLTextAreaElement>(null);
  const hadFocus = useRef(false); // textarea estava focado quando a janela perdeu o foco
  const hlRef = useRef<HTMLPreElement>(null); // espelho com syntax highlight atrás do textarea
  const baseH = useRef(0); // altura padrão (rows=2), capturada na 1ª medição
  // Ditado por voz: estado do botão + base do texto ao começar. A captura do mic
  // acontece NO HOST (webview do VSCode bloqueia getUserMedia); aqui só sinaliza.
  const [recording, setRecording] = useState(false);
  const [connecting, setConnecting] = useState(false); // clicou no mic, aguardando WS+áudio (spinner)
  const [correcting, setCorrecting] = useState(false); // corrigindo texto (input readonly)
  const recordingRef = useRef(false); // espelho síncrono p/ os listeners (sem stale closure)
  const voiceBaseRef = useRef('');
  // Corretor ortográfico: tick força re-render do overlay quando os dicionários
  // terminam de carregar; spellMenu controla o dropdown de correção aberto.
  const [spellTick, setSpellTick] = useState(0);
  const [spellMenu, setSpellMenu] = useState<{
    word: string;
    start: number;
    left: number;
    top: number; // y abaixo da palavra (posição preferida)
    anchorTop: number; // y do topo da palavra (p/ inverter o menu pra cima)
    sug: Suggestions | null; // null = carregando sugestões do host
  } | null>(null);

  // Cliente do corretor: liga o listener e re-renderiza o overlay sempre que
  // chega veredito novo do host (palavras marcadas/desmarcadas).
  useEffect(() => {
    void ensureSpell();
    const off = onSpellUpdate(() => setSpellTick((n) => n + 1));
    return off;
  }, []);

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
    // spell=true marca palavras erradas (após os dicionários carregarem; spellTick).
    if (hl) hl.innerHTML = `${richHighlight(text, spellCheck && spellReady())}\n`;
  }, [text, spellTick, spellCheck]);

  // Foco perdido ao voltar de outro app: quando a janela do VSCode é reativada, o
  // webview reconcilia o foco e BLURa o elemento ativo LOGO APÓS o clique — o
  // textarea, que o clique acabara de focar, perde o foco. Rearma: se o textarea
  // estava focado ao sair, restaura ao voltar, a menos que o usuário já tenha
  // focado outro controle (activeElement !== body/null/textarea).
  useEffect(() => {
    const onWinBlur = () => {
      hadFocus.current = document.activeElement === ref.current;
    };
    const restore = () => {
      const el = ref.current;
      if (!el || disabled) return;
      const ae = document.activeElement;
      if (ae === null || ae === document.body || ae === el) {
        el.focus();
        return true;
      }
      return false;
    };
    const onWinFocus = () => {
      if (!hadFocus.current) return;
      // O blur do VSCode é assíncrono; tenta em alguns instantes até pegar.
      requestAnimationFrame(() => restore());
      window.setTimeout(restore, 50);
      window.setTimeout(restore, 150);
    };
    window.addEventListener('blur', onWinBlur);
    window.addEventListener('focus', onWinFocus);
    return () => {
      window.removeEventListener('blur', onWinBlur);
      window.removeEventListener('focus', onWinFocus);
    };
  }, [disabled]);

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

  // Junta dois trechos com um espaço se necessário.
  const joinText = (a: string, b: string) => (a && !/\s$/.test(a) ? `${a} ${b}` : `${a}${b}`);

  // Transcrições vindas do host (STT): parcial atualiza ao vivo; final fixa.
  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data;
      if (m?.kind === 'voiceReady') {
        setConnecting(false); // WS + áudio fluindo: tira o spinner, pode falar
      } else if (m?.kind === 'voiceTranscript') {
        if (!recordingRef.current) return; // ignora transcrições tardias (parou/digitou)
        if (m.isFinal) {
          voiceBaseRef.current = joinText(voiceBaseRef.current, m.text);
          setText(voiceBaseRef.current);
        } else {
          setText(joinText(voiceBaseRef.current, m.text));
        }
      } else if (m?.kind === 'voiceClosed') {
        stopVoice();
      } else if (m?.kind === 'voiceError') {
        // eslint-disable-next-line no-console
        console.warn('[voice] error:', m.message);
        stopVoice();
      } else if (m?.kind === 'voiceCorrected') {
        voiceBaseRef.current = m.text;
        setText(m.text); // troca pelo corrigido
        setCorrecting(false); // libera o input p/ RW
        requestAnimationFrame(() => ref.current?.focus());
      } else if (m?.kind === 'voiceCorrectError') {
        setCorrecting(false); // mantém o original, libera
      }
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stopVoice = () => {
    if (recordingRef.current) send({ kind: 'voiceStop' });
    recordingRef.current = false;
    setRecording(false);
    setConnecting(false);
  };

  const toggleVoice = () => {
    if (recording) {
      stopVoice();
      // Correção habilitada: trava o input (readonly) e manda corrigir via Haiku.
      if (correctEnabled && text.trim()) {
        setCorrecting(true);
        send({ kind: 'voiceCorrect', text });
      }
    } else {
      if (disabled || correcting) return;
      voiceBaseRef.current = text;
      recordingRef.current = true;
      setRecording(true);
      setConnecting(true); // spinner até o host sinalizar voiceReady (mic vivo)
      send({ kind: 'voiceStart', language: locale }); // host abre o WS e captura o mic (ffmpeg)
      requestAnimationFrame(() => ref.current?.focus()); // foco no input ao ligar
    }
  };

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

  // Drag-to-attach: solta arquivos no composer. Usa o path do arquivo (ou o
  // uri-list) p/ anexar; imagens sem path entram como bitmap.
  const onDrop = (e: DragEvent<HTMLTextAreaElement>) => {
    const dt = e.dataTransfer;
    if (!dt) return;
    const files = Array.from(dt.files || []);
    const directPaths: string[] = [];
    const bitmaps: File[] = [];
    for (const f of files) {
      const p = (f as unknown as { path?: string }).path;
      if (p) directPaths.push(p);
      else if (f.type.startsWith('image/')) bitmaps.push(f);
    }
    if (directPaths.length === 0) {
      const uri = dt.getData('text/uri-list');
      for (const line of uri.split('\n').map((s) => s.trim())) {
        if (line.startsWith('file:')) directPaths.push(fileUriToPath(line));
      }
    }
    if (!directPaths.length && !bitmaps.length) return; // nada de arquivo: deixa o default (texto)
    e.preventDefault();
    if (directPaths.length) requestPaths(directPaths);
    bitmaps.forEach(attachImage);
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

  // Anti-perda do rascunho/ditado: na montagem, restaura do estado local do
  // webview (sobrevive a reload/crash do renderer e a reinício do VSCode).
  useEffect(() => {
    const saved = readState<{ draft?: string }>()?.draft;
    if (saved && !text) {
      voiceBaseRef.current = saved;
      setText(saved);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Espelha o texto atual no estado local (setState) e no HOST (sobrevive à morte
  // do renderer — tela branca). Debounce p/ não floodar. Restaurado no reload.
  const draftTimer = useRef<number | undefined>(undefined);
  const mirroredOnce = useRef(false);
  useEffect(() => {
    // Não apaga o rascunho do host na montagem com texto vazio (corrida com o
    // restore que ainda vai chegar). Só passa a espelhar após o 1º conteúdo.
    if (!mirroredOnce.current && !text) return;
    mirroredOnce.current = true;
    window.clearTimeout(draftTimer.current);
    draftTimer.current = window.setTimeout(() => {
      saveState({ draft: text });
      send({ kind: 'draftChanged', text });
    }, 350);
    return () => window.clearTimeout(draftTimer.current);
  }, [text]);

  // Restaura um draft (ex.: cancelou o gate de effort: o texto havia sido limpo;
  // ou recuperação pós-crash vinda do host).
  useEffect(() => {
    if (!injectDraft) return;
    setText(injectDraft.text);
    setImages(
      injectDraft.images.map((i) => ({
        id: rid(),
        mediaType: i.mediaType,
        data: i.data,
        url: `data:${i.mediaType};base64,${i.data}`,
      })),
    );
    requestAnimationFrame(() => ref.current?.focus());
    onDraftInjected?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectDraft]);

  // Insere texto (valor de credencial) na posição do cursor, sem apagar o resto.
  useEffect(() => {
    if (!injectText) return;
    const ins = injectText.text;
    const el = ref.current;
    setText((prev) => {
      const start = el?.selectionStart ?? prev.length;
      const end = el?.selectionEnd ?? prev.length;
      return prev.slice(0, start) + ins + prev.slice(end);
    });
    requestAnimationFrame(() => ref.current?.focus());
    onTextInjected?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [injectText]);

  const submit = () => {
    // Enviar durante o ditado: encerra a captura JÁ (sem correção) e cancela uma
    // correção pendente — senão o botão segue gravando e transcrições tardias
    // repopulam a área após o clear. recordingRef=false ANTES p/ o listener de
    // voiceTranscript ignorar o que ainda chegar.
    if (recordingRef.current) {
      recordingRef.current = false;
      setRecording(false);
      setConnecting(false);
      send({ kind: 'voiceStop' });
    }
    if (correcting) setCorrecting(false); // cancela correção em curso, envia o que tem
    const v = text.trim();
    if ((!v && images.length === 0) || disabled) return;
    onSend(
      v,
      images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
      includeSel && selectionRef ? selectionRef : undefined,
    );
    setText('');
    setImages([]);
    setMention(null);
    // Enviado: zera o rascunho espelhado (local + host) p/ não restaurar texto velho.
    saveState({ draft: '' });
    send({ kind: 'draftChanged', text: '' });
    requestAnimationFrame(() => ref.current?.focus());
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (mentionOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIdx((i) => (i + 1) % mentionItems.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIdx((i) => (i - 1 + mentionItems.length) % mentionItems.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        pickMention(mentionItems[Math.min(mentionIdx, mentionItems.length - 1)]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
    }
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
      submit(); // submit() já encerra ditado/correção em curso e envia
    }
  };

  // Clique no textarea: se o caret cair sobre uma palavra marcada (.spell-error no
  // overlay), abre o dropdown ancorado no span correspondente.
  const openSpellAt = (caret: number) => {
    const hl = hlRef.current;
    if (!hl) return setSpellMenu(null);
    for (const sp of Array.from(hl.querySelectorAll<HTMLElement>('.spell-error'))) {
      const start = Number(sp.dataset.ss);
      const word = sp.dataset.sw ?? sp.textContent ?? '';
      if (caret >= start && caret <= start + word.length) {
        const r = sp.getBoundingClientRect();
        setSpellMenu({ word, start, left: r.left, top: r.bottom + 2, anchorTop: r.top, sug: null });
        // Sugestões vêm do host (assíncrono); preenche quando chegarem.
        void suggest(word).then((s) =>
          setSpellMenu((cur) => (cur && cur.word === word && cur.start === start ? { ...cur, sug: s } : cur)),
        );
        return;
      }
    }
    setSpellMenu(null);
  };

  const applySpell = (replacement: string) => {
    if (!spellMenu) return;
    const { start, word } = spellMenu;
    setText((prev) => prev.slice(0, start) + replacement + prev.slice(start + word.length));
    setSpellMenu(null);
    const pos = start + replacement.length;
    requestAnimationFrame(() => {
      const el = ref.current;
      if (el) {
        el.focus();
        el.selectionStart = el.selectionEnd = pos;
      }
    });
  };

  const addSpell = () => {
    if (!spellMenu) return;
    addUserWord(spellMenu.word);
    setSpellMenu(null);
    setSpellTick((n) => n + 1);
  };
  const ignoreSpell = () => {
    if (!spellMenu) return;
    ignoreWord(spellMenu.word);
    setSpellMenu(null);
    setSpellTick((n) => n + 1);
  };

  // @-mention: detecta um token "@..." imediatamente antes do caret e pede arquivos.
  const mentionTimer = useRef<number | undefined>(undefined);
  const detectMention = (value: string, caret: number) => {
    const m = /(^|\s)@([^\s@]*)$/.exec(value.slice(0, caret));
    if (!m) {
      if (mention) setMention(null);
      return;
    }
    const query = m[2];
    const start = caret - query.length - 1; // posição do '@'
    setMention({ start, query });
    setMentionIdx(0);
    window.clearTimeout(mentionTimer.current);
    const requestId = rid();
    mentionReq.current = requestId;
    mentionTimer.current = window.setTimeout(() => {
      send({ kind: 'mentionSearch', requestId, query });
    }, 150);
  };

  const pickMention = (relPath: string) => {
    if (!mention) return;
    const el = ref.current;
    setText((prev) => {
      const end = mention.start + 1 + mention.query.length;
      const next = `${prev.slice(0, mention.start)}@${relPath} ${prev.slice(end)}`;
      const pos = mention.start + 1 + relPath.length + 1;
      requestAnimationFrame(() => {
        if (el) {
          el.focus();
          el.selectionStart = el.selectionEnd = pos;
        }
      });
      return next;
    });
    setMention(null);
    setMentionItems([]);
  };

  // Resultados do host p/ a @-mention (só aplica o pedido mais recente).
  useEffect(() => {
    const h = (e: MessageEvent) => {
      const m = e.data;
      if (m?.kind === 'mentionResults' && m.requestId === mentionReq.current) {
        setMentionItems(m.items ?? []);
        setMentionIdx(0);
      }
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, []);

  const mentionOpen = mention !== null && mentionItems.length > 0;

  const canSend = !disabled && !correcting && (!!text.trim() || images.length > 0);

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
      {mentionOpen && (
        <div className="slash-menu mention-menu">
          {mentionItems.map((it, i) => (
            <button
              type="button"
              key={it}
              className={`slash-item ${i === mentionIdx ? 'active' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                pickMention(it);
              }}
            >
              @{it}
            </button>
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
      {selectionRef && (
        <button
          type="button"
          className={`composer-selchip ${includeSel ? 'on' : 'off'}`}
          title={includeSel ? t('selection.included') : t('selection.excluded')}
          onClick={() => setIncludeSel((v) => !v)}
        >
          <span className="composer-selchip-eye">{includeSel ? '◉' : '◌'}</span>
          ⧉ {selectionRef}
        </button>
      )}
      <div className="composer-row">
        <div
          className="composer-input-wrap"
          onMouseDown={(e) => {
            // Clique na área vazia (abaixo do texto): mantém o foco no textarea.
            if (e.target !== ref.current && !correcting) {
              e.preventDefault();
              const el = ref.current;
              if (el) {
                el.focus();
                const end = el.value.length;
                el.setSelectionRange(end, end);
              }
            }
          }}
        >
          <pre className="composer-highlight hljs" ref={hlRef} aria-hidden="true" />
          {connecting && (
            <div className="voice-connecting" role="status">
              <span className="voice-spinner" aria-hidden="true" />
              <span>{t('voice.connecting')}</span>
            </div>
          )}
          <textarea
            ref={ref}
            className="composer-input"
            placeholder={
              correcting ? t('voice.correcting') : connecting ? t('voice.connecting') : t('composer.placeholder')
            }
            value={text}
            disabled={disabled}
            readOnly={correcting}
            rows={2}
            onChange={(e) => {
              if (recordingRef.current) stopVoice(); // digitou: encerra o ditado na hora
              const val = e.target.value;
              const caret = e.target.selectionStart ?? val.length;
              setText(val);
              setSlashDismissed(false);
              setSlashIdx(0);
              if (spellMenu) setSpellMenu(null);
              detectMention(val, caret);
            }}
            onClick={(e) => openSpellAt(e.currentTarget.selectionStart ?? 0)}
            onKeyDown={onKey}
            onPaste={onPaste}
            onDragOver={(e) => e.preventDefault()}
            onDrop={onDrop}
            onScroll={() => {
              syncScroll();
              if (spellMenu) setSpellMenu(null);
            }}
          />
        </div>
        <div className="composer-side">
          <Tooltip
            text={
              correcting
                ? t('voice.correcting')
                : connecting
                  ? t('voice.connecting')
                  : recording
                    ? t('voice.stop')
                    : t('voice.start')
            }
          >
            <button
              type="button"
              className={`composer-side-btn voice ${recording ? 'recording' : ''} ${correcting ? 'correcting' : ''} ${connecting ? 'connecting' : ''}`}
              onClick={toggleVoice}
              disabled={disabled || correcting}
              aria-pressed={recording}
            >
              {correcting || connecting ? (
                <span className="voice-spinner" aria-hidden="true" />
              ) : recording ? (
                <svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">
                  <rect x="6" y="6" width="12" height="12" rx="2.5" fill="currentColor" />
                </svg>
              ) : (
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="9" y="2" width="6" height="11" rx="3" />
                  <path d="M5 10a7 7 0 0 0 14 0" />
                  <line x1="12" y1="17" x2="12" y2="21" />
                  <line x1="8" y1="21" x2="16" y2="21" />
                </svg>
              )}
            </button>
          </Tooltip>
          {onVoiceDict && (
            <Tooltip text={t('voicedict.open')}>
              <button
                type="button"
                className="composer-side-btn voicedict-btn"
                onClick={onVoiceDict}
                aria-label={t('voicedict.open')}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M4 5a2 2 0 0 1 2-2h13v18H6a2 2 0 0 1-2-2z" />
                  <line x1="9" y1="7" x2="15" y2="7" />
                  <line x1="9" y1="11" x2="15" y2="11" />
                </svg>
              </button>
            </Tooltip>
          )}
          {onCredentials && (
            <Tooltip text={t('creds.open')}>
              <button
                type="button"
                className="composer-side-btn creds-btn"
                onClick={onCredentials}
                aria-label={t('creds.open')}
              >
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <rect x="3" y="11" width="18" height="11" rx="2" />
                  <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                </svg>
              </button>
            </Tooltip>
          )}
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
      {spellMenu && (
        <SpellDropdown
          t={t}
          word={spellMenu.word}
          sug={spellMenu.sug ?? { pt: [], en: [] }}
          loading={spellMenu.sug === null}
          left={spellMenu.left}
          top={spellMenu.top}
          anchorTop={spellMenu.anchorTop}
          onPick={applySpell}
          onAdd={addSpell}
          onIgnore={ignoreSpell}
          onClose={() => setSpellMenu(null)}
        />
      )}
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
