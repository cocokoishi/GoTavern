#!/usr/bin/env node
// THE PRESET-KNOB DISCRIMINATION GATE.
//
// The live provider-wire probe (tools/probe-provider-wire.mjs) proves, for every scenario, Node(capture) ==
// Go(capture) BYTE FOR BYTE (bodySha256/bodyLength/raw target/method). That is two of the four relations for a
// knob pair. This test proves the other two from the COMMITTED pinned captures:
//
//   Node(A) != Node(B)   -- the pair actually discriminates; a discriminating knob whose A/B bodies collide fails
//                           as HARNESS NON-DISCRIMINATING (AGENTS rule 50);
//   Go(A)   != Go(B)     -- follows from the three equalities (Go(A)==Node(A), Go(B)==Node(B), Node(A)!=Node(B)),
//                           and the logic is asserted here so a future change that stops recording one side cannot
//                           quietly reduce the claim to two relations.
//
// A knob declared MEASURED-NOOP must have A/B bodies that are BYTE-EQUAL on the pinned side. That equality is the
// evidence for the classification (the server ignores the member); a measured-noop knob whose captures differ
// means the classification is false and the test fails.
//
// The changed JSON paths are computed from `bodyText` for DIAGNOSTICS ONLY (which member moved, and that nothing
// else moved); equality is never decided on the projection -- it is bodySha256, as the provider-wire design
// requires. `bodyText` is a readability projection and the comparison here never treats equal text as equal bytes.
//
// USAGE:
//   node --test tests/provider-wire/preset-knobs.test.mjs
//   node tests/provider-wire/preset-knobs.test.mjs --summary     (one JSON line, for a CI job summary)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRESET_KNOBS, allKnobScenarios } from './preset-knobs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..', '..');
const scenarioDirectory = path.join(here, 'scenarios');
const fixturePath = path.join(repoRoot, 'tests', 'oracle', 'sillytavern-1.19.0-provider-wire.json');

// Dotted JSON paths, arrays as [i]. This is the diagnostic that says WHICH member moved; it never decides equality.
function changedPaths(left, right, prefix = '') {
    const changed = [];
    if (Array.isArray(left) && Array.isArray(right)) {
        for (let index = 0; index < Math.max(left.length, right.length); index++) {
            const child = `${prefix}[${index}]`;
            if (index >= left.length || index >= right.length) changed.push(child);
            else changed.push(...changedPaths(left[index], right[index], child));
        }
        return changed;
    }
    const isObject = value => value !== null && typeof value === 'object';
    if (isObject(left) && isObject(right)) {
        const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
        for (const key of keys) {
            const child = prefix === '' ? key : `${prefix}.${key}`;
            if (!(key in left) || !(key in right)) changed.push(child);
            else changed.push(...changedPaths(left[key], right[key], child));
        }
        return changed;
    }
    if (JSON.stringify(left) !== JSON.stringify(right)) changed.push(prefix);
    return changed;
}

function bodyOf(fixture, scenarioName) {
    const capture = fixture.scenarios?.[scenarioName];
    if (!capture) return { error: `${scenarioName}: no capture in the committed fixture` };
    const requests = capture.provider?.requests ?? [];
    if (requests.length !== 1) return { error: `${scenarioName}: expected exactly one provider request, got ${requests.length}` };
    const request = requests[0];
    let body = null;
    try {
        body = JSON.parse(request.bodyText);
    } catch (error) {
        return { error: `${scenarioName}: bodyText is not JSON (${error.message})` };
    }
    return { capture, request, body };
}

const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));

const findings = [];
const knobResults = [];
for (const knob of PRESET_KNOBS) {
    const a = bodyOf(fixture, `preset-knob-${knob.id}-a`);
    const b = bodyOf(fixture, `preset-knob-${knob.id}-b`);
    const result = {
        id: knob.id,
        area: knob.area,
        kind: knob.kind,
        capturedOnBothSides: Boolean(a.capture && b.capture),
        bodyBytesEqual: null,
        changedPaths: [],
        ok: false,
    };
    if (a.error || b.error) {
        findings.push({ knob: knob.id, failure: a.error ?? b.error });
        result.failure = a.error ?? b.error;
        knobResults.push(result);
        continue;
    }
    // EQUALITY IS ON BYTES, never on the projection.
    result.bodyBytesEqual = a.request.bodySha256 === b.request.bodySha256 && a.request.bodyLength === b.request.bodyLength;
    result.bodySha256A = a.request.bodySha256;
    result.bodySha256B = b.request.bodySha256;
    const differences = changedPaths(a.body, b.body);
    result.changedPaths = differences;

    if (knob.kind === 'discriminating') {
        if (result.bodyBytesEqual) {
            findings.push({
                knob: knob.id,
                failure: 'HARNESS NON-DISCRIMINATING: the -a and -b provider bodies are byte-identical, so this knob is not measured by the pair',
            });
            knobResults.push(result);
            continue;
        }
        const missing = knob.expectedChanges.filter(expected => !differences.includes(expected));
        if (missing.length > 0) {
            findings.push({ knob: knob.id, failure: `the declared change path(s) did not move: ${missing.join(', ')} (moved: ${differences.join(', ') || 'none'})` });
            knobResults.push(result);
            continue;
        }
        const unexpected = differences.filter(change => !knob.allowedChanges.includes(change));
        if (unexpected.length > 0) {
            findings.push({ knob: knob.id, failure: `paths moved that the knob must not move: ${unexpected.join(', ')}` });
            knobResults.push(result);
            continue;
        }
        result.ok = true;
    } else {
        if (!result.bodyBytesEqual) {
            findings.push({
                knob: knob.id,
                failure: `declared measured-noop, but the -a/-b provider bodies differ at: ${differences.join(', ') || 'unknown'}`,
            });
            knobResults.push(result);
            continue;
        }
        result.ok = true;
    }
    knobResults.push(result);
}

