// A15-GEN-CONVERSATION -- the conversation-editing half of the generation lane, driven through the UNMODIFIED pinned
// frontend with real pointer/keyboard events, on BOTH subjects, and compared on the FINAL PROVIDER REQUEST BYTES plus
// the PERSISTED CHAT on disk.
//
// WHY THIS PROBE EXISTS. Every other A15 generation probe covers a verb that already had a gate: regenerate
// (`q20-regenerate-probe.mjs`), continue (`q20-continue-probe.mjs`), persistence/swipe (`q20-persistence-probe.mjs`),
// regex (`regex-probe.mjs`), authors-note, world-info slots, helper variables. Four conversation behaviours that a
// user reaches from the message itself had ZERO coverage in this repository, checked by searching every probe for the
// pinned entry points:
//
//   * SWIPE LEFT (going BACK to an earlier swipe). The existing probes press `.swipe_right` once
//     (`combination-journey-probe.mjs`) or drive one swipe through the persistence verb; no probe ever navigates
//     BACKWARD and proves that the displayed message AND `chat[i].swipe_id` AND the persisted file move together.
//   * EDIT MESSAGE. No probe contained `.mes_edit`, `#curEditTextarea` or `.mes_edit_done`. An edit is invisible to
//     the provider unless the NEXT request's history carries the edited text, so the whole claim is a request-bytes
//     claim.
//   * DELETE MESSAGE. No probe contained `.mes_edit_delete`, `#option_delete_mes` or `deleteMessage`.
//   * A SLASH COMMAND THAT MUTATES CHAT STATE. Slash commands appear only as INPUT the probes deliberately avoid
//     (`silenceAndObserve` wraps `processCommands` because a stray command would silently swallow a send); nothing
//     executes one on purpose. `/sys` is used here because pinned's own callback (`sendNarratorMessage`,
//     public/scripts/slash-commands.js:1330+) INSERTS A MESSAGE INTO THE CHAT, so its effect is observable in three
//     independent places: the page, the chat file and the next provider request.
//
// PINNED'S SEMANTICS FOR THESE FOUR, read line by line rather than assumed:
//
//   swipe back   `.last_mes .swipe_left` -> `$(document).on('click', '.last_mes .swipe_left', ... swipe(LEFT))`
//                (public/script.js:11147). `swipe()` moves `swipe_id`, re-renders the message and does NOT start a
//                generation when the target swipe already exists; the LEFT direction is what proves the counter is a
//                real index rather than "the newest text".
//   edit         `.mes_edit` (public/script.js:11829) puts the message's own text into a REAL `<textarea
//                id="curEditTextarea">` (script.js:8264-8278); `.mes_edit_done` (script.js:11993) calls
//                `messageEditDone`, which writes `chat[i].mes`, emits MESSAGE_EDITED and saves. The next request's
//                history therefore must carry the EDITED text.
//   delete       `.mes_edit_delete` (script.js:11984) calls `deleteMessage` with
//                `power_user.confirm_message_delete` (default true, public/scripts/power-user.js:150), so a real user
//                gets a confirm popup and the drive must answer it; the deletion splices `chat` and calls
//                `saveChatDebounced` (script.js:1692-1697).
//   /sys         the slash command `sys` (public/scripts/slash-commands.js:1330) is `sendNarratorMessage`: it inserts
//                a system message, which the next `Generate` reproduces in the prompt history.
//
// THE FIVE EVIDENCE CLASSES ARE KEPT DISTINCT in every step record:
//   1. page loaded / settings ready        (openPage returns only after `settingsReady` AND `app_ready`)
//   2. script executes                     (the step's own click returned pressed/clicked true)
//   3. UI visible                          (DOM text / message count read from the rendered `#chat`, not the array)
//   4. provider request changed            (the peer's recorded body sha256 for that step)
//   5. data saved + survives reload        (the chat JSONL on disk, re-read after `saveChatConditional` and again
//                                            after a page reload)
//
// NO LIVE NETWORK. The only destination is the in-process recording peer on 127.0.0.1, selected through the
// frontend's own Custom (OpenAI-compatible) connection controls. The peer answers deterministic markers keyed by the
// request ordinal, so both subjects build the same chat history.
//
// Usage
//   Seed both legs identically:   node a15-gen-conversation-probe.mjs --seed-only <tree>
//   GoTavern leg:                 GOTAVERN_BINARY=... node a15-gen-conversation-probe.mjs --data-root <tree> --report <json>
//   Pinned leg:                   node run-against-pinned.mjs a15-gen-conversation-probe.mjs -- --data-root <tree> --report <json>
//   Compare:                      node a15-gen-compare.mjs --gotavern <json> --pinned <json>
//
// TEETH (each guard this file adds must be shown red before it is trusted; see the ledger ../a15-notes/D2.md):
//   * `character-opened` fails by name if the card name is wrong.
//   * every `*-persisted` guard fails if `saveChatConditional` is removed from the drive.
//   * `reload-*` guards fail if the reload is skipped.
//   * `*-provider-request` guards fail if the peer records no request.
//   * the request-history guards fail if the edit/delete/sys message does not reach the next body.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { argumentValue, bootSubject, freePort, repoRoot, startCapturePeer } from './q20-leg-runtime.mjs';
import {
    configureConnection, openCharacter, openPage, saveConditional, sendTurn, silenceAndObserve, waitForReply,
} from './q20-persistence-drive.mjs';
import {
    CARD, chatCarrying, chatProjection, readChatFiles, stageJourneyCard,
} from './extensions/combination-journey-kit.mjs';

