import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { saveDroppedFiles } from '../src/cli/DroppedFiles';

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
