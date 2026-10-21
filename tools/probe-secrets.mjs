#!/usr/bin/env node
// Probe the pinned secrets domain against pinned Node SillyTavern.
//
// Two phases, one fixture:
//
//   PHASE 1 (module level, no HTTP): the state map and the masking formula. The masked value is
//   pinned HERE rather than derived from getMaskedValue: the measured output is seven placeholders
//   plus the last three characters with no visible prefix. allowKeysExposure is evaluated once at
//   module load in the pinned source, so each configuration needs its own child runtime.
//
//   PHASE 2 (HTTP): the eight `/api/secrets/*` routes through the real pinned listener. This is the
//   only honest way to pin them: status codes, `sendStatus`/`send` bodies, the resulting
//   secrets.json BYTES (a write is observable, so is a deliberate non-write), and the file-creation
//   side effect of `_ensureSecretsFile`. Two boots are required for the same module-load reason as
//   phase 1.
//
// Construction note, because it cost three iterations once: the phase-1 child is WRITTEN TO A FILE
// and run, not passed through `node -e` with a template literal. Nested template construction is
// exactly the kind of second layer that should never be written before the first layer has executed.
//
// Two probe choices that are deliberate, not incidental:
//   - The pinned server is booted with `extensions.enabled: false`. /api/secrets is mounted at
//     server-startup.js:154 with NO extensionsEnabledFeatureGuard (unlike /api/extensions at :157),
//     so every recorded answer below is also evidence that the secrets domain does not depend on
//     that flag. A Go implementation that reuses the extension guard would answer 404 here.
//   - Non-write cases are seeded with TWO-space JSON. A no-op and a rewrite produce the same parsed
//     value, so bytes are the only discriminator between "returned early" and "wrote the file back".

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-secrets.json label="secrets"
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-secrets.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
const COOKIE_SECRET = 'gotavern-pinned-secrets-cookie-secret';

const utilURL = pathToFileURL(path.join(sourceRoot, 'src', 'util.js')).href;
const secretsURL = pathToFileURL(path.join(sourceRoot, 'src', 'endpoints', 'secrets.js')).href;

// Synthetic values only. Nothing here resembles a real credential.
const SEED_LONG = 'sk-synthetic-0123456789abcdefgh'; // 25 characters
const SEED_SHORT = 'short';                          // 5 characters
const SEED_TEN = 'exactlyten';                       // exactly the boundary of the length test
const SEED_LIBRE = 'synthetic-libre-value';          // exportable key: never masked

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

// Retries because this machine has been driven to 0.09 GB free by abandoned probe temp dirs, and a
// single EBUSY on Windows would otherwise leave the tree behind.
function removeWithRetries(target) {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            rmSync(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
            return;
        } catch (error) {
            if (attempt === 4) throw error;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
        }
    }
}

function safeCleanup(root, prefix) {
    const resolved = path.resolve(root);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith(prefix)) {
        throw new Error(`refusing to remove unexpected secrets path: ${resolved}`);
    }
    removeWithRetries(resolved);
}

// ── Phase 1: state map and masking ───────────────────────────────────────────────────────────────

