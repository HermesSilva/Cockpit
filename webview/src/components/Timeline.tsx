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
// Arquivos com preview nativo no VSCode (link "View").
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
  onRewind?: (userIndex: number) => void; // rebobinar até este prompt (remove-o)
}

// Agrupa itens em turnos: cada mensagem do usuário e, depois dela, a corrida
// contígua de itens do Claude (texto + tools) sob um único cabeçalho "Claude".
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
  // A checklist de tarefas é única e vive (agregada): renderiza só no último
  // turno que mexeu em tarefas, evitando repetir o grupo a cada add/marcação.
  let lastTodoGroup = -1;
  let lastUserGroup = -1;
  groups.forEach((g, i) => {
    if (g.kind === 'claude' && g.items.some((it) => it.kind === 'tool' && isTodoToolName(it.name))) {
      lastTodoGroup = i;
    }
    if (g.kind === 'user') lastUserGroup = i;
  });
  // Ordinal de cada prompt do usuário (casa com a ordem no transcript do host),
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
          />
        ),
      )}
      {busy && <ActivityIndicator t={t} items={items} stats={stats} />}
    </div>
  );
}

// Gauge de progresso (assintótico). Só aparece depois de GAUGE_DELAY de espera —
// tarefas curtas (< 2s) não mostram gauge, evitando piscação. Ao surgir já começa
// em GAUGE_START (10%) e cresce desacelerando: progress = 1 - (1-START)·e^(-(t-DELAY)/τ),
// com teto 1 - GAUGE_FLOOR (≈ 97%, nunca 100%). Reinicia a cada informação recebida;
// ao concluir/encerrar simplesmente some (sem flash de 100%). GAUGE_TAU = velocidade.
const GAUGE_TAU = 25_000;
const GAUGE_FLOOR = 0.03;
const GAUGE_DELAY = 2_000;
const GAUGE_START = 0.1;

// --- Calibração do gauge por tipo de tarefa (menos "fake") ---
// As médias de duração por tipo vêm do HOST (persistidas em ~/.claude/tootega,
// globais p/ todo projeto/aba/sessão). A webview envia amostras de duração e
// consulta o mapa recebido p/ derivar τ — assim o gauge é rápido p/ tarefas
// tipicamente curtas e lento p/ longas, calibrado ao tempo real.
const TASK_AVG = new Map<string, number>(); // tipo -> média (ms): espelho do host
const TAU_TARGET = 0.8; // progresso que o gauge deve atingir na duração média
// τ = (média - DELAY) / k, onde k resolve progress=TAU_TARGET na média.
const TAU_K = Math.log((1 - GAUGE_START) / (1 - TAU_TARGET)); // ≈ 1.504
const TAU_MIN = 1_500;
const TAU_MAX = 120_000;

