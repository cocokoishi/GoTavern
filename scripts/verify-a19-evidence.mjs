// THE alpha.19 REAL-UI ORACLE EVIDENCE VERIFIER.
//
// WHY THIS EXISTS. The new release gate's artifact is only a claim about a name until its CONTENT says what it is and
// what it compared. `scripts/release-governance/artifact-evidence.mjs` can check the generic rails (kind, embedded head
// SHA, pinned commit, truthy members, digests) but it cannot say whether the five OBSERVABLE LAYERS actually matched,
// whether the corpus came from the UI rather than a generator, or whether a "normalisation" is a named, evidenced
// decision rather than a broad ignore. Those are this round's contract, so they are enforced here and the release
// manifest's `requiredEvidence` covers the generic rails.
//
// TEETH. `--self-test` builds one valid document and a mutation per guard; every mutation must produce its NAMED
// problem and every run must start from a green baseline. A verifier whose failure modes are not exercised is the
// class of green this repository has already been burned by (AGENTS.md rule 7 / differential doctrine 4).
//
// USAGE
//   node scripts/verify-a19-evidence.mjs --self-test
//   node scripts/verify-a19-evidence.mjs --evidence <release-evidence.json> --sha <candidate> [--pinned <commit>]
//
// EXIT: 0 only when every guard passes; 1 otherwise. A JSON verdict line is always printed.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import process from 'node:process';

const KIND = 'a19-real-ui-oracle-v1';
const SCHEMA_VERSION = 1;
const PINNED_BASELINE = '06bde939fb1e9c4c8d8641d810f0a916b5bce127';
const LAYERS = ['browser', 'http', 'providerWire', 'persistence', 'lifecycle'];
const NORMALISATION_FIELDS = ['reason', 'pinnedEvidence', 'field', 'test', 'negativeCase'];

function argumentValue(argv, name, fallback = null) {
    const index = argv.indexOf(name);
    if (index === -1) return fallback;
    return argv[index + 1] ?? fallback;
}

function isNonEmptyString(value) {
    return typeof value === 'string' && value.trim() !== '';
}

