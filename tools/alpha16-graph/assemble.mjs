// assemble.mjs — build docs/alpha16/ownership-map.json from the M0 lane fragments.
//
// The audit's machine-readable artefact is a UNION of committed fragments, never a separately
// maintained file: each lane writes its own fragment under docs/alpha16/audit/fragments/, and this
// script validates every fragment, computes the coverage census against the generated source graph,
// checks every citation that names a file:line, and emits one deterministic document.
//
// Usage:
//   node tools/alpha16-graph/assemble.mjs --out docs/alpha16/ownership-map.json
//
// Exit codes: 0 = written and every citation resolves; 1 = validation or citation failure (the map
// is still written so a reader can see the offender, but the command fails).
//
// Determinism: lanes are read in the fixed order below, arrays keep their fragment order, the
// missing-production-file list is sorted, and no timestamp is recorded. Re-running on the same tree
// produces the same bytes.

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', '..');
const LANES = ['a', 'b', 'c', 'd', 'e'];
const LEAD = 'lead';
const CLASSES = new Set(['confirmed-defect', 'verified-risk', 'untested-hypothesis', 'intentional-parity', 'out-of-scope']);

function argumentValue(argv, name) {
    const index = argv.indexOf(name);
    if (index === -1) return null;
    return argv[index + 1] ?? null;
}

const outPath = path.resolve(repoRoot, argumentValue(process.argv, '--out') ?? 'docs/alpha16/ownership-map.json');
const fragmentDir = path.join(repoRoot, 'docs', 'alpha16', 'audit', 'fragments');
const failures = [];

function fail(message) {
    failures.push(message);
}

function readJSON(file) {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadLane(name) {
    const file = path.join(fragmentDir, `${name}.json`);
    if (!fs.existsSync(file)) {
        fail(`fragment missing: ${path.relative(repoRoot, file)}`);
        return null;
    }
    let fragment;
    try {
        fragment = readJSON(file);
    } catch (error) {
        fail(`fragment does not parse: ${path.relative(repoRoot, file)}: ${error.message}`);
        return null;
    }
    if (fragment.schemaVersion !== 1) fail(`${name}: schemaVersion is ${fragment.schemaVersion}, expected 1`);
    if (fragment.lane !== name.toUpperCase()) fail(`${name}: lane field is ${JSON.stringify(fragment.lane)}, expected ${name.toUpperCase()}`);
    for (const key of ['filesInspected', 'hypotheses']) {
        if (!Array.isArray(fragment[key])) fail(`${name}: ${key} is not an array`);
    }
    for (const hypothesis of fragment.hypotheses ?? []) {
        for (const key of ['id', 'title', 'classification', 'surface', 'impact', 'evidence', 'strength', 'counterargument', 'reproducerPlan']) {
            if (hypothesis[key] === undefined || hypothesis[key] === null || hypothesis[key] === '') {
                fail(`${name}/${hypothesis.id ?? '(no id)'}: hypothesis is missing ${key}`);
            }
        }
        if (!CLASSES.has(hypothesis.classification)) fail(`${name}/${hypothesis.id}: classification ${hypothesis.classification} is not in the taxonomy`);
        if (!Number.isInteger(hypothesis.strength) || hypothesis.strength < 1 || hypothesis.strength > 5) fail(`${name}/${hypothesis.id}: strength ${hypothesis.strength} is not 1-5`);
        if (!Array.isArray(hypothesis.evidence) || hypothesis.evidence.length === 0) fail(`${name}/${hypothesis.id}: evidence is empty`);
    }
    return { name, fragment };
}

const leadFile = path.join(repoRoot, 'docs', 'alpha16', 'audit', 'lead.json');
const lead = readJSON(leadFile);
const lanes = LANES.map(loadLane).filter(Boolean);
const sourceGraph = readJSON(path.join(repoRoot, 'docs', 'alpha16', 'source-graph.json'));

// ---- citation checking -----------------------------------------------------

const lineCache = new Map();
let citationsChecked = 0;
const citationPattern = /^(\.\.\/SillyTavern\/[^\s:]+|(?:internal|cmd|tests|tools|scripts|docs|upstream)\/[^\s:]+):(\d+)(?:-(\d+))?/;

function lineCount(file) {
    if (!lineCache.has(file)) {
        const absolute = path.resolve(repoRoot, file);
        lineCache.set(file, fs.existsSync(absolute) ? fs.readFileSync(absolute, 'utf8').split('\n').length : null);
    }
    return lineCache.get(file);
}

function checkCitations(owner, list) {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
        const match = citationPattern.exec(String(entry).trim());
        if (!match) continue; // prose, a grep command, a run id or a pinned package path: not a file:line claim
        citationsChecked += 1;
        const [, file, first, last] = match;
        const count = lineCount(file);
        if (count === null) {
            fail(`${owner}: citation file does not exist: ${file}`);
            continue;
        }
        const high = last ? Number(last) : Number(first);
        if (Number(first) < 1 || high > count) {
            fail(`${owner}: citation line out of range: ${entry} (file has ${count} lines)`);
        }
    }
}

