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
// WHY A DRY ASSEMBLY AND NOT ARITHMETIC. Summing per-message counts would be a derivation: the pinned
// budget reserves a slot for `new_chat_prompt`, subtracts 2 from every non-full count, and caches by
// message hash (public/scripts/tokenizers.js:872-900). Asking the trimmer itself, once per candidate
// context, makes the observation the thing that is recorded (AGENTS.md rule 4).
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

let exitCode = 1;
try {
    await page.goto(`${baseURL}/`);
    await page.waitForFunction('document.getElementById("preloader") === null', { timeout: 120000 });

    // 1. Apply the scenario, twice-read: `applyPresetKit` reports every step and names every failure.
    const applied = await page.evaluate(applyPresetKit, spec);
    const problems = [...(applied.problems ?? [])];

    // 1b. THE DRIVE'S OWN PRE-CONDITIONS, and the message the drive will TYPE. A send appends one user
    //     turn before assembly, so the capture must assemble a chat of the same shape or the boundary it
    //     measures is not the boundary the drive reaches.
    //
    //     `main_api` is driven through the control a user drives (`#main_api`, assigned by its change
    //     handler), because it is an exported `let` in script.js that cannot be assigned from outside and
    //     a stale value sends the dry assembly down another API's path entirely. The source and model are
    //     set to what the drive will use, so the assembled request is the one the differential compares.
    const preconditions = await page.evaluate(async ({ send, customModel }) => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        const mainApiControl = document.querySelector('#main_api');
        if (mainApiControl) {
            mainApiControl.value = 'openai';
            mainApiControl.dispatchEvent(new Event('change', { bubbles: true }));
        }
        openai.oai_settings.chat_completion_source = 'custom';
        openai.oai_settings.custom_model = customModel;
        openai.oai_settings.stream_openai = false;
        await new Promise(resolve => setTimeout(resolve, 500));
        script.chat.push({
            name: 'Probe User',
            is_user: true,
            is_system: false,
            send_date: '2026-01-01T00:00:00.000Z',
            mes: send,
            extra: {},
        });
        return {
            chatTurns: script.chat.length,
            mainApi: String(script.main_api ?? ''),
            hasMainApiControl: Boolean(mainApiControl),
            source: String(openai.oai_settings.chat_completion_source ?? ''),
            customModel: String(openai.oai_settings.custom_model ?? ''),
        };
    }, { send: spec.send, customModel: 'probe-model' });
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

    // 3. FIND THE BOUNDARY, AND PROVE IT IS A HISTORY BOUNDARY.
    //
    //    The trimmer keeps history newest-first and stops at the first message that does not fit
    //    (public/scripts/openai.js:951-1078), so "the OLDEST history turn is present" is monotone in
    //    `openai_max_context` *within the region where only history is being trimmed*. It is NOT monotone
    //    everywhere: at a tight budget the frontend also drops its own example and world-info messages,
    //    and run 40073802369 measured exactly that -- oldest turn present with 15 total messages at 1100,
    //    absent with 17 at 1099. The TOTAL message count is therefore not a discriminator; the count of
    //    HISTORY messages is, because exactly one of them changes across the boundary.
    //
    //    So: bisect for the smallest context that keeps the oldest turn, then ACCEPT the pair only if the
    //    oldest turn is absent one token lower AND the history-message delta is exactly one. Anything else
    //    is a boundary the scenario cannot support, and it is reported with the table rather than recorded.
    const searchLog = [];
    const probes = new Map();
    const record = result => {
        searchLog.push({
            maxContext: result.maxContext,
            messageCount: result.messageCount,
            historyMessages: result.historyMessages,
            oldestIndex: result.oldestIndex,
            oldestPresent: result.oldestIndex >= 0,
            promptManagerError: result.promptManagerError,
            failure: result.failure,
        });
        return result;
    };
    const probeAt = async context => {
        const key = Number(context);
        if (!probes.has(key)) {
            probes.set(key, await assembleAt(key));
        }
        return record(probes.get(key));
    };
    const low = Math.max(spec.maxTokens + 40, 120);
    const high = Math.max(low + 1, 8192);
    const atHigh = await probeAt(high);
    if (atHigh.failure) {
        problems.push(`the dry assembly failed at max_context=${high}: ${atHigh.failure}`);
    }
    if (atHigh.assemblyCount === 0) {
        problems.push('the dry assembly emitted no GENERATE_AFTER_DATA, so nothing was measured');
    }
    if (atHigh.oldestIndex < 0) {
        problems.push(`the oldest history turn is not present even at max_context=${high} (${atHigh.messageCount} messages, ${atHigh.historyMessages} history): the constant prompt block plus the history exceeds any context this scenario can ask for`);
    }
    let keepContext = null;
    let keep = null;
    let drop = null;
    if (atHigh.oldestIndex >= 0) {
        let lo = low;
        let hi = high;
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2);
            const result = await probeAt(mid);
            if (result.oldestIndex >= 0) {
                hi = mid;
            } else {
                lo = mid + 1;
            }
        }
        // A handful of candidates from the bisect's answer upward, because a pair that lands in a churn
        // band for the HISTORY count is rejected and the next context may sit in a clean one.
        //
        // THE CONTRACT IS THE HISTORY SET, NOT THE TOTAL MESSAGE COUNT. The total is recorded for every
        // probe and is deliberately NOT required to grow, because the frontend's own example and
        // world-info messages come and go with the budget independently of the trimmer. The second
        // capture run of this lane measured it directly at this pair: max_context 4235 -> 26 total
        // messages holding 11 history turns (oldest absent), max_context 4236 -> 24 total messages
        // holding 12 history turns (oldest present). A clause "the total must grow" therefore rejects the
        // one boundary where the history contract holds perfectly, which is exactly what the previous
        // version did. The artefact carries both totals and this reason, so a reader who later sees the
        // totals differ finds the explanation beside the numbers instead of re-deriving it.
        for (let candidate = lo; candidate <= lo + 6; candidate++) {
            if (candidate <= low) continue;
            const keepProbe = await probeAt(candidate);
            const dropProbe = await probeAt(candidate - 1);
            if (keepProbe.oldestIndex < 0 || dropProbe.oldestIndex >= 0) continue;
            const historyDelta = keepProbe.historyMessages - dropProbe.historyMessages;
            if (historyDelta !== 1) {
                problems.push(`candidate keep=${candidate}: the oldest turn flips, but the history-message delta against ${candidate - 1} is ${historyDelta} (keep ${keepProbe.historyMessages}, drop ${dropProbe.historyMessages}); that is not a history trim`);
                continue;
            }
            keepContext = candidate;
            keep = keepProbe;
            drop = dropProbe;
            break;
        }
        if (keepContext === null) {
            problems.push('no context separates "the oldest turn is kept" from "it is dropped" by exactly one history message, so the pair would not be a measured boundary. Search table (maxContext/total/history/oldestPresent): '
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
                    '10. dry assembly through script.Generate("normal", {}, true), bisecting openai_max_context for the smallest context that keeps the oldest history turn, then accepting the pair only if the turn is absent one token lower and exactly ONE history message differs',
                    '11. POST /api/tokenizers/openai/count?model=llama with the oracle anchor body through the frontend\'s own getRequestHeaders() (the CSRF header a plain fetch lacks, run 40073802369), expected 7',
                ],
                steps: applied.steps,
                boundaryMethod: 'bisect over openai_max_context with the pinned frontend dry assembly, then verified: oldest turn present at keep, absent at keep-1, and history-message delta exactly 1. The total message count is recorded but is NOT the discriminator, because the frontend also drops example/world-info messages at a tight budget',
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
                        totalMessagesNotAsserted: 'the TOTAL message count is recorded per probe and is NOT part of the contract. The frontend emits its own example and world-info messages as the budget allows, independently of the trimmer, so the total is not monotone in openai_max_context: the run that produced this fixture measured '
                            + `${drop?.messageCount ?? '?'} total messages holding ${drop?.historyMessages ?? '?'} history turns at max_context ${keepContext === null ? '?' : keepContext - 1}, and `
                            + `${keep?.messageCount ?? '?'} total messages holding ${keep?.historyMessages ?? '?'} history turns at ${keepContext ?? '?'}. Requiring the total to grow rejects exactly the boundaries whose history contract holds (it rejected this pair in the previous capture), which is why it is recorded and not asserted`,
                    },
                    searchLog: searchLog.map(entry => ({
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
