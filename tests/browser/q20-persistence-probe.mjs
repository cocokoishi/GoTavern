// Q20 — SAVE, RELOAD AND SWIPE PRESERVE EQUALITY (GOAL.md §9).
//
// The question this answers, in one sentence: after a user's chat is written by the product, read back by a FRESH
// page load, and given a second turn and a swipe, does the conversation on disk and the context that reaches the
// model stay equal to pinned Node SillyTavern's?
//
// WHY A NEW DRIVE RATHER THAN ANOTHER MODE OF A PROBE THAT ALREADY WORKS. `helper-probe.mjs` drives ONE turn and
// reads variables; `real-preset-probe.mjs` drives generations and never reloads a page; neither produces a SECOND
// message on the same chat or a swipe. The step that matters here -- a fresh page reading the chat the previous
// page saved -- is exactly the step no existing leg performs, and it is the step a user performs by closing and
// opening SillyTavern.
//
// THE ROUTES ARE PINNED'S, read from the pinned frontend rather than guessed:
//   save    POST /api/chats/save                 public/script.js:7447, inside saveChat() (:7395)
//   read    POST /api/chats/get                  public/script.js:7638, inside getChat()  (:7634)
//   swipe   swipe() on the last message          public/script.js:9954, its save at :9403
// The leg never writes a chat file itself: what is asserted on disk is what the PRODUCT wrote.
//
// WHAT THE EARLIER ATTEMPTS GOT WRONG (runs 40280522171, 40282904234, 40285374783, 40287740191, 40289860372; all
// identical on both subjects, so never a product finding -- rule 10):
//   - `saveMetadata()` / `saveChatConditional()` resolve and issue NO request when `characters[this_chid].chat` is
//     undefined (script.js:7407-7417), and a card that has just been clicked has none;
//   - a click on `#rm_print_characters_block .avatar[data-type="character"]` DOES NOT OPEN A CHAT ON A FRESH
//     INSTALL. A fresh install has no characters, so the page shows the welcome screen, whose assistant card is
//     `.character_select#CharID0` (script.js:945, :957) and NOT `.avatar[data-type="character"]` (that template is
//     only produced by `buildAvatarList`, which the welcome screen does not use). Run 40289860372 recorded
//     `chatLength:0` AFTER the click and a send that then took the page to the PERMANENT ASSISTANT chat
//     (`sendTextareaMessage` -> `newAssistantChat`, script.js:1760). This leg selects a real character by clicking
//     a card that is actually in the DOM;
//   - `TavernHelper.createChatMessages()` writes frontend state and no pinned chats endpoint creates an identity,
//     so a marker inserted that way can never reach disk.
// The one path a user has is the frontend's own send: it calls `saveChat({chatName})` FIRST with the marker in the
// outbound chat (script.js:7447), which creates the identity, and `Generate` saves again after the reply arrives
// (script.js:5573). This leg therefore drives `#send_textarea` + `#send_but` and judges the result BY THE FILE and
// BY THE RECORDED `/api/chats/save` REQUEST, never by a resolved promise.
//
// WHY THE SECOND TURN PUTS ITS MARKER IN THE CHAT AFTERWARDS, decided here rather than derived. The send CLEARS
// `#send_textarea` before it reads it in places, so the only way to prove the message CONTENT differs between
// subjects is for the leg to write it into the message it just created -- still the page's own state, through the
// page's own call, and recorded in the artefact. Without a per-subject content difference the second turn's
// comparison would be satisfied by any two equal requests.
//
// WHY THE FIRST TURN WAS "SILENTED", AND WHAT IS ACTUALLY TRUE ABOUT IT -- a correction, kept visible because the
// first version of this block asserted a root cause that measurement then refuted.
// The original text here said the leg set `power_user.savingAfterComplete = false` so `finishGenerating` "does not
// re-save mid-generation". MEASURED FALSE: `savingAfterComplete` DOES NOT EXIST anywhere under pinned's `public/**`
// (grepped every .js), so the flag the leg sets is inert and silences nothing. It is left in place because removing
// it is a behaviour change nobody has measured, and it is now labelled for what it is.
//
// THE EMPTY-TEXT REPLIES ARE A REAL OBSERVATION AND THEIR CAUSE IS NOT YET ESTABLISHED. Measurement, run
// 40445671791, IDENTICAL on both subjects: the file holds six records -- the header, the greeting (785 chars), the
// first marker, `is_user:false` with `mesLen: 0`, the second marker, and another `is_user:false` with `mesLen: 0` --
// while the peer recorded THREE completion requests whose last message was, respectively, the first marker, "Q20
// second turn input", and the second marker. So each turn DID produce a request, and each request is followed in the
// file by an EMPTY assistant record.
// A HYPOTHESIS WAS TESTED AND REFUTED, and it is recorded here so it is not re-derived: the peer answers
// `{choices: [{message: {role: 'assistant', content: 'Q20_REPLY_n'}}]}`, and `extractMessageFromData` for
// `main_api === 'openai'` (public/script.js:6454-6478) reads exactly `data.choices[0].message.content`. The answer
// shape is CORRECT, so "the peer answered in a shape the frontend cannot read" is FALSE.
// What remains known without a further run: the reply text does not reach disk on either subject, the two subjects
// are EQUALLY affected (so this is not GoTavern-vs-pinned), and `final-file-reflects-swipe` must therefore not claim
// the persisted text is a reply. The open question -- why a correct-shaped completion becomes an empty message --
// is named in the artefact as `emptyReplyOnBothSubjects` and is NOT resolved by choosing a value.
//
// WHAT THE TURNS THEREFORE DEPEND ON: each turn's presence on disk is written by the LEG's own explicit
// `saveChatConditional()`, which is the frontend's own "write it now". The setup below waits on the PRODUCT'S state
// (last message is an assistant turn, not busy) rather than on a sleep, and fails BY NAME when the budget expires.
//
// WHAT THIS DOES NOT PROVE, stated here so the artefact's `notCompared` can repeat it: a real provider (rule 22),
// streaming (Q19), regenerate/continue (Q20's other two verbs), group chats, and branch/checkpoint features.

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { seedLegConfig } from './seed-leg-config.mjs';
import { attachUrlRecorder } from './url-recorder.mjs';
import { ensurePinnedExtensionInstalled } from './install-pinned-extension.mjs';
import { pinnedExtension } from './pinned-extensions.mjs';
// THE DRIVE, SHARED WITH THE regenerate AND continue LEGS. What is imported here is exactly what this file now calls:
// the page/send/save primitives that used to be inline copies. `configureConnection`, `silenceAndObserve` and
// `sendTurn` are NOT imported yet -- this file still carries its own connection step, its own observer install
// (which counts listener timings, a field the other legs do not record) and its own second turn (which writes the
// per-subject marker into the chat); swapping those is a separate, separately-verifiable change and is NOT done here,
// because doing it in the same commit would make "the artefact did not move" unprovable.
import {
    readChatFiles as driveReadChatFiles, openPage as driveOpenPage,
    openCharacter as driveOpenCharacter, chatCarrying, waitForReply,
} from './q20-persistence-drive.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

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

