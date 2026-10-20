#!/usr/bin/env node
// Capture pinned tokenizer route behavior: tiktoken, SentencePiece and HF tokenizers.
//
// Every case records the request that produced it and the complete response, so the Go
// replay test needs no side table. The fixture also carries the pinned package versions,
// the SHA-256 of every tokenizer data file, and the commit the five externally fetched
// tokenizers are pinned to, so a capture from a different host fails instead of recording
// a value that only that host would produce.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { gunzipSync } from 'node:zlib';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// Upstream 1.19.0 fetches these from SillyTavern-Tokenizers/raw/main, a mutable branch.
// GoTavern pins the commit below and the fixture records that fact.
const PINNED_TOKENIZERS_REPOSITORY = 'SillyTavern/SillyTavern-Tokenizers';
const PINNED_TOKENIZERS_REF = 'main';
const PINNED_TOKENIZERS_COMMIT = '798bcd823dfd04227a79b487e1cf29e6de9aaece';
const PINNED_TOKENIZER_PACKAGES = {
    'tiktoken': '1.0.22',
    '@agnai/web-tokenizers': '0.1.3',
    '@agnai/sentencepiece-js': '1.1.1',
};
const COOKIE_SECRET = 'gotavern-pinned-tokenizers-cookie-secret';
// @gotavern-oracle: fixture=sillytavern-1.19.0-tokenizers.json label="tokenizers"
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-tokenizers.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const SENTENCEPIECE_MODELS = ['llama', 'nerdstash', 'nerdstash_v2', 'mistral', 'yi', 'gemma', 'jamba'];
const TIKTOKEN_ROUTES = ['gpt2'];
const WEB_MODELS = ['claude', 'llama3', 'qwen2', 'command-r', 'command-a', 'nemo', 'deepseek'];
const EXTERNAL_MODELS = ['qwen2', 'command-r', 'command-a', 'nemo', 'deepseek'];
const LOCAL_TOKENIZER_FILES = [
    'claude.json', 'gemma.model', 'jamba.model', 'llama.model', 'llama3.json',
    'mistral.model', 'nerdstash.model', 'nerdstash_v2.model', 'yi.model',
];
const TIKTOKEN_FILES = [
    'cl100k_base.json', 'gpt2.json', 'model_to_encoding.json', 'o200k_base.json',
    'p50k_base.json', 'p50k_edit.json', 'r50k_base.json', 'registry.json',
];

