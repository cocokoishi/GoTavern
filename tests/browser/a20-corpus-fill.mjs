// a20-corpus-fill.mjs -- bring a pinned corpus to a tier's CHATS and MESSAGES minimums.
//
// WHY A NEW FILE. The alpha.19 message top-up (a19-message-topup.mjs) spends its budget on real UI turns and
// then fills the remaining messages through the product save path in ONE chat. That is honest but it cannot
// reach ">=100 chats": 97 new chats x 5 real turns is ~485 provider turns, which does not fit a tier run.
// This additive a20 step keeps the same provenance rules and splits the work:
//
//   * CHATS are created through the product's own controls: card click -> New Chat -> saveChatConditional.
//     That is the real "new chat" action (no provider request is needed to create an empty chat file).
//   * MESSAGES are appended in two disclosed layers:
//       - real UI turns through #send_textarea + #send_but for a bounded sample of chats (the proven send
//         path; every such turn goes to the deterministic recording peer);
//       - the remaining deficit is appended to the page's chat model and persisted by the PRODUCT's own
//         saveChatConditional (the same function the frontend calls after a turn). This is the
//         "product-native save" layer, recorded separately and never presented as UI turns.
//
// RUN (through the pinned wrapper, like the base rounds):
//   node tests/browser/run-against-pinned.mjs a20-corpus-fill.mjs --data-root <corpus data> -- \
//     --chats-target 100 --messages-target 3000 --ui-turn-chats 3 --ui-turns-per-chat 2 \
//     --report <scratch>/fill.json --actions <scratch>/actions-fill.jsonl
//
// The report records the exact chat/message census before and after each phase and the split, so the
// finalizer can compute (not assume) the UI-turn vs product-save share.

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import {
    openPage, readReadiness, openCharacter, sendTurn, waitForReply, saveConditional, readChatFiles,
} from './q20-persistence-drive.mjs';
import { corpusPaths, ensureConnection, startProvider, startNewChat } from './a19-corpus-kit.mjs';

const argv = process.argv.slice(2);
const argument = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] ?? fallback;
};
const baseURL = process.env.PROBE_BASE_URL ?? argument('--base-url', null);
const dataRoot = path.resolve(process.env.A19_DATA_ROOT ?? argument('--data-root', ''));
const reportPath = path.resolve(argument('--report', path.join(corpusPaths(91).roundDir, 'a20-fill.json')));
const actionPath = path.resolve(argument('--actions', path.join(corpusPaths(91).roundDir, 'actions-a20-fill.jsonl')));
const chatsTarget = Number(argument('--chats-target', '100'));
const messagesTarget = Number(argument('--messages-target', '3000'));
const uiTurnChats = Number(argument('--ui-turn-chats', '3'));
const uiTurnsPerChat = Number(argument('--ui-turns-per-chat', '2'));
if (!baseURL || !dataRoot) { console.error('a20-corpus-fill: PROBE_BASE_URL and A19_DATA_ROOT are required (run through run-against-pinned.mjs)'); process.exit(2); }

