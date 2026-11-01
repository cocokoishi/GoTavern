#!/usr/bin/env node
// THE LIVE PROVIDER + PROXY CANARY.
//
// WHY THIS EXISTS. `providers-transport` and gap rank 6 say the same thing: every differential in this
// repository runs against its own recording peer, and AGENTS.md rule 22 makes a peer-only observation
// unverified for production purposes. P0-A was exactly that blind spot. `scripts/live-canary.mjs` and
// `scripts/deepseek-canary.mjs` established that a live path CAN be measured without a credential (the
// anonymous Pollinations source) and WITH one (DeepSeek), but neither exercises the PROXY path, and neither
// names the full transport surface a user relies on. This script does, through the SHIPPED BINARY and the
// PRODUCTION client (`internal/outbound/transport.go`), never the wire-exact recording seam.
//
// WHAT IT MEASURES, and how each claim can fail:
//   direct-completion      GoTavern -> real provider over TLS with system roots, non-streamed completion.
//   invalid-credential     a deliberately invalid key reaches the provider and the provider REJECTS it (401/403
//                          or its own error body). A request that never arrived cannot be rejected, so this
//                          proves DNS + TCP + TLS + framing + response mapping without a real key.
//   proxy-control-refused  with `requestProxy` CONFIGURED to a dead local port, the request MUST fail with a
//                          cause that names the proxy/connect stage. This is the control that proves the proxy
//                          setting is honoured at all: a canary that only tests a working proxy cannot tell
//                          "proxy used" from "proxy silently bypassed".
//   proxy-completion       the same completion through the user-configured HTTP proxy (CONNECT for https).
//   streaming              SSE frames and a clean [DONE] terminator through the production client.
//   mid-stream-cancel      abort the browser-side request after the first frame; the server must observe the
//                          disconnect and stay responsive (GET /version answers afterwards).
//   dns-failure            a `.invalid` provider host must fail with a cause naming DNS, through the binary.
//   ipv6                    when the provider publishes AAAA records, a boot preferring IPv6 must reach it;
//                          when it does not, the probe reports not-observed instead of pretending.
//   not-observed (named)   decompression, keep-alive reuse, redirect following, connect/header timeout, 429/5xx:
//                          each is either a property the ROUTE does not expose (decompression/keep-alive), a
//                          provider condition we cannot force without abusing it (429/5xx), or a slow shape the
//                          local unit gates already drive deterministically. They are reported with the exact
//                          local test that gates them; never counted as passes here.
//
// DEFAULT-SAFE, BY CONTRACT. With no provider credential this script prints one SKIPPED line naming what was
// missing, writes a report whose `skipped` is true, and exits 0. It never looks like a pass: the report says
// `skipped`, the workflow annotates the skip, and `--require-credentials` turns the skip into exit 2 so a
// maintainer who intended a credentialed run cannot be fooled by it.
//
// SECRETS. Provider key, proxy URL and proxy password are never printed, never written to the report and
// never uploaded. Every line goes through redact(); the report is checked for the secrets before it is
// written; the temporary install root (which holds secrets.json) is removed in `finally`.
//
// COST AND TIME. Bounded: at most 6 provider calls, tiny max_tokens, per-request timeouts, a 15-minute job
// bound, and no retry loops. The verdict is about TRANSPORT (status/headers/frames/error cause), never about
// model intelligence.
//
// Usage:
//   node scripts/live-provider-proxy-canary.mjs [--report <path>] [--require-credentials] [--selftest]
//   DEEPSEEK_API_KEY=... GOTAVERN_CANARY_PROXY_URL=http://user:pass@host:port node scripts/live-provider-proxy-canary.mjs --require-credentials
//   node scripts/live-provider-proxy-canary.mjs              # SKIPPED (no credential), exit 0
//
// Env:
//   DEEPSEEK_API_KEY                 provider credential (never printed)
//   GOTAVERN_CANARY_PROXY_URL        HTTP proxy URL, may carry user:pass (never printed)
//   GOTAVERN_CANARY_PROXY_BYPASS     optional space-separated bypass list passed to requestProxyBypass
//   GOTAVERN_CANARY_MODEL            default deepseek-chat
//   GOTAVERN_BINARY                  binary to drive; built from this tree when unset
//   GOTAVERN_CANARY_NO_IPV6=1        skip the IPv6 probe even if the provider publishes AAAA

