// A LOCAL SMOKE TEST OF THE PROBE'S ABORT PATH, WITHOUT A BROWSER.
//
// WHY: the probe's drive runs inside `page.evaluate`, where the outer `page` object does not exist. That
// mistake cost a full CI run (40307148708 failed on BOTH legs with "page.evaluate: ReferenceError: page is
// not defined") and `node --check` cannot see it. This test makes the same claims about the source in about
// a second, so the next edit of that block fails here instead of eighteen minutes into a dispatch.
//
// THE CLAIMS, each of which the source can fail:
//   1. no `page.` FOR A CALL inside a `page.evaluate` callback -- the exact defect above;
//   2. the abort observation records the keys the comparator reads (a comparator/recorder contract that has
//      already drifted once: `textAfterAbort` in the probe, `textAfterCut` in the comparator);
//   3. the abort surface never clicks a stop control (it must not measure cancellation);
//   4. the settle loop requires BOTH the frontend idle flag AND no render movement, at the tight interval;
//   5. the settle deadline is the 60 s bound this harness relies on;
//   6. the probe, the hop and the comparator all parse.
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

const driveStart = source.indexOf('const outcome = await page.evaluate(async ({ mockUrl');
assert.ok(driveStart > 0, 'the probe no longer has the drive page.evaluate call this test knows about');
const bodyStart = source.indexOf('\n', driveStart) + 1;
const driveEnd = source.indexOf('}, { mockUrl:', driveStart);
assert.ok(driveEnd > bodyStart, 'the drive body has no end marker');
// THE SLICE ENDS AT THE `page.evaluate(` CALL THAT OPENS IT, NOT AT THE ARGUMENTS AFTER ITS BODY. The first
// version read to the arguments object, which is AFTER the end of the callback, so the node-side abort
// observation block fell inside the "page body" and every legitimate `page.evaluate` there read as a defect.
// The closing is the line that both closes the object literal and ends the call (`});`).
// THE CALL CLOSES AT THE END OF THE ARGUMENTS: the line that ends the object literal and the call, i.e. the
// first ' });' after the arguments HEAD. A ' });' is also matched inside string literals of the body, so
// the search starts at the arguments head rather than inside the callback.
const callClose = source.indexOf(' });', driveEnd) + ' });'.length;
const driveBody = source.slice(bodyStart, callClose);
assert.ok(driveBody.length > 5000, `the drive body looks truncated (${driveBody.length} chars)`);

const cases = [];
const addCase = (description, check) => cases.push({ description, check });

/**
 * THE DEFECT'S OWN SHAPE: a `page.` reference INSIDE a `page.evaluate` callback. Braces are counted from the
 * callback's opening so the check follows the real nesting. The probe legitimately calls `page.evaluate(...)`
 * from node code outside any page context, which this does not flag -- only a reference reached from inside
 * a callback is unreachable at run time.
 */
// THE CALL TEXT IS ONE CONSTANT, so the slice that follows it cannot disagree with the search that found it
// (a literal length was one character too long here, and the detector silently found nothing).
const CALL = "page.evaluate(";
const pageReferencesInsideCallbacks = text => {
    const offenders = [];
    const lines = text.split(String.fromCharCode(10));
    // THE WINDOW OPENS AT `page.evaluate(` AND STAYS OPEN UNTIL `depth` returns to zero, where `depth` counts
    // braces from the FIRST `{` AFTER THE CALL. Counting from anywhere else is the bug this function had twice:
    // first it closed on the call line itself (a one-line defect passed), then it opened on the FIRST
    // `page.evaluate(` in the file and never looked at a later one. Both are fixed here and both are mutation-
    // tested below.
    let depth = 0;
    let openedAt = null;
    for (const [index, rawLine] of lines.entries()) {
        const code = rawLine.replace(/\/\/.*$/, "");
        if (openedAt === null) {
            const open = code.indexOf(CALL);
            if (open < 0) continue;
            const afterCall = code.slice(open + CALL.length);
            const firstBrace = afterCall.indexOf("{");
            if (firstBrace < 0) {
                // AN EXPRESSION-BODIED CALLBACK (`page.evaluate(() => page.keyboard)`): there is no brace, so the
                // rest of the line IS the callback and an outer use on it is reachable. The first version
                // skipped the line, which is why that shape survived its own mutation.
                if (/\bpage\s*\./.test(afterCall)) offenders.push(`inside the single-line callback at line ${index + 1}: ${rawLine.trim()}`);
                continue;
            }
            if (firstBrace < 0) continue;
            openedAt = index + 1;
            depth = balance(afterCall.slice(firstBrace));
        } else {
            if (/\bpage\s*\./.test(code)) offenders.push(`inside the callback opened at line ${openedAt}: ${index + 1}: ${rawLine.trim()}`);
            depth += balance(code);
        }
        if (openedAt !== null && depth <= 0) openedAt = null;
    }
    return [...new Set(offenders)];
};

