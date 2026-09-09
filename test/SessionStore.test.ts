// Regression: encodeCwd must match the folder names the Claude Code CLI actually
// creates under ~/.claude/projects. The original bug: a cwd with a SPACE
// (`F:\Estudo Cobol`) encoded to a path that never existed, so listSessions
// returned [] and every live tab showed "0 msgs".
import { describe, it, expect } from 'vitest';
import { encodeCwd } from '../src/session/SessionStore';

describe('encodeCwd — matches the CLI folder format', () => {
  it('replaces every non-alphanumeric char with a single "-"', () => {
    // Two specials in a row -> two dashes (not merged), matching real folders
    // like `D--Tootega-Source-TootegaERP--run-...`.
    expect(encodeCwd('D:\\Tootega\\Source\\Cockpit')).toBe('D--Tootega-Source-Cockpit');
  });

  it('encodes spaces in the path (the reported bug)', () => {
    // Real folder on disk: f--Estudo-Cobol (casing of the rest is preserved).
    expect(encodeCwd('f:\\Estudo Cobol')).toBe('f--Estudo-Cobol');
    expect(encodeCwd('F:\\Estudo Cobol')).toBe('F--Estudo-Cobol');
  });

  it('preserves the casing of the path (does not lowercase CrediSIS/Cockpit)', () => {
    expect(encodeCwd('d:\\CrediSIS\\Source\\ERP')).toBe('d--CrediSIS-Source-ERP');
  });

  it('collapses accents/parentheses/dots too (anything Windows allows)', () => {
    expect(encodeCwd('C:\\Proj (v2)\\São Paulo.bak')).toBe('C--Proj--v2--S-o-Paulo-bak');
  });

  it('keeps digits', () => {
    expect(encodeCwd('d:\\Tootega\\Source\\DASE50')).toBe('d--Tootega-Source-DASE50');
  });
});
