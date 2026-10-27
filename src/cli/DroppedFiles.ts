import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DroppedFile } from '../../shared/protocol';

/**
 * Turns files dropped on the composer whose path the drag hid into paths for the prompt.
 *
 * A file dragged from the OS's explorer reaches the webview as content only: the sandboxed
 * iframe never sees its path. But the drag left a trace outside the page — the file is
 * still selected in the Explorer window it came from. So each dropped file is looked up
 * there first (same name, and same bytes when the content came along), and only a file
 * that cannot be found is written to a folder of its own under the temp dir, keeping the
 * original name, for the prompt to point at the copy.
 */
export function resolveDroppedFiles(
  files: DroppedFile[],
  candidates: string[] = explorerSelection(),
  root = path.join(os.tmpdir(), 'cockpit-drops'),
): string[] {
  const real = files.map((f) => matchDropped(f, candidates));
  const copies = saveDroppedFiles(files.filter((_, i) => !real[i]), root);
  let next = 0;
  const out: string[] = [];
  for (let i = 0; i < files.length; i++) {
    const p = real[i] ?? (files[i].data ? copies[next++] : undefined);
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The candidate that is this file: same name and, when the content came along, same bytes. */
export function matchDropped(f: DroppedFile, candidates: string[]): string | undefined {
  const name = f.name.toLowerCase();
  const data = f.data ? Buffer.from(f.data, 'base64') : undefined;
  for (const c of candidates) {
    if (path.basename(c).toLowerCase() !== name) continue;
    try {
      const st = fs.statSync(c);
      if (!st.isFile()) continue;
      if (data && (st.size !== data.length || !fs.readFileSync(c).equals(data))) continue;
      return c;
    } catch {
      // gone or unreadable: not this one
    }
  }
  return undefined;
}

/** What is selected in the open Explorer windows (Windows only; elsewhere, nothing). */
function explorerSelection(): string[] {
  if (process.platform !== 'win32') return [];
  try {
    const res = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        // Forces UTF-8 on the output (avoids accent corruption from the code page).
        '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
          '$s = New-Object -ComObject Shell.Application; ' +
          'foreach ($w in $s.Windows()) { try { foreach ($i in $w.Document.SelectedItems()) { $i.Path } } catch {} }',
      ],
      { encoding: 'utf8', timeout: 5000, windowsHide: true },
    );
    if (res.status !== 0) return [];
    return (res.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim().normalize('NFC'))
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Saves dropped files that could not be found on disk, and returns where they went. The
 * content goes to a folder of its own under the temp dir, keeping the original name — that
 * name is what Claude reads first — and the prompt points at the copy.
 */
export function saveDroppedFiles(files: DroppedFile[], root = path.join(os.tmpdir(), 'cockpit-drops')): string[] {
  const dir = path.join(root, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const out: string[] = [];
  for (const f of files) {
    if (!f.data) continue; // too large to send: nothing to copy
    const name = path.basename(f.name || '').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') || 'dropped';
    let target = path.join(dir, name);
    // Two files of the same name in one drop: the second gets a suffix, not the first's content.
    for (let i = 2; out.includes(target); i++) {
      const ext = path.extname(name);
      target = path.join(dir, `${path.basename(name, ext)} (${i})${ext}`);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(target, Buffer.from(f.data, 'base64'));
    out.push(target);
  }
  return out;
}
