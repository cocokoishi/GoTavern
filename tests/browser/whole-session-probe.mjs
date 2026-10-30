// WHOLE-SESSION — ONE USER, ONE SERVER, ONE TREE, ONE CONTINUOUS SESSION LINEAGE.
//
// THE QUESTION, in one sentence: if a real user boots a stock SillyTavern tree, loads the page, reads settings,
// changes one, lists characters, opens a card, sends a message and gets a STREAMED reply, swipes that reply, saves,
// reloads the page, takes a second turn, regenerates, continues, then RESTARTS the server on the same tree and keeps
// working — does every fact a user or a user's model could observe match pinned Node SillyTavern's?
//
// WHY THIS FILE EXISTS AND THE EIGHT EXISTING PROBES ARE NOT ENOUGH. `docs/compatibility-matrix.json`'s
// `whole-session-e2e` row is the only FAIL, and its own `session` section states the reason precisely: every step of
// the journey has a probe, no probe shares a runtime with another, so there is no SESSION. A chat saved in one tree
// and reloaded in one tree is gated nowhere, and a comparison of "two subjects driven the same way" is vacuous when
// the fixture cannot tell them apart. Eight experiments answer eight questions about eight processes; this answers
// one question about one process.
//
// WHAT "THE SAME SESSION" MEANS HERE, stated so it can be falsified:
//   * phase `drive`   boots ONE server over ONE data root and performs the whole journey in ONE browsing context.
//     Every step after the first reads state the previous step (or the reload of it) left behind. The page is
//     reloaded once, deliberately: that is the step a user performs by closing and opening the tab.
//   * phase `restart` is a SECOND, SEPARATE INVOCATION over the SAME data root — a NEW server process, a NEW browser
//     and a NEW page — which must read back what the drive phase wrote. This is the established shape in this harness
//     (`helper-vars-probe.mjs --restart`, judged by `compare-helper-vars-generate-legs.mjs`), used instead of killing
//     a process mid-probe because the pinned subject is booted by `run-against-pinned.mjs`, which OWNS that process:
//     a probe that "restarted" a server it did not spawn would be recording a claim it cannot observe. That the two
//     runs used different pids is the comparator's `restart-is-a-new-process` guard.
//
// THE THREE FACT CLASSES THE COMPARATOR COMPARES, and why all three are needed (AGENTS.md rule 7):
//   1. BROWSER OBSERVABLE — readiness, the roster, the opened card, the chat id, the role+text sequence the page
//      holds at four moments (after the first turn, after the reload, after the verbs, after the restart), the
//      swipe/regenerate/continue state, and the setting the user changed.
//   2. PROVIDER WIRE — every completion request the recording peer received, in order: method, raw target, byte
//      length, sha256 and the raw body. Byte-oriented (differential doctrine 2): no canonicalising, no re-marshalling,
//      no dropping "irrelevant" members.
//   3. DISK STATE — the chat file the PRODUCT wrote (its name, its message count and per-message semantic fields), the
//      settings file the user's change landed in, and the growth the resumed turn causes after the restart.
//      Comparing only the browser would miss a chat that renders and never persists; only the wire would miss a
//      persisted file the reload reads wrongly; only disk would miss a page showing the wrong conversation.
//
// THE PER-SUBJECT DISCRIMINATOR (rule 50; the technique `q20-persistence-probe.mjs` documents). Both subjects are fed
// byte-identical user turns, so if both were also fed byte-identical replies the comparator could not show that its
// own fixture is able to tell the subjects apart. `--reply-prefix` (`WSG_` for GoTavern, `WSP_` for pinned) is
// stamped into ONE reply, and WHICH one is derived rather than chosen:
//   * it must be a reply the subject was really FED, so the difference is real;
//   * it must not be carried by any COMPARED provider request, so those stay byte-comparable;
//   * it must still exist at the END of the journey, or there is nothing for the comparator to require a difference in.
// The FIRST turn's reply satisfies all three only in the right order: it is rendered, then SWIPED AWAY (the swipe pops
// the message being swiped, `public/script.js:4497-4499`, and :4834 builds the message array from that same popped
// array) — so the swipe's own request and every later request carry the fresh, UNPREFIXED replacement — while the
// prefixed text remains on disk inside that message's `swipes[]` array, which nothing after the swipe deletes.
// Stamping the SECOND turn's reply instead, as the Q20 lane does, would not survive this journey: regenerate DELETES
// the last assistant message (:4399-4406), so the only copy of the discriminator would be destroyed before the restart.
//
// WHAT THIS DOES NOT PROVE, repeated in the artefact so the matrix row can quote it: a real provider (rule 22), group
// chats, branches/checkpoints, multi-user, or a real user's data. The provider is a recording peer answering with
// markers; the tree is a fresh install the server seeds itself.
//
// WHERE THIS RUNS: GitHub Actions only. This surface drives a real browser, which is forbidden on the operator's
// Windows host; a local attempt also opened the operator's DEFAULT BROWSER because the GoTavern leg was booted without
// `--browserLaunchEnabled false` (now fixed in q20-leg-runtime.mjs, whose comment records the measurement).

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { argumentValue, bootSubject, freePort, startCapturePeer, waitForServer } from './q20-leg-runtime.mjs';
import {
    chatCarrying, configureConnection, openCharacter as driveOpenCharacter, openPage as driveOpenPage,
    pressContinue, pressRegenerate, readChatFiles as driveReadChatFiles, readReadiness, resolveRoster,
    saveConditional, sendTurn, settleQuiet, waitForReply,
} from './q20-persistence-drive.mjs';
import { attachUrlRecorder } from './url-recorder.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

// ---------------------------------------------------------------------------------------------------------------
// THE JOURNEY'S INPUTS.
// ---------------------------------------------------------------------------------------------------------------

