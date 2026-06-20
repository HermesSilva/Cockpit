// Acesso à API do webview do VS Code.
import type { WebviewToHost } from '../../shared/protocol';

interface VsCodeApi {
  postMessage(msg: WebviewToHost): void;
  getState<T>(): T | undefined;
  setState<T>(state: T): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;

export function getVsCodeApi(): VsCodeApi {
  if (!api) api = acquireVsCodeApi();
  return api;
}

export function send(msg: WebviewToHost): void {
  getVsCodeApi().postMessage(msg);
}

// Estado leve persistido pelo VSCode (sobrevive a reload/crash do renderer e a
// reinício do VSCode). Usado p/ não perder o rascunho/ditado do composer.
export function saveState(patch: Record<string, unknown>): void {
  const api = getVsCodeApi();
  api.setState({ ...(api.getState() ?? {}), ...patch });
}

export function readState<T = Record<string, unknown>>(): T | undefined {
  return getVsCodeApi().getState<T>();
}
