// Does 酒馆助手's generation API reach a model backend, and does the request it produces equal pinned
// Node's? (GOAL.md Q9, Q11, Q12; AGENTS.md 47, 48, 49, 50.)
//
// WHY A SEPARATE DRIVE FROM helper-probe.mjs. The render leg asserts the iframe architecture and persisted
// state; this leg asserts the PROVIDER-WIRE request that the helper's own API produces. Keeping them
// apart means a red guard names one mechanism instead of two, and each leg boots with the connection it
// actually needs.
//
// WHAT IT DRIVES, measured from the pinned extension at N0VI028/JS-Slash-Runner@837a6288:
//   - `TavernHelper.generateRaw({ordered_prompts, user_input, max_chat_history, should_silence})`
//     (src/function/generate/index.ts:407, GenerateRawConfig in src/function/generate/types.ts:130). The
//     ordered prompts are set EXPLICITLY, so the captured request is a context oracle rather than
//     "whatever the frontend happened to assemble".
//   - `TavernHelper.generate({preset_name: 'in_use', injects: [...]})` (index.ts:396, GenerateConfig),
//     which is the preset path and the only place an injection depth can be observed (Q11/Q12).
// Both are called from INSIDE the extension's own script iframe, so what is captured is the request the
// helper produced through the host page, not a request this harness built.
//
// THE PEER CAPTURES AND ANSWERS; IT DOES NOT DEFINE CORRECTNESS (rule 49). The expectations asserted here
// are properties of the inputs this probe supplied - the three markers arrive, in order, with the roles
// asked for, and the injection marker arrives - plus `Node(X) == Go(X)` on the request bytes. No expected
// body is written by hand.
//
// THE CONNECTION IS DRIVEN THROUGH THE FRONTEND'S OWN CONTROLS, the same ones capture-settings.mjs
// recorded from the pinned frontend (`#chat_completion_source`, `#custom_api_url_text`,
// `#custom_model_id`, `#api_key_custom`). Both subjects serve the SAME pinned public/** (hard rule 3), so
// the controls are the same on both legs and no settings file is written by this harness.
//
// OFFLINE: the peer binds 127.0.0.1 and the only other host the page may reach is blocked - see
// helper-probe.mjs for the testingcf.jsdelivr.net decision, which this drive inherits by blocking the
// same host so an iframe head cannot stall the run.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describeInstalledExtension, ensurePinnedExtensionInstalled } from './install-pinned-extension.mjs';
import { pinnedExtension } from './pinned-extensions.mjs';
import { seedLegConfig } from './seed-leg-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

