// DOES THE TOKENIZER COMPARISON PAIR THE TWO LEGS CORRECTLY?
//
// WHY THIS FILE EXISTS. `compareTokenizers` in `compare-preset-legs.mjs` used to walk both legs' count arrays
// with ONE index, which is a derivation about the two legs having made the same number of calls in the same
// order -- and nothing asserted it. The committed artefact proved the assumption false and the diagnosis wrong:
// `preset-complex-comparison.json` records `gotavernCalls: 73` against `pinnedCalls: 67`, and its
// `firstDifference` said `index 18: pinnedCount 275, gotavernCount 225` with the note "the same message counted
// differently by the two servers". Aligning the arrays by VALUE shows that pinned's whole 67-count sequence is a
// SUBSEQUENCE of GoTavern's 73 with six calls GoTavern made that pinned never did; every common call agreed. So
// the artefact sent a reader after a counting bug in a message both servers counted identically, and hid the six
// calls that are the actual difference. A wrong diagnosis in committed evidence is a false finding, which is the
// class this repository's doctrine exists to catch.
//
// WHAT THIS PROVES. Each case builds the two legs' call lists, runs the REAL exported comparison, and requires
// the NAMED outcome. The first case is the real defect's shape, and it also runs the OLD positional logic on the
// same input to show the two disagree -- a control, because a fix that changed nothing observable would pass a
// test that only looked at the new output.
//
// Usage: node tests/browser/tokenizer-comparator-selftest.mjs
// Exit:  0 when every case behaved as required; 1 naming what was missed.

import { compareTokenizers } from './compare-preset-legs.mjs';

let failures = 0;
const check = (name, ok, detail) => {
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -- ${detail}`}`);
    if (!ok) failures++;
};

/** One recorded tokenizer call, in the shape `tokenizerCounts` produces. */
const call = (text, count, path = '/api/tokenizers/llama/encode') => ({ path, status: 200, count, requestText: text });

// -----------------------------------------------------------------------------------------------------------
// CASE 1 -- THE REAL DEFECT'S SHAPE: six extra calls on the GoTavern side, every common call agreeing.
//
// The numbers are the committed artefact's own, in the order it recorded them, with the six extras at the
// indices the subsequence alignment put them (18, 20, 21, 22, 31, 34). The messages are synthetic: the committed
// artefact stores only the counts, so the identity of each call is reconstructed as a distinct label -- which is
// exactly what the fix needs, and is why the artefact could not be checked this way before it recorded them.
const pinnedSequence = [3, 701, 190, 380, 589, 749, 750, 26, 702, 57, 13, 191, 7, 19, 20, 38, 56, 275, 380, 589, 749, 1018, 41, 987, 32, 25, 24, 25, 28, 57, 20, 26, 13, 21, 243, 247, 243, 246, 247, 20, 286, 289, 24, 28, 11, 14, 17, 25, 29, 31, 33, 35, 37, 39, 41, 43, 45, 47, 49, 51, 53, 55, 57, 59, 61, 63, 65];
const extras = [
    { at: 18, value: 225 },
    { at: 20, value: 380 },
    { at: 21, value: 589 },
    { at: 22, value: 749 },
    { at: 31, value: 57 },
    { at: 34, value: 13 },
];
const extraIndices = new Set(extras.map(entry => entry.at));
const extraByIndex = new Map(extras.map(entry => [entry.at, entry.value]));

const gotavernSequence = [];
for (let i = 0; i < pinnedSequence.length + extras.length; i++) {
    if (extraIndices.has(i)) gotavernSequence.push(extraByIndex.get(i));
    else gotavernSequence.push(pinnedSequence[i - extras.filter(e => e.at < i).length]);
}
check('case 1 fixture: GoTavern made 73 calls and pinned 67', gotavernSequence.length === 73 && pinnedSequence.length === 67,
    `${gotavernSequence.length} vs ${pinnedSequence.length}`);

// Every call is identified by its own text, so the extras are keys pinned never produced and every common key
// agrees. This is the state the committed artefact's data actually describes.
const pinnedCalls = pinnedSequence.map((count, i) => call(`pinned-message-${i}`, count));
const gotavernCalls = [];
{
    let pinnedIndex = 0;
    for (let i = 0; i < gotavernSequence.length; i++) {
        if (extraIndices.has(i)) {
            gotavernCalls.push(call(`gotavern-only-message-${i}`, gotavernSequence[i]));
        } else {
            gotavernCalls.push(call(`pinned-message-${pinnedIndex}`, gotavernSequence[i]));
            pinnedIndex++;
        }
    }
}

const real = compareTokenizers(gotavernCalls, pinnedCalls);
check('case 1: the comparison is NOT equal (six calls differ, so a difference is real)', real.equal === false,
    JSON.stringify(real).slice(0, 200));
check('case 1: the six extras are named as extra-on-GoTavern', real.extraOnGotavern.length === 6,
    `extraOnGotavern = ${JSON.stringify(real.extraOnGotavern).slice(0, 200)}`);
check('case 1: NO per-message disagreement is claimed', real.perMessageDifferences.length === 0,
    `perMessageDifferences = ${JSON.stringify(real.perMessageDifferences).slice(0, 200)}`);
