// Modelo de estado da UI.
export type ItemKind = 'user' | 'assistant' | 'tool';

// Uso de tokens de um turno (normalizado p/ a UI a partir do usage do engine).
export interface TurnUsage {
  input?: number;
  output?: number;
  cacheCreate?: number;
  cacheRead?: number;
}

export interface UserItem {
  kind: 'user';
  id: string;
  text: string;
  images?: string[]; // data URLs para preview
  ts?: number; // epoch ms de quando a mensagem entrou na UI
}

export interface AssistantItem {
  kind: 'assistant';
  id: string;
  text: string;
  thinking: string;
  done: boolean;
  canceled?: boolean;
  ts?: number; // epoch ms do início do streaming
  endTs?: number; // epoch ms do fim do turno (turnComplete)
  usage?: TurnUsage; // anexado no fim do turno (turnComplete)
  costUsd?: number; // custo do turno (turnComplete)
}

export interface ToolItem {
  kind: 'tool';
  id: string; // tool_use id
  name: string;
  input: unknown;
  result?: unknown;
  isError?: boolean;
  done: boolean;
  ts?: number; // epoch ms do tool_use
  endTs?: number; // epoch ms do tool_result (duração = endTs - ts)
}

export type TimelineItem = UserItem | AssistantItem | ToolItem;

export interface PermissionSuggestion {
  type?: string;
  mode?: string;
  destination?: string;
  [k: string]: unknown;
}

export interface PermissionRequest {
  requestId: string;
  tool: string;
  displayName?: string;
  description?: string;
  input: unknown;
  suggestions?: PermissionSuggestion[];
  oldText?: string;
}

export interface AskOption {
  label: string;
  description?: string;
}

export interface AskQuestion {
  question: string;
  header: string;
  multiSelect?: boolean;
  options: AskOption[];
}

export interface AskRequest {
  requestId: string;
  questions: AskQuestion[];
}

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
  description?: string;
  id?: number; // número da tarefa quando vem de tools Task* (TaskList "#N", TaskUpdate id)
}
