import * as vscode from 'vscode';

/**
 * Turns a file dropped from the OS onto a Cockpit panel into a path in its prompt — without
 * Shift — by catching what VS Code does with the drop instead of the drop itself.
 *
 * Why the webview cannot simply take it (read in VS Code 1.143's workbench, not guessed):
 * every webview editor/view registers an observer on the WORKBENCH window that answers any
 * dragover without Shift by setting pointer-events:none on the webview (windowDidDragStart).
 * A drag from the OS always crosses workbench chrome before reaching the panel, so the panel
 * is already blocked when the pointer arrives, and nothing the page does can undo it. The
 * drop then lands on the editor group's drop target, whose handler for external files
 *   1. calls workspacesService.addRecentlyOpened(files) — only for files from the OS, and
 *      never for opens from VS Code's own Explorer or Quick Open;
 *   2. opens them pinned in that group, i.e. on top of the Cockpit panel.
 *
 * So a drop is recognised by both together: a pinned editor appears in a group whose active
 * tab was a Cockpit panel, and its file just moved to the top of the recently-opened list.
 * The editor is closed again, the file taken back off the recents, the panel brought back,
 * and the path handed to its composer. Anything that does not match — a folder (VS Code adds
 * it to the workspace), a drop on another editor, a split-edge drop that creates a new group —
 * is left to VS Code.
 */
export class ExternalDropCatcher implements vscode.Disposable {
  private readonly subs: vscode.Disposable[] = [];
  // Per view column: the active tab at the last event, and when a Cockpit panel stopped
  // being active there (the open and the deactivation may arrive as separate events).
  private activeByColumn = new Map<number, vscode.Tab | undefined>();
  private cockpitLostAt = new Map<number, { at: number; tab: vscode.Tab }>();
  // Recently-opened files as of a quiet moment, to tell what a drop just added.
  private recentSnapshot: string[] = [];
  private snapshotTimer: ReturnType<typeof setTimeout> | undefined;
  private queue: Promise<void> = Promise.resolve();
  private pending = new Map<string, { paths: string[]; timer: ReturnType<typeof setTimeout> }>();

  constructor(
    private readonly viewType: string,
    private readonly panelFor: (column: number, cockpitTab: vscode.Tab) => string | undefined,
    private readonly deliver: (tabId: string, paths: string[]) => void,
    private readonly log: (s: string) => void = () => undefined,
  ) {
    this.snapshotTabs();
    void this.refreshRecents();
    this.subs.push(
      vscode.window.tabGroups.onDidChangeTabs((e) => {
        this.queue = this.queue.then(() => this.onTabs(e)).catch((err) => this.log(`[drop] ${String(err)}`));
      }),
      vscode.window.tabGroups.onDidChangeTabGroups(() => this.snapshotTabs()),
    );
  }

  dispose(): void {
    for (const s of this.subs) s.dispose();
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    for (const p of this.pending.values()) clearTimeout(p.timer);
  }

  private isCockpit(tab: vscode.Tab | undefined): boolean {
    const input = tab?.input;
    return input instanceof vscode.TabInputWebview && input.viewType.endsWith(this.viewType);
  }

  private snapshotTabs(): void {
    const now = Date.now();
    for (const g of vscode.window.tabGroups.all) {
      const before = this.activeByColumn.get(g.viewColumn);
      const after = g.activeTab;
      if (this.isCockpit(before) && !this.isCockpit(after) && before) {
        this.cockpitLostAt.set(g.viewColumn, { at: now, tab: before });
      }
      this.activeByColumn.set(g.viewColumn, after);
    }
  }

  /** The Cockpit tab that was in front in this column right before the event, if any. */
  private cockpitBefore(column: number, before: Map<number, vscode.Tab | undefined>): vscode.Tab | undefined {
    const prev = before.get(column);
    if (this.isCockpit(prev)) return prev;
    const lost = this.cockpitLostAt.get(column);
    return lost && Date.now() - lost.at < 2000 ? lost.tab : undefined;
  }

