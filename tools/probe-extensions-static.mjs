#!/usr/bin/env node
// Capture pinned extension static serving: /scripts/extensions/third-party/*
// (src/users.js:1219, createExtensionsRouteHandler).
//
// Every observation is made against the requesting user's own extensions
// directory, which lives under this probe's temporary data root, so the probe
// writes nothing into the shared pinned checkout and cannot race the other
// probes the harness runs concurrently.
//
// The handler's global branch (PUBLIC_DIRECTORIES.globalExtensions) is reached
// through the tracked public/scripts/extensions/third-party/.gitkeep: the
// frontend static middleware mounted at server-main.js:242 declines a dotfile,
// so the request falls through to this route, the per-user root misses, and the
// global branch answers. That pins the fallback without creating any file under
// the checkout.
//
// Two things this probe deliberately does NOT record, because they are served by
// the frontend static middleware rather than by this route and recording them
// would be a false observation of the route under test:
//   - a real file that exists in the global extensions directory (express.static
//     serves /scripts/extensions/third-party/<path> from
//     <serverDirectory>/public/scripts/extensions/third-party/<path> before the
//     login middleware and before this route);
//   - the exact mount path /scripts/extensions/third-party, which maps onto that
//     existing directory and is therefore handled by express.static.

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
// @gotavern-oracle: fixture=sillytavern-1.19.0-extensions-static.json label="extension static serving"
const COOKIE_SECRET = 'gotavern-pinned-extensions-static-cookie-secret';
const FIREFOX_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64; rv:119.0) Gecko/20100101 Firefox/119.0';
const CHROME_USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36';
// Every seeded file gets this exact whole-second modification time, so send()'s
// ETag (file size and mtime in milliseconds, hex) and Last-Modified are
// properties of the fixture rather than of the recording host.
const FIXED_MTIME_SECONDS = 1700000000;
const FIXED_MTIME_MS = FIXED_MTIME_SECONDS * 1000;
// The only entry the pinned checkout tracks inside the global extension root.
const GLOBAL_ROOT_PLACEHOLDER = '.gitkeep';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-extensions-static.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-extensions-static-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const globalRootPlaceholderPath = path.join(sourceRoot, 'public', 'scripts', 'extensions', 'third-party', GLOBAL_ROOT_PLACEHOLDER);
const logs = [];
let child;

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-extensions-static-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

// ---------------------------------------------------------------- http client

// A raw request is used for every observation: node:http sends `path` verbatim,
// so percent-encoded traversal and literal ".." segments reach the route
// unmodified. fetch would normalize them in the WHATWG URL parser, which would
// hide exactly the behaviour this probe has to record. keep-alive is disabled so
// a reused socket can never be confused for a fresh observation.
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

