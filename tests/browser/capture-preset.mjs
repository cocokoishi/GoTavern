// Capture the COMPLEX preset from the PINNED frontend, and measure where its context boundary lies.
//
// Run against a running pinned server (run-against-pinned.mjs capture-preset.mjs). It is the only
// producer of tests/browser/fixtures/preset-complex-settings.json: the settings in that file are read
// OUT of the pinned frontend after the scenario is applied, never written by hand, so a re-capture
// after a baseline bump is a byte-for-byte determinism check rather than a manual edit.
//
// THE BOUNDARY IS BINARY-SEARCHED, NOT DERIVED. `openai_max_context` is the only knob that decides
// whether the oldest history turn is kept (public/scripts/openai.js:3982-4089 trims client-side). This
// script drives the pinned frontend's own DRY assembly for a series of contexts and finds the smallest
// one that still contains the oldest marker, then records it and the value one below it. Those two
// numbers are a PINNED OBSERVATION of the pinned trimmer; the drive legs replay them, and the
// comparator requires the pinned leg to reproduce the keep/drop decision at each. No number in this
// file or in the fixture comes from GoTavern.
//
// WHY A DRY ASSEMBLY IS NOT ENOUGH, AND WHAT REPLACED IT. The first version bisected with
// `script.Generate('normal', {}, true)` and recorded the pair it found. Run 40082539457 then drove both
// variants at that exact pair and BOTH produced the drop shape (26 total messages, 11 history turns,
// oldest absent) -- the keep context behaved like the drop context on BOTH servers, identically. So the
// dry assembly costs very slightly less than the send it is supposed to predict (the pair was one token
// apart: 4236 kept, 4235 dropped), and a razor-thin boundary taken from a different assembly cannot bind.
// The boundary is therefore now measured by DRIVING THE REAL SEND against a recording peer: same entry
// point, same chat, same settings, and the compared number is the provider REQUEST the send produced.
// The dry assembly is kept only as a cheap PRE-SCAN that brackets the region for the send bisect, and
// `assemblyMode` in the fixture says which measurement the recorded pair came from.
//
// Usage: node capture-preset.mjs --base-url http://127.0.0.1:8127 [--out <path>]

import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';

import { PRESET_FIXTURE, applyPresetKit, presetSpec } from './preset-kit.mjs';

const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

function argument(name, fallback) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

const baseURL = argument('--base-url', process.env.CAPTURE_BASE_URL ?? 'http://127.0.0.1:8127');
const outPath = path.resolve(argument('--out', PRESET_FIXTURE));

// The pinned count of this body is `openai/count#llama#simple` in
// tests/oracle/sillytavern-1.19.0-tokenizers.json (`token_count: 7`). It is re-asked HERE so the
// fixture records that this server really tokenizes rather than guesstimates: a cold or missing
// tokenizer tree answers a different number on both legs, and the comparator refuses to compare.
const TOKENIZER_ANCHOR = {
    model: 'llama',
    body: [{ role: 'user', content: 'Hello, world!' }],
    pinnedCount: 7,
};

const spec = presetSpec();
const browser = await chromium.launch();
const page = await browser.newPage();
// THE RECORDING PEER. It exists so the boundary can be measured from a REAL SEND: the pinned server
// POSTs the assembled request here and this process records the bytes. It answers with a minimal
// completion so the frontend finishes and the next probe can be sent.
const peer = await startCapturePeer();
console.log(`[capture] provider peer ${peer.origin}`);
const consoleErrors = [];
page.on('pageerror', error => consoleErrors.push(String(error.message ?? error).slice(0, 200)));

