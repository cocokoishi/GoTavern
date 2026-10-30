// THE PARTS OF A Q20 LEG THAT ARE ABOUT RUNNING A SERVER, NOT ABOUT THE VERB BEING TESTED.
//
// `q20-persistence-probe.mjs` grew these inline for one verb pair (save/reload/swipe). A regenerate leg and a
// continue leg need the same capture peer, the same boot, the same "/version then wait", the same disk reader and
// the same request log. Keeping three copies would mean three chances for one of them to record the peer's port or
// the request count slightly differently, and the comparator's whole claim is that the two subjects were driven the
// same way -- so the shared half lives here and each probe owns only its subject drive.
//
// WHAT IS DELIBERATELY NOT SHARED WITH THE PINNED LEG'S BETTER HALF: the pinned leg is booted by
// `run-against-pinned.mjs`, which owns the pinned checkout, the port, the seeded config and `PROBE_BASE_URL`. A leg
// started that way must NOT boot anything itself, so `bootSubject` refuses when an external base URL is present
// instead of quietly starting a second server nobody compared.

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

// THE MODULE'S OWN DIRECTORY, the way every other probe in this harness resolves it: `new URL(...).pathname` is a
// URL path, so on a Windows host it arrives as `/C:/...` and `path.resolve` turns it into `C:\C:\...`.
export const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');

