// Message protocol between the extension host and the React webview.
import type { Usage } from './events';

export interface LimitWindow {
  usedPct?: number; // 0..1 — statusline (always) or stream (only close to the limit)
  resetsAt?: string; // ISO 8601
  status?: 'allowed' | 'allowed_warning' | 'rejected'; // banda vinda do stream
  usd?: number; // custo local na janela
  tokens?: number; // tokens locais na janela
}

export interface ContextSlice {
  label: string;
  tokens: number;
}

export interface ToolDecision {
  tool: string;
  allow: number;
  allowAlways: number;
  deny: number;
}

/** A recorded permission denial (denial log — E5/auto-mode). */
export interface DenialEvent {
  tool: string;
  ts: number; // epoch ms
  // 'user' = denied in the modal; 'engine' = denied by the CLI itself (auto-mode
  // rule, tool not allowed, path outside the workspace…). Absent = 'user' (old
  // data, written before the distinction existed).
  source?: 'user' | 'engine';
  // Motivo. No 'user': o feedback digitado. No 'engine': a mensagem do CLI (desde
  // 2.1.193 auto mode explains why it denied).
  reason?: string;
}

/** Accumulated usage segmented per model (a session can switch models). */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  turns: number;
}

/** A timeline sample (one point per turn) — the basis of the consumption charts (S10). */
export interface TimelineSample {
  ts: number; // epoch ms
  contextUsed: number; // tamanho do prompt (input + cache_*) no turno
  cacheReadPct: number; // 0..1 — fraction read from the cache this turn (efficiency)
  costUsd: number; // session cost accumulated up to here
  reset?: boolean; // this turn was a cache reset (cold TTL)
  compaction?: boolean; // this turn reduced the context (compaction)
}

/** Detected compaction event (the context shrank between turns) (S11). */
export interface CompactionEvent {
  ts: number;
  before: number;
  after: number;
  saved: number; // before - after
}

export interface StatsSnapshot {
  model?: string;
  mode?: string;
  // Session
  sessionStartTs?: number; // epoch ms — session start (system init)
  // Contexto
  contextUsed: number;
  contextLimit: number;
  contextBreakdown?: ContextSlice[];
  // Tokens accumulated in the session
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number; // 0..1 — cumulative for the session (read / (read+write+input))
  lastTurnHitRate?: number; // 0..1 — hit rate of the last consolidated turn (cr/total of the turn)
  cacheSavingsUsd?: number; // estimated savings (read tokens × input→read price delta)
  // Custo
  sessionCostUsd: number;
  lastTurnCostUsd: number;
  costIsEstimate: boolean;
  // Tool acceptance (per tool_name, accumulated in the session)
  toolAcceptance?: ToolDecision[];
  // Log of the most recent permission denials (E5) — latest first.
  recentDenials?: DenialEvent[];
  // --- Persistence/coherence across context reopens ---
  turnCount?: number; // turns consolidated in the session
  reopenCount?: number; // how many times the context was reopened/resumed
  // Cache reset (cold TTL): an idle turn that lost the prefix and rewrote the cache
  cacheResetCount?: number;
  cacheRecacheCostUsd?: number; // $ re-paid in cacheWrite because of the resets
  // Compaction (context condensed between turns) — S11
  compactionCount?: number;
  peakContextUsed?: number; // largest context reached in the session
  // REAL session execution time (sum of each prompt's time; excludes idleness)
  activeMs?: number;
  // --- Vida do cache (TTL de 1h) e keep-alive ---
  cacheLifeMs?: number; // janela total do cache (1h)
  cacheAgeMs?: number; // age since the last activity (request)
  cacheExpiresInMs?: number; // quanto falta p/ o cache expirar
  cacheExpiresAt?: number; // epoch ms of the expiry — for a live countdown
  cacheAlive?: boolean; // the cache is still alive (age < 1h)
  keepCacheAlive?: boolean; // checkbox: re-send so the cache doesn't die
  // Detalhamento por modelo (S5 estendido)
  perModel?: ModelUsage[];
  // Limites de conta
  limits?: { fiveHour?: LimitWindow; sevenDay?: LimitWindow };
  // Source of the limits: statusline (real complete %) > stream (rate_limit_event:
  // status/reset always, % only close to the limit) > estimate (tokens÷local budget).
  limitsSource?: 'statusline' | 'stream' | 'estimate';
  // --- Skills (transparência) ---
  skills?: SkillState[];
  skillsListingTokens?: number; // categoria "Skills" do get_context_usage (só metadados)
  skillsTotal?: number; // totalSkills (antes dos overrides)
  skillsListed?: number; // includedSkills (o que realmente entrou no listing)
  // Texto que hooks injetaram no contexto desta sessão (agrupado por hook).
  hookInjections?: HookInjection[];
}

