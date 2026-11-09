// ONE LEG OF THE THIRD-PARTY EXTENSION CORPUS DIFFERENTIAL.
//
// The question: with the WHOLE pinned set installed at once, does the pinned frontend load every named
// extension, issue the same API surface, reach the same page state, and stay healthy under a repeated
// send/cancel/reload/toggle drive -- identically on stock SillyTavern and GoTavern?
//
// The runner owns BOTH subjects, their ports and their restarts: this probe never boots a server
// (PROBE_BASE_URL is required, and its absence is a named refusal). It starts ONE recording provider peer
// in this process, points the page's connection at it, and records every page request. The peer is the
// only provider; the pinned frontend's own live-egress calls (e.g. /api/horde/) are recorded with their
// status and body digest but flagged `liveEgress` so the comparator never asserts their body (AGENTS 14).
//
// A LEG THAT CANNOT REACH THE STATE A USER REACHES WRITES A NAMED FAILURE. The extension-load facts are
// recorded per extension (a missing asset on GoTavern is a COMPARATOR finding, not a probe failure), but
// the drive itself is refused/red when the page never reaches settingsReady, the character cannot be
// opened, or a requested soak drive cannot complete an iteration.
//
// Usage:
//   PROBE_BASE_URL=http://127.0.0.1:<port> PROBE_SERVER_PID=<pid> node extension-corpus-probe.mjs \
//     --names a,b,c --data-root <dir> --report <file> --phase before --mode load [--soak-minutes N]
//   (or --lock-set all20 | cluster:<name>; --subject gotavern|pinned)

import fs from 'node:fs/promises';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { loadLock } from './third-party-extensions.mjs';
import { namesForLockSet } from './extension-corpus-clusters.mjs';
import http from 'node:http';
import { configureConnection, openCharacter, sendTurn, waitForReply } from './q20-persistence-drive.mjs';
import { settleWithEgressClassification, waitForNetworkQuiet } from './extension-corpus-netquiet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;


// THE PEER DELAYS ITS ANSWER ON PURPOSE. The soak step "cancel a streaming reply" needs a generation that is
// still in flight when the stop control is pressed; an instant peer answers before the click, so the
// cancellation would never be exercised. The delay also makes every normal send measurable at a realistic
// latency. The record shape matches the shared capture peer (method/path/bodyLength/sha256/body/requestedStream/
// served) so a past leg stays diagnosable, and the peer DEFINES NOTHING (AGENTS 49): replies are markers.
function startCorpusPeer({ delayMs = 400, replyText = ordinal => `CORPUS_REPLY_${ordinal}` } = {}) {
    const requests = [];
    let replyIndex = 0;
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            if (request.method === 'OPTIONS') {
                response.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': request.headers['access-control-request-headers'] ?? '*', 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-max-age': '600' });
                response.end();
                return;
            }
            let wantsStream = false;
            try { wantsStream = JSON.parse(body.toString('utf8'))?.stream === true; } catch { wantsStream = false; }
            const record = { method: request.method, path: request.url, byteLength: body.length, sha256: createHash('sha256').update(body).digest('hex'), body: body.toString('utf8'), requestedStream: wantsStream, served: { wire: null, frames: 0, bytes: 0, terminal: false, cancelled: false } };
            requests.push(record);
            if (request.method === 'GET' && /models/.test(request.url ?? '')) {
                const listing = JSON.stringify({ object: 'list', data: [{ id: 'corpus-probe-model', object: 'model' }] });
                record.served = { wire: 'json', frames: 0, bytes: Buffer.byteLength(listing), terminal: true, cancelled: false };
                response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                response.end(listing);
                return;
            }
            replyIndex += 1;
            const text = String(replyText(replyIndex) ?? '');
            const timer = setTimeout(() => {
                // THE CLIENT MAY HAVE ABORTED THE FETCH (the soap cancel step). An aborted response is a
                // RECORDED served state, not an error: what the peer observed is part of the leg's evidence.
                if (response.destroyed || response.writableEnded) { record.served.cancelled = true; return; }
                if (wantsStream) {
                    const delta = JSON.stringify({ id: `chatcmpl-corpus-${replyIndex}`, object: 'chat.completion.chunk', created: 1730000000, model: 'corpus-probe-model', choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }] });
                    const stop = JSON.stringify({ id: `chatcmpl-corpus-${replyIndex}`, object: 'chat.completion.chunk', created: 1730000000, model: 'corpus-probe-model', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
                    const payload = `data: ${delta}\n\ndata: ${stop}\n\ndata: [DONE]\n\n`;
                    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'access-control-allow-origin': '*' });
                    record.served = { wire: 'sse', frames: 3, bytes: Buffer.byteLength(payload), terminal: true, cancelled: false };
                    response.end(payload);
                } else {
                    const payload = JSON.stringify({ id: `chatcmpl-corpus-${replyIndex}`, object: 'chat.completion', created: 1730000000, model: 'corpus-probe-model', choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
                    response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
                    record.served = { wire: 'json', frames: 0, bytes: Buffer.byteLength(payload), terminal: true, cancelled: false };
                    response.end(payload);
                }
            }, delayMs);
            response.on('close', () => { if (!response.writableEnded) { clearTimeout(timer); record.served.cancelled = true; } });
        });
    });
    server.keepAliveTimeout = 1000;
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, requests, close: () => new Promise(done => server.close(done)) }));
    });
}

