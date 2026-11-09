#!/usr/bin/env node

// a19-pinned-config-refresh: does pinned SillyTavern re-read config.yaml at REQUEST time?
//
// WHY THIS EXISTS (and why it is not a perf guess). The alpha.19 profile attributed 67% of the chat-completion
// handler's CPU to `pinnedChatConfigSource` re-reading and YAML-parsing config.yaml per request, and the Go port's
// own comment claims pinned "parses config.yaml once at startup and never re-reads it". A perf cache that changes
// WHEN a config value is observed is a parity decision, not an optimization: pinned's source shows getConfig()
// caching the parsed document (src/util.js:61-63 `if (CACHED_CONFIG) return CACHED_CONFIG`), but a source reading
// is not an observation. This script OBSERVES it:
//
//   leg 1  boot pinned with a config whose requestOverrides set the header `x-a19-probe: baseline`; send one
//          text-completion generation at a recording mock provider and capture the provider request header;
//   leg 2  MUTATE config.yaml (x-a19-probe: mutated) while the same pinned process keeps running; send the same
//          generation again and capture the header;
//   leg 3  CONTROL: restart pinned with the mutated config, send again. `mutated` here proves the key is actually
//          observed through this route (otherwise ""old value"" in leg 2 would prove nothing).
//
// The key used is `requestOverrides`, which pinned reads through `getConfigValue` at REQUEST time
// (src/additional-headers.js:203 getOverrideHeaders -> :254, called while building the text-completion request),
// so a stale value in leg 2 is the strongest form of the answer: the FILE is cached process-wide, not just
// module-load constants.
//
// USAGE
//   node tools/perf/a19-pinned-config-refresh.mjs --pinned ..\SillyTavern --out <artifact>.json [--scratch <dir>]
//
// HONEST LIMITS: pinned is booted from its own checkout as-is (never modified); the scratch data root and config
// live outside it. The observed value is a provider request HEADER at the mock peer, not a browser observation.
// A run that cannot reach the generate route (auth/CSRF/config) fails loudly with the HTTP status and body instead
// of reporting ""old value"" from silence.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function usage(message) {
    if (message) console.error(`a19-pinned-config-refresh: ${message}\n`);
    console.error(`Usage: node tools/perf/a19-pinned-config-refresh.mjs --pinned <checkout> --out <artifact.json> [--scratch <dir>] [--timeout-seconds 180]`);
    process.exit(2);
}

function parseArguments(argv) {
    const options = {
        pinned: path.resolve(repoRoot, '..', 'SillyTavern'),
        scratch: path.join(repoRoot, '..', 'a19-perf', 'pinned-config-refresh'),
        out: null,
        timeoutSeconds: 180,
        mode: 'pinned',
        gotavern: null,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        const value = () => {
            const next = argv[index + 1];
            if (next === undefined || next.startsWith('--')) usage(`${flag} needs a value`);
            index += 1;
            return next;
        };
        switch (flag) {
            case '--pinned': options.pinned = path.resolve(value()); break;
            case '--scratch': options.scratch = path.resolve(value()); break;
            case '--out': options.out = path.resolve(value()); break;
            case '--timeout-seconds': options.timeoutSeconds = Number(value()); break;
            case '--mode': options.mode = value(); break;
            case '--gotavern': options.gotavern = path.resolve(value()); break;
            case '--help': usage(); break;
            default: usage(`unknown flag ${flag}`);
        }
    }
    if (!options.out) usage('--out is required');
    if (options.mode !== 'pinned' && options.mode !== 'gotavern') usage(`--mode must be pinned or gotavern, got ${options.mode}`);
    if (options.mode === 'pinned') {
        if (!fs.existsSync(path.join(options.pinned, 'server.js'))) usage(`${options.pinned} has no server.js`);
        if (!fs.existsSync(path.join(options.pinned, 'node_modules'))) usage(`${options.pinned} has no node_modules (pinned cannot boot)`);
    } else {
        if (!options.gotavern) usage('--mode gotavern needs --gotavern <binary>');
        if (!fs.existsSync(options.gotavern)) usage(`${options.gotavern} does not exist`);
    }
    return options;
}

const options = parseArguments(process.argv.slice(2));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function choosePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function killTree(child) {
    if (!child || child.exitCode !== null || !child.pid) return;
    spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8' });
}

function writeConfig(configPath, probeValue, mockAuthority) {
    const config = [
        'listen: false',
        'browserLaunch:',
        '  enabled: false',
        'enableUserAccounts: false',
        'requestOverrides:',
        '  - hosts:',
        `      - ${JSON.stringify(mockAuthority)}`,
        '    headers:',
        `      x-a19-probe: ${JSON.stringify(probeValue)}`,
        '',
    ].join('\n');
    fs.writeFileSync(configPath, config, 'utf8');
}

