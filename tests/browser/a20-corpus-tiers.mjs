// a20-corpus-tiers.mjs -- the alpha.20 multi-tier corpus driver (small / medium / large).
//
// WHAT IT DOES. It is the reproducible top-level recipe for a tier: start from a FRESH data root, run
// the real pinned-UI base rounds (a19-corpus-builder.mjs rounds 1-3), top up the categories the tier
// still needs (a20-corpus-topup.mjs), push the message count through the proven send path plus the
// PRODUCT's own save function where the timebox requires it (a19-message-topup.mjs, which records the
// split), then freeze the tree (a19-corpus-finalize.mjs) and write the alpha.20 report
// (a20-corpus-report.mjs) with per-category target/achieved counts and the disclosed provenance layers.
//
// IT IS A DRIVER, NOT A NEW ORACLE: every step invokes an existing committed tool or the additive a20
// top-up/report tools. Nothing here writes product data directly.
//
// HONESTY RULES BAKED IN:
//   * Every builder step runs through run-against-pinned.mjs, so the subject is the pinned checkout at
//     the pin and the data root is the only writable product tree.
//   * A shortfall is recorded, not hidden: the report tool writes reached:false and the achieved count.
//   * Generated inputs (cards/books/presets the UI imports) are inputs, never counted as created data.
//
// USAGE
//   node tests/browser/a20-corpus-tiers.mjs --tier small|medium|large --root <corpus root> [--dry-run]
//     [--rounds 1,2,3] [--skip-message-topup] [--message-budget-ms 120000]
//
// The corpus root layout this driver creates:
//   <root>/data      the corpus data root (the tree the oracle boots)
//   <root>/scratch   builder artifacts: round reports, action logs, provider recordings
//   <root>/manifest.json + <root>/corpus-report.json   the committed-provenance candidates
// The tree itself stays outside the repository (AGENTS rule 56: the corpus is an input, not a commit).

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const argv = process.argv.slice(2);
const argument = (name, fallback = null) => {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    return argv[index + 1] ?? fallback;
};
const hasFlag = name => argv.includes(name);

const tier = argument('--tier', 'medium');
const root = path.resolve(argument('--root', ''));
const dryRun = hasFlag('--dry-run');
const rounds = (argument('--rounds', '1,2,3') ?? '1,2,3').split(',').map(Number).filter(value => [1, 2, 3].includes(value));
const skipMessageTopup = hasFlag('--skip-message-topup');
const messageBudgetMs = Number(argument('--message-budget-ms', '120000'));
if (!root) { console.error('usage: node a20-corpus-tiers.mjs --tier small|medium|large --root <corpus root> [--dry-run]'); process.exit(2); }

const TARGETS = {
    small: { cards: 8, worlds: 2, worldEntries: 16, presets: 4, chats: 10, messages: 80, groups: 2 },
    medium: { cards: 64, worlds: 12, worldEntries: 200, presets: 20, chats: 100, messages: 3000, groups: 8 },
    large: { cards: 200, worlds: 30, worldEntries: 800, presets: 50, chats: 500, messages: 20000, groups: 20 },
};
const target = TARGETS[tier];
if (!target) { console.error(`unknown tier ${JSON.stringify(tier)}`); process.exit(2); }

const dataRoot = path.join(root, 'data');
const scratch = path.join(root, 'scratch');
const run = (label, command, args, { env = {}, timeoutMs = 0 } = {}) => {
    const line = `${command} ${args.join(' ')}`;
    console.log(`[a20-tiers] ${label}: ${line}`);
    if (dryRun) return { status: 0, skipped: true };
    fs.mkdirSync(scratch, { recursive: true });
    fs.mkdirSync(dataRoot, { recursive: true });
    const result = spawnSync(command, args, {
        cwd: path.join(repoRoot, 'tests', 'browser'),
        stdio: 'inherit',
        timeout: timeoutMs > 0 ? timeoutMs : undefined,
        env: { ...process.env, ...env, A19_SCRATCH: scratch, A19_DATA_ROOT: dataRoot, PINNED_READY_MS: process.env.PINNED_READY_MS ?? '300000' },
    });
    return { status: result.status ?? 1 };
};

