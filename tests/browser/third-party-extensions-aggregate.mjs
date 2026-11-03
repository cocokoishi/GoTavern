#!/usr/bin/env node
// AGGREGATE EVERY SHARD OF THE THIRD-PARTY EXTENSION COMPATIBILITY GATE.
//
// WHY THIS IS A GATE OF ITS OWN. A sharded matrix can be green while a shard was skipped, a matrix
// expression silently dropped one extension, two shards ran the same extension, or a run from a
// different commit was mixed in. `conclusion == success` cannot see any of those. This aggregator
// checks the SET, not the statuses:
//
//   * schema version is known (an unknown/old artifact is a FAIL, never a default PASS);
//   * every shard reports the same lock SHA-256, head SHA, run id and shard count;
//   * the union of observed extension names is EXACTLY the lock's 20 -- no missing, no duplicate,
//     no unexpected name, and every row's pinned commit equals the lock's;
//   * every extension verdict is PASS and every capability verdict is PASS or N/A;
//   * the expected shards are exactly the ones observed.
//
// Outputs summary.json, matrix.json, junit.xml and matrix.md (the release-notes table) from the same
// data, so a document can never be assembled from a different run than the gate judged.
//
// Usage:
//   node third-party-extensions-aggregate.mjs --shards <dir> [--lock <path>] [--out-dir <dir>]
//     [--expected-sha <sha>] [--expected-run-id <id>]

import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { loadLock } from './third-party-extensions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

const shardsDirectory = path.resolve(argumentValue('--shards', '.'));
const lockInfo = loadLock(argumentValue('--lock', path.join(here, 'third-party-extensions.lock.json')));
const outDirectory = path.resolve(argumentValue('--out-dir', shardsDirectory));
const expectedSha = argumentValue('--expected-sha', process.env.GITHUB_SHA ?? null);
const expectedRunId = argumentValue('--expected-run-id', process.env.GITHUB_RUN_ID ?? null);
const schemaVersion = 1;

const problems = [];
const files = (await fs.readdir(shardsDirectory)).filter(name => /^shard-\d+\.json$/.test(name)).sort();
if (files.length === 0) problems.push(`no shard-*.json files in ${shardsDirectory}`);

const shards = [];
for (const file of files) {
    let shard;
    try {
        shard = JSON.parse(await fs.readFile(path.join(shardsDirectory, file), 'utf8'));
    } catch (error) {
        problems.push(`${file} is not readable JSON: ${error.message}`);
        continue;
    }
    if (shard.schemaVersion !== schemaVersion) {
        problems.push(`${file} has schemaVersion ${JSON.stringify(shard.schemaVersion)}, expected ${schemaVersion}; an unknown artifact schema is not a pass`);
        continue;
    }
    if (shard.surface !== 'third-party-extension-compatibility') problems.push(`${file} surface is ${JSON.stringify(shard.surface)}`);
    if (shard.provenance?.extensionsLockSha256 !== lockInfo.sha256) {
        problems.push(`${file} was measured against lock ${shard.provenance?.extensionsLockSha256}, but the repository lock is ${lockInfo.sha256}`);
    }
    if (expectedSha && shard.provenance?.headSha !== expectedSha) problems.push(`${file} headSha is ${shard.provenance?.headSha}, expected ${expectedSha}`);
    if (expectedRunId && shard.provenance?.runId !== expectedRunId) problems.push(`${file} runId is ${shard.provenance?.runId}, expected ${expectedRunId}`);
    shards.push({ file, shard });
}

if (shards.length > 0) {
    const shardCounts = new Set(shards.map(({ shard }) => shard.provenance?.shardCount));
    const shardIndexes = shards.map(({ shard }) => shard.provenance?.shardIndex).sort((a, b) => a - b);
    if (shardCounts.size !== 1) problems.push(`shards disagree about shardCount: ${[...shardCounts].join(', ')}`);
    const declared = [...shardCounts][0];
    if (declared !== shards.length) problems.push(`${shards.length} shard artifact(s) were observed, but the shards declare shardCount=${declared}; a missing shard artifact cannot be seen from conclusions alone`);
    for (let index = 1; index <= (declared ?? shards.length); index += 1) {
        if (!shardIndexes.includes(index)) problems.push(`shard ${index} is missing from the artifacts`);
    }
}

