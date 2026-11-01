// Fake extension host for the showcase captures. It speaks the real host->webview protocol
// (shared/protocol.ts) to the real, unmodified webview bundle (dist/webview/main.js).
(function () {
  const D = window.__DATA__;
  const TAB = 'tab1';
  const SID = '7f3c2a10-5b9e-4c1d-9a7e-2f6b8d4e1c30';
  const CWD = 'D:\\Tootega\\Source\\Cockpit\\Cockpit';
  const listeners = [];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms / (window.__SPEED__ || 1)));
  const post = (msg) => window.postMessage(msg, '*');
  const tpost = (msg) => post({ ...msg, tab: TAB });

  const config = {
    engine: 'claude', engines: ['claude'],
    model: 'claude-opus-5-5', effort: 'high',
    models: ['default', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
    modelGroups: [{ label: 'versions', items: ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] }],
    modelMeta: {
      'claude-fable-5-1': { label: 'Claude Fable 5.1', contextTokens: 1000000 },
      'claude-opus-5-5': { label: 'Claude Opus 5.5', contextTokens: 1000000 },
      'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', contextTokens: 1000000 },
      'claude-haiku-5-5': { label: 'Claude Haiku 5.5', contextTokens: 200000 },
    },
    efforts: ['default', 'low', 'medium', 'high', 'xhigh', 'max'],
    defaultModel: 'claude-opus-5-5', defaultEffort: 'high',
    permissionMode: 'default',
    permissionModes: ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'],
    allowAgents: true, showThinking: false, spellCheck: false, expandToolCards: false,
    pendingRestart: false, userName: 'Hermes', voiceCorrect: false, verbosity: 'verbose',
  };

  let turnNo = 0;
  const stats = (k) => ({
    model: 'claude-opus-5-5', mode: 'default', sessionStartTs: Date.now() - 41 * 60e3,
    contextUsed: Math.round(118400 + k * 9300), contextLimit: 1000000,
    inputTokens: 2310 + k * 410, outputTokens: 18420 + k * 3900,
    cacheCreateTokens: 286000 + k * 9000, cacheReadTokens: 14400000 + k * 120000,
    cacheHitRate: 0.98, lastTurnHitRate: 0.97, cacheSavingsUsd: 64.82 + k * 0.6,
    sessionCostUsd: 4.36 + k * 0.41, lastTurnCostUsd: 0.41, costIsEstimate: false,
    turnCount: 177 + k, reopenCount: 2, activeMs: (22 * 60 + 28) * 1000 + k * 47000,
    cacheLifeMs: 3600e3, cacheAgeMs: 4000, cacheExpiresInMs: 3596e3, cacheExpiresAt: Date.now() + 3596e3,
    cacheAlive: true, keepCacheAlive: false, peakContextUsed: 131000, peakCacheTokens: 131000,
    limits: { fiveHour: { usedPct: 0.34, resetsAt: new Date(Date.now() + 2.4 * 3600e3).toISOString() },
              sevenDay: { usedPct: 0.21, resetsAt: new Date(Date.now() + 3.6 * 86400e3).toISOString() } },
    limitsSource: 'statusline',
    toolAcceptance: [{ tool: 'Edit', allow: 41, allowAlways: 6, deny: 2 }, { tool: 'Bash', allow: 63, allowAlways: 11, deny: 1 }],
  });
  const sessions = [
    { id: SID, title: 'Export do timeline perde os tool cards', updatedAt: new Date().toISOString(), messageCount: 221,
      createdAt: new Date(Date.now() - 3 * 3600e3).toISOString(), sizeBytes: 958600, userCount: 24, assistantCount: 112, toolCount: 85, model: 'claude-opus-5-5' },
    { id: 'b2', title: 'Drag-and-drop do Explorer sem Shift', updatedAt: new Date(Date.now() - 26 * 3600e3).toISOString(), messageCount: 164,
      createdAt: new Date(Date.now() - 30 * 3600e3).toISOString(), sizeBytes: 702100, userCount: 19, assistantCount: 80, toolCount: 61, model: 'claude-opus-5-5' },
    { id: 'b3', title: 'Paridade VS Code × Visual Studio', updatedAt: new Date(Date.now() - 4 * 86400e3).toISOString(), messageCount: 388,
      createdAt: new Date(Date.now() - 5 * 86400e3).toISOString(), sizeBytes: 1830000, userCount: 41, assistantCount: 190, toolCount: 152, model: 'claude-sonnet-5-5' },
  ];

  function boot() {
    post({ kind: 'ready', locale: window.__LOCALE__ || 'en' });
    post({ kind: 'cliStatus', available: true, version: '2.1.268', latest: '2.1.268', cockpitVersion: '1.0.276' });
    post({ kind: 'config', config });
    post({ kind: 'auth', loggedIn: true });
    post({ kind: 'tabs', tabs: [{ id: TAB, title: 'Export do timeline perde os tool cards', status: 'idle', sessionId: SID }], activeTab: TAB });
    tpost({ kind: 'sessionInit', sessionId: SID, model: 'claude-opus-5-5', cwd: CWD, mode: 'default', slashCommands: ['compact', 'clear', 'review', 'init', 'cost'] });
    tpost({ kind: 'stats', stats: stats(0) });
    post({ kind: 'sessions', sessions, cwd: CWD });
    post({ kind: 'taskTimings', timings: { 'tool:Read': 1500, 'tool:Grep': 1200, 'tool:Bash': 9000, assistant: 6000 } });
    tpost({ kind: 'history', items: window.__PRELOAD__ || [] });
  }

  async function stream(kind, id, text, cps) {
    // token-ish chunks, like the CLI's partial messages
    const parts = text.match(/\S+\s*|\s+/g) || [];
    for (const p of parts) {
      tpost({ kind, id, delta: p });
      await sleep(Math.max(12, (p.length / cps) * 1000));
    }
  }
  const setBusy = (b) => {
    post({ kind: 'tabs', tabs: [{ id: TAB, title: 'Export do timeline perde os tool cards', status: b ? 'busy' : 'idle', sessionId: SID }], activeTab: TAB });
    tpost({ kind: 'busy', busy: b });
  };
  let pendingPermission = null;

  async function turn() {
    turnNo++;
    setBusy(true);
    await sleep(700);
    tpost({ kind: 'assistantStart', id: 'a1' });
    await stream('thinking', 'a1',
      'The auto-saved HTML has every tool card closed. The capture expands all cards and waits for the number of mounted .tool-body nodes to stop growing — but thinking blocks are already open, so that count is stable after one frame and the wait ends before React mounts the tool bodies. I need to confirm in App.tsx.', 260);
    await stream('assistantText', 'a1', 'Let me look at how the export waits for the cards to open before capturing.', 70);
    tpost({ kind: 'assistantDone', id: 'a1' });
    await sleep(300);
    tpost({ kind: 'toolUse', id: 't1', name: 'Grep', input: { pattern: 'buildTimelineHtml', path: 'webview/src', output_mode: 'content', '-n': true } });
    await sleep(900);
    tpost({ kind: 'toolResult', toolUseId: 't1', content: D.grep });
    await sleep(300);
    tpost({ kind: 'toolUse', id: 't2', name: 'Read', input: { file_path: CWD + '\\webview\\src\\App.tsx', offset: D.readAppStart, limit: 39 } });
    await sleep(1000);
    tpost({ kind: 'toolResult', toolUseId: 't2', content: D.readApp });
    await sleep(300);
    tpost({ kind: 'assistantStart', id: 'a2' });
    await stream('assistantText', 'a2',
      "Found it. The loop breaks when `now > 0 && now === last` — with the thinking cards already open, `now` is non-zero and stable on the very first frame, so the capture runs **before** any tool body mounts.\n\nPlan:", 80);
    tpost({ kind: 'assistantDone', id: 'a2' });
    tpost({ kind: 'toolUse', id: 't3', name: 'TodoWrite', input: { todos: [
      { content: 'Open each closed card by clicking its head, wait on the chevrons', status: 'in_progress', activeForm: 'Opening every closed card through its own state' },
      { content: 'Restore exactly the cards it opened, and the scroll', status: 'pending' },
      { content: 'Make Show more, copy and images work in the exported file', status: 'pending' },
      { content: 'Run the test suite', status: 'pending' },
    ] } });
    tpost({ kind: 'toolResult', toolUseId: 't3', content: 'Todos have been modified successfully.' });
    await sleep(900);
    tpost({ kind: 'toolUse', id: 't4', name: 'Edit', input: { file_path: CWD + '\\webview\\src\\App.tsx', old_string: D.oldBlock, new_string: D.newBlock } });
    await sleep(400);
    tpost({ kind: 'permissionRequest', requestId: 'p1', tool: 'Edit', displayName: 'Edit', description: 'Edit webview/src/App.tsx',
      input: { file_path: CWD + '\\webview\\src\\App.tsx', old_string: D.oldBlock, new_string: D.newBlock } });
    await new Promise((r) => (pendingPermission = r));
    await sleep(250);
    tpost({ kind: 'toolResult', toolUseId: 't4', content: 'The file webview/src/App.tsx has been updated successfully.' });
    tpost({ kind: 'toolUse', id: 't5', name: 'TodoWrite', input: { todos: [
      { content: 'Open each closed card by clicking its head, wait on the chevrons', status: 'completed' },
      { content: 'Restore exactly the cards it opened, and the scroll', status: 'completed' },
      { content: 'Make Show more, copy and images work in the exported file', status: 'completed' },
      { content: 'Run the test suite', status: 'in_progress', activeForm: 'Running the test suite' },
    ] } });
    tpost({ kind: 'toolResult', toolUseId: 't5', content: 'Todos have been modified successfully.' });
    await sleep(500);
    tpost({ kind: 'toolUse', id: 't6', name: 'Bash', input: { command: 'npx vitest run', description: 'Run the unit tests' } });
    await sleep(2600);
    if (window.__HOLD_BASH__) await new Promise((r) => (window.__releaseBash = r));
    tpost({ kind: 'toolResult', toolUseId: 't6', content:
      ' Test Files  27 passed | 2 skipped (29)\n      Tests  187 passed | 3 skipped (190)\n   Start at  18:57:30\n   Duration  3.71s (transform 2.85s, setup 0ms, import 4.14s, tests 3.71s)' });
    tpost({ kind: 'toolUse', id: 't7', name: 'TodoWrite', input: { todos: [
      { content: 'Open each closed card by clicking its head, wait on the chevrons', status: 'completed' },
      { content: 'Restore exactly the cards it opened, and the scroll', status: 'completed' },
      { content: 'Make Show more, copy and images work in the exported file', status: 'completed' },
      { content: 'Run the test suite', status: 'completed' },
    ] } });
    tpost({ kind: 'toolResult', toolUseId: 't7', content: 'Todos have been modified successfully.' });
    await sleep(400);
    tpost({ kind: 'assistantStart', id: 'a3' });
    await stream('assistantText', 'a3',
      'Fixed. The exported timeline now opens every card for the capture and puts your view back afterwards.\n\n' +
      '| | Before | After |\n|---|---|---|\n| Tool cards in the file | closed, empty | open on click |\n| Show more | dead text | expands the prompt |\n| Copy | dead text | copies the source |\n\n' +
      'All **187** tests pass.', 90);
    tpost({ kind: 'assistantDone', id: 'a3' });
    tpost({ kind: 'turnComplete', costUsd: 0.41, usage: { input_tokens: 412, output_tokens: 3920, cache_creation_input_tokens: 9100, cache_read_input_tokens: 121300 } });
    tpost({ kind: 'stats', stats: stats(turnNo) });
    setBusy(false);
    window.__TURN_DONE__ = true;
  }

  async function ask() {
    setBusy(true);
    tpost({ kind: 'assistantStart', id: 'q0' });
    await stream('assistantText', 'q0', 'Before I write the tests, a few choices only you can make.', 80);
    tpost({ kind: 'assistantDone', id: 'q0' });
    tpost({ kind: 'toolUse', id: 'tq', name: 'AskUserQuestion', input: { questions: window.__QUESTIONS__ } });
    tpost({ kind: 'askRequest', requestId: 'q1', questions: window.__QUESTIONS__ });
  }

  async function answered(answers) {
    const qs = window.__QUESTIONS__;
    const txt = 'User has answered your questions: ' +
      qs.map((q) => `"${q.question}"="${answers[q.question] ?? ''}"`).join('. ') +
      '. You can now continue with the user\'s answers in mind.';
    await sleep(400);
    tpost({ kind: 'toolResult', toolUseId: 'tq', content: txt });
    tpost({ kind: 'assistantStart', id: 'q2' });
    await stream('assistantText', 'q2',
      'Recorded. I will start with **' + (answers[qs[0].question] || 'the webview') + '**, using **' +
      (answers[qs[1].question] || 'vitest') + '**, and keep each test at the *' + (answers[qs[3].question] || 'behaviour') + '* level.', 90);
    tpost({ kind: 'assistantDone', id: 'q2' });
    tpost({ kind: 'turnComplete', costUsd: 0.12 });
    setBusy(false);
    window.__TURN_DONE__ = true;
  }

  function usage() {
    const day = (n) => new Date(Date.now() - n * 86400e3).toISOString().slice(0, 10);
    return {
      account: { loggedIn: true, authMethod: 'claude.ai', email: 'hermes@tootega.com.br', orgName: 'Tootega', plan: 'max',
        session: { modelDisplay: 'Opus 5.5 (1M context)', effort: 'high', kind: 'interactive' } },
      buckets: {
        fiveHour: { usedPct: 0.34, resetsAt: new Date(Date.now() + 2.4 * 3600e3).toISOString() },
        sevenDay: { usedPct: 0.21, resetsAt: new Date(Date.now() + 3.6 * 86400e3).toISOString() },
        weeklyScoped: [{ label: 'Opus', usedPct: 0.27, resetsAt: new Date(Date.now() + 3.6 * 86400e3).toISOString() }],
      },
      source: 'api', trackingEnabled: true,
      breakdown: {
        byModel: [
          { key: 'claude-opus-5-5', usd: 61.4, tokens: 4120000, cacheRead: 212000000 },
          { key: 'claude-sonnet-5-5', usd: 9.8, tokens: 1830000, cacheRead: 41000000 },
          { key: 'claude-haiku-5-5', usd: 0.9, tokens: 610000, cacheRead: 3100000 },
        ],
        bySource: [
          { key: 'main', usd: 58.2, tokens: 4900000, cacheRead: 221000000 },
          { key: 'subagent', usd: 13.9, tokens: 1660000, cacheRead: 35100000 },
        ],
      },
      attribution: { longContextPct: 0.18, subagentPct: 0.19, cacheHitPct: 0.97,
        byTool: [{ key: 'Read', calls: 412, tokens: 3810000 }, { key: 'Bash', calls: 288, tokens: 1920000 },
                 { key: 'Grep', calls: 197, tokens: 640000 }, { key: 'mcp:dase', calls: 31, tokens: 210000 }] },
      tokens: { sent: 912000000, received: 6400000, total: 918400000,
        days: [0, 1, 2, 3, 4, 5, 6].map((n) => ({ date: day(n), sent: 41000000 - n * 3100000, received: 310000 - n * 21000 })) },
      generatedAt: new Date().toISOString(),
    };
  }

  window.__host = {
    turn, ask,
    on(fn) { listeners.push(fn); },
    fromWebview(msg) {
      for (const fn of listeners) fn(msg);
      if (msg.kind === 'init') boot();
      else if (msg.kind === 'sendMessage' && !window.__NO_AUTO_TURN__) turn();
      else if (msg.kind === 'permissionDecision' && pendingPermission) { const r = pendingPermission; pendingPermission = null; r(); }
      else if (msg.kind === 'listSessions') post({ kind: 'sessions', sessions, cwd: CWD });
      else if (msg.kind === 'fetchUsage') tpost({ kind: 'usageData', data: usage() });
      else if (msg.kind === 'askResponse') answered(msg.answers);
      else if (msg.kind === 'exportMd' && msg.html) window.__EXPORTED__ = msg.html;
    },
  };
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.__host.fromWebview(m),
    getState: () => undefined,
    setState: () => {},
  });
})();
