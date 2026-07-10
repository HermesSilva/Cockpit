// Provider do webview: ponte entre o CLI (motor) e a UI React.
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
import {
  ensureDaseMcpConfig,
  readDaseEndpoint,
  registerDaseInClaudeCli,
  KNOWN_DASE_EXT_IDS,
} from '../cli/DaseMcp';
import { resolveLocale } from '../i18n/host';
import { researchCommands } from '../cli/SlashCommandResearch';
import { getLatestCliVersion } from '../cli/CliVersion';
import { log, dlog } from '../util/logger';

// Aliases sempre válidos (resolvem para o mais recente da conta). 'default' = sem flag.
// O CLI não expõe lista de modelos; a UI complementa com o modelo ativo descoberto
// ao vivo (evento init) e com entrada livre ("Custom…"). Effort é enum fixo do CLI.
// Lista plana (sem agrupar). Modelos com variante 1M aparecem só como [1m]
// (a versão menor de 200K é omitida). O CLI valida no spawn.
const MODEL_LIST = [
  'default',
  'claude-opus-4-8[1m]',
  'claude-opus-4-7[1m]',
  'claude-opus-4-6',
  'claude-sonnet-4-6[1m]',
  'claude-haiku-4-5',
  'claude-opus-4-5',
  'claude-sonnet-4-5',
  'claude-fable-5',
];
// Versões de 200K que têm variante 1M na lista — filtradas da descoberta.
const BASE_OF_1M = new Set(['claude-opus-4-8', 'claude-opus-4-7', 'claude-sonnet-4-6']);
const EFFORT_OPTIONS = ['default', 'low', 'medium', 'high', 'xhigh', 'max'];
const PERMISSION_MODES = ['default', 'plan', 'acceptEdits', 'auto', 'dontAsk', 'bypassPermissions'];
// Cache da statusline mais velho que isto não é confiável como % "real" (engana).
const USAGE_CACHE_MAX_AGE_MS = 6 * 3600_000; // 6h

// Tag de endereçamento ao DASE no início da mensagem: "@DASE:" / "@dase " etc.
// Liga a integração (sticky) e é removido do prompt enviado ao agente.
const DASE_TAG = /^\s*@dase\b\s*:?\s*/i;
// Instrução curta injetada no prompt quando o @DASE: é usado (orienta às tools).
// O endpoint do DASE só aparece alguns instantes depois do activate (o servidor
// MCP sobe em background). Tentativas do registro no .claude.json.
const DASE_REGISTER_TRIES = 10;
const DASE_REGISTER_DELAY_MS = 500;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const DASE_STEER =
  'Use the DASE ORM Designer MCP tools (dase_*) to carry out this request. ' +
  'If unsure of the current model, call dase_list_documents / dase_get_model first.';

// Preferências por sessão persistidas em globalState (override da aba).
interface SessionPrefs {
  model?: string;
  effort?: string;
  allowAgents?: boolean;
  daseEnabled?: boolean;
}

// --- Watchdog de renderização ---
// DESATIVADO (2026-06-29): suspeito de causar tempestade de recreate de painel
// (dispose+create webview nativo + replayTab de timeline gigante em rajada) que
// precedeu um crash nativo do extension host (0xC0000005). Mantido em código p/
// avaliação de uso — religar trocando esta flag p/ true. Botão de reload manual
// (reloadActivePanel) segue funcionando independente disto.
const WATCHDOG_ENABLED = false;
const HEARTBEAT_DEAD_MS = 30_000; // sem pulso por isto = render presumido morto
const WATCHDOG_TICK_MS = 10_000; // frequência de checagem das superfícies visíveis
const RELOAD_COOLDOWN_MS = 60_000; // não recarrega a mesma superfície antes disto
const RELOAD_MAX_TRIES = 2; // tentativas antes de desistir (evita loop de reload)
const HUB_SURFACE = '__hub__'; // chave da superfície do hub no mapa de pulsos
const API_KEY_SECRET = 'cockpit.apiKey'; // chave da API key no SecretStorage (keychain do SO)

export class ChatViewProvider implements vscode.WebviewViewProvider {
  // O Cockpit vive como aba no editor (WebviewPanel) + hub na Activity Bar
  // (WebviewView). `surfaces` guarda os webviews ativos (broadcast) — o estado
  // vive no host e é replicado para todas as superfícies.
  // Cada contexto (sessão) abre como WebviewPanel próprio no editor.
  private panels = new Map<string, vscode.WebviewPanel>();
  private webviewSession = new Map<vscode.Webview, string>();
  private hubView?: vscode.WebviewView;

  // Watchdog de render: o processo do webview (renderer) pode cair (bug GPU do
  // VSCode) — a tela fica branca mas o host segue vivo (stream/stats/timeline
  // continuam). Cada superfície bate um pulso periódico; se uma VISÍVEL para de
  // bater além do limite, força reload do HTML. NUNCA toca no CLI/contexto.
  private lastBeat = new Map<string, number>(); // surfaceKey -> epoch ms do último pulso
  private reloadGuard = new Map<string, { at: number; count: number }>(); // cooldown/cap por superfície
  private justRecreated = new Set<string>(); // tabIds recriados pelo watchdog: replay forçado no init
  private watchdog?: ReturnType<typeof setInterval>;
  private watchdogDisabledLogged = false; // loga só 1x que o watchdog está desativado
  private windowStateSub?: vscode.Disposable; // foco da janela (rearma pulso ao voltar)

  // Abas: cada uma é uma Session (runtime de CLI + stats + streaming) paralela.
  private sessions = new Map<string, Session>();
  // Keep-alive de cache: renova em background os contextos marcados (até fechados).
  private cacheKeeper = new CacheKeeper({
    claudePath: () => this.claudePath(),
    pingOpen: (id) => this.pingOpenSession(id),
  });
  private tabMeta = new Map<string, { title: string; status: 'idle' | 'busy' | 'error' }>();
  // Rascunho/ditado espelhado por aba (anti-perda): vive no HOST, que sobrevive à
  // morte do renderer (tela branca). Re-injetado no webview ao (re)montar.
  private draftByTab = new Map<string, string>();
  private tabOrder: string[] = [];
  private activeTab = '';
  // Última sessão cujo painel foi fechado pelo usuário (p/ "reabrir fechada").
  private lastClosed?: { tabId: string; sessionId?: string };
  // Ref da seleção ativa do editor (@file#a-b) p/ compartilhar via composer.
  private lastSelRef?: string;
  private selListener?: vscode.Disposable;
  private tabSeq = 0;

  // Overrides de sessão (em memória — não alteram as settings globais do usuário).
  private modelOverride?: string;
  private effortOverride?: string;
  private permissionOverride?: string;
  // Baseline dos combos da aba ativa antes de o usuário mexer neles. Se, após
  // mexer, ele criar um NOVO contexto (em vez de enviar um prompt), a escolha era
  // para o novo contexto: o novo nasce com os valores escolhidos e a aba anterior
  // volta a este baseline. Enviar um prompt confirma a escolha na aba atual e
  // limpa o baseline (comportamento de sempre). Chave = aba que estava sendo editada.
  private comboBaseline?: {
    tab: string;
    model?: string;
    effort?: string;
    permission?: string;
    allowAgents?: boolean;
  };
  private statusBar?: vscode.StatusBarItem;
  // Botão de reload na status bar: sempre visível enquanto há painel do Cockpit
  // aberto. Recupera o webview cinza/morto (mesma ação do watchdog) — funciona no
  // host, então independe do renderer e das configs de ações do editor.
  private reloadBar?: vscode.StatusBarItem;
  // Modelos descobertos ao vivo (modelo ativo do init + /v1/models). Valor =
  // janela de contexto real (max_input_tokens) ou undefined se a conta não expõe.
  private discoveredModels = new Map<string, number | undefined>();
  private discoveryTried = false;
  // Preço por modelo (das docs de pricing; cache 1x/dia). Vazio até carregar.
  private pricing: PricingMap = {};
  private pricingTried = false;

  // Defaults do Claude Code (effort do settings; model do settings ou init cacheado).
  private defaults: { model?: string; effort?: string } = {};
  private observedDefaultModel?: string;
  // model/effort/permission mudou e ainda não reiniciou a sessão (avisa na UI).
  private pendingRestart = false;
  // Sessão de ditado por voz ativa (uma de cada vez; o mic é um só).
  private voice?: VoiceSession;
  private voiceCapture?: AudioCapture;
  private voiceDict: VoiceDict = { terms: [], replacements: [] }; // dicionário ativo do ditado

  // Corretor ortográfico (hunspell-asm no host). Lazy: instancia no 1º uso.
  private speller?: Speller;

