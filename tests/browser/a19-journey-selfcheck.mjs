// a19-journey-selfcheck.mjs -- a MINIMAL journey whose only job is to prove the alpha.19 LIVE ORACLE
// plumbing end to end (copy -> boot both subjects -> record five layers -> compare -> teeth).
//
// IT IS NOT THE ALPHA.19 ORACLE. The corpus it runs over is the existing SYNTHETIC long-lived corpus
// (docs/longlived-corpus.md says "synthetic and deterministic"), which the user prompt forbids treating
// as the Node-UI-Originated Corpora. Every artifact this file contributes to MUST stay labelled
// "harness self-check; synthetic stand-in, NOT the alpha.19 oracle" (the driver enforces the label and
// refuses to emit the real evidence-contract artifact in this mode). The real journey is Subagent A's
// a19-journey-probe.mjs, which follows the same LEG SCHEMA contract documented in a19-oracle-kit.mjs.
//
// CONTRACT (same as the real journey probe; the driver passes these):
//   --base-url <url>        the subject's base URL (ALSO in PROBE_BASE_URL). Present => DO NOT boot a
//                           server; the driver owns the process.
//   --data-root <path>      the subject's COPY of the corpus
//   --phase drive|restart   which half of the journey this leg is
//   --peer-url <url>        the driver's recording peer; the page is pointed at it through the
//                           frontend's own controls. This probe never starts its own peer.
//   --reply-prefix <P>      the per-subject discriminator the peer stamped (recorded, not applied here)
//   --report <path>         where the leg report is written (schema a19-live-oracle-leg-v1)
//
// LAYERS RECORDED HERE: A browser, B HTTP, D persistence, E lifecycle. C provider wire is recorded by
// the DRIVER's peer, because it is the same peer implementation for both subjects by construction.

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { openPage, readReadiness, resolveRoster, openCharacter, configureConnection, sendTurn, waitForReply, saveConditional, readChatFiles } from './q20-persistence-drive.mjs';
import { censusTree, emptyLeg, sha256, writeJson } from './a19-oracle-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
void here;

function argumentValue(argv, name, fallback = null) {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    return value === undefined ? fallback : value;
}

const argv = process.argv.slice(2);
const baseURL = process.env.PROBE_BASE_URL ?? argumentValue(argv, '--base-url', null);
const dataRoot = argumentValue(argv, '--data-root', null);
const phase = argumentValue(argv, '--phase', 'drive');
const peerURL = argumentValue(argv, '--peer-url', null);
const replyPrefix = argumentValue(argv, '--reply-prefix', '');
const reportPath = argumentValue(argv, '--report', null);
const journey = 'a19-journey-selfcheck';
const subject = argumentValue(argv, '--subject', null) ?? 'unknown';

if (!baseURL) throw new Error('a19-journey-selfcheck: --base-url (or PROBE_BASE_URL) is required; the driver owns the server process');
if (!dataRoot) throw new Error('a19-journey-selfcheck: --data-root is required');
if (!peerURL) throw new Error('a19-journey-selfcheck: --peer-url is required; this probe never invents a peer');
if (!reportPath) throw new Error('a19-journey-selfcheck: --report is required');

const browserModule = await import('@playwright/test');
const chromium = browserModule.chromium ?? browserModule.default?.chromium;

const leg = emptyLeg({ subject, phase, journey, corpusTreeSha256: null });
leg.baseURL = baseURL;
leg.peerURL = peerURL;
leg.wireMode = 'driver-peer';
leg.replyPrefix = replyPrefix;
// THE SERVER PROCESS IDENTITY, from the wrapper that owns the process (run-against-pinned.mjs exports
// PROBE_SERVER_PID; the driver passes the pid of the GoTavern process it spawned). A restart leg can then
// be proven to be a NEW process instead of assuming it.
leg.serverPid = process.env.PROBE_SERVER_PID ? Number(process.env.PROBE_SERVER_PID) : null;
const steps = leg.steps;
const record = (name, ok, detail = null) => {
    steps.push({ name, ok: ok === true, at: new Date().toISOString(), detail: detail ?? null });
    if (ok !== true) console.error(`[selfcheck/${phase}] FAIL ${name} :: ${JSON.stringify(detail)}`);
};

