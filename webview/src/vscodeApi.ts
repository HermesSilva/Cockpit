// Access to the VS Code webview API.
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

// Lightweight state persisted by VSCode (it survives a renderer reload/crash and a
// VSCode restart). Used so the composer's draft/dictation isn't lost.
export function saveState(patch: Record<string, unknown>): void {
  const api = getVsCodeApi();
  api.setState({ ...(api.getState() ?? {}), ...patch });
}

export function readState<T = Record<string, unknown>>(): T | undefined {
  return getVsCodeApi().getState<T>();
}
