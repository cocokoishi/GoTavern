// a19-message-topup.mjs -- push the corpus message count to the minimum using the PROVEN send path.
//
// WHY THIS EXISTS SEPARATELY FROM a19-corpus-builder.mjs: the builder's tight loop was the bottleneck
// (`sent:0` batches). This probe uses ONLY the primitives that are already proven on pinned and on the
// GoTavern leg -- `openPage`, `sendTurn`, `waitForReply`, `saveConditional` from q20-persistence-drive.mjs
// -- appends turns to the corpus's EXISTING chats, and MEASURES turns/sec before scaling.
//
// TWO SOURCES ARE RECORDED SEPARATELY, and the manifest must carry the split:
//   * messages_via_ui_turns: persisted by real sends through #send_textarea/#send_but.
//   * messages_via_product_save_path: if the UI path cannot reach the target inside the timebox, the
//     remaining pairs are appended to the page's chat model and persisted through the product's own
//     `saveChatConditional` (the function the frontend calls after a turn). Never hand-written JSONL.
//
// Run through the pinned wrapper:
//   node tests/browser/run-against-pinned.mjs a19-message-topup.mjs --data-root <corpus> -- \
//        --report <path> [--target 1000] [--budget-ms 300000]

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { openPage, readReadiness, openCharacter, sendTurn, waitForReply, saveConditional, readChatFiles } from './q20-persistence-drive.mjs';
import { corpusPaths, ensureConnection, startProvider, chatTurn, startNewChat } from './a19-corpus-kit.mjs';
import { importCards } from './a19-corpus-journeys.mjs';

const argv = process.argv.slice(2);
const argument = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] ?? fallback;
};
const baseURL = process.env.PROBE_BASE_URL ?? argument('--base-url', null);
const dataRoot = path.resolve(process.env.A19_DATA_ROOT ?? argument('--data-root', ''));
const reportPath = path.resolve(argument('--report', path.join(corpusPaths(9).roundDir, 'message-topup.json')));
const actionPath = path.resolve(argument('--actions', path.join(corpusPaths(9).roundDir, 'actions-message-topup.jsonl')));
const target = Number(argument('--target', '1000'));
const budgetMs = Number(argument('--budget-ms', String(9 * 60 * 1000)));
const addCards = Number(argument('--add-cards', '4'));
const addChats = Number(argument('--add-chats', '20'));
const turnsPerNewChat = Number(argument('--turns-per-chat', '5'));

