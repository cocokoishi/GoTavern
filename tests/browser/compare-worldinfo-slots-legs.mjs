// JUDGE THE WORLD-INFO SLOT ORDER: {gotavern, pinned} over ONE captured turn, per-slot named guards.
//
// WHAT IS COMPARED, AND WHAT IS ONLY MEASURED.
//   - THE PRODUCT CONTRACT IS THE RAW BYTES: bodySha256, byteLength, the method and the raw request target, per case.
//     No canonicalising, no re-marshalling, no dropping of members (differential doctrine 2).
//   - THE SLOT LAYOUT IS A GUARD, NOT A DERIVATION. Each guard cites the pinned source line it rests on
//     (`worldinfo-slots-kit.mjs` F1..F5), so a reader can check the assertion against the pin rather than against this
//     file's opinion. A guard whose fact id is missing makes this comparator REFUSE, because a guard with no oracle is
//     decoration.
//   - WHERE A NUMBER COMES FROM PINNED'S BEHAVIOUR RATHER THAN FROM A FORMULA, THE ASSERTION IS PARITY AND THE NUMBER IS
//     RECORDED. The depth offset is the case that proved this: `fromEnd === DEPTH` was a hand derivation, and the first
//     recorded leg put a depth-2 entry ONE position from the end. The pin's own splice is the oracle.
//
// THE VERDICT MECHANIC (the same vocabulary the other comparators use, so the artefacts read together):
//   guards.<name>  TRUE only when true on BOTH subjects.
//   false on BOTH  a DRIVER LIMITATION, allowed ONLY when unproven[] names it with a mechanism -- and this surface has
//                  NO unproven[] escape hatch: every guard here is required, so a false one is a red.
//   true on ONE    an ASYMMETRY: never declarable, always fails. That difference is the whole point.
//
// IT REFUSES RATHER THAN SKIPS. A missing leg report, a leg whose drive failed, or a leg with zero cases is a NAMED
// refusal with exit 2 (the run could not be judged) -- never a pass. This project has shipped that green twice.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { DEPTH, DEPTH_ROLE_NAME, INPUT_TEXT, MARKERS, PINNED_BASELINE, PINNED_DEPTH_OFFSET, PINNED_FACTS } from './worldinfo-slots-kit.mjs';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
};

async function readLeg(label, file) {
    if (!file) return { label, present: false, leg: null, file: null, error: 'no path supplied' };
    try {
        const leg = JSON.parse(await fs.readFile(file, 'utf8'));
        return { label, present: true, leg, file: path.basename(file) };
    } catch (error) {
        return { label, present: false, leg: null, file: path.basename(file), error: String(error?.message ?? error) };
    }
}

const legs = {
    gotavern: await readLeg('gotavern', arg('--gotavern')),
    pinned: await readLeg('pinned', arg('--pinned')),
};
const artefactPath = arg('--out');

// ---- REFUSALS: exit 2 means "this run could not be judged", never "the subjects matched" -----------------------
const missing = Object.entries(legs).filter(([, entry]) => !entry.present);
if (missing.length > 0) {
    console.error(`worldinfo-slots REFUSED: ${missing.map(([label, entry]) => `${label} leg (${entry.file ?? 'no path'}: ${entry.error})`).join('; ')}. Absent evidence is not a pass.`);
    process.exit(2);
}
const driveFailures = Object.entries(legs)
    .filter(([, entry]) => entry.leg?.failure)
    .map(([label, entry]) => `${label}: ${entry.leg.failure}`);
if (driveFailures.length > 0) {
    console.error(`worldinfo-slots REFUSED: a leg failed to drive, so there is no comparison to judge:\n  ${driveFailures.join('\n  ')}`);
    process.exit(2);
}
const noCase = Object.entries(legs).filter(([, entry]) => (entry.leg?.cases ?? []).length === 0);
if (noCase.length > 0) {
    console.error(`worldinfo-slots REFUSED: ${noCase.map(([label]) => `${label} leg recorded zero cases`).join('; ')}`);
    process.exit(2);
}

