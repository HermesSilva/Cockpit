import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolveDroppedFiles, saveDroppedFiles } from '../src/cli/DroppedFiles';

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
let root = '';

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
});

describe('saveDroppedFiles — files dropped from the OS explorer', () => {
  it('writes each file under its own name and returns the paths', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-test-'));
    const out = saveDroppedFiles([{ name: 'relatório.txt', data: b64('olá') }], root);
    expect(out).toHaveLength(1);
    expect(path.basename(out[0])).toBe('relatório.txt');
    expect(fs.readFileSync(out[0], 'utf8')).toBe('olá');
  });

  it('skips a file sent without content and keeps two of the same name apart', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-test-'));
    const out = saveDroppedFiles(
      [{ name: 'a.txt', data: b64('1') }, { name: 'big.bin' }, { name: 'a.txt', data: b64('2') }],
      root,
    );
    expect(out.map((p) => path.basename(p))).toEqual(['a.txt', 'a (2).txt']);
    expect(fs.readFileSync(out[1], 'utf8')).toBe('2');
  });

  it('never escapes its folder through the name', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-test-'));
    const [p] = saveDroppedFiles([{ name: '..\\..\\evil.txt', data: b64('x') }], root);
    expect(p.startsWith(root)).toBe(true);
  });
});

describe('resolveDroppedFiles — the real path when the Explorer selection has it', () => {
  it('points at the selected file itself instead of a copy', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-test-'));
    const real = path.join(root, 'Prêmios - Correções.md');
    fs.writeFileSync(real, 'olá');
    const out = resolveDroppedFiles([{ name: 'Prêmios - Correções.md', data: b64('olá') }], [real], path.join(root, 'copies'));
    expect(out).toEqual([real]);
    expect(fs.existsSync(path.join(root, 'copies'))).toBe(false);
  });

  it('copies a file whose namesake on disk has other content, and keeps the drop order', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-test-'));
    const a = path.join(root, 'a.txt');
    const b = path.join(root, 'b.txt');
    fs.writeFileSync(a, 'A');
    fs.writeFileSync(b, 'other');
    const out = resolveDroppedFiles(
      [{ name: 'b.txt', data: b64('B') }, { name: 'a.txt', data: b64('A') }],
      [a, b],
      path.join(root, 'copies'),
    );
    expect(out[0].startsWith(path.join(root, 'copies'))).toBe(true);
    expect(fs.readFileSync(out[0], 'utf8')).toBe('B');
    expect(out[1]).toBe(a);
  });

  it('takes a file too large to send by its name in the selection', () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'drop-test-'));
    const big = path.join(root, 'big.bin');
    fs.writeFileSync(big, 'x');
    expect(resolveDroppedFiles([{ name: 'big.bin' }], [big], path.join(root, 'copies'))).toEqual([big]);
  });
});
