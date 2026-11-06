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
//   * the dispatch-42173399186 defect: preset SELECTED but not APPLIED -> e03e04-preset-applied
//   * staged preset digest confused with the kit digest -> e03e04-preset-document-recorded
//   * the embedded book imported but NOT bound to the character (the dialog-only half) -> e03e04-embedded-book-imported
//   * a group turn that did not persist, or persisted outside the group-chat directory -> group-chat-persisted-parity
//   * an outgoing prompt replaced by an installed orchestrator (narrative-agent) -> outgoing-prompt-integrity
//   * an installed orchestrator observed but not configured off through its own setting -> extension-prompt-takeover-handled
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
import { GLOBAL_PROMPT_ORDER_DUMMY_ID as KIT_GLOBAL_PROMPT_ORDER_DUMMY_ID, chooseOverlayDismissal, classifyBlockingOverlays, stagedPresetDocument, validateStagedPreset } from './extensions/combination-journey-kit.mjs';
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
        preset: {
            file: 'OpenAI Settings/e03e04-profile.json',
            sha256: sha256('synthetic-staged-preset-bytes'),
            kitSha256: sha256(canonicalJson(built.preset)),
            promptOrderCharacterIds: ['100001', '100000'],
            activePromptOrderCharacterId: 100001,
            declaredPrompts: built.preset.prompts.length,
            activeOrderLength: built.preset.prompt_order[0].order.length,
            transformation: { kind: 'add-active-prompt-order-row', reason: 'synthetic selftest: the dispatch root cause' },
        },
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
            kitPreset: record.preset.kitSha256,
            expectedOrder: record.expectedOrderSha256,
            cardCharacterBook: record.cardCharacterBook.sha256,
            settingsPatch: record.settingsPatch.sha256,
        },
    };

    const body = armedBody(expectedOrder);
    const armedRequest = { case: 'turn-1-armed', method: 'POST', path: '/v1/chat/completions', requestedStream: true, served: { wire: 'sse' }, ...bodyFields(body) };
    const presetOffBody = { messages: [{ role: 'system', content: 'CONTROL_NO_MARKERS' }, { role: 'user', content: 'COMB_PRESET_OFF' }] };
    // THE WORLD-INFO-OFF ARM KEEPS THE PRESET APPLIED (it disables world info only), so its body still carries the
    // enabled preset markers. Dispatch 42178757887 measured 6 on both subjects and the old synthetic pair encoded the
    // opposite expectation; the guard's new clause is exercised by this fixture.
    const wiOffBody = {
        messages: [
            { role: 'system', content: 'SYNTHETIC_WI_OFF_KEEPS_PRESET' },
            ...expectedOrder.blocks.enabledRelative.map(marker => ({ role: 'system', content: marker })),
            { role: 'user', content: 'COMB_WI_OFF' },
        ],
    };
    // THE DURABLE CHAT: three journey files whose first messages collide (main chat and branch both open with the
    // greeting) and whose insertion order differs between subjects -- the comparator must sort on CONTENT, not on the
    // first message or the timestamped file name (dispatch 42178757887's branch/main order flipped with the listing).
    const journeyFiles = () => ([
        ['default-user/chats/COMB_JOURNEY_CARD - T.jsonl', {
            messages: [
                { name: 'COMB_JOURNEY_CARD', is_user: false, mes: 'COMB_CARD_GREETING', swipes: ['COMB_CARD_GREETING'], swipe_id: 0 },
                { name: 'Probe User', is_user: true, mes: 'COMB_TURN_1', swipes: null, swipe_id: null, branches: ['COMB_JOURNEY_CARD - T - Branch #1'] },
                { name: 'COMB_JOURNEY_CARD', is_user: false, mes: 'COMB_REGEX_OK_1 COMB_REGEX_OK_5', swipes: ['COMB_REGEX_OK_1 COMB_REGEX_OK_5'], swipe_id: 0, branches: null },
                { name: 'Probe User', is_user: true, mes: 'COMB_FINAL_TURN', swipes: null, swipe_id: null, branches: null },
            ],
        }],
        ['default-user/chats/COMB_JOURNEY_CARD - T - Branch #1.jsonl', {
            messages: [
                { name: 'COMB_JOURNEY_CARD', is_user: false, mes: 'COMB_CARD_GREETING', swipes: ['COMB_CARD_GREETING'], swipe_id: 0, branches: null },
                { name: 'Probe User', is_user: true, mes: 'COMB_TURN_1', swipes: null, swipe_id: null, branches: null },
            ],
        }],
        ['default-user/chats/Alice - T.jsonl', {
            messages: [
                { name: 'Alice', is_user: false, mes: 'COMB_GROUP_TURN greeting', swipes: ['COMB_GROUP_TURN greeting'], swipe_id: 0, branches: null },
                { name: 'Probe User', is_user: true, mes: 'COMB_GROUP_TURN', swipes: null, swipe_id: null, branches: null },
            ],
        }],
    ]);
    const projectionFor = subject => {
        const files = journeyFiles();
        // DELIBERATELY DIFFERENT KEY ORDER: content sorts equal, the directory listing does not.
        const ordered = subject === 'gotavern' ? files : [files[2], files[0], files[1]];
        return Object.fromEntries(ordered);
    };
    const makeLeg = subject => ({
        schemaVersion: 1,
        question: 'synthetic gate-selftest leg',
        phase: 'drive',
        subject,
        nonce: 'synthetic',
        steps: [
            { name: 'synthetic-leg', ok: true, detail: null },
            // THE STREAMING-ARMING EVIDENCE (dispatch 42203249658): the probe records the setting read/restore before
            // turn 1 and the turn's wire request must have asked for a stream. The synthetic pair carries both, so the
            // planted non-streaming case below can go red on exactly the guard that names it.
            { name: 'streaming-setting-armed-before-turn-1', ok: true, detail: { ok: true, expected: true, restored: false } },
            { name: 'turn-1-streaming-requested', ok: true, detail: { requestedStream: true, served: 'sse' } },
        ],
        // THE LEG-COMPLETION RECORD (dispatch 42203249658): a completed phase lists its landmarks; the probe emits
        // `leg-completed-all-expected-phases` and the comparator guard `legs-are-complete` requires this record.
        completion: { phase: 'drive', ok: true, landmarks: ['turn-1-request-captured', 'streaming-setting-armed-before-turn-1', 'journey-chat-written', 'e03e04-ordered-message-ids-recorded'], missing: [], steps: 3, failure: null },
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
            // THE OUTGOING PROMPT'S INTEGRITY (task-21): the probe records a named record for the first measured turn;
            // with an orchestrating extension installed it would carry `reason`/`extension` instead of ok:true.
            outgoingPromptIntegrity: { ok: true, captured: 1 },
            // THE BLOCKING-OVERLAY RECORD (task-23): empty when no overlay is present (the fast tier's shape), a
            // dismissal entry naming the overlay id and the clicked button when one was dismissed.
            overlayHandling: { ok: true, dismissals: [], undismissable: [], observations: [] },
            // THE GENERATION TRAIL (dispatch 42207738114): turn 1's attributed request is the streaming NORMAL generation;
            // a synthetic pair has no extension quiet generations, and the planted interception case below adds one on the
            // pinned leg to prove the parity guard has teeth.
            // THE QUIET-GENERATION EXTENSION RECORD (dispatch 42207738114): fast-tier shape = not installed, handled.
            quietGenerationExtension: { installed: false, handled: true, extension: null, decision: null, after: { settingsEnabled: null }, sourceEvidence: [], reason: null },
            generationTrail: {
                cases: [{
                    case: 'turn-1-armed',
                    window: { reset: true },
                    events: [{ kind: 'generation-started', type: 'normal' }, { kind: 'completion-settings-ready', type: 'normal', stream: true }],
                    windowRequests: [{ requestedStream: true, servedWire: 'sse', byteLength: 27038, sha256: 'synthetic-normal' }],
                    attributed: [{ requestedStream: true, servedWire: 'sse', sha256: 'synthetic-normal', byteLength: 27038 }],
                    extensionGenerations: [],
                    quietBeforeAttributed: [],
                    normalGenerationWait: null,
                    assistant: { ok: true },
                    reason: null,
                }],
            },
            // THE GROUP TURN'S PERSISTED EFFECT (task-19): the probe flushes it through the product's own save and reads
            // the GROUP-CHAT directory (`<user>/group chats/<id>.jsonl`), not `<user>/chats`. Both subjects persist the
            // same message projection, so the comparator's parity guard is green in the baseline.
            groupTurnPersist: {
                ok: true,
                action: 'group-turn',
                expected: 'COMB_GROUP_TURN',
                saved: { ok: true },
                scopesRead: ['chats', 'group chats'],
                filesCarrying: ['group chats/Natural Two - T.jsonl'],
                persisted: [{
                    file: 'group chats/Natural Two - T.jsonl',
                    messageCount: 5,
                    messages: [
                        { name: 'Alice', is_user: false, mes: 'Alice raises the lantern and says: the orchard is this way.', swipes: ['Alice raises the lantern and says: the orchard is this way.'], swipe_id: 0, branches: null },
                        { name: 'Bob', is_user: false, mes: 'Bob checks the map and disagrees with everyone.', swipes: ['Bob checks the map and disagrees with everyone.'], swipe_id: 0, branches: null },
                        { name: 'Probe User', is_user: true, mes: 'COMB_GROUP_TURN', swipes: null, swipe_id: null, branches: null },
                        { name: 'Alice', is_user: false, mes: 'COMB_RAW_REPLY_17', swipes: ['COMB_RAW_REPLY_17'], swipe_id: 0, branches: null },
                        { name: 'Bob', is_user: false, mes: 'COMB_RAW_REPLY_19', swipes: ['COMB_RAW_REPLY_19'], swipe_id: 0, branches: null },
                    ],
                }],
            },
            // THE FULL GROUP FAN-OUT (dispatch 42226736120): the capture window closes after the first member, so the
            // probe waits for the product's own generating state to idle, then records EVERY group-sequence request
            // (post-capture members flagged). Both subjects must reach quiescence with the same sealed request count.
            groupFanOut: {
                quiesced: true,
                waitedMs: 9000,
                expectedReplies: 2,
                requestCount: 2,
                sealedRequests: 2,
                postCapture: 1,
                state: {
                    chatLength: 5,
                    lastIsUser: false,
                    repliesAfterUser: 2,
                    replyNames: ['Alice', 'Bob'],
                    quietForMs: 5100,
                    isSendPress: false,
                    streamingProcessor: false,
                    isGroupGenerating: false,
                    generatingFlag: null,
                },
            },
            groupTurn: {
                requests: 2,
                captured: 1,
                postCapture: 1,
                ok: true,
                requestsDetail: [
                    { case: 'turn-group', requestedStream: true, servedWire: 'sse', byteLength: 26484, sha256: 'synthetic-group-first', captured: true, postCapture: false },
                    { case: 'turn-group', requestedStream: true, servedWire: 'sse', byteLength: 26604, sha256: 'synthetic-group-second', captured: false, postCapture: true },
                ],
            },
            // The APPLIED-state evidence the probe records after the preset is selected (dispatch 42173399186 showed
            // selection without application; the leg record must carry both).
            presetApplied: {
                ok: true,
                problems: [],
                observed: {
                    selectedPreset: 'e03e04-profile',
                    activeCharacterId: 100001,
                    declaredPrompts: built.preset.prompts.length,
                    orderRowFound: true,
                    orderLength: built.preset.prompt_order[0].order.length,
                    collectionMarkers: [...expectedOrder.blocks.enabledRelative, ...expectedOrder.blocks.enabledAbsolute],
                },
            },
            // The EMBEDDED-book evidence: imported, listed, bound to the character, and saved through the product's own
            // editor-save follow-up (the dialog alone does not bind; dispatch 42173399186 root cause).
            embeddedBook: {
                ok: true,
                chid: '3',
                name: 'SYNTHETIC_CARD',
                bookName: built.books.cardEmbedded.name,
                via: ['editor-open dialog confirm (checkEmbeddedWorld -> product confirm OK)', 'character Save (#create_button click; the menu handler follow-up)'],
                dialog: { present: true, clicked: true },
                fallback: null,
                importState: { listed: true, domWorld: built.books.cardEmbedded.name },
                save: {
                    saved: true,
                    evidence: { populated: true, actiontype: 'editcharacter', formName: 'SYNTHETIC_CARD', formAvatar: 'synthetic.png', avatar: 'synthetic.png', name: 'SYNTHETIC_CARD', domWorld: built.books.cardEmbedded.name },
                    mechanism: 'createOrEditCharacter via #create_button click (saveCharacterDebounced target, script.js:471)',
                },
                verified: { ok: true, names: [built.books.cardEmbedded.name], bound: built.books.cardEmbedded.name, domWorld: built.books.cardEmbedded.name, name: built.books.cardEmbedded.name },
            },
        },
        disk: { projection: projectionFor(subject) },
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

// 11. THE DISPATCH-42173399186 DEFECT ITSELF: the preset was SELECTED but the live prompt manager kept the default 11
//     prompts (staged order row keyed for an id the manager does not match). The applied-state guard must go red even
//     though every body marker guard is green in the synthetic pair.
syntheticMutation(
    'A-PRESET-IS-SELECTED-BUT-NOT-APPLIED goes RED by e03e04-preset-applied',
    'e03e04-preset-applied',
    legs => {
        legs.pinned.browser.presetApplied = {
            ok: false,
            problems: ['no prompt_order row for the active character id 100001 (the dispatch-42173399186 failure: a row keyed for a different id is invisible, PromptManager.js:1207-1212)'],
            observed: {
                selectedPreset: 'e03e04-profile',
                activeCharacterId: 100001,
                declaredPrompts: 24,
                orderRowFound: false,
                orderLength: 0,
                collectionMarkers: [],
            },
        };
    },
);

// 12. THE STAGED-PRESET DIGEST IS CONFUSED WITH THE KIT DIGEST: the record must keep both apart (the probe stages a
//     document with the active order row added), or a reader cannot tell which document the page read.
syntheticMutation(
    'THE-STAGED-PRESET-DIGEST-IS-NOT-RECORDED goes RED by e03e04-preset-document-recorded',
    'e03e04-preset-document-recorded',
    legs => {
        legs.go.identity.digests.preset = legs.go.e03e04.record.preset.kitSha256;
    },
);

// 13. THE EMBEDDED BOOK IS IMPORTED (world listed) BUT NOT BOUND to the character. This is the HALF the dialog path
//     actually performs - dispatch 42173399186 showed a bound=="" leg while the other happened to be bound - so the
//     guard must demand the product's effective binding, not merely the dialog click.
syntheticMutation(
    'THE-EMBEDDED-BOOK-IS-NOT-BOUND goes RED by e03e04-embedded-book-imported',
    'e03e04-embedded-book-imported',
    legs => {
        legs.pinned.browser.embeddedBook.verified.bound = '';
        legs.pinned.browser.embeddedBook.ok = false;
    },
);

// 15. THE DECLARED-AFTER-SLOT MARKER VANISHES: the worldbook after-slot ordering guard must still be red when a
//     PRESENT after-slot marker is missing from the body (dispatch 42178757887's after guards were red only because
//     the manifest's own `absent` markers were counted as expected-present; the guard keeps its teeth for the real
//     present markers).
syntheticMutation(
    'A-PRESENT-AFTER-SLOT-MARKER-VANISHES goes RED by worldbook-order-cardEmbedded-after',
    'worldbook-order-cardEmbedded-after',
    legs => {
        const request = legs.pinned.requests.find(entry => entry.case === 'turn-1-armed');
        const parsed = JSON.parse(request.body);
        const marker = synthetic.expectedOrder.worldBooks.cardEmbedded.slots.after
            .find(entry => !synthetic.expectedOrder.absent.some(absent => absent.marker === entry));
        if (!marker) throw new Error('the synthetic fast-tier card book has no present after-slot marker');
        parsed.messages = parsed.messages.map(message => ({ ...message, content: String(message.content).split(marker).join('AFTER_SLOT_REMOVED') }));
        Object.assign(request, bodyFields(parsed));
    },
);

// 16. THE WORLD-INFO-OFF ARM LOSES THE PRESET MARKERS: the world-info-off arm is supposed to keep the preset applied,
//     so a body without them must be red by HARNESS-NON-DISCRIMINATING (the new clause), not silently accepted.
syntheticMutation(
    'THE-WI-OFF-ARM-LOSES-THE-PRESET goes RED by HARNESS-NON-DISCRIMINATING',
    'HARNESS-NON-DISCRIMINATING',
    legs => {
        const request = legs.pinned.requests.find(entry => entry.case === 'control-wi-off');
        for (const marker of synthetic.expectedOrder.blocks.enabledRelative) {
            request.body = String(request.body).split(marker).join('WI_OFF_PRESET_MARKER_REMOVED');
        }
    },
);

// 17. THE DURABLE CHAT DIFFERS: the projection guard must be red on a content difference (the sort change above must
//     not turn a real difference green).
syntheticMutation(
    'THE-DURABLE-CHAT-DIFFERS goes RED by journey-chat-projection-equal-modulo-declared-volatile',
    'journey-chat-projection-equal-modulo-declared-volatile',
    legs => {
        const file = Object.entries(legs.pinned.disk.projection).find(([name]) => name.includes('COMB_JOURNEY_CARD - T.jsonl'))?.[1];
        if (!file) throw new Error('the synthetic pinned projection has no main journey file');
        file.messages[3].mes = 'COMB_FINAL_TURN_WITH_A_DIFFERENCE';
    },
);

// 18. THE CAPTURE-MISMATCH DIAGNOSTIC: a body difference must produce a bounded, named diagnosis in
//     `captures.mismatches[].firstDifference` (path, char offset, capped excerpts, at most 3 differences). Dispatch
//     42178757887's 16-byte red was only readable by downloading and diffing 18 KB bodies by hand.
{
    const legs = clone(synthetic.legs);
    const request = legs.pinned.requests.find(entry => entry.case === 'turn-1-armed');
    const parsed = JSON.parse(request.body);
    parsed.messages[1].content = 'SYNTHETIC_MAIN_PROMPT_WITH_A_DIFFERENCE';
    Object.assign(request, bodyFields(parsed));
    const result = compareCombinationJourney({ goDrive: clone(legs.go), pinnedDrive: clone(legs.pinned), expectProfile: 'e03e04' });
    const mismatch = (result.captures.mismatches ?? []).find(entry => entry.case === 'turn-1-armed');
    const first = mismatch?.firstDifference ?? null;
    record('A-CAPTURE-MISMATCH-NAMES-THE-FIRST-DIFFERING-MEMBER', result.guards['nodeEqualsGo-per-capture'] === false
        && first?.path === '$.messages[1].content'
        && Number.isInteger(first?.firstDifferingCharOffset) && first.firstDifferingCharOffset >= 0
        && typeof first?.gotavernExcerpt === 'string' && first.gotavernExcerpt.length <= 200
        && typeof first?.pinnedExcerpt === 'string' && first.pinnedExcerpt.length <= 200
        && Array.isArray(first?.differences) && first.differences.length >= 1 && first.differences.length <= 3, {
        guard: result.guards['nodeEqualsGo-per-capture'],
        firstDifference: first,
    });
}

// 19. THE RESTART CAPTURE DIFFERS: `restart-capture-equality` is a per-subject pair guard, and its red must be red
//     when the restart legs' captures differ -- with the same bounded body diagnosis the drive captures carry.
{
    const legs = clone(synthetic.legs);
    const restartFor = subject => ({
        ...clone(legs[subject]),
        phase: 'restart',
        requests: clone(legs[subject].requests).map(entry => ({ ...clone(entry), case: entry.case === 'turn-1-armed' ? 'turn-after-restart' : `${entry.case}-restart` })),
    });
    const goRestart = restartFor('go');
    const pinnedRestart = restartFor('pinned');
    const baseline = compareCombinationJourney({ goDrive: clone(legs.go), pinnedDrive: clone(legs.pinned), goRestart: clone(goRestart), pinnedRestart: clone(pinnedRestart), expectProfile: 'e03e04' });
    const guardWasGreen = baseline.guards['restart-capture-equality'] === true;
    const mutatedPinnedRestart = restartFor('pinned');
    const target = mutatedPinnedRestart.requests.find(entry => entry.case === 'turn-after-restart');
    target.body = '{"messages":[{"role":"user","content":"MUTATED_RESTART"}]}';
    target.sha256 = sha256(target.body);
    target.byteLength = Buffer.byteLength(target.body, 'utf8');
    const mutated = compareCombinationJourney({ goDrive: clone(legs.go), pinnedDrive: clone(legs.pinned), goRestart: clone(goRestart), pinnedRestart: mutatedPinnedRestart, expectProfile: 'e03e04' });
    const difference = mutated.restart?.differences?.[0] ?? null;
    record('THE-RESTART-CAPTURE-DIFFERS goes RED by restart-capture-equality', guardWasGreen && mutated.guards['restart-capture-equality'] === false
        && difference?.case === 'turn-after-restart' && difference?.firstDifference?.path === '$.messages', {
        targetGuard: 'restart-capture-equality',
        baselineGuard: baseline.guards['restart-capture-equality'],
        mutatedGuard: mutated.guards['restart-capture-equality'],
        firstDifference: difference?.firstDifference ?? null,
    });
}

// 20. THE GROUP TURN IS NOT PERSISTED ON ONE SUBJECT: the parity guard must be red when a subject records
//     `filesCarrying: []` (the exact dispatch 42182251438 failure, before the reader was fixed).
syntheticMutation(
    'THE-GROUP-TURN-IS-NOT-PERSISTED goes RED by group-chat-persisted-parity',
    'group-chat-persisted-parity',
    legs => {
        legs.pinned.browser.groupTurnPersist = {
            ok: false,
            action: 'group-turn',
            expected: 'COMB_GROUP_TURN',
            saved: { ok: true },
            scopesRead: ['chats', 'group chats'],
            filesCarrying: [],
            persisted: [],
        };
    },
);

// 21. THE GROUP TURN IS PERSISTED, BUT READ FROM THE WRONG DIRECTORY: a group chat recorded under `chats/` (the
//     pre-fix reader scope) must be red -- the guard requires the group-chat directory, not merely a file carrying
//     the marker, or the reader-scope defect would pass as persisted.
syntheticMutation(
    'THE-GROUP-CHAT-IS-READ-FROM-THE-WRONG-DIRECTORY goes RED by group-chat-persisted-parity',
    'group-chat-persisted-parity',
    legs => {
        const persistRecord = legs.pinned.browser.groupTurnPersist;
        persistRecord.filesCarrying = ['chats/bob/Bob - T.jsonl'];
        persistRecord.persisted = persistRecord.persisted.map(entry => ({ ...entry, file: 'chats/bob/Bob - T.jsonl' }));
    },
);

// 22. THE GROUP FAN-OUT WAS NOT QUIESCED (dispatch 42226736120): the pinned leg read the group-chat file while the
//     second member was still generating, so the persisted projection had only Alice's reply while the other subject
//     had Alice's AND Bob's. The guard must be RED -- both through the missing projection and through the recorded
//     quiescence evidence -- so a lagging fan-out cannot pass as "the durable chats match".
syntheticMutation(
    'A-NON-QUIESCED-GROUP-FAN-OUT goes RED by group-chat-persisted-parity',
    'group-chat-persisted-parity',
    legs => {
        const fanOut = legs.pinned.browser.groupFanOut;
        legs.pinned.browser.groupFanOut = {
            ...fanOut,
            quiesced: false,
            waitedMs: 180000,
            state: { ...fanOut.state, repliesAfterUser: 1, replyNames: ['Alice'] },
        };
        legs.pinned.browser.groupTurn = {
            ...legs.pinned.browser.groupTurn,
            requests: 1,
            captured: 1,
            postCapture: 0,
            requestsDetail: legs.pinned.browser.groupTurn.requestsDetail.slice(0, 1),
        };
        const persistRecord = legs.pinned.browser.groupTurnPersist;
        persistRecord.persisted = persistRecord.persisted.map(entry => ({
            ...entry,
            messageCount: 4,
            messages: entry.messages.filter(message => !(message.name === 'Bob' && String(message.mes).includes('COMB_RAW_REPLY_19'))),
        }));
    },
);
// 23. THE OUTGOING PROMPT WAS REPLACED (dispatch 42186322374): an extension orchestrated the request, so no capture
//     carried the user marker. The guard must be red on that record instead of reading `requests:0` as "no traffic".
syntheticMutation(
    'THE-OUTGOING-PROMPT-WAS-REPLACED goes RED by outgoing-prompt-integrity',
    'outgoing-prompt-integrity',
    legs => {
        legs.pinned.browser.outgoingPromptIntegrity = {
            ok: false,
            reason: 'outgoing-prompt-replaced-by-extension',
            extension: 'narrative-agent',
            replacement: { sha256: 'a'.repeat(64), byteLength: 12353, bodyHead: '{"messages":[{"role":"system","content":"You are a relay.' },
        };
    },
);

// 24. THE ORCHESTRATING EXTENSION IS INSTALLED BUT WAS NOT OBSERVED/CONFIGURED (narrative-agent in the full tier): the
//     conditional guard must require the wire-observed takeover AND the product-path setting change on BOTH subjects.
//     Built directly because the synthetic fast-tier pair does not install the orchestrator.
{
    const takeoverRecord = {
        installed: true,
        detected: true,
        extension: 'narrative-agent',
        disabled: true,
        toggle: { clicked: true, before: true, after: false, configEnabled: false },
        enabledProbe: { called: { called: true }, arrived: true, relay: { sha256: 'b'.repeat(64), byteLength: 12353, bodyHead: '{"messages":[{"role":"system","content":"You are a relay.' }, intact: null, requests: [] },
        intactProbe: { called: { called: true }, arrived: true, intact: { sha256: 'c'.repeat(64), byteLength: 12353 }, requests: [] },
        sourceEvidence: 'third-party/narrative-agent bridge.js _onPromptReady',
        ok: true,
    };
    const withOrchestrator = () => {
        const legs = clone(synthetic.legs);
        for (const leg of [legs.go, legs.pinned]) {
            leg.extensions.installed.push({ name: 'narrative-agent', commit: 'd'.repeat(40), source: 'corpus-lock', directory: 'default-user/extensions/narrative-agent', wireEffect: { status: 'capability-relevant-unproven', evidence: 'synthetic selftest' } });
            leg.extensions.installedCount = leg.extensions.installed.length;
            leg.extensions.expected = leg.extensions.installed.length;
            leg.browser.extensionTakeover = clone(takeoverRecord);
        }
        return legs;
    };
    const baselineLegs = withOrchestrator();
    const baseline = compareCombinationJourney({ goDrive: clone(baselineLegs.go), pinnedDrive: clone(baselineLegs.pinned), expectProfile: 'e03e04' });
    const guardWasGreen = baseline.guards['extension-prompt-takeover-handled'] === true;
    const mutatedLegs = withOrchestrator();
    mutatedLegs.pinned.browser.extensionTakeover.ok = false;
    mutatedLegs.pinned.browser.extensionTakeover.disabled = false;
    mutatedLegs.pinned.browser.extensionTakeover.toggle = { clicked: false, reason: 'the extension settings control was not found' };
    mutatedLegs.pinned.browser.extensionTakeover.intactProbe = null;
    const mutated = compareCombinationJourney({ goDrive: clone(mutatedLegs.go), pinnedDrive: clone(mutatedLegs.pinned), expectProfile: 'e03e04' });
    record('AN-INSTALLED-ORCHESTRATOR-NOT-CONFIGURED goes RED by extension-prompt-takeover-handled',
        guardWasGreen && mutated.guards['extension-prompt-takeover-handled'] === false, {
        baselineGuard: baseline.guards['extension-prompt-takeover-handled'],
        mutatedGuard: mutated.guards['extension-prompt-takeover-handled'],
        takeoverBaseline: baseline.guards.outgoingPromptIntegrity === true ? 'outgoing-prompt-integrity also green' : 'outgoing-prompt-integrity was not green in this fixture',
    });
}

// 25. THE BLOCKING-OVERLAY DECISION (dispatch 42193009501). The probe's browser side only inventories the overlay and
//     its controls; the kit's `chooseOverlayDismissal` decides which element is the extension's OWN dismiss affordance.
//     These are the same bytes the probe executes, so the selftest demonstrates both halves:
//     (a) an overlay with a close control is dismissed (and the close control, not the navigation link, is chosen);
//     (b) an overlay with NO dismiss affordance fails BY NAME (id/class/text + the buttons found) and is not clicked.
{
    const blockingOverlay = (buttons, text = "What's New in ST-Copilot Version 2.9.0") => ({
        sendButton: { id: 'send_but', visible: true, disabled: false, pointerEvents: 'auto' },
        sendCenter: { x: 640, y: 700 },
        hit: { tag: 'div', id: 'scp-changelog-modal', className: 'scp-modal-overlay', text },
        hitIsSend: false,
        overlays: [{
            index: 0,
            tag: 'div',
            id: 'scp-changelog-modal',
            className: 'scp-modal-overlay',
            text,
            blocksSend: true,
            extensionHints: ['ST-Copilot'],
            buttons,
        }],
    });
    const dismissable = chooseOverlayDismissal(blockingOverlay([
        { index: 0, tag: 'a', id: null, className: 'scp-link', text: 'Release notes', role: null, ariaLabel: null, title: null, disabled: false, href: 'https://example.invalid/changelog' },
        { index: 1, tag: 'button', id: 'scp-changelog-close', className: 'scp-hbtn scp-hbtn-close', text: '', role: null, ariaLabel: null, title: null, disabled: false, href: null },
        { index: 2, tag: 'button', id: 'scp-settings-btn', className: 'scp-hbtn', text: 'Settings', role: null, ariaLabel: null, title: null, disabled: false, href: null },
    ]));
    record('AN-OVERLAY-WITH-A-CLOSE-CONTROL-IS-DISMISSED-BY-ITS-OWN-BUTTON', dismissable.ok === true
        && dismissable.buttonIndex === 1 && dismissable.button.id === 'scp-changelog-close'
        && dismissable.overlay.id === 'scp-changelog-modal' && dismissable.overlay.extensionHints.includes('ST-Copilot'),
        dismissable);
    const undismissableInventory = blockingOverlay([
        { index: 0, tag: 'a', id: null, className: 'scp-link', text: 'Release notes', role: null, ariaLabel: null, title: null, disabled: false, href: 'https://example.invalid/changelog' },
        { index: 1, tag: 'button', id: 'scp-settings-btn', className: 'scp-hbtn', text: 'Settings', role: null, ariaLabel: null, title: null, disabled: false, href: null },
    ], 'ST-Copilot blocked the page with no way out');
    const refused = chooseOverlayDismissal(undismissableInventory);
    record('AN-OVERLAY-WITHOUT-A-DISMISS-AFFORDANCE-IS-NAMED-NOT-CLICKED', refused.ok === false
        && refused.undismissable === true
        && refused.overlay?.id === 'scp-changelog-modal'
        && String(refused.reason).includes('no dismissal affordance')
        && Array.isArray(refused.overlay?.buttons) && refused.overlay.buttons.length === 2,
        refused);
    // The comparator side: a leg that RECORDED an undismissable overlay must be red by name (and must not pass as
    // "no overlay present"); a leg that dismissed it is green. Same record shape the probe writes.
    const withOverlayRecord = overlay => {
        const legs = clone(synthetic.legs);
        for (const leg of [legs.go, legs.pinned]) leg.browser.overlayHandling = clone(overlay);
        return legs;
    };
    const dismissedRecord = {
        ok: true,
        dismissals: [{
            case: 'pre-turn-1',
            overlay: { id: 'scp-changelog-modal', className: 'scp-modal-overlay', text: "What's New in ST-Copilot", extensionHints: ['ST-Copilot'] },
            button: { id: 'scp-changelog-close', className: 'scp-hbtn scp-hbtn-close', text: '' },
            clicked: { clicked: true },
            hitIsSendAfter: true,
        }],
        undismissable: [],
        observations: [{ case: 'pre-turn-1', acted: true, ok: true }],
    };
    const overlayBaselineLegs = withOverlayRecord(dismissedRecord);
    const overlayBaseline = compareCombinationJourney({ goDrive: overlayBaselineLegs.go, pinnedDrive: overlayBaselineLegs.pinned, expectProfile: 'e03e04' });
    const overlayGuardWasGreen = overlayBaseline.guards['send-blocking-overlays-handled'] === true;
    const undismissableLegs = withOverlayRecord(dismissedRecord);
    undismissableLegs.pinned.browser.overlayHandling = {
        ok: false,
        dismissals: [],
        undismissable: [{ case: 'pre-turn-1', reason: 'the blocking overlay has no dismissal affordance a user could press', plan: refused }],
        observations: [{ case: 'pre-turn-1', acted: false, ok: false }],
    };
    const overlayMutated = compareCombinationJourney({ goDrive: clone(undismissableLegs.go), pinnedDrive: clone(undismissableLegs.pinned), expectProfile: 'e03e04' });
    record('AN-UNDISMISSABLE-OVERLAY-RECORD goes RED by send-blocking-overlays-handled', overlayGuardWasGreen
        && overlayMutated.guards['send-blocking-overlays-handled'] === false, {
        baselineGuard: overlayBaseline.guards['send-blocking-overlays-handled'],
        mutatedGuard: overlayMutated.guards['send-blocking-overlays-handled'],
    });

    // ---- THE TWO-OVERLAY SEQUENCE (dispatch 42198916430): the SECOND layer is a class-less popup that only the hit
    //      test discovers (`#rpg-deprecation-modal` class "rpg-settings-popup is-open": no modal/overlay/dialog token).
    //      The loop below is the probe's own rule expressed over pure snapshots: classify from the hit chain, choose
    //      that layer's own control, "dismiss", re-read the next snapshot, repeat -- so a passing case means both
    //      layers were dismissed in sequence through their own controls.
    const layerSnapshot = (hitLayer, { hitIsSend = false } = {}) => ({
        hitIsSend,
        sendCenter: { x: 640, y: 700 },
        hit: { tag: 'div', id: hitLayer.id ?? null, className: hitLayer.className ?? '', text: hitLayer.text ?? '' },
        hitChain: [hitLayer],
        overlays: [],
    });
    const scpLayer = {
        index: 0, tag: 'div', id: 'scp-changelog-modal', className: 'scp-modal-overlay', role: null,
        text: "What's New in ST-Copilot Version 2.9.0", blocksSend: true, position: 'fixed', pointerEvents: 'auto', zIndex: '2147483040',
        buttons: [{ index: 0, tag: 'button', id: 'scp-changelog-close', className: 'scp-hbtn scp-hbtn-close', text: '', ariaLabel: null, title: null, disabled: false, href: null }],
    };
    const rpgLayer = {
        index: 0, tag: 'div', id: 'rpg-deprecation-modal', className: 'rpg-settings-popup is-open', role: null,
        text: 'RPG Companion becomes deprecated! Thank you all for the continuous support.', blocksSend: true, position: 'fixed', pointerEvents: 'auto', zIndex: '10000',
        buttons: [
            { index: 0, tag: 'a', id: null, className: 'menu_button interactable', text: 'MarinaraEngine', ariaLabel: null, title: null, disabled: false, href: 'https://github.com/Pasta-Devs/Marinara-Engine' },
            { index: 1, tag: 'button', id: 'rpg-deprecation-close', className: 'rpg-popup-close', text: '', ariaLabel: 'Close Deprecation Notice', title: null, disabled: false, href: null },
            { index: 2, tag: 'button', id: 'rpg-deprecation-got-it', className: 'rpg-btn-primary', text: 'Got it!', ariaLabel: null, title: null, disabled: false, href: null },
        ],
    };
    const twoOverlaySequence = [layerSnapshot(scpLayer), layerSnapshot(rpgLayer), layerSnapshot(rpgLayer, { hitIsSend: true })];
    const sequenceDismissals = [];
    for (const snapshot of twoOverlaySequence) {
        const classified = classifyBlockingOverlays(snapshot);
        const plan = chooseOverlayDismissal(snapshot);
        if (snapshot.hitIsSend === true) { sequenceDismissals.push({ done: true, hitIsSend: true }); continue; }
        sequenceDismissals.push({
            overlayId: plan.overlay?.id ?? null,
            buttonId: plan.button?.id ?? null,
            discoveredBy: plan.overlay?.discoveredBy ?? null,
            classification: plan.overlay?.classification ?? null,
            candidates: classified.candidates.map(candidate => ({ id: candidate.id, discoveredBy: candidate.discoveredBy, blocking: candidate.blocking })),
            ok: plan.ok === true,
        });
    }
    record('TWO-OVERLAYS-ARE-DISMISSED-IN-SEQUENCE-BY-HIT-TEST', sequenceDismissals.length === 3
        && sequenceDismissals[0].ok === true && sequenceDismissals[0].overlayId === 'scp-changelog-modal' && sequenceDismissals[0].buttonId === 'scp-changelog-close'
        && sequenceDismissals[1].ok === true && sequenceDismissals[1].overlayId === 'rpg-deprecation-modal' && sequenceDismissals[1].buttonId === 'rpg-deprecation-close'
        && sequenceDismissals[1].discoveredBy === 'hit-test-element'
        && sequenceDismissals[1].candidates[0]?.id === 'rpg-deprecation-modal'
        && sequenceDismissals[1].candidates[0]?.blocking === true
        && sequenceDismissals[2].hitIsSend === true, sequenceDismissals);
    // The same class-less layer with NO dismissal affordance (only a navigation link and a disabled control) must be
    // named and left alone -- a second overlay cannot be "clicked randomly" to get past it.
    const rpgNoAffordance = {
        ...rpgLayer,
        buttons: [
            { index: 0, tag: 'a', id: null, className: 'menu_button interactable', text: 'MarinaraEngine', ariaLabel: null, title: null, disabled: false, href: 'https://github.com/Pasta-Devs/Marinara-Engine' },
            { index: 1, tag: 'button', id: 'rpg-disabled-ok', className: 'rpg-btn-primary', text: 'Continue', ariaLabel: null, title: null, disabled: true, href: null },
        ],
    };
    const rpgRefused = chooseOverlayDismissal(layerSnapshot(rpgNoAffordance));
    record('A-SECOND-OVERLAY-WITHOUT-A-CLOSE-CONTROL-IS-NAMED', rpgRefused.ok === false
        && rpgRefused.undismissable === true
        && rpgRefused.overlay?.id === 'rpg-deprecation-modal'
        && /rpg-settings-popup/.test(String(rpgRefused.overlay?.className ?? ''))
        && String(rpgRefused.reason).includes('no dismissal affordance')
        && Array.isArray(rpgRefused.overlay?.buttons) && rpgRefused.overlay.buttons.length === 2, rpgRefused);
}

// 26. STREAMING-ARMING AND LEG COMPLETION (dispatch 42203249658). A profile turn that reached the provider without
//     `stream:true` and a leg that stopped before its phase landmarks must each be RED BY NAME. The comparator's
//     `turn-1-streaming-requested` is the wire guard the probe already reports; `legs-are-complete` is the new
//     completion guard fed by `report.completion` + `leg-completed-all-expected-phases`.
{
    const baseline = judge(synthetic.legs);
    const streamingBaselineGreen = baseline.guards['turn-1-streaming-requested'] === true && baseline.guards['streaming-setting-armed-before-turn-1'] === true;
    // (a) A TURN SENT NON-STREAMING in profile mode: the request asked for JSON and the step says so. The fast tier's
    //     request is untouched, so the mutation is pinned-only -- the same asymmetry a real product difference shows.
    const nonStreamingLegs = clone(synthetic.legs);
    nonStreamingLegs.pinned.requests = clone(nonStreamingLegs.pinned.requests).map((entry, index) => index === 0 ? { ...entry, requestedStream: false, served: { wire: 'json', frames: 0, bytes: 267, terminal: true } } : entry);
    nonStreamingLegs.pinned.steps = clone(nonStreamingLegs.pinned.steps).map(entry => entry.name === 'turn-1-streaming-requested'
        ? { ...entry, ok: false, detail: { requestedStream: false, served: 'json' } }
        : entry);
    const nonStreaming = compareCombinationJourney({ goDrive: clone(nonStreamingLegs.go), pinnedDrive: clone(nonStreamingLegs.pinned), expectProfile: 'e03e04' });
    record('A-TURN-SENT-NON-STREAMING-GOES-RED-BY-turn-1-streaming-requested', streamingBaselineGreen
        && nonStreaming.guards['turn-1-streaming-requested'] === false, {
        baselineGuard: baseline.guards['turn-1-streaming-requested'],
        mutatedGuard: nonStreaming.guards['turn-1-streaming-requested'],
        served: nonStreaming.guards['all-captures-were-streamed'],
    });
    // (b) A PARTIAL LEG: the pinned report stopped at 50 of 85 steps; its completion record names the missing
    //     landmarks and the navigation failure. The guard must be RED and must not be read as an ordinary short leg.
    const partialLegs = clone(synthetic.legs);
    partialLegs.pinned.completion = {
        phase: 'drive',
        ok: false,
        landmarks: ['turn-1-request-captured', 'streaming-setting-armed-before-turn-1', 'journey-chat-written', 'e03e04-ordered-message-ids-recorded'],
        missing: ['journey-chat-written', 'e03e04-ordered-message-ids-recorded'],
        steps: 50,
        failure: 'page.evaluate: Execution context was destroyed, most likely because of a navigation.',
    };
    const partial = compareCombinationJourney({ goDrive: clone(partialLegs.go), pinnedDrive: clone(partialLegs.pinned), expectProfile: 'e03e04' });
    record('A-PARTIAL-LEG-GOES-RED-BY-legs-are-complete', baseline.guards['legs-are-complete'] === true
        && partial.guards['legs-are-complete'] === false, {
        baselineGuard: baseline.guards['legs-are-complete'],
        mutatedGuard: partial.guards['legs-are-complete'],
    });
    // (c) THE INTERCEPTION CASE (dispatch 42207738114): an extension starts a QUIET generation on the send, the quiet
    //     request carries the user marker and is the ONLY request in the window, and the turn must be NAMED as
    //     intercepted rather than attributed to that quiet body. The synthetic pinned leg gets a quiet generation in
    //     the trail and a non-streaming attributed request; the GO leg keeps the normal streaming attribution. The
    //     parity guard is GREEN on the baseline and RED here, and the same record proves the wire guard is red too
    //     (mirrors the real full-tier failure where the quiet body was the 27424-byte "normal" capture).
    const interceptionLegs = clone(synthetic.legs);
    interceptionLegs.pinned.requests = clone(interceptionLegs.pinned.requests).map((entry, index) => index === 0
        ? { ...entry, requestedStream: false, served: { wire: 'json', frames: 0, bytes: 267, terminal: true } }
        : entry);
    interceptionLegs.pinned.steps = clone(interceptionLegs.pinned.steps).map(entry => entry.name === 'turn-1-streaming-requested'
        ? { ...entry, ok: false, detail: { requestedStream: false, served: 'json' } }
        : entry);
    interceptionLegs.pinned.browser.generationTrail = {
        cases: [{
            case: 'turn-1-armed',
            window: { reset: true },
            events: [
                { kind: 'generation-started', type: 'normal' },
                { kind: 'generation-started', type: 'quiet', quietPromptPreview: 'SYNTHETIC_THINKING_PROMPT' },
                { kind: 'completion-settings-ready', type: 'quiet', stream: false, messages: 96 },
            ],
            windowRequests: [{ requestedStream: false, servedWire: 'json', byteLength: 27424, sha256: 'synthetic-quiet' }],
            attributed: [{ requestedStream: false, servedWire: 'json', sha256: 'synthetic-quiet', byteLength: 27424 }],
            extensionGenerations: [{ requestedStream: false, servedWire: 'json', byteLength: 27424, sha256: 'synthetic-quiet' }],
            quietBeforeAttributed: ['quiet', 'quiet'],
            normalGenerationWait: { waitedMs: 150000, found: 0 },
            assistant: { ok: false },
            reason: 'no-normal-generation-after-extension-quiet-generation',
        }],
    };
    const interception = compareCombinationJourney({ goDrive: clone(interceptionLegs.go), pinnedDrive: clone(interceptionLegs.pinned), expectProfile: 'e03e04' });
    record('AN-EXTENSION-QUIET-GENERATION-ON-SEND-IS-NAMED-NOT-ATTRIBUTED', baseline.guards['extension-quiet-generation-parity'] === true
        && interception.guards['extension-quiet-generation-parity'] === false
        && interception.guards['turn-1-streaming-requested'] === false, {
        baselineGuard: baseline.guards['extension-quiet-generation-parity'],
        mutatedGuard: interception.guards['extension-quiet-generation-parity'],
        wireGuard: interception.guards['turn-1-streaming-requested'],
        quietGeneration: interceptionLegs.pinned.browser.generationTrail.cases[0].extensionGenerations,
    });
    // (d) THE SEND-INTERCEPTING EXTENSION MUST BE HANDLED ON BOTH SUBJECTS: a leg that recorded the extension as
    //     installed but NOT disabled (its own settings still enabled) goes red by name, so "the quiet generation
    //     happened but nobody recorded the decision" cannot pass as a product finding.
    const extensionLegs = clone(synthetic.legs);
    extensionLegs.pinned.browser.quietGenerationExtension = {
        installed: true,
        handled: false,
        extension: 'st-stepped-thinking',
        decision: null,
        before: { settingsEnabled: true },
        disabled: { ok: false, reason: 'the extension own enable control did not persist is_enabled=false' },
        after: { settingsEnabled: true },
        sourceEvidence: ['installed thinking/engine.js:56 eventSource.on(GENERATION_AFTER_COMMANDS, runChatThinking)'],
        reason: 'the extension own enable control did not persist is_enabled=false',
    };
    const extensionUnhandled = compareCombinationJourney({ goDrive: clone(extensionLegs.go), pinnedDrive: clone(extensionLegs.pinned), expectProfile: 'e03e04' });
    record('AN-UNHANDLED-QUIET-GENERATION-EXTENSION-GOES-RED-BY-quiet-generation-extension-handled', baseline.guards['quiet-generation-extension-handled'] === true
        && extensionUnhandled.guards['quiet-generation-extension-handled'] === false, {
        baselineGuard: baseline.guards['quiet-generation-extension-handled'],
        mutatedGuard: extensionUnhandled.guards['quiet-generation-extension-handled'],
        record: extensionLegs.pinned.browser.quietGenerationExtension,
    });
}

// 27. THE ARTIFACT VERIFIER: a good identity verifies; a wrong head SHA, a wrong pinned SHA, a missing field and a
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

// 14b. THE PURE-NODE CHECK OF THE DISPATCH-42173399186 PRESET DEFECT. The staged-preset transformation/assertion lives
//      in the journey kit so it can be run without a browser: a KIT-ONLY document (row keyed 100000) is REFUSED, the
//      staged form carries the live 100001 row with one order entry per declared prompt, and it is byte-deterministic.
function stagedPresetShapeCases() {
    const built = buildProfile({ seed: PROFILE_SEED, blockCount: TIERS[PROFILE_TIER], tier: PROFILE_TIER });
    const kitOnly = validateStagedPreset(built.preset);
    record('THE-KIT-ONLY-PRESET-IS-REFUSED-BY-THE-ACTIVE-ROW-ASSERTION', kitOnly.ok === false
        && kitOnly.problems.length > 0, kitOnly);
    const staged = stagedPresetDocument(built.preset);
    const shape = validateStagedPreset(staged);
    record('THE-STAGED-PRESET-CARRIES-THE-LIVE-ACTIVE-ROW', shape.ok === true
        && Number(shape.activeCharacterId) === Number(KIT_GLOBAL_PROMPT_ORDER_DUMMY_ID)
        && shape.promptOrderCharacterIds.includes(String(KIT_GLOBAL_PROMPT_ORDER_DUMMY_ID))
        && shape.activeOrderLength === shape.declaredPrompts
        && shape.activeOrderLength === built.preset.prompts.length, shape);
    record('THE-STAGED-PRESET-IS-DETERMINISTIC', canonicalJson(stagedPresetDocument(built.preset)) === canonicalJson(staged), null);
}

stagedPresetShapeCases();

// The baseline itself must be green for the target guards, or every planted red above would be vacuous. The legacy
// guards are allowed to be red here: the synthetic pair is not a full journey, and each planted case only claims its
// OWN target guard was green first (the per-guard precondition below is the same discipline the live suite uses).
const syntheticBaseline = judge(synthetic.legs);
const requiredGreen = [
    'outgoing-prompt-integrity',
    'send-blocking-overlays-handled',
    'turn-1-streaming-requested',
    'streaming-setting-armed-before-turn-1',
    'legs-are-complete',
    'extension-quiet-generation-parity',
    'quiet-generation-extension-handled',
    'e03e04-profile-recorded',
    'e03e04-profile-identical',
    'e03e04-extensions-installed',
    'e03e04-preset-document-recorded',
    'e03e04-preset-applied',
    'e03e04-embedded-book-imported',
    'preset-block-order',
    'worldbook-order-recursiveGlobal-before',
    'worldbook-order-cardEmbedded-after',
    'worldbook-order-recursiveGlobal-after',
    'both-subjects-wrote-a-journey-chat',
    'journey-chat-projection-equal-modulo-declared-volatile',
    'group-chat-persisted-parity',
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
