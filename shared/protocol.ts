// Protocolo de mensagens entre o host da extensão e o webview React.
import type { Usage } from './events';

export interface LimitWindow {
  usedPct?: number; // 0..1 — statusline (sempre) ou stream (só perto do limite)
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

/** Uso acumulado segmentado por modelo (a sessão pode trocar de modelo). */
export interface ModelUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  turns: number;
}

/** Uma amostra da timeline (um ponto por turno) — base dos gráficos de consumo (S10). */
export interface TimelineSample {
  ts: number; // epoch ms
  contextUsed: number; // tamanho do prompt (input + cache_*) no turno
  cacheReadPct: number; // 0..1 — fração lida do cache neste turno (eficiência)
  costUsd: number; // custo acumulado da sessão até aqui
  reset?: boolean; // este turno foi um cache reset (TTL frio)
  compaction?: boolean; // este turno reduziu o contexto (compactação)
}

/** Evento de compactação detectado (contexto encolheu entre turnos) (S11). */
export interface CompactionEvent {
  ts: number;
  before: number;
  after: number;
  saved: number; // before - after
}

export interface StatsSnapshot {
  model?: string;
  mode?: string;
  // Sessão
  sessionStartTs?: number; // epoch ms — início da sessão (system init)
  // Contexto
  contextUsed: number;
  contextLimit: number;
  contextBreakdown?: ContextSlice[];
  // Tokens acumulados na sessão
  inputTokens: number;
  outputTokens: number;
  cacheCreateTokens: number;
  cacheReadTokens: number;
  cacheHitRate: number; // 0..1
  cacheSavingsUsd?: number; // economia estimada (tokens lidos × delta de preço input→read)
  // Custo
  sessionCostUsd: number;
  lastTurnCostUsd: number;
  costIsEstimate: boolean;
  // Aceitação de ferramentas (por tool_name, acumulado na sessão)
  toolAcceptance?: ToolDecision[];
  // --- Persistência/coerência entre reaberturas do contexto ---
  turnCount?: number; // turnos consolidados na sessão
  reopenCount?: number; // quantas vezes o contexto foi reaberto/retomado
  // Cache reset (TTL frio): turno ocioso que perdeu o prefixo e re-escreveu o cache
  cacheResetCount?: number;
  cacheRecacheCostUsd?: number; // $ re-pago em cacheWrite por causa dos resets
  // Compactação (contexto condensado entre turnos) — S11
  compactionCount?: number;
  peakContextUsed?: number; // maior contexto já atingido na sessão
  // Tempo de execução REAL da sessão (soma do tempo de cada prompt; exclui ociosidade)
  activeMs?: number;
  // --- Vida do cache (TTL de 1h) e keep-alive ---
  cacheLifeMs?: number; // janela total do cache (1h)
  cacheAgeMs?: number; // idade desde a última atividade (requisição)
  cacheExpiresInMs?: number; // quanto falta p/ o cache expirar
  cacheExpiresAt?: number; // epoch ms do vencimento — p/ contagem regressiva ao vivo
  cacheAlive?: boolean; // o cache ainda está vivo (idade < 1h)
  keepCacheAlive?: boolean; // checkbox: reenviar p/ o cache não morrer
  // Detalhamento por modelo (S5 estendido)
  perModel?: ModelUsage[];
  // Limites de conta
  limits?: { fiveHour?: LimitWindow; sevenDay?: LimitWindow };
  // Fonte dos limites: statusline (% real completo) > stream (rate_limit_event:
  // status/reset sempre, % só perto do limite) > estimate (tokens÷orçamento local).
  limitsSource?: 'statusline' | 'stream' | 'estimate';
}

