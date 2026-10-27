import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DroppedFile } from '../../shared/protocol';

/**
 * Saves files dropped on the composer whose path the drag hid, and returns where they went.
 *
 * A file dragged from the OS's explorer reaches the webview as content only: the sandboxed
 * iframe never sees its path, and there is no clipboard to read it back from as paste does.
 * So the content is written to a folder of its own under the temp dir, keeping the original
 * name — that name is what Claude reads first — and the prompt points at the copy.
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
