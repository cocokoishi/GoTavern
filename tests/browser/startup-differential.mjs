#!/usr/bin/env node
// Startup differential drive: boot the real pinned frontend against ONE server (GoTavern by default,
// or any server via PROBE_BASE_URL), drive it to a REAL user state, and record every same-origin
// request plus the final page state as JSON. Two runs per leg are used by compare-startup-legs.mjs to
// separate deterministic response bodies from bodies that vary by nature (timestamps, ids, tokens).
//
// DRIVER FAITHFULNESS (rule 10): a freshly seeded data root has settings.firstRun, so the server-side
// settings load awaits the onboarding popup; settingsReady never turns true until a user completes it.
// This drive completes onboarding, selects the API the way a user does (#main_api), and presses
// Connect — the three things the generation probe found were needed before the page was in a state a
// real user could act from. `reachedUserState` in the report asserts each of them.
//
// WHY THIS FILE EXISTS SEPARATELY: startup-calls.mjs enumerates and classifies calls on the GoTavern
// leg only and writes a markdown report. This produces machine-readable JSON on BOTH legs so the
// browser-events/final-state surface can be compared. It does NOT have the generation probe's fetch
// wrapper (and therefore not its unconditional `clone().text()` buffering defect): body digests are
// read through Playwright's response object, never by replacing the page's fetch.
//
// Usage: node startup-differential.mjs --report <path>
//        PROBE_BASE_URL=http://127.0.0.1:8000 node startup-differential.mjs --report <path>   (pinned leg)

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

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

async function waitForServer(url, deadlineMs = 60000) {
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
        try {
            const response = await fetch(url);
            if (response.status < 500) {
                return;
            }
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`${url} did not answer`);
}

const external = Boolean(process.env.PROBE_BASE_URL);
const port = await freePort();
const dataRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-startup-diff-'));
const binarySetting = process.env.GOTAVERN_BINARY ?? '';
const binary = binarySetting ? path.resolve(binarySetting) : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
let server = null;
let origin = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;

if (!external) {
    if (!binarySetting) {
        const build = spawn('go', ['build', '-trimpath', '-o', binary, './cmd/gotavern'], { cwd: repoRoot, stdio: 'inherit' });
        if (await new Promise(resolve => build.on('exit', resolve)) !== 0) {
            throw new Error('go build failed');
        }
    }
    // RELEASE LAYOUT (tokenizers only). `gotavern start` uses the executable's directory as
    // InstallRoot and tokenizer routes need `<InstallRoot>/tokenizers`; a release ships that beside
    // the binary. Staging `public/` is NOT equivalent to a release layout: the vendored
    // `upstream/public` is the pinned SOURCE tree, while a release installs the generated public
    // bundle, and serving the source index.html makes bare module imports fail (measured: the page
    // threw "Failed to resolve module specifier lodash" and never reached settings). Static/extension
    // asset gaps are therefore recorded as observed, against the known list in
    // docs/frontend-startup-calls.md, rather than papered over with the wrong tree.
    const tokenizerSource = path.join(repoRoot, 'upstream', 'tokenizers');
    // THE RELEASE LAYOUT IS `src/tokenizers`, the pinned SillyTavern layout: upstream reads the tree as
    // `src/tokenizers/...` (src/endpoints/tokenizers.js:251-254) and the runtime prefers that path.
    const tokenizerTarget = path.join(dataRoot, 'src', 'tokenizers');
    if (await fs.stat(tokenizerSource).then(() => true, () => false)) {
        await fs.mkdir(path.join(dataRoot, 'src'), { recursive: true });
        await fs.cp(tokenizerSource, tokenizerTarget, { recursive: true });
    } else {
        throw new Error(`tokenizer assets missing at ${tokenizerSource}; a release layout must stage them at <install root>/src/tokenizers`);
    }    // Extension assets: a release ships the built-in extensions under
    // `<InstallRoot>/public/scripts/extensions`. The vendored `upstream/public` cannot be staged whole
    // (its source index.html needs the generated bundle), but the extension SUBTREE is exactly what
    // `/api/extensions/discover` scans and what the frontend then loads. Staging only that subtree
    // keeps the served index.html on the embedded generated bundle while making extension discovery
    // faithful to a release install.
    const extensionSource = path.join(repoRoot, 'upstream', 'public', 'scripts', 'extensions');
    const extensionTarget = path.join(dataRoot, 'public', 'scripts', 'extensions');
    if (await fs.stat(extensionSource).then(() => true, () => false)) {
        await fs.cp(extensionSource, extensionTarget, { recursive: true });
    }    server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
}

const report = {
    schemaVersion: 1,
    question: 'does the pinned frontend make the same startup requests and reach the same final page state on GoTavern and pinned?',
    provenance: { subject: external ? 'pinned' : 'gotavern', external, baseURL: origin },
    reachedUserState: null,
    requests: [],
    finalState: null,
    pageErrors: [],
    consoleErrors: [],
    failure: null,
};

