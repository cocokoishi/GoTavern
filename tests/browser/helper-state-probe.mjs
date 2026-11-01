// SECOND-ORDER HELPER STATE SEMANTICS: variables by scope, preset mutation, lifecycle events and the
// iframe->bridge->host->disk->provider closure, driven in a real browser against the unmodified frontend with
// the pinned 酒馆助手 / JS-Slash-Runner installed, on BOTH subjects (GoTavern and pinned Node).
//
// WHAT THE EXISTING LEGS ALREADY PROVE, so this leg does not re-prove it:
//   * helper-probe.mjs            iframe runs a script, reads/writes a CHAT variable, renders a message;
//   * helper-generation-probe.mjs generate/generateRaw via the extension, injections at depth;
//   * helper-vars-generate-probe  chat + global variables reach the FINAL provider request, survive reload and
//                                 restart; message scope stored-not-surfaced (Q10/Q11);
//   * helper-vars-probe.mjs       the UI-select vehicle for the preset scope.
//
// WHAT THIS LEG ADDS (GOAL Q9/Q10/Q11/Q12/Q19; AGENTS 15/47/48/49/50):
//   1. VARIABLES second-order: character, preset and script (temporary) scopes beside chat/global; object,
//      list, simultaneous-mutation and deletion semantics; then the same values read from a NEW iframe after
//      a page reload, a SERVER RESTART, a CHAT SWITCH, a CHARACTER SWITCH and a PRESET SWITCH.
//   2. PRESET MUTATION (Q12): the helper changes the IN-USE preset (adds a prompt, changes a sampler), the
//      NEXT generation's exact provider request must carry the change, and a restore must remove it.
//   3. EVENTS (Q19): message/generation/preset/chat lifecycle events, their ORDER, and the state visible AT
//      event time, registered through the iframe bridge.
//   4. CLOSURE: every one of the above is executed by a script running INSIDE the extension's script iframe
//      (`replaceScriptTrees`), so the observed mutations travelled iframe -> bridge -> host API -> store ->
//      disk -> the next provider request. The report records `closure.insideIframe` and the bridge functions
//      the script actually used; "the iframe loaded" is never a claim.
//
// NON-CLAIMS, stated as fields: the provider is a simulated peer (rule 22); streaming/cancellation and the
// `extension` variable scope are not driven here; the character SWITCH uses a synthetic second card, not a
// user's real second character.
//
// Usage (GoTavern leg):  GOTAVERN_BINARY=... node helper-state-probe.mjs --data-root <tree> --report <json>
//                        [--variant on|off] [--after-restart]
// Usage (pinned leg):    node run-against-pinned.mjs helper-state-probe.mjs -- --data-root <tree> --report <json>

import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { describeInstalledExtension, ensurePinnedExtensionInstalled } from './install-pinned-extension.mjs';
import { pinnedExtension } from './pinned-extensions.mjs';
import { seedLegConfig } from './seed-leg-config.mjs';
import { readHelperApiSurface, PROBE_CARD, PINNED_BASELINE_COMMIT, readPresetStance, RESOLVE_IDENTIFIER } from './extensions/helper-vars-kit.mjs';
import {
    HELPERS, PRESET_A, PRESET_B, STATE_MARKERS, readCardVariables, readChatMetadataVariables, readPresetDocument,
    readSettingsGlobalVariables, stageChats, stageSecondCard, stageValidCard, waitForDisk, writeStatePresets,
} from './extensions/helper-state-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const SCRIPT_PATH = path.join(here, 'extensions', 'helper-state-script.js');
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

const argumentValue = (name, fallback = null) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
};
const flag = name => process.argv.includes(name);

