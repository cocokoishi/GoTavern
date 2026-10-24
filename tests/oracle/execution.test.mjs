// THE ORACLE'S EXECUTION CORE, PROVED AGAINST INJECTED FAKES. No probe is spawned, no browser is started,
// no network is touched, and nothing here depends on which fixtures are recorded: every "probe execution"
// below is a fake that records what the harness asked it to do.
//
// WHY THIS FILE EXISTS. Every fixture in tests/oracle is recorded by tools/build-generated-lib.mjs, which
// runs each declared probe twice "for stability". Measured before these tests existed:
//
//   * the function that was supposed to DECIDE that (`doubleRunFor`) was defined and called from NOWHERE,
//     so 118 declarations produced 118 x 2 = 236 executions in EVERY mode and GOTAVERN_ORACLE_DOUBLE_RUN
//     had no effect at all, while the comment above it claimed "the decision is printed per run";
//   * the two runners disagreed about a first-run failure: the pooled one kept run 1's error and discarded
//     run 2's (`failure = failure ?? error`), the serial one skipped run 2 entirely (`if (doubleRun && !failure)`);
//   * timings were collected only by the serial runner, reported before the late serial runs, summed rather
//     than averaged, and labelled with a hardcoded "x2 runs".
//
// None of that is observable in a fixture, which is why it survived: a fixture proves what a probe
// OBSERVED, never how many times the harness ran it or what the harness did with a failure. These tests are
// the oracle for the harness itself, and they are the only place the execution CONTRACT is written down:
//
//   1. the double-run policy is resolved from the recorded scope, and an unset/unknown setting is answered
//      by AUTO rather than by silently running everything twice;
//   2. ONE execution primitive drives both scheduling shapes (serial and pooled) with identical accounting;
//   3. a run-1 failure never skips run 2, and no error is ever swallowed;
//   4. double mode compares the two runs and names the changed JSON paths;
//   5. an empty selection and an unknown probe name are hard failures, not silent no-ops;
//   6. timing bills the executions that actually happened;
//   7. the policy is WIRED: the decision is taken once, printed once, and handed to the primitive at every
//      scheduling site. This last one is a source-shape assertion on purpose -- the original defect was an
//      orphan (a pure, correct function nobody called), and no behavioural test can see an orphan.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const EXECUTION_CORE = new URL('../../tools/oracle/execution.mjs', import.meta.url);
const RUNNER = new URL('../../tools/build-generated-lib.mjs', import.meta.url);

// Loaded lazily so that a MISSING core is reported against each invariant it blocks, with the reason,
// instead of crashing the whole file at import time and hiding which contract is unmet.
let coreModule;
async function core() {
    if (coreModule) return coreModule;
    try {
        coreModule = await import(EXECUTION_CORE.href);
    } catch (error) {
        assert.fail(
            `tools/oracle/execution.mjs is not importable (${error.code ?? error.message}). The runner has no `
            + 'execution core, so the double-run policy cannot be on the execution path and none of the '
            + 'contracts this file states can be satisfied.',
        );
    }
    return coreModule;
}

// One fake probe process. Each call to `run` IS one execution and records exactly what the primitive passed
// it: the argv (the primitive owns `[scriptPath, root, repositoryRoot, ...args]`), the cwd, and the attempt
// number. `fixtures[attempt - 1]` is the byte string that attempt "writes" to the fixture, so a double run
// can be given two identical fixtures (stable) or two different ones (unstable) without any real probe.
function fakeProbe({ fixtures = [Buffer.from('{"scenarios":{}}')], failAttempts = [] } = {}) {
    const executions = [];
    const state = { current: null };
    return {
        executions,
        async run(invocation) {
            executions.push(invocation);
            if (failAttempts.includes(invocation.attempt)) {
                const error = new Error(`probe exited 1 on attempt ${invocation.attempt}`);
                error.output = `stderr of attempt ${invocation.attempt}`;
                throw error;
            }
            state.current = Buffer.from(fixtures[Math.min(invocation.attempt - 1, fixtures.length - 1)]);
            return { output: `observed attempt ${invocation.attempt}` };
        },
        readFixture() {
            if (state.current === null) throw new Error('no fixture was written by the fake probe');
            return state.current;
        },
    };
}

const PROBE = {
    label: 'probe-fake.mjs',
    scriptPath: '/build/.gotavern-probe-fake.mjs',
    root: '/build',
    repositoryRoot: '/repo',
    args: ['--flag', 'value'],
};

