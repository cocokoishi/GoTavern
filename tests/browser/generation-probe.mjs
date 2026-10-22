// Generation probe: does a send driven from the PINNED frontend produce a provider request?
//
// WHAT IT MEASURES. It boots GoTavern (or is pointed at any other server with PROBE_BASE_URL), drives
// one send the way the frontend itself does -- load and select a character through the frontend's own
// functions, wait for the state a user can send from, then click #send_but -- and polls the recording
// mock provider for an arriving request. It also records EVERY page request unfiltered, so a negative
// finding ("this call never happened") comes from a log that would have shown it.
//
// WHAT ITS LAST RUN SHOWED (2026-10-20, GoTavern from a fresh data root): the character binds, the chat
// opens, the send button is enabled, the frontend assembles a prompt (three POST /api/tokenizers/llama/
// encode -> 200), every /api call answers 2xx/204, and NO backend call is made, so no provider request
// arrives. Page errors: none. Requests recorded: 241.
//
// WHAT IT DOES NOT CONCLUDE. "No provider request" with no failing request and no page error is a
// probe-faithfulness question (AGENTS.md verification rule 10), not a product finding: the drive's
// oai_settings are a partial configuration compared with what a user's custom-source setup contains.
// The next step is a differential against pinned Node with PROBE_BASE_URL and, if needed, a recorded
// user settings snapshot -- not more fields added until something happens.
//
// PROVENANCE IS PART OF THE OUTPUT. The report records which server was driven, whether the page
// loaded, how many requests were recorded, and the diagnostics at the point of the send; a bit quoted
// without them is not evidence.
// Generation probe (increment 0b), deliberately minimal.
//
// ONE question: does a send driven from the pinned frontend produce a provider request at all?
// It drives one generation against the recording mock provider, then reports whether a request
// arrived and what shape it had. It does NOT assert a boundary, a count, or a prompt shape —
// those come later and only if this answers yes.
//
// Why this is separate from the pinned suite: no spec in that suite drives a generation turn, so
// generation is untested rather than proven working. This probe exists to make that assumption
// measured instead of assumed, and to keep the answer unambiguous if it is no.
//
// Usage: node generation-probe.mjs [--report <path>]

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
// CJS interop: the browser type may be exposed on the namespace or only under default.
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

async function waitFor(url, label, deadlineMs = 30000) {
    const started = Date.now();
    let lastError = '';
    while (Date.now() - started < deadlineMs) {
        try {
            const response = await fetch(url);
            if (response.status < 500) {
                return response;
            }
            lastError = `status ${response.status}`;
        } catch (error) {
            lastError = String(error.message ?? error);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`${label} did not answer at ${url}: ${lastError}`);
}

// The mock's response script: one non-streaming chat completion, enough for the frontend to
// finish a turn.
// WHICH SOURCE THIS DRIVE SELECTS, decided ONCE and used by the mock script, the peer and the page. The
// captured fixture is a custom-source setup, so the source is assigned after it in the page; here it decides
// the provider protocol as well, so a claude drive is served an ANTHROPIC response and every other source an
// OpenAI one. A leg that silently fell back to the OpenAI script would show as a DIFFERENT final text rather
// than as an equal empty one.
const probeSource = process.env.PROBE_SOURCE ?? 'custom';
if (!['custom', 'openrouter', 'claude', 'mistralai'].includes(probeSource)) {
    throw new Error(`PROBE_SOURCE must be custom, openrouter, claude or mistralai, got ${probeSource}`);
}
const peerProtocol = probeSource === 'claude' ? 'anthropic' : 'openai';
const mockScript = {
    // The Connect step asks the chat-completions status route for GET {custom_url}/models, which the
    // server proxies to this peer. The scripted responses are SEQUENTIAL, so the models answer must
    // come first: with a single completion answer the models request consumed it and the completion
    // request got the mock's default 500 on BOTH legs (a probe-shape defect, not a product gap).
    responses: [
        // CLAUDE IS A NO-VALIDATE SOURCE (openai.js:4459): it never calls /models, so a models entry at index 0
        // is consumed by NOTHING and the completion request receives the MODELS body -- which has no `content`
        // member, so the claude rewrap yields content[0].text === '' and the page renders an empty message with
        // status 200 and no error. Measured exactly that before this fix. The script is therefore built from the
        // SOURCE'S OWN CALL SEQUENCE rather than assuming two calls.
        ...(peerProtocol === 'anthropic' ? [] : [{
            status: 200,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            body: JSON.stringify({ data: [{ id: 'probe-model' }] }),
        }]),

        {
            status: 200,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            body: JSON.stringify({
                // SHAPED BY THE SAME PROTOCOL PARAMETER as the streaming peer. The claude branch rewraps
                // `content[0].text` into `choices[0].message.content` (internal/server/claude_chat.go:900-920), so
                // the text must be non-empty AND distinct from the OpenAI text: an empty or identical final text
                // would let a leg that fell back to the wrong script compare equal.
                ...(peerProtocol === 'anthropic'
                    ? {
                        id: 'msg_probe', type: 'message', role: 'assistant', model: 'probe-model',
                        content: [{ type: 'text', text: 'probe reply from anthropic' }],
                        stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 },
                    }
                    : {
                        id: 'probe-completion',
                        choices: [{ index: 0, message: { role: 'assistant', content: 'probe reply' }, finish_reason: 'stop' }],
                    }),
            }),
        },
    ],
};

const port = await freePort();
const dataRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-probe-'));
const scriptPath = path.join(dataRoot, 'mock-script.json');
await fs.writeFile(scriptPath, JSON.stringify(mockScript));

