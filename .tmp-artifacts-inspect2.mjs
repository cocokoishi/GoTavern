import { execFileSync } from 'node:child_process';
const read = (ref) => JSON.parse(execFileSync('git', ['show', `${ref}:docs/compatibility-matrix.json`], { encoding: 'utf8' }));
const head = Object.fromEntries(read(':2').rows.map(r => [r.id, r]));
const lane = Object.fromEntries(read(':3').rows.map(r => [r.id, r]));
for (const id of ['groups', 'startup']) {
  const h = head[id], l = lane[id];
  console.log('===', id, '===');
  for (const k of new Set([...Object.keys(h.evidence ?? {}), ...Object.keys(l.evidence ?? {})])) {
    const hs = JSON.stringify(h.evidence?.[k]); const ls = JSON.stringify(l.evidence?.[k]);
    if (hs !== ls) console.log(' evidence.' + k, '\n  head=', (hs ?? '').slice(0, 400), '\n  lane=', (ls ?? '').slice(0, 400));
  }
  for (const k of ['evidenceGap', 'notes', 'status', 'wouldGoRedIfWrong']) {
    const hs = JSON.stringify(h[k]); const ls = JSON.stringify(l[k]);
    if (hs !== ls) console.log(' ' + k, '\n  head=', (hs ?? '').slice(0, 600), '\n  lane=', (ls ?? '').slice(0, 600));
  }
}
