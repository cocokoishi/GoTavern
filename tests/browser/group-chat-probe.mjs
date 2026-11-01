// THE GROUP-CHAT PROVIDER-REQUEST DIFFERENTIAL -- subject side.
//
// WHAT THIS PROVES (when its legs are compared by compare-group-chat-legs.mjs): a multi-character
// group chat driven through the PINNED FRONTEND sends the same final provider request under pinned
// Node and under GoTavern, for every scenario in CASES.
//
// WHY IT IS A BROWSER PROBE AND NOT A PROVIDER-WIRE SCENARIO. A group chat's turn is assembled in
// the browser: public/scripts/group-chats.js queues one Generate per activated member
// (group-chats.js:945-1092), and script.js/openai.js build that member's prompt (group nudge,
// member's card fields, world info, group history with per-message speaker attribution) before the
// request reaches /api/backends/chat-completions/generate. A body posted to that route by hand would
// be the harness's own reconstruction of a prompt, not the product's. tools/probe-provider-wire.mjs
// covers the backend->provider transformation; this probe covers the whole group turn.
//
// THE SUBJECT AND THE ORACLE NEVER SHARE AN EXPECTATION. This file reads no expected body, prompt or
// response. It seeds a user tree (group-chat-fixture.mjs), drives the pinned frontend, and records
// what the recording peer received. The pinned leg is recorded by the SAME script against pinned
// Node (run-against-pinned.mjs) and the comparator is the only place correctness is decided.
//
// DETERMINISM. Two sources of run-to-run variation are controlled explicitly and recorded:
//   * the group greeting picks `Math.random()` for the alternate greeting only when a card has one
//     (group-chats.js:581-585); these cards have none, so greeting text is fixed;
//   * NATURAL activation rolls `Math.random()` against talkativeness and shuffles members
//     (group-chats.js:1242-1316). All cards are talkativeness 1 (the SET is deterministic) and the
//     page's Math.random is replaced by a seeded LCG before any frontend module loads, so the ORDER
//     is reproducible on both subjects. The seed is recorded in the leg report. List-order and
//     manual cases never consume it.
//
// NO LIVE NETWORK. The only provider endpoint any leg is given is the in-process recording peer on
// 127.0.0.1; the custom-source URL travels in the frontend request member, so the subject cannot
// reach anything else through this drive. The peer replies with deterministic text keyed by
// (case, batch, ordinal), so both legs build identical chat histories.
//
// USAGE
//   GoTavern leg:  node tests/browser/group-chat-probe.mjs --data-root <dir> --report <path>
//   Pinned leg:    node tests/browser/run-against-pinned.mjs group-chat-probe.mjs -- \
//                    --data-root <dir> --report <path>
//   Restart leg:   append --phase restart (both subjects; the data root must be the one the full
//                  phase left behind, and the probe does NOT re-seed it).
//
// EXIT STATUS. 0 when the leg was recorded; non-zero when a precondition failed (no provider
// request for a case that must produce one, a page error, a marker that did not reach the request,
// or a scenario that never reached an idle state). A failed leg writes no comparison and the
// workflow's judge fails by name.

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
    MARKERS, expectedSeedDigest, repositoryRoot, seedDigest, seedGroupChatTree,
} from './group-chat-fixture.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const external = Boolean(process.env.PROBE_BASE_URL);
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

const PRNG_SEED = 0x5eed1234;
const USER_INPUT = MARKERS.USER_INPUT;

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

// `--seed-only <dir>` writes the deterministic input tree and exits. The pinned leg needs a data
// root of its own (run-against-pinned.mjs boots pinned Node over a caller-supplied directory), and
// BOTH legs must start from the same bytes, so the seeding step is the same code for both.
const seedOnly = argumentValue('--seed-only');
if (seedOnly) {
    const seeded = await seedGroupChatTree(seedOnly);
    console.log(JSON.stringify({ seeded: seeded.dataRoot, digest: seedDigest(seeded), cards: seeded.cards, groups: seeded.groups.length }));
    process.exit(0);
}

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createNetServer();
        server.unref();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close(() => resolve(port));
        });
    });
}

function sha256(value) {
    return createHash('sha256').update(value).digest('hex');
}

