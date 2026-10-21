// Shared machinery for probing PINNED outbound routes without touching the internet.
//
// THE PROBLEM THIS SOLVES, and the constraint it must not break: the pinned server hardcodes most
// upstream URLs (`https://api.electronhub.ai/v1/models`, `https://openrouter.ai/api/v1`, ...), so
// unlike the routes that read their URL from a secret there is no seam a probe can point at a local
// mock. The project-level convention (docs/tokenizer-parity-plan.md §11) says such a route can only
// be compared in SHAPE. This module removes that limitation honestly: it replaces ONLY the pinned
// server's `node-fetch` module through a Node module-resolution hook. The pinned endpoint code runs
// unmodified; its `fetch` answers from a control file the probe rewrites between requests, and every
// outbound request the pinned code would have sent is recorded verbatim.
//
// That is the same thing a URL seam does, applied one layer lower, and the recorded outbound request
// is what lets the Go side be compared at the wire level: the Go seam defaults to the same pinned
// URL, so the constructed URL, method and headers are directly comparable.
//
// The Go side still exercises its REAL fetch path against a real local peer; this stub only stands
// in for the third party on the PINNED side, where no other option exists.
//
// An unmatched URL answers a synthesized 500 instead of delegating to the real network, so a probe
// run cannot depend on (or reach) the internet.

import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

export const PINNED_COMMIT = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
export const PINNED_VERSION = '1.19.0';

export function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

export function removeWithRetries(target) {
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

export function safeCleanup(root, prefix) {
    const resolved = path.resolve(root);
    const parent = path.resolve(os.tmpdir());
    if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()
        || !path.basename(resolved).startsWith(prefix)) {
        throw new Error(`refusing to remove unexpected oracle path: ${resolved}`);
    }
    removeWithRetries(resolved);
}

export async function choosePort() {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const port = server.address().port;
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    return port;
}

