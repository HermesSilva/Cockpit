import { useState, useEffect, useRef, type ReactNode } from 'react';
import type { Translator } from '../i18n';
import type { StatsSnapshot } from '../../../shared/protocol';
import { send } from '../vscodeApi';
import type { TimelineItem, AssistantItem, ToolItem, UserItem, TodoItem, AskQuestion } from '../types';
import { isTodoToolName } from '../store';
import { Markdown } from './Markdown';
import { CodeBlock } from './CodeBlock';
import { DiffView } from './DiffView';
import { TodoCard } from './Todos';
import { useImageViewer } from './ImageViewer';
import { Tooltip, type TooltipRow } from './Tooltip';
import { languageFromPath, stripLineNumbers, richHighlight } from '../util/highlight';
import {
  fmtCompact,
  fmtTk,
  fmtBytes,
  fmtMs,
  fmtUsdShort,
  fmtClock,
  byteLen,
  countWords,
  countLines,
} from '../util/format';

const TOOL_ICONS: Record<string, string> = {
  Read: '📄',
  Write: '📝',
  Edit: '✏️',
  MultiEdit: '✏️',
  NotebookEdit: '📓',
  Bash: '❯',
  Grep: '🔍',
  Glob: '🗂️',
  Task: '🤖',
  Agent: '🤖',
  WebFetch: '🌐',
  WebSearch: '🔎',
  TodoWrite: '☑️',
};
const toolIcon = (name: string): string => TOOL_ICONS[name] ?? '⚙';
const basename = (p: string): string => p.replace(/["']/g, '').split(/[\\/]/).pop() || p;
// Files with a native preview in VSCode ("View" link).
const hasPreview = (p: string): boolean => /\.(md|markdown|svg|png|jpe?g|gif|webp|ipynb)$/i.test(p);

interface Props {
  items: TimelineItem[];
  t: Translator;
  emptyHint: boolean;
  showThinking?: boolean;
  expandTools?: boolean;
  userName?: string;
  todos: TodoItem[];
  answers?: Record<string, string>;
  busy?: boolean; // turno em andamento: mostra o indicador de atividade no fim
  stats?: StatsSnapshot; // tokens enviados/recebidos p/ o contador do indicador
  onRewind?: (userIndex: number) => void; // rewind to this prompt (removing it)
  verbosity?: string; // verbose|necessary|dialogo|quiet — filters the display
}

// Groups items into turns: each user message and, after it, the contiguous
// run of Claude items (text + tools) under a single "Claude" header.
type Group = { kind: 'user'; item: UserItem } | { kind: 'claude'; items: (AssistantItem | ToolItem)[] };

function groupItems(items: TimelineItem[]): Group[] {
  const out: Group[] = [];
  for (const it of items) {
    if (it.kind === 'user') {
      out.push({ kind: 'user', item: it });
      continue;
    }
    const last = out[out.length - 1];
    if (last && last.kind === 'claude') last.items.push(it);
    else out.push({ kind: 'claude', items: [it] });
  }
  return out;
}

function CopyButton({ text, t }: { text: string; t: Translator }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="msg-copy"
      title={t('common.copy')}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        });
      }}
    >
      {done ? '✓' : '⧉'}
    </button>
  );
}

export function Timeline({
  items,
  t,
  emptyHint,
  showThinking,
  expandTools,
  userName,
  todos,
  answers,
  busy,
  stats,
  onRewind,
  verbosity = 'verbose',
}: Props) {
  if (items.length === 0 && emptyHint) {
    return (
      <div className="timeline empty">
        <p className="welcome">{t('empty.welcome')}</p>
        <p className="hint">{t('empty.cliHint')}</p>
      </div>
    );
  }
  const groups = groupItems(items);
  // The task checklist is unique and lives aggregated: it is rendered only in the last
  // turn that touched tasks, avoiding repeating the group on every add/tick.
  let lastTodoGroup = -1;
  let lastUserGroup = -1;
  groups.forEach((g, i) => {
    if (g.kind === 'claude' && g.items.some((it) => it.kind === 'tool' && isTodoToolName(it.name))) {
      lastTodoGroup = i;
    }
    if (g.kind === 'user') lastUserGroup = i;
  });
  // Ordinal of each user prompt (matching the order in the host's transcript),
  // p/ o rewind referenciar o prompt certo independentemente do id local/uuid.
  let userOrdinal = -1;
  return (
    <div className="timeline">
      {groups.map((g, gi) =>
        g.kind === 'user' ? (
          ((userOrdinal += 1),
          (
            <UserBubble
              key={g.item.id}
              item={g.item}
              t={t}
              userName={userName}
              pinned={gi === lastUserGroup}
              onRewind={onRewind ? ((idx) => () => onRewind(idx))(userOrdinal) : undefined}
            />
          ))
        ) : (
          <ClaudeTurn
            key={g.items[0].id}
            items={g.items}
            t={t}
            defaultShowThinking={!!showThinking}
            defaultOpenTools={expandTools !== false}
            todos={todos}
            showTodos={gi === lastTodoGroup}
            answers={answers}
            verbosity={verbosity}
          />
        ),
      )}
      {busy && <ActivityIndicator t={t} items={items} stats={stats} verbosity={verbosity} />}
    </div>
  );
}

