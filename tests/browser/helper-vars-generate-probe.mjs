// DO 酒馆助手's VARIABLES REACH THE FINAL PROVIDER REQUEST -- the NARROW vehicle.
//
// THE CLAIM, in one sentence and in the two halves that either alone cannot prove: a helper writes a variable, and
//   (i)  a prompt that reads it through the HOST macro engine resolves the value DURING GENERATION so the resolved
//        text is in the captured provider request bytes;
//   (ii) the value is still readable FROM DISK after a fresh page and after a NEW server process.
// (i) alone is satisfied by a page-only write that is never saved; (ii) alone by a write no prompt can read.
//
// WHY THIS FILE EXISTS, stated as the record the lead asked for: THE UI-SELECT VEHICLE WAS ATTEMPTED FIRST AND COST
// FOUR REDS, ALL IN THE VEHICLE; THE CLAIM DOES NOT REQUIRE IT.
//   Browser differential 40445034876  card-opened           -- card matched by a field the template does not set
//   Browser differential 40451801982  ready-preset-selected -- card staged after the frontend read the character list
//   Browser differential 40457217583  ready-preset-selected -- DOM `selected` property vs jQuery's cached selection
//   (source-diagnosed, unfixed)       ready-preset-selected -- manager resolved by ambient `main_api`, not the openai
//                                                              select (preset-manager.js:76-96 + st-context.js:288)
// Every one was the vehicle. The claim needs ONE variable, ONE prompt that reads it, and ONE generation; a derived
// three-prompt preset, a staged card, a UI `<select>` and a manager lookup are all machinery the claim never named.
// The UI vehicle is KEPT as the SECOND probe for the `preset` scope only (a preset-scoped variable has no meaning
// without a preset), and its header says it is the harder vehicle for the narrower purpose.
//
// THE MECHANISM, read from pinned source (SillyTavern 06bde939fb1e9c4c8d8641d810f0a9165b5ce127), because this leg
// exercises it rather than assuming it:
//   `TavernHelper.generateRaw({ ordered_prompts: [{role, content}], user_input, max_chat_history: 0 })`
//     (extension N0VI028/JS-Slash-Runner@837a6288 src/function/generate/index.ts:407, GenerateRawConfig
//     src/function/generate/types.ts) drives the REAL assembly, so the request that reaches the peer is the product's
//     final provider request -- the same wire the generation leg already compares byte for byte.
//   The prompt content is expanded by the HOST macro engine, not by the extension:
//     public/scripts/macros/definitions/variable-macros.js:99-116   `getvar` -> ctx.variables.local.get(name)
//     public/scripts/st-context.js:258-279                           getContext().variables.local.get
//     public/scripts/variables.js:22-46                             reads chat_metadata.variables
//   An ABSENT variable resolves to '' -- public/scripts/variables.js:45 `(localVariable || '')` -- which is the
//   "absent form" the delete case asserts.
//
// KEPT FROM THE UI VEHICLE WITHOUT EXCEPTION (the lead's instruction, and they are green):
//   * the SIX REFUSAL CHECKS (extension pinned by commit + manifest; the API surface read from the installed source;
//     the two MEASURED absences, `setVariables` and the quiet option; the host macro surface);
//   * the pinned API-SURFACE RECORD with those two absences;
//   * `messageStoredNotSurfaced` as its OWN named row -- a finding about pinned, not a gap in this harness.
//
// WHAT THIS LEG DOES NOT DO, stated so no reader over-reads it: it does not drive a UI `<select>`, a card, or a
// chat switch (that is the second probe, and only for the `preset` scope); it does not stream; it does not use a real
// provider (AGENTS 22 -- a simulated peer is unverified for production, recorded in the artefact's `unproven`).
//
// OFFLINE: the peer binds 127.0.0.1. testingcf.jsdelivr.net is blocked and recorded, as in every helper leg.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createServer } from 'node:net';
import path from 'node:path';
import process from 'node:process';

