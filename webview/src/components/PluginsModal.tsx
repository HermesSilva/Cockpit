import { useMemo, useState } from 'react';
import type { Translator } from '../i18n';
import type { PluginsData } from '../../../shared/protocol';
import { Portal } from './Portal';

type Filter = 'all' | 'installed' | 'available';
type Action =
  | 'install'
  | 'uninstall'
  | 'enable'
  | 'disable'
  | 'update'
  | 'marketAdd'
  | 'marketRemove';

interface Props {
  t: Translator;
  data: PluginsData | null;
  busy: boolean;
  busyLabel?: string;
  error?: string;
  onAction: (action: Action, arg: string, scope?: string) => void;
  onRefresh: () => void;
  onOpenLink: (url: string) => void;
  onClose: () => void;
}

// Linha unificada (disponível ∪ instalado).
interface Row {
  id: string; // name@marketplace
  name: string;
  description?: string;
  marketplace?: string;
  installCount?: number;
  installed: boolean;
  enabled: boolean;
  url?: string;
  kind?: string;
}

function buildRows(data: PluginsData | null): Row[] {
  if (!data) return [];
  const inst = new Map(data.installed.map((p) => [p.id, p]));
  const seen = new Set<string>();
  const rows: Row[] = [];
  for (const a of data.available) {
    const i = inst.get(a.pluginId);
    seen.add(a.pluginId);
    rows.push({
      id: a.pluginId,
      name: a.name,
      description: a.description || i?.description,
      marketplace: a.marketplaceName,
      installCount: a.installCount,
      installed: !!i,
      enabled: i ? i.enabled : true,
      url: a.url || i?.url,
      kind: i?.kind || a.kind,
    });
  }
  // Instalados que não aparecem nos marketplaces (locais/privados).
  for (const p of data.installed) {
    if (seen.has(p.id)) continue;
    const [name, market] = p.id.split('@');
    rows.push({
      id: p.id,
      name: name || p.id,
      description: p.description,
      marketplace: market,
      installed: true,
      enabled: p.enabled,
      url: p.url,
      kind: p.kind,
    });
  }
  // Instalados primeiro; depois por nº de instalações desc.
  rows.sort((a, b) => {
    if (a.installed !== b.installed) return a.installed ? -1 : 1;
    return (b.installCount ?? 0) - (a.installCount ?? 0);
  });
  return rows;
}