// --- Skills ---

/**
 * Estados aceitos pelo `skillOverrides` do CLI. Ausente = 'on'.
 *  - 'name-only': lista a skill sem a descrição (custo cai para ~4 tokens).
 *  - 'user-invocable-only': some do listing do modelo, mas /nome continua funcionando.
 *  - 'off': some dos dois.
 */
export type SkillOverride = 'on' | 'name-only' | 'user-invocable-only' | 'off';

/** Estado de UMA skill: custo de metadados + se o corpo já foi carregado no contexto. */
export interface SkillState {
  name: string;
  source?: string; // 'built-in' | 'userSettings' | 'plugin'… (skillFrontmatter.source)
  metaTokens?: number; // custo do listing desta skill (get_context_usage)
  listed: boolean; // apareceu no listing da última leitura
  override?: SkillOverride; // ausente = 'on'
  // Corpo do SKILL.md injetado nesta sessão. O CLI NÃO emite evento próprio: isso vem
  // do tool_use `Skill` (invocação pelo modelo), de um /nome enviado pelo Cockpit ou de um
  // hook cujo texto injetado casa com o corpo do SKILL.md em disco ('hook', inferido).
  active?: boolean;
  activeTokens?: number; // ESTIMATIVA (chars/4). Ausente quando invocada por /nome.
  activatedAt?: number;
  invokedBy?: 'model' | 'user' | 'hook';
}

/**
 * Contexto injetado por um HOOK (`system/hook_response`), agrupado por hook. Vale para
 * qualquer hook — o texto entra no prompt e pesa, seja skill ou não. Quando o texto casa
 * com o corpo de um SKILL.md em disco, `skill` diz qual (inferência, rotulada na UI).
 */
export interface HookInjection {
  hook: string; // hook_name, ex.: 'SessionStart:startup'
  event?: string; // hook_event, ex.: 'SessionStart'
  count: number; // quantas vezes injetou nesta sessão
  tokens: number; // ESTIMATIVA (chars/4) do total injetado
  skill?: string; // skill reconhecida pelo corpo, quando houver
}

// --- Plugins (modal "Plugins") ---
export interface InstalledPlugin {
  id: string; // name@marketplace
  version?: string;
  scope?: string; // user | project | local
  enabled: boolean;
  description?: string; // do manifest plugin.json
  url?: string; // homepage/repo/author do manifest
  kind?: string; // type: skills|agents|commands|mcp|hooks|mixed (from the components)
}
export interface AvailablePlugin {
  pluginId: string; // name@marketplace
  name: string;
  description?: string;
  marketplaceName?: string;
  installCount?: number;
  url?: string; // source repository (source.url)
  kind?: string; // type (classified by Haiku)
}
export interface Marketplace {
  name: string;
  source?: string; // github | git | path
  repo?: string;
}
export interface PluginsData {
  installed: InstalledPlugin[];
  available: AvailablePlugin[];
  marketplaces: Marketplace[];
}

// --- Account & Usage ("Usage" button) ---
export interface UsageAccount {
  loggedIn: boolean;
  authMethod?: string; // 'claude.ai' | 'console' | …
  apiProvider?: string;
  email?: string;
  orgName?: string;
  plan?: string; // subscriptionType ('max' | 'pro' | …)
  loginExpiresAt?: number; // epoch ms — validade do login (refresh token)
}
export interface UsageBucket {
  usedPct?: number; // 0..1
  resetsAt?: string; // ISO 8601
  tokens?: number; // local estimate (when there is no real %)
  usd?: number;
}
/** Weekly window restricted to a scope (e.g. one model). The label comes from the server. */
export interface ScopedBucket extends UsageBucket {
  label: string; // display_name do escopo (ex.: "Fable", "Sonnet")
}
/** A slice of the usage breakdown (per model or per source). */
export interface UsageSlice {
  key: string; // id do modelo, ou 'main' | 'subagent'
  usd: number;
  tokens: number; // tokens NOVOS: input + output + cache-create
  cacheRead: number; // context re-read from the cache (dominates the total; displayed separately)
}

