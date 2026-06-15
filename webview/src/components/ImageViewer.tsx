import { createContext, useContext, useEffect } from 'react';
import type { Translator } from '../i18n';
import { send } from '../vscodeApi';
import { Portal } from './Portal';

// Abre o visualizador de imagem a partir de qualquer lugar (anexo do composer,
// bolha do chat) sem prop drilling. O App fornece o setter.
export const ImageViewerContext = createContext<(src: string) => void>(() => {});
export const useImageViewer = () => useContext(ImageViewerContext);

interface Props {
  t: Translator;
  src: string; // data URL ou URL
  onClose: () => void;
}

// Modal de imagem: Esc/overlay/X fecham. Copiar/Salvar executam a ação e fecham.
export function ImageViewer({ t, src, onClose }: Props) {
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const copy = async () => {
    try {
      const blob = await (await fetch(src)).blob();
      await navigator.clipboard.write([new ClipboardItem({ [blob.type]: blob })]);
    } catch {
      /* clipboard de imagem pode falhar em alguns ambientes; fecha mesmo assim */
    }
    onClose();
  };

  const save = async () => {
    try {
      const { mediaType, data } = await toBytes(src);
      send({ kind: 'saveImage', mediaType, data });
    } catch {
      /* noop */
    }
    onClose();
  };

  return (
    <Portal>
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal img-viewer" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="img-viewer-close"
            title={t('common.close')}
            onClick={onClose}
          >
            ✕
          </button>
          <img className="img-viewer-img" src={src} alt="" />
          <div className="modal-actions">
            <button type="button" className="btn" onClick={() => void copy()}>
              {t('common.copy')}
            </button>
            <button type="button" className="btn send" onClick={() => void save()}>
              {t('common.save')}
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}

// Extrai mediaType + base64 de um data URL; faz fallback via fetch p/ URLs comuns.
async function toBytes(src: string): Promise<{ mediaType: string; data: string }> {
  if (src.startsWith('data:')) {
    const comma = src.indexOf(',');
    const mediaType = src.slice(5, comma).split(';')[0] || 'image/png';
    return { mediaType, data: src.slice(comma + 1) };
  }
  const blob = await (await fetch(src)).blob();
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (const b of buf) bin += String.fromCharCode(b);
  return { mediaType: blob.type || 'image/png', data: btoa(bin) };
}
