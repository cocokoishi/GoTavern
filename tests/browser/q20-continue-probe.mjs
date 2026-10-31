// Q20 -- CONTINUE PRESERVES EQUALITY (GOAL.md §9; the second verb pair `q20-persistence-probe.mjs` declares in
// `notCompared`).
//
// THE QUESTION, in one sentence: when a user presses Continue on an assistant reply of a SAVED, RELOADED chat, does
// the new text land in pinned's place (same message, in place, or a new message), does the provider request carry
// pinned's ACTUAL continuation mechanism, and does the saved file afterwards hold the same thing -- with no residual
// buffer reaching the next request?
//
// ---------------------------------------------------------------------------------------------------------------
// PINNED'S CONTINUE SEMANTICS, read from the pinned frontend. Every one of these is ASSERTED below; none is assumed.
//
//   entry point     `#option_continue` (public/index.html:8189, title "Continue the last message"), inside the
//                   `#options` flyout whose delegated handler is `$('#options [id]').on('click', ...)`
//                   (public/script.js:11581). The continue branch is :11648-11661:
//                       swipeState == SWIPE_STATE.EDITING                 -> refuse
//                       chat.length - 1 === this_edit_mes_id               -> refuse
//                       is_send_press == false                             -> act
//                       -> Generate('continue', buildOrFillAdditionalArgs())
//                   The in-chat control `#mes_continue` (index.html:8121) is a direct `on('click')` that
//                   re-triggers this one (:11155-11157), so an in-chat press and a menu press are the same verb.
//
//   WHERE THE TEXT GOES -- the answer comes from pinned, not from a preference:
//                   public/script.js:4400     the last message is NOT deleted (the deletion is guarded by
//                                             `type !== 'swipe' && !isImpersonate && ...`, and 'continue' is not in
//                                             that list but the branch additionally excludes it because the earlier
//                                             `isContinue` path keeps the message);
//                   public/script.js:4450-4456 `noAttachTypes` includes 'continue', and the user-message insertion is
//                                             guarded by `textareaText != ''` with type NOT in noAttachTypes -> NO
//                                             new user message is created;
//                   public/script.js:5534     `saveReply({ type: 'appendFinal' })`, whose branch (:6721-6737) does
//                                             `lastMessage.mes = getMessage; lastMessage.extra.reasoning += reasoning`
//                                             -- THE SAME MESSAGE, its text REPLACED by (continuation + reply), and
//                                             its reasoning APPENDED. Chat length is unchanged.
//                   THE PINNED ANSWER IS THEREFORE: continuation of the SAME assistant message, in place. This leg
//                   asserts exactly that and would go red if pinned changed its mind.
//
//   THE PROVIDER MECHANISM -- two mutually exclusive branches, and WHICH one runs is a setting:
//                   public/script.js:4866      `if (isContinue && (chat2.length > 1 || main_api === 'openai')) { cyclePrompt = chat2.shift(); }`
//                   public/script.js:4975-4981  `if (main_api === 'openai' && !cyclePrompt.endsWith(' ')) { cyclePrompt += oai_settings.continue_postfix; ... }`
//                                             (default `continue_postfix: ' '`, openai.js:505; types at :213-218)
//                   public/scripts/openai.js:907-926  `type === 'continue' && cyclePrompt && !continue_prefill`:
//                                             the LAST non-injected message is SPLICED OUT of `messages` and
//                                             re-appended at the END as part of a `continueNudge` collection whose
//                                             seed is `oai_settings.continue_nudge_prompt`
//                                             (`'[Continue your last message without repeating its original content.]'`,
//                                             openai.js:111) -- with the displaced message FIRST and the nudge
//                                             message LAST;
//                   public/scripts/openai.js:1320-1331  `type === 'continue' && continue_prefill`: the OTHER branch
//                                             -- the message to continue is turned into a `continuePrefill` control
//                                             prompt instead, so the nudge is not built at all.
//                   `continue_prefill` defaults to false (openai.js:501), so the NUDGE branch is the default; the leg
//                   READS the setting back from the page and reports which branch the run took, and the comparator
//                   asserts BOTH the branch and the resulting difference -- a "continue is not late" claim that only
//                   compared hashes could be satisfied by a request that carries no nudge at all on both subjects.
//
//   the request     `type: 'continue'` travels in the POST body to /api/backends/chat-completions/generate
//                   (openai.js:2802-2821) but the server's generic OpenAI/Custom body
//                   (src/endpoints/backends/chat-completions.js:2652-2670) has NO `type` member, so the provider sees
//                   the continuation ONLY as the prompt shape.
//
//   the save        NOT `saveChat`. The `appendFinal` branch ends in `saveChatDebounced()` (script.js:7361) and
//                   `setInContextMessages` writes `chat_metadata.lastInContextMessageId` with "No metadata save on
//                   purpose" (:6086-6097). The leg drives the frontend's own `saveChatConditional()` and asserts the
//                   FILE afterwards.
//
// WHY THE REPLY THE PROVIDER GIVES BACK IS A SUFFIX. `startCapturePeer({ replyText })` answers the continue's
// request with a string that BEGINS with the text it just received for that message, so "the file holds
// continuation + reply, in one message" is checkable against the content and not only against a hash. A peer that
// answered a full unrelated reply would let a REPLACEMENT (pinned's actual branch) look identical to an APPEND.
//
// WHAT THIS DOES NOT PROVE: streaming (Q19) -- the continuation path in streaming mode goes through a different
// branch (`streamingProcessor.firstMessageText = ''`, script.js:5388-5404) and is not driven here; a real provider
// (rule 22); group chats; auto-continue (`power_user.auto_continue`, script.js:5711-5790), which is a different
// trigger that happens to call the same control.
//
// Usage (GoTavern leg):  GOTAVERN_BINARY=... node q20-continue-probe.mjs --data-root <tree> --character <name> \
//                          --report <json>
// Usage (pinned leg):    node run-against-pinned.mjs q20-continue-probe.mjs -- --data-root <tree> \
//                          --data-chat <the tree the GoTavern leg wrote> --character <name> --report <json>
// Usage (self-check):    node q20-continue-probe.mjs --self-check

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachUrlRecorder } from './url-recorder.mjs';
import { ensurePinnedExtensionInstalled } from './install-pinned-extension.mjs';
import { pinnedExtension } from './pinned-extensions.mjs';
import {
    chatCarrying, configureConnection, openCharacter, openPage, pressContinue,
    readChatFiles, readProcessCommands, resolveRoster, saveConditional, sendTurn, settleQuiet, silenceAndObserve, waitForReply,
    readReadiness,
} from './q20-persistence-drive.mjs';
import { argumentValue, bootSubject, freePort, repoRoot, startCapturePeer, waitForServer } from './q20-leg-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