// The capture peer: records everything, answers a chat completion whose content carries a marker so the leg can
// prove the reply came from here. It defines nothing (rule 49).
function startCapturePeer() {
    const requests = [];
    let replyIndex = 0;
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
            replyIndex += 1;
            response.writeHead(200, headers);
            response.end(JSON.stringify({
                id: `chatcmpl-q20-${replyIndex}`,
                object: 'chat.completion',
                created: 1730000000,
                model: 'probe-model',
                choices: [{ index: 0, message: { role: 'assistant', content: `Q20_REPLY_${replyIndex}` }, finish_reason: 'stop' }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            }));
        });
    });
    return new Promise((resolve, reject) => {
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => resolve({
            port: server.address().port,
            requests,
            close: () => new Promise(done => server.close(done)),
        }));
    });
}

const external = Boolean(process.env.PROBE_BASE_URL);
const dataRoot = path.resolve(argumentValue('--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-q20-')));
const reportPath = path.resolve(argumentValue('--report', path.join(here, 'q20-persistence-leg.json')));

// TavernHelper only exists when the pinned extension is installed, so it goes into the leg's own data root.
const installed = await ensurePinnedExtensionInstalled(dataRoot, pinnedExtension('tavern-helper'));

const port = await freePort();
let server = null;
const serverLog = [];
if (!external) {
    const binarySetting = process.env.GOTAVERN_BINARY ?? '';
    if (!binarySetting) throw new Error('GOTAVERN_BINARY is required for the GoTavern leg');
    await fs.cp(path.join(repoRoot, 'upstream', 'tokenizers'), path.join(dataRoot, 'tokenizers'), { recursive: true });
    await seedLegConfig(dataRoot);
    server = spawn(path.resolve(binarySetting), ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    // KEPT, but bounded: a server that answers /version and then refuses a save is otherwise unattributable.
    const collect = chunk => {
        if (serverLog.length < 200) serverLog.push(String(chunk).slice(0, 400));
    };
    server.stdout.on('data', collect);
    server.stderr.on('data', collect);
}

const baseURL = process.env.PROBE_BASE_URL ?? `http://127.0.0.1:${port}`;
const MARKERS = {
    first: 'Q20_FIRST_TURN_MARKER',
    second: 'Q20_SECOND_TURN_MARKER',
    swipe: 'Q20_SWIPE_MARKER',
};

const report = {
    schemaVersion: 1,
    question: 'After the product saves a chat, does a FRESH page load read it back, and do a second turn and a swipe reach the model with the same context as pinned?',
    subject: external ? 'pinned' : 'gotavern',
    baseURL,
    dataRoot,
    extension: { installedRevision: installed.revision, source: installed.source },
    markers: MARKERS,
    steps: [],
    pageRequests: [],
    chatRequests: [],
    peerRequests: [],
    navigations: [],
    pageErrorTail: [],
    consoleTail: [],
    consoleDiagnostics: [],
    listenerTimings: [],
    observerInstalls: [],
    pageErrors: [],
    console: [],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
}

// THE CHAT FILES THE PRODUCT WROTE. Read from disk, never written by this leg.
//
// LIFTED (q20-persistence-drive.mjs) so the regenerate and continue legs read the SAME way this one does; the body is
// unchanged, and `readChatFiles()` is kept as a zero-argument local because every call site below passes nothing.
const readChatFiles = () => driveReadChatFiles(dataRoot);

const carries = (files, marker) => files.some(file => (file.messages ?? []).some(message => String(message?.mes ?? '').includes(marker)));

const peer = await startCapturePeer();
let browser;
let disarmed = null;
try {
    await waitForServer(`${baseURL}/version`);
    // THE BUNDLED BUILD, deliberately. Run 40310580694 measured that `channel: 'chromium'` does NOT make
    // `window.location` forkable -- Playwright installs its own non-configurable one per browsing context in either
    // mode -- so the channel bought nothing and would have quietly made this leg drive a different browser from
    // every other leg in the workflow. Back to the default, with the recorder replaced by one that does not need a
    // scriptable Location.
    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
    page.on('console', message => report.console.push({ type: message.type(), text: String(message.text()).slice(0, 400) }));
    // THE PAGE'S OWN ERROR TAIL. `report.console` is bounded to a few hundred entries and a long startup can push an
    // error out of it; this keeps the last few page-side errors regardless of how much was logged around them.
    page.on('pageerror', error => {
        report.pageErrorTail.push(String(error?.stack ?? error?.message ?? error));
        if (report.pageErrorTail.length > 64) report.pageErrorTail.shift();
    });
    // The console tail, which is where a reload's agent usually announces itself (a toastr error, a thrown message).
    // THE DIAGNOSTIC CHANNEL. The previous listener kept only error/warning in a 12-entry ring with the text cut
    // at 300 characters, and `console.trace` reports type `trace`, so the two lines the pinned EventEmitter emits
    // when it swallows a listener throw (console.error(err) + console.trace('Error in event listener'),
    // public/lib/eventemitter.js:145-151) were DROPPED -- which is why the "who threw inside Generate" question
    // could not be answered from any run so far. Full text, no ring eviction below 200, trace included.
    page.on('console', message => {
        const type = message.type();
        if (!['error', 'warning', 'trace'].includes(type)) return;
        const location = message.location();
        report.consoleDiagnostics.push({
            type,
            text: String(message.text()),
            location: location && location.url ? `${location.url}:${location.lineNumber}` : null,
            at: new Date().toISOString(),
        });
        if (report.consoleDiagnostics.length > 200) report.consoleDiagnostics.shift();
    });
    // A NAVIGATION IS THE ONE DRIVE HAZARD THAT LOOKS LIKE A PRODUCT RESULT. Run 40300889852 recorded the send's
    // `POST /api/chats/save` 200 followed by a page that was NO LONGER THE PAGE THE SEND STARTED IN: startup
    // re-ran (initial user input not reported, app_ready rendered before startup), so the textarea the test then
    // read belonged to a NEW page whose in-memory chat was the saved greeting alone. Both subjects did it, so it is
    // the harness/startup interaction, not a backend difference -- and an unrecorded one turns "the marker is not
    // in the file" into an unexplained zero. Every main-frame navigation is therefore recorded.
    page.on('framenavigated', frame => {
        if (frame !== page.mainFrame()) return;
        report.navigations.push({ url: frame.url(), at: new Date().toISOString() });
    });
    await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
    // THE ONE INSTRUMENT USED FOR "DID THE FRONTEND ASK". Two runs measured a save that resolved `ok` and wrote
    // nothing; a resolved promise cannot tell "the page never asked" from "the server refused", and a request-only
    // listener cannot tell "the server refused" from "the response never arrived". The shared recorder carries
    // method, path+query, status and the response byte length for every URL, and url-recorder.mjs is the module the
    // helper and asset legs already use, so this probe is not a second, divergent instrument.
    const recorder = attachUrlRecorder(page);

    // WHO NAVIGATED, AND FROM WHERE. `framenavigated` proves a reload happened but not what asked for it, and the
    // pinned frontend has eleven `location.reload()` sites plus a dozen indirect reload paths, so reading them and
    // picking one would be the "derive the oracle" failure (rule 4). Two runtime routes were measured and BOTH are
    // closed in this driver: `Object.defineProperty(window, 'location', ...)` throws `Cannot redefine property:
    // location` in a standard Playwright context (run 40308271879), and it STILL throws with `channel: 'chromium'`
    // (run 40310580694), because Playwright installs its own non-configurable `window.location` per browsing
    // context in both modes.
    //
    // THE ORACLE IS THE SUSPECT'S OWN HYPOTHESIS, stated as a mechanism and tested by making it expensive. A reload
    // that lands in a READY document is a reload something called on purpose (the `location.reload` family); a
    // reload that lands while the document is still LOADING is the browser giving up (a stalled dependency, a
    // `Content-Disposition` attachment, a dropped connection). `Network.emulateNetworkConditions` widens that gap
    // to seconds, so the landing state at the navigation's own moment is recorded rather than inferred: every
    // lifecycle event, every navigation's `document.readyState` at `domcontentloaded`/`load`, and Chromium's own
    // network failure journal. Nothing in the page is patched, so nothing the page does is changed.
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    const networkFailures = [];
    cdp.on('Network.loadingFailed', event => {
        if (networkFailures.length < 40) networkFailures.push({ errorText: event.errorText, type: event.type, canceled: event.canceled ?? null, requestId: event.requestId });
    });
    const armPageSide = async () => page.evaluate(async () => {
        // "WHO THREW" WAS THE WRONG QUESTION, measured: `Error in event listener` appears ZERO times in a failing
        // run (40352368231), so no listener throw is swallowed -- Generate is HELD, not tripped. This observes each
        // listener by TIMING ONLY: it calls through, records enter/leave, and changes neither the return value nor
        // `this` nor the order. It never reimplements emit (AGENTS 58).
        window.__q20ListenerTimings = [];
        const observeListener = (eventName, original) => {
            if (typeof original !== 'function') return original;
            const wrapped = function (...args) {
                const entry = { event: eventName, enteredAt: Date.now(), leftAt: null, ms: null, threw: null };
                window.__q20ListenerTimings.push(entry);
                const started = performance.now();
                const finish = () => { entry.leftAt = Date.now(); entry.ms = Math.round(performance.now() - started); };
                try {
                    const result = original.apply(this, args);
                    if (result && typeof result.then === 'function') {
                        return result.then(
                            value => { finish(); return value; },
                            error => { entry.threw = String(error && error.message || error); finish(); throw error; },
                        );
                    }
                    finish();
                    return result;
                } catch (error) {
                    entry.threw = String(error && error.message || error);
                    finish();
                    throw error;
                }
            };
            wrapped.__q20Original = original;
            return wrapped;
        };
        window.__q20ObserveEvent = eventName => {
            const bus = window.SillyTavern && window.SillyTavern.getContext && window.SillyTavern.getContext().eventSource;
            const listeners = bus && bus.events && bus.events[eventName];
            if (!Array.isArray(listeners)) return { event: eventName, installed: -1 };
            let installed = 0;
            for (let index = 0; index < listeners.length; index++) {
                if (!listeners[index] || listeners[index].__q20Original !== undefined) continue;
                listeners[index] = observeListener(eventName, listeners[index]);
                installed += 1;
            }
            return { event: eventName, installed, total: listeners.length };
        };
        window.__q20Events = [];
        const record = (name, extra = null) => window.__q20Events.push({ name, at: Date.now(), readyState: document.readyState, href: String(window.location.href), extra });
        for (const name of ['readystatechange', 'DOMContentLoaded', 'load', 'beforeunload', 'pagehide', 'unload']) {
            window.addEventListener(name, () => record(name), { capture: true });
        }
        // THE PRODUCT'S OWN EVENT BUS, subscribed through the page's own module. Generate()'s first await is
        // EVENT_SOURCE / `settings_loaded` (measured, see the header), so the ORDER of that event against the send is
        // what decides whether a turn can exist at all; a console line is not enough, because the page's `console`
        // listener is bounded and a long startup pushes entries out. This records the event names in order with the
        // chat length at each one, which makes "was there a chat when generation ran" a measurement.
        const events = await import('./scripts/events.js');
        const script = await import('./script.js');
        if (!window.__q20Subscribed) {
            window.__q20Subscribed = true;
            for (const name of Object.values(events.event_types)) {
                try {
    // I WITHDREW THE `emit` WRAPPER THAT USED TO LIVE HERE. It recorded which listener threw, and it also BROKE
    // THE PRODUCT: run 40349251805 measured `Error saving settings: TypeError: Cannot read properties of undefined
    // (reading 'push') at events.eventSource.emit (…), script.js:8111` on every settings save, because the wrapper
    // reimplemented `emit` against a `this` that is not always the emitter. That is the worst class of harness defect:
    // the instrument changed the subject. The lesson is written down rather than merely fixed -- a probe may OBSERVE
    // the event bus, never reimplement it (AGENTS 58). The attribution this wrapper was built for now comes from
    // `consoleDiagnostics` below, which carries the pinned emitter's own `console.error(err)` +
    // `console.trace('Error in event listener')` in full, with the url:line they were logged from.
                    events.eventSource.on(name, () => record(`event:${name}`, { chatLength: (script.chat ?? []).length, lastIsUser: (script.chat ?? [])[script.chat.length - 1]?.is_user === true }));
                } catch {
                    // an event name the bus refuses is not a finding about the product
                }
            }
        }
        return { armed: true, href: String(window.location.href), readyState: document.readyState, subscribed: window.__q20Subscribed === true };
    });
    const readPageSide = async () => page.evaluate(() => window.__q20Events ?? []);
    const disarmReloadRecorder = async () => ({ disarmed: true });

    // THE PAGE, LIFTED: `driveOpenPage` is byte-for-byte the body this file used to carry (domcontentloaded, the
    // preloader wait, then `settingsReady` with the 90 s bound and the onboarding dismissal). Kept as a thunk so every
    // call site below -- the first load and the fresh reload -- is unchanged.
    const openPage = () => driveOpenPage(page, baseURL);
    // Declared here, READ AFTER the first `openPage()` (see `openCharacter` below): a page-scoped read cannot run
    // before the navigation that gives the document a base URL.
    let expectedCardName;

    // SELECT A REAL CHARACTER, WHICH IS THE PRECONDITION THE PRODUCT ITSELF CHECKS. The card a fresh install
    // actually renders is `.character_select#CharID<n>` (script.js:945); `.avatar[data-type="character"]` belongs to
    // the interactable lists and is absent here. The card's identity is taken from the page's own `characters` array
    // so a mismatch between the DOM and the model is visible in the artefact rather than assumed.
    //
    // LIFTED, WITH ONE DELIBERATE CHANGE STATED HERE: `driveOpenCharacter` takes the card's NAME and REFUSES when the
    // page does not list it, instead of clicking the first `.character_select` it finds. On THIS leg that is
    // behaviour-preserving in the only sense that matters -- a fresh-install tree holds exactly one card, so the
    // first card IS the named card -- and the name it opens is read back out of the page's own `characters` array
    // below, so the refusal path can only fire on a tree with no card at all. The change exists because the
    // regenerate/continue legs must open the card the FIRST leg opened, and "the first card that renders" is not a
    // precondition a real user has.
    // THE NAME IS READ FROM A LOADED PAGE, NOT BEFORE ONE. Measured in run 40444282138 (mode=preset): the first
    // version of this read sat above `openPage()`, so it ran while the document was still `about:blank` and
    // `import('./script.js')` had no base URL to resolve against -- `TypeError: Failed to resolve module
    // specifier './script.js'`, every guard downstream red. A page-scoped read belongs after the navigation that
    // makes the page exist; that is an ordering rule about `page.evaluate`, not about the product.
    const openCharacter = async () => {
        if (expectedCardName === undefined) {
            expectedCardName = await page.evaluate(async () => {
                const script = await import('./script.js');
                const deadline = Date.now() + 60000;
                while (Date.now() < deadline) {
                    const first = (script.characters ?? [])[0];
                    if (first?.name) return String(first.name);
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
                return null;
            });
        }
        return driveOpenCharacter(page, expectedCardName);
    };

    const readyFirst = await openPage();
    step('page-loaded', readyFirst === true, `settingsReady=${readyFirst}`);
    step('page-no-errors', report.pageErrors.length === 0, JSON.stringify(report.pageErrors));

    // The connection, through the frontend's own controls, after the page is ready.
    const peerBase = `http://127.0.0.1:${peer.port}/v1`;
    const connected = await page.evaluate(async ({ url, model }) => {
        const set = (selector, value) => {
            const control = document.querySelector(selector);
            if (!control) return false;
            control.value = value;
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
            return true;
        };
        // `chat_completion_source` IS NOT `main_api`. Run 40375075025 recorded `mainApi: "koboldhorde"` at the click:
        // the leg had configured the custom endpoint but the API SWITCH still pointed at the fresh-install default, so
        // Generate took the Horde path and quietly did nothing on both subjects. `changeMainAPI` is script.js:7756, the
        // frontend's own switch, and it also sets `#main_api` so the rest of the page agrees.
        const scriptModule = await import('./script.js');
        scriptModule.changeMainAPI('openai');
        set('#main_api', 'openai');
        set('#chat_completion_source', 'custom');
        set('#custom_api_url_text', url);
        set('#custom_model_id', model);
        set('#api_key_custom', 'probe-key');
        const openai = await import('./scripts/openai.js');
        // THE SAME OBJECT `getContext().powerUserSettings` RESOLVES TO, imported directly. Run 40298378524 measured
        // what the context route costs: the first turn's `page.evaluate` threw
        // "TypeError: Cannot set properties of undefined (setting 'savingAfterComplete')" on BOTH subjects, because
        // `script.js` has no named `powerUserSettings` export -- openai.js gets it from `./power-user.js` (:46).
        const power = await import('./scripts/power-user.js');
        // THE FIRST TURN IS SILENTED (decided, above): the post-generation save would otherwise land mid-generation,
        // and this leg needs a chat IDENTITY, not a provider reply, from the send.
        power.power_user.savingAfterComplete = false;
        return {
            source: openai.oai_settings.chat_completion_source ?? null,
            url: openai.oai_settings.custom_url ?? null,
            savingAfterComplete: power.power_user.savingAfterComplete ?? null,
        };
    }, { url: peerBase, model: 'probe-model' });
    step('connection-configured', connected.source === 'custom' && String(connected.url ?? '').includes(String(peer.port)), JSON.stringify(connected));

    const opened = await openCharacter();
    await page.waitForTimeout(1500);
    // SILENCED BEFORE THE FIRST SEND, and before any read that would be mistaken for state: the flag lives on the
    // page's live `power_user`, the same object a saved settings round-trip replaces, so it is re-asserted here
    // (after the click's `getChat()` -> `saveChatConditional()` sequence) and read back into the artefact.
    const silenced = await page.evaluate(async () => {
        const power = await import('./scripts/power-user.js');
        power.power_user.savingAfterComplete = false;
        // `processCommands` is the ONLY return path in `Generate('normal')` that produces no message and no request
        // (script.js:4310-4318: `if (interruptedByCommand) { unblockGeneration(type); return Promise.resolve(); }`),
        // and it consumes `#send_textarea` -- the same value the leg sets. It cannot be observed from outside, so it is
        // wrapped for the send window and its verdict is recorded. A slash command in the textarea would make every
        // later conclusion about "did the turn reach the model" a guess.
        const script = await import('./script.js');
        if (!window.__q20ProcessCommandsWrapped) {
            window.__q20ProcessCommandsWrapped = true;
            window.__q20ProcessCommands = [];
            const original = script.processCommands;
            if (typeof original === 'function') {
                script.processCommands = async function (text) {
                    const result = await original.apply(this, arguments);
                    window.__q20ProcessCommands.push({ text: String(text ?? '').slice(0, 120), interrupted: result === true });
                    return result;
                };
            }
        }
        return {
            savingAfterComplete: power.power_user.savingAfterComplete ?? null,
            processCommandsWrapped: window.__q20ProcessCommandsWrapped === true,
            processCommandsWasFunction: typeof (await import('./script.js')).processCommands === 'function',
        };
    });
    report.characterOpen = { ...opened, silenced };
    step('chat-open', opened?.clicked === true && (opened.chatLength > 0 || opened.messages > 0), JSON.stringify(report.characterOpen));

    // ARMED NOW, DISARMED BEFORE THE LEG'S OWN RELOAD. Everything between these two calls is the window in which a
    // navigation is a DEFECT rather than this leg's design, so anything the recorder catches is evidence, not noise.
    const armed = await armPageSide();
    // INSTALLED BEFORE ANY GENERATION RUNS, and asserted to have installed something: an observer that silently
    // observes nothing is the defect this file has produced three times already.
    // THE EVENT NAMES ARE READ FROM THE FRONTEND AT RUNTIME, never hardcoded. Measured in pinned
    // public/scripts/events.js: the values are NOT the constant names -- GENERATION_STARTED is
    // 'generation_started', MESSAGE_SENT is 'message_sent', CHAT_CHANGED is 'chat_id_changed' -- so the first
    // version of this observer indexed ``events['GENERATION_STARTED']`` and bound NOTHING (installed: -1) on five
    // of six events while reporting no error. The install count is therefore ASSERTED below: a target that binds
    // zero listeners fails the leg as a harness error rather than producing an artefact that measures nothing.
    const OBSERVED_CONSTANTS = [
        'GENERATION_STARTED', 'GENERATION_AFTER_COMMANDS', 'MESSAGE_SENT',
        'MESSAGE_RECEIVED', 'CHAT_CHANGED', 'USER_MESSAGE_RENDERED',
    ];
    const observerInstalls = [];
    for (const constantName of OBSERVED_CONSTANTS) {
        observerInstalls.push(await page.evaluate(name => {
            const context = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
            const table = (context && context.eventTypes) || window.event_types || null;
            const runtimeName = table && table[name];
            if (!runtimeName) return { constant: name, event: null, installed: -1, reason: 'event_types not reachable from the page' };
            if (!window.__q20ObserveEvent) return { constant: name, event: runtimeName, installed: -1, reason: 'observer not installed' };
            return { constant: name, ...window.__q20ObserveEvent(runtimeName) };
        }, constantName));
    }
    const unboundEvents = observerInstalls.filter(entry => entry.installed <= 0);
    report.observerInstalls = observerInstalls;
    report.observerUnbound = unboundEvents;
    // A TARGET THAT BOUND NOTHING IS A HARNESS ERROR, not a zero. Without this the observer silently measures
    // nothing and the artefact still looks like evidence -- the failure this file has produced four times.
    if (unboundEvents.length > 0) {
        report.failure = report.failure ?? `the observer bound no listener on: ${unboundEvents.map(entry => `${entry.constant} -> ${entry.event} (${entry.reason ?? 'installed: ' + entry.installed})`).join(', ')}`;
    }
    const readListenerTimings = async () => page.evaluate(() => window.__q20ListenerTimings ?? []);
    const pageMark = () => report.navigations.length;
    const navigationsBeforeSend = pageMark();

    // 1. THE FIRST TURN, THROUGH THE FRONTEND'S OWN SEND. The save that follows is the frontend's, with the chat
    // identity the send itself creates; the leg supplies only the text and the click.
    const sent = await page.evaluate(async marker => {
        // SETTINGS MUST BE READY BEFORE THE SEND. The console carried `Settings not ready, scheduling another save`
        // (script.js:8052) on BOTH subjects, so this drive used to click while the frontend was still initialising.
        // Wait on the frontend's own flag rather than a sleep, and carry the timing out so a red can say whether
        // the click preceded readiness.
        // DECLARED IN THIS SCOPE, because the browser callback cannot see anything outside it. Run 40372411027 died on
        // `ReferenceError: context is not defined` AFTER an earlier revert removed the binding -- `node --check` cannot
        // see that, so every field read below is also made self-reporting: a missing input appears as a value in the
        // artefact instead of throwing the whole leg away.
        const pageContext = (window.SillyTavern && window.SillyTavern.getContext) ? window.SillyTavern.getContext() : null;
        const missingInputs = [];
        const readInput = (label, read) => {
            try { return read(); } catch (error) { missingInputs.push(`${label}: ${String(error && error.message || error)}`); return null; }
        };
        const clickStartedAt = Date.now();
        const frontend = await import('./script.js');
        const kai = await import('./scripts/kai-settings.js');
        const readyDeadline = Date.now() + 60000;
        while (Date.now() < readyDeadline && frontend.settingsReady !== true) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const readyWaitMs = Date.now() - clickStartedAt;
        const settingsReadyAtClick = frontend.settingsReady === true;
        // TWO SILENT EARLY RETURNS sit between GENERATION_AFTER_COMMANDS and any provider request, and BOTH produce
        // exactly this leg's symptom -- events fire, /api/ping happens, then nothing, with no throw and no page
        // error. Record their inputs at the click so the next run can say whether this is one of them:
        //   script.js:4323  main_api == 'kobold' && kai_settings.streaming_kobold && !kai_flags.can_use_streaming
        //   script.js:4329  isHordeGenerationNotAllowed()
        const silentExitInputs = {
            mainApi: readInput('mainApi', () => pageContext.mainApi),
            kaiStreamingKobold: readInput('kaiStreamingKobold', () => Boolean(kai.kai_settings && kai.kai_settings.streaming_kobold)),
            kaiCanUseStreaming: readInput('kaiCanUseStreaming', () => Boolean(kai.kai_flags && kai.kai_flags.can_use_streaming)),
            selectedGroup: readInput('selectedGroup', () => Boolean(pageContext.groupId)),
            hordeBlocked: (() => {
                try { return typeof frontend.isHordeGenerationNotAllowed === 'function' ? Boolean(frontend.isHordeGenerationNotAllowed()) : null; }
                catch (error) { return `threw: ${String(error && error.message || error)}`; }
            })(),
        };
        const textarea = document.querySelector('#send_textarea');
        const button = document.querySelector('#send_but');
        if (!textarea || !button) return { clicked: false, reason: 'send controls missing' };
        textarea.value = marker;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
        return { clicked: true, textareaValue: textarea.value, settingsReadyAtClick, readyWaitMs, silentExitInputs, missingInputs };
    }, MARKERS.first);
    // A SEND IS ASYNCHRONOUS: the click returns immediately and the save lands after the frontend has produced the
    // message and named the chat. The file is polled for the marker with a bounded budget rather than read on the
    // next tick, and the recorded requests are carried in the artefact either way.
    let afterFirst = [];
    const firstDeadline = Date.now() + 30000;
    while (Date.now() < firstDeadline) {
        afterFirst = await readChatFiles();
        if (carries(afterFirst, MARKERS.first)) break;
        await page.waitForTimeout(500);
    }
    await recorder.settled();
    const reloads = await readPageSide();
    disarmed = await disarmReloadRecorder();
    const chatRequestLog = () => recorder.requests
        .filter(entry => /\/api\/chats/.test(entry.pathAndQuery ?? ''))
        .map(entry => ({ method: entry.method, path: entry.pathAndQuery, status: entry.status, contentType: entry.contentType, byteLength: entry.byteLength }));
    report.pageRequests = recorder.requests.map(entry => ({ method: entry.method, path: entry.pathAndQuery, status: entry.status }));
    report.chatRequests = chatRequestLog();
    report.firstTurn = sent;
    // THE CONSOLE IS CARRIED WITH THE FAILURE, because the pinned emitter logs a swallowed listener throw as
    // `console.error(err)` + `console.trace('Error in event listener')` (public/lib/eventemitter.js:145-151) and
    // nothing else survives to say who threw. `consoleDiagnostics` keeps both lines in full with url:line.
    report.listenerTimings = await readListenerTimings();
    report.observerInstalls = observerInstalls;
    report.afterFirstSave = afterFirst;
    report.reloadRecorder = { armed, disarmed, reloads, networkFailures, navigationsDuringSend: report.navigations.slice(navigationsBeforeSend), navigationsTotal: report.navigations.length, pageErrorTail: report.pageErrorTail.slice(), consoleTail: report.consoleTail.slice() };
    report.processCommands = await page.evaluate(() => window.__q20ProcessCommands ?? []);
    // THE SAVE IS JUDGED BY THE FILE AND BY THE REQUEST, NOT BY THE RETURN VALUE: a resolved promise is exactly what
    // the failing runs produced.
    step('first-turn-save-issued', report.chatRequests.some(entry => /\/api\/chats\/save$/.test(entry.path ?? '') && entry.status === 200),
        JSON.stringify(report.chatRequests));
    // A NAVIGATION HERE IS A FAILED DRIVE, NOT A SAVE FINDING. The page the marker was written into is gone, so the
    // marker's absence from the file says nothing about the product; the recorded navigation and reload stacks are
    // what the next change is built on. Kept as its own step so the two can never be confused in a summary.
    step('drive-stayed-on-one-page', report.navigations.length === navigationsBeforeSend,
        `${report.navigations.length - navigationsBeforeSend} navigation(s) during the first turn: ${JSON.stringify(report.reloadRecorder)}`);
    step('first-turn-saved', carries(afterFirst, MARKERS.first),
        `files=${afterFirst.map(file => `${file.file}:${file.lines}`).join(',') || 'none'}; processCommands=${JSON.stringify(report.processCommands)}`);

    // 2. A FRESH PAGE LOAD MUST READ THAT CHAT BACK. This is the step no other leg performs.
    const readyReload = await openPage();
    const reopened = await openCharacter();
    await page.waitForTimeout(1500);
    const afterReload = await page.evaluate(async () => {
        const script = await import('./script.js');
        // `getContext` is exposed on window.SillyTavern, NOT exported by script.js -- the same defect as line 601,
        // which was fixed there and missed here. Run 40378609525 died on it AFTER first-turn-saved went green.
        const context = window.SillyTavern.getContext();
        return {
            settingsReady: script.settingsReady === true,
            messages: document.querySelectorAll('#chat .mes').length,
            chatLength: (context.chat ?? []).length,
            chatId: context.chatId ?? null,
            carriesMarker: (context.chat ?? []).some(entry => String(entry?.mes ?? '').includes('Q20_FIRST_TURN_MARKER')),
            lastIsUser: (context.chat ?? [])[context.chat.length - 1]?.is_user === true,
        };
    });
    // THE CONNECTION IS RE-APPLIED, and that is recorded rather than hidden: the peer's port is ephemeral and this
    // leg's data root is a one-shot, so a fresh page may hold a stale custom URL. What is NOT repaired is the
    // subject of this step -- the chat and its identity come from the page's own read of what the previous page
    // saved.
    const reconnected = await page.evaluate(async ({ url, model }) => {
        const set = (selector, value) => {
            const control = document.querySelector(selector);
            if (!control) return null;
            control.value = value;
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
            return control.value;
        };
        // THE RELOAD RESETS THE SWITCH, NOT JUST THE URL. Run 40381923526 measured `second-turn-message-created`
        // failing with `wroteMarker:false` and `chatLength` unchanged at 3: the first turn went through because
        // `changeMainAPI('openai')` had been applied on THAT page, and the fresh page came back with the
        // fresh-install default (`koboldhorde`) again -- so the second send took the Horde branch and appended
        // nothing, exactly as the first turn did before d6e80f6. Re-applying it here is the same repair, not a
        // new one.
        const scriptForSwitch = await import('./script.js');
        scriptForSwitch.changeMainAPI('openai');
        set('#main_api', 'openai');
        set('#chat_completion_source', 'custom');
        set('#custom_api_url_text', url);
        set('#custom_model_id', model);
        set('#api_key_custom', 'probe-key');
        const openai = await import('./scripts/openai.js');
        const power = await import('./scripts/power-user.js');
        power.power_user.savingAfterComplete = false;
        return { source: openai.oai_settings.chat_completion_source ?? null, url: openai.oai_settings.custom_url ?? null };
    }, { url: peerBase, model: 'probe-model' });
    report.afterReload = { ...afterReload, reopened, reconnected, settingsReadyAfterReload: readyReload };
    step('reload-reads-the-chat', afterReload.carriesMarker === true, JSON.stringify(report.afterReload));
    step('reload-chat-identity', typeof afterReload.chatId === 'string' && afterReload.chatId.length > 0, `chatId=${afterReload.chatId}`);

    // 3. A SECOND TURN AND A SWIPE ON THE SAME CHAT.
    //
    // The second turn goes through the frontend's own send. The visible text a user types is the SAME on both
    // subjects (it selects no branch), and the MARKER is then written into the message that send created -- so the
    // two subjects' chats differ in content and must produce DIFFERENT provider requests, which is what makes the
    // equality of the second turn something other than a tautology.
    //
    // WHAT THIS BLOCK USED TO GET WRONG, AND WHY IT IS THE (b) FIX. It broke its wait as soon as A USER TURN APPEARED
    // (`chat.some(position >= before && entry.is_user === true)`), then wrote the marker into that user turn and
    // returned. When the assistant reply landed later, the wait had already resolved -- so the SWIPE that follows was
    // performed on a USER message, and `swipe()` refuses that silently (`isSwipingAllowed()` false, no throw). Run
    // 40448869208 recorded exactly that on the pinned subject: `before {chatLength: 4, mesId: 3, lastIsUser: true,
    // swipes: null, swipeAllowed: false}` and an `after` where nothing had been swiped. `swipe-held` PASSED in that
    // state because the swipe had appended one empty swipe to the user message. A guard that can pass through a state
    // no user can produce is unfalsifiable, and it was supporting a scorecard row.
    //
    // THE WAIT IS NOW ON THE ASSISTANT TURN, through the shared `waitForReply`, which fails BY NAME
    // (`setup-reply-did-not-arrive`) and quotes the screen and the peer's request count. `requireText` is FALSE here
    // ON PURPOSE and the reason is recorded rather than hidden: runs 40445671791 and 40448869208 measured that the
    // stored assistant message has EMPTY text on BOTH subjects, so requiring text would turn a known, equally-observed
    // condition into a red attributed to this leg. The condition is carried in the artefact as
    // `emptyReplyOnBothSubjects` and its cause is an OPEN finding, not a chosen value.
    const secondTurn = await page.evaluate(async marker => {
        const script = await import('./script.js');
        const textarea = document.querySelector('#send_textarea');
        const button = document.querySelector('#send_but');
        if (!textarea || !button) return { clicked: false, reason: 'send controls missing' };
        const before = (script.chat ?? []).length;
        textarea.value = 'Q20 second turn input';
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
        return { clicked: true, before };
    }, MARKERS.second);
    const peerCompletionsBeforeSecondTurn = peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? '')).length;
    const secondTurnSettled = await waitForReply(page, { timeoutMs: 60000, requireText: false, peerCompletions: peerCompletionsBeforeSecondTurn + 1 });
    report.secondTurn = { ...secondTurn, settled: secondTurnSettled };
    step('second-turn-message-created',
        secondTurn?.clicked === true && secondTurnSettled.ok === true,
        secondTurnSettled.ok === true ? JSON.stringify(secondTurnSettled.state) : JSON.stringify(secondTurnSettled));
    // THE MARKER, WRITTEN INTO THE USER TURN THE PAGE ITSELF CREATED, and only after the reply has settled, so the
    // message the swipe will act on is the assistant reply and not the user turn.
    const marked = secondTurnSettled.ok === true ? await page.evaluate(async ({ marker, before }) => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        const userTurnIndex = chat.findIndex((entry, position) => position >= before && entry?.is_user === true);
        if (userTurnIndex < 0) return { wroteMarker: false, reason: 'no user turn after the send', chatLength: chat.length };
        chat[userTurnIndex].mes = marker;
        script.printMessages();
        const last = chat[chat.length - 1] ?? null;
        return {
            wroteMarker: true,
            index: userTurnIndex,
            afterText: String(chat[userTurnIndex]?.mes ?? ''),
            // WHAT THE SWIPE WILL ACT ON, recorded so the next step cannot be read in the wrong state.
            lastIsUser: last?.is_user === true,
            lastTextLength: String(last?.mes ?? '').length,
            chatLength: chat.length,
        };
    }, { marker: MARKERS.second, before: secondTurn?.before ?? 0 }) : { wroteMarker: false, reason: 'the reply never settled' };
    report.secondTurnMarker = marked;
    step('second-turn-marker-written', marked?.wroteMarker === true, JSON.stringify(marked));
    // THE PRECONDITION THE SWIPE ITSELF CHECKS. Asserted here so a swipe that refuses is never read as a finding.
    const swipePrecondition = await page.evaluate(async () => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        return {
            lastIsUser: chat[chat.length - 1]?.is_user === true,
            swipeAllowed: typeof script.isSwipingAllowed === 'function' ? script.isSwipingAllowed() : null,
            isSendPress: script.is_send_press ?? null,
        };
    });
    report.swipePrecondition = swipePrecondition;
    step('swipe-precondition-reachable',
        swipePrecondition.lastIsUser === false && swipePrecondition.swipeAllowed !== false && swipePrecondition.isSendPress !== true,
        JSON.stringify(swipePrecondition));

    // THE EQUALLY-OBSERVED CONDITION, NAMED AND NOT ASSERTED AWAY. If the last assistant message has empty text on BOTH
    // subjects this is reported as a fact about the fixture; it is NOT parity, and it is NOT this leg's claim.
    report.emptyReplyOnBothSubjects = secondTurnSettled.ok === true && Number(secondTurnSettled.state?.lastTextLength ?? -1) === 0;

    const swiped = await page.evaluate(async () => {
        const script = await import('./script.js');
        const constants = await import('./scripts/constants.js');
        const chat = script.chat ?? [];
        const mesId = chat.length - 1;
        const before = {
            chatLength: chat.length,
            mesId,
            lastText: String(chat[mesId]?.mes ?? '').slice(0, 80),
            lastIsUser: chat[mesId]?.is_user === true,
            swipeId: chat[mesId]?.swipe_id ?? null,
            swipes: Array.isArray(chat[mesId]?.swipes) ? chat[mesId].swipes.length : null,
            swipeAllowed: script.isSwipingAllowed(),
            generating: Boolean(script.streamingProcessor),
        };
        let error = null;
        try {
            // `forceMesId` is what the click handler derives from the message element; passing it keeps the same
            // message the clicks are wired to even though this call carries no DOM event.
            await script.swipe(null, constants.SWIPE_DIRECTION.RIGHT, { source: constants.SWIPE_SOURCE.SWIPE_PICKER, repeated: false, forceMesId: mesId });
        } catch (thrown) {
            error = String(thrown && thrown.message || thrown);
        }
        const after = script.chat ?? [];
        return {
            before,
            error,
            after: {
                chatLength: after.length,
                mesId,
                lastText: String(after[mesId]?.mes ?? '').slice(0, 80),
                swipeId: after[mesId]?.swipe_id ?? null,
                swipes: Array.isArray(after[mesId]?.swipes) ? after[mesId].swipes.length : null,
            },
        };
    });
    report.swipe = swiped;
    step('swipe-held', swiped?.error === null && swiped?.before?.lastIsUser === false
        && Number(swiped?.after?.swipeId) > Number(swiped?.before?.swipeId)
        && Number(swiped?.after?.swipes ?? 0) > Number(swiped?.before?.swipes ?? 0),
        JSON.stringify({ before: swiped?.before, error: swiped?.error, after: swiped?.after }));

    // THE CHAT IS SAVED AFTER THE SWIPE, through the frontend's own conditional save (the entry the swipe itself
    // ends with, script.js:9403), so the file on disk reflects the swipe.
    //
    // WAIT ON THE SAVE'S OWN COMPLETION BEFORE READING THE FILE -- this is the answer to the artefact/replay
    // disagreement this lane left open (run 40448869208: the leg recorded `swipePersisted.swipeId: null` while
    // replaying the SAME recorded `finalFiles` through the same module gave `swipe_id: 1`). Two readings of one
    // value must not both be true, so what the assertion may use is fixed here rather than chosen later:
    //   * `saveChatConditional()` resolves when the POST /api/chats/save RESPONSE has arrived (script.js:7395-7454),
    //     and the server writes the file inside that request (`trySaveChat`, src/endpoints/chats.js:531-541) -- so a
    //     file read after this resolves is the post-flush file;
    //   * the read is done ONCE, into `report.finalFiles`, and every guard below reads THAT, never a second snapshot
    //     taken later or earlier;
    //   * the read is WITNESSED: the number of successful `/api/chats/save` requests recorded up to and including the
    //     flush is carried in the artefact, so a reader can tell "the file was read after a 200" from "the leg read a
    //     file whose save had not been issued". A `saveWitnessed: false` makes the swipe assertion unresolvable
    //     rather than passing or failing on a stale file.
    const savesBeforeFlush = chatRequestLog().filter(entry => /\/api\/chats\/save$/.test(entry.path ?? '') && entry.status === 200).length;
    report.savedAfterSwipe = await page.evaluate(async () => {
        const script = await import('./script.js');
        try {
            await script.saveChatConditional();
            return { ok: true };
        } catch (error) {
            return { ok: false, error: String(error && error.message || error) };
        }
    });
    // A BOUNDED WAIT, ON THE RECORDER, FOR THE SAVE THE FRONTEND JUST ISSUED -- not a fixed sleep and not a retry:
    // the condition is "a save request answered 200 that had not answered before the flush", which is the product's
    // own observable completion.
    {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            await recorder.settled();
            const saves = chatRequestLog().filter(entry => /\/api\/chats\/save$/.test(entry.path ?? '') && entry.status === 200).length;
            if (saves > savesBeforeFlush) break;
            await page.waitForTimeout(250);
        }
    }
    await recorder.settled();
    report.chatRequests = chatRequestLog();
    report.saveWitness = {
        savesBeforeFlush,
        savesAfterFlush: chatRequestLog().filter(entry => /\/api\/chats\/save$/.test(entry.path ?? '') && entry.status === 200).length,
    };
    report.saveWitnessed = report.saveWitness.savesAfterFlush > savesBeforeFlush;
    report.pageRequests = recorder.requests.map(entry => ({ method: entry.method, path: entry.pathAndQuery, status: entry.status }));
    report.peerRequests = peer.requests.map(entry => ({
        method: entry.method,
        path: entry.path,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        body: entry.body,
    }));
    const completions = report.peerRequests.filter(entry => /chat\/completions/.test(entry.path ?? ''));
    report.completions = completions.length;
    step('peer-reached', completions.length >= 2, `${completions.length} chat/completions request(s); all peer requests: ${report.peerRequests.length}`);
    step('swipe-save-witnessed', report.saveWitnessed === true,
        `the swipe assertion needs a successful /api/chats/save AFTER the flush; before=${report.saveWitness.savesBeforeFlush} after=${report.saveWitness.savesAfterFlush}`);
    // THE ONE READ. Every guard below uses this array, never a later one.
    report.finalFiles = await readChatFiles();
    // TIGHTENED, AND THIS IS A CHANGE IN THE ARTEFACT'S MEANING (stated in the commit message, not only here).
    // THE OLD FORM: `some file has some message with swipes.length > 1`. That is satisfied by ANY chat file in the
    // tree, by ANY message in it, including one this leg never touched and including a file a previous step left
    // behind -- so a swipe written into the wrong chat, or a swipe that never reached disk while an unrelated
    // collection did, both passed. It is the weakest form of this assertion and it was the only one guarding the
    // swipe's persistence.
    // THE NEW FORM names the chat and the message: the file that carries this leg's SECOND marker, and the LAST
    // message in it, must have MORE swipes than the page had before the swipe AND must select the new one. The
    // before/after counts come from `report.swipe` (the page's own `swipe_id`/`swipes`), so the file is judged
    // against the state the UI showed rather than against a constant.
    const swipeFile = chatCarrying(report.finalFiles, MARKERS.second);
    const swipeBefore = report.swipe?.before ?? {};
    const swipeAfter = report.swipe?.after ?? {};
    // WHICH MESSAGE, AND WHY NOT BY NUMBER. `swipe.before.mesId` is a RENDERED DOM ordinal (`mesid`, script.js:8144
    // `chat[mesElement.attr('mesid')]`), and `chat[0]` is the chat header, so the file index and that number are not
    // the same namespace -- measured in run 40445671791, where treating them as one pointed the guard at the wrong
    // message. The file is therefore matched by the ONE thing the page and the file agree on: the message the swipe
    // was performed on is the assistant reply the page had on screen. It is located by "the last persisted message
    // that is not a user message and is not the greeting", i.e. the tail of the conversation, and its INDEX is then
    // recorded so a red names it.
    const persistedMessages = swipeFile?.messages ?? [];
    // THE MESSAGE IS FOUND BY THE SWIPE'S OWN SIGNATURE, which is the only thing that identifies it without sharing
    // an expectation with the product: it is the message whose persisted `swipes` array is LONGER than the array the
    // page had before the swipe. Measured against run 40445671791's recorded legs: both subjects hold exactly one
    // such message, at index 4, with `swipes: 2, swipe_id: 1` -- while the greeting also has a `swipes` array (of 1)
    // and an empty reply also has one, so "an assistant message near the tail" and "a message with text" both pick
    // the WRONG one. `mesId` from the page is a rendered DOM ordinal over `#chat .mes` and is not the chat index.
    const grewBeyond = Number(swipeBefore.swipes ?? 0);
    const candidates = persistedMessages.filter(message => Number(message?.swipesCount ?? 0) > grewBeyond);
    const persisted = candidates.length === 1 ? candidates[0] : null;
    report.swipePersisted = swipeFile ? {
        file: swipeFile.file,
        headerStripped: swipeFile.hasHeader === true,
        messageIndex: persisted?.index ?? null,
        candidateIndexes: candidates.map(message => message.index),
        pageMesId: swipeBefore.mesId ?? null,
        swipesCount: persisted?.swipesCount ?? null,
        swipeId: persisted?.swipeId ?? null,
        isUser: persisted?.is_user ?? null,
    } : null;
    // EACH SUB-CONDITION IS NAMED, so a red says WHICH field disagreed instead of handing back one boolean.
    const swipeChecks = {
        'the file carrying the second marker exists': Boolean(swipeFile),
        // THE WITNESS IS PART OF THE ASSERTION, not beside it: a file read before its save answered cannot say
        // anything about what the product persisted, so the check refuses rather than passing on a stale read.
        'the file was read AFTER a successful /api/chats/save': report.saveWitnessed === true,
        'exactly ONE persisted message grew its swipes array (the swiped one)': candidates.length === 1,
        'the file holds the same message count the page showed': Boolean(swipeFile) && persistedMessages.length === Number(swipeAfter.chatLength ?? -1),
        'the swiped message is not a user message': persisted?.is_user === false,
        'the persisted swipes array GREW past what the page had before the swipe': Number(persisted?.swipesCount ?? 0) > grewBeyond,
        'the persisted swipe_id is the one the page selected': Number(persisted?.swipeId ?? -1) === Number(swipeAfter.swipeId ?? -2),
    };
    const failedSwipeChecks = Object.entries(swipeChecks).filter(([, ok]) => !ok).map(([name]) => name);
    step('final-file-reflects-swipe', failedSwipeChecks.length === 0,
        JSON.stringify({
            failed: failedSwipeChecks,
            swipePersisted: report.swipePersisted,
            before: { swipes: swipeBefore.swipes, swipeId: swipeBefore.swipeId, mesId: swipeBefore.mesId },
            after: { swipes: swipeAfter.swipes, swipeId: swipeAfter.swipeId, chatLength: swipeAfter.chatLength },
            files: (report.finalFiles ?? []).map(file => `${file.file}:${file.lines}`),
        }));
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    if (browser) await browser.close();
    await peer.close();
    if (server) server.kill();
    report.serverLog = serverLog;
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${report.subject} leg: ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;