// The child program, as a file. Written with plain string concatenation so no layer of quoting sits
// between this text and the program that runs.
function childProgram({ userRoot, dataRoot, configPath, flippedPath, seedFile }) {
    const lines = [
        `import { setConfigFilePath } from ${JSON.stringify(utilURL)};`,
        ``,
        `const userRoot = ${JSON.stringify(userRoot)};`,
        `const dataRoot = ${JSON.stringify(dataRoot)};`,
        `setConfigFilePath(${JSON.stringify(configPath)});`,
        `globalThis.DATA_ROOT = dataRoot;`,
        `Date.now = () => 1700000000000;`,
        ``,
        `const secrets = await import(${JSON.stringify(secretsURL)});`,
        `const { SecretManager, SECRET_KEYS, allowKeysExposure } = secrets;`,
        `const fs = await import('node:fs');`,
        `const directories = { root: userRoot, backups: userRoot + '/backups' };`,
        ``,
    ];
    if (seedFile === 'seeded') {
        lines.push(
            `// Seed from the pinned key ids rather than guessing them: a guessed id is silently`,
            `// absent from the state map instead of erroring, which is how the first version of`,
            `// this probe "passed" with an empty entry.`,
            `const seed = {`,
            `    [SECRET_KEYS.OPENAI]: [`,
            `        { id: 'sid-openai-1', value: ${JSON.stringify(SEED_LONG)}, label: 'primary', active: true, unknown_field: { nested: 1 } },`,
            `        { id: 'sid-openai-2', value: ${JSON.stringify(SEED_SHORT)}, label: 'secondary', active: false },`,
            `        { id: 'sid-openai-3', value: ${JSON.stringify(SEED_TEN)}, label: 'ten', active: true },`,
            `    ],`,
            `    [SECRET_KEYS.LIBRE_URL]: [`,
            `        { id: 'sid-libre-1', value: ${JSON.stringify(SEED_LIBRE)}, label: 'libre', active: true },`,
            `    ],`,
            `    [SECRET_KEYS.CUSTOM]: [],`,
            `    [SECRET_KEYS._MIGRATED]: [],`,
            `};`,
            `fs.writeFileSync(userRoot + '/secrets.json', JSON.stringify(seed, null, 4) + String.fromCharCode(10));`,
        );
    }
    lines.push(
        `const fileBefore = fs.existsSync(userRoot + '/secrets.json') ? fs.readFileSync(userRoot + '/secrets.json', 'utf8') : null;`,
        `const state = new SecretManager(directories).getSecretState();`,
        `const fileAfter = fs.existsSync(userRoot + '/secrets.json') ? fs.readFileSync(userRoot + '/secrets.json', 'utf8') : null;`,
        ``,
        `// Flip the config file under the running module: the pinned constant must NOT change.`,
        `setConfigFilePath(${JSON.stringify(flippedPath)});`,
        `const stateAfterFlip = new SecretManager(directories).getSecretState();`,
        ``,
        `console.log(JSON.stringify({`,
        `    allowKeysExposure: !!allowKeysExposure,`,
        `    secretKeyCount: Object.values(SECRET_KEYS).length,`,
        `    keyIds: { openai: SECRET_KEYS.OPENAI, libre: SECRET_KEYS.LIBRE_URL, custom: SECRET_KEYS.CUSTOM, migrated: SECRET_KEYS._MIGRATED },`,
        `    state,`,
        `    stateAfterFlipMatchesState: JSON.stringify(stateAfterFlip) === JSON.stringify(state),`,
        `    fileUnchangedByRead: fileAfter === fileBefore,`,
        `    fileCreatedByRead: fileBefore === null && fileAfter !== null,`,
        `    fileCreatedBytes: fileBefore === null ? fileAfter : null,`,
        `    seededFile: fileBefore ? JSON.parse(fileBefore) : null,`,
        `}));`,
        ``,
    );
    return lines.join('\n');
}

function runChild({ allowKeysExposure, seedFile }) {
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-secrets-oracle-'));
    try {
        const dataRoot = path.join(runtimeRoot, 'data');
        const userRoot = path.join(dataRoot, 'default-user');
        mkdirSync(path.join(userRoot, 'backups'), { recursive: true });
        const configPath = path.join(runtimeRoot, 'config.yaml');
        writeFileSync(configPath, `allowKeysExposure: ${allowKeysExposure}\n`);
        const flippedPath = path.join(runtimeRoot, 'config-flipped.yaml');
        writeFileSync(flippedPath, `allowKeysExposure: ${!allowKeysExposure}\n`);
        // 'absent' leaves no secrets.json at all; 'empty' writes an empty object. They are
        // different inputs and the pinned code branches on existsSync.
        if (seedFile === 'empty') {
            writeFileSync(path.join(userRoot, 'secrets.json'), '{}\n');
        }
        const childPath = path.join(runtimeRoot, 'child.mjs');
        writeFileSync(childPath, childProgram({ userRoot, dataRoot, configPath, flippedPath, seedFile }));
        const output = execFileSync(process.execPath, [childPath], {
            cwd: sourceRoot,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
        });
        return JSON.parse(output);
    } finally {
        safeCleanup(runtimeRoot, 'gotavern-secrets-oracle-');
    }
}

const runs = {
    exposureDisabled: runChild({ allowKeysExposure: false, seedFile: 'seeded' }),
    exposureEnabled: runChild({ allowKeysExposure: true, seedFile: 'seeded' }),
    fileAbsent: runChild({ allowKeysExposure: false, seedFile: 'absent' }),
    fileEmpty: runChild({ allowKeysExposure: false, seedFile: 'empty' }),
};

// The contract this probe exists to pin. Asserted here so a silent upstream change fails the probe
// instead of being recorded as a new expectation.
assert.equal(runs.exposureDisabled.allowKeysExposure, false);
assert.equal(runs.exposureEnabled.allowKeysExposure, true);
// The pinned util refuses to change the config path once set, so a single runtime cannot flip the
// configuration; the module-load semantics are instead proven by the two runs below producing
// DIFFERENT masking for the same seeded file, because each loaded the module with its own config.
assert.notEqual(runs.exposureDisabled.state[runs.exposureDisabled.keyIds.openai][0].value, runs.exposureEnabled.state[runs.exposureEnabled.keyIds.openai][0].value,
    'the two runs must disagree about masking, which is the evidence that allowKeysExposure is fixed at module load');
assert.equal(runs.exposureDisabled.fileUnchangedByRead, true,
    'reading an existing secrets file must not rewrite it, or rule 11 retention has no baseline');
// `_readSecretsFile` calls `_ensureSecretsFile` first, so a read on an ABSENT file CREATES one. That
// is a filesystem side effect the frontend's settings path provokes, and it is pinned here rather
// than assumed: the bytes are the pinned `JSON.stringify({})` with no trailing newline.
assert.equal(runs.fileAbsent.fileCreatedByRead, true,
    'the pinned _ensureSecretsFile must create the file when a read finds none');
