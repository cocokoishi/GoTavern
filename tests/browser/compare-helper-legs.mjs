// Judge the 酒馆助手 RENDER/VARIABLE surface: {gotavern,pinned} x {helper on, off}, plus the
// no-variable-write control.
//
// THE VERDICT MECHANIC (copied from tests/browser/compare-asset-legs.mjs, which the lead named):
//   guards.<name> is TRUE only when it is true on BOTH subjects.
//   A guard false on BOTH subjects is a DRIVER LIMITATION (rule 10), so it does not fail the run -- but only
//   if it is listed in `unprovenEntries` with its mechanism named. The list is emitted as `unproven` AND
//   `declaredUnproven`, so a reader and the verifier both see it.
//   A guard false on ONE subject and true on the other is an ASYMMETRY: never declarable, always fails, and
//   recorded in `asymmetries` with both values. That asymmetry is the whole point of the comparison.
//   A false-on-both guard that is NOT declared fails too: an undeclared gap is a red.
//
// WHY THIS SURFACE IS SEPARATE. Run 40217283368 carried two defensible outcomes in one artefact: the
// generation surface was clean apart from a guard of mine, and this surface was red on BOTH subjects because
// the drive never produced a saved chat. A gate that can only ever be red is as useless as one that can only
// ever be green, so the two surfaces now carry two artefacts and two verdicts.
//
// WHAT THIS IS ALLOWED TO CLAIM. It never defines what the correct rendered HTML is: the assertion is that
// the SAME script produced the SAME observable state through both servers, and that the architecture the
// extension depends on is present on both. The pinned leg is the oracle.

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
const mutated = await readLeg('gotavern-mutated', argumentValue('--gotavern-mutated'));
const artefactPath = argumentValue('--out');
const required = ['gotavernOn', 'gotavernOff', 'pinnedOn', 'pinnedOff'];

// WHICH STEPS ARE DRIVE, NOT GUARD. A red assertion is this comparator's business; a drive step that did
// not happen makes everything after it unattributable and is a failure in its own right.
const DRIVE_STEPS = new Set([
    'page-loaded', 'settings-ready', 'host-modules', 'character-opened', 'chat-has-message',
    'chat-open', 'script-enabled', 'script-iframe', 'script-ran',
]);

const missing = required.filter(key => !legs[key].present);
const driveStepFailures = required
    .filter(key => legs[key].present)
    .flatMap(key => (legs[key].leg?.steps ?? [])
        .filter(item => item.ok === false && DRIVE_STEPS.has(item.name))
        .map(item => `${key}: ${item.name}: ${item.detail ?? 'failed'}`));

const on = { gotavern: legs.gotavernOn.leg, pinned: legs.pinnedOn.leg };
const off = { gotavern: legs.gotavernOff.leg, pinned: legs.pinnedOff.leg };
const subjects = ['gotavern', 'pinned'];

