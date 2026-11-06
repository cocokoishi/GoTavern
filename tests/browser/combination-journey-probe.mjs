// COMBINATION JOURNEY — ONE SESSION, ONE USER, EVERY KNOB AT ONCE, BOTH SUBJECTS.
//
// GOAL §9 names this as the highest-priority scenario: character × complex preset × 酒馆助手 × world book × chat
// history × preset/chat/character variables × regex × Quick Replies × generation × streaming. Every ingredient has
// its own probe today (preset-semantics, worldinfo-slots, regex, helper-state, group-chat, q20 persistence, q21
// hand-back) and NO TWO OF THEM SHARE A RUNTIME. This probe is the shared session: it boots ONE server over ONE
// staged tree, drives the unmodified pinned frontend through all of it in one browsing context, and records the
// provider requests, the browser state and the disk state at every step. A second invocation (`--after-restart`)
// boots a NEW process over the SAME tree; a third (`--handback` under run-against-pinned) hands the Go-written tree
// to pinned Node, which must read the journey's chat and continue it.
//
// THE STEPS, in journey order, each recorded as a named step:
//   1. card staged from the committed derivation (image chunks only) + fresh install + character opened through the
//      frontend's own roster and a chat started (the pinned frontend's own click path);
//   2. a committed complex preset derivation planted and SELECTED through the frontend's preset control; a complex
//      world book selected through the persisted selection path (settings.world_info.globalSelect); author's note
//      set through the frontend's authors-note module; chat/global/character variables written through the pinned
//      酒馆助手 bridge and injected into the prompt; a Quick Reply created through the extension's published API and
//      EXECUTED; a CHARACTER-SCOPED regex stored in the card's V3 extension payload;
//   3. a STREAMED generation (recording peer answers SSE) with the exact request bytes captured;
//   4. a second turn proving the first reply (as regex-rewritten and stored) is in the history;
//   5. swipe / regenerate / continue / branch, each followed by its own captured request;
//   6. knob-off control turns inside the SAME session: preset switched to the fresh-install default, world info
//      de-selected, variables deleted -- so the harness can prove its captures MOVE when the knobs move (AGENTS 50);
//   7. save + page reload + a turn after the reload; then a group chat turn (multi-character) in the same session,
//      then back to the 1:1 chat for the final turn;
//   8. `--after-restart`: NEW process over the SAME tree, open the journey's chat, a turn proving preset/WI/vars/
//      history/QR/regex survived;
//   9. `--handback`: pinned Node (via run-against-pinned.mjs) over the GoTavern-written tree: reads the journey chat,
//      continues it, saves it. The comparator requires the hand-back leg's own steps and the continued marker.
//
// WHAT IS NOT CLAIMED, recorded in the report and the comparator: a real provider (the peer answers with markers,
// AGENTS 22); multi-user; a real user's card/preset prose (committed derivations only, AGENTS 56); text-completion
// instruct/context templates do not enter a chat-completion request (they are recorded from the preset file, not
// claimed on the wire); the group turn's multi-member fan-out is recorded as however many requests the product made.
//
// Usage:
//   node tests/browser/combination-journey-probe.mjs --data-root <tree> --report <json> [--nonce <shared>]
//   node tests/browser/combination-journey-probe.mjs --data-root <tree> --report <json> --profile e03e04 --tier fast|medium|full [--seed <s>] [--extension-tier fast|medium|full]
//   node tests/browser/run-against-pinned.mjs combination-journey-probe.mjs -- --data-root <tree> --report <json> --handback
// The GoTavern restart leg is the same command with --after-restart. `--profile e03e04` stages the generated
// E03+E04 profile (120-block class preset, three world books incl. a card-embedded one, 22 pinned extensions) and
// records the ordered marker manifest; with the flag absent the legacy journey above runs unchanged.

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { argumentValue, bootSubject, freePort, startCapturePeer, waitForServer } from './q20-leg-runtime.mjs';
import {
    configureConnection, openCharacter, openPage, pressContinue, pressRegenerate, readChatFiles,
    saveConditional, sendTurn, silenceAndObserve, waitForReply,
} from './q20-persistence-drive.mjs';
import { ensurePinnedExtensionInstalled, describeInstalledExtension } from './install-pinned-extension.mjs';
import { pinnedExtension } from './pinned-extensions.mjs';
import { readHelperApiSurface } from './extensions/helper-vars-kit.mjs';
import {
    CARD, GLOBAL_PROMPT_ORDER_DUMMY_ID, JOURNEY, STAGED_PROMPT_ORDER_REASON, chatCarrying, chatProjection,
    readChatFiles as readJourneyChats, readSettings,
    stageJourneyCard, stageJourneyGroups, stageJourneyWorldBook, stagedPresetDocument, validateStagedPreset,
} from './extensions/combination-journey-kit.mjs';
import { MARKERS as WI_MARKERS, extractLayout } from './worldinfo-slots-kit.mjs';
import { applyAuthorsNoteOverlay, authorsNoteOverlaySpec, resolveAuthorsNoteCase } from './preset-kit.mjs';
import {
    buildProfile as buildE03E04Profile,
    canonicalJson as canonicalE03E04Json,
    documentBytes as e03e04DocumentBytes,
    sha256 as e03e04Sha256,
    TIERS as E03E04_TIERS,
} from './extensions/e03e04-profile-kit.mjs';
import { EXTENSION_TIERS, extensionBatchRecord, installExtensionBatch } from './extensions/extension-install-batch.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

const dataRoot = path.resolve(argumentValue(process.argv, '--data-root') ?? '');
if (!argumentValue(process.argv, '--data-root')) {
    console.error('usage: node combination-journey-probe.mjs --data-root <tree> --report <json> [--profile e03e04 --tier fast|medium|full] [--after-restart|--handback]');
    process.exit(2);
}
const reportPath = path.resolve(argumentValue(process.argv, '--report') ?? path.join(here, 'combination-journey-report.json'));
const handback = process.argv.includes('--handback');
const afterRestart = process.argv.includes('--after-restart');
const phase = handback ? 'handback' : (afterRestart ? 'restart' : 'drive');
const external = Boolean(process.env.PROBE_BASE_URL);
if (external && !handback) {
    // The pinned DRIVE leg is the same probe under run-against-pinned.mjs, without --handback.
}
const subject = external ? 'pinned' : 'gotavern';
const nonce = argumentValue(process.argv, '--nonce') ?? 'comb';
const JOURNEY_WORLD = 'wi-slots-probe';

// =================================================================================================================
// E03+E04 PROFILE MODE (`--profile e03e04`).
//
// With the flag ABSENT this probe behaves exactly as it did before this mode existed: the committed preset-a
// derivation, the journey's own 3-slot book, the tavern-helper install, and the same 9-step journey. The flag only
// ADDS ingredients and profile-specific steps; it never changes a legacy step, a capture case name, or the report
// shape a legacy leg already wrote (`e03e04`, `extensions`, `identity` are new nullable members).
//
// WHAT THE MODE DOES (design sections 3-6; task-14):
//   * stages `buildProfile({seed, blockCount: TIERS[tier], tier})` BEFORE the page can read its lists: the preset
//     into `default-user/OpenAI Settings/`, the three-slot + recursive book documents into `default-user/worlds/`,
//     the settings patch merged into `settings.json`, and the card-embedded `character_book` payload into the
//     journey card's PNG through `combination-journey-kit.mjs` (which owns the tEXt staging);
//   * installs the tier's pinned extensions before boot through the ONE extracted batch helper;
//   * after boot it re-asserts the profile world-info settings through the product's own
//     `updateWorldInfoSettings`, selects the journey + profile books, imports the embedded book through the
//     product's own `checkEmbeddedWorld` path, and selects the preset through `#settings_preset_openai`;
//   * puts the profile's activation trigger tokens into the first user message (world-info activation needs them
//     in the scanned chat);
//   * RECORDS `expectedOrder` (and every staged document's digest) beside the leg in `report.e03e04`; it does NOT
//     assert the marker contract in the probe -- the comparator does (task-14 split).
// The record file `<dataRoot>/default-user/e03e04-profile.record.json` is written by the drive leg and READ BACK by
// the restart/hand-back legs, so they assert the SAME manifest the drive staged, with its digest re-verified.
// =================================================================================================================

const profileArgument = argumentValue(process.argv, '--profile');
if (profileArgument !== null && profileArgument !== 'e03e04') {
    console.error(`unsupported --profile ${JSON.stringify(profileArgument)}; supported: e03e04 (omit the flag for the legacy journey)`);
    process.exit(2);
}
const profileMode = profileArgument;
const tierArgument = profileMode ? (argumentValue(process.argv, '--tier') ?? 'full') : null;
if (profileMode && !Object.hasOwn(E03E04_TIERS, tierArgument)) {
    console.error(`unsupported --tier ${JSON.stringify(tierArgument)}; supported: ${Object.keys(E03E04_TIERS).join(', ')}`);
    process.exit(2);
}
// The extension tier follows the block tier by default (fast 3 / medium 10 / full 22); a caller may narrow it
// INDEPENDENTLY for triage, and the artifact records the value that actually ran.
const extensionTierArgument = profileMode ? (argumentValue(process.argv, '--extension-tier') ?? tierArgument) : null;
if (profileMode && !Object.hasOwn(E03E04_TIERS, extensionTierArgument)) {
    console.error(`unsupported --extension-tier ${JSON.stringify(extensionTierArgument)}; supported: ${Object.keys(E03E04_TIERS).join(', ')}`);
    process.exit(2);
}
const seedArgument = profileMode ? (argumentValue(process.argv, '--seed') ?? 'e03e04-alpha16') : null;
// TRIAGE MODE: stage the profile documents + record, skip the extension install and the boot. It exists so the
// staging path can be exercised by `node` alone (no browser, no pinned server, no network); the CI gate never passes
// it, and a leg recorded with it is not a journey leg (`report.stagingOnly = true`).
const stageOnly = process.argv.includes('--stage-only');
if (stageOnly && !profileMode) {
    console.error('--stage-only requires --profile e03e04');
    process.exit(2);
}
const PROFILE_PRESET_NAME = 'e03e04-profile';
const PROFILE_RECORD_FILE = 'e03e04-profile.record.json';
// THE GLOBAL PROMPT-ORDER CHARACTER ID IS 100001, NOT THE KIT'S 100000, AND THIS IS THE DISPATCH-DISCOVERED ROOT
// CAUSE OF THE PRESET NOT APPLYING. The implementation and its assertion live in the JOURNEY KIT
// (`combination-journey-kit.mjs`: `GLOBAL_PROMPT_ORDER_DUMMY_ID`, `stagedPresetDocument`, `validateStagedPreset`)
// because they are pure and must be checkable by `node` alone; the source chain is:
//   * `PromptManager.js:312-339` gives the PromptManager CLASS the configuration default `promptOrder.dummyId: 100000`,
//     and `PromptManager.js:1006-1015` (sanitizeServiceSettings) injects `promptManagerDefaultPromptOrder` for the
//     ACTIVE character when its order row has length 0;
//   * `openai.js:696-699` (setupChatCompletionPromptManager) OVERRIDES that default with `dummyId: 100001`, and
//     `script.js:7869` constructs the prompt manager with `oai_settings`, so `activeCharacter.id` is 100001;
//   * `PromptManager.js:1207-1212` (getPromptOrderForCharacter) matches `String(list.character_id) === String(character.id)`,
//     so a staged row keyed 100000 is INVISIBLE to the live prompt manager. `sanitizeServiceSettings` then injected the
//     DEFAULT 11-prompt order, which is exactly what dispatch 42173399186 recorded:
//     `{"promptCount":11,"identifiers":["main","worldInfoBefore",...],"activeCharacter":{"id":100001}}`.
// The staged preset carries an ACTIVE row for 100001 in addition to the kit's row (a frontend-saved preset can carry
// several character rows; committed preset-a.json carries 100000 AND 100001). The M1 kit is NOT edited; the
// transformation is applied to the staged bytes by the probe and recorded with its reason.
// The prompt-manager marker needle the "armed" wait counts. Legacy prompt contents carry the derivation's `MARK_`
// tokens; the profile's blocks carry `MARKER_Pxxxx`. Passing the needle explicitly keeps BOTH paths strong (a wait
// that counted nothing would call any page armed).
const ARMED_MARKER_NEEDLE = profileMode ? 'MARKER_P' : 'MARK_';
// Filled by the drive staging block (and reconstructed from the record file on the restart/hand-back phases).
let profileContext = null;
const profileWorldNames = () => (profileContext
    ? [profileContext.built.books.threeSlot.name, profileContext.built.books.recursiveGlobal.name]
    : []);

const report = {
    schemaVersion: 1,
    question: 'Does the full combination journey (card × complex preset × world book × variables × QR × character regex × streaming × verbs × reload × restart × group turn) produce the same provider requests, browser state and durable chat on pinned Node and GoTavern in ONE session, and does pinned Node continue the GoTavern-written chat?',
    phase,
    subject,
    nonce,
    steps: [],
    requests: [],
    captures: [],
    browser: {},
    disk: {},
    fixture: {},
    // Profile-mode records. All THREE are new optional members: a legacy leg leaves them null and the comparator's
    // profile guards simply do not exist for it (profile guards are created only for a profile pair).
    e03e04: null,
    extensions: null,
    identity: null,
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    console.error(`[${subject}/${phase}] ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${JSON.stringify(detail).slice(0, 900)}`}`);
    return ok;
}

function sha256(buffer) {
    return createHash('sha256').update(buffer).digest('hex');
}

// `peer` may legitimately be null when a SEQUENCE BEFORE BOOT fails (or in `--stage-only` triage): the finally block
// still writes a report, and a summary that threw inside the finally would replace the real failure with a TypeError.
const peerRequests = () => (peer ? peer.requests : []).filter(entry => /chat\/completions/.test(entry.path ?? ''));
const completionsFrom = index => peerRequests().slice(index);
let peer = null;
let browser = null;
let server = null;
// Literal substrings read from the PLANTED preset document, so "the preset reached the request" names pieces of
// the file this run wrote rather than strings written into this probe.
let presetSignatures = [];

async function waitForCondition(page, predicate, { label, timeoutMs = 90000, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await page.evaluate(predicate).catch(error => ({ __evaluateError: String(error?.message ?? error) }));
        if (last && last.ok === true) return { ok: true, waitedMs: timeoutMs - (deadline - Date.now()), value: last };
        await page.waitForTimeout(intervalMs);
    }
    return { ok: false, label, last, waitedMs: timeoutMs };
}

async function waitForPeerRequests(page, count, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (peerRequests().length >= count) return true;
        await page.waitForTimeout(150);
    }
    return false;
}

/**
 * Write the three scoped variables through the pinned 酒馆助手 bridge and inject the values, then read them back.
 * Used at the start of the armed journey and AGAIN after the reload and the restart: an injected floating prompt
 * lives in the page's memory, so a fresh page needs the helper to run again -- which is exactly what an installed
 * helper script does on load. The VARIABLES themselves are what must survive; the injection is the observable.
 */
async function injectVariablesThroughHelper(page) {
    const helperScript = `
        (async () => {
            const cfg = window.parent.__comb;
            if (!cfg) {
                // AUTO-RUN ON PAGE LOAD: the installed tree re-runs without an injection payload. Record that fact and
                // do nothing -- an injected payload is the only thing that may write variables or prompts.
                window.__combDone = { runId: 'auto-run-on-load', cases: [], errors: [], closure: { insideIframe: window !== window.parent, bridge: Boolean(window.TavernHelper) }, readback: null, skipped: 'no injection payload' };
                return;
            }
            const out = { runId: cfg.runId, cases: [], errors: [], closure: null, readback: null };
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const done = () => { window.__combDone = out; };
            try {
                const H = window.TavernHelper || window.parent.TavernHelper;
                out.closure = { insideIframe: window !== window.parent, bridge: !!H };
                H.insertOrAssignVariables({ comb_chat_var: cfg.chat }, { type: 'chat' });
                H.insertOrAssignVariables({ comb_global_var: cfg.global }, { type: 'global' });
                H.insertOrAssignVariables({ comb_character_var: cfg.character }, { type: 'character' });
                await sleep(400);
                const parts = [];
                for (const type of ['chat', 'global', 'character']) {
                    const value = H.getVariables({ type });
                    const keys = Object.keys(value || {}).filter(key => key.indexOf('comb_') === 0).sort();
                    parts.push('COMB_VAR_' + type.toUpperCase() + '[' + type + ']=' + keys.map(key => key + '=' + JSON.stringify(value[key])).join(';'));
                }
                out.readback = parts;
                await H.injectPrompts([{ id: 'comb-journey-vars', content: parts.join(' ') }]);
                out.cases.push({ name: 'variables-written', applied: true });
            } catch (error) { out.errors.push(String(error && error.message || error)); }
            return done();
        })();
    `;
    const runId = `comb-helper-${Date.now()}-${Math.floor(Math.random() * 1000)}`;
    const payload = { runId, chat: 'COMB_CHAT_VAR_MARKER', global: 'COMB_GLOBAL_VAR_MARKER', character: 'COMB_CHARACTER_VAR_MARKER' };
    await page.evaluate(item => {
        window.__comb = item.payload;
        window.__combDone = null;
        window.TavernHelper.replaceScriptTrees([{ type: 'script', enabled: true, name: item.runId, id: item.runId, content: item.content, button: { enabled: false, buttons: [] } }], { type: 'global' });
    }, { payload, runId, content: helperScript });
    const done = await waitForCondition(page, async () => {
        const found = [...document.querySelectorAll('iframe')].map(frame => { try { return frame.contentWindow?.__combDone ?? null; } catch { return null; } }).filter(Boolean);
        const record = found.find(entry => entry.runId === window.__comb?.runId) ?? null;
        return { ok: Boolean(record), done: record };
    }, { label: 'helper-variables', timeoutMs: 60000 });
    return { payload, done: done.value?.done ?? null, ok: done.ok === true && (done.value?.done?.errors ?? []).length === 0 };
}

/** Create the Quick Reply through the extension's published API and EXECUTE it (API path recorded). */
async function executeJourneyQuickReply(page) {
    return page.evaluate(async ({ setName, label, injection }) => {
        const api = globalThis.quickReplyApi;
        const preconditions = { published: Boolean(api) };
        if (!api) return { status: 'not-driven', preconditions };
        try {
            await api.createSet(setName).catch(() => { });
            await api.createQuickReply(setName, label, { message: `/inject id=comb-journey-qr position=0 depth=4 "${injection}"` });
            const set = api.getSetByName(setName);
            if (set && typeof set.save === 'function') await set.save();
            let via = null;
            if (typeof api.executeQuickReply === 'function') {
                await api.executeQuickReply(setName, label);
                via = 'api.executeQuickReply';
            } else {
                const buttons = [...document.querySelectorAll('.qr--button')];
                const button = buttons.find(entry => String(entry.textContent ?? '').includes(label));
                if (button) { button.click(); via = 'dom .qr--button click'; }
            }
            return { status: via ? 'driven' : 'not-driven', via, preconditions };
        } catch (error) { return { status: 'not-driven', preconditions, reason: String(error?.message ?? error).slice(0, 300) }; }
    }, { setName: JOURNEY.qrSet, label: JOURNEY.qrLabel, injection: JOURNEY.qrInjection });
}

async function readPageState(page) {
    return page.evaluate(async () => {
        const script = await import('./script.js');
        const context = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
        const chat = script.chat ?? [];
        return {
            ok: true,
            settingsReady: script.settingsReady === true,
            chatId: context?.chatId ?? null,
            isGroup: Boolean(context?.groupId) || Boolean(context?.selectedGroup),
            characterName: context?.name2 ?? context?.name ?? null,
            chatLength: chat.length,
            domMessages: document.querySelectorAll('#chat .mes').length,
            sequence: chat.map(entry => ({ role: entry?.is_user === true ? 'user' : 'assistant', text: String(entry?.mes ?? '') })),
            lastText: String(chat[chat.length - 1]?.mes ?? ''),
            lastSwipes: Array.isArray(chat[chat.length - 1]?.swipes) ? chat[chat.length - 1].swipes.map(String) : null,
            lastSwipeId: chat[chat.length - 1]?.swipe_id ?? null,
            isSendPress: script.is_send_press ?? null,
            streamingProcessor: Boolean(script.streamingProcessor),
        };
    });
}

/**
 * A BOUNDED QUIET WINDOW. A connection change, a verb, or a page load can leave a completion in flight; a send
 * issued inside that window is either refused or treated as a STOP (measured: a control turn whose send was
 * clicked but produced no request and no message, because CONTINUE was still streaming). The wait requires the
 * frontend's own idle flags AND no new peer request for `quietMs`, so the thing that follows starts from rest.
 */
async function waitForQuiet(page, { quietMs = 1800, maxMs = 60000 } = {}) {
    const started = Date.now();
    let lastCount = peerRequests().length;
    let quietSince = Date.now();
    while (Date.now() - started < maxMs) {
        const state = await page.evaluate(async () => {
            const script = await import('./script.js');
            return { isSendPress: script.is_send_press === true, streaming: Boolean(script.streamingProcessor) };
        }).catch(() => ({ isSendPress: true, streaming: true }));
        const count = peerRequests().length;
        if (count !== lastCount) { lastCount = count; quietSince = Date.now(); }
        const idle = state.isSendPress === false && state.streaming === false;
        if (idle && Date.now() - quietSince >= quietMs) return { ok: true, waitedMs: Date.now() - started };
        await page.waitForTimeout(150);
    }
    return { ok: false, waitedMs: Date.now() - started, lastCount };
}

/**
 * WAIT UNTIL THE TOKENIZER ANSWERS. A page that was just reloaded has no tokenizer model in memory; the first real
 * generation then throws inside prepareOpenAIMessages/populateChatCompletion, the catch leaves only the prompts it had
 * already added, and the request is a four-prompt skeleton with no chatHistory -- while a dry run 1.3 s later assembles
 * the full 39 messages on the same page (measured: reports jt1..jt5, both subjects). That is a harness precondition a
 * real user reaches by simply not clicking within a few hundred milliseconds, so the journey WAITS and asserts it
 * explicitly instead of sending into a cold tokenizer.
 */
async function waitForTokenizerReady(page, { maxMs = 30000 } = {}) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < maxMs) {
        const state = await page.evaluate(async () => {
            try {
                const tokenizers = await import('./scripts/tokenizers.js');
                // script.js IMPORTS getTokenCountAsync but does not re-export it (public/script.js:234), so calling it
                // through script.js threw "not a function" for 30 s and the step reported a cold tokenizer that was
                // actually a wrong import path. Ask the module that owns it.
                const count = await tokenizers.getTokenCountAsync('COMB_TOKENIZER_WARMUP');
                return { ok: Number.isFinite(count), count };
            } catch (error) { return { ok: false, error: String(error?.message ?? error).slice(0, 160) }; }
        }).catch(error => ({ ok: false, error: String(error?.message ?? error).slice(0, 160) }));
        if (state.ok) return { ok: true, waitedMs: Date.now() - started, count: state.count };
        last = state;
        await page.waitForTimeout(100);
    }
    return { ok: false, waitedMs: maxMs, last };
}


/**
 * Re-apply the recording-peer connection. A PRESET carries provider settings; selecting one can overwrite the custom
 * URL/model this harness configured, and a send then sets the frontend's busy flag and aborts before any request
 * (measured: clicked send, no request, no message, later verbs swallowed as stops). Every preset change in this
 * journey is followed by this call, which is also what a user would do: point the page back at the provider.
 */
async function applyConnectionState(page, peerURL) {
    const connected = await configureConnection(page, { url: peerURL, model: 'comb-journey-model' });
    await page.evaluate(async () => {
        const openai = await import('./scripts/openai.js');
        openai.oai_settings.stream_openai = true;
        // THE CONTEXT MUST HOLD THE DERIVED PRESET. This used to be 8192 context / 512 completion, which is
        // SMALLER than the committed complex preset's prompt mass: the derivation preserves byte length by
        // replacing prose with CJK markers, and the GPT tokenizer charges a CJK character roughly two tokens, so
        // the 105 prompts are ~25k tokens. With a 7680-token budget the assembly throws inside
        // populateChatCompletion and the catch leaves only the four prompts added before the throw -- the
        // 11864-byte four-prompt skeleton with no chatHistory, on BOTH subjects. The real preset declares
        // openai_max_context 2000000, so the cap now matches the fixture's own frame rather than truncating it,
        // and the journey can measure the FULL assembly it exists to compare.
        const journeyPresetContext = 2000000;
        openai.oai_settings.openai_max_context = journeyPresetContext;
        openai.oai_settings.openai_max_tokens = 512;
    });
    const silence = await silenceAndObserve(page);
    return { connected, silence, streaming: true };
}

/**
 * SELECT THE WORLD BOOK THROUGH THE FRONTEND AFTER BOOT, and prove it reached the product's own persisted member.
 * The pre-boot settings.world_info.globalSelect write is overwritten by BOTH servers' boot (measured on pinned:
 * wiPersisted null, turn-1 slots 0). The live world-info module is the state the assembly reads; the disk member is
 * the state a reload restores from, so both are set and the disk one is polled (bounded) rather than assumed.
 */
async function selectWorldBookAfterBoot(page, dataRoot, worldName) {
    const saveSelection = () => page.evaluate(async wanted => {
        const script = await import('./script.js');
        const worldInfo = await import('./scripts/world-info.js');
        if (typeof worldInfo.getWorldInfoList === 'function') await worldInfo.getWorldInfoList();
        const names = Array.isArray(worldInfo.world_names) ? worldInfo.world_names.slice() : [];
        if (!names.includes(wanted)) return { ok: false, reason: 'the world book is not in world_names', names };
        if (!Array.isArray(worldInfo.selected_world_info)) worldInfo.selected_world_info = [];
        if (!worldInfo.selected_world_info.includes(wanted)) worldInfo.selected_world_info.push(wanted);
        if (worldInfo.world_info && typeof worldInfo.world_info === 'object') worldInfo.world_info.globalSelect = [wanted];
        if (typeof script.saveSettings === 'function') await script.saveSettings();
        else if (typeof script.saveSettingsDebounced === 'function') script.saveSettingsDebounced();
        return { ok: true, names, selected: worldInfo.selected_world_info.slice(), globalSelect: worldInfo.world_info?.globalSelect ?? null };
    }, worldName);
    const saveThroughProductPath = () => page.evaluate(async wanted => {
        const worldInfo = await import('./scripts/world-info.js');
        if (typeof worldInfo.getWorldInfoList === 'function') await worldInfo.getWorldInfoList();
        const names = Array.isArray(worldInfo.world_names) ? worldInfo.world_names.slice() : [];
        if (!names.includes(wanted)) return { ok: false, reason: 'the world book is not in world_names', names };
        // THE PRODUCT'S OWN PATH: it assigns selected_world_info = activeWorldInfo, deletes settings.world_info and
        // calls the module's saveSettingsDebounced (world-info.js:847-851).
        const settings = worldInfo.getWorldInfoSettings();
        worldInfo.updateWorldInfoSettings(settings, [wanted]);
        return { ok: true, names, selected: Array.isArray(worldInfo.selected_world_info) ? worldInfo.selected_world_info.slice() : null, mechanism: 'updateWorldInfoSettings + module saveSettingsDebounced' };
    }, worldName);
    let last = null;
    let persistedGlobalSelect = null;
    const deadline = Date.now() + 25000;
    let attempts = 0;
    while (Date.now() < deadline) {
        attempts += 1;
        last = await saveThroughProductPath();
        const settings = await readSettings(dataRoot);
        persistedGlobalSelect = settings.globalSelect ?? null;
        if (Array.isArray(persistedGlobalSelect) && persistedGlobalSelect.includes(worldName)) break;
        await page.waitForTimeout(500);
    }
    let fallbackDirectWrite = null;
    if (!(Array.isArray(persistedGlobalSelect) && persistedGlobalSelect.includes(worldName))) {
        // Recorded last resort: the documented persisted member itself (the same one `stageSelection` writes and the
        // page restores from at startup). It is written only after the product path failed to land, and it is named.
        const settingsPath = path.join(dataRoot, 'default-user', 'settings.json');
        const current = JSON.parse(await fs.readFile(settingsPath, 'utf8').catch(() => '{}'));
        current.world_info = { ...(current.world_info ?? {}), globalSelect: [worldName] };
        await fs.writeFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`);
        persistedGlobalSelect = [worldName];
        fallbackDirectWrite = { file: 'settings.json', member: 'world_info.globalSelect', reason: 'the frontend updateWorldInfoSettings save path did not reach disk within the bounded wait; recorded so the artefact shows the harness wrote the product member itself' };
    }
    return { ok: last?.ok === true, attempts, last, persistedGlobalSelect, fallbackDirectWrite };
}

