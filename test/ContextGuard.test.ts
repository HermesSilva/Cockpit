import { describe, it, expect, beforeEach } from 'vitest';
import {
  ContextGuard,
  confirms,
  SENTINEL,
  COMPACT_COMMAND,
  RESUME_PROMPT,
  type GuardNotice,
} from '../src/session/ContextGuard';

// The guard's whole contract, against a fake Session. The CLI behaviours it relies on were
// measured with the real CLI (see the header of ContextGuard.ts); here they are simulated.
function harness(enabled = true, threshold = 0.8) {
  const sent: { text: string; newTurn: boolean }[] = [];
  const notices: GuardNotice[] = [];
  let n = 0;
  const g = new ContextGuard(
    {
      send: (text, newTurn) => sent.push({ text, newTurn }),
      notify: (x) => notices.push(x),
      nonce: () => `n${++n}`,
      log: () => {},
    },
    () => ({ enabled, threshold }),
  );
  return { g, sent, notices, last: () => notices[notices.length - 1] };
}
const LIMIT = 1_000_000;
const at = (pct: number) => (pct / 100) * LIMIT;

describe('ContextGuard — sentinel', () => {
  it('accepts only the exact last line with this nonce', () => {
    expect(confirms(`Saved to memory.\n\n${SENTINEL} abc`, 'abc')).toBe(true);
    expect(confirms(`${SENTINEL} abc\n`, 'abc')).toBe(true);
    expect(confirms(`\`${SENTINEL} abc\``, 'abc')).toBe(true); // lone line in backticks
    expect(confirms(`${SENTINEL} abd`, 'abc')).toBe(false); // other nonce
    expect(confirms(`${SENTINEL} abc\nand then I continued`, 'abc')).toBe(false); // not last
    expect(confirms(`ok ${SENTINEL} abc`, 'abc')).toBe(false); // other text on the line
    expect(confirms('', 'abc')).toBe(false);
  });
});

describe('ContextGuard — trigger', () => {
  it('does nothing below the threshold, when disabled, or while the CLI compacts', () => {
    let h = harness();
    h.g.onContext(at(79.9), LIMIT, true);
    expect(h.sent).toHaveLength(0);
    h = harness(false);
    h.g.onContext(at(90), LIMIT, true);
    expect(h.sent).toHaveLength(0);
    h = harness();
    h.g.onContext(at(90), LIMIT, true, true);
    expect(h.sent).toHaveLength(0);
    h.g.onContext(at(90), 0, true); // unknown window
    expect(h.sent).toHaveLength(0);
  });

  it('mid-turn: writes the request into the running turn (no new turn)', () => {
    const h = harness();
    h.g.onContext(at(81), LIMIT, true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0].newTurn).toBe(false);
    expect(h.sent[0].text).toContain(`${SENTINEL} n1`);
    expect(h.sent[0].text).toContain('81%');
    expect(h.last()).toMatchObject({ phase: 'saving', pct: 81, threshold: 80 });
    // further measurements in the same run do not start another one
    h.g.onContext(at(85), LIMIT, true);
    expect(h.sent).toHaveLength(1);
  });

  it('idle: the request opens its own turn', () => {
    const h = harness();
    h.g.onContext(at(83), LIMIT, false);
    expect(h.sent[0].newTurn).toBe(true);
  });
});

describe('ContextGuard — happy path', () => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => {
    h = harness();
    h.g.onContext(at(82), LIMIT, true); // mid-turn
    h.g.onApiCall(); // delivered at the next tool boundary
  });

  it('confirmed -> /compact -> boundary -> resume', () => {
    expect(h.g.onResult(`State saved.\n${SENTINEL} n1`, false)).toBeUndefined();
    expect(h.sent[1]).toEqual({ text: COMPACT_COMMAND, newTurn: true });
    expect(h.last().phase).toBe('compacting');

    h.g.onCompactStatus(true);
    h.g.onCompactBoundary('manual', 820_000, 96_000);
    h.g.onResult('', false); // the /compact turn
    expect(h.last()).toMatchObject({ phase: 'done', pre: 820_000, post: 96_000, resumed: true });
    expect(h.sent[2]).toEqual({ text: RESUME_PROMPT, newTurn: true });
    expect(h.g.active).toBe(false);
  });

  it('does not re-trigger until the fill drops below the threshold', () => {
    h.g.onResult(`${SENTINEL} n1`, false);
    h.g.onCompactBoundary('manual', 820_000, 96_000);
    h.g.onResult('', false);
    const before = h.sent.length;
    h.g.onContext(at(85), LIMIT, true); // stale reading still high
    expect(h.sent).toHaveLength(before);
    h.g.onContext(at(10), LIMIT, true); // after the compaction
    h.g.onContext(at(81), LIMIT, true); // filled again
    expect(h.sent).toHaveLength(before + 1);
    expect(h.sent[before].text).toContain(`${SENTINEL} n2`);
  });

  it('triggered while idle: no resume afterwards', () => {
    const k = harness();
    k.g.onContext(at(82), LIMIT, false);
    k.g.onResult(`${SENTINEL} n1`, false);
    k.g.onCompactBoundary('manual', 800, 100);
    k.g.onResult('', false);
    expect(k.last()).toMatchObject({ phase: 'done', resumed: false });
    expect(k.sent.map((s) => s.text)).not.toContain(RESUME_PROMPT);
  });
});

