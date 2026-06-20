import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getLogger(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('Tootega Cockpit');
  return channel;
}

export function log(msg: string): void {
  getLogger().appendLine(`[${new Date().toISOString()}] ${msg}`);
}

// Log de diagnóstico detalhado: só escreve com a flag ligada (tootega.debugLog).
// A flag vive em memória (setada no activate e em onDidChangeConfiguration) p/ o
// dlog não consultar a API do VSCode a cada chamada — e p/ não quebrar testes.
let debugEnabled = false;

export function setDebugLogging(on: boolean): void {
  debugEnabled = on;
}

export function isDebugLogging(): boolean {
  return debugEnabled;
}

/** Linha de debug estruturada `[scope] msg`, só quando o debugLog está ligado. */
export function dlog(scope: string, msg: string): void {
  if (debugEnabled) log(`[${scope}] ${msg}`);
}
