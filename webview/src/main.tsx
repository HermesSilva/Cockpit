import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles.css';

declare global {
  interface Window {
    __TOOTEGA_VIEW__?: 'chat' | 'hub';
    __TOOTEGA_SESSION__?: string;
    __TOOTEGA_REGION__?: string;
  }
}

const view = window.__TOOTEGA_VIEW__ === 'hub' ? 'hub' : 'chat';
const sessionId = window.__TOOTEGA_SESSION__ || '';
const container = document.getElementById('root');
if (container) {
  createRoot(container).render(<App view={view} sessionId={sessionId} />);
}