const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

const TURN_1 = 'A15_GEN_TURN_1';
const TURN_2 = 'A15_GEN_TURN_2';
const TURN_3 = 'A15_GEN_TURN_3';
const EDITED = 'A15_GEN_EDITED_TEXT the message after the edit';
const SYSTEM_MARKER = 'A15_GEN_SYSTEM_MARKER';
const SLASH = `/sys ${SYSTEM_MARKER}`;

const seedOnly = argumentValue(process.argv, '--seed-only');
if (seedOnly) {
    const tree = path.resolve(seedOnly);
    const card = await stageJourneyCard(tree);
    console.log(`[seed] ${card.file} (${card.byteLength} B) staged into ${tree}`);
    process.exit(0);
}

const dataRootArgument = argumentValue(process.argv, '--data-root');
if (!dataRootArgument) {
    console.error('usage: node a15-gen-conversation-probe.mjs --data-root <tree> --report <json>');
    process.exit(2);
}
const dataRoot = path.resolve(dataRootArgument);
const reportPath = path.resolve(argumentValue(process.argv, '--report') ?? path.join(repoRoot, 'tests', 'browser', 'a15-gen-conversation-report.json'));
const external = Boolean(process.env.PROBE_BASE_URL);
const subject = external ? 'pinned' : 'gotavern';

const report = {
    schemaVersion: 1,
    question: 'Through the unmodified pinned frontend: do swipe-back, message edit, message delete and a /sys slash command produce byte-identical final provider requests and byte-identical persisted chat history under pinned Node and GoTavern?',
    subject,
    phase: 'drive',
    steps: [],
    pageErrors: [],
    consoleErrors: [],
    peerRequests: [],
    requests: [],
    snapshots: {},
    finalDisk: null,
    failure: null,
};

let peer = null;
let passed = true;
function step(name, ok, detail = null) {
    const entry = { name, ok: Boolean(ok), detail };
    report.steps.push(entry);
    if (!ok) passed = false;
    console.error(`[${subject}] ${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` :: ${JSON.stringify(detail).slice(0, 800)}`}`);
    return Boolean(ok);
}