const lockNames = lockInfo.lock.selected.map(extension => extension.name);
const lockByName = new Map(lockInfo.lock.selected.map(extension => [extension.name, extension]));
const observed = new Map();
for (const { file, shard } of shards) {
    for (const name of shard.expectedNames ?? []) {
        if (!lockByName.has(name)) problems.push(`${file} declares expected extension ${JSON.stringify(name)} that is not in the lock`);
    }
    for (const row of shard.rows ?? []) {
        if (observed.has(row.name)) problems.push(`${row.name} was tested by more than one shard (${observed.get(row.name).file} and ${file})`);
        observed.set(row.name, { file, row });
        const lockEntry = lockByName.get(row.name);
        if (!lockEntry) {
            problems.push(`${file} tested ${JSON.stringify(row.name)} which is not in the lock`);
            continue;
        }
        if (row.commit !== lockEntry.commit) problems.push(`${row.name} was tested at ${row.commit}, but the lock pins ${lockEntry.commit}`);
        if (row.verdict !== 'PASS') problems.push(`${row.name} verdict is ${row.verdict}${row.failure ? `: ${row.failure}` : ''}`);
        for (const [capability, verdict] of Object.entries(row.capabilityVerdicts ?? {})) {
            if (verdict !== 'PASS' && verdict !== 'N/A') problems.push(`${row.name} capability ${capability} verdict is ${verdict}`);
        }
    }
}
const missing = lockNames.filter(name => !observed.has(name));
const unexpected = [...observed.keys()].filter(name => !lockByName.has(name));
if (missing.length > 0) problems.push(`extensions in the lock that no shard tested: ${missing.join(', ')}`);
if (unexpected.length > 0) problems.push(`extensions tested that are not in the lock: ${unexpected.join(', ')}`);
if (observed.size !== lockInfo.lock.selected.length) problems.push(`observed ${observed.size} extension(s), expected ${lockInfo.lock.selected.length}`);

const rows = lockNames.map(name => {
    const lockEntry = lockByName.get(name);
    const observation = observed.get(name);
    return {
        name,
        repo: lockEntry.repo,
        commit: lockEntry.commit,
        starsSnapshot: lockEntry.starsSnapshot,
        forksSnapshot: lockEntry.forksSnapshot,
        license: lockEntry.license,
        capabilities: lockEntry.capabilities,
        stock: observation?.row ? 'PASS' : 'NOT-OBSERVED',
        gotavern: observation?.row?.verdict ?? 'NOT-OBSERVED',
        capabilityVerdicts: observation?.row?.capabilityVerdicts ?? null,
        shard: observation?.file ?? null,
        durationMs: observation?.row?.durationMs ?? null,
    };
});

const summary = {
    schemaVersion,
    surface: 'third-party-extension-compatibility-summary',
    generatedAt: new Date().toISOString(),
    lock: { path: path.basename(lockInfo.path), sha256: lockInfo.sha256, snapshotAt: lockInfo.lock.snapshotAt },
    stockSillyTavernSha: shards[0]?.shard.provenance?.stockSillyTavernSha ?? null,
    shards: shards.map(({ file, shard }) => ({ file, index: shard.provenance?.shardIndex, count: shard.provenance?.shardCount, headSha: shard.provenance?.headSha, runId: shard.provenance?.runId })),
    expected: lockNames.length,
    observed: observed.size,
    compatible: rows.filter(row => row.gotavern === 'PASS').length,
    missing,
    unexpected,
    problems,
    ok: problems.length === 0,
    rows,
};
await fs.mkdir(outDirectory, { recursive: true });
await fs.writeFile(path.join(outDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
await fs.writeFile(path.join(outDirectory, 'matrix.json'), `${JSON.stringify({ schemaVersion, lockSha256: lockInfo.sha256, rows }, null, 2)}\n`);

// JUnit, so the shard results render in any CI UI without a custom parser.
const escape = text => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cases = rows.map(row => {
    const failure = row.gotavern === 'PASS' ? '' : `<failure message="${escape(row.gotavern)}">${escape(`${row.name} @ ${row.commit}: ${row.gotavern}`)}</failure>`;
    return `    <testcase classname="third-party-extension-compatibility" name="${escape(row.name)}" time="${((row.durationMs ?? 0) / 1000).toFixed(1)}">${failure}</testcase>`;
}).join('\n');
await fs.writeFile(path.join(outDirectory, 'junit.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="third-party-extension-compatibility" tests="${rows.length}" failures="${rows.filter(row => row.gotavern !== 'PASS').length}" timestamp="${summary.generatedAt}">\n${cases}\n</testsuite>\n`);

// The release-notes table, generated from the same rows the gate judged.
const table = [
    '| # | Extension | Repository | Pinned commit | Capabilities | Stock | GoTavern |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((row, index) => `| ${index + 1} | ${row.name} | ${row.repo} | \`${row.commit.slice(0, 12)}\` | ${row.capabilities.join(', ')} | ${row.stock} | ${row.gotavern} |`),
].join('\n');
await fs.writeFile(path.join(outDirectory, 'matrix.md'), `${table}\n`);

console.log(JSON.stringify({ ok: summary.ok, expected: summary.expected, observed: summary.observed, compatible: summary.compatible, missing, unexpected, problems, outDirectory }, null, 2));
if (!summary.ok) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
}