// =================================================================================================================
// E03+E04 PROFILE HELPERS (used only when `--profile e03e04`). Kept together so the legacy path above is untouched.
// =================================================================================================================

/** Merge the profile kit's settings patch into `settings.json` BEFORE the page reads it (best effort; re-asserted after boot). */
async function mergeProfileSettingsAtRoot(dataRoot, patch) {
    const settingsPath = path.join(dataRoot, 'default-user', 'settings.json');
    let current = {};
    try {
        current = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    } catch {
        current = {};
    }
    const mergeInto = (target, source) => {
        for (const [key, value] of Object.entries(source)) {
            if (value && typeof value === 'object' && !Array.isArray(value) && target[key] && typeof target[key] === 'object' && !Array.isArray(target[key])) {
                target[key] = { ...target[key], ...value };
            } else {
                target[key] = value;
            }
        }
        return target;
    };
    mergeInto(current, patch);
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    await fs.writeFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`);
    return { file: 'settings.json', sha256: sha256(await fs.readFile(settingsPath)), members: Object.keys(patch) };
}

/**
 * STAGE THE PROFILE BEFORE BOOT (drive phase only). Writes, in the order a user's tree would hold them:
 *   1. the preset document into `OpenAI Settings/` (the directory the frontend lists at page load);
 *   2. the three-slot and recursive world-book documents into `worlds/`;
 *   3. the profile kit's settings patch into `settings.json`;
 *   4. the profile RECORD into `default-user/<record>.json`, which the restart/hand-back phases read back (the
 *      record carries `expectedOrder` and the digest of every staged document, so a later phase cannot silently
 *      judge against a different manifest).
 * The card (with the embedded `character_book`) is staged by the caller through the journey kit, which owns PNG
 * staging; this function returns the payload so the caller passes the SAME object.
 */
async function stageE03e04Profile(dataRoot) {
    const blockCount = E03E04_TIERS[tierArgument];
    const built = buildE03E04Profile({ seed: seedArgument, blockCount, tier: tierArgument });
    // THE STAGED DOCUMENT, NOT THE KIT DOCUMENT: the active prompt_order row must carry the id the live prompt
    // manager matches (100001). See GLOBAL_PROMPT_ORDER_DUMMY_ID for the source/dispatch evidence; the kit's own
    // digest is kept beside the staged digest so a reader can reproduce both.
    const document = stagedPresetDocument(built.preset);
    const shape = validateStagedPreset(document);
    if (shape.ok !== true) {
        throw new Error(`the staged preset does not satisfy the frontend contract: ${shape.problems.join('; ')}`);
    }
    const presetDirectory = path.join(dataRoot, 'default-user', 'OpenAI Settings');
    await fs.mkdir(presetDirectory, { recursive: true });
    const presetFile = path.join(presetDirectory, `${PROFILE_PRESET_NAME}.json`);
    await fs.writeFile(presetFile, e03e04DocumentBytes(document));
    const stagedPresetBytes = await fs.readFile(presetFile);

    const worldsDirectory = path.join(dataRoot, 'default-user', 'worlds');
    await fs.mkdir(worldsDirectory, { recursive: true });
    const books = {};
    for (const book of [built.books.threeSlot, built.books.recursiveGlobal]) {
        const file = path.join(worldsDirectory, `${book.name}.json`);
        // Canonical bytes for the staged document, so two runs of the same recipe stage byte-identical files.
        await fs.writeFile(file, `${JSON.stringify(book.document, null, 2)}\n`);
        books[book.name] = { file: `worlds/${book.name}.json`, sha256: sha256(await fs.readFile(file)) };
    }
    const settings = await mergeProfileSettingsAtRoot(dataRoot, built.settings);

    const record = {
        kind: 'e03e04-profile-record',
        schemaVersion: 1,
        profile: profileMode,
        tier: tierArgument,
        seed: seedArgument,
        blockCount,
        expectedOrderSha256: e03e04Sha256(canonicalE03E04Json(built.expectedOrder)),
        expectedOrder: built.expectedOrder,
        preset: {
            file: `OpenAI Settings/${PROFILE_PRESET_NAME}.json`,
            // `sha256` describes the STAGED bytes (what the page reads); `kitSha256` the unmodified kit document.
            sha256: sha256(stagedPresetBytes),
            kitSha256: e03e04Sha256(canonicalE03E04Json(built.preset)),
            promptOrderCharacterIds: shape.promptOrderCharacterIds,
            activePromptOrderCharacterId: shape.activeCharacterId,
            declaredPrompts: shape.declaredPrompts,
            activeOrderLength: shape.activeOrderLength,
            transformation: { kind: 'add-active-prompt-order-row', reason: STAGED_PROMPT_ORDER_REASON },
        },
        books,
        cardCharacterBook: {
            name: built.books.cardEmbedded.name,
            sha256: e03e04Sha256(canonicalE03E04Json(built.books.cardEmbedded.characterBook)),
            entries: built.books.cardEmbedded.characterBook.entries.length,
        },
        settingsPatch: {
            sha256: e03e04Sha256(canonicalE03E04Json(built.settings)),
            file: settings.file,
            stagedSha256: settings.sha256,
        },
        activation: built.books.activation,
        worldInfoSettings: built.books.worldInfoSettings,
        // The power_user half of the settings patch (stop strings + instruct/context templates). Recorded so a later
        // phase (or a boot that overwrote settings.json) can re-assert the SAME values the drive staged.
        powerUserPatch: built.settings.power_user,
        selection: built.books.selection,
        extensionTier: extensionTierArgument,
        manifest: built.manifest,
    };
    const recordPath = path.join(dataRoot, 'default-user', PROFILE_RECORD_FILE);
    await fs.writeFile(recordPath, `${JSON.stringify(record, null, 2)}\n`);
    return { built, record, recordFile: `default-user/${PROFILE_RECORD_FILE}`, presetShape: shape, stagedPreset: document };
}

/** Read the record a drive leg staged and RE-VERIFY its manifest digest; a mismatch is a named refusal, not a guess. */
async function readE03e04Record(dataRoot) {
    const recordPath = path.join(dataRoot, 'default-user', PROFILE_RECORD_FILE);
    let record = null;
    let error = null;
    try {
        record = JSON.parse(await fs.readFile(recordPath, 'utf8'));
    } catch (caught) {
        error = String(caught?.message ?? caught);
    }
    if (!record) return { verified: false, record: null, reason: `the profile record is missing or unreadable: ${error}` };
    if (record.kind !== 'e03e04-profile-record' || record.schemaVersion !== 1) return { verified: false, record, reason: 'the profile record has an unknown kind/schemaVersion' };
    const recomputed = e03e04Sha256(canonicalE03E04Json(record.expectedOrder));
    const verified = recomputed === record.expectedOrderSha256;
    // Restore the pieces the drive path keeps in memory, so later phases can reuse the same helpers.
    const fakeBuilt = { books: { threeSlot: { name: 'e03e04-book-a-three-slot' }, recursiveGlobal: { name: 'e03e04-book-c-recursive' } } };
    return { verified, record, reason: verified ? null : `expectedOrder sha256 ${recomputed} != recorded ${record.expectedOrderSha256}`, built: fakeBuilt };
}

/**
 * Re-assert the profile world-info settings and selection through the PRODUCT'S OWN settings path after boot.
 * The pre-boot `settings.json` write cannot be relied on (both servers' boot overwrites it; measured by the journey's
 * own single-world helper), so every profile claim about recursion/depth/selection is applied to the live module and
 * then polled on disk.
 */
async function applyProfileWorldInfoAfterBoot(page, { worldInfoSettings, worldNames }) {
    const applied = await page.evaluate(async ({ patch, worlds }) => {
        const worldInfo = await import('./scripts/world-info.js');
        if (typeof worldInfo.getWorldInfoList === 'function') await worldInfo.getWorldInfoList();
        const names = Array.isArray(worldInfo.world_names) ? worldInfo.world_names.slice() : [];
        const missing = worlds.filter(name => !names.includes(name));
        if (missing.length > 0) return { ok: false, reason: 'the world books are not in world_names', missing, names };
        const current = worldInfo.getWorldInfoSettings();
        // Only the members the profile actually declares are overlaid; `world_info` itself is the product's own
        // selection object and must not be replaced by the patch's copy.
        const next = { ...current, ...patch, world_info: current.world_info };
        worldInfo.updateWorldInfoSettings(next, worlds);
        return { ok: true, names, selected: Array.isArray(worldInfo.selected_world_info) ? worldInfo.selected_world_info.slice() : null };
    }, { patch: worldInfoSettings, worlds: worldNames });
    // Poll the product's persisted member the same way the legacy single-world helper does, with a named fallback.
    let persistedGlobalSelect = null;
    const deadline = Date.now() + 25000;
    while (Date.now() < deadline) {
        const settings = await readSettings(dataRoot);
        persistedGlobalSelect = settings.globalSelect ?? null;
        if (Array.isArray(persistedGlobalSelect) && worldNames.every(name => persistedGlobalSelect.includes(name))) break;
        await page.waitForTimeout(500);
    }
    let fallbackDirectWrite = null;
    if (!(Array.isArray(persistedGlobalSelect) && worldNames.every(name => persistedGlobalSelect.includes(name)))) {
        const settingsPath = path.join(dataRoot, 'default-user', 'settings.json');
        const current = JSON.parse(await fs.readFile(settingsPath, 'utf8').catch(() => '{}'));
        current.world_info = { ...(current.world_info ?? {}), globalSelect: worldNames };
        if (current.world_info_settings && typeof current.world_info_settings === 'object') {
            current.world_info_settings = { ...current.world_info_settings, world_info: { ...(current.world_info_settings.world_info ?? {}), globalSelect: worldNames } };
        }
        await fs.writeFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`);
        persistedGlobalSelect = worldNames;
        fallbackDirectWrite = { file: 'settings.json', member: 'world_info.globalSelect', reason: 'the frontend updateWorldInfoSettings save path did not reach disk within the bounded wait; recorded so the artefact shows the harness wrote the product member itself' };
    }
    return { ok: applied.ok === true, applied, persistedGlobalSelect, fallbackDirectWrite, worlds: worldNames };
}

/** Profile-mode world selection: the journey's book PLUS both profile books, in one product-path call. */
async function selectJourneyWorlds(page, dataRoot) {
    if (!profileMode) return selectWorldBookAfterBoot(page, dataRoot, JOURNEY_WORLD);
    const worldNames = [JOURNEY_WORLD, ...profileWorldNames()];
    return applyProfileWorldInfoAfterBoot(page, {
        worldInfoSettings: profileContext.record.worldInfoSettings,
        worldNames,
    });
}

/** True when a selection covers every world this join/mode claims (legacy: the journey book; profile: plus both). */
function worldSelectionCovers(selection) {
    const persisted = selection?.persistedGlobalSelect ?? selection?.globalSelect ?? null;
    const required = profileMode ? [JOURNEY_WORLD, ...profileWorldNames()] : [JOURNEY_WORLD];
    return Array.isArray(persisted) && required.every(name => persisted.includes(name));
}

/**
 * Re-assert the power_user half of the profile patch (custom stop strings, instruct/context templates) after boot.
 * The pre-boot `settings.json` merge cannot be assumed (the boot seeds/rewrites it), and the stop strings DO reach a
 * chat-completion request (`openai.js:2814` getCustomStoppingStrings), so they are written through the product's own
 * `power_user` module before the armed turn.
 */
async function applyProfilePowerUserAfterBoot(page, patch) {
    if (!patch) return { ok: false, reason: 'the record carries no power_user patch' };
    return page.evaluate(async wanted => {
        const powerUser = await import('./scripts/power-user.js');
        const script = await import('./script.js');
        powerUser.power_user.custom_stopping_strings = wanted.custom_stopping_strings;
        powerUser.power_user.custom_stopping_strings_macro = wanted.custom_stopping_strings_macro === true;
        if (wanted.instruct) powerUser.power_user.instruct = { ...(powerUser.power_user.instruct ?? {}), ...wanted.instruct };
        if (wanted.context) powerUser.power_user.context = { ...(powerUser.power_user.context ?? {}), ...wanted.context };
        if (typeof script.saveSettingsDebounced === 'function') script.saveSettingsDebounced();
        return {
            ok: true,
            custom_stopping_strings: powerUser.power_user.custom_stopping_strings,
            custom_stopping_strings_macro: powerUser.power_user.custom_stopping_strings_macro,
            instructEnabled: powerUser.power_user.instruct?.enabled ?? null,
            contextPreset: powerUser.power_user.context?.preset ?? null,
        };
    }, patch);
}

/**
 * PERSIST A VERB'S EFFECT THROUGH THE PRODUCT'S OWN "WRITE IT NOW", BEFORE ANY PAGE RELOAD (task-18).
 *
 * WHAT DISPATCH 42178757887 MEASURED: `Generate('continue')` ends with `saveReply({type:'appendFinal'})` and then only
 * `saveChatDebounced()` (script.js:7361) -- the q20 kit already documents this for its own leg. The journey probe
 * continues, creates a branch, then RELOADS the page (`resetPageAndReopen` -> `openPage`), which re-reads the chat
 * FILE. On GoTavern the debounced write had not landed, so the reloaded assistant message was `COMB_REGEX_OK_4`
 * instead of `COMB_REGEX_OK_4 COMB_REGEX_OK_5` (16 bytes) and every later request from that chat carried the loss;
 * pinned happened to flush first. The same race lost the GROUP chat file on pinned (the durable-chat projection had
 * 3 files on GoTavern, 2 on pinned). A real user's `saveChatConditional` (script.js:7407, "close the chat") is the
 * product's own write-it-now, and q20 uses it for exactly this reason. Using it is NOT a product concession: it
 * removes a harness race so both subjects are compared on the state each product actually persisted.
 *
 * The effect is then POLLED on disk (bounded): the named step fails if the text is not in any persisted chat file.
 */
async function persistChatEffect(page, dataRoot, { action, expectText }) {
    const wanted = String(expectText ?? '').trim();
    if (wanted.length === 0) return { ok: false, action, reason: 'no expected text to look for; the verb effect was empty' };
    const saved = await saveConditional(page);
    const deadline = Date.now() + 20000;
    let carriers = [];
    while (Date.now() < deadline) {
        const chats = await readJourneyChats(dataRoot);
        carriers = Object.entries(chats)
            .filter(([, file]) => (file?.messages ?? []).some(message => String(message?.mes ?? '').includes(wanted)
                || (Array.isArray(message?.swipes) && message.swipes.some(swipe => String(swipe).includes(wanted)))))
            .map(([name]) => name);
        if (carriers.length > 0) break;
        await page.waitForTimeout(300);
    }
    return { ok: saved?.ok === true && carriers.length > 0, action, expected: wanted.slice(0, 160), saved, filesCarrying: carriers };
}

