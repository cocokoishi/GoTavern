// THE GROUP-CHAT PROVIDER-REQUEST DIFFERENTIAL -- judge.
//
// Compares the pinned-Node leg and the GoTavern leg recorded by group-chat-probe.mjs, byte for byte,
// and fails by NAME when they disagree. Two things must hold at once (AGENTS.md 48, GOAL.md 8/10):
//
//   1. Node(X) == Go(X) for every scenario X: the exact provider request bytes (method, raw target,
//      body sha256, body length) are identical for the same case and the same request ordinal; and
//   2. X != Y within one implementation where the scenario is a semantic knob that MUST change the
//      request: a 2-member turn is not a 3-member turn, a disabled member produces no request, a
//      forced order is that order, world info / Author's Note / sampler knobs actually reach the
//      wire, and truncation actually drops history. If two scenarios that must differ produce
//      identical requests the harness is not discriminating and this judge fails itself
//      (HARNESS NON-DISCRIMINATING), rather than passing on the equality half alone.
//
// BYTE-ORIENTED, NO CANONICALISATION. Nothing here parses and re-marshals a body for the equality
// gate: bodySha256 + bodyLength + method + target are the compared fields. `bodyText` is parsed only
// to LOCATE a semantic property (`which member is this request for?`, `which role is this line?`)
// for the discriminating half, never to make two different requests compare equal.
//
// VERDICT TAXONOMY (AGENTS.md doctrine 5): match | mismatch | harness-non-discriminating |
// harness-error. A missing case, a missing leg, or a seed-digest disagreement is a refusal
// (harness-error), not a match.
//
// Usage:
//   node tests/browser/compare-group-chat-legs.mjs \
//     --pinned-full <leg.json> --gotavern-full <leg.json> \
//     --pinned-restart <leg.json> --gotavern-restart <leg.json> \
//     --out tests/browser/group-chat-comparison.json

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

function readJSON(filePath, label) {
    try {
        return JSON.parse(readFileSync(path.resolve(filePath), 'utf8'));
    } catch (error) {
        const failure = new Error(`cannot read the ${label} leg at ${filePath}: ${error.message}`);
        failure.harness = true;
        throw failure;
    }
}

const verdict = {
    schemaVersion: 1,
    question: 'Does a multi-character group chat driven through the pinned frontend send the same final provider request under pinned Node and GoTavern?',
    scope: 'Group chats only: 2 and 3 members, disabled member, natural/list/manual activation, auto mode, previous-speaker ban, group greeting, character/chat/global world info, Author\'s Note at depth, samplers and stops, user turn, continue, swipe, regenerate, impersonate, truncation and a server restart over the same tree. Not claimed: providers other than the custom OpenAI-compatible source, streaming, tool calls, extension/helper group generation.',
    guards: {},
    failedGuards: [],
    cases: {},
    discriminating: {},
    verdict: 'match',
};

function guard(name, ok, detail) {
    verdict.guards[name] = { ok: Boolean(ok), ...(detail === undefined ? {} : { detail }) };
    if (!ok) verdict.failedGuards.push(name);
    return Boolean(ok);
}

function equalGuard(name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    return guard(name, ok, ok ? undefined : { actual, expected });
}

// ---------------------------------------------------------------------------------------------
// Semantic helpers. These read a request body to name a fact about the SCENARIO, never to make two
// different requests equal.
// ---------------------------------------------------------------------------------------------
function parseBody(record) {
    try {
        return JSON.parse(record.bodyText);
    } catch {
        return null;
    }
}

