// TEETH FOR THE COMBINATION-JOURNEY COMPARATOR, INCLUDING THE E03+E04 PROFILE CONTRACT.
//
// A comparator that can return `match` is only evidence if it can return `mismatch`, and AGENTS 4 requires the red
// to be OBSERVED and NAMED. This file has TWO suites:
//
//   1. THE SYNTHETIC PROFILE SUITE, which needs NO browser, NO leg files and NO pinned boot. It builds a minimal
//      pair of legs in memory from the committed kit's own `expectedOrder` (a fast-tier 12-block profile), proves
//      every target guard is GREEN in the unmutated pair, then plants each design-section-6 defect and requires the
//      NAMED guard to go RED. It runs locally (`node tests/browser/combination-journey-gate-selftest.mjs`) and in CI
//      before the live legs, so the profile contract's teeth are provable without paying for a browser run.
//   2. THE LIVE MUTATION SUITE, unchanged in intent from before this task: with `<go-drive.json> <pinned-drive.json>`
//      supplied it mutates the REAL legs in memory (never on disk, AGENTS 57), requires the target guard green in the
//      unmutated pair first, then requires it red.
//
// THE PLANTED CASES, one per design section 6 row (each names its target assertion):
//   * swap two world-book entry positions          -> worldbook-order-<book>-<slot>
//   * disable one preset block the fixture enabled -> preset-block-present-<MARKER_Pxxxx>
//   * drop the QR-written variable before the helper reads it -> qr-to-helper-chain
//   * turn the helper off                          -> helper-variable-marker
//   * remove one extension's own effect            -> extension-effect-<name>
//   * duplicate one user message in the persisted chat -> ordered-message-ids
//   * omit the card-embedded book                  -> card-character-book-marker
//   * record an artifact with a wrong head SHA     -> artifact-identity-complete (+ the verifier's own refusal)
//   * make both subjects identical with every knob off -> HARNESS-NON-DISCRIMINATING
//   * a leg with no profile record when one was requested -> e03e04-profile-recorded (REFUSED, never downgraded)
//
// Usage:
//   node tests/browser/combination-journey-gate-selftest.mjs                        # synthetic suite only
//   node tests/browser/combination-journey-gate-selftest.mjs <go> <pinned>          # synthetic + live mutations
//   (the CI workflow passes the two real leg files, so both suites run there)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import {
    EVIDENCE_ARTIFACT_KIND,
    PINNED_BASELINE_COMMIT,
    compareCombinationJourney,
    verifyArtifactIdentity,
} from './compare-combination-journey.mjs';
import { buildProfile, canonicalJson, sha256, TIERS } from './extensions/e03e04-profile-kit.mjs';
import { EXTENSION_TIERS } from './extensions/extension-install-batch.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const PROFILE_SEED = 'e03e04-gate-selftest';
const PROFILE_TIER = 'fast';

const cases = [];
const record = (name, ok, detail) => {
    cases.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -- ${JSON.stringify(detail).slice(0, 900)}`}`);
};