import { ensurePinnedExtensionInstalled } from './install-pinned-extension.mjs';
import { pinnedExtension } from './pinned-extensions.mjs';
import { seedLegConfig } from './seed-leg-config.mjs';
import { readChatRecords, readHelperApiSurface, readSettingsFile, here, repoRoot } from './extensions/helper-vars-kit.mjs';

const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

const subject = process.env.PROBE_BASE_URL ? 'pinned' : 'gotavern';
const external = Boolean(process.env.PROBE_BASE_URL);
const variant = argumentValue('--variant', 'on');
// THE CONTROL. `off` writes NO variable: every capture must then equal the never-set form. A pair whose on and off
// captures are identical is HARNESS NON-DISCRIMINATING (rule 50).
const writesVariables = variant !== 'off';
const afterRestart = process.argv.includes('--after-restart');
const dataRoot = path.resolve(argumentValue('--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-hv-narrow-')));
const reportPath = path.resolve(argumentValue('--report', path.join(here, `helper-vars-${subject}-${variant}${afterRestart ? '-restart' : ''}.json`)));

const MARKERS = {
    first: 'HV-ALPHA-7c31',
    second: 'HV-BETA-9d42',
    global: 'HV-GLOBAL-e05f',
    message: 'HV-MESSAGE-1a88',
};
// THE CLAUSE the prompt carries, so the assertion is "the value arrived WHERE THE PROMPT ASKED FOR IT", not "the
// token appears somewhere in the body" -- a body that merely echoes a stashed variable would satisfy the weaker form.
const PROMPTS = {
    chat: 'HV-READ-CHAT=',
    global: 'HV-READ-GLOBAL=',
    message: 'HV-READ-MESSAGE=',
};

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
            if ((await fetch(url)).ok) return;
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${url} did not answer within ${deadlineMs} ms`);
}

/** The capture peer: records the request, answers a canned completion, defines nothing (rule 49). */
function startCapturePeer() {
    const requests = [];
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
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
            const entry = {
                method: request.method,
                path: request.url,
                contentType: request.headers['content-type'] ?? null,
                byteLength: body.length,
                sha256: createHash('sha256').update(body).digest('hex'),
                body: body.toString('utf8'),
                at: requests.length,
            };
            requests.push(entry);
            if (request.method === 'GET' && /models/.test(request.url ?? '')) {
                response.writeHead(200, headers);
                response.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model' }] }));
                return;
            }
            response.writeHead(200, headers);
            response.end(JSON.stringify({
                id: `chatcmpl-hvn-${entry.at}`,
                object: 'chat.completion',
                created: 1730000000,
                model: 'probe-model',
                choices: [{ index: 0, message: { role: 'assistant', content: `HVN-REPLY-${entry.at}` }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, requests, close: () => new Promise(done => server.close(done)) }));
    });
}

const report = {
    schemaVersion: 1,
    question: 'Does a 酒馆助手 variable resolve into the FINAL provider request during a real generateRaw, and is it still readable from disk after a fresh page and a new server process?',
    vehicle: 'narrow: one variable, one prompt that reads it through the host macro engine, one generateRaw per case. The UI-select vehicle was attempted first and cost four reds, all in the vehicle; the claim does not require it.',
    uiVehicleRedRuns: [
        { run: '40445034876', step: 'card-opened', mechanism: 'card matched by a field the template does not set (title lives on the inner .avatar)' },
        { run: '40451801982', step: 'ready-preset-selected', mechanism: 'card staged after the frontend read the character list' },
        { run: '40457217583', step: 'ready-preset-selected', mechanism: 'DOM selected property vs jQuery cached selection' },
        { run: '(source-diagnosed, unfixed)', step: 'ready-preset-selected', mechanism: 'manager resolved by ambient main_api, not the openai select' },
    ],
    subject,
    variant,
    afterRestart,
    provenance: {
        extension: { key: 'tavern-helper', name: pinnedExtension('tavern-helper').name, repo: pinnedExtension('tavern-helper').repo, commit: pinnedExtension('tavern-helper').commit },
        peer: 'in-process HTTP capture peer on 127.0.0.1; records the request, answers a canned completion; defines nothing (rule 49)',
        blockedExternal: [],
    },
    apiSurface: null,
    marks: MARKERS,
    prompts: PROMPTS,
    steps: [],
    cases: [],
    timings: { phases: [] },
    console: [],
    pageErrors: [],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
}

const timings = report.timings;
let phaseStart = Date.now();
const phase = label => {
    const now = Date.now();
    timings.phases.push({ phase: label, ms: now - phaseStart });
    phaseStart = now;
};

const peer = await startCapturePeer();
let server = null;
let browser = null;

function binaryPath() {
    const binarySetting = process.env.GOTAVERN_BINARY ?? '';
    return binarySetting ? path.resolve(binarySetting) : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
}

/**
 * THE GENERATION SCRIPT, run INSIDE the extension's own script iframe. It is the only thing this leg installs, and it
 * uses the extension's own API: `replaceScriptTrees` to exist at all, `insertOrAssignVariables` to write,
 * `getVariables` to read back, and `generateRaw` to drive the real assembly.
 */
const SCRIPT = [
    'const cfg = window.parent.__hvn;',
    'const out = { cases: [], error: null };',
    'const record = (name, extra) => out.cases.push(Object.assign({ name }, extra));',
    'try {',
    // THE VEHICLE'S OWN PRECONDITION: the helper API this leg calls must exist. A missing one is a refusal, not a
    // failed case, because every later capture would be about something else.
    '  const api = {',
    '    getVariables: typeof TavernHelper?.getVariables === "function",',
    '    insertOrAssignVariables: typeof TavernHelper?.insertOrAssignVariables === "function",',
    '    deleteVariable: typeof TavernHelper?.deleteVariable === "function",',
    '    generateRaw: typeof TavernHelper?.generateRaw === "function",',
    '  };',
    '  out.api = api;',
    '  if (!api.getVariables || !api.insertOrAssignVariables || !api.generateRaw) {',
    '    out.error = "the pinned helper API this leg calls is not present: " + JSON.stringify(api);',
    '  } else {',
    '    const run = async (name, ops, prompt) => {',
    '      const applied = [];',
    '      for (const op of ops) {',
    '        if (op.kind === "insert") { TavernHelper.insertOrAssignVariables(op.values, { type: op.scope }); applied.push({ op: "insert", scope: op.scope, after: TavernHelper.getVariables({ type: op.scope }) }); }',
    '        else if (op.kind === "delete") { const r = TavernHelper.deleteVariable(op.path, { type: op.scope }); applied.push({ op: "delete", scope: op.scope, deleteOccurred: r?.delete_occurred ?? null, variables: r?.variables ?? null }); }',
    '        else if (op.kind === "message") { TavernHelper.insertOrAssignVariables(op.values, { type: "message", message_id: op.message_id }); applied.push({ op: "message", stored: TavernHelper.getVariables({ type: "message", message_id: op.message_id }) }); }',
    '      }',
    '      let reply = null; let error = null;',
    '      try {',
    '        reply = await TavernHelper.generateRaw({',
    '          ordered_prompts: [{ role: "system", content: prompt }],',
    '          user_input: name,',
    '          max_chat_history: 0,',
    '          should_stream: false,',
    '          should_silence: true,',
    '        });',
    '      } catch (e) { error = String(e && e.message || e); }',
    '      record(name, { applied, reply: reply === null ? null : String(reply).slice(0, 120), error });',
    '    };',
    '    for (const item of cfg.cases) await run(item.name, item.ops, item.prompt);',
    '  }',
    '} catch (error) { out.error = String(error && error.message || error); }',
    'window.__hvnDone = out;',
].join('\n');

try {
    await fs.mkdir(dataRoot, { recursive: true });
    const installed = await ensurePinnedExtensionInstalled(dataRoot, pinnedExtension('tavern-helper'));
    report.provenance.extension.installedRevision = installed.revision;
    report.provenance.extension.installSource = installed.source ?? null;

    // ---- THE SIX REFUSAL CHECKS, kept from the UI vehicle without exception ------------------------------
    const apiSurface = await readHelperApiSurface(installed, installed.extensionDirectory);
    report.apiSurface = apiSurface;
    if (!apiSurface.pinned) {
        throw new Error(`REFUSED: the pinned variable semantics are not the ones on disk: ${apiSurface.reasons.join('; ')}`);
    }
    step('extension-is-pinned', true, `${apiSurface.pinnedCommit} manifest ${apiSurface.manifestVersion}`);
    step('api-surface-recorded', Object.keys(apiSurface.exports).length >= 14 && Object.keys(apiSurface.scopes).length === 7,
        `exports=${Object.keys(apiSurface.exports).length} scopes=${Object.keys(apiSurface.scopes).join(',')}`);
    step('absent-features-recorded', apiSurface.absentUnexpected.length === 0,
        apiSurface.absentUnexpected.length === 0
            ? `confirmed absent at the pin: ${apiSurface.absentConfirmed.map(entry => entry.name).join(', ')}`
            : `UNEXPECTED at the pin: ${JSON.stringify(apiSurface.absentUnexpected)}`);
    step('message-scope-unreadable-by-macro', apiSurface.host.messageScopeMacro === false,
        'no host variable macro consults a message scope, so the message row is "stored, not surfaced"');
    step('host-macro-surface-present', apiSurface.host.macros?.present === true && apiSurface.host.variablesBinding === true,
        `macros=${apiSurface.host.macros?.file ?? null} declaresVariableMacros=${JSON.stringify(apiSurface.host.declaredVariableMacros ?? null)} variablesBinding=${apiSurface.host.variablesBinding}`);
    phase('refusals');

    const port = await freePort();
    let legConfig = process.env.PROBE_LEG_CONFIG_JSON ? JSON.parse(process.env.PROBE_LEG_CONFIG_JSON) : null;
    if (!external) {
        const binary = binaryPath();
        if (!process.env.GOTAVERN_BINARY) {
            const build = spawn('go', ['build', '-trimpath', '-o', binary, './cmd/gotavern'], { cwd: repoRoot, stdio: 'inherit' });
            if (await new Promise(resolve => build.on('exit', resolve)) !== 0) throw new Error('go build ./cmd/gotavern failed');
        } else {
            await fs.copyFile(path.resolve(process.env.GOTAVERN_BINARY), binary);
        }
        const tokenizers = path.join(repoRoot, 'upstream', 'tokenizers');
        if (!(await fs.stat(tokenizers).then(() => true, () => false))) throw new Error(`tokenizer data missing at ${tokenizers}`);
        await fs.cp(tokenizers, path.join(dataRoot, 'tokenizers'), { recursive: true });
        legConfig = await seedLegConfig(dataRoot);
        server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stdout.on('data', () => {});
        server.stderr.on('data', () => {});
        report.provenance.serverPid = server.pid ?? null;
    }
    report.provenance.configFile = { path: 'config.yaml', sha256: legConfig?.sha256 ?? null, matchesSource: legConfig?.matchesSource ?? null };
    const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;
    await waitForServer(`${baseURL}/version`);
    phase('server-ready');
    report.provenance.serverVersion = await fetch(`${baseURL}/version`).then(response => response.json(), () => null);

    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
    page.on('console', message => report.console.push({ type: message.type(), text: String(message.text()).slice(0, 400) }));
    await page.route('**://testingcf.jsdelivr.net/**', route => {
        report.provenance.blockedExternal.push(route.request().url());
        return route.abort();
    });

    const openPage = async () => {
        await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
        return page.evaluate(async () => {
            const script = await import('./script.js');
            const started = performance.now();
            while (performance.now() - started < 90000) {
                if (script.settingsReady) return { settingsReady: true };
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
            return { settingsReady: false };
        });
    };

    /**
     * POINT THE FRONTEND AT THE PEER, through its own controls. `generateRaw` still goes through the OpenAI
     * chat-completion path, so the connection has to be the custom endpoint; this is the same setup the proven
     * generation leg performs, and it is NOT the UI-select machinery the four reds were about.
     */
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
        return {
            mainApi: script.main_api ?? null,
            source: openai.oai_settings.chat_completion_source ?? null,
            model: openai.oai_settings.custom_model ?? null,
            urlSet: String(openai.oai_settings.custom_url ?? '').includes('127.0.0.1'),
        };
    }, peerUrl);

    const boot = await openPage();
    step('page-loaded', boot?.settingsReady === true, 'script.js settingsReady');
    phase('page-loaded');
    const connection = await connect(`http://127.0.0.1:${peer.port}/v1`);
    step('connection-configured', connection?.source === 'custom' && connection?.urlSet === true && connection?.mainApi === 'openai', JSON.stringify(connection));

    // THE CASES. Each is ONE variable operation followed by ONE generateRaw whose prompt reads that variable.
    const chatPrompt = `${PROMPTS.chat}{{getvar::hv_chat}}`;
    const globalPrompt = `${PROMPTS.global}{{getglobalvar::hv_global}}`;
    const messagePrompt = `${PROMPTS.message}{{getvar::hv_message}}`;
    const cases = writesVariables ? [
        { name: 'chat-alpha', ops: [{ kind: 'insert', scope: 'chat', values: { hv_chat: MARKERS.first } }], prompt: chatPrompt },
        { name: 'chat-beta', ops: [{ kind: 'insert', scope: 'chat', values: { hv_chat: MARKERS.second } }], prompt: chatPrompt },
        { name: 'chat-deleted', ops: [{ kind: 'delete', scope: 'chat', path: 'hv_chat' }], prompt: chatPrompt },
        { name: 'global-set', ops: [{ kind: 'insert', scope: 'global', values: { hv_global: MARKERS.global } }], prompt: globalPrompt },
        // THE `message` SCOPE AS ITS OWN ROW: it stores and reads back inside the page, and the wire must NOT carry
        // it, because no host macro consults a message scope (recorded by the refusal check above).
        { name: 'message-set', ops: [{ kind: 'message', message_id: 0, values: { hv_message: MARKERS.message } }], prompt: messagePrompt },
    ] : [
        // THE OFF CONTROL: the same prompts, no writes. Every capture must equal the never-set form.
        { name: 'chat-alpha', ops: [], prompt: chatPrompt },
        { name: 'chat-deleted', ops: [], prompt: chatPrompt },
        { name: 'global-set', ops: [], prompt: globalPrompt },
        { name: 'message-set', ops: [], prompt: messagePrompt },
    ];
    report.plannedCases = cases.map(entry => entry.name);

    // THE SCRIPT RUNS IN THE EXTENSION'S OWN IFRAME, through the helper's own API, exactly as the render and
    // generation legs do -- so what is captured is the request the helper produced, not one this harness built.
    const runScript = async list => {
        const before = peer.requests.length;
        await page.evaluate(payload => {
            window.__hvn = payload;
            window.TavernHelper.replaceScriptTrees([{
                type: 'script',
                enabled: true,
                name: 'gotavern-hv-narrow',
                id: 'gotavern-hv-narrow',
                content: payload.content,
                button: { enabled: false, buttons: [] },
            }], { type: 'global' });
        }, { content: SCRIPT, cases: list });
        const deadline = Date.now() + 120000;
        let done = null;
        while (Date.now() < deadline) {
            done = await page.evaluate(() => {
                const frame = Array.from(document.querySelectorAll('iframe')).find(item => {
                    try {
                        return Boolean(item.contentWindow?.__hvnDone);
                    } catch {
                        return false;
                    }
                });
                return frame ? frame.contentWindow.__hvnDone : null;
            });
            if (done) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { done, requests: peer.requests.slice(before) };
    };

    const run = await runScript(cases);
    phase('cases-run');
    report.script = run.done;
    step('script-completed', Boolean(run.done) && !run.done?.error, run.done?.error ?? 'no __hvnDone on any iframe');
    if (run.done?.api) step('helper-api-present', Object.values(run.done.api).every(Boolean), JSON.stringify(run.done.api));

    // ONE CAPTURE PER CASE, in order, because each generateRaw is awaited inside the script.
    report.cases = cases.map((entry, index) => ({
        case: entry.name,
        applied: (run.done?.cases ?? []).find(item => item.name === entry.name)?.applied ?? null,
        reply: (run.done?.cases ?? []).find(item => item.name === entry.name)?.reply ?? null,
        error: (run.done?.cases ?? []).find(item => item.name === entry.name)?.error ?? null,
        request: summarise(run.requests[index] ?? null),
    }));
    step('one-capture-per-case', report.cases.every(entry => entry.request !== null),
        report.cases.map(entry => `${entry.case}:${entry.request ? 'ok' : 'absent'}`).join(','));

    // ---- HALF (ii): DISK, re-read in this process ---------------------------------------------------------
    report.disk = { chats: await readChatRecords(dataRoot), settings: await readSettingsFile(dataRoot) };

    // ---- A FRESH PAGE over the same process ----------------------------------------------------------------
    const reloadBoot = await openPage();
    const reloadConnect = await connect(`http://127.0.0.1:${peer.port}/v1`);
    const reloadRun = await runScript([{ name: 'reload-chat', ops: [], prompt: chatPrompt }]);
    report.reload = {
        boot: reloadBoot,
        connection: reloadConnect,
        script: reloadRun.done,
        request: summarise(reloadRun.requests[0] ?? null),
        disk: { chats: await readChatRecords(dataRoot), settings: await readSettingsFile(dataRoot) },
    };
    step('reload-page-loaded', reloadBoot?.settingsReady === true && reloadRun.done !== null, JSON.stringify({ settingsReady: reloadBoot?.settingsReady, scriptError: reloadRun.done?.error ?? null }));
    phase('reload');

    report.completions = peer.requests.filter(entry => /completions$/.test(entry.path ?? '')).length;
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    const teardownStart = Date.now();
    if (browser) {
        await browser.close();
        timings.phases.push({ phase: 'browser-close', ms: Date.now() - teardownStart });
    }
    await peer.close();
    timings.phases.push({ phase: 'peer-close', ms: Date.now() - teardownStart });
    server?.kill();
}

