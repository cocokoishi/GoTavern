// Does the Q17 surface check have teeth? Mutate the committed artefact one way at a time and require a
// FAILING FINDING that names the thing broken. A verifier that accepts any well-formed JSON is decoration.
//
// RESOLVED FROM THIS FILE'S OWN URL, so the check runs from any working directory and survives being moved:
// a relative import broke the moment this file was promoted out of the repository root, which is the same
// class of defect as a probe that only works from one cwd.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const { authorsNoteSurface } = await import(pathToFileURL(path.join(here, 'browser-evidence', 'other-surfaces.mjs')).href);

const artefactPath = path.join(repoRoot, 'tests', 'browser', 'authors-note-comparison.json');
const artefact = JSON.parse(readFileSync(artefactPath, 'utf8'));
const clone = value => JSON.parse(JSON.stringify(value));
const run = (mutate) => {
    const copy = clone(artefact);
    mutate(copy);
    const ctx = { findings: [], observations: [], fail(message) { this.findings.push(message); }, observe(message) { this.observations.push(message); } };
    authorsNoteSurface(ctx, copy);
    return ctx.findings;
};
let bad = 0;
const check = (name, findings, expect) => {
    const hit = findings.some(finding => expect.test(finding));
    if (!hit) bad += 1;
    console.log(`${hit ? 'caught' : 'MISSED'} ${name}`);
    if (!hit) for (const finding of findings) console.log(`        got: ${finding}`);
};

// baseline: the committed artefact must pass
if (run(() => {}).length !== 0) { bad += 1; console.log('MISSED baseline: the committed artefact already fails'); }
else console.log('caught baseline is clean');

check('verdict flipped to PRODUCT_MISMATCH', run(a => { a.verdict = 'PRODUCT_MISMATCH'; }), /verdict is "PRODUCT_MISMATCH"/);
check('measuredBy changed to hand-derived', run(a => { a.measuredBy = 'hand-derived'; }), /measuredBy is "hand-derived"/);
check('one case flipped to red', run(a => { a.cases[0].verdict = 'PRODUCT_MISMATCH'; }), /case .* is "PRODUCT_MISMATCH"/);
check('byte equality claim removed from a PASS', run(a => { a.cases[0].checks.bodySha256Equal = false; }), /bodySha256Equal is false/);
check('a required case removed (depth0)', run(a => { a.cases = a.cases.filter(c => c.caseId !== 'depth0'); }), /case depth0 is absent/);
check('the disabled case removed', run(a => { a.cases = a.cases.filter(c => c.case?.enabled !== false); }), /disabled switch was not driven/);
check('notMeasured dropped', run(a => { delete a.notMeasured; }), /notMeasured is absent/);
check('pastHistoryInsideBudget dropped', run(a => { delete a.depthCoverage.pastHistoryInsideBudget; }), /pastHistoryInsideBudget is absent/);
check('the truncation rule removed', run(a => { delete a.depthCoverage.pastBudgetOutOfScope.rule; }), /truncation fact rather than a depth fact/);
check('the sweep stops discriminating', run(a => { a.sweep.theCapturesDiffer = false; }), /theCapturesDiffer is false/);
check('a PASS case loses its pinned observation', run(a => { delete a.cases[0].details; }), /records no pinned observation/);

console.log(bad === 0 ? '\nOK: every mutation of the artefact is caught by name' : `\n${bad} MISSED`);
process.exit(bad === 0 ? 0 : 1);
