#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-stream-termination.json label="provider stream termination and redirects"
//
// THE PROVIDER STREAM-TERMINATION AND REDIRECT DIFFERENTIAL.
//
// WHY IT EXISTS. The M0 audit found READ-level divergences with no gate: on a provider that dies
// mid-stream the relay may end the browser response cleanly, hang, or emit a terminal frame; the
// textgen streaming redirect loop looked unlike the other node-fetch copies; and an unsolicited gzip
// reply may leak the provider connection. Reading two implementations is not evidence. This probe
// drives a CONTROLLED PEER that sends N frames then resets the socket, trickles then stalls, redirects
// (same-host and cross-host), or serves an unsolicited gzip body -- against BOTH pinned Node and
// GoTavern, for the five relay paths the browser uses -- and records the BROWSER-VISIBLE observable of
// the relay route (status, frames, clean end vs hang vs error), plus the redirect observables (hop-2
// request headers and what the client did with the abandoned hop-1 body).
//
// THE SWITCHBOARD. One stable loopback peer serves every scenario: the scenario sets what the NEXT
// connection should do. A stable origin is what lets one pinned server and one GoTavern server be
// booted ONCE and reused: the pinned literal translation and the Go seam both point at the
// switchboard, and the switchboard decides per scenario. A subject that died (a mid-stream reset can
// kill pinned Node, whose uncaughtException handler exits the process) is recorded as an observable
// and replaced before the next scenario -- the exit is evidence, not something to normalise away.
//
// WHAT IS COMPARED, AND WHAT IS NOT. The compared object is the RELAY RESPONSE and the PEER-SIDE
// connection facts, not the provider request body: provider-wire bytes for non-redirect requests are
// owned by tools/probe-provider-wire.mjs and are not changed or re-compared here. Frames are recorded
// as counts and the presence of the `data: [DONE]` terminal frame; nothing is reordered or merged.
//
// THE PEER NEVER DEFINES CORRECTNESS. It only produces a controlled failure. The expectation is the
// pinned recording written to tests/oracle/sillytavern-1.19.0-stream-termination.json; the Go side is
// compared against it in the same run, and where the two disagree the probe fails by scenario name.
//
// NO LIVE NETWORK. Every peer listens on loopback (127.0.0.1 / ::1). The subjects are booted with a
// scratch data root and no other outbound destination is configured.
//
// Usage: node tools/probe-stream-termination.mjs <pinned-checkout> <gotavern-repository-root>
//        (the oracle runner supplies the pinned build root and the repository root as argv[2]/argv[3])

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-stream-termination.mjs <pinned-checkout> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const CLIENT_TIMEOUT_MS = 4000;
const SERVER_READY_MS = 180000;
const PINNED_ONLY = process.env.PROBE_STREAM_ONLY === 'pinned';
const FRAMES = 3;

// ---------------------------------------------------------------------------------------------
// The five relay paths the browser uses. `body`/`secrets` describe the browser-equivalent request;
// `<peer>` is replaced by the switchboard's stable origin. `pinnedLiteral` names the pinned constant
// a source without a request-member URL uses, so the pinned leg is aimed at the switchboard through a
// transport hook and the Go leg through its documented seam.
// ---------------------------------------------------------------------------------------------
const PATHS = [
    {
        id: 'chat',
        label: 'chat-completions stream (forwardFetchResponse)',
        route: '/api/backends/chat-completions/generate',
        body: { stream: true, chat_completion_source: 'custom', custom_url: '<peer>', custom_model: 'probe-model', messages: [{ role: 'user', content: 'probe' }], max_tokens: 8, temperature: 0, presence_penalty: 0, frequency_penalty: 0, top_p: 1 },
        secrets: { api_key_custom: 'probe-custom-key' },
    },
    {
        id: 'kobold',
        label: 'kobold stream (forwardFetchResponse)',
        route: '/api/backends/kobold/generate',
        body: { api_server: '<peer>', prompt: 'probe', max_length: 8, streaming: true, temperature: 0, top_p: 1, top_k: 0, rep_pen: 1 },
        secrets: { api_key_koboldcpp: 'probe-kobold-key' },
    },
    {
        id: 'novelai',
        label: 'novelai stream (forwardFetchResponse)',
        route: '/api/novelai/generate',
        body: { streaming: true, model: 'clio-v1', input: 'probe', max_length: 8, temperature: 0, top_p: 1, top_k: 0, repetition_penalty: 1 },
        secrets: { api_key_novel: 'probe-novel-key' },
        pinnedLiteral: 'https://api.novelai.net',
        goSeam: 'GOTAVERN_NOVELAI_API_URL',
    },
    {
        id: 'textgen',
        label: 'textgen stream (forwardFetchResponse + searchFetch redirect loop)',
        route: '/api/backends/text-completions/generate',
        body: { api_server: '<peer>', api_type: 'generic', model: 'probe-model', prompt: 'probe', max_tokens: 8, stream: true, temperature: 0, top_p: 1 },
        secrets: { api_key_generic: 'probe-generic-key' },
    },
    {
        id: 'ollama',
        label: 'textgen Ollama NDJSON re-framer (parseOllamaStream)',
        route: '/api/backends/text-completions/generate',
        body: { api_server: '<peer>', api_type: 'ollama', model: 'probe-model', prompt: 'probe', stream: true },
        secrets: { api_key_ollama: 'probe-ollama-key' },
    },
];