// The hook module is generated per run so the control/record paths are literals: a loader that
// needed the probe to pass state some other way would be a second layer that could silently do
// nothing.
function hookProgram({ realFetchURL, rulesPath, recordPath }) {
    return [
        `import { registerHooks } from 'node:module';`,
        `const REAL = ${JSON.stringify(realFetchURL)};`,
        `const RULES = ${JSON.stringify(rulesPath)};`,
        `const RECORD = ${JSON.stringify(recordPath)};`,
        `registerHooks({`,
        `  resolve(specifier, context, nextResolve) {`,
        `    if (specifier === 'node-fetch') return { url: 'gotavern-stub:node-fetch', shortCircuit: true };`,
        `    return nextResolve(specifier, context);`,
        `  },`,
        `  load(url, context, nextLoad) {`,
        `    if (url !== 'gotavern-stub:node-fetch') return nextLoad(url, context);`,
        `    return { format: 'module', shortCircuit: true, source: STUB };`,
        `  },`,
        `});`,
        ``,
        `const STUB = [`,
        `  'import realFetch from ' + JSON.stringify(REAL) + ';',`,
        `  "import { readFileSync, appendFileSync } from 'node:fs';",`,
        `  "import { Readable, Writable } from 'node:stream';",`,
        `  "import { createHash } from 'node:crypto';",`,
        `  'const RULES = ' + JSON.stringify(RULES) + ';',`,
        `  'const RECORD = ' + JSON.stringify(RECORD) + ';',`,
        `  "function readRules() { try { return JSON.parse(readFileSync(RULES, 'utf8')); } catch { return []; } }",`,
        `  "function lower(headers) { const out = {}; if (!headers) return out; for (const [name, value] of Object.entries(headers)) out[String(name).toLowerCase()] = String(value); return out; }",`,
        `  "async function recordBody(body) { if (body === undefined || body === null) return { body: null }; if (typeof body === 'string') return { body }; if (Buffer.isBuffer(body)) return { bodyBase64: body.toString('base64') }; if (typeof body.getBuffer === 'function') { try { const buffer = await body.getBuffer(); return { bodyBase64: buffer.toString('base64') }; } catch { /* a part is a stream */ } } if (Object.prototype.toString.call(body) === '[object FormData]' && typeof body.entries === 'function' && typeof body.pipe !== 'function') { const parts = []; for (const [name, value] of body.entries()) { if (value !== null && typeof value === 'object' && typeof value.arrayBuffer === 'function') { const buffer = Buffer.from(await value.arrayBuffer()); parts.push({ name: String(name), filename: value.name === undefined ? null : String(value.name), contentType: value.type === undefined ? null : String(value.type), bytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') }); } else { parts.push({ name: String(name), value: String(value) }); } } return { parts }; } if (typeof body.pipe === 'function') { const collected = await new Promise((resolve, reject) => { const chunks = []; const sink = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } }); sink.on('finish', () => resolve(Buffer.concat(chunks))); sink.on('error', reject); body.on('error', reject); body.pipe(sink); }); return { bodyBase64: collected.toString('base64') }; } return { body: String(body) }; }",`,
        `  "function makeResponse(rule, responseUrl) { const status = rule.status === undefined ? 200 : rule.status; const headers = rule.headers || {}; const buffer = rule.binaryBody ? Buffer.from(rule.body === undefined ? '' : rule.body, 'base64') : Buffer.from(rule.body === undefined ? '' : rule.body, 'utf8'); const text = buffer.toString('utf8'); return { ok: status >= 200 && status <= 299, status, statusText: rule.statusText === undefined ? '' : rule.statusText, url: responseUrl === undefined ? String(rule.url === undefined ? '' : rule.url) : String(responseUrl), headers: { get(name) { const key = String(name).toLowerCase(); const value = headers[key]; return value === undefined ? null : String(value); } }, text: async () => text, json: async () => JSON.parse(text), arrayBuffer: async () => buffer, body: Readable.from([buffer]) }; }",`,
        `  "const USED = new Map();",`,
        `  "function selectRule(href) { const rules = readRules(); for (let index = 0; index < rules.length; index++) { const candidate = rules[index]; if (!href.includes(candidate.match)) continue; if (candidate.times !== undefined) { const key = String(candidate.run === undefined ? '' : candidate.run) + '#' + index; const count = USED.get(key) || 0; if (count >= candidate.times) continue; USED.set(key, count + 1); } return candidate; } return null; }",`,
        `  "async function stubFetch(input, options = {}) { const href = typeof input === 'string' ? input : (input && input.href ? input.href : String(input)); const recorded = await recordBody(options.body); const headers = lower(options.headers); if (options.body && typeof options.body.getHeaders === 'function') { const extra = options.body.getHeaders(); for (const [name, value] of Object.entries(extra)) headers[String(name).toLowerCase()] = String(value); } appendFileSync(RECORD, JSON.stringify({ url: href, method: String(options.method || 'GET').toUpperCase(), headers, ...recorded }) + String.fromCharCode(10)); const rule = selectRule(href); if (!rule) return makeResponse({ status: 500, statusText: 'Stubbed', body: 'gotavern: unstubbed outbound request ' + href }, href); if (rule.throws) throw new TypeError('fetch failed'); return makeResponse(rule, href); }",
          "export default stubFetch;",
          "// Packages that call the GLOBAL fetch (the AI Horde SDK does) must reach the controlled peer too,",
          "// otherwise a probe silently hits the real service while its fixture records live data.",
          "globalThis.fetch = stubFetch;",`,
        `].join(String.fromCharCode(10));`,
        ``,
    ].join('\n');
}

// transfer-encoding is EXCLUDED even though it is a real difference: it is the framing of the body,
// not the body, and an httptest recorder can never produce it, so recording it would make the Go
// comparison assert a transport artifact instead of a response semantic.
export function stableHeaders(response) {
    return Object.fromEntries([...response.headers.entries()]
        .filter(([name]) => !['connection', 'date', 'keep-alive', 'last-modified', 'set-cookie', 'transfer-encoding', 'x-response-time'].includes(name))
        .sort(([left], [right]) => left.localeCompare(right)));
}

