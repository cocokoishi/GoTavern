// THE LIVE COMPLETION CANARY -- a REAL completion from a REAL provider, with NO credential.
//
// WHY THIS EXISTS. P0-A's completion half has never run: this project has no provider key, and a gate that skips
// when a secret is missing is a gate that cannot fail. But a credential was never the only way in. SillyTavern's
// `pollinations` source has an ANONYMOUS endpoint mode in which pinned sends the literal string "anonymous" as the
// key and never reads the secret at all (internal/server/pollinations_chat.go:12-13, :45, :52-59). That mode makes
// a real, live, end-to-end completion measurable -- shipped binary, production transport, real TLS to a real host,
// real SSE -- with nothing secret in the repository.
//
// WHAT IT PROVES, exactly:
//   - the shipped binary boots, takes the CSRF handshake and serves POST /api/backends/chat-completions/generate;
//   - the PRODUCTION transport (net/http: TLS with system roots, bounded connect/handshake/header waits,
//     decompression, keep-alive) reaches a real third-party host and parses its answer;
//   - the response mapping turns that answer into content the frontend can render;
//   - with --stream, the SSE path produces frames and a clean terminator.
//
// WHAT IT DOES NOT PROVE: parity with pinned Node (no pinned subject here), preset/world-info equivalence, or that
// any specific provider a user relies on is up. It also cannot prove DeepSeek specifically -- that still needs a
// key, and the reachability half of scripts/deepseek-canary.mjs covers what can be covered without one.
//
// THE VERDICT TAXONOMY IS DELIBERATE, because this gate talks to a third party that can be down:
//   ok                  a real completion came back. PASS.
//   provider-refused    the provider ANSWERED with its own error (5xx/4xx + its own message). PASS, loudly: the
//                       transport worked end to end -- a request that never arrived cannot be refused -- and the
//                       provider's condition is not this project's defect. The line names it so nobody reads it
//                       as a completion.
//   transport-failure   our side could not reach or parse the provider (`200 {"error":true}` from the catch, or a
//                       cause naming dns/connect/tls/proxy/timeout). FAIL. This is the P0-A shape.
//   empty-response      HTTP 200 with no content. FAIL: the mapping dropped an answer the provider gave.
//   not-ready           the server never answered /version inside the bound. FAIL, and never retried with a longer
//                       bound (rule 33).
//
// Usage:
//   GOTAVERN_BINARY=/path/to/gotavern node scripts/live-canary.mjs [--stream]
//   node scripts/live-canary.mjs            # builds the binary from this tree

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, copyFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const GENERATE_ROUTE = '/api/backends/chat-completions/generate';
const BOOT_DEADLINE_MS = 120_000;
const REQUEST_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WANT_STREAM = process.argv.includes('--stream');

const log = (...parts) => console.log(parts.join(' '));
const fail = message => {
    console.error(message);
    process.exitCode = 1;
};

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close(() => resolve(address.port));
        });
    });
}

