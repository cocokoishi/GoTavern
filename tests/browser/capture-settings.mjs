// Capture a USER's custom-source configuration from the pinned frontend's own panel controls.
//
// WHY IT DRIVES CONTROLS: setting `oai_settings` fields directly produced a configuration that
// declined to send on BOTH servers, which proved the configuration (not the server) was the problem.
// Driving the panel's controls lets the frontend's own handlers populate the dependent fields.
//
// PER-STEP ASSERTIONS, because the first two attempts silently captured a half-reset panel:
//   - selecting a prompt preset RESETS `chat_completion_source` to `openai` (measured twice), so the
//     preset goes first and the capture records whatever source state the frontend chose;
//   - the SOURCE is set after the preset, and the capture fails unless it actually becomes 'custom';
//   - the custom inputs only exist once the source is custom, so their presence is asserted first;
//   - the captured state must have a non-empty `custom_model`: a custom source with no model cannot
//     send, and would make any later comparison meaningless.
//
// Usage: node capture-settings.mjs --base-url http://127.0.0.1:8127

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

function argument(name, fallback) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

const baseURL = argument('--base-url', process.env.PROBE_BASE_URL ?? 'http://127.0.0.1:8127');
const outPath = path.resolve(argument('--out', path.join(here, 'fixtures', 'custom-source-settings.json')));
const CUSTOM_URL = process.env.CAPTURE_CUSTOM_URL ?? 'http://127.0.0.1:1';

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', error => consoleErrors.push(String(error.message ?? error).slice(0, 200)));
try {
    await page.goto(`${baseURL}/`);
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 120000 });

    const captured = await page.evaluate(async customUrl => {
        const script = await import('./script.js');
        const { oai_settings } = await import('./scripts/openai.js');
        await script.getCharacters();
        await script.selectCharacterById(0, { switchMenu: false });

        const steps = [];
        // Wait on the frontend's own state rather than a fixed sleep.
        const settle = async (predicate, label) => {
            for (let attempt = 0; attempt < 40; attempt++) {
                if (predicate()) {
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            return false;
        };

        // 1. Prompt preset first: selecting it resets the source, which is why the source is set last.
        const presetSelect = document.querySelector('#settings_preset_openai');
        if (!presetSelect || presetSelect.options.length === 0) {
            return { error: 'the prompt preset select is not present or empty', steps };
        }
        const presetOption = Array.from(presetSelect.options).find(candidate => candidate.value !== '');
        if (!presetOption) {
            return { error: 'the prompt preset select has no selectable option', steps };
        }
        presetSelect.value = presetOption.value;
        presetSelect.dispatchEvent(new Event('change', { bubbles: true }));
        // The handler reads the option's TEXT, not its value (openai.js:5023:
        // `$('#settings_preset_openai').find(':selected').text()`). The earlier failure reported
        // `preset_settings_openai = "Default"` because the setting had ALREADY taken the text while the
        // predicate compared the option value -- the assertion was reading the wrong thing, not the
        // frontend behaving differently.
        const presetText = (presetOption.textContent ?? '').trim();
        if (!(await settle(() => oai_settings.preset_settings_openai === presetText, 'the preset'))) {
            return { error: `the preset did not take effect (preset_settings_openai = ${JSON.stringify(oai_settings.preset_settings_openai)}, option text = ${JSON.stringify(presetText)})`, steps };
        }
        // Record the source state the preset left behind rather than assuming it is unchanged.
        steps.push({ step: 'preset', value: presetText, optionValue: presetOption.value, sourceAfterPreset: oai_settings.chat_completion_source });

        // 2. Source after the preset, and asserted.
        const sourceSelect = document.querySelector('#chat_completion_source');
        if (!sourceSelect) {
            return { error: 'the chat completion source select is not present', steps };
        }
        sourceSelect.value = 'custom';
        sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
        if (!(await settle(() => oai_settings.chat_completion_source === 'custom', 'the source'))) {
            return { error: `the source did not become custom (chat_completion_source = ${JSON.stringify(oai_settings.chat_completion_source)})`, steps };
        }
        steps.push({ step: 'source', value: oai_settings.chat_completion_source });

        // 3. The custom inputs exist only now; presence is asserted before use.
        const urlInput = document.querySelector('#custom_api_url_text');
        if (!urlInput) {
            return { error: 'the custom URL input is not present after selecting the custom source', steps };
        }
        urlInput.value = customUrl;
        urlInput.dispatchEvent(new Event('input', { bubbles: true }));
        urlInput.dispatchEvent(new Event('change', { bubbles: true }));
        if (!(await settle(() => oai_settings.custom_url === customUrl, 'the custom URL'))) {
            return { error: `the custom URL was not stored (custom_url = ${JSON.stringify(oai_settings.custom_url)})`, steps };
        }
        steps.push({ step: 'custom url', value: oai_settings.custom_url });

        const modelInput = document.querySelector('#custom_model');
        if (!modelInput) {
            return { error: 'the custom model input is not present after selecting the custom source', steps };
        }
        modelInput.value = 'probe-model';
        modelInput.dispatchEvent(new Event('input', { bubbles: true }));
        modelInput.dispatchEvent(new Event('change', { bubbles: true }));
        if (!(await settle(() => oai_settings.custom_model === 'probe-model', 'the custom model'))) {
            return { error: `the custom model was not stored (custom_model = ${JSON.stringify(oai_settings.custom_model)})`, steps };
        }
        steps.push({ step: 'custom model', value: oai_settings.custom_model });

        const keyInput = document.querySelector('#api_key_custom');
        if (keyInput) {
            keyInput.value = 'probe-synthetic-key';
            keyInput.dispatchEvent(new Event('input', { bubbles: true }));
            keyInput.dispatchEvent(new Event('change', { bubbles: true }));
            steps.push({ step: 'api key', value: 'probe-synthetic-key' });
        }

        if (String(oai_settings.custom_model ?? '').trim() === '') {
            return { error: 'the captured state has an empty custom_model, which cannot send', steps };
        }
        return {
            steps,
            chatCompletionSource: oai_settings.chat_completion_source,
            customUrl: oai_settings.custom_url,
            customModel: oai_settings.custom_model,
            preset: oai_settings.preset_settings_openai,
            oaiSettings: JSON.parse(JSON.stringify(oai_settings)),
            keys: Object.keys(oai_settings).length,
        };
    }, CUSTOM_URL);

    if (captured.error) {
        console.error(`capture FAILED: ${captured.error}`);
        console.error(JSON.stringify(captured.steps));
        process.exitCode = 1;
    } else {
        const fixture = {
            schemaVersion: 1,
            provenance: {
                capturedAt: new Date().toISOString(),
                server: baseURL,
                pinnedBaseline: 'SillyTavern 1.19.0, commit 06bde939fb1e9c4c8d8641d810f0a916b5bce127',
                uiPath: [
                    '1. #settings_preset_openai set to the first selectable preset and change dispatched; asserted preset_settings_openai took the value',
                    '2. #chat_completion_source set to custom and change dispatched; asserted chat_completion_source became custom',
                    '3. #custom_api_url_text set and input+change dispatched; asserted custom_url took the value',
                    '4. #custom_model set and input+change dispatched; asserted custom_model took the value',
                    '5. #api_key_custom set when present',
                ],
                orderingFinding: 'Selecting a prompt preset through the panel RESETS chat_completion_source to openai, measured twice, so the source must be set AFTER the preset.',
                steps: captured.steps,
                note: 'Captured from the frontend handlers with per-step assertions, not hand-assembled. Refresh by re-running capture-settings.mjs against a pinned server when the baseline moves.',
                consoleErrors,
            },
            capture: {
                chatCompletionSource: captured.chatCompletionSource,
                customUrl: captured.customUrl,
                customModel: captured.customModel,
                preset: captured.preset,
                keys: captured.keys,
                oaiSettings: captured.oaiSettings,
            },
        };
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, JSON.stringify(fixture, null, 2) + '\n');
        console.log(JSON.stringify({ out: outPath, source: captured.chatCompletionSource, model: captured.customModel, preset: captured.preset, keys: captured.keys, errors: consoleErrors.length }));
    }
} finally {
    await browser.close();
}
