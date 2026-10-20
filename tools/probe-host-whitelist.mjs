#!/usr/bin/env node
// Capture host-validation-middleware@0.1.1 through pinned SillyTavern's server.

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// Pinned src/util.js:149 reports /version's gitRevision with
// `git rev-parse --short HEAD`, whose abbreviation length is derived from the
// checkout's object database (git's core.abbrev=auto): a full clone yields 9
// characters while CI's fetch-depth 1 checkout yields 7. That changes the
// recorded /version body, content-length and ETag per host. Forcing the length
// makes the pinned server report the same revision everywhere, so the
// observation is host independent without rewriting any recorded value.
const PINNED_GIT_ENVIRONMENT = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'core.abbrev',
    GIT_CONFIG_VALUE_0: '9',
};
const sourceRoot = path.resolve(process.argv[2] ?? '');
const outputRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-host-whitelist.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
if (sourceCommit !== PINNED_COMMIT) throw new Error(`upstream checkout is ${sourceCommit}; expected ${PINNED_COMMIT}`);

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-host-whitelist-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
let child;

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function stableHeaders(response) {
    return Object.fromEntries(Object.entries(response.headers)
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'x-response-time'].includes(name))
        .map(([name, value]) => [name, Array.isArray(value) ? value.join(', ') : value])
        .sort(([left], [right]) => left.localeCompare(right)));
}

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-host-whitelist-oracle-')) {
        throw new Error(`refusing to remove unexpected runtime path: ${resolved}`);
    }
    rmSync(resolved, { recursive: true, force: true });
}

async function choosePort() {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
    });
    const port = listener.address().port;
    await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
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

async function getResponse(origin, host) {
    const port = new URL(origin).port;
    const { response, body } = await new Promise((resolve, reject) => {
        const request = http.request({
            hostname: '127.0.0.1',
            port,
            path: '/version',
            method: 'GET',
            headers: { Host: host },
            timeout: 10000,
        }, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ response, body: Buffer.concat(chunks) }));
        });
        request.once('error', reject);
        request.once('timeout', () => request.destroy(new Error('host-whitelist request timed out')));
        request.end();
    });
    return {
        host: host.replace(new RegExp(`:${port}$`), ':<port>'),
        headers: stableHeaders(response),
        status: response.statusCode,
        contentType: response.headers['content-type'] ?? null,
        bytes: body.byteLength,
        sha256: sha256(body),
        body: body.toString('utf8'),
    };
}

function writeConfig(port, enabled, scan) {
    writeFileSync(configPath, [
        'listen: true',
        'listenAddress:',
        '  ipv4: 127.0.0.1',
        'protocol:',
        '  ipv4: true',
        '  ipv6: false',
        'port: ' + port,
        'whitelistMode: true',
        'whitelist:',
        '  - 127.0.0.1',
        'basicAuthMode: false',
        'enableUserAccounts: false',
        'hostWhitelist:',
        '  enabled: ' + enabled,
        '  scan: ' + scan,
        '  hosts:',
        '    - trusted.example.com',
        '    - .example.net',
        '',
    ].join('\n'));
}

