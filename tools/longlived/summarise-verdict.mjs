#!/usr/bin/env node
// RENDER A MACHINE-READABLE QUALIFICATION VERDICT AS A JOB-SUMMARY TABLE.
//
// WHY A TOOL AND NOT A HEREDOC IN THE WORKFLOW: an embedded heredoc inside a YAML literal block has to be re-indented
// for the YAML parser, and then its shell terminator is no longer flush, so the heredoc silently swallows the rest of
// the step. Measured while writing .github/workflows/longlived.yml: YAML parsed, the shell step would not. One small
// program is auditable, testable and cannot corrupt the step that calls it.
//
// USAGE:
//   node tools/longlived/summarise-verdict.mjs --verdict <file.json> --label "long-lived corpus (small)"
//   (writes Markdown to stdout; exit 0 when the verdict says ok, 1 when it does not, 2 when it cannot read it)

import fs from 'node:fs/promises';

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

const file = argument('--verdict');
const label = argument('--label', 'qualification verdict');
if (!file) {
    console.error('usage: node tools/longlived/summarise-verdict.mjs --verdict <json> [--label <text>]');
    process.exit(2);
}

let verdict;
try {
    verdict = JSON.parse(await fs.readFile(file, 'utf8'));
} catch (error) {
    console.error(`could not read/parse ${file}: ${error?.message ?? error}`);
    process.exit(2);
}

const line = (key, value) => console.log(`- ${key}: ${value}`);
console.log(`### ${label}: ${verdict.ok === true ? 'PASS' : 'FAIL'}`);
line('schema', `\`${verdict.schema ?? 'unknown'}\``);
if (verdict.schema === 'gotavern-longlived-corpus') {
    // The loader's own verdict shape (tools/longlived/verify.mjs).
    line('size / seed', `\`${verdict.size}\` / \`${verdict.seed}\``);
    line('files / bytes', `${verdict.tree?.files} / ${verdict.tree?.bytes}`);
    line('tree sha256', `\`${verdict.tree?.sha256}\``);
    const failed = (verdict.checks ?? []).filter(check => check.ok !== true).map(check => check.name);
    line('checks', `${(verdict.checks ?? []).length} (${failed.length} failed${failed.length ? `: ${failed.join(', ')}` : ''})`);
} else if (verdict.schema === 'gotavern-longlived-verdict') {
    line('size', `\`${verdict.size}\``);
    line('corpus', `\`${verdict.corpus?.treeSha256}\` (${verdict.corpus?.files} files, ${verdict.corpus?.bytes} bytes)`);
    line('comparison', `\`${JSON.stringify(verdict.comparison?.summary ?? {})}\``);
    line('failed checks', `\`${JSON.stringify(verdict.comparison?.failed ?? [])}\``);
    line('teeth', `\`${JSON.stringify(verdict.teeth?.summary ?? {})}\``);
    line('legs', (verdict.legReports ?? []).map(leg => `${leg.subject ?? 'driver'}/${leg.phase ?? leg.name ?? '?'}: ${leg.skipped ? 'skipped' : leg.exitCode}`).join(', '));
} else if (verdict.schema === 'gotavern-published-upgrade-verdict') {
    line('baseline', `\`${verdict.baseline?.publishedTag}\` checksumVerified=${verdict.baseline?.checksumVerified} assetSha256=\`${verdict.baseline?.assetSha256}\``);
    line('candidate', `\`${verdict.candidate?.tag}\``);
    line('corpus', `\`${JSON.stringify(verdict.corpus ?? {})}\``);
    line('journey', `\`${JSON.stringify(verdict.journey ?? {})}\``);
    line('backup', `\`${JSON.stringify(verdict.backup ?? {})}\``);
    line('migration', `\`${JSON.stringify(verdict.migration ?? {})}\``);
    if (verdict.failure) line('failure', `\`${verdict.failure}\``);
} else {
    line('raw', `\`${JSON.stringify(verdict).slice(0, 1200)}\``);
}
process.exit(verdict.ok === true ? 0 : 1);
