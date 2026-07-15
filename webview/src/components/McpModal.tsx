import { useEffect, useState } from 'react';
import type { Translator } from '../i18n';
import type { McpData, McpServerInfo } from '../../../shared/protocol';
import { Portal } from './Portal';

interface Props {
  t: Translator;
  data: McpData | null; // null = ainda carregando
  busy: boolean;
  onRefresh: () => void;
  onClose: () => void;
}

// Painel "MCP servers" (X4): estado de cada servidor + as tools que ele expõe
// nesta sessão. Servidor `pending` é o caso que pede ação: um `.mcp.json` do repo
// que o CLI se recusa a subir enquanto o workspace não for aprovado.
export function McpModal({ t, data, busy, onRefresh, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const servers = data?.servers ?? [];
  const toolCount = servers.reduce((a, s) => a + s.tools.length, 0);

  return (
    <Portal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal usage" onClick={(e) => e.stopPropagation()}>
          <div className="usage-head">
            <span className="modal-title">{t('mcp.title')}</span>
            <button
              type="button"
              className="ctx-link mcp-refresh"
              onClick={onRefresh}
              disabled={busy}
            >
              ⟳ {t('plugins.refresh')}
            </button>
            <button type="button" className="usage-close" title={t('common.close')} onClick={onClose}>
              ✕
            </button>
          </div>

          {busy && !data ? (
            <div className="usage-loading">
              <span className="usage-spinner" aria-hidden="true" />
              <span>{t('mcp.checking')}</span>
            </div>
          ) : servers.length === 0 ? (
            <div className="usage-body">
              <div className="usage-muted">{t('mcp.none')}</div>
            </div>
          ) : (
            <div className="usage-body">
              <div className="usage-section-label">
                {t('mcp.servers')}
                <span className="usage-badge live">
                  {t('mcp.count', String(servers.length), String(toolCount))}
                </span>
              </div>
              {servers.map((s) => (
                <ServerCard key={s.name} t={t} s={s} />
              ))}
              {data && (
                <div className="usage-stamp">
                  {t('mcp.stamp', new Date(data.generatedAt).toLocaleTimeString())}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}

function ServerCard({ t, s }: { t: Translator; s: McpServerInfo }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`mcp-card ${s.status}`}>
      <div className="mcp-card-head">
        <span className={`mcp-dot ${s.status}`} aria-hidden="true" />
        <span className="mcp-name" title={s.target || undefined}>
          {s.name}
        </span>
        {s.transport && <span className="mcp-transport">{s.transport}</span>}
        <span className={`mcp-status ${s.status}`}>{t(`mcp.status.${s.status}`)}</span>
      </div>
      {/* Remoto sem URL: a CLI 2.1.208 rotula "not configured" — espelhamos. */}
      {s.notConfigured ? (
        <div className="mcp-target mcp-unconfigured">{t('mcp.notConfigured')}</div>
      ) : (
        s.target && <div className="mcp-target">{s.target}</div>
      )}
      {/* Servidor pendente não é falha: o CLI está esperando você aprovar o workspace. */}
      {s.status === 'pending' && <div className="usage-alert">{t('mcp.pendingHelp')}</div>}
      {s.tools.length > 0 ? (
        <>
          <button type="button" className="mcp-tools-toggle" onClick={() => setOpen(!open)}>
            {open ? '▾' : '▸'} {t('mcp.tools', String(s.tools.length))}
          </button>
          {open && (
            <div className="mcp-tools">
              {s.tools.map((tool) => (
                <span key={tool} className="mcp-tool">
                  {tool}
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        s.connected && <div className="usage-muted mcp-notools">{t('mcp.noTools')}</div>
      )}
    </div>
  );
}