/** Detalhamento local da janela de 7 dias (sempre estimativa de tabela). */
export interface UsageBreakdown {
  byModel: UsageSlice[];
  bySource: UsageSlice[]; // main vs. subagent (sidechain)
}

/** Context injected by a tool (estimated sum of the tool_results). */
export interface ToolContextSlice {
  key: string; // nome da tool; "mcp:<servidor>" ou "skill:<nome>" quando agrupada
  calls: number;
  tokens: number;
}

/** 7-day usage attribution: where the tokens went. */
export interface UsageAttribution {
  longContextPct: number; // 0..1 — share generated with context > 150k
  subagentPct: number; // 0..1 — parcela vinda de subagentes
  cacheHitPct?: number; // 0..1 — cache_read / (cache_read + cache_creation)
  byTool: ToolContextSlice[]; // maior primeiro
}

/** Tokens of a single day (local YYYY-MM-DD key). */
export interface DailyTokens {
  date: string; // YYYY-MM-DD no fuso local
  sent: number; // input + cache_read + cache_creation
  received: number; // output
}

/** GLOBAL token counter (every instance/context on the machine). */
export interface TokenTotals {
  sent: number; // all-time
  received: number; // all-time
  total: number; // sent + received
  days: DailyTokens[]; // recorte por dia (mais recente primeiro)
}

export interface UsageData {
  account: UsageAccount;
  // fiveHour = current session window; sevenDay = weekly "all models";
  // weeklyScoped = per-model weekly windows (e.g. Fable), labelled by the server.
  buckets: { fiveHour?: UsageBucket; sevenDay?: UsageBucket; weeklyScoped?: ScopedBucket[] };
  source: 'api' | 'statusline' | 'stream' | 'estimate'; // origin of the %
  trackingEnabled: boolean; // wrapper de statusline instalado (captura rate_limits real)
  // Detalhamento local 7d (por modelo / origem) — estimativa, sempre presente.
  breakdown?: UsageBreakdown;
  // Local 7d attribution: long context, subagents, cache hit rate, tools/MCP.
  attribution?: UsageAttribution;
  // Global token counter (sent/received/total) per day — the whole machine.
  tokens?: TokenTotals;
  // OTEL telemetry (opt-in) aggregated by the local receiver — absent when off.
  otel?: OtelStats;
  generatedAt: string; // ISO 8601
}

/** Aggregated statistics from Claude Code's OTEL telemetry (opt-in, local). */
export interface OtelStats {
  enabled: boolean; // receiver ligado e escutando
  endpoint?: string; // ex.: http://127.0.0.1:4318 (for the user to point OTEL at)
  sinceTs?: number; // epoch ms of the collection start
  linesAdded?: number; // claude_code.lines_of_code.count (type=added)
  linesRemoved?: number; // claude_code.lines_of_code.count (type=removed)
  locByModel?: UsageSlice[]; // LOC por modelo (tokens = linhas)
  costByModel?: UsageSlice[]; // custo REAL por modelo (claude_code.cost.usage, USD)
  sessionCount?: number; // claude_code.session.count
  commitCount?: number; // claude_code.commit.count
  prCount?: number; // claude_code.pull_request.count
  toolDecisions?: { tool: string; accept: number; reject: number }[]; // claude_code.code_edit_tool.decision
  workflows?: WorkflowRun[]; // custo/tokens por run de workflow (maior custo primeiro)
}

/** A workflow run reconstructed from the telemetry (`workflow.*` attributes, CLI 2.1.202). */
export interface WorkflowRun {
  runId: string;
  name: string;
  usd: number; // REAL cost summed from the run's agents
  tokens: number;
  effort?: string; // effort(s) of the run's agents (low…max), CLI 2.1.214; absent when the model doesn't support it
}

