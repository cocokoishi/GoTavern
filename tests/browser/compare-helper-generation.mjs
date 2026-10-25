// Judge the 酒馆助手 GENERATION surface: {gotavern,pinned} x {helper on, off}.
//
// The claim this artefact is allowed to make: a script inside the pinned extension's own iframe can call
// `generateRaw` with an explicit prompt order and `generate` with a depth-0 injection, the request reaches
// a model backend, and the request BYTES are identical on GoTavern and pinned Node. It never writes an
// expected body: the oracle is the pinned leg (rule 49), and the marker assertions are properties of the
// inputs this probe supplied.
//
// VERDICT MECHANIC, the same as compare-helper-legs.mjs and compare-asset-legs.mjs:
//   guards.<name> is true only when it is true on BOTH subjects; a false-on-both guard is a driver
//   limitation and must be declared in `unprovenEntries` or it fails the run; a guard true on one subject
//   and false on the other is an ASYMMETRY, is never declarable and always fails. `nodeEqualsGo` is a guard
//   of the first kind with no declaration available: a byte difference is the product claim, so it can only
//   ever be green or red.
//
// SEPARATE FROM THE RENDER SURFACE ON PURPOSE (Browser differential 40217283368): this artefact was clean
// on peer-reached / ordered-prompts / injection-visible / node-equals-go / discriminating while the render
// surface was red on both subjects for a driver reason. Two surfaces, two artefacts, two verdicts.

import fs from 'node:fs/promises';
import process from 'node:process';

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

async function readLeg(label, file) {
    if (!file) return { label, present: false, leg: null };
    try {
        return { label, present: true, leg: JSON.parse(await fs.readFile(file, 'utf8')) };
    } catch (error) {
        return { label, present: false, leg: null, error: String(error?.message ?? error) };
    }
}

const legs = {
    gotavernOn: await readLeg('gotavern-on', argumentValue('--gotavern-on')),
    gotavernOff: await readLeg('gotavern-off', argumentValue('--gotavern-off')),
    pinnedOn: await readLeg('pinned-on', argumentValue('--pinned-on')),
    pinnedOff: await readLeg('pinned-off', argumentValue('--pinned-off')),
};
const artefactPath = argumentValue('--out');
const required = ['gotavernOn', 'gotavernOff', 'pinnedOn', 'pinnedOff'];
const DRIVE_STEPS = new Set(['page-loaded', 'settings-ready', 'chat-open', 'script-enabled', 'script-completed']);

const on = { gotavern: legs.gotavernOn.leg, pinned: legs.pinnedOn.leg };
const off = { gotavern: legs.gotavernOff.leg, pinned: legs.pinnedOff.leg };
const subjects = ['gotavern', 'pinned'];

const markers = on.gotavern?.markers ?? on.pinned?.markers ?? null;
const observed = {};
for (const subject of subjects) {
    const leg = on[subject] ?? null;
    const offLeg = off[subject] ?? null;
    const raw = leg?.assertions?.rawRequest ?? null;
    const preset = leg?.assertions?.presetRequest ?? null;
    const applied = Array.isArray(leg?.connection?.applied) ? leg.connection.applied : [];
    observed[subject] = {
        legPresent: Boolean(leg),
        driveCompleted: Boolean(leg) && (leg.steps ?? []).every(item => !(item.ok === false && DRIVE_STEPS.has(item.name))),
        // The peer's OWN log, not the page's belief about its settings.
        peerReached: (leg?.assertions?.completionRequestCount ?? 0) >= 2 && Boolean(raw) && Boolean(preset),
        connectionFromPeer: raw?.model === 'probe-model' && applied.every(item => item?.found !== false),
        orderedPrompts: leg?.assertions?.markersPresent?.ordered === true
            && leg?.assertions?.markersPresent?.roles?.length === 3
            && leg?.assertions?.markersPresent?.roles[0] === 'system'
            && leg?.assertions?.markersPresent?.roles.slice(1).every(role => role === 'user'),
        injectionVisible: leg?.assertions?.injectionPresent === true,
        helperSeenOnlyWhenOn: (leg?.assertions?.completionRequestCount ?? 0) > 0
            && (offLeg?.assertions?.completionRequestCount ?? 0) === 0,
        completionRequests: { on: leg?.assertions?.completionRequestCount ?? null, off: offLeg?.assertions?.completionRequestCount ?? null },
        rawRequest: raw,
        presetRequest: preset,
        steps: (leg?.steps ?? []).map(item => ({ name: item.name, ok: item.ok, detail: item.detail })),
        scriptError: leg?.script?.errors ?? null,
        reply: { raw: leg?.script?.raw?.preview ?? null, preset: leg?.script?.preset?.preview ?? null },
    };
}

