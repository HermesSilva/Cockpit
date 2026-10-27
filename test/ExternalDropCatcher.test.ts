import { describe, it, expect } from 'vitest';
import { freshEntries } from '../src/panel/ExternalDropCatcher';

// What a drop from the OS adds to VS Code's recently-opened list is what tells it apart from an
// open from the Explorer, which adds nothing.
describe('freshEntries — files a drop just put on top of the recents', () => {
  it('takes what was added above the old top', () => {
    expect([...freshEntries(['a', 'b'], ['x', 'y', 'a', 'b'])]).toEqual(['x', 'y']);
  });

  it('takes a file that was already in the list and moved up', () => {
    expect([...freshEntries(['a', 'b', 'c'], ['c', 'a', 'b'])]).toEqual(['c']);
  });

  it('sees nothing new when the list only lost an entry', () => {
    expect(freshEntries(['a', 'b', 'c'], ['a', 'c']).size).toBe(0);
  });

  it('sees nothing new when nothing changed (an Explorer open)', () => {
    expect(freshEntries(['a', 'b'], ['a', 'b']).size).toBe(0);
  });

  it('falls back to new entries when the old top is gone', () => {
    expect([...freshEntries(['a', 'b'], ['x', 'b'])]).toEqual(['x']);
    expect([...freshEntries([], ['x'])]).toEqual(['x']);
  });
});
