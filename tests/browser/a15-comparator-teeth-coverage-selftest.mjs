// DO THE COMPARATOR SELF-TESTS COVER THE GUARDS THEY CLAIM TO COVER? (F15 in docs/verifier-audit.md)
//
// The audit's F15 was OPEN at this HEAD: `streaming-framing-selftest.mjs` printed "every guard the framing
// comparator names can fail" while three guards were named in no case, and `regex-gate-selftest.mjs`
// targeted 12 of the regex comparator's 17 guards. The general fix is not "add the missing cases once" --
// it is to COMPUTE the coverage from the comparator source, so a guard added later cannot escape the teeth
// proof while the self-test still reports success. The two self-tests now do that at their own exit; this
// file proves the coverage arithmetic itself, cheaply and without legs, and adds the mutations that show
// each overclaim guard can fail.
//
// WHAT IT ASSERTS:
//   1. every `guard('name', ...)` in the framing comparator is named as an expected guard by a framing
//      self-test case (and the framing self-test exits 0);
//   2. every `guard('name', ...)` in the regex comparator is targeted by a regex self-test mutation
//      (`expectedGuards` or `anyOfGuards`), and the self-test carries its own coverage assertion;
//   3. `compareTokenizers` is exercised by `tokenizer-comparator-selftest.mjs` and that selftest names the
//      three outcomes the comparator can report (perMessageDifferences / extraOnGotavern / missingOnPinned);
//   4. a self-test whose footer claims "every guard" must carry a coverage computation; today the preset
//      footer claims only its mutation count, and this file refuses a future overclaim.
//
// MUTATIONS. Each check is applied to a TEMP COPY with one guard/section removed or added, and the copy must
// be reported as a finding naming the missing/extra guard. No committed file is touched.
//
// Run: node tests/browser/a15-comparator-teeth-coverage-selftest.mjs

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

