import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';

// Renderiza os filhos no <body role="document"> do webview, fora da árvore .app.
// Garante que overlays de modal escapem de clip/stacking de ancestrais com
// overflow/transform e fiquem sempre no topo.
export function Portal({ children }: { children: ReactNode }) {
  return createPortal(children, document.body);
}