// ---------------------------------------------------------------------------------------------------------------
// A MINIMAL PROFILE PAIR, built from the kit's own manifest so the expected order is the real one.
// ---------------------------------------------------------------------------------------------------------------
function buildSyntheticProfileLegs() {
    const built = buildProfile({ seed: PROFILE_SEED, blockCount: TIERS[PROFILE_TIER], tier: PROFILE_TIER });
    const expectedOrder = built.expectedOrder;
    const record = {
        kind: 'e03e04-profile-record',
        schemaVersion: 1,
        profile: 'e03e04',
        tier: PROFILE_TIER,
        seed: PROFILE_SEED,
        blockCount: built.preset.e03e04_profile.blockCount,
        expectedOrderSha256: sha256(canonicalJson(expectedOrder)),
        expectedOrder,
        preset: { sha256: sha256(canonicalJson(built.preset)) },
        cardCharacterBook: { name: built.books.cardEmbedded.name, sha256: sha256(canonicalJson(built.books.cardEmbedded.characterBook)) },
        settingsPatch: { sha256: sha256(canonicalJson(built.settings)) },
        activation: built.books.activation,
        worldInfoSettings: built.books.worldInfoSettings,
        extensionTier: PROFILE_TIER,
    };
    const extensionTier = EXTENSION_TIERS[PROFILE_TIER];
    const extensionNames = ['JS-Slash-Runner', 'LittleWhiteBox', 'SillyTavern-Horae'].slice(0, extensionTier);
    const extensions = {
        tier: PROFILE_TIER,
        expected: extensionTier,
        installedCount: extensionTier,
        lockSha256: sha256('synthetic-lock'),
        installed: extensionNames.map((name, index) => ({
            name,
            commit: String(index + 1).repeat(40).slice(0, 40),
            source: index === 0 ? 'pinned-canary' : 'corpus-lock',
            directory: `default-user/extensions/${name}`,
            wireEffect: index < 2
                ? { status: 'capability-relevant-unproven', evidence: 'synthetic selftest evidence' }
                : { status: 'no-wire-effect', evidence: 'synthetic selftest evidence' },
        })),
        serveEvidence: extensionNames.map(name => ({ name, url: `/scripts/extensions/third-party/${name}/manifest.json`, status: 200, ok: true })),
    };
    const identity = {
        kind: 'combination-journey-leg',
        schemaVersion: 1,
        headSha: 'a'.repeat(40),
        pinnedSha: PINNED_BASELINE_COMMIT,
        profile: 'e03e04',
        tier: PROFILE_TIER,
        seed: PROFILE_SEED,
        extensionTier: PROFILE_TIER,
        blockCount: record.blockCount,
        nonce: 'synthetic',
        phase: 'drive',
        subject: 'synthetic',
        digests: {
            preset: record.preset.sha256,
            expectedOrder: record.expectedOrderSha256,
            cardCharacterBook: record.cardCharacterBook.sha256,
            settingsPatch: record.settingsPatch.sha256,
        },
    };

    const body = armedBody(expectedOrder);
    const armedRequest = { case: 'turn-1-armed', method: 'POST', path: '/v1/chat/completions', requestedStream: true, served: { wire: 'sse' }, ...bodyFields(body) };
    const presetOffBody = { messages: [{ role: 'system', content: 'CONTROL_NO_MARKERS' }, { role: 'user', content: 'COMB_PRESET_OFF' }] };
    const wiOffBody = { messages: [{ role: 'system', content: 'CONTROL_NO_MARKERS' }, { role: 'user', content: 'COMB_WI_OFF' }] };
    const makeLeg = subject => ({
        schemaVersion: 1,
        question: 'synthetic gate-selftest leg',
        phase: 'drive',
        subject,
        nonce: 'synthetic',
        steps: [{ name: 'synthetic-leg', ok: true, detail: null }],
        requests: [
            armedRequest,
            { case: 'control-preset-off', method: 'POST', path: '/v1/chat/completions', requestedStream: true, served: { wire: 'sse' }, ...bodyFields(presetOffBody) },
            { case: 'control-wi-off', method: 'POST', path: '/v1/chat/completions', requestedStream: true, served: { wire: 'sse' }, ...bodyFields(wiOffBody) },
        ],
        captures: [],
        pageErrors: [],
        browser: {
            profileChain: { readbackCarriesWrite: true, chain: { intendedOrder: ['qr-script-writes-chat-var', 'helper-reads-scopes', 'helper-injects-readback', 'qr-injects-prompt'] } },
            orderedMessageIds: {
                domIdsUnique: true,
                domIdsCoverChat: true,
                userMarkers: [{ index: 1, marker: 'COMB_TURN_1' }, { index: 3, marker: 'COMB_TURN_2' }, { index: 5, marker: 'COMB_FINAL_TURN' }],
            },
        },
        disk: { projection: {} },
        fixture: { card: { sha256: 'f'.repeat(64) }, apiSurface: { pinned: true } },
        identity,
        extensions,
        e03e04: {
            profile: 'e03e04',
            tier: PROFILE_TIER,
            seed: PROFILE_SEED,
            blockCount: record.blockCount,
            expectedOrderSha256: record.expectedOrderSha256,
            record,
        },
    });
    return { built, expectedOrder, legs: { go: makeLeg('gotavern'), pinned: makeLeg('pinned') } };
}

function bodyFields(bodyObject) {
    const body = JSON.stringify(bodyObject);
    return { body, byteLength: Buffer.byteLength(body, 'utf8'), sha256: sha256(body) };
}

