// WHOLE-SESSION — ONE USER, ONE SERVER, ONE TREE, ONE CONTINUOUS SESSION LINEAGE.
//
// THE QUESTION, in one sentence: if a real user boots a stock SillyTavern tree, loads the page, reads settings,
// changes one, lists characters, opens a card, sends a message and gets a STREAMED reply, swipes that reply, saves,
// reloads the page, takes a second turn, regenerates, continues, then RESTARTS the server on the same tree and keeps
// working — does every fact a user or a user's model could observe match pinned Node SillyTavern's?
//
// WHY THIS FILE EXISTS AND THE EIGHT EXISTING PROBES ARE NOT ENOUGH. `docs/compatibility-matrix.json`'s
// `whole-session-e2e` row is the only FAIL, and its own `session` section states the reason precisely: every step of
// the journey has a probe, no probe shares a runtime with another, so there is no SESSION. A chat saved in one tree
// and reloaded in one tree is gated nowhere, and a comparison of "two subjects driven the same way" is vacuous when
// the fixture cannot tell them apart. Eight experiments answer eight questions about eight processes; this answers
// one question about one process.
//
// WHAT "THE SAME SESSION" MEANS HERE, stated so it can be falsified:
//   * phase `drive`   boots ONE server over ONE data root and performs the whole journey in ONE browsing context.
//     Every step after the first reads state the previous step (or the reload of it) left behind. The page is
//     reloaded once, deliberately: that is the step a user performs by closing and opening the tab.
//   * phase `restart` is a SECOND, SEPARATE INVOCATION over the SAME data root — a NEW server process, a NEW browser
//     and a NEW page — which must read back what the drive phase wrote. This is the established shape in this harness
//     (`helper-vars-probe.mjs --restart`, judged by `compare-helper-vars-generate-legs.mjs`), used instead of killing
//     a process mid-probe because the pinned subject is booted by `run-against-pinned.mjs`, which OWNS that process:
//     a probe that "restarted" a server it did not spawn would be recording a claim it cannot observe. That the two
//     runs used different pids is the comparator's `restart-is-a-new-process` guard.
//
// THE THREE FACT CLASSES THE COMPARATOR COMPARES, and why all three are needed (AGENTS.md rule 7):
//   1. BROWSER OBSERVABLE — readiness, the roster, the opened card, the chat id, the role+text sequence the page
//      holds at four moments (after the first turn, after the reload, after the verbs, after the restart), the
//      swipe/regenerate/continue state, and the setting the user changed.
//   2. PROVIDER WIRE — every completion request the recording peer received, in order: method, raw target, byte
//      length, sha256 and the raw body. Byte-oriented (differential doctrine 2): no canonicalising, no re-marshalling,
//      no dropping "irrelevant" members.
//   3. DISK STATE — the chat file the PRODUCT wrote (its name, its message count and per-message semantic fields), the
//      settings file the user's change landed in, and the growth the resumed turn causes after the restart.
//      Comparing only the browser would miss a chat that renders and never persists; only the wire would miss a
//      persisted file the reload reads wrongly; only disk would miss a page showing the wrong conversation.
//
// THE PER-SUBJECT DISCRIMINATOR (rule 50; the technique `q20-persistence-probe.mjs` documents). Both subjects are fed
// byte-identical user turns, so if both were also fed byte-identical replies the comparator could not show that its
// own fixture is able to tell the subjects apart. `--reply-prefix` (`WSG_` for GoTavern, `WSP_` for pinned) is
// stamped into ONE reply, and WHICH one is derived rather than chosen:
//   * it must be a reply the subject was really FED, so the difference is real;
//   * it must not be carried by any COMPARED provider request, so those stay byte-comparable;
//   * it must still exist at the END of the journey, or there is nothing for the comparator to require a difference in.
// The FIRST turn's reply satisfies all three only in the right order: it is rendered, then SWIPED AWAY (the swipe pops
// the message being swiped, `public/script.js:4497-4499`, and :4834 builds the message array from that same popped
// array) — so the swipe's own request and every later request carry the fresh, UNPREFIXED replacement — while the
// prefixed text remains on disk inside that message's `swipes[]` array, which nothing after the swipe deletes.
// Stamping the SECOND turn's reply instead, as the Q20 lane does, would not survive this journey: regenerate DELETES
// the last assistant message (:4399-4406), so the only copy of the discriminator would be destroyed before the restart.
//
// WHAT THIS DOES NOT PROVE, repeated in the artefact so the matrix row can quote it: a real provider (rule 22), group
// chats, branches/checkpoints, multi-user, or a real user's data. The provider is a recording peer answering with
// markers; the tree is a fresh install the server seeds itself.
//
// THE COMPLEX-PRESET ARM AND THE RESUME ATTRIBUTION (Beta 1, the OPEN item). The journey can be run three ways:
//   * no `--preset`: the fresh-install tree, whose live prompt order is still observed and classified;
//   * `--preset <committed derivation>`: the same journey with the committed derived complex preset selected through
//     the frontend's own control, so the RESTART leg reads that preset (and its prompt order) back from the tree the
//     drive leg wrote;
//   * `--preset ... --preset-chat-history omit`: a structural CONTROL derived from the same committed bytes with the
//     runtime row's `chatHistory.enabled` set false -- the one branch in which a history-free request is CORRECT.
// The resumed turn's request is selected BY THE PEER ORDINAL ARMED IMMEDIATELY BEFORE THE CLICK, never by
// `completions().at(-1)`; `--helper-request-after-send` injects the one-system-message quiet completion that the old
// selection would have captured, so the failure mechanism is reproducible and is shown not to be attributable to the
// send. See docs/persistence-resume.md.
//
// WHERE THIS RUNS: GitHub Actions only. This surface drives a real browser, which is forbidden on the operator's
// Windows host; a local attempt also opened the operator's DEFAULT BROWSER because the GoTavern leg was booted without
// `--browserLaunchEnabled false` (now fixed in q20-leg-runtime.mjs, whose comment records the measurement).

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { argumentValue, bootSubject, freePort, startCapturePeer, waitForServer } from './q20-leg-runtime.mjs';
import {
    chatCarrying, configureConnection, openCharacter as driveOpenCharacter, openPage as driveOpenPage,
    pressContinue, pressRegenerate, readChatFiles as driveReadChatFiles, readReadiness, resolveRoster,
    saveConditional, sendTurn, settleQuiet, waitForReply,
} from './q20-persistence-drive.mjs';
import { attachUrlRecorder } from './url-recorder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

// ---------------------------------------------------------------------------------------------------------------
// THE JOURNEY'S INPUTS.
// ---------------------------------------------------------------------------------------------------------------

const dataRootArgument = argumentValue(process.argv, '--data-root', null);
if (!dataRootArgument) {
    console.error('whole-session-probe.mjs: --data-root is required (one tree, shared by the drive and restart phases)');
    process.exit(2);
}
const dataRoot = path.resolve(dataRootArgument);
await fs.mkdir(dataRoot, { recursive: true });
const phase = argumentValue(process.argv, '--phase', 'drive');
if (!['drive', 'restart'].includes(phase)) {
    console.error(`whole-session-probe.mjs: --phase must be drive or restart, not ${JSON.stringify(phase)}`);
    process.exit(2);
}
const reportPath = path.resolve(argumentValue(process.argv, '--report', path.join(here, `whole-session-${phase}-report.json`)));
// WHICH SUBJECT THIS LEG IS, decided by HOW it was started rather than by an argument that could disagree with the
// facts: `run-against-pinned.mjs` sets PROBE_BASE_URL, so an external base URL IS the pinned subject.
const external = Boolean(process.env.PROBE_BASE_URL);
const subject = external ? 'pinned' : 'gotavern';
const replyPrefix = argumentValue(process.argv, '--reply-prefix', process.env.WS_REPLY_PREFIX ?? '');

// THE USER'S OWN WORDS. Identical on both subjects on purpose: these strings ARE carried by the compared provider
// requests, so a difference here would be a difference the harness made.
const MARKERS = { turn1: 'WS_TURN_ONE_MARKER', turn2: 'WS_TURN_TWO_MARKER', resumed: 'WS_RESUMED_TURN_MARKER' };
// THE SETTING THE USER CHANGES, and its value. Temperature is used because it is something a user really changes, it
// reaches the provider body (so the change is observable on the wire as well as on disk), and it is not a string, so
// it cannot be confused with the prompt markers.
const TEMPERATURE = 0.42;
// THE MINIMUM A REAL JOURNEY PRODUCES: turn one, the swipe, turn two, regenerate, continue. Asserted absolutely, not
// by comparing two legs, because a comparison cannot see a journey that performed fewer verbs on BOTH sides.
const MINIMUM_COMPLETIONS = 5;

const replyPattern = /WS_REPLY_\d+/;
// The discriminator's own text, replaced by a marker wherever a compared field may carry it. A FIELD-PATH
// normalisation with its reason written down (differential doctrine 2), never a regex over a whole document.
const stripPrefix = value => (replyPrefix === ''
    ? String(value ?? '')
    : String(value ?? '').split(replyPrefix).join('<REPLY_PREFIX>'));

// THE DISCRIMINATOR'S ARM. The ordinal is set from the PEER'S OWN count immediately before the send that will consume
// it, so a counter that runs ahead cannot stamp the wrong reply (the failure q20-leg-runtime.mjs:143-147 records).
//
// THE REPLIES ARE PADDED SO THEY DIFFER IN LENGTH, and that is a fixture requirement rather than decoration. The shared
// `waitForReply` decides "the product's state MOVED" from the chat length or the TAIL TEXT LENGTH -- deliberately, see
// its own header -- and regenerate replaces one reply with another of the same nominal length. An unpadded fixture is
// therefore indistinguishable from "nothing happened" after a regenerate: measured in run 41014576819, where BOTH
// subjects sat for the full 90 s in `setup-reply-did-not-arrive` while the product had regenerated correctly (the peer
// recorded request 4 and the page showed the new reply `WS_REPLY_4`). One `#` per ordinal makes the tail length a
// function of the reply, so a replaced reply is visibly replaced.
let stampOrdinal = null;
// WHAT THE SUBJECT'S TOKENIZER ROUTES SAID ABOUT THEMSELVES, collected from the page's own responses by the handler
// installed below and judged by the `subject-tokenizes-exactly` step. Module scope because the handler is installed in
// the leg's outer block while the step lives in `drivePhase`.
const tokenizerResponses = [];
const replyText = ordinal => `${stampOrdinal !== null && ordinal === stampOrdinal ? replyPrefix : ''}WS_REPLY_${ordinal}${'#'.repeat(ordinal)}`;

