#!/usr/bin/env node
// THE ORACLE PLANNER: one decision, printed as JSON, fail-closed.
//
// WHY THE DECISION LEFT YAML. Until this file existed, `.github/workflows/ci.yml:113-152` WAS the
// Oracle selection policy: a bash regex, two `case` loops, and a `grep -l "fixture=..."` filename
// heuristic, all inside a workflow that cannot be unit-tested. Its gap was not a typo: the regex did
// not list `internal/**`, `cmd/**` or `tools/*/main.go`, so a Go change that moves a fixture skipped
// the entire oracle job and the log said `oracle=false` as though that were a measurement.
//
// WHAT THIS FILE DOES. It consumes `tools/oracle/manifest.mjs` (the derived dependency graph) and a
// changed-file list, and prints:
//
//   { "recordPinned": bool, "full": bool, "probes": [...], "reason": [...],
//     "stabilityMode": "single"|"double", "failClosed": bool, "changed": [...], "errors": [...] }
//
// `probes` holds SCRIPT file names (`probe-heartbeat.mjs`), not probe ids, because that is what the
// runner's filter compares (`tools/build-generated-lib.mjs:481-483` filters on `probe.script`, and
// `:485-491` refuses a name that does not exist). `probes: []` with `full: true` means "every probe",
// which is how the runner spells a full sweep (`GOTAVERN_ORACLE_PROBES` empty).
//
// THE THREE-WAY OUTCOME, and why none of them is silence:
//   recordPinned=false          every changed path is provably irrelevant to fixture bytes
//   recordPinned=true, full     every probe re-records (the only honest answer when the graph cannot
//                               attribute a change); failClosed says whether that was forced
//   recordPinned=true, !full    exactly the named probes re-record
//
// USAGE
//   node tools/oracle/plan.mjs --run-type push --changed changed.txt
//   node tools/oracle/plan.mjs --run-type push --changed-base <sha>
//   node tools/oracle/plan.mjs --run-type schedule
//   node tools/oracle/plan.mjs --run-type dispatch --requested probe-a.mjs,probe-b.mjs
//
// EXIT CODES: 0 a plan was produced; 1 the manifest or the request is structurally broken (the plan is
// still printed, so the log names it); 2 usage. Exit 1 is deliberate: an unknown requested probe or a
// graph that is not a total function must turn the `changes` job red, not select nothing.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildManifest, repositoryRootDefault, validate } from './manifest.mjs';

