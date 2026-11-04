#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-compression.json label="response compression"
// RECORD pinned's response-compression observable, before GoTavern implements it.
//
// WHY THIS PROBE EXISTS. Pinned mounts `app.use(compression())` (src/server-main.js:107) and its fixtures carry
// `content-encoding: gzip`, while GoTavern only reproduces the Vary side of that middleware. Every comparator
// normalizes Content-Encoding away, so the gap was invisible to the gates and cost real wire bytes (a page load
// is ~229 assets; script.js is 497,669 B). This probe records the contract the Go middleware must match, with
// RAW and DECODED bodies, so "the body is the same" cannot hide a missing/incorrect encoding.
//
// THE MIDDLEWARE UNDER TEST. pinned `compression@^1.8.1` with NO options (src/server-main.js:107): threshold
// 1024 B, default filter (`compressible(Content-Type)`), `Cache-Control: no-transform` respected, Vary:
// Accept-Encoding appended before the threshold/HEAD/negotiation checks, Content-Length removed when a body is
// compressed, HEAD never compressed, and negotiation by the `negotiator` package over
// ['br','gzip','deflate','identity'] with preference ['br','gzip'] when the Node runtime supports brotli
// (Node 24 does). SSE responses carry NO Content-Type (src/util.js forwardFetchResponse pipes the provider body),
// so the filter never matches them: this probe records that as the contract, because it is why compression must
// never touch SSE framing.
//
// WHAT IS RECORDED per scenario: request (method/path/headers), response status, content-encoding,
// transfer-encoding, content-length presence AND value, vary, content-type, whether an etag was present (the
// VALUE is host-specific: Express static derives it from size+mtime, so it is deliberately null), raw body
// bytes+sha256 and decoded body bytes+sha256 (+ text for small text bodies). Raw compressed bytes are recorded
// as evidence but are NOT a byte-equality contract: zlib and Go's compress/gzip emit different deflate streams.
// The contract is the encoding choice, the headers, and the decoded bytes.
//
// NOT RECORDED, with the reason (see `notRecorded`):
//   - ETag value and Last-Modified: derived from the checkout's file mtime, so they differ on every re-record.
//   - Date, X-Response-Time, Set-Cookie, Connection/Keep-Alive: run-specific.
//   - Compression level/strategy: not observable in the response; the stream bytes are not compared.
//
// DETERMINISM. The mock provider rule is a literal SSE body, the seeded user/settings are literals, and every
// header whose value is host- or time-derived is normalized to null/present. A Linux re-record must reproduce
// this fixture byte-for-byte.

import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import zlib from 'node:zlib';

import {
    PINNED_COMMIT,
    PINNED_VERSION,
    sha256,
    startPinnedProviderServer,
    writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-compression.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const FIXTURE = 'sillytavern-1.19.0-compression.json';
const SETTINGS_ROUTE = '/api/settings/get';
const GENERATE_ROUTE = '/api/backends/chat-completions/generate';
const SECRETS = {
    api_key_openai: [{ id: 'probe-compression-openai', value: 'probe-openai-key', label: 'openai', active: true }],
};
const SSE_FRAMES = [
    'data: {"id":"chatcmpl-probe","object":"chat.completion.chunk","created":1700000000,"model":"probe-model","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
    '',
    'data: {"id":"chatcmpl-probe","object":"chat.completion.chunk","created":1700000000,"model":"probe-model","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
    '',
    'data: [DONE]',
    '',
].join('\n');
const GENERATE_BODY = {
    chat_completion_source: 'openai',
    model: 'probe-model',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
    max_tokens: 8,
};

// The HTTP client must NOT auto-decompress: the whole point is the raw transfer. node:http leaves the body
// untouched, unlike fetch/undici.
function rawHttp(origin, requestPath, { method = 'GET', headers = {}, body = null } = {}) {
    const url = new URL(origin);
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: url.hostname,
            port: url.port,
            path: requestPath,
            method,
            headers,
            timeout: 30000,
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => {
                const raw = Buffer.concat(chunks);
                resolve({ status: response.statusCode, statusText: response.statusMessage, headers: response.headers, raw });
            });
        });
        request.on('timeout', () => request.destroy(new Error(`timeout: ${method} ${requestPath}`)));
        request.on('error', reject);
        if (body !== null) request.write(body);
        request.end();
    });
}