// THE CASE TABLE. Each case names the group it opens and the ordered steps it drives. A step is a
// driver instruction ("open this group", "send the composer", "press Continue"), never an expected
// output: everything the request should contain is decided by the pinned capture at run time.
//
// `expectRequests` is a DRIVE precondition (AGENTS.md verification rule 10): a case that must produce
// a provider request but produces none is a harness-faithfulness failure, not a pass. It is not an
// expected body.
const CASES = [
    {
        name: 'group-greeting',
        groupId: 'g-group-greeting',
        steps: [{ action: 'open' }, { action: 'observe' }],
        expectRequests: 0,
        notes: 'opening a group with no chat file builds the greeting from every member first_mes (group-chats.js:283-304); no provider request is made',
    },
    {
        name: 'user-message-natural-2',
        groupId: 'g-natural-2',
        steps: [{ action: 'open' }, { action: 'send', text: USER_INPUT }, { action: 'observe' }],
        expectRequests: 2,
        notes: '2 characters, NATURAL activation, a user message; every enabled member has talkativeness 1 so the set is All',
    },
    {
        name: 'user-message-natural-3',
        groupId: 'g-natural-3',
        steps: [{ action: 'open' }, { action: 'send', text: USER_INPUT }, { action: 'observe' }],
        expectRequests: 3,
        notes: '3 characters, NATURAL activation, a user message',
    },
    {
        name: 'user-message-list-3',
        groupId: 'g-list-3',
        steps: [{ action: 'open' }, { action: 'send', text: USER_INPUT }, { action: 'observe' }],
        expectRequests: 3,
        notes: '3 characters, LIST activation: all enabled members in member order',
    },
    {
        name: 'disabled-member',
        groupId: 'g-disabled',
        steps: [{ action: 'open' }, { action: 'send', text: USER_INPUT }, { action: 'observe' }],
        expectRequests: 2,
        notes: 'Carol is in disabled_members; a LIST-order turn must never produce a request for her',
    },
    {
        name: 'auto-mode-list',
        groupId: 'g-auto',
        steps: [{ action: 'open' }, { action: 'auto' }, { action: 'observe' }],
        expectRequests: 3,
        notes: 'auto mode drives generateGroupWrapper(true, "auto") (group-chats.js:1398-1414) with no user message',
    },
    {
        name: 'manual-activation',
        groupId: 'g-manual',
        steps: [
            { action: 'open' },
            { action: 'force', member: 'Bob' },
            { action: 'force', member: 'Alice' },
            { action: 'observe' },
        ],
        expectRequests: 2,
        notes: 'manual mode: the user (or /trigger) forces one member at a time, in a chosen order (slash-commands.js:4987-5023)',
    },
    {
        name: 'previous-speaker',
        groupId: 'g-previous-speaker',
        steps: [
            { action: 'open' },
            { action: 'send', text: USER_INPUT },
            { action: 'trigger' },
            { action: 'observe' },
        ],
        expectRequests: 5,
        notes: 'a trigger with no user input after a character spoke: NATURAL activation bans the previous speaker (group-chats.js:1246-1251)',
    },
    {
        name: 'world-info-and-note',
        groupId: 'g-world-info',
        steps: [
            { action: 'open' },
            { action: 'configureWorldInfo' },
            { action: 'configureAuthorsNote' },
            { action: 'configureSamplers' },
            { action: 'send', text: `${USER_INPUT} — the lantern, the orchard and the map.` },
            { action: 'observe' },
        ],
        expectRequests: 2,
        markers: [MARKERS.ALICE_LORE, MARKERS.GLOBAL_LORE, MARKERS.CHAT_LORE, MARKERS.AUTHORS_NOTE],
        notes: "character-bound WI (Alice's card world), the chat/group-bound world book (chat_metadata.world_info), the globally selected book, Author's Note at depth, and non-default samplers/stops in one turn",
    },
    {
        name: 'continue',
        groupId: 'g-continue',
        steps: [
            { action: 'open' },
            { action: 'send', text: USER_INPUT },
            { action: 'continue' },
            { action: 'observe' },
        ],
        expectRequests: 3,
        notes: 'user turn (2 members) then the Continue button: activateSwipe picks the last speaker only (group-chats.js:1014-1020)',
    },
    {
        name: 'swipe',
        groupId: 'g-swipe',
        steps: [
            { action: 'open' },
            { action: 'send', text: USER_INPUT },
            { action: 'swipe' },
            { action: 'observe' },
        ],
        expectRequests: 3,
        notes: 'user turn then the Swipe button',
    },
    {
        name: 'regenerate',
        groupId: 'g-regenerate',
        steps: [
            { action: 'open' },
            { action: 'send', text: USER_INPUT },
            { action: 'regenerate' },
            { action: 'observe' },
        ],
        expectRequests: 4,
        notes: 'user turn then the Regenerate button (script.js option_regenerate -> regenerateGroup)',
    },
    {
        name: 'impersonate',
        groupId: 'g-impersonate',
        steps: [{ action: 'open' }, { action: 'impersonate' }, { action: 'observe' }],
        expectRequests: 1,
        notes: 'the Impersonate button: activateImpersonate picks one member with Math.random (group-chats.js:1114-1121), deterministic under the seeded PRNG',
    },
    {
        name: 'truncation',
        groupId: 'g-truncation',
        steps: [
            { action: 'open' },
            { action: 'configureSmallContext' },
            { action: 'send', text: `${USER_INPUT} one` },
            { action: 'send', text: `${USER_INPUT} two` },
            { action: 'send', text: `${USER_INPUT} three` },
            { action: 'observe' },
        ],
        expectRequests: 6,
        notes: 'the context budget is small enough that the pinned trimmer drops old history: message ORDER and the KEPT SUBSET are the observable',
    },
    {
        name: 'restart-reload',
        groupId: 'g-restart',
        // The full phase PREPARES the chat (open + one user turn), so the restart phase has a
        // conversation to reload. Without the preparation the restart phase would open a fresh
        // chat and the "reloaded history" assertion would be vacuous.
        steps: [{ action: 'open' }, { action: 'send', text: `${USER_INPUT} restart` }, { action: 'observe' }],
        expectRequests: 2,
        restartSteps: [{ action: 'openExisting' }, { action: 'observe' }, { action: 'continue' }, { action: 'observe' }],
        expectRestartRequests: 1,
        notes: 'the server is restarted over the SAME tree, the group chat is reloaded from disk, then Continue: the request must carry the reloaded history',
    },
];