// The subject's own origin: stripped from RECORDED strings so the harness-allocated random port never
// survives in a compared field (AGENTS fixture rule 18: an unstable value must not survive in any field
// that is compared). This is a RECORDING convention, not a comparison normalisation.
const stripOwnOrigin = value => String(value ?? '').split(baseURL).join('<BASE>');
const stripDiscriminator = value => String(value ?? '').replace(/A19(?:HB)?[GP]_/g, '<REPLY_PREFIX>');

// -----------------------------------------------------------------------------------------------------
// B. HTTP layer: every request/response the page made, with SSE byte boundaries.
// -----------------------------------------------------------------------------------------------------
const http = { requests: [] };
const attachHttpRecorder = page => {
    const pending = new Map();
    page.on('request', request => {
        const url = new URL(request.url());
        // THE LIVE ORACLE'S HTTP LAYER IS THE /api SURFACE. Static frontend assets have their own gates and carry
        // the recorded embedded-public validator divergence (docs/compat-matrix.md "Frontend static middleware");
        // recording them here would compare a known, documented non-parity surface. A's real probe scopes the same
        // way, so the two journeys record the same layer.
        if (!url.pathname.startsWith('/api/')) return;
        const entry = {
            index: http.requests.length,
            method: request.method(),
            origin: url.origin === new URL(baseURL).origin ? 'subject' : url.origin,
            path: url.pathname,
            query: url.search,
            requestHeaders: null,
            requestBodyText: null,
            requestBodyLength: null,
            requestBodySha256: null,
            status: null,
            responseHeaders: null,
            responseBodyLength: null,
            responseBodySha256: null,
            contentType: '',
            sseFrameBytes: null,
        };
        // THE REQUEST BODY, for the layer-B body comparison. Recorded as text (the page's own JSON) so the
        // comparator can apply its NAMED normalisations (per-subject discriminator, wall-clock members) instead
        // of comparing a digest that differs for harness reasons.
        try {
            const text = request.postData();
            if (typeof text === 'string') {
                entry.requestBodyText = text;
                entry.requestBodyLength = Buffer.byteLength(text);
                entry.requestBodySha256 = sha256(Buffer.from(text, 'utf8'));
            }
        } catch { /* no body on this request */ }
        pending.set(request, entry);
        http.requests.push(entry);
        request.allHeaders().then(headers => { entry.requestHeaders = headers; }).catch(() => {});
    });
    page.on('response', async response => {
        const entry = pending.get(response.request());
        if (!entry) return;
        entry.status = response.status();
        try { entry.responseHeaders = await response.allHeaders(); } catch { entry.responseHeaders = null; }
        entry.contentType = entry.responseHeaders?.['content-type'] ?? '';
        try {
            const body = await response.body();
            entry.responseBodyLength = body.length;
            entry.responseBodySha256 = sha256(body);
            // The response body TEXT too, for the same named normalisations (only for bodies small enough to be
            // JSON state rather than a large asset; the digest still covers everything). The /api surface includes
            // SSE and routes whose Content-Type is only known after the body is read, so the scope is "any small
            // same-origin /api response", not "only json/event-stream" -- the generate proxy's streamed body was
            // recorded with a digest but no text because its Content-Type header arrived empty.
            if (body.length <= 2 * 1024 * 1024 && typeof entry.path === 'string' && entry.path.startsWith('/api/')) {
                try { entry.responseBodyText = body.toString('utf8'); } catch { entry.responseBodyText = null; }
            }
            if (entry.contentType.includes('text/event-stream')) {
                // THE SSE BYTE BOUNDARIES: the byte length of each `data:` frame, derived from the raw
                // bytes (not from a parsed event) so two subjects' framing is compared, not inferred.
                const frames = [];
                let offset = 0;
                while (offset < body.length) {
                    const next = body.indexOf('\n\n', offset);
                    const end = next === -1 ? body.length : next + 2;
                    frames.push(end - offset);
                    offset = end;
                    if (next === -1) break;
                }
                entry.sseFrameBytes = frames;
            }
        } catch {
            // redirects / aborted streams have no readable body
        }
    });
};

