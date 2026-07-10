import { useState, useRef, useEffect } from 'react';
import type { Translator } from '../i18n';
import type { StatsSnapshot, SessionConfig, SessionInfo } from '../../../shared/protocol';
import { fmtInt, fmtPct, fmtCompact, fmtBytes, fmtDuration, fmtUsdShort, fmtClock } from '../util/format';
import type { TooltipRow } from './Tooltip';
import { Controls } from './Controls';
import { Tooltip, type TooltipMeta } from './Tooltip';
import { send, readState, saveState } from '../vscodeApi';

// Procedência de um dado: origem + nível de confiança, já localizados, p/ o
// rodapé do hint (chips coloridos). Mantém as descrições i18n limpas.
type Origin = 'server' | 'local' | 'computed' | 'estimate' | 'cli';
function meta(t: Translator, origin: Origin, confidence: 'high' | 'medium' | 'low'): TooltipMeta {
  return {
    originLabel: t('meta.origin.label'),
    origin: t(`meta.origin.${origin}`),
    confidenceLabel: t('meta.conf.label'),
    confidence,
    confidenceText: t(`meta.conf.${confidence}`),
  };
}

interface Props {
  t: Translator;
  locale: string;
  cliMissing: boolean;
  cockpitVersion?: string;
  cliVersion?: string;
  cliLatest?: string;
  stats?: StatsSnapshot;
  busy?: boolean; // contexto ativo processando um turno → spinner no card
  config?: SessionConfig;
  activeModel?: string;
  loggedIn: boolean;
  sessions: SessionInfo[];
  cwd?: string;
  activeSessionId?: string;
  busySessions?: Set<string>; // sessionIds com turno em andamento → spinner no card
  onNewSession: () => void;
  onOpenFolder: (path: string) => void;
  onSettings: () => void;
  onUsage: () => void;
  onPlugins: () => void;
  onCredentials: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onUpdate: () => void;
  onInstall: () => void;
  onOpenLink: (href: string) => void;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
  onPermission: (mode: string) => void;
  onAllowAgents: (value: boolean) => void;
  onDaseEnabled: (value: boolean) => void;
  onResume: (id: string) => void;
  onReload: (id: string) => void;
  onRemote: (id: string) => void;
  onDelete: (session: SessionInfo) => void;
  onRename: (session: SessionInfo, name: string) => void;
  onDeleteAll: () => void;
}