// The full phase seeds the tree and drives every non-restart case; the restart phase reopens the
// tree the full phase left behind. Both phases are recorded on both subjects.
const phase = argumentValue('--phase', 'full');
if (!['full', 'restart'].includes(phase)) {
    console.error(`--phase must be "full" or "restart", got ${JSON.stringify(phase)}`);
    process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// The recording peer. In-process, so the peer knows which case is being driven without a second
// channel. Replies are deterministic and keyed by (case, batch, ordinal) so both legs build the
// same chat text; the peer never decides what the request should contain.
// ---------------------------------------------------------------------------------------------
const peerRequests = [];
let currentCase = null;
let currentBatch = null;
const peer = createServer((request, response) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
        const body = Buffer.concat(chunks);
        const url = request.url ?? '/';
        const record = {
            case: currentCase,
            batch: currentBatch,
            method: request.method,
            target: url,
            authority: request.headers.host ?? null,
            bodySha256: sha256(body),
            bodyLength: body.length,
            bodyText: body.toString('utf8'),
        };
        if (request.method === 'POST') {
            peerRequests.push(record);
        }
        if (request.method === 'GET' && url.split('?')[0].endsWith('/models')) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ object: 'list', data: [{ id: 'group-probe-model', object: 'model' }] }));
            return;
        }
        const ordinal = peerRequests.filter(entry => entry.method === 'POST').length;
        const text = `GROUP_REPLY:${currentCase ?? 'unlabelled'}:${currentBatch ?? 'unlabelled'}:${ordinal}`;
        const completion = {
            id: `group-probe-${ordinal}`,
            object: 'chat.completion',
            created: 0,
            model: 'group-probe-model',
            choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        };
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(completion));
    });
});
await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
const peerAddress = `127.0.0.1:${peer.address().port}`;
const peerURL = `http://${peerAddress}`;

// ---------------------------------------------------------------------------------------------
// The subject's server. In external mode the caller (run-against-pinned.mjs) has already booted
// pinned Node; otherwise this probe boots the GoTavern binary over the seeded tree.
// ---------------------------------------------------------------------------------------------
const dataRoot = path.resolve(argumentValue('--data-root', external ? '' : await fs.mkdtemp(path.join(os.tmpdir(), 'gotavern-group-chat-'))));
if (!dataRoot || dataRoot === path.resolve('')) {
    console.error('--data-root is required in external mode');
    process.exit(2);
}

const report = {
    schemaVersion: 1,
    question: 'Does a multi-character group chat driven through the pinned frontend send the same final provider request under pinned Node and GoTavern?',
    phase,
    subject: external ? 'pinned' : 'gotavern',
    prngSeed: PRNG_SEED,
    seed: null,
    tokenizerRoot: null,
    cases: [],
    connectionProbes: [],
    pageErrors: [],
    httpFailures: [],
    failure: null,
};
let server = null;
let serverLog = [];
let baseURL = process.env.PROBE_BASE_URL;
let browser = null;

function fail(message) {
    report.failure = message;
    throw new Error(message);
}

