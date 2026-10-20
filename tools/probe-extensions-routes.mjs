#!/usr/bin/env node
// Capture pinned frontend-extension management behavior: /discover, /version,
// /branches, /switch, /update, /install, /move and /delete, the feature-flag
// guard, filename sanitization, permission checks and the resulting extension
// trees.
//
// Every git observation is made against a repository the probe builds itself
// with fixed author/committer identities and dates, so the recorded commit
// hashes are a property of the fixture rather than of the recording host.
// Absolute runtime paths, the install checkout path and the loopback git
// server's port are the only normalized values; each one is listed in the
// fixture's normalizations array.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: fixture=sillytavern-1.19.0-extensions-routes.json label="frontend extension management routes"
const COOKIE_SECRET = 'gotavern-pinned-extensions-cookie-secret';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-extensions-routes.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-extensions-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const gitRoot = path.join(runtimeRoot, 'git');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
let child;
let gitServer;

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-extensions-oracle-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

// ---------------------------------------------------------------- git fixture

// An empty global/system git config makes the fixture independent of the
// recording machine's user config (autocrlf, gpgsign, init.defaultBranch,
// core.abbrev), which is what keeps commit hashes and branch labels identical
// on a Linux CI runner and on a Windows development machine.
const emptyGitConfig = path.join(runtimeRoot, 'empty-gitconfig');
const GIT_ENV = {
    ...process.env,
    GIT_CONFIG_GLOBAL: emptyGitConfig,
    GIT_CONFIG_SYSTEM: emptyGitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'GoTavern Probe',
    GIT_AUTHOR_EMAIL: 'probe@gotavern.invalid',
    GIT_COMMITTER_NAME: 'GoTavern Probe',
    GIT_COMMITTER_EMAIL: 'probe@gotavern.invalid',
};

function gitIn(directory, args, env = {}) {
    return execFileSync('git', ['-C', directory, ...args], {
        encoding: 'utf8',
        env: { ...GIT_ENV, ...env },
    }).trim();
}

