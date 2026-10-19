#!/usr/bin/env node
// Probe a fresh pinned SillyTavern runtime without writing to its source checkout.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const outputRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-node-reference.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
if (sourceCommit !== PINNED_COMMIT) throw new Error(`upstream checkout is ${sourceCommit}; expected ${PINNED_COMMIT}`);

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-node-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const expectedLibPath = path.join(outputRoot, 'upstream', 'generated', 'lib.js');
const expectedLibHash = createHash('sha256').update(readFileSync(expectedLibPath)).digest('hex');
const logs = [];
let child;

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-node-oracle-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
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

function snapshotTree(root, relativeRoot = '') {
    const result = [];
    const absolute = path.join(root, relativeRoot);
    for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = path.posix.join(relativeRoot.replaceAll(path.sep, '/'), entry.name);
        const normalizedRelative = relative.replace(/(settings_[^/]+_)\d{8}-\d{6}(?=\.json$)/, '$1<timestamp>');
        const full = path.join(root, relative);
        if (entry.isDirectory()) {
            result.push({ path: normalizedRelative, type: 'directory' });
            result.push(...snapshotTree(root, relative));
            continue;
        }
        if (!entry.isFile()) {
            result.push({ path: normalizedRelative, type: 'special' });
            continue;
        }
        const bytes = statSync(full).size;
        if (relative === 'cookie-secret.txt') {
            result.push({ path: normalizedRelative, type: 'file', bytes, normalized: 'generated secret value omitted' });
        } else if (relative.startsWith('_storage/')) {
            result.push({ path: normalizedRelative, type: 'file', bytes, normalized: 'account-store bytes can contain generated timestamps' });
        } else if (relative.startsWith('_webpack/') && !relative.endsWith('/output/lib.js')) {
            result.push({ path: normalizedRelative, type: 'file', normalized: 'Webpack cache is runtime-generated; size and contents vary between starts' });
        } else if (relative === 'stats.json' || relative.endsWith('/stats.json')) {
            result.push({ path: normalizedRelative, type: 'file', bytes, normalized: 'startup statistics are time-dependent' });
        } else {
            result.push({ path: normalizedRelative, type: 'file', bytes, sha256: sha256(readFileSync(full)) });
        }
    }
    return result;
}

function persistedUserRecords() {
    const directory = path.join(dataRoot, '_storage');
    return readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isFile() && !entry.name.startsWith('.'))
        .sort((left, right) => left.name.localeCompare(right.name))
        .map(entry => ({
            path: `_storage/${entry.name}`,
            record: JSON.parse(readFileSync(path.join(directory, entry.name), 'utf8')),
        }))
        .filter(item => typeof item.record.key === 'string' && item.record.key.startsWith('user:'))
        .map(item => {
            if (item.record.value && Number.isFinite(item.record.value.created)) {
                item.record.value.created = '<timestamp>';
            }
            return item;
        });
}

function startupDirectories(userDirectoryTemplate, publicDirectories) {
    const user = Object.entries(userDirectoryTemplate).map(([key, relative]) => {
        const absolute = path.join(dataRoot, 'default-user', relative);
        if (!statSync(absolute).isDirectory()) throw new Error(`missing pinned user directory ${absolute}`);
        return { key, path: path.relative(dataRoot, absolute).replaceAll(path.sep, '/') };
    });
    const publicPaths = Object.entries(publicDirectories).map(([key, relative]) => {
        const absolute = path.join(sourceRoot, relative);
        if (!statSync(absolute).isDirectory()) throw new Error(`missing pinned public directory ${absolute}`);
        return { key, path: path.relative(sourceRoot, absolute).replaceAll(path.sep, '/') };
    });
    return { user, public: publicPaths };
}