// Progress gauge (asymptotic). It only appears after GAUGE_DELAY of waiting —
// short tasks (< 2s) show no gauge, avoiding flicker. When it appears it already starts
// em GAUGE_START (10%) e cresce desacelerando: progress = 1 - (1-START)·e^(-(t-DELAY)/τ),
// with a ceiling of 1 - GAUGE_FLOOR (≈ 97%, never 100%). It restarts on every piece of information received;
// when it completes/ends it simply disappears (no 100% flash). GAUGE_TAU = speed.
const GAUGE_TAU = 25_000;
const GAUGE_FLOOR = 0.03;
const GAUGE_DELAY = 2_000;
const GAUGE_START = 0.1;

// --- Gauge calibration per task type (less "fake") ---
// The average durations per type come from the HOST (persisted in ~/.claude/tootega,
// global for every project/tab/session). The webview sends duration samples and
// consults the received map to derive τ — that way the gauge is fast for typically
// short tasks and slow for long ones, calibrated to the real time.
const TASK_AVG = new Map<string, number>(); // type -> average (ms): mirror of the host
const TAU_TARGET = 0.8; // progress the gauge should reach at the average duration
// τ = (average - DELAY) / k, where k solves progress=TAU_TARGET at the average.
const TAU_K = Math.log((1 - GAUGE_START) / (1 - TAU_TARGET)); // ≈ 1.504
const TAU_MIN = 1_500;
const TAU_MAX = 120_000;

/** Formats ms as min:sec (e.g. 75000 -> "1:15"). */
function fmtMinSec(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Seeds/updates the local mirror with the averages coming from the host. */
export function seedTaskTimings(timings: Record<string, number>): void {
  TASK_AVG.clear();
  for (const [k, v] of Object.entries(timings)) if (Number.isFinite(v)) TASK_AVG.set(k, v);
}
// Type of the task in progress = what is being waited on right now: the result of
// a tool (by name) or the model's next response.
function taskType(items: TimelineItem[]): string {
  const last = items[items.length - 1];
  if (last && last.kind === 'tool' && !last.done) return `tool:${last.name}`;
  return 'assistant';
}
function tauForType(type: string): number {
  const avg = TASK_AVG.get(type);
  if (avg == null) return GAUGE_TAU; // no sample yet: default
  return Math.min(TAU_MAX, Math.max(TAU_MIN, (avg - GAUGE_DELAY) / TAU_K));
}

// Command/tool running right now (last unfinished tool): name +
// file/command/pattern. Used in the progress bar in non-verbose modes.
function currentCmd(items: TimelineItem[]): string | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it.kind === 'tool' && !it.done) {
      const input = (it.input ?? {}) as Record<string, unknown>;
      const file = typeof input.file_path === 'string' ? basename(input.file_path) : undefined;
      const cmd = typeof input.command === 'string' ? input.command : undefined;
      const pat = typeof input.pattern === 'string' ? input.pattern : undefined;
      const detail = file || (cmd ? cmd.slice(0, 48) : pat ? pat.slice(0, 48) : '');
      return detail ? `${it.name}: ${detail}` : it.name;
    }
  }
  return undefined;
}