// The corpus is fixed and ordered: the fixture must be byte-identical across two runs.
const CORE_INPUTS = [
    ['empty', ''],
    ['ascii', 'Hello, world!'],
    ['long_ascii', 'The quick brown fox jumps over the lazy dog. '.repeat(24)],
    ['cjk', '\u3053\u3093\u306b\u3061\u306f\u4e16\u754c'],
    ['emoji', '\ud83d\ude00\ud83e\udd16'],
    ['combining', 'e\u0301a\u0300n\u0303'],
    ['nul', 'a\u0000b'],
    ['crlf', 'a\r\nb'],
    ['trailing_spaces', 'a   '],
    ['only_spaces', '   '],
    ['special_endoftext', 'a<|endoftext|>b'],
    ['added_llama3', 'x<|begin_of_text|>y'],
    ['lone_surrogate', 'a\ud800b'],
];
const FULL_INPUTS = [
    ...CORE_INPUTS,
    ['ascii_punct', "It's a test: 1,234.56 \u2014 ok?"],
    ['japanese', '\u543e\u8f29\u306f\u732b\u3067\u3042\u308b\u3002\u540d\u524d\u306f\u307e\u3060\u7121\u3044\u3002'],
    ['emoji_zwj', '\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67\u200d\ud83d\udc66'],
    ['emoji_skin', '\ud83d\udc4d\ud83c\udffd'],
    ['rtl', '\u0645\u0631\u062d\u0628\u0627 \u0628\u0627\u0644\u0639\u0627\u0644\u0645'],
    ['tabs', 'a\t\tb'],
    ['leading_spaces', '   a'],
    ['mid_spaces', 'a   b'],
    ['whitespace_runs', 'a \n\n\t  b   '],
    ['special_endofprompt', 'a<|endofprompt|>b'],
    ['special_fim', 'a<|fim_prefix|>b'],
    ['added_claude', 'x<EOT>y'],
    ['low_surrogate', '\udc00'],
    ['one_char', 'a'],
    ['space', ' '],
    ['mixed', 'The quick  brown fox\n\n\t\u65e5\u672c\u8a9e \ud83d\ude00 <|endoftext|>'],
];
const FULL_CORPUS_ROUTES = ['llama/encode', 'gpt2/encode', 'claude/encode'];
const OPENAI_ENCODE_MODELS = [
    'gpt-4', 'gpt-4o', 'gpt2', 'text-davinci-003', 'claude', 'llama3', 'llama', 'mistral', 'yi',
    'gemma', 'jamba', 'qwen2', 'command-r', 'command-a', 'nemo', 'deepseek', 'nerdstash', 'unknown-model',
];
const OPENAI_ENCODE_INPUTS = ['empty', 'ascii', 'cjk', 'emoji', 'special_endoftext', 'added_llama3'];
const OPENAI_DECODE_MODELS = ['gpt-4', 'gpt-4o', 'gpt2', 'text-davinci-003', 'claude', 'llama3', 'llama', 'gemma', 'qwen2', 'deepseek'];
const COUNT_MODELS = ['gpt-4', 'gpt-3.5-turbo-0301', 'gpt-4o', 'gpt2', 'claude', 'llama3', 'llama', 'gemma', 'deepseek', 'unknown-model'];
const COUNT_BODIES = [
    ['simple', [{ role: 'user', content: 'Hello, world!' }]],
    ['with_name', [{ role: 'user', content: 'Hello', name: 'Bob' }]],
    ['system_and_user', [{ role: 'system', content: 'You are a helpful assistant.' }, { role: 'user', content: 'Hi' }]],
    ['cjk', [{ role: 'user', content: '\u3053\u3093\u306b\u3061\u306f\u4e16\u754c' }]],
    ['numeric_content', [{ role: 'user', content: 42 }]],
    ['null_content', [{ role: 'user', content: null }]],
    ['nested_content', [{ role: 'user', content: { a: 1 } }]],
    ['array_content', [{ role: 'user', content: ['x', 'y'] }]],
    ['empty_array_content', [{ role: 'user', content: [] }]],
    ['empty_messages', []],
    ['special_content', [{ role: 'user', content: 'a<|endoftext|>b' }]],
    ['object_body', { not: 'an array' }],
    ['string_body', 'plain string'],
];
const FIXED_DECODE_CASES = [
    ['empty', []],
    ['single_zero', [0]],
    ['zero_one', [0, 1]],
    ['negative', [-1]],
    ['out_of_range', [999999999]],
];
const ROUTE_INVENTORY = [
    ...SENTENCEPIECE_MODELS.map(model => `POST /api/tokenizers/${model}/encode`),
    ...SENTENCEPIECE_MODELS.map(model => `POST /api/tokenizers/${model}/decode`),
    'POST /api/tokenizers/gpt2/encode',
    'POST /api/tokenizers/gpt2/decode',
    ...WEB_MODELS.map(model => `POST /api/tokenizers/${model}/encode`),
    ...WEB_MODELS.map(model => `POST /api/tokenizers/${model}/decode`),
    'POST /api/tokenizers/openai/encode',
    'POST /api/tokenizers/openai/decode',
    'POST /api/tokenizers/openai/count',
    'POST /api/tokenizers/remote/kobold/count',
    'POST /api/tokenizers/remote/textgenerationwebui/encode',
];
// The two remote routes proxy to a user-configured text-generation backend, so their
// request shape belongs to the shared outbound transport rather than to tokenizer data.
// They are listed as deferred, and the Go test pins this exact set so a route cannot
// quietly disappear from the plan.
const DEFERRED_ROUTES = [
    'POST /api/tokenizers/remote/kobold/count',
    'POST /api/tokenizers/remote/textgenerationwebui/encode',
];

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-tokenizers-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const cacheRoot = path.join(dataRoot, '_cache');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
let child;

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-tokenizers-oracle-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