// ---- PER-SUBJECT OBSERVATIONS ----------------------------------------------------------------------------------
const observed = {};
for (const subject of ['gotavern', 'pinned']) {
    const leg = legs[subject].leg;
    const entry = (leg?.cases ?? []).find(item => item.case === 'slots') ?? null;
    const layout = entry?.layout ?? null;
    const positions = layout?.positions ?? {};
    const index = slot => (positions?.[slot]?.index ?? null);
    const before = positions?.before ?? null;
    const after = positions?.after ?? null;
    const depth = positions?.depth ?? null;
    const historyIndex = layout?.historyInputIndex ?? null;
    // WHERE THE HISTORY BEGINS, read from the ROLES rather than from any one message: the system block is the run of
    // `role: 'system'` messages at the front, and the history starts at the first message that is not one. This matters
    // because the atDepth entry is spliced INTO the history but BEFORE the newest message -- an earlier version of this
    // file used the user-input message as the boundary and therefore reported a correct layout as
    // `depthSlotLandsInsideHistory: false` (the depth entry is 4, the user input 5).
    const roles = Array.isArray(layout?.roles) ? layout.roles : [];
    // AFTER THE LAST SYSTEM MESSAGE, not 'the first non-system one': a USER-role atDepth entry injected into the system
    // block (the mutation 'depth-slot-into-system-block') makes the first-non-system rule believe the history starts at
    // that entry, and then the very guard meant to catch it passes. The last system message is the boundary that does
    // not depend on where the entry landed.
    const lastSystemIndex = roles.lastIndexOf('system');
    const firstHistoryIndex = roles.length === 0 ? null : lastSystemIndex + 1;

    // Each slot must be on the wire EXACTLY ONCE. A duplicated marker is not "present": it means the entry activated
    // twice (or a slot's content was echoed into another message), and either would make an order assertion ambiguous.
    const beforePresent = before?.index !== null && before?.index !== undefined && before.occurrences === 1;
    const afterPresent = after?.index !== null && after?.index !== undefined && after.occurrences === 1;
    const depthPresent = depth?.index !== null && depth?.index !== undefined && depth.occurrences === 1;
    // F3: worldInfoBefore precedes worldInfoAfter (composed at openai.js:1376-1377, added at :1212/:1214).
    const beforePrecedesAfter = beforePresent && afterPresent && index('before') < index('after');
    // F3+F5: both system-block slots precede the chat history. The boundary is the first non-system message.
    const slotsPrecedeHistory = Boolean(firstHistoryIndex !== null && firstHistoryIndex > 0)
        && beforePresent && afterPresent
        && index('before') < firstHistoryIndex && index('after') < firstHistoryIndex;
    // F4/F5: the atDepth entry is spliced INTO the history, not left in the system block.
    const depthInsideHistory = depthPresent && Boolean(firstHistoryIndex !== null) && index('depth') >= firstHistoryIndex;
    // F4: the injection keeps its own role (script.js:4671 passes `e.role`; extension_prompt_roles USER = 1).
    const depthRoleRecorded = depthPresent && depth?.role === DEPTH_ROLE_NAME;
    // THE ORDER, as a comparable triple: the markers' relative positions.
    const slotOrder = [beforePresent ? index('before') : null, afterPresent ? index('after') : null, depthPresent ? index('depth') : null];

    observed[subject] = {
        legPresent: true,
        bakedSubject: leg?.subject ?? null,
        peerReplyPrefix: leg?.provenance?.peerReplyPrefix ?? null,
        request: entry?.request ? { method: entry.request.method, path: entry.request.path, sha256: entry.request.sha256, byteLength: entry.request.byteLength } : null,
        wire: {
            parsable: layout?.parsable ?? false,
            messages: layout?.messages ?? null,
            roles: layout?.roles ?? null,
            historyInputIndex: historyIndex,
            firstHistoryIndex,
            positions,
            slotOrder,
            slotsPresent: layout?.slotsPresent ?? 0,
            depthOffsetFromEnd: depth?.fromEnd ?? null,
        },
        requestedDepth: entry?.depth ?? null,
        requestedDepthRole: entry?.depthRole ?? null,
        slots: { beforePresent, afterPresent, depthPresent, beforePrecedesAfter, slotsPrecedeHistory, depthInsideHistory, depthRoleRecorded },
        driveSteps: (leg?.steps ?? []).map(item => ({ name: item.name, ok: item.ok })),
    };
}

// ---- THE GUARDS, each on a named pinned fact -------------------------------------------------------------------
const GUARDS = [
    { name: 'beforeSlotPresent', fact: 'F5', what: 'the before-position entry is on the wire exactly once', value: subject => subject.slots.beforePresent },
    { name: 'afterSlotPresent', fact: 'F5', what: 'the after-position entry is on the wire exactly once', value: subject => subject.slots.afterPresent },
    { name: 'depthSlotPresent', fact: 'F5', what: 'the atDepth entry is on the wire exactly once', value: subject => subject.slots.depthPresent },
    { name: 'beforeSlotPrecedesAfterSlot', fact: 'F3', what: 'worldInfoBefore precedes worldInfoAfter (openai.js:1376-1377, added at :1212/:1214)', value: subject => subject.slots.beforePrecedesAfter },
    { name: 'systemSlotsPrecedeHistory', fact: 'F5', what: 'both system-block slots precede the chat history', value: subject => subject.slots.slotsPrecedeHistory },
    { name: 'depthSlotLandsInsideHistory', fact: 'F4', what: 'the atDepth entry is spliced into the history, not left in the system block (script.js:4668-4672 -> openai.js:819-875)', value: subject => subject.slots.depthInsideHistory },
    { name: 'depthSlotKeepsItsRole', fact: 'F4', what: `the atDepth entry keeps role ${DEPTH_ROLE_NAME} (script.js:4671 passes e.role)`, value: subject => subject.slots.depthRoleRecorded },
];
const missingFacts = GUARDS.filter(guard => !PINNED_FACTS[guard.fact]).map(guard => `${guard.name} -> ${guard.fact}`);
if (missingFacts.length > 0) {
    console.error(`worldinfo-slots REFUSED: a guard cites a pinned fact this harness does not record: ${missingFacts.join('; ')}. A guard without an oracle is decoration.`);
    process.exit(2);
}

