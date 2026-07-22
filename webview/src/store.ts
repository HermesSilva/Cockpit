// Webview reducer: applies HostToWebview messages to the UI state.
// The state is split into global (locale, cli, config, sessions on disk) and per tab
// (each tab = a parallel session with its own conversation/stats/todos).
import type {
  HostToWebview,
  StatsSnapshot,
  SessionConfig,
  SessionInfo,
  SlashCmdMeta,
  BackgroundTask,
} from '../../shared/protocol';
import type {
  TimelineItem,
  PermissionRequest,
  AskRequest,
  AssistantItem,
  ToolItem,
  HookItem,
  TodoItem,
  TurnUsage,
} from './types';

export interface TabState {
  id: string;
  title: string;
  status: 'idle' | 'busy' | 'error';
  // Background tasks (Workflow / run_in_background) still running after the
  // turn ended. Independent of `status`: the composer stays enabled, but the
  // timeline and the Hub card show the "running" spinner and the list of what
  // each process is doing. `bgBusy` = derived (bgTasks.length > 0).
  bgTasks?: BackgroundTask[];
  bgBusy?: boolean;
  sessionId?: string; // id do transcript (casa com SessionInfo.id); vem do 'tabs'
  session?: { sessionId: string; model?: string; cwd?: string; mode?: string };
  items: TimelineItem[];
  historyLoaded?: boolean; // 1ª mensagem 'history' já chegou (timeline pronta p/ pintar)
  stats?: StatsSnapshot;
  todos: TodoItem[];
  slashCommands: string[];
  permission?: PermissionRequest;
  ask?: AskRequest;
  // Answers recorded for AskUserQuestion in this tab (key = the question text).
  // It feeds the inline view; resumed sessions fall back to parsing the tool_result.
  answers?: Record<string, string>;
  authRequired?: boolean;
}

export interface UiState {
  locale: string;
  cli: {
    available: boolean;
    checked?: boolean; // the host already reported the status (false = still loading)
    version?: string;
    error?: string;
    latest?: string; // latest Claude CLI version (npm)
    cockpitVersion?: string; // the extension's version
  };
  config?: SessionConfig;
  sessions: SessionInfo[];
  sessionsCwd?: string;
  slashMeta: Record<string, SlashCmdMeta>; // metadata of commands researched by AI
  slashResearching: boolean; // AI research in progress (indicator on the button)
  showSessions: boolean;
  showContext: boolean;
  error?: string;
  loggedIn: boolean; // login state (Sign in vs Sign out). Optimistic until confirmed.
  selectionRef?: string; // @file#a-b of the editor's active selection (shareable)
  tabs: TabState[];
  activeTab: string;
}

export const initialState: UiState = {
  locale: 'en',
  cli: { available: false },
  sessions: [],
  slashMeta: {},
  slashResearching: false,
  showSessions: false,
  showContext: false,
  loggedIn: true,
  tabs: [],
  activeTab: '',
};

function emptyTab(id: string, title = '', status: TabState['status'] = 'idle'): TabState {
  return { id, title, status, items: [], todos: [], slashCommands: [] };
}

/** Active tab (or undefined when there is none yet). */
export function activeTab(state: UiState): TabState | undefined {
  return state.tabs.find((t) => t.id === state.activeTab);
}

let userSeq = 0;
export function nextUserId(): string {
  return `u_${Date.now()}_${userSeq++}`;
}

export type Action =
  | { type: 'host'; msg: HostToWebview }
  | { type: 'localUser'; text: string; images?: string[] }
  | { type: 'removeLastUser' }
  | { type: 'clearPermission' }
  | { type: 'clearAsk'; answers?: Record<string, string> }
  | { type: 'setSessionsOpen'; open: boolean }
  | { type: 'setContextOpen'; open: boolean }
  | { type: 'clearError' }
  | { type: 'interruptUi' };