export async function rawRequest(url, method = 'GET', headers = {}, body, signal = null) {
    const response = await fetch(url, {
        method,
        headers: { 'Accept-Encoding': 'identity', ...headers },
        body,
        redirect: 'manual',
        signal: signal ?? AbortSignal.timeout(20000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    const text = bytes.toString('utf8');
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
    return { response, text, body: parsed, bytes };
}

export function captureHttp(result) {
    return {
        status: result.response.status,
        headers: stableHeaders(result.response),
        body: result.body,
        bodyText: result.text,
    };
}

// Binary responses (audio) cannot be recorded as text: a UTF-8 round trip through a string would
// corrupt bytes that are not valid UTF-8. The digest and length are the observation instead.
export function captureHttpBinary(result) {
    return {
        status: result.response.status,
        headers: stableHeaders(result.response),
        sha256: createHash('sha256').update(result.bytes).digest('hex'),
        bytes: result.bytes.length,
    };
}

// Parses a recorded multipart/form-data body into its parts. A boundary is random per request, so
// the raw body can never be compared; the parts (names, filenames, content types and content
// digests) are what the upstream actually observes.
export function parseMultipart(contentType, bodyBase64) {
    const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
    if (!match) throw new Error(`no multipart boundary in ${contentType}`);
    const boundary = (match[1] || match[2]).trim();
    const body = Buffer.from(bodyBase64, 'base64');
    const delimiter = Buffer.from(`--${boundary}`);
    const parts = [];
    let index = body.indexOf(delimiter);
    while (index >= 0) {
        const start = index + delimiter.length;
        if (body.slice(start, start + 2).toString() === '--') break;
        const next = body.indexOf(delimiter, start);
        if (next < 0) break;
        let chunk = body.slice(start, next);
        // Strip the CRLFs that frame each part.
        if (chunk.slice(0, 2).toString() === '\r\n') chunk = chunk.slice(2);
        if (chunk.slice(-2).toString() === '\r\n') chunk = chunk.slice(0, -2);
        const headerEnd = chunk.indexOf('\r\n\r\n');
        if (headerEnd >= 0) {
            const rawHeaders = chunk.slice(0, headerEnd).toString('utf8');
            const content = chunk.slice(headerEnd + 4);
            const headers = Object.fromEntries(rawHeaders.split('\r\n')
                .map(line => {
                    const colon = line.indexOf(':');
                    return [line.slice(0, colon).toLowerCase(), line.slice(colon + 1).trim()];
                }));
            const disposition = headers['content-disposition'] || '';
            parts.push({
                name: /name="([^"]*)"/.exec(disposition)?.[1] ?? null,
                filename: /filename="([^"]*)"/.exec(disposition)?.[1] ?? null,
                contentType: headers['content-type'] ?? null,
                sha256: createHash('sha256').update(content).digest('hex'),
                bytes: content.length,
            });
        }
        index = next;
    }
    return parts;
}

function cookiesFrom(response) {
    if (typeof response.headers.getSetCookie !== 'function') throw new Error('Node fetch does not expose getSetCookie()');
    return response.headers.getSetCookie();
}

function cookieHeader(cookies) {
    return cookies.map(cookie => cookie.split(';', 1)[0]).join('; ');
}

const CONFIG_YAML = [
    'enableUserAccounts: true',
    'skipContentCheck: true',
    // Extension loading is skipped so no startup path can make an outbound request of its own.
    'extensions:',
    '  enabled: false',
    'autoConnect: false',
    '',
].join('\n');

/**
 * Boot the pinned server with `node-fetch` replaced by a controlled peer.
 *
 * Returns helpers the probe drives:
 *   post(route, body, { headers }) -> captured response
 *   setMocks(rules)                -> rewrite the control file, so one boot can cover many cases
 *   outbound()                     -> every outbound request attempted since the last call
 *   writeSecrets(object)           -> replace the user's secrets.json
 */