const MODES = ['frames-reset', 'stall', 'redirect-cross', 'redirect-same', 'gzip'];

function sseFrame(text, kind) {
    if (kind === 'ollama') return `${JSON.stringify({ response: text, thinking: '' })}\n`;
    return `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`;
}

function responseHead(statusLine, headers) {
    const lines = [statusLine];
    for (const [name, value] of headers) lines.push(`${name}: ${value}`);
    return `${lines.join('\r\n')}\r\n\r\n`;
}

// A close-delimited provider response: no Content-Length and no Transfer-Encoding, so the body ends
// when the socket does. A RST mid-body is then unambiguously a truncated response for both clients.
function chunkedHead() {
    return responseHead('HTTP/1.1 200 OK', [
        ['Content-Type', 'text/event-stream'],
        ['Transfer-Encoding', 'chunked'],
        ['Connection', 'close'],
    ]);
}

function chunk(value) {
    const body = Buffer.from(value, 'utf8');
    return `${body.length.toString(16)}\r\n`;
}

function chunked(value) {
    const body = Buffer.from(value, 'utf8');
    return `${body.length.toString(16)}\r\n${value}\r\n`;
}

// ---------------------------------------------------------------------------------------------
// The switchboard: one stable loopback listener whose BEHAVIOUR is set by the current scenario.
// ---------------------------------------------------------------------------------------------
function startSwitchboard() {
    const state = { behaviour: { mode: 'frames-clean', kind: 'sse' }, connections: [] };
    const server = net.createServer(socket => {
        const connection = { requestLine: null, headers: {}, bodyBytes: 0, closedByClient: false, writeError: null };
        state.connections.push(connection);
        const behaviour = state.behaviour;
        let buffer = '';
        let responded = false;
        socket.on('error', () => { });
        socket.on('close', hadError => {
            connection.closedByClient = true;
            connection.hadError = Boolean(hadError);
        });
        socket.on('data', data => {
            buffer += data.toString('latin1');
            const end = buffer.indexOf('\r\n\r\n');
            if (end === -1) return;
            const lines = buffer.slice(0, end).split('\r\n');
            connection.requestLine = lines.shift();
            for (const line of lines) {
                const colon = line.indexOf(':');
                if (colon === -1) continue;
                const name = line.slice(0, colon).trim().toLowerCase();
                connection.headers[name] = line.slice(colon + 1).trim();
            }
            buffer = '';
            if (responded) return;
            responded = true;
            respond(behaviour);
        });

        function writeFrames(action) {
            let remaining = 0;
            const interval = setInterval(() => {
                if (socket.destroyed) { clearInterval(interval); return; }
                if (remaining >= FRAMES) { clearInterval(interval); action(); return; }
                remaining += 1;
                const frame = sseFrame(`provider-frame-${remaining}`, behaviour.kind);
                socket.write(chunked(frame));
                connection.bodyBytes += Buffer.byteLength(frame);
            }, 40);
        }

        function respond(current) {
            if (current.mode === 'frames-clean') {
                socket.write(chunkedHead());
                writeFrames(() => { socket.write('0\r\n\r\n'); socket.end(); });
                return;
            }
            if (current.mode === 'frames-reset') {
                socket.write(chunkedHead());
                writeFrames(() => {
                    setTimeout(() => {
                        if (socket.destroyed) return;
                        if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
                        else socket.destroy();
                    }, 80);
                });
                return;
            }
            if (current.mode === 'stall') {
                socket.write(chunkedHead());
                // Deliberately never end: the relay must show what it does when the provider stops
                // sending without closing.
                writeFrames(() => { });
                return;
            }
            if (current.mode === 'gzip') {
                let plain = '';
                const gzipFrames = current.kind === 'ollama' ? 1 : FRAMES;
                for (let index = 1; index <= gzipFrames; index += 1) plain += sseFrame(`provider-frame-${index}`, current.kind);
                const compressed = zlib.gzipSync(Buffer.from(plain, 'utf8'));
                socket.write(responseHead('HTTP/1.1 200 OK', [
                    ['Content-Type', 'text/event-stream'],
                    ['Content-Encoding', 'gzip'],
                    ['Content-Length', String(compressed.length)],
                    ['Connection', 'close'],
                ]));
                socket.write(compressed);
                socket.end();
                return;
            }
            if (current.mode === 'redirect') {
                // A redirect response WITH A BODY, so "did the client drain the abandoned body" is
                // observable: the byte count and the first failed write say whether it read it.
                const bodySize = 4 * 1024 * 1024;
                socket.write(responseHead('HTTP/1.1 302 Found', [
                    ['Location', current.redirectTo],
                    ['Content-Length', String(bodySize)],
                    ['Connection', 'close'],
                ]));
                let sent = 0;
                const block = Buffer.alloc(64 * 1024, 0x61);
                socket.on('error', error => { connection.writeError = String(error.code ?? error.message ?? error); });
                const pump = () => {
                    if (socket.destroyed || sent >= bodySize) return;
                    const chunk = sent + block.length <= bodySize ? block : block.subarray(0, bodySize - sent);
                    sent += chunk.length;
                    const flushed = socket.write(chunk);
                    connection.bodyBytes = sent;
                    if (flushed) setImmediate(pump);
                    else socket.once('drain', pump);
                };
                pump();
                return;
            }
            throw new Error(`unknown switchboard mode ${current.mode}`);
        }
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve({
                url: `http://127.0.0.1:${server.address().port}`,
                reset(behaviour) {
                    state.behaviour = behaviour;
                    state.connections = [];
                },
                connections: () => state.connections,
                close: () => new Promise(done => server.close(done)),
            });
        });
    });
}