async function readPageState(page) {
    return page.evaluate(async () => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        const last = chat[chat.length - 1] ?? null;
        return {
            chatLength: chat.length,
            last: last === null ? null : {
                name: last.name ?? null,
                isUser: last.is_user === true,
                isSystem: last.is_system === true,
                text: String(last.mes ?? ''),
                swipeId: last.swipe_id ?? null,
                swipes: Array.isArray(last.swipes) ? last.swipes.map(String) : null,
            },
            domMessageCount: document.querySelectorAll('#chat .mes').length,
            domLastText: String(document.querySelector('#chat .mes:last-child .mes_text')?.textContent ?? '').slice(0, 500),
            isSendPress: script.is_send_press ?? null,
            editingTextarea: document.querySelector('#curEditTextarea') !== null,
        };
    });
}

const completions = () => peer.requests.filter(entry => /chat\/completions/.test(entry.path ?? ''));

// THE POPUPS A REAL USER MUST ANSWER. Opening a card with embedded regex scripts (this probe's staged card carries
// one) raises pinned's own "Would you like to allow using them?" confirm (public/scripts/extensions/regex/
// embeddedScripts.html). The first run proved it is not cosmetic: the dialog covered the message list, so
// Playwright's real pointer hover on `.mes` timed out with "subtree intercepts pointer events" and the edit step
// never ran. A drive that skipped the popup would be driving a state a user cannot reach (AGENTS rule 10), so it is
// answered through the frontend's own confirmation button and recorded.
async function dismissPopups(page, label) {
    const answered = [];
    for (let round = 0; round < 6; round += 1) {
        const result = await page.evaluate(() => {
            const dialogs = [...document.querySelectorAll('dialog.popup, .popup')].filter(element => element.open === true || element.getAttribute('open') !== null || element.offsetParent !== null);
            const dialog = dialogs.find(element => element.querySelector('.popup-button-ok, .popup-button-cancel') !== null) ?? null;
            if (!dialog) return { answered: false };
            const buttons = [...dialog.querySelectorAll('button, .menu_button, .popup-button-ok, .popup-button-cancel')];
            const affirmative = dialog.querySelector('.popup-button-ok')
                ?? buttons.find(button => /yes|allow|ok|confirm|agree/i.test(String(button.textContent ?? '')))
                ?? buttons[0]
                ?? null;
            const text = String(dialog.textContent ?? '').replace(/\s+/g, ' ').slice(0, 160);
            if (!affirmative) { dialog.closest('dialog')?.close?.(); return { answered: true, text, pressed: '(closed, no button)' }; }
            const pressed = String(affirmative.textContent ?? affirmative.className ?? '').trim().slice(0, 80);
            affirmative.click();
            return { answered: true, text, pressed };
        });
        if (!result?.answered) break;
        answered.push(result);
        await page.waitForTimeout(250);
    }
    if (answered.length > 0) console.error(`[${subject}] popup(s) answered after ${label}: ${JSON.stringify(answered)}`);
    return answered;
}


async function waitFor(page, predicate, label, timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await predicate();
        if (last && last.ok === true) return { ok: true, value: last };
        await page.waitForTimeout(200);
    }
    return { ok: false, label, last, timeoutMs };
}

async function snapshot(name, page) {
    const saved = await saveConditional(page);
    if (!saved?.ok) {
        step(`snapshot-${name}-save`, false, saved);
        return null;
    }
    await page.waitForTimeout(300);
    const files = await readChatFiles(dataRoot);
    const fileNames = chatCarrying(files, TURN_1);
    const projection = fileNames.length === 0 ? null : chatProjection(files);
    const chosen = fileNames.length === 0 ? null : projection[fileNames[0]] ?? null;
    const state = await readPageState(page);
    report.snapshots[name] = { page: state, chatFiles: fileNames, chat: chosen, save: saved };
    return report.snapshots[name];
}

function diskTexts(snapshotValue) {
    return (snapshotValue?.chat?.messages ?? []).map(message => String(message.mes ?? ''));
}

