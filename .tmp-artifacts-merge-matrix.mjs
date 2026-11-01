import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
const ref = (r) => JSON.parse(execFileSync('git', ['show', `${r}:docs/compatibility-matrix.json`], { encoding: 'utf8' }));
const base = ref('550fcc1');
const head = ref(':2');
const lane = ref(':3');
const byId = (j) => Object.fromEntries(j.rows.map((row) => [row.id, row]));
const b = byId(base), h = byId(head), l = byId(lane);
const laneChangedOnly = [];
for (const id of Object.keys(h)) {
  const changedByHead = JSON.stringify(h[id]) !== JSON.stringify(b[id]);
  const changedByLane = JSON.stringify(l[id]) !== JSON.stringify(b[id]);
  if (changedByLane && !changedByHead) laneChangedOnly.push(id);
}
const union = (left, right) => { const out = [...(left ?? [])]; for (const item of right ?? []) { if (!out.some((existing) => JSON.stringify(existing) === JSON.stringify(item))) out.push(item); } return out; };
const merged = structuredClone(head);
merged.rows = merged.rows.map((row) => {
  if (laneChangedOnly.includes(row.id)) return structuredClone(l[row.id]);
  if (row.id === 'groups') {
    const lr = l.groups;
    return { ...row, evidence: { ...row.evidence, oracleFixtures: union(row.evidence.oracleFixtures, lr.evidence.oracleFixtures), tests: union(row.evidence.tests, lr.evidence.tests), browserArtifacts: union(row.evidence.browserArtifacts, lr.evidence.browserArtifacts), ci: union(row.evidence.ci, lr.evidence.ci) } };
  }
  if (row.id === 'startup') {
    const lr = l.startup;
    const gap = [...(row.evidenceGap ?? [])];
    for (const item of lr.evidenceGap ?? []) if (!gap.some((existing) => existing.slice(0, 80) === item.slice(0, 80))) gap.push(item);
    return { ...row, evidence: { ...row.evidence, tests: union(row.evidence.tests, lr.evidence.tests), ci: union(row.evidence.ci, lr.evidence.ci) }, evidenceGap: gap };
  }
  return row;
});
// gaps: only HEAD changed them; keep HEAD's.
merged.gaps = head.gaps;
const serialised = `${JSON.stringify(merged, null, 2)}\n`;
writeFileSync('docs/compatibility-matrix.json', serialised);
console.log('merged rows; lane-only rows:', laneChangedOnly.join(', '));