async function startServer(port, enabled, scan) {
    logs.length = 0;
    writeConfig(port, enabled, scan);
    child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listen', 'true', '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test', ...PINNED_GIT_ENVIRONMENT }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));

    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before becoming ready:\n${logs.join('').slice(-12000)}`);
        try {
            const response = await getResponse(origin, `trusted.example.com:${port}`);
            if (response.status === 200 && response.contentType?.includes('application/json')) {
                const version = JSON.parse(response.body);
                if (version.pkgVersion !== PINNED_VERSION || !String(version.agent).startsWith(`SillyTavern:${PINNED_VERSION}:`)) {
                    throw new Error(`unexpected /version payload: ${JSON.stringify(version)}`);
                }
                return origin;
            }
        } catch (error) {
            if (error.message.startsWith('unexpected /version payload')) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`pinned server did not become ready within 180 seconds:\n${logs.join('').slice(-12000)}`);
}

try {
    mkdirSync(dataRoot, { recursive: true });
    const port = await choosePort();
    const origin = await startServer(port, true, true);

    const hosts = [
        ['exactAllowed', 'trusted.example.com'],
        ['exactAllowedWithPort', `trusted.example.com:${port}`],
        ['caseMismatch', 'TRUSTED.EXAMPLE.COM'],
        ['subdomainOfExactHost', 'api.trusted.example.com'],
        ['dotPatternApex', 'example.net'],
        ['dotPatternSubdomain', 'api.example.net'],
        ['dotPatternNestedSubdomain', 'a.b.example.net'],
        ['dotPatternNearSuffix', 'badexample.net'],
        ['hostSuffixAttack', 'example.net.evil.test'],
        ['localhost', 'localhost'],
        ['localhostSubdomain', 'api.localhost'],
        ['ipv4', '192.0.2.11'],
        ['ipv4WithPort', '192.0.2.12:8080'],
        ['ipv6Loopback', '[::1]'],
        ['ipv6GlobalWithPort', '[2001:db8::1]:443'],
        ['bracketedNonIPv6', '[not-an-ipv6-address]'],
        ['invalidIPv6Prefix', '[::zz]'],
        ['invalidHostWithColon', 'untrusted.example.org:1234'],
        ['allowedHostWithNonNumericPort', 'example.net:not-a-port'],
        ['fileProtocolHost', 'file:local-file'],
        ['browserExtensionProtocolHost', 'chrome-extension:extension-id'],
    ];
    const observations = {};
    const scanWarnings = {};
    for (const [name, host] of hosts) {
        const logOffset = logs.join('').length;
        observations[name] = await getResponse(origin, host);
        if (name === 'caseMismatch') {
            await new Promise(resolve => setTimeout(resolve, 50));
            scanWarnings.firstRequest = logs.join('').slice(logOffset).split(/\r?\n/).filter(Boolean);
            const repeatOffset = logs.join('').length;
            await getResponse(origin, host);
            await new Promise(resolve => setTimeout(resolve, 50));
            scanWarnings.repeatedRequest = logs.join('').slice(repeatOffset).split(/\r?\n/).filter(Boolean);
        }
    }

    const customErrorPageContent = '<!doctype html><p>host error page changed after startup</p>\n';
    writeFileSync(path.join(dataRoot, '_errors', 'host-not-allowed.html'), customErrorPageContent);
    observations.customErrorPageReadPerRequest = await getResponse(origin, 'dynamic-error.example.org');
    await stopServer();

    const scanDisabled = {};
    const disabledOrigin = await startServer(port, false, true);
    const disabledHost = 'first-scan-disabled.example.org';
    let logOffset = logs.join('').length;
    scanDisabled.firstResponse = await getResponse(disabledOrigin, disabledHost);
    await new Promise(resolve => setTimeout(resolve, 50));
    scanDisabled.firstWarnings = logs.join('').slice(logOffset).split(/\r?\n/).filter(Boolean);
    logOffset = logs.join('').length;
    scanDisabled.repeatedResponse = await getResponse(disabledOrigin, disabledHost);
    await new Promise(resolve => setTimeout(resolve, 50));
    scanDisabled.repeatedWarnings = logs.join('').slice(logOffset).split(/\r?\n/).filter(Boolean);
    logOffset = logs.join('').length;
    scanDisabled.differentHostResponse = await getResponse(disabledOrigin, 'second-scan-disabled.example.org');
    await new Promise(resolve => setTimeout(resolve, 50));
    scanDisabled.differentHostWarnings = logs.join('').slice(logOffset).split(/\r?\n/).filter(Boolean);
    await stopServer();

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned host-validation-middleware@0.1.1 behavior through enabled SillyTavern host whitelist middleware',
        source: 'src/middleware/hostWhitelist.js; host-validation-middleware 0.1.1 dist/index.js; src/server-main.js: host whitelist mount order',
        inputs: {
            hostWhitelistEnabled: true,
            hostWhitelistScan: true,
            hosts: ['trusted.example.com', '.example.net'],
            customErrorPageContent,
        },
        observations,
        scanWarnings,
        scanDisabled,
    };
    const fixturePath = path.join(outputRoot, 'tests', 'oracle', 'sillytavern-1.19.0-host-whitelist.json');
    mkdirSync(path.dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(outputRoot, fixturePath)} from the pinned Node server`);
} finally {
    await stopServer();
    safeCleanup();
}
