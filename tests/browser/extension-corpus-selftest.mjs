#!/usr/bin/env node
// CHEAP TEETH FOR THE CORPUS COMPARATOR: no browser, no server.
//
// Each case builds a synthetic pair of leg reports, runs compare-extension-corpus.mjs as a child, and
// REQUIRES both the exit status and the named guard. A mutation that does not fire its named red is a
// survival, and the self-test exits non-zero (AGENTS.md verification rule 4: teeth are demonstrated, not
// asserted). The clean pair must PASS and exit 0 -- a comparator that fails everything has no teeth either.
//
// Cases:
//   1. clean pair                                    -> PASS (exit 0)
//   2. Go leg omits an expected extension            -> FAIL (expected-set-present-on-gotavern)
//   3. Go-only page error                            -> FAIL (no-gotavern-only-browser-errors)
//   4. API status differs on both legs               -> FAIL (api-status-sets-agree)
//   5. Final-state mismatch                          -> FAIL (final-page-state-equal)
//   6. Soak RSS regression > 3x                      -> FAIL (soak-rss-not-regressed-3x)
//   7. Soak p95 regression > 3x                      -> FAIL (soak-p95-not-regressed-3x)
//   8. A leg with failure must not PASS              -> FAIL (gotavern-legs-drove)
//   9. Expected set names an extension both omit     -> FAIL (expected-set-present-on-gotavern/stock)
//  10. Soak metrics null on both legs                -> not PASS, and reported as unmeasured
//  11. Live-egress (/api/horde/) body shapes differ  -> PASS (body deliberately not asserted)
//  12. Cluster plan is deterministic and reports uncovered extensions by name
//
// Usage: node extension-corpus-selftest.mjs

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadLock } from './third-party-extensions.mjs';
import { clusterPlan, namesForLockSet } from './extension-corpus-clusters.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const comparator = path.join(here, 'compare-extension-corpus.mjs');
const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'corpus-selftest-'));
const failures = [];

function baseLeg({ subject, phase = 'before', mode = 'load', names = ['alpha-ext', 'beta-ext'], loaded = true, soak = null } = {}) {
    return {
        schemaVersion: 1,
        surface: 'third-party-extension-corpus',
        subject, phase, mode,
        baseURL: 'http://127.0.0.1:20000',
        plan: { names, nameCount: names.length, lockSet: 'explicit --names', mode },
        provenance: { subject, phase, mode, lockSha256: 'a'.repeat(64), legConfig: { sha256: 'b'.repeat(64) } },
        steps: [],
        extensions: names.map(name => ({ name, loaded, firstAsset: loaded ? `/scripts/extensions/third-party/${name}/manifest.json` : null, firstFailingUrl: loaded ? null : `/scripts/extensions/third-party/${name}/manifest.json`, firstFailingStatus: loaded ? null : 404 })),
        rows: [],
        pageErrors: [],
        consoleErrors: [],
        failedRequests: [],
        finalState: { settingsReady: true, extensionContainerCount: names.length, extensionSettingsPresent: true, characterListPresent: true, sendButtonPresent: true },
        chat: { opened: true, chatLength: 3, lastText: 'CORPUS_REPLY_1', lastIsUser: false },
        soak,
        failure: null,
    };
}

async function runPair(goBefore, pinBefore, extraArgs = [], { goAfter = null, pinAfter = null } = {}) {
    const caseDir = path.join(tmpRoot, `case-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(caseDir, { recursive: true });
    const write = async (name, value) => { const file = path.join(caseDir, name); await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`); return file; };
    const files = [await write('go-before.json', goBefore), await write('pinned-before.json', pinBefore)];
    const args = [comparator, ...files];
    if (goAfter && pinAfter) args.push('--after', await write('go-after.json', goAfter), await write('pinned-after.json', pinAfter));
    args.push(...extraArgs);
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: here });
    let parsed = null;
    try { parsed = JSON.parse(result.stdout); } catch { parsed = null; }
    return { result, parsed, caseDir };
}

function check(label, condition, detail) {
    if (condition) { console.log(`ok   ${label}`); return; }
    failures.push(`${label}: ${detail}`);
    console.error(`FAIL ${label} :: ${detail}`);
}

