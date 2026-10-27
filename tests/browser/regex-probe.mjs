// THE REGEX LEG: does a rule REALLY run, at the placement the pinned frontend asks about, and does its
// result reach the FINAL PROVIDER REQUEST on one turn and deliberately not on another?
//
// WHY THIS IS A SEPARATE PROBE. `preset-kit.mjs` proves prompt ASSEMBLY and `real-preset-probe.mjs` proves a
// user's preset file changes the context. Neither can say "this rule executed": a settings file that
// carries `extension_settings.regex` loads identically whether its rules fire, are skipped by a flag, or are
// ignored by the subject. The observation that distinguishes those is the provider body paired with the
// rendered DOM, for the same turn, on the same page, with the rules present in the user's own settings.
//
// THE TURN STRUCTURE, AND WHERE EACH CASE COMES FROM (pinned source, read at 06bde939):
//
//   chat[0]  the greeting. `messageFormatting` treats messageId 0 specially (public/script.js:1805-1812:
//            macro substitution) and the DISPLAY path is the only caller that passes `isMarkdown`
//            (:1860-1864), so this is where a display-only rule can be observed at all.
//   chat[1]  the previous user turn. Its depth in a prompt assembly is 1
//            (`coreChat.length - index - (isContinue ? 2 : 1)`, :4504), which is what makes a `minDepth: 1`
//            rule fire for it and not for the turn being sent.
//   chat[2]  the turn to be sent, typed into the composer. `sendMessageAsUser` applies USER_INPUT before
//            the message is PUSHED (:5875-5886), so it is stored already rewritten and its prompt depth is
//            0 (:4504) -- which is why the depth rule must NOT touch it.
//
//   SEND      click #send_but   -> a new user turn, type 'normal'
//   REGENERATE click #option_regenerate -> `Generate('regenerate')` (:11640). This is the USER'S OWN
//             control and it matters for a measured reason: the send path TRUNCATES the last assistant
//             turn when it does not end in whitespace (:6357-6371, "Never run, unless in continue mode" /
//             `continue_` handling), so after ONE send+reply the assistant turn is a prefix of the reply and
//             a display rule's output is not reliably present in it. Regenerating re-renders that turn from
//             the FULL reply text, which is what a user sees when they press the button twice because the
//             first answer was unsatisfactory.
//
// WHAT IT RECORDS per leg: the settings the page holds, the rules in play, the product's own per-side
// answers (`getRegexedString` with the display flags and with the prompt flags -- the product, not a
// reimplementation), the rendered DOM after each step, and every provider request the peer received.
//
// WHAT IT REFUSES. It refuses to report a pass when the kit's own self-check failed (no rule fired at all =>
// every negative is vacuous), when no `chat/completions` request arrived, or when the peer did not receive
// at least the two requests the cases need. Each refusal is a named `failure`.
//
// THE EXPECTATIONS LIVE IN THE COMPARATOR (compare-regex-legs.mjs). This file records. The single exception
// is the harness-faithfulness gate, which must sit where the measurement is taken (AGENTS.md rule 50).
//
// Usage (GoTavern leg; boots the subject itself, or is pointed at one by PROBE_BASE_URL):
//   node regex-probe.mjs --data-root <tree> --variant <variant> --report <path>
// The pinned leg runs this same file under run-against-pinned.mjs, which supplies --base-url.

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { seedLegConfig } from './seed-leg-config.mjs';
import { MARKERS, PROBE_USER_NAME, REGEX_SCENARIO, REGEX_VARIANTS, applyNegation, applyRegexKit, negationFor, regexRules, turnText } from './regex-kit.mjs';

const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

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

