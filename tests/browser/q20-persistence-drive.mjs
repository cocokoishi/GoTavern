// Q20's DRIVE, SHARED BY EVERY Q20 LEG -- importable, so a leg that starts from a chat another run wrote uses the
// SAME code as the leg that wrote it. (AGENTS.md rule 3: the two subjects of a comparison may share browser-driving
// mechanics; they must not share an expectation.)
//
// WHY THIS FILE EXISTS RATHER THAN A SECOND PROBE. Q20 grew a second pair of verbs -- regenerate and continue -- and
// those legs need the first leg's chat: the pinned leg of the regenerate pair must OPEN the tree the GoTavern leg
// wrote, or the two subjects would not be regenerate-ing the same conversation. Two options existed:
//   (a) copy the open/select/send/record code into the new probe. That is the parallel harness this lane was told
//       not to build: the copy drifts, and the half that drifts is the one nobody re-reads;
//   (b) lift the drive into a module both probes import. Chosen.
// Nothing about the DRIVE changed in the lift: `q20-persistence-probe.mjs` calls these functions in the same order
// with the same arguments, records the same fields, and asserts the same steps. The one genuine change is
// `openCharacter(name)`: the drive used to take `#rm_print_characters_block .character_select` and never checked
// WHICH card it opened, so a second leg handed a tree with two cards could regenerate in the wrong chat (this
// lane's own brief: assert chat identity, never "the first card that renders").
//
// WHAT A CALLER OWNS AND THIS MODULE DOES NOT: the data root, the server process, the peer, the browser, the
// repository-level `step()`/`report.failure` bookkeeping, and the endpoint counting. All of those differ between a
// leg that boots its own GoTavern binary and a leg driven by `run-against-pinned.mjs`, and none of them is part of
// "how a user opens a chat and presses a button".

import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------------------------------------------
// CHAT FILES THE PRODUCT WROTE. Read from disk, never written by a leg.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Every *.jsonl under `<dataRoot>/<handle>/chats`, with the fields a Q20 guard judges.
 *
 * `file` is RELATIVE to `<dataRoot>/<handle>` on purpose: it is the chat's identity as the product names it
 * (`chats/<card>/<chat>.jsonl`), so two legs that wrote the same chat produce the same string, and a host path
 * never reaches an artefact (the sweep in AGENTS rule 18 is what enforces the second half of that).
 */
export async function readChatFiles(dataRoot, handle = 'default-user') {
    const chatsRoot = path.join(dataRoot, handle, 'chats');
    const found = [];
    const walk = async directory => {
        let entries = [];
        try {
            entries = await fs.readdir(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) await walk(full);
            else if (entry.name.endsWith('.jsonl')) {
                const body = await fs.readFile(full, 'utf8');
                found.push({
                    file: path.relative(path.join(dataRoot, handle), full),
                    bytes: Buffer.byteLength(body),
                    sha256: createHash('sha256').update(body).digest('hex'),
                    lines: body.split('\n').filter(line => line.trim().length > 0).length,
                    messages: body.split('\n').filter(line => line.trim().length > 0).map(line => {
                        try {
                            return JSON.parse(line);
                        } catch {
                            return null;
                        }
                    }).filter(Boolean),
                });
            }
        }
    };
    await walk(chatsRoot);
    return found;
}

export const carries = (files, marker) => files.some(file => (file.messages ?? []).some(message => String(message?.mes ?? '').includes(marker)));

/**
 * The chat this leg is about: the one file that carries `marker`, with the fields a guard compares.
 *
 * THE HEADER LINE IS NOT A MESSAGE. Measured in run 40445671791: a pinned/GoTavern `.jsonl` begins with a
 * HEADER record (`{chat_metadata, user_name: 'unused', character_name: 'unused'}`, written by
 * `saveChat`'s `chat: [chatHeader, ...trimmedChat]`, public/script.js:7446-7452) and every later line is a
 * message. `messages[length - 1]` on the RAW lines therefore pointed at the GREETING, not at the message the leg
 * had just swiped -- and the guard built on it failed on both subjects while the file was in fact correct (the
 * real message 5 held `swipes: 2, swipe_id: 1`, exactly what the page reported). `messages` here is header-stripped
 * and `index` is the message index the PAGE uses (0 = greeting), so `report.swipe.before.mesId` and this index are
 * the same namespace. `lines` stays the raw line count, because that is what the file holds.
 */
export function chatCarrying(files, marker) {
    const file = (files ?? []).find(candidate => carries([candidate], marker));
    if (!file) return null;
    // A header record is the first line and is recognisable by its own keys, not by position alone.
    const isHeader = record => Boolean(record) && (Object.prototype.hasOwnProperty.call(record, 'chat_metadata')
        || Object.prototype.hasOwnProperty.call(record, 'user_name'));
    const body = (file.messages ?? []).filter(record => !isHeader(record));
    return {
        file: file.file,
        sha256: file.sha256,
        lines: file.lines,
        hasHeader: (file.messages ?? []).length > 0 && isHeader((file.messages ?? [])[0]),
        messages: body.map((message, index) => ({
            index,
            is_user: message?.is_user === true,
            mes: String(message?.mes ?? ''),
            swipe_id: message?.swipe_id ?? null,
            swipes: Array.isArray(message?.swipes) ? message.swipes.map(swipe => String(swipe ?? '')) : null,
            swipesCount: Array.isArray(message?.swipes) ? message.swipes.length : null,
            extra: message?.extra ?? null,
            name: message?.name ?? null,
        })),
    };
}

