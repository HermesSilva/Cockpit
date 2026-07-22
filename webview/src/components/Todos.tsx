import { useState } from 'react';
import type { Translator } from '../i18n';
import type { TodoItem } from '../types';

interface Props {
  t: Translator;
  todos: TodoItem[];
}

const MARK: Record<TodoItem['status'], string> = {
  pending: '',
  in_progress: '',
  completed: '✓',
};

// Task checklist rendered inline in the conversation body (it is not a window).
export function TodoCard({ t, todos }: Props) {
  const [open, setOpen] = useState(true);
  const done = todos.filter((x) => x.status === 'completed').length;
  const active = todos.some((x) => x.status === 'in_progress');
  const allDone = todos.length > 0 && done === todos.length;
  const pct = todos.length ? Math.round((done / todos.length) * 100) : 0;

  return (
    <div className={`todo-inline ${active ? 'has-active' : ''} ${allDone ? 'all-done' : ''}`}>
      <button type="button" className="todo-inline-head" onClick={() => setOpen((o) => !o)}>
        <span className="todos-title">
          <span className="todos-glyph">{allDone ? '✓' : '☑'}</span>
          {t('todos.title')}
        </span>
        <span className="todos-head-right">
          <span className="todos-count">
            {done}
            <span className="todos-count-sep">/</span>
            {todos.length}
          </span>
          <span className="chevron">{open ? '▾' : '▸'}</span>
        </span>
      </button>

      <div className="todos-bar" aria-hidden>
        <div className={`todos-bar-fill ${allDone ? 'done' : ''}`} style={{ width: `${pct}%` }} />
      </div>

      {open && (
        <ul className="todos-list">
          {todos.map((x, i) => {
            const label = x.status === 'in_progress' && x.activeForm ? x.activeForm : x.content;
            return (
              <li key={i} className={`todo ${x.status}`}>
                <span className="todo-badge">
                  {x.status === 'in_progress' ? <span className="todo-spin" /> : MARK[x.status]}
                </span>
                <span className="todo-body">
                  <span className="todo-text">{label}</span>
                  {x.description && <span className="todo-desc">{x.description}</span>}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
