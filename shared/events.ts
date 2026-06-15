// Schemas dos eventos stream-json emitidos pelo Claude Code CLI.
// Contrato tolerante: tipos desconhecidos caem no índice genérico de ClaudeEvent.
// (Fase 1 do plano de execução — congelar este contrato com fixtures reais.)

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface TextBlock {
  type: 'text';
  text: string;
}
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
}
export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: unknown;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: unknown;
  is_error?: boolean;
}
export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | { type: string; [k: string]: unknown };

// --- Eventos de alto nível (uma linha NDJSON cada) ---

export interface SystemInitEvent {
  type: 'system';
  subtype: 'init';
  session_id: string;
  cwd?: string;
  model?: string;
  tools?: string[];
  mcp_servers?: { name: string; status: string }[];
  permissionMode?: string;
}

export interface AssistantEvent {
  type: 'assistant';
  session_id?: string;
  message: {
    id?: string;
    role: 'assistant';
    model?: string;
    content: ContentBlock[];
    usage?: Usage;
    stop_reason?: string | null;
  };
}

export interface UserEvent {
  type: 'user';
  session_id?: string;
  message: {
    role: 'user';
    content: ContentBlock[] | string;
  };
}

export interface ResultEvent {
  type: 'result';
  subtype: string; // 'success' | 'error_max_turns' | 'error_during_execution' | ...
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  usage?: Usage;
  num_turns?: number;
  duration_ms?: number;
}

// Deltas crus da API (quando --include-partial-messages está ativo).
export type RawStreamEvent =
  | { type: 'message_start'; message: { id: string; model?: string; usage?: Usage } }
  | { type: 'content_block_start'; index: number; content_block: ContentBlock }
  | {
      type: 'content_block_delta';
      index: number;
      delta:
        | { type: 'text_delta'; text: string }
        | { type: 'thinking_delta'; thinking: string }
        | { type: 'input_json_delta'; partial_json: string }
        | { type: string; [k: string]: unknown };
    }
  | { type: 'content_block_stop'; index: number }
  | { type: 'message_delta'; delta: { stop_reason?: string }; usage?: Usage }
  | { type: 'message_stop' }
  | { type: string; [k: string]: unknown };

export interface StreamWrapperEvent {
  type: 'stream_event';
  session_id?: string;
  event: RawStreamEvent;
}

// Limites de uso da conta, emitidos pelo engine no stream-json quando o status
// de um bucket muda. `utilization` (0..1) só vem quando o bucket cruza o limiar
// de warning — em uso baixo só status/resetsAt/rateLimitType (ver claude-code #50518).
export type RateLimitStatus = 'allowed' | 'allowed_warning' | 'rejected';
export type RateLimitBucket =
  | 'five_hour'
  | 'seven_day'
  | 'seven_day_opus'
  | 'seven_day_sonnet'
  | 'overage';

export interface RateLimitInfo {
  status: RateLimitStatus;
  resetsAt?: number; // epoch (segundos)
  rateLimitType?: RateLimitBucket;
  utilization?: number; // fração 0..1; ausente em uso baixo
  overageStatus?: RateLimitStatus;
  isUsingOverage?: boolean;
}

export interface RateLimitEvent {
  type: 'rate_limit_event';
  rate_limit_info: RateLimitInfo;
  uuid?: string;
  session_id?: string;
}

// Protocolo de controle (permissões interativas via stdin/stdout).
export interface ControlRequestEvent {
  type: 'control_request';
  request_id: string;
  request: {
    subtype: string; // 'can_use_tool' | ...
    tool_name?: string;
    input?: unknown;
    [k: string]: unknown;
  };
}

export type ClaudeEvent =
  | SystemInitEvent
  | AssistantEvent
  | UserEvent
  | ResultEvent
  | StreamWrapperEvent
  | ControlRequestEvent
  | RateLimitEvent
  | { type: string; [k: string]: unknown };