// --- Plugins (modal "Plugins") ---
export interface InstalledPlugin {
  id: string; // name@marketplace
  version?: string;
  scope?: string; // user | project | local
  enabled: boolean;
  description?: string; // do manifest plugin.json
  url?: string; // homepage/repo/author do manifest
  kind?: string; // tipo: skills|agents|commands|mcp|hooks|mixed (dos componentes)
}
export interface AvailablePlugin {
  pluginId: string; // name@marketplace
  name: string;
  description?: string;
  marketplaceName?: string;
  installCount?: number;
  url?: string; // repositório de origem (source.url)
  kind?: string; // tipo (classificado pelo Haiku)
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

// --- Account & Usage (botão "Usage") ---
export interface UsageAccount {
  loggedIn: boolean;
  authMethod?: string; // 'claude.ai' | 'console' | …
  apiProvider?: string;
  email?: string;
  orgName?: string;
  plan?: string; // subscriptionType ('max' | 'pro' | …)
}
export interface UsageBucket {
  usedPct?: number; // 0..1
  resetsAt?: string; // ISO 8601
  tokens?: number; // estimativa local (quando não há % real)
  usd?: number;
}
export interface UsageData {
  account: UsageAccount;
  buckets: { fiveHour?: UsageBucket; sevenDay?: UsageBucket; sevenDaySonnet?: UsageBucket };
  source: 'api' | 'statusline' | 'stream' | 'estimate'; // origem dos %
  trackingEnabled: boolean; // wrapper de statusline instalado (captura rate_limits real)
  generatedAt: string; // ISO 8601
}

export interface SessionConfig {
  model: string; // valor selecionado ('default' = padrão do CLI)
  effort: string; // 'default' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  models: string[]; // opções planas (compat)
  modelGroups?: ModelGroup[]; // opções agrupadas (aliases / versões / ativos)
  efforts: string[];
  defaultModel?: string; // o que 'Default' resolve (settings.model ou init observado)
  defaultEffort?: string; // settings.effortLevel
  permissionMode: string;
  permissionModes: string[];
  showThinking: boolean; // expandir thinking por padrão
  expandToolCards: boolean; // expandir cards de tool por padrão na timeline
  pendingRestart: boolean; // model/effort/permission mudou e reinicia no próximo envio
  userName: string; // nome do assinante para o rótulo "You" (vazio = usa o padrão)
  voiceCorrect: boolean; // corrigir o texto ditado via Haiku ao parar o ditado
  verbosity: string; // verbose|necessary|dialogo|quiet — o que mostrar no timeline
}

export interface ModelGroup {
  label: string; // 'aliases' | 'versions' | 'active' | 'discovered'
  items: string[];
}

// Sessão/conversa existente ("contexto") para retomar.
export interface SessionInfo {
  id: string;
  title: string;
  updatedAt: string; // ISO 8601
  messageCount: number;
  // Estatísticas extras p/ o hint rico do card (todas opcionais/tolerantes).
  createdAt?: string; // ISO 8601 — criação do transcript
  sizeBytes?: number; // tamanho do .jsonl
  userCount?: number; // mensagens do usuário
  assistantCount?: number; // mensagens do assistente
  toolCount?: number; // chamadas de tool (tool_use)
  model?: string; // último modelo observado
}

// Uma opção de uma pergunta do AskUserQuestion.
export interface AskOption {
  label: string;
  description?: string;
}

// Uma pergunta do AskUserQuestion (a UI renderiza uma aba por pergunta).
export interface AskQuestion {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: AskOption[];
}

// Sugestão de permissão que acompanha o can_use_tool (ex.: setMode acceptEdits).
export interface PermissionSuggestion {
  type?: string;
  mode?: string;
  destination?: string;
  [k: string]: unknown;
}

// Item reconstruído do transcript para renderizar o histórico ao retomar.
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

// Aba/sessão paralela: metadados que o host mantém (id, título, status).
export interface TabInfo {
  id: string;
  title: string;
  status: 'idle' | 'busy' | 'error';
  sessionId?: string; // id do transcript da sessão (casa com SessionInfo.id)
}

// host -> webview. Toda mensagem pode carregar `tab` (id da aba de origem):
// mensagens de conversa/stats são roteadas para o estado daquela aba; mensagens
// globais (ready/config/cliStatus/locale/sessions/tabs) vêm sem `tab`.
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
      latest?: string; // última versão publicada do Claude CLI (npm)
      cockpitVersion?: string; // versão desta extensão
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
      oldText?: string; // conteúdo atual em disco (Write) p/ diff
    }
  | { kind: 'askRequest'; requestId: string; questions: AskQuestion[] }
  | { kind: 'authRequired' }
  | { kind: 'stats'; stats: StatsSnapshot }
  // Timeline/compactações da sessão (pesado): enviado por turno, não por token.
  | { kind: 'statsTimeline'; timeline: TimelineSample[]; compactions: CompactionEvent[] }
  | { kind: 'turnComplete'; costUsd?: number; usage?: Usage }
  | { kind: 'busy'; busy: boolean }
  | { kind: 'error'; message: string }
  | { kind: 'sessions'; sessions: SessionInfo[]; cwd: string }
  | { kind: 'slashCommands'; commands: string[] }
  | { kind: 'slashMeta'; meta: Record<string, SlashCmdMeta> }
  | { kind: 'slashResearching'; busy: boolean }
  | { kind: 'history'; items: HistoryItem[] }
  | { kind: 'resolvedPath'; requestId: string; text: string }
  | { kind: 'openSessions' }
  | { kind: 'taskTimings'; timings: Record<string, number> } // médias por tipo, já no escopo (modelo,effort) atual (gauge)
  | { kind: 'usageData'; data: UsageData } // resposta ao botão "Usage"
  | { kind: 'effortGate'; selected: string; min: string } // effort < mínimo do CLAUDE.md da pasta: confirmar antes
  | { kind: 'voiceCorrected'; text: string } // ditado: texto corrigido (libera o input)
  | { kind: 'voiceCorrectError' } // ditado: correção falhou (mantém o original, libera)
  | { kind: 'voiceReady' } // ditado: WS aberto + mic capturando de fato (pode falar)
  | { kind: 'voiceTranscript'; text: string; isFinal: boolean } // ditado: transcrição parcial/final
  | { kind: 'voiceError'; message: string } // ditado: falha (sem token, ws, etc.)
  | { kind: 'voiceClosed' } // ditado: sessão encerrada
  | { kind: 'auth'; loggedIn: boolean } // estado de login (mostra Sign in OU Sign out)
  | { kind: 'pluginsData'; data: PluginsData } // lista de plugins/marketplaces (modal)
  | { kind: 'pluginsBusy'; busy: boolean; label?: string } // operação em andamento
  | { kind: 'pluginsError'; message: string } // falha numa ação de plugin
  | { kind: 'locale'; locale: string };