// ---------------------------------------------------------------------------------------------------------------
// THE PAGE, READY THE WAY THE FRONTEND'S OWN CODE DECIDES IT IS READY.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Load the page and wait for `settingsReady`, the flag `script.js` itself checks before it installs listeners.
 *
 * The 90 s bound and the onboarding dismissal are the ones the first leg measured (run 40269030050: a `#send_but`
 * click before `settingsReady` emptied the chat). Returns true only if the flag was observed true.
 */
export async function openPage(page, baseURL) {
    await page.goto(`${baseURL}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction('document.getElementById("preloader") === null', null, { timeout: 120000 });
    return page.evaluate(async () => {
        const script = await import('./script.js');
        const started = performance.now();
        while (performance.now() - started < 90000) {
            if (script.settingsReady) return true;
            const onboarding = document.querySelector('.popup .onboarding');
            if (onboarding) {
                const input = onboarding.closest('.popup')?.querySelector('.popup-input');
                if (input) {
                    input.value = 'Probe User';
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                onboarding.closest('.popup')?.querySelector('.popup-button-ok')?.click();
            }
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        return false;
    });
}

/**
 * Open a card BY THE NAME THE PRODUCT CALLS IT, and REFUSE -- never fall back -- when it cannot.
 *
 * WHY THE NAME IS REQUIRED AND THE FIRST CARD IS NOT AN OPTION. The original took the FIRST `.character_select` it
 * found. That is not a precondition a real user has: "whichever card renders" cannot tell two subjects apart when a
 * tree holds two cards, and it would let a regenerate leg re-run a generation on a different chat from the one it
 * compares. This lane's whole subject is "the same chat, the same message index, the same file", so a fallback is a
 * silent false pass. Both call sites therefore pass the name the workflow read out of the FIRST leg's artefact.
 *
 * THE REFUSAL IS A VALUE, NOT A THROW, so the caller records it in the leg's `steps`/`failure` and the run says
 * which name was wanted and which roster the page actually had -- the shape that distinguishes "the product has no
 * card" from "my selector is wrong" (AGENTS rule 5). `wanted` is the CHARACTER's own `data.name`
 * (`script.characters[i].name`), which is what the card list shows a user.
 *
 * WHAT IS RECORDED IS THE IDENTITY THE PAGE ITSELF BELIEVES: `characterName` (from `script.characters[this_chid]`),
 * `thisChid`, the page's `chatId`, and the DOM message count -- so a caller compares what was opened instead of
 * trusting the click.
 */
export async function openCharacter(page, expected) {
    if (typeof expected !== 'string' || expected.length === 0) {
        return { opened: false, clicked: false, wanted: expected ?? null, reason: 'REFUSED: openCharacter requires the card name the first leg opened; "the first card that renders" is not a precondition a user has' };
    }
    return page.evaluate(async wanted => {
        const script = await import('./script.js');
        const characterName = entry => String(entry?.name ?? '');
        const roster = () => (script.characters ?? []).map(characterName);
        const deadline = Date.now() + 60000;
        let chid = null;
        let waitedForRoster = 0;
        while (Date.now() < deadline) {
            const characters = script.characters ?? [];
            // THE ROSTER IS POLLED, AND THE WAIT IS BOUNDED AND RECORDED. A card list that is still loading is not a
            // missing card; a page that never lists it is. Which one happened is `rosterWaitMs`.
            const position = characters.findIndex(entry => characterName(entry) === String(wanted));
            if (position < 0) {
                waitedForRoster = 60000 - Math.max(0, deadline - Date.now());
                await new Promise(resolve => setTimeout(resolve, 250));
                continue;
            }
            chid = String(position);
            const candidates = [...document.querySelectorAll('#rm_print_characters_block .character_select, #rm_print_characters_block .avatar[data-type="character"]')];
            const card = candidates.find(element => String(element.getAttribute('data-chid')) === chid) ?? null;
            if (card) {
                const dataChid = card.getAttribute('data-chid');
                card.click();
                // The page's own `getChat()` creates a fresh chat and saves it (script.js:7694), so the wait is on
                // the PRODUCT's state: a chat id or a rendered message.
                const settle = Date.now() + 30000;
                while (Date.now() < settle) {
                    if ((script.chat ?? []).length > 0) break;
                    await new Promise(resolve => setTimeout(resolve, 250));
                }
                const context = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
                return {
                    opened: true,
                    clicked: true,
                    wanted: String(wanted),
                    rosterWaitMs: waitedForRoster,
                    cardClass: card.className,
                    dataChid,
                    thisChid: script.this_chid ?? null,
                    characterName: script.characters?.[script.this_chid]?.name ?? null,
                    characterChat: script.characters?.[script.this_chid]?.chat ?? null,
                    // THE IDENTITY A COMPARATOR NEEDS, named: the page's chat id and the file it resolves to.
                    chatId: context?.chatId ?? null,
                    chatLength: (script.chat ?? []).length,
                    messages: document.querySelectorAll('#chat .mes').length,
                };
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        return {
            opened: false,
            clicked: false,
            wanted: String(wanted),
            rosterWaitMs: waitedForRoster,
            reason: `no card named ${JSON.stringify(String(wanted))} in #rm_print_characters_block`,
            roster: roster(),
            chatLength: (script.chat ?? []).length,
            messages: document.querySelectorAll('#chat .mes').length,
        };
    }, expected);
}