for (const lane of lanes) {
    for (const hypothesis of lane.fragment.hypotheses ?? []) checkCitations(`${lane.name}/${hypothesis.id}`, hypothesis.evidence);
}
for (const hypothesis of lead.hypotheses ?? []) checkCitations(`lead/${hypothesis.id}`, hypothesis.evidence);
for (const candidate of lead.refactorCandidates ?? []) checkCitations(`lead/${candidate.id}`, [candidate.evidenceFor]);

// ---- coverage census -------------------------------------------------------

const productionFiles = new Set(sourceGraph.files.filter(file => !file.test).map(file => file.path));
const coverage = new Map(); // production path -> {deep: bool, lanes: Set}
const filesByKind = {};
for (const lane of lanes) {
    for (const file of lane.fragment.filesInspected ?? []) {
        filesByKind[file.kind] = (filesByKind[file.kind] ?? 0) + 1;
        if (file.kind !== 'production' || !productionFiles.has(file.path)) continue;
        const state = coverage.get(file.path) ?? { deep: false, mechanical: false, lanes: new Set() };
        if (file.depth === 'deep') state.deep = true;
        else state.mechanical = true;
        state.lanes.add(lane.name.toUpperCase());
        coverage.set(file.path, state);
    }
}
const missingProduction = [...productionFiles].filter(file => !coverage.has(file)).sort();

// A file can be covered by a report without appearing in `filesInspected`: the provider converters are
// covered as a CLASS by Lane D's registry table, and a lane may cite a helper in prose. Count both
// levels separately so the coverage claim is not inflated: "named in a report" is weaker than
// "deep-read", and "not mentioned at all" is the honest remainder the next round must close.
const REPORT_FILES = {
    a: 'a-request-path.md',
    b: 'b-persistence-writers.md',
    c: 'c-concurrency-lifecycle.md',
    d: 'd-providers-startup.md',
    e: 'e-gates-harness.md',
};
const reportText = lanes
    .map(lane => {
        const file = path.join(repoRoot, 'docs', 'alpha16', 'audit', REPORT_FILES[lane.name]);
        return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    })
    .join('\n');
const citedInReportOnly = missingProduction.filter(file => {
    const base = file.split('/').pop();
    // A report may cite a converter by basename+line without the directory prefix (Lane D's registry
    // table does exactly that), so a basename citation counts as report coverage, not as deep reading.
    return reportText.includes(file) || reportText.includes(base + ':');
});
const notMentioned = missingProduction.filter(file => !citedInReportOnly.includes(file));
const notMentionedByPackage = {};
const notMentionedCategories = { osSibling: [], devTooling: [], productLogic: [] };
for (const file of notMentioned) {
    const parts = file.split('/');
    const key = parts.length > 2 ? parts.slice(0, 2).join('/') : parts.slice(0, 1).join('/');
    notMentionedByPackage[key] = (notMentionedByPackage[key] ?? 0) + 1;
    const base = parts[parts.length - 1];
    const osSuffix = /_(unix|windows|linux|darwin|bsd|other)\.go$/.exec(base);
    if (osSuffix) {
        const prefix = file.slice(0, -osSuffix[0].length) + '_';
        const siblings = [...productionFiles].filter(other => other !== file && other.startsWith(prefix));
        if (siblings.length > 0) {
            notMentionedCategories.osSibling.push(file);
            continue;
        }
    }
    if (/^(tools|tests|cmd|upstream)\//.test(file)) {
        notMentionedCategories.devTooling.push(file);
        continue;
    }
    notMentionedCategories.productLogic.push(file);
}
const coveredDeep = [...coverage.entries()].filter(([, state]) => state.deep).map(([file]) => file).sort();
const coveredMechanicalOnly = [...coverage.entries()].filter(([, state]) => !state.deep).map(([file]) => file).sort();

// ---- union ----------------------------------------------------------------