// nodeEqualsGo: every compared value is the provider-wire contract (rule 48).
const mismatches = [];
function compareField(name, pick) {
    const gotavern = pick(on.gotavern);
    const pinned = pick(on.pinned);
    if (JSON.stringify(gotavern) !== JSON.stringify(pinned)) mismatches.push({ field: name, gotavern, pinned });
}
compareField('generateRaw.bodySha256', leg => leg?.assertions?.rawRequest?.sha256 ?? null);
compareField('generateRaw.byteLength', leg => leg?.assertions?.rawRequest?.byteLength ?? null);
compareField('generateRaw.model', leg => leg?.assertions?.rawRequest?.model ?? null);
compareField('generateRaw.stream', leg => leg?.assertions?.rawRequest?.stream ?? null);
compareField('generateRaw.messages', leg => leg?.assertions?.rawRequest?.messages ?? null);
compareField('generate.bodySha256', leg => leg?.assertions?.presetRequest?.sha256 ?? null);
compareField('generate.byteLength', leg => leg?.assertions?.presetRequest?.byteLength ?? null);
compareField('generate.messages', leg => leg?.assertions?.presetRequest?.messages ?? null);

const guards = {};
const subjectGuards = {
    legsPresent: subjects.map(subject => observed[subject].legPresent),
    driveCompleted: subjects.map(subject => observed[subject].driveCompleted),
    peerReached: subjects.map(subject => observed[subject].peerReached),
    connectionFromPeer: subjects.map(subject => observed[subject].connectionFromPeer),
    orderedPrompts: subjects.map(subject => observed[subject].orderedPrompts),
    injectionVisible: subjects.map(subject => observed[subject].injectionVisible),
    helperSeenOnlyWhenOn: subjects.map(subject => observed[subject].helperSeenOnlyWhenOn),
};
const asymmetries = [];
for (const [name, values] of Object.entries(subjectGuards)) {
    const trueCount = values.filter(Boolean).length;
    if (trueCount > 0 && trueCount < values.length) {
        asymmetries.push({ guard: name, gotavern: values[0], pinned: values[1] });
    }
    guards[name] = trueCount === values.length;
}
guards.nodeEqualsGo = mismatches.length === 0;
const missingLegs = required.filter(key => !legs[key].present);
if (missingLegs.length > 0) guards.legsPresent = false;

const unprovenEntries = [
    'a real provider: the peer is a simulated backend inside this process, so rule 22 makes every wire measurement here unverified for production. What is proven is the frontend+helper transform, not the transport to a live endpoint.',
    'streaming (should_stream: true) and cancellation: both calls set should_stream false so the peer can answer without SSE framing; the streaming path is a separate leg.',
    'tools / tool_choice / json_schema / reasoning / samplers: not supplied here; only the fields this drive asked for are compared.',
    'preset selection beyond the one in use: Q12 in its full form (a preset MUTATION changing the next request) is not exercised; only that preset_name in_use produces an equal request.',
    'injection depth greater than 0: the injection is at depth 0; deeper insertion interleaves with chat history, which needs a multi-turn chat this drive does not build.',
    'a user script that both renders and generates: that is the render surface (helper-comparison.json).',
];
const declaredUnproven = new Set(unprovenEntries.map(entry => String(entry).split(':')[0].trim()));
const failedGuards = Object.entries(guards)
    .filter(([name, value]) => value !== true && !declaredUnproven.has(name))
    .map(([name]) => name);

const artefact = {
    schemaVersion: 1,
    question: 'Does 酒馆助手\'s generation API reach the model backend through the pinned frontend, and is the resulting provider request byte-identical on GoTavern and pinned Node?',
    generatedBy: 'tests/browser/compare-helper-generation.mjs',
    subject: 'tavern-helper@837a6288135cde61522a9279173b98020f08807e (manifest 4.11.3)',
    surface: 'generation (Q9, Q11, part of Q12)',
    verdict: failedGuards.length === 0 && asymmetries.length === 0 ? 'PASS' : 'FAIL',
    guards,
    failedGuards,
    asymmetries,
    mismatches,
    markers,
    unproven: unprovenEntries,
    declaredUnproven: [...declaredUnproven].sort(),
    subjects: observed,
    answers: {
        'Q9 generation APIs': 'guards.peerReached + guards.orderedPrompts + guards.nodeEqualsGo',
        'Q11 injection changes the context': 'guards.injectionVisible',
        'Q12 in_use preset': 'guards.nodeEqualsGo on the generate() request; a preset MUTATION is declared unproven',
    },
    legs: Object.fromEntries(Object.entries(legs).map(([key, value]) => [key, {
        present: value.present,
        subject: value.leg?.subject ?? null,
        variant: value.leg?.variant ?? null,
        failure: value.leg?.failure ?? null,
        steps: (value.leg?.steps ?? []).map(item => `${item.ok === null ? 'n/a' : item.ok ? 'ok' : 'FAIL'} ${item.name}`),
    }])),
};
const serialised = `${JSON.stringify(artefact, null, 2)}\n`;
if (artefactPath) await fs.writeFile(artefactPath, serialised);
process.stdout.write(serialised);
if (failedGuards.length > 0 || asymmetries.length > 0) {
    console.error(`helper generation comparison failed: guards=[${failedGuards.join(', ')}] asymmetries=[${asymmetries.map(item => item.guard).join(', ')}] mismatches=[${mismatches.map(item => item.field).join(', ')}]`);
    process.exitCode = 1;
}
