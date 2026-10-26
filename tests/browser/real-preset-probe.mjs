// THE REAL-PRESET LEG (GOAL.md Q6/Q8): does a USER'S OWN complex preset change the model context, and does
// the request it produces equal pinned Node's?
//
// WHAT MAKES THIS DIFFERENT FROM capture-preset.mjs -- and why it is a second file rather than a mode of that
// one. `preset-kit.mjs` builds a SYNTHETIC preset in the page: `applyPresetKit` edits three prompts' content
// (`:409-427`) and then READS the live prompt order to assert ten identifiers are not disabled (`:431-436`).
// It never installs a prompt list and never sets an order row. A real preset is a FILE the frontend's own
// preset manager reads, so this leg LOADS it: the fixture is copied into the tree as
// `OpenAI Settings/<name>.json`, selected through `#settings_preset_openai`, and awaited through the
// frontend's own `getPresetApplicationPromise` before anything else touches the connection.
//
// THE ORDER OF OPERATIONS IS A MEASURED HAZARD, not a preference. `capture-settings.mjs:8-13` records that
// preset application completes ASYNCHRONOUSLY and, with `bind_preset_to_connection`, the completion path
// (`openai.js:5063`, from `OAI_PRESET_CHANGED_BEFORE`) OVERWRITES a connection source that was set 225 ms
// earlier. A leg that set the source first would capture a request from a different provider path than the
// one it claims to have measured.
//
// THE STRUCTURE NUMBERS ARE THE PROOF THE REAL PRESET IS IN PLAY. A cross-leg green on a default preset is
// worthless, so this leg refuses to send unless the frontend reports the fixture's own counts: 105 prompts /
// 109 order rows / 66 enabled for preset A, 119 / 115 / 39 for preset B.
//
// The peer captures and answers; it defines nothing (rule 49). The expectations live in the comparator.

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;
import { seedLegConfig } from './seed-leg-config.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = http.createServer();
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
        server.on('error', reject);
    });
}

