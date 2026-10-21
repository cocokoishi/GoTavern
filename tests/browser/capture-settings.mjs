// Capture a USER's custom-source configuration from the pinned frontend's own panel controls.
//
// WHY IT DRIVES CONTROLS: setting `oai_settings` fields directly produced a configuration that
// declined to send on BOTH servers, which proved the configuration (not the server) was the problem.
// Driving the panel's controls lets the frontend's own handlers populate the dependent fields.
//
// PER-STEP ASSERTIONS, because earlier attempts silently captured a half-reset panel:
//   - selecting a prompt preset is ASYNCHRONOUS and, with `bind_preset_to_connection` set, it writes
//     every connection setting INCLUDING `chat_completion_source` when it completes. A stack-traced
//     probe (openai.js:5063, reached from the OAI_PRESET_CHANGED_BEFORE continuation) showed it
//     overwriting a source that had just been set to 'custom' 225ms earlier. The preset is therefore
//     awaited through the frontend's OWN completion signal, `getPresetApplicationPromise()`
//     (openai.js:5015), not through a timer and not through the setting simply appearing;
//   - the SOURCE is set after the preset and must remain 'custom' across a stable window, because
//     the source handler's own follow-ups can rewrite it;
//   - the CUSTOM URL and MODEL controls are then set through their real bindings: the model binding
//     is `custom_model: ['#custom_model_id', 'custom_model', false, true]` (openai.js:349) and its
//     event is `input` (openai.js:5620), so `#custom_model` -- which does not exist in the DOM at
//     all, and was what an earlier version of this script looked for -- is not used;
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
const CUSTOM_MODEL = process.env.CAPTURE_CUSTOM_MODEL ?? 'probe-model';