function isSha256(value) {
    return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isCommitSha(value) {
    return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

/**
 * Validate one release-evidence document against the alpha.19 real-UI oracle contract.
 * Returns { problems: string[] }. An empty array means the document is release-admissible for this gate.
 */
export function validateA19Evidence(evidence, { sha, pinned = PINNED_BASELINE } = {}) {
    const problems = [];
    const fail = message => problems.push(message);

    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
        return { problems: ['the evidence document is not a JSON object'] };
    }
    if (evidence.schemaVersion !== SCHEMA_VERSION) {
        fail(`schemaVersion is ${JSON.stringify(evidence.schemaVersion)}, expected ${SCHEMA_VERSION}`);
    }
    if (evidence.kind !== KIND) {
        fail(`kind is ${JSON.stringify(evidence.kind)}, expected ${JSON.stringify(KIND)}`);
    }
    if (!isCommitSha(sha)) {
        fail(`the caller supplied no candidate SHA (got ${JSON.stringify(sha)}); the embedded headSha cannot be judged`);
    } else if (evidence.headSha !== sha) {
        fail(`headSha is ${JSON.stringify(evidence.headSha)}, not the candidate ${sha}`);
    }
    if (evidence.pinnedCommit !== pinned) {
        fail(`pinnedCommit is ${JSON.stringify(evidence.pinnedCommit)}, expected the pinned oracle ${pinned}`);
    }
    if (evidence.ok !== true) {
        fail(`ok is ${JSON.stringify(evidence.ok)}, expected exactly true (a mismatch, unobserved layer or harness error must not ship as release evidence)`);
    }

    // THE CORPUS ORIGIN IS THE ROUND'S CENTRAL CLAIM: a corpus built by the deterministic generator or by writing
    // product files is not this round's deliverable, whatever its counts say.
    const corpus = evidence.corpus;
    if (!corpus || typeof corpus !== 'object' || Array.isArray(corpus)) {
        fail('corpus is missing; the gate cannot tell what the journey ran over');
    } else {
        if (corpus.origin !== 'ui') {
            fail(`corpus.origin is ${JSON.stringify(corpus.origin)}, expected "ui" (a generated corpus is not the alpha.19 oracle)`);
        }
        if (!isSha256(corpus.manifestSha256)) {
            fail(`corpus.manifestSha256 is ${JSON.stringify(corpus.manifestSha256)}, expected a lowercase 64-hex digest`);
        }
        if (!Number.isInteger(corpus.files) || corpus.files <= 0) {
            fail(`corpus.files is ${JSON.stringify(corpus.files)}, expected a positive integer`);
        }
        if (!Number.isInteger(corpus.bytes) || corpus.bytes <= 0) {
            fail(`corpus.bytes is ${JSON.stringify(corpus.bytes)}, expected a positive integer`);
        }
        // THE TREE IDENTITY IS SEPARATE FROM THE MANIFEST-FILE IDENTITY. `manifestSha256` pins the manifest bytes the
        // driver read; `detail.treeSha256` is the walked corpus tree digest, and `manifestVerification` is the driver's
        // own statement that it recomputed the walk and the manifest agreed. Without both, an artifact could name a
        // digest of a document whose inventory describes a different tree.
        const detail = corpus.detail;
        if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
            fail('corpus.detail is missing; the tree digest and the manifest-vs-walk verification are not recorded');
        } else {
            if (!isSha256(detail.treeSha256)) {
                fail(`corpus.detail.treeSha256 is ${JSON.stringify(detail.treeSha256)}, expected a lowercase 64-hex digest`);
            }
            if (detail.manifestVerification !== true) {
                fail(`corpus.detail.manifestVerification is ${JSON.stringify(detail.manifestVerification)}, expected exactly true (the driver must recompute the corpus walk and refuse a manifest that disagrees)`);
            }
        }
    }

    // THE FIVE LAYERS ARE THE OBSERVABLE CONTRACT. `not-observed` and `pinned-unreachable` are NOT passes
    // (AGENTS.md differential doctrine 5), so only ok===true with verdict "match" counts.
    const layers = evidence.layers;
    if (!layers || typeof layers !== 'object' || Array.isArray(layers)) {
        fail('layers is missing; the five observable layers are the contract');
    } else {
        for (const layer of LAYERS) {
            const entry = layers[layer];
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                fail(`layers.${layer} is missing`);
                continue;
            }
            if (entry.ok !== true) {
                fail(`layers.${layer}.ok is ${JSON.stringify(entry.ok)}, expected exactly true`);
            }
            if (entry.verdict !== 'match') {
                fail(`layers.${layer}.verdict is ${JSON.stringify(entry.verdict)}, expected "match" (only a match is a pass)`);
            }
        }
    }

    // A NORMALISATION REDUCES STRENGTH UNLESS IT IS A NAMED DECISION. Every entry must carry the five members the
    // charter requires (reason, pinned evidence, field, test, negative case); an empty list is the default.
    if (!Array.isArray(evidence.normalisations)) {
        fail('normalisations must be an array (the empty array is the default)');
    } else {
        evidence.normalisations.forEach((entry, index) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                fail(`normalisations[${index}] is not an object`);
                return;
            }
            for (const field of NORMALISATION_FIELDS) {
                if (!isNonEmptyString(entry[field])) {
                    fail(`normalisations[${index}].${field} is missing or empty; a normalisation without ${field} is a broad ignore, not a decision`);
                }
            }
        });
    }

    // WHAT WAS NOT COMPARED MUST BE EXPLICIT. It may be non-empty (some surfaces are legitimately unreachable), but every
    // row must name the surface and the reason, so an omission cannot hide as silence.
    if (!Array.isArray(evidence.notCompared)) {
        fail('notCompared must be an array (the empty array is the default), so an omission is visible');
    } else {
        evidence.notCompared.forEach((entry, index) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                fail(`notCompared[${index}] is not an object`);
                return;
            }
            if (!isNonEmptyString(entry.surface)) fail(`notCompared[${index}].surface is missing or empty`);
            if (!isNonEmptyString(entry.reason)) fail(`notCompared[${index}].reason is missing or empty`);
        });
    }

    // THE SELECTION IS THE RUN-NAME PROOF TOO. A narrowed dispatch that only compared one layer must not ship as the
    // full-oracle artifact.
    const selection = evidence.selection;
    if (!selection || typeof selection !== 'object' || Array.isArray(selection)) {
        fail('selection is missing; the gate cannot tell which oracle was run');
    } else {
        if (selection.mode !== 'all') {
            fail(`selection.mode is ${JSON.stringify(selection.mode)}, expected "all"`);
        }
        if (selection.dispatch !== 'workflow_dispatch') {
            fail(`selection.dispatch is ${JSON.stringify(selection.dispatch)}, expected "workflow_dispatch"`);
        }
    }

    for (const field of ['startedAt', 'finishedAt']) {
        const value = evidence[field];
        if (!isNonEmptyString(value) || Number.isNaN(Date.parse(value))) {
            fail(`${field} is ${JSON.stringify(value)}, expected an ISO-8601 timestamp`);
        }
    }
    if (isNonEmptyString(evidence.startedAt) && isNonEmptyString(evidence.finishedAt)) {
        const started = Date.parse(evidence.startedAt);
        const finished = Date.parse(evidence.finishedAt);
        if (!Number.isNaN(started) && !Number.isNaN(finished) && finished < started) {
            fail('finishedAt is before startedAt; the document cannot describe a journey it ran');
        }
    }

    return { problems };
}

function validEvidence(sha) {
    return {
        schemaVersion: 1,
        kind: KIND,
        headSha: sha,
        pinnedCommit: PINNED_BASELINE,
        ok: true,
        corpus: { origin: 'ui', manifestSha256: 'a'.repeat(64), files: 200, bytes: 1234567, detail: { treeSha256: 'e'.repeat(64), manifestVerification: true } },
        selection: { mode: 'all', dispatch: 'workflow_dispatch', corpusTier: 'full' },
        layers: Object.fromEntries(LAYERS.map(layer => [layer, { ok: true, verdict: 'match', guards: [] }])),
        normalisations: [],
        notCompared: [],
        startedAt: '2026-11-08T00:00:00.000Z',
        finishedAt: '2026-11-08T00:30:00.000Z',
    };
}

