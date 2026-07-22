// Webview provider: the bridge between the CLI (engine) and the React UI.
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { CliProcessManager } from '../cli/CliProcessManager';
import { CacheKeeper } from '../cli/CacheKeeper';
import { discoverModels, resolveCreds } from '../cli/ModelDiscovery';
import { ensurePricing, type PricingMap } from '../cli/ModelPricing';
import {
  listSessions,
  loadTranscript,
  deleteSession,
  deleteAllSessions,
  truncateTranscriptAt,
  latestSessionId,
} from '../session/SessionStore';
import { resolveMinEffort, EFFORT_RANK } from '../session/RepoDirectives';
import { VoiceSession } from '../cli/VoiceStream';
import { workspaceTerms } from '../cli/WorkspaceTerms';
import { AudioCapture } from '../cli/AudioCapture';
import { Speller } from '../spell/Speller';
import { correctText } from '../cli/TextCorrector';
import {
  loadDictionary,
  saveDictionary,
  buildKeyterms,
  applyReplacements,
  correctorHints,
  resolveAccountKey,
  resetAccountKey,
  type VoiceDict,
} from '../cli/VoiceDictionary';
import { setInternalModel } from '../cli/AiClient';
import { listPlugins, pluginAction } from '../cli/PluginManager';
import { fetchMcpList, mergeMcpStatus } from '../cli/McpStatus';
import { readClipboardFiles } from '../cli/ClipboardFiles';
import { readClaudeDefaults } from '../cli/ClaudeSettings';
import { computeLocalUsage } from '../session/UsageAggregator';
import { computeDailyTokens } from '../stats/DailyTokens';
import { registerModelContext } from '../stats/StatsAggregator';
import { readUsageCache } from '../cli/StatuslineCache';
import { taskTimingsScoped, recordTaskTiming } from '../stats/TaskTimings';
import { fetchAuthStatus } from '../cli/AuthStatus';
import { isEnabled as usageTrackingEnabled, enableUsageTracking } from '../cli/StatuslineInstaller';
import { fetchAccountUsage } from '../cli/UsageApi';
import { OtelReceiver } from '../cli/OtelReceiver';
import { CredentialsStore } from '../secrets/CredentialsStore';
import type { LimitWindow, HostToWebview, WebviewToHost, TabInfo, UsageBucket, ScopedBucket, VoiceReplacement, ModelMeta } from '../../shared/protocol';
import { Session, type SessionHooks } from '../session/Session';
import { resolveLocale } from '../i18n/host';
import { researchCommands } from '../cli/SlashCommandResearch';
import { getLatestCliVersion } from '../cli/CliVersion';
import { log, dlog } from '../util/logger';

// Always-valid aliases (they resolve to the account's most recent). 'default' = no flag.
// The CLI doesn't expose a model list; the UI complements it with the active model discovered
// live (init event) and with free input ("Custom…"). Effort is a fixed CLI enum.
// Flat list (no grouping). Models with a 1M variant appear only as [1m]
// (the smaller 200K version is omitted). The CLI validates it at spawn.
const MODEL_LIST = [
  'default',
  'claude-opus-4-8[1m]',
  // Sonnet 5: the CLI default since 2.1.197. Its 1M window is NATIVE — it has no
  // `[1m]` variant (hence it stays out of BASE_OF_1M).
  'claude-sonnet-5',
  'claude-opus-4-7[1m]',
  'claude-opus-4-6',
  'claude-sonnet-4-6[1m]',
  'claude-haiku-4-5',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-fable-5',
];
// 200K versions that have a 1M variant in the list — filtered out of discovery.
const BASE_OF_1M = new Set(['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6']);
const EFFORT_OPTIONS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'];
// A statusline cache older than this isn't trustworthy as the "real" % (it misleads).
const USAGE_CACHE_MAX_AGE_MS = 6 * 3600_000; // 6h

// Per-session preferences persisted in globalState (tab override).
interface SessionPrefs {
  model?: string;
  effort?: string;
  allowAgents?: boolean;
}

// --- Render watchdog ---
// DESATIVADO (2026-06-29): suspeito de causar tempestade de recreate de painel
// (dispose+create native webview + replayTab of a huge timeline in a burst) that
// preceded a native extension-host crash (0xC0000005). Kept in the code for
// evaluation — re-enable by flipping this flag to true. The manual reload button
// (reloadActivePanel) segue funcionando independente disto.
const WATCHDOG_ENABLED = false;
const HEARTBEAT_DEAD_MS = 30_000; // no beat for this long = render presumed dead
const WATCHDOG_TICK_MS = 10_000; // how often the visible surfaces are checked
const RELOAD_COOLDOWN_MS = 60_000; // doesn't reload the same surface before this
const RELOAD_MAX_TRIES = 2; // attempts before giving up (avoids a reload loop)
const HUB_SURFACE = '__hub__'; // key of the hub surface in the beat map
const API_KEY_SECRET = 'cockpit.apiKey'; // chave da API key no SecretStorage (keychain do SO)

export class ChatViewProvider implements vscode.WebviewViewProvider {
  // The Cockpit lives as an editor tab (WebviewPanel) + a hub in the Activity Bar
  // (WebviewView). `surfaces` guarda os webviews ativos (broadcast) — o estado
  // lives in the host and is replicated to every surface.
  // Each context (session) opens as its own WebviewPanel in the editor.
  private panels = new Map<string, vscode.WebviewPanel>();
  private webviewSession = new Map<vscode.Webview, string>();
  private hubView?: vscode.WebviewView;

  // Render watchdog: the webview process (renderer) can die (VSCode GPU
  // bug) — the screen goes blank but the host stays alive (stream/stats/timeline
  // keep going). Every surface sends a periodic beat; when a VISIBLE one stops
  // beating past the limit, the HTML is force-reloaded. It NEVER touches the CLI/context.
  private lastBeat = new Map<string, number>(); // surfaceKey -> epoch ms of the last beat
  private reloadGuard = new Map<string, { at: number; count: number }>(); // cooldown/cap per surface
  private justRecreated = new Set<string>(); // tabIds recreated by the watchdog: forced replay on init
  private watchdog?: ReturnType<typeof setInterval>;
  private watchdogDisabledLogged = false; // logs only once that the watchdog is off
  private windowStateSub?: vscode.Disposable; // window focus (re-arms the beat on return)

  // Tabs: each one is a Session (CLI runtime + stats + streaming) in parallel.
  private sessions = new Map<string, Session>();
  // Cache keep-alive: renews the ticked contexts in the background (even closed ones).
  private cacheKeeper = new CacheKeeper({
    claudePath: () => this.claudePath(),
    pingOpen: (id) => this.pingOpenSession(id),
  });
  private tabMeta = new Map<string, { title: string; status: 'idle' | 'busy' | 'error' }>();
  // Draft/dictation mirrored per tab (loss prevention): it lives in the HOST, which survives
  // the renderer's death (blank screen). Re-injected into the webview on (re)mount.
  private draftByTab = new Map<string, string>();
  private tabOrder: string[] = [];
  private activeTab = '';
  // Last session whose panel the user closed (for "reopen closed").
  private lastClosed?: { tabId: string; sessionId?: string };
  // Ref of the editor's active selection (@file#a-b) to share via the composer.
  private lastSelRef?: string;
  private selListener?: vscode.Disposable;
  private tabSeq = 0;

  // Session overrides (in memory — they don't change the user's global settings).
  private modelOverride?: string;
  private effortOverride?: string;
  private permissionOverride?: string;
  // Baseline of the active tab's dropdowns before the user touched them. If, after
  // touching them, they create a NEW context (instead of sending a prompt), the choice was
  // for the new context: the new one is born with the chosen values and the previous tab
  // returns to this baseline. Sending a prompt confirms the choice in the current tab and
  // clears the baseline (the usual behavior). Key = the tab that was being edited.
  private comboBaseline?: {
    tab: string;
    model?: string;
    effort?: string;
    permission?: string;
    allowAgents?: boolean;
  };
  private statusBar?: vscode.StatusBarItem;
  // Reload button in the status bar: always visible while a Cockpit panel is
  // open. It recovers the gray/dead webview (same action as the watchdog) — it runs in the
  // host, so it is independent of the renderer and of the editor action settings.
  private reloadBar?: vscode.StatusBarItem;
  // Models discovered live (the init's active model + /v1/models). Value =
  // real context window (max_input_tokens) or undefined when the account doesn't expose it.
  private discoveredModels = new Map<string, number | undefined>();
  private discoveryTried = false;
  // Price per model (from the pricing docs; cached once a day). Empty until loaded.
  private pricing: PricingMap = {};
  private pricingTried = false;

  // Defaults do Claude Code (effort do settings; model do settings ou init cacheado).
  private defaults: { model?: string; effort?: string } = {};
  private observedDefaultModel?: string;
  // model/effort/permission changed and the session hasn't restarted yet (warns in the UI).
  private pendingRestart = false;
  // Active voice dictation session (one at a time; there is only one mic).
  private voice?: VoiceSession;
  private voiceCapture?: AudioCapture;
  private voiceDict: VoiceDict = { terms: [], replacements: [] }; // active dictation dictionary

  // Spell-checker (hunspell-asm in the host). Lazy: instantiated on first use.
  private speller?: Speller;

  // TOTP-protected credential vault (SecretStorage). Absent when the host doesn't
  // forneceu o SecretStorage (ex.: testes).
  private creds?: CredentialsStore;

  // SecretStorage do host (keychain do SO). Guarda a API key de descoberta de
  // models encrypted — never in plain text in the settings. Absent in tests.
  private readonly secrets?: vscode.SecretStorage;

