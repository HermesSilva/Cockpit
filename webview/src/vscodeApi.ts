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
