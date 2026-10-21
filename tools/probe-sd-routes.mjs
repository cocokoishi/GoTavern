#!/usr/bin/env node
// Capture the pinned non-generate /api/sd behaviour: the SD-WebUI/comfy/sdcpp/drawthings
// request/response mapping, the comfy workflow CRUD filesystem semantics, and the
// hardcoded-host model-list routes.
//
// SCOPE. src/endpoints/stable-diffusion.js exposes 53 POST routes under /api/sd. The 19
// `*/generate*` routes are out of scope for this domain and stay unimplemented; the 34 routes
// captured here are the rest:
//
//   root:        ping, upscalers, vaes, samplers, schedulers, models, get-model, set-model,
//                sd-next/upscalers
//   comfy:       ping, samplers, models, schedulers, vaes, workflows, workflow, save-workflow,
//                delete-workflow, rename-workflow
//   comfyrunpod: ping
//   sdcpp:       ping, models
//   drawthings:  ping, get-model, get-upscaler
//   model lists: together/models, chutes/models, electronhub/models, electronhub/sizes,
//                nanogpt/models, aimlapi/models, workersai/models, pollinations/models,
//                falai/models
//
// HOW THE PINNED CODE IS DRIVEN. The pinned server is started unmodified from its own checkout.
// Routes whose upstream is a value in the request body (`request.body.url`) are pointed at a
// local mock peer. Routes that hardcode a third-party URL cannot be pointed anywhere by the
// request, so a `--require` hook rewrites `https.request` for an explicit host allowlist onto
// the same local mock. That is the only way to observe those routes against a controlled peer
// without editing the oracle; the hook lives in the temporary runtime directory and is
// deleted with it.
//
// WHAT IS RECORDED. Every scenario records the full HTTP response observed at the browser, and
// every request the mock peer received (method, raw target, header lines in wire order and
// body). Each observation carries its own machine-readable classification: `compared` fields
// are asserted against the recorded value by the Go replay test, `shape` fields are asserted for
// presence/type only and the fixture says why. The single `shape` field is the `connection`
// header, which is framing chosen by the shared outbound client rather than by the route.
//
// DETERMINISM. The two fixtures are reviewed by tools/build-generated-lib.mjs, which runs every
// declared probe twice and compares the bytes. Ephemeral mock ports are normalised to <mock>,
// closed-port scenarios to <closed>, scenarios whose upstream calls are concurrent record their
// requests sorted, and the workflow sort order is only recorded under an English default locale
// (the probe refuses to run under any other, rather than record host-specific collation).
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-sd-routes.json label="SD non-generate routes"
// @gotavern-oracle: fixture=sillytavern-1.19.0-sd-workflows.json label="comfy workflow CRUD" args=workflows

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const COOKIE_SECRET = 'gotavern-pinned-sd-cookie-secret';
const SOURCE_ROOT = path.resolve(process.argv[2] ?? '');
const REPOSITORY_ROOT = path.resolve(process.argv[3] ?? '');
const MODE = process.argv[4] ?? 'routes';
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-sd-routes.mjs <pinned-source-clone> <gotavern-root> [routes|workflows]');
    process.exit(2);
}
if (MODE !== 'routes' && MODE !== 'workflows') {
    console.error(`unknown mode: ${MODE}`);
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: SOURCE_ROOT, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

// The workflow list is sorted with Intl.Collator(), whose default locale comes from the host.
// Recording that order under an unexpected locale would bake a host property into the fixture,
// so refuse instead.
const collatorLocale = new Intl.Collator().resolvedOptions().locale;
if (!collatorLocale.toLowerCase().startsWith('en')) {
    throw new Error(`default Intl locale is ${collatorLocale}; this probe records Intl.Collator order and only supports an English default locale`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-sd-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const hookPath = path.join(runtimeRoot, 'sd-fetch-hook.cjs');
const userRoot = path.join(dataRoot, 'default-user');
const workflowsRoot = path.join(userRoot, 'user', 'workflows');
const secretsPath = path.join(userRoot, 'secrets.json');
const logs = [];
let child;
let peer;

const SECRETS = {
    api_key_togetherai: 'probe-together-key',
    api_key_chutes: 'probe-chutes-key',
    api_key_electronhub: 'probe-electronhub-key',
    api_key_nanogpt: 'probe-nanogpt-key',
    api_key_aimlapi: 'probe-aimlapi-key',
    api_key_workers_ai: 'probe-workers-key',
    api_key_comfy_runpod: 'probe-runpod-key',
};

// Hosts the pinned routes hardcode. Only these are rewritten onto the local mock; every other
// outbound request is passed through untouched.
const REWRITTEN_HOSTS = [
    'api.together.xyz',
    'api.chutes.ai',
    'api.electronhub.ai',
    'nano-gpt.com',
    'api.aimlapi.com',
    'api.cloudflare.com',
    'gen.pollinations.ai',
    'fal.ai',
    'queue.fal.run',
];

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-sd-oracle-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function choosePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

async function closedPort() {
    return choosePort();
}

async function stopServer() {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGINT');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        sleep(5000),
    ]);
    if (child.exitCode === null) child.kill();
}

async function request(url, method = 'GET', headers = {}, body) {
    const response = await fetch(url, {
        method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000),
    });
    const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
    return { response, text };
}

function cookiesFrom(response) {
    if (typeof response.headers.getSetCookie !== 'function') throw new Error('Node fetch does not expose getSetCookie()');
    return response.headers.getSetCookie();
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

function rawHeaders(rawHeadersList) {
    const headers = [];
    for (let index = 0; index < rawHeadersList.length; index += 2) {
        headers.push({ name: rawHeadersList[index], value: rawHeadersList[index + 1] });
    }
    return headers;
}

// The mock peer answers a script keyed by "METHOD <pathname>". Each key consumes its responses
// in order; running past the script answers 500 with an explicit body so a scenario that calls
// more than it declared fails loudly instead of silently reusing an earlier reply.
class Peer {
    constructor() {
        this.script = new Map();
        this.requests = [];
        this.server = null;
        this.origin = '';
    }

    start(port) {
        return new Promise((resolve, reject) => {
            this.server = http.createServer((incoming, outgoing) => this.handle(incoming, outgoing));
            this.server.once('error', reject);
            this.server.listen(port, '127.0.0.1', () => {
                const address = this.server.address();
                this.origin = `http://127.0.0.1:${address.port}`;
                resolve(address.port);
            });
        });
    }

    reset(script = {}) {
        this.script = new Map();
        for (const [key, responses] of Object.entries(script)) {
            this.script.set(key, responses.map(response => ({ ...response, headers: { ...(response.headers ?? {}) } })));
        }
        this.requests = [];
    }

    handle(incoming, outgoing) {
        const chunks = [];
        incoming.on('data', chunk => chunks.push(chunk));
        incoming.on('end', () => {
            const bodyText = Buffer.concat(chunks).toString('utf8');
            const parsed = new URL(incoming.url, 'http://mock');
            this.requests.push({
                method: incoming.method,
                target: incoming.url,
                headers: rawHeaders(incoming.rawHeaders),
                bodyText,
            });
            const key = `${incoming.method} ${parsed.pathname}`;
            const queue = this.script.get(key);
            const response = queue && queue.length > 0
                ? queue.shift()
                : { status: 500, headers: {}, body: `mock peer has no scripted response for ${key}` };
            const headers = { ...(response.headers ?? {}) };
            const payload = response.body ?? '';
            if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-length')) {
                headers['Content-Length'] = String(Buffer.byteLength(payload));
            }
            outgoing.writeHead(response.status ?? 200, headers);
            outgoing.end(payload);
        });
    }

    recording() {
        return this.requests.map(entry => ({ ...entry }));
    }

    close() {
        if (this.server) this.server.close();
    }
}