// 1. CLEAN PAIR -> PASS.
{
    const go = baseLeg({ subject: 'gotavern' });
    const pin = baseLeg({ subject: 'pinned' });
    const { result, parsed } = await runPair(go, pin);
    check('clean pair passes', result.status === 0 && parsed?.verdict === 'PASS', `exit=${result.status} verdict=${parsed?.verdict} failed=${JSON.stringify(parsed?.failedGuards)}`);
}

// 2. GO LEG OMITS AN EXPECTED EXTENSION -> FAIL.
{
    const go = baseLeg({ subject: 'gotavern', names: ['alpha-ext'] });
    const pin = baseLeg({ subject: 'pinned' });
    const { result, parsed } = await runPair(go, pin);
    check('missing extension on Go fails', result.status !== 0 && parsed?.verdict === 'FAIL', `exit=${result.status} verdict=${parsed?.verdict}`);
}

// 3. GO-ONLY PAGE ERROR -> FAIL.
{
    const go = baseLeg({ subject: 'gotavern' });
    go.pageErrors.push('Uncaught ReferenceError: alpha is not defined');
    const pin = baseLeg({ subject: 'pinned' });
    const { result, parsed } = await runPair(go, pin);
    check('gotavern-only page error fails', result.status !== 0 && parsed?.guards?.['no-gotavern-only-browser-errors'] === false, `guards=${JSON.stringify(parsed?.guards)}`);
}

// 4. API STATUS DIFFERENCE -> FAIL.
{
    const go = baseLeg({ subject: 'gotavern' });
    go.rows.push({ method: 'POST', path: '/api/extensions/settings', status: 200, contentType: 'application/json', bodyLength: 2, bodySha256: 'c', bodyShape: { type: 'object', keys: {} } });
    const pin = baseLeg({ subject: 'pinned' });
    pin.rows.push({ method: 'POST', path: '/api/extensions/settings', status: 500, contentType: 'application/json', bodyLength: 2, bodySha256: 'd', bodyShape: { type: 'object', keys: {} } });
    const { result, parsed } = await runPair(go, pin);
    check('API status difference fails', result.status !== 0 && parsed?.guards?.['api-status-sets-agree'] === false, `guards=${JSON.stringify(parsed?.guards)}`);
}

// 5. FINAL-STATE MISMATCH -> FAIL.
{
    const go = baseLeg({ subject: 'gotavern' });
    go.finalState.extensionContainerCount = 1;
    const pin = baseLeg({ subject: 'pinned' });
    const { result, parsed } = await runPair(go, pin);
    check('final-state mismatch fails', result.status !== 0 && parsed?.guards?.['final-page-state-equal'] === false, `guards=${JSON.stringify(parsed?.guards)}`);
}

function soakLeg(subject, { rssKb, p95, serverErrors = 0, apiFailures = 0, apiResponses = 100 } = {}) {
    const leg = baseLeg({ subject, mode: 'soak' });
    leg.soak = {
        requestedMinutes: 1, minutes: 1, iterations: 5, samples: [],
        rssKb: { first: rssKb, last: rssKb, max: rssKb, samples: [rssKb] },
        goroutines: { value: null, reason: 'no pprof endpoint' },
        apiResponses, apiFailures, serverErrors,
        failureRate: apiResponses > 0 ? apiFailures / apiResponses : null,
        latencyMs: { samples: apiResponses, p50: p95, p95, p99: p95, max: p95 },
        browserErrorCount: 0,
        unmeasured: [{ metric: 'goroutines', reason: 'no pprof endpoint' }],
        orphanCheck: { checked: true, candidates: [], subjectPid: 1234, subjectPidAlive: true },
    };
    return leg;
}

// 6. SOAK RSS REGRESSION -> FAIL.
{
    const go = soakLeg('gotavern', { rssKb: 9000, p95: 10 });
    const pin = soakLeg('pinned', { rssKb: 1000, p95: 10 });
    const { result, parsed } = await runPair(go, pin, ['--mode', 'soak']);
    check('soak RSS regression fails', result.status !== 0 && parsed?.guards?.['soak-rss-not-regressed-3x'] === false, `guards=${JSON.stringify(parsed?.guards)}`);
}

