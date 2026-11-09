// a19-journey-probe.mjs -- THE LIVE-ORACLE JOURNEY. Runs the same deterministic user journey on
// whichever backend the driver hands it, and records the four layers the comparator judges (the
// provider-wire layer belongs to the driver's peer, not to this probe).
//
// CONTRACT (B's a19-live-oracle.mjs owns the process and the peer):
//   node a19-journey-probe.mjs --base-url <url> --data-root <tree> --phase drive|restart \
//        --peer-url <url> --reply-prefix <P> --report <path> [--subject <s>]
//   * `--base-url`/PROBE_BASE_URL present => NEVER boot a server. This probe drives a page only.
//   * `--peer-url` present => point the page at the driver's recording peer through the frontend's
//     own connection controls, and NEVER start a peer of its own. One peer implementation for both
//     subjects is what makes the provider-wire layer comparable.
//   * report schema `a19-live-oracle-leg-v1` (tests/browser/a19-oracle-kit.mjs LEG_SCHEMA) with
//     layers.{browser,http,persistence,lifecycle}; the driver fills layers.providerWire and
//     persistenceDiff. A missing layer is absent (null), never an empty pass.
//
// THE JOURNEY IS DETERMINISTIC AND REPLAYABLE:
//   drive:   open page -> open a card chosen by SORTED NAME -> open a chat chosen by SORTED FILE NAME
//            -> select the corpus preset and world by name -> ONE user turn through #send_textarea/
//            #send_but -> page reload (same chat id, messages preserved) -> final snapshot.
//   restart: open page -> open the SAME card -> resume the chat that carries the journey marker ->
//            verify it is the persisted chat -> final snapshot. No generation on this phase, so the
//            provider-wire request set stays a property of the drive leg alone.
//
// WHY ONE TURN ON THE DRIVE LEG: the peer stamps each subject's reply with a per-subject prefix
// (rule 50). A SECOND turn would embed the FIRST subject's prefixed reply in the request body, so
// the byte comparison of request #2 could never be equal for a harness reason. One turn keeps every
// compared provider request free of the discriminator while still exercising the full assembly path.
//
// WHY THE CARD AND CHAT ARE CHOSEN BY SORTED IDENTITY: directory read order is not a contract, and
// both subjects are handed byte-identical copies of the corpus. Sorting the roster and the chat file
// names makes the journey pick the same card and the same persisted chat on both legs.
//
// Everything recorded here is OBSERVATION: no expectation is taken from GoTavern or from GoTavern's
// documentation. The comparator takes its expectations from the pinned leg at the same phase.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';

import { chromium } from '@playwright/test';
import {
    configureConnection,
    openPage,
    readReadiness,
    readChatFiles,
    sendTurn,
    waitForReply,
} from './q20-persistence-drive.mjs';
import { saveConditional } from './a19-corpus-kit.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');

function argumentValue(argv, name, fallback = null) {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    return argv[index + 1] ?? fallback;
}

const argv = process.argv.slice(2);
const baseURL = process.env.PROBE_BASE_URL ?? argumentValue(argv, '--base-url', null);
const dataRootArgument = argumentValue(argv, '--data-root', process.env.A19_DATA_ROOT ?? '');
const dataRoot = path.resolve(dataRootArgument ?? '');
const phase = argumentValue(argv, '--phase', 'drive');
const peerURL = argumentValue(argv, '--peer-url', null);
const replyPrefix = argumentValue(argv, '--reply-prefix', '');
const reportPath = path.resolve(argumentValue(argv, '--report', ''));
const subject = argumentValue(argv, '--subject', process.env.A19_SUBJECT ?? 'pinned');
const characterArg = argumentValue(argv, '--character', null);
const presetArg = argumentValue(argv, '--preset', null);
const worldArg = argumentValue(argv, '--world', null);

if (!baseURL) {
    console.error('a19-journey-probe: --base-url or PROBE_BASE_URL is required; this probe never boots a server');
    process.exit(2);
}
if (!dataRootArgument) {
    console.error('a19-journey-probe: --data-root <tree> is required');
    process.exit(2);
}
if (!reportPath) {
    console.error('a19-journey-probe: --report <path> is required');
    process.exit(2);
}
if (!peerURL) {
    console.error('a19-journey-probe: --peer-url is required; this probe never starts its own peer');
    process.exit(2);
}

const leg = {
    schema: 'a19-live-oracle-leg-v1',
    subject,
    phase,
    journey: 'a19-journey-probe.mjs',
    corpusTreeSha256: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    baseURL,
    peerURL,
    replyPrefix,
    steps: [],
    failure: null,
    bootRefusal: null,
    serverPid: process.env.PROBE_SERVER_PID ? Number(process.env.PROBE_SERVER_PID) : null,
    layers: { browser: null, http: null, providerWire: null, persistence: null, lifecycle: null },
    notes: [],
};