async function main() {
    const port = await freePort();
    peer = await startCapturePeer({ replyText: ordinal => `A15_GEN_REPLY_${ordinal}` });
    const boot = await bootSubject({ argv: process.argv, dataRoot, port, external });
    if (boot.bootRefusal) {
        step('subject-booted', false, boot.bootRefusal);
        report.failure = boot.bootRefusal;
        throw new Error(boot.bootRefusal);
    }
    const baseURL = boot.baseURL;

    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', error => report.pageErrors.push(String(error?.message ?? error).slice(0, 400)));
    page.on('console', message => {
        if (message.type() === 'error') report.consoleErrors.push(String(message.text()).slice(0, 300));
    });
    try {
        const loaded = await openPage(page, baseURL);
        step('page-loaded', loaded === true, { settingsReady: loaded });
        const connection = await configureConnection(page, { url: `http://127.0.0.1:${peer.port}`, model: 'probe-model' });
        step('connection-configured', connection?.source === 'custom' && String(connection?.url ?? '').includes(String(peer.port)), connection);
        await silenceAndObserve(page);

        const opened = await openCharacter(page, CARD.name);
        step('character-opened', opened?.opened === true, opened);
        const chatLoaded = await waitFor(page, async () => {
            const script = await page.evaluate(async () => (await import('./script.js')).chat?.length ?? 0);
            return { ok: script > 0, chatLength: script };
        }, 'chat-loaded', 30000);
        step('chat-loaded', chatLoaded.ok === true, chatLoaded);
        report.popups = [...(report.popups ?? []), { after: 'chat-loaded', answered: await dismissPopups(page, 'chat-loaded') }];

        // ---- STEP 1: ONE NORMAL TURN ----------------------------------------------------------------
        const baseline = await readPageState(page);
        const sent1 = await sendTurn(page, TURN_1);
        const reply1 = await waitForReply(page, { baseline: sent1?.baseline, timeoutMs: 90000, peerCompletions: () => completions().length });
        const requestCount1 = await waitFor(page, async () => ({ ok: completions().length >= 1, count: completions().length }), 'turn-1-provider-request');
        step('turn-1-provider-request', requestCount1.ok === true && reply1.ok === true, { sent: sent1, reply: reply1 });
        await snapshot('turn-1', page);
        const afterTurn1 = await readPageState(page);
        step('turn-1-saved-user-and-reply', diskTexts(report.snapshots['turn-1']).includes(TURN_1) && afterTurn1.chatLength >= baseline.chatLength + 2, { texts: diskTexts(report.snapshots['turn-1']), chatLength: afterTurn1.chatLength });

        // ---- STEP 2: SWIPE RIGHT (a NEW swipe, which starts a generation) ---------------------------
        const swipeRightBeforeRequests = completions().length;
        const swipeRight = await page.evaluate(async () => {
            const script = await import('./script.js');
            const chat = script.chat ?? [];
            const id = chat.length - 1;
            const container = document.querySelector(`#chat .mes[mesid="${id}"]`);
            const control = container?.querySelector('.swipe_right') ?? null;
            const before = {
                id,
                swipeId: chat[id]?.swipe_id ?? null,
                swipes: Array.isArray(chat[id]?.swipes) ? chat[id].swipes.map(String) : null,
                text: String(chat[id]?.mes ?? ''),
            };
            if (!control) return { pressed: false, before, reason: 'no .swipe_right control on the last message' };
            control.click();
            return { pressed: true, before, controlClass: control.className };
        });
        const swipeRightMoved = await waitFor(page, async () => {
            const state = await readPageState(page);
            const last = state.last ?? {};
            return { ok: Boolean(last.swipeId === 1 && Array.isArray(last.swipes) && last.swipes.length >= 2), state: last };
        }, 'swipe-right-moved');
        const swipeRightRequest = await waitFor(page, async () => ({ ok: completions().length >= swipeRightBeforeRequests + 1, count: completions().length }), 'swipe-right-provider-request');
        step('swipe-right-started-a-request', swipeRight.pressed === true && swipeRightRequest.ok === true, { swipeRight, requests: completions().length });
        step('swipe-right-moved', swipeRightMoved.ok === true, swipeRightMoved);
        const turn1Body = String(completions()[swipeRightBeforeRequests - 1]?.body ?? '');
        const swipeRightBody = String(completions()[swipeRightBeforeRequests]?.body ?? '');
        const swipeRightState = await readPageState(page);
        step('swipe-right-displayed-the-new-swipe', swipeRightState.last?.swipeId === 1 && String(swipeRightState.domLastText).includes('A15_GEN_REPLY_2'), { swipeId: swipeRightState.last?.swipeId, domLastText: swipeRightState.domLastText });
        const rightSnapshot = await snapshot('swipe-right', page);
        step('swipe-right-persisted', (() => {
            const last = rightSnapshot?.chat?.messages?.[rightSnapshot.chat.messages.length - 1];
            return Boolean(last && last.swipe_id === 1 && Array.isArray(last.swipes) && last.swipes.length >= 2 && last.swipes[1].includes('A15_GEN_REPLY_2'));
        })(), rightSnapshot?.chat?.messages?.slice(-1) ?? null);

        // ---- STEP 3: SWIPE LEFT (BACK to the earlier swipe; must NOT request) -----------------------
        const swipeLeftBeforeRequests = completions().length;
        const swipeLeft = await page.evaluate(async () => {
            const script = await import('./script.js');
            const chat = script.chat ?? [];
            const id = chat.length - 1;
            const container = document.querySelector(`#chat .mes[mesid="${id}"]`);
            const control = container?.querySelector('.swipe_left') ?? null;
            if (!control) return { pressed: false, reason: 'no .swipe_left control on the last message' };
            control.click();
            return { pressed: true, controlClass: control.className };
        });
        const swipeLeftMoved = await waitFor(page, async () => {
            const state = await readPageState(page);
            return { ok: state.last?.swipeId === 0 && String(state.domLastText).includes('A15_GEN_REPLY_1'), state: state.last, domLastText: state.domLastText };
        }, 'swipe-left-moved', 30000);
        await page.waitForTimeout(800);
        const swipeLeftRequestCount = completions().length;
        step('swipe-left-moved-displayed-and-index', swipeLeft.pressed === true && swipeLeftMoved.ok === true, { swipeLeft, swipeLeftMoved });
        step('swipe-left-started-no-request', swipeLeftRequestCount === swipeLeftBeforeRequests, { before: swipeLeftBeforeRequests, after: swipeLeftRequestCount });
        const leftSnapshot = await snapshot('swipe-left', page);
        step('swipe-left-persisted', (() => {
            const last = leftSnapshot?.chat?.messages?.[leftSnapshot.chat.messages.length - 1];
            return Boolean(last && last.swipe_id === 0 && last.mes.includes('A15_GEN_REPLY_1'));
        })(), leftSnapshot?.chat?.messages?.slice(-1) ?? null);
        void turn1Body;
        void swipeRightBody;

        // ---- STEP 4: EDIT THE LAST MESSAGE ----------------------------------------------------------
        const editBefore = await readPageState(page);
        const editId = editBefore.chatLength - 1;
        await dismissPopups(page, 'before-edit');
        await page.hover(`#chat .mes[mesid="${editId}"]`);
        const editOpen = await page.evaluate(editedId => {
            const container = document.querySelector(`#chat .mes[mesid="${editedId}"]`);
            const control = container?.querySelector('.mes_button.mes_edit') ?? container?.querySelector('.mes_edit') ?? null;
            if (!control) return { clicked: false, reason: 'no .mes_edit control on the last message' };
            control.click();
            return { clicked: true, controlClass: control.className };
        }, editId);
        const textareaOpened = await page.waitForSelector('#curEditTextarea', { timeout: 15000 }).then(() => true).catch(() => false);
        if (textareaOpened) {
            await page.fill('#curEditTextarea', EDITED);
        }
        const editDone = await page.evaluate(doneId => {
            const container = document.querySelector(`#chat .mes[mesid="${doneId}"]`);
            const control = container?.querySelector('.mes_edit_done') ?? null;
            if (!control) return { clicked: false, reason: 'no .mes_edit_done control' };
            control.click();
            return { clicked: true };
        }, editId);
        const editSettled = await waitFor(page, async () => {
            const state = await readPageState(page);
            return { ok: String(state.last?.text ?? '') === EDITED, state: state.last, domLastText: state.domLastText };
        }, 'edit-displayed-the-edited-text', 30000);
        step('edit-clicked', editOpen.clicked === true && textareaOpened && editDone.clicked === true, { editOpen, textareaOpened, editDone });
        step('edit-displayed-the-edited-text', editSettled.ok === true && String(editSettled.value?.domLastText ?? '').includes('A15_GEN_EDITED_TEXT'), editSettled);
        const editSnapshot = await snapshot('edit', page);
        step('edit-persisted', diskTexts(editSnapshot).includes(EDITED) && !diskTexts(editSnapshot).includes('A15_GEN_REPLY_1'), { texts: diskTexts(editSnapshot) });

        // ---- STEP 5: A TURN AFTER THE EDIT, WHOSE REQUEST MUST CARRY THE EDITED TEXT ----------------
        const sent2 = await sendTurn(page, TURN_2);
        const reply2 = await waitForReply(page, { baseline: sent2?.baseline, timeoutMs: 90000, peerCompletions: () => completions().length });
        await waitFor(page, async () => ({ ok: completions().length >= 2, count: completions().length }), 'turn-2-provider-request');
        const turn2Body = String(completions()[2]?.body ?? '');
        step('turn-2-provider-request', reply2.ok === true && completions().length >= 2, { reply: reply2, requests: completions().length });
        step('turn-2-request-carries-edited-history', turn2Body.includes('A15_GEN_EDITED_TEXT') && !turn2Body.includes('A15_GEN_REPLY_1'), { bodyLength: turn2Body.length, carriesEdited: turn2Body.includes('A15_GEN_EDITED_TEXT'), carriesOldReply: turn2Body.includes('A15_GEN_REPLY_1') });
        await snapshot('turn-2', page);

        // ---- STEP 6: DELETE THE LAST MESSAGE (the turn-2 reply) -------------------------------------
        const deleteBefore = await readPageState(page);
        const deleteId = deleteBefore.chatLength - 1;
        await dismissPopups(page, 'before-delete');
        await page.hover(`#chat .mes[mesid="${deleteId}"]`);
        const deleteOpen = await page.evaluate(openId => {
            const container = document.querySelector(`#chat .mes[mesid="${openId}"]`);
            const editControl = container?.querySelector('.mes_button.mes_edit') ?? container?.querySelector('.mes_edit') ?? null;
            if (!editControl) return { clicked: false, reason: 'no .mes_edit control' };
            editControl.click();
            return { clicked: true };
        }, deleteId);
        await page.waitForSelector('#curEditTextarea', { timeout: 15000 }).catch(() => null);
        const deletePressed = await page.evaluate(async delId => {
            const container = document.querySelector(`#chat .mes[mesid="${delId}"]`);
            const control = container?.querySelector('.mes_edit_delete') ?? null;
            if (!control) return { clicked: false, reason: 'no .mes_edit_delete control' };
            control.click();
            return { clicked: true };
        }, deleteId);
        const confirmAppeared = await page.waitForSelector('.popup .popup-button-ok', { timeout: 15000 }).then(() => true).catch(() => false);
        if (confirmAppeared) {
            await page.click('.popup .popup-button-ok');
        }
        const deleteSettled = await waitFor(page, async () => {
            const state = await readPageState(page);
            return {
                ok: state.chatLength === deleteBefore.chatLength - 1 && !String(state.domLastText).includes('A15_GEN_REPLY_3'),
                state,
            };
        }, 'delete-removed-the-message', 30000);
        step('delete-clicked-and-confirmed', deleteOpen.clicked === true && deletePressed.clicked === true && confirmAppeared === true, { deleteOpen, deletePressed, confirmAppeared });
        step('delete-removed-the-message', deleteSettled.ok === true, deleteSettled);
        const deleteSnapshot = await snapshot('delete', page);
        step('delete-persisted', (() => {
            const texts = diskTexts(deleteSnapshot);
            return deleteSnapshot?.chat?.messages?.length === deleteBefore.chatLength - 1 && !texts.some(text => text.includes('A15_GEN_REPLY_3'));
        })(), { messages: deleteSnapshot?.chat?.messages?.length ?? null, texts: diskTexts(deleteSnapshot) });

        // ---- STEP 7: /sys SLASH COMMAND INSERTING A SYSTEM MESSAGE ---------------------------------
        const slashBefore = { requests: completions().length, state: await readPageState(page) };
        await page.fill('#send_textarea', SLASH);
        await page.press('#send_textarea', 'Enter');
        const slashSettled = await waitFor(page, async () => {
            const state = await readPageState(page);
            return { ok: Boolean((state.last?.isSystem === true || state.last?.name === 'System') && String(state.last?.text ?? '').includes(SYSTEM_MARKER)), state };
        }, 'slash-inserted-a-system-message', 30000);
        await page.waitForTimeout(800);
        step('slash-executed', slashSettled.ok === true, slashSettled);
        step('slash-started-no-provider-request', completions().length === slashBefore.requests, { before: slashBefore.requests, after: completions().length });
        const slashSnapshot = await snapshot('slash', page);
        step('slash-persisted', (() => {
            const systemMessages = (slashSnapshot?.chat?.messages ?? []).filter(message => String(message.mes ?? '').includes(SYSTEM_MARKER));
            return systemMessages.length >= 1 && (systemMessages[0].is_system === true || systemMessages[0].name === 'System');
        })(), slashSnapshot?.chat?.messages?.filter(message => String(message.mes ?? '').includes(SYSTEM_MARKER)) ?? null);

        // ---- STEP 8: A TURN AFTER /sys, WHOSE REQUEST MUST CARRY THE SYSTEM MESSAGE -----------------
        const sent3 = await sendTurn(page, TURN_3);
        const reply3 = await waitForReply(page, { baseline: sent3?.baseline, timeoutMs: 90000, peerCompletions: () => completions().length });
        await waitFor(page, async () => ({ ok: completions().length >= 4, count: completions().length }), 'turn-3-provider-request');
        const turn3Body = String(completions()[3]?.body ?? '');
        step('turn-3-provider-request', reply3.ok === true && completions().length >= 4, { reply: reply3, requests: completions().length });
        step('turn-3-request-carries-the-system-message', turn3Body.includes(SYSTEM_MARKER) && turn3Body.includes(TURN_3), { carriesSystem: turn3Body.includes(SYSTEM_MARKER), carriesTurn3: turn3Body.includes(TURN_3), bodyLength: turn3Body.length });
        step('turn-3-request-does-not-carry-the-deleted-reply', !turn3Body.includes('A15_GEN_REPLY_3'), { carriesDeletedReply: turn3Body.includes('A15_GEN_REPLY_3'), bodyLength: turn3Body.length });
        await snapshot('turn-3', page);

        // ---- STEP 9: SAVE, RELOAD, AND RE-READ THE PERSISTED HISTORY --------------------------------
        await saveConditional(page);
        await page.reload({ waitUntil: 'domcontentloaded' });
        const reloaded = await openPage(page, baseURL);
        await configureConnection(page, { url: `http://127.0.0.1:${peer.port}`, model: 'probe-model' });
        await openCharacter(page, CARD.name);
        await dismissPopups(page, 'after-reload');
        const savedBeforeReload = await readChatFiles(dataRoot);
        const savedNames = chatCarrying(savedBeforeReload, TURN_3);
        const savedChatName = savedNames.length === 0 ? null : path.basename(savedNames[0]).replace(/\.jsonl$/, '');
        let chatPicker = null;
        if (savedChatName !== null) {
            const openedPicker = await page.evaluate(() => {
                const control = document.querySelector('#option_select_chat');
                if (!control) return { clicked: false, reason: 'no #option_select_chat control' };
                control.click();
                return { clicked: true };
            });
            const pickerVisible = await page.waitForSelector('#select_chat_popup', { timeout: 15000 }).then(() => true).catch(() => false);
            const picked = pickerVisible ? await page.evaluate(name => {
                const blocks = [...document.querySelectorAll('#select_chat_div .select_chat_block')];
                const match = blocks.find(block => String(block.textContent ?? '').includes(name) || String(block.getAttribute('file_name') ?? '').includes(name));
                if (!match) return { clicked: false, candidateCount: blocks.length, wanted: name };
                match.click();
                return { clicked: true, candidateCount: blocks.length, wanted: name };
            }, savedChatName) : { clicked: false, pickerVisible: false, wanted: savedChatName };
            chatPicker = { openedPicker, pickerVisible, picked, savedChatName };
            if (picked.clicked === true) {
                await page.waitForTimeout(1500);
            }
        }
        const reloadSettled = await waitFor(page, async () => {
            const state = await readPageState(page);
            const script = await page.evaluate(async () => (await import('./script.js')).chat ?? []);
            const texts = script.map(message => String(message?.mes ?? ''));
            return { ok: reloaded === true && texts.some(text => text.includes(TURN_3)) && texts.some(text => text.includes('A15_GEN_EDITED_TEXT')), texts };
        }, 'reload-reads-the-edited-history', 60000);
        step('reload-page-loaded', reloaded === true, { settingsReady: reloaded });
        step('reload-reads-the-edited-history', reloadSettled.ok === true, { reloadSettled, chatPicker });

        const finalFiles = await readChatFiles(dataRoot);
        const finalNames = chatCarrying(finalFiles, TURN_1);
        const finalProjection = finalNames.length === 0 ? null : chatProjection(finalFiles);
        report.finalDisk = finalNames.length === 0 ? null : { files: finalNames, chats: Object.fromEntries(finalNames.map(name => [name, finalProjection[name]])) };
        step('final-disk-has-the-chat', finalNames.length > 0, { files: finalNames });
        step('final-disk-carries-all-three-turns-and-the-edit', (() => {
            const texts = (report.finalDisk?.chats?.[finalNames[0]]?.messages ?? []).map(message => String(message.mes ?? ''));
            return [TURN_1, TURN_2, TURN_3, 'A15_GEN_EDITED_TEXT'].every(marker => texts.some(text => text.includes(marker)))
                && !texts.some(text => text.includes('A15_GEN_REPLY_3'));
        })(), { texts: (report.finalDisk?.chats?.[finalNames[0]]?.messages ?? []).map(message => String(message.mes ?? '')) });

        report.requests = completions().map((entry, index) => ({ index, method: entry.method, path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256, body: entry.body }));
        step('four-provider-requests-recorded', report.requests.length === 4, { requests: report.requests.map(entry => `${entry.path} ${entry.byteLength}B ${entry.sha256.slice(0, 12)}`) });
        step('no-page-errors', report.pageErrors.length === 0, { pageErrors: report.pageErrors.slice(0, 8), consoleErrors: report.consoleErrors.slice(0, 8) });
    } catch (error) {
        step('drive-completed', false, String(error?.stack ?? error));
        report.failure = String(error?.message ?? error);
    } finally {
        report.peerRequests = (peer?.requests ?? []).map(entry => ({ method: entry.method, path: entry.path, byteLength: entry.byteLength, sha256: entry.sha256, requestedStream: entry.requestedStream, served: entry.served }));
        await browser.close().catch(() => { });
        if (boot.server) boot.server.kill('SIGKILL');
        await peer?.close().catch(() => { });
    }
    report.passed = passed && report.failure === null;
    if (report.failure === null && !report.passed) {
        report.failure = report.steps.find(entry => !entry.ok)?.name ?? 'unknown';
    }
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.error(`[${subject}] report written to ${reportPath} (passed=${report.passed}, failure=${report.failure ?? 'none'})`);
    process.exit(report.passed ? 0 : 1);
}

await main();