export function reducer(state: UiState, action: Action): UiState {
  if (action.type === 'localUser') {
    return patchTab(state, state.activeTab, (tab) => ({
      ...tab,
      items: [
        ...tab.items,
        { kind: 'user', id: nextUserId(), text: action.text, images: action.images, ts: Date.now() },
      ],
    }));
  }
  if (action.type === 'removeLastUser') {
    // Undoes the user's last bubble (send blocked by the effort gate).
    return patchTab(state, state.activeTab, (tab) => {
      const idx = [...tab.items].reverse().findIndex((i) => i.kind === 'user');
      if (idx < 0) return tab;
      const at = tab.items.length - 1 - idx;
      return { ...tab, items: tab.items.filter((_, i) => i !== at) };
    });
  }
  if (action.type === 'clearPermission') {
    return patchTab(state, state.activeTab, (tab) => ({ ...tab, permission: undefined }));
  }
  if (action.type === 'clearAsk') {
    const add = action.answers;
    return patchTab(state, state.activeTab, (tab) => ({
      ...tab,
      ask: undefined,
      answers: add ? { ...(tab.answers ?? {}), ...add } : tab.answers,
    }));
  }
  if (action.type === 'setSessionsOpen') {
    return { ...state, showSessions: action.open };
  }
  if (action.type === 'setContextOpen') {
    return { ...state, showContext: action.open };
  }
  if (action.type === 'clearError') {
    return state.error ? { ...state, error: undefined } : state;
  }
  if (action.type === 'interruptUi') {
    // Stop killed the CLI without 'assistantDone': ends the streaming and marks it cancelled.
    return patchTab(state, state.activeTab, (tab) => ({
      ...tab,
      status: 'idle',
      items: tab.items.map((i) =>
        i.kind === 'assistant' && !i.done ? { ...i, done: true, canceled: true } : i,
      ),
    }));
  }

  const msg = action.msg;
  switch (msg.kind) {
    // --- Global ---
    case 'ready':
    case 'locale':
      return { ...state, locale: msg.locale };
    case 'config':
      return { ...state, config: msg.config };
    case 'cliStatus':
      return {
        ...state,
        cli: {
          available: msg.available,
          checked: true,
          version: msg.version,
          error: msg.error,
          latest: msg.latest,
          cockpitVersion: msg.cockpitVersion,
        },
      };
    case 'selection':
      return { ...state, selectionRef: msg.ref };
    case 'sessions':
      return { ...state, sessions: msg.sessions, sessionsCwd: msg.cwd };
    case 'slashMeta':
      return { ...state, slashMeta: { ...state.slashMeta, ...msg.meta } };
    case 'slashResearching':
      return { ...state, slashResearching: msg.busy };
    case 'openSessions':
      return { ...state, showSessions: true };
    case 'auth':
      return { ...state, loggedIn: msg.loggedIn };
    case 'error':
      return { ...state, error: msg.message };
    case 'tabs': {
      const existing = new Map(state.tabs.map((t) => [t.id, t]));
      const tabs = msg.tabs.map((info) => {
        const prev = existing.get(info.id);
        return prev
          ? { ...prev, title: info.title, status: info.status, sessionId: info.sessionId }
          : { ...emptyTab(info.id, info.title, info.status), sessionId: info.sessionId };
      });
      return { ...state, tabs, activeTab: msg.activeTab };
    }

    // --- Per tab ---
    default:
      return patchTab(state, (msg as { tab?: string }).tab ?? state.activeTab, (tab) =>
        tabReducer(tab, msg),
      );
  }
}