// The tier layout: small runs round 1 only and a short top-up; medium runs all three base rounds.
const baseRounds = tier === 'small' ? rounds.filter(round => round === 1) : rounds;
const failures = [];
for (const round of baseRounds) {
    const report = path.join(scratch, `round${round}`, 'report.json');
    const result = run(`base-round-${round}`, process.execPath, [
        'run-against-pinned.mjs', 'a19-corpus-builder.mjs', '--data-root', dataRoot, '--', '--round', String(round),
    ]);
    if (result.status !== 0) failures.push({ step: `base-round-${round}`, status: result.status, report });
}

// Top-up only what the target still needs; the tool measures the tree itself and imports the shortfall.
const topupReport = path.join(scratch, 'a20-topup.json');
const topupArgs = [
    'run-against-pinned.mjs', 'a20-corpus-topup.mjs', '--data-root', dataRoot, '--',
    '--cards-target', String(target.cards),
    '--worlds-target', String(target.worlds),
    '--world-entries', String(tier === 'small' ? 8 : 10),
    '--presets-target', String(target.presets),
    '--groups-target', String(target.groups),
    '--report', topupReport,
    '--actions', path.join(scratch, 'actions-a20-topup.jsonl'),
];
if (tier !== 'small' || target.groups > 2) {
    const result = run('topup-categories', process.execPath, topupArgs);
    if (result.status !== 0) failures.push({ step: 'topup-categories', status: result.status, report: topupReport });
}

// Messages: proven send path first, then the product's own save function for the timebox remainder.
const messageReport = path.join(scratch, 'a20-message-topup.json');
if (!skipMessageTopup) {
    const addChats = Math.max(0, target.chats - (tier === 'small' ? 6 : 50));
    const result = run('message-topup', process.execPath, [
        'run-against-pinned.mjs', 'a19-message-topup.mjs', '--data-root', dataRoot, '--',
        '--report', messageReport,
        '--actions', path.join(scratch, 'actions-a20-message-topup.jsonl'),
        '--target', String(target.messages),
        '--budget-ms', String(messageBudgetMs),
        '--add-cards', '0',
        '--add-chats', String(addChats),
        '--turns-per-chat', String(tier === 'small' ? 8 : 5),
    ], { timeoutMs: 0 });
    if (result.status !== 0) failures.push({ step: 'message-topup', status: result.status, report: messageReport });
}

// Freeze the tree, then report counts + provenance (the report refuses to invent a count).
const manifest = path.join(root, 'manifest.json');
const reportFile = path.join(root, 'corpus-report.json');
const finalize = run('finalize-manifest', process.execPath, [
    'a19-corpus-finalize.mjs', '--data-root', dataRoot, '--out', manifest, '--tier', tier,
]);
if (finalize.status !== 0) failures.push({ step: 'finalize-manifest', status: finalize.status });
else {
    const roundReports = baseRounds.map(round => path.join(scratch, `round${round}`, 'report.json')).filter(file => fs.existsSync(file));
    const report = run('tier-report', process.execPath, [
        'a20-corpus-report.mjs', '--manifest', manifest, '--out', reportFile, '--tier', tier,
        '--round-reports', roundReports.join(','),
        '--topup', topupReport,
        '--messages', messageReport,
        '--seed', argument('--seed', 'deterministic-provider-peer'),
    ]);
    if (report.status !== 0) failures.push({ step: 'tier-report', status: report.status });
}

console.log(`[a20-tiers] tier ${tier}: ${failures.length === 0 ? 'driver completed' : 'FAILURES: ' + JSON.stringify(failures)}`);
console.log(`[a20-tiers] data root: ${dataRoot}`);
console.log(`[a20-tiers] manifest: ${manifest}${fs.existsSync(manifest) ? '' : ' (not written)'}`);
console.log(`[a20-tiers] report: ${reportFile}${fs.existsSync(reportFile) ? '' : ' (not written)'}`);
process.exit(failures.length === 0 ? 0 : 1);