// The dry assembly is a frontend function; it reads settings, the chat and the extension prompts and
// returns the assembled message list without any provider call. It is re-entered once per candidate
// context by `assembleAt`, so every probe of the trimmer is the same code path the send uses.
async function assembleAt(maxContext) {
    return page.evaluate(async ({ maxContext, oldestMarker, historyMarker }) => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        // A dry run returns before the fetch (script.js:5320), so no provider is needed; the status
        // check is a user-facing setting and would otherwise refuse a send in this offline capture.
        if ('bypass_status_check' in openai.oai_settings) {
            openai.oai_settings.bypass_status_check = true;
        }
        openai.oai_settings.openai_max_context = maxContext;
        // The prompt manager reports a refused assembly (a mandatory prompt that does not fit) through
        // this field instead of throwing, so it is cleared and read per probe: a stale value would make
        // one probe's diagnosis the next probe's.
        if (openai.promptManager) {
            openai.promptManager.error = null;
        }
        const seen = [];
        const handler = data => seen.push(data);
        script.eventSource.on(script.event_types.GENERATE_AFTER_DATA, handler);
        let failure = null;
        try {
            await script.Generate('normal', {}, true);
        } catch (error) {
            failure = String(error?.message ?? error).slice(0, 300);
        } finally {
            script.eventSource.removeListener(script.event_types.GENERATE_AFTER_DATA, handler);
        }
        const prompt = seen.length ? seen[seen.length - 1]?.prompt : null;
        const messages = Array.isArray(prompt) ? prompt : [];
        const text = message => {
            const content = message?.content;
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
            return '';
        };
        const index = messages.findIndex(message => text(message).includes(oldestMarker));
        // HOW MANY HISTORY MESSAGES SURVIVED. This is the count the boundary is about: the TOTAL message
        // count also moves when the frontend drops its own example/world-info messages at a tight
        // budget, which is how run 40073802369 recorded keep=15 and drop=17 with the wrong pair.
        const historyMessages = messages.filter(message => text(message).includes(historyMarker)).length;
        return {
            maxContext,
            failure,
            promptManagerError: String(openai.promptManager?.error ?? '') .slice(0, 200) || null,
            assemblyCount: seen.length,
            messageCount: messages.length,
            historyMessages,
            oldestIndex: index,
            roles: messages.map(message => message?.role ?? null),
            firstMessageText: text(messages[0] ?? {}).slice(0, 120),
        };
    }, { maxContext, oldestMarker: spec.history[0].text.slice(0, 40), historyMarker: spec.markers.history });
}

// ---------------------------------------------------------------------------------------------
// THE MEASUREMENT THAT BINDS: drive the REAL SEND and read the request it produced.
// ---------------------------------------------------------------------------------------------
function startCapturePeer() {
    const state = { posts: [], origin: null };
    const server = http.createServer((request, response) => {
        if (request.method !== 'POST') {
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ data: [{ id: 'probe-model', name: 'probe-model', context_length: 32768 }] }));
            return;
        }
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            state.posts.push(Buffer.concat(chunks).toString('utf8'));
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({
                id: 'probe-completion',
                object: 'chat.completion',
                created: 1,
                model: 'probe-model',
                choices: [{ index: 0, message: { role: 'assistant', content: 'probe reply' }, finish_reason: 'stop' }],
            }));
        });
    });
    server.unref();
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            state.origin = `http://127.0.0.1:${server.address().port}`;
            resolve({ server, state, origin: state.origin });
        });
    });
}

// ONE definition of what the boundary is measured on, shared by the dry pre-scan and the real send, so
// the two cannot disagree about what "the oldest turn" or "a history message" means.
function metricsOfBody(bodyText, markerOldest, markerHistory) {
    let body = null;
    try {
        body = JSON.parse(bodyText);
    } catch {
        return { messageCount: 0, historyMessages: 0, oldestIndex: -1, parseError: true };
    }
    const messages = Array.isArray(body?.messages) ? body.messages : [];
    const text = message => {
        const content = message?.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
        return '';
    };
    return {
        messageCount: messages.length,
        historyMessages: messages.filter(message => text(message).includes(markerHistory)).length,
        oldestIndex: messages.findIndex(message => text(message).includes(markerOldest)),
    };
}

