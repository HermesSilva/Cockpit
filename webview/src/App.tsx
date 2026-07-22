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
  McpData,
  PluginsData,
  SessionInfo,
  UsageData,
  VoiceDictData,
  CredentialMeta,
} from '../../shared/protocol';
import { send } from './vscodeApi';
import { createTranslator } from './i18n';
import { CliMissing } from './components/CliMissing';
import { Timeline, seedTaskTimings } from './components/Timeline';
import { Composer } from './components/Composer';
import { HubView } from './components/HubView';
import { UsageModal } from './components/UsageModal';
import { PluginsModal } from './components/PluginsModal';
import { McpModal } from './components/McpModal';
import { SkillsModal } from './components/SkillsModal';
import { VoiceDictModal } from './components/VoiceDictModal';
import { CredentialsModal } from './components/CredentialsModal';
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
  // Effort gate: the host blocks and sends 'effortGate'; we keep the last send
  // so it can be re-sent with force=true if the user confirms.
  const [confirmEffort, setConfirmEffort] = useState<{ selected: string; min: string } | null>(null);
  const lastSendRef = useRef<{ text: string; images: ImageAttachment[] } | null>(null);
  const [draftRestore, setDraftRestore] = useState<{ text: string; images: ImageAttachment[] } | null>(null);
  const [showUsage, setShowUsage] = useState(false);
  const [usage, setUsage] = useState<UsageData | null>(null);
  const [showPlugins, setShowPlugins] = useState(false);
  const [plugins, setPlugins] = useState<PluginsData | null>(null);
  const [showMcp, setShowMcp] = useState(false);
  const [mcp, setMcp] = useState<McpData | null>(null);
  const [mcpBusy, setMcpBusy] = useState(false);
  const [showSkills, setShowSkills] = useState(false);
  const [skillsBusy, setSkillsBusy] = useState(false);
  const [showVoiceDict, setShowVoiceDict] = useState(false);
  const [voiceDict, setVoiceDict] = useState<VoiceDictData | null>(null);
  // Credential vault (TOTP 2FA).
  const [showCreds, setShowCreds] = useState(false);
  const [credsData, setCredsData] = useState<{ enrolled: boolean; items: CredentialMeta[] } | null>(null);
  const [credsSetup, setCredsSetup] = useState<{ qrSvg: string; secret: string; uri: string } | null>(null);
  const [credsResult, setCredsResult] = useState<{ ok: boolean; action: string; message?: string } | null>(null);
  const [credsError, setCredsError] = useState<string | undefined>(undefined);
  // Text (credential value) to inject into the composer. Its ref changes to trigger it.
  const [injectText, setInjectText] = useState<{ text: string } | null>(null);
  const [exportMenu, setExportMenu] = useState(false); // export link expanded (direct/AI)
  const [pluginsBusy, setPluginsBusy] = useState(false);
  const [pluginsBusyLabel, setPluginsBusyLabel] = useState<string | undefined>(undefined);
  const [pluginsError, setPluginsError] = useState<string | undefined>(undefined);
  // null = follows the settings; boolean = override from the "expand/collapse all" button.
  const [allExpanded, setAllExpanded] = useState<boolean | null>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [showSearch, setShowSearch] = useState(false);
  const [viewerSrc, setViewerSrc] = useState<string | null>(null);
  const atBottomRef = useRef(true); // live state for the auto-scroll (no stale closure)
  const t = useMemo(() => createTranslator(state.locale), [state.locale]);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Chat: renders the injected session (one webview per context). Hub: the active one.
  const tab =
    view === 'hub' ? activeTab(state) : state.tabs.find((tb) => tb.id === sessionId) ?? activeTab(state);
  const items = tab?.items ?? [];

  // Ctrl+F: opens the search bar (chat only, not the hub).
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
      if (data?.kind === 'taskTimings') seedTaskTimings(data.timings); // host averages for the gauge
      if (data?.kind === 'usageData') setUsage(data.data); // answer to the Usage button (hot data)
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
      if (data?.kind === 'mcpData') setMcp(data.data);
      if (data?.kind === 'mcpBusy') setMcpBusy(data.busy);
      if (data?.kind === 'skillsBusy') setSkillsBusy(data.busy);
      if (data?.kind === 'credsData') {
        setCredsData({ enrolled: data.enrolled, items: data.items });
        setCredsSetup(null); // fresh data: ends any enrollment in progress
        setCredsResult(null);
      }
      if (data?.kind === 'credsSetup') setCredsSetup({ qrSvg: data.qrSvg, secret: data.secret, uri: data.uri });
      if (data?.kind === 'credsResult') setCredsResult({ ok: data.ok, action: data.action, message: data.message });
      if (data?.kind === 'credsError') setCredsError(data.message);
      if (data?.kind === 'credsValue') {
        // Value released by the vault. In the Hub there is no composer → it copies to the
        // clipboard; in the Chat it injects into the composer. It closes the modal in both cases.
        if (view === 'hub') {
          void navigator.clipboard?.writeText(data.value);
        } else {
          setInjectText({ text: data.value });
        }
        setShowCreds(false);
      }
      dispatch({ type: 'host', msg: data });
    };
    window.addEventListener('message', onMsg);
    send({ kind: 'init' });
    if (view === 'hub') send({ kind: 'listSessions' });
    return () => window.removeEventListener('message', onMsg);
  }, [view]);

  // Render heartbeat: it proves to the host that the webview process is alive.
  // When the renderer dies (VSCode GPU bug → blank screen), the beats stop and the host
  // forces an HTML reload (React remounts → transcript replay). Outside React's cycle
  // on purpose: a heavy timeline render delays the tick, but it fires
  // as soon as the stack clears — only a truly dead renderer stops beating.
  useEffect(() => {
    send({ kind: 'heartbeat' });
    const id = setInterval(() => send({ kind: 'heartbeat' }), 10_000);
    return () => clearInterval(id);
  }, []);

  // New content: it only pins to the bottom when the user WAS already at the bottom (respects manual scroll).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  // Tab switch: goes to the bottom and resets the "at bottom" state.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
  }, [state.activeTab]);

  // Optimistic send (local bubble + send to the host). The effort gate is decided IN THE
  // HOST (it reads the folder's CLAUDE.md): when it blocks, it sends 'effortGate' and doesn't run;
  // on confirmation, we re-send the last one with force=true.
  const onSend = (text: string, images: ImageAttachment[], selection?: string) => {
    lastSendRef.current = { text, images };
    const previews = images.map((i) => `data:${i.mediaType};base64,${i.data}`);
    dispatch({ type: 'localUser', text, images: previews.length ? previews : undefined });
    dispatch({ type: 'clearError' }); // new send: clears the previous error/abort warning
    send({ kind: 'sendMessage', text, images: images.length ? images : undefined, selection });
  };
  const onStop = () => {
    send({ kind: 'interrupt' });
    dispatch({ type: 'interruptUi' });
  };
  const onSettings = () => send({ kind: 'openSettings' });
  const onUsage = () => {
    setUsage(null); // cleared to show loading; always fetches fresh (hot data)
    setShowUsage(true);
    send({ kind: 'fetchUsage' });
  };
  const onManageUsage = () => send({ kind: 'openLink', href: 'https://claude.ai/settings/usage' });
  const onPlugins = () => {
    setShowPlugins(true);
    send({ kind: 'pluginsRefresh' }); // loads on open
  };
  const onMcp = () => {
    setMcp(null); // hot state: re-checks the servers' health on every open
    setShowMcp(true);
    send({ kind: 'mcpRefresh' });
  };
  const onSkills = () => {
    setShowSkills(true);
    send({ kind: 'skillsRefresh' }); // relê o get_context_usage ao abrir
  };
  const onVoiceDict = () => {
    setVoiceDict(null); // shows loading until the host answers
    setShowVoiceDict(true);
    send({ kind: 'voiceDictGet' });
  };
  const onCredentials = () => {
    setCredsData(null); // loading until the host answers
    setCredsSetup(null);
    setCredsResult(null);
    setCredsError(undefined);
    setShowCreds(true);
    send({ kind: 'credsLoad' });
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
    setUsage(null); // shows loading; the host installs the wrapper and re-sends usageData
    send({ kind: 'enableUsageTracking' });
  };

  // Click on a file link (a.md-link) -> opens it in the editor via the host.
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
  const onAllowAgents = (value: boolean) => send({ kind: 'setAllowAgents', value });
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
  // Loading: the host hasn't reported the CLI status yet, OR the tab hasn't
  // received the history yet (reopening a context). Avoids the flash of the banner and the empty
  // timeline — it shows the Cockpit loader. The banner only after the CLI status.
  const cliLoading = !state.cli.checked || (!!tab?.sessionId && !tab.historyLoaded);

  // Vault modal — shared between Hub and Chat. In the Hub there is no composer, so
  // "use" copies the value to the clipboard; in the Chat it injects into the composer (the
  // host sends 'credsValue' and the handler in onMsg decides by `view`).
  const credsModalEl = showCreds && (
    <CredentialsModal
      t={t}
      data={credsData}
      setup={credsSetup}
      error={credsError}
      result={credsResult}
      onEnrollBegin={() => send({ kind: 'credsEnrollBegin' })}
      onEnrollConfirm={(code) => send({ kind: 'credsEnrollConfirm', code })}
      onAdd={(d) =>
        send({
          kind: 'credsAdd',
          code: d.code,
          name: d.name,
          username: d.username,
          value: d.value ?? '',
          note: d.note,
        })
      }
      onEdit={(id, d) =>
        send({
          kind: 'credsEdit',
          code: d.code,
          id,
          name: d.name,
          username: d.username,
          value: d.value,
          note: d.note,
        })
      }
      onUse={(id, code) => send({ kind: 'credsUse', code, id })}
      onDelete={(id, code) => send({ kind: 'credsDelete', code, id })}
      onClose={() => setShowCreds(false)}
      useLabel={view === 'hub' ? t('creds.copy') : t('creds.use')}
    />
  );

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
          busy={tab?.status === 'busy' || tab?.bgBusy === true}
          config={state.config}
          activeModel={tab?.stats?.model ?? tab?.session?.model}
          loggedIn={state.loggedIn}
          sessions={state.sessions}
          cwd={state.sessionsCwd}
          activeSessionId={tab?.sessionId ?? tab?.session?.sessionId}
          busySessions={
            new Set(
              state.tabs
                .filter((tb) => (tb.status === 'busy' || tb.bgBusy === true) && tb.sessionId)
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
          onMcp={onMcp}
          onSkills={onSkills}
          onCredentials={onCredentials}
          onLogin={() => send({ kind: 'loginCli' })}
          onLogout={() => send({ kind: 'logoutCli' })}
          onUpdate={() => send({ kind: 'updateCli' })}
          onInstall={() => send({ kind: 'installCli' })}
          onOpenLink={(href) => send({ kind: 'openLink', href })}
          onModel={onModel}
          onEffort={onEffort}
          onPermission={onPermissionMode}
          onAllowAgents={onAllowAgents}
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
        {showMcp && (
          <McpModal
            t={t}
            data={mcp}
            busy={mcpBusy}
            onRefresh={() => send({ kind: 'mcpRefresh' })}
            onClose={() => setShowMcp(false)}
          />
        )}
        {showSkills && (
          <SkillsModal
            t={t}
            skills={tab?.stats?.skills}
            listingTokens={tab?.stats?.skillsListingTokens}
            total={tab?.stats?.skillsTotal}
            listed={tab?.stats?.skillsListed}
            hooks={tab?.stats?.hookInjections}
            busy={skillsBusy}
            onRefresh={() => send({ kind: 'skillsRefresh' })}
            onOverride={(name, value) => send({ kind: 'skillOverrideSet', name, value })}
            onClose={() => setShowSkills(false)}
          />
        )}
        {credsModalEl}
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
            busy={tab?.status === 'busy' || tab?.bgBusy === true}
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

      {state.error && (
        <div className="turn-error" role="alert">
          <span className="turn-error-text">{state.error}</span>
          <button
            type="button"
            className="turn-error-x"
            title={t('common.close')}
            onClick={() => dispatch({ type: 'clearError' })}
          >
            ✕
          </button>
        </div>
      )}

      {tab?.bgTasks && tab.bgTasks.length > 0 && (
        <div className="bg-tasks" role="status" aria-label={t('background.title')}>
          <div className="bg-tasks-head">
            <span className="voice-spinner bg-tasks-spinner" aria-hidden="true" />
            <span className="bg-tasks-title">
              {t('background.title')} ({tab.bgTasks.length})
            </span>
          </div>
          <ul className="bg-tasks-list">
            {tab.bgTasks.map((task) => (
              <li key={task.id} className="bg-task" title={task.label}>
                <span className="bg-task-tool">{task.tool}</span>
                <span className="bg-task-label">{task.label}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <Composer
        t={t}
        locale={state.locale}
        correctEnabled={state.config?.voiceCorrect === true}
        spellCheck={state.config?.spellCheck === true}
        busy={tab?.status === 'busy'}
        disabled={cliMissing}
        slashCommands={tab?.slashCommands ?? []}
        slashMeta={state.slashMeta}
        slashBusy={state.slashResearching}
        allExpanded={allExpanded ?? false}
        injectDraft={draftRestore}
        onDraftInjected={() => setDraftRestore(null)}
        injectText={injectText}
        onTextInjected={() => setInjectText(null)}
        onToggleExpandAll={() => setAllExpanded((a) => !(a ?? false))}
        onSend={onSend}
        selectionRef={state.selectionRef}
        onStop={onStop}
        onVoiceDict={onVoiceDict}
        onCredentials={onCredentials}
      />

      {credsModalEl}

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
            dispatch({ type: 'removeLastUser' }); // undoes the optimistic bubble (it won't run)
            if (lastSendRef.current) setDraftRestore(lastSendRef.current); // gives the text back to the input
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
            resetSpell(); // the spell-checker dictionary changed → re-check the overlay
          }}
          onClose={() => setShowVoiceDict(false)}
        />
      )}
    </div>
      {viewerSrc && <ImageViewer t={t} src={viewerSrc} onClose={() => setViewerSrc(null)} />}
    </ImageViewerContext.Provider>
  );
}
