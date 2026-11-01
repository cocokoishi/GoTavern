#!/usr/bin/env node
// CONFIGURATION PARITY, COMPUTED FROM THE PINNED FILE.
//
// The pinned `default/config.yaml` is the input: every EFFECTIVE leaf key in it — 116 at baseline
// 06bde939 — gets exactly one row in docs/config-parity.md, classified with the vocabulary in
// tools/inventories/config-parity.json. A key that no rule names falls to the documented `inherited`
// default, so the table is a TOTAL function over the pinned key set: a new upstream key changes this
// document instead of quietly entering the product without a classification.
//
// WHAT IS CHECKED, so a row cannot claim ahead of evidence (AGENTS.md 36):
//   * every cited Go test name exists in the COMMITTED test tree (`git ls-files`), so a deleted or
//     renamed test turns the document red;
//   * every cited implementation path exists;
//   * the keys classified `explicit-no-op-with-startup-warning` are exactly the keys the honesty channel
//     (internal/commandline/unimplemented_config.go) actually warns about, in BOTH directions — a warning
//     added without a row, or a row claiming a warning that is not emitted, is a failure;
//   * the CLI option list is parsed from the real parser table in internal/commandline/options.go, not
//     retyped here;
//   * `--check` refuses a tree whose committed document differs from the emitted one.
//
// Usage:
//   node tools/generate-config-parity.mjs --emit
//   node tools/generate-config-parity.mjs --check

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINNED_CONFIG = 'upstream/default/config.yaml';
const DATA = 'tools/inventories/config-parity.json';
const WARNINGS_SOURCE = 'internal/commandline/unimplemented_config.go';
const OPTIONS_SOURCE = 'internal/commandline/options.go';
const OUTPUT = 'docs/config-parity.md';

const read = relative => readFileSync(path.join(ROOT, relative), 'utf8');

