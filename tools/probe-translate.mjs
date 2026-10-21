#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-translate.json label="translate"
// Probe the pinned /api/translate/* routes against the REAL pinned server with its node-fetch
// replaced by a controlled peer (tools/lib/pinned-outbound.mjs).
//
// Six of the eight routes are pinned here. `/api/translate/google` and `/api/translate/bing` are NOT:
// they delegate to `google-translate-api-x` and `bing-translate-api`, which implement Google's and
// Bing's private multi-request protocols inside those packages. Their request flow is package code,
// not endpoint code, so it cannot be pinned from the SillyTavern source and is left `not implemented`
// rather than guessed.
//
// Four of the six read their URL from a SECRET (libre_url / deeplx_url / oneringtranslator_url /
// lingva_url), so their upstream is genuinely user-controlled; the probe points those secrets at test
// hosts and the Go side points them at a local listener. DeepL and Yandex hardcode their endpoint, so
// the module hook stands in for the third party there and the Go seam defaults are asserted.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-translate.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const TEST_URLS = {
    libre: 'https://libre.example.test/translate',
    deeplx: 'https://deeplx.example.test/translate',
    onering: 'https://onering.example.test/translate',
    lingva: 'https://lingva.example.test/api/v1',
};

const DEFAULTS = {
    lingva: 'https://lingva.ml/api/v1',
    onering: 'http://127.0.0.1:4990/translate',
    deeplx: 'http://127.0.0.1:1188/translate',
    deeplFree: 'https://api-free.deepl.com/v2/translate',
    deeplPro: 'https://api.deepl.com/v2/translate',
    yandex: 'https://translate.yandex.net/api/v1/tr.json/translate',
};