// sendAt sends ONE real message at `maxContext` through the composer and the send button -- the entry
// point a user uses and the entry point the drive legs use -- and reports what the provider received.
//
// A FRESH PAGE PER PROBE, via bootScenario: the chat, the author's note, the world info, the samplers
// and custom_url are re-established on every probe, so probe N cannot inherit probe N-1's composer,
// chat length or generation state, and custom_url cannot be lost to a settings reload.
async function sendAt(maxContext, peer) {
    const boot = await bootScenario({ includeTypedTurn: false });
    const bootProblems = boot.applied?.problems ?? [];
    if (bootProblems.length > 0) {
        return { maxContext, failure: `the scenario did not apply on a fresh page: ${bootProblems.join('; ')}`, messageCount: 0, historyMessages: 0, oldestIndex: -1 };
    }
    const mark = {
        console: pageLog.console.length,
        errors: pageLog.errors.length,
        requests: pageLog.requests.length,
        responses: pageLog.responses.length,
        posts: peer.state.posts.length,
    };
    const before = await page.evaluate(async () => {
        const script = await import('./script.js');
        return {
            generating: Boolean(script.isGenerating),
            generatingAttr: document.body.dataset.generating ?? null,
            sendDisabled: Boolean(document.querySelector('#send_but')?.disabled),
            chatLength: script.chat.length,
            onlineStatus: String(script.online_status ?? ''),
        };
    });
    const clicked = await page.evaluate(async ({ send, maxContext }) => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        openai.oai_settings.openai_max_context = maxContext;
        const composer = document.querySelector('#send_textarea');
        if (!composer) return { error: 'no #send_textarea in the served frontend' };
        composer.value = send;
        composer.dispatchEvent(new Event('input', { bubbles: true }));
        const button = document.querySelector('#send_but');
        if (!button) return { error: 'no #send_but in the served frontend' };
        const disabledBefore = Boolean(button.disabled);
        button.click();
        await new Promise(resolve => setTimeout(resolve, 500));
        return {
            disabledBefore,
            chatLengthAfter: script.chat.length,
            generatingAfter: Boolean(script.isGenerating),
            generatingAttrAfter: document.body.dataset.generating ?? null,
            contextApplied: Number(openai.oai_settings.openai_max_context),
            composerValueAfter: String(document.querySelector('#send_textarea')?.value ?? ''),
            promptManagerError: String(openai.promptManager?.error ?? '') || null,
            toast: (document.querySelector('#toast-container')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
        };
    }, { send: spec.send, maxContext });
    if (clicked.error) {
        return { maxContext, failure: clicked.error, messageCount: 0, historyMessages: 0, oldestIndex: -1 };
    }
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && peer.state.posts.length <= mark.posts) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    const during = {
        requests: pageLog.requests.slice(mark.requests),
        responses: pageLog.responses.slice(mark.responses),
        console: pageLog.console.slice(mark.console),
        errors: pageLog.errors.slice(mark.errors),
        peerPosts: peer.state.posts.length - mark.posts,
    };
    const diagnosis = {
        chatBefore: before.chatLength,
        chatAfterClick: clicked.chatLengthAfter,
        chatGrew: clicked.chatLengthAfter > before.chatLength,
        composerValueAfter: clicked.composerValueAfter,
        sendButtonDisabledBefore: clicked.disabledBefore,
        generatingBefore: before.generating,
        generatingAttrBefore: before.generatingAttr,
        generatingAfter: clicked.generatingAfter,
        generatingAttrAfter: clicked.generatingAttrAfter,
        onlineStatus: before.onlineStatus,
        contextApplied: clicked.contextApplied,
        promptManagerError: clicked.promptManagerError,
        toast: clicked.toast,
        generateResponses: during.responses,
        generateRequestCount: during.requests.filter(entry => entry.path.includes('/chat-completions/generate')).length,
        pageRequests: during.requests,
        pageConsole: during.console,
        pageErrors: during.errors,
        peerPosts: during.peerPosts,
    };
    if (during.peerPosts === 0) {
        // NAME THE CAUSE, not just the absence. The three cases need different fixes and the log must say
        // which one happened.
        const reason = diagnosis.generateRequestCount === 0
            ? (diagnosis.chatGrew
                ? 'a send STARTED (the chat grew) but the page issued NO /chat-completions/generate request'
                : 'the click did NOT start a send (the chat did not grow)')
            : `the page issued ${diagnosis.generateRequestCount} generate request(s) but the server produced no provider request (see generateResponses for the status/body)`;
        return {
            maxContext,
            failure: `no provider request reached the peer within 30s at max_context=${maxContext}: ${reason}. diagnosis=${JSON.stringify(diagnosis)}`,
            diagnosis,
            messageCount: 0,
            historyMessages: 0,
            oldestIndex: -1,
        };
    }
    return {
        maxContext,
        failure: null,
        settled: true,
        diagnosis,
        ...metricsOfBody(peer.state.posts[peer.state.posts.length - 1], spec.history[0].text.slice(0, 40), spec.markers.history),
    };
}

// ---------------------------------------------------------------------------------------------
// PAGE INSTRUMENTATION. A probe that reports "no request arrived" cannot say WHICH of three things
// happened: the click never started a generation (a frontend guard), a generation started but the page
// never issued its generate request (or the server answered it non-2xx), or a page error killed the
// handler. Run 40077240xxx's first probe reported exactly that and nothing more, so every probe now
// records the page's own console, its page errors, the requests IT issued (method + path only, never an
// origin: a committed artefact must not carry a host) and the frontend's own state before and after the
// click.
// ---------------------------------------------------------------------------------------------
const pageLog = { console: [], errors: [], requests: [], responses: [] };
function installInstrumentation(target) {
    target.on('console', message => {
        pageLog.console.push({ type: message.type(), text: String(message.text()).slice(0, 240) });
    });
    target.on('pageerror', error => {
        const text = String(error?.message ?? error).slice(0, 240);
        pageLog.errors.push(text);
        consoleErrors.push(text);
    });
    const note = (request, extra = {}) => {
        try {
            const url = new URL(request.url());
            pageLog.requests.push({ method: request.method(), path: url.pathname + url.search, ...extra });
        } catch {
            pageLog.requests.push({ method: request.method(), path: 'non-url', ...extra });
        }
    };
    target.on('request', request => note(request));
    target.on('requestfailed', request => note(request, { failed: String(request.failure()?.errorText ?? 'failed').slice(0, 120) }));
    target.on('response', response => {
        try {
            const url = new URL(response.url());
            if (!url.pathname.endsWith('/chat-completions/generate')) return;
            const entry = { status: response.status(), path: url.pathname };
            pageLog.responses.push(entry);
            // A non-2xx body names which branch refused; read it after recording the status so a body
            // that is slow to arrive cannot hide the status.
            if (!response.ok()) {
                response.text().then(body => { entry.bodyHead = String(body).slice(0, 200); }, () => {});
            }
        } catch {
            // a non-URL response cannot be attributed; nothing to record
        }
    });
}
installInstrumentation(page);