let browser;
try {
    await waitForServer(`${origin}/version`);
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error.message ?? error).slice(0, 300)));
    page.on('console', message => {
        if (message.type() === 'error') {
            report.consoleErrors.push(String(message.text()).slice(0, 300));
        }
    });
    const pending = new Map();
    page.on('request', request => {
        const url = new URL(request.url());
        if (url.origin !== origin) return;
        const entry = {
            method: request.method(),
            path: url.pathname + url.search,
            resourceType: request.resourceType(),
            status: null,
            contentType: '',
            bodySha256: null,
            bodyLength: null,
        };
        pending.set(request, entry);
        report.requests.push(entry);
    });
    page.on('response', async response => {
        const entry = pending.get(response.request());
        if (!entry) return;
        entry.status = response.status();
        entry.contentType = response.headers()['content-type'] ?? '';
        try {
            const bytes = await response.body();
            entry.bodyLength = bytes.length;
            entry.bodySha256 = createHash('sha256').update(bytes).digest('hex');
        } catch {
            entry.bodyLength = null;
            entry.bodySha256 = null;
        }
    });

    await page.goto(origin + '/');
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 90000 });

    const drive = await page.evaluate(async () => {
        const result = { onboardingCompleted: false, settingsReady: false, connectClicked: false, settingsReadyWaitMs: null, selectedMainApi: null };
        const script = await import('./script.js');
        const startedWaiting = performance.now();
        // FIRST-RUN ONBOARDING: getSettings() awaits this popup, and settingsReady stays false until a
        // user completes it (script.js:8041). The popup appears only once settings load is under way,
        // so WAIT for it (or for settingsReady) instead of sampling once immediately after the
        // preloader disappears: an immediate sample flaked once and made the drive look unfaithful.
        while (performance.now() - startedWaiting < 15000) {
            if (script.settingsReady) {
                break;
            }
            const onboarding = document.querySelector('.popup .onboarding');
            if (onboarding) {
                result.onboardingCompleted = true;
                const nameInput = onboarding.closest('.popup')?.querySelector('.popup-input');
                if (nameInput) {
                    nameInput.value = 'Probe User';
                    nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                }
                onboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        while (performance.now() - startedWaiting < 60000) {
            if (script.settingsReady) {
                result.settingsReady = true;
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        result.settingsReadyWaitMs = Math.round(performance.now() - startedWaiting);
        if (!result.settingsReady) {
            return result;
        }
        // A user selects the API through the control, not by assigning the module variable.
        const mainApiSelect = document.querySelector('#main_api');
        if (mainApiSelect) {
            mainApiSelect.value = 'openai';
            mainApiSelect.dispatchEvent(new Event('change', { bubbles: true }));
            result.selectedMainApi = 'openai';
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        const { oai_settings } = await import('./scripts/openai.js');
        const secretsModule = await import('./scripts/secrets.js');
        await secretsModule.writeSecret(secretsModule.SECRET_KEYS.CUSTOM, 'probe-synthetic-key');
        oai_settings.chat_completion_source = 'custom';
        // Closed port ON PURPOSE: the Connect status route must still answer (both legs answer the
        // pinned error envelope), and no real provider is contacted.
        oai_settings.custom_url = 'http://127.0.0.1:1';
        oai_settings.custom_model = 'probe-model';
        oai_settings.stream_openai = false;
        const connectButton = document.querySelector('#api_button_openai');
        if (connectButton) {
            result.connectClicked = true;
            connectButton.click();
            await new Promise(resolve => setTimeout(resolve, 2500));
        }
        return result;
    });
    report.reachedUserState = drive;

    // Let late startup calls settle before the final state is read. Measured: a 1.5 s settle left
    // POST /api/backgrounds/all and /api/chats/recent with no response recorded in one run, which is a
    // capture-ordering artefact, not a server difference.
    await new Promise(resolve => setTimeout(resolve, 4000));

    const connectStatusRequestObserved = report.requests.some(entry => entry.path.startsWith('/api/backends/chat-completions/status'));
    report.reachedUserState.connectStatusRequestObserved = connectStatusRequestObserved;

    report.finalState = await page.evaluate(async () => {
        const script = await import('./script.js');
        return {
            settingsReady: Boolean(script.settingsReady),
            onlineStatus: String(script.online_status),
            characterRows: document.querySelectorAll('#rm_print_characters_block .character_select, #rm_print_characters_block .character').length,
            mainApiValue: document.querySelector('#main_api')?.value ?? null,
            sendButtonPresent: Boolean(document.querySelector('#send_but')),
            sendButtonDisabled: Boolean(document.querySelector('#send_but')?.disabled),
            topBarPresent: Boolean(document.querySelector('.drawer-icon')),
            apiPanelPresent: Boolean(document.querySelector('#rm_api_block')),
            toastr: (document.querySelector('#toast-container')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
            bodyGenerating: document.body.dataset.generating ?? null,
            title: document.title,
            extensionPanels: document.querySelectorAll('#extensions_settings2 .extension_container, #extensions_settings .extension_container').length,
            promptManagerPresent: Boolean(document.querySelector('#completion_prompt_manager')),
            characterListPresent: Boolean(document.querySelector('#rm_print_characters_block')),
            quickReplyPresent: Boolean(document.querySelector('#quick_reply_bar')),
        };
    });

    if (!report.reachedUserState.settingsReady) {
        report.failure = 'settingsReady never became true: the page is not in a state a user can act from';
    } else if (!report.reachedUserState.connectStatusRequestObserved) {
        report.failure = 'Connect was clicked but no /api/backends/chat-completions/status request was observed: the drive did not reach the user action under test';
    }
} catch (error) {
    report.failure = String(error.message ?? error);
} finally {
    if (browser) {
        await browser.close();
    }
    server?.kill();
    if (process.env.GOTAVERN_KEEP_TEMP !== '1') {
        await new Promise(resolve => setTimeout(resolve, 300));
        await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(() => {});
    }
}

const reportPath = path.resolve(process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : path.join(repoRoot, 'tests', 'browser', 'startup-differential-report.json'));
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ subject: report.provenance.subject, failure: report.failure, requests: report.requests.length, settingsReady: report.reachedUserState?.settingsReady, connectStatus: report.reachedUserState?.connectStatusRequestObserved }, null, 2));
