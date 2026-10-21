// Generation probe: does a send driven from the PINNED frontend produce a provider request?
//
// WHAT IT MEASURES. It boots GoTavern (or is pointed at any other server with PROBE_BASE_URL), drives
// one send the way the frontend itself does -- load and select a character through the frontend's own
// functions, wait for the state a user can send from, then click #send_but -- and polls the recording
// mock provider for an arriving request. It also records EVERY page request unfiltered, so a negative
// finding ("this call never happened") comes from a log that would have shown it.
//
// WHAT ITS LAST RUN SHOWED (2026-10-20, GoTavern from a fresh data root): the character binds, the chat
// opens, the send button is enabled, the frontend assembles a prompt (three POST /api/tokenizers/llama/
// encode -> 200), every /api call answers 2xx/204, and NO backend call is made, so no provider request
// arrives. Page errors: none. Requests recorded: 241.
//
// WHAT IT DOES NOT CONCLUDE. "No provider request" with no failing request and no page error is a
// probe-faithfulness question (AGENTS.md verification rule 10), not a product finding: the drive's
// oai_settings are a partial configuration compared with what a user's custom-source setup contains.
// The next step is a differential against pinned Node with PROBE_BASE_URL and, if needed, a recorded
// user settings snapshot -- not more fields added until something happens.
//
// PROVENANCE IS PART OF THE OUTPUT. The report records which server was driven, whether the page
// loaded, how many requests were recorded, and the diagnostics at the point of the send; a bit quoted
// without them is not evidence.
// Generation probe (increment 0b), deliberately minimal.
//
// ONE question: does a send driven from the pinned frontend produce a provider request at all?
// It drives one generation against the recording mock provider, then reports whether a request
// arrived and what shape it had. It does NOT assert a boundary, a count, or a prompt shape —
// those come later and only if this answers yes.
//
// Why this is separate from the pinned suite: no spec in that suite drives a generation turn, so
// generation is untested rather than proven working. This probe exists to make that assumption
// measured instead of assumed, and to keep the answer unambiguous if it is no.
//
// Usage: node generation-probe.mjs [--report <path>]

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
// CJS interop: the browser type may be exposed on the namespace or only under default.
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

