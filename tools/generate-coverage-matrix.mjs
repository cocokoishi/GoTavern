#!/usr/bin/env node
// COMPUTED CHAT-COMPLETION COVERAGE.
//
// One row per source, one cell per surface. A `yes` cell is allowed ONLY when a committed artifact
// proves it: the provider-wire fixture for P, a committed generation/streaming comparison for E and
// streaming, and provider-observed disconnects inside that streaming artifact for cancellation. The
// Go registry is used ONLY as a second source of truth to cross-check the pinned-derived source list;
// it never proves a cell, and a mismatch in either direction is a finding and a --check failure.
//
// The browser catalogue and artefacts are also read here so that a stale or absent artifact is its own
// status (`stale`, `absent`) instead of silently becoming `no`. The staleness signature is the one the
// browser verifier uses: a required generation guard/trail field missing, a required streaming check
// missing, or a catalogue drive-parameter that the artifact does not carry. A catalogue `unproven`
// source (workers_ai cannot be re-recorded today) is `stale` for every browser surface.
//
// Usage:
//   node tools/generate-coverage-matrix.mjs            # write docs/generated/coverage-matrix.json + block
//   node tools/generate-coverage-matrix.mjs --check    # fail on any stale fact/cell, mismatch, or block drift
//   node tools/generate-coverage-matrix.mjs --print    # print the matrix, write nothing

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { SOURCES } from '../tests/browser/sources.mjs';
import { EVIDENCE_KEYS, requiredDriveParameters } from './browser-evidence/catalog-checks.mjs';
import { REQUIRED_GENERATION_GUARDS } from './browser-evidence/invariants.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MATRIX_PATH = path.join(ROOT, 'docs', 'generated', 'coverage-matrix.json');
const SURFACE_DOCUMENT = 'docs/surface-coverage.md';
const BLOCK_NAME = 'coverage.matrix';
const PROVIDER_WIRE_FIXTURE = 'tests/oracle/sillytavern-1.19.0-provider-wire.json';
const PROVIDER_WIRE_SCENARIOS = 'tests/provider-wire/scenarios';
const PRESET_COMPARISON = 'tests/browser/preset-complex-comparison.json';
const PRESET_SETTINGS = 'tests/browser/fixtures/preset-complex-settings.json';
const REGISTRY_PATH = 'internal/server/chat_completions_registry.go';
const ROUTE_LEVEL_PATH = 'internal/server/chat_completion_control_test.go';
const GENERATION_PREFIX = 'generation-';
const STREAMING_PREFIX = 'streaming-';
// These are the streaming/cancellation proof keys the browser verifier requires (see
// tools/browser-evidence/invariants.mjs). Kept as a local list so this generator does not import or
// modify the browser harness, which would trigger a browser-differential sweep for a docs-only lane.
const STREAM_CHECK_BLOCKS = ['streaming', 'cancellation', 'nonstream'];

const read = relativePath => readFileSync(path.join(ROOT, relativePath), 'utf8');
const readJSON = relativePath => JSON.parse(read(relativePath));
const exists = relativePath => existsSync(path.join(ROOT, relativePath));

function assertNoBOM(relativePath, content) {
    if (content.charCodeAt(0) === 0xfeff) throw new Error(`${relativePath}: refusing to write a BOM`);
}

function writeStrict(relativePath, content) {
    assertNoBOM(relativePath, content);
    const absolutePath = path.join(ROOT, relativePath);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
}

function sortValue(value) {
    if (Array.isArray(value)) return value.map(sortValue);
    if (value && typeof value === 'object') {
        const sorted = {};
        for (const key of Object.keys(value).sort()) sorted[key] = sortValue(value[key]);
        return sorted;
    }
    return value;
}