  // The extension's own globalStorage directory.
  private readonly globalStorageDir?: string;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memory: vscode.Memento,
    statusBar?: vscode.StatusBarItem,
    secrets?: vscode.SecretStorage,
    globalStorageUri?: vscode.Uri,
  ) {
    this.globalStorageDir = globalStorageUri?.fsPath;
    this.secrets = secrets;
    if (secrets) this.creds = new CredentialsStore(secrets);
    this.defaults = readClaudeDefaults();
    this.observedDefaultModel = this.memory.get<string>('defaultModel');
    this.statusBar = statusBar;
    this.updateStatusBar(false);
    // Reload button (status bar, right). Hidden until a context is opened.
    this.reloadBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.reloadBar.text = '$(refresh)';
    this.reloadBar.tooltip = vscode.l10n.t('Reload Cockpit view (fix gray/blank panel)');
    this.reloadBar.command = 'tootega.reloadView';
    this.updateReloadBar();
    setInternalModel(this.cfg().get<string>('internalModel', '')); // model of the internal calls
    void resolveAccountKey(this.claudePath()); // resolves the account early (dictation dictionary key)
    // Editor's active selection → shareable @file#a-b ref in the composer.
    this.selListener = vscode.window.onDidChangeTextEditorSelection((e) => this.onSelectionChanged(e));
    // Automatic keep-alive ping is OFF: any refresh via --resume writes
    // a real turn into the .jsonl (pollutes the conversation, spends tokens and reaches the agent).
    // O medidor de vida do cache no painel continua (independe do keeper).
    void this.cacheKeeper; // kept for a future clean reimplementation (without polluting the transcript)
    // OTEL telemetry (opt-in, default OFF): starts the local receiver that collects LOC/
    // sessions/commits from the CLI. When enabled, it injects the export env before the first spawn.
    if (this.cfg().get<boolean>('otel.enabled', false)) {
      try {
        this.otel.start();
      } catch (e) {
        log(`[otel] start falhou: ${String(e)}`);
      }
    }
  }

  // Local OTLP receiver (opt-in). Always instantiated; it only listens when enabled.
  private readonly otel = new OtelReceiver();

  /** Shuts down background resources (called in the extension's deactivate). */
  dispose(): void {
    this.cacheKeeper.stop();
    this.otel.stop();
    if (this.watchdog) clearInterval(this.watchdog);
    this.windowStateSub?.dispose();
    this.reloadBar?.dispose();
    this.selListener?.dispose();
    this.diffProviderReg?.dispose();
  }

  /** Updates the selection ref (@rel#a-b) and notifies the composer. Empty = no selection. */
  private onSelectionChanged(e: vscode.TextEditorSelectionChangeEvent): void {
    const ed = e.textEditor;
    const sel = ed.selection;
    let ref: string | undefined;
    if (ed.document.uri.scheme === 'file' && !sel.isEmpty) {
      const rel = vscode.workspace.asRelativePath(ed.document.uri, false);
      ref = `@${rel}#${sel.start.line + 1}-${sel.end.line + 1}`;
    }
    if (ref === this.lastSelRef) return;
    this.lastSelRef = ref;
    this.post({ kind: 'selection', ref });
  }

  /** Shows the reload button while at least one Cockpit panel is open. */
  private updateReloadBar(): void {
    if (!this.reloadBar) return;
    if (this.panels.size > 0) this.reloadBar.show();
    else this.reloadBar.hide();
  }

  /**
   * Keep-alive of a context that is OPEN in a tab: it pings through the session's live
   * CLI (no parallel --resume, which would conflict). 'busy' = a turn in progress already
   * keeps it warm; 'pinged' = ping sent; 'none' = there is no open session (the
   * keeper then uses the ephemeral spawn for a closed context).
   */
  private pingOpenSession(sessionId: string): 'busy' | 'pinged' | 'none' {
    for (const s of this.sessions.values()) {
      if (s.sessionId === sessionId || s.resumeId === sessionId) {
        if (s.busy) return 'busy';
        return s.keepAlivePing() ? 'pinged' : 'busy';
      }
    }
    return 'none';
  }

  // ---- Tabs / parallel sessions ----

  /** The active tab's session (creates the first tab when there is none yet). */
  private active(): Session {
    if (!this.activeTab || !this.sessions.has(this.activeTab)) this.createTab();
    return this.sessions.get(this.activeTab)!;
  }

  private hooksFor(tabId: string): SessionHooks {
    return {
      emit: (msg) => this.post(msg, tabId),
      onBusy: (busy) => this.setTabStatus(tabId, busy ? 'busy' : 'idle'),
      onResult: () => {
        this.notifyComplete();
        void this.refreshUsage(); // fetches fresh usage at the end of each interaction (no persisted cache)
        this.sendSessions(); // the new/updated session is already on disk — reflected in the context list
      },
      onInteraction: () => {
        // Ensures the context is visible (creates/focuses its panel) for the permission/question.
        this.openSessionPanel(tabId);
      },
      onInit: (model, cmds) => this.onSessionInit(model, cmds, tabId),
      onAuthRequired: () => this.post({ kind: 'authRequired' }, tabId),
      onTurnError: (info) => {
        const message =
          info.kind === 'aborted'
            ? vscode.l10n.t(
                'Claude process exited unexpectedly (code {0}) before finishing the turn. Send again to continue.',
                String(info.code ?? '?'),
              )
            : info.kind === 'transient'
              ? vscode.l10n.t('Connection was unstable — the turn may be incomplete. Send again if needed.{0}', info.text ? ` (${info.text})` : '')
              : vscode.l10n.t('The turn ended with an error.{0}', info.text ? ` ${info.text}` : '');
        this.post({ kind: 'error', message }, tabId);
        this.updateStatusBar(this.anyBusy());
      },
      fileText: (tool, input) => this.currentFileText(tool, input),
      onToolUse: (tool, input) => this.autoSaveForTool(tool, input),
      claudePath: () => this.claudePath(),
      cwd: () => this.workspaceCwd(),
      settings: () => ({
        model: this.cfg().get<string>('model', '') || 'default',
        effort: this.cfg().get<string>('effort', 'default') || 'default',
        permission: this.cfg().get<string>('permissionMode', 'default') || 'default',
        allowAgents: this.cfg().get<boolean>('allowAgents', false),
      }),
      askLanguage: () => this.askLanguageCode(),
    };
  }

  /** Creates a new tab and its Session; returns the id. It becomes the active tab. */
  private createTab(): string {
    const id = `t${++this.tabSeq}`;
    const s = new Session(this.hooksFor(id));
    if (this.lastLimits) s.applyLimits(this.lastLimits, this.lastLimitsSource);
    this.sessions.set(id, s);
    this.tabMeta.set(id, { title: '', status: 'idle' });
    this.tabOrder.push(id);
    this.activeTab = id;
    return id;
  }

  private setActive(tabId: string): void {
    if (!this.sessions.has(tabId)) return;
    this.activeTab = tabId;
    this.postTabs();
    // Combos (model/effort/permission) e stats refletem a aba ativa.
    this.sendConfig();
    this.post({ kind: 'stats', stats: this.sessions.get(tabId)!.snapshot() }, tabId);
    this.sessions.get(tabId)!.sendTimeline(); // timeline/compactions of the active tab
    this.replayTab(tabId); // guarantees the history on every surface
  }

  // Captures the baseline of `tab`'s dropdowns (once per edit). Called before
  // applying any dropdown change, so it can be reverted if the user chooses to
  // levar a escolha a um novo contexto.
  private snapComboBaseline(tab: string): void {
    const s = this.sessions.get(tab);
    if (!s || this.comboBaseline?.tab === tab) return;
    this.comboBaseline = {
      tab,
      model: s.modelOverride,
      effort: s.effortOverride,
      permission: s.permissionOverride,
      allowAgents: s.allowAgentsOverride,
    };
  }

  /** Cria um contexto novo (conversa vazia) e abre seu painel. */
  private openNewTab(): void {
    // The new context inherits the values currently chosen in the active tab's dropdowns.
    const prevTab = this.activeTab;
    const prev = this.sessions.get(prevTab);
    const inherited = prev
      ? {
          model: prev.modelOverride,
          effort: prev.effortOverride,
          permission: prev.permissionOverride,
          allowAgents: prev.allowAgentsOverride,
        }
      : undefined;
    // If the dropdowns were edited over the active tab, the choice was for the new
    // context: the previous tab is reverted to the baseline (it isn't mutated unduly).
    if (prev && this.comboBaseline?.tab === prevTab) {
      prev.modelOverride = this.comboBaseline.model;
      prev.effortOverride = this.comboBaseline.effort;
      prev.permissionOverride = this.comboBaseline.permission;
      prev.allowAgentsOverride = this.comboBaseline.allowAgents;
      this.saveSessionModel(prev);
      this.pendingRestart = false; // the previous tab is back to the original: no pending restart
    }
    this.comboBaseline = undefined;

    const id = this.createTab();
    if (inherited) {
      const s = this.sessions.get(id)!;
      s.modelOverride = inherited.model;
      s.effortOverride = inherited.effort;
      s.permissionOverride = inherited.permission;
      s.allowAgentsOverride = inherited.allowAgents;
      this.saveSessionModel(s);
    }
    this.openSessionPanel(id);
    this.post({ kind: 'history', items: [] }, id);
  }

  private closeTab(tabId: string): void {
    const s = this.sessions.get(tabId);
    if (!s) return;
    s.stop();
    const p = this.panels.get(tabId);
    if (p) {
      try {
        p.dispose();
      } catch {
        /* noop */
      }
    }
    this.sessions.delete(tabId);
    this.tabMeta.delete(tabId);
    this.tabOrder = this.tabOrder.filter((x) => x !== tabId);
    if (this.activeTab === tabId) this.activeTab = this.tabOrder[this.tabOrder.length - 1] ?? '';
    this.postTabs();
  }

  private setTabStatus(tabId: string, status: 'idle' | 'busy' | 'error'): void {
    const m = this.tabMeta.get(tabId);
    if (m && m.status !== status) {
      m.status = status;
      this.postTabs();
    }
    this.updateStatusBar(this.anyBusy());
  }

  private setTabTitle(tabId: string, title: string): void {
    const m = this.tabMeta.get(tabId);
    if (m) {
      m.title = title;
      const p = this.panels.get(tabId);
      if (p) p.title = title || 'Tootega Cockpit';
      this.postTabs();
    }
  }

  private anyBusy(): boolean {
    for (const s of this.sessions.values()) if (s.busy) return true;
    return false;
  }

  private postTabs(): void {
    const tabs: TabInfo[] = this.tabOrder.map((id) => {
      const s = this.sessions.get(id);
      return {
        id,
        title: this.tabMeta.get(id)?.title || '',
        status: this.tabMeta.get(id)?.status || 'idle',
        sessionId: s?.sessionId ?? s?.resumeId,
      };
    });
    this.post({ kind: 'tabs', tabs, activeTab: this.activeTab });
  }

  /** Global side of a session's init: model discovery + default cache. */
  private onSessionInit(model?: string, slashCommands?: string[], tabId?: string): void {
    void this.researchSlash(slashCommands);
    // REAL model resolved by the CLI: the timing scope may have changed
    // ('default' -> real id). Recalibrates the gauge with the new scope's averages.
    if (tabId) {
      this.postTaskTimings(tabId);
      // the sessionId now exists: persists the override (when there is one) of this new session.
      const s = this.sessions.get(tabId);
      if (s) this.saveSessionModel(s);
    }
    if (typeof model === 'string' && model) {
      if (!this.discoveredModels.has(model)) {
        this.discoveredModels.set(model, undefined); // context comes from /v1/models
        this.sendConfig();
      }
      const settingsModel = this.cfg().get<string>('model', '') || 'default';
      if (settingsModel === 'default' && !this.defaults.model && this.observedDefaultModel !== model) {
        this.observedDefaultModel = model;
        void this.memory.update('defaultModel', model);
        this.sendConfig();
      }
    }
    // A freshly started session already has a transcript on disk: refreshes the context grid.
    this.sendSessions();
  }

  private lastLimits?: { fiveHour?: LimitWindow; sevenDay?: LimitWindow };
  private lastLimitsSource: 'real' | 'estimate' = 'estimate';
  // Origem detalhada p/ o modal Usage (api > statusline > estimate).
  private lastUsageSource: 'api' | 'statusline' | 'estimate' = 'estimate';
  private lastScoped?: ScopedBucket[];
  private usageStarted = false;

  /** Starts (once) the periodic computation of local usage (5h/7d). */
  private startUsageTimer(): void {
    if (this.usageStarted) return;
    this.usageStarted = true;
    void this.refreshUsage();
    setInterval(() => void this.refreshUsage(), 120_000);
  }

  private async refreshUsage(force = false): Promise<void> {
    try {
      // 0) REAL account usage via the OAuth API (read-only, no token spend). It is the
      // mesma fonte do /usage do CLI — bate exatamente. Melhor fonte.
      const api = await fetchAccountUsage(force);
      if (api && (api.fiveHour || api.sevenDay)) {
        this.lastLimits = { fiveHour: api.fiveHour, sevenDay: api.sevenDay };
        this.lastScoped = api.weeklyScoped;
        this.lastLimitsSource = 'real';
        this.lastUsageSource = 'api';
      } else {
        // 1) Statusline cache (rate_limits). Only trusted when FRESH.
        const real = readUsageCache();
        const fresh = real != null && (real.ageMs == null || real.ageMs < USAGE_CACHE_MAX_AGE_MS);
        if (real && fresh && (real.fiveHour || real.sevenDay)) {
          this.lastLimits = { fiveHour: real.fiveHour, sevenDay: real.sevenDay };
          this.lastScoped = real.weeklyScoped;
          this.lastLimitsSource = 'real';
          this.lastUsageSource = 'statusline';
        } else {
          // 2) Fallback: local token usage (no %, only accumulated USD/tokens).
          const u = await computeLocalUsage(Date.now());
          this.lastLimits = {
            fiveHour: {
              usd: u.fiveHourUsd,
              tokens: u.fiveHourTokens,
              usedPct: undefined,
            },
            sevenDay: {
              usd: u.sevenDayUsd,
              tokens: u.sevenDayTokens,
              usedPct: undefined,
            },
          };
          this.lastScoped = undefined;
          this.lastLimitsSource = 'estimate';
          this.lastUsageSource = 'estimate';
        }
      }
      for (const [id, s] of this.sessions) {
        s.applyLimits(this.lastLimits, this.lastLimitsSource);
        this.post({ kind: 'stats', stats: s.snapshot() }, id);
      }
    } catch {
      /* ignora */
    }
  }

  private updateStatusBar(busy: boolean): void {
    if (!this.statusBar) return;
    this.statusBar.text = busy ? '$(loading~spin) Cockpit' : '$(sparkle) Cockpit';
    this.statusBar.tooltip = 'Tootega Cockpit';
    this.statusBar.command = 'tootega.open';
    this.statusBar.show();
  }

  /** Opens (or focuses) the active context as a WebviewPanel in the editor. */
  openInEditor(): void {
    const id = this.activeTab && this.sessions.has(this.activeTab) ? this.activeTab : this.createTab();
    this.openSessionPanel(id);
  }

  /** Opens (or focuses) a session's panel. Each context = one WebviewPanel. */
  private openSessionPanel(tabId: string): void {
    const existing = this.panels.get(tabId);
    if (existing) {
      try {
        existing.reveal();
        this.setActive(tabId);
        return;
      } catch {
        this.panels.delete(tabId);
        this.webviewSession.delete(existing.webview);
      }
    }
    const panel = vscode.window.createWebviewPanel(
      'tootega.cockpit.editor',
      this.tabMeta.get(tabId)?.title || 'Tootega Cockpit',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
      },
    );
    // Editor tabs don't mask the icon (raw render) -> colored version.
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon-color.svg');
    this.bindPanel(panel, tabId);
    this.setActive(tabId);
  }

  /** Binds a WebviewPanel to a specific session. */
  private bindPanel(panel: vscode.WebviewPanel, tabId: string): void {
    try {
      panel.webview.options = {
        enableScripts: true,
        localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
      };
      panel.webview.html = this.getHtml(panel.webview, 'chat', tabId);
    } catch {
      return;
    }
    this.panels.set(tabId, panel);
    this.webviewSession.set(panel.webview, tabId);
    this.updateReloadBar();
    const sub = panel.webview.onDidReceiveMessage((m: WebviewToHost) =>
      this.onWebviewMessage(m, panel.webview),
    );
    const vs = panel.onDidChangeViewState(() => {
      if (panel.active) this.setActive(tabId);
      // A dedicated context key for the refresh button in the title bar (more reliable than
      // activeWebviewPanelId for webview panels). True when THIS panel is active.
      void vscode.commands.executeCommand('setContext', 'tootega.cockpitActive', panel.active);
      // Shown again: timers were throttled while hidden — re-arms the clock so
      // the watchdog doesn't mistake the gap for a dead render.
      if (panel.visible) this.lastBeat.set(tabId, Date.now());
    });
    // A freshly created panel is born active: arm the context key right away.
    void vscode.commands.executeCommand('setContext', 'tootega.cockpitActive', true);
    this.lastBeat.set(tabId, Date.now()); // armed now: a freshly created panel hasn't beaten yet
    // Ref captured NOW: reading `panel.webview`/`panel.active` AFTER the dispose
    // throws "Webview is disposed" (assertNotDisposed getter) and aborts the rest of the
    // handler — vazando os listeners e os mapas de pulso. Captura evita o getter.
    const wv = panel.webview;
    panel.onDidDispose(() => {
      // A genuine close by the user (not a watchdog recreate): the map still
      // points to THIS panel. Stored for "reopen closed session".
      if (this.panels.get(tabId) === panel) {
        const s = this.sessions.get(tabId);
        this.lastClosed = { tabId, sessionId: s?.sessionId ?? s?.resumeId };
      }
      this.panels.delete(tabId);
      this.webviewSession.delete(wv);
      this.lastBeat.delete(tabId);
      this.reloadGuard.delete(tabId);
      this.updateReloadBar();
      // Doesn't read panel.active (the getter throws post-dispose): clears the context key directly.
      void vscode.commands.executeCommand('setContext', 'tootega.cockpitActive', false);
      sub.dispose();
      vs.dispose();
    });
  }

  /** Surface key for the watchdog: the panel's tabId, or HUB_SURFACE for the hub. */
  private surfaceKey(webview?: vscode.Webview): string | undefined {
    if (!webview) return undefined;
    const tab = this.webviewSession.get(webview);
    if (tab) return tab;
    if (webview === this.hubView?.webview) return HUB_SURFACE;
    return undefined;
  }

  /** Starts the periodic render checker (idempotent). */
  private startWatchdog(): void {
    if (!WATCHDOG_ENABLED) {
      if (!this.watchdogDisabledLogged) {
        this.watchdogDisabledLogged = true;
        log('Render watchdog DISABLED (usage evaluation) — no automatic webview reload');
      }
      return;
    }
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.checkSurfaces(), WATCHDOG_TICK_MS);
    // Window focus: Chromium FREEZES the renderer's timers when the VSCode window
    // goes to the background (background throttling) — the heartbeat stops even
    // with the panel "visible" and WITHOUT firing onDidChangeViewState. On regaining focus,
    // it re-arms the beat clock of every surface so the watchdog doesn't mistake
    // that gap for a dead render and close/reload the tab (and the Hub) unduly.
    this.windowStateSub ??= vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) this.rearmAllBeats();
    });
  }

  /** Re-arms the beat clock of every visible surface (now). */
  private rearmAllBeats(): void {
    const now = Date.now();
    for (const [tabId, panel] of this.panels) if (panel.visible) this.lastBeat.set(tabId, now);
    if (this.hubView?.visible) this.lastBeat.set(HUB_SURFACE, now);
    dlog('watchdog', 'janela reganhou foco — pulsos rearmados');
  }

  /** Sweeps VISIBLE surfaces; a hidden one is throttled/discarded, it doesn't count. */
  private checkSurfaces(): void {
    // Window in the background: the renderer's timers are frozen (this isn't a real
    // death). Nothing is reloaded — liveness is only evaluated with the window focused.
    if (!vscode.window.state.focused) {
      dlog('watchdog', 'tick skipped: window not focused');
      return;
    }
    const now = Date.now();
    for (const [tabId, panel] of this.panels) {
      if (panel.visible) this.maybeReload(tabId, panel.webview, now);
    }
    if (this.hubView?.visible) this.maybeReload(HUB_SURFACE, this.hubView.webview, now);
  }

  /**
   * Render presumed dead (beat stopped past the limit) → forces an HTML reload:
   * it remounts React, which re-sends 'init' and the host repaints via replayTab. The replay
   * cost (large timeline) is only paid HERE, in the recovery — never on the healthy path.
   * A cooldown + cap avoid a loop when the reload doesn't revive it (broken environment).
   */
  private maybeReload(key: string, webview: vscode.Webview, now: number): void {
    const beat = this.lastBeat.get(key);
    if (beat === undefined) {
      this.lastBeat.set(key, now); // first observation: arms the clock, doesn't act
      return;
    }
    const gap = now - beat;
    dlog('watchdog', `${key}: ${gap}ms since the last beat (limit ${HEARTBEAT_DEAD_MS}ms)`);
    if (gap < HEARTBEAT_DEAD_MS) return; // vivo
    const g = this.reloadGuard.get(key) ?? { at: 0, count: 0 };
    if (now - g.at < RELOAD_COOLDOWN_MS) {
      dlog('watchdog', `${key}: beat stopped (${gap}ms) but in cooldown — no reload`);
      return; // cooldown ativo
    }
    if (g.count >= RELOAD_MAX_TRIES) {
      dlog('watchdog', `${key}: beat stopped (${gap}ms) but hit the attempt cap — giving up`);
      return; // already tried too many times: gives up (no loop)
    }
    // Always logged (not only in debug): this is the ONLY place that restarts a webview.
    log(`Watchdog: beat of '${key}' stopped ${gap}ms ago (focus=${vscode.window.state.focused}) — reloading`);
    try {
      // A crashed renderer IGNORES a webview.html reassignment — only recreating the panel
      // respawns the process. The Hub is a WebviewView (owned by VSCode): only the html is left.
      if (key === HUB_SURFACE) {
        webview.html = this.getHtml(webview, 'hub');
      } else if (!this.recreatePanel(key)) {
        webview.html = this.getHtml(webview, 'chat', key); // fallback se recriar falhar
      }
    } catch {
      return;
    }
    this.reloadGuard.set(key, { at: now, count: g.count + 1 }); // after the recreate (survives the dispose)
    this.lastBeat.set(key, now); // grace window to remount and start beating again
    log(`Webview render dead (${key}) — recovered (try ${g.count + 1})`);
  }

  /**
   * Recreates a tab's WebviewPanel: dispose of the old one + a new createWebviewPanel,
   * keeping the SAME tabId/session (CLI and context untouched). The only path that
   * respawna um renderer morto. O painel novo manda 'init' → replayTab repinta.
   */
  private recreatePanel(tabId: string): boolean {
    const old = this.panels.get(tabId);
    if (!old) return false;
    const col = old.viewColumn ?? vscode.ViewColumn.Active;
    const title = this.tabMeta.get(tabId)?.title || 'Tootega Cockpit';
    // Unbinds before disposing: the old one's onDidDispose would erase the records
    // of the tabId that will belong to the new panel.
    this.panels.delete(tabId);
    this.webviewSession.delete(old.webview);
    try {
      old.dispose();
    } catch {
      /* already dead */
    }
    let panel: vscode.WebviewPanel;
    try {
      panel = vscode.window.createWebviewPanel('tootega.cockpit.editor', title, col, {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
          vscode.Uri.joinPath(this.extensionUri, 'media'),
        ],
      });
    } catch {
      return false;
    }
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon-color.svg');
    this.justRecreated.add(tabId); // the new panel's init must force a replay even when busy
    log(`recreatePanel: painel da aba '${tabId}' recriado (renderer respawnado)`);
    this.bindPanel(panel, tabId);
    return true;
  }

  /**
   * Manual reload (refresh button in the tab's title bar): forces the same recovery
   * as the watchdog on the active tab, but IGNORING the cooldown/cap — it is an explicit
   * user request to resurrect a gray/blank panel (dead renderer). It runs in the host,
   * so it works even with the renderer stuck.
   */
  reloadActivePanel(): void {
    let tabId: string | undefined;
    for (const [id, p] of this.panels) {
      if (p.active) {
        tabId = id;
        break;
      }
    }
    tabId ??= this.activeTab;
    if (!tabId || !this.panels.has(tabId)) return;
    this.reloadGuard.delete(tabId); // clears the guard: user action, no cap
    try {
      if (!this.recreatePanel(tabId)) {
        const p = this.panels.get(tabId);
        if (p) p.webview.html = this.getHtml(p.webview, 'chat', tabId);
      }
    } catch {
      return;
    }
    this.lastBeat.set(tabId, Date.now()); // grace window to remount
    log(`Webview manual reload (${tabId})`);
  }

  /** A panel restored by the serializer has no session binding: discarded. */
  attachPanel(panel: vscode.WebviewPanel): void {
    try {
      panel.dispose();
    } catch {
      /* noop */
    }
  }

  // ---- Commands exposed to the extension ----

  newSession(): void {
    this.openNewTab();
  }

  private workspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  /** Path relative to the cwd when inside it; absolute otherwise. */
  private resolvePath(absPathRaw: string): string {
    const absPath = absPathRaw.normalize('NFC');
    const cwd = this.workspaceCwd().normalize('NFC');
    const rel = path.relative(cwd, absPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/'); // dentro do contexto -> relativo
    }
    return absPath; // fora do contexto -> absoluto
  }

  /** Resolved path in quotes (handles spaces). */
  private quoteResolved(absPath: string): string {
    return `"${this.resolvePath(absPath)}"`;
  }

  /** Opens a link from the chat: external URL or file (relative to the cwd / absolute / by name). */
  private async openLink(href: string, preview = false): Promise<void> {
    if (!href) return;
    if (/^https?:\/\//i.test(href)) {
      void vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    let raw = href;
    // line anchor (#L12)
    let line: number | undefined;
    const lm = raw.match(/#L(\d+)\s*$/i);
    if (lm) {
      line = parseInt(lm[1], 10);
      raw = raw.slice(0, raw.length - lm[0].length);
    }
    raw = raw.replace(/^file:\/\//i, '').replace(/^["']|["']$/g, '');
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* already decoded */
    }
    raw = raw.normalize('NFC');

    const abs = path.isAbsolute(raw) ? raw : path.join(this.workspaceCwd(), raw);
    let uri = vscode.Uri.file(abs);

    if (!fs.existsSync(abs)) {
      // fallback: looks for the file name in the workspace
      const base = path.basename(raw);
      const safe = base.replace(/[*?[\]{}]/g, '');
      const found = safe
        ? await vscode.workspace.findFiles(`**/${safe}`, '**/node_modules/**', 1)
        : [];
      if (found.length) uri = found[0];
      else {
        void vscode.window.showWarningMessage(vscode.l10n.t('File not found: {0}', base));
        return;
      }
    }

    // Preview mode ("View" link): markdown -> native preview; the rest -> default opener.
    if (preview) {
      const cmd = /\.(md|markdown)$/i.test(uri.fsPath)
        ? 'markdown.showPreview'
        : 'vscode.open';
      try {
        await vscode.commands.executeCommand(cmd, uri);
      } catch {
        void vscode.commands.executeCommand('vscode.open', uri);
      }
      return;
    }

    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(doc, { preview: true });
      if (line) {
        const pos = new vscode.Position(Math.max(0, line - 1), 0);
        editor.selection = new vscode.Selection(pos, pos);
        editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenter);
      }
    } catch {
      void vscode.window.showWarningMessage(vscode.l10n.t('File not found: {0}', raw));
    }
  }

  /**
   * "Warms up" a chat tab's session: it starts the CLI process right when opening,
   * so the `init` event brings the slash commands before the first send. It only acts when
   * there is no process/commands yet and the CLI exists (avoids a useless spawn/error).
   */
  private primeCommands(tabId: string): void {
    const s = this.sessions.get(tabId);
    if (!s || s.cli || s.busy || s.slashCommands.length) return;
    if (!this.cliAvailable) return; // resolved in reportCliStatus (which runs earlier in init)
    try {
      s.ensureCli();
    } catch (e) {
      log(`primeCommands falhou: ${String(e)}`);
    }
  }

  /**
   * Enriquece os slash commands via IA (cache global ~/.claude/tootega) e envia os
   * metadata (category/hint/detail) to the webview. Best-effort: it only researches the ones
   * missing from the cache; a failure doesn't break the UI. Language = the Cockpit locale.
   */
  private async researchSlash(slashCommands?: string[]): Promise<void> {
    if (!slashCommands || slashCommands.length === 0) return;
    let started = false;
    try {
      const meta = await researchCommands({
        commands: slashCommands,
        locale: resolveLocale(),
        onResearchStart: () => {
          started = true;
          this.post({ kind: 'slashResearching', busy: true });
        },
      });
      if (Object.keys(meta).length) this.post({ kind: 'slashMeta', meta });
    } catch (e) {
      log(`researchSlash: ${String(e)}`);
    } finally {
      if (started) this.post({ kind: 'slashResearching', busy: false });
    }
  }

  private sendSessions(): void {
    const cwd = this.workspaceCwd();
    const names = this.memory.get<Record<string, string>>('sessionNames', {});
    const sessions = listSessions(cwd).map((s) =>
      names[s.id] ? { ...s, title: names[s.id] } : s,
    );
    // LIVE sessions (in-memory tabs) may not have a listable transcript on
    // disk yet on the CLI's first response. They are merged so the hub reflects running
    // contexts right away, without waiting for the turn to end.
    // Only BUSY (running) tabs are merged: an idle tab with content already comes from
    // listSessions (the .jsonl exists on disk); an idle, empty tab must NOT
    // reappear — otherwise it becomes a "ghost" that returns after deleting everything.
    const known = new Set(sessions.map((s) => s.id));
    for (const tabId of this.tabOrder) {
      const s = this.sessions.get(tabId);
      if (!s || !s.busy) continue;
      const id = s.sessionId ?? s.resumeId;
      if (!id || known.has(id)) continue;
      known.add(id);
      const nowIso = new Date().toISOString();
      sessions.push({
        id,
        title: names[id] || this.tabMeta.get(tabId)?.title || '',
        updatedAt: nowIso,
        createdAt: nowIso,
        messageCount: 0,
      });
    }
    sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
    this.post({ kind: 'sessions', sessions, cwd });
  }

  /** Lists plugins + marketplaces and sends them to the modal. force = re-validate URLs (Haiku). */
  private async sendPlugins(force = false): Promise<void> {
    this.post({ kind: 'pluginsBusy', busy: true });
    try {
      const data = await listPlugins(this.claudePath(), force);
      this.post({ kind: 'pluginsData', data });
    } catch (e) {
      this.post({ kind: 'pluginsError', message: String(e) });
    } finally {
      this.post({ kind: 'pluginsBusy', busy: false });
    }
  }

  /** Runs a plugin action (install/uninstall/…); reloads the list at the end. */
  private async runPluginAction(
    action: 'install' | 'uninstall' | 'enable' | 'disable' | 'update' | 'marketAdd' | 'marketRemove',
    arg: string,
    scope?: string,
  ): Promise<void> {
    this.post({ kind: 'pluginsBusy', busy: true, label: `${action} ${arg}` });
    try {
      const r = await pluginAction(this.claudePath(), action, arg, scope);
      if (!r.ok) this.post({ kind: 'pluginsError', message: r.message ?? 'failed' });
      const data = await listPlugins(this.claudePath());
      this.post({ kind: 'pluginsData', data });
    } catch (e) {
      this.post({ kind: 'pluginsError', message: String(e) });
    } finally {
      this.post({ kind: 'pluginsBusy', busy: false });
    }
  }

  /**
   * MCP servers (MCP button): merges the session's `init` inventory (tools per
   * server) with `claude mcp list` (pending approval + command/URL).
   * When the session hasn't done init yet (new tab), the panel shows only `mcp list`.
   */
  private async sendMcp(s: Session): Promise<void> {
    this.post({ kind: 'mcpBusy', busy: true });
    try {
      const list = await fetchMcpList(this.claudePath());
      const servers = mergeMcpStatus(s.lastTools, s.lastMcpServers, list);
      this.post({ kind: 'mcpData', data: { servers, generatedAt: new Date().toISOString() } });
    } catch (e) {
      log(`sendMcp: ${String(e)}`);
      this.post({ kind: 'mcpData', data: { servers: [], generatedAt: new Date().toISOString() } });
    } finally {
      this.post({ kind: 'mcpBusy', busy: false });
    }
  }

  /** Gathers the account + real (hot) limits and sends them to the webview (Usage button). */
  private async sendUsage(): Promise<void> {
    try {
      await this.refreshUsage(true); // forces a fresh API call (hot data on click)
      const account = await fetchAuthStatus(this.claudePath());
      const scoped = this.lastScoped ?? readUsageCache()?.weeklyScoped;
      // Detalhamento local 7d (por modelo / origem) — sempre estimativa de tabela,
      // independent of the account's real %. It scans this machine's transcripts.
      const [local, tokens] = await Promise.all([
        computeLocalUsage(Date.now()),
        computeDailyTokens(),
      ]);
      this.post({
        kind: 'usageData',
        data: {
          account,
          buckets: {
            fiveHour: toBucket(this.lastLimits?.fiveHour),
            sevenDay: toBucket(this.lastLimits?.sevenDay),
            weeklyScoped: scoped,
          },
          source: this.lastUsageSource,
          trackingEnabled: usageTrackingEnabled(),
          breakdown: local.breakdown,
          attribution: local.attribution,
          tokens,
          otel: this.otel.stats(),
          generatedAt: new Date().toISOString(),
        },
      });
    } catch (e) {
      log(`sendUsage: ${String(e)}`);
    }
  }

  private autoResumeDone = false;

  /** Resumes the most recent session ONCE (on the first init). Sessions created later
   *  by the user ("New Session") must start empty, not resume the last one. */
  private autoResumeLast(): void {
    if (this.autoResumeDone) return;
    this.autoResumeDone = true;
    if (!this.cfg().get<boolean>('autoResumeLastSession', true)) return;
    const s = this.active();
    if (s.resumeId || s.cli || s.sessionId) return; // there is already an active session
    const id = latestSessionId(this.workspaceCwd());
    if (id) {
      s.resume(id);
      this.restoreSessionModel(s, id); // restaura model/effort salvos
      this.sendConfig(); // reflects the restored model/effort in the dropdowns
    }
  }

  /**
   * Re-sends a tab's conversation (from the transcript) to ALL surfaces — to
   * populate a freshly opened panel or when switching tabs. It is skipped when the tab is
   * busy (live streaming) so the turn in progress isn't overwritten.
   */
  private replayTab(tabId: string, force = false): void {
    const s = this.sessions.get(tabId);
    // Normal: skipped when busy (doesn't overwrite the live turn). Recovery (force):
    // the panel has just remounted blank — repaints the persisted history; the
    // deltas em voo continuam chegando e se anexam.
    if (!s || (s.busy && !force)) return;
    const id = s.sessionId ?? s.resumeId;
    if (!id) return;
    const items = loadTranscript(this.workspaceCwd(), id);
    if (!this.tabMeta.get(tabId)?.title) {
      const names = this.memory.get<Record<string, string>>('sessionNames', {});
      this.setTabTitle(tabId, names[id] || this.titleFromItems(items));
    }
    this.post({ kind: 'history', items }, tabId);
  }

  /**
   * Opens a session (double click in the list): focuses the tab that already has it; otherwise
   * opens it in a NEW tab. It never overwrites the active tab's conversation.
   */
  private openSession(sessionId: string): void {
    for (const [id, s] of this.sessions) {
      if (s.sessionId === sessionId || s.resumeId === sessionId) {
        this.openSessionPanel(id); // foca o painel existente
        return;
      }
    }
    const tab = this.createTab();
    this.resumeInTab(tab, sessionId);
    this.openSessionPanel(tab); // opens the context in its own webview
    this.sendConfig();
  }

  /**
   * Reload (↻ button on the card): recovers the context's gray/dead webview. When the
   * panel is open, it recreates it (same tabId/session untouched) and reveals it; otherwise
   * it opens fresh. It runs in the host → it works even with the renderer stuck.
   */
  private reloadSession(sessionId: string): void {
    for (const [id, s] of this.sessions) {
      if (s.sessionId === sessionId || s.resumeId === sessionId) {
        if (this.panels.has(id)) {
          this.reloadGuard.delete(id); // explicit request: ignores cooldown/cap
          if (this.recreatePanel(id)) this.panels.get(id)?.reveal();
        } else {
          this.openSessionPanel(id);
        }
        return;
      }
    }
    this.openSession(sessionId); // it wasn't loaded: opens it from scratch
  }

  /**
   * Publishes the session for remote control (follow/interact from the phone): it opens
   * o contexto e roda /remote-control no CLI dele — o CLI devolve o link/QR de
   * pareamento na conversa.
   */
  private remoteControl(sessionId: string): void {
    this.openSession(sessionId); // makes sure the session is open/loaded
    for (const [, s] of this.sessions) {
      if (s.sessionId === sessionId || s.resumeId === sessionId) {
        s.send('/remote-control');
        return;
      }
    }
  }

  /** Reopens the last session the user closed (Ctrl+Shift+T). */
  reopenClosed(): void {
    const lc = this.lastClosed;
    if (!lc) return;
    this.lastClosed = undefined;
    // Session still alive in memory (only the panel was closed): reopens its panel.
    if (this.sessions.has(lc.tabId)) {
      this.openSessionPanel(lc.tabId);
    } else if (lc.sessionId) {
      this.openSession(lc.sessionId); // recarrega do transcript
    }
  }

  /** Loads a session's history into a specific tab and arms --resume. */
  private resumeInTab(tab: string, sessionId: string): void {
    const s = this.sessions.get(tab);
    s?.resume(sessionId);
    if (s) this.restoreSessionModel(s, sessionId); // model/effort saved for this session
    const items = loadTranscript(this.workspaceCwd(), sessionId);
    const names = this.memory.get<Record<string, string>>('sessionNames', {});
    this.setTabTitle(tab, names[sessionId] || this.titleFromItems(items));
    this.post({ kind: 'history', items }, tab);
    this.postTabs();
    log(`Resuming session ${sessionId} (${items.length} items) in ${tab}`);
  }

  /** Persists a session's model/effort (override) by sessionId, to restore later. */
  private saveSessionModel(s: Session): void {
    const id = s.sessionId ?? s.resumeId;
    if (!id) return; // a new session without an id yet: saved when init brings the id
    const map = this.memory.get<Record<string, SessionPrefs>>('sessionModels', {});
    map[id] = {
      model: s.modelOverride,
      effort: s.effortOverride,
      allowAgents: s.allowAgentsOverride,
    };
    void this.memory.update('sessionModels', map);
  }

  /** Restores a session's saved model/effort (without restarting — there is no CLI yet). */
  private restoreSessionModel(s: Session, id: string): void {
    const map = this.memory.get<Record<string, SessionPrefs>>('sessionModels', {});
    const o = map[id];
    if (!o) return;
    if (o.model) s.modelOverride = o.model;
    if (o.effort) s.effortOverride = o.effort;
    if (typeof o.allowAgents === 'boolean') s.allowAgentsOverride = o.allowAgents;
  }

  /**
   * Rewinds the conversation to the (index)-th user prompt: cuts the transcript
   * at that prompt (removing it and everything after), re-arms --resume of the truncated session and
   * reloads the history in the webview. The next message continues from that point.
   */
  private rewind(tabId: string, index: number): void {
    const s = this.sessions.get(tabId);
    if (!s || s.busy) return; // doesn't rewind a turn in progress
    const id = s.sessionId ?? s.resumeId;
    if (!id) return;
    const cwd = this.workspaceCwd();
    const users = loadTranscript(cwd, id).filter((i) => i.kind === 'user');
    const target = users[index];
    if (!target) return;
    if (!truncateTranscriptAt(cwd, id, target.id)) {
      log(`rewind: prompt #${index} (uuid ${target.id}) not found in the transcript`);
      return;
    }
    s.resume(id); // limpa a conversa e rearma --resume a partir do transcript truncado
    this.replayTab(tabId); // reloads the (already cut) history in the webview
    this.postTabs();
    this.sendSessions();
    log(`rewind: session ${id} cut at prompt #${index}`);
  }

  /**
   * Inicia o ditado por voz (STT) p/ a aba: abre o WS OAuth, captura o mic NO
   * HOST (via ffmpeg — the webview blocks getUserMedia) and routes the transcriptions
   * back to the surface. It ends a previous session, when there is one.
   */
  private async startVoice(tabId: string, language?: string): Promise<void> {
    this.stopVoice();
    // Language: an explicit setting (tootega.voiceLanguage) wins; otherwise the
    // webview locale; otherwise the Cockpit locale. Normalized to short (pt-BR->pt).
    const forced = this.cfg().get<string>('voiceLanguage', '').trim();
    const lang = ((forced || language || this.voiceLanguage()).split('-')[0] || 'en').toLowerCase();
    // Account dictionary: terms bias the STT (keyterms) + replacements applied
    // to the text. The key is resolved (cached) to match what the modal saved.
    // Reloaded from disk on every dictation (reflects modal edits immediately).
    this.voiceDict = loadDictionary();
    // Keyterms = the user's dictionary (priority) + the project name + terms
    // harvested from the workspace (deps + tech glossary). Since the STT runs monolingual
    // (the proxy rejects language=multi), keyterms is the anchor for the literal spelling of
    // jargon/English dictated inside pt-BR.
    const cwd = this.workspaceCwd();
    const keyterms = buildKeyterms(this.voiceDict, [path.basename(cwd), ...workspaceTerms(cwd)]);
    dlog(
      'voice',
      `dict: ${this.voiceDict.terms.length} terms, ${this.voiceDict.replacements.length} replacements | keyterms="${keyterms.slice(0, 240)}"`,
    );
    const capture = new AudioCapture({
      ffmpegPath: this.cfg().get<string>('ffmpegPath', '') || undefined,
    });
    this.voiceCapture = capture;
    let firstFrame = false; // sinaliza 'pronto' no 1º PCM real (mic vivo + WS aberto)
    this.voice = new VoiceSession(lang, keyterms, {
      onOpen: () => {
        // WS ready: start capturing and pushing PCM.
        void capture.start(
          (buf) => {
            if (!firstFrame) {
              firstFrame = true;
              // Only now is the dictation REALLY valid (WS + audio flowing):
              // the webview drops the spinner and enables "you may speak". Avoids losing
              // as 1ªs palavras faladas durante o setup do WS/ffmpeg.
              this.post({ kind: 'voiceReady' }, tabId);
            }
            this.voice?.pushAudio(buf);
          },
          (message) => {
            this.post({ kind: 'voiceError', message }, tabId);
            this.stopVoice();
          },
          () => {
            /* ffmpeg saiu: o stop() do WS cuida do encerramento */
          },
        );
      },
      onTranscript: (text, isFinal) => {
        const fixed = applyReplacements(text, this.voiceDict);
        if (isFinal && fixed !== text) dlog('voice', `replacement applied: "${text}" → "${fixed}"`);
        this.post({ kind: 'voiceTranscript', text: fixed, isFinal }, tabId);
      },
      onError: (message) => this.post({ kind: 'voiceError', message }, tabId),
      onClose: () => {
        this.voiceCapture?.stop();
        this.voiceCapture = undefined;
        this.voice = undefined;
        this.post({ kind: 'voiceClosed' }, tabId);
      },
    });
    this.voice.start();
  }

  /** Encerra a captura e o WS de voz, se ativos. */
  private stopVoice(): void {
    this.voiceCapture?.stop();
    this.voiceCapture = undefined;
    this.voice?.stop();
  }

  /** Corrects the dictated text via Haiku (isolated one-shot) and returns it to the surface. */
  private async correctVoice(tabId: string, text: string): Promise<void> {
    const t = text.trim();
    if (!t) {
      this.post({ kind: 'voiceCorrectError' }, tabId);
      return;
    }
    // Applies the dictionary replacements BEFORE and steers Haiku to preserve
    // the account's terms (not to "fix" proper nouns/jargon).
    const dict = loadDictionary();
    const pre = applyReplacements(t, dict);
    const corrected = await correctText(pre, correctorHints(dict));
    if (corrected) this.post({ kind: 'voiceCorrected', text: corrected }, tabId);
    else this.post({ kind: 'voiceCorrected', text: pre }, tabId); // Haiku failed: at least the replacements
  }

  /**
   * Exporta a conversa p/ um .md na RAIZ do projeto. mode 'direct' grava o
   * mechanical markdown; 'ai' rewrites it via the CLI (same model/effort as the tab, spends
   * tokens). Unique name (avoids overwriting); opens the file at the end.
   */
  private async exportConversation(
    tabId: string,
    markdown: string,
    fileName: string | undefined,
    mode: 'direct' | 'ai',
  ): Promise<void> {
    const pt = resolveLocale().startsWith('pt');
    try {
      let content = markdown;
      if (mode === 'ai') {
        const gen = await this.generateDocAI(tabId, markdown);
        if (!gen) {
          void vscode.window.showErrorMessage(
            pt ? 'Falha ao gerar o documento com IA.' : 'Failed to generate the document with AI.',
          );
          return;
        }
        content = gen;
      }
      const target = uniqueFilePath(path.join(this.workspaceCwd(), fileName || 'conversa.md'));
      await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(content, 'utf8'));
      await vscode.window.showTextDocument(vscode.Uri.file(target), { preview: false });
    } catch (e) {
      log(`exportConversation: ${String(e)}`);
      void vscode.window.showErrorMessage(pt ? 'Falha ao exportar a conversa.' : 'Failed to export the conversation.');
    }
  }

  /**
   * Generates the document via a CLI one-shot (a separate process — it does NOT pollute the tab),
   * with the session's SAME effective model/effort. It spends subscription tokens.
   * Retorna o Markdown gerado, ou undefined em falha.
   */
  private generateDocAI(tabId: string, sourceMd: string): Promise<string | undefined> {
    const s = this.sessions.get(tabId) ?? this.active();
    const model = s.model();
    const effort = s.effort();
    const prompt = `${DOC_PROMPT}\n\n--- REGISTRO DA CONVERSA ---\n\n${sourceMd}`;
    // The prompt goes through STDIN (not argv): the conversation can be long and blow the
    // command-line limit (Windows ~32k). `claude -p` with no arg reads stdin.
    const args = ['-p', '--output-format', 'json'];
    if (model && model !== 'default') args.push('--model', model);
    if (effort && effort !== 'default') args.push('--effort', effort);
    const useShell = process.platform === 'win32';
    const exe = useShell && /\s/.test(this.claudePath()) ? `"${this.claudePath()}"` : this.claudePath();

    return Promise.resolve(vscode.window.withProgress<string | undefined>(
      { location: vscode.ProgressLocation.Notification, title: this.docProgressTitle(model, effort), cancellable: true },
      (_p, token) =>
        new Promise((resolve) => {
          let out = '';
          const proc = spawn(exe, args, { cwd: this.workspaceCwd(), env: process.env, shell: useShell });
          const killer = setTimeout(() => { try { proc.kill(); } catch { /* noop */ } }, 180_000);
          token.onCancellationRequested(() => { try { proc.kill(); } catch { /* noop */ } });
          try {
            proc.stdin?.write(prompt);
            proc.stdin?.end();
          } catch { /* pipe fechou: o close devolve o que houver */ }
          proc.stdout?.setEncoding('utf8');
          proc.stdout?.on('data', (c: string) => (out += c));
          proc.on('error', (e) => { clearTimeout(killer); log(`generateDocAI spawn: ${String(e)}`); resolve(undefined); });
          proc.on('close', () => {
            clearTimeout(killer);
            resolve(extractCliResult(out));
          });
        }),
    ));
  }

  private docProgressTitle(model: string, effort: string): string {
    const pt = resolveLocale().startsWith('pt');
    const m = model && model !== 'default' ? model : pt ? 'padrão' : 'default';
    const e = effort && effort !== 'default' ? effort : pt ? 'padrão' : 'default';
    return pt
      ? `Gerando documento com IA (modelo ${m}, effort ${e})…`
      : `Generating document with AI (model ${m}, effort ${e})…`;
  }

  /** Loads the machine dictionary (dictation + spell-checker) and sends it to the modal. */
  private sendVoiceDict(tabId: string): void {
    const d = loadDictionary();
    this.post({ kind: 'voiceDict', data: { ...d, spellWords: this.getSpeller().userDict() } }, tabId);
  }

  /** Saves dictation + spell-checker dictionary (single per-machine file). */
  private saveVoiceDict(
    tabId: string,
    terms: string[],
    replacements: VoiceReplacement[],
    spellWords?: string[],
  ): void {
    if (spellWords) this.getSpeller().setUserDict(spellWords);
    // The dictation terms changed: reflected in the spell-checker (they aren't errors).
    this.getSpeller().setProjectTerms([...workspaceTerms(this.workspaceCwd()), ...terms]);
    const words = this.getSpeller().userDict();
    saveDictionary({ terms, replacements, spellWords: words });
    this.voiceDict = loadDictionary(); // applied right away to the next transcriptions
    this.post({ kind: 'voiceDict', data: { ...this.voiceDict, spellWords: words } }, tabId);
  }

  /** Spell-checker (lazy). Dictionaries in dict/ (data files). */
  private getSpeller(): Speller {
    if (!this.speller) {
      const dir = vscode.Uri.joinPath(this.extensionUri, 'dict').fsPath;
      // The spell-checker words come from the single per-machine file (~/.claude/tootega).
      const dict = loadDictionary();
      this.speller = new Speller(dir, dict.spellWords ?? []);
      // Technical terms (workspace deps/glossary + dictation dictionary terms)
      // count as known: the spell-checker doesn't flag them as errors.
      this.speller.setProjectTerms([...workspaceTerms(this.workspaceCwd()), ...dict.terms]);
    }
    return this.speller;
  }

  /** Checks a batch of words and returns the wrong ones to the tab that asked. */
  private async handleSpellCheck(tabId: string, words: string[]): Promise<void> {
    const sp = this.getSpeller();
    await sp.ensure();
    this.post({ kind: 'spellResult', bad: sp.check(words) }, tabId);
  }

  /** Correction suggestions (per language) for a word. */
  private async handleSpellSuggest(tabId: string, requestId: string, word: string): Promise<void> {
    const sp = this.getSpeller();
    await sp.ensure();
    const s = sp.suggest(word);
    this.post({ kind: 'spellSuggestResult', requestId, word, pt: s.pt, en: s.en }, tabId);
  }

  /** Dictation language: Cockpit locale -> short BCP47 code (pt-BR -> pt). */
  private voiceLanguage(): string {
    const loc = resolveLocale();
    return (loc.split('-')[0] || 'en').toLowerCase();
  }

  /**
   * Language of the agent's questions (AskUserQuestion). Same priority as dictation:
   * explicit `tootega.voiceLanguage` setting > Cockpit locale. Short code.
   */
  private askLanguageCode(): string {
    const forced = this.cfg().get<string>('voiceLanguage', '').trim();
    return ((forced || resolveLocale()).split('-')[0] || 'en').toLowerCase();
  }

  /** Short title from the user's first utterance in the transcript. */
  private titleFromItems(items: { kind: string; text?: string }[]): string {
    const first = items.find((i) => i.kind === 'user' && i.text)?.text ?? '';
    return first.replace(/\s+/g, ' ').trim().slice(0, 28);
  }

  /** Current file content (for the Write diff). Empty when new/unreadable/large. */
  private currentFileText(tool: string, input: unknown): string | undefined {
    if (tool !== 'Write') return undefined;
    const fp = (input as { file_path?: unknown })?.file_path;
    if (typeof fp !== 'string' || !fp) return undefined;
    try {
      const abs = path.isAbsolute(fp) ? fp : path.join(this.workspaceCwd(), fp);
      if (!fs.existsSync(abs)) return ''; // arquivo novo -> tudo adicionado
      const st = fs.statSync(abs);
      if (st.size > 512 * 1024) return undefined; // grande demais p/ diff
      return fs.readFileSync(abs, 'utf8');
    } catch {
      return undefined;
    }
  }

  // Auto-save: before the agent reads/writes a file, it saves the open buffer when
  // dirty (prevents the agent from working on an old version). Setting tootega.autosave.
  private autoSaveForTool(tool: string, input: unknown): void {
    if (!this.cfg().get<boolean>('autosave', true)) return;
    if (!/^(Edit|Write|MultiEdit|NotebookEdit|Read)$/.test(tool)) return;
    const fp = (input as { file_path?: unknown })?.file_path;
    if (typeof fp !== 'string' || !fp) return;
    const abs = path.isAbsolute(fp) ? fp : path.join(this.workspaceCwd(), fp);
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.isDirty && doc.uri.fsPath === abs) {
        void doc.save();
        return;
      }
    }
  }

  // Virtual content (the "proposed" side) of the native diff, per URI.
  private diffContent = new Map<string, string>();
  private diffProviderReg?: vscode.Disposable;
  private diffSeq = 0;

  /** Abre o diff proposto (Edit/Write/MultiEdit) no diff nativo do VS Code. */
  private async openNativeDiff(tool: string, input: unknown): Promise<void> {
    const inp = (input ?? {}) as Record<string, unknown>;
    const fp = typeof inp.file_path === 'string' ? inp.file_path : '';
    if (!fp) return;
    const abs = path.isAbsolute(fp) ? fp : path.join(this.workspaceCwd(), fp);
    let oldText = '';
    try {
      oldText = fs.readFileSync(abs, 'utf8');
    } catch {
      /* arquivo novo */
    }
    const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));
    let newText = oldText;
    if (tool === 'Write') newText = str(inp.content);
    else if (tool === 'Edit') newText = oldText.split(str(inp.old_string)).join(str(inp.new_string));
    else if (tool === 'MultiEdit' && Array.isArray(inp.edits)) {
      for (const e of inp.edits as Record<string, unknown>[]) {
        newText = newText.split(str(e.old_string)).join(str(e.new_string));
      }
    }
    // Provider lazy do esquema virtual p/ o lado "proposto".
    if (!this.diffProviderReg) {
      this.diffProviderReg = vscode.workspace.registerTextDocumentContentProvider('cockpit-diff', {
        provideTextDocumentContent: (uri) => this.diffContent.get(uri.toString()) ?? '',
      });
    }
    const fileExists = fs.existsSync(abs);
    const rightUri = vscode.Uri.parse(`cockpit-diff:/${this.diffSeq++}/${path.basename(abs)}`);
    this.diffContent.set(rightUri.toString(), newText);
    const leftUri = fileExists
      ? vscode.Uri.file(abs)
      : (() => {
          const u = vscode.Uri.parse(`cockpit-diff:/${this.diffSeq++}/old-${path.basename(abs)}`);
          this.diffContent.set(u.toString(), oldText);
          return u;
        })();
    const title = `${path.basename(abs)} — proposed (${tool})`;
    await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
  }

  /** Busca arquivos do workspace p/ o autocomplete de @-mention (fuzzy por path). */
  private async searchMentions(tabId: string, requestId: string, query: string): Promise<void> {
    let items: string[] = [];
    try {
      const glob = query ? `**/*${query.replace(/[^\w./-]/g, '')}*` : '**/*';
      const uris = await vscode.workspace.findFiles(glob, '**/node_modules/**', 30);
      items = uris.map((u) => vscode.workspace.asRelativePath(u, false)).sort((a, b) => a.length - b.length);
    } catch {
      /* no workspace */
    }
    this.post({ kind: 'mentionResults', requestId, items: items.slice(0, 12) }, tabId);
  }

  private notifyComplete(): void {
    if (!this.cfg().get<boolean>('notifyOnComplete', true)) return;
    // Notifies when no chat panel is visible.
    for (const p of this.panels.values()) if (p.visible) return;
    void vscode.window.showInformationMessage(vscode.l10n.t('Claude finished responding.'));
  }

  private renameSession(id: string, name: string): void {
    const names = this.memory.get<Record<string, string>>('sessionNames', {});
    const next = { ...names };
    const trimmed = name.trim();
    if (trimmed) next[id] = trimmed;
    else delete next[id];
    void this.memory.update('sessionNames', next);
    // Immediately updates the title of that session's open tab/webview (when there is one).
    // Matched by sessionId (a turn already ran) OR resumeId (resumed without a turn yet).
    for (const [tabId, s] of this.sessions) {
      if (s.sessionId === id || s.resumeId === id) {
        this.setTabTitle(tabId, trimmed);
        break;
      }
    }
    this.sendSessions();
  }

  /**
   * Shuts down a tab's live CLI before deleting its transcript. Without this the
   * open session's `claude` process holds the `.jsonl` handle (on Windows the
   * unlink fails and the file survives) OR recreates it on the next flush/keep-alive —
   * the "ghost session" that reappears in the hub. clearConversation() kills the process
   * e zera sessionId/resumeId, detachando a aba do transcript apagado.
   * `all=true` detacha todas as abas vivas (usado no "apagar tudo").
   */
  private detachLiveSessions(sessionId?: string, all = false): void {
    for (const [tabId, s] of this.sessions) {
      const match = all || s.sessionId === sessionId || s.resumeId === sessionId;
      if (!match) continue;
      const wasOpen = !!(s.sessionId || s.resumeId || s.cli);
      s.clearConversation();
      if (!wasOpen) continue;
      // Reflete a limpeza na webview aberta desta aba (se houver).
      this.setTabTitle(tabId, '');
      this.post({ kind: 'history', items: [] }, tabId);
    }
  }

  // They reflect the active tab (tab override ?? settings default).
  private currentModel(): string {
    return this.active().model();
  }
  private currentEffort(): string {
    return this.active().effort();
  }
  private currentPermissionMode(): string {
    return this.active().permission();
  }
  private currentAllowAgents(): boolean {
    return this.active().allowAgents();
  }

  private userName(): string {
    const set = this.cfg().get<string>('userName', '').trim();
    if (set) return set;
    try {
      return os.userInfo().username || '';
    } catch {
      return '';
    }
  }

  /**
   * Queries /v1/models once. It uses the API key (when present) or the subscription's
   * OAuth token — so new models released to the account show up without editing the
   * static list. It is a no-op only when there is no credential at all.
   */
  private async tryDiscoverModels(): Promise<void> {
    // The price is independent of the credential (public docs) — fetched in parallel.
    void this.tryFetchPricing();
    if (this.discoveryTried) return;
    this.discoveryTried = true;
    const creds = resolveCreds(await this.getApiKey());
    if (!creds) return; // no API key and no OAuth token: uses the static fallback
    try {
      const models = await discoverModels(creds);
      let added = false;
      for (const m of models) {
        if (!this.discoveredModels.has(m.id)) added = true;
        this.discoveredModels.set(m.id, m.contextTokens);
        registerModelContext(m.id, m.contextTokens); // fonte p/ o limite da barra (1M nativo)
      }
      if (added) {
        log(`Discovered ${models.length} models via /v1/models`);
        this.sendConfig();
        this.refreshContextLimits(); // post-init discovery: fixes the bar of the 1M models
      }
    } catch {
      /* silent — the fallback already covers it */
    }
  }

  /** Loads prices from the docs (cached once a day). No-op after the first time. */
  private async tryFetchPricing(): Promise<void> {
    if (this.pricingTried || !this.globalStorageDir) return;
    this.pricingTried = true;
    try {
      const map = await ensurePricing(this.globalStorageDir);
      if (Object.keys(map).length > 0) {
        this.pricing = map;
        log(`Loaded pricing for ${Object.keys(map).length} models`);
        this.sendConfig();
      }
    } catch {
      /* silent — the price column stays empty */
    }
  }

  // Reapplies the (auto) context limit of every tab and re-emits the stats of the
  // ones that changed. Used when discovery arrives after the session init.
  private refreshContextLimits(): void {
    for (const [tab, s] of this.sessions) {
      if (s.stats.refreshContextLimit()) {
        this.post({ kind: 'stats', stats: s.snapshot() }, tab);
      }
    }
  }

  private sendConfig(): void {
    // Discovered live but missing from the list — skipping the 200K versions
    // whose 1M variant is already offered.
    const discoveredExtra = [...this.discoveredModels.keys()].filter(
      (m) => !MODEL_LIST.includes(m) && !BASE_OF_1M.has(m),
    );
    const models = dedupe([...MODEL_LIST, ...discoveredExtra]);
    this.post({
      kind: 'config',
      config: {
        model: this.currentModel(),
        effort: this.currentEffort(),
        models,
        modelMeta: this.buildModelMeta(models),
        efforts: EFFORT_OPTIONS,
        defaultModel: this.defaults.model ?? this.observedDefaultModel,
        defaultEffort: this.defaults.effort,
        permissionMode: this.currentPermissionMode(),
        permissionModes: PERMISSION_MODES,
        allowAgents: this.currentAllowAgents(),
        showThinking: this.cfg().get<boolean>('showThinking', false),
        spellCheck: this.cfg().get<boolean>('spellCheck', false),
        expandToolCards: this.cfg().get<boolean>('expandToolCards', false),
        pendingRestart: this.pendingRestart,
        userName: this.userName(),
        voiceCorrect: this.cfg().get<boolean>('voiceCorrect', false),
        verbosity: this.cfg().get<string>('verbosity', 'verbose') || 'verbose',
      },
    });
  }

  /**
   * Per-model metadata for the selector columns. The context is REAL from the Models
   * API when discovered; otherwise derived ([1m]→1M, else 200K). The price comes from the
   * docs (base id, without the [1m] suffix); the multiplier normalizes the input by
   * Opus 4.8 (=1x), or by the highest price when Opus isn't in the table.
   */
  private buildModelMeta(models: string[]): Record<string, ModelMeta> {
    const anchor =
      this.pricing['claude-opus-4-8']?.inMTok ??
      Math.max(0, ...Object.values(this.pricing).map((p) => p.inMTok));
    const meta: Record<string, ModelMeta> = {};
    for (const id of models) {
      if (id === 'default' || /^(opus|sonnet|haiku|fable|mythos)$/i.test(id)) continue;
      const is1m = /\[1m\]/i.test(id);
      // Price key: without the [1m] suffix and without a dated snapshot (-YYYYMMDD).
      const baseId = id.replace(/\[1m\]/i, '').replace(/-\d{8}$/, '');
      const contextTokens = is1m ? 1_000_000 : (this.discoveredModels.get(id) ?? 200_000);
      const price = this.pricing[baseId];
      meta[id] = {
        contextTokens,
        inMTok: price?.inMTok,
        outMTok: price?.outMTok,
        priceMult:
          price && anchor > 0 ? Math.round((price.inMTok / anchor) * 100) / 100 : undefined,
      };
    }
    return meta;
  }

  interrupt(): void {
    this.active().interrupt();
  }

  pushLocale(): void {
    this.post({ kind: 'locale', locale: resolveLocale() });
  }

  /** Retries model discovery (e.g. after changing the API key). */
  refreshModels(): void {
    this.discoveryTried = false;
    void this.tryDiscoverModels();
  }

  /** API key da descoberta de modelos, lida do SecretStorage (cifrada). '' se ausente. */
  private async getApiKey(): Promise<string> {
    if (!this.secrets) return '';
    try {
      return (await this.secrets.get(API_KEY_SECRET)) ?? '';
    } catch {
      return '';
    }
  }

  /**
   * Asks the user for the API key (masked input) and writes it to SecretStorage.
   * Empty = removes the key. It re-runs model discovery at the end.
   * Comando `tootega.setApiKey`.
   */
  async setApiKeyInteractive(): Promise<void> {
    if (!this.secrets) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('SecretStorage unavailable — cannot store the API key on this host.'),
      );
      return;
    }
    const current = await this.getApiKey();
    const value = await vscode.window.showInputBox({
      title: vscode.l10n.t('Anthropic API key (model discovery)'),
      prompt: vscode.l10n.t('Stored encrypted in the OS keychain. Leave empty to remove.'),
      password: true,
      value: current,
      ignoreFocusOut: true,
      placeHolder: 'sk-ant-…',
    });
    if (value === undefined) return; // cancelou
    const trimmed = value.trim();
    if (trimmed) {
      await this.secrets.store(API_KEY_SECRET, trimmed);
      void vscode.window.showInformationMessage(vscode.l10n.t('API key saved to the OS keychain.'));
    } else {
      await this.secrets.delete(API_KEY_SECRET);
      void vscode.window.showInformationMessage(vscode.l10n.t('API key removed.'));
    }
    this.refreshModels();
  }

  /** Remove a API key do SecretStorage. Comando `tootega.clearApiKey`. */
  async clearApiKey(): Promise<void> {
    if (this.secrets) await this.secrets.delete(API_KEY_SECRET);
    void vscode.window.showInformationMessage(vscode.l10n.t('API key removed.'));
    this.refreshModels();
  }

  /**
   * One-off migration: when the old `tootega.apiKey` setting (plain text) has a value,
   * move p/ o SecretStorage e apaga a setting. Best-effort, silencioso.
   */
  async migrateApiKeyFromSettings(): Promise<void> {
    if (!this.secrets) return;
    const legacy = this.cfg().get<string>('apiKey', '').trim();
    if (!legacy) return;
    try {
      if (!(await this.secrets.get(API_KEY_SECRET))) {
        await this.secrets.store(API_KEY_SECRET, legacy);
      }
      // Cleared from all 3 scopes so no plain-text trace is left.
      const cfg = this.cfg();
      await cfg.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('apiKey', undefined, vscode.ConfigurationTarget.Workspace);
      await cfg.update('apiKey', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      log('[apiKey] migrada da setting p/ SecretStorage; setting removida');
      this.refreshModels();
    } catch (e) {
      log(`[apiKey] migration failed: ${String(e)}`);
    }
  }

  /** Applies the internal model (tootega.internalModel) to the AI helper. */
  applyInternalModel(): void {
    setInternalModel(this.cfg().get<string>('internalModel', ''));
  }

  /** Recomputes local usage (e.g. after changing the budget in the settings). */
  refreshUsageNow(): void {
    void this.refreshUsage();
  }

  /** The model/effort settings changed: clears overrides and reflects them in the UI dropdowns. */
  applyDefaultsFromSettings(): void {
    // The default settings changed: tabs without an override now follow them.
    this.active().stop();
    this.sendConfig();
  }

  /** UI-only prefs (thinking/tool cards/name/verbosity): re-pushes the config without touching the session. */
  pushConfig(): void {
    this.sendConfig();
    if (this.activeTab) this.postTaskTimings(this.activeTab); // verbosity muda o escopo do gauge
  }

  /** Opens the session list in the UI (command/shortcut). */
  openSessions(): void {
    this.post({ kind: 'openSessions' });
    this.sendSessions();
  }

  // Escopo (modelo, effort) p/ segmentar os tempos: prefere o modelo REAL
  // resolved by the CLI (snapshot), falling back to the selected one. Effort: the CLI doesn't
  // echo the level in the stream, so we resolve 'default' to the Cockpit setting and,
  // when still 'default', to the CLI's REAL effortLevel (~/.claude/settings.json) —
  // that way the key doesn't stay on an ambiguous 'default'.
  private timingScope(s: Session): { model: string; effort: string; verbosity: string } {
    const model = s.stats.snapshot().model || s.model() || 'default';
    let effort = s.effort() || 'default';
    if (effort === 'default') effort = this.cfg().get<string>('effort', 'default') || 'default';
    if (effort === 'default') effort = this.defaults.effort || 'default';
    const verbosity = this.cfg().get<string>('verbosity', 'verbose') || 'verbose';
    return { model, effort, verbosity };
  }

  /** Sends the averages of the tab's current scope to the surface(s) (calibrated gauge). */
  private postTaskTimings(tabId: string): void {
    const s = this.sessions.get(tabId) ?? this.active();
    const { model, effort, verbosity } = this.timingScope(s);
    this.post({ kind: 'taskTimings', timings: taskTimingsScoped(model, effort, verbosity) }, tabId);
  }

  // ---- Mensagens vindas do webview ----

  private onWebviewMessage(m: WebviewToHost, webview?: vscode.Webview): void {
    // Any message proves the render is alive: arms the watchdog clock.
    const sk = this.surfaceKey(webview);
    if (sk) {
      this.lastBeat.set(sk, Date.now());
      const g = this.reloadGuard.get(sk);
      if (g && Date.now() - g.at > RELOAD_COOLDOWN_MS) this.reloadGuard.delete(sk); // recuperou: zera o cap
    }
    // Origin session: chat panel -> its session; hub/unbound -> the active one.
    const bound = webview ? this.webviewSession.get(webview) : undefined;
    const srcTab = bound && this.sessions.has(bound) ? bound : this.activeTab;
    const srcSession = (): Session => this.sessions.get(srcTab) ?? this.active();
    switch (m.kind) {
      case 'heartbeat':
        this.startWatchdog(); // idempotente: garante o checador rodando
        break;
      case 'init':
        if (this.tabOrder.length === 0) this.createTab();
        this.startWatchdog();
        this.post({ kind: 'ready', locale: resolveLocale() });
        this.sendConfig();
        this.reportCliStatus();
        void this.tryDiscoverModels();
        this.startUsageTimer();
        this.reportAuth(); // login state for the Sign in/out button
        this.postTaskTimings(bound ?? this.activeTab); // scope averages to calibrate the gauge
        this.autoResumeLast();
        this.postTabs();
        // init = a freshly mounted panel (open/reopen/recreate). It ALWAYS forces a replay
        // of the history, even with the session busy: otherwise reopening a running
        // context would show only the part that arrives after reopening. The deltas in flight
        // append to the repainted history.
        this.justRecreated.delete(bound ?? this.activeTab);
        this.replayTab(bound ?? this.activeTab, true);
        if (bound) this.primeCommands(bound); // loads slash commands without waiting for the first send
        // Recupera o rascunho/ditado espelhado (ex.: tela branca durante o ditado).
        {
          const draft = this.draftByTab.get(bound ?? this.activeTab);
          if (draft) this.post({ kind: 'draftRestore', text: draft }, bound ?? this.activeTab);
        }
        break;
      case 'sendMessage': {
        // Minimum effort gate: resolved NOW from the CLAUDE.md applicable to the session's
        // working folder (it doesn't live in the config — different folders, different
        // values). Below the minimum and without 'force' → asks for confirmation and does NOT send.
        const s = srcSession();
        const cwd = this.workspaceCwd();
        const min = resolveMinEffort(cwd, cwd);
        const eff = this.timingScope(s).effort;
        log(`sendMessage: effort=${eff} minEffort=${min ?? 'none'} force=${!!m.force}`);
        if (
          !m.force &&
          min &&
          eff in EFFORT_RANK &&
          EFFORT_RANK[eff] < (EFFORT_RANK[min] ?? 0)
        ) {
          this.post({ kind: 'effortGate', selected: eff, min }, srcTab);
          break; // blocked: the webview confirms and re-sends with force
        }
        const body = m.text;
        if (!this.tabMeta.get(srcTab)?.title && body.trim()) {
          this.setTabTitle(srcTab, body.replace(/\s+/g, ' ').trim().slice(0, 28));
        }
        // Enviar prompt confirma as escolhas de combo na aba atual: descarta o
        // baseline (there is no pending revert for a new context anymore).
        if (this.comboBaseline?.tab === srcTab) this.comboBaseline = undefined;
        if (this.pendingRestart) {
          // The model/effort/permission change is applied now (restart): the warning goes away.
          this.pendingRestart = false;
          this.sendConfig();
        }
        // Shares the editor selection as context, when the composer asked for it.
        const sel = m.selection ? `${m.selection}\n` : '';
        const text = `${sel}${body}`;
        s.send(text, m.images);
        this.draftByTab.delete(srcTab); // enviado: descarta o rascunho espelhado
        break;
      }
      case 'resolvePaths':
        this.post({
          kind: 'resolvedPath',
          requestId: m.requestId,
          text: m.absPaths.map((p) => this.quoteResolved(p)).join(' '),
        });
        break;
      case 'readClipboardFiles': {
        const paths = readClipboardFiles();
        this.post({
          kind: 'resolvedPath',
          requestId: m.requestId,
          text: paths.map((p) => this.quoteResolved(p)).join(' '),
        });
        break;
      }
      case 'interrupt':
        srcSession().interrupt();
        break;
      case 'newSession':
        this.newSession();
        break;
      case 'permissionDecision':
        srcSession().decide(m.requestId, m.decision, m.message);
        break;
      case 'askResponse':
        srcSession().answer(m.requestId, m.answers);
        break;
      case 'setModel':
        this.snapComboBaseline(srcTab);
        srcSession().setModel(m.model);
        this.saveSessionModel(srcSession()); // persiste por contexto
        this.pendingRestart = true;
        this.sendConfig();
        this.postTaskTimings(srcTab); // novo escopo: recalibra o gauge
        break;
      case 'setEffort':
        this.snapComboBaseline(srcTab);
        srcSession().setEffort(m.effort);
        this.saveSessionModel(srcSession()); // persiste por contexto
        this.pendingRestart = true;
        this.sendConfig();
        this.postTaskTimings(srcTab); // novo escopo: recalibra o gauge
        break;
      case 'setPermissionMode':
        this.snapComboBaseline(srcTab);
        srcSession().setPermission(m.mode);
        this.pendingRestart = true;
        this.sendConfig();
        break;
      case 'setAllowAgents':
        this.snapComboBaseline(srcTab);
        srcSession().setAllowAgents(m.value);
        this.saveSessionModel(srcSession()); // persiste por contexto
        this.pendingRestart = true;
        this.sendConfig();
        break;
      case 'renameSession':
        this.renameSession(m.sessionId, m.name);
        break;
      case 'listSessions':
        this.sendSessions();
        break;
      case 'resumeSession':
        this.openSession(m.sessionId);
        break;
      case 'reloadSession':
        this.reloadSession(m.sessionId);
        break;
      case 'remoteControl':
        this.remoteControl(m.sessionId);
        break;
      case 'deleteSession':
        // Confirmation already done in the webview (elegant modal). Detaches the live tab
        // (releases the handle / prevents recreation) and then deletes the transcript.
        this.detachLiveSessions(m.sessionId);
        deleteSession(this.workspaceCwd(), m.sessionId);
        this.sendSessions();
        break;
      case 'deleteAllSessions':
        // Confirmation already done in the webview. Detaches ALL live tabs before
        // deleting — otherwise the open session holds/recreates its .jsonl and it reappears.
        this.detachLiveSessions(undefined, true);
        deleteAllSessions(this.workspaceCwd());
        this.sendSessions();
        break;
      case 'newTab':
        this.openNewTab();
        break;
      case 'closeTab':
        this.closeTab(m.tabId);
        break;
      case 'switchTab':
        this.setActive(m.tabId);
        break;
      case 'openSettings':
        void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:tootega.tootega-cockpit',
        );
        break;
      case 'openLink':
        void this.openLink(m.href, m.preview);
        break;
      case 'installCli':
        this.installCli();
        break;
      case 'updateCli':
        this.updateCli();
        break;
      case 'recheckCli':
        this.reportCliStatus();
        this.reportAuth();
        break;
      case 'loginCli':
        this.loginCli();
        break;
      case 'logoutCli':
        this.logoutCli();
        break;
      case 'clearContext': {
        // Limpa o contexto do contexto de origem (conversa nova).
        srcSession().clearConversation();
        this.setTabTitle(srcTab, '');
        this.post({ kind: 'history', items: [] }, srcTab);
        break;
      }
      case 'compactContext':
        // Compacta o contexto via slash command do CLI.
        srcSession().send('/compact');
        break;
      case 'setKeepCacheAlive':
        // Liga/desliga o keep-alive de cache do contexto de origem (persistido).
        srcSession().setKeepCacheAlive(m.value);
        break;
      case 'mentionSearch':
        void this.searchMentions(srcTab, m.requestId, m.query);
        break;
      case 'openDiff':
        void this.openNativeDiff(m.tool, m.input);
        break;
      case 'draftChanged':
        // Mirrors the draft/dictation in the host (survives the renderer's death).
        if (m.text) this.draftByTab.set(srcTab, m.text);
        else this.draftByTab.delete(srcTab);
        break;
      case 'setLocale':
        this.post({ kind: 'locale', locale: m.locale });
        break;
      case 'openEditor':
        this.openInEditor();
        break;
      case 'openFolder':
        // Abre a pasta no gerenciador de arquivos do SO (Explorer/Finder).
        void vscode.env.openExternal(vscode.Uri.file(m.path));
        break;
      case 'saveImage':
        void this.saveImage(m.mediaType, m.data);
        break;
      case 'spellCheck':
        void this.handleSpellCheck(srcTab, m.words);
        break;
      case 'spellSuggest':
        void this.handleSpellSuggest(srcTab, m.requestId, m.word);
        break;
      case 'spellAdd': {
        // Persists into the single per-machine file (preserves the existing dictation data).
        this.getSpeller().addWord(m.word);
        const cur = loadDictionary();
        saveDictionary({ ...cur, spellWords: this.getSpeller().userDict() });
        break;
      }
      case 'taskDuration': {
        // Duration sample: aggregated/persisted segmented by (model, effort,
        // verbosity, type) and returns the current scope's averages to the tab's surface.
        const { model, effort, verbosity } = this.timingScope(srcSession());
        recordTaskTiming(model, effort, verbosity, m.type, m.ms);
        this.postTaskTimings(srcTab);
        break;
      }
      case 'rewind':
        this.rewind(srcTab, m.index);
        break;
      case 'voiceStart':
        log('[voice] start requested by webview');
        void this.startVoice(srcTab, m.language);
        break;
      case 'voiceStop':
        log('[voice] webview requested stop');
        this.stopVoice();
        break;
      case 'voiceCorrect':
        void this.correctVoice(srcTab, m.text);
        break;
      case 'exportMd':
        void this.exportConversation(srcTab, m.markdown, m.fileName, m.mode);
        break;
      case 'voiceDictGet':
        this.sendVoiceDict(srcTab);
        break;
      case 'voiceDictSave':
        this.saveVoiceDict(srcTab, m.data.terms, m.data.replacements, m.data.spellWords);
        break;
      case 'pluginsRefresh':
        void this.sendPlugins(m.force);
        break;
      case 'mcpRefresh':
        void this.sendMcp(srcSession());
        break;
      case 'pluginAction':
        void this.runPluginAction(m.action, m.arg, m.scope);
        break;
      case 'fetchUsage':
        void this.sendUsage(); // hot data: fetches account + limits + breakdown on click
        break;
      case 'enableUsageTracking': {
        // Installs the statusline wrapper (captures the real rate_limits on the next render).
        const r = enableUsageTracking(this.memory);
        const msg =
          r === 'ok'
            ? vscode.l10n.t('Usage tracking enabled. Real limits appear after Claude refreshes the statusline.')
            : r === 'unsupported'
              ? vscode.l10n.t('Live usage tracking is only available on Windows for now.')
              : vscode.l10n.t('Could not enable usage tracking (settings.json could not be updated).');
        void vscode.window.showInformationMessage(msg);
        void this.sendUsage(); // reflete o novo estado de tracking no modal
        break;
      }
      case 'credsLoad':
      case 'credsEnrollBegin':
      case 'credsEnrollConfirm':
      case 'credsAdd':
      case 'credsEdit':
      case 'credsUse':
      case 'credsDelete':
        void this.handleCreds(m);
        break;
    }
  }

  /** Credential vault (TOTP 2FA). Every sensitive action validates the code in the host. */
  private async handleCreds(m: WebviewToHost): Promise<void> {
    const tab = this.activeTab;
    const store = this.creds;
    if (!store) {
      this.post({ kind: 'credsError', message: vscode.l10n.t('Secret storage is unavailable.') }, tab);
      return;
    }
    const sendData = async () => {
      this.post(
        { kind: 'credsData', enrolled: await store.isEnrolled(), items: await store.list() },
        tab,
      );
    };
    try {
      switch (m.kind) {
        case 'credsLoad':
          await sendData();
          break;
        case 'credsEnrollBegin': {
          const setup = await store.beginEnroll();
          this.post({ kind: 'credsSetup', ...setup }, tab);
          break;
        }
        case 'credsEnrollConfirm': {
          const ok = await store.confirmEnroll(m.code);
          this.post({ kind: 'credsResult', ok, action: 'enroll' }, tab);
          if (ok) await sendData();
          break;
        }
        case 'credsAdd': {
          const r = await store.add(m.code, {
            name: m.name,
            username: m.username,
            value: m.value,
            note: m.note,
          });
          this.post(
            { kind: 'credsResult', ok: r.ok, action: 'add', message: r.reason },
            tab,
          );
          if (r.ok) await sendData();
          break;
        }
        case 'credsEdit': {
          const r = await store.edit(m.code, m.id, {
            name: m.name,
            username: m.username,
            value: m.value,
            note: m.note,
          });
          this.post({ kind: 'credsResult', ok: r.ok, action: 'edit', message: r.reason }, tab);
          if (r.ok) await sendData();
          break;
        }
        case 'credsUse': {
          const r = await store.use(m.code, m.id);
          if (!r.ok) {
            this.post({ kind: 'credsResult', ok: false, action: 'use', message: r.reason }, tab);
            break;
          }
          const meta = (await store.list()).find((c) => c.id === m.id);
          this.post(
            { kind: 'credsValue', id: m.id, name: meta?.name ?? '', value: r.value ?? '' },
            tab,
          );
          break;
        }
        case 'credsDelete': {
          const r = await store.remove(m.code, m.id);
          this.post({ kind: 'credsResult', ok: r.ok, action: 'delete', message: r.reason }, tab);
          if (r.ok) await sendData();
          break;
        }
      }
    } catch (e) {
      // Never log values/secrets: only the error's generic message.
      this.post({ kind: 'credsError', message: String((e as Error)?.message ?? e) }, tab);
    }
  }

  /** Saves a pasted image (base64) to disk via VSCode's native dialog. */
  private async saveImage(mediaType: string, data: string): Promise<void> {
    const ext = (mediaType.split('/')[1] || 'png').replace('+xml', '').replace('jpeg', 'jpg');
    const def = `image-${Date.now()}.${ext}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.workspaceCwd(), def)),
      filters: { [vscode.l10n.t('Images')]: [ext] },
    });
    if (!uri) return; // the user cancelled
    try {
      fs.writeFileSync(uri.fsPath, Buffer.from(data, 'base64'));
    } catch (e) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Failed to save image: {0}', String(e)),
      );
    }
  }

  // ---- CLI ----

  private cfg() {
    return vscode.workspace.getConfiguration('tootega');
  }

  private resolvedCliPath?: string; // caminho funcional do claude (PATH ou ~/.local/bin)
  private cliAvailable = false;
  private pathFixed = false; // already tried adding ~/.local/bin to the user's PATH

  /** Caminho efetivo do CLI (resolvido) — usado p/ spawn/pesquisa/install. */
  private claudePath(): string {
    return this.resolvedCliPath ?? this.cfg().get<string>('claudePath', 'claude');
  }

  /** Comando p/ rodar o claude num TERMINAL (PATH ou ~/.local/bin fora do PATH).
   *  Without spaces: runs directly (PowerShell and cmd). With spaces: uses the call operator. */
  private claudeCmd(): string {
    const exe = this.claudePath();
    if (!/\s/.test(exe)) return exe;
    return process.platform === 'win32' ? `& "${exe}"` : `"${exe}"`;
  }

  private reportCliStatus(): void {
    const r = CliProcessManager.resolve(this.cfg().get<string>('claudePath', 'claude'));
    this.resolvedCliPath = r.ok ? r.path : undefined;
    this.cliAvailable = r.ok;
    const cockpitVersion = this.cockpitVersion();
    this.post({ kind: 'cliStatus', available: r.ok, version: r.version, error: r.error, cockpitVersion });
    if (r.ok) {
      log(`CLI detected: ${r.version} @ ${r.path}`);
      this.ensureLocalBinOnPath(r.path); // native installer: makes sure ~/.local/bin is in the user's PATH
      // Latest version (npm) in the background → repost with `latest` to flag it as outdated.
      void getLatestCliVersion().then((latest) => {
        if (latest) {
          this.post({ kind: 'cliStatus', available: true, version: r.version, latest, cockpitVersion });
        }
      });
    } else {
      log(`CLI not found: ${r.error}`);
    }
  }

  /**
   * Makes sure the native installer's dir (~/.local/bin) is in the USER's PATH
   * (Windows). Idempotent, User scope only (it doesn't touch the system PATH). It only
   * acts when claude was resolved from that dir and it isn't in the PATH yet.
   */
  private ensureLocalBinOnPath(exePath: string): void {
    if (process.platform !== 'win32' || this.pathFixed) return;
    const bin = path.dirname(exePath);
    if (!/[\\/]\.local[\\/]bin$/i.test(bin)) return; // only the native installer's dir
    if ((process.env.PATH ?? '').toLowerCase().includes(bin.toLowerCase())) return; // already in the PATH
    this.pathFixed = true;
    const ps =
      `$b='${bin.replace(/'/g, "''")}'; ` +
      `$p=[Environment]::GetEnvironmentVariable('Path','User'); if(-not $p){$p=''}; ` +
      `if(($p -split ';') -notcontains $b){ [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';')+';'+$b), 'User') }`;
    try {
      spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
        timeout: 8000,
      });
      log(`Added to user PATH: ${bin}`);
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Added Claude to your PATH: {0}. Restart open terminals to use it.', bin),
      );
    } catch (e) {
      log(`PATH update failed: ${String(e)}`);
    }
  }

  /** Runs `claude update` in a visible terminal (the user follows the progress). */
  private updateCli(): void {
    const term = vscode.window.createTerminal('Claude Update');
    term.show();
    term.sendText(`${this.claudeCmd()} update`);
  }

  /** This extension's version (read from the bundle's package.json). */
  private cockpitVersion(): string | undefined {
    try {
      const p = path.join(this.extensionUri.fsPath, 'package.json');
      return JSON.parse(fs.readFileSync(p, 'utf8')).version as string;
    } catch {
      return undefined;
    }
  }

  /** On activation: when the CLI is missing, it asks (with consent) and installs. */
  async promptInstallIfMissing(): Promise<void> {
    const path = this.cfg().get<string>('claudePath', 'claude');
    if (CliProcessManager.detect(path).ok) return;
    const install = vscode.l10n.t('Install');
    const docs = vscode.l10n.t('Documentation');
    const pick = await vscode.window.showWarningMessage(
      vscode.l10n.t('Claude Code CLI not found. The Cockpit needs it to run.'),
      install,
      docs,
    );
    if (pick === install) this.installCli();
    else if (pick === docs) {
      void vscode.env.openExternal(
        vscode.Uri.parse('https://docs.claude.com/en/docs/claude-code/overview'),
      );
    }
  }

  /** Instala o Claude Code CLI globalmente num terminal integrado (guiado). */
  private installCli(): void {
    const term = vscode.window.createTerminal('Claude Code · install');
    term.show();
    // Official NATIVE installer: it doesn't depend on Node/npm (solves the "npm not
    // recognized" case). It brings Claude Code's own runtime.
    const cmd =
      process.platform === 'win32'
        ? 'powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"'
        : 'curl -fsSL https://claude.ai/install.sh | bash';
    term.sendText(cmd);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Installing Claude Code CLI… it will be detected automatically when ready.'),
    );
    this.pollForCli();
  }

  /** After installing: re-probes the CLI (including ~/.local/bin) until it is found; then refreshes. */
  private pollForCli(): void {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const r = CliProcessManager.resolve(this.cfg().get<string>('claudePath', 'claude'));
      if (r.ok || tries > 60) {
        clearInterval(iv);
        if (r.ok) {
          this.reportCliStatus(); // validates + restores version/latest in the Cockpit
          void vscode.window.showInformationMessage(
            vscode.l10n.t('Claude Code CLI detected: {0}', r.version ?? ''),
          );
        }
      }
    }, 4000);
  }

  /**
   * Login NATIVO do CLI via OAuth no browser (`claude auth login`, default
   * --claudeai = subscription). A dedicated subcommand drives the flow; there is no need
   * to open the REPL or type /login. The Cockpit never touches credentials.
   */
  loginCli(): void {
    const term = vscode.window.createTerminal('Claude Code · login');
    term.show();
    term.sendText(`${this.claudeCmd()} auth login`); // abre OAuth no browser; --console p/ API billing
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Signing in via your browser. Approve the request, then click "Re-check".'),
    );
    this.scheduleAuthRefresh(); // the flow is asynchronous in the terminal: re-check right after
  }

  /** Native CLI logout (`claude auth logout`) in a terminal. The Cockpit never touches credentials. */
  logoutCli(): void {
    const term = vscode.window.createTerminal('Claude Code · logout');
    term.show();
    term.sendText(`${this.claudeCmd()} auth logout`);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Signing out in the terminal. Use Sign in when you want to log back in.'),
    );
    this.scheduleAuthRefresh();
  }

  /** Fetches the login state and pushes it to the webview (shows Sign in OR Sign out). */
  reportAuth(): void {
    resetAccountKey(); // login/logout may have changed the account → re-resolve the dictionary
    void resolveAccountKey(this.claudePath());
    void fetchAuthStatus(this.claudePath()).then((a) => this.post({ kind: 'auth', loggedIn: a.loggedIn }));
  }

  /** Re-checa o login algumas vezes (o fluxo de login/logout roda no terminal). */
  private scheduleAuthRefresh(): void {
    for (const ms of [3000, 8000, 15000]) setTimeout(() => this.reportAuth(), ms);
  }

  // ---- util ----

  private post(msg: HostToWebview, tab?: string): void {
    const payload = tab ? { ...msg, tab } : msg;
    // The hub receives everything (it mirrors the global state + the active session).
    this.trySend(this.hubView?.webview, payload);
    if (tab) {
      // Message from one session: only that session's panel.
      this.trySend(this.panels.get(tab)?.webview, payload);
    } else {
      // Global (config/cli/tabs/locale): every chat panel.
      for (const p of this.panels.values()) this.trySend(p.webview, payload);
    }
  }

  private trySend(w: vscode.Webview | undefined, payload: unknown): void {
    if (!w) return;
    try {
      void w.postMessage(payload);
    } catch {
      /* webview descartado */
    }
  }

  private getHtml(webview: vscode.Webview, mode: 'chat' | 'hub' = 'chat', sessionTab?: string): string {
    const base = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview');
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.js'));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(base, 'main.css'));
    // The extension icon for the activity indicator (img in the webview). media/ isn't
    // in localResourceRoots by default — included alongside dist/webview.
    const iconUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'icon.png'));
    const nonce = makeNonce();
    const csp = [
      `default-src 'none'`,
      `img-src ${webview.cspSource} data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="${resolveLocale()}">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Tootega Cockpit</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">window.__TOOTEGA_VIEW__ = ${JSON.stringify(mode)}; window.__TOOTEGA_SESSION__ = ${JSON.stringify(sessionTab ?? '')}; window.__TOOTEGA_REGION__ = ${JSON.stringify(osRegionLocale())}; window.__TOOTEGA_ICON__ = ${JSON.stringify(iconUri.toString())};</script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }

  /** Provider da view na Activity Bar (hub). Mesma bundle, modo 'hub'. */
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview'),
        vscode.Uri.joinPath(this.extensionUri, 'media'),
      ],
    };
    view.webview.html = this.getHtml(view.webview, 'hub');
    this.hubView = view;
    this.lastBeat.set(HUB_SURFACE, Date.now());
    dlog('watchdog', 'hub-view montado (resolveWebviewView)');
    const sub = view.webview.onDidReceiveMessage((m: WebviewToHost) =>
      this.onWebviewMessage(m, view.webview),
    );
    const visSub = view.onDidChangeVisibility(() => {
      if (view.visible) this.lastBeat.set(HUB_SURFACE, Date.now()); // shown again: re-arms the clock
    });
    view.onDidDispose(() => {
      sub.dispose();
      visSub.dispose();
      this.lastBeat.delete(HUB_SURFACE);
      this.reloadGuard.delete(HUB_SURFACE);
      if (this.hubView === view) this.hubView = undefined;
    });
  }
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean)));
}

// Instruction for the "Generate with AI" option: it produces an organized, coherent document
// from the conversation record. It focuses on the reasoning/decisions and the outcome;
// it omits technical noise. It keeps the conversation's language.
const DOC_PROMPT = [
  'You are a technical editor. From the conversation record below (between a developer and an AI assistant),',
  'write a DOCUMENT in Markdown — organized, high level and coherent — telling the story of the work:',
  'what was asked, what was thought and decided, what was done, WHY and HOW, and the final outcome.',
  'Prioritize the reasoning, the decisions and the motivation. OMIT technical noise (commands, tool output, raw diffs).',
  'Structure it with headings, sections and lists when that helps reading. Be faithful to the content — do not invent.',
  'Write in the SAME language that predominates in the conversation.',
  'Answer ONLY with the document Markdown — no comments, no code fence around the whole thing.',
].join(' ');

/** Unique path: when the file already exists, it inserts -2, -3… before the extension. */
function uniqueFilePath(full: string): string {
  if (!safeExistsSync(full)) return full;
  const dir = path.dirname(full);
  const ext = path.extname(full);
  const base = path.basename(full, ext);
  for (let i = 2; i < 1000; i++) {
    const cand = path.join(dir, `${base}-${i}${ext}`);
    if (!safeExistsSync(cand)) return cand;
  }
  return full;
}

function safeExistsSync(p: string): boolean {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
}

/** Extrai o texto do resultado do `claude -p --output-format json`. Tolerante. */
function extractCliResult(out: string): string | undefined {
  const trimmed = out.trim();
  if (!trimmed) return undefined;
  try {
    const j = JSON.parse(trimmed);
    const arr = Array.isArray(j) ? j : [j];
    for (const o of arr) {
      if (typeof o?.result === 'string' && o.result.trim()) return stripWrappingFence(o.result.trim());
    }
  } catch {
    /* non-JSON: uses the raw text as a fallback */
  }
  return stripWrappingFence(trimmed);
}

/** Removes a code fence wrapping the whole document (```markdown … ```). */
function stripWrappingFence(s: string): string {
  const m = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return m ? m[1] : s;
}

/** LimitWindow (interno) -> UsageBucket (protocolo do modal Usage). */
function toBucket(w?: LimitWindow): UsageBucket | undefined {
  if (!w) return undefined;
  return { usedPct: w.usedPct, resetsAt: w.resetsAt, tokens: w.tokens, usd: w.usd };
}

// The OS REGION locale (date/time format), NOT the UI language.
// On Windows VS Code forces Node's locale to the display language (en),
// so Node's Intl is useless — we read the regional culture via PowerShell
// `(Get-Culture).Name` (= "pt-BR", the same the taskbar uses). Memoized.
let cachedRegion: string | undefined;
function osRegionLocale(): string {
  if (cachedRegion) return cachedRegion;
  let loc = '';
  if (process.platform === 'win32') {
    try {
      const r = spawnSync(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-Command', '[System.Globalization.CultureInfo]::CurrentCulture.Name'],
        { encoding: 'utf8', timeout: 4000, windowsHide: true },
      );
      loc = (r.stdout || '').trim();
    } catch {
      /* fallback abaixo */
    }
  }
  if (!loc) {
    try {
      loc = new Intl.DateTimeFormat().resolvedOptions().locale;
    } catch {
      loc = 'en';
    }
  }
  cachedRegion = loc || 'en';
  return cachedRegion;
}

function makeNonce(): string {
  let t = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let i = 0; i < 32; i++) t += chars.charAt(Math.floor(Math.random() * chars.length));
  return t;
}
