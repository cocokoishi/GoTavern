// JUDGE the 酒馆助手 VARIABLE / INJECTION surface: {gotavern, pinned} x {on, off} x {first process, restarted}.
//
// THE CLAIM THIS ARTEFACT IS ALLOWED TO MAKE, in the two halves the probe drives:
//   (i)  a live preset prompt's `{{getvar::x}}` resolves the helper's value during an ordinary Generate, and the
//        resolved text is in `messages[]` on the wire;
//   (ii) that value is re-readable from DISK after a fresh page and after a NEW server process.
// Both halves must hold on BOTH subjects, and every case must DIFFER from its predecessor in a way attributed to
// the variable rather than to a timestamp.
//
// THE VERDICT MECHANIC (the same one compare-helper-legs.mjs and compare-asset-legs.mjs use, because a third
// vocabulary would make three artefacts that cannot be read together):
//   guards.<name>            TRUE only when true on BOTH subjects.
//   false on BOTH            a DRIVER LIMITATION (AGENTS 10) -- allowed ONLY when unproven[] names it with a
//                            mechanism, and then it is NOT evidence for anything.
//   true on ONE              an ASYMMETRY: never declarable, always fails. That difference is the whole point.
//   false on both, undeclared an undeclared gap: a red.
//
// WHY THIS SURFACE IS SEPARATE FROM helper-generation-comparison.json. That artefact drives
// `generate({injects:[...]})`, which passes the injection INTO the extension (generate/generateRaw.ts:281-414) and
// never touches `extension_prompts`. This leg drives `injectPrompts` -> `setExtensionPrompt`
// (src/function/inject.ts:21-55 -> public/script.js:8926) -> `populationInjectionPrompts`
// (public/scripts/openai.js:810-875). Two different mechanisms, so two different artefacts: a green on one says
// nothing about the other, and mixing them would make one red unattributable.
//
// WHAT IT NEVER DOES: it writes no expected provider body (rule 49). Every assertion is either `Node == Go` on the
// captured bytes, or a property of an input this leg supplied (a token it set, a marker it injected) -- and for a
// property the pinned leg is still read, because "the token is present" and "the token is present in the pinned
// position" are different claims.

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

