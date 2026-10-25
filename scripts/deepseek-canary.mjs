#!/usr/bin/env node
// THE LIVE DEEPSEEK CANARY.
//
// WHY THIS EXISTS. Every gate this project has for the provider path is either a unit test of the
// transport or a differential against a mock, and AGENTS.md rule 22 is explicit that a behaviour
// verified only against our own peer is UNVERIFIED for production purposes. P0-A was exactly that
// gap: the suite was green and the user's DeepSeek key reached nothing. This script is the one gate
// that speaks to the real api.deepseek.com through the shipped binary, with the key stored the way
// the frontend stores it.
//
// WHAT IT DOES, in the order a user does it:
//   1. boots the real binary (GOTAVERN_BINARY, or a build of this tree) into a throwaway install root;
//   2. waits for GET /version to answer, with a hard deadline and the child's output printed on
//      failure -- never a sleep;
//   3. GET /csrf-token, the CSRF handshake the frontend performs before a write (accounts are off in
//      the default config, so there is no login step on a fresh install);
//   4. POST /api/secrets/write {key: api_key_deepseek, value: <the key>, label}, i.e. the real route
//      and the real store -- a hand-written secrets.json would test the reader against this script's
//      own invention;
//   5. POST /api/backends/chat-completions/generate with a browser-shaped DEEPSEEK request and NO
//      seam, so API_DEEPSEEK is the real https://api.deepseek.com/beta;
//   6. classifies the answer and exits non-zero unless a non-empty completion came back.
//
// WHY IT SKIPS LOUDLY. A canary that silently does nothing when its credential is missing is a gate
// that cannot fail. With no DEEPSEEK_API_KEY this script prints one SKIPPED line naming the variable
// and exits 0, so the lane log shows exactly which of the two things happened.
//
// WHAT IT CANNOT PROVE, stated here because the verdict looks stronger than it is:
//   - It cannot distinguish DNS, connect, TLS, proxy and timeout failures, because the DEEPSEEK source
//     answers a THROWN fetch with `{"error":true}` and no message at all (pinned
//     chat-completions.js:1168-1174, reproduced deliberately). The canary therefore reports
//     "transport failure, cause discarded" and adds its OWN diagnostic fetch to say what this runner's
//     network did -- clearly labelled as the runner's, not the product's.
//   - It covers one source, one model and one non-streamed completion. Streaming, cancellation,
//     presets, world info and tokenization are not in scope.
//   - It runs only when a credential is configured, so its green is a property of runs that had one,
//     and a skipped lane says nothing about the provider path.
//   - It cannot prove parity with pinned Node: it has no pinned subject to compare against.
//
// Usage:
//   DEEPSEEK_API_KEY=... GOTAVERN_BINARY=/path/to/gotavern node scripts/deepseek-canary.mjs
//   DEEPSEEK_API_KEY=... GOTAVERN_ORIGIN=http://127.0.0.1:8000 node scripts/deepseek-canary.mjs
//   node scripts/deepseek-canary.mjs            # prints SKIPPED, exit 0
//
// No dependencies: Node's own fetch, child_process and net are enough, and Node already exists in CI.

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const KEY_VARIABLE = 'DEEPSEEK_API_KEY';
const SECRET_KEY = 'api_key_deepseek';
const GENERATE_ROUTE = '/api/backends/chat-completions/generate';
const MODEL = (process.env.GOTAVERN_CANARY_MODEL ?? '').trim() || 'deepseek-chat';
const BOOT_DEADLINE_MS = 120_000;
const GENERATE_TIMEOUT_MS = 150_000;
const POLL_INTERVAL_MS = 250;
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// A REAL KEY IS OPTIONAL, AND ITS ABSENCE IS NOT A SKIP.
//
// The first version of this script exited 0 with SKIPPED when the credential was missing, which made the only
// gate that reaches api.deepseek.com a line nobody could act on -- a gate that cannot fail. But "no key" does
// not mean "nothing can be measured": the reachability half of P0-A needs NO credential at all, because the
// provider itself answers an unauthenticated request with its OWN error body. Reaching that body proves DNS
// resolution, TCP connect, the TLS handshake against the system roots, request framing and response parsing --
// i.e. every stage that was failing in the report, and none of the stages a key would add.
//
// So there are two modes, and the reporting names which one ran:
//   - WITH a key    : a real completion is required, and anything else fails.
//   - WITHOUT a key : the script sends this script's own obviously-invalid key and REQUIRES a provider-origin
//                     rejection (an HTTP status plus the provider's error body). A transport failure, an empty
//                     completion or a route-level flag fails, because those are the P0-A shapes.
const INVALID_KEY = 'sk-gotavern-canary-no-credential-0000000000000000';
const apiKey = (process.env[KEY_VARIABLE] ?? '').trim();
const keyIsReal = apiKey.length > 0;
const effectiveKey = keyIsReal ? apiKey : INVALID_KEY;

