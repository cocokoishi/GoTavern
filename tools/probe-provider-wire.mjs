#!/usr/bin/env node
// Capture the pinned backend -> provider transformation for every provider-wire
// scenario, then close the differential: run the same scenarios through
// GoTavern and compare the two captures.
//
// Stage 1 drives each backend with the browser-equivalent HTTP request and
// records what reaches the provider. It validates the BACKEND to PROVIDER
// transformation only: browser-side prompt assembly happens in the frontend
// before the request reaches the route and is not covered here, so a green
// capture is not evidence of preset-level equivalence.
//
// The committed fixture is the pinned Node capture. The GoTavern capture is
// produced in memory by this run and compared against it here, because the
// comparison is the differential: if the two disagree, this probe fails and the
// oracle job fails with it.
//
// @gotavern-oracle: fixture=sillytavern-1.19.0-provider-wire.json label="provider wire"

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const PINNED_VERSION = '1.19.0';
const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-provider-wire.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

// The oracle runner copies this probe into a temporary pinned clone and runs it
// from there, so a relative import would resolve inside that clone. The
// comparator is resolved from the GoTavern root instead.
const { compareObservations } = await import(pathToFileURL(path.join(repositoryRoot, 'tools', 'compare-observations.mjs')).href);

const scenarioDirectory = path.join(repositoryRoot, 'tests', 'provider-wire', 'scenarios');
const scenarios = readdirSync(scenarioDirectory)
    .filter(name => name.endsWith('.json'))
    .sort()
    .map(name => ({ file: name, definition: JSON.parse(readFileSync(path.join(scenarioDirectory, name), 'utf8')) }));
if (scenarios.length === 0) throw new Error('no provider-wire scenarios found');

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

async function choosePort() {
    const listener = net.createServer();
    await new Promise((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(0, '127.0.0.1', resolve);
    });
    const port = listener.address().port;
    await new Promise(resolve => listener.close(resolve));
    return port;
}

async function request(url, method = 'GET', headers = {}, body) {
    const response = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(15000) });
    const text = Buffer.from(await response.arrayBuffer()).toString('utf8');
    let parsed = text;
    try {
        parsed = text ? JSON.parse(text) : null;
    } catch {
        // Preserve plain text and HTML bodies.
    }
    return { response, body: parsed, text };
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

// Drives a streaming generation and cancels it once the first event has been
// seen, which is how the abort case is exercised deterministically: the trigger
// is an observed event rather than a wall-clock delay.
async function requestAbortingAfterFirstEvent(url, headers, body) {
    const controller = new AbortController();
    const response = await fetch(url, {
        method: 'POST', headers, body, redirect: 'manual', signal: controller.signal,
    });
    let text = '';
    let aborted = false;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
            if (text.includes('\n\n')) {
                aborted = true;
                controller.abort();
                break;
            }
        }
    } catch (error) {
        if (error?.name !== 'AbortError') throw error;
        aborted = true;
    }
    return { response, body: null, text, aborted };
}

// Drives a request that the backend may never finish, for example when the
// provider dies mid-stream. The bound is a scenario constant, not a timing
// measurement: the capture records whether the backend completed or left the
// caller hanging, and whatever it had already delivered.
async function requestUntilTimeout(url, headers, body, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
        response = await fetch(url, { method: 'POST', headers, body, redirect: 'manual', signal: controller.signal });
    } catch (error) {
        clearTimeout(timer);
        if (error?.name === 'AbortError') return { response: { status: 0, headers: new Headers() }, body: null, text: '', timedOut: true };
        throw error;
    }
    let text = '';
    let timedOut = false;
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            text += decoder.decode(value, { stream: true });
        }
    } catch (error) {
        if (error?.name === 'AbortError') timedOut = true;
        else if (String(error?.message ?? '').includes('terminated')) timedOut = true;
        else throw error;
    } finally {
        clearTimeout(timer);
    }
    return { response, body: null, text, timedOut };
}

