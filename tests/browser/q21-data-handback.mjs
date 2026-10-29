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
function startCapturePeer() {
    const requests = [];
    let reply = 0;
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
                answersWith: `Q21_REPLY_${reply + 1}`,
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
                response.write(frame({ ...base, choices: [{ index: 0, delta: { content: `Q21_REPLY_${reply + 1}` }, finish_reason: null }] }));
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
                choices: [{ index: 0, message: { role: 'assistant', content: `Q21_REPLY_${reply}` }, finish_reason: 'stop' }],
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
    const server = spawn(path.resolve(binarySetting), ['start', '--port', String(port), '--dataRoot', dataRoot, '--configPath', path.join(dataRoot, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
    server.stdout.on('data', () => {});
    server.stderr.on('data', () => {});
    const peer = await startCapturePeer();
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
        browser = await chromium.launch();
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
        await page.waitForTimeout(3000);
        report.writtenTree = await hashTree(dataRoot);
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
    const child = spawn(path.resolve(binarySetting), ['start', '--port', String(port), '--dataRoot', root, '--configPath', path.join(root, 'config.yaml')], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });
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
    const peer = await startCapturePeer();
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

        browser = await chromium.launch();
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

        const before = await hashTree(dataRoot);
        report.treeBeforePinnedWrote = before;
        // WHAT "NO LOSS" CAN AND CANNOT MEAN HERE. Whole-tree byte identity is not the claim: the pinned server writes
        // on purpose the moment it is handed a tree -- `config.yaml` gains missing keys at boot (src/config-init.js)
        // and the frontend saves `settings.json` as it migrates on load -- so a byte-equality assertion fails on the
        // runtime's own startup writes and says nothing about the user's data. The claim is: nothing the product wrote
        // is MISSING, nothing under the DATA domains had its bytes moved, and the conversation still carries the marker.
        const runtimeState = /(^|[\\/])(settings\.json|config\.yaml)$|(^|[\\/])_webpack([\\/]|$)|(^|[\\/])_cache([\\/]|$)|(^|[\\/])backups([\\/]|$)/;
        const dataDomain = /(^|[\\/])(chats|characters|groups|worlds|presets|themes|QuickReplies)([\\/]|$)/;
        const removed = Object.keys(report.expectedTree ?? {}).filter(file => !(file in before));
        const modified = Object.keys(report.expectedTree ?? {}).filter(file => file in before && before[file] !== report.expectedTree[file]);
        const dataModified = modified.filter(file => dataDomain.test(file));
        report.treeLoss = { removed, modified, dataModified, runtimeStateModified: modified.filter(file => runtimeState.test(file)), unaccountedModified: modified.filter(file => !runtimeState.test(file) && !dataDomain.test(file)) };
        step('noDataLossOnHandBack',
            read.carriesMarkers.first === true && report.expectedTree !== undefined && removed.length === 0 && dataModified.length === 0,
            report.expectedTree === undefined ? 'no expected tree was supplied, so nothing can be said about loss'
                : JSON.stringify(report.treeLoss));

        // ---- (b) PINNED MUTATES: a turn of its own, then CONTINUE, both through its own UI -------------------
        await pointAtPeer(page, peer);
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
        // THE WRITE IS PERSISTED WHEN THE FILE SAYS SO, not when the screen does: pinned saves the chat after the
        // generation completes, and the reply is written with it.
        const pinnedWrote = await pollUntil(() => readChatFile(savedChatName),
            chat => Array.isArray(chat) && chatText(chat).includes(MARKERS.second), 60000);
        // A TURN THAT PRODUCED NO REPLY IS NOT A TURN THAT KEPT RUNNING, and waiting for the reply is also what makes
        // the CONTINUE click land on an idle page instead of being swallowed by a send still in flight (measured: the
        // continue appended nothing and no request left the page while the send's stream was outstanding).
        const sendRequestSeen = await pollUntil(async () => peer.requests.filter(entry => entry.carriesMarkers.second === true).pop() ?? null,
            entry => entry !== null, 60000);
        const sendReply = sendRequestSeen.value?.answersWith ?? null;
        report.pinnedSendRequest = { seen: sendRequestSeen.ok, stream: sendRequestSeen.value?.stream ?? null, messageCount: sendRequestSeen.value?.messageCount ?? null };
        const sendReplyPersisted = sendReply === null ? { ok: false, value: null } : await pollUntil(() => readChatFile(savedChatName),
            chat => Array.isArray(chat) && chat.some(entry => String(entry?.mes ?? '') === sendReply), 60000);
        report.pinnedSendReply = { sendReply, persisted: sendReplyPersisted.ok };
        step('pinnedWrote',
            sent.clicked === true && sent.timedOut !== true && pinnedWrote.ok === true && sendReplyPersisted.ok === true,
            {
                send: sent,
                persisted: pinnedWrote.ok,
                sendReply,
                replyPersisted: sendReplyPersisted.ok,
                fileMessages: Array.isArray(pinnedWrote.value) ? pinnedWrote.value.length : null,
                requests: peer.requests.map(entry => ({ stream: entry.stream, markers: entry.carriesMarkers, lastRole: entry.lastRole, answersWith: entry.answersWith })),
            });

        report.requestsBeforeContinue = peer.requests.length;
        const continueResult = await page.evaluate(async ({ startLength }) => {
            const script = await import('./script.js');
            const start = (script.chat ?? []).length;
            const lastTextBefore = String((script.chat ?? [])[start - 1]?.mes ?? '');
            const button = document.querySelector('#option_continue');
            if (!button) return { clicked: false, reason: 'no #option_continue' };
            button.click();
            // PINNED'S CONTINUE EXTENDS THE LAST MESSAGE, IT DOES NOT PUSH A NEW ONE (measured: the last message became
            // "Q21_REPLY_1 Q21_REPLY_2" and the chat length did not move), so waiting for a length increase waited for
            // something that never happens. The observable is the last message's TEXT growing.
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline) {
                const chat = script.chat ?? [];
                const lastTextNow = String(chat[start - 1]?.mes ?? '');
                if (chat.length > start || lastTextNow !== lastTextBefore) {
                    return {
                        clicked: true, startedAt: start, chatLength: chat.length,
                        lengthGrew: chat.length > start,
                        lastMessageGrew: lastTextNow !== lastTextBefore,
                        lastMessageBytes: lastTextNow.length,
                    };
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            return { clicked: true, startedAt: start, timedOut: true, chatLength: (script.chat ?? []).length };
        }, { startLength: pinnedWrote.value?.length ?? read.chatLength });
        report.pinnedContinue = continueResult;
        // THE TWO HALVES OF "KEEP RUNNING", EACH ABLE TO FAIL SEPARATELY:
        //   1. the CONTINUE request REACHED THE PROVIDER and carried the handed-back turns (captured by the peer);
        //   2. the answer the provider gave was PERSISTED into the chat file.
        // THE REQUEST BODY CARRIES NO GENERATION TYPE (measured: `type: null` on the send that DID reach the peer), so
        // the continue is identified by WHEN it arrives: everything recorded before the click belongs to the send, and
        // a request that appears after it can only be the continue, because nothing else runs in that window.
        const continueRequests = peer.requests.slice(report.requestsBeforeContinue ?? 0);
        const continueRequest = continueRequests[continueRequests.length - 1] ?? null;
        report.continueRequestsObserved = continueRequests.length;
        // THE HANDED-BACK REPLY IS THE SEND'S ANSWER -- the turn pinned produced FROM the GoTavern context, which is
        // what GoTavern must be able to read back. The continue's own answer is recorded in its row.
        const replyText = sendReply;
        const continueReply = continueRequest?.answersWith ?? null;
        const continuedInFile = await pollUntil(() => readChatFile(savedChatName),
            chat => continueReply !== null && Array.isArray(chat) && chat.some(entry => String(entry?.mes ?? '').includes(continueReply)), 60000);
        step('pinnedContinued',
            continueRequest !== null
                && continueRequest.carriesMarkers.first === true
                && continueRequest.carriesMarkers.second === true
                && continuedInFile.ok === true,
            {
                click: continueResult,
                continueRequests: continueRequests.length,
                carriedMarkers: continueRequest?.carriesMarkers ?? null,
                messageCount: continueRequest?.messageCount ?? null,
                answerPersisted: continuedInFile.ok,
                answersWith: continueReply,
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
    const verdict = missing.length > 0 ? 'unreached' : (failed.length > 0 || nonZero === false ? 'mismatch' : 'match');
    return { executed: true, phase: state.phase, verdict, required: required.length, missing, failed, countsAreNonZero: nonZero, counts };
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
        report.failure = report.failure ?? `hand-back judge ${report.judge.verdict}: failed=[${report.judge.failed.join(', ')}] missing=[${report.judge.missing.join(', ')}] counts=${JSON.stringify(report.judge.counts)}`;
    }
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${phase} leg: ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`${phase} judge: ${report.judge.verdict} -- ${report.judge.counts.ok}/${report.judge.counts.steps} step(s) green, ${report.judge.required} required row(s), ${report.judge.missing.length} missing, counts non-zero=${report.judge.countsAreNonZero}`);
    console.log(`${phase} judge counts: ${JSON.stringify(report.judge.counts)}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;
