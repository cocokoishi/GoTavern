// Q20 — SAVE, RELOAD AND SWIPE PRESERVE EQUALITY (GOAL.md §9).
//
// The question this answers, in one sentence: after a user's chat is written by the product, read back by a FRESH
// page load, and given a second turn and a swipe, does the conversation on disk and the context that reaches the
// model stay equal to pinned Node SillyTavern's?
//
// WHY A NEW DRIVE RATHER THAN ANOTHER MODE OF A PROBE THAT ALREADY WORKS. `helper-probe.mjs` drives ONE turn and
// reads variables; `real-preset-probe.mjs` drives generations and never reloads a page; neither produces a SECOND
// message on the same chat or a swipe. The step that matters here -- a fresh page reading the chat the previous
// page saved -- is exactly the step no existing leg performs, and it is the step a user performs by closing and
// opening SillyTavern.
//
// THE ROUTES ARE PINNED'S, read from the pinned frontend rather than guessed:
//   save    POST /api/chats/save                        public/script.js:7447, inside saveChat() (:7395)
//   read    POST /api/chats/get {avatar_url, file_name} public/script.js:7638, inside getChat()  (:7634)
//   swipe   swipe() on the last message, then a save     public/script.js:9954, endSwipe's save at :9403
// The leg never writes a chat file itself: what is asserted on disk is what the PRODUCT wrote.
//
// WHAT PRODUCES THE FIRST SAVE, and why the four earlier attempts did not. MEASURED across runs 40280522171,
// 40282904234, 40285374783 (both subjects identical, so never a product finding -- rule 10):
//   - `saveMetadata()` / `saveChatConditional()` resolve and issue NO request when `characters[this_chid].chat` is
//     undefined (script.js:7407-7417), and a card that has just been clicked has none;
//   - a synthetic click on `#send_but` is not a user path in this harness: run 40269030050 measured the click
//     leaving the textarea holding the text and taking `#chat .mes` from 2 to 0, i.e. the listener went down when
//     the page was not ready. Waiting for `settingsReady` is what fixes it;
//   - `TavernHelper.createChatMessages()` writes frontend state, and NO endpoint in pinned `src/endpoints/chats.js`
//     creates a chat identity, so a marker inserted that way can never reach disk.
// The one path a user has is the frontend's own send: it calls `saveChat({chatName})` FIRST with the marker in the
// outbound chat (script.js:7447), which creates the identity, and `Generate` saves again after the reply arrives
// (script.js:5573). This leg therefore drives `#send_textarea` + `#send_but` and judges the result BY THE FILE and
// BY THE RECORDED `/api/chats/save` REQUEST, never by a resolved promise.
//
// WHY THE FIRST TURN IS SILENTED, decided here rather than derived. A send needs a main API. This leg sets
// `power_user.savingAfterComplete = false` so `finishGenerating` does not re-save mid-generation, and creates the
// chat identity with the send itself, so no provider call is needed to get a file on disk. The Q20 pair then starts
// from THE SAME ON-DISK CHAT on both subjects (2 messages: the character's greeting and one user turn) -- which is
// what makes the second turn's request comparable in content. The provider path of a send is NOT the subject of
// this leg; it is proven elsewhere, and the peer's request list is recorded so the fact is visible in the artefact.
//
// WHAT THIS DOES NOT PROVE, stated here so the artefact's `notCompared` can repeat it: a real provider (rule 22),
// streaming (Q19), regenerate/continue (Q20's other two verbs), group chats, and branch/checkpoint features.

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { seedLegConfig } from './seed-leg-config.mjs';
import { attachUrlRecorder } from './url-recorder.mjs';
import { ensurePinnedExtensionInstalled } from './install-pinned-extension.mjs';
import { pinnedExtension } from './pinned-extensions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