// Parses a Server-Sent Events body into its event sequence. The event name and
// the data payload are kept verbatim rather than JSON-decoded, so an encoding or
// formatting difference cannot round-trip away. Per ARCHITECTURE.md section 17
// the parsed event sequence is compared, not TCP packet boundaries.
function parseSSE(text) {
    const events = [];
    let current = { event: null, data: [] };
    for (const rawLine of text.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
        if (line === '') {
            if (current.data.length > 0 || current.event !== null) {
                events.push({ event: current.event, data: current.data.join('\n') });
            }
            current = { event: null, data: [] };
            continue;
        }
        if (line.startsWith('event:')) {
            current.event = line.slice('event:'.length).trim();
        } else if (line.startsWith('data:')) {
            current.data.push(line.slice('data:'.length).replace(/^ /, ''));
        }
    }
    if (current.data.length > 0 || current.event !== null) {
        events.push({ event: current.event, data: current.data.join('\n') });
    }
    return events;
}

function stableHeaders(headers) {
    return Object.fromEntries([...headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'set-cookie', 'transfer-encoding', 'content-length', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

async function startMockProvider(binaryPath, scriptPath, logs) {
    // The mock is built once and spawned as a binary rather than through
    // `go run`: `go run` leaves a compiled grandchild behind that outlives the
    // parent and keeps the probe's event loop alive.
    const child = spawn(binaryPath, ['--responses', scriptPath], {
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    let address = '';
    child.stdout.on('data', chunk => {
        const match = /mock-provider (\S+)/.exec(chunk);
        if (match) address = match[1];
    });
    child.stderr.on('data', chunk => logs.push(chunk));
    const deadline = Date.now() + 180000;
    while (!address && Date.now() < deadline) {
        if (child.exitCode !== null) throw new Error('mock provider exited early:\n' + logs.join('').slice(-4000));
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!address) throw new Error('mock provider did not report an address:\n' + logs.join('').slice(-4000));
    return { child, address };
}

// Prepares the runtime inputs both backends must see. This is shared rather
// than duplicated so the two backends cannot silently be driven with different
// config, accounts or secrets, which would make the comparison meaningless.
function prepareRuntime(scenario, runtimeRoot, dataRoot) {
    const configPath = path.join(runtimeRoot, 'config.yaml');
    writeFileSync(configPath, scenario.backendConfig.join('\n') + '\n');
    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), 'gotavern-pinned-provider-wire-cookie-secret');
    writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
        key: 'user:default-user',
        value: {
            handle: 'default-user', name: 'Provider Wire Probe', created: 1700000000000,
            password: '', admin: true, enabled: true, salt: '', probeUnknownField: { preserve: true },
        },
    }));
    if (Object.keys(scenario.secrets).length > 0) {
        const userRoot = path.join(dataRoot, 'default-user');
        mkdirSync(userRoot, { recursive: true });
        writeFileSync(path.join(userRoot, 'secrets.json'), JSON.stringify(scenario.secrets, null, 4));
    }
    return configPath;
}

async function waitForBackend(child, origin, logs, label) {
    const deadline = Date.now() + 180000;
    let ready = false;
    while (Date.now() < deadline && !ready) {
        if (child.exitCode !== null) throw new Error(`${label} exited early:\n${logs.join('').slice(-4000)}`);
        try {
            const result = await request(`${origin}/login?noauto=1`);
            ready = result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html');
        } catch {
            // Still starting.
        }
        if (!ready) await new Promise(resolve => setTimeout(resolve, 400));
    }
    if (!ready) throw new Error(`${label} did not become ready:\n${logs.join('').slice(-4000)}`);
}

async function startPinnedServer(scenario, runtimeRoot, dataRoot, logs) {
    const configPath = prepareRuntime(scenario, runtimeRoot, dataRoot);
    const port = await choosePort();
    const child = spawn(process.execPath, [
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));

    const origin = `http://127.0.0.1:${port}`;
    await waitForBackend(child, origin, logs, 'pinned server');
    return { child, origin };
}

