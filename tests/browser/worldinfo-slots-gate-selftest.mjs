// TEETH FOR THE WORLD-INFO SLOT-ORDER COMPARATOR: mutate the recorded legs and require a NAMED red, then show green.
//
// WHY THIS FILE EXISTS. A comparator that always fails is not teeth either -- so this self-test asserts BOTH
// directions on the SAME recorded pair, in one run:
//   1. the UNTOUCHED pair must be GREEN (exit 0, no failed guards). If it is not, this file says so and stops: a
//      mutation result measured on top of an already-failing comparator proves nothing (rule 7 in a new costume).
//   2. each MUTATION is applied to COPIES of the legs, the comparator is run on the copies, and the run must
//      (a) exit non-zero and (b) name the EXPECTED guard in `failedGuards`. A mutation that goes red for a different
//      reason is a red I cannot attribute, and is reported as a failure of THIS file, not as success.
//   3. the originals are never written: their sha256 are captured before and after and must be unchanged.
//
// THE MUTATIONS ARE APPLIED TO THE MEASURED PROVIDER BODY, and the leg's layout is RECOMPUTED from the mutated body with
// the same `extractLayout` the probe uses. So the fixture cannot drift from the mutation: what the comparator reads is
// exactly what the mutated wire would say.
//
// BOTH SUBJECTS ARE MUTATED IDENTICALLY, AND THE DIGESTS ARE RECOMPUTED, on purpose: that keeps `nodeEqualsGo` green and
// leaves the ORDERING guard as the only thing that can fire. A mutation that only touched one subject would turn the
// byte guard red and prove nothing about ordering.
//
// Usage: node worldinfo-slots-gate-selftest.mjs [--gotavern <leg>] [--pinned <leg>] [--out-dir <dir>]

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { extractLayout } from './worldinfo-slots-kit.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1];
};
const outDir = path.resolve(arg('--out-dir', path.join(here, 'legs', 'gate-selftest')));
const legPaths = {
    gotavern: path.resolve(arg('--gotavern', path.join(here, 'legs', 'worldinfo-slots-gotavern.json'))),
    pinned: path.resolve(arg('--pinned', path.join(here, 'legs', 'worldinfo-slots-pinned.json'))),
};

const problems = [];
const legs = {};
for (const subject of ['gotavern', 'pinned']) {
    try {
        legs[subject] = JSON.parse(await fs.readFile(legPaths[subject], 'utf8'));
    } catch (error) {
        problems.push(`${subject} leg is unreadable at ${legPaths[subject]} (${error?.message ?? error}), so there is nothing to mutate`);
    }
}
if (problems.length > 0) {
    console.error(`worldinfo-slots gate self-test REFUSED: ${problems.join('; ')}`);
    process.exit(2);
}
const shasBefore = {};
for (const subject of ['gotavern', 'pinned']) {
    shasBefore[subject] = createHash('sha256').update(await fs.readFile(legPaths[subject])).digest('hex');
}

await fs.mkdir(outDir, { recursive: true });

function comparatorRun(gotavernPath, pinnedPath, outPath) {
    return new Promise(resolve => {
        const child = spawn(process.execPath, [path.join(here, 'compare-worldinfo-slots-legs.mjs'), '--gotavern', gotavernPath, '--pinned', pinnedPath, '--out', outPath], { cwd: here, stdio: ['ignore', 'pipe', 'pipe'] });
        const out = [];
        child.stdout.on('data', chunk => out.push(chunk.toString()));
        child.stderr.on('data', chunk => out.push(chunk.toString()));
        child.on('exit', code => resolve({ code: code ?? 1, output: out.join('') }));
    });
}

/** Reads the comparator's own artefact, which is the machine-readable verdict. */
async function verdictOf(outPath) {
    try {
        const artefact = JSON.parse(await fs.readFile(outPath, 'utf8'));
        return { failedGuards: artefact.failedGuards ?? [], asymmetries: artefact.asymmetries ?? [], mismatches: artefact.mismatches ?? [], verdict: artefact.verdict };
    } catch (error) {
        return { failedGuards: null, error: String(error?.message ?? error) };
    }
}

const rewriteBody = (leg, mutateMessages) => {
    const copy = JSON.parse(JSON.stringify(leg));
    const entry = copy.cases[0];
    const parsed = JSON.parse(entry.request.body);
    mutateMessages(parsed.messages);
    entry.request.body = JSON.stringify(parsed);
    entry.request.sha256 = createHash('sha256').update(entry.request.body).digest('hex');
    entry.request.byteLength = Buffer.byteLength(entry.request.body);
    entry.layout = extractLayout(entry.request.body);
    return copy;
};

