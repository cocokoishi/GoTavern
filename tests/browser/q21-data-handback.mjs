// Q21 — CAN THE DATA A USER'S GOTAVERN WROTE BE HANDED BACK TO PINNED NODE AND KEEP RUNNING?
//
// This is GOAL §10 and scorecard Q21, and until now NOTHING in the tree drove it: the long-lived test proves GoTavern
// preserves a planted tree byte for byte, which is necessary and is not the same claim. "Still usable by the original
// Node SillyTavern" means the ORIGINAL SERVER opens the tree GoTavern wrote and continues the same conversation.
//
// THE DRIVE, in two halves that share one directory -- and then a second cycle inside the second half:
//   1. GOTAVERN WRITES. Boot the product over a fresh data root with a staged install (a card from the committed
//      desensitised fixture), open the character, send a turn, let the product save, record everything.
//   2. PINNED READS AND WRITES. Hand THE SAME data root to `run-against-pinned.mjs`, which boots pinned over a
//      caller-supplied root and passes the child PROBE_BASE_URL. The child re-runs this file and takes the pinned
//      half. It opens the SAVED conversation (the roster's `chat` name is a manufactured timestamp -- see below),
//      reads the GoTavern turn, CONTINUES the conversation through its own UI against the capture peer, creates a
//      BRANCH of it, and then boots GoTavern over the same root to prove the other direction:
//
//        (b) GoTavern writes -> pinned reads -> pinned mutates/writes -> GoTavern reads
//        (a) pinned writes   -> GoTavern reads -> GoTavern mutates/writes -> pinned reads
//
//      The two hops share one directory and three markers, one per write, so each direction names the turn it
//      proves rather than pointing at "the chat".
//
// WHAT IS ASSERTED, AND WHICH DIRECTION EACH ROW PROVES (structural, each able to fail):
//   gotavernWrote            the product's own chat file exists, under the STAGED CARD's own directory, and the turn
//                            the user typed is in it                                                     (b start)
//   pinnedOpened/opened      pinned serves the same character and the click moved the page onto it
//   pinnedOpenedSavedChat    pinned opened the FILE that already exists, not a fresh chat: a card carries no `chat`
//                            field, so pinned's roster manufactures one (`characters.js:554`) and the saved
//                            conversation is reached from the character's chat list, the way a user reaches it
//   pinnedReadTheChat        pinned's in-memory chat carries the GoTavern marker                          (b)
//   pinnedChatIdMatches      that chat's identity is the file's own name                                (b)
//   pinnedContinued          CONTINUE through pinned's UI REACHED THE PROVIDER carrying the handed-back history,
//                            and the continuation it produced was PERSISTED to the chat file               (b)
//   pinnedBranched           pinned's own branch action produced a second chat file and recorded the branch name in
//                            the parent's last message `extra.branches`                                  (b)
//   noDataLossOnHandBack     every file GoTavern wrote is still present with the same SHA-256             (b)
//   gotavernReadsPinned      GoTavern, booted FRESH over the tree pinned just wrote, reads the chat, the markers, the
//                            branch and the branch list                                                  (a)
//   rosterAgrees             the two runtimes list the same characters                                   (a)
//   cardMetadataAgrees       the two runtimes serve the same card document for the same file             (a)
//   chatAssociationAgrees    the two runtimes associate the same chat files with the same character      (a)
//   gotavernMutated          GoTavern appends a turn to the chat pinned wrote, and the file carries it    (a)
//   branchStateSurvivesGoWrite  GoTavern's save did not drop `extra.branches` from the parent chat       (a)
//   pinnedReadGotavernsTurn  pinned, reloaded, reads the turn GoTavern wrote                             (a)
//
// WHAT IT DOES NOT DO: it does not compare provider requests (Q14 owns that), it does not compare tokenisation or
// prompt construction (the continue request is asserted only for WHICH TURNS it carried), and it says nothing about
// an extension that refuses to load in a second runtime.
//
// A DRIVER HAZARD THAT COST RUNS, kept here because it will be hit again: `#CharID<n>` gets `data-chid` and `id`
// only (`public/script.js:946`); the card's LABEL lives on `.ch_name` (`:953`). Reading the label off the wrapper
// answered "" for every card and made a full roster look empty.

import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { seedLegConfig } from './seed-leg-config.mjs';

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

const external = Boolean(process.env.PROBE_BASE_URL);
const phase = external ? 'pinned' : 'gotavern';
const dataRoot = path.resolve(argumentValue('--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-q21-')));
const reportPath = path.resolve(argumentValue('--report', path.join(here, `q21-data-handback-${phase}.json`)));
const MARKERS = {
    first: 'Q21_HANDED_BACK_TURN_MARKER',
    second: 'Q21_PINNED_CONTINUATION_MARKER',
    third: 'Q21_GOTAVERN_AFTER_PINNED_MARKER',
};

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

async function waitForVersion(baseURL, deadlineMs = 120000) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
        try {
            const response = await fetch(`${baseURL}/version`);
            if (response.ok) return true;
        } catch {
            // not up yet
        }
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error(`${baseURL} did not answer within ${deadlineMs} ms`);
}