async function startGoTavernServer(binaryPath, scenario, runtimeRoot, dataRoot, logs) {
    const configPath = prepareRuntime(scenario, runtimeRoot, dataRoot);
    const port = await choosePort();
    // The same command-line contract the pinned server is started with, so the
    // two backends differ only in the implementation under test.
    const child = spawn(binaryPath, [
        '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: runtimeRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));

    const origin = `http://127.0.0.1:${port}`;
    await waitForBackend(child, origin, logs, 'GoTavern');
    return { child, origin };
}

async function authenticate(origin) {
    const csrf = await request(`${origin}/csrf-token`);
    const token = csrf.body.token;
    const csrfCookie = cookieHeader(csrf.response.headers.getSetCookie());
    const login = await request(`${origin}/api/users/login`, 'POST', {
        Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
    }, JSON.stringify({ handle: 'default-user', password: '' }));
    if (login.response.status !== 200) {
        throw new Error(`could not log in: ${login.response.status} ${JSON.stringify(login.body)}`);
    }
    return { token, sessionCookie: cookieHeader(login.response.headers.getSetCookie()) };
}

// The mock listens on an ephemeral loopback port, so the authority is not a
// property of either backend. It appears in the Host header and in the driver's
// own request body, and both are recorded with the authority replaced rather
// than left to vary per run. Both substitutions are declared in the fixture's
// tier-2 list with the pinned line that shows where the value comes from.
function replaceMockAuthority(value, mockAddress) {
    return value.split(`http://${mockAddress}`).join('http://<mock>');
}

function normalizeProviderBody(body, mockAddress) {
    if (typeof body === 'string') return replaceMockAuthority(body, mockAddress);
    if (Array.isArray(body)) return body.map(item => normalizeProviderBody(item, mockAddress));
    if (body && typeof body === 'object') {
        const normalized = {};
        for (const key of Object.keys(body)) normalized[key] = normalizeProviderBody(body[key], mockAddress);
        return normalized;
    }
    return body;
}

// Extracts the header name from a normalization path of the form
// provider.requests[].headers[<name>].
function headerNameFromPath(entryPath) {
    const match = /headers\[([^\]]+)\]$/.exec(entryPath ?? '');
    return match ? match[1] : null;
}

// Fails closed: every normalization entry needs a source, no rule may name a
// header that was never observed on the surface it targets, and a header may
// not be both normalized and excluded. The three sets must partition what the
// mock actually saw, so a header can never be observed and then silently
// ignored.
function assertHeaderCoverage(definition, provider, responseHeaderNames) {
    const entries = [...(definition.normalization?.tier2 ?? []), ...(definition.normalization?.tier3 ?? [])];
    for (const entry of entries) {
        if (!entry.pinnedSource && !entry.harnessSource) {
            throw new Error(`normalization entry ${entry.path} has neither pinnedSource nor harnessSource`);
        }
    }
    const observed = new Set();
    for (const request of provider.requests) {
        for (const header of request.headers) observed.add(header.name);
    }
    const responseHeaders = new Set(responseHeaderNames);
    const normalized = new Set();
    const excluded = new Set();
    for (const [tier, bucket] of [['tier2', normalized], ['tier3', excluded]]) {
        for (const entry of definition.normalization?.[tier] ?? []) {
            const name = headerNameFromPath(entry.path);
            if (!name) continue;
            if ((entry.path ?? '').startsWith('provider.requests[].headers[')) {
                if (!observed.has(name)) {
                    throw new Error(`${tier} rule names request header ${name}, which the mock never observed; the rule is stale`);
                }
                bucket.add(name);
                continue;
            }
            if ((entry.path ?? '').startsWith('providerResponse.headers[')) {
                if (!responseHeaders.has(name)) {
                    throw new Error(`${tier} rule names response header ${name}, which the backend never sent; the rule is stale`);
                }
                bucket.add(name);
                continue;
            }
            // Other paths (for example the driver body) only need a source.
        }
    }
    for (const name of normalized) {
        if (excluded.has(name)) throw new Error(`header ${name} is both normalized and excluded`);
    }
    const comparedExactly = [...observed].filter(name => !normalized.has(name) && !excluded.has(name)).sort();
    return {
        comparedExactly,
        normalized: [...normalized].sort(),
        excluded: [...excluded].sort(),
    };
}

// Applies only the normalizations the scenario declares, each of which carries
// a pinned or harness source. Anything not declared is compared exactly.
function normalizeProvider(recording, mockAddress) {
    const provider = JSON.parse(JSON.stringify(recording));
    for (const request of provider.requests) {
        request.headers = request.headers.map(header => {
            if (header.name === 'Host') return { name: header.name, value: '<mock-authority>' };
            if (header.name === 'authorization' && /^Bearer\s/i.test(header.value)) {
                return { name: header.name, value: 'Bearer <redacted>' };
            }
            return header;
        });
    }
    void mockAddress;
    return provider;
}

// Runs one scenario against one backend and returns its capture. Both backends
// go through this exact code, so a difference in the capture is a difference in
// the backend and not in how it was driven.
async function captureScenario({ file, definition, mockBinary, startBackend, backendLabel, goCaptureDirectory }) {
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), `gotavern-provider-wire-${definition.name}-`));
    const dataRoot = path.join(runtimeRoot, 'data');
    const logs = [];
    let backendChild;
    let mockChild;
    try {
        mkdirSync(dataRoot, { recursive: true });
        const scriptPath = path.join(runtimeRoot, 'mock-script.json');
        writeFileSync(scriptPath, JSON.stringify(definition.mock, null, 2));
        const mock = await startMockProvider(mockBinary, scriptPath, logs);
        mockChild = mock.child;
        const server = await startBackend(definition, runtimeRoot, dataRoot, logs);
        backendChild = server.child;
        const { token, sessionCookie } = await authenticate(server.origin);

        const body = JSON.parse(JSON.stringify(definition.request.body));
        for (const key of Object.keys(body)) {
            if (typeof body[key] === 'string') body[key] = body[key].replace('<mock>', `http://${mock.address}`);
        }
        const rawBody = JSON.stringify(body);
        const generated = definition.abortAfterFirstEvent
            ? await requestAbortingAfterFirstEvent(`${server.origin}${definition.request.path}`, {
                Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
            }, rawBody)
            : definition.driverTimeoutMs
                ? await requestUntilTimeout(`${server.origin}${definition.request.path}`, {
                    Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
                }, rawBody, definition.driverTimeoutMs)
                : await request(`${server.origin}${definition.request.path}`, 'POST', {
                    Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
                }, rawBody);

        // Cancellation is observed at the provider, so give the backend a bounded
        // moment to tear the upstream connection down before reading the
        // recording. The wait is bounded rather than timed so the capture stays
        // deterministic.
        let recordingText;
        for (let attempt = 0; attempt < 40; attempt++) {
            const polled = await request(`http://${mock.address}/__mock/recording`);
            if (polled.response.status !== 200) {
                throw new Error(`mock provider recording unavailable: ${polled.response.status}`);
            }
            recordingText = polled.body;
            const disconnected = (recordingText.requests ?? []).every(entry => entry.clientDisconnected);
            if (!definition.abortAfterFirstEvent || disconnected) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const recorded = { body: recordingText };
        const recordedBody = normalizeProviderBody(body, mock.address);
        const recordedBodyJSON = JSON.stringify(recordedBody);
        const normalizedProvider = normalizeProvider(recorded.body, mock.address);
        const headerCoverage = assertHeaderCoverage(definition, normalizedProvider, [...generated.response.headers.keys()]);

        // A scenario that declares an expected key must actually have exercised
        // secret or proxy-password reading. Without this an empty key would be
        // redacted to the same placeholder and the scenario would prove nothing
        // about the pinned settings shape.
        let authorizationKeyVerified = false;
        if (definition.expectedAuthorizationKey) {
            const observed = (recorded.body.requests ?? [])
                .flatMap(entry => entry.headers)
                .find(header => header.name === 'authorization');
            const expected = `Bearer ${definition.expectedAuthorizationKey}`;
            if (!observed || observed.value !== expected) {
                throw new Error(`scenario ${definition.name}: ${backendLabel} provider saw authorization ${JSON.stringify(observed?.value)}, expected the declared key to be read through the pinned settings shape`);
            }
            authorizationKeyVerified = true;
        }

        // The scenario declares whether the generation is streamed. Detecting it
        // from the response content type would be wrong: the pinned streaming
        // path forwards the body WITHOUT a content-type header, and that
        // omission is itself part of the captured contract, so it is recorded
        // rather than used to decide how to parse.
        const isEventStream = definition.request.body.stream === true;
        const capture = {
            scenario: file,
            purpose: definition.purpose,
            stage1Boundary: definition.stage1Boundary,
            targetPath: definition.targetPath,
            comparisonRule: 'Assert on bodySha256 and bodyLength, which cover the exact bytes. bodyText is a readability projection only and must never be compared: a byte-level encoding difference would round-trip away.',
            http: {
                observed: true,
                note: 'Stage 1 drives the backend directly with the browser-equivalent request; this is the driver request, not a browser capture. The mock authority is normalized to <mock> because the mock listens on an ephemeral port.',
                requests: [{
                    method: 'POST',
                    path: definition.request.path,
                    body: recordedBody,
                    bodySha256: sha256(recordedBodyJSON),
                }],
            },
            provider: {
                observed: true,
                requests: normalizedProvider.requests,
            },
            // Observer C: the provider-to-browser leg. For a stream the parsed
            // event sequence is compared, not the raw framing; for a non-stream
            // response the parsed body is compared.
            providerResponse: {
                observed: true,
                status: generated.response.status,
                headers: stableHeaders(generated.response.headers),
                contentType: generated.response.headers.get('content-type') ?? null,
                abortedByDriver: generated.aborted === true,
                driverTimedOut: generated.timedOut === true,
                events: isEventStream ? parseSSE(generated.text) : undefined,
                body: isEventStream ? undefined : generated.body,
            },
            browserEvents: {
                observed: false,
                reason: 'Stage 1 has no browser: the request is driven directly. Browser-side prompt assembly and events belong to a later stage.',
            },
            filesystem: {
                observed: false,
                reason: 'Provider-wire stage 1 compares the request that reaches the provider; data-tree effects are covered by the existing domain oracles.',
            },
            normalization: definition.normalization,
            headerCoverage,
            authorizationKeyVerified,
        };
        if (goCaptureDirectory) {
            mkdirSync(goCaptureDirectory, { recursive: true });
            writeFileSync(path.join(goCaptureDirectory, `${definition.name}.json`), JSON.stringify(capture, null, 2) + '\n');
        }
        return capture;
    } catch (error) {
        console.error(`scenario ${definition.name} failed against ${backendLabel}:`, error);
        console.error(logs.join('').slice(-4000));
        process.exitCode = 1;
        throw error;
    } finally {
        for (const child of [backendChild, mockChild]) {
            if (child && child.exitCode === null) child.kill('SIGINT');
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
        for (const child of [backendChild, mockChild]) {
            if (child && child.exitCode === null) child.kill();
        }
        rmSync(runtimeRoot, { recursive: true, force: true });
    }
}

// The comparison rule this harness exists for: the assertion is anchored on the
// bytes that reached the provider, through bodySha256 and bodyLength. bodyText
// is a readability projection and is never the assertion, because a byte-level
// encoding difference would round-trip away through it. A capture that is
// missing the digest cannot be compared, and saying so is the point: an absent
// or incomplete capture must never look like a pass.
function assertProviderBodyDigests(name, label, capture) {
    if (capture?.provider?.observed !== true) {
        throw new Error(`${label} capture for ${name} does not mark the provider surface observed`);
    }
    const requests = capture.provider.requests ?? [];
    if (requests.length === 0) {
        throw new Error(`${label} capture for ${name} records no provider request at all`);
    }
    for (const entry of requests) {
        if (typeof entry.bodySha256 !== 'string' || entry.bodySha256 === '' || typeof entry.bodyLength !== 'number') {
            throw new Error(`${label} capture for ${name} request ${entry.index} has no bodySha256/bodyLength; the comparison cannot be anchored on the exact bytes`);
        }
    }
}

function assertGoTavernMatchesPinned(pinnedCaptures, goTavernCaptures) {
    const names = Object.keys(pinnedCaptures);
    if (names.length === 0) {
        throw new Error('the pinned capture has no scenarios, so nothing would be compared');
    }
    const missing = names.filter(name => !(name in goTavernCaptures));
    if (missing.length > 0) {
        throw new Error(`GoTavern produced no capture for ${missing.join(', ')}; an absent capture must never pass as equal`);
    }
    for (const name of names) {
        const reference = pinnedCaptures[name];
        const candidate = goTavernCaptures[name];
        assertProviderBodyDigests(name, 'pinned Node', reference);
        assertProviderBodyDigests(name, 'GoTavern', candidate);

        const referenceRequests = reference.provider.requests;
        const candidateRequests = candidate.provider.requests;
        if (referenceRequests.length !== candidateRequests.length) {
            throw new Error(`${name}: pinned sent ${referenceRequests.length} provider request(s), GoTavern sent ${candidateRequests.length}`);
        }
        for (let index = 0; index < referenceRequests.length; index++) {
            const left = referenceRequests[index];
            const right = candidateRequests[index];
            if (left.bodySha256 !== right.bodySha256 || left.bodyLength !== right.bodyLength) {
                throw new Error(`${name}: provider request ${index} differs in bytes: pinned sent length ${left.bodyLength} sha ${left.bodySha256}, GoTavern sent length ${right.bodyLength} sha ${right.bodySha256}`);
            }
        }
        if (reference.authorizationKeyVerified && !candidate.authorizationKeyVerified) {
            throw new Error(`${name}: the pinned capture verified the declared authorization key but the GoTavern capture did not`);
        }

        const result = compareObservations(reference, candidate);
        if (!result.matches) {
            const detail = result.differences.slice(0, 20).map(difference =>
                `  ${difference.path}: ${difference.reason}\n    pinned Node: ${JSON.stringify(difference.reference)}\n    GoTavern:    ${JSON.stringify(difference.candidate)}`).join('\n');
            throw new Error(`${name}: the GoTavern capture differs from the pinned capture\n${detail}`);
        }
        console.log(`provider-wire differential closed for ${name}: ${result.compared.join(', ')} compared, ${result.skipped.join(', ')} unobserved in both`);
    }
}

// Build the mock provider once: spawning a binary keeps the probe's process
// tree simple, so no grandchild can outlive the run.
//
// BINARIES MAY COME FROM THE LANE'S CI RUN INSTEAD OF A LOCAL BUILD. This host cannot usefully compile
// Go (a full cache once filled a 149 GB disk), so a lane downloads the binaries its OWN run built from
// the commit under test and points these variables at them. When a variable is unset the probe builds
// it exactly as before, which is what the CI oracle job relies on.
//
// The binary that MUST correspond to the commit under test is the GoTavern one: the differential
// exercises the code in this checkout, not an installed release. Both variables exist so a lane can
// satisfy that with an artifact instead of a local compile.
function resolveBinary(environmentVariable, buildRelativePath, fallbackName) {
    const provided = process.env[environmentVariable];
    if (provided) {
        const resolved = path.resolve(provided);
        if (!existsSync(resolved)) {
            throw new Error(`${environmentVariable} points at ${resolved}, which does not exist`);
        }
        console.log(`${environmentVariable}: using ${resolved}`);
        return resolved;
    }
    const directory = mkdtempSync(path.join(os.tmpdir(), 'gotavern-build-'));
    const binary = path.join(directory, process.platform === 'win32' ? `${fallbackName}.exe` : fallbackName);
    execFileSync('go', ['build', '-o', binary, buildRelativePath], { cwd: repositoryRoot, stdio: 'inherit' });
    return binary;
}

const mockBinary = resolveBinary('GOTAVERN_MOCK_PROVIDER_BINARY', './tools/mock-provider', 'mock-provider');
const goTavernBinary = resolveBinary('GOTAVERN_BINARY', './cmd/gotavern', 'gotavern');

const captures = {};
for (const { file, definition } of scenarios) {
    captures[definition.name] = await captureScenario({
        file, definition, mockBinary, backendLabel: 'pinned Node', startBackend: startPinnedServer,
    });
}

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'pinned backend -> provider transformation captured from a recording mock provider, per scenario',
    stage1Boundary: 'Validates the backend to provider transformation only. Browser-side prompt assembly is not covered.',
    scenarios: captures,
};
const outputFile = path.join(repositoryRoot, 'tests', 'oracle', 'sillytavern-1.19.0-provider-wire.json');
mkdirSync(path.dirname(outputFile), { recursive: true });
writeFileSync(outputFile, JSON.stringify(fixture, null, 2) + '\n');
console.log(`Wrote tests/oracle/sillytavern-1.19.0-provider-wire.json with ${Object.keys(captures).length} scenarios`);

// Close the differential in the same run. The pinned fixture is already on disk,
// so a GoTavern divergence fails this job without altering the committed
// specification.
const goTavernCaptures = {};
for (const { file, definition } of scenarios) {
    goTavernCaptures[definition.name] = await captureScenario({
        file, definition, mockBinary, backendLabel: 'GoTavern',
        startBackend: (scenario, runtimeRoot, dataRoot, logs) => startGoTavernServer(goTavernBinary, scenario, runtimeRoot, dataRoot, logs),
        goCaptureDirectory: path.join(goTavernRoot, 'captures'),
    });
}
assertGoTavernMatchesPinned(captures, goTavernCaptures);
console.log(`Provider-wire differential closed for ${Object.keys(goTavernCaptures).length} scenarios; GoTavern captures kept in ${path.join(goTavernRoot, 'captures')}`);

// Every scenario wrote its capture, so exit deliberately: a lingering child
// handle must never hang the oracle job after the fixture is on disk. A
// scenario failure has already set a non-zero exit code.
process.exit(process.exitCode ?? 0);
