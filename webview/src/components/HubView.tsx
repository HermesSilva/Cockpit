import { useState, useRef, useEffect } from 'react';
import type { Translator } from '../i18n';
import type { StatsSnapshot, SessionConfig, SessionInfo } from '../../../shared/protocol';
import { fmtInt, fmtPct, fmtCompact, fmtBytes } from '../util/format';
import type { TooltipRow } from './Tooltip';
import { Controls } from './Controls';
import { Tooltip } from './Tooltip';

interface Props {
  t: Translator;
  locale: string;
  cliMissing: boolean;
  cockpitVersion?: string;
  cliVersion?: string;
  cliLatest?: string;
  stats?: StatsSnapshot;
  config?: SessionConfig;
  activeModel?: string;
  loggedIn: boolean;
  sessions: SessionInfo[];
  cwd?: string;
  activeSessionId?: string;
  onNewSession: () => void;
  onOpenFolder: (path: string) => void;
  onSettings: () => void;
  onUsage: () => void;
  onPlugins: () => void;
  onLogin: () => void;
  onLogout: () => void;
  onUpdate: () => void;
  onInstall: () => void;
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
  onPermission: (mode: string) => void;
  onResume: (id: string) => void;
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
  config,
  activeModel,
  loggedIn,
  sessions,
  cwd,
  activeSessionId,
  onNewSession,
  onOpenFolder,
  onSettings,
  onUsage,
  onPlugins,
  onLogin,
  onLogout,
  onUpdate,
  onInstall,
  onModel,
  onEffort,
  onPermission,
  onResume,
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
                cliOutdated(cliVersion, cliLatest)
                  ? t('about.cliOutdated', semver(cliLatest) ?? cliLatest ?? '')
                  : t('about.cliUpToDate')
              }
            >
              <span className={`hub-cli ${cliOutdated(cliVersion, cliLatest) ? 'outdated' : ''}`}>
                Claude CLI {semver(cliVersion) ?? cliVersion}
              </span>
            </Tooltip>
            {cliOutdated(cliVersion, cliLatest) && (
              <Tooltip text={t('about.cliOutdated', semver(cliLatest) ?? cliLatest ?? '')}>
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

      <div className="ctx-panel-body">
        {/* Painel de informações do contexto ativo */}
        <section className="ctx-panel-info">
          {cliMissing ? (
            <div className="muted">{t('status.cliMissing')}</div>
          ) : stats ? (
            <ContextInfo t={t} locale={locale} stats={stats} />
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
            <div className="ctx-grid">
              {sessions.map((s) => (
                <SessionCard
                  key={s.id}
                  s={s}
                  t={t}
                  active={s.id === activeSessionId}
                  onResume={onResume}
                  onDelete={onDelete}
                  onRename={onRename}
                />
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
  onResume,
  onDelete,
  onRename,
}: {
  s: SessionInfo;
  t: Translator;
  active: boolean;
  onResume: (id: string) => void;
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
        className={`ctx-card ${active ? 'active' : ''}`}
        onClick={() => onResume(s.id)}
      >
        <span className="ctx-card-title">{s.title || t('session.untitled')}</span>
        <span className="ctx-card-meta">
          {fmtDate(s.updatedAt)} · {s.messageCount} {t('sessions.messages')}
        </span>
        <span className="ctx-card-actions">
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

function ContextInfo({ t, locale, stats }: { t: Translator; locale: string; stats: StatsSnapshot }) {
  const used = stats.contextUsed;
  const limit = stats.contextLimit || 1;
  const pct = Math.min(1, used / limit);
  const band = pct < 0.6 ? 'ok' : pct < 0.85 ? 'warn' : 'crit';

  return (
    <>
      <Tooltip className="tt-block" title={t('stats.context')} text={t('tip.ctx.context')}>
        <div className="ctx-info-head">
          <span className="col-title">{t('stats.context')}</span>
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

      <div className="ctx-info-grid">
        <div>
          <Tooltip className="tt-block" title={t('stats.tokens')} text={t('tip.ctx.tokensSection')}>
            <div className="stats-section-title">{t('stats.tokens')}</div>
          </Tooltip>
          <Row k={t('stats.tokens.input')} v={fmtInt(stats.inputTokens, locale)} tip={t('tip.ctx.input')} />
          <Row k={t('stats.tokens.output')} v={fmtInt(stats.outputTokens, locale)} tip={t('tip.ctx.output')} />
        </div>
        <div>
          <Tooltip className="tt-block" title={t('stats.cache')} text={t('tip.ctx.cacheSection')}>
            <div className="stats-section-title">{t('stats.cache')}</div>
          </Tooltip>
          <Row k={t('stats.cache.hitRate')} v={fmtPct(stats.cacheHitRate)} tip={t('tip.ctx.hit')} />
          <Row k={t('stats.cache.read')} v={fmtCompact(stats.cacheReadTokens)} tip={t('tip.ctx.cacheRead')} />
          <Row k={t('stats.cache.write')} v={fmtCompact(stats.cacheCreateTokens)} tip={t('tip.ctx.cacheWrite')} />
        </div>
      </div>
    </>
  );
}

function Row({ k, v, tip }: { k: string; v: string; tip?: string }) {
  const row = (
    <div className="stat-row">
      <span className="stat-k">{k}</span>
      <span className="stat-v">{v}</span>
    </div>
  );
  return tip ? (
    <Tooltip className="tt-block" title={k} text={tip}>
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

function cliOutdated(installed?: string, latest?: string): boolean {
  const a = semver(installed);
  const b = semver(latest);
  if (!a || !b) return false;
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] < pb[i]) return true;
    if (pa[i] > pb[i]) return false;
  }
  return false;
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