const CARD_FILE_NAME = 'Real Structure Card';
const CARD_RELATIVE = path.join(here, 'fixtures', 'real', 'card-a.png');

// Read the card name from the PNG's tEXt chunk (keywords chara / ccv3, base64-encoded V2/V3 JSON). A card with
// no readable name falls back to the FILENAME and the fallback is recorded, never silently assumed.
async function characterNameFromCard(file) {
    try {
        const bytes = await fs.readFile(file);
        let offset = 8;
        while (offset + 8 <= bytes.length) {
            const length = bytes.readUInt32BE(offset);
            const type = bytes.toString('ascii', offset + 4, offset + 8);
            const data = bytes.subarray(offset + 8, offset + 8 + length);
            if (type === 'tEXt') {
                const separator = data.indexOf(0);
                if (separator > 0) {
                    const keyword = data.toString('latin1', 0, separator);
                    if (keyword === 'chara' || keyword === 'ccv3') {
                        try {
                            const json = JSON.parse(Buffer.from(data.subarray(separator + 1).toString('latin1'), 'base64').toString('utf8'));
                            const name = json?.data?.name ?? json?.name ?? null;
                            if (typeof name === 'string' && name.trim() !== '') return { name: name.trim(), source: keyword };
                        } catch { /* try the next carrier */ }
                    }
                }
            }
            offset += 12 + length;
        }
        return { name: CARD_FILE_NAME, source: 'filename-fallback (no readable tEXt name)' };
    } catch (error) {
        return { name: CARD_FILE_NAME, source: `filename-fallback (card unreadable: ${String(error.message ?? error).slice(0, 120)})` };
    }
}

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index === -1) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

const phase = argument('--phase', 'before');
if (!['before', 'after'].includes(phase)) throw new Error(`--phase must be before or after; got ${JSON.stringify(phase)}`);
const mode = argument('--mode', 'load');
if (!['load', 'soak'].includes(mode)) throw new Error(`--mode must be load or soak; got ${JSON.stringify(mode)}`);
const soakMinutes = Number(argument('--soak-minutes', '0'));
const dataRoot = path.resolve(argument('--data-root', '.'));
const reportPath = path.resolve(argument('--report', path.join(here, `extension-corpus-${phase}.json`)));
const baseURL = process.env.PROBE_BASE_URL ?? argument('--base-url', null);
const subject = argument('--subject', process.env.PROBE_SUBJECT ?? 'gotavern');
const serverPid = process.env.PROBE_SERVER_PID ? Number(process.env.PROBE_SERVER_PID) : null;
if (!baseURL) throw new Error('PROBE_BASE_URL is required: the runner owns the subject process so a restart is a real restart');
// The subject's own origin, computed once: every page request is classified against it, so "same-origin"
// is the SUBJECT's origin and not "not the peer's port".
const subjectOrigin = new URL(baseURL).origin;
if (!['gotavern', 'pinned'].includes(subject)) throw new Error(`--subject must be gotavern or pinned; got ${JSON.stringify(subject)}`);

const lockInfo = loadLock(argument('--lock', path.join(here, 'third-party-extensions.lock.json')));
const lock = lockInfo.lock;
const lockSet = argument('--lock-set', null);
const namesArgument = argument('--names', null);
let names = namesArgument ? namesArgument.split(',').map(name => name.trim()).filter(Boolean) : namesForLockSet(lock, lockSet);
if (!names || names.length === 0) names = lock.selected.map(extension => extension.name);
const known = new Set(lock.selected.map(extension => extension.name));
const unknown = names.filter(name => !known.has(name));
if (unknown.length > 0) throw new Error(`unknown extension name(s): ${unknown.join(', ')}`);
names = [...new Set(names)];

