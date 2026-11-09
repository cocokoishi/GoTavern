// a19-group-pagination-proof.mjs -- bounded proof for the create-group dialog on a FRESH root.
//
// Proves the EXACT failing case the corpus harness had to fix:
//   1) create AND OPEN group 1 with 3 members (so pinned's sticky `openGroupId` is set),
//   2) the harness reloads (the smallest re-initialisation that clears it; `resetSelectedGroup()` does not),
//   3) create group 2 requesting ONE OF GROUP 1'S MEMBERS plus 3 others -> the dialog must see the full
//      candidate list and reach memberCount 4 with every add verified from the unfiltered page,
//   4) exercise the DISCLOSED product-API fallback directly (create -> edit -> verify via /api/groups/all).
// The full corpus chain stays CI-gated; this script proves only this dialog path.
//
// Run: node tests/browser/run-against-pinned.mjs a19-group-pagination-proof.mjs --data-root <fresh> -- \
//        --report <path>

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { openPage, readReadiness } from './q20-persistence-drive.mjs';
import { writeCardPng, createGroupUiFirst, createGroupViaProductApi, openGroup } from './a19-corpus-journeys.mjs';
import { corpusPaths, ensureConnection, startProvider } from './a19-corpus-kit.mjs';

const argv = process.argv.slice(2);
const argument = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] ?? fallback;
};
const baseURL = process.env.PROBE_BASE_URL ?? argument('--base-url', null);
const dataRoot = path.resolve(process.env.A19_DATA_ROOT ?? argument('--data-root', ''));
const reportPath = path.resolve(argument('--report', path.join(corpusPaths(12).roundDir, 'group-pagination-proof.json')));
const report = { schema: 'a19-group-pagination-proof-v2', startedAt: new Date().toISOString(), baseURL, dataRoot, cards: [], groups: [], apiFallback: null, failures: [], steps: [] };
const cardNames = ['A19R1 The Quiet Archive 3', 'A19R1 Glass Garden 2', 'A19R1 烟雨客栈 4', 'A19R1 深夜食堂 5', 'A19R1 終電の駅 6', 'A19R1 星海図書館 7'];
const chromium = (await import('@playwright/test')).chromium;