// Runs one fake through the primitive and collects the aggregated failures, exactly as the runner does.
async function runFake(probe, options = {}) {
    const { executeProbe } = await core();
    const failures = [];
    const result = await executeProbe({
        ...PROBE,
        doubleRun: true,
        run: probe.run,
        readFixture: probe.readFixture,
        recordFailure: failure => failures.push(failure),
        ...options,
    });
    return { result, failures };
}

// ---------------------------------------------------------------------------------------------
// 1. POLICY RESOLUTION
// ---------------------------------------------------------------------------------------------

test('policy: a narrowed selection with the default setting executes each probe once', async () => {
    const { doubleRunFor } = await core();
    const policy = doubleRunFor(false, {});
    assert.equal(policy.double, false);
    assert.equal(policy.executions, 1);
    assert.equal(policy.unknown, false);
});

test('policy: a full selection with the default setting is the stability pass (two executions)', async () => {
    const { doubleRunFor } = await core();
    const policy = doubleRunFor(true, {});
    assert.equal(policy.double, true);
    assert.equal(policy.executions, 2);
});

test('policy: GOTAVERN_ORACLE_DOUBLE_RUN=all forces two executions even for a narrowed selection', async () => {
    const { doubleRunFor } = await core();
    const policy = doubleRunFor(false, { GOTAVERN_ORACLE_DOUBLE_RUN: 'all' });
    assert.equal(policy.double, true);
    assert.equal(policy.executions, 2);
    assert.match(policy.why, /GOTAVERN_ORACLE_DOUBLE_RUN=all/);
});

test('policy: GOTAVERN_ORACLE_DOUBLE_RUN=none forces one execution even for a full selection', async () => {
    const { doubleRunFor } = await core();
    const policy = doubleRunFor(true, { GOTAVERN_ORACLE_DOUBLE_RUN: 'none' });
    assert.equal(policy.double, false);
    assert.equal(policy.executions, 1);
});

test('policy: the setting is normalised (case and surrounding space do not change the mode)', async () => {
    const { doubleRunFor } = await core();
    assert.equal(doubleRunFor(false, { GOTAVERN_ORACLE_DOUBLE_RUN: '  ALL ' }).double, true);
    assert.equal(doubleRunFor(true, { GOTAVERN_ORACLE_DOUBLE_RUN: 'None' }).double, false);
});

test('policy: an unrecognised setting fails closed to auto and says so', async () => {
    const { doubleRunFor } = await core();
    const full = doubleRunFor(true, { GOTAVERN_ORACLE_DOUBLE_RUN: 'sometimes' });
    assert.equal(full.unknown, true, 'an unrecognised value must be reported as unrecognised, not silently accepted');
    assert.equal(full.double, true, 'auto applies to a full selection, so an unrecognised value must not turn the stability pass off');
    assert.equal(full.executions, 2);
    assert.match(full.why, /sometimes/, 'the decision must name the unrecognised value it ignored');
    assert.match(full.why, /auto/, 'the decision must say what it fell back to');

    const narrowed = doubleRunFor(false, { GOTAVERN_ORACLE_DOUBLE_RUN: 'sometimes' });
    assert.equal(narrowed.unknown, true);
    assert.equal(narrowed.double, false, 'auto applies to a narrowed selection');
    assert.equal(narrowed.executions, 1);
});

test('policy: a decision cannot be taken without stating the recording scope', async () => {
    const { resolveDoubleRunPolicy } = await core();
    assert.throws(() => resolveDoubleRunPolicy({ setting: 'auto' }), /selectionIsFull/);
    assert.throws(() => resolveDoubleRunPolicy({ setting: 'all', selectionIsFull: 'yes' }), /selectionIsFull/);
});

test('policy: the decision is announced as one line naming the executions and the reason', async () => {
    const { doubleRunFor, formatDoubleRunDecision } = await core();
    const line = formatDoubleRunDecision(doubleRunFor(false, { GOTAVERN_ORACLE_DOUBLE_RUN: 'all' }));
    assert.match(line, /^double run: /, 'the announcement must be greppable as `double run: ...`');
    assert.match(line, /2 execution/);
    assert.match(line, /GOTAVERN_ORACLE_DOUBLE_RUN=all/);
    assert.equal(line.split('\n').length, 1, 'the decision must be one line, printed once');

    const single = formatDoubleRunDecision(doubleRunFor(false, {}));
    assert.match(single, /^double run: /);
    assert.match(single, /1 execution/);
});

// ---------------------------------------------------------------------------------------------
// 2. ONE PRIMITIVE, TWO SCHEDULING SHAPES
// ---------------------------------------------------------------------------------------------