const redact = text => {
    let out = String(text);
    for (const value of [apiKey, effectiveKey]) {
        if (value) {
            out = out.split(value).join('<redacted>');
        }
    }
    return out;
};
const log = (...parts) => console.log(redact(parts.join(' ')));
const fail = message => {
    console.error(redact(message));
    process.exitCode = 1;
};

// ---------------------------------------------------------------------------- the server under test

function freePort() {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.unref();
        probe.on('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address();
            probe.close(() => resolve(address.port));
        });
    });
}

// resolveBinary prefers the artifact the lane built for the commit under test, and compiles this tree
// only when it is given nothing -- a canary driving a binary from another commit would be measuring
// that commit.
function resolveBinary() {
    const configured = (process.env.GOTAVERN_BINARY ?? '').trim();
    if (configured) {
        const resolved = path.resolve(configured);
        if (!existsSync(resolved)) {
            throw new Error(`GOTAVERN_BINARY points at ${resolved}, which does not exist. The lane ` +
                `workflow builds that binary and exports this variable, and a canary without a binary ` +
                `would test nothing.`);
        }
        log(`GOTAVERN_BINARY: driving ${resolved}`);
        return resolved;
    }
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gotavern-canary-build-'));
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

async function bootServer(binary) {
    const installRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-canary-'));
    const output = [];
    let child = null;
    try {
        // The binary derives its install root from the directory it sits in
        // (cmd/gotavern/main.go:170), so it is copied into the throwaway install root rather than run
        // from wherever CI built it: otherwise a boot that writes anything beside the executable would
        // write into the repository checkout.
        const localBinary = path.join(installRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
        copyFileSync(binary, localBinary);
        chmodSync(localBinary, 0o755);
        const port = await freePort();
        child = spawn(localBinary, [
            'start',
            '--configPath', path.join(installRoot, 'config.yaml'),
            '--dataRoot', path.join(installRoot, 'data'),
            '--listenAddressIPv4', '127.0.0.1',
            '--enableIPv4', 'true',
            '--enableIPv6', 'false',
            '--listen', 'false',
            '--port', String(port),
            '--browserLaunchEnabled', 'false',
            '--heartbeatInterval', '0',
        ], {
            cwd: installRoot,
            // The canary must observe the PRODUCTION transport, so the wire-exact seam is removed from
            // the child's environment even if this runner inherited it.
            env: withoutSeam(process.env),
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => output.push(chunk));
        child.stderr.on('data', chunk => output.push(chunk));

        const origin = `http://127.0.0.1:${port}`;
        const deadline = Date.now() + BOOT_DEADLINE_MS;
        while (Date.now() < deadline) {
            if (child.exitCode !== null) {
                throw new Error(`the server exited before GET /version answered (exit ${child.exitCode}):\n${output.join('')}`);
            }
            try {
                const response = await fetch(`${origin}/version`, { signal: AbortSignal.timeout(5000) });
                const body = await response.text();
                if (response.status === 200 && body.length > 0) {
                    log(`server ready at ${origin} (GET /version -> ${response.status} ${JSON.stringify(body)})`);
                    return { child, origin, installRoot };
                }
            } catch {
                // Still starting. The deadline decides, never a fixed sleep.
            }
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        throw new Error(`the server did not answer GET /version within ${BOOT_DEADLINE_MS} ms:\n${output.join('')}`);
    } catch (error) {
        if (child && child.exitCode === null) {
            child.kill('SIGTERM');
        }
        rmSync(installRoot, { recursive: true, force: true });
        throw error;
    }
}

// ---------------------------------------------------------------------------- browser-equivalent calls

function cookiesOf(response) {
    const values = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    return values.map(value => value.split(';', 1)[0]).filter(Boolean).join('; ');
}

async function call(origin, route, options = {}) {
    const response = await fetch(`${origin}${route}`, {
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        body: options.body,
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await response.text();
    return { status: response.status, text, cookies: cookiesOf(response) };
}

// openSession is the handshake the frontend performs before a write on a fresh install: GET
// /csrf-token, and the signed cookie that comes with it. There is no login step on purpose -- the
// default config has enableUserAccounts: false, the middleware binds each request to the built-in
// default user, and POST /api/users/login would additionally need the _storage/user:default-user
// record that startup seeds, which would make the canary's first call race the boot it measures.
async function openSession(origin) {
    const csrf = await call(origin, '/csrf-token');
    if (csrf.status !== 200) {
        throw new Error(`GET /csrf-token -> ${csrf.status}: ${csrf.text.slice(0, 200)}`);
    }
    const token = JSON.parse(csrf.text).token;
    if (!token) {
        throw new Error('GET /csrf-token returned no token');
    }
    if (!csrf.cookies) {
        throw new Error('GET /csrf-token set no cookie, so no write below could be authenticated');
    }
    return { token, cookie: csrf.cookies };
}

async function storeKey(origin, session) {
    const response = await call(origin, '/api/secrets/write', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Cookie: session.cookie,
            'X-CSRF-Token': session.token,
        },
        body: JSON.stringify({ key: SECRET_KEY, value: effectiveKey, label: 'deepseek canary' }),
    });
    if (response.status !== 200) {
        throw new Error(`POST /api/secrets/write -> ${response.status}: ${response.text.slice(0, 200)}`);
    }
    const id = JSON.parse(response.text).id;
    if (!id) {
        throw new Error('POST /api/secrets/write returned no id');
    }
    log(`stored ${SECRET_KEY} through the frontend's own route (id ${id})`);
}

// ---------------------------------------------------------------------------- the verdict

// classify maps the answer to a NAMED shape. A taxonomy rather than a boolean is what makes a red say
// which of the four possible things happened, and only one of them means "the transport is broken".
function classify(status, text) {
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        parsed = null;
    }
    const content = parsed?.choices?.[0]?.message?.content;
    if (status === 200 && typeof content === 'string' && content.length > 0) {
        return { verdict: 'ok', content, model: parsed?.model ?? null, id: parsed?.id ?? null };
    }
    // DEEPSEEK's catch for a fetch that threw: response.send({ error: true }), HTTP 200.
    //
    // GoTavern keeps that flag BYTE-IDENTICALLY and ADDS a `message` naming the transport stage (product
    // decision 2026-10-25, AGENTS rule 35: "cannot connect" is not an error message). Both shapes are
    // recognised, and neither is a pass: the route still failed to reach the provider. The one with a cause
    // is reported WITH the cause, so a reader can tell DNS from TLS from a timeout.
    if (status === 200 && parsed && parsed.error === true) {
        const cause = typeof parsed.message === 'string' ? parsed.message.trim() : '';
        if (cause) {
            return { verdict: 'transport-failure-with-cause', cause };
        }
        return { verdict: 'transport-cause-discarded' };
    }
    if (parsed && typeof parsed?.error?.message === 'string' && parsed.error.message.length > 0) {
        return { verdict: 'provider-error', providerStatus: status, message: parsed.error.message };
    }
    if (status === 200 && parsed && Array.isArray(parsed.choices)) {
        return { verdict: 'empty-completion', body: text };
    }
    return { verdict: 'unclassified', status, body: text };
}

// diagnosticFetch is the canary's OWN egress check, run only when the route reported a transport
// failure whose cause it discarded. It is labelled as the runner's network rather than the product's,
// because that distinction is exactly what a P0-A report cannot make on its own.
async function diagnosticFetch() {
    try {
        const response = await fetch('https://api.deepseek.com/models', {
            headers: { authorization: `Bearer ${effectiveKey}`, accept: 'application/json' },
            signal: AbortSignal.timeout(20_000),
        });
        const text = await response.text();
        return `this runner reached api.deepseek.com/models directly: HTTP ${response.status} ${text.slice(0, 160)}`;
    } catch (error) {
        const code = error?.cause?.code ?? error?.code ?? error?.name ?? 'unknown';
        return `this runner could NOT reach api.deepseek.com directly either: ${code} ${error?.message ?? ''}`.trim();
    }
}

async function main() {
    log(`DeepSeek canary: model ${MODEL}, ` +
        (keyIsReal
            ? `${KEY_VARIABLE} present (value never printed): a real completion is required`
            : `${KEY_VARIABLE} ABSENT: running the reachability half with an invalid key, so the `
              + `provider must REJECT it with its own error body. That proves DNS, TCP, TLS, request `
              + `framing and response parsing through the shipped binary, and nothing that needs a key.`));

    let child = null;
    let installRoot = null;
    try {
        let origin = (process.env.GOTAVERN_ORIGIN ?? '').trim();
        if (origin) {
            log(`GOTAVERN_ORIGIN: driving the server already listening at ${origin}`);
        } else {
            const server = await bootServer(resolveBinary());
            child = server.child;
            installRoot = server.installRoot;
            origin = server.origin;
        }

        const session = await openSession(origin);
        await storeKey(origin, session);

        // NO SEAM AND NO OVERRIDE: this is the real provider, the real TLS and the real internet. The
        // timeout is this script's own bound; the route deliberately has none (the pinned fetch has
        // none), so a provider that accepts the connection and stalls holds the request, and this abort
        // is what turns that into a named verdict instead of a hung job.
        const started = Date.now();
        let response;
        try {
            response = await call(origin, GENERATE_ROUTE, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Cookie: session.cookie,
                    'X-CSRF-Token': session.token,
                },
                body: JSON.stringify({
                    chat_completion_source: 'deepseek',
                    model: MODEL,
                    messages: [{ role: 'user', content: 'Reply with the single word: pong.' }],
                    max_tokens: 16,
                    stream: false,
                }),
                timeoutMs: GENERATE_TIMEOUT_MS,
            });
        } catch (error) {
            const code = error?.cause?.code ?? error?.name ?? 'unknown';
            fail(`CANARY FAILED (no answer): the generate route did not answer within ` +
                `${GENERATE_TIMEOUT_MS} ms (${code}). The provider call has no client-side timeout, so a ` +
                `provider that accepts the connection and then stalls holds the request -- the frontend ` +
                `sees a spinner rather than an error.`);
            return;
        }
        const elapsed = Date.now() - started;

        // A SECRET IN A RESPONSE BODY is a defect independent of the provider path, so it is checked
        // before the verdict and every printed body goes through redact().
        if (redact(response.text) !== response.text) {
            fail('CANARY FAILED (secret leak): the route answered with the API key inside the response ' +
                'body, and the key is redacted from this log.');
            return;
        }

        const verdict = classify(response.status, response.text);
        switch (verdict.verdict) {
            case 'ok':
                log(`CANARY OK: ${elapsed} ms, HTTP ${response.status}, model ${JSON.stringify(verdict.model)}, ` +
                    `id ${JSON.stringify(verdict.id)}, ${verdict.content.length} chars of content ` +
                    `${JSON.stringify(verdict.content.slice(0, 80))}`);
                return;
            case 'provider-error':
                // WITHOUT a key this is the PASS: an HTTP status plus the provider's own error body is proof
                // that the whole transport worked -- DNS, TCP, the TLS handshake against the system roots,
                // request framing, response parsing -- because a provider cannot reject a request it never
                // received. That is the half of P0-A that needs no credential, and the half that was broken.
                if (!keyIsReal) {
                    log(`CANARY OK (reachable; no credential): ${elapsed} ms, HTTP ` +
                        `${verdict.providerStatus} from the provider itself, message ` +
                        `${JSON.stringify(verdict.message)}. api.deepseek.com answered OUR request through the ` +
                        `shipped binary, which is what a P0-A 'cannot connect' report was not happening.`);
                    return;
                }
                fail(`CANARY FAILED (provider answered with an error, HTTP ${verdict.providerStatus}): ` +
                    `${JSON.stringify(verdict.message)} -- the provider refused the request itself (invalid ` +
                    `key, unavailable model or exhausted quota). Causal, and about the account rather than ` +
                    `about the transport.`);
                return;
            case 'empty-completion':
                fail(`CANARY FAILED (empty completion): HTTP 200 with an empty ` +
                    `choices[0].message.content: ${verdict.body.slice(0, 300)}`);
                return;
            case 'transport-failure-with-cause': {
                const diagnosis = await diagnosticFetch();
                fail(`CANARY FAILED (transport): the request never reached the provider. HTTP ` +
                    `${response.status} carried the pinned flag plus the cause this project added: ` +
                    `${JSON.stringify(verdict.cause)}. This mode requires a provider-ORIGIN answer, so a ` +
                    `transport failure here means the user path cannot reach api.deepseek.com at all. ` +
                    `Diagnostic only, NOT the product's path: ${diagnosis}`);
                return;
            }
            case 'transport-cause-discarded': {
                const diagnosis = await diagnosticFetch();
                fail(`CANARY FAILED (transport, cause discarded): the route answered HTTP 200 ` +
                    `{"error":true}, the DEEPSEEK source's catch for a fetch that THREW ` +
                    `(chat-completions.js:1168-1174: response.send({error:true}), no status, no message). ` +
                    `The request never reached the provider, and the cause -- DNS, connect, TLS, proxy or ` +
                    `timeout -- is not in the response, so a user is told nothing it can act on. ` +
                    `Diagnostic only, NOT the product's path: ${diagnosis}`);
                return;
            }
            default:
                fail(`CANARY FAILED (unclassified): HTTP ${verdict.status} ` +
                    `${JSON.stringify((verdict.body ?? '').slice(0, 400))} -- neither a completion, nor a ` +
                    `provider error, nor DEEPSEEK's transport-failure flag, so nothing here can be ` +
                    `attributed to a stage.`);
        }
    } finally {
        if (child && child.exitCode === null) {
            child.kill('SIGTERM');
        }
        if (installRoot) {
            // The temporary install root holds secrets.json with the real key in it; it never outlives
            // the run.
            try {
                rmSync(installRoot, { recursive: true, force: true });
            } catch {
                // A Windows handle can outlive the kill for a moment; the directory is under the
                // runner's temp path and the platform reclaims it.
            }
        }
    }
}

await main();