/** The armed body a correct run would send: the manifest's markers at their documented positions. */
function armedBody(expectedOrder) {
    const beforeMarkers = Object.values(expectedOrder.worldBooks)
        .flatMap(book => (book.slots?.before ?? []).map(marker => ({ marker, order: book.markers.find(item => item.marker === marker)?.order ?? 0 })))
        .sort((left, right) => left.order - right.order).map(item => item.marker);
    const afterMarkers = Object.values(expectedOrder.worldBooks)
        .flatMap(book => (book.slots?.after ?? []).map(marker => ({ marker, order: book.markers.find(item => item.marker === marker)?.order ?? 0 })))
        .sort((left, right) => left.order - right.order).map(item => item.marker);
    const messages = [
        { role: 'system', content: beforeMarkers.join('\n') },
        { role: 'system', content: 'SYNTHETIC_MAIN_PROMPT' },
        { role: 'system', content: afterMarkers.join('\n') },
    ];
    for (const item of expectedOrder.sequence.filter(entry => entry.kind === 'preset-block')) {
        messages.push({ role: item.role, content: item.marker });
    }
    const absolute = expectedOrder.history.absoluteBlocks.flatMap(group => group.markers);
    if (absolute.length > 0) messages.push({ role: 'system', content: absolute.join('\n') });
    for (const group of expectedOrder.history.depthEntries) {
        if (group.markers.length === 0) continue;
        messages.push({ role: group.role === 1 ? 'user' : 'system', content: group.markers.join('\n') });
    }
    messages.push({ role: 'user', content: 'COMB_VAR_CHAT[chat]=comb_chat_var="COMB_QR_WROTE_MARKER"\nCOMB_QR_INJECTED_MARKER' });
    messages.push({ role: 'user', content: 'COMB_TURN_1 E03E04BTRIGGER' });
    messages.push({ role: 'assistant', content: 'COMB_REGEX_OK_1' });
    return { messages };
}

// ---------------------------------------------------------------------------------------------------------------
// THE SYNTHETIC SUITE.
// ---------------------------------------------------------------------------------------------------------------
const synthetic = buildSyntheticProfileLegs();
const judge = legs => compareCombinationJourney({ goDrive: clone(legs.go), pinnedDrive: clone(legs.pinned), expectProfile: 'e03e04' });

function syntheticMutation(name, targetGuard, mutate) {
    const baseline = judge(synthetic.legs);
    const guardWasGreen = baseline.guards[targetGuard] === true;
    const legs = clone(synthetic.legs);
    mutate(legs);
    const mutated = judge(legs);
    const guardWentRed = mutated.guards[targetGuard] === false;
    record(name, guardWasGreen && guardWentRed, {
        targetGuard,
        baselineGuard: baseline.guards[targetGuard],
        mutatedGuard: mutated.guards[targetGuard],
        failedGuards: mutated.failedGuards.slice(0, 10),
    });
}

function mutateArmedBody(leg, transform) {
    const request = (leg.requests ?? []).find(entry => entry.case === 'turn-1-armed');
    if (!request) throw new Error('the synthetic leg has no turn-1-armed capture to mutate');
    const parsed = JSON.parse(request.body);
    const next = transform(parsed) ?? parsed;
    Object.assign(request, bodyFields(next));
}

// 1. SWAP TWO WORLD-BOOK ENTRY POSITIONS (design section 6 row 1). The recursive book's before-slot has two entries
//    (WC0005 order 6, WC0001 order 11); swapping their positions in the slot text is exactly "the entries came out in
//    the wrong order".
syntheticMutation(
    'THE-WORLD-BOOK-ENTRY-ORDER-IS-SWAPPED goes RED by worldbook-order-recursiveGlobal-before',
    'worldbook-order-recursiveGlobal-before',
    legs => mutateArmedBody(legs.go, body => {
        const ordered = synthetic.expectedOrder.worldBooks.recursiveGlobal.slots.before;
        for (const message of body.messages) {
            if (ordered.every(marker => message.content.includes(marker))) {
                message.content = ordered.slice().reverse().join('\n');
                return body;
            }
        }
        throw new Error('the synthetic armed body has no recursiveGlobal before-slot message to swap');
    }),
);

// 2. DISABLE ONE PRESET BLOCK THE FIXTURE ENABLED (design section 6 row 2).
const firstEnabledMarker = synthetic.expectedOrder.blocks.enabledRelative[0];
syntheticMutation(
    `A-PRESET-BLOCK-VANISHES goes RED by preset-block-present-${firstEnabledMarker}`,
    `preset-block-present-${firstEnabledMarker}`,
    legs => mutateArmedBody(legs.go, body => {
        for (const message of body.messages) {
            if (message.content === firstEnabledMarker) { message.content = 'MUTATED_AWAY'; return body; }
            if (message.content.includes(firstEnabledMarker)) { message.content = message.content.replace(firstEnabledMarker, 'MUTATED_AWAY'); return body; }
        }
        throw new Error('the synthetic armed body does not carry the enabled block marker');
    }),
);