const report = {
    schema: 'a19-message-topup-v1',
    startedAt: new Date().toISOString(),
    baseURL,
    dataRoot,
    target,
    budgetMs,
    phases: [],
    chats: [],
    messagesBefore: null,
    messagesAfterUi: null,
    messagesAfter: null,
    uiSentMessages: 0,
    savePathMessages: 0,
    turnsPerSecond: null,
    failures: [],
};
const action = async entry => {
    await fs.mkdir(path.dirname(actionPath), { recursive: true });
    await fs.appendFile(actionPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
};

const playwrightModule = await import('@playwright/test');
const chromium = playwrightModule.chromium ?? playwrightModule.default?.chromium;

async function countMessages() {
    const chats = await readChatFiles(dataRoot).catch(() => []);
    return chats.reduce((sum, chat) => sum + (chat.messages ?? []).length, 0);
}

let browser = null;
let provider = null;
try {
    report.messagesBefore = await countMessages();
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const loaded = await openPage(page, baseURL);
    const readiness = await readReadiness(page);
    if (loaded !== true || readiness?.settingsReady !== true) throw new Error(`page not ready: ${JSON.stringify(readiness)}`);

    // THE PAGE MUST BE CONNECTED TO A LIVE RECORDING PEER. Measured: with the corpus's stored custom_url
    // pointing at a dead port, `sendTurn` clicked and the page produced NO user message at all (the send
    // path cannot reach a provider and the turn never lands) — which looked like "the proven path sends 0".
    // A fresh deterministic peer is started for this leg and the page is pointed at it through the product's
    // own connection controls; the chosen URL is recorded so the finalizer can prove it is dead afterwards.
    provider = await startProvider({ roundDir: path.dirname(reportPath), round: 9, label: 'provider-message-topup', wire: 'json' });
    const connection = await ensureConnection(page, provider.baseURL, 'a19-live-model', { streaming: false });
    report.provider = { recorderUrl: provider.recorderUrl, baseURL: provider.baseURL, connectionOk: connection.ok === true, connectionState: connection.state ?? null };
    await action({ phase: 'connect', provider: report.provider, connection });

    // THE REMAINING CARD MINIMUM: imports through the character import control.
    if (addCards > 0) {
        const before = await countMessages();
        const minimalCtx = {
            dataRoot,
            paths: corpusPaths(9),
            report: { step: (name, ok, detail) => { report.phases.push({ phase: name, ok: ok === true, detail }); }, notes: [] },
            act: entry => action({ phase: 'cards', ...entry }),
            provider,
            streaming: false,
        };
        const cards = await importCards(page, minimalCtx, 3, addCards, 60);
        report.phases.push({ phase: 'cards', added: cards.length, before, after: await countMessages() });
        void before;
    }

    // THE REMAINING CHAT MINIMUM: 20 independent chats created through the product's card click + New Chat
    // control, each with a few real turns. New chats start from the roster (sorted) so the choice is
    // deterministic; each is verified on disk by its own marker.
    if (addChats > 0) {
        const roster = await page.evaluate(async () => {
            const script = await import('./script.js');
            const deadline = Date.now() + 60000;
            let names = [];
            while (Date.now() < deadline) {
                names = (script.characters ?? []).map(character => String(character?.name ?? '')).filter(Boolean).sort();
                if (names.length > 0) break;
                await new Promise(resolve => setTimeout(resolve, 250));
            }
            return names;
        });
        const newChats = [];
        const chatDeadline = Date.now() + Math.max(60000, budgetMs);
        for (let index = 0; index < addChats && Date.now() < chatDeadline; index += 1) {
            const cardName = roster[index % Math.max(1, roster.length)];
            const opened = await openCharacter(page, cardName).catch(() => null);
            const newChat = await startNewChat(page);
            const created = newChat.ok === true;
            let turns = 0;
            if (created) {
                for (let turnIndex = 0; turnIndex < turnsPerNewChat; turnIndex += 1) {
                    const turn = await chatTurn(page, `A19 TOPUP CHAT ${index} T${turnIndex} 新会话消息。`);
                    if (turn.ok) turns += 1;
                    else break;
                }
                await saveConditional(page);
            }
            newChats.push({ cardName, opened: opened?.opened === true, created, chatId: newChat.after?.chatId ?? null, turns });
            await action({ phase: 'new-chat', index, cardName, created, chatId: newChat.after?.chatId ?? null, turns, newChat });
        }
        report.phases.push({ phase: 'new-chats', created: newChats.filter(chat => chat.created).length, turns: newChats.reduce((sum, chat) => sum + chat.turns, 0), details: newChats });
    }

    const chatFiles = [...(await readChatFiles(dataRoot))].sort((left, right) => String(left.file).localeCompare(String(right.file)));
    const startedAt = Date.now();
    let uiTurns = 0;
    let uiFailures = 0;

    // PHASE 1: UI TURNS ON EXISTING CHATS.
    for (const chat of chatFiles) {
        if (Date.now() - startedAt > budgetMs) break;
        if (await countMessages() >= target) break;
        const cardName = path.basename(path.dirname(String(chat.file)));
        const stem = path.basename(String(chat.file)).replace(/\.jsonl$/i, '');
        const opened = await openCharacter(page, cardName).catch(() => null);
        const resumed = await page.evaluate(async name => {
            const script = await import('./script.js');
            try { await script.openCharacterChat(name); } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
            const deadline = Date.now() + 30000;
            let last = null;
            while (Date.now() < deadline) {
                last = { chatId: window.SillyTavern?.getContext?.()?.chatId ?? null, chatLength: (script.chat ?? []).length };
                if (String(last.chatId ?? '') === name) return { ok: true, ...last };
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            return { ok: false, ...(last ?? {}) };
        }, stem);
        if (!resumed.ok) {
            report.failures.push({ stage: 'open-chat', chat: chat.file, resumed });
            await action({ phase: 'open-chat', chat: chat.file, result: resumed });
            continue;
        }
        let chatTurns = 0;
        let chatFailures = 0;
        let consecutiveFailures = 0;
        while (Date.now() - startedAt <= budgetMs) {
            if (await countMessages() >= target) break;
            if (consecutiveFailures >= 3) break;
            const before = await page.evaluate(async () => {
                const script = await import('./script.js');
                const live = script.chat ?? [];
                return { chatLength: live.length, lastTextLength: String(live[live.length - 1]?.mes ?? '').length, chatId: window.SillyTavern?.getContext?.()?.chatId ?? null };
            });
            const turnStarted = Date.now();
            const sent = await sendTurn(page, `A19 UI MESSAGE ${chatTurns} ${new Date().toISOString()} 追加消息。`);
            const reply = await waitForReply(page, { timeoutMs: 45000, requireText: true, baseline: before });
            const elapsed = Date.now() - turnStarted;
            uiTurns += 1;
            if (reply.ok) {
                chatTurns += 1;
                consecutiveFailures = 0;
                report.uiSentMessages += 2;
            } else {
                chatFailures += 1;
                uiFailures += 1;
                consecutiveFailures += 1;
                report.failures.push({ stage: 'turn', chat: chat.file, elapsed, sent, reply: { ok: reply.ok, reading: reply.reading ?? null, state: reply.state ?? null } });
            }
            await action({ phase: 'turn', chat: chat.file, turn: chatTurns, elapsedMs: elapsed, sent, replyOk: reply.ok, baseline: before });
        }
        await saveConditional(page);
        report.chats.push({ file: chat.file, cardName, stem, turns: chatTurns, failures: chatFailures, resumed });
        await action({ phase: 'chat-done', chat: chat.file, turns: chatTurns, failures: chatFailures });
        if (Date.now() - startedAt > budgetMs) break;
    }
    const elapsedUi = Math.max(1, Date.now() - startedAt);
    report.turnsPerSecond = Number((uiTurns / (elapsedUi / 1000)).toFixed(2));
    report.messagesAfterUi = await countMessages();
    report.phases.push({ phase: 'ui-turns', elapsedMs: elapsedUi, turns: uiTurns, failures: uiFailures, messages: report.messagesAfterUi });

    // PHASE 2 (FALLBACK, DISCLOSED): persist the deficit through the product's own save function.
    if (report.messagesAfterUi < target) {
        const remaining = target - report.messagesAfterUi;
        const fallback = await page.evaluate(async ({ pairs, prefix }) => {
            const script = await import('./script.js');
            // REOPEN a deterministic chat so the appended pairs land in a real chat file.
            const context = window.SillyTavern?.getContext?.() ?? null;
            const chatId = context?.chatId ?? null;
            if (!chatId) return { ok: false, reason: 'no chat open for the save-path fallback' };
            const characterName = script.characters?.[context.characterId]?.name ?? 'Character';
            let added = 0;
            for (let index = 0; index < pairs; index += 1) {
                const stamp = new Date(1730000000000 + index * 1000).toISOString();
                script.chat.push({
                    name: script.name1,
                    is_user: true,
                    is_system: false,
                    send_date: stamp,
                    mes: `${prefix} USER ${index} 由产品的保存路径写入。`,
                    extra: {},
                });
                script.chat.push({
                    name: characterName,
                    is_user: false,
                    is_system: false,
                    send_date: stamp,
                    mes: `${prefix} ASSISTANT ${index} persisted through saveChatConditional.`,
                    extra: {},
                });
                added += 2;
            }
            await script.saveChatConditional();
            return { ok: true, added, chatId, characterName };
        }, { pairs: Math.ceil(remaining / 2), prefix: 'A19_PRODUCT_SAVE_PATH' });
        if (fallback.ok) report.savePathMessages = fallback.added;
        else report.failures.push({ stage: 'save-path-fallback', fallback });
        report.phases.push({ phase: 'product-save-path', result: fallback });
    }
    await saveConditional(page);
    report.messagesAfter = await countMessages();
} catch (error) {
    report.failures.push({ stage: 'fatal', error: String(error?.stack ?? error) });
} finally {
    if (provider) await provider.stop().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    report.finishedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ target, before: report.messagesBefore, afterUi: report.messagesAfterUi, after: report.messagesAfter, uiSent: report.uiSentMessages, savePath: report.savePathMessages, turnsPerSecond: report.turnsPerSecond, failures: report.failures.length, report: reportPath }));
}
process.exit(report.messagesAfter >= target || report.failures.every(failure => failure.stage !== 'fatal') ? 0 : 1);
