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
//   node tests/browser/run-against-pinned.mjs combination-journey-probe.mjs -- --data-root <tree> --report <json> --handback
// The GoTavern restart leg is the same command with --after-restart.

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
    CARD, JOURNEY, chatCarrying, chatProjection, readChatFiles as readJourneyChats, readSettings,
    stageJourneyCard, stageJourneyGroups, stageJourneyWorldBook,
} from './extensions/combination-journey-kit.mjs';
import { MARKERS as WI_MARKERS, extractLayout } from './worldinfo-slots-kit.mjs';
import { applyAuthorsNoteOverlay, authorsNoteOverlaySpec, resolveAuthorsNoteCase } from './preset-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

const dataRoot = path.resolve(argumentValue(process.argv, '--data-root') ?? '');
if (!argumentValue(process.argv, '--data-root')) {
    console.error('usage: node combination-journey-probe.mjs --data-root <tree> --report <json> [--after-restart|--handback]');
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

const peerRequests = () => peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? ''));
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
        openai.oai_settings.openai_max_context = 8192;
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
            promptCount: Array.isArray(pm.prompts) ? pm.prompts.length : null,
            collection,
            enabled,
            disabled,
            thisChid: script.this_chid ?? null,
            contextChid: (window.SillyTavern?.getContext?.()?.characterId ?? null),
        };
    });
}