// 3. DROP THE QR-WRITTEN VARIABLE BEFORE THE HELPER READS IT (design section 6 row 3).
syntheticMutation(
    'THE-QR-WRITTEN-VARIABLE-IS-DROPPED goes RED by qr-to-helper-chain',
    'qr-to-helper-chain',
    legs => mutateArmedBody(legs.go, body => {
        for (const message of body.messages) {
            if (message.content.includes('COMB_VAR_CHAT')) {
                message.content = message.content.replace('comb_chat_var="COMB_QR_WROTE_MARKER"', 'comb_chat_var="MUTATED_MISSING"');
                return body;
            }
        }
        throw new Error('the synthetic armed body has no helper readback line');
    }),
);

// 4. TURN THE HELPER OFF (design section 6 row 4).
syntheticMutation(
    'THE-HELPER-IS-OFF goes RED by helper-variable-marker',
    'helper-variable-marker',
    legs => mutateArmedBody(legs.go, body => {
        body.messages = body.messages.filter(message => !message.content.includes('COMB_VAR_CHAT'));
        return body;
    }),
);

// 5. REMOVE ONE EXTENSION'S OWN EFFECT RECORD (design section 6 row 5).
const firstExtension = synthetic.legs.go.extensions.installed[0].name;
syntheticMutation(
    `AN-EXTENSION-EFFECT-IS-MISSING goes RED by extension-effect-${firstExtension}`,
    `extension-effect-${firstExtension}`,
    legs => {
        legs.go.extensions.installed = legs.go.extensions.installed.filter(entry => entry.name !== firstExtension);
    },
);

// 6. DUPLICATE ONE USER MESSAGE IN THE PERSISTED CHAT (design section 6 row 6).
syntheticMutation(
    'A-USER-MESSAGE-IS-DUPLICATED goes RED by ordered-message-ids',
    'ordered-message-ids',
    legs => {
        const markers = legs.go.browser.orderedMessageIds.userMarkers;
        markers.push(clone(markers[0]));
    },
);

// 7. OMIT THE CARD-EMBEDDED BOOK (design section 6 row 7).
syntheticMutation(
    'THE-CARD-EMBEDDED-BOOK-IS-OMITTED goes RED by card-character-book-marker',
    'card-character-book-marker',
    legs => mutateArmedBody(legs.go, body => {
        const cardMarkers = synthetic.expectedOrder.worldBooks.cardEmbedded.markers
            .map(item => item.marker)
            .filter(marker => !synthetic.expectedOrder.absent.some(item => item.marker === marker));
        body.messages = body.messages.filter(message => !cardMarkers.some(marker => message.content.includes(marker)));
        return body;
    }),
);

// 8. RECORD AN ARTIFACT WITH A WRONG HEAD SHA (design section 6 row 8): the comparator's guard, AND the fail-closed
//    verifier (which re-derives document digests from disk).
syntheticMutation(
    'A-WRONG-HEAD-SHA goes RED by artifact-identity-complete',
    'artifact-identity-complete',
    legs => { legs.go.identity.headSha = 'Z'.repeat(40); },
);

// 9. MAKE BOTH SUBJECTS PRODUCE IDENTICAL CAPTURES WITH EVERY KNOB OFF (AGENTS 50 / design section 6 row 9).
syntheticMutation(
    'ALL-KNOBS-OFF-IS-NON-DISCRIMINATING goes RED by HARNESS-NON-DISCRIMINATING',
    'HARNESS-NON-DISCRIMINATING',
    legs => {
        const armedSha = legs.go.requests.find(entry => entry.case === 'turn-1-armed').sha256;
        for (const leg of [legs.go, legs.pinned]) {
            for (const request of leg.requests) {
                if (request.case === 'control-preset-off' || request.case === 'control-wi-off') request.sha256 = armedSha;
            }
        }
    },
);

// 10. A REFUSED RUN: the pinned leg lost its profile record while the profile was requested. The comparator must
//     FAIL BY NAME, not silently fall back to the legacy guard set.
syntheticMutation(
    'A-MISSING-PROFILE-RECORD-IS-REFUSED goes RED by e03e04-profile-recorded',
    'e03e04-profile-recorded',
    legs => { delete legs.pinned.e03e04; },
);