assert.equal(runs.fileAbsent.fileCreatedBytes, '{}',
    'the created file is JSON.stringify(defaultSecrets), which is {} with no trailing newline');

const keys = runs.exposureDisabled.keyIds;
assert.equal(Object.hasOwn(runs.exposureDisabled.state, keys.migrated), false,
    'the migration marker must be skipped in the state map');
assert.equal(runs.exposureDisabled.state[keys.custom], null, 'an empty array must surface as null');
assert.equal(runs.exposureDisabled.state.api_key_claude, null, 'an absent key must surface as null');
assert.equal(Array.isArray(runs.exposureDisabled.state[keys.openai]), true);
assert.equal(runs.exposureDisabled.state[keys.openai].length, 3);

// THE MASKING CONTRACT, pinned by measurement rather than derived from the source.
assert.equal(runs.exposureDisabled.state[keys.openai][0].value, '*******fgh',
    'a value longer than ten characters masks to seven placeholders plus its last three characters');
assert.equal(runs.exposureDisabled.state[keys.openai][1].value, '**********',
    'a value of ten characters or fewer masks to ten placeholders');
assert.equal(runs.exposureDisabled.state[keys.openai][2].value, '**********',
    'exactly ten characters is still the short branch');
assert.equal(runs.exposureDisabled.state[keys.libre][0].value, SEED_LIBRE,
    'an exportable key must not be masked');
assert.equal(runs.exposureEnabled.state[keys.openai][0].value, SEED_LONG,
    'with exposure enabled the value is raw');
// The state projection keeps only id, value, label and active: the unknown field is not echoed.
assert.deepEqual(Object.keys(runs.exposureDisabled.state[keys.openai][0]).sort(), ['active', 'id', 'label', 'value']);

// A missing file and an empty file are different inputs, and both must produce the full null map.
for (const [label, probeRun] of [['absent', runs.fileAbsent], ['empty', runs.fileEmpty]]) {
    assert.equal(Object.keys(probeRun.state).length, runs.exposureDisabled.secretKeyCount - 1,
        `every SECRET_KEYS value except the migration marker must appear (${label} file)`);
    for (const [key, value] of Object.entries(probeRun.state)) {
        assert.equal(value, null, `${key} must be null on a ${label} file`);
    }
}

// ── Phase 2: the eight routes through the pinned listener ────────────────────────────────────────

// The seed used by every HTTP scenario. It is deliberately richer than the phase-1 seed:
//   - entry 2 has NO label, so the state projection's treatment of an absent field is observable;
//   - `api_key_custom` is an empty array, so a key present in the file but with no entries is
//     distinguishable from a key absent from the file;
//   - an unknown top-level object must survive every mutation (rule 11);
//   - `unknown_field` on entry 1 must survive every mutation.
function httpSeedObject() {
    return {
        api_key_openai: [
            { id: 'sid-openai-1', value: SEED_LONG, label: 'primary', active: true, unknown_field: { nested: 1 } },
            { id: 'sid-openai-2', value: SEED_SHORT, active: false },
            { id: 'sid-openai-3', value: SEED_TEN, label: 'ten', active: false },
        ],
        libre_url: [{ id: 'sid-libre-1', value: SEED_LIBRE, label: 'libre', active: true }],
        api_key_custom: [],
        _migrated: [],
        unknown_top_key: { preserved: true },
    };
}

const POPULATED_FILE = `${JSON.stringify(httpSeedObject(), null, 4)}\n`;
// Two-space form: a mutation that returns early leaves these bytes intact, while a mutation that
// writes the file back normalizes them to four spaces. This is the discriminator for "no write".
const POPULATED_FILE_TWO_SPACE = `${JSON.stringify(httpSeedObject(), null, 2)}\n`;
const MALFORMED_FILE = '{not json at all';
const POISONED_FILE = `${JSON.stringify({ api_key_openai: [null] }, null, 4)}\n`;

const CONFIG_YAML = (allowKeysExposure) => [
    'enableUserAccounts: true',
    'skipContentCheck: true',
    // /api/secrets is NOT behind extensionsEnabledFeatureGuard (server-startup.js:154 vs :157).
    'extensions:',
    '  enabled: false',
    `allowKeysExposure: ${allowKeysExposure ? 'true' : 'false'}`,
    '',
].join('\n');

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

// Accept-Encoding: identity keeps every recorded response uncompressed, so the recorded framing is a
// property of the route rather than of the pinned compression middleware.
async function rawRequest(url, method = 'GET', headers = {}, body) {
    const response = await fetch(url, {
        method,
        headers: { 'Accept-Encoding': 'identity', ...headers },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(15000),
    });
    const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
    let parsed = text;
    if (text) {
        try {
            parsed = JSON.parse(text);
        } catch {
            // Preserve plain text and HTML response bodies.
        }
    } else {
        parsed = null;
    }
    return { response, text, body: parsed };
}

function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