const step = (name, ok, detail = null) => {
    leg.steps.push({ name, ok: ok === true, detail, at: new Date().toISOString() });
    if (ok !== true && leg.failure === null) leg.failure = `${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    return ok === true;
};

const stripOwnOrigin = text => {
    if (typeof text !== 'string') return text;
    return text.split(baseURL).join('<base>').replace(/127\.0\.0\.1:\d{2,5}/g, '127.0.0.1:<port>');
};

// -----------------------------------------------------------------------------------------------------------------
// HTTP LAYER: same-origin /api requests (the subject's own surface) + external peer requests.
// -----------------------------------------------------------------------------------------------------------------
const httpRequests = [];
const pendingBodies = [];

function startHttpCapture(page) {
    page.on('response', response => {
        const request = response.request();
        let url;
        try {
            url = new URL(request.url());
        } catch {
            return;
        }
        const origin = url.origin === new URL(baseURL).origin ? 'subject' : (url.origin === new URL(peerURL).origin ? 'external' : 'external');
        if (origin === 'subject' && !url.pathname.startsWith('/api/')) return;
        if (origin === 'subject' && url.pathname === '/api/ping') return;
        const record = {
            method: request.method(),
            origin,
            path: url.pathname,
            query: url.search || null,
            status: response.status(),
            contentType: response.headers()['content-type'] ?? null,
            requestHeaders: request.headers(),
            responseHeaders: response.headers(),
            requestBodyText: request.postData() ?? null,
            requestBodySha256: request.postData() ? sha256(Buffer.from(request.postData(), 'utf8')) : null,
            responseBodyText: null,
            responseBodySha256: null,
            responseBodyLength: null,
            sseFrameBytes: null,
        };
        const contentType = String(record.contentType ?? '');
        const collect = (async () => {
            // A BODY READ CAN THROW TRANSIENTLY (a response racing a navigation, or a cached response whose body is
            // being replaced). One retry after the response FINISHES distinguishes that from a real absence; a body
            // that still cannot be read stays null (absence is recorded), never a guessed value.
            const readBody = async () => {
                try { return await response.text(); } catch (error) {
                    try { await response.finished(); } catch { /* navigation already gone */ }
                    await new Promise(resolve => setTimeout(resolve, 50));
                    return await response.text();
                }
            };
            try {
                if (contentType.includes('text/event-stream')) {
                    const text = await readBody();
                    const frameBytes = text.split(/\r\n\r\n|\n\n/).filter(frame => frame.startsWith('data:')).map(frame => Buffer.byteLength(`${frame}\n\n`));
                    record.responseBodyText = text.length <= 4 * 1024 * 1024 ? text : null;
                    record.responseBodySha256 = sha256(Buffer.from(text, 'utf8'));
                    record.responseBodyLength = Buffer.byteLength(text);
                    record.sseFrameBytes = frameBytes;
                } else if (origin === 'subject') {
                    const text = await readBody();
                    record.responseBodyText = text.length <= 4 * 1024 * 1024 ? text : null;
                    record.responseBodySha256 = sha256(Buffer.from(text, 'utf8'));
                    record.responseBodyLength = Buffer.byteLength(text);
                }
            } catch {
                // A body that could not be read stays null and the digest is null: absence is recorded.
            }
        })();
        pendingBodies.push(collect);
        httpRequests.push(record);
    });
}

async function settleHttp(timeoutMs = 5000) {
    // A SINGLE BATCH IS NOT A SETTLE: responses that arrive while the batch is being read are missed, and reading a
    // body after the page navigates is impossible (measured: unread bodies clustered at the reload boundary). Wait
    // until no pending body has appeared for a quiet window, bounded, so a body is always read while its response is
    // live.
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const batch = pendingBodies.splice(0);
        if (batch.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 120));
            if (pendingBodies.length === 0) return;
            continue;
        }
        await Promise.allSettled(batch);
    }
}

// -----------------------------------------------------------------------------------------------------------------
// BROWSER LAYER
// -----------------------------------------------------------------------------------------------------------------
const eventOrder = [];
// CAPTURED BEFORE THE RELOAD: see the drive branch; the page init resets the buffer on navigation.
let driveEventOrder = null;

const consoleErrors = [];
const consoleAll = [];
const pageErrors = [];
const iframes = [];

function attachConsoleCapture(page) {
    page.on('console', message => {
        const text = message.text().slice(0, 2000);
        if (consoleAll.length < 6000) consoleAll.push({ type: message.type(), text });
        if (message.type() === 'error') consoleErrors.push(stripOwnOrigin(text.slice(0, 1000)));
    });
    page.on('pageerror', error => pageErrors.push(stripOwnOrigin(String(error?.message ?? error).slice(0, 1000))));
}

async function subscribeEventTypes(page) {
    return page.evaluate(async () => {
        const events = await import('./scripts/events.js');
        const context = window.SillyTavern?.getContext?.() ?? null;
        const source = context?.eventSource ?? null;
        if (!source || typeof source.on !== 'function') return { subscribed: false, names: [] };
        window.__a19EventOrder = [];
        const names = Object.values(events.event_types ?? {}).filter(value => typeof value === 'string');
        for (const name of names) {
            try {
                source.on(name, () => window.__a19EventOrder.push(name));
            } catch {
                // an event type the emitter refuses is simply not subscribed
            }
        }
        return { subscribed: true, names };
    });
}

async function snapshotBrowser(page, stepName) {
    const snapshot = await page.evaluate(async () => {
        const script = await import('./script.js');
        const context = window.SillyTavern?.getContext?.() ?? null;
        const chat = script.chat ?? [];
        const images = [...document.images].map(image => {
            let decoded = image.complete && image.naturalWidth > 0;
            let pixelDigest = null;
            let tainted = false;
            try {
                if (decoded) {
                    const canvas = document.createElement('canvas');
                    canvas.width = 32;
                    canvas.height = 32;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(image, 0, 0, 32, 32);
                    const data = ctx.getImageData(0, 0, 32, 32).data;
                    let hash = 2166136261;
                    for (let index = 0; index < data.length; index += 1) {
                        hash ^= data[index];
                        hash = Math.imul(hash, 16777619) >>> 0;
                    }
                    pixelDigest = hash.toString(16).padStart(8, '0');
                }
            } catch {
                tainted = true;
                decoded = decoded === true;
            }
            return {
                src: image.getAttribute('src') ?? '',
                naturalWidth: image.naturalWidth ?? 0,
                naturalHeight: image.naturalHeight ?? 0,
                decoded,
                pixelDigest,
                tainted,
            };
        });
        const presetSelect = document.querySelector('#settings_preset_openai');
        const worldInfo = await import('./scripts/world-info.js');
        const selectedWorlds = Array.isArray(worldInfo.selected_world_info) ? worldInfo.selected_world_info.slice() : [];
        const last = chat[chat.length - 1] ?? null;
        return {
            readiness: window.__q20Readiness ?? null,
            roster: { count: (script.characters ?? []).length, names: (script.characters ?? []).map(character => String(character?.name ?? '')) },
            images,
            iframes: [...document.querySelectorAll('iframe')].map(frame => ({ src: frame.getAttribute('src') ?? '', title: frame.getAttribute('title') ?? null })),
            selected: {
                characterName: context?.characterId !== null && context?.characterId !== undefined ? (script.characters?.[context.characterId]?.name ?? null) : null,
                chatId: context?.chatId ?? null,
                presetName: presetSelect?.selectedOptions?.[0]?.textContent?.trim() ?? null,
                worldName: selectedWorlds.length > 0 ? selectedWorlds.slice().sort().join('|') : null,
            },
            finalChat: {
                chatId: context?.chatId ?? null,
                length: chat.length,
                lastIsUser: last?.is_user === true,
                lastText: String(last?.mes ?? '').slice(0, 2000),
            },
            eventOrder: window.__a19EventOrder ?? [],
        };
    });
    // NORMALISE THE HARNESS-RANDOM SURFACES AT RECORD TIME (the comparator refuses a compared string
    // that still carries a host:port). Image/iframe src become origin-relative.
    const normaliseSrc = src => {
        if (!src) return src;
        try {
            const url = new URL(src, baseURL);
            if (url.origin === new URL(baseURL).origin) return `${url.pathname}${url.search}`;
            return src;
        } catch {
            return src;
        }
    };
    snapshot.images = snapshot.images.map(image => ({ ...image, src: normaliseSrc(image.src) }));
    snapshot.iframes = snapshot.iframes.map(frame => ({ ...frame, src: normaliseSrc(frame.src) }));
    snapshot.consoleErrors = consoleErrors.slice();
    snapshot.pageErrors = pageErrors.slice();
    snapshot.step = stepName;
    return snapshot;
}

// -----------------------------------------------------------------------------------------------------------------
// PERSISTENCE LAYER
// -----------------------------------------------------------------------------------------------------------------
async function censusTree(root) {
    const files = [];
    const walk = async directory => {
        let entries = [];
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.isFile()) {
                const bytes = await fs.readFile(full);
                files.push({
                    path: path.relative(root, full).split(path.sep).join('/'),
                    sha256: sha256(bytes),
                    bytes: bytes.length,
                });
            }
        }
    };
    await walk(root);
    files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return { files, fileCount: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
}

async function readChatSemantics() {
    const chats = await readChatFiles(dataRoot);
    return chats.map(chat => ({
        file: `default-user/${chat.file.split(path.sep).join('/')}`,
        sha256: chat.sha256,
        lines: chat.lines,
        messages: (chat.messages ?? []).map(record => {
            const text = String(record?.mes ?? '');
            const stripped = replyPrefix ? text.split(replyPrefix).join('') : text;
            return {
                isUser: record?.is_user === true,
                name: record?.name ?? null,
                mesLength: text.length,
                mesSha256: sha256(Buffer.from(text, 'utf8')),
                mesSha256Stripped: sha256(Buffer.from(stripped, 'utf8')),
                sendDate: record?.send_date ?? null,
            };
        }),
    }));
}

// -----------------------------------------------------------------------------------------------------------------
// THE CARD AND CHAT CHOICE (sorted identity, never directory order)
// -----------------------------------------------------------------------------------------------------------------

/** The roster sorted by name, so both subjects choose the same card. */
async function sortedRoster(page) {
    return page.evaluate(async () => {
        const script = await import('./script.js');
        const deadline = Date.now() + 60000;
        let names = [];
        while (Date.now() < deadline) {
            names = (script.characters ?? []).map(character => String(character?.name ?? '')).filter(Boolean).sort();
            if (names.length > 0) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return names;
    });
}

/** Chats of a card, from the FRONTEND's own list for that card, sorted by file name. */
async function sortedChatsOfCard(page, characterName) {
    return page.evaluate(async wanted => {
        const script = await import('./script.js');
        const position = (script.characters ?? []).findIndex(character => String(character?.name ?? '') === String(wanted));
        if (position < 0) return { ok: false, reason: `no character named ${JSON.stringify(wanted)}`, chats: [] };
        const response = await fetch('/api/characters/chats', {
            method: 'POST',
            headers: script.getRequestHeaders(),
            body: JSON.stringify({ avatar_url: script.characters[position].avatar, metadata: false }),
        });
        if (!response.ok) return { ok: false, reason: `GET chats answered ${response.status}`, chats: [] };
        const listing = await response.json();
        const chats = (listing ?? [])
            .map(entry => String(entry?.file_name ?? entry?.file ?? ''))
            .filter(Boolean)
            .sort();
        return { ok: true, chats };
    }, characterName);
}

/** A chat identity WITHOUT the `.jsonl` extension: `openCharacterChat`/`getCurrentChatId` use the stem,
 *  while `/api/characters/chats` and the files on disk carry the extension. Passing an extension into
 *  `openCharacterChat` makes the product save `<stem>.jsonl.jsonl` (measured), so the stem is the ONE
 *  spelling this probe passes to the product. */
const chatStem = value => String(value ?? '').replace(/\.jsonl$/i, '');

/** Is the requested chat the one the page has open? */
async function openChatByName(page, characterName, chatFile) {
    const file = chatStem(chatFile);
    return page.evaluate(async ({ wanted, file: stem }) => {
        const script = await import('./script.js');
        const context = window.SillyTavern?.getContext?.() ?? null;
        const before = { chatId: context?.chatId ?? null, chatLength: (script.chat ?? []).length };
        try {
            await script.openCharacterChat(stem);
        } catch (error) {
            return { ok: false, before, reason: `openCharacterChat threw: ${String(error?.message ?? error)}` };
        }
        const deadline = Date.now() + 60000;
        let last = null;
        while (Date.now() < deadline) {
            const live = window.SillyTavern?.getContext?.() ?? null;
            last = {
                chatId: live?.chatId ?? null,
                chatLength: (script.chat ?? []).length,
                character: live?.characterId !== null && live?.characterId !== undefined ? (script.characters?.[live.characterId]?.name ?? null) : null,
            };
            if (String(last.chatId ?? '') === stem) {
                return { ok: true, wanted, file: stem, before, after: last };
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { ok: false, wanted, file: stem, before, after: last, reason: `the product never opened the chat ${JSON.stringify(stem)}` };
    }, { wanted: characterName, file });
}

/** The chat was opened by clicking the card; record what the product chose for itself. */
async function openCard(page, characterName) {
    return page.evaluate(async wanted => {
        const script = await import('./script.js');
        const deadline = Date.now() + 60000;
        let position = -1;
        while (Date.now() < deadline) {
            position = (script.characters ?? []).findIndex(character => String(character?.name ?? '') === String(wanted));
            if (position >= 0) break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (position < 0) return { ok: false, reason: `no character named ${JSON.stringify(wanted)}` };
        const card = [...document.querySelectorAll('#rm_print_characters_block .character_select, #rm_print_characters_block .avatar[data-type="character"]')]
            .find(element => String(element.getAttribute('data-chid')) === String(position)) ?? null;
        if (!card) return { ok: false, reason: `card ${JSON.stringify(wanted)} is not rendered`, position };
        card.click();
        const settle = Date.now() + 60000;
        let last = null;
        while (Date.now() < settle) {
            const context = window.SillyTavern?.getContext?.() ?? null;
            last = { chatId: context?.chatId ?? null, chatLength: (script.chat ?? []).length, character: context?.characterId ?? null };
            if (last.chatLength > 0 && last.chatId !== null) return { ok: true, clicked: true, position, ...last };
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { ok: false, clicked: true, position, reason: 'the click opened no chat', ...last };
    }, characterName);
}

async function selectPreset(page, presetName) {
    return page.evaluate(async wanted => {
        const openai = await import('./scripts/openai.js');
        const script = await import('./script.js');
        const select = document.querySelector('#settings_preset_openai');
        if (!select) return { ok: false, reason: '#settings_preset_openai is not in the DOM' };
        const options = [...select.options].map(option => ({ value: option.value, text: option.textContent.trim() }));
        const chosen = wanted
            ? options.find(option => option.text === wanted)
            : (options.find(option => /^A19/i.test(option.text)) ?? options.find(option => option.value !== 'gui'));
        if (!chosen) return { ok: false, reason: `preset ${JSON.stringify(wanted)} is not listed`, options };
        select.value = chosen.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const deadline = Date.now() + 30000;
        let observed = null;
        while (Date.now() < deadline) {
            observed = (document.querySelector('#settings_preset_openai')?.selectedOptions?.[0]?.textContent ?? '').trim();
            if (observed === chosen.text) return { ok: true, presetName: observed, options, selectedValue: foundValue(chosen) };
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        function foundValue(option) { return option.value; }
        return { ok: false, reason: 'the preset did not become selected', options, observed };
    }, presetName);
}

async function selectWorld(page, worldName) {
    return page.evaluate(async wanted => {
        const worldInfo = await import('./scripts/world-info.js');
        if (typeof worldInfo.getWorldInfoList === 'function') await worldInfo.getWorldInfoList();
        const names = Array.isArray(worldInfo.world_names) ? worldInfo.world_names.slice() : [];
        const chosen = wanted ? names.find(name => name === wanted) : (names.find(name => /^A19/i.test(name)) ?? names.slice().sort()[0] ?? null);
        if (!chosen) return { ok: false, reason: 'the corpus lists no lorebook', names };
        const select = document.querySelector('#world_info');
        if (!select) return { ok: false, reason: '#world_info is not in the DOM', names };
        for (const option of select.options) option.selected = option.textContent.trim() === chosen;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        const deadline = Date.now() + 30000;
        let last = null;
        while (Date.now() < deadline) {
            last = {
                selected: Array.isArray(worldInfo.selected_world_info) ? worldInfo.selected_world_info.slice() : null,
                globalSelect: worldInfo.world_info?.globalSelect ?? null,
            };
            if (Array.isArray(last.selected) && last.selected.includes(chosen)) return { ok: true, worldName: chosen, names, ...last };
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        return { ok: false, reason: 'the selection never reached selected_world_info', names, ...(last ?? {}) };
    }, worldName);
}

// -----------------------------------------------------------------------------------------------------------------
// THE CONNECTION MUST STILL POINT AT THE DRIVER'S PEER WHEN THE SEND HAPPENS.
//
// Measured by B on the plumbing run: pinned's status calls were `custom(portA) -> openai(400) ->
// custom(portB)` while GoTavern's were `custom(portA) -> custom(portB)`. `changeMainAPI('openai')`
// (script.js) triggers a chat-completions status check AND an asynchronous settings reload; if that
// reload lands after our `#chat_completion_source=custom` assignment, the page reverts to a source
// whose generation path emits no request for this peer, and the send times out with the reply never
// even being asked for. The page's OWN state is therefore read back and, if it drifted, re-applied;
// the last read-back is recorded so a future red names the state instead of the symptom.
async function ensureConnection(page, peerURL) {
    const normalise = value => String(value ?? '').replace(/\/+$/, '');
    const readState = () => page.evaluate(async () => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        return {
            mainApi: script.main_api ?? null,
            source: openai.oai_settings.chat_completion_source ?? null,
            url: openai.oai_settings.custom_url ?? null,
            model: openai.oai_settings.custom_model ?? null,
            streaming: openai.oai_settings.stream_openai ?? null,
        };
    });
    const attempts = [];
    let state = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        const applied = await configureConnection(page, { url: peerURL, model: 'a19-live-model' });
        // The status check and the settings reload are asynchronous; give them room to land, then read
        // the product's own state and re-apply once if it drifted.
        const deadline = Date.now() + 25000;
        while (Date.now() < deadline) {
            state = await readState();
            if (state.mainApi === 'openai' && state.source === 'custom' && normalise(state.url) === normalise(peerURL)) break;
            await page.waitForTimeout(250);
        }
        await page.waitForTimeout(500);
        state = await readState();
        attempts.push({ attempt, applied: { source: applied?.source ?? null, url: applied?.url ?? null }, state });
        if (state.mainApi === 'openai' && state.source === 'custom' && normalise(state.url) === normalise(peerURL)) {
            return { ok: true, attempts, state, readBack: true };
        }
    }
    return { ok: false, attempts, state, readBack: true, reason: `the page is not pointed at the peer: ${JSON.stringify(state)}` };
}
// -----------------------------------------------------------------------------------------------------------------
// THE PAGE, READY THE WAY THE PRODUCT DECIDES IT IS READY (used again after a reload).
// -----------------------------------------------------------------------------------------------------------------
async function waitForPageReady(page, timeoutMs = 180000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await page.evaluate(async () => {
            const script = await import('./script.js').catch(() => null);
            return {
                settingsReady: script?.settingsReady === true,
                appReady: window.__q20AppReady === true,
                roster: (script?.characters ?? []).length,
                chatId: window.SillyTavern?.getContext?.()?.chatId ?? null,
            };
        }).catch(() => null);
        if (last?.settingsReady === true && last?.appReady === true) return last;
        await page.waitForTimeout(250);
    }
    return last ?? { timedOut: true };
}