function readManifest() {
    const manifestPath = path.join(repositoryRoot, 'upstream', 'manifests', 'tokenizers.sha256');
    const entries = new Map();
    for (const line of readFileSync(manifestPath, 'utf8').replaceAll('\r\n', '\n').trim().split('\n')) {
        const separator = line.indexOf('  ');
        if (separator < 0) throw new Error(`${manifestPath}: malformed line ${JSON.stringify(line)}`);
        entries.set(line.slice(separator + 2), line.slice(0, separator));
    }
    return entries;
}

// The oracle must only record values this host can reproduce. Every tokenizer data file
// the pinned server will actually read is checked against the vendored manifest first.
function requirePinnedFile(manifest, relative, file, label) {
    const expected = manifest.get(relative);
    if (!expected) throw new Error(`manifest has no entry for ${relative}`);
    let actual;
    try {
        actual = sha256(readFileSync(file));
    } catch (error) {
        throw new Error(`${label}: cannot read ${file}: ${error.message}`);
    }
    if (actual !== expected) {
        throw new Error(`${label}: ${file} is ${actual} but the manifest pins ${expected}; refusing to record`);
    }
    return actual;
}

function requirePinnedPackage(name, expected) {
    const packagePath = path.join(sourceRoot, 'node_modules', name, 'package.json');
    const actual = JSON.parse(readFileSync(packagePath, 'utf8')).version;
    if (actual !== expected) {
        throw new Error(`${name} is ${actual} in the pinned checkout but the oracle expects ${expected}; refusing to record`);
    }
    return actual;
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

async function stopServer() {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGINT');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null) child.kill();
}

async function request(url, method = 'GET', headers = {}, body) {
    const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(30000) });
    let parsedBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
    try {
        parsedBody = parsedBody ? JSON.parse(parsedBody) : null;
    } catch {
        // Preserve plain-text response bodies.
    }
    return { response, body: parsedBody };
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

