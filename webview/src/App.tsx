import {
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { reducer, initialState, activeTab } from './store';
import type {
  HostToWebview,
  ImageAttachment,
  PluginsData,
  SessionInfo,
  UsageData,
  VoiceDictData,
} from '../../shared/protocol';
import { send } from './vscodeApi';
import { createTranslator } from './i18n';
import { CliMissing } from './components/CliMissing';
import { Timeline, seedTaskTimings } from './components/Timeline';
import { Composer } from './components/Composer';
import { HubView } from './components/HubView';
import { UsageModal } from './components/UsageModal';
import { PluginsModal } from './components/PluginsModal';
import { VoiceDictModal } from './components/VoiceDictModal';
import { PermissionModal } from './components/PermissionModal';
import { AskQuestionModal } from './components/AskQuestionModal';
import { ConfirmDialog } from './components/ConfirmDialog';
import { ScrollMarkers } from './components/ScrollMarkers';
import { SearchBar } from './components/SearchBar';
import { ImageViewer, ImageViewerContext } from './components/ImageViewer';
import { buildConversationMd, suggestedFileName } from './util/exportMd';
import { resetSpell } from './spell/spell';

export function App({ view, sessionId }: { view: 'chat' | 'hub'; sessionId: string }) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [confirmDelete, setConfirmDelete] = useState<SessionInfo | null>(null);
  const [confirmDeleteAll, setConfirmDeleteAll] = useState(false);
  const [confirmRewind, setConfirmRewind] = useState<number | null>(null);
  // Gate de effort: o host bloqueia e manda 'effortGate'; guardamos o último envio
  // p/ reenviar com force=true se o usuário confirmar.
  const [confirmEffort, setConfirmEffort] = useState<{ selected: string; min: string } | null>(null);
  const lastSendRef = useRef<{ text: string; images: ImageAttachment[] } | null>(null);
  const [draftRestore, setDraftRestore] = useState<{ text: string; images: ImageAttachment[] } | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [showPlugins, setShowPlugins] = useState(false);
  const [plugins, setPlugins] = useState<PluginsData | null>(null);
  const [showVoiceDict, setShowVoiceDict] = useState(false);
  const [voiceDict, setVoiceDict] = useState<VoiceDictData | null>(null);
  const [exportMenu, setExportMenu] = useState(false); // link de export expandido (direto/IA)
  const [pluginsBusy, setPluginsBusy] = useState(false);
  const [pluginsBusyLabel, setPluginsBusyLabel] = useState<string | undefined>(undefined);
  const [pluginsError, setPluginsError] = useState<string | undefined>(undefined);
  // null = segue as settings; boolean = override do botão "expandir/colapsar tudo".
  const [allExpanded, setAllExpanded] = useState<boolean | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [showSearch, setShowSearch] = useState(false);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const atBottomRef = useRef(true); // estado vivo p/ o auto-scroll (sem stale closure)
  const t = useMemo(() => createTranslator(state.locale), [state.locale]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Chat: renderiza a sessão injetada (uma webview por contexto). Hub: a ativa.
  const tab =
    view === 'hub' ? activeTab(state) : state.tabs.find((tb) => tb.id === sessionId) ?? activeTab(state);
  const items = tab?.items ?? [];

  // Ctrl+F: abre a barra de busca (só no chat, não no hub).
  useEffect(() => {
    if (view === 'hub') return;
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        e.stopPropagation();
        setShowSearch(true);
      }
    };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [view]);

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
      if (data?.kind === 'effortGate') setConfirmEffort({ selected: data.selected, min: data.min });
      if (data?.kind === 'draftRestore' && data.text) setDraftRestore({ text: data.text, images: [] });
      if (data?.kind === 'voiceDict') setVoiceDict(data.data);
      if (data?.kind === 'pluginsData') setPlugins(data.data);
      if (data?.kind === 'pluginsBusy') {
        setPluginsBusy(data.busy);
        setPluginsBusyLabel(data.busy ? data.label : undefined);
        if (data.busy) setPluginsError(undefined);
      }
      if (data?.kind === 'pluginsError') setPluginsError(data.message);
      dispatch({ type: 'host', msg: data });
    };
    window.addEventListener('message', onMsg);
    send({ kind: 'init' });
    if (view === 'hub') send({ kind: 'listSessions' });
    return () => window.removeEventListener('message', onMsg);
  }, [view]);

  // Heartbeat de renderização: prova ao host que o processo do webview está vivo.
  // Se o renderer cair (bug GPU do VSCode → tela branca), os pulsos param e o host
  // força um reload do HTML (remonta o React → replay do transcript). Fora do ciclo
  // do React de propósito: um render pesado de timeline atrasa o tick, mas ele
  // dispara assim que a stack limpa — só renderer realmente morto fica sem bater.
  useEffect(() => {
    send({ kind: 'heartbeat' });
    const id = setInterval(() => send({ kind: 'heartbeat' }), 10_000);
    return () => clearInterval(id);
  }, []);

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

  // Envia otimista (bolha local + manda ao host). O gate de effort é decidido NO
  // HOST (lê o CLAUDE.md da pasta): se bloquear, manda 'effortGate' e não roda;
  // confirmando, reenviamos o último com force=true.
  const onSend = (text: string, images: ImageAttachment[], selection?: string) => {
    lastSendRef.current = { text, images };
    const previews = images.map((i) => `data:${i.mediaType};base64,${i.data}`);
    dispatch({ type: 'localUser', text, images: previews.length ? previews : undefined });
    send({ kind: 'sendMessage', text, images: images.length ? images : undefined, selection });
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
  const onPlugins = () => {
    setShowPlugins(true);
    send({ kind: 'pluginsRefresh' }); // carrega ao abrir
  };
  const onVoiceDict = () => {
    setVoiceDict(null); // mostra carregando até o host responder
    setShowVoiceDict(true);
    send({ kind: 'voiceDictGet' });
  };
  const onExportMd = (mode: 'direct' | 'ai') => {
    const title = state.tabs.find((x) => x.id === state.activeTab)?.title;
    send({
      kind: 'exportMd',
      markdown: buildConversationMd(items, t, title, state.config?.userName),
      fileName: suggestedFileName(title),
      mode,
    });
  };
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
  const onPermission = (d: 'allow' | 'deny' | 'allow_always', message?: string) => {
    if (tab?.permission) {
      send({ kind: 'permissionDecision', requestId: tab.permission.requestId, decision: d, message });
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
  // Carregando: host ainda não reportou o status do CLI, OU a aba ainda não
  // recebeu o histórico (reabrir contexto). Evita o flash do banner e do timeline
  // vazio — mostra o loader do Cockpit. Banner só após o status do CLI.
  const cliLoading = !state.cli.checked || (!!tab?.sessionId && !tab.historyLoaded);

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
          busy={tab?.status === 'busy'}
          config={state.config}
          activeModel={tab?.stats?.model ?? tab?.session?.model}
          loggedIn={state.loggedIn}
          sessions={state.sessions}
          cwd={state.sessionsCwd}
          activeSessionId={tab?.sessionId ?? tab?.session?.sessionId}
          busySessions={
            new Set(
              state.tabs
                .filter((tb) => tb.status === 'busy' && tb.sessionId)
                .map((tb) => tb.sessionId as string),
            )
          }
          onNewSession={() => {
            send({ kind: 'newTab' });
            send({ kind: 'openEditor' });
          }}
          onOpenFolder={(path) => send({ kind: 'openFolder', path })}
          onSettings={onSettings}
          onUsage={onUsage}
          onPlugins={onPlugins}
          onLogin={() => send({ kind: 'loginCli' })}
          onLogout={() => send({ kind: 'logoutCli' })}
          onUpdate={() => send({ kind: 'updateCli' })}
          onInstall={() => send({ kind: 'installCli' })}
          onOpenLink={(href) => send({ kind: 'openLink', href })}
          onModel={onModel}
          onEffort={onEffort}
          onPermission={onPermissionMode}
          onResume={(id) => {
            onResume(id);
            send({ kind: 'openEditor' });
          }}
          onReload={(id) => send({ kind: 'reloadSession', sessionId: id })}
          onRemote={(id) => send({ kind: 'remoteControl', sessionId: id })}
          onDelete={onAskDelete}
          onRename={(s, name) => send({ kind: 'renameSession', sessionId: s.id, name })}
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
        {showPlugins && (
          <PluginsModal
            t={t}
            data={plugins}
            busy={pluginsBusy}
            busyLabel={pluginsBusyLabel}
            error={pluginsError}
            onAction={(action, arg, scope) => send({ kind: 'pluginAction', action, arg, scope })}
            onRefresh={() => send({ kind: 'pluginsRefresh', force: true })}
            onOpenLink={(href) => send({ kind: 'openLink', href })}
            onClose={() => setShowPlugins(false)}
          />
        )}
      </>
    );
  }

  return (
    <ImageViewerContext.Provider value={setViewerSrc}>
    <div className="app">
      {showSearch && (
        <SearchBar
          t={t}
          scrollRef={scrollRef}
          itemsKey={items.length}
          onClose={() => setShowSearch(false)}
        />
      )}
      {!cliLoading && (cliMissing || tab?.authRequired) && (
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
        {cliLoading ? (
          <div className="cockpit-loader" role="status" aria-label="Cockpit">
            <div className="cockpit-loader-ring">
              <span className="cockpit-loader-name">Cockpit</span>
            </div>
          </div>
        ) : (
        <>
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
            onRewind={tab?.status === 'busy' ? undefined : (idx) => setConfirmRewind(idx)}
            verbosity={state.config?.verbosity}
          />
          {/* Link de exportação: SÓ no fim e quando ocioso. Some ao recomeçar um
              turno (busy) e reaparece no novo fim ao concluir. */}
          {tab?.status !== 'busy' && items.length > 0 && (
            <div className="timeline-export">
              {!exportMenu ? (
                <button type="button" className="timeline-export-link" onClick={() => setExportMenu(true)}>
                  {t('export.link')}
                </button>
              ) : (
                <div className="export-menu">
                  <button
                    type="button"
                    className="timeline-export-link"
                    onClick={() => {
                      onExportMd('direct');
                      setExportMenu(false);
                    }}
                  >
                    {t('export.direct')}
                  </button>
                  <button
                    type="button"
                    className="timeline-export-link ai"
                    onClick={() => {
                      onExportMd('ai');
                      setExportMenu(false);
                    }}
                  >
                    {t('export.ai')}
                  </button>
                  <div className="export-note">
                    {t(
                      'export.ai.note',
                      tab?.stats?.model || state.config?.model || 'default',
                      state.config?.effort || 'default',
                    )}
                  </div>
                  <button type="button" className="export-cancel" onClick={() => setExportMenu(false)}>
                    {t('confirm.cancel')}
                  </button>
                </div>
              )}
            </div>
          )}
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
        </>
        )}
      </div>

      <Composer
        t={t}
        locale={state.locale}
        correctEnabled={state.config?.voiceCorrect !== false}
        busy={tab?.status === 'busy'}
        disabled={cliMissing}
        slashCommands={tab?.slashCommands ?? []}
        slashMeta={state.slashMeta}
        slashBusy={state.slashResearching}
        allExpanded={allExpanded ?? false}
        injectDraft={draftRestore}
        onDraftInjected={() => setDraftRestore(null)}
        onToggleExpandAll={() => setAllExpanded((a) => !(a ?? false))}
        onSend={onSend}
        selectionRef={state.selectionRef}
        onStop={onStop}
        onVoiceDict={onVoiceDict}
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

      {confirmRewind !== null && (
        <ConfirmDialog
          danger
          title={t('confirm.rewind.title')}
          body={t('confirm.rewind.body')}
          confirmLabel={t('confirm.rewind.action')}
          cancelLabel={t('confirm.cancel')}
          onConfirm={() => {
            send({ kind: 'rewind', index: confirmRewind });
            setConfirmRewind(null);
          }}
          onCancel={() => setConfirmRewind(null)}
        />
      )}

      {confirmEffort && (
        <ConfirmDialog
          danger
          title={t('confirm.effort.title')}
          body={t('confirm.effort.body', confirmEffort.selected, confirmEffort.min)}
          confirmLabel={t('confirm.effort.action')}
          cancelLabel={t('confirm.cancel')}
          onConfirm={() => {
            const p = lastSendRef.current;
            if (p) {
              send({
                kind: 'sendMessage',
                text: p.text,
                images: p.images.length ? p.images : undefined,
                force: true,
              });
            }
            setConfirmEffort(null);
          }}
          onCancel={() => {
            dispatch({ type: 'removeLastUser' }); // desfaz a bolha otimista (não vai rodar)
            if (lastSendRef.current) setDraftRestore(lastSendRef.current); // devolve o texto ao input
            setConfirmEffort(null);
          }}
        />
      )}
      {/* Dicionário (ditado + corretor): aberto pelo botão do composer (chat). */}
      {showVoiceDict && (
        <VoiceDictModal
          t={t}
          data={voiceDict}
          onSave={(d) => {
            send({ kind: 'voiceDictSave', data: d });
            resetSpell(); // dicionário do corretor mudou → re-checa o overlay
          }}
          onClose={() => setShowVoiceDict(false)}
        />
      )}
    </div>
      {viewerSrc && <ImageViewer t={t} src={viewerSrc} onClose={() => setViewerSrc(null)} />}
    </ImageViewerContext.Provider>
  );
}
