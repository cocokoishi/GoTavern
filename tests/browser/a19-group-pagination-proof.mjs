// a19-group-pagination-proof.mjs -- bounded proof for the create-group dialog on a FRESH root.
//
// The full round is CI's gate; this script proves ONLY the dialog/pagination path the harness had to fix:
//   - boot pinned through the wrapper (fresh root),
//   - import three cards with the exact names the corpus uses (through #character_import_file),
//   - open the create-group dialog TWICE and create two 4-member groups, both containing
//     `A19R1 The Quiet Archive 3`,
//   - assert each create step's read-back (ok, memberCount, added rows verified, paginationUsed) and write
//     the two step results as JSON.
//
// Run: node tests/browser/run-against-pinned.mjs a19-group-pagination-proof.mjs --data-root <fresh> -- \
//        --report <path>

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import { openPage, readReadiness } from './q20-persistence-drive.mjs';
import { writeCardPng, createGroupThroughPanel } from './a19-corpus-journeys.mjs';
import { corpusPaths } from './a19-corpus-kit.mjs';

const argv = process.argv.slice(2);
const argument = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] ?? fallback;
};
const baseURL = process.env.PROBE_BASE_URL ?? argument('--base-url', null);
const dataRoot = path.resolve(process.env.A19_DATA_ROOT ?? argument('--data-root', ''));
const reportPath = path.resolve(argument('--report', path.join(corpusPaths(12).roundDir, 'group-pagination-proof.json')));
const report = { schema: 'a19-group-pagination-proof-v1', startedAt: new Date().toISOString(), baseURL, dataRoot, cards: [], groups: [], failures: [] };
const cardNames = ['A19R1 The Quiet Archive 3', 'A19R1 Glass Garden 2', 'A19R1 烟雨客栈 4'];
const chromium = (await import('@playwright/test')).chromium;

let browser = null;
try {
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const page = await context.newPage();
    const loaded = await openPage(page, baseURL);
    const readiness = await readReadiness(page);
    if (loaded !== true || readiness?.settingsReady !== true) throw new Error(`page not ready: ${JSON.stringify(readiness)}`);
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
            firstMes: `A19_GROUP_PROOF greeting ${index + 1} for ${name}.`,
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
    const anchor = roster.find(name => name === 'A19R1 The Quiet Archive 3') ?? cardNames[0];
    if (roster.includes(anchor) === false) report.failures.push({ stage: 'anchor-missing', anchor, roster });
    const seed = roster.find(name => name === 'Seraphina') ?? roster.find(name => !cardNames.includes(name)) ?? anchor;
    const membersFor = attempt => {
        const set = [anchor, ...cardNames.filter(name => name !== anchor)];
        if (seed !== anchor && set.length < 4) set.push(seed);
        return set.slice(0, 4);
    };
    for (const attempt of [0, 1]) {
        const members = membersFor(attempt);
        const created = await createGroupThroughPanel(page, { name: `A19 Proof Group ${attempt + 1}`, memberNames: members, activationStrategy: attempt % 2, generationMode: attempt % 2 });
        const step = { attempt, name: `A19 Proof Group ${attempt + 1}`, requested: members, result: created };
        report.groups.push(step);
        const ok = created.ok === true && created.memberCount === members.length && (created.added ?? []).every(entry => entry.verified === true);
        if (!ok) report.failures.push({ stage: `group-create-${attempt}`, step });
    }
} catch (error) {
    report.failures.push({ stage: 'fatal', error: String(error?.stack ?? error) });
} finally {
    if (browser) await browser.close().catch(() => {});
    report.finishedAt = new Date().toISOString();
    report.ok = report.failures.length === 0 && report.groups.length === 2 && report.groups.every(group => group.result?.ok === true);
    await fs.mkdir(path.dirname(reportPath), { recursive: true });
    await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify({ ok: report.ok, cards: report.cards.map(card => `${card.name}:${card.ok}`), groups: report.groups.map(group => ({ name: group.name, ok: group.result?.ok, memberCount: group.result?.memberCount, paginationUsed: group.result?.paginationUsed, added: group.result?.added })), failures: report.failures, report: reportPath }));
}
process.exit(report.ok === true ? 0 : 1);