// ---------------------------------------------------------------------------------------------------------------
// THE CONNECTION, THROUGH THE FRONTEND'S OWN CONTROLS.
// ---------------------------------------------------------------------------------------------------------------

const CONFIGURE = async ({ url, model }) => {
    const set = (selector, value) => {
        const control = document.querySelector(selector);
        if (!control) return false;
        control.value = value;
        control.dispatchEvent(new Event('input', { bubbles: true }));
        control.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
    };
    // `chat_completion_source` IS NOT `main_api`. Run 40375075025 recorded `mainApi: "koboldhorde"` at the click:
    // the leg had configured the custom endpoint but the API SWITCH still pointed at the fresh-install default, so
    // Generate took the Horde path and quietly did nothing on both subjects. `changeMainAPI` is script.js:7756, the
    // frontend's own switch, and it also sets `#main_api` so the rest of the page agrees. A fresh page forgets it
    // (run 40381923526), which is why every caller that reloads re-applies this.
    const scriptModule = await import('./script.js');
    scriptModule.changeMainAPI('openai');
    set('#main_api', 'openai');
    set('#chat_completion_source', 'custom');
    set('#custom_api_url_text', url);
    set('#custom_model_id', model);
    set('#api_key_custom', 'probe-key');
    const openai = await import('./scripts/openai.js');
    // THE SAME OBJECT `getContext().powerUserSettings` RESOLVES TO, imported directly. Run 40298378524 measured what
    // the context route costs: the first turn's `page.evaluate` threw
    // "TypeError: Cannot set properties of undefined (setting 'savingAfterComplete')" on BOTH subjects, because
    // `script.js` has no named `powerUserSettings` export -- openai.js gets it from `./power-user.js` (:46).
    const power = await import('./scripts/power-user.js');
    power.power_user.savingAfterComplete = false;
    return {
        source: openai.oai_settings.chat_completion_source ?? null,
        url: openai.oai_settings.custom_url ?? null,
        savingAfterComplete: power.power_user.savingAfterComplete ?? null,
        // THE CONTINUE MECHANISM'S OWN SETTINGS, read back rather than assumed. `continue_prefill` decides between
        // two DIFFERENT provider requests (a displaced prefill message vs an appended nudge made of the history
        // tail plus `continue_nudge_prompt`), so which branch ran has to be in the artefact, not in a comment.
        continuePrefill: openai.oai_settings.continue_prefill ?? null,
        continueNudgePrompt: openai.oai_settings.continue_nudge_prompt ?? null,
        continuePostfix: openai.oai_settings.continue_postfix ?? null,
        sendIfEmpty: openai.oai_settings.send_if_empty ?? null,
        continueOnSend: power.power_user.continue_on_send ?? null,
    };
};

export const configureConnection = (page, { url, model }) => page.evaluate(CONFIGURE, { url, model });

/**
 * Keep `savingAfterComplete` false and record `processCommands`, the one silent exit between a send and a request.
 *
 * `processCommands` is the ONLY return path in `Generate('normal')` that produces no message and no request
 * (script.js:4310-4318: `if (interruptedByCommand) { unblockGeneration(type); return Promise.resolve(); }`), and it
 * consumes `#send_textarea` -- the same value a leg sets. It cannot be observed from outside, so it is wrapped for
 * the send window and its verdict is recorded. A slash command in the textarea would make every later conclusion
 * about "did the turn reach the model" a guess.
 */
export const silenceAndObserve = page => page.evaluate(async () => {
    const power = await import('./scripts/power-user.js');
    power.power_user.savingAfterComplete = false;
    const script = await import('./script.js');
    if (!window.__q20ProcessCommandsWrapped) {
        window.__q20ProcessCommandsWrapped = true;
        window.__q20ProcessCommands = [];
        const original = script.processCommands;
        if (typeof original === 'function') {
            script.processCommands = async function (text) {
                const result = await original.apply(this, arguments);
                window.__q20ProcessCommands.push({ text: String(text ?? '').slice(0, 120), interrupted: result === true });
                return result;
            };
        }
    }
    return {
        savingAfterComplete: power.power_user.savingAfterComplete ?? null,
        processCommandsWrapped: window.__q20ProcessCommandsWrapped === true,
        processCommandsWasFunction: typeof script.processCommands === 'function',
    };
});

