#!/usr/bin/env node
// Capture the pinned /api/search/* behaviour against a controlled peer.
//
// The pinned routes hardcode their search-provider URLs, so `node-fetch` is replaced for the
// pinned process through tools/lib/pinned-outbound.mjs: the endpoint code runs unmodified and
// every outbound request it would have made is recorded verbatim (url, method, explicit headers,
// body). Routes whose URL comes from the request body (/searxng, /koboldcpp) are pointed at a
// placeholder peer origin; both this probe and the Go replay substitute their own local peer for
// the `<mock>` marker, so the recorded request shape is directly comparable.
//
// /api/search/visit is NOT probed and NOT implemented. The pinned route relies on
// getUntrustedRequestAgent(), the private-request-filter SSRF agent (DNS-resolved private-address
// blocking, per-hop redirect validation and rebinding pinning). GoTavern has no shared
// private-address transport policy yet; implementing the fetch route without it would be strictly
// less safe than pinned, and implementing a second route-local network policy would violate the
// single-outbound-policy rule. The reason is recorded in the fixture below.
//
// The Go replay asserts the recorded outbound requests including their EXPLICIT headers, plus the
// node-fetch wire defaults recorded in `nodeFetchWireDefaults` (verified independently by the
// committed SD wire capture tests/oracle/sillytavern-1.19.0-sd-routes.json, where the pinned server
// talked to a real local peer through node-fetch). `connection` stays shape-classified: it is the
// transport's framing, not the route's header.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-search.json label="search routes"

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, captureHttp, rawRequest, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-search.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COOKIE_SECRET = 'gotavern-pinned-search-cookie-secret';
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

const SECRETS = {
    api_key_serpapi: 'probe-serpapi-key',
    api_key_tavily: 'probe-tavily-key',
    api_key_serper: 'probe-serper-key',
    api_key_zai: 'probe-zai-key',
    api_key_koboldcpp: 'probe-koboldcpp-key',
    api_key_generic: 'probe-generic-key',
    api_key_mancer: 'probe-mancer-key',
};

// Placeholder peer origins. The pinned process is given these; the Go replay substitutes its own
// http mock, and the fixture stores the marker <mock> instead of either host.
const MOCK = '<mock>';
const PINNED_PEER = 'http://search-peer.example';

// Route -> URL seam, for the routes whose upstream is hardcoded. /searxng and /koboldcpp take
// their URL from the request body and have no seam.
const SEAMS = {
    serpapi: 'GOTAVERN_SEARCH_SERPAPI_URL',
    transcript: 'GOTAVERN_SEARCH_YOUTUBE_URL',
    tavily: 'GOTAVERN_SEARCH_TAVILY_URL',
    serper: 'GOTAVERN_SEARCH_SERPER_URL',
    zai: 'GOTAVERN_SEARCH_ZAI_URL',
};
const SEAM_DEFAULTS = {
    GOTAVERN_SEARCH_SERPAPI_URL: 'https://serpapi.com',
    GOTAVERN_SEARCH_YOUTUBE_URL: 'https://www.youtube.com',
    GOTAVERN_SEARCH_TAVILY_URL: 'https://api.tavily.com',
    GOTAVERN_SEARCH_SERPER_URL: 'https://google.serper.dev',
    GOTAVERN_SEARCH_ZAI_URL: 'https://api.z.ai',
};


// The pinned secrets file stores each key as an array of {id, value, label, active} entries;
// readSecret returns '' for a plain-string value, which is how the first probe run's 400s arose.
function secretFile(values) {
    const secrets = {};
    for (const [key, value] of Object.entries(values)) {
        secrets[key] = [{ id: `probe-id-${key}`, value, label: key, active: true }];
    }
    return secrets;
}

function materialize(value) {
    if (typeof value === 'string') return value.split(MOCK).join(PINNED_PEER);
    if (Array.isArray(value)) return value.map(materialize);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) result[key] = materialize(item);
        return result;
    }
    return value;
}

function normalize(value) {
    if (typeof value === 'string') {
        return value.split(PINNED_PEER).join(MOCK);
    }
    return value;
}

// node-fetch lowercases header names and sorts the final set; the stub records the explicit
// header object before node-fetch adds its defaults, so sort here to model the wire order.
function explicitHeaders(headers) {
    return Object.entries(headers ?? {})
        .map(([name, value]) => [String(name).toLowerCase(), String(value)])
        .sort((left, right) => left[0].localeCompare(right[0]));
}

