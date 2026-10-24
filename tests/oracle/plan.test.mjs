// THE ORACLE PLANNER'S OWN GATE.
//
// Every case here is a rule the previous selection logic encoded in YAML, plus the rules it could not
// encode at all (a Go change, a change to a repository Go helper, an unresolved path). The assertions
// are on the JSON plan, not on prose, because the plan is what `.github/workflows/ci.yml` reads.
//
// These tests never run a probe, never touch the network, and never invoke
// `tools/build-generated-lib.mjs`. `node --test tests/oracle/` is the whole cost.

import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    buildManifest,
    createManifest,
    deriveInputs,
    parseDeclarations,
    repositoryRootDefault,
    validate,
} from '../../tools/oracle/manifest.mjs';
import {
    exitCodeFor,
    finalizePlan,
    plan,
    planRepository,
    resolveRequested,
} from '../../tools/oracle/plan.mjs';

const repositoryRoot = repositoryRootDefault ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// ------------------------------------------------------------------------------------------------
// Synthetic manifest. Small enough that an expected set can be written by hand, which is the only
// kind of fixture a selection rule can be tested against: on the real graph every assertion would be
// "whatever the code says", i.e. a check whose two sides come from the same source.
// ------------------------------------------------------------------------------------------------

function syntheticManifest({
    extraEntries = [],
    scripts = ['probe-alpha.mjs', 'probe-beta.mjs'],
    fixtures = ['sillytavern-1.19.0-alpha.json', 'sillytavern-1.19.0-beta.json'],
    classifications = new Map(),
    sharedFixtures = new Map(),
    skippedDeclarationLines = [],
    unknownDeclarationFields = [],
} = {}) {
    const entries = [
        {
            probe: 'alpha',
            script: 'probe-alpha.mjs',
            fixture: 'sillytavern-1.19.0-alpha.json',
            label: 'alpha',
            args: [],
            sharedWrite: false,
            inputs: ['tools/probe-alpha.mjs'],
            resolution: 'derived',
            goProduct: false,
        },
        {
            probe: 'beta',
            script: 'probe-beta.mjs',
            fixture: 'sillytavern-1.19.0-beta.json',
            label: 'beta',
            args: [],
            sharedWrite: false,
            inputs: ['tools/probe-beta.mjs', 'tools/helper/', 'go-product'],
            resolution: 'derived',
            goProduct: true,
        },
        ...extraEntries,
    ];
    return createManifest({
        repositoryRoot: '/synthetic',
        scripts,
        fixtures,
        entries,
        classifications,
        sharedFixtures,
        skippedDeclarationLines,
        unknownDeclarationFields,
    });
}

function decide(manifest, { runType = 'push', changed = [], requested = [], manifestErrors = [] } = {}) {
    return plan({ manifest, manifestErrors, runType, changed, requested });
}

// ------------------------------------------------------------------------------------------------
// 1. The plan shape and the run-type rules.
// ------------------------------------------------------------------------------------------------

test('the plan has exactly the fields the workflow reads', () => {
    const decision = decide(syntheticManifest(), { runType: 'schedule' });
    assert.deepEqual(Object.keys(decision), [
        'recordPinned', 'full', 'probes', 'reason', 'stabilityMode', 'failClosed', 'changed', 'errors',
    ]);
    assert.equal(typeof decision.recordPinned, 'boolean');
    assert.equal(typeof decision.full, 'boolean');
    assert.ok(Array.isArray(decision.probes));
    assert.ok(Array.isArray(decision.reason));
    assert.equal(decision.stabilityMode, 'double');
    assert.equal(typeof decision.failClosed, 'boolean');
    assert.deepEqual(decision.errors, []);
});

