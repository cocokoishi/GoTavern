// DOES THE GROUP-CHAT JUDGE HAVE TEETH?
//
// AGENTS.md differential doctrine 4: after adding a gate, mutate the thing it guards, show the exact
// assertion name that went red, restore, show green. This file does that for
// compare-group-chat-legs.mjs WITHOUT a browser, a server or a pinned checkout: it loads the
// committed pinned oracle fixture, builds a synthetic GoTavern leg from it (baseline), and then
// applies the three semantic mutations the lane's acceptance requires:
//
//   1. SWAPPING TWO CHARACTERS' GENERATION ORDER   -> the request order for `manual-activation`
//   2. DROPPING ONE CHARACTER'S PROMPT             -> a missing request for `user-message-list-3`
//   3. CHANGING A MESSAGE ROLE                     -> a role field changed inside a request body
//
// plus a missing-case mutation. Each mutation must be killed BY A NAMED GUARD, and the baseline must
// pass. A comparator that cannot be made to fail here is not evidence for the equality it prints.
//
// The synthetic legs are the pinned fixture relabelled as `gotavern`: this file tests the JUDGE, not
// the product. The product differential is compare-group-chat-legs.mjs run against freshly recorded
// legs by the workflow.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const comparator = path.join(here, 'compare-group-chat-legs.mjs');
const fixturePath = path.join(here, 'fixtures', 'group-chat', 'pinned-oracle.json');

function sha256(text) {
    return createHash('sha256').update(text).digest('hex');
}

const scratch = mkdtempSync(path.join(os.tmpdir(), 'gotavern-group-teeth-'));
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8'));

// The packaged oracle fixture is two legs in one file; the comparator consumes leg files. Write
// the pinned pair once, byte-identical to what a fresh pinned recording would have produced.
const pinnedPaths = (() => {
    const fullPath = path.join(scratch, 'pinned-full.json');
    const restartPath = path.join(scratch, 'pinned-restart.json');
    writeFileSync(fullPath, JSON.stringify(fixture.legs.full));
    writeFileSync(restartPath, JSON.stringify(fixture.legs.restart));
    return { fullPath, restartPath };
})();

function clone(value) {
    return JSON.parse(JSON.stringify(value));
}

// The synthetic GoTavern legs are the pinned observation with the subject renamed. That is the
// baseline: it MUST produce a match, otherwise a red mutation would prove nothing.
function syntheticLegs() {
    const full = clone(fixture.legs.full);
    const restart = clone(fixture.legs.restart);
    for (const leg of [full, restart]) {
        leg.subject = 'gotavern';
        leg.failure = null;
        leg.pageErrors = [];
        leg.httpFailures = [];
    }
    return { full, restart };
}

function writeLegs(name, legs) {
    const fullPath = path.join(scratch, `${name}-full.json`);
    const restartPath = path.join(scratch, `${name}-restart.json`);
    writeFileSync(fullPath, JSON.stringify(legs.full));
    writeFileSync(restartPath, JSON.stringify(legs.restart));
    return { fullPath, restartPath };
}

function runComparator(name, legs, pinnedLegs = null) {
    const paths = writeLegs(name, legs);
    const pinned = pinnedLegs ? writeLegs(`${name}-pinned`, pinnedLegs) : pinnedPaths;
    const outPath = path.join(scratch, `${name}-verdict.json`);
    const result = spawnSync(process.execPath, [
        comparator,
        '--pinned-full', pinned.fullPath,
        '--gotavern-full', paths.fullPath,
        '--pinned-restart', pinned.restartPath,
        '--gotavern-restart', paths.restartPath,
        '--out', outPath,
    ], { encoding: 'utf8' });
    let parsed = null;
    try {
        parsed = JSON.parse(readFileSync(outPath, 'utf8'));
    } catch {
        parsed = null;
    }
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, verdict: parsed };
}

const failures = [];
const rows = [];
function record(name, expectedGuard, outcome) {
    const ok = outcome.verdict && outcome.verdict.failedGuards.includes(expectedGuard) && outcome.status !== 0;
    rows.push({ name, expectedGuard, red: ok, failedGuards: outcome.verdict?.failedGuards ?? null, verdict: outcome.verdict?.verdict ?? null });
    if (!ok) failures.push(`${name}: expected the named guard ${expectedGuard} to be red, got ${JSON.stringify(outcome.verdict?.failedGuards ?? null)} (exit ${outcome.status})`);
}

// --- baseline: an unmutated pair MUST pass ---------------------------------------------------
{
    const outcome = runComparator('baseline', syntheticLegs());
    const ok = outcome.status === 0 && outcome.verdict?.verdict === 'match' && (outcome.verdict.failedGuards ?? []).length === 0;
    rows.push({ name: 'baseline-match', expectedGuard: null, red: !ok, failedGuards: outcome.verdict?.failedGuards ?? null, verdict: outcome.verdict?.verdict ?? null });
    if (!ok) failures.push(`baseline: an unmutated pair did not match (${JSON.stringify(outcome.verdict?.failedGuards ?? null)}, exit ${outcome.status})`);
}

