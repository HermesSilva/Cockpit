import { useEffect, useMemo, useState } from 'react';
import type { Translator } from '../i18n';
import type { SkillState, SkillOverride } from '../../../shared/protocol';
import { Portal } from './Portal';

interface Props {
  t: Translator;
  skills?: SkillState[];
  listingTokens?: number;
  total?: number;
  listed?: number;
  busy: boolean;
  onRefresh: () => void;
  onOverride: (name: string, value: SkillOverride) => void;
  onClose: () => void;
}

const OVERRIDES: SkillOverride[] = ['on', 'name-only', 'user-invocable-only', 'off'];

// Grupos por origem. `source` vem do engine (get_context_usage): medido no CLI 2.1.217
// como 'projectSettings' | 'userSettings' | 'built-in'. Qualquer valor novo cai em 'other'.
type Group = 'project' | 'user' | 'built-in' | 'other';
const GROUP_ORDER: Group[] = ['project', 'user', 'built-in', 'other'];

export function groupOf(source?: string): Group {
  if (source === 'projectSettings') return 'project';
  if (source === 'userSettings') return 'user';
  if (source === 'built-in') return 'built-in';
  return 'other';
}

/** O eixo de OBSERVAÇÃO (o que está acontecendo), separado do de configuração. */
type Observed = 'active' | 'resident' | 'light';

/**
 * `resident` é o estado que não pode ser escondido: a skill foi desligada mas o corpo dela
 * continua no contexto — desligar impede re-disparo, não descarrega (o engine não oferece
 * como descarregar uma skill isolada).
 */
export function observed(s: SkillState): Observed {
  if (s.active !== true) return 'light';
  const off = s.override === 'off' || s.override === 'user-invocable-only';
  return off ? 'resident' : 'active';
}

