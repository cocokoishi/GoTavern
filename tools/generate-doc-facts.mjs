#!/usr/bin/env node
// Generate the facts documents cite, and rewrite only the marked blocks that carry them.
//
// The rule this tool enforces: a count in a document is either derived from the tree by this
// script or explicitly dated as historical. Prose outside the markers stays human-owned.
//
// Usage:
//   node tools/generate-doc-facts.mjs            # rewrite docs/generated/facts.json + marked blocks
//   node tools/generate-doc-facts.mjs --check    # recompute and fail on any stale fact or block
//   node tools/generate-doc-facts.mjs --print    # print the derived facts, write nothing
//
// No dependencies. Node 24.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FACTS_PATH = path.join(ROOT, 'docs', 'generated', 'facts.json');
const MARKER = /<!-- BEGIN GENERATED: ([A-Za-z0-9.-]+) -->([\s\S]*?)<!-- END GENERATED: \1 -->/g;
const DOCUMENTS = [
    'README.md',
    'HANDOFF.md',
    'docs/compat-matrix.md',
    'docs/surface-coverage.md',
];
const CROSS_BASELINE = 'd00d99b87fc2fbd1ffd218c5ce160d07f27c47ef';
const TOKENIZER_MODELS = [
    'llama', 'nerdstash', 'nerdstash_v2', 'mistral', 'yi', 'gemma', 'jamba',
    'gpt2', 'claude', 'llama3', 'qwen2', 'command-r', 'command-a', 'nemo', 'deepseek',
];