function captureResponse(result) {
    return {
        status: result.response.status,
        contentType: normalize(result.response.headers.get('content-type') ?? '') || null,
        contentLength: result.response.headers.get('content-length'),
        etag: result.response.headers.get('etag'),
        body: normalize(result.text),
    };
}

function comparison() {
    return {
        compared: ['status', 'contentType', 'contentLength', 'etag', 'body', 'outbound'],
        shape: ['outbound[].transportConnection'],
        shapeReason: {
            'outbound[].transportConnection': 'the stub records the headers the route passed, not the transport Connection Node would append; the value is a property of the shared outbound client, so the replay asserts presence only. Routes that DO set Connection explicitly (visitHeaders) have it in explicitHeaders and it is compared there',
        },
    };
}

const scenarios = [];
function addScenario(definition) {
    scenarios.push(definition);
}

// ---- /serpapi -----------------------------------------------------------------------------
addScenario({
    name: 'serpapi.ok',
    route: 'serpapi',
    body: { query: 'cats & dogs' },
    upstream: [{
        method: 'GET', path: '/search.json', status: 200,
        body: JSON.stringify({ search_metadata: { status: 'Success' }, organic_results: [{ title: 'Cats', link: 'https://example.com/cats' }] }),
    }],
});
addScenario({
    name: 'serpapi.noKey',
    route: 'serpapi',
    body: { query: 'cats' },
    secrets: { ...SECRETS, api_key_serpapi: '' },
});
addScenario({
    name: 'serpapi.nonOk',
    route: 'serpapi',
    body: { query: 'cats' },
    upstream: [{ method: 'GET', path: '/search.json', status: 500, body: 'serpapi exploded' }],
});
addScenario({
    name: 'serpapi.notJson',
    route: 'serpapi',
    body: { query: 'cats' },
    upstream: [{ method: 'GET', path: '/search.json', status: 200, body: 'this is not json' }],
});
addScenario({
    name: 'serpapi.coercedQuery',
    route: 'serpapi',
    body: { query: ['a', 'b'] },
    upstream: [{ method: 'GET', path: '/search.json', status: 200, body: '{}' }],
});

// ---- /transcript --------------------------------------------------------------------------
function videoPage({ captions = true, tracks, recaptcha = false, playability = true } = {}) {
    const parts = ['<html><head></head><body>'];
    if (recaptcha) parts.push('<div class="g-recaptcha"></div>');
    if (playability) parts.push('<script>var ytInitialPlayerResponse = {"playabilityStatus":{"status":"OK"}');
    if (captions) {
        const trackList = tracks ?? [
            { languageCode: 'en', baseUrl: `${MOCK}/track?lang=en` },
            { languageCode: 'de', baseUrl: `${MOCK}/track?lang=de` },
        ];
        const payload = { playerCaptionsTracklistRenderer: { captionTracks: trackList } };
        parts.push(',"captions":' + JSON.stringify(payload) + ',"videoDetails":{"videoId":"abc"}');
    }
    parts.push('};</script></body></html>');
    return parts.join('');
}

const transcriptXml = [
    '<transcript>',
    '<text start="0.5" dur="1.25">Hello &amp;amp; welcome</text>',
    '<text start="2" dur="0.75">&#39;second&#39; line</text>',
    '</transcript>',
].join('');