const combined = {
    schemaVersion: 1,
    generator: 'tools/alpha16-graph/assemble.mjs',
    plan: 'docs/alpha16-agent-execution-plan.md',
    baseCommit: lead.commit,
    generatedFrom: [...lanes.map(lane => `docs/alpha16/audit/fragments/${lane.name}.json`), 'docs/alpha16/audit/lead.json'],
    graph: {
        generator: sourceGraph.generator,
        commit: sourceGraph.commit,
        summary: sourceGraph.summary,
    },
    coverage: {
        lanes: lanes.map(lane => ({
            lane: lane.name.toUpperCase(),
            commit: lane.fragment.commit,
            filesInspected: lane.fragment.filesInspected.length,
            deep: lane.fragment.filesInspected.filter(file => file.depth === 'deep').length,
            mechanical: lane.fragment.filesInspected.filter(file => file.depth === 'mechanical').length,
        })),
        filesInspectedByKind: filesByKind,
        productionFilesInGraph: productionFiles.size,
        productionFilesCoveredByLanes: coverage.size,
        productionFilesDeep: coveredDeep.length,
        productionFilesMechanicalOnly: coveredMechanicalOnly.length,
        productionFilesCitedInAReportOnly: citedInReportOnly.length,
        productionFilesCitedInAReportOnlyList: citedInReportOnly,
        productionFilesNotMentionedByAnyLane: notMentioned.length,
        productionFilesNotMentionedByAnyLaneList: notMentioned,
        productionFilesNotMentionedByPackage: notMentionedByPackage,
        productionFilesNotMentionedByCategory: {
            osSibling: notMentionedCategories.osSibling,
            devTooling: notMentionedCategories.devTooling,
            productLogic: notMentionedCategories.productLogic,
        },
        note: 'A production file "named" by a lane is not the same as deep-read: mechanical depth means the lane looked at it for a specific question. The generated source graph covers all ' + productionFiles.size + ' production files mechanically; the not-mentioned list is the honest remainder and is what the next audit round must close.',
    },
    fiveStrongest: lead.fiveStrongest,
    beyondFive: lead.beyondFive,
    lanes: lanes.map(lane => ({
        lane: lane.name.toUpperCase(),
        title: lane.fragment.title,
        commit: lane.fragment.commit,
        filesInspected: lane.fragment.filesInspected.length,
        hypotheses: lane.fragment.hypotheses.length,
    })),
    packages: lanes.flatMap(lane => (lane.fragment.packages ?? []).map(entry => ({ lane: lane.name.toUpperCase(), ...entry }))),
    requestPath: [
        ...lead.requestPath.map(entry => ({ lane: 'Lead', ...entry })),
        ...lanes.flatMap(lane => (lane.fragment.requestPath ?? []).map(entry => ({ lane: lane.name.toUpperCase(), ...entry }))),
    ],
    writers: lanes.flatMap(lane => (lane.fragment.writers ?? []).map(entry => ({ lane: lane.name.toUpperCase(), ...entry }))),
    startupMutations: lanes.flatMap(lane => (lane.fragment.startupMutations ?? []).map(entry => ({ lane: lane.name.toUpperCase(), ...entry }))),
    concurrency: lanes.flatMap(lane => (lane.fragment.concurrency ?? []).map(entry => ({ lane: lane.name.toUpperCase(), ...entry }))),
    caches: lanes.flatMap(lane => (lane.fragment.caches ?? []).map(entry => ({ lane: lane.name.toUpperCase(), ...entry }))),
    gateInventory: (lanes.find(lane => lane.fragment.gateInventory)?.fragment.gateInventory ?? []),
    harnessInventory: (lanes.find(lane => lane.fragment.harnessInventory)?.fragment.harnessInventory ?? []),
    surfaceVocabulary: (lanes.find(lane => lane.fragment.surfaceVocabulary)?.fragment.surfaceVocabulary ?? []),
    hypotheses: [
        ...lanes.flatMap(lane => (lane.fragment.hypotheses ?? []).map(hypothesis => ({ lane: lane.name.toUpperCase(), ...hypothesis }))),
        ...lead.hypotheses.map(hypothesis => ({ lane: 'Lead', ...hypothesis, classification: hypothesis.classification ?? 'confirmed-defect' })),
    ],
    refactorCandidates: lead.refactorCandidates,
    baseline: lead.baseline,
    questions: [
        ...lanes.flatMap(lane => (lane.fragment.questions ?? []).map(question => ({ lane: lane.name.toUpperCase(), question }))),
        ...(lead.questions ?? []).map(question => ({ lane: 'Lead', question })),
    ],
};

// Duplicate hypothesis ids are an assembly defect, not a merge.
const seen = new Set();
for (const hypothesis of combined.hypotheses) {
    if (seen.has(hypothesis.id)) fail(`duplicate hypothesis id after union: ${hypothesis.id}`);
    seen.add(hypothesis.id);
}

fs.writeFileSync(outPath, JSON.stringify(combined, null, 2) + '\n', 'utf8');

const summary = {
    lanes: combined.lanes.length,
    hypotheses: combined.hypotheses.length,
    fiveStrongest: combined.fiveStrongest.length,
    writers: combined.writers.length,
    startupMutations: combined.startupMutations.length,
    concurrency: combined.concurrency.length,
    caches: combined.caches.length,
    requestPathStages: combined.requestPath.length,
    gateInventory: combined.gateInventory.length,
    citationsChecked,
    failures: failures.length,
    production: `${coverage.size}/${productionFiles.size} named, ${coveredDeep.length} deep, ${citedInReportOnly.length} cited-in-report, ${notMentioned.length} not mentioned`,
};
console.log(JSON.stringify(summary, null, 2));
if (failures.length) {
    console.error('assemble: failures:');
    for (const message of failures) console.error('  - ' + message);
    process.exit(1);
}
console.log('assemble: ownership map written to ' + path.relative(repoRoot, outPath));
