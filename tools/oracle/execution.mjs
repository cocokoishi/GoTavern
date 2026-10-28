// THE ORACLE'S EXECUTION CORE: how many times each probe runs, what happens when a run fails, and the ONE
// primitive both scheduling shapes use to execute a probe.
//
// WHY THIS MODULE EXISTS. The recording runner in tools/build-generated-lib.mjs had two independent
// implementations of "run a probe and compare the two runs": a pooled one for the concurrent phase and a
// serial one for the probes that must run alone. They accounted for executions differently, timed
// differently, and CONTRADICTED each other about a first-run failure -- the pooled one kept run 1's error
// and discarded run 2's (`failure = failure ?? error`), the serial one skipped run 2 entirely
// (`if (doubleRun && !failure)`), while the comment above them promised "both runs always execute, even if
// the first one fails". Neither behaviour was observable in a fixture, because a fixture records what a
// probe OBSERVED and never how many times the harness ran it, so nothing could catch it.
//
// The policy that was supposed to settle the count (`doubleRunFor`) was itself dead code: defined once,
// called from nowhere, so 118 declarations produced 118 x 2 executions in every mode and
// GOTAVERN_ORACLE_DOUBLE_RUN did nothing at all.
//
// So the execution path lives here, as a module with no side effects at import, pure where it can be pure,
// and injectable where it cannot: `executeProbe` takes the single-run function and the fixture reader as
// arguments, which is what makes the contract testable by tests/oracle/execution.test.mjs with no probe,
// no browser and no network.
//
// NOTHING HERE MAY CHANGE WHAT A PROBE RECORDS. Its only inputs are the probe's argv, the process exit
// status, the fixture bytes, and the environment; the fixture comparison it performs is the same
// byte-for-byte comparison (and the same changed-JSON-path report) the runner always used.

import { execFileSync, spawn } from 'node:child_process';
import process from 'node:process';

// ---------------------------------------------------------------------------------------------------
// The double-run policy
// ---------------------------------------------------------------------------------------------------

export const DOUBLE_RUN_ENV = 'GOTAVERN_ORACLE_DOUBLE_RUN';
export const DOUBLE_RUN_MODES = ['all', 'none', 'auto'];

// Resolves how many times each probe runs. Pure, and deliberately total: every input answers, and an
// input it does not recognise falls back to AUTO rather than being silently ignored. That is the defect
// this function replaces -- a mode that was read by nobody produced "everything runs twice" while looking
// like "the setting was honoured".
export function resolveDoubleRunPolicy({ setting, selectionIsFull } = {}) {
    if (typeof selectionIsFull !== 'boolean') {
        throw new TypeError(
            'resolveDoubleRunPolicy needs selectionIsFull: true when every declared probe is selected, false '
            + 'when the run is narrowed. Scope is the whole basis of the policy, so an unstated scope is '
            + 'refused rather than guessed.',
        );
    }
    const normalised = String(setting ?? 'auto').trim().toLowerCase();
    const unknown = !DOUBLE_RUN_MODES.includes(normalised);
    const mode = unknown ? 'auto' : normalised;
    const double = mode === 'all' ? true : mode === 'none' ? false : selectionIsFull;
    const reason = mode === 'all'
        ? `${DOUBLE_RUN_ENV}=all`
        : mode === 'none'
            ? `${DOUBLE_RUN_ENV}=none`
            : selectionIsFull
                ? 'every probe is recording, so this run is the stability pass'
                : 'a narrowed run records what this change can move; the nightly full sweep proves stability';
    return {
        double,
        executions: double ? 2 : 1,
        setting: normalised,
        mode,
        unknown,
        why: unknown
            ? `${DOUBLE_RUN_ENV}="${setting}" is not one of ${DOUBLE_RUN_MODES.join('|')}; failing closed to auto: ${reason}`
            : reason,
    };
}

// The only way the runner asks the question, so the environment is read in exactly one place.
export function doubleRunFor(selectionIsFull, env = process.env) {
    return resolveDoubleRunPolicy({ setting: env?.[DOUBLE_RUN_ENV], selectionIsFull });
}

// The decision is PRINTED once per run. The old file's comment claimed it did that; nothing did.
export function formatDoubleRunDecision(policy) {
    const mode = policy.double ? 'yes' : 'no';
    return `double run: ${mode} -- ${policy.executions} execution(s) per probe; ${policy.why}`;
}

// ---------------------------------------------------------------------------------------------------
// Probe selection
// ---------------------------------------------------------------------------------------------------

