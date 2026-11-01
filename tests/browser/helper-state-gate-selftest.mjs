// TEETH FOR THE HELPER SECOND-ORDER STATE COMPARATOR.
//
// A comparator is only worth its green if it can go red on the claim it names. This program takes the LEG REPORTS
// the two subjects just produced, applies one mutation at a time to a deep copy, and requires the comparator to go
// RED **by a named guard**. A mutation that survives is reported as DECORATION and exits non-zero (AGENTS.md
// differential doctrine 4: a gate's teeth are demonstrated, not reasoned about).
//
// It runs AFTER the legs because the expected values must be the subjects' own observations, not a comparator
// author's idea of what the frontend should do. The five mutations mirror the mission's required teeth:
//   1. a variable that reads back but is NOT on disk              -> scopePersistence
//   2. an injected prompt dropped from the provider request       -> generationCarriesScopes
//   3. a lifecycle event reordered                               -> eventsOrdered
//   4. the preset mutation missing from the NEXT request          -> presetMutationReachesNextRequest
//   5. the two subjects' request bytes diverging                  -> nodeEqualsGo
//
// Usage: node tests/browser/helper-state-gate-selftest.mjs <gotavern-on.json> <pinned-on.json>

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { compareLegs } from './compare-helper-state-legs.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const args = process.argv.slice(2).filter(entry => entry !== '--json');
if (args.length !== 2) {
    console.error('usage: node helper-state-gate-selftest.mjs <gotavern-on.json> <pinned-on.json>');
    process.exit(2);
}
const live = {
    gotavern: JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8')),
    pinned: JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8')),
};

const cases = [];
const record = (name, ok, detail) => {
    cases.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -- ${JSON.stringify(detail).slice(0, 700)}`}`);
};

const compare = ({ gotavern = clone(live.gotavern), pinned = clone(live.pinned) } = {}) => compareLegs({ onGotavern: gotavern, onPinned: pinned });

// THE BASELINE MUST BE GREEN. A mutation suite run against a red baseline proves nothing about the mutation: the
// guard could already be red for the unrelated reason.
const baseline = compare();
record('the live pair the legs produced is PASS', baseline.verdict === 'PASS', baseline.failedGuards);
if (baseline.verdict !== 'PASS') {
    console.error('[selftest] refusing to demonstrate teeth on a pair the comparator already rejects; fix the legs first');
    process.exit(1);
}

// 1. A VARIABLE THAT IS ABSENT FROM DISK: the in-page readback stays green, only the persisted projection changes.
const m1 = compare({ gotavern: (() => {
    const report = clone(live.gotavern);
    report.phases.diskCardPreset.value.cardA.variables = null;
    return report;
})() });
record('THE-VARIABLE-IS-NOT-ON-DISK goes RED by scopePersistence',
    m1.verdict === 'FAIL' && m1.failedGuards.includes('scopePersistence'), m1.failedGuards);

// 2. AN INJECTED PROMPT DROPPED FROM THE REQUEST: the scope readbacks still green; the wire loses the clause.
const m2 = compare({ gotavern: (() => {
    const report = clone(live.gotavern);
    const marker = `${report.markers.character}${report.nonce}`;
    report.phases.write.done.injected = report.phases.write.done.injected.map(clause => String(clause).replace(marker, 'DROPPED'));
    for (const phase of ['write', 'readReload']) {
        const holder = phase === 'write' ? report.phases.write : report.phases.readReload.readReload;
        holder.requests = holder.requests.map(entry => ({ ...entry, body: String(entry.body).split(marker).join('DROPPED'), sha256: `dropped-${entry.sha256}` }));
    }
    return report;
})() });
record('THE-INJECTED-PROMPT-IS-DROPPED-FROM-THE-REQUEST goes RED by generationCarriesScopes',
    m2.verdict === 'FAIL' && m2.failedGuards.includes('generationCarriesScopes'), m2.failedGuards);

// 3. AN EVENT REORDERED: generation_ended before generation_started.
const m3 = compare({ gotavern: (() => {
    const report = clone(live.gotavern);
    const events = report.phases.events.done.eventsAtEnd;
    // THE FAMILY IS READ FROM THE CAPTURE, not assumed: a silent helper generation emits the iframe
    // js_generation_* events rather than the host generation_* names.
    const started = events.findIndex(entry => entry.type === 'generation_started' || entry.type === 'js_generation_started');
    const ended = events.findIndex(entry => entry.type === 'generation_ended' || entry.type === 'js_generation_ended');
    if (started < 0 || ended < 0) throw new Error('the live capture carries no generation start/end pair to reorder');
    const copy = events.slice();
    [copy[started], copy[ended]] = [copy[ended], copy[started]];
    report.phases.events.done.eventsAtEnd = copy;
    return report;
})() });
record('THE-EVENT-IS-REORDERED goes RED by eventsOrdered',
    m3.verdict === 'FAIL' && m3.failedGuards.includes('eventsOrdered'), m3.failedGuards);

// 4. THE PRESET MUTATION MISSING FROM THE NEXT REQUEST: strip the marker from the mutated capture only.
const m4 = compare({ gotavern: (() => {
    const report = clone(live.gotavern);
    const marker = `${report.markers.mutation}${report.nonce}`;
    const entry = report.phases.mutate.requests.find(item => item.case === 'hs-b1-mutated');
    entry.body = String(entry.body).split(marker).join('REMOVED');
    entry.sha256 = `mutated-without-marker-${entry.body.length}`;
    return report;
})() });
record('THE-PRESET-MUTATION-IS-MISSING-FROM-THE-NEXT-REQUEST goes RED by presetMutationReachesNextRequest',
    m4.verdict === 'FAIL' && m4.failedGuards.includes('presetMutationReachesNextRequest'), m4.failedGuards);

// 5. THE TWO SUBJECTS' BYTES DIVERGE on one case.
const m5 = compare({ pinned: (() => {
    const report = clone(live.pinned);
    const entry = report.phases.write.requests.find(item => item.case === 'hs-write');
    entry.sha256 = 'a-different-body';
    return report;
})() });
record('THE-TWO-SUBJECTS-BYTE-DIFFER goes RED by nodeEqualsGo',
    m5.verdict === 'FAIL' && m5.failedGuards.includes('nodeEqualsGo'), m5.failedGuards);

const failed = cases.filter(entry => entry.ok !== true);
console.log(`[selftest] ${cases.length - failed.length}/${cases.length} case(s) behaved as required`);
if (failed.length > 0) {
    console.error(`[selftest] DECORATION: ${failed.map(entry => entry.name).join(', ')}`);
    process.exit(1);
}
