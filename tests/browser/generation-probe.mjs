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

const binarySetting = process.env.GOTAVERN_BINARY ?? '';
const binary = binarySetting ? path.resolve(binarySetting) : path.join(dataRoot, process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
const buildSteps = [];
if (!binarySetting) {
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

const server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
const serverLog = [];
server.stdout.on('data', chunk => serverLog.push(chunk.toString()));
server.stderr.on('data', chunk => serverLog.push(chunk.toString()));

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
    // Every request and its status, unfiltered: a negative finding about a call needs a log that
    // would have shown it, so the log is complete rather than pre-filtered.
    report.requests = [];
    const pendingRequests = new Map();
    page.on('request', request => {
        const entry = { method: request.method(), url: new URL(request.url()).pathname + new URL(request.url()).search, status: null };
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
    await page.addInitScript(() => {
        window.__probeFetchLog = [];
        const originalFetch = window.fetch;
        window.fetch = async (...parameters) => {
            const response = await originalFetch(...parameters);
            const request = parameters[0];
            const url = typeof request === 'string' ? request : (request?.url ?? '');
            let looksLikeMarkup = false;
            try {
                const text = await response.clone().text();
                looksLikeMarkup = text.trimStart().startsWith('<');
            } catch {
                looksLikeMarkup = false;
            }
            window.__probeFetchLog.push({ url, status: response.status, looksLikeMarkup });
            return response;
        };
    });
    await page.goto(`${baseURL}/`);
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 60000 });

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

        oai_settings.chat_completion_source = 'custom';
        oai_settings.custom_url = mockUrl;
        oai_settings.custom_model = 'probe-model';
        oai_settings.stream_openai = false;
        oai_settings.openai_max_context = 4096;
        oai_settings.openai_max_tokens = 64;

        const diagnostics = () => ({
            thisChid: typeof script.this_chid === 'undefined' ? 'undefined' : String(script.this_chid),
            charactersLength: Array.isArray(script.characters) ? script.characters.length : 'not-array',
            chatLength: Array.isArray(script.chat) ? script.chat.length : 'not-array',
            isGenerating: Boolean(script.isGenerating),
            generatingAttribute: document.body.dataset.generating ?? null,
            sendButtonDisabled: Boolean(document.querySelector('#send_but')?.disabled),
            hasSendButton: Boolean(document.querySelector('#send_but')),
        });
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
        sendButton.click();

        // Give the frontend time to build and post the request.
        await new Promise(resolve => setTimeout(resolve, 8000));
        return { preconditions: { charactersLoaded: true, ...before }, error: null, after: diagnostics() };
    }, `http://${mockAddress}`);

    report.htmlIntoJson = await page.evaluate(() => (window.__probeFetchLog ?? []).filter(entry => entry.looksLikeMarkup));
    report.fetchFailures = await page.evaluate(() => (window.__probeFetchLog ?? []).filter(entry => entry.status >= 400));
    report.diagnostics = outcome.preconditions ?? null;
    if (outcome.error) {
        report.failure = `Generate threw: ${outcome.error}`;
    }

    // Poll the recorder rather than the page: arrival is the fact under test.
    for (let attempt = 0; attempt < 100; attempt++) {
        const recording = await (await fetch(`http://${mockAddress}/__mock/recording`)).json();
        if ((recording.requests ?? []).length > 0) {
            report.requestArrived = true;
            report.recording = recording.requests.map(request => ({
                method: request.method,
                path: request.rawTarget,
                bodyLength: request.bodyLength,
                bodyKeys: Object.keys(JSON.parse(request.body ?? '{}')).slice(0, 12),
                bodySha256: request.bodySha256,
                model: (() => {
                    try {
                        return JSON.parse(request.body ?? '{}').model ?? null;
                    } catch {
                        return null;
                    }
                })(),
                messageCount: (() => {
                    try {
                        const parsed = JSON.parse(request.body ?? '{}');
                        return Array.isArray(parsed.messages) ? parsed.messages.length : null;
                    } catch {
                        return null;
                    }
                })(),
            }));
            break;
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
    server.kill();
    mock.kill();
}

const reportPath = path.resolve(process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : path.join(repoRoot, 'tests', 'browser', 'generation-probe-report.json'));
await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exit(0);