const dataRootArgument = argumentValue(process.argv, '--data-root', null);
if (!dataRootArgument) {
    console.error('whole-session-probe.mjs: --data-root is required (one tree, shared by the drive and restart phases)');
    process.exit(2);
}
const dataRoot = path.resolve(dataRootArgument);
await fs.mkdir(dataRoot, { recursive: true });
const phase = argumentValue(process.argv, '--phase', 'drive');
if (!['drive', 'restart'].includes(phase)) {
    console.error(`whole-session-probe.mjs: --phase must be drive or restart, not ${JSON.stringify(phase)}`);
    process.exit(2);
}
const reportPath = path.resolve(argumentValue(process.argv, '--report', path.join(here, `whole-session-${phase}-report.json`)));
// WHICH SUBJECT THIS LEG IS, decided by HOW it was started rather than by an argument that could disagree with the
// facts: `run-against-pinned.mjs` sets PROBE_BASE_URL, so an external base URL IS the pinned subject.
const external = Boolean(process.env.PROBE_BASE_URL);
const subject = external ? 'pinned' : 'gotavern';
const replyPrefix = argumentValue(process.argv, '--reply-prefix', process.env.WS_REPLY_PREFIX ?? '');

// THE USER'S OWN WORDS. Identical on both subjects on purpose: these strings ARE carried by the compared provider
// requests, so a difference here would be a difference the harness made.
const MARKERS = { turn1: 'WS_TURN_ONE_MARKER', turn2: 'WS_TURN_TWO_MARKER', resumed: 'WS_RESUMED_TURN_MARKER' };
// THE SETTING THE USER CHANGES, and its value. Temperature is used because it is something a user really changes, it
// reaches the provider body (so the change is observable on the wire as well as on disk), and it is not a string, so
// it cannot be confused with the prompt markers.
const TEMPERATURE = 0.42;
// THE MINIMUM A REAL JOURNEY PRODUCES: turn one, the swipe, turn two, regenerate, continue. Asserted absolutely, not
// by comparing two legs, because a comparison cannot see a journey that performed fewer verbs on BOTH sides.
const MINIMUM_COMPLETIONS = 5;

const replyPattern = /WS_REPLY_\d+/;
// The discriminator's own text, replaced by a marker wherever a compared field may carry it. A FIELD-PATH
// normalisation with its reason written down (differential doctrine 2), never a regex over a whole document.
const stripPrefix = value => (replyPrefix === ''
    ? String(value ?? '')
    : String(value ?? '').split(replyPrefix).join('<REPLY_PREFIX>'));

// THE DISCRIMINATOR'S ARM. The ordinal is set from the PEER'S OWN count immediately before the send that will consume
// it, so a counter that runs ahead cannot stamp the wrong reply (the failure q20-leg-runtime.mjs:143-147 records).
let stampOrdinal = null;
const replyText = ordinal => (stampOrdinal !== null && ordinal === stampOrdinal
    ? `${replyPrefix}WS_REPLY_${ordinal}`
    : `WS_REPLY_${ordinal}`);

// ---------------------------------------------------------------------------------------------------------------
// THE ARTEFACT. Written even on failure: a leg that died with no report is indistinguishable from one that never ran,
// and this project has shipped that green twice.
// ---------------------------------------------------------------------------------------------------------------

const report = {
    surface: 'whole-session',
    phase,
    subject,
    recordedAt: new Date().toISOString(),
    dataRootName: path.basename(dataRoot),
    replyPrefix,
    markers: MARKERS,
    temperatureRequested: TEMPERATURE,
    discriminator: { stampOrdinal: null, stampedText: null, appliedOnThePage: null },
    server: { baseURL: null, pid: null, spawnedAt: null, version: null, bootRefusal: null },
    steps: [],
    browser: {},
    wire: { completions: [] },
    disk: {},
    requests: { page: [], interesting: [] },
    notCompared: [
        'a real provider (AGENTS rule 22): the peer answers with markers',
        'group chats, branches and checkpoints',
        'multi-user trees',
        'chat_metadata clocks and per-message send_date: read by readChatFiles, never carried into a guard (a field that carries a clock cannot be compared across two recordings)',
        'the discriminator text itself: normalised to <REPLY_PREFIX> in every field that may carry it, and separately REQUIRED to differ between subjects',
    ],
    failure: null,
};

function step(name, ok, detail = null) {
    report.steps.push({ name, ok, detail });
    if (!ok && !report.failure) report.failure = `${name}: ${detail ?? 'failed'}`;
    return ok;
}

// ---------------------------------------------------------------------------------------------------------------
// DISK, READ THE WAY THE PRODUCT WROTE IT.
// ---------------------------------------------------------------------------------------------------------------

/**
 * The chat file carrying this journey's own first-turn marker, reduced to the fields a guard may judge.
 *
 * `send_date` and `chat_metadata`'s clock are deliberately NOT in this view: they carry a clock, so they can never be
 * compared across two independent recordings. What is kept is what a user's reload and a user's model depend on — the
 * role, the text, and the swipe state of every message — plus the header's existence.
 */
async function readDisk() {
    const files = await driveReadChatFiles(dataRoot);
    const chat = chatCarrying(files, MARKERS.turn1);
    const settings = await readSettingsFile();
    return {
        chatFileCount: files.length,
        chatFiles: files.map(file => ({ file: file.file, lines: file.lines })),
        chat: chat === null ? null : {
            file: chat.file,
            hasHeader: chat.hasHeader,
            messageCount: chat.messages.length,
            messages: chat.messages.map(message => ({
                index: message.index,
                is_user: message.is_user,
                mes: stripPrefix(message.mes),
                raw: message.mes,
                swipe_id: message.swipe_id,
                swipesCount: message.swipesCount,
                swipes: (message.swipes ?? []).map(stripPrefix),
                rawSwipes: message.swipes ?? null,
                name: message.name,
            })),
        },
        settings,
    };
}