addScenario({
    name: 'transcript.ok',
    route: 'transcript',
    body: { id: 'abc' },
    upstream: [
        { method: 'GET', path: '/watch', status: 200, headers: { 'content-type': 'text/html' }, body: videoPage() },
        { method: 'GET', path: '/track', status: 200, body: transcriptXml },
    ],
});
addScenario({
    name: 'transcript.jsonOk',
    route: 'transcript',
    body: { id: 'abc', json: true },
    upstream: [
        { method: 'GET', path: '/watch', status: 200, headers: { 'content-type': 'text/html' }, body: videoPage() },
        { method: 'GET', path: '/track', status: 200, body: transcriptXml },
    ],
});
addScenario({
    name: 'transcript.lang',
    route: 'transcript',
    body: { id: 'abc', lang: 'de', json: true },
    upstream: [
        { method: 'GET', path: '/watch', status: 200, headers: { 'content-type': 'text/html' }, body: videoPage() },
        { method: 'GET', path: '/track', status: 200, body: transcriptXml },
    ],
});
addScenario({
    name: 'transcript.langMissing',
    route: 'transcript',
    body: { id: 'abc', lang: 'fr', json: true },
    upstream: [
        { method: 'GET', path: '/watch', status: 200, headers: { 'content-type': 'text/html' }, body: videoPage() },
    ],
});
addScenario({
    name: 'transcript.noCaptionsJson',
    route: 'transcript',
    body: { id: 'abc', json: true },
    upstream: [{ method: 'GET', path: '/watch', status: 200, headers: { 'content-type': 'text/html' }, body: videoPage({ captions: false }) }],
});
addScenario({
    name: 'transcript.noCaptionsThrows',
    route: 'transcript',
    body: { id: 'abc' },
    upstream: [{ method: 'GET', path: '/watch', status: 200, headers: { 'content-type': 'text/html' }, body: videoPage({ captions: false }) }],
});
addScenario({
    name: 'transcript.recaptcha',
    route: 'transcript',
    body: { id: 'abc' },
    upstream: [{ method: 'GET', path: '/watch', status: 200, headers: { 'content-type': 'text/html' }, body: videoPage({ captions: false, recaptcha: true }) }],
});
addScenario({
    name: 'transcript.captionNonOk',
    route: 'transcript',
    body: { id: 'abc' },
    upstream: [
        { method: 'GET', path: '/watch', status: 200, headers: { 'content-type': 'text/html' }, body: videoPage() },
        { method: 'GET', path: '/track', status: 500, body: 'nope' },
    ],
});
addScenario({
    name: 'transcript.missingId',
    route: 'transcript',
    body: { id: '', json: true },
});

// ---- /searxng -----------------------------------------------------------------------------
const searxngMain = '<html><head><link href="/client.1234.css" rel="stylesheet"></head><body>searxng</body></html>';
addScenario({
    name: 'searxng.ok',
    route: 'searxng',
    body: { baseUrl: MOCK, query: 'cats & dogs', preferences: 'p q', categories: 'general' },
    upstream: [
        { method: 'GET', match: '/client.1234.css', path: '/client.1234.css', status: 200, headers: { 'content-type': 'text/css' }, body: 'body{}' },
        { method: 'GET', match: '/search?', path: '/search', status: 200, headers: { 'content-type': 'text/html' }, body: '<html>results</html>' },
        { method: 'GET', match: `${PINNED_PEER}/`, path: '/', status: 200, headers: { 'content-type': 'text/html' }, body: searxngMain },
    ],
});
addScenario({
    name: 'searxng.noClientHref',
    route: 'searxng',
    body: { baseUrl: MOCK, query: 'cats' },
    upstream: [
        { method: 'GET', match: '/search?', path: '/search', status: 200, headers: { 'content-type': 'text/html' }, body: 'results' },
        { method: 'GET', match: `${PINNED_PEER}/`, path: '/', status: 200, headers: { 'content-type': 'text/html' }, body: '<html>plain</html>' },
    ],
});
addScenario({
    name: 'searxng.missingParams',
    route: 'searxng',
    body: { baseUrl: MOCK },
});
addScenario({
    name: 'searxng.invalidBaseUrl',
    route: 'searxng',
    body: { baseUrl: 'not a url', query: 'cats' },
});
addScenario({
    name: 'searxng.mainNonOk',
    route: 'searxng',
    body: { baseUrl: MOCK, query: 'cats' },
    upstream: [{ method: 'GET', path: '/', status: 500, body: 'nope' }],
});
addScenario({
    name: 'searxng.searchNonOk',
    route: 'searxng',
    body: { baseUrl: MOCK, query: 'cats' },
    upstream: [
        { method: 'GET', match: '/client.1234.css', path: '/client.1234.css', status: 200, headers: { 'content-type': 'text/css' }, body: 'body{}' },
        { method: 'GET', match: '/search?', path: '/search', status: 500, body: 'nope' },
        { method: 'GET', match: `${PINNED_PEER}/`, path: '/', status: 200, headers: { 'content-type': 'text/html' }, body: searxngMain },
    ],
});

