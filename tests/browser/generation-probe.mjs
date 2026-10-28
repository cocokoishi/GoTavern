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
// arrived and what shape it had. It does NOT assert a boundary, a count, or a prompt shape --
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
import { PEER_CIRCUIT, sourceFor } from './sources.mjs';
import { PRESET_FIXTURE, applyPresetKit, applyAuthorsNoteOverlay, authorsNoteOverlaySpec, presetSpec, resolveAuthorsNoteCase } from './preset-kit.mjs';
import { HOP_MODES, loopbackUpstream, startStreamingHop } from './streaming-framing.mjs';

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
//
// THE SOURCE IS A CATALOG ENTRY NOW, NOT A NAME THIS FILE KNOWS. Everything below that used to be a
// per-source `if` -- the protocol, the scripted /models count, the peer circuit, the seam env vars, the
// redirect origin, the model setting, the key field, the connect preconditions -- is read from
// tests/browser/sources.mjs, which is DRIVER-ONLY by contract. Adding a source must not need an edit here.
const probeSource = process.env.PROBE_SOURCE ?? 'custom';
const source = sourceFor(probeSource);
const peerProtocol = source.probe.peer.protocol;
// HOW MANY MODEL-LIST ANSWERS THE POSITIONAL SCRIPT CARRIES. Only the scripted circuit consumes them;
// a request-keyed peer answers by REQUEST and needs no count at all (which is why most sources use it).
const scriptedModelAnswers = source.probe.peer.circuit === PEER_CIRCUIT.SCRIPTED ? source.probe.peer.scriptedModelsAnswers : 0;
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
        // HOW MANY STATUS CALLS THE DRIVE MAKES IS THE SOURCE'S OWN BUSINESS, and a fresh pinned page
        // asks for the model list more than once (openai.js:6097 at settings load and :6963 after
        // connect). The script is SEQUENTIAL, so ONE models entry is consumed by the first call and the
        // second receives the COMPLETION body, which no model renderer can read: measured on the groq
        // pinned leg, onlineStatus ended "no_connection", the peer was never asked for a completion, and
        // the send was silently refused -- while the GoTavern leg, which asks once, sent fine.
        // SCOPE MATTERS: the script is sequential, so an extra entry shifts every LATER response, which
        // is exactly why the count is a per-source CATALOG FIELD and not a shared constant.
        ...Array.from({ length: scriptedModelAnswers }, () => ({
            status: 200,
            headers: [{ name: 'Content-Type', value: 'application/json' }],
            body: JSON.stringify({ data: [{ id: 'probe-model' }] }),
        })),

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
// (cmd/gotavern/main.go), and tokenizer routes look for <InstallRoot>/src/tokenizers. This probe builds
// the binary into a scratch directory, so without this the server silently takes the pinned
// fallback path (guesstimate counts, empty ids) and the two legs cannot be compared on token counts
// at all. A release puts the tree at `src/tokenizers/` -- the pinned SillyTavern layout, and the copy the
// runtime prefers -- so stage THAT layout rather than changing production code to make a probe work.
if (!external) {
    const tokenizerSource = path.join(repoRoot, 'upstream', 'tokenizers');
    // BESIDE THE BINARY THAT ACTUALLY RUNS, which is not always the one this probe builds. When
    // GOTAVERN_BINARY supplies a lane artifact, `dataRoot` is NOT its install root, so staging there left
    // the server with no tokenizer tree and every count route answered the GUESSTIMATE fallback
    // (ceil(bytes/3.35)) instead of tokenizing: `[{content:'probe user marker'}]` came back as 10 and the
    // role-ful body as 15, which are exactly those byte-lengths divided by 3.35, while pinned answered
    // 9 and 10. That is the failure this comment block already describes, one level down: the probe
    // staged the release layout faithfully for a binary it had just built and not for one it was handed.
    const tokenizerTarget = path.join(path.dirname(binary), 'src', 'tokenizers');
    if (await fs.stat(tokenizerSource).then(() => true, () => false)) {
        await fs.mkdir(path.join(path.dirname(binary), 'src'), { recursive: true });
        await fs.cp(tokenizerSource, tokenizerTarget, { recursive: true });
    } else {
        throw new Error(`tokenizer assets missing at ${tokenizerSource}; a release layout must stage them at <install root>/src/tokenizers`);
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
// ABORT MODE (Q19, the mid-stream network close). Same peer, same paced frames, same drive as `stream`
// -- the difference is in the NETWORK and in the CALLER, and both are named here rather than inferred:
//   * the network: the page reaches the peer through the framing proxy in `cut` mode, which releases
//     only the first N bytes of the upstream body and then closes both sockets. The peer stays healthy
//     and writes its whole script, so the reply the subject RECEIVED is a strict prefix of the reply it
//     receives in `stream` mode;
//   * the caller: the page is NEVER asked to stop. The frontend has to notice a dead stream by itself,
//     which is the half `cancel` mode cannot measure because there the user pressed the stop button.
// The two halves are recorded separately (`networkClose` from the proxy, `streamState` from the page) so
// "the network died" and "the page gave up" can never be confused for one another.
const abortMode = probeMode === 'abort';
const streamingModeOrAbort = streamingMode || abortMode;
// A HOP BETWEEN THE SUBJECT AND THE PEER. `PROBE_NETWORK_HOP=cut` puts the framing hop in front of the
// peer in its cutting mode, `pass-through` in its control mode; anything else leaves the page talking to
// the peer directly, which is what every earlier artefact recorded. The mode is applied to whichever
// address the leg would otherwise use, so the drive code is untouched: only the network underneath it
// changes, which is the whole point of the gate.
//
// THE `buffer` MODE IS DELETED, and the deletion is a measurement rather than a simplification. A hop that
// releases the whole body in one write does not slow a streaming server down: in ONE release the page
// reads everything, the pinned SSE reader yields every frame in that same tick, and incremental render is
// lost on BOTH subjects for reasons that have nothing to do with either server's flushing (measured, run
// 40299346339: 2 content states on GoTavern, 1 on pinned). A mode whose difference is the browser's commit
// schedule cannot support a claim about a subject, so it is gone rather than dressed up. See
// tests/browser/streaming-framing.mjs for the full reasoning.
const hopModeSetting = process.env.PROBE_NETWORK_HOP ?? '';
const hopMode = hopModeSetting === HOP_MODES.CUT || hopModeSetting === HOP_MODES.CUT_AT_HEAD || hopModeSetting === HOP_MODES.PASS_THROUGH
    ? hopModeSetting
    : null;
if (hopModeSetting && !hopMode) {
    throw new Error(`PROBE_NETWORK_HOP must be "${HOP_MODES.CUT}" or "${HOP_MODES.PASS_THROUGH}" (or unset), got ${JSON.stringify(hopModeSetting)}: an unrecognised value would silently measure the direct connection while the artefact claimed a hop`);
}
// THE CUT POINT IS THE PEER'S OWN FRAMING, NOT A BYTE COUNT PICKED HERE. The peer writes
// `data: {...}\n\n`; cutting "after N bytes" would land mid-payload on one protocol and mid-frame on
// another. So the probe learns the frame length from the peer's OWN encoder and cuts at the END of a
// frame, which makes the required observation exact: the subject receives at least one complete content
// frame (so a render must start) and strictly fewer than were written (so the stream cannot finish).
const cutAfterFrames = Number(process.env.PROBE_CUT_AFTER_FRAMES ?? 2);

// PRESET MODE: the complex-preset differential (AGENTS.md rules 8 and 9).
//
// The drive is the ordinary non-streaming custom-source send, except that the page is given the
// COMPLEX preset captured from the pinned frontend (tests/browser/fixtures/preset-complex-settings.json,
// produced by capture-preset.mjs) and one of the two measured context boundaries:
//
//   PROBE_PRESET_VARIANT=keep  -- openai_max_context is the smallest value at which the pinned frontend
//                                 keeps the OLDEST history turn;
//   PROBE_PRESET_VARIANT=drop  -- that value minus one, at which the pinned frontend drops it.
//
// Both numbers are pinned observations of the pinned trimmer (bisected in capture-preset.mjs), so the
// pair is a real boundary rather than a number derived from GoTavern's own count. If GoTavern counts a
// message differently, its trimmer keeps a different SET of messages and the comparison says which
// message index differs.
//
// THE FIXTURE IS REQUIRED, NOT OPTIONAL. Without it there is no preset to drive and no boundary to
// bind, and a silent fall back to the simple captured configuration would produce an artefact that
// looks like the complex differential and is not (AGENTS.md rule 7). The probe therefore refuses.
const presetMode = probeMode === 'preset';
// Q17 -- THE AUTHOR'S NOTE DEPTH CASE THIS LEG DRIVES.
//
// `PROBE_AUTHORS_NOTE_CASE=<id>` selects one case from `authorsNoteOverlaySpec()` (tests/browser/
// preset-kit.mjs), whose numbers are resolved HERE and passed into the page as data, exactly like the
// preset spec. The case list is one list; a leg cannot drive a case the preparation drive did not
// measure, because both call `resolveAuthorsNoteCase` on the same spec.
//
// THE OVERLAY NEEDS THE PRESET'S CONTEXT (its world-info entries, its long history, its budget), which is
// why it is an overlay on preset mode rather than a second mode: a note injected into an empty chat could
// not tell depth 0 from depth 6, and Q17 is a positional question.
const authorsNoteCaseId = (process.env.PROBE_AUTHORS_NOTE_CASE ?? '').trim();
const authorsNoteOverlayCase = authorsNoteCaseId
    ? resolveAuthorsNoteCase(authorsNoteOverlaySpec(), authorsNoteCaseId)
    : null;
if (authorsNoteCaseId && !presetMode) {
    throw new Error(`PROBE_AUTHORS_NOTE_CASE=${JSON.stringify(authorsNoteCaseId)} needs PROBE_MODE=preset: the note's depth is only observable against the preset's history, world info and budget`);
}
const presetVariant = process.env.PROBE_PRESET_VARIANT ?? 'keep';
let presetFixture = null;
if (presetMode) {
    if (!['keep', 'drop'].includes(presetVariant)) {
        throw new Error(`PROBE_PRESET_VARIANT must be "keep" or "drop", got ${JSON.stringify(presetVariant)}`);
    }
    try {
        presetFixture = JSON.parse(await fs.readFile(PRESET_FIXTURE, 'utf8'));
    } catch (error) {
        throw new Error(`preset mode needs ${PRESET_FIXTURE}: ${error.message}. Run capture-preset.mjs against the pinned leg first (the browser-differential workflow does this in its capture step).`);
    }
    const boundary = presetFixture?.capture?.boundary ?? {};
    if (!Number.isInteger(boundary.keepContext) || !Number.isInteger(boundary.dropContext)) {
        throw new Error(`${PRESET_FIXTURE} records no boundary pair (keepContext/dropContext); the capture did not bind the context budget, so there is no differential to run`);
    }
    const anchor = presetFixture?.capture?.tokenizerAnchor?.observed?.count ?? null;
    if (anchor !== presetFixture?.capture?.tokenizerAnchor?.pinnedCount) {
        throw new Error(`${PRESET_FIXTURE} recorded a tokenizer anchor of ${JSON.stringify(anchor)} at capture time, not the pinned ${presetFixture?.capture?.tokenizerAnchor?.pinnedCount}: a server that does not tokenize cannot host a context-boundary differential`);
    }
}
// WHICH TOKENIZER TREE THIS LEG WOULD USE, recorded from the filesystem rather than inferred. The
// routes answer a Guesstimate (or 0) when no tree resolves and keep answering 200, so a missing tree
// is invisible in the response and would make the whole boundary meaningless. `src/tokenizers` is the
// pinned AND release layout; `tokenizers/` and `upstream/tokenizers` are fallbacks (internal/server/
// tokenizers.go:120-129). The pinned leg is reported as `external`, because its tree lives in the
// reference checkout rather than beside a binary this probe staged.
async function tokenizerRootEvidence() {
    const target = external ? process.env.GOTAVERN_REFERENCE ?? null : path.dirname(binary);
    const candidates = external
        ? [target ? path.join(target, 'src', 'tokenizers') : null].filter(Boolean)
        : ['src', 'tokenizers', 'upstream'].map(prefix => (prefix === 'tokenizers'
            ? path.join(target, 'tokenizers')
            : path.join(target, prefix, 'tokenizers')));
    const observed = [];
    for (const candidate of candidates) {
        const present = await fs.stat(candidate).then(info => info.isDirectory(), () => false);
        const files = present ? (await fs.readdir(candidate).catch(() => [])).length : 0;
        observed.push({ root: path.basename(path.dirname(candidate)) === 'src' ? 'src/tokenizers' : path.relative(target, candidate).split(path.sep).join('/'), present, entries: files });
    }
    const resolved = observed.find(candidate => candidate.present && candidate.entries > 0) ?? null;
    return { leg: external ? 'pinned' : 'gotavern', target, resolved: resolved?.root ?? null, candidates: observed };
}
const tokenizerRoot = await tokenizerRootEvidence();

function startStreamingPeer(mode, protocol) {
    // EVERY request the peer answered, with the status it gave: without this a drive that never
    // reaches a connected status cannot be told apart from one whose status call the peer answered, and
    // that indistinguishability has produced phantom defects on this project twice.
    const state = { requests: [], heldClosed: false, paths: [] };
    const server = http.createServer((request, response) => {
        const pathEntry = { method: request.method, path: request.url, status: null };
        state.paths.push(pathEntry);
        // `includes`, NOT `startsWith`, FOR THE MODEL LIST: cohere's status arm asks the /v1 base for
        // `/v1/models`, and a prefix test answered 404 -- the frontend never reached a connected
        // online_status and the send was silently refused, on a source whose Go arm is not in question.
        // Same lesson as the completion path and as workers_ai/pollinations/fireworks, one level over.
        if (request.method === 'GET' && request.url.includes('/models')) {
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
        // COHERE'S COMPLETION ROUTE IS `/v2/chat`, not `/chat/completions` (Cohere's v2 API), so a peer that
        // keyed on the OpenAI path name answered a correct request 404 and the recorded failure read as a
        // product one. The predicate admits either shape and the peer's own path log still shows exactly
        // which one arrived, so nothing is inferred.
        if (request.method !== 'POST' || !(request.url.includes(completionPath) || request.url.includes('/chat'))) {
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
                // THE HEADERS, so the report can record the FRAMING (names and the computed
                // content-length). The reporter below copies NAMES and the content-length only -- no
                // header value ever reaches a report, and the value that matters (authorization) is
                // reduced to a presence boolean. Without this the ai21 framing block was recorded as an
                // empty name list and a null length, which is why no committed artefact could have been
                // produced from a leg: run 40068803201's leg holds headerNames [] and
                // receivedContentLength null.
                headers: request.headers ?? {},
                bodyLength: body.length,
                bodySha256: createHash('sha256').update(body).digest('hex'),
                body: body.toString('utf8'),
                clientDisconnected: false,
                framesWritten: 0,
            };
            state.requests.push(entry);
            pathEntry.status = 200;
            if (mode === 'nonstream') {
                // A NON-STREAM COMPLETION, in the source's own protocol shape: the same body the scripted
                // provider would have returned, chosen by the REQUEST rather than by arrival order.
                const completion = protocol === 'anthropic'
                    ? { id: 'msg_probe', type: 'message', role: 'assistant', model: 'probe-model', content: [{ type: 'text', text: 'probe reply from anthropic' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 2 } }
                    : { id: 'probe-completion', object: 'chat.completion', created: 1, model: 'probe-model', choices: [{ index: 0, message: { role: 'assistant', content: 'probe reply' }, finish_reason: 'stop' }] };
                response.writeHead(200, { 'Content-Type': 'application/json' });
                response.end(JSON.stringify(completion));
                return;
            }
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
            // `abort` IS NOT `cancel` ON THE PEER'S SIDE. In cancel mode the peer holds the stream open
            // and waits for the caller to go away, because the subject under test is the page's stop
            // button. In abort mode the CALLER never stops: the network dies in the middle (the framing
            // proxy cuts) while the peer goes on writing its whole script. So the peer must NOT hold the
            // stream open, or it would be the peer that truncated the reply and the subject's behaviour
            // would be unobservable. It finishes normally, and the proxy decides what reaches the page.
            const holdOpen = mode === 'cancel';
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
                if (holdOpen) {
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
// THE PEER CIRCUIT COMES FROM THE CATALOG. A source that needs more than one status answer, or any
// streamed/cancelled drive, is served by the in-process peer that answers by REQUEST: it needs no
// per-source count at all, which is why the whole class moved to it rather than each source keeping
// its own entries in a positional script.
const useInProcessPeer = streamingModeOrAbort || source.probe.peer.circuit === PEER_CIRCUIT.REQUEST_KEYED;
if (useInProcessPeer) {
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

// THE BYTE COUNT THAT ENDS A FRAME. `cutAfterBytes` is resolved per protocol from the peer's own frame
// encoding, so the cut lands on a FRAME boundary rather than inside a JSON payload: the required
// observation then becomes a COUNT of complete frames the subject received, and neither chunk coalescing
// nor a proxy padding decision can move it.
function framesToBytes(frames, protocol) {
    const sample = protocol === 'anthropic'
        ? `event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } })}\n\n`
        : `data: ${JSON.stringify({
            id: 'chatcmpl-probe', object: 'chat.completion.chunk', created: 1, model: 'probe-model',
            choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
        })}\n\n`;
    return Buffer.byteLength(sample, 'utf8') * frames;
}
const cutAfterBytes = abortMode && (hopMode === HOP_MODES.CUT || hopMode === HOP_MODES.CUT_AT_HEAD) ? framesToBytes(cutAfterFrames, peerProtocol) : 0;
// THE HOP GOES IN FRONT OF THE PEER, BEFORE ANYTHING IS AIMED AT IT. Every aim step below reads
// `mockAddress` -- the seams, the redirect file and the page's own custom_url/reverse_proxy -- so one
// reassignment moves the whole leg behind the hop and there is no second place the peer's address is
// spelled. Nothing about the drive changes; only the network underneath it does.
//
// THE CUT IS ARMED ONLY ON THE COMPLETION ROUTE, and it is named HERE (by the same `protocol` fact that
// builds the peer) rather than guessed by the hop: a hop that cut the frontend's own GET /models would
// truncate the reachability check and the drive would never reach a connected state (measured in the first
// draft: both subjects ended with `in flight: 1` and no stream at all).
const cutArmOnPath = peerProtocol === 'anthropic' ? '/messages' : '/chat/completions';
const proxy = hopMode ? await startStreamingHop({
    upstream: loopbackUpstream(mockAddress),
    mode: hopMode,
    cutAfterBytes,
    cutArmOnPath,
}) : null;
if (proxy) {
    mockAddress = proxy.address;
    console.log(`[hop] ${hopMode} ${proxy.address} -> ${streamingPeer ? streamingPeer.address : 'the scripted peer'}${hopMode === HOP_MODES.CUT ? ` (cut on ${cutArmOnPath} after ${cutAfterBytes} B = ${cutAfterFrames} frames)` : ''}`);
}

// AIM THE LEGS AT THE PEER IN BOTH MODES, FROM THE CATALOG.
//
// This block used to be a dozen `if (probeSource === 'x') { process.env.GOTAVERN_X_CHAT_URL = ... }`
// statements followed by a dozen redirect writes: two lists that had to agree with each other, with the
// Go arm and with the pinned literal, and that had ALREADY drifted (openai and openrouter had a seam but
// no entry in the recorded seam map, and claude/mistralai had neither). Both lists now come from
// `probe.seams` and `probe.redirectFrom` on the catalog entry, so a source cannot be half-aimed.
//
// WHY BOTH MECHANISMS ARE SET FOR A PROXY-CAPABLE SOURCE: the request member (custom_url /
// reverse_proxy) is the ROUTE a user takes, and the seam plus the transport redirect are SAFETY NETS --
// they exist so that a leg which stopped honouring the member cannot reach the real provider. Setting
// them is what makes the recorded claim true rather than prose: claude and mistralai artifacts said
// "seam aimed as a safety net" while nothing aimed it (AGENTS verification rule 14: a probe must not be
// able to reach the live network).
for (const seam of source.probe.seams) {
    if (!external) {
        process.env[seam.env] = `http://${mockAddress}${seam.suffix}`;
    }
}
// The PINNED leg reaches the same peer through the loader hook tools/run-against-pinned.mjs installs when
// this file is named: the hook re-reads the mapping per request, which is why it can be written only now
// that the peer has an address. A source whose redirect list is empty carries the peer in the request and
// needs no redirect; anything else would be a leg that can reach the real provider.
const redirectFile = process.env.PROBE_PINNED_REDIRECT_FILE;
if (external && redirectFile && source.probe.redirectFrom.length > 0) {
    await fs.writeFile(redirectFile, JSON.stringify(source.probe.redirectFrom.map(origin => ({ from: origin, to: `http://${mockAddress}` }))));
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
    // Present only in preset mode, so no other mode's report changes shape.
    ...(presetMode ? { preset: null, tokenizerRoot } : {}),
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
    // THE DRIVE PLAN, DERIVED FROM THE CATALOG AND PASSED INTO THE PAGE AS DATA.
    //
    // Everything the page-side drive used to decide with `if (probeSource === ...)` is here instead:
    // which setting names the model, which control a user sets, whether the peer travels in reverse_proxy
    // or custom_url, which secret slot and which key field. The page applies the plan generically, so a
    // new source is a catalog row rather than a branch in a function that also drives every other source.
    const plan = {
        source: source.id,
        browserSource: source.browserSource,
        secretKey: source.probe.secretKey,
        keySelector: source.probe.keySelector,
        modelSetting: source.probe.modelSetting,
        modelControl: source.probe.modelControl,
        reverseProxy: source.probe.reverseProxy,
        customUrl: source.probe.customUrl,
        expectsModelsCall: source.probe.expectsModelsCall,
        noValidate: source.probe.noValidate,
    };
    const modelControlRecords = plan.modelControl ? [plan.modelControl.record] : [];
    // THE PRESET KIT IS INSTALLED, NOT RE-DEFINED. `page.evaluate` cannot pass a function as an
    // argument, and the scenario has exactly one definition (preset-kit.mjs) shared with the capture
    // run: it is injected as a page global and called from inside the drive below.
    if (presetMode) {
        await page.addScriptTag({ content: `globalThis.__applyPresetKit = (${applyPresetKit.toString()});` });
        // Q17's overlay is installed the same way and for the same reason: ONE definition, shared by the
        // pinned preparation drive and by both compared legs, so the oracle and the subject cannot be
        // handed two different scenarios.
        await page.addScriptTag({ content: `globalThis.__applyAuthorsNoteOverlay = (${applyAuthorsNoteOverlay.toString()});` });
        // THE RESOLVED CASE IS INSTALLED AS DATA, the same way the preset spec is: the drive reads it, and
        // the pre-send re-apply inside the page uses the same object, so "the case the drive chose" and
        // "the case re-applied immediately before the click" cannot be two different readings of the env.
        if (authorsNoteOverlayCase) {
            await page.addScriptTag({ content: `globalThis.__authorsNoteOverlayCase = ${JSON.stringify(authorsNoteOverlayCase)};` });
        }
    }
    const outcome = await page.evaluate(async ({ mockUrl, probeMode, probeSource, plan, presetSpec, presetVariant, presetBoundary, presetAnchor, presetContextOverride }) => {
    const streaming = probeMode === 'stream' || probeMode === 'cancel' || probeMode === 'abort';
        // Faithful drive: load and select a character through the frontend's OWN functions, then send
        // through the UI button. The earlier version pushed into a temporary chat and called
        // Generate() with the frontend already mid-operation and no character bound, which a user
        // cannot do; it short-circuited on a guard and reported "no request" with no error.
        const script = await import('./script.js');
        const { oai_settings } = await import('./scripts/openai.js');
        const secretsModule = await import('./scripts/secrets.js');
        // The key goes in the source's own secret slot: a user would paste one, and the connect
        // handler refuses a source with no secret in secret_state. WHICH slot is a catalog fact
        // (plan.secretKey names a SECRET_KEYS member), so this file no longer carries a map.
        await secretsModule.writeSecret(secretsModule.SECRET_KEYS[plan.secretKey], 'probe-synthetic-key');

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
        // assigned AFTER it: without this, an openrouter run would silently be a custom run.
        oai_settings.chat_completion_source = probeSource;
        // HOW THIS SOURCE IS POINTED AT THE PEER AND WHICH MODEL IT SELECTS -- three catalog facts, applied
        // generically. Every `else if (probeSource === ...)` that used to sit here was a copy of the same
        // two lines (a model setting, and whether the peer travels in reverse_proxy or custom_url), and the
        // copies had drifted: the probe's list and the comparator's prose did not agree about which sources
        // carry a proxy credential.
        //
        // The rule the catalog encodes, which a user can also follow: a proxy-capable source is driven
        // through the frontend's own `reverse_proxy` setting (so the peer address travels the way a user's
        // endpoint would and BOTH legs follow it); a `proxy: false` source has that control at all, so its
        // peer arrives by seam + transport redirect instead and proxyPasswordPresent stays false.
        if (plan.modelSetting) {
            oai_settings[plan.modelSetting] = 'probe-model';
        }
        if (plan.reverseProxy) {
            oai_settings.reverse_proxy = mockUrl;
        }
        if (plan.customUrl) {
            oai_settings.custom_url = mockUrl;
        }
        // A BODY-DERIVED HOST IS DRIVEN THROUGH THE FRONTEND'S OWN CONTROL, GENERICALLY: the drive selects
        // the control's OWN default option (never an invented value) and records what it drove, so an
        // artifact that does not say which host it measured cannot be produced.
        if (plan.modelControl) {
            const control = document.querySelector(plan.modelControl.selector);
            if (!control) {
                return { status: 'not-driven', reason: `no ${plan.modelControl.selector} control in the served frontend` };
            }
            const options = [...control.options].map(option => option.value);
            const selected = control.options[control.selectedIndex]?.value ?? null;
            control.value = selected ?? options[0] ?? '';
            control.dispatchEvent(new Event('input', { bubbles: true }));
            globalThis[plan.modelControl.record] = {
                mode: selected ?? options[0] ?? null,
                available: options,
                control: plan.modelControl.selector,
                via: 'input event',
            };
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

        // THE COMPLEX PRESET. Applied HERE rather than before the drive because `promptManager` exists
        // only after settings load (initOpenAI), and the character and chat must be in place before the
        // kit writes them. Everything it touches is a frontend module the UI itself uses. The kit returns
        // a named list of anything that did not take, and the drive REFUSES to send on a half-applied
        // preset: a preset that silently shrank would be a smaller differential wearing a complex one's
        // name (AGENTS.md rule 7).
        let presetApplied = null;
        if (presetSpec && presetBoundary) {
            const kit = await globalThis.__applyPresetKit(presetSpec);
            // THE CONTEXT MAY BE MEASURED, NOT INHERITED. `presetContextOverride` is the context a boundary
            // search is probing. The legs the differential compares are driven WITH an explicit override,
            // so the context they run at is the one the PINNED LEG ITSELF was measured at.
            const maxContext = Number.isInteger(presetContextOverride) && presetContextOverride > 0
                ? presetContextOverride
                : (presetVariant === 'drop' ? presetBoundary.dropContext : presetBoundary.keepContext);
            // UNLOCK THE SLIDER BEFORE SETTING IT. With `max_context_unlocked` false the frontend clamps
            // `openai_max_context` to the model select's `max` attribute whenever a model change fires
            // (openai.js:5701), and that clamp lands AFTER this assignment -- silently replacing the
            // measured budget with the same value for BOTH variants. That is the defect behind run
            // 40073821604: keep and drop both assembled the DROP shape (11 history turns, oldest turn
            // absent) while the artefact recorded the keep boundary.
            oai_settings.max_context_unlocked = true;
            oai_settings.openai_max_context = maxContext;
            // Non-streaming on every variant: the compared object is the provider's REQUEST, and a
            // streamed leg would make this artefact about framing rather than about prompt assembly.
            oai_settings.stream_openai = false;
            // ASSERT THE VALUE STUCK, BY NAME. A budget the frontend quietly replaced is a differential
            // that measures the wrong thing on both legs, which reads exactly like "the product agrees"
            // (AGENTS verification rule 10). Read repeatedly, because the panel handlers settle
            // asynchronously and a one-shot read can catch the value before a clamp lands.
            let appliedContext = Number(oai_settings.openai_max_context);
            for (let attempt = 0; attempt < 20 && appliedContext !== maxContext; attempt++) {
                await new Promise(resolve => setTimeout(resolve, 50));
                appliedContext = Number(oai_settings.openai_max_context);
            }
            const contextProblems = [];
            if (appliedContext !== maxContext) {
                contextProblems.push(`openai_max_context settled at ${JSON.stringify(appliedContext)} after the drive set ${JSON.stringify(maxContext)} for the ${presetVariant} variant, so this leg did not run at the measured boundary and the variants would not be distinguishable`);
            }
            // THE TOKENIZER ANCHOR, ASKED OF THE SERVER THIS LEG IS DRIVING. A fixed body whose pinned
            // count is 7 (tests/oracle/sillytavern-1.19.0-tokenizers.json, openai/count#llama#simple);
            // a server on the Guesstimate path answers a different number, which is how this lane
            // refuses to compare token counts that are not counts.
            let tokenizerAnchor = null;
            if (presetAnchor) {
                let count = null;
                let status = null;
                // THE POST NEEDS THE CSRF TOKEN (run 40073802369 answered 403 to a plain fetch). The
                // frontend's own header helper is how every panel request authenticates, on BOTH legs.
                const anchorHeaders = script.getRequestHeaders();
                try {
                    const response = await fetch(`/api/tokenizers/openai/count?model=${encodeURIComponent(presetAnchor.model)}`, {
                        method: 'POST',
                        headers: anchorHeaders,
                        body: JSON.stringify(presetAnchor.body),
                    });
                    status = response.status;
                    count = Number((await response.json())?.token_count);
                } catch (error) {
                    tokenizerAnchor = { model: presetAnchor.model, status, count: null, pinnedCount: presetAnchor.pinnedCount, error: String(error?.message ?? error).slice(0, 160) };
                }
                tokenizerAnchor = tokenizerAnchor ?? {
                    model: presetAnchor.model,
                    status,
                    count,
                    pinnedCount: presetAnchor.pinnedCount,
                    csrfHeaderPresent: Object.keys(anchorHeaders).some(name => name.toLowerCase() === 'x-csrf-token'),
                };
            }
            presetApplied = {
                variant: presetVariant,
                maxContext,
                // WHAT THE LEG ACTUALLY RAN AT, recorded next to what it was asked for: the comparator
                // asserts both against the fixture, so a clamped or replaced budget is named rather than
                // silently folded into "both legs agree".
                maxContextApplied: appliedContext,
                maxContextUnlocked: Boolean(oai_settings.max_context_unlocked),
                boundary: {
                    keepContext: presetBoundary.keepContext,
                    dropContext: presetBoundary.dropContext,
                    keepMessages: presetBoundary.keepMessages,
                    dropMessages: presetBoundary.dropMessages,
                },
                typedMessage: presetSpec.send ?? null,
                chatTurns: kit.chatTurns ?? null,
                steps: kit.steps ?? [],
                problems: [...(kit.problems ?? []), ...contextProblems],
                tokenizerAnchor,
                settings: {
                    openai_max_context: oai_settings.openai_max_context,
                    openai_max_tokens: oai_settings.openai_max_tokens,
                    temp_openai: oai_settings.temp_openai,
                    top_p_openai: oai_settings.top_p_openai,
                    pres_openai: oai_settings.pres_openai,
                    freq_openai: oai_settings.freq_openai,
                    names_behavior: oai_settings.names_behavior,
                    stream_openai: oai_settings.stream_openai,
                },
            };
            if (presetApplied.problems.length > 0) {
                return {
                    preconditions: { charactersLoaded: true, settingsReady: true, presetApplied },
                    presetApplied,
                    error: `the complex preset did not apply: ${presetApplied.problems.join('; ')}`,
                };
            }
        }

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
        // WHICH KEY FIELD THIS DRIVE TYPES, from the catalog. A null selector is a fact worth recording
        // rather than a gap: several sources have a per-source key input the connect handler does not
        // require, and typing a field the product does not offer would be a state a user cannot reach.
        const sourceKeySelector = plan.keySelector;
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
        // NO-VALIDATE SOURCES (openai.js:4459 `getStatusOpen`). For these the page sets a STATUS MESSAGE
        // ("Key saved; press \"Test Message\" to verify.") and returns BEFORE the status route is called,
        // so a drive that waits for a connected online_status waits for a state a user of these sources
        // never reaches. Assert the state the page DOES reach and record its text; a real user's only
        // verification is the first message, so the drive sends. WHICH sources are in that list is a
        // catalog fact (plan.noValidate) -- the same list, but no longer a second copy of it here.
        const noValidate = plan.noValidate === true;
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
            // The typed text is the scenario's own marker in preset mode: the capture appended the SAME
            // message to the chat before it bisected the boundary, so the assembled list this send
            // produces is the list the boundary was measured against.
            composer.value = presetSpec?.send ?? 'probe user marker';
            composer.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const sendButton = document.querySelector('#send_but');
        // ---------------------------------------------------------------------------------------
        // Q17 -- THE AUTHOR'S NOTE OVERLAY, APPLIED HERE AND OBSERVED IN THE REQUEST.
        //
        // WHY IT IS APPLIED AT THIS POINT AND NOT EARLIER: `Generate` re-derives the prompt injection
        // from `chat_metadata` + the DOM on EVERY assembly (`script.js:4619 setFloatingPrompt()`), so any
        // write made before the page settles can be overwritten by `loadSettings()` inside a debounced
        // panel handler. Applying it after the composer is typed and before the quiescence wait means the
        // send assembles the state this drive chose, and the state is recorded beside the request.
        //
        // THE RESULT IS ASSERTED, NOT ASSUMED: if the case does not reach `extension_prompts` the drive
        // REFUSES to send (a note that silently stayed the preset's would produce a green comparison of
        // the wrong scenario, which is rule 7's shape).
        let authorsNoteApplied = null;
        if (globalThis.__authorsNoteOverlayCase && typeof globalThis.__applyAuthorsNoteOverlay === 'function') {
            const overlayResult = await globalThis.__applyAuthorsNoteOverlay(globalThis.__authorsNoteOverlayCase);
            authorsNoteApplied = overlayResult?.applied ?? null;
            const overlayProblems = [...(overlayResult?.problems ?? [])];
            // The interval-0 case is the product's OWN disable switch: `setFloatingPrompt` writes
            // position NONE rather than a value (authors-note.js:351-356), so "the note is empty in
            // extension_prompts" is the positive expectation there and a problem everywhere else.
            const disabledByProduct = globalThis.__authorsNoteOverlayCase.enabled === false;
            const state = authorsNoteApplied?.extensionPrompt ?? null;
            const statePosition = Number(state?.position ?? NaN);
            const notePresent = Boolean(String(state?.value ?? ''));
            if (disabledByProduct) {
                if (statePosition !== -1 && notePresent) {
                    overlayProblems.push(`the disable case left position ${JSON.stringify(state?.position)} carrying a value; the product disables a note by writing position NONE (-1) with the text cleared (authors-note.js:351-356), so the case did not disable anything`);
                }
            } else if (!notePresent || !String(state?.value ?? '').includes(globalThis.__authorsNoteOverlayCase.text)) {
                overlayProblems.push(`the note did not reach extension_prompts["2_floating_prompt"]: got ${JSON.stringify(state?.value ?? null)} at position ${JSON.stringify(state?.position ?? null)}`);
            }
            if (globalThis.__authorsNoteOverlayCase.depth !== null && !disabledByProduct) {
                const wanted = Number(globalThis.__authorsNoteOverlayCase.depth);
                if (Number(state?.depth ?? NaN) !== wanted) {
                    overlayProblems.push(`the note's injected depth is ${JSON.stringify(state?.depth ?? null)}, not the ${wanted} this case asked for, so the depth under test is not the depth the request will carry`);
                }
            }
            if (overlayProblems.length > 0) {
                return {
                    preconditions: { charactersLoaded: true, settingsReady: true, authorsNoteOverlay: authorsNoteApplied },
                    authorsNoteOverlay: { requested: globalThis.__authorsNoteOverlayCase, applied: authorsNoteApplied, problems: overlayProblems },
                    error: `the author's note overlay did not apply: ${overlayProblems.join('; ')}`,
                };
            }
            authorsNoteApplied = { ...authorsNoteApplied, problems: overlayProblems, requested: globalThis.__authorsNoteOverlayCase };
            globalThis.__probeAuthorsNoteOverlay = authorsNoteApplied;
        }
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
        // THE ABORT SURFACE'S OWN RECORDER, INSTALLED BEFORE THE SEND.
        //
        // It is READ in two places and was ASSIGNED in none: the settle predicate below (`renderStates:
        // (globalThis.__probeAbortRecorder?.renderStates ?? []).length`) and the node-side observation
        // after the drive returned. Because nothing created it, the settle loop compared the length of a
        // list that did not exist -- always 0 -- so the quiet state was rejected forever and both
        // subjects reported `the page did not settle within 60s` with `renderStates: 0`. That number was
        // not a measurement of the page; it was the absence of one. Measured, `Browser differential`
        // 40629705640 (failure), step `Compare the streaming framing legs`.
        //
        // WHY IT LIVES HERE, INSIDE THIS `page.evaluate` AND BEFORE THE CLICK. This is the same
        // page-side, pre-send install point the in-flight counters (`:856`) and the pre-send preset
        // state (`:1589`) already use. A page handle does not exist inside the drive callback -- putting
        // an observation there failed on both legs with `page is not defined` (runs 40307148708,
        // 40310223649) -- so the recorder is created page-side and SURVIVES the callback, which is why
        // the node-side block can read it after the drive returns.
        //
        // IT ALIASES THE OBSERVATION THAT ALREADY EXISTS rather than sampling a second time: the
        // MutationObserver above already records every distinct rendered text into
        // `__probeRenderSnapshots`, and a second poll would disagree with it under exactly the timing
        // this surface is about. `ended` is the emit log's own completion/stop/error entries, filtered
        // here so the reader does not re-derive them.
        globalThis.__probeAbortRecorder = {
            get renderStates() {
                return globalThis.__probeRenderSnapshots ?? [];
            },
            get ended() {
                return (globalThis.__probeEmitLog ?? []).filter(entry => (
                    entry.name === 'GENERATION_ENDED'
                    || entry.name === 'GENERATION_STOPPED'
                    || entry.name === 'GENERATION_AFTER_COMMANDS'
                ));
            },
        };
        globalThis.__probeClickPerf = Math.round(performance.now());
        // THE PRE-SEND STATE, IN PRESET MODE, MEASURED IMMEDIATELY BEFORE THE CLICK.
        //
        // The comparator compares these against what the CAPTURE recorded for the same variant, because a
        // chat that already carries a previous send, or an assembly that has grown by messages the capture
        // did not have, makes the differential measure the harness's state instead of the frontend's
        // behaviour. Run 40087218275 is the case: the capture's own send at max_context 4253 assembled 24
        // messages with 12 history turns, while the drive at the SAME context assembled 26 with 11 -- same
        // server, same context, different state at send time.
        //
        // The dry assembly is recorded too, and it is what separates the two possible causes: if the DRY
        // assembly here already counts more messages than the capture measured, the page's prompt state
        // grew before the send; if it matches and only the sent request differs, the send path itself is
        // adding them.
        if (presetSpec) {
            const presetOpenAI = await import('./scripts/openai.js');
            const scriptForPresend = await import('./script.js');
            // RESTORE THE SCENARIO IMMEDIATELY BEFORE THE SEND, the same way the capture does before every
            // probe: the kit rebuilds the chat from the spec, re-writes the note and the world, and
            // re-asserts every step, so a page whose state drifted during the drive's own setup cannot
            // send from a different chat than the one the boundary was measured on.
            const presendReset = await globalThis.__applyPresetKit(presetSpec);
            const presendProblems = [...(presendReset?.problems ?? [])];
            // THE PRESET IDENTITY, RE-ASSERTED AFTER THE RESET AND IMMEDIATELY BEFORE THE CLICK.
            //
            // The reconcile pass above re-selects the character, and `autoSelectPreset`
            // (public/scripts/preset-manager.js:49-76) runs on CHAT_CHANGED and selects a preset NAMED AFTER
            // THE CHARACTER -- so the identity read after the first kit application is not necessarily the
            // identity that will assemble this send. Another lane measured that hook replacing a driver's
            // preset today; the read is repeated here, at the one point where a replacement would corrupt
            // exactly the request about to be produced.
            let presendPresetIdentity = null;
            try {
                const presetIdentityManager = scriptForPresend.getPresetManager?.();
                if (presetIdentityManager) {
                    const selectedName = presetIdentityManager.getSelectedPresetName?.() ?? null;
                    const characterName = String(scriptForPresend.characters?.[scriptForPresend.this_chid]?.name ?? '');
                    presendPresetIdentity = {
                        beforeClick: selectedName,
                        characterName,
                        matchesCharacter: selectedName !== null && characterName !== ''
                            && String(selectedName).trim() === characterName.trim(),
                    };
                    if (presendPresetIdentity.matchesCharacter) {
                        presendProblems.push(`autoSelectPreset fired before the click: the page reports preset ${JSON.stringify(selectedName)}, which IS the character's name, so this send would assemble a preset the leg did not choose`);
                    }
                } else {
                    presendPresetIdentity = { managerPresent: false };
                }
            } catch (error) {
                presendPresetIdentity = { error: String(error?.message ?? error).slice(0, 200) };
            }
            // Q17: THE OVERLAY IS RE-APPLIED AFTER THE RESET, for the same reason the reset exists --
            // `applyPresetKit` writes the PRESET'S author's note (depth 3, IN_CHAT), so a leg driven by
            // an overlay case would otherwise send the preset's note and record an overlay that never
            // took effect. The overlay is applied by the SAME function the drive used before the click.
            let presendOverlay = null;
            const overlayNow = globalThis.__authorsNoteOverlayCase ?? null;
            if (overlayNow && typeof globalThis.__applyAuthorsNoteOverlay === 'function') {
                presendOverlay = await globalThis.__applyAuthorsNoteOverlay(overlayNow);
                presendProblems.push(...(presendOverlay?.problems ?? []));
            }
            // RE-SELECTING THE CHARACTER MAY TOUCH THE COMPOSER, and a re-applied preset may start a
            // prompt-manager dry render: re-assert the outgoing text and let the page go idle again, so the
            // send starts from the same three values the capture recorded.
            const composerForPresend = document.querySelector('#send_textarea');
            if (composerForPresend && String(composerForPresend.value ?? '') !== String(presetSpec.send ?? '')) {
                composerForPresend.value = presetSpec.send ?? '';
                composerForPresend.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const presendIdleDeadline = performance.now() + 10000;
            while (performance.now() < presendIdleDeadline) {
                const idle = Boolean(scriptForPresend.isGenerating) === false && document.body.dataset.generating === undefined;
                if (idle) break;
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            let dryAssembly = null;
            try {
                const seenPresend = [];
                const presendHandler = data => seenPresend.push(data);
                scriptForPresend.eventSource.on(scriptForPresend.event_types.GENERATE_AFTER_DATA, presendHandler);
                await scriptForPresend.Generate('normal', {}, true);
                scriptForPresend.eventSource.removeListener(scriptForPresend.event_types.GENERATE_AFTER_DATA, presendHandler);
                const assembled = seenPresend.length ? seenPresend[seenPresend.length - 1]?.prompt : null;
                const list = Array.isArray(assembled) ? assembled : [];
                const text = message => {
                    const content = message?.content;
                    if (typeof content === 'string') return content;
                    if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
                    return '';
                };
                dryAssembly = {
                    messageCount: list.length,
                    historyMessages: list.filter(message => text(message).includes(presetSpec.markers.history)).length,
                    // Whether the OLDEST turn is still in this pre-send assembly, by the same marker the
                    // boundary uses.
                    oldestPresent: list.some(message => text(message).includes(String(presetSpec.history?.[0]?.text ?? '').slice(0, 40))),
                };
            } catch (error) {
                dryAssembly = { error: String(error?.message ?? error).slice(0, 200) };
            }
            globalThis.__probePresetPreSend = {
                chatTurns: scriptForPresend.chat.length,
                outgoingText: String(document.querySelector('#send_textarea')?.value ?? ''),
                contextApplied: Number(presetOpenAI.oai_settings.openai_max_context ?? NaN),
                resetProblems: presendProblems,
                // Q17/Q18: THE PRESET ACTUALLY IN EFFECT WHEN THIS SEND ASSEMBLES, with the character name it
                // was compared against. `matchesCharacter: true` would mean `autoSelectPreset` replaced the
                // preset with one named after the card, i.e. the comparison measured an input nobody chose.
                presetIdentity: presendPresetIdentity,
                // Q17: WHAT THE OVERLAY LEFT BEHIND IMMEDIATELY BEFORE THE CLICK, read from the same
                // metadata and `extension_prompts` entry the assembly reads. A leg whose note reverted to
                // the preset's is visible here instead of being inferred from a body that agrees for the
                // wrong reason.
                authorsNoteOverlay: overlayNow ? {
                    caseId: overlayNow.caseId ?? null,
                    requested: { depth: overlayNow.depth, position: overlayNow.position, interval: overlayNow.interval, role: overlayNow.role },
                    applied: presendOverlay?.applied ?? null,
                    extensionPrompt: scriptForPresend.extension_prompts?.['2_floating_prompt'] ?? null,
                } : null,
                dryAssembly,
            };
        }
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
            } else if (probeMode === 'abort') {
                // THE OBSERVATION IS TAKEN AFTER THE DRIVE RETURNS, OUTSIDE THE PAGE CONTEXT. See the
                // probeMode === 'abort' block below the settle: a page handle is not reachable from
                // inside this callback, and an earlier draft put it here, which is what made both
                // abort legs fail with 'page is not defined' (runs 40307148708 and 40310223649).
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
        // THE PAGE-SIDE PREDICATE, INSTALLED BEFORE THE SETTLE LOOP READS IT. `isGenerating` is a FUNCTION
        // over module state (`script.js:604`: is_send_press || is_group_generating), so it is CALLED, and it
        // is called from inside the page's own context -- a `page.evaluate` body cannot reach the outer
        // `page` object, which is how the first version of this failed on both legs at once.
        // A SURFACE WHOSE END IS AN ERROR SETTLES WHEN THE PAGE IS QUIET, NOT WHEN A COMPLETION LANDED.
        // On a mid-stream cut the pinned frontend ends the send through its own error path
        // (`StreamingProcessor.generate`'s catch -> `onErrorStreaming` -> `markUIGenStopped` ->
        // `unblockGeneration`, script.js:3812-3832/3617-3619), NOT through a normal completion -- so
        // `__probeCompletions` stays 0 by design and requiring one made the drive report a 60 s timeout
        // while the page had already stopped (measured, run 40299346339). The window therefore ends on the
        // state a user sees: `isGenerating()` false AND no stop button, held for the same 1500 ms the
        // completion path uses.
        const settleDeadline = settleStarted + 60000;
        let idleSince = null;
        let settleInFlight = null;
        let quietState = null;
        let quietSinceRenderChange = 0;
        while (performance.now() < settleDeadline) {
            settleInFlight = globalThis.__probeInFlight ?? 0;
            if (probeMode === 'abort') {
                // THE QUIET STATE, WITH NO IMPORT INSIDE THE LOOP, and the render count from the
                // page-side recorder so "nothing arrived after the cut" is a comparison of two states of
                // ONE recording rather than of two polls.
                const scriptModule = await import('./script.js');
                quietState = {
                    isGenerating: Boolean(scriptModule.isGenerating()),
                    generatingAttribute: document.body.dataset.generating ?? null,
                    stopButton: Boolean(document.querySelector('#mes_stop')),
                    sendButtonDisabled: Boolean(document.querySelector('#send_but')?.disabled),
                    renderStates: (globalThis.__probeAbortRecorder?.renderStates ?? []).length,
                };
                const quiet = !quietState.isGenerating && quietState.generatingAttribute === null && !quietState.stopButton;
                // THE WINDOW NEEDS THE QUIET STATE **AND** NO RENDER MOVEMENT FOR 1500 ms: a quiet moment
                // between two frames is not an end. Measured, run 40304606443, where a poll sampled the
                // in-operation state and the reply had already been saved and rendered before the next one.
                if (quiet) {
                    if (idleSince === null || quietState.renderStates !== quietSinceRenderChange) {
                        idleSince = performance.now();
                        quietSinceRenderChange = quietState.renderStates;
                    } else if (performance.now() - idleSince >= 1500) {
                        break;
                    }
                } else {
                    idleSince = null;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
                continue;
            }
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
        // THE TERMINAL STATE, NAMED. Seven outcomes this surface can reach, each decided from evidence
        // the harness already records rather than from waiting on a state that may be unreachable:
        //
        //   1 normal-completion      GENERATION_ENDED arrived and the page went quiet.
        //   2 client-abort           GENERATION_STOPPED, with a stop control that was actually clicked
        //                            (cancel mode only; this surface never clicks one).
        //   3 network-cut            the hop reports a cut of ITS OWN, by name, and the page stopped
        //                            moving afterwards -- the terminal a cut stream reaches.
        //   4 subject-crash          the page reported errors and never returned to idle.
        //   5 harness-failure        the drive never produced a request, or the page handle was lost.
        //   6 cut-evidence-timeout   the settle window expired BUT the abort evidence above WAS observed:
        //                            a named hop cut, at least one frame written, and a frozen render
        //                            count. This is the case the branch misreported as a drive failure.
        //   7 no-evidence-timeout    the window expired with nothing above. A real drive failure.
        //
        // STATE 6 IS ONLY REACHABLE FOR AN EXPECTED-ABORT LEG, and only when the cut is attributable to
        // the HOP rather than inferred from a quiet page. Every condition the other modes already used is
        // preserved untouched: the non-abort legs still settle on `completed && settleInFlight === 0`.
        const settledIdle = idleSince !== null && performance.now() - idleSince >= 1500;
        // THE PAGE REPORTS FACTS, NODE DECIDES THE STATE. Everything reachable from inside this
        // callback is page-side state; `proxy`, `streamingPeer` and `report` are NODE variables and a
        // `page.evaluate` body cannot see them -- reading them here failed on BOTH legs with
        // `ReferenceError: streamingPeer is not defined` / `proxy is not defined` (Browser differential
        // 40643109721), which is the same outer-handle defect this file records at L3-7. So the settle
        // block records WHAT IT OBSERVED, and the seven-state classification runs in node below.
        const stoppedEmitted = (globalThis.__probeEmitLog ?? []).some(entry => entry.name === 'GENERATION_STOPPED');
        globalThis.__probeSettle = {
            settledIdle,
            waitedMs: Math.round(performance.now() - settleStarted),
            completions: globalThis.__probeCompletions ?? 0,
            inFlightAtRead: settleInFlight,
            // PAGE-SIDE ONLY. The hop's cut evidence and the node-side classification are added below,
            // outside this callback, where proxy and report exist.
            endReason: 'settle-window-closed',
            stoppedEmitted,
            quietState,
        };
        // THE WINDOW DID NOT CLOSE, so the drive reports a timeout here. Whether that timeout is a
        // NAMED TERMINAL or a real failure is decided in node, where the hop evidence is visible;
        // this callback cannot see `proxy`, and must not guess.
        if (!settledIdle) {
            // THE TIMEOUT PATH MUST STILL PUBLISH WHAT IT OBSERVED. It previously returned only an
            // `error` string, so the abort leg's report carried NO `postSend` at all -- no
            // `renderSnapshots`, no `streamState`, no `textAfterCut` -- and every guard that reads
            // those fields evaluated against `[]` and reported "no content rendered" while the page
            // had in fact rendered it (measured: contentStates 2, textAfterCut "Hello from the").
            // The observations exist in this scope; not publishing them is what made four guards
            // vacuous rather than false. AGENTS 103: the consumer reads `postSend.renderSnapshots`;
            // the producer wrote it only on the settle path, so the boundary was the PRODUCER's
            // early return, not the field name.
            return {
                preconditions: { charactersLoaded: true, ...before, settle: globalThis.__probeSettle },
                // THE SAME KEYS THE SETTLE PATH PUBLISHES, so a consumer cannot tell the two apart
                // by shape and a guard reading them never silently sees an empty array.
                postSend: {
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
                    renderStatesAtTimeout: quietState?.renderStates ?? null,
                },
                error: `the page did not settle within 60s (completions: ${globalThis.__probeCompletions ?? 0}, in flight: ${settleInFlight}, quiet state: ${JSON.stringify(quietState)}); the recorded window would end before the send did`,
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
        return { preconditions: { charactersLoaded: true, ...before }, error: null, after: diagnostics(), postSend, presetApplied, authorsNoteOverlay: globalThis.__probeAuthorsNoteOverlay ?? null };
    }, { mockUrl: `http://${mockAddress}`, probeMode, probeSource, plan,
        presetSpec: presetMode ? presetFixture.capture.spec : null,
        presetVariant,
        presetBoundary: presetMode ? presetFixture.capture.boundary : null,
        presetAnchor: presetMode ? presetFixture.capture.tokenizerAnchor : null,
        presetContextOverride: Number.isInteger(Number(process.env.PROBE_PRESET_CONTEXT ?? '')) ? Number(process.env.PROBE_PRESET_CONTEXT) : null });

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
    // THE SEVEN-STATE TERMINAL, DECIDED HERE BECAUSE ONLY NODE CAN SEE THE EVIDENCE.
    //
    // The settle block records what the PAGE observed; the hop's own cut record, the peer's request list
    // and the page-error log are all node-side, so the classification lives here. An earlier draft put it
    // inside the page callback and both legs died with `ReferenceError: streamingPeer is not defined`
    // (`Browser differential` 40643109721) -- the same outer-handle defect this file records at L3-7.
    if (probeMode === 'abort') {
        const settle = outcome.postSend?.settle ?? null;
        const hopState = proxy?.state ?? null;
        const abortEvidence = {
            cut: hopState?.cut ?? null,
            mode: hopState?.mode ?? null,
            cutsPerformed: hopState?.cutsPerformed ?? 0,
            framesReleased: (hopState?.writes ?? []).reduce((total, write) => total + (write.frames ?? 0), 0),
            hopCompleted: Boolean(hopState?.completed),
            renderStates: settle?.quietState?.renderStates ?? 0,
        };
        const sawCut = Boolean(abortEvidence.cut && abortEvidence.cutsPerformed > 0 && abortEvidence.framesReleased > 0);
        const requestsObserved = (hopState?.writes ?? []).length + (hopState?.requestsSeen ?? 0);
        const pageErrorsObserved = (report.pageErrors ?? []).length;
        const stopped = (settle?.stoppedEmitted ?? false);
        const settledIdle = Boolean(settle?.settledIdle);
        let terminalState;
        if (settledIdle) {
            terminalState = abortEvidence.cut ? 'network-cut' : (stopped ? 'client-abort' : 'normal-completion');
        } else if (sawCut) {
            terminalState = 'cut-evidence-timeout';
        } else if (pageErrorsObserved > 0) {
            terminalState = requestsObserved > 0 ? 'subject-crash' : 'harness-failure';
        } else if (requestsObserved === 0) {
            terminalState = 'harness-failure';
        } else {
            terminalState = 'no-evidence-timeout';
        }
        report.abortTerminal = { terminalState, settledIdle, sawCut, abortEvidence, requestsObserved, pageErrorsObserved, stopped };
        // STATE 6 IS NOT A FAILURE. The leg reached the terminal a cut stream reaches and the evidence
        // names it, so the drive timeout is replaced by a statement of what was observed. States 4, 5 and
        // 7 keep their failure, and so does any non-abort timeout (this block is abort-only).
        if (report.failure && terminalState === 'cut-evidence-timeout') {
            report.driveTimeout = report.failure;
            report.failure = null;
        }
    }
    report.clickT = await page.evaluate(() => globalThis.__probeClickT ?? null);
    report.emitLog = await page.evaluate(() => (globalThis.__probeEmitLog ?? []).filter(entry => entry.t >= (globalThis.__probeClickPerf ?? 0) - 50));
    report.requestsAfterClick = report.requests.filter(entry => report.clickT !== null && entry.t >= report.clickT - 50);
    report.pingLog = await page.evaluate(() => globalThis.__probePingLog ?? []);
    report.tokenizerLog = await page.evaluate(() => globalThis.__probeTokenizerLog ?? []);
    report.xhrLog = await page.evaluate(() => globalThis.__probeXhrLog ?? []);
    report.diagnostics = outcome.preconditions ?? null;
    report.postSend = outcome.postSend ?? null;
    // The preset block is only meaningful in preset mode, and it is recorded even when the drive then
    // failed: which variant, which context, and what the kit reported is what a reader needs to judge
    // whether the leg measured the scenario at all.
    if (presetMode) {
        report.preset = outcome.presetApplied ?? null;
        // Q17: WHAT THE OVERLAY LEFT IN THE PAGE, recorded whatever the drive then did. A leg whose case
        // did not apply, or applied with a depth other than the one asked for, is a named problem here
        // rather than a body difference nobody can attribute.
        report.authorsNoteOverlay = outcome.authorsNoteOverlay
            ?? { requested: authorsNoteOverlayCase, applied: null, problems: ['the drive never reached the overlay stage, so no note was applied'] };
        // THE STATE THE VARIANT ACTUALLY STARTED FROM, read at the click (chat turns, outgoing text,
        // applied context) plus one dry assembly taken immediately before it. The comparator compares
        // these with the capture's recorded values and refuses when they differ: without that, a leg
        // whose page had drifted measures the harness instead of the frontend.
        try {
            report.presetPreSend = await page.evaluate(() => globalThis.__probePresetPreSend ?? null);
        } catch (error) {
            report.presetPreSend = { unreadable: String(error?.message ?? error).slice(0, 160) };
        }
    }
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
    // THE ABORT SURFACE'S OBSERVATIONS ARE TAKEN HERE, IN NODE, AFTER THE DRIVE HAS RETURNED. They were
    // briefly inside the drive's `page.evaluate` callback, where the outer `page` handle does not exist and
    // both legs failed with "page is not defined" (runs 40307148708, 40310223649) -- a defect that built
    // cleanly and was only visible in a browser. The recorder they read is page-side and survives the
    // callback, so nothing else had to move.
    if (probeMode === 'abort') {
        const recorder = await page.evaluate(() => globalThis.__probeAbortRecorder ?? null);
        const recordedStates = (recorder?.renderStates ?? []).map(entry => entry.text)
            .filter(text => text && text !== '\u2026' && text !== 'probe user marker');
        report.streamState = {
            ...(report.streamState ?? {}),
            // THE NAMED TERMINAL this leg reached (the seven-state classifier in the settle block),
            // carried beside the evidence it was decided from so the comparator does not have to
            // re-derive it from a timeout's shape.
            terminalState: report.settle?.terminalState ?? null,
            abortEvidence: report.settle?.abortEvidence ?? null,
            stopClickedAt: null,
            // WHAT SURVIVED THE CUT, from the recording rather than from a poll: a state that lasted 100 ms
            // is still observed.
            textAfterCut: recordedStates.at(-1) ?? null,
            contentStatesAtCut: recordedStates.length,
            snapshotsAtCut: recorder?.renderStates?.length ?? 0,
            // THE FRONTEND'S OWN IDLE FLAG, read through the module AFTER the drive returned. The frontend
            // ends a dead stream through its own error path (StreamingProcessor.generate's catch ->
            // onErrorStreaming -> markUIGenStopped -> unblockGeneration, script.js:3812-3832/3617-3619),
            // which clears this flag; a subject that hangs leaves it set and a user sees a spinner forever.
            // THE FLAG IS READ FROM THE PAGE, because document also does not exist here.
            returnedToIdle: await page.evaluate(async () => {
                const script = await import('./script.js');
                return !Boolean(script.isGenerating()) && document.body.dataset.generating === undefined;
            }),
            endedEvents: recorder?.ended ?? [],
            toastrAfterCut: await page.evaluate(() => (document.querySelector('#toast-container')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300)),
        };
        // A SECOND WINDOW, 700 ms later: "nothing arrived after the cut" needs a later sample of the same
        // recording.
        await new Promise(resolve => setTimeout(resolve, 700));
        const later = await page.evaluate(() => globalThis.__probeAbortRecorder ?? null);
        const laterStates = (later?.renderStates ?? []).map(entry => entry.text).filter(Boolean);
        report.streamState = {
            ...(report.streamState ?? {}),
            textLater: laterStates.at(-1) ?? null,
            snapshotsLater: later?.renderStates?.length ?? 0,
        };
    }
    // THE HOP, RECORDED FROM ITS OWN SIDE. What the hop forwarded (byte digests, never bodies), how many
    // downstream body writes it made and how many frames each carried, how many bytes it released, whether
    // it re-framed the stream as a single gzip member, which responses it cut and which it relayed whole,
    // and -- in cut mode -- whether the cut actually happened. A truncation the network did NOT perform
    // must be visible as `cut: null`, or a subject that truncated by itself would be credited to the
    // network. `absent` is recorded explicitly when no hop was configured, so "no hop" is a value rather
    // than a missing field.
    report.networkHop = proxy ? {
        mode: proxy.state.mode,
        cutArmOnPath: proxy.state.cutArmOnPath,
        cutAfterBytes: proxy.state.cutAfterBytes,
        cutAfterFrames,
        requestsSeen: proxy.state.requestsSeen,
        cutArmedResponses: proxy.state.cutArmedResponses ?? 0,
        relayedWholeResponses: proxy.state.relayedWholeResponses ?? 0,
        gzipFramedResponses: proxy.state.gzipFramedResponses ?? 0,
        forwarded: proxy.state.forwarded,
        bodyWrites: proxy.state.writes,
        bodyWriteCount: proxy.state.writes.length,
        releasedBytes: proxy.state.releasedBytes,
        // THE COUNT THE ABORT SURFACE IS ABOUT: this RESPONSE's body, not the hop-wide cumulative total
        // (which includes the reachability check relayed whole before it).
        releasedAtCut: proxy.state.releasedAtCut ?? null,
        // A CUT BELONGS TO A REQUEST, and a later request on the same connection can clear `cut`.
        // `anyCut` is the durable fact and is what a reader should trust when the two disagree;
        // measured twice (runs 40314154794, 40316734219) where `cut` was null beside 533 released
        // bytes. Both are recorded so the disagreement itself is visible rather than smoothed over.
        cut: proxy.state.cut,
        anyCut: proxy.state.anyCut ?? null,
        cutsPerformed: proxy.state.cutsPerformed ?? 0,
        completed: proxy.state.completed === true,
        callerClosed: proxy.state.callerClosed === true,
        upstreamErrors: proxy.state.upstreamErrors,
    } : { mode: null, absent: true };
    // WHICH BODY-DERIVED VALUE THIS DRIVE DROVE. A source whose host depends on a body field cannot be
    // read back unless the record says which value the drive selected, so every model-control record
    // the plan declared is copied out here by name.
    report.controls = await page.evaluate(names => Object.fromEntries(names.map(name => [name, globalThis[name] ?? null])), modelControlRecords);
    report.endpoint = report.controls[modelControlRecords[0]] ?? null;
    if (streamingModeOrAbort) {
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
        // A REQUEST-KEYED PEER HAS NO /__mock/recording ENDPOINT, and polling it made a working drive
        // report `Unexpected token 'o', "not found" is not valid JSON`: the 404 body of the peer, read
        // as the recorder's answer. Its own `state` is the recording, so read that instead and keep the
        // same report shape (paths = what the peer was asked, with the status it answered).
        if (streamingPeer) {
            report.requestArrived = streamingPeer.state.requests.some(request => request.method === 'POST');
            report.streamingPeerPaths = streamingPeer.state.paths;
            report.recording = streamingPeer.state.requests.map(request => {
                let parsedBody = null;
                try {
                    parsedBody = request.body ? JSON.parse(request.body) : null;
                } catch {
                    parsedBody = null;
                }
                return {
                    method: request.method,
                    path: request.path,
                    // THE FRAMING, for the artifacts that record it: header NAMES only. No value is
                    // recorded, because `authorization` carries the source key and a committed artifact must
                    // never hold one; content-length IS recorded because node-fetch COMPUTES it from the body
                    // and a body-only diff hides it.
                    headerNames: Object.keys(request.headers ?? {}).sort(),
                    receivedContentLength: request.headers?.['content-length'] ?? null,
                    bodyLength: request.bodyLength,
                    body: request.body,
                    bodySha256: request.bodySha256,
                    model: parsedBody?.model ?? null,
                    messageCount: Array.isArray(parsedBody?.messages) ? parsedBody.messages.length : null,
                    clientDisconnected: request.clientDisconnected,
                    framesWritten: request.framesWritten,
                };
            });
            // WHICH SEAMS AIMED THIS LEG, recorded from the catalog rather than from a second list: a
            // record that named the groq variable for a nanogpt run would misdescribe the drive that
            // produced it, and the previous hand-written map had already lost two of its own entries
            // (openai and openrouter had seams the map never named).
            report.peer = {
                kind: 'request-keyed',
                seams: source.probe.seams.map(seam => ({ env: seam.env, value: process.env[seam.env] ?? null })),
                redirectFrom: source.probe.redirectFrom,
                route: source.pinnedRoute,
            };
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
    // THE HOP GOES DOWN AFTER THE PEER: closing the proxy first would make the peer record a
    // disconnect the subject never performed, which is the cancellation observation wearing another
    // mode's name.
    await proxy?.close();
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