/**
 * Find the user's setting on disk WITHOUT ASSUMING WHERE PINNED PUTS IT.
 *
 * The probe knows the value it set and records the path it actually landed at, so a comparator compares "the same
 * place" rather than two readings of two guesses. Both candidate nestings are tried because `settings.json`'s shape is
 * pinned's business, not this probe's, and inventing one would be a derivation dressed as an oracle.
 */
async function readSettingsFile() {
    const candidates = [
        { file: path.join(dataRoot, 'default-user', 'settings.json'), label: 'default-user/settings.json' },
        { file: path.join(dataRoot, 'settings.json'), label: 'settings.json' },
    ];
    for (const candidate of candidates) {
        let text = null;
        try {
            text = await fs.readFile(candidate.file, 'utf8');
        } catch {
            continue;
        }
        let json = null;
        try {
            json = JSON.parse(text);
        } catch (error) {
            return { file: candidate.label, parseError: String(error?.message ?? error) };
        }
        const paths = [['oai_settings', 'temp_openai'], ['temp_openai']];
        const found = paths.find(keys => keys.reduce((node, key) => (node === null || node === undefined ? node : node[key]), json) !== undefined);
        const value = found ? found.reduce((node, key) => (node === null || node === undefined ? node : node[key]), json) : null;
        return {
            file: candidate.label,
            bytes: Buffer.byteLength(text),
            temperaturePath: found ? found.join('.') : null,
            temperature: typeof value === 'number' ? value : null,
        };
    }
    return { file: null, missing: 'no settings.json under the data root' };
}

// ---------------------------------------------------------------------------------------------------------------
// THE SESSION.
// ---------------------------------------------------------------------------------------------------------------

const peer = await startCapturePeer({ wire: 'honour', replyText });
const port = await freePort();
const boot = await bootSubject({ argv: process.argv.slice(2), dataRoot, port, external });
const baseURL = boot.baseURL;
report.server.baseURL = baseURL;
report.server.bootRefusal = boot.bootRefusal ?? null;
const peerBase = `http://127.0.0.1:${peer.port}/v1`;
const completions = () => peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? ''));

let browser = null;
try {
    if (boot.bootRefusal) throw new Error(`subject could not be booted: ${boot.bootRefusal}`);
    report.server.pid = boot.external ? (Number(process.env.PROBE_SERVER_PID ?? 0) || null) : (boot.server?.pid ?? null);
    report.server.spawnedAt = new Date().toISOString();
    await waitForServer(`${baseURL}/version`, 120000);
    const versionResponse = await fetch(`${baseURL}/version`);
    report.server.version = { status: versionResponse.status, body: await versionResponse.json().catch(() => null) };
    step('subject-answers-version', versionResponse.status === 200 && report.server.version.body !== null,
        JSON.stringify(report.server.version));
    step('subject-process-identified', typeof report.server.pid === 'number' && report.server.pid > 0,
        `pid=${report.server.pid} (from ${boot.external ? 'PROBE_SERVER_PID, the runner that owns the pinned process' : 'the child this leg spawned'})`);

    browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', error => {
        report.browser.pageErrors = report.browser.pageErrors ?? [];
        if (report.browser.pageErrors.length < 40) report.browser.pageErrors.push(String(error?.message ?? error).slice(0, 300));
    });
    page.on('framenavigated', frame => {
        if (frame !== page.mainFrame()) return;
        report.browser.navigations = report.browser.navigations ?? [];
        report.browser.navigations.push({ url: frame.url(), at: new Date().toISOString() });
    });
    // The pinned page reaches a CDN for its libraries; the harness refuses it so no leg can depend on the internet.
    await page.route('**://testingcf.jsdelivr.net/**', route => route.abort());
    const recorder = attachUrlRecorder(page);
    const pageRequests = () => recorder.requests.map(entry => ({ method: entry.method, path: entry.pathAndQuery, status: entry.status }));

    const openPage = () => driveOpenPage(page, baseURL);
    // THE CONNECTION, THROUGH THE FRONTEND'S OWN CONTROLS. Re-applied after every reload because the peer's port is
    // ephemeral and a fresh page comes back holding the fresh-install default (q20-persistence-drive.mjs:375-379).
    const connect = async () => {
        const applied = await configureConnection(page, { url: peerBase, model: 'probe-model' });
        report.browser.connection = applied;
        return applied;
    };
    // THE PAGE'S OWN STATE READER, used at every moment the artefact compares. It reads the chat through
    // `getContext()` — NOT `SillyTavern.eventSource`, which does not exist (q20-persistence-drive.mjs:158-170).
    //
    // THE PREFIX IS PASSED IN BECAUSE A PAGE FUNCTION CANNOT SEE THIS MODULE'S HELPERS: `stripPrefix` has to be applied
    // inside the evaluation, which is also why the prefix is the ONLY thing the page is told about the comparison (it
    // cannot influence anything else).
    const readPageState = () => page.evaluate(async prefix => {
        const script = await import('./script.js');
        const context = (window.SillyTavern && window.SillyTavern.getContext) ? window.SillyTavern.getContext() : null;
        const chat = script.chat ?? [];
        const openai = await import('./scripts/openai.js');
        const normalise = text => (prefix === '' ? String(text ?? '') : String(text ?? '').split(prefix).join('<REPLY_PREFIX>'));
        return {
            settingsReady: script.settingsReady === true,
            chatId: context?.chatId ?? null,
            characterName: context?.name2 ?? context?.name ?? null,
            chatLength: chat.length,
            domMessages: document.querySelectorAll('#chat .mes').length,
            temperature: typeof openai.oai_settings?.temp_openai === 'number' ? openai.oai_settings.temp_openai : null,
            sequence: chat.map(entry => ({ role: entry?.is_user === true ? 'user' : 'assistant', text: normalise(entry?.mes) })),
            rawSequence: chat.map(entry => String(entry?.mes ?? '')),
            lastIsUser: chat[chat.length - 1]?.is_user === true,
            lastSwipes: Array.isArray(chat[chat.length - 1]?.swipes) ? chat[chat.length - 1].swipes.length : null,
            lastSwipeId: chat[chat.length - 1]?.swipe_id ?? null,
            isSendPress: script.is_send_press ?? null,
            streaming: Boolean(script.streamingProcessor),
        };
    }, replyPrefix);

    /**
     * A CHAT LOAD IS ASYNCHRONOUS, AND THE CLICK THAT TRIGGERED IT HAS ALREADY RETURNED.
     *
     * `openCharacter` resolves when the CARD is open, not when the conversation is on the page: measured in this
     * surface's first run, where the read after a reload returned `chatLength: 0` for a chat the file already held,
     * and every later step then measured a state no user would have acted on (a second turn that opened a NEW chat, a
     * regenerate whose "replaced" reply was empty). Every read that follows a reload or a reopen goes through this
     * bound instead of a sleep: it waits for the PRODUCT's own state to carry what the file holds, and fails BY NAME
     * when the budget expires rather than letting a stale read become a finding.
     */
    const waitForChatLoaded = async ({ marker = null, minimum = 2, timeoutMs = 45000 } = {}) => {
        const deadline = Date.now() + timeoutMs;
        let state = null;
        while (Date.now() < deadline) {
            state = await readPageState();
            const carries = marker === null || state.sequence.some(entry => entry.text.includes(marker));
            if (state.chatLength >= minimum && carries && state.isSendPress !== true && state.streaming !== true) {
                return { ok: true, state };
            }
            await page.waitForTimeout(250);
        }
        return { ok: false, state };
    };

    const driver = { page, recorder, openPage, connect, readPageState, pageRequests, baseURL, waitForChatLoaded };

    if (phase === 'drive') {
        await drivePhase(driver);
    } else {
        await restartPhase(driver);
    }

    report.requests.page = pageRequests();
    report.requests.interesting = pageRequests().filter(entry => /\/(api\/(settings|characters|chats)|version|thumbnail)/.test(entry.path ?? ''));
    report.wire.completions = completions().map((entry, index) => ({
        index: index + 1,
        method: entry.method,
        path: entry.path,
        byteLength: entry.byteLength,
        sha256: entry.sha256,
        body: entry.body,
        requestedStream: entry.requestedStream,
        served: entry.served,
    }));
    report.wire.count = report.wire.completions.length;
} catch (error) {
    report.failure = report.failure ?? String(error?.stack ?? error);
} finally {
    if (browser) await browser.close().catch(() => {});
    await peer.close().catch(() => {});
    if (boot.server) boot.server.kill();
    report.serverLog = boot.serverLog ?? [];
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`${subject} ${phase} leg: ${report.steps.map(entry => `${entry.ok ? 'ok' : 'FAIL'} ${entry.name}`).join(', ')}`);
    console.log(`report: ${reportPath}`);
    if (report.failure) console.error(`FAILURE: ${report.failure}`);
}

