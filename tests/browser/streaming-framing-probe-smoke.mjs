// A LOCAL SMOKE TEST OF THE PROBE'S ABORT PATH, WITHOUT A BROWSER.
//
// WHY: the probe's drive runs inside `page.evaluate`, where the outer `page`, `document` and `window` do not
// exist. That mistake cost two full CI runs -- 40307148708 and 40310223649 both failed on BOTH legs with
// "page.evaluate: ReferenceError: page is not defined" -- and `node --check` cannot see it. This test makes
// the same claims about the source in about a second, so the next edit of that block fails here instead of
// eighteen minutes into a dispatch.
//
// WHAT IT CHECKS, each of which the source can fail:
//   1. no node-only global (`page`, `document`, `window`) is used inside the drive callback. The callback's
//      extent is the drive call's own argument list, computed on source with strings and comments removed,
//      because a brace count over the raw text is defeated by template literals -- which is how the same
//      defect survived its first fix.
//   2. the abort observations live OUTSIDE that callback and record the keys the comparator reads. That
//      contract has already drifted once (`textAfterAbort` in the probe against `textAfterCut` in the
//      comparator), so it is asserted by name.
//   3. the abort observation never clicks a stop control: this surface must not measure cancellation.
//   4. the settle loop requires BOTH the frontend idle flag AND a still render count, at the tight interval,
//      under the 60 s bound.
//   5. the probe, the hop and the comparator all parse.
//
// The scan is paired with a mutation performed BY THE TEST ITSELF, so a checker that cannot fail is caught
// here rather than trusted.
//
// Run: node tests/browser/streaming-framing-probe-smoke.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = readFileSync(path.join(here, 'generation-probe.mjs'), 'utf8');

const cases = [];
const addCase = (description, check) => cases.push({ description, check });

/** Removes comments and string/template contents, so punctuation can be counted on code alone. */
const stripLiterals = text => {
    let out = '';
    let mode = null;
    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];
        const next = text[index + 1];
        if (mode === null) {
            if (character === '/' && next === '/') { mode = 'line'; index += 1; continue; }
            if (character === "'" || character === '"' || character === '`') { mode = character; out += ' '; continue; }
            out += character;
            continue;
        }
        if (mode === 'line') {
            if (character === '\n') { mode = null; out += '\n'; }
            continue;
        }
        if (character === '\\') { index += 1; continue; }
        if (character === mode) { mode = null; out += ' '; }
    }
    return out;
};

// ONLY THE OUTER HANDLES: `page` is the Playwright object, and `process` / `require` are node-only.
// `document`, `window` and `performance` exist INSIDE the page and the drive uses them legitimately.
const outerHandleUses = lines => lines.flatMap(({ number, code }) => ['page', 'process', 'require']
    .filter(name => new RegExp('\\b' + name + '\\s*\\.').test(code))
    .map(name => `line ${number}: ${code.trim()}`));

/**
 * The CODE lines of the drive callback, with comments and string contents removed. Working line by line keeps a
 * line NUMBER in the report, and it means a word inside a comment -- an earlier version flagged the noun
 * "process" in a remark about the generating variable -- cannot be mistaken for a call.
 */
const driveCallbackCode = () => {
    const lines = source.split('\n');
    const start = lines.findIndex(line => line.includes('const outcome = await page.evaluate('));
    assert.ok(start >= 0, 'the probe no longer has the drive page.evaluate call this test knows about');
    const collected = [];
    let depth = 0;
    let opened = false;
    for (let index = start; index < lines.length; index += 1) {
        const stripped = stripLiterals(lines[index]);
        collected.push({ number: index + 1, code: stripped });
        for (const character of stripped) {
            if (character === '{' || character === '(') { depth += 1; opened = true; }
            else if (character === '}' || character === ')') depth -= 1;
        }
        // THE CALLBACK ENDS WHERE ITS ARGUMENT LIST CLOSES, after it has opened at least once.
        if (opened && depth <= 0) break;
    }
    assert.ok(collected.length > 10, `the drive callback slice looks wrong (${collected.length} line(s))`);
    return collected;
};

addCase('no outer handle (page, process, require) is used inside the drive callback', () => {
    // THE CALL LINE AND THE ARGUMENT OBJECT ARE NODE-SIDE BY CONSTRUCTION: the first opens the call with
    // `page.evaluate(` and passes `process.env` in the object AFTER the callback. Only lines strictly between
    // them run in the browser.
    const lines = driveCallbackCode();
    const first = lines[0];
    const last = lines[lines.length - 1];
    const inner = lines.slice(1, Math.max(1, lines.length - 1));
    assert.ok(/page\.evaluate\(/.test(first.code), 'the drive slice does not start at the drive call');
    assert.ok(/process\.env/.test(last.code) || /\}\);/.test(last.code), 'the drive slice does not end at its argument object');
    const offenders = outerHandleUses(inner);
    assert.deepEqual(offenders, [], `the Playwright page handle and the node globals are unreachable inside a page callback, got: ${offenders.join(', ')}`);
});

