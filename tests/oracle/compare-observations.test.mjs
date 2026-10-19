import test from 'node:test';
import assert from 'node:assert/strict';
import { compareObservations } from '../../tools/compare-observations.mjs';

test('compares observed HTTP and filesystem surfaces and skips mutually unobserved surfaces', () => {
    const result = compareObservations(
        {
            http: { observed: true, responses: [{ status: 200, body: { version: '1.19.0', agent: 'ST' } }] },
            provider: { observed: false },
            providerResponse: { observed: false },
            browserEvents: { observed: false },
            filesystem: { observed: true, paths: ['a', 'b'] },
        },
        {
            filesystem: { paths: ['a', 'b'], observed: true },
            browserEvents: { observed: false },
            providerResponse: { observed: false },
            provider: { observed: false },
            http: { responses: [{ body: { agent: 'ST', version: '1.19.0' }, status: 200 }], observed: true },
        },
    );

    assert.equal(result.matches, true);
    assert.deepEqual(result.compared, ['http', 'filesystem']);
    assert.deepEqual(result.skipped, ['provider', 'providerResponse', 'browserEvents']);
});

test('reports HTTP status, field-presence, and array-order differences', () => {
    const result = compareObservations(
        {
            http: { responses: [{ status: 200, body: { value: 1 } }] },
            provider: { observed: false },
            providerResponse: { observed: false },
            browserEvents: { observed: false },
            filesystem: { entries: ['a', 'b'] },
        },
        {
            http: { responses: [{ status: 204, body: { value: 1, extra: true } }] },
            provider: { observed: false },
            providerResponse: { observed: false },
            browserEvents: { observed: false },
            filesystem: { entries: ['b', 'a'] },
        },
    );

    assert.equal(result.matches, false);
    assert.ok(result.differences.some(item => item.path === '$.http.responses[0].status'));
    assert.ok(result.differences.some(item => item.path === '$.http.responses[0].body.extra'));
    assert.ok(result.differences.some(item => item.path === '$.filesystem.entries[0]'));
});

test('does not treat different observer availability as a passing comparison', () => {
    const result = compareObservations(
        {
            http: { observed: true },
            provider: { observed: false },
            providerResponse: { observed: false },
            browserEvents: { observed: false },
            filesystem: { observed: true },
        },
        {
            http: { observed: true },
            provider: { observed: true, requests: [] },
            providerResponse: { observed: false },
            browserEvents: { observed: false },
            filesystem: { observed: true },
        },
    );

    assert.equal(result.matches, false);
    assert.ok(result.differences.some(item => item.path === '$.provider.observed'));
});