async function waitForServer(url, deadlineMs = 120000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.ok) return true;
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${url} did not answer within ${deadlineMs} ms`);
}

// One request in, one recorded exchange out; CORS answered because the browser posts to the peer directly.
function startCapturePeer() {
    const requests = [];
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);
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
            requests.push({
                method: request.method,
                path: request.url,
                contentType: request.headers['content-type'] ?? null,
                byteLength: body.length,
                sha256: createHash('sha256').update(body).digest('hex'),
                body: body.toString('utf8'),
            });
            const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
            if (request.method === 'GET' && /models/.test(request.url ?? '')) {
                response.writeHead(200, headers);
                response.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model' }] }));
                return;
            }
            response.writeHead(200, headers);
            response.end(JSON.stringify({
                id: 'chatcmpl-preset-probe',
                object: 'chat.completion',
                created: 1730000000,
                model: 'probe-model',
                choices: [{ index: 0, message: { role: 'assistant', content: 'REAL-PRESET-REPLY' }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            requests,
            close: () => new Promise(done => server.close(done)),
        }));
    });
}

const presetPath = argumentValue('--preset');
if (!presetPath) throw new Error('--preset <fixture.json> is required');
const presetName = argumentValue('--preset-name', path.basename(presetPath, '.json'));
const expected = {
    prompts: Number(argumentValue('--expect-prompts', '0')),
    rows: Number(argumentValue('--expect-rows', '0')),
    enabled: Number(argumentValue('--expect-enabled', '0')),
};
const external = Boolean(process.env.PROBE_BASE_URL);
const dataRoot = path.resolve(argumentValue('--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-real-preset-')));
const reportPath = path.resolve(argumentValue('--report', path.join(here, `real-preset-${presetName}-leg.json`)));
const fixtureBytes = await fs.readFile(presetPath);

// THE PRESET ENTERS THE TREE THE WAY A USER'S PRESET DOES: as a file the preset manager lists.
const presetDirectory = path.join(dataRoot, 'default-user', 'OpenAI Settings');
await fs.mkdir(presetDirectory, { recursive: true });
const presetTarget = path.join(presetDirectory, `${presetName}.json`);
await fs.writeFile(presetTarget, fixtureBytes);

const port = await freePort();
let server = null;
let legConfig = null;
if (!external) {
    const binarySetting = process.env.GOTAVERN_BINARY ?? '';
    if (!binarySetting) throw new Error('GOTAVERN_BINARY is required for the GoTavern leg');
    const binary = path.resolve(binarySetting);
    await fs.cp(path.join(repoRoot, 'upstream', 'tokenizers'), path.join(dataRoot, 'tokenizers'), { recursive: true });
    legConfig = await seedLegConfig(dataRoot);
    server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
}

const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;

const report = {
    schemaVersion: 1,
    question: 'Does a real user preset change the model context, and is the provider request it produces equal on GoTavern and pinned Node?',
    subject: external ? 'pinned' : 'gotavern',
    preset: {
        name: presetName,
        file: path.basename(presetPath),
        bytes: fixtureBytes.length,
        sha256: createHash('sha256').update(fixtureBytes).digest('hex'),
        plantedAt: 'default-user/OpenAI Settings/<name>.json',
    },
    expected,
    steps: [],
    structure: null,
    connection: null,
    peerRequests: [],
    console: [],
    pageErrors: [],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
}

const peer = await startCapturePeer();
let browser;
try {
    await waitForServer(`${baseURL}/version`);
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
    page.on('console', message => report.console.push({ type: message.type(), text: String(message.text()).slice(0, 400) }));
    await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());

    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
    step('page-loaded', true);

    const ready = await page.evaluate(async () => {
        const script = await import('./script.js');
        const started = performance.now();
        while (performance.now() - started < 60000) {
            if (script.settingsReady) return true;
            const onboarding = document.querySelector('.popup .onboarding');
            if (onboarding) {
                const input = onboarding.closest('.popup')?.querySelector('.popup-input');
                if (input) {
                    input.value = 'Probe User';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                onboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
    });
    step('settings-ready', ready === true, 'script.js settingsReady');

    // 1. LOAD THE REAL PRESET through the frontend's own control, and await its own completion promise.
    const loaded = await page.evaluate(async name => {
        const openai = await import('./scripts/openai.js');
        const select = document.querySelector('#settings_preset_openai');
        if (!select) return { ok: false, reason: 'no #settings_preset_openai control' };
        const option = [...select.options].find(entry => entry.textContent?.trim() === name || entry.value === name);
        if (!option) return { ok: false, reason: `the preset manager does not list ${name}`, options: [...select.options].map(entry => entry.textContent?.trim()).slice(0, 40) };
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        // THE HAZARD: application completes asynchronously and can overwrite the connection source, so the
        // source is set AFTER this await and never before it (capture-settings.mjs:8-13, openai.js:5063).
        if (typeof openai.getPresetApplicationPromise === 'function') {
            await openai.getPresetApplicationPromise(openai.oai_settings.preset_settings_openai);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        const settings = openai.oai_settings;
        const manager = openai.promptManager;
        const order = manager?.getPromptOrderForCharacter?.(manager.activeCharacter) ?? [];
        return {
            ok: true,
            selected: settings.preset_settings_openai,
            prompts: Array.isArray(settings.prompts) ? settings.prompts.length : null,
            rows: order.length,
            enabled: order.filter(entry => entry.enabled).length,
        };
    }, presetName);
    report.structure = loaded;
    const structureOk = loaded?.ok === true
        && loaded.prompts === expected.prompts
        && loaded.rows === expected.rows
        && loaded.enabled === expected.enabled;
    step('real-preset-loaded', loaded?.ok === true, JSON.stringify(loaded));
    step('real-preset-structure', structureOk, `client reports ${loaded?.prompts}/${loaded?.rows}/${loaded?.enabled}, the fixture requires ${expected.prompts}/${expected.rows}/${expected.enabled}`);

    // 2. THE CONNECTION, after the preset has been applied, held stable for a moment.
    const peerBase = `http://127.0.0.1:${peer.port}/v1`;
    const connection = await page.evaluate(async ({ url, model }) => {
        const set = (selector, value) => {
            const control = document.querySelector(selector);
            if (!control) return false;
            control.value = value;
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        };
        const applied = {
            source: set('#chat_completion_source', 'custom'),
            url: set('#custom_api_url_text', url),
            model: set('#custom_model_id', model),
            key: set('#api_key_custom', 'probe-key'),
        };
        const openai = await import('./scripts/openai.js');
        const settings = openai.oai_settings;
        return {
            applied,
            observed: {
                source: settings.chat_completion_source ?? null,
                url: settings.custom_url ?? null,
                model: settings.custom_model ?? null,
                preset: settings.preset_settings_openai ?? null,
            },
        };
    }, { url: peerBase, model: 'probe-model' });
    report.connection = connection;
    const connected = connection?.observed?.source === 'custom'
        && String(connection?.observed?.url ?? '').includes(`127.0.0.1:${peer.port}`)
        && connection?.observed?.preset === presetName;
    step('connection-configured', connected, JSON.stringify(connection));

    // 3. ONE SEND, and the peer records what actually reached the model backend.
    if (connected && structureOk) {
        await page.evaluate(async () => {
            const textarea = document.querySelector('#send_textarea');
            const button = document.querySelector('#send_but');
            if (!textarea || !button) throw new Error('send controls missing');
            textarea.value = 'REAL_PRESET_PROBE_INPUT';
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            button.click();
        });
        const deadline = Date.now() + 60000;
        while (Date.now() < deadline && peer.requests.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 250));
        }
    }
    await new Promise(resolve => setTimeout(resolve, 1500));
    report.peerRequests = peer.requests.map(entry => ({
        method: entry.method,
        path: entry.path,
        contentType: entry.contentType,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        body: entry.body,
    }));
    step('peer-reached', report.peerRequests.length > 0, `${report.peerRequests.length} request(s)`);
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    if (browser) await browser.close();
    await peer.close();
    if (server) server.kill();
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${report.subject} leg: ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;