// --- mutation 1: swap two characters' generation order --------------------------------------
{
    const legs = syntheticLegs();
    const manual = legs.full.cases.find(entry => entry.name === 'manual-activation');
    if (!manual || manual.requests.length !== 2) {
        failures.push('mutation 1 could not be built: manual-activation has no pair of requests in the fixture');
    } else {
        manual.requests.reverse();
        record('mutation-1-swap-generation-order', 'full.case.manual-activation.request[0].bodySha256', runComparator('swap-order', legs));
        record('mutation-1-swap-generation-order-discriminating', 'discriminating.manual-activation-order', runComparator('swap-order-2', legs));
    }
}

// --- mutation 2: drop one character's prompt ------------------------------------------------
{
    const legs = syntheticLegs();
    const list = legs.full.cases.find(entry => entry.name === 'user-message-list-3');
    if (!list || list.requests.length !== 3) {
        failures.push('mutation 2 could not be built: user-message-list-3 has no three requests in the fixture');
    } else {
        list.requests.splice(1, 1);
        record('mutation-2-drop-character-prompt', 'full.case.user-message-list-3.requestCount', runComparator('drop-prompt', legs));
    }
}

// --- mutation 3: change a message role ------------------------------------------------------
{
    const legs = syntheticLegs();
    const list = legs.full.cases.find(entry => entry.name === 'user-message-list-3');
    const request = list?.requests?.[0] ?? null;
    let mutated = false;
    if (request) {
        const body = JSON.parse(request.bodyText);
        // EVERY assistant line becomes a user line: the group turn's name-attributed assistant
        // history is what `discriminating.roles-and-attribution` reads, so a role change that keeps
        // some assistant lines would still satisfy that guard. Mutating the whole class is the
        // honest form of "the implementation changed the role it emits".
        let changed = 0;
        for (const message of body.messages) {
            if (message.role === 'assistant') {
                message.role = 'user';
                changed += 1;
            }
        }
        if (changed > 0) {
            const text = JSON.stringify(body);
            request.bodyText = text;
            request.bodySha256 = sha256(text);
            request.bodyLength = Buffer.byteLength(text);
            mutated = true;
        }
    }
    if (!mutated) {
        failures.push('mutation 3 could not be built: no assistant role found in the first list-order request');
    } else {
        record('mutation-3-change-message-role', 'full.case.user-message-list-3.request[0].bodySha256', runComparator('role-change', legs));
        record('mutation-3-change-message-role-attribution', 'discriminating.roles-and-attribution', runComparator('role-change-2', legs));
    }
}

// --- mutation 5: a knob stops changing the request on BOTH subjects -------------------------
// This is the AGENTS.md rule 50 case: the equality half still holds (both subjects changed
// identically), but the scenario no longer distinguishes a disabled member from an enabled one, so
// the verdict must be HARNESS NON-DISCRIMINATING rather than match.
{
    const oracleLegs = { full: clone(fixture.legs.full), restart: clone(fixture.legs.restart) };
    const goLegs = syntheticLegs();
    for (const legs of [oracleLegs, goLegs]) {
        const list = legs.full.cases.find(entry => entry.name === 'user-message-list-3');
        const disabled = legs.full.cases.find(entry => entry.name === 'disabled-member');
        if (!list || !disabled) continue;
        // Keep the case NAME (the universe guard must still pass) but give it the enabled group's
        // requests and observations, on both sides.
        disabled.requests = clone(list.requests);
        disabled.steps = clone(list.steps);
    }
    const outcome = runComparator('non-discriminating', goLegs, oracleLegs);
    const ok = outcome.status !== 0
        && outcome.verdict?.verdict === 'harness-non-discriminating'
        && (outcome.verdict.failedGuards ?? []).includes('discriminating.disabled-member-excluded');
    rows.push({
        name: 'mutation-5-non-discriminating-verdict',
        expectedGuard: 'discriminating.disabled-member-excluded',
        red: ok,
        failedGuards: outcome.verdict?.failedGuards ?? null,
        verdict: outcome.verdict?.verdict ?? null,
    });
    if (!ok) failures.push(`mutation 5: expected verdict harness-non-discriminating with discriminating.disabled-member-excluded red, got ${outcome.verdict?.verdict} ${JSON.stringify(outcome.verdict?.failedGuards ?? null)}`);
}

// --- mutation 4: remove a case entirely (the absence class) ---------------------------------
{
    const legs = syntheticLegs();
    const index = legs.full.cases.findIndex(entry => entry.name === 'disabled-member');
    if (index !== -1) {
        legs.full.cases.splice(index, 1);
        record('mutation-4-missing-case', 'full.caseUniverse', runComparator('missing-case', legs));
    } else {
        failures.push('mutation 4 could not be built: disabled-member case absent from the fixture');
    }
}

const summary = {
    schemaVersion: 1,
    question: 'Can the group-chat comparator be made to fail by the mutations the lane requires?',
    fixture: 'tests/browser/fixtures/group-chat/pinned-oracle.json',
    rows,
    failures,
    verdict: failures.length === 0 ? 'teeth-proven' : 'no-teeth',
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length > 0) {
    for (const failure of failures) console.error(`::error::${failure}`);
    process.exit(1);
}
process.exit(0);
