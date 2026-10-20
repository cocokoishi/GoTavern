#!/usr/bin/env node
// Capture the pinned frontend static middleware:
//
//	app.use(express.static(path.join(serverDirectory, 'public'), {}))   server-main.js:242
//
// which is mounted BEFORE requireLoginMiddleware (:248) and before
// setupPrivateEndpoints (:278). The URL space maps one-to-one onto
// <serverDirectory>/public/**, so a real file under public/ is served without
// authentication — including a real file in the global extensions directory at
// public/scripts/extensions/third-party/, which is why the extension route's
// global branch is reachable only for paths this middleware declines.
//
// The middleware is serve-static 1.16.x over send 0.19.0, so the media type comes
// from mime@1.6.0 and the caching/conditional/range/index/dotfile behaviour is
// send's. serve-static answers only GET and HEAD; everything else falls through
// to the rest of the application, as does any 404 send raises.
//
// This probe declares sharedWrite=true: it seeds files under public/, which the
// harness treats as a shared PUBLIC_DIRECTORIES subtree and gives a private build
// root for.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: fixture=sillytavern-1.19.0-frontend-static.json label="frontend static middleware" sharedWrite=true
const COOKIE_SECRET = 'gotavern-pinned-frontend-static-cookie-secret';
const FIXED_MTIME_SECONDS = 1700000000;
const FIXED_MTIME_MS = FIXED_MTIME_SECONDS * 1000;
// Everything this probe creates under the checkout lives below these two
// prefixes, so cleanup can only ever remove its own artifacts.
const SEED_DIRECTORY = 'probe-frontend-static';
const GLOBAL_EXTENSION_DIRECTORY = 'probe-frontend-static-ext';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-frontend-static.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-frontend-static-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const publicRoot = path.join(sourceRoot, 'public');
const logs = [];
let child;

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-frontend-static-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

function removeSeededPublicContent() {
    rmSync(path.join(publicRoot, SEED_DIRECTORY), { recursive: true, force: true });
    rmSync(path.join(publicRoot, 'scripts', 'extensions', 'third-party', GLOBAL_EXTENSION_DIRECTORY), { recursive: true, force: true });
}

// ---------------------------------------------------------------- http client

function rawRequest(origin, { method = 'GET', path: requestPath, headers = {}, body = null }) {
    const target = new URL(origin);
    return new Promise((resolve, reject) => {
        const request = http.request({
            host: target.hostname,
            port: target.port,
            method,
            path: requestPath,
            agent: false,
            headers: { 'Accept-Encoding': 'identity', ...headers },
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(chunks),
            }));
        });
        request.on('error', reject);
        request.end(body === null ? undefined : body);
    });
}

const SKIPPED_HEADERS = new Set(['connection', 'date', 'keep-alive', 'transfer-encoding', 'set-cookie', 'x-response-time']);

