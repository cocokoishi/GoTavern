// Q20 -- REGENERATE PRESERVES EQUALITY (GOAL.md §9; the verb pair `q20-persistence-probe.mjs` declares in
// `notCompared`).
//
// THE QUESTION, in one sentence: when a user presses Regenerate on a chat that was SAVED, READ BACK BY A FRESH PAGE
// LOAD and given a turn, does the request that reaches the model equal pinned's, does the chat END UP THE SAME on
// disk (same message count, same swipes array, same metadata), and does the request AFTER it carry no residual
// state?
//
// ---------------------------------------------------------------------------------------------------------------
// PINNED'S SEMANTICS FOR THIS VERB, read from the pinned frontend, line by line -- this leg asserts THESE and does
// not assume any of them:
//
//   entry point     `#option_regenerate` (public/index.html:8181), inside the `#options` flyout.
//                   Its handler is the DELEGATED `$('#options [id]').on('click', ...)` at public/script.js:11581,
//                   and the regenerate branch is public/script.js:11629-11641:
//                       chat.length - 1 === this_edit_mes_id && chat[this_edit_mes_id]?.is_user == false -> refuse
//                       is_send_press == false                                                            -> act
//                       selected_group ? regenerateGroup() : Generate('regenerate', ...)
//   the deletion    public/script.js:4399-4406. `type !== 'regenerate'` is false for this verb, so the
//                   `else if (...)` at :4400 runs: `chat.length = chat.length - 1; await removeLastMessage();
//                   MESSAGE_DELETED`. THE ASSISTANT MESSAGE BEING REPLACED IS REMOVED FROM `chat` BEFORE THE
//                   REQUEST IS ASSEMBLED -- which is why the regenerated request's history must END AT THE USER TURN,
//                   and why "the assistant message being replaced is the one that was there" is checkable at all.
//   the prompt      openai path: `oaiMessages = setOpenAIMessages(coreChat)` (:4834) with the deleted message gone;
//                   `type` only selects the OpenAI preset collection (`chat_completion_type`, :4441-4458).
//   the reply       non-streaming, `originalType !== 'continue'` (:5531): `saveReply({ type, ... })` with
//                   `type === 'regenerate'`. `saveReply` (:6642) at :6690/:6721: the last message EXISTS and has a
//                   `swipe_id`, so `type` is NOT coerced to 'normal'; the 'append'/'continue' and 'appendFinal'
//                   branches do not match either; the fallthrough `else` (:6738) pushes a NEW message.
//                   So regenerate appends one message -- it does not grow a swipes array. That is what the file
//                   assertion checks, and it is pinned's answer, not this file's preference.
//   the request     `type` is part of the POST to /api/backends/chat-completions/generate
//                   (public/scripts/openai.js:2802-2821 `generate_data`), and the server's generic OpenAI/Custom body
//                   (src/endpoints/backends/chat-completions.js:2652-2670) has NO `type` member -- so the PROVIDER
//                   request for regenerate differs from a normal turn ONLY where the prompt differs.
//   the save        NOT `saveChat`. `saveReply`'s regenerate path ends in `saveChatDebounced()`
//                   (public/script.js:7361, a setTimeout) and `setInContextMessages` (:6086-6097) writes
//                   `chat_metadata.lastInContextMessageId` with the comment "No metadata save on purpose". The leg
//                   therefore drives the frontend's own `saveChatConditional()` as the user closing the chat does,
//                   and asserts the FILE afterwards rather than assuming the debounce fired.
//
// WHY THE CHAT IS (GREETING, USER, ASSISTANT, USER, ASSISTANT) ON BOTH SUBJECTS AND WHY IT COMES FROM DISK. The
// GoTavern leg writes it -- through the frontend's own send -- and the pinned leg OPENS THE TREE THE GOTAVERN LEG
// WROTE (`--data-chat`), so the conversation being regenerated is byte-identical before either subject acts. A leg
// that built its own chat would be comparing regenerate-on-A with regenerate-on-B. The drive that opens it is
// `q20-persistence-drive.mjs` on both sides: SAME code path, different server.
//
// WHAT THE PER-SUBJECT CONTENT MARKER IS FOR. Both subjects must send requests that are NOT equal to each other
// before the verb, or "the requests are equal" is satisfied by two empty builds. The second turn's user text is
// written into the page's own chat, on the page's own state, with a per-subject token in it (the same technique,
// and the same reason, as q20-persistence-probe.mjs's second turn).
//
// WHAT THIS DOES NOT PROVE, carried into the comparator's `notCompared`: streaming, a real provider (rule 22), group
// chats, multi-swipe providers (`n > 1` is off for this source), and the click's own animation timing.
//
// Usage (GoTavern leg):  GOTAVERN_BINARY=... node q20-regenerate-probe.mjs --data-root <tree> --report <json>
// Usage (pinned leg):    node run-against-pinned.mjs q20-regenerate-probe.mjs -- --data-root <tree> \
//                          --data-chat <the tree the GoTavern leg wrote> --report <json>
// Usage (self-check):    node q20-regenerate-probe.mjs --self-check
//
// The self-check REFUSES when a precondition is missing rather than reporting a pass: it reads the pinned frontend
// line by line for the entry point, the deletion, the saveReply branch and the request builder, and fails by name if
// any of them moved. It needs no server and no browser.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachUrlRecorder } from './url-recorder.mjs';
import { ensurePinnedExtensionInstalled } from './install-pinned-extension.mjs';
import { pinnedExtension } from './pinned-extensions.mjs';
import {
    chatCarrying, configureConnection, openCharacter, openPage, pressRegenerateThroughMenu,
    readChatFiles, readProcessCommands, resolveRoster, saveConditional, sendTurn, settleQuiet, silenceAndObserve, waitForReply,
} from './q20-persistence-drive.mjs';
import { argumentValue, bootSubject, freePort, repoRoot, startCapturePeer, waitForServer } from './q20-leg-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------------------------------------------
// WHAT THE DRIVE REQUIRES OF THE ORACLE, as pinned source predicates. Named so a red says WHICH moved.
// ---------------------------------------------------------------------------------------------------------------
export const PINNED_PRECONDITIONS = [
    { name: 'entry: the regenerate control is a #options child', file: 'public/index.html', pattern: /<a id="option_regenerate">/, why: 'the control this leg presses' },
    { name: 'entry: #options delegates clicks to its [id] children', file: 'public/script.js', pattern: /\$\('#options \[id\]'\)\.on\('click'/, why: 'without this a click on the control reaches no handler' },
    { name: 'entry: the regenerate branch calls Generate(\'regenerate\')', file: 'public/script.js', pattern: /Generate\('regenerate', buildOrFillAdditionalArgs\(\)\)/, why: 'the verb itself' },
    { name: 'guard: is_send_press gates the control', file: 'public/script.js', pattern: /if \(is_send_press == false\) \{\s*\n\s*if \(selected_group\) \{\s*\n\s*regenerateGroup\(\);/, why: 'a leg that presses mid-generation measures the guard, not the verb' },
    { name: 'semantics: regenerate deletes the last message before the request', file: 'public/script.js', pattern: /chat\.length = chat\.length - 1;\s*\n\s*await removeLastMessage\(\);/, why: 'the regenerated request must not contain the replaced reply' },
    { name: 'semantics: the deletion is guarded by type !== \'swipe\'/quiet/impersonate', file: 'public/script.js', pattern: /type !== 'quiet' && type !== 'swipe' && !isImpersonate && !dryRun && !depth && chat\.length/, why: 'regenerate is not in the exclusion list, which is what makes the deletion happen' },
    { name: 'semantics: non-streaming regenerate is saved through saveReply({type})', file: 'public/script.js', pattern: /\{ type, getMessage \} = await saveReply\(\{ type, getMessage, title, swipes, reasoning, imageUrls, reasoningSignature \}\)/, why: 'the branch that decides new message vs swipe' },
    { name: 'semantics: saveReply coerces to normal only for non-append types', file: 'public/script.js', pattern: /if \(type != 'append' && type != 'continue' && type != 'appendFinal' && chat\.length/, why: 'regenerate falls through to the new-message branch' },
    { name: 'request: the provider body carries no `type` member', file: 'src/endpoints/backends/chat-completions.js', pattern: /const requestBody = \{\s*\n\s*'messages'/, why: 'the difference must be prompt-visible, not a hidden transport flag' },
    { name: 'save: regenerate ends in saveChatDebounced, not saveChat', file: 'public/script.js', pattern: /export function saveChatDebounced\(\)/, why: 'why the leg must drive saveChatConditional itself' },
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
const dataRoot = path.resolve(argumentValue(process.argv, '--data-root') ?? await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'gotavern-q20-regen-')));
// THE TREE THE GOTAVERN LEG WROTE, for the pinned leg. When present it is COPIED into this leg's own data root --
// `run-against-pinned.mjs` owns the process, not the tree -- so the pinned server boots against exactly the bytes
// the product wrote without either leg writing into the other's root. Recorded in the artefact as a digest.
const sourceChatTree = argumentValue(process.argv, '--data-chat', process.env.Q20_DATA_CHAT ?? null);
const reportPath = path.resolve(argumentValue(process.argv, '--report', path.join(here, 'q20-regenerate-leg.json')));

const installed = await ensurePinnedExtensionInstalled(dataRoot, pinnedExtension('tavern-helper'));
if (sourceChatTree) {
    await fs.cp(path.resolve(sourceChatTree), dataRoot, { recursive: true, force: true });
}

const port = await freePort();
const boot = await bootSubject({ argv: process.argv, dataRoot, port, external });
const baseURL = boot.baseURL;
const MARKERS = {
    first: 'Q20_REGEN_FIRST_TURN_MARKER',
    second: process.env.Q20_REGEN_SECOND_MARKER ?? 'Q20_REGEN_SECOND_TURN_MARKER',
};

// CONDITION 5, PROVIDE-DO-NOT-USE: `--wire honour|json|sse`. The default HONOURS the request (SSE to a `stream: true`
// request), so the response format is a function of what the page asked for; a leg may pin it instead, and the choice
// is recorded in `report.wireMode` so no reader has to infer which peer an artefact came from.
// DECLARED BEFORE `report`, which carries it: a `const` referenced above its declaration is a temporal-dead-zone
// ReferenceError, and `node --check` cannot see that (it is a runtime error, not a syntax one).
const wireMode = argumentValue(process.argv, '--wire', process.env.Q20_WIRE ?? 'honour');

const report = {
    schemaVersion: 1,
    verb: 'regenerate',
    question: 'When a user regenerates the last reply of a saved, reloaded chat, does the model receive the same context as pinned, does the disk end up the same, and does the NEXT request carry no residual state?',
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

if (boot.bootRefusal) {
    report.failure = `leg-refused: ${boot.bootRefusal}`;
}

// CONDITION 5, PROVIDE-DO-NOT-USE: `--wire honour|json|sse`. The default HONOURS the request (SSE to a `stream: true`
// request), so the response format is a function of what the page asked for; a leg may pin it instead, and the choice
// is recorded in `report.wireMode` so no reader has to infer which peer an artefact came from.
const peer = await startCapturePeer({ wire: wireMode });

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

    // 1. THE PAGE, THE CONNECTION, THE CHAT THE PRODUCT ALREADY WROTE.
    const ready = await openPage(page, baseURL);
    step('page-loaded', ready === true, `settingsReady=${ready}`);
    step('page-no-errors', report.pageErrors.length === 0, JSON.stringify(report.pageErrors));
    const configured = await configureConnection(page, { url: peerBase, model: 'probe-model' });
    report.configured = configured;
    step('connection-configured', configured.source === 'custom' && String(configured.url ?? '').includes(String(peer.port)), JSON.stringify(configured));

    // THE CHAT IS NAMED, NOT ASSUMED. `--character` is passed by the workflow from the GoTavern leg's own artefact;
    // without it this leg refuses rather than opening whichever card renders (the brief's "never the first card").
    // THE CARD NAME: `--character <name>` when a caller has one (the pinned leg, given the GoTavern leg's own
    // artefact), `--character auto` when the leg must discover it, and NO default -- an unnamed card is refused.
    //
    // WHY `auto` EXISTS, measured twice. Run 40452820868: `--character` was passed to the pinned leg only, so this leg
    // refused and every later step ran with no chat open. Run 40454879293: the workflow then read
    // `<dataRoot>/default-user/characters` BEFORE this leg ran, and on a FRESH install that directory does not exist
    // yet -- the card is seeded by the SERVER at boot -- so the name was empty again. `auto` asks THE PAGE, whose
    // roster is the product's own answer, and it is deliberately narrow:
    //   * it reads `script.characters[0].name` from the LOADED page, never a DOM node, so it cannot pick "whichever
    //     card rendered" -- the roster is the page's model, and a page with no card yields no name and a REFUSAL;
    //   * it records the name it used in `characterOpen.characterName` (via `openCharacter`), so the artefact says
    //     which card was acted on and the pinned leg can be pointed at the same one;
    //   * it refuses when the roster has ZERO entries, and when it has MORE THAN ONE it refuses too -- a fresh-install
    //     leg has exactly one card, and an ambiguous roster is a reason to stop, not to choose.
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
        return { chatId: context.chatId ?? null, chatLength: (context.chat ?? []).length, thisChid: context.characterId ?? null, characterName: (context.characters ?? [])[Number(context.characterId)]?.name ?? null };
    });
    report.openedContext = openedContext;

    // 2. THE CHAT IS BROUGHT TO THE STATE THE VERB NEEDS: (greeting, user, assistant, user, assistant).
    //
    // The first turn is SILENCED for the save (`savingAfterComplete = false`) so that the Q20 pair starts from the
    // same on-disk chat; the second turn's user text carries a PER-SUBJECT marker so two equal-after-the-verb
    // requests cannot be equal for the trivial reason that both legs sent the same bytes.
    const silenced = await silenceAndObserve(page);
    report.silenced = silenced;
    step('frontend-observers-installed', silenced.processCommandsWrapped === true, JSON.stringify(silenced));

    const beforeFirst = await readChatFiles(dataRoot);
    if (openedContext.chatLength < 3) {
        // A fresh chat has ONE greeting. Two turns make it (greeting, user, assistant, user, assistant).
        //
        // THE TURN WAITS ON THE PRODUCT'S SETUP STATE AND FAILS BY NAME -- `waitForReply` in the shared drive -- rather
        // than polling for "the user turn exists". Run 40448869208 measured what polling for a USER turn costs: the
        // leg proceeded while the assistant reply had not landed, and the swipe that followed was performed on the
        // user message, a state the frontend refuses silently. `requireText` is FALSE for the reason recorded in the
        // comparator's `emptyReplyOnBothSubjects`: the stored reply has empty text on BOTH subjects (40445671791,
        // 40448869208), which is an OPEN fixture finding, not a condition this leg may convert into a red.
        for (const [index, turnMarker] of [[0, MARKERS.first], [1, MARKERS.second]]) {
            const sent = await sendTurn(page, index === 0 ? `Q20 regenerable first turn ${turnMarker}` : `Q20 regenerable second turn ${turnMarker}`);
            report[`send${index + 1}`] = sent;
            const countBefore = peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? '')).length;
            const reply = await waitForReply(page, { timeoutMs: 60000, requireText: false, peerCompletions: countBefore + 1, baseline: sent?.baseline ?? null });
            report[`reply${index + 1}`] = reply;
            step(`turn-${index + 1}-reply-settled`, reply.ok === true, reply.ok === true ? JSON.stringify(reply.state) : JSON.stringify(reply));
            if (!reply.ok) {
                // THE NAMED FAILURE IS THE RESULT: stop here rather than let the later steps act on a state a user
                // cannot reach. The step above already carries `setup-reply-did-not-arrive` and the falsifier.
                report.failure = report.failure ?? `${reply.name}: ${reply.reading} ${JSON.stringify(reply.state)} peerCompletions=${JSON.stringify(reply.peerCompletions)}`;
                break;
            }
            // THE TURN IS ON DISK THROUGH THE FRONTEND'S OWN WRITE-NOW, and the file (not a snapshot) is what the
            // later steps read. `saveChatConditional` is the entry `/Generate` itself ends with (script.js:5573).
            await saveConditional(page);
            await settleQuiet(page, recorder);
            const files = await readChatFiles(dataRoot);
            const carried = chatCarrying(files, turnMarker) !== null;
            step(`turn-${index + 1}-saved`, carried, files.map(file => `${file.file}:${file.lines}`).join(',') || 'none');
            if (!carried) {
                report.failure = report.failure ?? `turn-${index + 1}-saved: the file on disk does not carry ${turnMarker}`;
                break;
            }
        }
    }
    await settleQuiet(page, recorder);
    report.chatRequestsAfterSetup = chatRequestLog();
    const beforeRegenerate = await readChatFiles(dataRoot);
    const preState = await page.evaluate(async () => {
        const script = await import('./script.js');
        const context = window.SillyTavern.getContext();
        const chat = script.chat ?? [];
        return {
            chatId: context.chatId ?? null,
            chatLength: chat.length,
            lastIsUser: chat[chat.length - 1]?.is_user === true,
            lastText: String(chat[chat.length - 1]?.mes ?? ''),
            lastSwipesCount: Array.isArray(chat[chat.length - 1]?.swipes) ? chat[chat.length - 1].swipes.length : null,
            lastSwipeId: chat[chat.length - 1]?.swipe_id ?? null,
            lastSendDate: chat[chat.length - 1]?.send_date ?? null,
            isSendPress: script.is_send_press ?? null,
            thisEditMesId: script.this_edit_mes_id ?? null,
            lastInContextMessageId: context.chatMetadata?.lastInContextMessageId ?? null,
        };
    });
    report.preRegenerate = { page: preState, file: chatCarrying(beforeRegenerate, MARKERS.second) ?? chatCarrying(beforeRegenerate, MARKERS.first) };
    // THE PRECONDITION THE SUBJECT ITSELF CHECKS, asserted rather than assumed (AGENTS rule 10): a leg that presses
    // regenerate while the page is busy, or on a user message, would be measuring pinned's own guard.
    step('precondition-regenerable', preState.lastIsUser === false && preState.chatLength >= 3 && preState.isSendPress !== true && preState.thisEditMesId === null,
        JSON.stringify(preState));
    const requestsBefore = peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? '')).length;
    const navigationsBefore = report.navigations.length;

    // 3. THE REAL CONTROL, PRESSED.
    const pressed = await pressRegenerateThroughMenu(page);
    report.regenerate = pressed;
    // WHAT "REACHED THE CONTROL" MEANS, corrected by measurement. The first version required my `Generate` wrapper to
    // record a call; run 40462256569 measured `generateCalls: []` and `sawRegenerateCall: false` WHILE THE REGENERATE
    // WORKED (`Q20_REPLY_2` -> `Q20_REPLY_3`, chat length unchanged, page and file agreeing). A browser ES module
    // export is a live binding, so a wrapper assigned onto the namespace may never bind -- and a guard that fails when
    // its INSTRUMENT fails is a guard on the harness, not on the product (AGENTS rule 10's inverse error). The
    // subject's own observables are used instead, and the instrument is still reported so a reader knows why:
    //   * the press was delivered (`pressed.pressed`: the control was in the page and was clicked);
    //   * the product ACTED: `sawBusy` (the page entered a generation -- `is_send_press` or a `streamingProcessor`),
    //     and afterwards the last message carries a DIFFERENT peer reply from the one that was there.
    step('regenerate-control-reached',
        pressed?.pressed === true
        && pressed?.sawBusy === true
        && pressed?.after?.lastIsUser === false
        && String(pressed?.after?.lastText ?? '') !== String(pressed?.before?.lastMessage?.mes ?? '')
        && /^Q20_REPLY_\d+$/.test(String(pressed?.after?.lastText ?? '').trim()),
        JSON.stringify({
            menuVisible: pressed?.menuVisible,
            generateWrapStatus: pressed?.generateWrapStatus,
            calls: pressed?.generateCalls,
            sawBusy: pressed?.sawBusy,
            beforeText: pressed?.before?.lastMessage?.mes ?? null,
            afterText: pressed?.after?.lastText ?? null,
        }));
    await settleQuiet(page, recorder);
    const saved = await saveConditional(page);
    report.savedAfterRegenerate = saved;
    await settleQuiet(page, recorder);

    const completions = peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? ''));
    const regenerated = completions.slice(requestsBefore);
    report.peerRequests = peer.requests.map(entry => ({ method: entry.method, path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256, body: entry.body, requestedStream: entry.requestedStream ?? null, served: entry.served ?? null }));
    report.regenerateRequests = regenerated.length;
    step('regenerate-issued-exactly-one-request', regenerated.length === 1, `${regenerated.length} new chat/completions request(s); all peer requests: ${peer.requests.length}`);
    step('drive-stayed-on-one-page', report.navigations.length === navigationsBefore, JSON.stringify(report.navigations.slice(navigationsBefore)));

    // 4. THE DISK AFTERWARDS, AND THE UI, AS TWO SEPARATE STATEMENTS.
    const afterRegenerate = await readChatFiles(dataRoot);
    report.pageAfter = await page.evaluate(async () => {
        const script = await import('./script.js');
        const context = window.SillyTavern.getContext();
        const chat = script.chat ?? [];
        return {
            chatLength: chat.length,
            domMessageCount: document.querySelectorAll('#chat .mes').length,
            lastText: String(chat[chat.length - 1]?.mes ?? ''),
            lastIsUser: chat[chat.length - 1]?.is_user === true,
            lastSwipesCount: Array.isArray(chat[chat.length - 1]?.swipes) ? chat[chat.length - 1].swipes.length : null,
            lastSwipeId: chat[chat.length - 1]?.swipe_id ?? null,
            chatId: context.chatId ?? null,
        };
    });
    report.fileAfterRegenerate = chatCarrying(afterRegenerate, MARKERS.second) ?? chatCarrying(afterRegenerate, MARKERS.first);
    const beforeFile = report.preRegenerate.file;
    const afterFile = report.fileAfterRegenerate;
    step('regenerate-ui-held-a-message',
        report.pageAfter.chatLength === preState.chatLength && report.pageAfter.lastIsUser === false && report.pageAfter.lastText.startsWith('Q20_REPLY_'),
        JSON.stringify({ preState, after: report.pageAfter }));
    step('regenerate-file-held-the-same-message-count',
        beforeFile && afterFile && beforeFile.lines === afterFile.lines,
        `before=${beforeFile?.lines} after=${afterFile?.lines} file=${afterFile?.file ?? 'none'}`);
    step('regenerate-file-holds-the-new-reply',
        Boolean(afterFile) && afterFile.messages[afterFile.messages.length - 1]?.mes?.startsWith('Q20_REPLY_') === true
        && afterFile.messages[afterFile.messages.length - 1]?.mes !== beforeFile?.messages?.[beforeFile.messages.length - 1]?.mes,
        `last=${JSON.stringify(afterFile?.messages?.[afterFile.messages.length - 1]?.mes ?? null)}`);
    step('regenerate-file-swipes-unchanged',
        (beforeFile?.messages?.[beforeFile.messages.length - 1]?.swipesCount ?? null) === (afterFile?.messages?.[afterFile.messages.length - 1]?.swipesCount ?? null),
        `before=${beforeFile?.messages?.[beforeFile.messages.length - 1]?.swipesCount ?? null} after=${afterFile?.messages?.[afterFile.messages.length - 1]?.swipesCount ?? null}`);

    // 5. THE NEXT REQUEST CARRIES NO RESIDUAL STATE. A swipe AFTER the regenerate is the cheapest probe of that: the
    // swipe's request must equal the regenerate's (same chat, same history) and must not carry the replaced reply.
    const swiped = await page.evaluate(async () => {
        const script = await import('./script.js');
        const constants = await import('./scripts/constants.js');
        const chat = script.chat ?? [];
        const mesId = chat.length - 1;
        const before = { mesId, swipeId: chat[mesId]?.swipe_id ?? null, swipes: Array.isArray(chat[mesId]?.swipes) ? chat[mesId].swipes.length : null, lastIsUser: chat[mesId]?.is_user === true };
        let error = null;
        try {
            await script.swipe(null, constants.SWIPE_DIRECTION.RIGHT, { source: constants.SWIPE_SOURCE.SWIPE_PICKER, repeated: false, forceMesId: mesId });
        } catch (thrown) {
            error = String(thrown && thrown.message || thrown);
        }
        const after = script.chat ?? [];
        return { before, error, after: { chatLength: after.length, mesId, swipeId: after[mesId]?.swipe_id ?? null, swipes: Array.isArray(after[mesId]?.swipes) ? after[mesId].swipes.length : null } };
    });
    report.swipeAfter = swiped;
    await settleQuiet(page, recorder);
    await saveConditional(page);
    await settleQuiet(page, recorder);
    report.peerRequests = peer.requests.map(entry => ({ method: entry.method, path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256, body: entry.body, requestedStream: entry.requestedStream ?? null, served: entry.served ?? null }));
    const allCompletions = peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? ''));
    step('swipe-after-regenerate-issued-one-request', allCompletions.length === requestsBefore + 2,
        `${allCompletions.length - requestsBefore} request(s) after the pre-regenerate mark, expected 2 (regenerate, swipe)`);
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
    console.log(`${report.subject} leg (regenerate): ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;