// -----------------------------------------------------------------------------------------------------
// A. Browser layer: readiness, images DECODED, selected state, console/page errors, iframes, event
//    order, final chat state.
// -----------------------------------------------------------------------------------------------------
const browserLayer = {
    readiness: null,
    roster: null,
    images: [],
    selected: null,
    consoleErrors: [],
    pageErrors: [],
    iframes: [],
    eventOrder: [],
    finalChat: null,
};

const attachErrorRecorders = page => {
    page.on('console', message => {
        if (message.type() === 'error') browserLayer.consoleErrors.push(stripOwnOrigin(message.text()).slice(0, 400));
    });
    page.on('pageerror', error => browserLayer.pageErrors.push(stripOwnOrigin(error.message).slice(0, 400)));
};

/**
 * EVENT ORDER, captured from the page's own event bus. The hook is installed with addInitScript so it
 * runs before the page's scripts; it wraps `getContext().eventSource.emit` once the handle exists (the
 * handle is `getContext().eventSource`, not `SillyTavern.eventSource` -- q20-persistence-drive.mjs
 * records that measurement). Only event NAMES are recorded: a timestamp would be host noise.
 */
const attachEventOrderHook = page => page.addInitScript(() => {
    window.__a19EventOrder = [];
    let attempts = 0;
    const attach = () => {
        let source = null;
        try { source = window.SillyTavern?.getContext?.()?.eventSource ?? null; } catch { source = null; }
        if (source && typeof source.emit === 'function') {
            const original = source.emit;
            source.emit = function (name, ...rest) {
                if (window.__a19EventOrder.length < 500 && typeof name === 'string') window.__a19EventOrder.push(name);
                return original.call(this, name, ...rest);
            };
            window.__a19EventOrderWrapped = true;
            return;
        }
        if (++attempts < 6000) setTimeout(attach, 5);
    };
    attach();
});

/** Image DECODE proof: natural size plus a pixel digest from a canvas, for every rendered image. */
const readDecodedImages = page => page.evaluate(() => {
    const digest = canvas => {
        try {
            const context = canvas.getContext('2d');
            const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
            let hash = 2166136261;
            for (let index = 0; index < data.length; index += 4) {
                hash ^= data[index]; hash = Math.imul(hash, 16777619);
                hash ^= data[index + 1]; hash = Math.imul(hash, 16777619);
                hash ^= data[index + 2]; hash = Math.imul(hash, 16777619);
            }
            return (hash >>> 0).toString(16).padStart(8, '0');
        } catch { return null; }
    };
    const entries = [];
    const images = [...document.querySelectorAll('img')].slice(0, 80);
    for (const [index, image] of images.entries()) {
        const entry = {
            index,
            id: image.id || null,
            className: image.className || null,
            src: String(image.getAttribute('src') ?? '').split('?')[0],
            naturalWidth: image.naturalWidth ?? 0,
            naturalHeight: image.naturalHeight ?? 0,
            complete: image.complete === true,
            decoded: (image.naturalWidth ?? 0) > 0 && (image.naturalHeight ?? 0) > 0,
            pixelDigest: null,
        };
        if (entry.decoded) {
            try {
                const canvas = document.createElement('canvas');
                canvas.width = image.naturalWidth;
                canvas.height = image.naturalHeight;
                canvas.getContext('2d').drawImage(image, 0, 0);
                entry.pixelDigest = digest(canvas);
            } catch { entry.pixelDigest = null; }
        }
        entries.push(entry);
    }
    return entries;
});

const readSelectedState = page => page.evaluate(async () => {
    const script = await import('./script.js');
    const context = window.SillyTavern?.getContext?.() ?? null;
    const preset = document.querySelector('#settings_preset_openai');
    const world = document.querySelector('#world_info');
    return {
        chid: context?.characterId ?? script.this_chid ?? null,
        characterName: script.characters?.[context?.characterId ?? script.this_chid]?.name ?? null,
        chatId: context?.chatId ?? null,
        presetName: preset?.selectedOptions?.[0]?.textContent ?? preset?.value ?? null,
        worldName: world?.selectedOptions?.[0]?.textContent ?? world?.value ?? null,
    };
});