const report = {
    schema: 'a20-corpus-fill-v1',
    startedAt: new Date().toISOString(),
    baseURL,
    dataRoot,
    targets: { chats: chatsTarget, messages: messagesTarget },
    measured: {},
    phases: [],
    uiSentMessages: 0,
    savePathMessages: 0,
    failures: [],
};
const action = async entry => {
    await fs.mkdir(path.dirname(actionPath), { recursive: true });
    await fs.appendFile(actionPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
};

async function census() {
    const files = await readChatFiles(dataRoot).catch(() => []);
    return {
        chats: files.length,
        messages: files.reduce((sum, file) => sum + (file.messages ?? []).length, 0),
        files: files.map(file => ({ file: file.file, messages: (file.messages ?? []).length })),
    };
}

const chromium = (await import('@playwright/test')).chromium;
let browser = null;
let provider = null;
try {
    report.measured.before = await census();
    provider = await startProvider({ roundDir: path.dirname(reportPath), round: 91, label: 'provider-corpus-fill', wire: 'json' });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const loaded = await openPage(page, baseURL);
    const readiness = await readReadiness(page);
    if (loaded !== true || readiness?.settingsReady !== true) throw new Error(`page not ready: ${JSON.stringify(readiness)}`);
    const connection = await ensureConnection(page, provider.baseURL, 'a20-live-model', { streaming: false });
    report.connection = { ok: connection.ok === true, state: connection.state ?? null };
    if (connection.ok !== true) throw new Error('the page could not be pointed at the recording peer');

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
    if (roster.length === 0) throw new Error('no roster characters on the page; the corpus has no cards to open');
    report.rosterSize = roster.length;

    // PHASE 1a: a small sample of chats created through the REAL card click + New Chat controls, so the
    // UI-origin claim has real control interactions behind it.
    let uiCreatedChats = 0;
    const shortfall = Math.max(0, chatsTarget - report.measured.before.chats);
    const uiSample = Math.min(3, shortfall);
    for (let index = 0; index < uiSample; index += 1) {
        const cardName = roster[index % roster.length];
        const opened = await openCharacter(page, cardName).catch(() => null);
        const newChat = await startNewChat(page);
        if (newChat.ok === true) {
            await saveConditional(page);
            uiCreatedChats += 1;
        }
        await action({ phase: 'new-chat-ui', index, cardName, opened: opened?.opened === true, created: newChat.ok === true, chatId: newChat.after?.chatId ?? null });
        if (!newChat.ok) report.failures.push({ stage: 'new-chat-ui', index, cardName, newChat });
    }

    // PHASE 1b: the remaining chats through the PRODUCT FUNCTION behind the New Chat control
    // (`script.doNewChat`), which is the same code the confirmed click handler invokes
    // (public/script.js:11623). This is a disclosed product-native creation layer, counted separately from
    // the UI-control sample above: a per-chat click path costs ~40 s each under load and cannot reach a
    // 100-chat tier inside a tier run. Nothing is hand-written: the product's own function creates and
    // persists each chat file.
    let productCreatedChats = 0;
    const remainingChats = Math.max(0, chatsTarget - (report.measured.before.chats + uiCreatedChats));
    if (remainingChats > 0) {
        const batchResult = await page.evaluate(async ({ count, marker }) => {
            const script = await import('./script.js');
            const created = [];
            for (let index = 0; index < count; index += 1) {
                try {
                    const characters = script.characters ?? [];
                    if (characters.length === 0) break;
                    const chid = index % characters.length;
                    await script.selectCharacterById(chid, { switchMenu: false });
                    await script.doNewChat({ deleteCurrentChat: false });
                    created.push({ index, chid, character: String(characters[chid]?.name ?? ''), sessionName: String(characters[chid]?.chat ?? '') });
                } catch (error) {
                    return { ok: false, created, error: String(error?.message ?? error), index };
                }
            }
            return { ok: true, created, marker };
        }, { count: remainingChats, marker: 'A20_FILL_PRODUCT_NEW_CHAT' });
        if (batchResult.ok !== true) report.failures.push({ stage: 'new-chat-product-function', batchResult });
        productCreatedChats = batchResult.created.length;
        await action({ phase: 'new-chats-product-function', requested: remainingChats, created: productCreatedChats, first: batchResult.created.slice(0, 3), marker: 'A20_FILL_PRODUCT_NEW_CHAT' });
        await saveConditional(page);
    }
    report.chatCreation = { uiControlSample: uiCreatedChats, productFunction: productCreatedChats };
    report.measured.afterChats = await census();
    report.phases.push({ phase: 'new-chats', charters: report.measured.afterChats.chats, uiControlSample: uiCreatedChats, productFunction: productCreatedChats });


    // PHASE 2: a bounded sample of REAL UI turns (proven send path) so the UI-origin share is real.
    const files = [...(await readChatFiles(dataRoot))].sort((left, right) => String(left.file).localeCompare(String(right.file)));
    let uiTurns = 0;
    for (let index = 0; index < Math.min(uiTurnChats, files.length); index += 1) {
        const file = files[index];
        const cardName = path.basename(path.dirname(String(file.file)));
        const stem = path.basename(String(file.file)).replace(/\.jsonl$/i, '');
        const opened = await openCharacter(page, cardName).catch(() => null);
        if (!opened) continue;
        const resumed = await page.evaluate(async name => {
            const script = await import('./script.js');
            try { await script.openCharacterChat(name); } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                if (String(window.SillyTavern?.getContext?.()?.chatId ?? '') === name) return { ok: true };
                await new Promise(resolve => setTimeout(resolve, 200));
            }
            return { ok: false };
        }, stem);
        if (!resumed.ok) { report.failures.push({ stage: 'ui-open', chat: file.file, resumed }); continue; }
        for (let turnIndex = 0; turnIndex < uiTurnsPerChat; turnIndex += 1) {
            const before = await page.evaluate(async () => {
                const script = await import('./script.js');
                return { chatLength: (script.chat ?? []).length, chatId: window.SillyTavern?.getContext?.()?.chatId ?? null };
            });
            const sent = await sendTurn(page, `A20 FILL UI TURN ${index}-${turnIndex} 真实发送路径。`);
            const reply = await waitForReply(page, { timeoutMs: 60000, requireText: true, baseline: before });
            if (reply.ok) { uiTurns += 1; report.uiSentMessages += 2; }
            else report.failures.push({ stage: 'ui-turn', chat: file.file, sent, reply: { ok: reply.ok, state: reply.state ?? null } });
        }
        await saveConditional(page);
    }
    report.measured.afterUi = await census();
    report.phases.push({ phase: 'ui-turns', chats: Math.min(uiTurnChats, files.length), turns: uiTurns, messages: report.measured.afterUi.messages });

    // PHASE 3: the remaining message deficit, distributed across every chat and persisted by the product's
    // own save function. Disclosed as product-native save, never as UI turns.
    const filesNow = [...(await readChatFiles(dataRoot))].sort((left, right) => String(left.file).localeCompare(String(right.file)));
    const deficit = Math.max(0, messagesTarget - report.measured.afterUi.messages);
    const pairsPerChat = filesNow.length > 0 ? Math.ceil(deficit / 2 / filesNow.length) : 0;
    let appended = 0;
    for (const [index, file] of filesNow.entries()) {
        if (appended >= deficit) break;
        const cardName = path.basename(path.dirname(String(file.file)));
        const stem = path.basename(String(file.file)).replace(/\.jsonl$/i, '');
        const opened = await openCharacter(page, cardName).catch(() => null);
        if (!opened) continue;
        const pairs = Math.min(pairsPerChat, Math.ceil((deficit - appended) / 2));
        if (pairs <= 0) break;
        const result = await page.evaluate(async ({ name, pairs, marker }) => {
            const script = await import('./script.js');
            try { await script.openCharacterChat(name); } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline) {
                if (String(window.SillyTavern?.getContext?.()?.chatId ?? '') === name) break;
                await new Promise(resolve => setTimeout(resolve, 150));
            }
            const characterName = script.characters?.[window.SillyTavern?.getContext?.()?.characterId ?? 0]?.name ?? 'Character';
            const base = 1731000000000;
            let added = 0;
            for (let offset = 0; offset < pairs; offset += 1) {
                const stamp = new Date(base + offset * 1000).toISOString();
                script.chat.push({ name: script.name1, is_user: true, is_system: false, send_date: stamp, mes: `${marker} USER ${offset} 由产品的保存路径写入。`, extra: {} });
                script.chat.push({ name: characterName, is_user: false, is_system: false, send_date: stamp, mes: `${marker} ASSISTANT ${offset} persisted through saveChatConditional.`, extra: {} });
                added += 2;
            }
            await script.saveChatConditional();
            return { ok: true, added, chatId: name, characterName };
        }, { name: stem, pairs, marker: 'A20_PRODUCT_SAVE_PATH' });
        if (result.ok === true) {
            appended += result.added;
            report.savePathMessages += result.added;
        } else {
            report.failures.push({ stage: 'save-path', chat: file.file, result });
        }
        await action({ phase: 'save-path', chat: file.file, pairs, result });
        if ((index + 1) % 20 === 0) console.log(`[a20-fill] save-path chats ${index + 1}/${filesNow.length} appended=${appended}/${deficit}`);
    }
    await saveConditional(page);
    report.measured.after = await census();
    report.phases.push({ phase: 'product-save-path', appended, messages: report.measured.after.messages });
    report.reached = {
        chats: report.measured.after.chats >= chatsTarget,
        messages: report.measured.after.messages >= messagesTarget,
        achievedChats: report.measured.after.chats,
        achievedMessages: report.measured.after.messages,
    };
    if (!report.reached.chats || !report.reached.messages) {
        report.failures.push({ stage: 'target', reached: report.reached });
    }
} catch (error) {
    report.failures.push({ stage: 'fatal', error: String(error?.stack ?? error) });
    console.error(`[a20-fill] FAILED: ${String(error?.stack ?? error)}`);
} finally {
    if (provider) await provider.stop().catch(() => null);
    if (browser) await browser.close().catch(() => null);
    report.finishedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(`[a20-fill] report: ${reportPath}`);
    console.log(JSON.stringify({ before: report.measured.before, after: report.measured.after, reached: report.reached ?? null, uiSent: report.uiSentMessages, savePath: report.savePathMessages, failures: report.failures.length }).slice(0, 1200));
}
process.exit((report.failures ?? []).filter(entry => entry.stage !== 'target').length === 0 ? 0 : 1);
