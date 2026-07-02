// Ponto de entrada da extensão.
import * as vscode from 'vscode';
import { ChatViewProvider } from './panel/ChatViewProvider';
import { enableUsageTracking, disableUsageTracking, isEnabled } from './cli/StatuslineInstaller';
import { flushStats } from './stats/StatsStore';
import { log, setDebugLogging } from './util/logger';

export function activate(context: vscode.ExtensionContext): void {
  setDebugLogging(vscode.workspace.getConfiguration('tootega').get<boolean>('debugLog', false));
  log('Tootega Cockpit activating…');

  // Reinício/reload: o VSCode tenta restaurar as abas-webview dos contextos, mas
  // sem estado elas ficam "mortas". Fecha todas ao ativar — começa limpo.
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

  // O Cockpit vive como aba no editor (WebviewPanel). Sem view de sidebar.
  // O item da status bar (criado pelo provider) e o comando/atalho abrem o editor.

  // Migração única: tira a antiga setting `tootega.apiKey` (texto plano) e move
  // p/ o SecretStorage (keychain do SO). Best-effort, silencioso.
  void provider.migrateApiKeyFromSettings();

  // Na ativação (onStartupFinished): se o CLI faltar, oferece instalar.
  void provider.promptInstallIfMissing();
  // Oferece (uma vez) ativar o uso real da conta via statusline — enriquece o %
  // sempre-visível. O canal automático (rate_limit_event no stream) já funciona
  // sem isto; a statusline complementa em uso baixo.
  void maybeOfferUsageTracking(context, provider);

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
    // Restaura o painel-editor (e sua largura/posição) ao recarregar a janela.
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
        // Fora do Windows o wrapper de statusline não se aplica — mas o uso real já
        // vem da API OAuth /usage (fonte primária, cross-platform). Nada a instalar.
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
      // Mudança de model/effort/permission: reinicia overrides + reflete nos combos.
      if (
        e.affectsConfiguration('tootega.model') ||
        e.affectsConfiguration('tootega.effort') ||
        e.affectsConfiguration('tootega.permissionMode') ||
        e.affectsConfiguration('tootega.allowAgents')
      ) {
        provider.applyDefaultsFromSettings();
      }
      // Prefs só de UI: re-empurra config sem reiniciar a sessão.
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

/** Fecha as abas-webview do Cockpit (viewType tootega.cockpit.editor) que o VSCode
 *  tentou restaurar sem estado após reload/reinício. */
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
 * Oferece (uma única vez) ativar o uso real da conta via statusline. Windows-only
 * por enquanto. Não insiste: grava um flag em globalState após a primeira oferta.
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