// =================================================================================================================
// THE COMPLEX-PRESET ARM (HANDOFF "accepted risks and open items" #1), AND THE DERIVED CONTROL THAT OMITS chatHistory.
// =================================================================================================================
//
// THE QUESTION THIS ARM EXISTS TO ANSWER. The post-restart resumed turn's provider request was once recorded as a
// single-system-message request that carried none of the restored history. The leading hypothesis was that the user's
// complex preset structures its runtime prompt order without an enabled `chatHistory` row, in which case a history-free
// request is CORRECT on both subjects -- and the assertion that demanded history was, in that configuration, wrong. The
// committed derivation of that preset (`tests/browser/fixtures/real/preset-a.json`, 105 prompts / 109 order rows) is
// what this arm selects; its structure is the oracle's own, and only a fixture that reproduces the structure can answer
// the question (AGENTS rule 56: the user's file never enters this repository, the derivation does).
//
// TWO ARMS, ONE LOADER. `--preset <fixture>` plants the committed derivation into the tree and selects it through the
// frontend's own preset control, exactly as `real-preset-probe.mjs` does (plant before the page loads; select; await
// `getPresetApplicationPromise`; set the connection AFTER it, because `OAI_PRESET_CHANGED_BEFORE` can overwrite the
// source -- capture-settings.mjs:8-13). `--preset-chat-history omit` derives a CONTROL from the SAME committed bytes by
// setting the runtime row's `chatHistory.enabled` to false -- the one thing a user can toggle in the prompt manager
// (`isPromptToggleAllowed` includes chatHistory, PromptManager.js:1099-1112). The derivation is recorded field by field
// in the artefact (source digest, the rewritten path, the before/after value) and the file is generated at run time,
// never committed: it is a structural control, not a user's preset.
//
// WHICH ROW IS "THE RUNTIME ROW" IS PINNED'S OWN CONFIGURATION, NOT A GUESS. `setupChatCompletionPromptManager` passes
// `promptOrder: { strategy: 'global', dummyId: 100001 }` (public/scripts/openai.js:696-699), and the global strategy
// makes the active character `{ id: dummyId }` (PromptManager.js:438, :1131-1132), so the order the frontend uses for
// every generation is the row whose `character_id` is 100001 -- NOT the 100000 row some presets also carry. The counts
// are read back from the live page rather than derived here, and the classification is computed from that observation
// by the same rule the comparator applies to the artefact.
const PRESET_RUNTIME_CHARACTER_ID = 100001;
const HELPER_MARKER = 'WS_HELPER_SINGLE_SYSTEM';
const presetArgument = argumentValue(process.argv, '--preset', null);
const presetNameArgument = argumentValue(process.argv, '--preset-name', null);
const presetChatHistoryMode = argumentValue(process.argv, '--preset-chat-history', 'keep');
if (!['keep', 'omit'].includes(presetChatHistoryMode)) {
    console.error(`whole-session-probe.mjs: --preset-chat-history must be keep or omit, not ${JSON.stringify(presetChatHistoryMode)}`);
    process.exit(2);
}
// THE EXTRA REQUEST THAT REPRODUCES THE RECORDED FAILURE MECHANISM. When enabled, the leg performs ONE helper-style
// completion AFTER the resumed send has settled: `generateRaw` (public/script.js:4122) called with a prompt that is a
// single system message. That is the shape a TavernHelper/extension "quiet" completion takes when it asks for its own
// prompt rather than the chat (`createRawPrompt` unshifts the system prompt and the quiet path posts it through
// `/api/backends/chat-completions/generate`), and it is the shape the OPEN observation recorded. The old probe read
// `completions().at(-1)`, so such a request WOULD have been captured as "the resumed turn" -- this flag makes that
// failure reproducible on a fresh synthetic tree, and the ordinal attribution below is what refuses it.
const helperAfterSend = process.argv.includes('--helper-request-after-send');

const presetPath = presetArgument === null
    ? null
    : (path.isAbsolute(presetArgument) ? presetArgument : path.resolve(here, '..', '..', presetArgument));

/**
 * Plant the preset (and, for the control arm, its one-field derivation) into the tree BEFORE the subject boots.
 *
 * The file is written where the preset manager looks for it (`default-user/OpenAI Settings/<name>.json`), which is the
 * entry a real user's preset takes. Everything derived from the source is recorded with its digest, so the arm can be
 * re-run and the bytes it used be proven rather than assumed.
 */