/**
 * A CAPTURE, as the comparator reads it. The raw body and digest are the contract (rule 2); `bodies` is the whole
 * body text (bounded) because the assertions match CLAUSES inside it.
 */
function summarise(request) {
    if (!request) return null;
    let parsed = null;
    try {
        parsed = JSON.parse(request.body);
    } catch {
        parsed = null;
    }
    return {
        path: request.path,
        contentType: request.contentType,
        byteLength: request.byteLength,
        sha256: request.sha256,
        body: request.body.slice(0, 12000),
        keys: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed).sort() : null,
        model: parsed?.model ?? null,
        stream: parsed?.stream ?? null,
    };
}

try {
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
} catch (writeError) {
    console.error(`could not write ${reportPath}: ${writeError && writeError.message || writeError}`);
    process.exitCode = 1;
}

console.log(JSON.stringify({
    subject: report.subject,
    variant: report.variant,
    afterRestart: report.afterRestart,
    failure: report.failure,
    steps: report.steps.map(item => `${item.ok === null ? 'n/a' : item.ok ? 'ok' : 'FAIL'} ${item.name}`),
    cases: report.cases.map(entry => ({ case: entry.case, sha256: entry.request?.sha256 ?? null, bytes: entry.request?.byteLength ?? null, error: entry.error ?? null })),
    timings: report.timings.phases,
}, null, 2));