const runTypeCases = [
    {
        name: 'schedule is a full sweep with the stability pass',
        options: { runType: 'schedule' },
        expected: { recordPinned: true, full: true, probes: [], stabilityMode: 'double', failClosed: false },
    },
    {
        name: 'dispatch with no probe list is a requested full sweep',
        options: { runType: 'dispatch', requested: [] },
        expected: { recordPinned: true, full: true, probes: [], stabilityMode: 'double', failClosed: false },
    },
    {
        name: 'dispatch naming one script narrows to it',
        options: { runType: 'dispatch', requested: ['probe-beta.mjs'] },
        expected: { recordPinned: true, full: false, probes: ['probe-beta.mjs'], stabilityMode: 'single', failClosed: false },
    },
    {
        name: 'dispatch accepts a probe id',
        options: { runType: 'dispatch', requested: ['alpha'] },
        expected: { recordPinned: true, full: false, probes: ['probe-alpha.mjs'], stabilityMode: 'single', failClosed: false },
    },
    {
        name: 'dispatch accepts a fixture name',
        options: { runType: 'dispatch', requested: ['sillytavern-1.19.0-beta.json'] },
        expected: { recordPinned: true, full: false, probes: ['probe-beta.mjs'], stabilityMode: 'single', failClosed: false },
    },
    {
        name: 'an unknown run type is refused, not guessed',
        options: { runType: 'nightly' },
        expected: { recordPinned: true, full: true, stabilityMode: 'double', failClosed: true, errorCode: 'unknown-run-type' },
    },
];

for (const testCase of runTypeCases) {
    test(`run type: ${testCase.name}`, () => {
        const decision = decide(syntheticManifest(), testCase.options);
        assert.equal(decision.recordPinned, testCase.expected.recordPinned);
        assert.equal(decision.full, testCase.expected.full);
        assert.deepEqual(decision.probes, testCase.expected.probes ?? decision.probes);
        assert.equal(decision.stabilityMode, testCase.expected.stabilityMode);
        assert.equal(decision.failClosed, testCase.expected.failClosed);
        if (testCase.expected.errorCode) {
            assert.ok(decision.errors.some(entry => entry.code === testCase.expected.errorCode),
                `expected ${testCase.expected.errorCode}, got ${JSON.stringify(decision.errors)}`);
            assert.equal(exitCodeFor(decision), 1);
        } else {
            assert.deepEqual(decision.errors, []);
            assert.equal(exitCodeFor(decision), 0);
        }
    });
}

test('an unknown requested probe is a hard error, never an empty selection', () => {
    const decision = decide(syntheticManifest(), { runType: 'dispatch', requested: ['probe-alpha.mjs', 'probe-nope.mjs'] });
    const codes = decision.errors.map(entry => entry.code);
    assert.ok(codes.includes('unknown-requested-probe'), `codes: ${codes.join(',')}`);
    assert.match(decision.errors.find(entry => entry.code === 'unknown-requested-probe').subject, /probe-nope\.mjs/);
    assert.equal(decision.recordPinned, true);
    assert.equal(exitCodeFor(decision), 1);
});

test('a request that resolves to nothing is recorded as an empty selection', () => {
    const decision = decide(syntheticManifest(), { runType: 'dispatch', requested: ['probe-nope.mjs'] });
    const codes = decision.errors.map(entry => entry.code);
    assert.ok(codes.includes('empty-selection'), `codes: ${codes.join(',')}`);
    assert.equal(exitCodeFor(decision), 1);
});

test('resolveRequested reports every unknown name and keeps the known ones', () => {
    const { entries, unknown } = resolveRequested(syntheticManifest(), ['alpha', 'ghost.mjs', 'other']);
    assert.deepEqual(entries.map(entry => entry.script), ['probe-alpha.mjs']);
    assert.deepEqual(unknown, ['ghost.mjs', 'other']);
});

// ------------------------------------------------------------------------------------------------
// 2. The empty-selection invariant, tested where it lives.
// ------------------------------------------------------------------------------------------------

test('finalizePlan refuses a plan that needs the oracle and names no probe', () => {
    const decision = finalizePlan({ recordPinned: true, full: false, probes: [], reason: ['x'] });
    assert.equal(decision.errors.length, 1);
    assert.equal(decision.errors[0].code, 'empty-selection');
    assert.equal(exitCodeFor(decision), 1);
});

test('finalizePlan allows an empty probe list only for a full sweep or a skip', () => {
    assert.deepEqual(finalizePlan({ recordPinned: true, full: true, probes: [] }).errors, []);
    assert.deepEqual(finalizePlan({ recordPinned: false, full: false, probes: [] }).errors, []);
    assert.deepEqual(finalizePlan({ recordPinned: true, full: false, probes: ['probe-alpha.mjs'] }).errors, []);
});