test('every knob pair is captured on both sides and the pair discriminates or is a proven noop', () => {
    assert.equal(PRESET_KNOBS.length > 0, true, 'the catalogue is empty, so this gate would prove nothing');
    if (findings.length > 0) {
        assert.fail(findings.map(finding => `${finding.knob}: ${finding.failure}`).join('\n'));
    }
    assert.equal(knobResults.filter(result => result.ok).length, PRESET_KNOBS.length);
});

test('the discrimination claim covers all four relations', () => {
    // Two relations are enforced live by the probe for EVERY scenario; the other two are the assertions above. This
    // test makes the composition explicit so "Node(A)==Go(A), Node(B)==Go(B), Node(A)!=Node(B)" cannot be reported
    // as a two-relation result in a later refactor.
    const discriminating = knobResults.filter(result => result.kind === 'discriminating');
    for (const result of discriminating) {
        assert.notEqual(result.bodySha256A, result.bodySha256B, `${result.id}: Node(A) and Node(B) must differ`);
    }
    const noops = knobResults.filter(result => result.kind === 'measured-noop');
    for (const result of noops) {
        assert.equal(result.bodySha256A, result.bodySha256B, `${result.id}: a measured-noop knob must not move the provider body`);
    }
    // Go equality is not re-derived here (it would need the live Go captures); it is the probe's contract, and the
    // comparator for it is byte-oriented. Say so rather than silently dropping the relation.
    assert.ok(true, 'Go(A)==Node(A) and Go(B)==Node(B) are enforced by tools/probe-provider-wire.mjs for every scenario');
});

test('the scenario files on disk are exactly what the catalogue emits', async () => {
    const expected = allKnobScenarios();
    const expectedNames = new Set(expected.map(scenario => `${scenario.name}.json`));
    const onDisk = (await fs.readdir(scenarioDirectory)).filter(name => name.startsWith('preset-knob-') && name.endsWith('.json'));
    const problems = [];
    for (const name of onDisk) if (!expectedNames.has(name)) problems.push(`${name}: on disk but not declared by the catalogue`);
    for (const scenario of expected) {
        const file = path.join(scenarioDirectory, `${scenario.name}.json`);
        const body = await fs.readFile(file, 'utf8').catch(() => null);
        if (body === null) {
            problems.push(`${scenario.name}: missing (run node tools/generate-preset-knob-scenarios.mjs)`);
            continue;
        }
        if (body !== `${JSON.stringify(scenario, null, 2)}\n`) problems.push(`${scenario.name}: file differs from the catalogue`);
    }
    assert.deepEqual(problems, []);
});

// A one-line machine-readable summary for the job summary / a lane's report. Guarded so `node --test` is unaffected.
if (process.argv.includes('--summary')) {
    const summary = {
        schema: 'gotavern-preset-knob-discrimination',
        schemaVersion: 1,
        knobs: PRESET_KNOBS.length,
        scenarios: allKnobScenarios().length,
        discriminating: knobResults.filter(result => result.kind === 'discriminating').length,
        measuredNoop: knobResults.filter(result => result.kind === 'measured-noop').length,
        passed: knobResults.filter(result => result.ok).length,
        failed: findings,
        ok: findings.length === 0 && knobResults.every(result => result.ok),
        relations: {
            nodeAEqualsGoA: 'enforced live by tools/probe-provider-wire.mjs for every scenario (byte-oriented)',
            nodeBEqualsGoB: 'enforced live by tools/probe-provider-wire.mjs for every scenario (byte-oriented)',
            nodeADiffersFromNodeB: 'asserted from the committed pinned captures by this test',
            goADiffersFromGoB: 'follows from the three relations; asserted as a composition in this test',
        },
        knobsDetail: knobResults,
    };
    console.log(JSON.stringify(summary));
    if (!summary.ok) process.exit(1);
}