// ---- /tavily ------------------------------------------------------------------------------
addScenario({
    name: 'tavily.ok',
    route: 'tavily',
    body: { query: 'cats', include_images: true },
    upstream: [{ method: 'POST', path: '/search', status: 200, body: JSON.stringify({ answer: 'cats', results: [] }) }],
});
addScenario({
    name: 'tavily.noKey',
    route: 'tavily',
    body: { query: 'cats' },
    secrets: { ...SECRETS, api_key_tavily: '' },
});
addScenario({
    name: 'tavily.nonOk',
    route: 'tavily',
    body: { query: 'cats' },
    upstream: [{ method: 'POST', path: '/search', status: 500, body: 'tavily exploded' }],
});
addScenario({
    name: 'tavily.includeImagesTruthiness',
    route: 'tavily',
    body: { query: 'cats', include_images: 'yes' },
    upstream: [{ method: 'POST', path: '/search', status: 200, body: '{}' }],
});

// ---- /koboldcpp ---------------------------------------------------------------------------
addScenario({
    name: 'koboldcpp.ok',
    route: 'koboldcpp',
    body: { query: 'cats', url: `${MOCK}/v1`, api_type: 'koboldcpp' },
    upstream: [{ method: 'POST', path: '/api/extra/websearch', status: 200, body: JSON.stringify({ results: [{ title: 'Cats' }] }) }],
});
addScenario({
    name: 'koboldcpp.genericType',
    route: 'koboldcpp',
    body: { query: 'cats', url: `${MOCK}/`, api_type: 'generic' },
    upstream: [{ method: 'POST', path: '/api/extra/websearch', status: 200, body: '{}' }],
});
addScenario({
    name: 'koboldcpp.mancerType',
    route: 'koboldcpp',
    body: { query: 'cats', url: MOCK, api_type: 'mancer' },
    upstream: [{ method: 'POST', path: '/api/extra/websearch', status: 200, body: '{}' }],
});
addScenario({
    name: 'koboldcpp.noUrl',
    route: 'koboldcpp',
    body: { query: 'cats' },
});
addScenario({
    name: 'koboldcpp.nonOk',
    route: 'koboldcpp',
    body: { query: 'cats', url: MOCK },
    upstream: [{ method: 'POST', path: '/api/extra/websearch', status: 500, body: 'kobold exploded' }],
});

// ---- /serper ------------------------------------------------------------------------------
addScenario({
    name: 'serper.ok',
    route: 'serper',
    body: { query: 'cats' },
    upstream: [{ method: 'POST', path: '/search', status: 200, body: JSON.stringify({ organic: [] }) }],
});
addScenario({
    name: 'serper.images',
    route: 'serper',
    body: { query: 'cats', images: true },
    upstream: [{ method: 'POST', path: '/images', status: 200, body: '{"images":[]}' }],
});
addScenario({
    name: 'serper.noKey',
    route: 'serper',
    body: { query: 'cats' },
    secrets: { ...SECRETS, api_key_serper: '' },
});
addScenario({
    name: 'serper.nonOk',
    route: 'serper',
    body: { query: 'cats' },
    upstream: [{ method: 'POST', path: '/search', status: 500, body: 'serper exploded' }],
});

// ---- /zai ---------------------------------------------------------------------------------
addScenario({
    name: 'zai.ok',
    route: 'zai',
    body: { query: 'cats' },
    upstream: [{ method: 'POST', path: '/api/paas/v4/web_search', status: 200, body: '{"search_result":[]}' }],
});
addScenario({
    name: 'zai.noKey',
    route: 'zai',
    body: { query: 'cats' },
    secrets: { ...SECRETS, api_key_zai: '' },
});
addScenario({
    name: 'zai.noQuery',
    route: 'zai',
    body: {},
});
addScenario({
    name: 'zai.nonOk',
    route: 'zai',
    body: { query: 'cats' },
    upstream: [{ method: 'POST', path: '/api/paas/v4/web_search', status: 500, body: 'zai exploded' }],
});

// ---- fixture assembly ---------------------------------------------------------------------

function stubRule(upstream) {
    return {
        match: upstream.match ?? upstream.path,
        status: upstream.status,
        headers: upstream.headers ?? {},
        body: upstream.body,
    };
}

