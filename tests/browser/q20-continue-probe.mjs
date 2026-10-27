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
const peerState = { continuationOrdinal: null, continuationTail: null };
const peer = await startCapturePeer({
    wire: wireMode,
    replyText: (ordinal, counterpart) => (peerState.continuationOrdinal !== null && peerState.continuationOrdinal === counterpart
        ? `${MARKERS.continuation}_${counterpart}${typeof peerState.continuationTail === 'string' ? peerState.continuationTail : ''}`
        : `Q20_REPLY_${counterpart}`),
});
const peerBase = `http://127.0.0.1:${peer.port}/v1`;

let browser;
try {
    if (boot.bootRefusal) throw new Error(boot.bootRefusal);
    await waitForServer(`${baseURL}/version`);
    browser = await chromium.launch();
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
        return { chatId: context.chatId ?? null, chatLength: (context.chat ?? []).length, thisChid: context.characterId ?? null };
    });
    report.openedContext = openedContext;

    // 1. BRING THE CHAT TO (greeting, user, assistant, user, assistant) -- the same five-message shape the
    // regenerate leg uses, so the two verbs are measured on one conversation and not on two.
    const silenced = await silenceAndObserve(page);
    report.silenced = silenced;
    step('frontend-observers-installed', silenced.processCommandsWrapped === true, JSON.stringify(silenced));
    if (openedContext.chatLength < 3) {
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
    // THE PRECONDITIONS THE SUBJECT ITSELF CHECKS (:11648-11661), asserted so a refusal is never read as a defect.
    step('precondition-continuable',
        preState.lastIsUser === false && preState.chatLength >= 3 && preState.isSendPress !== true && preState.thisEditMesId === null,
        JSON.stringify(preState));
    const requestsBefore = peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? '')).length;
    const navigationsBefore = report.navigations.length;

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
        report.pageAfter.domMessageCount === report.pageAfter.chatLength
        && String(report.pageAfter.domLastText ?? '').includes(MARKERS.continuation),
        JSON.stringify({ domMessageCount: report.pageAfter.domMessageCount, chatLength: report.pageAfter.chatLength, domLastText: String(report.pageAfter.domLastText ?? '').slice(0, 200) }));

    // 4. THE FILE AFTERWARDS -- separate from the UI on purpose: the UI replacing the bubble and the file holding the
    // right swipe are two different claims (this lane's brief), so they are two steps and two artefact fields.
    const afterContinue = await readChatFiles(dataRoot);
    report.fileAfterContinue = chatCarrying(afterContinue, MARKERS.second) ?? chatCarrying(afterContinue, MARKERS.first);
    const beforeFile = report.preContinue.file;
    const afterFile = report.fileAfterContinue;
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
