import { useEffect, useState } from 'react';
import type { Translator } from '../i18n';
import type { VoiceDictData, VoiceReplacement } from '../../../shared/protocol';
import { Portal } from './Portal';

interface Props {
  t: Translator;
  data: VoiceDictData | null; // null = ainda carregando
  onSave: (data: VoiceDictData) => void;
  onClose: () => void;
}

// Modal do dicionário de ditado (por login): termos a reconhecer/preservar e
// substituições "ouvido → escrito". Edita um rascunho local; salva no host.
export function VoiceDictModal({ t, data, onSave, onClose }: Props) {
  const [terms, setTerms] = useState<string[]>([]);
  const [reps, setReps] = useState<VoiceReplacement[]>([]);
  const [newTerm, setNewTerm] = useState('');
  const [repFrom, setRepFrom] = useState('');
  const [repTo, setRepTo] = useState('');

  // Sincroniza com o que o host mandou (1ª carga / após salvar).
  useEffect(() => {
    if (data) {
      setTerms(data.terms ?? []);
      setReps(data.replacements ?? []);
    }
  }, [data]);

  const addTerm = () => {
    const v = newTerm.trim();
    if (!v || terms.some((x) => x.toLowerCase() === v.toLowerCase())) {
      setNewTerm('');
      return;
    }
    setTerms((p) => [...p, v]);
    setNewTerm('');
  };
  const addRep = () => {
    const from = repFrom.trim();
    const to = repTo.trim();
    if (!from) return;
    setReps((p) => [...p.filter((r) => r.from.toLowerCase() !== from.toLowerCase()), { from, to }]);
    setRepFrom('');
    setRepTo('');
  };

  const save = () => onSave({ terms, replacements: reps });

  return (
    <Portal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal voicedict-modal" onClick={(e) => e.stopPropagation()}>
          <div className="voicedict-head">
            <span className="modal-title">🗣️ {t('voicedict.title')}</span>
            {data?.account && data.account !== 'default' && (
              <span className="voicedict-account" title={t('voicedict.account')}>
                {data.account}
              </span>
            )}
            <button type="button" className="modal-close" title={t('common.close')} onClick={onClose}>
              ✕
            </button>
          </div>

          <p className="voicedict-desc">{t('voicedict.desc')}</p>

          {data == null ? (
            <div className="voicedict-loading">…</div>
          ) : (
            <div className="voicedict-body">
              {/* Termos */}
              <section className="voicedict-sec">
                <div className="voicedict-sec-title">{t('voicedict.terms')}</div>
                <div className="voicedict-hint">{t('voicedict.terms.hint')}</div>
                <div className="voicedict-add">
                  <input
                    className="voicedict-input"
                    value={newTerm}
                    placeholder={t('voicedict.terms.ph')}
                    onChange={(e) => setNewTerm(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTerm())}
                  />
                  <button type="button" className="btn" onClick={addTerm}>
                    {t('voicedict.add')}
                  </button>
                </div>
                <div className="voicedict-chips">
                  {terms.length === 0 && <span className="voicedict-empty">{t('voicedict.empty')}</span>}
                  {terms.map((term) => (
                    <span className="voicedict-chip" key={term}>
                      {term}
                      <button
                        type="button"
                        className="voicedict-chip-x"
                        title={t('voicedict.remove')}
                        onClick={() => setTerms((p) => p.filter((x) => x !== term))}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              </section>

              {/* Substituições */}
              <section className="voicedict-sec">
                <div className="voicedict-sec-title">{t('voicedict.reps')}</div>
                <div className="voicedict-hint">{t('voicedict.reps.hint')}</div>
                <div className="voicedict-add">
                  <input
                    className="voicedict-input"
                    value={repFrom}
                    placeholder={t('voicedict.reps.from')}
                    onChange={(e) => setRepFrom(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addRep())}
                  />
                  <span className="voicedict-arrow">→</span>
                  <input
                    className="voicedict-input"
                    value={repTo}
                    placeholder={t('voicedict.reps.to')}
                    onChange={(e) => setRepTo(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addRep())}
                  />
                  <button type="button" className="btn" onClick={addRep}>
                    {t('voicedict.add')}
                  </button>
                </div>
                <div className="voicedict-reps">
                  {reps.length === 0 && <span className="voicedict-empty">{t('voicedict.empty')}</span>}
                  {reps.map((r) => (
                    <div className="voicedict-rep" key={r.from}>
                      <span className="voicedict-rep-from">{r.from}</span>
                      <span className="voicedict-arrow">→</span>
                      <span className="voicedict-rep-to">{r.to || <em>{t('voicedict.reps.delete')}</em>}</span>
                      <button
                        type="button"
                        className="voicedict-chip-x"
                        title={t('voicedict.remove')}
                        onClick={() => setReps((p) => p.filter((x) => x.from !== r.from))}
                      >
                        ✕
                      </button>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          )}

          <div className="voicedict-foot">
            <button type="button" className="btn" onClick={onClose}>
              {t('confirm.cancel')}
            </button>
            <button type="button" className="btn send" onClick={save} disabled={data == null}>
              {t('voicedict.save')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