const guards = {};
const subjectGuards = {};
for (const guard of GUARDS) {
    const values = ['gotavern', 'pinned'].map(subject => Boolean(guard.value(observed[subject])));
    subjectGuards[guard.name] = values;
    guards[guard.name] = values.every(Boolean);
    guards[`fact:${guard.name}`] = `${guard.fact} ${PINNED_FACTS[guard.fact].file}:${PINNED_FACTS[guard.fact].lines}`;
}

// THE ORDERING AS AN ORDERING: the three markers' relative sequence must be the SAME on both subjects. This is the guard
// that says "the order is pinned's" without the byte guard having to explain which slot moved.
const orderOf = subject => observed[subject].wire.slotOrder;
guards.slotOrderEqualsPinned = JSON.stringify(orderOf('gotavern')) === JSON.stringify(orderOf('pinned'));

// THE DEPTH OFFSET AS PARITY, NOT AS A FORMULA (see the header). The requested depth and the measured offset are both
// recorded; the assertion is that the two subjects agree AND that both drives requested the same depth.
const offsets = ['gotavern', 'pinned'].map(subject => observed[subject].wire.depthOffsetFromEnd);
const requestedDepths = ['gotavern', 'pinned'].map(subject => observed[subject].requestedDepth);
guards.depthOffsetEqualsPinned = offsets[0] !== null && offsets[1] !== null && offsets[0] === offsets[1];
// THE ABSOLUTE DEPTH ANCHOR. Parity alone is not enough: a mutation that moves the depth entry on BOTH legs keeps the
// parity guard green (observed: the selftest's move-depth-one-position mutation SURVIVED the first version of this
// file). The pinned measurement recorded in the kit is the expectation, and a fresh pinned leg that DISAGREES with it is
// a STALE BASELINE -- refused, never silently accepted.
const pinnedOffset = offsets[1];
if (pinnedOffset !== PINNED_DEPTH_OFFSET.offsetFromEnd) {
    console.error(`worldinfo-slots REFUSED: the pinned leg measured a depth offset of ${JSON.stringify(pinnedOffset)} for depth ${PINNED_DEPTH_OFFSET.requestedDepth}, but this harness records ${PINNED_DEPTH_OFFSET.offsetFromEnd} (${PINNED_DEPTH_OFFSET.measuredBy}). Either pinned's behaviour changed or the fixture did, so the expectation is stale and must be re-measured rather than compared.`);
    process.exit(2);
}
guards.depthOffsetMatchesThePinnedMeasurement = offsets.every(offset => offset === PINNED_DEPTH_OFFSET.offsetFromEnd);
guards.requestedDepthMatchesOnBothSubjects = requestedDepths[0] !== null && requestedDepths[0] === requestedDepths[1];

// THE BYTE CONTRACT, case by case.
const mismatches = [];
const names = [...new Set((legs.gotavern.leg?.cases ?? []).map(entry => entry.case))];
for (const name of names) {
    const mine = (legs.gotavern.leg?.cases ?? []).find(entry => entry.case === name)?.request ?? null;
    const theirs = (legs.pinned.leg?.cases ?? []).find(entry => entry.case === name)?.request ?? null;
    for (const field of ['sha256', 'byteLength', 'method', 'path']) {
        const a = mine?.[field] ?? null;
        const b = theirs?.[field] ?? null;
        if (JSON.stringify(a) !== JSON.stringify(b)) mismatches.push({ case: name, field, gotavern: a, pinned: b });
    }
}
guards.nodeEqualsGo = mismatches.length === 0;

// RULE 50: THE HARNESS MUST BE ABLE TO TELL THE SUBJECTS APART. The discriminator is the peer's reply prefix, stamped
// into the REPLY, which cannot appear in the single compared request body.
const prefixes = ['gotavern', 'pinned'].map(subject => observed[subject].peerReplyPrefix);
guards.subjectsAreDistinguishable = prefixes.every(prefix => typeof prefix === 'string' && prefix.length > 0) && prefixes[0] !== prefixes[1];

