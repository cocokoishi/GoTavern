// LONG-LIVED CORPUS PROBE -- ONE SUBJECT, ONE CORPUS COPY, ONE CONTINUOUS SESSION LINEAGE.
//
// THE QUESTION, in one sentence: when a real user's long-lived SillyTavern tree (several characters, months of
// chats with swipes and branches, groups, world books, presets, assets, legacy settings) is opened by GoTavern
// or by pinned Node SillyTavern, and the user RESUMES an existing long chat, sends a turn, swipes a reply,
// switches preset/world/character, reloads the tab repeatedly, saves, and then RESTARTS the server and keeps
// working -- do the browser-visible state, the provider request bytes and the persisted disk state match?
//
// WHY THIS IS NOT ANOTHER FRESH-INSTALL JOURNEY. `whole-session-probe.mjs` starts from a tree the server seeds
// itself. This probe starts from `tools/build-longlived-corpus.mjs`'s tree: the corpus is COPIED for each
// subject (never booted in place, AGENTS 14/51) and its chat, card bindings, settings and assets are the input.
// The long-lived qualification is therefore about RESUMING existing data, not about creating new data.
//
// THE THREE FACT CLASSES RECORDED (AGENTS 7), and where they are judged:
//   1. BROWSER OBSERVABLE -- readiness/roster/opened card/chat identity, message markers, the swiped reply,
//      the setting/preset/world/character the user changed, and the state after each reload. Judged by
//      `compare-longlived-legs.mjs`.
//   2. PROVIDER WIRE -- every completion request the recording peer received, in order: method, raw target,
//      byte length, sha256 and the raw body. Byte-oriented (differential doctrine 2); the only normalisation
//      the comparator may apply is a named FIELD PATH with its reason (docs/longlived-corpus.md).
//   3. DISK STATE -- the corpus as planted (manifest inventory) versus after the journey: which planted files
//      changed/were deleted, which files appeared, the final messages of the chat the user resumed, the
//      settings file. Judged against the pinned leg's identical tree.
//
// THE PER-SUBJECT DISCRIMINATOR (AGENTS 50). Both subjects are fed identical user turns, so if both were also
// fed identical replies the comparator could not show its fixture distinguishes them. `--reply-prefix` stamps
// exactly ONE reply (`--stamp-ordinal`, default the first) whose text remains on disk inside that message's
// `swipes[]` after the user swipes it -- and the swipe's own request and every later request carry the fresh
// UNPREFIXED replacement -- so the discriminator is real, survives to the artefact, and cannot contaminate a
// compared provider request. This is the technique whole-session-probe.mjs documents at length.
//
// WHERE THIS RUNS: the longlived workflow boots this probe twice per subject (drive + restart), exactly like
// whole-session-probe.mjs. A `--base-url`/PROBE_BASE_URL is supplied by run-against-pinned.mjs for the pinned
// subject; the GoTavern leg boots its own binary through q20-leg-runtime.mjs.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { argumentValue, bootSubject, freePort, startCapturePeer, waitForServer } from './q20-leg-runtime.mjs';
import {
    chatCarrying, configureConnection, openCharacter, openPage, pressContinue, readChatFiles, readReadiness, resolveRoster,
    saveConditional, sendTurn, silenceAndObserve, waitForReply,
} from './q20-persistence-drive.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

// ---------------------------------------------------------------------------------------------------------------
// INPUTS.
// ---------------------------------------------------------------------------------------------------------------

const dataRootArgument = argumentValue(process.argv, '--data-root', null);
if (!dataRootArgument) {
    console.error('longlived-corpus-probe.mjs: --data-root is required (one corpus COPY shared by the two phases of one subject)');
    process.exit(2);
}
const dataRoot = path.resolve(dataRootArgument);
const phase = argumentValue(process.argv, '--phase', 'drive');
if (!['drive', 'restart'].includes(phase)) {
    console.error(`longlived-corpus-probe.mjs: --phase must be drive or restart, not ${JSON.stringify(phase)}`);
    process.exit(2);
}
const reportPath = path.resolve(argumentValue(process.argv, '--report', path.join(here, `longlived-${phase}-report.json`)));
const external = Boolean(process.env.PROBE_BASE_URL);
const subject = external ? 'pinned' : 'gotavern';
const replyPrefix = argumentValue(process.argv, '--reply-prefix', process.env.LL_REPLY_PREFIX ?? '');
const stampOrdinal = Number(argumentValue(process.argv, '--stamp-ordinal', '1'));
const claim = argumentValue(process.argv, '--claim', phase === 'restart' ? 'continue' : 'send');

// THE USER'S OWN WORDS, identical on both subjects: they are carried by compared provider requests, so a
// difference here would be a difference the harness made.
const MARKERS = { turnOne: 'LL_TURN_ONE_MARKER', turnTwo: 'LL_TURN_TWO_MARKER', resumed: 'LL_RESUMED_MARKER' };
// The setting the user changes. Temperature reaches the provider body and the settings file, so the change is
// observable on two surfaces at once and is not a string that could be confused with a prompt marker.
const CHANGED_TEMPERATURE = 0.33;

const sha256 = value => createHash('sha256').update(value).digest('hex');

// ---------------------------------------------------------------------------------------------------------------
// THE CORPUS AS PLANTED. The manifest is the qualification input's own description; using it is not sharing an
// expectation with the product (differential doctrine 3): it says WHICH files the user had, never what the
// product must answer.
// ---------------------------------------------------------------------------------------------------------------