// A FRESH DATA ROOT MUST CONTAIN THE STAGED CARD THE RUNNER COPIED INTO BOTH LEGS; without it the drive
// would open no character and the leg would record a page state a user never reaches.
const cardPath = path.join(dataRoot, 'default-user', 'characters', `${CARD_FILE_NAME}.png`);
const cardIdentity = await characterNameFromCard(cardPath);
const cardName = cardIdentity.name;
const stagedCardPresent = existsSync(cardPath);
if (!stagedCardPresent) {
    const report = { schemaVersion: 1, surface: 'third-party-extension-corpus', subject, phase, mode, baseURL, startedAt: new Date().toISOString(), provenance: { lockSha256: lockInfo.sha256 }, plan: { names }, steps: [], failure: `the runner did not stage the committed card at ${cardPath}; refusing to drive a data root without the character both legs must open` };
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.error(report.failure);
    process.exit(1);
}
const cardSha256 = createHash('sha256').update(await fs.readFile(cardPath)).digest('hex');

const report = {
    schemaVersion: 1,
    surface: 'third-party-extension-corpus',
    question: 'Does the pinned third-party set load, issue the same API surface and survive a repeated drive/restart identically on stock SillyTavern and GoTavern?',
    subject, phase, mode, baseURL,
    startedAt: new Date().toISOString(),
    plan: { names, nameCount: names.length, lockSet: lockSet ?? (namesArgument ? 'explicit --names' : 'all20'), mode },
    provenance: {
        subject, phase, mode,
        lockSha256: lockInfo.sha256,
        lockPath: path.basename(lockInfo.path),
        cardPath: 'fixtures/real/card-a.png',
        cardSha256,
        stagedCardPath: `${CARD_FILE_NAME}.png`,
        cardCharacterName: cardIdentity.name,
        cardCharacterNameSource: cardIdentity.source,
        serverPid,
        legConfig: process.env.PROBE_LEG_CONFIG_JSON ? JSON.parse(process.env.PROBE_LEG_CONFIG_JSON) : null,
        baseURLIsExternal: true,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
    },
    steps: [],
    extensions: [],
    rows: [],
    pageErrors: [],
    consoleErrors: [],
    failedRequests: [],
    finalState: null,
    chat: null,
    soak: null,
    failure: null,
};
function record(name, ok, detail = null) {
    report.steps.push({ name, ok: ok === true, at: new Date().toISOString(), detail: detail ?? null });
    if (!ok) console.error(`[${subject}/${phase}] FAIL ${name} :: ${JSON.stringify(detail)}`);
}

const shapeOf = (value, depth = 0) => {
    if (depth > 3) return 'depth-limit';
    if (value === null) return 'null';
    if (Array.isArray(value)) return { type: 'array', length: value.length, item: value.length ? shapeOf(value[0], depth + 1) : null };
    if (typeof value === 'object') {
        const keys = {};
        for (const key of Object.keys(value).sort()) keys[key] = shapeOf(value[key], depth + 1);
        return { type: 'object', keys };
    }
    return typeof value;
};

function readVmRss(pid) {
    if (process.platform !== 'linux') return { kb: null, reason: `VmRSS is read from /proc and this host is ${process.platform}; no equivalent is asserted here` };
    if (!pid) return { kb: null, reason: 'no subject PID was supplied (PROBE_SERVER_PID is empty)' };
    try {
        const content = readFileSync(`/proc/${pid}/status`, 'utf8');
        const match = /VmRSS:\s+(\d+)\s+kB/.exec(content);
        return match ? { kb: Number(match[1]), reason: null } : { kb: null, reason: 'VmRSS line absent from /proc/<pid>/status' };
    } catch (error) {
        return { kb: null, reason: `could not read /proc/${pid}/status: ${String(error.message ?? error).slice(0, 160)}` };
    }
}

async function readGoroutines() {
    try {
        const response = await fetch(`${baseURL}/debug/pprof/goroutine?debug=1`, { signal: AbortSignal.timeout(5000) });
        if (response.status !== 200) return { value: null, reason: `the subject answered ${response.status} for /debug/pprof/goroutine (no pprof endpoint is asserted as exposed)` };
        const text = await response.text();
        const count = (text.match(/^goroutine \d+ \[/gm) ?? []).length;
        return { value: count > 0 ? count : null, reason: count > 0 ? null : 'pprof answered 200 but no goroutine headers were parsed' };
    } catch (error) {
        return { value: null, reason: `no pprof endpoint answered: ${String(error.message ?? error).slice(0, 160)}` };
    }
}

// ORPHAN CHECK: on Linux, a process whose command line names THIS data root should be the subject itself.
// A second one is an orphan from a previous boot (the runner kills its own children in finally; this
// observes, it does not kill). Excludes this process and its parent, because their command lines carry the
// data root path without being a server.
function orphanProcesses() {
    if (process.platform !== 'linux') return { checked: false, reason: `process scan is implemented for /proc only; host is ${process.platform}`, candidates: [] };
    const excluded = new Set([process.pid, process.ppid]);
    const candidates = [];
    try {
        for (const entry of readdirSync('/proc')) {
            if (!/^\d+$/.test(entry)) continue;
            const pid = Number(entry);
            if (excluded.has(pid)) continue;
            try {
                const cmdline = readFileSync(`/proc/${entry}/cmdline`, 'utf8').split('\0').filter(Boolean);
                if (cmdline.length === 0) continue;
                if (cmdline.some(token => token.includes(dataRoot)) && !(serverPid && pid === serverPid)) {
                    candidates.push({ pid, argv: cmdline.slice(0, 3) });
                }
            } catch { /* process vanished or not readable */ }
        }
        return { checked: true, reason: null, candidates };
    } catch (error) {
        return { checked: false, reason: `could not scan /proc: ${String(error.message ?? error).slice(0, 160)}`, candidates: [] };
    }
}

const latencyOf = list => {
    const sorted = [...list].sort((a, b) => a - b);
    const at = fraction => sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))];
    return { samples: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.length ? sorted[sorted.length - 1] : null };
};

