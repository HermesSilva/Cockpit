import { useEffect } from 'react';
import { Portal } from './Portal';
import type { Translator } from '../i18n';
import type {
  UsageData,
  UsageBucket,
  UsageSlice,
  UsageAttribution,
  OtelStats,
  TokenTotals,
} from '../../../shared/protocol';
import { fmtUsdShort, fmtCompact, fmtInt } from '../util/format';

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
              <Meter t={t} locale={locale} label={t('usage.currentSession')} tone="warm" live={live} b={usage.buckets.fiveHour} />
              <Meter t={t} locale={locale} label={t('usage.weeklyAll')} tone="cool" live={live} b={usage.buckets.sevenDay} />
              {usage.buckets.weeklyScoped?.map((b) => (
                <Meter key={b.label} t={t} locale={locale} label={t('usage.weeklyModel', b.label)} tone="cool" live={live} b={b} />
              ))}
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

              {/* DETALHAMENTO LOCAL 7d (por modelo / origem) — estimativa de tabela */}
              {usage.breakdown && (usage.breakdown.byModel.length > 0 || usage.breakdown.bySource.length > 0) && (
                <Breakdown t={t} b={usage.breakdown} />
              )}

              {/* ATRIBUIÇÃO 7d: long context, subagentes, cache, tools/MCP */}
              {usage.attribution && <Attribution t={t} locale={locale} a={usage.attribution} />}

              {/* CONTADOR GLOBAL DE TOKENS (enviado/recebido/total) por dia */}
              {usage.tokens && usage.tokens.total > 0 && (
                <Tokens t={t} locale={locale} tk={usage.tokens} />
              )}

              {/* TELEMETRIA OTEL (opt-in) */}
              {usage.otel?.enabled && <Otel t={t} locale={locale} o={usage.otel} />}

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

