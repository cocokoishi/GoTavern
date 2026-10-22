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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
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
const CONFIG_ENABLED = 'enableUserAccounts: true\nskipContentCheck: true\nenableDownloadableTokenizers: true\nextensions:\n  enabled: false\n  autoUpdate: false\n';
// enableDownloadableTokenizers is read when the endpoint module loads, so the cold-cache
// fallback needs its own server process.
const CONFIG_DOWNLOADS_DISABLED = 'enableUserAccounts: true\nskipContentCheck: true\nenableDownloadableTokenizers: false\nextensions:\n  enabled: false\n  autoUpdate: false\n';
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
// WHAT THIS CORPUS MUST CONTAIN, and why the replay case counts move with it.
//
// The count corpus carries BOTH message shapes: with a role, and WITHOUT one. The role-less
// `[{ content }]` is not a synthetic case -- it is what `counterWrapperOpenAIAsync` in the pinned
// frontend builds and posts with `full = true`, so it is the shape every browser token count uses. For
// a long time the corpus held only role-ful bodies, so the per-property iteration was never exercised
// on the shape a real caller sends, and a browser differential could disagree with a 908-case fixture
// while neither side was wrong about the cases it had.
//
// Consequence for a change here: adding an input or a model moves the replay's expected case counts
// (asserted on purpose, so a silently-shrunk corpus cannot pass). Update them in the SAME commit as the
// fixture, and let the LINUX oracle record that fixture -- a Windows re-record of this corpus alters
// pre-existing `chunks` by decoding UTF-8 as Latin-1, measured twice from the worktree root.
const TIKTOKEN_FILES = [
    'cl100k_base.json', 'gpt2.json', 'model_to_encoding.json', 'o200k_base.json',
    'p50k_base.json', 'p50k_edit.json', 'r50k_base.json', 'registry.json',
];

