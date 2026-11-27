import { describe, it, expect } from 'vitest';
import { reducer, initialState } from '../webview/src/store';
import type { HostToWebview } from '../shared/protocol';

const host = (msg: unknown) => ({ type: 'host', msg: msg as HostToWebview }) as Parameters<typeof reducer>[1];
const tabs = (sessionId?: string) => host({ kind: 'tabs', tabs: [{ id: 't1', title: '', status: 'busy', sessionId }], activeTab: 't1' });

// The loader stays up while a tab has a sessionId and no 'history' yet. These pin which
// tabs wait for history and which already hold their timeline.
describe('store: history loading', () => {
  it('a tab first seen with a sessionId waits for its history', () => {
    const s = reducer(initialState, tabs('abc'));
    expect(s.tabs[0].historyLoaded).toBeFalsy();
  });

  it('a live conversation that gets its sessionId afterwards does not fall back to the loader', () => {
    let s = reducer(initialState, tabs(undefined));
    s = reducer(s, host({ kind: 'assistantStart', id: 'a1', tab: 't1' }));
    s = reducer(s, host({ kind: 'assistantText', id: 'a1', delta: 'hello', tab: 't1' }));
    s = reducer(s, tabs('abc'));
    expect(s.tabs[0].historyLoaded).toBe(true);
    expect(s.tabs[0].items).toHaveLength(1);
  });

  it('an empty tab that gets a sessionId (resume) still waits for the history', () => {
    let s = reducer(initialState, tabs(undefined));
    s = reducer(s, tabs('abc'));
    expect(s.tabs[0].historyLoaded).toBeFalsy();
  });
});
