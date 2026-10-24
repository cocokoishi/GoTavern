// Capture the COMPLEX preset from the PINNED frontend, and measure where its context boundary lies.
//
// Run against a running pinned server (run-against-pinned.mjs capture-preset.mjs). It is the only
// producer of tests/browser/fixtures/preset-complex-settings.json: the settings in that file are read
// OUT of the pinned frontend after the scenario is applied, never written by hand, so a re-capture
// after a baseline bump is a byte-for-byte determinism check rather than a manual edit.
//
// THE BOUNDARY IS BINARY-SEARCHED, NOT DERIVED. `openai_max_context` is the only knob that decides
// whether the oldest history turn is kept (public/scripts/openai.js:3982-4089 trims client-side). This
// script drives the pinned frontend's own DRY assembly for a series of contexts and finds the smallest
// one that still contains the oldest marker, then records it and the value one below it. Those two
// numbers are a PINNED OBSERVATION of the pinned trimmer; the drive legs replay them, and the
// comparator requires the pinned leg to reproduce the keep/drop decision at each. No number in this
// file or in the fixture comes from GoTavern.
//
// WHY THE PAIR IS MEASURED ON THE PRE-SEND ASSEMBLY, AND WHERE THE PROOF LIVES NOW. The first version
// bisected with `script.Generate('normal', {}, true)` and recorded the pair it found; run 40082539457 then
// drove both variants at that exact pair and BOTH produced the drop shape on BOTH servers (26 messages,
// 11 history turns, oldest absent), because a dry assembly costs a few tokens less than the send it
// predicts. The capture then bisected by DRIVING REAL SENDS against a recording peer, and run 40087218275
// showed that even a send-measured pair could disagree with the drive at the same context (the capture's
// send held 24 messages / 12 history where the drive held 26 / 11). Sending in the capture therefore
// duplicated work without settling the question, so it is gone: the capture records what the drive needs
// to start from -- settings, kit, tokenizer anchor and `preSend` -- and measures the pair on the PRE-SEND
// assembly, which is the same pass the drive uses to record `preSend`.
//
// THE PROOF MOVED TO THE DRIVE, WHERE IT IS CHECKED ON BOTH LEGS: compare-preset-legs.mjs refuses a pair
// that does not bind (oldest turn present at keep, absent at drop, exactly one history message between
// them) and refuses a leg that did not start from the captured `preSend`. Nothing about a wrong pair can
// pass silently; it fails with the guard's name instead of being assumed away.
//
// Usage: node capture-preset.mjs --base-url http://127.0.0.1:8127 [--out <path>]

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { PRESET_FIXTURE, applyPresetKit, presetSpec } from './preset-kit.mjs';

const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

function argument(name, fallback) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

const baseURL = argument('--base-url', process.env.CAPTURE_BASE_URL ?? 'http://127.0.0.1:8127');
const outPath = path.resolve(argument('--out', PRESET_FIXTURE));

// The pinned count of this body is `openai/count#llama#simple` in
// tests/oracle/sillytavern-1.19.0-tokenizers.json (`token_count: 7`). It is re-asked HERE so the
// fixture records that this server really tokenizes rather than guesstimates: a cold or missing
// tokenizer tree answers a different number on both legs, and the comparator refuses to compare.
const TOKENIZER_ANCHOR = {
    model: 'llama',
    body: [{ role: 'user', content: 'Hello, world!' }],
    pinnedCount: 7,
};

const spec = presetSpec();
const browser = await chromium.launch();
const page = await browser.newPage();
EMPTY
const consoleErrors = [];
page.on('pageerror', error => consoleErrors.push(String(error.message ?? error).slice(0, 200)));

