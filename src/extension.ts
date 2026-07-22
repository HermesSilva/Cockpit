// Extension entry point.
import * as vscode from 'vscode';
import { ChatViewProvider } from './panel/ChatViewProvider';
import { enableUsageTracking, disableUsageTracking, isEnabled } from './cli/StatuslineInstaller';
import {
  enableUtf8Fix,
  disableUtf8Fix,
  isEnabled as utf8FixEnabled,
} from './cli/Utf8HookInstaller';
import { flushStats } from './stats/StatsStore';
import { log, setDebugLogging } from './util/logger';

export function activate(context: vscode.ExtensionContext): void {
  setDebugLogging(vscode.workspace.getConfiguration('tootega').get<boolean>('debugLog', false));
  log('Tootega Cockpit activating…');

  // Restart/reload: VSCode tries to restore the contexts' webview tabs, but
  // without state they end up "dead". Close them all on activate — start clean.
  closeStaleCockpitTabs();

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  context.subscriptions.push(statusBar);

  const provider = new ChatViewProvider(
    context.extensionUri,
    context.globalState,
    statusBar,
    context.secrets,
    context.globalStorageUri,
  );
  context.subscriptions.push({ dispose: () => provider.dispose() }); // para o CacheKeeper

  // The Cockpit lives as an editor tab (WebviewPanel). No sidebar view.
  // The status bar item (created by the provider) and the command/shortcut open the editor.

  // One-off migration: drops the old `tootega.apiKey` setting (plain text) and moves it
  // p/ o SecretStorage (keychain do SO). Best-effort, silencioso.
  void provider.migrateApiKeyFromSettings();

  // On activation (onStartupFinished): if the CLI is missing, offer to install it.
  void provider.promptInstallIfMissing();
  // Offer (once) to enable real account usage via the statusline — it enriches the
  // always-visible %. The automatic channel (rate_limit_event in the stream) already works
  // without it; the statusline complements it at low usage.
  void maybeOfferUsageTracking(context, provider);
  // Offer (once) the hook that fixes the accents of the PowerShell tool on
  // Windows — see Utf8HookInstaller for the why.
  void maybeOfferUtf8Fix(context);

  context.subscriptions.push(
    vscode.commands.registerCommand('tootega.open', () => {
      provider.openInEditor();
    }),
    vscode.commands.registerCommand('tootega.newSession', () => {
      provider.newSession();
      vscode.window.setStatusBarMessage(vscode.l10n.t('Started a new session.'), 3000);
    }),
    vscode.commands.registerCommand('tootega.interrupt', () => {
      provider.interrupt();
      vscode.window.setStatusBarMessage(vscode.l10n.t('Agent interrupted.'), 3000);
    }),
    vscode.commands.registerCommand('tootega.openSessions', async () => {
      await vscode.commands.executeCommand('workbench.view.extension.tootega');
      provider.openSessions();
    }),
    vscode.commands.registerCommand('tootega.settings', () => {
      void vscode.commands.executeCommand(
        'workbench.action.openSettings',
        '@ext:tootega.tootega-cockpit',
      );
    }),
    vscode.commands.registerCommand('tootega.openInEditor', () => {
      provider.openInEditor();
    }),
    vscode.commands.registerCommand('tootega.reloadView', () => {
      provider.reloadActivePanel();
    }),
    vscode.commands.registerCommand('tootega.reopenClosed', () => {
      provider.reopenClosed();
    }),
    vscode.commands.registerCommand('tootega.login', () => {
      provider.loginCli();
    }),
    vscode.commands.registerCommand('tootega.logout', () => {
      provider.logoutCli();
    }),
    vscode.commands.registerCommand('tootega.setApiKey', () => {
      void provider.setApiKeyInteractive();
    }),
    vscode.commands.registerCommand('tootega.clearApiKey', () => {
      void provider.clearApiKey();
    }),
    // Hub na Activity Bar (WebviewView). Mesma bundle, modo 'hub'.
    vscode.window.registerWebviewViewProvider('tootega.hub', provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    // Restores the editor panel (and its width/position) when the window reloads.
    vscode.window.registerWebviewPanelSerializer('tootega.cockpit.editor', {
      deserializeWebviewPanel: async (panel) => {
        provider.attachPanel(panel);
      },
    }),
    vscode.commands.registerCommand('tootega.enableUsageTracking', () => {
      const r = enableUsageTracking(context.globalState);
      if (r === 'ok') {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Real usage tracking enabled. Run an interactive `claude` session once to populate it.'),
        );
      } else if (r === 'unsupported') {
        // Outside Windows the statusline wrapper doesn't apply — but real usage already
        // comes from the OAuth /usage API (primary, cross-platform source). Nothing to install.
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            'Real account usage already comes from the Claude API on this platform — nothing to install. (The statusline wrapper is a Windows-only extra source.)',
          ),
        );
      } else {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('Could not update ~/.claude/settings.json (does it have comments?). Edit it manually.'),
        );
      }
      provider.refreshUsageNow();
    }),
    vscode.commands.registerCommand('tootega.disableUsageTracking', () => {
      const r = disableUsageTracking(context.globalState);
      void vscode.window.showInformationMessage(
        r === 'ok'
          ? vscode.l10n.t('Real usage tracking disabled.')
          : vscode.l10n.t('Could not update ~/.claude/settings.json (does it have comments?). Edit it manually.'),
      );
      provider.refreshUsageNow();
    }),
    vscode.commands.registerCommand('tootega.enableUtf8Fix', () => {
      const r = enableUtf8Fix();
      if (r === 'ok') {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Accent fix installed. New PowerShell tool calls will return UTF-8 output.'),
        );
      } else if (r === 'unsupported') {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('Nothing to install: shells on this platform already output UTF-8.'),
        );
      } else {
        void vscode.window.showWarningMessage(
          vscode.l10n.t('Could not update ~/.claude/settings.json (does it have comments?). Edit it manually.'),
        );
      }
    }),
    vscode.commands.registerCommand('tootega.disableUtf8Fix', () => {
      const r = disableUtf8Fix();
      void vscode.window.showInformationMessage(
        r === 'ok'
          ? vscode.l10n.t('Accent fix removed.')
          : vscode.l10n.t('Could not update ~/.claude/settings.json (does it have comments?). Edit it manually.'),
      );
    }),
    vscode.commands.registerCommand('tootega.toggleLanguage', async () => {
      const cfg = vscode.workspace.getConfiguration('tootega');
      const current = cfg.get<string>('language', 'auto');
      const next = current === 'pt-BR' ? 'en' : 'pt-BR';
      await cfg.update('language', next, vscode.ConfigurationTarget.Global);
      provider.pushLocale();
    }),
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('tootega.language')) provider.pushLocale();
      if (e.affectsConfiguration('tootega.internalModel')) provider.applyInternalModel();
      if (e.affectsConfiguration('tootega.debugLog')) {
        setDebugLogging(vscode.workspace.getConfiguration('tootega').get<boolean>('debugLog', false));
      }
      // Model/effort/permission change: resets overrides + reflects them in the dropdowns.
      if (
        e.affectsConfiguration('tootega.model') ||
        e.affectsConfiguration('tootega.effort') ||
        e.affectsConfiguration('tootega.permissionMode') ||
        e.affectsConfiguration('tootega.allowAgents')
      ) {
        provider.applyDefaultsFromSettings();
      }
      // UI-only prefs: re-push the config without restarting the session.
      if (
        e.affectsConfiguration('tootega.showThinking') ||
        e.affectsConfiguration('tootega.expandToolCards') ||
        e.affectsConfiguration('tootega.userName') ||
        e.affectsConfiguration('tootega.verbosity')
      ) {
        provider.pushConfig();
      }
    }),
  );

  // URI handler: vscode://tootega.tootega-cockpit/open
  context.subscriptions.push(
    vscode.window.registerUriHandler({
      handleUri: (uri) => {
        if (uri.path === '/open' || uri.path === '') {
          void vscode.commands.executeCommand('tootega.open');
        }
      },
    }),
  );

  log('Tootega Cockpit activated.');
}