const readIframes = page => page.evaluate(() => [...document.querySelectorAll('iframe')].map(frame => ({
    id: frame.id || null,
    className: frame.className || null,
    src: (() => { try { return new URL(frame.src).pathname; } catch { return String(frame.getAttribute('src') ?? ''); } })(),
})));

/**
 * Let the page's event bus go quiet, then (optionally) RESTART the log. The comparison covers the events the
 * JOURNEY's actions emit; load-time and reload-time initialisation events are recorded separately because which of
 * them the polling hook catches is a race with the page's own init (measured: the faster subject lost
 * `chatLoaded`/`settings_updated`). A bounded quiet window is what makes the boundary a measurement.
 */
async function settleEvents(page, { quietMs = 1500, maxMs = 20000, reset = false } = {}) {
    const started = Date.now();
    let last = await page.evaluate(() => (window.__a19EventOrder ?? []).length);
    let lastChange = Date.now();
    while (Date.now() - started < maxMs) {
        await page.waitForTimeout(100);
        const length = await page.evaluate(() => (window.__a19EventOrder ?? []).length);
        if (length !== last) { last = length; lastChange = Date.now(); }
        else if (Date.now() - lastChange >= quietMs) break;
    }
    if (reset) await page.evaluate(() => { window.__a19EventOrder = []; });
    return last;
}

const readFinalChat = page => page.evaluate(async () => {
    const script = await import('./script.js');
    const context = window.SillyTavern?.getContext?.() ?? null;
    const chat = script.chat ?? [];
    const tail = chat[chat.length - 1] ?? null;
    return {
        chatId: context?.chatId ?? null,
        length: chat.length,
        lastIsUser: tail?.is_user === true,
        lastText: String(tail?.mes ?? ''),
        lastTextLength: String(tail?.mes ?? '').length,
        lastTextSha256: null,
    };
});