function captureHttp(result) {
    return { status: result.response.status, headers: stableHeaders(result.response), body: result.body };
}

// The recorded BODY also carries the generated uuid for /write, so it goes through the same
// normalization as the recorded file bytes; otherwise the fixture would change on every run.
// The ETag is a hash of the RAW body, so it necessarily changes with the uuid: it is recorded as a
// marker instead of being normalized into something that pretends to be an ETag. The Go test skips
// exactly that marker and compares every other header.
function captureNormalizedHttp(result) {
    const captured = captureHttp(result);
    const raw = JSON.stringify(captured.body);
    const normalized = normalizeUuids(raw);
    if (normalized !== raw) {
        captured.headers.etag = '<unstable-body>';
    }
    captured.body = JSON.parse(normalized);
    // The exact response text is recorded too, so the Go test can compare BYTES: a parsed-value
    // comparison would hide key order, which /view and /read both depend on.
    captured.bodyText = normalizeUuids(result.text);
    return captured;
}

function cookiesFrom(response) {
    if (typeof response.headers.getSetCookie !== 'function') throw new Error('Node fetch does not expose getSetCookie()');
    return response.headers.getSetCookie();
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

// A uuidv4 is generated by writeSecret and is the only nondeterministic value in this domain. It is
// replaced by a marker in both the response body and the recorded file bytes.
const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;
function normalizeUuids(text) {
    return typeof text === 'string' ? text.replace(UUID_PATTERN, '<uuid>') : text;
}

async function waitForServer(origin, child, logs) {
    const deadline = Date.now() + 180000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error(`pinned server exited before readiness:\n${logs.join('').slice(-10000)}`);
        try {
            const result = await rawRequest(`${origin}/login?noauto=1`);
            if (result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html')) return;
            lastError = new Error(`login returned ${result.response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise(resolve => setTimeout(resolve, 300));
    }
    throw new Error(`pinned server did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-10000)}`);
}

async function stopServer(child) {
    if (!child || child.exitCode !== null) return;
    child.kill('SIGINT');
    await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise(resolve => setTimeout(resolve, 5000)),
    ]);
    if (child.exitCode === null) child.kill();
}

// One boot per allowKeysExposure value: the flag is a module-level constant in the pinned source.
async function runHttpScenarios(allowKeysExposure, scenarios) {
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), 'gotavern-secrets-http-oracle-'));
    const logs = [];
    let child;
    try {
        const dataRoot = path.join(runtimeRoot, 'data');
        const configPath = path.join(runtimeRoot, 'config.yaml');
        mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
        writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), COOKIE_SECRET);
        writeFileSync(configPath, CONFIG_YAML(allowKeysExposure));
        writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
            key: 'user:default-user',
            value: {
                handle: 'default-user', name: 'Secrets Probe', created: 1700000000000,
                password: '', admin: true, enabled: true, salt: '',
                probeUnknownField: { preserve: true },
            },
        }));

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
        await waitForServer(origin, child, logs);

        const userRoot = path.join(dataRoot, 'default-user');
        const secretsPath = path.join(userRoot, 'secrets.json');

        const csrf = await rawRequest(`${origin}/csrf-token`);
        const token = csrf.body.token;
        const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
        const login = await rawRequest(`${origin}/api/users/login`, 'POST', {
            Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, JSON.stringify({ handle: 'default-user', password: '' }));
        if (login.response.status !== 200) {
            throw new Error(`could not login: ${login.response.status} ${JSON.stringify(login.body)}\n${logs.join('').slice(-10000)}`);
        }
        const sessionCookie = cookieHeader(cookiesFrom(login.response));
        const jsonHeaders = { Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token };

        const recorded = [];
        for (const scenario of scenarios) {
            if (scenario.initialFile === null) {
                if (existsSync(secretsPath)) rmSync(secretsPath, { force: true });
            } else {
                writeFileSync(secretsPath, scenario.initialFile);
            }
            const beforeBytes = existsSync(secretsPath) ? readFileSync(secretsPath, 'utf8') : null;
            if (beforeBytes !== scenario.initialFile) {
                throw new Error(`${scenario.label}: probe could not establish its own precondition`);
            }
            const steps = [];
            for (const step of scenario.steps) {
                const result = await rawRequest(`${origin}${step.route}`, 'POST', jsonHeaders, step.body);
                const fileAfter = existsSync(secretsPath) ? readFileSync(secretsPath, 'utf8') : null;
                steps.push({
                    label: step.label,
                    route: step.route,
                    body: step.body,
                    response: captureNormalizedHttp(result),
                    fileAfter: normalizeUuids(fileAfter),
                });
            }
            recorded.push({
                label: scenario.label,
                allowKeysExposure,
                initialFile: normalizeUuids(scenario.initialFile),
                steps,
            });
        }
        return recorded;
    } finally {
        await stopServer(child);
        safeCleanup(runtimeRoot, 'gotavern-secrets-http-oracle-');
    }
}

const FIND_BODY = (value) => JSON.stringify(value);

const deniedScenarios = [
    {
        label: 'viewDenied',
        initialFile: POPULATED_FILE,
        steps: [
            { label: 'view', route: '/api/secrets/view', body: '{}' },
            { label: 'viewAgain', route: '/api/secrets/view', body: '{"ignored":true}' },
        ],
    },
    {
        label: 'findWithoutExposure',
        initialFile: POPULATED_FILE,
        steps: [
            // A non-exportable key is refused BEFORE the state map is read.
            { label: 'findApiKey', route: '/api/secrets/find', body: FIND_BODY({ key: 'api_key_openai' }) },
            // The four EXPORTABLE_KEYS are readable with exposure disabled.
            { label: 'findExportable', route: '/api/secrets/find', body: FIND_BODY({ key: 'libre_url' }) },
            { label: 'findExportableById', route: '/api/secrets/find', body: FIND_BODY({ key: 'libre_url', id: 'sid-libre-1' }) },
            { label: 'findMissingKey', route: '/api/secrets/find', body: FIND_BODY({ key: 'api_key_claude' }) },
            { label: 'findNoKey', route: '/api/secrets/find', body: '{}' },
            { label: 'findEmptyKey', route: '/api/secrets/find', body: FIND_BODY({ key: '' }) },
        ],
    },
    {
        label: 'deleteById',
        initialFile: POPULATED_FILE,
        steps: [
            // Removing the INACTIVE entry leaves entry 1 active.
            { label: 'deleteInactive', route: '/api/secrets/delete', body: FIND_BODY({ key: 'api_key_openai', id: 'sid-openai-2' }) },
            // Removing the ACTIVE entry leaves no active entry, so the pinned reactivation rule
            // promotes the first remaining one. Both bytes and the flag are recorded.
            { label: 'deleteActiveById', route: '/api/secrets/delete', body: FIND_BODY({ key: 'api_key_openai', id: 'sid-openai-1' }) },
            // An empty id is FALSY, so this is the "delete the active entry" branch, not "no match".
            { label: 'deleteFalsyId', route: '/api/secrets/delete', body: FIND_BODY({ key: 'api_key_openai', id: '' }) },
            // Deleting the last entry removes the key from the file entirely.
            { label: 'deleteLastEntry', route: '/api/secrets/delete', body: FIND_BODY({ key: 'api_key_openai' }) },
            { label: 'deleteAgain', route: '/api/secrets/delete', body: FIND_BODY({ key: 'api_key_openai' }) },
        ],
    },
    {
        label: 'deleteNoOpCases',
        initialFile: POPULATED_FILE_TWO_SPACE,
        steps: [
            // An unknown key fails _validateSecretKey and returns before writing.
            { label: 'deleteUnknownKey', route: '/api/secrets/delete', body: FIND_BODY({ key: 'api_key_claude' }) },
            // The migration marker is a real array in the file, so this one DOES rewrite the file and
            // removes the marker. Recorded, not assumed.
            { label: 'deleteMigrationMarker', route: '/api/secrets/delete', body: FIND_BODY({ key: '_migrated' }) },
            { label: 'deleteNoKey', route: '/api/secrets/delete', body: '{}' },
            { label: 'deleteEmptyKey', route: '/api/secrets/delete', body: FIND_BODY({ key: '' }) },
            { label: 'deleteZeroKey', route: '/api/secrets/delete', body: '{"key":0,"id":"x"}' },
        ],
    },
    {
        label: 'deleteMissingFile',
        initialFile: null,
        steps: [
            // deleteSecret returns on a missing file BEFORE _readSecretsFile, so no file is created.
            { label: 'delete', route: '/api/secrets/delete', body: FIND_BODY({ key: 'api_key_openai' }) },
        ],
    },
    {
        label: 'rotate',
        initialFile: POPULATED_FILE,
        steps: [
            { label: 'rotateInactive', route: '/api/secrets/rotate', body: FIND_BODY({ key: 'api_key_openai', id: 'sid-openai-3' }) },
            { label: 'rotateActive', route: '/api/secrets/rotate', body: FIND_BODY({ key: 'api_key_openai', id: 'sid-openai-1' }) },
        ],
    },
    {
        label: 'rotateNoOpCases',
        initialFile: POPULATED_FILE_TWO_SPACE,
        steps: [
            // An unknown id logs and returns WITHOUT writing (bytes stay two-space).
            { label: 'rotateUnknownId', route: '/api/secrets/rotate', body: FIND_BODY({ key: 'api_key_openai', id: 'sid-missing' }) },
            { label: 'rotateUnknownKey', route: '/api/secrets/rotate', body: FIND_BODY({ key: 'api_key_claude', id: 'sid-missing' }) },
            { label: 'rotateNoKey', route: '/api/secrets/rotate', body: FIND_BODY({ id: 'sid-openai-1' }) },
            { label: 'rotateNoId', route: '/api/secrets/rotate', body: FIND_BODY({ key: 'api_key_openai' }) },
            { label: 'rotateEmptyId', route: '/api/secrets/rotate', body: FIND_BODY({ key: 'api_key_openai', id: '' }) },
        ],
    },
    {
        label: 'rotateMissingFile',
        initialFile: null,
        steps: [
            // rotateSecret has an existsSync guard, so no file is created.
            { label: 'rotate', route: '/api/secrets/rotate', body: FIND_BODY({ key: 'api_key_openai', id: 'x' }) },
        ],
    },
    {
        label: 'rename',
        initialFile: POPULATED_FILE,
        steps: [
            // Entry 2 has no label, so the assignment APPENDS the field at the end of the object.
            { label: 'renameWithoutLabel', route: '/api/secrets/rename', body: FIND_BODY({ key: 'api_key_openai', id: 'sid-openai-2', label: 'renamed' }) },
            // Entry 1 already has a label, so the assignment REPLACES it in place.
            { label: 'renameWithLabel', route: '/api/secrets/rename', body: FIND_BODY({ key: 'api_key_openai', id: 'sid-openai-1', label: 'primary-renamed' }) },
            // `label` is only truthiness-checked, so a number is written as a number.
            { label: 'renameNumericLabel', route: '/api/secrets/rename', body: '{"key":"libre_url","id":"sid-libre-1","label":5}' },
        ],
    },
    {
        label: 'renameNoOpCases',
        initialFile: POPULATED_FILE_TWO_SPACE,
        steps: [
            { label: 'renameEmptyLabel', route: '/api/secrets/rename', body: '{"key":"api_key_openai","id":"sid-openai-1","label":""}' },
            { label: 'renameZeroLabel', route: '/api/secrets/rename', body: '{"key":"api_key_openai","id":"sid-openai-1","label":0}' },
            { label: 'renameFalseLabel', route: '/api/secrets/rename', body: '{"key":"api_key_openai","id":"sid-openai-1","label":false}' },
            { label: 'renameNoLabel', route: '/api/secrets/rename', body: '{"key":"api_key_openai","id":"sid-openai-1"}' },
            { label: 'renameNoId', route: '/api/secrets/rename', body: '{"key":"api_key_openai","label":"x"}' },
            { label: 'renameNoKey', route: '/api/secrets/rename', body: '{"id":"sid-openai-1","label":"x"}' },
            // Unknown key/id: rename returns late (after validate/findIndex) without writing, but
            // _readSecretsFile already ensured the file exists. Bytes stay two-space.
            { label: 'renameUnknownKey', route: '/api/secrets/rename', body: '{"key":"api_key_claude","id":"x","label":"y"}' },
            { label: 'renameUnknownId', route: '/api/secrets/rename', body: '{"key":"api_key_openai","id":"sid-missing","label":"y"}' },
        ],
    },
    {
        label: 'renameMissingFile',
        initialFile: null,
        steps: [
            // renameSecret has NO existsSync guard, so _readSecretsFile creates an empty file.
            { label: 'rename', route: '/api/secrets/rename', body: '{"key":"api_key_openai","id":"x","label":"y"}' },
        ],
    },
    {
        label: 'readMissingFile',
        initialFile: null,
        steps: [
            { label: 'read', route: '/api/secrets/read', body: '{}' },
        ],
    },
    {
        label: 'readPopulated',
        initialFile: POPULATED_FILE,
        steps: [
            // Entry 2 has no label: the projection must OMIT the field rather than send null.
            { label: 'read', route: '/api/secrets/read', body: '{}' },
        ],
    },
    {
        label: 'malformedFile',
        initialFile: MALFORMED_FILE,
        steps: [
            // The pinned catch in /read answers an empty object, not an error status.
            { label: 'read', route: '/api/secrets/read', body: '{}' },
            // /view refuses on exposure before it reads, and /read of an exportable key is refused
            // for the same reason, so the parse is reached only by the routes below.
            { label: 'view', route: '/api/secrets/view', body: '{}' },
            { label: 'findExportable', route: '/api/secrets/find', body: FIND_BODY({ key: 'libre_url' }) },
            { label: 'delete', route: '/api/secrets/delete', body: FIND_BODY({ key: 'api_key_openai' }) },
            { label: 'rotate', route: '/api/secrets/rotate', body: FIND_BODY({ key: 'api_key_openai', id: 'x' }) },
            { label: 'rename', route: '/api/secrets/rename', body: '{"key":"api_key_openai","id":"x","label":"y"}' },
        ],
    },
    {
        label: 'writeTwice',
        initialFile: POPULATED_FILE,
        steps: [
            // writeSecret deactivates every existing entry for the key and sets the previous default
            // label 'Unlabeled' (NOT 'Unnamed') when the body has no label.
            { label: 'writeFirst', route: '/api/secrets/write', body: FIND_BODY({ key: 'api_key_custom', value: 'first-value', label: 'first' }) },
            { label: 'writeSecondWithoutLabel', route: '/api/secrets/write', body: FIND_BODY({ key: 'api_key_custom', value: 'second-value' }) },
            // A null label is NOT undefined, so the default does not apply and null is written.
            { label: 'writeNullLabel', route: '/api/secrets/write', body: '{"key":"api_key_custom","value":"third-value","label":null}' },
            { label: 'writeEmptyKey', route: '/api/secrets/write', body: '{"value":"x"}' },
            { label: 'writeNonStringValue', route: '/api/secrets/write', body: '{"key":"api_key_custom","value":42}' },
        ],
    },
];

const allowedScenarios = [
    {
        label: 'viewAllowed',
        initialFile: POPULATED_FILE,
        steps: [
            // getAllSecrets returns the ACTIVE entry's raw value per key, in file order, and skips
            // non-array members such as the unknown top-level object.
            { label: 'view', route: '/api/secrets/view', body: '{}' },
        ],
    },
    {
        label: 'findAllowed',
        initialFile: POPULATED_FILE,
        steps: [
            { label: 'findActive', route: '/api/secrets/find', body: FIND_BODY({ key: 'api_key_openai' }) },
            { label: 'findById', route: '/api/secrets/find', body: FIND_BODY({ key: 'api_key_openai', id: 'sid-openai-2' }) },
            { label: 'findUnknownId', route: '/api/secrets/find', body: FIND_BODY({ key: 'api_key_openai', id: 'sid-missing' }) },
            { label: 'findNumericId', route: '/api/secrets/find', body: '{"key":"api_key_openai","id":5}' },
            { label: 'findEmptyArrayKey', route: '/api/secrets/find', body: FIND_BODY({ key: 'api_key_custom' }) },
            { label: 'findAbsentKey', route: '/api/secrets/find', body: FIND_BODY({ key: 'api_key_claude' }) },
            // The migration marker is skipped by the state map, so it is a 404 even with exposure.
            { label: 'findMigrationMarker', route: '/api/secrets/find', body: FIND_BODY({ key: '_migrated' }) },
            // A key that exists in the file but is not in SECRET_KEYS is not in the state map: 404.
            { label: 'findUnknownTopLevelKey', route: '/api/secrets/find', body: FIND_BODY({ key: 'unknown_top_key' }) },
            // ...but an inherited Object.prototype property IS truthy in the pinned `!state[key]`
            // check, so the route proceeds and readSecret answers an empty string instead of 404.
            { label: 'findPrototypeConstructor', route: '/api/secrets/find', body: FIND_BODY({ key: 'constructor' }) },
            { label: 'findPrototypeToString', route: '/api/secrets/find', body: FIND_BODY({ key: 'toString' }) },
            { label: 'findUnknownKey', route: '/api/secrets/find', body: FIND_BODY({ key: 'not_a_secret_key' }) },
        ],
    },
    {
        label: 'viewMissingFile',
        initialFile: null,
        steps: [
            // getAllSecrets -> _readSecretsFile -> _ensureSecretsFile creates the file.
            { label: 'view', route: '/api/secrets/view', body: '{}' },
        ],
    },
    {
        label: 'findMissingFile',
        initialFile: null,
        steps: [
            // getSecretState creates the file before the 404 is decided.
            { label: 'find', route: '/api/secrets/find', body: FIND_BODY({ key: 'api_key_openai' }) },
        ],
    },
    {
        label: 'poisonedFile',
        initialFile: POISONED_FILE,
        steps: [
            // A null entry makes every projection throw: /read answers {}, everything else 500.
            { label: 'read', route: '/api/secrets/read', body: '{}' },
            { label: 'view', route: '/api/secrets/view', body: '{}' },
            { label: 'find', route: '/api/secrets/find', body: FIND_BODY({ key: 'api_key_openai' }) },
            { label: 'delete', route: '/api/secrets/delete', body: FIND_BODY({ key: 'api_key_openai' }) },
            { label: 'rotate', route: '/api/secrets/rotate', body: FIND_BODY({ key: 'api_key_openai', id: 'x' }) },
            { label: 'rename', route: '/api/secrets/rename', body: '{"key":"api_key_openai","id":"x","label":"y"}' },
        ],
    },
];

const httpRuns = [
    ...await runHttpScenarios(false, deniedScenarios),
    ...await runHttpScenarios(true, allowedScenarios),
];

// Sanity assertions on the phase-2 recording, so a silently broken probe fails instead of writing a
// fixture full of identical default answers.
const byLabel = new Map(httpRuns.map(run => [run.label, run]));
function step(runLabel, stepLabel) {
    const run = byLabel.get(runLabel);
    assert.ok(run, `missing recorded scenario ${runLabel}`);
    const found = run.steps.find(candidate => candidate.label === stepLabel);
    assert.ok(found, `missing recorded step ${runLabel}/${stepLabel}`);
    return found;
}
assert.equal(step('viewDenied', 'view').response.status, 403, '/view must refuse without allowKeysExposure');
assert.equal(step('viewAllowed', 'view').response.body.api_key_openai, SEED_LONG,
    'with exposure the view body carries raw values');
assert.equal(step('findWithoutExposure', 'findExportable').response.body.value, SEED_LIBRE,
    'an exportable key is readable without exposure');
assert.equal(step('findWithoutExposure', 'findApiKey').response.status, 403,
    'a non-exportable key is refused without exposure');
assert.equal(step('findAllowed', 'findPrototypeConstructor').response.status, 200,
    'an Object.prototype key passes the !state[key] check');
assert.equal(step('findAllowed', 'findMigrationMarker').response.status, 404,
    'the migration marker is absent from the state map, so find answers 404');
assert.equal(step('deleteById', 'deleteLastEntry').fileAfter.includes('api_key_openai'), false,
    'deleting the last entry removes the key from the file');
assert.notEqual(step('deleteNoOpCases', 'deleteUnknownKey').fileAfter, null);
assert.equal(step('deleteNoOpCases', 'deleteUnknownKey').fileAfter, POPULATED_FILE_TWO_SPACE,
    'a mutation that returns early must not rewrite the file (two-space seed survives)');
assert.equal(step('rotateNoOpCases', 'rotateUnknownId').fileAfter, POPULATED_FILE_TWO_SPACE,
    'rotate with an unknown id must not rewrite the file');
assert.equal(step('rotateMissingFile', 'rotate').fileAfter, null,
    'rotate must not create a missing secrets file');
assert.equal(step('deleteMissingFile', 'delete').fileAfter, null,
    'delete must not create a missing secrets file');
assert.equal(step('renameMissingFile', 'rename').fileAfter, '{}',
    'rename has no existsSync guard, so it creates an empty file');
assert.equal(step('readMissingFile', 'read').fileAfter, '{}',
    'the read state map creates a missing secrets file');
assert.equal(step('writeTwice', 'writeSecondWithoutLabel').fileAfter.includes('"Unlabeled"'), true,
    'the pinned default label is Unlabeled');
assert.equal(step('malformedFile', 'read').response.body && Object.keys(step('malformedFile', 'read').response.body).length, 0,
    '/read answers an empty object for an unparsable file');
assert.equal(step('poisonedFile', 'read').response.body && Object.keys(step('poisonedFile', 'read').response.body).length, 0,
    '/read answers an empty object when an entry is null');
assert.equal(step('poisonedFile', 'delete').response.status, 500,
    'a null entry makes delete throw, which the pinned catch answers with 500');
assert.equal(byLabel.get('poisonedFile').steps[0].fileAfter, POISONED_FILE,
    'a failing mutation must leave the poisoned file untouched');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-secrets.mjs',
    pinnedMasking: {
        longValue: { input: SEED_LONG, output: '*******fgh', formula: "'*'.repeat(10 - 3) + value.slice(-3)" },
        shortValue: { input: SEED_SHORT, output: '**********' },
        tenCharacters: { input: SEED_TEN, output: '**********' },
        exportableKey: { keyId: 'libre_url', input: SEED_LIBRE, output: SEED_LIBRE },
    },
    normalizations: [
        'writeSecret generates a uuidv4, the only nondeterministic value in this domain. The probe replaces it with <uuid> in the recorded response body and in every recorded secrets.json, so the fixture is stable across runs.',
        'The /write response ETag is a hash of the RAW body, so it is a function of that uuid. It is recorded as "<unstable-body>" and the Go test skips exactly that marker while comparing every other header; it must not appear anywhere else.',
        'Requests are sent with Accept-Encoding: identity so the recorded framing is a property of the route rather than of the pinned compression middleware.',
        'secrets.json bytes are recorded verbatim (never sizes, mtimes or directory stat values), so no observation depends on the host filesystem.',
        'The pinned server is booted with extensions.enabled: false, proving the secrets routes are not behind extensionsEnabledFeatureGuard.',
        'A deliberate non-write is seeded with two-space JSON: a rewrite normalizes the file to four spaces, so the bytes discriminate "returned early" from "wrote it back".',
    ],
    configurations: { allowKeysExposureFalse: CONFIG_YAML(false), allowKeysExposureTrue: CONFIG_YAML(true) },
    seeds: {
        populatedFile: POPULATED_FILE,
        populatedFileTwoSpace: POPULATED_FILE_TWO_SPACE,
        malformedFile: MALFORMED_FILE,
        poisonedFile: POISONED_FILE,
    },
    runs,
    httpRuns,
};
const fixturePath = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-secrets.json');
writeFileSync(fixturePath, `${JSON.stringify(fixture, null, 2)}\n`);

console.log(`exposure disabled state[api_key_openai] = ${JSON.stringify(runs.exposureDisabled.state[keys.openai])}`);
console.log(`exportable key raw = ${JSON.stringify(runs.exposureDisabled.state[keys.libre])}`);
console.log(`absent file: ${Object.keys(runs.fileAbsent.state).length} keys, all null = ${Object.values(runs.fileAbsent.state).every(value => value === null)}`);
console.log(`http scenarios: ${httpRuns.length}, steps: ${httpRuns.reduce((total, run) => total + run.steps.length, 0)}`);
console.log(`fixture written to ${fixturePath}`);