function stableHeaders(headers) {
    const result = {};
    for (const [name, value] of Object.entries(headers)) {
        if (SKIPPED_HEADERS.has(name)) continue;
        result[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function capture(result) {
    const text = result.body.toString('utf8');
    const roundTrips = Buffer.compare(Buffer.from(text, 'utf8'), result.body) === 0;
    return {
        status: result.status,
        headers: stableHeaders(result.headers),
        bodyBase64: result.body.toString('base64'),
        bodyText: roundTrips ? text : null,
    };
}

function captureErrorPage(label, result) {
    const contentType = String(result.headers['content-type'] ?? '');
    const body = result.body.toString('utf8');
    if (!contentType.startsWith('text/html') || !body.includes('<pre>')) {
        throw new Error(`${label}: expected Express finalhandler's error page, got ${result.status} ${contentType}: ${body.slice(0, 200)}`);
    }
    return { status: result.status, contentType };
}

function cookiesFrom(headers) {
    const raw = headers['set-cookie'];
    if (!raw) return [];
    return Array.isArray(raw) ? raw : [raw];
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function seedUser(key, value) {
    writeFileSync(path.join(dataRoot, '_storage', sha256(key)), JSON.stringify({ key, value }));
}

// ------------------------------------------------------------------- startup

async function waitForServer(origin) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before readiness:\n${logs.join('').slice(-10000)}`);
        try {
            const result = await rawRequest(origin, { path: '/login?noauto=1' });
            if (result.status === 200 && String(result.headers['content-type'] ?? '').includes('text/html')) return;
            lastError = new Error(`login returned ${result.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(`pinned server did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-10000)}`);
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

async function startServer(origin, port, configBody) {
    writeFileSync(configPath, configBody);
    child = spawn(process.execPath, [
        path.join(sourceRoot, 'server.js'),
        '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));
    await waitForServer(origin);
}

async function login(origin, handle) {
    const csrf = await rawRequest(origin, { path: '/csrf-token' });
    const token = JSON.parse(csrf.body.toString('utf8')).token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.headers));
    const body = JSON.stringify({ handle, password: '' });
    const result = await rawRequest(origin, {
        method: 'POST',
        path: '/api/users/login',
        headers: { Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token, 'Content-Length': Buffer.byteLength(body) },
        body,
    });
    if (result.status !== 200) {
        throw new Error(`could not login as ${handle}: ${result.status} ${result.body.toString('utf8')}\n${logs.join('').slice(-10000)}`);
    }
    return { token, cookie: cookieHeader(cookiesFrom(result.headers)) };
}

// -------------------------------------------------------------------- seeding

function seedFile(root, relative, content) {
    const target = path.join(root, relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
    const when = new Date(FIXED_MTIME_MS);
    utimesSync(target, when, when);
}

const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64');
const BINARY_BYTES = Buffer.from(Array.from({ length: 256 }, (unused, index) => index));

// Seeded below public/ so the pinned middleware serves them from disk. They live
// under one directory so cleanup can only ever remove this probe's artifacts.
const PUBLIC_FILES = {
    [`${SEED_DIRECTORY}/script.js`]: Buffer.from('window.frontendStatic = true;\n', 'utf8'),
    [`${SEED_DIRECTORY}/module.mjs`]: Buffer.from('export const probe = 1;\n', 'utf8'),
    [`${SEED_DIRECTORY}/style.css`]: Buffer.from('body { color: #abcdef; }\n', 'utf8'),
    [`${SEED_DIRECTORY}/data.json`]: Buffer.from('{"probe":true}', 'utf8'),
    [`${SEED_DIRECTORY}/page.html`]: Buffer.from('<!doctype html><title>Probe</title>\n', 'utf8'),
    [`${SEED_DIRECTORY}/pixel.png`]: PNG_BYTES,
    [`${SEED_DIRECTORY}/all-bytes.bin`]: BINARY_BYTES,
    [`${SEED_DIRECTORY}/no-extension`]: Buffer.from('no extension here\n', 'utf8'),
    [`${SEED_DIRECTORY}/unknown.zzz`]: Buffer.from('unknown extension\n', 'utf8'),
    [`${SEED_DIRECTORY}/notes.md`]: Buffer.from('# notes\n', 'utf8'),
    [`${SEED_DIRECTORY}/source.map`]: Buffer.from('{"version":3}', 'utf8'),
    [`${SEED_DIRECTORY}/empty.txt`]: Buffer.from('', 'utf8'),
    [`${SEED_DIRECTORY}/sub/nested.txt`]: Buffer.from('nested\n', 'utf8'),
    [`${SEED_DIRECTORY}/with-index/index.html`]: Buffer.from('<h1>index</h1>\n', 'utf8'),
    [`${SEED_DIRECTORY}/without-index/readme.txt`]: Buffer.from('no index\n', 'utf8'),
    [`${SEED_DIRECTORY}/.hidden`]: Buffer.from('dotfile\n', 'utf8'),
    [`${SEED_DIRECTORY}/.git/config`]: Buffer.from('[core]\n', 'utf8'),
    // A real file in the global extensions directory. The pinned static
    // middleware serves this without authentication, which is why the extension
    // route's global branch never sees it.
    [`scripts/extensions/third-party/${GLOBAL_EXTENSION_DIRECTORY}/script.js`]: Buffer.from('window.globalExtension = true;\n', 'utf8'),
    [`scripts/extensions/third-party/${GLOBAL_EXTENSION_DIRECTORY}/manifest.json`]: Buffer.from('{"display_name":"Frontend Static Global"}', 'utf8'),
};

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Frontend Static Probe', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '',
    });

    removeSeededPublicContent();
    for (const [relative, content] of Object.entries(PUBLIC_FILES)) seedFile(publicRoot, relative, content);

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    await startServer(origin, port, 'enableUserAccounts: true\nskipContentCheck: true\n');

    const admin = await login(origin, 'default-user');
    const base = `/${SEED_DIRECTORY}/`;
    const globalExtensionPath = `/scripts/extensions/third-party/${GLOBAL_EXTENSION_DIRECTORY}/script.js`;

    const responses = {};
    const errorPages = {};
    const record = async (label, result) => { responses[label] = capture(await result); };
    const recordErrorPage = async (label, result) => { errorPages[label] = captureErrorPage(label, await result); };

    // ---- unauthenticated: the point of this middleware --------------------
    // Every one of these is served before requireLoginMiddleware.
    const anonymous = {};
    anonymous.scriptJs = capture(await rawRequest(origin, { path: base + 'script.js' }));
    anonymous.pageHtml = capture(await rawRequest(origin, { path: base + 'page.html' }));
    anonymous.pixelPng = capture(await rawRequest(origin, { path: base + 'pixel.png' }));
    anonymous.globalExtension = capture(await rawRequest(origin, { path: globalExtensionPath }));
    // A miss falls through to the login middleware, which answers 403.
    anonymous.missing = capture(await rawRequest(origin, { path: base + 'missing.js' }));
    anonymous.dotfile = capture(await rawRequest(origin, { path: base + '.hidden' }));
    // serve-static answers only GET and HEAD, so a POST falls through as well.
    anonymous.post = capture(await rawRequest(origin, { method: 'POST', path: base + 'script.js' }));

    // ---- authenticated: same files, plus what only a session reaches ------
    const authed = { Cookie: admin.cookie };
    const get = (relative, headers = {}) => rawRequest(origin, { path: base + relative, headers: { ...authed, ...headers } });

    await record('localJs', get('script.js'));
    await record('localMjs', get('module.mjs'));
    await record('localCss', get('style.css'));
    await record('localJson', get('data.json'));
    await record('localHtml', get('page.html'));
    await record('localPng', get('pixel.png'));
    await record('localBinary', get('all-bytes.bin'));
    await record('localNoExtension', get('no-extension'));
    await record('localUnknownExtension', get('unknown.zzz'));
    await record('localMarkdown', get('notes.md'));
    await record('localSourceMap', get('source.map'));
    await record('localEmptyFile', get('empty.txt'));
    await record('localNested', get('sub/nested.txt'));
    await record('globalExtensionFile', rawRequest(origin, { path: globalExtensionPath, headers: authed }));
    // The middleware falls through on a miss, so a session reaches the
    // application's final 404 rather than a send() error document.
    await record('authenticatedMissing', rawRequest(origin, { path: base + 'missing.js', headers: authed }));
    await record('authenticatedDotfile', rawRequest(origin, { path: base + '.hidden', headers: authed }));
    await record('authenticatedPost', rawRequest(origin, { method: 'POST', path: base + 'script.js', headers: { ...authed, 'X-CSRF-Token': admin.token, 'Content-Length': 0 } }));

    // ---- directories ------------------------------------------------------
    await record('directoryWithIndex', get('with-index/'));
    await record('directoryWithoutSlash', get('with-index'));
    await record('directoryWithoutIndex', get('without-index/'));
    await record('directoryWithoutIndexNoSlash', get('without-index'));

    // ---- dotfiles ---------------------------------------------------------
    await record('dotfileMiddlePart', get('.git/config'));

    // ---- traversal --------------------------------------------------------
    // send() rejects a path whose "./"-normalized form still contains "..", but
    // serve-static only forwards an error once a file has been resolved. A
    // pre-resolution error therefore falls through to the application, exactly
    // like a miss.
    await record('authenticatedTraversal', rawRequest(origin, { path: `/${SEED_DIRECTORY}/%2e%2e%2fpackage.json`, headers: authed }));

    // ---- conditional requests --------------------------------------------
    const etag = responses.localJs.headers.etag;
    const lastModified = responses.localJs.headers['last-modified'];
    if (!etag || !lastModified) {
        throw new Error(`pinned static response is missing etag/last-modified: ${JSON.stringify(responses.localJs.headers)}`);
    }
    await record('conditionalIfNoneMatch', get('script.js', { 'If-None-Match': etag }));
    await record('conditionalIfNoneMatchStale', get('script.js', { 'If-None-Match': 'W/"1-1"' }));
    await record('conditionalIfModifiedSince', get('script.js', { 'If-Modified-Since': lastModified }));
    await record('conditionalIfModifiedSinceStale', get('script.js', { 'If-Modified-Since': new Date(FIXED_MTIME_MS - 60000).toUTCString() }));
    await recordErrorPage('conditionalIfMatchStale', get('script.js', { 'If-Match': 'W/"1-1"' }));
    await record('conditionalNoCacheRequest', get('script.js', { 'If-None-Match': etag, 'Cache-Control': 'no-cache' }));

    // ---- ranges -----------------------------------------------------------
    await record('rangeFirstBytes', get('all-bytes.bin', { Range: 'bytes=0-9' }));
    await record('rangeSuffix', get('all-bytes.bin', { Range: 'bytes=-10' }));
    await recordErrorPage('rangeUnsatisfiable', get('all-bytes.bin', { Range: 'bytes=9999-10000' }));
    await record('rangeMultiple', get('all-bytes.bin', { Range: 'bytes=0-1,4-5' }));

    // ---- HEAD -------------------------------------------------------------
    await record('headServesHeaders', rawRequest(origin, { method: 'HEAD', path: base + 'script.js', headers: authed }));

    // ---- self-checks ------------------------------------------------------
    const expectedEtag = (size, mtimeMs) => `W/"${size.toString(16)}-${mtimeMs.toString(16)}"`;
    for (const [label, content] of [
        ['localJs', PUBLIC_FILES[`${SEED_DIRECTORY}/script.js`]],
        ['localBinary', PUBLIC_FILES[`${SEED_DIRECTORY}/all-bytes.bin`]],
        ['localPng', PUBLIC_FILES[`${SEED_DIRECTORY}/pixel.png`]],
        ['localEmptyFile', PUBLIC_FILES[`${SEED_DIRECTORY}/empty.txt`]],
        ['localNested', PUBLIC_FILES[`${SEED_DIRECTORY}/sub/nested.txt`]],
        ['directoryWithIndex', PUBLIC_FILES[`${SEED_DIRECTORY}/with-index/index.html`]],
        ['dotfileMiddlePart', PUBLIC_FILES[`${SEED_DIRECTORY}/.git/config`]],
        ['globalExtensionFile', PUBLIC_FILES[`scripts/extensions/third-party/${GLOBAL_EXTENSION_DIRECTORY}/script.js`]],
    ]) {
        const recorded = Buffer.from(responses[label].bodyBase64, 'base64');
        if (Buffer.compare(recorded, content) !== 0) {
            throw new Error(`${label}: recorded bytes differ from the seeded bytes`);
        }
        const wantEtag = expectedEtag(content.length, FIXED_MTIME_MS);
        if (responses[label].headers.etag !== wantEtag) {
            throw new Error(`${label}: etag ${responses[label].headers.etag} is not the fixed-mtime ${wantEtag}`);
        }
    }
    // The unauthenticated observations are the contract this probe exists for:
    // a real public file is served before the login middleware, and a miss is not.
    if (anonymous.scriptJs.status !== 200 || anonymous.globalExtension.status !== 200) {
        throw new Error(`the pinned static middleware did not serve a public file without authentication: ${anonymous.scriptJs.status}/${anonymous.globalExtension.status}`);
    }
    if (anonymous.missing.status !== 403) {
        throw new Error(`a miss did not fall through to the login middleware: ${anonymous.missing.status}`);
    }
    if (anonymous.scriptJs.bodyBase64 !== Buffer.from(PUBLIC_FILES[`${SEED_DIRECTORY}/script.js`]).toString('base64')) {
        throw new Error('the unauthenticated response did not carry the seeded bytes');
    }
    if (anonymous.globalExtension.bodyBase64 !== Buffer.from(PUBLIC_FILES[`scripts/extensions/third-party/${GLOBAL_EXTENSION_DIRECTORY}/script.js`]).toString('base64')) {
        throw new Error('the global extension file was not served by the static middleware');
    }

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned frontend static middleware: express.static(serverDirectory/public) before authentication, serve-static/send headers, conditional requests, ranges, directory and dotfile handling, method fallthrough, and the global-extension shadowing case',
        normalizations: [
            'Every response body is recorded as base64 bytes, plus bodyText when the bytes round-trip through UTF-8. No byte is normalized.',
            'Every seeded file is given the exact whole-second modification time 1700000000, so send()\'s ETag (file size and mtime in milliseconds, hex) and Last-Modified are properties of the fixture rather than of the recording host. The probe fails if a recorded ETag is not the fixed-mtime value.',
            'The probe declares sharedWrite=true, so the harness gives it a private build root and its writes under public/ cannot reach any other probe. It still removes exactly its own two seeded directories before and after each run.',
            'Requests are sent with Accept-Encoding: identity, so the recorded framing is a property of the middleware rather than of the pinned compression middleware.',
            'Connection, Date, Keep-Alive, Transfer-Encoding, Set-Cookie and X-Response-Time are not recorded: they are properties of the connection, the clock or the session rather than of the middleware.',
            'Requests are issued with node:http and an explicit path with keep-alive disabled, because fetch would normalize percent-encoded and literal dot segments in the WHATWG URL parser and hide the traversal behaviour under test.',
            'Express finalhandler\'s error page is a V8 stack trace carrying host-absolute paths and pinned line numbers, so the responses that produce it are recorded in errorPages as status and content type only.',
        ],
        gaps: [
            'serve-static forwards a 404 from send to next() when fallthrough is on, so a missing path is answered by whatever the application does next: the login middleware answers 403 without a session and the application\'s final 404 handler answers an empty page with one. The middleware itself never produces a 404.',
            'The media type comes from send@0.19.0\'s mime@1.6.0 dependency on this path too, so the frontend and extension static routes share one pinned table; mime.TypeByExtension is not used for either.',
            'This probe covers the pinned middleware reading <serverDirectory>/public from disk. GoTavern also embeds the vendored public tree, and an embedded file has no modification time, so a response served from the embedded copy cannot carry the pinned ETag or Last-Modified. That difference is named in docs/compat-matrix.md.',
            'A malformed percent escape is rejected by Go\'s HTTP server while Node passes it to the middleware; a literal ".." segment is cleaned by Go\'s ServeMux into a redirect while Node reaches send\'s own 403.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            seededUsers: [
                { handle: 'default-user', name: 'Frontend Static Probe', created: 1700000000000, password: '', admin: true, enabled: true, salt: '' },
            ],
            fixedMtimeSeconds: FIXED_MTIME_SECONDS,
            seedDirectory: SEED_DIRECTORY,
            globalExtensionDirectory: GLOBAL_EXTENSION_DIRECTORY,
            publicFiles: Object.fromEntries(Object.entries(PUBLIC_FILES).map(([relative, content]) => [relative, content.toString('base64')])),
        },
        responses,
        errorPages,
        anonymous,
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-frontend-static.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned frontend static middleware behavior`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    try {
        removeSeededPublicContent();
    } catch {
        // The harness discards a private build root anyway.
    }
    safeCleanup();
}
