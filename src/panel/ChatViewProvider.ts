// Provider do webview: ponte entre o CLI (motor) e a UI React.
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { CliProcessManager } from '../cli/CliProcessManager';
import { discoverModels, resolveCreds } from '../cli/ModelDiscovery';
import {
  listSessions,
  loadTranscript,
  deleteSession,
  deleteAllSessions,
  latestSessionId,
} from '../session/SessionStore';
import { readClipboardFiles } from '../cli/ClipboardFiles';
import { readClaudeDefaults } from '../cli/ClaudeSettings';
import { computeLocalUsage } from '../session/UsageAggregator';
import { readUsageCache } from '../cli/StatuslineCache';
import { taskTimingsAll, recordTaskTiming } from '../stats/TaskTimings';
import { fetchAuthStatus } from '../cli/AuthStatus';
import { isEnabled as usageTrackingEnabled, enableUsageTracking } from '../cli/StatuslineInstaller';
import { fetchAccountUsage } from '../cli/UsageApi';
import type { LimitWindow, HostToWebview, WebviewToHost, TabInfo, UsageBucket } from '../../shared/protocol';
import { Session, type SessionHooks } from '../session/Session';
import { resolveLocale } from '../i18n/host';
import { researchCommands } from '../cli/SlashCommandResearch';
import { getLatestCliVersion } from '../cli/CliVersion';
import { log } from '../util/logger';

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

export class ChatViewProvider implements vscode.WebviewViewProvider {
  // O Cockpit vive como aba no editor (WebviewPanel) + hub na Activity Bar
  // (WebviewView). `surfaces` guarda os webviews ativos (broadcast) — o estado
  // vive no host e é replicado para todas as superfícies.
  // Cada contexto (sessão) abre como WebviewPanel próprio no editor.
  private panels = new Map<string, vscode.WebviewPanel>();
  private webviewSession = new Map<vscode.Webview, string>();
  private hubView?: vscode.WebviewView;

  // Abas: cada uma é uma Session (runtime de CLI + stats + streaming) paralela.
  private sessions = new Map<string, Session>();
  private tabMeta = new Map<string, { title: string; status: 'idle' | 'busy' | 'error' }>();
  private tabOrder: string[] = [];
  private activeTab = '';
  private tabSeq = 0;

  // Overrides de sessão (em memória — não alteram as settings globais do usuário).
  private modelOverride?: string;
  private effortOverride?: string;
  private permissionOverride?: string;
  private statusBar?: vscode.StatusBarItem;
  // Modelos descobertos ao vivo (modelo ativo do init + /v1/models quando há key).
  private discoveredModels = new Set<string>();
  private discoveryTried = false;