if (report.failure) process.exitCode = 1;

// ---------------------------------------------------------------------------------------------------------------
// PHASE `drive`.
// ---------------------------------------------------------------------------------------------------------------

async function drivePhase({ page, recorder, openPage, connect, readPageState, pageRequests, waitForChatLoaded }) {
    const loaded = await openPage();
    const readiness = await readReadiness(page);
    report.browser.readiness = readiness;
    step('page-loaded', loaded === true && readiness?.settingsReady === true,
        `openPage=${loaded}; readiness=${JSON.stringify(readiness)}`);
    report.browser.connectionInitial = await connect();

    // ---- 1. SETTINGS: READ, CHANGE ONE, SAVE, AND SEE IT ON DISK ---------------------------------------------
    const settingsLoaded = pageRequests().some(entry => /\/api\/settings\/get$/.test(entry.path ?? '') && entry.status === 200);
    step('settings-loaded', settingsLoaded === true,
        JSON.stringify(pageRequests().filter(entry => /settings/.test(entry.path ?? ''))));

    const settingsWrite = await page.evaluate(async temperature => {
        const script = await import('./script.js');
        const openai = await import('./scripts/openai.js');
        const before = typeof openai.oai_settings?.temp_openai === 'number' ? openai.oai_settings.temp_openai : null;
        // THE UI FIRST, because a user changes a setting through a control, and the frontend's own handler is what
        // turns that control's value into the setting.
        const control = document.querySelector('#temp_openai');
        let source = 'object';
        if (control) {
            control.value = String(temperature);
            control.dispatchEvent(new Event('input', { bubbles: true }));
            control.dispatchEvent(new Event('change', { bubbles: true }));
            source = 'slider';
        }
        let after = typeof openai.oai_settings?.temp_openai === 'number' ? openai.oai_settings.temp_openai : null;
        // THE FALLBACK IS NAMED IN THE ARTEFACT, never hidden: if the control did not carry the value the setting is
        // assigned directly and `source` says so, so the comparator can require the SAME mechanism on both subjects.
        if (after === null || Math.abs(after - temperature) > 1e-9) {
            openai.oai_settings.temp_openai = temperature;
            after = openai.oai_settings.temp_openai;
            source = control ? 'slider+object' : 'object';
        }
        let save = { called: false };
        try {
            if (typeof script.saveSettings === 'function') {
                await script.saveSettings();
                save = { called: true, via: 'saveSettings' };
            } else if (typeof script.saveSettingsDebounced === 'function') {
                script.saveSettingsDebounced();
                save = { called: true, via: 'saveSettingsDebounced' };
            }
        } catch (error) {
            save = { called: true, threw: String(error?.message ?? error) };
        }
        return { controlFound: Boolean(control), source, before, after, save };
    }, TEMPERATURE);
    report.browser.settingsWrite = settingsWrite;
    // THE SAVE IS JUDGED BY THE REQUEST AND BY THE DISK, never by a resolved promise.
    {
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
            await recorder.settled();
            if (pageRequests().some(entry => /\/api\/settings\/save$/.test(entry.path ?? '') && entry.status === 200)) break;
            await page.waitForTimeout(250);
        }
    }
    await recorder.settled();
    const settingsSaveAccepted = pageRequests().some(entry => /\/api\/settings\/save$/.test(entry.path ?? '') && entry.status === 200);
    const settingsOnDiskAfterWrite = await readSettingsFile();
    report.browser.settingsDiskAfterWrite = settingsOnDiskAfterWrite;
    step('settings-change-applied',
        settingsWrite.after !== null && Math.abs(Number(settingsWrite.after) - TEMPERATURE) < 1e-9,
        JSON.stringify({ before: settingsWrite.before, after: settingsWrite.after, source: settingsWrite.source }));
    // A 200 on the save IS the CSRF evidence: pinned's settings route sits behind the CSRF middleware, so a request
    // that arrived without the session's token cannot answer 200.
    step('settings-save-reached-the-server', settingsSaveAccepted === true,
        JSON.stringify(pageRequests().filter(entry => /settings\/save/.test(entry.path ?? ''))));
    step('settings-change-persisted', Number(settingsOnDiskAfterWrite.temperature) === TEMPERATURE,
        JSON.stringify(settingsOnDiskAfterWrite));

    // ---- 2. CHARACTERS: LIST, THEN OPEN THE CARD -----------------------------------------------------------
    const roster = await resolveRoster(page);
    report.browser.roster = roster;
    step('characters-listed', roster.count > 0, JSON.stringify(roster));
    const cardName = roster.names[0] ?? '';
    const characterOpen = await driveOpenCharacter(page, cardName);
    report.browser.characterOpen = characterOpen;
    step('character-opened', characterOpen?.opened === true,
        JSON.stringify({ wanted: cardName, opened: characterOpen?.opened ?? null, reason: characterOpen?.reason ?? null }));

    // ---- 3. SEND + STREAM: THE FIRST TURN, WHOSE REPLY CARRIES THE DISCRIMINATOR ---------------------------
    // ARMED BEFORE THE CLICK, from the peer's own count, because the click issues the request.
    stampOrdinal = completions().length + 1;
    const beforeFirstTurn = await readPageState();
    const sentFirst = await sendTurn(page, MARKERS.turn1);
    report.browser.firstTurn = { sent: sentFirst, before: beforeFirstTurn };
    let firstSettled = { ok: false, state: null };
    if (sentFirst?.clicked === true) {
        firstSettled = await waitForReply(page, {
            timeoutMs: 90000, requireText: true,
            peerCompletions: completions().length + 1,
            baseline: sentFirst.baseline ?? beforeFirstTurn,
        });
    }
    report.browser.firstTurn.settled = firstSettled;
    step('first-turn-sent', sentFirst?.clicked === true && firstSettled.ok === true,
        firstSettled.ok === true ? JSON.stringify(firstSettled.state) : JSON.stringify({ sent: sentFirst, settled: firstSettled }));
    // THE STREAM IS A FACT ABOUT WHAT THE PEER SERVED, quoted from the peer's own record: `served.wire` says what went
    // over the socket and `requestedStream` says what the page asked for, so a leg that drove a streaming page against
    // a JSON peer is visible here instead of being inferred from a missing message.
    const firstCompletion = completions()[0] ?? null;
    report.browser.firstTurn.completion = firstCompletion === null ? null
        : { requestedStream: firstCompletion.requestedStream, served: firstCompletion.served };
    step('first-turn-streamed', firstCompletion?.requestedStream === true && firstCompletion?.served?.wire === 'sse',
        JSON.stringify(report.browser.firstTurn.completion));
    const afterFirst = await readPageState();
    report.browser.afterFirstTurn = afterFirst;
    step('first-turn-rendered-the-reply', afterFirst.sequence.some(entry => replyPattern.test(entry.text)),
        JSON.stringify(afterFirst.sequence));
    // THE DISCRIMINATOR'S OWN RECORD. THE PEER'S REQUEST DOES NOT CARRY THE REPLY IT SERVES: the first version of this
    // check searched `entry.body` — what the page SENT — for the prefix, so it could only ever report a missing stamp
    // while the page was rendering it perfectly well (measured in this surface's first run: `appliedOnThePage: false`
    // beside a sequence whose last entry read `<REPLY_PREFIX>WS_REPLY_1`). It is proven on the two surfaces it actually
    // reaches: the text the peer SERVED (a function of the ordinal this leg armed) and the page's own chat, read from
    // `rawSequence` because `sequence` is already normalised.
    report.discriminator = {
        stampOrdinal,
        stampedText: replyPrefix === '' ? null : `${replyPrefix}WS_REPLY_${stampOrdinal}`,
        appliedOnThePage: replyPrefix !== '' && afterFirst.rawSequence.some(text => text.includes(replyPrefix)),
    };
    step('discriminator-applied-to-the-swipeable-reply',
        replyPrefix === '' || (report.discriminator.stampedText !== null && report.discriminator.appliedOnThePage === true),
        JSON.stringify(report.discriminator));

    // ---- 4. SWIPE THE REPLY THAT CARRIES IT ----------------------------------------------------------------
    // The frontend's own `swipe()`, with the message the clicks are wired to (`forceMesId`); the precondition is
    // asserted first so a swipe the product refuses is never read as a product finding.
    const swipePrecondition = await page.evaluate(async () => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        return {
            lastIsUser: chat[chat.length - 1]?.is_user === true,
            swipeAllowed: typeof script.isSwipingAllowed === 'function' ? script.isSwipingAllowed() : null,
            isSendPress: script.is_send_press ?? null,
            generating: Boolean(script.streamingProcessor),
        };
    });
    report.browser.swipePrecondition = swipePrecondition;
    step('swipe-precondition-reachable',
        swipePrecondition.lastIsUser === false && swipePrecondition.swipeAllowed !== false
        && swipePrecondition.isSendPress !== true && swipePrecondition.generating !== true,
        JSON.stringify(swipePrecondition));
    const swiped = await page.evaluate(async () => {
        const script = await import('./script.js');
        const constants = await import('./scripts/constants.js');
        const chat = script.chat ?? [];
        const mesId = chat.length - 1;
        const before = {
            chatLength: chat.length,
            swipeId: chat[mesId]?.swipe_id ?? null,
            swipes: Array.isArray(chat[mesId]?.swipes) ? chat[mesId].swipes.length : null,
            lastText: String(chat[mesId]?.mes ?? ''),
        };
        let error = null;
        try {
            await script.swipe(null, constants.SWIPE_DIRECTION.RIGHT, {
                source: constants.SWIPE_SOURCE.SWIPE_PICKER, repeated: false, forceMesId: mesId,
            });
        } catch (thrown) {
            error = String(thrown?.message ?? thrown);
        }
        const live = script.chat ?? [];
        return {
            before, error,
            after: {
                chatLength: live.length,
                swipeId: live[mesId]?.swipe_id ?? null,
                swipes: Array.isArray(live[mesId]?.swipes) ? live[mesId].swipes.length : null,
                lastText: String(live[mesId]?.mes ?? ''),
            },
        };
    });
    report.browser.swipe = swiped;
    step('swipe-held',
        swiped.error === null && Number(swiped.after.swipes ?? 0) > Number(swiped.before.swipes ?? 0)
        && Number(swiped.after.swipeId ?? -1) > Number(swiped.before.swipeId ?? -2),
        JSON.stringify(swiped));

    // ---- 5. SAVE, THEN RELOAD: A FRESH PAGE MUST READ THE CHAT BACK ------------------------------------------
    const saveAfterSwipe = await saveConditional(page);
    await settleQuiet(page, recorder, { quietMs: 500, maxMs: 8000 });
    const diskAfterSwipe = await readDisk();
    report.disk.afterSwipe = diskAfterSwipe;
    step('swipe-saved-the-replacement-reply',
        saveAfterSwipe?.ok === true && (diskAfterSwipe.chat?.messages ?? []).some(message => replyPattern.test(message.mes)),
        JSON.stringify({ save: saveAfterSwipe, file: diskAfterSwipe.chat?.file ?? null, messageCount: diskAfterSwipe.chat?.messageCount ?? null }));
    // AND THE DISCRIMINATOR IS ON DISK, inside the swiped message's own `swipes[]`. Asserted here, at the only moment
    // it can be attributed to the swipe, and again at the end of the journey where the comparator reads it.
    const swipedSwipes = (diskAfterSwipe.chat?.messages ?? []).flatMap(message => message.rawSwipes ?? []);
    step('disk-holds-the-per-subject-discriminator',
        replyPrefix === '' || swipedSwipes.some(text => String(text).includes(replyPrefix)),
        JSON.stringify({ replyPrefix, swipedSwipes: swipedSwipes.map(text => String(text).slice(0, 40)) }));

    // THE RELOAD. This is the step no other leg performs and the step a user performs by closing and opening the tab.
    const reloaded = await openPage();
    const reopenedAfterReload = await driveOpenCharacter(page, cardName);
    const connectionAfterReload = await connect();
    const reloadSettled = await waitForChatLoaded({ marker: MARKERS.turn1, minimum: 3 });
    const afterReload = reloadSettled.state ?? await readPageState();
    report.browser.afterReload = { openPage: reloaded, characterOpen: reopenedAfterReload, connection: connectionAfterReload, state: afterReload };
    step('reload-reopened-the-same-chat',
        reloadSettled.ok === true && afterReload.chatId !== null
        && afterReload.sequence.some(entry => entry.text.includes(MARKERS.turn1)),
        JSON.stringify({ reloadSettled: reloadSettled.ok, chatId: afterReload.chatId, chatLength: afterReload.chatLength, sequence: afterReload.sequence }));
    step('reload-carried-the-swipe-state', Number(afterReload.lastSwipes ?? 0) > 1,
        JSON.stringify({ lastSwipes: afterReload.lastSwipes, lastSwipeId: afterReload.lastSwipeId }));

    // ---- 6. THE SECOND TURN, ON THE RELOADED PAGE -----------------------------------------------------------
    const sentSecond = await sendTurn(page, MARKERS.turn2);
    let secondSettled = { ok: false, state: null };
    if (sentSecond?.clicked === true) {
        secondSettled = await waitForReply(page, {
            timeoutMs: 90000, requireText: true,
            peerCompletions: completions().length + 1,
            baseline: sentSecond.baseline ?? { chatLength: afterReload.chatLength, lastTextLength: 0 },
        });
    }
    report.browser.secondTurn = { sent: sentSecond, settled: secondSettled };
    step('second-turn-sent', sentSecond?.clicked === true && secondSettled.ok === true,
        secondSettled.ok === true ? JSON.stringify(secondSettled.state) : JSON.stringify({ sent: sentSecond, settled: secondSettled }));

    // ---- 7. REGENERATE --------------------------------------------------------------------------------------
    // The last assistant message is DELETED before the prompt is assembled (`public/script.js:4399-4406`) and a new
    // one is pushed (:6738), so the request must NOT carry the reply it replaced. That absence is a product assertion,
    // and it is what mutation C attacks.
    const regenerateCompletionsBefore = completions().length;
    const regenerated = await pressRegenerate(page);
    // THE PRESS'S OWN BEFORE/AFTER ARE HOISTED, not left inside `result`: the comparator names this verb's chat length,
    // and a guard that has to know whether a field sits under `.result` is a guard that will one day read `undefined`
    // on both sides and pass.
    report.browser.regenerate = {
        result: regenerated, completionsBefore: regenerateCompletionsBefore,
        before: regenerated?.before ?? null, after: regenerated?.after ?? null,
    };
    if (regenerated?.pressed === true) {
        const settled = await waitForReply(page, {
            timeoutMs: 90000, requireText: true,
            peerCompletions: regenerateCompletionsBefore + 1,
            baseline: { chatLength: regenerated.before?.chatLength ?? null, lastTextLength: String(regenerated.before?.lastText ?? '').length },
        });
        const request = completions()[regenerateCompletionsBefore] ?? null;
        const replacedText = String(regenerated.before?.lastText ?? '');
        report.browser.regenerate.settled = settled;
        report.browser.regenerate.request = request === null ? null : {
            index: regenerateCompletionsBefore + 1,
            bodySha256: request.sha256,
            requestedStream: request.requestedStream,
            served: request.served,
            replacedTextLength: replacedText.length,
            carriesReplacedText: replacedText.length > 0 && request.body.includes(replacedText),
        };
        // THE VACUOUS PASS IS REFUSED: with an EMPTY last message "the request does not carry the replaced reply" is
        // true of every request, so the assertion must be able to fail before it is allowed to pass.
        step('regenerate-deleted-then-replaced-the-reply',
            settled.ok === true && replacedText.length > 0
            && report.browser.regenerate.request?.carriesReplacedText === false
            && Number(settled.state?.chatLength ?? 0) === Number(regenerated.before?.chatLength ?? -1),
            JSON.stringify({ settled, request: report.browser.regenerate.request }));
    } else {
        step('regenerate-deleted-then-replaced-the-reply', false, JSON.stringify(regenerated));
    }
    await saveConditional(page);
    await settleQuiet(page, recorder, { quietMs: 500, maxMs: 8000 });

    // ---- 8. CONTINUE ----------------------------------------------------------------------------------------
    // Continue REPLACES the last message's text in place (:6719-6737) and appends no message, so its signature is a
    // GROWN text at the SAME length — the opposite of regenerate's, and the reason the two verbs cannot share an
    // assertion (mutation D is what catches a driver that points at the wrong request).
    const continueCompletionsBefore = completions().length;
    const continued = await pressContinue(page);
    report.browser.continue = {
        result: continued, completionsBefore: continueCompletionsBefore,
        before: continued?.before ?? null, after: continued?.after ?? null,
    };
    if (continued?.pressed === true) {
        const settled = await waitForReply(page, {
            timeoutMs: 90000, requireText: true,
            peerCompletions: continueCompletionsBefore + 1,
            baseline: { chatLength: continued.before?.chatLength ?? null, lastTextLength: String(continued.before?.lastText ?? '').length },
        });
        const afterContinue = await readPageState();
        const request = completions()[continueCompletionsBefore] ?? null;
        const beforeLength = String(continued.before?.lastText ?? '').length;
        const afterLength = String(afterContinue.rawSequence.at(-1) ?? '').length;
        report.browser.continue.settled = settled;
        report.browser.continue.after = afterContinue;
        report.browser.continue.request = request === null ? null : {
            index: continueCompletionsBefore + 1,
            bodySha256: request.sha256,
            requestedStream: request.requestedStream,
            served: request.served,
        };
        // SAME REFUSAL OF A VACUOUS PASS: an empty "before" makes "the text grew" a comparison of zero with a number.
        step('continue-grew-the-same-message',
            settled.ok === true && beforeLength > 0
            && Number(afterContinue.chatLength) === Number(continued.before?.chatLength)
            && afterLength > beforeLength,
            JSON.stringify({
                settled,
                before: { chatLength: continued.before?.chatLength, lastTextLength: beforeLength },
                after: { chatLength: afterContinue.chatLength, lastTextLength: afterLength },
            }));
    } else {
        step('continue-grew-the-same-message', false, JSON.stringify(continued));
    }

    // ---- 9. PERSIST, THEN RECORD THE STATE THE RESTART MUST FIND --------------------------------------------
    const finalSave = await saveConditional(page);
    await settleQuiet(page, recorder, { quietMs: 500, maxMs: 8000 });
    const finalDisk = await readDisk();
    const finalPage = await readPageState();
    report.browser.final = finalPage;
    report.disk.final = finalDisk;
    step('state-was-saved-before-the-restart',
        finalSave?.ok === true && (finalDisk.chat?.messageCount ?? 0) >= 4, JSON.stringify({
            save: finalSave,
            file: finalDisk.chat?.file ?? null,
            messageCount: finalDisk.chat?.messageCount ?? null,
            chatId: finalPage.chatId,
        }));
    // NON-VACUITY, ABSOLUTE rather than comparative: a journey of this shape produced at least five completions (turn
    // one, the swipe, turn two, regenerate, continue). A comparator that only compares two artefacts cannot see a
    // journey that performed FEWER verbs on BOTH sides; this can.
    step('journey-performed-every-wire-step', completions().length >= MINIMUM_COMPLETIONS,
        `${completions().length} completion(s): ${completions().map(entry => entry.served?.wire ?? '?').join(',')}`);
    step('settings-still-persisted-at-the-end-of-the-journey',
        Number(finalDisk.settings?.temperature) === TEMPERATURE, JSON.stringify(finalDisk.settings));
}