export function argumentValue(argv, name, fallback = null) {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    return value === undefined ? fallback : value;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.unref();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

export async function waitForServer(url, deadlineMs = 120000) {
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

/**
 * The capture peer: records every request (method, path, byte length, sha256, body) and answers.
 *
 * It DEFINES NOTHING (AGENTS 49): the replies are markers so a leg can prove the message came from here, and the
 * only branch is a `/models` probe answer, which is a capability check rather than a completion.
 *
 * `replyText` is a FUNCTION of the reply ordinal so a continue leg can make the continuation's text provably a
 * CONTINUATION (a suffix) rather than another full reply -- the persisted file is where that is judged.
 *
 * THE PEER HONOURS `stream: true` WITH REAL SSE. Measured in run 40459475175's predecessor 40459475159: the page
 * STREAMS (`oai_settings.stream_openai` defaults TRUE when missing, openai.js:376; `isStreamingEnabled()`,
 * script.js:3517-3526), so this peer's JSON body was handed to `EventSourceStream` (public/scripts/sse-stream.js),
 * which found no `data:` frames, yielded zero tokens, and the page stored an EMPTY assistant message -- its own
 * console said so: `Stream stats: 0 tokens, NaN seconds, rate: NaN TPS`. A peer that answers the wrong content type
 * for the request it received is a fixture that lies, and it made every structure-only guard in this repository
 * unfalsifiable on content.
 *
 * THE FRAME CONTRACT IS THE FRONTEND'S, read from `public/scripts/sse-stream.js`:
 *   - events are separated by a blank line (`streamBuffer.split(/\r\n\r\n|\r\r|\n\n/g)`),
 *   - a `data:` line's value is ACCUMULATED WITH A TRAILING '\n' per line and the final one is stripped,
 *   - `data: [DONE]` ends the stream (openai.js:3173-3174 `if (rawData === '[DONE]') return;`),
 *   - each frame's JSON is read by `getStreamingReply`, so the delta lives at `choices[0].delta.content`.
 *
 * `--wire` (CONDITION 5, provide-do-not-use): the default is `honour`, which answers SSE to a `stream: true` request
 * and JSON otherwise, so the response format is a function of what was ASKED. A leg may pass `--wire json` or
 * `--wire sse` to pin it; the choice is recorded in the artefact (`wireMode`) so no reader has to infer it.
 *
 * EVERY RESPONSE RECORDS WHAT WAS SERVED (`served`, CONDITION 1): `{wire, frames, bytes, terminal}`. That is what
 * makes a past leg's silence diagnosable -- a leg that drove a streaming page against a JSON peer now says
 * `served.wire: "json"` in its own record instead of leaving the discrepancy to be reasoned about.
 */
export function startCapturePeer({ replyText = ordinal => `Q20_REPLY_${ordinal}`, wire = 'honour', replyPrefix = '' } = {}) {
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
            // WHAT THE REQUEST ASKED FOR, read rather than assumed.
            let wantsStream = false;
            try {
                wantsStream = JSON.parse(body.toString('utf8'))?.stream === true;
            } catch {
                wantsStream = false;
            }
            const record = {
                method: request.method,
                path: request.url,
                byteLength: body.length,
                sha256: createHash('sha256').update(body).digest('hex'),
                body: body.toString('utf8'),
                requestedStream: wantsStream,
                // FILLED BELOW, before the response ends: what this peer actually served.
                served: { wire: null, frames: 0, bytes: 0, terminal: false },
            };
            requests.push(record);
            const jsonHeaders = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
            if (request.method === 'GET' && /models/.test(request.url ?? '')) {
                response.writeHead(200, jsonHeaders);
                const listing = JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model' }] });
                record.served = { wire: 'json', frames: 0, bytes: Buffer.byteLength(listing), terminal: true };
                response.end(listing);
                return;
            }
            replyIndex += 1;
            // THE REPLY TEXT CAN BE MADE PER-SUBJECT, and run 40494862493 is why it sometimes must be.
            //
            // Each leg boots its OWN peer process with its own `replyIndex` starting at zero, so by default BOTH
            // subjects receive the SAME text (`Q20_REPLY_1`, `Q20_REPLY_2`, ...). For a single-subject leg that is
            // harmless. For TWO legs whose equality is the assertion it is a rule-50 defect at the content level: the
            // requests can be equal because the two subjects were fed identical bytes, so the comparison cannot
            // distinguish "the product sent the same thing" from "the harness made them the same thing".
            //
            // It also BIT the regenerate comparison, in a way that looked like a product finding: the pinned leg
            // performed one more setup completion than the GoTavern leg, so its counter ran ahead, its chat's last
            // message was `Q20_REPLY_4` with TWO swipes while GoTavern's was `Q20_REPLY_2` with ONE, and
            // `regenerate-file-swipes-unchanged` went red with `before=2 after=1`. That red was correct about the
            // bytes and wrong about the cause -- the extra swipe came from the reply the harness had handed it.
            //
            // `replyPrefix` lets a caller stamp the subject's identity into the text, so a difference attributable to
            // the harness is visible AS a difference instead of hiding inside a shared convention.
            // `replyIndex` is passed TWICE -- as the ordinal and as the "counterpart" slot -- so a caller may declare
            // either `ordinal => ...` (regenerate, save/reload/swipe) or `(ordinal, counterpart) => ...` (continue).
            //
            // THE SECOND ARGUMENT EXISTS BECAUSE ITS ABSENCE WAS A SILENT DEFECT. The continue probe declares
            // `replyText: (ordinal, counterpart) => ...`, and when this call site passed only one argument the reply
            // text became the literal string `Q20_REPLY_undefined`. NOTHING THREW: the page stored it, the message
            // count was correct, and only the assertions that READ the reply went red --
            // `turn-1-saved-the-reply`, `turn-2-saved-the-reply`, `continue-control-reached`,
            // `continue-ui-shows-the-grown-message` and `continue-file-holds-continuation-in-same-message`. Five reds
            // from one missing argument, every one of them shaped like a finding about the continue verb.
            // A signature mismatch between a producer and its only consumer is invisible to `node --check`, and this is
            // the cheapest possible instance of rule 80: the weak spot was not in the assertion but in the fixture
            // underneath all of them.
            const text = String(replyText(replyIndex, replyIndex) ?? '');
            const labelled = replyPrefix ? `${replyPrefix}${text}` : text;
            const serveSse = wire === 'sse' || (wire === 'honour' && wantsStream);
            if (serveSse) {
                // THE FRAMES THE READER EXPECTS: one delta carrying the whole text (a single chunk is enough -- the
                // reader concatenates deltas), then the terminal sentinel.
                const delta = JSON.stringify({
                    id: `chatcmpl-q20-${replyIndex}`,
                    object: 'chat.completion.chunk',
                    created: 1730000000,
                    model: 'probe-model',
                    choices: [{ index: 0, delta: { role: 'assistant', content: labelled }, finish_reason: null }],
                });
                const stop = JSON.stringify({
                    id: `chatcmpl-q20-${replyIndex}`,
                    object: 'chat.completion.chunk',
                    created: 1730000000,
                    model: 'probe-model',
                    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
                });
                const payload = `data: ${delta}\n\ndata: ${stop}\n\ndata: [DONE]\n\n`;
                response.writeHead(200, {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache',
                    'access-control-allow-origin': '*',
                });
                record.served = { wire: 'sse', frames: 3, bytes: Buffer.byteLength(payload), terminal: true };
                response.end(payload);
                return;
            }
            const payload = JSON.stringify({
                id: `chatcmpl-q20-${replyIndex}`,
                object: 'chat.completion',
                created: 1730000000,
                model: 'probe-model',
                choices: [{ index: 0, message: { role: 'assistant', content: labelled }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            });
            response.writeHead(200, jsonHeaders);
            record.served = { wire: 'json', frames: 0, bytes: Buffer.byteLength(payload), terminal: true };
            response.end(payload);
        });
    });
    server.keepAliveTimeout = 1000;
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            requests,
            wireMode: wire,
            close: () => new Promise(done => server.close(done)),
        }));
    });
}