// The corpus is fixed and ordered: the fixture must be byte-identical across two runs.
const CORE_INPUTS = [
    ['empty', ''],
    ['ascii', 'Hello, world!'],
    // The exact string the BROWSER probe counts, which is why it is here. It does NOT separate the two
    // OpenAI encodings: measured, gpt2 (r50k_base) and gpt-4/claude (cl100k_base) both tokenize it into
    // the same three pieces, so the "this one can" claim that first stood here was wrong and is not
    // repeated. Its value is that it is the input a real caller sends: a count regression on it is one
    // a user sees.
    ['probe_user_marker', 'probe user marker'],
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
    // A compatibility character distinguishes NFKC from NFC: NFKC folds U+FB01 and U+FF21,
    // NFC leaves them. Without this the two normalizers are indistinguishable, and claude is
    // the only NFKC file.
    ['compat_ligature', '\ufb01\uff21'],
    // claude declares <META_START> among its added tokens, so this pins that a declared added
    // token is matched and mapped to its own id. It does NOT discriminate longest-match from
    // first-match: no pinned tokenizer declares one added token as a prefix of another (0
    // pairs across 2160 added tokens in the seven files), so that rule is pinned by
    // TestHFAddedTokenLongestMatch instead.
    ['added_meta_start', 'x<META_START>y'],
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
    // Purpose-built BPE tie inputs. In nerdstash/nerdstash_v2 the pieces "\u2581\u2581" and
    // "\u2581\"" share a score, and in yi "\u2581\u2581" and "\u2581t" do, so the first
    // merge has two equal-score candidates and the tie-break direction decides the
    // segmentation. Without these the corpus cannot tell leftmost from rightmost.
    ['tie_break_quote', '  "'],
    ['tie_break_t', '  t'],
    ['mixed', 'The quick  brown fox\n\n\t\u65e5\u672c\u8a9e \ud83d\ude00 <|endoftext|>'],
];
const FULL_CORPUS_ROUTES = ['llama/encode', 'gpt2/encode', 'claude/encode'];
const OPENAI_ENCODE_MODELS = [
    'gpt-4', 'gpt-3.5-turbo', 'gpt-4o', 'gpt2', 'text-davinci-003', 'claude', 'llama3', 'llama', 'mistral', 'yi',
    'gemma', 'jamba', 'qwen2', 'command-r', 'command-a', 'nemo', 'deepseek', 'nerdstash', 'unknown-model',
];
const OPENAI_ENCODE_INPUTS = ['empty', 'ascii', 'probe_user_marker', 'cjk', 'emoji', 'special_endoftext', 'special_endofprompt', 'special_fim', 'added_llama3'];
const OPENAI_DECODE_MODELS = ['gpt-4', 'gpt-4o', 'gpt2', 'text-davinci-003', 'claude', 'llama3', 'llama', 'gemma', 'qwen2', 'deepseek'];
const COUNT_MODELS = ['gpt-4', 'gpt-3.5-turbo', 'gpt-3.5-turbo-0301', 'gpt-4o', 'gpt2', 'claude', 'llama3', 'llama', 'gemma', 'deepseek', 'unknown-model'];
const COUNT_BODIES = [
    ['simple', [{ role: 'user', content: 'Hello, world!' }]],
    // THE SHAPE THE FRONTEND ACTUALLY SENDS. `counterWrapperOpenAIAsync` builds `{ content: text }` --
    // NO role -- and posts `[message]` with `full = true`, so the browser's count is
    // 3 (per message) + encode(content) + 3 (padding). Every previously recorded case carried a role, so
    // the per-property iteration was never exercised on the shape the browser uses; that is how a browser
    // probe could disagree with a 908-case fixture while neither side was wrong about the cases it had.
    ['content_only_probe_user_marker', [{ content: 'probe user marker' }]],
    ['content_only_simple', [{ content: 'Hello, world!' }]],
    ['content_only_two_messages', [{ content: 'probe system marker' }, { content: 'probe user marker' }]],
    ['role_content_reversed', [{ content: 'probe user marker', role: 'user' }]],
    ['probe_user_marker', [{ role: 'user', content: 'probe user marker' }]],
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
    // A value the tokenizer cannot encode aborts only the rest of that message, so the
    // bad value must be followed by another property for the behaviour to be observable.
    ['numeric_then_name', [{ role: 'user', content: 42, name: 'Bob' }]],
    ['array_then_name', [{ role: 'user', content: ['x', 'y'], name: 'Bob' }]],
    ['special_then_name', [{ role: 'user', content: 'a<|endoftext|>b', name: 'Bob' }]],
    ['empty_array_then_name', [{ role: 'user', content: [], name: 'Bob' }]],
    // The guesstimate fallback divides by 3.35, which only differs from a rounded divisor
    // for inputs long enough to cross an integer boundary.
    ['object_body_long', { not: 'an array', padding: 'x'.repeat(220) }],
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
// Every route in the pinned inventory is recorded. The two remote routes proxy to a
// user-configured text-generation backend, so they are exercised against a local mock
// backend that also records the request the pinned server builds.
const DEFERRED_ROUTES = [];
const REMOTE_API_TYPES = ['tabby', 'koboldcpp', 'llamacpp', 'vllm', 'aphrodite', 'ooba'];
const REMOTE_UNKNOWN_API_TYPE = 'ollama';
// Inputs used for the two downloads-disabled runs, and for the llama3 comparison that
// proves the cold-cache fallback.
const FALLBACK_INPUTS = ['ascii', 'cjk', 'emoji', 'special_endoftext', 'added_llama3'];
const GZ_CACHE_INPUTS = ['ascii', 'cjk', 'emoji'];

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-tokenizers-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const cacheRoot = path.join(dataRoot, '_cache');
const configPath = path.join(runtimeRoot, 'config.yaml');
let logs = [];
let child;
let mockServer;
let mockOrigin;
const mockRequests = [];

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

// The mock text-generation backend. Responses are fixed and cover every response
// projection the two remote routes can take, plus the failure paths.
const MOCK_RESPONSES = [
    ['/v1/token/encode', { length: 7, tokens: [4, 5, 6] }],
    ['/v1/internal/encode', { value: 5 }],
    ['/api/extra/tokencount', { count: 9, ids: [7, 8] }],
    ['/extra/tokencount', { value: 42, ids: [1, 2, 3] }],
    ['/v1/tokenize', { ids: [12] }],
    ['/tokenize', { tokens: [10, 11] }],
];

function recordedMockHeaders(headers) {
    // Only headers that describe the tokenizer request are recorded. Transport headers
    // such as host and user-agent are properties of the recording host.
    const recorded = {};
    for (const name of ['content-type', 'content-length', 'authorization', 'x-api-key']) {
        if (headers[name] !== undefined) recorded[name] = String(headers[name]);
    }
    return recorded;
}

async function startMockBackend() {
    mockServer = http.createServer((req, res) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            mockRequests.push({ method: req.method, path: req.url, headers: recordedMockHeaders(req.headers), body });
            if (req.url.includes('/fail')) {
                res.writeHead(500, { 'content-type': 'application/json' });
                res.end('{"error":"mock failure"}');
                return;
            }
            if (req.url.includes('/notjson')) {
                res.writeHead(200, { 'content-type': 'text/plain' });
                res.end('not json');
                return;
            }
            const pathname = req.url.split('?', 1)[0];
            // Longest matching suffix wins, so /api/extra/tokencount is not served by
            // the shorter /extra/tokencount entry.
            const match = MOCK_RESPONSES
                .filter(([route]) => pathname.endsWith(route))
                .sort((left, right) => right[0].length - left[0].length)[0];
            if (!match) {
                res.writeHead(404, { 'content-type': 'application/json' });
                res.end('{"error":"unknown mock route"}');
                return;
            }
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(match[1]));
        });
    });
    await new Promise((resolve, reject) => {
        mockServer.once('error', reject);
        mockServer.listen(0, '127.0.0.1', resolve);
    });
    mockOrigin = `http://127.0.0.1:${mockServer.address().port}`;
}