// Per-subject observations first, then the object the verdict is computed from.
const observed = {};
for (const subject of subjects) {
    const leg = on[subject] ?? null;
    const offLeg = off[subject] ?? null;
    const counter = Number(leg?.variableState?.after?.helper_probe_counter ?? 0);
    const urlProblems = [];
    for (const target of leg?.urls ?? []) {
        for (const purpose of ['character', 'thumbnail']) {
            const response = target[`${purpose}Response`];
            if (!response || response.status !== 200 || !(response.byteLength > 0)) {
                urlProblems.push(`${purpose}: ${response ? `${response.status}/${response.byteLength}` : 'not requested'}`);
            }
        }
    }
    observed[subject] = {
        legPresent: Boolean(leg),
        driveCompleted: Boolean(leg) && (leg.steps ?? []).every(item => !(item.ok === false && DRIVE_STEPS.has(item.name))),
        hostModulesServed: (leg?.hostImportStatus ?? []).length === 25
            && (leg?.hostImportStatus ?? []).every(entry => entry.status === 200 && entry.byteLength > 0),
        scriptIframeUnsandboxed: Boolean(leg?.iframe) && leg.iframe.hasSandboxAttribute === false
            && leg.iframe.sameOriginReadable === true && leg.iframe.parentHelperReachable === true,
        moduleCompleted: leg?.iframe?.done?.marker === 'HELPER_PROBE_SCRIPT_DONE',
        chatFileCreated: Boolean(leg?.variableState?.chatFile),
        variablePersisted: counter >= 1 && leg?.variableState?.changed === true,
        renderPathProduced: leg?.render?.renderedText === 'HELPER_PROBE_RENDERED',
        domUrlsServed: Boolean(leg) && (leg.urls ?? []).length > 0 && urlProblems.length === 0,
        domUrlProblems: urlProblems,
        helperSeenWhenOn: Boolean(leg?.iframe?.id) || Boolean(leg?.bridge),
        helperAbsentWhenOff: !(Boolean(offLeg?.iframe?.id) || Boolean(offLeg?.bridge)),
        counters: { on: counter, off: Number(offLeg?.variableState?.after?.helper_probe_counter ?? 0) },
        bridge: leg?.bridge ?? null,
        iframe: leg ? { id: leg.iframe?.id ?? null, sandbox: leg.iframe?.hasSandboxAttribute ?? null, sameOriginReadable: leg.iframe?.sameOriginReadable ?? null, scriptError: leg.iframe?.scriptError ?? null } : null,
        renderDiagnostics: leg?.renderDiagnostics ?? null,
        // Q10's evidence, carried into the artefact: what the host hands the page, what the drive called,
        // and where the chat file would have been (flat or per-character).
        saveFunctionsReachable: leg?.saveFunctionsReachable ?? null,
        // Q10's measured mechanism, carried into the artefact so the finding is not left in a leg file:
        // what saveChat reads (chatLength/chatId/characterChatName), which /api/chats requests the browser
        // actually made, and the console warnings the frontend emitted while refusing to save.
        saveDiagnostics: leg?.saveDiagnostics ?? null,
        saveRequests: leg?.saveRequests ?? null,
        consoleSaveWarnings: (leg?.console ?? []).filter(item => /chat_name|Error saving chat/i.test(item.text ?? '')).map(item => item.text),
        saveAttempt: leg?.saveAttempt ?? null,
        chatFile: leg?.variableState?.chatFile ?? null,
        steps: (leg?.steps ?? []).map(item => ({ name: item.name, ok: item.ok, detail: item.detail })),
    };
}

// THE SAME-FIXTURE GUARD, per subject: the extension revision, the config bytes and the post-boot tree
// (characters are seeded by the SERVER at startup, so a pre-boot count is zero by construction).
function fixtureOk(leg) {
    return leg?.provenance?.extension?.installedRevision === '837a6288135cde61522a9279173b98020f08807e'
        && Boolean(leg?.provenance?.configFile?.matchesSource)
        && (leg?.provenance?.startingState?.characterFilesAfterBoot ?? 0) > 0;
}
for (const subject of subjects) observed[subject].sameFixture = fixtureOk(on[subject]);
const configHashes = subjects.map(subject => on[subject]?.provenance?.configFile?.sha256 ?? null);
const fixturesMatchEachOther = configHashes[0] !== null && configHashes[0] === configHashes[1];

// The negative control's teeth are a property of the DRIVER, not of a subject: one leg suffices.
const controlCounter = Number(mutated.leg?.variableState?.after?.helper_probe_counter ?? 0);
const controlBridgeOk = mutated.leg?.iframe?.done?.marker === 'HELPER_PROBE_SCRIPT_DONE';

const guards = {};
const subjectGuards = {
    legsPresent: subjects.map(subject => observed[subject].legPresent),
    driveCompleted: subjects.map(subject => observed[subject].driveCompleted),
    sameFixture: subjects.map(subject => observed[subject].sameFixture),
    hostModulesServed: subjects.map(subject => observed[subject].hostModulesServed),
    scriptIframeUnsandboxed: subjects.map(subject => observed[subject].scriptIframeUnsandboxed),
    moduleCompleted: subjects.map(subject => observed[subject].moduleCompleted),
    chatFileCreated: subjects.map(subject => observed[subject].chatFileCreated),
    variablePersisted: subjects.map(subject => observed[subject].variablePersisted),
    renderPathProduced: subjects.map(subject => observed[subject].renderPathProduced),
    domUrlsServed: subjects.map(subject => observed[subject].domUrlsServed),
    helperSeenOnlyWhenOn: subjects.map(subject => observed[subject].helperSeenWhenOn && observed[subject].helperAbsentWhenOff),
};
const asymmetries = [];
for (const [name, values] of Object.entries(subjectGuards)) {
    const trueCount = values.filter(Boolean).length;
    if (trueCount > 0 && trueCount < values.length) {
        asymmetries.push({ guard: name, gotavern: values[0], pinned: values[1] });
    }
    guards[name] = trueCount === values.length;
}
guards.fixturesMatchEachOther = fixturesMatchEachOther;
guards.negativeControlBites = mutated.present && controlCounter === 0 && controlBridgeOk;
if (driveStepFailures.length > 0) guards.driveCompleted = false;

