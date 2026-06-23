import { useEffect, useRef, useState } from 'react';
import type { Translator } from '../i18n';
import type { VoiceDictData, VoiceReplacement } from '../../../shared/protocol';
import { Portal } from './Portal';

interface Props {
  t: Translator;
  data: VoiceDictData | null; // null = ainda carregando
  onSave: (data: VoiceDictData) => void;
  onClose: () => void;
}

type Tab = 'terms' | 'reps' | 'spell';

// Modal dos dicionários (por login), em abas: termos do ditado, substituições
// "ouvido → escrito" e o dicionário do corretor. Cada aba é uma LISTA editável
// (altera inline, adiciona linha, remove). Edita um rascunho local; salva no host.
export function VoiceDictModal({ t, data, onSave, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('terms');
  const [terms, setTerms] = useState<string[]>([]);
  const [reps, setReps] = useState<VoiceReplacement[]>([]);
  const [spellWords, setSpellWords] = useState<string[]>([]);
  const lastInput = useRef<HTMLInputElement>(null); // foca a linha recém-adicionada

  useEffect(() => {
    if (data) {
      setTerms(data.terms ?? []);
      setReps(data.replacements ?? []);
      setSpellWords(data.spellWords ?? []);
    }
  }, [data]);

  // --- termos (lista de strings) ---
  const setTermAt = (i: number, v: string) => setTerms((p) => p.map((x, j) => (j === i ? v : x)));
  const removeTerm = (i: number) => setTerms((p) => p.filter((_, j) => j !== i));
  const addTerm = () => {
    setTerms((p) => [...p, '']);
    focusLast();
  };

  // --- substituições (lista de {from,to}) ---
  const setRep = (i: number, k: 'from' | 'to', v: string) =>
    setReps((p) => p.map((x, j) => (j === i ? { ...x, [k]: v } : x)));
  const removeRep = (i: number) => setReps((p) => p.filter((_, j) => j !== i));
  const addRep = () => {
    setReps((p) => [...p, { from: '', to: '' }]);
    focusLast();
  };

  // --- corretor (lista de strings) ---
  const setSpellAt = (i: number, v: string) =>
    setSpellWords((p) => p.map((x, j) => (j === i ? v : x)));
  const removeSpell = (i: number) => setSpellWords((p) => p.filter((_, j) => j !== i));
  const addSpell = () => {
    setSpellWords((p) => [...p, '']);
    focusLast();
  };

  const focusLast = () => requestAnimationFrame(() => lastInput.current?.focus());

  // Limpa vazios/duplicados antes de salvar.
  const save = () => {
    const cleanList = (a: string[]) => {
      const seen = new Set<string>();
      const out: string[] = [];
      for (const w of a.map((x) => x.trim())) {
        const k = w.toLowerCase();
        if (w && !seen.has(k)) {
          seen.add(k);
          out.push(w);
        }
      }
      return out;
    };
    onSave({
      terms: cleanList(terms),
      replacements: reps.map((r) => ({ from: r.from.trim(), to: r.to.trim() })).filter((r) => r.from),
      spellWords: cleanList(spellWords),
    });
  };

  const tabs: { id: Tab; label: string; count: number }[] = [
    { id: 'terms', label: t('voicedict.terms'), count: terms.length },
    { id: 'reps', label: t('voicedict.reps'), count: reps.length },
    { id: 'spell', label: t('voicedict.spell'), count: spellWords.length },
  ];

  return (
    <Portal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal voicedict-modal" onClick={(e) => e.stopPropagation()}>
          <div className="voicedict-head">
            <span className="modal-title">📚 {t('voicedict.title')}</span>
            {data?.account && data.account !== 'default' && (
              <span className="voicedict-account" title={t('voicedict.account')}>
                {data.account}
              </span>
            )}
            <button type="button" className="modal-close" title={t('common.close')} onClick={onClose}>
              ✕
            </button>
          </div>

          {data == null ? (
            <div className="voicedict-loading">…</div>
          ) : (
            <>
              <div className="voicedict-tabs" role="tablist">
                {tabs.map((tb) => (
                  <button
                    type="button"
                    key={tb.id}
                    className={`voicedict-tab ${tab === tb.id ? 'on' : ''}`}
                    onClick={() => setTab(tb.id)}
                  >
                    {tb.label}
                    <span className="voicedict-tab-count">{tb.count}</span>
                  </button>
                ))}
              </div>

              <div className="voicedict-body">
                {tab === 'terms' && (
                  <section>
                    <div className="voicedict-hint">{t('voicedict.terms.hint')}</div>
                    <div className="voicedict-list">
                      {terms.length === 0 && <div className="voicedict-empty">{t('voicedict.empty')}</div>}
                      {terms.map((term, i) => (
                        <div className="voicedict-row" key={i}>
                          <input
                            ref={i === terms.length - 1 ? lastInput : undefined}
                            className="voicedict-input"
                            value={term}
                            placeholder={t('voicedict.terms.ph')}
                            onChange={(e) => setTermAt(i, e.target.value)}
                          />
                          <button
                            type="button"
                            className="voicedict-row-x"
                            title={t('voicedict.remove')}
                            onClick={() => removeTerm(i)}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                    <button type="button" className="voicedict-addrow" onClick={addTerm}>
                      + {t('voicedict.add')}
                    </button>
                  </section>
                )}

                {tab === 'reps' && (
                  <section>
                    <div className="voicedict-hint">{t('voicedict.reps.hint')}</div>
                    <div className="voicedict-list">
                      {reps.length === 0 && <div className="voicedict-empty">{t('voicedict.empty')}</div>}
                      {reps.map((r, i) => (
                        <div className="voicedict-row" key={i}>
                          <input
                            ref={i === reps.length - 1 ? lastInput : undefined}
                            className="voicedict-input"
                            value={r.from}
                            placeholder={t('voicedict.reps.from')}
                            onChange={(e) => setRep(i, 'from', e.target.value)}
                          />
                          <span className="voicedict-arrow">→</span>
                          <input
                            className="voicedict-input"
                            value={r.to}
                            placeholder={t('voicedict.reps.to')}
                            onChange={(e) => setRep(i, 'to', e.target.value)}
                          />
                          <button
                            type="button"
                            className="voicedict-row-x"
                            title={t('voicedict.remove')}
                            onClick={() => removeRep(i)}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                    <button type="button" className="voicedict-addrow" onClick={addRep}>
                      + {t('voicedict.add')}
                    </button>
                  </section>
                )}

                {tab === 'spell' && (
                  <section>
                    <div className="voicedict-hint">{t('voicedict.spell.hint')}</div>
                    <div className="voicedict-list">
                      {spellWords.length === 0 && <div className="voicedict-empty">{t('voicedict.empty')}</div>}
                      {spellWords.map((w, i) => (
                        <div className="voicedict-row" key={i}>
                          <input
                            ref={i === spellWords.length - 1 ? lastInput : undefined}
                            className="voicedict-input"
                            value={w}
                            placeholder={t('voicedict.spell.ph')}
                            onChange={(e) => setSpellAt(i, e.target.value)}
                          />
                          <button
                            type="button"
                            className="voicedict-row-x"
                            title={t('voicedict.remove')}
                            onClick={() => removeSpell(i)}
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                    </div>
                    <button type="button" className="voicedict-addrow" onClick={addSpell}>
                      + {t('voicedict.add')}
                    </button>
                  </section>
                )}
              </div>
            </>
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