// Applies a conversation/stats message to ONE tab's state.
function tabReducer(tab: TabState, msg: HostToWebview): TabState {
  switch (msg.kind) {
    case 'sessionInit':
      return {
        ...tab,
        session: { sessionId: msg.sessionId, model: msg.model, cwd: msg.cwd, mode: msg.mode },
        slashCommands: msg.slashCommands ?? tab.slashCommands,
      };

    case 'assistantStart': {
      // A flowing response = authenticated: clears any login warning.
      const base = tab.authRequired ? { ...tab, authRequired: false } : tab;
      if (base.items.some((i) => i.kind === 'assistant' && i.id === msg.id)) return base;
      const item: AssistantItem = {
        kind: 'assistant',
        id: msg.id,
        text: '',
        thinking: '',
        done: false,
        ts: Date.now(),
      };
      return { ...base, items: [...base.items, item] };
    }

    case 'slashCommands':
      return { ...tab, slashCommands: msg.commands };
    case 'authRequired':
      return { ...tab, authRequired: true };
    case 'assistantText':
      return patchAssistant(tab, msg.id, (a) => ({ ...a, text: a.text + msg.delta }));
    case 'thinking':
      return patchAssistant(tab, msg.id, (a) => ({ ...a, thinking: a.thinking + msg.delta }));
    case 'assistantDone':
      return patchAssistant(tab, msg.id, (a) => ({ ...a, done: true }));

    case 'toolUse': {
      const todos = todosFromToolUse(msg.name, msg.input, tab.todos);
      if (tab.items.some((i) => i.kind === 'tool' && i.id === msg.id)) {
        return todos ? { ...tab, todos } : tab;
      }
      const item: ToolItem = {
        kind: 'tool',
        id: msg.id,
        name: msg.name,
        input: msg.input,
        done: false,
        ts: Date.now(),
      };
      const next = { ...tab, items: [...tab.items, item] };
      return todos ? { ...next, todos } : next;
    }
    // Corpo do SKILL.md entrou no contexto: sela o card do Skill que o disparou.
    case 'skillLoaded': {
      const items = tab.items.map((i) =>
        i.kind === 'tool' && i.id === msg.toolUseId
          ? { ...i, skillLoaded: msg.name, skillTokens: msg.tokens ?? i.skillTokens }
          : i,
      );
      return { ...tab, items };
    }
    // Hook injetou contexto (skill inclusive): item próprio, já que não há card para selar.
    case 'hookInjected': {
      const id = `hook:${msg.hook}`;
      if (tab.items.some((i) => i.kind === 'hook' && i.id === id)) return tab;
      const item: HookItem = {
        kind: 'hook',
        id,
        hook: msg.hook,
        skill: msg.skill,
        tokens: msg.tokens,
        ts: Date.now(),
      };
      return { ...tab, items: [...tab.items, item] };
    }
    case 'toolResult': {
      const owner = tab.items.find(
        (i): i is ToolItem => i.kind === 'tool' && i.id === msg.toolUseId,
      );
      let todos: TodoItem[] | undefined;
      if (owner && isTaskListTool(owner.name)) todos = parseTaskList(msg.content, tab.todos);
      else if (owner && isTaskCreateTool(owner.name)) todos = applyCreateResult(msg.content, tab.todos);
      const items = tab.items.map((i) =>
        i.kind === 'tool' && i.id === msg.toolUseId
          ? { ...i, result: msg.content, isError: msg.isError, done: true, endTs: Date.now() }
          : i,
      );
      return todos ? { ...tab, items, todos } : { ...tab, items };
    }

    case 'stats':
      return { ...tab, stats: msg.stats };

    case 'background':
      return { ...tab, bgTasks: msg.tasks, bgBusy: msg.tasks.length > 0 };

    case 'history': {
      const items: TimelineItem[] = msg.items.map((h) =>
        h.kind === 'assistant' ? { ...h, done: true } : h.kind === 'tool' ? { ...h, done: true } : h,
      );
      return {
        ...tab,
        items,
        historyLoaded: true,
        permission: undefined,
        ask: undefined,
        authRequired: false,
        todos: todosFromHistory(items),
      };
    }

    case 'permissionRequest':
      return {
        ...tab,
        permission: {
          requestId: msg.requestId,
          tool: msg.tool,
          displayName: msg.displayName,
          description: msg.description,
          input: msg.input,
          suggestions: msg.suggestions,
          oldText: msg.oldText,
        },
      };
    case 'askRequest':
      return { ...tab, ask: { requestId: msg.requestId, questions: msg.questions } };

    case 'turnComplete': {
      // Attaches the turn's cost/token usage to the last assistant (communication data
      // the engine emits in the result but the UI showed nowhere).
      const u = msg.usage;
      const usage: TurnUsage | undefined = u
        ? {
            input: u.input_tokens,
            output: u.output_tokens,
            cacheCreate: u.cache_creation_input_tokens,
            cacheRead: u.cache_read_input_tokens,
          }
        : undefined;
      let idx = -1;
      for (let i = tab.items.length - 1; i >= 0; i--) {
        if (tab.items[i].kind === 'assistant') {
          idx = i;
          break;
        }
      }
      if (idx < 0) return tab;
      const items = tab.items.map((it, i) =>
        i === idx ? { ...(it as AssistantItem), usage, costUsd: msg.costUsd, endTs: Date.now() } : it,
      );
      return { ...tab, items };
    }

    default:
      return tab;
  }
}