// The dry assembly is a frontend function; it reads settings, the chat and the extension prompts and
// returns the assembled message list without any provider call. It is re-entered once per candidate
// context by `assembleAt`, so every probe of the trimmer is the same code path the send uses.
async function assembleAt(maxContext) {
    return page.evaluate(async ({ maxContext, oldestMarker, historyMarker }) => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        // A dry run returns before the fetch (script.js:5320), so no provider is needed; the status
        // check is a user-facing setting and would otherwise refuse a send in this offline capture.
        if ('bypass_status_check' in openai.oai_settings) {
            openai.oai_settings.bypass_status_check = true;
        }
        openai.oai_settings.openai_max_context = maxContext;
        // The prompt manager reports a refused assembly (a mandatory prompt that does not fit) through
        // this field instead of throwing, so it is cleared and read per probe: a stale value would make
        // one probe's diagnosis the next probe's.
        if (openai.promptManager) {
            openai.promptManager.error = null;
        }
        const seen = [];
        const handler = data => seen.push(data);
        script.eventSource.on(script.event_types.GENERATE_AFTER_DATA, handler);
        let failure = null;
        try {
            await script.Generate('normal', {}, true);
        } catch (error) {
            failure = String(error?.message ?? error).slice(0, 300);
        } finally {
            script.eventSource.removeListener(script.event_types.GENERATE_AFTER_DATA, handler);
        }
        const prompt = seen.length ? seen[seen.length - 1]?.prompt : null;
        const messages = Array.isArray(prompt) ? prompt : [];
        const text = message => {
            const content = message?.content;
            if (typeof content === 'string') return content;
            if (Array.isArray(content)) return content.map(part => (typeof part === 'string' ? part : part?.text ?? '')).join('\n');
            return '';
        };
        const index = messages.findIndex(message => text(message).includes(oldestMarker));
        // HOW MANY HISTORY MESSAGES SURVIVED. This is the count the boundary is about: the TOTAL message
        // count also moves when the frontend drops its own example/world-info messages at a tight
        // budget, which is how run 40073802369 recorded keep=15 and drop=17 with the wrong pair.
        const historyMessages = messages.filter(message => text(message).includes(historyMarker)).length;
        return {
            maxContext,
            failure,
            promptManagerError: String(openai.promptManager?.error ?? '') .slice(0, 200) || null,
            assemblyCount: seen.length,
            messageCount: messages.length,
            historyMessages,
            oldestIndex: index,
            roles: messages.map(message => message?.role ?? null),
            firstMessageText: text(messages[0] ?? {}).slice(0, 120),
        };
    }, { maxContext, oldestMarker: spec.history[0].text.slice(0, 40), historyMarker: spec.markers.history });
}

EMPTY

EMPTY

// ---------------------------------------------------------------------------------------------
// PAGE INSTRUMENTATION. A probe that reports "no request arrived" cannot say WHICH of three things
// happened: the click never started a generation (a frontend guard), a generation started but the page
// never issued its generate request (or the server answered it non-2xx), or a page error killed the
// handler. Run 40077240xxx's first probe reported exactly that and nothing more, so every probe now
// records the page's own console, its page errors, the requests IT issued (method + path only, never an
// origin: a committed artefact must not carry a host) and the frontend's own state before and after the
// click.
// ---------------------------------------------------------------------------------------------
const pageLog = { console: [], errors: [], requests: [], responses: [] };
function installInstrumentation(target) {
    target.on('console', message => {
        pageLog.console.push({ type: message.type(), text: String(message.text()).slice(0, 240) });
    });
    target.on('pageerror', error => {
        const text = String(error?.message ?? error).slice(0, 240);
        pageLog.errors.push(text);
        consoleErrors.push(text);
    });
    const note = (request, extra = {}) => {
        try {
            const url = new URL(request.url());
            pageLog.requests.push({ method: request.method(), path: url.pathname + url.search, ...extra });
        } catch {
            pageLog.requests.push({ method: request.method(), path: 'non-url', ...extra });
        }
    };
    target.on('request', request => note(request));
    target.on('requestfailed', request => note(request, { failed: String(request.failure()?.errorText ?? 'failed').slice(0, 120) }));
    target.on('response', response => {
        try {
            const url = new URL(response.url());
            if (!url.pathname.endsWith('/chat-completions/generate')) return;
            const entry = { status: response.status(), path: url.pathname };
            pageLog.responses.push(entry);
            // A non-2xx body names which branch refused; read it after recording the status so a body
            // that is slow to arrive cannot hide the status.
            if (!response.ok()) {
                response.text().then(body => { entry.bodyHead = String(body).slice(0, 200); }, () => {});
            }
        } catch {
            // a non-URL response cannot be attributed; nothing to record
        }
    });
}
installInstrumentation(page);

