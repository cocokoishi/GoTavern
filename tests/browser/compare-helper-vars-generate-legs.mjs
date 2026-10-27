// JUDGE the NARROW vehicle: does a 酒馆助手 variable reach the FINAL provider request, and survive a fresh page and a
// new server process?
//
// WHY THE ASSERTIONS ARE ON CLAUSES, NOT SUBSTRINGS. The claim is that the value arrives WHERE THE PROMPT ASKED FOR
// IT, so each guard matches `<CLAUSE><value>` followed by a boundary inside the RAW BODY BYTES. A body that merely
// echoes the token somewhere -- a settings dump, a second-generation prompt, a stashed variable inside a
// provider-extension member -- satisfies a substring test while the macro never resolved. This is also the guard that
// can fail when the two subjects AGREE AND ARE BOTH WRONG: with digest equality as the only other evidence, a pair of
// identical requests that both lack the value would pass `nodeEqualsGo` and every comparator guard.
//
// THE VERDICT MECHANIC (as every helper comparator, so the artefacts read together):
//   guards.<name>            TRUE only when true on BOTH subjects.
//   false on BOTH            a DRIVER LIMITATION (rule 10) -- excusable ONLY through unproven[] with a mechanism.
//   true on ONE              an ASYMMETRY: never declarable, always fails. That is the difference this exists to find.
//
// THE OFF CONTROL IS PART OF THE VERDICT. Rule 50: if the on and off captures are identical, the pair cannot show the
// variable is what changed anything, so `offIsTheControl` is required and is computed from the OFF legs.

import fs from 'node:fs/promises';
import process from 'node:process';

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

async function readLeg(label, file) {
    if (!file) return { label, present: false, leg: null, path: null };
    try {
        return { label, present: true, leg: JSON.parse(await fs.readFile(file, 'utf8')), path: file };
    } catch (error) {
        return { label, present: false, leg: null, path: file, error: String(error?.message ?? error) };
    }
}

const legs = {
    gotavernOn: await readLeg('gotavern-on', argumentValue('--gotavern-on')),
    pinnedOn: await readLeg('pinned-on', argumentValue('--pinned-on')),
    gotavernOff: await readLeg('gotavern-off', argumentValue('--gotavern-off')),
    pinnedOff: await readLeg('pinned-off', argumentValue('--pinned-off')),
    gotavernRestart: await readLeg('gotavern-restart', argumentValue('--gotavern-restart')),
    pinnedRestart: await readLeg('pinned-restart', argumentValue('--pinned-restart')),
};
const artefactPath = argumentValue('--out');
const subjects = ['gotavern', 'pinned'];
const on = { gotavern: legs.gotavernOn.leg, pinned: legs.pinnedOn.leg };
const off = { gotavern: legs.gotavernOff.leg, pinned: legs.pinnedOff.leg };
const restart = { gotavern: legs.gotavernRestart.leg, pinned: legs.pinnedRestart.leg };

const DRIVE_STEPS = new Set([
    'page-loaded', 'extension-is-pinned', 'api-surface-recorded', 'host-macro-surface-present',
    'connection-configured', 'script-completed', 'helper-api-present', 'one-capture-per-case', 'message-scope-unreadable-by-macro',
]);
const DRIVE_STEP_FAILURES = [];
for (const [label, entry] of Object.entries(legs)) {
    for (const item of entry.leg?.steps ?? []) {
        if (item.ok === false && DRIVE_STEPS.has(item.name)) DRIVE_STEP_FAILURES.push(`${label}: ${item.name}: ${item.detail ?? 'failed'}`);
    }
}

const escapeRegExp = value => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const caseOf = (leg, name) => (leg?.cases ?? []).find(entry => entry.case === name) ?? null;
const body = entry => String(entry?.request?.body ?? '');
const hasClause = (entry, clause, value) => Boolean(entry?.request) && new RegExp(`${escapeRegExp(clause)}${escapeRegExp(value)}(?![\\w-])`).test(body(entry));
const hasEmptyClause = (entry, clause) => Boolean(entry?.request) && new RegExp(`${escapeRegExp(clause)}(?![\\w-])`).test(body(entry)) && !new RegExp(`${escapeRegExp(clause)}HV-`).test(body(entry));