/** Formata ms como min:seg (ex.: 75000 -> "1:15"). */
function fmtMinSec(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** Semeia/atualiza o espelho local com as médias vindas do host. */
export function seedTaskTimings(timings: Record<string, number>): void {
  TASK_AVG.clear();
  for (const [k, v] of Object.entries(timings)) if (Number.isFinite(v)) TASK_AVG.set(k, v);
}
// Tipo da tarefa em andamento = o que se está esperando agora: o resultado de
// uma tool (por nome) ou a próxima resposta do modelo.
function taskType(items: TimelineItem[]): string {
  const last = items[items.length - 1];
  if (last && last.kind === 'tool' && !last.done) return `tool:${last.name}`;
  return 'assistant';
}
function tauForType(type: string): number {
  const avg = TASK_AVG.get(type);
  if (avg == null) return GAUGE_TAU; // sem amostra ainda: padrão
  return Math.min(TAU_MAX, Math.max(TAU_MIN, (avg - GAUGE_DELAY) / TAU_K));
}

// Indicador de atividade na última linha do timeline (enquanto o turno corre):
// ícone da extensão + spinner + contador de tokens enviados/recebidos, como na
// GUI original do Claude Code, + gauge de progresso restante (assintótico) à
// direita do "Working". "Recebidos" soma a saída consolidada à estimativa do
// turno em voo (texto÷4) para contar ao vivo durante o streaming.
function ActivityIndicator({
  t,
  items,
  stats,
}: {
  t: Translator;
  items: TimelineItem[];
  stats?: StatsSnapshot;
}) {
  const icon = window.__TOOTEGA_ICON__;
  // Assinatura de "informação recebida": muda a cada item novo (texto/tool),
  // resultado de tool que chega, ou resposta concluída. É o gatilho de reinício
  // — streaming no mesmo bloco não muda o id, mas cada chegada muda a assinatura.
  let doneAssist = 0;
  let doneTools = 0;
  for (const it of items) {
    if (it.kind === 'assistant') {
      if (it.done) doneAssist++;
    } else if (it.kind === 'tool' && it.done) {
      doneTools++;
    }
  }
  // Texto/thinking da resposta em voo: cresce a cada token que aparece. Usado p/
  // resetar o gauge enquanto a resposta está visivelmente chegando.
  const last = items[items.length - 1];
  const flowing =
    last && last.kind === 'assistant' && !last.done ? last.text.length + last.thinking.length : 0;
  // Segmento "grosso" (aprendizado de duração + tipo): item novo / tool / conclusão.
  const segSig = `${items.length}:${doneAssist}:${doneTools}`;
  // Sinal "fino" (reset visual): muda também quando chega token → o gauge não sobe
  // enquanto a resposta chega; só sobe em stall real (> GAUGE_DELAY sem nada novo).
  const liveSig = `${segSig}:${flowing}`;
  const sent = stats?.inputTokens ?? 0;
  const received = stats?.outputTokens ?? 0;
  const [elapsed, setElapsed] = useState(0);
  const [totalMs, setTotalMs] = useState(0); // tempo decorrido do turno (não reseta por token)
  const gaugeStartRef = useRef(Date.now()); // base do gauge (reset por liveSig)
  const turnStartRef = useRef(Date.now()); // início do turno (montagem do indicador)
  const segStartRef = useRef(Date.now()); // base do segmento (aprendizado)
  const prevLive = useRef(liveSig);
  const prevSeg = useRef(segSig);
  const typeRef = useRef(taskType(items)); // tipo da espera atual
  const tauRef = useRef(tauForType(typeRef.current)); // τ calibrado p/ esse tipo
  // Tick do cronômetro do gauge.
  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      setElapsed(now - gaugeStartRef.current);
      setTotalMs(now - turnStartRef.current);
    }, 100);
    return () => clearInterval(id);
  }, []);
  // Qualquer informação que chega (item, tool result OU token fluindo) reinicia o
  // gauge — assim ele só "sobe" num stall real, e some quando a resposta chega.
  useEffect(() => {
    if (liveSig === prevLive.current) return;
    prevLive.current = liveSig;
    gaugeStartRef.current = Date.now();
    setElapsed(0);
  }, [liveSig]);
  // Aprendizado: mede a duração só nos segmentos grossos (não por token, p/ não
  // poluir a EMA) e calibra τ pelo tipo da próxima espera.
  useEffect(() => {
    if (segSig === prevSeg.current) return;
    prevSeg.current = segSig;
    const dur = Date.now() - segStartRef.current;
    if (dur >= 150) send({ kind: 'taskDuration', type: typeRef.current, ms: dur });
    typeRef.current = taskType(items);
    tauRef.current = tauForType(typeRef.current);
    segStartRef.current = Date.now();
  }, [segSig]);
  // Gauge só após GAUGE_DELAY (stall > 2s); surge em GAUGE_START e cresce
  // assintótico (τ calibrado pelo tipo de tarefa) até o teto (1 - GAUGE_FLOOR).
  const showGauge = elapsed >= GAUGE_DELAY;
  const progress = Math.min(
    1 - GAUGE_FLOOR,
    1 - (1 - GAUGE_START) * Math.exp(-(elapsed - GAUGE_DELAY) / tauRef.current),
  );
  const pct = Math.round(progress * 100);
  return (
    <div className="activity" role="status" aria-live="polite">
      {icon && <img className="activity-icon" src={icon} alt="" width={16} height={16} />}
      <span className="activity-spinner" aria-hidden="true" />
      <span className="activity-tokens">
        <span className="activity-up" title={t('activity.sent')}>↑ {fmtCompact(sent)}</span>
        <span className="activity-down" title={t('activity.received')}>↓ {fmtCompact(received)}</span>
      </span>
      <span className="activity-label">{t('activity.working')}</span>
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

// Um turno do Claude: cabeçalho único + texto/tools na ordem. Corridas de tools
// de tarefa são fundidas numa única checklist inline (TodoCard).
function ClaudeTurn({
  items,
  t,
  defaultShowThinking,
  defaultOpenTools,
  todos,
  showTodos,
  answers,
}: {
  items: (AssistantItem | ToolItem)[];
  t: Translator;
  defaultShowThinking: boolean;
  defaultOpenTools: boolean;
  todos: TodoItem[];
  showTodos: boolean;
  answers?: Record<string, string>;
}) {
  const active = items.some((i) => i.kind === 'assistant' && !i.done);
  const canceled = items.some((i) => i.kind === 'assistant' && i.canceled);
  const turnEnd = turnEndTs(items);
  const turnStart = turnStartTs(items);
  const nodes: ReactNode[] = [];
  let todoShown = false;
  for (const it of items) {
    // ToolSearch é plumbing interno do CLI (carrega schemas de tools deferred): oculta.
    if (it.kind === 'tool' && it.name === 'ToolSearch') continue;
    // Tools de tarefa não viram cards: alimentam a checklist única do turno.
    if (it.kind === 'tool' && isTodoToolName(it.name)) {
      if (showTodos && !todoShown && todos.length > 0) {
        nodes.push(<TodoCard key={`todo-${it.id}`} t={t} todos={todos} />);
        todoShown = true;
      }
      continue;
    }
    if (it.kind === 'assistant') {
      nodes.push(
        <Tooltip key={it.id} className="tt-block" title={t('role.assistant')} rows={assistantRows(it, t)}>
          <AssistantContent item={it} t={t} defaultShowThinking={defaultShowThinking} />
        </Tooltip>,
      );
    } else if (it.name === 'AskUserQuestion') {
      nodes.push(<AskCard key={it.id} item={it} t={t} answers={answers} />);
    } else {
      nodes.push(
        <Tooltip key={it.id} className="tt-block" title={it.name} rows={toolRows(it, t)}>
          <ToolCard item={it} t={t} defaultOpen={defaultOpenTools} />
        </Tooltip>,
      );
    }
  }
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
            className="content hljs user-hl"
            dangerouslySetInnerHTML={{ __html: richHighlight(item.text) }}
          />
        )}
      </div>
    </Tooltip>
  );
}