  // Cofre de credenciais protegido por TOTP (SecretStorage). Ausente se o host não
  // forneceu o SecretStorage (ex.: testes).
  private creds?: CredentialsStore;

  // SecretStorage do host (keychain do SO). Guarda a API key de descoberta de
  // modelos cifrada — nunca em texto plano nas settings. Ausente em testes.
  private readonly secrets?: vscode.SecretStorage;

  // Diretório de globalStorage da própria extensão. Usado p/ (a) localizar o
  // a pasta *.dase irmã (descoberta do MCP) e (b) gravar o arquivo --mcp-config.
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
    // Botão de reload (status bar, direita). Escondido até abrir um contexto.
    this.reloadBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    this.reloadBar.text = '$(refresh)';
    this.reloadBar.tooltip = vscode.l10n.t('Reload Cockpit view (fix gray/blank panel)');
    this.reloadBar.command = 'tootega.reloadView';
    this.updateReloadBar();
    setInternalModel(this.cfg().get<string>('internalModel', '')); // modelo das chamadas internas
    this.ensureDaseActivated(); // sobe o servidor MCP do DASE cedo (endpoint pronto antes do uso)
    void resolveAccountKey(this.claudePath()); // resolve a conta cedo (chave do dicionário de ditado)
    // Seleção ativa do editor → ref @file#a-b compartilhável no composer.
    this.selListener = vscode.window.onDidChangeTextEditorSelection((e) => this.onSelectionChanged(e));
    // Ping automático de keep-alive DESLIGADO: qualquer refresh via --resume grava
    // um turno real no .jsonl (polui a conversa, gasta tokens e chega ao agente).
    // O medidor de vida do cache no painel continua (independe do keeper).
    void this.cacheKeeper; // mantido p/ futura reimplementação limpa (sem poluir o transcript)
    // Telemetria OTEL (opt-in, padrão OFF): liga o receiver local que coleta LOC/
    // sessões/commits da CLI. Ao ligar, injeta as env de export antes do 1º spawn.
    if (this.cfg().get<boolean>('otel.enabled', false)) {
      try {
        this.otel.start();
      } catch (e) {
        log(`[otel] start falhou: ${String(e)}`);
      }
    }
  }

  // Receiver OTLP local (opt-in). Sempre instanciado; só escuta se ligado.
  private readonly otel = new OtelReceiver();

  /** Encerra recursos de background (chamado no deactivate da extensão). */
  dispose(): void {
    this.cacheKeeper.stop();
    this.otel.stop();
    if (this.watchdog) clearInterval(this.watchdog);
    this.windowStateSub?.dispose();
    this.reloadBar?.dispose();
    this.selListener?.dispose();
    this.diffProviderReg?.dispose();
  }

  /** Atualiza o ref da seleção (@rel#a-b) e avisa o composer. Vazio = sem seleção. */
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

  /** Mostra o botão de reload enquanto houver ao menos um painel do Cockpit aberto. */
  private updateReloadBar(): void {
    if (!this.reloadBar) return;
    if (this.panels.size > 0) this.reloadBar.show();
    else this.reloadBar.hide();
  }

  /**
   * Keep-alive de um contexto que está ABERTO numa aba: pinga pelo CLI vivo da
   * sessão (sem --resume paralelo, que conflita). 'busy' = turno em andamento já
   * mantém quente; 'pinged' = ping enviado; 'none' = não há sessão aberta (o
   * keeper então usa o spawn efêmero p/ contexto fechado).
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

  // ---- Abas / sessões paralelas ----

  /** Sessão da aba ativa (cria a primeira aba se ainda não houver). */
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
        void this.refreshUsage(); // busca uso fresco ao fim de cada interação (sem cache persistido)
        this.sendSessions(); // sessão nova/atualizada já está no disco — reflete na lista de contextos
      },
      onInteraction: () => {
        // Garante o contexto visível (cria/foca seu painel) p/ permissão/pergunta.
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
        daseModel: this.cfg().get<string>('dase.model', '') || 'default',
      }),
      mcpConfigPath: () => this.daseMcpConfigPath(),
      askLanguage: () => this.askLanguageCode(),
    };
  }

  /** Cria uma aba nova e sua Session; retorna o id. Vira a aba ativa. */
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
    this.sessions.get(tabId)!.sendTimeline(); // timeline/compactações da aba ativa
    this.replayTab(tabId); // garante o histórico em todas as superfícies
  }

  // Captura o baseline dos combos de `tab` (uma vez por edição). Chamado antes de
  // aplicar qualquer mudança de combo, p/ poder reverter se o usuário optar por
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
    // O novo contexto herda os valores atualmente escolhidos nos combos da aba ativa.
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
    // Se os combos foram editados sobre a aba ativa, a escolha era p/ o novo
    // contexto: reverte a aba anterior ao baseline (não a muta indevidamente).
    if (prev && this.comboBaseline?.tab === prevTab) {
      prev.modelOverride = this.comboBaseline.model;
      prev.effortOverride = this.comboBaseline.effort;
      prev.permissionOverride = this.comboBaseline.permission;
      prev.allowAgentsOverride = this.comboBaseline.allowAgents;
      this.saveSessionModel(prev);
      this.pendingRestart = false; // aba anterior voltou ao original: sem restart pendente
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

  /** Lado global do init de uma sessão: descoberta de modelo + cache do default. */
  private onSessionInit(model?: string, slashCommands?: string[], tabId?: string): void {
    void this.researchSlash(slashCommands);
    // Modelo REAL resolvido pelo CLI: o escopo de tempos pode ter mudado
    // ('default' -> id real). Recalibra o gauge com as médias do novo escopo.
    if (tabId) {
      this.postTaskTimings(tabId);
      // sessionId agora existe: persiste o override (se houver) desta sessão nova.
      const s = this.sessions.get(tabId);
      if (s) this.saveSessionModel(s);
    }
    if (typeof model === 'string' && model) {
      if (!this.discoveredModels.has(model)) {
        this.discoveredModels.set(model, undefined); // contexto vem do /v1/models
        this.sendConfig();
      }
      const settingsModel = this.cfg().get<string>('model', '') || 'default';
      if (settingsModel === 'default' && !this.defaults.model && this.observedDefaultModel !== model) {
        this.observedDefaultModel = model;
        void this.memory.update('defaultModel', model);
        this.sendConfig();
      }
    }
    // Sessão recém-iniciada já tem transcript no disco: atualiza a grade de contextos.
    this.sendSessions();
  }

  private lastLimits?: { fiveHour?: LimitWindow; sevenDay?: LimitWindow };
  private lastLimitsSource: 'real' | 'estimate' = 'estimate';
  // Origem detalhada p/ o modal Usage (api > statusline > estimate).
  private lastUsageSource: 'api' | 'statusline' | 'estimate' = 'estimate';
  private lastScoped?: ScopedBucket[];
  private usageStarted = false;

  /** Inicia (uma vez) o cálculo periódico do uso local (5h/7d). */
  private startUsageTimer(): void {
    if (this.usageStarted) return;
    this.usageStarted = true;
    void this.refreshUsage();
    setInterval(() => void this.refreshUsage(), 120_000);
  }

  private async refreshUsage(force = false): Promise<void> {
    try {
      // 0) Uso REAL da conta via API OAuth (read-only, sem gasto de token). É a
      // mesma fonte do /usage do CLI — bate exatamente. Melhor fonte.
      const api = await fetchAccountUsage(force);
      if (api && (api.fiveHour || api.sevenDay)) {
        this.lastLimits = { fiveHour: api.fiveHour, sevenDay: api.sevenDay };
        this.lastScoped = api.weeklyScoped;
        this.lastLimitsSource = 'real';
        this.lastUsageSource = 'api';
      } else {
        // 1) Cache da statusline (rate_limits). Só confia se FRESCO.
        const real = readUsageCache();
        const fresh = real != null && (real.ageMs == null || real.ageMs < USAGE_CACHE_MAX_AGE_MS);
        if (real && fresh && (real.fiveHour || real.sevenDay)) {
          this.lastLimits = { fiveHour: real.fiveHour, sevenDay: real.sevenDay };
          this.lastScoped = real.weeklyScoped;
          this.lastLimitsSource = 'real';
          this.lastUsageSource = 'statusline';
        } else {
          // 2) Fallback: uso local por tokens (sem %, só USD/tokens acumulados).
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

  /** Abre (ou foca) o contexto ativo como WebviewPanel no editor. */
  openInEditor(): void {
    const id = this.activeTab && this.sessions.has(this.activeTab) ? this.activeTab : this.createTab();
    this.openSessionPanel(id);
  }

  /** Abre (ou foca) o painel de uma sessão. Cada contexto = um WebviewPanel. */
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
    // Tabs do editor não mascaram o ícone (render cru) -> versão colorida.
    panel.iconPath = vscode.Uri.joinPath(this.extensionUri, 'media', 'icon-color.svg');
    this.bindPanel(panel, tabId);
    this.setActive(tabId);
  }

  /** Liga um WebviewPanel a uma sessão específica. */
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
      // Context key próprio p/ o botão de refresh no title bar (mais confiável que
      // activeWebviewPanelId p/ webview panels). True quando ESTE painel está ativo.
      void vscode.commands.executeCommand('setContext', 'tootega.cockpitActive', panel.active);
      // Reexibido: timers ficaram throttled enquanto oculto — rearma o relógio p/
      // o watchdog não confundir o gap com render morto.
      if (panel.visible) this.lastBeat.set(tabId, Date.now());
    });
    // Painel recém-criado nasce ativo: arma o context key já.
    void vscode.commands.executeCommand('setContext', 'tootega.cockpitActive', true);
    this.lastBeat.set(tabId, Date.now()); // arma já: painel recém-criado ainda não bateu
    // Ref capturada AGORA: ler `panel.webview`/`panel.active` DEPOIS do dispose
    // lança "Webview is disposed" (getter assertNotDisposed) e aborta o resto do
    // handler — vazando os listeners e os mapas de pulso. Captura evita o getter.
    const wv = panel.webview;
    panel.onDidDispose(() => {
      // Fechamento genuíno pelo usuário (não recreate do watchdog): o mapa ainda
      // aponta p/ ESTE painel. Guarda p/ "reabrir sessão fechada".
      if (this.panels.get(tabId) === panel) {
        const s = this.sessions.get(tabId);
        this.lastClosed = { tabId, sessionId: s?.sessionId ?? s?.resumeId };
      }
      this.panels.delete(tabId);
      this.webviewSession.delete(wv);
      this.lastBeat.delete(tabId);
      this.reloadGuard.delete(tabId);
      this.updateReloadBar();
      // Não lê panel.active (getter lança pós-dispose): zera o context key direto.
      void vscode.commands.executeCommand('setContext', 'tootega.cockpitActive', false);
      sub.dispose();
      vs.dispose();
    });
  }

  /** Chave de superfície p/ o watchdog: tabId do painel, ou HUB_SURFACE do hub. */
  private surfaceKey(webview?: vscode.Webview): string | undefined {
    if (!webview) return undefined;
    const tab = this.webviewSession.get(webview);
    if (tab) return tab;
    if (webview === this.hubView?.webview) return HUB_SURFACE;
    return undefined;
  }

  /** Liga o checador periódico de render (idempotente). */
  private startWatchdog(): void {
    if (!WATCHDOG_ENABLED) {
      if (!this.watchdogDisabledLogged) {
        this.watchdogDisabledLogged = true;
        log('Watchdog de renderização DESATIVADO (avaliação de uso) — sem reload automático de webview');
      }
      return;
    }
    if (this.watchdog) return;
    this.watchdog = setInterval(() => this.checkSurfaces(), WATCHDOG_TICK_MS);
    // Foco da janela: o Chromium CONGELA os timers do renderer quando a janela do
    // VSCode vai p/ segundo plano (background throttling) — o heartbeat para mesmo
    // com o painel "visible" e SEM disparar onDidChangeViewState. Ao reganhar foco,
    // rearma o relógio de pulso de todas as superfícies p/ o watchdog não confundir
    // esse gap com render morto e fechar/recarregar a aba (e o Hub) indevidamente.
    this.windowStateSub ??= vscode.window.onDidChangeWindowState((s) => {
      if (s.focused) this.rearmAllBeats();
    });
  }

  /** Rearma o relógio de pulso de todas as superfícies visíveis (agora). */
  private rearmAllBeats(): void {
    const now = Date.now();
    for (const [tabId, panel] of this.panels) if (panel.visible) this.lastBeat.set(tabId, now);
    if (this.hubView?.visible) this.lastBeat.set(HUB_SURFACE, now);
    dlog('watchdog', 'janela reganhou foco — pulsos rearmados');
  }

  /** Varre superfícies VISÍVEIS; oculta é throttled/descartada, não conta. */
  private checkSurfaces(): void {
    // Janela em segundo plano: os timers do renderer estão congelados (não é morte
    // real). Não recarrega nada — só avalia liveness com a janela em foco.
    if (!vscode.window.state.focused) {
      dlog('watchdog', 'tick ignorado: janela sem foco');
      return;
    }
    const now = Date.now();
    for (const [tabId, panel] of this.panels) {
      if (panel.visible) this.maybeReload(tabId, panel.webview, now);
    }
    if (this.hubView?.visible) this.maybeReload(HUB_SURFACE, this.hubView.webview, now);
  }

  /**
   * Render presumido morto (pulso parado além do limite) → força reload do HTML:
   * remonta o React, que reenvia 'init' e o host repinta via replayTab. O custo do
   * replay (timeline grande) só é pago AQUI, no recovery — jamais no caminho são.
   * Cooldown + cap evitam loop caso o reload não reviva (ambiente quebrado).
   */
  private maybeReload(key: string, webview: vscode.Webview, now: number): void {
    const beat = this.lastBeat.get(key);
    if (beat === undefined) {
      this.lastBeat.set(key, now); // 1ª observação: arma o relógio, não age
      return;
    }
    const gap = now - beat;
    dlog('watchdog', `${key}: ${gap}ms desde o último pulso (limite ${HEARTBEAT_DEAD_MS}ms)`);
    if (gap < HEARTBEAT_DEAD_MS) return; // vivo
    const g = this.reloadGuard.get(key) ?? { at: 0, count: 0 };
    if (now - g.at < RELOAD_COOLDOWN_MS) {
      dlog('watchdog', `${key}: pulso parado (${gap}ms) mas em cooldown — não recarrega`);
      return; // cooldown ativo
    }
    if (g.count >= RELOAD_MAX_TRIES) {
      dlog('watchdog', `${key}: pulso parado (${gap}ms) mas atingiu o cap de tentativas — desiste`);
      return; // já tentou demais: desiste (sem loop)
    }
    // Sempre logado (não só debug): este é o ÚNICO ponto que reinicia uma webview.
    log(`Watchdog: pulso de '${key}' parado há ${gap}ms (foco=${vscode.window.state.focused}) — vai recarregar`);
    try {
      // Renderer crashado IGNORA reatribuir webview.html — só recriar o painel
      // respawna o processo. Hub é WebviewView (VSCode dono): só resta o html.
      if (key === HUB_SURFACE) {
        webview.html = this.getHtml(webview, 'hub');
      } else if (!this.recreatePanel(key)) {
        webview.html = this.getHtml(webview, 'chat', key); // fallback se recriar falhar
      }
    } catch {
      return;
    }
    this.reloadGuard.set(key, { at: now, count: g.count + 1 }); // depois do recreate (sobrevive ao dispose)
    this.lastBeat.set(key, now); // janela de graça p/ remontar e voltar a bater
    log(`Webview render dead (${key}) — recovered (try ${g.count + 1})`);
  }

  /**
   * Recria o WebviewPanel de uma aba: dispose do velho + createWebviewPanel novo,
   * mantendo o MESMO tabId/sessão (CLI e contexto intactos). Único caminho que
   * respawna um renderer morto. O painel novo manda 'init' → replayTab repinta.
   */
  private recreatePanel(tabId: string): boolean {
    const old = this.panels.get(tabId);
    if (!old) return false;
    const col = old.viewColumn ?? vscode.ViewColumn.Active;
    const title = this.tabMeta.get(tabId)?.title || 'Tootega Cockpit';
    // Desvincula antes de descartar: o onDidDispose do velho apagaria os registros
    // do tabId que passarão a pertencer ao painel novo.
    this.panels.delete(tabId);
    this.webviewSession.delete(old.webview);
    try {
      old.dispose();
    } catch {
      /* já morto */
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
    this.justRecreated.add(tabId); // o init do painel novo deve forçar replay mesmo se busy
    log(`recreatePanel: painel da aba '${tabId}' recriado (renderer respawnado)`);
    this.bindPanel(panel, tabId);
    return true;
  }

  /**
   * Reload manual (botão de refresh no title bar da aba): força o mesmo recovery
   * do watchdog na aba ativa, mas IGNORANDO o cooldown/cap — é pedido explícito do
   * usuário p/ ressuscitar um painel cinza/branco (renderer morto). Roda no host,
   * então funciona mesmo com o renderer travado.
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
    this.reloadGuard.delete(tabId); // zera o guard: ação do usuário, sem cap
    try {
      if (!this.recreatePanel(tabId)) {
        const p = this.panels.get(tabId);
        if (p) p.webview.html = this.getHtml(p.webview, 'chat', tabId);
      }
    } catch {
      return;
    }
    this.lastBeat.set(tabId, Date.now()); // janela de graça p/ remontar
    log(`Webview manual reload (${tabId})`);
  }

  /** Painel restaurado pelo serializer não tem vínculo de sessão: descarta. */
  attachPanel(panel: vscode.WebviewPanel): void {
    try {
      panel.dispose();
    } catch {
      /* noop */
    }
  }

  // ---- Comandos expostos à extensão ----

  newSession(): void {
    this.openNewTab();
  }

  private workspaceCwd(): string {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  }

  /** Caminho relativo ao cwd se estiver dentro dele; senão absoluto. */
  private resolvePath(absPathRaw: string): string {
    const absPath = absPathRaw.normalize('NFC');
    const cwd = this.workspaceCwd().normalize('NFC');
    const rel = path.relative(cwd, absPath);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
      return rel.split(path.sep).join('/'); // dentro do contexto -> relativo
    }
    return absPath; // fora do contexto -> absoluto
  }

  /** Caminho resolvido entre aspas (lida com espaços). */
  private quoteResolved(absPath: string): string {
    return `"${this.resolvePath(absPath)}"`;
  }

  /** Abre um link do chat: URL externa ou arquivo (relativo ao cwd / absoluto / por nome). */
  private async openLink(href: string, preview = false): Promise<void> {
    if (!href) return;
    if (/^https?:\/\//i.test(href)) {
      void vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    let raw = href;
    // âncora de linha (#L12)
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
      /* já decodificado */
    }
    raw = raw.normalize('NFC');

    const abs = path.isAbsolute(raw) ? raw : path.join(this.workspaceCwd(), raw);
    let uri = vscode.Uri.file(abs);

    if (!fs.existsSync(abs)) {
      // fallback: procura pelo nome do arquivo no workspace
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

    // Modo preview (link "View"): markdown -> preview nativo; demais -> abridor padrão.
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
   * "Esquenta" a sessão de uma aba de chat: sobe o processo do CLI já no abrir,
   * para que o evento `init` traga os slash commands antes do 1º envio. Só age se
   * ainda não há processo/comandos e o CLI existe (evita spawn inútil/erro).
   */
  private primeCommands(tabId: string): void {
    const s = this.sessions.get(tabId);
    if (!s || s.cli || s.busy || s.slashCommands.length) return;
    if (!this.cliAvailable) return; // resolvido em reportCliStatus (roda antes no init)
    try {
      s.ensureCli();
    } catch (e) {
      log(`primeCommands falhou: ${String(e)}`);
    }
  }

  /**
   * Enriquece os slash commands via IA (cache global ~/.claude/tootega) e envia os
   * metadados (categoria/hint/detalhe) ao webview. Best-effort: só pesquisa os que
   * faltam no cache; falha não quebra a UI. Idioma = locale do Cockpit.
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
    // Sessões VIVAS (abas em memória) podem ainda não ter transcript listável no
    // disco na 1ª resposta do CLI. Mescla-as para o hub refletir contextos em
    // execução de imediato, sem esperar o turno terminar.
    // Só mescla abas OCUPADAS (rodando): uma aba idle com conteúdo já vem de
    // listSessions (o .jsonl existe no disco); uma aba idle e vazia NÃO deve
    // reaparecer — senão vira "fantasma" que ressurge após apagar tudo.
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

  /** Lista plugins + marketplaces e envia ao modal. force = re-valida URLs (Haiku). */
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

  /** Executa uma ação de plugin (install/uninstall/…); ao fim, recarrega a lista. */
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

  /** Reúne conta + limites reais (quentes) e envia ao webview (botão Usage). */
  private async sendUsage(): Promise<void> {
    try {
      await this.refreshUsage(true); // força API fresca (dado quente ao clicar)
      const account = await fetchAuthStatus(this.claudePath());
      const scoped = this.lastScoped ?? readUsageCache()?.weeklyScoped;
      // Detalhamento local 7d (por modelo / origem) — sempre estimativa de tabela,
      // independente do % real da conta. Varre os transcripts desta máquina.
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

  /** Retoma a sessão mais recente UMA vez (no 1º init). Sessões criadas depois
   *  pelo usuário ("New Session") devem começar vazias, não retomar a última. */
  private autoResumeLast(): void {
    if (this.autoResumeDone) return;
    this.autoResumeDone = true;
    if (!this.cfg().get<boolean>('autoResumeLastSession', true)) return;
    const s = this.active();
    if (s.resumeId || s.cli || s.sessionId) return; // já há sessão ativa
    const id = latestSessionId(this.workspaceCwd());
    if (id) {
      s.resume(id);
      this.restoreSessionModel(s, id); // restaura model/effort salvos
      this.sendConfig(); // reflete o model/effort restaurado nos combos
    }
  }

  /**
   * Reenvia a conversa de uma aba (do transcript) a TODAS as superfícies — para
   * popular um painel recém-aberto ou ao trocar de aba. Pula se a aba está
   * ocupada (streaming ao vivo) para não sobrescrever o turno em andamento.
   */
  private replayTab(tabId: string, force = false): void {
    const s = this.sessions.get(tabId);
    // Normal: pula se busy (não sobrescreve o turno ao vivo). Recovery (force):
    // o painel acabou de remontar em branco — repinta o histórico persistido; os
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
   * Abre uma sessão (duplo clique na lista): foca a aba que já a tem; senão
   * abre numa aba NOVA. Nunca sobrepõe a conversa da aba ativa.
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
    this.openSessionPanel(tab); // abre o contexto numa webview própria
    this.sendConfig();
  }

  /**
   * Reload (botão ↻ no card): recupera o webview cinza/morto do contexto. Se o
   * painel está aberto, recria-o (mesmo tabId/sessão intactos) e revela; se não,
   * abre fresco. Roda no host → funciona mesmo com o renderer travado.
   */
  private reloadSession(sessionId: string): void {
    for (const [id, s] of this.sessions) {
      if (s.sessionId === sessionId || s.resumeId === sessionId) {
        if (this.panels.has(id)) {
          this.reloadGuard.delete(id); // pedido explícito: ignora cooldown/cap
          if (this.recreatePanel(id)) this.panels.get(id)?.reveal();
        } else {
          this.openSessionPanel(id);
        }
        return;
      }
    }
    this.openSession(sessionId); // não estava carregada: abre do zero
  }

  /**
   * Publica a sessão p/ controle remoto (acompanhar/interagir pelo celular): abre
   * o contexto e roda /remote-control no CLI dele — o CLI devolve o link/QR de
   * pareamento na conversa.
   */
  private remoteControl(sessionId: string): void {
    this.openSession(sessionId); // garante a sessão aberta/carregada
    for (const [, s] of this.sessions) {
      if (s.sessionId === sessionId || s.resumeId === sessionId) {
        s.send('/remote-control');
        return;
      }
    }
  }

  /** Reabre a última sessão fechada pelo usuário (Ctrl+Shift+T). */
  reopenClosed(): void {
    const lc = this.lastClosed;
    if (!lc) return;
    this.lastClosed = undefined;
    // Sessão ainda viva em memória (fechou só o painel): reabre o painel dela.
    if (this.sessions.has(lc.tabId)) {
      this.openSessionPanel(lc.tabId);
    } else if (lc.sessionId) {
      this.openSession(lc.sessionId); // recarrega do transcript
    }
  }

  /** Carrega o histórico de uma sessão numa aba específica e arma --resume. */
  private resumeInTab(tab: string, sessionId: string): void {
    const s = this.sessions.get(tab);
    s?.resume(sessionId);
    if (s) this.restoreSessionModel(s, sessionId); // model/effort salvos desta sessão
    const items = loadTranscript(this.workspaceCwd(), sessionId);
    const names = this.memory.get<Record<string, string>>('sessionNames', {});
    this.setTabTitle(tab, names[sessionId] || this.titleFromItems(items));
    this.post({ kind: 'history', items }, tab);
    this.postTabs();
    log(`Resuming session ${sessionId} (${items.length} items) in ${tab}`);
  }

  /** Persiste o model/effort (override) da sessão por sessionId, p/ restaurar depois. */
  private saveSessionModel(s: Session): void {
    const id = s.sessionId ?? s.resumeId;
    if (!id) return; // sessão nova ainda sem id: salva quando o init trouxer o id
    const map = this.memory.get<Record<string, SessionPrefs>>('sessionModels', {});
    map[id] = {
      model: s.modelOverride,
      effort: s.effortOverride,
      allowAgents: s.allowAgentsOverride,
      daseEnabled: s.daseEnabledOverride,
    };
    void this.memory.update('sessionModels', map);
  }

  /** Restaura o model/effort salvos de uma sessão (sem reiniciar — ainda sem CLI). */
  private restoreSessionModel(s: Session, id: string): void {
    const map = this.memory.get<Record<string, SessionPrefs>>('sessionModels', {});
    const o = map[id];
    if (!o) return;
    if (o.model) s.modelOverride = o.model;
    if (o.effort) s.effortOverride = o.effort;
    if (typeof o.allowAgents === 'boolean') s.allowAgentsOverride = o.allowAgents;
    if (typeof o.daseEnabled === 'boolean') s.daseEnabledOverride = o.daseEnabled;
  }

  /**
   * Rebobina a conversa até o (index)-ésimo prompt do usuário: corta o transcript
   * nesse prompt (removendo-o e tudo depois), rearma --resume da sessão truncada e
   * recarrega o histórico na webview. A próxima mensagem continua daquele ponto.
   */
  private rewind(tabId: string, index: number): void {
    const s = this.sessions.get(tabId);
    if (!s || s.busy) return; // não rebobina turno em andamento
    const id = s.sessionId ?? s.resumeId;
    if (!id) return;
    const cwd = this.workspaceCwd();
    const users = loadTranscript(cwd, id).filter((i) => i.kind === 'user');
    const target = users[index];
    if (!target) return;
    if (!truncateTranscriptAt(cwd, id, target.id)) {
      log(`rewind: prompt #${index} (uuid ${target.id}) não encontrado no transcript`);
      return;
    }
    s.resume(id); // limpa a conversa e rearma --resume a partir do transcript truncado
    this.replayTab(tabId); // recarrega o histórico (já cortado) na webview
    this.postTabs();
    this.sendSessions();
    log(`rewind: sessão ${id} cortada no prompt #${index}`);
  }

  /**
   * Inicia o ditado por voz (STT) p/ a aba: abre o WS OAuth, captura o mic NO
   * HOST (via ffmpeg — o webview bloqueia getUserMedia) e roteia as transcrições
   * de volta à superfície. Encerra uma sessão anterior, se houver.
   */
  private async startVoice(tabId: string, language?: string): Promise<void> {
    this.stopVoice();
    // Idioma: setting explícito (tootega.voiceLanguage) tem prioridade; senão o
    // locale do webview; senão o locale do Cockpit. Normaliza p/ curto (pt-BR->pt).
    const forced = this.cfg().get<string>('voiceLanguage', '').trim();
    const lang = ((forced || language || this.voiceLanguage()).split('-')[0] || 'en').toLowerCase();
    // Dicionário da conta: termos viesam o STT (keyterms) + substituições aplicadas
    // ao texto. Chave resolvida (cacheada) p/ casar com o que o modal salvou.
    // Recarrega do disco a cada ditado (reflete edições do modal na hora).
    this.voiceDict = loadDictionary();
    // Keyterms = dicionário do usuário (prioridade) + nome do projeto + termos
    // colhidos do workspace (deps + glossário tech). Como o STT roda monolíngue
    // (proxy rejeita language=multi), keyterms é a âncora p/ grafia literal de
    // jargão/inglês ditado dentro do PT.
    const cwd = this.workspaceCwd();
    const keyterms = buildKeyterms(this.voiceDict, [path.basename(cwd), ...workspaceTerms(cwd)]);
    dlog(
      'voice',
      `dict: ${this.voiceDict.terms.length} termos, ${this.voiceDict.replacements.length} substituições | keyterms="${keyterms.slice(0, 240)}"`,
    );
    const capture = new AudioCapture({
      ffmpegPath: this.cfg().get<string>('ffmpegPath', '') || undefined,
    });
    this.voiceCapture = capture;
    let firstFrame = false; // sinaliza 'pronto' no 1º PCM real (mic vivo + WS aberto)
    this.voice = new VoiceSession(lang, keyterms, {
      onOpen: () => {
        // WS pronto: começa a capturar e empurrar PCM.
        void capture.start(
          (buf) => {
            if (!firstFrame) {
              firstFrame = true;
              // Só agora o ditado está REALMENTE válido (WS + áudio fluindo):
              // o webview tira o spinner e libera o "pode falar". Evita perder
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
        if (isFinal && fixed !== text) dlog('voice', `substituição aplicada: "${text}" → "${fixed}"`);
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

  /** Corrige o texto ditado via Haiku (one-shot isolado) e devolve à superfície. */
  private async correctVoice(tabId: string, text: string): Promise<void> {
    const t = text.trim();
    if (!t) {
      this.post({ kind: 'voiceCorrectError' }, tabId);
      return;
    }
    // Aplica as substituições do dicionário ANTES e orienta o Haiku a preservar
    // os termos da conta (não "corrigir" nomes próprios/jargão).
    const dict = loadDictionary();
    const pre = applyReplacements(t, dict);
    const corrected = await correctText(pre, correctorHints(dict));
    if (corrected) this.post({ kind: 'voiceCorrected', text: corrected }, tabId);
    else this.post({ kind: 'voiceCorrected', text: pre }, tabId); // falha do Haiku: ao menos as substituições
  }

  /**
   * Exporta a conversa p/ um .md na RAIZ do projeto. mode 'direct' grava o
   * markdown mecânico; 'ai' reescreve via CLI (mesmo modelo/effort da aba, gasta
   * tokens). Nome único (evita sobrescrever); abre o arquivo ao final.
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
   * Gera o documento via one-shot do CLI (processo separado — NÃO polui a aba),
   * com o MESMO modelo/effort efetivos da sessão. Gasta tokens da assinatura.
   * Retorna o Markdown gerado, ou undefined em falha.
   */
  private generateDocAI(tabId: string, sourceMd: string): Promise<string | undefined> {
    const s = this.sessions.get(tabId) ?? this.active();
    const model = s.model();
    const effort = s.effort();
    const prompt = `${DOC_PROMPT}\n\n--- REGISTRO DA CONVERSA ---\n\n${sourceMd}`;
    // Prompt vai por STDIN (não argv): a conversa pode ser longa e estourar o
    // limite de linha de comando (Windows ~32k). `claude -p` sem arg lê o stdin.
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

  /** Carrega o dicionário da máquina (ditado + corretor) e envia ao modal. */
  private sendVoiceDict(tabId: string): void {
    const d = loadDictionary();
    this.post({ kind: 'voiceDict', data: { ...d, spellWords: this.getSpeller().userDict() } }, tabId);
  }

  /** Salva ditado + dicionário do corretor (arquivo único da máquina). */
  private saveVoiceDict(
    tabId: string,
    terms: string[],
    replacements: VoiceReplacement[],
    spellWords?: string[],
  ): void {
    if (spellWords) this.getSpeller().setUserDict(spellWords);
    // Termos de ditado mudaram: reflete no corretor (não são erro).
    this.getSpeller().setProjectTerms([...workspaceTerms(this.workspaceCwd()), ...terms]);
    const words = this.getSpeller().userDict();
    saveDictionary({ terms, replacements, spellWords: words });
    this.voiceDict = loadDictionary(); // aplica já às próximas transcrições
    this.post({ kind: 'voiceDict', data: { ...this.voiceDict, spellWords: words } }, tabId);
  }

  /** Corretor ortográfico (lazy). Dicionários em dict/ (arquivos de dados). */
  private getSpeller(): Speller {
    if (!this.speller) {
      const dir = vscode.Uri.joinPath(this.extensionUri, 'dict').fsPath;
      // Palavras do corretor vêm do arquivo único da máquina (~/.claude/tootega).
      const dict = loadDictionary();
      this.speller = new Speller(dir, dict.spellWords ?? []);
      // Termos técnicos (deps/glossário do workspace + termos do dicionário de
      // ditado) contam como conhecidos: o corretor não os marca como erro.
      this.speller.setProjectTerms([...workspaceTerms(this.workspaceCwd()), ...dict.terms]);
    }
    return this.speller;
  }

  /** Checa um lote de palavras e devolve as erradas à aba que pediu. */
  private async handleSpellCheck(tabId: string, words: string[]): Promise<void> {
    const sp = this.getSpeller();
    await sp.ensure();
    this.post({ kind: 'spellResult', bad: sp.check(words) }, tabId);
  }

  /** Sugestões de correção (por idioma) p/ uma palavra. */
  private async handleSpellSuggest(tabId: string, requestId: string, word: string): Promise<void> {
    const sp = this.getSpeller();
    await sp.ensure();
    const s = sp.suggest(word);
    this.post({ kind: 'spellSuggestResult', requestId, word, pt: s.pt, en: s.en }, tabId);
  }

  /** Idioma do ditado: locale do Cockpit -> código BCP47 curto (pt-BR -> pt). */
  private voiceLanguage(): string {
    const loc = resolveLocale();
    return (loc.split('-')[0] || 'en').toLowerCase();
  }

  /**
   * Idioma das perguntas do agente (AskUserQuestion). Mesma prioridade do ditado:
   * setting explícito `tootega.voiceLanguage` > locale do Cockpit. Código curto.
   */
  private askLanguageCode(): string {
    const forced = this.cfg().get<string>('voiceLanguage', '').trim();
    return ((forced || resolveLocale()).split('-')[0] || 'en').toLowerCase();
  }

  /** Título curto a partir da primeira fala do usuário no transcript. */
  private titleFromItems(items: { kind: string; text?: string }[]): string {
    const first = items.find((i) => i.kind === 'user' && i.text)?.text ?? '';
    return first.replace(/\s+/g, ' ').trim().slice(0, 28);
  }

  /** Conteúdo atual do arquivo (p/ diff do Write). Vazio se novo/ilegível/grande. */
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

  // Auto-save: antes do agente ler/escrever um arquivo, grava o buffer aberto se
  // estiver sujo (evita o agente operar numa versão velha). Setting tootega.autosave.
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

  // Conteúdo virtual (lado "proposto") do diff nativo, por URI.
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
      /* sem workspace */
    }
    this.post({ kind: 'mentionResults', requestId, items: items.slice(0, 12) }, tabId);
  }

  private notifyComplete(): void {
    if (!this.cfg().get<boolean>('notifyOnComplete', true)) return;
    // Notifica se nenhum painel de chat está visível.
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
    // Atualiza de imediato o título da aba/webview aberta dessa sessão (se houver).
    // Casa por sessionId (turno já rodou) OU resumeId (retomada ainda sem turno).
    for (const [tabId, s] of this.sessions) {
      if (s.sessionId === id || s.resumeId === id) {
        this.setTabTitle(tabId, trimmed);
        break;
      }
    }
    this.sendSessions();
  }

  /**
   * Desliga o CLI vivo de uma aba antes de apagar seu transcript. Sem isto o
   * processo `claude` da sessão aberta segura o handle do `.jsonl` (no Windows o
   * unlink falha e o arquivo sobrevive) OU o recria no próximo flush/keep-alive —
   * a "sessão-fantasma" que reaparece no hub. clearConversation() mata o processo
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

  // Refletem a aba ativa (override da aba ?? default das settings).
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
  private currentDaseEnabled(): boolean {
    return this.active().daseEnabled();
  }

  /**
   * Caminho do `--mcp-config` do DASE p/ a sessão atual, ou undefined. Gera o
   * arquivo na hora (token do DASE muda a cada start, então sempre relê). Gated
   * pelo setting `tootega.dase.enabled`.
   */
  private daseMcpConfigPath(): string | undefined {
    if (!this.cfg().get<boolean>('dase.enabled', true)) return undefined;
    this.ensureDaseActivated();
    const storageDir = this.globalStorageDir;
    if (!storageDir) return undefined;
    const p = ensureDaseMcpConfig(storageDir, storageDir, this.daseWorkspacePath());
    if (!p) log('[dase] endpoint não encontrado (servidor MCP do DASE desligado?)');
    else void this.syncDaseRegistration(); // DASE reiniciado ⇒ token novo no .claude.json
    return p;
  }

  /**
   * Extensão DASE instalada? Gate de VISIBILIDADE do checkbox: sem a extensão, o
   * toggle nem aparece. Tenta os IDs conhecidos (publishers variam) e, como
   * fallback, considera instalado se o endpoint de descoberta já existe (servidor
   * ligado). Respeita o setting `dase.enabled`.
   */
  private daseInstalled(): boolean {
    if (!this.cfg().get<boolean>('dase.enabled', true)) return false;
    if (this.daseExtension()) return true;
    return !!readDaseEndpoint(this.globalStorageDir, this.daseWorkspacePath());
  }

  /**
   * Workspace desta janela (1ª pasta), p/ casar o endpoint do DASE. Cada janela do
   * DASE roda numa porta efêmera e grava um discovery próprio marcado com o
   * workspace — assim pegamos o servidor da NOSSA janela, não o de outra.
   */
  private daseWorkspacePath(): string | undefined {
    return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  }

  /** Resolve a extensão DASE por qualquer ID conhecido, ou undefined. */
  private daseExtension(): vscode.Extension<unknown> | undefined {
    for (const id of KNOWN_DASE_EXT_IDS) {
      const ext = vscode.extensions.getExtension(id);
      if (ext) return ext;
    }
    return undefined;
  }

  /** Endpoint do DASE existe (servidor MCP ligado no DASE)? P/ habilitar o toggle. */
  private daseAvailable(): boolean {
    if (!this.cfg().get<boolean>('dase.enabled', true)) return false;
    this.ensureDaseActivated();
    return !!readDaseEndpoint(this.globalStorageDir, this.daseWorkspacePath());
  }

  // Ativação da extensão DASE já disparada (1x). DASE só ativa com .dsorm aberto/
  // no workspace; sem isto, num workspace sem modelo o servidor MCP nunca sobe.
  private daseActivation?: Thenable<unknown>;

  /**
   * Garante que a extensão DASE seja ativada. Ela registra o watcher de config e
   * sobe o servidor MCP (se dase.mcp.enabled). Best-effort, idempotente: no-op se
   * a extensão não estiver instalada. O endpoint aparece de forma assíncrona logo
   * após — por isso ativamos cedo (na construção).
   */
  private ensureDaseActivated(): void {
    if (this.daseActivation) return;
    if (!this.cfg().get<boolean>('dase.enabled', true)) return;
    const ext = this.daseExtension();
    if (!ext) return;
    this.daseActivation = (ext.isActive ? Promise.resolve() : ext.activate()).then(
      () => {
        dlog('dase', 'extensão DASE ativada');
        void this.syncDaseRegistration();
      },
      (e) => log(`[dase] activate falhou: ${String(e)}`),
    );
  }

  /**
   * Registra o DASE no `.claude.json` (escopo user) para que o Claude Code CLI
   * enxergue as tools `dase_*` em qualquer sessão — inclusive fora do Cockpit.
   * O endpoint surge alguns instantes após a ativação do DASE, então tentamos
   * algumas vezes antes de desistir. Best-effort e silencioso quanto ao token.
   */
  private async syncDaseRegistration(): Promise<void> {
    if (!this.cfg().get<boolean>('dase.registerInCli', true)) return;
    if (this.daseSyncing) return; // evita loops de retry sobrepostos
    this.daseSyncing = true;
    try {
      for (let i = 0; i < DASE_REGISTER_TRIES; i++) {
        const r = registerDaseInClaudeCli(this.globalStorageDir, this.daseWorkspacePath());
        if (r !== 'unavailable') {
          if (r === 'written') log('[dase] servidor MCP registrado no .claude.json (escopo user)');
          else if (r === 'error') log('[dase] falha ao registrar o MCP no .claude.json');
          return;
        }
        await delay(DASE_REGISTER_DELAY_MS);
      }
      log('[dase] endpoint indisponível: registro no .claude.json adiado');
    } finally {
      this.daseSyncing = false;
    }
  }

  // Registro no .claude.json em andamento (guard de reentrância).
  private daseSyncing = false;
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
   * Consulta /v1/models uma vez. Usa API key (se houver) ou o token OAuth da
   * assinatura — assim modelos novos liberados na conta aparecem sem editar a
   * lista estática. No-op só quando não há credencial alguma.
   */
  private async tryDiscoverModels(): Promise<void> {
    // Preço é independente da credencial (docs públicas) — busca em paralelo.
    void this.tryFetchPricing();
    if (this.discoveryTried) return;
    this.discoveryTried = true;
    const creds = resolveCreds(await this.getApiKey());
    if (!creds) return; // sem API key nem token OAuth: usa fallback estático
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
        this.refreshContextLimits(); // descoberta pós-init: corrige a barra dos modelos 1M
      }
    } catch {
      /* silencioso — fallback já cobre */
    }
  }

  /** Carrega o preço das docs (cache 1x/dia). No-op após a 1ª vez. */
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
      /* silencioso — coluna de preço fica vazia */
    }
  }

  // Reaplica o limite de contexto (auto) de todas as abas e reemite os stats das
  // que mudaram. Usado quando a descoberta chega depois do init da sessão.
  private refreshContextLimits(): void {
    for (const [tab, s] of this.sessions) {
      if (s.stats.refreshContextLimit()) {
        this.post({ kind: 'stats', stats: s.snapshot() }, tab);
      }
    }
  }

  private sendConfig(): void {
    // Descobertos ao vivo que não estão na lista — pulando as versões de 200K
    // cuja variante 1M já é oferecida.
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
        daseEnabled: this.currentDaseEnabled(),
        daseInstalled: this.daseInstalled(),
        daseAvailable: this.daseAvailable(),
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
   * Metadados por modelo para as colunas do seletor. Contexto é REAL da Models
   * API quando descoberto; senão derivado ([1m]→1M, senão 200K). Preço vem das
   * docs (id base, sem sufixo [1m]); multiplicador normaliza a entrada pelo
   * Opus 4.8 (=1x), ou pelo maior preço se o Opus não estiver na tabela.
   */
  private buildModelMeta(models: string[]): Record<string, ModelMeta> {
    const anchor =
      this.pricing['claude-opus-4-8']?.inMTok ??
      Math.max(0, ...Object.values(this.pricing).map((p) => p.inMTok));
    const meta: Record<string, ModelMeta> = {};
    for (const id of models) {
      if (id === 'default' || /^(opus|sonnet|haiku|fable|mythos)$/i.test(id)) continue;
      const is1m = /\[1m\]/i.test(id);
      // Chave de preço: sem sufixo [1m] e sem snapshot datado (-YYYYMMDD).
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

  /** Re-tenta a descoberta de modelos (ex.: após mudar a API key). */
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
   * Pede a API key ao usuário (input mascarado) e grava no SecretStorage.
   * Vazio = remove a chave. Reexecuta a descoberta de modelos ao final.
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
   * Migração única: se a antiga setting `tootega.apiKey` (texto plano) tiver valor,
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
      // Limpa dos 3 escopos p/ não deixar rastro em texto plano.
      const cfg = this.cfg();
      await cfg.update('apiKey', undefined, vscode.ConfigurationTarget.Global);
      await cfg.update('apiKey', undefined, vscode.ConfigurationTarget.Workspace);
      await cfg.update('apiKey', undefined, vscode.ConfigurationTarget.WorkspaceFolder);
      log('[apiKey] migrada da setting p/ SecretStorage; setting removida');
      this.refreshModels();
    } catch (e) {
      log(`[apiKey] migração falhou: ${String(e)}`);
    }
  }

  /** Aplica o modelo interno (tootega.internalModel) ao helper de IA. */
  applyInternalModel(): void {
    setInternalModel(this.cfg().get<string>('internalModel', ''));
  }

  /** Recalcula o uso local (ex.: após mudar orçamento nas settings). */
  refreshUsageNow(): void {
    void this.refreshUsage();
  }

  /** Settings de model/effort mudaram: limpa overrides e reflete nos combos da UI. */
  applyDefaultsFromSettings(): void {
    // Settings de default mudaram: abas sem override passam a segui-las.
    this.active().stop();
    this.sendConfig();
  }

  /** Prefs só de UI (thinking/tool cards/nome/verbosity): re-empurra config sem mexer na sessão. */
  pushConfig(): void {
    this.sendConfig();
    if (this.activeTab) this.postTaskTimings(this.activeTab); // verbosity muda o escopo do gauge
  }

  /** Abre a lista de sessões na UI (comando/atalho). */
  openSessions(): void {
    this.post({ kind: 'openSessions' });
    this.sendSessions();
  }

  // Escopo (modelo, effort) p/ segmentar os tempos: prefere o modelo REAL
  // resolvido pelo CLI (snapshot), caindo p/ o selecionado. Effort: o CLI não
  // ecoa o nível no stream, então resolvemos 'default' p/ o setting do Cockpit e,
  // se ainda 'default', p/ o effortLevel REAL do CLI (~/.claude/settings.json) —
  // assim a chave não fica num 'default' ambíguo.
  private timingScope(s: Session): { model: string; effort: string; verbosity: string } {
    const model = s.stats.snapshot().model || s.model() || 'default';
    let effort = s.effort() || 'default';
    if (effort === 'default') effort = this.cfg().get<string>('effort', 'default') || 'default';
    if (effort === 'default') effort = this.defaults.effort || 'default';
    const verbosity = this.cfg().get<string>('verbosity', 'verbose') || 'verbose';
    return { model, effort, verbosity };
  }

  /** Envia ao(s) surface(s) as médias do escopo atual da aba (gauge calibrado). */
  private postTaskTimings(tabId: string): void {
    const s = this.sessions.get(tabId) ?? this.active();
    const { model, effort, verbosity } = this.timingScope(s);
    this.post({ kind: 'taskTimings', timings: taskTimingsScoped(model, effort, verbosity) }, tabId);
  }

  // ---- Mensagens vindas do webview ----

  private onWebviewMessage(m: WebviewToHost, webview?: vscode.Webview): void {
    // Qualquer mensagem prova que o render está vivo: arma o relógio do watchdog.
    const sk = this.surfaceKey(webview);
    if (sk) {
      this.lastBeat.set(sk, Date.now());
      const g = this.reloadGuard.get(sk);
      if (g && Date.now() - g.at > RELOAD_COOLDOWN_MS) this.reloadGuard.delete(sk); // recuperou: zera o cap
    }
    // Sessão de origem: painel de chat -> sua sessão; hub/sem vínculo -> ativa.
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
        this.reportAuth(); // estado de login p/ o botão Sign in/out
        this.postTaskTimings(bound ?? this.activeTab); // médias do escopo p/ calibrar o gauge
        this.autoResumeLast();
        this.postTabs();
        // init = painel recém-montado (abrir/reabrir/recriar). Força replay do
        // histórico SEMPRE, mesmo com a sessão ocupada: senão reabrir um contexto
        // em execução mostra só o trecho que chega após reabrir. Os deltas em voo
        // se anexam ao histórico repintado.
        this.justRecreated.delete(bound ?? this.activeTab);
        this.replayTab(bound ?? this.activeTab, true);
        if (bound) this.primeCommands(bound); // carrega slash commands sem esperar o 1º envio
        // Recupera o rascunho/ditado espelhado (ex.: tela branca durante o ditado).
        {
          const draft = this.draftByTab.get(bound ?? this.activeTab);
          if (draft) this.post({ kind: 'draftRestore', text: draft }, bound ?? this.activeTab);
        }
        break;
      case 'sendMessage': {
        // Gate de effort mínimo: resolvido AGORA do CLAUDE.md aplicável à pasta de
        // trabalho da sessão (não vive em config — pastas diferentes, valores
        // diferentes). Abaixo do mínimo e sem 'force' → pede confirmação e NÃO envia.
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
          break; // bloqueia: webview confirma e reenvia com force
        }
        // Tag @DASE: liga a integração DASE (sticky) e orienta o agente às tools
        // dase_*. O tag é removido do prompt. 1ª vez respawna o CLI com o
        // --mcp-config; depois fica ligado (cache quente).
        let body = m.text;
        let daseSteer = '';
        if (DASE_TAG.test(body)) {
          body = body.replace(DASE_TAG, '');
          if (!s.daseEnabled() && this.daseAvailable()) {
            s.setDaseEnabled(true); // stop() → respawn no s.send() abaixo com DASE
            this.saveSessionModel(s);
            this.sendConfig(); // reflete o toggle ligado na UI
          }
          if (s.daseEnabled()) {
            daseSteer = `${DASE_STEER}\n\n`;
          } else {
            this.post(
              {
                kind: 'error',
                message: vscode.l10n.t(
                  '@DASE ignored — the DASE MCP server is not running (enable dase.mcp.enabled in the DASE extension).',
                ),
              },
              srcTab,
            );
          }
        }
        if (!this.tabMeta.get(srcTab)?.title && body.trim()) {
          this.setTabTitle(srcTab, body.replace(/\s+/g, ' ').trim().slice(0, 28));
        }
        // Enviar prompt confirma as escolhas de combo na aba atual: descarta o
        // baseline (não há mais reversão pendente para um novo contexto).
        if (this.comboBaseline?.tab === srcTab) this.comboBaseline = undefined;
        if (this.pendingRestart) {
          // A mudança de model/effort/permission é aplicada agora (reinício): some o aviso.
          this.pendingRestart = false;
          this.sendConfig();
        }
        // Compartilha a seleção do editor como contexto, se o composer pediu.
        const sel = m.selection ? `${m.selection}\n` : '';
        const text = `${daseSteer}${sel}${body}`;
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
      case 'setDaseEnabled':
        srcSession().setDaseEnabled(m.value);
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
        // Confirmação já feita no webview (modal elegante). Detacha a aba viva
        // (libera o handle / impede recriação) e então apaga o transcript.
        this.detachLiveSessions(m.sessionId);
        deleteSession(this.workspaceCwd(), m.sessionId);
        this.sendSessions();
        break;
      case 'deleteAllSessions':
        // Confirmação já feita no webview. Detacha TODAS as abas vivas antes de
        // apagar — senão a sessão aberta segura/recria seu .jsonl e reaparece.
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
        // Espelha o rascunho/ditado no host (sobrevive à morte do renderer).
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
        // Persiste no arquivo único da máquina (preserva ditado existente).
        this.getSpeller().addWord(m.word);
        const cur = loadDictionary();
        saveDictionary({ ...cur, spellWords: this.getSpeller().userDict() });
        break;
      }
      case 'taskDuration': {
        // Amostra de duração: agrega/persiste segmentada por (modelo, effort,
        // verbosity, tipo) e devolve ao surface da aba as médias do escopo atual.
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
      case 'pluginAction':
        void this.runPluginAction(m.action, m.arg, m.scope);
        break;
      case 'fetchUsage':
        void this.sendUsage(); // dado quente: busca conta + limites + breakdown ao clicar
        break;
      case 'enableUsageTracking': {
        // Instala o wrapper de statusline (captura rate_limits real no próximo render).
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

  /** Cofre de credenciais (TOTP 2FA). Toda ação sensível valida o código no host. */
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
      // Nunca logar valores/segredos: só a mensagem genérica do erro.
      this.post({ kind: 'credsError', message: String((e as Error)?.message ?? e) }, tab);
    }
  }

  /** Salva uma imagem colada (base64) em disco via diálogo nativo do VSCode. */
  private async saveImage(mediaType: string, data: string): Promise<void> {
    const ext = (mediaType.split('/')[1] || 'png').replace('+xml', '').replace('jpeg', 'jpg');
    const def = `image-${Date.now()}.${ext}`;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(this.workspaceCwd(), def)),
      filters: { [vscode.l10n.t('Images')]: [ext] },
    });
    if (!uri) return; // usuário cancelou
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
  private pathFixed = false; // já tentou adicionar ~/.local/bin ao PATH do usuário

  /** Caminho efetivo do CLI (resolvido) — usado p/ spawn/pesquisa/install. */
  private claudePath(): string {
    return this.resolvedCliPath ?? this.cfg().get<string>('claudePath', 'claude');
  }

  /** Comando p/ rodar o claude num TERMINAL (PATH ou ~/.local/bin fora do PATH).
   *  Sem espaços: roda direto (PowerShell e cmd). Com espaços: usa call operator. */
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
      this.ensureLocalBinOnPath(r.path); // installer nativo: garante ~/.local/bin no PATH do usuário
      // Última versão (npm) em background → repost com `latest` p/ marcar desatualizado.
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
   * Garante que o dir do installer nativo (~/.local/bin) esteja no PATH do USUÁRIO
   * (Windows). Idempotente, escopo User apenas (não toca no PATH do sistema). Só
   * age quando o claude foi resolvido daquele dir e ele ainda não está no PATH.
   */
  private ensureLocalBinOnPath(exePath: string): void {
    if (process.platform !== 'win32' || this.pathFixed) return;
    const bin = path.dirname(exePath);
    if (!/[\\/]\.local[\\/]bin$/i.test(bin)) return; // só o dir do installer nativo
    if ((process.env.PATH ?? '').toLowerCase().includes(bin.toLowerCase())) return; // já no PATH
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

  /** Roda `claude update` num terminal visível (usuário acompanha o progresso). */
  private updateCli(): void {
    const term = vscode.window.createTerminal('Claude Update');
    term.show();
    term.sendText(`${this.claudeCmd()} update`);
  }

  /** Versão desta extensão (lida do package.json do bundle). */
  private cockpitVersion(): string | undefined {
    try {
      const p = path.join(this.extensionUri.fsPath, 'package.json');
      return JSON.parse(fs.readFileSync(p, 'utf8')).version as string;
    } catch {
      return undefined;
    }
  }

  /** Na ativação: se o CLI faltar, pergunta (com consentimento) e instala. */
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
    // Installer NATIVO oficial: não depende de Node/npm (resolve o caso "npm não
    // reconhecido"). Traz o runtime próprio do Claude Code.
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

  /** Após instalar: re-sonda o CLI (inclui ~/.local/bin) até achar; então faz refresh. */
  private pollForCli(): void {
    let tries = 0;
    const iv = setInterval(() => {
      tries++;
      const r = CliProcessManager.resolve(this.cfg().get<string>('claudePath', 'claude'));
      if (r.ok || tries > 60) {
        clearInterval(iv);
        if (r.ok) {
          this.reportCliStatus(); // valida + repõe versão/latest no Cockpit
          void vscode.window.showInformationMessage(
            vscode.l10n.t('Claude Code CLI detected: {0}', r.version ?? ''),
          );
        }
      }
    }, 4000);
  }

  /**
   * Login NATIVO do CLI via OAuth no browser (`claude auth login`, default
   * --claudeai = assinatura). Subcomando dedicado conduz o fluxo; não é preciso
   * abrir o REPL nem digitar /login. O Cockpit não toca em credenciais.
   */
  loginCli(): void {
    const term = vscode.window.createTerminal('Claude Code · login');
    term.show();
    term.sendText(`${this.claudeCmd()} auth login`); // abre OAuth no browser; --console p/ API billing
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Signing in via your browser. Approve the request, then click "Re-check".'),
    );
    this.scheduleAuthRefresh(); // o fluxo é assíncrono no terminal: re-checa em seguida
  }

  /** Logout nativo do CLI (`claude auth logout`) num terminal. O Cockpit não toca em credenciais. */
  logoutCli(): void {
    const term = vscode.window.createTerminal('Claude Code · logout');
    term.show();
    term.sendText(`${this.claudeCmd()} auth logout`);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Signing out in the terminal. Use Sign in when you want to log back in.'),
    );
    this.scheduleAuthRefresh();
  }

  /** Busca o estado de login e empurra ao webview (mostra Sign in OU Sign out). */
  reportAuth(): void {
    resetAccountKey(); // login/logout pode ter mudado a conta → re-resolve o dicionário
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
    // Hub recebe tudo (espelha estado global + sessão ativa).
    this.trySend(this.hubView?.webview, payload);
    if (tab) {
      // Mensagem de uma sessão: só o painel daquela sessão.
      this.trySend(this.panels.get(tab)?.webview, payload);
    } else {
      // Global (config/cli/tabs/locale): todos os painéis de chat.
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
    // Ícone da extensão p/ o indicador de atividade (img no webview). media/ não
    // está em localResourceRoots por padrão — incluído junto com dist/webview.
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
      if (view.visible) this.lastBeat.set(HUB_SURFACE, Date.now()); // reexibido: rearma o relógio
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

// Instrução p/ a opção "Gerar com IA": produz um documento organizado e coerente
// a partir do registro da conversa. Foca no raciocínio/decisões e no resultado;
// omite ruído técnico. Mantém o idioma da conversa.
const DOC_PROMPT = [
  'Você é um editor técnico. A partir do registro de conversa abaixo (entre um desenvolvedor e um assistente de IA),',
  'escreva um DOCUMENTO em Markdown — organizado, de alto nível e coerente — que conte a história do trabalho:',
  'o que foi pedido, o que foi pensado e decidido, o que foi feito, POR QUE e COMO, e o resultado final.',
  'Priorize o raciocínio, as decisões e a motivação. OMITA ruído técnico (comandos, saídas de ferramentas, diffs crus).',
  'Estruture com títulos, seções e listas quando ajudar a leitura. Seja fiel ao conteúdo — não invente.',
  'Escreva no MESMO idioma predominante da conversa.',
  'Responda SOMENTE com o Markdown do documento — sem comentários, sem cercas de código ao redor do todo.',
].join(' ');

/** Caminho único: se o arquivo já existe, insere -2, -3… antes da extensão. */
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
    /* não-JSON: usa o texto cru como fallback */
  }
  return stripWrappingFence(trimmed);
}

/** Remove uma cerca de código que envolva o documento inteiro (```markdown … ```). */
function stripWrappingFence(s: string): string {
  const m = s.match(/^```[a-zA-Z]*\n([\s\S]*?)\n```$/);
  return m ? m[1] : s;
}

/** LimitWindow (interno) -> UsageBucket (protocolo do modal Usage). */
function toBucket(w?: LimitWindow): UsageBucket | undefined {
  if (!w) return undefined;
  return { usedPct: w.usedPct, resetsAt: w.resetsAt, tokens: w.tokens, usd: w.usd };
}

// Locale de REGIÃO do SO (formato de data/hora), NÃO o idioma da UI.
// No Windows o VS Code força o locale do Node pro idioma de exibição (en),
// então o Intl do Node não serve — leio a cultura regional via PowerShell
// `(Get-Culture).Name` (= "pt-BR", o mesmo que a barra de tarefas usa). Memoizado.
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