test('finalizePlan derives stabilityMode from the full/narrowed policy', () => {
    assert.equal(finalizePlan({ recordPinned: true, full: true }).stabilityMode, 'double');
    assert.equal(finalizePlan({ recordPinned: true, full: false, probes: ['probe-alpha.mjs'] }).stabilityMode, 'single');
});

// ------------------------------------------------------------------------------------------------
// 3. Push selection: every branch.
// ------------------------------------------------------------------------------------------------

const pushCases = [
    {
        name: 'a probe script selects that probe',
        changed: ['tools/probe-alpha.mjs'],
        expected: { recordPinned: true, full: false, probes: ['probe-alpha.mjs'], failClosed: false },
    },
    {
        name: 'changing a fixture re-records its owner',
        changed: ['tests/oracle/sillytavern-1.19.0-alpha.json'],
        expected: { recordPinned: true, full: false, probes: ['probe-alpha.mjs'], failClosed: false },
    },
    {
        name: 'changing a fixture nothing owns forces a full sweep',
        changed: ['tests/oracle/sillytavern-1.19.0-nobody.json'],
        expected: { recordPinned: true, full: true, failClosed: true, reasonIncludes: 'no probe owns this fixture' },
    },
    {
        name: 'a change to the shared harness is a full sweep',
        changed: ['tools/lib/pinned-outbound.mjs'],
        expected: { recordPinned: true, full: true, failClosed: false, reasonIncludes: 'tools/lib is the harness' },
    },
    {
        name: 'a change to the generator is a full sweep',
        changed: ['tools/build-generated-lib.mjs'],
        expected: { recordPinned: true, full: true, failClosed: false, reasonIncludes: 'the generator' },
    },
    {
        name: 'a change to the inventories generator is a full sweep',
        changed: ['tools/generate-upstream-inventories.mjs'],
        expected: { recordPinned: true, full: true, failClosed: false },
    },
    {
        name: 'a change to the vendored baseline is a full sweep',
        changed: ['upstream/generated/lib.js'],
        expected: { recordPinned: true, full: true, failClosed: false },
    },
    {
        name: 'go.mod is a full sweep',
        changed: ['go.mod'],
        expected: { recordPinned: true, full: true, failClosed: false },
    },
    {
        name: 'go.sum is a full sweep',
        changed: ['go.sum'],
        expected: { recordPinned: true, full: true, failClosed: false },
    },
    {
        name: 'an internal Go change selects the go-product dependents',
        changed: ['internal/server/chat_completions.go'],
        expected: { recordPinned: true, full: false, probes: ['probe-beta.mjs'], failClosed: false },
    },
    {
        name: 'a cmd/ Go change selects the go-product dependents',
        changed: ['cmd/gotavern/main.go'],
        expected: { recordPinned: true, full: false, probes: ['probe-beta.mjs'], failClosed: false },
    },
    {
        name: 'a change to a repository Go helper selects the probes that run it',
        changed: ['tools/helper/main.go'],
        expected: { recordPinned: true, full: false, probes: ['probe-beta.mjs'], failClosed: false },
    },
    {
        name: 'a Go file nobody can attribute forces a full sweep',
        changed: ['pkg/loose/loose.go'],
        expected: { recordPinned: true, full: true, failClosed: true, reasonIncludes: 'cannot be attributed' },
    },
    {
        name: 'an unknown path forces a full sweep and names the path',
        changed: ['mystery/config.yaml'],
        expected: { recordPinned: true, full: true, failClosed: true, reasonIncludes: 'unresolved dependency: mystery/config.yaml' },
    },
    {
        name: 'documentation alone needs no oracle at all',
        changed: ['docs/development-loop.md', 'README.md'],
        expected: { recordPinned: false, full: false, probes: [], failClosed: false },
    },
    {
        name: 'workflow and planner files are not fixture inputs',
        changed: ['.github/workflows/ci.yml', 'tools/oracle/plan.mjs', 'tests/oracle/plan.test.mjs', 'tests/oracle/README.md'],
        expected: { recordPinned: false, full: false, probes: [], failClosed: false },
    },
    {
        name: 'irrelevant and relevant paths together narrow to the relevant probe',
        changed: ['docs/development-loop.md', 'tools/probe-alpha.mjs'],
        expected: { recordPinned: true, full: false, probes: ['probe-alpha.mjs'], failClosed: false },
    },
    {
        name: 'two relevant probes are both selected, once each',
        changed: ['tools/probe-alpha.mjs', 'tools/probe-beta.mjs', 'tools/probe-alpha.mjs'],
        expected: { recordPinned: true, full: false, probes: ['probe-alpha.mjs', 'probe-beta.mjs'], failClosed: false },
    },
    {
        name: 'an empty change list is not evidence that nothing changed',
        changed: [],
        expected: { recordPinned: true, full: true, failClosed: true, reasonIncludes: 'no changed paths were supplied' },
    },
];