export function parseProbeFilter(value) {
    return String(value ?? '')
        .split(',')
        .map(name => name.trim())
        .filter(name => name !== '');
}

// Resolves GOTAVERN_ORACLE_PROBES against the discovered declarations, and returns the selection together
// with every reason it is invalid. An EMPTY selection is a failure in both of its forms -- zero
// declarations discovered (a broken declaration regex, a probe directory that moved) and a filter that
// matches nothing -- because an oracle run that records nothing and exits 0 is the most dangerous result
// this harness can produce: the zero-diff gate then passes over fixtures nobody re-recorded.
export function selectProbes({ discovered = [], filter = [] } = {}) {
    const declared = Array.isArray(discovered) ? discovered : [];
    const names = Array.isArray(filter) ? filter.filter(name => typeof name === 'string' && name !== '') : [];
    const selected = names.length === 0 ? [...declared] : declared.filter(probe => names.includes(probe.script));
    const failures = [];
    if (names.length > 0) {
        const unknown = names.filter(name => !declared.some(probe => probe.script === name));
        if (unknown.length > 0) {
            failures.push({
                label: 'oracle probe filter',
                message: `GOTAVERN_ORACLE_PROBES names probes that do not exist: ${unknown.join(', ')}`,
            });
        }
    }
    if (selected.length === 0) {
        failures.push({
            label: 'oracle probe filter',
            message: names.length === 0
                ? 'no probe declaration was discovered, so this run would record nothing; an oracle run that records nothing is an error rather than a success'
                : 'GOTAVERN_ORACLE_PROBES selected no probe; an empty selection records nothing, so it is an error rather than a success',
        });
    }
    return {
        selected,
        failures,
        selectionIsFull: selected.length > 0 && selected.length === declared.length,
    };
}

// ---------------------------------------------------------------------------------------------------
// The fixture comparison, moved here unchanged so the primitive owns it rather than a scheduling site.
// ---------------------------------------------------------------------------------------------------

export function changedJSONPaths(left, right, location = '$', output = []) {
    if (Object.is(left, right) || output.length >= 40) return output;
    if (Array.isArray(left) && Array.isArray(right)) {
        if (left.length !== right.length) output.push(`${location}.length`);
        for (let index = 0; index < Math.min(left.length, right.length); index++) {
            changedJSONPaths(left[index], right[index], `${location}[${index}]`, output);
        }
        return output;
    }
    if (left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)) {
        const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort();
        for (const key of keys) {
            if (!(key in left) || !(key in right)) output.push(`${location}.${key}`);
            else changedJSONPaths(left[key], right[key], `${location}.${key}`, output);
            if (output.length >= 40) break;
        }
        return output;
    }
    output.push(location);
    return output;
}

// The double-run determinism check: run 1 and run 2 of the SAME pinned server must produce the same bytes.
// Note what this does and does not prove: the zero-diff gate already proves run 1 equals the COMMITTED
// fixture, so this catches a probe that is INTERMITTENTLY unstable -- one whose two runs disagree while at
// least one still matches the commit. The sd-routes arrival-order race was found exactly this way.
export function compareProbeRuns(first, second) {
    if (first.equals(second)) return null;
    const paths = changedJSONPaths(JSON.parse(first), JSON.parse(second));
    // A PATH WITHOUT ITS TWO VALUES IS AN ANONYMOUS RED. Measured: `Browser differential`-adjacent CI run
    // 40689195143 failed with "oracle changed across identical pinned Node runs at:
    // $.results.duplicate-key-control.configAfter.mtimeMs" and nothing else -- no values, so the reader
    // could not tell a wall-clock difference (which the probe ALREADY declares `rule: 'null'` and which
    // therefore cannot be a product finding) from a real instability of recorded BYTES. AGENTS 103: make
    // the producer print what the consumer needs before spending the run. The values are truncated
    // because they are diagnostic, not evidence.
    const show = value => {
        const text = value === undefined ? '<absent>' : JSON.stringify(value);
        return text.length > 120 ? `${text.slice(0, 117)}...` : text;
    };
    const details = paths.map(path => {
        const read = (document) => {
            let cursor = document;
            for (const part of path.replace(/^\$\./, '').split('.')) {
                if (cursor === null || cursor === undefined) return undefined;
                const key = part.replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
                for (const step of key) { cursor = cursor?.[step]; }
            }
            return cursor;
        };
        return `${path} (run1 ${show(read(JSON.parse(first)))}, run2 ${show(read(JSON.parse(second)))})`;
    });
    return new Error(`oracle changed across identical pinned Node runs at: ${details.join(', ')}`);
}

