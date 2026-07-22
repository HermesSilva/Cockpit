import { useEffect } from 'react';
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

// Painel "Skills" (X2). Fonte: o control_request `get_context_usage` do CLI (cálculo
// local: não cria turno nem gasta token) para os metadados, e o stream para saber o que
// já foi acionado. Não existe botão de "descarregar": o engine não permite tirar o corpo
// de UMA skill do contexto — o que existe de verdade é o override de listing.
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const list = skills ?? [];

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
              <div className="usage-section-label">
                {t('skills.title')}
                <span className="usage-badge live">
                  {t(
                    'skills.listing',
                    String(listingTokens ?? 0),
                    String(listed ?? list.filter((s) => s.listed).length),
                    String(total ?? list.length),
                  )}
                </span>
              </div>
              {list.map((s) => (
                <SkillRow key={s.name} t={t} s={s} onOverride={onOverride} />
              ))}
              <div className="usage-stamp">{t('skills.overrideHelp')}</div>
            </div>
          )}
        </div>
      </div>
    </Portal>
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
  const active = s.active === true;
  const sourceLabel = s.source ? t(`skills.source.${s.source}` as never) : undefined;
  return (
    <div className={`mcp-card ${active ? 'connected' : ''}`}>
      <div className="mcp-card-head">
        <span className="mcp-name">{s.name}</span>
        {sourceLabel && <span className="mcp-transport">{sourceLabel}</span>}
        <span
          className={`mcp-status ${active ? 'connected' : 'unknown'}`}
          title={active ? t('skills.activeHint') : t('skills.lightHint')}
        >
          {active ? t('skills.stateActive') : t('skills.stateLight')}
        </span>
      </div>
      <div className="mcp-target">
        {s.metaTokens != null && <span>{t('skills.metaTokens', String(s.metaTokens))}</span>}
        {active && (
          <span>
            {' · '}
            {s.activeTokens != null
              ? t('skills.activeTokens', String(s.activeTokens))
              : t('skills.activeUnknown')}
            {s.invokedBy &&
              ` (${s.invokedBy === 'model' ? t('skills.invokedByModel') : t('skills.invokedByUser')})`}
          </span>
        )}
      </div>
      {/* Skill já carregada: o override continua valendo (não relista, não re-dispara),
          mas seria mentira sugerir que ele descarrega o corpo — dizemos o que acontece. */}
      {active && <div className="usage-alert">{t('skills.noUnload')}</div>}
      <label className="mcp-tools-toggle">
        {t('skills.override')}{' '}
        <select
          value={s.override ?? 'on'}
          onChange={(e) => onOverride(s.name, e.target.value as SkillOverride)}
        >
          {OVERRIDES.map((o) => (
            <option key={o} value={o}>
              {t(`skills.override.${o}` as never)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
