#!/usr/bin/env node
// WRITE THE PRESET-KNOB PROVIDER-WIRE SCENARIOS from the one catalogue in tests/provider-wire/preset-knobs.mjs.
//
// WHY GENERATED. Each knob has an A and a B scenario that must differ in exactly one member of the
// browser-equivalent generate request. Hand-editing 44 near-identical JSON files is how a scenario pair drifts into
// "A changed two things", which would make the discrimination proof credit the wrong knob. Generating them makes
// "only this member differs" a property of the code that writes them, and tests/provider-wire/preset-knobs.test.mjs
// re-checks it against the files on disk.
//
// USAGE:
//   node tools/generate-preset-knob-scenarios.mjs [--check]
//     (no flag) write/refresh tests/provider-wire/scenarios/preset-knob-*.json
//     --check   write nothing; fail if a file is missing or differs from what the catalogue would emit
//
// The output is deterministic (sorted names, 2-space JSON, one trailing newline), so --check is a real drift gate.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRESET_KNOBS, allKnobScenarios } from '../tests/provider-wire/preset-knobs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const scenarioDirectory = path.join(repoRoot, 'tests', 'provider-wire', 'scenarios');
const checkOnly = process.argv.includes('--check');

const scenarios = allKnobScenarios();
const expectedNames = new Set(scenarios.map(scenario => `${scenario.name}.json`));
const problems = [];
let written = 0;

for (const scenario of scenarios) {
    const file = path.join(scenarioDirectory, `${scenario.name}.json`);
    const body = `${JSON.stringify(scenario, null, 2)}\n`;
    let existing = null;
    try {
        existing = await fs.readFile(file, 'utf8');
    } catch {
        existing = null;
    }
    if (checkOnly) {
        if (existing === null) problems.push(`${scenario.name}: scenario file is missing (run without --check)`);
        else if (existing !== body) problems.push(`${scenario.name}: file differs from the catalogue`);
        continue;
    }
    if (existing === body) continue;
    await fs.writeFile(file, body, 'utf8');
    written++;
}

// A catalogue knob must have EXACTLY its two scenarios on disk: a stale -a/-b for a removed knob would be a gate
// still claiming a knob nobody declares any more.
for (const knob of PRESET_KNOBS) {
    if (!knob.bodyA || !knob.bodyB) problems.push(`${knob.id}: the catalogue must declare bodyA and bodyB`);
    if (!knob.pinnedSource || !knob.goSource) problems.push(`${knob.id}: the catalogue must declare pinnedSource and goSource`);
    if (knob.kind !== 'discriminating' && knob.kind !== 'measured-noop') problems.push(`${knob.id}: kind must be discriminating or measured-noop`);
}
const onDisk = (await fs.readdir(scenarioDirectory)).filter(name => name.startsWith('preset-knob-') && name.endsWith('.json'));
for (const name of onDisk) {
    if (!expectedNames.has(name)) problems.push(`${name}: on disk but no longer declared by the catalogue (delete it or re-declare the knob)`);
}

if (problems.length > 0) {
    for (const problem of problems) console.error(`preset-knob scenarios: ${problem}`);
    process.exit(1);
}
console.log(JSON.stringify({ ok: true, knobs: PRESET_KNOBS.length, scenarios: scenarios.length, written, checkOnly }));