// Etiqueta curta de modelo (claude-opus-4-8[1m] -> "opus 4.8 1M").
function modelLabel(id: string): string {
  if (id === 'unknown') return id;
  const oneM = /\[1m\]/i.test(id);
  const core = id.replace(/^claude-/i, '').replace(/\[1m\]/i, '');
  const m = core.match(/^(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?$/i);
  let s = core;
  if (m) s = `${m[1]} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`;
  return oneM ? `${s} 1M` : s;
}

// Barra proporcional de uma fatia (USD) dentro do total da categoria.
function SliceRow({
  t,
  label,
  usd,
  tokens,
  cacheRead,
  frac,
}: {
  t: Translator;
  label: string;
  usd: number;
  tokens: number;
  cacheRead: number;
  frac: number;
}) {
  return (
    <div className="usage-slice">
      <div className="usage-slice-head">
        <span className="usage-slice-label">{label}</span>
        <span className="usage-slice-val">
          {fmtUsdShort(usd)}
          <span className="usage-muted"> · {t('usage.slice.newTokens', fmtCompact(tokens))}</span>
        </span>
      </div>
      <div className="usage-bar">
        <span className="usage-bar-fill warm" style={{ width: `${Math.max(2, frac * 100)}%` }} />
      </div>
      {cacheRead > 0 && (
        <div className="usage-slice-sub usage-muted">
          {t('usage.slice.cacheRead', fmtCompact(cacheRead))}
        </div>
      )}
    </div>
  );
}

// Detalhamento local da janela de 7d: por modelo e por origem (main/subagent).
// Sempre estimativa de tabela (badge "≈"), independente do % real da conta.
function Breakdown({ t, b }: { t: Translator; b: { byModel: UsageSlice[]; bySource: UsageSlice[] } }) {
  const totalModel = b.byModel.reduce((s, x) => s + x.usd, 0) || 1;
  const totalSrc = b.bySource.reduce((s, x) => s + x.usd, 0) || 1;
  return (
    <>
      <div className="usage-section-label">
        {t('usage.breakdown')}
        <span className="usage-badge est">{t('usage.badge.est')}</span>
      </div>
      <div className="usage-sub-label">{t('usage.breakdown.byModel')}</div>
      {b.byModel.map((s) => (
        <SliceRow
          key={s.key}
          t={t}
          label={modelLabel(s.key)}
          usd={s.usd}
          tokens={s.tokens}
          cacheRead={s.cacheRead}
          frac={s.usd / totalModel}
        />
      ))}
      {b.bySource.length > 1 && (
        <>
          <div className="usage-sub-label">{t('usage.breakdown.bySource')}</div>
          {b.bySource.map((s) => (
            <SliceRow
              key={s.key}
              t={t}
              label={t(s.key === 'subagent' ? 'usage.source.subagent' : 'usage.source.main')}
              usd={s.usd}
              tokens={s.tokens}
              cacheRead={s.cacheRead}
              frac={s.usd / totalSrc}
            />
          ))}
        </>
      )}
      <div className="usage-muted usage-breakdown-note">{t('usage.breakdown.note')}</div>
    </>
  );
}

// Rótulo legível p/ um bucket de tool: "mcp:dase" -> "MCP · dase".
function toolLabel(key: string): string {
  if (key.startsWith('mcp:')) return `MCP · ${key.slice(4)}`;
  if (key.startsWith('skill:')) return `Skill · ${key.slice(6)}`;
  return key;
}

// Um insight: título com o número em destaque + explicação do que fazer com ele.
function Insight({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="usage-insight">
      <div className="usage-insight-title">{title}</div>
      <div className="usage-muted usage-insight-desc">{desc}</div>
    </div>
  );
}

// Atribuição 7d: responde "para onde foram meus tokens". Percentuais sobre os
// tokens NOVOS da janela. O contexto por tool é estimado a partir dos tool_result.
function Attribution({ t, locale, a }: { t: Translator; locale: string; a: UsageAttribution }) {
  const pct = (v: number) => Math.round(v * 100);
  const top = a.byTool.slice(0, 6);
  const maxTok = top.reduce((m, s) => Math.max(m, s.tokens), 0) || 1;
  const hasInsight = a.longContextPct > 0 || a.subagentPct > 0 || a.cacheHitPct != null;
  if (!hasInsight && top.length === 0) return null;
  return (
    <>
      <div className="usage-section-label">
        {t('usage.attribution')}
        <span className="usage-badge est">{t('usage.badge.est')}</span>
      </div>
      {a.longContextPct > 0 && (
        <Insight
          title={t('usage.i.context', pct(a.longContextPct))}
          desc={t('usage.i.context.desc')}
        />
      )}
      {a.subagentPct > 0 && (
        <Insight
          title={t('usage.i.subagents', pct(a.subagentPct))}
          desc={t('usage.i.subagents.desc')}
        />
      )}
      {a.cacheHitPct != null && (
        <Insight title={t('usage.i.cache', pct(a.cacheHitPct))} desc={t('usage.i.cache.desc')} />
      )}
      {top.length > 0 && (
        <>
          <div className="usage-sub-label">{t('usage.attr.byTool')}</div>
          {top.map((s) => (
            <div key={s.key} className="usage-slice">
              <div className="usage-slice-head">
                <span className="usage-slice-label">{toolLabel(s.key)}</span>
                <span className="usage-slice-val usage-muted">
                  {t('usage.attr.tool.calls', fmtInt(s.calls, locale), fmtCompact(s.tokens))}
                </span>
              </div>
              <div className="usage-bar">
                <span
                  className="usage-bar-fill cool"
                  style={{ width: `${Math.max(2, (s.tokens / maxTok) * 100)}%` }}
                />
              </div>
            </div>
          ))}
          <div className="usage-muted usage-breakdown-note">{t('usage.attr.note')}</div>
        </>
      )}
    </>
  );
}

// Contador GLOBAL de tokens (enviado/recebido/total), all-time + por dia. Fonte:
// transcripts locais — soma de todos os contextos e janelas do VSCode da máquina.
function Tokens({ t, locale, tk }: { t: Translator; locale: string; tk: TokenTotals }) {
  const max = tk.days.reduce((m, d) => Math.max(m, d.sent + d.received), 0) || 1;
  return (
    <>
      <div className="usage-section-label">
        {t('usage.tokens')}
        <span className="usage-badge live">{t('usage.tokens.badge')}</span>
      </div>
      <div className="usage-rows">
        <Row k={t('usage.tokens.sent')} v={fmtInt(tk.sent, locale)} />
        <Row k={t('usage.tokens.received')} v={fmtInt(tk.received, locale)} />
        <Row k={t('usage.tokens.total')} v={fmtInt(tk.total, locale)} accent />
      </div>
      {tk.days.length > 0 && (
        <>
          <div className="usage-sub-label">{t('usage.tokens.byDay')}</div>
          {tk.days.map((d) => (
            <div className="usage-slice" key={d.date}>
              <div className="usage-slice-head">
                <span className="usage-slice-label">{fmtDay(d.date, locale)}</span>
                <span className="usage-slice-val">
                  {fmtCompact(d.sent + d.received)}
                  <span className="usage-muted">
                    {' '}
                    ↑{fmtCompact(d.sent)} ↓{fmtCompact(d.received)}
                  </span>
                </span>
              </div>
              <div className="usage-bar">
                <span
                  className="usage-bar-fill cool"
                  style={{ width: `${Math.max(2, ((d.sent + d.received) / max) * 100)}%` }}
                />
              </div>
            </div>
          ))}
        </>
      )}
      <div className="usage-muted usage-breakdown-note">{t('usage.tokens.note')}</div>
    </>
  );
}

// "2026-06-30" -> rótulo curto localizado (ex.: "30 jun"). Hoje vira "Today/Hoje".
function fmtDay(iso: string, locale: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, (m ?? 1) - 1, d ?? 1);
  const now = new Date();
  const sameDay = dt.getFullYear() === now.getFullYear() && dt.getMonth() === now.getMonth() && dt.getDate() === now.getDate();
  if (sameDay) return locale.startsWith('pt') ? 'Hoje' : 'Today';
  try {
    return new Intl.DateTimeFormat(locale, { day: '2-digit', month: 'short' }).format(dt);
  } catch {
    return iso;
  }
}