function seededContentEntries(entries) {
    return entries.filter(entry => {
        const relative = entry.path;
        if (relative === 'content.log' || relative === 'default-user/content.log') return true;
        if (relative === '_css' || relative.startsWith('_css/') || relative === '_errors' || relative.startsWith('_errors/')) return true;
        if (!relative.startsWith('default-user/')) return false;
        return relative !== 'default-user/stats.json'
            && relative !== 'default-user/backups'
            && !relative.startsWith('default-user/backups/')
            && !relative.endsWith('/.migrated');
    }).sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
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

async function getResponse(url, method = 'GET') {
    const response = await fetch(url, { method, redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const body = new Uint8Array(await response.arrayBuffer());
    return { response, body };
}

try {
    mkdirSync(dataRoot, { recursive: true });
    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [
        'server.js',
        '--configPath', configPath,
        '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1',
        '--enableIPv4', 'true',
        '--enableIPv6', 'false',
        '--listen', 'false',
        '--port', String(port),
        '--browserLaunchEnabled', 'false',
        '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));

    let versionObservation;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before becoming ready:\n${logs.join('').slice(-12000)}`);
        try {
            const { response, body } = await getResponse(`${origin}/version`);
            if (response.status === 200 && response.headers.get('content-type')?.includes('application/json')) {
                const version = JSON.parse(Buffer.from(body).toString('utf8'));
                if (version.pkgVersion !== PINNED_VERSION || !String(version.agent).startsWith(`SillyTavern:${PINNED_VERSION}:`)) {
                    throw new Error(`unexpected /version payload: ${JSON.stringify(version)}`);
                }
                versionObservation = {
                    status: response.status,
                    contentType: response.headers.get('content-type'),
                    body: version,
                };
                break;
            }
        } catch (error) {
            if (error.message.startsWith('unexpected /version payload')) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    if (!versionObservation) throw new Error(`pinned server did not become ready within 180 seconds:\n${logs.join('').slice(-12000)}`);

    const rootResult = await getResponse(`${origin}/`);
    if (rootResult.response.status !== 200 || !rootResult.response.headers.get('content-type')?.includes('text/html')) {
        throw new Error(`unexpected root response: ${rootResult.response.status} ${rootResult.response.headers.get('content-type')}`);
    }
    const libraryResult = await getResponse(`${origin}/lib.js`);
    if (libraryResult.response.status !== 200) throw new Error(`unexpected /lib.js status: ${libraryResult.response.status}`);
    const libraryHash = sha256(libraryResult.body);
    if (libraryHash !== expectedLibHash) throw new Error(`/lib.js digest ${libraryHash} differs from the vendored generated library ${expectedLibHash}`);
    const notFoundURL = `${origin}/__gotavern_missing_route__`;
    const notFoundResult = await getResponse(notFoundURL);
    const notFoundHeadResult = await getResponse(notFoundURL, 'HEAD');

    await stopServer();
    const { USER_DIRECTORY_TEMPLATE, PUBLIC_DIRECTORIES } = await import(pathToFileURL(path.join(sourceRoot, 'src', 'constants.js')).href);
    const dataRootTree = snapshotTree(dataRoot);
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'empty runtime HTTP and startup-tree smoke observation',
        normalization: {
            'data/cookie-secret.txt': 'generated secret value is omitted; path and size are retained',
            'data/_storage/**': 'account store paths and sizes are retained; user record values are recorded with only generated created timestamps normalized',
            'data/_webpack/** except output/lib.js': 'Webpack cache artifacts are runtime-generated; paths are retained while size and contents are omitted',
            'data/<handle>/stats.json': 'startup statistics are time-dependent; path and size are retained',
            'data/<handle>/backups/settings_<handle>_<timestamp>.json': 'the upstream startup backup name contains a local timestamp; path is normalized and content hash is retained',
        },
        http: {
            observed: true,
            requests: [
                { method: 'GET', path: '/version' },
                { method: 'GET', path: '/' },
                { method: 'GET', path: '/lib.js' },
                { method: 'GET', path: '/__gotavern_missing_route__' },
                { method: 'HEAD', path: '/__gotavern_missing_route__' },
            ],
            responses: {
                '/version': versionObservation,
                '/': {
                    status: rootResult.response.status,
                    contentType: rootResult.response.headers.get('content-type'),
                    bytes: rootResult.body.byteLength,
                    sha256: sha256(rootResult.body),
                },
                '/lib.js': {
                    status: libraryResult.response.status,
                    contentType: libraryResult.response.headers.get('content-type'),
                    bytes: libraryResult.body.byteLength,
                    sha256: libraryHash,
                },
                '/__gotavern_missing_route__': {
                    status: notFoundResult.response.status,
                    contentType: notFoundResult.response.headers.get('content-type'),
                    bytes: notFoundResult.body.byteLength,
                    sha256: sha256(notFoundResult.body),
                },
                'HEAD /__gotavern_missing_route__': {
                    status: notFoundHeadResult.response.status,
                    contentType: notFoundHeadResult.response.headers.get('content-type'),
                    contentLength: notFoundHeadResult.response.headers.get('content-length'),
                    bytes: notFoundHeadResult.body.byteLength,
                    sha256: sha256(notFoundHeadResult.body),
                },
            },
        },
        provider: { observed: false, reason: 'this smoke scenario sends no generation request' },
        providerResponse: { observed: false, reason: 'this smoke scenario sends no generation request' },
        browserEvents: { observed: false, reason: 'this smoke scenario does not run a browser' },
        filesystem: {
            observed: true,
            config: {
                bytes: statSync(configPath).size,
                sha256: sha256(readFileSync(configPath)),
            },
            dataRoot: dataRootTree,
            seededContent: seededContentEntries(dataRootTree),
            userStore: {
                observed: true,
                implementation: 'node-persist@4.0.4; SHA-256 key filenames; ttl disabled',
                userRecords: persistedUserRecords(),
            },
            startupDirectories: startupDirectories(USER_DIRECTORY_TEMPLATE, PUBLIC_DIRECTORIES),
        },
    };
    const outputDirectory = path.join(outputRoot, 'tests', 'oracle');
    mkdirSync(outputDirectory, { recursive: true });
    const outputFile = path.join(outputDirectory, 'sillytavern-1.19.0-fresh-start.json');
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(outputRoot, outputFile)} from the pinned Node server`);
} finally {
    await stopServer();
    safeCleanup();
}
