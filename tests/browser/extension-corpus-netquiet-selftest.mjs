// extension-corpus-netquiet-selftest.mjs -- TEETH for the network-quiet / external-egress split.
//
// No browser, no server. Each case builds a synthetic request list and asserts the CLASSIFIER's verdict, so
// the split is proven to be discriminating in both directions:
//   * a stalled SAME-ORIGIN request must still fail the drive (the guard was not weakened), and the failure
//     names the unresolved path;
//   * a stalled DECLARED external origin must be recorded, not fail (the false red this fix removes);
//   * an UNEXPECTED external origin must fail, named (the declared set is not an ignore list);
//   * the OLD "any request pending" predicate is computed beside the new one on the same data, so the
//     before/after difference this commit claims is shown by the test rather than argued in a comment.
//
// Usage: node extension-corpus-netquiet-selftest.mjs
// Exit 0 only when every case holds; prints one JSON verdict line.

import { settleWithEgressClassification, APPROVED_EXTERNAL_ORIGINS } from './extension-corpus-netquiet.mjs';

const SUBJECT = 'http://127.0.0.1:41000';
const APPROVED = APPROVED_EXTERNAL_ORIGINS[0]?.origin ?? 'https://api.github.com';

const entry = ({ origin = SUBJECT, path = '/api/whatever', status = 200, latencyMs = 10, sameOrigin } = {}) => ({
    origin,
    sameOrigin: sameOrigin ?? origin === SUBJECT,
    path,
    status,
    latencyMs,
});

// The predicate the old guard used: EVERY recorded request must be settled. It is kept here only to show
// that the data which makes the new guard green made the old one red.
const oldAnyPending = entries => entries.some(entry => entry.status === null);

const cases = [];
const check = (name, condition, detail) => cases.push({ name, ok: condition === true, detail });

const quietOptions = { subjectOrigin: SUBJECT, quietMs: 60, deadlineMs: 400 };

// 1. A quiet page: same-origin resolved, approved external resolved.
{
    const entries = [entry({ path: '/api/settings/get' }), entry({ origin: APPROVED, path: '/repos/x/y' })];
    const result = await settleWithEgressClassification(entries, quietOptions);
    check('quiet-page-is-green', result.ok === true, { failed: result.failed, origins: Object.keys(result.external.origins) });
    check('quiet-page-scopes-to-same-origin', result.quiet.scope === 'same-origin', result.quiet);
}

// 2. A stalled SAME-ORIGIN request is still a drive failure, and it is named.
{
    const entries = [entry({ path: '/api/slow-hang', status: null }), entry({ origin: APPROVED, path: '/repos/x/y' })];
    const result = await settleWithEgressClassification(entries, quietOptions);
    check('stalled-same-origin-is-red', result.ok === false && result.failed.includes('network-quiet'), { failed: result.failed });
    check('stalled-same-origin-names-the-path', JSON.stringify(result.quiet.unresolved ?? []).includes('/api/slow-hang'), result.quiet.unresolved);
}

// 3. A stalled DECLARED external origin is RECORDED and does NOT fail (the measured false red).
{
    const entries = [entry({ path: '/api/settings/get' }), entry({ origin: APPROVED, path: '/repos/DangerDaza/Dooms-Enhancement-Suite', status: null })];
    const result = await settleWithEgressClassification(entries, quietOptions);
    check('stalled-approved-external-is-green', result.ok === true, { failed: result.failed, external: result.external });
    check('stalled-approved-external-is-recorded', result.external.pending === 1 && result.external.origins[APPROVED]?.pending === 1, result.external.origins[APPROVED]);
    check('old-any-pending-predicate-would-have-been-red', oldAnyPending(entries) === true, null);
}

// 4. An UNEXPECTED external origin fails by name (the declared set is not an ignore).
{
    const entries = [entry({ path: '/api/settings/get' }), entry({ origin: 'https://unexpected.example', path: '/update', status: null })];
    const result = await settleWithEgressClassification(entries, quietOptions);
    check('unexpected-external-origin-is-red', result.ok === false && result.failed.includes('unexpected-external-origin'), { failed: result.failed });
    check('unexpected-external-origin-is-named', result.external.unexpected.includes('https://unexpected.example'), result.external.unexpected);
}

// 5. Both failures at once are both named.
{
    const entries = [entry({ path: '/api/slow-hang', status: null }), entry({ origin: 'https://unexpected.example', path: '/update' })];
    const result = await settleWithEgressClassification(entries, quietOptions);
    check('both-failures-are-both-named', result.failed.includes('network-quiet') && result.failed.includes('unexpected-external-origin'), { failed: result.failed });
}

// 6. The declaration itself carries the evidence the five-member normalisation rule requires for a decision.
for (const origin of APPROVED_EXTERNAL_ORIGINS) {
    const complete = ['origin', 'reason', 'evidence', 'extension', 'pinnedCommit'].every(field => typeof origin[field] === 'string' && origin[field].trim() !== '');
    check(`declared-origin-${origin.origin}-has-evidence`, complete, origin);
}

const failed = cases.filter(testCase => testCase.ok !== true);
const verdict = { schema: 'extension-corpus-netquiet-selftest-v1', ok: failed.length === 0, cases: cases.length, failed: failed.map(testCase => testCase.name), detail: cases };
console.log(JSON.stringify(verdict));
if (failed.length > 0) {
    for (const testCase of failed) console.error(`${testCase.name}: ${JSON.stringify(testCase.detail)}`);
    process.exit(1);
}
