// Which engine backs the session: the official Claude Code CLI, or the
// Tootega agent (a local model, no account and no cost).
//
// Both speak the SAME process contract — stream-json over stdin/stdout, the
// shapes in shared/events.ts. That is the whole point: the UI does not
// reimplement orchestration for either one, it just spawns a different binary.
//
// What differs is only what the engine can offer around the conversation.
// Claude brings account, subscription limits, plugins, skills and MCP; Tootega
// runs a local model, so those panels have nothing to show. `engineCaps` is the
// single place that says so, instead of scattering `if (engine === ...)` across
// the UI.
import * as vscode from 'vscode';

export type EngineId = 'claude' | 'tootega';

export interface EngineCaps {
  /** Anthropic account, `/usage`, statusline, rate limits. */
  account: boolean;
  /** Plugins, skills, MCP servers, subagents. */
  extensions: boolean;
  /** Cost in dollars is meaningful (Tootega always reports zero). */
  cost: boolean;
}

const CAPS: Record<EngineId, EngineCaps> = {
  claude: { account: true, extensions: true, cost: true },
  tootega: { account: false, extensions: false, cost: false },
};

export function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('tootega');
}

export function currentEngine(): EngineId {
  return cfg().get<EngineId>('engine', 'claude') === 'tootega' ? 'tootega' : 'claude';
}

export function engineCaps(engine: EngineId = currentEngine()): EngineCaps {
  return CAPS[engine];
}

export function engineLabel(engine: EngineId = currentEngine()): string {
  return engine === 'tootega' ? 'Tootega Code CLI' : 'Claude Code CLI';
}

/** Configured path of the executable for the active engine. */
export function enginePath(engine: EngineId = currentEngine()): string {
  return engine === 'tootega'
    ? cfg().get<string>('tootegaPath', 'agent.exe')
    : cfg().get<string>('claudePath', 'claude');
}

/** `host:port` of the tootega engine server. Empty means the agent's default. */
export function tootegaServer(): string {
  return cfg().get<string>('tootegaServer', '127.0.0.1:8080').trim();
}