/**
 * IMPORT THE CARD-EMBEDDED LOREBOOK THROUGH THE PRODUCT'S OWN PATH, INCLUDING THE BINDING THE DIALOG PATH DOES NOT DO.
 *
 * THE DISPATCH-42173399186 ROOT CAUSE (harness defect, not a product finding): the confirmation dialog's callback
 * (`world-info.js:5711-5716`) calls `importEmbeddedWorldInfo(true)`, which imports the world and sets the HIDDEN input
 * `#character_world` (`world-info.js:5757`) but never saves the character. The state `getCharacterLore` actually
 * reads is `characters[chid].data.extensions.world` (`world-info.js:4482`), which only changes when the character
 * editor is saved. The product's own "Import Card Lore" MENU handler performs exactly that follow-up
 * (`script.js:12363-12368`: `importEmbeddedWorldInfo(); saveCharacterDebounced();`), where
 * `saveCharacterDebounced = debounce(() => $('#create_button').trigger('click'))` (`script.js:471`) and
 * `createOrEditCharacter` posts the `#form_create` FormData - whose hidden `world` input is `#character_world`
 * (`index.html:6206`) - then reloads the character via `getOneCharacter`. The first version of this probe clicked the
 * dialog OK and required the binding, which the dialog path never performs. The dispatch showed the consequence: the
 * GoTavern leg happened to be bound by a timing coincidence (its body carried the 3 extra MARKER_WB markers) while the
 * pinned leg was not (`bound: ""`) - a HARNESS asymmetry that would have been a false product finding.
 *
 * The faithful flow: select the character through the editor-population path the dialog is normally opened from
 * (`select_selected_character`, `script.js:8762`, which populates `#form_create` and calls `checkEmbeddedWorld` at
 * `script.js:8811`), confirm the product dialog (or the product's fallback import), wait for the world to be listed,
 * assert the editor form IS populated before saving (saving an unpopulated form would overwrite the card the rest of
 * the journey measures - refuse by name instead), press the same Save the menu follow-up presses, wait for the
 * product's own effective binding, and close the editor. Every step and its evidence is recorded.
 */
async function importEmbeddedCardBookAfterBoot(page) {
    const prepared = await page.evaluate(async () => {
        const script = await import('./script.js');
        const chid = script.this_chid;
        const character = chid === undefined || chid === null ? null : (script.characters ?? [])[chid] ?? null;
        if (!character) return { ok: false, reason: 'no active character' };
        if (!character?.data?.character_book) return { ok: false, reason: 'the staged card carries no data.character_book', chid, name: character?.name ?? null };
        // The dialog is reached from the character editor; this is the product function that populates the editor form
        // for the character AND calls checkEmbeddedWorld(chid). Recorded either way (a throw is captured below).
        let editorSelection = { called: false };
        if (typeof script.select_selected_character === 'function') {
            try {
                script.select_selected_character(chid, { switchMenu: true });
                editorSelection = { called: true };
            } catch (error) {
                editorSelection = { called: true, threw: String(error?.message ?? error).slice(0, 200) };
            }
        }
        return { ok: true, chid: String(chid), name: character?.name ?? null, bookName: String(character.data.character_book.name ?? ''), editorSelection };
    });
    if (prepared.ok !== true) return { ...prepared, via: [] };

    const clickPopup = async (timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            const popup = await page.evaluate(() => {
                const button = document.querySelector('.popup .popup-button-ok') ?? document.querySelector('.popup-button-ok');
                if (!button) return { present: false };
                button.click();
                return { present: true };
            }).catch(() => ({ present: false }));
            if (popup.present) return true;
            await page.waitForTimeout(200);
        }
        return false;
    };

    const via = [];
    let dialog = { present: false, clicked: false };
    // (1) The dialog the editor-open path already raises (the product's own ask).
    dialog.present = await clickPopup(6000);
    if (dialog.present) {
        dialog.clicked = true;
        via.push('editor-open dialog confirm (checkEmbeddedWorld -> product confirm OK)');
    }
    // (2) If no dialog is present (already-acknowledged character, or the user setting shows a toast), ask the product
    //     to raise it; if the product answers "no dialog", call the exact function its confirm callback calls.
    let fallback = null;
    if (!dialog.present) {
        const triggered = await page.evaluate(async chid => {
            const worldInfo = await import('./scripts/world-info.js');
            return { opened: worldInfo.checkEmbeddedWorld(Number(chid)) === true };
        }, prepared.chid).catch(error => ({ opened: false, error: String(error?.message ?? error).slice(0, 200) }));
        dialog.present = await clickPopup(6000);
        if (dialog.present) {
            dialog.clicked = true;
            via.push('checkEmbeddedWorld -> product confirm OK');
        } else {
            const direct = await page.evaluate(async () => {
                const worldInfo = await import('./scripts/world-info.js');
                await worldInfo.importEmbeddedWorldInfo(true);
                return { called: true };
            }).catch(error => ({ called: false, error: String(error?.message ?? error).slice(0, 300) }));
            fallback = { triggered, direct };
            if (direct.called) via.push('importEmbeddedWorldInfo(true) (product function the dialog confirm calls)');
        }
    }
    dialog.trigger = fallback?.triggered ?? null;

    // (3) Import completion: the world is LISTED and the product set the hidden world input.
    const waited = { deadlineMs: 20000 };
    let importState = { listed: false, domWorld: null };
    const importDeadline = Date.now() + waited.deadlineMs;
    while (Date.now() < importDeadline) {
        importState = await page.evaluate(async name => {
            const worldInfo = await import('./scripts/world-info.js');
            const $ = globalThis.jQuery ?? null;
            if (typeof worldInfo.getWorldInfoList === 'function') await worldInfo.getWorldInfoList();
            const names = Array.isArray(worldInfo.world_names) ? worldInfo.world_names.slice() : [];
            return { listed: names.includes(name), names, domWorld: $ ? String($('#character_world').val() ?? '') : null };
        }, prepared.bookName).catch(error => ({ listed: false, error: String(error?.message ?? error).slice(0, 200) }));
        if (importState.listed === true) break;
        await page.waitForTimeout(250);
    }

    // (4) SAVE THROUGH THE SAME BUTTON THE PRODUCT'S MENU FOLLOW-UP PRESSES - but only from a POPULATED editor form:
    //     posting an unpopulated form would overwrite the staged card (description/personality/scenario) that the
    //     provider-request assertions measure. An unpopulated form is a NAMED harness failure, never a save.
    const save = await page.evaluate(async () => {
        const script = await import('./script.js');
        const $ = globalThis.jQuery ?? null;
        const chid = script.this_chid;
        const character = (script.characters ?? [])[chid] ?? null;
        if (!$) return { saved: false, reason: 'no jQuery on the page' };
        const actiontype = $('#form_create').attr('actiontype') ?? null;
        const formName = String($('#character_name_pole').val() ?? '');
        const formAvatar = String($('#avatar_url_pole').val() ?? '');
        const domWorld = String($('#character_world').val() ?? '');
        const populated = actiontype === 'editcharacter'
            && character !== null
            && formName === String(character?.name ?? '\u0000')
            && formAvatar === String(character?.avatar ?? '\u0000');
        const evidence = { populated, actiontype, formName, formAvatar, avatar: character?.avatar ?? null, name: character?.name ?? null, domWorld };
        if (!populated) return { saved: false, evidence, reason: 'the character editor form is not populated for this character; refusing to save it' };
        // `saveCharacterDebounced` (script.js:471) is a debounced `#create_button` click; triggering the click is the
        // same product action without a debounce delay.
        $('#create_button').trigger('click');
        return { saved: true, evidence, mechanism: 'createOrEditCharacter via #create_button click (saveCharacterDebounced target, script.js:471)' };
    }).catch(error => ({ saved: false, reason: String(error?.message ?? error).slice(0, 300) }));

    // (5) The product's own effective binding: characters[chid].data.extensions.world, the member getCharacterLore
    //     reads (world-info.js:4482). Bounded; both the bound value and the hidden input are recorded.
    let verified = { ok: false };
    const bindDeadline = Date.now() + 30000;
    while (Date.now() < bindDeadline) {
        verified = await page.evaluate(async name => {
            const script = await import('./script.js');
            const worldInfo = await import('./scripts/world-info.js');
            const $ = globalThis.jQuery ?? null;
            if (typeof worldInfo.getWorldInfoList === 'function') await worldInfo.getWorldInfoList();
            const names = Array.isArray(worldInfo.world_names) ? worldInfo.world_names.slice() : [];
            const chid = script.this_chid;
            const bound = String(script.characters?.[chid]?.data?.extensions?.world ?? '');
            return { ok: names.includes(name) && bound === name, names, bound, domWorld: $ ? String($('#character_world').val() ?? '') : null, name };
        }, prepared.bookName).catch(error => ({ ok: false, error: String(error?.message ?? error).slice(0, 200) }));
        if (verified.ok === true) break;
        await page.waitForTimeout(250);
    }

    // (6) Return the page to the chat context the rest of the drive expects (close the editor if it is open).
    const editorClosed = await page.evaluate(async () => {
        const $ = globalThis.jQuery ?? null;
        if (!$) return { closed: false, reason: 'no jQuery' };
        const cross = $('#character_cross');
        if (cross.length === 0) return { closed: false, reason: 'no #character_cross control' };
        cross.trigger('click');
        return { closed: true };
    }).catch(error => ({ closed: false, error: String(error?.message ?? error).slice(0, 200) }));

    if (save.saved === true) via.push('character Save (#create_button click; the menu handler follow-up)');
    return {
        ...prepared,
        via,
        dialog,
        fallback,
        importState,
        save,
        editorClosed,
        verified,
        ok: verified.ok === true && importState.listed === true && save.saved === true,
    };
}

/** Fetch each installed extension's manifest through the product's own static mount and record the observed status. */
async function recordExtensionServeEvidence(page, installed) {
    return page.evaluate(async entries => {
        const observations = [];
        for (const entry of entries) {
            const url = `/scripts/extensions/third-party/${entry.name}/manifest.json`;
            try {
                const response = await fetch(url);
                observations.push({ name: entry.name, url, status: response.status, ok: response.ok === true });
            } catch (error) {
                observations.push({ name: entry.name, url, status: null, ok: false, error: String(error?.message ?? error).slice(0, 200) });
            }
        }
        return observations;
    }, installed.map(entry => ({ name: entry.name })));
}

/**
 * THE PROFILE'S QR -> HELPER CHAIN (design section 5.5). The QR's STscript WRITES the chat variable and then
 * INJECTS its prompt; the read-only helper run AFTER the QR reads the scopes and injects the readback, so the
 * provider body carries "the helper read the value the QR wrote" (and both markers are attributable).
 */
async function runProfileQrHelperChain(page) {
    const writeMarker = 'COMB_QR_WROTE_MARKER';
    const injection = JOURNEY.qrInjection;
    const qr = await page.evaluate(async ({ setName, label, marker, text }) => {
        const api = globalThis.quickReplyApi;
        if (!api) return { status: 'not-driven', reason: 'quickReplyApi not published' };
        try {
            await api.createSet(setName).catch(() => {});
            const message = `/setvar key=comb_chat_var "${marker}" | /inject id=comb-journey-qr position=0 depth=4 "${text}"`;
            await api.createQuickReply(setName, label, { message });
            const set = api.getSetByName(setName);
            if (set && typeof set.save === 'function') await set.save();
            if (typeof api.executeQuickReply === 'function') {
                await api.executeQuickReply(setName, label);
                return { status: 'driven', via: 'api.executeQuickReply', message };
            }
            return { status: 'not-driven', reason: 'no executeQuickReply', message };
        } catch (error) {
            return { status: 'not-driven', reason: String(error?.message ?? error).slice(0, 300) };
        }
    }, { setName: JOURNEY.qrSet, label: JOURNEY.qrLabel, marker: writeMarker, text: injection });

    let pageVariable = { direct: null };
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        pageVariable = await page.evaluate(async () => {
            try {
                const script = await import('./script.js');
                const variables = script.chat_metadata?.variables ?? null;
                return { direct: variables && typeof variables === 'object' ? (variables.comb_chat_var ?? null) : null, hasMetadata: Boolean(script.chat_metadata) };
            } catch (error) {
                return { direct: null, error: String(error?.message ?? error).slice(0, 160) };
            }
        });
        if (pageVariable.direct === writeMarker) break;
        await page.waitForTimeout(200);
    }

    // THE READ-ONLY HELPER RUN: it writes nothing, so what it reads is what the QR wrote.
    const helperScript = `
        (async () => {
            const cfg = window.parent.__combRead;
            if (!cfg) {
                window.__combDone = { runId: 'auto-run-on-load', errors: [], closure: { insideIframe: window !== window.parent, bridge: Boolean(window.TavernHelper) }, readback: null };
                return;
            }
            const out = { runId: cfg.runId, errors: [], closure: null, readback: null };
            const done = () => { window.__combDone = out; };
            try {
                const H = window.TavernHelper || window.parent.TavernHelper;
                out.closure = { insideIframe: window !== window.parent, bridge: Boolean(H) };
                const parts = [];
                for (const type of ['chat', 'global', 'character']) {
                    const value = H.getVariables({ type });
                    const keys = Object.keys(value || {}).filter(key => key.indexOf('comb_') === 0).sort();
                    parts.push('COMB_VAR_' + type.toUpperCase() + '[' + type + ']=' + keys.map(key => key + '=' + JSON.stringify(value[key])).join(';'));
                }
                out.readback = parts;
                await H.injectPrompts([{ id: 'comb-journey-vars', content: parts.join(' ') }]);
            } catch (error) { out.errors.push(String(error && error.message || error)); }
            return done();
        })();
    `;
    const runId = `comb-readonly-helper-${Date.now()}`;
    await page.evaluate(item => {
        window.__combRead = { runId: item.runId };
        window.__combDone = null;
        window.TavernHelper.replaceScriptTrees([{ type: 'script', enabled: true, name: item.runId, id: item.runId, content: item.content, button: { enabled: false, buttons: [] } }], { type: 'global' });
    }, { runId, content: helperScript });
    const done = await waitForCondition(page, async () => {
        const found = [...document.querySelectorAll('iframe')].map(frame => { try { return frame.contentWindow?.__combDone ?? null; } catch { return null; } }).filter(Boolean);
        const record = found.find(entry => entry.runId === window.__combRead?.runId) ?? null;
        return { ok: Boolean(record), done: record };
    }, { label: 'profile-readonly-helper', timeoutMs: 60000 });
    const readOnly = { payload: { runId }, done: done.value?.done ?? null, ok: done.ok === true && (done.value?.done?.errors ?? []).length === 0 };
    const readbackText = (readOnly.done?.readback ?? []).join(' ');
    const chain = {
        writeMarker,
        injection,
        intendedOrder: ['qr-script-writes-chat-var', 'helper-reads-scopes', 'helper-injects-readback', 'qr-injects-prompt'],
        qr,
        pageVariable,
        helper: readOnly,
        readbackCarriesWrite: readbackText.includes(writeMarker),
    };
    return {
        qr,
        helper: readOnly,
        chain,
        readbackCarriesWrite: chain.readbackCarriesWrite,
        closure: readOnly.done?.closure ?? null,
        errors: readOnly.done?.errors ?? [],
        ok: qr.status === 'driven' && readOnly.ok === true && chain.readbackCarriesWrite === true,
    };
}

/** Ordered message ids: the persisted/rendered order the design's duplicate-message control reads. */
async function recordOrderedMessageIds(page) {
    return page.evaluate(async () => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        const userMarkers = [];
        const messages = chat.map((message, index) => {
            const text = String(message?.mes ?? '');
            const marker = (text.match(/COMB_[A-Z_]+/) ?? [null])[0];
            if (message?.is_user === true && marker) userMarkers.push({ index, marker });
            return { index, role: message?.is_user === true ? 'user' : 'assistant', marker, textLength: text.length };
        });
        const domMesIds = [...document.querySelectorAll('#chat .mes')].map(element => element.getAttribute('mesid') ?? element.dataset?.mesId ?? null);
        return {
            messages,
            userMarkers,
            domMesIds,
            chatLength: chat.length,
            domCount: domMesIds.length,
            // The two facts the comparator needs: the rendered ids are unique, and the rendered count matches the
            // chat array (the conversation-editing race the design requires be resolved before this lane gates).
            domIdsUnique: new Set(domMesIds).size === domMesIds.length,
            domIdsCoverChat: domMesIds.length === chat.length,
        };
    });
}

/** Which of the journey's injected prompts the page's own assembly state currently carries. */
async function verifyInjectionPrompts(page, { timeoutMs = 8000 } = {}) {
    const read = () => page.evaluate(async () => {
        const script = await import('./script.js');
        const context = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
        const prompts = script.extension_prompts ?? context?.extensionPrompts ?? null;
        const inspect = id => {
            const entry = prompts ? prompts[id] : undefined;
            if (!entry) return { id, present: false };
            return {
                id,
                present: true,
                hasValue: typeof entry.value === 'string' ? entry.value.length > 0 : Boolean(entry.value),
                position: entry.position ?? null,
                depth: entry.depth ?? null,
                valuePreview: typeof entry.value === 'string' ? entry.value.slice(0, 60) : null,
            };
        };
        return { available: Boolean(prompts), variables: inspect('comb-journey-vars'), quickReply: inspect('comb-journey-qr') };
    });
    const deadline = Date.now() + timeoutMs;
    let last = await read();
    while (Date.now() < deadline) {
        const ok = last.variables?.present === true && last.variables?.hasValue === true && last.quickReply?.present === true;
        if (ok) return last;
        await page.waitForTimeout(200);
        last = await read();
    }
    return last;
}

/**
 * A user's recovery from a stuck send: press the product's stop control, then wait (bounded) for the frontend's own
 * idle flags. If the page never goes idle, the caller reloads; this function never claims success it did not see.
 */
async function recoverStuckSend(page) {
    const pressed = await page.evaluate(async () => {
        const stop = document.querySelector('#mes_stop') ?? document.querySelector('#send_but');
        const script = await import('./script.js');
        const before = { isSendPress: script.is_send_press === true, streaming: Boolean(script.streamingProcessor), stopPresent: Boolean(document.querySelector('#mes_stop')) };
        if (stop) stop.click();
        try { if (typeof script.stopGeneration === 'function') await script.stopGeneration(true); } catch { /* recorded below */ }
        return { clicked: Boolean(stop), before };
    }).catch(error => ({ clicked: false, error: String(error?.message ?? error) }));
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const state = await page.evaluate(async () => {
            const script = await import('./script.js');
            return { isSendPress: script.is_send_press === true, streaming: Boolean(script.streamingProcessor) };
        }).catch(() => ({ isSendPress: true, streaming: true }));
        if (state.isSendPress === false && state.streaming === false) return { recovered: true, pressed, waitedMs: 15000 - (deadline - Date.now()) };
        await page.waitForTimeout(200);
    }
    return { recovered: false, pressed };
}

function userMessageCarries(body, marker) {
    try {
        const parsed = JSON.parse(body);
        const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
        return messages.some(message => message.role === 'user' && String(message.content ?? '').includes(marker));
    } catch {
        return false;
    }
}

function anyMessageCarries(body, marker) {
    return String(body ?? '').includes(marker);
}