for (const testCase of pushCases) {
    test(`push: ${testCase.name}`, () => {
        const decision = decide(syntheticManifest(), { runType: 'push', changed: testCase.changed });
        assert.equal(decision.recordPinned, testCase.expected.recordPinned, JSON.stringify(decision.reason));
        assert.equal(decision.full, testCase.expected.full, JSON.stringify(decision.reason));
        if (testCase.expected.probes) assert.deepEqual(decision.probes, testCase.expected.probes);
        assert.equal(decision.failClosed, testCase.expected.failClosed);
        if (testCase.expected.reasonIncludes) {
            assert.ok(decision.reason.some(line => line.includes(testCase.expected.reasonIncludes)),
                `reason did not mention "${testCase.expected.reasonIncludes}": ${JSON.stringify(decision.reason)}`);
        }
        assert.deepEqual(decision.errors, []);
    });
}

test('a Go change with no go-product dependent forces a full sweep and says why', () => {
    const manifest = createManifest({
        repositoryRoot: '/synthetic',
        scripts: ['probe-alpha.mjs'],
        fixtures: ['sillytavern-1.19.0-alpha.json'],
        entries: [{
            probe: 'alpha', script: 'probe-alpha.mjs', fixture: 'sillytavern-1.19.0-alpha.json',
            label: 'alpha', args: [], sharedWrite: false,
            inputs: ['tools/probe-alpha.mjs'], resolution: 'derived', goProduct: false,
        }],
    });
    const decision = decide(manifest, { runType: 'push', changed: ['internal/users.js'.replace('.js', '.go')] });
    assert.equal(decision.full, true);
    assert.equal(decision.failClosed, true);
    assert.ok(decision.reason.some(line => line.includes('no probe declares a go-product dependency')),
        JSON.stringify(decision.reason));
});

test('a probe-declared input wins over the irrelevant allowlist', () => {
    const manifest = syntheticManifest({
        extraEntries: [{
            probe: 'gamma', script: 'probe-gamma.mjs', fixture: 'sillytavern-1.19.0-gamma.json',
            label: 'gamma', args: [], sharedWrite: false,
            inputs: ['tools/probe-gamma.mjs', 'scripts/probe-invoked-tool.mjs'],
            resolution: 'declared', goProduct: false,
        }],
        scripts: ['probe-alpha.mjs', 'probe-beta.mjs', 'probe-gamma.mjs'],
        fixtures: ['sillytavern-1.19.0-alpha.json', 'sillytavern-1.19.0-beta.json', 'sillytavern-1.19.0-gamma.json'],
    });
    const decision = decide(manifest, { runType: 'push', changed: ['scripts/probe-invoked-tool.mjs'] });
    assert.equal(decision.recordPinned, true);
    assert.deepEqual(decision.probes, ['probe-gamma.mjs']);
});

test('a broken graph refuses to narrow anything', () => {
    const decision = decide(syntheticManifest(), {
        runType: 'push',
        changed: ['tools/probe-alpha.mjs'],
        manifestErrors: [{ code: 'orphan-fixture', subject: 'x.json', message: 'no owner' }],
    });
    assert.equal(decision.recordPinned, true);
    assert.equal(decision.full, true);
    assert.equal(decision.failClosed, true);
    assert.equal(exitCodeFor(decision), 1);
});

// ------------------------------------------------------------------------------------------------
// 4. validate(): every invariant, each with the code the mutation table cites.
// ------------------------------------------------------------------------------------------------

test('validate accepts a manifest where every fixture has exactly one owner', () => {
    assert.deepEqual(validate(syntheticManifest()).errors, []);
});