// THE CHECKER MUST BE ABLE TO FAIL, and it must not flag what is legitimate.
addCase('the scan detects a planted outer-handle use and ignores a frontend call', () => {
    assert.equal(outerHandleUses([{ number: 1, code: '(async () => { const x = await page.evaluate(() => 1); })' }]).length, 1,
        'the scan did not see a planted page.evaluate');
    assert.equal(outerHandleUses([{ number: 1, code: '(async () => { const d = document.querySelector("#x"); })' }]).length, 0,
        'the scan flagged document, which exists inside the page');
});

const abortBlocks = [...source.matchAll(/^ {4}if \(probeMode === .abort.\) \{/gm)].map(match => match.index);
assert.ok(abortBlocks.length > 0, 'the probe no longer has a node-side abort observation block');
const observationStart = abortBlocks[abortBlocks.length - 1];
const observationEnd = source.indexOf('\n    }', observationStart);
assert.ok(observationEnd > observationStart, 'the abort observation block has no end marker');
const observationBody = source.slice(observationStart, observationEnd);
// IT MUST BE OUTSIDE THE DRIVE. A block that lives inside the callback compiles and fails in a browser, which
// is the defect this file exists for; the drive's argument object ends before the node-side block.
assert.ok(observationStart > source.indexOf('presetContextOverride: Number.isInteger'),
    'the abort observation block is still inside the drive callback');

for (const key of ['textAfterCut', 'returnedToIdle', 'contentStatesAtCut', 'snapshotsLater', 'endedEvents']) {
    addCase(`the comparator's observable \`${key}\` is recorded by the abort observation`, () => {
        // A MEMBER OF THE OBJECT ASSIGNED TO report.streamState, not a `streamState.x = ...` statement: this
        // block builds the object in node, so a test looking for the statement shape checks the wrong thing.
        assert.ok(new RegExp('\n {12}' + key + ':').test(observationBody),
            `${key} is not recorded by the abort observation, so the comparator would read undefined on both legs`);
    });
}
addCase('the abort observation never clicks a stop control', () => {
    assert.equal(/stopButton\.click\(|#mes_stop[^;]*\.click\(/.test(observationBody), false,
        'the observation clicked a stop control, so cancellation and a dead network would be indistinguishable');
});

const settleStart = source.indexOf('while (performance.now() < settleDeadline) {');
const settleEnd = source.indexOf('const settledIdle', settleStart);
assert.ok(settleStart > 0 && settleEnd > settleStart, 'the probe no longer has the settle loop this test knows about');
const settleBody = source.slice(settleStart, settleEnd);
addCase('the abort settle requires the idle flag AND a still render count', () => {
    assert.ok(/quietState\.renderStates !== quietSinceRenderChange/.test(settleBody), 'the settle loop does not compare the render count, so a gap between frames would end the window');
    assert.ok(/quietState\.isGenerating/.test(settleBody), 'the settle loop does not read the frontend idle flag');
    assert.ok(/setTimeout\(resolve, 50\)/.test(settleBody), 'the settle loop does not poll at the tight interval the abort surface needs');
});
addCase('the settle loop is bounded at 60 s', () => {
    assert.ok(/const settleDeadline = settleStarted \+ 60000;/.test(source), 'the settle deadline is not the 60 s bound this harness relies on');
});
addCase('the probe, the hop and the comparator all parse', () => {
    for (const file of ['generation-probe.mjs', 'streaming-framing.mjs', 'compare-streaming-framing.mjs']) {
        const result = spawnSync(process.execPath, ['--check', path.join(here, file)], { encoding: 'utf8' });
        assert.equal(result.status, 0, `${file} does not parse: ${result.stderr}`);
    }
});

let failures = 0;
for (const testCase of cases) {
    try {
        testCase.check();
        console.log(`ok    ${testCase.description}`);
    } catch (error) {
        failures += 1;
        console.error(`FAIL  ${testCase.description}: ${String(error.message ?? error)}`);
    }
}
if (failures > 0) {
    console.error(`${failures} of ${cases.length} probe-smoke checks are wrong`);
    process.exit(1);
}
console.log(`${cases.length} checks: the drive stays out of the outer scope and the abort observations are the keys the comparator reads`);