async function stopMockBackend() {
    if (!mockServer) return;
    await new Promise(resolve => mockServer.close(resolve));
    mockServer = undefined;
}

function cacheState() {
    if (!existsSync(cacheRoot)) return { exists: false, entries: [] };
    const entries = readdirSync(cacheRoot).sort().map(name => {
        const absolute = path.join(cacheRoot, name);
        if (statSync(absolute).isDirectory()) {
            // _cache is shared: pinned startup also creates _cache/characters for the
            // character disk cache, so a directory here is not a tokenizer artifact.
            return { path: name, kind: 'directory' };
        }
        const bytes = readFileSync(absolute);
        return { path: name, kind: 'file', bytes: bytes.length, sha256: sha256(bytes) };
    });
    return { exists: true, entries };
}

async function startPinnedServer(configText) {
    writeFileSync(configPath, configText);
    logs = [];
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
    return { origin, token, sessionCookie: cookieHeader(cookiesFrom(login.response)) };
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

    await startMockBackend();
    const mainSession = await startPinnedServer(CONFIG_ENABLED);
    const { origin } = mainSession;

    const responses = {};
    const errorPages = {};
    const backendRequests = {};
    const casesByRoute = new Map();
    // The mock backend's origin is a property of this run, so every recorded value that
    // can contain it is normalized.
    const normalizeOrigin = value => {
        if (typeof value === 'string') return value.split(mockOrigin).join('<mock-origin>');
        if (Array.isArray(value)) return value.map(normalizeOrigin);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeOrigin(item)]));
        return value;
    };
    const makeRecorder = session => {
        const send = (routePath, { method = 'POST', query = null, body, authenticated = true, contentType = 'application/json' } = {}) => {
            const headers = {};
            if (authenticated) headers.Cookie = session.sessionCookie;
            if (contentType) headers['Content-Type'] = contentType;
            if (authenticated) headers['X-CSRF-Token'] = session.token;
            const url = `${session.origin}/api/tokenizers${routePath}${query ? `?${new URLSearchParams(query)}` : ''}`;
            return request(url, method, headers, body);
        };
        return {
            capture: async (name, routePath, options = {}) => {
                if (Object.hasOwn(responses, name)) throw new Error(`duplicate case name ${name}`);
                const backendBefore = mockRequests.length;
                const result = await send(routePath, options);
                const routeKey = `${options.method ?? 'POST'} /api/tokenizers${routePath}`;
                casesByRoute.set(routeKey, (casesByRoute.get(routeKey) ?? 0) + 1);
                responses[name] = {
                    request: { path: `/api/tokenizers${routePath}`, query: options.query ?? null, body: options.body === undefined ? null : normalizeOrigin(JSON.parse(options.body)) },
                    status: result.response.status,
                    headers: stableHeaders(result.response),
                    body: normalizeOrigin(result.body),
                };
                for (const backendRequest of mockRequests.slice(backendBefore)) {
                    backendRequests[name] = normalizeOrigin(backendRequest);
                }
                return result;
            },
            // Express renders thrown middleware/route errors as an HTML page whose <pre>
            // block is a V8 stack with host-absolute source paths. Only the status and
            // content type are recorded; the body belongs to the recording host.
            errorPage: async (name, routePath, options = {}) => {
                if (Object.hasOwn(errorPages, name)) throw new Error(`duplicate error page name ${name}`);
                const result = await send(routePath, options);
                const responseContentType = result.response.headers.get('content-type') ?? '';
                if (!responseContentType.startsWith('text/html')) {
                    throw new Error(`${name}: expected the Express error page, got ${result.response.status} ${responseContentType}: ${String(result.body).slice(0, 200)}`);
                }
                const routeKey = `${options.method ?? 'POST'} /api/tokenizers${routePath}`;
                casesByRoute.set(routeKey, (casesByRoute.get(routeKey) ?? 0) + 1);
                errorPages[name] = { status: result.response.status, contentType: responseContentType };
            },
        };
    };
    const main = makeRecorder(mainSession);
    const record = main.capture;
    const recordErrorPage = main.errorPage;
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
            Cookie: mainSession.sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': mainSession.token,
        }, json({ text: 'Hello, world!' }));
        const emoji = await request(`${origin}/api/tokenizers/${model}/encode`, 'POST', {
            Cookie: mainSession.sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': mainSession.token,
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
            Cookie: mainSession.sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': mainSession.token,
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

    // The two remote passthrough routes, exercised against the mock backend.
    const inputText = name => [...FULL_INPUTS, ...CORE_INPUTS].find(entry => entry[0] === name)[1];
    await record('remote/kobold/count#ok', '/remote/kobold/count', { body: json({ text: 'Hello, world!', url: mockOrigin }) });
    await record('remote/kobold/count#empty_text', '/remote/kobold/count', { body: json({ text: '', url: mockOrigin }) });
    await record('remote/kobold/count#error_status', '/remote/kobold/count', { body: json({ text: 'Hello, world!', url: `${mockOrigin}/fail` }) });
    await record('remote/kobold/count#not_json', '/remote/kobold/count', { body: json({ text: 'Hello, world!', url: `${mockOrigin}/notjson` }) });
    await record('remote/kobold/count#missing_url', '/remote/kobold/count', { body: json({ text: 'Hello, world!' }) });
    for (const apiType of REMOTE_API_TYPES) {
        await record(`remote/textgenerationwebui/encode#${apiType}`, '/remote/textgenerationwebui/encode', {
            body: json({ text: 'Hello, world!', url: mockOrigin, model: 'test-model', api_type: apiType }),
        });
    }
    await record('remote/textgenerationwebui/encode#tabby#cjk', '/remote/textgenerationwebui/encode', {
        body: json({ text: inputText('cjk'), url: mockOrigin, model: 'test-model', api_type: 'tabby' }),
    });
    await record('remote/textgenerationwebui/encode#tabby#trailing_v1', '/remote/textgenerationwebui/encode', {
        body: json({ text: 'Hello, world!', url: `${mockOrigin}/v1`, model: 'test-model', api_type: 'tabby' }),
    });
    await record('remote/textgenerationwebui/encode#tabby#trailing_slash', '/remote/textgenerationwebui/encode', {
        body: json({ text: 'Hello, world!', url: `${mockOrigin}/`, model: 'test-model', api_type: 'tabby' }),
    });
    await record(`remote/textgenerationwebui/encode#${REMOTE_UNKNOWN_API_TYPE}`, '/remote/textgenerationwebui/encode', {
        body: json({ text: 'Hello, world!', url: mockOrigin, model: 'test-model', api_type: REMOTE_UNKNOWN_API_TYPE }),
    });
    await record('remote/textgenerationwebui/encode#koboldcpp#error_status', '/remote/textgenerationwebui/encode', {
        body: json({ text: 'Hello, world!', url: `${mockOrigin}/fail`, model: 'test-model', api_type: 'koboldcpp' }),
    });
    await record('remote/textgenerationwebui/encode#tabby#missing_url', '/remote/textgenerationwebui/encode', {
        body: json({ text: 'Hello, world!', model: 'test-model', api_type: 'tabby' }),
    });
    await stopServer();

    // Run 2: downloads disabled with a cold cache. Pinned upstream cannot fetch and has no
    // cached copy, so it falls back to llama3.json for all five external tokenizers.
    rmSync(cacheRoot, { recursive: true, force: true });
    const coldCacheBefore = cacheState();
    const cold = makeRecorder(await startPinnedServer(CONFIG_DOWNLOADS_DISABLED));
    const coldAsciiIds = {};
    for (const input of FALLBACK_INPUTS) {
        const result = await cold.capture(`downloads-disabled-cold/llama3/encode#${input}`, '/llama3/encode', { body: json({ text: inputText(input) }) });
        if (input === 'ascii') coldAsciiIds.llama3 = result.body?.ids ?? [];
    }
    for (const model of EXTERNAL_MODELS) {
        for (const input of FALLBACK_INPUTS) {
            const result = await cold.capture(`downloads-disabled-cold/${model}/encode#${input}`, `/${model}/encode`, { body: json({ text: inputText(input) }) });
            if (input === 'ascii') coldAsciiIds[model] = result.body?.ids ?? [];
        }
    }
    await cold.capture('downloads-disabled-cold/llama3/decode#roundtrip_ascii', '/llama3/decode', { body: json({ ids: coldAsciiIds.llama3 }) });
    for (const model of EXTERNAL_MODELS) {
        await cold.capture(`downloads-disabled-cold/${model}/decode#roundtrip_ascii`, `/${model}/decode`, { body: json({ ids: coldAsciiIds[model] }) });
    }
    await stopServer();
    const coldCacheAfter = cacheState();

    // Run 3: downloads disabled with the pinned .gz files already in _cache. Pinned upstream
    // decompresses them in place, so the vendored bytes win over the llama3 fallback.
    rmSync(cacheRoot, { recursive: true, force: true });
    mkdirSync(cacheRoot, { recursive: true });
    for (const model of EXTERNAL_MODELS) {
        writeFileSync(path.join(cacheRoot, `${model}.json.gz`), readFileSync(path.join(repositoryRoot, 'upstream', 'tokenizers', 'external', `${model}.json.gz`)));
    }
    const gzCacheBefore = cacheState();
    const gz = makeRecorder(await startPinnedServer(CONFIG_DOWNLOADS_DISABLED));
    for (const model of EXTERNAL_MODELS) {
        for (const input of GZ_CACHE_INPUTS) {
            await gz.capture(`downloads-disabled-gz/${model}/encode#${input}`, `/${model}/encode`, { body: json({ text: inputText(input) }) });
        }
    }
    await stopServer();
    const gzCacheAfter = cacheState();
    await stopMockBackend();

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
            'The five externally fetched tokenizers are seeded into <DATA_ROOT>/_cache from the vendored pinned bytes in the first run, so that capture makes no network request and cannot follow the mutable upstream branch. The two later runs deliberately change that cache state to record the fallback and the in-place decompression.',
            'The mock text-generation backend origin is recorded as <mock-origin>, because its port differs on every run.',
            'Backend requests record method, path, content-type, content-length and credential headers only; transport headers such as host and user-agent are omitted because they belong to the recording host.',
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
        backendRequests,
        downloadsDisabled: {
            coldCache: { cacheBefore: coldCacheBefore, cacheAfter: coldCacheAfter },
            gzCache: { cacheBefore: gzCacheBefore, cacheAfter: gzCacheAfter },
        },
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
    await stopMockBackend();
    safeCleanup();
}