test('execution: one primitive serves the serial and pooled shapes with identical accounting', async () => {
    const { runProbeInherited, runProbeBuffered } = await core();
    assert.equal(typeof runProbeInherited, 'function', 'the serial shape needs its own single-execution runner');
    assert.equal(typeof runProbeBuffered, 'function', 'the pooled shape needs its own single-execution runner');

    const serialProbe = fakeProbe();
    const pooledProbe = fakeProbe();
    const serial = await runFake(serialProbe, { run: serialProbe.run, shape: 'serial' });
    const pooled = await runFake(pooledProbe, { run: pooledProbe.run, shape: 'pooled' });

    assert.equal(serial.result.executions, 2);
    assert.equal(pooled.result.executions, 2);
    assert.deepEqual(serial.result.errors, []);
    assert.deepEqual(pooled.result.errors, []);
    assert.equal(serial.result.compared, true);
    assert.equal(pooled.result.compared, true);
    assert.ok(serial.result.firstMs !== null && serial.result.secondMs !== null, 'both attempts must be timed');
    assert.ok(pooled.result.firstMs !== null && pooled.result.secondMs !== null, 'both attempts must be timed');
    assert.ok(serial.result.fixture.equals(pooled.result.fixture), 'both shapes must return the recorded bytes');
});

test('execution: the primitive owns the probe argv, and both shapes pass it identically', async () => {
    const serialProbe = fakeProbe();
    const pooledProbe = fakeProbe();
    await runFake(serialProbe, { run: serialProbe.run });
    await runFake(pooledProbe, { run: pooledProbe.run });

    const expected = [PROBE.scriptPath, PROBE.root, PROBE.repositoryRoot, ...PROBE.args];
    assert.deepEqual(serialProbe.executions[0].argv, expected);
    assert.deepEqual(pooledProbe.executions[0].argv, expected);
    assert.deepEqual(serialProbe.executions.map(entry => entry.argv), pooledProbe.executions.map(entry => entry.argv));
    assert.equal(serialProbe.executions[0].cwd, PROBE.root);
    assert.equal(pooledProbe.executions[0].cwd, PROBE.root);
    assert.deepEqual(serialProbe.executions.map(entry => entry.attempt), [1, 2]);
});

test('execution: a single run executes once and does not touch the second slot', async () => {
    const probe = fakeProbe();
    const { result } = await runFake(probe, { doubleRun: false });
    assert.equal(result.executions, 1);
    assert.equal(probe.executions.length, 1);
    assert.equal(result.secondMs, null);
    assert.equal(result.compared, false);
});

test('execution: an execution with no policy decision is refused rather than silently doubled', async () => {
    const { executeProbe } = await core();
    const probe = fakeProbe();
    await assert.rejects(
        () => executeProbe({ ...PROBE, run: probe.run, readFixture: probe.readFixture }),
        /doubleRun/,
    );
    assert.equal(probe.executions.length, 0, 'the refusal must happen before any probe process is started');
});

// ---------------------------------------------------------------------------------------------
// 3. FAILURES: run 2 is never skipped, and no error is swallowed
// ---------------------------------------------------------------------------------------------

test('execution: a run-1 failure still executes run 2 and surfaces BOTH errors', async () => {
    const probe = fakeProbe({ failAttempts: [1, 2] });
    const { result, failures } = await runFake(probe);
    assert.equal(result.executions, 2, 'run 2 must execute in double mode even when run 1 failed');
    assert.equal(probe.executions.length, 2, 'the stability run must never be skipped');
    assert.equal(result.errors.length, 2, 'both attempts failed, so both must be reported (no `??` swallowing)');
    assert.match(result.errors[0].error.message, /attempt 1/);
    assert.match(result.errors[1].error.message, /attempt 2/);
    assert.equal(result.fixture, null);
    assert.equal(result.compared, false, 'nothing can be compared when an attempt produced no fixture');

    assert.equal(failures.length, 2);
    assert.equal(failures[0].label, PROBE.label);
    assert.equal(failures[1].label, `${PROBE.label} (run 2)`, 'the second error must be attributed to run 2');
});

test('execution: a run-1 failure is reported even when run 2 succeeds', async () => {
    const probe = fakeProbe({ failAttempts: [1] });
    const { result, failures } = await runFake(probe);
    assert.equal(result.executions, 2);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error.message, /attempt 1/);
    assert.equal(result.fixture, null, 'an unstable probe must not hand back bytes that look recorded');
    assert.equal(failures.length, 1);
});

test('execution: a run-2 failure alone is reported, and run 1 still happened', async () => {
    const probe = fakeProbe({ failAttempts: [2] });
    const { result, failures } = await runFake(probe);
    assert.equal(result.executions, 2);
    assert.equal(result.errors.length, 1);
    assert.match(result.errors[0].error.message, /attempt 2/);
    assert.equal(result.firstMs !== null, true, 'run 1 was executed and timed');
    assert.match(failures[0].message, /attempt 2/);
});