/** Open braces minus close braces on one line, ignoring a trailing comment. */
const balance = code => {
    const stripped = code.replace(/\/\/.*$/, "");
    return (stripped.match(/\{/g) ?? []).length - (stripped.match(/\}/g) ?? []).length;
};

addCase('no `page.` reference inside a page callback (the ReferenceError of run 40307148708)', () => {
    const offenders = pageReferencesInsideCallbacks(driveBody);
    assert.deepEqual(offenders, [], `the outer page object is unreachable inside a page callback, got:\n${offenders.join('\n')}`);
    // THE COMPLEMENTARY SHAPE, and it is the one the first mutation test found surviving: a `page.` call
    // ANYWHERE between the opening of the drive and its return is equally unreachable, because the whole body
    // runs in the browser. This is broader and needs no brace counting; the nested-callback detector above is
    // kept because it names the LINE of a nested evaluate, which is what a reader needs when this rule fires.
    // fires on a legitimate `page.evaluate` that belongs to a scope this slice cannot see.
    // `page.evaluate(...)` IS EXCLUDED BY DESIGN: the abort observation block that reads the recorder runs in
    // NODE, after the settle loop, so its calls to `page.evaluate` are the legitimate ones. What is never
    // legitimate from inside the browser body is any OTHER use of the outer object -- `page.mainFrame()`,
    // `page.on(...)`, `page.keyboard` -- so the rule matches `page.` unless the member is `evaluate` itself.
    const outerUses = driveBody.split('\n')
        .map((line, index) => [index + 1, line.replace(/\/\/.*$/, '')])
        .filter(([, code]) => /\bpage\s*\.(?!evaluate\b)/.test(code))
        .map(([number, code]) => `${number}: ${code.trim()}`);
    assert.deepEqual(outerUses, [], `the drive body runs inside the browser, where the outer page object does not exist, got:\n${outerUses.join(String.fromCharCode(10))}`);
});

// AND THE CHECK CAN FAIL: run over a body that HAS the defect, it must name it. Without this the assertion
// above could be decoration.
addCase('the page-callback check itself detects a planted reference', () => {
    const planted = 'await page.evaluate(() => {\n    const x = page.mainFrame();\n});\n';
    assert.equal(pageReferencesInsideCallbacks(planted).length, 1, 'the detector did not find a page reference inside a page callback');
});

const observationStart = source.indexOf("} else if (probeMode === 'abort') {");
assert.ok(observationStart > 0, 'the probe no longer has the abort observation block this test knows about');
const observationEnd = source.indexOf('            } else {', observationStart);
assert.ok(observationEnd > observationStart, 'the abort observation block has no end marker');
const observationBody = source.slice(observationStart, observationEnd);

for (const key of ['textAfterCut', 'returnedToIdle', 'contentStatesAtCut', 'snapshotsLater', 'endedEvents']) {
    addCase(`the comparator's observable \`${key}\` is recorded by the abort branch`, () => {
        assert.ok(observationBody.includes(`streamState.${key}`), `${key} is not set in the abort branch, so the comparator would read undefined on both legs`);
    });
}
addCase('the abort branch never clicks a stop control', () => {
    assert.equal(/stopButton\.click\(|#mes_stop[^;]*\.click\(/.test(observationBody), false, 'the abort branch clicked a stop control, so cancellation and a dead network would be indistinguishable');
});

const settleStart = source.indexOf('while (performance.now() < settleDeadline) {');
const settleEnd = source.indexOf('const settledIdle', settleStart);
assert.ok(settleStart > 0 && settleEnd > settleStart, 'the probe no longer has the settle loop this test knows about');
const settleBody = source.slice(settleStart, settleEnd);

addCase('the abort settle requires the idle flag AND no render movement', () => {
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