describe('ContextGuard — the request queued by the CLI', () => {
  it('turn ends with no tool boundary after the write: expect the queued turn, then verify it', () => {
    const h = harness();
    h.g.onContext(at(82), LIMIT, true); // written mid-turn, but the model was already answering
    expect(h.g.onResult('Here is the final answer to the task.', false)).toBe('expect-queued-turn');
    expect(h.sent).toHaveLength(1); // nothing re-sent: the CLI runs it on its own
    expect(h.g.onResult(`${SENTINEL} n1`, false)).toBeUndefined();
    expect(h.sent[1].text).toBe(COMPACT_COMMAND);
  });
});

describe('ContextGuard — never compacts without proof', () => {
  it('missing confirmation: one stricter retry, then fails', () => {
    const h = harness();
    h.g.onContext(at(82), LIMIT, false);
    h.g.onResult('I saved some notes.', false);
    expect(h.last().phase).toBe('retrying');
    expect(h.sent[1].newTurn).toBe(true);
    expect(h.sent[1].text).toContain(`${SENTINEL} n1`); // same nonce
    h.g.onResult('Done!', false);
    expect(h.last()).toMatchObject({ phase: 'failed', reason: 'no-confirmation' });
    expect(h.sent.map((s) => s.text)).not.toContain(COMPACT_COMMAND);
  });

  it('a stale nonce is not a confirmation', () => {
    const h = harness();
    h.g.onContext(at(82), LIMIT, false);
    h.g.onResult(`${SENTINEL} n0`, false);
    expect(h.last().phase).toBe('retrying');
  });

  it('save turn ended with an error', () => {
    const h = harness();
    h.g.onContext(at(82), LIMIT, false);
    h.g.onResult(`${SENTINEL} n1`, true);
    expect(h.last()).toMatchObject({ phase: 'failed', reason: 'turn-error' });
    expect(h.sent).toHaveLength(1);
  });

  it('compaction blocked or failed (result still "success")', () => {
    const h = harness();
    h.g.onContext(at(82), LIMIT, false);
    h.g.onResult(`${SENTINEL} n1`, false);
    h.g.onCompactStatus(false, 'skipped: Compaction blocked by PreCompact hook');
    h.g.onResult('Compaction blocked by PreCompact hook', false);
    expect(h.last()).toMatchObject({ phase: 'failed', reason: 'compact-error' });
    expect(h.last().detail).toContain('PreCompact');
    expect(h.sent.map((s) => s.text)).not.toContain(RESUME_PROMPT);
  });

  it('a /compact turn with no boundary, or one that saved nothing, is not a compaction', () => {
    let h = harness();
    h.g.onContext(at(82), LIMIT, false);
    h.g.onResult(`${SENTINEL} n1`, false);
    h.g.onResult('', false);
    expect(h.last()).toMatchObject({ phase: 'failed', reason: 'no-compaction' });
    h = harness();
    h.g.onContext(at(82), LIMIT, false);
    h.g.onResult(`${SENTINEL} n1`, false);
    h.g.onCompactBoundary('manual', 500, 500);
    h.g.onResult('', false);
    expect(h.last()).toMatchObject({ phase: 'failed', reason: 'no-compaction' });
  });

  it('after a failure it waits for 5 more points before trying again', () => {
    const h = harness();
    h.g.onContext(at(82), LIMIT, false);
    h.g.onResult('nope', false);
    h.g.onResult('nope', false); // failed at 82%
    const n = h.sent.length;
    h.g.onContext(at(86), LIMIT, false);
    expect(h.sent).toHaveLength(n);
    h.g.onContext(at(87.5), LIMIT, false);
    expect(h.sent).toHaveLength(n + 1);
  });
});

describe('ContextGuard — the CLI compacted on its own during the save', () => {
  it('skips the second compaction and still resumes', () => {
    const h = harness();
    h.g.onContext(at(82), LIMIT, true);
    h.g.onApiCall();
    h.g.onCompactBoundary('auto', 900_000, 120_000);
    h.g.onResult(`${SENTINEL} n1`, false);
    expect(h.sent.map((s) => s.text)).not.toContain(COMPACT_COMMAND);
    expect(h.last()).toMatchObject({ phase: 'done', pre: 900_000, post: 120_000, resumed: true });
    expect(h.sent[h.sent.length - 1].text).toBe(RESUME_PROMPT);
  });
});

describe('ContextGuard — cancel', () => {
  it('Stop cancels the run; nothing else is sent', () => {
    const h = harness();
    h.g.onContext(at(82), LIMIT, true);
    h.g.onUserInterrupt();
    expect(h.last()).toMatchObject({ phase: 'canceled', reason: 'interrupted' });
    expect(h.g.active).toBe(false);
    h.g.onResult(`${SENTINEL} n1`, false); // a late result changes nothing
    expect(h.sent).toHaveLength(1);
  });

  it('reset (restart / new conversation) cancels and clears the floors', () => {
    const h = harness();
    h.g.onContext(at(82), LIMIT, false);
    h.g.reset();
    expect(h.last()).toMatchObject({ phase: 'canceled', reason: 'restarted' });
    h.g.onContext(at(82), LIMIT, false);
    expect(h.sent).toHaveLength(2);
  });
});