// Painel "Skills" (X2). Dois eixos lado a lado: o dropdown CONFIGURA o que entra no
// listing; a coluna ao lado OBSERVA o que já está no contexto. Nenhum número inventado —
// metadados são medidos pelo engine, o corpo carregado é estimativa e vai rotulado.
export function SkillsModal({
  t,
  skills,
  listingTokens,
  total,
  listed,
  busy,
  onRefresh,
  onOverride,
  onClose,
}: Props) {
  const [filter, setFilter] = useState<Group | 'all'>('all');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const list = skills ?? [];
  const groups = useMemo(() => {
    const map = new Map<Group, SkillState[]>();
    for (const s of list) {
      const g = groupOf(s.source);
      const arr = map.get(g) ?? [];
      arr.push(s);
      map.set(g, arr);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g)! }));
  }, [list]);

  // Somas: metadados vêm medidos do engine; o corpo carregado é ESTIMADO (e só existe
  // quando conseguimos medir a mensagem injetada), por isso os dois totais são separados.
  const activeTokens = list.reduce((a, s) => a + (s.active ? (s.activeTokens ?? 0) : 0), 0);
  const activeCount = list.filter((s) => s.active).length;
  const shown = filter === 'all' ? groups : groups.filter((g) => g.group === filter);

  return (
    <Portal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal usage" onClick={(e) => e.stopPropagation()}>
          <div className="usage-head">
            <span className="modal-title">{t('skills.title')}</span>
            <button type="button" className="ctx-link mcp-refresh" onClick={onRefresh} disabled={busy}>
              ⟳ {t('plugins.refresh')}
            </button>
            <button type="button" className="usage-close" title={t('common.close')} onClick={onClose}>
              ✕
            </button>
          </div>

          {busy && list.length === 0 ? (
            <div className="usage-loading">
              <span className="usage-spinner" aria-hidden="true" />
              <span>{t('skills.loading')}</span>
            </div>
          ) : list.length === 0 ? (
            <div className="usage-body">
              <div className="usage-muted">{t('skills.none')}</div>
              <div className="usage-muted">{t('skills.hint')}</div>
            </div>
          ) : (
            <div className="usage-body">
              <div className="skills-tiles">
                <Tile label={t('skills.tile.count')} value={String(total ?? list.length)} />
                <Tile
                  label={t('skills.tile.metadata')}
                  value={fmtTk(listingTokens)}
                  note={listed != null && total != null && listed < total ? t('skills.tile.listedOf', String(listed), String(total)) : undefined}
                />
                <Tile
                  label={t('skills.tile.active')}
                  value={activeCount === 0 ? '—' : fmtTk(activeTokens)}
                  note={activeCount > 0 ? t('skills.tile.estimated') : undefined}
                  strong={activeCount > 0}
                />
              </div>

              {groups.length > 1 && (
                <div className="skills-filters">
                  {groups.map((g) => (
                    <button
                      key={g.group}
                      type="button"
                      className={`skills-chip ${filter === g.group ? 'on' : ''}`}
                      onClick={() => setFilter(g.group)}
                    >
                      {t(`skills.group.${g.group}` as never)}
                    </button>
                  ))}
                  <button
                    type="button"
                    className={`skills-chip ${filter === 'all' ? 'on' : ''}`}
                    onClick={() => setFilter('all')}
                  >
                    {t('skills.group.all')}
                  </button>
                </div>
              )}

              {shown.map(({ group, items }) => (
                <div key={group}>
                  <div className="usage-section-label">
                    {t(`skills.group.${group}` as never)} · {items.length}
                  </div>
                  {items.map((s) => (
                    <SkillRow key={s.name} t={t} s={s} onOverride={onOverride} />
                  ))}
                </div>
              ))}

              <div className="skills-legend">
                <div>
                  <span className="skills-obs active">⚡ {t('skills.obs.active')}</span> — {t('skills.legend.active')}
                </div>
                <div>
                  <span className="skills-obs light">{t('skills.obs.light')}</span> — {t('skills.legend.light')}
                </div>
                <div>
                  <span className="skills-obs resident">⚠ {t('skills.obs.resident')}</span> — {t('skills.legend.resident')}
                </div>
                <div className="skills-legend-scope">{t('skills.legend.scope')}</div>
              </div>
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}

function Tile({
  label,
  value,
  note,
  strong,
}: {
  label: string;
  value: string;
  note?: string;
  strong?: boolean;
}) {
  return (
    <div className={`skills-tile ${strong ? 'strong' : ''}`}>
      <div className="skills-tile-label">{label}</div>
      <div className="skills-tile-value">{value}</div>
      {note && <div className="skills-tile-note">{note}</div>}
    </div>
  );
}

function SkillRow({
  t,
  s,
  onOverride,
}: {
  t: Translator;
  s: SkillState;
  onOverride: (name: string, value: SkillOverride) => void;
}) {
  const obs = observed(s);
  const group = groupOf(s.source);
  return (
    <div className={`mcp-card skills-row ${obs}`}>
      <div className="mcp-card-head">
        <span className="mcp-name">{s.name}</span>
        <span className="mcp-transport">{t(`skills.group.${group}` as never)}</span>
        <span className={`skills-obs ${obs}`} title={t(`skills.legend.${obs}` as never)}>
          {obs === 'active' && '⚡ '}
          {obs === 'resident' && '⚠ '}
          {t(`skills.obs.${obs}` as never)}
        </span>
      </div>
      <div className="skills-row-body">
        <div className="mcp-target">
          {t('skills.metaTokens', s.metaTokens != null ? String(s.metaTokens) : '?')}
          {obs === 'active' &&
            (s.activeTokens != null ? (
              <span className="skills-active-tk"> · {t('skills.activeTokens', fmtTk(s.activeTokens))}</span>
            ) : (
              <span className="skills-active-tk"> · {t('skills.activeUnknown')}</span>
            ))}
          {/* Desligada e ainda residente: o número é o que continua ocupando contexto. */}
          {obs === 'resident' && (
            <span className="skills-resident-tk">
              {' · '}
              {s.activeTokens != null
                ? t('skills.residentTokens', fmtTk(s.activeTokens))
                : t('skills.residentUnknown')}
            </span>
          )}
          {obs === 'light' && s.override === 'name-only' && ` · ${t('skills.note.nameOnly')}`}
          {obs === 'light' && s.override === 'user-invocable-only' && ` · ${t('skills.note.slashOnly')}`}
          {obs === 'light' && s.override === 'off' && ` · ${t('skills.note.off')}`}
        </div>
        <select
          className="skills-select"
          title={t('skills.overrideHelp')}
          value={s.override ?? 'on'}
          onChange={(e) => onOverride(s.name, e.target.value as SkillOverride)}
        >
          {OVERRIDES.map((o) => (
            <option key={o} value={o}>
              {t(`skills.override.${o}` as never)}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** 1928 → "1.9k". Sem valor conhecido → "—". */
function fmtTk(n?: number): string {
  if (n == null) return '—';
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}