// WHICH CONFIG MECHANISM TO USE, so the next reader does not reach for the wrong one:
//
//   - `startPinnedProviderServer({ config })` is for asserting a CONFIG-DRIVEN BRANCH. The override is applied
//     to the document at the SAME point the real startup writes config.yaml, BEFORE the server is spawned, so
//     the server parses it through its normal path and the scenario asserts a config the product would really
//     build. There is no mid-run mutation, so there is no shared state to restore and no ordering constraint.
//   - the handle's `writeConfig`/`restoreConfig` pair is for a DIFFERENT use case: asserting what the pinned
//     server WRITES to its config (config-init, migration, startup seeding). It cannot make a config-driven
//     BRANCH observable, because getConfigValue reads a config parsed at STARTUP and a running process never
//     re-reads the file -- measured, with the assertion failing at "actual: 1, expected: 2" messages.
//
// The merge is TEXT-LEVEL on purpose: re-serializing the whole document with our own yaml writer could
// reformat unrelated keys into something the pinned reader parses differently, which would change every
// scenario's config at once. Only the addressed key's line is touched.
function mergeConfigDocument(original, patch) {
    let text = original;
    for (const [dotted, value] of Object.entries(patch)) {
        const literal = typeof value === 'string' ? value : JSON.stringify(value);
        const [section, member] = dotted.includes('.') ? dotted.split('.', 2) : [null, dotted];
        if (section === null) {
            const pattern = new RegExp(`^${member}:.*$`, 'mu');
            text = pattern.test(text) ? text.replace(pattern, `${member}: ${literal}`) : `${text.trimEnd()}\n${member}: ${literal}\n`;
            continue;
        }
        const sectionPattern = new RegExp(`^${section}:$`, 'mu');
        if (!sectionPattern.test(text)) {
            text = `${text.trimEnd()}\n${section}:\n  ${member}: ${literal}\n`;
            continue;
        }
        const afterSection = text.slice(text.search(sectionPattern));
        const memberPattern = new RegExp(`^  ${member}:.*$`, 'mu');
        text = memberPattern.test(afterSection)
            ? text.replace(afterSection, afterSection.replace(memberPattern, `  ${member}: ${literal}`))
            : text.replace(sectionPattern, `${section}:\n  ${member}: ${literal}`);
    }
    return text;
}