// -----------------------------------------------------------------------------------------------------
// THE JOURNEY (minimal, but user-reachable): open -> decode images -> select -> configure -> send ->
// reply -> save -> reload -> read back -> census.
// -----------------------------------------------------------------------------------------------------
let browser = null;
try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    const page = await context.newPage();
    attachHttpRecorder(page);
    attachErrorRecorders(page);
    await attachEventOrderHook(page);

    const opened = await openPage(page, baseURL);
    record('page-loaded', opened === true, await readReadiness(page));
    browserLayer.readiness = await readReadiness(page);
    // LOAD-TIME EVENTS ARE RECORDED BUT NOT COMPARED: which of them the polling hook catches is a race with the
    // page's own init (measured: the faster subject lost `chatLoaded`/`settings_updated`). The comparison starts
    // after readiness, so it covers the events the DRIVE emits, which is the claim layer E is about.
    browserLayer.loadEvents = await page.evaluate(() => window.__a19EventOrder ?? []);
    browserLayer.loadEventCount = browserLayer.loadEvents.length;
    await settleEvents(page, { reset: true });

    // Images decode BEFORE any click: this is the "the page shows pictures" observation.
    // WAIT FOR THE PAGE'S OWN IMAGES TO SETTLE before snapshotting: an image still loading is not a broken
    // image, and comparing a mid-load set would make the two legs' timing look like a product difference.
    await page.waitForFunction(() => [...document.images].every(image => image.complete === true), null, { timeout: 30000 }).catch(() => {});
    browserLayer.images = await readDecodedImages(page);
    record('images-recorded', browserLayer.images.length > 0, { images: browserLayer.images.length, decoded: browserLayer.images.filter(entry => entry.decoded).length });

    browserLayer.roster = await resolveRoster(page);
    record('roster-recorded', (browserLayer.roster?.count ?? 0) > 0, browserLayer.roster);
    browserLayer.iframes = await readIframes(page);

    const targetName = browserLayer.roster.names[0] ?? null;
    const character = await openCharacter(page, targetName);
    record('character-opened', character?.opened === true, character);
    browserLayer.selected = await readSelectedState(page);

    const configured = await configureConnection(page, { url: peerURL, model: 'a19-live-model' });
    record('connection-configured', configured?.url === peerURL, configured);

    if (phase === 'drive') {
        // THE USER TURN IS SHARED INPUT: the same text must reach both subjects, or the persisted chat and the
        // provider context differ for a HARNESS reason (rule 50). Only the peer's REPLY carries a per-subject
        // discriminator. The driver passes A19_TURN_MARKER so a run can date its marker without changing that.
        const marker = process.env.A19_TURN_MARKER ?? 'A19_SELFCHECK_TURN';
        const send = await sendTurn(page, marker);
        record('turn-sent', send?.clicked === true, send);
        // THE BASELINE IS THE PAGE'S OWN, FROM IMMEDIATELY BEFORE THE CLICK. A hand-built baseline with
        // lastTextLength:0 makes moved true on the first poll for any chat whose tail is non-empty -- the
        // measured failure that made this leg reload a page mid-generation and abort the provider request.
        const reply = await waitForReply(page, { timeoutMs: 120000, requireText: true, baseline: send?.baseline ?? null });
        record('reply-arrived', reply?.ok === true, reply);
        const saved = await saveConditional(page);
        record('save-requested', saved?.ok === true, saved);
        // THE DRIVE'S OWN EVENT SEQUENCE, captured BEFORE the reload. The reload resets the bus (its load-time
        // events are a race, not a subject observation), so the compared sequence must be taken here.
        browserLayer.driveEvents = await page.evaluate(() => window.__a19EventOrder ?? []);
        // A fresh page must read the chat the previous page wrote (the reload face of the persistence layer).
        // WAIT ON THE QUANTITY THE ASSERTION READS (a chat identity and length restored), not on openPage's
        // readiness flag: after a reload the chat loads asynchronously and an immediate read saw the welcome
        // screen (measured: chatId null, length 2).
        const chatBeforeReload = await readFinalChat(page);
        await openPage(page, baseURL);
        // A RELOADED PAGE DOES NOT REOPEN THE CHAT BY ITSELF (measured: chatId null, length 2), which is why the
        // long-lived probe "reopens the card after each reload". A user clicks the card; this leg does the same.
        const reloadRoster = await resolveRoster(page);
        const reloadName = reloadRoster.names[0] ?? null;
        const reloadOpened = await openCharacter(page, reloadName);
        record('reload-character-opened', reloadOpened?.opened === true, reloadOpened);
        await settleEvents(page, { reset: true });
        const reloadDeadline = Date.now() + 60000;
        let chatAfterReload = await readFinalChat(page);
        while (Date.now() < reloadDeadline) {
            if (chatAfterReload.chatId !== null && chatAfterReload.length >= chatBeforeReload.length) break;
            await page.waitForTimeout(250);
            chatAfterReload = await readFinalChat(page);
        }
        browserLayer.lifecycleReload = {
            before: chatBeforeReload,
            after: chatAfterReload,
            sameChatId: chatBeforeReload.chatId !== null && chatBeforeReload.chatId === chatAfterReload.chatId,
            lengthPreserved: chatAfterReload.length >= chatBeforeReload.length,
        };
        record('reload-read-back', browserLayer.lifecycleReload.sameChatId && chatAfterReload.length >= chatBeforeReload.length, browserLayer.lifecycleReload);
    } else {
        // The restart leg: a fresh SERVER process over the tree the drive leg wrote. The driver proves the
        // process identity (pid differs); this leg proves the page reads the persisted chat back BY OPENING
        // the card again (a user does exactly that after a restart), not by trusting settings to resume it.
        const restartRoster = await resolveRoster(page);
        const restartName = restartRoster.names[0] ?? null;
        const reopened = await openCharacter(page, restartName);
        record('restart-character-opened', reopened?.opened === true, reopened);
        // The resumed chat loads asynchronously after the card click; wait for the product's own chatId and
        // length rather than reading the page in the middle of the load.
        const resumeDeadline = Date.now() + 60000;
        let chat = await readFinalChat(page);
        while (Date.now() < resumeDeadline) {
            if (chat.chatId !== null && chat.length > 0) break;
            await page.waitForTimeout(250);
            chat = await readFinalChat(page);
        }
        browserLayer.restartResume = {
            chat,
            resumed: (chat.chatId ?? null) !== null && chat.length > 0,
        };
        record('restart-resumed-chat', browserLayer.restartResume.resumed, browserLayer.restartResume);
    }

    browserLayer.finalChat = await readFinalChat(page);
    if (browserLayer.finalChat.lastText) browserLayer.finalChat.lastTextSha256 = sha256(Buffer.from(browserLayer.finalChat.lastText, 'utf8'));
    browserLayer.finalChat.lastText = stripOwnOrigin(browserLayer.finalChat.lastText);
    await settleEvents(page);
    const finalEvents = await page.evaluate(() => window.__a19EventOrder ?? []);
    browserLayer.eventOrder = phase === 'drive' ? (browserLayer.driveEvents ?? finalEvents) : finalEvents;
    record('event-order-recorded', browserLayer.eventOrder.length > 0, { events: browserLayer.eventOrder.length });
    browserLayer.iframes = await readIframes(page);

    // D. Persistence: the tree this leg's product wrote (the driver diffs it against the corpus census).
    // THE PRODUCT-SURFACE JSON DOCUMENTS, recorded as TEXT so the comparator applies its named normalisations
    // (per-leg peer endpoint, random ids) instead of comparing digests that differ for harness reasons.
    const jsonFiles = [];
    for (const relative of ['default-user/settings.json', 'default-user/image-metadata.json']) {
        try {
            const text = await fs.readFile(path.join(dataRoot, relative), 'utf8');
            if (text.length <= 4 * 1024 * 1024) jsonFiles.push({ path: relative, text });
        } catch { /* absent is a fact the guard reports by its absence */ }
    }
    const chats = await readChatFiles(dataRoot);
    leg.layers.persistence = {
        tree: await censusTree(dataRoot),
        chats: chats.map(chat => ({ file: chat.file, bytes: chat.bytes, sha256: chat.sha256, lines: chat.lines })),
        jsonFiles,
        chatMessages: chats.map(chat => ({ file: chat.file, messages: chat.messages.map(message => ({
            isUser: message?.is_user === true,
            mesLength: String(message?.mes ?? '').length,
            mesSha256: sha256(Buffer.from(String(message?.mes ?? ''), 'utf8')),
            mesSha256Stripped: sha256(Buffer.from(stripDiscriminator(String(message?.mes ?? '')), 'utf8')),
            name: message?.name ?? null,
            sendDate: message?.send_date ?? null,
        })) })),
    };
    record('persistence-censused', leg.layers.persistence.tree.fileCount > 0, { files: leg.layers.persistence.tree.fileCount, bytes: leg.layers.persistence.tree.bytes });

    // E. Lifecycle facts this leg can observe itself (the driver adds process identity and hand-back).
    leg.layers.lifecycle = {
        phase,
        serverPid: leg.serverPid,
        reload: browserLayer.lifecycleReload ?? null,
        restart: browserLayer.restartResume ?? null,
        selectedBeforeReload: browserLayer.selected,
    };
    record('journey-completed', true, { phase });
} catch (error) {
    leg.failure = String(error?.message ?? error).slice(0, 2000);
    console.error(`[selfcheck/${phase}] FAILURE: ${leg.failure}`);
} finally {
    if (browser) await browser.close().catch(() => {});
}

leg.layers.browser = browserLayer;
leg.layers.http = http;
leg.finishedAt = new Date().toISOString();
leg.failedSteps = steps.filter(step => step.ok !== true).map(step => step.name);
if (leg.failure === null && leg.failedSteps.length > 0) leg.failure = `drive steps did not hold: ${leg.failedSteps.join(', ')}`;
await writeJson(path.resolve(reportPath), leg);
console.log(JSON.stringify({ subject, phase, failedSteps: leg.failedSteps, failure: leg.failure, browser: { images: browserLayer.images.length, decoded: browserLayer.images.filter(entry => entry.decoded).length, chatLength: browserLayer.finalChat?.length ?? null, events: browserLayer.eventOrder.length }, http: http.requests.length, persistence: leg.layers.persistence ? { files: leg.layers.persistence.tree.fileCount } : null }));
if (leg.failure) process.exitCode = 1;
