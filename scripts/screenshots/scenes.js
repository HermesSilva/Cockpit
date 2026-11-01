// A past conversation, replayed through the real 'history' message (several prompts, so the
// scroll-marker rail has something to mark).
if (new URLSearchParams(location.search).get('preload') === 'history') {
  const t0 = Date.now() - 50 * 60e3;
  const P = [
    'Audit the webview for strings that bypass t() and list them by component.',
    'Port the scroll-marker rail to the Visual Studio build.\nKeep the same hover preview and the numbered tips.',
    'Why does the cache hit rate drop to 60% after an idle hour?',
    'Add a keep-alive that re-sends a minimal turn before the 1h TTL lapses.\nIt must be opt-in, per tab, and visible in the hub.',
    'Write the CHANGELOG entry for the keep-alive.',
    'Check that the stream-json contract still matches between both repos.',
  ];
  const A = [
    'Found **14** literal strings in 6 components. The worst offender is `UsageModal.tsx` (5).',
    'Ported. The rail reads the same `.bubble.user` anchors, so no host code was needed.',
    'The prefix cache has a **1 h TTL**. After it lapses the next turn re-writes the whole prefix (`cache_creation`), which is what drags the hit rate down.',
    'Done: a checkbox per tab; the host fires a one-token turn at 55 min and the hub shows the countdown.',
    'Added under **[Unreleased] › Added**.',
    '`shared/events.ts` and `shared/protocol.ts` match byte for byte. No drift.',
  ];
  const B = [
    '- `UsageModal.tsx` — 5\n- `HubView.tsx` — 4\n- `Composer.tsx` — 3\n- `McpModal.tsx`, `SkillsModal.tsx` — 1 each',
    'The tips keep the prompt number and the first lines of text, and they follow the theme bridge colours.',
    'Turning on **keep cache alive** for long-lived tabs avoids the re-write; the hub shows how long the cache has left.',
    'The countdown resets on every real turn, so an active session never pays for a keep-alive it did not need.',
    '```md\n### Added\n- **Keep cache alive** — opt-in per tab; re-arms the 1 h prompt cache before it expires.\n```',
    'The parity script reports 11 identical files and 32 with only the expected localisation differences.',
  ];
  const items = [];
  P.forEach((p, i) => {
    items.push({ kind: 'user', id: 'h' + i, text: p, ts: t0 + i * 7 * 60e3 });
    items.push({ kind: 'tool', id: 'ht' + i, name: i % 2 ? 'Grep' : 'Read', input: i % 2 ? { pattern: 't\\(' } : { file_path: 'D:\\Tootega\\Source\\Cockpit\\Cockpit\\webview\\src\\App.tsx' }, result: 'ok', ts: t0 + i * 7 * 60e3 + 9000 });
    items.push({ kind: 'assistant', id: 'ha' + i, text: A[i] + '\n\n' + B[i], thinking: '' });
  });
  window.__PRELOAD__ = items;
}

window.__QUESTIONS__ = [
  { header: 'Target', question: 'Which layer should the new tests cover first?', multiSelect: false, options: [
    { label: 'Webview components', description: 'Timeline, Composer and the modals, rendered with React.' },
    { label: 'Host session', description: 'Session.ts: the stream-json parser and the control protocol.' },
    { label: 'Both', description: 'One suite per side, sharing the event fixtures.' } ] },
  { header: 'Framework', question: 'Which test runner?', multiSelect: false, options: [
    { label: 'vitest', description: 'Already in the repo; fast, ESM-native.' },
    { label: 'Playwright', description: 'Real browser, slower; best for the webview.' } ] },
  { header: 'Coverage', question: 'Which UI areas should be covered?', multiSelect: true, options: [
    { label: 'Chat / streaming', description: 'Token-by-token render, thinking blocks, tool timeline.' },
    { label: 'Diff / permissions', description: 'Inline diff, accept / reject, permission approval.' },
    { label: 'Stats / usage', description: 'Context meter, cache, cost, subscription limits.' },
    { label: 'i18n', description: 'pt-BR + en, runtime switching, VS Code locale.' } ] },
  { header: 'Depth', question: 'How deep should each test go?', multiSelect: false, options: [
    { label: 'Smoke', description: 'Renders and does not throw.' },
    { label: 'Behaviour', description: 'Clicks, keyboard, state transitions.' },
    { label: 'Pixel', description: 'Screenshot comparison against a baseline.' } ] },
];