function decode(headers, raw) {
    const encoding = String(headers['content-encoding'] ?? '').trim().toLowerCase();
    if (encoding === 'gzip') return zlib.gunzipSync(raw);
    if (encoding === 'deflate') {
        try { return zlib.inflateSync(raw); } catch { return zlib.inflateRawSync(raw); }
    }
    if (encoding === 'br') return zlib.brotliDecompressSync(raw);
    return raw;
}

const STABLE_HEADERS = new Set([
    'content-encoding', 'content-length', 'content-type', 'etag', 'transfer-encoding', 'vary',
    'cache-control', 'content-range', 'accept-ranges', 'x-content-type-options',
]);

function capture(name, request, result) {
    const decoded = decode(result.headers, result.raw);
    const headers = {};
    for (const key of Object.keys(result.headers).sort()) {
        if (STABLE_HEADERS.has(key)) headers[key] = result.headers[key];
    }
    // Small bodies are recorded as text so the replay can compare the DECODED bytes directly; the SSE response
    // carries no Content-Type (pinned's forwardFetchResponse), so a content-type gate would hide its framing.
    const text = decoded.length <= 4096 ? decoded.toString('utf8') : null;
    // THE COMPRESSED BYTES ARE NOT A CROSS-HOST CONTRACT. The CI re-record of this probe produced a different
    // gzip stream (same length for some assets, different length for others) than the Windows recording, because
    // zlib's deflate output is not byte-stable across builds/hosts; brotli is likewise implementation-defined. The
    // contract is the encoding CHOICE, the headers and the DECODED bytes, so a compressed scenario records raw as
    // null with the reason instead of committing a host-specific hash. Identity scenarios keep their raw bytes
    // (raw === decoded there).
    const encoding = String(result.headers['content-encoding'] ?? '').trim().toLowerCase();
    const raw = encoding === ''
        ? { bytes: result.raw.length, sha256: sha256(result.raw), reason: null }
        : { bytes: null, sha256: null, reason: `content-encoding ${encoding}: compressed bytes are produced by the host's zlib/brotli build and are not a byte-stability contract; the encoding choice, headers and decoded bytes are` };
    return {
        name,
        request,
        response: {
            status: result.status,
            contentEncoding: result.headers['content-encoding'] ?? null,
            transferEncoding: result.headers['transfer-encoding'] ?? null,
            contentLength: 'content-length' in result.headers ? String(result.headers['content-length']) : null,
            vary: result.headers.vary ?? null,
            contentType: result.headers['content-type'] ?? null,
            etagPresent: 'etag' in result.headers,
            cacheControl: result.headers['cache-control'] ?? null,
            acceptRanges: result.headers['accept-ranges'] ?? null,
            contentRange: result.headers['content-range'] ?? null,
        },
        raw,
        decoded: { bytes: decoded.length, sha256: sha256(decoded), text },
    };
}

// The recorded request is the SEMANTIC request, not the transport envelope: the session cookie and the CSRF
// token are random per boot, and an If-None-Match value is host-specific (size+mtime ETag), so recording any of
// them would make the fixture differ on every re-record. Their PRESENCE is the contract and is recorded as a
// boolean; the values are not part of what the compression middleware observes.
const UNSTABLE_REQUEST_HEADERS = new Set(['cookie', 'x-csrf-token', 'if-none-match']);
function withDefaults(request) {
    const rawHeaders = request.headers ?? {};
    const headers = {};
    for (const [name, value] of Object.entries(rawHeaders)) {
        if (!UNSTABLE_REQUEST_HEADERS.has(name.toLowerCase())) headers[name] = value;
    }
    return {
        method: request.method ?? 'GET',
        path: request.path,
        headers: Object.fromEntries(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))),
        authenticated: Object.keys(rawHeaders).some(name => name.toLowerCase() === 'cookie'),
        conditional: Object.keys(rawHeaders).some(name => name.toLowerCase() === 'if-none-match'),
        ...(request.body !== undefined && request.body !== null ? { body: request.body } : {}),
    };
}

