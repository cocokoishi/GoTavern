// THE JUDGE FOR THE HELPER SECOND-ORDER STATE LEG.
//
// It reads the reports the two subjects produced (helper-state-probe.mjs) and turns them into a TAXONOMY:
// every guard is a claim about the SUBJECTS' OWN observations, and the answer is `match` only when both
// subjects observed it. The expected values come from the capture and from the probe's own recorded
// preconditions -- never from the comparator's opinion of what the frontend should do (AGENTS differential
// doctrine 3: subject and oracle must not share an expectation).
//
// The guards fall in the four groups the mission names:
//   VARIABLES     scopeReadback, objectListSemantics, simultaneousMutations, deletion, scopePersistence,
//                 survivesReload, survivesRestart, chat/character/preset scope isolation;
//   PRESET        presetMutationReachesNextRequest (+ restore), presetMutationPersisted;
//   EVENTS        eventSequenceEquals, eventsOrdered, stateAtEventSane, chatChangedEventFires;
//   CLOSURE       closureProven, generationCarriesScopes, nodeEqualsGo;
// plus the rule-50 control (offIsTheControl) and the harness guards (legsPresent, fixtureEqual, driveCompleted).
//
// A guard is `true` only when the observation is true on BOTH subjects; a subject-only difference is an
// ASYMMETRY and fails the verdict even when each side's own step list is green.
//
// Usage: node tests/browser/compare-helper-state-legs.mjs <gotavern-on> <pinned-on>
//          [--off <gotavern-off> <pinned-off>] [--restart <gotavern-restart> <pinned-restart>] [--out <json>]

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const read = target => JSON.parse(fs.readFileSync(path.resolve(target), 'utf8'));
const MARKER_KEY = { chat: 'chat', global: 'global', character: 'character', preset: 'preset', script: 'script', message: 'message', injected: 'injected', mutation: 'mutation', presetB: 'presetB' };

function expected(report, key) {
    const markers = report.markers ?? {};
    const marker = markers[MARKER_KEY[key] ?? key];
    if (typeof marker !== 'string') return null;
    return `${marker}${report.nonce ?? ''}`;
}

function requestsOf(report, phaseName) {
    const phase = report.phases?.[phaseName];
    return Array.isArray(phase?.requests) ? phase.requests : (Array.isArray(phase?.readReload?.requests) ? phase.readReload.requests : []);
}

function requestWith(report, phaseName, caseName) {
    return requestsOf(report, phaseName).find(entry => entry.case === caseName) ?? null;
}

function caseOf(report, phaseName, caseName) {
    const phase = report.phases?.[phaseName];
    const done = phase?.done ?? phase?.readReload?.readReload?.done ?? null;
    if (done === null) return null;
    return (done.cases ?? []).find(entry => entry.name === caseName) ?? null;
}

function variablesOf(readback, scope) {
    const entry = readback?.[scope];
    if (entry === undefined || entry === null) return null;
    return entry.ok === true ? (entry.value ?? {}) : null;
}

