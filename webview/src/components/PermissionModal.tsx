import { useEffect } from 'react';
import type { Translator } from '../i18n';
import type { PermissionRequest } from '../types';
import { Markdown } from './Markdown';
import { DiffView } from './DiffView';
import { Portal } from './Portal';

interface Props {
  t: Translator;
  req: PermissionRequest;
  onDecision: (d: 'allow' | 'deny' | 'allow_always') => void;
}

// Ícone por ferramenta (espelha o conjunto da Timeline).
const TOOL_ICON: Record<string, string> = {
  Bash: '$_',
  Write: '✎',
  Edit: '✎',
  MultiEdit: '✎',
  NotebookEdit: '✎',
  Read: '◇',
  WebFetch: '🌐',
  WebSearch: '🔎',
  Task: '⚙',
};

export function PermissionModal({ t, req, onDecision }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDecision('deny');
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) onDecision('allow');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDecision]);

  // Plan mode: ExitPlanMode chega como permissão; o plano vem em input.plan.
  if (req.tool === 'ExitPlanMode') {
    const plan = String((req.input as Record<string, unknown>)?.plan ?? '');
    return (
      <Portal>
        <div className="modal-overlay" onClick={() => onDecision('deny')}>
          <div className="modal perm plan" onClick={(e) => e.stopPropagation()}>
            <div className="perm-head">
              <span className="perm-icon">◑</span>
              <div className="perm-headtext">
                <div className="modal-title">{t('permission.planTitle')}</div>
                <div className="perm-tool">{t('permission.planSubtitle')}</div>
              </div>
            </div>
            <div className="perm-plan-body">
              <Markdown text={plan} />
            </div>
            <div className="modal-actions perm-actions">
              <button type="button" className="btn deny" onClick={() => onDecision('deny')}>
                {t('permission.keepPlanning')}
              </button>
              <button type="button" className="btn send" onClick={() => onDecision('allow')} autoFocus>
                {t('permission.approvePlan')}
              </button>
            </div>
          </div>
        </div>
      </Portal>
    );
  }

  const inp = (req.input ?? {}) as Record<string, unknown>;
  const isShell = typeof inp.command === 'string' && !!inp.command;
  const name = req.displayName || req.tool;
  const icon = isShell ? '❯' : (TOOL_ICON[req.tool] ?? '◆');
  const preview = inputPreview(req);
  const alwaysLabel = suggestionLabel(t, req) ?? t('permission.allowAlways');

  return (
    <Portal>
      <div className="modal-overlay" onClick={() => onDecision('deny')}>
        <div
          className={`modal perm ${preview?.kind === 'diff' ? 'has-diff' : ''}`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="perm-head">
            <span className={`perm-icon ${isShell ? 'shell' : ''}`}>{icon}</span>
            <div className="perm-headtext">
              <div className="modal-title">{t('permission.title')}</div>
              <div className="perm-tool">{name}</div>
            </div>
          </div>

          {req.description && <div className="perm-desc">{req.description}</div>}

          {preview && <PreviewBlock p={preview} />}

          <div className="modal-actions perm-actions">
            <button type="button" className="btn deny" onClick={() => onDecision('deny')}>
              {t('permission.deny')}
            </button>
            <button type="button" className="btn" onClick={() => onDecision('allow_always')}>
              {alwaysLabel}
            </button>
            <button type="button" className="btn send" onClick={() => onDecision('allow')} autoFocus>
              {t('permission.allow')}
            </button>
          </div>
          <div className="perm-hint">{t('permission.shortcut')}</div>
        </div>
      </div>
    </Portal>
  );
}

// Rótulo do "Sempre permitir" derivado da sugestão do CLI (ex.: acceptEdits).
function suggestionLabel(t: Translator, req: PermissionRequest): string | undefined {
  const s = req.suggestions?.[0];
  if (s?.type === 'setMode' && s.mode === 'acceptEdits') return t('permission.alwaysEdits');
  return undefined;
}

type DiffSeg = { old: string; new: string; label?: string };
type Preview =
  | { kind: 'cmd'; text: string }
  | { kind: 'url'; text: string }
  | { kind: 'file'; label: string; text: string }
  | { kind: 'diff'; segs: DiffSeg[] }
  | { kind: 'json'; text: string };

// Bloco de preview por tipo de conteúdo.
function PreviewBlock({ p }: { p: Preview }) {
  if (p.kind === 'diff') {
    return (
      <div className="perm-preview">
        {p.segs.map((s, i) => (
          <DiffView key={i} oldText={s.old} newText={s.new} label={s.label} />
        ))}
      </div>
    );
  }
  if (p.kind === 'cmd') {
    return (
      <div className="perm-term">
        <span className="perm-term-prompt">❯</span>
        <code className="perm-term-cmd">{p.text}</code>
      </div>
    );
  }
  if (p.kind === 'url') {
    return <div className="perm-url">{p.text}</div>;
  }
  if (p.kind === 'file') {
    return (
      <div className="perm-preview">
        {p.label && (
          <div className="perm-file">
            <span className="perm-file-ico">▤</span>
            <span className="perm-file-name">{p.label}</span>
          </div>
        )}
        {p.text && <pre className="tool-pre mono">{p.text}</pre>}
      </div>
    );
  }
  return <pre className="tool-pre">{p.text}</pre>;
}

// Decide o preview pelo conteúdo do input (não pelo nome da tool — shells
// custom como "PowerShell" também trazem `command`).
function inputPreview(req: PermissionRequest): Preview | null {
  const inp = (req.input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : String(v));

  if (typeof inp.command === 'string' && inp.command) {
    return { kind: 'cmd', text: inp.command };
  }
  const file = str(inp.file_path);
  if (req.tool === 'Write') {
    return { kind: 'diff', segs: [{ old: req.oldText ?? '', new: str(inp.content), label: file }] };
  }
  if (req.tool === 'Edit') {
    return { kind: 'diff', segs: [{ old: str(inp.old_string), new: str(inp.new_string), label: file }] };
  }
  if (req.tool === 'MultiEdit' && Array.isArray(inp.edits)) {
    const segs = (inp.edits as Record<string, unknown>[]).map((e) => ({
      old: str(e.old_string),
      new: str(e.new_string),
      label: file,
    }));
    if (segs.length) return { kind: 'diff', segs };
  }
  if (typeof inp.url === 'string' && inp.url) {
    return { kind: 'url', text: inp.url };
  }
  // Genérico: JSON compacto, sem repetir a descrição já exibida acima.
  const rest: Record<string, unknown> = { ...inp };
  if (req.description && rest.description === req.description) delete rest.description;
  try {
    const json = JSON.stringify(rest, null, 2);
    if (json && json !== '{}') return { kind: 'json', text: clip(json, 600) };
  } catch {
    /* noop */
  }
  return null;
}

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '\n…' : s;
}