test('validate: an orphan fixture is an error, and a classification is the only excuse', () => {
    const orphan = validate(syntheticManifest({ fixtures: ['sillytavern-1.19.0-alpha.json', 'sillytavern-1.19.0-beta.json', 'sillytavern-1.19.0-orphan.json'] }));
    assert.ok(orphan.errors.some(entry => entry.code === 'orphan-fixture' && entry.subject === 'sillytavern-1.19.0-orphan.json'),
        JSON.stringify(orphan.errors));

    const classified = validate(syntheticManifest({
        fixtures: ['sillytavern-1.19.0-alpha.json', 'sillytavern-1.19.0-beta.json', 'sillytavern-1.19.0-external.json'],
        classifications: new Map([['sillytavern-1.19.0-external.json', 'external']]),
    }));
    assert.deepEqual(classified.errors, [], 'an explicitly classified fixture must not be an orphan');
});

test('validate: a classification on an owned fixture is stale', () => {
    const result = validate(syntheticManifest({
        classifications: new Map([['sillytavern-1.19.0-alpha.json', 'external']]),
    }));
    assert.ok(result.errors.some(entry => entry.code === 'stale-classification'), JSON.stringify(result.errors));
});

test('validate: an unknown classification value is refused', () => {
    const result = validate(syntheticManifest({
        fixtures: ['sillytavern-1.19.0-alpha.json', 'sillytavern-1.19.0-beta.json', 'sillytavern-1.19.0-odd.json'],
        classifications: new Map([['sillytavern-1.19.0-odd.json', 'probe-ish']]),
    }));
    assert.ok(result.errors.some(entry => entry.code === 'unknown-classification'), JSON.stringify(result.errors));
});

test('validate: a declaration naming a missing script or fixture is dangling', () => {
    const missingScript = validate(syntheticManifest({ scripts: ['probe-beta.mjs'] }));
    assert.ok(missingScript.errors.some(entry => entry.code === 'dangling-script' && entry.subject === 'probe-alpha.mjs'),
        JSON.stringify(missingScript.errors));

    const missingFixture = validate(syntheticManifest({ fixtures: ['sillytavern-1.19.0-beta.json'] }));
    assert.ok(missingFixture.errors.some(entry => entry.code === 'dangling-fixture'), JSON.stringify(missingFixture.errors));
});

test('validate: a probe script with no declaration is invisible, so it is an error', () => {
    const result = validate(syntheticManifest({ scripts: ['probe-alpha.mjs', 'probe-beta.mjs', 'probe-silent.mjs'] }));
    assert.ok(result.errors.some(entry => entry.code === 'undeclared-probe' && entry.subject === 'probe-silent.mjs'),
        JSON.stringify(result.errors));
});

test('validate: one script declaring the same fixture twice is refused', () => {
    const manifest = syntheticManifest();
    manifest.entries.push({ ...manifest.entries[0] });
    const result = validate(manifest);
    assert.ok(result.errors.some(entry => entry.code === 'duplicate-declaration'), JSON.stringify(result.errors));
});

test('validate: two writers of one fixture must be declared, and the declaration must be exact', () => {
    const manifest = syntheticManifest();
    manifest.entries.push({
        probe: 'delta', script: 'probe-beta.mjs', fixture: 'sillytavern-1.19.0-alpha.json',
        label: 'delta', args: [], sharedWrite: false, inputs: ['tools/probe-beta.mjs'], resolution: 'derived', goProduct: true,
    });
    const undeclared = validate(manifest);
    assert.ok(undeclared.errors.some(entry => entry.code === 'multi-writer-undeclared'), JSON.stringify(undeclared.errors));

    const declared = validate(syntheticManifest({
        extraEntries: [{
            probe: 'delta', script: 'probe-beta.mjs', fixture: 'sillytavern-1.19.0-alpha.json',
            label: 'delta', args: [], sharedWrite: false, inputs: ['tools/probe-beta.mjs'], resolution: 'derived', goProduct: true,
        }],
        sharedFixtures: new Map([['sillytavern-1.19.0-alpha.json', ['alpha', 'delta']]]),
    }));
    assert.deepEqual(declared.errors, [], 'a declared shared fixture is legal');

    const stale = validate(syntheticManifest({
        extraEntries: [{
            probe: 'delta', script: 'probe-beta.mjs', fixture: 'sillytavern-1.19.0-alpha.json',
            label: 'delta', args: [], sharedWrite: false, inputs: ['tools/probe-beta.mjs'], resolution: 'derived', goProduct: true,
        }],
        sharedFixtures: new Map([['sillytavern-1.19.0-alpha.json', ['alpha']]]),
    }));
    assert.ok(stale.errors.some(entry => entry.code === 'stale-shared-fixture'), JSON.stringify(stale.errors));
});

