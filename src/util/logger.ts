import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

export function getLogger(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('Tootega Cockpit');
  return channel;
}

export function log(msg: string): void {
  getLogger().appendLine(`[${new Date().toISOString()}] ${msg}`);
}

// Detailed diagnostic log: only writes when the flag is on (tootega.debugLog).
// The flag lives in memory (set in activate and in onDidChangeConfiguration) so
// dlog doesn't hit the VSCode API on every call — and doesn't break tests.
let debugEnabled = false;

export function setDebugLogging(on: boolean): void {
  debugEnabled = on;
}

export function isDebugLogging(): boolean {
  return debugEnabled;
}

/** Structured debug line `[scope] msg`, only when debugLog is on. */
export function dlog(scope: string, msg: string): void {
  if (debugEnabled) log(`[${scope}] ${msg}`);
}