// 7. SOAK p95 REGRESSION -> FAIL.
{
    const go = soakLeg('gotavern', { rssKb: 1000, p95: 300 });
    const pin = soakLeg('pinned', { rssKb: 1000, p95: 10 });
    const { result, parsed } = await runPair(go, pin, ['--mode', 'soak']);
    check('soak p95 regression fails', result.status !== 0 && parsed?.guards?.['soak-p95-not-regressed-3x'] === false, `guards=${JSON.stringify(parsed?.guards)}`);
}

// 7b. THE PROBE'S OWN STOP, IN ITS NETWORK COSTUME -> NOISE, NOT A GO-ONLY ERROR.
// The soak cancels a streaming reply; an extension's follow-up fetch can be aborted mid-flight and the
// browser then reports TypeError: Failed to fetch. Both legs recorded the same abort as "Cancelled by stop
// event" in the phases where it landed in the frontend (runs 41780365931 and 41801638163), so the message
// is the drive's signal. It is noise only when the leg saw no failed API response.
{
    const go = soakLeg('gotavern', { rssKb: 1000, p95: 10 });
    go.consoleErrors.push('[Dooms Tracker] Error updating RPG data: TypeError: Failed to fetch\n    at capturePatched (http://127.0.0.1:20000/scripts/extensions/third-party/Dooms-Enhancement-Suite/src/utils/responseExtractor.js:12:34)');
    const pin = soakLeg('pinned', { rssKb: 1000, p95: 10 });
    pin.consoleErrors.push('[Dooms Tracker] Error updating RPG data: Error: Cancelled by stop event');
    const { result, parsed } = await runPair(go, pin, ['--mode', 'soak']);
    check('a probe-aborted extension fetch is soak noise, not a Go-only error', result.status === 0 && parsed?.verdict === 'PASS', `exit=${result.status} verdict=${parsed?.verdict} failed=${JSON.stringify(parsed?.failedGuards)}`);
}

// 7c. THE SAME MESSAGE WITH A RECORDED API FAILURE STILL FAILS.
{
    const go = soakLeg('gotavern', { rssKb: 1000, p95: 10, apiFailures: 3 });
    go.consoleErrors.push('[Dooms Tracker] Error updating RPG data: TypeError: Failed to fetch');
    const pin = soakLeg('pinned', { rssKb: 1000, p95: 10 });
    const { result, parsed } = await runPair(go, pin, ['--mode', 'soak']);
    check('the same message with a recorded API failure still fails', result.status !== 0 && parsed?.guards?.['no-gotavern-only-browser-errors'] === false, `guards=${JSON.stringify(parsed?.guards)}`);
}

// 8. A LEG WITH failure MUST NOT PASS.
{
    const go = baseLeg({ subject: 'gotavern' });
    go.failure = 'the page never reached settingsReady';
    const pin = baseLeg({ subject: 'pinned' });
    const { result, parsed } = await runPair(go, pin);
    check('a failed Go leg cannot pass', result.status !== 0 && parsed?.verdict === 'FAIL', `exit=${result.status} verdict=${parsed?.verdict}`);
}

// 9. EXPECTED SET NAMES AN EXTENSION BOTH LEGS OMIT -> FAIL.
{
    const go = baseLeg({ subject: 'gotavern' });
    const pin = baseLeg({ subject: 'pinned' });
    const { result, parsed } = await runPair(go, pin, ['--expected', 'alpha-ext,beta-ext,gamma-ext']);
    check('expected set missing on both legs fails', result.status !== 0 && parsed?.guards?.['expected-set-present-on-gotavern'] === false && parsed?.guards?.['expected-set-present-on-stock'] === false, `guards=${JSON.stringify(parsed?.guards)}`);
}

// 10. NULL SOAK METRICS ARE UNMEASURED, NOT A SILENT PASS.
{
    const go = baseLeg({ subject: 'gotavern', mode: 'soak' });
    go.soak = { requestedMinutes: 1, minutes: 1, iterations: 3, samples: [], rssKb: { first: null, last: null, max: null, samples: [] }, goroutines: { value: null, reason: 'no pprof endpoint' }, apiResponses: 10, apiFailures: 0, serverErrors: 0, failureRate: 0, latencyMs: { samples: 0, p50: null, p95: null, p99: null, max: null }, browserErrorCount: 0, unmeasured: [{ metric: 'rssKb', reason: 'Windows host: no /proc' }], orphanCheck: { checked: false, reason: 'Windows host', candidates: [] } };
    const pin = JSON.parse(JSON.stringify(go));
    pin.subject = 'pinned';
    const { result, parsed } = await runPair(go, pin, ['--mode', 'soak']);
    const text = JSON.stringify(parsed ?? {});
    check('null soak metrics are recorded as unmeasured and not a pass', result.status !== 0 && parsed?.verdict !== 'PASS' && parsed?.guards?.['soak-metrics-measured'] === false && text.includes('unmeasured'), `exit=${result.status} verdict=${parsed?.verdict}`);
}