function read(relativePath) {
    return readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function readJSON(relativePath) {
    return JSON.parse(read(relativePath));
}

function splitTableRow(line) {
    const fields = [];
    let current = '';
    for (let index = 0; index < line.length; index += 1) {
        const character = line[index];
        if (character === '\\' && line[index + 1] === '|') {
            current += '\\|';
            index += 1;
            continue;
        }
        if (character === '|') {
            fields.push(current.trim());
            current = '';
            continue;
        }
        current += character;
    }
    fields.push(current.trim());
    return fields;
}

function deriveRoutes() {
    const lines = read('docs/api-inventory.md').split(/\r?\n/);
    const statuses = [];
    for (const line of lines) {
        if (!/^\|\s*(GET|POST|PUT|PATCH|DELETE|ALL|OPTIONS|HEAD)\s*\|/.test(line)) continue;
        const fields = splitTableRow(line);
        statuses.push(fields[4] ?? '');
    }
    const count = (predicate) => statuses.filter(predicate).length;
    return {
        total: statuses.length,
        bareNotImplemented: count((status) => status === 'not implemented'),
        reasonedExclusions: count((status) => status.startsWith('not implemented')),
        partial: count((status) => status.startsWith('partial')),
        compatible: count((status) => status === 'compatible'),
        unsupported: count((status) => status === 'unsupported'),
        reachableCeiling: count((status) => !status.startsWith('not implemented')),
    };
}

function deriveProviderWire() {
    const scenarioDirectory = path.join(ROOT, 'tests', 'provider-wire', 'scenarios');
    const scenarioFiles = readdirSync(scenarioDirectory).filter((name) => name.endsWith('.json'));
    const sources = new Set();
    for (const name of scenarioFiles) {
        const scenario = JSON.parse(readFileSync(path.join(scenarioDirectory, name), 'utf8'));
        const source = scenario?.request?.body?.chat_completion_source;
        if (typeof source !== 'string' || source.length === 0) {
            throw new Error(`${name} names no chat_completion_source; the source count would be a guess`);
        }
        sources.add(source);
    }
    const fixture = readJSON('tests/oracle/sillytavern-1.19.0-provider-wire.json');
    const capturedScenarios = Object.keys(fixture.scenarios ?? {}).length;
    return {
        sources: sources.size,
        scenarioInputs: scenarioFiles.length,
        capturedScenarios,
    };
}

function comparisonSource(name, prefix) {
    if (name === `${prefix}-comparison.json`) return 'custom';
    const match = name.match(new RegExp(`^${prefix}-(.+)-comparison\\.json$`));
    return match ? match[1] : null;
}

function deriveBrowser() {
    const directory = path.join(ROOT, 'tests', 'browser');
    const names = readdirSync(directory).filter((name) => name.endsWith('-comparison.json'));
    const generation = new Set();
    const streaming = new Set();
    const cancellation = new Set();
    for (const name of names) {
        const generationSource = comparisonSource(name, 'generation');
        if (generationSource) generation.add(generationSource);
        const streamingSource = comparisonSource(name, 'streaming');
        if (!streamingSource) continue;
        streaming.add(streamingSource);
        const text = readFileSync(path.join(directory, name), 'utf8');
        if (/"clientDisconnected"\s*:\s*true/.test(text)) cancellation.add(streamingSource);
    }
    const both = [...generation].filter((source) => streaming.has(source));
    return {
        generationSources: generation.size,
        streamingSources: streaming.size,
        bothSurfaces: both.length,
        cancellationSources: cancellation.size,
    };
}

function deriveTokenizers() {
    const fixture = readJSON('tests/oracle/sillytavern-1.19.0-tokenizers.json');
    const keys = Object.keys(fixture.responses ?? {});
    const matchesModelRoute = (key, suffix) => TOKENIZER_MODELS.some((model) => key.startsWith(`${model}/${suffix}#`));
    return {
        cases: keys.length,
        encodeRoute: keys.filter((key) => matchesModelRoute(key, 'encode')).length,
        decodeRoute: keys.filter((key) => matchesModelRoute(key, 'decode')).length,
        openai: keys.filter((key) => key.startsWith('openai/')).length,
        remote: keys.filter((key) => key.startsWith('remote/')).length,
        downloadsDisabled: keys.filter((key) => key.startsWith('downloads-disabled')).length,
    };
}

function deriveSecrets() {
    const text = read('internal/startup/secrets_state.go');
    const block = text.match(/var SecretKeyIDs = \[\]string\{([\s\S]*?)\n\}/);
    if (!block) throw new Error('SecretKeyIDs declaration not found; refusing to guess the secret-key count');
    const keys = block[1].split(/\r?\n/).filter((line) => /^\s*"/.test(line)).length;
    return { keys };
}

function deriveSDGenerate() {
    const directory = path.join(ROOT, 'internal', 'server');
    const routes = new Set();
    for (const name of readdirSync(directory)) {
        if (!/^sd.*\.go$/.test(name) || name.endsWith('_test.go')) continue;
        const text = readFileSync(path.join(directory, name), 'utf8');
        for (const match of text.matchAll(/post\("(\/api\/sd\/[^"]*generate[^"]*)"/g)) {
            routes.add(match[1]);
        }
    }
    return { routes: routes.size };
}

function deriveProviderStatus() {
    const text = read('internal/server/backends_status.go');
    const explicit = new Set([...text.matchAll(/chatCompletionSource([A-Za-z0-9]+)/g)].map((match) => match[1]));
    const customFallThrough = text.includes('source != "custom"') ? 1 : 0;
    return {
        explicitBranches: explicit.size,
        customFallThrough,
        sources: explicit.size + customFallThrough,
        vertexAIExplicitBranch: explicit.has('VertexAI'),
    };
}

function deriveStartup() {
    const fixture = readJSON('tests/browser/startup-comparison.json');
    return {
        requests: (fixture.rows ?? []).length,
        equal: fixture.summary?.equal ?? null,
        differentStatus: fixture.summary?.['different-status'] ?? null,
        unexpected: fixture.unexpectedCount ?? null,
    };
}

function deriveSCM() {
    let commitsSinceCrossBaseline = null;
    try {
        const output = execFileSync('git', ['rev-list', '--count', `${CROSS_BASELINE}..HEAD`], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        commitsSinceCrossBaseline = Number(output);
    } catch {
        commitsSinceCrossBaseline = null;
    }
    let versionTags = [];
    try {
        versionTags = execFileSync('git', ['tag', '--list', 'v*', '--sort=version:refname'], {
            cwd: ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).split(/\r?\n/).filter(Boolean);
    } catch {
        versionTags = [];
    }
    return {
        crossBaselineCommit: CROSS_BASELINE,
        commitsSinceCrossBaseline,
        versionTags,
    };
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

function deriveFacts() {
    const facts = {
        schemaVersion: 1,
        generatedBy: 'tools/generate-doc-facts.mjs',
        routes: deriveRoutes(),
        providerWire: deriveProviderWire(),
        browser: deriveBrowser(),
        tokenizers: deriveTokenizers(),
        secrets: deriveSecrets(),
        sdGenerate: deriveSDGenerate(),
        providerStatus: deriveProviderStatus(),
        startup: deriveStartup(),
        scm: deriveSCM(),
    };
    return sortValue(facts);
}

const BLOCKS = {
    'routes.accounting': (facts) => `\`${facts.routes.total}\` inventoried routes; \`${facts.routes.bareNotImplemented}\` bare \`not implemented\`; \`${facts.routes.reasonedExclusions}\` reasoned exclusions; \`${facts.routes.reachableCeiling}\` reachable.`,
    'provider-wire.sources': (facts) => `\`${facts.providerWire.sources}\``,
    'provider-wire.scenarios': (facts) => `\`${facts.providerWire.capturedScenarios}\``,
    'provider-wire.summary': (facts) => `\`${facts.providerWire.sources}\` sources with recorded provider-wire captures; \`${facts.providerWire.capturedScenarios}\` recorded scenarios.`,
    'browser.sources': (facts) => `\`${facts.browser.bothSurfaces}\``,
    'tokenizers.cases': (facts) => `\`${facts.tokenizers.cases}\``,
    'tokenizers.encodeRoute': (facts) => `\`${facts.tokenizers.encodeRoute}\``,
    'tokenizers.openai': (facts) => `\`${facts.tokenizers.openai}\``,
    'tokenizers.downloadsDisabled': (facts) => `\`${facts.tokenizers.downloadsDisabled}\``,
    'secrets.keys': (facts) => `\`${facts.secrets.keys}\``,
    'sd.generateRoutes': (facts) => `\`${facts.sdGenerate.routes}\``,
    'provider-status.sources': (facts) => `\`${facts.providerStatus.sources}\``,
    'startup.requests': (facts) => `\`${facts.startup.requests}\``,
    'startup.differential': (facts) => `\`${facts.startup.requests}\` startup requests: \`${facts.startup.equal}\` equal, \`${facts.startup.differentStatus}\` different-status, \`${facts.startup.unexpected}\` unexpected.`,
    'scm.commitsSinceCrossBaseline': (facts) => `\`${facts.scm.commitsSinceCrossBaseline}\``,
    'release.versionTags': (facts) => facts.scm.versionTags.length ? facts.scm.versionTags.map((tag) => `\`${tag}\``).join(', ') : 'none',
};

function renderDocument(relativePath, facts) {
    const absolutePath = path.join(ROOT, relativePath);
    if (!existsSync(absolutePath)) return null;
    const original = readFileSync(absolutePath, 'utf8');
    const used = new Set();
    const rendered = original.replace(MARKER, (match, name, current) => {
        if (!Object.hasOwn(BLOCKS, name)) {
            throw new Error(`${relativePath}: unknown generated block "${name}"`);
        }
        used.add(name);
        return `<!-- BEGIN GENERATED: ${name} -->${BLOCKS[name](facts)}<!-- END GENERATED: ${name} -->`;
    });
    return { relativePath, original, rendered, used };
}

function collectMarkers(text) {
    const names = [];
    for (const match of text.matchAll(MARKER)) names.push(match[1]);
    return names;
}

function diffFacts(committed, generated, prefix = '', differences = []) {
    if (JSON.stringify(committed) === JSON.stringify(generated)) return differences;
    if (committed === null || generated === null || typeof committed !== 'object' || typeof generated !== 'object' || Array.isArray(committed) || Array.isArray(generated)) {
        differences.push({ name: prefix, committed, generated });
        return differences;
    }
    const keys = new Set([...Object.keys(committed), ...Object.keys(generated)]);
    for (const key of keys) {
        diffFacts(committed[key], generated[key], prefix ? `${prefix}.${key}` : key, differences);
    }
    return differences;
}

function writeFileStrict(relativePath, content) {
    const absolutePath = path.join(ROOT, relativePath);
    if (content.charCodeAt(0) === 0xfeff) throw new Error(`${relativePath}: refusing to write a BOM`);
    mkdirSync(path.dirname(absolutePath), { recursive: true });
    writeFileSync(absolutePath, content, 'utf8');
}

function main() {
    const mode = process.argv.includes('--check') ? 'check' : process.argv.includes('--print') ? 'print' : 'write';
    const facts = deriveFacts();
    const factsText = `${JSON.stringify(facts, null, 2)}\n`;

    if (mode === 'print') {
        process.stdout.write(factsText);
        return 0;
    }

    const renderedDocuments = DOCUMENTS.map((document) => renderDocument(document, facts)).filter(Boolean);
    const usedBlocks = new Set();
    for (const document of renderedDocuments) {
        for (const name of document.used) usedBlocks.add(name);
    }
    const unused = Object.keys(BLOCKS).filter((name) => !usedBlocks.has(name));

    if (mode === 'write') {
        writeFileStrict('docs/generated/facts.json', factsText);
        for (const document of renderedDocuments) {
            if (document.rendered !== document.original) writeFileStrict(document.relativePath, document.rendered);
        }
        console.log(`wrote docs/generated/facts.json and ${renderedDocuments.length} document(s)`);
        if (unused.length > 0) console.log(`unused generated block(s): ${unused.join(', ')}`);
        return 0;
    }

    const problems = [];
    if (!existsSync(FACTS_PATH)) {
        problems.push('docs/generated/facts.json is missing');
    } else {
        const committed = JSON.parse(readFileSync(FACTS_PATH, 'utf8'));
        for (const difference of diffFacts(committed, facts)) {
            problems.push(`fact ${difference.name}: committed=${JSON.stringify(difference.committed)} generated=${JSON.stringify(difference.generated)}`);
        }
        if (readFileSync(FACTS_PATH, 'utf8') !== factsText) {
            problems.push('docs/generated/facts.json formatting is stale (expected sorted keys, 2-space indent, LF)');
        }
    }

    for (const document of renderedDocuments) {
        if (document.original !== document.rendered) {
            const committedBlocks = collectMarkers(document.original);
            const generatedMarkers = new Map();
            for (const match of document.rendered.matchAll(MARKER)) generatedMarkers.set(match[1], match[2]);
            for (const name of committedBlocks) {
                const current = document.original.match(new RegExp(`<!-- BEGIN GENERATED: ${name.replaceAll('.', '\\.')} -->([\\s\\S]*?)<!-- END GENERATED: ${name.replaceAll('.', '\\.')} -->`));
                const expected = generatedMarkers.get(name);
                if (!current || current[1] !== expected) {
                    problems.push(`${document.relativePath}: block ${name}: committed=${JSON.stringify(current?.[1] ?? null)} generated=${JSON.stringify(expected ?? null)}`);
                }
            }
            if (problems.length === 0) {
                problems.push(`${document.relativePath}: generated block content is stale`);
            }
        }
    }
    if (unused.length > 0) problems.push(`unused generated block(s): ${unused.join(', ')}`);

    if (problems.length > 0) {
        for (const problem of problems) console.error(problem);
        console.error('generated documentation facts are STALE; run: node tools/generate-doc-facts.mjs');
        return 1;
    }
    console.log('generated documentation facts are current');
    return 0;
}

process.exitCode = main();