test('validate: a declaration line the generator would silently skip is an error here', () => {
    const result = validate(syntheticManifest({
        skippedDeclarationLines: [{ script: 'probe-alpha.mjs', line: '// @gotavern-oracle: fixture = typo.json' }],
    }));
    assert.ok(result.errors.some(entry => entry.code === 'broken-declaration'), JSON.stringify(result.errors));
});

test('validate: a declaration field nothing reads is a warning, not an error', () => {
    const result = validate(syntheticManifest({
        unknownDeclarationFields: [{ script: 'probe-alpha.mjs', name: 'serial', line: '// @gotavern-oracle: fixture=x serial=yes' }],
    }));
    assert.deepEqual(result.errors, []);
    assert.ok(result.warnings.some(entry => entry.code === 'ignored-declaration-field'), JSON.stringify(result.warnings));
});

// ------------------------------------------------------------------------------------------------
// 5. The declaration parser matches the generator's semantics.
// ------------------------------------------------------------------------------------------------

test('parseDeclarations reads the generator\'s own format, including quoted labels and args', () => {
    const source = [
        '// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,',
        '// @gotavern-oracle: fixture=sillytavern-1.19.0-x.json label="a label with spaces" args=one,two sharedWrite=true',
        '// @gotavern-oracle: fixture=sillytavern-1.19.0-y.json label=plain',
    ].join('\n');
    const { entries, skipped } = parseDeclarations({ script: 'probe-x.mjs', source });
    assert.deepEqual(skipped, []);
    assert.equal(entries.length, 2);
    assert.deepEqual(entries[0], {
        probe: 'x',
        script: 'probe-x.mjs',
        fixture: 'sillytavern-1.19.0-x.json',
        label: 'a label with spaces',
        args: ['one', 'two'],
        sharedWrite: true,
        declaredInputs: null,
    });
    assert.equal(entries[1].label, 'plain');
    assert.deepEqual(entries[1].args, []);
    assert.equal(entries[1].sharedWrite, false);
});

test('parseDeclarations keeps the boilerplate form silent but reports a broken fixture field', () => {
    const source = [
        '// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,',
        '// @gotavern-oracle: fixture = sillytavern-1.19.0-x.json label="typo"',
    ].join('\n');
    const { entries, skipped } = parseDeclarations({ script: 'probe-x.mjs', source });
    assert.equal(entries.length, 0);
    assert.equal(skipped.length, 1, 'a line that mentions a fixture but does not parse must be reported');
});

// ------------------------------------------------------------------------------------------------
// 6. Input derivation: the edges the old YAML selection could not see.
// ------------------------------------------------------------------------------------------------

test('deriveInputs sees a tools/lib import', () => {
    const derived = deriveInputs({ script: 'probe-a.mjs', source: "import { x } from './lib/pinned-outbound.mjs';" });
    assert.ok(derived.inputs.includes('tools/lib/'));
    assert.equal(derived.goProduct, false);
    assert.equal(derived.resolution, 'derived');
});

test('deriveInputs sees a provider-wire scenarios read', () => {
    const derived = deriveInputs({
        script: 'probe-a.mjs',
        source: "const dir = path.join(root, 'tests', 'provider-wire', 'scenarios');",
    });
    assert.ok(derived.inputs.includes('tests/provider-wire/scenarios/'));
});

test('deriveInputs sees a repository Go helper and marks the go-product edge', () => {
    const derived = deriveInputs({
        script: 'probe-a.mjs',
        source: "const child = spawn('go', ['run', './tools/image-metadata-roundtrip', root]);",
    });
    assert.ok(derived.inputs.includes('tools/image-metadata-roundtrip/'), JSON.stringify(derived.inputs));
    assert.equal(derived.goProduct, true, 'a probe that runs a repo Go helper records Go output');
});

test('deriveInputs marks a probe that drives the GoTavern binary', () => {
    const derived = deriveInputs({ script: 'probe-a.mjs', source: "const bin = process.env.GOTAVERN_BINARY;" });
    assert.ok(derived.inputs.includes('go-product'));
    assert.equal(derived.goProduct, true);
});