// The redirect target. Cross-host is expressed as ::1 vs 127.0.0.1: both clients compare HOSTNAMES
// (node-fetch isDomainOrSubdomain, Go shouldCopyHeaderOnRedirect), so the IPv4/IPv6 loopback pair is
// a cross-host redirect with no host-file change. Same-host uses the same address on another port.
async function startHop2({ kind, crossHost }) {
    const holder = { record: null };
    const server = net.createServer(socket => {
        const record = { requestLine: null, headers: {} };
        holder.record = record;
        let buffer = '';
        let responded = false;
        socket.on('error', () => { });
        socket.on('data', data => {
            buffer += data.toString('latin1');
            const end = buffer.indexOf('\r\n\r\n');
            if (end === -1) return;
            const lines = buffer.slice(0, end).split('\r\n');
            record.requestLine = lines.shift();
            for (const line of lines) {
                const colon = line.indexOf(':');
                if (colon === -1) continue;
                record.headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
            }
            buffer = '';
            if (responded) return;
            responded = true;
            socket.write(chunkedHead());
            let remaining = 0;
            const interval = setInterval(() => {
                if (socket.destroyed || remaining >= FRAMES) {
                    clearInterval(interval);
                    if (!socket.destroyed) { socket.write('0\r\n\r\n'); socket.end(); }
                    return;
                }
                remaining += 1;
                socket.write(chunked(sseFrame(`hop2-frame-${remaining}`, kind)));
            }, 30);
        });
    });
    const useV6 = crossHost && process.env.PROBE_PEER_HOST === 'v6';
    const host = useV6 ? '::1' : '127.0.0.1';
    const displayHost = useV6 ? '[::1]' : '127.0.0.1';
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => {
            resolve({
                url: `http://${displayHost}:${server.address().port}`,
                record: () => holder.record,
                close: () => new Promise(done => server.close(done)),
            });
        });
    });
}

