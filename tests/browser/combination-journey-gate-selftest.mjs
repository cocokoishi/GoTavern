// TEETH FOR THE COMBINATION-JOURNEY COMPARATOR.
//
// A comparator that can return `match` is only evidence if it can return `mismatch`, and AGENTS 4 requires the red
// to be OBSERVED and NAMED. Each case below mutates the legs' OWN artefacts in memory (never on disk, AGENTS 57),
// requires its TARGET GUARD TO BE GREEN in the unmutated pair first, then requires that same guard to go RED.
//
// The per-guard precondition is deliberate. On a journey leg with an unrelated red step, a whole-baseline rule
// would refuse to demonstrate any teeth; checking only the guard a mutation targets keeps each case honest without
// weakening the other guards.
//
// The five mutations:
//   1. the armed turn loses a world-info slot        -> a world-book entry silently not reaching the model
//   2. the armed turn loses the preset pieces        -> preset selection becoming a no-op
//   3. the armed turn loses the variable scopes      -> helper variables not reaching the model
//   4. one subject stops capturing a turn            -> a subject that never sent the request its pair sent
//   5. the durable chat loses its journey messages   -> a request that renders but never persists
//
// Usage: node tests/browser/combination-journey-gate-selftest.mjs <go-drive.json> <pinned-drive.json>

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { compareCombinationJourney } from './compare-combination-journey.mjs';

const clone = value => JSON.parse(JSON.stringify(value));
const args = process.argv.slice(2).filter(entry => entry !== '--json');
if (args.length !== 2) {
    console.error('usage: node combination-journey-gate-selftest.mjs <go-drive.json> <pinned-drive.json>');
    process.exit(2);
}
const live = { go: JSON.parse(fs.readFileSync(path.resolve(args[0]), 'utf8')), pinned: JSON.parse(fs.readFileSync(path.resolve(args[1]), 'utf8')) };
const judge = legs => compareCombinationJourney({ goDrive: clone(legs.go), pinnedDrive: clone(legs.pinned) });

const cases = [];
const record = (name, ok, detail) => {
    cases.push({ name, ok, detail });
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -- ${JSON.stringify(detail).slice(0, 800)}`}`);
};

const setStep = (report, name, ok) => {
    const step = (report.steps ?? []).find(entry => entry.name === name);
    if (!step) throw new Error(`the leg has no step ${JSON.stringify(name)} to mutate`);
    step.ok = ok;
    step.detail = { mutated: true };
};

function mutation(name, targetGuard, mutate) {
    const baseline = judge(live);
    const guardWasGreen = baseline.guards[targetGuard] === true;
    const legs = { go: clone(live.go), pinned: clone(live.pinned) };
    mutate(legs);
    const mutated = judge(legs);
    const guardWentRed = mutated.guards[targetGuard] === false;
    record(name, guardWasGreen && guardWentRed, {
        targetGuard,
        baselineGuard: baseline.guards[targetGuard],
        mutatedGuard: mutated.guards[targetGuard],
        failedGuards: mutated.failedGuards.slice(0, 10),
    });
}

mutation('THE-QUICK-REPLY-INJECTION-IS-DROPPED goes RED by turn-1-quick-reply-in-request',
    'turn-1-quick-reply-in-request',
    legs => setStep(legs.go, 'turn-1-quick-reply-in-request', false));

// 1b. THE WORLD-INFO SLOT DROP IS RECORDED BUT NOT DEMONSTRATED HERE (see the comment in the docs).
// 2. THE QUICK REPLY INJECTION DISAPPEARS (The world-info slot is an even better target,
// but it is already red in this pair because the pinned leg's pre-boot selection write did not survive the pinned
// boot; a mutation of an already-red guard could not demonstrate anything, so it is recorded in
// docs/combination-journey.md instead of being dressed up as a demonstrated red.)

// 2. THE COMPLEX PRESET BECOMES A NO-OP.
mutation('THE-PRESET-PIECES-VANISH goes RED by turn-1-preset-pieces-in-request',
    'turn-1-preset-pieces-in-request',
    legs => setStep(legs.pinned, 'turn-1-preset-pieces-in-request', false));

// 3. THE VARIABLE SCOPES VANISH.
mutation('THE-VARIABLES-VANISH goes RED by turn-1-variables-in-request',
    'turn-1-variables-in-request',
    legs => setStep(legs.pinned, 'turn-1-variables-in-request', false));

// 4. ONE SUBJECT STOPS CAPTURING A TURN.
mutation('A-SUBJECT-MISSES-A-TURN goes RED by both-subjects-captured-the-same-turns',
    'both-subjects-captured-the-same-turns',
    legs => {
        const kept = (legs.pinned.requests ?? []).filter(entry => entry.case !== 'turn-2-after-regex');
        if (kept.length === (legs.pinned.requests ?? []).length) throw new Error('the pinned leg has no turn-2-after-regex capture to remove');
        legs.pinned.requests = kept;
    });

// 5. THE DURABLE CHAT LOSES ITS JOURNEY MESSAGES.
mutation('THE-DURABLE-CHAT-IS-EMPTIED goes RED by both-subjects-wrote-a-journey-chat',
    'both-subjects-wrote-a-journey-chat',
    legs => {
        const projection = legs.go.disk?.projection ?? null;
        if (!projection) throw new Error('the GoTavern leg has no disk projection to mutate');
        for (const file of Object.values(projection)) file.messages = [];
    });

const failed = cases.filter(entry => entry.ok !== true);
console.log(`[selftest] ${cases.length - failed.length}/${cases.length} mutation(s) produced their NAMED red`);
if (failed.length > 0) {
    console.error(`[selftest] NOT DEMONSTRATED: ${failed.map(entry => entry.name).join(', ')}`);
    process.exit(1);
}