// --- MCP (painel 🔌 Servers) ---
/** An MCP server: its state now + the tools it exposes in this session. */
export interface McpServerInfo {
  name: string;
  // 'pending' = `.mcp.json` not approved (the CLI won't even start the server — 2.1.196).
  status: 'connected' | 'failed' | 'pending' | 'unknown';
  connected: boolean;
  target?: string; // comando (stdio) ou URL (http/sse), sem o sufixo `(HTTP)`/`(SSE)`
  transport?: string; // 'HTTP' | 'SSE' — só p/ servidores remotos; ausente = stdio
  notConfigured?: boolean; // remoto declarado sem URL (a CLI 2.1.208 mostra "not configured")
  tools: string[]; // nomes curtos, sem o prefixo `mcp__<server>__`
}

export interface McpData {
  servers: McpServerInfo[];
  generatedAt: string; // ISO 8601
}

export interface SessionConfig {
  model: string; // valor selecionado ('default' = padrão do CLI)
  effort: string; // 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  models: string[]; // flat options (compat)
  modelGroups?: ModelGroup[]; // grouped options (aliases / versions / active)
  modelMeta?: Record<string, ModelMeta>; // context (real, /v1/models) + price (docs) per id
  efforts: string[];
  defaultModel?: string; // o que 'Default' resolve (settings.model ou init observado)
  defaultEffort?: string; // settings.effortLevel
  permissionMode: string;
  permissionModes: string[];
  allowAgents: boolean; // liberar agentes (Task) e workflows (Workflow); off economiza tokens
  showThinking: boolean; // expand thinking by default
  spellCheck: boolean; // spell-check while typing (composer overlay)
  expandToolCards: boolean; // expand tool cards by default in the timeline
  pendingRestart: boolean; // model/effort/permission changed and restarts on the next send
  userName: string; // nome do assinante para o rótulo "You" (vazio = usa o padrão)
  voiceCorrect: boolean; // correct the dictated text via Haiku when dictation stops
  verbosity: string; // verbose|necessary|dialogo|quiet — what to show in the timeline
}

export interface ModelGroup {
  label: string; // 'aliases' | 'versions' | 'active' | 'discovered'
  items: string[];
}

// Per-model metadata for the selector (context/price columns).
// The context comes REAL from the Models API (/v1/models: max_input_tokens); the price from the
// pricing docs (there is no price endpoint). Absent fields = unknown.
export interface ModelMeta {
  contextTokens?: number; // janela de contexto (max_input_tokens)
  inMTok?: number; // input price in USD per 1M tokens
  outMTok?: number; // output price in USD per 1M tokens
  priceMult?: number; // multiplicador de entrada normalizado (Opus 4.8 = 1x)
}

// Existing session/conversation ("context") to resume.
export interface SessionInfo {
  id: string;
  title: string;
  updatedAt: string; // ISO 8601
  messageCount: number;
  // Extra statistics for the card's rich hint (all optional/tolerant).
  createdAt?: string; // ISO 8601 — transcript creation
  sizeBytes?: number; // tamanho do .jsonl
  userCount?: number; // user messages
  assistantCount?: number; // mensagens do assistente
  toolCount?: number; // chamadas de tool (tool_use)
  model?: string; // last observed model
}

// One option of an AskUserQuestion question.
export interface AskOption {
  label: string;
  description?: string;
}

// One AskUserQuestion question (the UI renders one tab per question).
export interface AskQuestion {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: AskOption[];
}

// Permission suggestion that accompanies can_use_tool (e.g. setMode acceptEdits).
export interface PermissionSuggestion {
  type?: string;
  mode?: string;
  destination?: string;
  [k: string]: unknown;
}

// Item rebuilt from the transcript to render the history when resuming.
export type HistoryItem =
  | { kind: 'user'; id: string; text: string; images?: string[]; ts?: number }
  | { kind: 'assistant'; id: string; text: string; thinking: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: unknown;
      result?: unknown;
      isError?: boolean;
      ts?: number;
    };

// Parallel tab/session: metadata the host keeps (id, title, status).
export interface TabInfo {
  id: string;
  title: string;
  status: 'idle' | 'busy' | 'error';
  sessionId?: string; // the session's transcript id (matches SessionInfo.id)
}

// Metadata of a vault credential (it never carries the secret value).
export interface CredentialMeta {
  id: string;
  name: string;
  username?: string;
  note?: string;
  createdAt: number;
}

// A background task in progress (Workflow / tool with run_in_background).
export interface BackgroundTask {
  id: string; // tool_use id that launched it (matches the <tool-use-id> of the notification)
  tool: string; // 'Workflow' | 'Task' | 'Bash' | …
  label: string; // what it is doing (workflow name / description / command)
}

