// Q20 — SAVE, RELOAD AND SWIPE PRESERVE EQUALITY (GOAL.md §9).
//
// The question this answers, in one sentence: after a user's chat is written by the product, read back by a FRESH
// page load, and given a new swipe, does the conversation on disk and the context that reaches the model stay equal
// to pinned Node SillyTavern's?
//
// WHY A NEW DRIVE RATHER THAN ANOTHER MODE OF A PROBE THAT ALREADY WORKS. `helper-probe.mjs` drives ONE turn and
// reads variables; `real-preset-probe.mjs` drives one generation; neither reloads a page or produces a second
// message on the same chat. The step that matters here -- a fresh page reading the chat the previous page saved --
// is exactly the step no existing leg performs, and it is the step a user performs by closing and opening SillyTavern.
//
// THE ROUTES ARE PINNED'S, read from the pinned frontend rather than guessed:
//   save    fetch('/api/chats/save', ...)                public/script.js:7348, via saveChat()
//   read    POST /api/chats/get {avatar_url, file_name}  src/endpoints/chats.js:592-614
//   swipe   generate() on the last message, then a save  public/script.js:9954 (swipe), :4290 (Generate)
// The leg never writes a chat file itself: what is asserted on disk is what the PRODUCT wrote.
//
// WHAT THIS DOES NOT PROVE, stated here so the artefact's `notCompared` can repeat it: a real provider (rule 22),
// the swipe BUTTON wiring (the swipe is produced by the same generation entry the preset leg uses, on a message
// that already exists), group chats, and branch/checkpoint features.

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { seedLegConfig } from './seed-leg-config.mjs';
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
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            get requests() { return requests; },
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
if (!external) {
    const binarySetting = process.env.GOTAVERN_BINARY ?? '';
    if (!binarySetting) throw new Error('GOTAVERN_BINARY is required for the GoTavern leg');
    await fs.cp(path.join(repoRoot, 'upstream', 'tokenizers'), path.join(dataRoot, 'tokenizers'), { recursive: true });
    await seedLegConfig(dataRoot);
    server = spawn(path.resolve(binarySetting), ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
}

const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;
const MARKERS = {
    first: 'Q20_FIRST_TURN_MARKER',
    second: 'Q20_SECOND_TURN_MARKER',
    swipe: 'Q20_SWIPE_MARKER',
};

const report = {
    schemaVersion: 1,
    question: 'After the product saves a chat, does a FRESH page load read it back, and does a second message and a swipe reach the model with the same context as pinned?',
    subject: external ? 'pinned' : 'gotavern',
    baseURL,
    dataRoot,
    extension: { installedRevision: installed.revision },
    markers: MARKERS,
    steps: [],
    peerRequests: [],
    chatRequests: [],
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

const peer = await startCapturePeer();
let browser;
try {
    await waitForServer(`${baseURL}/version`);
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
    page.on('console', message => report.console.push({ type: message.type(), text: String(message.text()).slice(0, 400) }));
    // WHY THIS EXISTS. Two runs measured a save that resolved ok and wrote nothing, with `files=` empty on BOTH
    // subjects. A resolved promise cannot tell "the frontend never asked" from "the server refused", so the
    // requests the page makes to /api/chats are recorded and carried into the artefact: a non-2xx is a product
    // finding, an absent request is a drive limitation.
    const chatRequests = [];
    const pageRequests = [];
    // BOTH SIDES ARE RECORDED. The first attempt listened only to RESPONSES, so an absent response and an absent
    // request looked identical -- and the log had neither. Recording the page's own requests as well makes
    // "the frontend never asked" and "the server refused" distinguishable in the artefact.
    page.on('request', request => {
        const url = request.url();
        if (!/\/api\//.test(url)) return;
        pageRequests.push({ method: request.method(), path: new URL(url).pathname });
    });
    page.on('response', async response => {
        const url = response.url();
        if (!/\/api\/chats/.test(url)) return;
        let byteLength = null;
        try {
            byteLength = (await response.body()).length;
        } catch {
            byteLength = null;
        }
        chatRequests.push({
            method: response.request().method(),
            path: new URL(url).pathname,
            status: response.status(),
            byteLength,
        });
    });
    await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());

    const openPage = async () => {
        await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
        await page.evaluate(async () => {
            const script = await import('./script.js');
            const started = performance.now();
            while (performance.now() - started < 60000) {
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

    await openPage();
    step('page-loaded', true);

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
        return {
            source: openai.oai_settings.chat_completion_source ?? null,
            url: openai.oai_settings.custom_url ?? null,
        };
    }, { url: peerBase, model: 'probe-model' });
    step('connection-configured', connected.source === 'custom' && String(connected.url ?? '').includes(String(peer.port)), JSON.stringify(connected));

    // A chat to work in: click the first character, then let the page settle.
    await page.waitForSelector('#rm_print_characters_block .avatar[data-type="character"]', { timeout: 60000 }).catch(() => null);
    await page.click('#rm_print_characters_block .avatar[data-type="character"]', { timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(2500);
    const opened = await page.evaluate(() => ({
        messages: document.querySelectorAll('#chat .mes').length,
        chatLength: (window.SillyTavern?.getContext?.().chat ?? []).length,
    }));
    step('chat-open', opened.messages > 0 || opened.chatLength > 0, JSON.stringify(opened));

    // 1. ONE USER TURN THROUGH THE PRODUCT, then a save THAT ACTUALLY WRITES.
    //
    // MEASURED (run 40280522171): `saveMetadata()` resolved ok and wrote NOTHING -- `files=` was empty -- because
    // saveChat() returns before any request when `chatName ?? characters[chid].chat` is undefined
    // (public/script.js:7407-7417). A chat that has just been clicked has no identity, so the Q10 lane had to
    // create one; the same applies here. The named form is the frontend's own saveChat with the one argument a
    // user supplies on their first save.
    const first = await page.evaluate(async marker => {
        const context = window.SillyTavern.getContext();
        const before = {
            chatLength: (context.chat ?? []).length,
            characterChat: context.characters?.[context.characterId]?.chat ?? null,
            saveFunctions: ['saveMetadata', 'saveChat', 'saveChatConditional'].filter(name => typeof context[name] === 'function'),
        };
        const inserted = await window.TavernHelper.createChatMessages([{ role: 'user', message: marker }]);
        const attempts = [];
        const callSave = async (name, argument) => {
            try {
                await context[name](argument);
                attempts.push({ via: name, argument: argument ?? null, ok: true });
            } catch (error) {
                attempts.push({ via: name, argument: argument ?? null, ok: false, error: String(error && error.message || error) });
            }
        };
        // A CHAT WITH NO IDENTITY CANNOT BE SAVED, and the frontend only creates that identity when a message is
        // actually sent through its own send path (measured twice: runs 40282904234 and 40285374783, where both
        // saves resolved and the page issued NO /api/chats request at all). So the first turn is sent the way a
        // user sends it, and the save that follows is the one the send itself triggers.
        const sendControls = {
            textarea: Boolean(document.querySelector('#send_textarea')),
            button: Boolean(document.querySelector('#send_but')),
        };
        let sendClicked = false;
        if (sendControls.textarea && sendControls.button) {
            const textarea = document.querySelector('#send_textarea');
            textarea.value = marker;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            document.querySelector('#send_but').click();
            sendClicked = true;
        }
        if (before.saveFunctions.includes('saveMetadata')) await callSave('saveMetadata');
        if (before.saveFunctions.includes('saveChat')) await callSave('saveChat', { chatName: 'q20-probe-chat' });
        const after = window.SillyTavern.getContext();
        return {
            sendControls,
            sendClicked,
            ok: attempts.some(attempt => attempt.ok === true),
            inserted,
            before,
            attempts,
            chatLength: (after.chat ?? []).length,
            characterChat: after.characters?.[after.characterId]?.chat ?? null,
        };
    }, MARKERS.first);
    // A SEND IS ASYNCHRONOUS: the frontend saves before it contacts the provider, but the click returns
    // immediately, so the record is read after a bounded wait rather than on the next tick.
    await page.waitForTimeout(6000);
    const afterFirst = await readChatFiles();
    report.chatRequests = chatRequests.slice();
    report.pageRequests = pageRequests.slice();
    report.afterFirstSave = afterFirst;
    report.firstTurn = first;
    // THE SAVE IS JUDGED BY THE FILE, NOT BY THE RETURN VALUE: a resolved promise is exactly what the failing run
    // produced.
    step('first-turn-saved', afterFirst.some(file => file.messages.some(message => String(message.mes ?? '').includes(MARKERS.first))),
        `${JSON.stringify(first)}; files=${afterFirst.map(file => `${file.file}:${file.lines}`).join(',')}`);

    // 2. A FRESH PAGE LOAD MUST READ THAT CHAT BACK. This is the step no other leg performs.
    await openPage();
    await page.waitForSelector('#rm_print_characters_block .avatar[data-type="character"]', { timeout: 60000 }).catch(() => null);
    await page.click('#rm_print_characters_block .avatar[data-type="character"]', { timeout: 30000 }).catch(() => null);
    await page.waitForTimeout(2500);
    const afterReload = await page.evaluate(async marker => {
        const context = window.SillyTavern?.getContext?.();
        const chat = context?.chat ?? [];
        return {
            messages: document.querySelectorAll('#chat .mes').length,
            chatLength: chat.length,
            carriesMarker: chat.some(entry => String(entry?.mes ?? '').includes(marker)),
        };
    }, MARKERS.first);
    report.afterReload = afterReload;
    step('reload-reads-the-chat', afterReload.carriesMarker === true, JSON.stringify(afterReload));

    // 3. A SECOND TURN AND A SWIPE, through the extension's own generation entry against the peer.
    const generated = await page.evaluate(async markers => {
        window.__q20 = { done: null };
        const script = [
            "const cfg = window.parent.__q20cfg;",
            "const out = { turns: [], errors: {} };",
            "try {",
            "  out.turns.push(String(await TavernHelper.generate({ preset_name: 'in_use', user_input: cfg.second, should_stream: false, should_silence: true })).slice(0, 60));",
            "} catch (error) { out.errors.second = String(error && error.message || error); }",
            "try {",
            "  out.turns.push(String(await TavernHelper.generate({ preset_name: 'in_use', user_input: cfg.swipe, should_stream: false, should_silence: true })).slice(0, 60));",
            "} catch (error) { out.errors.swipe = String(error && error.message || error); }",
            "window.parent.__q20.done = out;",
        ].join('\n');
        window.__q20cfg = markers;
        window.TavernHelper.replaceScriptTrees([{
            type: 'script',
            enabled: true,
            name: 'q20-probe-script',
            id: 'q20-probe-script',
            content: script,
            button: { enabled: true, buttons: [{ name: 'probe', visible: true }] },
        }], { type: 'global' });
        const deadline = Date.now() + 90000;
        let outcome = null;
        while (Date.now() < deadline) {
            outcome = await page.evaluate(() => window.__q20?.done ?? null);
            if (outcome) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return outcome;
    }, { second: MARKERS.second, swipe: MARKERS.swipe });
    report.generated = generated;
    step('second-generation-completed', generated !== null && Array.isArray(generated.turns) && generated.turns.length >= 1, JSON.stringify(generated));

    await page.waitForTimeout(1500);
    report.peerRequests = peer.requests.map(entry => ({
        method: entry.method,
        path: entry.path,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        body: entry.body,
    }));
    step('peer-reached', report.peerRequests.length > 0, `${report.peerRequests.length} request(s)`);

    report.finalFiles = await readChatFiles();
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    if (browser) await browser.close();
    await peer.close();
    if (server) server.kill();
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${report.subject} leg: ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;
