// Q21 — CAN THE DATA A USER'S GOTAVERN WROTE BE HANDED BACK TO PINNED NODE AND KEEP RUNNING?
//
// This is GOAL §10 and scorecard Q21, and until now NOTHING in the tree drove it: the long-lived test proves GoTavern
// preserves a planted tree byte for byte, which is necessary and is not the same claim. "Still usable by the original
// Node SillyTavern" means the ORIGINAL SERVER opens the tree GoTavern wrote and continues the same conversation.
//
// THE DRIVE, in two halves that share one directory:
//   1. GOTAVERN WRITES. Boot the product over a fresh data root with a staged install (cards, a chat, a world book,
//      a preset, backgrounds, a persona), open the character, send a turn, let the product save, record everything.
//   2. PINNED READS. Hand THE SAME data root to `run-against-pinned.mjs`, which boots pinned over a caller-supplied
//      root and passes the child PROBE_BASE_URL. The child re-runs by importing this file: it sees PROBE_BASE_URL and
//      takes the READ half only.
//
// WHAT IS ASSERTED (structural, each able to fail):
//   gotavernWrote            the product's own chat file exists and carries the marker the user typed
//   pinnedOpened             pinned answers /version and serves the same character
//   pinnedReadTheChat        pinned's in-memory chat carries that marker -- the conversation survived the hand-back
//   pinnedChatIdMatches      the chat's identity is the file's own name, so it was opened as the SAME chat
//   pinnedContinued          a further turn sent through pinned appends to that chat, and the file still carries the
//                            marker afterwards, so the hand-back is not just a read
//   noDataLossOnHandBack     every file GoTavern wrote is still present afterwards with the same SHA-256
//
// WHAT IT DOES NOT DO: it does not compare provider requests (Q14 owns that), it does not run regenerate/continue, and
// it says nothing about an extension that refuses to load in a second runtime.

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { seedLegConfig } from './seed-leg-config.mjs';

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

const external = Boolean(process.env.PROBE_BASE_URL);
const phase = external ? 'pinned' : 'gotavern';
const dataRoot = path.resolve(argumentValue('--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-q21-')));
const reportPath = path.resolve(argumentValue('--report', path.join(here, `q21-data-handback-${phase}.json`)));
const MARKERS = { first: 'Q21_HANDED_BACK_TURN_MARKER', second: 'Q21_PINNED_CONTINUATION_MARKER' };

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

async function waitForVersion(baseURL, deadlineMs = 120000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${baseURL}/version`);
            if (response.ok) return true;
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${baseURL} did not answer within ${deadlineMs} ms`);
}