const contentOf = message => (typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? ''));
const indexOf = (messages, marker) => messages.findIndex(message => contentOf(message).includes(marker));
const MARKERS = legs.gotavern?.cases?.[0]?.markers ?? legs.pinned?.cases?.[0]?.markers ?? null;
if (!MARKERS) {
    console.error('worldinfo-slots gate self-test REFUSED: neither leg records its markers, so no mutation can name a slot');
    process.exit(2);
}

const results = [];
const check = async (name, mutation, expectedGuard, { sides = 'both' } = {}) => {
    const copyPaths = {
        gotavern: path.join(outDir, `mutated-${name}-gotavern.json`),
        pinned: path.join(outDir, `mutated-${name}-pinned.json`),
    };
    // A ONE-SIDED MUTATION IS THE FAITHFUL SIMULATION OF A PRODUCT DEFECT: the candidate misplaces a slot while the
    // PINNED leg stays the oracle. A TWO-SIDED mutation cannot test an ABSOLUTE guard -- the pinned baseline moves with
    // it and the comparator rightly REFUSES as a STALE BASELINE, which is a red but not the named guard this file is
    // looking for (measured: both depth mutations came back with exit 2 and no artefact until this split existed). So
    // the ordering mutation, whose point is that equal BYTES can still carry the wrong ORDER, uses both sides, and every
    // mutation that moves a depth uses one.
    for (const subject of ['gotavern', 'pinned']) {
        const mutated = sides === 'both' || subject === 'gotavern' ? rewriteBody(legs[subject], mutation) : JSON.parse(JSON.stringify(legs[subject]));
        await fs.writeFile(copyPaths[subject], `${JSON.stringify(mutated, null, 2)}\n`);
    }
    const outPath = path.join(outDir, `mutated-${name}-verdict.json`);
    // A REFUSAL (exit 2) writes NO artefact, so a file left by an earlier run must never be read as this run's verdict.
    await fs.rm(outPath, { force: true });
    const run = await comparatorRun(copyPaths.gotavern, copyPaths.pinned, outPath);
    const verdict = await verdictOf(outPath);
    const named = verdict.failedGuards ?? [];
    const ok = run.code !== 0 && named.includes(expectedGuard);
    results.push({ mutation: name, expectedGuard, exitCode: run.code, failedGuards: named, asymmetries: (verdict.asymmetries ?? []).map(item => item.guard), mismatches: (verdict.mismatches ?? []).length, ok });
    console.log(`${ok ? 'ok  ' : 'FAIL'} mutation ${name}: exit=${run.code} failedGuards=[${named.join(', ')}] expected=${expectedGuard}`);
    if (!ok) console.error(`     ${run.output.slice(-1500)}`);
    return ok;
};

// 1. THE UNTOUCHED PAIR MUST BE GREEN. Without this, every red below could be the comparator failing for its own reason.
const greenPath = path.join(outDir, 'untouched-verdict.json');
const greenRun = await comparatorRun(legPaths.gotavern, legPaths.pinned, greenPath);
const greenVerdict = await verdictOf(greenPath);
const greenOk = greenRun.code === 0 && greenVerdict.verdict === 'PASS' && (greenVerdict.failedGuards ?? []).length === 0;
console.log(`${greenOk ? 'ok  ' : 'FAIL'} untouched pair: exit=${greenRun.code} verdict=${greenVerdict.verdict} failedGuards=[${(greenVerdict.failedGuards ?? []).join(', ')}]`);
if (!greenOk) {
    console.error('the comparator is not green on the untouched pair, so a mutation red would be unattributable; stopping.');
    console.error(greenRun.output.slice(-3000));
    process.exit(1);
}

const all = [];
// 2a. SWAP THE TWO SYSTEM-BLOCK SLOTS. The messages stay in place; the before/after MARKERS trade places, which is what
// "the implementation put the after-slot content before the before-slot content" looks like on the wire.
all.push(await check('swap-before-and-after', messages => {
    const beforeIndex = indexOf(messages, MARKERS.before);
    const afterIndex = indexOf(messages, MARKERS.after);
    if (beforeIndex < 0 || afterIndex < 0) throw new Error('the recorded body does not contain both system-block markers, so this mutation cannot be applied');
    const beforeContent = contentOf(messages[beforeIndex]);
    messages[beforeIndex] = { ...messages[beforeIndex], content: beforeContent.split?.(MARKERS.before).join(MARKERS.after) };
    messages[afterIndex] = { ...messages[afterIndex], content: contentOf(messages[afterIndex]).split?.(MARKERS.after).join(MARKERS.before) };
}, 'beforeSlotPrecedesAfterSlot'));

// 2b. DROP THE DEPTH SLOT. The entry never activated (or was consumed) -- the shape a broken activation would produce.
all.push(await check('drop-depth-slot', messages => {
    const depthIndex = indexOf(messages, MARKERS.depth);
    if (depthIndex < 0) throw new Error('the recorded body does not contain the depth marker, so this mutation cannot be applied');
    messages[depthIndex] = { ...messages[depthIndex], content: contentOf(messages[depthIndex]).split(MARKERS.depth).join('') };
}, 'depthSlotPresent', { sides: 'gotavern' }));