// Metadados de um slash command pesquisados por IA (cache global ~/.claude).
// `category` é uma chave enum (session|context|config|tools|account|info|plugin|other);
// `hint`/`detail` já vêm no idioma do Cockpit.
export interface SlashCmdMeta {
  category: string;
  hint: string;
  detail?: string;
  group?: string; // nome do plugin/ferramenta de terceiro (grupo próprio)
}

// Imagem anexada (base64 sem prefixo data:).
export interface ImageAttachment {
  mediaType: string;
  data: string;
}

// webview -> host
export type WebviewToHost =
  | { kind: 'init' }
  | { kind: 'heartbeat' } // pulso de vida do render: silêncio prolongado = renderer morto (tela branca)
  | { kind: 'sendMessage'; text: string; images?: ImageAttachment[]; force?: boolean }
  | { kind: 'resolvePaths'; requestId: string; absPaths: string[] }
  | { kind: 'readClipboardFiles'; requestId: string }
  | { kind: 'openLink'; href: string; preview?: boolean }
  | { kind: 'interrupt' }
  | { kind: 'newSession' }
  | {
      kind: 'permissionDecision';
      requestId: string;
      decision: 'allow' | 'deny' | 'allow_always';
    }
  | { kind: 'askResponse'; requestId: string; answers: Record<string, string> }
  | { kind: 'setModel'; model: string }
  | { kind: 'setEffort'; effort: string }
  | { kind: 'setPermissionMode'; mode: string }
  | { kind: 'renameSession'; sessionId: string; name: string }
  | { kind: 'openSettings' }
  | { kind: 'listSessions' }
  | { kind: 'resumeSession'; sessionId: string }
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
  | { kind: 'setKeepCacheAlive'; value: boolean } // liga/desliga o keep-alive do cache desta aba
  | { kind: 'openEditor' }
  | { kind: 'openFolder'; path: string }
  | { kind: 'taskDuration'; type: string; ms: number } // amostra de duração de tarefa (gauge)
  | { kind: 'rewind'; index: number } // rebobina a conversa até o (index)-ésimo prompt do usuário, removendo-o
  | { kind: 'voiceStart'; language?: string } // ditado: host abre o WS + captura o mic (ffmpeg)
  | { kind: 'voiceStop' } // ditado: finaliza a captura
  | { kind: 'voiceCorrect'; text: string } // ditado: corrige o texto via Haiku (one-shot)
  | { kind: 'pluginsRefresh'; force?: boolean } // modal Plugins: (re)carrega; force = re-valida URLs via Haiku
  | {
      kind: 'pluginAction';
      action: 'install' | 'uninstall' | 'enable' | 'disable' | 'update' | 'marketAdd' | 'marketRemove';
      arg: string;
      scope?: string;
    }
  | { kind: 'fetchUsage' } // botão "Usage": busca conta + limites + breakdown (dado quente)
  | { kind: 'enableUsageTracking' } // instala o wrapper de statusline p/ capturar rate_limits real
  | { kind: 'saveImage'; mediaType: string; data: string };