let browser = null;
let provider = null;
try {
    provider = await startProvider({ roundDir: path.dirname(reportPath), round: 12, label: 'provider-group-proof', wire: 'json' });
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const loaded = await openPage(page, baseURL);
    const readiness = await readReadiness(page);
    if (loaded !== true || readiness?.settingsReady !== true) throw new Error(`page not ready: ${JSON.stringify(readiness)}`);
    const connection = await ensureConnection(page, provider.baseURL, 'a19-live-model', { streaming: false });
    const ctx = {
        dataRoot,
        provider,
        streaming: false,
        report: {
            counts: report,
            step: (name, ok, detail) => {
                report.steps.push({ name, ok: ok === true, detail });
                if (ok !== true) report.failures.push({ stage: name, detail });
            },
            note: text => report.steps.push({ note: text }),
        },
        act: async entry => {
            report.steps.push({ action: entry.field ?? entry.action ?? 'action', detail: entry.result ?? null });
        },
    };
    report.connection = { ok: connection.ok === true, state: connection.state ?? null };

    const dir = path.join(corpusPaths(12).artifactsDir, 'imports', 'cards');
    await fs.mkdir(dir, { recursive: true });
    const rosterNames = async () => page.evaluate(async () => {
        const script = await import('./script.js');
        return (script.characters ?? []).map(character => String(character?.name ?? '')).filter(Boolean).sort();
    });
    for (const [index, name] of cardNames.entries()) {
        const file = await writeCardPng(path.join(dir, `proof-card-${index}.png`), 90 + index, {
            name,
            description: `A19 group proof card ${index + 1}: ${name}. 用于群聊分页证明。`,
            firstMessage: `A19_GROUP_PROOF greeting ${index + 1} for ${name}.`,
        });
        const before = (await rosterNames()).length;
        await page.setInputFiles('#character_import_file', file);
        const deadline = Date.now() + 40000;
        let after = before;
        while (Date.now() < deadline) {
            await page.evaluate(async () => {
                const script = await import('./script.js');
                await script.getCharacters();
            });
            after = (await rosterNames()).length;
            if (after > before) break;
            await page.waitForTimeout(300);
        }
        const imported = { name, ok: after > before, before, after };
        report.cards.push(imported);
        if (!imported.ok) report.failures.push({ stage: 'card-import', imported });
    }
    const roster = await rosterNames();
    const anchor = 'A19R1 The Quiet Archive 3';
    if (roster.includes(anchor) === false) report.failures.push({ stage: 'anchor-missing', anchor, roster });

    // 1) CREATE + OPEN group 1 (3 members) so pinned's sticky openGroupId is set.
    const group1Members = [cardNames[0], cardNames[1], cardNames[2]];
    const group1 = await createGroupUiFirst(page, ctx, 12, 0, { name: 'A19 Proof Group 1', memberNames: group1Members, activationStrategy: 0, generationMode: 0 });
    report.groups.push({ case: 'group-1-created-and-opened', requested: group1Members, result: group1 });
    if (group1.ok !== true) report.failures.push({ stage: 'group-1-create', result: group1 });
    const opened = await openGroup(page, group1.group?.id, true);
    report.groups[report.groups.length - 1].opened = opened;
    if (opened.ok !== true) report.failures.push({ stage: 'group-1-open', opened });

    // 2) CREATE group 2 requesting ONE OF GROUP 1'S MEMBERS + 3 others. The helper reloads first.
    const group2Members = [cardNames[1], cardNames[3], cardNames[4], cardNames[5]];
    const group2 = await createGroupUiFirst(page, ctx, 12, 1, { name: 'A19 Proof Group 2', memberNames: group2Members, activationStrategy: 1, generationMode: 1 });
    report.groups.push({ case: 'group-2-after-reload-with-group-1-member', requested: group2Members, result: group2 });
    if (group2.ok !== true || group2.memberCount !== 4) report.failures.push({ stage: 'group-2-create', result: group2 });
    if ((group2.added ?? []).some(entry => entry.verified !== true || entry.viaFilter === true)) report.failures.push({ stage: 'group-2-adds-not-direct', added: group2.added });

    // 3) EXERCISE THE DISCLOSED PRODUCT-API FALLBACK directly (create -> edit -> verify).
    const apiMembers = [cardNames[0], cardNames[1], cardNames[2], cardNames[3]];
    report.apiFallback = await createGroupViaProductApi(page, { name: 'A19 Proof Group 3 API', memberNames: apiMembers, activationStrategy: 0, generationMode: 0, uiFailure: { reason: 'direct exercise of the disclosed fallback in this proof' } });
    if (report.apiFallback.ok !== true) report.failures.push({ stage: 'api-fallback', result: report.apiFallback });
} catch (error) {
    report.failures.push({ stage: 'fatal', error: String(error?.stack ?? error) });
} finally {
    if (browser) await browser.close().catch(() => {});
    if (provider) await provider.stop().catch(() => {});
    report.finishedAt = new Date().toISOString();
    report.ok = report.failures.length === 0
        && report.groups.length === 2
        && report.groups.every(group => group.result?.ok === true)
        && report.apiFallback?.ok === true;
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({
        ok: report.ok,
        cards: report.cards.map(card => `${card.name}:${card.ok}`),
        groups: report.groups.map(group => ({ case: group.case, name: group.result?.name, createdVia: group.result?.createdVia, ok: group.result?.ok, memberCount: group.result?.memberCount, currentlyOpenGroup: group.result?.currentlyOpenGroup, paginationUsed: group.result?.paginationUsed, added: group.result?.added, opened: group.opened?.ok ?? null })),
        apiFallback: { ok: report.apiFallback?.ok, createdVia: report.apiFallback?.createdVia, memberCount: report.apiFallback?.memberCount, uiFailure: report.apiFallback?.uiFailure },
        steps: report.steps.map(step => step.name ?? step.action).slice(0, 14),
        failures: report.failures,
        report: reportPath,
    }));
}
process.exit(report.ok === true ? 0 : 1);