// ---------------------------------------------------------------------------------------------------
// Shared-write diagnostics
// ---------------------------------------------------------------------------------------------------

// Paths under the build root that more than one probe could write.
//
// Pinned src/constants.js PUBLIC_DIRECTORIES are relative to the server directory, and pinned server.js:11
// does `process.chdir(serverDirectory)`, so a probe that touches one of these writes into the shared build
// root no matter what cwd it was spawned with. Spawning with an isolated cwd cannot help.
//
// These are exactly the four PUBLIC_DIRECTORIES subtrees; `extensions` contains `third-party`, and both are
// listed because both are named upstream and either could be touched directly. Add a fifth explicitly, with
// a comment, rather than widening this to the whole build root: a blanket lock could break something
// legitimate for a reason nobody would connect to this change.
export const sharedWritePaths = [
    'public/img',
    'public/sounds',
    'public/scripts/extensions',
    'public/scripts/extensions/third-party',
];

// Reports a write into a shared path with the probe that attempted it, so the failure reads as an
// instruction rather than as a mystery permission error.
export function describeSharedWrite(label, output) {
    if (!/EACCES|EPERM|permission denied|read-only/i.test(output)) return null;
    const mentioned = sharedWritePaths.filter(relative => output.includes(relative));
    const where = mentioned.length > 0 ? mentioned.join(', ') : sharedWritePaths.join(', ');
    return `probe ${label} attempted to write under ${where}, which is shared with other probes. `
        + 'Declare sharedWrite=true on its @gotavern-oracle line to give it a private build root, or stop writing there.';
}

// ---------------------------------------------------------------------------------------------------
// Running a probe once
// ---------------------------------------------------------------------------------------------------

// A probe is executed by a `run` function so the primitive below can be tested with a fake. Both real
// implementations OWN THE SPAWN; what differs between the two scheduling shapes is only how the child's
// output is handled, which is why the shape is a parameter and not a second implementation of the loop.
//
// POOLED: buffered, because concurrent probes would otherwise interleave their output into an unreadable
// log, and because the shared-write diagnostic needs the child's text to name the path it tried to write.
export function runProbeBuffered({ argv, cwd }) {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, argv, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        const output = [];
        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => output.push(chunk));
        child.stderr.on('data', chunk => output.push(chunk));
        child.on('error', reject);
        child.on('close', code => {
            const text = output.join('');
            if (code === 0) {
                resolve({ output: text });
                return;
            }
            const error = new Error(`${process.execPath} ${argv.join(' ')} exited ${code}\n${text}`);
            error.output = text;
            reject(error);
        });
    });
}

// SERIAL: inherited stdio, because a serial probe runs alone and its output should reach the job log as it
// happens. A serial failure's diagnostic can therefore only use the error message, which is why
// describeSharedWrite treats a missing output as "no mentioned path" rather than as "no write happened".
export function runProbeInherited({ argv, cwd }) {
    return new Promise((resolve, reject) => {
        try {
            execFileSync(process.execPath, argv, { cwd, encoding: 'utf8', stdio: 'inherit' });
            resolve({ output: '' });
        } catch (error) {
            reject(error);
        }
    });
}

// ---------------------------------------------------------------------------------------------------
// THE ONE EXECUTION PRIMITIVE
// ---------------------------------------------------------------------------------------------------

