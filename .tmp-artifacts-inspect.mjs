import { execFileSync } from 'node:child_process';
const read = (ref) => JSON.parse(execFileSync('git', ['show', `${ref}:docs/compatibility-matrix.json`], { encoding: 'utf8' }));
const base = read('550fcc1'); const head = read(':2'); const lane = read(':3');
const rows = (j) => Object.fromEntries(j.rows.map(r => [r.id, r]));
const gaps = (j) => Object.fromEntries(j.gaps.map(g => [g.row, g]));
const b = rows(base), h = rows(head), l = rows(lane);
for (const id of new Set([...Object.keys(b), ...Object.keys(h), ...Object.keys(l)])) {
  const bs = JSON.stringify(b[id]), hs = JSON.stringify(h[id]), ls = JSON.stringify(l[id]);
  if (bs !== hs || bs !== ls) console.log('ROW', id, 'headChg=' + (bs!==hs), 'laneChg=' + (bs!==ls));
}
const bg = gaps(base), hg = gaps(head), lg = gaps(lane);
for (const id of new Set([...Object.keys(bg), ...Object.keys(hg), ...Object.keys(lg)])) {
  const bs = JSON.stringify(bg[id]), hs = JSON.stringify(hg[id]), ls = JSON.stringify(lg[id]);
  if (bs !== hs || bs !== ls) console.log('GAP', id, 'headChg=' + (bs!==hs), 'laneChg=' + (bs!==ls));
}