// host -> webview. Every message can carry `tab` (the origin tab id):
// conversation/stats messages are routed to that tab's state; global
// messages (ready/config/cliStatus/locale/sessions/tabs) come without `tab`.
export type HostToWebview = HostMsg & { tab?: string };

type HostMsg =
  | { kind: 'ready'; locale: string }
  | { kind: 'tabs'; tabs: TabInfo[]; activeTab: string }
  | { kind: 'config'; config: SessionConfig }
  | {
      kind: 'cliStatus';
      available: boolean;
      version?: string;
      error?: string;
      latest?: string; // latest published Claude CLI version (npm)
      cockpitVersion?: string; // this extension's version
    }
  | {
      kind: 'sessionInit';
      sessionId: string;
      model?: string;
      cwd?: string;
      mode?: string;
      tools?: string[];
      mcpServers?: { name: string; status: string }[];
      slashCommands?: string[];
    }
  | { kind: 'assistantStart'; id: string }
  | { kind: 'assistantText'; id: string; delta: string }
  | { kind: 'assistantDone'; id: string }
  | { kind: 'thinking'; id: string; delta: string }
  | { kind: 'toolUse'; id: string; name: string; input: unknown }
  | { kind: 'toolResult'; toolUseId: string; content: unknown; isError?: boolean }
  | {
      kind: 'permissionRequest';
      requestId: string;
      tool: string;
      displayName?: string;
      description?: string;
      input: unknown;
      suggestions?: PermissionSuggestion[];
      oldText?: string; // current content on disk (Write) for the diff
    }
  | { kind: 'askRequest'; requestId: string; questions: AskQuestion[] }
  | { kind: 'authRequired' }
  | { kind: 'stats'; stats: StatsSnapshot }
  // Session timeline/compactions (heavy): sent per turn, not per token.
  | { kind: 'statsTimeline'; timeline: TimelineSample[]; compactions: CompactionEvent[] }
  | { kind: 'turnComplete'; costUsd?: number; usage?: Usage }
  | { kind: 'busy'; busy: boolean }
  // Background task(s) (Workflow / run_in_background) still running after the
  // turn ended: the `result` clears busy, but the work goes on. It keeps the
  // "running" indicator in the timeline and in the Hub card until the notification arrives,
  // and lists what each process is doing (label) so the user is aware.
  | { kind: 'background'; tasks: BackgroundTask[] }
  | { kind: 'error'; message: string }
  | { kind: 'sessions'; sessions: SessionInfo[]; cwd: string }
  | { kind: 'slashCommands'; commands: string[] }
  | { kind: 'slashMeta'; meta: Record<string, SlashCmdMeta> }
  | { kind: 'slashResearching'; busy: boolean }
  | { kind: 'history'; items: HistoryItem[] }
  | { kind: 'resolvedPath'; requestId: string; text: string }
  | { kind: 'openSessions' }
  | { kind: 'taskTimings'; timings: Record<string, number> } // averages per type, already in the current (model,effort) scope (gauge)
  | { kind: 'usageData'; data: UsageData } // resposta ao botão "Usage"
  | { kind: 'effortGate'; selected: string; min: string } // effort < the folder CLAUDE.md minimum: confirm first
  | { kind: 'voiceCorrected'; text: string } // ditado: texto corrigido (libera o input)
  | { kind: 'voiceCorrectError' } // dictation: correction failed (keeps the original, unblocks)
  | { kind: 'draftRestore'; text: string } // restores the draft/dictation after a renderer reload/crash
  | { kind: 'voiceDict'; data: VoiceDictData } // the account's dictation dictionary (answer to the modal)
  | { kind: 'voiceReady' } // dictation: WS open + mic actually capturing (you may speak)
  | { kind: 'voiceTranscript'; text: string; isFinal: boolean } // dictation: partial/final transcription
  | { kind: 'voiceError'; message: string } // dictation: failure (no token, ws, etc.)
  | { kind: 'voiceClosed' } // dictation: session ended
  | { kind: 'auth'; loggedIn: boolean } // estado de login (mostra Sign in OU Sign out)
  | { kind: 'pluginsData'; data: PluginsData } // lista de plugins/marketplaces (modal)
  | { kind: 'pluginsBusy'; busy: boolean; label?: string } // operation in progress
  | { kind: 'pluginsError'; message: string } // a plugin action failed
  | { kind: 'skillsBusy'; busy: boolean } // leitura do get_context_usage em curso
  // Corpo de um SKILL.md entrou no contexto: marca isso no card do Skill no timeline.
  // `tokens` é ESTIMATIVA (tamanho da mensagem injetada); ausente = engine não informou.
  | { kind: 'skillLoaded'; toolUseId: string; name: string; tokens?: number }
  // Um HOOK injetou texto no contexto (sem tool_use para selar): vira item próprio no
  // timeline. `skill` sai quando o texto casa com o corpo de um SKILL.md em disco.
  | { kind: 'hookInjected'; hook: string; event?: string; skill?: string; tokens?: number }
  | { kind: 'mcpData'; data: McpData } // servidores MCP + tools (modal)
  | { kind: 'mcpBusy'; busy: boolean } // health-check do `claude mcp list` em curso
  | { kind: 'locale'; locale: string }
  // Spell-checker (host via hunspell-asm): result of a check (wrong words)
  // and of suggestions (per language).
  | { kind: 'spellResult'; bad: string[] }
  | { kind: 'spellSuggestResult'; requestId: string; word: string; pt: string[]; en: string[] }
  // --- Cofre de credenciais (TOTP 2FA) ---
  | { kind: 'credsData'; enrolled: boolean; items: CredentialMeta[] } // estado do cofre
  | { kind: 'credsSetup'; qrSvg: string; secret: string; uri: string } // enrollment: QR + segredo
  | { kind: 'credsValue'; id: string; name: string; value: string } // valor liberado p/ injetar no composer
  | { kind: 'credsResult'; ok: boolean; action: string; message?: string } // result of an action
  | { kind: 'credsError'; message: string } // failure (storage unavailable, etc.)
  // Editor selection/active file to share as @file#a-b (composer toggle).
  | { kind: 'selection'; ref?: string }
  // Autocomplete de @-mention: resultados de arquivos p/ a query digitada.
  | { kind: 'mentionResults'; requestId: string; items: string[] };