// bootScenario gives every probe a FRESH PAGE with the scenario applied, which removes the whole class
// of "dirty state after N sends" failures: the chat, the author's note, the world info, the samplers and
// custom_url are re-established by the same code on every probe. `includeTypedTurn` is true only for the
// dry pre-scan, which must assemble the same list a send produces (a send appends the typed turn itself).
async function bootScenario({ includeTypedTurn }) {
    await page.goto(`${baseURL}/`);
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 120000 });
    const applied = await page.evaluate(applyPresetKit, spec);
    const state = await page.evaluate(async ({ send, customModel, peerOrigin, includeTypedTurn }) => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        const mainApiControl = document.querySelector('#main_api');
        if (mainApiControl) {
            mainApiControl.value = 'openai';
            mainApiControl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        openai.oai_settings.chat_completion_source = 'custom';
        openai.oai_settings.custom_model = customModel;
        // custom_url IS RE-APPLIED ON EVERY BOOT, because a fresh page reloads the persisted settings.
        openai.oai_settings.custom_url = peerOrigin;
        openai.oai_settings.stream_openai = false;
        if ('bypass_status_check' in openai.oai_settings) {
            openai.oai_settings.bypass_status_check = true;
        }
        await new Promise(resolve => setTimeout(resolve, 600));
        if (includeTypedTurn) {
            script.chat.push({
                name: 'Probe User',
                is_user: true,
                is_system: false,
                send_date: '2026-01-01T00:00:00.000Z',
                mes: send,
                extra: {},
            });
        }
        return {
            chatTurns: script.chat.length,
            mainApi: String(script.main_api ?? ''),
            hasMainApiControl: Boolean(mainApiControl),
            source: String(openai.oai_settings.chat_completion_source ?? ''),
            customUrl: String(openai.oai_settings.custom_url ?? ''),
            customModel: String(openai.oai_settings.custom_model ?? ''),
            onlineStatus: String(script.online_status ?? ''),
        };
    }, { send: spec.send, customModel: 'probe-model', peerOrigin: peer.origin, includeTypedTurn });
    // CONNECT, THE WAY THE DRIVE DOES. A chat-completion send is silently ignored while
    // `online_status` is 'no_connection', and that status is only set by the frontend's own connection
    // check. `bypass_status_check` is set as well, but run 40077240xxx's first probe reported neither a
    // started send nor a request, and "missing status" is one of the three causes this capture must be
    // able to tell apart -- so it performs the handshake and records the outcome either way.
    const connection = await page.evaluate(async () => {
        const script = await import('./script.js');
        const keyField = document.querySelector('#api_key_custom');
        if (keyField && !keyField.value) {
            keyField.value = 'probe-synthetic-key';
            keyField.dispatchEvent(new Event('input', { bubbles: true }));
            keyField.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const button = document.querySelector('#api_button_openai');
        const connectButtonPresent = Boolean(button);
        if (button) {
            button.click();
        }
        const deadline = performance.now() + 8000;
        let onlineStatus = String(script.online_status ?? '');
        while (performance.now() < deadline && onlineStatus === 'no_connection') {
            await new Promise(resolve => setTimeout(resolve, 250));
            onlineStatus = String(script.online_status ?? '');
        }
        return { connectButtonPresent, keyFieldPresent: Boolean(keyField), onlineStatus };
    });
    state.connection = connection;
    return { applied, state };
}