function patchTab(state: UiState, tabId: string, fn: (tab: TabState) => TabState): UiState {
  if (!tabId) return state;
  let found = false;
  const tabs = state.tabs.map((t) => {
    if (t.id === tabId) {
      found = true;
      return fn(t);
    }
    return t;
  });
  if (!found) {
    // The event arrived before the tab list: creates the tab on demand.
    tabs.push(fn(emptyTab(tabId)));
  }
  return { ...state, tabs };
}

function patchAssistant(tab: TabState, id: string, fn: (a: AssistantItem) => AssistantItem): TabState {
  let found = false;
  const items = tab.items.map((i) => {
    if (i.kind === 'assistant' && i.id === id) {
      found = true;
      return fn(i);
    }
    return i;
  });
  if (!found) items.push(fn({ kind: 'assistant', id, text: '', thinking: '', done: false }));
  return { ...tab, items };
}

// --- Task panel: fed by TodoWrite and by Task* tools (MCP) ---

type Status = TodoItem['status'];

function todosFromToolUse(name: string, input: unknown, prev: TodoItem[]): TodoItem[] | undefined {
  if (name === 'TodoWrite') return extractTodos(input);
  if (isTaskUpdateTool(name)) return updateTask(input, prev);
  if (isTaskCreateTool(name)) return appendTask(input, prev);
  return undefined;
}

// Rebuilds the task state when reopening a session, replaying the sequence
// of Task*/TodoWrite tools from the transcript in order (create -> result -> update).
function todosFromHistory(items: TimelineItem[]): TodoItem[] {
  let todos: TodoItem[] = [];
  for (const it of items) {
    if (it.kind !== 'tool') continue;
    const name = it.name;
    if (name === 'TodoWrite') {
      todos = extractTodos(it.input) ?? todos;
    } else if (isTaskCreateTool(name)) {
      todos = appendTask(it.input, todos) ?? todos;
      todos = applyCreateResult(it.result, todos) ?? todos;
    } else if (isTaskUpdateTool(name)) {
      todos = updateTask(it.input, todos) ?? todos;
    } else if (isTaskListTool(name)) {
      todos = parseTaskList(it.result, todos) ?? todos;
    }
  }
  return todos;
}

function extractTodos(input: unknown): TodoItem[] | undefined {
  const t = (input as { todos?: unknown })?.todos;
  if (!Array.isArray(t)) return undefined;
  return t
    .filter((x): x is TodoItem => !!x && typeof (x as TodoItem).content === 'string')
    .map((x) => ({
      content: x.content,
      status: x.status,
      activeForm: x.activeForm,
      description: (x as TodoItem).description,
    }));
}

const isTaskCreateTool = (name: string) => /task.*(create|add|new)|(create|add|new).*task/i.test(name);
const isTaskListTool = (name: string) => /task.*list|list.*task/i.test(name);
const isTaskUpdateTool = (name: string) =>
  /task.*(update|status|complete|done|set|edit|patch)|(update|complete|finish).*task/i.test(name);

// Tool that feeds the task panel (TodoWrite or the MCP Task*).
// It does NOT include the plain "Task"/"Agent" (subagent launcher).
export const isTodoToolName = (name: string): boolean =>
  name === 'TodoWrite' || isTaskCreateTool(name) || isTaskListTool(name) || isTaskUpdateTool(name);