// 11. THE ARTIFACT VERIFIER: a good identity verifies; a wrong head SHA, a wrong pinned SHA, a missing field and a
//     tampered document digest are each REFUSED (never warnings). The document bytes are real files in a temp dir.
function artifactVerifierCases() {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cj-selftest-'));
    const legFile = path.join(directory, 'go-drive.json');
    fs.writeFileSync(legFile, '{"synthetic":true}\n');
    const documentSha = sha256(fs.readFileSync(legFile));
    const good = {
        kind: EVIDENCE_ARTIFACT_KIND,
        schemaVersion: 1,
        headSha: 'a'.repeat(40),
        pinnedSha: PINNED_BASELINE_COMMIT,
        profile: 'e03e04',
        tier: 'full',
        seed: PROFILE_SEED,
        documents: { 'go-drive': { path: legFile, sha256: documentSha } },
    };
    const verified = verifyArtifactIdentity(good);
    record('THE-ARTIFACT-VERIFIER-ACCEPTS-A-CORRECT-IDENTITY', verified.ok === true, verified);
    const wrongHead = verifyArtifactIdentity({ ...good, headSha: 'Z'.repeat(40) });
    record('THE-ARTIFACT-VERIFIER-REFUSES-A-WRONG-HEAD-SHA', wrongHead.ok === false && wrongHead.problems.some(problem => problem.includes('headSha')), wrongHead);
    const wrongPinned = verifyArtifactIdentity({ ...good, pinnedSha: 'b'.repeat(40) });
    record('THE-ARTIFACT-VERIFIER-REFUSES-A-WRONG-PINNED-SHA', wrongPinned.ok === false && wrongPinned.problems.some(problem => problem.includes('pinnedSha')), wrongPinned);
    const tampered = verifyArtifactIdentity({ ...good, documents: { 'go-drive': { path: legFile, sha256: 'c'.repeat(64) } } });
    record('THE-ARTIFACT-VERIFIER-REFUSES-A-TAMPERED-DOCUMENT-DIGEST', tampered.ok === false && tampered.problems.some(problem => problem.includes('digest')), tampered);
    const missing = verifyArtifactIdentity({ ...good, profile: '' });
    record('THE-ARTIFACT-VERIFIER-REFUSES-A-MISSING-FIELD', missing.ok === false && missing.problems.some(problem => problem.includes('profile')), missing);
    const unreadable = verifyArtifactIdentity({ ...good, documents: { 'go-drive': { path: path.join(directory, 'missing.json'), sha256: documentSha } } });
    record('THE-ARTIFACT-VERIFIER-REFUSES-AN-UNREADABLE-DOCUMENT', unreadable.ok === false && unreadable.problems.some(problem => problem.includes('cannot be read')), unreadable);
    fs.rmSync(directory, { recursive: true, force: true });
}

artifactVerifierCases();

// The baseline itself must be green for the target guards, or every planted red above would be vacuous. The legacy
// guards are allowed to be red here: the synthetic pair is not a full journey, and each planted case only claims its
// OWN target guard was green first (the per-guard precondition below is the same discipline the live suite uses).
const syntheticBaseline = judge(synthetic.legs);
const requiredGreen = [
    'e03e04-profile-recorded',
    'e03e04-profile-identical',
    'e03e04-extensions-installed',
    'preset-block-order',
    'worldbook-order-recursiveGlobal-before',
    `preset-block-present-${firstEnabledMarker}`,
    'qr-to-helper-chain',
    'helper-variable-marker',
    `extension-effect-${firstExtension}`,
    'ordered-message-ids',
    'card-character-book-marker',
    'artifact-identity-complete',
    'HARNESS-NON-DISCRIMINATING',
];
const baselineProblems = requiredGreen.filter(name => syntheticBaseline.guards[name] !== true);
record('THE-SYNTHETIC-PAIR-IS-GREEN-FOR-EVERY-TARGET-GUARD', baselineProblems.length === 0, { notGreen: baselineProblems });