// ---------------------------------------------------------------------------------------------
// 4. DOUBLE MODE COMPARISON
// ---------------------------------------------------------------------------------------------

test('execution: double mode with two different fixtures fails naming the changed JSON paths', async () => {
    const probe = fakeProbe({
        fixtures: [
            Buffer.from('{"scenarios":{"a":1,"b":[1,2]},"meta":{"ok":true}}'),
            Buffer.from('{"scenarios":{"a":2,"b":[1,3]},"meta":{"ok":true}}'),
        ],
    });
    const { result, failures } = await runFake(probe);
    assert.equal(result.compared, true);
    assert.equal(result.errors.length, 1, 'an unstable probe is exactly one comparison failure');
    const message = result.errors[0].error.message;
    assert.match(message, /oracle changed across identical pinned Node runs/);
    assert.match(message, /\$\.scenarios\.a/, `the failure must name the changed path; got: ${message}`);
    assert.match(message, /\$\.scenarios\.b\[1\]/, `the failure must name the changed array element; got: ${message}`);
    assert.equal(failures.length, 1);
});

test('execution: two identical fixtures pass the comparison and are not a failure', async () => {
    const stable = Buffer.from('{"same":true}');
    const probe = fakeProbe({ fixtures: [stable, stable] });
    const { result, failures } = await runFake(probe);
    assert.equal(result.compared, true);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(failures, []);
    assert.ok(result.fixture.equals(stable));
});

test('execution: a single run is never compared against anything', async () => {
    const probe = fakeProbe({
        fixtures: [Buffer.from('{"run":1}'), Buffer.from('{"run":2}')],
    });
    const { result } = await runFake(probe, { doubleRun: false });
    assert.equal(result.compared, false, 'there is no second run to compare with');
    assert.deepEqual(result.errors, []);
});

// ---------------------------------------------------------------------------------------------
// 5. SELECTION: no silent no-op
// ---------------------------------------------------------------------------------------------

test('selection: an empty selection is a hard failure, not a silent no-op', async () => {
    const { selectProbes } = await core();
    const discovered = [
        { script: 'probe-a.mjs', fixture: 'a.json' },
        { script: 'probe-b.mjs', fixture: 'b.json' },
    ];
    const unfiltered = selectProbes({ discovered, filter: [] });
    assert.equal(unfiltered.selected.length, 2);
    assert.equal(unfiltered.selectionIsFull, true);
    assert.deepEqual(unfiltered.failures, []);

    const nothingDiscovered = selectProbes({ discovered: [], filter: [] });
    assert.equal(nothingDiscovered.selected.length, 0);
    assert.equal(nothingDiscovered.failures.length, 1, 'zero discovered declarations must fail: it records nothing');
    assert.match(nothingDiscovered.failures[0].message, /record(s)? nothing/);

    const matchedNone = selectProbes({ discovered, filter: ['probe-other.mjs'] });
    assert.equal(matchedNone.selected.length, 0);
    assert.ok(matchedNone.failures.some(failure => /selected no probe/.test(failure.message)));
});

test('selection: an unknown probe name in GOTAVERN_ORACLE_PROBES is a hard failure', async () => {
    const { selectProbes, parseProbeFilter } = await core();
    const discovered = [{ script: 'probe-a.mjs', fixture: 'a.json' }];
    assert.deepEqual(parseProbeFilter(' probe-a.mjs ,  ,'), ['probe-a.mjs']);
    assert.deepEqual(parseProbeFilter(''), []);

    const selection = selectProbes({ discovered, filter: ['probe-a.mjs', 'probe-nope.mjs'] });
    assert.equal(selection.selected.length, 1);
    assert.equal(selection.selectionIsFull, false);
    assert.equal(selection.failures.length, 1);
    assert.match(selection.failures[0].message, /do not exist: probe-nope\.mjs/);
});

test('selection: naming every declaration explicitly still counts as the full recording pass', async () => {
    const { selectProbes } = await core();
    const discovered = [
        { script: 'probe-a.mjs', fixture: 'a.json' },
        { script: 'probe-b.mjs', fixture: 'b.json' },
    ];
    const selection = selectProbes({ discovered, filter: ['probe-a.mjs', 'probe-b.mjs'] });
    assert.equal(selection.selected.length, 2);
    assert.equal(selection.selectionIsFull, true, 'a full selection is what earns the stability pass, however it was named');
});

// ---------------------------------------------------------------------------------------------
// 6. TIMING
// ---------------------------------------------------------------------------------------------