export function deactivate(): void {
  flushStats(); // grava as estatísticas pendentes de cada sessão antes de sair
  log('Tootega Cockpit deactivated.');
}

/** Closes the Cockpit webview tabs (viewType tootega.cockpit.editor) that VSCode
 *  tried to restore without state after a reload/restart. */
function closeStaleCockpitTabs(): void {
  try {
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (
          input instanceof vscode.TabInputWebview &&
          input.viewType.includes('tootega.cockpit.editor')
        ) {
          void vscode.window.tabGroups.close(tab);
        }
      }
    }
  } catch (e) {
    log(`closeStaleCockpitTabs: ${String(e)}`);
  }
}

/**
 * Offers (only once) to enable real account usage via the statusline. Windows-only
 * for now. It doesn't insist: it writes a flag in globalState after the first offer.
 */
async function maybeOfferUsageTracking(
  context: vscode.ExtensionContext,
  provider: ChatViewProvider,
): Promise<void> {
  if (process.platform !== 'win32') return; // instalador Windows-only por ora
  if (isEnabled()) return; // já ativo
  if (context.globalState.get<boolean>('usageTrackingPrompted')) return;
  void context.globalState.update('usageTrackingPrompted', true);
  const enable = vscode.l10n.t('Enable');
  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Show real account usage (5h / 7-day limits) in the Cockpit? This wraps your Claude Code statusline; you can undo it anytime.',
    ),
    enable,
  );
  if (pick !== enable) return;
  const r = enableUsageTracking(context.globalState);
  if (r === 'ok') {
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Real usage tracking enabled. Run an interactive `claude` session once to populate it.',
      ),
    );
  } else if (r !== 'unsupported') {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Could not update ~/.claude/settings.json (does it have comments?). Edit it manually.',
      ),
    );
  }
  provider.refreshUsageNow();
}

/**
 * Offers (only once) to install the PowerShell tool's UTF-8 hook. Windows-only:
 * that's where a console-less shell falls back to the OEMCP and corrupts accents in the output.
 */
async function maybeOfferUtf8Fix(context: vscode.ExtensionContext): Promise<void> {
  if (process.platform !== 'win32') return;
  if (utf8FixEnabled()) return;
  if (context.globalState.get<boolean>('utf8FixPrompted')) return;
  void context.globalState.update('utf8FixPrompted', true);
  const install = vscode.l10n.t('Install');
  const pick = await vscode.window.showInformationMessage(
    vscode.l10n.t(
      'Fix garbled accents in PowerShell command output? Installs a small Claude Code hook that forces UTF-8; it never blocks a command and you can remove it anytime.',
    ),
    install,
  );
  if (pick !== install) return;
  const r = enableUtf8Fix();
  if (r === 'ok') {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Accent fix installed. New PowerShell tool calls will return UTF-8 output.'),
    );
  } else if (r !== 'unsupported') {
    void vscode.window.showWarningMessage(
      vscode.l10n.t(
        'Could not update ~/.claude/settings.json (does it have comments?). Edit it manually.',
      ),
    );
  }
}