// Conteúdo de uma mensagem do assistente, SEM cabeçalho de papel (o turno já
// mostra "Claude" uma vez). Vazio (sem texto nem thinking) não renderiza nada.
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
  // Default global (setting) mudou: re-sincroniza os blocos já montados.
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

function ToolCard({ item, t, defaultOpen }: { item: ToolItem; t: Translator; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  // Default global (setting) mudou: re-sincroniza os cards já montados.
  useEffect(() => setOpen(defaultOpen), [defaultOpen]);
  const statusCls = item.isError ? 'err' : item.done ? 'ok' : 'busy';
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

  return (
    <div className={`tool-card ${statusCls}`}>
      <button type="button" className="tool-head" onClick={() => setOpen((o) => !o)}>
        <span className="tool-icon">{toolIcon(name)}</span>
        <span className="tool-name">{name}</span>
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
        {item.ts && <span className="tool-time">{fmtStamp(item.ts)}</span>}
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
          {item.isError ? t('tool.error') : item.done ? '' : t('tool.running')}
        </span>
        <span className="chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && <div className="tool-body">{renderBody()}</div>}
    </div>
  );

  function renderBody() {
    // Bash: comando shell destacado + saída (stdout) em texto.
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
    // Read: separa numeração (cat -n) num gutter e destaca o conteúdo limpo.
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
    // MultiEdit: um diff por edição.
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
    // Write: conteúdo novo destacado.
    if (name === 'Write' && writeContent !== undefined) {
      return <CodeBlock code={writeContent} language={lang} />;
    }
    // Genérico: entrada e saída cruas (seguro para qualquer ferramenta).
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

// AskUserQuestion: visão inline tipo modal — perguntas + opções com a escolha
// marcada. Sempre aberta. Respostas vêm do estado vivo da aba; em sessão
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
// Ancorado nos textos exatos das perguntas (a resposta pode conter aspas).
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

// Timestamp mais recente do turno (fim da interação): endTs do turnComplete ou,
// em sessão retomada, o maior ts entre os itens (assistant/tool).
function turnEndTs(items: (AssistantItem | ToolItem)[]): number | undefined {
  let m = 0;
  for (const it of items) {
    if (it.endTs) m = Math.max(m, it.endTs);
    if (it.ts) m = Math.max(m, it.ts);
  }
  return m || undefined;
}

// Primeiro carimbo do turno (início da execução do prompt).
function turnStartTs(items: (AssistantItem | ToolItem)[]): number | undefined {
  let m = Infinity;
  for (const it of items) if (it.ts) m = Math.min(m, it.ts);
  return Number.isFinite(m) ? m : undefined;
}

// Data + hora completa (HH:MM:SS) no formato da região do PC.
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

// ---- Linhas dos hints (dados de comunicação que não aparecem na timeline) ----

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