check('case 1: nothing is claimed missing on the pinned side', real.missingOnPinned.length === 0,
    JSON.stringify(real.missingOnPinned).slice(0, 200));
check('case 1: the first difference says EXTRA, not "counted differently"',
    typeof real.firstDifference?.note === 'string' && /pinned did not make/.test(real.firstDifference.note),
    JSON.stringify(real.firstDifference));
check('case 1: the first difference no longer reports a positional index', real.firstDifference?.index === undefined,
    JSON.stringify(real.firstDifference));

// THE CONTROL: the old positional walk on the same input reports the WRONG thing, so the two disagree. Without
// this, a "fix" that produced the same output as before would pass every assertion above except by luck.
const positional = (mine, theirs) => {
    for (let index = 0; index < Math.max(mine.length, theirs.length); index++) {
        if (!mine[index] || !theirs[index]) return { note: 'different call counts' };
        if (mine[index].count !== theirs[index].count) return { note: 'the same message counted differently by the two servers; the pinned count is the oracle' };
    }
    return null;
};
const old = positional(gotavernCalls, pinnedCalls);
check('case 1 control: the OLD positional walk reports "counted differently" on this input',
    old !== null && /counted differently/.test(old.note), JSON.stringify(old));
check('case 1 control: the old and new diagnoses therefore DISAGREE',
    old.note !== real.firstDifference.note, 'they agree, so the case cannot discriminate');

// -----------------------------------------------------------------------------------------------------------
// CASE 2 -- A REAL PER-MESSAGE DISAGREEMENT IS STILL CAUGHT, and named with its request.
const sameText = compareTokenizers([call('shared', 11)], [call('shared', 7)]);
check('case 2: a per-message disagreement is not equal', sameText.equal === false, JSON.stringify(sameText));
check('case 2: it is named as a per-message difference with both counts',
    sameText.perMessageDifferences.length === 1
    && sameText.perMessageDifferences[0].gotavernCount === 11
    && sameText.perMessageDifferences[0].pinnedCount === 7,
    JSON.stringify(sameText.perMessageDifferences));
check('case 2: the first difference keeps the pinned-is-the-oracle note',
    /pinned count is the oracle/.test(sameText.firstDifference?.note ?? ''), JSON.stringify(sameText.firstDifference));

// -----------------------------------------------------------------------------------------------------------
// CASE 3 -- A CALL PINNED MADE AND GOTAVERN DID NOT.
const missing = compareTokenizers([call('a', 1)], [call('a', 1), call('b', 2)]);
check('case 3: a pinned-only call is named as missing, not as a count disagreement',
    missing.missingOnPinned.length === 1 && missing.perMessageDifferences.length === 0 && missing.extraOnGotavern.length === 0,
    JSON.stringify(missing));

// -----------------------------------------------------------------------------------------------------------
// CASE 4 -- THE SAME REQUEST COUNTED TWICE ON ONE SIDE IS A PER-KEY COUNT DIFFERENCE, not an extra key.
const repeated = compareTokenizers([call('dup', 5), call('dup', 6)], [call('dup', 5)]);
check('case 4: a key counted more often on GoTavern is a per-message difference naming the multiplicity',
    repeated.perMessageDifferences.length === 1
    && /counted 2 time\(s\) on GoTavern and 1 time\(s\) on pinned/.test(repeated.perMessageDifferences[0].note ?? ''),
    JSON.stringify(repeated.perMessageDifferences));
check('case 4: it is NOT reported as an extra key', repeated.extraOnGotavern.length === 0, JSON.stringify(repeated.extraOnGotavern));

// -----------------------------------------------------------------------------------------------------------
// CASE 5 -- AN EMPTY COMPARISON IS NOT AGREEMENT (rule 19). Two legs that share no request compared nothing.
const disjoint = compareTokenizers([call('only-gotavern', 1)], [call('only-pinned', 2)]);
check('case 5: no shared request is UNMEASURABLE, not equal', disjoint.equal === false && typeof disjoint.unmeasurable === 'string',
    JSON.stringify(disjoint).slice(0, 200));
check('case 5: the reason names the shared-key count', disjoint.commonKeys === 0, `commonKeys = ${disjoint.commonKeys}`);

// -----------------------------------------------------------------------------------------------------------
// CASE 6 -- THE ORDINARY GREEN PATH, so the guard is not simply always red.
const identical = compareTokenizers([call('a', 3), call('b', 4)], [call('b', 4), call('a', 3)]);
check('case 6: identical multisets are equal regardless of order', identical.equal === true && identical.firstDifference === null,
    JSON.stringify(identical).slice(0, 200));

// -----------------------------------------------------------------------------------------------------------
// NEGATIVE CONTROL: the selftest itself can fail. A comparison that reported "equal" for case 1's input must be
// caught, or every assertion above is decoration.
const brokenVerdict = { ...real, equal: true };
check('negative control: a wrong "equal" verdict is detectable', brokenVerdict.equal !== real.equal,
    'the control cannot discriminate');

console.log(`\ntokenizer comparator self-test: ${failures === 0 ? 'all cases behaved as required' : `${failures} case(s) FAILED`}`);
if (failures > 0) process.exitCode = 1;