// The settings aggregation is CONFIG-DRIVEN: pinned's default config has extensions.autoUpdate=true, while
// GoTavern's product decision makes auto-update default OFF. Pinning that knob here keeps the recorded body a
// compression observation rather than an unrelated product divergence; extensions.enabled stays at pinned's
// default (true), which is also GoTavern's default. The Go replay runs with the same effective values.
const server = await startPinnedProviderServer({
    sourceRoot,
    prefix: 'gotavern-compression-oracle-',
    mocks: [],
    config: {
        'extensions.enabled': true,
        'extensions.autoUpdate': false,
        // The pinned default request-compression timeout is 4000 ms while GoTavern's option default is 3000; the
        // aggregation echoes it, so pin the knob to the value the Go replay runs with.
        'performance.requestCompression.timeout': 3000,
    },
});
const scenarios = {};
try {
    // A stable user tree. settings.json must be large enough that the aggregated /api/settings/get response clears
    // the 1024 B compression threshold; an empty one answers 557 B and would record the BELOW-threshold branch,
    // which is not the JSON scenario this probe exists for.
    mkdirSync(server.userRoot, { recursive: true });
    const settingsDocument = {
        username: 'compression-probe',
        unknown: { keep: true },
        padding: 'c'.repeat(2000),
    };
    // The exact bytes are recorded as an INPUT so the replay seeds the same tree; a placeholder here would
    // replay the empty-settings response and silently test the below-threshold branch instead.
    const settingsText = `${JSON.stringify(settingsDocument)}\n`;
    writeFileSync(path.join(server.userRoot, 'settings.json'), settingsText);
    server.writeSecrets(SECRETS);

    const session = server.session;
    const auth = { Cookie: session.cookie, 'X-CSRF-Token': session.csrfToken };

    const run = async (name, request, { before = null } = {}) => {
        if (before) await before();
        const result = await rawHttp(server.origin, request.path, request);
        scenarios[name] = capture(name, withDefaults(request), result);
        return scenarios[name];
    };

    const gzipAccept = { 'Accept-Encoding': 'gzip, deflate' };
    const brAccept = { 'Accept-Encoding': 'br, gzip' };

    // 1. >1 KB static asset, the page-load case. 2. HTML shell. 3. JSON POST. 4. 304 revalidation.
    const script = await run('static.scriptGzip', { path: '/script.js', headers: gzipAccept });
    await run('static.scriptBrotliPreferred', { path: '/script.js', headers: brAccept });
    await run('static.scriptIdentity', { path: '/script.js', headers: { 'Accept-Encoding': 'identity' } });
    await run('static.scriptNoAcceptEncoding', { path: '/script.js', headers: {} });
    // `/` redirects an unauthenticated request to /login (server-main.js:214), so the shell scenario carries the
    // session cookie; a redirect would record no compression and prove nothing about the shell.
    await run('shell.rootGzip', { path: '/', headers: { ...gzipAccept, Cookie: session.cookie } });
    await run('json.settingsGetGzip', {
        method: 'POST',
        path: SETTINGS_ROUTE,
        headers: { ...gzipAccept, ...auth, 'Content-Type': 'application/json' },
        body: '{}',
    });

    // The ETag VALUE is host-specific (size+mtime); take it from the live response, record only that it existed
    // and that the conditional request answered 304.
    const scriptEtag = (await rawHttp(server.origin, '/script.js', { headers: gzipAccept })).headers.etag;
    if (!scriptEtag) throw new Error('the pinned static response carried no ETag, so the 304 contract cannot be recorded');
    await run('revalidate.304', {
        path: '/script.js',
        headers: { ...gzipAccept, 'If-None-Match': scriptEtag },
    });

    // 5. Range (206, body below threshold). 6. sub-threshold response. 7. HEAD. 8. non-compressible type.
    await run('range.bytes0to99', {
        path: '/script.js',
        headers: { ...gzipAccept, Range: 'bytes=0-99' },
    });
    // A sub-threshold response with a HOST-STABLE body. `/version` was the obvious candidate but its body carries
    // pinned's `gitRevision`, whose length depends on the checkout's git state (9 chars here, 7 on CI), so it
    // cannot be a cross-host fixture. /robots.txt is 26 bytes of static text/plain: compressible by Content-Type,
    // below the 1024 B threshold, and identical on every host.
    await run('small.robotsTxt', { path: '/robots.txt', headers: gzipAccept });
    await run('head.script', { method: 'HEAD', path: '/script.js', headers: gzipAccept });
    await run('binary.png', { path: '/img/default-expressions/admiration.png', headers: gzipAccept });

    // 9. SSE generation through a controlled provider peer. The mock rule answers an SSE body; pinned's
    // forwardFetchResponse pipes it with NO content-type, so the compression filter must not match it.
    server.setMocks([{
        run: 'compression-sse',
        match: '/chat/completions',
        status: 200,
        statusText: 'OK',
        headers: { 'content-type': 'text/event-stream' },
        body: SSE_FRAMES,
    }]);
    await run('sse.generateStream', {
        method: 'POST',
        path: GENERATE_ROUTE,
        headers: { ...gzipAccept, ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify(GENERATE_BODY),
    });

    // Print every capture BEFORE asserting, so a contract failure shows the observed status/encoding rather than
    // only the assertion text.
    for (const [name, scenario] of Object.entries(scenarios)) {
        console.log(`  ${name.padEnd(30)} status=${scenario.response.status} ce=${String(scenario.response.contentEncoding)} cl=${String(scenario.response.contentLength)} raw=${scenario.raw.bytes} decoded=${scenario.decoded.bytes}`);
    }

    // The probe asserts its own contract: a silent "pinned did not compress" would make the fixture useless.
    const expect = (name, predicate, why) => {
        if (!predicate(scenarios[name])) throw new Error(`${name}: ${why}`);
    };
    expect('static.scriptGzip', s => s.response.contentEncoding === 'gzip', 'pinned did not gzip a >1 KB static asset');
    expect('static.scriptGzip', s => s.raw.bytes < s.decoded.bytes, 'the "compressed" static body was not smaller');
    expect('static.scriptGzip', s => s.response.contentLength === null, 'pinned kept Content-Length on a compressed body');
    expect('static.scriptBrotliPreferred', s => s.response.contentEncoding === 'br', 'pinned did not prefer brotli when offered');
    expect('shell.rootGzip', s => s.response.contentEncoding === 'gzip', 'pinned did not gzip the HTML shell');
    expect('json.settingsGetGzip', s => s.response.contentEncoding === 'gzip', 'pinned did not gzip the settings JSON');
    expect('revalidate.304', s => s.response.status === 304, 'the conditional static request did not answer 304');
    expect('range.bytes0to99', s => s.response.status === 206 && s.response.contentLength === '100', 'the range response was not a 100-byte 206');
    expect('range.bytes0to99', s => s.response.contentEncoding === null, 'pinned compressed a sub-threshold range body');
    expect('small.robotsTxt', s => s.response.contentEncoding === null && s.response.contentLength !== null, 'the sub-threshold response was compressed or lost its length');
    expect('head.script', s => s.response.contentEncoding === null && s.response.contentLength !== null, 'HEAD was compressed or lost its length');
    expect('binary.png', s => s.response.contentEncoding === null, 'pinned compressed an image/png');
    expect('sse.generateStream', s => s.response.contentEncoding === null, 'pinned compressed the SSE stream');
    expect('sse.generateStream', s => s.decoded.text.includes('data: [DONE]'), 'the SSE stream lost its terminator');

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned response compression: encoding choice, headers, raw and decoded bodies, and the SSE non-compression contract',
        middleware: {
            package: 'compression@^1.8.1 (src/server-main.js:107 app.use(compression()) with no options)',
            thresholdBytes: 1024,
            filter: 'compressible(Content-Type); Cache-Control no-transform respected',
            supportedEncodings: ['br', 'gzip', 'deflate', 'identity'],
            preferredEncodings: ['br', 'gzip'],
            brotliAvailableOnPinnedRuntime: true,
        },
        inputs: {
            settingsJson: settingsText,
            secrets: { api_key_openai: 'probe-openai-key' },
            generateBody: GENERATE_BODY,
            sseFrames: SSE_FRAMES,
            pngAsset: '/img/default-expressions/admiration.png',
        },
        scenarios,
        notRecorded: {
            etagValue: 'Express static derives it from size+mtime, so it differs on every checkout/re-record; only etagPresent is recorded',
            lastModified: 'same reason as etagValue',
            dateAndResponseTime: 'run-specific headers',
            compressedBytesAsByteContract: 'zlib and Go compress/gzip emit different deflate streams; the contract is encoding choice + headers + decoded bytes',
        },
        notes: [
            'The Go side must match the encoding CHOICE and headers, and the DECODED bytes; raw compressed bytes are evidence, not a byte-equality target.',
            'pinned prefers br when the client offers it (Node 24 has brotli). GoTavern without a brotli encoder answers gzip for that request; that is the one recorded deviation and it is asserted on both halves.',
            'SSE is not compressed because pinned forwards the provider stream with NO Content-Type, so the compression filter never matches; GoTavern sets no Content-Type there either (chat_completions.go), and this scenario guards that it stays so.',
        ],
    };
    const written = writeFixture(repositoryRoot, FIXTURE, fixture);
    console.log(`wrote ${written}`);
    for (const [name, scenario] of Object.entries(scenarios)) {
        console.log(`  ${name.padEnd(30)} status=${scenario.response.status} ce=${String(scenario.response.contentEncoding)} raw=${scenario.raw.bytes} decoded=${scenario.decoded.bytes}`);
    }
} finally {
    await server.stop();
}
