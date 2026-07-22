import { useState } from 'react';
import { Portal } from './Portal';
import type { Translator } from '../i18n';
import type { CredentialMeta } from '../../../shared/protocol';

interface Props {
  t: Translator;
  data: { enrolled: boolean; items: CredentialMeta[] } | null; // null = carregando
  setup: { qrSvg: string; secret: string; uri: string } | null; // enrollment em curso
  error?: string;
  result?: { ok: boolean; action: string; message?: string } | null;
  onEnrollBegin: () => void;
  onEnrollConfirm: (code: string) => void;
  onAdd: (d: { name: string; username?: string; value?: string; note?: string; code: string }) => void;
  onEdit: (id: string, d: { name: string; username?: string; value?: string; note?: string; code: string }) => void;
  onUse: (id: string, code: string) => void;
  onDelete: (id: string, code: string) => void;
  onClose: () => void;
  useLabel: string; // "Usar" (chat: injeta) ou "Copiar" (hub: clipboard)
}

// 6-digit TOTP code field.
function CodeInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      className="creds-code"
      inputMode="numeric"
      autoComplete="one-time-code"
      maxLength={6}
      placeholder={placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value.replace(/\D/g, '').slice(0, 6))}
    />
  );
}

export function CredentialsModal({
  t,
  data,
  setup,
  error,
  result,
  onEnrollBegin,
  onEnrollConfirm,
  onAdd,
  onEdit,
  onUse,
  onDelete,
  onClose,
  useLabel,
}: Props) {
  const [enrollCode, setEnrollCode] = useState('');
  const [code, setCode] = useState(''); // current code for actions (add/use/delete)
  const [name, setName] = useState('');
  const [username, setUsername] = useState('');
  const [value, setValue] = useState('');
  const [note, setNote] = useState('');
  const [confirmDel, setConfirmDel] = useState<string | null>(null);
  // Inline editing: the id being edited + a draft of the fields (empty value = keep current).
  const [editId, setEditId] = useState<string | null>(null);
  const [edit, setEdit] = useState({ name: '', username: '', value: '', note: '' });

  const badCode = result && !result.ok && result.message === 'totp';
  const badInput = result && !result.ok && result.message === 'input';

  return (
    <Portal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal creds-modal" onClick={(e) => e.stopPropagation()}>
          <div className="creds-head">
            <span className="modal-title">🔐 {t('creds.title')}</span>
            <button type="button" className="modal-close" title={t('common.close')} onClick={onClose}>
              ✕
            </button>
          </div>

          {error && <div className="creds-error">{error}</div>}

          {data == null ? (
            <div className="creds-loading">…</div>
          ) : !data.enrolled ? (
            // ---- Enrollment do 2FA ----
            <div className="creds-enroll">
              <p className="creds-hint">{t('creds.enroll.intro')}</p>
              {!setup ? (
                <button type="button" className="btn primary" onClick={onEnrollBegin}>
                  {t('creds.enroll.begin')}
                </button>
              ) : (
                <>
                  <div
                    className="creds-qr"
                    // SVG generated in the host (qrcode lib) — trusted content.
                    dangerouslySetInnerHTML={{ __html: setup.qrSvg }}
                  />
                  <p className="creds-hint">{t('creds.enroll.scan')}</p>
                  <code className="creds-secret" title={t('creds.enroll.manual')}>
                    {setup.secret}
                  </code>
                  <div className="creds-row">
                    <CodeInput value={enrollCode} onChange={setEnrollCode} placeholder={t('creds.code')} />
                    <button
                      type="button"
                      className="btn primary"
                      disabled={enrollCode.length !== 6}
                      onClick={() => onEnrollConfirm(enrollCode)}
                    >
                      {t('creds.enroll.confirm')}
                    </button>
                  </div>
                  {result && !result.ok && result.action === 'enroll' && (
                    <div className="creds-error">{t('creds.code.invalid')}</div>
                  )}
                </>
              )}
            </div>
          ) : (
            // ---- Enrolled vault: code + add + list ----
            <div className="creds-vault">
              <div className="creds-codebar">
                <CodeInput value={code} onChange={setCode} placeholder={t('creds.code')} />
                <span className="creds-codehint">{t('creds.code.hint')}</span>
              </div>
              {badCode && <div className="creds-error">{t('creds.code.invalid')}</div>}
              {badInput && <div className="creds-error">{t('creds.add.invalid')}</div>}

              <details className="creds-add">
                <summary>{t('creds.add')}</summary>
                <div className="creds-add-form">
                  <input
                    className="creds-field"
                    placeholder={t('creds.field.name')}
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                  <input
                    className="creds-field"
                    placeholder={t('creds.field.username')}
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                  />
                  <input
                    className="creds-field"
                    type="password"
                    placeholder={t('creds.field.value')}
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                  />
                  <input
                    className="creds-field"
                    placeholder={t('creds.field.note')}
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn primary"
                    disabled={code.length !== 6 || !name.trim() || !value}
                    onClick={() => {
                      onAdd({ name, username, value, note, code });
                      setName('');
                      setUsername('');
                      setValue('');
                      setNote('');
                    }}
                  >
                    {t('creds.add.action')}
                  </button>
                </div>
              </details>

              <ul className="creds-list">
                {data.items.length === 0 && <li className="creds-empty">{t('creds.empty')}</li>}
                {data.items.map((c) =>
                  editId === c.id ? (
                    // ---- Inline editing ----
                    <li key={c.id} className="creds-item editing">
                      <div className="creds-add-form">
                        <input
                          className="creds-field"
                          placeholder={t('creds.field.name')}
                          value={edit.name}
                          onChange={(e) => setEdit((s) => ({ ...s, name: e.target.value }))}
                        />
                        <input
                          className="creds-field"
                          placeholder={t('creds.field.username')}
                          value={edit.username}
                          onChange={(e) => setEdit((s) => ({ ...s, username: e.target.value }))}
                        />
                        <input
                          className="creds-field"
                          type="password"
                          placeholder={t('creds.field.value.keep')}
                          value={edit.value}
                          onChange={(e) => setEdit((s) => ({ ...s, value: e.target.value }))}
                        />
                        <input
                          className="creds-field"
                          placeholder={t('creds.field.note')}
                          value={edit.note}
                          onChange={(e) => setEdit((s) => ({ ...s, note: e.target.value }))}
                        />
                        <div className="creds-item-actions">
                          <button
                            type="button"
                            className="btn primary"
                            disabled={code.length !== 6 || !edit.name.trim()}
                            onClick={() => {
                              onEdit(c.id, { ...edit, code });
                              setEditId(null);
                            }}
                          >
                            {t('creds.edit.save')}
                          </button>
                          <button type="button" className="btn" onClick={() => setEditId(null)}>
                            {t('confirm.cancel')}
                          </button>
                        </div>
                      </div>
                    </li>
                  ) : (
                  <li key={c.id} className="creds-item">
                    <div className="creds-item-info">
                      <span className="creds-item-name">{c.name}</span>
                      {c.username && <span className="creds-item-user">{c.username}</span>}
                      {c.note && <span className="creds-item-note">{c.note}</span>}
                    </div>
                    {confirmDel === c.id ? (
                      <div className="creds-item-actions">
                        <button
                          type="button"
                          className="btn danger"
                          disabled={code.length !== 6}
                          onClick={() => {
                            onDelete(c.id, code);
                            setConfirmDel(null);
                          }}
                        >
                          {t('creds.delete.confirm')}
                        </button>
                        <button type="button" className="btn" onClick={() => setConfirmDel(null)}>
                          {t('confirm.cancel')}
                        </button>
                      </div>
                    ) : (
                      <div className="creds-item-actions">
                        <button
                          type="button"
                          className="btn primary"
                          disabled={code.length !== 6}
                          title={t('creds.use.hint')}
                          onClick={() => onUse(c.id, code)}
                        >
                          {useLabel}
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => {
                            setEditId(c.id);
                            setEdit({
                              name: c.name,
                              username: c.username ?? '',
                              value: '',
                              note: c.note ?? '',
                            });
                          }}
                          aria-label={t('creds.edit')}
                          title={t('creds.edit')}
                        >
                          ✏️
                        </button>
                        <button
                          type="button"
                          className="btn"
                          onClick={() => setConfirmDel(c.id)}
                          aria-label={t('creds.delete')}
                        >
                          🗑
                        </button>
                      </div>
                    )}
                  </li>
                  ),
                )}
              </ul>
            </div>
          )}
        </div>
      </div>
    </Portal>
  );
}