// Executes one declared probe `doubleRun ? 2 : 1` times and returns everything the caller needs to decide
// what to report. It owns, for BOTH scheduling shapes:
//
//   * the spawn contract: `[scriptPath, root, repositoryRoot, ...args]`, with cwd = root;
//   * per-run wall time, and the number of executions that ACTUALLY happened;
//   * the byte comparison between the two runs (compareProbeRuns), and the changed JSON paths it names;
//   * the shared-write diagnostic for any probe-level failure;
//   * failure aggregation, including the rule the two old runners disagreed about: a failed run 1 does NOT
//     skip run 2 (the stability check must never be skipped for a probe that just misbehaved), and no
//     error is ever dropped -- both are reported, run 2 attributed as `(run 2)`.
//
// Returns `fixture: null` when a run failed, so a caller can never mistake unstable bytes for recorded
// ones. When only the double-run COMPARISON failed the bytes are still returned, exactly as the old pooled
// runner did, because a caller consumes them (config-init supplies the vendored default config) and the
// recorded failure fails the job regardless.
export async function executeProbe({
    label,
    scriptPath,
    root,
    repositoryRoot,
    args = [],
    doubleRun,
    run = runProbeBuffered,
    readFixture,
    timings = null,
    recordFailure = () => {},
}) {
    if (typeof doubleRun !== 'boolean') {
        throw new TypeError(
            `probe ${label} was executed without a double-run decision. Resolve the policy once with `
            + 'doubleRunFor() and pass .double here, so a mode that is read but never applied cannot happen again.',
        );
    }
    if (typeof readFixture !== 'function') throw new TypeError(`probe ${label} needs a readFixture function`);

    const argv = [scriptPath, root, repositoryRoot, ...args];
    const planned = doubleRun ? 2 : 1;
    const errors = [];
    const outputs = [];
    let first = null;
    let second = null;
    let firstMs = null;
    let secondMs = null;
    let executions = 0;

    for (let attempt = 1; attempt <= planned; attempt++) {
        executions++;
        const started = Date.now();
        try {
            const result = await run({ argv, cwd: root, attempt, stream: attempt === 1 ? 'first' : 'second' });
            const elapsed = Date.now() - started;
            if (attempt === 1) firstMs = elapsed;
            else secondMs = elapsed;
            if (result && typeof result.output === 'string' && result.output) outputs.push(result.output);
            const bytes = readFixture();
            if (attempt === 1) first = bytes;
            else second = bytes;
        } catch (error) {
            const elapsed = Date.now() - started;
            if (attempt === 1) firstMs = elapsed;
            else secondMs = elapsed;
            errors.push({ attempt, error });
        }
    }

    const observed = outputs.join('').trim();
    if (errors.length === 0 && doubleRun) {
        const comparison = compareProbeRuns(first, second);
        if (comparison) errors.push({ attempt: 'comparison', error: comparison });
    }

    for (const { attempt, error } of errors) {
        const attributed = attempt === 2 ? `${label} (run 2)` : label;
        const message = error && error.message ? error.message : String(error);
        const sharedWrite = describeSharedWrite(label, `${observed}\n${message}`);
        recordFailure({
            attempt,
            label: attributed,
            error,
            message: sharedWrite ? `${message}\n${sharedWrite}` : message,
        });
    }

    const runFailed = errors.some(entry => entry.attempt !== 'comparison');
    const failed = errors.length > 0;
    if (timings) timings.push({ label, firstMs, secondMs, executions, failed });

    return {
        fixture: runFailed ? null : first,
        firstMs,
        secondMs,
        executions,
        compared: doubleRun && first !== null && second !== null,
        errors,
        output: observed,
    };
}

// ---------------------------------------------------------------------------------------------------
// The timing report
// ---------------------------------------------------------------------------------------------------

// WHERE THE ORACLE'S TIME ACTUALLY GOES. A declaration costs one execution per run, so the count is what
// makes the number actionable. Two corrections over the version this replaces: the report is emitted AFTER
// the late serial runs (it used to be printed before them, so their time was silently missing), and the
// denominator is the number of executions that happened rather than a hardcoded "x2 runs" -- a single-run
// mode must not be billed for a second run it never paid for.
export function formatTimingReport(rows) {
    if (!Array.isArray(rows) || rows.length === 0) return '';
    const sorted = [...rows].sort((a, b) => ((b.firstMs ?? 0) + (b.secondMs ?? 0)) - ((a.firstMs ?? 0) + (a.secondMs ?? 0)));
    const totalMs = sorted.reduce((sum, row) => sum + (row.firstMs ?? 0) + (row.secondMs ?? 0), 0);
    const executions = sorted.reduce((sum, row) => sum + (row.executions ?? 0), 0);
    const seconds = value => `${(value / 1000).toFixed(1)}s`;
    const lines = [
        `probe execution time: ${seconds(totalMs)} across ${sorted.length} probe declaration(s), ${executions} execution(s)`,
        '  (summed per declaration: with concurrent probes this is execution time, not wall clock)',
        '  slowest first (run 1 / run 2):',
    ];
    for (const row of sorted.slice(0, 15)) {
        const first = row.firstMs === null || row.firstMs === undefined ? 'failed' : seconds(row.firstMs);
        const second = (row.executions ?? 0) < 2
            ? 'not run'
            : row.secondMs === null || row.secondMs === undefined ? 'failed' : seconds(row.secondMs);
        lines.push(`    ${String(first).padStart(8)} / ${String(second).padStart(8)}  ${row.label}`);
    }
    return lines.join('\n');
}