import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { promises as dns } from 'node:dns';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GENERATE_ROUTE = '/api/backends/chat-completions/generate';
const SECRETS_WRITE_ROUTE = '/api/secrets/write';
const BOOT_DEADLINE_MS = 120_000;
const REQUEST_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const MODEL = (process.env.GOTAVERN_CANARY_MODEL ?? '').trim() || 'deepseek-chat';
const PROVIDER_HOST = 'api.deepseek.com';
const DECISION_DOC = 'docs/remote-embeddings-decision.md';

const providerKey = (process.env.DEEPSEEK_API_KEY ?? '').trim();
const proxyUrl = (process.env.GOTAVERN_CANARY_PROXY_URL ?? '').trim();
const proxyBypass = (process.env.GOTAVERN_CANARY_PROXY_BYPASS ?? '').trim();
const hasProviderCredential = providerKey.length > 0;
const hasProxyCredential = proxyUrl.length > 0;
const REQUIRE_CREDENTIALS = process.argv.includes('--require-credentials');
const SELFTEST = process.argv.includes('--selftest');
// REACHABILITY MODE IS AN EXPLICIT OPT-IN AND NEVER CLAIMS A COMPLETION. It runs the probes that need no
// credential (invalid-credential, dns-failure, proxy-control-refused) so the live machinery -- boot, CSRF,
// secrets write, route, production transport, causal error shapes -- is measurable on a machine without a
// key. The default stays SKIP, because a no-key run must not look like a pass.
const REACHABILITY = process.argv.includes('--reachability');
const SKIP_IPV6 = process.env.GOTAVERN_CANARY_NO_IPV6 === '1';
const REPORT_PATH = (() => {
    const index = process.argv.indexOf('--report');
    return index >= 0 ? path.resolve(process.argv[index + 1] ?? '') : '';
})();

// Every printable value passes through here. The proxy URL is redacted whole as well as by password, because
// its userinfo is a credential and its host is not the provider's.
const secrets = [providerKey, proxyUrl, proxyUrl.replace(/^[a-z]+:\/\//i, '')].filter(value => value.length > 0);
const proxyPassword = (() => {
    try {
        return new URL(proxyUrl).password;
    } catch {
        return '';
    }
})();
if (proxyPassword) secrets.push(proxyPassword);
function redact(value) {
    let text = String(value);
    for (const secret of secrets) text = text.split(secret).join('<redacted>');
    return text;
}
const log = (...parts) => console.log(redact(parts.join(' ')));
const fail = message => {
    console.error(redact(message));
    process.exitCode = 1;
};

// -----------------------------------------------------------------------------------------------------------
// Probe bookkeeping: a verdict TAXONOMY, because "green" would collapse "the provider refused us" (transport
// worked) with "we never reached the provider" (P0-A) into one word.
// -----------------------------------------------------------------------------------------------------------
const probes = [];
function record(name, verdict, detail, observed = {}) {
    const entry = { name, verdict, detail: redact(detail), observed };
    probes.push(entry);
    log(`${verdict === 'ok' || verdict.startsWith('provider-') ? 'PASS' : verdict === 'not-observed' || verdict === 'skipped' ? 'SKIP' : 'FAIL'} ${name}: ${entry.detail}`);
    return entry;
}

// -----------------------------------------------------------------------------------------------------------
// The server under test. The binary is copied into a throwaway install root (it derives its install root from
// the executable's directory), browser launch is disabled explicitly, and the wire-exact recording seam is
// removed from the child's environment so the PRODUCTION client is what this canary measures.
// -----------------------------------------------------------------------------------------------------------
function freePort() {
    return new Promise((resolve, reject) => {
        const probe = createServer();
        probe.unref();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const address = probe.address();
            probe.close(() => resolve(address.port));
        });
    });
}