// Metadados de um slash command pesquisados por IA (cache global ~/.claude).
// `category` is an enum key (session|context|config|tools|account|info|plugin|other);
// `hint`/`detail` already come in the Cockpit's language.
export interface SlashCmdMeta {
  category: string;
  hint: string;
  detail?: string;
  group?: string; // name of the third-party plugin/tool (its own group)
}

// Dictation dictionary (per login): terms to recognize/preserve + replacements.
export interface VoiceReplacement {
  from: string; // how it is usually heard/transcribed
  to: string; // how it should be written
}
export interface VoiceDictData {
  terms: string[];
  replacements: VoiceReplacement[];
  account?: string; // account it belongs to (informative label)
  spellWords?: string[]; // spell-checker dictionary (added/ignored words)
}

// Attached image (base64 without the data: prefix).
export interface ImageAttachment {
  mediaType: string;
  data: string;
}

// webview -> host
export type WebviewToHost =
  | { kind: 'init' }
  | { kind: 'heartbeat' } // render liveness beat: prolonged silence = dead renderer (blank screen)
  | { kind: 'sendMessage'; text: string; images?: ImageAttachment[]; force?: boolean; selection?: string }
  | { kind: 'resolvePaths'; requestId: string; absPaths: string[] }
  | { kind: 'readClipboardFiles'; requestId: string }
  | { kind: 'openLink'; href: string; preview?: boolean }
  | { kind: 'interrupt' }
  | { kind: 'newSession' }
  | {
      kind: 'permissionDecision';
      requestId: string;
      decision: 'allow' | 'deny' | 'allow_always';
      message?: string; // feedback (plan mode editável: notas ao "manter planejando")
    }
  | { kind: 'askResponse'; requestId: string; answers: Record<string, string> }
  | { kind: 'setModel'; model: string }
  | { kind: 'setEffort'; effort: string }
  | { kind: 'setPermissionMode'; mode: string }
  | { kind: 'setAllowAgents'; value: boolean }
  | { kind: 'renameSession'; sessionId: string; name: string }
  | { kind: 'openSettings' }
  | { kind: 'listSessions' }
  | { kind: 'resumeSession'; sessionId: string }
  | { kind: 'reloadSession'; sessionId: string }
  | { kind: 'remoteControl'; sessionId: string } // publishes the session for remote control (phone)
  | { kind: 'deleteSession'; sessionId: string }
  | { kind: 'deleteAllSessions' }
  | { kind: 'setLocale'; locale: string }
  | { kind: 'newTab' }
  | { kind: 'closeTab'; tabId: string }
  | { kind: 'switchTab'; tabId: string }
  | { kind: 'installCli' }
  | { kind: 'updateCli' }
  | { kind: 'recheckCli' }
  | { kind: 'loginCli' }
  | { kind: 'logoutCli' }
  | { kind: 'clearContext' }
  | { kind: 'compactContext' }
  | { kind: 'mentionSearch'; requestId: string; query: string } // @-mention: busca arquivos
  | { kind: 'openDiff'; tool: string; input: unknown } // abre o diff proposto no editor nativo
  | { kind: 'draftChanged'; text: string } // espelha o rascunho/ditado no host (anti-perda)
  // Exports the conversation to a .md at the project root. mode 'direct' = mechanical (the
  // markdown is already built); 'ai' = rewritten via the CLI (same model/effort, spends tokens).
  | { kind: 'exportMd'; markdown: string; fileName?: string; mode: 'direct' | 'ai' }
  | { kind: 'voiceDictGet' } // modal: loads the account's dictation dictionary
  | { kind: 'voiceDictSave'; data: VoiceDictData } // modal: saves the dictation dictionary
  | { kind: 'setKeepCacheAlive'; value: boolean } // liga/desliga o keep-alive do cache desta aba
  | { kind: 'openEditor' }
  | { kind: 'openFolder'; path: string }
  | { kind: 'taskDuration'; type: string; ms: number } // task duration sample (gauge)
  | { kind: 'rewind'; index: number } // rewinds the conversation to the (index)-th user prompt, removing it
  | { kind: 'voiceStart'; language?: string } // ditado: host abre o WS + captura o mic (ffmpeg)
  | { kind: 'voiceStop' } // ditado: finaliza a captura
  | { kind: 'voiceCorrect'; text: string } // ditado: corrige o texto via Haiku (one-shot)
  | { kind: 'pluginsRefresh'; force?: boolean } // modal Plugins: (re)carrega; force = re-valida URLs via Haiku
  | { kind: 'mcpRefresh' } // modal MCP: (re)carrega init + `claude mcp list`
  // Painel Skills: relê o get_context_usage (control_request, sem gastar turno).
  | { kind: 'skillsRefresh' }
  // Painel Skills: muda o override de UMA skill (aplica no próximo spawn do CLI).
  | { kind: 'skillOverrideSet'; name: string; value: SkillOverride }
  | {
      kind: 'pluginAction';
      action: 'install' | 'uninstall' | 'enable' | 'disable' | 'update' | 'marketAdd' | 'marketRemove';
      arg: string;
      scope?: string;
    }
  | { kind: 'fetchUsage' } // botão "Usage": busca conta + limites + breakdown (dado quente)
  | { kind: 'enableUsageTracking' } // instala o wrapper de statusline p/ capturar rate_limits real
  | { kind: 'saveImage'; mediaType: string; data: string }
  // Spell-checker: checks a batch of words; asks for suggestions for one; adds
  // to the user dictionary (persistent in the host).
  | { kind: 'spellCheck'; words: string[] }
  | { kind: 'spellSuggest'; requestId: string; word: string }
  | { kind: 'spellAdd'; word: string }
  // --- Cofre de credenciais (TOTP 2FA) ---
  | { kind: 'credsLoad' } // pede o estado do cofre (enrolado? lista)
  | { kind: 'credsEnrollBegin' } // gera segredo TOTP novo (devolve QR)
  | { kind: 'credsEnrollConfirm'; code: string } // confirms the enrollment with the first code
  | { kind: 'credsAdd'; code: string; name: string; username?: string; value: string; note?: string }
  // Edit: absent/undefined value = keeps the current value; present = replaces it.
  | { kind: 'credsEdit'; code: string; id: string; name: string; username?: string; value?: string; note?: string }
  | { kind: 'credsUse'; code: string; id: string } // usa: valida TOTP e devolve o valor
  | { kind: 'credsDelete'; code: string; id: string };