async function plantPreset() {
    if (presetPath === null) return null;
    const source = await fs.readFile(presetPath);
    const sourceSha = createHash('sha256').update(source).digest('hex');
    const directory = path.join(dataRoot, 'default-user', 'OpenAI Settings');
    await fs.mkdir(directory, { recursive: true });
    const baseName = path.basename(presetPath, '.json');
    const name = presetNameArgument ?? (presetChatHistoryMode === 'omit' ? `${baseName}-no-chat-history` : baseName);
    const document = JSON.parse(source.toString('utf8'));
    const rows = Array.isArray(document.prompt_order) ? document.prompt_order : [];
    const runtimeRow = rows.find(row => String(row?.character_id) === String(PRESET_RUNTIME_CHARACTER_ID)) ?? null;
    if (runtimeRow === null || !Array.isArray(runtimeRow.order)) {
        throw new Error(`the preset ${baseName} has no prompt_order row for character_id ${PRESET_RUNTIME_CHARACTER_ID}, which is the row pinned's global prompt-order strategy uses; this fixture cannot answer the question it was chosen for`);
    }
    const entryIndex = runtimeRow.order.findIndex(entry => entry?.identifier === 'chatHistory');
    // THE ENABLED COUNTS ON BOTH SIDES OF THE REWRITE. The expected structure the frontend must report is the count of
    // the bytes this run planted, so it is read AFTER the rewrite rather than derived by subtracting one from the source
    // count -- a formula that is only correct while the toggled row was enabled, and that is a property of the fixture.
    const runtimeEnabledRowsBeforeRewrite = runtimeRow.order.filter(entry => entry.enabled === true).length;
    const rewrite = {
        applied: presetChatHistoryMode === 'omit',
        path: `prompt_order[character_id=${PRESET_RUNTIME_CHARACTER_ID}].order[identifier=chatHistory].enabled`,
        before: entryIndex === -1 ? null : runtimeRow.order[entryIndex].enabled === true,
        after: presetChatHistoryMode === 'omit' ? false : (entryIndex === -1 ? null : runtimeRow.order[entryIndex].enabled === true),
        reason: 'a derived control, not a user preset: the runtime row is the one the frontend uses (openai.js:696-699 dummyId 100001), and chatHistory is user-toggleable (PromptManager.js:1099-1112). This is the one field changed so the history-free branch can be measured instead of assumed.',
    };
    let planted;
    if (presetChatHistoryMode === 'omit') {
        if (entryIndex === -1) {
            throw new Error(`--preset-chat-history omit was asked for, but ${baseName}'s runtime row does not contain a chatHistory entry to disable; a row that OMITS it is a different branch and is not this control`);
        }
        runtimeRow.order[entryIndex] = { ...runtimeRow.order[entryIndex], enabled: false };
        planted = Buffer.from(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
    } else {
        planted = source;
    }
    const plantedSha = createHash('sha256').update(planted).digest('hex');
    const target = path.join(directory, `${name}.json`);
    await fs.writeFile(target, planted);
    const runtimeEnabledRowsPlanted = runtimeRow.order.filter(entry => entry.enabled === true).length;
    return {
        name,
        mode: presetChatHistoryMode,
        file: path.relative(dataRoot, target).split(path.sep).join('/'),
        source: { file: path.basename(presetPath), bytes: source.length, sha256: sourceSha },
        planted: { bytes: planted.length, sha256: plantedSha },
        contentPreserved: presetChatHistoryMode !== 'omit' || planted.length > 0,
        structure: {
            prompts: Array.isArray(document.prompts) ? document.prompts.length : null,
            orderRows: rows.reduce((total, row) => total + (Array.isArray(row?.order) ? row.order.length : 0), 0),
            runtimeCharacterId: PRESET_RUNTIME_CHARACTER_ID,
            runtimeRows: runtimeRow.order.length,
            // THE PLANTED COUNT, which is what the frontend must report after reading this run's bytes.
            runtimeEnabledRows: runtimeEnabledRowsPlanted,
            runtimeEnabledRowsBeforeRewrite,
            chatHistoryEntry: entryIndex === -1 ? { present: false, enabled: null } : { present: true, enabled: runtimeRow.order[entryIndex].enabled === true },
        },
        rewrite,
    };
}

const presetPlanting = await plantPreset();

/**
 * THE CLASSIFICATION TAXONOMY, derived from the OBSERVED prompt order and nothing else.
 *
 * Its two answers are the whole point of this arm:
 *   `resumed-history-expected`    the runtime row enables `chatHistory`, so the resumed send MUST carry the restored
 *                                 history. A request without it is a product/harness defect and goes red by name.
 *   `resumed-history-omitted-by-preset`  the runtime row has no enabled `chatHistory`, so `populateChatHistory` returns
 *                                 immediately (`public/scripts/openai.js:885-888`): the request legitimately carries NO
 *                                 history AND no copy of the typed user message. That is not a pass because it is
 *                                 absent; it is a pass because the STRUCTURE predicts it, and the same guard requires the
 *                                 GoTavern request to be byte-identical to pinned's.
 * A row that is PRESENT but disabled and a row that is ABSENT are different structures, so the reason names which one.
 */
function classifyPromptOrder(observation) {
    if (!observation || observation.chatHistoryEntry === null || observation.chatHistoryEntry === undefined) {
        return { historyExpected: null, reason: 'prompt-order-observation-missing' };
    }
    const entry = observation.chatHistoryEntry;
    if (entry.present !== true) {
        return { historyExpected: false, reason: 'prompt-order-row-omits-chatHistory', detail: `the character_id=${observation.activeCharacterId} row has no chatHistory entry` };
    }
    if (entry.enabled !== true) {
        return { historyExpected: false, reason: 'prompt-order-row-disables-chatHistory', detail: `the character_id=${observation.activeCharacterId} row has a chatHistory entry with enabled=false` };
    }
    return { historyExpected: true, reason: 'prompt-order-row-enables-chatHistory', detail: `the character_id=${observation.activeCharacterId} row has chatHistory enabled` };
}

/**
 * READ THE FRONTEND'S OWN PROMPT-ORDER STATE, through the prompt manager the generation path itself uses.
 *
 * `getPromptOrderForCharacter(activeCharacter)` is the same call `getPromptCollection(generationType)` makes
 * (PromptManager.js:1516-1541), and `activeCharacter` under the global strategy is `{id: dummyId}` (:438, :1131-1132).
 * The fallback to the raw `oai_settings.prompt_order` row exists only so a page whose manager is not initialised still
 * produces an observation the artefact can name; `via` records which route was taken.
 */
const readPromptOrder = targetPage => targetPage.evaluate(async runtimeId => {
    const openai = await import('./scripts/openai.js');
    const settings = openai.oai_settings ?? {};
    const manager = openai.promptManager ?? null;
    const activeCharacter = manager?.activeCharacter ?? null;
    let order = [];
    let via = 'manager.getPromptOrderForCharacter(activeCharacter)';
    if (manager && activeCharacter && typeof manager.getPromptOrderForCharacter === 'function') {
        order = manager.getPromptOrderForCharacter(activeCharacter) ?? [];
    } else {
        via = 'oai_settings.prompt_order row';
        const row = (settings.prompt_order ?? []).find(entry => String(entry?.character_id) === String(runtimeId));
        order = row?.order ?? [];
    }
    const entry = order.find(item => item?.identifier === 'chatHistory') ?? null;
    return {
        via,
        presetSelected: settings.preset_settings_openai ?? null,
        promptsCount: Array.isArray(settings.prompts) ? settings.prompts.length : null,
        activeCharacterId: activeCharacter?.id ?? null,
        orderLength: order.length,
        enabledCount: order.filter(item => item.enabled === true).length,
        chatHistoryEntry: entry === null ? { present: false, enabled: null } : { present: true, enabled: entry.enabled === true },
        squashSystemMessages: settings.squash_system_messages ?? null,
        streamOpenai: settings.stream_openai ?? null,
        source: settings.chat_completion_source ?? null,
        customUrl: settings.custom_url ?? null,
    };
}, PRESET_RUNTIME_CHARACTER_ID);

// ---------------------------------------------------------------------------------------------------------------
// THE ARTEFACT. Written even on failure: a leg that died with no report is indistinguishable from one that never ran,
// and this project has shipped that green twice.
// ---------------------------------------------------------------------------------------------------------------

const report = {
    surface: 'whole-session',
    phase,
    subject,
    recordedAt: new Date().toISOString(),
    dataRootName: path.basename(dataRoot),
    replyPrefix,
    markers: MARKERS,
    temperatureRequested: TEMPERATURE,
    // THE PRESET ARM, its planted bytes and its structural classification. `null` means the fresh-install journey,
    // whose prompt-order observation is still recorded (`promptOrder`) so the SAME classification rule judges it.
    preset: presetPlanting === null ? null : {
        name: presetPlanting.name,
        mode: presetPlanting.mode,
        file: presetPlanting.file,
        source: presetPlanting.source,
        planted: presetPlanting.planted,
        structure: presetPlanting.structure,
        rewrite: presetPlanting.rewrite,
    },
    promptOrder: { drive: null, restart: null, driveClassification: null, restartClassification: null },
    helperRequest: null,
    discriminator: { stampOrdinal: null, stampedText: null, appliedOnThePage: null },
    server: { baseURL: null, pid: null, spawnedAt: null, version: null, bootRefusal: null },
    steps: [],
    browser: {},
    wire: { completions: [] },
    disk: {},
    requests: { page: [], interesting: [] },
    notCompared: [
        'a real provider (AGENTS rule 22): the peer answers with markers',
        'group chats, branches and checkpoints',
        'multi-user trees',
        'chat_metadata clocks and per-message send_date: read by readChatFiles, never carried into a guard (a field that carries a clock cannot be compared across two recordings)',
        'the discriminator text itself: normalised to <REPLY_PREFIX> in every field that may carry it, and separately REQUIRED to differ between subjects',
        'which completion the resumed send produced: NOT compared by "the last request"; the peer ordinal armed immediately before the click attributes it, and the helper completion this journey can inject is recorded separately (helperRequest)',
        'which completion a helper/quiet call would have produced if the ordinal attribution were absent: recorded, and required to be a DIFFERENT request from the send\'s, never merged with it',
    ],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
}

// ---------------------------------------------------------------------------------------------------------------
// DISK, READ THE WAY THE PRODUCT WROTE IT.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The chat file carrying this journey's own first-turn marker, reduced to the fields a guard may judge.
 *
 * `send_date` and `chat_metadata`'s clock are deliberately NOT in this view: they carry a clock, so they can never be
 * compared across two independent recordings. What is kept is what a user's reload and a user's model depend on — the
 * role, the text, and the swipe state of every message — plus the header's existence.
 */
async function readDisk() {
    const files = await driveReadChatFiles(dataRoot);
    const chat = chatCarrying(files, MARKERS.turn1);
    const settings = await readSettingsFile();
    return {
        chatFileCount: files.length,
        chatFiles: files.map(file => ({ file: file.file, lines: file.lines })),
        chat: chat === null ? null : {
            file: chat.file,
            hasHeader: chat.hasHeader,
            messageCount: chat.messages.length,
            messages: chat.messages.map(message => ({
                index: message.index,
                is_user: message.is_user,
                mes: stripPrefix(message.mes),
                raw: message.mes,
                swipe_id: message.swipe_id,
                swipesCount: message.swipesCount,
                swipes: (message.swipes ?? []).map(stripPrefix),
                rawSwipes: message.swipes ?? null,
                name: message.name,
            })),
        },
        settings,
    };
}

/**
 * Find the user's setting on disk WITHOUT ASSUMING WHERE PINNED PUTS IT.
 *
 * The probe knows the value it set and records the path it actually landed at, so a comparator compares "the same
 * place" rather than two readings of two guesses. Both candidate nestings are tried because `settings.json`'s shape is
 * pinned's business, not this probe's, and inventing one would be a derivation dressed as an oracle.
 */
async function readSettingsFile() {
    const candidates = [
        { file: path.join(dataRoot, 'default-user', 'settings.json'), label: 'default-user/settings.json' },
        { file: path.join(dataRoot, 'settings.json'), label: 'settings.json' },
    ];
    for (const candidate of candidates) {
        let text = null;
        try {
            text = await fs.readFile(candidate.file, 'utf8');
        } catch {
            continue;
        }
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (error) {
            return { file: candidate.label, parseError: String(error?.message ?? error) };
        }
        const paths = [['oai_settings', 'temp_openai'], ['temp_openai']];
        const found = paths.find(keys => keys.reduce((node, key) => (node === null || node === undefined ? node : node[key]), json) !== undefined);
        const value = found ? found.reduce((node, key) => (node === null || node === undefined ? node : node[key]), json) : null;
        return {
            file: candidate.label,
            bytes: Buffer.byteLength(text),
            temperaturePath: found ? found.join('.') : null,
            temperature: typeof value === 'number' ? value : null,
        };
    }
    return { file: null, missing: 'no settings.json under the data root' };
}

// ---------------------------------------------------------------------------------------------------------------
// THE SESSION.
// ---------------------------------------------------------------------------------------------------------------

const peer = await startCapturePeer({ wire: 'honour', replyText });
const port = await freePort();
const boot = await bootSubject({ argv: process.argv.slice(2), dataRoot, port, external });
const baseURL = boot.baseURL;
report.server.baseURL = baseURL;
report.server.bootRefusal = boot.bootRefusal ?? null;
// WHICH INSTALL ROOT THE SUBJECT RAN FROM, recorded rather than inferred: the tokenizer tree's resolved path (or null
// for the pinned subject, which is booted by run-against-pinned.mjs and reads its own checkout).
report.server.tokenizers = boot.tokenizers ?? null;
const peerBase = `http://127.0.0.1:${peer.port}/v1`;
const completions = () => peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? ''));