function readScenarioInputs() {
    const directory = path.join(ROOT, PROVIDER_WIRE_SCENARIOS);
    const files = readdirSync(directory).filter(name => name.endsWith('.json')).sort();
    const bySource = new Map();
    for (const file of files) {
        const scenario = JSON.parse(readFileSync(path.join(directory, file), 'utf8'));
        const source = scenario?.request?.body?.chat_completion_source;
        const name = scenario?.name;
        if (typeof source !== 'string' || source.length === 0 || typeof name !== 'string') {
            throw new Error(`${PROVIDER_WIRE_SCENARIOS}/${file}: no request.body.chat_completion_source/name`);
        }
        if (!bySource.has(source)) bySource.set(source, []);
        bySource.get(source).push(name);
    }
    return bySource;
}

function readProviderWireFixture() {
    const fixture = readJSON(PROVIDER_WIRE_FIXTURE);
    if (!fixture.scenarios || typeof fixture.scenarios !== 'object') {
        throw new Error(`${PROVIDER_WIRE_FIXTURE}: no scenarios object`);
    }
    return fixture.scenarios;
}

// The product registry is a DECLARATION, not evidence. It is read only to cross-check the pinned
// source list. The constants and the registry rows are parsed from the product files; route-level
// sources are declared by the product test that enforces their dispatch ordering.
function readProductRegistry() {
    const directory = path.join(ROOT, 'internal', 'server');
    const constants = new Map();
    for (const file of readdirSync(directory).filter(name => name.endsWith('.go') && !name.endsWith('_test.go'))) {
        const text = readFileSync(path.join(directory, file), 'utf8');
        for (const match of text.matchAll(/chatCompletionSource([A-Za-z0-9]+)\s*=\s*"([a-z0-9_]+)"/g)) {
            constants.set(match[1], match[2]);
        }
    }
    const registryText = read(REGISTRY_PATH);
    const rows = [...registryText.matchAll(/newChatCompletionSource\(\s*chatCompletionSource([A-Za-z0-9]+)/g)]
        .map(match => constants.get(match[1]))
        .filter(Boolean);
    const routeText = read(ROUTE_LEVEL_PATH);
    const routeBlock = routeText.match(/pinnedRouteLevelChatCompletionSources\s*=\s*\[\]string\{([^}]*)\}/);
    if (!routeBlock) throw new Error(`${ROUTE_LEVEL_PATH}: pinnedRouteLevelChatCompletionSources not found`);
    const routeLevel = [...routeBlock[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
    return {
        sources: [...new Set([...rows, ...routeLevel])].sort(),
        registryRows: rows.length,
        routeLevel,
        paths: [REGISTRY_PATH, `${ROUTE_LEVEL_PATH}:50`],
    };
}

function catalogueById() {
    return new Map(SOURCES.map(source => [source.id, source]));
}

function artifactRelative(source, surface) {
    const filename = source.evidence?.[surface];
    return filename ? `tests/browser/${filename}` : null;
}

function readArtifact(relativePath) {
    try {
        return { artifact: JSON.parse(read(relativePath)) };
    } catch (error) {
        return { error: String(error.message ?? error) };
    }
}

// This is the verifier's staleness signature, deliberately limited to the fields the verifier itself
// uses to call an artifact stale or unsupported. A false PRODUCT check (providerRequestEqual false,
// compatibleReady false, a failed guard value) is not staleness; it is reported as `no` with the
// reason, because the artifact exists and the observation disagrees.
function classifyArtefact(source, surface) {
    const relativePath = artifactRelative(source, surface);
    if (!relativePath) {
        return {
            status: 'no',
            reason: source.unproven ?? 'no committed artefact; the source is not in the browser catalogue',
        };
    }
    if (!exists(relativePath)) {
        return { status: 'absent', path: relativePath, reason: 'the catalogue names this artefact but the file is missing' };
    }
    if (source.unproven) {
        return { status: 'stale', path: relativePath, reason: source.unproven };
    }
    const { artifact, error } = readArtifact(relativePath);
    if (error) return { status: 'stale', path: relativePath, reason: `cannot parse: ${error}` };

    const stale = [];
    const documentation = [];
    if (surface === 'generation') {
        for (const guard of REQUIRED_GENERATION_GUARDS) {
            if (!(guard in (artifact.guards ?? {}))) stale.push(`guards.${guard} missing`);
        }
        if (!artifact.generationInvocations) stale.push('generationInvocations missing');
        if (!artifact.generationUnmatchedAfterData) stale.push('generationUnmatchedAfterData missing');
    } else {
        for (const block of STREAM_CHECK_BLOCKS) {
            if (!artifact[block]?.checks?.finalTextNonEmpty) stale.push(`${block}.checks.finalTextNonEmpty missing`);
        }
        if (!artifact.cancellation?.checks?.abortTextIsPrefixOfStreamedReply) {
            stale.push('cancellation.checks.abortTextIsPrefixOfStreamedReply missing');
        }
    }

    const template = source.driveParameters ? source.driveParameters(undefined) : {};
    const { all, legDerived } = requiredDriveParameters(source);
    const parameters = artifact.driveParameters ?? {};
    for (const key of all) {
        if (!(key in parameters)) {
            if (EVIDENCE_KEYS.has(key) || legDerived.includes(key)) stale.push(`driveParameters.${key} missing`);
            else documentation.push(key);
        } else if (legDerived.includes(key) && (parameters[key] === null || parameters[key] === undefined)) {
            stale.push(`driveParameters.${key} is not the driven value`);
        }
    }
    if ((source.probe.seams ?? []).length > 0) {
        const expected = source.probe.seams[0].env;
        if ('seamEnvVar' in parameters && parameters.seamEnvVar !== expected) {
            stale.push(`driveParameters.seamEnvVar is ${JSON.stringify(parameters.seamEnvVar)}, expected ${expected}`);
        }
    }

    if (stale.length > 0) return { status: 'stale', path: relativePath, reason: stale.join('; ') };
    if (surface === 'generation' && artifact.providerRequestEqual !== true) {
        return { status: 'no', path: relativePath, reason: 'providerRequestEqual is not true' };
    }
    if (surface === 'streaming' && artifact.compatibleReady !== true) {
        return { status: 'no', path: relativePath, reason: 'compatibleReady is not true' };
    }
    const cell = { status: 'yes', path: relativePath };
    if (documentation.length > 0) {
        cell.note = `documentation-only staleness: ${documentation.join(', ')}`;
    }
    return cell;
}

function classifyCancellation(source) {
    const streaming = classifyArtefact(source, 'streaming');
    if (streaming.status !== 'yes') {
        return streaming.status === 'stale'
            ? { ...streaming, reason: `streaming artefact: ${streaming.reason}` }
            : streaming;
    }
    const { artifact } = readArtifact(streaming.path);
    const disconnected = block => (artifact[block]?.gotavern?.providerRequests ?? []).some(request => request.clientDisconnected === true)
        && (artifact[block]?.pinned?.providerRequests ?? []).some(request => request.clientDisconnected === true);
    const observed = disconnected('cancellation');
    if (!observed) {
        return { status: 'no', path: streaming.path, reason: 'clientDisconnected is not true on both cancellation legs' };
    }
    return { status: 'yes', path: streaming.path, evidence: 'cancellation.clientDisconnected true on both legs' };
}

function readPresetEvidence() {
    if (!exists(PRESET_COMPARISON) || !exists(PRESET_SETTINGS)) {
        return {
            status: 'absent',
            reason: 'no complex-preset differential artifact',
            comparison: PRESET_COMPARISON,
            settings: PRESET_SETTINGS,
        };
    }
    const comparison = readJSON(PRESET_COMPARISON);
    const settings = readJSON(PRESET_SETTINGS);
    const source = settings?.capture?.oaiSettings?.chat_completion_source;
    if (typeof source !== 'string' || source.length === 0) {
        throw new Error(`${PRESET_SETTINGS}: capture.oaiSettings.chat_completion_source not found`);
    }
    const boundary = comparison.boundary ?? {};
    const keepDifferences = comparison.bodyDifferences?.keep;
    const dropDifferences = comparison.bodyDifferences?.drop;
    const equal = comparison.providerRequestEqual === true
        && Array.isArray(keepDifferences) && keepDifferences.length === 0
        && Array.isArray(dropDifferences) && dropDifferences.length === 0;
    return {
        status: 'measured',
        source,
        comparison: PRESET_COMPARISON,
        settings: PRESET_SETTINGS,
        verdict: comparison.verdict ?? null,
        providerRequestEqual: comparison.providerRequestEqual === true,
        bodyDifferencesEmpty: equal,
        keepContext: boundary.keepContext ?? null,
        dropContext: boundary.dropContext ?? null,
        measuredBy: boundary.measuredBy ?? null,
        keepMessages: boundary.keepMessages ?? null,
        dropMessages: boundary.dropMessages ?? null,
        keepHistoryMessages: boundary.keepHistoryMessages ?? null,
        dropHistoryMessages: boundary.dropHistoryMessages ?? null,
    };
}

function classifyPreset(source, evidence) {
    if (evidence.status !== 'measured') {
        return { status: 'no', reason: evidence.reason };
    }
    if (evidence.source !== source) {
        return {
            status: 'no',
            reason: `no complex-preset differential for this source; the measured scenario uses ${evidence.source}`,
        };
    }
    if (evidence.verdict !== 'match' || !evidence.providerRequestEqual || !evidence.bodyDifferencesEmpty || evidence.measuredBy !== 'pinned-leg') {
        return {
            status: 'no',
            reason: `complex-preset differential verdict ${evidence.verdict ?? 'missing'}, measuredBy=${evidence.measuredBy ?? 'missing'}, providerRequestEqual=${evidence.providerRequestEqual}`,
            path: evidence.comparison,
        };
    }
    return {
        status: 'yes',
        path: evidence.comparison,
        settingsPath: evidence.settings,
        scenario: 'complex preset',
        boundary: {
            keepContext: evidence.keepContext,
            dropContext: evidence.dropContext,
            measuredBy: evidence.measuredBy,
            keepMessages: evidence.keepMessages,
            dropMessages: evidence.dropMessages,
            keepHistoryMessages: evidence.keepHistoryMessages,
            dropHistoryMessages: evidence.dropHistoryMessages,
        },
    };
}

function pinnedCell(source, scenariosBySource, captured) {
    if (source === 'cometapi') {
        return {
            status: 'excluded',
            reason: 'pinned assembles the URL and key and then throws before sending (src/endpoints/backends/chat-completions.js)',
        };
    }
    const scenarioNames = scenariosBySource.get(source);
    if (!scenarioNames || scenarioNames.length === 0) {
        return { status: 'no', reason: 'no provider-wire scenario input names this source' };
    }
    const missing = scenarioNames.filter(name => {
        const entry = captured[name];
        return !entry || !Array.isArray(entry.provider?.requests) || entry.provider.requests.length === 0;
    });
    if (missing.length > 0) {
        return {
            status: 'stale',
            fixture: PROVIDER_WIRE_FIXTURE,
            reason: `scenario input(s) without a captured provider request: ${missing.join(', ')}`,
        };
    }
    return {
        status: 'yes',
        fixture: PROVIDER_WIRE_FIXTURE,
        scenarios: scenarioNames.length,
        scenarioNames: [...scenarioNames].sort(),
    };
}

function deriveMatrix() {
    const scenariosBySource = readScenarioInputs();
    const captured = readProviderWireFixture();
    const product = readProductRegistry();
    const catalogue = catalogueById();
    const presetEvidence = readPresetEvidence();

    const pinnedSources = [...scenariosBySource.keys()].sort();
    const productSources = product.sources;
    const allSources = [...new Set([...pinnedSources, ...productSources, 'cometapi'])].sort();
    const pinnedSet = new Set(pinnedSources);
    const productSet = new Set(productSources);
    const pinnedOnly = [...pinnedSet].filter(source => !productSet.has(source)).sort();
    const productOnly = [...productSet].filter(source => !pinnedSet.has(source)).sort();
    const catalogueOnly = [...catalogue.keys()].filter(source => !pinnedSet.has(source) && !productSet.has(source)).sort();

    const rows = allSources.map(source => {
        const sourceCatalogue = catalogue.get(source);
        const generation = sourceCatalogue
            ? classifyArtefact(sourceCatalogue, 'generation')
            : { status: 'no', reason: 'source is not in tests/browser/sources.mjs, so no browser drive exists' };
        const streaming = sourceCatalogue
            ? classifyArtefact(sourceCatalogue, 'streaming')
            : { status: 'no', reason: 'source is not in tests/browser/sources.mjs, so no browser drive exists' };
        const cancellation = sourceCatalogue
            ? classifyCancellation(sourceCatalogue)
            : { status: 'no', reason: 'source is not in tests/browser/sources.mjs, so no browser drive exists' };
        return {
            source,
            productRegistered: productSet.has(source),
            pinnedScenarioInputs: pinnedSet.has(source),
            P: pinnedCell(source, scenariosBySource, captured),
            E: generation,
            streaming,
            cancellation,
            preset: classifyPreset(source, presetEvidence),
        };
    });

    const count = (surface, status) => rows.filter(row => row[surface]?.status === status).length;
    const staleArtefacts = [];
    for (const row of rows) {
        for (const surface of ['E', 'streaming']) {
            if (row[surface]?.status === 'stale') {
                staleArtefacts.push({
                    source: row.source,
                    surface,
                    path: row[surface].path ?? null,
                    reason: row[surface].reason,
                });
            }
        }
    }
    const reRecordQueue = staleArtefacts.filter(cell => !(catalogue.get(cell.source)?.unproven));
    const notReRecordable = staleArtefacts.filter(cell => catalogue.get(cell.source)?.unproven);

    const matrix = {
        schemaVersion: 1,
        generatedBy: 'tools/generate-coverage-matrix.mjs',
        crossCheck: {
            pinned: {
                definition: 'unique request.body.chat_completion_source across tests/provider-wire/scenarios/*.json',
                path: PROVIDER_WIRE_SCENARIOS,
                count: pinnedSources.length,
                sources: pinnedSources,
            },
            product: {
                definition: 'newChatCompletionSource rows plus pinnedRouteLevelChatCompletionSources',
                paths: product.paths,
                count: productSources.length,
                sources: productSources,
            },
            pinnedOnly,
            productOnly,
            catalogueOnly,
        },
        presetEvidence,
        summary: {
            rows: rows.length,
            providerWireYes: count('P', 'yes'),
            providerWireExcluded: count('P', 'excluded'),
            generationYes: count('E', 'yes'),
            generationStale: count('E', 'stale'),
            generationNo: count('E', 'no'),
            streamingYes: count('streaming', 'yes'),
            streamingStale: count('streaming', 'stale'),
            streamingNo: count('streaming', 'no'),
            cancellationYes: count('cancellation', 'yes'),
            cancellationStale: count('cancellation', 'stale'),
            cancellationNo: count('cancellation', 'no'),
            presetYes: count('preset', 'yes'),
            staleArtefacts: staleArtefacts.length,
            reRecordQueue: reRecordQueue.length,
            notReRecordable: notReRecordable.length,
            documentationOnlyNotes: rows.filter(row => row.E?.note || row.streaming?.note).length,
        },
        reRecordQueue,
        notReRecordable,
        rows,
    };
    return sortValue(matrix);
}

function cellText(cell) {
    if (!cell) return 'no';
    if (cell.status === 'yes') {
        if (cell.path) return `yes: \`${cell.path}\``;
        if (cell.fixture) return `yes: \`${cell.fixture}\` (${cell.scenarios} scenario(s))`;
        return 'yes';
    }
    if (cell.status === 'excluded') return `excluded: ${cell.reason}`;
    if (cell.status === 'stale') return `stale: \`${cell.path ?? 'unknown'}\` (${cell.reason})`;
    if (cell.status === 'absent') return `absent: \`${cell.path}\``;
    return cell.reason ? `no: ${cell.reason}` : 'no';
}

function renderBlock(matrix) {
    const summary = matrix.summary;
    const lines = [];
    lines.push(`Computed from the committed provider-wire fixture and committed browser artefacts. P yes: ${summary.providerWireYes}; excluded: ${summary.providerWireExcluded}. E yes: ${summary.generationYes}; stale: ${summary.generationStale}; no: ${summary.generationNo}. Streaming yes: ${summary.streamingYes}; stale: ${summary.streamingStale}; no: ${summary.streamingNo}. Cancellation yes: ${summary.cancellationYes}; stale: ${summary.cancellationStale}; no: ${summary.cancellationNo}. Preset yes: ${summary.presetYes}. Stale artefacts: ${summary.staleArtefacts} (${summary.reRecordQueue} in the re-record queue, ${summary.notReRecordable} not re-recordable). A \`yes\` cell names its committed proof; \`stale\` is a committed artefact that predates the current recorder and must be re-recorded.`);
    lines.push('');
    lines.push('| Source | P | E | Streaming | Cancellation | Preset |');
    lines.push('|---|---|---|---|---|---|');
    for (const row of matrix.rows) {
        lines.push(`| \`${row.source}\` | ${cellText(row.P)} | ${cellText(row.E)} | ${cellText(row.streaming)} | ${cellText(row.cancellation)} | ${cellText(row.preset)} |`);
    }
    return lines.join('\n');
}

function renderSurfaceDocument(matrix) {
    const relativePath = SURFACE_DOCUMENT;
    const original = read(relativePath);
    const marker = new RegExp(`<!-- BEGIN GENERATED: ${BLOCK_NAME.replaceAll('.', '\\.')} -->([\\s\\S]*?)<!-- END GENERATED: ${BLOCK_NAME.replaceAll('.', '\\.')} -->`);
    if (!marker.test(original)) throw new Error(`${SURFACE_DOCUMENT}: missing ${BLOCK_NAME} marker`);
    const newline = original.includes('\r\n') ? '\r\n' : '\n';
    const block = renderBlock(matrix).replace(/\r?\n/g, newline);
    const rendered = original.replace(marker, `<!-- BEGIN GENERATED: ${BLOCK_NAME} -->${block}<!-- END GENERATED: ${BLOCK_NAME} -->`);
    return { original, rendered };
}

function diffJson(committed, generated, prefix = '', differences = []) {
    if (JSON.stringify(committed) === JSON.stringify(generated)) return differences;
    if (Array.isArray(committed) && Array.isArray(generated)) {
        const length = Math.max(committed.length, generated.length);
        for (let index = 0; index < length; index += 1) {
            diffJson(committed[index], generated[index], `${prefix}[${index}]`, differences);
        }
        return differences;
    }
    if (committed === null || generated === null || typeof committed !== 'object' || typeof generated !== 'object' || Array.isArray(committed) || Array.isArray(generated)) {
        differences.push({ name: prefix, committed, generated });
        return differences;
    }
    for (const key of new Set([...Object.keys(committed), ...Object.keys(generated)])) {
        diffJson(committed[key], generated[key], prefix ? `${prefix}.${key}` : key, differences);
    }
    return differences;
}

function main() {
    const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--print') ? 'print' : 'write';
    const matrix = deriveMatrix();
    const matrixText = `${JSON.stringify(matrix, null, 2)}\n`;

    if (mode === 'print') {
        process.stdout.write(matrixText);
        return 0;
    }

    const document = renderSurfaceDocument(matrix);
    if (mode === 'write') {
        writeStrict('docs/generated/coverage-matrix.json', matrixText);
        if (document.rendered !== document.original) writeStrict(SURFACE_DOCUMENT, document.rendered);
        console.log(`wrote docs/generated/coverage-matrix.json and ${SURFACE_DOCUMENT}`);
        if (matrix.crossCheck.pinnedOnly.length > 0 || matrix.crossCheck.productOnly.length > 0 || matrix.crossCheck.catalogueOnly.length > 0) {
            console.log(`CROSS-CHECK MISMATCH pinnedOnly=${matrix.crossCheck.pinnedOnly.join(',') || '-'} productOnly=${matrix.crossCheck.productOnly.join(',') || '-'} catalogueOnly=${matrix.crossCheck.catalogueOnly.join(',') || '-'}`);
        }
        return 0;
    }

    const problems = [];
    if (!exists('docs/generated/coverage-matrix.json')) {
        problems.push('docs/generated/coverage-matrix.json is missing');
    } else {
        const committed = JSON.parse(read('docs/generated/coverage-matrix.json'));
        for (const difference of diffJson(committed, matrix)) {
            problems.push(`matrix ${difference.name}: committed=${JSON.stringify(difference.committed)} generated=${JSON.stringify(difference.generated)}`);
        }
        if (read('docs/generated/coverage-matrix.json').replace(/\r\n/g, '\n') !== matrixText) {
            problems.push('docs/generated/coverage-matrix.json formatting is stale (expected sorted keys, 2-space indent, LF)');
        }
    }
    if (document.original !== document.rendered) {
        const committedBlock = document.original.match(new RegExp(`<!-- BEGIN GENERATED: ${BLOCK_NAME.replaceAll('.', '\\.')} -->([\\s\\S]*?)<!-- END GENERATED: ${BLOCK_NAME.replaceAll('.', '\\.')} -->`));
        const generatedBlock = document.rendered.match(new RegExp(`<!-- BEGIN GENERATED: ${BLOCK_NAME.replaceAll('.', '\\.')} -->([\\s\\S]*?)<!-- END GENERATED: ${BLOCK_NAME.replaceAll('.', '\\.')} -->`));
        const normalize = value => (value ?? '').replace(/\r\n/g, '\n');
        if (normalize(committedBlock?.[1]) !== normalize(generatedBlock?.[1])) {
            problems.push(`${SURFACE_DOCUMENT}: block ${BLOCK_NAME}: committed=${JSON.stringify(committedBlock?.[1] ?? null)} generated=${JSON.stringify(generatedBlock?.[1] ?? null)}`);
        }
    }
    if (matrix.crossCheck.pinnedOnly.length > 0 || matrix.crossCheck.productOnly.length > 0) {
        problems.push(`source-of-truth mismatch: pinnedOnly=${matrix.crossCheck.pinnedOnly.join(', ') || '-'} (${matrix.crossCheck.pinned.path}) productOnly=${matrix.crossCheck.productOnly.join(', ') || '-'} (${matrix.crossCheck.product.paths.join(', ')})`);
    }
    if (matrix.crossCheck.catalogueOnly.length > 0) {
        problems.push(`catalogue sources absent from both pinned and product: ${matrix.crossCheck.catalogueOnly.join(', ')}`);
    }
    if (problems.length > 0) {
        for (const problem of problems) console.error(problem);
        console.error('coverage matrix is STALE; run: node tools/generate-coverage-matrix.mjs');
        return 1;
    }
    console.log('coverage matrix is current');
    return 0;
}

process.exitCode = main();