export function PluginsModal({
  t,
  data,
  busy,
  busyLabel,
  error,
  onAction,
  onRefresh,
  onOpenLink,
  onClose,
}: Props) {
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [showMarkets, setShowMarkets] = useState(false);
  const [newMarket, setNewMarket] = useState('');

  const rows = useMemo(() => buildRows(data), [data]);
  const counts = useMemo(
    () => ({
      all: rows.length,
      installed: rows.filter((r) => r.installed).length,
      available: rows.filter((r) => !r.installed).length,
    }),
    [rows],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === 'installed' && !r.installed) return false;
      if (filter === 'available' && r.installed) return false;
      if (!q) return true;
      return (
        r.name.toLowerCase().includes(q) ||
        (r.description ?? '').toLowerCase().includes(q) ||
        (r.marketplace ?? '').toLowerCase().includes(q)
      );
    });
  }, [rows, query, filter]);

  const addMarket = () => {
    const v = newMarket.trim();
    if (v) {
      onAction('marketAdd', v);
      setNewMarket('');
    }
  };

  return (
    <Portal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal plugins-modal" onClick={(e) => e.stopPropagation()}>
          <div className="plugins-head">
            <span className="modal-title">🧩 {t('plugins.title')}</span>
            <button
              type="button"
              className="plugins-refresh"
              title={t('plugins.refresh')}
              onClick={onRefresh}
              disabled={busy}
            >
              ⟳
            </button>
            <button type="button" className="modal-close" title={t('common.close')} onClick={onClose}>
              ✕
            </button>
          </div>

          <div className="plugins-toolbar">
            <input
              className="plugins-search"
              placeholder={t('plugins.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <div className="plugins-filter">
              {(['all', 'installed', 'available'] as Filter[]).map((f) => (
                <button
                  type="button"
                  key={f}
                  className={`plugins-filter-btn ${filter === f ? 'active' : ''}`}
                  onClick={() => setFilter(f)}
                >
                  {t(`plugins.filter.${f}`)} <span className="plugins-count">{counts[f]}</span>
                </button>
              ))}
            </div>
          </div>

          {busy && (
            <div className="plugins-busy">
              <span className="voice-spinner" /> {busyLabel || t('plugins.loading')}
            </div>
          )}
          {error && <div className="plugins-error">⚠ {error}</div>}

          <div className="plugins-list">
            {filtered.length === 0 && !busy ? (
              <div className="plugins-empty">{t('plugins.empty')}</div>
            ) : (
              filtered.map((r) => (
                <div className={`plugin-row ${r.installed ? 'is-installed' : ''}`} key={r.id}>
                  <div className="plugin-main">
                    <div className="plugin-name-line">
                      {r.kind && (
                        <span className={`plugin-kind kind-${r.kind}`}>
                          {t(`plugins.kind.${r.kind}` as Parameters<typeof t>[0])}
                        </span>
                      )}
                      {r.url ? (
                        <a
                          className="plugin-name plugin-name-link"
                          href={r.url}
                          title={r.url}
                          onClick={(e) => {
                            e.preventDefault();
                            onOpenLink(r.url as string);
                          }}
                        >
                          {r.name}
                        </a>
                      ) : (
                        <span className="plugin-name">{r.name}</span>
                      )}
                      {r.marketplace && <span className="plugin-market">{r.marketplace}</span>}
                      {r.installed && (
                        <span className={`plugin-badge ${r.enabled ? 'on' : 'off'}`}>
                          {r.enabled ? t('plugins.enabled') : t('plugins.disabled')}
                        </span>
                      )}
                      {typeof r.installCount === 'number' && (
                        <span className="plugin-installs" title={t('plugins.installs')}>
                          ↓ {r.installCount.toLocaleString()}
                        </span>
                      )}
                    </div>
                    {r.description && <div className="plugin-desc">{r.description}</div>}
                  </div>
                  <div className="plugin-actions">
                    {r.installed ? (
                      <>
                        <button
                          type="button"
                          className="plugin-btn"
                          disabled={busy}
                          onClick={() => onAction(r.enabled ? 'disable' : 'enable', r.id)}
                        >
                          {r.enabled ? t('plugins.disable') : t('plugins.enable')}
                        </button>
                        <button
                          type="button"
                          className="plugin-btn danger"
                          disabled={busy}
                          onClick={() => onAction('uninstall', r.id)}
                        >
                          {t('plugins.uninstall')}
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="plugin-btn primary"
                        disabled={busy}
                        onClick={() => onAction('install', r.id)}
                      >
                        {t('plugins.install')}
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div className="plugins-markets">
            <button
              type="button"
              className="plugins-markets-toggle"
              onClick={() => setShowMarkets((v) => !v)}
            >
              {showMarkets ? '▾' : '▸'} {t('plugins.marketplaces')} ({data?.marketplaces.length ?? 0})
            </button>
            {showMarkets && (
              <div className="plugins-markets-body">
                <div className="plugins-market-add">
                  <input
                    className="plugins-search"
                    placeholder={t('plugins.marketAddPlaceholder')}
                    value={newMarket}
                    onChange={(e) => setNewMarket(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && addMarket()}
                  />
                  <button type="button" className="plugin-btn primary" disabled={busy} onClick={addMarket}>
                    {t('plugins.marketAdd')}
                  </button>
                </div>
                {(data?.marketplaces ?? []).map((m) => (
                  <div className="plugin-market-row" key={m.name}>
                    <span className="plugin-market-name">{m.name}</span>
                    {m.repo && <span className="plugin-market-repo">{m.repo}</span>}
                    <button
                      type="button"
                      className="plugin-btn danger"
                      disabled={busy}
                      onClick={() => onAction('marketRemove', m.name)}
                    >
                      {t('plugins.remove')}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}