// THE DRIVE MUST HAVE HAPPENED (rule 10: a step that did not run makes every later guard unattributable).
const REQUIRED_STEPS = ['subject-booted', 'page-loaded', 'world-selected', 'connection-configured', 'provider-request-arrived', 'turn-completed', 'drive-completed'];
const driveStepFailures = [];
for (const subject of ['gotavern', 'pinned']) {
    const done = new Set((observed[subject].driveSteps ?? []).filter(item => item.ok === true).map(item => item.name));
    for (const name of REQUIRED_STEPS) {
        if (!done.has(name)) driveStepFailures.push(`${subject}: ${name}`);
    }
}
guards.driveCompleted = driveStepFailures.length === 0;

const asymmetries = [];
for (const [name, values] of Object.entries(subjectGuards)) {
    const trueCount = values.filter(Boolean).length;
    if (trueCount > 0 && trueCount < values.length) asymmetries.push({ guard: name, gotavern: values[0], pinned: values[1] });
}

const failedGuards = Object.entries(guards)
    .filter(([name, value]) => !name.startsWith('fact:') && value !== true)
    .map(([name]) => name);

const artefact = {
    schemaVersion: 1,
    surface: 'worldinfo-slots',
    question: 'Do a `before`, an `after` and an `atDepth` world-info entry reach the FINAL provider request at the positions and in the order pinned produces?',
    generatedBy: 'tests/browser/compare-worldinfo-slots-legs.mjs',
    pinnedBaseline: PINNED_BASELINE,
    pinnedFacts: PINNED_FACTS,
    pinnedDepthOffset: PINNED_DEPTH_OFFSET,
    method: "one ordinary browser turn per subject against an in-process capture peer; the FINAL provider request bytes are compared byte-for-byte, and the same request's messages array is read for the three markers' positions. The expected order is the pinned source's (F1..F5) AND the pinned leg's own capture.",
    doesNotEstablish: 'server-side prompt handling: both legs drive the `custom` chat-completion source, whose pinned branch is a SERVER-SIDE PASSTHROUGH (src/endpoints/backends/chat-completions.js:2394-2421 never reads `messages`), so this compares the pinned FRONTEND assembling a prompt against two servers',
    fixture: {
        world: legs.gotavern.leg?.fixture?.file ?? legs.pinned.leg?.fixture?.file ?? null,
        markers: MARKERS,
        input: INPUT_TEXT,
        depth: DEPTH,
        depthRole: DEPTH_ROLE_NAME,
        entries: Object.entries(MARKERS).map(([slot, marker]) => ({ slot, marker })),
        requestedDepthPerSubject: requestedDepths,
        measuredOffsetFromEndPerSubject: offsets,
        depthRelationship: "the requested depth is NOT equal to the distance from the end (measured on this host: depth 2 -> offset 1), so the offset is asserted as PARITY with the pinned leg rather than derived",
    },
    verdict: failedGuards.length === 0 && asymmetries.length === 0 ? 'PASS' : 'FAIL',
    guards,
    failedGuards,
    asymmetries,
    mismatches,
    driveStepFailures,
    subjects: observed,
    unproven: [],
    answers: {
        'does every slot reach the wire': 'guards.beforeSlotPresent + afterSlotPresent + depthSlotPresent',
        "is the order pinned's": 'guards.beforeSlotPrecedesAfterSlot + systemSlotsPrecedeHistory + depthSlotLandsInsideHistory + slotOrderEqualsPinned',
        "is the depth position pinned's": 'guards.depthOffsetEqualsPinned + depthSlotKeepsItsRole + requestedDepthMatchesOnBothSubjects (the offset is pinned-measured, not derived)',
        'are the two subjects the same bytes': 'guards.nodeEqualsGo',
        'can the harness tell the subjects apart': 'guards.subjectsAreDistinguishable (peer reply prefix, which cannot enter the compared body)',
    },
};

const serialised = `${JSON.stringify(artefact, null, 2)}\n`;
if (artefactPath) await fs.writeFile(artefactPath, serialised);
process.stdout.write(serialised);
if (failedGuards.length > 0 || asymmetries.length > 0) {
    console.error(`worldinfo-slots comparison FAILED: guards=[${failedGuards.join(', ')}] asymmetries=[${asymmetries.map(item => item.guard).join(', ')}] mismatches=[${mismatches.map(item => `${item.case}.${item.field}`).join(', ')}]`);
    if (driveStepFailures.length > 0) console.error(`drive steps that did not happen: ${driveStepFailures.join(', ')}`);
    process.exitCode = 1;
}