function urlSecret(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

const LIBRE_OK = { translatedText: 'Hallo Welt' };
const DEEPL_OK = { translations: [{ detected_source_language: 'EN', text: 'Hallo Welt' }] };
const YANDEX_OK = { code: 200, lang: 'en-de', text: ['Hallo', 'Welt'] };
const LINGVA_OK = { translation: 'Hallo Welt' };
const ONERING_OK = { result: 'Hallo Welt' };
const DEEPLX_OK = { code: 200, data: 'Hallo Welt' };

const SCENARIOS = [
    // ── /libre ──────────────────────────────────────────────────────────────────────────────────
    { label: 'libreNoUrl', route: '/api/translate/libre', body: '{"text":"hello","lang":"de"}', secrets: {}, match: 'libre.example.test' },
    { label: 'libreNoText', route: '/api/translate/libre', body: '{"lang":"de"}', secrets: urlSecret('libre_url', TEST_URLS.libre), match: 'libre.example.test' },
    { label: 'libreOk', route: '/api/translate/libre', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('libre_url', TEST_URLS.libre), match: 'libre.example.test', payload: LIBRE_OK },
    { label: 'libreWithKey', route: '/api/translate/libre', body: '{"text":"hello","lang":"de"}', secrets: { ...urlSecret('libre_url', TEST_URLS.libre), ...urlSecret('libre', 'synthetic-libre-key') }, match: 'libre.example.test', payload: LIBRE_OK },
    { label: 'libreZhCN', route: '/api/translate/libre', body: '{"text":"hello","lang":"zh-CN"}', secrets: urlSecret('libre_url', TEST_URLS.libre), match: 'libre.example.test', payload: LIBRE_OK },
    { label: 'libreZhTW', route: '/api/translate/libre', body: '{"text":"hello","lang":"zh-TW"}', secrets: urlSecret('libre_url', TEST_URLS.libre), match: 'libre.example.test', payload: LIBRE_OK },
    { label: 'librePtBR', route: '/api/translate/libre', body: '{"text":"hello","lang":"pt-BR"}', secrets: urlSecret('libre_url', TEST_URLS.libre), match: 'libre.example.test', payload: LIBRE_OK },
    { label: 'libreEmptyPayload', route: '/api/translate/libre', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('libre_url', TEST_URLS.libre), match: 'libre.example.test', payload: {} },
    { label: 'libreNonOk', route: '/api/translate/libre', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('libre_url', TEST_URLS.libre), match: 'libre.example.test', status: 500, statusText: 'Internal Server Error', text: 'libre says no' },
    { label: 'libreInvalidJSON', route: '/api/translate/libre', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('libre_url', TEST_URLS.libre), match: 'libre.example.test', raw: 'not json' },
    { label: 'libreThrows', route: '/api/translate/libre', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('libre_url', TEST_URLS.libre), match: 'libre.example.test', throws: true },

    // ── /deeplx ─────────────────────────────────────────────────────────────────────────────────
    { label: 'deeplxDefaultUrl', route: '/api/translate/deeplx', body: '{"text":"hello","lang":"de"}', secrets: {}, match: '127.0.0.1:1188', payload: DEEPLX_OK },
    { label: 'deeplxSecretUrl', route: '/api/translate/deeplx', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('deeplx_url', TEST_URLS.deeplx), match: 'deeplx.example.test', payload: DEEPLX_OK },
    { label: 'deeplxZhCN', route: '/api/translate/deeplx', body: '{"text":"hello","lang":"zh-CN"}', secrets: urlSecret('deeplx_url', TEST_URLS.deeplx), match: 'deeplx.example.test', payload: DEEPLX_OK },
    { label: 'deeplxNoText', route: '/api/translate/deeplx', body: '{"lang":"de"}', secrets: urlSecret('deeplx_url', TEST_URLS.deeplx), match: 'deeplx.example.test' },
    { label: 'deeplxNonOk', route: '/api/translate/deeplx', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('deeplx_url', TEST_URLS.deeplx), match: 'deeplx.example.test', status: 500, statusText: 'Internal Server Error', text: 'deeplx says no' },
    { label: 'deeplxThrows', route: '/api/translate/deeplx', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('deeplx_url', TEST_URLS.deeplx), match: 'deeplx.example.test', throws: true },

    // ── /onering ────────────────────────────────────────────────────────────────────────────────
    { label: 'oneringDefaultUrl', route: '/api/translate/onering', body: '{"text":"hello","from_lang":"en","to_lang":"de"}', secrets: {}, match: '127.0.0.1:4990', payload: ONERING_OK },
    { label: 'oneringSecretUrl', route: '/api/translate/onering', body: '{"text":"hello","from_lang":"en","to_lang":"de"}', secrets: urlSecret('oneringtranslator_url', TEST_URLS.onering), match: 'onering.example.test', payload: ONERING_OK },
    { label: 'oneringNoFromLang', route: '/api/translate/onering', body: '{"text":"hello","to_lang":"de"}', secrets: urlSecret('oneringtranslator_url', TEST_URLS.onering), match: 'onering.example.test' },
    { label: 'oneringPtBR', route: '/api/translate/onering', body: '{"text":"hello","lang":"pt-BR","from_lang":"en","to_lang":"pt-BR"}', secrets: urlSecret('oneringtranslator_url', TEST_URLS.onering), match: 'onering.example.test', payload: ONERING_OK },
    { label: 'oneringNonOk', route: '/api/translate/onering', body: '{"text":"hello","from_lang":"en","to_lang":"de"}', secrets: urlSecret('oneringtranslator_url', TEST_URLS.onering), match: 'onering.example.test', status: 500, statusText: 'Internal Server Error', text: 'onering says no' },
    { label: 'oneringThrows', route: '/api/translate/onering', body: '{"text":"hello","from_lang":"en","to_lang":"de"}', secrets: urlSecret('oneringtranslator_url', TEST_URLS.onering), match: 'onering.example.test', throws: true },

    // ── /lingva ─────────────────────────────────────────────────────────────────────────────────
    { label: 'lingvaDefaultUrl', route: '/api/translate/lingva', body: '{"text":"hello","lang":"de"}', secrets: {}, match: 'lingva.ml', payload: LINGVA_OK },
    { label: 'lingvaSecretUrl', route: '/api/translate/lingva', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('lingva_url', TEST_URLS.lingva), match: 'lingva.example.test', payload: LINGVA_OK },
    { label: 'lingvaTrailingSlash', route: '/api/translate/lingva', body: '{"text":"hello world","lang":"de"}', secrets: urlSecret('lingva_url', `${TEST_URLS.lingva}/`), match: 'lingva.example.test', payload: LINGVA_OK },
    { label: 'lingvaZhCN', route: '/api/translate/lingva', body: '{"text":"hello","lang":"zh-CN"}', secrets: urlSecret('lingva_url', TEST_URLS.lingva), match: 'lingva.example.test', payload: LINGVA_OK },
    // A non-ok answer with valid JSON does NOT return early: the pinned handler only logs, then parses.
    { label: 'lingvaNonOkValidJSON', route: '/api/translate/lingva', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('lingva_url', TEST_URLS.lingva), match: 'lingva.example.test', status: 500, statusText: 'Internal Server Error', payload: LINGVA_OK },
    { label: 'lingvaNonOkInvalidJSON', route: '/api/translate/lingva', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('lingva_url', TEST_URLS.lingva), match: 'lingva.example.test', status: 500, statusText: 'Internal Server Error', raw: 'nope' },
    { label: 'lingvaThrows', route: '/api/translate/lingva', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('lingva_url', TEST_URLS.lingva), match: 'lingva.example.test', throws: true },

    // ── /deepl ──────────────────────────────────────────────────────────────────────────────────
    { label: 'deeplNoKey', route: '/api/translate/deepl', body: '{"text":"hello","lang":"de"}', secrets: {}, match: 'api-free.deepl.com' },
    { label: 'deeplFree', route: '/api/translate/deepl', body: '{"text":"hello","lang":"en"}', secrets: urlSecret('deepl', 'synthetic-deepl-key'), match: 'api-free.deepl.com', payload: DEEPL_OK },
    { label: 'deeplPro', route: '/api/translate/deepl', body: '{"text":"hello","lang":"en","endpoint":"pro"}', secrets: urlSecret('deepl', 'synthetic-deepl-key'), match: 'api.deepl.com', payload: DEEPL_OK },
    { label: 'deeplFormality', route: '/api/translate/deepl', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('deepl', 'synthetic-deepl-key'), match: 'api-free.deepl.com', payload: DEEPL_OK },
    { label: 'deeplNoFormalityForEnglish', route: '/api/translate/deepl', body: '{"text":"hello","lang":"en-US"}', secrets: urlSecret('deepl', 'synthetic-deepl-key'), match: 'api-free.deepl.com', payload: DEEPL_OK },
    { label: 'deeplZhCN', route: '/api/translate/deepl', body: '{"text":"hello","lang":"zh-CN"}', secrets: urlSecret('deepl', 'synthetic-deepl-key'), match: 'api-free.deepl.com', payload: DEEPL_OK },
    { label: 'deeplNoText', route: '/api/translate/deepl', body: '{"lang":"de"}', secrets: urlSecret('deepl', 'synthetic-deepl-key'), match: 'api-free.deepl.com' },
    { label: 'deeplNonOk', route: '/api/translate/deepl', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('deepl', 'synthetic-deepl-key'), match: 'api-free.deepl.com', status: 403, statusText: 'Forbidden', text: 'quota' },
    { label: 'deeplThrows', route: '/api/translate/deepl', body: '{"text":"hello","lang":"de"}', secrets: urlSecret('deepl', 'synthetic-deepl-key'), match: 'api-free.deepl.com', throws: true },

    // ── /yandex ─────────────────────────────────────────────────────────────────────────────────
    { label: 'yandexNoChunks', route: '/api/translate/yandex', body: '{"lang":"de"}', secrets: {}, match: 'translate.yandex.net' },
    { label: 'yandexChunks', route: '/api/translate/yandex', body: '{"chunks":["hello ","world"],"lang":"de"}', secrets: {}, match: 'translate.yandex.net', payload: YANDEX_OK },
    { label: 'yandexEmptyChunks', route: '/api/translate/yandex', body: '{"chunks":[],"lang":"de"}', secrets: {}, match: 'translate.yandex.net', payload: YANDEX_OK },
    { label: 'yandexZhCN', route: '/api/translate/yandex', body: '{"chunks":["hello"],"lang":"zh-CN"}', secrets: {}, match: 'translate.yandex.net', payload: YANDEX_OK },
    { label: 'yandexPtPT', route: '/api/translate/yandex', body: '{"chunks":["hello"],"lang":"pt-PT"}', secrets: {}, match: 'translate.yandex.net', payload: YANDEX_OK },
    { label: 'yandexNonOk', route: '/api/translate/yandex', body: '{"chunks":["hello"],"lang":"de"}', secrets: {}, match: 'translate.yandex.net', status: 500, statusText: 'Internal Server Error', text: 'yandex says no' },
    { label: 'yandexEmptyPayload', route: '/api/translate/yandex', body: '{"chunks":["hello"],"lang":"de"}', secrets: {}, match: 'translate.yandex.net', payload: {} },
];

// The Yandex ucid is a fresh uuidv4 per request, so it is the one nondeterministic value in this
// domain and is replaced by a marker in both the recorded outbound URL and the Go-side comparison.
const UCID_PATTERN = /ucid=[0-9a-f]{32}/g;
function normalizeUcid(value) {
    return typeof value === 'string' ? value.replace(UCID_PATTERN, 'ucid=<uuid>') : value;
}

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-translate-oracle-', mocks: [] });
const scenarios = {};
let bootOutbound = [];
try {
    bootOutbound = server.bootOutbound;
    for (const scenario of SCENARIOS) {
        const rule = {
            match: scenario.match,
            status: scenario.status ?? 200,
            statusText: scenario.statusText ?? 'OK',
            headers: { 'content-type': 'application/json' },
            body: scenario.raw ?? (scenario.text !== undefined ? scenario.text : JSON.stringify(scenario.payload ?? {})),
            throws: scenario.throws === true,
        };
        server.setMocks([rule]);
        server.writeSecrets(scenario.secrets);
        const result = await server.post(scenario.route, scenario.body);
        const requests = server.outbound();
        scenarios[scenario.label] = {
            route: scenario.route,
            requestBody: scenario.body,
            mocks: [rule],
            secrets: server.readSecrets(),
            response: captureHttp(result),
            outbound: requests.map(request => ({ url: normalizeUcid(request.url), method: request.method, headers: request.headers, body: request.body })),
        };
    }
} finally {
    await server.stop();
}

// ── assertions: each route's translation and outbound form, not merely its status ───────────────
assert.equal(scenarios.libreOk.response.status, 200, 'libre answers 200');
assert.equal(scenarios.libreOk.response.bodyText, 'Hallo Welt', 'libre answers json.translatedText as a plain string');
assert.equal(requireOutbound('libreOk', 0).method, 'POST', 'libre POSTs');
assert.deepEqual(JSON.parse(requireOutbound('libreOk', 0).body),
    { q: 'hello', source: 'auto', target: 'de', format: 'text', api_key: '' },
    'libre sends the pinned JSON body, including an EMPTY api_key when no key is configured');
assert.deepEqual(JSON.parse(requireOutbound('libreWithKey', 0).body).api_key, 'synthetic-libre-key',
    'libre sends the configured api_key');
assert.deepEqual(JSON.parse(requireOutbound('libreZhCN', 0).body).target, 'zh', 'libre maps zh-CN to zh');
assert.deepEqual(JSON.parse(requireOutbound('libreZhTW', 0).body).target, 'zt', 'libre maps zh-TW to zt');
assert.deepEqual(JSON.parse(requireOutbound('librePtBR', 0).body).target, 'pt', 'libre maps pt-BR to pt');
assert.equal(scenarios.libreEmptyPayload.response.bodyText, '', 'an absent translatedText sends an EMPTY body with 200');
assert.equal(scenarios.libreNonOk.response.status, 500, 'a non-ok libre peer answers 500');
assert.equal(scenarios.libreThrows.response.status, 500, 'a rejected libre fetch answers 500');
assert.equal(scenarios.libreNoUrl.response.status, 400, 'libre without a configured URL answers 400');
assert.equal(scenarios.libreNoUrl.outbound.length, 0, 'libre without a URL must not reach any peer');

assert.equal(requireOutbound('deeplxDefaultUrl', 0).url, `${DEFAULTS.deeplx}`, 'deeplx defaults to the pinned local URL');
assert.deepEqual(JSON.parse(requireOutbound('deeplxSecretUrl', 0).body),
    { text: 'hello', source_lang: 'auto', target_lang: 'de' }, 'deeplx sends the pinned JSON body');
assert.deepEqual(JSON.parse(requireOutbound('deeplxZhCN', 0).body).target_lang, 'ZH', 'deeplx maps zh-CN to ZH');
assert.equal(scenarios.deeplxNoText.response.status, 400, 'deeplx without text answers 400');

assert.equal(requireOutbound('oneringDefaultUrl', 0).url,
    `${DEFAULTS.onering}?text=hello&from_lang=en&to_lang=de`,
    'onering defaults to the pinned local URL and sends URLSearchParams as the query');
assert.equal(requireOutbound('oneringSecretUrl', 0).url,
    `${TEST_URLS.onering}?text=hello&from_lang=en&to_lang=de`,
    'onering uses the configured URL with the same ordered query');
assert.equal(scenarios.oneringNoFromLang.response.status, 400, 'onering without from_lang answers 400');
assert.equal(requireOutbound('oneringPtBR', 0).url.includes('to_lang=pt-BR'), true,
    'onering does not remap to_lang, only an unused lang variable');
assert.equal(scenarios.oneringNonOk.response.status, 500, 'a non-ok onering peer answers 500');

assert.equal(requireOutbound('lingvaDefaultUrl', 0).url, `${DEFAULTS.lingva}/auto/de/hello`,
    'lingva defaults to the pinned public URL and joins auto/lang/text');
assert.equal(requireOutbound('lingvaSecretUrl', 0).url, `${TEST_URLS.lingva}/auto/de/hello`,
    'lingva uses the configured URL');
assert.equal(requireOutbound('lingvaTrailingSlash', 0).url, `${TEST_URLS.lingva}/auto/de/hello%20world`,
    'url-join collapses the trailing slash and the text is encodeURIComponent-encoded');
assert.equal(requireOutbound('lingvaZhCN', 0).url, `${TEST_URLS.lingva}/auto/zh/hello`, 'lingva maps zh-CN to zh');
assert.equal(scenarios.lingvaNonOkValidJSON.response.status, 200,
    'a non-ok lingva answer with valid JSON is still parsed and returned');
assert.equal(scenarios.lingvaNonOkValidJSON.response.bodyText, 'Hallo Welt', 'the lingva translation is returned despite the peer status');
assert.equal(scenarios.lingvaNonOkInvalidJSON.response.status, 500, 'a non-ok lingva answer that is not JSON answers 500');
assert.equal(scenarios.lingvaThrows.response.status, 500, 'a rejected lingva fetch answers 500');

assert.equal(scenarios.deeplNoKey.response.status, 400, 'deepl without a key answers 400');
assert.equal(requireOutbound('deeplFree', 0).url, DEFAULTS.deeplFree, 'deepl uses the free endpoint by default');
assert.equal(requireOutbound('deeplPro', 0).url, DEFAULTS.deeplPro, 'endpoint:"pro" selects the paid endpoint');
assert.equal(requireOutbound('deeplFree', 0).body, 'text=hello&target_lang=en',
    'deepl form-encodes text and target_lang in that order, with no formality for "en"');
assert.equal(requireOutbound('deeplFormality', 0).body, 'text=hello&target_lang=de&formality=default',
    'deepl appends formality for a supported language, defaulting the config value to "default"');
assert.equal(requireOutbound('deeplNoFormalityForEnglish', 0).body, 'text=hello&target_lang=en-US',
    'deepl adds formality only for its supported language list');
assert.equal(requireOutbound('deeplZhCN', 0).body, 'text=hello&target_lang=ZH', 'deepl maps zh-CN to ZH');
assert.equal(requireOutbound('deeplFree', 0).headers.authorization, 'DeepL-Auth-Key synthetic-deepl-key',
    'deepl authenticates with the pinned scheme');
assert.equal(scenarios.deeplNonOk.response.status, 500, 'a non-ok deepl peer answers 500');

assert.equal(scenarios.yandexNoChunks.response.status, 400, 'yandex without chunks answers 400');
assert.equal(requireOutbound('yandexChunks', 0).body, 'text=hello+&text=world&lang=de',
    'yandex appends one text parameter per chunk, preserving order, then lang');
assert.equal(requireOutbound('yandexEmptyChunks', 0).body, 'lang=de',
    'an EMPTY chunks array is truthy, so the request carries only lang');
assert.equal(requireOutbound('yandexChunks', 0).url,
    `${DEFAULTS.yandex}?ucid=<uuid>&srv=android&format=text`,
    'the yandex URL carries a fresh ucid, normalized here');
assert.equal(requireOutbound('yandexZhCN', 0).body, 'text=hello&lang=zh', 'yandex maps zh-CN to zh');
assert.equal(requireOutbound('yandexPtPT', 0).body, 'text=hello&lang=pt', 'yandex maps pt-PT to pt');
assert.equal(scenarios.yandexChunks.response.bodyText, 'Hallo,Welt',
    'yandex joins the returned text array with a comma');
assert.equal(scenarios.yandexEmptyPayload.response.status, 500,
    'yandex with a payload that has no text array throws inside the handler, which answers 500');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-translate.mjs',
    pinnedSource: {
        'src/endpoints/translate.js:10-12': "DEEPLX_URL_DEFAULT / ONERING_URL_DEFAULT / LINGVA_DEFAULT defaults",
        'src/endpoints/translate.js:16-74': 'POST /libre: URL from libre_url secret, lang remapping, ordered JSON body',
        'src/endpoints/translate.js:103-157': 'POST /yandex: URLSearchParams with one text per chunk, ucid uuidv4',
        'src/endpoints/translate.js:159-201': 'POST /lingva: url-join(base, auto, lang, encodeURIComponent(text)); a non-ok answer is only logged',
        'src/endpoints/translate.js:203-263': 'POST /deepl: endpoint selection, formality only for supported languages',
        'src/endpoints/translate.js:265-320': 'POST /onering: query built from text/from_lang/to_lang',
        'src/endpoints/translate.js:322-376': 'POST /deeplx: ordered JSON body with source_lang auto',
    },
    mechanism: 'DeepL and Yandex hardcode their endpoint, so the pinned server runs with only its node-fetch module replaced by a controlled peer (tools/lib/pinned-outbound.mjs). Libre/DeepLX/OneRing/Lingva take the URL from a secret, so the probe points that secret at a test host and the Go side points it at a local listener.',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handler chooses 200/400/500 itself' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'Express and the pinned middleware stack set them' },
        { path: 'scenarios.*.response.bodyText', comparison: 'compared', reason: 'the translated text and the empty-body case are endpoint behaviour' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'constructed upstream URL, including defaults, url-join and the yandex ucid shape' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'exact JSON body or application/x-www-form-urlencoded string, including parameter ORDER' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'shape', reason: 'only the declared content-type/authorization headers are asserted' },
        { path: 'translated text', comparison: 'shape', reason: 'third-party content: the fixture supplies the peer payload and asserts the extraction' },
    ],
    normalizations: [
        'The Yandex ucid is a fresh uuidv4 per request, so it is replaced by <uuid> in the recorded outbound URL; it is the only nondeterministic value in this domain.',
        'The DeepL formality value comes from config (`deepl.formality`), which the probe does not configure, so the pinned default "default" is what is recorded. A configured formality is NOT pinned.',
        'Synthetic credentials only.',
    ],
    inputs: {
        testUrls: TEST_URLS,
        defaults: DEFAULTS,
        payloads: { libre: LIBRE_OK, deepl: DEEPL_OK, yandex: YANDEX_OK, lingva: LINGVA_OK, onering: ONERING_OK, deeplx: DEEPLX_OK },
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-translate.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);

