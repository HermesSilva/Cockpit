import { useState, useRef, useEffect } from 'react';
import type { Translator } from '../i18n';
import type { SessionConfig, ModelMeta } from '../../../shared/protocol';
import { Tooltip } from './Tooltip';

const CUSTOM = '__custom__';

interface Props {
  t: Translator;
  config?: SessionConfig;
  activeModel?: string; // the model the CLI is running (from the init event)
  onModel: (model: string) => void;
  onEffort: (effort: string) => void;
  onPermission: (mode: string) => void;
  onAllowAgents: (value: boolean) => void;
}

export function Controls({ t, config, activeModel, onModel, onEffort, onPermission, onAllowAgents }: Props) {
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
          <ModelSelect
            t={t}
            value={selectValue}
            models={config.models}
            meta={config.modelMeta}
            known={known}
            currentModel={config.model}
            defaultFor={config.defaultModel ?? activeModel}
            onSelect={onModelSelect}
          />
        </label>
      </Tooltip>

      <Tooltip className="tt-block" title={t('controls.effort')} text={t('tip.ctrl.effort')}>
        <label className="ctrl">
          <span className="ctrl-label">{t('controls.effort')}</span>
          <EffortSelect
            t={t}
            value={config.effort}
            efforts={config.efforts}
            defaultEffort={config.defaultEffort}
            onSelect={onEffort}
          />
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

interface ModelSelectProps {
  t: Translator;
  value: string; // selecionado ('__custom__' quando em modo custom)
  models: string[];
  meta?: Record<string, ModelMeta>;
  known: boolean; // is config.model in the list?
  currentModel: string;
  defaultFor?: string; // o que 'default' resolve (p/ rótulo)
  onSelect: (v: string) => void;
}

/** Model selector with 3 columns (model · context · price). It is a custom dropdown
 *  because a native <option> can't render columns. Context/price come from `meta`. */
function ModelSelect({
  t,
  value,
  models,
  meta,
  known,
  currentModel,
  defaultFor,
  onSelect,
}: ModelSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Modelo custom aplicado (fora da lista) aparece no topo.
  const rows: string[] = [];
  if (!known && currentModel && currentModel !== CUSTOM) rows.push(currentModel);
  rows.push(...models);

  const currentLabel =
    value === CUSTOM ? `${t('controls.model')} …` : modelLabel(value, t, defaultFor);

  const pick = (v: string) => {
    setOpen(false);
    onSelect(v);
  };

  return (
    <div className="ctrl-modelsel" ref={ref}>
      <button
        type="button"
        className="ctrl-select ctrl-modelsel-btn"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ctrl-modelsel-cur">{currentLabel}</span>
        <span className="ctrl-modelsel-arrow">▾</span>
      </button>
      {open && (
        <div className="ctrl-modelsel-pop" role="listbox">
          <div className="ctrl-modelsel-head">
            <span>{t('controls.model')}</span>
            <span>{t('controls.context')}</span>
            <span>{t('controls.price')}</span>
          </div>
          {rows.map((m) => {
            const md = meta?.[m];
            return (
              <button
                key={m}
                type="button"
                role="option"
                aria-selected={m === value}
                className={`ctrl-modelsel-row${m === value ? ' sel' : ''}`}
                onClick={() => pick(m)}
              >
                <span className="c-model">{modelLabel(m, t, defaultFor)}</span>
                <span className="c-ctx">
                  {md?.contextTokens ? formatContext(md.contextTokens) : '—'}
                </span>
                <span className="c-price" title={priceTitle(md)}>
                  {md?.priceMult != null ? formatMult(md.priceMult) : '—'}
                </span>
              </button>
            );
          })}
          <button
            type="button"
            role="option"
            className="ctrl-modelsel-row custom"
            onClick={() => pick(CUSTOM)}
          >
            <span className="c-model">{t('controls.model')} …</span>
            <span className="c-ctx" />
            <span className="c-price" />
          </button>
        </div>
      )}
    </div>
  );
}

/** 200000 -> "200K"; 1000000 -> "1M". */
function formatContext(tokens: number): string {
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`.replace('.0M', 'M');
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`;
  return String(tokens);
}

/** 1 -> "1x"; 0.6 -> "0.6x"; 2 -> "2x". */
function formatMult(mult: number): string {
  return `${mult}x`;
}

/** Tooltip with the real price in USD/1M ("$5/M in · $25/M out"). */
function priceTitle(md?: ModelMeta): string {
  if (!md || md.inMTok == null) return '';
  const out = md.outMTok != null ? ` · $${md.outMTok}/M out` : '';
  return `$${md.inMTok}/M in${out}`;
}

// Estimated relative token consumption per effort level. It is NOT an official
// factor (Anthropic publishes no per-effort multiplier) — only an order of
// grandeza p/ orientar a escolha. Ancorado em high = 1x (default da API).
// Recalibrate here if you want other values.
const EFFORT_MULT: Record<string, number> = {
  low: 0.3,
  medium: 0.6,
  high: 1,
  xhigh: 1.6,
  max: 2.5,
};

interface EffortSelectProps {
  t: Translator;
  value: string;
  efforts: string[];
  defaultEffort?: string;
  onSelect: (v: string) => void;
}

/** Effort selector with an estimated per-level token consumption multiplier. */
function EffortSelect({ t, value, efforts, defaultEffort, onSelect }: EffortSelectProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const pick = (v: string) => {
    setOpen(false);
    onSelect(v);
  };

  // 'default' resolves to the default effort — uses its multiplier.
  const multFor = (ef: string): number | undefined =>
    EFFORT_MULT[ef === 'default' ? (defaultEffort ?? '') : ef];

  return (
    <div className="ctrl-modelsel ctrl-effortsel" ref={ref}>
      <button
        type="button"
        className="ctrl-select ctrl-modelsel-btn"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="ctrl-modelsel-cur">{effortLabel(value, t, defaultEffort)}</span>
        <span className="ctrl-modelsel-arrow">▾</span>
      </button>
      {open && (
        <div className="ctrl-modelsel-pop" role="listbox">
          <div className="ctrl-modelsel-head">
            <span>{t('controls.effort')}</span>
            <span title={t('tip.effort.est')}>{t('controls.usage')}</span>
          </div>
          {efforts.map((ef) => {
            const mult = multFor(ef);
            return (
              <button
                key={ef}
                type="button"
                role="option"
                aria-selected={ef === value}
                className={`ctrl-modelsel-row${ef === value ? ' sel' : ''}`}
                onClick={() => pick(ef)}
              >
                <span className="c-model">{effortLabel(ef, t, defaultEffort)}</span>
                <span className="c-price" title={t('tip.effort.est')}>
                  {mult != null ? `~${mult}x` : '—'}
                </span>
              </button>
            );
          })}
        </div>
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

/** Elegant title: claude-opus-4-8 -> "Claude Opus 4.8"; …[1m] -> "… 1M". */
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