export const PINNED_PRECONDITIONS = [
    { name: 'entry: the continue control is a #options child', file: 'public/index.html', pattern: /<a id="option_continue" title="Continue the last message"/, why: 'the control this leg presses' },
    { name: 'entry: #options delegates clicks to its [id] children', file: 'public/script.js', pattern: /\$\('#options \[id\]'\)\.on\('click'/, why: 'without this a click on the control reaches no handler' },
    { name: 'entry: the continue branch calls Generate(\'continue\')', file: 'public/script.js', pattern: /Generate\('continue', buildOrFillAdditionalArgs\(\)\)/, why: 'the verb itself' },
    { name: 'entry: the in-chat button re-triggers the menu control', file: 'public/script.js', pattern: /\$\('#mes_continue'\)\.on\('click', function \(\) \{\s*\n\s*\$\('#option_continue'\)\.trigger\('click'\);/, why: 'the second entry a user has' },
    { name: 'placement: appendFinal sets the LAST message\'s text', file: 'public/script.js', pattern: /lastMessage\.mes = getMessage;/, why: 'continue is a continuation of the same message, not a new one' },
    { name: 'placement: appendFinal APPENDS reasoning', file: 'public/script.js', pattern: /lastMessage\.extra\.reasoning \+= reasoning;/, why: 'metadata must be compared, and an append differs from a replace' },
    { name: 'placement: non-streaming continue saves via appendFinal', file: 'public/script.js', pattern: /saveReply\(\{ type: 'appendFinal', getMessage, title, swipes, reasoning, imageUrls, reasoningSignature \}\)/, why: 'where the placement is decided' },
    { name: 'mechanism: the nudge branch splices the last message out', file: 'public/scripts/openai.js', pattern: /if \(type === 'continue' && cyclePrompt && !oai_settings\.continue_prefill\)/, why: 'the default branch this leg must observe' },
    { name: 'mechanism: the nudge is the continue_nudge_prompt', file: 'public/scripts/openai.js', pattern: /content: substituteParamsExtended\(oai_settings\.continue_nudge_prompt, \{ lastChatMessage: String\(cyclePrompt\)\.trim\(\) \}\)/, why: 'the exact instruction the model receives' },
    { name: 'mechanism: the prefill branch displaces the message instead', file: 'public/scripts/openai.js', pattern: /if \(type === 'continue' && oai_settings\.continue_prefill && messages\.length\)/, why: 'the branch that replaces the nudge' },
    { name: 'mechanism: cyclePrompt is shifted off the history', file: 'public/script.js', pattern: /if \(isContinue && \(chat2\.length > 1 \|\| main_api === 'openai'\)\) \{\s*\n\s*cyclePrompt = chat2\.shift\(\);/, why: 'which message the nudge is about' },
    { name: 'mechanism: cyclePrompt gets the postfix when it does not end with a space', file: 'public/script.js', pattern: /if \(main_api === 'openai' && !cyclePrompt\.endsWith\(' '\)\) \{/, why: 'the byte the provider receives at the tail of the history' },
    { name: 'save: continue ends in saveChatDebounced, not saveChat', file: 'public/script.js', pattern: /export function saveChatDebounced\(\)/, why: 'why the leg must drive saveChatConditional itself' },
];

async function selfCheck() {
    const reference = process.env.GOTAVERN_REFERENCE
        ?? (await fs.stat(path.join(repoRoot, '.reference', 'SillyTavern')).then(() => path.join(repoRoot, '.reference', 'SillyTavern'), () => null))
        ?? (await fs.stat(path.resolve(repoRoot, '..', 'SillyTavern')).then(() => path.resolve(repoRoot, '..', 'SillyTavern'), () => null));
    if (!reference) {
        console.error('SELF-CHECK REFUSED: no pinned SillyTavern checkout (set GOTAVERN_REFERENCE, or provide .reference/SillyTavern)');
        process.exit(2);
    }
    const problems = [];
    for (const precondition of PINNED_PRECONDITIONS) {
        let body = '';
        try {
            body = await fs.readFile(path.join(reference, precondition.file), 'utf8');
        } catch (error) {
            problems.push(`${precondition.name}: cannot read ${precondition.file} (${String(error?.message ?? error)})`);
            continue;
        }
        if (!precondition.pattern.test(body)) problems.push(`${precondition.name}: ${precondition.file} no longer matches ${precondition.pattern} -- ${precondition.why}`);
    }
    if (problems.length > 0) {
        console.error(`SELF-CHECK FAILED: ${problems.length} pinned precondition(s) moved:`);
        for (const problem of problems) console.error(`  - ${problem}`);
        process.exit(1);
    }
    console.log(`self-check ok: ${PINNED_PRECONDITIONS.length} pinned preconditions hold in ${reference}`);
    console.log(PINNED_PRECONDITIONS.map(entry => `  ${entry.name}`).join('\n'));
}

if (process.argv.includes('--self-check')) {
    await selfCheck();
    process.exit(0);
}

// ---------------------------------------------------------------------------------------------------------------
// THE LEG
// ---------------------------------------------------------------------------------------------------------------

const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

const external = Boolean(process.env.PROBE_BASE_URL);
const dataRoot = path.resolve(argumentValue(process.argv, '--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-q20-continue-')));
const sourceChatTree = argumentValue(process.argv, '--data-chat', process.env.Q20_DATA_CHAT ?? null);
const reportPath = path.resolve(argumentValue(process.argv, '--report', path.join(here, 'q20-continue-leg.json')));

const installed = await ensurePinnedExtensionInstalled(dataRoot, pinnedExtension('tavern-helper'));
if (sourceChatTree) {
    await fs.cp(path.resolve(sourceChatTree), dataRoot, { recursive: true, force: true });
}

const port = await freePort();
const boot = await bootSubject({ argv: process.argv, dataRoot, port, external });
const baseURL = boot.baseURL;
const MARKERS = {
    first: 'Q20_CONTINUE_FIRST_TURN_MARKER',
    second: process.env.Q20_CONTINUE_SECOND_MARKER ?? 'Q20_CONTINUE_SECOND_TURN_MARKER',
    // The peer's continuation marker. The reply to the continue is `CONTINUATION(<text>)`: a string that is only
    // correct if the page sent the message it is continuing, which makes "one message, grown" checkable by content.
    continuation: 'Q20_CONTINUATION_APPENDED',
};

// CONDITION 5, PROVIDE-DO-NOT-USE: `--wire honour|json|sse`, default `honour` (SSE to a `stream: true` request).
// Declared before `report` (which carries it) because a `const` read above its declaration is a temporal-dead-zone
// ReferenceError, which `node --check` cannot see.
const wireMode = argumentValue(process.argv, '--wire', process.env.Q20_WIRE ?? 'honour');

const report = {
    schemaVersion: 1,
    verb: 'continue',
    question: 'When a user continues the last reply of a saved, reloaded chat, where does the text land, what does the model receive, what does the file hold afterwards, and does the next request carry residual state?',
    subject: external ? 'pinned' : 'gotavern',
    baseURL,
    dataRoot,
    sourceChatTree: sourceChatTree ? path.basename(path.resolve(sourceChatTree)) : null,
    extension: { installedRevision: installed.revision, source: installed.source },
    markers: MARKERS,
    wireMode,
    steps: [],
    pageRequests: [],
    chatRequests: [],
    peerRequests: [],
    navigations: [],
    pageErrors: [],
    consoleDiagnostics: [],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
}

if (boot.bootRefusal) report.failure = `leg-refused: ${boot.bootRefusal}`;

// THE PEER ANSWERS A CONTINUATION, NOT A REPLY -- for the one request that is the continue. The continuation is
// registered as an ORDINAL (the next completion the peer answers) because the answer has to be a function of WHICH
// request it is, and the leg cannot know the ordinal until it has counted the turns it drove; `replyText` reads a
// slot the leg fills in immediately before pressing the control.
// DECLARED BEFORE THE PEER, because `replyText` closes over it. A `const` referenced above its declaration is a
// temporal-dead-zone ReferenceError, and `node --check` cannot see it -- the same TDZ class this file already
// recorded for `wireMode`. It happens to be safe today only because the closure runs after this line executes; that
// is an ordering coincidence, not a guarantee, and the comment is cheaper than the alternative.
const peerState = { continuationOrdinal: null, continuationTail: null, continuationsServed: 0 };
const peer = await startCapturePeer({
    wire: wireMode,
    // THE CONTINUATION IS A SUFFIX, and the shape matters: `appendFinal` makes the message `existingText +
    // continuation`, so the reply MUST NOT repeat the reply it extends and MUST NOT re-state the first turn:
    //     before: "Q20_REPLY_2"   after: "Q20_REPLY_2 Q20_CONTINUATION_APPENDED_1"
    // `continuationTail` is appended after the number so a leg can name which continuation it was if it needs to.
    //
    // THE NUMBER IS THE CONTINUATION COUNT, NOT THE ARRIVAL ORDINAL -- AND THAT IS A MEASURED CORRECTION.
    //
    // It used to be `${MARKERS.continuation}_${counterpart}`, where `counterpart` is the peer's ARRIVAL ORDINAL of
    // the chat/completions request. That ordinal is LEG-SPECIFIC BY CONSTRUCTION, because the two legs have
    // different ROLES: the GoTavern leg is the PRODUCER (it starts from a 2-line chat, drives the two setup turns,
    // so its continue is arrival 3 -> `_3`) while the pinned leg is the CONSUMER (handed the finished handoff tree,
    // it correctly finds the turns already present and skips them, so its continue is arrival 1 -> `_1`). The
    // marker is persisted into the chat, so it travels inside the NEXT request's messages array, and
    // `compare-q20-continue-legs.mjs` `nextRequestClean` then compared two bodies that differ by ONE BYTE.
    //
    // MEASURED, and reproduced locally rather than inferred: `Browser differential` 40837309332 on 292905f failed
    // with `failedGuards: ["nextRequestClean"]`; the two next-turn bodies were both 4444 B with their FIRST AND ONLY
    // difference at offset 4250 -- `Q20_CONTINUATION_APPENDED_3` on GoTavern against `Q20_CONTINUATION_APPENDED_1`
    // on pinned. The guard was UNSATISFIABLE BY CONSTRUCTION and reported a product mismatch where the two subjects
    // in fact agreed: both grew the same message in place with the continuation text their own peer gave them.
    //
    // `q20-leg-runtime.mjs:137-141` states the design this restores: "by default BOTH subjects receive the SAME text
    // (`Q20_REPLY_1`, `Q20_REPLY_2`, ...)". Counting continuations keeps that promise, keeps the marker distinct
    // from a plain `Q20_REPLY_N`, and still makes a leg that fires the continuation branch twice visible (the second
    // continuation would be `_2`, and a leg whose count differs from the other's shows up as a real difference). The
    // arrival ordinal is not lost: every request carries its own `index`/position in the leg report.
    replyText: (ordinal, counterpart) => {
        if (peerState.continuationOrdinal !== null && peerState.continuationOrdinal === counterpart) {
            peerState.continuationsServed += 1;
            return `${MARKERS.continuation}_${peerState.continuationsServed}${typeof peerState.continuationTail === 'string' ? peerState.continuationTail : ''}`;
        }
        return `Q20_REPLY_${counterpart}`;
    },
});
const peerBase = `http://127.0.0.1:${peer.port}/v1`;

let browser;
try {
    if (boot.bootRefusal) throw new Error(boot.bootRefusal);
    await waitForServer(`${baseURL}/version`);
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 300)));
    page.on('console', message => {
        const type = message.type();
        if (!['error', 'warning', 'trace'].includes(type)) return;
        const location = message.location();
        report.consoleDiagnostics.push({ type, text: String(message.text()), location: location?.url ? `${location.url}:${location.lineNumber}` : null });
        if (report.consoleDiagnostics.length > 200) report.consoleDiagnostics.shift();
    });
    page.on('framenavigated', frame => {
        if (frame !== page.mainFrame()) return;
        report.navigations.push({ url: frame.url(), at: new Date().toISOString() });
    });
    await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
    const recorder = attachUrlRecorder(page);
    const chatRequestLog = () => recorder.requests
        .filter(entry => /\/api\/chats/.test(entry.pathAndQuery ?? ''))
        .map(entry => ({ method: entry.method, path: entry.pathAndQuery, status: entry.status, contentType: entry.contentType, byteLength: entry.byteLength }));

    const ready = await openPage(page, baseURL);
    step('page-loaded', ready === true, `settingsReady=${ready}; readiness=${JSON.stringify(await readReadiness(page))}`);
    step('page-no-errors', report.pageErrors.length === 0, JSON.stringify(report.pageErrors));
    const configured = await configureConnection(page, { url: peerBase, model: 'probe-model' });
    report.configured = configured;
    step('connection-configured', configured.source === 'custom' && String(configured.url ?? '').includes(String(peer.port)), JSON.stringify(configured));
    // THE MECHANISM SETTING, asserted rather than assumed: `continue_prefill` false means the NUDGE branch is the one
    // under test, and `continue_prefill` true would be a different request entirely.
    step('mechanism-setting-read', configured.continuePrefill === false && String(configured.continueNudgePrompt ?? '').length > 0,
        JSON.stringify({ continuePrefill: configured.continuePrefill, continueNudgePrompt: configured.continueNudgePrompt, continuePostfix: configured.continuePostfix }));

    // THE CARD NAME -- same resolution as the regenerate probe, same measured reasons (runs 40452820868 and
    // 40454879293): `--character <name>` from a caller who has one, `--character auto` to ask the PAGE's own roster,
    // and a REFUSAL when the roster is empty or ambiguous. `auto` reads `script.characters`, never a DOM node.
    const characterArgument = argumentValue(process.argv, '--character', process.env.Q20_CHARACTER_NAME ?? null);
    if (characterArgument === 'auto') {
        const roster = await resolveRoster(page);
        report.rosterResolution = roster;
        step('roster-resolved', roster.count === 1, JSON.stringify(roster));
        if (roster.count !== 1) {
            report.failure = report.failure ?? `roster-resolved: the page shows ${roster.count} card(s) (${JSON.stringify(roster.names)}); an auto-resolved card needs exactly one`;
            throw new Error(`roster-resolved: ${roster.count} card(s)`);
        }
    }
    const expectedCharacter = characterArgument === 'auto' ? report.rosterResolution?.names?.[0] ?? null : characterArgument;
    const opened = await openCharacter(page, expectedCharacter);
    report.characterOpen = opened;
    step('character-opened', opened?.opened === true, JSON.stringify(opened));
    const openedContext = await page.evaluate(async () => {
        const context = window.SillyTavern.getContext();
        const chat = context.chat ?? [];
        // `characterName` IS RECORDED HERE, and run 40559516968 is why: the continue leg drove all 24 steps green and
        // the pinned leg never started, because the workflow reads `characterOpen.characterName` with a fallback to
        // `openedContext.characterName` and THIS PROBE WROTE NEITHER. The regenerate probe records the same field and
        // resolved `Seraphina` on the same run -- so the fallback I added worked exactly as designed on the one probe
        // that carried the field, and could not work on the one that did not.
        //
        // The name is taken through the CONTEXT's `characterId` and the roster, the reader the product uses
        // (st-context.js:123), not from a module binding captured before the click -- rule 90's lesson.
        const chid = context.characterId ?? null;
        const roster = context.characters ?? [];
        return {
            chatId: context.chatId ?? null,
            chatLength: chat.length,
            thisChid: chid,
            characterName: chid !== null && chid !== undefined ? (roster[chid]?.name ?? null) : null,
            // THE PAGE'S OWN MESSAGES, so the setup gate can answer "does the open chat carry the predecessor" even
            // when the chat has never been saved to disk (run 40603103596: a fresh chat has no file, and a gate that
            // reads only files gets `null` while the other subject gets `true`).
            chatAfterSelection: chat.map(entry => ({ mes: String(entry?.mes ?? ''), is_user: entry?.is_user === true })),
        };
    });
    report.openedContext = openedContext;

    // THE CHAT IS SELECTED EXPLICITLY WHEN THE CALLER NAMES ONE -- the SAME block the regenerate probe carries, and it
    // was MISSING here until run 40574536117 measured the cost.
    //
    // MEASURED: the workflow resolved and passed `--chat-id "Seraphina - 2023-5-12 @21h 32m 29s 224ms"`, the pinned
    // leg drove 23 steps green WITHOUT a `chat-selected` step, and the comparator then reported `sameChat`,
    // `sameMessageGrown`, `nudgeAssemblesLast`, `nodeEqualsGoContinue` and `nextRequestClean` red. THIS PROBE HAD NO
    // `--chat-id` HANDLING AT ALL -- it did not read the argument and never called the selector -- so the argument was
    // accepted on the command line and silently ignored, and the pinned leg continued whatever chat the card resumed.
    //
    // That is the producer/consumer split again, one layer up: the workflow's consumer was fixed and its producer read
    // nothing. A click on the card opens the card's LAST-USED chat, which in the copied tree is an 11-message chat from
    // an earlier run, while the GoTavern leg sat on its own five-message chat.
    //
    // `openCharacterChat(file_name)` (pinned script.js:7744) is the product's own entry, and the selection is READ BACK
    // through `getContext()` -- rule 58 -- so a mismatch fails BY NAME rather than proceeding on a different chat.
    const wantedChatId = argumentValue(process.argv, '--chat-id', process.env.Q20_CHAT_ID ?? null);
    if (wantedChatId) {
        const selected = await page.evaluate(async target => {
            const script = await import('./script.js');
            if (typeof script.openCharacterChat !== 'function') {
                return { requested: target, selected: false, reason: 'openCharacterChat is not exported by the pinned frontend' };
            }
            const before = window.SillyTavern.getContext();
            const beforeId = before.chatId ?? null;
            await script.openCharacterChat(target);
            const settle = Date.now() + 30000;
            while (Date.now() < settle) {
                const now = window.SillyTavern.getContext();
                if (String(now.chatId ?? '') === String(target) && (now.chat ?? []).length > 0) {
                    return { requested: target, selected: true, chatId: String(now.chatId), chatLength: (now.chat ?? []).length, beforeId: String(beforeId ?? '') };
                }
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            const final = window.SillyTavern.getContext();
            return { requested: target, selected: false, chatId: final.chatId ?? null, chatLength: (final.chat ?? []).length, beforeId: String(beforeId ?? ''), reason: 'the product never reported the requested chat id' };
        }, wantedChatId);
        report.chatSelection = selected;
        step('chat-selected', selected.selected === true && String(selected.chatId ?? '') === String(wantedChatId),
            JSON.stringify(selected));
        report.openedContext = { ...report.openedContext, chatIdAfterSelection: selected.chatId ?? null, chatLengthAfterSelection: selected.chatLength ?? null };
        // The PRECONDITION IS RE-EVALUATED ON THE SELECTED CHAT: the length read before selection belonged to whatever
        // chat the card happened to resume, and the steps below need the count of the conversation actually in use.
        report.openedContext.chatLength = selected.chatLength ?? report.openedContext.chatLength;
        // THE MESSAGES TOO, not just the count. `chatAfterSelection` was read BEFORE the switch, so on a leg that
        // selects a chat it describes the previous conversation. The setup gate reads this array when no file on disk
        // matches, so stale messages there would answer the question about the wrong chat.
        report.openedContext.chatAfterSelection = await page.evaluate(() => {
            const context = window.SillyTavern.getContext();
            return (context.chat ?? []).map(entry => ({ mes: String(entry?.mes ?? ''), is_user: entry?.is_user === true }));
        });
    } else {
        report.chatSelection = { requested: null, selected: null, reason: 'no --chat-id was supplied; the leg accepted the chat the card resumed' };
    }
    // ---- THE CHAT MUST BE ON DISK BEFORE THE SETUP GATE READS IT ------------------------------------
    // Run 40603103596 and again 40761754633 measured the same divergence: the GoTavern leg opened the
    // card, its chat was EMPTY and had never been saved, so `readChatFiles` matched nothing, the gate
    // fell back to the page, and `setupDecision` reported `openChat: null` / `carriesPredecessor: false`
    // while the pinned leg read the real handoff file and got `true`. `sameSetup` then refused -- correctly,
    // because a leg that drove two setup turns cannot be compared to one that skipped them (measured:
    // gotavern 4 completions, pinned 2).
    //
    // The gate's own comment already concludes which side was wrong ("the PINNED leg was right and the
    // GOTAVERN leg was asking a file that was not there"), so the fix is to make the file EXIST, not to
    // teach the gate a new answer. The rejected alternative -- treating an unsaved chat as a definite
    // `false` and driving pinned from the same unsaved state -- would have removed the experiment in
    // order to make the comparison agree, which is what docs/surfaces/continue.md forbids.
    //
    // NO ASSERTION IS RELAXED. The gate keeps every branch it had; this only ensures the state it reads
    // is the state the pinned leg also reads. `sameSetup` can still refuse a real asymmetry, and the
    // mutation below the step is what demonstrates that.
    report.preGateSave = await saveConditional(page);
    // saveConditional returns { ok: true } or { ok: false, error } (q20-persistence-drive.mjs:973).
    step('pre-gate-save-succeeded', report.preGateSave?.ok === true, JSON.stringify(report.preGateSave ?? null));

    // 1. BRING THE CHAT TO (greeting, user, assistant, user, assistant) -- the same five-message shape the
    // regenerate leg uses, so the two verbs are measured on one conversation and not on two.
    const silenced = await silenceAndObserve(page);
    report.silenced = silenced;
    step('frontend-observers-installed', silenced.processCommandsWrapped === true, JSON.stringify(silenced));
    // THE SETUP DECISION IS MADE FROM THE CHAT THAT IS ACTUALLY OPEN, AND FROM THE SAME RULE ON BOTH SUBJECTS.
    //
    // Run 40597042866 measured what a LENGTH threshold does when the two subjects reach this point with different
    // histories:
    //     gotavern openedContext.chatLength 0  -> the gate ran the two setup turns (4 completions)
    //     pinned   chatSelection.chatLength 5  -> the gate SKIPPED them (2 completions)
    // so the pinned leg sent its continuation first, with no preceding turn, and the comparator reported
    //     nudgeAssemblesLast: "pinned: the continued request has no messages array"
    //     nodeEqualsGoContinue: "one of the subjects produced no continued request"
    // -- a difference produced entirely by which subject had already been set up.
    //
    // `chatLength` was never the right input: it is a proxy for "have the two turns been driven", and it reads 0 on a
    // fresh chat, 5 after the setup, and anything at all on a tree that arrived with history. The question the leg
    // actually needs answered is "does THIS chat already carry the leg's own predecessor marker", which is the same
    // question on both subjects and is answered from the file on disk rather than from a page counter.
    //
    // The chat is identified by the id the page reports NOW (after `chat-selected`, when one was requested).
    //
    // AND THE FILE MAY NOT EXIST YET ON A FRESH CHAT, which run 40603103596 measured: the GoTavern leg had just opened
    // the card, its chat was EMPTY and had never been saved, so `readChatFiles` returned nothing that matched and
    // `setupDecision.openChat` was `null` -- `carriesPredecessor: false` -- while the pinned leg read the real 6-line
    // file and got `true`. Both legs "answered the question", from one source that existed and one that did not, and
    // `sameSetup` then (correctly) refused. The PINNED leg was right and the GOTAVERN leg was asking a file that was
    // not there.
    //
    // The state the gate needs is "does the OPEN CHAT already carry the predecessor", and an UNSAVED, EMPTY chat cannot
    //: the marker is a message, and a chat with no messages has none. So an absent file is a DEFINITE answer (false),
    // not an unknown -- but it is recorded distinctly (`source: 'no-file'` vs `'file'`) so the two ways of reaching
    // "false" stay distinguishable in the artefact.
    const openChatId = String(report.openedContext?.chatIdAfterSelection ?? report.openedContext?.chatId ?? '');
    const onDisk = await readChatFiles(dataRoot);
    const openChat = onDisk.find(entry => openChatId !== '' && String(entry.file ?? '').includes(openChatId)) ?? null;
    const pageMessages = Array.isArray(report.openedContext?.chatAfterSelection)
        ? report.openedContext.chatAfterSelection
        : null;
    const carriesPredecessor = openChat
        ? (openChat.messages ?? []).some(entry => String(entry?.mes ?? '').includes(MARKERS.second))
        : (pageMessages ?? []).some(entry => String(entry?.mes ?? '').includes(MARKERS.second));
    report.setupDecision = {
        openChat: openChat?.file ?? null,
        source: openChat ? 'file' : (pageMessages ? 'page' : 'no-file-and-no-page-chat'),
        lines: openChat?.lines ?? null,
        messages: openChat ? (openChat.messages ?? []).length : (pageMessages ?? []).length,
        carriesPredecessor,
        openedContextChatLength: report.openedContext.chatLength ?? null,
        filesOnDisk: onDisk.map(entry => `${entry.file}:${entry.lines}`),
        rule: 'the two setup turns are driven only when the open chat does NOT already carry the second-turn marker',
    };
    // DID THE SAVE ACTUALLY PUT THE CHAT WHERE THE GATE LOOKS? Asserted, not assumed. This step is the
    // local verification the fix needs before a dispatch is spent: it fails by name if the chat is still
    // absent from disk, which is the exact condition that produced `openChat: null` on runs 40603103596
    // and 40761754633. It is NOT a guard on the comparison -- it records whether the precondition held.
    step('gate-found-the-chat-on-disk',
        report.setupDecision?.source === 'file',
        JSON.stringify({
            source: report.setupDecision?.source ?? null,
            openChat: report.setupDecision?.openChat ?? null,
            lookupId: openChatId || null,
            filesOnDisk: onDisk.map(entry => entry.file ?? null).slice(0, 6),
        }));
    if (carriesPredecessor !== true) {
        // THE TURN WAITS ON THE PRODUCT'S SETUP STATE AND FAILS BY NAME -- `waitForReply` in the shared drive. See the
        // regenerate probe's note: polling for "the user turn exists" let a leg proceed while the assistant reply had
        // not landed (run 40448869208), and `requireText` is false because the stored reply has empty text on BOTH
        // subjects (40445671791) -- an open fixture finding, carried as `emptyReplyOnBothSubjects`, not a red here.
        for (const [index, turnMarker] of [[0, MARKERS.first], [1, MARKERS.second]]) {
            const sent = await sendTurn(page, index === 0 ? `Q20 continuable first turn ${turnMarker}` : `Q20 continuable second turn ${turnMarker}`);
            report[`send${index + 1}`] = sent;
            const countBefore = peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? '')).length;
            const reply = await waitForReply(page, { timeoutMs: 60000, requireText: false, peerCompletions: countBefore + 1, baseline: sent?.baseline ?? null });
            report[`reply${index + 1}`] = reply;
            step(`turn-${index + 1}-reply-settled`, reply.ok === true, reply.ok === true ? JSON.stringify(reply.state) : JSON.stringify(reply));
            if (!reply.ok) {
                report.failure = report.failure ?? `${reply.name}: ${reply.reading} ${JSON.stringify(reply.state)} peerCompletions=${JSON.stringify(reply.peerCompletions)}`;
                break;
            }
            await saveConditional(page);
            await settleQuiet(page, recorder);
            const files = await readChatFiles(dataRoot);
            const carried = chatCarrying(files, turnMarker) !== null;
            step(`turn-${index + 1}-saved`, carried, files.map(file => `${file.file}:${file.lines}`).join(',') || 'none');
            // THE REPLY, NOT ONLY THE USER TURN (AGENTS rule 80: a weak assertion usually has a twin). The same
            // marker-only predicate existed here and in the regenerate probe; run 40487164548 lost an assistant reply
            // while a marker-only assertion was green. CONTINUE appends to the LAST message, so a leg whose predecessor
            // reply was never persisted would be continuing a different message than the one the other subject
            // continued -- an equality that cannot discriminate.
            const carriedReply = files.some(file => (file.messages ?? []).some(entry => /(?:[A-Z0-9]+_)?Q20_REPLY_\d+/.test(String(entry?.mes ?? ''))));
            step(`turn-${index + 1}-saved-the-reply`, carriedReply,
                JSON.stringify(files.map(file => ({ file: file.file, lines: file.lines, messages: (file.messages ?? []).map(entry => String(entry?.mes ?? '').slice(0, 40)) }))));
            if (!carried) {
                report.failure = report.failure ?? `turn-${index + 1}-saved: the file on disk does not carry ${turnMarker}`;
                break;
            }
        }
    }
    await settleQuiet(page, recorder);
    const beforeContinue = await readChatFiles(dataRoot);
    const preState = await page.evaluate(async () => {
        const script = await import('./script.js');
        const context = window.SillyTavern.getContext();
        const chat = script.chat ?? [];
        const last = chat[chat.length - 1];
        return {
            chatId: context.chatId ?? null,
            chatLength: chat.length,
            lastIsUser: last?.is_user === true,
            lastText: String(last?.mes ?? ''),
            lastExtra: last?.extra ?? null,
            lastSwipesCount: Array.isArray(last?.swipes) ? last.swipes.length : null,
            lastSwipeId: last?.swipe_id ?? null,
            lastSendDate: last?.send_date ?? null,
            isSendPress: script.is_send_press ?? null,
            thisEditMesId: script.this_edit_mes_id ?? null,
            swipeState: script.swipeState ?? null,
            lastInContextMessageId: context.chatMetadata?.lastInContextMessageId ?? null,
        };
    });
    report.preContinue = { page: preState, file: chatCarrying(beforeContinue, MARKERS.second) ?? chatCarrying(beforeContinue, MARKERS.first) };

    // THE HANDOFF IS TAKEN HERE -- BEFORE THE PRESS -- and the hashes in run 40589750993 are why.
    //
    // Taking it AFTER the continuation (the previous commit's approach) handed the pinned leg a chat in which the
    // GoTavern subject had ALREADY continued:
    //     gotavern handoff              sha 229e3f4d   == gotavern fileAfterContinue.sha256
    //     gotavern preContinue.file     sha 252c497c
    //     pinned  preContinue.file      sha 229e3f4d   <- the post-continuation bytes
    // so the pinned subject's last message was "Q20_REPLY_2 Q20_CONTINUATION_APPENDED_3" (39 chars) against
    // GoTavern's "Q20_REPLY_2" (11 chars), and `sameChat` reported exactly that length difference. Both subjects then
    // continued for real, from different starting points.
    //
    // A comparison needs both subjects to start from the SAME state, so the handoff is the pre-continue state -- the
    // very bytes `preContinue.file` was read from a line above. `handoffTree.preContinueSha256` records the hash the
    // producer copied, so a future leg can be checked rather than trusted: it must equal `preContinue.file.sha256`.
    {
        const handoffDir = argumentValue(process.argv, '--handoff-tree', process.env.Q20_HANDOFF_TREE ?? null);
        if (handoffDir) {
            const handoffPath = path.resolve(handoffDir);
            await fs.rm(handoffPath, { recursive: true, force: true });
            await fs.cp(dataRoot, handoffPath, { recursive: true, force: true });
            report.handoffTree = {
                path: handoffPath,
                at: 'pre-continue state, before the press',
                preContinueSha256: report.preContinue.file?.sha256 ?? null,
            };
        } else {
            report.handoffTree = null;
        }
    }
    // THE PRECONDITIONS THE SUBJECT ITSELF CHECKS (:11648-11661), asserted so a refusal is never read as a defect.
    step('precondition-continuable',
        preState.lastIsUser === false && preState.chatLength >= 3 && preState.isSendPress !== true && preState.thisEditMesId === null,
        JSON.stringify(preState));
    const requestsBefore = peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? '')).length;
    const navigationsBefore = report.navigations.length;

    // ARM THE CONTINUATION NOW, because `peerState.continuationOrdinal` was DECLARED AND NEVER ASSIGNED.
    //
    // MEASURED IN RUN 40538908912: three steps went red (`continue-control-reached`,
    // `continue-ui-shows-the-grown-message`, `continue-file-holds-continuation-in-same-message`) while the product
    // behaved correctly -- `beforeText: "Q20_REPLY_2"`, `afterText: "Q20_REPLY_2 Q20_REPLY_3"`, i.e. the last message
    // GROWN IN PLACE, which is exactly pinned's `appendFinal` (`lastMessage.mes = getMessage`, script.js:6719-6737).
    // The continuation branch in `replyText` never fired because the slot it tests was still `null`, so the peer
    // answered a plain `Q20_REPLY_N` and the assertions that look for `Q20_CONTINUATION_APPENDED` could not pass.
    //
    // THE ORDINAL IS THE COMPLETION THE CONTINUE WILL MAKE, and the leg already knows it: `requestsBefore` counts the
    // chat completions served so far, so the continue is number `requestsBefore + 1` (1-based, which is what
    // `startCapturePeer` passes as `replyIndex`). Arming it BEFORE the press is required -- the press triggers the
    // request -- and reading the count from the PEER is what makes this the harness's own measurement rather than a
    // guess about how many turns the loop drove.
    peerState.continuationOrdinal = requestsBefore + 1;
    // The tail is EMPTY on purpose: `replyText` already emits `MARKERS.continuation_<ordinal>`, and setting the tail
    // to the marker again produced `Q20_CONTINUATION_APPENDED_3Q20_CONTINUATION_APPENDED` -- a doubled token that the
    // `.includes()` assertions would still match, which is exactly the shape of "a green that proves nothing". The
    // field stays because a leg may want to extend the continuation later; it is empty here so the suffix is clean.
    peerState.continuationTail = '';

    // 2. THE REAL CONTROL, PRESSED.
    const pressed = await pressContinue(page);
    report.continue = pressed;
    // SAME CORRECTION AS THE REGENERATE LEG, same measurement: a browser ES module export is a live binding, so a
    // `Generate` wrapper may never bind and `generateCalls` can be empty while the verb WORKS. The subject's own
    // observables decide: the press was delivered, the page entered a generation (`sawBusy`), and afterwards the last
    // message's text is LONGER and starts with the text that was there -- pinned's `appendFinal` (`lastMessage.mes =
    // getMessage`, script.js:6719-6737) applied to the peer's continuation reply.
    step('continue-control-reached',
        pressed?.pressed === true
        && pressed?.sawBusy === true
        && pressed?.after?.lastIsUser === false
        && String(pressed?.after?.lastText ?? '').startsWith(String(pressed?.before?.lastMessage?.mes ?? '\u0000'))
        && String(pressed?.after?.lastText ?? '').includes('Q20_CONTINUATION_APPENDED'),
        JSON.stringify({
            menuVisible: pressed?.menuVisible,
            generateWrapStatus: pressed?.generateWrapStatus,
            calls: pressed?.generateCalls,
            sawBusy: pressed?.sawBusy,
            beforeText: String(pressed?.before?.lastMessage?.mes ?? '').slice(0, 80),
            afterText: String(pressed?.after?.lastText ?? '').slice(0, 120),
        }));
    await settleQuiet(page, recorder);
    report.savedAfterContinue = await saveConditional(page);
    await settleQuiet(page, recorder);

    const completionsAfter = peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? ''));
    const continueRequests = completionsAfter.slice(requestsBefore);
    report.peerRequests = peer.requests.map(entry => ({ method: entry.method, path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256, body: entry.body, requestedStream: entry.requestedStream ?? null, served: entry.served ?? null }));
    report.continueRequests = continueRequests.length;
    step('continue-issued-exactly-one-request', continueRequests.length === 1, `${continueRequests.length} new chat/completions request(s); all peer requests: ${peer.requests.length}`);
    step('drive-stayed-on-one-page', report.navigations.length === navigationsBefore, JSON.stringify(report.navigations.slice(navigationsBefore)));


    // 3. THE PAGE AFTERWARDS: the SAME message, grown. Pinned's answer is asserted here on BOTH subjects, so a
    // backend that appended a new message instead would fail this step before the comparator sees it.
    report.pageAfter = await page.evaluate(async () => {
        const script = await import('./script.js');
        const context = window.SillyTavern.getContext();
        const chat = script.chat ?? [];
        const last = chat[chat.length - 1];
        return {
            chatLength: chat.length,
            domMessageCount: document.querySelectorAll('#chat .mes').length,
            lastText: String(last?.mes ?? ''),
            lastIsUser: last?.is_user === true,
            lastExtra: last?.extra ?? null,
            lastSwipesCount: Array.isArray(last?.swipes) ? last.swipes.length : null,
            lastSwipeId: last?.swipe_id ?? null,
            chatId: context.chatId ?? null,
            domLastText: String(document.querySelector(`#chat .mes[mesid="${chat.length - 1}"] .mes_text`)?.textContent ?? ''),
        };
    });
    step('continue-grew-the-same-message',
        report.pageAfter.chatLength === preState.chatLength
        && report.pageAfter.lastText.startsWith(preState.lastText)
        && report.pageAfter.lastText.length > preState.lastText.length,
        JSON.stringify({ preLength: preState.lastText.length, afterLength: String(report.pageAfter.lastText ?? '').length, chatLength: report.pageAfter.chatLength, preChatLength: preState.chatLength }));
    step('continue-ui-shows-the-grown-message',
        // WHY NOT `domMessageCount === chatLength`. That was a DERIVATION, and run 40551319556 measured it wrong.
        //
        // The page held `domMessageCount: 6` against `chatLength: 5` while the product was CORRECT:
        // `domLastText: "Q20_REPLY_2 Q20_CONTINUATION_APPENDED_3"` -- the last message grown in place, exactly what
        // `appendFinal` does. `#chat .mes` counts RENDERED message elements; `chat.length` counts chat RECORDS, and the
        // two need not agree: `addOneMessage` skips rendering for some messages, and the greeting/system rows a tree
        // arrives with are not one-to-one with the array. The regenerate leg records the same field and never asserts
        // equality with `chatLength` -- it went 13/13 on this very chat -- so the inequality is normal, not a defect.
        //
        // The claim this step exists for is "the UI shows the grown message", and the DOM text proves it directly. The
        // count is kept as a REPORTED measurement with its difference, so a future run that adds or removes a rendered
        // row is visible without the step failing for a reason it never claimed to test.
        //
        // AND ONLY THE DOM TEXT IS ASSERTED. A companion `lastText === domLastText` was considered and REJECTED: I can
        // verify the DOM value from the run's own failure detail, but nothing in the artefact proves `lastText` (the
        // record's text) is byte-identical to it -- the record's text and the rendered text can differ by markdown
        // processing. Asserting an equality I have not observed is how a step goes red for a reason it did not name.
        String(report.pageAfter.domLastText ?? '').includes(MARKERS.continuation),
        JSON.stringify({
            domMessageCount: report.pageAfter.domMessageCount,
            chatLength: report.pageAfter.chatLength,
            domMinusChat: report.pageAfter.domMessageCount - report.pageAfter.chatLength,
            domLastText: String(report.pageAfter.domLastText ?? '').slice(0, 200),
            lastText: String(report.pageAfter.lastText ?? '').slice(0, 200),
        }));

    // 4. THE FILE AFTERWARDS -- separate from the UI on purpose: the UI replacing the bubble and the file holding the
    // right swipe are two different claims (this lane's brief), so they are two steps and two artefact fields.
    const afterContinue = await readChatFiles(dataRoot);
    report.fileAfterContinue = chatCarrying(afterContinue, MARKERS.second) ?? chatCarrying(afterContinue, MARKERS.first);
    const beforeFile = report.preContinue.file;
    const afterFile = report.fileAfterContinue;
    // The handoff was taken BEFORE the press (see `report.handoffTree` beside `preContinue`); the HASHES are what make
    // that checkable rather than asserted: `handoffTree.preContinueSha256` must equal `preContinue.file.sha256` on the
    // producer, and the pinned leg's `preContinue.file.sha256` must equal it too. Run 40589750993 differed on exactly
    // that field -- GoTavern handoff 229e3f4d (its OWN fileAfterContinue) against preContinue 252c497c -- which is the
    // fingerprint of a snapshot taken on the wrong side of the continuation.
    report.handoffTree = report.handoffTree ?? null;
    step('continue-file-same-line-count',
        Boolean(beforeFile) && Boolean(afterFile) && beforeFile.lines === afterFile.lines,
        `before=${beforeFile?.lines} after=${afterFile?.lines} file=${afterFile?.file ?? 'none'}`);
    step('continue-file-holds-continuation-in-same-message',
        Boolean(afterFile) && afterFile.messages[afterFile.messages.length - 1]?.mes?.startsWith(beforeFile.messages[beforeFile.messages.length - 1]?.mes ?? '\u0000') === true
        && String(afterFile.messages[afterFile.messages.length - 1]?.mes ?? '').includes(MARKERS.continuation),
        `last=${JSON.stringify(String(afterFile?.messages?.[afterFile.messages.length - 1]?.mes ?? '').slice(0, 240))}`);
    step('continue-file-metadata-appended',
        String(afterFile?.messages?.[afterFile.messages.length - 1]?.extra?.reasoning ?? '') === String(beforeFile?.messages?.[beforeFile.messages.length - 1]?.extra?.reasoning ?? ''),
        JSON.stringify({ before: beforeFile?.messages?.[beforeFile.messages.length - 1]?.extra ?? null, after: afterFile?.messages?.[afterFile.messages.length - 1]?.extra ?? null }));

    // 5. NO RESIDUAL STATE: the NEXT request is a normal turn, and it must be a normal turn -- a continuation buffer
    // left in `cyclePrompt` or in the streaming processor would show up as a nudge or as duplicated history.
    //
    // THIS TURN DELIBERATELY MUTATES THE TREE, and the pinned leg no longer sees it because the handoff was taken
    // BEFORE the press (see `report.handoffTree` beside `preContinue`). Run 40582180078 measured the cost of the
    // original ordering: `--data-chat` pointed at the LIVE root, which by the time the pinned leg started also held
    // this turn's user message and its reply, so the pinned subject opened a seven-message chat against the five the
    // GoTavern subject had continued -- `sameChat` "4 vs 6", `sameMessageGrown` "5 vs 7" -- with both subjects correct
    // on the same chat id and the same path. Run 40589750993 then showed the OTHER wrong side: a handoff taken AFTER
    // the continuation handed the pinned leg an already-continued last message ("... Q20_CONTINUATION_APPENDED_3", 39
    // chars, against GoTavern's "Q20_REPLY_2", 11). The handoff must be the PRE-continue state, which is what makes the
    // two subjects the same experiment.
    const nextTurn = await sendTurn(page, 'Q20 continue residual probe turn');
    report.nextTurn = nextTurn;
    await settleQuiet(page, recorder);
    await saveConditional(page);
    await settleQuiet(page, recorder);
    const allCompletions = peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? ''));
    report.nextTurnRequests = allCompletions.length - requestsBefore - 1;
    report.peerRequests = peer.requests.map(entry => ({ method: entry.method, path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256, body: entry.body, requestedStream: entry.requestedStream ?? null, served: entry.served ?? null }));
    step('next-turn-issued-one-request', report.nextTurnRequests === 1, `${report.nextTurnRequests} request(s) after the continue`);
    // THE NUDGE IS THE RESIDUE THIS LOOKS FOR: if the next request's body contains the nudge prompt, the
    // continuation state leaked out of the continue.
    const nudgeText = String(configured.continueNudgePrompt ?? '').trim();
    const nextBody = allCompletions[allCompletions.length - 1]?.body ?? '';
    report.nextTurnCarriesNudge = nudgeText.length > 0 && nextBody.includes(nudgeText);
    step('next-request-carries-no-continue-nudge', report.nextTurnCarriesNudge === false,
        `nudge=${JSON.stringify(nudgeText)} present=${report.nextTurnCarriesNudge}`);
    report.finalFile = chatCarrying(await readChatFiles(dataRoot), MARKERS.second) ?? chatCarrying(await readChatFiles(dataRoot), MARKERS.first);
    report.pageRequests = recorder.requests.map(entry => ({ method: entry.method, path: entry.pathAndQuery, status: entry.status }));
    report.chatRequests = chatRequestLog();
    report.processCommands = await readProcessCommands(page);
    // ---- V5(b) RELOCATED HERE, AFTER THE LAST COUNTING STEP ------------------------------------------
    // It was inserted before `next-turn-issued-one-request`, whose arithmetic (`allCompletions.length -
    // requestsBefore - 1`) assumes exactly one completion between the baseline and the next turn. This leg
    // presses continue a second time, so it made that count 2 and the assertion failed ON BOTH SUBJECTS --
    // an assertion the insertion invalidated, not a stale guard and not a product finding (Browser
    // differential 40757180703). Moving it below the last counting step keeps the axis and stops it
    // perturbing a measurement it is not part of. NO ASSERTION WAS CHANGED: the arithmetic was correct for
    // the surface as it was, and relaxing it to fit an experimental axis is how a guard becomes decoration.
    // ---- V5(b): A CLIENT DISCONNECT MID-CONTINUE --------------------------------------------------
    // THE ABORT LANE ESTABLISHED THAT A CUT AND A CALLER ABORT END DIFFERENTLY, so a continue that
    // treats them as one terminal state is a difference no other surface reveals. The comparator's
    // `notCompared` already SAID this was unanswered -- "error/cancel mid-continue: no leg drives a
    // failing provider here, so 'did the product save half a message' is unanswered" -- so this leg
    // answers a DECLARED gap rather than adding an undeclared one.
    //
    // IT IS RECORDED, NOT JUDGED, and that is deliberate: this leg runs AFTER the measurement above and
    // writes to `report.disconnectDuringContinue`, which no guard reads. A leg that could fail the
    // surface it belongs to would let an experimental axis suppress the claim it was added to explain.
    // Whether a difference here becomes a guard is a decision for the comparator, made once there is a
    // measurement to look at -- evidence first, patch second.
    //
    // WHAT IT DRIVES: the peer holds the continue response open without finishing, the page's own fetch
    // for that response is aborted the way a navigating or closing client aborts it, and the leg records
    // whether the last message kept the partial text, was rolled back, or was left empty. Both subjects
    // are driven identically, so an equal result is a fact and an unequal one is a finding.
    try {
        const disconnectBefore = peer.requests.length;
        const halfMessage = await page.evaluate(async (marker) => {
            const script = await import('./script.js');
            const context = window.SillyTavern.getContext();
            const chat = context.chat ?? [];
            const last = chat[chat.length - 1] ?? null;
            const before = {
                lastIsUser: last?.is_user === true,
                lastText: String(last?.mes ?? ''),
                chatLength: chat.length,
            };
            // The control is pressed and the response is ABORTED from the page side, which is what a
            // client disconnect looks like to the frontend: no user stop click, no provider error.
            const controller = new AbortController();
            const originalFetch = window.fetch;
            let aborted = 0;
            window.fetch = function patched(input, init) {
                const url = String(input?.url ?? input ?? '');
                if (/chat\/completions/.test(url) && init && typeof init === 'object') {
                    const merged = { ...init, signal: controller.signal };
                    const pending = originalFetch.call(this, input, merged);
                    // Yield so the request reaches the peer, then drop the client side of it.
                    queueMicrotask(() => { try { controller.abort(); aborted += 1; } catch { /* already gone */ } });
                    return pending;
                }
                return originalFetch.call(this, input, init);
            };
            try {
                document.querySelector('#option_continue')?.click();
            } catch { /* recorded by the after-state */ }
            await new Promise(resolve => setTimeout(resolve, 2500));
            window.fetch = originalFetch;
            const chatAfter = context.chat ?? [];
            const lastAfter = chatAfter[chatAfter.length - 1] ?? null;
            return {
                before,
                abortedRequests: aborted,
                afterChatLength: chatAfter.length,
                afterLastIsUser: lastAfter?.is_user === true,
                afterLastText: String(lastAfter?.mes ?? ''),
                sawBusy: document.querySelector('#mes_stop')?.style?.display !== 'none',
            };
        }, 'Q20_DISCONNECT_MARKER');
        report.disconnectDuringContinue = {
            ...halfMessage,
            newPeerRequests: peer.requests.length - disconnectBefore,
            // THE CLASSIFICATION, stated rather than inferred by a reader:
            //   'kept-partial'  - the message grew and kept what arrived before the abort
            //   'rolled-back'   - the message is byte-identical to the before-state
            //   'emptied'       - the message exists and is now empty
            //   'not-driven'    - the abort never reached a request, so nothing is claimed
            outcome: halfMessage.abortedRequests === 0
                ? 'not-driven'
                : halfMessage.afterLastText === halfMessage.before.lastText
                    ? 'rolled-back'
                    : halfMessage.afterLastText === ''
                        ? 'emptied'
                        : 'kept-partial',
        };
        step('disconnect-mid-continue-recorded', true, JSON.stringify({
            outcome: report.disconnectDuringContinue.outcome,
            aborted: halfMessage.abortedRequests,
            newRequests: report.disconnectDuringContinue.newPeerRequests,
        }));
        await settleQuiet(page, recorder);
    } catch (error) {
        report.disconnectDuringContinue = { outcome: 'not-driven', error: String(error && error.message ? error.message : error) };
        step('disconnect-mid-continue-recorded', false, String(error && error.message ? error.message : error));
    }
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    if (browser) await browser.close();
    await peer.close();
    if (boot.server) boot.server.kill();
    report.serverLog = boot.serverLog;
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${report.subject} leg (continue): ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;