function normaliseValue(value, replacements) {
    let result = value;
    for (const [needle, replacement] of replacements) {
        result = result.split(needle).join(replacement);
    }
    return result;
}

function captureResponse(result, replacements) {
    return {
        status: result.response.status,
        contentType: result.response.headers.get('content-type'),
        contentLength: result.response.headers.get('content-length'),
        etag: result.response.headers.get('etag'),
        body: normaliseValue(result.text, replacements),
    };
}

function sdComparison(shapeOverrides = {}) {
    const comparison = {
        compared: ['status', 'contentType', 'contentLength', 'etag', 'body', 'requests', 'requestHeaders', 'requestBody'],
        shape: ['requestHeaders.connection'],
        shapeReason: {
            'requestHeaders.connection': 'keep-alive framing chosen by Node/ node-fetch for the pinned run and by the shared outbound client for Go; the route never sets it, so only its presence is asserted',
        },
    };
    for (const [key, reason] of Object.entries(shapeOverrides)) {
        comparison.compared = comparison.compared.filter(entry => entry !== key);
        comparison.shape.push(key);
        comparison.shapeReason[key] = reason;
    }
    return comparison;
}

function seedFixture() {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    mkdirSync(userRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\n');
    writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
        key: 'user:default-user',
        value: {
            handle: 'default-user', name: 'SD Writer', created: 1700000000000,
            password: '', admin: true, enabled: true, salt: '',
        },
    }));
    writeSecrets();
    mkdirSync(workflowsRoot, { recursive: true });
}

let currentSecretValues = { ...SECRETS };

function currentSecrets() {
    return { ...currentSecretValues };
}

function writeSecrets(overrides = {}) {
    currentSecretValues = { ...SECRETS, ...overrides };
    const secrets = {};
    for (const [key, value] of Object.entries(currentSecretValues)) {
        secrets[key] = [{ id: `probe-id-${key}`, value, label: key, active: true }];
    }
    writeFileSync(secretsPath, JSON.stringify(secrets));
}

function writeFetchHook() {
    writeFileSync(hookPath, [
        "'use strict';",
        "// Generated by tools/probe-sd-routes.mjs. Rewrites https.request for an explicit host",
        "// allowlist onto the local mock peer so the pinned routes with hardcoded third-party URLs",
        "// can be observed against a controlled peer. Deleted with the probe runtime directory.",
        "const http = require('node:http');",
        "const https = require('node:https');",
        "const hosts = new Set((process.env.GOTAVERN_SD_PROBE_HOSTS || '').split(',').filter(Boolean));",
        "const port = Number(process.env.GOTAVERN_SD_PROBE_PORT || '0');",
        "const original = https.request;",
        "https.request = function patched(url, options, callback) {",
        "  let cb = callback;",
        "  let opts = options;",
        "  if (typeof opts === 'function') { cb = opts; opts = {}; }",
        "  const parsed = typeof url === 'string' ? new URL(url) : url;",
        "  if (!port || !parsed || !hosts.has(parsed.hostname)) return original.call(this, url, opts, cb);",
        "  const local = Object.assign({}, opts);",
        "  delete local.agent;",
        "  delete local.servername;",
        "  delete local.rejectUnauthorized;",
        "  local.protocol = 'http:';",
        "  local.hostname = '127.0.0.1';",
        "  local.host = '127.0.0.1:' + port;",
        "  local.port = port;",
        "  local.path = parsed.pathname + parsed.search;",
        "  return http.request(local, cb);",
        "};",
        '',
    ].join('\n'));
}

