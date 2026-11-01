// PACKAGE / FRESHNESS CHECK FOR THE COMMITTED GROUP-CHAT ORACLE FIXTURE.
//
// The committed fixture is the PINNED NODE observation of every group-chat scenario: the exact
// provider request bytes (method, raw target, body sha256, body length, raw body text) plus the
// page-side observations that are deterministic. It is recorded by running
// group-chat-probe.mjs against pinned Node, and the GoTavern leg is compared against it at run
// time -- the fixture never contains a GoTavern observation.
//
// HOST-DEPENDENT FIELDS ARE STRIPPED, NOT NORMALISED AWAY FROM THE COMPARISON: `dataRoot`, the
// ephemeral base URL and the page's own incidental HTTP failures are provenance, not evidence, and
// they differ on every run. Everything that IS evidence survives byte-for-byte, so a fresh
// re-record can be diffed against the committed file (the same discipline as the provider-wire
// oracle: a fixture that re-records byte-identically is the check that it describes behaviour
// rather than a moment).
//
// Usage:
//   node tests/browser/group-chat-record-fixture.mjs --write <fixture.json> --full <pinned leg> --restart <pinned leg>
//   node tests/browser/group-chat-record-fixture.mjs --check <fixture.json> --full <fresh pinned leg> --restart <fresh pinned leg>

import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const BASELINE = Object.freeze({
    name: 'SillyTavern',
    version: '1.19.0',
    commit: '06bde939fb1e9c4c8d8641d810f0a916b5bce127',
});

function argumentValue(name, fallback = null) {
    const index = process.argv.indexOf(name);
    return index === -1 ? fallback : process.argv[index + 1];
}

function readLeg(filePath, label) {
    try {
        const leg = JSON.parse(readFileSync(path.resolve(filePath), 'utf8'));
        if (leg.subject !== 'pinned') throw new Error(`the ${label} leg is ${JSON.stringify(leg.subject)}, not the pinned oracle`);
        return leg;
    } catch (error) {
        const failure = new Error(`cannot read the ${label} pinned leg at ${filePath}: ${error.message}`);
        failure.harness = true;
        throw failure;
    }
}

function normalise(leg) {
    // `setup.rosterAttempts` is a HARNESS diagnostic (how many times the bounded roster re-ask was
    // needed on this host) and is not evidence about pinned behaviour; a run that needed one retry
    // and one that needed none describe the same oracle. It is stripped so the freshness check can
    // be byte-comparison rather than a tolerance.
    const setup = leg.setup ? { ...leg.setup } : null;
    if (setup) delete setup.rosterAttempts;
    return {
        subject: 'pinned',
        phase: leg.phase,
        prngSeed: leg.prngSeed ?? null,
        seedDigest: leg.seedDigest ?? null,
        serverVersion: leg.serverVersion ?? null,
        tokenizerRoot: leg.tokenizerRoot ?? null,
        setup,
        cases: (leg.cases ?? []).map(entry => ({
            name: entry.name,
            groupId: entry.groupId,
            notes: entry.notes,
            steps: (entry.steps ?? []).map(step => step),
            requests: (entry.requests ?? []).map(record => ({
                method: record.method,
                target: record.target,
                batch: record.batch,
                bodySha256: record.bodySha256,
                bodyLength: record.bodyLength,
                bodyText: record.bodyText,
            })),
        })),
    };
}

function buildFixture(fullLeg, restartLeg) {
    return {
        schemaVersion: 1,
        question: 'What provider request does pinned Node send for each group-chat scenario?',
        baseline: BASELINE,
        recordedFrom: 'pinned Node via run-against-pinned.mjs + group-chat-probe.mjs',
        legs: {
            full: normalise(fullLeg),
            restart: normalise(restartLeg),
        },
    };
}

function describeDifference(left, right, prefix = '') {
    if (JSON.stringify(left) === JSON.stringify(right)) return null;
    if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') {
        return `${prefix || '(root)'}: ${JSON.stringify(left)?.slice(0, 120)} != ${JSON.stringify(right)?.slice(0, 120)}`;
    }
    if (Array.isArray(left) !== Array.isArray(right)) {
        return `${prefix}: array/non-array mismatch`;
    }
    if (Array.isArray(left)) {
        if (left.length !== right.length) return `${prefix}.length: ${left.length} != ${right.length}`;
        for (let index = 0; index < left.length; index++) {
            const found = describeDifference(left[index], right[index], `${prefix}[${index}]`);
            if (found) return found;
        }
        return null;
    }
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    for (const key of keys) {
        const found = describeDifference(left[key], right[key], prefix ? `${prefix}.${key}` : key);
        if (found) return found;
    }
    return null;
}

try {
    const fullPath = argumentValue('--full');
    const restartPath = argumentValue('--restart');
    if (!fullPath || !restartPath) {
        throw Object.assign(new Error('--full and --restart pinned legs are required'), { harness: true });
    }
    const fresh = buildFixture(readLeg(fullPath, 'full'), readLeg(restartPath, 'restart'));
    const writePath = argumentValue('--write');
    const checkPath = argumentValue('--check');
    if (writePath) {
        writeFileSync(path.resolve(writePath), `${JSON.stringify(fresh, null, 2)}\n`);
        console.log(JSON.stringify({ wrote: path.resolve(writePath), cases: fresh.legs.full.cases.length + fresh.legs.restart.cases.length }));
    }
    if (checkPath) {
        const committed = JSON.parse(readFileSync(path.resolve(checkPath), 'utf8'));
        const difference = describeDifference(committed, fresh);
        if (difference) {
            console.error(JSON.stringify({ verdict: 'stale', firstDifference: difference }));
            console.error('The pinned oracle recorded a different observation than the committed fixture. Re-record ONLY if the pinned behaviour or the scenario legitimately changed, and say which in the commit message (AGENTS.md doctrine 9).');
            process.exit(1);
        }
        console.log(JSON.stringify({ verdict: 'fresh', cases: fresh.legs.full.cases.length + fresh.legs.restart.cases.length }));
    }
    if (!writePath && !checkPath) {
        throw Object.assign(new Error('either --write or --check is required'), { harness: true });
    }
} catch (error) {
    console.error(`GROUP-CHAT FIXTURE TOOL FAILED: ${error.message}`);
    process.exit(2);
}