const read = file => readFileSync(path.join(here, file), 'utf8');
const guardNames = source => [...source.matchAll(/guard\('([A-Za-z0-9_]+)'/g)].map(match => match[1]);

/** Framing: every comparator guard must be an expected guard of some self-test case. */
function framingCoverage(comparatorSource, selftestSource) {
    const named = guardNames(comparatorSource);
    const exercised = new Set([...selftestSource.matchAll(/surface: '[a-z]+', name: '([A-Za-z0-9_]+)'/g)].map(match => match[1]));
    const uncovered = named.filter(name => !exercised.has(name));
    return { named, uncovered, problems: uncovered.map(name => `the framing comparator names ${name}, which no self-test case exercises`) };
}

/** Regex: every comparator guard must be targeted by a mutation's expected/anyOf list. */
function regexCoverage(comparatorSource, selftestSource) {
    const named = guardNames(comparatorSource);
    const targeted = new Set([...selftestSource.matchAll(/(?:expectedGuards|anyOfGuards): \[([^\]]*)\]/g)]
        .flatMap(match => [...match[1].matchAll(/'([^']+)'/g)].map(inner => inner[1])));
    const uncovered = named.filter(name => !targeted.has(name));
    const problems = uncovered.map(name => `the regex comparator names ${name}, which no mutation targets`);
    if (!selftestSource.includes('guard coverage')) problems.push('the regex self-test has no guard-coverage assertion, so a future guard escapes the mutation list silently');
    return { named, uncovered, problems };
}

/** A footer that claims "every guard" must carry a coverage computation; otherwise it is an overclaim. */
function footerOverclaimProblems(selftestSource, label) {
    const problems = [];
    if (/"every guard/i.test(selftestSource) || /every guard the/i.test(selftestSource)) {
        const computesCoverage = /guard coverage|namedGuards|guardNames|matchAll\(\/guard\(/i.test(selftestSource);
        if (!computesCoverage) problems.push(`${label} claims "every guard" in its output but computes no coverage, so the claim cannot fail`);
    }
    return problems;
}

const cases = [];
const addCase = (description, run) => cases.push({ description, run });
const expectFinding = (description, problems, needle) => {
    assert.ok(problems.some(problem => problem.includes(needle)), `${description}: expected a finding naming ${JSON.stringify(needle)}; got ${JSON.stringify(problems)}`);
};

const framingComparator = read('compare-streaming-framing.mjs');
const framingSelftest = read('streaming-framing-selftest.mjs');
const regexComparator = read('compare-regex-legs.mjs');
const regexSelftest = read('regex-gate-selftest.mjs');

addCase('every framing comparator guard is exercised by a framing self-test case', () => {
    const { named, uncovered } = framingCoverage(framingComparator, framingSelftest);
    assert.deepEqual(uncovered, [], `uncovered framing guards: ${uncovered.join(', ')}`);
    assert.ok(named.length >= 30, `expected the framing comparator's guard set; found ${named.length}`);
});

addCase('every regex comparator guard is targeted by a regex self-test mutation', () => {
    const { named, uncovered } = regexCoverage(regexComparator, regexSelftest);
    assert.deepEqual(uncovered, [], `uncovered regex guards: ${uncovered.join(', ')}`);
    assert.ok(named.length >= 17, `expected the regex comparator's guard set; found ${named.length}`);
});

addCase('compareTokenizers is exercised, and its three outcomes are named by the tokenizer self-test', () => {
    const comparator = read('compare-preset-legs.mjs');
    const tokenizerSelftest = read('tokenizer-comparator-selftest.mjs');
    assert.ok(/export function compareTokenizers/.test(comparator), 'compareTokenizers is no longer exported');
    assert.ok(/import \{ compareTokenizers \}/.test(tokenizerSelftest), 'the tokenizer self-test no longer imports the real comparator');
    for (const outcome of ['perMessageDifferences', 'extraOnGotavern', 'missingOnPinned']) {
        assert.ok(tokenizerSelftest.includes(outcome), `the tokenizer self-test does not name the ${outcome} outcome`);
    }
});

addCase('a self-test footer may claim "every guard" only when it computes coverage', () => {
    assert.deepEqual(footerOverclaimProblems(framingSelftest, 'framing self-test'), [], 'the framing footer must be backed by a coverage computation');
    assert.deepEqual(footerOverclaimProblems(regexSelftest, 'regex self-test'), [], 'the regex self-test must not overclaim');
    // The preset self-test claims only its mutation count, so it is allowed to say "5 mutations caught".
    assert.deepEqual(footerOverclaimProblems(read('preset-gate-selftest.mjs'), 'preset self-test'), []);
    // A synthetic overclaim must be caught.
    expectFinding('synthetic overclaim', footerOverclaimProblems('console.log("every guard can fail")', 'synthetic'), 'computes no coverage');
});

// ---- negative controls on temp copies: the coverage arithmetic must report the mutation ---------------
const scratch = mkdtempSync(path.join(os.tmpdir(), 'a15-teeth-coverage-'));
const copy = (name, text) => {
    const file = path.join(scratch, name);
    writeFileSync(file, text);
    return file;
};
const mutations = [
    {
        description: 'a guard added to the framing comparator with no case is reported',
        check: () => framingCoverage(`${framingComparator}\nguard('a15UncoveredGuard', 'synthetic', true);\n`, framingSelftest),
        needle: 'a15UncoveredGuard',
    },
    {
        description: 'a guard added to the regex comparator with no mutation is reported',
        check: () => regexCoverage(`${regexComparator}\nguard('a15UncoveredRegexGuard', () => []);\n`, regexSelftest),
        needle: 'a15UncoveredRegexGuard',
    },
    {
        description: 'a regex self-test whose coverage assertion was deleted is reported',
        check: () => regexCoverage(regexComparator, regexSelftest.replace('guard coverage', 'removed coverage wording')),
        needle: 'no guard-coverage assertion',
    },
    {
        description: 'a tokenizer self-test that stopped naming an outcome is reported',
        check: () => {
            const tokenizerSelftest = read('tokenizer-comparator-selftest.mjs').replaceAll('extraOnGotavern', 'renamed');
            return { problems: ['extraOnGotavern', 'perMessageDifferences', 'missingOnPinned'].filter(outcome => !tokenizerSelftest.includes(outcome)).map(outcome => `does not name ${outcome}`) };
        },
        needle: 'extraOnGotavern',
    },
];
for (const mutation of mutations) {
    const result = mutation.check();
    const problems = result.problems ?? result;
    if (!problems.some(problem => problem.includes(mutation.needle))) {
        console.error(`FAIL  ${mutation.description}: got ${JSON.stringify(problems)}`);
        process.exitCode = 1;
    } else {
        console.log(`ok    ${mutation.description}`);
    }
}
rmSync(scratch, { recursive: true, force: true });

// ---- the framing self-test itself must exit 0 (it now computes its own coverage) ----------------------
const framingRun = spawnSync(process.execPath, [path.join(here, 'streaming-framing-selftest.mjs')], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
if (framingRun.status !== 0) {
    console.error(`FAIL  the framing self-test must be green; got exit ${framingRun.status}: ${String(framingRun.stderr ?? '').slice(-800)}`);
    process.exitCode = 1;
} else {
    console.log('ok    the framing self-test is green and reports its guard coverage');
}

let failures = 0;
for (const testCase of cases) {
    try {
        testCase.run();
        console.log(`ok    ${testCase.description}`);
    } catch (error) {
        failures += 1;
        console.error(`FAIL  ${String(error.message ?? error)}`);
    }
}

if (failures > 0 || process.exitCode === 1) {
    console.error(`\n${failures} of ${cases.length} teeth-coverage cases are wrong; the self-tests' coverage claim is not backed by a computation`);
    process.exit(1);
}
console.log(`\n${cases.length} coverage checks + ${mutations.length} mutation(s): every comparator guard the self-tests claim to exercise is computed from the comparator source`);
