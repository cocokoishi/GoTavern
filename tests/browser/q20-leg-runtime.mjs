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
 */
export function startCapturePeer({ replyText = ordinal => `Q20_REPLY_${ordinal}` } = {}) {
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
                choices: [{ index: 0, message: { role: 'assistant', content: replyText(replyIndex) }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
    });
    server.keepAliveTimeout = 1000;
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            requests,
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
    const server = spawn(path.resolve(binarySetting), ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
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