// Hub na Activity Bar: centro de controle. Barra de botões + info do contexto
// ativo (janela de contexto + controles de sessão) + grade de contextos salvos.
// O chat de cada contexto vive numa webview própria no editor.
export function HubView({
  t,
  locale,
  cliMissing,
  cockpitVersion,
  cliVersion,
  cliLatest,
  stats,
  busy,
  config,
  activeModel,
  loggedIn,
  sessions,
  cwd,
  activeSessionId,
  busySessions,
  onNewSession,
  onOpenFolder,
  onSettings,
  onUsage,
  onPlugins,
  onCredentials,
  onLogin,
  onLogout,
  onUpdate,
  onInstall,
  onOpenLink,
  onModel,
  onEffort,
  onPermission,
  onAllowAgents,
  onDaseEnabled,
  onResume,
  onReload,
  onRemote,
  onDelete,
  onRename,
  onDeleteAll,
}: Props) {
  return (
    <div className="hub">
      <header className="hub-head">
        <svg className="hub-logo" width="20" height="20" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <g fill="#ff7a18">
            <path id="hub-flame" d="M12 0.4C14.1 3.4 13.9 4.9 12 6.3C10.1 4.9 9.9 3.4 12 0.4Z" />
            <use href="#hub-flame" transform="rotate(45 12 12)" />
            <use href="#hub-flame" transform="rotate(90 12 12)" />
            <use href="#hub-flame" transform="rotate(135 12 12)" />
            <use href="#hub-flame" transform="rotate(180 12 12)" />
            <use href="#hub-flame" transform="rotate(225 12 12)" />
            <use href="#hub-flame" transform="rotate(270 12 12)" />
            <use href="#hub-flame" transform="rotate(315 12 12)" />
          </g>
          <circle cx="12" cy="12" r="7.7" fill="none" stroke="#ff9a3c" strokeWidth="1.7" />
          <g fill="none" stroke="#4da3ff" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7.8 16.6 L10.5 8.0 L13.2 16.6" />
            <path d="M8.7 13.9 H12.3" />
            <path d="M15.9 8.0 V16.6" strokeWidth="2.1" />
          </g>
        </svg>
        <span className="hub-title">Tootega Cockpit</span>
        {cockpitVersion && <span className="hub-ver">v{cockpitVersion}</span>}
        {cliVersion ? (
          <>
            <Tooltip
              text={
                cliBelowMin(cliVersion)
                  ? t('about.cliBelowMin', MIN_CLI_VERSION)
                  : t('about.cliReleaseNotes')
              }
            >
              <button
                type="button"
                className={`hub-cli ${cliOutdated(cliVersion, cliLatest) || cliBelowMin(cliVersion) ? 'outdated' : ''}`}
                onClick={() => onOpenLink(CLI_RELEASES_URL)}
              >
                Claude CLI {semver(cliVersion) ?? cliVersion}
              </button>
            </Tooltip>
            {(cliOutdated(cliVersion, cliLatest) || cliBelowMin(cliVersion)) && (
              <Tooltip
                text={
                  cliBelowMin(cliVersion)
                    ? t('about.cliBelowMin', MIN_CLI_VERSION)
                    : t('about.cliOutdated', semver(cliLatest) ?? cliLatest ?? '')
                }
              >
                <button type="button" className="hub-update" onClick={onUpdate}>
                  ↑ {t('about.update')}
                </button>
              </Tooltip>
            )}
          </>
        ) : (
          <Tooltip text={t('about.install.tip')}>
            <button type="button" className="hub-update install" onClick={onInstall}>
              ⤓ {t('about.install')}
            </button>
          </Tooltip>
        )}
      </header>

      {/* Barra de botões */}
      <div className="ctx-panel-actions">
        <Tooltip title={t('usage.title')} text={t('tip.usage.desc')}>
          <button type="button" className="ctx-link" onClick={onUsage}>
            📊 {t('usage.button')}
          </button>
        </Tooltip>
        {loggedIn ? (
          <Tooltip title={t('tip.logout.title')} text={t('tip.logout.desc')}>
            <button type="button" className="ctx-link" onClick={onLogout}>
              🚪 {t('tip.logout.title')}
            </button>
          </Tooltip>
        ) : (
          <Tooltip title={t('tip.login.title')} text={t('tip.login.desc')}>
            <button type="button" className="ctx-link" onClick={onLogin}>
              🔑 {t('tip.login.title')}
            </button>
          </Tooltip>
        )}
        <Tooltip title={t('plugins.title')} text={t('plugins.desc')}>
          <button type="button" className="ctx-link" onClick={onPlugins}>
            🧩 {t('plugins.title')}
          </button>
        </Tooltip>
        <Tooltip title={t('creds.title')} text={t('creds.open')}>
          <button type="button" className="ctx-link" onClick={onCredentials}>
            🔐 {t('creds.title')}
          </button>
        </Tooltip>
        <Tooltip
          className="hub-settings-wrap"
          title={t('tip.settings.title')}
          text={t('tip.settings.desc')}
        >
          <button type="button" className="ctx-link" onClick={onSettings}>
            ⚙️ {t('tip.settings.title')}
          </button>
        </Tooltip>
      </div>

      <Onboarding t={t} cliMissing={cliMissing} loggedIn={loggedIn} hasSessions={sessions.length > 0} />

      <div className="ctx-panel-body">
        {/* Painel de informações do contexto ativo */}
        <section className="ctx-panel-info">
          {cliMissing ? (
            <div className="muted">{t('status.cliMissing')}</div>
          ) : stats ? (
            <ContextInfo t={t} locale={locale} stats={stats} busy={busy} />
          ) : (
            <div className="muted">{t('ctxPanel.noStats')}</div>
          )}
          {config && (
            <div className="ctx-panel-controls">
              <Controls
                t={t}
                config={config}
                activeModel={activeModel}
                onModel={onModel}
                onEffort={onEffort}
                onPermission={onPermission}
                onAllowAgents={onAllowAgents}
                onDaseEnabled={onDaseEnabled}
              />
            </div>
          )}
        </section>

        <div className="ctx-panel-sep" role="separator" />

        {/* Grade de contextos salvos (sessões) */}
        <section className="ctx-panel-grid-wrap">
          <div className="ctx-panel-grid-head">
            <span className="col-title">{t('ctxPanel.contexts')}</span>
            <span className="ctx-panel-count">{sessions.length}</span>
            <Tooltip title={t('tip.new.title')} text={t('tip.new.desc')}>
              <button type="button" className="ctx-link hub-new" onClick={onNewSession}>
                ＋ {t('tip.new.title')}
              </button>
            </Tooltip>
            {sessions.length > 0 && (
              <Tooltip title={t('tip.deleteAll.title')} text={t('tip.deleteAll.desc')}>
                <button type="button" className="ctx-link hub-del-all" onClick={onDeleteAll}>
                  🗑 {t('sessions.deleteAll')}
                </button>
              </Tooltip>
            )}
          </div>
          {cwd && (
            <Tooltip className="tt-block" title={t('ctxPanel.openFolder')} text={cwd}>
              <button type="button" className="hub-folder" onClick={() => onOpenFolder(cwd)}>
                <span className="hub-folder-ico">🗀</span>
                <span className="hub-folder-path">{cwd}</span>
              </button>
            </Tooltip>
          )}
          {sessions.length === 0 ? (
            <div className="muted sessions-empty">{t('sessions.empty')}</div>
          ) : (
            <div className="ctx-groups">
              {groupSessions(sessions).map((g) => (
                <div className="ctx-group" key={g.key}>
                  <div className="ctx-group-head">{t(g.key as Parameters<typeof t>[0])}</div>
                  <div className="ctx-grid">
                    {g.items.map((s) => (
                      <SessionCard
                        key={s.id}
                        s={s}
                        t={t}
                        active={s.id === activeSessionId}
                        running={busySessions?.has(s.id) ?? false}
                        onResume={onResume}
                        onReload={onReload}
                        onRemote={onRemote}
                        onDelete={onDelete}
                        onRename={onRename}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// Card de um contexto salvo. Abre ao clicar; ✏ entra em edição inline do nome,
// 🗑 remove. Ao salvar, dispara onRename (host persiste e atualiza o título da
// webview aberta, se houver).
function SessionCard({
  s,
  t,
  active,
  running,
  onResume,
  onReload,
  onRemote,
  onDelete,
  onRename,
}: {
  s: SessionInfo;
  t: Translator;
  active: boolean;
  running: boolean;
  onResume: (id: string) => void;
  onReload: (id: string) => void;
  onRemote: (id: string) => void;
  onDelete: (session: SessionInfo) => void;
  onRename: (session: SessionInfo, name: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(s.title || '');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  function startEdit(): void {
    setDraft(s.title || '');
    setEditing(true);
  }
  function commit(): void {
    const name = draft.trim();
    if (name && name !== s.title) onRename(s, name);
    setEditing(false);
  }

  if (editing) {
    return (
      <div className={`ctx-card editing ${active ? 'active' : ''}`}>
        <input
          ref={inputRef}
          className="ctx-card-edit"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            else if (e.key === 'Escape') setEditing(false);
          }}
          onBlur={commit}
          aria-label={t('sessions.rename')}
        />
        <span className="ctx-card-meta">
          {fmtDate(s.updatedAt)} · {s.messageCount} {t('sessions.messages')}
        </span>
      </div>
    );
  }

  return (
    <Tooltip
      className="tt-block"
      title={s.title || t('session.untitled')}
      text={t('sessions.openHint')}
      rows={sessionRows(s, t)}
    >
      <button
        type="button"
        className={`ctx-card ${active ? 'active' : ''} ${running ? 'running' : ''}`}
        onClick={() => onResume(s.id)}
      >
        <span className="ctx-card-title">
          {running && (
            <span
              className="voice-spinner ctx-card-spinner"
              role="status"
              title={t('status.busy')}
              aria-label={t('status.busy')}
            />
          )}
          {s.title || t('session.untitled')}
        </span>
        <span className="ctx-card-meta">
          {fmtDate(s.updatedAt)} · {s.messageCount} {t('sessions.messages')}
          {s.sizeBytes != null && <span className="muted"> · {fmtBytes(s.sizeBytes)}</span>}
        </span>
        <span className="ctx-card-actions">
          <span
            className="ctx-card-remote"
            title={t('sessions.remote')}
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onRemote(s.id);
            }}
          >
            📱
          </span>
          <span
            className="ctx-card-reload"
            title={t('sessions.reload')}
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onReload(s.id);
            }}
          >
            ↻
          </span>
          <span
            className="ctx-card-edit-btn"
            title={t('sessions.rename')}
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              startEdit();
            }}
          >
            ✏
          </span>
          <span
            className="ctx-card-del"
            title={t('sessions.delete')}
            role="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(s);
            }}
          >
            🗑
          </span>
        </span>
      </button>
    </Tooltip>
  );
}

// Vida do cache (TTL de 1h): barra do tempo restante + checkbox de keep-alive.
// `now` vem do tick de 1s do pai (contagem regressiva ao vivo).
function CacheLife({ t, stats, now }: { t: Translator; stats: StatsSnapshot; now: number }) {
  const expiresAt = stats.cacheExpiresAt ?? 0;
  const lifeMs = stats.cacheLifeMs || 3_600_000;
  const remaining = Math.max(0, expiresAt - now);
  const alive = remaining > 0;
  const pct = Math.min(1, remaining / lifeMs); // fração de vida RESTANTE
  const band = !alive ? 'crit' : pct > 0.25 ? 'ok' : pct > 0.08 ? 'warn' : 'crit';
  const keep = !!stats.keepCacheAlive;
  return (
    <Tooltip className="tt-block" title={t('stats.cache.life')} text={t('tip.ctx.cacheLife')} meta={meta(t, 'computed', 'low')}>
      <div className="stat-row stat-row-session">
        <span className="stat-k">{t('stats.cache.life')}</span>
        <span className={`stat-v ${band}`}>
          {alive ? t('stats.cache.life.left', fmtDuration(remaining)) : t('stats.cache.life.expired')}
        </span>
      </div>
      <div className="meter">
        <div className={`meter-fill ${band}`} style={{ width: `${pct * 100}%` }} />
      </div>
      <label className="ctx-keepalive">
        <input
          type="checkbox"
          checked={keep}
          onChange={(e) => send({ kind: 'setKeepCacheAlive', value: e.target.checked })}
        />
        <span>{t('stats.cache.keepAlive')}</span>
      </label>
    </Tooltip>
  );
}

function ContextInfo({
  t,
  locale,
  stats,
  busy,
}: {
  t: Translator;
  locale: string;
  stats: StatsSnapshot;
  busy?: boolean;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!stats.sessionStartTs) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [stats.sessionStartTs]);

  const used = stats.contextUsed;
  const limit = stats.contextLimit || 1;
  const pct = Math.min(1, used / limit);
  const band = pct < 0.6 ? 'ok' : pct < 0.85 ? 'warn' : 'crit';
  const elapsed = stats.sessionStartTs ? now - stats.sessionStartTs : undefined;

  // Aceitação de ferramentas: só mostra se houve decisões na sessão.
  const toolRows = stats.toolAcceptance?.filter((d) => d.allow + d.allowAlways + d.deny > 0) ?? [];

  return (
    <>
      <Tooltip className="tt-block" title={t('stats.context')} text={t('tip.ctx.context')} meta={meta(t, 'server', 'high')}>
        <div className="ctx-info-head">
          <span className="col-title">
            {t('stats.context')}
            {busy && (
              <span
                className="voice-spinner ctx-info-spinner"
                role="status"
                title={t('status.busy')}
                aria-label={t('status.busy')}
              />
            )}
          </span>
          <span className={`ctx-info-pct ${band}`}>{fmtPct(pct)}</span>
        </div>
        <div className="meter">
          <div className={`meter-fill ${band}`} style={{ width: `${pct * 100}%` }} />
        </div>
      </Tooltip>
      <div className="ctx-info-nums">
        {t('stats.context.used', fmtInt(used, locale), fmtInt(limit, locale))}
        <span className="muted">
          {' '}
          · {t('stats.context.remaining', fmtInt(Math.max(0, limit - used), locale))}
        </span>
      </div>
      {pct >= 0.85 && <div className="alert">{t('alert.contextHigh')}</div>}

      {/* Duração da sessão */}
      {elapsed != null && (
        <Tooltip className="tt-block" title={t('stats.session.duration')} text={t('tip.ctx.duration')} meta={meta(t, 'local', 'high')}>
          <div className="stat-row stat-row-session">
            <span className="stat-k">{t('stats.session.duration')}</span>
            <span className="stat-v">{fmtDuration(elapsed)}</span>
          </div>
        </Tooltip>
      )}

      {/* Vida do cache (TTL de 1h) + keep-alive */}
      {stats.cacheExpiresAt != null && (
        <CacheLife t={t} stats={stats} now={now} />
      )}

      <div className="ctx-info-grid">
        <div>
          <Tooltip className="tt-block" title={t('stats.tokens')} text={t('tip.ctx.tokensSection')} meta={meta(t, 'server', 'high')}>
            <div className="stats-section-title">{t('stats.tokens')}</div>
          </Tooltip>
          <Row k={t('stats.tokens.input')} v={fmtInt(stats.inputTokens, locale)} tip={t('tip.ctx.input')} tipMeta={meta(t, 'server', 'high')} />
          <Row k={t('stats.tokens.output')} v={fmtInt(stats.outputTokens, locale)} tip={t('tip.ctx.output')} tipMeta={meta(t, 'server', 'high')} />
        </div>
        <div>
          <Tooltip className="tt-block" title={t('stats.cache')} text={t('tip.ctx.cacheSection')} meta={meta(t, 'server', 'high')}>
            <div className="stats-section-title">{t('stats.cache')}</div>
          </Tooltip>
          <Row k={t('stats.cache.hitRate')} v={fmtPct(stats.cacheHitRate)} tip={t('tip.ctx.hit')} tipMeta={meta(t, 'computed', 'high')} />
          <Row k={t('stats.cache.read')} v={fmtCompact(stats.cacheReadTokens)} tip={t('tip.ctx.cacheRead')} tipMeta={meta(t, 'server', 'high')} />
          <Row k={t('stats.cache.write')} v={fmtCompact(stats.cacheCreateTokens)} tip={t('tip.ctx.cacheWrite')} tipMeta={meta(t, 'server', 'high')} />
          {stats.cacheSavingsUsd != null && stats.cacheSavingsUsd > 0 && (
            <Row
              k={t('stats.cache.savings')}
              v={fmtUsdShort(stats.cacheSavingsUsd)}
              tip={t('tip.ctx.savings')}
              tipMeta={meta(t, 'estimate', 'medium')}
            />
          )}
        </div>
      </div>

      {/* Custo da sessão com badge estimado/real */}
      <div className="ctx-info-grid">
        <div>
          <div className="stats-section-title">{t('stats.cost')}</div>
          <div className="stat-row">
            <span className="stat-k">{t('stats.cost.session')}</span>
            <span className="stat-v">
              {fmtUsdShort(stats.sessionCostUsd)}
              {stats.costIsEstimate && (
                <span className="stat-badge est" title={t('tip.ctx.costEstimate')}>
                  ~
                </span>
              )}
            </span>
          </div>
          {stats.lastTurnCostUsd > 0 && (
            <Row k={t('stats.cost.lastTurn')} v={fmtUsdShort(stats.lastTurnCostUsd)} />
          )}
        </div>
      </div>

      {/* Atividade da sessão: contadores persistentes (turnos, pico, compactações,
          resets de cache). Só aparece quando há ao menos um turno consolidado. */}
      {(stats.turnCount ?? 0) > 0 && (
        <div className="ctx-info-grid">
          <div>
            <Tooltip className="tt-block" title={t('stats.activity')} text={t('tip.ctx.activity')} meta={meta(t, 'computed', 'medium')}>
              <div className="stats-section-title">{t('stats.activity')}</div>
            </Tooltip>
            <Row k={t('stats.activity.turns')} v={fmtInt(stats.turnCount ?? 0, locale)} />
            {stats.peakContextUsed != null && stats.peakContextUsed > 0 && (
              <Row
                k={t('stats.activity.peak')}
                v={`${fmtCompact(stats.peakContextUsed)} (${fmtPct(Math.min(1, stats.peakContextUsed / (stats.contextLimit || 1)))})`}
                tip={t('tip.ctx.peak')}
                tipMeta={meta(t, 'computed', 'high')}
              />
            )}
            {(stats.compactionCount ?? 0) > 0 && (
              <Row
                k={t('stats.activity.compactions')}
                v={fmtInt(stats.compactionCount ?? 0, locale)}
                tip={t('tip.ctx.compactions')}
                tipMeta={meta(t, 'computed', 'medium')}
              />
            )}
            {(stats.cacheResetCount ?? 0) > 0 && (
              <Row
                k={t('stats.activity.resets')}
                v={
                  stats.cacheRecacheCostUsd != null && stats.cacheRecacheCostUsd > 0
                    ? `${stats.cacheResetCount} · ${fmtUsdShort(stats.cacheRecacheCostUsd)}`
                    : String(stats.cacheResetCount ?? 0)
                }
                tip={t('tip.ctx.resets')}
                tipMeta={meta(t, 'computed', 'medium')}
              />
            )}
          </div>
        </div>
      )}

      {/* Aceitação de ferramentas (só exibe se houve decisões) */}
      {toolRows.length > 0 && (
        <div className="ctx-tool-acceptance">
          <Tooltip className="tt-block" title={t('stats.tools.acceptance')} text={t('tip.ctx.toolAcceptance')} meta={meta(t, 'local', 'high')}>
            <div className="stats-section-title">{t('stats.tools.acceptance')}</div>
          </Tooltip>
          {toolRows.map((d) => {
            const total = d.allow + d.allowAlways + d.deny;
            const acceptPct = total > 0 ? Math.round(((d.allow + d.allowAlways) / total) * 100) : 0;
            return (
              <div key={d.tool} className="stat-row">
                <span className="stat-k stat-tool-name">{d.tool}</span>
                <span className="stat-v">
                  <span className={`stat-accept-pct ${acceptPct >= 80 ? 'ok' : acceptPct >= 50 ? 'warn' : 'crit'}`}>
                    {acceptPct}%
                  </span>
                  <span className="muted"> ({total})</span>
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Log de negações de permissão (E5) — auditoria das últimas recusas. */}
      {stats.recentDenials && stats.recentDenials.length > 0 && (
        <div className="ctx-denials">
          <Tooltip className="tt-block" title={t('stats.denials')} text={t('tip.ctx.denials')} meta={meta(t, 'local', 'high')}>
            <div className="stats-section-title">{t('stats.denials')}</div>
          </Tooltip>
          {stats.recentDenials.slice(0, 8).map((d, i) => (
            <div key={`${d.ts}-${i}`} className="stat-row stat-denial">
              <span className="stat-k stat-tool-name" title={d.reason || undefined}>
                <span className="stat-denial-x">✕</span> {d.tool}
                {d.reason && <span className="muted stat-denial-reason"> · {d.reason}</span>}
              </span>
              <span className="stat-v muted">{fmtClock(d.ts)}</span>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

function Row({ k, v, tip, tipMeta }: { k: string; v: string; tip?: string; tipMeta?: TooltipMeta }) {
  const row = (
    <div className="stat-row">
      <span className="stat-k">{k}</span>
      <span className="stat-v">{v}</span>
    </div>
  );
  return tip ? (
    <Tooltip className="tt-block" title={k} text={tip} meta={tipMeta}>
      {row}
    </Tooltip>
  ) : (
    row
  );
}

function sessionRows(s: SessionInfo, t: Translator): TooltipRow[] {
  const rows: TooltipRow[] = [];
  if (s.createdAt) rows.push({ label: t('tip.sess.created'), value: fmtDate(s.createdAt) });
  rows.push({ label: t('tip.sess.updated'), value: fmtDate(s.updatedAt) });
  rows.push({ label: t('tip.sess.messages'), value: String(s.messageCount) });
  if (s.userCount != null) rows.push({ label: t('tip.sess.user'), value: String(s.userCount) });
  if (s.assistantCount != null) {
    rows.push({ label: t('tip.sess.assistant'), value: String(s.assistantCount) });
  }
  if (s.toolCount != null) rows.push({ label: t('tip.sess.tools'), value: String(s.toolCount) });
  if (s.model) rows.push({ label: t('tip.sess.model'), value: prettyChip(s.model), accent: true });
  if (s.sizeBytes != null) rows.push({ label: t('tip.sess.size'), value: fmtBytes(s.sizeBytes) });
  rows.push({ label: t('tip.id'), value: s.id.slice(0, 12) });
  return rows;
}

function semver(s?: string): string | undefined {
  if (!s) return undefined;
  const m = s.match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m[0] : undefined;
}

// Lista de releases do Claude CLI no GitHub.
const CLI_RELEASES_URL = 'https://github.com/anthropics/claude-code/releases';

// Versão mínima do CLI para o Cockpit funcionar direito: a 2.1.162 corrigiu o
// Esc (interromper) sendo descartado no início do turno em sessões stream-json,
// que é exatamente o canal que usamos. Abaixo disso, o botão Stop pode não pegar.
const MIN_CLI_VERSION = '2.1.162';

/** a < b (semver de 3 partes). false quando alguma versão não é reconhecida. */
function semverLt(a?: string, b?: string): boolean {
  const x = semver(a);
  const y = semver(b);
  if (!x || !y) return false;
  const pa = x.split('.').map(Number);
  const pb = y.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true;
    if (pa[i] > pb[i]) return false;
  }
  return false;
}

function cliOutdated(installed?: string, latest?: string): boolean {
  return semverLt(installed, latest);
}

/** CLI velho a ponto de quebrar o Stop — aviso mais forte que "desatualizado". */
function cliBelowMin(installed?: string): boolean {
  return semverLt(installed, MIN_CLI_VERSION);
}

function prettyChip(id: string): string {
  const oneM = /\[1m\]/i.test(id);
  const core = id.replace(/^claude-/i, '').replace(/\[1m\]/i, '');
  const m = core.match(/^(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?$/i);
  let s = core;
  if (m) s = `${m[1]} ${m[3] ? `${m[2]}.${m[3]}` : m[2]}`;
  return oneM ? `${s} 1M` : s;
}

// Data/hora no formato da REGIÃO do PC (injetado pelo host via Node Intl),
// independente do idioma da UI. Fallback: locale do webview.
// Checklist de onboarding (dispensável, persiste no estado do webview). Os passos
// de CLI e login se marcam sozinhos pelo estado; abrir contexto e ditado são dicas.
function Onboarding({
  t,
  cliMissing,
  loggedIn,
  hasSessions,
}: {
  t: Translator;
  cliMissing: boolean;
  loggedIn: boolean;
  hasSessions: boolean;
}) {
  const [dismissed, setDismissed] = useState(
    () => readState<{ onboardingDone?: boolean }>()?.onboardingDone === true,
  );
  if (dismissed) return null;
  const steps: { done: boolean; label: string }[] = [
    { done: !cliMissing, label: t('onboarding.cli') },
    { done: loggedIn, label: t('onboarding.signin') },
    { done: hasSessions, label: t('onboarding.session') },
    { done: false, label: t('onboarding.voice') },
  ];
  const dismiss = () => {
    saveState({ onboardingDone: true });
    setDismissed(true);
  };
  return (
    <div className="onboarding">
      <div className="onboarding-head">
        <span className="onboarding-title">🎓 {t('onboarding.title')}</span>
        <button type="button" className="onboarding-x" title={t('onboarding.dismiss')} onClick={dismiss}>
          ✕
        </button>
      </div>
      <ul className="onboarding-list">
        {steps.map((s) => (
          <li key={s.label} className={s.done ? 'done' : ''}>
            <span className="onboarding-check">{s.done ? '✓' : '○'}</span>
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

// Agrupa as sessões por faixa de tempo (updatedAt) p/ a grade do hub. A lista já
// vem ordenada por mais recente; preserva essa ordem dentro de cada faixa.
function groupSessions(sessions: SessionInfo[]): { key: string; items: SessionInfo[] }[] {
  const now = new Date();
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const dayMs = 86_400_000;
  const buckets: Record<string, SessionInfo[]> = { today: [], yesterday: [], week: [], older: [] };
  for (const s of sessions) {
    const ts = Date.parse(s.updatedAt) || 0;
    if (ts >= startToday) buckets.today.push(s);
    else if (ts >= startToday - dayMs) buckets.yesterday.push(s);
    else if (ts >= startToday - 7 * dayMs) buckets.week.push(s);
    else buckets.older.push(s);
  }
  return [
    { key: 'sessions.today', items: buckets.today },
    { key: 'sessions.yesterday', items: buckets.yesterday },
    { key: 'sessions.week', items: buckets.week },
    { key: 'sessions.older', items: buckets.older },
  ].filter((g) => g.items.length > 0);
}

function fmtDate(iso: string): string {
  const region = window.__TOOTEGA_REGION__ || navigator.language || undefined;
  try {
    return new Intl.DateTimeFormat(region, { dateStyle: 'short', timeStyle: 'short' }).format(
      new Date(iso),
    );
  } catch {
    return iso;
  }
}