// â”€â”€ Refusal guards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// An assertion that dereferences `outbound[0]` turns a fixture difference into a stack trace, and it
// would have been a SILENT PASS had the expected value also been undefined. Every dereference goes
// through requireOutbound, which REFUSES with the evidence needed to tell a probe defect from a product
// difference: the recorded status, the recorded body and the pinned server's own log tail.
function refuseProbe(message) {
    console.error('PROBE REFUSES: ' + message);
    try {
        const logs = typeof server !== 'undefined' && server && Array.isArray(server.logs) ? server.logs.join('') : '';
        console.error('pinned server log tail:');
        console.error(logs.slice(-4000));
    } catch (error) {
        console.error('could not read the pinned server log: ' + error);
    }
    process.exit(1);
}

function requireOutbound(label, index = 0) {
    const scenario = scenarios[label];
    if (!scenario) {
        refuseProbe(`scenario ${label} is missing from the recording`);
    }
    if (scenario.outbound.length <= index) {
        const response = scenario.response ?? {};
        const body = response.bodyText ?? response.sha256 ?? '';
        refuseProbe(`scenario ${label} recorded ${scenario.outbound.length} outbound request(s), so request ${index} cannot be compared`
            + ` | recorded status ${response.status}`
            + ` | recorded body ${String(body).slice(0, 500)}`
            + ` | scenario request body ${String(scenario.requestBody).slice(0, 300)}`);
    }
    return scenario.outbound[index];
}