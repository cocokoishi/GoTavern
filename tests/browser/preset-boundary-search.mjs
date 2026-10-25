// Measure the preset boundary WITH THE PINNED LEG ITSELF.
//
// WHY THIS EXISTS, IN ONE SENTENCE: seven runs failed because the boundary was measured by a procedure
// that was merely SIMILAR to the one that produces the compared request. The capture bisected a dry
// assembly; then it bisected its own sends; each time the drive's send assembled a different number of
// messages at the same context (run 40087218275: capture 24 total / 12 history, all four legs 26 / 11),
// so the pair named a boundary the differential never ran. This script removes the translation: every
// candidate context is driven by THE SAME PROGRAM, WITH THE SAME ARGUMENTS, as the real pinned leg --
// `run-against-pinned.mjs generation-probe.mjs` with PROBE_MODE=preset -- and the observation is the
// provider request that drive produced. The pair it chooses is therefore, by construction, a pair of
// requests the differential can reproduce.
//
// THE CONTRACT IS THE HISTORY SET: oldest turn present at `keep`, absent at `keep - 1`, and the number of
// HISTORY turns differing by exactly one. The TOTAL count is recorded and never asserted (the frontend
// emits its own example/world-info messages as the budget allows). The capture's dry pre-scan is a HINT
// that seeds the bracket; nothing depends on it, and the bracket is widened in whichever direction fails.
//
// Usage: node preset-boundary-search.mjs --legs <dir> [--out <dir>/preset-boundary.json] [--fixture <path>]
// Exit:  0 with the pair, or 1 with the full table and the range that was searched.

import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { PRESET_FIXTURE, parseProviderBody, findMessage, messageText } from './preset-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
};
const legsDir = path.resolve(arg('--legs', path.join(here, '..', '..', 'legs')));
const outPath = path.resolve(arg('--out', path.join(legsDir, 'preset-boundary.json')));
const fixturePath = path.resolve(arg('--fixture', PRESET_FIXTURE));
const low = 120;
const high = 8192;


// SELF-CHECK: resolve the module's top-level constants and exit before spawning anything. `node --check`
// cannot see an undefined identifier, and the first thing this script otherwise does is boot a pinned
// server. CI runs this as its step's first command.
if (argv.includes('--self-check')) {
    console.log(JSON.stringify({ selfCheck: 'ok', legsDir: typeof legsDir === 'string' && legsDir.length > 0, outPath: typeof outPath === 'string' && outPath.length > 0, fixturePath: typeof fixturePath === 'string' && fixturePath.length > 0, range: [low, high] }));
    process.exit(0);
}
async function readJSON(file) {
    return JSON.parse(await fs.readFile(file, 'utf8'));
}

// drivePinned runs ONE pinned-leg drive at `context` and returns the observation from the provider
// request it produced. `run-against-pinned.mjs` boots a fresh pinned server and data root per call, so
// every candidate is measured from the same clean state a real leg starts from.
async function drivePinned(fixture, context) {
    const reportPath = path.join(legsDir, `preset-search-${context}.json`);
    const redirectPath = path.join(legsDir, `redirect-preset-search-${context}.json`);
    const child = spawn(process.execPath, [
        path.join(here, 'run-against-pinned.mjs'),
        'generation-probe.mjs',
        '--',
        '--report',
        reportPath,
    ], {
        cwd: here,
        stdio: ['ignore', 'inherit', 'inherit'],
        env: {
            ...process.env,
            PROBE_MODE: 'preset',
            PROBE_SOURCE: 'custom',
            PROBE_PRESET_VARIANT: 'keep',
            PROBE_PRESET_CONTEXT: String(context),
            PROBE_PINNED_REDIRECT_FILE: redirectPath,
        },
    });
    const code = await new Promise(resolve => child.on('exit', resolve));
    if (code !== 0) {
        return { context, failure: `the pinned drive exited ${code} at max_context=${context}` };
    }
    const report = await readJSON(reportPath);
    if (!report.requestArrived) {
        return { context, failure: `the pinned drive produced no provider request at max_context=${context}`, diagnosis: report.failure ?? null };
    }
    const parsed = parseProviderBody(report);
    if (!parsed) {
        return { context, failure: `the pinned drive recorded no POST body at max_context=${context}` };
    }
    const messages = Array.isArray(parsed.body?.messages) ? parsed.body.messages : [];
    const oldestMarker = String(fixture?.capture?.boundary?.oldestMarker ?? '').slice(0, 40);
    const historyMarker = fixture?.capture?.spec?.markers?.history ?? 'PRESET_HIST_7F';
    return {
        context,
        total: messages.length,
        history: messages.filter(message => messageText(message).includes(historyMarker)).length,
        oldestPresent: findMessage(parsed.body, oldestMarker) >= 0,
        bodySha256: parsed.bodySha256 ?? null,
        bodyLength: parsed.bodyLength ?? null,
        failure: null,
    };
}