let browser = null;
try {
    if (boot.bootRefusal) throw new Error(`subject could not be booted: ${boot.bootRefusal}`);
    report.server.pid = boot.external ? (Number(process.env.PROBE_SERVER_PID ?? 0) || null) : (boot.server?.pid ?? null);
    report.server.spawnedAt = new Date().toISOString();
    await waitForServer(`${baseURL}/version`, 120000);
    const versionResponse = await fetch(`${baseURL}/version`);
    report.server.version = { status: versionResponse.status, body: await versionResponse.json().catch(() => null) };
    step('subject-answers-version', versionResponse.status === 200 && report.server.version.body !== null,
        JSON.stringify(report.server.version));
    step('subject-process-identified', typeof report.server.pid === 'number' && report.server.pid > 0,
        `pid=${report.server.pid} (from ${boot.external ? 'PROBE_SERVER_PID, the runner that owns the pinned process' : 'the child this leg spawned'})`);

    // HEADLESS IS EXPLICIT: a default Chromium launch is headless today, but this probe must never be able to open a
    // window on the machine running it -- the operator reported a browser window during a local run, and a harness
    // that relies on a default for "do not take over the desktop" is one Playwright release away from doing it.
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    // ======================== IS THE SUBJECT AN INSTALLATION? =====================================================
    // EVERY CONTEXT-SENSITIVE REQUEST THIS JOURNEY COMPARES IS BUILT FROM TOKEN COUNTS: the world-info scan spends a
    // budget in tokens (public/scripts/world-info.js:4736, :5061) and the prompt manager decides what fits from the
    // same counts. The GoTavern server can answer those counts EXACTLY only when its tokenizer tree has been installed
    // beside the executable (the release archive ships it at `<root>/src/tokenizers`; `gotavern assets verify` refuses
    // an installation without it). When it cannot, /api/tokenizers answers the pinned Guesstimate fallback and every
    // route still returns 200 with a plausible number -- so the degradation is invisible in the requests themselves
    // and surfaces, if at all, as a mysterious one-message difference in the provider body.
    //
    // MEASURED IN RUN 41015209900: exactly that. The GoTavern leg answered `/api/tokenizers/openai/count` with 755
    // where pinned answered 589, and 971 where pinned answered 749 (~25% high, the fallback's measured signature); the
    // world-info budget then dropped the `power` example entry and request 1 was 6682 bytes against pinned's 7404.
    // The comparator's `completion-1-equal`/`completion-2-equal` guards were the red, and no product code could have
    // made them green: the leg's binary had been built into a scratch directory with no tokenizer tree beside it.
    //
    // SO THE LEG RECORDS THE SUBJECT'S EXACTNESS and asserts it as a named step, for BOTH subjects (symmetry is what
    // keeps the assertion non-vacuous: the pinned server, which has no such header, must carry NONE, while the GoTavern
    // server must answer `exact: true` on EVERY tokenizer response). `q20-leg-runtime.mjs bootSubject` is what
    // installs the tree; this is the assertion that notices if it stops doing so.
    page.on('response', response => {
        if (!/\/api\/tokenizers\//.test(response.url())) return;
        const headers = response.headers();
        tokenizerResponses.push({
            path: new URL(response.url()).pathname,
            exact: headers['x-gotavern-tokenizer-exact'] ?? null,
            layout: headers['x-gotavern-tokenizer-layout'] ?? null,
        });
    });
    page.on('pageerror', error => {
        report.browser.pageErrors = report.browser.pageErrors ?? [];
        if (report.browser.pageErrors.length < 40) report.browser.pageErrors.push(String(error?.message ?? error).slice(0, 300));
    });
    page.on('framenavigated', frame => {
        if (frame !== page.mainFrame()) return;
        report.browser.navigations = report.browser.navigations ?? [];
        report.browser.navigations.push({ url: frame.url(), at: new Date().toISOString() });
    });
    // The pinned page reaches a CDN for its libraries; the harness refuses it so no leg can depend on the internet.
    await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
    const recorder = attachUrlRecorder(page);
    const pageRequests = () => recorder.requests.map(entry => ({ method: entry.method, path: entry.pathAndQuery, status: entry.status }));

    const openPage = () => driveOpenPage(page, baseURL);
    // THE CONNECTION, THROUGH THE FRONTEND'S OWN CONTROLS. Re-applied after every reload because the peer's port is
    // ephemeral and a fresh page comes back holding the fresh-install default (q20-persistence-drive.mjs:375-379).
    const connect = async () => {
        const applied = await configureConnection(page, { url: peerBase, model: 'probe-model' });
        report.browser.connection = applied;
        return applied;
    };
    // ---- THE PRESET ARM'S TWO HALVES: select it, and read the structure generation will actually use ---------
    //
    // THE SELECTION IS THE FRONTEND'S OWN CONTROL, and the application is awaited through its own promise, because
    // application is asynchronous and `OAI_PRESET_CHANGED_BEFORE` can overwrite the connection source
    // (capture-settings.mjs:8-13; openai.js:5063). That is why the callers below select/await BEFORE `connect()`.
    const selectPreset = async () => {
        if (presetPlanting === null) return { requested: false };
        const outcome = await page.evaluate(async name => {
            const openai = await import('./scripts/openai.js');
            const select = document.querySelector('#settings_preset_openai');
            if (!select) return { ok: false, reason: 'no #settings_preset_openai control' };
            const option = [...select.options].find(entry => entry.textContent?.trim() === name || entry.value === name);
            if (!option) {
                return { ok: false, reason: `the preset manager does not list ${JSON.stringify(name)}`, options: [...select.options].map(entry => entry.textContent?.trim()).slice(0, 40) };
            }
            select.value = option.value;
            select.dispatchEvent(new Event('change', { bubbles: true }));
            if (typeof openai.getPresetApplicationPromise === 'function') {
                await openai.getPresetApplicationPromise(openai.oai_settings.preset_settings_openai);
            }
            await new Promise(resolve => setTimeout(resolve, 500));
            return { ok: true, selected: openai.oai_settings.preset_settings_openai ?? null, optionValue: option.value };
        }, presetPlanting.name);
        return { requested: true, ...outcome };
    };
    // THE EXPECTED STRUCTURE IS THE PLANTED FIXTURE'S OWN, not a number written down here: prompts and the runtime
    // row's length/enabled count are read out of the bytes this run planted, and the control arm's own rewrite is the
    // only difference. A frontend reporting different numbers did not apply the file this run put there.
    const expectedPromptStructure = () => {
        if (presetPlanting === null) return { prompts: null, rows: null, enabled: null };
        return {
            prompts: presetPlanting.structure.prompts,
            rows: presetPlanting.structure.runtimeRows,
            // READ FROM THE PLANTED BYTES, never derived by subtracting the rewrite from the source count: the count the
            // frontend must report is a property of the file this run wrote (structure.runtimeEnabledRows is computed
            // AFTER the rewrite for exactly that reason).
            enabled: presetPlanting.structure.runtimeEnabledRows,
        };
    };
    const recordPromptOrder = async kind => {
        const observation = await readPromptOrder(page);
        const classification = classifyPromptOrder(observation);
        report.promptOrder[kind] = observation;
        report.promptOrder[`${kind}Classification`] = classification;
        return { observation, classification };
    };
    // THE PAGE'S OWN STATE READER, used at every moment the artefact compares. It reads the chat through
    // `getContext()` — NOT `SillyTavern.eventSource`, which does not exist (q20-persistence-drive.mjs:158-170).
    //
    // THE PREFIX IS PASSED IN BECAUSE A PAGE FUNCTION CANNOT SEE THIS MODULE'S HELPERS: `stripPrefix` has to be applied
    // inside the evaluation, which is also why the prefix is the ONLY thing the page is told about the comparison (it
    // cannot influence anything else).
    const readPageState = () => page.evaluate(async prefix => {
        const script = await import('./script.js');
        const context = (window.SillyTavern && window.SillyTavern.getContext) ? window.SillyTavern.getContext() : null;
        const chat = script.chat ?? [];
        const openai = await import('./scripts/openai.js');
        const normalise = text => (prefix === '' ? String(text ?? '') : String(text ?? '').split(prefix).join('<REPLY_PREFIX>'));
        return {
            settingsReady: script.settingsReady === true,
            chatId: context?.chatId ?? null,
            characterName: context?.name2 ?? context?.name ?? null,
            chatLength: chat.length,
            domMessages: document.querySelectorAll('#chat .mes').length,
            temperature: typeof openai.oai_settings?.temp_openai === 'number' ? openai.oai_settings.temp_openai : null,
            sequence: chat.map(entry => ({ role: entry?.is_user === true ? 'user' : 'assistant', text: normalise(entry?.mes) })),
            rawSequence: chat.map(entry => String(entry?.mes ?? '')),
            lastIsUser: chat[chat.length - 1]?.is_user === true,
            lastSwipes: Array.isArray(chat[chat.length - 1]?.swipes) ? chat[chat.length - 1].swipes.length : null,
            lastSwipeId: chat[chat.length - 1]?.swipe_id ?? null,
            isSendPress: script.is_send_press ?? null,
            streaming: Boolean(script.streamingProcessor),
        };
    }, replyPrefix);

    /**
     * A CHAT LOAD IS ASYNCHRONOUS, AND THE CLICK THAT TRIGGERED IT HAS ALREADY RETURNED.
     *
     * `openCharacter` resolves when the CARD is open, not when the conversation is on the page: measured in this
     * surface's first run, where the read after a reload returned `chatLength: 0` for a chat the file already held,
     * and every later step then measured a state no user would have acted on (a second turn that opened a NEW chat, a
     * regenerate whose "replaced" reply was empty). Every read that follows a reload or a reopen goes through this
     * bound instead of a sleep: it waits for the PRODUCT's own state to carry what the file holds, and fails BY NAME
     * when the budget expires rather than letting a stale read become a finding.
     */
    const waitForChatLoaded = async ({ marker = null, minimum = 2, timeoutMs = 45000 } = {}) => {
        const deadline = Date.now() + timeoutMs;
        let state = null;
        while (Date.now() < deadline) {
            state = await readPageState();
            const carries = marker === null || state.sequence.some(entry => entry.text.includes(marker));
            // THE DOM MUST HAVE RENDERED THE CHAT, and this condition was added from a MEASURED local race: a reload
            // read `chatLength: 3, domMessages: 0` on the GoTavern leg while pinned showed 3, so `reload-state-equal`
            // went red on a difference the probe created by reading between the chat model and the renderer. A user
            // sees the messages; the reader that records `domMessages` must wait for the same state. It is not a
            // substitute for the product assertion: the comparator still requires the DOM count to equal pinned's.
            const rendered = Number(state.domMessages ?? 0) >= Number(state.chatLength ?? 0);
            if (state.chatLength >= minimum && carries && rendered && state.isSendPress !== true && state.streaming !== true) {
                return { ok: true, state };
            }
            await page.waitForTimeout(250);
        }
        return { ok: false, state };
    };

    const driver = { page, recorder, openPage, connect, readPageState, pageRequests, baseURL, waitForChatLoaded, selectPreset, recordPromptOrder, expectedPromptStructure };

    if (phase === 'drive') {
        await drivePhase(driver);
    } else {
        await restartPhase(driver);
    }

    report.requests.page = pageRequests();
    report.requests.interesting = pageRequests().filter(entry => /\/(api\/(settings|characters|chats)|version|thumbnail)/.test(entry.path ?? ''));
    report.wire.completions = completions().map((entry, index) => ({
        index: index + 1,
        method: entry.method,
        path: entry.path,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        body: entry.body,
        requestedStream: entry.requestedStream,
        served: entry.served,
    }));
    report.wire.count = report.wire.completions.length;
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    if (browser) await browser.close().catch(() => {});
    await peer.close().catch(() => {});
    if (boot.server) boot.server.kill();
    report.serverLog = boot.serverLog ?? [];
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${subject} ${phase} leg: ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;

// ---------------------------------------------------------------------------------------------------------------
// PHASE `drive`.
// ---------------------------------------------------------------------------------------------------------------

async function drivePhase({ page, recorder, openPage, connect, readPageState, pageRequests, waitForChatLoaded, selectPreset, recordPromptOrder, expectedPromptStructure }) {
    const loaded = await openPage();
    const readiness = await readReadiness(page);
    report.browser.readiness = readiness;
    step('page-loaded', loaded === true && readiness?.settingsReady === true,
        `openPage=${loaded}; readiness=${JSON.stringify(readiness)}`);

    // ---- 0. THE PRESET, BEFORE THE CONNECTION ---------------------------------------------------------------
    // Order is a measured hazard, not a preference: applying a preset fires OAI_PRESET_CHANGED_BEFORE, and a
    // connection configured before that can be overwritten by it (capture-settings.mjs:8-13; openai.js:5063). The
    // structure is read back from the live prompt manager AFTER the application settles, so the classification below
    // is an observation of what generation will use, not a reading of the file this leg planted.
    if (presetPlanting !== null) {
        const selection = await selectPreset();
        report.browser.presetSelection = selection;
        step('preset-selected', selection?.ok === true && selection.selected === presetPlanting.name, JSON.stringify(selection));
        const { observation, classification } = await recordPromptOrder('drive');
        const expected = expectedPromptStructure();
        step('preset-structure-is-the-planted-fixture',
            observation.promptsCount === expected.prompts
            && observation.orderLength === expected.rows
            && observation.enabledCount === expected.enabled,
            JSON.stringify({ expected, observed: observation, classification }));
    } else {
        // THE FRESH-INSTALL JOURNEY IS CLASSIFIED BY THE SAME RULE, from the frontend's live prompt order, so the
        // history requirement is never a special case of "no preset was asked for".
        const { observation, classification } = await recordPromptOrder('drive');
        step('prompt-order-recorded', observation.chatHistoryEntry !== null && observation.activeCharacterId !== null,
            JSON.stringify({ observation, classification }));
    }
    report.browser.connectionInitial = await connect();

    // ---- 1. SETTINGS: READ, CHANGE ONE, SAVE, AND SEE IT ON DISK ---------------------------------------------
    const settingsLoaded = pageRequests().some(entry => /\/api\/settings\/get$/.test(entry.path ?? '') && entry.status === 200);
    step('settings-loaded', settingsLoaded === true,
        JSON.stringify(pageRequests().filter(entry => /settings/.test(entry.path ?? ''))));

    const settingsWrite = await page.evaluate(async temperature => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        const before = typeof openai.oai_settings?.temp_openai === 'number' ? openai.oai_settings.temp_openai : null;
        // THE UI FIRST, because a user changes a setting through a control, and the frontend's own handler is what
        // turns that control's value into the setting.
        const control = document.querySelector('#temp_openai');
        let source = 'object';
        if (control) {
            control.value = String(temperature);
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
            source = 'slider';
        }
        let after = typeof openai.oai_settings?.temp_openai === 'number' ? openai.oai_settings.temp_openai : null;
        // THE FALLBACK IS NAMED IN THE ARTEFACT, never hidden: if the control did not carry the value the setting is
        // assigned directly and `source` says so, so the comparator can require the SAME mechanism on both subjects.
        if (after === null || Math.abs(after - temperature) > 1e-9) {
            openai.oai_settings.temp_openai = temperature;
            after = openai.oai_settings.temp_openai;
            source = control ? 'slider+object' : 'object';
        }
        let save = { called: false };
        try {
            if (typeof script.saveSettings === 'function') {
                await script.saveSettings();
                save = { called: true, via: 'saveSettings' };
            } else if (typeof script.saveSettingsDebounced === 'function') {
                script.saveSettingsDebounced();
                save = { called: true, via: 'saveSettingsDebounced' };
            }
        } catch (error) {
            save = { called: true, threw: String(error?.message ?? error) };
        }
        return { controlFound: Boolean(control), source, before, after, save };
    }, TEMPERATURE);
    report.browser.settingsWrite = settingsWrite;
    // THE SAVE IS JUDGED BY THE REQUEST AND BY THE DISK, never by a resolved promise.
    {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            await recorder.settled();
            if (pageRequests().some(entry => /\/api\/settings\/save$/.test(entry.path ?? '') && entry.status === 200)) break;
            await page.waitForTimeout(250);
        }
    }
    await recorder.settled();
    const settingsSaveAccepted = pageRequests().some(entry => /\/api\/settings\/save$/.test(entry.path ?? '') && entry.status === 200);
    const settingsOnDiskAfterWrite = await readSettingsFile();
    report.browser.settingsDiskAfterWrite = settingsOnDiskAfterWrite;
    step('settings-change-applied',
        settingsWrite.after !== null && Math.abs(Number(settingsWrite.after) - TEMPERATURE) < 1e-9,
        JSON.stringify({ before: settingsWrite.before, after: settingsWrite.after, source: settingsWrite.source }));
    // A 200 on the save IS the CSRF evidence: pinned's settings route sits behind the CSRF middleware, so a request
    // that arrived without the session's token cannot answer 200.
    step('settings-save-reached-the-server', settingsSaveAccepted === true,
        JSON.stringify(pageRequests().filter(entry => /settings\/save/.test(entry.path ?? ''))));
    step('settings-change-persisted', Number(settingsOnDiskAfterWrite.temperature) === TEMPERATURE,
        JSON.stringify(settingsOnDiskAfterWrite));

    // ---- 2. CHARACTERS: LIST, THEN OPEN THE CARD -----------------------------------------------------------
    const roster = await resolveRoster(page);
    report.browser.roster = roster;
    step('characters-listed', roster.count > 0, JSON.stringify(roster));
    const cardName = roster.names[0] ?? '';
    const characterOpen = await driveOpenCharacter(page, cardName);
    report.browser.characterOpen = characterOpen;
    step('character-opened', characterOpen?.opened === true,
        JSON.stringify({ wanted: cardName, opened: characterOpen?.opened ?? null, reason: characterOpen?.reason ?? null }));

    // ---- 3. SEND + STREAM: THE FIRST TURN, WHOSE REPLY CARRIES THE DISCRIMINATOR ---------------------------
    // THE CARD'S CHAT IS LOADED BY THE SAME ASYNCHRONOUS PATH A RELOAD USES, so the first turn waits for it with the
    // same bound. WITHOUT THIS, THE FIRST SEND RACES THE GREETING and the wait that follows mistakes the greeting's
    // arrival for the reply: measured locally twice out of five runs while another lane was driving its own server —
    // the click landed at `chatLength: 0`, the greeting then arrived, and `waitForReply` returned `ok` after 11 ms on
    // `{chatLength: 1, lastIsUser: false, lastTextLength: 785}` — the greeting, not a reply. The leg then read the
    // swipe precondition on a page that had not generated anything (`swipeAllowed: false, isSendPress: true`) and the
    // journey collapsed into five red steps that were all one race. A real user sees the greeting before they type;
    // this is the probe refusing to drive a state a user cannot reach (AGENTS rule 10).
    const firstChatLoaded = await waitForChatLoaded({ minimum: 1, timeoutMs: 45000 });
    report.browser.firstChatLoaded = firstChatLoaded.state;
    step('first-chat-loaded', firstChatLoaded.ok === true, JSON.stringify(firstChatLoaded.state));
    // ARMED BEFORE THE CLICK, from the peer's own count, because the click issues the request.
    stampOrdinal = completions().length + 1;
    const beforeFirstTurn = await readPageState();
    const sentFirst = await sendTurn(page, MARKERS.turn1);
    report.browser.firstTurn = { sent: sentFirst, before: beforeFirstTurn };
    let firstSettled = { ok: false, state: null };
    if (sentFirst?.clicked === true) {
        firstSettled = await waitForReply(page, {
            timeoutMs: 90000, requireText: true,
            peerCompletions: completions().length + 1,
            baseline: sentFirst.baseline ?? beforeFirstTurn,
        });
    }
    report.browser.firstTurn.settled = firstSettled;
    step('first-turn-sent', sentFirst?.clicked === true && firstSettled.ok === true,
        firstSettled.ok === true ? JSON.stringify(firstSettled.state) : JSON.stringify({ sent: sentFirst, settled: firstSettled }));
    // THE STREAM IS A FACT ABOUT WHAT THE PEER SERVED, quoted from the peer's own record: `served.wire` says what went
    // over the socket and `requestedStream` says what the page asked for, so a leg that drove a streaming page against
    // a JSON peer is visible here instead of being inferred from a missing message.
    const firstCompletion = completions()[0] ?? null;
    report.browser.firstTurn.completion = firstCompletion === null ? null
        : { requestedStream: firstCompletion.requestedStream, served: firstCompletion.served };
    step('first-turn-streamed', firstCompletion?.requestedStream === true && firstCompletion?.served?.wire === 'sse',
        JSON.stringify(report.browser.firstTurn.completion));
    // THE SUBJECT'S TOKEN EXACTNESS, judged from the responses the PAGE received (see the recorder above). The first
    // turn is where the tokenizer routes are first asked, so by here the answer exists for both subjects.
    report.browser.tokenizers = {
        subject,
        responses: tokenizerResponses.length,
        exactValues: [...new Set(tokenizerResponses.map(entry => entry.exact))],
        layouts: [...new Set(tokenizerResponses.map(entry => entry.layout))],
    };
    step('subject-tokenizes-exactly', tokenizerResponses.length > 0 && (subject === 'gotavern'
        ? tokenizerResponses.every(entry => entry.exact === 'true')
        : tokenizerResponses.every(entry => entry.exact === null)),
    JSON.stringify(report.browser.tokenizers));
    const afterFirst = await readPageState();
    report.browser.afterFirstTurn = afterFirst;
    step('first-turn-rendered-the-reply', afterFirst.sequence.some(entry => replyPattern.test(entry.text)),
        JSON.stringify(afterFirst.sequence));
    // THE DISCRIMINATOR'S OWN RECORD. THE PEER'S REQUEST DOES NOT CARRY THE REPLY IT SERVES: the first version of this
    // check searched `entry.body` — what the page SENT — for the prefix, so it could only ever report a missing stamp
    // while the page was rendering it perfectly well (measured in this surface's first run: `appliedOnThePage: false`
    // beside a sequence whose last entry read `<REPLY_PREFIX>WS_REPLY_1`). It is proven on the two surfaces it actually
    // reaches: the text the peer SERVED (a function of the ordinal this leg armed) and the page's own chat, read from
    // `rawSequence` because `sequence` is already normalised.
    report.discriminator = {
        stampOrdinal,
        // READ BACK THROUGH THE SAME FUNCTION that produced it, so the artefact cannot record a literal the peer never
        // served (the padding added below is part of the served text).
        stampedText: replyPrefix === '' ? null : replyText(stampOrdinal),
        appliedOnThePage: replyPrefix !== '' && afterFirst.rawSequence.some(text => text.includes(replyPrefix)),
    };
    step('discriminator-applied-to-the-swipeable-reply',
        replyPrefix === '' || (report.discriminator.stampedText !== null && report.discriminator.appliedOnThePage === true),
        JSON.stringify(report.discriminator));

    // ---- 4. SWIPE THE REPLY THAT CARRIES IT ----------------------------------------------------------------
    // The frontend's own `swipe()`, with the message the clicks are wired to (`forceMesId`); the precondition is
    // asserted first so a swipe the product refuses is never read as a product finding.
    const swipePrecondition = await page.evaluate(async () => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        return {
            lastIsUser: chat[chat.length - 1]?.is_user === true,
            swipeAllowed: typeof script.isSwipingAllowed === 'function' ? script.isSwipingAllowed() : null,
            isSendPress: script.is_send_press ?? null,
            generating: Boolean(script.streamingProcessor),
        };
    });
    report.browser.swipePrecondition = swipePrecondition;
    step('swipe-precondition-reachable',
        swipePrecondition.lastIsUser === false && swipePrecondition.swipeAllowed !== false
        && swipePrecondition.isSendPress !== true && swipePrecondition.generating !== true,
        JSON.stringify(swipePrecondition));
    const swiped = await page.evaluate(async () => {
        const script = await import('./script.js');
        const constants = await import('./scripts/constants.js');
        const chat = script.chat ?? [];
        const mesId = chat.length - 1;
        const before = {
            chatLength: chat.length,
            swipeId: chat[mesId]?.swipe_id ?? null,
            swipes: Array.isArray(chat[mesId]?.swipes) ? chat[mesId].swipes.length : null,
            lastText: String(chat[mesId]?.mes ?? ''),
        };
        let error = null;
        try {
            await script.swipe(null, constants.SWIPE_DIRECTION.RIGHT, {
                source: constants.SWIPE_SOURCE.SWIPE_PICKER, repeated: false, forceMesId: mesId,
            });
        } catch (thrown) {
            error = String(thrown?.message ?? thrown);
        }
        const live = script.chat ?? [];
        return {
            before, error,
            after: {
                chatLength: live.length,
                swipeId: live[mesId]?.swipe_id ?? null,
                swipes: Array.isArray(live[mesId]?.swipes) ? live[mesId].swipes.length : null,
                lastText: String(live[mesId]?.mes ?? ''),
            },
        };
    });
    report.browser.swipe = swiped;
    step('swipe-held',
        swiped.error === null && Number(swiped.after.swipes ?? 0) > Number(swiped.before.swipes ?? 0)
        && Number(swiped.after.swipeId ?? -1) > Number(swiped.before.swipeId ?? -2),
        JSON.stringify(swiped));

    // ---- 5. SAVE, THEN RELOAD: A FRESH PAGE MUST READ THE CHAT BACK ------------------------------------------
    const saveAfterSwipe = await saveConditional(page);
    await settleQuiet(page, recorder, { quietMs: 500, maxMs: 8000 });
    const diskAfterSwipe = await readDisk();
    report.disk.afterSwipe = diskAfterSwipe;
    step('swipe-saved-the-replacement-reply',
        saveAfterSwipe?.ok === true && (diskAfterSwipe.chat?.messages ?? []).some(message => replyPattern.test(message.mes)),
        JSON.stringify({ save: saveAfterSwipe, file: diskAfterSwipe.chat?.file ?? null, messageCount: diskAfterSwipe.chat?.messageCount ?? null }));
    // AND THE DISCRIMINATOR IS ON DISK, inside the swiped message's own `swipes[]`. Asserted here, at the only moment
    // it can be attributed to the swipe, and again at the end of the journey where the comparator reads it.
    const swipedSwipes = (diskAfterSwipe.chat?.messages ?? []).flatMap(message => message.rawSwipes ?? []);
    step('disk-holds-the-per-subject-discriminator',
        replyPrefix === '' || swipedSwipes.some(text => String(text).includes(replyPrefix)),
        JSON.stringify({ replyPrefix, swipedSwipes: swipedSwipes.map(text => String(text).slice(0, 40)) }));

    // THE RELOAD. This is the step no other leg performs and the step a user performs by closing and opening the tab.
    const reloaded = await openPage();
    const reopenedAfterReload = await driveOpenCharacter(page, cardName);
    const connectionAfterReload = await connect();
    const reloadSettled = await waitForChatLoaded({ marker: MARKERS.turn1, minimum: 3 });
    const afterReload = reloadSettled.state ?? await readPageState();
    report.browser.afterReload = { openPage: reloaded, characterOpen: reopenedAfterReload, connection: connectionAfterReload, state: afterReload };
    step('reload-reopened-the-same-chat',
        reloadSettled.ok === true && afterReload.chatId !== null
        && afterReload.sequence.some(entry => entry.text.includes(MARKERS.turn1)),
        JSON.stringify({ reloadSettled: reloadSettled.ok, chatId: afterReload.chatId, chatLength: afterReload.chatLength, sequence: afterReload.sequence }));
    step('reload-carried-the-swipe-state', Number(afterReload.lastSwipes ?? 0) > 1,
        JSON.stringify({ lastSwipes: afterReload.lastSwipes, lastSwipeId: afterReload.lastSwipeId }));

    // ---- 6. THE SECOND TURN, ON THE RELOADED PAGE -----------------------------------------------------------
    const sentSecond = await sendTurn(page, MARKERS.turn2);
    let secondSettled = { ok: false, state: null };
    if (sentSecond?.clicked === true) {
        secondSettled = await waitForReply(page, {
            timeoutMs: 90000, requireText: true,
            peerCompletions: completions().length + 1,
            baseline: sentSecond.baseline ?? { chatLength: afterReload.chatLength, lastTextLength: 0 },
        });
    }
    report.browser.secondTurn = { sent: sentSecond, settled: secondSettled };
    step('second-turn-sent', sentSecond?.clicked === true && secondSettled.ok === true,
        secondSettled.ok === true ? JSON.stringify(secondSettled.state) : JSON.stringify({ sent: sentSecond, settled: secondSettled }));

    // ---- 7. REGENERATE --------------------------------------------------------------------------------------
    // The last assistant message is DELETED before the prompt is assembled (`public/script.js:4399-4406`) and a new
    // one is pushed (:6738), so the request must NOT carry the reply it replaced. That absence is a product assertion,
    // and it is what mutation C attacks.
    const regenerateCompletionsBefore = completions().length;
    // THE REPLY THAT IS ABOUT TO BE DELETED IS READ FROM THE PAGE HERE, NOT FROM THE VERB'S OWN `before`. Measured in
    // this surface's first CI run: `pressRegenerate`'s `before` carries the chat LENGTH and the swipe state but NO
    // `lastText` (that field exists only in its `after`), so `String(before.lastText ?? '')` was `''`, the
    // "replaced text is non-empty" precondition refused, and the step went red for a reason one layer below the claim.
    const beforeRegenerate = await readPageState();
    const replacedText = String(beforeRegenerate.rawSequence.at(-1) ?? '');
    const regenerated = await pressRegenerate(page);
    // THE PRESS'S OWN BEFORE/AFTER ARE HOISTED, not left inside `result`: the comparator names this verb's chat length,
    // and a guard that has to know whether a field sits under `.result` is a guard that will one day read `undefined`
    // on both sides and pass.
    report.browser.regenerate = {
        result: regenerated, completionsBefore: regenerateCompletionsBefore,
        before: regenerated?.before ?? null, after: regenerated?.after ?? null,
        replacerState: { chatLength: beforeRegenerate.chatLength, lastTextLength: replacedText.length, lastText: replacedText },
    };
    if (regenerated?.pressed === true) {
        const settled = await waitForReply(page, {
            timeoutMs: 90000, requireText: true,
            peerCompletions: regenerateCompletionsBefore + 1,
            baseline: { chatLength: beforeRegenerate.chatLength, lastTextLength: replacedText.length },
        });
        const request = completions()[regenerateCompletionsBefore] ?? null;
        report.browser.regenerate.settled = settled;
        report.browser.regenerate.request = request === null ? null : {
            index: regenerateCompletionsBefore + 1,
            bodySha256: request.sha256,
            requestedStream: request.requestedStream,
            served: request.served,
            replacedTextLength: replacedText.length,
            carriesReplacedText: replacedText.length > 0 && request.body.includes(replacedText),
        };
        // THE VACUOUS PASS IS REFUSED: with an EMPTY last message "the request does not carry the replaced reply" is
        // true of every request, so the assertion must be able to fail before it is allowed to pass.
        step('regenerate-deleted-then-replaced-the-reply',
            settled.ok === true && replacedText.length > 0
            && report.browser.regenerate.request?.carriesReplacedText === false
            && Number(settled.state?.chatLength ?? 0) === Number(regenerated.before?.chatLength ?? -1),
            JSON.stringify({ settled, request: report.browser.regenerate.request }));
    } else {
        step('regenerate-deleted-then-replaced-the-reply', false, JSON.stringify(regenerated));
    }
    await saveConditional(page);
    await settleQuiet(page, recorder, { quietMs: 500, maxMs: 8000 });

    // ---- 8. CONTINUE ----------------------------------------------------------------------------------------
    // Continue REPLACES the last message's text in place (:6719-6737) and appends no message, so its signature is a
    // GROWN text at the SAME length — the opposite of regenerate's, and the reason the two verbs cannot share an
    // assertion (mutation D is what catches a driver that points at the wrong request).
    const continueCompletionsBefore = completions().length;
    // THE SAME MEASUREMENT AS REGENERATE, one verb over: `pressContinue`'s `before` has no `lastText`, so the text the
    // continuation must GROW is read from the page here. Without it, `beforeLength` was 0, the vacuous-pass refusal
    // fired, and the red described the fixture rather than the product.
    const beforeContinue = await readPageState();
    const continuedText = String(beforeContinue.rawSequence.at(-1) ?? '');
    const continued = await pressContinue(page);
    report.browser.continue = {
        result: continued, completionsBefore: continueCompletionsBefore,
        before: continued?.before ?? null, after: continued?.after ?? null,
        growerState: { chatLength: beforeContinue.chatLength, lastTextLength: continuedText.length, lastText: continuedText },
    };
    if (continued?.pressed === true) {
        const settled = await waitForReply(page, {
            timeoutMs: 90000, requireText: true,
            peerCompletions: continueCompletionsBefore + 1,
            baseline: { chatLength: beforeContinue.chatLength, lastTextLength: continuedText.length },
        });
        const afterContinue = await readPageState();
        const request = completions()[continueCompletionsBefore] ?? null;
        const beforeLength = continuedText.length;
        const afterLength = String(afterContinue.rawSequence.at(-1) ?? '').length;
        report.browser.continue.settled = settled;
        report.browser.continue.after = afterContinue;
        report.browser.continue.request = request === null ? null : {
            index: continueCompletionsBefore + 1,
            bodySha256: request.sha256,
            requestedStream: request.requestedStream,
            served: request.served,
        };
        // SAME REFUSAL OF A VACUOUS PASS: an empty "before" makes "the text grew" a comparison of zero with a number.
        step('continue-grew-the-same-message',
            settled.ok === true && beforeLength > 0
            && Number(afterContinue.chatLength) === Number(continued.before?.chatLength)
            && afterLength > beforeLength,
            JSON.stringify({
                settled,
                before: { chatLength: continued.before?.chatLength, lastTextLength: beforeLength },
                after: { chatLength: afterContinue.chatLength, lastTextLength: afterLength },
            }));
    } else {
        step('continue-grew-the-same-message', false, JSON.stringify(continued));
    }

    // ---- 9. PERSIST, THEN RECORD THE STATE THE RESTART MUST FIND --------------------------------------------
    const finalSave = await saveConditional(page);
    await settleQuiet(page, recorder, { quietMs: 500, maxMs: 8000 });
    const finalDisk = await readDisk();
    const finalPage = await readPageState();
    report.browser.final = finalPage;
    report.disk.final = finalDisk;
    step('state-was-saved-before-the-restart',
        finalSave?.ok === true && (finalDisk.chat?.messageCount ?? 0) >= 4, JSON.stringify({
            save: finalSave,
            file: finalDisk.chat?.file ?? null,
            messageCount: finalDisk.chat?.messageCount ?? null,
            chatId: finalPage.chatId,
        }));
    // NON-VACUITY, ABSOLUTE rather than comparative: a journey of this shape produced at least five completions (turn
    // one, the swipe, turn two, regenerate, continue). A comparator that only compares two artefacts cannot see a
    // journey that performed FEWER verbs on BOTH sides; this can.
    step('journey-performed-every-wire-step', completions().length >= MINIMUM_COMPLETIONS,
        `${completions().length} completion(s): ${completions().map(entry => entry.served?.wire ?? '?').join(',')}`);
    step('settings-still-persisted-at-the-end-of-the-journey',
        Number(finalDisk.settings?.temperature) === TEMPERATURE, JSON.stringify(finalDisk.settings));
}