// ---------------------------------------------------------------------------------------------
// Subject lifecycle. One pinned and one GoTavern process are reused across scenarios; a subject that
// exited is replaced, and the exit is recorded as an observable of the scenario that caused it.
// ---------------------------------------------------------------------------------------------
function prepareRuntime(runtimeRoot, dataRoot, secrets) {
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    const configPath = path.join(runtimeRoot, 'config.yaml');
    writeFileSync(configPath, [
        'listen: false',
        'enableKeepAlive: false',
        'skipContentCheck: true',
        'privateAddressWhitelist:',
        '  enabled: true',
        '  allowedRanges:',
        "    - '127.0.0.0/8'",
        "    - '::1/128'",
        '',
    ].join('\n'));
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), 'gotavern-pinned-stream-termination-cookie-secret');
    writeFileSync(path.join(dataRoot, '_storage', createHash('sha256').update('user:default-user').digest('hex')), JSON.stringify({
        key: 'user:default-user',
        value: { handle: 'default-user', name: 'Stream Termination Probe', created: 1700000000000, password: '', admin: true, enabled: true, salt: '' },
    }));
    const userRoot = path.join(dataRoot, 'default-user');
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(path.join(userRoot, 'secrets.json'), JSON.stringify(secrets, null, 4));
    return configPath;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
}

// The pinned translation hook rewrites only the declared literal's scheme+host to the switchboard.
// It re-reads the mapping file per request, so a mapping rewritten between scenarios takes effect
// without booting a server per scenario.
function redirectHookProgram(realFetchURL, mappingPath) {
    return [
        `import { registerHooks } from 'node:module';`,
        `const REAL = ${JSON.stringify(realFetchURL)};`,
        `const MAP = ${JSON.stringify(mappingPath)};`,
        `registerHooks({`,
        `  resolve(specifier, context, nextResolve) {`,
        `    if (specifier === 'node-fetch') return { url: 'gotavern-stream-redirect:node-fetch', shortCircuit: true };`,
        `    return nextResolve(specifier, context);`,
        `  },`,
        `  load(url, context, nextLoad) {`,
        `    if (url !== 'gotavern-stream-redirect:node-fetch') return nextLoad(url, context);`,
        `    return { format: 'module', shortCircuit: true, source: SOURCE };`,
        `  },`,
        `});`,
        `const SOURCE = [`,
        `  'import realFetch from ' + JSON.stringify(REAL) + ';',`,
        `  'import { readFileSync } from "node:fs";',`,
        `  'const MAP = ' + JSON.stringify(MAP) + ';',`,
        `  'function redirect(input) {',`,
        `  '  const href = typeof input === "string" ? input : (input && input.href ? input.href : String(input));',`,
        `  '  let rewrites = [];',`,
        `  '  try { rewrites = JSON.parse(readFileSync(MAP, "utf8")); } catch { rewrites = []; }',`,
        `  '  for (const pair of rewrites) {',`,
        `  '    if (!href.startsWith(pair.from)) continue;',`,
        `  '    return pair.to + href.slice(pair.from.length);',`,
        `  '  }',`,
        `  '  return href;',`,
        `  '}',`,
        `  'export default function fetchThroughRedirect(input, options) { return realFetch(redirect(input), options); }',`,
        `  'globalThis.fetch = fetchThroughRedirect;',`,
        `].join(String.fromCharCode(10));`,
        '',
    ].join('\n');
}

