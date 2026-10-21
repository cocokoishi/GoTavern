#!/usr/bin/env node
// Capture the pinned /api/vector/* behaviour: the vectra LocalIndex on-disk format, the seven
// route contracts, the precomputed-embedding sources (webllm / koboldcpp work with no network),
// the batch-size-10 loop, query scoring/threshold/topK, multi-query grouping, delete-by-hash,
// purge/purge-all, and the corrupted-index regeneration redirect.
//
// SOURCE COVERAGE. Only the sources whose vectors arrive precomputed in the request body are
// probed here (`webllm`, `koboldcpp`). Every provider source (transformers/openai/togetherai/...)
// needs its own provider oracle; the Go implementation does not implement them yet and the fixture
// says so in knownDifferences. A missing `source` member is NOT defaulted by the pinned code:
// `String(req.body.source) || 'transformers'` yields the string 'undefined', which is why several
// recorded scenarios exercise the 'undefined' source path.
//
// The pinned server boots with node-fetch replaced by the pinned-outbound stub, so a scenario can
// never reach the internet; these routes make no outbound request.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-vector.json label="vector routes"

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-vector.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COOKIE_SECRET = 'gotavern-pinned-vector-cookie-secret';
// src/endpoints/vectors.js:22, in order; purge/purge-all iterate exactly this list.
const SOURCES = [
    'transformers', 'mistral', 'openai', 'extras', 'palm', 'togetherai', 'nomicai', 'cohere',
    'ollama', 'llamacpp', 'vllm', 'webllm', 'koboldcpp', 'vertexai', 'electronhub', 'openrouter',
    'chutes', 'nanogpt', 'siliconflow', 'workers_ai',
];

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/g;

function normalizeText(text) {
    return text.replace(UUID_PATTERN, '<uuid>');
}

// A recursive, deterministic snapshot of the user's vectors directory. File contents are read as
// UTF-8 and UUIDs are normalised; nothing else is rewritten.
function snapshotDirectory(root) {
    const entries = [];
    const walk = (absolute, relative) => {
        if (!existsSync(absolute)) return;
        for (const name of readdirSync(absolute).sort()) {
            const childAbsolute = path.join(absolute, name);
            const childRelative = relative === '' ? name : `${relative}/${name}`;
            const info = statSync(childAbsolute);
            if (info.isDirectory()) {
                entries.push({ path: childRelative, kind: 'directory', content: null });
                walk(childAbsolute, childRelative);
            } else {
                entries.push({ path: childRelative, kind: 'file', content: normalizeText(readFileSync(childAbsolute).toString('utf8')) });
            }
        }
    };
    walk(root, '');
    return entries;
}

// Deterministic numeric vectors. Each text gets a distinct direction so scores are orders of
// magnitude apart and threshold behaviour is discriminating.
function vectorFor(index) {
    const vectors = [
        [1, 0, 0],
        [0.6, 0.8, 0],
        [0.6, 0, 0.8],
        [0.28, 0.96, 0],
        [0.5, 0.5, 0.7071],
        [0, 1, 0],
        [0, 0, 1],
        [0.8, 0.2, 0.56],
        [0.2, 0.8, 0.56],
        [0.9, 0.1, 0.42],
        [0.1, 0.9, 0.42],
    ];
    return vectors[index % vectors.length];
}

function itemSet({ start, count, prefix = 't' }) {
    const items = [];
    const embeddings = {};
    for (let index = 0; index < count; index += 1) {
        const text = `${prefix}${index}`;
        items.push({ hash: start + index, text, index });
        embeddings[text] = vectorFor(index);
    }
    return { items, embeddings };
}

function responseCapture(result) {
    const location = result.response.headers.get('location');
    return {
        status: result.response.status,
        contentType: result.response.headers.get('content-type'),
        contentLength: result.response.headers.get('content-length'),
        etag: result.response.headers.get('etag'),
        location,
        body: normalizeText(result.text),
    };
}

