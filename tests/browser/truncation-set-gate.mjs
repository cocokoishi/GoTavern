// Q18 -- EXACT TOKEN TRUNCATION: DO BOTH SUBJECTS KEEP AND DROP THE SAME TURNS AT THE BOUNDARY?
//
// THE QUESTION (GOAL.md Q18, docs/goal-scorecard.md): "Is token truncation the same?" The preset lane already
// drives both sides of a measured context boundary and compares the provider requests byte-for-byte; a
// different trimmer would make that red. What it does NOT say is the thing Q18 asks: WHICH turn the boundary
// is about, whether that turn is the turn that crossed it, and whether the two subjects agree on the SET of
// history turns they kept -- not merely on a digest that could differ for an unrelated reason.
//
// THE RULE THIS FILE OBEYS, AND THE REASON IT EXISTS AT ALL. AGENTS.md records seven failed runs on this
// surface because the boundary was measured by a procedure merely SIMILAR to the one that produced the
// compared request. So this gate does NOT measure anything: it takes the boundary pair that
// `preset-boundary-search.mjs` produced (same program, same arguments, same clean state as the compared
// pinned leg) and the four legs the workflow already recorded at that pair, and it asks the boundary question
// of those exact captures. If the boundary file is missing, the verdict is `BLOCKED`; if the legs are
// missing, `INFRA_ERROR`; if a leg recorded no request, `HARNESS_ERROR`. Never `PASS`.
//
// THE FOUR ASSERTIONS, each of which can fail on its own:
//   A. THE OLDEST HISTORY TURN IS PRESENT AT `keep` AND ABSENT AT `keep - 1`, on the PINNED leg. This is
//      what makes the pair a boundary rather than two numbers: the assumption is the pinned trimmer's own
//      behaviour (`populateChatHistory`, public/scripts/openai.js:949-1075), and if it does not hold the pair
//      measured nothing.
//   B. NODE AND GO AGREE ON THE KEPT SET AT `keep`, MEMBER FOR MEMBER: every history turn the pinned request
//      carried is carried by the GoTavern request, at the same relative order. A digest comparing equal
//      already implies this, and the digest is also asserted -- but the SET comparison is the sentence Q18
//      needs, and it survives a future narrow normalisation that a digest comparison would not.
//   C. THE SAME AGREEMENT AT `keep - 1`: the DROPPED set agrees too, so "they agree at the boundary" is not
//      a statement that holds only where nothing was dropped.
//   D. THE SET ACTUALLY CHANGED ACROSS THE PAIR: exactly one history turn is retained at `keep` and not at
//      `keep - 1`, on BOTH subjects. A trimmer that ignored the budget would pass A-C with the same set at
//      both contexts, and the sweep would prove nothing (AGENTS.md 50: a harness whose captures do not
//      differ must fail itself).
//
// PLUS THE PHASE/REQUEST-COUNT GUARD, without which "no difference" can be manufactured by "no request":
// every leg must have captured exactly one provider POST, every leg must have reported
// `requestArrived: true`, and the number of POSTs must be equal across the four legs. A leg with zero
// requests is `HARNESS_ERROR`, and a leg with two is `HARNESS_ERROR` (a retry or a duplicate send would make
// "which request is the comparison" a coin toss).
//
// VERDICT TAXONOMY (AGENTS.md differential doctrine 5), one per assertion:
//   PASS | PRODUCT_MISMATCH | PINNED_BEHAVIOR | HARNESS_ERROR | INFRA_ERROR | BLOCKED
//
// Usage: node truncation-set-gate.mjs --boundary <preset-boundary.json> \
//            --gotavern-keep <leg> --pinned-keep <leg> --gotavern-drop <leg> --pinned-drop <leg> \
//            [--fixture <preset fixture>] [--out <authors...>/truncation-comparison.json]
//        node truncation-set-gate.mjs --self-check
// Exit: 0 only on PASS.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { MARKERS, PRESET_FIXTURE, findMessage, messageText, parseProviderBody } from './preset-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const VERDICTS = ['PRODUCT_MISMATCH', 'PINNED_BEHAVIOR', 'HARNESS_ERROR', 'INFRA_ERROR', 'BLOCKED', 'PASS'];
const FORBIDDEN = [/127\.0\.0\.1/, /localhost:\d+/, /\[::1\]/, /[A-Za-z]:\\\\/, /AppData/i, /\/home\//, /\/tmp\//, /\/Users\//, /\/root\//];

// ---------------------------------------------------------------------------------------------
// The history turns, identified by CONTENT, in the order the scenario declares them.
//
// WHY NOT BY INDEX: the assembled list interleaves the frontend's own example, world-info and injection
// messages, and their presence depends on the budget -- so "history turn 3" is not at any fixed index, and an
// index-based set comparison would call two different sets equal whenever the churn happened to line up.
// The scenario's own history texts are the identity, which is also what the boundary search uses
// (`MARKERS.history` prefix plus the ordered turn text).
// ---------------------------------------------------------------------------------------------
export function historyTurnsOf(fixture) {
    const history = fixture?.capture?.spec?.history ?? [];
    return history.map((turn, index) => ({
        index,
        id: `TURN_${String(index).padStart(2, '0')}`,
        // A BOUNDED PREFIX, because the full turn is padded to 600 characters and 1 600 for the oldest. The
        // prefix includes the padding seed, which differs per turn, so it identifies the turn uniquely; the
        // boundary search uses the same 40-character convention for the oldest turn.
        needle: String(turn.text ?? '').slice(0, 40),
        fullLength: String(turn.text ?? '').length,
        isUser: turn.isUser === true,
    }));
}

// keptTurns: which of the scenario's turns a request body carries, in scenario order. A turn whose needle is
// absent is dropped. `order` is the position of each kept turn INSIDE the assembled list, which is what
// "same relative order" is checked on.
export function keptTurnsOf(body, turns) {
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const kept = [];
    for (const turn of turns) {
        const index = messages.findIndex(message => messageText(message).includes(turn.needle));
        if (index >= 0) kept.push({ id: turn.id, index, isUser: turn.isUser });
    }
    return kept;
}

// ---------------------------------------------------------------------------------------------
// One leg: its request, its history set, and the counts the phase guard needs.
// ---------------------------------------------------------------------------------------------
export function observeLeg(file, turns, subject) {
    let report;
    try {
        report = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
        return { error: `the ${subject} leg report ${path.basename(file)} is unreadable or absent (${error?.message ?? error})`, kind: 'INFRA_ERROR' };
    }
    const posts = (Array.isArray(report.recording) ? report.recording : []).filter(entry => entry.method === 'POST');
    const parsed = parseProviderBody(report);
    const kept = parsed ? keptTurnsOf(parsed.body, turns) : null;
    return {
        subject,
        file: path.basename(file),
        requestArrived: report.requestArrived === true,
        postCount: posts.length,
        recordedRequests: Array.isArray(report.recording) ? report.recording.length : 0,
        bodySha256: parsed?.bodySha256 ?? null,
        bodyLength: parsed?.bodyLength ?? null,
        messageCount: Array.isArray(parsed?.body?.messages) ? parsed.body.messages.length : null,
        // THE WHOLE USER/AI TURN LIST, recorded so a reader can see the boundary move rather than infer it
        // from a count. `kept` is the SET the assertions below compare.
        kept,
        keptIds: kept ? kept.map(entry => entry.id) : null,
        historyCount: kept ? kept.length : null,
        variant: report.preset?.variant ?? null,
        maxContextApplied: report.preset?.maxContextApplied ?? null,
        generationProblems: Array.isArray(report.preset?.problems) ? report.preset.problems : null,
        tokenizerAnchor: report.preset?.tokenizerAnchor?.count ?? null,
        failure: report.failure ?? null,
    };
}

// ---------------------------------------------------------------------------------------------
// The gate. Pure: it takes four leg observations and the boundary, and returns a verdict.
// ---------------------------------------------------------------------------------------------
export function judgeTruncation({ boundary, fixture, legs }) {
    const turns = historyTurnsOf(fixture);
    const checks = {};
    const details = {};
    const verdict = (name, reason, extra = {}) => ({ verdict: name, reason, checks, details: { ...details, ...extra } });

    // 0. THE BOUNDARY EXISTS AND WAS MEASURED BY THE PINNED LEG. Two numbers from anywhere else are not an
    //    oracle (`measuredBy` is what the search writes).
    if (!boundary) {
        checks.boundarySupplied = false;
        return verdict('BLOCKED', 'no boundary file was supplied, so this gate has no pair to ask its question of; run preset-boundary-search.mjs (it drives the pinned leg itself)');
    }
    checks.boundarySupplied = true;
    checks.boundaryMeasuredByThePinnedLeg = boundary.measuredBy === 'pinned-leg';
    checks.boundaryIsAPair = Number.isInteger(boundary.keepContext) && Number.isInteger(boundary.dropContext)
        && boundary.dropContext === boundary.keepContext - 1;
    details.boundary = {
        keepContext: boundary.keepContext ?? null,
        dropContext: boundary.dropContext ?? null,
        measuredBy: boundary.measuredBy ?? null,
        keep: boundary.keep ? { total: boundary.keep.total ?? null, history: boundary.keep.history ?? null, oldestPresent: boundary.keep.oldestPresent ?? null } : null,
        drop: boundary.drop ? { total: boundary.drop.total ?? null, history: boundary.drop.history ?? null, oldestPresent: boundary.drop.oldestPresent ?? null } : null,
    };
    if (!checks.boundaryMeasuredByThePinnedLeg || !checks.boundaryIsAPair) {
        return verdict(boundary.measuredBy === 'pinned-leg' ? 'HARNESS_ERROR' : 'BLOCKED',
            `the boundary file is not a pinned-leg-measured adjacent pair (measuredBy=${JSON.stringify(boundary.measuredBy)}, keep=${JSON.stringify(boundary.keepContext)}, drop=${JSON.stringify(boundary.dropContext)})`);
    }

    // 1. INFRASTRUCTURE and THE PHASE GUARD. Every leg must exist, must have reported a request, and must
    //    have captured EXACTLY ONE POST. This is the assertion that stops "no request" from reading as "no
    //    difference": a leg with zero requests has no kept set, and two empty sets would compare equal.
    const expected = ['gotavernKeep', 'pinnedKeep', 'gotavernDrop', 'pinnedDrop'];
    for (const name of expected) {
        const leg = legs[name];
        if (leg?.error) {
            checks[`${name}.readable`] = false;
            return verdict('INFRA_ERROR', leg.error);
        }
        checks[`${name}.readable`] = true;
    }
    for (const name of expected) {
        const leg = legs[name];
        checks[`${name}.requestArrived`] = leg.requestArrived === true;
        checks[`${name}.exactlyOneProviderPost`] = leg.postCount === 1;
        checks[`${name}.hasAKeptSet`] = Array.isArray(leg.kept);
    }
    const phaseFailures = expected.filter(name => !checks[`${name}.requestArrived`] || !checks[`${name}.exactlyOneProviderPost`] || !checks[`${name}.hasAKeptSet`]);
    if (phaseFailures.length > 0) {
        details.phase = Object.fromEntries(expected.map(name => [name, {
            requestArrived: legs[name].requestArrived,
            recordedRequests: legs[name].recordedRequests,
            postCount: legs[name].postCount,
            failure: legs[name].failure,
        }]));
        return verdict('HARNESS_ERROR', `the following legs did not capture exactly one provider request (${phaseFailures.join(', ')}); a leg with no request cannot agree with a leg with no request`, { phase: details.phase });
    }
    checks.allFourLegsCapturedExactlyOneRequest = true;
    checks.theFourLegsRanAtTheMeasuredContexts =
        legs.gotavernKeep.maxContextApplied === boundary.keepContext
        && legs.pinnedKeep.maxContextApplied === boundary.keepContext
        && legs.gotavernDrop.maxContextApplied === boundary.dropContext
        && legs.pinnedDrop.maxContextApplied === boundary.dropContext;
    if (!checks.theFourLegsRanAtTheMeasuredContexts) {
        return verdict('HARNESS_ERROR', 'a leg did not run at the context the pinned search measured, so the pair it belongs to is not the boundary this gate is asking about', {
            contexts: Object.fromEntries(expected.map(name => [name, { variant: legs[name].variant, maxContextApplied: legs[name].maxContextApplied }])),
        });
    }
    details.legs = Object.fromEntries(expected.map(name => [name, {
        file: legs[name].file,
        maxContextApplied: legs[name].maxContextApplied,
        bodySha256: legs[name].bodySha256,
        bodyLength: legs[name].bodyLength,
        messageCount: legs[name].messageCount,
        historyCount: legs[name].historyCount,
        keptIds: legs[name].keptIds,
        tokenizerAnchor: legs[name].tokenizerAnchor,
    }]));
    if (turns.length === 0) {
        return verdict('HARNESS_ERROR', 'the preset fixture declares no history turns, so there is no set to compare');
    }

    // 2. (A) THE BOUNDARY BINDS ON THE PINNED LEG: the OLDEST turn present at keep, absent at keep-1.
    const oldest = turns[0].id;
    checks.pinnedKeepsTheOldestTurnAtKeep = legs.pinnedKeep.keptIds.includes(oldest);
    checks.pinnedDropsTheOldestTurnAtKeepMinusOne = !legs.pinnedDrop.keptIds.includes(oldest);
    if (!checks.pinnedKeepsTheOldestTurnAtKeep || !checks.pinnedDropsTheOldestTurnAtKeepMinusOne) {
        return verdict('PINNED_BEHAVIOR', `the pair does not bind on the pinned leg: the oldest turn (${oldest}) is ${checks.pinnedKeepsTheOldestTurnAtKeep ? 'present' : 'absent'} at keep=${boundary.keepContext} and ${checks.pinnedDropsTheOldestTurnAtKeepMinusOne ? 'absent' : 'present'} at drop=${boundary.dropContext}; the boundary search measured a boundary this gate cannot reproduce`, { kept: { pinnedKeep: legs.pinnedKeep.keptIds, pinnedDrop: legs.pinnedDrop.keptIds } });
    }

    // 3. (D) THE SET CHANGED ACROSS THE PAIR, ON BOTH SUBJECTS, BY EXACTLY ONE HISTORY TURN. A trimmer that
    //    ignored the budget would satisfy 4 and 5 below with the same set twice.
    const droppedAcrossPair = (keepIds, dropIds) => keepIds.filter(id => !dropIds.includes(id));
    const gainedAcrossPair = (keepIds, dropIds) => dropIds.filter(id => !keepIds.includes(id));
    const pinnedDropped = droppedAcrossPair(legs.pinnedKeep.keptIds, legs.pinnedDrop.keptIds);
    const pinnedGained = gainedAcrossPair(legs.pinnedKeep.keptIds, legs.pinnedDrop.keptIds);
    const gotavernDropped = droppedAcrossPair(legs.gotavernKeep.keptIds, legs.gotavernDrop.keptIds);
    const gotavernGained = gainedAcrossPair(legs.gotavernKeep.keptIds, legs.gotavernDrop.keptIds);
    checks.thePinnedLegDropsExactlyOneTurnAcrossThePair = pinnedDropped.length === 1 && pinnedGained.length === 0;
    checks.theGotavernLegDropsExactlyOneTurnAcrossThePair = gotavernDropped.length === 1 && gotavernGained.length === 0;
    details.acrossThePair = { pinnedDropped, pinnedGained, gotavernDropped, gotavernGained };
    if (!checks.thePinnedLegDropsExactlyOneTurnAcrossThePair) {
        return verdict('PINNED_BEHAVIOR', `the pinned leg drops ${pinnedDropped.length} and gains ${pinnedGained.length} history turn(s) across the pair, not exactly one dropped and none gained (${JSON.stringify(details.acrossThePair)})`);
    }

    // 4. (B) NODE AND GO AGREE ON THE KEPT SET AT `keep`, member for member AND in the same relative order.
    checks.keepSetsAreEqual = JSON.stringify(legs.pinnedKeep.keptIds) === JSON.stringify(legs.gotavernKeep.keptIds);
    checks.keepRelativeOrderIsEqual = JSON.stringify(legs.pinnedKeep.kept) === JSON.stringify(legs.gotavernKeep.kept.map(entry => ({ ...entry, index: legs.pinnedKeep.kept.find(other => other.id === entry.id)?.index ?? -1 })));
    checks.keepBodiesAreByteIdentical = legs.pinnedKeep.bodySha256 !== null && legs.pinnedKeep.bodySha256 === legs.gotavernKeep.bodySha256
        && legs.pinnedKeep.bodyLength === legs.gotavernKeep.bodyLength;
    // 5. (C) THE SAME AT `keep - 1`: the DROPPED set agrees.
    checks.dropSetsAreEqual = JSON.stringify(legs.pinnedDrop.keptIds) === JSON.stringify(legs.gotavernDrop.keptIds);
    checks.dropBodiesAreByteIdentical = legs.pinnedDrop.bodySha256 !== null && legs.pinnedDrop.bodySha256 === legs.gotavernDrop.bodySha256
        && legs.pinnedDrop.bodyLength === legs.gotavernDrop.bodyLength;

    const setDifferences = [];
    if (!checks.keepSetsAreEqual) {
        setDifferences.push(keepSetDifference('at keep', legs.pinnedKeep.keptIds, legs.gotavernKeep.keptIds));
    }
    if (!checks.dropSetsAreEqual) {
        setDifferences.push(keepSetDifference('at keep-1', legs.pinnedDrop.keptIds, legs.gotavernDrop.keptIds));
    }
    if (!checks.keepRelativeOrderIsEqual) {
        setDifferences.push('the kept turns are in a different relative order inside the assembled request');
    }
    if (!checks.keepBodiesAreByteIdentical || !checks.dropBodiesAreByteIdentical) {
        setDifferences.push(`the request bytes differ (keep ${legs.pinnedKeep.bodyLength} B pinned vs ${legs.gotavernKeep.bodyLength} B GoTavern; drop ${legs.pinnedDrop.bodyLength} B vs ${legs.gotavernDrop.bodyLength} B)`);
    }
    if (setDifferences.length > 0) {
        return verdict('PRODUCT_MISMATCH', setDifferences.join('; '), { setDifferences });
    }

    // 6. THE GOTAVERN LEG MUST DROP THE SAME TURN THE PINNED LEG DROPPED. This is the sentence Q18 asks for,
    //    stated separately from "the sets are equal" because it names the CONTENT that crossed the boundary.
    checks.gotavernDropsTheSameTurn = JSON.stringify(gotavernDropped) === JSON.stringify(pinnedDropped);
    if (!checks.gotavernDropsTheSameTurn) {
        return verdict('PRODUCT_MISMATCH', `across the pair the pinned leg dropped ${JSON.stringify(pinnedDropped)} and GoTavern dropped ${JSON.stringify(gotavernDropped)}`);
    }

    const failures = Object.entries(checks).filter(([, value]) => value !== true).map(([name]) => name);
    if (failures.length > 0) {
        return verdict('PRODUCT_MISMATCH', `failed checks: ${failures.join(', ')}`);
    }
    return verdict('PASS', `both subjects keep ${legs.pinnedKeep.historyCount} history turns at ${boundary.keepContext} and ${legs.pinnedDrop.historyCount} at ${boundary.dropContext}, drop the same turn (${pinnedDropped[0]}), and the request bytes are identical at both contexts`);

    function keepSetDifference(where, pinnedIds, gotavernIds) {
        const onlyPinned = pinnedIds.filter(id => !gotavernIds.includes(id));
        const onlyGotavern = gotavernIds.filter(id => !pinnedIds.includes(id));
        return `${where}: pinned kept ${JSON.stringify(pinnedIds)} and GoTavern kept ${JSON.stringify(gotavernIds)} (only pinned ${JSON.stringify(onlyPinned)}, only GoTavern ${JSON.stringify(onlyGotavern)})`;
    }
}

// ---------------------------------------------------------------------------------------------
// SELF-CHECK: a REFUSAL, not a skip. `node --check` cannot see an undefined identifier, and every failure
// this module can have is one that would otherwise be discovered after four browser drives.
// ---------------------------------------------------------------------------------------------
function selfCheck({ boundaryPath, fixturePath, legPaths }) {
    const problems = [];
    for (const [name, value] of [['parseProviderBody', parseProviderBody], ['findMessage', findMessage], ['messageText', messageText], ['judgeTruncation', judgeTruncation], ['historyTurnsOf', historyTurnsOf], ['keptTurnsOf', keptTurnsOf]]) {
        if (typeof value !== 'function') problems.push(`preset-kit.mjs does not export ${name}`);
    }
    if (!MARKERS?.history) problems.push('preset-kit.mjs does not declare MARKERS.history');
    let fixture = null;
    try {
        fixture = JSON.parse(fs.readFileSync(fixturePath ?? PRESET_FIXTURE, 'utf8'));
    } catch (error) {
        problems.push(`the preset fixture is unreadable at ${fixturePath ?? PRESET_FIXTURE} (${error?.message ?? error})`);
    }
    if (fixture) {
        const turns = historyTurnsOf(fixture);
        if (turns.length < 2) problems.push(`the preset fixture declares ${turns.length} history turns; a boundary needs at least two to tell a kept set from a dropped one`);
        const needles = new Set(turns.map(turn => turn.needle));
        if (needles.size !== turns.length) problems.push('two history turns share a 40-character needle prefix, so a kept set cannot identify them');
        if (turns.length > 0 && String(fixture?.capture?.boundary?.oldestMarker ?? '').slice(0, 40) !== turns[0].needle) {
            problems.push(`the fixture's boundary.oldestMarker (${JSON.stringify(String(fixture?.capture?.boundary?.oldestMarker ?? '').slice(0, 40))}) is not the first history turn's needle (${JSON.stringify(turns[0].needle)}); the boundary search and this gate would be asking about different turns`);
        }
    }
    if (boundaryPath) {
        try {
            const boundary = JSON.parse(fs.readFileSync(boundaryPath, 'utf8'));
            if (boundary.measuredBy !== 'pinned-leg') problems.push(`${boundaryPath} does not say measuredBy: "pinned-leg"`);
            if (!Number.isInteger(boundary.keepContext) || !Number.isInteger(boundary.dropContext)) problems.push(`${boundaryPath} records no adjacent integer pair`);
        } catch (error) {
            problems.push(`the boundary file is unreadable at ${boundaryPath} (${error?.message ?? error})`);
        }
    }
    for (const [name, file] of Object.entries(legPaths ?? {})) {
        if (!file) problems.push(`no ${name} leg was given`);
        else if (!fs.existsSync(file)) problems.push(`the ${name} leg does not exist at ${file}`);
    }
    if (problems.length > 0) {
        console.error(`truncation-set-gate SELF-CHECK FAILED: ${problems.join('; ')}`);
        return 1;
    }
    console.log(JSON.stringify({ selfCheck: 'ok', fixture: path.basename(fixturePath ?? PRESET_FIXTURE), boundary: boundaryPath ? path.basename(boundaryPath) : null, legs: Object.keys(legPaths ?? {}) }));
    return 0;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------
const main = () => {
    const args = process.argv.slice(2);
    const value = name => {
        const index = args.indexOf(name);
        return index >= 0 ? args[index + 1] : null;
    };
    const boundaryPath = value('--boundary') ? path.resolve(value('--boundary')) : null;
    const fixturePath = value('--fixture') ? path.resolve(value('--fixture')) : PRESET_FIXTURE;
    const outPath = value('--out') ? path.resolve(value('--out')) : null;
    const files = {
        gotavernKeep: value('--gotavern-keep') ? path.resolve(value('--gotavern-keep')) : null,
        pinnedKeep: value('--pinned-keep') ? path.resolve(value('--pinned-keep')) : null,
        gotavernDrop: value('--gotavern-drop') ? path.resolve(value('--gotavern-drop')) : null,
        pinnedDrop: value('--pinned-drop') ? path.resolve(value('--pinned-drop')) : null,
    };
    if (args.includes('--self-check')) {
        // ON A BARE SELF-CHECK the legs may not exist yet (the step runs before the legs on a cold run), so
        // only the files that WERE named are required to exist. Naming none is the documented cold start.
        process.exit(selfCheck({ boundaryPath, fixturePath, legPaths: Object.fromEntries(Object.entries(files).filter(([, file]) => file !== null)) }));
    }
    if (!boundaryPath) {
        console.error('usage: node truncation-set-gate.mjs --boundary <preset-boundary.json> --gotavern-keep <leg> --pinned-keep <leg> --gotavern-drop <leg> --pinned-drop <leg> [--fixture <path>] [--out <path>]');
        process.exit(2);
    }
    let boundary = null;
    try {
        boundary = JSON.parse(fs.readFileSync(boundaryPath, 'utf8'));
    } catch (error) {
        boundary = null;
        console.error(`the boundary file is unreadable at ${boundaryPath} (${error?.message ?? error})`);
    }
    let fixture = null;
    try {
        fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    } catch (error) {
        console.error(`the preset fixture is unreadable at ${fixturePath} (${error?.message ?? error})`);
        process.exit(2);
    }
    const turns = historyTurnsOf(fixture);
    const legs = {
        gotavernKeep: files.gotavernKeep ? observeLeg(files.gotavernKeep, turns, 'GoTavern@keep') : { error: 'no GoTavern keep leg was supplied', kind: 'INFRA_ERROR' },
        pinnedKeep: files.pinnedKeep ? observeLeg(files.pinnedKeep, turns, 'pinned@keep') : { error: 'no pinned keep leg was supplied', kind: 'INFRA_ERROR' },
        gotavernDrop: files.gotavernDrop ? observeLeg(files.gotavernDrop, turns, 'GoTavern@keep-1') : { error: 'no GoTavern drop leg was supplied', kind: 'INFRA_ERROR' },
        pinnedDrop: files.pinnedDrop ? observeLeg(files.pinnedDrop, turns, 'pinned@keep-1') : { error: 'no pinned drop leg was supplied', kind: 'INFRA_ERROR' },
    };
    const result = judgeTruncation({ boundary, fixture, legs });
    const artifact = {
        schemaVersion: 1,
        surface: 'truncation',
        question: 'Q18: is token truncation the same -- do Node and Go keep and drop the same history turns at the measured context boundary?',
        pinnedBaseline: fixture?.provenance?.pinnedBaseline ?? 'SillyTavern 1.19.0, commit 06bde939fb1e9c4c8d8641d810f0a9165bce127',
        method: 'the boundary pair is the one preset-boundary-search.mjs measured by driving run-against-pinned.mjs generation-probe.mjs (the same program and arguments as the compared legs); this gate asks the set question of the four legs the workflow already recorded at that pair, and measures nothing itself',
        inputs: { boundary: path.basename(boundaryPath), legs: Object.fromEntries(Object.entries(files).map(([name, file]) => [name, file ? path.basename(file) : null])) },
        turns: turns.map(turn => turn.id),
        ...result,
        verdictTaxonomy: VERDICTS,
    };
    // RULE 18: a committed artefact must not carry a host-derived value. The sweep is the same one the
    // verifier runs, applied here so a gate that leaks a path fails its own run.
    const text = JSON.stringify(artifact);
    const leaked = FORBIDDEN.filter(pattern => pattern.test(text));
    artifact.noHostDerivedValue = leaked.length === 0;
    if (leaked.length > 0) artifact.hostDerivedPatterns = leaked.map(String);
    const body = `${JSON.stringify(artifact, null, 2)}\n`;
    if (outPath) fs.writeFileSync(outPath, body);
    console.log(body);
    if (artifact.verdict !== 'PASS' || leaked.length > 0) {
        console.error(`truncation gate: ${artifact.verdict} -- ${artifact.reason}`);
        process.exit(1);
    }
};

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
    main();
}