function hasKey(object, key) {
    return object !== null && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

const markerText = body => {
    if (typeof body !== 'string') return '';
    return body;
};

function containsAll(body, needles) {
    const text = markerText(body);
    return needles.every(needle => typeof needle === 'string' && needle.length > 0 && text.includes(needle));
}

function eventTypes(report, phaseName = 'events') {
    const events = report.phases?.[phaseName]?.done?.eventsAtEnd ?? [];
    return events.map(entry => String(entry?.type ?? '(none)'));
}

function firstIndex(types, name) {
    return types.indexOf(name);
}

function subjectObservations(report) {
    const on = report;
    const write = on.phases?.write ?? null;
    const writeReadback = write?.done?.readback ?? null;
    const readReload = on.phases?.readReload?.readReload?.done?.readback ?? null;
    const readRestart = on.phases?.readRestart?.done?.readback ?? null;
    const chatSwitched = on.phases?.readAfterChatSwitch?.done?.readback ?? null;
    const characterSwitched = on.phases?.readAfterCharacterSwitch?.done?.readback ?? null;
    const presetSwitched = on.phases?.switchPresetB?.done?.readback ?? null;
    const presetBack = on.phases?.switchPresetBack?.done?.readback ?? null;
    const diskWrite = on.phases?.diskAfterWrite?.value ?? null;
    const diskCardPreset = on.phases?.diskCardPreset?.value ?? null;
    const diskRestart = on.phases?.diskRestart ?? null;
    const events = eventTypes(on);
    const afterSwitch = (on.phases?.switchChat?.eventsAfterSwitch ?? []).map(entry => String(entry?.type ?? '(none)'));
    const beforeSwitch = (on.phases?.switchChat?.eventsBeforeSwitch ?? []).map(entry => String(entry?.type ?? '(none)'));
    const chatVars = variablesOf(writeReadback, 'chat');
    const globalVars = variablesOf(writeReadback, 'global');
    const characterVars = variablesOf(writeReadback, 'character');
    const presetVars = variablesOf(writeReadback, 'preset');
    const scriptVars = variablesOf(writeReadback, 'script');
    const messageVars = variablesOf(writeReadback, 'message');
    const writeReq = requestWith(on, 'write', 'hs-write');
    const b0 = requestWith(on, 'mutate', 'hs-b0-baseline');
    const b1 = requestWith(on, 'mutate', 'hs-b1-mutated');
    const b2 = requestWith(on, 'mutate', 'hs-b2-sampler');
    const b3 = requestWith(on, 'mutate', 'hs-b3-restored');
    const reloadReq = requestWith(on, 'readReload', 'hs-read-reload') ?? on.phases?.readReload?.readReload?.requests?.find(entry => entry.case === 'hs-read-reload') ?? null;
    const restartReq = requestWith(on, 'readRestart', 'hs-read-restart') ?? null;
    return {
        report: on,
        variant: on.variant,
        afterRestart: on.afterRestart === true,
        stepsFailed: (on.steps ?? []).filter(entry => entry.ok !== true).map(entry => entry.name),
        closure: write?.done?.closure ?? null,
        writeCases: Object.fromEntries((write?.done?.cases ?? []).map(entry => [entry.name, entry])),
        writeReadback, chatVars, globalVars, characterVars, presetVars, scriptVars, messageVars,
        simultaneousCounter: Number(chatVars?.hs_counter ?? NaN),
        deletedAbsent: !hasKey(chatVars, 'hs_delete_me'),
        parallelKeys: [hasKey(chatVars, 'hs_parallel_a'), hasKey(chatVars, 'hs_parallel_b')],
        objectSemantics: chatVars?.hs_object ?? null,
        listSemantics: chatVars?.hs_list ?? null,
        diskChatVars: diskWrite?.chat?.variables ?? null,
        diskGlobalVars: diskWrite?.global?.variablesGlobal ?? null,
        diskCardVars: diskCardPreset?.cardA?.variables ?? null,
        diskCardBvars: diskCardPreset?.cardB?.variables ?? null,
        diskPresetVars: diskCardPreset?.presetA?.document?.extensions?.tavern_helper?.variables ?? null,
        diskPresetAfterMutation: on.phases?.presetAfterMutation?.document?.extensions?.tavern_helper?.variables ?? null,
        readReload, readRestart,
        chatSwitched, characterSwitched, presetSwitched, presetBack,
        events, afterSwitch, beforeSwitch,
        writeReq, b0, b1, b2, b3, reloadReq, restartReq,
        pageErrors: on.pageErrors ?? [],
        injectionClauses: write?.done?.injected ?? null,
        reloadInjectionClauses: on.phases?.readReload?.readReload?.done?.injected ?? null,
        restartInjectionClauses: on.phases?.readRestart?.done?.injected ?? null,
        mutatePresets: {
            baseline: on.phases?.mutate?.done?.baselinePreset ?? null,
            mutated: on.phases?.mutate?.done?.afterMutationPreset ?? null,
            sampler: on.phases?.mutate?.done?.samplerPreset ?? null,
            restored: on.phases?.mutate?.done?.restoredPreset ?? null,
        },
    };
}

const guard = (name, gotavern, pinned) => ({ name, go: gotavern, pinned, ok: gotavern === true && pinned === true });

export function compareLegs({ onGotavern, onPinned, offGotavern = null, offPinned = null, restartGotavern = null, restartPinned = null }) {
    const go = subjectObservations(onGotavern);
    const node = subjectObservations(onPinned);
    const guards = [];
    const asymmetries = [];

    const push = (name, a, b) => {
        guards.push(guard(name, a, b));
        if (a !== b) asymmetries.push({ guard: name, gotavern: a, pinned: b });
    };
    const pushBoth = (name, fnGo, fnNode) => push(name, fnGo === undefined ? true : fnGo, fnNode === undefined ? true : fnNode);

    // ---- harness ---------------------------------------------------------------------------------------
    pushBoth('legsPresent',
        go.report.leg === 'gotavern' && typeof go.report.nonce === 'string',
        node.report.leg === 'pinned' && typeof node.report.nonce === 'string');
    pushBoth('driveCompleted', go.stepsFailed.length === 0, node.stepsFailed.length === 0);
    const fixtureGo = go.report.fixture?.card?.sha256 ?? null;
    const fixtureNode = node.report.fixture?.card?.sha256 ?? null;
    pushBoth('fixtureEqual', fixtureGo !== null && fixtureGo === fixtureNode, fixtureNode !== null && fixtureNode === fixtureGo);
    pushBoth('extensionIsThePin',
        go.report.provenance?.apiSurface?.pinned === true,
        node.report.provenance?.apiSurface?.pinned === true);

    // ---- closure: the script ran INSIDE the iframe and used the bridge ---------------------------------
    const closureOk = subject => subject.closure?.insideIframe === true && Array.isArray(subject.closure?.bridgeFns) && subject.closure.bridgeFns.length >= 6;
    pushBoth('closureProven', closureOk(go), closureOk(node));

    // ---- variables: writes, readback, semantics --------------------------------------------------------
    const writeApplied = (subject, name) => subject.writeCases?.[name]?.applied === true;
    pushBoth('scopesWritten',
        ['chat-set', 'global-set', 'character-set', 'preset-set', 'script-set', 'message-set'].every(name => writeApplied(go, name)),
        ['chat-set', 'global-set', 'character-set', 'preset-set', 'script-set', 'message-set'].every(name => writeApplied(node, name)));
    const markerMatches = (subject, scope, value) => value === expected(subject.report, scope);
    pushBoth('scopeReadback',
        markerMatches(go, 'chat', go.chatVars?.hs_chat) && markerMatches(go, 'global', go.globalVars?.hs_global)
        && markerMatches(go, 'character', go.characterVars?.hs_character) && markerMatches(go, 'preset', go.presetVars?.hs_preset)
        && markerMatches(go, 'script', go.scriptVars?.hs_script) && markerMatches(go, 'message', go.messageVars?.hs_message),
        markerMatches(node, 'chat', node.chatVars?.hs_chat) && markerMatches(node, 'global', node.globalVars?.hs_global)
        && markerMatches(node, 'character', node.characterVars?.hs_character) && markerMatches(node, 'preset', node.presetVars?.hs_preset)
        && markerMatches(node, 'script', node.scriptVars?.hs_script) && markerMatches(node, 'message', node.messageVars?.hs_message));
    const objectSane = subject => subject.objectSemantics?.nested?.n === 1 && subject.objectSemantics?.nested?.flag === true
        && Array.isArray(subject.objectSemantics?.list) && subject.objectSemantics.list.length === 3
        && Array.isArray(subject.listSemantics) && subject.listSemantics.length === 3 && subject.listSemantics[1] === 'two';
    pushBoth('objectListSemantics', objectSane(go), objectSane(node));
    pushBoth('simultaneousMutations',
        go.simultaneousCounter === 3 && go.parallelKeys[0] === true && go.parallelKeys[1] === true,
        node.simultaneousCounter === 3 && node.parallelKeys[0] === true && node.parallelKeys[1] === true);
    pushBoth('deletion', go.deletedAbsent === true, node.deletedAbsent === true);

    // ---- persistence: the SAME markers in the persisted files -----------------------------------------
    const diskChatOk = subject => subject.diskChatVars?.hs_chat === expected(subject.report, 'chat');
    const diskGlobalOk = subject => subject.diskGlobalVars?.hs_global === expected(subject.report, 'global');
    const diskCardOk = subject => subject.diskCardVars?.hs_character === expected(subject.report, 'character');
    const diskPresetOk = subject => subject.diskPresetVars?.hs_preset === expected(subject.report, 'preset');
    pushBoth('scopePersistence',
        diskChatOk(go) && diskGlobalOk(go) && diskCardOk(go) && diskPresetOk(go),
        diskChatOk(node) && diskGlobalOk(node) && diskCardOk(node) && diskPresetOk(node));

    // ---- persistence across reload / restart / switches -----------------------------------------------
    const reloadHas = (subject, scope, key) => {
        const vars = variablesOf(subject.readReload, scope);
        return vars !== null && vars[key] === expected(subject.report, scope);
    };
    // CHARACTER SCOPE IS EXCLUDED FROM THE RELOAD CLAIM, HONESTLY: measured on BOTH subjects, the helper's
    // character store reads {} in a fresh page after the character is re-opened, while the card on disk still
    // carries the variables. That is a pinned frontend+helper property, so the reload guard claims the scopes
    // that DO survive and a separate equivalence guard records the character observation (equal on both sides)
    // without turning it into a green.
    pushBoth('survivesReload',
        reloadHas(go, 'chat', 'hs_chat') && reloadHas(go, 'global', 'hs_global') && reloadHas(go, 'preset', 'hs_preset')
        && variablesOf(go.readReload, 'script') !== null && !hasKey(variablesOf(go.readReload, 'script'), 'hs_script'),
        reloadHas(node, 'chat', 'hs_chat') && reloadHas(node, 'global', 'hs_global') && reloadHas(node, 'preset', 'hs_preset')
        && variablesOf(node.readReload, 'script') !== null && !hasKey(variablesOf(node.readReload, 'script'), 'hs_script'));
    push('reloadCharacterScopeEquivalent',
        JSON.stringify(variablesOf(go.readReload, 'character')) === JSON.stringify(variablesOf(node.readReload, 'character')),
        JSON.stringify(variablesOf(node.readReload, 'character')) === JSON.stringify(variablesOf(go.readReload, 'character')));
    const restartHas = (subject, scope, key) => {
        const vars = variablesOf(subject.readRestart, scope);
        return vars !== null && vars[key] === expected(subject.report, scope);
    };
    if (restartGotavern && restartPinned) {
        const goRestart = subjectObservations(restartGotavern);
        const nodeRestart = subjectObservations(restartPinned);
        push('survivesRestart',
            restartHas(goRestart, 'chat', 'hs_chat') && restartHas(goRestart, 'global', 'hs_global') && restartHas(goRestart, 'preset', 'hs_preset')
            && variablesOf(goRestart.readRestart, 'script') !== null && !hasKey(variablesOf(goRestart.readRestart, 'script'), 'hs_script'),
            restartHas(nodeRestart, 'chat', 'hs_chat') && restartHas(nodeRestart, 'global', 'hs_global') && restartHas(nodeRestart, 'preset', 'hs_preset')
            && variablesOf(nodeRestart.readRestart, 'script') !== null && !hasKey(variablesOf(nodeRestart.readRestart, 'script'), 'hs_script'));
        push('restartCharacterScopeEquivalent',
            JSON.stringify(variablesOf(goRestart.readRestart, 'character')) === JSON.stringify(variablesOf(nodeRestart.readRestart, 'character')),
            JSON.stringify(variablesOf(nodeRestart.readRestart, 'character')) === JSON.stringify(variablesOf(goRestart.readRestart, 'character')));
        push('restartIsNewProcess',
            goRestart.report.provenance?.serverEpoch !== go.report.provenance?.serverEpoch,
            nodeRestart.report.provenance?.serverEpoch !== node.report.provenance?.serverEpoch);
    }
    pushBoth('chatScopeIsolation',
        variablesOf(go.chatSwitched, 'chat') !== null && !hasKey(variablesOf(go.chatSwitched, 'chat'), 'hs_chat'),
        variablesOf(node.chatSwitched, 'chat') !== null && !hasKey(variablesOf(node.chatSwitched, 'chat'), 'hs_chat'));
    // AFTER A CHARACTER SWITCH THE HELPER'S CHARACTER STORE CAN STILL CARRY THE PREVIOUS CHARACTER'S VARIABLES
    // (measured on BOTH subjects: the store refreshes on the extension's own CHARACTER_PAGE_LOADED/selection
    // path). That staleness is a pinned frontend+helper property, so the claim this leg makes is EQUALITY with
    // the oracle's observation -- not that the store is empty, which would be our derivation, not the oracle.
    // ONLY THE CHARACTER STORE IS COMPARED. The chat/message stores are refreshed by the extension on its own
    // chat-change path and can lag the switch by a tick on either subject; comparing them here would turn a
    // timing observation into a product finding. The chat-store claim has its own explicit chat-switch phase.
    push('characterSwitchReadbackEquivalent',
        JSON.stringify(go.characterSwitched?.character ?? null) === JSON.stringify(node.characterSwitched?.character ?? null),
        JSON.stringify(node.characterSwitched?.character ?? null) === JSON.stringify(go.characterSwitched?.character ?? null));
    pushBoth('presetScopeIsolation',
        variablesOf(go.presetSwitched, 'preset') !== null && !hasKey(variablesOf(go.presetSwitched, 'preset'), 'hs_preset')
        && variablesOf(go.presetBack, 'preset')?.hs_preset === expected(go.report, 'preset'),
        variablesOf(node.presetSwitched, 'preset') !== null && !hasKey(variablesOf(node.presetSwitched, 'preset'), 'hs_preset')
        && variablesOf(node.presetBack, 'preset')?.hs_preset === expected(node.report, 'preset'));

    // ---- the WIRE: each scope reaches the request, through the helper's own bridge ---------------------
    const wireClauses = subject => {
        const clauses = subject.injectionClauses ?? [];
        const text = clauses.join(' ');
        return text.includes(expected(subject.report, 'chat') ?? 'x')
            && text.includes(expected(subject.report, 'global') ?? 'x')
            && text.includes(expected(subject.report, 'character') ?? 'x')
            && text.includes(expected(subject.report, 'preset') ?? 'x')
            && clauses.length === 4;
    };
    const bodyCarries = (subject, request) => request !== null && containsAll(request.body ?? '', [
        expected(subject.report, 'chat'), expected(subject.report, 'global'), expected(subject.report, 'character'), expected(subject.report, 'preset'),
    ]);
    const reloadClausesCarry = (subject, scope) => (subject.reloadInjectionClauses ?? []).join(' ').includes(expected(subject.report, scope) ?? 'x');
    const reloadBodyCarries = (subject, scopes) => subject.reloadReq !== null && scopes.every(scope => containsAll(subject.reloadReq.body ?? '', [expected(subject.report, scope)]));
    pushBoth('generationCarriesScopes',
        wireClauses(go) && bodyCarries(go, go.writeReq),
        wireClauses(node) && bodyCarries(node, node.writeReq));
    // THE PERSISTED SCOPES ON THE RELOAD REQUEST: chat/global/preset (the character scope does not survive, above).
    pushBoth('generationCarriesPersistedScopes',
        ['chat', 'global', 'preset'].every(scope => reloadClausesCarry(go, scope)) && reloadBodyCarries(go, ['chat', 'global', 'preset']),
        ['chat', 'global', 'preset'].every(scope => reloadClausesCarry(node, scope)) && reloadBodyCarries(node, ['chat', 'global', 'preset']));
    const identityOk = subject => containsAll(subject.writeReq?.body ?? '', [`HS-IDENT=${expected(subject.report, 'chat')}|${expected(subject.report, 'global')}`]);
    pushBoth('hostMacroResolvedScopes', identityOk(go), identityOk(node));

    // ---- preset mutation -> the NEXT request ----------------------------------------------------------
    const has = (subject, request, needle) => request !== null && typeof request.body === 'string' && request.body.includes(needle);
    const mutationMarker = subject => `${subject.report.markers?.mutation ?? ''}${subject.report.nonce ?? ''}`;
    pushBoth('presetMutationReachesNextRequest',
        has(go, go.b1, mutationMarker(go)) && !has(go, go.b0, mutationMarker(go)) && has(go, go.b2, '"temperature":0.42') && !has(go, go.b0, '"temperature":0.42')
        && !has(go, go.b3, mutationMarker(go)) && !has(go, go.b3, '"temperature":0.42'),
        has(node, node.b1, mutationMarker(node)) && !has(node, node.b0, mutationMarker(node)) && has(node, node.b2, '"temperature":0.42') && !has(node, node.b0, '"temperature":0.42')
        && !has(node, node.b3, mutationMarker(node)) && !has(node, node.b3, '"temperature":0.42'));
    pushBoth('presetMutationPersisted',
        go.diskPresetAfterMutation?.hs_preset === expected(go.report, 'preset'),
        node.diskPresetAfterMutation?.hs_preset === expected(node.report, 'preset'));

    // ---- events ---------------------------------------------------------------------------------------
    // A SILENT helper generation may emit the helper's IFRAME generation events rather than the host's, and may
    // not emit message events at all -- which family fires is a pinned observation, so the ordering guard accepts
    // either family and only requires message ordering WHERE message events exist.
    const ordered = subject => {
        const types = subject.events;
        const started = Math.max(firstIndex(types, 'generation_started'), firstIndex(types, 'js_generation_started'));
        const ended = Math.max(firstIndex(types, 'generation_ended'), firstIndex(types, 'js_generation_ended'));
        const sent = firstIndex(types, 'message_sent');
        const received = firstIndex(types, 'message_received');
        const messagesOrdered = sent < 0 || received < 0 || sent < received;
        return started >= 0 && ended > started && messagesOrdered && types.includes('preset_changed');
    };
    pushBoth('eventsOrdered', ordered(go), ordered(node));
    push('eventSequenceEquals', JSON.stringify(go.events) === JSON.stringify(node.events), JSON.stringify(node.events) === JSON.stringify(go.events));
    const stateSane = subject => {
        const events = subject.report.phases?.events?.done?.eventsAtEnd ?? [];
        if (events.length === 0) return false;
        return events.every(entry => typeof entry?.chatLength === 'number' && (entry?.lastRole === null || ['user', 'assistant', 'system'].includes(entry.lastRole)));
    };
    pushBoth('stateAtEventSane', stateSane(go), stateSane(node));
    // CHAT_CHANGED THROUGH THE HELPER IFRAME IS NOT ASSERTED: the extension re-creates script iframes on chat
    // change, so a listener installed by the pre-switch iframe can legitimately cease to exist before the event.
    // The chat-switch CLAIM is the state isolation asserted above; the event is recorded in the artefact and
    // listed as not-observed instead of being turned into a green that cannot fail.
    pushBoth('chatChangeStateObserved',
        variablesOf(go.chatSwitched, 'chat') !== null && !hasKey(variablesOf(go.chatSwitched, 'chat'), 'hs_chat'),
        variablesOf(node.chatSwitched, 'chat') !== null && !hasKey(variablesOf(node.chatSwitched, 'chat'), 'hs_chat'));

    // ---- rule-50 control: the off legs (no writes) must NOT produce the markers ------------------------
    if (offGotavern && offPinned) {
        const goOff = subjectObservations(offGotavern);
        const nodeOff = subjectObservations(offPinned);
        const noMarker = (subject, needle) => !String(subject.writeReq?.body ?? '').includes(needle);
        push('offIsTheControl',
            noMarker(goOff, `${go.report.markers?.chat ?? ''}${go.report.nonce ?? ''}`) && (goOff.writeReq?.sha256 ?? '') !== (go.writeReq?.sha256 ?? ''),
            noMarker(nodeOff, `${node.report.markers?.chat ?? ''}${node.report.nonce ?? ''}`) && (nodeOff.writeReq?.sha256 ?? '') !== (node.writeReq?.sha256 ?? ''));
    }

    // ---- byte equality of the provider requests per case (subject vs oracle) --------------------------
    const byCase = report => {
        const map = {};
        for (const phase of ['write', 'mutate', 'events']) {
            for (const request of requestsOf(report, phase)) if (request.case) map[request.case] = request;
        }
        for (const [phaseName, caseName] of [['readReload', 'hs-read-reload'], ['readRestart', 'hs-read-restart']]) {
            const request = requestWith(report, phaseName, caseName) ?? report.phases?.[phaseName]?.readReload?.requests?.find(entry => entry.case === caseName) ?? null;
            if (request) map[caseName] = request;
        }
        return map;
    };
    const goCases = byCase(go.report);
    const nodeCases = byCase(node.report);
    const common = Object.keys(goCases).filter(name => name in nodeCases);
    const byteMismatches = common.filter(name => goCases[name].sha256 !== nodeCases[name].sha256).map(name => ({
        case: name, gotavern: goCases[name].sha256, pinned: nodeCases[name].sha256, gotavernBytes: goCases[name].byteLength, pinnedBytes: nodeCases[name].byteLength,
    }));
    push('nodeEqualsGo', common.length >= 6 && byteMismatches.length === 0, common.length >= 6 && byteMismatches.length === 0);
    pushBoth('noPageErrors', go.pageErrors.length === 0, node.pageErrors.length === 0);

    const failedGuards = guards.filter(entry => entry.ok !== true).map(entry => entry.name);
    const verdict = failedGuards.length === 0 && asymmetries.length === 0 ? 'PASS' : 'FAIL';
    return {
        schemaVersion: 1,
        question: 'Do helper second-order state mutations (scoped variables, in-use preset mutation, lifecycle events) reach the NEXT provider request identically on both subjects, and survive reload/restart/switch?',
        verdict,
        guards: Object.fromEntries(guards.map(entry => [entry.name, entry.ok])),
        failedGuards,
        asymmetries,
        subjectGuards: guards.map(entry => ({ name: entry.name, gotavern: entry.go, pinned: entry.pinned })),
        captures: { cases: common, byteMismatches },
        subjects: {
            gotavern: { leg: go.report.leg, nonce: go.report.nonce, serverEpoch: go.report.provenance?.serverEpoch, steps: go.report.steps?.length ?? 0, failedSteps: go.stepsFailed },
            pinned: { leg: node.report.leg, nonce: node.report.nonce, serverEpoch: node.report.provenance?.serverEpoch, steps: node.report.steps?.length ?? 0, failedSteps: node.stepsFailed },
        },
        events: { gotavern: go.events, pinned: node.events },
        unproven: [
            'a real provider: the peer is an in-process simulated backend, so rule 22 makes every wire measurement here unverified for PRODUCTION; what is proven is the frontend+helper transform, not a live transport.',
            'streaming and cancellation of a helper generation, and the `extension` variable scope: neither is driven by this probe.',
            'a real user second character: the character switch uses a synthetic 1x1 PNG card whose ccv3 payload is written by the probe (no user prose is copied).',
            'the CHAT_CHANGED event as observed by a helper-iframe listener across a UI chat switch: the extension re-creates script iframes on chat change; chat-scope isolation is asserted instead and the event sequence is recorded.',
        ],
    };
}

function main() {
    const argv = process.argv.slice(2);
    const positional = [];
    const section = { off: [], restart: [] };
    let current = null;
    let out = null;
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        if (token === '--off' || token === '--restart') { current = token.slice(2); continue; }
        if (token === '--out') { out = argv[index + 1]; index += 1; current = null; continue; }
        if (current === null) positional.push(token);
        else section[current].push(token);
    }
    if (positional.length !== 2) {
        console.error('usage: node compare-helper-state-legs.mjs <gotavern-on> <pinned-on> [--off <gotavern-off> <pinned-off>] [--restart <gotavern-restart> <pinned-restart>] [--out <json>]');
        process.exit(2);
    }
    const result = compareLegs({
        onGotavern: read(positional[0]),
        onPinned: read(positional[1]),
        offGotavern: section.off[0] ? read(section.off[0]) : null,
        offPinned: section.off[1] ? read(section.off[1]) : null,
        restartGotavern: section.restart[0] ? read(section.restart[0]) : null,
        restartPinned: section.restart[1] ? read(section.restart[1]) : null,
    });
    for (const entry of result.subjectGuards) console.error(`${entry.gotavern === true && entry.pinned === true ? 'ok  ' : 'FAIL'} ${entry.name} -- gotavern=${entry.gotavern} pinned=${entry.pinned}`);
    console.log(`${JSON.stringify(result, null, 2)}\n`);
    if (out) fs.writeFileSync(path.resolve(out), `${JSON.stringify(result, null, 2)}\n`);
    console.error(`verdict: ${result.verdict}${result.failedGuards.length > 0 ? ` -- failed guards: ${result.failedGuards.join(', ')}` : ''}`);
    process.exit(result.verdict === 'PASS' ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))) main();