function resolveBinary() {
    const configured = (process.env.GOTAVERN_BINARY ?? '').trim();
    if (configured) {
        const resolved = path.resolve(configured);
        if (!existsSync(resolved)) throw new Error(`GOTAVERN_BINARY points at ${resolved}, which does not exist`);
        log(`GOTAVERN_BINARY: driving ${resolved}`);
        return resolved;
    }
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gotavern-live-canary-build-'));
    const target = path.join(directory, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
    execFileSync('go', ['build', '-trimpath', '-o', target, './cmd/gotavern'], { cwd: REPOSITORY_ROOT, stdio: 'inherit' });
    log(`GOTAVERN_BINARY is unset: built ${target} from this tree`);
    return target;
}

function withoutSeam(environment) {
    const copy = { ...environment };
    delete copy.GOTAVERN_OUTBOUND_WIRE_EXACT;
    return copy;
}

async function bootServer(binary, extraArguments = []) {
    const installRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-live-canary-'));
    const output = [];
    let child = null;
    try {
        const localBinary = path.join(installRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
        copyFileSync(binary, localBinary);
        chmodSync(localBinary, 0o755);
        const port = await freePort();
        const argumentsList = [
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
            ...extraArguments,
        ];
        child = spawn(localBinary, argumentsList, {
            cwd: installRoot,
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
                throw new Error(`the server exited before /version answered (exit ${child.exitCode}):\n${redact(output.join(''))}`);
            }
            try {
                const response = await fetch(`${origin}/version`, { signal: AbortSignal.timeout(5_000) });
                const body = await response.text();
                if (response.status === 200 && body.length > 0) {
                    log(`server ready at ${origin} (GET /version -> ${response.status})`);
                    return { child, origin, installRoot };
                }
            } catch {
                // still starting; the deadline decides
            }
            await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
        }
        throw new Error(`the server did not answer /version within ${BOOT_DEADLINE_MS} ms:\n${redact(output.join(''))}`);
    } catch (error) {
        if (child && child.exitCode === null) child.kill('SIGTERM');
        rmSync(installRoot, { recursive: true, force: true });
        throw error;
    }
}

function cookiesOf(response) {
    const values = typeof response.headers.getSetCookie === 'function' ? response.headers.getSetCookie() : [];
    return values.map(value => value.split(';', 1)[0]).filter(Boolean).join('; ');
}

async function call(origin, route, options = {}) {
    const response = await fetch(`${origin}${route}`, {
        method: options.method ?? 'GET',
        headers: options.headers ?? {},
        body: options.body,
        signal: options.signal ?? AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
    const text = await response.text();
    return { status: response.status, text, cookies: cookiesOf(response) };
}

async function openSession(origin) {
    const csrf = await call(origin, '/csrf-token');
    if (csrf.status !== 200) throw new Error(`GET /csrf-token -> ${csrf.status}`);
    const token = JSON.parse(csrf.text).token;
    if (!token || !csrf.cookies) throw new Error('GET /csrf-token returned no token/cookie');
    return { token, cookie: csrf.cookies };
}

async function storeSecret(origin, session, key, value) {
    const response = await call(origin, SECRETS_WRITE_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.token },
        body: JSON.stringify({ key, value, label: 'live provider canary' }),
    });
    if (response.status !== 200) throw new Error(`POST ${SECRETS_WRITE_ROUTE} -> ${response.status}: ${redact(response.text.slice(0, 200))}`);
    return response;
}

// A provider request body shaped the way the frontend sends it. `custom` carries its own URL and key so a
// non-provider target (the `.invalid` DNS probe) can be driven through the same route.
function generateBody(overrides = {}) {
    return {
        chat_completion_source: 'deepseek',
        model: MODEL,
        messages: [{ role: 'user', content: 'Reply with the single word: pong.' }],
        max_tokens: 8,
        stream: false,
        ...overrides,
    };
}

async function generate(origin, session, body, timeoutMs = REQUEST_TIMEOUT_MS) {
    return call(origin, GENERATE_ROUTE, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.token },
        body: JSON.stringify(body),
        timeoutMs,
    });
}