function selfTest() {
    const sha = 'b'.repeat(40);
    const baseline = validateA19Evidence(validEvidence(sha), { sha });
    const results = [{ name: 'valid-document-passes', ok: baseline.problems.length === 0, problems: baseline.problems }];
    if (baseline.problems.length !== 0) {
        return results;
    }
    const mutations = [
        ['wrong-head-sha', doc => { doc.headSha = 'c'.repeat(40); }, /headSha is .*not the candidate/],
        ['wrong-pinned-commit', doc => { doc.pinnedCommit = 'd'.repeat(40); }, /pinnedCommit is .*expected the pinned oracle/],
        ['generator-origin', doc => { doc.corpus.origin = 'generator'; }, /corpus\.origin .*expected "ui"/],
        ['missing-layer', doc => { delete doc.layers.providerWire; }, /layers\.providerWire is missing/],
        ['layer-mismatch', doc => { doc.layers.http = { ok: false, verdict: 'mismatch' }; }, /layers\.http\.(ok|verdict)/],
        ['unobserved-layer', doc => { doc.layers.lifecycle = { ok: true, verdict: 'not-observed' }; }, /layers\.lifecycle\.verdict .*expected "match"/],
        ['overall-not-ok', doc => { doc.ok = false; }, /ok is false, expected exactly true/],
        ['normalisation-without-evidence', doc => { doc.normalisations = [{ reason: 'timestamps vary' }]; }, /normalisations\[0\]\.pinnedEvidence/],
        ['corpus-digest-malformed', doc => { doc.corpus.manifestSha256 = 'not-a-digest'; }, /corpus\.manifestSha256/],
        ['tree-digest-malformed', doc => { doc.corpus.detail.treeSha256 = 'not-a-digest'; }, /corpus\.detail\.treeSha256/],
        ['manifest-not-verified', doc => { doc.corpus.detail.manifestVerification = false; }, /corpus\.detail\.manifestVerification/],
        ['narrowed-selection', doc => { doc.selection.mode = 'browser-only'; }, /selection\.mode/],
        ['push-run-selection', doc => { doc.selection.dispatch = 'push'; }, /selection\.dispatch/],
        // A LOCAL RUN MUST NEVER BE ACCEPTED AS RELEASE EVIDENCE: the producer writes 'local' when it was not
        // dispatched by the release workflow, and the verifier must refuse that exact value (the Lead's gate).
        ['local-run-selection', doc => { doc.selection.dispatch = 'local'; }, /selection\.dispatch/],
        ['unexplained-not-compared', doc => { doc.notCompared = [{ surface: 'extension iframe' }]; }, /notCompared\[0\]\.reason/],
        ['finished-before-started', doc => { doc.finishedAt = '2026-11-07T23:00:00.000Z'; }, /finishedAt is before startedAt/],
    ];
    for (const [name, mutate, expected] of mutations) {
        const doc = validEvidence(sha);
        mutate(doc);
        const { problems } = validateA19Evidence(doc, { sha });
        const caught = problems.some(problem => expected.test(problem));
        results.push({ name: `mutation:${name}`, ok: caught, problems });
    }
    return results;
}

function main() {
    const argv = process.argv.slice(2);
    if (argv.includes('--self-test')) {
        const results = selfTest();
        const failures = results.filter(result => !result.ok);
        const verdict = { schema: 'a19-evidence-verifier-selftest-v1', ok: failures.length === 0, cases: results.length, failed: failures.map(result => result.name) };
        console.log(JSON.stringify(verdict));
        if (failures.length > 0) {
            for (const failure of failures) console.error(`${failure.name}: ${JSON.stringify(failure.problems)}`);
            process.exit(1);
        }
        return;
    }
    const evidencePath = argumentValue(argv, '--evidence');
    const sha = argumentValue(argv, '--sha');
    const pinned = argumentValue(argv, '--pinned', PINNED_BASELINE);
    if (!evidencePath || !sha) {
        console.error('usage: node scripts/verify-a19-evidence.mjs --evidence <release-evidence.json> --sha <candidate> [--pinned <commit>]');
        console.error('       node scripts/verify-a19-evidence.mjs --self-test');
        process.exit(2);
    }
    let evidence;
    try {
        evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
    } catch (error) {
        console.log(JSON.stringify({ schema: 'a19-evidence-verdict-v1', ok: false, evidence: evidencePath, sha, problems: [`cannot read the evidence document: ${error.message}`] }));
        process.exit(1);
    }
    const { problems } = validateA19Evidence(evidence, { sha, pinned });
    const ok = problems.length === 0;
    console.log(JSON.stringify({ schema: 'a19-evidence-verdict-v1', ok, evidence: evidencePath, sha, pinned, problems }));
    process.exit(ok ? 0 : 1);
}

// Run only when invoked as a program: the validator is exported so a test or another workflow step can import it
// without the import executing a CLI that would inspect its own argv.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
