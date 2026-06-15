import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { reducer, initialState, activeTab } from './store';
import type { HostToWebview, ImageAttachment, SessionInfo, UsageData } from '../../shared/protocol';
import { send } from './vscodeApi';
import { createTranslator } from './i18n';
import { CliMissing } from './components/CliMissing';
import { Timeline, seedTaskTimings } from './components/Timeline';
import { Composer } from './components/Composer';
import { HubView } from './components/HubView';
import { UsageModal } from './components/UsageModal';
import { PermissionModal } from './components/PermissionModal';
import { AskQuestionModal } from './components/AskQuestionModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ScrollMarkers } from './components/ScrollMarkers';
import { ImageViewer, ImageViewerContext } from './components/ImageViewer';

export function App({ view, sessionId }: { view: 'chat' | 'hub'; sessionId: string }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [confirmDelete, setConfirmDelete] = useState<SessionInfo | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [showUsage, setShowUsage] = useState(false);
  const [usage, setUsage] = useState<UsageData | null>(null);
  // null = segue as settings; boolean = override do botão "expandir/colapsar tudo".
  const [allExpanded, setAllExpanded] = useState<boolean | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const atBottomRef = useRef(true); // estado vivo p/ o auto-scroll (sem stale closure)
  const t = useMemo(() => createTranslator(state.locale), [state.locale]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Chat: renderiza a sessão injetada (uma webview por contexto). Hub: a ativa.
  const tab =
    view === 'hub' ? activeTab(state) : state.tabs.find((tb) => tb.id === sessionId) ?? activeTab(state);
  const items = tab?.items ?? [];

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    atBottomRef.current = bottom;
    setAtBottom(bottom);
  };
  const scrollToBottom = () => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const data = e.data as HostToWebview;
      if (data?.kind === 'taskTimings') seedTaskTimings(data.timings); // médias do host p/ o gauge
      if (data?.kind === 'usageData') setUsage(data.data); // resposta do botão Usage (dado quente)
      dispatch({ type: 'host', msg: data });
    };
    window.addEventListener('message', onMsg);
    send({ kind: 'init' });
    if (view === 'hub') send({ kind: 'listSessions' });
    return () => window.removeEventListener('message', onMsg);
  }, [view]);

  // Conteúdo novo: só fixa no fim se o usuário JÁ estava no fim (respeita scroll manual).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  // Troca de aba: vai pro fim e reseta o estado de "no fim".
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
  }, [state.activeTab]);

  const onSend = (text: string, images: ImageAttachment[]) => {
    const previews = images.map((i) => `data:${i.mediaType};base64,${i.data}`);
    dispatch({ type: 'localUser', text, images: previews.length ? previews : undefined });
    send({ kind: 'sendMessage', text, images: images.length ? images : undefined });
  };
  const onStop = () => {
    send({ kind: 'interrupt' });
    dispatch({ type: 'interruptUi' });
  };
  const onSettings = () => send({ kind: 'openSettings' });
  const onUsage = () => {
    setUsage(null); // limpa p/ mostrar carregando; busca sempre fresco (dado quente)
    setShowUsage(true);
    send({ kind: 'fetchUsage' });
  };
  const onManageUsage = () => send({ kind: 'openLink', href: 'https://claude.ai/settings/usage' });
  const onEnableTracking = () => {
    setUsage(null); // mostra carregando; host instala wrapper e reenvia usageData
    send({ kind: 'enableUsageTracking' });
  };

  // Clique em link de arquivo (a.md-link) -> abre no editor via host.
  const onContentClick = (e: ReactMouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest('a.md-link');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href');
      if (href) send({ kind: 'openLink', href });
    }
  };

  const onModel = (model: string) => send({ kind: 'setModel', model });
  const onEffort = (effort: string) => send({ kind: 'setEffort', effort });
  const onPermissionMode = (mode: string) => send({ kind: 'setPermissionMode', mode });
  const onResume = (id: string) => send({ kind: 'resumeSession', sessionId: id });
  const onAskDelete = (session: SessionInfo) => setConfirmDelete(session);
  const onConfirmDelete = () => {
    if (confirmDelete) send({ kind: 'deleteSession', sessionId: confirmDelete.id });
    setConfirmDelete(null);
  };
  const onConfirmDeleteAll = () => {
    send({ kind: 'deleteAllSessions' });
    setConfirmDeleteAll(false);
  };
  const onPermission = (d: 'allow' | 'deny' | 'allow_always') => {
    if (tab?.permission) {
      send({ kind: 'permissionDecision', requestId: tab.permission.requestId, decision: d });
      dispatch({ type: 'clearPermission' });
    }
  };
  const onAsk = (answers: Record<string, string>) => {
    if (tab?.ask) {
      send({ kind: 'askResponse', requestId: tab.ask.requestId, answers });
      dispatch({ type: 'clearAsk', answers });
    }
  };

  const cliMissing = !state.cli.available;

  if (view === 'hub') {
    return (
      <>
        <HubView
          t={t}
          locale={state.locale}
          cliMissing={cliMissing}
          cockpitVersion={state.cli.cockpitVersion}
          cliVersion={state.cli.version}
          cliLatest={state.cli.latest}
          stats={tab?.stats}
          config={state.config}
          activeModel={tab?.stats?.model ?? tab?.session?.model}
          sessions={state.sessions}
          cwd={state.sessionsCwd}
          activeSessionId={tab?.sessionId ?? tab?.session?.sessionId}
          onNewSession={() => {
            send({ kind: 'newTab' });
            send({ kind: 'openEditor' });
          }}
          onOpenFolder={(path) => send({ kind: 'openFolder', path })}
          onSettings={onSettings}
          onUsage={onUsage}
          onLogin={() => send({ kind: 'loginCli' })}
          onLogout={() => send({ kind: 'logoutCli' })}
          onUpdate={() => send({ kind: 'updateCli' })}
          onInstall={() => send({ kind: 'installCli' })}
          onModel={onModel}
          onEffort={onEffort}
          onPermission={onPermissionMode}
          onResume={(id) => {
            onResume(id);
            send({ kind: 'openEditor' });
          }}
          onDelete={onAskDelete}
          onDeleteAll={() => setConfirmDeleteAll(true)}
        />
        {confirmDelete && (
          <ConfirmDialog
            danger
            title={t('confirm.delete.title')}
            body={t('confirm.delete.body', confirmDelete.title || t('session.untitled'))}
            confirmLabel={t('confirm.delete.action')}
            cancelLabel={t('confirm.cancel')}
            onConfirm={onConfirmDelete}
            onCancel={() => setConfirmDelete(null)}
          />
        )}
        {confirmDeleteAll && (
          <ConfirmDialog
            danger
            title={t('confirm.deleteAll.title')}
            body={t('confirm.deleteAll.body', String(state.sessions.length))}
            confirmLabel={t('confirm.deleteAll.action')}
            cancelLabel={t('confirm.cancel')}
            onConfirm={onConfirmDeleteAll}
            onCancel={() => setConfirmDeleteAll(false)}
          />
        )}
        {showUsage && (
          <UsageModal
            t={t}
            locale={state.locale}
            usage={usage}
            onClose={() => setShowUsage(false)}
            onManage={onManageUsage}
            onEnableTracking={onEnableTracking}
          />
        )}
      </>
    );
  }

  return (
    <ImageViewerContext.Provider value={setViewerSrc}>
    <div className="app">
      {(cliMissing || tab?.authRequired) && (
        <CliMissing
          t={t}
          mode={cliMissing ? 'missing' : 'login'}
          error={cliMissing ? state.cli.error : undefined}
          onInstall={() => send({ kind: 'installCli' })}
          onLogin={() => send({ kind: 'loginCli' })}
          onRecheck={() => send({ kind: 'recheckCli' })}
          onDocs={(href) => send({ kind: 'openLink', href })}
        />
      )}

      <div className="scroll-wrap">
        <div className="scroll" ref={scrollRef} onClick={onContentClick} onScroll={onScroll}>
          <Timeline
            items={items}
            t={t}
            emptyHint={items.length === 0}
            showThinking={allExpanded ?? state.config?.showThinking}
            expandTools={allExpanded ?? state.config?.expandToolCards === true}
            userName={state.config?.userName}
            todos={tab?.todos ?? []}
            answers={tab?.answers}
            busy={tab?.status === 'busy'}
            stats={tab?.stats}
          />
        </div>
        <ScrollMarkers scrollRef={scrollRef} items={items} />
        {!atBottom && (
          <button
            type="button"
            className="scroll-bottom"
            title={t('scroll.bottom')}
            onClick={scrollToBottom}
          >
            ↓
          </button>
        )}
      </div>

      <Composer
        t={t}
        busy={tab?.status === 'busy'}
        disabled={cliMissing}
        slashCommands={tab?.slashCommands ?? []}
        slashMeta={state.slashMeta}
        slashBusy={state.slashResearching}
        allExpanded={allExpanded ?? false}
        onToggleExpandAll={() => setAllExpanded((a) => !(a ?? false))}
        onSend={onSend}
        onStop={onStop}
      />

      {tab?.permission && <PermissionModal t={t} req={tab.permission} onDecision={onPermission} />}

      {tab?.ask && <AskQuestionModal t={t} req={tab.ask} onSubmit={onAsk} />}

      {confirmDelete && (
        <ConfirmDialog
          danger
          title={t('confirm.delete.title')}
          body={t('confirm.delete.body', confirmDelete.title || t('session.untitled'))}
          confirmLabel={t('confirm.delete.action')}
          cancelLabel={t('confirm.cancel')}
          onConfirm={onConfirmDelete}
          onCancel={() => setConfirmDelete(null)}
        />
      )}
    </div>
      {viewerSrc && <ImageViewer t={t} src={viewerSrc} onClose={() => setViewerSrc(null)} />}
    </ImageViewerContext.Provider>
  );
}