// A DRIVE STEP THAT DID NOT HAPPEN MAKES EVERYTHING AFTER IT UNATTRIBUTABLE (rule 10), so these fail by name and are
// never excusable. Everything else is a guard the subjects are compared on.
const DRIVE_STEPS = new Set([
    'page-loaded', 'card-opened', 'ready-preset-selected', 'ready-provider-reached', 'capture-shape-identified',
    'trio-selected', 'fixture-written', 'extension-is-pinned', 'api-surface-recorded',
    'restart-tree-carries-the-fixture', 'restart-trio-selected',
]);
const DRIVE_STEP_FAILURES = [];
for (const [label, entry] of Object.entries(legs)) {
    for (const item of entry.leg?.steps ?? []) {
        if (item.ok === false && DRIVE_STEPS.has(item.name)) DRIVE_STEP_FAILURES.push(`${label}: ${item.name}: ${item.detail ?? 'failed'}`);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// PER-SUBJECT OBSERVATIONS. Everything the guards are computed from, so a red names a value rather than a verdict.
// ---------------------------------------------------------------------------------------------------------------
const caseOf = (leg, name) => (leg?.cases ?? []).find(entry => entry.case === name) ?? null;
const wire = (leg, name) => caseOf(leg, name)?.request ?? null;
const unitsOf = wire => (wire?.units ?? []).map(unit => String(unit.content ?? ''));
const anyUnitHas = (wireEntry, needle) => unitsOf(wireEntry).some(content => content.includes(needle));
const unitIndex = (wireEntry, needle) => unitsOf(wireEntry).findIndex(content => content.includes(needle));
/** `value` is a marker this leg chose, but escaping it keeps a future marker with regex metacharacters from silently
 *  turning `RESOLVED.*` into a pattern that matches anything. */
const escapeRegExp = value => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MARKERS = on.gotavern?.markers ?? on.pinned?.markers ?? null;

const observed = {};
for (const subject of subjects) {
    const leg = on[subject];
    const offLeg = off[subject];
    const restartLeg = restart[subject];
    const units = leg?.units ?? null;

    // ---- HALF (i): the resolved value is on the wire ------------------------------------------------------
    const alpha = wire(leg, 'chat-alpha');
    const beta = wire(leg, 'chat-beta');
    const deleted = wire(leg, 'chat-deleted');
    const globalSet = wire(leg, 'global-set');
    const characterSet = wire(leg, 'character-set');
    const nestedSet = wire(leg, 'nested-set');
    const messageSet = wire(leg, 'message-set');
    const ready = wire(leg, 'ready');
    const chatTwo = wire(leg, 'chat-two');
    const chatTwoSet = wire(leg, 'chat-two-set');

    // A POSITIVE ASSERTION ON THE WIRE CONTENT, NOT ONLY ON DIGEST EQUALITY.
    //
    // This is the guard that can fail when the two subjects AGREE AND ARE BOTH WRONG -- a pair of identical requests
    // that both lack the resolved value would otherwise pass `nodeEqualsGo` and every digest comparison. So the
    // assertion is on the REQUEST BODY BYTES: the raw body must contain the exact `marker=value` clause the trio's
    // identity prompt contains, at the position the prompt puts it (`HV-IDENTITY-CHAT=<value>`).
    //
    // It is deliberately NOT `anyUnitHas(token)`: a body that merely echoes the token somewhere -- a settings dump, a
    // second-generation prompt, a stashed variable in a provider-extension member -- would satisfy a substring test
    // while the macro never resolved. Matching `HV-IDENTITY-CHAT=` + value + a boundary means the value arrived WHERE
    // THE PROMPT ASKED FOR IT.
    const RESOLVED = {
        chat: value => new RegExp(`HV-IDENTITY-CHAT=${escapeRegExp(value)}(?![\\w-])`),
        global: value => new RegExp(`HV-IDENTITY-GLOBAL=${escapeRegExp(value)}(?![\\w-])`),
        char: value => new RegExp(`HV-IDENTITY-CHAR=${escapeRegExp(value)}(?![\\w-])`),
        nested: value => new RegExp(`HV-IDENTITY-NESTED=${escapeRegExp(value)}(?![\\w-])`),
        chatEmpty: () => /HV-IDENTITY-CHAT=\|/,
    };
    const rawBody = entry => String(entry?.body ?? '');
    const bodyMatches = (entry, pattern) => Boolean(entry) && pattern.test(rawBody(entry));

    const alphaHasValue = bodyMatches(alpha, RESOLVED.chat(MARKERS?.first ?? 'HV-MARKET-ALPHA'));
    const betaHasValue = bodyMatches(beta, RESOLVED.chat(MARKERS?.second ?? 'HV-MARKET-BETA'));
    // THE CHANGE, AND ITS ATTRIBUTION. Two requests that differ prove nothing on their own -- two timestamps differ.
    // So: the two captures must differ, AND each must carry ITS OWN value AT ITS OWN CLAUSE, AND the later one must
    // not carry the earlier one's. Without the last part a subject whose macro resolved to a constant would pass:
    // both bodies would "have a value" while the variable did nothing.
    const alphaBetaDiffer = Boolean(alpha && beta) && alpha.sha256 !== beta.sha256;
    const betaLostOld = !bodyMatches(beta, RESOLVED.chat(MARKERS?.first ?? 'HV-MARKET-ALPHA'));
    const deleteRemoved = Boolean(deleted)
        && !bodyMatches(deleted, RESOLVED.chat(MARKERS?.first ?? 'HV-MARKET-ALPHA'))
        && !bodyMatches(deleted, RESOLVED.chat(MARKERS?.second ?? 'HV-MARKET-BETA'));
    // THE PARENT FORM: with the variable deleted the macro resolves to '', so the trio's identity unit must be the
    // one the SAME preset produces when the variable was never set -- never the READY preset's, which carries no
    // identity prompt at all (the probe passes `identity: ''` for it) and would have made this guard impossible to
    // satisfy rather than hard to satisfy. The parent is `chat-two` when chat two never set `market_value`, and the
    // probe also records a `chat-deleted` capture taken AFTER the delete in the same chat, which is the direct form.
    const deletedIdentity = deleted ? unitsOf(deleted).find(content => content.startsWith('HV-IDENTITY-CHAT=')) ?? null : null;
    // THE EMPTY RESOLUTION, asserted as text: the lookups must have collapsed to nothing, i.e. the unit still exists
    // (the prompt is in the request) but the macro produced no token between its markers.
    const deleteCollapsed = deletedIdentity !== null && /HV-IDENTITY-CHAT=\|/.test(deletedIdentity);
    const deleteReturnedToParent = deletedIdentity !== null && deleteCollapsed;

    // ---- HALF (ii): the value is on DISK, and survives a fresh page and a new process ---------------------
    const chatRecordsAfterSession = leg?.disk?.chats ?? {};
    const chatVariablesOnDisk = Object.entries(chatRecordsAfterSession)
        .flatMap(([file, record]) => Object.entries(record?.variables ?? {}).map(([name, value]) => ({ file, name, value })));
    const chatValueOnDisk = chatVariablesOnDisk.some(entry => JSON.stringify(entry.value ?? '').includes(MARKERS?.first ?? 'HV-MARKET-ALPHA'))
        || chatVariablesOnDisk.some(entry => JSON.stringify(entry.value ?? '').includes(MARKERS?.chatTwo ?? 'HV-MARKET-CHAT-TWO'));
    const globalOnDisk = JSON.stringify(leg?.disk?.settings?.variablesGlobal ?? null).includes(MARKERS?.global ?? 'HV-ROLE-SIGNAL');
    const characterOnDisk = Object.values(leg?.disk?.card ?? {})
        .some(card => JSON.stringify(card?.tavernHelper?.variables ?? null).includes(MARKERS?.charScope ?? 'HV-CHAR-SCOPE'));

    // THE SAME VALUE, FROM THE FILES A NEW PROCESS WOULD READ. `diskAfterReload` is taken after the SECOND page, so
    // a value that only ever lived in the first page's memory cannot appear there.
    const reloadChatVariables = Object.entries(leg?.diskAfterReload?.chats ?? {})
        .flatMap(([file, record]) => Object.entries(record?.variables ?? {}).map(([name, value]) => ({ file, name, value })));
    const chatValueSurvivesReload = reloadChatVariables.some(entry => JSON.stringify(entry.value ?? '').includes(MARKERS?.first ?? 'HV-MARKET-ALPHA'))
        || reloadChatVariables.some(entry => JSON.stringify(entry.value ?? '').includes(MARKERS?.chatTwo ?? 'HV-MARKET-CHAT-TWO'));
    const globalSurvivesReload = JSON.stringify(leg?.diskAfterReload?.settings?.variablesGlobal ?? null).includes(MARKERS?.global ?? 'HV-ROLE-SIGNAL');
    const characterSurvivesReload = Object.values(leg?.diskAfterReload?.card ?? {})
        .some(card => JSON.stringify(card?.tavernHelper?.variables ?? null).includes(MARKERS?.charScope ?? 'HV-CHAR-SCOPE'));
    // THE FRESH PAGE'S OWN WIRE, not only the files: the reload case's capture must carry a value that the FRESH page
    // resolved, which is only possible if it read the chat file. Asserted at the CLAUSE, like every other wire claim.
    const reloadWire = wire(leg, 'reload-chat-value');
    const reloadWireHasValue = bodyMatches(reloadWire, RESOLVED.chat(MARKERS?.first ?? 'HV-MARKET-ALPHA'))
        || bodyMatches(reloadWire, RESOLVED.chat(MARKERS?.chatTwo ?? 'HV-MARKET-CHAT-TWO'));

    // THE RESTART LEG's own evidence: a different process, the same tree, the same resolved value on the wire.
    const restartWire = wire(restartLeg, 'restart-chat-value');
    const restartHasValue = bodyMatches(restartWire, RESOLVED.chat(MARKERS?.first ?? 'HV-MARKET-ALPHA'))
        || bodyMatches(restartWire, RESOLVED.chat(MARKERS?.chatTwo ?? 'HV-MARKET-CHAT-TWO'));
    const restartIsNewProcess = Boolean(restartLeg?.provenance?.serverPid) && restartLeg?.provenance?.serverPid !== leg?.provenance?.serverPid;

    // ---- SCOPES AND ISOLATION ---------------------------------------------------------------------------
    const globalHasValue = bodyMatches(globalSet, RESOLVED.global(MARKERS?.global ?? 'HV-ROLE-SIGNAL'));
    const characterHasValue = bodyMatches(characterSet, RESOLVED.char(MARKERS?.charScope ?? 'HV-CHAR-SCOPE'));
    // THE NESTED VALUE, through {{getvarkey::market_object::tier}}. The pinned reader JSON.stringifies an object and
    // indexes it, so the resolved text is the bare value; the guard asserts the VALUE AT THE CLAUSE, not the JSON.
    const nestedHasValue = bodyMatches(nestedSet, RESOLVED.nested('gold'));
    // THE CHAT-SCOPE LEAK, both directions. Chat two must NOT carry chat one's value at its own clause, and chat two's
    // OWN value must come back on its own request -- otherwise "no leak" would be satisfied by a chat scope that
    // never works at all.
    const chatTwoLeaks = bodyMatches(chatTwo, RESOLVED.chat(MARKERS?.first ?? 'HV-MARKET-ALPHA'));
    const chatTwoOwn = bodyMatches(chatTwoSet, RESOLVED.chat(MARKERS?.chatTwo ?? 'HV-MARKET-CHAT-TWO'));
    const globalNotChatScoped = globalHasValue && bodyMatches(chatTwo, RESOLVED.global(MARKERS?.global ?? 'HV-ROLE-SIGNAL'));

    // ---- THE `message` SCOPE: stored, NOT surfaced -------------------------------------------------------
    // Pinned stores and retrieves it inside the page (:58-71) and no host macro reads it, so the honest assertions
    // are (a) the page retrieved what it wrote and (b) the wire does NOT carry it.
    const messageApplied = (caseOf(leg, 'message-set')?.applied ?? []).find(entry => entry?.op?.action === 'message') ?? null;
    const messageStored = JSON.stringify(messageApplied?.stored ?? null).includes(MARKERS?.messageScope ?? 'HV-MESSAGE-SCOPE');
    const messageNotOnWire = Boolean(messageSet) && !anyUnitHas(messageSet, MARKERS?.messageScope ?? 'HV-MESSAGE-SCOPE');

    // ---- INJECTION: position by MEASURED index, then removal ----------------------------------------------
    // Depth d is NOT "the d-th message". `populationInjectionPrompts` reverses the history and then splices per
    // depth at `injectIdx = i + totalInsertedMessages` with a per-role insert counter (openai.js:820-871), so the
    // index pinned produces is a property of the message COUNT, which is why the index is read from the capture and
    // compared across subjects rather than computed from a formula in this file. The offset the formula would give
    // is recorded beside it so a shifted implementation is a named value instead of a red with no cause.
    //
    // THE MARKER COMES FROM THE CASE'S OWN OP, NOT FROM ITS NAME. The first version derived it with
    // `name.slice(-2).toUpperCase()` and produced `HV-INJECT-PROBE-` + `D2` = `HV-INJECT-PROBE-D2`, which happens to
    // match -- by luck, because the depth digit is one character. A depth of 10 would have read the probe's content
    // back as `...-0` and searched for a marker no request carries, turning "the injection was placed" into a
    // silent false-on-both. The content is what was injected, so the content is what is searched for.
    const injectionIndex = name => {
        const entry = caseOf(leg, name);
        const injected = (entry?.applied ?? []).filter(item => item?.op?.action === 'inject').map(item => String(item.op.content ?? ''));
        const content = injected.at(-1) ?? null;
        const request = entry?.request ?? null;
        const index = content && request ? unitIndex(request, content) : -1;
        return {
            depth: entry?.applied?.find(item => item?.op?.action === 'inject')?.op?.depth ?? null,
            marker: content,
            index,
            length: request?.units?.length ?? null,
            role: index >= 0 ? (request.units[index]?.role ?? null) : null,
        };
    };
    const d0 = injectionIndex('inject-d0');
    const d1 = injectionIndex('inject-d1');
    const d2 = injectionIndex('inject-d2');
    const uninjectedEntry = caseOf(leg, 'uninject');
    const uninjected = uninjectedEntry?.request ?? null;
    const injectionPlaced = entry => entry.index >= 0 && entry.length > 0;
    // THE OFFSET THE PINNED FORMULA PREDICTS, recorded next to the measured index: `length - 1 - depth` when the
    // injection is the only one at its depth and no role inserted before it. A measured index that disagrees with
    // this is still authoritative (the pin is the oracle), but the disagreement is a field a reader can act on.
    const offsets = {
        d0: d0.index < 0 ? null : d0.length - 1 - d0.index,
        d1: d1.index < 0 ? null : d1.length - 1 - d1.index,
        d2: d2.index < 0 ? null : d2.length - 1 - d2.index,
    };
    // REMOVAL IS PROVEN FROM THE PROBE'S OWN RECORD, NOT ONLY FROM THE ABSENT MARKER: `uninjectPrompts` deletes
    // extension_prompts[id] (src/function/inject.ts:57-61) and the probe reads `stillPresent` immediately after.
    const uninjectApplied = (uninjectedEntry?.applied ?? []).find(item => item?.op?.action === 'uninject') ?? null;
    const injectionRemoved = Boolean(uninjected)
        && uninjectApplied?.stillPresent === false
        && !anyUnitHas(uninjected, MARKERS?.injection ?? 'HV-INJECT-PROBE');

    // ---- THE OFF CONTROL: nothing written, nothing injected ----------------------------------------------
    // Every off capture must equal the READY form. A pair whose on and off captures are identical is HARNESS
    // NON-DISCRIMINATING (rule 50), so both directions are recorded.
    const offReady = wire(offLeg, 'ready');
    const offAlpha = wire(offLeg, 'chat-alpha');
    const offValuesAbsent = offLeg
        ? ![MARKERS?.first, MARKERS?.second, MARKERS?.global, MARKERS?.charScope, MARKERS?.injection].some(marker => marker && (anyUnitHas(offAlpha, marker) || anyUnitHas(offLeg.cases?.find(entry => entry.case === 'inject-d2')?.request, marker)))
        : false;
    const offEqualsReadyForm = Boolean(offReady && offAlpha) && offReady.sha256 === offAlpha.sha256;

    observed[subject] = {
        legPresent: Boolean(leg),
        units,
        captures: (leg?.cases ?? []).map(entry => ({ case: entry.case, sha256: entry.request?.sha256 ?? null, byteLength: entry.request?.byteLength ?? null, arrived: Boolean(entry.request) })),
        halfI: { alphaHasValue, betaHasValue, alphaBetaDiffer, betaLostOld, deleteRemoved, deleteCollapsed, deleteReturnedToParent },
        halfII: { chatValueOnDisk, globalOnDisk, characterOnDisk, chatValueSurvivesReload, globalSurvivesReload, characterSurvivesReload, reloadWireHasValue, restartHasValue, restartIsNewProcess },
        scopes: { globalHasValue, characterHasValue, nestedHasValue, chatTwoLeaks, chatTwoOwn, globalNotChatScoped },
        messageScope: { messageStored, messageNotOnWire },
        injection: { d0, d1, d2, offsets, injectionPlaced: injectionPlaced(d0) && injectionPlaced(d1) && injectionPlaced(d2), injectionRemoved, uninjectApplied: uninjectApplied ?? null },
        offControl: { offValuesAbsent, offEqualsReadyForm },
        disk: {
            chatVariables: chatVariablesOnDisk.map(entry => ({ file: entry.file, name: entry.name })),
            globalVariables: Object.keys(leg?.disk?.settings?.variablesGlobal ?? {}),
            characterVariables: Object.values(leg?.disk?.card ?? {}).map(card => Object.keys(card?.tavernHelper?.variables ?? {})),
            requests: leg?.disk?.requests ?? null,
        },
        apiSurface: leg?.apiSurface ? {
            pinnedCommit: leg.apiSurface.pinnedCommit,
            manifestVersion: leg.apiSurface.manifestVersion,
            scopes: Object.keys(leg.apiSurface.scopes ?? {}),
            exportCount: Object.keys(leg.apiSurface.exports ?? {}).length,
            absentConfirmed: (leg.apiSurface.absentConfirmed ?? []).map(entry => entry.name),
        } : null,
        failure: leg?.failure ?? null,
        pageErrors: leg?.pageErrors ?? null,
    };
}

// ---------------------------------------------------------------------------------------------------------------
// THE GUARDS.
// ---------------------------------------------------------------------------------------------------------------
const guards = {};
// THE PINNED COMMIT AS A LITERAL, NOT AS THE OTHER LEG'S RECORD. `surface.pinnedCommit ===
// (on.pinned?.apiSurface?.pinnedCommit ?? null)` compared the PINNED subject against ITSELF -- the right side
// is the very object the left side came from -- so the pinned half of this guard could not fail, and a run
// whose extension was not the pinned revision would have passed on both subjects as long as they agreed.
// The revision is part of the claim (the semantics were read from ONE commit), so it is compared against the
// literal that `tools/browser-evidence/other-surfaces.mjs` already pins the committed artefact to.
const PINNED_HELPER_COMMIT = '837a6288135cde61522a9279173b98020f08807e';
const subjectGuards = {
    legsPresent: subjects.map(subject => observed[subject].legPresent),
    sameApiSurface: subjects.map(subject => {
        const surface = observed[subject].apiSurface;
        return Boolean(surface) && surface.pinnedCommit === PINNED_HELPER_COMMIT && surface.scopes.length === 7;
    }),

    // HALF (i)
    valueOnWire: subjects.map(subject => observed[subject].halfI.alphaHasValue),
    changeChangesTheWire: subjects.map(subject => observed[subject].halfI.alphaHasValue && observed[subject].halfI.betaHasValue && observed[subject].halfI.alphaBetaDiffer && observed[subject].halfI.betaLostOld),
    deleteReturnsToParent: subjects.map(subject => observed[subject].halfI.deleteRemoved && observed[subject].halfI.deleteReturnedToParent),

    // HALF (ii)
    valueOnDisk: subjects.map(subject => observed[subject].halfII.chatValueOnDisk),
    globalOnDisk: subjects.map(subject => observed[subject].halfII.globalOnDisk),
    characterOnDisk: subjects.map(subject => observed[subject].halfII.characterOnDisk),
    survivesFreshPage: subjects.map(subject => observed[subject].halfII.chatValueSurvivesReload && observed[subject].halfII.reloadWireHasValue),
    survivesRestart: subjects.map(subject => observed[subject].halfII.restartHasValue && observed[subject].halfII.restartIsNewProcess),

    // SCOPES
    globalScopeReachesWire: subjects.map(subject => observed[subject].scopes.globalHasValue),
    characterScopeReachesWire: subjects.map(subject => observed[subject].scopes.characterHasValue),
    nestedValueResolves: subjects.map(subject => observed[subject].scopes.nestedHasValue),
    chatScopeIsolated: subjects.map(subject => observed[subject].scopes.chatTwoOwn && !observed[subject].scopes.chatTwoLeaks),
    globalScopeNotChatScoped: subjects.map(subject => observed[subject].scopes.globalNotChatScoped),
    // THE MESSAGE ROW IS A FINDING, ASSERTED BOTH WAYS: stored in the page, absent from the wire.
    messageStoredNotSurfaced: subjects.map(subject => observed[subject].messageScope.messageStored && observed[subject].messageScope.messageNotOnWire),

    // INJECTION
    injectionPlaced: subjects.map(subject => observed[subject].injection.injectionPlaced),
    injectionRemoved: subjects.map(subject => observed[subject].injection.injectionRemoved),

    // THE PAIR IS DISCRIMINATING
    offIsTheControl: subjects.map(subject => observed[subject].offControl.offValuesAbsent && observed[subject].offControl.offEqualsReadyForm),
};

const asymmetries = [];
for (const [name, values] of Object.entries(subjectGuards)) {
    const trueCount = values.filter(Boolean).length;
    if (trueCount > 0 && trueCount < values.length) asymmetries.push({ guard: name, gotavern: values[0], pinned: values[1] });
    guards[name] = trueCount === values.length;
}

// nodeEqualsGo: the provider-wire contract, case by case. A byte difference in ANY case is the product claim.
const mismatches = [];
for (const name of new Set((on.gotavern?.cases ?? []).map(entry => entry.case))) {
    const mine = wire(on.gotavern, name);
    const theirs = wire(on.pinned, name);
    if (JSON.stringify(mine?.sha256 ?? null) !== JSON.stringify(theirs?.sha256 ?? null)) {
        mismatches.push({ case: name, field: 'sha256', gotavern: mine?.sha256 ?? null, pinned: theirs?.sha256 ?? null });
    }
    if (JSON.stringify(mine?.byteLength ?? null) !== JSON.stringify(theirs?.byteLength ?? null)) {
        mismatches.push({ case: name, field: 'byteLength', gotavern: mine?.byteLength ?? null, pinned: theirs?.byteLength ?? null });
    }
    if (JSON.stringify(mine?.units ?? null) !== JSON.stringify(theirs?.units ?? null)) {
        mismatches.push({ case: name, field: 'units', gotavern: mine?.units ?? null, pinned: theirs?.units ?? null });
    }
}
// The injection POSITION is compared as a number, because that is the claim: a same-bytes-different-position
// implementation would not exist, but a different position with different bytes must still be named as one.
for (const depth of ['d0', 'd1', 'd2']) {
    const mine = on.gotavern ? observed.gotavern?.injection?.[depth]?.index ?? null : null;
    const theirs = on.pinned ? observed.pinned?.injection?.[depth]?.index ?? null : null;
    if (mine !== theirs) mismatches.push({ case: `inject-${depth}`, field: 'injectionIndex', gotavern: mine, pinned: theirs });
}
guards.nodeEqualsGo = mismatches.length === 0;

// ---- DECLARATIONS -----------------------------------------------------------------------------------------
// A FALSE-ON-BOTH GUARD IS ONLY EXCUSABLE WITH A NAMED MECHANISM, AND ONLY WHILE IT IS FALSE. Each mechanism is a
// property of the DRIVER or of the pinned version, never of a subject -- an excuse that covered one subject would
// be an asymmetry wearing a hat, which the asymmetries[] check already refuses.
const unprovenEntries = [
    'a real provider: the peer is an in-process simulated backend, so rule 22 makes every wire measurement here unverified for PRODUCTION. What is proven is the frontend+helper transform, not the transport to a live endpoint.',
    'streaming / cancellation: every case sends non-streamed so the peer can answer without SSE framing; those surfaces belong to the stream and cancel legs.',
    'samplers, tools, tool_choice, json_schema and reasoning: not varied here. This leg varies variable state, so those members are compared only as they happen to appear (through nodeEqualsGo) and are not individually exercised.',
    'a helper SCRIPT that both renders and generates: the render surface is helper-comparison.json; this leg drives the variables API from the page, not from a user script iframe.',
    'the `script` and `extension` variable scopes: both exist at the pinned commit (src/function/variables.ts:84-92) and neither has a host macro, so neither can reach a provider request; they are recorded in apiSurface.scopes and not driven.',
];
const guardMechanisms = {
    characterOnDisk: () => `the card's data.extensions.tavern_helper.variables was not found on disk after the session; cardStance=${JSON.stringify(subjects.map(subject => observed[subject].disk.characterVariables))}. A character-scope write goes through writeExtensionField -> POST /api/characters/merge-attributes (public/scripts/extensions.js:2070-2119), so an absent row means that request did not land or the merge did not write the field.`,
    survivesRestart: () => `the restart leg did not produce a resolvable value from the tree: restartPids=${JSON.stringify(subjects.map(subject => restart[subject]?.provenance?.serverPid ?? null))}, sessionPids=${JSON.stringify(subjects.map(subject => on[subject]?.provenance?.serverPid ?? null))}. A restart leg that did not boot a NEW process is a harness failure, not a product finding.`,
    offIsTheControl: () => `the off leg's captures did not equal the READY form, so the pair cannot show that the variable is what changed the request; offCaptures=${JSON.stringify(subjects.map(subject => off[subject]?.cases?.map(entry => entry.case) ?? null))}`,
};
for (const [name, mechanism] of Object.entries(guardMechanisms)) {
    if (guards[name] !== true) unprovenEntries.push(`${name}: ${mechanism()}`);
}
const declaredUnproven = new Set(unprovenEntries.map(entry => String(entry).split(':')[0].trim()));

const failedGuards = Object.entries(guards)
    .filter(([name, value]) => value !== true && !declaredUnproven.has(name))
    .map(([name]) => name);
if (DRIVE_STEP_FAILURES.length > 0) {
    guards.driveCompleted = false;
    if (!failedGuards.includes('driveCompleted')) failedGuards.push('driveCompleted');
} else {
    guards.driveCompleted = true;
}

const missingLegs = Object.entries(legs).filter(([, entry]) => !entry.present).map(([key, entry]) => `${key}${entry.path ? ` (${entry.path}: ${entry.error ?? 'absent'})` : ''}`);
if (missingLegs.length > 0) {
    guards.legsPresent = false;
    if (!failedGuards.includes('legsPresent')) failedGuards.push('legsPresent');
}

const artefact = {
    schemaVersion: 1,
    question: 'Does a 酒馆助手 variable change the FINAL provider request through host macro substitution AND survive on disk (fresh page, new process), does an injection land at the index pinned produces, and do both behave identically on GoTavern and pinned Node?',
    generatedBy: 'tests/browser/compare-helper-vars-legs.mjs',
    subject: 'tavern-helper@837a6288135cde61522a9279173b98020f08807e (manifest 4.11.3), host SillyTavern 06bde939fb1e9c4c8d8641d810f0a9165b5ce127',
    surface: 'variables + injection (Q10, Q11)',
    verdict: failedGuards.length === 0 && asymmetries.length === 0 ? 'PASS' : 'FAIL',
    guards,
    failedGuards,
    driveStepFailures: DRIVE_STEP_FAILURES,
    missingLegs,
    asymmetries,
    mismatches,
    markers: MARKERS,
    claim: on.gotavern?.claim ?? on.pinned?.claim ?? null,
    apiSurface: { gotavern: observed.gotavern?.apiSurface ?? null, pinned: observed.pinned?.apiSurface ?? null },
    unproven: unprovenEntries,
    declaredUnproven: [...declaredUnproven].sort(),
    subjects: observed,
    answers: {
        'Q10 do variables work': 'guards.valueOnWire + guards.changeChangesTheWire + guards.valueOnDisk + guards.survivesFreshPage + guards.survivesRestart -- BOTH halves',
        'Q11 does injection change the context': 'guards.injectionPlaced at depths 0/1/2 + guards.injectionRemoved + guards.nodeEqualsGo on the injection captures',
        'scope isolation': 'guards.chatScopeIsolated + guards.globalScopeNotChatScoped',
        'message scope': 'guards.messageStoredNotSurfaced -- a FINDING: stored in the page, absent from the wire because no host macro reads it',
        'not exercised here': 'streaming, cancellation, real provider, script/extension scopes (recorded in unproven[])',
    },
    legs: Object.fromEntries(Object.entries(legs).map(([key, value]) => [key, {
        present: value.present,
        path: value.path,
        subject: value.leg?.subject ?? null,
        variant: value.leg?.variant ?? null,
        afterRestart: value.leg?.afterRestart ?? null,
        failure: value.leg?.failure ?? null,
        cases: (value.leg?.cases ?? []).map(entry => entry.case),
        steps: (value.leg?.steps ?? []).map(item => `${item.ok === null ? 'n/a' : item.ok ? 'ok' : 'FAIL'} ${item.name}`),
    }])),
};

const serialised = `${JSON.stringify(artefact, null, 2)}\n`;
if (artefactPath) await fs.writeFile(artefactPath, serialised);
process.stdout.write(serialised);
if (failedGuards.length > 0 || asymmetries.length > 0) {
    console.error(`helper variables comparison FAILED: guards=[${failedGuards.join(', ')}] asymmetries=[${asymmetries.map(item => item.guard).join(', ')}] mismatches=[${mismatches.map(item => `${item.case}.${item.field}`).join(', ')}]`);
    if (DRIVE_STEP_FAILURES.length > 0) console.error(`drive steps that did not happen:\n  ${DRIVE_STEP_FAILURES.join('\n  ')}`);
    if (missingLegs.length > 0) console.error(`legs missing (a leg whose \`if:\` was false reports nothing, so this is a NAMED refusal):\n  ${missingLegs.join('\n  ')}`);
    process.exitCode = 1;
}