function commitAll(directory, message, date) {
    gitIn(directory, ['add', '.']);
    gitIn(directory, ['commit', '-m', message], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
    return gitIn(directory, ['rev-parse', 'HEAD']);
}

function initRepo(directory) {
    mkdirSync(directory, { recursive: true });
    gitIn(directory, ['init']);
    // Explicit refs/heads/main so the branch name never depends on
    // init.defaultBranch.
    gitIn(directory, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
}

const DATE_ONE = '2020-01-01T00:00:00+00:00';
const DATE_TWO = '2020-01-02T00:00:00+00:00';
const DATE_THREE = '2020-01-03T00:00:00+00:00';

function makeBareRepo(name, { files, branch = null }) {
    const work = path.join(gitRoot, `work-${name}`);
    initRepo(work);
    for (const [relative, content] of Object.entries(files.main)) {
        const target = path.join(work, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
    }
    const mainCommit = commitAll(work, 'main commit', DATE_ONE);
    let branchCommit = null;
    if (branch) {
        gitIn(work, ['checkout', '-b', branch.name]);
        for (const [relative, content] of Object.entries(branch.files)) {
            const target = path.join(work, relative);
            mkdirSync(path.dirname(target), { recursive: true });
            writeFileSync(target, content);
        }
        branchCommit = commitAll(work, 'branch commit', DATE_TWO);
        gitIn(work, ['checkout', 'main']);
    }
    const bare = path.join(gitRoot, `${name}.git`);
    gitIn(gitRoot, ['clone', '--bare', work, bare]);
    gitIn(bare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    return { bare, mainCommit, branchCommit };
}

// ------------------------------------------------------------------ http git

// A minimal smart-HTTP git server. git http-backend is the same CGI program
// that any git host runs, so `git clone http://...` exercises the real smart
// protocol including the shallow (depth) capability the pinned /install uses.
function startGitHTTPServer(projectRoot, port) {
    const server = http.createServer((request, response) => {
        const separator = request.url.indexOf('?');
        const rawPath = separator === -1 ? request.url : request.url.slice(0, separator);
        const query = separator === -1 ? '' : request.url.slice(separator + 1);
        const env = {
            ...GIT_ENV,
            GIT_PROJECT_ROOT: projectRoot,
            GIT_HTTP_EXPORT_ALL: '1',
            GIT_HTTP_MAX_REQUEST_BUFFER: '100M',
            PATH_INFO: decodeURIComponent(rawPath),
            QUERY_STRING: query,
            REQUEST_METHOD: request.method,
            CONTENT_TYPE: request.headers['content-type'] ?? '',
            CONTENT_LENGTH: request.headers['content-length'] ?? '',
            REMOTE_ADDR: '127.0.0.1',
            SERVER_PROTOCOL: 'HTTP/1.1',
            SERVER_NAME: '127.0.0.1',
            SERVER_PORT: String(port),
            GATEWAY_INTERFACE: 'CGI/1.1',
        };
        const backend = spawn('git', ['http-backend'], { env });
        const chunks = [];
        backend.stdout.on('data', chunk => chunks.push(chunk));
        backend.stderr.on('data', chunk => logs.push(chunk.toString('utf8')));
        backend.on('error', () => {
            response.writeHead(500);
            response.end();
        });
        backend.on('close', () => {
            const buffer = Buffer.concat(chunks);
            let headerEnd = buffer.indexOf('\r\n\r\n');
            let offset = 4;
            if (headerEnd === -1) {
                headerEnd = buffer.indexOf('\n\n');
                offset = 2;
            }
            if (headerEnd === -1) {
                response.writeHead(500);
                response.end();
                return;
            }
            const headerLines = buffer.slice(0, headerEnd).toString('utf8').split(/\r?\n/);
            const headers = {};
            let status = 200;
            for (const line of headerLines) {
                if (!line) continue;
                const colon = line.indexOf(':');
                if (colon === -1) continue;
                const name = line.slice(0, colon).trim();
                const value = line.slice(colon + 1).trim();
                if (name.toLowerCase() === 'status') {
                    status = Number.parseInt(value, 10);
                    continue;
                }
                headers[name] = value;
            }
            response.writeHead(status, headers);
            response.end(buffer.slice(headerEnd + offset));
        });
        request.pipe(backend.stdin);
    });
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve(server));
    });
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

// ---------------------------------------------------------------- http client

async function request(url, method = 'GET', headers = {}, body) {
    const response = await fetch(url, {
        method,
        headers: { 'Accept-Encoding': 'identity', ...headers },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(120000),
    });
    let parsedBody = Buffer.from(await response.arrayBuffer()).toString('utf8');
    try {
        parsedBody = parsedBody ? JSON.parse(parsedBody) : null;
    } catch {
        // Preserve plain text and HTML response bodies.
    }
    return { response, body: parsedBody };
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

// ------------------------------------------------------------- normalization

const NORMALIZATIONS = [
    'Absolute runtime paths are recorded as <runtime> and the pinned checkout path as <install>, because both differ per recording host. The path suffixes after each placeholder are recorded unchanged.',
    'Recorded strings have their backslashes rewritten to forward slashes, because Node path.join on Windows and on POSIX differ only in the separator.',
    'The loopback git server port is recorded as <port>, because the probe binds an ephemeral port.',
    'Pinned /discover returns fs.readdirSync order, which is a property of the host filesystem (ext4 hash order, NTFS name order). The fixture sorts each pinned group (system, local, global) by name and the comparison is order-insensitive within a group; src/endpoints/extensions.js:506-530 performs no sort.',
    'A thrown route error answers with Express finalhandler\'s HTML page, whose <pre> block is the V8 stack with host-absolute source paths and pinned line numbers. Those responses are recorded in errorPages as a status only; GoTavern answers the same status with a plain-text body.',
    'git output is recorded as pinned Node returns it. The probe builds every repository with fixed identities, fixed author/committer dates and an empty git config, so commit hashes and branch labels are reproducible off the recording host; the probe fails rather than record a branch abbreviation other than the pinned seven characters.',
    'For a response body that carries a path or the loopback port, content-length and ETag are recorded as <path-body-length> and <path-body-etag>: Express derives both from the raw bytes, which embed this host\'s absolute paths and this host\'s path separators. The decision is made on the normalized body, so it does not itself depend on the recording host.',
];

function normalizeText(text) {
    let result = text;
    for (const [prefix, placeholder] of [[runtimeRoot, '<runtime>'], [sourceRoot, '<install>']]) {
        result = result.split(prefix).join(placeholder);
        result = result.split(prefix.split('\\').join('/')).join(placeholder);
    }
    result = result.replace(/http:\/\/127\.0\.0\.1:\d+/g, 'http://127.0.0.1:<port>');
    return result.split('\\').join('/');
}

function normalizeValue(value) {
    if (typeof value === 'string') return normalizeText(value);
    if (Array.isArray(value)) return value.map(normalizeValue);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, member] of Object.entries(value)) result[key] = normalizeValue(member);
        return result;
    }
    return value;
}

// src/endpoints/extensions.js:506-530 concatenates three readdirSync results
// without sorting; only the grouping is pinned, so the recorded order is
// normalized per group.
const DISCOVERY_GROUP_ORDER = ['system', 'local', 'global'];

function normalizeDiscovery(entries) {
    if (!Array.isArray(entries)) return entries;
    const result = [];
    for (const type of DISCOVERY_GROUP_ORDER) {
        const group = entries.filter(entry => entry.type === type).map(entry => ({ type: entry.type, name: entry.name }));
        group.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
        result.push(...group);
    }
    return result;
}

// A response body that carries a path (or the loopback port) also makes its
// content-length and Express ETag properties of the recording host, because
// Express derives both from the raw bytes: an absolute path has a different
// length per host and an OS-specific separator escapes differently in JSON.
// The decision is made on the *normalized* body, so it is the same on every
// host, and the two headers are recorded as markers rather than as this host's
// numbers.
function containsPathObservation(value) {
    if (typeof value === 'string') {
        return value.includes('/') || value.includes('<runtime>') || value.includes('<install>') || value.includes('<port>');
    }
    if (Array.isArray(value)) return value.some(containsPathObservation);
    if (value && typeof value === 'object') return Object.values(value).some(containsPathObservation);
    return false;
}

function capture(result, normalizeBody) {
    const rawBody = result.body;
    const body = normalizeValue(normalizeBody ? normalizeBody(rawBody) : rawBody);
    const headers = stableHeaders(result.response);
    if (containsPathObservation(body)) {
        if ('content-length' in headers) headers['content-length'] = '<path-body-length>';
        if ('etag' in headers) headers['etag'] = '<path-body-etag>';
    }
    return { status: result.response.status, headers, body };
}