function appendTask(input: unknown, prev: TodoItem[]): TodoItem[] | undefined {
  const o = (input ?? {}) as Record<string, unknown>;
  const subject =
    typeof o.subject === 'string' ? o.subject : typeof o.content === 'string' ? o.content : undefined;
  if (!subject) return undefined;
  if (prev.some((p) => p.content === subject)) return undefined;
  return [
    ...prev,
    {
      content: subject,
      status: 'pending',
      description: typeof o.description === 'string' ? o.description : undefined,
      activeForm: typeof o.activeForm === 'string' ? o.activeForm : undefined,
    },
  ];
}

const STATUS_WORD: Record<string, Status> = {
  completed: 'completed', complete: 'completed', done: 'completed', finished: 'completed', ok: 'completed',
  in_progress: 'in_progress', 'in progress': 'in_progress', active: 'in_progress', running: 'in_progress',
  doing: 'in_progress', current: 'in_progress', wip: 'in_progress',
  pending: 'pending', todo: 'pending', open: 'pending', queued: 'pending', waiting: 'pending', 'not started': 'pending',
};
const mapStatus = (s: string): Status => STATUS_WORD[s.trim().toLowerCase()] ?? 'pending';

function updateTask(input: unknown, prev: TodoItem[]): TodoItem[] | undefined {
  if (!prev.length) return undefined;
  const o = (input ?? {}) as Record<string, unknown>;
  const statusRaw =
    typeof o.status === 'string' ? o.status : typeof o.state === 'string' ? o.state : undefined;
  const status: Status | undefined = statusRaw ? mapStatus(statusRaw) : undefined;
  if (!status) return undefined;

  const idRaw = o.id ?? o.task_id ?? o.taskId ?? o.number ?? o.index ?? o.n;
  const id = typeof idRaw === 'number' ? idRaw : typeof idRaw === 'string' ? Number(idRaw) : NaN;
  const subject =
    typeof o.subject === 'string'
      ? o.subject
      : typeof o.content === 'string'
        ? o.content
        : typeof o.title === 'string'
          ? o.title
          : typeof o.task === 'string'
            ? o.task
            : typeof o.name === 'string'
              ? o.name
              : undefined;

  let idx = -1;
  if (!Number.isNaN(id)) idx = prev.findIndex((p) => p.id === id);
  if (idx < 0 && subject) idx = prev.findIndex((p) => p.content === subject);
  if (idx < 0) return undefined;
  return prev.map((p, i) => (i === idx ? { ...p, status } : p));
}

function contentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === 'string'
          ? b
          : b && typeof b === 'object' && 'text' in b
            ? String((b as { text: unknown }).text)
            : '',
      )
      .join('\n');
  }
  return '';
}

// TaskCreate result, e.g. "Task #3 created successfully: Load DataCache".
const CREATE_LINE = /task\s*#(\d+)\b[^\n]*?:\s*(.+?)\s*$/i;

// Links the id returned by TaskCreate to the created task (matched by title; otherwise
// the first one without an id) — that is what lets TaskUpdate mark it by id later.
function applyCreateResult(content: unknown, prev: TodoItem[]): TodoItem[] | undefined {
  const m = CREATE_LINE.exec(contentToText(content));
  if (!m) return undefined;
  const id = Number(m[1]);
  const subject = m[2];
  let idx = prev.findIndex((p) => p.content === subject);
  if (idx < 0) idx = prev.findIndex((p) => p.id === undefined);
  if (idx < 0 || prev[idx].id === id) return undefined;
  return prev.map((p, i) => (i === idx ? { ...p, id } : p));
}

const TASK_LINE = /^\s*#?\s*(\d+)[.)]?\s*\[([^\]]+)\]\s*(.+?)\s*$/;

function parseTaskList(content: unknown, prev: TodoItem[]): TodoItem[] | undefined {
  const text = contentToText(content);
  if (!text) return undefined;
  const byContent = new Map(prev.map((p) => [p.content, p]));
  const out: TodoItem[] = [];
  for (const line of text.split('\n')) {
    const m = TASK_LINE.exec(line);
    if (!m) continue;
    const subject = m[3];
    const old = byContent.get(subject);
    out.push({
      content: subject,
      status: mapStatus(m[2]),
      id: Number(m[1]),
      description: old?.description,
      activeForm: old?.activeForm,
    });
  }
  return out.length ? out : undefined;
}
