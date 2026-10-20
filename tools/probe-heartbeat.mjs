#!/usr/bin/env node
// Capture pinned server-main heartbeat creation, periodic updates, and shutdown behavior.

import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-heartbeat.json label="heartbeat"
const HEARTBEAT_INTERVAL_SECONDS = 0.05;
const sourceRoot = path.resolve(process.argv[2] ?? '');
const outputRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-heartbeat.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}

const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim();
if (sourceCommit !== PINNED_COMMIT) throw new Error(`upstream checkout is ${sourceCommit}; expected ${PINNED_COMMIT}`);

const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-heartbeat-oracle-'));
const dataRoot = path.join(runtimeRoot, 'data');
const configPath = path.join(runtimeRoot, 'config.yaml');
const logs = [];
let child;

function safeCleanup() {
    const resolved = path.resolve(runtimeRoot);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith('gotavern-heartbeat-oracle-')) {
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

async function requestVersion(origin) {
    return new Promise((resolve, reject) => {
        const request = http.get(`${origin}/version`, response => {
            const chunks = [];
            response.on('data', chunk => chunks.push(chunk));
            response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
        });
        request.setTimeout(5000, () => request.destroy(new Error('heartbeat probe request timed out')));
        request.once('error', reject);
    });
}

function readHeartbeat(heartbeatPath) {
    const raw = readFileSync(heartbeatPath, 'utf8');
    const value = JSON.parse(raw);
    return { raw, value };
}

async function waitFor(condition, timeoutMs, description) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            const result = condition();
            if (result) return result;
        } catch {
            // The heartbeat can be observed during the short truncate/write window.
        }
        await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error(`timed out waiting for ${description}:\n${logs.join('').slice(-12000)}`);
}

try {
    mkdirSync(dataRoot, { recursive: true });
    const port = await choosePort();
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
        'browserLaunch:',
        '  enabled: false',
        `heartbeatInterval: ${HEARTBEAT_INTERVAL_SECONDS}`,
        '',
    ].join('\n'));

    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listen', 'true', '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', String(HEARTBEAT_INTERVAL_SECONDS),
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));

    let ready = false;
    const readyDeadline = Date.now() + 180000;
    while (Date.now() < readyDeadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before becoming ready:\n${logs.join('').slice(-12000)}`);
        try {
            const response = await requestVersion(origin);
            if (response.status === 200) {
                const version = JSON.parse(response.body);
                if (version.pkgVersion !== PINNED_VERSION || !String(version.agent).startsWith(`SillyTavern:${PINNED_VERSION}:`)) {
                    throw new Error(`unexpected /version payload: ${JSON.stringify(version)}`);
                }
                ready = true;
                break;
            }
        } catch (error) {
            if (error.message.startsWith('unexpected /version payload')) throw error;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error(`pinned server did not become ready within 180 seconds:\n${logs.join('').slice(-12000)}`);

    const heartbeatPath = path.join(dataRoot, 'heartbeat.json');
    const firstHeartbeat = await waitFor(() => readHeartbeat(heartbeatPath), 5000, 'heartbeat.json');
    const timestampKeys = Object.keys(firstHeartbeat.value).sort();
    const initialTimestamp = firstHeartbeat.value.timestamp;
    if (timestampKeys.length !== 1 || timestampKeys[0] !== 'timestamp' || typeof initialTimestamp !== 'number') {
        throw new Error(`unexpected heartbeat data: ${firstHeartbeat.raw}`);
    }

    const periodicHeartbeat = await waitFor(() => {
        const current = readHeartbeat(heartbeatPath);
        return current.value.timestamp > initialTimestamp ? current : null;
    }, 5000, 'a periodic heartbeat timestamp update');
    await stopServer();
    const stoppedHeartbeat = readHeartbeat(heartbeatPath);
    await new Promise(resolve => setTimeout(resolve, 150));
    const afterExitHeartbeat = readHeartbeat(heartbeatPath);

    const fixture = {
        schemaVersion: 1,
        baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
        probe: 'pinned server-main post-setup heartbeat write and timer behavior',
        source: 'src/server-main.js: postSetupTasks heartbeatInterval branch, immediate write, and unref interval',
        inputs: { heartbeatIntervalSeconds: HEARTBEAT_INTERVAL_SECONDS },
        observations: {
            immediate: { filePresent: true, keys: timestampKeys, timestampType: typeof initialTimestamp },
            periodic: { timestampChanged: periodicHeartbeat.value.timestamp > initialTimestamp, keys: Object.keys(periodicHeartbeat.value).sort() },
            afterShutdown: { filePresent: true, timestampUnchangedAfterExit: stoppedHeartbeat.raw === afterExitHeartbeat.raw },
        },
    };
    const fixturePath = path.join(outputRoot, 'tests', 'oracle', 'sillytavern-1.19.0-heartbeat.json');
    mkdirSync(path.dirname(fixturePath), { recursive: true });
    writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);
    console.log(`Wrote ${path.relative(outputRoot, fixturePath)} from the pinned Node server`);
} finally {
    await stopServer();
    safeCleanup();
}