// Telemetria OTEL (opt-in): LOC por modelo, sessões, commits, PRs, decisões.
function Otel({ t, locale, o }: { t: Translator; locale: string; o: OtelStats }) {
  return (
    <>
      <div className="usage-section-label">
        {t('usage.otel')}
        <span className="usage-badge live">{t('usage.otel.live')}</span>
      </div>
      {o.costByModel && o.costByModel.length > 0 && (
        <>
          <div className="usage-sub-label">{t('usage.otel.costByModel')}</div>
          {o.costByModel.map((s) => (
            <SliceRow
              key={s.key}
              t={t}
              label={modelLabel(s.key)}
              usd={s.usd}
              tokens={s.tokens}
              cacheRead={s.cacheRead}
              frac={s.usd / (o.costByModel!.reduce((a, x) => a + x.usd, 0) || 1)}
            />
          ))}
        </>
      )}
      <div className="usage-rows">
        {(o.linesAdded != null || o.linesRemoved != null) && (
          <Row
            k={t('usage.otel.loc')}
            v={`+${fmtInt(o.linesAdded ?? 0, locale)} / −${fmtInt(o.linesRemoved ?? 0, locale)}`}
            accent
          />
        )}
        {o.sessionCount != null && <Row k={t('usage.otel.sessions')} v={fmtInt(o.sessionCount, locale)} />}
        {o.commitCount != null && <Row k={t('usage.otel.commits')} v={fmtInt(o.commitCount, locale)} />}
        {o.prCount != null && <Row k={t('usage.otel.prs')} v={fmtInt(o.prCount, locale)} />}
      </div>
      {o.locByModel && o.locByModel.length > 0 && (
        <>
          <div className="usage-sub-label">{t('usage.otel.locByModel')}</div>
          {o.locByModel.map((s) => (
            <Row key={s.key} k={modelLabel(s.key)} v={`${fmtInt(s.tokens, locale)} ${t('usage.otel.lines')}`} />
          ))}
        </>
      )}
      {o.toolDecisions && o.toolDecisions.length > 0 && (
        <>
          <div className="usage-sub-label">{t('usage.otel.decisions')}</div>
          {o.toolDecisions.map((d) => (
            <Row key={d.tool} k={d.tool} v={`✓ ${d.accept} · ✕ ${d.reject}`} />
          ))}
        </>
      )}
    </>
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
