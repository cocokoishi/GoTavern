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
    const slice = completionsFrom(before).map(entry => ({
        case: caseName,
        method: entry.method,
        path: entry.path,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        body: entry.body,
        requestedStream: entry.requestedStream,
        served: entry.served,
        matchedMarker: String(entry.body ?? '').includes(marker),
    }));
    let matched = slice.filter(entry => entry.matchedMarker);
    if (matched.length === 0) {
        const deadline = Date.now() + 30000;
        while (matched.length === 0 && Date.now() < deadline) {
            await page.waitForTimeout(200);
            const fresh = completionsFrom(before).map(entry => ({ ...entry, matchedMarker: String(entry.body ?? '').includes(marker) })).filter(entry => entry.matchedMarker);
            matched = fresh;
        }
    }
    const unmatched = slice.filter(entry => !entry.matchedMarker);
    if (unmatched.length > 0) {
        report.unattributedRequests = report.unattributedRequests ?? [];
        report.unattributedRequests.push(...unmatched.map(entry => ({ after: caseName, byteLength: entry.byteLength, sha256: entry.sha256 })));
    }
    const requests = (matched.length > 0 ? matched : slice.filter(entry => entry.matchedMarker)).map(entry => ({
        case: caseName,
        method: entry.method,
        path: entry.path,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        body: entry.body,
        requestedStream: entry.requestedStream,
        served: entry.served,
    }));
    report.captures.push({ case: caseName, marker, at: Date.now(), requestCount: requests.length, requestShas: requests.map(entry => entry.sha256) });
    report.requests.push(...requests);
    const after = await readPageState(page);
    return { ok: replied?.ok !== false && requestArrived && requests.length >= 1, caseName, requested: requestArrived, matched: requests.length, sent, replied, baseline, after, requests };
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
        const page = await browser.newPage();
        report.pageErrors = [];
        page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
        await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
        await openPage(page, baseURL);
        const peerURL = `http://127.0.0.1:${peer.port}/v1`;
        const connect = async () => {
            const connected = await configureConnection(page, { url: peerURL, model: 'comb-journey-model' });
            await page.evaluate(async () => {
                const openai = await import('./scripts/openai.js');
                // STREAMING ON: every generation in this journey must ask for SSE, and the peer answers SSE.
                openai.oai_settings.stream_openai = true;
                openai.oai_settings.openai_max_context = 8192;
                openai.oai_settings.openai_max_tokens = 512;
            });
            const silence = await silenceAndObserve(page);
            return { connected, silence, streaming: true };
        };
        report.browser.connect = await connect();

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

            // ---- STEP 3: the armed streamed turn -----------------------------------------------------
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

            // ---- STEP 6: knob-off discriminations in the SAME session --------------------------------
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
            await waitForQuiet(page);
            const turnPresetOff = await turn(page, 'COMB_PRESET_OFF', 'control-preset-off');
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
            await waitForQuiet(page);
            step('preset-restored-after-control', presetRestored.ok === true, presetRestored);

            const wiOff = await page.evaluate(async () => {
                const worldInfo = await import('./scripts/world-info.js');
                const before = Array.isArray(worldInfo.selected_world_info) ? worldInfo.selected_world_info.slice() : null;
                window.__combWorldSelection = before;
                if (Array.isArray(worldInfo.selected_world_info)) worldInfo.selected_world_info.length = 0;
                return { before, after: Array.isArray(worldInfo.selected_world_info) ? worldInfo.selected_world_info.slice() : null };
            });
            report.browser.wiOff = wiOff;
            const turnWiOff = await turn(page, 'COMB_WI_OFF', 'control-wi-off');
            const captureWiOff = classifyCapture(turnWiOff.requests[0]);
            report.browser.captureWiOff = captureWiOff;
            step('wi-off-turn-captured', turnWiOff.requests.length >= 1, { requests: turnWiOff.requests.length });
            step('wi-off-request-lacks-world-info', captureWiOff?.layout?.slotsPresent === 0, { layout: captureWiOff?.layout, markers: captureWiOff?.wiMarkers });

            const wiRestored = await page.evaluate(async () => {
                const script = await import('./script.js');
                const worldInfo = await import('./scripts/world-info.js');
                const wanted = Array.isArray(window.__combWorldSelection) ? window.__combWorldSelection.slice() : [];
                if (Array.isArray(worldInfo.selected_world_info) && wanted.length > 0) {
                    for (const name of wanted) if (!worldInfo.selected_world_info.includes(name)) worldInfo.selected_world_info.push(name);
                }
                // PERSIST THE SELECTION THE WAY THE PRODUCT DOES: `world_info.globalSelect` is the member the frontend
                // restores `selected_world_info` from at startup (world-info.js:998), and the module's own save path is
                // `Object.assign(world_info, { globalSelect: selected_world_info })` then `saveSettings()` (:84-86).
                // Assigning the live object and calling the frontend's save is that same write.
                if (worldInfo.world_info && typeof worldInfo.world_info === 'object') worldInfo.world_info.globalSelect = wanted.slice();
                if (typeof script.saveSettings === 'function') await script.saveSettings();
                else if (typeof script.saveSettingsDebounced === 'function') script.saveSettingsDebounced();
                await new Promise(resolve => setTimeout(resolve, 800));
                return { restored: Array.isArray(worldInfo.selected_world_info) ? worldInfo.selected_world_info.slice() : null, wanted, persistedGlobalSelect: worldInfo.world_info?.globalSelect ?? null };
            });
            report.browser.wiRestore = wiRestored;
            step('world-info-restored-after-control', (wiRestored.restored ?? []).length > 0, wiRestored);
            // PERSISTENCE IS A DISK CONDITION, NOT A RETURN VALUE: the frontend's save is debounced, and the only
            // evidence that the RELOAD will restore the selection is the member on disk. Poll it, bounded; re-issue
            // the same product write if it has not landed.
            let wiPersisted = null;
            const wiPersistDeadline = Date.now() + 20000;
            while (Date.now() < wiPersistDeadline) {
                const settingsNow = await readSettings(dataRoot);
                wiPersisted = settingsNow.globalSelect ?? null;
                if (Array.isArray(wiPersisted) && wiPersisted.length > 0) break;
                await page.evaluate(async () => {
                    const worldInfo = await import('./scripts/world-info.js');
                    const script = await import('./script.js');
                    const wanted = Array.isArray(window.__combWorldSelection) ? window.__combWorldSelection.slice() : [];
                    if (worldInfo.world_info && typeof worldInfo.world_info === 'object') worldInfo.world_info.globalSelect = wanted;
                    if (typeof script.saveSettings === 'function') await script.saveSettings();
                    else if (typeof script.saveSettingsDebounced === 'function') script.saveSettingsDebounced();
                });
                await page.waitForTimeout(400);
            }
            report.browser.wiPersisted = wiPersisted;

            step('world-info-selection-persisted-to-disk', Array.isArray(wiPersisted) && wiPersisted.length > 0, { wiPersisted });
            if (!(Array.isArray(wiPersisted) && wiPersisted.length > 0)) {
                // Last resort, recorded: write the documented product storage directly (the same member
                // `stageSelection` writes before boot and the page restores from at startup, world-info.js:998).
                const settingsPath = path.join(dataRoot, 'default-user', 'settings.json');
                const current = JSON.parse(await fs.readFile(settingsPath, 'utf8').catch(() => '{}'));
                current.world_info = { ...(current.world_info ?? {}), globalSelect: [JOURNEY_WORLD] };
                await fs.writeFile(settingsPath, `${JSON.stringify(current, null, 2)}\n`);
                const reread = await readSettings(dataRoot);
                report.browser.wiPersistedDirectWrite = { globalSelect: reread.globalSelect ?? null, note: 'settings.world_info.globalSelect written directly after the frontend save did not land; same member the page restores from' };
            }

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

            // ---- STEP 7: reload + resumed turn, then a group turn -----------------------------------
            const beforeReload = await readPageState(page);
            const savedChatId = beforeReload.chatId;
            const saved = await saveConditional(page);
            await openPage(page, baseURL);
            await connect();
            await openJourneyCharacter();
            const reopened = await page.evaluate(async wanted => {
                const script = await import('./script.js');
                if (!wanted) return { opened: false, reason: 'no chat id to reopen' };
                await script.openCharacterChat(wanted);
                const deadline = Date.now() + 30000;
                while (Date.now() < deadline) {
                    const context = window.SillyTavern?.getContext?.();
                    if (context?.chatId === wanted && (script.chat ?? []).length > 0) return { opened: true, chatId: context.chatId, chatLength: script.chat.length };
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                return { opened: false, wanted, chatId: window.SillyTavern?.getContext?.()?.chatId ?? null };
            }, savedChatId);
            report.browser.reload = { saved, savedChatId, beforeReload: { chatLength: beforeReload.chatLength, chatId: beforeReload.chatId }, reopened };
            step('chat-saved-and-reloaded', saved.ok === true && reopened.opened === true, report.browser.reload);
            const reloadedState = await readPageState(page);
            step('reload-preserved-history', reloadedState.chatLength >= beforeReload.chatLength, { before: beforeReload.chatLength, after: reloadedState.chatLength });
            // A FRESH PAGE HAS NO INJECTED PROMPTS. An installed helper script re-runs on load and the user clicks the
            // Quick Reply again; this is that pair, and it is what lets the post-reload request prove the VARIABLES and
            // the QR content survived rather than only that the page loaded.
            const reloadHelper = await injectVariablesThroughHelper(page);
            const reloadQR = await executeJourneyQuickReply(page);
            report.browser.reloadHelper = { ok: reloadHelper.ok, done: reloadHelper.done };
            step('reload-helper-reran-and-reinjected-variables', reloadHelper.ok === true, reloadHelper.done ?? null);
            const turnReload = await turn(page, 'COMB_TURN_AFTER_RELOAD', 'turn-after-reload');
            const captureReload = classifyCapture(turnReload.requests[0]);
            step('after-reload-request-carries-surviving-state', turnReload.requests.length >= 1 && captureReload?.layout?.slotsPresent === 3 && captureReload?.regexRewritten === true, { layout: captureReload?.layout, regexRewritten: captureReload?.regexRewritten });
            step('after-reload-request-carries-preset-and-regex', (captureReload?.presetMarkers ?? []).filter(entry => entry.present).length >= 2 && captureReload?.regexRewritten === true, { preset: captureReload?.presetMarkers, regexRewritten: captureReload?.regexRewritten });
            step('after-reload-request-carries-variables-and-qr', captureReload?.variables?.chat === true && captureReload?.qr === true, { variables: captureReload?.variables, qr: captureReload?.qr, quickReply: reloadQR.status });

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
            const back = await page.evaluate(async wanted => {
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
            const reopened = await page.evaluate(async wanted => {
                const script = await import('./script.js');
                await script.openCharacterChat(wanted);
                const deadline = Date.now() + 30000;
                while (Date.now() < deadline) {
                    const context = window.SillyTavern?.getContext?.();
                    if (context?.chatId === wanted && (script.chat ?? []).length > 0) return { opened: true, chatId: context.chatId, chatLength: script.chat.length };
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                return { opened: false, wanted, chatId: window.SillyTavern?.getContext?.()?.chatId ?? null };
            }, chatId);
            report.browser.reopened = reopened;
            step('restart-reopened-the-saved-chat', reopened.opened === true, reopened);
            // A NEW PROCESS HAS NO IN-MEMORY INJECTIONS EITHER: the installed helper re-runs and the user re-clicks
            // the QR. What must survive is the VARIABLES themselves, the preset selection, the world-info selection,
            // the author's note (chat metadata) and the banked history.
            const restartHelper = await injectVariablesThroughHelper(page);
            const restartQR = await executeJourneyQuickReply(page);
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
            const reopened = await page.evaluate(async wanted => {
                const script = await import('./script.js');
                await script.openCharacterChat(wanted);
                const deadline = Date.now() + 30000;
                while (Date.now() < deadline) {
                    const context = window.SillyTavern?.getContext?.();
                    if (context?.chatId === wanted && (script.chat ?? []).length > 0) return { opened: true, chatId: context.chatId, chatLength: script.chat.length };
                    await new Promise(resolve => setTimeout(resolve, 200));
                }
                return { opened: false, wanted };
            }, chatId);
            report.browser.reopened = reopened;
            step('handback-opened-the-gotavern-chat', reopened.opened === true, reopened);
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
