import { useEffect } from 'react';
import { Portal } from './Portal';
import type { Translator } from '../i18n';
import type { UsageData, UsageBucket } from '../../../shared/protocol';
import { fmtUsdShort } from '../util/format';

interface Props {
  t: Translator;
  locale: string;
  usage: UsageData | null; // null = carregando (dado quente em busca)
  onClose: () => void;
  onManage: () => void;
  onEnableTracking: () => void;
}

// Modal "Account & Usage" (botão Usage). Reproduz o /usage do CLI: conta exata
// (auth status) + janelas de limite reais (API OAuth, read-only).
export function UsageModal({ t, locale, usage, onClose, onManage, onEnableTracking }: Props) {
  const live = !!usage && usage.source !== 'estimate';
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <Portal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal usage" onClick={(e) => e.stopPropagation()}>
          <div className="usage-head">
            <span className="modal-title">{t('usage.title')}</span>
            <button type="button" className="usage-close" title={t('common.close')} onClick={onClose}>
              ✕
            </button>
          </div>

          {!usage ? (
            <div className="usage-loading">
              <span className="usage-spinner" aria-hidden="true" />
              <span>{t('usage.loading')}</span>
            </div>
          ) : (
            <div className="usage-body">
              {/* ACCOUNT */}
              <div className="usage-section-label">{t('usage.account')}</div>
              {usage.account.loggedIn ? (
                <div className="usage-rows">
                  <Row k={t('usage.authMethod')} v={authLabel(usage.account.authMethod)} />
                  {usage.account.email && <Row k={t('usage.email')} v={usage.account.email} />}
                  {usage.account.orgName && <Row k={t('usage.org')} v={usage.account.orgName} />}
                  {usage.account.plan && <Row k={t('usage.plan')} v={planLabel(usage.account.plan)} accent />}
                </div>
              ) : (
                <div className="usage-muted">{t('usage.notLoggedIn')}</div>
              )}

              {/* USAGE WINDOWS */}
              <div className="usage-section-label">
                {t('usage.usage')}
                <span className={`usage-badge ${live ? 'live' : 'est'}`}>
                  {live ? t('usage.badge.live') : t('usage.badge.est')}
                </span>
              </div>
              <Meter t={t} locale={locale} label={t('usage.session5h')} tone="warm" live={live} b={usage.buckets.fiveHour} />
              <Meter t={t} locale={locale} label={t('usage.weekly7d')} tone="cool" live={live} b={usage.buckets.sevenDay} />
              {usage.buckets.sevenDaySonnet && (
                <Meter t={t} locale={locale} label={t('usage.weeklySonnet')} tone="cool" live={live} b={usage.buckets.sevenDaySonnet} />
              )}
              {!live && (
                <div className="usage-est-note">
                  <span>{t(usage.trackingEnabled ? 'usage.est.waiting' : 'usage.est.note')}</span>
                  {!usage.trackingEnabled && (
                    <button type="button" className="usage-cta" onClick={onEnableTracking}>
                      {t('usage.enableTracking')}
                    </button>
                  )}
                </div>
              )}
              <button type="button" className="usage-link" onClick={onManage}>
                {t('usage.manage')}
              </button>
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}

function Row({ k, v, accent }: { k: string; v: string; accent?: boolean }) {
  return (
    <div className="usage-row">
      <span className="usage-row-k">{k}</span>
      <span className={`usage-row-v ${accent ? 'accent' : ''}`}>{v}</span>
    </div>
  );
}

// Barra de uma janela de limite (sessão/semana). % real quando há; senão estimativa.
function Meter({
  t,
  locale,
  label,
  tone,
  live,
  b,
}: {
  t: Translator;
  locale: string;
  label: string;
  tone: 'warm' | 'cool';
  live: boolean;
  b?: UsageBucket;
}) {
  const pct = b?.usedPct;
  const known = typeof pct === 'number';
  const w = known ? Math.max(0, Math.min(1, pct)) * 100 : 0;
  // Estimativa: prefixo "≈" e barra esmaecida (não é o limite real da conta).
  const right = known
    ? `${live ? '' : '≈'}${Math.round(w)}%`
    : b?.usd != null
      ? fmtUsdShort(b.usd)
      : t('usage.na');
  return (
    <div className="usage-meter">
      <div className="usage-meter-head">
        <span className="usage-meter-label">{label}</span>
        <span className="usage-meter-pct">{right}</span>
      </div>
      <div className="usage-bar">
        <span
          className={`usage-bar-fill ${tone} ${known ? '' : 'unknown'} ${live ? '' : 'estimate'}`}
          style={{ width: `${w}%` }}
        />
      </div>
      {b?.resetsAt && <div className="usage-meter-sub">{t('usage.resetsIn', relReset(b.resetsAt, locale))}</div>}
    </div>
  );
}

function authLabel(m?: string): string {
  if (m === 'claude.ai') return 'Claude AI';
  if (m === 'console') return 'Anthropic Console';
  if (m === 'apiKey') return 'API key';
  return m || '—';
}
function planLabel(p?: string): string {
  if (!p) return '—';
  return `Claude ${p.charAt(0).toUpperCase()}${p.slice(1)}`;
}

// "Resets in 3h" / "3d" / "12m" a partir do ISO de reset.
function relReset(iso: string, _locale: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (Number.isNaN(ms) || ms <= 0) return '0m';
  const m = Math.round(ms / 60000);
  if (m < 60) return `${m}m`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.round(h / 24)}d`;
}