async function waitFor(url, label, deadlineMs = 30000) {
    const started = Date.now();
    let lastError = '';
    while (Date.now() - started < deadlineMs) {
        try {
            const response = await fetch(url);
            if (response.status < 500) {
                return response;
            }
            lastError = `status ${response.status}`;
        } catch (error) {
            lastError = String(error.message ?? error);
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error(`${label} did not answer at ${url}: ${lastError}`);
}

// The mock's response script: one non-streaming chat completion, enough for the frontend to
// finish a turn.
const mockScript = {
    responses: [{
        status: 200,
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        body: JSON.stringify({
            id: 'probe-completion',
            choices: [{ index: 0, message: { role: 'assistant', content: 'probe reply' }, finish_reason: 'stop' }],
        }),
    }],
};

const port = await freePort();
const dataRoot = await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-probe-'));
const scriptPath = path.join(dataRoot, 'mock-script.json');
await fs.writeFile(scriptPath, JSON.stringify(mockScript));

// PROBE_BASE_URL means the drive is aimed at ANOTHER server (the pinned differential), so there is
// nothing to build and nothing to boot: building anyway costs a build and, when the disk was full,
// failed the differential with an error that had nothing to do with what it was measuring.
const external = Boolean(process.env.PROBE_BASE_URL);
const binarySetting = process.env.GOTAVERN_BINARY ?? '';
const binary = binarySetting ? path.resolve(binarySetting) : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
const buildSteps = [];
if (!binarySetting && !external) {
    buildSteps.push(['go', ['build', '-trimpath', '-o', binary, './cmd/gotavern']]);
}
buildSteps.push(['go', ['build', '-trimpath', '-o', path.join(dataRoot, process.platform === 'win32' ? 'mock-provider.exe' : 'mock-provider'), './tools/mock-provider']]);
for (const [command, args] of buildSteps) {
    const build = spawn(command, args, { cwd: repoRoot, stdio: 'inherit' });
    const code = await new Promise(resolve => build.on('exit', resolve));
    if (code !== 0) {
        throw new Error(`${command} ${args.join(' ')} failed`);
    }
}

// RELEASE LAYOUT: `gotavern start` resolves InstallRoot as the directory of the executable
// (cmd/gotavern/main.go), and tokenizer routes look for <InstallRoot>/tokenizers. This probe builds
// the binary into a scratch directory, so without this the server silently takes the pinned
// fallback path (guesstimate counts, empty ids) and the two legs cannot be compared on token counts
// at all. A release puts `tokenizers/` beside the binary; stage the same layout instead of changing
// production code to make a probe work.
if (!external) {
    const tokenizerSource = path.join(repoRoot, 'upstream', 'tokenizers');
    const tokenizerTarget = path.join(dataRoot, 'tokenizers');
    if (await fs.stat(tokenizerSource).then(() => true, () => false)) {
        await fs.cp(tokenizerSource, tokenizerTarget, { recursive: true });
    } else {
        throw new Error(`tokenizer assets missing at ${tokenizerSource}; a release layout must stage them beside the binary`);
    }
}
const mock = spawn(path.join(dataRoot, process.platform === 'win32' ? 'mock-provider.exe' : 'mock-provider'), ['--responses', scriptPath, '--port', '0'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
let mockAddress = '';
mock.stdout.on('data', chunk => {
    const text = chunk.toString();
    const match = /mock-provider (\S+)/.exec(text);
    if (match) {
        mockAddress = match[1];
    }
});
for (let attempt = 0; attempt < 100 && !mockAddress; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 100));
}
if (!mockAddress) {
    throw new Error('mock provider did not report its address');
}

const server = external ? null : spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
const serverLog = [];
if (server) {
    server.stdout.on('data', chunk => serverLog.push(chunk.toString()));
    server.stderr.on('data', chunk => serverLog.push(chunk.toString()));
}

const report = {
    question: 'does a send driven from the pinned frontend produce a provider request?',
    gotavern: process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`,
    mockProvider: `http://${mockAddress}`,
    requestArrived: false,
    recording: null,
    pageErrors: [],
    generatedText: null,
    failure: null,
};

let browser;
// PROBE_BASE_URL points the identical drive at another server (pinned Node) for a differential, and
// the same factoring is what the provider comparison will need.
const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;
try {
    await waitFor(`${baseURL}/version`, 'server');
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error.message ?? error).slice(0, 300)));
    // EVERY console message, not just errors. The frontend reports several generation problems with
    // console.warn/console.debug rather than by throwing (for example the custom-endpoint guard in
    // openai.js:4476 uses console.debug), so a report that only kept page errors could show a clean
    // run for a send that the frontend itself refused to make.
    report.console = [];
    page.on('console', message => {
        report.console.push({ t: Math.round(message.timestamp ? message.timestamp() * 1000 : 0), type: message.type(), text: String(message.text()).slice(0, 500) });
    });
    // Every request and its status, unfiltered: a negative finding about a call needs a log that
    // would have shown it, so the log is complete rather than pre-filtered.
    report.requests = [];
    const pendingRequests = new Map();
    page.on('request', request => {
        const entry = { t: Date.now(), method: request.method(), url: new URL(request.url()).pathname + new URL(request.url()).search, status: null };
        report.requests.push(entry);
        pendingRequests.set(request, entry);
    });
    page.on('response', response => {
        const entry = pendingRequests.get(response.request());
        if (entry) {
            entry.status = response.status();
        }
    });
    // Which calls the frontend makes, and which of them the server answers with an error: the
    // probe reports arrival, but if nothing arrives this is what says why.
    report.httpFailures = [];
    page.on('response', response => {
        if (response.status() >= 400) {
            report.httpFailures.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
        }
    });
    page.on('requestfailed', request => {
        report.httpFailures.push(`FAILED ${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? ''}`);
    });
    // Attribute "HTML parsed as JSON" to the request that produced it, rather than inferring it
    // from the 404 list: wrap fetch inside the page and record status plus whether the body looks
    // like markup, so the finding names a URL.
    const instrumentFetch = process.env.PROBE_NO_FETCH_WRAPPER !== '1';
    if (instrumentFetch) await page.addInitScript(() => {
        window.__probeFetchLog = [];
        // Token counts are issued by jQuery.ajax (XMLHttpRequest), not fetch. Capture the XHR pair so
        // the two legs can be compared on the EXACT inputs the frontend asked both servers to count:
        // a different token count changes how much of the prompt fits and therefore the provider
        // request body.
        window.__probeXhrLog = [];
        const originalXhrOpen = XMLHttpRequest.prototype.open;
        const originalXhrSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function (method, url, ...rest) {
            this.__probeUrl = String(url);
            return originalXhrOpen.call(this, method, url, ...rest);
        };
        XMLHttpRequest.prototype.send = function (body) {
            if (String(this.__probeUrl).includes('/api/tokenizers/')) {
                const xhr = this;
                xhr.addEventListener('load', () => {
                    window.__probeXhrLog.push({
                        url: xhr.__probeUrl,
                        requestBody: typeof body === 'string' ? body : null,
                        status: xhr.status,
                        responseText: xhr.responseText,
                    });
                });
            }
            return originalXhrSend.call(this, body);
        };
        const originalFetch = window.fetch;
        window.fetch = async (...parameters) => {
            const request = parameters[0];
            const probeRequestUrl = typeof request === 'string' ? request : (request?.url ?? '');
            if (probeRequestUrl.includes('api/ping')) {
                (window.__probePingLog = window.__probePingLog ?? []).push({
                    phase: 'call', t: Math.round(performance.now()),
                    stack: String(new Error().stack).slice(0, 800),
                    hasSignal: Boolean(parameters[1]?.signal),
                });
            }
            let response;
            try {
                response = await originalFetch(...parameters);
            } catch (error) {
                if (probeRequestUrl.includes('api/ping')) {
                    (window.__probePingLog = window.__probePingLog ?? []).push({ phase: 'reject', t: Math.round(performance.now()), name: error?.name, message: String(error?.message) });
                }
                throw error;
            }
            if (probeRequestUrl.includes('api/ping')) {
                (window.__probePingLog = window.__probePingLog ?? []).push({ phase: 'response', t: Math.round(performance.now()), status: response.status });
            }
            if (probeRequestUrl.includes('/api/tokenizers/')) {
                let responseText = null;
                try {
                    responseText = await response.clone().text();
                } catch {
                    responseText = null;
                }
                (window.__probeTokenizerLog = window.__probeTokenizerLog ?? []).push({
                    url: probeRequestUrl,
                    requestBody: typeof parameters[1]?.body === 'string' ? parameters[1].body : null,
                    status: response.status,
                    responseText,
                });
            }
            const url = typeof request === 'string' ? request : (request?.url ?? '');
            // Do NOT read the body of a 204/304 or a bodiless response. The wrapper originally read
            // every clone, and `await clone().text()` on the 204 from POST /api/ping never settled in
            // this page, so pingServer() hung and the real generation stopped after
            // GENERATION_AFTER_COMMANDS with the composer still full. That was a probe artefact, not
            // a frontend behaviour: the same wrapper also runs on the pinned leg.
            let looksLikeMarkup = false;
            const bodiless = response.status === 204 || response.status === 205 || response.status === 304 || request?.method === 'HEAD';
            try {
                if (!bodiless) {
                    const text = await response.clone().text();
                    looksLikeMarkup = text.trimStart().startsWith('<');
                }
            } catch {
                looksLikeMarkup = false;
            }
            window.__probeFetchLog.push({ url, status: response.status, looksLikeMarkup });
            return response;
        };
    });
    await page.goto(`${baseURL}/`);
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60000 });

    // Load the captured user configuration into the page before driving, when the fixture exists.
    const fixturePath = path.join(here, 'fixtures', 'custom-source-settings.json');
    let capturedSettings = null;
    try {
        const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
        capturedSettings = fixture.capture?.oaiSettings ?? null;
    } catch {
        capturedSettings = null;
    }
    if (capturedSettings) {
        await page.evaluate(settings => {
            globalThis.__capturedSettings = settings;
        }, capturedSettings);
    }
    const outcome = await page.evaluate(async mockUrl => {
        // Faithful drive: load and select a character through the frontend's OWN functions, then send
        // through the UI button. The earlier version pushed into a temporary chat and called
        // Generate() with the frontend already mid-operation and no character bound, which a user
        // cannot do; it short-circuited on a guard and reported "no request" with no error.
        const script = await import('./script.js');
        const { oai_settings } = await import('./scripts/openai.js');
        const secretsModule = await import('./scripts/secrets.js');
        // The custom OpenAI-compatible source needs a key in secret_state; a user would paste one.
        await secretsModule.writeSecret(secretsModule.SECRET_KEYS.CUSTOM, 'probe-synthetic-key');

        await script.getCharacters();
        if (!Array.isArray(script.characters) || script.characters.length === 0) {
            return { preconditions: { charactersLoaded: false }, error: 'no characters available after getCharacters()' };
        }
        await script.selectCharacterById(0, { switchMenu: false });

        // Start from the CAPTURED user configuration when the fixture exists: the earlier drive set
        // three fields by hand and declined to send on BOTH servers, proving the configuration (not
        // the server) was the problem. The fixture is recorded from the frontend's own handlers.
        const captured = globalThis.__capturedSettings ?? null;
        if (captured) {
            Object.assign(oai_settings, captured);
        }
        if (!captured) {
        oai_settings.chat_completion_source = 'custom';
        oai_settings.custom_url = mockUrl;
        oai_settings.custom_model = 'probe-model';
        oai_settings.stream_openai = false;
        oai_settings.openai_max_context = 4096;
        oai_settings.openai_max_tokens = 64;
        }
        if (captured) {
            oai_settings.custom_url = mockUrl;
        }

        // The API dispatch flag is NOT part of oai_settings, and `main_api` is an exported `let` that
        // cannot be reassigned from outside its module, so the settings shortcut above leaves it at
        // whatever the page happened to load. sendGenerationRequest branches on it BEFORE looking at
        // the chat-completion source (script.js:6117), so a stale value sends the request down the
        // Horde path instead: horde.js:148 logged `8192 350` and /api/horde/text-workers was called,
        // and no chat-completions call was ever made -- identically on pinned Node and GoTavern. The
        // fix is to drive the control a user drives, `#main_api`, whose change handler assigns it
        // (script.js:7861).
        // A real user cannot act before the page has finished loading settings: `settingsReady`
        // (script.js:421, set at the end of getSettings) gates saveSettings, and a send started
        // while it is false leaves PromptManager's saveServiceSettings awaiting an event that a
        // gated save never emits. Measured: both servers emitted "Settings not ready" continuously
        // and the real (dryRun=false) generation stopped right after GENERATION_AFTER_COMMANDS while
        // a prompt-manager dry run proceeded. Wait for the same readiness a user waits for.
        // FIRST-RUN ONBOARDING. A fresh data root has settings.firstRun=true, and getSettings
        // AWAITS doOnboarding() (script.js:8041), which is a user-input popup; settingsReady stays
        // false until the user completes it. A real first-run user fills the name and clicks OK, so
        // the drive does exactly that instead of acting on a page no user could act on.
        const onboarding = document.querySelector('.popup .onboarding');
        const onboardingCompleted = Boolean(onboarding);
        if (onboarding) {
            const nameInput = onboarding.closest('.popup')?.querySelector('.popup-input');
            if (nameInput) {
                nameInput.value = 'Probe User';
                nameInput.dispatchEvent(new Event('input', { bubbles: true }));
            }
            const okButton = onboarding.closest('.popup')?.querySelector('.popup-button-ok');
            if (okButton) {
                okButton.click();
            }
        }
        const readinessDeadline = performance.now() + 60000;
        let settingsReady = false;
        let readinessDiagnostics = null;
        while (performance.now() < readinessDeadline) {
            const scriptModule = await import('./script.js');
            settingsReady = Boolean(scriptModule.settingsReady);
            if (settingsReady) break;
            readinessDiagnostics = {
                onboardingCompleted,
                firstRun: scriptModule.settings?.firstRun ?? null,
                hasSettings: Boolean(scriptModule.settings),
                settingsKeys: scriptModule.settings ? Object.keys(scriptModule.settings).length : 0,
                onboardingPresent: Boolean(document.querySelector('#onboarding_template')),
                popupText: (document.querySelector('.popup')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
            };
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (!settingsReady) {
            return { preconditions: { charactersLoaded: true, settingsReady: false, readiness: readinessDiagnostics }, error: 'settingsReady never became true within 60s' };
        }
        const mainApiSelect = document.querySelector('#main_api');
        if (!mainApiSelect) {
            return { preconditions: { charactersLoaded: true }, error: '#main_api is not present, so the API cannot be selected the way a user selects it' };
        }
        mainApiSelect.value = 'openai';
        mainApiSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 1000));

        const diagnostics = () => ({
            // The API dispatch flag, which is NOT in oai_settings: sendGenerationRequest branches on
            // it (script.js:6117) before it ever looks at the chat-completion source.
            mainApi: String(script.main_api),
            thisChid: typeof script.this_chid === 'undefined' ? 'undefined' : String(script.this_chid),
            charactersLength: Array.isArray(script.characters) ? script.characters.length : 'not-array',
            chatLength: Array.isArray(script.chat) ? script.chat.length : 'not-array',
            isGenerating: Boolean(script.isGenerating),
            generatingAttribute: document.body.dataset.generating ?? null,
            sendButtonDisabled: Boolean(document.querySelector('#send_but')?.disabled),
            hasSendButton: Boolean(document.querySelector('#send_but')),
            // The frontend reports a refused generation through toastr, not through the console: a
            // caught error renders a toast and fires generation_ended with no page error at all. A
            // probe that only watched pageErrors and /api calls saw "nothing happened".
            toastr: (document.querySelector('#toast-container')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
        });
        // CONNECT. A chat-completion send is silently ignored when online_status is 'no_connection'
        // (script.js:4391 returns before the composer is touched), and online_status is only set by
        // the frontend's own connection check. A user presses Connect after entering the endpoint and
        // key, so the drive presses the same control and waits for the status to change. Measured
        // first: without this, the real generation stopped right after GENERATION_AFTER_COMMANDS with
        // the composer untouched and no user message appended.
        const connectButton = document.querySelector('#api_button_openai');
        if (connectButton) {
            connectButton.click();
        } else {
            const fallbackConnect = document.querySelector('#api_button_openai, .api_button[data-server-connect="openai"]');
            fallbackConnect?.click();
        }
        const connectionDeadline = performance.now() + 30000;
        let onlineStatus = 'unknown';
        while (performance.now() < connectionDeadline) {
            const scriptModule = await import('./script.js');
            onlineStatus = String(scriptModule.online_status);
            if (onlineStatus !== 'no_connection' && onlineStatus !== 'unknown') break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (onlineStatus === 'no_connection') {
            return { preconditions: { charactersLoaded: true, settingsReady: true, onlineStatus, connectButtonPresent: Boolean(connectButton) }, error: 'the frontend never reached a connected online_status; a send is silently ignored in that state' };
        }
        const before = diagnostics();
        // Preconditions a real user action implies. Asserted, not assumed: an unfaithful drive must
        // fail loudly instead of reporting a false negative.
        if (before.thisChid === 'undefined' || before.charactersLength === 0) {
            return { preconditions: { charactersLoaded: false, ...before }, error: 'no character bound before the send' };
        }
        // The user-facing gate is the DOM/live flag the frontend itself uses (body[data-generating]
        // and the disabled send button), not the internal isGenerating variable, which reports true
        // on a freshly loaded page and would reject a legitimate user state.
        if (before.generatingAttribute !== null || before.sendButtonDisabled) {
            return { preconditions: { charactersLoaded: true, ...before }, error: 'the send button was not in a user-sendable state' };
        }

        const composer = document.querySelector('#send_textarea');
        if (composer) {
            composer.value = 'probe user marker';
            composer.dispatchEvent(new Event('input', { bubbles: true }));
        }
        const sendButton = document.querySelector('#send_but');
        // Record the frontend's own generation events. A run that reaches generate_after_data and
        // then never issues a request is indistinguishable, from the request log alone, from one
        // that never assembled a prompt at all; the event trail names the last stage that completed,
        // and CHAT_COMPLETION_SETTINGS_READY is emitted immediately before the fetch.
        const { eventSource, event_types } = await import('./scripts/events.js');
        // Measurement only: wrap emit to record EVERY event name and whether its promise settles.
        // An emitted-but-never-settled event is the await the real generation is stuck on, which the
        // request log cannot show because the deadlock is purely in frontend promises.
        const namesByValue = new Map(Object.entries(event_types).map(([eventName, eventValue]) => [eventValue, eventName]));
        globalThis.__probeEmitLog = [];
        const originalEmit = eventSource.emit.bind(eventSource);
        eventSource.emit = (eventValue, ...args) => {
            const eventName = namesByValue.get(eventValue) ?? String(eventValue);
            const entry = { name: eventName, t: Math.round(performance.now()), settled: false };
            globalThis.__probeEmitLog.push(entry);
            const result = originalEmit(eventValue, ...args);
            if (result && typeof result.then === 'function') {
                result.then(() => { entry.settled = true; }, () => { entry.settled = 'rejected'; });
            } else {
                entry.settled = true;
            }
            return result;
        };
        globalThis.__probeEvents = [];
        for (const [name, value] of Object.entries(event_types)) {
            if (!['GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'GENERATE_BEFORE_COMBINE_PROMPTS', 'GENERATE_AFTER_COMBINE_PROMPTS', 'CHAT_COMPLETION_PROMPT_READY', 'GENERATE_AFTER_DATA', 'CHAT_COMPLETION_SETTINGS_READY', 'GENERATION_ENDED', 'GENERATION_STOPPED'].includes(name)) {
                continue;
            }
            eventSource.on(value, (...args) => globalThis.__probeEvents.push({
                name,
                t: Math.round(performance.now()),
                // GENERATION_STARTED(-ish) emits dryRun as the third argument; GENERATE_AFTER_DATA
                // as the second. Recording it separates a prompt-assembly dry run from the real
                // send, which is invisible if only the event name is kept.
                dryRun: JSON.stringify(args.map(argument => (typeof argument === 'boolean' ? argument : (argument && typeof argument === 'object' ? Object.keys(argument).slice(0, 6) : typeof argument)))),
            }));
        }
        globalThis.__probeClickT = Date.now();
        globalThis.__probeClickPerf = Math.round(performance.now());
        sendButton.click();

        // A short settle is enough to let the click register; the WAIT for the request happens below,
        // against the recorded request log, because prompt assembly (world-info dry run plus a token
        // count per candidate) legitimately takes longer than any fixed sleep would guess.
        await new Promise(resolve => setTimeout(resolve, 3000));
        // Post-send measurement: whether the user message was appended (sendMessageAsUser got past
        // saveChatConditional) and whether a token count issued from the page can still complete.
        // This distinguishes "stuck inside sendMessageAsUser" from "never reached it".
        const tokenizersModule = await import('./scripts/tokenizers.js');
        const tokenCountProbe = await Promise.race([
            tokenizersModule.getTokenCountAsync('probe user marker', 0).then(value => `resolved:${value}`, error => `rejected:${String(error?.message ?? error)}`),
            new Promise(resolve => setTimeout(() => resolve('timeout'), 4000)),
        ]);
        const scriptModule = await import('./script.js');
        const manualPing = await Promise.race([
            fetch('api/ping', { method: 'POST', headers: scriptModule.getRequestHeaders?.({ omitContentType: true }) ?? {} })
                .then(async response => `status:${response.status}:${(await response.text()).slice(0, 60)}`, error => `error:${error.name}:${error.message}`),
            new Promise(resolve => setTimeout(() => resolve('timeout'), 5000)),
        ]);
        const postSend = {
            manualPing,
            toastrAfter: (document.querySelector('#toast-container')?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 300),
            chatLength: Array.isArray(scriptModule.chat) ? scriptModule.chat.length : 'not-array',
            chatDomMessages: document.querySelectorAll('#chat .mes').length,
            textareaValue: String(document.querySelector('#send_textarea')?.value ?? ''),
            tokenCountProbe,
            emitPending: (globalThis.__probeEmitLog ?? []).filter(entry => entry.settled === false).map(entry => entry.name),
        };
        return { preconditions: { charactersLoaded: true, ...before }, error: null, after: diagnostics(), postSend };
    }, `http://${mockAddress}`);

    report.htmlIntoJson = await page.evaluate(() => (window.__probeFetchLog ?? []).filter(entry => entry.looksLikeMarkup));
    report.fetchFailures = await page.evaluate(() => (window.__probeFetchLog ?? []).filter(entry => entry.status >= 400));
    report.events = await page.evaluate(() => globalThis.__probeEvents ?? []);
    report.clickT = await page.evaluate(() => globalThis.__probeClickT ?? null);
    report.emitLog = await page.evaluate(() => (globalThis.__probeEmitLog ?? []).filter(entry => entry.t >= (globalThis.__probeClickPerf ?? 0) - 50));
    report.requestsAfterClick = report.requests.filter(entry => report.clickT !== null && entry.t >= report.clickT - 50);
    report.pingLog = await page.evaluate(() => globalThis.__probePingLog ?? []);
    report.tokenizerLog = await page.evaluate(() => globalThis.__probeTokenizerLog ?? []);
    report.xhrLog = await page.evaluate(() => globalThis.__probeXhrLog ?? []);
    report.diagnostics = outcome.preconditions ?? null;
    report.postSend = outcome.postSend ?? null;
    if (outcome.error) {
        report.failure = `Generate threw: ${outcome.error}`;
    }

    // Poll the recorder rather than the page: arrival is the fact under test. 300 attempts at 200ms
    // is a 60s window, which prompt assembly has repeatedly needed: the world-info dry run counts
    // every candidate, and the earlier 20s window gave up while token counts were still in flight.
    for (let attempt = 0; attempt < 300; attempt++) {
        const recording = await (await fetch(`http://${mockAddress}/__mock/recording`)).json();
        if ((recording.requests ?? []).length > 0) {
            report.requestArrived = true;
            report.recording = recording.requests.map(request => {
                const rawBody = request.bodyText ?? (request.bodyBase64 ? Buffer.from(request.bodyBase64, 'base64').toString('utf8') : null);
                let parsedBody = null;
                try {
                    parsedBody = rawBody ? JSON.parse(rawBody) : null;
                } catch {
                    parsedBody = null;
                }
                return {
                    method: request.method,
                    path: request.rawTarget,
                    bodyLength: request.bodyLength,
                    body: rawBody,
                    bodySha256: request.bodySha256,
                    model: parsedBody?.model ?? null,
                    messageCount: Array.isArray(parsedBody?.messages) ? parsedBody.messages.length : null,
                };
            });            break;
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!report.requestArrived) {
        report.failure = report.failure ?? 'no provider request arrived within 20s';
    }
} catch (error) {
    report.failure = String(error.message ?? error);
} finally {
    if (browser) {
        await browser.close();
    }
    server?.kill();
    mock.kill();
    // The scratch directory holds a built binary and a mock binary -- about 78 MB per run, and
    // twenty-nine abandoned copies of it filled the disk to 0.09 GB free, which then failed an
    // unrelated `go build` inside a differential with "not enough space on the disk". Clean up by
    // default; GOTAVERN_KEEP_TEMP=1 keeps it when a failed run needs its artifacts.
    if (process.env.GOTAVERN_KEEP_TEMP !== '1') {
        // Retries, because Windows keeps the just-killed binaries' handles open for a moment: the
        // first attempt after SIGKILL fails with EBUSY and an unconditional catch would hide it,
        // which is how twenty-nine copies accumulated without anything reporting a problem.
        await new Promise(resolve => setTimeout(resolve, 300));
        await fs.rm(dataRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 }).catch(error => {
            console.error(`probe: could not remove ${dataRoot}: ${error.message}`);
        });
    }
}

const reportPath = path.resolve(process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : path.join(repoRoot, 'tests', 'browser', 'generation-probe-report.json'));
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exit(0);
