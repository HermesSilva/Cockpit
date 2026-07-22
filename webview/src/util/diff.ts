// Line diff (LCS) for the side-by-side view. No dependencies.

export type DiffRow = {
  type: 'equal' | 'add' | 'del' | 'change';
  left?: { num: number; text: string };
  right?: { num: number; text: string };
};

export interface DiffResult {
  rows: DiffRow[];
  added: number;
  removed: number;
  truncated: boolean;
}

const MAX_CELLS = 400_000; // DP limit (n*m) to avoid freezing on huge files

export function sideBySideDiff(oldText: string, newText: string): DiffResult {
  const a = oldText.length ? oldText.split('\n') : [];
  const b = newText.length ? newText.split('\n') : [];
  const n = a.length;
  const m = b.length;

  // Large file: skips the LCS and shows a block removal + block addition.
  if (n * m > MAX_CELLS) {
    const rows: DiffRow[] = [];
    for (let i = 0; i < n; i++) rows.push({ type: 'del', left: { num: i + 1, text: a[i] } });
    for (let j = 0; j < m; j++) rows.push({ type: 'add', right: { num: j + 1, text: b[j] } });
    return { rows, added: m, removed: n, truncated: true };
  }

  // LCS via dynamic programming.
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  type Op = { t: 'eq' | 'del' | 'add'; ai?: number; bi?: number };
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: 'eq', ai: i, bi: j });
      i++;
      j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ t: 'del', ai: i });
      i++;
    } else {
      ops.push({ t: 'add', bi: j });
      j++;
    }
  }
  while (i < n) ops.push({ t: 'del', ai: i++ });
  while (j < m) ops.push({ t: 'add', bi: j++ });

  // Builds the rows: pairs adjacent del+add runs as a "change".
  const rows: DiffRow[] = [];
  let added = 0;
  let removed = 0;
  let k = 0;
  while (k < ops.length) {
    if (ops[k].t === 'eq') {
      const o = ops[k++];
      rows.push({
        type: 'equal',
        left: { num: o.ai! + 1, text: a[o.ai!] },
        right: { num: o.bi! + 1, text: b[o.bi!] },
      });
      continue;
    }
    const dels: number[] = [];
    const adds: number[] = [];
    while (k < ops.length && ops[k].t === 'del') dels.push(ops[k++].ai!);
    while (k < ops.length && ops[k].t === 'add') adds.push(ops[k++].bi!);
    removed += dels.length;
    added += adds.length;
    const max = Math.max(dels.length, adds.length);
    for (let x = 0; x < max; x++) {
      const d = dels[x];
      const ad = adds[x];
      if (d !== undefined && ad !== undefined) {
        rows.push({
          type: 'change',
          left: { num: d + 1, text: a[d] },
          right: { num: ad + 1, text: b[ad] },
        });
      } else if (d !== undefined) {
        rows.push({ type: 'del', left: { num: d + 1, text: a[d] } });
      } else {
        rows.push({ type: 'add', right: { num: ad + 1, text: b[ad] } });
      }
    }
  }
  return { rows, added, removed, truncated: false };
}