// bootScenario gives every probe a FRESH PAGE with the scenario applied, which removes the whole class
// of "dirty state after N sends" failures: the chat, the author's note, the world info, the samplers and
// custom_url are re-established by the same code on every probe. `includeTypedTurn` is true only for the
// dry pre-scan, which must assemble the same list a send produces (a send appends the typed turn itself).
async function bootScenario({ includeTypedTurn }) {
    await page.goto(`${baseURL}/`);
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 120000 });
    const applied = await page.evaluate(applyPresetKit, spec);
    const state = await page.evaluate(async ({ send, customModel, peerOrigin, includeTypedTurn }) => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        const mainApiControl = document.querySelector('#main_api');
        if (mainApiControl) {
            mainApiControl.value = 'openai';
            mainApiControl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        openai.oai_settings.chat_completion_source = 'custom';
        openai.oai_settings.custom_model = customModel;
        // custom_url IS RE-APPLIED ON EVERY BOOT, because a fresh page reloads the persisted settings.
        openai.oai_settings.custom_url = peerOrigin;
        openai.oai_settings.stream_openai = false;
        if ('bypass_status_check' in openai.oai_settings) {
            openai.oai_settings.bypass_status_check = true;
        }
        await new Promise(resolve => setTimeout(resolve, 600));
        if (includeTypedTurn) {
            script.chat.push({
                name: 'Probe User',
                is_user: true,
                is_system: false,
                send_date: '2026-01-01T00:00:00.000Z',
                mes: send,
                extra: {},
            });
        }
        return {
            chatTurns: script.chat.length,
            mainApi: String(script.main_api ?? ''),
            hasMainApiControl: Boolean(mainApiControl),
            source: String(openai.oai_settings.chat_completion_source ?? ''),
            customUrl: String(openai.oai_settings.custom_url ?? ''),
            customModel: String(openai.oai_settings.custom_model ?? ''),
            onlineStatus: String(script.online_status ?? ''),
        };
    }, { send: spec.send, customModel: 'probe-model', peerOrigin: 'http://127.0.0.1:1', includeTypedTurn });
    // CONNECT, THE WAY THE DRIVE DOES. A chat-completion send is silently ignored while
    // `online_status` is 'no_connection', and that status is only set by the frontend's own connection
    // check. `bypass_status_check` is set as well, but run 40077240xxx's first probe reported neither a
    // started send nor a request, and "missing status" is one of the three causes this capture must be
    // able to tell apart -- so it performs the handshake and records the outcome either way.
    const connection = await page.evaluate(async () => {
        const script = await import('./script.js');
        const keyField = document.querySelector('#api_key_custom');
        if (keyField && !keyField.value) {
            keyField.value = 'probe-synthetic-key';
            keyField.dispatchEvent(new Event('input', { bubbles: true }));
            keyField.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const button = document.querySelector('#api_button_openai');
        const connectButtonPresent = Boolean(button);
        if (button) {
            button.click();
        }
        const deadline = performance.now() + 8000;
        let onlineStatus = String(script.online_status ?? '');
        while (performance.now() < deadline && onlineStatus === 'no_connection') {
            await new Promise(resolve => setTimeout(resolve, 250));
            onlineStatus = String(script.online_status ?? '');
        }
        return { connectButtonPresent, keyFieldPresent: Boolean(keyField), onlineStatus };
    });
    state.connection = connection;
    return { applied, state };
}