function resolveBinary() {
    const configured = (process.env.GOTAVERN_BINARY ?? '').trim();
    if (configured) {
        if (!existsSync(configured)) {
            throw new Error(`GOTAVERN_BINARY points at ${configured}, which does not exist`);
        }
        log(`GOTAVERN_BINARY: driving ${configured}`);
        return configured;
    }
    const directory = mkdtempSync(path.join(tmpdir(), 'gotavern-live-build-'));
    const target = path.join(directory, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
    execFileSync('go', ['build', '-trimpath', '-o', target, './cmd/gotavern'], {
        cwd: REPOSITORY_ROOT,
        stdio: 'inherit',
    });
    log(`GOTAVERN_BINARY is unset: built ${target} from this tree`);
    return target;
}

function withoutSeam(environment) {
    const copy = { ...environment };
    delete copy.GOTAVERN_OUTBOUND_WIRE_EXACT;
    return copy;
}

// bootServer copies the binary into a throwaway install root because the binary derives its install root from the
// directory it sits in; running it from the checkout would let a boot write into the repository.
async function bootServer(binary) {
    const installRoot = mkdtempSync(path.join(tmpdir(), 'gotavern-live-'));
    const output = [];
    let child = null;
    try {
        copyFileSync(binary, path.join(installRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern'));
        const port = await freePort();
        writeFileSync(
            path.join(installRoot, 'config.yaml'),
            ['listen: false', `port: ${port}`, 'whitelist:', '  - 127.0.0.1', '  - ::1', ''].join('\n'),
            'utf8',
        );
        const executable = path.join(installRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
        child = spawn(executable, [], {
            cwd: installRoot,
            env: withoutSeam(process.env),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', chunk => output.push(chunk.toString()));
        child.stderr.on('data', chunk => output.push(chunk.toString()));
        const origin = `http://127.0.0.1:${port}`;
        const deadline = Date.now() + BOOT_DEADLINE_MS;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) {
                throw new Error(`the server EXITED before ready (code ${child.exitCode}); its output was:\n${output.join('')}`);
            }
            try {
                const response = await fetch(`${origin}/version`, { signal: AbortSignal.timeout(2_000) });
                if (response.ok) {
                    log(`server ready at ${origin} after GET /version answered ${response.status}`);
                    return { child, installRoot, origin, output };
                }
            } catch {
                // not up yet; the loop is the poll, never a sleep-then-assume
            }
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        throw new Error(`the server did not answer /version within ${BOOT_DEADLINE_MS} ms; its output was:\n${output.join('')}`);
    } catch (error) {
        if (child && child.exitCode === null) {
            child.kill('SIGKILL');
        }
        throw error;
    }
}

function cookiesOf(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    return raw.map(value => value.split(';', 1)[0]).join('; ');
}

async function call(origin, route, options = {}) {
    const response = await fetch(`${origin}${route}`, {
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        body: options.body,
        signal: AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    return { status: response.status, text, headers: response.headers };
}

async function openSession(origin) {
    const response = await fetch(`${origin}/csrf-token`);
    const cookie = cookiesOf(response);
    const body = await response.text();
    let token = '';
    try {
        token = JSON.parse(body)?.token ?? '';
    } catch {
        token = '';
    }
    if (!token) {
        throw new Error(`GET /csrf-token produced no token: HTTP ${response.status} ${body.slice(0, 200)}`);
    }
    return { cookie, token };
}

async function main() {
    log(`live completion canary: source pollinations endpoint=anonymous (NO credential), stream=${WANT_STREAM}`);
    let server = null;
    try {
        server = await bootServer(resolveBinary());
        const session = await openSession(server.origin);
        const body = {
            chat_completion_source: 'pollinations',
            pollinations_endpoint: 'anonymous',
            model: 'openai',
            messages: [{ role: 'user', content: 'Reply with the single word: pong.' }],
            max_tokens: 16,
            stream: WANT_STREAM,
        };
        const started = Date.now();
        const response = await call(server.origin, GENERATE_ROUTE, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Cookie: session.cookie,
                'X-CSRF-Token': session.token,
            },
            body: JSON.stringify(body),
        });
        const elapsed = Date.now() - started;

        if (response.status !== 200) {
            fail(`LIVE CANARY FAILED: the route answered HTTP ${response.status}: ${response.text.slice(0, 400)}`);
            return;
        }

        let parsed = null;
        try {
            parsed = JSON.parse(response.text);
        } catch {
            parsed = null;
        }

        // The pinned catch for a thrown fetch on this source family: 200 with the flag.
        if (parsed && parsed.error === true) {
            const cause = typeof parsed.message === 'string' ? parsed.message.trim() : '';
            fail(`LIVE CANARY FAILED (transport): the request never reached the provider. HTTP 200 carried the ` +
                `${cause ? `flag plus the cause ${JSON.stringify(cause)}` : 'bare pinned flag, no cause'}: ${response.text.slice(0, 300)}`);
            return;
        }

        if (WANT_STREAM) {
            const frames = response.text.split('\n\n').filter(frame => frame.trim().length > 0);
            const terminated = /data:\s*\[DONE\]\s*$/.test(response.text.trimEnd());
            if (frames.length === 0) {
                fail(`LIVE CANARY FAILED (empty stream): HTTP 200 with no SSE frames: ${response.text.slice(0, 300)}`);
                return;
            }
            if (!terminated) {
                fail(`LIVE CANARY FAILED (unterminated stream): ${frames.length} frame(s) but no clean [DONE] terminator`);
                return;
            }
            log(`LIVE CANARY OK (stream): ${elapsed} ms, ${frames.length} SSE frame(s), clean [DONE] terminator, ` +
                `last frame ${JSON.stringify(frames[frames.length - 1].slice(0, 120))}`);
            return;
        }

        const content = parsed?.choices?.[0]?.message?.content;
        if (typeof content === 'string' && content.trim().length > 0) {
            log(`LIVE CANARY OK (completion): ${elapsed} ms, model ${JSON.stringify(parsed?.model ?? null)}, ` +
                `${content.trim().length} chars: ${JSON.stringify(content.trim().slice(0, 120))}`);
            return;
        }

        const providerMessage = parsed?.error?.message ?? parsed?.message;
        if (typeof providerMessage === 'string' && providerMessage.trim().length > 0) {
            // The provider ANSWERED. The transport worked (a request that never arrived cannot be refused), and a
            // third party's condition is not this project's defect -- but it is not a completion either, and the
            // line says so rather than letting a green be read as one.
            log(`LIVE CANARY PROVIDER-REFUSED: ${elapsed} ms, HTTP ${response.status}, the provider answered with ` +
                `its own error ${JSON.stringify(providerMessage.trim().slice(0, 200))}. The transport reached it; no ` +
                `completion was produced, so the completion claim is NOT supported by this run.`);
            return;
        }

        fail(`LIVE CANARY FAILED (empty response): HTTP 200 without content and without a provider message: ` +
            `${response.text.slice(0, 400)}`);
    } finally {
        if (server?.child && server.child.exitCode === null) {
            server.child.kill('SIGKILL');
        }
    }
}

await main();