const manifest = JSON.parse(await fs.readFile(path.join(dataRoot, 'manifest.json'), 'utf8'));
const planted = new Map((manifest.inventory ?? []).map(entry => [entry.path, entry]));
const characters = manifest.surfaces?.characters ?? [];
const chats = manifest.surfaces?.chats ?? [];
const worlds = manifest.surfaces?.worlds ?? [];
const presets = manifest.surfaces?.presets ?? [];
const groups = manifest.surfaces?.groups ?? [];
const backgrounds = manifest.surfaces?.backgrounds ?? [];
const avatars = manifest.surfaces?.avatars ?? [];
const assets = manifest.surfaces?.assets ?? [];
if (characters.length < 2) {
    console.error(`longlived-corpus-probe.mjs: the corpus at ${dataRoot} has ${characters.length} characters; the journey needs at least two`);
    process.exit(2);
}
const primary = characters[0];
const secondary = characters[1];
const primaryChats = chats.filter(chat => chat.character === primary.name);
const longChat = primaryChats.find(chat => chat.long === true) ?? primaryChats[0] ?? null;
if (!longChat) {
    console.error(`longlived-corpus-probe.mjs: the corpus binds no chat to ${JSON.stringify(primary.name)}`);
    process.exit(2);
}
const longChatName = path.basename(longChat.file, '.jsonl');
const activeWorld = worlds.find(world => world.name === manifest.surfaces?.worldNames?.[0]) ?? worlds[0] ?? null;
const changedPreset = presets.find(preset => preset.name !== manifest.surfaces?.presets?.find(complex => complex.structurePreserving)?.name)
    ?? presets[presets.length - 1] ?? null;

// ---------------------------------------------------------------------------------------------------------------
// REPORT + STEP BOOKKEEPING. A leg that cannot drive still WRITES its report: the comparator then says "the
// leg failed by name" instead of treating absent evidence as a pass.
// ---------------------------------------------------------------------------------------------------------------

const report = {
    schema: 'gotavern-longlived-leg',
    schemaVersion: 1,
    subject,
    phase,
    claim,
    replyPrefix,
    stampOrdinal,
    corpus: { size: manifest.size ?? null, seed: manifest.seed ?? null, treeSha256: manifest.tree?.sha256 ?? null },
    server: { external, baseURL: null, bootRefusal: null, pid: null, configSha256: null, tokenizerLayout: null },
    browser: { readiness: null, roster: null, opened: null, baseline: null, turnOne: null, swipe: null, presetSwitch: null, worldSwitch: null, temperatureChange: null, turnTwo: null, characterSwitch: null, reloads: [], final: null, runtimeSettings: null },
    provider: { wireMode: null, requests: [] },
    assets: [],
    disk: { baselineFiles: planted.size, settingsBefore: null, changed: [], deleted: [], added: [], settingsAfter: null, chatsAfter: [] },
    steps: [],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok: ok === true, detail });
    return ok === true;
}

function fail(name, detail) {
    report.failure = { name, detail };
}

async function readSettingsFile() {
    try {
        return JSON.parse(await fs.readFile(path.join(dataRoot, 'default-user', 'settings.json'), 'utf8'));
    } catch {
        return null;
    }
}

async function readTreeDigests() {
    const digests = {};
    const walk = async directory => {
        const entries = await fs.readdir(directory, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile()) {
                const body = await fs.readFile(full);
                digests[path.relative(dataRoot, full).split(path.sep).join('/')] = { bytes: body.length, sha256: sha256(body) };
            }
        }
    };
    await walk(dataRoot);
    return digests;
}

// `messages` from the product-written chat files, with the fields a guard compares. send_date is EXCLUDED here
// because each subject stamps its own wall clock; the comparator's normalisation table records that field path
// and reason, and no OTHER field is normalised.
function summariseChatFile(file) {
    const header = file.messages?.[0] && (file.messages[0].chat_metadata !== undefined || file.messages[0].user_name !== undefined)
        ? file.messages[0]
        : null;
    const body = (file.messages ?? []).filter(record => !(record?.chat_metadata !== undefined || record?.user_name !== undefined));
    return {
        file: file.file,
        lines: file.lines,
        header: header ? { worldInfo: header.chat_metadata?.world_info ?? null, legacyMetadata: header.chat_metadata?.longlived_legacy_metadata ?? null } : null,
        messages: body.map(message => ({
            isUser: message?.is_user === true,
            name: message?.name ?? null,
            mes: String(message?.mes ?? ''),
            swipeId: message?.swipe_id ?? null,
            swipesCount: Array.isArray(message?.swipes) ? message.swipes.length : null,
            swipes: Array.isArray(message?.swipes) ? message.swipes.map(swipe => String(swipe ?? '')) : null,
            forceAvatar: message?.force_avatar ?? null,
            extraKeys: message?.extra && typeof message.extra === 'object' ? Object.keys(message.extra).sort() : null,
        })),
    };
}

async function summariseChats() {
    const files = await readChatFiles(dataRoot);
    return files.map(summariseChatFile).sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : 0));
}

// ---------------------------------------------------------------------------------------------------------------
// BROWSER READERS AND CONTROLS -- the frontend's own modules, the way a user's actions reach them.
// ---------------------------------------------------------------------------------------------------------------