// 2c. MOVE THE DEPTH ENTRY ONE POSITION DEEPER. The marker is still inside the history and still the right role, so only
// the DEPTH guard can fire -- that is what makes this mutation a test of the depth arithmetic rather than of presence.
all.push(await check('move-depth-one-position', messages => {
    const depthIndex = indexOf(messages, MARKERS.depth);
    if (depthIndex <= 1) throw new Error(`the depth marker is at index ${depthIndex}, too early for this mutation`);
    const [moved] = messages.splice(depthIndex, 1);
    messages.splice(depthIndex - 1, 0, moved);
}, 'depthOffsetMatchesThePinnedMeasurement', { sides: 'gotavern' }));

// 2d. PUT THE DEPTH ENTRY INTO THE SYSTEM BLOCK. This is the "treated a depth entry as an after-slot entry" bug: the
// marker is present exactly once, at the right depth from the end of the *system* part, and only the history guard can
// see it.
all.push(await check('depth-slot-into-system-block', messages => {
    const depthIndex = indexOf(messages, MARKERS.depth);
    if (depthIndex < 0) throw new Error('the recorded body does not contain the depth marker, so this mutation cannot be applied');
    const [moved] = messages.splice(depthIndex, 1);
    const afterIndex = indexOf(messages, MARKERS.after);
    messages.splice(Math.max(afterIndex, 0), 0, moved);
}, 'depthSlotLandsInsideHistory', { sides: 'gotavern' }));

// 2e. ONE SUBJECT ONLY. This one must turn the BYTE guard red, and it proves the byte contract is live rather than
// implied by the ordering guards.
const bytePaths = {
    gotavern: path.join(outDir, 'mutated-bytes-gotavern.json'),
    pinned: path.join(outDir, 'mutated-bytes-pinned.json'),
};
{
    const mutated = rewriteBody(legs.gotavern, messages => {
        messages[0] = { ...messages[0], content: `${contentOf(messages[0])} ` };
    });
    await fs.writeFile(bytePaths.gotavern, `${JSON.stringify(mutated, null, 2)}\n`);
    await fs.writeFile(bytePaths.pinned, `${JSON.stringify(legs.pinned, null, 2)}\n`);
    const outPath = path.join(outDir, 'mutated-bytes-verdict.json');
    const run = await comparatorRun(bytePaths.gotavern, bytePaths.pinned, outPath);
    const verdict = await verdictOf(outPath);
    const ok = run.code !== 0 && (verdict.mismatches ?? []).length > 0 && (verdict.failedGuards ?? []).includes('nodeEqualsGo');
    results.push({ mutation: 'one-subject-byte-change', expectedGuard: 'nodeEqualsGo', exitCode: run.code, failedGuards: verdict.failedGuards ?? [], mismatches: (verdict.mismatches ?? []).length, ok });
    console.log(`${ok ? 'ok  ' : 'FAIL'} mutation one-subject-byte-change: exit=${run.code} failedGuards=[${(verdict.failedGuards ?? []).join(', ')}] mismatches=${(verdict.mismatches ?? []).length}`);
    all.push(ok);
}

// 3. THE ORIGINALS ARE UNTOUCHED, and the pair is still green -- the "restore" half of the demonstration, proven by bytes
// rather than by an intention.
const shasAfter = {};
for (const subject of ['gotavern', 'pinned']) {
    shasAfter[subject] = createHash('sha256').update(await fs.readFile(legPaths[subject])).digest('hex');
}
const originalsIntact = shasBefore.gotavern === shasAfter.gotavern && shasBefore.pinned === shasAfter.pinned;
const restorePath = path.join(outDir, 'restored-verdict.json');
const restoreRun = await comparatorRun(legPaths.gotavern, legPaths.pinned, restorePath);
const restoreVerdict = await verdictOf(restorePath);
const restoredGreen = restoreRun.code === 0 && restoreVerdict.verdict === 'PASS';
console.log(`${originalsIntact ? 'ok  ' : 'FAIL'} recorded legs unchanged: gotavern ${shasBefore.gotavern === shasAfter.gotavern} pinned ${shasBefore.pinned === shasAfter.pinned}`);
console.log(`${restoredGreen ? 'ok  ' : 'FAIL'} restored pair: exit=${restoreRun.code} verdict=${restoreVerdict.verdict}`);

const passed = greenOk && all.every(Boolean) && originalsIntact && restoredGreen;
console.log(`\nworldinfo-slots gate self-test: ${passed ? 'PASS' : 'FAIL'} (${results.filter(entry => entry.ok).length}/${results.length} mutations named their guard)`);
process.exit(passed ? 0 : 1);