let browser = null;
let peer = null;
let page = null;
try {
    peer = await startCorpusPeer({ delayMs: 400, replyText: ordinal => `CORPUS_REPLY_${ordinal}` });
    const peerURL = `http://127.0.0.1:${peer.port}/v1`;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    page = await context.newPage();
    const requests = [];
    const pending = new Map();
    page.on('pageerror', error => report.pageErrors.push(String(error.message ?? error).slice(0, 300)));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(String(message.text()).slice(0, 400)); });
    page.on('request', request => {
        const url = new URL(request.url());
        const entry = {
            method: request.method(), path: url.pathname + url.search, status: null, contentType: '',
            // THE ORIGIN IS RECORDED so a request that never settled can be classified by HOST rather than by
            // path shape. Measured defect (runs 42478967874 and 42477517830): the unresolved request was
            // reported as a bare `/repos/...` path, and "which host was this?" had to be inferred. A
            // page-originated request to a third-party origin is not the subject's behaviour; a same-origin
            // request is.
            origin: url.origin,
            sameOrigin: url.origin === subjectOrigin,
            bodyLength: null, bodySha256: null, bodyShape: null, liveEgress: url.pathname.startsWith('/api/horde/'), startedAt: Date.now(), latencyMs: null,
        };
        pending.set(request, entry);
        requests.push(entry);
    });
    page.on('response', async response => {
        const entry = pending.get(response.request());
        if (!entry) return;
        entry.status = response.status();
        entry.contentType = response.headers()['content-type'] ?? '';
        entry.latencyMs = Date.now() - entry.startedAt;
        try {
            const bytes = await response.body();
            entry.bodyLength = bytes.length;
            entry.bodySha256 = createHash('sha256').update(bytes).digest('hex');
            if (entry.contentType.includes('application/json') && bytes.length < 200000) {
                try { entry.bodyShape = shapeOf(JSON.parse(bytes.toString('utf8'))); } catch { entry.bodyShape = 'unparsable-json'; }
            }
        } catch { /* redirects / aborted streams have no readable body */ }
    });
    page.on('requestfailed', request => report.failedRequests.push(`FAILED ${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? ''}`));
    page.on('response', response => { if (response.status() >= 400) report.failedRequests.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`); });

    const extensionPrefix = name => `/scripts/extensions/third-party/${name}/`;
    async function waitForExtensions(expectedNames) {
        const deadline = Date.now() + 240000;
        const outcome = new Map(expectedNames.map(name => [name, { name, loaded: false, firstAsset: null, firstFailingUrl: null, firstFailingStatus: null, requests: 0 }]));
        while (Date.now() < deadline) {
            for (const [name, record] of outcome) {
                const prefix = extensionPrefix(name);
                const own = requests.filter(entry => entry.path.startsWith(prefix));
                record.requests = own.length;
                const success = own.find(entry => entry.status !== null && entry.status < 400);
                const failing = own.find(entry => entry.status !== null && entry.status >= 400);
                if (success && !record.loaded) {
                    record.loaded = true;
                    record.firstAsset = success.path.split('?')[0];
                }
                if (failing && record.firstFailingUrl === null) {
                    record.firstFailingUrl = failing.path.split('?')[0];
                    record.firstFailingStatus = failing.status;
                }
            }
            if ([...outcome.values()].every(record => record.loaded || record.firstFailingUrl !== null)) return [...outcome.values()];
            await page.waitForTimeout(250);
        }
        return [...outcome.values()];
    }

    async function reachPage(label) {
        const started = Date.now();
        await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded', timeout: 180000 });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 300000 });
        const ready = await page.evaluate(async () => {
            const script = await import('./script.js');
            const began = performance.now();
            const result = { settingsReady: false, onboarding: false, timedOut: false };
            while (performance.now() - began < 240000) {
                const onboarding = document.querySelector('.popup .onboarding');
                if (onboarding) {
                    result.onboarding = true;
                    const input = onboarding.closest('.popup')?.querySelector('.popup-input');
                    if (input) {
                        input.value = 'Probe User';
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    onboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
                }
                if (script.settingsReady === true) { result.settingsReady = true; return result; }
                await new Promise(resolve => setTimeout(resolve, 150));
            }
            result.timedOut = true;
            return result;
        });
        ready.preloaderGone = true;
        ready.title = await page.title().catch(() => null);
        ready.waitedMs = Date.now() - started;
        record(`${label}-page-reached`, ready.settingsReady === true, ready);
        return ready;
    }

    async function readFinalState() {
        return page.evaluate(async () => {
            const script = await import('./script.js');
            return {
                settingsReady: script.settingsReady === true,
                extensionContainerCount: document.querySelectorAll('#extensions_settings2 .extension_container, #extensions_settings .extension_container').length,
                extensionSettingsPresent: Boolean(document.querySelector('#extensions_settings, #extensions_settings2')),
                characterListPresent: Boolean(document.querySelector('#rm_print_characters_block')),
                sendButtonPresent: Boolean(document.querySelector('#send_but')),
            };
        });
    }

    async function readChat() {
        return page.evaluate(async () => {
            const script = await import('./script.js');
            const chat = script.chat ?? [];
            const last = chat[chat.length - 1] ?? null;
            return { opened: chat.length > 0, chatLength: chat.length, lastText: String(last?.mes ?? '').slice(0, 300), lastIsUser: last?.is_user === true, chatId: window.SillyTavern?.getContext?.()?.chatId ?? null };
        });
    }

    async function connectPeer() {
        await configureConnection(page, { url: peerURL, model: 'corpus-probe-model' });
        await page.evaluate(async () => {
            const openai = await import('./scripts/openai.js');
            openai.oai_settings.stream_openai = true;
        });
        await waitForNetworkQuiet(requests, { quietMs: 1200, deadlineMs: 30000, subjectOrigin });
    }

    // THE PAGE CAN BE MID-GENERATION WHEN THE NEXT SOAK STEP RUNS. A send clicked while the frontend is
    // still streaming is refused by the frontend's own gate (`isGenerating`), so the soak would record a
    // send that never happened and stop (measured: soak iteration 9 on the stock leg of run 41577643804).
    // The stop button is visible exactly while a generation is in flight, so waiting for it to disappear is
    // the page's own definition of idle; if it never disappears, the stop control is clicked once so the
    // next iteration can proceed.
    async function waitForIdle(deadlineMs = 30000) {
        const deadline = Date.now() + deadlineMs;
        while (Date.now() < deadline) {
            const state = await page.evaluate(async () => {
                const script = await import('./script.js');
                const stop = document.querySelector('#mes_stop');
                const stopVisible = Boolean(stop) && stop.offsetParent !== null;
                return { stopVisible, streaming: script.streamingProcessor === true };
            }).catch(() => ({ stopVisible: true, streaming: true }));
            if (!state.stopVisible && !state.streaming) return { idle: true };
            await page.waitForTimeout(200);
        }
        // Still busy: click the stop control once (the frontend's own cancel path) and give it a moment.
        await page.evaluate(() => {
            const stop = document.querySelector('#mes_stop');
            if (stop && stop.offsetParent !== null) stop.click();
        }).catch(() => {});
        await page.waitForTimeout(1000);
        return { idle: false };
    }

    async function sendAndWait(marker) {
        await waitForIdle();
        const baseline = await page.evaluate(async () => {
            const script = await import('./script.js');
            const chat = script.chat ?? [];
            const last = chat[chat.length - 1] ?? null;
            return { chatLength: chat.length, lastTextLength: String(last?.mes ?? '').length };
        });
        const before = peer.requests.length;
        const sent = await sendTurn(page, marker);
        if (!sent?.clicked) return { ok: false, marker, reason: 'send control did not click', sent };
        const replied = await waitForReply(page, { baseline, peerCompletions: peer.requests, timeoutMs: 120000 });
        const arrived = await (async () => {
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline && peer.requests.length <= before) await page.waitForTimeout(200);
            return peer.requests.length > before;
        })();
        return { ok: replied?.ok === true && arrived, marker, sent, replied, providerRequests: peer.requests.length - before };
    }

    async function cancelStreamingReply(marker) {
        const cancelled = await page.evaluate(async text => {
            const script = await import('./script.js');
            const textarea = document.querySelector('#send_textarea');
            const button = document.querySelector('#send_but');
            if (!textarea || !button) return { attempted: false, reason: 'send controls missing' };
            textarea.value = text;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            button.click();
            // THE STOP CONTROL APPEARS WHEN GENERATION STARTS (finishGenerating -> showStopButton), so the
            // click waits for it within a bounded window; the delayed peer keeps the reply in flight.
            const stopDeadline = performance.now() + 5000;
            let stop = null;
            while (performance.now() < stopDeadline) {
                stop = document.querySelector('#mes_stop');
                if (stop) break;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            const stopPresent = Boolean(stop);
            if (stop) stop.click();
            const deadline = performance.now() + 15000;
            while (performance.now() < deadline) {
                if (script.is_send_press !== true && !script.streamingProcessor) break;
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return { attempted: true, stopPresent, idleAfter: script.is_send_press !== true && !script.streamingProcessor };
        }, marker);
        return { ...cancelled, marker };
    }

    async function toggleSettingAndSave() {
        return page.evaluate(async () => {
            const script = await import('./script.js');
            const openai = await import('./scripts/openai.js');
            const before = openai.oai_settings.stream_openai === true;
            openai.oai_settings.stream_openai = !before;
            const saved = await script.saveSettings();
            const after = openai.oai_settings.stream_openai === true;
            return { before, after, saved: saved === undefined ? true : Boolean(saved) };
        });
    }

    // ---- BEFORE / AFTER PHASE DRIVE ---------------------------------------------------------------
    await reachPage(phase);
    const extensionFacts = await waitForExtensions(names);
    report.extensions = extensionFacts;
    record('extension-assets-settled', true, { loaded: extensionFacts.filter(entry => entry.loaded).length, total: names.length });
    // THE DRIVE GUARD WATCHES THE SUBJECT'S OWN ORIGIN. External egress is classified against the DECLARED
    // origin set: a stalled declared origin is recorded (it is runner network weather -- runs 42478967874 and
    // 42477517830 failed this leg and the PINNED oracle leg identically on one), while an UNDECLARED origin is
    // a named drive failure. Both facts are steps, so the split is visible in the emitted evidence.
    const classified = await settleWithEgressClassification(requests, { subjectOrigin, quietMs: 2500, deadlineMs: 120000 });
    record('network-quiet', classified.quiet.quiet === true, classified.quiet);
    record('external-egress-classified', classified.external.unexpected.length === 0, {
        origins: Object.keys(classified.external.origins),
        unexpected: classified.external.unexpected,
        pending: classified.external.pending,
        byOrigin: classified.external.origins,
    });
    report.externalEgress = classified.external;
    report.networkClassification = {
        quiet: classified.quiet.quiet === true,
        sameOriginScope: classified.quiet.scope,
        unresolvedSameOrigin: classified.quiet.unresolved ?? [],
        external: classified.external,
    };
    console.error(`[${subject}/${phase}] network-classification :: ${JSON.stringify({ sameOriginQuiet: classified.quiet.quiet === true, unresolvedSameOrigin: classified.quiet.unresolved ?? [], origins: Object.keys(classified.external.origins), unexpected: classified.external.unexpected, pending: classified.external.pending })}`);

    const opened = await openCharacter(page, cardName);
    record('character-opened', opened?.opened === true, opened);
    await page.waitForTimeout(500);
    const chatBefore = await readChat();
    record('chat-loaded', chatBefore.opened === true, { chatLength: chatBefore.chatLength, chatId: chatBefore.chatId });
    await connectPeer();

    const soakSamples = [];
    let chatAfter = chatBefore;
    if (mode === 'load') {
        const marker = `CORPUS_${subject.toUpperCase()}_${phase.toUpperCase()}_TURN_${Date.now()}`;
        const send = await sendAndWait(marker);
        record('load-turn-sent', send.ok === true, send);
        chatAfter = await readChat();
        report.chat = { ...chatAfter, marker, phase, opened: opened?.opened === true };
    } else {
        const minutes = phase === 'after' ? Math.min(soakMinutes, 2) : soakMinutes;
        const soakStarted = Date.now();
        const deadline = soakStarted + Math.max(1, minutes) * 60000;
        let iteration = 0;
        while (Date.now() < deadline) {
            iteration += 1;
            const startedAt = Date.now();
            // AN EXTENSION MAY RELOAD THE PAGE WHEN A SETTING IS SAVED. The soak toggles a setting every
            // other iteration, and a frontend that reloads (or navigates) destroys the execution context of
            // an in-flight evaluate: measured as `page.evaluate: Execution context was destroyed` on the
            // GoTavern leg of run 41577643804. Recovery is explicit and bounded: re-reach the page once,
            // reconnect the peer, and run the iteration again; a second failure is the iteration's failure.
            const runIteration = async () => {
                const rssNow = readVmRss(serverPid);
                const goroutinesNow = await readGoroutines();
                const sample = { iteration, at: new Date(startedAt).toISOString(), rssKb: rssNow.kb, rssReason: rssNow.reason, goroutines: goroutinesNow.value, goroutinesReason: goroutinesNow.reason, steps: [] };
                const sendMarker = `CORPUS_${subject.toUpperCase()}_${phase.toUpperCase()}_SOAK_${iteration}`;
                const send = await sendAndWait(sendMarker);
                sample.steps.push({ name: 'send', ok: send.ok === true });
                sample.sendOk = send.ok === true;
                // A FAILED SEND ENDS THE ITERATION. Running cancel/toggle/reload on a page whose send was
                // refused compounds the failure and makes the sample unreadable; the loop below retries the
                // send once from a freshly reached page and only then gives up.
                if (!send.ok) return sample;
                if (iteration % 3 === 0) {
                    const cancelled = await cancelStreamingReply(`CORPUS_${subject.toUpperCase()}_${phase.toUpperCase()}_CANCEL_${iteration}`);
                    sample.cancelled = cancelled;
                    sample.steps.push({ name: 'cancel', ok: cancelled.attempted === true && cancelled.idleAfter !== false });
                }
                if (iteration % 2 === 0) {
                    const toggled = await toggleSettingAndSave();
                    sample.setting = toggled;
                    sample.steps.push({ name: 'toggle-setting', ok: toggled.after !== toggled.before });
                }
                if (iteration % 5 === 0) {
                    const reloadStarted = Date.now();
                    await reachPage(`${phase}-soak-${iteration}-reload`).catch(error => record('soak-reload', false, String(error.message ?? error)));
                    sample.reloadMs = Date.now() - reloadStarted;
                    await connectPeer();
                    sample.steps.push({ name: 'reload', ok: true });
                }
                const apiEntries = requests.filter(entry => entry.path.startsWith('/api/') && entry.status !== null);
                sample.apiResponses = apiEntries.length;
                sample.apiFailures = apiEntries.filter(entry => entry.status >= 400).length;
                sample.serverErrors = apiEntries.filter(entry => entry.status >= 500).length;
                sample.latencyMs = latencyOf(apiEntries.map(entry => entry.latencyMs).filter(value => typeof value === 'number'));
                sample.pageErrorCount = report.pageErrors.length;
                sample.durationMs = Date.now() - startedAt;
                return sample;
            };
            let sample;
            try {
                sample = await runIteration();
            } catch (error) {
                const message = String(error.message ?? error);
                if (!/Execution context was destroyed|Target closed|navigat/i.test(message)) throw error;
                record(`soak-iteration-${iteration}-recovered`, true, { reason: message });
                await reachPage(`${phase}-soak-${iteration}-recover`).catch(() => {});
                await connectPeer().catch(() => {});
                sample = await runIteration();
            }
            // A REFUSED SEND GETS ONE RECOVERY ATTEMPT FROM A FRESHLY REACHED PAGE. Measured on the Windows
            // local soak: iteration 12 (the one that cancels and toggles after a reload iteration) left the
            // page busy enough that the frontend refused the send, the reply wait timed out and the sample
            // read as a failed soak. The recovery is bounded and recorded; a second refusal is the
            // iteration's failure.
            if (sample.sendOk !== true) {
                record(`soak-iteration-${iteration}-send-recovered`, true, { firstAttempt: sample });
                await reachPage(`${phase}-soak-${iteration}-send-recover`).catch(() => {});
                await connectPeer().catch(() => {});
                await waitForIdle(20000);
                const retrySend = await sendAndWait(`CORPUS_${subject.toUpperCase()}_${phase.toUpperCase()}_SOAK_${iteration}_RETRY`);
                sample.steps.push({ name: 'send-retry', ok: retrySend.ok === true });
                sample.sendOk = retrySend.ok === true;
            }
            soakSamples.push(sample);
            record(`soak-iteration-${iteration}`, sample.sendOk === true, { sendOk: sample.sendOk, apiFailures: sample.apiFailures, rssKb: sample.rssKb });
            if (!sample.sendOk) break;
        }
        chatAfter = await readChat();
        const rssValues = soakSamples.map(sample => sample.rssKb).filter(value => typeof value === 'number');
        const iterationApi = soakSamples.reduce((sum, sample) => sum + (sample.apiFailures ?? 0), 0);
        const iterationApiTotal = soakSamples.reduce((sum, sample) => sum + (sample.apiResponses ?? 0), 0);
        const allApiLatencies = requests.filter(entry => entry.path.startsWith('/api/') && entry.status !== null && typeof entry.latencyMs === 'number').map(entry => entry.latencyMs);
        const unmeasured = [];
        const rssSample = readVmRss(serverPid);
        const goroutineSample = await readGoroutines();
        if (rssSample.kb === null) unmeasured.push({ metric: 'rssKb', reason: rssSample.reason });
        if (goroutineSample.value === null) unmeasured.push({ metric: 'goroutines', reason: goroutineSample.reason });
        const orphans = orphanProcesses();
        report.soak = {
            requestedMinutes: minutes,
            minutes: (Date.now() - soakStarted) / 60000,
            iterations: soakSamples.length,
            samples: soakSamples,
            rssKb: { first: soakSamples[0]?.rssKb ?? null, last: soakSamples[soakSamples.length - 1]?.rssKb ?? null, max: rssValues.length ? Math.max(...rssValues) : null, samples: rssValues },
            goroutines: goroutineSample,
            apiResponses: iterationApiTotal,
            apiFailures: iterationApi,
            serverErrors: soakSamples.reduce((sum, sample) => sum + (sample.serverErrors ?? 0), 0),
            failureRate: iterationApiTotal > 0 ? iterationApi / iterationApiTotal : null,
            latencyMs: latencyOf(allApiLatencies),
            browserErrorCount: report.pageErrors.length + report.consoleErrors.length,
            unmeasured,
            orphanCheck: { ...orphans, subjectPid: serverPid, subjectPidAlive: (() => { try { process.kill(serverPid, 0); return true; } catch { return false; } })() },
        };
        report.chat = { ...chatAfter, phase, opened: opened?.opened === true };
    }

    report.finalState = await readFinalState();
    record('final-state-read', report.finalState !== null, report.finalState);
    report.rows = requests.map(entry => ({
        method: entry.method, origin: entry.origin, sameOrigin: entry.sameOrigin === true, path: entry.path.split('?')[0], status: entry.status, contentType: entry.contentType,
        bodyLength: entry.bodyLength, bodySha256: entry.bodySha256, bodyShape: entry.bodyShape, liveEgress: entry.liveEgress,
        latencyMs: entry.latencyMs,
    }));
    // REQUEST COUNT IS A FACT OF THE LEG, not a guess: the comparator can see whether both drives reached
    // the same surface, and a leg that recorded no extension asset at all is visible here.
    record('requests-recorded', requests.length > 0, { requests: requests.length });
} catch (error) {
    report.failure = String(error.message ?? error).slice(0, 2000);
    // Record what the leg had observed when the drive failed: rows + unresolved requests + a best-effort final
    // state. Without this a preloader timeout is a bare string and the next fix starts from a guess.
    try {
        const requestsSeen = typeof requests !== 'undefined' ? requests : [];
        report.rows = requestsSeen.map(entry => ({ method: entry.method, origin: entry.origin, sameOrigin: entry.sameOrigin === true, path: entry.path.split('?')[0], status: entry.status, contentType: entry.contentType, bodyLength: entry.bodyLength, bodySha256: entry.bodySha256, bodyShape: entry.bodyShape, liveEgress: entry.liveEgress, latencyMs: entry.latencyMs }));
        report.unresolvedRequests = requestsSeen.filter(entry => entry.status === null).map(entry => ({ method: entry.method, path: entry.path, startedAt: entry.startedAt }));
        report.finalState = await readFinalState().catch(() => null);
    } catch (secondary) {
        report.failureDiagnostics = String(secondary.message ?? secondary);
    }
    console.error(`[${subject}/${phase}] FAILURE: ${report.failure}`);
} finally {
    if (browser) await browser.close().catch(() => {});
    if (peer) await peer.close().catch(() => {});
}

// A leg's own hard failures: the page never reached settingsReady, or no character/chat could be opened.
const failedSteps = report.steps.filter(step => step.ok !== true).map(step => step.name);
if (report.failure === null && failedSteps.length > 0) {
    // Extension-load facts are NOT leg failures (the comparator judges them); a failed DRIVE step is.
    report.failure = `drive steps did not hold: ${failedSteps.join(', ')}`;
}
report.finishedAt = new Date().toISOString();
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify({
    subject, phase, mode,
    extensions: report.extensions.map(entry => ({ name: entry.name, loaded: entry.loaded, firstFailingUrl: entry.firstFailingUrl })),
    failedSteps, failure: report.failure,
    soak: report.soak ? { iterations: report.soak.iterations, rssKb: report.soak.rssKb.max, p95: report.soak.latencyMs.p95, unmeasured: report.soak.unmeasured } : null,
}, null, 2));
if (report.failure) process.exitCode = 1;