function parsed(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

// The transport-failure causes the production client attributes. A response that carries one of these (in the
// additive `message` member, or in the provider error body) never reached the provider.
const TRANSPORT_CAUSE = /dns|no such host|connect|connection refused|tls|proxy|timeout|deadline|unreachable|network is unreachable|eof|reset/i;
function transportCauseOf(response) {
    const body = parsed(response.text);
    const message = typeof body?.message === 'string' ? body.message : typeof body?.error?.message === 'string' ? body.error.message : '';
    if (message && TRANSPORT_CAUSE.test(message)) return message;
    if (body && body.error === true && !message) return '';
    return '';
}

// -----------------------------------------------------------------------------------------------------------
// Probes. Each returns a recorded verdict and never throws past its own bound.
// -----------------------------------------------------------------------------------------------------------
async function probeDirectCompletion(server) {
    const session = await openSession(server.origin);
    await storeSecret(server.origin, session, 'api_key_deepseek', providerKey);
    const started = Date.now();
    let response;
    try {
        response = await generate(server.origin, session, generateBody());
    } catch (error) {
        return record('direct-completion', 'transport-failure', `the route did not answer within its bound (${error?.name ?? 'error'})`);
    }
    const elapsed = Date.now() - started;
    const body = parsed(response.text);
    const content = body?.choices?.[0]?.message?.content;
    if (response.status === 200 && typeof content === 'string' && content.trim().length > 0) {
        return record('direct-completion', 'ok', `${elapsed} ms, HTTP 200, model ${JSON.stringify(body?.model ?? null)}, ${content.trim().length} chars`, { status: 200, model: body?.model ?? null, latencyMs: elapsed });
    }
    const cause = transportCauseOf(response);
    if (cause) return record('direct-completion', 'transport-failure', `the request never reached ${PROVIDER_HOST}: ${JSON.stringify(cause)}`, { status: response.status });
    return record('direct-completion', 'provider-refused', `HTTP ${response.status} without a completion; the provider answered: ${redact(response.text.slice(0, 240))}`, { status: response.status });
}

async function probeInvalidCredential(server) {
    const session = await openSession(server.origin);
    await storeSecret(server.origin, session, 'api_key_deepseek', 'sk-gotavern-canary-invalid-000000000000000000');
    let response;
    try {
        response = await generate(server.origin, session, generateBody());
    } catch (error) {
        return record('invalid-credential', 'transport-failure', `the route did not answer within its bound (${error?.name ?? 'error'})`);
    }
    const body = parsed(response.text);
    const providerMessage = body?.error?.message ?? (typeof body?.message === 'string' ? body.message : '');
    if ([401, 403].includes(response.status)) {
        return record('invalid-credential', 'provider-rejected-credential', `HTTP ${response.status}; the provider rejected the invalid key, so the request reached it`, { status: response.status });
    }
    // MEASURED 2026-11-01: api.deepseek.com answers an invalid key with its own 401-shaped JSON, and this route
    // surfaces it as HTTP 500 with the provider's body (pinned's DeepSeek branch forwards the parsed error). The
    // transport claim is still "the provider answered", so the classifier reads the PROVIDER MESSAGE, not the
    // status alone -- and checks the transport-cause vocabulary FIRST so a thrown fetch can never be mistaken for
    // a credential rejection.
    if (providerMessage && /auth|api[ _-]?key|invalid|unauthor|forbidden|permission|credential/i.test(String(providerMessage)) && !TRANSPORT_CAUSE.test(String(providerMessage))) {
        return record('invalid-credential', 'provider-rejected-credential', `HTTP ${response.status} with the provider's own authentication error ${JSON.stringify(redact(String(providerMessage).slice(0, 160)))}; the request reached the provider`, { status: response.status });
    }
    if (body?.error === true && providerMessage && !TRANSPORT_CAUSE.test(providerMessage)) {
        return record('invalid-credential', 'provider-rejected-credential', `HTTP ${response.status} with the provider's own error ${JSON.stringify(redact(providerMessage.slice(0, 160)))}`, { status: response.status });
    }
    const cause = transportCauseOf(response);
    if (cause) return record('invalid-credential', 'transport-failure', `the request never reached the provider: ${JSON.stringify(cause)}`, { status: response.status });
    return record('invalid-credential', 'unclassified', `HTTP ${response.status} is neither a credential rejection nor a transport failure: ${redact(response.text.slice(0, 240))}`, { status: response.status });
}

async function probeProxyControl(binary, provider) {
    // The proxy is CONFIGURED (not the environment) to a port that was just closed. If the product ignored the
    // setting, the request would go direct and could succeed; it must instead fail with a proxy/connect cause.
    const deadPort = await freePort();
    const server = await bootServer(binary, ['--requestProxyEnabled', 'true', '--requestProxyUrl', `http://127.0.0.1:${deadPort}`]);
    try {
        const session = await openSession(server.origin);
        await storeSecret(server.origin, session, 'api_key_deepseek', 'sk-gotavern-canary-invalid-000000000000000000');
        let response;
        try {
            response = await generate(server.origin, session, generateBody(), 60_000);
        } catch (error) {
            return record('proxy-control-refused', 'transport-failure', `the route did not answer within its bound (${error?.name ?? 'error'})`);
        }
        const cause = transportCauseOf(response);
        if (cause && /proxy|connect|refused/i.test(cause)) {
            return record('proxy-control-refused', 'ok', `a configured dead proxy produced a causal failure naming the proxy/connect stage: ${JSON.stringify(cause)}`, { status: response.status });
        }
        if (cause) {
            return record('proxy-control-refused', 'transport-failure', `the failure did not name the proxy/connect stage: ${JSON.stringify(cause)}`, { status: response.status });
        }
        return record('proxy-control-refused', 'transport-failure', `a configured dead proxy did NOT fail the request, so the proxy setting is not honoured: HTTP ${response.status} ${redact(response.text.slice(0, 200))}`, { status: response.status });
    } finally {
        stopServer(server);
    }
}

async function probeProxyCompletion(binary) {
    const server = await bootServer(binary, ['--requestProxyEnabled', 'true', '--requestProxyUrl', proxyUrl, ...(proxyBypass ? ['--requestProxyBypass', ...proxyBypass.split(/\s+/)] : [])]);
    try {
        const session = await openSession(server.origin);
        await storeSecret(server.origin, session, 'api_key_deepseek', providerKey);
        const started = Date.now();
        let response;
        try {
            response = await generate(server.origin, session, generateBody());
        } catch (error) {
            return record('proxy-completion', 'transport-failure', `the route did not answer within its bound (${error?.name ?? 'error'})`);
        }
        const elapsed = Date.now() - started;
        const body = parsed(response.text);
        const content = body?.choices?.[0]?.message?.content;
        if (response.status === 200 && typeof content === 'string' && content.trim().length > 0) {
            return record('proxy-completion', 'ok', `${elapsed} ms through the configured proxy, HTTP 200, ${content.trim().length} chars`, { status: 200, latencyMs: elapsed });
        }
        const cause = transportCauseOf(response);
        if (cause) return record('proxy-completion', 'transport-failure', `the request through the configured proxy never reached ${PROVIDER_HOST}: ${JSON.stringify(cause)}`, { status: response.status });
        return record('proxy-completion', 'provider-refused', `HTTP ${response.status} through the proxy without a completion: ${redact(response.text.slice(0, 240))}`, { status: response.status });
    } finally {
        stopServer(server);
    }
}

async function probeStreaming(server) {
    const session = await openSession(server.origin);
    await storeSecret(server.origin, session, 'api_key_deepseek', providerKey);
    let response;
    try {
        response = await call(server.origin, GENERATE_ROUTE, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.token },
            body: JSON.stringify(generateBody({ stream: true })),
            timeoutMs: REQUEST_TIMEOUT_MS,
        });
    } catch (error) {
        return record('streaming', 'transport-failure', `the streaming route did not answer within its bound (${error?.name ?? 'error'})`);
    }
    if (response.status !== 200) {
        return record('streaming', 'transport-failure', `the streaming route answered HTTP ${response.status}: ${redact(response.text.slice(0, 200))}`, { status: response.status });
    }
    const frames = response.text.split('\n\n').filter(frame => frame.trim().length > 0);
    const terminated = /data:\s*\[DONE\]\s*$/.test(response.text.trimEnd());
    if (frames.length === 0) return record('streaming', 'empty-response', 'HTTP 200 with no SSE frames', { status: 200, frames: 0 });
    if (!terminated) return record('streaming', 'transport-failure', `${frames.length} SSE frame(s) without a clean [DONE] terminator`, { status: 200, frames: frames.length });
    return record('streaming', 'ok', `${frames.length} SSE frame(s) with a clean [DONE] terminator`, { status: 200, frames: frames.length });
}