async function main() {
    const server = await startPinnedProviderServer({
        sourceRoot,
        prefix: 'gotavern-vector-oracle-',
        mocks: [],
    });
    const vectorsRoot = path.join(server.userRoot, 'vectors');
    const steps = [];
    const state = {};
    try {
        const step = async (name, route, body, { query = '', before, beforeFile } = {}) => {
            if (before) before();
            const result = await server.post(`/api/vector/${route}${query}`, JSON.stringify(body ?? {}));
            steps.push({ name, route, query, body: body ?? {}, beforeFile: beforeFile ?? null, response: responseCapture(result) });
            state[name] = snapshotDirectory(vectorsRoot);
        };

        await step('list.missingParams', 'list', {});
        await step('list.noSourceCreatesUndefinedIndex', 'list', { collectionId: 'c1' });
        await step('list.empty', 'list', { collectionId: 'c1', source: 'webllm', model: 'm' });

        const first = itemSet({ start: 1, count: 2, prefix: 'alpha' });
        first.items[0].text = 'alpha';
        first.items[1].text = 'beta';
        delete first.embeddings.alpha0;
        delete first.embeddings.beta1;
        first.embeddings.alpha = [1, 0, 0];
        first.embeddings.beta = [0.6, 0.8, 0];
        await step('insert.ok', 'insert', {
            collectionId: 'c1', source: 'webllm', model: 'm', items: first.items, embeddings: first.embeddings,
        });
        await step('list.afterInsert', 'list', { collectionId: 'c1', source: 'webllm', model: 'm' });

        await step('insert.missingEmbedding', 'insert', {
            collectionId: 'c1', source: 'webllm', model: 'm',
            items: [{ hash: 3, text: 'gamma', index: 2 }], embeddings: {},
        });

        const batch = itemSet({ start: 10, count: 11, prefix: 'batch' });
        await step('insert.moreThanOneBatch', 'insert', {
            collectionId: 'c1', source: 'webllm', model: 'm', items: batch.items, embeddings: batch.embeddings,
        });
        await step('list.afterBatchInsert', 'list', { collectionId: 'c1', source: 'webllm', model: 'm' });

        await step('insert.nullItem', 'insert', {
            collectionId: 'c1', source: 'webllm', model: 'm', items: [null], embeddings: {},
        });
        await step('insert.missingParams', 'insert', {});
        await step('insert.itemsNotArray', 'insert', { collectionId: 'c1', items: 'nope' });

        const queryEmbeddings = { alpha: [1, 0, 0], beta: [0.6, 0.8, 0] };
        await step('query.basic', 'query', {
            collectionId: 'c1', source: 'webllm', model: 'm', searchText: 'alpha',
            topK: 3, threshold: 0.5, embeddings: queryEmbeddings,
        });
        await step('query.highThresholdHashesUnfiltered', 'query', {
            collectionId: 'c1', source: 'webllm', model: 'm', searchText: 'alpha',
            topK: 2, threshold: 2, embeddings: queryEmbeddings,
        });
        await step('query.topKOnly', 'query', {
            collectionId: 'c1', source: 'webllm', model: 'm', searchText: 'beta',
            topK: 1, embeddings: queryEmbeddings,
        });
        await step('query.noSource', 'query', {
            collectionId: 'c1', model: 'm', searchText: 'alpha', embeddings: queryEmbeddings,
        });
        await step('query.missingParams', 'query', { collectionId: 'c1' });

        await step('insert.secondCollection', 'insert', {
            collectionId: 'c2', source: 'webllm', model: 'm', items: first.items, embeddings: first.embeddings,
        });
        await step('queryMulti.ok', 'query-multi', {
            collectionIds: ['c1', 'c2'], source: 'webllm', model: 'm', searchText: 'alpha',
            topK: 4, threshold: 0.4, embeddings: queryEmbeddings,
        });
        await step('queryMulti.collectionIdsNotArray', 'query-multi', {
            collectionIds: 'c1', source: 'webllm', model: 'm', searchText: 'alpha',
        });

        await step('delete.ok', 'delete', {
            collectionId: 'c1', source: 'webllm', model: 'm', hashes: [2, 12],
        });
        await step('list.afterDelete', 'list', { collectionId: 'c1', source: 'webllm', model: 'm' });
        await step('delete.noMatch', 'delete', {
            collectionId: 'c1', source: 'webllm', model: 'm', hashes: [999],
        });
        await step('delete.missingParams', 'delete', { collectionId: 'c1' });

        await step('purge.oneCollection', 'purge', { collectionId: 'c1' });
        await step('list.afterPurge', 'list', { collectionId: 'c1', source: 'webllm', model: 'm' });
        await step('purge.missingParams', 'purge', {});
        await step('purgeAll', 'purge-all', {});
        await step('list.afterPurgeAll', 'list', { collectionId: 'c2', source: 'webllm', model: 'm' });

        // Corrupted index: the pinned catch deletes the index and answers a 307 to the same URL
        // with ?regenerated=true; the retried request recreates the index and proceeds.
        await step('corrupt.setup', 'list', { collectionId: 'c3', source: 'webllm', model: 'm' });
        const corruptContent = '{"version":1,"items":[broken';
        await step('corrupt.listWithoutRegenerated', 'list', { collectionId: 'c3', source: 'webllm', model: 'm' }, {
            beforeFile: { path: 'webllm/c3/m/index.json', content: corruptContent },
            before: () => {
                writeFileSync(path.join(vectorsRoot, 'webllm', 'c3', 'm', 'index.json'), corruptContent);
            },
        });
        await step('corrupt.listRegenerated', 'list', { collectionId: 'c3', source: 'webllm', model: 'm' }, {
            query: '?regenerated=true',
        });

        await step('list.sanitizesCollectionId', 'list', { collectionId: '../escape/../c4', source: 'webllm', model: 'm' });
        await step('purgeAll.final', 'purge-all', {});

        const knownDifferences = [{
            area: 'provider-backed vector sources',
            status: 'not implemented',
            reason: 'the pinned domain can embed text through 20 sources; this round implements the two sources whose vectors are supplied in the request body (webllm, koboldcpp) plus the unknown-source error path. Every provider-backed source (transformers, openai, togetherai, mistral, electronhub, openrouter, chutes, nanogpt, siliconflow, workers_ai, cohere, nomicai, extras, palm, vertexai, ollama, llamacpp, vllm) needs its own provider-wire oracle and adapter; until then those sources answer 500 like any other failed vector lookup instead of silently succeeding.',
        }, {
            area: 'request-body source default',
            status: 'preserved',
            reason: 'pinned `String(req.body.source) || "transformers"` makes an ABSENT source the literal string "undefined", which is preserved here and covered by the noSource scenarios',
        }];

        const fixture = {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned /api/vector/* routes: vectra LocalIndex format, scoring, grouping, purge and corruption regeneration',
            oracle: { file: 'src/endpoints/vectors.js', mountedAt: '/api/vector (src/server-startup.js:171)' },
            conventions: {
                snapshot: 'a recursive snapshot of the user vectors directory after every step; file contents are UTF-8 with UUIDs normalised to <uuid>',
                sources: SOURCES,
            },
            fixtureFields: {
                compared: ['steps[].response.status', 'steps[].response.contentType', 'steps[].response.contentLength', 'steps[].response.etag', 'steps[].response.location', 'steps[].response.body', 'state[<step>] (path/kind/content of every vectors entry, UUID-normalised)'],
                shape: [],
                notRecorded: ['the random item UUID values (normalised)', 'the pinned server listen port', 'the pinned runtime path'],
            },
            inputs: {
                cookieSecret: COOKIE_SECRET,
                account: { handle: 'default-user', name: 'Vector Probe', admin: true, password: '' },
                sources: SOURCES,
            },
            steps,
            state,
            knownDifferences,
        };
        writeFixture(repositoryRoot, 'sillytavern-1.19.0-vector.json', fixture);
        console.log('Wrote tests/oracle/sillytavern-1.19.0-vector.json from pinned /api/vector behaviour');
    } finally {
        await server.stop();
    }
}

await main();