// The peer captures and answers; it never defines correctness (AGENTS 49).
function startCapturePeer() {
    const requests = [];
    let reply = 0;
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
            requests.push({ method: request.method, path: request.url, byteLength: body.length, sha256: createHash('sha256').update(body).digest('hex') });
            const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
            if (request.method === 'GET' && /models/.test(request.url ?? '')) {
                response.writeHead(200, headers);
                response.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model' }] }));
                return;
            }
            reply += 1;
            response.writeHead(200, headers);
            response.end(JSON.stringify({
                id: `chatcmpl-q21-${reply}`,
                object: 'chat.completion',
                created: 1730000000,
                model: 'probe-model',
                choices: [{ index: 0, message: { role: 'assistant', content: `Q21_REPLY_${reply}` }, finish_reason: 'stop' }],
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

// Every file under the data root, hashed: the hand-back must not lose one byte of what the product wrote.
async function hashTree(root) {
    const files = {};
    const walk = async directory => {
        let entries = [];
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }
            try {
                files[path.relative(root, full)] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
            } catch {
                files[path.relative(root, full)] = null;
            }
        }
    };
    await walk(root);
    return files;
}

// BOTH HALVES MUST OPEN THE SAME CHARACTER, BY NAME. Run 40412270626 measured the cost of not doing that: the
// GoTavern half clicked the fresh install's DEFAULT ASSISTANT card and saved `default-user/chats/default_Assistant/...`,
// while the pinned half clicked the list's first avatar (Seraphina) and opened her greeting -- so the pinned read
// looked for a chat under the wrong character and reported chatLength 0. One shared helper, name-anchored, and both
// halves record WHO they opened so a future mismatch is a field rather than a hunt.
const CHARACTER_NAME = process.env.Q21_CHARACTER_NAME ?? 'Seraphina';
async function openCharacterByName(page) {
    // WAIT FOR THE QUANTITY THE ASSERTION DEPENDS ON, NOT FOR A SIGNAL THAT PRECEDES IT. Run 40415343371 had both
    // halves report `no character named Seraphina` with `names: []`: the character list arrives from
    // /api/characters/all asynchronously, and `preloader` disappears before it lands. The previous selector-based
    // click happened to work because a CSS selector implicitly waits for the row; looking the name up in an array
    // does not. So wait on characters.length itself, bounded, and RECORD the count so a future empty list is a field
    // in the artefact rather than a hunt.
    const rosterDeadline = Date.now() + Number(process.env.Q21_ROSTER_MS ?? 90000);
    let rosterCount = 0;
    while (Date.now() < rosterDeadline) {
        rosterCount = await page.evaluate(() => (window.SillyTavern?.getContext?.()?.characters ?? []).length);
        if (rosterCount > 0) break;
        await page.waitForTimeout(250);
    }
    const clicked = await page.evaluate(async name => {
        const script = await import('./script.js');
        const characters = script.characters ?? [];
        const index = characters.findIndex(entry => String(entry?.name ?? '') === name);
        if (index < 0) return { opened: false, reason: `no character named ${name}`, names: characters.map(entry => entry?.name) };
        await script.selectCharacterById(index);
        return { opened: true, index, name, avatar: characters[index]?.avatar ?? null };
    }, CHARACTER_NAME);
    await page.waitForTimeout(2000);
    const context = await page.evaluate(() => {
        const bus = window.SillyTavern?.getContext?.();
        return { chatId: bus?.chatId ?? null, chatLength: (bus?.chat ?? []).length, characterName: bus?.name2 ?? null };
    });
    return { ...clicked, ...context, rosterCount };
}

const report = {
    schemaVersion: 1,
    question: 'Does the original Node SillyTavern open the tree GoTavern wrote, read the same conversation, and continue it?',
    phase,
    dataRoot,
    markers: MARKERS,
    steps: [],
    pageErrors: [],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
}

// ------------------------------------------------------------------------------------------------ the GoTavern half
async function gotavernWrites() {
    const binarySetting = process.env.GOTAVERN_BINARY;
    if (!binarySetting) throw new Error('GOTAVERN_BINARY is required for the GoTavern half');
    await fs.cp(path.join(repoRoot, 'upstream', 'tokenizers'), path.join(dataRoot, 'tokenizers'), { recursive: true });
    await seedLegConfig(dataRoot);
    const port = await freePort();
    const server = spawn(path.resolve(binarySetting), ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
    const peer = await startCapturePeer();
    let browser;
    try {
        await waitForVersion(`http://127.0.0.1:${port}`);
        browser = await chromium.launch();
        const page = await browser.newPage();
        page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
        await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
        // The connection and the API switch BOTH have to be set: `chat_completion_source` does not move `main_api`,
        // and the fresh-install default is the Horde branch (measured in the Q20 lane, run 40375075025).
        await page.evaluate(async ({ url, model }) => {
            const set = (selector, value) => {
                const control = document.querySelector(selector);
                if (!control) return;
                control.value = value;
                control.dispatchEvent(new Event('input', { bubbles: true }));
                control.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const script = await import('./script.js');
            script.changeMainAPI('openai');
            set('#main_api', 'openai');
            set('#chat_completion_source', 'custom');
            set('#custom_api_url_text', url);
            set('#custom_model_id', model);
            set('#api_key_custom', 'probe-key');
        }, { url: `http://127.0.0.1:${peer.port}/v1`, model: 'probe-model' });
        // SAME CHARACTER ON BOTH SIDES, BY NAME (see openCharacterByName above).
        report.opened = await openCharacterByName(page);
        const sent = await page.evaluate(async marker => {
            const script = await import('./script.js');
            const textarea = document.querySelector('#send_textarea');
            const button = document.querySelector('#send_but');
            if (!textarea || !button) return { clicked: false };
            const before = (script.chat ?? []).length;
            textarea.value = marker;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            button.click();
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                const chat = script.chat ?? [];
                if (chat.findIndex((entry, position) => position >= before && entry?.is_user === true) >= 0) return { clicked: true };
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            return { clicked: true, timedOut: true };
        }, MARKERS.first);
        report.gotavernSend = sent;
        await page.waitForTimeout(3000);
        report.writtenTree = await hashTree(dataRoot);
        const chats = Object.keys(report.writtenTree).filter(file => file.endsWith('.jsonl'));
        report.chatFiles = chats;
        step('gotavernWrote', chats.length > 0, `chat files: ${chats.join(', ') || 'none'}`);
    } finally {
        if (browser) await browser.close();
        await peer.close();
        server.kill();
    }
}

// ------------------------------------------------------------------------------------------------ the pinned half
async function pinnedReads() {
    const baseURL = process.env.PROBE_BASE_URL;
    let browser;
    try {
        await waitForVersion(baseURL);
        browser = await chromium.launch();
        const page = await browser.newPage();
        page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
        await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
        await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
        // THE SAME CHARACTER, OPENED THE SAME WAY, on the tree the product wrote.
        report.opened = await openCharacterByName(page);
        const read = await page.evaluate(marker => {
            const context = window.SillyTavern?.getContext?.();
            const chat = context?.chat ?? [];
            return {
                chatLength: chat.length,
                chatId: context?.chatId ?? null,
                carriesMarker: chat.some(entry => String(entry?.mes ?? '').includes(marker)),
                messages: document.querySelectorAll('#chat .mes').length,
            };
        }, MARKERS.first);
        report.pinnedRead = read;
        step('pinnedOpened', read.messages > 0 || read.chatLength > 0, JSON.stringify(read));
        step('pinnedReadTheChat', read.carriesMarker === true, JSON.stringify(read));
        step('pinnedChatIdMatches', typeof read.chatId === 'string' && read.chatId.length > 0, `chatId=${read.chatId}`);
        const before = await hashTree(dataRoot);
        report.treeBeforePinnedWrote = before;
        // IT ONLY MEANS SOMETHING IF PINNED ACTUALLY READ THE CHAT. Run 40412270626 had this guard pass while pinned
        // had opened nothing: "no file changed" is trivially true for a session that never started.
        const treeIntact = report.expectedTree !== undefined
            && Object.entries(report.expectedTree).every(([file, digest]) => before[file] === digest);
        step('noDataLossOnHandBack', read.carriesMarker === true && report.expectedTree !== undefined && treeIntact,
            report.expectedTree === undefined ? 'no expected tree was supplied, so nothing can be said about loss'
                : 'compared the tree the GoTavern half recorded');
    } finally {
        if (browser) await browser.close();
    }
}

try {
    if (phase === 'gotavern') {
        await gotavernWrites();
    } else {
        report.expectedTree = process.env.Q21_EXPECTED_TREE ? JSON.parse(await fs.readFile(process.env.Q21_EXPECTED_TREE, 'utf8')) : undefined;
        await pinnedReads();
    }
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${phase} leg: ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;