async function readBrowserState(page) {
    return page.evaluate(async () => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        const worldInfo = await import('./scripts/world-info.js');
        const context = window.SillyTavern?.getContext?.() ?? null;
        const chat = script.chat ?? [];
        const marker = text => /LL_[A-Z_]*MARKER/.exec(String(text ?? ''))?.[0] ?? null;
        return {
            settingsReady: script.settingsReady === true,
            chatId: context?.chatId ?? null,
            characterName: context?.characterId !== null && context?.characterId !== undefined
                ? (script.characters?.[context.characterId]?.name ?? null) : null,
            thisChid: context?.characterId ?? script.this_chid ?? null,
            isSendPress: script.is_send_press === true,
            streaming: Boolean(script.streamingProcessor),
            onlineStatus: script.online_status ?? null,
            chatLength: chat.length,
            domMessages: document.querySelectorAll('#chat .mes').length,
            roster: (script.characters ?? []).map(entry => String(entry?.name ?? '')),
            markers: chat.map(entry => marker(entry?.mes)).filter(Boolean),
            last: chat.length > 0 ? {
                isUser: chat[chat.length - 1]?.is_user === true,
                mes: String(chat[chat.length - 1]?.mes ?? ''),
                marker: marker(chat[chat.length - 1]?.mes),
                swipeId: chat[chat.length - 1]?.swipe_id ?? null,
                swipesCount: Array.isArray(chat[chat.length - 1]?.swipes) ? chat[chat.length - 1].swipes.length : null,
            } : null,
            preset: openai.oai_settings?.preset_settings_openai ?? null,
            temperature: openai.oai_settings?.temp_openai ?? null,
            chatCompletionSource: openai.oai_settings?.chat_completion_source ?? null,
            selectedWorlds: Array.isArray(worldInfo.selected_world_info) ? [...worldInfo.selected_world_info] : null,
            worldNames: Array.isArray(worldInfo.world_names) ? [...worldInfo.world_names] : null,
        };
    });
}

async function switchPreset(page, presetName) {
    return page.evaluate(async wanted => {
        const select = document.querySelector('#settings_preset_openai');
        if (!select) return { switched: false, reason: 'no #settings_preset_openai control' };
        const options = [...select.options];
        const option = options.find(candidate => candidate.text === wanted)
            ?? options.find(candidate => candidate.text.includes(wanted));
        if (!option) return { switched: false, wanted, available: options.map(candidate => candidate.text).slice(0, 30) };
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 1500));
        const openai = await import('./scripts/openai.js');
        return { switched: true, wanted, selectedText: option.text, preset: openai.oai_settings?.preset_settings_openai ?? null, temperature: openai.oai_settings?.temp_openai ?? null };
    }, presetName);
}

async function switchWorld(page, worldName) {
    return page.evaluate(async wanted => {
        const select = document.querySelector('#world_info');
        if (!select) return { switched: false, reason: 'no #world_info control' };
        // THE OPTION VALUE IS THE WORLD'S INDEX, NOT ITS NAME (`world-info.js:1004-1005` builds
        // `<option value='<i>'>${item}</option>`), so matching on value would silently pick the wrong world or
        // none at all. The visible TEXT is the name a user selects.
        const options = [...select.options];
        const option = options.find(candidate => candidate.text === wanted);
        if (!option) return { switched: false, wanted, available: options.map(candidate => candidate.text).slice(0, 30) };
        for (const candidate of options) candidate.selected = false;
        option.selected = true;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 1000));
        const worldInfo = await import('./scripts/world-info.js');
        return { switched: true, wanted, optionValue: option.value, selectedWorlds: Array.isArray(worldInfo.selected_world_info) ? [...worldInfo.selected_world_info] : null };
    }, worldName);
}

/**
 * Wait for a preset application to finish before the next user action touches the connection.
 *
 * `onSettingsPresetChange` (public/scripts/openai.js:5021) is ASYNC and exposes `getPresetApplicationPromise()`;
 * issuing a request inside that window would measure a half-applied preset. The wait also lets the debounced
 * settings save settle, which is what makes "the change persisted" a fact and not a race.
 */
async function waitForPresetApplied(page, { timeoutMs = 20000 } = {}) {
    return page.evaluate(async budget => {
        const openai = await import('./scripts/openai.js');
        const script = await import('./script.js');
        try {
            await openai.getPresetApplicationPromise?.();
        } catch {
            // The promise is best-effort by design; the bounded state wait below still decides.
        }
        const deadline = Date.now() + budget;
        while (Date.now() < deadline) {
            if (script.is_send_press !== true && !script.streamingProcessor) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        await new Promise(resolve => setTimeout(resolve, 1500));
        return { preset: openai.oai_settings?.preset_settings_openai ?? null, temperature: openai.oai_settings?.temp_openai ?? null };
    }, timeoutMs);
}

async function changeTemperature(page, value) {
    return page.evaluate(async wanted => {
        const control = document.querySelector('#temp_openai');
        if (!control) return { changed: false, reason: 'no #temp_openai control' };
        control.value = String(wanted);
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        if (typeof script.saveSettingsDebounced === 'function') script.saveSettingsDebounced();
        await new Promise(resolve => setTimeout(resolve, 1200));
        return { changed: true, wanted, controlValue: control.value, runtimeTemperature: openai.oai_settings?.temp_openai ?? null };
    }, value);
}

async function pressSwipe(page) {
    const before = await page.evaluate(async () => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        return {
            chatLength: chat.length,
            lastTextLength: String(chat[chat.length - 1]?.mes ?? '').length,
            lastMes: String(chat[chat.length - 1]?.mes ?? ''),
            swipeAllowed: typeof script.isSwipingAllowed === 'function' ? Boolean(script.isSwipingAllowed()) : null,
            lastIsUser: chat.length > 0 && chat[chat.length - 1]?.is_user === true,
        };
    });
    if (before.swipeAllowed !== true) return { pressed: false, before, reason: 'the frontend would refuse a swipe in this state, so the press would be a state a user cannot reach' };
    const clicked = await page.evaluate(() => {
        const control = document.querySelector('#chat .last_mes .swipe_right') ?? document.querySelector('.last_mes .swipe_right');
        if (!control) return { clicked: false, reason: 'no .swipe_right control in the last message' };
        // A delegated click handler is bound on `document` (script.js:11146), so the element needs a real click
        // event through the page's own event path; `element.click()` is enough and `pointerdown` is sent first
        // because the control is styled for pointer interaction.
        control.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        control.click();
        return { clicked: true, className: control.className ?? null };
    });
    return { pressed: clicked.clicked === true, clicked, before };
}

