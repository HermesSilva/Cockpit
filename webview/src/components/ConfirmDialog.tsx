import { useEffect } from 'react';
import { Portal } from './Portal';

interface Props {
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  cancelLabel,
  danger,
  onConfirm,
  onCancel,
}: Props) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onConfirm();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onConfirm, onCancel]);

  return (
    <Portal>
      <div className="modal-overlay" onClick={onCancel}>
        <div className="modal confirm" onClick={(e) => e.stopPropagation()}>
          <div className="confirm-head">
            <span className={`confirm-icon ${danger ? 'danger' : ''}`}>{danger ? '⚠' : '?'}</span>
            <span className="modal-title">{title}</span>
          </div>
          <div className="modal-body">{body}</div>
          <div className="modal-actions">
            <button type="button" className="btn" onClick={onCancel}>
              {cancelLabel}
            </button>
            <button
              type="button"
              className={`btn ${danger ? 'danger-solid' : 'send'}`}
              onClick={onConfirm}
              autoFocus
            >
              {confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
