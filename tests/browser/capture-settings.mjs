// Capture a USER's custom-source configuration from the pinned frontend, rather than assembling
// fields by hand.
//
// The earlier drive set three `oai_settings` fields directly and the frontend declined to send — on
// BOTH servers, which proved the configuration was the problem and not GoTavern. This script drives
// the panel's own controls instead: it sets the DOM inputs a user touches and dispatches the events
// the frontend itself listens to, so its own handlers populate every dependent field. Then it records
// the resulting `oai_settings` as a fixture with provenance, so a future drive starts from a state
// that is by construction a user's and can be refreshed when the baseline moves.
//
// Usage: node capture-settings.mjs [--base-url http://127.0.0.1:8127] [--out <path>]

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

function argument(name, fallback) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

const baseURL = argument('--base-url', process.env.PROBE_BASE_URL ?? 'http://127.0.0.1:8127');
const outPath = path.resolve(argument('--out', path.join(here, 'fixtures', 'custom-source-settings.json')));

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', error => consoleErrors.push(String(error.message ?? error).slice(0, 200)));
try {
    await page.goto(`${baseURL}/`);
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 120000 });

    const captured = await page.evaluate(async () => {
        const script = await import('./script.js');
        const { oai_settings } = await import('./scripts/openai.js');
        await script.getCharacters();
        await script.selectCharacterById(0, { switchMenu: false });

        // Drive the controls a user touches. The frontend listens for these events and its own
        // handlers fill the dependent fields (include-body flags, custom prompt handling and so on);
        // nothing here assigns oai_settings directly.
        const sourceSelect = document.querySelector('#chat_completion_source');
        if (!sourceSelect) {
            return { error: 'the chat completion source select is not present' };
        }
        sourceSelect.value = 'custom';
        sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));

        const urlInput = document.querySelector('#custom_api_url_text');
        if (urlInput) {
            urlInput.value = 'http://127.0.0.1:1';
            urlInput.dispatchEvent(new Event('input', { bubbles: true }));
            urlInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const keyInput = document.querySelector('#api_key_custom');
        if (keyInput) {
            keyInput.value = 'probe-synthetic-key';
            keyInput.dispatchEvent(new Event('input', { bubbles: true }));
            keyInput.dispatchEvent(new Event('change', { bubbles: true }));
        }
        // Give the frontend's change handlers a moment to run.
        await new Promise(resolve => setTimeout(resolve, 1500));
        return {
            chatCompletionSource: oai_settings.chat_completion_source,
            customUrl: oai_settings.custom_url,
            oaiSettings: JSON.parse(JSON.stringify(oai_settings)),
            keys: Object.keys(oai_settings).length,
        };
    });

    const fixture = {
        schemaVersion: 1,
        provenance: {
            capturedAt: new Date().toISOString(),
            server: baseURL,
            pinnedBaseline: 'SillyTavern 1.19.0, commit 06bde939fb1e9c4c8d8641d810f0a916b5bce127',
            uiPath: [
                '#chat_completion_source set to "custom" and dispatched change (the AI Response Configuration panel control)',
                '#custom_api_url_text set and dispatched input+change',
                '#api_key_custom set and dispatched input+change',
                'frontend handlers then populate the dependent oai_settings fields',
            ],
            note: 'Captured from the frontend handlers, not hand-assembled. Refresh by re-running capture-settings.mjs against a pinned server when the baseline moves.',
            consoleErrors,
        },
        capture: captured,
    };
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, JSON.stringify(fixture, null, 2) + '\n');
    console.log(JSON.stringify({ out: outPath, source: captured.chatCompletionSource, keys: captured.keys, errors: consoleErrors.length }));
} finally {
    await browser.close();
}