/**
 * Wait for a swipe to REPLACE the last message's text and settle.
 *
 * `waitForReply` cannot judge this verb: a swipe regenerates the same message IN PLACE, so the chat length does not
 * move, and the peer's reply text can have the SAME length as the one it replaced (`LL_REPLY_1` and `LL_REPLY_2`
 * are both ten characters -- measured on the first local drive, where a length-based `moved` check waited out its
 * whole budget on a swipe that had in fact succeeded). The observable is the TEXT ITSELF plus the product's own
 * busy flags.
 */
async function waitForSwipedReply(page, before, { timeoutMs = 60000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let state = await readBrowserState(page);
    while (Date.now() < deadline) {
        state = await readBrowserState(page);
        const replaced = state.last !== null && state.last.mes !== before.lastMes;
        const settled = state.isSendPress !== true && state.streaming !== true;
        if (replaced && settled && state.last.lastTextLength !== 0) return { ok: true, state };
        await page.waitForTimeout(250);
    }
    return { ok: false, name: 'swipe-reply-did-not-settle', before, state };
}

/**
 * Wait until the frontend's own connection status is not `no_connection`.
 *
 * WHY THIS EXISTS, measured on a local restart leg: `configureConnection` re-points the API and the frontend's
 * status check runs ASYNCHRONOUSLY. A generation pressed inside that window hits `Generate`'s
 * `if (!dryRun && !hasBackendConnection) { is_send_press = false; return; }` early return (script.js:4383-4387) --
 * no provider request, no page error, exactly the "no failure reported, but the expected outcome did not happen"
 * shape. The wait is on the frontend's own `online_status`, bounded, and a timeout is a named failure rather than
 * a silent send.
 */
async function waitForOnline(page, { timeoutMs = 20000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let state = await readBrowserState(page);
    while (Date.now() < deadline) {
        state = await readBrowserState(page);
        if (state.onlineStatus !== null && state.onlineStatus !== 'no_connection' && !state.isSendPress && !state.streaming) {
            return { ok: true, state };
        }
        await page.waitForTimeout(250);
    }
    return { ok: false, state };
}

async function reloadPage(page, baseURL) {
    const loaded = await openPage(page, baseURL);
    return { loaded };
}

/**
 * Wait for the PRODUCT to finish resuming the corpus chat.
 *
 * WHY `openCharacter` ALONE IS NOT ENOUGH, measured on the first local drive: the helper returns as soon as the
 * page's `chat` array becomes non-empty, which for a tree whose card binds a 118-message history happens BEFORE
 * the history is loaded from disk. The probe then read `chatLength: 0` / `chatId: null` and every assertion about
 * "the long-lived chat was resumed" would have been about a page that had not resumed it yet. The wait is on the
 * product's own state (the context's chat id and the live chat length), bounded, and returns the state it saw.
 */
async function waitForResumedChat(page, expectedChatId, minimumLength) {
    const deadline = Date.now() + 60000;
    let state = await readBrowserState(page);
    while (Date.now() < deadline) {
        state = await readBrowserState(page);
        if (state.chatId === expectedChatId && state.chatLength >= minimumLength) {
            return { ok: true, state };
        }
        await page.waitForTimeout(250);
    }
    return { ok: false, expectedChatId, minimumLength, state };
}

// ---------------------------------------------------------------------------------------------------------------
// ASSET ACCESS -- the routes the pinned frontend builds, fetched as the browser would (GET, no session).
// ---------------------------------------------------------------------------------------------------------------

async function readAssets(baseURL) {
    // STATIC GETs ONLY: the list routes are POSTs that need the frontend's CSRF headers, and a 403 recorded as a
    // "broken asset" would be a harness finding rather than a product one. The lists are read through the loaded
    // page instead (resolveRoster), where a real browser's session exists.
    const probes = [
        { name: 'character-image', path: `/characters/${encodeURIComponent(path.basename(primary.avatar))}` },
        { name: 'character-thumbnail', path: `/thumbnail?type=avatar&file=${encodeURIComponent(path.basename(primary.avatar))}` },
        { name: 'persona-avatar', path: '/User%20Avatars/user-default.png' },
        { name: 'background', path: `/backgrounds/${encodeURIComponent(backgrounds[0]?.name ?? '')}` },
        { name: 'background-thumbnail', path: `/thumbnail?type=bg&file=${encodeURIComponent(backgrounds[0]?.name ?? '')}` },
        { name: 'asset', path: `/assets/${encodeURIComponent(assets[0]?.name ?? '')}` },
    ];
    const recorded = [];
    for (const probe of probes) {
        try {
            const response = await fetch(`${baseURL}${probe.path}`);
            const body = Buffer.from(await response.arrayBuffer());
            recorded.push({
                name: probe.name,
                method: 'GET',
                path: probe.path,
                status: response.status,
                contentType: response.headers.get('content-type'),
                bytes: body.length,
                sha256: sha256(body),
            });
        } catch (error) {
            recorded.push({ name: probe.name, method: 'GET', path: probe.path, status: 0, error: String(error?.message ?? error) });
        }
    }
    return recorded;
}

// ---------------------------------------------------------------------------------------------------------------
// THE JOURNEY.
// ---------------------------------------------------------------------------------------------------------------

const peer = await startCapturePeer({
    wire: 'honour',
    replyText: ordinal => (ordinal === stampOrdinal && replyPrefix ? `${replyPrefix}LL_REPLY_${ordinal}` : `LL_REPLY_${ordinal}`),
});
const port = await freePort();
report.provider.wireMode = peer.wireMode;
// COMPLETIONS ONLY. The peer also answers the frontend's `/models` capability probe; counting every recorded request
// made a continue leg report "reached the provider" when the only new request was that probe (observed on a local
// restart leg: the step passed while the peer had zero chat-completion requests).
const completionCount = () => peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? '')).length;
report.server.baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;