try {
    // SEED ONLY IN THE FULL PHASE. The restart phase must find the tree exactly as the full phase
    // left it: re-seeding would erase the chat the restart is supposed to reload.
    if (!external && phase === 'full') {
        report.seed = await seedGroupChatTree(dataRoot);
    } else if (!external && phase === 'restart') {
        const marker = path.join(dataRoot, 'default-user', 'groups', `${CASES.find(entry => Array.isArray(entry.restartSteps)).groupId}.json`);
        if (!existsSync(marker)) {
            fail(`restart phase needs the tree the full phase wrote, but ${marker} is missing`);
        }
        report.seed = { dataRoot: null, replayed: true };
    } else {
        // The pinned leg's tree is written by the caller with the same fixture; its digest is
        // recomputed here from the same declaration so a pair that did not start from the same
        // bytes can be refused.
        report.seed = { dataRoot: null, external: true };
    }
    report.seedDigest = await expectedSeedDigest();

    if (!external) {
        const binary = process.env.GOTAVERN_BINARY
            ? path.resolve(process.env.GOTAVERN_BINARY)
            : path.join(dataRoot, 'bin', process.platform === 'win32' ? 'gotavern.exe' : 'gotavern');
        if (!process.env.GOTAVERN_BINARY) {
            const build = spawnSync('go', ['build', '-trimpath', '-o', binary, './cmd/gotavern'], { cwd: repositoryRoot, stdio: 'inherit' });
            if (build.status !== 0) throw new Error(`go build failed with status ${build.status}`);
        }
        // STAGE THE RELEASE TOKENIZER LAYOUT BESIDE THE BINARY. `gotavern start` resolves the
        // install root as the executable's directory (cmd/gotavern/main.go), and the tokenizer
        // routes look for <install root>/src/tokenizers. Without it every /api/tokenizers call
        // answers the Guesstimate fallback, which is a DIFFERENT count from pinned's exact one and
        // would make the truncation case measure the harness. This is the release layout, not a
        // production change to make a probe work.
        const tokenizerSource = path.join(repositoryRoot, 'upstream', 'tokenizers');
        const tokenizerTarget = path.join(path.dirname(binary), 'src', 'tokenizers');
        if (await fs.stat(tokenizerSource).then(() => true, () => false)) {
            await fs.mkdir(path.join(path.dirname(binary), 'src'), { recursive: true });
            await fs.cp(tokenizerSource, tokenizerTarget, { recursive: true });
            report.tokenizerRoot = { layout: 'src/tokenizers', source: 'upstream/tokenizers', entries: (await fs.readdir(tokenizerTarget)).length };
        } else {
            throw new Error(`tokenizer assets missing at ${tokenizerSource}; the truncation case would measure a guesstimate on one leg`);
        }
        const port = await freePort();
        server = spawn(binary, ['start', '--port', String(port), '--dataRoot', dataRoot, '--browserLaunchEnabled', 'false'], {
            cwd: repositoryRoot,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        server.stdout.on('data', chunk => serverLog.push(chunk.toString()));
        server.stderr.on('data', chunk => serverLog.push(chunk.toString()));
        baseURL = `http://127.0.0.1:${port}`;
    } else {
        report.tokenizerRoot = { layout: 'external', source: 'pinned checkout src/tokenizers', entries: null };
    }

    const readyDeadline = Date.now() + (external ? 300000 : 90000);
    let ready = false;
    while (Date.now() < readyDeadline) {
        try {
            const response = await fetch(`${baseURL}/version`);
            if (response.status < 500) {
                // HOST-INDEPENDENT PROVENANCE. The base URL is a port chosen per run, so it must
                // never enter the artefact: the committed pinned fixture is re-recorded and diffed
                // byte-for-byte by the workflow, and an ephemeral port would make every run stale.
                report.serverVersion = (await response.text()).trim().slice(0, 200);
                ready = true;
                break;
            }
        } catch {
            // not listening yet
        }
        await new Promise(resolve => setTimeout(resolve, 200));
    }
    if (!ready) fail(`the subject at ${baseURL} never answered /version`);

    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error.message ?? error).slice(0, 300)));
    page.on('response', response => {
        if (response.status() >= 400) report.httpFailures.push(`${response.status()} ${response.request().method()} ${new URL(response.url()).pathname}`);
    });
    page.on('requestfailed', request => report.httpFailures.push(`FAILED ${request.method()} ${new URL(request.url()).pathname}: ${request.failure()?.errorText ?? ''}`));
    // Same PRNG on both subjects, installed before any frontend module can call it.
    await page.addInitScript(seed => {
        let state = seed >>> 0;
        Math.random = () => {
            state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
            return state / 4294967296;
        };
    }, PRNG_SEED);

    await page.goto(`${baseURL}/`);
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 120000 });

    // One evaluate call installs the page-side driver state (the frontend modules) and waits for the
    // same readiness a user's first send waits for.
    const setup = await page.evaluate(async ({ peerURL, phase, USER_INPUT }) => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        const groupChats = await import('./scripts/group-chats.js');
        const worldInfo = await import('./scripts/world-info.js');
        const secrets = await import('./scripts/secrets.js');
        const powerUser = await import('./scripts/power-user.js');

        const onboarding = document.querySelector('.popup .onboarding');
        if (onboarding) {
            const input = onboarding.closest('.popup')?.querySelector('.popup-input');
            if (input) { input.value = 'Group Probe User'; input.dispatchEvent(new Event('input', { bubbles: true })); }
            onboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
        }
        const readinessDeadline = performance.now() + 120000;
        while (performance.now() < readinessDeadline && !script.settingsReady) {
            const popupOnboarding = document.querySelector('.popup .onboarding');
            if (popupOnboarding) {
                const input = popupOnboarding.closest('.popup')?.querySelector('.popup-input');
                if (input) { input.value = 'Group Probe User'; input.dispatchEvent(new Event('input', { bubbles: true })); }
                popupOnboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!script.settingsReady) return { error: 'settingsReady never became true' };
        const mainApi = document.querySelector('#main_api');
        if (!mainApi) return { error: '#main_api is absent' };
        mainApi.value = 'openai';
        mainApi.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(resolve => setTimeout(resolve, 500));

        openai.oai_settings.chat_completion_source = 'custom';
        openai.oai_settings.custom_url = peerURL;
        openai.oai_settings.custom_model = 'group-probe-model';
        openai.oai_settings.stream_openai = false;
        openai.oai_settings.openai_max_context = 4096;
        openai.oai_settings.openai_max_tokens = 64;
        openai.oai_settings.temp_openai = 0.5;
        openai.oai_settings.top_p_openai = 1;
        openai.oai_settings.freq_pen_openai = 0;
        openai.oai_settings.pres_pen_openai = 0;
        openai.oai_settings.names_behavior = 0;
        openai.oai_settings.show_thoughts = false;
        const secretKey = secrets.SECRET_KEYS.CUSTOM;
        await secrets.writeSecret(secretKey, 'probe-synthetic-key');
        document.querySelector('#api_button_openai')?.click();
        const connectDeadline = performance.now() + 30000;
        let onlineStatus = String(script.online_status);
        while (performance.now() < connectDeadline) {
            onlineStatus = String(script.online_status);
            if (onlineStatus !== 'no_connection' && onlineStatus !== 'unknown') break;
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        if (onlineStatus === 'no_connection') return { error: 'the frontend never reached a connected online_status', toastr: document.querySelector('#toast-container')?.textContent?.slice(0, 200) ?? null };
        // LIST THE SEEDED ROSTER, WITH A BOUNDED RETRY. A cold pinned boot can answer
        // /api/characters/all with an empty array while its own content seeding initialises the
        // user tree (measured on this lane: one pinned leg recorded `characters: []` with zero HTTP
        // failures, so the endpoint answered 200 and the list was genuinely empty at that moment).
        // A user would simply see the roster appear; the drive re-asks the same endpoint, bounded,
        // and the report records how many attempts it took -- never a sleep.
        const rosterDeadline = performance.now() + 60000;
        let rosterAttempts = 0;
        while (performance.now() < rosterDeadline) {
            rosterAttempts += 1;
            await script.getCharacters();
            await groupChats.getGroups();
            if (Array.isArray(script.characters) && script.characters.length >= 3 && Array.isArray(groupChats.groups) && groupChats.groups.length >= 10) {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        if (!Array.isArray(script.characters) || script.characters.length < 3) {
            return { error: 'the seeded characters were not listed', characters: script.characters?.map(entry => entry?.name) ?? null, rosterAttempts };
        }
        if (!Array.isArray(groupChats.groups) || groupChats.groups.length < 10) {
            return { error: 'the seeded groups were not listed', groups: groupChats.groups?.map(entry => entry?.name) ?? null, rosterAttempts };
        }

        globalThis.__groupProbe = {
            script, openai, groupChats, worldInfo, secrets, powerUser,
            MARKERS: { USER_INPUT },
            events: { wrapperStarted: 0, wrapperFinished: 0 },
        };
        // THE WRAPPER'S OWN LIFECYCLE EVENTS ARE THE COMPLETION SIGNAL.
        //
        // `document.body.dataset.generating` and the module flags are per-member: a group turn runs
        // one Generate per activated member (group-chats.js:1051-1076), so between two members the
        // page briefly looks idle while the wrapper is still running. Measured on this lane's first
        // run: natural-2 produced 1 recorded provider request because the drive stopped in that gap.
        // GROUP_WRAPPER_FINISHED is emitted exactly once, in the wrapper's `finally`
        // (group-chats.js:1088), so waiting for it is waiting on the quantity the assertion reads.
        const events = await import('./scripts/events.js');
        events.eventSource.on(events.event_types.GROUP_WRAPPER_STARTED, () => { globalThis.__groupProbe.events.wrapperStarted += 1; });
        events.eventSource.on(events.event_types.GROUP_WRAPPER_FINISHED, () => { globalThis.__groupProbe.events.wrapperFinished += 1; });
        // WAIT UNTIL THE FRONTEND IS IDLE. The prompt manager starts a dry generation of its own
        // when the source/model changes (openai.js initOpenAI), which is the same readiness a user's
        // send implicitly waits for; a send issued mid-dry-run would interleave two assemblies.
        const quiet = async (minimumQuietMs = 500, limitMs = 60000) => {
            const deadline = performance.now() + limitMs;
            let quietSince = null;
            let lastLength = script.chat.length;
            while (performance.now() < deadline) {
                const generating = Boolean(document.body.dataset.generating) || Boolean(script.isGenerating());
                const length = script.chat.length;
                if (!generating && length === lastLength) {
                    if (quietSince === null) quietSince = performance.now();
                    if (performance.now() - quietSince > minimumQuietMs) return { ok: true, chatLength: length };
                } else {
                    quietSince = null;
                    lastLength = length;
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return { ok: false, chatLength: script.chat.length, generating: Boolean(document.body.dataset.generating) || Boolean(script.isGenerating()) };
        };
        // Wait for one COMPLETED group wrapper after `baseline`, then for a quiet page.
        const idle = async (baseline = null, limitMs = 60000) => {
            if (baseline === null) {
                return quiet(500, limitMs);
            }
            const deadline = performance.now() + limitMs;
            while (performance.now() < deadline) {
                if (globalThis.__groupProbe.events.wrapperFinished > baseline) {
                    const settled = await quiet(400, 30000);
                    return { ...settled, wrapperFinished: globalThis.__groupProbe.events.wrapperFinished, wrapperDelta: globalThis.__groupProbe.events.wrapperFinished - baseline };
                }
                await new Promise(resolve => setTimeout(resolve, 50));
            }
            return { ok: false, reason: 'the group wrapper never finished', wrapperStarted: globalThis.__groupProbe.events.wrapperStarted, wrapperFinished: globalThis.__groupProbe.events.wrapperFinished };
        };
        globalThis.__groupProbe.quiet = quiet;
        globalThis.__groupProbe.idle = idle;
        const idleResult = await quiet(500);
        if (!idleResult.ok) return { error: 'the frontend never became idle after settings loaded', idleResult };
        return {
            ready: true,
            onlineStatus,
            rosterAttempts,
            characters: script.characters.map(entry => entry.name),
            groups: groupChats.groups.map(entry => entry.name),
            chatCompletionSource: openai.oai_settings.chat_completion_source,
            stream: openai.oai_settings.stream_openai,
            mainApi: String(script.main_api),
        };
    }, { peerURL, phase, USER_INPUT });
    if (setup.error) fail(`setup: ${setup.error} ${JSON.stringify(setup)}`);
    report.setup = setup;

    // ---------------------------------------------------------------------------------------
    // The page-side step runner. It is idempotent per call: every step takes the page as it is,
    // performs one user-visible action, and returns what it observed -- never an expected value.
    // ---------------------------------------------------------------------------------------
    const runStepInPage = async ({ action, groupId, text, member, markers }) => {
        const gp = globalThis.__groupProbe;
        const { script, openai, groupChats, worldInfo, powerUser } = gp;
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const requireGroup = () => {
            const group = groupChats.groups.find(entry => entry.id === groupId);
            if (!group) throw new Error('group ' + groupId + ' is not in the frontend roster: ' + groupChats.groups.map(entry => entry.id).join(','));
            return group;
        };
        const emit = (observation) => {
            gp.lastObservation = observation;
            return observation;
        };
        // PIN Math.random FOR THE DURATION OF A GENERATION.
        //
        // Two group decisions are dice rolls: NATURAL activation rolls each member's talkativeness
        // and shuffles the member order (group-chats.js:1271-1291), and impersonate picks a member at
        // random (group-chats.js:1114-1121). The page also calls Math.random for things that never
        // reach a provider request (message `gen_id`), and asynchronous frontend code can consume a
        // different NUMBER of values per run. Measured on this lane: `impersonate` selected a
        // different member on a re-record, changing its request bytes between two otherwise
        // identical runs. Pinning the value for exactly the generation window makes the dice roll a
        // constant on BOTH subjects -- a harness determinism control (like a fixed seed), not an
        // expectation. With talkativeness 1, roll 0.5 activates every enabled member; the shuffle
        // order of a constant-random Fisher-Yates is a fixed permutation; impersonate's
        // floor(0.5 * memberCount) is a fixed member.
        const withPinnedRandom = async (run) => {
            const original = Math.random;
            Math.random = () => 0.5;
            try {
                return await run();
            } finally {
                Math.random = original;
            }
        };
        if (action === 'open' || action === 'openExisting') {
            requireGroup();
            if (String(groupChats.selected_group) === String(groupId)) {
                // A user cannot re-open the group they are already in; the probe resets the
                // selection the way leaving the chat does, so the open path runs for real.
                groupChats.resetSelectedGroup();
            }
            const result = await withPinnedRandom(async () => {
                const opened = await groupChats.openGroupById(groupId);
                if (!opened) throw new Error('openGroupById(' + groupId + ') refused');
                // wait for the chat model the assertion reads, not for a neighbouring signal
                const deadline = performance.now() + 60000;
                while (performance.now() < deadline && (!Array.isArray(script.chat) || script.chat.length === 0)) {
                    await sleep(100);
                }
                return gp.idle();
            });
            return emit({
                step: action,
                selectedGroup: String(groupChats.selected_group),
                chatLength: script.chat.length,
                chatId: script.getCurrentChatId() ?? null,
                messages: script.chat.map(message => ({ name: message.name, isUser: Boolean(message.is_user), isSystem: Boolean(message.is_system) })),
                idle: result,
            });
        }
        if (action === 'send') {
            const composer = document.querySelector('#send_textarea');
            if (!composer) throw new Error('#send_textarea is absent');
            composer.value = text;
            composer.dispatchEvent(new Event('input', { bubbles: true }));
            const sendButton = document.querySelector('#send_but');
            if (!sendButton) throw new Error('#send_but is absent');
            const baseline = gp.events.wrapperFinished;
            const idle = await withPinnedRandom(async () => {
                sendButton.click();
                return gp.idle(baseline);
            });
            if (!idle.ok) throw new Error('the group wrapper never settled after the send: ' + JSON.stringify(idle));
            return emit({ step: 'send', typed: text, idle, chatLength: script.chat.length });
        }
        if (action === 'auto') {
            const idle = await withPinnedRandom(async () => {
                await groupChats.generateGroupWrapper(true, 'auto');
                return gp.quiet(400);
            });
            return emit({ step: 'auto', idle, chatLength: script.chat.length });
        }
        if (action === 'force') {
            const character = script.characters.find(entry => entry.name === member);
            if (!character) throw new Error('no character named ' + JSON.stringify(member));
            const chid = script.characters.indexOf(character);
            const baseline = gp.events.wrapperFinished;
            const idle = await withPinnedRandom(async () => {
                await script.Generate('normal', { force_chid: chid });
                return gp.idle(baseline);
            });
            if (!idle.ok) throw new Error('the group wrapper never settled after the forced turn: ' + JSON.stringify(idle));
            return emit({ step: 'force', member, idle, chatLength: script.chat.length });
        }
        if (action === 'trigger') {
            const baseline = gp.events.wrapperFinished;
            const idle = await withPinnedRandom(async () => {
                await script.Generate('normal');
                return gp.idle(baseline);
            });
            if (!idle.ok) throw new Error('the group wrapper never settled after the trigger: ' + JSON.stringify(idle));
            return emit({ step: 'trigger', idle, chatLength: script.chat.length });
        }
        if (action === 'swipe') {
            // There is no `#option_swipe` element in the pinned options menu; a user swipes with
            // the message's arrow (or /swipe). `swipe_right` is the exported function the arrow
            // calls, and SWIPE_SOURCE.SLASH_COMMAND is the same bypass the /swipe command uses
            // (script.js:9954-10460 -> Generate('swipe') -> generateGroupWrapper('swipe')).
            const baseline = gp.events.wrapperFinished;
            const idle = await withPinnedRandom(async () => {
                await script.swipe_right(null, { source: 'slash-command' });
                return gp.idle(baseline);
            });
            if (!idle.ok) throw new Error('the group wrapper never settled after the swipe: ' + JSON.stringify(idle));
            return emit({ step: 'swipe', idle, chatLength: script.chat.length });
        }
        if (action === 'continue' || action === 'regenerate' || action === 'impersonate') {
            const id = { continue: 'option_continue', regenerate: 'option_regenerate', impersonate: 'option_impersonate' }[action];
            const button = document.querySelector('#' + id);
            if (!button) throw new Error('#' + id + ' is absent');
            const baseline = gp.events.wrapperFinished;
            const idle = await withPinnedRandom(async () => {
                button.click();
                return gp.idle(baseline);
            });
            if (!idle.ok) throw new Error('the group wrapper never settled after #' + id + ': ' + JSON.stringify(idle));
            return emit({ step: action, idle, chatLength: script.chat.length });
        }
        if (action === 'configureWorldInfo') {
            // three scopes at once: the character-bound book rides on Alice's card, the
            // chat/group-bound book on chat_metadata.world_info, the shared book on the global
            // selection a user ticks in the World Info panel.
            if (!worldInfo.selected_world_info.includes('GlobalLore')) {
                worldInfo.selected_world_info.push('GlobalLore');
            }
            script.chat_metadata.world_info = 'ChatLore';
            return emit({ step: action, selectedWorldInfo: [...worldInfo.selected_world_info], chatWorldInfo: script.chat_metadata.world_info });
        }
        if (action === 'configureAuthorsNote') {
            const note = markers.AUTHORS_NOTE;
            const field = document.querySelector('#extension_floating_prompt');
            if (field) {
                field.value = note;
                field.dispatchEvent(new Event('input', { bubbles: true }));
            }
            script.chat_metadata.note_prompt = note;
            script.chat_metadata.note_interval = 1;
            script.chat_metadata.note_depth = 2;
            script.chat_metadata.note_position = 1; // extension_prompt_types.IN_CHAT
            script.chat_metadata.note_role = 0;     // extension_prompt_roles.SYSTEM
            return emit({ step: action, note: script.chat_metadata.note_prompt, interval: script.chat_metadata.note_interval, depth: script.chat_metadata.note_depth, position: script.chat_metadata.note_position });
        }
        if (action === 'configureSamplers') {
            openai.oai_settings.temp_openai = 0.91;
            openai.oai_settings.top_p_openai = 0.77;
            openai.oai_settings.freq_pen_openai = 0.11;
            openai.oai_settings.pres_pen_openai = 0.22;
            openai.oai_settings.openai_max_tokens = 77;
            powerUser.power_user.custom_stopping_strings = JSON.stringify(['GROUP_STOP_A', 'GROUP_STOP_B']);
            return emit({ step: action, temperature: openai.oai_settings.temp_openai, topP: openai.oai_settings.top_p_openai, frequencyPenalty: openai.oai_settings.freq_pen_openai, presencePenalty: openai.oai_settings.pres_pen_openai, maxTokens: openai.oai_settings.openai_max_tokens, stop: powerUser.power_user.custom_stopping_strings });
        }
        if (action === 'configureSmallContext') {
            openai.oai_settings.max_context_unlocked = true;
            // 160, not 320: measured, 320 tokens fits the greeting + three user turns and six
            // short replies, so NO history was dropped and the truncation case would have compared
            // a context that never truncated. 160 forces the pinned trimmer to drop the oldest
            // turn while keeping the newest (asserted from the requests, not from this number).
            openai.oai_settings.openai_max_context = 160;
            openai.oai_settings.openai_max_tokens = 32;
            return emit({ step: action, openaiMaxContext: openai.oai_settings.openai_max_context, openaiMaxTokens: openai.oai_settings.openai_max_tokens });
        }
        if (action === 'observe') {
            const last = script.chat[script.chat.length - 1] ?? null;
            return emit({
                step: 'observe',
                chatLength: script.chat.length,
                chatId: script.getCurrentChatId() ?? null,
                lastMessage: last ? { name: last.name, isUser: Boolean(last.is_user), text: String(last.mes).slice(0, 200) } : null,
                messages: script.chat.map(message => ({ name: message.name, isUser: Boolean(message.is_user), text: String(message.mes).slice(0, 120) })),
                generating: Boolean(script.isGenerating()),
            });
        }
        throw new Error('unknown step action ' + JSON.stringify(action));
    };

    const runStep = async (step, caseName) => {
        currentCase = caseName;
        currentBatch = step.action;
        return page.evaluate(runStepInPage, { ...step, markers: MARKERS });
    };

    const cases = CASES.filter(entry => (phase === 'restart' ? Array.isArray(entry.restartSteps) : true));
    const driveStarted = Date.now();
    for (const caseDefinition of cases) {
        // MEASURED BOUND, NOT A SLEEP: a normal case completes in 1-4 s (the wrapper's own FINISHED
        // event is the wait). A drive that has not finished the case list inside this bound is
        // wedged, and says so by name rather than letting the workflow timeout report a bare kill.
        if (Date.now() - driveStarted > 8 * 60 * 1000) {
            fail(`the group drive exceeded its 8-minute wedge bound after ${caseDefinition.name}; a frontend that does not settle is a harness failure, not a pass`);
        }
        const steps = phase === 'restart' ? caseDefinition.restartSteps : caseDefinition.steps;
        const expected = phase === 'restart' ? (caseDefinition.expectRestartRequests ?? null) : (caseDefinition.expectRequests ?? null);
        const before = peerRequests.length;
        const caseReport = {
            name: caseDefinition.name,
            groupId: caseDefinition.groupId,
            notes: caseDefinition.notes,
            steps: [],
            requests: [],
            observations: [],
        };
        for (const step of steps) {
            caseReport.steps.push(await runStep({ ...step, groupId: caseDefinition.groupId }, caseDefinition.name));
        }
        currentCase = null;
        currentBatch = null;
        caseReport.requests = peerRequests.slice(before).map(record => ({
            method: record.method,
            target: record.target,
            batch: record.batch,
            bodySha256: record.bodySha256,
            bodyLength: record.bodyLength,
            bodyText: record.bodyText,
        }));
        // A DRIVE PRECONDITION, NAMED. Case that must reach the provider but did not is a harness
        // failure (AGENTS.md verification rule 10), never a pass.
        if (expected !== null && caseReport.requests.length !== expected) {
            fail(`${caseDefinition.name} (${phase} phase): expected ${expected} provider request(s), recorded ${caseReport.requests.length}`);
        }
        // A scenario whose marker must appear in the request must actually reach it, or the case
        // measured something else. The marker is a string this harness injected, not an expected
        // body: it proves the world book / note was REACHED, not what the request should be.
        for (const marker of caseDefinition.markers ?? []) {
            if (!caseReport.requests.some(record => String(record.bodyText).includes(marker))) {
                fail(`${caseDefinition.name}: marker ${marker} never reached a provider request, so the mechanism it names was not exercised`);
            }
        }
        report.cases.push(caseReport);
    }

    report.connectionProbes = peerRequests.filter(record => record.method !== 'POST').map(record => ({ method: record.method, target: record.target }));
    if (report.pageErrors.length > 0) fail(`page errors: ${report.pageErrors.join(' | ')}`);
} catch (error) {
    report.failure = report.failure ?? String(error?.message ?? error);
} finally {
    await browser?.close().catch(() => { });
    if (server) server.kill();
    peer.close();
}

const reportPath = path.resolve(argumentValue('--report', path.join(here, 'group-chat-leg.json')));
await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
// The stdout projection is for CI logs; the artefact is the JSON.
console.log(JSON.stringify({
    subject: report.subject,
    phase: report.phase,
    failure: report.failure,
    cases: report.cases.map(entry => ({ name: entry.name, requests: entry.requests.length, sha: entry.requests.map(record => record.bodySha256.slice(0, 12)) })),
    pageErrors: report.pageErrors.length,
    httpFailures: report.httpFailures.length,
    report: reportPath,
}));
if (report.failure) {
    console.error(`GROUP-CHAT PROBE FAILED: ${report.failure}`);
    if (serverLog.length) console.error(serverLog.join('').slice(-4000));
    process.exit(1);
}