const MARKS = on.gotavern?.marks ?? on.pinned?.marks ?? null;
const CLAUSES = on.gotavern?.prompts ?? on.pinned?.prompts ?? null;
const chat = MARKS?.first ?? 'HV-ALPHA-7c31';
const chatBeta = MARKS?.second ?? 'HV-BETA-9d42';
const globalMark = MARKS?.global ?? 'HV-GLOBAL-e05f';
const messageMark = MARKS?.message ?? 'HV-MESSAGE-1a88';
const C = CLAUSES ?? { chat: 'HV-READ-CHAT=', global: 'HV-READ-GLOBAL=', message: 'HV-READ-MESSAGE=' };

const observed = {};
for (const subject of subjects) {
    const leg = on[subject];
    const offLeg = off[subject];
    const restartLeg = restart[subject];

    const alpha = caseOf(leg, 'chat-alpha');
    const beta = caseOf(leg, 'chat-beta');
    const deleted = caseOf(leg, 'chat-deleted');
    const globalSet = caseOf(leg, 'global-set');
    const messageSet = caseOf(leg, 'message-set');

    // HALF (i)
    const valueOnWire = hasClause(alpha, C.chat, chat);
    const secondValueOnWire = hasClause(beta, C.chat, chatBeta);
    const changeDiffered = Boolean(alpha?.request && beta?.request) && alpha.request.sha256 !== beta.request.sha256;
    const changeLostOld = !hasClause(beta, C.chat, chat);

    // WHICH MECHANISM PRODUCED THE RESOLUTION -- the claim is "the resolved value is on the wire", and "the MACRO
    // resolved it" is a separate, checkable fact rather than an inference. Three things are compared per probe case:
    //   promptRaw                    the string the prompt carried, e.g. `HV-READ-CHAT={{getvar::hv_chat}}`
    //   renderedWithMacroEngine      the host's own substitution of that same string (TavernHelper.substitudeMacros)
    //   request.body                 what the provider actually received
    // The mechanism is DEMONSTRATED, not assumed, when: the raw form still contains `{{getvar::`, the rendered form
    // does NOT, the rendered form carries the value, and the body carries the rendered form rather than the raw one.
    // A body that still held `{{getvar::...}}` would mean the macro never ran and the value came from somewhere else;
    // that case fails `macroWasTheResolver` rather than quietly satisfying the clause assertions.
    const mechanismOf = entry => {
        const raw = typeof entry?.promptRaw === 'string' ? entry.promptRaw : null;
        const rendered = typeof entry?.renderedWithMacroEngine === 'string' ? entry.renderedWithMacroEngine : null;
        const wire = body(entry);
        return {
            rawHasMacroSyntax: raw !== null && /\{\{get(?:global)?var::/.test(raw),
            renderedHasNoMacroSyntax: rendered !== null && !/\{\{get(?:global)?var::/.test(rendered),
            renderedCarriesValue: rendered !== null && (rendered.includes(chat) || rendered.includes(chatBeta) || rendered.includes(globalMark)),
            wireHasRenderedForm: rendered !== null && rendered.includes(C.chat ?? 'HV-READ-CHAT=') && wire.includes(String(rendered).split('\u0000')[0].slice(0, 60)),
            wireStillHasRawForm: raw !== null && wire.includes(raw),
            raw,
            rendered,
        };
    };
    const alphaMechanism = mechanismOf(alpha);
    const betaMechanism = mechanismOf(beta);
    const globalMechanism = mechanismOf(globalSet);
    const macroWasTheResolver = [alphaMechanism, betaMechanism].every(entry => entry.rawHasMacroSyntax)
        && [alphaMechanism, betaMechanism].every(entry => entry.renderedHasNoMacroSyntax)
        && [alphaMechanism, betaMechanism].every(entry => entry.renderedCarriesValue)
        && [alphaMechanism, betaMechanism].every(entry => entry.wireHasRenderedForm)
        && [alphaMechanism, betaMechanism, globalMechanism].every(entry => entry.wireStillHasRawForm === false);

    // THE ABSENT FORM. With the variable deleted the macro resolves to '' (public/scripts/variables.js:45,
    // `(localVariable || '')`), so the clause must be present with NOTHING after it -- the prompt still arrived, the
    // lookup produced nothing. A body missing the clause entirely is a different fact (the prompt did not arrive) and
    // is therefore NOT accepted here.
    const deleteIsEmptyForm = hasEmptyClause(deleted, C.chat);
    const deleteDroppedValue = !hasClause(deleted, C.chat, chat) && !hasClause(deleted, C.chat, chatBeta);
    // The deleted case's HARNESS mechanism: the rendered form must have collapsed to the bare clause, so the empty
    // wire form is the macro's own doing rather than a prompt that lost its text.
    const deleteMechanism = mechanismOf(deleted);
    const deleteMechanismShown = deleteMechanism.rawHasMacroSyntax === true
        && deleteMechanism.renderedHasNoMacroSyntax === true
        && typeof deleteMechanism.rendered === 'string'
        && deleteMechanism.rendered.trim().endsWith(String(C.chat ?? 'HV-READ-CHAT='));

    // SCOPES
    const globalOnWire = hasClause(globalSet, C.global, globalMark);
    // THE `message` SCOPE, AS ITS OWN ROW: stored in the page, and NOT on the wire.
    const messageStored = JSON.stringify(caseOf(leg, 'message-set')?.applied ?? null).includes(messageMark);
    const messageNotOnWire = Boolean(messageSet?.request) && !body(messageSet).includes(messageMark);
    // THE REFUSAL IS A PARITY FACT TOO. `src/function/variables.ts:58-63` bounds `message_id` to
    // `(-chat.length, chat.length)`, so on an EMPTY chat every message-scoped write is refused by range check -- pinned
    // behaving correctly. The probe seeds one message so the normal path can be measured; when the seed did not take,
    // the honest row is "both subjects refused identically", which IS the claim for that case. Refused-on-one /
    // stored-on-the-other lands in asymmetries and is refused there.
    const messageRefused = JSON.stringify(caseOf(leg, 'message-set')?.applied ?? null).includes('pinned range check');
    const messageRowComplete = messageStored || messageRefused;
    const chatSeedOk = leg?.chatSeed?.ok === true;

    // HALF (ii): DISK
    const chatVariables = Object.entries(leg?.disk?.chats ?? {})
        .flatMap(([file, record]) => Object.entries(record?.variables ?? {}).map(([name, value]) => ({ file, name, value })));
    // The value that must be on disk is whichever one the run left: alpha was overwritten by beta and then deleted,
    // so the surviving evidence is the REPLAYED case in the restart leg and the GLOBAL write, which nothing deletes.
    const globalOnDisk = JSON.stringify(leg?.disk?.settings?.variablesGlobal ?? null).includes(globalMark);
    const reloadWireValue = hasClause({ request: leg?.reload?.request ?? null }, C.chat, chat) || hasClause({ request: leg?.reload?.request ?? null }, C.chat, chatBeta);
    const reloadSawEmpty = hasEmptyClause({ request: leg?.reload?.request ?? null }, C.chat);
    // THE FRESH PAGE READ THE FILE, so one of the two states is what the CHAT FILE said.
    const survivesFreshPage = Boolean(leg?.reload?.request) && (reloadWireValue || reloadSawEmpty);

    // THE RESTART LEG: a NEW process over the tree the on-leg left.
    const restartCase = caseOf(restartLeg, 'reload-chat') ?? caseOf(restartLeg, 'chat-alpha');
    const restartWireValue = hasClause(restartCase, C.chat, chat) || hasClause(restartCase, C.chat, chatBeta) || hasEmptyClause(restartCase, C.chat);
    const restartIsNewProcess = Boolean(restartLeg?.provenance?.serverPid) && restartLeg?.provenance?.serverPid !== leg?.provenance?.serverPid;
    const survivesRestart = Boolean(restartCase?.request) && restartWireValue && restartIsNewProcess;

    // THE OFF CONTROL
    const offAlpha = caseOf(offLeg, 'chat-alpha');
    const offBeta = caseOf(offLeg, 'chat-deleted');
    const offHasNoValue = Boolean(offLeg)
        && !hasClause(offLeg && caseOf(offLeg, 'chat-alpha'), C.chat, chat)
        && !hasClause(offLeg && caseOf(offLeg, 'global-set'), C.global, globalMark)
        && Boolean(offAlpha?.request);
    // The two off captures must be byte-identical to each other: nothing was written between them, so a difference
    // would mean the harness changed something on its own.
    const offStable = Boolean(offAlpha?.request && offBeta?.request) && offAlpha.request.sha256 === offBeta.request.sha256;

    observed[subject] = {
        legPresent: Boolean(leg),
        apiSurface: leg?.apiSurface ? {
            pinnedCommit: leg.apiSurface.pinnedCommit,
            manifestVersion: leg.apiSurface.manifestVersion,
            scopes: Object.keys(leg.apiSurface.scopes ?? {}),
            exportCount: Object.keys(leg.apiSurface.exports ?? {}).length,
            absentConfirmed: (leg.apiSurface.absentConfirmed ?? []).map(entry => entry.name),
        } : null,
        halfI: { valueOnWire, secondValueOnWire, changeDiffered, changeLostOld, macroWasTheResolver, deleteIsEmptyForm, deleteDroppedValue, deleteMechanismShown },
        mechanism: { alpha: alphaMechanism, beta: betaMechanism, global: globalMechanism, deleted: deleteMechanism },
        scopes: { globalOnWire, messageStored, messageNotOnWire, messageRefused, messageRowComplete, chatSeedOk },
        halfII: { chatVariableNames: [...new Set(chatVariables.map(entry => entry.name))], globalOnDisk, survivesFreshPage, survivesRestart, restartIsNewProcess },
        offControl: { offHasNoValue, offStable },
        captures: (leg?.cases ?? []).map(entry => ({ case: entry.case, sha256: entry.request?.sha256 ?? null, byteLength: entry.request?.byteLength ?? null, arrived: Boolean(entry.request), error: entry.error ?? null })),
        timings: leg?.timings?.phases ?? null,
        failure: leg?.failure ?? null,
    };
}

const guards = {};
const subjectGuards = {
    legsPresent: subjects.map(subject => observed[subject].legPresent),
    sameApiSurface: subjects.map(subject => {
        const surface = observed[subject].apiSurface;
        return Boolean(surface) && surface.pinnedCommit === (on.pinned?.apiSurface?.pinnedCommit ?? null) && surface.scopes.length === 7 && surface.exportCount >= 14;
    }),
    // HALF (i)
    valueOnWire: subjects.map(subject => observed[subject].halfI.valueOnWire),
    // THE MECHANISM, as its own guard: the resolved value being on the wire and the MACRO resolving it are different
    // facts, and only the second one makes this a test of 酒馆助手's variables rather than of the harness's own string.
    macroWasTheResolver: subjects.map(subject => observed[subject].halfI.macroWasTheResolver),
    changeChangesTheWire: subjects.map(subject => observed[subject].halfI.secondValueOnWire && observed[subject].halfI.changeDiffered && observed[subject].halfI.changeLostOld),
    deleteReturnsToEmptyForm: subjects.map(subject => observed[subject].halfI.deleteIsEmptyForm && observed[subject].halfI.deleteDroppedValue && observed[subject].halfI.deleteMechanismShown),
    // SCOPES
    globalScopeReachesWire: subjects.map(subject => observed[subject].scopes.globalOnWire),
    // Either the write landed and stayed off the wire, or it was refused identically on both subjects. Both are the
    // claim for this row; only one subject refusing would surface as an asymmetry.
    messageStoredNotSurfaced: subjects.map(subject => observed[subject].scopes.chatSeedOk
        ? (observed[subject].scopes.messageStored && observed[subject].scopes.messageNotOnWire)
        : observed[subject].scopes.messageRefused),
    // HALF (ii)
    survivesFreshPage: subjects.map(subject => observed[subject].halfII.survivesFreshPage),
    survivesRestart: subjects.map(subject => observed[subject].halfII.survivesRestart),
    // THE PAIR IS DISCRIMINATING
    offIsTheControl: subjects.map(subject => observed[subject].offControl.offHasNoValue && observed[subject].offControl.offStable),
};

const asymmetries = [];
for (const [name, values] of Object.entries(subjectGuards)) {
    const trueCount = values.filter(Boolean).length;
    if (trueCount > 0 && trueCount < values.length) asymmetries.push({ guard: name, gotavern: values[0], pinned: values[1] });
    guards[name] = trueCount === values.length;
}

// nodeEqualsGo: the provider-wire contract, case by case.
const mismatches = [];
for (const name of new Set((on.gotavern?.cases ?? []).map(entry => entry.case))) {
    const mine = caseOf(on.gotavern, name)?.request ?? null;
    const theirs = caseOf(on.pinned, name)?.request ?? null;
    if (JSON.stringify(mine?.sha256 ?? null) !== JSON.stringify(theirs?.sha256 ?? null)) mismatches.push({ case: name, field: 'sha256', gotavern: mine?.sha256 ?? null, pinned: theirs?.sha256 ?? null });
    if (JSON.stringify(mine?.byteLength ?? null) !== JSON.stringify(theirs?.byteLength ?? null)) mismatches.push({ case: name, field: 'byteLength', gotavern: mine?.byteLength ?? null, pinned: theirs?.byteLength ?? null });
    if (JSON.stringify(body({ request: mine })) !== JSON.stringify(body({ request: theirs }))) mismatches.push({ case: name, field: 'body', gotavern: mine?.sha256 ?? null, pinned: theirs?.sha256 ?? null });
}
guards.nodeEqualsGo = mismatches.length === 0;

if (DRIVE_STEP_FAILURES.length > 0) guards.driveCompleted = false;
else guards.driveCompleted = true;
const missingLegs = Object.entries(legs).filter(([, entry]) => !entry.present).map(([key, entry]) => `${key}${entry.path ? ` (${entry.path}: ${entry.error ?? 'absent'})` : ''}`);
if (missingLegs.length > 0) guards.legsPresent = false;

const unprovenEntries = [
    'a real provider: the peer is an in-process simulated backend, so rule 22 makes every wire measurement here unverified for PRODUCTION. What is proven is the frontend+helper transform, not the transport to a live endpoint.',
    'the `preset` and `character` scopes: this vehicle writes chat, global and message only. The preset scope needs a preset to exist, which is the SECOND probe (helper-vars-probe.mjs) and the harder vehicle for that narrower purpose.',
    'streaming / cancellation: every generateRaw sets should_stream false so the peer can answer without SSE framing.',
    'the `script` and `extension` scopes: both exist at the pinned commit and neither has a host macro, so neither can reach a provider request; recorded in apiSurface.scopes and not driven.',
];
const guardMechanisms = {
    survivesRestart: () => `the restart leg did not show the value from the tree: restartPids=${JSON.stringify(subjects.map(subject => restart[subject]?.provenance?.serverPid ?? null))}, onPids=${JSON.stringify(subjects.map(subject => on[subject]?.provenance?.serverPid ?? null))}. A restart leg that did not boot a NEW process is a harness failure, not a product finding.`,
    offIsTheControl: () => `the off legs did not behave as a control: offHasNoValue=${JSON.stringify(subjects.map(subject => observed[subject].offControl.offHasNoValue))} offStable=${JSON.stringify(subjects.map(subject => observed[subject].offControl.offStable))}. A pair whose on and off captures are identical is HARNESS NON-DISCRIMINATING (rule 50).`,
};
for (const [name, mechanism] of Object.entries(guardMechanisms)) {
    if (guards[name] !== true) unprovenEntries.push(`${name}: ${mechanism()}`);
}
const declaredUnproven = new Set(unprovenEntries.map(entry => String(entry).split(':')[0].trim()));

const failedGuards = Object.entries(guards)
    .filter(([name, value]) => value !== true && !declaredUnproven.has(name))
    .map(([name]) => name);
for (const name of ['driveCompleted', 'legsPresent']) if (guards[name] === false && !failedGuards.includes(name)) failedGuards.push(name);

const artefact = {
    schemaVersion: 1,
    question: 'Does a 酒馆助手 variable resolve into the FINAL provider request during a real generateRaw, and is it still readable from disk after a fresh page and a new server process?',
    generatedBy: 'tests/browser/compare-helper-vars-generate-legs.mjs',
    vehicle: on.gotavern?.vehicle ?? on.pinned?.vehicle ?? null,
    uiVehicleRedRuns: on.gotavern?.uiVehicleRedRuns ?? on.pinned?.uiVehicleRedRuns ?? null,
    subject: 'tavern-helper@837a6288135cde61522a9279173b98020f08807e (manifest 4.11.3), host SillyTavern 06bde939fb1e9c4c8d8641d810f0a9165b5ce127',
    surface: 'variables through the host macro engine (Q10), narrow vehicle',
    verdict: failedGuards.length === 0 && asymmetries.length === 0 ? 'PASS' : 'FAIL',
    guards,
    failedGuards,
    driveStepFailures: DRIVE_STEP_FAILURES,
    missingLegs,
    asymmetries,
    mismatches,
    marks: MARKS,
    clauses: C,
    apiSurface: { gotavern: observed.gotavern?.apiSurface ?? null, pinned: observed.pinned?.apiSurface ?? null },
    unproven: unprovenEntries,
    declaredUnproven: [...declaredUnproven].sort(),
    subjects: observed,
    answers: {
        // THE SCOPE OF THIS CLAIM, stated as narrowly as it is true. `generateRaw` with ordered_prompts and
        // max_chat_history:0 is a DIFFERENT assembly from an ordinary `Generate` turn, so a green here says exactly
        // this and no more. The UI vehicle is the evidence for the other half; the two together are stronger than
        // either stretched.
        'Q10 do variables reach the final request': 'guards.valueOnWire + guards.macroWasTheResolver + guards.changeChangesTheWire + guards.deleteReturnsToEmptyForm -- on the RAW BODY BYTES, at the clause the prompt carries. SCOPE: generateRaw\'s ordered_prompts assembly, NOT an ordinary chat-completion turn; the claim supported is "a chat-scoped helper variable reaches the wire through generateRaw\'s ordered prompts and the host macro engine", not "through an ordinary Generate turn".',
        'Q10 persistence': 'guards.survivesFreshPage + guards.survivesRestart -- a fresh page and a NEW server process',
        'scope isolation / second scope': 'guards.globalScopeReachesWire',
        'message scope': 'guards.messageStoredNotSurfaced -- a FINDING: stored in the page, absent from the wire because no host macro reads a message scope',
        'not exercised here': 'preset and character scopes (the UI-vehicle probe), real provider, streaming (see unproven[])',
    },
    legs: Object.fromEntries(Object.entries(legs).map(([key, value]) => [key, { present: value.present, path: value.path, subject: value.leg?.subject ?? null, variant: value.leg?.variant ?? null, afterRestart: value.leg?.afterRestart ?? null, failure: value.leg?.failure ?? null, cases: (value.leg?.cases ?? []).map(entry => entry.case), steps: (value.leg?.steps ?? []).map(item => `${item.ok === null ? 'n/a' : item.ok ? 'ok' : 'FAIL'} ${item.name}`) }])),
};

const serialised = `${JSON.stringify(artefact, null, 2)}\n`;
if (artefactPath) await fs.writeFile(artefactPath, serialised);
process.stdout.write(serialised);
if (failedGuards.length > 0 || asymmetries.length > 0) {
    console.error(`helper variables (narrow) comparison FAILED: guards=[${failedGuards.join(', ')}] asymmetries=[${asymmetries.map(item => item.guard).join(', ')}] mismatches=[${mismatches.map(item => `${item.case}.${item.field}`).join(', ')}]`);
    if (DRIVE_STEP_FAILURES.length > 0) console.error(`drive steps that did not happen:\n  ${DRIVE_STEP_FAILURES.join('\n  ')}`);
    if (missingLegs.length > 0) console.error(`legs missing (a leg whose \`if:\` was false reports nothing, so this is a NAMED refusal):\n  ${missingLegs.join('\n  ')}`);
    process.exitCode = 1;
}