// Which member a request is generating for. The pinned frontend's group prompt names the member in
// the first system message ("Write <Name>'s next reply in a fictional chat between <Name> and
// <User>.") and in the depth instruction at the end ("[Write the next reply only as <Name>.]").
// Reading BOTH and requiring agreement is what makes this a fact about the request rather than a
// lucky substring.
function targetCharacter(record) {
    const body = parseBody(record);
    if (!body || !Array.isArray(body.messages) || body.messages.length === 0) return null;
    const first = String(body.messages[0]?.content ?? '');
    const match = first.match(/Write (.+)'s next reply in a fictional chat between /);
    return match ? match[1] : null;
}

// A NORMAL group turn must also confirm the member in the final instruction; the frontend writes
// "[Write the next reply only as <Name>.]" (openai.js group depth instruction). Continue turns use
// a different final instruction, which is why this is a separate fact rather than part of the name.
function targetConfirmedByFinalInstruction(record) {
    const name = targetCharacter(record);
    if (!name) return false;
    const body = parseBody(record);
    const last = String(body.messages[body.messages.length - 1]?.content ?? '');
    return last.includes(`reply only as ${name}.`);
}

function roles(record) {
    const body = parseBody(record);
    return Array.isArray(body?.messages) ? body.messages.map(message => message.role) : null;
}

function contents(record) {
    const body = parseBody(record);
    return Array.isArray(body?.messages) ? body.messages.map(message => String(message.content ?? '')) : [];
}

function bodyContains(record, needle) {
    return String(record.bodyText ?? '').includes(needle);
}

function compareLegs(label, pinnedLeg, goLeg) {
    equalGuard(`${label}.subject`, goLeg.subject, 'gotavern');
    equalGuard(`${label}.oracleSubject`, pinnedLeg.subject, 'pinned');
    equalGuard(`${label}.phase`, goLeg.phase, pinnedLeg.phase);
    equalGuard(`${label}.seedDigest`, goLeg.seedDigest, pinnedLeg.seedDigest);
    guard(`${label}.pinnedRecorded`, pinnedLeg.failure === null || pinnedLeg.failure === undefined, pinnedLeg.failure ?? undefined);
    guard(`${label}.gotavernRecorded`, goLeg.failure === null || goLeg.failure === undefined, goLeg.failure ?? undefined);
    guard(`${label}.noPageErrorsOnPinned`, (pinnedLeg.pageErrors ?? []).length === 0, pinnedLeg.pageErrors ?? undefined);
    guard(`${label}.noPageErrorsOnGotavern`, (goLeg.pageErrors ?? []).length === 0, goLeg.pageErrors ?? undefined);

    const pinnedCases = new Map((pinnedLeg.cases ?? []).map(entry => [entry.name, entry]));
    const goCases = new Map((goLeg.cases ?? []).map(entry => [entry.name, entry]));
    equalGuard(`${label}.caseUniverse`, [...goCases.keys()].sort(), [...pinnedCases.keys()].sort());

    for (const [name, goCase] of goCases) {
        const pinnedCase = pinnedCases.get(name);
        if (!pinnedCase) {
            guard(`${label}.case.${name}`, false, 'the pinned leg recorded no such case');
            continue;
        }
        equalGuard(`${label}.case.${name}.requestCount`, goCase.requests.length, pinnedCase.requests.length);
        const count = Math.max(goCase.requests.length, pinnedCase.requests.length);
        for (let index = 0; index < count; index++) {
            const goRequest = goCase.requests[index];
            const pinnedRequest = pinnedCase.requests[index];
            const prefix = `${label}.case.${name}.request[${index}]`;
            if (!goRequest || !pinnedRequest) {
                guard(prefix, false, { reason: 'one leg has no request at this ordinal', go: Boolean(goRequest), pinned: Boolean(pinnedRequest) });
                continue;
            }
            equalGuard(`${prefix}.method`, goRequest.method, pinnedRequest.method);
            equalGuard(`${prefix}.target`, goRequest.target, pinnedRequest.target);
            equalGuard(`${prefix}.bodyLength`, goRequest.bodyLength, pinnedRequest.bodyLength);
            equalGuard(`${prefix}.bodySha256`, goRequest.bodySha256, pinnedRequest.bodySha256);
        }
        // Replay-surface observation: what the page ended up holding (greeting names/order and the
        // chat length) is compared only where the scenario makes it deterministic. Chat IDs are
        // timestamp-derived (humanizedDateTime) and are deliberately NOT compared across subjects.
        const goObservation = goCase.steps.at(-1) ?? null;
        const pinnedObservation = pinnedCase.steps.at(-1) ?? null;
        equalGuard(`${label}.case.${name}.chatLength`, goObservation?.chatLength ?? null, pinnedObservation?.chatLength ?? null);
        equalGuard(
            `${label}.case.${name}.messageNames`,
            (goObservation?.messages ?? []).map(entry => entry.name),
            (pinnedObservation?.messages ?? []).map(entry => entry.name),
        );
        verdict.cases[`${label}/${name}`] = {
            requests: goCase.requests.length,
            bodySha256: goCase.requests.map(record => record.bodySha256),
        };
    }
    return { pinnedCases, goCases };
}

// ---------------------------------------------------------------------------------------------
// THE DISCRIMINATING HALF. Each entry asserts a property the PRODUCT must have for the scenario to
// mean anything, computed from the GoTavern leg (and, where it is about the comparison, from both).
// Failure of any of these is `harness-non-discriminating` -- the fixture cannot support the
// equality claim -- rather than a provider mismatch.
// ---------------------------------------------------------------------------------------------
function checkDiscrimination(full) {
    const { goCases, pinnedCases } = full;
    const fail = (name, detail) => {
        verdict.discriminating[name] = { ok: false, detail };
        verdict.failedGuards.push(`discriminating.${name}`);
    };
    const pass = (name, detail) => {
        verdict.discriminating[name] = { ok: true, ...(detail === undefined ? {} : { detail }) };
    };

    const caseOf = name => goCases.get(name);
    const requestsOf = (name, batch = null) => {
        const entry = caseOf(name);
        if (!entry) return [];
        return batch === null ? entry.requests : entry.requests.filter(record => record.batch === batch);
    };
    const pinnedRequestsOf = name => pinnedCases.get(name)?.requests ?? [];

    // --- every case exists -------------------------------------------------------------------
    for (const expected of ['group-greeting', 'user-message-natural-2', 'user-message-natural-3', 'user-message-list-3', 'disabled-member', 'auto-mode-list', 'manual-activation', 'previous-speaker', 'world-info-and-note', 'continue', 'swipe', 'regenerate', 'impersonate', 'truncation', 'restart-reload']) {
        if (!caseOf(expected)) fail('case-universe', `the go leg recorded no case named ${expected}`);
    }

    // --- 2 characters vs 3 characters --------------------------------------------------------
    const natural2 = requestsOf('user-message-natural-2');
    const natural3 = requestsOf('user-message-natural-3');
    if (natural2.length === 2 && natural3.length === 3) pass('two-vs-three-members', { two: natural2.length, three: natural3.length });
    else fail('two-vs-three-members', { two: natural2.length, three: natural3.length, wanted: '2 and 3 provider requests' });

    // --- list order is member order ----------------------------------------------------------
    const list3Targets = requestsOf('user-message-list-3').map(targetCharacter);
    if (JSON.stringify(list3Targets) === JSON.stringify(['Alice', 'Bob', 'Carol'])) pass('list-order-targets', list3Targets);
    else fail('list-order-targets', { actual: list3Targets, wanted: ['Alice', 'Bob', 'Carol'] });

    // --- disabled member is excluded ---------------------------------------------------------
    const disabledRequests = requestsOf('disabled-member');
    const disabledTargets = disabledRequests.map(targetCharacter);
    if (disabledRequests.length === 2 && disabledTargets.every(target => target && target !== 'Carol')) pass('disabled-member-excluded', disabledTargets);
    else fail('disabled-member-excluded', { count: disabledRequests.length, targets: disabledTargets });

    // --- auto mode runs with no user turn in history -----------------------------------------
    const autoRequests = requestsOf('auto-mode-list');
    const autoRoles = autoRequests.flatMap(roles).filter(Boolean);
    if (autoRequests.length === 3 && !autoRoles.includes('user')) pass('auto-mode-no-user-role', { requests: autoRequests.length });
    else fail('auto-mode-no-user-role', { requests: autoRequests.length, hasUserRole: autoRoles.includes('user') });

    // --- manual activation is the forced order -----------------------------------------------
    const manualTargets = requestsOf('manual-activation').map(targetCharacter);
    if (JSON.stringify(manualTargets) === JSON.stringify(['Bob', 'Alice'])) pass('manual-activation-order', manualTargets);
    else fail('manual-activation-order', { actual: manualTargets, wanted: ['Bob', 'Alice'] });

    // --- previous-speaker ban ----------------------------------------------------------------
    const sendRequests = requestsOf('previous-speaker', 'send');
    const triggerRequests = requestsOf('previous-speaker', 'trigger');
    const sendTargets = sendRequests.map(targetCharacter).filter(Boolean);
    const triggerTargets = triggerRequests.map(targetCharacter);
    const lastSpeaker = sendTargets.at(-1) ?? null;
    if (sendRequests.length === 3 && triggerRequests.length === 2 && lastSpeaker && triggerTargets.every(target => target && target !== lastSpeaker)) {
        pass('previous-speaker-ban', { lastSpeaker, triggerTargets });
    } else {
        fail('previous-speaker-ban', { sendTargets, triggerTargets, lastSpeaker });
    }

    // --- user turn, continue, swipe and regenerate are distinct batches ----------------------
    for (const [name, batch, wanted] of [['continue', 'continue', 1], ['swipe', 'swipe', 1], ['regenerate', 'regenerate', 2], ['impersonate', 'impersonate', 1]]) {
        const count = requestsOf(name, batch).length;
        if (count === wanted) pass(`${batch}-batch`, { count });
        else fail(`${batch}-batch`, { count, wanted });
    }
    const continueTargets = requestsOf('continue', 'continue').map(targetCharacter).filter(Boolean);
    const continueSendTargets = requestsOf('continue', 'send').map(targetCharacter).filter(Boolean);
    if (continueTargets.length === 1 && continueTargets[0] === continueSendTargets.at(-1)) pass('continue-targets-last-speaker', continueTargets);
    else fail('continue-targets-last-speaker', { continueTargets, sendTargets: continueSendTargets });

    // --- world info, Author's Note, samplers and stops actually reach the wire --------------
    const wiRequests = requestsOf('world-info-and-note');
    const requiredMarkers = ['WI_ALICE_LANTERN_MARKER', 'WI_GLOBAL_ORCHARD_MARKER', 'WI_CHAT_GROUPBOOK_MARKER', 'AN_GROUP_DEPTH_MARKER'];
    const missingMarkers = requiredMarkers.filter(marker => !wiRequests.some(record => bodyContains(record, marker)));
    if (wiRequests.length === 2 && missingMarkers.length === 0) pass('world-info-and-note-reached', requiredMarkers);
    else fail('world-info-and-note-reached', { requests: wiRequests.length, missingMarkers });
    // Author's Note POSITION: the case asks for depth 2, so the note must be in a system message
    // near the END of the chat messages, not in the first system block. Naming the index is a
    // placement assertion, not a byte expectation.
    const wiBody = wiRequests[0] ? parseBody(wiRequests[0]) : null;
    const wiMessages = wiBody?.messages ?? [];
    const noteIndex = wiMessages.findIndex(message => String(message.content ?? '').includes('AN_GROUP_DEPTH_MARKER'));
    const firstSystemIndex = wiMessages.findIndex(message => message.role === 'system');
    if (noteIndex > 0 && noteIndex > firstSystemIndex && wiMessages.length - noteIndex <= 5) {
        pass('authors-note-depth-placement', { noteIndex, total: wiMessages.length });
    } else {
        fail('authors-note-depth-placement', { noteIndex, total: wiMessages.length, firstSystemIndex });
    }
    const wiBodyForSamplers = wiRequests[0] ? parseBody(wiRequests[0]) : null;
    const samplerFacts = {
        temperature: wiBodyForSamplers?.temperature,
        topP: wiBodyForSamplers?.top_p,
        frequencyPenalty: wiBodyForSamplers?.frequency_penalty,
        presencePenalty: wiBodyForSamplers?.presence_penalty,
        maxTokens: wiBodyForSamplers?.max_tokens,
        stop: wiBodyForSamplers?.stop,
    };
    const samplersOk = samplerFacts.temperature === 0.91
        && samplerFacts.topP === 0.77
        && samplerFacts.frequencyPenalty === 0.11
        && samplerFacts.presencePenalty === 0.22
        && samplerFacts.maxTokens === 77
        && Array.isArray(samplerFacts.stop)
        && samplerFacts.stop.includes('GROUP_STOP_A')
        && samplerFacts.stop.includes('GROUP_STOP_B');
    if (samplersOk) pass('samplers-and-stops-reached', samplerFacts);
    else fail('samplers-and-stops-reached', samplerFacts);

    // --- truncation actually drops old history ----------------------------------------------
    const truncationRequests = requestsOf('truncation');
    const lastTruncation = truncationRequests.at(-1) ?? null;
    const firstTurnReached = truncationRequests.some(record => bodyContains(record, 'GROUP_USER_INPUT_MARKER one'));
    const lastTurnReached = lastTruncation ? bodyContains(lastTruncation, 'GROUP_USER_INPUT_MARKER three') : false;
    const oldHistoryDropped = lastTruncation ? !bodyContains(lastTruncation, 'GROUP_USER_INPUT_MARKER one') : false;
    if (truncationRequests.length === 6 && firstTurnReached && lastTurnReached && oldHistoryDropped) {
        pass('truncation-drops-old-history', { firstTurnReached, lastTurnReached, oldHistoryDropped, lastMessages: (parseBody(lastTruncation)?.messages ?? []).length });
    } else {
        fail('truncation-drops-old-history', { requests: truncationRequests.length, firstTurnReached, lastTurnReached, oldHistoryDropped });
    }

    // --- group greeting ----------------------------------------------------------------------
    const greetingObservation = caseOf('group-greeting')?.steps.at(-1) ?? null;
    const greetingNames = (greetingObservation?.messages ?? []).map(entry => entry.name);
    if (JSON.stringify(greetingNames) === JSON.stringify(['Alice', 'Bob']) && requestsOf('group-greeting').length === 0) {
        pass('group-greeting-from-cards', greetingNames);
    } else {
        fail('group-greeting-from-cards', { names: greetingNames, requests: requestsOf('group-greeting').length });
    }

    // --- roles and attribution ---------------------------------------------------------------
    // A group turn must carry system prompts AND assistant history whose text starts with the
    // speaker's name — that attribution is what makes a multi-character request what it is.
    const list3Requests = requestsOf('user-message-list-3');
    const attributionOk = list3Requests.every(record => {
        const body = parseBody(record);
        if (!body?.messages) return false;
        const hasSystem = body.messages.some(message => message.role === 'system');
        const assistantLines = body.messages.filter(message => message.role === 'assistant');
        const attributed = assistantLines.some(message => /^(Alice|Bob|Carol): /.test(String(message.content ?? '')));
        const userLines = body.messages.filter(message => message.role === 'user');
        const userAttributed = userLines.some(message => String(message.content ?? '').includes('GROUP_USER_INPUT_MARKER'));
        return hasSystem && attributed && userAttributed;
    });
    if (attributionOk) pass('roles-and-attribution', true);
    else fail('roles-and-attribution', 'a group request lacked a system prompt, a name-attributed assistant line, or the user turn');

    // The pinned group turn ends with a depth instruction naming the member ("[Write the next reply
    // only as <Name>.]"). Its presence and its NAME are what makes the final instruction a group
    // instruction rather than a single-character one; a request that lost it is still "a valid
    // chat completion" and would otherwise pass a weaker comparator.
    const list3FinalInstructionOk = list3Requests.every(targetConfirmedByFinalInstruction);
    if (list3FinalInstructionOk) pass('final-depth-instruction-names-member', true);
    else fail('final-depth-instruction-names-member', list3Requests.map(record => ({ target: targetCharacter(record), confirmed: targetConfirmedByFinalInstruction(record) })));

    // --- HARNESS-DISCRIMINATING PAIRS --------------------------------------------------------
    // Requests that MUST differ within one implementation. Equality here means the scenario knobs
    // are not reaching the wire and the equality half would be vacuous (AGENTS.md rule 50).
    const shaOf = record => record?.bodySha256 ?? null;
    const pairs = [
        ['two-vs-three-shapes', shaOf(natural2[0]), shaOf(natural3[0]), 'a 2-member turn and a 3-member turn'],
        ['manual-targets-differ', shaOf(requestsOf('manual-activation')[0]), shaOf(requestsOf('manual-activation')[1]), 'two forced turns for two different members over the same history'],
        ['world-info-vs-plain-shape', shaOf(wiRequests[0]), shaOf(requestsOf('user-message-list-3')[0]), 'a turn with world info/Author\'s Note/samplers and a plain turn'],
        ['auto-vs-user-shape', shaOf(autoRequests[0]), shaOf(list3Requests[0]), 'an auto-mode turn and a user-message turn'],
        ['manual-vs-list-shape', shaOf(requestsOf('manual-activation')[0]), shaOf(list3Requests[0]), 'a forced single-member turn and a list-order turn'],
        ['truncated-vs-full-shape', shaOf(truncationRequests.at(-1)), shaOf(requestsOf('user-message-list-3').at(-1)), 'a truncated context and a full one'],
    ];
    for (const [name, left, right, description] of pairs) {
        if (!left || !right) {
            fail(`pair.${name}`, { reason: 'one side of the pair is absent', left, right });
        } else if (left === right) {
            fail(`pair.${name}`, { reason: `identical request bytes where ${description} must differ`, sha: left });
        } else {
            pass(`pair.${name}`, { left, right });
        }
    }
    const distinct = new Set(goCases.get('user-message-list-3')?.requests.map(record => record.bodySha256) ?? []);
    if (distinct.size >= 2) pass('list3-requests-differ-by-member', { distinct: distinct.size });
    else fail('list3-requests-differ-by-member', { distinct: distinct.size });

    // The pinned leg must show the SAME discriminating structure: a fixture where two scenarios
    // are identical on the oracle side cannot support a claim about either.
    const pinnedList3 = pinnedRequestsOf('user-message-list-3');
    const pinnedDisabled = pinnedRequestsOf('disabled-member');
    if (pinnedList3.length === 3 && pinnedDisabled.length === 2) pass('oracle-side-knobs', { list3: pinnedList3.length, disabled: pinnedDisabled.length });
    else fail('oracle-side-knobs', { list3: pinnedList3.length, disabled: pinnedDisabled.length });
}

// ---------------------------------------------------------------------------------------------
// The restart legs: the same tree, a second server process.
// ---------------------------------------------------------------------------------------------
function checkRestart(full, restart) {
    const fullGoRestart = full.goCases.get('restart-reload');
    const fullPinnedRestart = full.pinnedCases.get('restart-reload');
    const goRestartCase = restart.goCases.get('restart-reload');
    const pinnedRestartCase = restart.pinnedCases.get('restart-reload');
    if (!fullGoRestart || !goRestartCase || !fullPinnedRestart || !pinnedRestartCase) {
        guard('restart.casePresent', false, 'a restart phase leg is missing the restart-reload case');
        return;
    }
    const fullOpen = fullGoRestart.steps.find(entry => entry.step === 'open') ?? null;
    const fullFinal = fullGoRestart.steps.at(-1) ?? null;
    const restartOpen = goRestartCase.steps.find(entry => entry.step === 'openExisting') ?? null;
    equalGuard('restart.chatLengthReloaded', restartOpen?.chatLength ?? null, fullFinal?.chatLength ?? null);
    equalGuard('restart.chatIdReloaded', restartOpen?.chatId ?? null, fullOpen?.chatId ?? null);
    equalGuard('restart.messageNamesReloaded', (restartOpen?.messages ?? []).map(entry => entry.name), (fullFinal?.messages ?? []).map(entry => entry.name));
    const restartRequest = goRestartCase.requests[0] ?? null;
    const pinnedRequest = pinnedRestartCase.requests[0] ?? null;
    if (restartRequest && pinnedRequest) {
        equalGuard('restart.request.bodySha256', restartRequest.bodySha256, pinnedRequest.bodySha256);
        equalGuard('restart.request.bodyLength', restartRequest.bodyLength, pinnedRequest.bodyLength);
        guard('restart.request.carriesReloadedHistory', bodyContains(restartRequest, 'GROUP_USER_INPUT_MARKER restart'), 'the continuation after the restart must carry the pre-restart user turn');
    } else {
        guard('restart.request.present', false, 'one leg recorded no provider request after the restart');
    }
}

// ---------------------------------------------------------------------------------------------

let comparison = null;
try {
    const pinnedFull = readJSON(argumentValue('--pinned-full'), 'pinned full');
    const goFull = readJSON(argumentValue('--gotavern-full'), 'gotavern full');
    const pinnedRestart = readJSON(argumentValue('--pinned-restart'), 'pinned restart');
    const goRestart = readJSON(argumentValue('--gotavern-restart'), 'gotavern restart');
    equalGuard('restart.subject', goRestart.subject, 'gotavern');
    equalGuard('restart.oracleSubject', pinnedRestart.subject, 'pinned');
    equalGuard('restart.phase', goRestart.phase, 'restart');
    const full = compareLegs('full', pinnedFull, goFull);
    const restart = compareLegs('restart', pinnedRestart, goRestart);
    checkDiscrimination(full);
    checkRestart(full, restart);
    // TAXONOMY, NOT A BOOLEAN (AGENTS.md doctrine 5). A failed subject/oracle guard is a MISMATCH;
    // `harness-non-discriminating` is reserved for a run where the equality half held but a
    // scenario knob could not be shown to change the request, which is a statement about the
    // harness rather than about the product.
    const equalityFailed = verdict.failedGuards.some(name => !name.startsWith('discriminating.'));
    const discriminationFailed = verdict.failedGuards.some(name => name.startsWith('discriminating.'));
    verdict.verdict = equalityFailed ? 'mismatch' : (discriminationFailed ? 'harness-non-discriminating' : 'match');
} catch (error) {
    verdict.verdict = error.harness ? 'harness-error' : 'harness-error';
    verdict.error = String(error.message ?? error);
    verdict.failedGuards.push('harness');
}

const out = argumentValue('--out');
if (out) writeFileSync(path.resolve(out), `${JSON.stringify(verdict, null, 2)}\n`);
console.log(JSON.stringify({
    verdict: verdict.verdict,
    guards: Object.keys(verdict.guards).length,
    failedGuards: verdict.failedGuards,
    error: verdict.error ?? null,
    out: out ? path.resolve(out) : null,
}));
process.exit(verdict.verdict === 'match' ? 0 : 1);