// ---------------------------------------------------------------------------------------------------------------
// PHASE `restart`: A NEW PROCESS, A NEW PAGE, THE SAME TREE. What the drive phase wrote, read back by something that
// did not write it.
// ---------------------------------------------------------------------------------------------------------------

async function restartPhase({ page, recorder, openPage, connect, readPageState, waitForChatLoaded }) {
    const loaded = await openPage();
    const readiness = await readReadiness(page);
    report.browser.readiness = readiness;
    step('restart-page-loaded', loaded === true && readiness?.settingsReady === true,
        `openPage=${loaded}; readiness=${JSON.stringify(readiness)}`);

    // THE SETTING MUST COME BACK WITHOUT THIS LEG WRITING IT. Read from the DISK first (nothing on the page can have
    // influenced it), then from the page (which is what proves the frontend's own load path read that file).
    const settingsOnDisk = await readSettingsFile();
    report.disk.settingsAtRestart = settingsOnDisk;
    const stateBeforeReopen = await readPageState();
    report.browser.atRestart = stateBeforeReopen;
    step('restart-read-the-setting-from-disk',
        Number(settingsOnDisk.temperature) === TEMPERATURE && Number(stateBeforeReopen.temperature) === TEMPERATURE,
        JSON.stringify({ disk: settingsOnDisk.temperature, page: stateBeforeReopen.temperature, path: settingsOnDisk.temperaturePath }));

    // THE CHAT, REOPENED BY THE NEW PROCESS FROM THE FILE THE OLD ONE WROTE.
    const roster = await resolveRoster(page);
    report.browser.roster = roster;
    step('restart-listed-the-characters', roster.count > 0, JSON.stringify(roster));
    const cardName = roster.names[0] ?? '';
    const characterOpen = await driveOpenCharacter(page, cardName);
    const reopenSettled = await waitForChatLoaded({ marker: MARKERS.turn1, minimum: 3 });
    const reopened = reopenSettled.state ?? await readPageState();
    report.browser.characterOpen = characterOpen;
    report.browser.reopened = reopened;
    step('restart-reopened-the-chat',
        reopenSettled.ok === true && characterOpen?.opened === true && reopened.chatId !== null
        && reopened.sequence.some(entry => entry.text.includes(MARKERS.turn1)),
        JSON.stringify({ reopenSettled: reopenSettled.ok, opened: characterOpen?.opened ?? null, chatId: reopened.chatId, chatLength: reopened.chatLength, sequence: reopened.sequence }));
    // THE HISTORY, BY CONTENT: both user turns this journey wrote must be in the reopened conversation, and the
    // assistant turns between them must be replies (the peer's markers), not empty records.
    const restoredReplies = reopened.sequence.filter(entry => entry.role === 'assistant' && replyPattern.test(entry.text));
    step('restart-restored-the-whole-history',
        reopened.sequence.some(entry => entry.text.includes(MARKERS.turn2)) && restoredReplies.length >= 2,
        JSON.stringify({ restoredReplies: restoredReplies.map(entry => entry.text), sequence: reopened.sequence.map(entry => `${entry.role}:${entry.text.slice(0, 32)}`) }));
    step('restart-restored-the-swipe-state', Number(reopened.lastSwipes ?? 0) >= 1,
        JSON.stringify({ lastSwipes: reopened.lastSwipes, lastSwipeId: reopened.lastSwipeId }));

    // ---- AND THEN KEEP USING IT. A new turn whose request must carry the restored history, which is the difference
    // between "the file was read" and "the session continued".
    await connect();
    const sentResumed = await sendTurn(page, MARKERS.resumed);
    let resumedSettled = { ok: false, state: null };
    if (sentResumed?.clicked === true) {
        resumedSettled = await waitForReply(page, {
            timeoutMs: 90000, requireText: true,
            peerCompletions: completions().length + 1,
            baseline: sentResumed.baseline ?? { chatLength: reopened.chatLength, lastTextLength: 0 },
        });
    }
    report.browser.resumedTurn = { sent: sentResumed, settled: resumedSettled };
    step('restart-took-another-turn', sentResumed?.clicked === true && resumedSettled.ok === true,
        resumedSettled.ok === true ? JSON.stringify(resumedSettled.state) : JSON.stringify({ sent: sentResumed, settled: resumedSettled }));

    const resumedCompletion = completions().at(-1) ?? null;
    // THE RESTORED HISTORY IS WHAT THE REQUEST CARRIED: the two user turns the drive phase wrote must appear in the
    // body, byte for byte. That is the assertion a "the page showed the right thing but the prompt was assembled from
    // somewhere else" defect cannot survive.
    report.browser.resumedTurn.request = resumedCompletion === null ? null : {
        index: completions().length,
        bodySha256: resumedCompletion.sha256,
        byteLength: resumedCompletion.byteLength,
        carriesFirstTurnMarker: resumedCompletion.body.includes(MARKERS.turn1),
        carriesSecondTurnMarker: resumedCompletion.body.includes(MARKERS.turn2),
        carriesRestoredReplies: restoredReplies.every(entry => resumedCompletion.body.includes(entry.text)),
    };
    step('restart-turn-carried-the-restored-history',
        report.browser.resumedTurn.request?.carriesFirstTurnMarker === true
        && report.browser.resumedTurn.request?.carriesSecondTurnMarker === true
        && report.browser.resumedTurn.request?.carriesRestoredReplies === true,
        JSON.stringify(report.browser.resumedTurn.request));

    await saveConditional(page);
    await settleQuiet(page, recorder, { quietMs: 500, maxMs: 8000 });
    const finalDisk = await readDisk();
    report.disk.final = finalDisk;
    report.browser.final = await readPageState();
    step('restart-persisted-the-new-turn', (finalDisk.chat?.messageCount ?? 0) >= reopened.chatLength + 2,
        JSON.stringify({ before: reopened.chatLength, after: finalDisk.chat?.messageCount ?? null, file: finalDisk.chat?.file ?? null }));
    // THE DISCRIMINATOR IS STILL THERE AFTER A RESTART, which is what lets the comparator require the two subjects to
    // differ on disk while every compared provider body agreed.
    const swipesAtRestart = (finalDisk.chat?.messages ?? []).flatMap(message => message.rawSwipes ?? []);
    step('restart-still-holds-the-per-subject-discriminator',
        replyPrefix === '' || swipesAtRestart.some(text => String(text).includes(replyPrefix)),
        JSON.stringify({ replyPrefix, swipes: swipesAtRestart.map(text => String(text).slice(0, 40)) }));
}
