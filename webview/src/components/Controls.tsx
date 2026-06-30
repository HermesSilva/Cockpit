import { useState } from 'react';
import type { Translator } from '../i18n';
import type { SessionConfig } from '../../../shared/protocol';
import { Tooltip } from './Tooltip';

const CUSTOM = '__custom__';

interface Props {
  t: Translator;
  config?: SessionConfig;
  activeModel?: string; // modelo que o CLI está rodando (do evento init)
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
  onPermission: (mode: string) => void;
  onAllowAgents: (value: boolean) => void;
  onDaseEnabled: (value: boolean) => void;
}

export function Controls({ t, config, activeModel, onModel, onEffort, onPermission, onAllowAgents, onDaseEnabled }: Props) {
  const [customMode, setCustomMode] = useState(false);
  const [customText, setCustomText] = useState('');

  if (!config) return null;

  const known = config.models.includes(config.model);
  const selectValue = customMode ? CUSTOM : config.model;

  const onModelSelect = (v: string) => {
    if (v === CUSTOM) {
      setCustomMode(true);
      setCustomText('');
    } else {
      setCustomMode(false);
      onModel(v);
    }
  };

  const applyCustom = () => {
    const v = customText.trim();
    if (v) {
      onModel(v);
      setCustomMode(false);
    }
  };

  return (
    <div className="controls">
      <Tooltip className="tt-block" title={t('controls.model')} text={t('tip.ctrl.model')}>
        <label className="ctrl">
          <span className="ctrl-label">{t('controls.model')}</span>
          <select
            className="ctrl-select"
            value={selectValue}
            onChange={(e) => onModelSelect(e.target.value)}
          >
            {!known && config.model && config.model !== CUSTOM && (
              <option value={config.model}>{config.model}</option>
            )}
            {config.models.map((m) => (
              <option key={m} value={m}>
                {modelLabel(m, t, config.defaultModel ?? activeModel)}
              </option>
            ))}
            <option value={CUSTOM}>{t('controls.model')} …</option>
          </select>
        </label>
      </Tooltip>

      <Tooltip className="tt-block" title={t('controls.effort')} text={t('tip.ctrl.effort')}>
        <label className="ctrl">
          <span className="ctrl-label">{t('controls.effort')}</span>
          <select
            className="ctrl-select"
            value={config.effort}
            onChange={(e) => onEffort(e.target.value)}
          >
            {config.efforts.map((ef) => (
              <option key={ef} value={ef}>
                {effortLabel(ef, t, config.defaultEffort)}
              </option>
            ))}
          </select>
        </label>
      </Tooltip>

      <Tooltip className="tt-block" title={t('controls.permission')} text={t('tip.ctrl.permission')}>
        <label className="ctrl">
          <span className="ctrl-label">{t('controls.permission')}</span>
          <select
            className="ctrl-select"
            value={config.permissionMode}
            onChange={(e) => onPermission(e.target.value)}
          >
            {config.permissionModes.map((pm) => (
              <option key={pm} value={pm}>
                {permLabel(pm, t)}
              </option>
            ))}
          </select>
        </label>
      </Tooltip>

      <Tooltip className="tt-block" title={t('controls.agents')} text={t('tip.ctrl.agents')}>
        <label className="ctrl ctrl-check">
          <input
            type="checkbox"
            checked={config.allowAgents}
            onChange={(e) => onAllowAgents(e.target.checked)}
          />
          <span className="ctrl-label">{t('controls.agents')}</span>
        </label>
      </Tooltip>

      {config.daseAvailable && (
        <Tooltip className="tt-block" title={t('controls.dase')} text={t('tip.ctrl.dase')}>
          <label className="ctrl ctrl-check">
            <input
              type="checkbox"
              checked={config.daseEnabled}
              onChange={(e) => onDaseEnabled(e.target.checked)}
            />
            <span className="ctrl-label">{t('controls.dase')}</span>
          </label>
        </Tooltip>
      )}

      {customMode && (
        <div className="ctrl-custom">
          <input
            className="ctrl-input"
            placeholder="claude-…"
            value={customText}
            autoFocus
            onChange={(e) => setCustomText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') applyCustom();
              if (e.key === 'Escape') setCustomMode(false);
            }}
          />
          <button
            type="button"
            className="btn send"
            onClick={applyCustom}
            disabled={!customText.trim()}
          >
            ✓
          </button>
        </div>
      )}

      {config.pendingRestart && (
        <div className="ctrl-note pending">{t('controls.applies')}</div>
      )}
    </div>
  );
}

function modelLabel(m: string, t: Translator, defaultForParen?: string): string {
  if (m === 'default') {
    return defaultForParen
      ? `${t('model.default')} (${prettyModel(defaultForParen)})`
      : t('model.default');
  }
  // alias puro (opus/sonnet/haiku/...) -> capitaliza ("Opus")
  if (/^(opus|sonnet|haiku|fable|mythos)$/i.test(m)) {
    return m[0].toUpperCase() + m.slice(1).toLowerCase();
  }
  return prettyModel(m);
}

/** Título elegante: claude-opus-4-8 -> "Claude Opus 4.8"; …[1m] -> "… 1M". */
function prettyModel(id: string): string {
  const oneM = /\[1m\]/i.test(id);
  const core = id.replace(/^claude-/i, '').replace(/\[1m\]/i, '');
  const m = core.match(/^(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?$/i);
  let s: string;
  if (m) {
    const fam = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
    const ver = m[3] ? `${m[2]}.${m[3]}` : m[2];
    s = `Claude ${fam} ${ver}`;
  } else {
    s = id; // desconhecido: mostra o id cru
  }
  return oneM ? `${s} 1M` : s;
}

function permLabel(pm: string, t: Translator): string {
  const key = `perm.${pm}` as Parameters<Translator>[0];
  const v = t(key);
  return v === key ? pm : v;
}

function effortLabel(ef: string, t: Translator, defaultEffort?: string): string {
  const key = `effort.${ef}` as Parameters<Translator>[0];
  const label = t(key);
  const base = label === key ? ef : label;
  if (ef === 'default' && defaultEffort) return `${base} (${defaultEffort})`;
  return base;
}