export const readProcessCommands = page => page.evaluate(() => window.__q20ProcessCommands ?? []);

/**
 * WAIT FOR THE PRODUCT'S OWN STATE AFTER A SEND, AND FAIL BY NAME WHEN IT NEVER ARRIVES.
 *
 * WHY A NAMED FAILURE AND NOT A SLEEP, NOT A RETRY. Measured across runs 40444282138 / 40445671791 / 40448869208: the
 * second turn's reply did not always land before the leg acted on it, and in 40448869208 that produced a swipe of a
 * USER message -- a state the frontend itself refuses (`isSwipingAllowed()` false), so every downstream guard was
 * measuring something a user cannot produce. A fixed sleep converts that into a slow flake; a retry converts it into
 * a hidden one. What is wanted is a RED WITH A NAME and the first observation attached, which is the only form this
 * project can act on (AGENTS rule 10: "no failure reported, but the expected outcome did not happen" is a
 * probe-faithfulness alarm).
 *
 * THE CONDITIONS ARE THE PRODUCT'S, read from the page rather than assumed:
 *   lastIsUser === false   a reply exists and is the last message. Read from the LAST message rather than from the
 *                          length, because the two verbs differ: a normal turn appends (`:6738`) while continue
 *                          replaces the last message's text in place (`:6719-6737`), so a length check would pass for
 *                          one and fail for the other.
 *   not busy               `is_send_press` false and no `streamingProcessor` -- which is the same gate the next
 *                          control checks for itself (script.js:11634 `is_send_press == false`, :11655). Waiting on it
 *                          means the next press is a user-reachable action rather than one the page is refusing.
 *   has text               when `requireText` is set, the last message's text is non-empty. This condition was FALSE
 *                          on BOTH subjects in run 40445671791 (measured: `mesLen: 0`), so it is checked and reported
 *                          rather than assumed away.
 *
 * THE FAILURE CARRIES THE FALSIFIER: `peerCompletions` is how many chat-completion requests the peer had recorded at
 * that moment. If it did not move, the request never left the page; if it moved, the page received an answer and did
 * not store it. Those are different findings and a boolean cannot tell them apart.
 */
export async function waitForReply(page, { timeoutMs = 60000, requireText = true, peerCompletions = null } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
        last = await page.evaluate(async () => {
            const script = await import('./script.js');
            const context = window.SillyTavern && window.SillyTavern.getContext ? window.SillyTavern.getContext() : null;
            const chat = script.chat ?? [];
            const tail = chat[chat.length - 1] ?? null;
            return {
                chatLength: chat.length,
                chatId: context?.chatId ?? null,
                lastIsUser: tail?.is_user === true,
                lastTextLength: String(tail?.mes ?? '').length,
                isSendPress: script.is_send_press ?? null,
                streamingProcessor: Boolean(script.streamingProcessor),
                // WHAT A USER WOULD SEE, quoted into the failure instead of a bare boolean.
                domLastText: String(document.querySelector('#chat .mes:last-child .mes_text')?.textContent ?? '').slice(0, 200),
            };
        });
        const settled = last.lastIsUser === false && last.isSendPress !== true && last.streamingProcessor !== true;
        const hasText = requireText ? last.lastTextLength > 0 : true;
        if (settled && hasText) {
            return { ok: true, state: last, waitedMs: timeoutMs - Math.max(0, deadline - Date.now()) };
        }
        await page.waitForTimeout(250);
    }
    return {
        ok: false,
        name: 'setup-reply-did-not-arrive',
        state: last,
        waitedMs: timeoutMs,
        peerCompletions,
        // THE READINGS THAT SEPARATE THE FINDINGS, stated so a log line is self-explanatory.
        reading: last?.lastIsUser === true
            ? 'the last message is still the USER turn: no assistant message was created'
            : (last?.lastTextLength === 0
                ? 'an assistant message exists but its text is EMPTY: the reply was created without content'
                : (last?.isSendPress === true || last?.streamingProcessor === true
                    ? 'the page is still GENERATING: the reply never settled'
                    : 'the page settled in a state that satisfies no expected condition')),
    };
}


// ---------------------------------------------------------------------------------------------------------------
// ONE TURN, THROUGH THE FRONTEND'S OWN SEND, AND ONE REGENERATE.
// ---------------------------------------------------------------------------------------------------------------

/**
 * Click `#send_but` with `marker` in the textarea, after waiting for the frontend's own readiness flag.
 *
 * RUN STATE IS READ BEFORE THE CLICK, which is what keeps this drive faithful (AGENTS rule 10): `Generate` has two
 * silent early returns that produce exactly this leg's "events fire, then nothing" symptom, and
 * `option_regenerate`/`option_continue` are guarded on `is_send_press` and the swipe-edit state. A leg that clicked
 * while the page was still mid-operation would be driving a state a user cannot reach.
 */