/** Re-select the armed preset through the frontend's own control. Returns the product's reported selection. */
async function selectPresetThroughControl(page, name) {
    const outcome = await page.evaluate(async wanted => {
        const openai = await import('./scripts/openai.js');
        const select = document.querySelector('#settings_preset_openai');
        if (!select) return { ok: false, reason: 'no #settings_preset_openai control' };
        const option = [...select.options].find(entry => String(entry.textContent ?? '').trim() === wanted || entry.value === wanted);
        if (!option) return { ok: false, reason: 'preset not listed', options: [...select.options].map(entry => String(entry.textContent ?? '').trim()).slice(0, 30) };
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (typeof openai.getPresetApplicationPromise === 'function') {
            try { await openai.getPresetApplicationPromise(openai.oai_settings.preset_settings_openai); } catch { /* recorded by the caller through the returned selection */ }
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        return { ok: true, selected: openai.oai_settings.preset_settings_openai ?? null, optionValue: option.value };
    }, name);
    return outcome;
}



/**
 * Reopen the saved journey chat through the product's own path and assert the preconditions a user has before they
 * press send: the saved chat is ACTIVE, it has more than one message, and the last message is the assistant's
 * regex-rewritten reply. Returns the observed state and a named `precondition` when it is not satisfied.
 */
async function reopenJourneyChat(page, chatId, { minLength = 2, expectText = null } = {}) {
    const observed = await page.evaluate(async ({ wanted, expected, minimum }) => {
        const script = await import('./script.js');
        const groupChats = await import('./scripts/group-chats.js');
        if (typeof groupChats.resetSelectedGroup === 'function') groupChats.resetSelectedGroup();
        if (!wanted) return { opened: false, precondition: 'no saved chat id', wanted };
        // THE CHARACTER'S OWN CHAT IS ALREADY THE SAVED ONE on the reload/restart paths; only an ACTIVE-CHAT mismatch
        // needs the explicit open (recorded in the result either way).
        let via = 'character-open/default-chat';
        let beforeId = window.SillyTavern?.getContext?.()?.chatId ?? null;
        if (beforeId !== wanted) {
            via = 'openCharacterChat';
            try { await script.openCharacterChat(wanted); } catch (error) { return { opened: false, precondition: 'openCharacterChat threw', wanted, threw: String(error?.message ?? error).slice(0, 300) }; }
        }
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            const context = window.SillyTavern?.getContext?.();
            const chat = script.chat ?? [];
            if (context?.chatId === wanted && chat.length > 0) {
                const last = chat[chat.length - 1] ?? null;
                const lastText = String(last?.mes ?? '');
                const ready = chat.length >= minimum && String(last?.is_user ?? false) === 'false' && (!expected || lastText.includes(expected));
                // STABILITY WINDOW: the length must hold for a settling period before the caller may send.
                const settleDeadline = Date.now() + 1500;
                let stable = true;
                while (Date.now() < settleDeadline) {
                    await new Promise(resolve => setTimeout(resolve, 100));
                    const again = window.SillyTavern?.getContext?.();
                    const lengthNow = (script.chat ?? []).length;
                    if (again?.chatId !== wanted || lengthNow < minimum) { stable = false; break; }
                }
                if (stable) {
                    return {
                        opened: true, chatId: context.chatId, chatLength: chat.length,
                        lastText: lastText.slice(0, 200), lastIsUser: last?.is_user === true,
                        regexWordPresent: lastText.includes(String(expected ?? '')), expected, stable: true, via, beforeId,
                        satisfied: ready,
                        precondition: ready ? null : (chat.length < minimum ? 'the reopened chat has fewer messages than the saved viewer had' : (expected && !lastText.includes(String(expected)) ? 'the last message is not the regex-rewritten assistant reply' : 'the last message is not an assistant message')),
                    };
                }
                // Not stable: fall through and keep polling, the chat is still loading.
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return { opened: false, precondition: 'the saved chat never became the active chat', wanted, chatId: window.SillyTavern?.getContext?.()?.chatId ?? null, chatLength: (script.chat ?? []).length };
    }, { wanted: chatId, expected: expectText, minimum: minLength });
    return observed;
}

/** Set the product's own current-user name (what {{user}} resolves to) through its own setter and persist it. */
async function setJourneyUserName(page, name) {
    return page.evaluate(async wanted => {
        const script = await import('./script.js');
        const powerUser = await import('./scripts/power-user.js');
        if (typeof script.setUserName === 'function') script.setUserName(wanted, { toastPersonaNameChange: false });
        // THE PAGE CAN RE-ASSERT THE PERSONA AFTER A LATE BOOT STEP: personas.js's selectCurrentPersona() copies
        // power_user.personas[user_avatar] back into name1 -- and addMissingPersonas() has already created that
        // entry as '[Unnamed Persona]' for the seeded avatar. On Linux the boot ordering let that run AFTER this
        // setter (the ubuntu CI capture carried [Unnamed Persona] where pinned carried Probe User, +7 bytes on
        // every capture), while Windows happened to run it first. Setting the map entry too is what a user does
        // when they name their persona, and it makes the value survive the re-assert on both hosts.
        // PERSONAS.js OWNS user_avatar AND THE BOOT MAY NOT HAVE SET IT YET. reading it from script.js gave undefined;
        // reading it once from personas.js gave '' on the Linux boot (so the write was skipped and run 41364544754
        // still carried [Unnamed Persona] on every capture). Wait bounded for it, write the map entry, and rewrite any
        // placeholder entry the boot's addMissingPersonas() may already have created -- that entry is the one
        // selectCurrentPersona() copies back into name1 when the boot step lands after this setter.
        const personasModule = await import('./scripts/personas.js');
        let personaAvatar = '';
        for (let attempt = 0; attempt < 50; attempt += 1) {
            personaAvatar = personasModule.user_avatar ?? '';
            if (personaAvatar) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        powerUser.power_user.personas = powerUser.power_user.personas ?? {};
        for (const [avatarId, personaName] of Object.entries(powerUser.power_user.personas)) {
            if (!personaName || personaName === '[Unnamed Persona]') powerUser.power_user.personas[avatarId] = wanted;
        }
        if (personaAvatar) {
            powerUser.power_user.personas[personaAvatar] = wanted;
            powerUser.power_user.persona_descriptions = powerUser.power_user.persona_descriptions ?? {};
            powerUser.power_user.persona_descriptions[personaAvatar] = powerUser.power_user.persona_descriptions[personaAvatar] ?? { description: '', position: 0, depth: 4, role: 0, lorebook: '' };
        }
        // The history prefix a user message carries is governed by this setting. Both subjects must agree on it or the
        // request bodies differ by "Name: " on every history turn (measured: Go "Probe User: COMB_TURN_1" vs pinned
        // "COMB_TURN_1").
        powerUser.power_user.allow_name1_display = false;
        if (typeof script.saveSettingsDebounced === 'function') script.saveSettingsDebounced();
        const context = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
        return { name1: script.name1 ?? context?.name1 ?? null, setterUsed: typeof script.setUserName === 'function', allowName1Display: powerUser.power_user.allow_name1_display === true };
    }, name);
}


/** The prompt manager state that decides which prompts enter the request (compare armed vs reloaded). */
async function readPromptManagerState(page) {
    return page.evaluate(async () => {
        const openai = await import('./scripts/openai.js');
        const script = await import('./script.js');
        const pm = openai.promptManager;
        if (!pm) return { available: false };
        let collection = null;
        try {
            const entries = pm.getPromptCollection('normal');
            collection = entries ? [...entries.entries?.() ?? Object.entries(entries)].map(([key, value]) => ({ key, contentLength: String(value?.content ?? '').length, role: value?.role ?? null })).slice(0, 40) : null;
        } catch (error) { collection = { error: String(error?.message ?? error) }; }
        const order = pm.serviceSettings && pm.serviceSettings.prompt_order ? pm.serviceSettings.prompt_order : null;
        const enabled = {};
        const disabled = {};
        for (const identifier of ['main', 'chatHistory', 'worldInfoBefore', 'worldInfoAfter', 'worldInfoExamples', 'jailbreak', 'nsfw']) {
            try {
                const entry = Array.isArray(order) ? order.flatMap(group => group.order ?? []).find(item => item.identifier === identifier) : null;
                enabled[identifier] = entry ? entry.enabled === true : null;
                disabled[identifier] = pm.isPromptDisabledForActiveCharacter ? pm.isPromptDisabledForActiveCharacter(identifier) : null;
            } catch (error) { enabled[identifier] = 'threw'; }
        }
        return {
            available: true,
            activeCharacter: pm.activeCharacter ?? null,
            // `pm.prompts` DOES NOT EXIST (the prompts live on `pm.serviceSettings.prompts`): the pre-dispatch version
            // reported `prompts: null` here, which is why `complex-preset-selected` could look "selected but empty"
            // and why the applied state was never asserted. Both the declared prompts and the ACTIVE order row are
            // reported now, plus the marker-bearing collection the assembly actually uses.
            promptCount: Array.isArray(pm.serviceSettings?.prompts) ? pm.serviceSettings.prompts.length : null,
            promptOrderRows: Array.isArray(pm.serviceSettings?.prompt_order) ? pm.serviceSettings.prompt_order.map(row => ({ character_id: row?.character_id ?? null, orderLength: Array.isArray(row?.order) ? row.order.length : null })) : null,
            activeCharacterId: pm.activeCharacter?.id ?? null,
            activeOrderLength: (() => {
                const id = pm.activeCharacter?.id ?? null;
                const row = (pm.serviceSettings?.prompt_order ?? []).find(item => String(item?.character_id) === String(id));
                return Array.isArray(row?.order) ? row.order.length : null;
            })(),
            collectionMarkers: (() => {
                try {
                    const entries = pm.getPromptCollection('normal');
                    const prompts = Array.isArray(entries?.collection) ? entries.collection : [];
                    return prompts.map(prompt => String(prompt?.content ?? '').match(/MARKER_P\d{4}/)?.[0] ?? null).filter(Boolean);
                } catch { return null; }
            })(),
            collection,
            enabled,
            disabled,
            thisChid: script.this_chid ?? null,
            contextChid: (window.SillyTavern?.getContext?.()?.characterId ?? null),
        };
    });
}

/** The values an APPLIED profile preset must show, derived from the recorded recipe (no hand-written counts). */
function expectedPresetApplication() {
    const record = profileContext?.record ?? null;
    const staged = profileContext?.stagedPreset ?? null;
    const enabledMarkers = record
        ? [...record.expectedOrder.blocks.enabledRelative, ...record.expectedOrder.blocks.enabledAbsolute]
        : [];
    let nonMarkerEnabled = null;
    if (staged && Array.isArray(staged.prompts)) {
        const contentByIdentifier = new Map(staged.prompts.map(prompt => [prompt.identifier, String(prompt?.content ?? '')]));
        const activeRow = (staged.prompt_order ?? []).find(row => String(row?.character_id) === String(GLOBAL_PROMPT_ORDER_DUMMY_ID));
        nonMarkerEnabled = (activeRow?.order ?? []).filter(entry => entry?.enabled === true && !/MARKER_P\d{4}/.test(contentByIdentifier.get(entry.identifier) ?? '')).length;
    }
    return {
        declaredPrompts: record?.preset?.declaredPrompts ?? null,
        orderLength: record?.preset?.activeOrderLength ?? null,
        enabledMarkers,
        nonMarkerEnabled,
    };
}

/**
 * THE APPLIED-STATE ASSERTION (what dispatch 42173399186 needed and did not have). A preset is applied only when the
 * LIVE prompt manager shows the staged declared prompts, an order row for its OWN active character id, that row's
 * length, and the marker-bearing collection the assembly uses. Selecting the option is not applying it; the previous
 * check only reported `prompts: null` and could not tell the difference.
 */
async function readPresetAppliedState(page, expected) {
    const observed = await page.evaluate(async () => {
        const openai = await import('./scripts/openai.js');
        const pm = openai.promptManager ?? null;
        const service = pm?.serviceSettings ?? openai.oai_settings ?? {};
        const activeId = pm?.activeCharacter?.id ?? null;
        const rows = Array.isArray(service.prompt_order) ? service.prompt_order : [];
        const row = rows.find(item => String(item?.character_id) === String(activeId)) ?? null;
        const order = Array.isArray(row?.order) ? row.order : [];
        const prompts = Array.isArray(service.prompts) ? service.prompts : [];
        let collection = null;
        try {
            const entries = pm ? pm.getPromptCollection('normal') : null;
            collection = Array.isArray(entries?.collection) ? entries.collection : null;
        } catch { collection = null; }
        const collectionMarkers = collection === null ? null : collection.map(prompt => String(prompt?.content ?? '').match(/MARKER_P\d{4}/)?.[0] ?? null).filter(Boolean);
        return {
            selectedPreset: openai.oai_settings?.preset_settings_openai ?? null,
            activeCharacterId: activeId,
            declaredPrompts: prompts.length,
            orderRowFound: Boolean(row),
            orderLength: order.length,
            enabledInOrder: order.filter(entry => entry?.enabled === true).length,
            collectionLength: collection === null ? null : collection.length,
            collectionMarkers,
            collectionNonMarkerCount: collection === null ? null : collection.filter(prompt => !/MARKER_P\d{4}/.test(String(prompt?.content ?? ''))).length,
            promptManagerPresent: Boolean(pm),
        };
    });
    const observedMarkers = [...new Set(observed.collectionMarkers ?? [])].sort();
    const expectedMarkers = [...new Set(expected.enabledMarkers ?? [])].sort();
    const problems = [];
    if (observed.promptManagerPresent !== true) problems.push('the prompt manager is not initialised');
    if (expected.declaredPrompts !== null && observed.declaredPrompts !== expected.declaredPrompts) problems.push(`declared prompts ${observed.declaredPrompts} != ${expected.declaredPrompts}`);
    if (observed.orderRowFound !== true) problems.push(`no prompt_order row for the active character id ${String(observed.activeCharacterId)} (the dispatch-42173399186 failure: a row keyed for a different id is invisible, PromptManager.js:1207-1212)`);
    if (expected.orderLength !== null && observed.orderLength !== expected.orderLength) problems.push(`active order length ${observed.orderLength} != ${expected.orderLength}`);
    if (JSON.stringify(observedMarkers) !== JSON.stringify(expectedMarkers)) problems.push(`collection markers ${observedMarkers.length} != expected ${expectedMarkers.length} (${expectedMarkers.filter(marker => !observedMarkers.includes(marker)).slice(0, 5).join(',')} missing)`);
    if (expected.nonMarkerEnabled !== null && observed.collectionNonMarkerCount !== expected.nonMarkerEnabled) problems.push(`non-marker collection prompts ${observed.collectionNonMarkerCount} != ${expected.nonMarkerEnabled}`);
    return { ok: problems.length === 0, problems, observed, expected };
}


/** Wait (bounded) until the prompt manager's NORMAL collection is the character's, not the dummy fallback. */
async function waitForArmedPromptManager(page, { minimum = 8, timeoutMs = 30000, markerNeedle = 'MARK_' } = {}) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
        last = await page.evaluate(async needle => {
            const openai = await import('./scripts/openai.js');
            const script = await import('./script.js');
            const pm = openai.promptManager;
            if (!pm) return { available: false };
            let count = null;
            let identifiers = null;
            let markerCount = 0;
            try {
                const collection = pm.getPromptCollection('normal');
                const prompts = Array.isArray(collection?.collection) ? collection.collection : [];
                count = prompts.length;
                identifiers = prompts.map(prompt => prompt?.identifier ?? null);
                // THE COMPLEX PRESET IS WHAT MAKES THE FINAL REQUEST WHAT IT IS. The default prompt order also has
                // chatHistory/worldInfoBefore/main, so the three required identifiers could not tell an armed complex
                // preset from a freshly booted default one -- and the restart capture carried world-info slots but no
                // preset markers while this check was green. Count the preset's own marker-shaped prompts and require
                // them; the NEEDLE is passed in so the legacy derivation's `MARK_` tokens and the E03+E04 profile's
                // `MARKER_Pxxxx` blocks each get a check that can actually fail.
                markerCount = prompts.filter(prompt => String(prompt?.content ?? '').includes(needle)).length;
            } catch (error) { return { available: true, error: String(error?.message ?? error) }; }
            return { available: true, promptCount: count, identifiers, markerCount, needle, activeCharacter: pm.activeCharacter ?? null, chid: script.this_chid ?? null };
        }, markerNeedle);
        const identifiers = last?.identifiers ?? [];
        const required = ['chatHistory', 'worldInfoBefore', 'main'];
        const armed = last?.available === true && Number(last?.promptCount) >= minimum && Number(last?.markerCount) >= 5 && required.every(identifier => identifiers.includes(identifier));
        if (armed) {
            // STABILITY WINDOW: keep sampling for 2.5 s; a later sample that is not armed restarts the window.
            const stableSince = Date.now();
            let stable = true;
            while (Date.now() - stableSince < 2500) {
                await page.waitForTimeout(250);
                const again = await page.evaluate(async needle => {
                    const openai = await import('./scripts/openai.js');
                    const collection = openai.promptManager?.getPromptCollection('normal');
                    const prompts = Array.isArray(collection?.collection) ? collection.collection : [];
                    return { count: prompts.length, identifiers: prompts.map(prompt => prompt?.identifier ?? null), markerCount: prompts.filter(prompt => String(prompt?.content ?? '').includes(needle)).length };
                }, markerNeedle);
                const stillArmed = Number(again?.count) >= minimum && Number(again?.markerCount) >= 5 && required.every(identifier => (again?.identifiers ?? []).includes(identifier));
                if (!stillArmed) { stable = false; break; }
            }
            if (stable) return { ...last, armed: true, stableForMs: Date.now() - started, waitedMs: Date.now() - started };
        }
        await page.waitForTimeout(250);
    }
    return { ...(last ?? {}), armed: false, waitedMs: Date.now() - started };
}

/** One user turn: baseline first, click the product's send control, wait for the page AND the peer to move. */
async function turn(page, marker, caseName, { settleMs = 0 } = {}) {
    await waitForQuiet(page);
    const baseline = await readPageState(page);
    const before = peerRequests().length;
    const sent = await sendTurn(page, marker);
    if (!sent?.clicked) return { ok: false, caseName, reason: 'send control did not click', sent, requests: [] };
    const replied = await waitForReply(page, { baseline, peerCompletions: peerRequests(), timeoutMs: 120000 });
    // The peer answers in a stream; the page settles when the generation ends. Both conditions are bounded.
    const requestArrived = await waitForPeerRequests(page, before + 1, 60000);
    if (settleMs > 0) await page.waitForTimeout(settleMs);
    // ATTRIBUTION BY CONTENT, NOT BY ARRIVAL ORDER. A page that has just reloaded can have a late request in flight
    // (the connection change fires a prompt assembly), and an arrival-order slice then records that request as "the
    // turn" while the real turn's request lands later. The user's own text is IN the request body, so the capture a
    // turn owns is the one whose body contains its marker; anything else after `before` is recorded as unattributed.
    const attribute = entries => entries.map(entry => {
        const userMatch = userMessageCarries(entry.body, marker);
        return {
            case: caseName,
            method: entry.method,
            path: entry.path,
            byteLength: entry.byteLength,
            sha256: entry.sha256,
            body: entry.body,
            requestedStream: entry.requestedStream,
            served: entry.served,
            attribution: userMatch ? 'user-message' : (anyMessageCarries(entry.body, marker) ? 'system-or-other' : 'none'),
            matchedMarker: userMatch,
        };
    });
    let returns = null;
    let slice = attribute(completionsFrom(before));
    let matched = slice.filter(entry => entry.matchedMarker);
    let recovered = null;
    if (matched.length === 0) {
        // BOUNDED WAIT: a real generation request may still be in flight after the page-load assembly.
        const deadline = Date.now() + 20000;
        while (matched.length === 0 && Date.now() < deadline) {
            await page.waitForTimeout(200);
            slice = attribute(completionsFrom(before));
            matched = slice.filter(entry => entry.matchedMarker);
        }
    }
    if (matched.length === 0) {
        // A CLICK WITH NO GENERATION REQUEST is the stuck state the control arms produce. Recover the way a user does
        // (stop, then idle) and retry the send ONCE; the retry is recorded, and a second failure stays red.
        recovered = await recoverStuckSend(page);
        if (recovered.recovered) {
            const retryBaseline = await readPageState(page);
            const retryBefore = peerRequests().length;
            const retrySent = await sendTurn(page, marker);
            if (retrySent?.clicked) {
                await waitForReply(page, { baseline: retryBaseline, peerCompletions: peerRequests(), timeoutMs: 120000 }).catch(() => null);
                await waitForPeerRequests(page, retryBefore + 1, 60000);
                const retrySlice = attribute(completionsFrom(retryBefore));
                const retryMatched = retrySlice.filter(entry => entry.matchedMarker);
                if (retryMatched.length > 0) { slice = retrySlice; matched = retryMatched; }
            }
        }
    }
    if (matched.length === 0) {
        const seen = slice.map(entry => ({ attribution: entry.attribution, byteLength: entry.byteLength, sha256: entry.sha256 }));
        returns = { noGenerationRequest: true, seen, recovered };
    }
    const unmatched = slice.filter(entry => entry.attribution !== 'user-message');
    if (unmatched.length > 0) {
        report.unattributedRequests = report.unattributedRequests ?? [];
        report.unattributedRequests.push(...unmatched.slice(0, 2).map(entry => ({ after: caseName, attribution: entry.attribution, byteLength: entry.byteLength, sha256: entry.sha256, bodyHead: String(entry.body ?? '').slice(0, 5000) })));
    }
    const requests = matched.map(entry => ({
        case: caseName,
        method: entry.method,
        path: entry.path,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        body: entry.body,
        requestedStream: entry.requestedStream,
        served: entry.served,
        attribution: entry.attribution,
    }));
    report.captures.push({ case: caseName, marker, at: Date.now(), requestCount: requests.length, requestShas: requests.map(entry => entry.sha256) });
    report.requests.push(...requests);
    const after = await readPageState(page);
    return {
        ok: replied?.ok !== false && requestArrived && requests.length >= 1,
        caseName, requested: requestArrived, matched: requests.length, sent, replied, baseline, after, requests,
        noGenerationRequest: returns?.noGenerationRequest === true, seen: returns?.seen ?? null, recovered: returns?.recovered ?? recovered,
    };
}

function classifyCapture(request) {
    if (!request) return null;
    const layout = extractLayout(request.body ?? '');
    const text = request.body ?? '';
    return {
        case: request.case,
        sha256: request.sha256,
        byteLength: request.byteLength,
        requestedStream: request.requestedStream,
        servedWire: request.served?.wire ?? null,
        layout,
        wiMarkers: {
            before: text.includes(WI_MARKERS.before),
            after: text.includes(WI_MARKERS.after),
            depth: text.includes(WI_MARKERS.depth),
        },
        variables: {
            chat: text.includes(`${JOURNEY.helperChatVar}=`) || text.includes('COMB_CHAT_VAR_MARKER'),
            global: text.includes('COMB_GLOBAL_VAR_MARKER'),
            character: text.includes('COMB_CHARACTER_VAR_MARKER'),
        },
        qr: text.includes(JOURNEY.qrInjection),
        regexRewritten: text.includes(CARD.regexReplace),
        regexRawLeaked: text.includes(CARD.regexFind),
        presetMarkers: presetSignatures.map(marker => ({ marker, present: text.includes(marker) })),
        anMarker: text.includes('PRESET_AN_DEPTH_7F'),
        historyTurns: 0,
    };
}

async function main() {
    try {
        // ---- staged fixture (before boot) ---------------------------------------------------------------
        // THE COMMITTED COMPLEX PRESET IS PLANTED BEFORE THE SERVER BOOTS, because the frontend's preset manager
        // lists the preset directory as it was when the page initialised; a file written after page load is not in
        // its list (measured: options were ["Default"]). The user-equivalent path is a preset file in the tree
        // before the page opens, which is also what whole-session-probe.mjs does for its preset arm.
        const presetName = profileMode ? PROFILE_PRESET_NAME : 'comb-journey-complex-preset';
        let presetDocument = null;
        let presetSource = null;
        if (phase === 'drive') {
            if (profileMode) {
                // ---- E03+E04 INGREDIENTS, ALL OF THEM, BEFORE THE PAGE READS ITS LISTS --------------------
                profileContext = await stageE03e04Profile(dataRoot);
                report.e03e04 = {
                    profile: profileMode,
                    tier: tierArgument,
                    seed: seedArgument,
                    blockCount: profileContext.record.blockCount,
                    recordFile: profileContext.recordFile,
                    expectedOrderSha256: profileContext.record.expectedOrderSha256,
                    record: profileContext.record,
                };
                step('e03e04-profile-staged', profileContext.record.expectedOrderSha256.length === 64
                    && profileContext.record.books['e03e04-book-a-three-slot'] !== undefined
                    && profileContext.record.books['e03e04-book-c-recursive'] !== undefined
                    && profileContext.presetShape?.ok === true, {
                    tier: tierArgument,
                    seed: seedArgument,
                    blockCount: profileContext.record.blockCount,
                    expectedOrderSha256: profileContext.record.expectedOrderSha256,
                    stagedPresetSha256: profileContext.record.preset.sha256,
                    kitPresetSha256: profileContext.record.preset.kitSha256,
                    promptOrderCharacterIds: profileContext.record.preset.promptOrderCharacterIds,
                    activePromptOrderCharacterId: profileContext.record.preset.activePromptOrderCharacterId,
                    declaredPrompts: profileContext.record.preset.declaredPrompts,
                    activeOrderLength: profileContext.record.preset.activeOrderLength,
                    presetShapeProblems: profileContext.presetShape?.problems ?? null,
                    cardCharacterBookSha256: profileContext.record.cardCharacterBook.sha256,
                });
                // The staged preset document is what the frontend will read; record the SHAPE check separately so a
                // future run names "the file is not what the frontend applies" before a browser is even needed.
                step('e03e04-preset-document-applies-to-frontend-id', profileContext.presetShape?.ok === true
                    && String(profileContext.presetShape.activeCharacterId) === String(GLOBAL_PROMPT_ORDER_DUMMY_ID)
                    && profileContext.presetShape.activeOrderLength === profileContext.presetShape.declaredPrompts,
                    profileContext.presetShape);
                if (extensionTierArgument !== tierArgument) {
                    step('e03e04-extension-tier-is-narrowed', false, {
                        blockTier: tierArgument,
                        extensionTier: extensionTierArgument,
                        reason: 'the extension tier was narrowed independently of the block tier; the run is a triage run and must not be reported as full coverage',
                    });
                }
                // ONE extracted install helper (extension-install-batch.mjs); revisions are re-read and verified there.
                if (stageOnly) {
                    step('e03e04-extensions-install-skipped', true, { reason: '--stage-only: the staging triage mode does not install extensions (no network, no boot)' });
                } else {
                    const batch = await installExtensionBatch({ dataRoot, tier: extensionTierArgument });
                    report.extensions = extensionBatchRecord(batch);
                    step('e03e04-extensions-installed', batch.installedCount === batch.expected && batch.expected === EXTENSION_TIERS[extensionTierArgument],
                        { tier: extensionTierArgument, expected: batch.expected, installed: batch.installedCount, lockSha256: batch.lockSha256 });
                }
                if (report.extensions === null) report.extensions = { tier: extensionTierArgument, skipped: true, installedCount: 0, expected: EXTENSION_TIERS[extensionTierArgument], installed: [], serveEvidence: [] };
                const helperRecord = report.extensions.installed.find(entry => entry.name === 'JS-Slash-Runner') ?? null;
                if (!helperRecord && !stageOnly) {
                    step('helper-extension-is-pinned', false, { reason: 'the batch did not install the pinned Tavern Helper canary', installed: report.extensions.installed.map(entry => entry.name) });
                }
                const built = profileContext.built;
                const card = await stageJourneyCard(dataRoot, { characterBook: built.books.cardEmbedded.characterBook });
                const world = await stageJourneyWorldBook(dataRoot);
                const groups = await stageJourneyGroups(dataRoot);
                const helperDirectory = helperRecord ? path.join(dataRoot, helperRecord.directory) : null;
                const apiSurface = helperDirectory ? await readHelperApiSurface({ extensionDirectory: helperDirectory, revision: helperRecord.commit }, helperDirectory) : { pinned: false, reasons: ['helper not installed by the batch'] };
                report.fixture = {
                    card,
                    world,
                    groups,
                    profile: {
                        profile: profileMode,
                        tier: tierArgument,
                        seed: seedArgument,
                        blockCount: profileContext.record.blockCount,
                        documents: profileContext.record.manifest.documents,
                    },
                    extensions: report.extensions,
                    apiSurface,
                };
                step('card-staged', card.sha256.length === 64 && card.characterBook?.sha256 === profileContext.record.cardCharacterBook.sha256,
                    { file: card.file, regex: card.regex, characterBook: card.characterBook });
                step('world-book-staged', world.book.entries === 3 && Array.isArray(world.selection.worldInfo?.globalSelect), world.book);
                step('groups-staged', Boolean(groups.groupName), { groupId: groups.groupId, groupName: groups.groupName });
                if (!stageOnly) {
                    step('helper-extension-is-pinned', apiSurface.pinned === true && (apiSurface.reasons ?? []).length === 0, { pinned: apiSurface.pinned, reasons: apiSurface.reasons });
                }
            } else {
                presetSource = await fs.readFile(path.join(here, 'fixtures', 'real', 'preset-a.json'));
                presetDocument = JSON.parse(presetSource.toString('utf8'));
                await fs.mkdir(path.join(dataRoot, 'default-user', 'OpenAI Settings'), { recursive: true });
                await fs.writeFile(path.join(dataRoot, 'default-user', 'OpenAI Settings', `${presetName}.json`), `${JSON.stringify(presetDocument, null, 2)}\n`);
                const card = await stageJourneyCard(dataRoot);
                const world = await stageJourneyWorldBook(dataRoot);
                const groups = await stageJourneyGroups(dataRoot);
                const extension = await ensurePinnedExtensionInstalled(dataRoot, pinnedExtension('tavern-helper'));
                const apiSurface = await readHelperApiSurface(extension, extension.extensionDirectory);
                report.fixture = { card, world, groups, extension: { ...describeInstalledExtension(extension.extensionDirectory), revision: extension.revision }, apiSurface };
                step('card-staged', card.sha256.length === 64, { file: card.file, regex: card.regex });
                step('world-book-staged', world.book.entries === 3 && Array.isArray(world.selection.worldInfo?.globalSelect), world.book);
                step('groups-staged', Boolean(groups.groupName), { groupId: groups.groupId, groupName: groups.groupName });
                step('helper-extension-is-pinned', apiSurface.pinned === true && (apiSurface.reasons ?? []).length === 0, { pinned: apiSurface.pinned, reasons: apiSurface.reasons });
            }
        } else {
            report.fixture = { reused: true };
            if (profileMode) {
                // A LATER PHASE JUDGES AGAINST THE SAME MANIFEST THE DRIVE STAGED, digest re-verified; it never
                // re-derives a possibly different recipe from the command line alone.
                const loaded = await readE03e04Record(dataRoot);
                profileContext = loaded.built ? { record: loaded.record, built: loaded.built } : null;
                report.e03e04 = {
                    profile: profileMode,
                    tier: loaded.record?.tier ?? tierArgument,
                    seed: loaded.record?.seed ?? seedArgument,
                    blockCount: loaded.record?.blockCount ?? null,
                    recordFile: `default-user/${PROFILE_RECORD_FILE}`,
                    expectedOrderSha256: loaded.record?.expectedOrderSha256 ?? null,
                    recordSha256Verified: loaded.verified,
                    record: loaded.record,
                };
                // The later phases classify captures with the SAME three preset signatures the drive used.
                if (loaded.verified === true) presetSignatures = loaded.record.expectedOrder.blocks.enabledRelative.slice(0, 3);
                step('e03e04-profile-record-reused', loaded.verified === true, { verified: loaded.verified, reason: loaded.reason, tier: loaded.record?.tier ?? null });
            }
        }

        if (stageOnly) {
            // TRIAGE MODE ONLY: the staged documents and record are the whole point; no server/browser is started.
            report.stagingOnly = true;
            step('stage-only-complete', true, {
                profile: profileMode,
                tier: tierArgument,
                seed: seedArgument,
                recordFile: profileContext?.recordFile ?? null,
                expectedOrderSha256: profileContext?.record?.expectedOrderSha256 ?? null,
                stagedPresetSha256: profileContext?.record?.preset?.sha256 ?? null,
                kitPresetSha256: profileContext?.record?.preset?.kitSha256 ?? null,
                presetShape: profileContext?.presetShape ?? null,
                documents: Object.keys(profileContext?.record?.manifest?.documents ?? {}),
            });
            return;
        }

        // ---- boot + browser ---------------------------------------------------------------------------
        const port = await freePort();
        server = await bootSubject({ argv: process.argv, dataRoot, port, external });
        if (server.bootRefusal) throw new Error(server.bootRefusal);
        await waitForServer(`${server.baseURL}/version`);
        const baseURL = server.baseURL;
        step('server-ready', true, { external, baseURL: baseURL.replace(/:\d+/, ':<port>') });
        peer = await startCapturePeer({ wire: 'honour', replyText: ordinal => `${CARD.regexFind}_${ordinal}` });
        browser = await chromium.launch({ headless: true });
        let page = await browser.newPage();
        report.pageErrors = [];
        page.on('pageerror', error => report.pageErrors.push(String(error?.stack ?? error?.message ?? error).slice(0, 900)));
        await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
        await openPage(page, baseURL);
        const peerURL = `http://127.0.0.1:${peer.port}/v1`;
        const connect = () => applyConnectionState(page, peerURL);
        report.browser.connect = await connect();
        // PROFILE: the stop strings / instruct-context members are power_user state, not preset members, and the boot
        // may have rewritten settings.json; re-assert them through the product's own module before any turn.
        if (profileMode) {
            report.browser.powerUserPatch = await applyProfilePowerUserAfterBoot(page, profileContext?.record?.powerUserPatch ?? null);
            if (phase === 'drive') {
                step('e03e04-stops-and-templates-applied', report.browser.powerUserPatch.ok === true && Array.isArray(JSON.parse(report.browser.powerUserPatch.custom_stopping_strings ?? '[]')) && JSON.parse(report.browser.powerUserPatch.custom_stopping_strings).length === 4, report.browser.powerUserPatch);
            }
        }
        // THE EXTENSION BATCH IS SERVED BY THE PRODUCT'S OWN STATIC MOUNT. Fetching each installed extension's
        // manifest is the page-side half of E04's install claim (the disk half is the revision-verified batch); the
        // per-extension `extension-effect-<name>` guard reads this record together with the wire-effect classification.
        if (profileMode && phase === 'drive') {
            const serveEvidence = await recordExtensionServeEvidence(page, report.extensions.installed);
            report.extensions.serveEvidence = serveEvidence;
            const served = serveEvidence.filter(entry => entry.ok === true).length;
            const classified = report.extensions.installed.filter(entry => entry.wireEffect?.status && entry.wireEffect?.evidence).length;
            step('e03e04-extensions-served', served === report.extensions.installed.length, { served, expected: report.extensions.installed.length, failures: serveEvidence.filter(entry => entry.ok !== true).slice(0, 4) });
            step('e03e04-extension-effects-recorded', classified === report.extensions.installed.length, { classified, expected: report.extensions.installed.length, noWireEffect: report.extensions.installed.filter(entry => entry.wireEffect?.status === 'no-wire-effect').map(entry => entry.name) });
        }
        // THE WORLD BOOK IS SELECTED THROUGH THE FRONTEND AFTER BOOT, on every phase: the pre-boot settings write is
        // overwritten by both servers' booting (measured on pinned: turn-1 slots 0). This is the product's own
        // selection path and the disk member it persists is polled, not assumed. In profile mode the SAME call also
        // re-asserts the recursion/depth settings and selects the journey book PLUS both profile books.
        const bootWorldSelection = await selectJourneyWorlds(page, dataRoot);
        report.browser.worldSelectionAfterBoot = bootWorldSelection;
        step('world-info-selected-after-boot', bootWorldSelection.ok === true, bootWorldSelection);
        step('world-info-persisted-after-boot', Array.isArray(bootWorldSelection.persistedGlobalSelect) && bootWorldSelection.persistedGlobalSelect.includes(JOURNEY_WORLD)
            && (!profileMode || profileWorldNames().every(name => bootWorldSelection.persistedGlobalSelect.includes(name))), bootWorldSelection);
        report.browser.userName = await setJourneyUserName(page, 'Probe User');
        step('user-name-set', report.browser.userName.name1 === 'Probe User', report.browser.userName);

        const openJourneyCharacter = async () => {
            const opened = await openCharacter(page, CARD.name);
            step('character-opened', opened?.opened === true, opened);
            return opened;
        };
        const waitChatLoaded = async () => {
            const loaded = await waitForCondition(page, async () => {
                const script = await import('./script.js');
                return { ok: (script.chat ?? []).length > 0 && script.settingsReady === true };
            }, { label: 'chat-loaded', timeoutMs: 90000 });
            return loaded;
        };
        const readJourneyChatsNow = () => readJourneyChats(dataRoot);
        // A FULL PAGE RESET, the user's recovery when the composer stays wedged: reload -> reconnect -> keep the
        // product's world selection -> open the same conversation -> re-run the helper and the QR.
        const resetPageAndReopen = async chatId => {
            await openPage(page, baseURL);
            await connect();
            const world = await selectJourneyWorlds(page, dataRoot);
            await openJourneyCharacter();
            await waitChatLoaded();
            const reopened = await reopenJourneyChat(page, chatId, { minLength: 2 });
            // THE PERSONA BINDING IS CLEARED BY OPENING THE CHARACTER, so it is re-asserted AFTER the chat is open.
            const userName = await setJourneyUserName(page, 'Probe User');
            // ... and the peer connection is re-applied LAST, so nothing after it can replace the custom URL/model.
            await connect();
            const helper = await injectVariablesThroughHelper(page);
            const qr = await executeJourneyQuickReply(page);
            await waitForQuiet(page);
            return { world, userName, reopened, helper: { ok: helper.ok }, qr: { status: qr.status } };
        };

        if (phase === 'drive') {
            // ---- STEP 1: character + chat ------------------------------------------------------------
            await openJourneyCharacter();
            step('chat-loaded', (await waitChatLoaded()).ok === true);
            const roster = await page.evaluate(async () => {
                const script = await import('./script.js');
                return (script.characters ?? []).map(entry => String(entry?.name ?? ''));
            });
            report.browser.roster = roster;
            step('roster-has-journey-card-and-group-members', roster.includes(CARD.name) && roster.includes('Alice') && roster.includes('Bob'), { roster });
            // CHARACTER-SCOPED REGEX IS GATED BY THE REGEX EXTENSION'S OWN ALLOW-LIST. `getScriptsByType` returns a
            // character's scripts only when `extension_settings.character_allowed_regex` includes that character's
            // avatar (engine.js:115-118). The checkbox that state belongs to is the user's "allow scoped regex for this
            // character" control; this writes the same member through the extension's own settings object and records
            // the avatar, so the rule executes on the model output (placement 2) rather than being silently skipped.
            const regexAllow = await page.evaluate(async () => {
                const script = await import('./script.js');
                const extensions = await import('./scripts/extensions.js');
                const settings = extensions.extension_settings;
                const character = (script.characters ?? [])[script.this_chid] ?? null;
                const avatar = character?.avatar ?? null;
                if (!Array.isArray(settings.character_allowed_regex)) settings.character_allowed_regex = [];
                if (avatar && !settings.character_allowed_regex.includes(avatar)) settings.character_allowed_regex.push(avatar);
                if (typeof script.saveSettingsDebounced === 'function') script.saveSettingsDebounced();
                const engine = await import('./scripts/extensions/regex/engine.js');
                const scoped = typeof engine.getScriptsByType === 'function' && engine.SCRIPT_TYPES
                    ? (engine.getScriptsByType(engine.SCRIPT_TYPES.SCOPED, { allowedOnly: true }) ?? []).length : null;
                return { avatar, allowed: settings.character_allowed_regex.slice(), scopedScriptsVisible: scoped };
            });
            report.browser.regexAllow = regexAllow;
            step('character-scoped-regex-allowed-and-visible', regexAllow.avatar !== null && Number(regexAllow.scopedScriptsVisible) >= 1, regexAllow);

            // ---- STEP 2a-pre: the CARD-EMBEDDED LOREBOOK, through the product's own import path (profile only) ----
            // The book is in the card's V3 payload (`data.character_book`), NOT auto-active: a user imports it from
            // the character panel ("Import Card Lore") and the product binds it as the character's world
            // (world-info.js:5691-5760). The journey's legacy path stages no embedded book, so this step exists only
            // in profile mode.
            if (profileMode) {
                const embedded = await importEmbeddedCardBookAfterBoot(page);
                report.browser.embeddedBook = embedded;
                step('e03e04-embedded-book-imported', embedded.ok === true, {
                    bookName: embedded.bookName, via: embedded.via, verified: embedded.verified, dialog: embedded.dialog,
                });
            }

            // ---- STEP 2a: committed complex preset SELECTED through the frontend control -------------------
            // (The file itself was planted BEFORE the server booted: the preset manager lists the preset directory
            // as it was at startup, so a file written after page load is not in its list -- measured: only
            // `Default` was listed. Planting pre-boot is the user-equivalent path whole-session-probe.mjs uses.)
            const selected = await page.evaluate(async name => {
                const openai = await import('./scripts/openai.js');
                const select = document.querySelector('#settings_preset_openai');
                if (!select) return { ok: false, reason: 'no preset control' };
                let option = [...select.options].find(entry => entry.textContent?.trim() === name || entry.value === name);
                if (!option) {
                    // The freshly written file may not be in the manager yet; the frontend's own refresh is the
                    // user-equivalent path and is retried bounded.
                    const deadline = Date.now() + 15000;
                    while (!option && Date.now() < deadline) {
                        try {
                            const pm = typeof openai.getPresetManager === 'function' ? openai.getPresetManager() : null;
                            if (pm && typeof pm.refresh === 'function') await pm.refresh();
                        } catch { /* the failure is recorded below as "not listed" */ }
                        await new Promise(resolve => setTimeout(resolve, 250));
                        const current = document.querySelector('#settings_preset_openai');
                        option = current ? [...current.options].find(entry => entry.textContent?.trim() === name || entry.value === name) : null;
                    }
                }
                if (!option) return { ok: false, reason: `preset ${name} not listed`, options: [...select.options].map(entry => entry.textContent?.trim()).slice(0, 30) };
                select.value = option.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                if (typeof openai.getPresetApplicationPromise === 'function') await openai.getPresetApplicationPromise(openai.oai_settings.preset_settings_openai);
                await new Promise(resolve => setTimeout(resolve, 500));
                // THE DECLARED PROMPTS LIVE ON `promptManager.serviceSettings.prompts`, never on `promptManager.prompts`
                // (the pre-dispatch read reported `null` from the wrong member). The APPLIED assertion is separate
                // (readPresetAppliedState) so "selected" and "applied" are never conflated again.
                const service = openai.promptManager?.serviceSettings ?? openai.oai_settings ?? {};
                return {
                    ok: true,
                    selected: openai.oai_settings.preset_settings_openai ?? null,
                    declaredPrompts: Array.isArray(service.prompts) ? service.prompts.length : null,
                    orderRows: Array.isArray(service.prompt_order) ? service.prompt_order.map(row => ({ character_id: row?.character_id ?? null, orderLength: Array.isArray(row?.order) ? row.order.length : null })) : null,
                    activeCharacterId: openai.promptManager?.activeCharacter?.id ?? null,
                    optionValue: option.value,
                };
            }, presetName);
            // THE APPLIED-STATE ASSERTION: a selected option is not an applied preset. This is the named check that
            // would have caught dispatch 42173399186's 11-default-prompt order at the step, before any request.
            const presetApplied = profileMode ? await readPresetAppliedState(page, expectedPresetApplication()) : null;
            report.browser.presetApplied = presetApplied;
            const plantedPreset = profileMode
                ? profileContext.stagedPreset
                : presetDocument;
            report.browser.preset = {
                name: presetName,
                plantedSha: profileMode ? profileContext.record.preset.sha256 : sha256(presetSource),
                structure: {
                    prompts: (plantedPreset.prompts ?? []).length,
                    orderRows: (plantedPreset.prompt_order ?? []).flatMap(row => row.order ?? []).length,
                },
                profile: profileMode ? { tier: tierArgument, blockCount: profileContext.record.blockCount, totalPromptCount: profileContext.record.manifest.claim.totalPrompts } : null,
                selected,
            };
            // THE PRESET'S OWN LITERAL PIECES, from the document this run planted:
            //   * legacy: the derivation's `MARK_` tokens;
            //   * profile: the first three enabled RELATIVE block markers from the recorded manifest (a subset of the
            //     full ordered contract, which the COMPARATOR asserts -- the probe does not assert expectedOrder).
            presetSignatures = profileMode
                ? profileContext.record.expectedOrder.blocks.enabledRelative.slice(0, 3)
                : (presetDocument.prompts ?? [])
                    .map(entry => String(entry?.content ?? ''))
                    .filter(content => /MARK_[0-9A-Za-z]{4,}/.test(content))
                    .map(content => (content.match(/MARK_[0-9A-Za-z_]+/) ?? [null])[0])
                    .filter(Boolean)
                    .slice(0, 3);
            report.browser.presetSignatures = presetSignatures;
            step('complex-preset-selected', selected.ok === true
                && String(selected.selected ?? '').toLowerCase().includes(profileMode ? 'e03e04' : 'comb-journey')
                && (!profileMode || presetApplied?.ok === true), { selected, applied: presetApplied });
            if (profileMode) {
                // NAMED APPLIED ASSERTION (new in this task): the staged prompts/order reached the LIVE prompt manager,
                // including an order row for its own active character id. Dispatch 42173399186 selected the option and
                // still ran the 11 default prompts; this step fails with the exact mismatch that happened.
                step('e03e04-preset-applied-to-prompt-manager', presetApplied?.ok === true, presetApplied);
            }

            // ---- STEP 2b: author's note through the frontend's own module ----------------------------
            const anSpec = resolveAuthorsNoteCase(authorsNoteOverlaySpec(), 'parity');
            const anApplied = await page.evaluate(applyAuthorsNoteOverlay, anSpec);
            report.browser.authorsNote = { spec: anSpec, applied: anApplied };
            step('authors-note-applied', anApplied?.problems?.length === 0, anApplied);

            // ---- STEP 2c/2d: variables + injection + Quick Reply (profile mode composes them into ONE chain) ----
            // LEGACY: the helper writes the three scoped variables and injects them; the QR is created and EXECUTED
            // afterwards (two independent effects).
            // PROFILE (design section 5.5): the QR's STscript WRITES the chat variable and injects its prompt, then a
            // READ-ONLY helper run reads the scopes (it writes nothing) and injects the readback -- so the body
            // carries "the helper read the value the QR wrote", the chain the comparator guard `qr-to-helper-chain`
            // names.
            if (profileMode) {
                // The E03/E04 chain needs the three scopes populated as well as the QR-written value: the legacy
                // WRITE helper runs first, then the QR writes/injects, then the read-only helper re-reads and
                // re-injects, so the armed body carries all three scope markers AND the QR-written chat value the
                // helper read.
                const writeRun = await injectVariablesThroughHelper(page);
                report.browser.profileWriteRun = { ok: writeRun.ok, done: writeRun.done ?? null };
                const chain = await runProfileQrHelperChain(page);
                report.browser.profileChain = chain;
                report.browser.helper = { payload: chain.helper?.payload ?? null, done: chain.helper?.done ?? null, mode: 'write-run + read-only-after-qr' };
                report.browser.quickReply = chain.qr;
                step('helper-variables-written', writeRun.ok === true && chain.helper?.ok === true && chain.readbackCarriesWrite === true, {
                    writeRun: { ok: writeRun.ok, errors: writeRun.done?.errors ?? null },
                    readback: chain.helper?.done?.readback ?? null,
                    writeMarker: chain.chain.writeMarker,
                    readbackCarriesWrite: chain.readbackCarriesWrite,
                });
                step('helper-closure-inside-iframe', chain.closure?.insideIframe === true, chain.closure ?? null);
                step('quick-reply-created-and-executed', chain.qr?.status === 'driven', chain.qr);
                const driveInjections = await verifyInjectionPrompts(page);
                report.browser.driveInjections = driveInjections;
                step('drive-injections-active-in-page', driveInjections.variables?.present === true && driveInjections.variables?.hasValue === true, driveInjections);
                step('e03e04-qr-helper-chain-recorded', chain.ok === true, {
                    intendedOrder: chain.chain.intendedOrder,
                    readbackCarriesWrite: chain.readbackCarriesWrite,
                    pageVariable: chain.chain.pageVariable,
                    qr: chain.qr,
                });
            } else {
                // ---- STEP 2c: variables + injection through the pinned 酒馆助手 bridge --------------------
                const helperInstall = await ensurePinnedExtensionInstalled(dataRoot, pinnedExtension('tavern-helper'));
                report.fixture.helperInstall = { revision: helperInstall.revision };
                const helperScript = `
                    (async () => {
                        const cfg = window.parent.__comb;
                        if (!cfg) {
                            window.__combDone = { runId: 'auto-run-on-load', cases: [], errors: [], closure: { insideIframe: window !== window.parent, bridge: Boolean(window.TavernHelper) }, readback: null, skipped: 'no injection payload' };
                            return;
                        }
                        const out = { runId: cfg.runId, cases: [], errors: [], closure: null };
                        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
                        const done = () => { window.__combDone = out; };
                        try {
                            const H = window.TavernHelper || window.parent.TavernHelper;
                            out.closure = { insideIframe: window !== window.parent, bridge: !!H };
                            H.insertOrAssignVariables({ comb_chat_var: cfg.chat }, { type: 'chat' });
                            H.insertOrAssignVariables({ comb_global_var: cfg.global }, { type: 'global' });
                            H.insertOrAssignVariables({ comb_character_var: cfg.character }, { type: 'character' });
                            await sleep(300);
                            const parts = [];
                            for (const type of ['chat', 'global', 'character']) {
                                const value = H.getVariables({ type });
                                const keys = Object.keys(value || {}).filter(key => key.indexOf('comb_') === 0).sort();
                                parts.push('COMB_VAR_' + type.toUpperCase() + '[' + type + ']=' + keys.map(key => key + '=' + JSON.stringify(value[key])).join(';'));
                            }
                            out.readback = parts;
                            await H.injectPrompts([{ id: 'comb-journey-vars', content: parts.join(' ') }]);
                            out.cases.push({ name: 'variables-written', applied: true });
                        } catch (error) { out.errors.push(String(error && error.message || error)); }
                        return done();
                    })();
                `;
                const helperRunId = `comb-helper-${Date.now()}`;
                const helperPayload = { runId: helperRunId, chat: 'COMB_CHAT_VAR_MARKER', global: 'COMB_GLOBAL_VAR_MARKER', character: 'COMB_CHARACTER_VAR_MARKER' };
                await page.evaluate(item => { window.__comb = item.payload; window.__combDone = null; window.TavernHelper.replaceScriptTrees([{ type: 'script', enabled: true, name: item.runId, id: item.runId, content: item.content, button: { enabled: false, buttons: [] } }], { type: 'global' }); }, { payload: helperPayload, runId: helperRunId, content: helperScript });
                const helperDone = await waitForCondition(page, async () => {
                    const found = [...document.querySelectorAll('iframe')].map(frame => { try { return frame.contentWindow?.__combDone ?? null; } catch { return null; } }).filter(Boolean);
                    const done = found.find(entry => entry.runId === window.__comb?.runId) ?? null;
                    return { ok: Boolean(done), done };
                }, { label: 'helper-variables', timeoutMs: 60000 });
                report.browser.helper = { payload: helperPayload, done: helperDone.value?.done ?? null };
                step('helper-variables-written', helperDone.ok === true && (helperDone.value?.done?.errors ?? []).length === 0, helperDone.value?.done ?? helperDone.last);
                step('helper-closure-inside-iframe', helperDone.value?.done?.closure?.insideIframe === true, helperDone.value?.done?.closure ?? null);

                // ---- STEP 2d: a Quick Reply created through the extension API and EXECUTED ----------------
                const qr = await page.evaluate(async ({ setName, label, injection }) => {
                    const api = globalThis.quickReplyApi;
                    const preconditions = { published: Boolean(api) };
                    if (!api) return { status: 'not-driven', preconditions };
                    try {
                        await api.createSet(setName).catch(() => {});
                        await api.createQuickReply(setName, label, { message: `/inject id=comb-journey-qr position=0 depth=4 "${injection}"` });
                        const set = api.getSetByName(setName);
                        if (set && typeof set.save === 'function') await set.save();
                        let via = null;
                        if (typeof api.executeQuickReply === 'function') {
                            await api.executeQuickReply(setName, label);
                            via = 'api.executeQuickReply';
                        } else {
                            const buttons = [...document.querySelectorAll('.qr--button')];
                            const button = buttons.find(entry => String(entry.textContent ?? '').includes(label));
                            if (button) { button.click(); via = 'dom .qr--button click'; }
                        }
                        return { status: via ? 'driven' : 'not-driven', via, preconditions };
                    } catch (error) { return { status: 'not-driven', preconditions, reason: String(error?.message ?? error).slice(0, 300) }; }
                }, { setName: JOURNEY.qrSet, label: JOURNEY.qrLabel, injection: JOURNEY.qrInjection });
                report.browser.quickReply = qr;
                step('quick-reply-created-and-executed', qr.status === 'driven', qr);

                const driveInjections = await verifyInjectionPrompts(page);
                report.browser.driveInjections = driveInjections;
                step('drive-injections-active-in-page', driveInjections.variables?.present === true && driveInjections.variables?.hasValue === true, driveInjections);
            }

            // ---- STEP 3: the armed streamed turn -----------------------------------------------------
            report.browser.promptManagerArmed = await readPromptManagerState(page);
            // The profile's world-info entries are keyed on synthetic trigger tokens that must be IN the scanned chat
            // (a constant entry needs no key, but the recursion/secondary-key chain does). Putting them in the first
            // user message is the user-equivalent path -- the probe does not write book state at scan time.
            const turn1Marker = profileMode
                ? `COMB_TURN_1 ${profileContext.record.activation.chatTriggerTokens.join(' ')}`
                : 'COMB_TURN_1';
            const turn1 = await turn(page, turn1Marker, 'turn-1-armed');
            const capture1 = classifyCapture(turn1.requests[0]);
            report.browser.turn1 = { ok: turn1.ok, replied: turn1.replied, after: turn1.after, marker: turn1Marker };
            step('turn-1-request-captured', turn1.requests.length >= 1, { requests: turn1.requests.length });
            step('turn-1-streaming-requested', capture1?.requestedStream === true && capture1?.servedWire === 'sse', { requestedStream: capture1?.requestedStream, served: capture1?.servedWire });
            step('turn-1-preset-pieces-in-request', presetSignatures.length >= 2 && (capture1?.presetMarkers ?? []).filter(entry => entry.present).length >= 2, { signatures: presetSignatures, found: capture1?.presetMarkers });
            step('turn-1-world-info-three-slots-placed', capture1?.layout?.slotsPresent === 3 && capture1?.layout?.positions?.depth !== null, capture1?.layout);
            step('turn-1-variables-in-request', capture1?.variables?.chat === true && capture1?.variables?.global === true && capture1?.variables?.character === true, capture1?.variables);
            step('turn-1-quick-reply-in-request', capture1?.qr === true, { qr: capture1?.qr });
            step('turn-1-authors-note-in-request', capture1?.anMarker === true, { anMarker: capture1?.anMarker });
            if (profileMode) {
                step('e03e04-trigger-tokens-in-first-user-message', userMessageCarries(turn1.requests[0]?.body, profileContext.record.activation.chatTriggerTokens[0]), {
                    triggerTokens: profileContext.record.activation.chatTriggerTokens,
                    found: String(turn1.requests[0]?.body ?? '').includes(profileContext.record.activation.chatTriggerTokens[0]),
                });
            }

            // ---- STEP 4: regex changed the visible message (AI output) and the stored form ----------
            const visible = await page.evaluate(async () => {
                const script = await import('./script.js');
                const chat = script.chat ?? [];
                const last = chat[chat.length - 1] ?? null;
                return { lastText: String(last?.mes ?? ''), domText: String(document.querySelector('#chat .mes:last-child .mes_text')?.textContent ?? '').slice(0, 400) };
            });
            report.browser.regex = { find: CARD.regexFind, replace: CARD.regexReplace, visible };
            step('regex-rewrote-visible-message', visible.lastText.includes(CARD.regexReplace) && !visible.lastText.includes(CARD.regexFind), visible);
            const turn2 = await turn(page, 'COMB_TURN_2', 'turn-2-after-regex');
            const capture2 = classifyCapture(turn2.requests[0]);
            report.browser.turn2 = { ok: turn2.ok, after: turn2.after };
            step('turn-2-history-carries-regex-rewritten-text', capture2?.regexRewritten === true && capture2?.regexRawLeaked === false, { rewritten: capture2?.regexRewritten, rawLeaked: capture2?.regexRawLeaked });
            step('turn-2-history-carries-turn-1', String(turn2.requests[0]?.body ?? '').includes('COMB_TURN_1'), { bodyLength: turn2.requests[0]?.byteLength ?? null, found: String(turn2.requests[0]?.body ?? '').includes('COMB_TURN_1') });

            // ---- STEP 5: swipe / regenerate / continue / branch --------------------------------------
            // A PAGE ERROR ON BOTH SUBJECTS IS STILL A HARNESS PRECONDITION: ubuntu run 41363205426 recorded
            // "Cannot read properties of undefined (reading 'swipe_id')" on BOTH subjects, which means the swipe was
            // pressed while the last message had no swipe state yet. Wait for the state a swipeable message has.
            const swipeReady = await waitForCondition(page, async () => {
                const script = await import('./script.js');
                const chat = script.chat ?? [];
                const last = chat[chat.length - 1] ?? null;
                return {
                    // endSwipe() awaits the in-flight generation and then indexes chat[mesId]; pressing while a
                    // generation is still settling makes mesId stale when the chat array changes under it -- the
                    // both-subject page error on ubuntu. Require a quiet window after the last GENERATION_ENDED too.
                    ok: chat.length > 0 && last?.is_user === false && last?.swipe_id !== undefined
                        && script.is_send_press !== true && (Date.now() - (window.__combLastGenerationEnded ?? 0)) > 1500,
                    chatLength: chat.length,
                    lastIsUser: last?.is_user ?? null,
                    swipeId: last?.swipe_id ?? null,
                };
            }, { label: 'swipe-ready', timeoutMs: 30000 });
            step('swipe-ready', swipeReady.ok === true, swipeReady.value ?? swipeReady);
            const swipeBefore = await readPageState(page);
            const swipe = await page.evaluate(async () => {
                const script = await import('./script.js');
                // THE RENDERED CHAT CAN LAG THE ARRAY ON THE LINUX BOOT: endSwipe() indexes chat[] with the DOM's
                // message id, and a stale .mes node makes that index undefined -> the page error both subjects showed.
                // If the counts disagree, reopen the active chat (a user-reachable sync) and wait for the DOM to agree.
                const context = window.SillyTavern?.getContext?.();
                const domCount = () => document.querySelectorAll('#chat .mes').length;
                if (domCount() !== (script.chat ?? []).length && context?.chatId) {
                    try { await script.openCharacterChat(context.chatId); } catch (error) { /* recorded below if it persists */ }
                    const deadline = Date.now() + 15000;
                    while (Date.now() < deadline && domCount() !== (script.chat ?? []).length) await new Promise(resolve => setTimeout(resolve, 100));
                }
                const chat = script.chat ?? [];
                window.__combSwipeBefore = { chatLength: chat.length, lastText: String(chat[chat.length - 1]?.mes ?? '') };
                const allowed = typeof script.isSwipingAllowed === 'function' ? script.isSwipingAllowed() : null;
                // REBUILD THE RENDERED CHAT, THEN CLICK. The control click captures mesId from the rendered element and
                // endSwipe() later indexes chat[mesId]; a rendered node that is not the chat array's node (or a stale
                // node after the reload/return paths) makes that index undefined -- the endSwipe TypeError. Comparing
                // counts was not enough (run 41370517073: counts agreed, GoTavern alone raised it). printMessages() is
                // the frontend's own renderer, so after it returns the DOM ids ARE the chat indexes, and the click below
                // sees a coherent state. (The /swipe slash command was tried first: it did not start a generation at all
                // on either subject -- measured in run 41372041021 -- so the user-path control is kept, with its state
                // made coherent first.)
                await script.printMessages();
                const container = document.querySelector('#chat .mes:last-child');
                const control = container?.querySelector('.swipe_right') ?? container?.querySelector('[data-i18n="Right"]');
                if (!control) return { pressed: false, allowed, reason: 'no swipe-right control on the last message' };
                control.click();
                return { pressed: true, allowed, method: 'dom-click-after-render' };
            });
            const swipeRequestIndex = peerRequests().length;
            const swipeSettled = await waitForCondition(page, async () => {
                const script = await import('./script.js');
                const chat = script.chat ?? [];
                const before = window.__combSwipeBefore ?? { chatLength: 0, lastText: '' };
                return { ok: chat.length >= before.chatLength && script.is_send_press !== true && String(chat[chat.length - 1]?.mes ?? '') !== before.lastText };
            }, { label: 'swipe-settled', timeoutMs: 90000 });
            await waitForPeerRequests(page, swipeRequestIndex + (swipe.pressed ? 1 : 0), 60000);
            const swipeRequests = completionsFrom(swipeRequestIndex).map(entry => ({ case: 'swipe', method: entry.method, path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256, body: entry.body, requestedStream: entry.requestedStream, served: entry.served }));
            report.requests.push(...swipeRequests);
            report.captures.push({ case: 'swipe', requestShas: swipeRequests.map(entry => entry.sha256) });
            step('swipe-produced-a-request', swipe.pressed === true && swipeRequests.length >= 1 && swipeSettled.ok === true, { swipe, requests: swipeRequests.length });
            step('swipe-state-moved', swipeSettled.ok === true && swipeBefore.lastSwipes !== null, { before: { lastSwipes: swipeBefore.lastSwipes, lastSwipeId: swipeBefore.lastSwipeId }, after: swipeSettled.value });

            const regenBefore = peerRequests().length;
            const regen = await pressRegenerate(page);
            await waitForReply(page, { baseline: await readPageState(page), peerCompletions: regenBefore, timeoutMs: 120000 }).catch(() => null);
            await waitForPeerRequests(page, regenBefore + 1, 90000);
            const regenRequests = completionsFrom(regenBefore).map(entry => ({ case: 'regenerate', method: entry.method, path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256, body: entry.body, requestedStream: entry.requestedStream, served: entry.served }));
            report.requests.push(...regenRequests);
            report.captures.push({ case: 'regenerate', requestShas: regenRequests.map(entry => entry.sha256) });
            step('regenerate-produced-a-request', regen?.pressed !== false && regenRequests.length >= 1, { regen, requests: regenRequests.length });

            const contBefore = peerRequests().length;
            const cont = await pressContinue(page);
            await waitForPeerRequests(page, contBefore + 1, 90000);
            const contRequests = completionsFrom(contBefore).map(entry => ({ case: 'continue', method: entry.method, path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256, body: entry.body, requestedStream: entry.requestedStream, served: entry.served }));
            report.requests.push(...contRequests);
            report.captures.push({ case: 'continue', requestShas: contRequests.map(entry => entry.sha256) });
            step('continue-produced-a-request', cont?.pressed !== false && contRequests.length >= 1, { cont, requests: contRequests.length });
            // THE CONTINUATION'S APPENDED TEXT MUST BE ON DISK BEFORE THE NEXT PAGE RELOAD, or the reload re-reads a
            // stale chat file (dispatch 42178757887: 16 bytes, 4 capture mismatches + the restart capture + the chat
            // projection). The in-page state the verb produced is the expectation; the disk copy is what the reload
            // must see on BOTH subjects.
            report.browser.continuePersist = await persistChatEffect(page, dataRoot, {
                action: 'continue',
                expectText: String(cont?.after?.lastText ?? ''),
            });
            step('continue-effect-persisted-before-reload', report.browser.continuePersist.ok === true, report.browser.continuePersist);

            const branch = await page.evaluate(async () => {
                const script = await import('./script.js');
                const bookmarks = await import('./scripts/bookmarks.js');
                const chat = script.chat ?? [];
                const index = chat.length - 1;
                if (index < 0) return { created: false, reason: 'empty chat' };
                try {
                    const name = await bookmarks.createBranch(index);
                    return { created: Boolean(name), name: name ?? null, parentLength: chat.length };
                } catch (error) { return { created: false, reason: String(error?.message ?? error).slice(0, 300) }; }
            });
            report.browser.branch = branch;
            step('branch-created-through-frontend-bookmarks', branch.created === true, branch);

            // ---- STEP 6: knob-off discriminations, each arm as its own reset segment ------------------
            const controlSegmentChat = (await readPageState(page)).chatId;
            report.browser.controlSegmentReset = await resetPageAndReopen(controlSegmentChat);
            const controlPreset = await selectPresetThroughControl(page, presetName);
            report.browser.controlSegmentPreset = controlPreset;
            const presetOff = await page.evaluate(async () => {
                const select = document.querySelector('#settings_preset_openai');
                if (!select) return { ok: false, reason: 'no preset control' };
                const option = [...select.options].find(entry => String(entry.textContent ?? '').trim().toLowerCase() === 'default');
                if (!option) return { ok: false, reason: 'no Default preset option', options: [...select.options].map(entry => String(entry.textContent ?? '').trim()).slice(0, 30) };
                select.value = option.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise(resolve => setTimeout(resolve, 750));
                return { ok: true, selected: option.textContent?.trim() ?? null };
            });
            report.browser.presetOff = presetOff;
            // A PRESET CARRIES PROVIDER SETTINGS: re-point the page at the peer and re-select the world book, then start
            // the control turn from the frontend's own idle state.
            report.browser.presetOffReconnected = await connect();
            const controlWorld = await selectJourneyWorlds(page, dataRoot);
            report.browser.controlPersona = await setJourneyUserName(page, 'Probe User');
            report.browser.controlRecover = await recoverStuckSend(page);
            await waitForQuiet(page);
            let turnPresetOff = await turn(page, 'COMB_PRESET_OFF', 'control-preset-off');
            if (turnPresetOff.requests.length === 0) {
                const controlChatId = (await readPageState(page)).chatId;
                report.browser.controlReset = await resetPageAndReopen(controlChatId);
                turnPresetOff = await turn(page, 'COMB_PRESET_OFF', 'control-preset-off');
            }
            const capturePresetOff = classifyCapture(turnPresetOff.requests[0]);
            report.browser.capturePresetOff = capturePresetOff;
            report.browser.controlPresetTurn = { sent: turnPresetOff.sent, ok: turnPresetOff.ok, after: turnPresetOff.after };
            step('preset-off-turn-captured', turnPresetOff.requests.length >= 1, { requests: turnPresetOff.requests.length, sent: turnPresetOff.sent });
            step('preset-off-request-lacks-preset-markers', capturePresetOff?.presetMarkers?.every(entry => !entry.present) === true, capturePresetOff?.presetMarkers);
            // RESTORE THE ARMED PRESET, or every later turn (and the reload) would measure the control arm.
            const presetRestored = await page.evaluate(async name => {
                const select = document.querySelector('#settings_preset_openai');
                if (!select) return { ok: false, reason: 'no preset control' };
                const option = [...select.options].find(entry => String(entry.textContent ?? '').trim() === name || entry.value === name);
                if (!option) return { ok: false, reason: `restore target ${name} not listed` };
                select.value = option.value;
                select.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise(resolve => setTimeout(resolve, 750));
                return { ok: true, selected: String(option.textContent ?? '').trim() };
            }, presetName);
            report.browser.presetRestored = presetRestored;
            report.browser.presetRestoredReconnected = await connect();
            await selectJourneyWorlds(page, dataRoot);
            await waitForQuiet(page);
            step('preset-restored-after-control', presetRestored.ok === true, presetRestored);
            // SECOND ARM, SEPARATE SEGMENT: a fresh page, armed preset, then the world book is cleared in-page for the
            // control turn. The reset is what keeps a wedged composer from the first arm out of this one.
            report.browser.wiSegmentReset = await resetPageAndReopen((await readPageState(page)).chatId);
            report.browser.wiSegmentWorld = await selectJourneyWorlds(page, dataRoot);
            report.browser.wiSegmentPreset = await selectPresetThroughControl(page, presetName);

            const wiOff = await page.evaluate(async () => {
                const worldInfo = await import('./scripts/world-info.js');
                const before = Array.isArray(worldInfo.selected_world_info) ? worldInfo.selected_world_info.slice() : null;
                window.__combWorldSelection = before;
                if (Array.isArray(worldInfo.selected_world_info)) worldInfo.selected_world_info.length = 0;
                // PROFILE MODE ALSO UNBINDS THE CHARACTER'S OWN WORLD. The card-embedded book is CHARACTER lore, not
                // a `selected_world_info` member, so clearing the global selection alone would leave its before/after
                // entries in the request and make the "world info off" arm a lie. The binding is restored below, and
                // the arm records both values.
                const jQuery = globalThis.jQuery ?? null;
                const characterWorldBefore = jQuery ? String(jQuery('#character_world').val() ?? '') : null;
                window.__combCharacterWorld = characterWorldBefore;
                if (jQuery) jQuery('#character_world').val('').trigger('change');
                return { before, after: Array.isArray(worldInfo.selected_world_info) ? worldInfo.selected_world_info.slice() : null, characterWorldBefore, characterWorldCleared: Boolean(jQuery) };
            });
            report.browser.wiOff = wiOff;
            report.browser.wiOffPersona = await setJourneyUserName(page, 'Probe User');
            report.browser.wiOffRecover = await recoverStuckSend(page);
            await waitForQuiet(page);
            let turnWiOff = await turn(page, 'COMB_WI_OFF', 'control-wi-off');
            if (turnWiOff.requests.length === 0) {
                const wiChatId = (await readPageState(page)).chatId;
                report.browser.wiReset = await resetPageAndReopen(wiChatId);
                // Re-clear the selection on the fresh page (the control arm is still the control arm).
                await page.evaluate(async () => {
                    const worldInfo = await import('./scripts/world-info.js');
                    window.__combWorldSelection = Array.isArray(worldInfo.selected_world_info) ? worldInfo.selected_world_info.slice() : [];
                    if (Array.isArray(worldInfo.selected_world_info)) worldInfo.selected_world_info.length = 0;
                });
                turnWiOff = await turn(page, 'COMB_WI_OFF', 'control-wi-off');
            }
            const captureWiOff = classifyCapture(turnWiOff.requests[0]);
            report.browser.captureWiOff = captureWiOff;
            step('wi-off-turn-captured', turnWiOff.requests.length >= 1, { requests: turnWiOff.requests.length });
            step('wi-off-request-lacks-world-info', captureWiOff?.layout?.slotsPresent === 0, { layout: captureWiOff?.layout, markers: captureWiOff?.wiMarkers });

            const wiRestored = await selectJourneyWorlds(page, dataRoot);
            report.browser.wiRestore = wiRestored;
            // Restore the character's own world binding cleared for the profile's world-info-off arm (the product path:
            // the same `#character_world` change a user's panel selection performs, then the debounced character save).
            if (profileMode && report.browser.embeddedBook?.bookName) {
                report.browser.characterWorldRestore = await page.evaluate(async wanted => {
                    const script = await import('./script.js');
                    const jQuery = globalThis.jQuery ?? null;
                    if (!jQuery) return { ok: false, reason: 'no jQuery on the page' };
                    jQuery('#character_world').val(wanted).trigger('change');
                    if (typeof script.saveCharacterDebounced === 'function') script.saveCharacterDebounced();
                    await new Promise(resolve => setTimeout(resolve, 300));
                    const chid = script.this_chid;
                    return { ok: String(script.characters?.[chid]?.data?.extensions?.world ?? '') === wanted, bound: String(script.characters?.[chid]?.data?.extensions?.world ?? '') };
                }, report.browser.embeddedBook.bookName).catch(error => ({ ok: false, error: String(error?.message ?? error) }));
            }
            step('world-info-restored-after-control', wiRestored.ok === true && worldSelectionCovers(wiRestored), wiRestored);
            report.browser.wiPersisted = wiRestored.persistedGlobalSelect ?? null;
            step('world-info-selection-persisted-to-disk', Array.isArray(report.browser.wiPersisted) && report.browser.wiPersisted.length > 0, { wiPersisted: report.browser.wiPersisted });

            // ---- STEP 7: reload + resumed turn, then a group turn -----------------------------------
            const beforeReload = await readPageState(page);
            const savedChatId = beforeReload.chatId;
            const saved = await saveConditional(page);
            // CLOSE THE TAB AND OPEN A NEW ONE (the user's "close and reopen"): the reloaded turn is measured on a
            // page that was never mid-session, so an extension/iframe residue from the previous navigation cannot be
            // the cause of a swallowed assembly.
            await page.close().catch(() => null);
            page = await browser.newPage();
            page.on('pageerror', error => report.pageErrors.push(String(error?.stack ?? error?.message ?? error).slice(0, 900)));
            await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
            report.browser.reloadNewTab = true;
            await openPage(page, baseURL);
            await connect();
            // THE ORDER A USER TAKES AFTER A RELOAD: re-select the preset, restore the world selection, open the
            // character, REOPEN THE SAVED CHAT BY ITS ID (and prove it is active with its history), re-assert the
            // persona binding (the character open cleared it), and re-apply the peer connection LAST. Sending before
            // the chat is active is what produced a system-only 11864-byte assembly with no history.
            const reloadPreset = await selectPresetThroughControl(page, presetName);
            const reloadWorld = await selectJourneyWorlds(page, dataRoot);
            const reloadPersisted = await readSettings(dataRoot);
            await openJourneyCharacter();
            await waitChatLoaded();
            const reloadReopen = await reopenJourneyChat(page, savedChatId, { minLength: beforeReload.chatLength, expectText: CARD.regexReplace });
            report.browser.reloadReopen = reloadReopen;
            step('reload-chat-reopened', reloadReopen.satisfied === true, reloadReopen);
            const reloadUserName = await setJourneyUserName(page, 'Probe User');
            const reloadReconnected = await connect();
            await waitForQuiet(page);
            const reloadedState = await readPageState(page);
            report.browser.reload = { saved, savedChatId, beforeReload: { chatLength: beforeReload.chatLength, chatId: beforeReload.chatId }, reopened: reloadReopen, reloadPreset, reloadWorld, reloadPersisted: reloadPersisted.globalSelect ?? null, reloadUserName, reloadedState };
            step('chat-saved-and-reloaded', saved.ok === true && reloadReopen.opened === true, { saved, reopened: reloadReopen });
            step('reload-preserved-history', reloadReopen.satisfied === true && reloadReopen.chatLength >= beforeReload.chatLength, { before: beforeReload.chatLength, after: reloadReopen.chatLength, lastIsUser: reloadReopen.lastIsUser, regexWordPresent: reloadReopen.regexWordPresent });
            step('reload-world-info-persisted-from-disk', worldSelectionCovers(reloadPersisted), reloadPersisted.globalSelect ?? null);
            report.browser.reloadPresetNow = await page.evaluate(async () => {
                const openai = await import('./scripts/openai.js');
                return { preset: openai.oai_settings.preset_settings_openai ?? null, source: openai.oai_settings.chat_completion_source ?? null };
            });
            // A FRESH PAGE HAS NO INJECTED PROMPTS: the helper re-runs and the user re-clicks the QR. The page-side
            // check proves the prompts are registered BEFORE the send.
            const reloadHelper = await injectVariablesThroughHelper(page);
            const reloadQR = await executeJourneyQuickReply(page);
            const reloadInjections = await verifyInjectionPrompts(page);
            report.browser.reloadInjections = reloadInjections;
            step('reload-injections-active-in-page', reloadInjections.variables?.present === true && reloadInjections.variables?.hasValue === true, reloadInjections);
            report.browser.reloadHelper = { ok: reloadHelper.ok, done: reloadHelper.done };
            step('reload-helper-reran-and-reinjected-variables', reloadHelper.ok === true, reloadHelper.done ?? null);
            // RE-ASSERT THE ACTIVE CHAT AFTER THE INJECTIONS, immediately before the turn: the helper script and the QR
            // execute in the page and must not be trusted to have left the saved chat active.
            const reloadReady = await reopenJourneyChat(page, savedChatId, { minLength: beforeReload.chatLength, expectText: CARD.regexReplace });
            const reloadPersonaFinal = await setJourneyUserName(page, 'Probe User');
            const reloadConnectedFinal = await connect();
            await waitForQuiet(page);
            report.browser.reloadReady = { ...reloadReady, persona: reloadPersonaFinal, reconnected: reloadConnectedFinal };
            step('reload-ready-to-send', reloadReady.satisfied === true, reloadReady);
            report.browser.promptManagerReload = await readPromptManagerState(page);
            report.browser.reloadPresetFinal = await selectPresetThroughControl(page, presetName);
            report.browser.reloadConnectedFinal2 = await connect();
            await waitForQuiet(page);
            report.browser.reloadPromptArmed = await waitForArmedPromptManager(page, { markerNeedle: ARMED_MARKER_NEEDLE });
            step('reload-prompt-manager-armed', report.browser.reloadPromptArmed.armed === true, report.browser.reloadPromptArmed);
            if (profileMode) {
                report.browser.reloadPresetApplied = await readPresetAppliedState(page, expectedPresetApplication());
                step('e03e04-reload-preset-applied-to-prompt-manager', report.browser.reloadPresetApplied.ok === true, report.browser.reloadPresetApplied);
            }
            await page.evaluate(async () => {
                const script = await import('./script.js');
                const events = await import('./scripts/events.js');
                window.__combGenLog = [];
                window.__combOpenAI = await import('./scripts/openai.js');

                // THE TOKEN COUNTS THE BUDGET IS COMPUTED FROM. countAsync is the only thing between a prompt and
                // its token cost; a null/undefined returning here turns the budget arithmetic into NaN and the add
                // loop stops after the prompts whose counts were sane. Record every call and any error.
                window.__combTokLog = [];
                try {
                    const tokenHandler = window.__combOpenAI?.promptManager?.tokenHandler;
                    if (tokenHandler && !tokenHandler.__combWrapped) {
                        tokenHandler.__combWrapped = true;
                        const originalCount = tokenHandler.countAsync.bind(tokenHandler);
                        tokenHandler.countAsync = async function (message) {
                            const record = { contentLength: String(message?.content ?? '').length, at: Date.now() };
                            try {
                                const result = await originalCount(message);
                                record.count = result;
                                record.finite = Number.isFinite(result);
                                window.__combTokLog.push(record);
                                return result;
                            } catch (error) {
                                record.error = String(error?.message ?? error).slice(0, 240);
                                window.__combTokLog.push(record);
                                throw error;
                            }
                        };
                    }
                } catch (error) { /* recorder must never break the page */ }
                const record = async (event, args) => {
                    try {
                        const context = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
                        let promptCount = null;
                        try {
                            const openai = await import('./scripts/openai.js');
                            const collection = openai.promptManager?.getPromptCollection('normal');
                            promptCount = Array.isArray(collection?.collection) ? collection.collection.length : null;
                        } catch (error) { promptCount = 'threw'; }
                        window.__combGenLog.push({
                            event, type: args?.[0] ?? null, dryRun: args?.[2] ?? null,
                            chatLength: (script.chat ?? []).length,
                            chatId: context?.chatId ?? null,
                            mainApi: context?.mainApi ?? null,
                            isSendPress: script.is_send_press === true,
                            // THE PROMPT COLLECTION LENGTH AT EVENT TIME. GENERATE_AFTER_DATA reported 4 dummy prompts on
                            // both subjects while a dry run 1.3 s later assembled 39; this field says whether the manager
                            // was already disarmed BEFORE the event or only by the time the messages were built.
                            promptCount,
                            thisChid: script.this_chid ?? null,
                            // WHICH PROMPT ORDER / PRESET THE CALL ITSELF SEES. The content capture proved the real
                            // post-reload call resolves the dummy order while a later dry run resolves the armed one;
                            // these fields say whether the selected preset name, the settings' prompt_order and the
                            // manager's service settings agree at the real call (they are the three inputs that can
                            // disagree without changing the collection count the armed check measured later).
                            presetName: (() => { try { const pm = window.SillyTavern?.getContext?.()?.getPresetManager?.(); return pm?.getSelectedPresetName?.() ?? null; } catch (error) { return 'threw'; } })(),
                            settingsPreset: (() => { try { return window.__combOpenAI?.oai_settings?.preset_settings_openai ?? null; } catch (error) { return 'threw'; } })(),
                            serviceOrderLength: (() => { try { const order = window.__combOpenAI?.promptManager?.serviceSettings?.prompt_order; const dummy = Array.isArray(order) ? order.find(entry => entry?.character_id === 100001) : null; return dummy?.order?.length ?? null; } catch (error) { return 'threw'; } })(),
                            // THE PROMPTS LIST vs THE ORDER LIST. getPromptCollection skips an order entry whose
                            // prompt is absent, so a settings object that arrived with the 98-entry order but only the
                            // default prompts renders a four-message skeleton while every count derived from the order
                            // still looks right.
                            servicePromptsLength: (() => { try { const prompts = window.__combOpenAI?.promptManager?.serviceSettings?.prompts; return Array.isArray(prompts) ? prompts.length : null; } catch (error) { return 'threw'; } })(),
                            activeCharacterId: (() => { try { return window.__combOpenAI?.promptManager?.activeCharacter?.id ?? null; } catch (error) { return 'threw'; } })(),
                            at: Date.now(),
                        });
                        // A CHAT-LENGTH TIMELINE ACROSS THE GENERATION. The assembly happens ~1.7 s after
                        // GENERATION_STARTED; if the global chat array is swapped or emptied in that window, the
                        // assembled prompt would be a 4-message skeleton while every event still reports 9 messages.
                        // Sampling 25 ms gives the transition time and the chat id/character at each sample.
                        try {
                            if (event !== 'GENERATION_ENDED') {
                                if (!window.__combChatTimeline) window.__combChatTimeline = [];
                                if (!window.__combChatTimer) {
                                    window.__combChatTimer = setInterval(async () => {
                                        try {
                                            const script2 = await import('./script.js');
                                            const ctx2 = window.SillyTavern?.getContext ? window.SillyTavern.getContext() : null;
                                            window.__combChatTimeline.push({
                                                at: Date.now(),
                                                len: (script2.chat ?? []).length,
                                                chatId: ctx2?.chatId ?? null,
                                                chid: script2.this_chid ?? null,
                                                sendPress: script2.is_send_press === true,
                                            });
                                        } catch (error) { /* sampling must never break the page */ }
                                    }, 25);
                                }
                            } else if (window.__combChatTimer) {
                                clearInterval(window.__combChatTimer);
                                window.__combChatTimer = null;
                            }
                        } catch (error) { /* recorder must never break the page */ }
                    } catch (error) { window.__combGenLog.push({ event, error: String(error?.message ?? error) }); }
                };
                events.eventSource.on(events.event_types.GENERATION_STARTED, (...args) => record('GENERATION_STARTED', args));
                events.eventSource.on(events.event_types.GENERATION_AFTER_COMMANDS, (...args) => record('GENERATION_AFTER_COMMANDS', args));
                events.eventSource.on(events.event_types.GENERATION_ENDED, (...args) => { window.__combLastGenerationEnded = Date.now(); record('GENERATION_ENDED', args); });
                events.eventSource.on(events.event_types.GENERATE_AFTER_DATA, async (data, dryRun) => {
                    try {
                        let promptCountNow = null;
                        try {
                            const openai = await import('./scripts/openai.js');
                            const collection = openai.promptManager?.getPromptCollection('normal');
                            promptCountNow = Array.isArray(collection?.collection) ? collection.collection.length : null;
                        } catch (error) { promptCountNow = 'threw'; }
                        window.__combGenLog.push({
                            event: 'GENERATE_AFTER_DATA', dryRun, promptCount: promptCountNow, thisChid: null,
                            keys: Object.keys(data ?? {}),
                            promptLength: typeof data?.prompt === 'string' ? data.prompt.length : null,
                            promptArrayLength: Array.isArray(data?.prompt) ? data.prompt.length : null,
                            promptRoles: Array.isArray(data?.prompt) ? data.prompt.map(entry => entry?.role ?? null).slice(0, 20) : null,
                            // WHAT THE MESSAGES ACTUALLY ARE, not only their roles: the four-message real assembly is
                            // the object this anomaly is about, and a role list cannot tell a dummy prompt order from a
                            // truncated history. Content is clipped to 160 chars.
                            promptHeads: Array.isArray(data?.prompt) ? data.prompt.slice(0, 8).map(entry => ({ role: entry?.role ?? null, name: entry?.name ?? null, head: String(entry?.content ?? '').slice(0, 160) })) : null,
                            messageCounts: Array.isArray(data?.prompt) ? data.prompt.length : null,
                            messagesLength: Array.isArray(data?.messages) ? data.messages.length : null,
                            finalMesSendLength: Array.isArray(data?.finalMesSend) ? data.finalMesSend.length : null,
                            at: Date.now(),
                        });
                    } catch (error) { window.__combGenLog.push({ event: 'GENERATE_AFTER_DATA', error: String(error?.message ?? error) }); }
                });
                // WRAP fetch IN THE PAGE AND IN EVERY SAME-ORIGIN IFRAME, recording the caller stack and body size for
                // requests to the recording peer. Restore nothing: the page is a throwaway test page.
                window.__combFetchLog = [];
                const wrap = target => {
                    if (!target || !target.fetch || target.__combFetchWrapped) return;
                    target.__combFetchWrapped = true;
                    const original = target.fetch.bind(target);
                    target.fetch = function (input, init) {
                        try {
                            const url = typeof input === 'string' ? input : (input && input.url) || '';
                            if (String(url).includes('127.0.0.1') && /\/v1\/|chat\/completions/.test(String(url))) {
                                const body = init && init.body ? String(init.body) : '';
                                target.parent.__combFetchLog?.push?.({ url: String(url).slice(0, 200), bodyLength: body.length, bodyHead: body.slice(0, 160), stack: String(new Error().stack ?? '').slice(0, 1200), at: Date.now() });
                            }
                        } catch (error) { /* recorder must never break the page */ }
                        return original(input, init);
                    };
                };
                wrap(window);
                for (const frame of document.querySelectorAll('iframe')) {
                    try { wrap(frame.contentWindow); } catch (error) { /* cross-origin frame */ }
                }
            });
            let turnReload = null;
            if (reloadReopen.satisfied !== true) {
                // NAMED RED, NO MALFORMED TURN: the preconditions a user needs are not met, so nothing is sent.
                report.browser.reloadTurn = { skipped: true, reason: 'reload-chat-not-reopened', precondition: reloadReopen.precondition, reopen: reloadReopen };
            } else {
                const reloadTokenizer = await waitForTokenizerReady(page);
                step('reload-tokenizer-ready', reloadTokenizer.ok === true, reloadTokenizer);
                await waitForQuiet(page);
                turnReload = await turn(page, 'COMB_TURN_AFTER_RELOAD', 'turn-after-reload');
                report.browser.reloadTurn = { matched: turnReload.requests.length, noGenerationRequest: turnReload.noGenerationRequest === true, seen: turnReload.seen ?? null, recovered: turnReload.recovered ?? null, baseline: turnReload.baseline ?? null, sent: turnReload.sent ?? null, after: turnReload.after ?? null };
                report.browser.reloadGenLog = await page.evaluate(() => window.__combGenLog ?? null);
                report.browser.reloadChatTimeline = await page.evaluate(() => (window.__combChatTimeline ?? []).slice(0, 400));
                report.browser.reloadTokenCountLog = await page.evaluate(() => (window.__combTokLog ?? []).slice(0, 200));
                report.browser.reloadPromptError = await page.evaluate(async () => {
                    try {
                        const openai = await import('./scripts/openai.js');
                        return {
                            error: openai.promptManager?.error ?? null,
                            context: openai.oai_settings?.openai_max_context ?? null,
                            maxTokens: openai.oai_settings?.openai_max_tokens ?? null,
                            squash: openai.oai_settings?.squash_system_messages ?? null,
                            tokenizer: openai.oai_settings?.tokenizer ?? null,
                        };
                    } catch (error) { return { threw: String(error?.message ?? error) }; }
                });
                report.browser.reloadFetchLog = await page.evaluate(() => window.__combFetchLog ?? null);
            }
            const reloadTurnCaptured = turnReload !== null && turnReload.requests.length >= 1;
            step('after-reload-turn-captured', reloadTurnCaptured, report.browser.reloadTurn);
            const captureReload = classifyCapture(turnReload?.requests?.[0]);
            step('after-reload-request-carries-surviving-state', reloadTurnCaptured && captureReload?.layout?.slotsPresent === 3 && captureReload?.regexRewritten === true, { layout: captureReload?.layout, regexRewritten: captureReload?.regexRewritten });
            step('after-reload-request-carries-preset-and-regex', reloadTurnCaptured && (captureReload?.presetMarkers ?? []).filter(entry => entry.present).length >= 2 && captureReload?.regexRewritten === true, { preset: captureReload?.presetMarkers, regexRewritten: captureReload?.regexRewritten });
            step('after-reload-request-carries-variables-and-qr', reloadTurnCaptured && captureReload?.variables?.chat === true && captureReload?.qr === true, { variables: captureReload?.variables, qr: captureReload?.qr, quickReply: reloadQR.status });

            // group turn
            await waitForQuiet(page);
            const group = await page.evaluate(async groupId => {
                const groupChats = await import('./scripts/group-chats.js');
                await groupChats.getGroups();
                const groups = groupChats.groups ?? [];
                const target = groups.find(entry => entry.id === groupId) ?? groups[0] ?? null;
                if (!target) return { opened: false, reason: 'no groups listed', count: groups.length };
                let ok = false;
                const openDeadline = Date.now() + 20000;
                while (!ok && Date.now() < openDeadline) {
                    ok = await groupChats.openGroupById(target.id);
                    if (!ok) await new Promise(resolve => setTimeout(resolve, 500));
                }
                const deadline = Date.now() + 30000;
                while (Date.now() < deadline) {
                    const context = window.SillyTavern?.getContext?.();
                    if (context?.groupId || context?.selectedGroup) return { opened: Boolean(ok), groupId: target.id, name: target.name, contextGroup: context?.groupId ?? context?.selectedGroup ?? null };
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                return { opened: Boolean(ok), groupId: target.id, name: target.name, contextGroup: null };
            }, JOURNEY.groupId);
            report.browser.group = group;
            step('group-chat-opened', group.opened === true && group.contextGroup !== null, group);
            const groupBefore = peerRequests().length;
            await waitForTokenizerReady(page);
            // THE GROUP'S FIRST RESPONDER MUST BE DETERMINISTIC. The staged group uses the NATURAL strategy, whose
            // tie-break is a random member order: the Linux run's only capture mismatch was the group turn, with Bob
            // first on GoTavern and Alice first on pinned (the wire is otherwise byte-equal). The frontend's own LIST
            // strategy takes the members in configured order, so set it through the frontend's groups endpoint before
            // the turn -- a user-reachable setting change, not a comparator concession.
            report.browser.groupStrategy = await page.evaluate(async groupId => {
                const groupChats = await import('./scripts/group-chats.js');
                const script = await import('./script.js');
                const target = (groupChats.groups ?? []).find(entry => entry.id === groupId);
                if (!target) return { ok: false, reason: 'group not listed' };
                target.activation_strategy = groupChats.group_activation_strategy.LIST;
                try {
                    const headers = typeof script.getRequestHeaders === 'function' ? script.getRequestHeaders() : { 'Content-Type': 'application/json' };
                    const response = await fetch('/api/groups/edit', { method: 'POST', headers, body: JSON.stringify(target) });
                    return { ok: response.ok, status: response.status, strategy: target.activation_strategy };
                } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
            }, group.groupId);
            step('group-strategy-is-deterministic', report.browser.groupStrategy?.ok === true, report.browser.groupStrategy);
            const groupTurn = await turn(page, 'COMB_GROUP_TURN', 'turn-group');
            report.browser.groupTurn = { requests: groupTurn.requests.length, ok: groupTurn.ok };
            step('group-turn-produced-request', groupTurn.requests.length >= 1, { requests: groupTurn.requests.length });
            // THE GROUP CHAT FILE MUST BE PERSISTED BEFORE THE RETURN TO THE 1:1 CHAT: opening the character switches
            // the chat context, and dispatch 42178757887's pinned leg never wrote the group chat at all (the durable
            // projection had 3 journey files on GoTavern and 2 on pinned) because the switch raced its debounced save.
            report.browser.groupTurnPersist = await persistChatEffect(page, dataRoot, { action: 'group-turn', expectText: 'COMB_GROUP_TURN' });
            step('group-turn-effect-persisted-before-return', report.browser.groupTurnPersist.ok === true, report.browser.groupTurnPersist);
            // RETURN TO THE 1:1 CHAT: the group context has no journey character chat, so the character is opened
            // through the same roster path a user takes and then the saved conversation is reopened by its id.
            // CONFIRM THE CHARACTER BEFORE openCharacterChat: on the Linux run the return path threw
            // "Cannot set properties of undefined (setting 'chat')" inside openCharacterChat because no character was
            // selected yet after the group context, and the helper then could not save a character variable.
            await openCharacter(page, CARD.name);
            const returnedCharacter = await waitForCondition(page, async () => {
                const script = await import('./script.js');
                const context = window.SillyTavern?.getContext?.();
                return { ok: (script.this_chid !== undefined && script.this_chid !== null) || Boolean(context?.characterId), thisChid: script.this_chid ?? null, characterId: context?.characterId ?? null };
            }, { label: 'returned-to-character', timeoutMs: 20000 });
            report.browser.returnedCharacter = returnedCharacter.value ?? returnedCharacter;
            step('returned-to-character', returnedCharacter.ok === true, report.browser.returnedCharacter);
            // THE RETURN PATH IS THE RELOAD PATH A USER TAKES: open the character through the roster, wait for the
            // chat to load, then reopen the saved conversation by id, preferring the same helper the reload phase uses.
            // A single openCharacterChat(evaluate) left chatId null on pinned in run 41367546193, so this is bounded
            // and retried instead of being one blind call.
            let back = { opened: false };
            for (let attempt = 0; attempt < 3 && back.opened !== true; attempt += 1) {
                try {
                    await openCharacter(page, CARD.name);
                    await waitChatLoaded();
                    await page.waitForTimeout(500);
                    const attemptResult = await reopenJourneyChat(page, savedChatId, { minLength: 3, expectText: CARD.regexReplace });
                    back = { ...attemptResult, attempt: attempt + 1 };
                } catch (error) {
                    back = { opened: false, reason: String(error?.message ?? error).slice(0, 300), threw: true, attempt: attempt + 1 };
                }
                if (back.opened !== true) await page.waitForTimeout(1000);
            }
            step('returned-to-journey-chat', back.opened === true, back);
            const finalHelper = await injectVariablesThroughHelper(page);
            const finalQR = await executeJourneyQuickReply(page);
            step('final-helper-reran-and-reinjected-variables', finalHelper.ok === true, finalHelper.done ?? null);

            await waitForTokenizerReady(page);
            const finalTurn = await turn(page, 'COMB_FINAL_TURN', 'turn-final');
            const captureFinal = classifyCapture(finalTurn.requests[0]);
            report.browser.finalCapture = captureFinal;
            step('final-turn-earned-request', finalTurn.requests.length >= 1, { requests: finalTurn.requests.length });

            // ---- STEP 9a: disk state of the journey ------------------------------------------------
            await saveConditional(page);
            report.disk = { chats: await readJourneyChatsNow(), settings: await readSettings(dataRoot) };
            const journeyChats = Object.entries(report.disk.chats).filter(([name]) => name.includes(CARD.chatDirectory) || name.includes('comb'));
            report.disk.journeyChatNames = journeyChats.map(([name]) => name);
            step('journey-chat-written', chatCarrying(report.disk.chats, 'COMB_FINAL_TURN').length > 0 || chatCarrying(report.disk.chats, 'COMB_TURN_1').length > 0, { carrying: chatCarrying(report.disk.chats, 'COMB_') });
            step('disk-chat-carries-regex-rewritten-reply', chatCarrying(report.disk.chats, CARD.regexReplace).length > 0, { carrying: chatCarrying(report.disk.chats, CARD.regexReplace) });
            step('disk-chat-carries-branch-metadata', Object.values(report.disk.chats).some(file => file.messages.some(message => Array.isArray(message.branches) && message.branches.length > 0)) || (branch.created === true), { branch });
            report.disk.projection = chatProjection(report.disk.chats);
            if (profileMode) {
                // THE ORDERED MESSAGE IDS (design section 6/9.2): the persisted/rendered order the duplicate-message
                // control reads, plus the two DOM facts that make a duplicate visible (unique mes ids, count equal to
                // the chat array). Recorded, not asserted against a golden: the comparator compares both subjects and
                // the planted case mutates this record.
                report.browser.orderedMessageIds = await recordOrderedMessageIds(page);
                const ordered = report.browser.orderedMessageIds;
                step('e03e04-ordered-message-ids-recorded', ordered.domIdsUnique === true && ordered.domIdsCoverChat === true && ordered.userMarkers.length > 0, {
                    chatLength: ordered.chatLength,
                    domCount: ordered.domCount,
                    domIdsUnique: ordered.domIdsUnique,
                    domIdsCoverChat: ordered.domIdsCoverChat,
                    userMarkers: ordered.userMarkers.slice(0, 8),
                });
            }
        }

        // THE PRESET SIGNATURES ARE CLASSIFIER INPUT, NOT DRIVE-ONLY DATA. They were computed inside the drive
        // branch, so on the restart and hand-back phases classifyCapture returned an EMPTY presetMarkers list no
        // matter what was on the wire -- the after-restart capture carried MARK_ prompts and satisfied every other
        // guard while "preset markers present" was false on both subjects. The preset file is in the tree, so read it
        // back on the phases that did not plant it.
        if (presetSignatures.length === 0) {
            try {
                const presetPath = path.join(dataRoot, 'default-user', 'OpenAI Settings', 'comb-journey-complex-preset.json');
                const lateDocument = JSON.parse((await fs.readFile(presetPath)).toString('utf8'));
                presetSignatures = (lateDocument.prompts ?? [])
                    .map(entry => String(entry?.content ?? ''))
                    .filter(content => /MARK_[0-9A-Za-z]{4,}/.test(content))
                    .map(content => (content.match(/MARK_[0-9A-Za-z_]+/) ?? [null])[0])
                    .filter(Boolean)
                    .slice(0, 3);
                report.browser.presetSignatures = presetSignatures;
            } catch (error) { report.browser.presetSignaturesError = String(error?.message ?? error); }
        }

        if (phase === 'restart') {
            // ---- STEP 8: a NEW process over the SAME tree reads and continues the journey ----------
            const chats = await readJourneyChats(dataRoot);
            report.disk = { chats, settings: await readSettings(dataRoot) };
            const carrying = chatCarrying(chats, 'COMB_');
            report.browser.carryingChats = carrying;
            step('restart-found-the-journey-chat', carrying.length > 0, { carrying });
            // THE CHAT IS CHOSEN DETERMINISTICALLY. The group chat's file also carries COMB_ markers, and on Linux the
            // directory order put 'Alice - ...' first, so carrying[0] selected the GROUP chat while the character opened
            // was the journey card -- the reopen then reported the saved chat active with one message. Prefer the
            // card's own chat directory, and among those the one with the most messages.
            const restartCardCarrying = carrying.filter(name => name.includes(CARD.chatDirectory));
            const restartPick = (restartCardCarrying.length > 0 ? restartCardCarrying : carrying)
                .slice()
                .sort((left, right) => (chats[right]?.messages?.length ?? 0) - (chats[left]?.messages?.length ?? 0));
            report.browser.pickedChat = restartPick[0] ?? null;
            const chatId = restartPick[0] ? path.basename(restartPick[0], '.jsonl') : null;
            await openCharacter(page, CARD.name);
            await waitChatLoaded();
            const handbackWorld = await selectJourneyWorlds(page, dataRoot);
            report.browser.handbackWorldSelection = handbackWorld;
            step('handback-world-info-selected', handbackWorld.ok === true, handbackWorld);
            report.browser.handbackPreset = await selectPresetThroughControl(page, presetName);
            const reopened = await reopenJourneyChat(page, chatId, { minLength: 3, expectText: 'COMB_' });
            report.browser.reopened = reopened;
            step('restart-reopened-the-saved-chat', reopened.opened === true, reopened);
            report.browser.restartPersona = await setJourneyUserName(page, 'Probe User');
            report.browser.handbackReconnected = await connect();
            await waitForQuiet(page);
            step('restart-chat-ready', reopened.satisfied === true, { satisfied: reopened.satisfied, precondition: reopened.precondition, chatLength: reopened.chatLength, lastText: reopened.lastText });
            report.browser.restartPromptArmed = await waitForArmedPromptManager(page, { markerNeedle: ARMED_MARKER_NEEDLE });
            step('restart-prompt-manager-armed', report.browser.restartPromptArmed.armed === true, report.browser.restartPromptArmed);
            // A NEW PROCESS HAS NO IN-MEMORY INJECTIONS EITHER: the installed helper re-runs and the user re-clicks
            // the QR. What must survive is the VARIABLES themselves, the preset selection, the world-info selection,
            // the author's note (chat metadata) and the banked history.
            const restartWorld = await selectJourneyWorlds(page, dataRoot);
            report.browser.restartWorldSelection = restartWorld;
            step('restart-world-info-selected', restartWorld.ok === true, restartWorld);
            report.browser.restartPreset = await selectPresetThroughControl(page, presetName);
            report.browser.restartReconnected = await connect();
            const restartHelper = await injectVariablesThroughHelper(page);
            const restartQR = await executeJourneyQuickReply(page);
            const restartInjections = await verifyInjectionPrompts(page);
            report.browser.restartInjections = restartInjections;
            step('restart-injections-active-in-page', restartInjections.variables?.present === true && restartInjections.variables?.hasValue === true, restartInjections);
            report.browser.restartHelper = { ok: restartHelper.ok, payload: restartHelper.payload, done: restartHelper.done };
            step('after-restart-helper-reran', restartHelper.ok === true, restartHelper.done ?? null);
            const restartTokenizer = await waitForTokenizerReady(page);
            step('restart-tokenizer-ready', restartTokenizer.ok === true, restartTokenizer);
            // THE RELOAD PHASE SAID THIS ORDER MATTERS AND THE RESTART PHASE DID NOT DO IT: the last thing before a
            // send must be the preset/world selection and the connection, because the helper re-run and the QR
            // execute page code that can leave the prompt manager on the default order. restart-prompt-manager-armed
            // was measured BEFORE the injections, and the capture then carried world-info slots but no preset
            // markers at all (both subjects identically). Re-assert here, last, and assert the armed state again.
            report.browser.restartWorldFinal = await selectJourneyWorlds(page, dataRoot);
            report.browser.restartPresetFinal = await selectPresetThroughControl(page, presetName);
            report.browser.restartReconnectedFinal = await connect();
            await waitForQuiet(page);
            report.browser.restartPromptArmedFinal = await waitForArmedPromptManager(page, { markerNeedle: ARMED_MARKER_NEEDLE });
            step('restart-ready-to-send', report.browser.restartPromptArmedFinal.armed === true
                && report.browser.restartPresetFinal.ok === true, { armed: report.browser.restartPromptArmedFinal, preset: report.browser.restartPresetFinal, world: report.browser.restartWorldFinal });
            if (profileMode) {
                report.browser.restartPresetApplied = await readPresetAppliedState(page, expectedPresetApplication());
                step('e03e04-restart-preset-applied-to-prompt-manager', report.browser.restartPresetApplied.ok === true, report.browser.restartPresetApplied);
            }
        const resumed = await turn(page, 'COMB_TURN_AFTER_RESTART', 'turn-after-restart');
            const captureResumed = classifyCapture(resumed.requests[0]);
            report.browser.resumed = { requests: resumed.requests.length, after: resumed.after };
            step('after-restart-request-captured', resumed.requests.length >= 1, { requests: resumed.requests.length });
            step('after-restart-request-carries-preset-and-world-info', captureResumed?.layout?.slotsPresent === 3 && (captureResumed?.presetMarkers ?? []).some(entry => entry.present), { layout: captureResumed?.layout, preset: captureResumed?.presetMarkers });
            step('after-restart-request-carries-history', String(resumed.requests[0]?.body ?? '').includes('COMB_TURN_'), { historyMarkers: (String(resumed.requests[0]?.body ?? '').match(/COMB_[A-Z_]+/g) ?? []).slice(0, 8) });
            step('after-restart-request-carries-variables-and-qr', captureResumed?.variables?.chat === true && captureResumed?.qr === true, { variables: captureResumed?.variables, qr: captureResumed?.qr, quickReply: restartQR.status });
            step('after-restart-request-carries-authors-note', captureResumed?.anMarker === true, { anMarker: captureResumed?.anMarker });
            step('after-restart-request-carries-regex-rewritten-history', captureResumed?.regexRewritten === true, { regexRewritten: captureResumed?.regexRewritten });
            await saveConditional(page);
            report.disk.afterRestart = await readJourneyChats(dataRoot);
        }

        if (phase === 'handback') {
            // ---- STEP 9b: pinned Node over the GoTavern-written tree ------------------------------
            const chats = await readJourneyChats(dataRoot);
            report.disk = { chats, settings: await readSettings(dataRoot) };
            const carrying = chatCarrying(chats, 'COMB_');
            report.browser.carryingChats = carrying;
            step('handback-tree-has-the-journey-chat', carrying.length > 0, { carrying });
            const handbackCardCarrying = carrying.filter(name => name.includes(CARD.chatDirectory));
            const handbackPick = (handbackCardCarrying.length > 0 ? handbackCardCarrying : carrying)
                .slice()
                .sort((left, right) => (chats[right]?.messages?.length ?? 0) - (chats[left]?.messages?.length ?? 0));
            report.browser.handbackPickedChat = handbackPick[0] ?? null;
            const chatId = handbackPick[0] ? path.basename(handbackPick[0], '.jsonl') : null;
            await openCharacter(page, CARD.name);
            await waitChatLoaded();
            const handbackWorld = await selectJourneyWorlds(page, dataRoot);
            report.browser.handbackWorldSelection = handbackWorld;
            step('handback-world-info-selected', handbackWorld.ok === true, handbackWorld);
            const reopened = await reopenJourneyChat(page, chatId, { minLength: 3, expectText: 'COMB_' });
            report.browser.reopened = reopened;
            step('handback-opened-the-gotavern-chat', reopened.opened === true, reopened);
            report.browser.handbackPersona = await setJourneyUserName(page, 'Probe User');
            report.browser.handbackReconnected = await connect();
            await waitForQuiet(page);
            step('handback-chat-ready', reopened.satisfied === true, { satisfied: reopened.satisfied, precondition: reopened.precondition, chatLength: reopened.chatLength, lastText: reopened.lastText });
            report.browser.handbackPromptArmed = await waitForArmedPromptManager(page, { markerNeedle: ARMED_MARKER_NEEDLE });
            step('handback-prompt-manager-armed', report.browser.handbackPromptArmed.armed === true, report.browser.handbackPromptArmed);
            if (profileMode) {
                report.browser.handbackPresetApplied = await readPresetAppliedState(page, expectedPresetApplication());
                step('e03e04-handback-preset-applied-to-prompt-manager', report.browser.handbackPresetApplied.ok === true, report.browser.handbackPresetApplied);
            }
            const before = await readPageState(page);
            report.browser.handbackBefore = before;
            step('handback-read-gotavern-history', before.chatLength > 5 && before.lastText.includes('COMB_'), { chatLength: before.chatLength, lastText: before.lastText.slice(0, 120) });
            const handbackTokenizer = await waitForTokenizerReady(page);
        step('handback-tokenizer-ready', handbackTokenizer.ok === true, handbackTokenizer);
        const continued = await turn(page, 'COMB_HANDED_BACK_TURN', 'turn-handback');
            step('handback-continued-and-reached-provider', continued.requests.length >= 1, { requests: continued.requests.length });
            await saveConditional(page);
            const after = await readJourneyChats(dataRoot);
            report.disk.after = after;
            step('handback-persisted-its-turn', chatCarrying(after, 'COMB_HANDED_BACK_TURN').length > 0, { carrying: chatCarrying(after, 'COMB_HANDED_BACK_TURN') });
            report.browser.handbackAfter = await readPageState(page);
        }
    } catch (error) {
        report.failure = String(error?.stack ?? error);
        console.error(`[${subject}/${phase}] FAILURE: ${report.failure.slice(0, 1200)}`);
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (peer) await peer.close().catch(() => {});
        if (server?.server) server.server.kill('SIGKILL');
        // ARTIFACT IDENTITY, written even on a failed drive (a red leg's artifact must still say WHICH tree/profile
        // it measured). `designed` values come from the command line; the profile digests come from the staged record
        // when the staging step got that far. The comparator's artifact guards require these fields, and a
        // fail-closed `--verify-artifact` mode refuses a missing/ill-formed identity.
        const stagedRecord = report.e03e04?.record ?? null;
        report.identity = {
            kind: 'combination-journey-leg',
            schemaVersion: 1,
            headSha: process.env.GITHUB_SHA ?? null,
            pinnedSha: process.env.PINNED_BASELINE_COMMIT ?? null,
            profile: profileMode ?? 'none',
            tier: profileMode ? (stagedRecord?.tier ?? tierArgument) : null,
            seed: profileMode ? (stagedRecord?.seed ?? seedArgument) : null,
            extensionTier: profileMode ? (stagedRecord?.extensionTier ?? extensionTierArgument) : null,
            blockCount: profileMode ? (stagedRecord?.blockCount ?? E03E04_TIERS[tierArgument]) : null,
            nonce,
            phase,
            subject,
            digests: stagedRecord
                ? {
                    // `preset` is the STAGED document's digest (what the page read); `kitPreset` is the unmodified M1
                    // kit document's digest. The selector's order-row correction is the only difference.
                    preset: stagedRecord.preset?.sha256 ?? null,
                    kitPreset: stagedRecord.preset?.kitSha256 ?? null,
                    expectedOrder: stagedRecord.expectedOrderSha256 ?? null,
                    cardCharacterBook: stagedRecord.cardCharacterBook?.sha256 ?? null,
                    settingsPatch: stagedRecord.settingsPatch?.sha256 ?? null,
                }
                : null,
            promptOrder: stagedRecord?.preset
                ? {
                    characterIds: stagedRecord.preset.promptOrderCharacterIds ?? null,
                    activeCharacterId: stagedRecord.preset.activePromptOrderCharacterId ?? null,
                    declaredPrompts: stagedRecord.preset.declaredPrompts ?? null,
                    activeOrderLength: stagedRecord.preset.activeOrderLength ?? null,
                }
                : null,
        };
        report.summary = {
            steps: report.steps.length,
            failedSteps: report.steps.filter(entry => !entry.ok).map(entry => entry.name),
            requestCount: peerRequests().length,
            profile: profileMode ?? 'none',
            tier: profileMode ? report.identity.tier : null,
            extensionTier: profileMode ? report.identity.extensionTier : null,
            extensionCount: report.extensions?.installedCount ?? null,
        };
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        console.error(`[${subject}/${phase}] ${report.steps.length} step(s), ${report.summary.failedSteps.length} failed${report.summary.failedSteps.length ? ` [${report.summary.failedSteps.join(', ')}]` : ''}`);
        console.error(`report: ${reportPath}`);
        if (report.failure || report.summary.failedSteps.length > 0) process.exitCode = 1;
    }
}

await main();
