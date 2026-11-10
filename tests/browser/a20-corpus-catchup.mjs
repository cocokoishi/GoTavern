// a20-corpus-catchup.mjs -- bounded message catch-up for a corpus that is already at its chat target.
//
// When a20-corpus-fill.mjs has created the chats but the per-chat product-save loop stalls on some
// product-created chat names, the remaining MESSAGE deficit is finished here in ONE already-open chat,
// through the product's own `saveChatConditional` (the same function the frontend calls after a turn).
// This is the disclosed product-native save layer, not a UI turn, and the report says so.
//
// RUN (through the pinned wrapper):
//   node tests/browser/run-against-pinned.mjs a20-corpus-catchup.mjs --data-root <corpus data> -- \
//     --messages-target 3000 --report <scratch>/catchup.json --actions <scratch>/actions-catchup.jsonl

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { openPage, readReadiness, openCharacter, saveConditional, readChatFiles } from './q20-persistence-drive.mjs';
import { corpusPaths } from './a19-corpus-kit.mjs';

const argv = process.argv.slice(2);
const argument = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] ?? fallback;
};
const baseURL = process.env.PROBE_BASE_URL ?? argument('--base-url', null);
const dataRoot = path.resolve(process.env.A19_DATA_ROOT ?? argument('--data-root', ''));
const reportPath = path.resolve(argument('--report', path.join(corpusPaths(92).roundDir, 'a20-catchup.json')));
const actionPath = path.resolve(argument('--actions', path.join(corpusPaths(92).roundDir, 'actions-a20-catchup.jsonl')));
const messagesTarget = Number(argument('--messages-target', '3000'));
if (!baseURL || !dataRoot) { console.error('a20-corpus-catchup: PROBE_BASE_URL and A19_DATA_ROOT are required'); process.exit(2); }

const report = { schema: 'a20-corpus-catchup-v1', startedAt: new Date().toISOString(), baseURL, dataRoot, target: messagesTarget, before: null, after: null, appended: 0, failures: [] };
const action = async entry => {
    await fs.mkdir(path.dirname(actionPath), { recursive: true });
    await fs.appendFile(actionPath, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
};
async function census() {
    const files = await readChatFiles(dataRoot).catch(() => []);
    return { chats: files.length, messages: files.reduce((sum, file) => sum + (file.messages ?? []).length, 0) };
}

const chromium = (await import('@playwright/test')).chromium;
let browser = null;
try {
    report.before = await census();
    const deficit = Math.max(0, messagesTarget - report.before.messages);
    if (deficit === 0) {
        report.after = report.before;
        report.note = 'already at target; nothing to append';
    } else {
        browser = await chromium.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
        const page = await context.newPage();
        const loaded = await openPage(page, baseURL);
        const readiness = await readReadiness(page);
        if (loaded !== true || readiness?.settingsReady !== true) throw new Error(`page not ready: ${JSON.stringify(readiness)}`);
        const files = [...(await readChatFiles(dataRoot))].sort((left, right) => String(left.file).localeCompare(String(right.file)));
        const file = files.find(entry => (entry.messages ?? []).length > 0) ?? files[0];
        if (!file) throw new Error('no chat file to append to');
        const cardName = path.basename(path.dirname(String(file.file)));
        const stem = path.basename(String(file.file)).replace(/\.jsonl$/i, '');
        const opened = await openCharacter(page, cardName);
        const result = await page.evaluate(async ({ name, pairs, marker }) => {
            const script = await import('./script.js');
            try { await script.openCharacterChat(name); } catch (error) { return { ok: false, reason: String(error?.message ?? error) }; }
            const deadline = Date.now() + 30000;
            while (Date.now() < deadline && String(window.SillyTavern?.getContext?.()?.chatId ?? '') !== name) await new Promise(resolve => setTimeout(resolve, 150));
            const characterName = script.characters?.[window.SillyTavern?.getContext?.()?.characterId ?? 0]?.name ?? 'Character';
            const base = 1732000000000;
            let added = 0;
            for (let offset = 0; offset < pairs; offset += 1) {
                const stamp = new Date(base + offset * 1000).toISOString();
                script.chat.push({ name: script.name1, is_user: true, is_system: false, send_date: stamp, mes: `${marker} USER ${offset} 产品的保存路径补足。`, extra: {} });
                script.chat.push({ name: characterName, is_user: false, is_system: false, send_date: stamp, mes: `${marker} ASSISTANT ${offset} persisted through saveChatConditional.`, extra: {} });
                added += 2;
            }
            await script.saveChatConditional();
            return { ok: true, added, chatId: name, characterName };
        }, { name: stem, pairs: Math.ceil(deficit / 2), marker: 'A20_PRODUCT_SAVE_PATH' });
        if (result.ok === true) report.appended = result.added;
        else report.failures.push({ stage: 'append', result });
        await action({ phase: 'catchup', file: file.file, deficit, opened: opened?.opened === true, result });
        await saveConditional(page);
        report.after = await census();
        report.reached = report.after.messages >= messagesTarget;
    }
    report.finishedAt = new Date().toISOString();
} catch (error) {
    report.failures.push({ stage: 'fatal', error: String(error?.stack ?? error) });
    report.after = await census().catch(() => null);
} finally {
    if (browser) await browser.close().catch(() => null);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    console.log(JSON.stringify({ before: report.before, after: report.after, appended: report.appended, reached: report.reached ?? null, failures: report.failures.length, report: reportPath }));
}
process.exit(report.failures.length === 0 ? 0 : 1);