// ---------------------------------------------------------------------------------------------------------------
// THE LIVE MUTATION SUITE (only when the workflow passes the two real leg files).
// ---------------------------------------------------------------------------------------------------------------
function liveMutations(goPath, pinnedPath) {
    const live = { go: JSON.parse(fs.readFileSync(path.resolve(goPath), 'utf8')), pinned: JSON.parse(fs.readFileSync(path.resolve(pinnedPath), 'utf8')) };
    const judgeLive = legs => compareCombinationJourney({ goDrive: clone(legs.go), pinnedDrive: clone(legs.pinned) });
    const setStep = (report, name, ok) => {
        const step = (report.steps ?? []).find(entry => entry.name === name);
        if (!step) throw new Error(`the leg has no step ${JSON.stringify(name)} to mutate`);
        step.ok = ok;
        step.detail = { mutated: true };
    };
    const mutation = (name, targetGuard, mutate) => {
        const baseline = judgeLive(live);
        const guardWasGreen = baseline.guards[targetGuard] === true;
        const legs = clone(live);
        let mutateError = null;
        try { mutate(legs); } catch (error) { mutateError = String(error?.message ?? error); }
        const mutated = mutateError ? { guards: {}, failedGuards: [] } : judgeLive(legs);
        const guardWentRed = mutateError === null && mutated.guards[targetGuard] === false;
        record(name, guardWasGreen && guardWentRed, {
            targetGuard,
            baselineGuard: baseline.guards[targetGuard],
            mutatedGuard: mutateError ?? mutated.guards[targetGuard],
            failedGuards: (mutated.failedGuards ?? []).slice(0, 10),
        });
    };
    mutation('THE-QUICK-REPLY-INJECTION-IS-DROPPED goes RED by turn-1-quick-reply-in-request',
        'turn-1-quick-reply-in-request',
        legs => setStep(legs.go, 'turn-1-quick-reply-in-request', false));
    mutation('THE-PRESET-PIECES-VANISH goes RED by turn-1-preset-pieces-in-request',
        'turn-1-preset-pieces-in-request',
        legs => setStep(legs.pinned, 'turn-1-preset-pieces-in-request', false));
    mutation('THE-VARIABLES-VANISH goes RED by turn-1-variables-in-request',
        'turn-1-variables-in-request',
        legs => setStep(legs.pinned, 'turn-1-variables-in-request', false));
    mutation('A-SUBJECT-MISSES-A-TURN goes RED by both-subjects-captured-the-same-turns',
        'both-subjects-captured-the-same-turns',
        legs => {
            const kept = (legs.pinned.requests ?? []).filter(entry => entry.case !== 'turn-2-after-regex');
            if (kept.length === (legs.pinned.requests ?? []).length) throw new Error('the pinned leg has no turn-2-after-regex capture to remove');
            legs.pinned.requests = kept;
        });
    mutation('THE-DURABLE-CHAT-IS-EMPTIED goes RED by both-subjects-wrote-a-journey-chat',
        'both-subjects-wrote-a-journey-chat',
        legs => {
            const projection = legs.go.disk?.projection ?? null;
            if (!projection) throw new Error('the GoTavern leg has no disk projection to mutate');
            for (const file of Object.values(projection)) file.messages = [];
        });
    // THE PROFILE CONTRACT ON THE REAL LEGS: when the pair carries e03e04 records, mutate the armed body the same way
    // the synthetic suite does, so the live legs must show the same named reds.
    if (live.go.e03e04?.record?.expectedOrder && live.pinned.e03e04?.record?.expectedOrder) {
        const expected = live.go.e03e04.record.expectedOrder;
        const targetMarker = expected.blocks.enabledRelative[0];
        mutation(`THE-LIVE-PRESET-BLOCK-VANISHES goes RED by preset-block-present-${targetMarker}`,
            `preset-block-present-${targetMarker}`,
            legs => {
                const request = (legs.go.requests ?? []).find(entry => entry.case === 'turn-1-armed');
                if (!request) throw new Error('the live leg has no turn-1-armed capture');
                request.body = String(request.body).replace(targetMarker, 'MUTATED_AWAY');
                request.sha256 = sha256(request.body);
            });
    }
}

const positional = process.argv.slice(2).filter(entry => entry !== '--json');
if (positional.length === 2) {
    liveMutations(positional[0], positional[1]);
} else if (positional.length !== 0) {
    console.error('usage: node combination-journey-gate-selftest.mjs [<go-drive.json> <pinned-drive.json>]');
    process.exit(2);
}

const failed = cases.filter(entry => entry.ok !== true);
console.log(`[selftest] ${cases.length - failed.length}/${cases.length} planted case(s) produced their NAMED red`);
if (failed.length > 0) {
    console.error(`[selftest] NOT DEMONSTRATED: ${failed.map(entry => entry.name).join(', ')}`);
    process.exit(1);
}
