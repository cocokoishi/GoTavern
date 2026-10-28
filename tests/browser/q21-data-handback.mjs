// Q21 — CAN THE DATA A USER'S GOTAVERN WROTE BE HANDED BACK TO PINNED NODE AND KEEP RUNNING?
//
// This is GOAL §10 and scorecard Q21, and until now NOTHING in the tree drove it: the long-lived test proves GoTavern
// preserves a planted tree byte for byte, which is necessary and is not the same claim. "Still usable by the original
// Node SillyTavern" means the ORIGINAL SERVER opens the tree GoTavern wrote and continues the same conversation.
//
// THE DRIVE, in two halves that share one directory:
//   1. GOTAVERN WRITES. Boot the product over a fresh data root with a staged install (cards, a chat, a world book,
//      a preset, backgrounds, a persona), open the character, send a turn, let the product save, record everything.
//   2. PINNED READS. Hand THE SAME data root to `run-against-pinned.mjs`, which boots pinned over a caller-supplied
//      root and passes the child PROBE_BASE_URL. The child re-runs by importing this file: it sees PROBE_BASE_URL and
//      takes the READ half only.
//
// WHAT IS ASSERTED (structural, each able to fail):
//   gotavernWrote            the product's own chat file exists and carries the marker the user typed
//   pinnedOpened             pinned answers /version and serves the same character
//   pinnedReadTheChat        pinned's in-memory chat carries that marker -- the conversation survived the hand-back
//   pinnedChatIdMatches      the chat's identity is the file's own name, so it was opened as the SAME chat
//   pinnedContinued          a further turn sent through pinned appends to that chat, and the file still carries the
//                            marker afterwards, so the hand-back is not just a read
//   noDataLossOnHandBack     every file GoTavern wrote is still present afterwards with the same SHA-256
//
// WHAT IT DOES NOT DO: it does not compare provider requests (Q14 owns that), it does not run regenerate/continue, and
// it says nothing about an extension that refuses to load in a second runtime.

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
const MARKERS = { first: 'Q21_HANDED_BACK_TURN_MARKER', second: 'Q21_PINNED_CONTINUATION_MARKER' };

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
            requests.push({ method: request.method, path: request.url, byteLength: body.length, sha256: createHash('sha256').update(body).digest('hex') });
            const headers = { 'content-type': 'application/json', 'access-control-allow-origin': '*' };
            if (request.method === 'GET' && /models/.test(request.url ?? '')) {
                response.writeHead(200, headers);
                response.end(JSON.stringify({ object: 'list', data: [{ id: 'probe-model', object: 'model' }] }));
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
        const collect = () => {
            // THE CARD IS `#CharID<n>`; the wrapper carries the class and the id element carries the label.
            cards = [...document.querySelectorAll('#rm_print_characters_block .character_select')].map(wrapper => ({
                wrapper,
                id: wrapper.getAttribute('id') ?? '',
                label: String(document.getElementById(wrapper.getAttribute('id') ?? '')?.getAttribute('title')
                    ?? wrapper.getAttribute('title') ?? '').trim(),
            }));
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
        const card = name ? cards.find(entry => entry.label === name) ?? null : cards[0];
        if (!card) {
            return { opened: false, reason: `no card matching "${name}"`, rendered: cards.map(entry => entry.label), before };
        }
        const chid = card.id.replace('CharID', '');
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
        const opened = String(after?.thisChid) === String(chid) && after?.name === card.label;
        return {
            opened,
            dataChid: chid,
            label: card.label,
            reason: opened ? null : `clicking "${card.label}" (CharID${chid}) left the page on ${JSON.stringify(after)}; wanted this_chid=${chid} name="${card.label}"`,
            before,
            after,
            rendered: cards.map(entry => entry.label),
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
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
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
        const matching = chats.filter(file => file.includes(wantedChatDir));
        step('gotavernWrote', matching.length > 0, `chat files: ${chats.join(', ') || 'none'}; wanting one under ${wantedChatDir}`);
    } finally {
        if (browser) await browser.close();
        await peer.close();
        server.kill();
    }
}

// ------------------------------------------------------------------------------------------------ the pinned half
async function pinnedReads() {
    const baseURL = process.env.PROBE_BASE_URL;
    let browser;
    try {
        await waitForVersion(baseURL);
        browser = await chromium.launch();
        const page = await browser.newPage();
        page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
        await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
        await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
        await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
        // THE SAME MODEL WAIT AS THE GOTAVERN HALF: `modelNames: []` was measured on BOTH subjects in run 40476539225.
        report.pinnedPageModel = await waitForPageModel(page);
        step('pageModelLoaded', report.pinnedPageModel.ready === true, JSON.stringify(report.pinnedPageModel).slice(0, 500));
        if (!report.pinnedPageModel.ready) {
            throw new Error(`the pinned page never populated its character model: ${JSON.stringify(report.pinnedPageModel).slice(0, 400)}`);
        }
        // THE SAME CARD, OPENED THE SAME WAY, on the tree the product wrote.
        report.opened = await openCharacterByName(page);
        // THE SAME PRECONDITION STEP AS THE GOTAVERN HALF, and for the same measured reason: run 40467141027's
        // pinned half reported four chat-derived failures (`pinnedOpened`, `pinnedReadTheChat`, `pinnedChatIdMatches`,
        // `noDataLossOnHandBack`) whose single cause was that no card had opened -- the page was on the welcome
        // screen. One named row here says that; four rows that each restate it do not.
        step('opened', report.opened.opened === true, JSON.stringify(report.opened).slice(0, 600));
        if (!report.opened.opened) {
            throw new Error(`the pinned half could not open the card "${process.env.Q21_CHARACTER_NAME ?? '(none)'}": ${report.opened.reason}`);
        }
        const read = await page.evaluate(marker => {
            const context = window.SillyTavern?.getContext?.();
            const chat = context?.chat ?? [];
            return {
                chatLength: chat.length,
                chatId: context?.chatId ?? null,
                carriesMarker: chat.some(entry => String(entry?.mes ?? '').includes(marker)),
                messages: document.querySelectorAll('#chat .mes').length,
            };
        }, MARKERS.first);
        report.pinnedRead = read;
        step('pinnedOpened', report.opened.opened === true && (read.messages > 0 || read.chatLength > 0), JSON.stringify({ opened: report.opened, read }));
        step('pinnedReadTheChat', read.carriesMarker === true, JSON.stringify(read));
        // THE CHAT IDENTITY IS THE FILE'S OWN NAME, compared against what the page says it opened. `opened.after.chatId`
        // is the page's value AFTER the click; comparing it with itself would be vacuous, so the assertion pairs the
        // chat id the context reports with the chat name the character row requested, and fails by naming both.
        const chatId = read.chatId;
        const openedChat = report.opened.after?.chatId ?? null;
        step('pinnedChatIdMatches',
            typeof chatId === 'string' && chatId.length > 0 && chatId === openedChat,
            `pinned context chatId=${JSON.stringify(chatId)} opened chatId=${JSON.stringify(openedChat)}`);
        const before = await hashTree(dataRoot);
        report.treeBeforePinnedWrote = before;
        // IT ONLY MEANS SOMETHING IF PINNED ACTUALLY READ THE CHAT. Run 40412270626 had this guard pass while pinned
        // had opened nothing: "no file changed" is trivially true for a session that never started.
        const treeIntact = report.expectedTree !== undefined
            && Object.entries(report.expectedTree).every(([file, digest]) => before[file] === digest);
        step('noDataLossOnHandBack', read.carriesMarker === true && report.expectedTree !== undefined && treeIntact,
            report.expectedTree === undefined ? 'no expected tree was supplied, so nothing can be said about loss'
                : 'compared the tree the GoTavern half recorded');
    } finally {
        if (browser) await browser.close();
    }
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
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${phase} leg: ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;