const unprovenEntries = [
    'a user script that loads Vue / Vue-Router inside the iframe: the probe blocks testingcf.jsdelivr.net (the iframe heads load Vue there with blocking tags and no onerror) and the probe script uses only TavernHelper.',
    'injection or generation through THIS surface: they are the generation surface (helper-generation-comparison.json).',
];
// A FALSE GUARD IS DECLARED WITH ITS MEASURED MECHANISM, AND ONLY WHILE IT IS FALSE. A declaration that
// stayed behind after the guard went green would hide a green guard from the required set (helperSurface
// refuses that as stale), and a declaration written before the measurement would be another guess. The
// mechanism is read from the legs, so it names what actually happened on this run.
const guardMechanisms = {
    chatFileCreated: () => `no chat file appeared after the drive's save attempt; saveFunctionsReachable=${JSON.stringify(subjects.map(subject => on[subject]?.saveFunctionsReachable ?? null))} saveAttempt=${JSON.stringify(subjects.map(subject => on[subject]?.saveAttempt ?? null))}; the scan covers chats/**/*.jsonl (flat and per-character)`,
    variablePersisted: () => `the chat variable never reached a persisted chat file; counters=${JSON.stringify(subjects.map(subject => observed[subject].counters))}. See chatFileCreated for the save path that was tried.`,
    renderPathProduced: () => 'the helper renderer produced no div.TH-render on either subject: the message the script wrote is judged only through the DOM, and no rendered message existed',
    domUrlsServed: () => 'the rendered message is what requests /characters/<avatar>.png; no rendered message existed on either subject, so nothing was requested to judge',
};
for (const [name, mechanism] of Object.entries(guardMechanisms)) {
    if (guards[name] !== true) unprovenEntries.push(`${name}: ${mechanism()}`);
}
const declaredUnproven = new Set(unprovenEntries.map(entry => String(entry).split(':')[0].trim()));

const failedGuards = Object.entries(guards)
    .filter(([name, value]) => value !== true && !declaredUnproven.has(name))
    .map(([name]) => name);

const artefact = {
    schemaVersion: 1,
    question: 'Does the pinned 酒馆助手\'s user-script iframe RUN on GoTavern as it does on pinned Node, and does the state it produces - a chat variable in the chat file and a message rendered by the extension\'s own renderer - persist and display identically?',
    generatedBy: 'tests/browser/compare-helper-legs.mjs',
    subject: 'tavern-helper@837a6288135cde61522a9279173b98020f08807e (manifest 4.11.3)',
    surface: 'render + variables',
    verdict: failedGuards.length === 0 ? 'PASS' : 'FAIL',
    guards,
    failedGuards,
    asymmetries,
    // A false-on-both guard is only allowed through when it is named here; the pairing is what makes the
    // allowance auditable instead of silent.
    unproven: unprovenEntries,
    declaredUnproven: [...declaredUnproven].sort(),
    subjects: observed,
    negativeControl: mutated.present
        ? { leg: 'helper-gotavern-mutated', mutation: mutated.leg?.mutation ?? null, counter: controlCounter, bridgeCompleted: controlBridgeOk, chatFile: mutated.leg?.variableState?.chatFile ?? null }
        : null,
    answers: {
        'Q8 iframe + bridge': 'guards.scriptIframeUnsandboxed + guards.hostModulesServed + guards.moduleCompleted',
        'Q10 chat variables': 'guards.variablePersisted (declared unproven until the drive produces a saved chat)',
        'Q19 streaming, Q20 reload/swipe': 'not attempted by this surface',
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
    console.error(`helper render comparison failed: guards=[${failedGuards.join(', ')}] asymmetries=[${asymmetries.map(item => item.guard).join(', ')}]`);
    process.exitCode = 1;
}