  private async onTabs(e: vscode.TabChangeEvent): Promise<void> {
    const before = new Map(this.activeByColumn);
    this.snapshotTabs();

    const candidates = [...e.opened, ...e.changed].filter((t) => t.isActive && !t.isPreview && uriOf(t));
    const hits: { tab: vscode.Tab; uri: vscode.Uri; tabId: string; opened: boolean }[] = [];
    for (const tab of candidates) {
      const column = tab.group.viewColumn;
      const cockpit = this.cockpitBefore(column, before);
      if (!cockpit) continue;
      const tabId = this.panelFor(column, cockpit);
      if (!tabId) continue;
      hits.push({ tab, uri: uriOf(tab)!, tabId, opened: e.opened.includes(tab) });
    }
    if (hits.length) await this.claim(hits);
    this.scheduleRecentsSnapshot();
  }

  private async claim(hits: { tab: vscode.Tab; uri: vscode.Uri; tabId: string; opened: boolean }[]): Promise<void> {
    // The recents are written by the main process; give it one beat if the first read is early.
    let fresh = await this.freshRecents();
    if (!hits.some((h) => fresh.has(h.uri.toString()))) {
      await new Promise((r) => setTimeout(r, 150));
      fresh = await this.freshRecents();
    }
    for (const h of hits) {
      if (!fresh.has(h.uri.toString())) continue; // opened some other way: VS Code's business
      this.log(`[drop] external file dropped on the Cockpit: ${h.uri.fsPath}`);
      // Already open before the drop: VS Code only brought it forward, so it stays open.
      if (h.opened) await vscode.window.tabGroups.close(h.tab).then(undefined, () => undefined);
      await vscode.commands
        .executeCommand('_workbench.removeFromRecentlyOpened', h.uri)
        .then(undefined, () => undefined);
      this.queueDelivery(h.tabId, h.uri.fsPath);
    }
    // No re-read here on purpose: taking a file off the recents does not move the old top
    // entry, and the other files of a multi-file drop are still to be claimed against the
    // list as it was before the drop. The snapshot is retaken once things are quiet.
  }

  // A multi-file drop arrives as several tab events: hand the paths over together.
  private queueDelivery(tabId: string, path: string): void {
    const cur = this.pending.get(tabId);
    if (cur) {
      clearTimeout(cur.timer);
      if (!cur.paths.includes(path)) cur.paths.push(path);
    }
    const entry = cur ?? { paths: [path], timer: undefined as unknown as ReturnType<typeof setTimeout> };
    entry.timer = setTimeout(() => {
      this.pending.delete(tabId);
      this.deliver(tabId, entry.paths);
    }, 120);
    this.pending.set(tabId, entry);
  }

  private async recents(): Promise<string[]> {
    try {
      const r = await vscode.commands.executeCommand<{ files?: { fileUri?: vscode.Uri }[] }>(
        '_workbench.getRecentlyOpened',
      );
      return (r?.files ?? []).map((f) => f.fileUri?.toString() ?? '').filter(Boolean);
    } catch {
      return [];
    }
  }

  private async refreshRecents(): Promise<void> {
    this.recentSnapshot = await this.recents();
  }

  // The snapshot is taken only once things are quiet, so the events of one drop are all
  // compared against the list as it was before that drop.
  private scheduleRecentsSnapshot(): void {
    if (this.snapshotTimer) clearTimeout(this.snapshotTimer);
    this.snapshotTimer = setTimeout(() => void this.refreshRecents(), 1000);
  }

  /** Files that just went to the top of the recents: new ones, or ones that moved up. */
  private async freshRecents(): Promise<Set<string>> {
    return freshEntries(this.recentSnapshot, await this.recents());
  }
}

/**
 * Entries an add put on top since `before`: everything above the old top entry. Comparing
 * positions one by one would not do — removing any entry shifts the rest up, which would read
 * as every file having just been added. Without the old top (it was removed), new entries.
 */
export function freshEntries(before: string[], now: string[]): Set<string> {
  const top = before.length ? now.indexOf(before[0]) : -1;
  return new Set(top === -1 ? now.filter((u) => !before.includes(u)) : now.slice(0, top));
}

function uriOf(tab: vscode.Tab): vscode.Uri | undefined {
  const i = tab.input;
  if (i instanceof vscode.TabInputText || i instanceof vscode.TabInputCustom || i instanceof vscode.TabInputNotebook) {
    return i.uri.scheme === 'file' ? i.uri : undefined;
  }
  return undefined;
}