let browser = null;
let server = null;
const settingsBefore = await readSettingsFile();
report.disk.settingsBefore = settingsBefore ? {
    preset: settingsBefore.oai_settings?.preset_settings_openai ?? null,
    temperature: settingsBefore.oai_settings?.temp_openai ?? null,
    worldSelection: settingsBefore.world_info?.globalSelect ?? null,
    unknownKeyPresent: Object.prototype.hasOwnProperty.call(settingsBefore, 'longlived_legacy_state'),
} : null;

try {
    // BASELINE DISK IS THE PLANTED CORPUS, not a post-boot snapshot: on the pinned leg run-against-pinned.mjs has
    // already booted the server (and re-written config.yaml) before this probe starts, so a "before" walk would
    // make the two legs' baselines different for a harness reason. The manifest inventory is the same tree on both
    // legs, and comparing against it is what "the user's planted bytes" means.
    server = await bootSubject({ argv: process.argv.slice(2), dataRoot, port, external });
    report.server.external = server.external === true;
    report.server.bootRefusal = server.bootRefusal ?? null;
    report.server.pid = server.external ? (process.env.PROBE_SERVER_PID ? Number(process.env.PROBE_SERVER_PID) : null) : (server.server?.pid ?? null);
    report.server.tokenizerLayout = server.tokenizers?.layout ?? null;
    try {
        const config = await fs.readFile(path.join(dataRoot, 'config.yaml'));
        report.server.configSha256 = sha256(config);
    } catch {
        report.server.configSha256 = null;
    }
    if (!step('subject-booted', server.bootRefusal === null, { bootRefusal: server.bootRefusal })) {
        throw new Error(`the subject could not be booted: ${server.bootRefusal}`);
    }
    const baseURL = server.baseURL;
    report.server.baseURL = baseURL;
    await waitForServer(`${baseURL}/version`, 120000);

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    const consoleErrors = [];
    const consoleLog = [];
    page.on('pageerror', error => pageErrors.push(String(error?.message ?? error)));
    page.on('console', message => {
        if (message.type() === 'error') consoleErrors.push(String(message.text?.() ?? '').slice(0, 400));
        const text = String(message.text?.() ?? '');
        if (/Generate entered|continue|early return|online_status/i.test(text) && consoleLog.length < 40) {
            // WHICH EARLY RETURN the continue path took is the difference between "the product refused a state a user
            // cannot reach" and "the page never asked the server to generate". The frontend logs its own entry
            // (`Generate entered`, script.js:4290) and the status check, so those lines are kept.
            consoleLog.push(text.slice(0, 300));
        }
    });
    const failedRequests = [];
    page.on('requestfailed', request => failedRequests.push({ url: request.url(), failure: request.failure()?.errorText ?? null }));
    // BROWSER -> SERVER requests that could be the generation, recorded so "no provider request" can name whether the
    // browser ever asked the server to generate. A silent early return and a request that the page never sent look
    // identical from the peer alone (AGENTS rule 10).
    const browserApiRequests = [];
    page.on('response', response => {
        const target = response.url();
        if (/\/api\/(backends|chat|generate|settings)/.test(target)) {
            browserApiRequests.push({ status: response.status(), method: response.request().method(), url: target.replace(/^https?:\/\/[^/]+/, '') });
            if (/chat-completions\/generate/.test(target)) {
                response.text().then(text => {
                    browserApiRequests[browserApiRequests.length - 1].responseBody = String(text ?? '').slice(0, 1200);
                }).catch(() => {});
            }
        }
    });
    report.diagnostics = { pageErrors, consoleErrors, consoleLog, failedRequests, browserApiRequests };

    // (1) THE PAGE LOADS over the long-lived tree.
    const loaded = await openPage(page, baseURL);
    report.browser.readiness = await readReadiness(page);
    step('page-loaded', loaded === true && report.browser.readiness?.settingsReady === true, report.browser.readiness);
    if (!loaded) throw new Error(`the page did not become ready: ${JSON.stringify(report.browser.readiness)}`);

    // (2) THE ROSTER: every planted character (plus content-seeding additions) is listed by the product.
    const roster = await resolveRoster(page);
    report.browser.roster = roster;
    const rosterNames = new Set(roster.names);
    const missingCharacters = characters.map(character => character.name).filter(name => !rosterNames.has(name));
    step('roster-lists-the-corpus', missingCharacters.length === 0, { count: roster.count, names: roster.names, missing: missingCharacters });
    if (missingCharacters.length > 0) throw new Error(`the character list does not hold the corpus cards: missing ${missingCharacters.join(', ')}`);

    // (3) RESUME THE EXISTING LONG CHAT. The card's `chat` binding is what pinned loads on click; a card that
    // named no chat would open an empty conversation and every later assertion would be about a fresh chat.
    const opened = await openCharacter(page, primary.name);
    report.browser.opened = opened;
    const resumed = await waitForResumedChat(page, longChatName, Math.min(100, longChat.messages));
    const baseline = resumed.state;
    report.browser.baseline = baseline;
    report.browser.resumed = { ok: resumed.ok, expectedChatId: longChatName, minimumLength: Math.min(100, longChat.messages) };
    step('corpus-chat-resumed', opened.opened === true && resumed.ok === true, {
        opened: opened.characterName, chatId: baseline.chatId, chatLength: baseline.chatLength, plantedMessages: longChat.messages,
    });
    step('resumed-chat-identity', baseline.chatId === longChatName, { chatId: baseline.chatId, planted: longChatName });
    if (!opened.opened) throw new Error(`the corpus card ${JSON.stringify(primary.name)} could not be opened: ${opened.reason}`);
    if (!resumed.ok) throw new Error(`the corpus chat ${JSON.stringify(longChatName)} was not resumed: ${JSON.stringify(baseline).slice(0, 600)}`);

    // (4) THE USER'S ASSETS ARE SERVED. Fetched before any generation so a later failure cannot hide them.
    report.assets = await readAssets(baseURL);
    const brokenAssets = report.assets.filter(asset => asset.status !== 200);
    step('corpus-assets-served', brokenAssets.length === 0, { broken: brokenAssets.map(asset => `${asset.name}:${asset.status}`), served: report.assets.length });

    // (5) THE PROVIDER CONNECTION, through the frontend's own controls.
    const peerBase = `http://127.0.0.1:${peer.port}/v1`;
    const configured = await configureConnection(page, { url: peerBase, model: 'probe-model' });
    await silenceAndObserve(page);
    step('provider-configured', configured.source === 'custom' || configured.source === 'openai', configured);
    const online = await waitForOnline(page);
    step('provider-online', online.ok === true, { onlineStatus: online.state?.onlineStatus ?? null });
    if (!online.ok) throw new Error(`the frontend never reported a live backend connection: ${JSON.stringify(online.state).slice(0, 400)}`);
    if (configured.url !== peerBase) throw new Error(`the page is pointed at ${JSON.stringify(configured.url)}, not the recording peer ${peerBase}`);

    if (phase === 'drive') {
        // (6) TURN ONE on the resumed history.
        const sent = await sendTurn(page, MARKERS.turnOne);
        step('turn-one-clicked', sent.clicked === true, sent);
        const replied = await waitForReply(page, { baseline: sent.baseline, peerCompletions: completionCount() });
        step('turn-one-reply', replied.ok === true, replied.ok ? replied.state : replied);
        if (!replied.ok) throw new Error(`turn one produced no reply: ${JSON.stringify(replied)}`);
        report.browser.turnOne = await readBrowserState(page);

        // (7) SWIPE the reply: the persisted form of an edited/branched history, and the mechanism that keeps the
        // per-subject discriminator out of every later provider request.
        const completionsBeforeSwipe = completionCount();
        const swiped = await pressSwipe(page);
        let swipeReply = { ok: false };
        if (swiped.pressed) {
            // THE SWIPE MUST REACH THE PEER, and the wait says so: a swipe that changed nothing would leave the
            // prefixed reply in the chat and every later provider body would carry the harness's discriminator.
            const swipeDeadline = Date.now() + 30000;
            while (Date.now() < swipeDeadline && completionCount() <= completionsBeforeSwipe) {
                await page.waitForTimeout(250);
            }
            swipeReply = await waitForSwipedReply(page, swiped.before);
        }
        report.browser.swipe = {
            pressed: swiped.pressed,
            before: swiped.before,
            reachedProvider: completionCount() > completionsBeforeSwipe,
            newCompletions: completionCount() - completionsBeforeSwipe,
            reply: swipeReply.ok === true ? swipeReply.state : swipeReply,
        };
        step('turn-one-swiped', swiped.pressed === true && swipeReply.ok === true && completionCount() > completionsBeforeSwipe, report.browser.swipe);
        if (!report.browser.swipe.reachedProvider) {
            throw new Error(`the swipe never reached the provider: ${JSON.stringify(report.browser.swipe).slice(0, 600)}`);
        }

        // (8) TURN TWO. It happens BEFORE the state mutations, deliberately: a preset can legitimately re-bind the
        // connection (`bind_preset_to_connection`), and a generation issued inside that application window would be
        // measuring a half-applied preset. The changed preset's effect on the model context is measured by the
        // RESTART phase's `continue` request instead -- a fresh process reading the SAVED settings, which is a
        // stricter observation because it proves the switch persisted.
        const completionsBefore = completionCount();
        const sentTwo = await sendTurn(page, MARKERS.turnTwo);
        step('turn-two-clicked', sentTwo.clicked === true, sentTwo);
        const repliedTwo = await waitForReply(page, { baseline: sentTwo.baseline, peerCompletions: completionCount() });
        step('turn-two-reply', repliedTwo.ok === true, repliedTwo.ok ? repliedTwo.state : repliedTwo);
        if (!repliedTwo.ok) throw new Error(`turn two produced no reply: ${JSON.stringify(repliedTwo)}`);
        report.browser.turnTwo = { ...(await readBrowserState(page)), newCompletions: completionCount() - completionsBefore };

        // (9) MUTATE STATE: switch the preset, switch the world, change the temperature. Each is a user action
        // through the frontend's own control; the runtime settings and the persisted settings file prove the switch
        // reached the product.
        report.browser.presetSwitch = await switchPreset(page, changedPreset?.name ?? presets[presets.length - 1]?.name ?? '');
        step('preset-switched', report.browser.presetSwitch?.switched === true, report.browser.presetSwitch);
        report.browser.presetApplied = await waitForPresetApplied(page);
        report.browser.worldSwitch = await switchWorld(page, activeWorld?.name ?? worlds[0]?.name ?? '');
        step('world-switched', report.browser.worldSwitch?.switched === true, report.browser.worldSwitch);
        report.browser.temperatureChange = await changeTemperature(page, CHANGED_TEMPERATURE);
        step('temperature-changed', report.browser.temperatureChange?.changed === true, report.browser.temperatureChange);
        // The settings file must hold the change: a switch that only moved a JS global is not persisted state.
        let persisted = null;
        const settingsDeadline = Date.now() + 15000;
        while (Date.now() < settingsDeadline) {
            persisted = await readSettingsFile();
            if (Math.abs(Number(persisted?.oai_settings?.temp_openai ?? -1) - CHANGED_TEMPERATURE) < 0.001
                && persisted?.oai_settings?.preset_settings_openai === report.browser.presetSwitch?.wanted) break;
            await page.waitForTimeout(500);
        }
        report.browser.settingsPersisted = {
            temperature: persisted?.oai_settings?.temp_openai ?? null,
            preset: persisted?.oai_settings?.preset_settings_openai ?? null,
        };
        step('changed-setting-persisted', Math.abs(Number(persisted?.oai_settings?.temp_openai ?? -1) - CHANGED_TEMPERATURE) < 0.001
            && persisted?.oai_settings?.preset_settings_openai === report.browser.presetSwitch?.wanted, report.browser.settingsPersisted);

        // (10) SWITCH CHARACTER and return: a long-lived tree has several, and switching must not lose the chat.
        const switched = await openCharacter(page, secondary.name);
        report.browser.characterSwitch = await page.evaluate(async wanted => {
            const script = await import('./script.js');
            const context = window.SillyTavern?.getContext?.() ?? null;
            return { wanted, characterName: context?.characterId !== null && context?.characterId !== undefined ? script.characters?.[context.characterId]?.name ?? null : null, chatLength: (script.chat ?? []).length };
        }, secondary.name);
        report.browser.characterSwitch.opened = switched.opened === true;
        step('character-switched', switched.opened === true && report.browser.characterSwitch.characterName === secondary.name, report.browser.characterSwitch);
        const back = await openCharacter(page, primary.name);
        const backResumed = await waitForResumedChat(page, longChatName, baseline.chatLength);
        step('character-switched-back', back.opened === true && backResumed.ok === true, { opened: back.opened, resumed: backResumed.ok });

        // (11) REPEATED OPEN/CLOSE. Two deliberate reloads: the step a user performs by closing and reopening the
        // tab. After each reload the page starts on the character list (a reload does NOT restore the open chat),
        // so the user reopens the card and the resumed history must still be read from disk.
        let afterReloads = null;
        for (let reload = 1; reload <= 2; reload++) {
            const reloaded = await reloadPage(page, baseURL);
            await silenceAndObserve(page);
            const reopenedAfterReload = await openCharacter(page, primary.name);
            const resumedAfterReload = await waitForResumedChat(page, longChatName, baseline.chatLength);
            const state = resumedAfterReload.state;
            report.browser.reloads.push({
                reload,
                loaded: reloaded.loaded,
                reopened: reopenedAfterReload.opened === true,
                chatId: state.chatId,
                chatLength: state.chatLength,
                domMessages: state.domMessages,
                markers: state.markers,
            });
            step(`page-reloaded-${reload}`, reloaded.loaded === true && resumedAfterReload.ok === true
                && state.chatId === longChatName
                && state.markers.includes(MARKERS.turnOne) && state.markers.includes(MARKERS.turnTwo),
            report.browser.reloads[report.browser.reloads.length - 1]);
            afterReloads = state;
        }
        step('chat-survives-reloads', afterReloads?.chatId === longChatName
            && afterReloads.markers.includes(MARKERS.turnOne) && afterReloads.markers.includes(MARKERS.turnTwo),
        { chatId: afterReloads?.chatId ?? null, markers: afterReloads?.markers ?? [] });

        // (12) SAVE through the frontend's own conditional save, then wait for the PRODUCT to write the markers.
        const saved = await saveConditional(page);
        step('chat-saved', saved.ok === true, saved);
        const filesAfterSave = await waitForChatMarker(page, MARKERS.turnTwo);
        step('saved-marker-on-disk', chatCarrying(filesAfterSave, MARKERS.turnTwo) !== null, { files: filesAfterSave.length });
        report.browser.final = await readBrowserState(page);
    } else {
        // ---- RESTART PHASE: a NEW process, a NEW browser, the SAME tree. The product must read back what the
        // drive phase wrote: the resumed chat, its swipes and the user's changed settings, then keep working.
        const reopened = await openCharacter(page, primary.name);
        const restartResumed = await waitForResumedChat(page, longChatName, longChat.messages);
        const state = restartResumed.state;
        report.browser.opened = reopened;
        report.browser.baseline = state;
        step('restart-resumed-chat', reopened.opened === true && restartResumed.ok === true && state.markers.includes(MARKERS.turnOne) && state.markers.includes(MARKERS.turnTwo), {
            opened: reopened.opened, chatId: state.chatId, markers: state.markers, chatLength: state.chatLength,
        });
        step('restart-reads-changed-settings', Math.abs(Number(state.temperature ?? -1) - CHANGED_TEMPERATURE) < 0.001, { temperature: state.temperature, expected: CHANGED_TEMPERATURE });
        report.assets = await readAssets(baseURL);
        step('restart-assets-served', report.assets.every(asset => asset.status === 200), { broken: report.assets.filter(asset => asset.status !== 200).map(asset => `${asset.name}:${asset.status}`) });

        const peerBase = `http://127.0.0.1:${peer.port}/v1`;
        const configured = await configureConnection(page, { url: peerBase, model: 'probe-model' });
        await silenceAndObserve(page);
        step('restart-provider-configured', configured.url === peerBase, configured);
        const restartOnline = await waitForOnline(page);
        step('restart-provider-online', restartOnline.ok === true, { onlineStatus: restartOnline.state?.onlineStatus ?? null });

        // (13) CONTINUE the last reply, the verb a user reaches for when a long session's last message was cut off.
        // The press goes through the shared continue drive: it opens the options menu the control lives in, records
        // the frontend's own preconditions, and waits on the EFFECT (the last message's text growing in place).
        const before = await readBrowserState(page);
        const completionsBefore = completionCount();
        const continued = await pressContinue(page);
        let continueReply = { ok: false, state: null };
        if (continued.pressed === true) {
            const continueDeadline = Date.now() + 30000;
            while (Date.now() < continueDeadline && completionCount() <= completionsBefore) {
                await page.waitForTimeout(250);
            }
            continueReply.state = await readBrowserState(page);
        }
        report.browser.continue = {
            pressed: continued.pressed === true,
            before: { chatLength: before.chatLength, last: before.last },
            drive: continued,
            reply: continueReply.state,
            newCompletions: completionCount() - completionsBefore,
        };
        step('continue-reached-provider', continued.pressed === true && completionCount() > completionsBefore, {
            pressed: continued.pressed, newCompletions: completionCount() - completionsBefore, reason: continued.reason ?? null,
        });

        const saved = await saveConditional(page);
        step('restart-chat-saved', saved.ok === true, saved);
        const filesAfterContinue = await waitForChatMarker(page, 'LL_REPLY_');
        report.browser.final = await readBrowserState(page);
        step('restart-final-chat-holds-history', report.browser.final.markers.includes(MARKERS.turnOne) && report.browser.final.markers.includes(MARKERS.turnTwo), { markers: report.browser.final.markers });
        report.disk.chatsAfter = (await summariseChats()).filter(chat => chat.file.includes(path.basename(longChat.file, '.jsonl')));
        void filesAfterContinue;
    }

    // (14) THE PROVIDER WIRE, byte-oriented. Raw target/body; the recording peer received them, nothing was
    // reconstructed. Every request is recorded, including the /models capability probe (its path is in the record),
    // so a leg that made an unexpected request cannot pass by comparing a filtered subset.
    report.provider.requests = peer.requests.map(entry => ({
        method: entry.method,
        path: entry.path,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        body: entry.body,
        served: entry.served,
    }));
    step('provider-requests-recorded', report.provider.requests.filter(entry => /chat\/completions/.test(entry.path ?? '')).length >= (phase === 'drive' ? 3 : 1), {
        total: report.provider.requests.length,
        completions: report.provider.requests.filter(entry => /chat\/completions/.test(entry.path ?? '')).length,
    });

    // (15) DISK STATE: the planted corpus versus now. The raw tree digests are NOT compared across subjects
    // (send_date, save ordering and random secrets legitimately differ); the comparator compares the SETS and the
    // message/settings facts, with the named normalisations in docs/longlived-corpus.md.
    const after = await readTreeDigests();
    for (const [relative, plantedEntry] of planted) {
        const current = after[relative];
        if (!current) report.disk.deleted.push(relative);
        else if (current.sha256 !== plantedEntry.sha256) report.disk.changed.push({ path: relative, beforeSha256: plantedEntry.sha256, afterSha256: current.sha256, beforeBytes: plantedEntry.bytes, afterBytes: current.bytes });
    }
    for (const relative of Object.keys(after)) {
        if (!planted.has(relative) && relative !== 'manifest.json') {
            report.disk.added.push({ path: relative, bytes: after[relative].bytes, sha256: after[relative].sha256 });
        }
    }
    report.disk.added.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    report.disk.settingsAfter = await readSettingsFile();
    if (phase === 'drive') report.disk.chatsAfter = await summariseChats();
    step('no-planted-file-deleted', report.disk.deleted.length === 0, { deleted: report.disk.deleted });
    step('resumed-chat-file-persisted', report.disk.changed.some(entry => entry.path === longChat.file), {
        longChat: longChat.file,
        changed: report.disk.changed.map(entry => entry.path),
    });
    step('settings-file-persisted', report.disk.changed.some(entry => entry.path === 'default-user/settings.json'), {
        changed: report.disk.changed.map(entry => entry.path),
    });
    report.browser.runtimeSettings = await readBrowserState(page);
    report.pageErrors = pageErrors;
    report.failedRequests = failedRequests.slice(0, 20);
} catch (error) {
    if (!report.failure) fail('probe-exception', String(error?.stack ?? error));
} finally {
    // THE SUBJECT'S OWN LOG is recorded for both subjects: on the GoTavern leg it is where a refused generation
    // names itself, and on the pinned leg the wrapper gives none (the record says so instead of implying silence).
    report.server.log = Array.isArray(server?.serverLog) ? server.serverLog.slice(-40) : null;
    try {
        if (browser) await browser.close();
    } catch {
        // closing a browser is best-effort; the leg's evidence is already recorded
    }
    try {
        if (server?.server) server.server.kill('SIGKILL');
    } catch {
        // same
    }
    try {
        await peer.close();
    } catch {
        // same
    }
    report.steps.forEach(entry => {
        if (!entry.ok && !report.failure) report.failure = { name: entry.name, detail: entry.detail };
    });
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    if (report.failure) {
        console.error(`longlived ${subject}/${phase}: FAILED at ${report.failure.name}: ${JSON.stringify(report.failure.detail).slice(0, 600)}`);
        process.exitCode = 1;
    } else {
        console.error(`longlived ${subject}/${phase}: recorded ${report.steps.length} steps (${report.provider.requests.length} provider requests) at ${reportPath}`);
    }
}

// A bounded wait for the product to write a marker, using the disk reader the Q20 drive shares.
async function waitForChatMarker(page, marker) {
    const deadline = Date.now() + 30000;
    let files = [];
    while (Date.now() < deadline) {
        files = await readChatFiles(dataRoot);
        if (chatCarrying(files, marker) !== null) break;
        await page.waitForTimeout(500);
    }
    return files;
}
