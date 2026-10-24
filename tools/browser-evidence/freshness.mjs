#!/usr/bin/env node
// FRESHNESS: does the artefact a run just produced say the same thing as the committed one?
//
// This is the question the verifier CANNOT answer, and the reason is structural rather than temporary:
// the verifier reads committed bytes and has no legs, because legs are gitignored on purpose. So the
// only way to learn that a committed comparison no longer describes HEAD is to RUN the drive again and
// diff the result against the committed file. That is what .github/workflows/browser-differential.yml
// does, and this module turns its two files into a named, ordered list of differences.
//
// WHAT IS COMPARED, AND WHAT IS DELIBERATELY NOT.
//   * Every field of both documents, by JSON path, so a difference is named rather than shown as a diff
//     of reordered keys.
//   * `captures` / `inputs` are EXCLUDED with a stated reason: they are the per-run FILE NAMES of the
//     legs (`stream-a.json` vs `stream-groq-gotavern.json`), which differ whenever a run names its legs
//     differently and says nothing about either server. Everything else -- including driveParameters
//     prose -- is compared, because a changed sentence about how a leg was aimed is exactly the drift
//     this report exists to surface.
//
// EXIT CODES. 0 when the two agree, 1 when they differ. A workflow that only ever prints a report can
// be ignored; a workflow that fails on a difference and says WHICH field is actionable.
//
// Usage: node tools/browser-evidence/freshness.mjs <committed.json> <fresh.json> [--json]

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const RUN_LOCAL_FIELDS = new Set(['captures', 'inputs']);

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Flattens a document into { 'a.b[0].c': value } so a difference can be named by its path. */
function flatten(value, prefix = '', into = new Map()) {
    if (Array.isArray(value)) {
        if (value.length === 0) into.set(prefix, []);
        value.forEach((item, index) => flatten(item, `${prefix}[${index}]`, into));
        return into;
    }
    if (isPlainObject(value)) {
        const keys = Object.keys(value);
        if (keys.length === 0) into.set(prefix, {});
        for (const key of keys) {
            if (prefix === '' && RUN_LOCAL_FIELDS.has(key)) continue;
            flatten(value[key], prefix === '' ? key : `${prefix}.${key}`, into);
        }
        return into;
    }
    into.set(prefix, value);
    return into;
}

/** The differences between two artifacts, in document order of the committed one. */
export function compareArtifacts(committed, fresh) {
    const left = flatten(committed);
    const right = flatten(fresh);
    const differences = [];
    for (const [path, value] of left) {
        if (!right.has(path)) {
            differences.push({ path, kind: 'removed', committed: value });
        } else if (JSON.stringify(value) !== JSON.stringify(right.get(path))) {
            differences.push({ path, kind: 'changed', committed: value, fresh: right.get(path) });
        }
    }
    for (const [path, value] of right) {
        if (!left.has(path)) differences.push({ path, kind: 'added', fresh: value });
    }
    return { identical: differences.length === 0, differences, excluded: [...RUN_LOCAL_FIELDS] };
}

const show = value => JSON.stringify(value)?.slice(0, 240) ?? String(value);

const main = () => {
    const [committedPath, freshPath] = process.argv.slice(2).filter(argument => !argument.startsWith('--'));
    const asJson = process.argv.includes('--json');
    if (!committedPath || !freshPath) {
        console.error('usage: node tools/browser-evidence/freshness.mjs <committed.json> <fresh.json> [--json]');
        process.exit(2);
    }
    const committed = JSON.parse(readFileSync(committedPath, 'utf8'));
    const fresh = JSON.parse(readFileSync(freshPath, 'utf8'));
    const result = compareArtifacts(committed, fresh);
    if (asJson) {
        console.log(JSON.stringify({ committedPath, freshPath, ...result }, null, 2));
    } else if (result.identical) {
        console.log(`FRESH    ${freshPath}: field-by-field identical to ${committedPath} (leg names excluded: ${result.excluded.join(', ')})`);
    } else {
        console.log(`STALE    ${freshPath}: ${result.differences.length} difference(s) against ${committedPath}`);
        for (const difference of result.differences) {
            if (difference.kind === 'changed') {
                console.log(`  ~ ${difference.path}: committed ${show(difference.committed)} -> fresh ${show(difference.fresh)}`);
            } else if (difference.kind === 'removed') {
                console.log(`  - ${difference.path}: committed-only value ${show(difference.committed)}`);
            } else {
                console.log(`  + ${difference.path}: fresh-only value ${show(difference.fresh)}`);
            }
        }
    }
    process.exitCode = result.identical ? 0 : 1;
};

// INVOKED-AS-A-SCRIPT DETECTION, done with pathToFileURL rather than string concatenation. The first
// version compared `import.meta.url` against `file://${process.argv[1]}`; on Windows argv[1] is
// `C:\...`, so the comparison was false, main() never ran, and the script exited 0 with no output --
// a "freshness report" that reported nothing and passed. Caught by running it against a deliberately
// changed copy and noticing the exit code was 0.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
    main();
}
