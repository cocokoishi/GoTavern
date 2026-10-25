// Judge the four 酒馆助手 GENERATION legs: {gotavern,pinned} x {helper on, helper off}.
//
// The claim this artefact is allowed to make: a script inside the pinned extension's own iframe can call
// `generateRaw` with an explicit prompt order and `generate` with an injection, the request reaches a
// model backend, and the request BYTES are identical on GoTavern and pinned Node. It never writes an
// expected body: the oracle is the pinned leg (rule 49), and the assertions on marker order are
// properties of the inputs this probe supplied.
//
// Two verdicts are separate on purpose:
//   node-equals-go   - the two subjects produce the same request
//   discriminating   - helper-on produces requests and helper-off produces none; if both produced none,
//                      or both produced some, the harness cannot see the helper and must fail itself
//                      (AGENTS.md 50)
// A simulated peer is not a production provider (rule 22), so the artefact says so in `unproven[]`
// whatever the guards say.

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
const guards = [];
const mismatches = [];
const notCompared = [];
const unproven = [];

function guard(name, ok, detail = null) {
    guards.push({ guard: name, ok: Boolean(ok), detail });
    return Boolean(ok);
}

const missing = required.filter(key => !legs[key].present);
const driveFailures = required
    .filter(key => legs[key].present)
    .map(key => ({ key, failure: legs[key].leg?.failure, steps: (legs[key].leg?.steps ?? []).filter(item => item.ok === false) }))
    .filter(item => item.failure);
guard('legs-present', missing.length === 0, missing.length ? `missing: ${missing.join(', ')}` : null);
guard('legs-drove', driveFailures.length === 0, driveFailures.length ? driveFailures.map(item => `${item.key}: ${item.failure}`).join(' | ') : null);

const on = { gotavern: legs.gotavernOn.leg, pinned: legs.pinnedOn.leg };
const off = { gotavern: legs.gotavernOff.leg, pinned: legs.pinnedOff.leg };

// The connection the drive established must be the captured one, on both subjects.
const connectionProblems = [];
for (const subject of ['gotavern', 'pinned']) {
    const connection = on[subject]?.connection ?? null;
    if (connection?.observedSource !== 'custom') connectionProblems.push(`${subject}: chat_completion_source=${connection?.observedSource}`);
    if (!String(connection?.observedUrl ?? '').startsWith('http://127.0.0.1:')) connectionProblems.push(`${subject}: custom_url=${connection?.observedUrl}`);
    if (connection?.observedModel !== 'probe-model') connectionProblems.push(`${subject}: custom_model=${connection?.observedModel}`);
}
guard('connection-configured', connectionProblems.length === 0, connectionProblems.join(' | ') || null);

// Did the request arrive at all? Counted from the PEER's own log, not from the page's belief.
const reachProblems = [];
const rawBySubject = {};
const presetBySubject = {};
for (const subject of ['gotavern', 'pinned']) {
    const assertions = on[subject]?.assertions ?? {};
    rawBySubject[subject] = assertions.rawRequest ?? null;
    presetBySubject[subject] = assertions.presetRequest ?? null;
    if (!rawBySubject[subject]) reachProblems.push(`${subject}: no generateRaw request reached the peer`);
    if (!presetBySubject[subject]) reachProblems.push(`${subject}: no generate request reached the peer`);
    if ((assertions.completionRequestCount ?? 0) < 2) reachProblems.push(`${subject}: ${assertions.completionRequestCount ?? 0} chat/completions request(s)`);
    if (!Array.isArray(rawBySubject[subject]?.messages)) reachProblems.push(`${subject}: the generateRaw body carried no messages array`);
}
guard('peer-reached', reachProblems.length === 0, reachProblems.join(' | ') || null);

// The ordered-prompts oracle, per subject: the markers this probe supplied arrive, in the order asked
// for, with the roles the frontend assigned.
const orderProblems = [];
for (const subject of ['gotavern', 'pinned']) {
    const markers = on[subject]?.assertions?.markersPresent ?? null;
    if (markers?.ordered !== true) orderProblems.push(`${subject}: marker order ${JSON.stringify(markers)}`);
    if (!(markers?.roles?.length === 3 && markers.roles[0] === 'system' && markers.roles.slice(1).every(role => role === 'user'))) {
        orderProblems.push(`${subject}: marker roles ${JSON.stringify(markers?.roles)}`);
    }
}
guard('ordered-prompts', orderProblems.length === 0, orderProblems.join(' | ') || null);

