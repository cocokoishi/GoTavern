// Compare TWO shared corpus schemas and name every difference class (alpha.15 lane E, §0.3).
//
// §0.3 asks whether ONE deterministic initial corpus can feed Go, Node, browser and provider-wire tests.
// This tool measures the answer instead of asserting it: it takes the Go complex instance's schema and the
// browser/Node corpus's schema, compares them file-by-file, class-by-class, count-by-count, feature-by-
// feature and marker-by-marker, and reports
//
//   decision: "ONE_CORPUS_BYTE_IDENTICAL"  only when every path exists on both sides with an equal sha256;
//             "TWO_CORPORA_SHARED_SCHEMA"    otherwise (the expected, measured result).
//   byteIdentical                          true only when the file sets and every sha256 are equal.
//   differenceClasses                      EVERY named difference with its measured evidence, so a report
//                                          can say WHY two corpora exist rather than claiming equivalence.
//   separateCorporaJustified               true when the measured differences include coverage that one
//                                          corpus has and the other does not (files, classes or features).
//
// The schema is a shared CONTRACT, not a claim of equality: both generators emit it, both trees can be
// verified with tools/longlived/verify-corpus-schema.mjs, and this tool decides identity only from bytes.
//
// Usage:
//   node tools/longlived/compare-corpora.mjs --left <schema.json> --right <schema.json> \
//        [--out <report.json>] [--markdown <report.md>] [--quiet]

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareCorpora, loadSchema, renderComparisonMarkdown } from './corpus-schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

function usage(message) {
    if (message) console.error(`compare-corpora: ${message}`);
    console.error('usage: node tools/longlived/compare-corpora.mjs --left <schema.json> --right <schema.json> [--out <file>] [--markdown <file>] [--quiet]');
    process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const leftPath = argument('--left');
    const rightPath = argument('--right');
    if (!leftPath) usage('--left is required');
    if (!rightPath) usage('--right is required');
    const outPath = argument('--out', null);
    const markdownPath = argument('--markdown', null);
    const quiet = process.argv.includes('--quiet');

    const report = {
        schema: 'gotavern-corpus-comparison',
        schemaVersion: 1,
        tool: 'tools/longlived/compare-corpora.mjs',
        repoRoot: REPO_ROOT,
        leftPath: path.resolve(leftPath),
        rightPath: path.resolve(rightPath),
    };
    try {
        const left = await loadSchema(path.resolve(leftPath));
        const right = await loadSchema(path.resolve(rightPath));
        Object.assign(report, compareCorpora(left, right));
    } catch (error) {
        report.ok = false;
        report.error = String(error?.message ?? error);
        report.decision = 'COMPARISON_HARNESS_ERROR';
        report.differenceClasses = [];
        report.separateCorporaJustified = false;
    }
    report.ok = report.decision === 'ONE_CORPUS_BYTE_IDENTICAL' || report.decision === 'TWO_CORPORA_SHARED_SCHEMA';
    const payload = `${JSON.stringify(report, null, 2)}\n`;
    if (outPath) await fs.writeFile(path.resolve(outPath), payload, 'utf8');
    if (markdownPath && report.left && report.right) await fs.writeFile(path.resolve(markdownPath), renderComparisonMarkdown(report), 'utf8');
    if (!quiet) {
        console.error(`left:  ${report.left?.generator ?? '?'} (${report.left?.files ?? '?'} files, tree ${String(report.left?.treeSha256 ?? '').slice(0, 16)}…)`);
        console.error(`right: ${report.right?.generator ?? '?'} (${report.right?.files ?? '?'} files, tree ${String(report.right?.treeSha256 ?? '').slice(0, 16)}…)`);
        console.error(`decision: ${report.decision}; byteIdentical: ${report.byteIdentical}; shared paths: ${report.identicalPaths}/${report.sharedPaths}; difference classes: ${report.differenceClasses?.length ?? 0}`);
        for (const entry of (report.differenceClasses ?? []).slice(0, 40)) console.error(`  ${entry.name}`);
    }
    console.log(JSON.stringify({
        ok: report.ok,
        decision: report.decision,
        byteIdentical: report.byteIdentical,
        separateCorporaJustified: report.separateCorporaJustified,
        differenceClasses: (report.differenceClasses ?? []).map(entry => entry.name),
        left: report.left,
        right: report.right,
    }));
    if (!report.ok) process.exit(1);
}