async function main() {
    const server = await startPinnedProviderServer({
        sourceRoot,
        prefix: 'gotavern-search-oracle-',
        mocks: [],
    });
    try {
        server.writeSecrets(secretFile(SECRETS));
        const observations = {};
        const inputs = {};
        for (const scenario of scenarios) {
            const secrets = scenario.secrets ?? SECRETS;
            server.writeSecrets(secretFile(secrets));
            server.setMocks((scenario.upstream ?? []).map(stubRule));
            const body = materialize(scenario.body ?? {});
            const result = await server.post(`/api/search/${scenario.route}`, JSON.stringify(body));
            const outbound = server.outbound().map(request => ({
                url: normalize(request.url),
                method: request.method,
                explicitHeaders: explicitHeaders(request.headers),
                body: normalize(request.body ?? ''),
            }));
            const captured = captureResponse(result);
            const scenarioComparison = comparison();
            if (captured.body.includes(MOCK)) {
                // The recorded response echoes the placeholder peer origin (the transcript route
                // returns the video page). Its length differs from the Go replay's own mock
                // authority, so the framing fields cannot be compared literally; the body is
                // compared after both sides normalise the origin back to <mock>.
                scenarioComparison.compared = scenarioComparison.compared.filter(key => key !== 'contentLength' && key !== 'etag');
                scenarioComparison.shape.push('contentLength', 'etag');
                scenarioComparison.shapeReason.contentLength = 'the response body embeds the <mock> peer origin, whose byte length differs from the replay mock authority';
                scenarioComparison.shapeReason.etag = 'the ETag is derived from the same origin-bearing body';
            }
            observations[scenario.name] = {
                ...captured,
                outbound,
                comparison: scenarioComparison,
            };
            inputs[scenario.name] = {
                route: scenario.route,
                body: scenario.body ?? {},
                seam: SEAMS[scenario.route] ?? null,
                secretKeys: Object.keys(secrets).sort(),
                secrets,
                upstream: scenario.upstream ?? [],
            };
        }

        const knownDifferences = [{
            route: '/api/search/visit',
            status: 'not implemented',
            reason: 'the pinned route fetches an arbitrary caller-supplied URL through getUntrustedRequestAgent(), the private-request-filter SSRF agent (DNS-resolved private-address blocking, per-hop redirect validation, rebinding pinning); GoTavern has no shared private-address transport policy yet, so implementing the route now would be strictly less safe than pinned, and a route-local dial policy would violate the single-outbound-policy rule. The route is therefore absent rather than faked.',
        }];

        const fixture = {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned /api/search/* routes driven against a controlled peer through the pinned-outbound node-fetch replacement',
            oracle: { file: 'src/endpoints/search.js', mountedAt: '/api/search (src/server-startup.js:175)' },
            conventions: {
                mock: 'body-URL and page-URL peers are recorded as the <mock> marker; the Go replay substitutes its own local mock origin',
                outboundHeaderModel: 'explicitHeaders are the header object the route passed, lowercased and sorted as node-fetch sends them; nodeFetchWireDefaults are the defaults node-fetch adds and are asserted separately',
            },
            nodeFetchWireDefaults: {
                headers: [['accept', '*/*'], ['accept-encoding', 'gzip, deflate, br'], ['user-agent', 'node-fetch']],
                verifiedBy: 'tests/oracle/sillytavern-1.19.0-sd-routes.json records the same defaults on the pinned wire against a real local peer (tools/probe-sd-routes.mjs)',
            },
            fixtureFields: {
                compared: ['observations.*.status', 'observations.*.contentType', 'observations.*.contentLength', 'observations.*.etag', 'observations.*.body', 'observations.*.outbound[] (url, method, explicitHeaders, body)', 'nodeFetchWireDefaults.headers'],
                shape: ['observations.*.outbound[].connection'],
                notRecorded: ['the ephemeral peer authority', 'the pinned server listen port', 'startup log'],
            },
            inputs: {
                cookieSecret: COOKIE_SECRET,
                account: { handle: 'default-user', name: 'Search Probe', admin: true, password: '' },
                userAgent: USER_AGENT,
                seamDefaults: SEAM_DEFAULTS,
                scenarios: inputs,
            },
            observations,
            knownDifferences,
        };
        writeFixture(repositoryRoot, 'sillytavern-1.19.0-search.json', fixture);
        console.log('Wrote tests/oracle/sillytavern-1.19.0-search.json from pinned /api/search behaviour');
    } finally {
        await server.stop();
    }
}

await main();