  // Defaults do Claude Code (effort do settings; model do settings ou init cacheado).
  private defaults: { model?: string; effort?: string } = {};
  private observedDefaultModel?: string;
  // model/effort/permission mudou e ainda não reiniciou a sessão (avisa na UI).
  private pendingRestart = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly memory: vscode.Memento,
    statusBar?: vscode.StatusBarItem,
  ) {
    this.defaults = readClaudeDefaults();
    this.observedDefaultModel = this.memory.get<string>('defaultModel');
    this.statusBar = statusBar;
    this.updateStatusBar(false);
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
      onInit: (model, cmds) => this.onSessionInit(model, cmds),
      onAuthRequired: () => this.post({ kind: 'authRequired' }, tabId),
      fileText: (tool, input) => this.currentFileText(tool, input),
      claudePath: () => this.claudePath(),
      cwd: () => this.workspaceCwd(),
      settings: () => ({
        model: this.cfg().get<string>('model', '') || 'default',
        effort: this.cfg().get<string>('effort', 'default') || 'default',
        permission: this.cfg().get<string>('permissionMode', 'default') || 'default',
      }),
      contextLimit: () => this.cfg().get<number>('contextLimit', 0),
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
    this.replayTab(tabId); // garante o histórico em todas as superfícies
  }

  /** Cria um contexto novo (conversa vazia) e abre seu painel. */
  private openNewTab(): void {
    const id = this.createTab();
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
  private onSessionInit(model?: string, slashCommands?: string[]): void {
    void this.researchSlash(slashCommands);
    if (typeof model === 'string' && model) {
      if (!this.discoveredModels.has(model)) {
        this.discoveredModels.add(model);
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
  private lastApiSonnet?: LimitWindow;
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
        this.lastApiSonnet = api.sevenDaySonnet;
        this.lastLimitsSource = 'real';
        this.lastUsageSource = 'api';
      } else {
        // 1) Cache da statusline (rate_limits). Só confia se FRESCO.
        const real = readUsageCache();
        const fresh = real != null && (real.ageMs == null || real.ageMs < USAGE_CACHE_MAX_AGE_MS);
        if (real && fresh && (real.fiveHour || real.sevenDay)) {
          this.lastLimits = { fiveHour: real.fiveHour, sevenDay: real.sevenDay };
          this.lastApiSonnet = real.sevenDaySonnet;
          this.lastLimitsSource = 'real';
          this.lastUsageSource = 'statusline';
        } else {
          // 2) Fallback: estimativa local por tokens ÷ orçamento.
          const u = await computeLocalUsage(Date.now());
          const b5 = this.cfg().get<number>('fiveHourTokenBudget', 0);
          const b7 = this.cfg().get<number>('weeklyTokenBudget', 0);
          this.lastLimits = {
            fiveHour: {
              usd: u.fiveHourUsd,
              tokens: u.fiveHourTokens,
              usedPct: b5 > 0 ? Math.min(1, u.fiveHourTokens / b5) : undefined,
            },
            sevenDay: {
              usd: u.sevenDayUsd,
              tokens: u.sevenDayTokens,
              usedPct: b7 > 0 ? Math.min(1, u.sevenDayTokens / b7) : undefined,
            },
          };
          this.lastApiSonnet = undefined;
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
    const sub = panel.webview.onDidReceiveMessage((m: WebviewToHost) =>
      this.onWebviewMessage(m, panel.webview),
    );
    const vs = panel.onDidChangeViewState(() => {
      if (panel.active) this.setActive(tabId);
    });
    panel.onDidDispose(() => {
      this.panels.delete(tabId);
      this.webviewSession.delete(panel.webview);
      sub.dispose();
      vs.dispose();
    });
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
        claudePath: this.claudePath(),
        cwd: this.workspaceCwd(),
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
    this.post({ kind: 'sessions', sessions, cwd });
  }

  /** Reúne conta + limites reais (quentes) e envia ao webview (botão Usage). */
  private async sendUsage(): Promise<void> {
    try {
      await this.refreshUsage(true); // força API fresca (dado quente ao clicar)
      const account = await fetchAuthStatus(this.claudePath());
      const sonnet = this.lastApiSonnet ?? readUsageCache()?.sevenDaySonnet;
      this.post({
        kind: 'usageData',
        data: {
          account,
          buckets: {
            fiveHour: toBucket(this.lastLimits?.fiveHour),
            sevenDay: toBucket(this.lastLimits?.sevenDay),
            sevenDaySonnet: toBucket(sonnet),
          },
          source: this.lastUsageSource,
          trackingEnabled: usageTrackingEnabled(),
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
    if (id) s.resume(id);
  }

  /**
   * Reenvia a conversa de uma aba (do transcript) a TODAS as superfícies — para
   * popular um painel recém-aberto ou ao trocar de aba. Pula se a aba está
   * ocupada (streaming ao vivo) para não sobrescrever o turno em andamento.
   */
  private replayTab(tabId: string): void {
    const s = this.sessions.get(tabId);
    if (!s || s.busy) return;
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

  /** Carrega o histórico de uma sessão numa aba específica e arma --resume. */
  private resumeInTab(tab: string, sessionId: string): void {
    const s = this.sessions.get(tab);
    s?.resume(sessionId);
    const items = loadTranscript(this.workspaceCwd(), sessionId);
    const names = this.memory.get<Record<string, string>>('sessionNames', {});
    this.setTabTitle(tab, names[sessionId] || this.titleFromItems(items));
    this.post({ kind: 'history', items }, tab);
    this.postTabs();
    log(`Resuming session ${sessionId} (${items.length} items) in ${tab}`);
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

  private notifyComplete(): void {
    if (!this.cfg().get<boolean>('notifyOnComplete', true)) return;
    // Notifica se nenhum painel de chat está visível.
    for (const p of this.panels.values()) if (p.visible) return;
    void vscode.window.showInformationMessage(vscode.l10n.t('Claude finished responding.'));
  }

  private renameSession(id: string, name: string): void {
    const names = this.memory.get<Record<string, string>>('sessionNames', {});
    const next = { ...names };
    if (name.trim()) next[id] = name.trim();
    else delete next[id];
    void this.memory.update('sessionNames', next);
    this.sendSessions();
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
  private userName(): string {
    const set = this.cfg().get<string>('userName', '').trim();
    if (set) return set;
    try {
      return os.userInfo().username || '';
    } catch {
      return '';
    }
  }

  /** Consulta /v1/models uma vez, se houver credencial de API. No-op sem key. */
  private async tryDiscoverModels(): Promise<void> {
    if (this.discoveryTried) return;
    this.discoveryTried = true;
    const creds = resolveCreds(this.cfg().get<string>('apiKey', ''));
    if (!creds) return; // assinatura sem API key: usa fallback
    try {
      const ids = await discoverModels(creds);
      let added = false;
      for (const id of ids) {
        if (!this.discoveredModels.has(id)) {
          this.discoveredModels.add(id);
          added = true;
        }
      }
      if (added) {
        log(`Discovered ${ids.length} models via /v1/models`);
        this.sendConfig();
      }
    } catch {
      /* silencioso — fallback já cobre */
    }
  }

  private sendConfig(): void {
    // Descobertos ao vivo que não estão na lista — pulando as versões de 200K
    // cuja variante 1M já é oferecida.
    const discoveredExtra = [...this.discoveredModels].filter(
      (m) => !MODEL_LIST.includes(m) && !BASE_OF_1M.has(m),
    );
    const models = dedupe([...MODEL_LIST, ...discoveredExtra]);
    this.post({
      kind: 'config',
      config: {
        model: this.currentModel(),
        effort: this.currentEffort(),
        models,
        efforts: EFFORT_OPTIONS,
        defaultModel: this.defaults.model ?? this.observedDefaultModel,
        defaultEffort: this.defaults.effort,
        permissionMode: this.currentPermissionMode(),
        permissionModes: PERMISSION_MODES,
        showThinking: this.cfg().get<boolean>('showThinking', false),
        expandToolCards: this.cfg().get<boolean>('expandToolCards', false),
        pendingRestart: this.pendingRestart,
        userName: this.userName(),
      },
    });
  }

  interrupt(): void {
    this.active().interrupt();
  }

  pushLocale(): void {
    this.post({ kind: 'locale', locale: resolveLocale() });
  }

  /** Re-tenta a descoberta de modelos (ex.: após mudar a API key nas settings). */
  refreshModels(): void {
    this.discoveryTried = false;
    void this.tryDiscoverModels();
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

  /** Prefs só de UI (thinking/tool cards/nome): re-empurra config sem mexer na sessão. */
  pushConfig(): void {
    this.sendConfig();
  }

  /** Abre a lista de sessões na UI (comando/atalho). */
  openSessions(): void {
    this.post({ kind: 'openSessions' });
    this.sendSessions();
  }

  // ---- Mensagens vindas do webview ----

  private onWebviewMessage(m: WebviewToHost, webview?: vscode.Webview): void {
    // Sessão de origem: painel de chat -> sua sessão; hub/sem vínculo -> ativa.
    const bound = webview ? this.webviewSession.get(webview) : undefined;
    const srcTab = bound && this.sessions.has(bound) ? bound : this.activeTab;
    const srcSession = (): Session => this.sessions.get(srcTab) ?? this.active();
    switch (m.kind) {
      case 'init':
        if (this.tabOrder.length === 0) this.createTab();
        this.post({ kind: 'ready', locale: resolveLocale() });
        this.sendConfig();
        this.reportCliStatus();
        void this.tryDiscoverModels();
        this.startUsageTimer();
        this.post({ kind: 'taskTimings', timings: taskTimingsAll() }); // médias p/ calibrar o gauge
        this.autoResumeLast();
        this.postTabs();
        this.replayTab(bound ?? this.activeTab); // popula a superfície com sua conversa
        if (bound) this.primeCommands(bound); // carrega slash commands sem esperar o 1º envio
        break;
      case 'sendMessage': {
        if (!this.tabMeta.get(srcTab)?.title && m.text.trim()) {
          this.setTabTitle(srcTab, m.text.replace(/\s+/g, ' ').trim().slice(0, 28));
        }
        if (this.pendingRestart) {
          // A mudança de model/effort/permission é aplicada agora (reinício): some o aviso.
          this.pendingRestart = false;
          this.sendConfig();
        }
        srcSession().send(m.text, m.images);
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
        srcSession().decide(m.requestId, m.decision);
        break;
      case 'askResponse':
        srcSession().answer(m.requestId, m.answers);
        break;
      case 'setModel':
        srcSession().setModel(m.model);
        this.pendingRestart = true;
        this.sendConfig();
        break;
      case 'setEffort':
        srcSession().setEffort(m.effort);
        this.pendingRestart = true;
        this.sendConfig();
        break;
      case 'setPermissionMode':
        srcSession().setPermission(m.mode);
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
      case 'deleteSession':
        // Confirmação já feita no webview (modal elegante). Apaga direto.
        deleteSession(this.workspaceCwd(), m.sessionId);
        this.sendSessions();
        break;
      case 'deleteAllSessions':
        // Confirmação já feita no webview. Apaga todos os transcripts do cwd.
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
      case 'taskDuration':
        // Amostra de duração por tipo: agrega/persiste (global) e devolve as
        // médias atualizadas a TODAS as superfícies (sincroniza abas/painéis).
        recordTaskTiming(m.type, m.ms);
        this.post({ kind: 'taskTimings', timings: taskTimingsAll() });
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
  }

  /** Logout nativo do CLI (`claude auth logout`) num terminal. O Cockpit não toca em credenciais. */
  logoutCli(): void {
    const term = vscode.window.createTerminal('Claude Code · logout');
    term.show();
    term.sendText(`${this.claudeCmd()} auth logout`);
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Signing out in the terminal. Use Sign in when you want to log back in.'),
    );
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
    const sub = view.webview.onDidReceiveMessage((m: WebviewToHost) =>
      this.onWebviewMessage(m, view.webview),
    );
    view.onDidDispose(() => {
      sub.dispose();
      if (this.hubView === view) this.hubView = undefined;
    });
  }
}

function dedupe(arr: string[]): string[] {
  return Array.from(new Set(arr.filter(Boolean)));
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