const browser = await chromium.launch();
const page = await browser.newPage();
const consoleErrors = [];
page.on('pageerror', error => consoleErrors.push(String(error.message ?? error).slice(0, 200)));
try {
    await page.goto(`${baseURL}/`);
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 120000 });

    const captured = await page.evaluate(async options => {
        const script = await import('./script.js');
        const { oai_settings, getPresetApplicationPromise } = await import('./scripts/openai.js');
        await script.getCharacters();
        await script.selectCharacterById(0, { switchMenu: false });

        const steps = [];
        // Wait on the frontend's own state rather than a fixed sleep.
        const settle = async (predicate, label, attempts = 40) => {
            for (let attempt = 0; attempt < attempts; attempt++) {
                if (predicate()) {
                    return true;
                }
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            console.warn(`capture: ${label} never became true`);
            return false;
        };
        // A value is STABLE when it is unchanged across consecutive polls spanning `windowMs`. The
        // source handler's follow-ups are asynchronous, so "true right now" is not the same as "will
        // stay true"; a capture that only checked once recorded a source that had already reverted.
        const stableValue = async (read, windowMs, attempts = 40) => {
            const seen = new Set();
            let previous = Symbol('unset');
            let unchangedFor = 0;
            const step = 100;
            for (let attempt = 0; attempt < attempts; attempt++) {
                const value = read();
                if (value === previous) {
                    unchangedFor += step;
                } else {
                    previous = value;
                    unchangedFor = 0;
                }
                seen.add(JSON.stringify(value));
                if (unchangedFor >= windowMs) {
                    return { value, seen: [...seen] };
                }
                await new Promise(resolve => setTimeout(resolve, step));
            }
            return { value: previous, seen: [...seen] };
        };

        // 1. Prompt preset first, awaited through the frontend's own promise: with
        //    bind_preset_to_connection it overwrites the connection source on completion.
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
        // `$('#settings_preset_openai').find(':selected').text()`).
        const presetText = (presetOption.textContent ?? '').trim();
        await Promise.race([
            getPresetApplicationPromise(),
            new Promise(resolve => setTimeout(resolve, 15000)),
        ]);
        if (!(await settle(() => oai_settings.preset_settings_openai === presetText, 'the preset'))) {
            return { error: `the preset did not take effect (preset_settings_openai = ${JSON.stringify(oai_settings.preset_settings_openai)}, option text = ${JSON.stringify(presetText)})`, steps };
        }
        steps.push({ step: 'preset', value: presetText, optionValue: presetOption.value, sourceAfterPreset: oai_settings.chat_completion_source, bindPresetToConnection: Boolean(oai_settings.bind_preset_to_connection) });

        // 2. Source after the preset, and asserted stable.
        const sourceSelect = document.querySelector('#chat_completion_source');
        if (!sourceSelect) {
            return { error: 'the chat completion source select is not present', steps };
        }
        sourceSelect.value = 'custom';
        sourceSelect.dispatchEvent(new Event('change', { bubbles: true }));
        const sourceStability = await stableValue(() => oai_settings.chat_completion_source, 500);
        if (sourceStability.value !== 'custom') {
            return { error: `the source did not stay custom (settled on ${JSON.stringify(sourceStability.value)}; observed ${JSON.stringify(sourceStability.seen)})`, steps };
        }
        steps.push({ step: 'source', value: oai_settings.chat_completion_source, stableFor: '500ms', observed: sourceStability.seen });

        // 3. The custom inputs exist only now; presence is asserted before use.
        const urlInput = document.querySelector('#custom_api_url_text');
        if (!urlInput) {
            return { error: 'the custom URL input is not present after selecting the custom source', steps };
        }
        urlInput.value = options.customUrl;
        urlInput.dispatchEvent(new Event('input', { bubbles: true }));
        urlInput.dispatchEvent(new Event('change', { bubbles: true }));
        if (!(await settle(() => oai_settings.custom_url === options.customUrl, 'the custom URL'))) {
            return { error: `the custom URL was not stored (custom_url = ${JSON.stringify(oai_settings.custom_url)})`, steps };
        }
        steps.push({ step: 'custom url', value: oai_settings.custom_url });

        // 4. The MODEL control is `#custom_model_id` (openai.js:349 binding) and its event is `input`
        //    (openai.js:5620). `#custom_model` is not part of the DOM.
        const modelInput = document.querySelector('#custom_model_id');
        if (!modelInput) {
            return { error: 'the custom model input (#custom_model_id) is not present after selecting the custom source', steps };
        }
        modelInput.value = options.customModel;
        modelInput.dispatchEvent(new Event('input', { bubbles: true }));
        if (!(await settle(() => oai_settings.custom_model === options.customModel, 'the custom model'))) {
            return { error: `the custom model was not stored (custom_model = ${JSON.stringify(oai_settings.custom_model)})`, steps };
        }
        steps.push({ step: 'custom model', value: oai_settings.custom_model, control: '#custom_model_id' });

        const keyInput = document.querySelector('#api_key_custom');
        if (keyInput) {
            keyInput.value = 'probe-synthetic-key';
            keyInput.dispatchEvent(new Event('input', { bubbles: true }));
            keyInput.dispatchEvent(new Event('change', { bubbles: true }));
            steps.push({ step: 'api key', value: 'probe-synthetic-key' });
        }

        // Final re-read: the whole point of the per-step assertions is that the END state is right.
        if (String(oai_settings.custom_model ?? '').trim() === '') {
            return { error: 'the captured state has an empty custom_model, which cannot send', steps };
        }
        if (oai_settings.chat_completion_source !== 'custom') {
            return { error: `the captured state does not end on the custom source (chat_completion_source = ${JSON.stringify(oai_settings.chat_completion_source)})`, steps };
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
    }, { customUrl: CUSTOM_URL, customModel: CUSTOM_MODEL });

    if (captured.error) {
        console.error(`capture FAILED: ${captured.error}`);
        console.error(JSON.stringify(captured.steps));
        process.exitCode = 1;
    } else {
        const fixture = {
            schemaVersion: 1,
            provenance: {
                // A plain re-run updates this and nothing else, which would dirty the tree on every
                // verification. CAPTURE_TIMESTAMP pins it so a determinism check can be a byte-for-byte
                // diff rather than a normalized one.
                capturedAt: process.env.CAPTURE_TIMESTAMP ?? new Date().toISOString(),
                // The port is replaced because it is chosen per run: recording it would make every
                // re-capture differ for a reason that says nothing about the frontend.
                server: baseURL.replace(/:\d+$/, ':<port>'),
                pinnedBaseline: 'SillyTavern 1.19.0, commit 06bde939fb1e9c4c8d8641d810f0a916b5bce127',
                uiPath: [
                    '1. #settings_preset_openai set to the first selectable preset and change dispatched; awaited through getPresetApplicationPromise() and asserted preset_settings_openai took the option text',
                    '2. #chat_completion_source set to custom and change dispatched; asserted chat_completion_source stayed custom across a 500ms stable window',
                    '3. #custom_api_url_text set and input+change dispatched; asserted custom_url took the value',
                    '4. #custom_model_id (the control the custom_model binding actually names) set and input dispatched; asserted custom_model took the value',
                    '5. #api_key_custom set when present',
                ],
                orderingFinding: 'Selecting a prompt preset is asynchronous and, with bind_preset_to_connection, writes chat_completion_source on completion (openai.js:5063). A source set to custom before that completion is overwritten 225ms later, which is why the preset is awaited through the frontend promise and the source is validated as STABLE rather than as momentarily correct.',
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