function freePort() {
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

async function waitForServer(url, deadlineMs = 90000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) return;
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${url} did not answer within ${deadlineMs} ms`);
}

// ---------------------------------------------------------------------------------------------------
// THE CAPTURE PEER. One request in, one recorded exchange out. CORS is answered because the pinned
// frontend posts to a custom endpoint from the BROWSER, not through the server's proxy: without the
// preflight reply the request would never leave the page and the leg would look like a product failure.
// ---------------------------------------------------------------------------------------------------
function startCapturePeer() {
    const requests = [];
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            const entry = {
                method: request.method,
                path: request.url,
                contentType: request.headers['content-type'] ?? null,
                authorization: request.headers.authorization ? 'present' : 'absent',
                byteLength: body.length,
                sha256: createHash('sha256').update(body).digest('hex'),
                body: body.toString('utf8'),
            };
            if (request.method === 'OPTIONS') {
                response.writeHead(204, {
                    'access-control-allow-origin': '*',
                    'access-control-allow-headers': request.headers['access-control-request-headers'] ?? '*',
                    'access-control-allow-methods': 'GET,POST,OPTIONS',
                    'access-control-max-age': '600',
                });
                response.end();
                return;
            }
            requests.push(entry);
            const headers = {
                'content-type': 'application/json',
                'access-control-allow-origin': '*',
            };
            const wantsModels = request.method === 'GET' && /models/.test(request.url ?? '');
            if (wantsModels) {
                response.writeHead(200, headers);
                response.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model' }] }));
                return;
            }
            // A completion shaped like the OpenAI chat completion the custom source expects. The content
            // is a fixed marker so a leg can prove the REPLY came back from the peer.
            response.writeHead(200, headers);
            response.end(JSON.stringify({
                id: 'chatcmpl-probe',
                object: 'chat.completion',
                created: 1730000000,
                model: 'probe-model',
                choices: [{ index: 0, message: { role: 'assistant', content: 'HELPER-GEN-REPLY' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            resolve({ port: server.address().port, requests, close: () => server.close() });
        });
    });
}

const extensionKey = 'tavern-helper';
const extension = pinnedExtension(extensionKey);
const external = Boolean(process.env.PROBE_BASE_URL);
const variant = argumentValue('--variant', 'on');
const dataRoot = path.resolve(argumentValue('--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-helper-gen-')));
const reportPath = path.resolve(argumentValue('--report', path.join(here, `helper-generation-${variant}-leg.json`)));

await fs.mkdir(dataRoot, { recursive: true });
const installed = await ensurePinnedExtensionInstalled(dataRoot, extension);
const described = await describeInstalledExtension(installed.extensionDirectory);

const MARKERS = {
    system: 'HV-SYSTEM-MARKER-2f41',
    user: 'HV-USER-MARKER-9c02',
    input: 'HV-INPUT-MARKER-7ab3',
    inject: 'HV-INJECT-MARKER-4d18',
};

const GENERATION_SCRIPT = [
    "const cfg = window.parent.__helperGenConfig;",
    "const result = { raw: null, preset: null, errors: {} };",
    "try {",
    "  const raw = await TavernHelper.generateRaw({",
    "    ordered_prompts: [{ role: 'system', content: cfg.system }, { role: 'user', content: cfg.user }],",
    "    user_input: cfg.input,",
    "    max_chat_history: 0,",
    "    should_stream: false,",
    "    should_silence: true,",
    "  });",
    "  result.raw = { type: typeof raw, preview: String(raw).slice(0, 120) };",
    "} catch (error) { result.errors.raw = String(error && error.message || error); }",
    "try {",
    "  const preset = await TavernHelper.generate({",
    "    preset_name: 'in_use',",
    "    user_input: cfg.input,",
    "    injects: [{ role: 'system', content: cfg.inject, depth: 0 }],",
    "    should_stream: false,",
    "    should_silence: true,",
    "  });",
    "  result.preset = { type: typeof preset, preview: String(preset).slice(0, 120) };",
    "} catch (error) { result.errors.preset = String(error && error.message || error); }",
    "window.__helperGeneration = result;",
].join('\n');

const port = await freePort();
let server = null;
let stagedLayout = null;
let legConfig = process.env.PROBE_LEG_CONFIG_JSON ? JSON.parse(process.env.PROBE_LEG_CONFIG_JSON) : null;
if (!external) {
    const binarySetting = process.env.GOTAVERN_BINARY ?? '';
    const binary = binarySetting ? path.resolve(binarySetting) : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
    if (!binarySetting) {
        const build = spawn('go', ['build', '-trimpath', '-o', binary, './cmd/gotavern'], { cwd: repoRoot, stdio: 'inherit' });
        if (await new Promise(resolve => build.on('exit', resolve)) !== 0) {
            throw new Error('go build ./cmd/gotavern failed');
        }
    }
    if (binarySetting) {
        await fs.copyFile(binarySetting, binary);
    }
    const tokenizerSource = path.join(repoRoot, 'upstream', 'tokenizers');
    await fs.cp(tokenizerSource, path.join(dataRoot, 'tokenizers'), { recursive: true });
    stagedLayout = { installRootIsDataRoot: true, stagedTokenizers: true, stagedPublic: false, source: binarySetting ? 'GOTAVERN_BINARY' : 'go build ./cmd/gotavern' };
    legConfig = await seedLegConfig(dataRoot);
    server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml'), '--browserLaunchEnabled', 'false'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
}

const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;

const report = {
    schemaVersion: 1,
    question: 'Does 酒馆助手\'s generateRaw/generate reach the model backend through the pinned frontend, and is the provider request it produces equal on GoTavern and pinned Node?',
    subject: external ? 'pinned' : 'gotavern',
    variant,
    baseURL,
    provenance: {
        subject: external ? 'pinned' : 'gotavern',
        layout: stagedLayout,
        configFile: legConfig,
        extension: {
            key: extensionKey,
            name: extension.name,
            repo: extension.repo,
            commit: extension.commit,
            installedRevision: installed.revision,
            installSource: installed.source ?? null,
            ...described,
        },
        connection: 'driven through the pinned frontend\'s own controls (#chat_completion_source, #custom_api_url_text, #custom_model_id, #api_key_custom); no settings file is written by this harness',
        peer: 'in-process HTTP capture peer on 127.0.0.1; records the request, answers a canned chat completion; defines nothing (rule 49)',
        browserSecurity: 'the peer answers CORS preflight because the pinned frontend posts to a custom endpoint from the browser',
    },
    markers: MARKERS,
    steps: [],
    connection: null,
    script: null,
    peerRequests: [],
    assertions: {},
    unreachableExternal: [],
    console: [],
    pageErrors: [],
    failure: null,
};

function observation(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
}

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
}

const peer = await startCapturePeer();
let browser;
let wroteReport = false;
try {
    await waitForServer(`${baseURL}/version`);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
    page.on('console', message => report.console.push({ type: message.type(), text: String(message.text()).slice(0, 400) }));
    await page.route('**://testingcf.jsdelivr.net/**', route => {
        report.unreachableExternal.push(route.request().url());
        return route.abort();
    });

    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
    step('page-loaded', true);
    report.reachedUserState = await page.evaluate(async () => {
        const script = await import('./script.js');
        const started = performance.now();
        while (performance.now() - started < 60000) {
            if (script.settingsReady) return { settingsReady: true };
            const onboarding = document.querySelector('.popup .onboarding');
            if (onboarding) {
                const nameInput = onboarding.closest('.popup')?.querySelector('.popup-input');
                if (nameInput) {
                    nameInput.value = 'Probe User';
                    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                onboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { settingsReady: false };
    });
    step('settings-ready', report.reachedUserState?.settingsReady === true, 'script.js settingsReady');

    // THE CONNECTION, through the frontend's own controls. Each control is set and its binding is read
    // back from the page's own settings object, so "the request went to my peer" cannot be satisfied by
    // a control that silently refused the value.
    const peerBase = `http://127.0.0.1:${peer.port}/v1`;
    report.connection = await page.evaluate(async config => {
        const setControl = (selector, value, eventName) => {
            const element = document.querySelector(selector);
            if (!element) return { selector, found: false };
            element.value = value;
            element.dispatchEvent(new Event(eventName, { bubbles: true }));
            return { selector, found: true, value: element.value };
        };
        const applied = [];
        applied.push(setControl('#chat_completion_source', 'custom', 'change'));
        await new Promise(resolve => setTimeout(resolve, 150));
        applied.push(setControl('#custom_api_url_text', config.url, 'input'));
        applied.push(setControl('#custom_model_id', config.model, 'input'));
        const key = document.querySelector('#api_key_custom');
        applied.push(setControl('#api_key_custom', 'probe-synthetic-key', 'input'));
        await new Promise(resolve => setTimeout(resolve, 150));
        const script = await import('./script.js');
        const settings = script.chatCompletionSettings ?? script.oai_settings ?? null;
        return {
            applied,
            apiKeyControlPresent: key !== null,
            observedSource: settings?.chat_completion_source ?? null,
            observedUrl: settings?.custom_url ?? null,
            observedModel: settings?.custom_model ?? null,
        };
    }, { url: peerBase, model: 'probe-model' });
    // A COMMITTED ARTEFACT MAY NOT CARRY A PORT (the verifier's host-derived sweep refuses it, and the
    // asset lane paid for that lesson). The peer URL is replaced with a marker; the selector names and the
    // found flags are the observation, and the comparator judges the connection from the peer's capture.
    // The controls existed and accepted the values; the PEER's capture is what the comparator judges.
    const connectionOk = (report.connection?.applied ?? []).every(item => item?.found === true);
    const redactLoopback = value => (typeof value === 'string'
        ? value.replace(/^https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?/i, '<loopback>')
        : value);
    report.connection = {
        ...report.connection,
        peerUrl: '<loopback>/v1',
        observedUrl: redactLoopback(report.connection?.observedUrl),
        applied: (report.connection?.applied ?? []).map(item => ({ ...item, value: redactLoopback(item?.value) })),
    };
    report.connectionOk = connectionOk;
    // The page's settings object is NOT the oracle: script.js does not export it under the name this
    // harness guessed, which is why 40217283368 read observedSource=null while the peer DID receive the
    // request. The controls and their accepted values are recorded here; the comparator judges the peer.
    observation('connection-controls-applied', connectionOk, JSON.stringify(report.connection));

    await page.waitForSelector('#rm_print_characters_block .avatar[data-type="character"]', { timeout: 60000 }).catch(() => null);
    const clicked = await page.click('#rm_print_characters_block .avatar[data-type="character"]', { timeout: 30000 }).then(() => true, () => false);
    const messageArrived = await page.waitForSelector('#chat .mes', { timeout: 60000 }).then(() => true, () => false);
    step('chat-open', clicked || messageArrived, `click=${clicked} chatAlreadyOpen=${messageArrived}`);

    await page.evaluate(config => {
        window.__helperGenConfig = config;
    }, MARKERS);

    if (variant === 'on') {
        await page.evaluate(script => {
            window.TavernHelper.replaceScriptTrees([{
                type: 'script',
                enabled: true,
                name: 'gotavern-generation-script',
                id: 'gotavern-generation-script',
                content: script.content,
                button: { enabled: true, buttons: [{ name: 'generate', visible: true }] },
            }], { type: 'global' });
        }, { content: GENERATION_SCRIPT });
        step('script-enabled', true);

        const deadline = Date.now() + 90000;
        let observed = null;
        while (Date.now() < deadline) {
            observed = await page.evaluate(() => {
                const frames = Array.from(document.querySelectorAll('iframe'));
                const frame = frames.find(item => {
                    try {
                        return Boolean(item.contentWindow?.__helperGeneration);
                    } catch {
                        return false;
                    }
                });
                return frame ? frame.contentWindow.__helperGeneration : null;
            });
            if (observed) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        report.script = observed;
        step('script-completed', observed !== null, observed === null ? 'no __helperGeneration on any iframe (the module may still be awaiting a response)' : null);
    } else {
        report.steps.push({ name: 'script-enabled', ok: null, detail: 'variant off: no generation script is installed' });
        report.steps.push({ name: 'script-completed', ok: null, detail: 'variant off' });
        // Give the page the same window in which an installed script would have fired.
        await new Promise(resolve => setTimeout(resolve, 5000));
    }

    // THE PROVIDER-WIRE OBSERVATION. Parsed here so the comparator can assert ORDER and ROLES without
    // re-implementing the parse, and so a body that is not JSON is named rather than silently ignored.
    report.peerRequests = peer.requests.map(entry => {
        let parsed = null;
        try {
            parsed = JSON.parse(entry.body);
        } catch {
            parsed = null;
        }
        return {
            method: entry.method,
            path: entry.path,
            contentType: entry.contentType,
            authorization: entry.authorization,
            byteLength: entry.byteLength,
            sha256: entry.sha256,
            model: parsed?.model ?? null,
            stream: parsed?.stream ?? null,
            messages: Array.isArray(parsed?.messages)
                ? parsed.messages.map(message => ({ role: message.role ?? null, content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? null) }))
                : null,
            body: entry.body.slice(0, 6000),
        };
    });

    const completions = report.peerRequests.filter(entry => /\/chat\/completions$/.test(entry.path ?? ''));
    report.assertions = {
        completionRequestCount: completions.length,
        rawRequest: completions[0] ? { sha256: completions[0].sha256, byteLength: completions[0].byteLength, model: completions[0].model, stream: completions[0].stream, messages: completions[0].messages } : null,
        presetRequest: completions[1] ? { sha256: completions[1].sha256, byteLength: completions[1].byteLength, model: completions[1].model, stream: completions[1].stream, messages: completions[1].messages } : null,
        markersPresent: null,
        injectionPresent: null,
    };
    const rawMessages = report.assertions.rawRequest?.messages ?? [];
    const rawIndex = marker => rawMessages.findIndex(message => message.content.includes(marker));
    report.assertions.markersPresent = {
        system: rawIndex(MARKERS.system),
        user: rawIndex(MARKERS.user),
        input: rawIndex(MARKERS.input),
        ordered: rawIndex(MARKERS.system) !== -1
            && rawIndex(MARKERS.system) < rawIndex(MARKERS.user)
            && rawIndex(MARKERS.user) < rawIndex(MARKERS.input),
        roles: rawMessages.filter(message => [MARKERS.system, MARKERS.user, MARKERS.input].some(marker => message.content.includes(marker))).map(message => message.role),
    };
    const presetMessages = report.assertions.presetRequest?.messages ?? [];
    report.assertions.injectionPresent = presetMessages.some(message => message.content.includes(MARKERS.inject));

    if (variant === 'on') {
        step('peer-reached', completions.length >= 2, `${completions.length} chat/completions request(s) arrived at the peer`);
        step('ordered-prompts', report.assertions.markersPresent.ordered === true, JSON.stringify(report.assertions.markersPresent));
        step('injection-visible', report.assertions.injectionPresent === true, 'the generate() request carried the injection marker');
    } else {
        // The off leg's evidence is the ABSENCE of a provider request: that is what makes the
        // on-vs-off comparison discriminating.
        step('peer-silent-with-helper-off', completions.length === 0, `${completions.length} chat/completions request(s) arrived with no generation script installed`);
        report.steps.push({ name: 'ordered-prompts', ok: null, detail: 'variant off' });
        report.steps.push({ name: 'injection-visible', ok: null, detail: 'variant off' });
    }
} catch (error) {
    report.failure = report.failure ?? String(error?.message ?? error);
} finally {
    if (browser) await browser.close();
    server?.kill();
    peer.close();
}

try {
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    wroteReport = true;
} catch (writeError) {
    console.error(`could not write ${reportPath}: ${writeError && writeError.message || writeError}`);
}

console.log(JSON.stringify({
    subject: report.subject,
    variant: report.variant,
    failure: report.failure,
    connection: report.connection ? { source: report.connection.observedSource, url: report.connection.observedUrl, model: report.connection.observedModel } : null,
    script: report.script,
    completionRequests: report.assertions?.completionRequestCount ?? 0,
    rawSha256: report.assertions?.rawRequest?.sha256 ?? null,
    rawMarkerOrder: report.assertions?.markersPresent ?? null,
    injectionPresent: report.assertions?.injectionPresent ?? null,
    steps: report.steps.map(item => `${item.ok === null ? 'n/a' : item.ok ? 'ok' : 'FAIL'} ${item.name}`),
}, null, 2));
// The probe RECORDS; the comparator JUDGES (see helper-probe.mjs for the run that taught this).
if (!wroteReport) process.exitCode = 1;