async function waitForPinnedReady(origin, ceilingMs) {
    const deadline = Date.now() + ceilingMs;
    let last = 'no attempt';
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${origin}/version`, { signal: AbortSignal.timeout(1000) });
            if (response.status === 200) return;
            last = `status ${response.status}`;
        } catch (error) {
            last = error.message;
        }
        await sleep(100);
    }
    throw new Error(`pinned did not answer GET /version within ${ceilingMs} ms (last: ${last})`);
}

class Session {
    constructor(origin) {
        this.origin = origin;
        this.cookies = new Map();
        this.csrf = null;
    }

    absorb(response) {
        for (const raw of response.headers.getSetCookie?.() ?? []) {
            const pair = raw.split(';')[0];
            const index = pair.indexOf('=');
            if (index > 0) this.cookies.set(pair.slice(0, index).trim(), pair.slice(index + 1).trim());
        }
    }

    headers(extra = {}) {
        const headers = { ...extra };
        if (this.cookies.size) headers.cookie = [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
        if (this.csrf) headers['x-csrf-token'] = this.csrf;
        return headers;
    }

    async handshake() {
        const response = await fetch(`${this.origin}/csrf-token`, { signal: AbortSignal.timeout(10000) });
        this.absorb(response);
        const body = await response.text();
        try { this.csrf = JSON.parse(body).token ?? null; } catch { this.csrf = null; }
        if (!this.csrf) throw new Error(`GET /csrf-token gave no token: ${body.slice(0, 200)}`);
    }

    async post(route, body) {
        const response = await fetch(`${this.origin}${route}`, {
            method: 'POST',
            headers: this.headers({ 'content-type': 'application/json' }),
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(120000),
        });
        return { status: response.status, text: await response.text() };
    }
}

async function readRecording(mockOrigin) {
    const response = await fetch(`${mockOrigin}/__mock/recording`, { signal: AbortSignal.timeout(10000) });
    return response.json();
}

function probeHeader(recorded) {
    const headers = recorded?.Headers ?? recorded?.headers ?? [];
    for (const header of headers) {
        if (String(header.name ?? header.Name).toLowerCase() === 'x-a19-probe') return header.value ?? header.Value;
    }
    return null;
}

async function runLeg({ session, mockOrigin, pinnedVersion }) {
    const before = (await readRecording(mockOrigin)).requests?.length ?? 0;
    const result = await session.post('/api/backends/text-completions/generate', {
        api_type: 'generic',
        api_server: mockOrigin,
        model: 'a19-probe-model',
        prompt: 'a19 config refresh probe',
        max_tokens: 8,
        stream: false,
    });
    const deadline = Date.now() + 15000;
    let recording = null;
    while (Date.now() < deadline) {
        recording = await readRecording(mockOrigin);
        if ((recording.requests?.length ?? 0) > before) break;
        await sleep(50);
    }
    const requests = recording?.requests ?? [];
    const recorded = requests.length > before ? requests[requests.length - 1] : null;
    return {
        pinnedVersion,
        httpStatus: result.status,
        httpBodyHead: (result.text ?? '').slice(0, 300),
        providerRequestSeen: Boolean(recorded),
        providerRequestTarget: recorded?.rawTarget ?? null,
        probeHeader: probeHeader(recorded),
        recordedRequestCount: requests.length,
    };
}

async function startPinned(configPath, dataRoot) {
    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    const logs = [];
    const child = spawn(process.execPath, [
        'server.js',
        '--configPath', configPath,
        '--dataRoot', dataRoot,
        '--port', String(port),
        '--listen', 'false',
        '--browserLaunchEnabled', 'false',
    ], {
        cwd: options.pinned,
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    child.stdout.on('data', chunk => logs.push(chunk.toString('utf8')));
    child.stderr.on('data', chunk => logs.push(chunk.toString('utf8')));
    try {
        await waitForPinnedReady(origin, options.timeoutSeconds * 1000);
    } catch (error) {
        // Pinned compiles the frontend (webpack, pruneCache) on every boot; under co-tenant load that can take
        // minutes. The tail of its output is part of the error, so a boot problem is not mistaken for a probe
        // result (a "no header" from a server that never booted would read as evidence if it were silent).
        throw new Error(`${error.message}\npinned output tail:\n${logs.join('').slice(-3000)}`);
    }
    const vite = await fetch(`${origin}/version`, { signal: AbortSignal.timeout(5000) });
    return { child, origin, logs, version: (await vite.text()).slice(0, 120) };
}

async function startGotavern(configPath, dataRoot) {
    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    const logs = [];
    const child = spawn(options.gotavern, [
        'start',
        '--configPath', configPath,
        '--dataRoot', dataRoot,
        '--port', String(port),
        '--listen', 'false',
        '--browserLaunchEnabled', 'false',
    ], {
        cwd: path.dirname(options.gotavern),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
    });
    child.stdout.on('data', chunk => logs.push(chunk.toString('utf8')));
    child.stderr.on('data', chunk => logs.push(chunk.toString('utf8')));
    try {
        await waitForPinnedReady(origin, options.timeoutSeconds * 1000);
    } catch (error) {
        throw new Error(`${error.message}\ngotavern output tail:\n${logs.join('').slice(-3000)}`);
    }
    const version = await fetch(`${origin}/version`, { signal: AbortSignal.timeout(5000) });
    return { child, origin, logs, version: (await version.text()).slice(0, 120) };
}

// runGotavernLeg drives the route that GoTavern reads requestOverrides on: the kobold generate handler calls
// pinnedApplyRequestOverrides while building its provider request (backends_kobold.go / backends_kobold_deferred.go),
// which goes through pinnedChatConfigValue -- the function C2 caches. That is what makes this leg a control for the
// GoTavern side of the same question the pinned legs answer.
async function runGotavernLeg({ session, mockOrigin }) {
    const before = (await readRecording(mockOrigin)).requests?.length ?? 0;
    const result = await session.post('/api/backends/kobold/generate', {
        api_server: mockOrigin,
        prompt: 'a19 config refresh probe',
        max_length: 8,
        stream: false,
    });
    const deadline = Date.now() + 15000;
    let recording = null;
    while (Date.now() < deadline) {
        recording = await readRecording(mockOrigin);
        if ((recording.requests?.length ?? 0) > before) break;
        await sleep(50);
    }
    const requests = recording?.requests ?? [];
    const recorded = requests.length > before ? requests[requests.length - 1] : null;
    return {
        httpStatus: result.status,
        httpBodyHead: (result.text ?? '').slice(0, 300),
        providerRequestSeen: Boolean(recorded),
        providerRequestTarget: recorded?.rawTarget ?? null,
        probeHeader: probeHeader(recorded),
        recordedRequestCount: requests.length,
    };
}

async function main() {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const scratch = path.join(options.scratch, stamp);
    const dataRoot = path.join(scratch, 'data');
    const configPath = path.join(scratch, 'config.yaml');
    await fsp.mkdir(dataRoot, { recursive: true });
    const artifact = {
        harness: 'tools/perf/a19-pinned-config-refresh.mjs',
        mode: options.mode,
        question: options.mode === 'pinned'
            ? 'Does pinned SillyTavern observe a config.yaml mutation made while the process is running?'
            : 'Does GoTavern observe a config.yaml mutation made while the process is running? (pinned does NOT: startup-only)',
        startedAt: new Date().toISOString(),
        subject: {},
        legs: {},
        verdict: null,
        notes: options.mode === 'pinned' ? [
            'The observed value is an outbound provider request HEADER (x-a19-probe) captured by a recording mock provider, not a browser observation.',
            'The key is requestOverrides, which pinned reads per request through getConfigValue; a stale value therefore shows the config FILE is cached process-wide.',
            'Leg 3 is the control: it proves the mutated value would be observed by a fresh process, so a stale leg 2 cannot be an unread key.',
            'Pinned is booted from its checkout without modification; data root and config are in the scratch directory.',
        ] : [
            'Same three-leg shape as the pinned probe, driven through GoTaavern\'s kobold generate route, which reads requestOverrides through pinnedChatConfigValue while building its provider request.',
            'Pre-C2 expectation (the divergence): leg 2 sees "mutated", because the reader parsed config.yaml per request.',
            'Post-C2 expectation (pinned parity): leg 2 still sees "baseline", because the parsed document is cached for the process lifetime.',
            'Leg 3 (restart with the mutated config) must see "mutated"; it proves the key is observable through this route, so a stale leg 2 is a cache and not an unread key.',
        ],
    };
    if (options.mode === 'pinned') {
        const serverPath = path.join(options.pinned, 'server.js');
        artifact.subject = { path: options.pinned, serverJsSha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(serverPath)).digest('hex') };
    } else {
        artifact.subject = { path: options.gotavern, binarySha256: (await import('node:crypto')).createHash('sha256').update(fs.readFileSync(options.gotavern)).digest('hex') };
    }

    // mock provider
    const mockBinary = path.join(scratch, 'mock-provider.exe');
    const build = spawnSync('go', ['build', '-trimpath', '-o', mockBinary, './tools/mock-provider'], { cwd: repoRoot, encoding: 'utf8' });
    if (build.status !== 0) throw new Error(`go build tools/mock-provider failed: ${build.stderr}`);
    const responsesPath = path.join(scratch, 'responses.json');
    const response = { status: 200, headers: [{ name: 'Content-Type', value: 'application/json' }], body: '{"results":[{"text":"ok"}]}' };
    fs.writeFileSync(responsesPath, JSON.stringify({ responses: Array.from({ length: 8 }, () => response) }), 'utf8');
    const mockLogs = [];
    const mock = spawn(mockBinary, ['--responses', responsesPath, '--port', '0'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    mock.stdout.on('data', chunk => mockLogs.push(chunk.toString('utf8')));
    mock.stderr.on('data', chunk => mockLogs.push(chunk.toString('utf8')));
    const mockDeadline = Date.now() + 15000;
    let mockAuthority = null;
    while (Date.now() < mockDeadline && !mockAuthority) {
        const line = mockLogs.join('').split('\n').find(entry => entry.startsWith('mock-provider '));
        if (line) mockAuthority = line.slice('mock-provider '.length).trim();
        else await sleep(50);
    }
    if (!mockAuthority) { killTree(mock); throw new Error(`mock provider did not print its address: ${mockLogs.join('').slice(-500)}`); }
    const mockOrigin = `http://${mockAuthority}`;
    artifact.mockProvider = { origin: mockOrigin };

    let subject = null;
    try {
        writeConfig(configPath, 'baseline', mockAuthority);
        subject = options.mode === 'pinned' ? await startPinned(configPath, dataRoot) : await startGotavern(configPath, dataRoot);
        artifact.subject.version = subject.version;
        const session = new Session(subject.origin);
        await session.handshake();
        const runLegForMode = options.mode === 'pinned' ? runLeg : runGotavernLeg;
        artifact.legs.leg1_baseline = await runLegForMode({ session, mockOrigin, pinnedVersion: subject.version });
        if (artifact.legs.leg1_baseline.probeHeader !== 'baseline') {
            throw new Error(`leg 1 did not observe the baseline override header (got ${JSON.stringify(artifact.legs.leg1_baseline)}): the probe is not exercising requestOverrides`);
        }

        writeConfig(configPath, 'mutated', mockAuthority);
        await sleep(250);
        artifact.legs.leg2_mutated_while_running = await runLegForMode({ session, mockOrigin, pinnedVersion: subject.version });

        killTree(subject.child);
        await sleep(1000);
        subject = options.mode === 'pinned' ? await startPinned(configPath, dataRoot) : await startGotavern(configPath, dataRoot);
        artifact.subject.restartedVersion = subject.version;
        const restartedSession = new Session(subject.origin);
        await restartedSession.handshake();
        artifact.legs.leg3_control_restarted_with_mutated_config = await runLegForMode({ session: restartedSession, mockOrigin, pinnedVersion: subject.version });
        if (artifact.legs.leg3_control_restarted_with_mutated_config.probeHeader !== 'mutated') {
            throw new Error(`the control leg did not observe the mutated header (got ${JSON.stringify(artifact.legs.leg3_control_restarted_with_mutated_config)}): the key is not observable through this route, so the probe cannot answer the question`);
        }

        const running = artifact.legs.leg2_mutated_while_running.probeHeader;
        artifact.runningObservedHeader = running;
        if (options.mode === 'pinned') {
            artifact.verdict = running === 'baseline'
                ? 'STARTUP-ONLY: pinned observed the value it parsed at startup; a config.yaml mutation made while the process runs was NOT seen by the next request'
                : 'RUNTIME RE-READ: pinned observed the mutated value without a restart';
        } else {
            artifact.verdict = running === 'baseline'
                ? 'STARTUP-ONLY (pinned parity): the mutation made while the process runs was NOT seen by the next request'
                : 'RUNTIME RE-READ (divergence from pinned): the mutation made while the process runs WAS seen by the next request';
        }
    } finally {
        killTree(subject?.child);
        killTree(mock);
    }
    artifact.finishedAt = new Date().toISOString();
    await fsp.mkdir(path.dirname(options.out), { recursive: true });
    fs.writeFileSync(options.out, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    console.log(`mode: ${options.mode}`);
    console.log(`verdict: ${artifact.verdict}`);
    console.log(`legs: leg1=${artifact.legs.leg1_baseline?.probeHeader} leg2(no restart)=${artifact.legs.leg2_mutated_while_running?.probeHeader} leg3(control)=${artifact.legs.leg3_control_restarted_with_mutated_config?.probeHeader}`);
    console.log(`artifact: ${options.out}`);
    return 0;
}
main().then(code => process.exit(code)).catch(error => { console.error(`a19-pinned-config-refresh: ${error.stack ?? error}`); process.exit(1); });