// ---------------------------------------------------------------------------------------------------------------
// PHASE `restart`: A NEW PROCESS, A NEW PAGE, THE SAME TREE. What the drive phase wrote, read back by something that
// did not write it.
// ---------------------------------------------------------------------------------------------------------------

async function restartPhase({ page, recorder, openPage, connect, readPageState, waitForChatLoaded, recordPromptOrder, expectedPromptStructure }) {
    const loaded = await openPage();
    const readiness = await readReadiness(page);
    report.browser.readiness = readiness;
    step('restart-page-loaded', loaded === true && readiness?.settingsReady === true,
        `openPage=${loaded}; readiness=${JSON.stringify(readiness)}`);

    // ---- THE NEW PROCESS MUST READ THE PRESET BACK, WITHOUT THIS LEG SELECTING ANYTHING -----------------------
    // A user's tree already has the preset selected when the server restarts, so a leg that re-selected it would be
    // proving its own write instead of the product's read. The observation is taken before the connection is
    // configured, and its classification is the one the resumed request below is judged against.
    {
        const { observation, classification } = await recordPromptOrder('restart');
        if (presetPlanting !== null) {
            const expected = expectedPromptStructure();
            step('restart-preset-restored',
                observation.presetSelected === presetPlanting.name
                && observation.promptsCount === expected.prompts
                && observation.orderLength === expected.rows
                && observation.enabledCount === expected.enabled,
                JSON.stringify({ requested: presetPlanting.name, expected, observed: observation, classification }));
        } else {
            step('restart-prompt-order-readable', observation.chatHistoryEntry !== null,
                JSON.stringify({ observation, classification }));
        }
    }

    // THE SETTING MUST COME BACK WITHOUT THIS LEG WRITING IT. Read from the DISK first (nothing on the page can have
    // influenced it), then from the page (which is what proves the frontend's own load path read that file).
    const settingsOnDisk = await readSettingsFile();
    report.disk.settingsAtRestart = settingsOnDisk;
    const stateBeforeReopen = await readPageState();
    report.browser.atRestart = stateBeforeReopen;
    step('restart-read-the-setting-from-disk',
        Number(settingsOnDisk.temperature) === TEMPERATURE && Number(stateBeforeReopen.temperature) === TEMPERATURE,
        JSON.stringify({ disk: settingsOnDisk.temperature, page: stateBeforeReopen.temperature, path: settingsOnDisk.temperaturePath }));

    // THE CHAT, REOPENED BY THE NEW PROCESS FROM THE FILE THE OLD ONE WROTE.
    const roster = await resolveRoster(page);
    report.browser.roster = roster;
    step('restart-listed-the-characters', roster.count > 0, JSON.stringify(roster));
    const cardName = roster.names[0] ?? '';
    const characterOpen = await driveOpenCharacter(page, cardName);
    const reopenSettled = await waitForChatLoaded({ marker: MARKERS.turn1, minimum: 3 });
    const reopened = reopenSettled.state ?? await readPageState();
    report.browser.characterOpen = characterOpen;
    report.browser.reopened = reopened;
    step('restart-reopened-the-chat',
        reopenSettled.ok === true && characterOpen?.opened === true && reopened.chatId !== null
        && reopened.sequence.some(entry => entry.text.includes(MARKERS.turn1)),
        JSON.stringify({ reopenSettled: reopenSettled.ok, opened: characterOpen?.opened ?? null, chatId: reopened.chatId, chatLength: reopened.chatLength, sequence: reopened.sequence }));
    // THE HISTORY, BY CONTENT: both user turns this journey wrote must be in the reopened conversation, and the
    // assistant turns between them must be replies (the peer's markers), not empty records.
    const restoredReplies = reopened.sequence.filter(entry => entry.role === 'assistant' && replyPattern.test(entry.text));
    step('restart-restored-the-whole-history',
        reopened.sequence.some(entry => entry.text.includes(MARKERS.turn2)) && restoredReplies.length >= 2,
        JSON.stringify({ restoredReplies: restoredReplies.map(entry => entry.text), sequence: reopened.sequence.map(entry => `${entry.role}:${entry.text.slice(0, 32)}`) }));
    step('restart-restored-the-swipe-state', Number(reopened.lastSwipes ?? 0) >= 1,
        JSON.stringify({ lastSwipes: reopened.lastSwipes, lastSwipeId: reopened.lastSwipeId }));

    // ---- AND THEN KEEP USING IT. A new turn whose request must carry whatever the prompt order says it must carry;
    // the difference between "the file was read" and "the session continued".
    await connect();
    // THE ORDINAL IS ARMED IMMEDIATELY BEFORE THE CLICK, FROM THE PEER'S OWN COUNT. This is the fix for the OPEN
    // observation, and it is a measurement fix rather than a prose one: `completions().at(-1)` answers "which
    // completion was last when I looked", which is not the same question as "which completion did MY send produce".
    // Any request that arrives later -- a helper extension's `generateRaw`, a quiet/title completion -- is captured by
    // the first question and not by the second. The click is what issues the request (q20-leg-runtime.mjs:118-119
    // records the same hazard for the reply ordinal), so the peer's count taken at that instant is the attribution.
    const resumedOrdinal = completions().length + 1;
    report.browser.resumedTurn = {
        armedOrdinal: resumedOrdinal,
        peerCompletionsBeforeTheClick: resumedOrdinal - 1,
    };
    const sentResumed = await sendTurn(page, MARKERS.resumed);
    let resumedSettled = { ok: false, state: null };
    if (sentResumed?.clicked === true) {
        resumedSettled = await waitForReply(page, {
            timeoutMs: 90000, requireText: true,
            peerCompletions: resumedOrdinal,
            baseline: sentResumed.baseline ?? { chatLength: reopened.chatLength, lastTextLength: 0 },
        });
    }
    report.browser.resumedTurn.sent = sentResumed;
    report.browser.resumedTurn.settled = resumedSettled;
    report.browser.resumedTurn.peerCompletionsAfterTheClick = completions().length;
    step('restart-took-another-turn', sentResumed?.clicked === true && resumedSettled.ok === true,
        resumedSettled.ok === true ? JSON.stringify(resumedSettled.state) : JSON.stringify({ sent: sentResumed, settled: resumedSettled }));

    // THE SEND'S OWN REQUEST, BY ORDINAL. Not `.at(-1)`: that is what the OPEN observation measured, and it cannot
    // distinguish this request from a later one.
    const resumedCompletion = completions()[resumedOrdinal - 1] ?? null;
    const resumeClassification = report.promptOrder.restartClassification ?? classifyPromptOrder(report.promptOrder.restart);
    let resumedMessages = [];
    try { resumedMessages = JSON.parse(resumedCompletion?.body ?? '{}').messages ?? []; } catch { resumedMessages = []; }
    // THE RESTORED HISTORY IS WHAT THE REQUEST CARRIED: the two user turns the drive phase wrote must appear in the
    // body, byte for byte. That is the assertion a "the page showed the right thing but the prompt was assembled from
    // somewhere else" defect cannot survive.
    report.browser.resumedTurn.request = resumedCompletion === null ? null : {
        ordinal: resumedOrdinal,
        // `index` keeps the field name the existing comparator guard reads; it is the peer ordinal, 1-based.
        index: resumedOrdinal,
        method: resumedCompletion.method,
        path: resumedCompletion.path,
        bodySha256: resumedCompletion.sha256,
        byteLength: resumedCompletion.byteLength,
        messageCount: Array.isArray(resumedMessages) ? resumedMessages.length : null,
        roles: Array.isArray(resumedMessages) ? resumedMessages.map(message => message?.role ?? null) : [],
        carriesFirstTurnMarker: resumedCompletion.body.includes(MARKERS.turn1),
        carriesSecondTurnMarker: resumedCompletion.body.includes(MARKERS.turn2),
        carriesRestoredReplies: restoredReplies.every(entry => resumedCompletion.body.includes(entry.text)),
        // THE TYPED TURN ITSELF. With `chatHistory` omitted from the runtime order, `populateChatHistory` returns
        // before adding ANY message (openai.js:885-888), so the user's own text is legitimately absent too -- and that
        // fact is what separates "history was dropped by the product" from "this preset does not send history".
        carriesResumedUserMarker: resumedCompletion.body.includes(MARKERS.resumed),
    };
    report.browser.resumedTurn.classification = resumeClassification;
    step('restart-resumed-request-attributed-to-the-send',
        sentResumed?.clicked === true && resumedSettled.ok === true
        && resumedCompletion !== null && report.browser.resumedTurn.request?.ordinal === resumedOrdinal,
        JSON.stringify({
            armedOrdinal: resumedOrdinal,
            foundAtOrdinal: report.browser.resumedTurn.request?.ordinal ?? null,
            peerCompletionsBeforeTheClick: report.browser.resumedTurn.peerCompletionsBeforeTheClick,
            peerCompletionsAfterTheSettle: report.browser.resumedTurn.peerCompletionsAfterTheClick,
        }));
    // THE ASSERTION IS CONDITIONAL ON THE STRUCTURE, AND THE CONDITION IS RECORDED SO IT CAN NEVER BE A SILENT PASS.
    //   * the runtime row ENABLES chatHistory -> the resumed request MUST carry the restored history, both turns, every
    //     restored reply, AND the typed resumed turn itself, or this step is red by name;
    //   * the row OMITS/DISABLES it -> the request legitimately carries no RESTORED HISTORY, and the SAME step requires
    //     the structural classification to say so (not merely the absence). MEASURED on the derived control: the typed
    //     user turn CAN still reach the model through another enabled preset prompt (preset-a has one that carries the
    //     current input), so `carriesResumedUserMarker` is recorded as an observation and is NOT asserted in this arm;
    //     what the omission removes is the restored conversation. Byte equality with pinned is the comparator's job and
    //     is required for both arms.
    const requiresHistory = resumeClassification?.historyExpected === true;
    const carriesHistory = report.browser.resumedTurn.request !== null
        && report.browser.resumedTurn.request.carriesFirstTurnMarker === true
        && report.browser.resumedTurn.request.carriesSecondTurnMarker === true
        && report.browser.resumedTurn.request.carriesRestoredReplies === true
        && report.browser.resumedTurn.request.carriesResumedUserMarker === true;
    const structurallyOmitsHistory = resumeClassification?.historyExpected === false
        && report.browser.resumedTurn.request !== null
        && report.browser.resumedTurn.request.carriesFirstTurnMarker === false
        && report.browser.resumedTurn.request.carriesSecondTurnMarker === false
        && report.browser.resumedTurn.request.carriesRestoredReplies === false;
    step('restart-resumed-request-satisfies-its-prompt-order',
        report.browser.resumedTurn.request !== null && (requiresHistory ? carriesHistory : structurallyOmitsHistory),
        JSON.stringify({ requiresHistory, classification: resumeClassification, request: report.browser.resumedTurn.request }));

    // ---- THE RECORDED FAILURE MECHANISM, REPRODUCED ON PURPOSE ------------------------------------------------
    // A helper/extension "quiet" completion after the send. `generateRaw` is the frontend's own entry
    // (public/script.js:4122), and a one-system-message prompt is the shape the OPEN observation recorded. With the
    // probe's previous `.at(-1)` selection this request would have been captured as the resumed turn; the ordinal
    // attribution above cannot. The request is made through the product's own route on BOTH subjects, so it is also a
    // parity observation rather than a synthetic one.
    report.helperRequest = { injected: false };
    if (helperAfterSend) {
        const helperOrdinal = completions().length + 1;
        const helperCall = await page.evaluate(async marker => {
            const script = await import('./script.js');
            try {
                const startedAt = Date.now();
                const data = await script.generateRaw({ prompt: [{ role: 'system', content: marker }], api: 'openai' });
                return { ok: true, elapsedMs: Date.now() - startedAt, returned: data === null ? 'null' : typeof data };
            } catch (error) {
                return { ok: false, error: String(error?.message ?? error) };
            }
        }, HELPER_MARKER);
        const helperDeadline = Date.now() + 30000;
        while (Date.now() < helperDeadline && completions().length < helperOrdinal) {
            await page.waitForTimeout(100);
        }
        const helperCompletion = completions()[helperOrdinal - 1] ?? null;
        let helperMessages = [];
        try { helperMessages = JSON.parse(helperCompletion?.body ?? '{}').messages ?? []; } catch { helperMessages = []; }
        report.helperRequest = {
            injected: true,
            armedOrdinal: helperOrdinal,
            call: helperCall,
            received: helperCompletion !== null,
            peerCompletionsAtCapture: completions().length,
            request: helperCompletion === null ? null : {
                ordinal: helperOrdinal,
                bodySha256: helperCompletion.sha256,
                byteLength: helperCompletion.byteLength,
                messageCount: helperMessages.length,
                roles: helperMessages.map(message => message?.role ?? null),
                isSingleSystemMessage: helperMessages.length === 1 && helperMessages[0]?.role === 'system',
                carriesHelperMarker: helperCompletion.body.includes(HELPER_MARKER),
                carriesRestoredMarkers: [MARKERS.turn1, MARKERS.turn2, MARKERS.resumed].some(marker => helperCompletion.body.includes(marker)),
            },
        };
        step('helper-completion-has-the-recorded-shape',
            helperCompletion !== null
            && report.helperRequest.request.isSingleSystemMessage === true
            && report.helperRequest.request.carriesHelperMarker === true
            && report.helperRequest.request.carriesRestoredMarkers === false,
            JSON.stringify(report.helperRequest));
        // THE MECHANISM, NAMED: the send's request and the helper's request are DIFFERENT requests, and the send's is
        // the one at the armed ordinal. This is the fact the old selection could not express.
        step('helper-completion-is-not-attributed-to-the-send',
            helperCompletion !== null
            && report.browser.resumedTurn.request !== null
            && report.helperRequest.armedOrdinal !== resumedOrdinal
            && report.helperRequest.request.bodySha256 !== report.browser.resumedTurn.request.bodySha256
            && report.browser.resumedTurn.request.ordinal === resumedOrdinal,
            JSON.stringify({ resumed: { ordinal: resumedOrdinal, sha256: report.browser.resumedTurn.request?.bodySha256 ?? null }, helper: { ordinal: helperOrdinal, sha256: report.helperRequest.request?.bodySha256 ?? null } }));
    }

    await saveConditional(page);
    await settleQuiet(page, recorder, { quietMs: 500, maxMs: 8000 });
    const finalDisk = await readDisk();
    report.disk.final = finalDisk;
    report.browser.final = await readPageState();
    step('restart-persisted-the-new-turn', (finalDisk.chat?.messageCount ?? 0) >= reopened.chatLength + 2,
        JSON.stringify({ before: reopened.chatLength, after: finalDisk.chat?.messageCount ?? null, file: finalDisk.chat?.file ?? null }));
    // THE DISCRIMINATOR IS STILL THERE AFTER A RESTART, which is what lets the comparator require the two subjects to
    // differ on disk while every compared provider body agreed.
    const swipesAtRestart = (finalDisk.chat?.messages ?? []).flatMap(message => message.rawSwipes ?? []);
    step('restart-still-holds-the-per-subject-discriminator',
        replyPrefix === '' || swipesAtRestart.some(text => String(text).includes(replyPrefix)),
        JSON.stringify({ replyPrefix, swipes: swipesAtRestart.map(text => String(text).slice(0, 40)) }));
}