const fixture = await readJSON(fixturePath);
const hint = Number.isInteger(fixture?.capture?.boundary?.dryPreScanFlip) ? fixture.capture.boundary.dryPreScanFlip : null;
// The bracket is seeded by the hint and is TWO-SIDED: the two runs so far disagree about which side the
// send's flip is on, so neither direction is assumed.
let bottom = Math.max(low, (hint ?? 2048) - 1024);
let top = Math.min(high, (hint ?? 2048) + 512);
const search = [];
const probe = async context => {
    const known = search.find(entry => entry.context === context);
    if (known) return known;
    const result = await drivePinned(fixture, context);
    search.push(result);
    console.log(`[boundary] ${JSON.stringify(result)}`);
    return result;
};

const failures = [];
const topProbe = await probe(top);
if (topProbe.failure) failures.push(topProbe.failure);
let bottomProbe = await probe(bottom);
if (bottomProbe.failure) failures.push(bottomProbe.failure);
if (!bottomProbe.failure && bottomProbe.oldestPresent && bottom > low) {
    bottom = low;
    bottomProbe = await probe(bottom);
    if (bottomProbe.failure) failures.push(bottomProbe.failure);
}

const table = () => search
    .slice()
    .sort((left, right) => left.context - right.context)
    .map(entry => `${entry.context}/${entry.total ?? '-'}/${entry.history ?? '-'}/${entry.failure ? 'FAILED' : entry.oldestPresent}`)
    .join('; ');

let keepContext = null;
let keep = null;
let drop = null;
if (!topProbe.failure && !bottomProbe.failure && topProbe.oldestPresent && !bottomProbe.oldestPresent) {
    let lo = bottom; // drops the oldest turn
    let hi = top; // keeps it
    while (lo + 1 < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const result = await probe(mid);
        if (result.failure) {
            failures.push(result.failure);
            break;
        }
        if (result.oldestPresent) {
            hi = mid;
        } else {
            lo = mid;
        }
    }
    for (let candidate = hi; candidate <= Math.min(hi + 4, high); candidate++) {
        const keepProbe = await probe(candidate);
        const dropProbe = await probe(candidate - 1);
        if (keepProbe.failure || dropProbe.failure) continue;
        if (!keepProbe.oldestPresent || dropProbe.oldestPresent) continue;
        if (keepProbe.history - dropProbe.history !== 1) continue;
        keepContext = candidate;
        keep = keepProbe;
        drop = dropProbe;
        break;
    }
}

const artifact = {
    schemaVersion: 1,
    measuredBy: 'pinned-leg',
    method: 'every candidate context is driven by run-against-pinned.mjs generation-probe.mjs with PROBE_MODE=preset (the same program, arguments and clean state as the compared pinned leg); the observation is the provider REQUEST that drive produced',
    hint: { dryPreScanFlip: hint, usedAs: 'bracket seed only, never as a bound' },
    bracket: { bottom, top, searchedLow: low, searchedHigh: high },
    keepContext,
    dropContext: keepContext === null ? null : keepContext - 1,
    keep,
    drop,
    search: search.slice().sort((left, right) => left.context - right.context),
    failures,
};
await fs.mkdir(path.dirname(outPath), { recursive: true });
await fs.writeFile(outPath, JSON.stringify(artifact, null, 2) + '\n');

if (keepContext === null) {
    console.error(`preset boundary search FAILED: no context in [${bottom}, ${top}] separated "kept" from "dropped" by exactly one history message.`);
    console.error(`table (max_context/total/history/oldestPresent): ${table()}`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
if (!topProbe.oldestPresent && !topProbe.failure) {
    console.error(`preset boundary search FAILED: the pinned leg DROPPED the oldest turn at every probed context up to ${top}; widen the range upward. table: ${table()}`);
    process.exit(1);
}
console.log(JSON.stringify({
    out: outPath,
    keepContext,
    dropContext: keepContext - 1,
    keep: { total: keep.total, history: keep.history },
    drop: { total: drop.total, history: drop.history },
    probes: search.length,
}));