async function probeMidStreamCancel(server) {
    const session = await openSession(server.origin);
    await storeSecret(server.origin, session, 'api_key_deepseek', providerKey);
    const controller = new AbortController();
    let firstChunk = false;
    try {
        const response = await fetch(`${server.origin}${GENERATE_ROUTE}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: session.cookie, 'X-CSRF-Token': session.token },
            body: JSON.stringify(generateBody({ stream: true })),
            signal: controller.signal,
        });
        if (response.status !== 200) {
            return record('mid-stream-cancel', 'transport-failure', `the streaming route answered HTTP ${response.status} before a frame could be cancelled`, { status: response.status });
        }
        const reader = response.body.getReader();
        try {
            const first = await reader.read();
            firstChunk = !first.done;
        } finally {
            controller.abort();
            try { await reader.cancel(); } catch { /* already cancelled */ }
        }
    } catch (error) {
        if (!firstChunk && error?.name !== 'AbortError') {
            return record('mid-stream-cancel', 'transport-failure', `the stream failed before a frame arrived (${error?.name ?? 'error'})`);
        }
    }
    // The server must remain responsive after the client aborted mid-stream.
    try {
        const version = await call(server.origin, '/version', { timeoutMs: 10_000 });
        if (version.status === 200) {
            return record('mid-stream-cancel', firstChunk ? 'ok' : 'not-observed', firstChunk
                ? 'the client aborted after the first frame and the server stayed responsive (GET /version -> 200)'
                : 'no frame arrived before the abort, so the mid-stream half was not observed; the server stayed responsive', { status: 200 });
        }
        return record('mid-stream-cancel', 'transport-failure', `the server did not answer /version after the abort: HTTP ${version.status}`);
    } catch (error) {
        return record('mid-stream-cancel', 'transport-failure', `the server did not answer /version after the abort (${error?.name ?? 'error'})`);
    }
}

async function probeDnsFailure(server) {
    const session = await openSession(server.origin);
    await storeSecret(server.origin, session, 'api_key_custom', 'sk-gotavern-canary-invalid-000000000000000000');
    let response;
    try {
        response = await generate(server.origin, session, generateBody({
            chat_completion_source: 'custom',
            custom_url: 'https://gotavern-canary-does-not-exist.invalid/v1',
            model: 'canary',
        }), 60_000);
    } catch (error) {
        return record('dns-failure', 'transport-failure', `the route did not answer within its bound (${error?.name ?? 'error'})`);
    }
    const body = parsed(response.text);
    const message = body?.message ?? body?.error?.message ?? '';
    if (/dns|no such host|name resolution|lookup/i.test(String(message))) {
        return record('dns-failure', 'ok', `a .invalid host failed with a causal DNS message: ${JSON.stringify(redact(String(message).slice(0, 200)))}`, { status: response.status });
    }
    return record('dns-failure', 'transport-failure', `a .invalid host did not produce a causal DNS message: HTTP ${response.status} ${redact(response.text.slice(0, 240))}`, { status: response.status });
}

async function probeIPv6(binary) {
    if (SKIP_IPV6) return record('ipv6', 'skipped', 'GOTAVERN_CANARY_NO_IPV6=1');
    let addresses = [];
    try {
        addresses = await dns.resolve6(PROVIDER_HOST);
    } catch {
        addresses = [];
    }
    if (addresses.length === 0) {
        return record('ipv6', 'not-observed', `${PROVIDER_HOST} publishes no AAAA record from this runner, so an IPv6 path cannot be exercised here; the IPv4 path is covered by direct-completion`);
    }
    const server = await bootServer(binary, ['--enableIPv6', 'true', '--dnsPreferIPv6', 'true']);
    try {
        const session = await openSession(server.origin);
        await storeSecret(server.origin, session, 'api_key_deepseek', providerKey);
        let response;
        try {
            response = await generate(server.origin, session, generateBody());
        } catch (error) {
            return record('ipv6', 'transport-failure', `the IPv6-preferring boot did not answer within its bound (${error?.name ?? 'error'})`);
        }
        const body = parsed(response.text);
        const content = body?.choices?.[0]?.message?.content;
        if (response.status === 200 && typeof content === 'string' && content.trim().length > 0) {
            return record('ipv6', 'ok', `IPv6 preference enabled (${addresses.length} AAAA record(s)); a real completion came back`, { status: 200, aaaaRecords: addresses.length });
        }
        const cause = transportCauseOf(response);
        return record('ipv6', cause ? 'transport-failure' : 'provider-refused', `IPv6-preferring boot: HTTP ${response.status} ${redact(String(cause || response.text.slice(0, 200)))}`, { status: response.status, aaaaRecords: addresses.length });
    } finally {
        stopServer(server);
    }
}

// Properties the ROUTE does not expose, or a provider condition we must not force. Each names the local gate
// that drives it deterministically, so this report never implies more than it measured.
function recordNotObserved() {
    record('decompression', 'not-observed', 'the route exposes neither the provider response headers nor whether a body was compressed, so a live provider that happens to compress cannot be distinguished from one that does not; gated by TestProductionTransportDecompressesGzipJSON and its deflate/chunked siblings');
    record('keep-alive', 'not-observed', 'connection reuse is not observable through the HTTP route; gated by TestProductionTransportKeepAliveFollowsTheConfigKey');
    record('redirect-following', 'not-observed', 'no stable OpenAI-compatible endpoint was available that redirects, and forcing one would test a third party rather than the product; bounded redirect policy gated by TestProductionTransportFollowsARedirect and TestProductionTransportGivesUpAfterRepeatedRedirects');
    record('connect-header-timeouts', 'not-observed', 'forcing a connect/header timeout against a real provider requires a black-holed address and would spend 30-120 s per probe; gated deterministically by TestProductionTransportAttributesATimeoutToTheHeaderStage and TestProductionTransportNamesAConnectRefusal');
    record('rate-limit-5xx', 'not-observed', '429/5xx are provider conditions that cannot be produced without abusing the provider; error mapping is gated against recorded provider answers in the differential corpus');
}

function stopServer(server) {
    if (server?.child && server.child.exitCode === null) server.child.kill('SIGTERM');
    if (server?.installRoot) {
        try { rmSync(server.installRoot, { recursive: true, force: true }); } catch { /* Windows handle may outlive the kill briefly */ }
    }
}

// -----------------------------------------------------------------------------------------------------------
// Self-test: the secret handling and the verdict mapping are the two places this script could lie. Both are
// exercised WITHOUT the network so a maintainer can run them anywhere.
// -----------------------------------------------------------------------------------------------------------
function selftest() {
    const results = [];
    const check = (name, condition, detail) => {
        results.push({ name, ok: Boolean(condition), detail });
        log(`${condition ? 'PASS' : 'FAIL'} ${name}${condition ? '' : ` -- ${detail}`}`);
    };
    const synthetic = 'sk-gotavern-selftest-secret-0123456789';
    const syntheticProxy = 'http://proxy-user:proxy-pass@proxy.example:3128';
    secrets.push(synthetic, syntheticProxy, 'proxy-pass');
    check('redact removes a provider secret', !redact(`body ${synthetic} tail`).includes(synthetic));
    check('redact removes a proxy URL and its password', !redact(`${syntheticProxy} proxy-pass`).includes('proxy-pass') && !redact(syntheticProxy).includes('proxy.example'));
    check('a transport cause is recognised', TRANSPORT_CAUSE.test('proxy CONNECT for provider api.deepseek.com failed: dial tcp 127.0.0.1:9: connect: connection refused'));
    check('a provider refusal is not a transport cause', !TRANSPORT_CAUSE.test('Incorrect API key provided: sk-***'));
    const report = JSON.stringify({ probes: [{ detail: redact(`leak ${synthetic}`) }] });
    check('the serialized report carries no secret', !report.includes(synthetic));
    const failed = results.filter(result => !result.ok).length;
    log(`live-canary selftest: ${results.length - failed}/${results.length} check(s) green`);
    return failed === 0 ? 0 : 1;
}

// -----------------------------------------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------------------------------------
function writeReport(report) {
    if (!REPORT_PATH) return;
    mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
    const text = `${JSON.stringify(report, null, 2)}\n`;
    const leaked = secrets.filter(secret => secret.length >= 6 && text.includes(secret));
    if (leaked.length > 0) {
        throw new Error(`refusing to write the report: ${leaked.length} secret(s) would appear in it`);
    }
    writeFileSync(REPORT_PATH, text, 'utf8');
    const readBack = readFileSync(REPORT_PATH, 'utf8');
    if (readBack !== text) throw new Error('report read-back mismatch');
    log(`report written to ${REPORT_PATH} (${text.length} bytes, secret-scan clean)`);
}

async function main() {
    if (SELFTEST) {
        process.exitCode = selftest();
        return;
    }

    const report = {
        schemaVersion: 1,
        probe: 'live-provider-proxy-canary',
        provider: { source: 'deepseek', host: PROVIDER_HOST, model: MODEL },
        credentials: { provider: hasProviderCredential, proxy: hasProxyCredential },
        skipped: false,
        probes: [],
        notObserved: [],
        secretScan: { checked: true, clean: true },
    };

    if (!hasProviderCredential && !REACHABILITY) {
        const reason = hasProxyCredential
            ? 'GOTAVERN_CANARY_PROXY_URL is set but DEEPSEEK_API_KEY is absent, and no completion can be claimed without a provider credential'
            : 'DEEPSEEK_API_KEY and GOTAVERN_CANARY_PROXY_URL are both absent';
        log(`SKIPPED: no credential (${reason}). This run measured NOTHING about the provider path and must not be read as a pass.`);
        report.skipped = true;
        report.skipReason = redact(reason);
        writeReport(report);
        if (REQUIRE_CREDENTIALS) {
            console.error('FAILED: --require-credentials was requested but the provider credential is absent, so a credentialed run could not happen.');
            process.exitCode = 2;
        }
        return;
    }

    if (!hasProviderCredential) {
        // Reachability mode: the probes that need no credential, and nothing that would claim a completion.
        log('REACHABILITY MODE (--reachability): no provider credential, so NO completion claim is made. Running the no-key probes only: invalid-credential, dns-failure, proxy-control-refused.');
        report.mode = 'reachability';
        report.credentialed = false;
        const binary = resolveBinary();
        let server = null;
        try {
            server = await bootServer(binary);
            await probeInvalidCredential(server);
            await probeDnsFailure(server);
            await probeProxyControl(binary);
            record('direct-completion', 'skipped', 'no provider credential: a completion cannot be claimed');
            record('streaming', 'skipped', 'no provider credential');
            record('mid-stream-cancel', 'skipped', 'no provider credential');
            record('proxy-completion', 'skipped', 'no provider credential');
            record('ipv6', 'skipped', 'no provider credential');
            recordNotObserved();
            report.notObserved = probes.filter(entry => entry.verdict === 'not-observed').map(entry => entry.name);
        } finally {
            stopServer(server);
        }
        report.probes = probes;
        const reachabilityFailures = probes.filter(entry => entry.verdict === 'transport-failure' || entry.verdict === 'unclassified');
        report.verdict = reachabilityFailures.length > 0 ? 'transport-failure' : 'reachability-only';
        writeReport(report);
        if (reachabilityFailures.length > 0) {
            fail(`REACHABILITY CANARY FAILED: ${reachabilityFailures.map(entry => entry.name).join(', ')}`);
            return;
        }
        log('REACHABILITY CANARY: the no-key probes measured the production path; this is NOT a completion claim and the default (no --reachability) behaviour is still SKIP.');
        return;
    }

    log(`live provider + proxy canary: provider=${PROVIDER_HOST} model=${MODEL}, proxy=${hasProxyCredential ? 'configured (value never printed)' : 'not configured'}, credential present (value never printed)`);
    report.mode = 'credentialed';
    report.credentialed = true;
    const binary = resolveBinary();
    let server = null;
    try {
        server = await bootServer(binary);
        await probeDirectCompletion(server);
        await probeInvalidCredential(server);
        await probeStreaming(server);
        await probeMidStreamCancel(server);
        await probeDnsFailure(server);
        await probeProxyControl(binary);
        if (hasProxyCredential) {
            await probeProxyCompletion(binary);
        } else {
            record('proxy-completion', 'skipped', 'GOTAVERN_CANARY_PROXY_URL is absent, so the proxy completion path was not exercised; proxy-control-refused still proves a CONFIGURED proxy is honoured');
        }
        await probeIPv6(binary);
        recordNotObserved();
        report.notObserved = probes.filter(entry => entry.verdict === 'not-observed').map(entry => entry.name);
    } finally {
        stopServer(server);
    }

    report.probes = probes;
    const transportFailures = probes.filter(entry => entry.verdict === 'transport-failure' || entry.verdict === 'empty-response' || entry.verdict === 'unclassified');
    report.verdict = transportFailures.length > 0 ? 'transport-failure' : probes.some(entry => entry.verdict === 'ok' || entry.verdict.startsWith('provider-')) ? 'measured' : 'not-observed';
    writeReport(report);
    if (transportFailures.length > 0) {
        fail(`LIVE CANARY FAILED: ${transportFailures.length} transport-shaped failure(s): ${transportFailures.map(entry => entry.name).join(', ')}`);
        return;
    }
    log(`LIVE CANARY: ${probes.filter(entry => entry.verdict === 'ok' || entry.verdict.startsWith('provider-')).length} probe(s) measured the production path; ${probes.filter(entry => entry.verdict === 'not-observed' || entry.verdict === 'skipped').length} reported not-observed/skipped with the local gate that covers it`);
}

await main();