/**
 * ONE TURN THROUGH THE REAL SEND, REQUIRING A NEW MESSAGE TO APPEAR, WITH ONE RETRY.
 *
 * WHY NOT `chatTurn` ALONE (measured, three runs): `sendTextareaMessage` has silent exits
 * (`swipeState`, `is_send_press`, `isExecutingCommandsFromChatInput`) and a `SimpleMutex` around
 * the click handler. In one run the click produced NO user message at all — the artefact showed a
 * baseline that was still satisfied (7 messages, last text length 36) and `waitForReply` timed out
 * against a baseline the page had never been asked to move past. The contract this probe needs is
 * stronger than "the reply eventually exists": after the click a NEW message must be appended
 * (`chatLength > before.chatLength`), and only then is the reply waited for. A click that produced
 * nothing is retried ONCE (a user pressing send again), with the attempt recorded; a second silent
 * click is a red step, never a quiet pass.
 */
async function sendJourneyTurn(page, text) {
    // THE PAGE MUST BE FREE BEFORE THE CLICK: a chat that is still loading or still generating is a
    // state a user's click would be refused in, and the refusal is silent.
    const freeDeadline = Date.now() + 60000;
    let free = null;
    while (Date.now() < freeDeadline) {
        free = await page.evaluate(async () => {
            const script = await import('./script.js');
            return {
                chatId: window.SillyTavern?.getContext?.()?.chatId ?? null,
                chatLength: (script.chat ?? []).length,
                isSendPress: script.is_send_press ?? null,
                streamingProcessor: Boolean(script.streamingProcessor),
                swipeState: script.swipeState ?? null,
            };
        });
        if (free.chatId !== null && free.chatLength > 0 && free.isSendPress !== true && free.streamingProcessor !== true) break;
        await page.waitForTimeout(200);
    }
    await page.waitForTimeout(600);
    const attempts = [];
    let afterUser = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        const sent = await sendTurn(page, text);
        const userDeadline = Date.now() + 30000;
        let observed = null;
        while (Date.now() < userDeadline) {
            observed = await page.evaluate(async () => {
                const script = await import('./script.js');
                const chat = script.chat ?? [];
                const last = chat[chat.length - 1] ?? null;
                return {
                    chatLength: chat.length,
                    lastIsUser: last?.is_user === true,
                    lastTextLength: String(last?.mes ?? '').length,
                    isSendPress: script.is_send_press ?? null,
                    streamingProcessor: Boolean(script.streamingProcessor),
                };
            });
            if (observed.lastIsUser === true) break;
            await page.waitForTimeout(200);
        }
        attempts.push({ attempt, sent, observed });
        if (observed?.lastIsUser === true) {
            afterUser = observed;
            break;
        }
        await page.waitForTimeout(1000);
    }
    const before = { chatLength: free?.chatLength ?? null, lastTextLength: null };
    if (afterUser === null) {
        return {
            ok: false,
            reason: 'the real send click produced no user message after two attempts',
            free,
            attempts,
            before,
            reply: null,
            after: null,
        };
    }
    const reply = await waitForReply(page, {
        timeoutMs: 120000,
        requireText: true,
        baseline: { chatLength: before.chatLength ?? 0, lastTextLength: null },
    });
    const after = await page.evaluate(async () => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        const last = chat[chat.length - 1] ?? null;
        return {
            chatLength: chat.length,
            lastIsUser: last?.is_user === true,
            lastText: String(last?.mes ?? '').slice(0, 2000),
            lastTextLength: String(last?.mes ?? '').length,
            chatId: window.SillyTavern?.getContext?.()?.chatId ?? null,
        };
    });
    const appended = after.chatLength > (before.chatLength ?? 0);
    return { ok: reply.ok === true && appended && after.lastIsUser === false && after.lastTextLength > 0, free, attempts, before, reply, after };
}
async function waitForChatRestore(page, timeoutMs = 120000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await page.evaluate(async () => {
            const script = await import('./script.js');
            const context = window.SillyTavern?.getContext?.() ?? null;
            return {
                chatId: context?.chatId ?? null,
                chatLength: (script.chat ?? []).length,
                characterName: context?.characterId !== null && context?.characterId !== undefined ? (script.characters?.[context.characterId]?.name ?? null) : null,
            };
        });
        if (last?.chatId !== null) return last;
        await page.waitForTimeout(250);
    }
    return last ?? { timedOut: true };
}