test('deriveInputs: an explicit inputs= replaces the derivation and must name the script', () => {
    const derived = deriveInputs({
        script: 'probe-a.mjs',
        source: "import { x } from './lib/pinned-outbound.mjs';",
        declaredInputs: ['tools/probe-a.mjs', 'tools/special/'],
    });
    assert.deepEqual(derived.inputs, ['tools/probe-a.mjs', 'tools/special/']);
    assert.equal(derived.resolution, 'declared');

    const missingSelf = validate(syntheticManifest({
        extraEntries: [{
            probe: 'gamma', script: 'probe-gamma.mjs', fixture: 'sillytavern-1.19.0-gamma.json',
            label: 'gamma', args: [], sharedWrite: false,
            inputs: ['tools/special/'], resolution: 'declared', goProduct: false,
        }],
        scripts: ['probe-alpha.mjs', 'probe-beta.mjs', 'probe-gamma.mjs'],
        fixtures: ['sillytavern-1.19.0-alpha.json', 'sillytavern-1.19.0-beta.json', 'sillytavern-1.19.0-gamma.json'],
    }));
    assert.ok(missingSelf.errors.some(entry => entry.code === 'declared-inputs-omit-self'), JSON.stringify(missingSelf.errors));
});

// ------------------------------------------------------------------------------------------------
// 7. The real repository. This is the drift gate: if the graph stops describing the tree, this fails.
// ------------------------------------------------------------------------------------------------

test('the committed repository produces a complete, consistent graph', () => {
    const manifest = buildManifest({ repositoryRoot });
    const result = validate(manifest);

    assert.deepEqual(result.errors, [], `manifest errors:\n${JSON.stringify(result.errors, null, 2)}`);
    assert.equal(manifest.entries.length, manifest.fixtures.length,
        'every committed fixture must have exactly one declaration');
    assert.ok(manifest.scripts.length > 0);
    assert.ok(manifest.entries.length >= manifest.scripts.length,
        'some probes declare more than one run; fewer declarations than scripts means a probe is invisible');

    const goProduct = manifest.entries.filter(entry => entry.goProduct).map(entry => entry.script);
    assert.ok(goProduct.length > 0,
        'no probe declares a go-product dependency: a Go change would then either be unattributable or, worse, silently select nothing');
    assert.ok(manifest.entries.some(entry => entry.inputs.includes('tools/lib/')),
        'no probe imports tools/lib: the derivation has stopped seeing the harness edge');
});

test('the real repository: an internal Go change selects the go-product dependents, not nothing', () => {
    const { manifest, plan: decision } = planRepository({
        repositoryRoot,
        runType: 'push',
        changed: ['internal/server/chat_completions.go'],
    });
    const expected = [...new Set(manifest.entries.filter(entry => entry.goProduct).map(entry => entry.script))].sort();
    assert.equal(decision.recordPinned, true);
    assert.equal(decision.full, false);
    assert.deepEqual(decision.probes, expected);
    assert.ok(decision.probes.length > 0, 'the audit finding: this change used to skip the oracle entirely');
});

test('the real repository: a repository Go helper change selects the probes that run it', () => {
    const { plan: decision } = planRepository({
        repositoryRoot,
        runType: 'push',
        changed: ['tools/image-metadata-roundtrip/main.go'],
    });
    assert.equal(decision.recordPinned, true);
    assert.equal(decision.full, false);
    assert.ok(decision.probes.length > 0);
    assert.ok(decision.probes.includes('probe-image-metadata-get.mjs'), decision.probes.join(','));
    assert.ok(!decision.probes.includes('probe-heartbeat.mjs'), 'an unrelated probe must not be swept in');
});

test('the real repository: the oracle-relevant part of this PR is documentation and planner code', () => {
    const { plan: decision } = planRepository({
        repositoryRoot,
        runType: 'push',
        changed: [
            '.github/workflows/ci.yml',
            'tools/oracle/manifest.mjs',
            'tools/oracle/plan.mjs',
            'tests/oracle/plan.test.mjs',
            'tests/oracle/README.md',
            'docs/development-loop.md',
        ],
    });
    assert.equal(decision.recordPinned, false);
    assert.deepEqual(decision.errors, []);
});