function cookiesFrom(response) {
    if (typeof response.headers.getSetCookie !== 'function') throw new Error('Node fetch does not expose getSetCookie()');
    return response.headers.getSetCookie();
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

function seedUser(key, value) {
    writeFileSync(path.join(dataRoot, '_storage', sha256(key)), JSON.stringify({ key, value }));
}

try {
    const manifest = readManifest();
    const tokenizerData = {};
    for (const name of LOCAL_TOKENIZER_FILES) {
        tokenizerData[`upstream/tokenizers/${name}`] = requirePinnedFile(manifest, name, path.join(repositoryRoot, 'upstream', 'tokenizers', name), 'vendored');
        requirePinnedFile(manifest, name, path.join(sourceRoot, 'src', 'tokenizers', name), 'pinned checkout');
    }
    for (const name of TIKTOKEN_FILES) {
        tokenizerData[`upstream/tokenizers/tiktoken/${name}`] = requirePinnedFile(
            manifest, `tiktoken/${name}`, path.join(sourceRoot, 'node_modules', 'tiktoken', name === 'model_to_encoding.json' || name === 'registry.json' ? name : path.join('encoders', name)), 'pinned tiktoken package');
    }
    const tokenizerPackages = {};
    for (const [name, expected] of Object.entries(PINNED_TOKENIZER_PACKAGES)) {
        tokenizerPackages[name] = requirePinnedPackage(name, expected);
    }

    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    mkdirSync(cacheRoot, { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    writeFileSync(configPath, 'enableUserAccounts: true\nskipContentCheck: true\nenableDownloadableTokenizers: true\nextensions:\n  enabled: false\n  autoUpdate: false\n');
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Tokenizer Reader', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '',
    });

    // The five externally fetched tokenizers are seeded from the vendored pinned bytes, so
    // the capture needs no network and cannot depend on what the mutable branch serves.
    const externalFiles = {};
    const cacheSeed = {};
    for (const model of EXTERNAL_MODELS) {
        const gzName = `${model}.json.gz`;
        const gzPath = path.join(repositoryRoot, 'upstream', 'tokenizers', 'external', gzName);
        const gzDigest = requirePinnedFile(manifest, `external/${gzName}`, gzPath, 'vendored external');
        const plain = gunzipSync(readFileSync(gzPath));
        externalFiles[gzName] = gzDigest;
        cacheSeed[`${model}.json`] = sha256(plain);
        writeFileSync(path.join(cacheRoot, `${model}.json`), plain);
    }

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
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
        if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!ready) throw new Error(`pinned server did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-10000)}`);

    const csrf = await request(`${origin}/csrf-token`);
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const login = await request(`${origin}/api/users/login`, 'POST', {
        Cookie: csrfCookie,
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: '' }));
    if (login.response.status !== 200) throw new Error(`could not login: ${login.response.status} ${JSON.stringify(login.body)}\n${logs.join('').slice(-10000)}`);
    const sessionCookie = cookieHeader(cookiesFrom(login.response));

    const responses = {};
    const errorPages = {};
    const casesByRoute = new Map();
    const record = async (name, routePath, { method = 'POST', query = null, body, authenticated = true, contentType = 'application/json' } = {}) => {
        if (Object.hasOwn(responses, name)) throw new Error(`duplicate case name ${name}`);
        const headers = {};
        if (authenticated) headers.Cookie = sessionCookie;
        if (contentType) headers['Content-Type'] = contentType;
        if (authenticated) headers['X-CSRF-Token'] = token;
        const url = `${origin}/api/tokenizers${routePath}${query ? `?${new URLSearchParams(query)}` : ''}`;
        const result = await request(url, method, headers, body);
        const routeKey = `${method} /api/tokenizers${routePath}`;
        casesByRoute.set(routeKey, (casesByRoute.get(routeKey) ?? 0) + 1);
        responses[name] = {
            request: { path: `/api/tokenizers${routePath}`, query: query ?? null, body: body === undefined ? null : JSON.parse(body) },
            status: result.response.status,
            headers: stableHeaders(result.response),
            body: result.body,
        };
        return result;
    };
    // Express renders thrown middleware/route errors as an HTML page whose <pre> block is a
    // V8 stack with host-absolute source paths. Only the status and content type are
    // recorded; the body is a property of the recording host, not of the pinned server.
    const recordErrorPage = async (name, routePath, { method = 'POST', query = null, body, authenticated = true, contentType = 'application/json' } = {}) => {
        if (Object.hasOwn(errorPages, name)) throw new Error(`duplicate error page name ${name}`);
        const headers = {};
        if (authenticated) headers.Cookie = sessionCookie;
        if (contentType) headers['Content-Type'] = contentType;
        if (authenticated) headers['X-CSRF-Token'] = token;
        const url = `${origin}/api/tokenizers${routePath}${query ? `?${new URLSearchParams(query)}` : ''}`;
        const result = await request(url, method, headers, body);
        const responseContentType = result.response.headers.get('content-type') ?? '';
        if (!responseContentType.startsWith('text/html')) {
            throw new Error(`${name}: expected the Express error page, got ${result.response.status} ${responseContentType}: ${String(result.body).slice(0, 200)}`);
        }
        const routeKey = `${method} /api/tokenizers${routePath}`;
        casesByRoute.set(routeKey, (casesByRoute.get(routeKey) ?? 0) + 1);
        errorPages[name] = { status: result.response.status, contentType: responseContentType };
    };
    const json = value => JSON.stringify(value);

    // One unauthenticated capture pins the middleware that precedes every tokenizer route.
    await recordErrorPage('unauthorized#llama/encode', '/llama/encode', { body: json({ text: 'Hello, world!' }), authenticated: false });

    for (const model of SENTENCEPIECE_MODELS) {
        for (const [name, text] of FULL_INPUTS) {
            await record(`${model}/encode#${name}`, `/${model}/encode`, { body: json({ text }) });
        }
    }
    for (const model of [...TIKTOKEN_ROUTES, ...WEB_MODELS]) {
        const inputs = FULL_CORPUS_ROUTES.includes(`${model}/encode`) ? FULL_INPUTS : CORE_INPUTS;
        for (const [name, text] of inputs) {
            await record(`${model}/encode#${name}`, `/${model}/encode`, { body: json({ text }) });
        }
    }

    // Request-shape cases that pin the reachable and unreachable error paths.
    await record('llama/encode#no_body', '/llama/encode', { body: undefined, contentType: null });
    await recordErrorPage('llama/encode#json_null', '/llama/encode', { body: 'null' });
    await record('llama/encode#empty_array', '/llama/encode', { body: '[]' });
    await record('llama/encode#missing_text', '/llama/encode', { body: '{}' });
    await record('llama/encode#method_mismatch', '/llama/encode', { method: 'GET', body: undefined, contentType: null });

    const decodeRoutes = [...SENTENCEPIECE_MODELS, ...TIKTOKEN_ROUTES, ...WEB_MODELS];
    for (const model of decodeRoutes) {
        const ascii = await request(`${origin}/api/tokenizers/${model}/encode`, 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, json({ text: 'Hello, world!' }));
        const emoji = await request(`${origin}/api/tokenizers/${model}/encode`, 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, json({ text: '\ud83d\ude00' }));
        const roundTrips = [
            ['roundtrip_ascii', ascii.body?.ids ?? []],
            ['roundtrip_emoji', emoji.body?.ids ?? []],
        ];
        for (const [name, ids] of [...roundTrips, ...FIXED_DECODE_CASES]) {
            await record(`${model}/decode#${name}`, `/${model}/decode`, { body: json({ ids }) });
        }
    }

    for (const model of OPENAI_ENCODE_MODELS) {
        for (const name of OPENAI_ENCODE_INPUTS) {
            const text = [...FULL_INPUTS, ...CORE_INPUTS].find(entry => entry[0] === name)[1];
            await record(`openai/encode#${model}#${name}`, '/openai/encode', { query: { model }, body: json({ text }) });
        }
    }
    for (const model of OPENAI_DECODE_MODELS) {
        const ascii = await request(`${origin}/api/tokenizers/openai/encode?model=${encodeURIComponent(model)}`, 'POST', {
            Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, json({ text: 'Hello, world!' }));
        for (const [name, ids] of [['roundtrip_ascii', ascii.body?.ids ?? []], ['out_of_range', [999999999]], ['empty', []]]) {
            await record(`openai/decode#${model}#${name}`, '/openai/decode', { query: { model }, body: json({ ids }) });
        }
    }
    for (const model of COUNT_MODELS) {
        for (const [name, messages] of COUNT_BODIES) {
            // A JSON string body is rejected by the pinned strict body parser before the
            // route runs, so it is an error page rather than a guesstimate response.
            if (name === 'string_body') {
                await recordErrorPage(`openai/count#${model}#${name}`, '/openai/count', { query: { model }, body: json(messages) });
                continue;
            }
            await record(`openai/count#${model}#${name}`, '/openai/count', { query: { model }, body: json(messages) });
        }
    }

    await stopServer();

    const expectedCases = Object.keys(responses);
    const coverage = {
        routes: ROUTE_INVENTORY.map(route => ({
            route,
            cases: casesByRoute.get(route) ?? 0,
            status: DEFERRED_ROUTES.includes(route) ? 'deferred' : 'recorded',
        })),
        deferredRoutes: DEFERRED_ROUTES,
        requiredCases: expectedCases,
        requiredErrorPages: Object.keys(errorPages),
    };
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned tokenizer encode/decode/count routes across tiktoken, SentencePiece and HF tokenizers, with the corpus that exercises context boundaries',
        normalizations: [
            'Responses Express renders as its HTML error page are recorded in errorPages as status and content type only, because the page body is a V8 stack carrying host-absolute source paths and pinned line numbers.',
            'The five externally fetched tokenizers are seeded into <DATA_ROOT>/_cache from the vendored pinned bytes, so the capture makes no network request and cannot follow the mutable upstream branch.',
            'The session cookie and CSRF token are request inputs, not observations, and are not recorded.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            tokenizerPackages,
            tokenizerData,
            externalTokenizers: {
                repository: PINNED_TOKENIZERS_REPOSITORY,
                ref: PINNED_TOKENIZERS_REF,
                commit: PINNED_TOKENIZERS_COMMIT,
                note: 'pinned 1.19.0 fetches these from a mutable branch; GoTavern pins this commit and serves the vendored bytes',
                files: externalFiles,
            },
            cacheSeed,
        },
        coverage,
        responses,
        errorPages,
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-tokenizers.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned tokenizer behavior (${expectedCases.length} cases)`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