// Express's res.sendFile attaches an error listener to the send stream, so every
// error send raises (a declined dotfile, a directory with no index, an
// unsatisfiable range, send's own UP_PATH rejection) is emitted as an error and
// rendered by Express finalhandler instead of by send. That page is a V8 stack
// trace with host-absolute paths and pinned line numbers, so it cannot be
// recorded; the status and content type are what remain host-independent, and
// the content type is what tells this page apart from the route's own
// plain-text sendStatus responses.
function captureErrorPage(label, result) {
    const contentType = String(result.headers['content-type'] ?? '');
    const body = result.body.toString('utf8');
    if (!contentType.startsWith('text/html') || !body.includes('<pre>')) {
        throw new Error(`${label}: expected Express finalhandler's error page, got ${result.status} ${contentType}: ${body.slice(0, 200)}`);
    }
    const captured = { status: result.status, contentType };
    // send() sets Content-Range on the response before raising the 416, so that
    // one header survives into finalhandler's page and is host-independent.
    const contentRange = result.headers['content-range'];
    if (contentRange !== undefined) {
        captured.contentRange = String(contentRange);
    }
    return captured;
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

// Seeded into the requesting user's own extensions directory, which is inside
// this probe's temporary data root.
const LOCAL_FILES = {
    'static-probe/script.js': Buffer.from('window.staticProbe = "local";\n', 'utf8'),
    'static-probe/module.mjs': Buffer.from('export const probe = 1;\n', 'utf8'),
    'static-probe/style.css': Buffer.from('body { color: #123456; }\n', 'utf8'),
    'static-probe/manifest.json': Buffer.from('{"display_name":"Static Probe","version":"1.0.0"}', 'utf8'),
    'static-probe/page.html': Buffer.from('<!doctype html><title>Static Probe</title>\n', 'utf8'),
    'static-probe/pixel.png': PNG_BYTES,
    'static-probe/all-bytes.bin': BINARY_BYTES,
    'static-probe/no-extension': Buffer.from('no extension here\n', 'utf8'),
    'static-probe/unknown.zzz': Buffer.from('unknown extension\n', 'utf8'),
    'static-probe/empty.txt': Buffer.from('', 'utf8'),
    'static-probe/with space.js': Buffer.from('spaced\n', 'utf8'),
    'static-probe/notes.md': Buffer.from('# notes\n', 'utf8'),
    'static-probe/source.map': Buffer.from('{"version":3}', 'utf8'),
    'static-probe/sub/nested.txt': Buffer.from('nested local\n', 'utf8'),
    'static-probe/sub/index.html': Buffer.from('<h1>index</h1>\n', 'utf8'),
    'static-probe/no-index/readme.txt': Buffer.from('no index here\n', 'utf8'),
    'static-probe/.hidden': Buffer.from('dotfile\n', 'utf8'),
    'static-probe/.git/config': Buffer.from('[core]\n', 'utf8'),
    'traversal-probe/inside.txt': Buffer.from('inside the served root\n', 'utf8'),
};

// A real file outside the served root, so a traversal that is not rejected would
// serve something recognisable instead of a 404. Still inside the probe's own
// data root.
const OUTSIDE_FILES = {
    'secret.txt': Buffer.from('outside the served root\n', 'utf8'),
};

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Static Probe', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '',
    });

    // The global branch is observed through this tracked placeholder; without it
    // the fixture could not tell the global branch apart from the route's own
    // 404, so refuse to run rather than record a vacuous observation.
    if (!existsSync(globalRootPlaceholderPath)) {
        throw new Error(`the pinned checkout does not track ${path.relative(sourceRoot, globalRootPlaceholderPath)}, which this probe needs to reach the handler's global branch without writing into the shared checkout`);
    }

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    await startServer(origin, port, 'enableUserAccounts: true\nskipContentCheck: true\nextensions:\n  enabled: true\n');

    const userRoot = path.join(dataRoot, 'default-user');
    const localRoot = path.join(userRoot, 'extensions');
    rmSync(localRoot, { recursive: true, force: true });
    mkdirSync(localRoot, { recursive: true });
    for (const [relative, content] of Object.entries(LOCAL_FILES)) seedFile(localRoot, relative, content);
    for (const [relative, content] of Object.entries(OUTSIDE_FILES)) seedFile(userRoot, relative, content);

    const admin = await login(origin, 'default-user');
    const base = '/scripts/extensions/third-party/';
    const authed = { Cookie: admin.cookie };
    const get = (relative, headers = {}) => rawRequest(origin, { path: base + relative, headers: { ...authed, ...headers } });

    const responses = {};
    const errorPages = {};
    const record = async (label, result) => { responses[label] = capture(await result); };
    const recordErrorPage = async (label, result) => { errorPages[label] = captureErrorPage(label, await result); };

    // ---- local files, one per MIME class ---------------------------------
    await record('localJs', get('static-probe/script.js'));
    await record('localMjs', get('static-probe/module.mjs'));
    await record('localCss', get('static-probe/style.css'));
    await record('localJson', get('static-probe/manifest.json'));
    await record('localHtml', get('static-probe/page.html'));
    await record('localPng', get('static-probe/pixel.png'));
    await record('localBinary', get('static-probe/all-bytes.bin'));
    await record('localNoExtension', get('static-probe/no-extension'));
    await record('localUnknownExtension', get('static-probe/unknown.zzz'));
    await record('localMarkdown', get('static-probe/notes.md'));
    await record('localSourceMap', get('static-probe/source.map'));
    await record('localEmptyFile', get('static-probe/empty.txt'));
    await record('localNested', get('static-probe/sub/nested.txt'));
    await record('localEncodedSpace', get('static-probe/with%20space.js'));
    await record('localMissing', get('static-probe/does-not-exist.js'));

    // ---- the handler's global branch --------------------------------------
    // express.static declines the dotfile, the per-user root misses, and the
    // global branch finds it. send() then declines the dotfile as well, and
    // because Express attached an error listener the answer is Express's
    // finalhandler page, not the route's plain-text 404. The two are told apart
    // by content type, which is why this is recorded as an error page.
    await recordErrorPage('globalBranchPlaceholder', get(GLOBAL_ROOT_PLACEHOLDER));
    await record('globalBranchPlaceholderMissing', get('static-probe-missing/' + GLOBAL_ROOT_PLACEHOLDER));

    // ---- directories ------------------------------------------------------
    await record('directoryWithoutSlash', get('static-probe/sub'));
    await record('directoryWithIndex', get('static-probe/sub/'));
    await recordErrorPage('directoryWithoutIndex', get('static-probe/no-index/'));
    await record('directoryNoIndexNoSlash', get('static-probe/no-index'));

    // ---- dotfiles ---------------------------------------------------------
    // send()'s legacy dotfile rule looks at the LAST path part only, so a
    // trailing dotfile is declined while a dotfile in a middle segment is served.
    await recordErrorPage('dotfileLastPart', get('static-probe/.hidden'));
    await record('dotfileMiddlePart', get('static-probe/.git/config'));

    // ---- traversal --------------------------------------------------------
    // path.join() collapses the dot segments, so a traversal only leaves the
    // served root when the decoded path has more leading ".." than the served
    // root is deep. secret.txt exists one level above the served root, so a
    // broken containment check would serve it rather than answer 403.
    await record('encodedTraversal', get('%2e%2e%2fsecret.txt'));
    await record('encodedTraversalDeep', get('%2e%2e%2f%2e%2e%2fdefault-user%2fsecret.txt'));
    await record('encodedTraversalStaysInside', get('static-probe/%2e%2e%2fsecret.txt'));
    await record('absolutePathSegment', get('%2fetc%2fpasswd'));
    // send()'s own UP_PATH rejection is unreachable through this route: the
    // route runs isPathUnderParent on the already-normalized path.join() result,
    // so any path whose "./"-normalized form would still contain ".." has already
    // been answered with the route's plain-text 403.
    await record('traversalTwoLevelsInsideRoot', get('traversal-probe/%2e%2e%2f%2e%2e%2ftraversal-probe/inside.txt'));

    // ---- the mount's empty wildcard --------------------------------------
    // express.static falls through for the bare directory (no index.html), so the
    // route runs and res.sendFile('') throws into its 500.
    await record('emptyWildcard', get(''));

    // ---- methods ----------------------------------------------------------
    // The pinned mount is router.use, which matches every method. The CSRF
    // middleware runs before the router, so the POST carries a valid token;
    // without one this would record the CSRF rejection instead of the route.
    await record('postServesFile', rawRequest(origin, {
        method: 'POST',
        path: base + 'static-probe/script.js',
        headers: { ...authed, 'X-CSRF-Token': admin.token, 'Content-Length': 0 },
    }));
    await record('headServesHeaders', rawRequest(origin, { method: 'HEAD', path: base + 'static-probe/script.js', headers: authed }));

    // ---- conditional requests --------------------------------------------
    const etag = responses.localJs.headers.etag;
    const lastModified = responses.localJs.headers['last-modified'];
    if (!etag || !lastModified) {
        throw new Error(`pinned local file response is missing etag/last-modified: ${JSON.stringify(responses.localJs.headers)}`);
    }
    await record('conditionalIfNoneMatch', get('static-probe/script.js', { 'If-None-Match': etag }));
    await record('conditionalIfNoneMatchStale', get('static-probe/script.js', { 'If-None-Match': 'W/"1-1"' }));
    await record('conditionalIfNoneMatchStar', get('static-probe/script.js', { 'If-None-Match': '*' }));
    await record('conditionalIfModifiedSince', get('static-probe/script.js', { 'If-Modified-Since': lastModified }));
    await record('conditionalIfModifiedSinceStale', get('static-probe/script.js', { 'If-Modified-Since': new Date(FIXED_MTIME_MS - 60000).toUTCString() }));
    await recordErrorPage('conditionalIfMatchStale', get('static-probe/script.js', { 'If-Match': 'W/"1-1"' }));
    await recordErrorPage('conditionalIfUnmodifiedSinceStale', get('static-probe/script.js', { 'If-Unmodified-Since': new Date(FIXED_MTIME_MS - 60000).toUTCString() }));
    await record('conditionalNoCacheRequest', get('static-probe/script.js', { 'If-None-Match': etag, 'Cache-Control': 'no-cache' }));

    // ---- ranges -----------------------------------------------------------
    await record('rangeFirstBytes', get('static-probe/all-bytes.bin', { Range: 'bytes=0-9' }));
    await record('rangeSuffix', get('static-probe/all-bytes.bin', { Range: 'bytes=-10' }));
    await record('rangeOpenEnded', get('static-probe/all-bytes.bin', { Range: 'bytes=250-' }));
    await recordErrorPage('rangeUnsatisfiable', get('static-probe/all-bytes.bin', { Range: 'bytes=9999-10000' }));
    // range-parser answers -1 for a malformed byte range too, so this is the same
    // 416 path as an unsatisfiable one.
    await recordErrorPage('rangeMalformed', get('static-probe/all-bytes.bin', { Range: 'bytes=abc' }));
    // A multi-range request is treated as a regular response: send() only honours
    // a single range.
    await record('rangeMultiple', get('static-probe/all-bytes.bin', { Range: 'bytes=0-1,4-5' }));

    // ---- user agent -------------------------------------------------------
    // createExtensionsRouteHandler does NOT call invalidateFirefoxCache: that call
    // is in createRouteHandler only (users.js:1079). These observations pin its
    // absence here, so an implementation that helpfully added Firefox cache
    // invalidation to this route would fail.
    await record('firefoxImage', get('static-probe/pixel.png', { 'User-Agent': FIREFOX_USER_AGENT }));
    await record('firefoxNonImage', get('static-probe/script.js', { 'User-Agent': FIREFOX_USER_AGENT }));
    await record('firefoxUnknownType', get('static-probe/unknown.zzz', { 'User-Agent': FIREFOX_USER_AGENT }));
    await record('chromeImage', get('static-probe/pixel.png', { 'User-Agent': CHROME_USER_AGENT }));
    await record('firefoxImageRange', get('static-probe/pixel.png', { 'User-Agent': FIREFOX_USER_AGENT, Range: 'bytes=0-3' }));

    // ---- unauthenticated --------------------------------------------------
    const unauthenticated = {};
    unauthenticated.localFile = capture(await rawRequest(origin, { path: base + 'static-probe/script.js' }));
    unauthenticated.missing = capture(await rawRequest(origin, { path: base + 'static-probe/nope.js' }));
    unauthenticated.globalPlaceholder = capture(await rawRequest(origin, { path: base + GLOBAL_ROOT_PLACEHOLDER }));

    await stopServer();

    // ---- extensions.enabled = false --------------------------------------
    const disabled = {};
    const disabledPort = await choosePort();
    const disabledOrigin = `http://127.0.0.1:${disabledPort}`;
    await startServer(disabledOrigin, disabledPort, 'enableUserAccounts: true\nskipContentCheck: true\nextensions:\n  enabled: false\n');
    const disabledAdmin = await login(disabledOrigin, 'default-user');
    const disabledHeaders = { Cookie: disabledAdmin.cookie };
    disabled.localFile = capture(await rawRequest(disabledOrigin, { path: base + 'static-probe/script.js', headers: disabledHeaders }));
    disabled.globalPlaceholder = capture(await rawRequest(disabledOrigin, { path: base + GLOBAL_ROOT_PLACEHOLDER, headers: disabledHeaders }));
    disabled.traversal = capture(await rawRequest(disabledOrigin, { path: base + 'static-probe/%2e%2e%2fsecret.txt', headers: disabledHeaders }));
    disabled.emptyWildcard = capture(await rawRequest(disabledOrigin, { path: base, headers: disabledHeaders }));
    disabled.unauthenticated = capture(await rawRequest(disabledOrigin, { path: base + 'static-probe/script.js' }));
    await stopServer();

    // ---- self-checks ------------------------------------------------------
    // The recorded bytes must be the seeded bytes, and the ETag/Last-Modified
    // must be the fixed-mtime values; otherwise the fixture would be recording
    // something other than what it claims to have seeded.
    const expectedEtag = (size, mtimeMs) => `W/"${size.toString(16)}-${mtimeMs.toString(16)}"`;
    for (const [label, content] of [
        ['localJs', LOCAL_FILES['static-probe/script.js']],
        ['localMjs', LOCAL_FILES['static-probe/module.mjs']],
        ['localBinary', LOCAL_FILES['static-probe/all-bytes.bin']],
        ['localPng', LOCAL_FILES['static-probe/pixel.png']],
        ['localEmptyFile', LOCAL_FILES['static-probe/empty.txt']],
        ['localNested', LOCAL_FILES['static-probe/sub/nested.txt']],
        ['localEncodedSpace', LOCAL_FILES['static-probe/with space.js']],
        ['dotfileMiddlePart', LOCAL_FILES['static-probe/.git/config']],
        ['directoryWithIndex', LOCAL_FILES['static-probe/sub/index.html']],
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
    const binary = Buffer.from(responses.localBinary.bodyBase64, 'base64');
    if (binary.length !== 256 || binary[0] !== 0 || binary[255] !== 255) {
        throw new Error('localBinary did not round-trip all 256 byte values');
    }
    if (responses.encodedTraversal.status !== 403) {
        throw new Error(`encodedTraversal is ${responses.encodedTraversal.status}, not the route's 403`);
    }
    // The global branch must be distinguishable from the route's own 404: the
    // branch is reached only for paths the frontend static middleware declines,
    // and every such path then fails inside send(), which answers Express's HTML
    // error page rather than the route's plain-text sendStatus.
    const placeholder = errorPages.globalBranchPlaceholder;
    if (!placeholder || placeholder.status !== 404 || !placeholder.contentType.startsWith('text/html')) {
        throw new Error(`globalBranchPlaceholder is not the finalhandler error page, so the fixture would not distinguish the global branch from the route's own 404: ${JSON.stringify(placeholder)}`);
    }
    const routeMissing = responses.localMissing;
    if (routeMissing.status !== 404 || !String(routeMissing.headers['content-type'] ?? '').startsWith('text/plain')) {
        throw new Error(`localMissing is not the route's own plain-text 404, so the two 404 shapes are not discriminated: ${JSON.stringify(routeMissing)}`);
    }
    if (!errorPages.dotfileLastPart || !errorPages.directoryWithoutIndex || !errorPages.rangeUnsatisfiable || !errorPages.rangeMalformed
        || !errorPages.conditionalIfMatchStale || !errorPages.conditionalIfUnmodifiedSinceStale) {
        throw new Error('an expected send() error case was not recorded as an Express error page');
    }

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned extension static serving: /scripts/extensions/third-party/* from the per-user root, the handler\'s global branch, exact response bytes, MIME types, cache/conditional/range headers, directory and dotfile handling, traversal, methods and the extensions.enabled guard',
        normalizations: [
            'Every response body is recorded as base64 bytes, plus bodyText when the bytes round-trip through UTF-8. No byte is normalized.',
            'Every seeded file is given the exact whole-second modification time 1700000000, so send()\'s ETag (file size and mtime in milliseconds, hex) and Last-Modified are properties of the fixture rather than of the recording host. The probe fails if a recorded ETag is not the fixed-mtime value.',
            'All seeded content lives under the probe\'s own temporary data root. Nothing is written into the shared pinned checkout, so this probe cannot race the other probes the harness runs concurrently.',
            'The handler\'s global branch is reached through the tracked public/scripts/extensions/third-party/.gitkeep, which the frontend static middleware declines as a dotfile. The probe asserts the result is Express finalhandler\'s HTML error page and not the route\'s plain-text 404, so the fixture cannot silently stop discriminating the two.',
            'Express\'s res.sendFile attaches error, directory, file, stream and end listeners to the send stream, so several of send\'s own behaviours never reach the client. A send error (a declined dotfile, a directory with no index, an unsatisfiable or malformed range, a failed precondition) is rendered by Express finalhandler as a V8 stack page, and a directory request without a trailing slash is turned into a plain next() that lands on the application\'s final 404. Error pages are recorded in errorPages as status, content type and, for the 416 cases, Content-Range only, because the page carries host-absolute paths and pinned line numbers.',
            'createExtensionsRouteHandler does not call invalidateFirefoxCache: that call exists only in createRouteHandler (users.js:1079). The Firefox user-agent observations therefore pin the absence of Firefox cache invalidation on this route.',
            'Requests are sent with Accept-Encoding: identity, so the recorded framing is a property of the route rather than of the pinned compression middleware.',
            'Connection, Date, Keep-Alive, Transfer-Encoding, Set-Cookie and X-Response-Time are not recorded: they are properties of the connection, the clock or the session rather than of the route.',
            'Requests are issued with node:http and an explicit path with keep-alive disabled, because fetch would normalize percent-encoded and literal dot segments in the WHATWG URL parser and hide the traversal behaviour under test.',
            'Two behaviours are deliberately NOT recorded because the frontend static middleware at server-main.js:242 serves them before this route and the login middleware: a real file that exists in the global extensions directory, and the exact mount path /scripts/extensions/third-party. See the fixture\'s gaps.',
        ],
        gaps: [
            'A real file in the global extensions directory cannot be observed through this route: express.static(serverDirectory/public) is mounted before requireLoginMiddleware and before setupPrivateEndpoints, so /scripts/extensions/third-party/<path> is served from <serverDirectory>/public/scripts/extensions/third-party/<path> by the static middleware. The route\'s global branch is therefore reachable only for paths that middleware declines, and per-user precedence over an existing global file is not observable here.',
            'For the same reason the exact mount path /scripts/extensions/third-party maps onto the existing global directory and is handled by express.static, not by this route.',
            'A malformed percent escape in the request path is rejected by Go\'s HTTP server while Node passes it to the route, which answers 500; a literal ".." segment is cleaned by Go\'s ServeMux into a redirect while Node passes it to the route, which answers 403.',
            'send()\'s directory redirect (301 plus a Location header) is unreachable through this route, because Express\'s res.sendFile attaches a directory listener that turns the directory case into next(). A directory without a trailing slash therefore answers the application\'s final 404, and a directory with one is handled by send\'s index lookup. send\'s own UP_PATH 403 is unreachable too, because the route runs its containment check on the already-normalized path.join() result.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            seededUsers: [
                { handle: 'default-user', name: 'Static Probe', created: 1700000000000, password: '', admin: true, enabled: true, salt: '' },
            ],
            fixedMtimeSeconds: FIXED_MTIME_SECONDS,
            firefoxUserAgent: FIREFOX_USER_AGENT,
            chromeUserAgent: CHROME_USER_AGENT,
            globalRootPlaceholder: GLOBAL_ROOT_PLACEHOLDER,
            localFiles: Object.fromEntries(Object.entries(LOCAL_FILES).map(([relative, content]) => [relative, content.toString('base64')])),
            outsideFiles: Object.fromEntries(Object.entries(OUTSIDE_FILES).map(([relative, content]) => [relative, content.toString('base64')])),
        },
        responses,
        errorPages,
        unauthenticated,
        disabled,
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-extensions-static.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned extension static-serving behavior`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
