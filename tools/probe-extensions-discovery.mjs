#!/usr/bin/env node
// Capture what pinned SillyTavern reports as its SYSTEM (built-in) extension
// list on a fresh install, and record the files behind every name it reports.
//
// Why this probe exists: a release-shaped GoTavern install staged no
// `public/scripts/extensions` tree, so `/api/extensions/discover` answered an
// EMPTY system list and the pinned frontend loaded no built-in extension at all.
// The pinned answer for the same state is not a measurement anyone can derive:
// it is `fs.readdirSync(PUBLIC_DIRECTORIES.extensions)` filtered by pinned
// (src/endpoints/extensions.js:506-511). This probe records that answer, in the
// state a user actually gets — no seeded user extensions, no seeded global
// extensions — so the Go side can be compared against pinned rather than
// against a hand-derived list.
//
// Nothing is seeded anywhere:
//   - the user extensions directory lives in this probe's temporary data root
//     and is removed before the call, so the discover route's own recreation is
//     the only thing that can put it back;
//   - the global extensions directory is the pinned checkout's TRACKED
//     public/scripts/extensions/third-party, which ships only `.gitkeep`. The
//     probe REFUSES to run when a sibling probe left a directory there, because
//     a global entry would then appear in the recorded list and the fixture
//     would depend on scheduling rather than on pinned behaviour;
//   - the system extensions are the pinned checkout's own public/ fleet, which
//     is what a real install has.
//
// The per-file digests are recorded from the PINNED CHECKOUT, not from
// GoTavern's embedded copy, so the Go test's "every built-in discovery names has
// embedded files behind it" assertion is anchored to upstream bytes instead of
// to the embedded tree describing itself.
//
// Host-dependent values: none are recorded. There is no path, no port and no
// modification time in the fixture. `fs.readdirSync` order is a property of the
// recording host's filesystem (ext4 hash order, NTFS name order), so the
// discovery list is recorded sorted within the pinned group order and the
// comparison is order-insensitive; every file list is sorted by relative path.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: fixture=sillytavern-1.19.0-extensions-discovery.json label="built-in extension discovery on a fresh install"
const COOKIE_SECRET = 'gotavern-pinned-extensions-discovery-cookie-secret';
const CONFIG = 'enableUserAccounts: true\nskipContentCheck: true\nextensions:\n  enabled: true\n';
// The only entry the pinned checkout tracks inside the global extensions root.
const GLOBAL_ROOT_PLACEHOLDER = '.gitkeep';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-extensions-discovery.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-extensions-discovery-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const systemRoot = path.join(sourceRoot, 'public', 'scripts', 'extensions');
const globalRoot = path.join(systemRoot, 'third-party');
const logs = [];
let child;

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-extensions-discovery-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

// ---------------------------------------------------------------- http client

// A raw request is used rather than fetch so the request path reaches the route
// verbatim and no response body is re-encoded on the way in.
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

// Only headers that are properties of the route rather than of the connection or
// the clock are recorded. ETag and Last-Modified are deliberately NOT recorded:
// send() derives them from stat().mtime, and a runtime that serves the same bytes
// from its embedded copy has no modification time to describe (static.go:46-52
// and the "Frontend static middleware" row of docs/compat-matrix.md). Recording
// them would assert a value the embedded path cannot carry.
const SKIPPED_HEADERS = new Set(['connection', 'date', 'keep-alive', 'etag', 'last-modified', 'transfer-encoding', 'set-cookie', 'x-response-time']);