export async function sendTurn(page, marker) {
    return page.evaluate(async text => {
        const pageContext = (window.SillyTavern && window.SillyTavern.getContext) ? window.SillyTavern.getContext() : null;
        const missingInputs = [];
        const readInput = (label, read) => {
            try { return read(); } catch (error) { missingInputs.push(`${label}: ${String(error && error.message || error)}`); return null; }
        };
        const frontend = await import('./script.js');
        const kai = await import('./scripts/kai-settings.js');
        const clickStartedAt = Date.now();
        const readyDeadline = Date.now() + 60000;
        while (Date.now() < readyDeadline && frontend.settingsReady !== true) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const readyWaitMs = Date.now() - clickStartedAt;
        const settingsReadyAtClick = frontend.settingsReady === true;
        const silentExitInputs = {
            mainApi: readInput('mainApi', () => pageContext.mainApi),
            kaiStreamingKobold: readInput('kaiStreamingKobold', () => Boolean(kai.kai_settings && kai.kai_settings.streaming_kobold)),
            kaiCanUseStreaming: readInput('kaiCanUseStreaming', () => Boolean(kai.kai_flags && kai.kai_flags.can_use_streaming)),
            selectedGroup: readInput('selectedGroup', () => Boolean(pageContext.groupId)),
            hordeBlocked: (() => {
                try { return typeof frontend.isHordeGenerationNotAllowed === 'function' ? Boolean(frontend.isHordeGenerationNotAllowed()) : null; }
                catch (error) { return `threw: ${String(error && error.message || error)}`; }
            })(),
        };
        const textarea = document.querySelector('#send_textarea');
        const button = document.querySelector('#send_but');
        if (!textarea || !button) return { clicked: false, reason: 'send controls missing' };
        textarea.value = text;
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        button.click();
        return { clicked: true, textareaValue: textarea.value, settingsReadyAtClick, readyWaitMs, silentExitInputs, missingInputs };
    }, marker);
}

/**
 * Press the REAL regenerate control (`#option_regenerate`, index.html:8181) and say whether the page acted on it.
 *
 * WHY THIS ENTRY POINT AND NOT `Generate('regenerate')`. The control is what a user presses, and it is the only
 * place pinned's own guards live (script.js:11629-11641):
 *   `chat.length - 1 === this_edit_mes_id && chat[this_edit_mes_id]?.is_user == false` -> refuses while editing;
 *   `is_send_press == false`                                      -> refuses while a generation is running;
 *   `selected_group` -> regenerateGroup(); else `Generate('regenerate', ...)`.
 * A driver that called `Generate` directly would skip all three, and could then report "the product does not
 * regenerate" while the product was correctly refusing a state the driver had manufactured (AGENTS rule 10, the
 * inverse error). The control's state before the press is recorded for the same reason: a control a user cannot see
 * or a guard that is latched is a fact about the state, not about the backend, and the artefact must carry it.
 *
 * The press is a DOM click, which is what makes `#options [id]`'s delegated handler (script.js:11581) run. That
 * handler is attached to the menu, so the menu must not have been detached; the click itself does not need the
 * menu to be VISIBLE (a jQuery handler fires on a hidden element), but the element's presence does.
 */