// Activity indicator on the timeline's last line (while the turn runs):
// extension icon + spinner + sent/received token counter, as in the
// original Claude Code GUI, + a remaining-progress gauge (asymptotic) to the
// right of "Working". "Received" adds the consolidated output to the estimate of the
// turn in flight (text÷4) so it counts live during the streaming.
function ActivityIndicator({
  t,
  items,
  stats,
  verbosity = 'verbose',
}: {
  t: Translator;
  items: TimelineItem[];
  stats?: StatsSnapshot;
  verbosity?: string;
}) {
  const icon = window.__TOOTEGA_ICON__;
  // "Information received" signature: it changes on every new item (text/tool),
  // tool result that arrives, or completed response. It is the restart trigger
  // — streaming within the same block doesn't change the id, but each arrival changes the signature.
  // The gauge must only restart when something is REALLY painted in the timeline (according to
  // the verbosity). In quiet, hidden tools change command without painting anything → they don't
  // reset. That's why we count only the VISIBLE items.
  const lastAssistId = [...items].reverse().find((i) => i.kind === 'assistant')?.id;
  const vis = items.filter((it) => visibleInTimeline(it, verbosity, lastAssistId));
  let doneAssist = 0;
  let doneTools = 0;
  for (const it of vis) {
    if (it.kind === 'assistant') {
      if (it.done) doneAssist++;
    } else if (it.kind === 'tool' && it.done) {
      doneTools++;
    }
  }
  // Text/thinking of the visible response in flight: it grows with every token that appears.
  const last = vis[vis.length - 1];
  const flowing =
    last && last.kind === 'assistant' && !last.done ? last.text.length + last.thinking.length : 0;
  // Completed visible edits (deliverables painted in necessary/dialogo).
  const editsDone = vis.filter((i) => i.kind === 'tool' && i.done && MERGE_EDIT.test(i.name)).length;
  // Fronteira de segmento (aprendizado) e reset visual, POR MODO:
  //  - quiet: SEVERAL commands = ONE bar for the whole turn → it never resets.
  //  - necessary: resets only when an EDIT is painted (between edits = 1 bar).
  //  - verbose/dialogo: reset per visible item (each command/text = 1 bar).
  let segSig: string;
  if (verbosity === 'quiet') segSig = 'turn';
  else if (verbosity === 'necessary') segSig = `e${editsDone}`;
  else segSig = `${vis.length}:${doneAssist}:${doneTools}`;
  // "Fine" reset: includes the text streaming (it doesn't climb while the response arrives)
  // only where the text is painted (verbose/dialogo). Quiet/necessary ignore tokens.
  const liveSig =
    verbosity === 'verbose' || verbosity === 'dialogo' ? `${segSig}:${flowing}` : segSig;
  const sent = stats?.inputTokens ?? 0;
  const received = stats?.outputTokens ?? 0;
  const [elapsed, setElapsed] = useState(0);
  const [totalMs, setTotalMs] = useState(0); // turn elapsed time (not reset per token)
  const gaugeStartRef = useRef(Date.now()); // base do gauge (reset por liveSig)
  const turnStartRef = useRef(Date.now()); // turn start (indicator mount)
  const segStartRef = useRef(Date.now()); // base do segmento (aprendizado)
  const prevLive = useRef(liveSig);
  const prevSeg = useRef(segSig);
  // Segment type for the duration learning:
  //  - verbose: each command is its own segment → type = command (tool:Read…).
  //  - non-verbose: ONE bar covers SEVERAL different commands (between two painted
  //    items) → it can't be keyed per command; it uses a single 'batch' bucket.
  const segType = () => (verbosity === 'verbose' ? taskType(vis) : 'batch');
  const typeRef = useRef(segType());
  const tauRef = useRef(tauForType(typeRef.current)); // τ calibrado p/ esse tipo
  // Gauge stopwatch tick.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setElapsed(now - gaugeStartRef.current);
      setTotalMs(now - turnStartRef.current);
    }, 100);
    return () => clearInterval(id);
  }, []);
  // Any information that arrives (item, tool result OR a flowing token) restarts the
  // gauge — that way it only "climbs" on a real stall, and disappears when the response arrives.
  useEffect(() => {
    if (liveSig === prevLive.current) return;
    prevLive.current = liveSig;
    gaugeStartRef.current = Date.now();
    setElapsed(0);
  }, [liveSig]);
  // Learning: it measures the duration only on the coarse segments (not per token, so the
  // EMA isn't polluted) and calibrates τ by the type of the next wait.
  useEffect(() => {
    if (segSig === prevSeg.current) return;
    prevSeg.current = segSig;
    const dur = Date.now() - segStartRef.current;
    if (dur >= 150) send({ kind: 'taskDuration', type: typeRef.current, ms: dur });
    typeRef.current = segType();
    tauRef.current = tauForType(typeRef.current);
    segStartRef.current = Date.now();
  }, [segSig]);
  // End of the turn (the indicator unmounts): records the last bar still in progress —
  // that is what captures the duration of quiet's SINGLE bar (which never changes segSig).
  useEffect(() => {
    return () => {
      const dur = Date.now() - segStartRef.current;
      if (dur >= 150) send({ kind: 'taskDuration', type: typeRef.current, ms: dur });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Gauge only after GAUGE_DELAY (stall > 2s); it appears at GAUGE_START and grows
  // asymptotically (τ calibrated by task type) up to the ceiling (1 - GAUGE_FLOOR).
  const showGauge = elapsed >= GAUGE_DELAY;
  const progress = Math.min(
    1 - GAUGE_FLOOR,
    1 - (1 - GAUGE_START) * Math.exp(-(elapsed - GAUGE_DELAY) / tauRef.current),
  );
  const pct = Math.round(progress * 100);
  // In non-verbose modes the tool cards are hidden: it shows on the left the
  // command running right now (name + file/command).
  const cmd = verbosity !== 'verbose' ? currentCmd(items) : undefined;
  return (
    <div className="activity" role="status" aria-live="polite">
      {icon && <img className="activity-icon" src={icon} alt="" width={16} height={16} />}
      <span className="activity-spinner" aria-hidden="true" />
      <span className="activity-tokens">
        <span className="activity-up" title={t('activity.sent')}>↑ {fmtCompact(sent)}</span>
        <span className="activity-down" title={t('activity.received')}>↓ {fmtCompact(received)}</span>
      </span>
      <span className="activity-label">{cmd || t('activity.working')}</span>
      {showGauge && (
        <span
          className="activity-gauge"
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          title={`${pct}%`}
        >
          <span className="activity-gauge-fill" style={{ width: `${(progress * 100).toFixed(1)}%` }} />
          <span className="activity-gauge-pct">{pct}%</span>
          <span className="activity-gauge-time">{fmtMinSec(totalMs)}</span>
        </span>
      )}
    </div>
  );
}

// One Claude turn: a single header + text/tools in order. Runs of task tools
// are merged into a single inline checklist (TodoCard).
// Edit family: they group together (Edit/Write/MultiEdit) on the same file.
const MERGE_EDIT = /^(Edit|MultiEdit|Write|NotebookEdit)$/;

/**
 * Merge key: consecutive tools with the SAME key become one card.
 *  - edit on the same file → `edit:<file>` (merges Edit/Write/MultiEdit together)
 *  - another file tool → `<name>:<file>` (Read of the same file, etc.)
 *  - the rest (Bash/Grep/…) → `<name>` (sequence of the same command)
 */
function mergeKey(it: ToolItem): string {
  const input = (it.input ?? {}) as Record<string, unknown>;
  const file = typeof input.file_path === 'string' ? input.file_path : undefined;
  if (MERGE_EDIT.test(it.name) && file) return `edit:${file}`;
  if (file) return `${it.name}:${file}`;
  return it.name;
}

/**
 * An item is DISPLAYED in the timeline according to the verbosity (display only):
 *   verbose=everything; dialogo=edits+all text; necessary=edits+final text;
 *   quiet=final text only. Ask/checklist always; user always.
 */
function visibleInTimeline(it: TimelineItem, verbosity: string, lastAssistId?: string): boolean {
  if (verbosity === 'verbose') return true;
  if (it.kind === 'user') return true;
  if (it.kind === 'assistant') {
    if (verbosity === 'dialogo') return true; // all the text
    return it.id === lastAssistId; // necessary/quiet: only the final one
  }
  // tool
  if (it.name === 'AskUserQuestion' || isTodoToolName(it.name)) return true;
  if (verbosity === 'quiet') return false;
  return MERGE_EDIT.test(it.name); // necessary/dialogo: edits only
}

function ClaudeTurn({
  items,
  t,
  defaultShowThinking,
  defaultOpenTools,
  todos,
  showTodos,
  answers,
  verbosity,
}: {
  items: (AssistantItem | ToolItem)[];
  t: Translator;
  defaultShowThinking: boolean;
  defaultOpenTools: boolean;
  todos: TodoItem[];
  showTodos: boolean;
  answers?: Record<string, string>;
  verbosity: string;
}) {
  const active = items.some((i) => i.kind === 'assistant' && !i.done);
  const canceled = items.some((i) => i.kind === 'assistant' && i.canceled);
  const turnEnd = turnEndTs(items);
  const turnStart = turnStartTs(items);
  const nodes: ReactNode[] = [];
  let todoShown = false;
  // Verbosity filters the DISPLAY (it changes nothing in the agent):
  //   verbose   = everything (as today)
  //   necessary = edits + final explanation
  //   dialogo   = edits + text of what it is doing (all the text)
  //   quiet     = only the final explanation
  const lastAssistId = [...items].reverse().find((i) => i.kind === 'assistant')?.id;
  const visible = items.filter((it) => visibleInTimeline(it, verbosity, lastAssistId));
  // Buffer to merge ADJACENT tools with the same key (same file/command).
  let group: ToolItem[] = [];
  let groupKey = '';
  const flushGroup = () => {
    if (group.length === 0) return;
    const grp = group;
    group = [];
    nodes.push(
      <Tooltip key={grp[0].id} className="tt-block" title={grp[0].name} rows={toolRows(grp[0], t)}>
        <ToolCard items={grp} t={t} defaultOpen={defaultOpenTools} />
      </Tooltip>,
    );
  };
  for (const it of visible) {
    // ToolSearch is internal CLI plumbing (it loads deferred tool schemas): hidden.
    if (it.kind === 'tool' && it.name === 'ToolSearch') continue;
    // Task tools don't become cards: they feed the turn's single checklist.
    if (it.kind === 'tool' && isTodoToolName(it.name)) {
      flushGroup();
      if (showTodos && !todoShown && todos.length > 0) {
        nodes.push(<TodoCard key={`todo-${it.id}`} t={t} todos={todos} />);
        todoShown = true;
      }
      continue;
    }
    // AskUserQuestion: its own card (not merged).
    if (it.kind === 'tool' && it.name === 'AskUserQuestion') {
      flushGroup();
      nodes.push(<AskCard key={it.id} item={it} t={t} answers={answers} />);
      continue;
    }
    // Other tools: accumulated in the group while the merge key holds.
    if (it.kind === 'tool') {
      const key = mergeKey(it);
      if (group.length && groupKey === key) group.push(it);
      else {
        flushGroup();
        group = [it];
        groupKey = key;
      }
      continue;
    }
    // Assistente (texto/thinking): quebra o grupo.
    flushGroup();
    nodes.push(
      <Tooltip key={it.id} className="tt-block" title={t('role.assistant')} rows={assistantRows(it, t)}>
        <AssistantContent item={it} t={t} defaultShowThinking={defaultShowThinking} />
      </Tooltip>,
    );
  }
  flushGroup();
  return (
    <div className="bubble assistant turn">
      <Tooltip className="tt-block" focusable title={t('role.assistant')} rows={turnRows(items, t)}>
        <div className="role role-assistant">
          {t('role.assistant')}
          {active && <span className="caret">▋</span>}
          {canceled && <span className="canceled-tag">{t('turn.canceled')}</span>}
        </div>
      </Tooltip>
      {nodes}
      {!active && turnEnd != null && (
        <div className="turn-end">
          {fmtStamp(turnEnd)}
          {turnStart != null && turnEnd > turnStart && (
            <span className="turn-elapsed">{fmtMinSec(turnEnd - turnStart)}</span>
          )}
        </div>
      )}
    </div>
  );
}

function UserBubble({
  item,
  t,
  userName,
  pinned,
  onRewind,
}: {
  item: UserItem;
  t: Translator;
  userName?: string;
  pinned?: boolean;
  onRewind?: () => void;
}) {
  const openImage = useImageViewer();
  const [collapsed, setCollapsed] = useState(true);
  // It only makes sense to offer expanding when the text has more than one line.
  const collapsible = !!item.text && item.text.includes('\n');
  return (
    <Tooltip
      className={`tt-block ${pinned ? 'pinned-wrap' : ''}`}
      title={t('role.user')}
      rows={userRows(item, t)}
    >
      <div className={`bubble user ${pinned ? 'pinned' : ''}`} id={`msg-${item.id}`}>
        <div className="role role-user">
          <span>{userName || t('role.user')}</span>
          {item.ts && <span className="bubble-time">{fmtStamp(item.ts)}</span>}
          {item.text && <CopyButton text={item.text} t={t} />}
          {collapsible && (
            <button
              type="button"
              className="bubble-toggle"
              onClick={() => setCollapsed((v) => !v)}
            >
              {collapsed ? t('bubble.showMore') : t('bubble.showLess')}
            </button>
          )}
          {onRewind && (
            <button
              type="button"
              className="msg-rewind"
              title={t('rewind.title')}
              onClick={onRewind}
            >
              ↶
            </button>
          )}
        </div>
        {item.images && item.images.length > 0 && (
          <div className="bubble-images">
            {item.images.map((src, i) => (
              <button
                type="button"
                className="bubble-image-btn"
                key={i}
                title={t('attach.view')}
                onClick={() => openImage(src)}
              >
                <img className="bubble-image" src={src} alt="" />
              </button>
            ))}
          </div>
        )}
        {item.text && (
          <pre
            className={`content hljs user-hl ${collapsible && collapsed ? 'user-hl--clamp' : ''}`}
            dangerouslySetInnerHTML={{ __html: richHighlight(item.text) }}
          />
        )}
      </div>
    </Tooltip>
  );
}


// Content of an assistant message, WITHOUT a role header (the turn already
// shows "Claude" once). Empty (no text and no thinking) renders nothing.
function AssistantContent({
  item,
  t,
  defaultShowThinking,
}: {
  item: AssistantItem;
  t: Translator;
  defaultShowThinking: boolean;
}) {
  const [showThinking, setShowThinking] = useState(defaultShowThinking);
  // The global default (setting) changed: re-syncs the already mounted blocks.
  useEffect(() => setShowThinking(defaultShowThinking), [defaultShowThinking]);
  if (!item.text && !item.thinking) return null;
  return (
    <div className="assistant-msg">
      {item.thinking && (
        <div className="thinking">
          <button type="button" className="link-btn" onClick={() => setShowThinking((s) => !s)}>
            {showThinking ? t('thinking.hide') : t('thinking.show')}
          </button>
          {showThinking && <pre className="thinking-body">{item.thinking}</pre>}
        </div>
      )}
      {item.text && (
        <div className="content">
          <Markdown text={item.text} />
          {item.done && <CopyButton text={item.text} t={t} />}
        </div>
      )}
    </div>
  );
}

function ToolCard({ items, t, defaultOpen }: { items: ToolItem[]; t: Translator; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  // The global default (setting) changed: re-syncs the already mounted cards.
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const item = items[0]; // primary (header)
  const last = items[items.length - 1];
  const merged = items.length > 1;
  // Aggregated status: error when any failed; busy when any hasn't finished.
  const anyErr = items.some((i) => i.isError);
  const anyBusy = items.some((i) => !i.done);
  const statusCls = anyErr ? 'err' : anyBusy ? 'busy' : 'ok';
  const input = (item.input ?? {}) as Record<string, unknown>;
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
  const name = item.name;

  return (
    <div className={`tool-card ${statusCls}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-icon">{toolIcon(name)}</span>
        <span className="tool-name">{name}{merged && <span className="tool-count">×{items.length}</span>}</span>
        {filePath && (
          <span
            className="tool-file"
            title={filePath}
            role="link"
            onClick={(e) => {
              e.stopPropagation();
              send({ kind: 'openLink', href: filePath });
            }}
          >
            {basename(filePath)}
          </span>
        )}
        {/* Skill cujo corpo entrou no contexto: o custo fica visível no momento em que
            acontece, não só no painel. Sem tamanho informado, mostra só o selo. */}
        {item.skillLoaded && (
          <span className="tool-skill-load" title={t('skills.legend.active')}>
            ⚡ {item.skillTokens != null ? t('skills.activeTokens', fmtTk(item.skillTokens)) : t('skills.obs.active')}
          </span>
        )}
        {last.ts && <span className="tool-time">{fmtStamp(last.ts)}</span>}
        {filePath && hasPreview(filePath) && (
          <span
            className="tool-view"
            title={t('tool.view')}
            role="link"
            onClick={(e) => {
              e.stopPropagation();
              send({ kind: 'openLink', href: filePath, preview: true });
            }}
          >
            {t('tool.view')}
          </span>
        )}
        <span className="tool-status">
          {anyErr ? t('tool.error') : anyBusy ? t('tool.running') : ''}
        </span>
        <span className="chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-body">
          {items.map((it, i) => (
            <div key={it.id} className={i > 0 ? 'tool-merge-part' : undefined}>
              {renderBody(it)}
            </div>
          ))}
        </div>
      )}
    </div>
  );

  function renderBody(item: ToolItem) {
    const input = (item.input ?? {}) as Record<string, unknown>;
    const filePath = typeof input.file_path === 'string' ? input.file_path : undefined;
    const lang = languageFromPath(filePath);
    const name = item.name;
    const command = typeof input.command === 'string' ? input.command : undefined;
    const description = typeof input.description === 'string' ? input.description : undefined;
    const writeContent =
      typeof input.content === 'string'
        ? input.content
        : typeof input.new_string === 'string'
          ? input.new_string
          : undefined;
    // Bash: highlighted shell command + output (stdout) as text.
    if (name === 'Bash' && command !== undefined) {
      return (
        <>
          {description && <div className="tool-desc">{description}</div>}
          <div className="tool-section-label">{t('tool.command')}</div>
          <CodeBlock code={command} language="bash" />
          {item.result !== undefined && (
            <>
              <div className="tool-section-label">{t('tool.output')}</div>
              <pre className="tool-pre">{toText(item.result)}</pre>
            </>
          )}
        </>
      );
    }
    // Read: splits the numbering (cat -n) into a gutter and highlights the clean content.
    if (name === 'Read' && item.result !== undefined) {
      const raw = toText(item.result);
      const parsed = stripLineNumbers(raw);
      return (
        <CodeBlock
          code={parsed ? parsed.code : raw}
          language={lang}
          lineNumbers={parsed?.numbers}
        />
      );
    }
    // Edit: diff lado-a-lado de old_string -> new_string.
    if (name === 'Edit' && typeof input.old_string === 'string') {
      return (
        <DiffView
          oldText={input.old_string}
          newText={typeof input.new_string === 'string' ? input.new_string : ''}
        />
      );
    }
    // MultiEdit: one diff per edit.
    if (name === 'MultiEdit' && Array.isArray(input.edits)) {
      return (
        <>
          {(input.edits as Record<string, unknown>[]).map((e, i) => (
            <DiffView
              key={i}
              oldText={typeof e.old_string === 'string' ? e.old_string : ''}
              newText={typeof e.new_string === 'string' ? e.new_string : ''}
            />
          ))}
        </>
      );
    }
    // Write: highlighted new content.
    if (name === 'Write' && writeContent !== undefined) {
      return <CodeBlock code={writeContent} language={lang} />;
    }
    // Generic: raw input and output (safe for any tool).
    return (
      <>
        <div className="tool-section-label">{t('tool.input')}</div>
        <pre className="tool-pre">{stringify(item.input)}</pre>
        {item.result !== undefined && (
          <>
            <div className="tool-section-label">{t('tool.output')}</div>
            <pre className="tool-pre">{toText(item.result)}</pre>
          </>
        )}
      </>
    );
  }
}

// AskUserQuestion: inline modal-like view — questions + options with the choice
// marked. Always open. Answers come from the tab's live state; in a resumed
// retomada, caem no parse do tool_result.
function AskCard({
  item,
  t,
  answers,
}: {
  item: ToolItem;
  t: Translator;
  answers?: Record<string, string>;
}) {
  const input = (item.input ?? {}) as { questions?: AskQuestion[] };
  const questions = input.questions ?? [];
  if (questions.length === 0) {
    return (
      <div className="tool-card ok">
        <div className="tool-body">
          <pre className="tool-pre">{stringify(item.input)}</pre>
        </div>
      </div>
    );
  }

  const parsed = parseAnswersFromResult(toText(item.result), questions);
  const answerOf = (q: string): string => (answers?.[q] ?? parsed[q] ?? '').trim();
  const anyAnswered = questions.some((q) => answerOf(q.question).length > 0);

  return (
    <div className="ask-card">
      <div className="ask-card-head">
        <span className="ask-icon">?</span>
        <span className="ask-card-title">{t(anyAnswered ? 'ask.answered' : 'ask.title')}</span>
      </div>

      {questions.map((q, i) => {
        const ans = answerOf(q.question);
        const tokens = ans ? ans.split(',').map((s) => s.trim()).filter(Boolean) : [];
        const known = new Set(q.options.map((o) => o.label));
        const picked = new Set(tokens.filter((tk) => known.has(tk)));
        const other = tokens.filter((tk) => !known.has(tk)).join(', ');
        return (
          <div className="ask-card-q" key={i}>
            <div className="ask-card-qhead">
              {q.header && <span className="ask-card-chip">{q.header}</span>}
              {q.multiSelect && <span className="ask-card-multi">{t('ask.multiHint')}</span>}
            </div>
            <div className="ask-question">{q.question}</div>
            <div className="ask-options ask-options-static">
              {q.options.map((opt, oi) => {
                const active = picked.has(opt.label);
                return (
                  <div key={oi} className={`ask-option ${active ? 'active' : 'dim'}`}>
                    <span className={`ask-ctrl ${q.multiSelect ? 'check' : 'radio'} ${active ? 'on' : ''}`} />
                    <span className="ask-opt-text">
                      <span className="ask-opt-label">{opt.label}</span>
                      {opt.description && <span className="ask-opt-desc">{opt.description}</span>}
                    </span>
                  </div>
                );
              })}
              {other && (
                <div className="ask-option active">
                  <span className={`ask-ctrl ${q.multiSelect ? 'check' : 'radio'} on`} />
                  <span className="ask-opt-text">
                    <span className="ask-opt-label">{t('ask.other')}</span>
                    <span className="ask-opt-desc">{other}</span>
                  </span>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Extrai pares pergunta->resposta do tool_result. Formato do CLI:
//   User has answered your questions: "Q1"="A1". "Q2"="A2". You can now continue…
// Anchored on the exact question texts (the answer may contain quotes).
function parseAnswersFromResult(text: string, questions: AskQuestion[]): Record<string, string> {
  const out: Record<string, string> = {};
  if (!text) return out;
  for (let i = 0; i < questions.length; i++) {
    const key = `"${questions[i].question}"="`;
    const at = text.indexOf(key);
    if (at < 0) continue;
    const start = at + key.length;
    let end = text.length;
    for (let j = 0; j < questions.length; j++) {
      if (j === i) continue;
      const p = text.indexOf(`"${questions[j].question}"="`, start);
      if (p >= 0 && p < end) end = p;
    }
    let seg = text.slice(start, end);
    seg = seg.replace(/\s*You can now continue with the user's answers in mind\.?\s*$/, '');
    seg = seg.trim().replace(/"\.?\s*$/, '');
    out[questions[i].question] = seg;
  }
  return out;
}

// Extrai texto de um tool_result (string ou array de blocos {type:'text'}).
function toText(v: unknown): string {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    return v
      .map((b) =>
        b && typeof (b as { text?: unknown }).text === 'string'
          ? (b as { text: string }).text
          : typeof b === 'string'
            ? b
            : JSON.stringify(b),
      )
      .join('');
  }
  if (v && typeof (v as { text?: unknown }).text === 'string') return (v as { text: string }).text;
  return stringify(v);
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

// Latest timestamp of the turn (end of the interaction): the turnComplete endTs or,
// in a resumed session, the largest ts among the items (assistant/tool).
function turnEndTs(items: (AssistantItem | ToolItem)[]): number | undefined {
  let m = 0;
  for (const it of items) {
    if (it.endTs) m = Math.max(m, it.endTs);
    if (it.ts) m = Math.max(m, it.ts);
  }
  return m || undefined;
}

// First stamp of the turn (start of the prompt's execution).
function turnStartTs(items: (AssistantItem | ToolItem)[]): number | undefined {
  let m = Infinity;
  for (const it of items) if (it.ts) m = Math.min(m, it.ts);
  return Number.isFinite(m) ? m : undefined;
}

// Full date + time (HH:MM:SS) in the PC's region format.
function fmtStamp(ts: number): string {
  const region = window.__TOOTEGA_REGION__ || navigator.language || undefined;
  try {
    return new Intl.DateTimeFormat(region, { dateStyle: 'short', timeStyle: 'medium' }).format(
      new Date(ts),
    );
  } catch {
    return '';
  }
}

// ---- Hint lines (communication data that doesn't show up in the timeline) ----

function userRows(item: UserItem, t: Translator): TooltipRow[] {
  const rows: TooltipRow[] = [];
  if (item.ts) rows.push({ label: t('tip.time'), value: fmtClock(item.ts) });
  rows.push({ label: t('tip.chars'), value: fmtCompact(item.text.length) });
  rows.push({ label: t('tip.words'), value: fmtCompact(countWords(item.text)) });
  if (item.images?.length) rows.push({ label: t('tip.images'), value: String(item.images.length) });
  return rows;
}

function toolRows(item: ToolItem, t: Translator): TooltipRow[] {
  const inp = (item.input ?? {}) as Record<string, unknown>;
  const rows: TooltipRow[] = [];
  // Arquivo envolvido primeiro: distingue cards iguais ("Edit", "Read"…).
  if (typeof inp.file_path === 'string' && inp.file_path) {
    rows.push({ label: t('tip.file'), value: basename(inp.file_path), accent: true });
  }
  if (item.ts) rows.push({ label: t('tip.time'), value: fmtClock(item.ts) });
  rows.push({ label: t('tip.inputSize'), value: fmtBytes(byteLen(stringify(item.input))) });
  if (item.result !== undefined) {
    const out = toText(item.result);
    rows.push({ label: t('tip.outputSize'), value: fmtBytes(byteLen(out)) });
    rows.push({ label: t('tip.lines'), value: fmtCompact(countLines(out)) });
  }
  if (item.ts && item.endTs) {
    rows.push({ label: t('tip.duration'), value: fmtMs(item.endTs - item.ts) });
  }
  if (item.isError) rows.push({ label: t('tip.status'), value: t('tool.error'), accent: true });
  rows.push({ label: t('tip.id'), value: item.id.slice(0, 12) });
  return rows;
}

function assistantRows(item: AssistantItem, t: Translator): TooltipRow[] {
  const rows: TooltipRow[] = [];
  if (item.ts) rows.push({ label: t('tip.time'), value: fmtClock(item.ts) });
  rows.push({ label: t('tip.outChars'), value: fmtCompact(item.text.length) });
  rows.push({ label: t('tip.estTokens'), value: `~${fmtCompact(Math.round(item.text.length / 4))}` });
  if (item.thinking) rows.push({ label: t('tip.thinking'), value: fmtCompact(item.thinking.length) });
  if (item.usage?.input != null) rows.push({ label: t('tip.tokensIn'), value: fmtCompact(item.usage.input) });
  if (item.usage?.output != null) rows.push({ label: t('tip.tokensOut'), value: fmtCompact(item.usage.output) });
  if (item.costUsd != null) {
    rows.push({ label: t('tip.cost'), value: fmtUsdShort(item.costUsd), accent: true });
  }
  return rows;
}

function turnRows(items: (AssistantItem | ToolItem)[], t: Translator): TooltipRow[] {
  const assistants = items.filter((i): i is AssistantItem => i.kind === 'assistant');
  const toolCount = items.filter((i) => i.kind === 'tool').length;
  const outChars = assistants.reduce((s, a) => s + a.text.length, 0);
  const thinkChars = assistants.reduce((s, a) => s + a.thinking.length, 0);
  const firstTs = assistants.find((a) => a.ts)?.ts;
  const withUsage = [...assistants].reverse().find((a) => a.usage || a.costUsd != null);
  const rows: TooltipRow[] = [];
  if (firstTs) rows.push({ label: t('tip.time'), value: fmtClock(firstTs) });
  rows.push({ label: t('tip.outChars'), value: fmtCompact(outChars) });
  rows.push({ label: t('tip.estTokens'), value: `~${fmtCompact(Math.round(outChars / 4))}` });
  if (thinkChars) rows.push({ label: t('tip.thinking'), value: fmtCompact(thinkChars) });
  if (toolCount) rows.push({ label: t('tip.tools'), value: String(toolCount) });
  const u = withUsage?.usage;
  if (u) {
    if (u.input != null) rows.push({ label: t('tip.tokensIn'), value: fmtCompact(u.input) });
    if (u.output != null) rows.push({ label: t('tip.tokensOut'), value: fmtCompact(u.output) });
    if (u.cacheRead != null) rows.push({ label: t('tip.cacheRead'), value: fmtCompact(u.cacheRead) });
    if (u.cacheCreate != null) {
      rows.push({ label: t('tip.cacheCreate'), value: fmtCompact(u.cacheCreate) });
    }
    const totalIn = (u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheCreate ?? 0);
    if (totalIn > 0 && u.cacheRead != null) {
      rows.push({ label: t('tip.cacheHit'), value: `${Math.round((u.cacheRead / totalIn) * 100)}%` });
    }
  }
  if (withUsage?.costUsd != null) {
    rows.push({ label: t('tip.cost'), value: fmtUsdShort(withUsage.costUsd), accent: true });
  }
  return rows;
}