function stableHeaders(headers) {
    const result = {};
    for (const [name, value] of Object.entries(headers)) {
        if (SKIPPED_HEADERS.has(name)) continue;
        result[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
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

// ------------------------------------------------------------ filesystem view

// Sorted relative paths with their bytes' digests, taken from the pinned
// checkout. Sizes and mtimes are not recorded: they are properties of the
// extraction, not of the file.
function snapshotDigests(root) {
    const entries = [];
    const walk = (directory, prefix) => {
        for (const name of readdirSync(directory).sort()) {
            const absolute = path.join(directory, name);
            const relative = prefix ? `${prefix}/${name}` : name;
            const info = statSync(absolute);
            if (info.isDirectory()) {
                walk(absolute, relative);
                continue;
            }
            entries.push({ path: relative, sha256: sha256(readFileSync(absolute)) });
        }
    };
    walk(root, '');
    entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return entries;
}

// --------------------------------------------------------------- normalization

// src/endpoints/extensions.js:506-530 concatenates three readdirSync results
// without sorting; only the grouping is pinned.
const DISCOVERY_GROUP_ORDER = ['system', 'local', 'global'];

function normalizeDiscovery(entries) {
    if (!Array.isArray(entries)) return entries;
    const result = [];
    for (const type of DISCOVERY_GROUP_ORDER) {
        const group = entries
            .filter(entry => entry && entry.type === type)
            .map(entry => ({ type: entry.type, name: entry.name }))
            .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
        result.push(...group);
    }
    return result;
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

async function startServer(origin, port) {
    writeFileSync(configPath, CONFIG);
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

// ---------------------------------------------------------------- observations

// The two files per built-in extension that the pinned frontend asks for: the
// manifest the discover loop reads to build each entry, and the module the
// extension loader imports. Recorded from the frontend static middleware, which
// is the surface a browser actually reaches (server-main.js:242), not from the
// extension route under /api.
const STATIC_PROBE_FILES = ['manifest.json', 'index.js'];

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Extensions Discovery Probe', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '',
    });

    // "No seeded extensions" has to be true, not assumed. A directory left in the
    // global extensions root by a sibling probe would add a `global` entry and a
    // directory in the system root would change the system list; either would
    // make the recorded answer depend on scheduling.
    for (const [label, root] of [['system', systemRoot], ['global', globalRoot]]) {
        if (!existsSync(root) || !statSync(root).isDirectory()) {
            throw new Error(`the pinned checkout has no ${label} extensions directory, so the probe would record a state pinned cannot be in`);
        }
    }
    const strayGlobal = readdirSync(globalRoot).filter(name => {
        try {
            return statSync(path.join(globalRoot, name)).isDirectory();
        } catch {
            return false;
        }
    });
    if (strayGlobal.length > 0) {
        throw new Error(`the pinned checkout's global extensions root is not empty (${strayGlobal.join(', ')}), so this probe cannot record a fresh install: another probe is writing into the shared checkout`);
    }
    if (!existsSync(path.join(globalRoot, GLOBAL_ROOT_PLACEHOLDER))) {
        throw new Error(`the pinned checkout does not track ${GLOBAL_ROOT_PLACEHOLDER} in its global extensions root, so the probe cannot tell a fresh global root from a wiped one`);
    }

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    await startServer(origin, port);

    const userExtensionsRoot = path.join(dataRoot, 'default-user', 'extensions');
    // A fresh install's user is what the route must answer for, so remove the
    // startup-created directory: the route recreates it (extensions.js:481-483)
    // and that recreation is recorded as an observation rather than trusted.
    rmSync(userExtensionsRoot, { recursive: true, force: true });

    const admin = await login(origin, 'default-user');
    const authed = { Cookie: admin.cookie };

    const discoveryResponse = await rawRequest(origin, { path: '/api/extensions/discover', headers: authed });
    const extra = {};
    extra.userExtensionsDirectoryRecreated = existsSync(userExtensionsRoot) && statSync(userExtensionsRoot).isDirectory();
    if (!extra.userExtensionsDirectoryRecreated) {
        throw new Error('/api/extensions/discover did not recreate the missing user extensions directory');
    }
    if (discoveryResponse.status !== 200) {
        throw new Error(`/api/extensions/discover answered ${discoveryResponse.status}: ${discoveryResponse.body.toString('utf8').slice(0, 400)}`);
    }
    const rawDiscovery = JSON.parse(discoveryResponse.body.toString('utf8'));
    const entries = normalizeDiscovery(rawDiscovery);
    // normalizeDiscovery only keeps the three pinned groups, so counting the
    // normalized list would hide a fourth group rather than fail on it.
    if (!Array.isArray(rawDiscovery) || rawDiscovery.length !== entries.length) {
        throw new Error(`pinned reported an entry outside the pinned groups: ${JSON.stringify(rawDiscovery)}`);
    }
    const systemNames = entries.filter(entry => entry.type === 'system').map(entry => entry.name);
    // This is the release blocker's whole point: an empty system list means the
    // pinned frontend loads no built-in extension. A fixture that recorded one
    // would hand the Go side an oracle for the defect.
    if (systemNames.length === 0) {
        throw new Error('pinned reported no system extensions, so the recorded list could not distinguish a working install from the defect');
    }
    // The interesting state is the fresh one: any local/global entry means
    // something was seeded after all.
    if (entries.length !== systemNames.length) {
        throw new Error(`pinned reported entries outside the system group on a fresh install: ${JSON.stringify(entries)}`);
    }
    // The system list must be exactly the pinned checkout's own directory
    // listing projected through the pinned filters; a mismatch means the probe
    // read some other tree than the one it is about to record digests from.
    const expectedNames = readdirSync(systemRoot)
        .filter(name => {
            try {
                return statSync(path.join(systemRoot, name)).isDirectory();
            } catch {
                return false;
            }
        })
        .filter(name => name !== 'third-party')
        .filter(name => existsSync(path.join(systemRoot, name, 'manifest.json')))
        .sort();
    if (JSON.stringify(systemNames) !== JSON.stringify(expectedNames)) {
        throw new Error(`pinned system list ${JSON.stringify(systemNames)} is not the checkout's filtered directory listing ${JSON.stringify(expectedNames)}`);
    }

    // ---- the files behind each name ---------------------------------------
    const systemExtensions = [];
    const staticFiles = [];
    for (const name of systemNames) {
        const root = path.join(systemRoot, name);
        if (!existsSync(path.join(root, 'manifest.json'))) {
            throw new Error(`pinned listed system extension ${name} but it has no manifest.json, so the recorded list does not follow the pinned filter`);
        }
        systemExtensions.push({ name, files: snapshotDigests(root) });
        for (const relative of STATIC_PROBE_FILES) {
            const requestPath = `/scripts/extensions/${name}/${relative}`;
            const result = await rawRequest(origin, { path: requestPath, headers: authed });
            if (result.status !== 200) {
                throw new Error(`${requestPath} answered ${result.status}; the frontend requests it for every listed system extension, so the fixture would record a broken install`);
            }
            staticFiles.push({
                path: requestPath,
                status: result.status,
                headers: stableHeaders(result.headers),
                bodySha256: sha256(result.body),
                bodyLength: result.body.length,
            });
        }
    }
    // The frontend static middleware is mounted before requireLoginMiddleware
    // (server-main.js:242 vs :248), so these files are reachable without a
    // session. One observation is enough to pin that, and it is the request a
    // browser makes before the login step in a multi-user install.
    const anonymous = await rawRequest(origin, { path: `/scripts/extensions/${systemNames[0]}/manifest.json` });
    extra.anonymousManifestStatus = anonymous.status;
    extra.systemCount = systemNames.length;
    extra.systemFileCount = systemExtensions.reduce((total, extension) => total + extension.files.length, 0);

    await stopServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned built-in extension discovery on a fresh install: the system list /api/extensions/discover reports with no seeded user or global extensions, the pinned checkout files behind every name, and the frontend static middleware\'s answer for each built-in extension\'s manifest.json and index.js',
        normalizations: [
            'No path, port or modification time is recorded: discovery returns names only, and the per-file observations record the request path, status, content type, content length and body digest.',
            'Pinned /discover returns fs.readdirSync order, which is a property of the host filesystem (ext4 hash order, NTFS name order). The fixture records the list sorted within the pinned group order (system, local, global) and the comparison is order-insensitive; src/endpoints/extensions.js:506-530 performs no sort.',
            'Every file list is sorted by relative path and records the SHA-256 of the bytes plus the path. Size and mtime are not recorded, because they are properties of the checkout extraction rather than of the file.',
            'ETag and Last-Modified are not recorded. send() derives both from stat().mtime, and a runtime that answers the same bytes from its embedded copy has no modification time to describe (static.go:46-52 and the Frontend static middleware row of docs/compat-matrix.md). Recording them would assert a value the embedded path cannot carry.',
            'Only headers that are properties of the route are recorded: Content-Type, Content-Length, Cache-Control, Accept-Ranges and Vary. Connection, Date, Keep-Alive, Transfer-Encoding, Set-Cookie and X-Response-Time belong to the connection, the clock or the session.',
            'Requests are sent with Accept-Encoding: identity and with keep-alive disabled, so the recorded framing is a property of the route rather than of the pinned compression middleware or a reused socket.',
            'The per-file digests are taken from the PINNED CHECKOUT\'s public/scripts/extensions tree, not from the reference implementation\'s embedded copy, so the comparison is anchored to upstream bytes.',
        ],
        gaps: [
            'A pinned checkout always ships its built-in extensions inside public/scripts/extensions, so pinned CANNOT be observed in the state a release-shaped reference install is in: a public/scripts/extensions directory that exists (startup creates it: src/users.js:113-118 creates every PUBLIC_DIRECTORIES entry recursively) and contains only the empty third-party container. The embedded-tree answer for that state is faithful because pinned\'s own users.js guarantees the built-ins are there, but it is not itself a pinned observation.',
            'Consequently a checkout whose built-in extensions were DELETED from public/scripts/extensions is byte-indistinguishable on disk from the release scaffold, and pinned would answer an empty system list there. That state is only reachable by mutating the pinned checkout\'s tracked files, and the reference implementation still serves those extensions\' files from its embedded copy, so listing them describes what the runtime can load. Recorded here rather than papered over.',
            'The per-file observations are made with a session cookie. The unauthenticated reachability of these files is pinned by one extra observation (extra.anonymousManifestStatus) rather than by repeating every file twice.',
            'This probe records manifests and index.js only. Other files a built-in extension loads (HTML templates, CSS, worker scripts) are listed in each entry\'s file digests but are not requested over HTTP by this probe.',
        ],
        inputs: {
            cookieSecret: COOKIE_SECRET,
            config: CONFIG,
            seededUsers: [
                { handle: 'default-user', name: 'Extensions Discovery Probe', created: 1700000000000, password: '', admin: true, enabled: true, salt: '' },
            ],
            sealedUserExtensionsDirectory: 'removed before the request, so the route\'s own recreation is observed',
            globalRootPlaceholder: GLOBAL_ROOT_PLACEHOLDER,
            staticProbeFiles: STATIC_PROBE_FILES,
        },
        discovery: {
            status: discoveryResponse.status,
            headers: stableHeaders(discoveryResponse.headers),
            entries,
        },
        systemExtensions,
        staticFiles,
        extra,
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-extensions-discovery.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned built-in extension discovery (${systemNames.length} system extensions, ${extra.systemFileCount} files)`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    await stopServer();
    safeCleanup();
}