// ---- pinned key enumeration -----------------------------------------------------------------------
// A deliberately small YAML reader: the pinned file is flat maps, block sequences and one flow map, and
// pulling in a YAML dependency to read four shapes would be a bigger surface than the file.
export function pinnedConfigLeaves(yamlText) {
    const lines = yamlText.split(/\r?\n/);
    const stack = [];
    const entries = [];
    for (const raw of lines) {
        if (!raw.trim() || raw.trim().startsWith('#')) continue;
        const indent = raw.length - raw.trimStart().length;
        const text = raw.trim();
        if (text.startsWith('- ')) {
            while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
            if (stack.length) stack[stack.length - 1].sequence = true;
            continue;
        }
        const match = /^(['"]?)([A-Za-z0-9_.-]+)\1\s*:(.*)$/.exec(text);
        if (!match) continue;
        while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
        const node = { indent, name: match[2], value: match[3].trim(), sequence: false, flow: null };
        stack.push(node);
        entries.push({ node, path: stack.map(part => part.name) });
        const flowMap = /^\{(.*)\}\s*$/.exec(node.value);
        if (flowMap) node.flow = [...flowMap[1].matchAll(/(['"]?)([A-Za-z0-9_.-]+)\1\s*:/g)].map(item => item[2]);
    }
    const byPath = new Map();
    for (const entry of entries) byPath.set(entry.path.join('.'), entry);
    const leaves = [];
    for (const [key, entry] of byPath) {
        if (entry.node.flow && entry.node.flow.length) {
            for (const child of entry.node.flow) leaves.push({ key: `${key}.${child}`, value: null });
            continue;
        }
        const hasChildren = [...byPath.keys()].some(other => other.startsWith(key + '.'));
        if (hasChildren) continue;
        if (entry.node.value === '' && !entry.node.sequence) continue;
        leaves.push({ key, value: entry.node.value === '' ? '(sequence)' : entry.node.value });
    }
    return leaves.sort((left, right) => left.key.localeCompare(right.key));
}

function globMatches(pattern, key) {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '.*');
    return new RegExp(`^${escaped}$`).test(key);
}

// ---- committed test names -------------------------------------------------------------------------
function committedTestNames() {
    const files = execFileSync('git', ['ls-files', '--', 'internal'], { cwd: ROOT, encoding: 'utf8' })
        .split('\n').filter(name => name.endsWith('_test.go'));
    const names = new Set();
    for (const file of files) {
        for (const match of read(file).matchAll(/^func (Test[A-Za-z0-9_]+)\(/gm)) names.add(match[1]);
    }
    return names;
}

function warnKeysFromSource(pinnedKeys) {
    const text = read(WARNINGS_SOURCE);
    // Every EXACT pinned key the honesty channel names as a quoted literal. Messages are prose and are
    // not exact literals, so they cannot be mistaken for a warning key; a top-level key (no dot, e.g.
    // enableServerPlugins) is included because it is still a pinned key.
    return [...text.matchAll(/"([^"]+)"/g)]
        .map(match => match[1])
        .filter(value => pinnedKeys.has(value));
}

function cliOptionsFromSource() {
    const text = read(OPTIONS_SOURCE);
    const block = /var cliOptionKinds = map\[string\]cliOptionKind\{([\s\S]*?)\n\}/.exec(text);
    if (!block) throw new Error(`${OPTIONS_SOURCE}: the cliOptionKinds table was not found`);
    return [...block[1].matchAll(/"([A-Za-z0-9_]+)":\s*(cli[A-Za-z]+)/g)].map(match => ({ name: match[1], kind: match[2] }));
}

export function buildReport() {
    const data = JSON.parse(read(DATA));
    const leaves = pinnedConfigLeaves(read(PINNED_CONFIG));
    const testNames = committedTestNames();
    const warningKeys = new Set(warnKeysFromSource(new Set(leaves.map(leaf => leaf.key))));
    const problems = [];

    const categories = data.categories;
    const classified = new Map();
    for (const leaf of leaves) {
        const matching = data.rules.filter(rule => rule.match.some(pattern => globMatches(pattern, leaf.key)));
        if (matching.length > 1) {
            problems.push(`config key ${leaf.key} matches ${matching.length} classification rules; the data must classify it once`);
            continue;
        }
        const rule = matching[0] ?? data.default;
        const row = {
            key: leaf.key,
            pinnedValue: leaf.value ?? '(flow map)',
            classification: rule.classification,
            tests: rule.tests ?? [],
            implementation: rule.implementation ?? [],
            note: rule.note ?? '',
        };
        if (!categories[row.classification]) problems.push(`config key ${leaf.key} uses unknown classification ${row.classification}`);
        for (const test of row.tests) {
            if (!testNames.has(test)) problems.push(`${leaf.key} cites Go test ${test}, which is not a declared test in the committed tree`);
        }
        for (const file of row.implementation) {
            if (!existsSync(path.join(ROOT, file))) problems.push(`${leaf.key} cites implementation ${file}, which does not exist`);
        }
        classified.set(leaf.key, row);
    }
    // The honesty channel must agree with the data in BOTH directions.
    for (const [key, row] of classified) {
        const warns = row.classification === 'explicit-no-op-with-startup-warning';
        if (warns && !warningKeys.has(key)) {
            problems.push(`${key} is classified as warned but ${WARNINGS_SOURCE} never mentions it`);
        }
        if (!warns && warningKeys.has(key)) {
            problems.push(`${WARNINGS_SOURCE} warns about ${key}, but the classification is ${row.classification}`);
        }
    }
    const rows = [...classified.values()];
    const counts = Object.fromEntries(Object.keys(categories).map(category => [category, rows.filter(row => row.classification === category).length]));
    const cli = cliOptionsFromSource();
    const cliEvidence = data.cliOptions.evidence ?? [];
    for (const test of cliEvidence) {
        if (!testNames.has(test)) problems.push(`CLI evidence cites Go test ${test}, which is not a declared test in the committed tree`);
    }
    if (counts.inherited === 0 && problems.length === 0) problems.push('every pinned key is classified as something stronger than inherited; that is not this tree');
    return { data, rows, counts, cli, cliEvidence, problems, categories };
}

function slug(value) {
    return value.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase();
}

export function render(report) {
    const { data, rows, counts, cli, cliEvidence, categories } = report;
    const lines = [];
    lines.push('# Configuration parity');
    lines.push('');
    lines.push(`Generated from \`${PINNED_CONFIG}\` (pinned SillyTavern 1.19.0, commit 06bde939fb1e9c4c8d8641d810f0a916b5bce127) and \`${DATA}\` by \`tools/generate-config-parity.mjs\`. Do not edit by hand: \`--check\` fails on drift.`);
    lines.push('');
    lines.push('Every effective leaf key in the pinned default configuration has exactly one row below. The');
    lines.push('classification vocabulary is the mission vocabulary: `implemented` means a named Go test fails if');
    lines.push('the behaviour is removed; `explicit-no-op-with-startup-warning` means the key is carried and a');
    lines.push('non-default value prints a named warning; `explicit-unsupported` means a documented decision not to');
    lines.push('port the behaviour; `inherited` means this lane has no key-level behaviour evidence and the row is');
    lines.push('the explicit work list rather than a parity claim; `not-applicable` means the pinned subsystem is a');
    lines.push('documented architecture exclusion.');
    lines.push('');
    lines.push('## Category definitions');
    lines.push('');
    for (const [category, meaning] of Object.entries(categories)) {
        lines.push(`- **${category}** — ${meaning}`);
    }
    lines.push('');
    lines.push('## Counts');
    lines.push('');
    lines.push(`Pinned default leaf keys inventoried: **${rows.length}**. CLI options parsed by GoTavern: **${cli.length}**.`);
    lines.push('');
    lines.push('| Classification | Keys |');
    lines.push('|---|---|');
    for (const category of Object.keys(categories)) lines.push(`| ${category} | ${counts[category]} |`);
    lines.push(`| **total** | **${rows.length}** |`);
    lines.push('');
    lines.push('## Per-key table');
    lines.push('');
    lines.push('| Config key | Pinned default | Classification | Evidence (Go test / implementation) | Note |');
    lines.push('|---|---|---|---|---|');
    for (const row of rows) {
        const evidence = [
            ...row.tests.map(test => `\`${test}\``),
            ...row.implementation.map(file => `\`${file}\``),
        ].join('<br>') || '—';
        lines.push(`| \`${row.key}\` | ${row.pinnedValue === '(sequence)' || row.pinnedValue === '(flow map)' ? row.pinnedValue : `\`${row.pinnedValue.replaceAll('|', '\\|')}\``} | ${row.classification} | ${evidence} | ${row.note.replaceAll('|', '\\|')} |`);
    }
    lines.push('');
    lines.push('## CLI options');
    lines.push('');
    lines.push(`Parsed from \`${OPTIONS_SOURCE}\` (\`cliOptionKinds\`), not retyped: every option GoTavern\'s parser knows is listed, with the parser's own kind. ${data.cliOptions.note}`);
    lines.push('');
    lines.push('| CLI option | Kind | Status |');
    lines.push('|---|---|---|');
    for (const option of cli) {
        const override = data.cliOptions.overrides?.[option.name] ?? 'parsed and resolved by `ResolveCommandLine`';
        lines.push(`| \`--${option.name}\` | ${option.kind} | ${override} |`);
    }
    lines.push('');
    if (cliEvidence.length) {
        lines.push(`CLI evidence: ${cliEvidence.map(test => `\`${test}\``).join(', ')}.`);
        lines.push('');
    }
    lines.push('## Startup warnings for accepted-but-unimplemented keys');
    lines.push('');
    lines.push('The honesty channel is `internal/commandline/unimplemented_config.go`. It fires only for a key whose');
    lines.push('effective value differs from the pinned shipped default (so a stock install prints nothing) and it is');
    lines.push('capped at a bounded number of lines, with an overflow line naming how many more settings are in scope.');
    lines.push('');
    lines.push('| Warned key | Behaviour that is missing |');
    lines.push('|---|---|');
    for (const row of rows.filter(entry => entry.classification === 'explicit-no-op-with-startup-warning')) {
        lines.push(`| \`${row.key}\` | ${row.note.replaceAll('|', '\\|')} |`);
    }
    lines.push('');
    return lines.join('\n');
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (isMain) {
    const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--emit') ? 'emit' : null;
    if (!mode) {
        console.error('usage: node tools/generate-config-parity.mjs --emit | --check');
        process.exit(2);
    }
    const report = buildReport();
    if (report.problems.length) {
        console.error(`configuration parity: ${report.problems.length} problem(s)`);
        for (const problem of report.problems) console.error(`  - ${problem}`);
        process.exit(1);
    }
    const document = render(report);
    if (mode === 'emit') {
        writeFileSync(path.join(ROOT, OUTPUT), `${document}\n`, 'utf8');
        console.log(`wrote ${OUTPUT} (${report.rows.length} pinned key(s), ${report.cli.length} CLI option(s))`);
    } else {
        const committed = read(OUTPUT);
        if (committed.replaceAll('\r\n', '\n') !== `${document}\n`) {
            console.error(`${OUTPUT} is stale (run: node tools/generate-config-parity.mjs --emit)`);
            process.exit(1);
        }
        console.log(`configuration parity: ${report.rows.length} pinned key(s) classified, ${report.cli.length} CLI option(s), warnings agree with the honesty channel — up to date`);
    }
}
