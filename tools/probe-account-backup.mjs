#!/usr/bin/env node
// Capture pinned full-user ZIP backups, authorization, and secret filtering.

import { execFileSync, spawn } from 'node:child_process';
import { createHash, scryptSync } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-account-backup.json label="account-backup"
const COOKIE_SECRET = 'gotavern-pinned-account-backup-probe-secret';
const PASSWORD = 'account-backup-protected-password';
const SALT = Buffer.from('account-backup-salt').toString('base64');
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-account-backup.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

function seedUser(dataRoot, key, value) {
    writeFileSync(path.join(dataRoot, '_storage', sha256(key)), JSON.stringify({ key, value }));
}

function safeCleanup(runtimeRoot, prefix) {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith(prefix)) {
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

async function inspectZip(buffer, yauzl) {
    return new Promise((resolve, reject) => {
        yauzl.fromBuffer(buffer, { lazyEntries: true, decodeStrings: true }, (openError, archive) => {
            if (openError) return reject(openError);
            const directories = [];
            const files = [];
            archive.once('error', reject);
            archive.once('end', () => {
                directories.sort();
                files.sort((left, right) => left.path.localeCompare(right.path));
                resolve({ directories, files });
            });
            archive.on('entry', entry => {
                if (entry.fileName.endsWith('/')) {
                    directories.push(entry.fileName.slice(0, -1));
                    archive.readEntry();
                    return;
                }
                archive.openReadStream(entry, (streamError, stream) => {
                    if (streamError) return reject(streamError);
                    const chunks = [];
                    stream.on('data', chunk => chunks.push(chunk));
                    stream.once('error', reject);
                    stream.once('end', () => {
                        const bytes = Buffer.concat(chunks);
                        files.push({ path: entry.fileName, sha256: sha256(bytes), bytes: bytes.length });
                        archive.readEntry();
                    });
                });
            });
            archive.readEntry();
        });
    });
}

function stableHeaders(response) {
    const headers = Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'transfer-encoding', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
    if (headers['content-disposition']) {
        headers['content-disposition'] = headers['content-disposition'].replace(/\d{8}-\d{6}/g, '<timestamp>');
    }
    return headers;
}

function cookiesFrom(response) {
    if (typeof response.headers.getSetCookie !== 'function') throw new Error('Node fetch does not expose getSetCookie()');
    return response.headers.getSetCookie();
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

async function captureRequest(url, cookie, token, body, yauzl) {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Cookie: cookie,
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
        },
        body: JSON.stringify(body),
        redirect: 'manual',
        signal: AbortSignal.timeout(30000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    let parsedBody = bytes.toString('utf8');
    let archive;
    if (response.status === 200 && response.headers.get('content-type')?.includes('application/zip')) {
        archive = await inspectZip(bytes, yauzl);
        parsedBody = null;
    } else {
        try {
            parsedBody = parsedBody ? JSON.parse(parsedBody) : null;
        } catch {
            // Retain non-JSON error bodies.
        }
    }
    return {
        observation: { status: response.status, headers: stableHeaders(response), body: parsedBody },
        archive,
    };
}

function directorySnapshot(root) {
    const directories = [];
    const files = [];
    function visit(current, relative = '') {
        for (const name of readdirSync(current).sort()) {
            const absolute = path.join(current, name);
            const childRelative = relative ? `${relative}/${name}` : name;
            const info = statSync(absolute);
            if (info.isDirectory()) {
                directories.push(childRelative);
                visit(absolute, childRelative);
            } else if (info.isFile()) {
                const bytes = readFileSync(absolute);
                files.push({ path: childRelative, sha256: sha256(bytes), bytes: bytes.length });
            }
        }
    }
    visit(root);
    return { directories, files };
}

async function runScenario(name, config, runRequests) {
    const prefix = `gotavern-account-backup-${name}-oracle-`;
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
    const dataRoot = path.join(runtimeRoot, 'data');
    const configPath = path.join(runtimeRoot, 'config.yaml');
    const logs = [];
    let child;
    async function stopServer() {
        if (!child || child.exitCode !== null) return;
        child.kill('SIGINT');
        await Promise.race([
            new Promise(resolve => child.once('exit', resolve)),
            new Promise(resolve => setTimeout(resolve, 5000)),
        ]);
        if (child.exitCode === null) child.kill();
    }
    try {
        mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
        writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
        writeFileSync(configPath, `enableUserAccounts: true\nskipContentCheck: true\nbackups:\n  allowFullDataBackup: ${config.allowFullDataBackup}\nallowKeysExposure: ${config.allowKeysExposure}\n`);
        const passwordHash = scryptSync(PASSWORD.normalize('NFC'), SALT, 64).toString('base64');
        seedUser(dataRoot, 'user:default-user', {
            handle: 'default-user', name: 'Protected Admin', created: 1700000000000,
            password: passwordHash, admin: true, enabled: true, salt: SALT,
        });
        seedUser(dataRoot, 'user:guest-user', {
            handle: 'guest-user', name: 'Passwordless Guest', created: 1700000000001,
            password: '', admin: false, enabled: true, salt: '',
        });
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
                const response = await fetch(`${origin}/login?noauto=1`, { signal: AbortSignal.timeout(10000) });
                ready = response.status === 200 && response.headers.get('content-type')?.includes('text/html');
                if (!ready) lastError = new Error(`login returned ${response.status}`);
            } catch (error) {
                lastError = error;
            }
            if (!ready) await new Promise(resolve => setTimeout(resolve, 500));
        }
        if (!ready) throw new Error(`pinned server did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-10000)}`);

        // Normalize statistics so archive digests are repeatable.
        for (const handle of ['default-user', 'guest-user']) {
            writeFileSync(path.join(dataRoot, handle, 'stats.json'), '{"timestamp":1735689600000}');
        }
        const customRoot = path.join(dataRoot, 'default-user');
        mkdirSync(path.join(customRoot, 'backups'), { recursive: true });
        mkdirSync(path.join(customRoot, 'characters', 'nested'), { recursive: true });
        mkdirSync(path.join(customRoot, 'empty-folder'), { recursive: true });
        writeFileSync(path.join(customRoot, 'settings.json'), '{"owner":"default-user"}');
        writeFileSync(path.join(customRoot, 'secrets.json'), '{"private":"never expose by default"}');
        writeFileSync(path.join(customRoot, 'ordinary.txt'), 'visible root data');
        writeFileSync(path.join(customRoot, '.hidden-root'), 'hidden data');
        writeFileSync(path.join(customRoot, 'backups', 'secrets_migration_20250101.json'), '{"private":"migration secret"}');
        writeFileSync(path.join(customRoot, 'backups', 'secrets_migration_notes.txt'), 'not a secret JSON backup');
        writeFileSync(path.join(customRoot, 'backups', 'ordinary.json'), '{"backup":true}');
        writeFileSync(path.join(customRoot, 'characters', 'nested', 'character.json'), '{"name":"nested"}');
        const guestRoot = path.join(dataRoot, 'guest-user');
        mkdirSync(path.join(guestRoot, 'empty-folder'), { recursive: true });
        writeFileSync(path.join(guestRoot, 'guest.txt'), 'guest data');
        writeFileSync(path.join(guestRoot, 'secrets.json'), '{"private":"guest secret"}');

        const yauzl = createRequire(path.join(sourceRoot, 'package.json'))('yauzl');
        const csrf = await fetch(`${origin}/csrf-token`);
        const csrfBody = await csrf.json();
        const csrfCookie = cookieHeader(cookiesFrom(csrf));
        const login = async (handle, password) => {
            const response = await fetch(`${origin}/api/users/login`, {
                method: 'POST',
                headers: { Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': csrfBody.token },
                body: JSON.stringify({ handle, password }),
                redirect: 'manual',
                signal: AbortSignal.timeout(10000),
            });
            if (response.status !== 200) throw new Error(`could not login ${handle}: ${response.status} ${await response.text()}\n${logs.join('').slice(-10000)}`);
            return cookieHeader(cookiesFrom(response));
        };
        const adminCookie = await login('default-user', PASSWORD);
        const guestCookie = await login('guest-user', '');
        const url = `${origin}/api/users/backup`;
        const beforeDefault = directorySnapshot(customRoot);
        const beforeGuest = directorySnapshot(guestRoot);
        const adminRecordPath = path.join(dataRoot, '_storage', sha256('user:default-user'));
        const guestRecordPath = path.join(dataRoot, '_storage', sha256('user:guest-user'));
        const beforeAdminRecord = readFileSync(adminRecordPath);
        const beforeGuestRecord = readFileSync(guestRecordPath);
        const responses = {
            unauthorized: await captureRequest(url, csrfCookie, csrfBody.token, { handle: 'default-user' }, yauzl),
            missingHandle: await captureRequest(url, adminCookie, csrfBody.token, {}, yauzl),
            nonAdminOtherUser: await captureRequest(url, guestCookie, csrfBody.token, { handle: 'default-user' }, yauzl),
            adminOwn: await captureRequest(url, adminCookie, csrfBody.token, { handle: 'default-user' }, yauzl),
            adminOtherUser: await captureRequest(url, adminCookie, csrfBody.token, { handle: 'guest-user' }, yauzl),
            guestOwn: await captureRequest(url, guestCookie, csrfBody.token, { handle: 'guest-user' }, yauzl),
        };
        if (config.allowFullDataBackup) await runRequests({ responses, yauzl, url, adminCookie, guestCookie, csrfBody, csrfCookie });
        const afterDefault = directorySnapshot(customRoot);
        const afterGuest = directorySnapshot(guestRoot);
        return {
            responses: Object.fromEntries(Object.entries(responses).map(([key, value]) => [key, value.observation])),
            archives: Object.fromEntries(Object.entries(responses).filter(([, value]) => value.archive).map(([key, value]) => [key, value.archive])),
            filesystemUnchanged: JSON.stringify(beforeDefault) === JSON.stringify(afterDefault) && JSON.stringify(beforeGuest) === JSON.stringify(afterGuest),
            accountRecordsUnchanged: beforeAdminRecord.equals(readFileSync(adminRecordPath)) && beforeGuestRecord.equals(readFileSync(guestRecordPath)),
        };
    } finally {
        await stopServer();
        safeCleanup(runtimeRoot, prefix);
    }
}

try {
    const standard = await runScenario('standard', { allowFullDataBackup: true, allowKeysExposure: false }, async ({ responses }) => {
        // Keep one scenario focused on ordinary authorization and secret filtering.
        if (responses.adminOwn.observation.status !== 200) throw new Error('admin self-backup did not produce a ZIP archive');
    });
    const exposed = await runScenario('exposed', { allowFullDataBackup: true, allowKeysExposure: true }, async () => {});
    const disabled = await runScenario('disabled', { allowFullDataBackup: false, allowKeysExposure: false }, async ({ responses }) => {
        if (responses.adminOwn.observation.status !== 403) throw new Error('full-data backup config did not deny the route');
    });
    if (disabled.responses.adminOwn.status !== 403 || disabled.responses.missingHandle.status !== 403) {
        throw new Error('full-data backup config did not deny the route before body validation');
    }
    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned private full-user ZIP backup authorization, config gates, archive entries, and secrets filtering',
        inputs: { cookieSecret: COOKIE_SECRET, password: PASSWORD, salt: SALT },
        standard,
        exposed,
        disabled,
    };
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-account-backup.json');
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(repositoryRoot, outputFile)} from pinned account backup behavior`);
} catch (error) {
    console.error(error);
    process.exitCode = 1;
}