// PROBE_BASE_URL means the drive is aimed at ANOTHER server (the pinned differential), so there is
// nothing to build and nothing to boot: building anyway costs a build and, when the disk was full,
// failed the differential with an error that had nothing to do with what it was measuring.
const external = Boolean(process.env.PROBE_BASE_URL);
const binarySetting = process.env.GOTAVERN_BINARY ?? '';
const binary = binarySetting ? path.resolve(binarySetting) : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
const buildSteps = [];
if (!binarySetting && !external) {
    buildSteps.push(['go', ['build', '-trimpath', '-o', binary, './cmd/gotavern']]);
}
// The recording peer is a Go binary too, and this host cannot compile Go (a full cache once filled a
// 149 GB disk). A lane downloads the binary its own CI run built from the commit under test, exactly as
// tools/probe-provider-wire.mjs does; an unset variable keeps the build the CI oracle job relies on.
const mockProviderSetting = process.env.GOTAVERN_MOCK_PROVIDER_BINARY ?? '';
const mockProviderBinary = mockProviderSetting ? path.resolve(mockProviderSetting) : path.join(dataRoot, process.platform === 'win32' ? 'mock-provider.exe' : 'mock-provider');
if (!mockProviderSetting) {
    buildSteps.push(['go', ['build', '-trimpath', '-o', mockProviderBinary, './tools/mock-provider']]);
}
for (const [command, args] of buildSteps) {
    const build = spawn(command, args, { cwd: repoRoot, stdio: 'inherit' });
    const code = await new Promise(resolve => build.on('exit', resolve));
    if (code !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed`);
    }
}

// RELEASE LAYOUT: `gotavern start` resolves InstallRoot as the directory of the executable
// (cmd/gotavern/main.go), and tokenizer routes look for <InstallRoot>/tokenizers. This probe builds
// the binary into a scratch directory, so without this the server silently takes the pinned
// fallback path (guesstimate counts, empty ids) and the two legs cannot be compared on token counts
// at all. A release puts `tokenizers/` beside the binary; stage the same layout instead of changing
// production code to make a probe work.
if (!external) {
    const tokenizerSource = path.join(repoRoot, 'upstream', 'tokenizers');
    // BESIDE THE BINARY THAT ACTUALLY RUNS, which is not always the one this probe builds. When
    // GOTAVERN_BINARY supplies a lane artifact, `dataRoot` is NOT its install root, so staging there left
    // the server with no `tokenizers/` and every count route answered the GUESSTIMATE fallback
    // (ceil(bytes/3.35)) instead of tokenizing: `[{content:'probe user marker'}]` came back as 10 and the
    // role-ful body as 15, which are exactly those byte-lengths divided by 3.35, while pinned answered
    // 9 and 10. That is the failure this comment block already describes, one level down: the probe
    // staged the release layout faithfully for a binary it had just built and not for one it was handed.
    const tokenizerTarget = path.join(path.dirname(binary), 'tokenizers');
    if (await fs.stat(tokenizerSource).then(() => true, () => false)) {
        await fs.cp(tokenizerSource, tokenizerTarget, { recursive: true });
    } else {
        throw new Error(`tokenizer assets missing at ${tokenizerSource}; a release layout must stage them beside the binary`);
    }
}
// STREAMING / CANCELLATION MODE.
//
// The Go mock provider writes its scripted frames in one burst and closes immediately, which cannot
// model "cancel while the stream is still open". For PROBE_MODE=stream|cancel this probe starts an
// in-process Node peer instead: it paces SSE frames (so incremental rendering is genuinely
// observed), and in cancel mode it keeps the response open until the caller goes away, recording
// whether the connection was closed before the stream finished. The peer is the only custom_url the
// browser is given, so it is unbypassable for this drive (rule 14).
const probeMode = process.env.PROBE_MODE ?? 'nonstream';
// WHICH CHAT-COMPLETION SOURCE THIS DRIVE SELECTS. The custom source was the first one measured end to
// end; openrouter is the second, and it reaches the peer differently: the custom source carries the peer
// in `custom_url` (a request member), while openrouter's URL is a pinned LITERAL with no request member at
// all, so the GoTavern leg is aimed through its seam and the pinned leg through a transport redirect that
// tools/run-against-pinned.mjs installs.
// (source and protocol are derived above, before the mock script, so one place decides both)

const streamingMode = probeMode === 'stream' || probeMode === 'cancel';

function startStreamingPeer(mode, protocol) {
    // EVERY request the peer answered, with the status it gave: without this a drive that never
    // reaches a connected status cannot be told apart from one whose status call the peer answered, and
    // that indistinguishability has produced phantom defects on this project twice.
    const state = { requests: [], heldClosed: false, paths: [] };
    const server = http.createServer((request, response) => {
        const pathEntry = { method: request.method, path: request.url, status: null };
        state.paths.push(pathEntry);
        if (request.method === 'GET' && request.url.startsWith('/models')) {
            pathEntry.status = 200;
            // A MODEL LIST THE OPENROUTER UI CAN CONSUME. The custom source ignores this body, so it only
            // ever needed a bare id; the openrouter source populates a real model list from it and will not
            // reach a connected status if the entries lack the fields its renderer reads. Measured: with
            // `{data:[{id:'probe-model'}]}` the drive failed with "the frontend never reached a connected
            // online_status" while the SAME peer drove custom successfully. `architecture` is deliberately
            // absent so the drive keeps the frontend's turbo fallback tokenizer, which is what the
            // non-streaming OpenRouter artifact was recorded with.
            response.writeHead(200, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({
                data: [{
                    id: 'probe-model',
                    name: 'probe-model',
                    context_length: 4096,
                    pricing: { prompt: '0.000001', completion: '0.000002' },
                    top_provider: { context_length: 4096 },
                }],
            }));
            return;
        }
        // CONTAINS, NOT STARTS-WITH. A source aimed through `reverse_proxy` reaches the peer as
        // `//chat/completions` -- the pinned literal's trailing slash plus the appended path, the same quirk
        // already documented for the openai reverse proxy -- and a startsWith check answers 404 to a request
        // that is exactly right. Measured: `GET /models -> 200` then `POST //chat/completions -> 404`.
        const completionPath = protocol === 'anthropic' ? '/messages' : '/chat/completions';

        // `includes`, NOT `startsWith`: a reverse_proxy caller (how claude and mistralai reach the peer)
        // builds its target from a scheme-less base, so the request line arrives as `//chat/completions`
        // and a prefix test 404s a completely correct request -- which then looks like a product defect
        // on both legs and a missing surface in the artifact.
        if (request.method !== 'POST' || !request.url.includes(completionPath)) {
            pathEntry.status = 404;
            response.writeHead(404, { 'Content-Type': 'text/plain' });
            response.end('not found');
            return;
        }
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            const entry = {
                method: request.method,
                path: request.url,
                bodyLength: body.length,
                bodySha256: createHash('sha256').update(body).digest('hex'),
                body: body.toString('utf8'),
                clientDisconnected: false,
                framesWritten: 0,
            };
            state.requests.push(entry);
            pathEntry.status = 200;
            response.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                Connection: 'keep-alive',
            });
            const wordCount = Number(process.env.PROBE_FRAME_COUNT ?? (mode === 'cancel' ? 12 : 5));
            const words = ['Hello', ' from', ' the', ' stream', '?', ' incremental', ' rendering', ' is', ' genuinely', ' observed', ' and', ' paced', ' by', ' the', ' peer', '.'];// placeholder
            const frames = [];
            for (let wordIndex = 0; wordIndex < wordCount; wordIndex += 1) {
                frames.push(words[wordIndex % words.length] + (wordIndex >= words.length ? '#' + wordIndex : ''));
            }
            const frameDelay = Number(process.env.PROBE_FRAME_MS ?? (mode === 'cancel' ? 120 : 40));
            let finished = false;
            response.on('close', () => {
                if (!finished) {
                    entry.clientDisconnected = true;
                }
                state.heldClosed = true;
            });
            const writeFrame = (content, isLast) => {
                if (protocol === 'anthropic') {
                    const anthropicPayload = isLast
                        ? { type: 'content_block_stop', index: 0 }
                        : { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content } };
                    response.write('event: ' + anthropicPayload.type + '\ndata: ' + JSON.stringify(anthropicPayload) + '\n\n');
                    entry.framesWritten += 1;
                    return;
                }
                const payload = {
                    id: 'chatcmpl-probe',
                    object: 'chat.completion.chunk',
                    created: 1,
                    model: 'probe-model',
                    choices: [{ index: 0, delta: isLast ? {} : { content }, finish_reason: isLast ? 'stop' : null }],
                };
                response.write(`data: ${JSON.stringify(payload)}\n\n`);
                entry.framesWritten += 1;
            };
            if (protocol === 'anthropic') {
                const messageStart = { type: 'message_start', message: { id: 'msg_probe', type: 'message', role: 'assistant', model: 'probe-model', content: [], stop_reason: null } };
                response.write('event: message_start\ndata: ' + JSON.stringify(messageStart) + '\n\n');
                const blockStart = { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } };
                response.write('event: content_block_start\ndata: ' + JSON.stringify(blockStart) + '\n\n');
            }
            let index = 0;
            const timer = setInterval(() => {
                if (index < frames.length) {
                    writeFrame(frames[index], false);
                    index += 1;
                    return;
                }
                clearInterval(timer);
                if (mode === 'cancel') {
                    // Hold the stream open: the browser must abort while text is partially rendered.
                    // The peer only ends when the caller closes (the close handler above records it).
                    return;
                }
                writeFrame('', true);
                finished = true;
                if (protocol === 'anthropic') {
                    response.write('event: message_delta\ndata: ' + JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 0 } }) + '\n\n');
                    response.write('event: message_stop\ndata: ' + JSON.stringify({ type: 'message_stop' }) + '\n\n');
                } else {
                    response.write('data: [DONE]\n\n');
                }
                response.end();
            }, frameDelay);
        });
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            resolve({
                address: `127.0.0.1:${port}`,
                state,
                close: () => new Promise(done => server.close(() => done())),
            });
        });
    });
}