export async function startPinnedProviderServer({ sourceRoot, prefix, mocks = [], config = null }) {
    const runtimeRoot = mkdtempSync(path.join(os.tmpdir(), prefix));
    const dataRoot = path.join(runtimeRoot, 'data');
    const configPath = path.join(runtimeRoot, 'config.yaml');
    const rulesPath = path.join(runtimeRoot, 'mocks.json');
    const recordPath = path.join(runtimeRoot, 'outbound.jsonl');
    const hooksPath = path.join(runtimeRoot, 'hooks.mjs');
    const logs = [];
    let child;
    let stopped = false;

    const realFetchPath = path.join(sourceRoot, 'node_modules', 'node-fetch', 'src', 'index.js');
    if (!existsSync(realFetchPath)) {
        throw new Error(`the pinned checkout has no node-fetch at ${realFetchPath}; run npm ci in it first`);
    }

    mkdirSync(path.join(dataRoot, '_storage'), { recursive: true });
    writeFileSync(path.join(dataRoot, 'cookie-secret.txt'), 'gotavern-pinned-outbound-cookie-secret');
    // The BOOT-TIME config override is applied HERE, at the same point the real startup writes config.yaml and
    // before the server is spawned, so the pinned server parses it through its normal path rather than through
    // a test-only branch. `config` is null for every existing probe, so their bytes cannot change.
    writeFileSync(configPath, config === null ? CONFIG_YAML : mergeConfigDocument(CONFIG_YAML, config));
    writeFileSync(path.join(dataRoot, '_storage', sha256('user:default-user')), JSON.stringify({
        key: 'user:default-user',
        value: {
            handle: 'default-user', name: 'Outbound Probe', created: 1700000000000,
            password: '', admin: true, enabled: true, salt: '',
            probeUnknownField: { preserve: true },
        },
    }));
    writeFileSync(rulesPath, JSON.stringify(mocks));
    writeFileSync(recordPath, '');
    writeFileSync(hooksPath, hookProgram({
        realFetchURL: pathToFileURL(realFetchPath).href,
        rulesPath,
        recordPath,
    }));

    const port = await choosePort();
    const origin = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [
        '--import', pathToFileURL(hooksPath).href,
        'server.js', '--configPath', configPath, '--dataRoot', dataRoot,
        '--listenAddressIPv4', '127.0.0.1', '--enableIPv4', 'true', '--enableIPv6', 'false',
        '--listen', 'false', '--port', String(port), '--browserLaunchEnabled', 'false', '--heartbeatInterval', '0',
    ], { cwd: sourceRoot, env: { ...process.env, NODE_ENV: 'test' }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => logs.push(chunk));
    child.stderr.on('data', chunk => logs.push(chunk));

    const userRoot = path.join(dataRoot, 'default-user');
    const secretsPath = path.join(userRoot, 'secrets.json');

    const stop = async () => {
        if (stopped) return;
        stopped = true;
        if (child && child.exitCode === null) {
            child.kill('SIGINT');
            await Promise.race([
                new Promise(resolve => child.once('exit', resolve)),
                new Promise(resolve => setTimeout(resolve, 5000)),
            ]);
            if (child.exitCode === null) child.kill();
        }
        safeCleanup(runtimeRoot, prefix);
    };

    try {
        const deadline = Date.now() + 180000;
        let lastError;
        let ready = false;
        while (Date.now() < deadline && !ready) {
            if (child.exitCode !== null) throw new Error(`pinned server exited before readiness:\n${logs.join('').slice(-12000)}`);
            try {
                const result = await rawRequest(`${origin}/login?noauto=1`);
                ready = result.response.status === 200 && result.response.headers.get('content-type')?.includes('text/html');
                if (!ready) lastError = new Error(`login returned ${result.response.status}`);
            } catch (error) {
                lastError = error;
            }
            if (!ready) await new Promise(resolve => setTimeout(resolve, 300));
        }
        if (!ready) throw new Error(`pinned server did not become ready: ${lastError?.stack ?? 'none'}\n${logs.join('').slice(-12000)}`);

        const csrf = await rawRequest(`${origin}/csrf-token`);
        const token = csrf.body.token;
        const csrfCookie = cookieHeader(cookiesFrom(csrf.response));
        const login = await rawRequest(`${origin}/api/users/login`, 'POST', {
            Cookie: csrfCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token,
        }, JSON.stringify({ handle: 'default-user', password: '' }));
        if (login.response.status !== 200) {
            throw new Error(`could not login: ${login.response.status} ${JSON.stringify(login.body)}\n${logs.join('').slice(-12000)}`);
        }
        const sessionCookie = cookieHeader(cookiesFrom(login.response));
        const jsonHeaders = { Cookie: sessionCookie, 'Content-Type': 'application/json', 'X-CSRF-Token': token };

        // The boot itself must not have reached the network; if it did, the recording would be a
        // property of the pinned startup rather than of the route under test.
        const bootOutbound = readOutbound(recordPath);
        writeFileSync(recordPath, '');

        return {
            origin,
            logs,
            bootOutbound,
            userRoot,
            uploadsRoot: path.join(dataRoot, '_uploads'),
            // A probe that must destroy the connection itself (a true client disconnect) needs the
            // authenticated headers the helper already holds.
            session: { cookie: sessionCookie, csrfToken: token },
            post: (route, body) => rawRequest(`${origin}${route}`, 'POST', jsonHeaders, body),
            // A route whose client-abort path is part of its contract needs a request the probe can
            // cancel mid-flight, so the caller supplies the signal.
            postSignal: (route, body, signal) => rawRequest(`${origin}${route}`, 'POST', jsonHeaders, body, signal),
            // A multipart request must not carry the JSON content type: fetch sets its own boundary.
            postForm: (route, form) => rawRequest(`${origin}${route}`, 'POST', {
                Cookie: sessionCookie, 'X-CSRF-Token': token,
            }, form),
            setMocks: rules => writeFileSync(rulesPath, JSON.stringify(rules)),
            outbound: () => {
                const requests = readOutbound(recordPath);
                writeFileSync(recordPath, '');
                return requests;
            },
            readSecrets: () => {
                if (!existsSync(secretsPath)) return null;
                const raw = readFileSync(secretsPath, 'utf8');
                return raw.trim() === '' ? null : JSON.parse(raw);
            },
            writeSecrets: object => {
                mkdirSync(userRoot, { recursive: true });
                writeFileSync(secretsPath, object === null ? '' : JSON.stringify(object, null, 4));
                if (object === null) rmSync(secretsPath, { force: true });
            },
            // CONFIG IS SHARED STATE ACROSS SCENARIOS. The runtime `config.yaml` is written once at boot, so a
            // scenario that changes it changes what EVERY LATER scenario's pinned server reads. These two are
            // therefore a PAIR: `writeConfig` returns the previous document and `restoreConfig` puts it back, so
            // a probe can restore in a `finally` and a throwing scenario cannot leak. A probe must ALSO assert
            // the isolation -- a later scenario observing the setting ABSENT -- because a restore that silently
            // fails looks exactly like one that worked.
            //
            // The merge is TEXT-LEVEL on purpose: re-serializing the whole document with our own yaml writer
            // could reformat unrelated keys into something the pinned reader parses differently, which would
            // change every scenario's config at once. Only the addressed key's line is touched.
            writeConfig: patch => {
                const original = readFileSync(configPath, 'utf8');
                let text = original;
                for (const [dotted, value] of Object.entries(patch)) {
                    const literal = typeof value === 'string' ? value : JSON.stringify(value);
                    const [section, member] = dotted.includes('.') ? dotted.split('.', 2) : [null, dotted];
                    if (section === null) {
                        const pattern = new RegExp(`^${member}:.*$`, 'mu');
                        text = pattern.test(text) ? text.replace(pattern, `${member}: ${literal}`) : `${text.trimEnd()}\n${member}: ${literal}\n`;
                        continue;
                    }
                    const sectionPattern = new RegExp(`^${section}:$`, 'mu');
                    if (!sectionPattern.test(text)) {
                        text = `${text.trimEnd()}\n${section}:\n  ${member}: ${literal}\n`;
                        continue;
                    }
                    const afterSection = text.slice(text.search(sectionPattern));
                    const memberPattern = new RegExp(`^  ${member}:.*$`, 'mu');
                    text = memberPattern.test(afterSection)
                        ? text.replace(afterSection, afterSection.replace(memberPattern, `  ${member}: ${literal}`))
                        : text.replace(sectionPattern, `${section}:\n  ${member}: ${literal}`);
                }
                writeFileSync(configPath, text);
                return original;
            },
            restoreConfig: original => {
                writeFileSync(configPath, original);
            },
            stop,
        };
    } catch (error) {
        await stop();
        throw error;
    }
}

function readOutbound(recordPath) {
    if (!existsSync(recordPath)) return [];
    return readFileSync(recordPath, 'utf8')
        .split('\n')
        .filter(line => line.trim() !== '')
        .map(line => JSON.parse(line));
}

/**
 * Assert that the pinned route actually reached the controlled peer. A probe that records a
 * third-party answer it never requested would otherwise look like evidence.
 */
export function assertOutbound(requests, matcher, label) {
    const found = requests.filter(request => request.url.includes(matcher));
    if (found.length === 0) {
        throw new Error(`${label}: the pinned route never requested ${matcher}; recorded ${JSON.stringify(requests.map(request => request.url))}`);
    }
    return found[found.length - 1];
}

export function writeFixture(repositoryRoot, name, fixture) {
    const outputFile = path.join(repositoryRoot, 'tests', 'oracle', name);
    mkdirSync(path.dirname(outputFile), { recursive: true });
    writeFileSync(outputFile, `${JSON.stringify(fixture, null, 2)}\n`);
    return outputFile;
}

export { appendFileSync };