/**
 * SETTLE THE EVENT BUS, THEN RESET IT (B's self-check reference pattern).
 *
 * A comparison over the raw log of every emitted event is a HARNESS comparison, not a subject one: the
 * load-time init sequence races the subscription hook (the faster subject loses `chatLoaded` /
 * `settings_updated` entirely) and debounced saves emit duplicate events whose COUNT depends on timing.
 * The compared surface is therefore only what the journey's own actions emit: wait until no new event
 * has arrived for `quietMs`, snapshot the load-time events as `loadEvents` (recorded, never compared),
 * and empty the buffer.
 */
async function settleAndResetEvents(page, quietMs = 1500, maxMs = 20000) {
    const result = await page.evaluate(async ({ quietMs: quiet, maxMs: max }) => {
        const started = Date.now();
        let lastCount = window.__a19EventOrder?.length ?? 0;
        let lastChange = Date.now();
        while (Date.now() - started < max) {
            await new Promise(resolve => setTimeout(resolve, 100));
            const current = window.__a19EventOrder?.length ?? 0;
            if (current !== lastCount) {
                lastCount = current;
                lastChange = Date.now();
            } else if (Date.now() - lastChange >= quiet) {
                break;
            }
        }
        const loadEvents = window.__a19EventOrder?.slice() ?? [];
        window.__a19EventOrder = [];
        return { loadEvents, settledMs: Date.now() - started, quiet };
    }, { quietMs, maxMs });
    return result;
}