// THE IRRELEVANT-PATH ALLOWLIST, QUOTED ONCE.
//
// A path here is "provably irrelevant to fixture bytes". This list is the ONLY place a change may
// reach the oracle's `oracle=false` outcome, and each entry states the reason AND how the claim was
// checked, because a silent skip is exactly the failure this whole change exists to remove. Anything
// not listed here and not attributable through the manifest is treated as an unresolved dependency and
// forces a FULL sweep. FULL_TRIGGERS is consulted BEFORE this list, so a control-plane file named there
// can never be excused by a broader entry below.
//
// `scripts/` IS THE ONE ENTRY THAT RESTS ON A NEGATIVE. It was checked, not assumed: at HEAD
// `grep -c 'scripts/' tools/probe-*.mjs` finds 28 lines, and every distinct token is the PINNED
// server's URL path under `public/scripts/extensions` (`/scripts/extensions/third-party/`, ...), never
// a repository path; `grep -E "scripts/[A-Za-z0-9._-]+\.(mjs|sh|ps1)" tools/probe-*.mjs` and
// `grep -E "spawn\('node'|execFileSync\('node'|'\./scripts/"` both return ZERO. The claim is also
// enforced rather than trusted: `deriveInputs` turns any future `scripts/<name>.mjs|.sh|.ps1` reference
// in a probe into that probe's input, and an input is matched before this list is consulted, so a probe
// that starts invoking a repository script selects itself without anyone editing this file.
// ---------------------------------------------------------------------------------------------
export const IRRELEVANT_PATHS = [
    { pattern: /^docs\//, why: 'documentation; no probe reads it' },
    { pattern: /^\.github\//, why: 'workflow definitions other than the ones named in FULL_TRIGGERS; they schedule work, they are never recorded into a fixture' },
    { pattern: /^tests\/browser\//, why: 'browser evidence artifacts; the oracle records no fixture from them' },
    { pattern: /^tests\/oracle\/[^/]+\.md$/, why: 'fixture documentation' },
    { pattern: /^tests\/oracle\/[^/]+\.test\.mjs$/, why: 'the oracle tests themselves; gated by node --test, not by re-recording' },
    { pattern: /^tools\/oracle\//, why: 'the planner (manifest.mjs/plan.mjs) runs no probe and is not an input to one; tests/oracle/plan.test.mjs is its gate. execution.mjs is NOT covered by this: it executes every probe and is a FULL trigger above' },
    { pattern: /^scripts\//, why: 'developer scripts; no probe invokes one (checked, see above), and a probe that starts to would gain the path as a derived input that outranks this entry' },
    { pattern: /^[^/]+\.md$/, why: 'top-level markdown' },
    { pattern: /^LICENSE$/, why: 'licence text' },
];

// A change to any of these can move ANY fixture, because every probe imports the harness, or because
// the whole pinned baseline moves. The plan cannot narrow them without lying.
//
// THE CONTROL PLANE IS IN HERE ON PURPOSE. `ci.yml`/`lane.yml` decide WHICH work runs; a change to them
// is not evidence that the new selection is correct, it is the thing under test. The first draft of this
// file classified `.github/**` as irrelevant, and this PR's own run came back `oracle: skipped` -- the
// precise false green this change exists to remove, produced by the change itself. A control-plane edit
// now forces one full sweep against the real corpus, which is the only thing that can show the new
// planner agrees with the old behaviour.
export const FULL_TRIGGERS = [
    { pattern: /^\.github\/workflows\/ci\.yml$/, why: 'the gate that selects the oracle\'s work: a change to it must be proven against a full sweep, not excused' },
    { pattern: /^\.github\/workflows\/lane\.yml$/, why: 'the lane verification workflow: same control-plane class as ci.yml' },
    { pattern: /^tools\/lib\//, why: 'tools/lib is the harness every probe imports' },
    { pattern: /^tools\/build-generated-lib\.mjs$/, why: 'the generator that records every fixture' },
    { pattern: /^tools\/oracle\/execution\.mjs$/, why: 'the execution primitive the generator runs every probe through, so a change here can move every fixture' },
    { pattern: /^tools\/generate-upstream-inventories\.mjs$/, why: 'the inventories generator the oracle job also runs' },
    { pattern: /^upstream\//, why: 'vendored baseline assets; the whole pinned baseline can move' },
    { pattern: /^go\.mod$/, why: 'the Go dependency graph' },
    { pattern: /^go\.sum$/, why: 'the Go dependency graph' },
];

const GO_PRODUCT_TRIGGER = /^(internal|cmd)\//;
const GO_FILE = /\.go$/;
const FIXTURE_PATH = /^tests\/oracle\/[^/]+\.json$/;

function toPosix(value) {
    return value.split('\\').join('/').replace(/^\.\//, '');
}

function matches(pattern, filePath) {
    return pattern.test(filePath);
}

function entrySelectsPath(entry, changedPath) {
    return entry.inputs.some(input => (input.endsWith('/')
        ? changedPath === input.slice(0, -1) || changedPath.startsWith(input)
        : changedPath === input));
}

function probeList(entries) {
    return [...new Set(entries.map(entry => entry.script))].sort();
}

/**
 * The only constructor of a plan, so the "empty selection while the oracle is needed" invariant has
 * one home. Exported because a post-condition nobody can call is a post-condition nobody can test:
 * `tests/oracle/plan.test.mjs` feeds it the offending shape directly.
 */
export function finalizePlan(fields) {
    const errors = [...(fields.errors ?? [])];
    const probes = fields.probes ?? [];
    const recordPinned = fields.recordPinned;
    const full = fields.full;
    // A plan that says "the oracle must record" and names nothing is the failure this whole module
    // exists to prevent: the caller would pass an empty GOTAVERN_ORACLE_PROBES, the runner would treat
    // it as "all"..., or worse, record nothing and report success.
    if (recordPinned === true && full !== true && probes.length === 0
        && !errors.some(entry => entry.code === 'empty-selection')) {
        errors.push({
            code: 'empty-selection',
            subject: 'plan',
            message: 'recordPinned is true but no probe was selected and the run is not full: '
                + 'an empty selection cannot verify anything, so this plan is refused',
        });
    }
    return {
        recordPinned,
        full,
        probes,
        reason: fields.reason ?? [],
        stabilityMode: fields.stabilityMode ?? (full ? 'double' : 'single'),
        failClosed: fields.failClosed ?? false,
        changed: fields.changed ?? [],
        errors,
    };
}

/** Exit-code policy, so it is a function of the decision and not of `main`'s mood. */
export function exitCodeFor(decision) {
    return decision.errors.length > 0 ? 1 : 0;
}

/**
 * Resolve a request (dispatch input, or a hand-typed list) to a set of probe scripts.
 * Acronyms: accepts a script name, a probe id, or a fixture file name; anything else is an error.
 */
export function resolveRequested(manifest, requested) {
    const byScript = new Map(manifest.entries.map(entry => [entry.script, entry]));
    const byProbe = new Map();
    const byFixture = new Map();
    for (const entry of manifest.entries) {
        byProbe.set(entry.probe, entry);
        byFixture.set(entry.fixture, entry);
    }
    const selected = new Map();
    const unknown = [];
    for (const raw of requested) {
        const name = raw.trim();
        if (name === '') continue;
        const entry = byScript.get(name) ?? byProbe.get(name) ?? byFixture.get(name);
        if (!entry) {
            unknown.push(name);
            continue;
        }
        selected.set(entry.script, entry);
    }
    return { entries: [...selected.values()], unknown };
}

/**
 * The planner, as a pure function of the manifest + the run request. No git, no filesystem.
 */
export function plan({ manifest, manifestErrors = [], runType, changed = [], requested = [] }) {
    const errors = [...manifestErrors];
    const reason = [];

    if (errors.length > 0) {
        // A graph that is not a total function from fixture to owner cannot justify any selection.
        return finalizePlan({
            recordPinned: true,
            full: true,
            reason: ['the oracle dependency graph is broken, so no narrowing is trustworthy'],
            stabilityMode: 'double',
            failClosed: true,
            changed,
            errors,
        });
    }

    const allEntries = manifest.entries;

    if (runType === 'schedule') {
        return finalizePlan({
            recordPinned: true,
            full: true,
            reason: ['scheduled full sweep: every declared probe re-records, which is also the stability pass'],
            stabilityMode: 'double',
            changed,
            errors,
        });
    }

    if (runType !== 'push' && runType !== 'dispatch') {
        errors.push({ code: 'unknown-run-type', subject: String(runType), message: 'run type must be push, schedule or dispatch' });
        return finalizePlan({ recordPinned: true, full: true, reason: ['unrecognised run type'], failClosed: true, changed, errors });
    }

    if (runType === 'dispatch') {
        if (requested.length === 0) {
            return finalizePlan({
                recordPinned: true,
                full: true,
                reason: ['dispatch with no probe list: this is a requested full sweep'],
                stabilityMode: 'double',
                changed,
                errors,
            });
        }
        const { entries, unknown } = resolveRequested(manifest, requested);
        if (unknown.length > 0) {
            errors.push({
                code: 'unknown-requested-probe',
                subject: unknown.join(', '),
                message: `requested probe(s) do not exist: ${unknown.join(', ')}. An unknown name must fail, not select nothing.`,
            });
        }
        if (entries.length === 0) {
            errors.push({
                code: 'empty-selection',
                subject: 'dispatch',
                message: 'the request resolved to no probe; a narrowed run that records nothing cannot verify anything',
            });
        }
        return finalizePlan({
            recordPinned: entries.length > 0,
            full: false,
            probes: probeList(entries),
            reason: [`dispatch requested ${probeList(entries).length} probe(s)`],
            stabilityMode: 'single',
            changed,
            errors,
        });
    }

    // ---- push -----------------------------------------------------------------------------
    const files = [...new Set(changed.map(toPosix).filter(name => name !== ''))].sort();
    if (files.length === 0) {
        // An empty diff against a real base means nothing changed, but an empty list can also mean the
        // diff failed. Recording nothing is only safe when the caller proved the emptiness, and it
        // cannot, so this is a full sweep with the reason named.
        return finalizePlan({
            recordPinned: true,
            full: true,
            reason: ['no changed paths were supplied, so the change cannot be attributed'],
            stabilityMode: 'double',
            failClosed: true,
            changed: files,
            errors,
        });
    }

    const selected = new Map();
    let forcedFull = false;
    const unresolved = [];

    for (const file of files) {
        const fullTrigger = FULL_TRIGGERS.find(trigger => matches(trigger.pattern, file));
        if (fullTrigger) {
            return finalizePlan({
                recordPinned: true,
                full: true,
                reason: [`${file}: ${fullTrigger.why} -- every probe must re-record`],
                stabilityMode: 'double',
                failClosed: false,
                changed: files,
                errors,
            });
        }

        const selectors = allEntries.filter(entry => entrySelectsPath(entry, file));
        if (selectors.length > 0) {
            for (const entry of selectors) selected.set(entry.script, entry);
            reason.push(`${file}: ${probeList(selectors).length} probe(s) read it directly`);
            continue;
        }

        // A CHANGED FIXTURE SELECTS ITS OWNER. This is the one path where the old `grep -l
        // "fixture=..."` was right, and it is now answered by the manifest's owner map instead of a
        // filename grep. A fixture with no owner is not "someone else's problem": nothing can
        // re-record it, so the sweep is full and the reason names the fixture.
        if (FIXTURE_PATH.test(file)) {
            const fixtureName = file.slice(file.lastIndexOf('/') + 1);
            const owners = allEntries.filter(entry => entry.fixture === fixtureName);
            if (owners.length === 0) {
                forcedFull = true;
                reason.push(`${file}: no probe owns this fixture, so nothing can re-record it -- full sweep`);
                continue;
            }
            for (const entry of owners) selected.set(entry.script, entry);
            reason.push(`${file}: fixture re-recorded by its owner ${probeList(owners).join(', ')}`);
            continue;
        }

        if (GO_PRODUCT_TRIGGER.test(file)) {
            const dependents = allEntries.filter(entry => entry.goProduct || entry.inputs.includes('go-product'));
            if (dependents.length === 0) {
                forcedFull = true;
                reason.push(`${file}: Go change but no probe declares a go-product dependency -- full sweep`);
                continue;
            }
            for (const entry of dependents) selected.set(entry.script, entry);
            reason.push(`${file}: Go change; ${probeList(dependents).length} probe(s) record Go output`);
            continue;
        }

        const irrelevant = IRRELEVANT_PATHS.find(allowed => matches(allowed.pattern, file));
        if (irrelevant) {
            reason.push(`${file}: irrelevant (${irrelevant.why})`);
            continue;
        }

        // A stray Go file outside internal/, cmd/ and a known helper directory is the one case where
        // "no probe reads this" and "no fixture can move" are different statements: a new package can
        // be imported by anything.
        if (GO_FILE.test(file)) {
            forcedFull = true;
            unresolved.push(file);
            reason.push(`${file}: a Go file outside internal/, cmd/ and the known helper directories cannot be attributed -- full sweep`);
            continue;
        }

        forcedFull = true;
        unresolved.push(file);
        reason.push(`unresolved dependency: ${file} -- no probe declares it and it is not in the irrelevant allowlist`);
    }

    if (forcedFull) {
        return finalizePlan({
            recordPinned: true,
            full: true,
            reason,
            stabilityMode: 'double',
            failClosed: true,
            changed: files,
            errors,
        });
    }

    const probes = probeList([...selected.values()]);
    if (probes.length === 0) {
        // Every path was provably irrelevant. This is the only road to oracle=false.
        return finalizePlan({
            recordPinned: false,
            full: false,
            probes: [],
            reason: [...reason, 'no changed path can move a fixture: the oracle job is not needed'],
            stabilityMode: 'single',
            failClosed: false,
            changed: files,
            errors,
        });
    }
    return finalizePlan({
        recordPinned: true,
        full: false,
        probes,
        reason,
        stabilityMode: 'single',
        changed: files,
        errors,
    });
}

/**
 * Build a plan for the real repository, validating the graph first.
 *
 * Warnings are surfaced on the manifest's own CLI (`--validate`) and are not decisions: they mark
 * declaration fields nothing reads. Only a broken invariant makes the graph unusable.
 */
export function planRepository({ repositoryRoot = repositoryRootDefault, runType, changed = [], requested = [] }) {
    const manifest = buildManifest({ repositoryRoot });
    const validation = validate(manifest);
    return { manifest, plan: plan({ manifest, manifestErrors: validation.errors, runType, changed, requested }) };
}

function parseArguments(argv) {
    const options = { runType: 'push', changed: null, changedBase: null, requested: [] };
    for (let index = 0; index < argv.length; index += 1) {
        const token = argv[index];
        const value = argv[index + 1];
        if (token === '--run-type' && value) { options.runType = value.trim(); index += 1; continue; }
        if (token === '--changed' && value) { options.changed = value; index += 1; continue; }
        if (token === '--changed-base' && value) { options.changedBase = value; index += 1; continue; }
        if (token === '--requested') { options.requested = (value ?? '').split(',').map(name => name.trim()).filter(Boolean); index += 1; continue; }
        throw new Error(`unknown argument: ${token}`);
    }
    return options;
}

function readChanged(options, repositoryRoot) {
    if (options.changed) {
        return readFileSync(options.changed, 'utf8').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    }
    if (options.changedBase) {
        const output = execFileSync('git', ['diff', '--name-only', options.changedBase, 'HEAD'], {
            cwd: repositoryRoot,
            encoding: 'utf8',
        });
        return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    }
    return [];
}

function main(argv) {
    let options;
    try {
        options = parseArguments(argv);
    } catch (error) {
        console.error(error.message);
        return 2;
    }
    const { plan: decision } = planRepository({
        runType: options.runType,
        changed: readChanged(options, repositoryRootDefault),
        requested: options.requested,
    });
    console.log(JSON.stringify(decision, null, 2));
    if (decision.errors.length > 0) {
        for (const entry of decision.errors) console.error(`${entry.code} [${entry.subject}] ${entry.message}`);
    }
    return exitCodeFor(decision);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exit(main(process.argv.slice(2)));
}