let exitCode = 1;
try {
    // 1. THE SCENARIO'S FIRST BOOT. Its `applied` report is the one the fixture records; later boots are
    //    per-probe resets and only their failures matter.
    const firstBoot = await bootScenario({ includeTypedTurn: true });
    const applied = firstBoot.applied;
    const preconditions = firstBoot.state;
    const problems = [...(applied.problems ?? [])];

    // 1b. THE DRIVE'S OWN PRE-CONDITIONS. A send appends one user turn before assembly, so the capture
    //     assembles a chat of the same shape or the boundary it measures is not the boundary the drive
    //     reaches. `main_api` is driven through the control a user drives (`#main_api`, assigned by its
    //     change handler), because it is an exported `let` that cannot be assigned from outside.
    const chatTurnsAtBoundary = preconditions.chatTurns;
    if (preconditions.mainApi !== 'openai') {
        problems.push(`main_api is ${JSON.stringify(preconditions.mainApi)} after driving #main_api (control present: ${preconditions.hasMainApiControl}); the dry assembly would not take the chat-completion path`);
    }
    if (chatTurnsAtBoundary !== applied.chatTurns + 1) {
        problems.push(`the capture's chat has ${chatTurnsAtBoundary} turns after the typed message, expected ${applied.chatTurns + 1}`);
    }


    // 2. The tokenizer anchor. Read BEFORE the boundary search, because a guesstimating server would
    //    place the boundary somewhere meaningless and the fixture must say so.
    //
    //    THE POST NEEDS THE CSRF TOKEN. Run 40073802369 answered 403 here: the pinned server rejects a
    //    same-origin POST that carries no `X-CSRF-Token`, and a plain `fetch(...)` from the page does not
    //    add one. The frontend's own `getRequestHeaders()` is what every panel request uses (it carries
    //    the token it fetched at load, and the browser adds the session cookie), so the anchor asks the
    //    server the same way the UI does. The failure stays LOUD: an anchor of 7 obtained through any
    //    fallback would be the vacuous evidence doctrine 4 forbids.
    const anchor = await page.evaluate(async anchorBody => {
        const script = await import('./script.js');
        const headers = script.getRequestHeaders();
        const response = await fetch('/api/tokenizers/openai/count?model=llama', {
            method: 'POST',
            headers,
            body: JSON.stringify(anchorBody),
        });
        const csrfHeaderPresent = Object.keys(headers).some(name => name.toLowerCase() === 'x-csrf-token');
        if (!response.ok) {
            return { status: response.status, count: null, csrfHeaderPresent, error: 'the count route did not answer 200' };
        }
        const payload = await response.json();
        return { status: response.status, count: Number(payload?.token_count), csrfHeaderPresent };
    }, TOKENIZER_ANCHOR.body);
    if (anchor.count !== TOKENIZER_ANCHOR.pinnedCount) {
        problems.push(`the tokenizer anchor answered ${JSON.stringify(anchor)}; a server that does not tokenize exactly cannot host a context-boundary measurement`);
    }

    // 3. FIND THE BOUNDARY, AND PROVE IT IS A HISTORY BOUNDARY -- ON THE SEND'S OWN ASSEMBLY.
    //
    //    The trimmer keeps history newest-first and stops at the first message that does not fit
    //    (public/scripts/openai.js:951-1078), so "the OLDEST history turn is present" is monotone in
    //    `openai_max_context` *within the region where only history is being trimmed*. It is not monotone
    //    everywhere (at a tight budget the frontend also drops its own example/world-info messages), and
    //    the TOTAL message count is therefore recorded but never asserted.
    //
    //    WHY THE DRY ASSEMBLY IS ONLY A PRE-SCAN. Run 40082539457 drove both variants at the pair a dry
    //    bisect had found (4236 kept / 4235 dropped) and BOTH produced the drop shape on BOTH servers --
    //    26 total, 11 history, oldest absent -- because the pair was one token apart and the real send's
    //    assembly costs slightly more than the dry one. A boundary taken from a different assembly cannot
    //    bind, so the pair is now taken from REAL SENDS against the peer. The dry bisect survives only to
    //    bracket the region so the send bisect needs ~10 probes instead of ~15.
    const dryLog = [];
    const dryProbes = new Map();
    const dryAt = async context => {
        const key = Number(context);
        if (!dryProbes.has(key)) {
            dryProbes.set(key, await assembleAt(key));
        }
        const result = dryProbes.get(key);
        dryLog.push({
            maxContext: result.maxContext,
            messageCount: result.messageCount,
            historyMessages: result.historyMessages,
            oldestPresent: result.oldestIndex >= 0,
            promptManagerError: result.promptManagerError,
            failure: result.failure,
        });
        return result;
    };
    const low = Math.max(spec.maxTokens + 40, 120);
    const high = Math.max(low + 1, 8192);
    let dryLow = null;
    const atHigh = await dryAt(high);
    if (atHigh.failure) {
        problems.push(`the dry pre-scan failed at max_context=${high}: ${atHigh.failure}`);
    }
    if (atHigh.assemblyCount === 0) {
        problems.push('the dry pre-scan emitted no GENERATE_AFTER_DATA, so nothing was measured');
    }
    if (atHigh.oldestIndex < 0) {
        problems.push(`the oldest history turn is not present even at max_context=${high} (${atHigh.messageCount} messages, ${atHigh.historyMessages} history): the constant prompt block plus the history exceeds any context this scenario can ask for`);
    } else {
        let lo = low;
        let hi = high;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            const result = await dryAt(mid);
            if (result.oldestIndex >= 0) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        dryLow = lo;
    }

    // THE SEND BISECT. The send assembly costs at least as much as the dry one, so the send's flip is at
    // or above the dry flip; the bracket is [dryLow, dryLow + 512], which is far wider than any plausible
    // difference and still only ~9 probes.
    const searchLog = [];
    let keepContext = null;
    let keep = null;
    let drop = null;
    if (dryLow !== null) {
        const sendAt2 = async context => {
            const result = await sendAt(context, peer);
            searchLog.push({
                maxContext: result.maxContext,
                messageCount: result.messageCount,
                historyMessages: result.historyMessages,
                oldestIndex: result.oldestIndex,
                oldestPresent: result.oldestIndex >= 0,
                settled: result.settled ?? null,
                failure: result.failure ?? null,
            });
            return result;
        };
        const sendProbes = new Map();
        const sendProbe = async context => {
            const key = Number(context);
            if (!sendProbes.has(key)) {
                sendProbes.set(key, await sendAt2(key));
            }
            return sendProbes.get(key);
        };
        const bracketTop = Math.min(dryLow + 512, high);
        const topProbe = await sendProbe(bracketTop);
        if (topProbe.failure) {
            problems.push(`a probe send failed at max_context=${bracketTop}: ${topProbe.failure}`);
        }
        if (topProbe.oldestIndex < 0) {
            problems.push(`the oldest history turn is absent from the SENT request even at max_context=${bracketTop} (${topProbe.messageCount} messages, ${topProbe.historyMessages} history): the dry pre-scan said it was present at ${dryLow}, so the send costs more than the pre-scan bracket allows; widen the bracket or shorten the history`);
        } else {
            let lo = dryLow;
            let hi = bracketTop;
            while (lo < hi) {
                const mid = Math.floor((lo + hi) / 2);
                const result = await sendProbe(mid);
                if (result.oldestIndex >= 0) {
                    hi = mid;
                } else {
                    lo = mid + 1;
                }
            }
            // Accept the pair only on the HISTORY contract; a candidate in a churn band is named and the
            // next context is tried. The TOTAL count is recorded and not asserted: at the pair the previous
            // capture recorded, 26 total messages held 11 history turns below the boundary and 24 total
            // held 12 above it, because the frontend emits its own example/world-info messages as the
            // budget allows, independently of the trimmer.
            //
            // A FAILED PROBE IS NOT A DROP. A send that never reached the peer, or a page that never
            // settled, yields no messages and would read as "the oldest turn is absent" -- so a failure at
            // either side of a candidate disqualifies that candidate by name instead of being accepted as
            // the boundary.
            let failedProbes = 0;
            for (let candidate = lo; candidate <= lo + 4; candidate++) {
                if (candidate <= low) continue;
                const keepProbe = await sendProbe(candidate);
                const dropProbe = await sendProbe(candidate - 1);
                if (keepProbe.failure || dropProbe.failure) {
                    failedProbes += 1;
                    problems.push(`candidate keep=${candidate}: a probe send failed (${keepProbe.failure ?? dropProbe.failure}); a failed probe is not a drop`);
                    continue;
                }
                if (keepProbe.oldestIndex < 0 || dropProbe.oldestIndex >= 0) continue;
                const historyDelta = keepProbe.historyMessages - dropProbe.historyMessages;
                if (historyDelta !== 1) {
                    problems.push(`candidate keep=${candidate}: the sent request flips the oldest turn, but the history-message delta against ${candidate - 1} is ${historyDelta} (keep ${keepProbe.historyMessages}, drop ${dropProbe.historyMessages}); that is not a history trim`);
                    continue;
                }
                keepContext = candidate;
                keep = keepProbe;
                drop = dropProbe;
                break;
            }
            if (keepContext === null) {
                problems.push('no context separates "the oldest turn is kept" from "it is dropped" by exactly one history message in the SENT request, so the pair would not be a measured boundary. Send table (maxContext/total/history/oldestPresent): '
                    + searchLog.map(entry => `${entry.maxContext}/${entry.messageCount}/${entry.historyMessages}/${entry.oldestPresent}`).join('; '));
            }
            // EVERY PROBE IN THE BISECT MUST HAVE SETTLED, or the bracket itself was measured on sends that
            // did not happen.
            const unsettled = [...sendProbes.values()].filter(probe => probe.failure);
            if (unsettled.length > 0) {
                problems.push(`${unsettled.length} probe send(s) in the bracket did not complete: ${unsettled.map(probe => `${probe.maxContext}:${probe.failure}`).join('; ')}`);
            }
            if (failedProbes > 0) {
                problems.push(`${failedProbes} candidate pair(s) were rejected because a probe send failed, not because the boundary was wrong`);
            }
        }
    }

    if (problems.length > 0) {
        console.error('capture-preset FAILED:');
        for (const problem of problems) {
            console.error(`  - ${problem}`);
        }
        console.error(JSON.stringify({ steps: applied.steps, searchLog: searchLog.map(entry => ({ ...entry, firstMessageText: undefined })) }, null, 2));
        process.exitCode = 1;
    } else {
        const fixture = {
            schemaVersion: 1,
            provenance: {
                capturedAt: process.env.CAPTURE_TIMESTAMP ?? new Date().toISOString(),
                server: baseURL.replace(/:\d+$/, ':<port>'),
                pinnedBaseline: 'SillyTavern 1.19.0, commit 06bde939fb1e9c4c8d8641d810f0a916b5bce127',
                uiPath: [
                    '1. getCharacters() + selectCharacterById(0) -- prompt assembly reads characters[this_chid]',
                    '2. character description/personality/scenario/examples set on the bound card and read back',
                    '3. script.chat replaced with the scenario history (greeting + 12 turns) and length asserted',
                    '4. world info built in a local data object through world-info.js createWorldInfoEntry + saveWorldInfo (immediate) and READ BACK with loadWorldInfo (createNewWorldInfo does not populate world_info[name], measured in run 40073802369): one entry at position "after", one at "atDepth" depth 0, then activated',
                    "5. author's note written into chat_metadata (including note_interval=1), typed into #extension_floating_prompt, and pushed through authors-note.js setFloatingPrompt() -- which reads the VALUE FROM THE DOM, not from the metadata; asserted in extension_prompts['2_floating_prompt']",
                    '6. stop strings set on power_user.custom_stopping_strings and read back through getCustomStoppingStrings(4)',
                    '7. samplers, max_tokens and names_behavior set on oai_settings (no prompt-manager dependency)',
                    '8. main/nsfw/jailbreak prompt content set through promptManager.getPromptById(identifier) and read back; order entries asserted enabled',
                    '9. instruct/context template names set to a non-default preset and recorded',
                    '10. DRY PRE-SCAN through script.Generate("normal", {}, true) to bracket the region (cheap, and NOT the recorded measurement)',
                    '11. REAL SENDS through #send_textarea + #send_but against a recording peer, one per candidate openai_max_context, bisecting inside the pre-scan bracket for the smallest context whose SENT request still carries the oldest history turn; the pair is accepted only if that turn is absent one token lower and exactly ONE history message differs',
                    '12. POST /api/tokenizers/openai/count?model=llama with the oracle anchor body through the frontend\'s own getRequestHeaders() (the CSRF header a plain fetch lacks, run 40073802369), expected 7',
                ],
                instrumentation: 'every probe runs on a FRESH PAGE (bootScenario re-applies the kit, custom_url, samplers and the connect handshake), and records the page console, page errors, the requests the page issued (method + path only) and the frontend state before/after the click, so a "no request arrived" failure names WHICH cause it was: no send started, a send with no generate request, or a generate request the server answered non-2xx',
                steps: applied.steps,
                boundaryMethod: 'bisect over openai_max_context by DRIVING THE REAL SEND against a recording peer and reading the provider request it produced; verified: oldest turn present at keep, absent at keep-1, history-message delta exactly 1. The dry assembly is a pre-scan only, because run 40082539457 showed a dry-measured pair (4236/4235, one token apart) does not bind: the send assembles slightly more, so both variants produced the drop shape. The TOTAL message count is recorded and never asserted, because the frontend also emits/drops its own example and world-info messages with the budget',
                assemblyMode: 'real-send',
                note: 'Captured from the pinned frontend with per-step assertions, not hand-assembled. Re-run capture-preset.mjs against the pinned baseline to refresh; the fixture must be byte-identical when nothing upstream changed.',
                consoleErrors,
            },
            capture: {
                spec,
                oaiSettings: applied.oaiSettings,
                powerUser: applied.powerUser,
                prompts: applied.prompts,
                chatTurns: applied.chatTurns,
                // The chat the bisect actually assembled: greeting + history + the message the drive will
                // type. Recorded because it is the list the boundary belongs to.
                chatTurnsAtBoundary,
                drivePreconditions: {
                    mainApi: preconditions.mainApi,
                    mainApiControlPresent: preconditions.hasMainApiControl,
                    source: preconditions.source,
                    customModel: preconditions.customModel,
                },
                tokenizerAnchor: { ...TOKENIZER_ANCHOR, observed: anchor },
                boundary: {
                    oldestMarker: spec.history[0].text.slice(0, 40),
                    // WHICH ASSEMBLY THE PAIR BELONGS TO. The comparator refuses a pair whose value is not
                    // 'real-send', because a dry-measured pair does not bind (run 40082539457).
                    assemblyMode: 'real-send',
                    keepContext,
                    dropContext: keepContext === null ? null : keepContext - 1,
                    keepMessages: keep?.messageCount ?? null,
                    dropMessages: drop?.messageCount ?? null,
                    // THE COUNTS THE BOUNDARY IS ABOUT. `historyMessages` is how many history turns
                    // survived; the pair must differ by exactly one. The oldest turn's INDEX is recorded as
                    // context only -- it is not asserted, because the frontend's own message layout around
                    // the history block is not the property under test.
                    keepHistoryMessages: keep?.historyMessages ?? null,
                    dropHistoryMessages: drop?.historyMessages ?? null,
                    keepOldestIndex: keep?.oldestIndex ?? null,
                    dropOldestIndex: drop?.oldestIndex ?? null,
                    // THE BOUNDARY'S CONTRACT, written into the artefact so a reader who later sees the
                    // two TOTALS differ (e.g. 24 at keep and 26 at drop) finds the reason beside the
                    // numbers rather than concluding the pair is broken.
                    contract: {
                        asserted: [
                            'the oldest history turn is present at keepContext and absent at dropContext',
                            'the number of HISTORY turns differs by exactly one across the pair',
                            'the comparator recomputes both from the provider BODY on each leg, never from a probe claim',
                            'the pinned tokenizer anchor (count 7) is answered by both servers and the tokenizer tree resolved',
                        ],
                        historyTurns: { keep: keep?.historyMessages ?? null, drop: drop?.historyMessages ?? null },
                        totalMessages: { keep: keep?.messageCount ?? null, drop: drop?.messageCount ?? null },
                        measuredOn: 'the provider request produced by a REAL SEND (#send_but) at each context, not a dry assembly',
                        totalMessagesNotAsserted: 'the TOTAL message count is recorded per probe and is NOT part of the contract. The frontend emits its own example and world-info messages as the budget allows, independently of the trimmer, so the total is not monotone in openai_max_context: the run that produced this fixture measured '
                            + `${drop?.messageCount ?? '?'} total messages holding ${drop?.historyMessages ?? '?'} history turns at max_context ${keepContext === null ? '?' : keepContext - 1}, and `
                            + `${keep?.messageCount ?? '?'} total messages holding ${keep?.historyMessages ?? '?'} history turns at ${keepContext ?? '?'}. Requiring the total to grow rejects exactly the boundaries whose history contract holds (it rejected this pair in the previous capture), which is why it is recorded and not asserted`,
                    },
                    dryPreScanFlip: dryLow,
                    dryPreScan: dryLog.map(entry => ({
                        maxContext: entry.maxContext,
                        messageCount: entry.messageCount,
                        historyMessages: entry.historyMessages,
                        oldestPresent: entry.oldestPresent,
                        promptManagerError: entry.promptManagerError,
                        failure: entry.failure,
                    })),
                    sendLog: searchLog.map(entry => ({
                        maxContext: entry.maxContext,
                        messageCount: entry.messageCount,
                        historyMessages: entry.historyMessages,
                        oldestIndex: entry.oldestIndex,
                        oldestPresent: entry.oldestPresent,
                        promptManagerError: entry.promptManagerError,
                        failure: entry.failure,
                    })),
                },
            },
        };
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, JSON.stringify(fixture, null, 2) + '\n');
        console.log(JSON.stringify({
            out: outPath,
            keepContext,
            dropContext: keepContext === null ? null : keepContext - 1,
            keepMessages: fixture.capture.boundary.keepMessages,
            dropMessages: fixture.capture.boundary.dropMessages,
            tokenizerCount: anchor.count,
            assemblyMode: 'real-send',
            dryPreScanFlip: dryLow,
            keepHistoryMessages: keep?.historyMessages ?? null,
            dropHistoryMessages: drop?.historyMessages ?? null,
            probeSends: searchLog.length,
            steps: applied.steps.length,
            errors: consoleErrors.length,
        }));
        exitCode = 0;
    }
} catch (error) {
    console.error(`capture-preset threw: ${String(error?.stack ?? error)}`);
    console.error(JSON.stringify({ consoleErrors }));
} finally {
    await browser.close();
    await new Promise(resolve => peer.server.close(resolve));
}
process.exit(exitCode);