async function waitForServer(url, deadlineMs = 180000) {
    const deadline = Date.now() + deadlineMs;
    let last = 'no attempt';
    while (Date.now() < deadline) {
        try {
            const response = await fetch(url);
            if (response.status < 500) return true;
            last = `status ${response.status}`;
        } catch (error) {
            last = String(error?.message ?? error);
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${url} did not answer within ${deadlineMs} ms (${last})`);
}

// ===================================================================================================
// THE RECORDING PEER. It captures each request and answers deterministically FROM THE REQUEST (GOAL.md
// §8.1): the reply names the probe tokens that arrived, so a leg that sent a different context produces a
// visibly different rendered reply and nothing can compare equal by accident. It never defines correctness
// (rule 49).
// ===================================================================================================
function startPeer() {
    const requests = [];
    const server = http.createServer((request, response) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const body = Buffer.concat(chunks);
            const headers = {
                'content-type': 'application/json',
                'access-control-allow-origin': '*',
                'access-control-allow-headers': request.headers['access-control-request-headers'] ?? '*',
                'access-control-allow-methods': 'GET,POST,OPTIONS',
            };
            if (request.method === 'OPTIONS') {
                response.writeHead(204, headers);
                response.end();
                return;
            }
            const text = body.toString('utf8');
            if (request.method === 'GET' && /models/.test(request.url ?? '')) {
                response.writeHead(200, headers);
                response.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model' }] }));
                return;
            }
            const arrived = [...new Set(String(text).match(/RXQ_[A-Z]+_[A-Z0-9]+/g) ?? [])].sort();
            requests.push({
                method: request.method,
                path: request.url,
                contentType: request.headers['content-type'] ?? null,
                byteLength: body.length,
                sha256: createHash('sha256').update(body).digest('hex'),
                body: text,
                arrived,
            });
            response.writeHead(200, headers);
            // NO TRAILING WHITESPACE, deliberately: the send path trims a trailing partial word
            // (script.js:6357-6371), and a reply that ends in a newline would make the displayed text
            // depend on that trim rather than on the rule under test.
            response.end(JSON.stringify({
                id: 'chatcmpl-regex-probe',
                object: 'chat.completion',
                created: 1730000000,
                model: 'probe-model',
                choices: [{
                    index: 0,
                    message: { role: 'assistant', content: `REPLY_${requests.length} saw ${arrived.join(',') || 'none'}` },
                    finish_reason: 'stop',
                }],
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

// ===================================================================================================
// THE SETTINGS THE RULES LIVE IN. `extension_settings.regex` is the GLOBAL rule set (engine.js:112-113) and
// `preset_allowed_regex[apiId]` / `character_allowed_regex` are the consent lists
// (engine.js:114-127, :166-220). All three are members of the frontend's own `settings.json` -- the file
// `saveSettings` writes -- so the harness writes that file BEFORE boot and the frontend loads it. That is
// the state of a user who has rules and has accepted the frontend's own prompt, and it means no part of the
// product is patched to install a rule.
//
// WHY THE GLOBAL SET AND NOT THE PRESET'S OWN `extensions.regex_scripts`. Preset-scoped rules are read from
// the preset that is IN USE through `readPresetExtensionField` (engine.js:121-127), so proving one fires
// would also have to prove preset selection, which the preset lane owns. The global set runs through the
// SAME engine, the SAME placement enum, the SAME SCRIPT_TYPES order and the SAME call sites; only the array
// this file wrote differs. That keeps a red attributable to the rule engine rather than to preset selection,
// and the artefact says so in `notProven`.
// ===================================================================================================
async function writeSettingsFragment(dataRoot, rules) {
    const settingsPath = path.join(dataRoot, 'default-user', 'settings.json');
    await fs.mkdir(path.dirname(settingsPath), { recursive: true });
    let settings = {};
    const existed = await fs.stat(settingsPath).then(() => true, () => false);
    if (existed) {
        settings = JSON.parse(await fs.readFile(settingsPath, 'utf8'));
    }
    // THE SPEAKER NAME MUST COME FROM THE SCENARIO, NOT FROM WHICHEVER TREE SEEDED A SETTINGS FILE.
    // Measured in run 40476961120: this leg CREATED settings.json (`existed:false`) and the pinned leg
    // MERGED into one the pinned server had already seeded (`existed:true`), which carried a `username`.
    // So pinned sent `Probe User` and GoTavern sent `[Unnamed Persona]` (personas.js:237, the placeholder
    // for a nameless persona) -- a 21-byte difference in EVERY request, on EVERY variant, that looks
    // exactly like a product defect and is an ASYMMETRIC PRECONDITION. `name1` is `settings.username`
    // (script.js:7931), so pinning it here makes both legs send the same speaker and turns the 21 bytes
    // into a real comparison.
    settings.username = PROBE_USER_NAME;
    settings.extension_settings = settings.extension_settings ?? {};    const extensionSettings = settings.extension_settings;
    extensionSettings.regex = rules;
    // Consent, for the click the frontend's own prompt would make (regex/index.js:1327-1337). Written
    // because a fresh accountStorage shows that dialog ONCE and the leg would then be racing a modal; the
    // leg RECORDS what the frontend reports about consent, so a subject that ignored this list shows up as
    // `rulesInPlay: 0` rather than as "the rule did nothing".
    extensionSettings.preset_allowed_regex = extensionSettings.preset_allowed_regex ?? {};
    extensionSettings.character_allowed_regex = extensionSettings.character_allowed_regex ?? [];
    // THE RULE ENGINE'S OWN GLOBAL OFF SWITCH is asserted OFF, because `getRegexedString` returns the input
    // untouched when it is on (engine.js:342) -- a single entry here would make every case pass for one
    // unrelated reason.
    extensionSettings.disabledExtensions = Array.isArray(extensionSettings.disabledExtensions)
        ? extensionSettings.disabledExtensions.filter(name => name !== 'regex')
        : [];
    await fs.writeFile(settingsPath, `${JSON.stringify(settings, null, 4)}\n`);
    return { settingsPath: path.relative(dataRoot, settingsPath).split(path.sep).join('/'), existed, ruleCount: rules.length };
}

// ===================================================================================================
// ARGUMENTS AND SUBJECT.
// ===================================================================================================
const variant = argumentValue('--variant', 'baseline');
// THE NEGATION IS THE VARIANT, and an unknown one is refused: a typo in the workflow must not run the
// baseline twice and report two identical captures as a discriminating pair.
if (!REGEX_VARIANTS.includes(variant)) {
    throw new Error(`--variant must be one of ${REGEX_VARIANTS.join(', ')}, got ${JSON.stringify(variant)}`);
}
const reportPath = path.resolve(argumentValue('--report', path.join(here, `regex-${variant}-leg.json`)));
const dataRoot = path.resolve(argumentValue('--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-regex-')));
const external = Boolean(process.env.PROBE_BASE_URL);
const rules = applyNegation(regexRules(), negationFor(variant));

const report = {
    schemaVersion: 1,
    question: 'Does a regex rule really execute on this subject, at the pinned placement, on the turn the pinned frontend says it applies to, and does its result reach the FINAL provider request (or deliberately not)?',
    scenario: REGEX_SCENARIO,
    variant,
    subject: external ? 'pinned' : 'gotavern',
    rules: rules.map(rule => ({
        id: rule.id,
        scriptName: rule.scriptName,
        placement: rule.placement,
        disabled: Boolean(rule.disabled),
        markdownOnly: Boolean(rule.markdownOnly),
        promptOnly: Boolean(rule.promptOnly),
        minDepth: rule.minDepth ?? null,
        maxDepth: rule.maxDepth ?? null,
        // The BODIES are recorded because they ARE the scenario, and they are synthetic ASCII markers.
        findRegex: rule.findRegex,
        replaceString: rule.replaceString,
    })),
    settings: null,
    steps: [],
    rulesInPlay: null,
    sides: null,
    perTurn: null,
    displayOnlyUserTurn: null,
    order: null,
    case7: null,
    rawChat: null,
    chatIdentity: null,
    storedCandidates: null,
    storedChat: null,
    rendered: {},
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

const chatCompletions = () => report.peerRequests.filter(entry => /chat\/completions/.test(entry.path ?? ''));

const peer = await startPeer();
let server = null;
let browser = null;
try {
    report.settings = await writeSettingsFragment(dataRoot, rules);

    const port = await freePort();
    if (!external) {
        const binarySetting = process.env.GOTAVERN_BINARY ?? '';
        if (!binarySetting) throw new Error('GOTAVERN_BINARY is required for the GoTavern leg');
        const binary = path.resolve(binarySetting);
        // The tokenizer tree, so the frontend's own budget arithmetic is the same one every other leg runs
        // against. Absent it the frontend answers a Guesstimate and assembly still proceeds.
        await fs.cp(path.join(repoRoot, 'upstream', 'tokenizers'), path.join(dataRoot, 'tokenizers'), { recursive: true }).catch(() => {});
        await seedLegConfig(dataRoot);
        server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
        server.stdout.on('data', () => {});
        server.stderr.on('data', () => {});
    }
    const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;
    await waitForServer(`${baseURL}/version`);

    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 400)));
    page.on('console', message => report.console.push({ type: message.type(), text: String(message.text()).slice(0, 400) }));
    // No live network from the page: the CDN the frontend probes is refused, exactly as the other legs do.
    await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());

    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 180000 });
    step('page-loaded', true);

    // THE KIT IS INSTALLED, NOT RE-DEFINED: one definition (regex-kit.mjs) shared with the expectation side.
    await page.addScriptTag({ content: `globalThis.__applyRegexKit = (${applyRegexKit.toString()});` });
    const spec = {
        markers: MARKERS,
        // THE VARIANT TRAVELS WITH THE SPEC, because the self-check's positive control depends on it: R1 is
        // DELIBERATELY disabled in `disabled-rewrite`, so "R1 must fire" is the correct expectation in the
        // baseline and the WRONG one there. Measured in run 40468846644, where the baseline legs passed the
        // whole self-check on BOTH subjects and the disabled-rewrite leg failed it for firing the baseline's
        // expectation -- the harness demanding a control its own variant had switched off.
        variant,
        // The three turns, and WHY each exists, are documented at the top of this file. `send` is the text
        // typed into the composer; the previous turn is what makes depth 1 reachable.
        turns: [
            { isUser: false, text: MARKERS.greeting },
            { isUser: true, text: MARKERS.previousTurn },
        ],
        send: turnText(),
    };

    // THE READINESS A USER WAITS FOR. `settingsReady` is set at the end of getSettings, and a first run shows
    // the onboarding popup that a real user fills in; the drive fills the same field and clicks the same
    // button instead of skipping a state a user cannot skip (generation-probe.mjs:956-992).
    const ready = await page.evaluate(async () => {
        const script = await import('./script.js');
        const deadline = performance.now() + 120000;
        while (performance.now() < deadline) {
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

    // THE RULES MUST BE IN PLAY BEFORE ANYTHING IS MEASURED, and they are read from the PAGE rather than
    // from the file this process wrote: a subject that discarded the member cannot then pass because the
    // file exists on disk.
    const inPlay = await page.evaluate(async () => {
        const extensions = await import('./scripts/extensions.js');
        const engine = await import('./scripts/extensions/regex/engine.js');
        const settings = extensions.extension_settings ?? {};
        const rules = Array.isArray(settings.regex) ? settings.regex : [];
        return {
            count: rules.length,
            disabledNames: rules.filter(rule => rule.disabled).map(rule => rule.scriptName),
            regexExtensionDisabled: Array.isArray(settings.disabledExtensions) && settings.disabledExtensions.includes('regex'),
            ids: rules.map(rule => rule.id),
            // The consent the engine checks with `allowedOnly` (engine.js:121-127): the same array the
            // frontend's own prompt writes.
            presetAllowedRegex: settings.preset_allowed_regex ?? null,
            // The placement enum and the script-type priority, read from the subject so the artefact can
            // show which enum the leg actually ran against.
            placementEnum: engine.regex_placement,
            scriptTypes: engine.SCRIPT_TYPES,
        };
    });
    report.rulesInPlay = inPlay;
    const rulesPresent = inPlay.count === rules.length && inPlay.regexExtensionDisabled === false;
    step('rules-in-play', rulesPresent,
        `the page reports ${inPlay.count} global regex rule(s) and disabledExtensions.includes('regex')=${inPlay.regexExtensionDisabled}; this leg wrote ${rules.length}`);

    // THE SCENARIO'S SELF-CHECK RUNS BEFORE ANY SEND. A kit whose sides all equal their inputs means the
    // rules are inert on THIS subject, and every negative below would then pass for the wrong reason.
    const kit = await page.evaluate(specification => globalThis.__applyRegexKit(specification), spec);
    report.sides = kit.sides ?? null;
    report.perTurn = kit.perTurn ?? null;
    report.displayOnlyUserTurn = kit.displayOnlyUserTurn ?? null;
    report.order = kit.order ?? null;
    report.case7 = kit.case7 ?? null;
    report.rawChat = kit.rawChat ?? null;
    report.kitSteps = kit.steps ?? [];
    const kitProblems = kit.problems ?? [];
    step('kit-self-check', kitProblems.length === 0, kitProblems.length === 0 ? null : kitProblems.join(' | '));

    // THE CONNECTION, through the frontend's own settings member and its own connect control.
    const connected = await page.evaluate(async ({ url, model }) => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        const secretsModule = await import('./scripts/secrets.js');
        await secretsModule.writeSecret(secretsModule.SECRET_KEYS.custom, 'probe-synthetic-key');
        const settings = openai.oai_settings;
        settings.chat_completion_source = 'custom';
        settings.custom_url = url;
        settings.custom_model = model;
        settings.stream_openai = false;
        settings.openai_max_context = 8192;
        settings.openai_max_tokens = 128;
        // THE API DISPATCH FLAG IS DRIVEN THROUGH ITS OWN CONTROL: `main_api` is an exported `let`, and a
        // stale value sends the request down another backend's path so no chat-completions request is ever
        // made -- measured identically on both subjects in the generation lane
        // (generation-probe.mjs:942-949).
        const mainApiSelect = document.querySelector('#main_api');
        if (!mainApiSelect) return { error: '#main_api is not present' };
        mainApiSelect.value = 'openai';
        mainApiSelect.dispatchEvent(new Event('change', { bubbles: true }));
        const connect = document.querySelector('#api_button_openai');
        if (connect) connect.click();
        const deadline = performance.now() + 30000;
        while (performance.now() < deadline) {
            if (String(script.online_status) !== 'no_connection' && String(script.online_status) !== 'unknown') break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return { onlineStatus: String(script.online_status), connectPresent: Boolean(connect), source: settings.chat_completion_source, url: settings.custom_url };
    }, { url: `http://127.0.0.1:${peer.port}/v1`, model: 'probe-model' });
    const connectionOk = connected?.onlineStatus && connected.onlineStatus !== 'no_connection' && connected.onlineStatus !== 'unknown';
    step('connected', Boolean(connectionOk), JSON.stringify(connected));

    const readRendered = async label => {
        report.rendered[label] = await page.evaluate(() => [...document.querySelectorAll('#chat .mes')].map(element => ({
            mesid: element.getAttribute('mesid'),
            isUser: element.getAttribute('is_user'),
            text: (element.querySelector('.mes_text')?.innerText ?? '').trim().slice(0, 4000),
        })));
        return report.rendered[label];
    };

    const applyKit = async () => {
        const result = await page.evaluate(specification => globalThis.__applyRegexKit(specification), spec);
        return result;
    };

    // -----------------------------------------------------------------------------------------------
    // STEP 1: THE SEND. The composer is typed and #send_but clicked -- the user path. The chat is rebuilt
    // from the spec immediately before the click because the connect path may have reloaded a chat.
    // -----------------------------------------------------------------------------------------------
    if (connectionOk) {
        const kitBeforeSend = await applyKit();
        if ((kitBeforeSend.problems ?? []).length > 0) report.kitProblemsBeforeSend = kitBeforeSend.problems;
        await readRendered('beforeSend');
        const sendResult = await page.evaluate(async ({ text }) => {
            const script = await import('./script.js');
            const composer = document.querySelector('#send_textarea');
            if (!composer) return { error: '#send_textarea is not present' };
            composer.value = text;
            composer.dispatchEvent(new Event('input', { bubbles: true }));
            // QUIESCENCE: a click issued mid-dry-run interleaves two assemblies
            // (generation-probe.mjs:1280-1312), which is a state a user cannot observe the outcome of.
            const idleDeadline = performance.now() + 30000;
            while (performance.now() < idleDeadline) {
                if (document.body.dataset.generating === undefined && Boolean(script.isGenerating) === false) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
            const send = document.querySelector('#send_but');
            if (!send) return { error: '#send_but is not present', sendDisabled: null };
            const sendDisabled = Boolean(send.disabled);
            if (sendDisabled) return { error: 'the send button is disabled', sendDisabled };
            send.click();
            return { clicked: true, sendDisabled };
        }, { text: spec.send });
        step('send-clicked', sendResult?.clicked === true, JSON.stringify(sendResult));

        // Wait for the peer, then for the page to be idle again. Bounded; the numbers are recorded.
        const firstDeadline = Date.now() + 60000;
        while (Date.now() < firstDeadline && chatCompletions().length === 0 && peer.requests.length === 0) {
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        await page.evaluate(async () => {
            const script = await import('./script.js');
            const deadline = performance.now() + 60000;
            while (performance.now() < deadline) {
                if (document.body.dataset.generating === undefined && Boolean(script.isGenerating) === false) break;
                await new Promise(resolve => setTimeout(resolve, 100));
            }
        });
        await new Promise(resolve => setTimeout(resolve, 1500));
        await readRendered('afterFirstReply');
        // The provider requests are re-read from the peer at every step, so a request that landed late is
        // still attributed to the step that produced it.
        const afterFirst = peer.requests.length;
        report.steps.push({ name: 'first-round-trip', ok: afterFirst > 0, detail: `${afterFirst} peer request(s)` });
    }

    // -----------------------------------------------------------------------------------------------
    // STEP 2: THE REGENERATE. `#option_regenerate` -> `Generate('regenerate')` (script.js:11640) is the
    // user's own control, and it re-renders the last assistant turn from the FULL reply text -- which is
    // where a DISPLAY-only rule's output becomes reliably observable, because the send path trims a
    // trailing partial word out of that text (:6357-6371).
    // -----------------------------------------------------------------------------------------------
    const requestsBeforeRegenerate = peer.requests.length;
    const regenerate = await page.evaluate(async () => {
        const script = await import('./script.js');
        const button = document.querySelector('#option_regenerate');
        if (!button) return { error: '#option_regenerate is not present', alternatives: [...document.querySelectorAll('#regenerate_button, .mes_regenerate')].map(node => node.id || node.className).slice(0, 5) };
        button.click();
        const deadline = performance.now() + 60000;
        while (performance.now() < deadline) {
            if (document.body.dataset.generating === undefined && Boolean(script.isGenerating) === false) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return { clicked: true };
    });
    step('regenerated', regenerate?.clicked === true, JSON.stringify(regenerate));
    await new Promise(resolve => setTimeout(resolve, 1500));
    await readRendered('afterRegenerate');
    report.steps.push({ name: 'regenerate-round-trip', ok: peer.requests.length > requestsBeforeRegenerate, detail: `${peer.requests.length - requestsBeforeRegenerate} new peer request(s)` });

    // -----------------------------------------------------------------------------------------------
    // STEP 3: THE STORED FORM, READ FROM DISK.
    //
    // THIS IS THE CASE NO REQUEST-LEVEL COMPARISON CAN SEE, and the lead asked for it after the pinned
    // reading established that USER INPUT is rewritten TWICE. Pinned's `sendMessageAsUser` applies
    // USER_INPUT at public/script.js:5875 and builds the message from the RESULT (`mes:` at :5882), so the
    // chat FILE holds the rule's output. A GoTavern that applied the rule only at assembly time (:4506)
    // would produce an IDENTICAL provider request and an IDENTICAL DOM, and only the file on disk would
    // differ. So read the file.
    //
    // WHICH FILE IS ASKED OF THE PAGE, not guessed: the frontend knows its own chat id (`getCurrentChatId`)
    // and the product wrote the file through its own save path. Pinned stores chats as JSONL under
    // `<dataRoot>/default-user/chats/`. If the id is absent the leg records that rather than inventing a
    // path, and the comparator treats "no stored observation" as unverified rather than as a pass.
    // -----------------------------------------------------------------------------------------------
    const chatIdentity = await page.evaluate(async () => {
        const script = await import('./script.js');
        const chats = await import('./scripts/chats.js').catch(() => null);
        const id = (typeof script.getCurrentChatId === 'function' ? script.getCurrentChatId() : null)
            ?? (chats && typeof chats.getCurrentChatId === 'function' ? chats.getCurrentChatId() : null)
            ?? null;
        return {
            chatId: id,
            userAvatar: script.user_avatar ?? null,
            chatLength: Array.isArray(script.chat) ? script.chat.length : null,
        };
    });
    report.chatIdentity = chatIdentity;
    // THE ID IS READ AGAIN AFTER THE DRIVE, and the two must agree. `send` and `swipe` can move the page to
    // a different chat, so an id captured BEFORE the drive could name a different conversation than the one
    // whose file satisfies the assertions -- a file correct in every respect but belonging to another chat.
    // That is the Q21 lesson ("name the card the server thinks it serves") in a new costume: identify the
    // artefact by the handle the subject reports, at the time the artefact was produced.
    const chatIdentityAfter = await page.evaluate(async () => {
        const script = await import('./script.js');
        return {
            chatId: typeof script.getCurrentChatId === 'function' ? script.getCurrentChatId() : null,
            chatLength: Array.isArray(script.chat) ? script.chat.length : null,
        };
    });
    report.chatIdentityAfter = chatIdentityAfter;
    // The chats directory is per-user; a fresh tree is `default-user`. Both candidates are tried and BOTH the
    // resolved path AND WHICH CANDIDATE MATCHED are recorded, so the comparator never has to assume which
    // layout the leg used.
    const storedCandidates = [];
    const chatsRoot = path.join(dataRoot, 'default-user', 'chats');
    let storedPath = null;
    let matchedCandidate = null;
    if (chatIdentity?.chatId) {
        const direct = path.join(chatsRoot, `${chatIdentity.chatId}.jsonl`);
        storedCandidates.push(path.relative(dataRoot, direct).split(path.sep).join('/'));
        if (await fs.stat(direct).then(() => true, () => false)) {
            storedPath = direct;
            matchedCandidate = storedCandidates[storedCandidates.length - 1];
        } else {
            // A named chat may live in a per-character subdirectory; list the root's entries so the
            // artefact says what WAS there instead of only what was not.
            const entries = await fs.readdir(chatsRoot, { withFileTypes: true }).catch(() => []);
            report.chatsRootEntries = entries.map(entry => `${entry.isDirectory() ? 'dir' : 'file'}:${entry.name}`).slice(0, 40);
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const nested = path.join(chatsRoot, entry.name, `${chatIdentity.chatId}.jsonl`);
                storedCandidates.push(path.relative(dataRoot, nested).split(path.sep).join('/'));
                if (await fs.stat(nested).then(() => true, () => false)) {
                    storedPath = nested;
                    matchedCandidate = storedCandidates[storedCandidates.length - 1];
                    break;
                }
            }
        }
    }
    report.storedCandidates = storedCandidates;
    report.storedMatch = { matchedCandidate, chatIdAtRead: chatIdentity?.chatId ?? null, chatIdAfterDrive: chatIdentityAfter?.chatId ?? null, idStable: (chatIdentity?.chatId ?? null) === (chatIdentityAfter?.chatId ?? null) };
    if (storedPath) {
        const raw = await fs.readFile(storedPath, 'utf8');
        // JSONL: one JSON object per line. A malformed line is recorded, not thrown on, so a corrupt file
        // still yields an artefact that says what is in it.
        const storedMessages = [];
        const badLines = [];
        for (const [index, line] of raw.split('\n').entries()) {
            if (!line.trim()) continue;
            try {
                storedMessages.push(JSON.parse(line));
            } catch (error) {
                badLines.push({ line: index + 1, error: String(error?.message ?? error).slice(0, 120) });
            }
        }
        report.storedChat = {
            path: path.relative(dataRoot, storedPath).split(path.sep).join('/'),
            bytes: Buffer.byteLength(raw, 'utf8'),
            messageCount: storedMessages.length,
            badLines,
            // WHICH CANDIDATE THIS FILE WAS, and the chat id the page reported on both sides of the drive.
            // A file that satisfies the token assertions but belongs to a DIFFERENT chat is the failure this
            // metadata exists to make visible (the Q21 lesson). The comparator asserts idStable.
            matchedCandidate,
            chatIdAtRead: chatIdentity?.chatId ?? null,
            chatIdAfterDrive: chatIdentityAfter?.chatId ?? null,
            idStable: (chatIdentity?.chatId ?? null) === (chatIdentityAfter?.chatId ?? null),
            persistedHandlePresent: /\bchat_metadata\b/.test(raw),
            // WHAT THE TYPED TURN LOOKS LIKE ON DISK. The rule's output must be here and the user's raw
            // token must not be, because pinned rewrites before the push (:5875-5886).
            messages: storedMessages.map(message => ({
                is_user: Boolean(message.is_user),
                is_system: Boolean(message.is_system),
                // The stored text, bounded: this is the USER'S OWN typed text plus marker output, never a
                // real preset or card (rule 56), so it is safe to record in the artefact.
                mes: String(message.mes ?? '').slice(0, 2000),
                inputTokens: [...new Set(String(message.mes ?? '').match(/RXQ_IN_[A-Z0-9]+/g) ?? [])].sort(),
                outputTokens: [...new Set(String(message.mes ?? '').match(/RXQ_OUT_[A-Z0-9]+/g) ?? [])].sort(),
            })),
        };
        step('stored-chat-read', report.storedChat.messageCount > 0, `${report.storedChat.path}: ${report.storedChat.messageCount} message(s), ${report.storedChat.bytes} bytes`);
    } else {
        // NAMED, NOT SILENT. A chat the product saved but this leg could not find is a measurement gap, and
        // the comparator must fail on it rather than treat an absent observation as agreement.
        step('stored-chat-read', false, `no chat file found for chatId ${JSON.stringify(chatIdentity?.chatId ?? null)}; tried ${storedCandidates.join(', ') || '(nothing, because the page reported no chat id)'}`);
    }

    // THE RECORD. Read ONCE at the end, from the peer's own list, so the artefact carries what the peer
    // received rather than what a step believed it produced.
    report.peerRequests = peer.requests.map(entry => ({
        method: entry.method,
        path: entry.path,
        contentType: entry.contentType,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        body: entry.body,
        arrived: entry.arrived,
    }));
    step('peer-reached', chatCompletions().length >= 2, `${chatCompletions().length} chat/completions request(s); ${peer.requests.length} total`);
    // THE DOM AS THE USER SEES IT, for the second round, read again after the peer list so a late render is
    // included rather than missed by the fixed settle above.
    await readRendered('final');
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    if (browser) await browser.close().catch(() => {});
    await peer.close().catch(() => {});
    if (server) server.kill();
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${report.subject}/${report.variant} leg: ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;
