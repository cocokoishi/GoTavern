// Verify ANY long-lived tree against a SHARED corpus-schema manifest (gotavern-corpus-schema v1).
//
// The schema can come from EITHER generator:
//   go run ./cmd/build-longlived <dir> -schema <schema.json>          (the Go complex instance)
//   node tools/build-longlived-corpus.mjs --size small --out <dir> --schema-out <schema.json>
//                                                                    (the browser/Node corpus)
// A consumer that drives the tree (a browser leg, a Node probe, a Go boot) runs this first, so "the tree I
// am about to drive is the tree the manifest describes" is a checked claim rather than an assumption.
//
// Every check has a stable NAME; the Go gate (`tests/e2e/longlived_schema_test.go`) asserts those names on
// deliberately mutated trees, so a red is attributable to one assertion instead of to "verify failed".
//
// Usage:
//   node tools/longlived/verify-corpus-schema.mjs --corpus <dir> --schema <file> [--report <file>] [--quiet]
//
// Exit 0 only when every check passes. Prints one JSON line (the report) on stdout and FAIL lines on stderr.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema, verifyCorpusAgainstSchema } from './corpus-schema.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '..', '..');

function argument(name, fallback = null) {
    const index = process.argv.indexOf(name);
    if (index < 0) return fallback;
    const value = process.argv[index + 1];
    return value === undefined ? fallback : value;
}

function usage(message) {
    if (message) console.error(`verify-corpus-schema: ${message}`);
    console.error('usage: node tools/longlived/verify-corpus-schema.mjs --corpus <dir> --schema <file> [--report <file>] [--quiet]');
    process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    const corpus = argument('--corpus');
    const schemaPath = argument('--schema');
    if (!corpus) usage('--corpus is required');
    if (!schemaPath) usage('--schema is required');
    const reportPath = argument('--report', null);
    const quiet = process.argv.includes('--quiet');
    let report;
    let schema = null;
    try {
        schema = await loadSchema(path.resolve(schemaPath));
    } catch (error) {
        // A schema that does not LOAD is still a verifier verdict, not a harness crash: the load error carries
        // the NAMED refusal (`scenario-version:2`, `scenario-byte-census-bytes:1`, …), and reporting it under
        // `schema-valid` keeps the gate attributable instead of degrading it to `verify-harness-error`.
        const message = String(error?.message ?? error);
        report = {
            // `schema: null` keeps the payload shape stable: the verifier normally reports the loaded schema
            // summary here (it overrides the payload's tool identity in the spread below), and a malformed
            // schema must not turn the report into a differently-shaped document.
            schema: null,
            corpus: null,
            ok: false,
            checks: [{ name: 'schema-valid', ok: false, detail: [message] }],
            failed: ['schema-valid'],
            error: message,
        };
    }
    if (!report) {
        try {
            report = await verifyCorpusAgainstSchema({ corpus: path.resolve(corpus), schema });
        } catch (error) {
            report = { ok: false, checks: [], failed: ['verify-harness-error'], error: String(error?.message ?? error) };
        }
    }
    const payload = {
        schema: 'gotavern-corpus-schema-verification',
        schemaVersion: 1,
        verifier: 'tools/longlived/verify-corpus-schema.mjs',
        repoRoot: REPO_ROOT,
        schemaPath: path.resolve(schemaPath),
        corpus: path.resolve(corpus),
        ...report,
    };
    if (reportPath) await fs.writeFile(path.resolve(reportPath), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    for (const check of payload.checks) {
        if (!check.ok) console.error(`FAIL ${check.name}: ${JSON.stringify(check.detail)}`);
    }
    console.log(JSON.stringify(payload));
    if (!payload.ok) process.exit(1);
}
