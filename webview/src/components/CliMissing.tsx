import type { Translator } from '../i18n';

const DOCS_URL = 'https://docs.claude.com/en/docs/claude-code/overview';

interface Props {
  t: Translator;
  mode: 'missing' | 'login';
  error?: string;
  onInstall: () => void;
  onLogin: () => void;
  onRecheck: () => void;
  onDocs: (href: string) => void;
}

// Prerequisite banner: CLI missing (install) or not authenticated (login).
export function CliMissing({ t, mode, error, onInstall, onLogin, onRecheck, onDocs }: Props) {
  const login = mode === 'login';
  return (
    <div className="cli-missing">
      <div className="cli-missing-head">
        <span className="cli-missing-icon">{login ? '🔑' : '⚠'}</span>
        <span className="cli-missing-title">
          {login ? t('cli.auth.title') : t('cli.missing.title')}
        </span>
      </div>
      <div className="cli-missing-desc">{login ? t('cli.auth.desc') : t('cli.missing.desc')}</div>
      {error && <pre className="cli-missing-err">{error}</pre>}
      <div className="cli-missing-actions">
        {login ? (
          <button type="button" className="btn send" onClick={onLogin}>
            {t('cli.login')}
          </button>
        ) : (
          <button type="button" className="btn send" onClick={onInstall}>
            {t('cli.install')}
          </button>
        )}
        <button type="button" className="btn" onClick={onRecheck}>
          {t('cli.recheck')}
        </button>
        <button type="button" className="btn" onClick={() => onDocs(DOCS_URL)}>
          {t('cli.docs')}
        </button>
      </div>
    </div>
  );
}