/**
 * Boot the GoTavern binary for a leg that owns its server, or return the pinned base URL a caller supplied.
 *
 * REFUSES BOTH MIXED STATES: an external base URL with a binary to boot (two servers, one compared), and no base
 * URL with no binary (nothing to drive). Recording the refusal in the leg's own `failure` is what keeps "the drive
 * could not run" out of the comparison as a product finding.
 */
export async function bootSubject({ argv, dataRoot, port, external }) {
    if (external) {
        return { external: true, baseURL: process.env.PROBE_BASE_URL, server: null, serverLog: [], bootRefusal: null };
    }
    const binarySetting = process.env.GOTAVERN_BINARY ?? '';
    if (!binarySetting) {
        return { external: false, baseURL: `http://127.0.0.1:${port}`, server: null, serverLog: [], bootRefusal: 'GOTAVERN_BINARY is required for the GoTavern leg' };
    }
    const { seedLegConfig } = await import('./seed-leg-config.mjs');
    await fs.cp(path.join(repoRoot, 'upstream', 'tokenizers'), path.join(dataRoot, 'tokenizers'), { recursive: true });
    await seedLegConfig(dataRoot);
    // `--browserLaunchEnabled false` IS NOT OPTIONAL, AND THIS LEG LEARNED IT THE EXPENSIVE WAY. The config every leg is
    // seeded with is derived from the PINNED default tree, whose `browserLaunch.enabled` is TRUE, and a server that
    // honours it opens the developer's DEFAULT BROWSER at boot. Measured on a local run of the whole-session surface:
    // the GoTavern leg's own process opened a real browser tab on the developer's desktop while the leg was measuring
    // a page in headless Chromium. `run-against-pinned.mjs` has always passed the equivalent flag to the pinned
    // server for exactly this reason; the GoTavern leg did not, so every caller of this helper could do it too. The
    // flag overrides the config without editing the tree (AGENTS rule 14).
    const server = spawn(path.resolve(binarySetting), ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml'), '--browserLaunchEnabled', 'false'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const serverLog = [];
    const collect = chunk => {
        if (serverLog.length < 200) serverLog.push(String(chunk).slice(0, 400));
    };
    server.stdout.on('data', collect);
    server.stderr.on('data', collect);
    void argv;
    return { external: false, baseURL: `http://127.0.0.1:${port}`, server, serverLog, bootRefusal: null };
}

export { freePort };