async function waitForBackend(child, origin, logs, label) {
    const deadline = Date.now() + SERVER_READY_MS;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`${label} exited early (${child.exitCode}):\n${logs.join('').slice(-4000)}`);
        try {
            const response = await fetch(`${origin}/login?noauto=1`);
            if (response.status === 200 && String(response.headers.get('content-type') ?? '').includes('text/html')) return;
        } catch {
            // still starting
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`${label} did not become ready:\n${logs.join('').slice(-4000)}`);
}

async function authenticate(origin) {
    const csrfResponse = await fetch(`${origin}/csrf-token`);
    const csrf = await csrfResponse.json();
    const cookies = csrfResponse.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; ');
    const login = await fetch(`${origin}/api/users/login`, {
        method: 'POST',
        headers: { Cookie: cookies, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.token },
        body: JSON.stringify({ handle: 'default-user', password: '' }),
    });
    if (login.status !== 200) throw new Error(`login failed: ${login.status} ${await login.text()}`);
    return {
        token: csrf.token,
        cookie: login.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; '),
    };
}

function makeSubjectLauncher({ subject, binary, switchboard, secrets, mappingPath }) {
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), `gotavern-stream-${subject}-`));
    const dataRoot = path.join(runtimeRoot, 'data');
    const configPath = prepareRuntime(runtimeRoot, dataRoot, secrets);
    let handle = null;
    const boot = async () => {
        const port = await freePort();
        const origin = `http://127.0.0.1:${port}`;
        const logs = [];
        let command;
        let args;
        if (subject === 'pinned') {
            const realFetchPath = path.join(sourceRoot, 'node_modules', 'node-fetch', 'src', 'index.js');
            if (!existsSync(realFetchPath)) throw new Error(`pinned checkout has no node-fetch at ${realFetchPath}`);
            const hookPath = path.join(runtimeRoot, 'stream-redirect-hook.mjs');
            writeFileSync(hookPath, redirectHookProgram(pathToFileURL(realFetchPath).href, mappingPath));
            command = process.execPath;
            args = [
                '--import', pathToFileURL(hookPath).href, 'server.js',
                '--configPath', configPath, '--dataRoot', dataRoot,
                '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'true',
                '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
            ];
        } else {
            command = binary;
            args = [
                '--configPath', configPath, '--dataRoot', dataRoot,
                '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'true',
                '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
            ];
        }
        const child = spawn(command, args, {
            cwd: subject === 'pinned' ? sourceRoot : runtimeRoot,
            env: { ...process.env, ...(subject === 'pinned' ? {} : { [secrets.goSeamVariable]: switchboard.url }), NODE_ENV: 'test' },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => logs.push(chunk));
        child.stderr.on('data', chunk => logs.push(chunk));
        let exited = null;
        child.on('exit', (code, signal) => { exited = { code, signal }; });
        await waitForBackend(child, origin, logs, subject);
        const session = await authenticate(origin);
        handle = { origin, session, child, logs, exited: () => exited };
        return handle;
    };
    return {
        async get() {
            if (handle && handle.exited() === null) return handle;
            handle = null;
            return boot();
        },
        async stop() {
            if (!handle || handle.exited() !== null) { handle = null; return; }
            const child = handle.child;
            await new Promise(resolve => {
                child.once('exit', resolve);
                child.kill();
                setTimeout(() => { try { child.kill('SIGKILL'); } catch { } resolve(); }, 3000);
            });
            handle = null;
        },
        exited: () => handle?.exited() ?? null,
    };
}