let mock = null;
let streamingPeer = null;
let mockAddress = '';
if (streamingMode) {
    streamingPeer = await startStreamingPeer(probeMode, peerProtocol);
    mockAddress = streamingPeer.address;
} else {
    mock = spawn(mockProviderBinary, ['--responses', scriptPath, '--port', '0'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    mock.stdout.on('data', chunk => {
        const text = chunk.toString();
        const match = /mock-provider (\S+)/.exec(text);
        if (match) {
            mockAddress = match[1];
        }
    });
    for (let attempt = 0; attempt < 100 && !mockAddress; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!mockAddress) {
        throw new Error('mock provider did not report its address');
    }
}

// AIM THE LEGS AT THE PEER IN BOTH MODES. This block used to sit INSIDE the non-stream branch, so a
// streaming drive exported no seam and wrote no redirect mapping: the peer's own path log showed it was
// never asked for anything, on EITHER leg, because neither backend was pointed at it. That is a harness
// defect that presents exactly like a product one -- both legs refused for the same reason and the
// downstream symptom was 'the frontend never reached a connected online_status'.
    // OPENROUTER'S PEER CANNOT TRAVEL IN THE REQUEST. Its URL is the pinned literal
    // `https://openrouter.ai/api/v1` with no reverse_proxy and no custom_url, so the GoTavern leg is aimed at
    // the recording peer through the seam the provider-wire lane added, and the PINNED leg through the
    // transport redirect tools/run-against-pinned.mjs installs for the same origin.
    if (probeSource === 'openrouter' && !external) {
        process.env.GOTAVERN_OPENROUTER_CHAT_URL = `http://${mockAddress}`;
    }
    // The PINNED leg reaches the same peer through the loader hook tools/run-against-pinned.mjs installs when
    // this file is named: the hook re-reads it per request, which is why it can be written only now that the
    // peer has an address.
    const redirectFile = process.env.PROBE_PINNED_REDIRECT_FILE;
    if (probeSource === 'openrouter' && external && redirectFile) {
        await fs.writeFile(redirectFile, JSON.stringify([{ from: 'https://openrouter.ai/api/v1', to: `http://${mockAddress}` }]));
    }

const server = external ? null : spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
const serverLog = [];
if (server) {
    server.stdout.on('data', chunk => serverLog.push(chunk.toString()));
    server.stderr.on('data', chunk => serverLog.push(chunk.toString()));
}

const report = {
    question: 'does a send driven from the pinned frontend produce a provider request?',
    gotavern: process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`,
    mockProvider: `http://${mockAddress}`,
    requestArrived: false,
    recording: null,
    pageErrors: [],
    generatedText: null,
    failure: null,
};

let browser;
// PROBE_BASE_URL points the identical drive at another server (pinned Node) for a differential, and
// the same factoring is what the provider comparison will need.
const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;
try {
    await waitFor(`${baseURL}/version`, 'server');
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error.message ?? error).slice(0, 300)));
    // EVERY console message, not just errors. The frontend reports several generation problems with
    // console.warn/console.debug rather than by throwing (for example the custom-endpoint guard in
    // openai.js:4476 uses console.debug), so a report that only kept page errors could show a clean
    // run for a send that the frontend itself refused to make.
    report.console = [];
    page.on('console', message => {
        report.console.push({ t: Math.round(message.timestamp ? message.timestamp() * 1000 : 0), type: message.type(), text: String(message.text()).slice(0, 500) });
    });
    // Every request and its status, unfiltered: a negative finding about a call needs a log that
    // would have shown it, so the log is complete rather than pre-filtered.
    report.requests = [];
    const pendingRequests = new Map();
    page.on('request', request => {
        const entry = { t: Date.now(), method: request.method(), url: new URL(request.url()).pathname + new URL(request.url()).search, status: null };
        report.requests.push(entry);
        pendingRequests.set(request, entry);
    });
    page.on('response', response => {
        const entry = pendingRequests.get(response.request());
        if (entry) {
            entry.status = response.status();
        // A reader looking at a 400 needs to know in one glance whether the credential travelled. Boolean
        // only: the artifact must never carry the credential itself.
        try {
            const submitted = JSON.parse(entry.postData ?? '{}');
            entry.proxyPasswordPresent = Boolean(submitted.proxy_password && String(submitted.proxy_password).length > 0);
        } catch {
            entry.proxyPasswordPresent = null;
        }
        }
    });
    // THE BROWSER'S OWN TOKENIZER CALL, AS BYTES. A count the page computed is a number that two
    // different causes can produce: the server answering differently, or the page asking a different
    // question (another model, another body). The differential needs the REQUEST (method, path, exact
    // POST body) and the RESPONSE body for every /api/tokenizers call, on both legs, so a 10-vs-9 can be
    // attributed to one leg and not guessed at.
    // THE GENERATE EXCHANGE, REQUEST AND RESPONSE BODY. A 400 on this route is narrow enough that the body
    // names which branch answered, and comparing the two legs' bodies decides whether a difference is the
    // drive or the product. Recorded for every call, not only failures.
    report.generateCalls = [];
    const generateEntries = new Map();
    page.on('request', request => {
        if (!new URL(request.url()).pathname.endsWith('/chat-completions/generate')) return;
        generateEntries.set(request, { method: request.method(), postData: request.postData() ?? null, status: null, responseBody: null });
    });
    page.on('response', async response => {
        const entry = generateEntries.get(response.request());
        if (!entry) return;
        entry.status = response.status();
        // A reader looking at a 400 needs to know in one glance whether the credential travelled. Boolean
        // only: the artifact must never carry the credential itself.
        try {
            const submitted = JSON.parse(entry.postData ?? '{}');
            entry.proxyPasswordPresent = Boolean(submitted.proxy_password && String(submitted.proxy_password).length > 0);
        } catch {
            entry.proxyPasswordPresent = null;
        }
        try {
            entry.responseBody = (await response.text()).slice(0, 2000);
        } catch (error) {
            entry.responseBody = `unreadable: ${String(error.message ?? error)}`;
        }
        report.generateCalls.push(entry);
    });
    report.tokenizerCalls = [];
    const tokenizerEntries = new Map();
    page.on('request', request => {
        const url = new URL(request.url());
        if (!url.pathname.includes('/api/tokenizers')) return;
        const entry = { method: request.method(), path: url.pathname + url.search, postData: request.postData() ?? null, status: null, responseBody: null };
        report.tokenizerCalls.push(entry);
        tokenizerEntries.set(request, entry);
    });
    page.on('response', async response => {
        const entry = tokenizerEntries.get(response.request());
        if (!entry) return;
        entry.status = response.status();
        // A reader looking at a 400 needs to know in one glance whether the credential travelled. Boolean
        // only: the artifact must never carry the credential itself.
        try {
            const submitted = JSON.parse(entry.postData ?? '{}');
            entry.proxyPasswordPresent = Boolean(submitted.proxy_password && String(submitted.proxy_password).length > 0);
        } catch {
            entry.proxyPasswordPresent = null;
        }
        try {
            entry.responseBody = (await response.text()).slice(0, 4000);
        } catch (error) {
            entry.responseBody = `unreadable: ${String(error.message ?? error)}`;
        }
    });
    // Which calls the frontend makes, and which of them the server answers with an error: the
    // probe reports arrival, but if nothing arrives this is what says why.
    report.httpFailures = [];
    page.on('response', response => {
        if (response.status() >= 400) {
            report.httpFailures.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
        }
    });
    page.on('requestfailed', request => {
        report.httpFailures.push(`FAILED ${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? ''}`);
    });
    // Attribute "HTML parsed as JSON" to the request that produced it, rather than inferring it
    // from the 404 list: wrap fetch inside the page and record status plus whether the body looks
    // like markup, so the finding names a URL.
    const instrumentFetch = process.env.PROBE_NO_FETCH_WRAPPER !== '1';
    if (instrumentFetch) await page.addInitScript(() => {
        window.__probeFetchLog = [];
        // Token counts are issued by jQuery.ajax (XMLHttpRequest), not fetch. Capture the XHR pair so
        // the two legs can be compared on the EXACT inputs the frontend asked both servers to count:
        // a different token count changes how much of the prompt fits and therefore the provider
        // request body.
        window.__probeXhrLog = [];
        const originalXhrOpen = XMLHttpRequest.prototype.open;
        const originalXhrSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this.__probeUrl = String(url);
            return originalXhrOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function (body) {
            if (String(this.__probeUrl).includes('/api/tokenizers/')) {
                const xhr = this;
                xhr.addEventListener('load', () => {
                    window.__probeXhrLog.push({
                        url: xhr.__probeUrl,
                        requestBody: typeof body === 'string' ? body : null,
                        status: xhr.status,
                        responseText: xhr.responseText,
                    });
                });
            }
            return originalXhrSend.call(this, body);
        };
        const originalFetch = window.fetch;
        window.fetch = async (...parameters) => {
            const request = parameters[0];
            const probeRequestUrl = typeof request === 'string' ? request : (request?.url ?? '');
            if (probeRequestUrl.includes('api/ping')) {
                (window.__probePingLog = window.__probePingLog ?? []).push({
                    phase: 'call', t: Math.round(performance.now()),
                    stack: String(new Error().stack).slice(0, 800),
                    hasSignal: Boolean(parameters[1]?.signal),
                });
            }
            let response;
            try {
                response = await originalFetch(...parameters);
            } catch (error) {
                if (probeRequestUrl.includes('api/ping')) {
                    (window.__probePingLog = window.__probePingLog ?? []).push({ phase: 'reject', t: Math.round(performance.now()), name: error?.name, message: String(error?.message) });
                }
                throw error;
            }
            if (probeRequestUrl.includes('api/ping')) {
                (window.__probePingLog = window.__probePingLog ?? []).push({ phase: 'response', t: Math.round(performance.now()), status: response.status });
            }
            if (probeRequestUrl.includes('/api/tokenizers/')) {
                let responseText = null;
                try {
                    responseText = await response.clone().text();
                } catch {
                    responseText = null;
                }
                (window.__probeTokenizerLog = window.__probeTokenizerLog ?? []).push({
                    url: probeRequestUrl,
                    requestBody: typeof parameters[1]?.body === 'string' ? parameters[1].body : null,
                    status: response.status,
                    responseText,
                });
            }
            const url = typeof request === 'string' ? request : (request?.url ?? '');
            // Do NOT read the body of a 204/304 or a bodiless response. The wrapper originally read
            // every clone, and `await clone().text()` on the 204 from POST /api/ping never settled in
            // this page, so pingServer() hung and the real generation stopped after
            // GENERATION_AFTER_COMMANDS with the composer still full. That was a probe artefact, not
            // a frontend behaviour: the same wrapper also runs on the pinned leg.
            let looksLikeMarkup = false;
            const bodiless = response.status === 204 || response.status === 205 || response.status === 304 || request?.method === 'HEAD';
            // A STREAMED response must NOT be read through a clone before returning it: `await
            // clone().text()` waits for the whole stream, so the frontend's fetch promise would not
            // resolve until the last chunk and incremental rendering would be impossible to observe
            // (it also makes a mid-stream abort observe an empty message). This was a probe defect,
            // identical on both legs, not a server behaviour.
            const responseType = (response.headers.get('content-type') ?? '').toLowerCase();
            const isStreamingResponse = responseType.includes('text/event-stream') || /\/api\/backends\/chat-completions\/generate$/.test(probeRequestUrl);
            try {
                if (!bodiless && !isStreamingResponse) {
                    const text = await response.clone().text();
                    looksLikeMarkup = text.trimStart().startsWith('<');
                }
            } catch {
                looksLikeMarkup = false;
            }
            window.__probeFetchLog.push({ url, status: response.status, looksLikeMarkup });
            return response;
        };
    });
    await page.goto(`${baseURL}/`);
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60000 });

    // INSTRUMENT BEFORE THE DRIVE, NOT IMMEDIATELY BEFORE THE CLICK.
    //
    // The observation used to start a few statements before `sendButton.click()`, which made the
    // milestone counters depend on whether an ALREADY-RUNNING generation had finished by then. It
    // had: the prompt manager's own dry generation (PromptManager.js:862-872 -> openai.js:707-713 ->
    // Generate('normal', {}, true)) starts when the drive selects the chat-completion source/model,
    // and on a slower leg its GENERATE_AFTER_DATA landed INSIDE the recorded window while on a
    // faster leg it landed before the window opened. Measured on the recorded legs: both runs
    // entered Generate exactly 3 times and called runGenerate 3 times, but the pinned window
    // contained a second dry GENERATE_AFTER_DATA with NO dry GENERATION_STARTED -- i.e. a fragment
    // of a Generate that had begun before the window. That is an observation-window race, not a
    // product difference, and a window that can start mid-operation must not be recorded as if it
    // were a state.
    //
    // So: attach the recorder here (page load), count in-flight Generate invocations, wait for the
    // frontend to be idle before clicking a real user's send, and slice the reported events at the
    // click. The counters then measure the send and its consequences on both legs.
    await page.evaluate(async () => {
        const { eventSource, event_types } = await import('./scripts/events.js');
        const namesByValue = new Map(Object.entries(event_types).map(([eventName, eventValue]) => [eventValue, eventName]));
        globalThis.__probeEmitLog = [];
        globalThis.__probeInFlight = 0;
        globalThis.__probeInFlightMax = 0;
        globalThis.__probeCompletions = 0;
        globalThis.__probeGenerates = [];
        const originalEmit = eventSource.emit.bind(eventSource);
        eventSource.emit = (eventValue, ...args) => {
            const eventName = namesByValue.get(eventValue) ?? String(eventValue);
            const entry = { name: eventName, t: Math.round(performance.now()), settled: false };
            globalThis.__probeEmitLog.push(entry);
            // In-flight accounting, derived from the pinned emitter arguments and the pinned
            // control flow rather than from a guess:
            //   script.js:4299  emit(GENERATION_STARTED, type, options, dryRun)  -> args[2] is dryRun
            //   script.js:5318  emit(GENERATE_AFTER_DATA, generate_data, dryRun) -> args[1] is dryRun
            //   script.js:5320  `if (dryRun) return Promise.resolve();` -- a DRY generation ends here,
            //                   before finishGenerating(), so it never shows the stop button and never
            //                   emits GENERATION_ENDED (that comes from hideStopButton(), script.js:3536).
            // A real generation therefore ends with GENERATION_ENDED, a dry one with its
            // GENERATE_AFTER_DATA; both are counted, so an idle frontend is inFlight === 0.
            if (eventName === 'GENERATION_STARTED') {
                globalThis.__probeInFlight += 1;
                globalThis.__probeInFlightMax = Math.max(globalThis.__probeInFlightMax, globalThis.__probeInFlight);
                globalThis.__probeGenerates.push({ event: 'started', dryRun: args[2] === true, t: entry.t });
            } else if (eventName === 'GENERATION_ENDED') {
                globalThis.__probeInFlight = Math.max(0, globalThis.__probeInFlight - 1);
                globalThis.__probeCompletions += 1;
                globalThis.__probeGenerates.push({ event: 'ended', dryRun: false, t: entry.t });
            } else if (eventName === 'GENERATION_STOPPED') {
                // An aborted send completes this way too (script.js:5618); GENERATION_ENDED still
                // follows from hideStopButton(), but counting both keeps an abort from looking like
                // a send that never finished.
                globalThis.__probeCompletions += 1;
                globalThis.__probeGenerates.push({ event: 'stopped', dryRun: false, t: entry.t });
            } else if (eventName === 'GENERATE_AFTER_DATA' && args[1] === true) {
                globalThis.__probeInFlight = Math.max(0, globalThis.__probeInFlight - 1);
                globalThis.__probeGenerates.push({ event: 'dryData', dryRun: true, t: entry.t });
            }
            const result = originalEmit(eventValue, ...args);
            if (result && typeof result.then === 'function') {
                result.then(() => { entry.settled = true; }, () => { entry.settled = 'rejected'; });
            } else {
                entry.settled = true;
            }
            return result;
        };
        globalThis.__probeEvents = [];
        for (const [name, value] of Object.entries(event_types)) {
            if (!['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATE_BEFORE_COMBINE_PROMPTS', 'GENERATE_AFTER_COMBINE_PROMPTS', 'CHAT_COMPLETION_PROMPT_READY', 'GENERATE_AFTER_DATA', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATION_ENDED', 'GENERATION_STOPPED'].includes(name)) {
                continue;
            }
            eventSource.on(value, (...args) => globalThis.__probeEvents.push({
                name,
                t: Math.round(performance.now()),
                // GENERATION_STARTED(-ish) emits dryRun as the third argument; GENERATE_AFTER_DATA
                // as the second. Recording it separates a prompt-assembly dry run from the real
                // send, which is invisible if only the event name is kept.
                dryRun: JSON.stringify(args.map(argument => (typeof argument === 'boolean' ? argument : (argument && typeof argument === 'object' ? Object.keys(argument).slice(0, 6) : typeof argument)))),
            }));
        }
    });

    // Load the captured user configuration into the page before driving, when the fixture exists.
    const fixturePath = path.join(here, 'fixtures', 'custom-source-settings.json');
    let capturedSettings = null;
    try {
        const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
        capturedSettings = fixture.capture?.oaiSettings ?? null;
    } catch {
        capturedSettings = null;
    }
    if (capturedSettings) {
        await page.evaluate(settings => {
            globalThis.__capturedSettings = settings;
        }, capturedSettings);
    }
    const outcome = await page.evaluate(async ({ mockUrl, probeMode, probeSource }) => {
    const streaming = probeMode === 'stream' || probeMode === 'cancel';
        // Faithful drive: load and select a character through the frontend's OWN functions, then send
        // through the UI button. The earlier version pushed into a temporary chat and called
        // Generate() with the frontend already mid-operation and no character bound, which a user
        // cannot do; it short-circuited on a guard and reported "no request" with no error.
        const script = await import('./script.js');
        const { oai_settings } = await import('./scripts/openai.js');
        const secretsModule = await import('./scripts/secrets.js');
        // The custom OpenAI-compatible source needs a key in secret_state; a user would paste one.
        const sourceSecretKey = {
            openrouter: secretsModule.SECRET_KEYS.OPENROUTER,
            claude: secretsModule.SECRET_KEYS.CLAUDE,
            mistralai: secretsModule.SECRET_KEYS.MISTRALAI,
            custom: secretsModule.SECRET_KEYS.CUSTOM,
        }[probeSource];
        await secretsModule.writeSecret(sourceSecretKey, 'probe-synthetic-key');

        await script.getCharacters();
        if (!Array.isArray(script.characters) || script.characters.length === 0) {
            return { preconditions: { charactersLoaded: false }, error: 'no characters available after getCharacters()' };
        }
        await script.selectCharacterById(0, { switchMenu: false });

        // Start from the CAPTURED user configuration when the fixture exists: the earlier drive set
        // three fields by hand and declined to send on BOTH servers, proving the configuration (not
        // the server) was the problem. The fixture is recorded from the frontend's own handlers.
        const captured = globalThis.__capturedSettings ?? null;
        if (captured) {
            Object.assign(oai_settings, captured);
        }
        if (!captured) {
        oai_settings.chat_completion_source = 'custom';
        oai_settings.custom_url = mockUrl;
        oai_settings.custom_model = 'probe-model';
        oai_settings.stream_openai = false;
        oai_settings.openai_max_context = 4096;
        oai_settings.openai_max_tokens = 64;
        }
        if (captured) {
            oai_settings.custom_url = mockUrl;
        }
        // Streaming is a property of THIS drive, not of the captured user settings: the fixture stores
        // booleans as the strings the panel writes, and a streamed send must be requested explicitly.
        oai_settings.stream_openai = streaming;

        // WHICH SOURCE THIS DRIVE SELECTS. The captured fixture is a custom-source setup, so the source is
        // assigned AFTER it: without this, an openrouter run would silently be a custom run. For openrouter
        // the peer cannot travel in the request (its URL is a pinned literal with no request member), so the
        // legacy `custom_url` is left alone and the GoTavern leg is aimed by its seam below.
        oai_settings.chat_completion_source = probeSource;
        // CLAUDE AND MISTRALAI ARE AIMED THROUGH THE FRONTEND'S OWN `reverse_proxy` SETTING, not a
        // test-only seam: both read it (their provider-wire scenarios include a reverse-proxy variant), so
        // the peer address travels the way a user's endpoint would and BOTH legs follow it.
        if (probeSource === 'openrouter') {
            oai_settings.openrouter_model = 'probe-model';
        } else if (probeSource === 'claude') {
            oai_settings.claude_model = 'probe-model';
            oai_settings.reverse_proxy = mockUrl;
        } else if (probeSource === 'mistralai') {
            oai_settings.mistralai_model = 'probe-model';
            oai_settings.reverse_proxy = mockUrl;
        } else if (captured) {
            oai_settings.custom_url = mockUrl;
        } else {
            oai_settings.custom_url = mockUrl;
        }

        // The API dispatch flag is NOT part of oai_settings, and `main_api` is an exported `let` that
        // cannot be reassigned from outside its module, so the settings shortcut above leaves it at
        // whatever the page happened to load. sendGenerationRequest branches on it BEFORE looking at
        // the chat-completion source (script.js:6117), so a stale value sends the request down the
        // Horde path instead: horde.js:148 logged `8192 350` and /api/horde/text-workers was called,
        // and no chat-completions call was ever made -- identically on pinned Node and GoTavern. The
        // fix is to drive the control a user drives, `#main_api`, whose change handler assigns it
        // (script.js:7861).
        // A real user cannot act before the page has finished loading settings: `settingsReady`
        // (script.js:421, set at the end of getSettings) gates saveSettings, and a send started
        // while it is false leaves PromptManager's saveServiceSettings awaiting an event that a
        // gated save never emits. Measured: both servers emitted "Settings not ready" continuously
        // and the real (dryRun=false) generation stopped right after GENERATION_AFTER_COMMANDS while
        // a prompt-manager dry run proceeded. Wait for the same readiness a user waits for.
        // FIRST-RUN ONBOARDING. A fresh data root has settings.firstRun=true, and getSettings
        // AWAITS doOnboarding() (script.js:8041), which is a user-input popup; settingsReady stays
        // false until the user completes it. A real first-run user fills the name and clicks OK, so
        // the drive does exactly that instead of acting on a page no user could act on.
        const onboarding = document.querySelector('.popup .onboarding');
        const onboardingCompleted = Boolean(onboarding);
        if (onboarding) {
            const nameInput = onboarding.closest('.popup')?.querySelector('.popup-input');
            if (nameInput) {
                nameInput.value = 'Probe User';
                nameInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const okButton = onboarding.closest('.popup')?.querySelector('.popup-button-ok');
            if (okButton) {
                okButton.click();
            }
        }
        const readinessDeadline = performance.now() + 60000;
        let settingsReady = false;
        let readinessDiagnostics = null;
        while (performance.now() < readinessDeadline) {
            const scriptModule = await import('./script.js');
            settingsReady = Boolean(scriptModule.settingsReady);
            if (settingsReady) break;
            readinessDiagnostics = {
                onboardingCompleted,
                firstRun: scriptModule.settings?.firstRun ?? null,
                hasSettings: Boolean(scriptModule.settings),
                settingsKeys: scriptModule.settings ? Object.keys(scriptModule.settings).length : 0,
                onboardingPresent: Boolean(document.querySelector('#onboarding_template')),
                popupText: (document.querySelector('.popup')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
            };
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!settingsReady) {
            return { preconditions: { charactersLoaded: true, settingsReady: false, readiness: readinessDiagnostics }, error: 'settingsReady never became true within 60s' };
        }
        const mainApiSelect = document.querySelector('#main_api');
        if (!mainApiSelect) {
            return { preconditions: { charactersLoaded: true }, error: '#main_api is not present, so the API cannot be selected the way a user selects it' };
        }
        mainApiSelect.value = 'openai';
        mainApiSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 1000));

        const diagnostics = () => ({
            // The API dispatch flag, which is NOT in oai_settings: sendGenerationRequest branches on
            // it (script.js:6117) before it ever looks at the chat-completion source.
            mainApi: String(script.main_api),
            thisChid: typeof script.this_chid === 'undefined' ? 'undefined' : String(script.this_chid),
            charactersLength: Array.isArray(script.characters) ? script.characters.length : 'not-array',
            chatLength: Array.isArray(script.chat) ? script.chat.length : 'not-array',
            isGenerating: Boolean(script.isGenerating),
            generatingAttribute: document.body.dataset.generating ?? null,
            sendButtonDisabled: Boolean(document.querySelector('#send_but')?.disabled),
            hasSendButton: Boolean(document.querySelector('#send_but')),
            // The frontend reports a refused generation through toastr, not through the console: a
            // caught error renders a toast and fires generation_ended with no page error at all. A
            // probe that only watched pageErrors and /api calls saw "nothing happened".
            toastr: (document.querySelector('#toast-container')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        });
        // CONNECT. A chat-completion send is silently ignored when online_status is 'no_connection'
        // (script.js:4391 returns before the composer is touched), and online_status is only set by
        // the frontend's own connection check. A user presses Connect after entering the endpoint and
        // key, so the drive presses the same control and waits for the status to change. Measured
        // first: without this, the real generation stopped right after GENERATION_AFTER_COMMANDS with
        // the composer untouched and no user message appended.
        // CREDENTIALS GO THROUGH THE FIELD THE CONNECT HANDLER READS, not through the secrets API. openai.js
        // :6082 reads `$(config.selector).val()`, writes the secret itself and updates `secret_state`; a
        // drive that writes /api/secrets/write directly leaves the page's map stale (it is populated once at
        // load, secrets.js:419), so the handler's `!secret_state[config.key]` guard fires and returns BEFORE
        // any status call -- measured as an empty peer path log on both legs with no status request at all.
        const sourceKeySelector = {
            claude: '#api_key_claude',
            mistralai: '#api_key_mistralai',
            openrouter: '#api_key_openrouter',
            custom: '#api_key_custom',
        }[probeSource];
        // THE PROXY FIELD IS TYPED, NOT ASSIGNED. `oai_settings.reverse_proxy` is written by the
        // `#openai_reverse_proxy` handler (openai.js:6031); assigning the property directly left the connect
        // guard `!secret_state[MISTRALAI] && (!proxy || !reverse_proxy)` (openai.js:6089) firing, which is
        // why a validating source issued NO status call at all. Typing through the field is the user path
        // and the handler writes the same property.
        // THE DOM IS MEASURED BEFORE IT IS USED. Two rounds were spent guessing selectors; this records what
        // the panel actually renders (the reverse-proxy field's real id/value, whether the per-source key
        // field exists, and what the setting holds) so the next decision is a reading, not a guess.
        globalThis.__probeDomDump = {
            source: probeSource,
            reverseProxySettingBefore: String(oai_settings.reverse_proxy ?? ''),
            proxyFieldByIdExists: Boolean(document.querySelector('#openai_reverse_proxy')),
            proxyFieldByIdValue: document.querySelector('#openai_reverse_proxy')?.value ?? null,
            proxyInputsRendered: [...document.querySelectorAll('input[id*="proxy"], input[name*="proxy"]')].map(element => ({ id: element.id, name: element.name, value: String(element.value ?? '') })),
            sourceKeySelector,
            sourceKeyFieldExists: sourceKeySelector ? Boolean(document.querySelector(sourceKeySelector)) : false,
        };
        // (The #openai_reverse_proxy field is NOT typed: the DOM dump showed oai_settings.reverse_proxy already
        // populated at click time while the field itself is a different control, so typing it is noise.)
        globalThis.__probeDomDump.reverseProxySettingAfterType = String(oai_settings.reverse_proxy ?? '');
        // THE PROXY ACCESS KEY IS THE CREDENTIAL THE SERVER ACTUALLY READS when a reverse proxy is set:
        // chat-completions.js:881 `const apiKey = request.body.reverse_proxy ? request.body.proxy_password : readSecret(...)`.
        // A source secret typed into #api_key_<source> therefore does NOT satisfy it, and the route answers
        // 400 {"error":true} with no message -- measured identically on both legs. A user fills this field in
        // the proxy panel, so the drive does the same.
        const proxyAccessField = document.querySelector('#openai_proxy_access_key');
        if (proxyAccessField) {
            proxyAccessField.value = 'probe-synthetic-key';
            proxyAccessField.dispatchEvent(new Event('input', { bubbles: true }));
            proxyAccessField.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const keyField = sourceKeySelector ? document.querySelector(sourceKeySelector) : null;
        if (keyField) {
            keyField.value = 'probe-synthetic-key';
            keyField.dispatchEvent(new Event('input', { bubbles: true }));
            keyField.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // THE PROXY CONFIRMATION DIALOG, INSTALLED BEFORE CONNECT. `getStatusOpen` (:4493-4506) runs
        // `validateReverseProxy()` for MISTRALAI because `validateProxySources` contains it, and the SEND path
        // runs the same guard again (:2849) for CLAUDE, which is in `noValidateSources` and therefore gets past
        // connect. One dialog, two symptoms: no status request (connect) or a hang with the prompt assembled and
        // no generate request (send). The button is `.popup-button-ok` on a `<dialog>` cloned from
        // `#popup_template` (popup.js:255-256) -- NOT scoped under `#popup`, which is why a comma list scoped
        // there matched nothing.
        let popupClicks = 0;
        const popupSeen = [];
        const popupWatcher = setInterval(() => {
            const okButton = document.querySelector('.popup-button-ok');
            if (!okButton) return;
            const dialog = okButton.closest('dialog') ?? okButton.parentElement;
            if (popupSeen.length === 0 && dialog) {
                popupSeen.push({ id: dialog.id, className: String(dialog.className), html: String(dialog.outerHTML ?? '').slice(0, 1200) });
                globalThis.__probePopupDump = popupSeen;
            }
            if (typeof okButton.click === 'function') {
                okButton.click();
                popupClicks += 1;
            }
        }, 100);
        globalThis.__probePopupWatcherInstalled = true;
        const connectButton = document.querySelector('#api_button_openai');
        if (connectButton) {
            connectButton.click();
        } else {
            const fallbackConnect = document.querySelector('#api_button_openai, .api_button[data-server-connect="openai"]');
            fallbackConnect?.click();
        }
        // NO-VALIDATE SOURCES (openai.js:4459 `getStatusOpen`): claude, ai21, vertexai, perplexity, zai,
        // minimax. For these the page sets a STATUS MESSAGE ("Key saved; press \"Test Message\" to verify.")
        // and returns BEFORE the status route is called, so a drive that waits for a connected online_status
        // waits for a state a user of these sources never reaches. Assert the state the page DOES reach and
        // record its text; a real user's only verification is the first message, so the drive sends.
        const NO_VALIDATE_SOURCES = ['claude', 'ai21', 'vertexai', 'perplexity', 'zai', 'minimax'];
        const noValidate = NO_VALIDATE_SOURCES.includes(probeSource);
        const connectionDeadline = performance.now() + 30000;
        let onlineStatus = 'unknown';
        while (performance.now() < connectionDeadline) {
            const scriptModule = await import('./script.js');
            onlineStatus = String(scriptModule.online_status);
            if (onlineStatus !== 'no_connection' && onlineStatus !== 'unknown') break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (noValidate) {
            // Recorded, not synthesised: whatever the page itself says after the no-validate branch, plus
            // the preconditions it implies, so the artifact can name the connect state.
            const statusElement = document.querySelector('#online_status');
            onlineStatus = String(statusElement?.textContent ?? onlineStatus);
        }
        if (!noValidate && onlineStatus === 'no_connection') {
            return { preconditions: { charactersLoaded: true, settingsReady: true, onlineStatus, connectButtonPresent: Boolean(connectButton) }, error: 'the frontend never reached a connected online_status; a send is silently ignored in that state' };
        }
        // WHICH MODELS THE PAGE ACCEPTED for the openrouter source: an empty or fallback-only list
        // means the page never accepted the peer's model, which is a different failure from a populated
        // list whose connect path needs a call the peer does not answer.
        const modelOptionValues = [...document.querySelectorAll('#model_openrouter_select option')].map(option => String(option.value)).slice(0, 25);
        const modelOptionCount = document.querySelectorAll('#model_openrouter_select option').length;
        // THE PROXY CONFIRMATION DIALOG (openai.js:2849 -> validateReverseProxy :537-563). `proxySupportedSources`
        // includes CLAUDE and MISTRALAI, so `generate_data.reverse_proxy` IS sent; the send then awaits an
        // accountStorage-gated confirm popup, and an unclicked popup looks exactly like a hang: the promise
        // never settles, no provider request is issued, both legs identical, 60 s later the drive times out.
        // A real user sees this dialog once and clicks Connect, so the drive clicks the same button instead of
        // pre-setting `Proxy_SkipConfirm_<hash>` in accountStorage -- the popup path is the user's path.
        // (the popup watcher is installed before the connect click above)
        const before = diagnostics();
        before.popupWatcherInstalled = globalThis.__probePopupWatcherInstalled === true;
        before.modelOptionCount = modelOptionCount;
        before.modelOptionValues = modelOptionValues;
        // Preconditions a real user action implies. Asserted, not assumed: an unfaithful drive must
        // fail loudly instead of reporting a false negative.
        if (before.thisChid === 'undefined' || before.charactersLength === 0) {
            return { preconditions: { charactersLoaded: false, ...before }, error: 'no character bound before the send' };
        }
        // The user-facing gate is the DOM/live flag the frontend itself uses (body[data-generating]
        // and the disabled send button), not the internal isGenerating variable, which reports true
        // on a freshly loaded page and would reject a legitimate user state.
        if (before.generatingAttribute !== null || before.sendButtonDisabled) {
            return { preconditions: { charactersLoaded: true, ...before }, error: 'the send button was not in a user-sendable state' };
        }

        const composer = document.querySelector('#send_textarea');
        if (composer) {
            composer.value = 'probe user marker';
            composer.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const sendButton = document.querySelector('#send_but');
        // The generation-event recorder is installed at PAGE LOAD (see the __probeEmitLog /
        // __probeEvents installation above), not here: a recorder attached at this point captures a
        // window that begins mid-operation when a dry generation is still running, which is exactly
        // the difference the milestone counters used to record.
        //
        // QUIESCENCE BEFORE A SEND A USER COULD MAKE (AGENTS.md verification rule 10). The prompt
        // manager's debounced re-render starts a dry generation by itself whenever the source, model
        // or preset changes -- including the changes this drive makes. `render()` waits for
        // `!is_send_press` (PromptManager.js:868) but does not block the send button, so a click
        // issued mid-dry-run is a state a user cannot observe the outcome of: it interleaves two
        // prompt assemblies. Wait for the idle state, and if it never arrives say so instead of
        // recording a window that started mid-operation.
        const quiescenceStarted = performance.now();
        const quiescenceDeadline = quiescenceStarted + 60000;
        let quiescentSince = null;
        while (performance.now() < quiescenceDeadline) {
            if ((globalThis.__probeInFlight ?? 0) === 0) {
                if (quiescentSince === null) {
                    quiescentSince = performance.now();
                }
                if (performance.now() - quiescentSince >= 500) {
                    break;
                }
            } else {
                quiescentSince = null;
            }
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        const quiesced = quiescentSince !== null && performance.now() - quiescentSince >= 500;
        globalThis.__probeQuiescence = {
            quiesced,
            waitedMs: Math.round(performance.now() - quiescenceStarted),
            inFlightMaxBeforeSend: globalThis.__probeInFlightMax ?? 0,
            inFlightAtClick: globalThis.__probeInFlight ?? 0,
            // Whole-drive lifecycle, INDEPENDENT of the reported window: every Generate invocation
            // this page ran, dry or real. This is the number a reader needs in order to check
            // whether a windowed counter is a difference of behaviour or of observation.
            generateInvocationsBeforeSend: (globalThis.__probeGenerates ?? []).filter(entry => entry.event === 'started').length,
        };
        if (!quiesced) {
            return {
                preconditions: { charactersLoaded: true, ...before, quiescence: globalThis.__probeQuiescence },
                error: `the frontend was still running a generation when the send was due (in flight: ${globalThis.__probeInFlight ?? 0}); a click here would record a window that began mid-operation`,
            };
        }
        // Incremental rendering is observed with a MutationObserver on the chat: each distinct text
        // state of the last message is a render event. A single-chunk (non-incremental) response and
        // a genuinely streamed response are distinguishable here, and cancellation can be proven by
        // the text no longer changing after the stop click.
        globalThis.__probeRenderSnapshots = [];
        const chatRoot = document.querySelector('#chat');
        const recordRender = () => {
            const messages = chatRoot.querySelectorAll('.mes');
            const last = messages[messages.length - 1];
            const text = last ? (last.querySelector('.mes_text')?.innerText ?? '') : '';
            const previous = globalThis.__probeRenderSnapshots[globalThis.__probeRenderSnapshots.length - 1];
            if (!previous || previous.text !== text) {
                globalThis.__probeRenderSnapshots.push({ t: Math.round(performance.now()), text });
            }
        };
        const renderObserver = new MutationObserver(recordRender);
        if (chatRoot) {
            renderObserver.observe(chatRoot, { subtree: true, childList: true, characterData: true });
        }
        globalThis.__probeClickT = Date.now();
        globalThis.__probeClickPerf = Math.round(performance.now());
        // The reported event window starts AT THE CLICK, and because the frontend was quiescent a
        // moment ago no generation can straddle this boundary. Events recorded before it are kept as
        // counts (report.eventsBeforeClick) so a reader can see what was excluded and why.
        globalThis.__probeEventIndexAtClick = (globalThis.__probeEvents ?? []).length;
        sendButton.click();

        // Mode-aware settle. Non-streaming keeps the original fixed settle; streaming WAITS for the
        // observable (at least two distinct rendered text states) instead of guessing, and the cancel
        // mode then presses the frontend's own Abort control and checks that the text stops changing.
        const renderSnapshots = () => globalThis.__probeRenderSnapshots ?? [];
        const waitUntil = async (predicate, timeout) => {
            const deadline = performance.now() + timeout;
            while (performance.now() < deadline) {
                if (predicate()) {
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return false;
        };
        let streamState = null;
        if (streaming) {
            // Cancellation must happen AFTER streamed content has been rendered, otherwise the abort
            // proves only that a placeholder was cleared. Wait for an EXACT rendered prefix ('Hello
            // from'), not a snapshot count: a count is a race between provider writing and browser
            // rendering, while the exact prefix is a state both legs can reach. Streaming mode uses
            // the same predicate so both legs only proceed once incremental content is visible.
            const contentSnapshots = () => renderSnapshots().filter(snapshot => String(snapshot.text ?? '').startsWith('Hello from'));
            const sawIncremental = await waitUntil(() => contentSnapshots().length >= 1, 20000);
            streamState = { sawIncremental, contentSnapshotsBeforeEnd: contentSnapshots().length, snapshotsBeforeEnd: renderSnapshots().length };
            if (probeMode === 'cancel') {
                const stopButton = document.querySelector('#mes_stop');
                streamState.stopPresent = Boolean(stopButton);
                streamState.stopClickedAt = Math.round(performance.now());
                if (stopButton) {
                    stopButton.click();
                }
                await new Promise(resolve => setTimeout(resolve, 1200));
                streamState.snapshotsAtStopPlus1200 = renderSnapshots().length;
                streamState.textAfterStop = renderSnapshots().at(-1)?.text ?? null;
                await new Promise(resolve => setTimeout(resolve, 1500));
                streamState.snapshotsLater = renderSnapshots().length;
                streamState.textLater = renderSnapshots().at(-1)?.text ?? null;
            } else {
                await waitUntil(() => !script.isGenerating, 30000);
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        } else {
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
        // THE END OF THE WINDOW IS A STATE, NOT A SLEEP.
        //
        // The fixed 3 s settle above is enough on a fast leg and not on a slow one, and the milestone
        // counters are read from the events recorded up to the end of the window. Measured: a pinned
        // leg whose server was slower had rendered the reply but had NOT yet emitted GENERATION_ENDED
        // when the fixed sleep expired, so the same drive produced generationEnded=0 there and 1 on
        // GoTavern -- a difference in when the window closed, not in either server. The window is
        // therefore closed the way it is opened (a state): the send must COMPLETE (GENERATION_ENDED
        // or an aborted GENERATION_STOPPED), and the page must then be idle for longer than
        // debounce_timeout.relaxed (1000 ms, constants.js) so a debounced prompt-manager re-render --
        // the frontend's own dry generation, which is what the dry counters count -- starts and
        // finishes INSIDE the window instead of falling off its end on one leg only.
        const settleStarted = performance.now();
        const settleDeadline = settleStarted + 60000;
        let idleSince = null;
        let settleInFlight = null;
        while (performance.now() < settleDeadline) {
            settleInFlight = globalThis.__probeInFlight ?? 0;
            const completed = (globalThis.__probeCompletions ?? 0) >= 1;
            if (completed && settleInFlight === 0) {
                if (idleSince === null) {
                    idleSince = performance.now();
                }
                if (performance.now() - idleSince >= 1500) {
                    break;
                }
            } else {
                idleSince = null;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const settledIdle = idleSince !== null && performance.now() - idleSince >= 1500;
        globalThis.__probeSettle = {
            settledIdle,
            waitedMs: Math.round(performance.now() - settleStarted),
            completions: globalThis.__probeCompletions ?? 0,
            inFlightAtRead: settleInFlight,
        };
        if (!settledIdle) {
            return {
                preconditions: { charactersLoaded: true, ...before, settle: globalThis.__probeSettle },
                error: `the send did not complete and settle within 60s (completions: ${globalThis.__probeCompletions ?? 0}, in flight: ${settleInFlight}); the recorded window would end before the send did`,
            };
        }
        // Post-send measurement: whether the user message was appended (sendMessageAsUser got past
        // saveChatConditional) and whether a token count issued from the page can still complete.
        // This distinguishes "stuck inside sendMessageAsUser" from "never reached it".
        const tokenizersModule = await import('./scripts/tokenizers.js');
        const tokenCountProbe = await Promise.race([
            tokenizersModule.getTokenCountAsync('probe user marker', 0).then(value => `resolved:${value}`, error => `rejected:${String(error?.message ?? error)}`),
            new Promise(resolve => setTimeout(() => resolve('timeout'), 4000)),
        ]);
        const scriptModule = await import('./script.js');
        const manualPing = await Promise.race([
            fetch('api/ping', { method: 'POST', headers: scriptModule.getRequestHeaders?.({ omitContentType: true }) ?? {} })
                .then(async response => `status:${response.status}:${(await response.text()).slice(0, 60)}`, error => `error:${error.name}:${error.message}`),
            new Promise(resolve => setTimeout(() => resolve('timeout'), 5000)),
        ]);
        const postSend = {
            manualPing,
            toastrAfter: (document.querySelector('#toast-container')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
            chatLength: Array.isArray(scriptModule.chat) ? scriptModule.chat.length : 'not-array',
            chatDomMessages: document.querySelectorAll('#chat .mes').length,
            textareaValue: String(document.querySelector('#send_textarea')?.value ?? ''),
            tokenCountProbe,
            popupClicks,
            popupSeen,
            popupClicks,
            emitPending: (globalThis.__probeEmitLog ?? []).filter(entry => entry.settled === false).map(entry => entry.name),
            renderSnapshots: renderSnapshots(),
            finalAssistantText: (() => {
                const messages = document.querySelectorAll('#chat .mes');
                for (let index = messages.length - 1; index >= 0; index--) {
                    if (messages[index].getAttribute('is_user') !== 'true') {
                        return messages[index].querySelector('.mes_text')?.innerText ?? null;
                    }
                }
                return null;
            })(),
            streamState,
        };
        return { preconditions: { charactersLoaded: true, ...before }, error: null, after: diagnostics(), postSend };
    }, { mockUrl: `http://${mockAddress}`, probeMode, probeSource });

    report.htmlIntoJson = await page.evaluate(() => (window.__probeFetchLog ?? []).filter(entry => entry.looksLikeMarkup));
    report.fetchFailures = await page.evaluate(() => (window.__probeFetchLog ?? []).filter(entry => entry.status >= 400));
    // The reported window is [click, end]. A dry generation the drive's own setup started cannot
    // straddle it, because the click waited for quiescence; whatever came before the click is
    // retained as a count so the exclusion is visible instead of silent.
    report.events = await page.evaluate(() => {
        const all = globalThis.__probeEvents ?? [];
        const index = globalThis.__probeEventIndexAtClick;
        return typeof index === 'number' ? all.slice(index) : all;
    });
    report.eventsBeforeClick = await page.evaluate(() => {
        const all = globalThis.__probeEvents ?? [];
        const index = globalThis.__probeEventIndexAtClick;
        const before = typeof index === 'number' ? all.slice(0, index) : [];
        return { count: before.length, names: before.map(entry => entry.name) };
    });
    report.quiescence = await page.evaluate(() => globalThis.__probeQuiescence ?? null);
    report.settle = await page.evaluate(() => globalThis.__probeSettle ?? null);
    // Whole-drive Generate lifecycle, windowed counters excluded on purpose: this is the number that
    // says whether two legs ran the same NUMBER of generations, independently of where a window fell.
    report.generateLifecycle = await page.evaluate(() => {
        const entries = globalThis.__probeGenerates ?? [];
        const started = entries.filter(entry => entry.event === 'started');
        return {
            started: started.length,
            dryStarted: started.filter(entry => entry.dryRun === true).length,
            realStarted: started.filter(entry => entry.dryRun === false).length,
            dryAfterData: entries.filter(entry => entry.event === 'dryData').length,
            ended: entries.filter(entry => entry.event === 'ended').length,
            invocations: started.map(entry => ({ dryRun: entry.dryRun, t: entry.t })),
        };
    });
    report.clickT = await page.evaluate(() => globalThis.__probeClickT ?? null);
    report.emitLog = await page.evaluate(() => (globalThis.__probeEmitLog ?? []).filter(entry => entry.t >= (globalThis.__probeClickPerf ?? 0) - 50));
    report.requestsAfterClick = report.requests.filter(entry => report.clickT !== null && entry.t >= report.clickT - 50);
    report.pingLog = await page.evaluate(() => globalThis.__probePingLog ?? []);
    report.tokenizerLog = await page.evaluate(() => globalThis.__probeTokenizerLog ?? []);
    report.xhrLog = await page.evaluate(() => globalThis.__probeXhrLog ?? []);
    report.diagnostics = outcome.preconditions ?? null;
    report.postSend = outcome.postSend ?? null;
    if (outcome.error) {
        report.failure = `Generate threw: ${outcome.error}`;
    }

    // Read the measured DOM back out of the page, whatever the drive's outcome was: a failed drive still
    // has to answer what the panel rendered.
    try {
        report.domDump = await page.evaluate(() => globalThis.__probeDomDump ?? null);
        report.popupDump = await page.evaluate(() => globalThis.__probePopupDump ?? null);
    } catch (error) {
        report.domDumpError = String(error.message ?? error);
    }
    report.streamState = outcome.postSend?.streamState ?? null;
    if (streamingMode) {
        // The in-process peer recorded the request, its body digest, whether the caller closed the
        // stream before it finished (cancellation), and how many frames it wrote.
        report.recording = streamingPeer.state.requests.map(request => ({
            method: request.method,
            path: request.path,
            bodyLength: request.bodyLength,
            body: request.body,
            bodySha256: request.bodySha256,
            clientDisconnected: request.clientDisconnected,
            framesWritten: request.framesWritten,
        }));
        report.streamingPeerPaths = streamingPeer.state.paths;
        report.requestArrived = report.recording.some(request => request.method === 'POST');
        if (!report.requestArrived) {
            report.failure = report.failure ?? 'streaming peer received no POST /chat/completions';
        }
    } else {
        // Poll the recorder rather than the page: arrival is the fact under test. 300 attempts at
        // 200ms is a 60s window, which prompt assembly has repeatedly needed.
        for (let attempt = 0; attempt < 300; attempt++) {
            const recording = await (await fetch(`http://${mockAddress}/__mock/recording`)).json();
            if ((recording.requests ?? []).length > 0) {
                report.requestArrived = true;
                report.recording = recording.requests.map(request => {
                    const rawBody = request.bodyText ?? (request.bodyBase64 ? Buffer.from(request.bodyBase64, 'base64').toString('utf8') : null);
                    let parsedBody = null;
                    try {
                        parsedBody = rawBody ? JSON.parse(rawBody) : null;
                    } catch {
                        parsedBody = null;
                    }
                    return {
                        method: request.method,
                        path: request.rawTarget,
                        bodyLength: request.bodyLength,
                        body: rawBody,
                        bodySha256: request.bodySha256,
                        model: parsedBody?.model ?? null,
                        messageCount: Array.isArray(parsedBody?.messages) ? parsedBody.messages.length : null,
                    };
                });
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!report.requestArrived) {
            report.failure = report.failure ?? 'no provider request arrived within 20s';
        }
    }
} catch (error) {
    report.failure = String(error.message ?? error);
} finally {
    if (browser) {
        await browser.close();
    }
    server?.kill();
    mock?.kill();
    await streamingPeer?.close();
    // The scratch directory holds a built binary and a mock binary -- about 78 MB per run, and
    // twenty-nine abandoned copies of it filled the disk to 0.09 GB free, which then failed an
    // unrelated `go build` inside a differential with "not enough space on the disk". Clean up by
    // default; GOTAVERN_KEEP_TEMP=1 keeps it when a failed run needs its artifacts.
    if (process.env.GOTAVERN_KEEP_TEMP !== '1') {
        // Retries, because Windows keeps the just-killed binaries' handles open for a moment: the
        // first attempt after SIGKILL fails with EBUSY and an unconditional catch would hide it,
        // which is how twenty-nine copies accumulated without anything reporting a problem.
        await new Promise(resolve => setTimeout(resolve, 300));
        await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(error => {
            console.error(`probe: could not remove ${dataRoot}: ${error.message}`);
        });
    }
}

const reportPath = path.resolve(process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : path.join(repoRoot, 'tests', 'browser', 'generation-probe-report.json'));
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exit(0);