// -----------------------------------------------------------------------------------------------------------------
// MAIN
// -----------------------------------------------------------------------------------------------------------------
let browser = null;
try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    startHttpCapture(page);
    attachConsoleCapture(page);

    const loaded = await openPage(page, baseURL);
    const readiness = await readReadiness(page);
    step('page-loaded', loaded === true && readiness?.settingsReady === true, readiness);
    const subscribed = await subscribeEventTypes(page);
    const loadEventSettle = await settleAndResetEvents(page);
    leg.eventLog = {
        subscription: subscribed,
        loadEvents: loadEventSettle.loadEvents,
        loadSettledMs: loadEventSettle.settledMs,
        comparedScope: 'events emitted AFTER readiness by this journey\'s own actions (load-time events recorded as loadEvents and never compared)',
    };

    // POINT AT THE DRIVER'S PEER THROUGH THE FRONTEND'S OWN CONTROLS.
    const connection = await ensureConnection(page, peerURL);
    // `configureConnection` changes the source to custom; keep streaming ON so the peer serves SSE for
    // a stream:true request (a JSON answer to a streaming request stores an empty reply).
    const streaming = await page.evaluate(async () => {
        const openai = await import('./scripts/openai.js');
        const toggle = document.querySelector('#stream_toggle');
        if (toggle && !toggle.checked) toggle.click();
        return { streamOpenai: openai.oai_settings.stream_openai ?? null, toggle: toggle ? toggle.checked : null };
    });
    step('connection-configured', connection.ok === true, { connection, streaming });

    // CHOOSE THE CARD BY SORTED ROSTER NAME (never directory order).
    const roster = await sortedRoster(page);
    const characterName = characterArg ?? roster[0] ?? null;
    step('roster-read', roster.length > 0 && typeof characterName === 'string', { count: roster.length, chosen: characterName });
    const opened = await openCard(page, characterName);
    step('card-opened', opened.ok === true, opened);

    // THE CHAT IS CHOSEN BY SORTED FILE NAME; on restart phases the chat carrying the journey marker wins.
    const chatListing = await sortedChatsOfCard(page, characterName);
    const marker = 'A19_JOURNEY_INPUT_1';
    const allChatFiles = (await readChatFiles(dataRoot)).filter(chat => (chat.messages ?? []).some(message => String(message?.mes ?? '').includes(marker)));
    const markerChat = allChatFiles[0]?.file ?? null;
    const expectedChatId = markerChat ? chatStem(path.basename(markerChat)) : null;
    let chatChoice = null;
    if (phase === 'restart') {
        const candidate = chatListing.chats.find(name => expectedChatId !== null && chatStem(name) === expectedChatId)
            ?? (expectedChatId ? `${expectedChatId}.jsonl` : null)
            ?? chatListing.chats[0];
        chatChoice = { mechanism: 'marker', candidate, markerChat: markerChat ? path.basename(markerChat) : null };
    } else {
        const sorted = [...chatListing.chats].sort((left, right) => chatStem(left).localeCompare(chatStem(right)));
        chatChoice = { mechanism: 'sorted-first', candidate: sorted[0] ?? null };
    }
    step('chat-chosen', chatChoice.candidate !== null && chatChoice.candidate !== undefined, chatChoice);
    const chatOpen = await openChatByName(page, characterName, chatChoice.candidate);
    step('chat-opened', chatOpen.ok === true, chatOpen);
    leg.chatAtOpen = await page.evaluate(async () => {
        const script = await import('./script.js');
        const context = window.SillyTavern?.getContext?.() ?? null;
        return {
            chatId: context?.chatId ?? null,
            length: (script.chat ?? []).length,
            names: (script.chat ?? []).map(message => message?.name ?? null).slice(0, 40),
            name1: context?.name1 ?? null,
            name2: context?.name2 ?? null,
        };
    });

    // SELECT THE CORPUS PRESET AND LOREBOOK THROUGH THE PRODUCT'S OWN CONTROLS.
    const preset = await selectPreset(page, presetArg);
    step('preset-selected', preset.ok === true, preset);
    // A PRESET CAN CARRY a provider URL of its own; re-apply the peer connection after selection so the
    // page is definitely pointed at the driver's peer for the generation below.
    const connectionAfterPreset = await ensureConnection(page, peerURL);
    const world = await selectWorld(page, worldArg);
    step('world-selected', world.ok === true, { world, connectionAfterPreset });

    let driveResult = null;
    if (phase === 'drive') {
        const before = await page.evaluate(async () => {
            const script = await import('./script.js');
            const chat = script.chat ?? [];
            return { chatLength: chat.length, chatId: window.SillyTavern?.getContext?.()?.chatId ?? null, lastTextLength: String(chat[chat.length - 1]?.mes ?? '').length };
        });
        // INSTRUMENT THE ONE SILENT EXIT THAT CANNOT BE SEEN FROM OUTSIDE: observe `Generate` and
        // `processCommands` without reimplementing either (AGENTS 58). A send that produces a USER
        // message can still exit before a provider request; a send that produces NO user message never
        // reached Generate, and these two facts separate those cases in the artefact.
        const instrumentation = await page.evaluate(async () => {
            const script = await import('./script.js');
            window.__a19GenCalls = [];
            let wrapStatus = 'not-installed';
            const original = script.Generate;
            if (typeof original === 'function') {
                const wrapper = function (type, ...rest) {
                    window.__a19GenCalls.push(String(type ?? ''));
                    return original.call(this, type, ...rest);
                };
                try { script.Generate = wrapper; } catch { /* live binding */ }
                if (script.Generate !== wrapper) {
                    try { Object.defineProperty(script, 'Generate', { value: wrapper, writable: true, configurable: true }); } catch { /* did not bind */ }
                }
                wrapStatus = script.Generate === wrapper ? 'bound' : 'did-not-bind';
            }
            window.__a19ProcessCommands = [];
            if (!window.__a19ProcessWrapped && typeof script.processCommands === 'function') {
                window.__a19ProcessWrapped = true;
                const originalCommands = script.processCommands;
                script.processCommands = async function (text) {
                    const result = await originalCommands.apply(this, arguments);
                    window.__a19ProcessCommands.push({ text: String(text ?? '').slice(0, 200), interrupted: result === true });
                    return result;
                };
            }
            return { generateWrap: wrapStatus, processWrapped: window.__a19ProcessWrapped === true };
        });
        const preSendState = await page.evaluate(async () => {
            const script = await import('./script.js');
            const context = window.SillyTavern?.getContext?.() ?? null;
            // THE TOKEN COUNTER'S OWN VIEW: the frontend builds count inputs from this chat array and the
            // context's name1/name2. A token-count difference between subjects must be explainable from THIS
            // recorded state before it can be called a product difference.
            return {
                chatForTokenizer: {
                    chatId: context?.chatId ?? null,
                    length: (script.chat ?? []).length,
                    names: (script.chat ?? []).map(message => message?.name ?? null).slice(0, 40),
                    name1: context?.name1 ?? null,
                    name2: context?.name2 ?? null,
                    characterName: context?.characters?.[context?.characterId]?.name ?? null,
                },
                swipeState: script.swipeState ?? null,
                isExecutingCommandsFromChatInput: script.isExecutingCommandsFromChatInput ?? null,
                thisEditMesId: script.this_edit_mes_id ?? null,
                isSendPress: script.is_send_press ?? null,
                selectedGroup: window.SillyTavern?.getContext?.()?.groupId ?? null,
                sendButtonDisabled: document.querySelector('#send_but')?.disabled ?? null,
                textareaDisabled: document.querySelector('#send_textarea')?.disabled ?? null,
            };
        });
        const consoleMark = consoleAll.length;
        const turn = await sendJourneyTurn(page, marker);
        const diagnosis = await page.evaluate(async () => {
            const script = await import('./script.js');
            return {
                generateCalls: window.__a19GenCalls ?? [],
                processCommands: window.__a19ProcessCommands ?? [],
                textareaValue: document.querySelector('#send_textarea')?.value ?? null,
                swipeState: script.swipeState ?? null,
                isSendPress: script.is_send_press ?? null,
                isExecutingCommandsFromChatInput: script.isExecutingCommandsFromChatInput ?? null,
                chatLength: (script.chat ?? []).length,
            };
        });
        driveResult = {
            before,
            instrumentation,
            preSendState,
            turn: {
                ok: turn.ok,
                reason: turn.reason ?? null,
                free: turn.free ?? null,
                attempts: turn.attempts ?? null,
                reply: turn.reply ? { ok: turn.reply.ok, reading: turn.reply.reading ?? null, state: turn.reply.state ?? null, waitedMs: turn.reply.waitedMs ?? null } : null,
                after: turn.after ?? null,
            },
            diagnosis,
            consoleDuringSend: consoleAll.slice(consoleMark).filter(entry => entry.type === 'error' || /Generate|error|Error|abort|Abort/i.test(entry.text)).slice(0, 30),
        };
        step('one-turn-through-the-real-send', turn.ok === true && turn.after !== null && turn.after.chatLength > before.chatLength, driveResult);
        await settleHttp();
        await saveConditional(page);

        // A NAVIGATION DETACHES PENDING RESPONSES: the requests issued by the save (and the counter passes it triggers)
        // are still in flight when the page reloads, and their bodies become unreadable (measured run 2: 3 GoTavern /
        // 4 pinned unread bodies, ALL clustered at this boundary). Settle the HTTP layer BEFORE navigating so every
        // body is read while the response is live.
        await settleHttp();
        // PAGE RELOAD: the same chat must be open with its messages, WITHOUT the harness re-opening it.
        const beforeReload = await page.evaluate(async () => {
            const script = await import('./script.js');
            const context = window.SillyTavern?.getContext?.() ?? null;
            return { chatId: context?.chatId ?? null, chatLength: (script.chat ?? []).length };
        });
        // THE DRIVE'S OWN EVENT SEQUENCE, captured BEFORE the navigation: a reload creates a new event-bus instance
        // and the page init resets the buffer, so reading only after the reload loses every event the journey's own
        // actions emitted (measured release run 2026-11-08: both subjects recorded 12/13 post-reload events and NONE
        // of the core drive events -- a capture defect, identical on both sides, not a product difference).
        driveEventOrder = await page.evaluate(() => window.__a19EventOrder ?? []);
        await page.reload({ waitUntil: 'domcontentloaded' });
        const readyAfterReload = await waitForPageReady(page);
        // THE EVENT BUS IS A NEW INSTANCE AFTER A NAVIGATION: subscribe again, settle the load-time
        // sequence, record it separately and reset, so only the post-reload journey events are compared.
        const subscribedAfterReload = await subscribeEventTypes(page);
        const reloadEventSettle = await settleAndResetEvents(page);
        leg.eventLog.afterReload = {
            subscription: subscribedAfterReload,
            loadEvents: reloadEventSettle.loadEvents,
            loadSettledMs: reloadEventSettle.settledMs,
        };
        const afterReload = await waitForChatRestore(page);
        // THE RELOAD FACT IS WHAT THE PRODUCT DID ON ITS OWN: if the chat did not come back, that is the
        // observation; the journey then explicitly re-opens it so the remaining snapshots are possible,
        // and records that it had to.
        // PINNED DOES NOT RE-OPEN THE LAST CHAT BY ITSELF (measured: after APP_READY the roster is loaded
        // but characterId/chatId stay null for the whole 120 s wait). A reloaded page therefore shows the
        // character list with NO chat open — that is the product's behaviour on both subjects, so the
        // reload fact is "the persisted chat is still there and re-opening it restores it", which is what
        // a user does after a refresh. The card is clicked and the chat opened through the product's own
        // paths, and the judged facts are the id and the message count before vs after.
        const reopenedCard = await openCard(page, characterName);
        const reopenedChat = await openChatByName(page, characterName, chatChoice.candidate);
        const afterReopen = await page.evaluate(async () => {
            const script = await import('./script.js');
            const context = window.SillyTavern?.getContext?.() ?? null;
            return { chatId: context?.chatId ?? null, chatLength: (script.chat ?? []).length };
        });
        leg.layers.lifecycle = {
            phase,
            serverPid: leg.serverPid,
            reload: {
                sameChatId: afterReopen.chatId === beforeReload.chatId,
                lengthPreserved: afterReopen.chatLength >= beforeReload.chatLength,
                before: beforeReload,
                readyAfterReload,
                afterReopen,
                reopenMechanism: 'card click + openCharacterChat (the product functions the chat list uses)',
                reopenedCard,
                reopenedChat,
            },
            restart: null,
        };
        step('reload-reopened-the-persisted-chat', afterReopen.chatId === beforeReload.chatId && afterReopen.chatLength >= beforeReload.chatLength, leg.layers.lifecycle.reload);
    } else {
        // RESTART: the driven chat must be the one on disk, and re-opening the card must resume it.
        const diskChat = allChatFiles[0] ?? null;
        const resumedOpen = await openChatByName(page, characterName, diskChat ? path.basename(diskChat.file) : (chatChoice.candidate ?? ''));
        const state = await page.evaluate(async () => {
            const script = await import('./script.js');
            const context = window.SillyTavern?.getContext?.() ?? null;
            const chat = script.chat ?? [];
            return {
                chatId: context?.chatId ?? null,
                chatLength: chat.length,
                carriesInput: chat.some(message => String(message?.mes ?? '').includes('A19_JOURNEY_INPUT_1')),
                assistantReplies: chat.filter(message => message?.is_user !== true && String(message?.mes ?? '').length > 0).length,
            };
        });
        const resumed = resumedOpen.ok === true
            && (expectedChatId === null || chatStem(state.chatId) === expectedChatId || chatStem(state.chatId).startsWith(expectedChatId))
            && state.carriesInput === true;
        leg.layers.lifecycle = { phase, serverPid: leg.serverPid, reload: null, restart: { resumed, state, expectedChatId, diskChatPresent: diskChat !== null } };
        step('restart-resumed-the-persisted-chat', resumed === true, leg.layers.lifecycle.restart);
    }

    await settleHttp();
    const snapshot = await snapshotBrowser(page, phase === 'drive' ? 'after-reload' : 'after-restart');
    leg.layers.browser = {
        readiness: { settingsReady: snapshot.readiness?.settingsReady === true, appReady: snapshot.readiness?.appReady === true, viaFallback: snapshot.readiness?.viaFallback === true },
        roster: snapshot.roster,
        images: snapshot.images,
        iframes: snapshot.iframes,
        selected: snapshot.selected,
        consoleErrors: snapshot.consoleErrors,
        pageErrors: snapshot.pageErrors,
        eventOrder: phase === 'drive' ? (driveEventOrder ?? snapshot.eventOrder) : snapshot.eventOrder,
        finalChat: snapshot.finalChat,
        snapshots: [snapshot],
    };
    leg.layers.http = { requests: httpRequests };

    const tree = await censusTree(dataRoot);
    // THE PRODUCT-SURFACE JSON DOCUMENTS, recorded as TEXT so the comparator applies its named JSON projections
    // (run-created secrets, per-leg peer URL, generation timings) instead of comparing raw bytes that legitimately
    // differ; a change outside those members still changes the projected digest.
    const jsonFiles = [];
    for (const relative of ['default-user/settings.json', 'default-user/image-metadata.json', 'default-user/secrets.json']) {
        try {
            const text = await fs.readFile(path.join(dataRoot, relative), 'utf8');
            if (text.length <= 4 * 1024 * 1024) jsonFiles.push({ path: relative, text });
        } catch { /* absent is a fact the guard reports by its absence */ }
    }
    let corpusTreeSha256 = null;
    try {
        const manifest = JSON.parse(await fs.readFile(path.join(path.dirname(dataRoot), 'corpus-manifest.json'), 'utf8'));
        corpusTreeSha256 = manifest.treeSha256 ?? null;
    } catch {
        corpusTreeSha256 = null;
    }
    leg.corpusTreeSha256 = corpusTreeSha256;
    leg.layers.persistence = {
        tree: { files: tree.files, fileCount: tree.fileCount, bytes: tree.bytes },
        chats: (await readChatFiles(dataRoot)).map(chat => ({
            file: `default-user/${chat.file.split(path.sep).join('/')}`,
            sha256: chat.sha256,
            lines: chat.lines,
        })),
        chatMessages: await readChatSemantics(),
        jsonFiles,
    };

    // FAIL A STEP IF THE LAYERS IT CLAIMS ARE ABSENT: absence is reported, never treated as a pass.
    step('browser-layer-recorded', Array.isArray(leg.layers.browser.images) && leg.layers.browser.images.length > 0, { images: leg.layers.browser.images.length, roster: leg.layers.browser.roster?.count ?? 0 });
    step('http-layer-recorded', httpRequests.length > 0, { requests: httpRequests.length });
    step('persistence-layer-recorded', tree.fileCount > 0 && leg.layers.persistence.chatMessages.length > 0, { files: tree.fileCount, chats: leg.layers.persistence.chatMessages.length });
} catch (error) {
    leg.failure = String(error?.stack ?? error).slice(0, 4000);
    leg.steps.push({ name: 'journey', ok: false, detail: leg.failure });
} finally {
    if (browser) await browser.close().catch(() => {});
    leg.finishedAt = new Date().toISOString();
    leg.failedSteps = leg.steps.filter(entry => entry.ok !== true).map(entry => entry.name);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(leg, null, 2)}\n`, 'utf8');
    console.log(`[a19-journey] ${phase}/${subject}: ${leg.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`[a19-journey] report: ${reportPath}`);
    if (leg.failure) console.error(`[a19-journey] FAILURE: ${leg.failure}`);
}
process.exit(leg.failedSteps.length === 0 ? 0 : 1);