let exitCode = 1;
try {
    // 1. THE SCENARIO'S FIRST BOOT. Its `applied` report is the one the fixture records; later boots are
    //    per-probe resets and only their failures matter.
    const firstBoot = await bootScenario({ includeTypedTurn: true });
    const applied = firstBoot.applied;
    const preconditions = firstBoot.state;
    const problems = [...(applied.problems ?? [])];

    // 1b. THE DRIVE'S OWN PRE-CONDITIONS. A send appends one user turn before assembly, so the capture
    //     assembles a chat of the same shape or the boundary it measures is not the boundary the drive
    //     reaches. `main_api` is driven through the control a user drives (`#main_api`, assigned by its
    //     change handler), because it is an exported `let` that cannot be assigned from outside.
    const chatTurnsAtBoundary = preconditions.chatTurns;
    if (preconditions.mainApi !== 'openai') {
        problems.push(`main_api is ${JSON.stringify(preconditions.mainApi)} after driving #main_api (control present: ${preconditions.hasMainApiControl}); the dry assembly would not take the chat-completion path`);
    }
    if (chatTurnsAtBoundary !== applied.chatTurns + 1) {
        problems.push(`the capture's chat has ${chatTurnsAtBoundary} turns after the typed message, expected ${applied.chatTurns + 1}`);
    }


    // 2. The tokenizer anchor. Read BEFORE the boundary search, because a guesstimating server would
    //    place the boundary somewhere meaningless and the fixture must say so.
    //
    //    THE POST NEEDS THE CSRF TOKEN. Run 40073802369 answered 403 here: the pinned server rejects a
    //    same-origin POST that carries no `X-CSRF-Token`, and a plain `fetch(...)` from the page does not
    //    add one. The frontend's own `getRequestHeaders()` is what every panel request uses (it carries
    //    the token it fetched at load, and the browser adds the session cookie), so the anchor asks the
    //    server the same way the UI does. The failure stays LOUD: an anchor of 7 obtained through any
    //    fallback would be the vacuous evidence doctrine 4 forbids.
    const anchor = await page.evaluate(async anchorBody => {
        const script = await import('./script.js');
        const headers = script.getRequestHeaders();
        const response = await fetch('/api/tokenizers/openai/count?model=llama', {
            method: 'POST',
            headers,
            body: JSON.stringify(anchorBody),
        });
        const csrfHeaderPresent = Object.keys(headers).some(name => name.toLowerCase() === 'x-csrf-token');
        if (!response.ok) {
            return { status: response.status, count: null, csrfHeaderPresent, error: 'the count route did not answer 200' };
        }
        const payload = await response.json();
        return { status: response.status, count: Number(payload?.token_count), csrfHeaderPresent };
    }, TOKENIZER_ANCHOR.body);
    if (anchor.count !== TOKENIZER_ANCHOR.pinnedCount) {
        problems.push(`the tokenizer anchor answered ${JSON.stringify(anchor)}; a server that does not tokenize exactly cannot host a context-boundary measurement`);
    }

    // 3. FIND THE BOUNDARY, AND PROVE IT IS A HISTORY BOUNDARY -- ON THE SEND'S OWN ASSEMBLY.
    //
    //    The trimmer keeps history newest-first and stops at the first message that does not fit
    //    (public/scripts/openai.js:951-1078), so "the OLDEST history turn is present" is monotone in
    //    `openai_max_context` *within the region where only history is being trimmed*. It is not monotone
    //    everywhere (at a tight budget the frontend also drops its own example/world-info messages), and
    //    the TOTAL message count is therefore recorded but never asserted.
    //
    //    WHY THE PAIR COMES FROM THE PRE-SEND ASSEMBLY. Run 40082539457 drove both variants at the pair a
    //    dry bisect had found (4236 kept / 4235 dropped) and BOTH produced the drop shape on BOTH servers
    //    (26 messages, 11 history, oldest absent), because the pair was one token apart and the real send's
    //    assembly costs slightly more than the dry one. The send bisect that replaced it was itself
    //    contradicted by run 40087218275, so the pair is measured here on the pre-send assembly and the
    //    DRIVE proves the binding on both legs (see this file's header).
    const dryLog = [];
    const dryProbes = new Map();
    const dryAt = async context => {
        const key = Number(context);
        if (!dryProbes.has(key)) {
            dryProbes.set(key, await assembleAt(key));
        }
        const result = dryProbes.get(key);
        dryLog.push({
            maxContext: result.maxContext,
            messageCount: result.messageCount,
            historyMessages: result.historyMessages,
            oldestPresent: result.oldestIndex >= 0,
            promptManagerError: result.promptManagerError,
            failure: result.failure,
        });
        return result;
    };
    const low = Math.max(spec.maxTokens + 40, 120);
    const high = Math.max(low + 1, 8192);
    let dryLow = null;
    const atHigh = await dryAt(high);
    if (atHigh.failure) {
        problems.push(`the dry pre-scan failed at max_context=${high}: ${atHigh.failure}`);
    }
    if (atHigh.assemblyCount === 0) {
        problems.push('the dry pre-scan emitted no GENERATE_AFTER_DATA, so nothing was measured');
    }
    if (atHigh.oldestIndex < 0) {
        problems.push(`the oldest history turn is not present even at max_context=${high} (${atHigh.messageCount} messages, ${atHigh.historyMessages} history): the constant prompt block plus the history exceeds any context this scenario can ask for`);
    } else {
        let lo = low;
        let hi = high;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            const result = await dryAt(mid);
            if (result.oldestIndex >= 0) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        dryLow = lo;
    }

    // THE PAIR IS MEASURED ON THE PRE-SEND ASSEMBLY, NOT BY SENDING.
    //
    // The capture used to bisect by DRIVING REAL SENDS against a recording peer: ~10 sends on fresh pages
    // each, and it still could not guarantee the drive would assemble the same list -- run 40087218275
    // measured the capture's own send at max_context 4253 holding 24 messages / 12 history turns while
    // the drive at the SAME context held 26 / 11. The DRIVE is now what proves the pair binds: it runs
    // both variants on both legs, and compare-preset-legs.mjs refuses unless the oldest turn is present at
    // keep, absent at drop, with exactly one history message between them. Paying for that in the capture
    // as well bought nothing the drive does not already assert, so the capture records the state the drive
    // must start from -- settings, kit, tokenizer anchor and `preSend` -- and measures the pair on the
    // pre-send assembly: the same `script.Generate(..., true)` pass the probe uses to read `preSend`, one
    // candidate per step, no provider and no page boot.
    const searchLog = [];
    let keepContext = null;
    let keep = null;
    let drop = null;
    if (dryLow !== null) {
        // Candidates from the pre-scan flip upward, because the drive's real send can fit slightly more
        // than a dry assembly; the first pair that satisfies the HISTORY contract is taken, and the drive
        // refuses by name if it does not bind on either leg.
        for (let candidate = dryLow; candidate <= dryLow + 4; candidate++) {
            const keepProbe = await dryAt(candidate);
            const dropProbe = await dryAt(candidate - 1);
            searchLog.push({
                maxContext: candidate,
                messageCount: keepProbe.messageCount,
                historyMessages: keepProbe.historyMessages,
                oldestIndex: keepProbe.oldestIndex,
                oldestPresent: keepProbe.oldestIndex >= 0,
                failure: keepProbe.failure ?? null,
                kind: 'keep',
            });
            searchLog.push({
                maxContext: candidate - 1,
                messageCount: dropProbe.messageCount,
                historyMessages: dropProbe.historyMessages,
                oldestIndex: dropProbe.oldestIndex,
                oldestPresent: dropProbe.oldestIndex >= 0,
                failure: dropProbe.failure ?? null,
                kind: 'drop',
            });
            if (keepProbe.failure || dropProbe.failure) {
                problems.push(`candidate keep=${candidate}: a pre-send assembly failed (${keepProbe.failure ?? dropProbe.failure}); a failed assembly is not a drop`);
                continue;
            }
            if (keepProbe.oldestIndex < 0 || dropProbe.oldestIndex >= 0) continue;
            const historyDelta = keepProbe.historyMessages - dropProbe.historyMessages;
            if (historyDelta !== 1) {
                problems.push(`candidate keep=${candidate}: the pre-send assembly flips the oldest turn, but the history-message delta against ${candidate - 1} is ${historyDelta} (keep ${keepProbe.historyMessages}, drop ${dropProbe.historyMessages}); that is not a history trim`);
                continue;
            }
            keepContext = candidate;
            keep = keepProbe;
            drop = dropProbe;
            break;
        }
        if (keepContext === null) {
            problems.push('no context separates "the oldest turn is kept" from "it is dropped" by exactly one history message in the PRE-SEND assembly, so the pair would not be a measured boundary. Table (maxContext/total/history/oldestPresent): '
                + searchLog.map(entry => `${entry.maxContext}/${entry.messageCount}/${entry.historyMessages}/${entry.oldestPresent}`).join('; '));
        }
    }

    if (problems.length > 0) {
        console.error('capture-preset FAILED:');
        for (const problem of problems) {
            console.error(`  - ${problem}`);
        }
        console.error(JSON.stringify({ steps: applied.steps, searchLog: searchLog.map(entry => ({ ...entry, firstMessageText: undefined })) }, null, 2));
        process.exitCode = 1;
    } else {
        const fixture = {
            schemaVersion: 1,
            provenance: {
                capturedAt: process.env.CAPTURE_TIMESTAMP ?? new Date().toISOString(),
                server: baseURL.replace(/:\d+$/, ':<port>'),
                pinnedBaseline: 'SillyTavern 1.19.0, commit 06bde939fb1e9c4c8d8641d810f0a916b5bce127',
                uiPath: [
                    '1. getCharacters() + selectCharacterById(0) -- prompt assembly reads characters[this_chid]',
                    '2. character description/personality/scenario/examples set on the bound card and read back',
                    '3. script.chat replaced with the scenario history (greeting + 12 turns) and length asserted',
                    '4. world info built in a local data object through world-info.js createWorldInfoEntry + saveWorldInfo (immediate) and READ BACK with loadWorldInfo (createNewWorldInfo does not populate world_info[name], measured in run 40073802369): one entry at position "after", one at "atDepth" depth 0, then activated',
                    "5. author's note written into chat_metadata (including note_interval=1), typed into #extension_floating_prompt, and pushed through authors-note.js setFloatingPrompt() -- which reads the VALUE FROM THE DOM, not from the metadata; asserted in extension_prompts['2_floating_prompt']",
                    '6. stop strings set on power_user.custom_stopping_strings and read back through getCustomStoppingStrings(4)',
                    '7. samplers, max_tokens and names_behavior set on oai_settings (no prompt-manager dependency)',
                    '8. main/nsfw/jailbreak prompt content set through promptManager.getPromptById(identifier) and read back; order entries asserted enabled',
                    '9. instruct/context template names set to a non-default preset and recorded',
                    '10. THE ASSEMBLY BISECT through script.Generate("normal", {}, true): a pre-scan finds the flip at a wide context, then candidates from that flip upward are tried, and the pair is accepted only if the oldest history turn is present at keep, absent one token lower, and exactly ONE history message differs. This is the pre-send assembly -- the same pass the drive records as preSend -- and it is what the fixture pairs.',
                    '12. POST /api/tokenizers/openai/count?model=llama with the oracle anchor body through the frontend\'s own getRequestHeaders() (the CSRF header a plain fetch lacks, run 40073802369), expected 7',
                ],
                instrumentation: 'every assembly runs on the SAME page state the drive records as preSend (the kit is re-applied, custom_url, samplers and the connect handshake re-asserted), and records the page console, page errors and the requests the page issued (method + path only): an assembly that does not happen is reported with its cause rather than as a missing boundary',
                steps: applied.steps,
                boundaryMethod: 'bisect over openai_max_context on the PRE-SEND assembly (script.Generate(normal, {}, true), the same pass the drive records as preSend): oldest turn present at keep, absent at keep-1, history-message delta exactly 1, searched from the pre-scan flip upward because a real send can fit slightly more than this assembly. NOTHING HERE PROVES THE PAIR BINDS: the drive runs both variants on both legs, and compare-preset-legs.mjs refuses a pair that does not bind or a leg that did not start from the captured preSend. The TOTAL message count is recorded and never asserted, because the frontend also emits/drops its own example and world-info messages with the budget',
                assemblyMode: 'pre-send-assembly',
                note: 'Captured from the pinned frontend with per-step assertions, not hand-assembled. Re-run capture-preset.mjs against the pinned baseline to refresh; the fixture must be byte-identical when nothing upstream changed.',
                consoleErrors,
            },
            capture: {
                spec,
                oaiSettings: applied.oaiSettings,
                powerUser: applied.powerUser,
                prompts: applied.prompts,
                chatTurns: applied.chatTurns,
                // The chat the bisect actually assembled: greeting + history + the message the drive will
                // type. Recorded because it is the list the boundary belongs to.
                chatTurnsAtBoundary,
                drivePreconditions: {
                    mainApi: preconditions.mainApi,
                    mainApiControlPresent: preconditions.hasMainApiControl,
                    source: preconditions.source,
                    customModel: preconditions.customModel,
                },
                tokenizerAnchor: { ...TOKENIZER_ANCHOR, observed: anchor },
                boundary: {
                    oldestMarker: spec.history[0].text.slice(0, 40),
                    // WHICH ASSEMBLY THE PAIR BELONGS TO. The comparator refuses a pair whose value is not
                    // 'real-send', because a dry-measured pair does not bind (run 40082539457).
                    assemblyMode: 'pre-send-assembly',
                    keepContext,
                    dropContext: keepContext === null ? null : keepContext - 1,
                    keepMessages: keep?.messageCount ?? null,
                    dropMessages: drop?.messageCount ?? null,
                    // THE COUNTS THE BOUNDARY IS ABOUT. `historyMessages` is how many history turns
                    // survived; the pair must differ by exactly one. The oldest turn's INDEX is recorded as
                    // context only -- it is not asserted, because the frontend's own message layout around
                    // the history block is not the property under test.
                    keepHistoryMessages: keep?.historyMessages ?? null,
                    dropHistoryMessages: drop?.historyMessages ?? null,
                    keepOldestIndex: keep?.oldestIndex ?? null,
                    dropOldestIndex: drop?.oldestIndex ?? null,
                    // THE BOUNDARY'S CONTRACT, written into the artefact so a reader who later sees the
                    // two TOTALS differ (e.g. 24 at keep and 26 at drop) finds the reason beside the
                    // numbers rather than concluding the pair is broken.
                    contract: {
                        asserted: [
                            'the oldest history turn is present at keepContext and absent at dropContext',
                            'the number of HISTORY turns differs by exactly one across the pair',
                            'the comparator recomputes both from the provider BODY on each leg, never from a probe claim',
                            'the pinned tokenizer anchor (count 7) is answered by both servers and the tokenizer tree resolved',
                        ],
                        historyTurns: { keep: keep?.historyMessages ?? null, drop: drop?.historyMessages ?? null },
                        totalMessages: { keep: keep?.messageCount ?? null, drop: drop?.messageCount ?? null },
                        measuredOn: 'the PRE-SEND assembly at each candidate context -- the same script.Generate(normal, {}, true) pass the drive records as preSend -- not a provider request. The pair is a HYPOTHESIS the drive tests: it runs both variants on both legs and the comparator refuses a pair that does not bind',
                        totalMessagesNotAsserted: 'the TOTAL message count is recorded per probe and is NOT part of the contract. The frontend emits its own example and world-info messages as the budget allows, independently of the trimmer, so the total is not monotone in openai_max_context: the run that produced this fixture measured '
                            + `${drop?.messageCount ?? '?'} total messages holding ${drop?.historyMessages ?? '?'} history turns at max_context ${keepContext === null ? '?' : keepContext - 1}, and `
                            + `${keep?.messageCount ?? '?'} total messages holding ${keep?.historyMessages ?? '?'} history turns at ${keepContext ?? '?'}. Requiring the total to grow rejects exactly the boundaries whose history contract holds (it rejected this pair in the previous capture), which is why it is recorded and not asserted`,
                    },
                    dryPreScanFlip: dryLow,
                    // THE STATE EACH VARIANT MUST START FROM. The drive reads the same three values at its
                    // own click and the comparator refuses a variant that differs, naming the numbers.
                    //
                    // `chatTurns` is the length BEFORE the typed turn is appended -- the state the probe's
                    // own pre-send pass sees (`script.chat.length` after the kit has built the chat and
                    // before the composer is sent). The capture used to read it off a real send; with the
                    // send bisect gone it is `applied.chatTurns`, which the kit asserted and which is
                    // exactly what the drive's kit will report.
                    preSend: {
                        chatTurns: applied.chatTurns,
                        dropChatTurns: applied.chatTurns,
                        outgoingText: spec.send,
                    },
                    // THE BRACKET THE SEND BISECT ACTUALLY SEARCHED. The pre-scan flip is recorded as a
                    // HINT only: run 40085109802 measured the send's flip BELOW the dry flip (every probe
                    // from 4254 upward kept the turn), so nothing is derived from it.
                    bracket: bracket ?? null,
                    dryPreScan: dryLog.map(entry => ({
                        maxContext: entry.maxContext,
                        messageCount: entry.messageCount,
                        historyMessages: entry.historyMessages,
                        oldestPresent: entry.oldestPresent,
                        promptManagerError: entry.promptManagerError,
                        failure: entry.failure,
                    })),
                    sendLog: searchLog.map(entry => ({
                        maxContext: entry.maxContext,
                        messageCount: entry.messageCount,
                        historyMessages: entry.historyMessages,
                        oldestIndex: entry.oldestIndex,
                        oldestPresent: entry.oldestPresent,
                        promptManagerError: entry.promptManagerError,
                        failure: entry.failure,
                    })),
                },
            },
        };
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await fs.writeFile(outPath, JSON.stringify(fixture, null, 2) + '\n');
        console.log(JSON.stringify({
            out: outPath,
            keepContext,
            dropContext: keepContext === null ? null : keepContext - 1,
            keepMessages: fixture.capture.boundary.keepMessages,
            dropMessages: fixture.capture.boundary.dropMessages,
            tokenizerCount: anchor.count,
            assemblyMode: 'pre-send-assembly',
            dryPreScanFlip: dryLow,
            keepHistoryMessages: keep?.historyMessages ?? null,
            dropHistoryMessages: drop?.historyMessages ?? null,
            probeAssemblies: searchLog.length,
            steps: applied.steps.length,
            errors: consoleErrors.length,
        }));
        exitCode = 0;
    }
} catch (error) {
    console.error(`capture-preset threw: ${String(error?.stack ?? error)}`);
    console.error(JSON.stringify({ consoleErrors }));
} finally {
    await browser.close();
}
process.exit(exitCode);