const injectionProblems = [];
for (const subject of ['gotavern', 'pinned']) {
    if (on[subject]?.assertions?.injectionPresent !== true) injectionProblems.push(`${subject}: the generate() request did not carry the injection marker`);
}
guard('injection-visible', injectionProblems.length === 0, injectionProblems.join(' | ') || null);

// Node == Go on the request bytes. Every compared value is the provider-wire contract (rule 48).
for (const [name, left, right] of [
    ['generateRaw.bodySha256', rawBySubject.gotavern?.sha256, rawBySubject.pinned?.sha256],
    ['generateRaw.byteLength', rawBySubject.gotavern?.byteLength, rawBySubject.pinned?.byteLength],
    ['generateRaw.model', rawBySubject.gotavern?.model, rawBySubject.pinned?.model],
    ['generateRaw.stream', rawBySubject.gotavern?.stream, rawBySubject.pinned?.stream],
    ['generateRaw.messages', rawBySubject.gotavern?.messages, rawBySubject.pinned?.messages],
    ['generate.bodySha256', presetBySubject.gotavern?.sha256, presetBySubject.pinned?.sha256],
    ['generate.byteLength', presetBySubject.gotavern?.byteLength, presetBySubject.pinned?.byteLength],
    ['generate.messages', presetBySubject.gotavern?.messages, presetBySubject.pinned?.messages],
]) {
    if (JSON.stringify(left) !== JSON.stringify(right)) mismatches.push({ field: name, gotavern: left, pinned: right });
}
guard('node-equals-go', mismatches.length === 0, mismatches.map(item => item.field).join(', ') || null);

// Rule 50: the pair must be able to see the helper at all.
const discrimination = {};
for (const subject of ['gotavern', 'pinned']) {
    const onCount = on[subject]?.assertions?.completionRequestCount ?? null;
    const offCount = off[subject]?.assertions?.completionRequestCount ?? null;
    discrimination[subject] = { onCount, offCount, differs: onCount !== null && offCount !== null && onCount > 0 && offCount === 0 };
}
guard('discriminating', required.every(key => legs[key].present) && ['gotavern', 'pinned'].every(subject => discrimination[subject].differs), JSON.stringify(discrimination));

field('request.headers', 'the peer records only whether an Authorization header was present, because the frontend adds volatile client metadata; the body, model, stream flag and message array are compared and the body digest covers the rest.');
function field(name, reason) {
    notCompared.push({ field: name, reason });
}

field('request.path', 'recorded per leg and compared through /chat/completions presence; the exact suffix depends on the custom URL this probe chose, which both legs share.');

unproven.push({ capability: 'a REAL provider', reason: 'the peer is a simulated backend inside this process; rule 22 makes every wire measurement here unverified for production. What is proven is the frontend+helper transform, not the transport to a live endpoint.' });
unproven.push({ capability: 'streaming (should_stream: true) and cancellation', reason: 'both calls set should_stream: false so the peer can answer without SSE framing; the streaming path is a separate leg.' });
unproven.push({ capability: 'tools / tool_choice / json_schema / reasoning / samplers in the request', reason: 'not supplied here; the custom source\'s own field set is compared byte-wise only for the fields this drive asked for.' });
unproven.push({ capability: 'presets other than the one in use', reason: 'generate() used preset_name: in_use; a preset matrix is the preset lane\'s artefact, not this one.' });
unproven.push({ capability: 'injection depth > 0', reason: 'the injection is at depth 0; deeper insertion interleaves with chat history, which needs a multi-turn chat this drive does not build.' });
unproven.push({ capability: 'a user script that both renders and generates', reason: 'this is a second drive; the render leg is helper-comparison.json.' });

const failedGuards = guards.filter(item => !item.ok);
const artefact = {
    schemaVersion: 1,
    question: 'Does 酒馆助手\'s generation API reach the model backend through the pinned frontend, and is the resulting provider request byte-identical on GoTavern and pinned Node?',
    generatedBy: 'tests/browser/compare-helper-generation.mjs',
    subject: 'tavern-helper@837a6288135cde61522a9279173b98020f08807e (manifest 4.11.3)',
    verdict: failedGuards.length === 0 ? 'PASS' : 'FAIL',
    guards,
    mismatches,
    discrimination,
    requests: {
        generateRaw: rawBySubject,
        generate: presetBySubject,
    },
    notCompared,
    unproven,
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
if (failedGuards.length > 0) {
    console.error(`helper generation comparison failed: ${failedGuards.map(item => item.guard).join(', ')}`);
    process.exitCode = 1;
}