// 11. LIVE-EGRESS BODY SHAPES ARE NOT ASSERTED.
{
    const go = baseLeg({ subject: 'gotavern' });
    go.rows.push({ method: 'POST', path: '/api/horde/text-models', status: 200, contentType: 'application/json', bodyLength: 10, bodySha256: 'e', bodyShape: { type: 'object', keys: { models: 'array' } } });
    const pin = baseLeg({ subject: 'pinned' });
    pin.rows.push({ method: 'POST', path: '/api/horde/text-models', status: 200, contentType: 'application/json', bodyLength: 10, bodySha256: 'f', bodyShape: { type: 'object', keys: { models: 'object' } } });
    const { result, parsed } = await runPair(go, pin);
    check('live-egress body shape difference does not fail', result.status === 0 && parsed?.verdict === 'PASS', `exit=${result.status} verdict=${parsed?.verdict} failed=${JSON.stringify(parsed?.failedGuards)}`);
}

// 12. CLUSTER PLAN IS DETERMINISTIC AND REPORTS UNCOVERED NAMES.
{
    const { lock } = loadLock();
    const first = clusterPlan(lock);
    const second = clusterPlan(lock);
    check('cluster plan is deterministic', JSON.stringify(first) === JSON.stringify(second), 'two computations differ');
    const selected = lock.selected.map(extension => extension.name);
    const paired = new Set(first.pairs.flatMap(pair => pair.names));
    const expectedUncovered = selected.filter(name => !paired.has(name));
    check('cluster plan reports uncovered names exactly', JSON.stringify(first.uncovered) === JSON.stringify(expectedUncovered), JSON.stringify({ planned: first.uncovered, expected: expectedUncovered }));
    check('cluster plan has one run per distinct pair', first.runs.length === new Set(first.pairs.map(pair => [...pair.names].sort().join(','))).size, JSON.stringify(first.runs.map(run => run.names)));
    check('cluster plan covers every named class or records it', first.pairs.length === 6, JSON.stringify(first.pairs.map(pair => pair.cluster)));
    check('lock-set all20 resolves to the whole lock', namesForLockSet(lock, 'all20').length === 20, 'all20 did not resolve to 20 names');
    check('lock-set cluster resolves to its pair', JSON.stringify(namesForLockSet(lock, 'cluster:prompt-mutation')) === JSON.stringify(first.pairs.find(pair => pair.cluster === 'prompt-mutation').names), 'cluster lookup differs from plan');
}

// 13. AN EMPTY CORPUS MUST FAIL, NOT PASS VACUOUSLY.
// Without --expected the comparator takes the expected set from the leg's own plan, so a drive that recorded
// NO extensions used to make every expected-set guard vacuous and could reach PASS with zero comparisons.
{
    const go = baseLeg({ subject: 'gotavern', names: [] });
    const pin = baseLeg({ subject: 'pinned', names: [] });
    const { result, parsed } = await runPair(go, pin);
    check('an empty corpus fails by name', result.status !== 0 && parsed?.verdict === 'FAIL'
        && parsed?.guards?.['expected-set-declared'] === false
        && parsed?.guards?.['corpus-recorded-extensions'] === false,
        `exit=${result.status} verdict=${parsed?.verdict} guards=${JSON.stringify({ expected: parsed?.guards?.['expected-set-declared'], recorded: parsed?.guards?.['corpus-recorded-extensions'] })}`);
}

await fs.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
if (failures.length > 0) {
    console.error(`\n[selftest] ${failures.length} missed mutation(s):\n- ${failures.join('\n- ')}`);
    process.exit(1);
}
console.log(`\n[selftest] all ${13} corpus-comparator teeth fired; clean pair PASSed`);