export async function pressRegenerate(page) {
    return page.evaluate(async () => {
        const script = await import('./script.js');
        const context = (window.SillyTavern && window.SillyTavern.getContext) ? window.SillyTavern.getContext() : null;
        const chat = script.chat ?? [];
        const before = {
            controlFound: document.querySelector('#option_regenerate') !== null,
            controlConnected: document.querySelector('#option_regenerate')?.isConnected === true,
            chatLength: chat.length,
            thisEditMesId: script.this_edit_mes_id ?? null,
            lastIsUser: chat[chat.length - 1]?.is_user === true,
            isSendPress: script.is_send_press ?? null,
            selectedGroup: context?.groupId ?? null,
            streamingProcessor: Boolean(script.streamingProcessor),
            chatId: context?.chatId ?? null,
            lastMessage: {
                mes: String(chat[chat.length - 1]?.mes ?? ''),
                swipe_id: chat[chat.length - 1]?.swipe_id ?? null,
                swipes: Array.isArray(chat[chat.length - 1]?.swipes) ? chat[chat.length - 1].swipes.slice() : null,
                send_date: chat[chat.length - 1]?.send_date ?? null,
                name: chat[chat.length - 1]?.name ?? null,
                gen_started: chat[chat.length - 1]?.gen_started ?? null,
            },
        };
        const control = document.querySelector('#option_regenerate');
        if (!control) return { pressed: false, before, reason: 'the regenerate control (#option_regenerate) is not in the page' };
        control.click();
        // The control returns immediately (`Generate` is not awaited by the handler), so the OUTCOME is polled on the
        // frontend's own state: `is_send_press` becomes true as the generation starts, and the last message's text
        // changes when the reply lands. Bounded, and reported either way.
        const deadline = Date.now() + 30000;
        let sawBusy = false;
        let state = null;
        while (Date.now() < deadline) {
            const live = script.chat ?? [];
            state = {
                chatLength: live.length,
                lastIsUser: live[live.length - 1]?.is_user === true,
                lastText: String(live[live.length - 1]?.mes ?? '').slice(0, 120),
                isSendPress: script.is_send_press ?? null,
                streamingProcessor: Boolean(script.streamingProcessor),
            };
            if (state.isSendPress === true || state.streamingProcessor) sawBusy = true;
            const textChanged = state.lastText !== before.lastMessage.mes.slice(0, 120);
            if (sawBusy && textChanged && state.isSendPress !== true) break;
            if (!sawBusy && textChanged) break;
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        const live = script.chat ?? [];
        return {
            pressed: true,
            before,
            sawBusy,
            after: {
                chatLength: live.length,
                lastIsUser: live[live.length - 1]?.is_user === true,
                lastText: String(live[live.length - 1]?.mes ?? '').slice(0, 120),
                lastMessage: {
                    mes: String(live[live.length - 1]?.mes ?? ''),
                    swipe_id: live[live.length - 1]?.swipe_id ?? null,
                    swipes: Array.isArray(live[live.length - 1]?.swipes) ? live[live.length - 1].swipes.slice() : null,
                    send_date: live[live.length - 1]?.send_date ?? null,
                    name: live[live.length - 1]?.name ?? null,
                },
            },
        };
    });
}

/**
 * Fire `option_regenerate`'s delegated handler and say whether `Generate('regenerate')` was reached.
 *
 * WHY A SECOND ENTRY INTO THE SAME CONTROL, measured rather than assumed. `#option_regenerate` is an `<a>` inside
 * `#options`, and `#options` is a Popper-managed flyout opened by `#options_button` (script.js:11546-11572) whose
 * delegated handler is `$('#options [id]').on('click', ...)` (script.js:11581). A real user opens the menu first.
 * The plain `control.click()` used by `pressRegenerate` may therefore reach nothing -- there is no direct `on`
 * handler on the anchor itself -- and "no request was observed" would then be a DRIVER defect with no product
 * meaning (AGENTS rule 10, exactly the shape that produced this file's header notes). So the menu is opened the way
 * the page opens it and the control's own click is re-dispatched.
 *
 * `sawRegenerateCall` is the point: it wraps `Generate` for the press ONLY, calls through unchanged (never
 * reimplements it -- AGENTS 58), and records `{type}`. A `false` here means the drive never reached the subject, and
 * the leg reports a harness failure instead of a product finding.
 */
export async function pressRegenerateThroughMenu(page) {
    return page.evaluate(async () => {
        const script = await import('./script.js');
        const chat = script.chat ?? [];
        const before = {
            menuPresent: document.querySelector('#options') !== null,
            buttonPresent: document.querySelector('#options_button') !== null,
            controlFound: document.querySelector('#option_regenerate') !== null,
            chatLength: chat.length,
            thisEditMesId: script.this_edit_mes_id ?? null,
            lastIsUser: chat[chat.length - 1]?.is_user === true,
            isSendPress: script.is_send_press ?? null,
            streamingProcessor: Boolean(script.streamingProcessor),
            lastMessage: {
                mes: String(chat[chat.length - 1]?.mes ?? ''),
                swipe_id: chat[chat.length - 1]?.swipe_id ?? null,
                swipes: Array.isArray(chat[chat.length - 1]?.swipes) ? chat[chat.length - 1].swipes.slice() : null,
                send_date: chat[chat.length - 1]?.send_date ?? null,
                name: chat[chat.length - 1]?.name ?? null,
            },
        };
        if (!before.menuPresent || !before.controlFound) {
            return { pressed: false, before, reason: 'the options menu or the regenerate control is not in the page' };
        }
        // OPEN THE MENU THE WAY THE PAGE OPENS IT, so the anchor is inside a live flyout exactly as a user's press
        // finds it. A page whose menu never opens is reported as such rather than papered over.
        const button = document.querySelector('#options_button');
        if (button) button.click();
        await new Promise(resolve => setTimeout(resolve, 500));
        const menuVisible = document.querySelector('#options')?.style?.display !== 'none';
        // OBSERVE, NEVER REIMPLEMENT: `Generate` is called through with its own `this` and arguments, and the wrapper
        // records only the type string. It stays installed for the whole leg (a later press must be observable too),
        // guarded by a window flag so a second call does not double-wrap.
        if (!window.__q20GenerateWrap) {
            window.__q20GenerateWrap = [];
            const original = script.Generate;
            if (typeof original === 'function') {
                window.__q20OriginalGenerate = original;
                script.Generate = function (type, ...rest) {
                    window.__q20GenerateWrap.push({ type: String(type ?? ''), at: Date.now() });
                    return original.call(this, type, ...rest);
                };
            }
        }
        const control = document.querySelector('#option_regenerate');
        control.click();
        const deadline = Date.now() + 30000;
        let sawBusy = false;
        let state = null;
        while (Date.now() < deadline) {
            const live = script.chat ?? [];
            state = {
                chatLength: live.length,
                lastIsUser: live[live.length - 1]?.is_user === true,
                lastText: String(live[live.length - 1]?.mes ?? '').slice(0, 120),
                isSendPress: script.is_send_press ?? null,
                streamingProcessor: Boolean(script.streamingProcessor),
            };
            if (state.isSendPress === true || state.streamingProcessor) sawBusy = true;
            if (state.isSendPress !== true) {
                const called = (window.__q20GenerateWrap ?? []).some(entry => entry.type === 'regenerate');
                if (called && sawBusy) break;
                if (called && state.lastText !== before.lastMessage.mes.slice(0, 120)) break;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        const live = script.chat ?? [];
        return {
            pressed: true,
            before,
            menuVisible,
            generateCalls: (window.__q20GenerateWrap ?? []).slice(),
            sawRegenerateCall: (window.__q20GenerateWrap ?? []).some(entry => entry.type === 'regenerate'),
            sawBusy,
            after: {
                chatLength: live.length,
                lastIsUser: live[live.length - 1]?.is_user === true,
                lastText: String(live[live.length - 1]?.mes ?? '').slice(0, 120),
                lastMessage: {
                    mes: String(live[live.length - 1]?.mes ?? ''),
                    swipe_id: live[live.length - 1]?.swipe_id ?? null,
                    swipes: Array.isArray(live[live.length - 1]?.swipes) ? live[live.length - 1].swipes.slice() : null,
                    send_date: live[live.length - 1]?.send_date ?? null,
                    name: live[live.length - 1]?.name ?? null,
                },
            },
        };
    });
}

/**
 * Press the REAL continue control (`#option_continue`, index.html:8189) and record what the page did.
 *
 * Pinned's guards on this control (script.js:11648-11661) are recorded in `before` rather than reproduced:
 *   `swipeState == SWIPE_STATE.EDITING`      -> refuses (a swipe-edit is in progress);
 *   `chat.length - 1 === this_edit_mes_id`   -> refuses (the message being continued is being edited);
 *   `is_send_press == false`                 -> refuses while a generation runs;
 *   -> `Generate('continue', ...)`.
 * A refusal by any of those is a fact about the state the drive reached, and the leg must be able to say so instead
 * of reporting "continue does nothing".
 */
export async function pressContinue(page) {
    return page.evaluate(async () => {
        const script = await import('./script.js');
        const context = (window.SillyTavern && window.SillyTavern.getContext) ? window.SillyTavern.getContext() : null;
        const chat = script.chat ?? [];
        const before = {
            menuPresent: document.querySelector('#options') !== null,
            controlFound: document.querySelector('#option_continue') !== null,
            // THE MESSAGE-BUTTON ENTRY TOO (`#mes_continue`, index.html:8121), recorded because it is the control a
            // user is more likely to press inside a chat and because its handler is a direct `on('click')` that
            // re-triggers this one (script.js:11155-11157).
            messageControlFound: document.querySelector('#mes_continue') !== null,
            chatLength: chat.length,
            chatId: context?.chatId ?? null,
            thisEditMesId: script.this_edit_mes_id ?? null,
            swipeEditing: script.swipeState ?? null,
            isSendPress: script.is_send_press ?? null,
            streamingProcessor: Boolean(script.streamingProcessor),
            lastIsUser: chat[chat.length - 1]?.is_user === true,
            lastMessage: {
                mes: String(chat[chat.length - 1]?.mes ?? ''),
                swipe_id: chat[chat.length - 1]?.swipe_id ?? null,
                swipes: Array.isArray(chat[chat.length - 1]?.swipes) ? chat[chat.length - 1].swipes.slice() : null,
                send_date: chat[chat.length - 1]?.send_date ?? null,
                name: chat[chat.length - 1]?.name ?? null,
                extra: chat[chat.length - 1]?.extra ?? null,
            },
        };
        if (!before.menuPresent || !before.controlFound) {
            return { pressed: false, before, reason: 'the options menu or the continue control is not in the page' };
        }
        const button = document.querySelector('#options_button');
        if (button) button.click();
        await new Promise(resolve => setTimeout(resolve, 500));
        const menuVisible = document.querySelector('#options')?.style?.display !== 'none';
        if (!window.__q20GenerateWrap) {
            window.__q20GenerateWrap = [];
            const original = script.Generate;
            if (typeof original === 'function') {
                window.__q20OriginalGenerate = original;
                script.Generate = function (type, ...rest) {
                    window.__q20GenerateWrap.push({ type: String(type ?? ''), at: Date.now() });
                    return original.call(this, type, ...rest);
                };
            }
        }
        document.querySelector('#option_continue').click();
        const deadline = Date.now() + 30000;
        let sawBusy = false;
        let state = null;
        while (Date.now() < deadline) {
            const live = script.chat ?? [];
            state = {
                chatLength: live.length,
                lastIsUser: live[live.length - 1]?.is_user === true,
                lastText: String(live[live.length - 1]?.mes ?? '').slice(0, 160),
                isSendPress: script.is_send_press ?? null,
                streamingProcessor: Boolean(script.streamingProcessor),
            };
            if (state.isSendPress === true || state.streamingProcessor) sawBusy = true;
            if (state.isSendPress !== true) {
                const called = (window.__q20GenerateWrap ?? []).some(entry => entry.type === 'continue');
                // A CONTINUATION CHANGES THE LAST MESSAGE IN PLACE, so "a new message appeared" is not the signal.
                // The DOM's own text is what a user sees change.
                const domText = String(document.querySelector(`#chat .mes[mesid="${live.length - 1}"] .mes_text`)?.textContent ?? '');
                if (called && sawBusy && domText !== '') break;
                if (called && !sawBusy && domText !== '') break;
            }
            await new Promise(resolve => setTimeout(resolve, 250));
        }
        const live = script.chat ?? [];
        const last = live[live.length - 1];
        return {
            pressed: true,
            before,
            menuVisible,
            generateCalls: (window.__q20GenerateWrap ?? []).slice(),
            sawContinueCall: (window.__q20GenerateWrap ?? []).some(entry => entry.type === 'continue'),
            sawBusy,
            after: {
                chatLength: live.length,
                lastIsUser: last?.is_user === true,
                lastText: String(last?.mes ?? ''),
                lastMessage: {
                    mes: String(last?.mes ?? ''),
                    swipe_id: last?.swipe_id ?? null,
                    swipes: Array.isArray(last?.swipes) ? last.swipes.slice() : null,
                    send_date: last?.send_date ?? null,
                    name: last?.name ?? null,
                    // METADATA IS COMPARED, so it is captured in full: `extra.reasoning` is APPENDED (not replaced) by
                    // pinned's appendFinal branch (script.js:6724-6736), which a replacement branch would silently
                    // get wrong.
                    extra: last?.extra ?? null,
                },
                // THE DOM'S OWN VIEW, so "the UI replaced the bubble" and "the file holds the right swipe" stay two
                // separate statements in the artefact.
                domMessageCount: document.querySelectorAll('#chat .mes').length,
                domLastText: String(document.querySelector(`#chat .mes[mesid="${live.length - 1}"] .mes_text`)?.textContent ?? '').slice(0, 400),
            },
        };
    });
}

/**
 * Save through the frontend's own conditional save, the entry the regenerate and continue paths end with.
 *
 * WHY THIS IS NEEDED AND IS NOT A SUBSTITUTE FOR THE PRODUCT SAVING: measured from pinned's source, neither
 * `Generate('regenerate')` (:5531 `saveReply({type:'swipe'})`) nor `Generate('continue')` (:5534
 * `saveReply({type:'appendFinal'})`) calls `saveChat`; both call `saveChatDebounced()` (script.js:7361, a setTimeout
 * with no bound the leg can wait on), and `setInContextMessages` (:6086) explicitly says "No metadata save on
 * purpose". So the file on disk is written by the DEBOUNCED save, and a leg that closed the page immediately would
 * race it. `saveChatConditional()` is the frontend's own "write it now", used here as the user closing a chat does.
 * It resolves and issues nothing when the chat has no identity (script.js:7407-7417), so the result is recorded.
 */
export const saveConditional = page => page.evaluate(async () => {
    const script = await import('./script.js');
    try {
        await script.saveChatConditional();
        return { ok: true };
    } catch (error) {
        return { ok: false, error: String(error && error.message || error) };
    }
});

/**
 * Wait for the PRODUCT to have written `marker` into a chat file, bounded, returning the files either way.
 *
 * The wait polls the disk because a write is asynchronous; it is bounded because an unbounded wait turns a missing
 * save into a hung job, and it reads the file rather than the promise because "a resolved promise" is exactly what
 * the failing Q20 runs produced.
 */
export async function waitForChatFile(page, dataRoot, carriesMarker, timeoutMs = 30000, handle = 'default-user') {
    const deadline = Date.now() + timeoutMs;
    let files = [];
    while (Date.now() < deadline) {
        files = await readChatFiles(dataRoot, handle);
        if (carriesMarker(files)) break;
        await page.waitForTimeout(500);
    }
    return files;
}

/**
 * Wait, bounded, until every recorded request has a response (or the budget expires), then return them.
 *
 * A debounced save can land after the last DOM event a leg observed; this is what makes "the request count" a
 * measurement instead of a race.
 */
export async function settleQuiet(page, recorder, { quietMs = 1500, maxMs = 15000 } = {}) {
    await recorder.settled();
    const started = Date.now();
    let last = recorder.requests.length;
    let lastChange = Date.now();
    while (Date.now() - started < maxMs) {
        await page.waitForTimeout(250);
        if (recorder.requests.length !== last) {
            last = recorder.requests.length;
            lastChange = Date.now();
            await recorder.settled();
        } else if (Date.now() - lastChange >= quietMs) {
            break;
        }
    }
    await recorder.settled();
    return recorder.requests;
}