test('timing: the record bills only the executions that happened', async () => {
    const { formatTimingReport } = await core();
    const singleProbe = fakeProbe();
    const single = await runFake(singleProbe, { doubleRun: false });
    assert.equal(single.result.executions, 1);

    const singleRow = {
        label: PROBE.label,
        firstMs: 1200,
        secondMs: null,
        executions: 1,
        failed: false,
    };
    const singleReport = formatTimingReport([singleRow]);
    assert.match(singleReport, /1 execution\(s\)/, `the report must state the real execution count; got: ${singleReport}`);
    assert.match(singleReport, /not run/, 'a second run that never happened must be labelled as not run');
    assert.doesNotMatch(singleReport, /x2/, 'a single-run report must not claim two runs');
    assert.doesNotMatch(singleReport, /failed/, 'a successful single run must not be labelled failed');

    const doubleReport = formatTimingReport([
        { label: PROBE.label, firstMs: 1200, secondMs: 800, executions: 2, failed: false },
    ]);
    assert.match(doubleReport, /2 execution\(s\)/);
    assert.doesNotMatch(doubleReport, /not run/);
});

test('timing: a failed attempt keeps its timing and is still counted as an execution', async () => {
    const probe = fakeProbe({ failAttempts: [2] });
    const { result } = await runFake(probe);
    assert.equal(result.executions, 2);
    assert.equal(result.secondMs !== null, true, 'the failing attempt was still executed, so it was timed');
});

// ---------------------------------------------------------------------------------------------
// 7. WIRING: the policy must be ON the execution path
// ---------------------------------------------------------------------------------------------

test('wiring: the double-run decision is taken exactly once (the policy is not an orphan)', () => {
    const source = readFileSync(RUNNER, 'utf8');
    const callSites = source
        .split('\n')
        .map((text, index) => ({ text: text.trim(), line: index + 1 }))
        .filter(({ text }) => /\bdoubleRunFor\s*\(/.test(text))
        .filter(({ text }) => !/function\s+doubleRunFor/.test(text))
        .filter(({ text }) => !/^\s*import\b/.test(text));
    assert.equal(
        callSites.length,
        1,
        `doubleRunFor must be called where the run decides its mode; found ${callSites.length} call site(s): ${JSON.stringify(callSites)}`,
    );
    assert.match(source, /doubleRunFor\(selectionIsFull\)/, 'the decision must be taken from the recording scope');
});

test('wiring: both scheduling shapes hand the decision to the one execution primitive', () => {
    const source = readFileSync(RUNNER, 'utf8');
    const callSites = callExpressions(source, 'executeProbe');
    assert.ok(
        callSites.length >= 2,
        `the single primitive must be called from both scheduling shapes (serial and pooled); found ${callSites.length} call site(s)`,
    );
    callSites.forEach((call, index) => {
        assert.match(
            call,
            /doubleRun\s*:/,
            `executeProbe call site #${index + 1} does not pass a doubleRun decision, so the policy is not on its execution path: ${call.slice(0, 240)}`,
        );
    });
    assert.ok(callSites.some(call => /runProbeInherited/.test(call)), 'the serial shape must use its own single-execution runner');
    assert.ok(callSites.some(call => /runProbeBuffered/.test(call)), 'the pooled shape must use its own single-execution runner');
    assert.doesNotMatch(
        source,
        /verifyProbeSerial|\bverifyProbe\b/,
        'the two old runners must be gone: while a second execution path exists, no policy can reach every probe',
    );
});

test('wiring: the decision is printed exactly once', () => {
    const source = readFileSync(RUNNER, 'utf8');
    const printed = source
        .split('\n')
        .map((text, index) => ({ text: text.trim(), line: index + 1 }))
        .filter(({ text }) => /double run: /.test(text));
    assert.equal(printed.length, 1, `the policy decision must be printed once; found ${printed.length}: ${JSON.stringify(printed)}`);
});

// Returns the full text of every call to `name` in `source`, matched by balanced parentheses, so a call
// site can be inspected for the options it passes without depending on how it is line-wrapped.
function callExpressions(source, name) {
    const found = [];
    for (const match of source.matchAll(new RegExp(`\\b${name}\\s*\\(`, 'g'))) {
        const open = match.index + match[0].length - 1;
        let depth = 0;
        let end = -1;
        for (let index = open; index < source.length; index++) {
            if (source[index] === '(') depth++;
            else if (source[index] === ')') {
                depth--;
                if (depth === 0) {
                    end = index;
                    break;
                }
            }
        }
        found.push(source.slice(match.index, end + 1));
    }
    return found;
}