// ---------------------------------------------------------------------------------------------
// Drive one relay request and record the BROWSER-VISIBLE observable.
// ---------------------------------------------------------------------------------------------
function driveRelay({ origin, session, route, bodyText }) {
    return new Promise(resolve => {
        const started = Date.now();
        const result = { status: null, headers: {}, terminal: null, dataFrames: 0, doneFrame: false, bytes: 0, textPrefix: '', readError: null, elapsedMs: null, timedOut: false };
        const chunks = [];
        let finished = false;
        const request = http.request(`${origin}${route}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(bodyText),
                Cookie: session.cookie,
                'X-CSRF-Token': session.token,
            },
        }, response => {
            result.status = response.statusCode;
            for (const [name, value] of Object.entries(response.headers)) result.headers[name] = Array.isArray(value) ? value.join(', ') : String(value);
            response.on('data', chunk => {
                chunks.push(chunk);
                result.bytes += chunk.length;
            });
            response.on('end', () => finish('clean'));
            response.on('error', error => {
                result.readError = String(error.code ?? error.message ?? error);
                finish('error');
            });
        });
        const timer = setTimeout(() => {
            result.timedOut = true;
            request.destroy();
            finish('hang');
        }, CLIENT_TIMEOUT_MS);
        request.on('error', error => {
            result.readError = String(error.code ?? error.message ?? error);
            finish('error');
        });
        request.end(bodyText);
        function finish(terminal) {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            result.terminal = terminal;
            result.elapsedMs = Date.now() - started;
            const text = Buffer.concat(chunks).toString('utf8');
            result.textPrefix = text.slice(0, 400);
            const frameMatches = text.match(/(?:^|\n)data: /g);
            result.dataFrames = frameMatches ? frameMatches.length : 0;
            result.doneFrame = /data: \[DONE\]/.test(text);
            resolve(result);
        }
    });
}

function normalizedObservation({ relayResponse, redirect, serverExit, badRequest }) {
    const observation = {
        badRequest: badRequest ?? null,
        serverExited: Boolean(serverExit),
        relay: relayResponse === null ? null : {
            status: relayResponse.status,
            terminal: relayResponse.terminal,
            dataFrames: relayResponse.dataFrames,
            doneFrame: relayResponse.doneFrame,
            readErrorClass: relayResponse.terminal === 'error' ? 'read-error' : null,
            contentType: relayResponse.headers?.['content-type'] ?? null,
        },
    };
    if (redirect) {
        observation.redirect = {
            hop1SensitivePresent: redirect.hop1SensitivePresent,
            hop2SensitivePresent: redirect.hop2SensitivePresent,
            hop2Sensitive: redirect.hop2Sensitive,
            hop1BodyDrained: redirect.hop1BodyBytesWritten >= 4 * 1024 * 1024,
            hop1BodyAborted: Boolean(redirect.hop1BodyClosedByClient || redirect.hop1BodyWriteError),
            hop2RequestLine: redirect.hop2RequestLine,
        };
    }
    return observation;
}

// The error WORDING of a transport failure is client-specific (`ECONNRESET` vs `aborted`); the class
// is compared instead (clean end vs hang vs read error), together with the frame count, the terminal
// `[DONE]`, the subject's process exit and every redirect fact exactly.
function compareObservations(pinned, gotavern) {
    const differences = [];
    const walk = (a, b, prefix) => {
        if (JSON.stringify(a) === JSON.stringify(b)) return;
        if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
            differences.push({ path: prefix, pinned: a, gotavern: b });
            return;
        }
        for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
            if (!(key in a)) { differences.push({ path: `${prefix}.${key}`, pinned: '<absent>', gotavern: b[key] }); continue; }
            if (!(key in b)) { differences.push({ path: `${prefix}.${key}`, pinned: a[key], gotavern: '<absent>' }); continue; }
            walk(a[key], b[key], prefix ? `${prefix}.${key}` : key);
        }
    };
    walk(pinned, gotavern, '');
    return differences;
}

// ---------------------------------------------------------------------------------------------
// Main.
// ---------------------------------------------------------------------------------------------
function resolveBinary(environmentVariable, buildRelativePath, fallbackName) {
    const provided = process.env[environmentVariable];
    if (provided) {
        const resolved = path.resolve(provided);
        if (!existsSync(resolved)) throw new Error(`${environmentVariable} points at ${resolved}, which does not exist`);
        return resolved;
    }
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gotavern-stream-build-'));
    const binary = path.join(directory, process.platform === 'win32' ? `${fallbackName}.exe` : fallbackName);
    execFileSync('go', ['build', '-o', binary, buildRelativePath], { cwd: repositoryRoot, stdio: 'inherit' });
    return binary;
}

let crossHostSupported = true;
try {
    await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '::1', () => probe.close(resolve));
    });
    process.env.PROBE_PEER_HOST = 'v6';
} catch {
    crossHostSupported = false;
    process.env.PROBE_PEER_HOST = 'v4';
    console.log('WARNING: ::1 is unavailable on this host; cross-host redirect scenarios are UNPROVEN');
}

const switchboard = await startSwitchboard();
const mappingRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-stream-mapping-'));
const mappingPath = path.join(mappingRoot, 'mapping.json');
writeFileSync(mappingPath, '[]');
const allSecrets = Object.assign({}, ...PATHS.map(relay => relay.secrets));
const binary = PINNED_ONLY ? null : resolveBinary('GOTAVERN_BINARY', './cmd/gotavern', 'gotavern');
const launchers = {
    pinned: makeSubjectLauncher({ subject: 'pinned', binary: null, switchboard, secrets: { ...allSecrets, goSeamVariable: 'GOTAVERN_NOVELAI_API_URL' }, mappingPath }),
    gotavern: PINNED_ONLY ? null : makeSubjectLauncher({ subject: 'gotavern', binary, switchboard, secrets: { ...allSecrets, goSeamVariable: 'GOTAVERN_NOVELAI_API_URL' }, mappingPath }),
};

const modesSelected = (process.env.PROBE_STREAM_MODES ?? '').split(',').filter(Boolean);
const pathsSelected = (process.env.PROBE_STREAM_PATHS ?? '').split(',').filter(Boolean);
const effectiveModes = modesSelected.length > 0 ? MODES.filter(mode => modesSelected.includes(mode)) : MODES;
const effectivePaths = pathsSelected.length > 0 ? PATHS.filter(relay => pathsSelected.includes(relay.id)) : PATHS;
const scenarios = [];
for (const relay of effectivePaths) for (const mode of effectiveModes) scenarios.push({ relay, mode });

async function runScenario({ relay, mode, subject }) {
    const kind = relay.id === 'ollama' ? 'ollama' : 'sse';
    const hop2 = mode.startsWith('redirect') ? await startHop2({ kind, crossHost: mode === 'redirect-cross' }) : null;
    switchboard.reset({ mode: mode.startsWith('redirect') ? 'redirect' : mode, kind, redirectTo: hop2 ? hop2.url : null });
    writeFileSync(mappingPath, JSON.stringify(relay.pinnedLiteral ? [{ from: relay.pinnedLiteral, to: switchboard.url }] : []));
    const launcher = launchers[subject];
    try {
        const handle = await launcher.get();
        const substituted = JSON.parse(JSON.stringify(relay.body));
        const replace = value => {
            if (typeof value === 'string') return value.split('<peer>').join(switchboard.url);
            if (Array.isArray(value)) return value.map(replace);
            if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, replace(entry)]));
            return value;
        };
        const bodyText = JSON.stringify(replace(substituted));
        const relayResponse = await driveRelay({ origin: handle.origin, session: handle.session, route: relay.route, bodyText });
        const badRequest = relayResponse.status === 400 || relayResponse.status === 500 ? relayResponse.textPrefix : null;
        let redirect = null;
        if (hop2) {
            await new Promise(resolve => setTimeout(resolve, 200));
            const connection = switchboard.connections()[0] ?? {};
            const hop2Record = hop2.record() ?? {};
            const sensitive = ['authorization', 'www-authenticate', 'cookie', 'cookie2'];
            const hop2Headers = hop2Record.headers ?? {};
            redirect = {
                hop1SensitivePresent: sensitive.some(name => name in (connection.headers ?? {})),
                hop2SensitivePresent: sensitive.some(name => name in hop2Headers),
                hop2Sensitive: Object.fromEntries(sensitive.filter(name => name in hop2Headers).map(name => [name, '<recorded>'])),
                hop1BodyBytesWritten: connection.bodyBytes ?? 0,
                hop1BodyClosedByClient: Boolean(connection.closedByClient),
                hop1BodyWriteError: connection.writeError ?? null,
                hop2RequestLine: hop2Record.requestLine ?? null,
            };
        }
        // Read AFTER the drive: a mid-stream reset that killed the subject is this scenario's
        // observable, and the next scenario gets a fresh process.
        const serverExit = launcher.exited();
        if (serverExit) await launcher.stop();
        return normalizedObservation({ relayResponse, redirect, serverExit, badRequest });
    } finally {
        await hop2?.close().catch(() => { });
    }
}

const results = { pinned: {}, gotavern: {} };
for (const scenario of scenarios) {
    const name = `${scenario.relay.id}.${scenario.mode}`;
    results.pinned[name] = await runScenario({ ...scenario, subject: 'pinned' });
    console.log(`${name} [pinned] terminal=${results.pinned[name].relay?.terminal} frames=${results.pinned[name].relay?.dataFrames} done=${results.pinned[name].relay?.doneFrame} exit=${results.pinned[name].serverExited} status=${results.pinned[name].relay?.status}`);
    if (!PINNED_ONLY) {
        results.gotavern[name] = await runScenario({ ...scenario, subject: 'gotavern' });
        console.log(`${name} [gotavern] terminal=${results.gotavern[name].relay?.terminal} frames=${results.gotavern[name].relay?.dataFrames} done=${results.gotavern[name].relay?.doneFrame} exit=${results.gotavern[name].serverExited} status=${results.gotavern[name].relay?.status}`);
    }
}
await launchers.pinned.stop();
if (launchers.gotavern) await launchers.gotavern.stop();
await switchboard.close();

const classification = {};
const differences = [];
if (!PINNED_ONLY) {
    for (const scenario of scenarios) {
        const name = `${scenario.relay.id}.${scenario.mode}`;
        if (scenario.mode === 'redirect-cross' && !crossHostSupported) {
            classification[name] = { verdict: 'unproven', reason: 'no IPv6 loopback on this host, so the cross-host redirect was not exercised' };
            continue;
        }
        const diff = compareObservations(results.pinned[name], results.gotavern[name]);
        classification[name] = { verdict: diff.length === 0 ? 'match' : 'different', differences: diff.slice(0, 8) };
        if (diff.length > 0) differences.push({ name, differences: diff.slice(0, 8) });
    }
}

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'pinned relay response and peer-connection observable for a controlled provider that resets, stalls, redirects, or compresses; compared against GoTavern in the same run',
    crossHostSupported,
    clientTimeoutMs: CLIENT_TIMEOUT_MS,
    paths: PATHS.map(relay => ({ id: relay.id, route: relay.route, body: relay.body, label: relay.label, pinnedLiteral: relay.pinnedLiteral ?? null })),
    scenarios: Object.fromEntries(scenarios.map(scenario => {
        const name = `${scenario.relay.id}.${scenario.mode}`;
        return [name, { relay: scenario.relay.id, mode: scenario.mode, observation: results.pinned[name], classification: classification[name]?.verdict ?? 'pinned-only' }];
    })),
    notRecorded: [
        'provider request body bytes for non-redirect requests (owned by the provider-wire differential; this probe does not compare them)',
        'response header ORDER and casing (only content-type is recorded; the browser does not receive the other relay headers as an ordering contract)',
        'a cross-SCHEME redirect (http->https): pinned node-fetch also strips sensitive headers on a protocol change, but a TLS peer with a certificate both clients trust is not available in this loopback harness, so it is unproven rather than assumed',
        'timing beyond the 4 s client bound (a stall is "no terminal within the bound", not a hang duration)',
    ],
};
const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-stream-termination.json');
mkdirSync(path.dirname(outputFile), { recursive: true });
writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`wrote ${outputFile} with ${Object.keys(fixture.scenarios).length} scenario(s)`);

if (!PINNED_ONLY && differences.length > 0) {
    for (const { name, differences: entries } of differences) {
        console.error(`::error::stream-termination differential DIFFERS for ${name}`);
        for (const entry of entries) console.error(`  ${entry.path}: pinned=${JSON.stringify(entry.pinned)} gotavern=${JSON.stringify(entry.gotavern)}`);
    }
    console.error(`stream-termination: ${differences.length} of ${scenarios.length} scenario(s) differ`);
    process.exitCode = 1;
} else if (!PINNED_ONLY) {
    console.log(`stream-termination differential closed: ${scenarios.length}/${scenarios.length} scenario(s) match`);
}
process.exit(process.exitCode ?? 0);
