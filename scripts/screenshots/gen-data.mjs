// Pulls REAL content from the Cockpit repo (the commit that fixed the HTML export) so the
// staged session shows genuine files, diffs and output. Writes data.js for host.js.
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const repo = process.argv[2];
const out = process.argv[3];
// The HTML-export fix (31/10/2026): the session in the captures is that real bug and its real fix.
const BEFORE = '22ab648';
const AFTER = '4c1cb5d';
const git = (a) => execSync(`git -C "${repo}" ${a}`, { encoding: 'utf8', maxBuffer: 1 << 26 });
const before = git(`show ${BEFORE}:webview/src/App.tsx`).split('\n');
// cat -n style, as the CLI's Read returns it
const catN = (lines, from, to) =>
  lines
    .slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(6)}\t${l}`)
    .join('\n');
const start = before.findIndex((l) => l.includes("const docTitle = title?.trim()")) + 1;
const readApp = catN(before, start, start + 38);
const noComments = (a) => a.filter((l) => !/^\s*\/\//.test(l));
const oldBlock = noComments(before.slice(start + 4, start + 38)).join('\n');
const after = git(`show ${AFTER}:webview/src/App.tsx`).split('\n');
const s2 = after.findIndex((l) => l.includes("const docTitle = title?.trim()")) + 1;
const nb = noComments(after.slice(s2, s2 + 20));
const newBlock = nb.slice(0, nb.findIndex((l) => l.trim() === '})();') + 1).join('\n');
const grep = git(`grep -n "buildTimelineHtml" ${BEFORE} -- webview/src`)
  .split('\n')
  .filter(Boolean)
  .map((l) => l.slice(l.indexOf(':') + 1))
  .join('\n');
const exportHead = git(`show ${AFTER}:webview/src/util/exportHtml.ts`).split('\n').slice(108, 140);
const data = {
  readApp,
  readAppStart: start,
  oldBlock,
  newBlock,
  grep,
  exportFn: exportHead.join('\n'),
  stat: git(`show --stat --format= ${AFTER}`).trim(),
};
writeFileSync(out, 'window.__DATA__ = ' + JSON.stringify(data) + ';\n', 'utf8');
console.log('start', start, 'grep lines', grep.split('\n').length);