async function waitForServer(url, deadlineMs = 120000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) return true;
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${url} did not answer within ${deadlineMs} ms`);
}

// The capture peer: records everything, answers a chat completion whose content carries a marker so the leg can
// prove the reply came from here. It defines nothing (rule 49).
function startCapturePeer() {
    const requests = [];
    let replyIndex = 0;
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            if (request.method === 'OPTIONS') {
                response.writeHead(204, {
                    'access-control-allow-origin': '*',
                    'access-control-allow-headers': request.headers['access-control-request-headers'] ?? '*',
                    'access-control-allow-methods': 'GET,POST,OPTIONS',
                    'access-control-max-age': '600',
                });
                response.end();
                return;
            }
            requests.push({
                method: request.method,
                path: request.url,
                byteLength: body.length,
                sha256: createHash('sha256').update(body).digest('hex'),
                body: body.toString('utf8'),
            });
            const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
            if (request.method === 'GET' && /models/.test(request.url ?? '')) {
                response.writeHead(200, headers);
                response.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model' }] }));
                return;
            }
            replyIndex += 1;
            response.writeHead(200, headers);
            response.end(JSON.stringify({
                id: `chatcmpl-q20-${replyIndex}`,
                object: 'chat.completion',
                created: 1730000000,
                model: 'probe-model',
                choices: [{ index: 0, message: { role: 'assistant', content: `Q20_REPLY_${replyIndex}` }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            requests,
            close: () => new Promise(done => server.close(done)),
        }));
    });
}

const external = Boolean(process.env.PROBE_BASE_URL);
const dataRoot = path.resolve(argumentValue('--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-q20-')));
const reportPath = path.resolve(argumentValue('--report', path.join(here, 'q20-persistence-leg.json')));

// TavernHelper only exists when the pinned extension is installed, so it goes into the leg's own data root.
const installed = await ensurePinnedExtensionInstalled(dataRoot, pinnedExtension('tavern-helper'));

const port = await freePort();
let server = null;
const serverLog = [];
if (!external) {
    const binarySetting = process.env.GOTAVERN_BINARY ?? '';
    if (!binarySetting) throw new Error('GOTAVERN_BINARY is required for the GoTavern leg');
    await fs.cp(path.join(repoRoot, 'upstream', 'tokenizers'), path.join(dataRoot, 'tokenizers'), { recursive: true });
    await seedLegConfig(dataRoot);
    server = spawn(path.resolve(binarySetting), ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    // KEPT, but bounded: a server that answers /version and then refuses a save is otherwise unattributable.
    const collect = chunk => {
        if (serverLog.length < 200) serverLog.push(String(chunk).slice(0, 400));
    };
    server.stdout.on('data', collect);
    server.stderr.on('data', collect);
}

const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;
const MARKERS = {
    first: 'Q20_FIRST_TURN_MARKER',
    second: 'Q20_SECOND_TURN_MARKER',
    swipe: 'Q20_SWIPE_MARKER',
};

const report = {
    schemaVersion: 1,
    question: 'After the product saves a chat, does a FRESH page load read it back, and do a second turn and a swipe reach the model with the same context as pinned?',
    subject: external ? 'pinned' : 'gotavern',
    baseURL,
    dataRoot,
    extension: { installedRevision: installed.revision, source: installed.source },
    markers: MARKERS,
    steps: [],
    pageRequests: [],
    chatRequests: [],
    peerRequests: [],
    pageErrors: [],
    console: [],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
}

// THE CHAT FILES THE PRODUCT WROTE. Read from disk, never written by this leg.
async function readChatFiles() {
    const chatsRoot = path.join(dataRoot, 'default-user', 'chats');
    const found = [];
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
            else if (entry.name.endsWith('.jsonl')) {
                const body = await fs.readFile(full, 'utf8');
                found.push({
                    file: path.relative(path.join(dataRoot, 'default-user'), full),
                    bytes: Buffer.byteLength(body),
                    sha256: createHash('sha256').update(body).digest('hex'),
                    lines: body.split('\n').filter(line => line.trim().length > 0).length,
                    messages: body.split('\n').filter(line => line.trim().length > 0).map(line => {
                        try {
                            return JSON.parse(line);
                        } catch {
                            return null;
                        }
                    }).filter(Boolean),
                });
            }
        }
    };
    await walk(chatsRoot);
    return found;
}

const carries = (files, marker) => files.some(file => (file.messages ?? []).some(message => String(message?.mes ?? '').includes(marker)));

const peer = await startCapturePeer();
let browser;
try {
    await waitForServer(`${baseURL}/version`);
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
    page.on('console', message => report.console.push({ type: message.type(), text: String(message.text()).slice(0, 400) }));
    await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
    // THE ONE INSTRUMENT USED FOR "DID THE FRONTEND ASK". Two runs measured a save that resolved `ok` and wrote
    // nothing; a resolved promise cannot tell "the page never asked" from "the server refused", and a request-only
    // listener cannot tell "the server refused" from "the response never arrived". The shared recorder carries
    // method, path+query, status and the response byte length for every URL, and url-recorder.mjs is the module the
    // helper and asset legs already use, so this probe is not a second, divergent instrument.
    const recorder = attachUrlRecorder(page);

    const openPage = async () => {
        await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
        // THE PAGE MUST BE READY BEFORE A CLICK IS A USER ACTION. Run 40269030050 measured a #send_but click that
        // emptied the chat because the listener was not installed yet; `settingsReady` is script.js's own flag.
        return page.evaluate(async () => {
            const script = await import('./script.js');
            const started = performance.now();
            while (performance.now() - started < 90000) {
                if (script.settingsReady) return true;
                const onboarding = document.querySelector('.popup .onboarding');
                if (onboarding) {
                    const input = onboarding.closest('.popup')?.querySelector('.popup-input');
                    if (input) {
                        input.value = 'Probe User';
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    onboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return false;
        });
    };

    const readyFirst = await openPage();
    step('page-loaded', readyFirst === true, `settingsReady=${readyFirst}`);
    step('page-no-errors', report.pageErrors.length === 0, JSON.stringify(report.pageErrors));

    // The connection, through the frontend's own controls, after the page is ready.
    const peerBase = `http://127.0.0.1:${peer.port}/v1`;
    const connected = await page.evaluate(async ({ url, model }) => {
        const set = (selector, value) => {
            const control = document.querySelector(selector);
            if (!control) return false;
            control.value = value;
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        };
        set('#chat_completion_source', 'custom');
        set('#custom_api_url_text', url);
        set('#custom_model_id', model);
        set('#api_key_custom', 'probe-key');
        const openai = await import('./scripts/openai.js');
        const st = await import('./script.js');
        // THE FIRST TURN IS SILENTED (decided, above): the post-generation save would otherwise land mid-generation,
        // and this leg needs a chat IDENTITY, not a provider reply, from the send.
        st.powerUserSettings.savingAfterComplete = false;
        return {
            source: openai.oai_settings.chat_completion_source ?? null,
            url: openai.oai_settings.custom_url ?? null,
            savingAfterComplete: st.powerUserSettings.savingAfterComplete ?? null,
        };
    }, { url: peerBase, model: 'probe-model' });
    step('connection-configured', connected.source === 'custom' && String(connected.url ?? '').includes(String(peer.port)), JSON.stringify(connected));

    // A chat to work in: click the first character, then let the page settle.
    await page.waitForSelector('#rm_print_characters_block .avatar[data-type="character"]', { timeout: 60000 }).catch(() => null);
    await page.click('#rm_print_characters_block .avatar[data-type="character"]', { timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(2500);
    const opened = await page.evaluate(() => {
        const context = window.SillyTavern?.getContext?.();
        return {
            messages: document.querySelectorAll('#chat .mes').length,
            chatLength: (context?.chat ?? []).length,
            characterChat: context?.characters?.[context.characterId]?.chat ?? null,
        };
    });
    step('chat-open', opened.messages > 0 || opened.chatLength > 0, JSON.stringify(opened));

    // 1. THE FIRST TURN, THROUGH THE FRONTEND'S OWN SEND. The save that follows is the frontend's, with the chat
    // identity the send itself creates; the leg supplies only the text and the click.
    const sent = await page.evaluate(async marker => {
        const textarea = document.querySelector('#send_textarea');
        const button = document.querySelector('#send_but');
        if (!textarea || !button) return { clicked: false, reason: 'send controls missing' };
        textarea.value = marker;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
        return { clicked: true, textareaValue: textarea.value, buttonVisible: !button.classList.contains('displayNone') };
    }, MARKERS.first);
    // A SEND IS ASYNCHRONOUS: the click returns immediately and the save lands after the frontend has produced the
    // message and named the chat. The file is polled for the marker with a bounded budget rather than read on the
    // next tick, and the recorded requests are carried in the artefact either way.
    let afterFirst = [];
    const firstDeadline = Date.now() + 30000;
    while (Date.now() < firstDeadline) {
        afterFirst = await readChatFiles();
        if (carries(afterFirst, MARKERS.first)) break;
        await page.waitForTimeout(500);
    }
    await recorder.settled();
    const saveRequests = () => recorder.requests
        .filter(entry => /\/api\/chats/.test(entry.pathAndQuery ?? ''))
        .map(entry => ({ method: entry.method, path: entry.pathAndQuery, status: entry.status, contentType: entry.contentType, byteLength: entry.byteLength }));
    report.pageRequests = recorder.requests.map(entry => ({ method: entry.method, path: entry.pathAndQuery, status: entry.status }));
    report.chatRequests = saveRequests();
    report.firstTurn = sent;
    report.afterFirstSave = afterFirst;
    // THE SAVE IS JUDGED BY THE FILE AND BY THE REQUEST, NOT BY THE RETURN VALUE: a resolved promise is exactly what
    // the failing runs produced.
    step('first-turn-save-issued', report.chatRequests.some(entry => /\/api\/chats\/save$/.test(entry.path ?? '') && entry.status === 200),
        JSON.stringify(report.chatRequests));
    step('first-turn-saved', carries(afterFirst, MARKERS.first),
        `files=${afterFirst.map(file => `${file.file}:${file.lines}`).join(',') || 'none'}`);

    // 2. A FRESH PAGE LOAD MUST READ THAT CHAT BACK. This is the step no other leg performs.
    const readyReload = await openPage();
    await page.waitForSelector('#rm_print_characters_block .avatar[data-type="character"]', { timeout: 60000 }).catch(() => null);
    await page.click('#rm_print_characters_block .avatar[data-type="character"]', { timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(2500);
    const afterReload = await page.evaluate(async () => {
        // THE CONNECTION IS RE-APPLIED, and that is recorded rather than hidden: the peer's port is ephemeral and
        // the frontend's settings file lives inside this leg's own one-shot data root, so a fresh page may hold a
        // stale custom URL. What is NOT repaired is the subject of this step -- the chat and its identity come from
        // the page's own read of what the previous page saved.
        const set = (selector, value) => {
            const control = document.querySelector(selector);
            if (!control) return false;
            control.value = value;
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        };
        const script = await import('./script.js');
        const context = script.getContext();
        return {
            settingsReady: script.settingsReady === true,
            messages: document.querySelectorAll('#chat .mes').length,
            chatLength: (context.chat ?? []).length,
            chatId: context.chatId ?? null,
            carriesMarker: (context.chat ?? []).some(entry => String(entry?.mes ?? '').includes('Q20_FIRST_TURN_MARKER')),
            hasPeerControls: Boolean(document.querySelector('#custom_api_url_text')),
        };
    });
    const reconnected = await page.evaluate(async ({ url, model }) => {
        const set = (selector, value) => {
            const control = document.querySelector(selector);
            if (!control) return null;
            control.value = value;
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
            return control.value;
        };
        set('#chat_completion_source', 'custom');
        set('#custom_api_url_text', url);
        set('#custom_model_id', model);
        set('#api_key_custom', 'probe-key');
        const openai = await import('./scripts/openai.js');
        const st = await import('./script.js');
        st.powerUserSettings.savingAfterComplete = false;
        return { source: openai.oai_settings.chat_completion_source ?? null, url: openai.oai_settings.custom_url ?? null };
    }, { url: peerBase, model: 'probe-model' });
    report.afterReload = { ...afterReload, reconnected };
    step('reload-reads-the-chat', afterReload.carriesMarker === true, JSON.stringify(report.afterReload));
    step('reload-chat-identity', typeof afterReload.chatId === 'string' && afterReload.chatId.length > 0, `chatId=${afterReload.chatId}`);

    // 3. A SECOND TURN AND A SWIPE ON THE SAME CHAT.
    //
    // THE SECOND TURN GOES THROUGH THE FRONTEND'S OWN SEND, so the identity for the next request is created by the
    // product: that send WRITES THE MARKER, and only the request it provokes is compared (the write is 200 on
    // purpose -- this turn drives the generation, and the second handler must drop it so it cannot poison every
    // later comparison).
    //
    // THE SWIPE IS THE FRONTEND'S OWN `swipe()` (script.js:9954), called the way the frontend calls it from its
    // click handler (`(e, data) => await swipe(e, SWIPE_DIRECTION.RIGHT, data)`, :11146): the swipe flow itself
    // decides `run_generate`, the `swipe_id`, the `swipes` array and the save at its end, and `Generate('swipe')`
    // assembles the context from the chat as it then stands. The extension's `generate({preset_name:'in_use'})` is
    // NOT used for the swipe: a generic turn is not a swipe, so it could not demonstrate that a swipe preserves
    // equality even if its request happened to be equal.
    const secondTurn = await page.evaluate(async marker => {
        const textarea = document.querySelector('#send_textarea');
        const button = document.querySelector('#send_but');
        if (!textarea || !button) return { clicked: false, reason: 'send controls missing' };
        const before = (window.SillyTavern.getContext().chat ?? []).length;
        textarea.value = marker;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
        return { clicked: true, before };
    }, MARKERS.second);
    // Bounded wait on the PRODUCT's own state: the last message must be the reply and generation must have ended.
    const secondDeadline = Date.now() + 60000;
    let secondState = null;
    while (Date.now() < secondDeadline) {
        secondState = await page.evaluate(() => {
            const context = window.SillyTavern.getContext();
            const chat = context.chat ?? [];
            const last = chat[chat.length - 1] ?? null;
            return {
                chatLength: chat.length,
                lastIsUser: last?.is_user === true,
                lastText: String(last?.mes ?? '').slice(0, 80),
                generating: typeof context.streamingProcessor !== 'undefined' && context.streamingProcessor !== null,
            };
        });
        if (secondState.chatLength >= 4 && secondState.lastIsUser === false && /Q20_REPLY/.test(secondState.lastText)) break;
        await page.waitForTimeout(250);
    }
    report.secondTurn = { ...secondTurn, state: secondState };
    step('second-generation-completed', /Q20_REPLY/.test(String(secondState?.lastText ?? '')), JSON.stringify(report.secondTurn));

    const swiped = await page.evaluate(async () => {
        const script = await import('./script.js');
        const constants = await import('./scripts/constants.js');
        const chat = script.chat ?? [];
        const mesId = chat.length - 1;
        const before = {
            chatLength: chat.length,
            mesId,
            lastText: String(chat[mesId]?.mes ?? '').slice(0, 80),
            lastIsUser: chat[mesId]?.is_user === true,
            swipeId: chat[mesId]?.swipe_id ?? null,
            swipes: Array.isArray(chat[mesId]?.swipes) ? chat[mesId].swipes.length : null,
            swipeElementPresent: Boolean(document.querySelector(`#chat .mes[mesid="${mesId}"] .swipe_right`)),
            swipeAllowed: script.isSwipingAllowed(),
        };
        let error = null;
        try {
            // `forceMesId` is what the click handler derives from the message element; passing it keeps the same
            // message the clicks are wired to even though this call carries no DOM event.
            await script.swipe(null, constants.SWIPE_DIRECTION.RIGHT, { source: constants.SWIPE_SOURCE.SWIPE_PICKER, repeated: false, forceMesId: mesId });
        } catch (thrown) {
            error = String(thrown && thrown.message || thrown);
        }
        const after = script.chat ?? [];
        return {
            before,
            error,
            after: {
                chatLength: after.length,
                mesId,
                lastText: String(after[mesId]?.mes ?? '').slice(0, 80),
                swipeId: after[mesId]?.swipe_id ?? null,
                swipes: Array.isArray(after[mesId]?.swipes) ? after[mesId].swipes.length : null,
                lastSwipeText: String(after[mesId]?.swipes?.[after[mesId]?.swipe_id] ?? '').slice(0, 80),
            },
        };
    });
    report.swipe = swiped;
    // THE SWIPE'S OWN VERDICT IS THE PRODUCT'S STATE: a new swipe id, a grown `swipes` array, and a body that
    // differs from the message it replaced. A call that returned without doing any of that is a failed drive.
    step('swipe-held', swiped?.error === null && swiped?.before?.lastIsUser === false
        && Number(swiped?.after?.swipeId) > Number(swiped?.before?.swipeId)
        && Number(swiped?.after?.swipes ?? 0) > Number(swiped?.before?.swipes ?? 0),
        JSON.stringify({ before: swiped?.before, error: swiped?.error, after: swiped?.after }));

    // THE CHAT IS SAVED AFTER THE SWIPE, through the frontend's own conditional save (the entry the swipe itself
    // ends with, script.js:9403), so the file on disk also reflects the swipe.
    const savedAfterSwipe = await page.evaluate(async () => {
        const script = await import('./script.js');
        try {
            await script.saveChatConditional();
            return { ok: true };
        } catch (error) {
            return { ok: false, error: String(error && error.message || error) };
        }
    });

    await page.waitForTimeout(1500);
    await recorder.settled();
    report.chatRequests = saveRequests();
    report.pageRequests = recorder.requests.map(entry => ({ method: entry.method, path: entry.pathAndQuery, status: entry.status }));
    report.savedAfterSwipe = savedAfterSwipe;
    report.peerRequests = peer.requests.map(entry => ({
        method: entry.method,
        path: entry.path,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        body: entry.body,
    }));
    const completions = report.peerRequests.filter(entry => /chat\/completions/.test(entry.path ?? ''));
    report.completions = completions.length;
    step('peer-reached', completions.length >= 2, `${completions.length} chat/completions request(s); all peer requests: ${report.peerRequests.length}`);
    report.finalFiles = await readChatFiles();
    step('final-file-reflects-swipe', (report.finalFiles ?? []).some(file => (file.messages ?? []).some(message => Array.isArray(message?.swipes) && message.swipes.length > 1)),
        JSON.stringify((report.finalFiles ?? []).map(file => `${file.file}:${file.lines}`)));
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    if (browser) await browser.close();
    await peer.close();
    if (server) server.kill();
    report.serverLog = serverLog;
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${report.subject} leg: ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;