/** Wait (bounded) until the prompt manager's NORMAL collection is the character's, not the dummy fallback. */
async function waitForArmedPromptManager(page, { minimum = 8, timeoutMs = 30000 } = {}) {
    const started = Date.now();
    let last = null;
    while (Date.now() - started < timeoutMs) {
        last = await page.evaluate(async () => {
            const openai = await import('./scripts/openai.js');
            const script = await import('./script.js');
            const pm = openai.promptManager;
            if (!pm) return { available: false };
            let count = null;
            let identifiers = null;
            try {
                const collection = pm.getPromptCollection('normal');
                const prompts = Array.isArray(collection?.collection) ? collection.collection : [];
                count = prompts.length;
                identifiers = prompts.map(prompt => prompt?.identifier ?? null);
            } catch (error) { return { available: true, error: String(error?.message ?? error) }; }
            return { available: true, promptCount: count, identifiers, activeCharacter: pm.activeCharacter ?? null, chid: script.this_chid ?? null };
        });
        const identifiers = last?.identifiers ?? [];
        const required = ['chatHistory', 'worldInfoBefore', 'main'];
        const armed = last?.available === true && Number(last?.promptCount) >= minimum && required.every(identifier => identifiers.includes(identifier));
        if (armed) {
            // STABILITY WINDOW: keep sampling for 2.5 s; a later sample that is not armed restarts the window.
            const stableSince = Date.now();
            let stable = true;
            while (Date.now() - stableSince < 2500) {
                await page.waitForTimeout(250);
                const again = await page.evaluate(async () => {
                    const openai = await import('./scripts/openai.js');
                    const collection = openai.promptManager?.getPromptCollection('normal');
                    const prompts = Array.isArray(collection?.collection) ? collection.collection : [];
                    return { count: prompts.length, identifiers: prompts.map(prompt => prompt?.identifier ?? null) };
                });
                const stillArmed = Number(again?.count) >= minimum && required.every(identifier => (again?.identifiers ?? []).includes(identifier));
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
        const presetName = 'comb-journey-complex-preset';
        let presetDocument = null;
        let presetSource = null;
        if (phase === 'drive') {
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
        } else {
            report.fixture = { reused: true };
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
        page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
        await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
        await openPage(page, baseURL);
        const peerURL = `http://127.0.0.1:${peer.port}/v1`;
        const connect = () => applyConnectionState(page, peerURL);
        report.browser.connect = await connect();
        // THE WORLD BOOK IS SELECTED THROUGH THE FRONTEND AFTER BOOT, on every phase: the pre-boot settings write is
        // overwritten by both servers' booting (measured on pinned: turn-1 slots 0). This is the product's own
        // selection path and the disk member it persists is polled, not assumed.
        const bootWorldSelection = await selectWorldBookAfterBoot(page, dataRoot, JOURNEY_WORLD);
        report.browser.worldSelectionAfterBoot = bootWorldSelection;
        step('world-info-selected-after-boot', bootWorldSelection.ok === true, bootWorldSelection);
        step('world-info-persisted-after-boot', Array.isArray(bootWorldSelection.persistedGlobalSelect) && bootWorldSelection.persistedGlobalSelect.includes(JOURNEY_WORLD), bootWorldSelection);
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
            const world = await selectWorldBookAfterBoot(page, dataRoot, JOURNEY_WORLD);
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
                return { ok: true, selected: openai.oai_settings.preset_settings_openai ?? null, prompts: (openai.oai_settings.promptManager?.prompts ?? []).length, optionValue: option.value };
            }, presetName);
            report.browser.preset = { name: presetName, plantedSha: sha256(presetSource), structure: { prompts: (presetDocument.prompts ?? []).length, orderRows: (presetDocument.prompt_order ?? []).flatMap(row => row.order ?? []).length }, selected };
            // THE PRESET'S OWN LITERAL PIECES: from the planted bytes, the first three non-empty prompt bodies that
            // carry a marker-shaped token (the derivation's `MARK_` strings). A placed preset must put them on the
            // wire; a preset selection that did nothing cannot.
            presetSignatures = (presetDocument.prompts ?? [])
                .map(entry => String(entry?.content ?? ''))
                .filter(content => /MARK_[0-9A-Za-z]{4,}/.test(content))
                .map(content => (content.match(/MARK_[0-9A-Za-z_]+/) ?? [null])[0])
                .filter(Boolean)
                .slice(0, 3);
            report.browser.presetSignatures = presetSignatures;
            step('complex-preset-selected', selected.ok === true && String(selected.selected ?? '').toLowerCase().includes('comb-journey'), selected);

            // ---- STEP 2b: author's note through the frontend's own module ----------------------------
            const anSpec = resolveAuthorsNoteCase(authorsNoteOverlaySpec(), 'parity');
            const anApplied = await page.evaluate(applyAuthorsNoteOverlay, anSpec);
            report.browser.authorsNote = { spec: anSpec, applied: anApplied };
            step('authors-note-applied', anApplied?.problems?.length === 0, anApplied);

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

            // ---- STEP 3: the armed streamed turn -----------------------------------------------------
            report.browser.promptManagerArmed = await readPromptManagerState(page);
            const turn1 = await turn(page, 'COMB_TURN_1', 'turn-1-armed');
            const capture1 = classifyCapture(turn1.requests[0]);
            report.browser.turn1 = { ok: turn1.ok, replied: turn1.replied, after: turn1.after };
            step('turn-1-request-captured', turn1.requests.length >= 1, { requests: turn1.requests.length });
            step('turn-1-streaming-requested', capture1?.requestedStream === true && capture1?.servedWire === 'sse', { requestedStream: capture1?.requestedStream, served: capture1?.servedWire });
            step('turn-1-preset-pieces-in-request', presetSignatures.length >= 2 && (capture1?.presetMarkers ?? []).filter(entry => entry.present).length >= 2, { signatures: presetSignatures, found: capture1?.presetMarkers });
            step('turn-1-world-info-three-slots-placed', capture1?.layout?.slotsPresent === 3 && capture1?.layout?.positions?.depth !== null, capture1?.layout);
            step('turn-1-variables-in-request', capture1?.variables?.chat === true && capture1?.variables?.global === true && capture1?.variables?.character === true, capture1?.variables);
            step('turn-1-quick-reply-in-request', capture1?.qr === true, { qr: capture1?.qr });
            step('turn-1-authors-note-in-request', capture1?.anMarker === true, { anMarker: capture1?.anMarker });

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
            const swipeBefore = await readPageState(page);
            const swipe = await page.evaluate(async () => {
                const script = await import('./script.js');
                const chat = script.chat ?? [];
                window.__combSwipeBefore = { chatLength: chat.length, lastText: String(chat[chat.length - 1]?.mes ?? '') };
                const allowed = typeof script.isSwipingAllowed === 'function' ? script.isSwipingAllowed() : null;
                const container = document.querySelector('#chat .mes:last-child');
                const control = container?.querySelector('.swipe_right') ?? container?.querySelector('[data-i18n="Right"]');
                if (!control) return { pressed: false, allowed, reason: 'no swipe-right control on the last message' };
                control.click();
                return { pressed: true, allowed };
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
            const controlWorld = await selectWorldBookAfterBoot(page, dataRoot, JOURNEY_WORLD);
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
            await selectWorldBookAfterBoot(page, dataRoot, JOURNEY_WORLD);
            await waitForQuiet(page);
            step('preset-restored-after-control', presetRestored.ok === true, presetRestored);
            // SECOND ARM, SEPARATE SEGMENT: a fresh page, armed preset, then the world book is cleared in-page for the
            // control turn. The reset is what keeps a wedged composer from the first arm out of this one.
            report.browser.wiSegmentReset = await resetPageAndReopen((await readPageState(page)).chatId);
            report.browser.wiSegmentWorld = await selectWorldBookAfterBoot(page, dataRoot, JOURNEY_WORLD);
            report.browser.wiSegmentPreset = await selectPresetThroughControl(page, presetName);

            const wiOff = await page.evaluate(async () => {
                const worldInfo = await import('./scripts/world-info.js');
                const before = Array.isArray(worldInfo.selected_world_info) ? worldInfo.selected_world_info.slice() : null;
                window.__combWorldSelection = before;
                if (Array.isArray(worldInfo.selected_world_info)) worldInfo.selected_world_info.length = 0;
                return { before, after: Array.isArray(worldInfo.selected_world_info) ? worldInfo.selected_world_info.slice() : null };
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

            const wiRestored = await selectWorldBookAfterBoot(page, dataRoot, JOURNEY_WORLD);
            report.browser.wiRestore = wiRestored;
            step('world-info-restored-after-control', wiRestored.ok === true && Array.isArray(wiRestored.persistedGlobalSelect) && wiRestored.persistedGlobalSelect.includes(JOURNEY_WORLD), wiRestored);
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
            page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
            await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
            report.browser.reloadNewTab = true;
            await openPage(page, baseURL);
            await connect();
            // THE ORDER A USER TAKES AFTER A RELOAD: re-select the preset, restore the world selection, open the
            // character, REOPEN THE SAVED CHAT BY ITS ID (and prove it is active with its history), re-assert the
            // persona binding (the character open cleared it), and re-apply the peer connection LAST. Sending before
            // the chat is active is what produced a system-only 11864-byte assembly with no history.
            const reloadPreset = await selectPresetThroughControl(page, presetName);
            const reloadWorld = await selectWorldBookAfterBoot(page, dataRoot, JOURNEY_WORLD);
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
            step('reload-world-info-persisted-from-disk', Array.isArray(reloadPersisted.globalSelect) && reloadPersisted.globalSelect.includes(JOURNEY_WORLD), reloadPersisted.globalSelect ?? null);
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
            report.browser.reloadPromptArmed = await waitForArmedPromptManager(page);
            step('reload-prompt-manager-armed', report.browser.reloadPromptArmed.armed === true, report.browser.reloadPromptArmed);
            await page.evaluate(async () => {
                const script = await import('./script.js');
                const events = await import('./scripts/events.js');
                window.__combGenLog = [];
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
                            at: Date.now(),
                        });
                    } catch (error) { window.__combGenLog.push({ event, error: String(error?.message ?? error) }); }
                };
                events.eventSource.on(events.event_types.GENERATION_STARTED, (...args) => record('GENERATION_STARTED', args));
                events.eventSource.on(events.event_types.GENERATION_AFTER_COMMANDS, (...args) => record('GENERATION_AFTER_COMMANDS', args));
                events.eventSource.on(events.event_types.GENERATION_ENDED, (...args) => record('GENERATION_ENDED', args));
                events.eventSource.on(events.event_types.GENERATE_AFTER_DATA, (data, dryRun) => {
                    try {
                        window.__combGenLog.push({
                            event: 'GENERATE_AFTER_DATA', dryRun,
                            keys: Object.keys(data ?? {}),
                            promptLength: typeof data?.prompt === 'string' ? data.prompt.length : null,
                            promptArrayLength: Array.isArray(data?.prompt) ? data.prompt.length : null,
                            promptRoles: Array.isArray(data?.prompt) ? data.prompt.map(entry => entry?.role ?? null).slice(0, 20) : null,
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
                turnReload = await turn(page, 'COMB_TURN_AFTER_RELOAD', 'turn-after-reload');
                report.browser.reloadTurn = { matched: turnReload.requests.length, noGenerationRequest: turnReload.noGenerationRequest === true, seen: turnReload.seen ?? null, recovered: turnReload.recovered ?? null, baseline: turnReload.baseline ?? null, sent: turnReload.sent ?? null, after: turnReload.after ?? null };
                report.browser.reloadGenLog = await page.evaluate(() => window.__combGenLog ?? null);
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
            const groupTurn = await turn(page, 'COMB_GROUP_TURN', 'turn-group');
            report.browser.groupTurn = { requests: groupTurn.requests.length, ok: groupTurn.ok };
            step('group-turn-produced-request', groupTurn.requests.length >= 1, { requests: groupTurn.requests.length });
            // RETURN TO THE 1:1 CHAT: the group context has no journey character chat, so the character is opened
            // through the same roster path a user takes and then the saved conversation is reopened by its id.
            await openCharacter(page, CARD.name);
            let back;
            try {
            back = await page.evaluate(async wanted => {
                const script = await import('./script.js');
                const groupChats = await import('./scripts/group-chats.js');
                if (typeof groupChats.resetSelectedGroup === 'function') groupChats.resetSelectedGroup();
                await new Promise(resolve => setTimeout(resolve, 300));
                await script.openCharacterChat(wanted);
                const deadline = Date.now() + 30000;
                while (Date.now() < deadline) {
                    const context = window.SillyTavern?.getContext?.();
                    if (context?.chatId === wanted && (script.chat ?? []).length > 0) return { opened: true, chatId: context.chatId, chatLength: script.chat.length };
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                return { opened: false, wanted, chatId: window.SillyTavern?.getContext?.()?.chatId ?? null };
            }, savedChatId);
            } catch (error) {
                back = { opened: false, reason: String(error?.message ?? error).slice(0, 300), threw: true };
            }
            step('returned-to-journey-chat', back.opened === true, back);
            const finalHelper = await injectVariablesThroughHelper(page);
            const finalQR = await executeJourneyQuickReply(page);
            step('final-helper-reran-and-reinjected-variables', finalHelper.ok === true, finalHelper.done ?? null);

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
        }

        if (phase === 'restart') {
            // ---- STEP 8: a NEW process over the SAME tree reads and continues the journey ----------
            const chats = await readJourneyChats(dataRoot);
            report.disk = { chats, settings: await readSettings(dataRoot) };
            const carrying = chatCarrying(chats, 'COMB_');
            report.browser.carryingChats = carrying;
            step('restart-found-the-journey-chat', carrying.length > 0, { carrying });
            const chatId = carrying[0] ? path.basename(carrying[0], '.jsonl') : null;
            await openCharacter(page, CARD.name);
            await waitChatLoaded();
            const handbackWorld = await selectWorldBookAfterBoot(page, dataRoot, JOURNEY_WORLD);
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
            report.browser.restartPromptArmed = await waitForArmedPromptManager(page);
            step('restart-prompt-manager-armed', report.browser.restartPromptArmed.armed === true, report.browser.restartPromptArmed);
            // A NEW PROCESS HAS NO IN-MEMORY INJECTIONS EITHER: the installed helper re-runs and the user re-clicks
            // the QR. What must survive is the VARIABLES themselves, the preset selection, the world-info selection,
            // the author's note (chat metadata) and the banked history.
            const restartWorld = await selectWorldBookAfterBoot(page, dataRoot, JOURNEY_WORLD);
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
            const chatId = carrying[0] ? path.basename(carrying[0], '.jsonl') : null;
            await openCharacter(page, CARD.name);
            await waitChatLoaded();
            const handbackWorld = await selectWorldBookAfterBoot(page, dataRoot, JOURNEY_WORLD);
            report.browser.handbackWorldSelection = handbackWorld;
            step('handback-world-info-selected', handbackWorld.ok === true, handbackWorld);
            const reopened = await reopenJourneyChat(page, chatId, { minLength: 3, expectText: 'COMB_' });
            report.browser.reopened = reopened;
            step('handback-opened-the-gotavern-chat', reopened.opened === true, reopened);
            report.browser.handbackPersona = await setJourneyUserName(page, 'Probe User');
            report.browser.handbackReconnected = await connect();
            await waitForQuiet(page);
            step('handback-chat-ready', reopened.satisfied === true, { satisfied: reopened.satisfied, precondition: reopened.precondition, chatLength: reopened.chatLength, lastText: reopened.lastText });
            report.browser.handbackPromptArmed = await waitForArmedPromptManager(page);
            step('handback-prompt-manager-armed', report.browser.handbackPromptArmed.armed === true, report.browser.handbackPromptArmed);
            const before = await readPageState(page);
            report.browser.handbackBefore = before;
            step('handback-read-gotavern-history', before.chatLength > 5 && before.lastText.includes('COMB_'), { chatLength: before.chatLength, lastText: before.lastText.slice(0, 120) });
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
        report.summary = {
            steps: report.steps.length,
            failedSteps: report.steps.filter(entry => !entry.ok).map(entry => entry.name),
            requestCount: peerRequests().length,
        };
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        console.error(`[${subject}/${phase}] ${report.steps.length} step(s), ${report.summary.failedSteps.length} failed${report.summary.failedSteps.length ? ` [${report.summary.failedSteps.join(', ')}]` : ''}`);
        console.error(`report: ${reportPath}`);
        if (report.failure || report.summary.failedSteps.length > 0) process.exitCode = 1;
    }
}

await main();