async function startPinnedServer(options = {}) {
    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    const environment = { ...process.env, NODE_ENV: 'test', LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8' };
    if (options.fetchHook) {
        if (hookPath.includes(' ')) throw new Error(`temporary hook path contains a space and cannot be passed through NODE_OPTIONS: ${hookPath}`);
        environment.NODE_OPTIONS = `--require ${hookPath}`;
        environment.GOTAVERN_SD_PROBE_HOSTS = REWRITTEN_HOSTS.join(',');
        environment.GOTAVERN_SD_PROBE_PORT = String(options.mockPort);
    }
    child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: SOURCE_ROOT, env: environment, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));
    const deadline = Date.now() + 180000;
    let ready = false;
    let lastError;
    while (Date.now() < deadline && !ready) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before readiness:\n${logs.join('').slice(-10000)}`);
        try {
            const result = await request(`${origin}/login?noauto=1`);
            ready = result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html');
            if (!ready) lastError = new Error(`login returned ${result.response.status}`);
        } catch (error) {
            lastError = error;
        }
        if (!ready) await sleep(500);
    }
    if (!ready) throw new Error(`pinned server did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-10000)}`);
    return origin;
}

async function login(origin) {
    const csrf = await request(`${origin}/csrf-token`);
    const token = JSON.parse(csrf.text).token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const result = await request(`${origin}/api/users/login`, 'POST', {
        Cookie: csrfCookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: '' }));
    if (result.response.status !== 200) {
        throw new Error(`could not login: ${result.response.status} ${result.text}\n${logs.join('').slice(-10000)}`);
    }
    return { token, sessionCookie: cookieHeader(cookiesFrom(result.response)) };
}

function cloneBody(body) {
    return JSON.parse(JSON.stringify(body ?? {}));
}

function routeScenarios(origin, auth) {
    let activeRawBody = null;
    const post = async route => {
        const payload = activeRawBody ?? JSON.stringify(activeBody);
        const result = await request(`${origin}/api/sd/${route}`, 'POST', {
            Cookie: auth.sessionCookie,
            'Content-Type': activeContentType,
            'X-CSRF-Token': auth.token,
        }, payload);
        return result;
    };
    const observations = {};
    const inputs = {};
    let activeBody = {};
    let activeContentType = 'application/json';
    let replacements = [];
    const run = async (name, route, body, script, options = {}) => {
        peer.reset(script);
        writeSecrets(options.secretOverrides ?? {});
        activeContentType = options.contentType ?? 'application/json';
        activeRawBody = options.rawBody ?? null;
        activeBody = cloneBody(body);
        replacements = [];
        if (options.mock) {
            replacements.push([peer.origin, '<mock>']);
            // The Host header carries the authority without a scheme, so normalise both forms.
            replacements.push([peer.origin.replace('http://', ''), '<mock>']);
            for (const field of options.urlFields ?? ['url']) {
                if (typeof activeBody[field] === 'string' && activeBody[field] === '<mock>') activeBody[field] = peer.origin;
            }
        }
        if (options.closedUrl) {
            replacements.push([options.closedUrl, '<closed>']);
            activeBody.url = options.closedUrl;
        }
        let result;
        try {
            result = await post(route);
        } catch (error) {
            observations[name] = { requestFailed: true, errorName: error?.name ?? 'Error' };
            inputs[name] = { route, body: cloneBody(activeBody) };
            return;
        }
        const recorded = peer.recording().map(entry => ({
            method: entry.method,
            target: normaliseValue(entry.target, replacements),
            headers: entry.headers.map(header => ({
                name: header.name,
                value: normaliseValue(header.value, replacements),
            })),
            bodyText: normaliseValue(entry.bodyText, replacements),
        }));
        if (options.unordered) recorded.sort((left, right) => (left.method + left.target).localeCompare(right.method + right.target));
        const bodyForFixture = cloneBody(activeBody);
        for (const field of options.urlFields ?? ['url']) {
            if (typeof bodyForFixture[field] === 'string' && replacements.some(([needle]) => needle === bodyForFixture[field])) {
                bodyForFixture[field] = '<mock>';
            }
        }
        if (options.closedUrl) bodyForFixture.url = '<closed>';
        observations[name] = {
            ...captureResponse(result, replacements),
            requests: recorded,
            comparison: sdComparison(options.shape),
        };
        inputs[name] = {
            route,
            body: bodyForFixture,
            rawBody: options.rawBody ?? null,
            contentType: activeContentType,
            seam: options.seam ?? null,
            unordered: options.unordered === true,
            peerScript: script,
            // The secret file this scenario ran against. Most scenarios use the full set; the
            // noKey scenarios run with one value emptied, and the Go replay test restores the
            // same file before each step so both servers see identical account state.
            secrets: currentSecrets(),
        };
    };

    const json = body => ({ status: 200, headers: { 'Content-Type': 'application/json' }, body });
    const text = (status, body) => ({ status, headers: { 'Content-Type': 'text/plain' }, body });

    return (async () => {
        // ---- root router: the SD WebUI family ------------------------------------------------
        await run('ping.ok', 'ping', { url: '<mock>', auth: 'user:pass' },
            { 'GET /sdapi/v1/options': [json('{"sd_model_checkpoint":"probe-model"}')] }, { mock: true });

        await run('ping.noAuth', 'ping', { url: '<mock>' },
            { 'GET /sdapi/v1/options': [json('{}')] }, { mock: true });

        await run('ping.nonOk', 'ping', { url: '<mock>', auth: 'user:pass' },
            { 'GET /sdapi/v1/options': [text(500, 'boom')] }, { mock: true });

        await run('ping.redirect', 'ping', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/options': [{ status: 302, headers: { Location: '/final-options' }, body: '' }],
            'GET /final-options': [json('{"sd_model_checkpoint":"redirected"}')],
        }, { mock: true });

        const probeClosed = await closedPort();
        await run('ping.closedPort', 'ping', { url: '<mock>', auth: 'user:pass' }, {}, { closedUrl: `http://127.0.0.1:${probeClosed}` });

        await run('ping.invalidUrl', 'ping', { url: 'not a url', auth: 'user:pass' }, {}, {});

        // A body that is valid JSON but not declared application/json is not parsed by the
        // pinned express.json middleware, so request.body stays empty and the route sees no url.
        await run('ping.textPlainBody', 'ping', { url: '<mock>', auth: 'user:pass' }, {}, { mock: true, contentType: 'text/plain' });

        // express.json rejects a malformed body before the route runs. The status is contract;
        // the error page body is finalhandler's, which is environment specific.
        await run('ping.malformedJson', 'ping', {}, {}, {
            rawBody: '{"url": ',
            shape: {
                contentType: 'finalhandler renders a development error page whose shape depends on NODE_ENV and the thrown SyntaxError text; only the status is contract',
                contentLength: 'same as contentType: the error page length is not contract',
                etag: 'same as contentType: the error page ETag is derived from a non-contract body',
                body: 'same as contentType: the error page body is not contract',
            },
        });

        await run('upscalers.ok', 'upscalers', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/upscalers': [json(JSON.stringify([{ name: 'R-ESRGAN 4x+' }, { name: 'ESRGAN_4x' }]))],
            'GET /sdapi/v1/latent-upscale-modes': [json(JSON.stringify([{ name: 'Latent' }, { name: 'Latent (nearest)' }]))],
        }, { mock: true, unordered: true });

        await run('upscalers.latentNonOk', 'upscalers', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/upscalers': [json(JSON.stringify([{ name: 'ESRGAN_4x' }]))],
            'GET /sdapi/v1/latent-upscale-modes': [text(500, 'boom')],
        }, { mock: true, unordered: true });

        await run('upscalers.notArray', 'upscalers', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/upscalers': [json('{"name":"not-an-array"}')],
            'GET /sdapi/v1/latent-upscale-modes': [json('[]')],
        }, { mock: true, unordered: true });

        await run('vaes.autoFirst', 'vaes', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/sd-vae': [json(JSON.stringify([{ model_name: 'vae-ft-mse' }, { model_name: 'auto-vae' }]))],
            'GET /sdapi/v1/sd-modules': [json(JSON.stringify([{ model_name: 'forge-vae' }]))],
        }, { mock: true, unordered: true });

        await run('vaes.autoFails', 'vaes', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/sd-vae': [text(500, 'boom')],
            'GET /sdapi/v1/sd-modules': [json(JSON.stringify([{ model_name: 'forge-vae' }]))],
        }, { mock: true, unordered: true });

        await run('vaes.forgeNonArrayAutoFulfilled', 'vaes', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/sd-vae': [json('{"model_name":"not-an-array"}')],
            'GET /sdapi/v1/sd-modules': [json(JSON.stringify([{ model_name: 'forge-vae' }]))],
        }, { mock: true, unordered: true });

        await run('vaes.bothFail', 'vaes', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/sd-vae': [text(500, 'boom')],
            'GET /sdapi/v1/sd-modules': [text(503, 'boom')],
        }, { mock: true, unordered: true });

        await run('samplers.ok', 'samplers', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/samplers': [json(JSON.stringify([{ name: 'Euler a' }, { name: 'DPM++ 2M' }]))],
        }, { mock: true });

        await run('schedulers.ok', 'schedulers', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/schedulers': [json(JSON.stringify([{ name: 'Automatic' }, { name: 'Karras' }]))],
        }, { mock: true });

        await run('models.ok', 'models', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/sd-models': [json(JSON.stringify([{ title: 'modelA.safetensors' }, { title: 'modelB.ckpt' }]))],
        }, { mock: true });

        await run('get-model.ok', 'get-model', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/options': [json('{"sd_model_checkpoint":"modelA.safetensors"}')],
        }, { mock: true });

        await run('get-model.nonOkJson', 'get-model', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/options': [{ status: 500, headers: { 'Content-Type': 'application/json' }, body: '{"sd_model_checkpoint":"model-from-error"}' }],
        }, { mock: true });

        await run('get-model.missingField', 'get-model', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/options': [json('{"other":1}')],
        }, { mock: true, shape: {
            contentLength: 'pinned res.send(undefined) ends a bodyless response without Content-Length; Go net/http emits Content-Length: 0 for a bodyless 200, so only the status and empty body are compared',
        } });

        await run('get-model.nullField', 'get-model', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/options': [json('{"sd_model_checkpoint":null}')],
        }, { mock: true });

        await run('get-model.numberField', 'get-model', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/options': [json('{"sd_model_checkpoint":1e21}')],
        }, { mock: true });

        await run('get-model.statusNumberField', 'get-model', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/options': [json('{"sd_model_checkpoint":404}')],
        }, { mock: true });

        await run('get-model.booleanField', 'get-model', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/options': [json('{"sd_model_checkpoint":true}')],
        }, { mock: true });

        await run('get-model.notJson', 'get-model', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/options': [text(200, 'this is not json')],
        }, { mock: true });

        await run('set-model.ok', 'set-model', { url: '<mock>', auth: 'user:pass', model: 'modelB.safetensors' }, {
            'POST /sdapi/v1/options': [{ status: 200, headers: {}, body: '' }],
            'GET /sdapi/v1/progress': [json('{"progress":0,"state":{"job_count":0}}')],
        }, { mock: true });

        await run('set-model.waitsForProgress', 'set-model', { url: '<mock>', auth: 'user:pass', model: 'modelC.safetensors' }, {
            'POST /sdapi/v1/options': [{ status: 200, headers: {}, body: '' }],
            'GET /sdapi/v1/progress': [
                json('{"progress":0.5,"state":{"job_count":1}}'),
                json('{"progress":0,"state":{"job_count":0}}'),
            ],
        }, { mock: true });

        await run('set-model.optionsNonOk', 'set-model', { url: '<mock>', auth: 'user:pass', model: 'modelD.safetensors' }, {
            'POST /sdapi/v1/options': [text(500, 'boom')],
        }, { mock: true });

        await run('set-model.missingModel', 'set-model', { url: '<mock>', auth: 'user:pass' }, {
            'POST /sdapi/v1/options': [{ status: 200, headers: {}, body: '' }],
            'GET /sdapi/v1/progress': [json('{"progress":0,"state":{"job_count":0}}')],
        }, { mock: true });

        await run('set-model.postRedirect', 'set-model', { url: '<mock>', auth: 'user:pass', model: 'modelE.safetensors' }, {
            'POST /sdapi/v1/options': [{ status: 302, headers: { Location: '/final-options' }, body: '' }],
            'GET /final-options': [{ status: 200, headers: {}, body: '' }],
            'GET /sdapi/v1/progress': [json('{"progress":0,"state":{"job_count":0}}')],
        }, { mock: true });

        await run('sd-next-upscalers.ok', 'sd-next/upscalers', { url: '<mock>', auth: 'user:pass' }, {
            'GET /sdapi/v1/upscalers': [json(JSON.stringify([{ name: 'R-ESRGAN 4x+' }, { name: 'SwinIR 4x' }]))],
        }, { mock: true });

        // ---- comfy --------------------------------------------------------------------------
        const objectInfo = {
            KSampler: { input: { required: { sampler_name: [['euler', 'euler_ancestral', 'dpmpp_2m']], scheduler: [['normal', 'karras', 'exponential']] } } },
            VAELoader: { input: { required: { vae_name: [['vae-ft-mse-840000-ema-pruned.safetensors', 'sdxl_vae.safetensors']] } } },
            CheckpointLoaderSimple: { input: { required: { ckpt_name: [['sd_xl_base_1.0.safetensors', 'dreamshaper_8.safetensors']] } } },
            UNETLoader: { input: { required: { unet_name: [['flux1-dev.safetensors']] } } },
            UnetLoaderGGUF: { input: { required: { unet_name: [['flux1-dev-Q4_K_S.gguf']] } } },
        };

        await run('comfy.ping.ok', 'comfy/ping', { url: '<mock>' }, {
            'GET /system_stats': [json('{"system":{"os":"nt"}}')],
        }, { mock: true });

        await run('comfy.ping.nonOk', 'comfy/ping', { url: '<mock>' }, {
            'GET /system_stats': [text(500, 'boom')],
        }, { mock: true });

        await run('comfy.samplers.ok', 'comfy/samplers', { url: '<mock>' }, {
            'GET /object_info': [json(JSON.stringify(objectInfo))],
        }, { mock: true });

        await run('comfy.schedulers.ok', 'comfy/schedulers', { url: '<mock>' }, {
            'GET /object_info': [json(JSON.stringify(objectInfo))],
        }, { mock: true });

        await run('comfy.vaes.ok', 'comfy/vaes', { url: '<mock>' }, {
            'GET /object_info': [json(JSON.stringify(objectInfo))],
        }, { mock: true });

        await run('comfy.models.ok', 'comfy/models', { url: '<mock>' }, {
            'GET /object_info': [json(JSON.stringify(objectInfo))],
        }, { mock: true });

        await run('comfy.models.withoutOptionalLoaders', 'comfy/models', { url: '<mock>' }, {
            'GET /object_info': [json(JSON.stringify({
                CheckpointLoaderSimple: objectInfo.CheckpointLoaderSimple,
                UNETLoader: objectInfo.UNETLoader,
            }))],
        }, { mock: true });

        await run('comfy.samplers.missingPath', 'comfy/samplers', { url: '<mock>' }, {
            'GET /object_info': [json('{}')],
        }, { mock: true });

        // ---- comfy runpod ------------------------------------------------------------------
        await run('comfyrunpod.ping.ok', 'comfyrunpod/ping', { url: '<mock>' }, {
            'GET /health': [json('{"workers":{"ready":1,"idle":0,"running":1}}')],
        }, { mock: true });

        await run('comfyrunpod.ping.noReadyWorkers', 'comfyrunpod/ping', { url: '<mock>' }, {
            'GET /health': [json('{"workers":{"ready":0,"idle":0,"running":0}}')],
        }, { mock: true });

        await run('comfyrunpod.ping.missingWorkers', 'comfyrunpod/ping', { url: '<mock>' }, {
            'GET /health': [json('{}')],
        }, { mock: true });

        await run('comfyrunpod.ping.nonOk', 'comfyrunpod/ping', { url: '<mock>' }, {
            'GET /health': [text(500, 'boom')],
        }, { mock: true });

        await run('comfyrunpod.ping.noKey', 'comfyrunpod/ping', { url: '<mock>' }, {}, { mock: true, secretOverrides: { api_key_comfy_runpod: '' } });

        // ---- stable-diffusion.cpp ----------------------------------------------------------
        await run('sdcpp.ping.ok', 'sdcpp/ping', { url: '<mock>' }, {
            'OPTIONS /v1/images/generations': [text(200, '')],
        }, { mock: true });

        await run('sdcpp.ping.nonOk', 'sdcpp/ping', { url: '<mock>' }, {
            'OPTIONS /v1/images/generations': [text(500, 'boom')],
        }, { mock: true });

        await run('sdcpp.models.ok', 'sdcpp/models', { url: '<mock>' }, {
            'GET /v1/models': [json('{"object":"list","data":[{"id":"sd-v1-4.ckpt"}],"n":1e21,"small":1e-7,"escaped":"<&>","order":{"z":1,"a":2}}')],
        }, { mock: true });

        await run('sdcpp.models.nonOk', 'sdcpp/models', { url: '<mock>' }, {
            'GET /v1/models': [text(500, 'boom')],
        }, { mock: true });

        // ---- drawthings --------------------------------------------------------------------
        await run('drawthings.ping.ok', 'drawthings/ping', { url: '<mock>' }, {
            'HEAD /': [text(200, '')],
        }, { mock: true });

        await run('drawthings.ping.nonOk', 'drawthings/ping', { url: '<mock>' }, {
            'HEAD /': [text(500, 'boom')],
        }, { mock: true });

        await run('drawthings.get-model.ok', 'drawthings/get-model', { url: '<mock>' }, {
            'GET /': [json('{"model":"sd_v1.5_f16.ckpt","upscaler":"realesrgan"}')],
        }, { mock: true });

        await run('drawthings.get-model.missing', 'drawthings/get-model', { url: '<mock>' }, {
            'GET /': [json('{"upscaler":"realesrgan"}')],
        }, { mock: true, shape: {
            contentLength: 'pinned res.send(undefined) ends a bodyless response without Content-Length and the compression middleware then uses chunked framing; Go net/http emits Content-Length: 0 for a bodyless 200, so only the status and empty body are compared',
        } });

        await run('drawthings.get-upscaler.ok', 'drawthings/get-upscaler', { url: '<mock>' }, {
            'GET /': [json('{"model":"sd_v1.5_f16.ckpt","upscaler":"realesrgan_x4"}')],
        }, { mock: true });

        // ---- hardcoded third-party model lists ---------------------------------------------
        await run('together.models.ok', 'together/models', {}, {
            'GET /api/models': [json(JSON.stringify([
                { id: 'black-forest-labs/FLUX.1-schnell', display_name: 'FLUX.1 Schnell', type: 'image' },
                { id: 'meta-llama/Llama-3-8b', display_name: 'Llama 3 8B', type: 'language' },
                { id: 'stabilityai/stable-diffusion-xl', display_name: 'SDXL', type: 'image' },
            ]))],
        }, { mock: true, seam: 'GOTAVERN_SD_TOGETHER_URL' });

        // The missing-key branch answers before any fetch, so these scenarios declare no peer
        // script: an unused script entry would make the replay test's completeness check fail.
        await run('together.models.noKey', 'together/models', {}, {}, { mock: true, seam: 'GOTAVERN_SD_TOGETHER_URL', secretOverrides: { api_key_togetherai: '' } });

        await run('together.models.nonOk', 'together/models', {}, {
            'GET /api/models': [text(500, 'boom')],
        }, { mock: true, seam: 'GOTAVERN_SD_TOGETHER_URL' });

        await run('together.models.notArray', 'together/models', {}, {
            'GET /api/models': [json('{"not":"an array"}')],
        }, { mock: true, seam: 'GOTAVERN_SD_TOGETHER_URL' });

        await run('chutes.models.ok', 'chutes/models', {}, {
            'GET /chutes/': [json(JSON.stringify({ items: [
                { name: 'chutes/flux-dev' }, { name: 'chutes/Anime-XL' }, { name: 'chutes/anima-pencil-xl-v5' },
            ] }))],
        }, { mock: true, seam: 'GOTAVERN_SD_CHUTES_URL' });

        await run('chutes.models.noItems', 'chutes/models', {}, {
            'GET /chutes/': [json('{"total":0}')],
        }, { mock: true, seam: 'GOTAVERN_SD_CHUTES_URL' });

        await run('chutes.models.noKey', 'chutes/models', {}, {}, { mock: true, seam: 'GOTAVERN_SD_CHUTES_URL', secretOverrides: { api_key_chutes: '' } });

        await run('electronhub.models.ok', 'electronhub/models', {}, {
            'GET /v1/models': [json(JSON.stringify({ data: [
                { id: 'flux-schnell', name: 'FLUX Schnell', endpoints: ['/v1/images/generations', '/v1/chat/completions'], value: 'pinned-value', text: 'pinned-text' },
                { id: 'chat-model', name: 'Chat Model', endpoints: ['/v1/chat/completions'] },
                { id: 'no-endpoints', name: 'No endpoints' },
            ] }))],
        }, { mock: true, seam: 'GOTAVERN_SD_ELECTRONHUB_URL' });

        await run('electronhub.models.notArrayData', 'electronhub/models', {}, {
            'GET /v1/models': [json('{"data":"not-an-array"}')],
        }, { mock: true, seam: 'GOTAVERN_SD_ELECTRONHUB_URL' });

        await run('electronhub.models.noKey', 'electronhub/models', {}, {}, { mock: true, seam: 'GOTAVERN_SD_ELECTRONHUB_URL', secretOverrides: { api_key_electronhub: '' } });

        await run('electronhub.sizes.ok', 'electronhub/sizes', { model: 'flux-schnell' }, {
            'GET /v1/models/flux-schnell': [json('{"sizes":["1024x1024","768x1344"]}')],
        }, { mock: true, seam: 'GOTAVERN_SD_ELECTRONHUB_URL' });

        await run('electronhub.sizes.missingSizes', 'electronhub/sizes', { model: 'flux-schnell' }, {
            'GET /v1/models/flux-schnell': [json('{"other":1}')],
        }, { mock: true, seam: 'GOTAVERN_SD_ELECTRONHUB_URL' });

        await run('electronhub.sizes.nonOk', 'electronhub/sizes', { model: 'flux-schnell' }, {
            'GET /v1/models/flux-schnell': [text(500, 'boom')],
        }, { mock: true, seam: 'GOTAVERN_SD_ELECTRONHUB_URL' });

        await run('nanogpt.models.ok', 'nanogpt/models', {}, {
            'GET /api/models': [json(JSON.stringify({ models: { image: {
                a: { model: 'nano-flux', name: 'Nano Flux' },
                b: { model: 'nano-sd', name: 'Nano SD' },
            } } }))],
        }, { mock: true, seam: 'GOTAVERN_SD_NANOGPT_URL' });

        await run('nanogpt.models.imageNotObject', 'nanogpt/models', {}, {
            'GET /api/models': [json('{"models":{"image":"nope"}}')],
        }, { mock: true, seam: 'GOTAVERN_SD_NANOGPT_URL' });

        await run('nanogpt.models.noKey', 'nanogpt/models', {}, {}, { mock: true, seam: 'GOTAVERN_SD_NANOGPT_URL', secretOverrides: { api_key_nanogpt: '' } });

        await run('aimlapi.models.ok', 'aimlapi/models', {}, {
            'GET /v1/models': [json(JSON.stringify({ data: [
                { id: 'flux/dev', type: 'image', info: { name: 'FLUX Dev' } },
                { id: 'triposr', type: 'image', info: { name: 'TripoSR' } },
                { id: 'flux/dev/image-to-image', type: 'image' },
                { id: 'gpt-4o', type: 'language', info: { name: 'GPT-4o' } },
            ] }))],
        }, { mock: true, seam: 'GOTAVERN_SD_AIMLAPI_URL' });

        await run('aimlapi.models.noData', 'aimlapi/models', {}, {
            'GET /v1/models': [json('{}')],
        }, { mock: true, seam: 'GOTAVERN_SD_AIMLAPI_URL' });

        await run('aimlapi.models.noKey', 'aimlapi/models', {}, {}, { mock: true, seam: 'GOTAVERN_SD_AIMLAPI_URL', secretOverrides: { api_key_aimlapi: '' } });

        await run('workersai.models.ok', 'workersai/models', { account_id: ' probe-account ' }, {
            'GET /client/v4/accounts/probe-account/ai/models/search': [json(JSON.stringify({
                success: true,
                result: [{ name: '@cf/black-forest-labs/flux-1-schnell' }, { name: '@cf/stabilityai/stable-diffusion-xl-base-1.0' }],
            }))],
        }, { mock: true, seam: 'GOTAVERN_SD_WORKERSAI_URL' });

        await run('workersai.models.noAccountId', 'workersai/models', {}, {}, { mock: true, seam: 'GOTAVERN_SD_WORKERSAI_URL' });

        await run('workersai.models.notSuccess', 'workersai/models', { account_id: 'probe-account' }, {
            'GET /client/v4/accounts/probe-account/ai/models/search': [json('{"success":false,"result":[]}')],
        }, { mock: true, seam: 'GOTAVERN_SD_WORKERSAI_URL' });

        await run('workersai.models.noKey', 'workersai/models', { account_id: 'probe-account' }, {}, { mock: true, seam: 'GOTAVERN_SD_WORKERSAI_URL', secretOverrides: { api_key_workers_ai: '' } });

        await run('pollinations.models.ok', 'pollinations/models', {}, {
            'GET /image/models': [json(JSON.stringify([{ name: 'flux' }, { name: 'turbo' }]))],
        }, { mock: true, seam: 'GOTAVERN_SD_POLLINATIONS_URL' });

        await run('pollinations.models.notArray', 'pollinations/models', {}, {
            'GET /image/models': [json('{"models":[]}')],
        }, { mock: true, seam: 'GOTAVERN_SD_POLLINATIONS_URL' });

        await run('pollinations.models.nonOk', 'pollinations/models', {}, {
            'GET /image/models': [text(503, 'boom')],
        }, { mock: true, seam: 'GOTAVERN_SD_POLLINATIONS_URL' });

        await run('falai.models.ok', 'falai/models', {}, {
            'GET /api/models': [
                json(JSON.stringify({
                    page: 1,
                    pages: 3,
                    items: [
                        { title: 'Fast SDXL', modelUrl: 'https://fal.run/fal-ai/fast-sdxl' },
                        { title: 'SDXL Inpainting', modelUrl: 'https://fal.run/fal-ai/sdxl-inpainting' },
                        { title: 'ControlNet', modelUrl: 'https://fal.run/fal-ai/controlnet' },
                    ],
                })),
                json(JSON.stringify({
                    page: 2,
                    pages: 3,
                    items: [
                        { title: 'Aura Flow', modelUrl: 'https://fal.run/fal-ai/aura-flow' },
                        { title: 'Upscale Model', modelUrl: 'https://fal.run/fal-ai/upscale' },
                        { title: 'Flux LoRA', modelUrl: 'https://fal.run/fal-ai/flux-lora' },
                    ],
                })),
            ],
        }, { mock: true, seam: 'GOTAVERN_SD_FALAI_URL' });

        await run('falai.models.invalidItems', 'falai/models', {}, {
            'GET /api/models': [json('{"page":1,"pages":1}')],
        }, { mock: true, seam: 'GOTAVERN_SD_FALAI_URL' });

        await run('falai.models.nonOk', 'falai/models', {}, {
            'GET /api/models': [text(500, 'boom')],
        }, { mock: true, seam: 'GOTAVERN_SD_FALAI_URL' });

        return { observations, inputs };
    })();
}