const dataRoot = path.resolve(argumentValue('--data-root') ?? '');
const reportPath = path.resolve(argumentValue('--report') ?? 'helper-state-report.json');
const variant = argumentValue('--variant', 'on');
const afterRestart = flag('--after-restart');
const externalURL = process.env.PROBE_BASE_URL ?? null;
if (!argumentValue('--data-root')) {
    console.error('usage: node helper-state-probe.mjs --data-root <tree> --report <json> [--variant on|off] [--after-restart]');
    process.exit(2);
}
const nonce = argumentValue('--nonce') ?? createHash('sha256').update(`${dataRoot}:${process.pid}:${Date.now()}`).digest('hex').slice(0, 10);
const markers = Object.fromEntries(Object.entries(STATE_MARKERS).map(([key, value]) => [key, value]));

const report = {
    schemaVersion: 1,
    question: 'Does a second-order helper state mutation (scoped variable, preset mutation, event) travel the iframe->bridge->host->disk path and reach the NEXT provider request identically on GoTavern and pinned Node, and survive reload/restart/switch?',
    leg: externalURL ? 'pinned' : 'gotavern',
    variant,
    afterRestart,
    nonce,
    markers,
    pinnedBaselineCommit: PINNED_BASELINE_COMMIT,
    steps: [],
    phases: {},
    pageErrors: [],
    consoleErrors: [],
    network: [],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    console.error(`[hse] ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`.slice(0, 900)}`);
    if (!ok && !report.failure) report.failure = `${name}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
    return ok;
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

// THE CAPTURE PEER. Records every chat-completion request (target, sha256, raw body) and answers a canned
// completion. It DEFINES NOTHING (rule 49): the expected request comes from the pinned leg's capture.
function startCapturePeer() {
    const requests = [];
    let reply = 0;
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            const text = body.toString('utf8');
            if (request.method !== 'POST') {
                response.writeHead(404, { 'content-type': 'application/json' });
                response.end('{}');
                return;
            }
            requests.push({
                method: request.method,
                target: request.url,
                sha256: createHash('sha256').update(body).digest('hex'),
                byteLength: body.length,
                body: text,
            });
            reply += 1;
            const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
            if (request.method === 'OPTIONS') {
                response.writeHead(204, headers);
                response.end();
                return;
            }
            response.writeHead(200, headers);
            response.end(JSON.stringify({
                id: `chatcmpl-hse-${reply}`,
                object: 'chat.completion',
                created: 1730000000,
                model: 'probe-model',
                choices: [{ index: 0, message: { role: 'assistant', content: `HS-PEER-REPLY-${reply}` }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            get requests() { return requests; },
            close: () => new Promise(done => server.close(done)),
        }));
    });
}

function binaryPath() {
    const setting = process.env.GOTAVERN_BINARY;
    if (!setting) throw new Error('GOTAVERN_BINARY is required for the GoTavern leg');
    return path.resolve(setting);
}

async function bootGoTavern(root) {
    const port = await freePort();
    const server = spawn(binaryPath(), ['start', '--port', String(port), '--dataRoot', root, '--configPath', path.join(root, 'config.yaml'), '--browserLaunchEnabled', 'false'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const log = [];
    server.stdout.on('data', chunk => { if (log.length < 200) log.push(String(chunk).slice(0, 400)); });
    server.stderr.on('data', chunk => { if (log.length < 200) log.push(String(chunk).slice(0, 400)); });
    return { server, baseURL: `http://127.0.0.1:${port}`, log };
}

async function main() {
    let browser = null;
    let peer = null;
    let gotavern = null;
    const baseURL = externalURL ?? null;
    try {
        // ---- fixture and pinned extension ---------------------------------------------------------------
        const install = await ensurePinnedExtensionInstalled(dataRoot, pinnedExtension('tavern-helper'));
        const apiSurface = await readHelperApiSurface(install, install.extensionDirectory);
        report.provenance = {
            extension: { ...describeInstalledExtension(install.extensionDirectory), revision: install.revision, source: install.source, remote: install.remote, expectedCommit: pinnedExtension('tavern-helper').commit },
            apiSurface,
            pinnedBaselineCommit: PINNED_BASELINE_COMMIT,
            variant,
            afterRestart,
        };
        step('extension-is-the-pin', apiSurface.pinned === true && apiSurface.reasons.length === 0,
            { pinned: apiSurface.pinned, reasons: apiSurface.reasons });
        if (apiSurface.pinned !== true) throw new Error(`refusing to measure a helper that is not the pin: ${apiSurface.reasons.join('; ')}`);

        if (!afterRestart) {
            const card = await stageValidCard(dataRoot);
            const secondCard = await stageSecondCard(dataRoot);
            const chats = await stageChats(dataRoot, { primaryAvatar: PROBE_CARD.fileName, secondaryAvatar: HELPERS.name });
            const presets = await writeStatePresets(dataRoot, { nonce });
            const stagedPresets = await readPresetStance(dataRoot, [PRESET_A, PRESET_B]);
            const stagedIdentity = presetName => String(stagedPresets?.[presetName]?.promptContents?.[RESOLVE_IDENTIFIER] ?? '');
            report.fixture = { card, secondCard, chats, presets, stagedPresets };
            // THE FIXTURE'S MISSING IDENTIFIERS ARE EXPECTED (the committed derivation has no placeholder
            // prompts); what must be true is the derived identity prompt EXISTS ON DISK with the content this
            // leg's generation reads. Asserting `missingIdentifiers.length === 0` would red a correct fixture.
            step('fixture-staged',
                stagedPresets?.[PRESET_A]?.present === true && stagedPresets?.[PRESET_B]?.present === true
                && stagedIdentity(PRESET_A) === presets.presets[PRESET_A].identity
                && stagedIdentity(PRESET_B) === presets.presets[PRESET_B].identity,
                {
                    presentA: stagedPresets?.[PRESET_A]?.present ?? null,
                    presentB: stagedPresets?.[PRESET_B]?.present ?? null,
                    identityA: stagedIdentity(PRESET_A) || null,
                    identityB: stagedIdentity(PRESET_B) || null,
                    missingA: presets.presets[PRESET_A].missingIdentifiers,
                    missingB: presets.presets[PRESET_B].missingIdentifiers,
                });
        } else {
            report.fixture = { reused: true };
        }

        if (!baseURL) {
            await seedLegConfig(dataRoot);
            gotavern = await bootGoTavern(dataRoot);
            await waitForServer(`${gotavern.baseURL}/version`);
        }
        const origin = baseURL ?? gotavern.baseURL;
        report.provenance.serverEpoch = createHash('sha256').update(`server:${origin}`).digest('hex').slice(0, 16);
        report.provenance.serverVersion = await fetch(`${origin}/version`).then(response => response.json(), () => null);
        step('server-ready', true, { epoch: report.provenance.serverEpoch });

        peer = await startCapturePeer();
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
        page.on('console', message => {
            // CONSOLE ERRORS ARE RECORDED, NOT ASSERTED: the probe deliberately blocks testingcf.jsdelivr.net, so
            // the page's own resource-load failures are expected and would make a zero-error assertion vacuous
            // decoration. Uncaught page exceptions stay in pageErrors and ARE asserted.
            if (message.type() === 'error') report.consoleErrors.push(String(message.text()).slice(0, 300));
        });
        // CHARACTER-WRITE EVIDENCE: the helper's character scope goes through POST /api/characters/merge-attributes,
        // so its status/body is recorded -- a scope that reads back in the store but never reaches disk must name
        // the request that failed, not just "the card has no variables".
        page.on('response', async response => {
            const url = response.url();
            if (!/\/api\/(characters\/(merge-attributes|edit-attribute|get)|chats\/)/.test(url)) return;
            let body = null;
            try { body = (await response.text()).slice(0, 400); } catch { body = null; }
            report.network.push({ url: url.replace(/^https?:\/\/[^/]+/, ''), status: response.status(), body });
        });
        await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());

        const openPage = async () => {
            await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
            return page.evaluate(async () => {
                const script = await import('./script.js');
                const started = performance.now();
                while (performance.now() - started < 90000) {
                    if (script.settingsReady) return { settingsReady: true };
                    const onboarding = document.querySelector('.popup .onboarding');
                    if (onboarding) {
                        const input = onboarding.closest('.popup')?.querySelector('.popup-input');
                        if (input) input.value = 'Probe User';
                        onboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                return { settingsReady: false };
            });
        };

        const connect = async peerUrl => page.evaluate(async url => {
            const script = await import('./script.js');
            const openai = await import('./scripts/openai.js');
            if (typeof script.changeMainAPI === 'function') script.changeMainAPI('openai');
            const set = (selector, value, eventName = 'input') => {
                const control = document.querySelector(selector);
                if (!control) return false;
                control.value = value;
                control.dispatchEvent(new Event(eventName, { bubbles: true }));
                return true;
            };
            set('#main_api', 'openai', 'change');
            set('#chat_completion_source', 'custom', 'change');
            set('#custom_api_url_text', url);
            set('#custom_model_id', 'probe-model');
            set('#api_key_custom', 'probe-key');
            openai.oai_settings.stream_openai = false;
            return { mainApi: script.main_api ?? null, source: openai.oai_settings.chat_completion_source ?? null, urlSet: String(openai.oai_settings.custom_url ?? '').includes('127.0.0.1') };
        }, peerUrl);

        const openCharacterByName = async name => page.evaluate(async wanted => {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const script = await import('./script.js');
            const collect = () => [...document.querySelectorAll('#rm_print_characters_block .character_select')].map(wrapper => {
                const id = wrapper.getAttribute('id') ?? '';
                const chid = String(wrapper.getAttribute('data-chid') ?? (id.startsWith('CharID') ? id.slice('CharID'.length) : ''));
                const label = String(wrapper.querySelector('.ch_name')?.textContent ?? '').trim();
                const modelName = chid === '' ? null : (script.characters?.[chid]?.name ?? null);
                return { wrapper, id, chid, label, modelName };
            });
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline) {
                // THE WELCOME PANEL FIRST: while it is up the roster can be hidden behind it, and a probe that
                // waits on the roster alone times out on a page a user would simply click past.
                if (!document.querySelector('#chat .mes')) {
                    document.querySelector('#rm_button_close')?.click();
                    document.querySelector('.welcomePanel .close')?.click();
                }
                const cards = collect();
                const card = cards.find(entry => entry.label === wanted || entry.modelName === wanted);
                if (card) {
                    card.wrapper.click();
                    const settle = Date.now() + 30000;
                    while (Date.now() < settle) {
                        const context = window.SillyTavern?.getContext?.();
                        if (script.this_chid !== undefined && script.this_chid !== null && context?.chatId !== undefined && context?.chatId !== null) {
                            return { opened: true, name: wanted, chid: String(script.this_chid), chatId: context.chatId, chatLength: (context?.chat ?? []).length, rendered: cards.map(entry => entry.label || entry.modelName) };
                        }
                        await sleep(250);
                    }
                    return { opened: false, name: wanted, reason: 'card clicked but no character became current', rendered: cards.map(entry => entry.label || entry.modelName) };
                }
                await sleep(250);
            }
            return { opened: false, name: wanted, reason: 'no roster card with that name', rendered: collect().map(entry => entry.label || entry.modelName) };
        }, name);

        const openSavedChat = async chatName => page.evaluate(async wanted => {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            let viaPanel = false;
            const rendered = [];
            document.querySelector('#option_select_chat')?.click();
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                const rows = Array.from(document.querySelectorAll('#select_chat_div .select_chat_block'));
                rendered.length = 0;
                for (const row of rows) rendered.push(String(row.getAttribute('file_name') ?? ''));
                const row = rows.find(entry => String(entry.getAttribute('file_name') ?? '') === wanted);
                if (row) {
                    row.click();
                    viaPanel = true;
                    break;
                }
                await sleep(250);
            }
            if (!viaPanel) {
                const script = await import('./script.js');
                await script.openCharacterChat(wanted);
            }
            const settle = Date.now() + 30000;
            while (Date.now() < settle) {
                const context = window.SillyTavern?.getContext?.();
                if (context?.chatId === wanted) return { opened: true, viaPanel, rendered, chatId: context.chatId, chatLength: (context?.chat ?? []).length };
                await sleep(250);
            }
            return { opened: false, viaPanel, rendered, chatId: window.SillyTavern?.getContext?.()?.chatId ?? null };
        }, chatName);

        const SCRIPT_TEXT = await fs.readFile(SCRIPT_PATH, 'utf8');
        if (SCRIPT_TEXT.includes('`') || SCRIPT_TEXT.includes('</script>')) {
            throw new Error('the in-iframe script contains a backtick or </script>, which the extension embedder cannot carry');
        }
        let runCounter = 0;
        const runPhase = async (phase, extra = {}) => {
            runCounter += 1;
            const runId = `hse-${phase}-${runCounter}`;
            const payload = {
                runId, phase, nonce, off: variant === 'off',
                markers, presets: { a: PRESET_A, b: PRESET_B },
                eventNames: ['message_sent', 'message_received', 'generation_started', 'generation_ended', 'generation_stopped', 'preset_changed', 'oai_preset_changed_after', 'chat_id_changed', 'js_generation_started', 'js_generation_ended', 'message_updated'],
                presetName: extra.presetName ?? null,
                scopes: extra.scopes ?? ['chat', 'global', 'character', 'preset', 'script', 'message', 'extension'],
                caseName: extra.caseName ?? null,
            };
            const before = peer.requests.length;
            await page.evaluate(item => {
                window.__hse = item;
                window.__hseDone = null;
                window.TavernHelper.replaceScriptTrees([{
                    type: 'script',
                    enabled: true,
                    name: item.runId,
                    id: item.runId,
                    content: item.content,
                    button: { enabled: false, buttons: [] },
                }], { type: 'global' });
            }, { ...payload, content: SCRIPT_TEXT });
            const deadline = Date.now() + 120000;
            let done = null;
            while (Date.now() < deadline) {
                const found = await page.evaluate(() => Array.from(document.querySelectorAll('iframe')).map(item => {
                    try { return item.contentWindow?.__hseDone ?? null; } catch { return null; }
                }).filter(Boolean));
                done = found.find(item => item.runId === runId) ?? null;
                if (done) break;
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            console.error(`[hse] phase ${phase} run ${runId}: done=${done !== null} requests=${peer.requests.length - before} errors=${JSON.stringify(done?.errors ?? null).slice(0, 400)}`);
            const requests = peer.requests.slice(before).map(entry => ({ ...entry, case: inferCase(entry.body, extra.cases ?? []) }));
            return { runId, done, requests };
        };

        // The case a capture belongs to is read from the body's own last user message (generate() sends
        // `user_input` there), never from arrival order: an accounting shift once reported two subjects as
        // disagreeing when they did not.
        const inferCase = (body, cases) => {
            for (const name of cases) if (body.includes(name)) return name;
            return null;
        };
        const caseNames = cfg => cfg;

        // ---- open the primary character and its seeded chat --------------------------------------------
        const boot = await openPage();
        step('page-loaded', boot.settingsReady === true, boot);
        const connected = await connect(`http://127.0.0.1:${peer.port}`);
        step('peer-wired', connected.urlSet === true, connected);
        const openedCard = await openCharacterByName(PROBE_CARD.dataName);
        step('character-opened', openedCard.opened === true, openedCard);
        const openedChat = await openSavedChat('HS Primary Chat');
        step('chat-opened', openedChat.opened === true, openedChat);

        const readDisk = async () => ({
            chat: await readChatMetadataVariables(dataRoot, PROBE_CARD.fileName, 'HS Primary Chat'),
            global: await readSettingsGlobalVariables(dataRoot),
            cardA: await readCardVariables(dataRoot, `${PROBE_CARD.fileName}.png`),
            cardB: await readCardVariables(dataRoot, HELPERS.file),
            presetA: await readPresetDocument(dataRoot, PRESET_A),
            presetB: await readPresetDocument(dataRoot, PRESET_B),
        });

        if (!afterRestart) {
            // ---- PHASE 1: the write matrix, then the first generation carrying every scope -----------------
            const write = await runPhase('write', { cases: ['hs-write'] });
            report.phases.write = write;
            step('write-script-completed', write.done !== null && (write.done.errors ?? []).length === 0, { errors: write.done?.errors ?? ['no done record'], cases: write.done?.cases?.map(entry => `${entry.name}:${entry.applied === undefined ? '?' : entry.applied}`) ?? null });
            step('closure-proven', write.done?.closure?.insideIframe === true && (write.done?.closure?.bridgeFns ?? []).length >= 6, write.done?.closure ?? null);
            step('write-generation-captured', write.requests.some(entry => entry.case === 'hs-write'), { captured: write.requests.map(entry => entry.case ?? '(unmatched)') });
            // SETTLE THE HOST'S OWN METADATA SAVE. Pinned's helper schedules saveMetadataDebounced and pinned skips it
            // if the character changed between scheduling and firing; a chat-file reader that polls for 30 s then
            // cannot distinguish "the helper never saved" from "a host save was skipped". Calling the HOST's own
            // saveMetadata() is the same call the debounce makes, is recorded, and keeps the WRITE itself on the
            // bridge (the helper wrote chat_metadata; this only flushes it).
            // SETTLE THE HOST'S METADATA SAVE, AS A CONDITION AND NOT A SLEEP. The helper's chat-scope write is a
            // bridge call; the HOST's live chatMetadata object can lag it by a tick, so a single saveMetadata() right
            // after the script returns can flush the PREVIOUS (empty) object -- measured as an intermittent pinned
            // miss while the same code passed on an earlier run. Wait (bounded) for the host's own object to carry
            // keys, then call the host's own save; record both, so a flush that never got the value stays visible.
            const settled = await page.evaluate(async () => {
                const read = () => {
                    try { const context = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null; return context && context.chatMetadata ? (context.chatMetadata.variables || null) : null; }
                    catch (error) { return null; }
                };
                const startedAt = Date.now();
                let keys = 0;
                while (Date.now() - startedAt < 10000) {
                    const current = read();
                    keys = current && typeof current === 'object' ? Object.keys(current).length : 0;
                    if (keys > 0) break;
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                let saved = false;
                let reason = null;
                try {
                    const context = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
                    if (!context || typeof context.saveMetadata !== 'function') reason = 'no getContext().saveMetadata';
                    else { await context.saveMetadata(); saved = true; }
                } catch (error) { reason = String((error && error.message) || error); }
                return { saved, reason, hostKeysBeforeSave: keys, waitedMs: Date.now() - startedAt };
            });
            report.phases.metadataSaveSettled = settled;
            const diskAfterWrite = await waitForDisk('scopes-on-disk', readDisk, disk => {
                const chatVars = disk.chat.variables ?? {};
                return chatVars.hs_chat === `${markers.chat}${nonce}` && (disk.global.variablesGlobal ?? {}).hs_global === `${markers.global}${nonce}`;
            }, { deadlineMs: 30000 });
            report.phases.diskAfterWrite = { ok: diskAfterWrite.ok, waitedMs: diskAfterWrite.waitedMs, value: diskAfterWrite.value };
            step('chat-and-global-persisted', diskAfterWrite.ok === true, { waitedMs: diskAfterWrite.waitedMs, chat: diskAfterWrite.value?.chat?.variables ?? null, global: diskAfterWrite.value?.global?.variablesGlobal ?? null });
            const diskCardPreset = await waitForDisk('card-and-preset-on-disk', readDisk, disk => {
                const cardVars = disk.cardA.variables ?? {};
                const presetVars = disk.presetA.document?.extensions?.tavern_helper?.variables ?? {};
                return cardVars.hs_character === `${markers.character}${nonce}` && presetVars.hs_preset === `${markers.preset}${nonce}`;
            }, { deadlineMs: 30000 });
            report.phases.diskCardPreset = { ok: diskCardPreset.ok, waitedMs: diskCardPreset.waitedMs, value: diskCardPreset.value };
            step('character-and-preset-persisted', diskCardPreset.ok === true, {
                waitedMs: diskCardPreset.waitedMs,
                card: diskCardPreset.value?.cardA?.variables ?? null,
                preset: diskCardPreset.value?.presetA?.document?.extensions?.tavern_helper?.variables ?? null,
            });

            // ---- PHASE 2: preset mutation -> the NEXT request ---------------------------------------------
            const mutate = await runPhase('mutate', { cases: ['hs-b0-baseline', 'hs-b1-mutated', 'hs-b2-sampler', 'hs-b3-restored'] });
            report.phases.mutate = mutate;
            step('mutation-script-completed', mutate.done !== null && (mutate.done.errors ?? []).length === 0, { errors: mutate.done?.errors ?? ['no done record'] });
            for (const name of ['hs-b0-baseline', 'hs-b1-mutated', 'hs-b2-sampler', 'hs-b3-restored']) {
                step(`capture-${name}`, mutate.requests.some(entry => entry.case === name), { captured: mutate.requests.map(entry => entry.case ?? '(unmatched)') });
            }
            await waitForDisk('preset-mutation-on-disk', () => readPresetDocument(dataRoot, PRESET_A), doc => String(doc?.document?.extensions?.tavern_helper?.variables?.hs_preset ?? '') === `${markers.preset}${nonce}`, { deadlineMs: 15000 });
            report.phases.presetAfterMutation = await readPresetDocument(dataRoot, PRESET_A);

            // ---- PHASE 3: events --------------------------------------------------------------------------
            const events = await runPhase('events', { cases: ['hs-c1-event'] });
            report.phases.events = events;
            step('events-script-completed', events.done !== null && (events.done.errors ?? []).length === 0, { errors: events.done?.errors ?? ['no done record'] });
            report.phases.eventsAtEnd = events.done?.eventsAtEnd ?? [];
            // the listener stays alive only for this phase; the CHAT_CHANGED event is collected by the driver
            // after the switch below, from the same parent array the listener wrote to.
            const eventsBeforeSwitch = await page.evaluate(() => (window.__hseEvents ?? []).slice());
            const switchedChat = await openSavedChat('HS Second Chat');
            const eventsAfterSwitch = await page.evaluate(() => (window.__hseEvents ?? []).slice());
            report.phases.switchChat = { switchedChat, eventsBeforeSwitch, eventsAfterSwitch };
            step('chat-switched', switchedChat.opened === true, switchedChat);
            const chatRead = await runPhase('read', { caseName: 'hs-read-chat-switched', cases: ['hs-read-chat-switched'] });
            report.phases.readAfterChatSwitch = chatRead;
            const reopenedChat = await openSavedChat('HS Primary Chat');
            report.phases.reopenedChat = reopenedChat;

            // ---- PHASE 4: character switch ---------------------------------------------------------------
            const switchedCharacter = await openCharacterByName(HELPERS.name);
            report.phases.switchCharacter = { switchedCharacter };
            step('character-switched', switchedCharacter.opened === true, switchedCharacter);
            const characterRead = await runPhase('read', { caseName: 'hs-read-character-switched', cases: ['hs-read-character-switched'] });
            report.phases.readAfterCharacterSwitch = characterRead;
            const backCharacter = await openCharacterByName(PROBE_CARD.dataName);
            await openSavedChat('HS Primary Chat');
            report.phases.switchedBackCharacter = backCharacter;

            // ---- PHASE 5: preset switch -------------------------------------------------------------------
            // PRESET B carries no helper variables and a different identity prompt, so the preset scope must read
            // EMPTY on B and the generation's preset clause must be empty; switching back to A must restore both.
            const switchedPreset = await runPhase('read', { presetName: PRESET_B, caseName: 'hs-read-preset-b', cases: ['hs-read-preset-b'] });
            report.phases.switchPresetB = switchedPreset;
            step('preset-switched-read-captured', switchedPreset.requests.some(entry => entry.case === 'hs-read-preset-b'), { captured: switchedPreset.requests.map(entry => entry.case ?? '(unmatched)') });
            const switchedPresetBack = await runPhase('read', { presetName: PRESET_A, caseName: 'hs-read-preset-back', cases: ['hs-read-preset-back'] });
            report.phases.switchPresetBack = switchedPresetBack;
        } else {
            // A RESTART LEG IS READ-ONLY: it opens the same tree in a NEW process and reads what the writer left.
            const read = await runPhase('read', { caseName: 'hs-read-restart', cases: ['hs-read-restart'] });
            report.phases.readRestart = read;
            step('restart-read-captured', read.requests.some(entry => entry.case === 'hs-read-restart'), { captured: read.requests.map(entry => entry.case ?? '(unmatched)') });
            report.phases.diskRestart = await readDisk();
        }

        // ---- PHASE 6: reload (same process, new page) ---------------------------------------------------
        await page.goto(`${origin}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 }).catch(() => {});
        const reloadBoot = await openPage();
        const reopened = await openCharacterByName(PROBE_CARD.dataName);
        await openSavedChat('HS Primary Chat');
        // REWIRE THE HARNESS PEER, NOT PRODUCT STATE. The capture peer listens on a per-run ephemeral port; after a
        // reload the settings on disk still name the port the WRITER run used, so the generation would answer 502
        // "connection refused" before it reached any state under test (measured: run 41313285166, restart leg
        // reload-read-captured with captured=[]). Re-point the page at THIS run's peer; the variables, preset and
        // chat state this phase proves are still read from disk and are untouched by the rewire.
        await connect(`http://127.0.0.1:${peer.port}`);
        const readReload = await runPhase('read', { caseName: 'hs-read-reload', cases: ['hs-read-reload'] });
        report.phases.readReload = { reloadBoot, reopened, readReload };
        step('reload-read-captured', readReload.requests.some(entry => entry.case === 'hs-read-reload'), { settingsReady: reloadBoot.settingsReady, captured: readReload.requests.map(entry => entry.case ?? '(unmatched)') });

        report.phases.pageErrors = report.pageErrors;
        report.phases.consoleErrors = report.consoleErrors;
        report.phases.network = report.network;
        if (gotavern?.log) report.provenance.serverLog = gotavern.log.slice(0, 60);
        step('no-page-errors', report.pageErrors.length === 0, report.pageErrors.slice(0, 8));
    } catch (error) {
        report.failure = report.failure ?? String(error?.stack ?? error);
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (peer) await peer.close().catch(() => {});
        if (gotavern?.server) gotavern.server.kill('SIGKILL');
        report.steps = report.steps;
        await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
        const failed = report.steps.filter(entry => !entry.ok).map(entry => entry.name);
        console.log(`${report.leg} helper-state (${variant}${afterRestart ? ', restart' : ''}): ${report.steps.length} step(s), ${failed.length} failed${failed.length > 0 ? ` [${failed.join(', ')}]` : ''}`);
        console.log(`report: ${reportPath}`);
        if (report.failure) console.error(`FAILURE: ${String(report.failure).slice(0, 1200)}`);
        if (report.failure || failed.length > 0) process.exitCode = 1;
    }
}

await main();