// The peer captures and answers; it never defines correctness (AGENTS 49).
//
// WHAT IT RECORDS, AND WHY THE BODY IS INSPECTED WITHOUT BEING STORED: `pinnedContinued` has to say that the
// continuation request CARRIED the handed-back history. A byte length and a digest cannot say that, and keeping the
// request body would put conversation text into a report. So the peer answers three booleans per request -- did this
// body carry each hand-back marker -- plus the generation `type` and the message count. Those are the only facts the
// capture leg asserts on, and each of them can be false.
//
// THE REPLY TEXT CARRIES THE LEG'S PHASE, AND THAT IS A BUG FIX, NOT A COSMETIC CHANGE. Both legs' peers used to
// answer `Q21_REPLY_<ordinal>`, so the FIRST pinned reply was byte-identical to the reply GoTavern's leg had already
// persisted into the handed-back tree. The pinned half's "did the send's reply land?" wait matched that STALE
// message in the chat file, let the CONTINUE press happen while the send was still streaming, and pinned's own
// `is_send_press == false` guard swallowed the press -- run 41171855911's `pinnedContinued` red with
// `continueRequests: 0`. Two peers answering the same string is a fixture that cannot distinguish "this leg's
// reply" from "the other runtime's reply"; `Q21_GOTAVERN_REPLY_n` / `Q21_PINNED_REPLY_n` restores the distinction.
function startCapturePeer({ replyTag = 'Q21' } = {}) {
    const requests = [];
    let reply = 0;
    const replyTextFor = ordinal => `${replyTag}_REPLY_${ordinal}`;
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
            const text = body.toString('utf8');
            let parsed = null;
            try {
                parsed = JSON.parse(text);
            } catch {
                parsed = null;
            }
            const messages = Array.isArray(parsed?.messages) ? parsed.messages : null;
            requests.push({
                method: request.method,
                path: request.url,
                byteLength: body.length,
                sha256: createHash('sha256').update(body).digest('hex'),
                carriesMarkers: Object.fromEntries(Object.entries(MARKERS).map(([key, marker]) => [key, text.includes(marker)])),
                generationType: typeof parsed?.type === 'string' ? parsed.type : null,
                stream: parsed?.stream === true,
                messageCount: messages === null ? null : messages.length,
                lastRole: messages === null || messages.length === 0 ? null : (messages[messages.length - 1]?.role ?? null),
                answersWith: replyTextFor(reply + 1),
            });
            const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
            if (request.method === 'GET' && /models/.test(request.url ?? '')) {
                response.writeHead(200, headers);
                response.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model' }] }));
                return;
            }
            // ANSWER IN THE PROTOCOL THE CLIENT ASKED FOR. Measured 2026-10-29: this peer answered plain JSON to a
            // request whose body said `stream: true` (pinned's own default is `oai_settings.stream_openai: true`,
            // read out of the tree it was handed), so BOTH frontends parsed zero chunks, appended an EMPTY assistant
            // message and left the generation busy. The "continue" that followed was then swallowed by the send still
            // in flight, which read as a hand-back defect in two directions. A peer answering in the wrong protocol is
            // a harness defect, and it is the one that hid `pinnedContinued`.
            if (parsed?.stream === true) {
                const id = `chatcmpl-q21-${reply + 1}`;
                const base = { id, object: 'chat.completion.chunk', created: 1730000000, model: 'probe-model' };
                response.writeHead(200, {
                    'content-type': 'text/event-stream',
                    'cache-control': 'no-cache',
                    'connection': 'keep-alive',
                    'access-control-allow-origin': '*',
                });
                const frame = payload => `data: ${JSON.stringify(payload)}\n\n`;
                response.write(frame({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }));
                response.write(frame({ ...base, choices: [{ index: 0, delta: { content: replyTextFor(reply + 1) }, finish_reason: null }] }));
                response.write(frame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }));
                response.write('data: [DONE]\n\n');
                response.end();
                reply += 1;
                return;
            }
            reply += 1;
            response.writeHead(200, headers);
            response.end(JSON.stringify({
                id: `chatcmpl-q21-${reply}`,
                object: 'chat.completion',
                created: 1730000000,
                model: 'probe-model',
                choices: [{ index: 0, message: { role: 'assistant', content: replyTextFor(reply) }, finish_reason: 'stop' }],
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

// Every file under the data root, hashed: the hand-back must not lose one byte of what the product wrote.
async function hashTree(root) {
    const files = {};
    const walk = async directory => {
        let entries = [];
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) {
                await walk(full);
                continue;
            }
            try {
                files[path.relative(root, full)] = createHash('sha256').update(await fs.readFile(full)).digest('hex');
            } catch {
                files[path.relative(root, full)] = null;
            }
        }
    };
    await walk(root);
    return files;
}

// BOTH HALVES MUST OPEN THE SAME CHARACTER, THE WAY A USER DOES -- AND THE WAY Q20 ALREADY PROVES WORKS.
// Three attempts failed by looking the character up in a MODULE INSTANCE (`import('./script.js')` inside
// `page.evaluate` gives the probe its own module graph, so `characters` was always [] and `rosterCount` 0 while the
// page's own list was full). `tests/browser/q20-persistence-probe.mjs:440-472` has the shape that works and is now
// used verbatim here: wait for the CARD in the DOM (`.character_select#CharID<n>`, script.js:945), click it, then
// wait on the PRODUCT's own chat state. The card's `data-chid` is recorded so a future mismatch is a field.
// WAIT FOR THE PAGE'S OWN READY FLAG, THEN FOR ITS OWN CHARACTER MODEL.
//
// MEASURED, run 40476539225 (`mode=preset`): both halves failed `opened` with
//   {"opened":false,"reason":"no .character_select card rendered in #rm_print_characters_block after 90000 ms",
//    "rendered":[],"modelNames":[]}
// `modelNames` is read from the page's `characters` array, and EMPTY means `getCharacters()` (script.js:1294) had not
// populated it -- so no selector was ever reached and the 90-second wait was waiting for a render that could not
// happen. The wait that was missing is the one Q20 already uses (`q20-persistence-probe.mjs:411-434`): the page
// signals readiness through its OWN flag `settingsReady`, and it prompts `.popup .onboarding` for a user name before
// it can become ready. A page that is not ready has no character model, whatever the server lists.
//
// THE ORDERING IS ALREADY CORRECT and was NOT changed: the card is staged into the tree BEFORE the server boots
// (`stageCharacterCard` runs before `spawn`), so the first `/api/characters/all` the page makes includes it. The
// `dataRootWasEmpty` and `characterStaged` rows happen before `page.goto` for exactly that reason.
async function waitForPageModel(page, { limitMs = 90000 } = {}) {
    return page.evaluate(async limit => {
        const script = await import('./script.js');
        const started = performance.now();
        const cleared = [];
        while (performance.now() - started < limit) {
            if ((script.characters ?? []).length > 0) {
                return { ready: true, modelNames: script.characters.map(entry => entry?.name ?? null), cleared, waitedMs: Math.round(performance.now() - started) };
            }
            // READY FIRST, ONBOARDING SECOND. `settingsReady` is the page's own flag (Q20 measured a click that
            // emptied the chat because a listener was not installed yet); the onboarding popup blocks it on a fresh
            // install and asks for a user name.
            const onboarding = document.querySelector('.popup .onboarding');
            if (onboarding) {
                const popup = onboarding.closest('.popup');
                const input = popup?.querySelector('.popup-input');
                if (input && input.value !== 'Probe User') {
                    input.value = 'Probe User';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                popup?.querySelector('.popup-button-ok')?.click();
                if (cleared[cleared.length - 1] !== 'onboarding') cleared.push('onboarding');
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return {
            ready: false,
            modelNames: (script.characters ?? []).map(entry => entry?.name ?? null),
            settingsReady: script.settingsReady === true,
            cleared,
            waitedMs: Math.round(performance.now() - started),
        };
    }, limitMs);
}

// BOTH HALVES MUST OPEN THE SAME CARD, BY THE NAME THE SERVER SHOWS, AND MUST PROVE WHICH CARD THEY OPENED.
//
// `Browser differential` 40467141027 (`mode=preset`, step "Hand GoTavern's own tree back to pinned Node (Q21)")
// measured the previous version of this function's failure in full: `characterStaged` passed, and then
// `gotavernWrote` failed with `chat files: default-user/chats/default_Assistant/Assistant - 2026-10-27@08h08m09s548ms.jsonl;
// wanting one under chats/Q21 Handback Card/`. The product had opened the DEFAULT ASSISTANT, saved the turn under
// it, and the report blamed the chat. On the pinned side the same defect read `no card matching "MARK_002794…";
// rendered 0`, because the pinned page was still on the welcome screen.
//
// THREE THINGS WERE WRONG, and each is answered here:
//  1. THE STEP LIST HAD NO `opened` ROW. A false opener proceeded to send, so an open failure was reported as a
//     chat failure. The caller now asserts `opened` (see the `step('opened', …)` calls in each half) BEFORE
//     anything derived from a chat, which is AGENTS 71: assert the precondition was reached before asserting
//     what depends on it.
//  2. THE OPENER MATCHED ON A LABEL THAT DOES NOT EXIST. The pinned template sets the card's `title` on the
//     `id="CharID<n>"` ELEMENT (`public/script.js:950-957`), not on the `.character_select` wrapper, so reading
//     `title` off the wrapper always answered "" and no card ever matched. The card is now identified from the
//     PAGE'S OWN MODEL -- `document.getElementById('CharID<n>').getAttribute('title')` for the label, and the
//     module's `characters[chid].avatar`/`name` for the identity -- because a label read from the wrong node is
//     the same class of defect as a state read back through the wrong reader (AGENTS 58).
//  3. THE WELCOME SCREEN WAS NEVER LEFT. A fresh install renders the welcome panel; `.character_select` rows may
//     not exist yet, and `q20-persistence-probe.mjs:436-472` already records this shape. The opener now waits on
//     the SERVER's roster *and* the DOM, clicks through the close button when the panel is up, and then REQUIRES
//     that the open changed the page's character identity -- a click that leaves `this_chid` on the assistant is
//     not an open of the staged card, whatever the DOM looked like.
// The click still comes from the DOM card (`script.js:945` renders `#CharID<n>`), never from a probe-side model
// mutation, because the question Q21 asks is what a USER can reach.
async function openCharacterByName(page) {
    const wanted = process.env.Q21_CHARACTER_NAME ?? null;
    const rosterMs = Number(process.env.Q21_ROSTER_MS ?? 90000);
    return page.evaluate(async ({ name, limitMs }) => {
        const script = await import('./script.js');
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const deadline = Date.now() + limitMs;
        let cards = [];
        // THE LABEL LIVES ON `.ch_name`, MEASURED IN THE PINNED TEMPLATE RATHER THAN ASSUMED.
        // `public/script.js:945-953` builds every card from `#character_template`: the clone gets `data-chid` and
        // `id` (`:946`), the avatar gets the `title` attribute (`:951`), and `.ch_name` gets BOTH the text and its
        // own `title` (`:953`). The `#CharID<n>` WRAPPER NEVER GETS A `title`. The old reader asked that wrapper
        // for one, so every card rendered as the empty string and the opener could not match the name the roster
        // had just answered -- measured on this host as `rendered: ["", ""]` with a TWO-CARD roster and
        // `characterStaged` green. The label is now read from the node the template writes it to, and it is
        // cross-checked against the page's own character model, because both are `item.name` (`:945` clones from
        // `getCharacters()`, which is the same array the card renders from): a label that disagrees with the model
        // is recorded and treated as a failure rather than matching either one.
        const collect = () => {
            cards = [...document.querySelectorAll('#rm_print_characters_block .character_select')].map(wrapper => {
                const id = wrapper.getAttribute('id') ?? '';
                const chid = String(wrapper.getAttribute('data-chid') ?? (id.startsWith('CharID') ? id.slice('CharID'.length) : ''));
                const label = String(wrapper.querySelector('.ch_name')?.textContent ?? '').trim();
                const modelName = chid === '' ? null : (script.characters?.[chid]?.name ?? null);
                return { wrapper, id, chid, label, modelName, labelAgreesWithModel: modelName === null ? null : modelName === label };
            });
            return cards;
        };
        while (Date.now() < deadline) {
            collect();
            if (cards.length > 0) break;
            // THE WELCOME SCREEN FIRST: while it is up the roster may be empty, and a probe that waits on the
            // roster alone times out on a page a user would simply click past.
            const close = document.querySelector('#chat .mes');
            if (!close) {
                document.querySelector('#rm_button_close')?.click();
                document.querySelector('.welcomePanel .close')?.click();
            }
            await sleep(250);
        }
        if (cards.length === 0) {
            return {
                opened: false,
                reason: `no .character_select card rendered in #rm_print_characters_block after ${limitMs} ms`,
                rendered: [],
                modelNames: (script.characters ?? []).map(entry => entry?.name ?? null),
            };
        }
        const before = {
            thisChid: script.this_chid ?? null,
            chatId: script.chatId ?? null,
            name: script.this_chid !== undefined ? (script.characters?.[script.this_chid]?.name ?? null) : null,
        };
        // A CARD MATCHES WHEN EITHER OF ITS TWO `item.name` REPRESENTATIONS DOES, and both are recorded. The
        // rendered label and the page model are the same value in the pinned template, so requiring one to speak
        // for the other would turn a rendering defect into a "wrong character" finding; recording both is what
        // lets a later report say WHICH of them disagreed.
        const matches = entry => entry.label === name || entry.modelName === name;
        const card = name ? cards.find(matches) ?? null : cards[0];
        if (!card) {
            return {
                opened: false,
                reason: `no card matching "${name}"`,
                rendered: cards.map(entry => entry.label),
                modelNames: cards.map(entry => entry.modelName),
                before,
            };
        }
        const chid = card.chid || card.id.replace('CharID', '');
        card.wrapper.click();
        // THE OPEN IS PROVEN BY THE PAGE'S OWN STATE, NOT BY THE CLICK: `this_chid` must become this card's id and
        // its name must be the one the server listed. A click that leaves the welcome screen in place, or opens the
        // assistant, fails here instead of three steps later.
        const settle = Date.now() + 30000;
        let after = null;
        while (Date.now() < settle) {
            after = {
                thisChid: script.this_chid ?? null,
                chatId: script.chatId ?? null,
                name: script.this_chid !== undefined ? (script.characters?.[script.this_chid]?.name ?? null) : null,
                chatLength: (script.chat ?? []).length,
                messages: document.querySelectorAll('#chat .mes').length,
            };
            if (String(after.thisChid) === String(chid) && after.chatLength > 0) break;
            await sleep(250);
        }
        // THE IDENTITY IS THE PAGE'S OWN MODEL VALUE for the card that was clicked, not the rendered label: the
        // label is what a user reads, the model is what the server listed, and the open is the model moving.
        const wantedName = card.modelName ?? card.label;
        const opened = String(after?.thisChid) === String(chid) && after?.name === wantedName;
        return {
            opened,
            dataChid: chid,
            label: card.label,
            modelName: card.modelName,
            labelAgreesWithModel: card.labelAgreesWithModel,
            wantedName,
            reason: opened ? null : `clicking "${card.label}"/#CharID${chid} left the page on ${JSON.stringify(after)}; wanted this_chid=${chid} name=${JSON.stringify(wantedName)}`,
            before,
            after,
            rendered: cards.map(entry => entry.label),
            modelNames: cards.map(entry => entry.modelName),
        };
    }, { name: wanted, limitMs: rosterMs });
}
const report = {
    schemaVersion: 1,
    question: 'Does the original Node SillyTavern open the tree GoTavern wrote, read the same conversation, and continue it?',
    phase,
    dataRoot,
    markers: MARKERS,
    steps: [],
    // EVERY WAIT THIS LEG PERFORMS, AS A NAMED CONDITION WITH WHAT IT OBSERVED. This is what makes a red row
    // diagnosable: "waited for the page's chat model to hold the send's reply, observed lastText=\"…\"" says
    // which wait failed, where the old report's `continueRequests: 0` only said a count was zero. A failure
    // throws with the condition's own `waitedFor`/`observed`, and the in-file judge names every failed one.
    conditions: [],
    pageErrors: [],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    // A STRUCTURED DETAIL MUST BE RENDERED, NOT INTERPOLATED. Template interpolation of an object is
    // "[object Object]", which is what the first CI execution of this probe printed for the one failing
    // row: "FAILURE: pinnedContinued: [object Object]" (Browser differential 40917936757). The reason
    // existed in the report and was unreadable in the log, so the next reader had to search the uploaded
    // JSON -- the same diagnostic defect AGENTS.md rule 20 records for a probe that fails silently.
    if (!ok && !report.failure) {
        const rendered = typeof detail === 'string' ? detail : JSON.stringify(detail);
        report.failure = `${name}: ${detail == null ? 'failed' : rendered}`;
    }
    return ok;
}

// A WAIT IS A NAMED CONDITION, NOT A DURATION.
//
// Every fixed sleep this probe used to contain hid the same question: what was actually being waited for?
// `waitForTimeout(3000)` before hashing the tree meant "maybe GoTavern has saved by now"; a poll for a reply
// TEXT meant "maybe that string is in the file" -- and both can be satisfied by a stale state, which is exactly
// how run 41171855911 produced `pinnedContinued` red with `continueRequests: 0` (the file already held the
// same reply string from the OTHER runtime).
//
// So each wait names (a) the condition in the subject's own state, (b) its deadline, and (c) the observation
// that was on the wire when it gave up. The condition is recorded in `report.conditions` whether it holds or
// not, and callers THROW with the condition's `waitedFor`/`observed` so a failure names the wait.
async function waitForCondition(name, { waitedFor, deadlineMs = 60000, intervalMs = 250, produce, accept, snapshot = value => value }) {
    const started = Date.now();
    let observed = null;
    let polls = 0;
    while (Date.now() - started < deadlineMs) {
        observed = await produce();
        polls += 1;
        if (accept(observed)) {
            const condition = { name, ok: true, waitedFor, deadlineMs, elapsedMs: Date.now() - started, polls, observed: snapshot(observed) };
            report.conditions.push(condition);
            return { ok: true, value: observed, condition };
        }
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    const condition = { name, ok: false, waitedFor, deadlineMs, elapsedMs: Date.now() - started, polls, observed: snapshot(observed) };
    report.conditions.push(condition);
    return { ok: false, value: observed, condition };
}

// A TREE IS SNAPSHOTTED WHEN IT STOPS MOVING, NOT WHEN A SLEEP ENDS.
//
// Replacing the GoTavern half's `waitForTimeout(3000)` with a save condition exposed a second, smaller race:
// `hashTree` could catch a file mid-write. Measured on this host: `default-user/.gotavern-content-log-<hash>.tmp`
// was present in the tree the product wrote and gone by the time pinned read the same directory, so
// `noDataLossOnHandBack` reported a REMOVAL of a file the product itself had already replaced with `content.log`.
// The condition is filesystem quiescence: two consecutive scans byte-identical over every path and digest. It is
// a real condition (not a wider timeout), and the returned hash is the settled snapshot.
async function waitForTreeQuiescence(name, { intervalMs = 750, maxMs = 30000 } = {}) {
    const started = Date.now();
    let previous = await hashTree(dataRoot);
    let scans = 1;
    while (Date.now() - started < maxMs) {
        await new Promise(resolve => setTimeout(resolve, intervalMs));
        const current = await hashTree(dataRoot);
        scans += 1;
        const changed = Object.keys(current).filter(file => !(file in previous) || previous[file] !== current[file]);
        const removed = Object.keys(previous).filter(file => !(file in current));
        if (changed.length === 0 && removed.length === 0) {
            const condition = { name, ok: true, waitedFor: 'two consecutive whole-tree scans are byte-identical (no file added, removed or rewritten between them)', deadlineMs: maxMs, elapsedMs: Date.now() - started, polls: scans, observed: { files: Object.keys(current).length, filesAddedOrChanged: [], filesRemoved: [] } };
            report.conditions.push(condition);
            return { ok: true, value: current, condition };
        }
        previous = current;
    }
    const condition = { name, ok: false, waitedFor: 'two consecutive whole-tree scans are byte-identical', deadlineMs: maxMs, elapsedMs: Date.now() - started, polls: scans, observed: { files: Object.keys(previous).length, note: 'the tree was still changing when the quiescence budget expired' } };
    report.conditions.push(condition);
    return { ok: false, value: previous, condition };
}

// ------------------------------------------------------------------------------------------------ the GoTavern half
// THE TREE NEEDS A CHARACTER BEFORE ANYTHING CAN OPEN ONE. Four runs of this probe changed HOW the character was
// opened (a CSS card, a module lookup, the DOM card, a bounded wait) while the tree never contained a card at all:
// run 40422280023 measured `no character card rendered in #rm_print_characters_block` on BOTH legs, and the GoTavern
// half's `gotavernWrote: true` was a FALSE POSITIVE -- it had saved a conversation with the fresh install's default
// assistant, not with the character it claimed to open. `tests/browser/asset-probe.mjs:236-261` already stages a tree
// correctly (a synthesised PNG plus the COMMITTED desensitised card from tests/browser/fixtures/real/card-a.png, which
// AGENTS 56 permits and the originals do not enter this repository). Same two files, same names, same rule that a
// missing fixture is a REFUSAL rather than a silent skip.
const CARD_FILE_NAME = 'Q21 Handback Card';
const CARD_RELATIVE = path.join(here, 'fixtures', 'real', 'card-a.png');

// WHICH DOCUMENT THE SERVER READS IS PINNED, AND THIS READER MUST READ THE SAME ONE.
// `GoTavern Lane CI` 40446833206 logged the committed card's four names:
//     chara: data.name="MARK_000466…" root.name="MARK_000464…"
//     ccv3:  data.name="MARK_002794…" root.name="MARK_002792…"
// The server answered …794, because `ccv3` takes precedence (pinned src/character-card-parser.js:54-78; the port's
// characters_card.go:178-182 is the same rule). This function used to RETURN ON THE FIRST MATCH IN FILE ORDER, and
// `chara` is written before `ccv3`, so it read …466 -- the OTHER document -- and every later step was then about a
// name the server had never been asked about. Two runs (40438262854, 40444636900) and six driver commits were spent
// reconciling that, which is the cost of a reader that is not equivalent to the subject's own.
//
// THE RULE, in the pinned order: collect every chara/ccv3 tEXt chunk, then take the FIRST `ccv3`, else the FIRST
// `chara`. `selfCheckCardReader` below proves this on a synthetic file whose two chunks carry DIFFERENT names,
// including the `chara`-first order the committed card has.
function cardChunks(bytes) {
    const chunks = [];
    let offset = 8;
    while (offset + 8 <= bytes.length) {
        const length = bytes.readUInt32BE(offset);
        const type = bytes.toString('latin1', offset + 4, offset + 8);
        const dataStart = offset + 8;
        if (dataStart + length > bytes.length) break;
        if (type === 'tEXt') {
            const chunk = bytes.subarray(dataStart, dataStart + length);
            const zero = chunk.indexOf(0);
            const keyword = zero > 0 ? chunk.toString('latin1', 0, zero) : '';
            if (/^(ccv3|chara)$/i.test(keyword)) {
                chunks.push({ keyword: keyword.toLowerCase(), base64: chunk.subarray(zero + 1).toString('latin1') });
            }
        }
        offset = dataStart + length + 4;
        if (type === 'IEND') break;
    }
    return chunks;
}

function cardChunkDocument(chunk) {
    const raw = Buffer.from(chunk.base64, 'base64').toString('utf8');
    // `chara` is the V1/V2 form, which pinned writes percent-encoded in the oldest cards and plain JSON in newer
    // ones; a decode that throws falls back to the raw text, and JSON.parse decides.
    const text = chunk.keyword === 'ccv3' ? raw : (() => {
        try {
            return decodeURIComponent(raw);
        } catch {
            return raw;
        }
    })();
    return JSON.parse(text);
}

// The name the server will list, read the way the server reads it: ccv3 precedence, `data.name` when present,
// otherwise the document's own root name (pinned readFromV2, src/endpoints/characters.js:525-551).
function cardOwnName(bytes) {
    const chunks = cardChunks(bytes);
    const selected = chunks.find(chunk => chunk.keyword === 'ccv3') ?? chunks.find(chunk => chunk.keyword === 'chara');
    if (!selected) return null;
    try {
        const document = cardChunkDocument(selected);
        return String(document?.data?.name ?? document?.name ?? '') || null;
    } catch {
        return null;
    }
}

// THE READER PROVES ITSELF BEFORE IT IS TRUSTED. A `chara`-first file whose two chunks carry different names must
// read the `ccv3` one, and the same file with the chunks swapped must read the same value -- so the answer cannot
// depend on file order, which is the exact defect this replaced.
function selfCheckCardReader() {
    const chunk = (keyword, name) => {
        const payload = Buffer.concat([
            Buffer.from(`${keyword}\0`, 'latin1'),
            Buffer.from(Buffer.from(JSON.stringify({ name: `root-${name}`, data: { name } }), 'utf8').toString('base64'), 'latin1'),
        ]);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(payload.length);
        return Buffer.concat([length, Buffer.from('tEXt', 'latin1'), payload, Buffer.alloc(4)]);
    };
    const build = order => Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
        ...order.map(([keyword, name]) => chunk(keyword, name)),
    ]);
    const charaFirst = cardOwnName(build([['chara', 'V2_MARKER'], ['ccv3', 'V3_MARKER']]));
    const ccv3First = cardOwnName(build([['ccv3', 'V3_MARKER'], ['chara', 'V2_MARKER']]));
    if (charaFirst !== 'V3_MARKER' || ccv3First !== 'V3_MARKER') {
        throw new Error(`the card reader is not equivalent to the server's: chara-first read "${charaFirst}", ccv3-first read "${ccv3First}", both must be "V3_MARKER" (pinned character-card-parser.js:54-78 gives ccv3 precedence)`);
    }
    return { charaFirst, ccv3First };
}

async function stageCharacterCard(root) {
    const charactersDir = path.join(root, 'default-user', 'characters');
    await fs.mkdir(charactersDir, { recursive: true });
    let bytes;
    try {
        bytes = await fs.readFile(CARD_RELATIVE);
    } catch (error) {
        throw new Error(`the committed card is not readable at ${CARD_RELATIVE}: ${error?.message ?? error}`);
    }
    const staged = path.join(charactersDir, `${CARD_FILE_NAME}.png`);
    await fs.writeFile(staged, bytes);
    // THE READER IS PROVEN BEFORE ITS ANSWER IS USED, and both chunk names are recorded, because the committed card
    // carries two DIFFERENT documents (Lane CI 40446833206) and a report that shows only one of them cannot say
    // which document any later disagreement was about.
    const selfCheck = selfCheckCardReader();
    const chunks = cardChunks(bytes).map(entry => {
        let document = null;
        try {
            document = cardChunkDocument(entry);
        } catch {
            document = null;
        }
        return { keyword: entry.keyword, dataName: String(document?.data?.name ?? ''), rootName: String(document?.name ?? '') };
    });
    const ownName = cardOwnName(bytes);
    if (!ownName) throw new Error(`the committed card at ${CARD_RELATIVE} carries no readable data.name`);
    return { staged, ownName, chunks, readerSelfCheck: selfCheck, byteLength: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

// The character list the SERVER returns, asked over HTTP so the answer cannot depend on the probe's module graph.
// A MINIMAL COOKIE ROUND TRIP, BECAUSE THE CSRF TOKEN LIVES IN THE SIGNED SESSION COOKIE.
// internal/server/csrf_session.go: the token is the session's "csrfToken" field (:200-208) and the session travels as
// `session-<hex>` plus `session-<hex>.sig` (:257-263), with the name derived from the hostname (:172-173) -- so the
// name is never hard-coded here. Without sending those cookies back, the token cannot be found in the session and the
// route answers 403 "Invalid CSRF token", which is exactly what run 40427250663 measured. Only NAME=LENGTH pairs are
// recorded: a session cookie is signing material and this repository does not log secrets.
async function postForJSON(baseURL, pathName, body) {
    const jar = new Map();
    const absorb = response => {
        for (const [name, value] of response.headers) {
            if (name.toLowerCase() !== 'set-cookie') continue;
            const pair = String(value).split(';')[0];
            const equals = pair.indexOf('=');
            if (equals > 0) jar.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
        }
    };
    const cookieHeader = () => [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
    const tokenResponse = await fetch(`${baseURL}/csrf-token`);
    absorb(tokenResponse);
    const tokenData = await tokenResponse.json().catch(() => null);
    const token = tokenData?.token ?? null;
    const cookies = [...jar.keys()];
    if (!token) return { ok: false, reason: '/csrf-token answered without a token', cookies, names: [] };
    const response = await fetch(`${baseURL}${pathName}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': token, cookie: cookieHeader() },
        body: JSON.stringify(body ?? {}),
    });
    absorb(response);
    const text = await response.text();
    if (!response.ok) return { ok: false, reason: `POST ${pathName} answered ${response.status}: ${text.slice(0, 160)}`, cookies, names: [] };
    let parsed = null;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { ok: false, reason: `not JSON: ${text.slice(0, 120)}`, cookies, names: [] };
    }
    // THE CALLER DECIDES WHAT THE BODY MEANS. /api/characters/all answers an array (or `{characters}`); other routes
    // answer a plain object. The parsed body is returned as `body` so a caller can read a field without a second shape
    // being guessed here.
    const rows = Array.isArray(parsed) ? parsed : (parsed?.characters ?? []);
    return { ok: true, names: rows.map(row => row?.name ?? null), count: rows.length, cookies, body: parsed };
}

async function listCharacters(baseURL) {
    // THE REQUEST MUST LOOK LIKE THE FRONTEND'S, OR THE ANSWER IS ABOUT THE REQUEST.
    return postForJSON(baseURL, '/api/characters/all', {});
}
async function gotavernWrites() {
    const binarySetting = process.env.GOTAVERN_BINARY;
    if (!binarySetting) throw new Error('GOTAVERN_BINARY is required for the GoTavern half');
    // THE TREE MUST BE EMPTY BEFORE ANYTHING IS STAGED, OR EVERY LATER ROW COULD BE SOMEONE ELSE'S. The workflow
    // recreates the directory (rm -rf then mkdir), so this is a cheap assertion that the driver is running where it
    // thinks it is -- and it names the entries when it is not.
    const existingEntries = await fs.readdir(dataRoot).catch(() => []);
    report.dataRootWasEmpty = existingEntries.length === 0;
    step('dataRootWasEmpty', report.dataRootWasEmpty, `entries: ${JSON.stringify(existingEntries).slice(0, 300)}`);
    if (!report.dataRootWasEmpty) {
        throw new Error(`the data root ${dataRoot} was not empty: ${JSON.stringify(existingEntries).slice(0, 300)}`);
    }
    await fs.cp(path.join(repoRoot, 'upstream', 'tokenizers'), path.join(dataRoot, 'tokenizers'), { recursive: true });
    report.stagedCard = await stageCharacterCard(dataRoot);
    await seedLegConfig(dataRoot);
    const port = await freePort();
    // `--browserLaunchEnabled false` IS NOT OPTIONAL, AND THIS LEG WAS MISSING IT. The seeded config is the
    // PINNED default, whose `browserLaunch.enabled` is TRUE (`upstream/default/config.yaml`), so a server that
    // honours it opens the OPERATOR'S DEFAULT BROWSER at boot. A local stability campaign therefore opened real
    // tabs on the developer's desktop -- measured and reported by the operator -- which is exactly the hazard
    // `run-against-pinned.mjs` and `q20-leg-runtime.mjs` already record for the same flag. The override keeps the
    // pinned config bytes untouched (rule 14) while making a probe boot a headless server.
    const server = spawn(path.resolve(binarySetting), ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml'), '--browserLaunchEnabled', 'false'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
    const peer = await startCapturePeer({ replyTag: 'Q21_GOTAVERN' });
    let browser;
    try {
        await waitForVersion(`http://127.0.0.1:${port}`);
        // THE PRECONDITION, ASSERTED BEFORE ANY DRIVING: the card is on disk AND the server lists it BY NAME.
        // Asking over HTTP rather than through the page keeps this independent of the probe's module graph.
        const starter = await listCharacters(`http://127.0.0.1:${port}`);
        report.serverRoster = starter;
        // ASSERT THE NAME THE SERVER SHOWS, WHICH IS THE CARD`S OWN `data.name`, AND NAME ANYTHING ELSE IN THE TREE.
        // A roster that contains rows this probe did not stage means the data root was not clean, which would make
        // every later verdict depend on someone else's leftovers -- the same shape as the adversarial case fixed in
        // 03f1988. `unexpectedCharacters` records it instead of letting it pass silently.
        const stagedName = report.stagedCard.ownName;
        report.unexpectedCharacters = starter.names.filter(name => name !== stagedName);
        // THE QUERY ALREADY GOES TO MY OWN PORT (``127.0.0.1:${port}``), which is the instance this half booted over
        // this very directory -- so a roster that ALSO holds rows this probe never staged means the instance is
        // reading a tree other than the one it was given, which is a finding in its own right, not a driver quirk.
        report.rosterQueryUrl = `http://127.0.0.1:${port}/api/characters/all`;
        // WHICH USER TREE IS IT SERVING? `POST /api/users/me` answers the handle the server believes it is on; if it
        // is not the handle this probe staged into, the roster above is somebody else's list and every later verdict
        // would be about the wrong tree.
        const me = await postForJSON(`http://127.0.0.1:${port}`, '/api/users/me', {}).catch(() => null);
        report.serverUserHandle = me?.ok ? (me.body?.handle ?? me.body?.user ?? me.body?.name ?? null) : null;
        step('characterStaged', starter.ok === true && starter.names.includes(stagedName), `wanting "${stagedName}"; roster ${JSON.stringify(starter.names).slice(0, 300)}`);
        if (!starter.ok || !starter.names.includes(stagedName)) {
            throw new Error(`the staged card "${stagedName}" is not listed by the server: ${JSON.stringify(starter).slice(0, 300)}`);
        }
        // HEADLESS IS EXPLICIT, NOT IMPLIED. Playwright's default is headless today, but a browser window on the
        // operator's desktop is not a failure mode worth leaving to a default: the probe measures page state and
        // never needs a visible surface.
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
        await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
        await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
        // THE PAGE MUST HAVE ITS OWN MODEL BEFORE A CARD CAN BE OPENED. Run 40476539225 measured `modelNames: []`
        // on both halves -- the wait for a render was waiting for a render that could not happen.
        report.gotavernPageModel = await waitForPageModel(page);
        step('pageModelLoaded', report.gotavernPageModel.ready === true, JSON.stringify(report.gotavernPageModel).slice(0, 500));
        if (!report.gotavernPageModel.ready) {
            throw new Error(`the GoTavern page never populated its character model: ${JSON.stringify(report.gotavernPageModel).slice(0, 400)}`);
        }
        // The connection and the API switch BOTH have to be set
        // The connection and the API switch BOTH have to be set: `chat_completion_source` does not move `main_api`,
        // and the fresh-install default is the Horde branch (measured in the Q20 lane, run 40375075025).
        await page.evaluate(async ({ url, model }) => {
            const set = (selector, value) => {
                const control = document.querySelector(selector);
                if (!control) return;
                control.value = value;
                control.dispatchEvent(new Event('input', { bubbles: true }));
                control.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const script = await import('./script.js');
            script.changeMainAPI('openai');
            set('#main_api', 'openai');
            set('#chat_completion_source', 'custom');
            set('#custom_api_url_text', url);
            set('#custom_model_id', model);
            set('#api_key_custom', 'probe-key');
        }, { url: `http://127.0.0.1:${peer.port}/v1`, model: 'probe-model' });
        // THE SAME CARD, OPENED THE SAME WAY, on each side's own tree. The name comes from the card the probe staged,
        // so this half cannot drift to a different character than the half that reads it back.
        process.env.Q21_CHARACTER_NAME = report.stagedCard.ownName;
        report.opened = await openCharacterByName(page);
        // THE PRECONDITION IS A STEP OF ITS OWN, ASSERTED BEFORE ANYTHING THAT DEPENDS ON IT. `Browser differential`
        // 40467141027 sent a turn after the opener had failed and reported `gotavernWrote`, so the finding read
        // "the chat went to the wrong character" when the truth was "the card never opened" -- the default
        // assistant took the turn instead. A false opener now fails here, with the opener's own account of what it
        // saw (rendered labels, the page's before/after identity), and nothing is sent.
        step('opened', report.opened.opened === true, JSON.stringify(report.opened).slice(0, 600));
        if (!report.opened.opened) {
            throw new Error(`the GoTavern half could not open the staged card "${report.stagedCard.ownName}": ${report.opened.reason}`);
        }
        const sent = await page.evaluate(async marker => {
            const script = await import('./script.js');
            const textarea = document.querySelector('#send_textarea');
            const button = document.querySelector('#send_but');
            if (!textarea || !button) return { clicked: false };
            const before = (script.chat ?? []).length;
            textarea.value = marker;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            button.click();
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                const chat = script.chat ?? [];
                if (chat.findIndex((entry, position) => position >= before && entry?.is_user === true) >= 0) return { clicked: true };
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            return { clicked: true, timedOut: true };
        }, MARKERS.first);
        report.gotavernSend = sent;
        // THE WRITE IS WAITED ON, NOT SLEPT THROUGH. The old `waitForTimeout(3000)` before hashing the tree was
        // exactly the shape AGENTS rule 33 forbids: a fixed sleep standing in for "the save has happened". It made
        // the tree handed to pinned a TIMING SAMPLE -- a fast host handed over a chat whose reply was persisted, a
        // slow one handed over a chat with only the user turn -- and the pinned half's own persistence check was
        // then the first thing to notice. Both conditions below are the subject's own state: a request left the
        // GoTavern frontend, and a chat file under the STAGED CARD carries the user turn followed by that request's
        // reply.
        const goSendRequest = await waitForCondition('gotavern-send-request-reached-peer', {
            waitedFor: `the capture peer records a chat-completions request carrying "${MARKERS.first}" (a request left the GoTavern frontend)`,
            deadlineMs: 60000,
            produce: async () => peer.requests.filter(entry => entry.carriesMarkers.first === true),
            accept: list => list.length > 0,
            snapshot: () => peer.requests.map(entry => ({ markers: entry.carriesMarkers, answersWith: entry.answersWith, stream: entry.stream, messageCount: entry.messageCount })),
        });
        report.gotavernSendRequest = { ok: goSendRequest.ok, condition: goSendRequest.condition };
        if (!goSendRequest.ok) {
            throw new Error(`gotavern-send-request-reached-peer: waited for ${goSendRequest.condition.waitedFor}; observed ${JSON.stringify(goSendRequest.condition.observed).slice(0, 900)}`);
        }
        const goReply = goSendRequest.value[goSendRequest.value.length - 1]?.answersWith ?? null;
        const goPersisted = await waitForCondition('gotavern-send-committed-to-disk', {
            waitedFor: `a chat file under chats/${CARD_FILE_NAME}/ holds the user turn "${MARKERS.first}" followed by an assistant turn whose text is "${goReply}"`,
            deadlineMs: 60000,
            produce: async () => {
                const files = await savedChatFiles();
                const reads = [];
                for (const file of files) {
                    reads.push({ file, chat: await readChatFile(file.replace(/\.jsonl$/, '')) });
                }
                return reads;
            },
            accept: reads => reads.some(({ chat }) => {
                if (!Array.isArray(chat)) return false;
                const userIndex = chat.findIndex(entry => String(entry?.mes ?? '').includes(MARKERS.first));
                return userIndex >= 0 && chat.slice(userIndex + 1).some(entry => entry?.is_user === false && String(entry?.mes ?? '') === goReply);
            }),
            snapshot: reads => reads.map(({ file, chat }) => ({
                file,
                messages: Array.isArray(chat) ? chat.length : null,
                tail: Array.isArray(chat) ? chat.slice(-2).map(entry => ({ role: entry?.is_user ? 'user' : entry?.is_system ? 'system' : 'assistant', bytes: String(entry?.mes ?? '').length, tail: String(entry?.mes ?? '').slice(-40) })) : null,
            })),
        });
        report.gotavernSendPersistence = goPersisted.condition;
        if (!goPersisted.ok) {
            throw new Error(`gotavern-send-committed-to-disk: waited for ${goPersisted.condition.waitedFor}; observed ${JSON.stringify(goPersisted.condition.observed).slice(0, 900)}`);
        }
        step('gotavernSendReplyPersisted', true, JSON.stringify({ reply: goReply, condition: goPersisted.condition.name, elapsedMs: goPersisted.condition.elapsedMs }));
        const goTreeQuiescent = await waitForTreeQuiescence('gotavern-tree-quiescent');
        report.gotavernTreeQuiescence = goTreeQuiescent.condition;
        if (!goTreeQuiescent.ok) {
            throw new Error(`gotavern-tree-quiescent: waited for ${goTreeQuiescent.condition.waitedFor}; observed ${JSON.stringify(goTreeQuiescent.condition.observed).slice(0, 900)}`);
        }
        report.writtenTree = goTreeQuiescent.value;
        const chats = Object.keys(report.writtenTree).filter(file => file.endsWith('.jsonl'));
        report.chatFiles = chats;
        // A SAVED CHAT IS NOT THE CLAIM; A SAVED CHAT WITH THE CHARACTER IT OPENED IS. Run 40422280023 reported
        // `gotavernWrote: true` for a conversation the product had started with the fresh install's default
        // assistant, while the opener had failed with `no character card rendered`. Require the chat path to
        // NAME the staged card.
        const wantedChatDir = `chats/${CARD_FILE_NAME}/`;
        // THE SEPARATOR IS THE HOST'S, THE QUESTION IS NOT. `hashTree` records `path.relative` results, which use
        // `\` on Windows and `/` on Linux; a check for `chats/<card>/` therefore failed on this host for a chat that
        // WAS in the right directory (measured: `default-user\chats\Q21 Handback Card\MARK_002794… - 2026-…jsonl`),
        // and that is a driver artefact rather than a product finding (AGENTS.md "a local red is a hypothesis").
        // The comparison is on a NORMALISED copy so a future report cannot read a separator as a wrong character;
        // the raw list is recorded above it either way.
        const normalised = chats.map(file => file.split(path.sep).join('/'));
        const matching = normalised.filter(file => file.includes(wantedChatDir));
        step('gotavernWrote', matching.length > 0, `chat files: ${chats.join(', ') || 'none'}; wanting one under ${wantedChatDir}`);
        report.matchingChatFiles = matching;
    } finally {
        if (browser) await browser.close();
        await peer.close();
        server.kill();
    }
}

// ------------------------------------------------------------------------------------------------ the pinned half
//
// THE SAVED CHAT IS NOT THE CHAT THE ROSTER NAMES, AND THAT IS PINNED'S OWN BEHAVIOUR. A card carries no `chat`
// field, and pinned MANUFACTURES one on every read:
//
//     char.chat = char.chat ?? `${char.name} - ${humanizedDateTime()}`      src/endpoints/characters.js:554
//
// so clicking the character opens a chat named with the CURRENT SECOND, not the conversation that is on disk. The
// first version of this half clicked the card, read a one-message chat and reported `carriesMarker: false` for a tree
// that was in fact intact. A user reaches the saved conversation from the character's chat list, and so does this
// half: the list is read from the same route the list panel uses (`/api/characters/chats`,
// `characters.js:1499-1535`) and the conversation is opened through the frontend's own `openCharacterChat`
// (`public/script.js:7744`), which is exactly what a row click in that panel calls.
async function savedChatFiles() {
    const chatsDirectory = path.join(dataRoot, 'default-user', 'chats', CARD_FILE_NAME);
    const entries = await fs.readdir(chatsDirectory).catch(() => []);
    return entries.filter(name => name.endsWith('.jsonl')).sort();
}

// ONE CHAT FILE, PARSED THE WAY THE SERVER PARSES IT (`chats.js:577-590`: split on newlines, keep the lines that
// parse). A missing file is `null`, never an empty chat: "no file" and "an empty conversation" are different
// findings and this probe must not conflate them.
async function readChatFile(chatName) {
    const target = path.join(dataRoot, 'default-user', 'chats', CARD_FILE_NAME, `${chatName}.jsonl`);
    const text = await fs.readFile(target, 'utf8').catch(() => null);
    if (text === null) return null;
    return text.split('\n').map(line => {
        try {
            return JSON.parse(line);
        } catch {
            return null;
        }
    }).filter(Boolean);
}

const chatText = chat => (Array.isArray(chat) ? chat.map(entry => String(entry?.mes ?? '')).join('\n') : '');

async function pollUntil(produce, accept, deadlineMs) {
    const deadline = Date.now() + deadlineMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await produce();
        if (accept(last)) return { ok: true, value: last };
        await new Promise(resolve => setTimeout(resolve, 250));
    }
    return { ok: false, value: last };
}

// THE FRONTEND'S OWN ENTRY POINT FOR OPENING A SAVED CONVERSATION, WITH THE PANEL TRIED FIRST.
// A user clicks `#option_select_chat`, then the `.select_chat_block[file_name="…"]` row the panel renders from
// `/api/chats/search` (`public/script.js:8604-8618`); that row's handler calls `openCharacterChat`
// (`:11484-11510`, `:7744`). This drives the panel and falls back to the same function when the headless layout does
// not render a row -- and RECORDS which path was taken, so "the panel path was not exercised" cannot read as "it was".
async function openSavedChat(page, chatName) {
    return page.evaluate(async ({ wanted }) => {
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        let viaPanel = false;
        let rendered = [];
        try {
            document.querySelector('#option_select_chat')?.click();
            const deadline = Date.now() + 15000;
            while (Date.now() < deadline) {
                const rows = [...document.querySelectorAll('#select_chat_div .select_chat_block')];
                rendered = rows.map(row => String(row.getAttribute('file_name') ?? ''));
                const row = rows.find(entry => String(entry.getAttribute('file_name') ?? '') === wanted);
                if (row) {
                    row.click();
                    viaPanel = true;
                    break;
                }
                await sleep(250);
            }
        } catch (error) {
            viaPanel = false;
        }
        if (!viaPanel) {
            const script = await import('./script.js');
            await script.openCharacterChat(wanted);
        }
        const settle = Date.now() + 30000;
        while (Date.now() < settle) {
            const context = window.SillyTavern?.getContext?.();
            if (context?.chatId === wanted && (context?.chat ?? []).length > 0) {
                return { opened: true, viaPanel, rendered, chatId: context.chatId, chatLength: context.chat.length };
            }
            await sleep(250);
        }
        const context = window.SillyTavern?.getContext?.();
        return {
            opened: false,
            viaPanel,
            rendered,
            chatId: context?.chatId ?? null,
            chatLength: (context?.chat ?? []).length,
            reason: `opening "${wanted}" left chatId=${JSON.stringify(context?.chatId ?? null)} and a ${(context?.chat ?? []).length}-message chat`,
        };
    }, { wanted: chatName });
}

// The provider controls the page sends in every generation request. Set on both subjects through the same controls,
// because the provider URL is a property of the FRONTEND request (`chat_completion_source: 'custom'` +
// `custom_url`), not of server settings -- which is why a tree written under a peer port that has since died is
// still usable once the user points the connection at a live one.
async function pointAtPeer(page, peer) {
    await page.evaluate(async ({ url, model }) => {
        const set = (selector, value) => {
            const control = document.querySelector(selector);
            if (!control) return;
            control.value = value;
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
        };
        const script = await import('./script.js');
        script.changeMainAPI('openai');
        set('#main_api', 'openai');
        set('#chat_completion_source', 'custom');
        set('#custom_api_url_text', url);
        set('#custom_model_id', model);
        set('#api_key_custom', 'probe-key');
    }, { url: `http://127.0.0.1:${peer.port}/v1`, model: 'probe-model' });
}

// THE SAME CARD DOCUMENT, COMPARED BETWEEN THE TWO RUNTIMES. `chat` is DELIBERATELY excluded and the exclusion is
// pinned's own rule: the roster's chat name is regenerated on every read (`characters.js:554`) and removed before
// saving (`unsetPrivateFields`, `:498-502`), so two reads one second apart differ by DESIGN. Everything else here is
// a field a reader answers from the card, so a difference is a hand-back defect.
function cardProjection(row) {
    if (!row || typeof row !== 'object') return null;
    const jsonData = typeof row.json_data === 'string' ? row.json_data : null;
    return {
        name: row.name ?? null,
        avatar: row.avatar ?? null,
        createDate: row.create_date ?? null,
        dataName: row.data?.name ?? null,
        spec: row.spec ?? null,
        specVersion: row.spec_version ?? null,
        creator: row.data?.creator ?? null,
        characterVersion: row.data?.character_version ?? null,
        world: row.data?.extensions?.world ?? null,
        alternateGreetings: Array.isArray(row.data?.alternate_greetings) ? row.data.alternate_greetings.length : null,
        bookEntries: Array.isArray(row.data?.character_book?.entries) ? row.data.character_book.entries.length : null,
        jsonDataBytes: jsonData === null ? null : Buffer.byteLength(jsonData),
        jsonDataSha256: jsonData === null ? null : createHash('sha256').update(jsonData).digest('hex'),
    };
}

async function characterChats(baseURL, avatarFile) {
    // `simple` is pinned's own cheap form (`characters.js:1517-1519`): file names only, no preview, no race against a
    // chat file being written by the other runtime.
    const answer = await postForJSON(baseURL, '/api/characters/chats', { avatar_url: avatarFile, simple: true });
    if (!answer.ok) return answer;
    const rows = Array.isArray(answer.body) ? answer.body : [];
    return { ok: true, files: rows.map(row => row?.file_name ?? null).filter(Boolean).sort(), reason: null };
}

// A FRESH GOTAVERN OVER A TREE IT DID NOT WRITE. This is the other direction's subject: it is booted AFTER pinned has
// written, so anything it reads came off the disk in pinned's format.
async function bootGotavernOver(root) {
    const binarySetting = process.env.GOTAVERN_BINARY;
    if (!binarySetting) throw new Error('GOTAVERN_BINARY is required to hand the tree BACK to GoTavern; without it this direction cannot run and must not be reported as passed');
    const port = await freePort();
    // SAME FLAG AS THE OTHER BOOT SITE: this second GoTavern process (over the tree pinned just wrote) must not
    // open a desktop browser either. The flag is passed at every boot rather than relying on the caller.
    const child = spawn(path.resolve(binarySetting), ['start', '--port', String(port), '--dataRoot', root, '--configPath', path.join(root, 'config.yaml'), '--browserLaunchEnabled', 'false'], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    const tail = [];
    child.stdout.on('data', chunk => tail.push(chunk.toString()));
    child.stderr.on('data', chunk => tail.push(chunk.toString()));
    const baseURL = `http://127.0.0.1:${port}`;
    try {
        await waitForVersion(baseURL);
    } catch (error) {
        throw new Error(`${error.message}; GoTavern's own output: ${tail.join('').slice(-1200)}`);
    }
    return { baseURL, port, output: () => tail.join('').slice(-2000), kill: () => child.kill() };
}

async function pinnedReads() {
    const baseURL = process.env.PROBE_BASE_URL;
    const avatarFile = `${CARD_FILE_NAME}.png`;
    const peer = await startCapturePeer({ replyTag: 'Q21_PINNED' });
    let browser;
    let gotavern = null;
    try {
        await waitForVersion(baseURL);
        // WHICH FILE IS THE CONVERSATION? Read off the DISK, not off the roster: the roster's chat name is a
        // manufactured timestamp (`characters.js:554`). Exactly one is required, and the count is recorded.
        const files = await savedChatFiles();
        report.savedChatFiles = files;
        const savedChatName = files.length === 1 ? files[0].replace(/\.jsonl$/, '') : null;
        if (!savedChatName) {
            throw new Error(`wanted exactly ONE saved chat under chats/${CARD_FILE_NAME}/, found ${JSON.stringify(files)}`);
        }
        report.savedChatName = savedChatName;

        // HEADLESS IS EXPLICIT, NOT IMPLIED. Playwright's default is headless today, but a browser window on the
        // operator's desktop is not a failure mode worth leaving to a default: the probe measures page state and
        // never needs a visible surface.
        browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
        await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
        await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
        report.pinnedPageModel = await waitForPageModel(page);
        step('pageModelLoaded', report.pinnedPageModel.ready === true, JSON.stringify(report.pinnedPageModel).slice(0, 500));
        if (!report.pinnedPageModel.ready) {
            throw new Error(`the pinned page never populated its character model: ${JSON.stringify(report.pinnedPageModel).slice(0, 400)}`);
        }
        if (!process.env.Q21_CHARACTER_NAME) process.env.Q21_CHARACTER_NAME = report.pinnedPageModel.modelNames[0] ?? null;

        report.opened = await openCharacterByName(page);
        step('opened', report.opened.opened === true, JSON.stringify(report.opened).slice(0, 600));
        if (!report.opened.opened) {
            throw new Error(`the pinned half could not open the card "${process.env.Q21_CHARACTER_NAME ?? '(none)'}": ${report.opened.reason}`);
        }
        // `pinnedOpened`: THE SERVER ANSWERS AND THE PAGE RENDERS THE CHARACTER'S CHAT. Clicking a card opens the chat
        // name the roster answered (a manufactured timestamp when the card carries no `chat` field), so what this row
        // proves is that the server lists and opens the STAGED CARD -- not yet that it read the saved conversation,
        // which the next row is for. Its `messages` count is the greeting the fresh chat got, so a page that rendered
        // nothing is a FAIL here rather than a mystery three rows later.
        // THE LANDING IS POLLED, NOT SAMPLED ONCE: measured 2026-10-29, the click's own render had not completed when
        // this read ran -- `chatId: null`, `chatLength: 1`, `messages: 0` for a character that WAS opening. A single
        // read turns a render race into a red row, and a red row here stops the whole leg before the hand-back itself is
        // judged (the run reported `unreached`, which is the right taxonomy for a probe that never got there).
        const landed = async () => page.evaluate(async () => {
            // THE ROSTER IS READ FROM THE PAGE'S OWN MODULE, not from `getContext()`: measured 2026-10-29,
            // `context.characters` is undefined and this row failed on a character that WAS open. The opener already
            // reads `script.characters` and works, so the same reader is used here (AGENTS 58: read a state through the
            // framework that reads it).
            const script = await import('./script.js');
            const chid = script.this_chid;
            return {
                character: chid === undefined || chid === null ? null : (script.characters?.[chid]?.name ?? null),
                thisChid: chid ?? null,
                chatId: script.chatId ?? null,
                chatLength: (script.chat ?? []).length,
                messages: document.querySelectorAll('#chat .mes').length,
            };
        });
        const landingWait = await pollUntil(landed, value => value.messages > 0 && typeof value.chatId === 'string' && value.chatId.length > 0, 30000);
        const landing = landingWait.value;
        report.pinnedLanding = landing;
        step('pinnedOpened',
            landing !== null && landing.messages > 0 && landing.character === (process.env.Q21_CHARACTER_NAME ?? null),
            JSON.stringify({ landing, waitedMs: landingWait.ok, wanted: process.env.Q21_CHARACTER_NAME ?? null }));
        // THE MANUFACTURED CHAT, RECORDED AS EVIDENCE FOR THE NEXT ROW. If this equals the saved chat's name, then
        // the card DOES carry a `chat` field and the saved-chat claim below is not the one being tested.
        report.pinnedAutoOpenedChatId = await page.evaluate(() => window.SillyTavern?.getContext?.()?.chatId ?? null);

        const openedSaved = await openSavedChat(page, savedChatName);
        report.pinnedOpenedSaved = openedSaved;
        step('pinnedOpenedSavedChat', openedSaved.opened === true, JSON.stringify(openedSaved).slice(0, 600));
        if (!openedSaved.opened) throw new Error(`pinned did not open the saved chat "${savedChatName}": ${JSON.stringify(openedSaved).slice(0, 400)}`);

        const readChat = async () => page.evaluate(markers => {
            const context = window.SillyTavern?.getContext?.();
            const chat = context?.chat ?? [];
            const text = chat.map(entry => String(entry?.mes ?? '')).join('\n');
            return {
                chatLength: chat.length,
                chatId: context?.chatId ?? null,
                carriesMarkers: Object.fromEntries(Object.entries(markers).map(([key, marker]) => [key, text.includes(marker)])),
                messages: document.querySelectorAll('#chat .mes').length,
            };
        }, MARKERS);
        const read = await readChat();
        report.pinnedRead = read;
        step('pinnedReadTheChat', read.carriesMarkers.first === true, JSON.stringify(read));
        step('pinnedChatIdMatches', read.chatId === savedChatName,
            `pinned context chatId=${JSON.stringify(read.chatId)} the file's own name=${JSON.stringify(savedChatName)}`);

        // THE BASELINE IS THE TREE AS PINNED LEFT IT. No quiescence wait here: the pinned server's own startup writes
        // (config.yaml key insertion, settings migration, `_webpack`/`_cache` warm-up) are exactly the runtime-state
        // class the comparison below classifies, and the tree the product wrote was already snapshotted only after
        // ITS quiescence condition above. A quiescence wait on this side would add a second moving-tree detector for
        // files whose movement the claim deliberately ignores.
        const before = await hashTree(dataRoot);
        report.treeBeforePinnedWrote = before;
        // WHAT "NO LOSS" CAN AND CANNOT MEAN HERE. Whole-tree byte identity is not the claim: the pinned server writes
        // on purpose the moment it is handed a tree -- `config.yaml` gains missing keys at boot (src/config-init.js)
        // and the frontend saves `settings.json` as it migrates on load -- so a byte-equality assertion fails on the
        // runtime's own startup writes and says nothing about the user's data. The claim is: nothing the product wrote
        // is MISSING, nothing under the DATA domains had its bytes moved, and the conversation still carries the marker.
        //
        // A RUNTIME TEMP FILE IS NOT USER DATA. Measured on this host: the product's atomic content-log write leaves
        // `default-user/.gotavern-content-log-<hash>.tmp` for a moment and renames it to `content.log`; a snapshot
        // taken in that window (which the quiescence wait above now prevents) would otherwise make a REMOVAL of the
        // product's own temp file read as data loss. Runtime-state paths are therefore classified on both the
        // MODIFIED and the REMOVED side, and any removal outside that class still fails the row.
        const runtimeState = /(^|[\\/])(settings\.json|config\.yaml)$|(^|[\\/])_webpack([\\/]|$)|(^|[\\/])_cache([\\/]|$)|(^|[\\/])backups([\\/]|$)|(^|[\\/])\.gotavern-[^\\/]+\.tmp$/;
        const dataDomain = /(^|[\\/])(chats|characters|groups|worlds|presets|themes|QuickReplies)([\\/]|$)/;
        const removed = Object.keys(report.expectedTree ?? {}).filter(file => !(file in before));
        const modified = Object.keys(report.expectedTree ?? {}).filter(file => file in before && before[file] !== report.expectedTree[file]);
        const dataModified = modified.filter(file => dataDomain.test(file));
        const removedRuntimeState = removed.filter(file => runtimeState.test(file));
        const removedUnaccounted = removed.filter(file => !runtimeState.test(file));
        report.treeLoss = { removed, removedRuntimeState, removedUnaccounted, modified, dataModified, runtimeStateModified: modified.filter(file => runtimeState.test(file)), unaccountedModified: modified.filter(file => !runtimeState.test(file) && !dataDomain.test(file)) };
        step('noDataLossOnHandBack',
            read.carriesMarkers.first === true && report.expectedTree !== undefined && removedUnaccounted.length === 0 && dataModified.length === 0,
            report.expectedTree === undefined ? 'no expected tree was supplied, so nothing can be said about loss'
                : JSON.stringify(report.treeLoss));

        // ---- (b) PINNED MUTATES: a turn of its own, then CONTINUE, both through its own UI -------------------
        await pointAtPeer(page, peer);

        // THE PAGE'S OWN STATE, READ THROUGH THE PAGE'S OWN MODULE. Every wait below is on a NAMED condition of
        // this state (or of the peer's request log / the chat file), never on elapsed time. The failure this
        // section was rewritten for was a wait whose condition could already be true before the action it was
        // waiting on -- see the `pinned-send-reply-committed-in-page` comment below.
        const readPageState = () => page.evaluate(async () => {
            const script = await import('./script.js');
            const context = window.SillyTavern?.getContext?.() ?? null;
            const chat = script.chat ?? [];
            const last = chat[chat.length - 1] ?? null;
            return {
                chatLength: chat.length,
                chatId: context?.chatId ?? script.chatId ?? null,
                // THE INPUTS PINNED'S OWN CONTINUE GUARD READS (script.js:11648-11661), recorded rather than
                // reproduced: a press the guard refuses is a fact about the state the drive reached.
                isSendPress: script.is_send_press === true,
                streamingProcessor: Boolean(script.streamingProcessor),
                thisEditMesId: script.this_edit_mes_id ?? null,
                swipeState: script.swipeState ?? null,
                lastIsUser: last?.is_user === true,
                lastIsSystem: last?.is_system === true,
                lastText: String(last?.mes ?? ''),
                lastBytes: String(last?.mes ?? '').length,
                domMessages: document.querySelectorAll('#chat .mes').length,
            };
        });
        report.pinnedPageBeforeSend = await readPageState();

        const sent = await page.evaluate(async ({ marker, startLength }) => {
            const script = await import('./script.js');
            const textarea = document.querySelector('#send_textarea');
            const button = document.querySelector('#send_but');
            if (!textarea || !button) return { clicked: false, reason: 'no #send_textarea or #send_but' };
            textarea.value = marker;
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            button.click();
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline) {
                const chat = script.chat ?? [];
                if (chat.length > startLength && chat.some(entry => String(entry?.mes ?? '').includes(marker))) {
                    return { clicked: true, chatLength: chat.length };
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            return { clicked: true, timedOut: true, chatLength: (script.chat ?? []).length };
        }, { marker: MARKERS.second, startLength: read.chatLength });
        report.pinnedSend = sent;

        // 1. THE SEND'S REQUEST LEFT THE PAGE. The peer's record is the observation: the page cannot prove a
        //    request left it, and nothing in the page's DOM distinguishes "the provider was asked" from
        //    "the page is waiting".
        const sendRequestSeen = await waitForCondition('pinned-send-request-reached-peer', {
            waitedFor: `the capture peer records a chat-completions request carrying "${MARKERS.second}" (a request left the pinned frontend)`,
            deadlineMs: 60000,
            produce: async () => peer.requests.filter(entry => entry.carriesMarkers.second === true),
            accept: list => list.length > 0,
            snapshot: () => peer.requests.map(entry => ({ stream: entry.stream, markers: entry.carriesMarkers, lastRole: entry.lastRole, answersWith: entry.answersWith })),
        });
        const sendRequest = sendRequestSeen.value[sendRequestSeen.value.length - 1] ?? null;
        const sendReply = sendRequest?.answersWith ?? null;
        report.pinnedSendRequest = { ok: sendRequestSeen.ok, stream: sendRequest?.stream ?? null, messageCount: sendRequest?.messageCount ?? null, answersWith: sendReply, condition: sendRequestSeen.condition };
        if (!sendRequestSeen.ok) {
            throw new Error(`pinned-send-request-reached-peer: waited for ${sendRequestSeen.condition.waitedFor}; observed ${JSON.stringify(sendRequestSeen.condition.observed).slice(0, 900)}`);
        }

        // 2. THE PAGE COMMITTED THE SEND'S REPLY. THIS IS THE CONDITION WHOSE ABSENCE WAS THE FLAKE.
        //
        //    THE OLD WAIT ASKED THE FILE FOR `mes === sendReply`, and the two peers answered the same strings
        //    (`Q21_REPLY_1`, ...): GoTavern's leg had already persisted `Q21_REPLY_1` into the tree it handed
        //    over, so the pinned half's "did the send's reply land?" wait was satisfied by the HANDED-BACK reply
        //    before the send's own reply existed. `pinnedWrote` then went green while the send was STILL
        //    STREAMING; the CONTINUE press below was swallowed by pinned's own `is_send_press == false` guard
        //    (script.js:11658); the send's reply landing afterwards moved the chat and the probe misread that as
        //    a continuation. That is run 41171855911's `pinnedContinued` red -- `continueRequests: 0`,
        //    `lengthGrew: true`, `lastMessageGrew: false`.
        //
        //    Two things make it impossible now: (a) the peer's replies carry the leg's phase
        //    (`Q21_PINNED_REPLY_n`, see startCapturePeer), so no stale message can carry this leg's reply text;
        //    and (b) the wait is on the PAGE's own model holding the reply as its last message AND the page being
        //    idle -- the exact state pinned's continue guard requires before it will call Generate.
        const pageCommittedSend = await waitForCondition('pinned-send-reply-committed-in-page', {
            waitedFor: `the page's own chat model holds the send's reply "${sendReply}" as the last message and is idle (is_send_press false, no streaming processor)`,
            deadlineMs: 60000,
            produce: readPageState,
            accept: state => sendReply !== null
                && state.isSendPress === false
                && state.streamingProcessor === false
                && state.lastIsUser === false
                && state.lastText === sendReply,
            snapshot: state => ({
                chatLength: state.chatLength, lastIsUser: state.lastIsUser, lastText: state.lastText.slice(0, 120),
                isSendPress: state.isSendPress, streamingProcessor: state.streamingProcessor, domMessages: state.domMessages,
            }),
        });
        report.pinnedSendCommitted = { ok: pageCommittedSend.ok, condition: pageCommittedSend.condition };
        if (!pageCommittedSend.ok) {
            throw new Error(`pinned-send-reply-committed-in-page: waited for ${pageCommittedSend.condition.waitedFor}; observed ${JSON.stringify(pageCommittedSend.condition.observed).slice(0, 900)}`);
        }

        // 3. THE REPLY IS PERSISTED, POSITIONALLY: the file must hold the user turn and then an ASSISTANT turn
        //    carrying this reply after it. The phase-tagged reply text alone makes this unambiguous; the position
        //    keeps "a stale message with the same text" impossible even if a future fixture re-used a tag.
        const pinnedWrote = await waitForCondition('pinned-send-reply-persisted', {
            waitedFor: `the chat file holds the user turn "${MARKERS.second}" followed by an assistant turn whose text is "${sendReply}"`,
            deadlineMs: 60000,
            produce: () => readChatFile(savedChatName),
            accept: chat => {
                if (!Array.isArray(chat)) return false;
                const userIndex = chat.findIndex(entry => String(entry?.mes ?? '').includes(MARKERS.second));
                return userIndex >= 0 && chat.slice(userIndex + 1).some(entry => entry?.is_user === false && String(entry?.mes ?? '') === sendReply);
            },
            snapshot: chat => ({
                fileMessages: Array.isArray(chat) ? chat.length : null,
                tail: Array.isArray(chat) ? chat.slice(-3).map(entry => ({ role: entry?.is_user ? 'user' : entry?.is_system ? 'system' : 'assistant', bytes: String(entry?.mes ?? '').length, tail: String(entry?.mes ?? '').slice(-40) })) : null,
            }),
        });
        report.pinnedSendReply = { sendReply, persisted: pinnedWrote.ok, condition: pinnedWrote.condition };
        if (!pinnedWrote.ok) {
            throw new Error(`pinned-send-reply-persisted: waited for ${pinnedWrote.condition.waitedFor}; observed ${JSON.stringify(pinnedWrote.condition.observed).slice(0, 900)}`);
        }
        step('pinnedWrote',
            sent.clicked === true && sent.timedOut !== true && pageCommittedSend.ok === true && pinnedWrote.ok === true,
            {
                send: sent,
                persisted: pinnedWrote.ok,
                sendReply,
                replyCommittedInPage: pageCommittedSend.ok,
                replyPersisted: pinnedWrote.ok,
                fileMessages: Array.isArray(pinnedWrote.value) ? pinnedWrote.value.length : null,
                conditions: { request: sendRequestSeen.condition.name, committedInPage: pageCommittedSend.condition.name, persisted: pinnedWrote.condition.name },
                requests: peer.requests.map(entry => ({ stream: entry.stream, markers: entry.carriesMarkers, lastRole: entry.lastRole, answersWith: entry.answersWith })),
            });

        // 4. THE CONTINUE PRESS LANDS ONLY ON A PAGE THE FRONTEND ITSELF CALLS CONTINUABLE. This is the
        //    PRECONDITION check AGENTS rule 10 asks for: pinned's `#option_continue` handler refuses (SILENTLY --
        //    no toast, no error) when `is_send_press` is true, when the message being continued is being edited, or
        //    during a swipe edit (`public/script.js:11648-11661`). A drive that pressed while the page was busy
        //    would be driving a state a user cannot reach, and the resulting "nothing happened" is a probe defect,
        //    not a product finding.
        const guardState = await waitForCondition('pinned-continue-allowed-by-frontend-guard', {
            waitedFor: 'the page is idle and continuable: is_send_press === false, no streaming processor, no message being edited, no swipe edit',
            deadlineMs: 60000,
            produce: readPageState,
            accept: state => state.isSendPress === false && state.streamingProcessor === false && state.thisEditMesId === null,
            snapshot: state => ({ chatLength: state.chatLength, isSendPress: state.isSendPress, streamingProcessor: state.streamingProcessor, thisEditMesId: state.thisEditMesId, swipeState: state.swipeState, lastBytes: state.lastBytes }),
        });
        report.pinnedContinueGuard = guardState.condition;
        if (!guardState.ok) {
            throw new Error(`pinned-continue-allowed-by-frontend-guard: waited for ${guardState.condition.waitedFor}; observed ${JSON.stringify(guardState.condition.observed).slice(0, 900)}`);
        }
        report.requestsBeforeContinue = peer.requests.length;
        const continuePreState = await readPageState();
        report.pinnedContinueBefore = continuePreState;
        const continueResult = await page.evaluate(async () => {
            const script = await import('./script.js');
            const chatBefore = script.chat ?? [];
            const before = {
                chatLength: chatBefore.length,
                lastText: String(chatBefore[chatBefore.length - 1]?.mes ?? ''),
                lastIsUser: chatBefore[chatBefore.length - 1]?.is_user === true,
                isSendPress: script.is_send_press === true,
                streamingProcessor: Boolean(script.streamingProcessor),
                thisEditMesId: script.this_edit_mes_id ?? null,
                swipeState: script.swipeState ?? null,
            };
            const button = document.querySelector('#option_continue');
            if (!button) return { clicked: false, accepted: false, before, settled: null, reason: 'no #option_continue in the page' };
            button.click();
            // THE ACCEPTANCE IS READ SYNCHRONOUSLY, IN THE SAME TASK AS THE CLICK. Pinned's handler sets
            // `is_send_press = true` BEFORE calling Generate (script.js:11658-11660), so a press its guard REFUSED
            // is observable here -- it must not be inferred later from a chat change, because a chat change after
            // the press can belong to whatever ELSE was running. This is the check that turns the old silent
            // swallow into a named refusal instead of a misleading `continueRequests: 0`.
            const accepted = script.is_send_press === true || Boolean(script.streamingProcessor);
            const deadline = Date.now() + 60000;
            let settled = null;
            while (Date.now() < deadline) {
                const chat = script.chat ?? [];
                const last = chat[chat.length - 1] ?? null;
                settled = {
                    chatLength: chat.length,
                    lastText: String(last?.mes ?? ''),
                    lastIsUser: last?.is_user === true,
                    isSendPress: script.is_send_press === true,
                    streamingProcessor: Boolean(script.streamingProcessor),
                    domLastText: String(document.querySelector(`#chat .mes[mesid="${chat.length - 1}"] .mes_text`)?.textContent ?? '').slice(0, 200),
                };
                const changed = settled.chatLength !== before.chatLength || settled.lastText !== before.lastText;
                if (accepted !== true) break;
                if (settled.isSendPress === false && settled.streamingProcessor === false && changed) break;
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            return {
                clicked: true,
                accepted,
                before,
                settled,
                lengthGrew: settled !== null && settled.chatLength > before.chatLength,
                lastMessageGrew: settled !== null && settled.lastText !== before.lastText,
                timedOut: settled === null ? true : (settled.isSendPress === true || settled.streamingProcessor === true),
            };
        });
        report.pinnedContinue = continueResult;
        if (continueResult.clicked !== true) {
            throw new Error(`continue-control-missing: ${continueResult.reason}`);
        }
        if (continueResult.accepted !== true) {
            // THE EXACT FAILURE THE OLD PROBE COULD NOT NAME: the frontend refused the press. Throw with the state
            // its guard read, so "the control was pressed and nothing was asked" is never read as a product defect.
            throw new Error(`continue-press-not-accepted: the pinned frontend DID NOT start a generation for the continue press (its own guard refused it); pre-click state=${JSON.stringify(continueResult.before)}; observed=${JSON.stringify(continueResult.settled)}`);
        }

        // 5. THE CONTINUE'S REQUEST REACHED THE PROVIDER. Everything recorded before the press belongs to the
        //    send; a request that appears after it can only be the continue, because nothing else runs in that
        //    window. This is the observation `continueRequests: 0` was about.
        const continueRequestSeen = await waitForCondition('continue-request-reached-provider', {
            waitedFor: 'the capture peer records at least one NEW chat-completions request after the continue press',
            deadlineMs: 60000,
            produce: async () => ({ requests: peer.requests.slice(report.requestsBeforeContinue ?? 0), page: await readPageState() }),
            accept: value => value.requests.length > 0,
            snapshot: value => ({
                newRequests: value.requests.map(entry => ({ markers: entry.carriesMarkers, messageCount: entry.messageCount, lastRole: entry.lastRole, answersWith: entry.answersWith, stream: entry.stream })),
                page: { chatLength: value.page.chatLength, lastBytes: value.page.lastBytes, isSendPress: value.page.isSendPress, streamingProcessor: value.page.streamingProcessor, domMessages: value.page.domMessages },
            }),
        });
        const continueRequests = continueRequestSeen.value.requests;
        report.continueRequestsObserved = continueRequests.length;
        const continueRequest = continueRequests[continueRequests.length - 1] ?? null;
        if (!continueRequestSeen.ok) {
            // A page that ACCEPTED the press and then issued no request is the harness-faithfulness alarm the
            // differential doctrine names: it is recorded, not guessed at.
            throw new Error(`continue-request-reached-provider: waited for ${continueRequestSeen.condition.waitedFor}; the press WAS accepted by the page (is_send_press became true) yet no request left it; observed ${JSON.stringify(continueRequestSeen.condition.observed).slice(0, 1200)}`);
        }

        // 6. THE PAGE FINISHED THE CONTINUATION, and 7. the answer it produced was persisted. Each is a separate
        //    observation and neither is inferred from the request having arrived.
        const pageSettledContinue = await waitForCondition('continue-completed-in-page', {
            waitedFor: `the page is idle again and the continuation moved the chat: the last message's text grew/changed or the chat gained a message (pre-press: ${JSON.stringify({ chatLength: continuePreState.chatLength, lastBytes: continuePreState.lastBytes })})`,
            deadlineMs: 60000,
            produce: readPageState,
            accept: state => state.isSendPress === false && state.streamingProcessor === false
                && (state.chatLength !== continuePreState.chatLength || state.lastText !== continuePreState.lastText),
            snapshot: state => ({ chatLength: state.chatLength, lastBytes: state.lastBytes, lastText: state.lastText.slice(0, 160), isSendPress: state.isSendPress, streamingProcessor: state.streamingProcessor, domMessages: state.domMessages }),
        });
        report.pinnedContinueSettled = pageSettledContinue.condition;
        const continueReply = continueRequest?.answersWith ?? null;
        const continuedInFile = await waitForCondition('continue-answer-persisted', {
            waitedFor: `a chat file holds the continue's answer "${continueReply}"`,
            deadlineMs: 60000,
            produce: () => readChatFile(savedChatName),
            // THE ANSWER MAY BE A SUFFIX, NOT A WHOLE MESSAGE. Pinned's continuation appends to the LAST
            // message in place (`public/script.js:6719-6737`, measured: "Q21_PINNED_REPLY_1
            // Q21_PINNED_REPLY_2" in one entry), so equality would fail for the exact behaviour the row is
            // meant to prove. The reply text is phase- and ordinal-tagged (`Q21_PINNED_REPLY_2`), so
            // `.includes()` cannot be satisfied by any other request of this leg.
            accept: chat => continueReply !== null && Array.isArray(chat) && chat.some(entry => String(entry?.mes ?? '').includes(continueReply)),
            snapshot: chat => ({
                fileMessages: Array.isArray(chat) ? chat.length : null,
                tail: Array.isArray(chat) ? chat.slice(-4).map(entry => ({ role: entry?.is_user ? 'user' : entry?.is_system ? 'system' : 'assistant', bytes: String(entry?.mes ?? '').length, tail: String(entry?.mes ?? '').slice(-40) })) : null,
            }),
        });
        // THE FILE'S OWN TAIL, RECORDED ONLY WHEN THE WAIT FAILED. It answers the question the row cannot answer
        // from `answerPersisted:false` alone: did pinned write NOTHING, write the continuation without its answer,
        // or write the answer under a name the probe is not polling?
        const fileTail = continuedInFile.ok ? null : continuedInFile.condition.observed;
        // THE HANDED-BACK REPLY IS THE SEND'S ANSWER -- the turn pinned produced FROM the GoTavern context, which is
        // what GoTavern must be able to read back. The continue's own answer is recorded in its row.
        const replyText = sendReply;
        step('pinnedContinued',
            continueRequest !== null
                && continueRequest.carriesMarkers.first === true
                && continueRequest.carriesMarkers.second === true
                && pageSettledContinue.ok === true
                && continuedInFile.ok === true,
            {
                click: continueResult,
                continueRequests: report.continueRequestsObserved,
                carriedMarkers: continueRequest?.carriesMarkers ?? null,
                messageCount: continueRequest?.messageCount ?? null,
                answerPersisted: continuedInFile.ok,
                answersWith: continueReply,
                chatFileTail: fileTail,
                conditions: {
                    guard: guardState.condition.name,
                    request: continueRequestSeen.condition.name,
                    settled: pageSettledContinue.condition.name,
                    persisted: continuedInFile.condition.name,
                    failed: report.conditions.filter(entry => entry.ok !== true).map(entry => entry.name),
                },
                pageBefore: continuePreState,
                pageAfter: pageSettledContinue.value ?? null,
                allRequests: peer.requests.map(entry => ({ type: entry.generationType, markers: entry.carriesMarkers, answersWith: entry.answersWith })),
            });

        // ---- (b) PINNED BRANCHES: its own branch action, which writes a SECOND chat file and records the name in
        //      the parent's last message (`public/scripts/bookmarks.js:187-245`; the list is persisted on the next
        //      save, `:236-243` + `saveChatConditional`).
        const branch = await page.evaluate(async () => {
            const bookmarks = await import('./scripts/bookmarks.js');
            const script = await import('./script.js');
            const context = window.SillyTavern?.getContext?.();
            const last = (context?.chat ?? []).length - 1;
            const name = await bookmarks.createBranch(last);
            await script.saveChatConditional();
            return { name: name ?? null, last };
        });
        report.pinnedBranch = branch;
        const branchPersisted = branch.name
            ? await pollUntil(() => readChatFile(branch.name), chat => Array.isArray(chat) && chat.length > 1, 30000)
            : { ok: false, value: null };
        const parentAfterBranch = await readChatFile(savedChatName);
        const parentLast = Array.isArray(parentAfterBranch) ? parentAfterBranch[parentAfterBranch.length - 1] : null;
        const branchNamesOnDisk = Array.isArray(parentLast?.extra?.branches) ? parentLast.extra.branches : null;
        const branchMeta = Array.isArray(branchPersisted.value) ? (branchPersisted.value[0]?.chat_metadata ?? null) : null;
        step('pinnedBranched',
            typeof branch.name === 'string' && branchPersisted.ok === true
                && branchNamesOnDisk !== null && branchNamesOnDisk.includes(branch.name)
                && branchMeta !== null,
            {
                branchName: branch.name,
                branchMessages: Array.isArray(branchPersisted.value) ? branchPersisted.value.length : null,
                branchMetadata: branchMeta === null ? null : { main_chat: branchMeta.main_chat ?? null, hasIntegrity: typeof branchMeta.integrity === 'string' },
                parentBranches: branchNamesOnDisk,
            });

        // ---- the API state pinned leaves behind, and the tree it left behind -------------------------------
        const pinnedState = {
            roster: await listCharacters(baseURL),
            chats: await characterChats(baseURL, avatarFile),
            card: await postForJSON(baseURL, '/api/characters/get', { avatar_url: avatarFile }),
        };
        report.pinnedState = {
            rosterNames: pinnedState.roster.names,
            chatFiles: pinnedState.chats.ok ? pinnedState.chats.files : pinnedState.chats.reason,
            card: cardProjection(pinnedState.card.ok ? pinnedState.card.body : null),
        };
        const treeAfterPinned = await hashTree(dataRoot);
        report.treeAfterPinnedWrote = treeAfterPinned;
        report.treeDeltaFromPinned = {
            filesAdded: Object.keys(treeAfterPinned).filter(file => !(file in (report.expectedTree ?? {}))),
            filesRemoved: Object.keys(report.expectedTree ?? {}).filter(file => !(file in treeAfterPinned)),
        };

        // ---- (a) GOTAVERN READS WHAT PINNED WROTE ---------------------------------------------------------
        gotavern = await bootGotavernOver(dataRoot);
        const goRoster = await listCharacters(gotavern.baseURL);
        const goChats = await characterChats(gotavern.baseURL, avatarFile);
        const goCard = await postForJSON(gotavern.baseURL, '/api/characters/get', { avatar_url: avatarFile });
        const goChat = await postForJSON(gotavern.baseURL, '/api/chats/get', { ch_name: process.env.Q21_CHARACTER_NAME, file_name: savedChatName, avatar_url: avatarFile });
        const goBranch = branch.name
            ? await postForJSON(gotavern.baseURL, '/api/chats/get', { ch_name: process.env.Q21_CHARACTER_NAME, file_name: branch.name, avatar_url: avatarFile })
            : null;
        const goChatArray = Array.isArray(goChat.body) ? goChat.body : [];
        const goChatLast = goChatArray.length > 0 ? goChatArray[goChatArray.length - 1] : null;
        const goBranchArray = Array.isArray(goBranch?.body) ? goBranch.body : [];
        const goBranchText = chatText(goBranchArray);
        report.gotavernState = {
            rosterNames: goRoster.names,
            chatFiles: goChats.ok ? goChats.files : goChats.reason,
            card: cardProjection(goCard.ok ? goCard.body : null),
            chatLength: goChatArray.length,
            chatCarries: {
                first: chatText(goChatArray).includes(MARKERS.first),
                second: chatText(goChatArray).includes(MARKERS.second),
                pinnedReply: replyText !== null && chatText(goChatArray).includes(replyText),
                pinnedReplyExpected: replyText,
            },
            branchLength: goBranchArray.length,
            branchCarriesSecond: goBranchText.includes(MARKERS.second),
            branchNamesInParent: Array.isArray(goChatLast?.extra?.branches) ? goChatLast.extra.branches : null,
        };
        // THE ROSTER IS A SET, NOT A SEQUENCE. Pinned builds it from `fs.readdirSync(characters)`
        // (`src/endpoints/characters.js:1468-1470`), whose order Node does not define, so two servers reading ONE
        // directory may list the same characters in different orders and neither is wrong. The comparison is on SORTED
        // names; both raw orders are recorded, so a difference in MEMBERSHIP cannot hide behind the sort.
        const sortNames = names => [...names].sort();
        step('rosterAgrees',
            JSON.stringify(sortNames(goRoster.names)) === JSON.stringify(sortNames(pinnedState.roster.names)),
            { gotavern: goRoster.names, pinned: pinnedState.roster.names, orderNote: 'readdir order is not a contract (characters.js:1468)' });
        step('cardMetadataAgrees',
            JSON.stringify(report.gotavernState.card) === JSON.stringify(report.pinnedState.card),
            { gotavern: report.gotavernState.card, pinned: report.pinnedState.card });
        step('chatAssociationAgrees',
            goChats.ok === true && pinnedState.chats.ok === true
                && JSON.stringify(goChats.files) === JSON.stringify(pinnedState.chats.files),
            { gotavern: report.gotavernState.chatFiles, pinned: report.pinnedState.chatFiles });
        step('gotavernReadsPinned',
            goChatArray.length > 1
                && report.gotavernState.chatCarries.first === true
                && report.gotavernState.chatCarries.second === true
                && report.gotavernState.chatCarries.pinnedReply === true
                && goBranchArray.length > 1
                && report.gotavernState.branchCarriesSecond === true
                && Array.isArray(report.gotavernState.branchNamesInParent)
                && report.gotavernState.branchNamesInParent.includes(branch.name),
            JSON.stringify(report.gotavernState).slice(0, 900));

        // ---- (a) GOTAVERN MUTATES: a turn appended through the product's OWN save route --------------------
        // The message shape is the one the chat already carries, with the fields a frontend-written turn has; the
        // point of this hop is the PERSISTENCE path, not the generation path (Q20 owns generation).
        const header = goChatArray[0] ?? {};
        const appended = {
            name: header.user_name ?? 'Probe User',
            is_user: true,
            is_system: false,
            send_date: '2026-10-29@00h00m00s000ms',
            mes: MARKERS.third,
            extra: {},
        };
        const goSave = await postForJSON(gotavern.baseURL, '/api/chats/save', {
            ch_name: process.env.Q21_CHARACTER_NAME,
            file_name: savedChatName,
            avatar_url: avatarFile,
            chat: [...goChatArray, appended],
        });
        const goSaved = await pollUntil(() => readChatFile(savedChatName),
            chat => Array.isArray(chat) && chatText(chat).includes(MARKERS.third), 30000);
        const parentAfterGo = await readChatFile(savedChatName);
        const parentLastAfterGo = Array.isArray(parentAfterGo) ? parentAfterGo[parentAfterGo.length - 1] : null;
        step('gotavernMutated',
            goSave.ok === true && goSaved.ok === true,
            { save: goSave.ok ? 'ok' : goSave.reason, persisted: goSaved.ok });
        step('branchStateSurvivesGoWrite',
            Array.isArray(parentAfterGo)
                && (parentAfterGo[0]?.chat_metadata?.main_chat === undefined || true)
                && parentAfterGo.some(entry => Array.isArray(entry?.extra?.branches) && entry.extra.branches.includes(branch.name))
                && Array.isArray(branchPersisted.value) && branchPersisted.value.length > 1,
            {
                parentBranchesAfterGo: parentAfterGo === null ? null
                    : parentAfterGo.flatMap(entry => (Array.isArray(entry?.extra?.branches) ? entry.extra.branches : [])),
                branchStillOnDisk: Array.isArray(branchPersisted.value) ? branchPersisted.value.length : null,
                lastEntry: parentLastAfterGo === null ? null : { isUser: parentLastAfterGo.is_user ?? null, carriesThird: String(parentLastAfterGo.mes ?? '').includes(MARKERS.third) },
            });
        report.gotavernChatAfterSave = Array.isArray(parentAfterGo) ? parentAfterGo.length : null;

        // ---- (a) PINNED READS THE TURN GOTAVERN JUST WROTE -------------------------------------------------
        gotavern.kill();
        gotavern = null;
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
        report.pinnedReloadedModel = await waitForPageModel(page);
        if (!report.pinnedReloadedModel.ready) {
            throw new Error(`the pinned page did not repopulate its character model after the reload: ${JSON.stringify(report.pinnedReloadedModel).slice(0, 400)}`);
        }
        const reopened = await openCharacterByName(page);
        const reopenedSaved = reopened.opened ? await openSavedChat(page, savedChatName) : { opened: false, reason: 'the character did not open' };
        const answered = await page.evaluate(async markers => {
            const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
            const script = await import('./script.js');
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                const chat = script.chat ?? [];
                const text = chat.map(entry => String(entry?.mes ?? '')).join('\n');
                if (text.includes(markers.third)) {
                    return {
                        carriesThird: true, chatLength: chat.length, chatId: script.chatId ?? null,
                        carriesFirst: text.includes(markers.first), carriesSecond: text.includes(markers.second),
                        branches: chat.flatMap(entry => (Array.isArray(entry?.extra?.branches) ? entry.extra.branches : [])),
                        messages: document.querySelectorAll('#chat .mes').length,
                    };
                }
                await sleep(250);
            }
            const chat = script.chat ?? [];
            const text = chat.map(entry => String(entry?.mes ?? '')).join('\n');
            return {
                carriesThird: false, chatLength: chat.length, chatId: script.chatId ?? null,
                carriesFirst: text.includes(markers.first),
                messages: document.querySelectorAll('#chat .mes').length,
            };
        }, MARKERS);
        report.pinnedFinalRead = { reopened, reopenedSaved, answered };
        step('pinnedReadGotavernsTurn',
            reopenedSaved.opened === true && answered.carriesThird === true && answered.carriesFirst === true && answered.messages > 0,
            JSON.stringify({ reopenedSaved, answered }).slice(0, 800));
    } finally {
        if (gotavern) gotavern.kill();
        if (browser) await browser.close();
        await peer.close();
    }
}

// ---------------------------------------------------------------------------------------------------------------
// THE JUDGE, AS A STEP THAT MUST EXECUTE AND MUST ACCOUNT FOR ITSELF.
//
// The workflow's own judge (`.github/workflows/browser-differential.yml`, "Judge the hand-back") reads
// `report.failure` and prints the step list. It CANNOT tell a leg that judged seventeen rows from a leg that exited 0
// having judged none: an empty `steps` array with no `failure` passes it. That is the failure mode this project keeps
// hitting, so the accounting is done HERE and written into the report:
//
//   * every REQUIRED row for the phase must be PRESENT -- a missing row is `unreached`, which is a different verdict
//     from `mismatch`, because "the probe never got there" and "the two runtimes disagreed" need different fixes;
//   * every present row must be green;
//   * the COUNTS must be non-zero: a hand-back leg whose chat count, roster count or marker count is zero has not
//     observed the thing it claims, whatever its steps say.
const REQUIRED_ROWS = {
    gotavern: ['dataRootWasEmpty', 'characterStaged', 'pageModelLoaded', 'opened', 'gotavernWrote'],
    pinned: [
        'pageModelLoaded', 'opened', 'pinnedOpened', 'pinnedOpenedSavedChat', 'pinnedReadTheChat', 'pinnedChatIdMatches',
        'noDataLossOnHandBack', 'pinnedWrote', 'pinnedContinued', 'pinnedBranched',
        'rosterAgrees', 'cardMetadataAgrees', 'chatAssociationAgrees', 'gotavernReadsPinned',
        'gotavernMutated', 'branchStateSurvivesGoWrite', 'pinnedReadGotavernsTurn',
    ],
};

function judgeHandback(state) {
    const required = REQUIRED_ROWS[state.phase] ?? [];
    const byName = new Map(state.steps.map(entry => [entry.name, entry]));
    const missing = required.filter(name => !byName.has(name));
    const failed = state.steps.filter(entry => !entry.ok).map(entry => entry.name);
    const answered = state.pinnedFinalRead?.answered ?? null;
    const counts = state.phase === 'gotavern'
        ? {
            steps: state.steps.length,
            ok: state.steps.filter(entry => entry.ok).length,
            required: required.length,
            chatFilesUnderCard: (state.matchingChatFiles ?? []).length,
            treeFilesWritten: Object.keys(state.writtenTree ?? {}).length,
            cardChunks: (state.stagedCard?.chunks ?? []).length,
            cardChunkNames: (state.stagedCard?.chunks ?? []).map(entry => `${entry.keyword}:${entry.dataName}`),
        }
        : {
            steps: state.steps.length,
            ok: state.steps.filter(entry => entry.ok).length,
            required: required.length,
            savedChats: (state.savedChatFiles ?? []).length,
            rosterRows: Array.isArray(state.gotavernState?.rosterNames) ? state.gotavernState.rosterNames.length : 0,
            chatFilesAssociated: Array.isArray(state.gotavernState?.chatFiles) ? state.gotavernState.chatFiles.length : 0,
            markersInFinalChat: answered === null
                ? 0
                : [answered.carriesFirst, answered.carriesSecond, answered.carriesThird].filter(value => value === true).length,
            continueRequests: state.continueRequestsObserved ?? 0,
            treeFilesAfterPinned: Object.keys(state.treeAfterPinnedWrote ?? {}).length,
            branchChats: Array.isArray(state.gotavernState?.branchNamesInParent) ? state.gotavernState.branchNamesInParent.length : 0,
        };
    const nonZero = state.phase === 'gotavern'
        ? counts.chatFilesUnderCard > 0 && counts.treeFilesWritten > 0 && counts.cardChunks >= 2
        : counts.savedChats > 0 && counts.rosterRows > 0 && counts.chatFilesAssociated > 0
            && counts.markersInFinalChat >= 3 && counts.continueRequests >= 1;
    // A FAILED WAIT IS A NAMED CONDITION, NOT ONLY A RED ROW. `failed` says WHICH row; `failedConditions` says
    // WHICH wait did not hold and WHAT it observed, which is the difference between "pinnedContinued is red" and
    // "the page never committed the send's reply; it was still streaming with lastText='…'". A row that failed
    // without a failed condition is still red -- the verdict does not depend on this list, it only explains it.
    const failedConditions = (state.conditions ?? []).filter(entry => entry.ok !== true).map(entry => ({
        name: entry.name, waitedFor: entry.waitedFor, elapsedMs: entry.elapsedMs, observed: entry.observed,
    }));
    const verdict = missing.length > 0 ? 'unreached' : (failed.length > 0 || nonZero === false ? 'mismatch' : 'match');
    return { executed: true, phase: state.phase, verdict, required: required.length, missing, failed, failedConditions, countsAreNonZero: nonZero, counts };
}

try {
    if (phase === 'gotavern') {
        await gotavernWrites();
    } else {
        report.expectedTree = process.env.Q21_EXPECTED_TREE ? JSON.parse(await fs.readFile(process.env.Q21_EXPECTED_TREE, 'utf8')) : undefined;
        await pinnedReads();
    }
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    // THE JUDGE RUNS IN `finally` SO THAT A LEG WHICH THREW STILL ACCOUNTS FOR ITSELF. A report with
    // `judge.verdict = 'unreached'` is a diagnosis; a report with no judge block at all is a probe that exited before
    // reaching the judge, which is the one outcome this file must make impossible to mistake for success.
    report.judge = judgeHandback(report);
    if (report.judge.verdict !== 'match') {
        const namedConditions = (report.judge.failedConditions ?? []).map(entry => `${entry.name} (waited for ${entry.waitedFor}; observed ${JSON.stringify(entry.observed).slice(0, 600)})`);
        report.failure = report.failure ?? `hand-back judge ${report.judge.verdict}: failed=[${report.judge.failed.join(', ')}] missing=[${report.judge.missing.join(', ')}] counts=${JSON.stringify(report.judge.counts)}${namedConditions.length > 0 ? `; failed conditions: ${namedConditions.join(' | ')}` : ''}`;
    }
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${phase} leg: ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`${phase} conditions: ${report.conditions.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`${phase} judge: ${report.judge.verdict} -- ${report.judge.counts.ok}/${report.judge.counts.steps} step(s) green, ${report.judge.required} required row(s), ${report.judge.missing.length} missing, counts non-zero=${report.judge.countsAreNonZero}`);
    console.log(`${phase} judge counts: ${JSON.stringify(report.judge.counts)}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;
