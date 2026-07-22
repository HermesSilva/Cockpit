// UI state model.
export type ItemKind = 'user' | 'assistant' | 'tool';

// Token usage of a turn (normalized for the UI from the engine's usage).
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
  images?: string[]; // data URLs for the preview
  ts?: number; // epoch ms of when the message entered the UI
}

export interface AssistantItem {
  kind: 'assistant';
  id: string;
  text: string;
  thinking: string;
  done: boolean;
  canceled?: boolean;
  ts?: number; // epoch ms of the streaming start
  endTs?: number; // epoch ms of the turn's end (turnComplete)
  usage?: TurnUsage; // attached at the end of the turn (turnComplete)
  costUsd?: number; // turn cost (turnComplete)
}

export interface ToolItem {
  kind: 'tool';
  id: string; // tool_use id
  name: string;
  input: unknown;
  result?: unknown;
  isError?: boolean;
  done: boolean;
  ts?: number; // epoch ms of the tool_use
  endTs?: number; // epoch ms of the tool_result (duration = endTs - ts)
  // Tool `Skill` cujo corpo entrou no contexto. `skillTokens` é ESTIMATIVA (tamanho da
  // mensagem que o engine injetou); ausente = carregou, mas sem tamanho informado.
  skillLoaded?: string;
  skillTokens?: number;
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