function captureErrorPage(label, result) {
    const contentType = result.response.headers.get('content-type') ?? '';
    if (!contentType.startsWith('text/html')) {
        throw new Error(`${label}: expected the Express error page, got ${result.response.status} ${contentType}: ${String(result.body).slice(0, 300)}`);
    }
    return { status: result.response.status };
}

function cookiesFrom(response) {
    if (typeof response.headers.getSetCookie !== 'function') throw new Error('Node fetch does not expose getSetCookie()');
    return response.headers.getSetCookie();
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

// Sorted relative-path snapshot: kind and exact bytes, never sizes or mtimes, so
// no observation depends on the host filesystem. A .git directory is recorded
// as a single marker because its internals are a property of the git build.
function snapshotTree(root) {
    if (!existsSync(root)) return null;
    const entries = [];
    const walk = (directory, prefix) => {
        for (const name of readdirSync(directory).sort()) {
            const absolute = path.join(directory, name);
            const relative = prefix ? `${prefix}/${name}` : name;
            const info = statSync(absolute);
            // A .git directory holds build-specific internals, and a .git file
            // holds an absolute gitdir pointer; both are recorded as one marker.
            if (name === '.git') {
                entries.push({ path: relative, kind: 'git-directory' });
                continue;
            }
            if (info.isDirectory()) {
                entries.push({ path: relative, kind: 'directory' });
                walk(absolute, relative);
                continue;
            }
            if (info.isFile()) {
                entries.push({ path: relative, kind: 'file', content: readFileSync(absolute).toString('utf8') });
                continue;
            }
            entries.push({ path: relative, kind: 'other' });
        }
    };
    walk(root, '');
    entries.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    return entries;
}

function extensionDirectoryState(root, names) {
    const state = {};
    for (const name of names) {
        state[name] = snapshotTree(path.join(root, name));
    }
    return state;
}

// ------------------------------------------------------------------- startup

async function waitForServer(origin) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before readiness:\n${logs.join('').slice(-10000)}`);
        try {
            const result = await request(`${origin}/login?noauto=1`);
            if (result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html')) return;
            lastError = new Error(`login returned ${result.response.status}`);
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

async function startServer(origin, port, configBody) {
    writeFileSync(configPath, configBody);
    child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...GIT_ENV, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));
    await waitForServer(origin);
}

async function login(origin, handle) {
    const csrf = await request(`${origin}/csrf-token`);
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
    const result = await request(`${origin}/api/users/login`, 'POST', {
        Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify({ handle, password: '' }));
    if (result.response.status !== 200) {
        throw new Error(`could not login as ${handle}: ${result.response.status} ${JSON.stringify(result.body)}\n${logs.join('').slice(-10000)}`);
    }
    return { token, cookie: cookieHeader(cookiesFrom(result.response)) };
}

// -------------------------------------------------------------------- seeding

const GLOBAL_PREFIX = 'probe-';
const EXTENSION_MANIFEST = JSON.stringify({
    display_name: 'Probe Local One',
    version: '1.0.0',
    author: 'Probe',
    unknownManifestField: { keep: true },
}, null, 2);

// The pinned global extension directory belongs to the shared pinned checkout,
// so the probe removes only the entries it created and restores the original
// listing. That keeps two consecutive probe runs, and the double-run
// determinism check, identical.
let originalGlobalEntries = null;

function restoreGlobalExtensions(directory) {
    if (originalGlobalEntries === null) {
        rmSync(directory, { recursive: true, force: true });
        return;
    }
    if (!existsSync(directory)) {
        mkdirSync(directory, { recursive: true });
    }
    for (const name of readdirSync(directory)) {
        if (!originalGlobalEntries.includes(name)) {
            rmSync(path.join(directory, name), { recursive: true, force: true });
        }
    }
}

function seedExtension(directory, name, files) {
    const root = path.join(directory, name);
    mkdirSync(root, { recursive: true });
    for (const [relative, content] of Object.entries(files)) {
        const target = path.join(root, relative);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, content);
    }
}

const INSTALL_MANIFEST_MAIN = JSON.stringify({
    display_name: 'Manifest Extension',
    version: '1.2.3',
    author: 'Probe Author',
    unknownManifestField: { keep: 'main' },
});
const INSTALL_MANIFEST_ALT = JSON.stringify({
    display_name: 'Manifest Extension Alt',
    version: '9.9.9',
    author: 'Probe Author',
    unknownManifestField: { keep: 'alt' },
});

try {
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    mkdirSync(gitRoot, { recursive: true });
    writeFileSync(emptyGitConfig, '');
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
    seedUser('user:default-user', {
        handle: 'default-user', name: 'Extensions Probe', created: 1700000000000,
        password: '', admin: true, enabled: true, salt: '',
        probeUnknownField: { preserve: true },
    });
    seedUser('user:plainuser', {
        handle: 'plainuser', name: 'Plain User', created: 1700000000001,
        password: '', admin: false, enabled: true, salt: '',
    });

    // ---- git repositories -------------------------------------------------
    // origin.git is the remote of the working clone under the user's extensions
    // directory; the manifest repositories are served over smart HTTP for the
    // pinned install route, which rejects every non-http(s) URL.
    const originWork = path.join(gitRoot, 'work-origin');
    initRepo(originWork);
    writeFileSync(path.join(originWork, 'probe.txt'), 'one\n');
    const firstCommit = commitAll(originWork, 'first commit', DATE_ONE);
    writeFileSync(path.join(originWork, 'probe.txt'), 'two\n');
    const secondCommit = commitAll(originWork, 'second commit', DATE_TWO);
    gitIn(originWork, ['branch', 'feature-b', firstCommit]);
    const originBare = path.join(gitRoot, 'origin.git');
    gitIn(gitRoot, ['clone', '--bare', originWork, originBare]);
    gitIn(originBare, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

    const manifestRepo = makeBareRepo('manifest', {
        files: { main: { 'manifest.json': INSTALL_MANIFEST_MAIN, 'probe.txt': 'main\n' } },
        branch: { name: 'alt', files: { 'manifest.json': INSTALL_MANIFEST_ALT, 'probe.txt': 'alt\n' } },
    });
    const partialRepo = makeBareRepo('partial', { files: { main: { 'manifest.json': '{"display_name":"Partial Extension"}' } } });
    const noFieldsRepo = makeBareRepo('nofields', { files: { main: { 'manifest.json': '{}' } } });
    const noManifestRepo = makeBareRepo('nomanifest', { files: { main: { 'probe.txt': 'no manifest\n' } } });
    const badManifestRepo = makeBareRepo('badmanifest', { files: { main: { 'manifest.json': 'not json at all' } } });
    const arrayManifestRepo = makeBareRepo('arraymanifest', { files: { main: { 'manifest.json': '[1,2,3]' } } });
    const nullManifestRepo = makeBareRepo('nullmanifest', { files: { main: { 'manifest.json': 'null' } } });
    const globalRepo = makeBareRepo('global', {
        files: { main: { 'manifest.json': JSON.stringify({ display_name: 'Global Extension', version: '2.0.0', author: 'Global Author' }) } },
    });

    const gitServerPort = await choosePort();
    gitServer = await startGitHTTPServer(gitRoot, gitServerPort);
    const gitOriginBase = `http://127.0.0.1:${gitServerPort}`;

    const globalExtensionsRoot = path.join(sourceRoot, 'public', 'scripts', 'extensions', 'third-party');
    originalGlobalEntries = existsSync(globalExtensionsRoot) ? readdirSync(globalExtensionsRoot).sort() : null;
    restoreGlobalExtensions(globalExtensionsRoot);

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    await startServer(origin, port, 'enableUserAccounts: true\nskipContentCheck: true\nextensions:\n  enabled: true\n');

    const userRoot = path.join(dataRoot, 'default-user');
    const plainRoot = path.join(dataRoot, 'plainuser');
    const userExtensionsRoot = path.join(userRoot, 'extensions');
    const plainExtensionsRoot = path.join(plainRoot, 'extensions');

    // ---- seed the extension trees ----------------------------------------
    for (const root of [userExtensionsRoot, plainExtensionsRoot]) {
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true });
    }
    seedExtension(userExtensionsRoot, 'probe-local-one', { 'manifest.json': EXTENSION_MANIFEST, 'data.txt': 'local one\n' });
    seedExtension(userExtensionsRoot, 'probe-local-nomanifest', { 'data.txt': 'no manifest\n' });
    seedExtension(userExtensionsRoot, 'probe-global-conflict', { 'manifest.json': '{"display_name":"User Copy"}' });
    writeFileSync(path.join(userExtensionsRoot, 'probe-local-file.txt'), 'plain file\n');
    // The pinned route never decodes the URL pathname, so a directory whose name
    // literally contains %20 is the discriminator for that rule.
    mkdirSync(path.join(userExtensionsRoot, 'My%20Repo'), { recursive: true });
    writeFileSync(path.join(userExtensionsRoot, 'My%20Repo', 'placeholder.txt'), 'percent\n');
    seedExtension(plainExtensionsRoot, 'probe-other-one', { 'manifest.json': '{"display_name":"Plain One"}' });

    restoreGlobalExtensions(globalExtensionsRoot);
    seedExtension(globalExtensionsRoot, 'probe-global-one', { 'manifest.json': '{"display_name":"Global One"}' });
    seedExtension(globalExtensionsRoot, 'probe-global-conflict', { 'manifest.json': '{"display_name":"Global Copy"}' });
    seedExtension(globalExtensionsRoot, 'probe-global-nomanifest', { 'data.txt': 'no manifest\n' });
    writeFileSync(path.join(globalExtensionsRoot, 'probe-global-file.txt'), 'plain file\n');
    // extensions.js:509 excludes the third-party container by name *before* the
    // manifest filter, so a manifest inside it must still keep the folder out of
    // the system listing. Without this file the exclusion is unobservable,
    // because the container has no manifest of its own.
    writeFileSync(path.join(globalExtensionsRoot, 'manifest.json'), '{"display_name":"Third Party Container"}');

    // The working clone lives inside the user's extension directory, exactly
    // where an installed extension would be. --no-local is what makes git honour
    // --depth for a local source while still recording a plain-path origin; a
    // file:// origin would put the host's URL form into every remoteUrl, and the
    // shallow state is what the pinned /branches route unshallows.
    gitIn(gitRoot, ['clone', '--depth', '1', '--no-local', originBare, path.join(userExtensionsRoot, 'probe-git')]);
    const probeGitDirectory = path.join(userExtensionsRoot, 'probe-git');
    const cloneHead = gitIn(probeGitDirectory, ['rev-parse', 'HEAD']);
    if (cloneHead !== secondCommit) {
        throw new Error(`probe clone HEAD ${cloneHead} does not match the fixture commit ${secondCommit}`);
    }
    if (gitIn(probeGitDirectory, ['rev-parse', '--is-shallow-repository']) !== 'true') {
        throw new Error('probe clone is not shallow, so the pinned /branches unshallow path would not be exercised');
    }

    // A directory whose .git is a file pointing at another repository's gitdir is
    // a valid work tree but not a repository root: `git rev-parse --git-dir`
    // answers an absolute path, so the pinned checkIsRepoRoot is false while
    // `rev-parse HEAD` still succeeds. Without this entry the pinned
    // "not a git repository" early return cannot be told apart from a plain
    // failure of the later git commands.
    gitIn(originWork, ['remote', 'add', 'origin', originBare]);
    const nestedExtension = path.join(userExtensionsRoot, 'probe-nested');
    mkdirSync(nestedExtension, { recursive: true });
    writeFileSync(path.join(nestedExtension, '.git'), `gitdir: ${path.join(originWork, '.git')}\n`);

    // ---- built-in extension inventory ------------------------------------
    // Recorded so the Go test can rebuild the pinned checkout's system
    // extension listing instead of depending on its own install root.
    const builtInRoot = path.join(sourceRoot, 'public', 'scripts', 'extensions');
    const builtInExtensions = readdirSync(builtInRoot)
        .filter(name => {
            try {
                return statSync(path.join(builtInRoot, name)).isDirectory();
            } catch {
                return false;
            }
        })
        .map(name => ({ name, hasManifest: existsSync(path.join(builtInRoot, name, 'manifest.json')) }))
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    if (builtInExtensions.length === 0) {
        throw new Error('pinned checkout has no built-in extensions to record');
    }

    const admin = await login(origin, 'default-user');
    const plain = await login(origin, 'plainuser');
    const adminHeaders = { Cookie: admin.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': admin.token };
    const plainHeaders = { Cookie: plain.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': plain.token };

    const responses = {};
    const errorPages = {};
    const extra = {};
    const record = (label, result, normalizeBody) => { responses[label] = capture(result, normalizeBody); };
    const recordErrorPage = (label, result) => { errorPages[label] = captureErrorPage(label, result); };

    const post = (route, headers, body) => request(`${origin}/api/extensions/${route}`, 'POST', headers, body);
    const json = value => JSON.stringify(value);

    // ---- /discover --------------------------------------------------------
    record('discoverAdmin', await request(`${origin}/api/extensions/discover`, 'GET', { Cookie: admin.cookie }), normalizeDiscovery);
    record('discoverPlain', await request(`${origin}/api/extensions/discover`, 'GET', { Cookie: plain.cookie }), normalizeDiscovery);
    record('discoverWrongMethod', await post('discover', adminHeaders, json({})));
    rmSync(plainExtensionsRoot, { recursive: true, force: true });
    record('discoverRecreatesUserDirectory', await request(`${origin}/api/extensions/discover`, 'GET', { Cookie: plain.cookie }), normalizeDiscovery);
    extra.userExtensionsDirectoryRecreated = existsSync(plainExtensionsRoot) && statSync(plainExtensionsRoot).isDirectory();
    if (!extra.userExtensionsDirectoryRecreated) {
        throw new Error('/discover did not recreate the missing user extensions directory');
    }
    seedExtension(plainExtensionsRoot, 'probe-other-one', { 'manifest.json': '{"display_name":"Plain One"}' });

    // ---- /version ---------------------------------------------------------
    record('versionNonRepo', await post('version', adminHeaders, json({ extensionName: 'probe-local-one' })));
    record('versionGit', await post('version', adminHeaders, json({ extensionName: 'probe-git' })));
    record('versionMissing', await post('version', adminHeaders, json({ extensionName: 'probe-missing' })));
    record('versionSanitizesToEmpty', await post('version', adminHeaders, json({ extensionName: '..' })));
    record('versionNonString', await post('version', adminHeaders, json({ extensionName: 5 })));
    record('versionNoName', await post('version', adminHeaders, json({})));
    // extensions.js:387 has no global/admin guard, so a non-admin user reads a
    // global extension's version instead of being refused.
    record('versionGlobalNonAdmin', await post('version', plainHeaders, json({ extensionName: 'probe-global-one', global: true })));
    // probe-nested is a work tree whose .git is a file, so it is not a
    // repository root and the pinned route answers the empty projection. It is
    // read before the origin advances, so the pinned update path also stops at
    // the repository-root check instead of pulling.
    record('versionNestedRepo', await post('version', adminHeaders, json({ extensionName: 'probe-nested' })));
    record('updateNestedRepo', await post('update', adminHeaders, json({ extensionName: 'probe-nested' })));
    record('versionWrongMethod', await request(`${origin}/api/extensions/version`, 'GET', { Cookie: admin.cookie }));
    recordErrorPage('versionMalformedBody', await post('version', adminHeaders, '{'));

    // ---- /branches --------------------------------------------------------
    record('branchesGit', await post('branches', adminHeaders, json({ extensionName: 'probe-git' })));
    record('branchesNonGit', await post('branches', adminHeaders, json({ extensionName: 'probe-local-one' })));
    record('branchesMissing', await post('branches', adminHeaders, json({ extensionName: 'probe-missing' })));
    record('branchesNonString', await post('branches', adminHeaders, json({ extensionName: 5 })));
    record('branchesGlobalNonAdmin', await post('branches', plainHeaders, json({ extensionName: 'probe-global-one', global: true })));

    // ---- /switch ----------------------------------------------------------
    record('switchMissing', await post('switch', adminHeaders, json({ extensionName: 'probe-missing', branch: 'main' })));
    record('switchNoBranch', await post('switch', adminHeaders, json({ extensionName: 'probe-git' })));
    record('switchNonStringBranch', await post('switch', adminHeaders, json({ extensionName: 'probe-git', branch: 5 })));
    record('switchUnknownLocal', await post('switch', adminHeaders, json({ extensionName: 'probe-git', branch: 'nope' })));
    record('switchToRemoteBranch', await post('switch', adminHeaders, json({ extensionName: 'probe-git', branch: 'origin/feature-b' })));
    extra.switchToRemoteBranchFile = readFileSync(path.join(userExtensionsRoot, 'probe-git', 'probe.txt'), 'utf8');
    extra.switchToRemoteBranchBranch = gitIn(path.join(userExtensionsRoot, 'probe-git'), ['rev-parse', '--abbrev-ref', 'HEAD']);
    record('switchAlreadyCheckedOut', await post('switch', adminHeaders, json({ extensionName: 'probe-git', branch: 'feature-b' })));
    record('switchBackToMain', await post('switch', adminHeaders, json({ extensionName: 'probe-git', branch: 'main' })));
    extra.switchBackToMainFile = readFileSync(path.join(userExtensionsRoot, 'probe-git', 'probe.txt'), 'utf8');
    record('switchGlobalNonAdmin', await post('switch', plainHeaders, json({ extensionName: 'probe-global-one', branch: 'main', global: true })));

    // ---- /update ----------------------------------------------------------
    // A third commit on the origin makes the clone one commit behind, so the
    // update path actually pulls and its short hash is distinguishable from the
    // clone's.
    writeFileSync(path.join(originWork, 'probe.txt'), 'three\n');
    const thirdCommit = commitAll(originWork, 'third commit', DATE_THREE);
    gitIn(originWork, ['push', originBare, 'main']);
    if (gitIn(originBare, ['rev-parse', 'HEAD']) !== thirdCommit) {
        throw new Error('origin.git did not advance to the third commit');
    }
    record('updateGit', await post('update', adminHeaders, json({ extensionName: 'probe-git' })));
    extra.updatePulledCommit = gitIn(path.join(userExtensionsRoot, 'probe-git'), ['rev-parse', 'HEAD']);
    extra.updatePulledFile = readFileSync(path.join(userExtensionsRoot, 'probe-git', 'probe.txt'), 'utf8');
    record('updateAgain', await post('update', adminHeaders, json({ extensionName: 'probe-git' })));
    record('versionAfterUpdate', await post('version', adminHeaders, json({ extensionName: 'probe-git' })));
    record('updateNonGit', await post('update', adminHeaders, json({ extensionName: 'probe-local-one' })));
    record('updateMissing', await post('update', adminHeaders, json({ extensionName: 'probe-missing' })));
    record('updateNonString', await post('update', adminHeaders, json({ extensionName: 5 })));
    record('updateGlobalNonAdmin', await post('update', plainHeaders, json({ extensionName: 'probe-global-one', global: true })));

    // ---- /move ------------------------------------------------------------
    record('moveUserToGlobal', await post('move', adminHeaders, json({ extensionName: 'probe-local-one', source: 'user', destination: 'global' })));
    record('moveGlobalToUser', await post('move', adminHeaders, json({ extensionName: 'probe-global-one', source: 'global', destination: 'user' })));
    // Both raw values are 'global', so the paths are equal and the pinned
    // existsSync check answers before the same-source check. A wrong
    // implementation that reorders those two checks returns the other message.
    record('moveSameGlobalSource', await post('move', adminHeaders, json({ extensionName: 'probe-global-conflict', source: 'global', destination: 'global' })));
    record('moveSourceMissing', await post('move', adminHeaders, json({ extensionName: 'probe-missing', source: 'user', destination: 'global' })));
    record('moveDestinationExists', await post('move', adminHeaders, json({ extensionName: 'probe-global-conflict', source: 'user', destination: 'global' })));
    record('moveSourceIsFile', await post('move', adminHeaders, json({ extensionName: 'probe-local-file.txt', source: 'user', destination: 'global' })));
    record('moveMissingDestination', await post('move', adminHeaders, json({ extensionName: 'probe-global-conflict', source: 'user' })));
    record('moveNonString', await post('move', adminHeaders, json({ extensionName: 5, source: 'user', destination: 'global' })));
    record('moveSanitizesToEmpty', await post('move', adminHeaders, json({ extensionName: '..', source: 'user', destination: 'global' })));
    record('moveNonAdmin', await post('move', plainHeaders, json({ extensionName: 'probe-global-conflict', source: 'user', destination: 'global' })));
    record('moveGlobalSourceNonAdmin', await post('move', plainHeaders, json({ extensionName: 'probe-global-conflict', source: 'global', destination: 'user' })));
    record('moveWrongMethod', await request(`${origin}/api/extensions/move`, 'GET', { Cookie: admin.cookie }));
    const userAfterMove = snapshotTree(userExtensionsRoot);
    const globalAfterMove = snapshotTree(globalExtensionsRoot);

    // ---- /delete ----------------------------------------------------------
    record('deleteUserExtension', await post('delete', adminHeaders, json({ extensionName: 'probe-local-nomanifest' })));
    record('deleteGlobalExtension', await post('delete', adminHeaders, json({ extensionName: 'probe-local-one', global: true })));
    record('deleteMissing', await post('delete', adminHeaders, json({ extensionName: 'probe-missing' })));
    record('deleteNonString', await post('delete', adminHeaders, json({ extensionName: 5 })));
    record('deleteSanitizesToEmpty', await post('delete', adminHeaders, json({ extensionName: '..' })));
    record('deleteGlobalNonAdmin', await post('delete', plainHeaders, json({ extensionName: 'probe-global-conflict', global: true })));
    record('deleteWrongMethod', await request(`${origin}/api/extensions/delete`, 'GET', { Cookie: admin.cookie }));
    const userAfterDelete = snapshotTree(userExtensionsRoot);
    const globalAfterDelete = snapshotTree(globalExtensionsRoot);

    // ---- /install ---------------------------------------------------------
    record('installValid', await post('install', adminHeaders, json({ url: `${gitOriginBase}/manifest.git` })));
    const installedTree = snapshotTree(path.join(userExtensionsRoot, 'manifest'));
    record('installBranchGlobal', await post('install', adminHeaders, json({ url: `${gitOriginBase}/manifest.git`, branch: 'alt', global: true })));
    const installedGlobalTree = snapshotTree(path.join(globalExtensionsRoot, 'manifest'));
    record('installPartialManifest', await post('install', adminHeaders, json({ url: `${gitOriginBase}/partial.git` })));
    record('installNoFields', await post('install', adminHeaders, json({ url: `${gitOriginBase}/nofields.git` })));
    record('installExistingDirectory', await post('install', adminHeaders, json({ url: `${gitOriginBase}/manifest.git` })));
    record('installEncodedNameNotDecoded', await post('install', adminHeaders, json({ url: `${gitOriginBase}/My%20Repo.git` })));
    record('installSpaceNameEncoded', await post('install', adminHeaders, json({ url: `${gitOriginBase}/My Repo.git` })));
    record('installNoManifest', await post('install', adminHeaders, json({ url: `${gitOriginBase}/nomanifest.git` })));
    record('installBadManifest', await post('install', adminHeaders, json({ url: `${gitOriginBase}/badmanifest.git` })));
    record('installArrayManifest', await post('install', adminHeaders, json({ url: `${gitOriginBase}/arraymanifest.git` })));
    record('installNullManifest', await post('install', adminHeaders, json({ url: `${gitOriginBase}/nullmanifest.git` })));
    record('installCloneFailure', await post('install', adminHeaders, json({ url: `${gitOriginBase}/does-not-exist.git` })));
    record('installInvalidURL', await post('install', adminHeaders, json({ url: 'not a url' })));
    record('installRelativeURL', await post('install', adminHeaders, json({ url: '/foo.git' })));
    record('installFileProtocol', await post('install', adminHeaders, json({ url: 'file:///tmp/probe.git' })));
    record('installMailtoProtocol', await post('install', adminHeaders, json({ url: 'mailto:probe@gotavern.invalid' })));
    record('installMissingURL', await post('install', adminHeaders, json({})));
    record('installNonStringURL', await post('install', adminHeaders, json({ url: 5 })));
    record('installEmptyNameURL', await post('install', adminHeaders, json({ url: `${gitOriginBase}/` })));
    record('installDotGitURL', await post('install', adminHeaders, json({ url: `${gitOriginBase}/.git` })));
    record('installWrongMethod', await request(`${origin}/api/extensions/install`, 'GET', { Cookie: admin.cookie }));
    // extensions.js:96-99 checks the global permission before the URL, so an
    // invalid URL with global:true from a non-admin is a 403, not a 400.
    record('installGlobalNonAdminInvalidURL', await post('install', plainHeaders, json({ url: 'not a url', global: true })));
    record('installGlobalNonAdmin', await post('install', plainHeaders, json({ url: `${gitOriginBase}/global.git`, global: true })));
    record('installGlobalAdmin', await post('install', adminHeaders, json({ url: `${gitOriginBase}/global.git`, global: true })));
    const installedGlobalRepoTree = snapshotTree(path.join(globalExtensionsRoot, 'global'));
    const userAfterInstall = snapshotTree(userExtensionsRoot);
    const globalAfterInstall = snapshotTree(globalExtensionsRoot);

    await stopServer();

    // ---- extensions.enabled = false --------------------------------------
    const disabledResponses = {};
    const disabledPort = await choosePort();
    const disabledOrigin = `http://127.0.0.1:${disabledPort}`;
    await startServer(disabledOrigin, disabledPort, 'enableUserAccounts: true\nskipContentCheck: true\nextensions:\n  enabled: false\n');
    const disabledAdmin = await login(disabledOrigin, 'default-user');
    const disabledHeaders = { Cookie: disabledAdmin.cookie, 'Content-Type': 'application/json', 'X-CSRF-Token': disabledAdmin.token };
    const disabledPost = async (route, body) => request(`${disabledOrigin}/api/extensions/${route}`, 'POST', disabledHeaders, body);
    disabledResponses.install = capture(await disabledPost('install', json({ url: `${gitOriginBase}/manifest.git` })));
    disabledResponses.update = capture(await disabledPost('update', json({ extensionName: 'probe-git' })));
    disabledResponses.branches = capture(await disabledPost('branches', json({ extensionName: 'probe-git' })));
    disabledResponses.switch = capture(await disabledPost('switch', json({ extensionName: 'probe-git', branch: 'main' })));
    disabledResponses.move = capture(await disabledPost('move', json({ extensionName: 'probe-git', source: 'user', destination: 'global' })));
    disabledResponses.version = capture(await disabledPost('version', json({ extensionName: 'probe-git' })));
    disabledResponses.delete = capture(await disabledPost('delete', json({ extensionName: 'probe-git' })));
    disabledResponses.discover = capture(await request(`${disabledOrigin}/api/extensions/discover`, 'GET', { Cookie: disabledAdmin.cookie }));
    disabledResponses.unauthenticatedDiscover = capture(await request(`${disabledOrigin}/api/extensions/discover`, 'GET'));
    await stopServer();

    // The fixture must not carry a branch abbreviation that is longer than the
    // pinned seven characters, because that would silently depend on the
    // recording host's core.abbrev.
    for (const [label, response] of Object.entries(responses)) {
        const branches = Array.isArray(response.body) ? response.body : [];
        for (const branch of branches) {
            if (typeof branch.commit === 'string' && branch.commit.length !== 0 && branch.commit.length !== 7) {
                throw new Error(`${label}: recorded branch commit ${branch.commit} is not the pinned seven-character abbreviation`);
            }
        }
    }
    for (const [label, hash] of Object.entries({
        firstCommit, secondCommit, thirdCommit,
        cloneHead, manifestMain: manifestRepo.mainCommit, manifestAlt: manifestRepo.branchCommit,
    })) {
        if (typeof hash !== 'string' || !/^[0-9a-f]{40}$/.test(hash)) {
            throw new Error(`${label}: expected a full commit hash, got ${hash}`);
        }
    }
    const fullCommitHashes = {
        originFirst: firstCommit,
        originSecond: secondCommit,
        originThird: thirdCommit,
        manifestMain: manifestRepo.mainCommit,
        manifestAlt: manifestRepo.branchCommit,
    };
    for (const [label, response] of Object.entries(responses)) {
        for (const value of [response.body?.currentCommitHash, response.body?.shortCommitHash]) {
            if (typeof value !== 'string' || value === '') continue;
            const candidates = Object.values(fullCommitHashes);
            if (value.length === 7 && !candidates.some(candidate => candidate.startsWith(value))) {
                throw new Error(`${label}: commit ${value} is not a prefix of any fixture commit`);
            }
        }
    }

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned frontend-extension management routes: discover/version/branches/switch/update/install/move/delete, feature guard, sanitization, permission checks and the resulting extension trees',
        normalizations: NORMALIZATIONS,
        inputs: {
            cookieSecret: COOKIE_SECRET,
            seededUsers: [
                { handle: 'default-user', name: 'Extensions Probe', created: 1700000000000, password: '', admin: true, enabled: true, salt: '', probeUnknownField: { preserve: true } },
                { handle: 'plainuser', name: 'Plain User', created: 1700000000001, password: '', admin: false, enabled: true, salt: '' },
            ],
            builtInExtensions,
            localExtensions: {
                'probe-local-one': { 'manifest.json': EXTENSION_MANIFEST, 'data.txt': 'local one\n' },
                'probe-local-nomanifest': { 'data.txt': 'no manifest\n' },
                'probe-global-conflict': { 'manifest.json': '{"display_name":"User Copy"}' },
                'probe-local-file.txt': 'plain file\n',
                'My%20Repo': { 'placeholder.txt': 'percent\n' },
            },
            globalExtensions: {
                'probe-global-one': { 'manifest.json': '{"display_name":"Global One"}' },
                'probe-global-conflict': { 'manifest.json': '{"display_name":"Global Copy"}' },
                'probe-global-nomanifest': { 'data.txt': 'no manifest\n' },
                'probe-global-file.txt': 'plain file\n',
                'manifest.json': '{"display_name":"Third Party Container"}',
            },
            plainUserExtensions: {
                'probe-other-one': { 'manifest.json': '{"display_name":"Plain One"}' },
            },
            git: {
                fullCommitHashes,
                originBranch: 'main',
                originBranchTip: firstCommit,
                featureBranch: 'feature-b',
                altBranch: 'alt',
                commitMessages: { first: 'first commit', second: 'second commit', third: 'third commit' },
                originRemoteSuffix: 'git/origin.git',
                installRepos: {
                    manifest: 'manifest.git',
                    partial: 'partial.git',
                    nofields: 'nofields.git',
                    nomanifest: 'nomanifest.git',
                    badmanifest: 'badmanifest.git',
                    arraymanifest: 'arraymanifest.git',
                    nullmanifest: 'nullmanifest.git',
                    global: 'global.git',
                },
                installManifests: { main: INSTALL_MANIFEST_MAIN, alt: INSTALL_MANIFEST_ALT },
            },
        },
        responses,
        errorPages,
        extra,
        state: {
            userAfterMove,
            globalAfterMove,
            userAfterDelete,
            globalAfterDelete,
            userAfterInstall,
            globalAfterInstall,
            installedTree,
            installedGlobalTree,
            installedGlobalRepoTree,
        },
        disabled: disabledResponses,
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-extensions-routes.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned extension-route behavior`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
} finally {
    if (gitServer) gitServer.close();
    await stopServer();
    if (originalGlobalEntries !== null || existsSync(path.join(sourceRoot, 'public', 'scripts', 'extensions', 'third-party'))) {
        try {
            restoreGlobalExtensions(path.join(sourceRoot, 'public', 'scripts', 'extensions', 'third-party'));
        } catch {
            // The temporary checkout is discarded by the harness anyway.
        }
    }
    safeCleanup();
}
