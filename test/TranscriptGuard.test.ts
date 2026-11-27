// Reopening a session must show the context guard and the compaction the way the live session
// did: banners, not the guard's messages as prompts the user never typed. The lines below
// mirror a real CLI transcript (2.1.3xx) — the guard's save request as a user line, the
// compact_boundary with its metadata, the compact summary, the /compact wrapper, the resume
// request, and a mid-turn save request recorded as a queued_command attachment.
import { describe, it, expect } from 'vitest';
import { parseTranscript } from '../src/session/SessionStore';
import { savePrompt, RESUME_PROMPT, retryPrompt } from '../src/session/ContextGuard';

const user = (uuid: string, text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'user', uuid, timestamp: '2026-11-26T01:50:42.148Z', message: { role: 'user', content: text }, ...extra });
const assistant = (id: string, text: string) =>
  JSON.stringify({ type: 'assistant', uuid: `u-${id}`, message: { id, role: 'assistant', content: [{ type: 'text', text }] } });
const boundary = (uuid: string) =>
  JSON.stringify({
    type: 'system',
    subtype: 'compact_boundary',
    uuid,
    timestamp: '2026-11-26T01:52:14.982Z',
    content: 'Conversation compacted',
    compactMetadata: { trigger: 'manual', preTokens: 804640, postTokens: 17492, durationMs: 65127 },
  });
const queued = (uuid: string, text: string) =>
  JSON.stringify({ type: 'attachment', uuid, attachment: { type: 'queued_command', prompt: [{ type: 'text', text }] } });

describe('parseTranscript: context guard and compaction', () => {
  it('a guard run that compacted becomes one guard banner plus the compaction banner — no prompts', () => {
    const items = parseTranscript(
      [
        user('p1', 'do the task'),
        assistant('a1', 'working'),
        user('g1', savePrompt(80, 80, '109cc5b4')),
        assistant('a2', 'saved\nCOCKPIT-CONTEXT-SAVED 109cc5b4'),
        boundary('b1'),
        user('s1', 'This session is being continued from a previous conversation…', { isCompactSummary: true, isVisibleInTranscriptOnly: true }),
        user('c1', '<command-name>/compact</command-name>'),
        user('o1', '<local-command-stdout>Compacted </local-command-stdout>'),
        user('r1', RESUME_PROMPT),
        assistant('a3', 'resuming'),
      ].join('\n'),
    );
    expect(items.filter((i) => i.kind === 'user').map((i) => (i as { text: string }).text)).toEqual(['do the task']);
    const notices = items.filter((i) => i.kind === 'notice') as Extract<(typeof items)[number], { kind: 'notice' }>[];
    expect(notices).toHaveLength(2);
    expect(notices[0].guard).toEqual({ phase: 'done', pct: 80, threshold: 80, pre: 804640, post: 17492, resumed: true });
    expect(notices[1].topic).toBe('compact_boundary');
    expect(notices[1].compaction).toEqual({ pre: 804640, post: 17492, trigger: 'manual', durationMs: 65127 });
    // Order matches the live timeline: request banner, the saving reply, then the boundary.
    expect(items.map((i) => i.kind)).toEqual(['user', 'assistant', 'notice', 'assistant', 'notice', 'assistant']);
  });

  it('a mid-turn save request (queued_command) opens the run; a quoted guard text in a tool result does not', () => {
    const toolUse = JSON.stringify({
      type: 'assistant',
      uuid: 'u-t',
      message: { id: 'a1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: {} }] },
    });
    const toolResult = JSON.stringify({
      type: 'user',
      uuid: 'tr',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: `log: ${savePrompt(90, 80, 'zzzz')}` }] },
    });
    const items = parseTranscript([toolUse, toolResult, queued('q1', savePrompt(83, 80, 'abcd1234'))].join('\n'));
    const notices = items.filter((i) => i.kind === 'notice') as Extract<(typeof items)[number], { kind: 'notice' }>[];
    expect(notices).toHaveLength(1);
    // Nothing compacted after it: it ended without a compaction, not "still saving" forever.
    expect(notices[0].guard).toMatchObject({ phase: 'failed', pct: 83, threshold: 80, reason: 'no-compaction' });
  });

  it('the retry request is not a prompt either, and the same request recorded twice is one banner', () => {
    const save = savePrompt(80, 80, 'n1');
    const items = parseTranscript([user('g1', save), queued('q1', save), user('g2', retryPrompt('n1')), boundary('b1')].join('\n'));
    expect(items.some((i) => i.kind === 'user')).toBe(false);
    expect(items.filter((i) => i.kind === 'notice' && i.guard)).toHaveLength(1);
  });

  it('a compaction the user ran by hand is a compaction banner with no guard banner', () => {
    const items = parseTranscript([user('p1', 'hi'), boundary('b1'), user('c1', '<command-name>/compact</command-name>')].join('\n'));
    expect(items.map((i) => (i.kind === 'notice' ? i.topic : i.kind))).toEqual(['user', 'compact_boundary']);
  });
});