function snapshotWorkflowDirectory(directory) {
    const names = readdirSync(directory).sort();
    // The snapshot order is compared by a Go replay that sorts UTF-8 byte strings, while
    // JavaScript's default sort compares UTF-16 code units. Those orders agree for every name in
    // this fixture, and the guard below refuses to record a set where they would not: a future
    // non-BMP or otherwise unit-order-sensitive name would otherwise make the recording depend on
    // which language sorted it.
    const byteOrder = [...names].sort((left, right) => Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8')));
    if (JSON.stringify(byteOrder) !== JSON.stringify(names)) {
        throw new Error(`workflow snapshot order depends on the sort implementation (UTF-16 vs UTF-8): ${JSON.stringify(names)} vs ${JSON.stringify(byteOrder)}`);
    }
    return names.map(name => {
        const absolute = path.join(directory, name);
        const info = statSync(absolute);
        return {
            name,
            kind: info.isDirectory() ? 'directory' : 'file',
            content: info.isFile() ? readFileSync(absolute).toString('utf8') : null,
        };
    });
}

async function workflowScenarios(origin, auth) {
    // Start from a deliberately empty workflows directory. The probe config sets
    // skipContentCheck, so neutral default content is not seeded, and the Go replay test
    // reproduces the same empty starting state.
    rmSync(workflowsRoot, { recursive: true, force: true });
    mkdirSync(workflowsRoot, { recursive: true });
    mkdirSync(path.join(workflowsRoot, 'dir.json'), { recursive: true });

    const post = async (route, body) => {
        const result = await request(`${origin}/api/sd/${route}`, 'POST', {
            Cookie: auth.sessionCookie,
            'Content-Type': 'application/json',
            'X-CSRF-Token': auth.token,
        }, JSON.stringify(body ?? {}));
        return captureResponse(result, []);
    };
    const steps = [];
    const state = {};
    const step = async (name, route, body) => {
        const response = await post(route, body);
        steps.push({ name, route, body: body ?? {}, response });
        state[name] = snapshotWorkflowDirectory(workflowsRoot);
    };

    await step('workflows.empty', 'comfy/workflows', {});

    await step('saveWorkflow.first', 'comfy/save-workflow', {
        file_name: 'Alpha.json',
        workflow: '{"1":{"class_type":"KSampler","inputs":{"seed":1}}}',
    });

    await step('saveWorkflow.uppercaseExtension', 'comfy/save-workflow', {
        file_name: 'beta.JSON',
        workflow: '{"uppercase":"extension"}',
    });

    await step('saveWorkflow.nonJsonExtension', 'comfy/save-workflow', {
        file_name: 'zeta.txt',
        workflow: 'written but never listed',
    });

    await step('saveWorkflow.hiddenName', 'comfy/save-workflow', {
        file_name: '.hidden.json',
        workflow: '{"hidden":true}',
    });

    // Names in this fixture must be unique under ASCII CASE FOLDING: Windows filesystems are
    // case-insensitive, so recording 'aa.json' and 'AA.json' in one run collapses them into one
    // file there and leaves two files on Linux, which makes the recorded directory contents (and
    // every list response after it) host-dependent. The guard below refuses such a recording.
    for (const [label, name] of [
        ['numericTen', '10.json'],
        ['numericTwo', '2.json'],
        ['leadingUnderscore', '_under.json'],
        ['space', 'a b.json'],
        ['upperA', 'A.json'],
        ['lowerA2', 'aa.json'],
        ['upperAB', 'AB.json'],
        ['unicodeA', 'Ä.json'],
    ]) {
        await step(`saveWorkflow.sort-${label}`, 'comfy/save-workflow', { file_name: name, workflow: `{"name":${JSON.stringify(name)}}` });
    }

    await step('saveWorkflow.missingFileName', 'comfy/save-workflow', { workflow: '{"noFileName":true}' });

    await step('saveWorkflow.emptySanitizedName', 'comfy/save-workflow', { file_name: '/', workflow: '{"emptyName":true}' });

    await step('saveWorkflow.objectWorkflow', 'comfy/save-workflow', { file_name: 'object-workflow.json', workflow: { not: 'a string' } });

    await step('saveWorkflow.numberWorkflow', 'comfy/save-workflow', { file_name: 'number-workflow.json', workflow: 42 });

    await step('saveWorkflow.numberFileName', 'comfy/save-workflow', { file_name: 7, workflow: '{"numberName":true}' });

    await step('saveWorkflow.missingWorkflow', 'comfy/save-workflow', { file_name: 'no-workflow.json' });

    await step('saveWorkflow.nullWorkflow', 'comfy/save-workflow', { file_name: 'null-workflow.json', workflow: null });

    await step('saveWorkflow.arrayWorkflow', 'comfy/save-workflow', { file_name: 'array-workflow.json', workflow: [1, 2, 3] });

    await step('saveWorkflow.reservedName', 'comfy/save-workflow', { file_name: 'CON.json', workflow: '{"reserved":true}' });

    await step('saveWorkflow.pathCharacters', 'comfy/save-workflow', { file_name: '../../escape/evil.json', workflow: '{"traversal":"sanitized"}' });

    await step('workflow.existing', 'comfy/workflow', { file_name: 'Alpha.json' });

    await step('workflow.missingFallsBackToDefaultAbsent', 'comfy/workflow', { file_name: 'not-there.json' });

    await step('saveWorkflow.default', 'comfy/save-workflow', {
        file_name: 'Default_Comfy_Workflow.json',
        workflow: '{"default":"workflow"}',
    });

    await step('workflow.missingFallsBackToDefault', 'comfy/workflow', { file_name: 'not-there.json' });

    await step('workflow.missingFileNameUsesUndefined', 'comfy/workflow', {});

    await step('workflow.pathCharactersSanitized', 'comfy/workflow', { file_name: '../../Alpha.json' });

    await step('deleteWorkflow.existing', 'comfy/delete-workflow', { file_name: 'A.json' });

    await step('deleteWorkflow.missing', 'comfy/delete-workflow', { file_name: 'A.json' });

    await step('deleteWorkflow.noName', 'comfy/delete-workflow', {});

    await step('renameWorkflow.ok', 'comfy/rename-workflow', { old_name: 'beta.JSON', new_name: 'renamed.json' });

    await step('renameWorkflow.missingOld', 'comfy/rename-workflow', { old_name: 'absent.json', new_name: 'renamed2.json' });

    await step('renameWorkflow.newNotJson', 'comfy/rename-workflow', { old_name: 'renamed.json', new_name: 'renamed.txt' });

    await step('renameWorkflow.oldNotJson', 'comfy/rename-workflow', { old_name: 'zeta.txt', new_name: 'zeta.json' });

    await step('renameWorkflow.existingNew', 'comfy/rename-workflow', { old_name: 'renamed.json', new_name: 'aa.json' });

    await step('renameWorkflow.slashInOld', 'comfy/rename-workflow', { old_name: 'a/../renamed.json', new_name: 'slash.json' });

    await step('renameWorkflow.nulInNew', 'comfy/rename-workflow', { old_name: 'renamed.json', new_name: 'nul\u0000name.json' });

    await step('renameWorkflow.sanitizedNoExtension', 'comfy/rename-workflow', { old_name: 'renamed.json', new_name: ':*?"<>|' });

    await step('renameWorkflow.directory', 'comfy/rename-workflow', { old_name: 'dir.json', new_name: 'moved.json' });

    await step('workflows.final', 'comfy/workflows', {});

    // Host-independence guard. A workflow fixture must never create two names that differ only by
    // ASCII case: Windows collapses them into one file (case-insensitive) while Linux keeps both,
    // so the recorded directory contents and every later list response would be host-dependent.
    // This is exactly the defect CI caught in 'sort-upperA2' after a v1 recording used 'aa.json'
    // and 'AA.json' in the same run; refuse to record such a case instead of reproducing it.
    const caseFoldedNames = new Map();
    for (const recorded of steps) {
        if (recorded.route !== 'comfy/save-workflow') continue;
        const fileName = recorded.body.file_name;
        if (fileName === undefined || fileName === null) continue;
        const text = String(fileName);
        const folded = text.toLowerCase();
        const previous = caseFoldedNames.get(folded);
        if (previous !== undefined && previous !== text) {
            throw new Error(`workflow fixture would record a case-insensitive filename collision: ${JSON.stringify(previous)} and ${JSON.stringify(text)}; Windows and Linux would produce different directory contents`);
        }
        caseFoldedNames.set(folded, text);
    }

    return { steps, state, collatorLocale };
}

function baseFixture(probeDescription) {
    return {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: probeDescription,
        oracle: {
            file: 'src/endpoints/stable-diffusion.js',
            mountedAt: '/api/sd (src/server-startup.js:169)',
            scope: 'the 34 non-generate /api/sd routes; the 19 */generate* routes are out of scope',
        },
        inputs: {
            cookieSecret: COOKIE_SECRET,
            account: { handle: 'default-user', name: 'SD Writer', admin: true, password: '' },
            secrets: SECRETS,
        },
    };
}

function writeFixture(name, fixture) {
    const outputFile = path.join(REPOSITORY_ROOT, 'tests', 'oracle', name);
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(REPOSITORY_ROOT, outputFile)} from pinned SD ${MODE} behaviour`);
}

try {
    seedFixture();
    if (MODE === 'routes') {
        peer = new Peer();
        const mockPort = await peer.start(0);
        writeFetchHook();
        const origin = await startPinnedServer({ fetchHook: true, mockPort });
        const auth = await login(origin);
        const { observations, inputs } = await routeScenarios(origin, auth);

        // The one pinned handler in this file without a try/catch is electronhub/sizes. A
        // rejected fetch or json() therefore leaves an unhandled rejection, which Node turns
        // into an uncaught exception and the pinned process exits. Run it last and record what
        // actually happened rather than asserting a shape the pinned code cannot produce.
        writeSecrets();
        peer.reset({ 'GET /v1/models/crash-model': [textResponse(200, 'this is not json')] });
        let thrownOutcome;
        try {
            const result = await request(`${origin}/api/sd/electronhub/sizes`, 'POST', {
                Cookie: auth.sessionCookie,
                'Content-Type': 'application/json',
                'X-CSRF-Token': auth.token,
            }, JSON.stringify({ model: 'crash-model' }));
            thrownOutcome = { requestAnswered: true, status: result.response.status, body: result.text };
        } catch {
            thrownOutcome = { requestAnswered: false };
        }
        await sleep(1000);
        const exited = child.exitCode !== null;
        const knownDifferences = [{
            route: '/api/sd/electronhub/sizes',
            condition: 'the upstream answer is not JSON, or the connection is refused',
            pinned: {
                handlerHasTryCatch: false,
                cause: 'Express 4.21 does not forward a rejected async handler; the unhandled rejection reaches the process-level uncaughtException handler, which exits',
                observed: thrownOutcome,
                serverExited: exited,
                exitCode: exited ? child.exitCode : null,
            },
            gotavern: {
                behaviour: 'answers 500 like the non-2xx branch instead of terminating the server',
                reason: 'a single request must not be able to stop the server; this is the one deliberate deviation in this domain and it only affects the error branch',
            },
        }];

        const fixture = baseFixture('pinned non-generate /api/sd routes driven against a local mock peer');
        fixture.conventions = {
            urlPlaceholders: {
                '<mock>': 'the local mock peer authority used for the run; the Go replay test substitutes its own mock authority',
                '<closed>': 'a loopback port with no listener, used to produce a refused connection deterministically',
            },
            requestHeaderOrder: 'header lines are recorded in wire order; `connection` is the only shape-classified header',
            redirects: 'node-fetch follows up to 20 redirects; the redirect scenarios record every hop the peer received',
        };
        fixture.fixtureFields = {
            compared: [
                'observations.*.status',
                'observations.*.contentType',
                'observations.*.contentLength',
                'observations.*.etag',
                'observations.*.body',
                'observations.*.requests (method, target, order)',
                'observations.*.requests[].headers except connection (name order and value)',
                'observations.*.requests[].bodyText',
            ],
            shape: [
                'observations.*.requests[].headers.connection',
            ],
            shapeReason: {
                'observations.*.requests[].headers.connection': 'keep-alive framing chosen by the outbound transport (Node for the pinned run, the shared outbound client for Go); the route never sets it',
            },
            notRecorded: [
                'the mock peer authority itself (normalised to <mock>) because it is an ephemeral port',
                'the pinned server listen port and its startup log',
            ],
        };
        fixture.inputs.scenarios = inputs;
        fixture.observations = observations;
        fixture.knownDifferences = knownDifferences;
        await stopServer();
        writeFixture('sillytavern-1.19.0-sd-routes.json', fixture);
    } else {
        const origin = await startPinnedServer({});
        const auth = await login(origin);
        const { steps, state, collatorLocale: locale } = await workflowScenarios(origin, auth);
        await stopServer();
        const fixture = baseFixture('pinned comfy workflow CRUD: responses and filesystem mutations');
        fixture.oracle.file = 'src/endpoints/stable-diffusion.js (comfy router, lines 485-560)';
        fixture.inputs.collatorLocale = locale;
        fixture.inputs.startingDirectory = { files: [], note: 'the probe removes user/workflows and recreates it empty, then adds a directory named dir.json' };
        fixture.fixtureFields = {
            compared: [
                'steps[].response.status',
                'steps[].response.contentType',
                'steps[].response.contentLength',
                'steps[].response.etag',
                'steps[].response.body',
                'state[<step>] (sorted name/kind/content after every step)',
            ],
            shape: [],
        };
        fixture.steps = steps;
        fixture.state = state;
        writeFixture('sillytavern-1.19.0-sd-workflows.json', fixture);
    }
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    if (peer) peer.close();
    await stopServer();
    safeCleanup();
}

function textResponse(status, body) {
    return { status, headers: { 'Content-Type': 'text/plain' }, body };
}
