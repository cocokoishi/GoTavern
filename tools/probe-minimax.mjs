#!/usr/bin/env node
// Capture the pinned MiniMax text-to-speech route:
//
//	POST /api/minimax/generate-voice  minimax.js:19
//
// EIGHT destructuring initializers on the request body's own members
// (apiHost, model, speed, volume, pitch, audioSampleRate, bitrate, format). Every one of them is
// observable: with the member ABSENT the request carries the pinned literal, with it PRESENT the
// request carries the caller's value. One scenario per default therefore exists here in BOTH
// directions — `voice.defaults` (all eight absent) plus eight `voice.<member>` scenarios that set
// exactly one member and leave the other seven to their defaults, so a mutated default for member X
// fails scenario X and nothing else.
//
// A destructuring initializer fires on `undefined` ONLY, which is not the same rule as `||`: a
// `null` or an empty string is used verbatim and produces `/v1/t2a_v2` or `null/v1/t2a_v2` — a
// relative URL node-fetch rejects, so the route answers 500 "Internal server error". The
// `voice.explicitNull*` scenarios record that difference instead of assuming the `||` reading.
//
// `Number()` is applied to speed/volume/pitch/audioSampleRate/bitrate, and JSON.stringify renders
// NaN as null; `voice.coercions` records it. `format` is used verbatim in the body AND selects the
// response MIME type through a `|| 'audio/mpeg'` fallback table.
//
// The upstream host is a hardcoded literal (`apiHost = 'https://api.minimax.io'`), so node-fetch is
// replaced for the pinned process by tools/lib/pinned-outbound.mjs: the endpoint code runs
// unmodified, BOTH the request and the response are captured from the controlled peer, and an
// unmatched URL answers a synthesized error rather than reaching the internet. Every scenario
// asserts the number of requests the peer recorded, so a request that escapes the stub shows up as
// a MISSING capture rather than as plausible data.
//
// HOST-DEPENDENCE: nothing here is host-derived. The peer origin is recorded as the `<mock>` marker
// (the Go replay substitutes its own listener), the connection-failure scenarios use `<closed>`
// (a real bound-then-closed local port on the Go side), and the audio payload is a synthetic byte
// string, never a live third-party answer.
//
// @gotavern-oracle: this declaration is read by tools/build-generated-lib.mjs,
// which auto-discovers probes so that adding one needs no edit there.
// @gotavern-oracle: fixture=sillytavern-1.19.0-minimax.json label="MiniMax generate-voice"

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import {
    PINNED_COMMIT, PINNED_VERSION, rawRequest, stableHeaders, startPinnedProviderServer, writeFixture,
} from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-minimax.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COOKIE_SECRET = 'gotavern-pinned-minimax-cookie-secret';
const API_KEY = 'probe-minimax-key';
const SECRETS = { api_key_minimax: API_KEY };

// Placeholder origins. The pinned process is given these; the Go replay substitutes its own
// listener (for <mock>) or a real bound-then-closed port (for <closed>), and the fixture stores the
// markers instead of either host.
const MOCK = '<mock>';
const CLOSED = '<closed>';
const PINNED_PEER = 'http://minimax-peer.example';
const PINNED_CLOSED = 'http://minimax-closed.invalid';

// The seam the Go implementation carries so its DEFAULT (the pinned literal) can be redirected at a
// local peer. The fixture records the pinned literal so the default cannot drift silently.
const SEAM_DEFAULTS = { GOTAVERN_MINIMAX_API_URL: 'https://api.minimax.io' };

// A deterministic synthetic audio payload. The route hex-decodes the provider's answer, so the
// response bytes are a function of this string and nothing else.
const AUDIO = Buffer.from('gotavern-minimax-synthetic-voice-payload', 'utf8');
const AUDIO_HEX = AUDIO.toString('hex');
const spacedHex = value => value.match(/.{1,8}/g).join(' ');

function secretFile(values) {
    const secrets = {};
    for (const [key, value] of Object.entries(values)) {
        secrets[key] = [{ id: `probe-id-${key}`, value, label: key, active: true }];
    }
    return secrets;
}

function materialize(value) {
    if (typeof value === 'string') {
        return value.split(MOCK).join(PINNED_PEER).split(CLOSED).join(PINNED_CLOSED);
    }
    if (Array.isArray(value)) return value.map(materialize);
    if (value && typeof value === 'object') {
        const result = {};
        for (const [key, item] of Object.entries(value)) result[key] = materialize(item);
        return result;
    }
    return value;
}

function normalize(value) {
    if (typeof value !== 'string') return value;
    return value.split(PINNED_PEER).join(MOCK).split(PINNED_CLOSED).join(CLOSED);
}

// node-fetch lowercases header names and sends the sorted set; the stub records the header object
// the route passed, so sort here to model the wire order the provider observes.
function explicitHeaders(headers) {
    return Object.entries(headers ?? {})
        .map(([name, value]) => [String(name).toLowerCase(), String(value)])
        .sort((left, right) => left[0].localeCompare(right[0]));
}

const TEXT = 'hello there';
const VOICE = 'female-shaonv';

// The eight defaulted members, in the order the pinned destructuring lists them.
const DEFAULTED = ['apiHost', 'model', 'speed', 'volume', 'pitch', 'audioSampleRate', 'bitrate', 'format'];

const scenarios = [];
function addScenario(definition) {
    scenarios.push(definition);
}

const okPayload = extra => JSON.stringify({
    data: { audio: AUDIO_HEX },
    base_resp: { status_code: 0, status_msg: 'success' },
    ...extra,
});
const jsonRule = (body, status = 200) => ({
    status, headers: { 'content-type': 'application/json' }, body,
});
const miniMaxRule = (body, status = 200) => ({
    match: '/v1/t2a_v2', status, headers: { 'content-type': 'application/json' }, body,
});
// `body` is the request body; `<mock>` in an apiHost is the placeholder peer.
const voice = (name, extra = {}, options = {}) => {
    const definition = {
        name,
        body: { apiHost: MOCK, text: TEXT, voiceId: VOICE, ...(extra.body ?? {}) },
        // Every scenario built here names its host in the body; only `voice.defaults` omits apiHost,
        // and it declares urlSource: 'seam' itself.
        urlSource: 'body',
        upstream: extra.upstream ?? [miniMaxRule(okPayload())],
        expectedOutbound: 1,
        ...options,
    };
    for (const member of DEFAULTED) {
        if (extra.body && member in extra.body) definition.overrides = [...(definition.overrides ?? []), member];
    }
    addScenario(definition);
    return definition;
};

// ---- the eight defaults, both directions -------------------------------------------------------
// `voice.defaults` omits apiHost TOO, so it is the only scenario that exercises the host literal.
addScenario({
    name: 'voice.defaults',
    body: { text: TEXT, voiceId: VOICE },
    urlSource: 'seam',
    upstream: [miniMaxRule(okPayload())],
    expectedOutbound: 1,
    overrides: [],
});
voice('voice.apiHost', { body: { apiHost: `${MOCK}/tts` } });
voice('voice.model', { body: { model: 'speech-01-turbo' } });
voice('voice.speed', { body: { speed: 0.35 } });
voice('voice.volume', { body: { volume: 7 } });
voice('voice.pitch', { body: { pitch: 1.25 } });
voice('voice.audioSampleRate', { body: { audioSampleRate: 16000 } });
voice('voice.bitrate', { body: { bitrate: 64000 } });
voice('voice.format', { body: { format: 'wav' } });

// A relative URL is what a `||`-reading would never produce: the initializer does not fire for
// null or '', so the concatenation is `null/v1/t2a_v2` / `/v1/t2a_v2`, and the real node-fetch
// rejects a non-absolute URL with a TypeError that the route's outer catch turns into
// 500 "Internal server error". The stub is told to THROW for those exact targets, because a real
// node-fetch cannot be reached through it; the observable (the status and the body) is identical to
// the pinned rejection, and the recorded target still proves the concatenation.
voice('voice.explicitNullHost', { body: { apiHost: null } }, {
    upstream: [{ match: 'null/v1/t2a_v2', throws: true }],
    expectedOutbound: 1,
    unreachableOutbound: 1,
});
voice('voice.emptyHost', { body: { apiHost: '' } }, {
    upstream: [{ match: '/v1/t2a_v2', throws: true }],
    expectedOutbound: 1,
    unreachableOutbound: 1,
});

// The URL is built by plain concatenation, so a trailing slash doubles the separator.
voice('voice.hostTrailingSlash', { body: { apiHost: `${MOCK}/` } });

// `||` fallbacks and unexercised-by-default members.
voice('voice.formatUnknown', { body: { format: 'ogg' } });
voice('voice.language', { body: { language: 'zh' } });
voice('voice.languageEmpty', { body: { language: '' } });
voice('voice.coercions', {
    body: { speed: 'fast', volume: null, pitch: true, audioSampleRate: '8000', bitrate: [], model: 5, format: 42 },
});
voice('voice.reservedText', {
    body: { text: 'a/b?c&d=e#f%20g "quoted" ünïcode', voiceId: 'voice/id with space' },
});
voice('voice.sampleRateFloat', { body: { audioSampleRate: 22050.5, bitrate: 1e5 } });

// ---- required parameters (no outbound) ---------------------------------------------------------
addScenario({
    name: 'voice.missingText',
    body: { apiHost: MOCK, voiceId: VOICE },
    urlSource: 'body', upstream: [], expectedOutbound: 0,
});
addScenario({
    name: 'voice.emptyText',
    body: { apiHost: MOCK, text: '', voiceId: VOICE },
    urlSource: 'body', upstream: [], expectedOutbound: 0,
});
addScenario({
    name: 'voice.missingVoiceId',
    body: { apiHost: MOCK, text: TEXT },
    urlSource: 'body', upstream: [], expectedOutbound: 0,
});
addScenario({
    name: 'voice.missingKey',
    body: { apiHost: MOCK, text: TEXT, voiceId: VOICE },
    urlSource: 'body', upstream: [], expectedOutbound: 0,
    secrets: {},
});

// ---- non-ok upstream answers: the error-message taxonomy ---------------------------------------
const nonOk = (name, status, body, headers = { 'content-type': 'application/json' }) => {
    addScenario({
        name,
        body: { apiHost: MOCK, text: TEXT, voiceId: VOICE },
        urlSource: 'body',
        upstream: [{ match: '/v1/t2a_v2', status, headers, body }],
        expectedOutbound: 1,
    });
};
nonOk('voice.upstream.json1004', 401, JSON.stringify({ base_resp: { status_code: 1004, status_msg: 'auth' } }));
nonOk('voice.upstream.jsonOtherStatus', 400, JSON.stringify({ base_resp: { status_code: 1002, status_msg: 'rate limited' } }));
nonOk('voice.upstream.errorEnvelope', 500, JSON.stringify({ error: { message: 'boom' } }));
nonOk('voice.upstream.messageEnvelope', 502, JSON.stringify({ message: 'bad gateway twice' }));
nonOk('voice.upstream.detailEnvelope', 503, JSON.stringify({ detail: 'detail wins next' }));
nonOk('voice.upstream.plainText', 500, 'plain failure', { 'content-type': 'text/plain' });
nonOk('voice.upstream.jsonString', 503, JSON.stringify('just a string'));
nonOk('voice.upstream.largeText', 500, 'x'.repeat(600), { 'content-type': 'text/plain' });
nonOk('voice.upstream.largeJsonFallthrough', 500, JSON.stringify({ note: 'y'.repeat(600) }));
// A body that is valid JSON but not ok: the code path is the SAME as a non-ok answer's JSON parse.
addScenario({
    name: 'voice.response.notJson',
    body: { apiHost: MOCK, text: TEXT, voiceId: VOICE },
    urlSource: 'body',
    upstream: [{ match: '/v1/t2a_v2', status: 200, headers: { 'content-type': 'text/plain' }, body: 'not json at all' }],
    expectedOutbound: 1,
});
addScenario({
    name: 'voice.response.arrayPayload',
    body: { apiHost: MOCK, text: TEXT, voiceId: VOICE },
    urlSource: 'body',
    upstream: [miniMaxRule(JSON.stringify([1, 2, 3]))],
    expectedOutbound: 1,
});

// ---- base_resp error codes inside a 200 answer -------------------------------------------------
const successWith = (name, payload) => {
    addScenario({
        name,
        body: { apiHost: MOCK, text: TEXT, voiceId: VOICE },
        urlSource: 'body',
        upstream: [miniMaxRule(JSON.stringify(payload))],
        expectedOutbound: 1,
    });
};
successWith('voice.baseResp.1004', { data: { audio: AUDIO_HEX }, base_resp: { status_code: 1004, status_msg: 'auth' } });
successWith('voice.baseResp.other', { data: { audio: AUDIO_HEX }, base_resp: { status_code: 1002, status_msg: 'quota' } });
successWith('voice.baseResp.noStatusMsg', { data: { audio: AUDIO_HEX }, base_resp: { status_code: 1 } });
// `baseResp.status_code !== 0` is a STRICT comparison: the string "0" is not the number 0, so a
// string status is an error even though it reads as success.
successWith('voice.baseResp.stringZero', { data: { audio: AUDIO_HEX }, base_resp: { status_code: '0', status_msg: 'string zero' } });
successWith('voice.baseResp.nullCode', { data: { audio: AUDIO_HEX }, base_resp: { status_code: null, status_msg: 'null code' } });

// ---- audio payload shapes ---------------------------------------------------------------------
const hexPayload = (name, hex, format) => {
    addScenario({
        name,
        body: { apiHost: MOCK, text: TEXT, voiceId: VOICE, ...(format ? { format } : {}) },
        urlSource: 'body',
        upstream: [miniMaxRule(JSON.stringify({ data: { audio: hex }, base_resp: { status_code: 0 } }))],
        expectedOutbound: 1,
    });
};
hexPayload('voice.hex.prefixedSpaced', `0x${spacedHex(AUDIO_HEX)}`);
hexPayload('voice.hex.oddLength', 'abc');
hexPayload('voice.hex.uppercase', AUDIO_HEX.toUpperCase(), 'flac');
hexPayload('voice.hex.newlines', `${AUDIO_HEX.slice(0, 10)}\n\t ${AUDIO_HEX.slice(10)}`, 'aac');
// `'0x'.replace(/^0x/,'')` is the empty string, which is TRUTHY at the guard and then fails the
// `.{1,2}` match, so it reaches 'Invalid hex string format' rather than the empty-audio message.
hexPayload('voice.hex.prefixOnly', '0x');
hexPayload('voice.hex.whitespaceOnly', '   ');
hexPayload('voice.hex.invalidChar', '0xzz');
hexPayload('voice.hex.mixedCasePrefix', `0X${AUDIO_HEX}`);
successWith('voice.audioNonString', { data: { audio: 5 }, base_resp: { status_code: 0 } });
successWith('voice.audioEmptyString', { data: { audio: '' }, base_resp: { status_code: 0 } });
successWith('voice.noData', { base_resp: { status_code: 0 } });
successWith('voice.emptyDataObject', { data: {}, base_resp: { status_code: 0 } });
successWith('voice.dataIsString', { data: 'nope', base_resp: { status_code: 0 } });
successWith('voice.noBaseRespEmpty', {});

// ---- the URL branch: a SECOND outbound request ------------------------------------------------
addScenario({
    name: 'voice.url.ok',
    body: { apiHost: MOCK, text: TEXT, voiceId: VOICE, format: 'wav' },
    urlSource: 'body',
    upstream: [
        miniMaxRule(JSON.stringify({ data: { url: `${MOCK}/audio/clip.bin` }, base_resp: { status_code: 0 } })),
        { match: '/audio/clip.bin', status: 200, headers: { 'content-type': 'application/octet-stream' }, body: AUDIO.toString('utf8'), binaryBody: false },
    ],
    expectedOutbound: 2,
});
addScenario({
    name: 'voice.url.nonOk',
    body: { apiHost: MOCK, text: TEXT, voiceId: VOICE },
    urlSource: 'body',
    upstream: [
        miniMaxRule(JSON.stringify({ data: { url: `${MOCK}/audio/missing.bin` }, base_resp: { status_code: 0 } })),
        { match: '/audio/missing.bin', status: 404, headers: { 'content-type': 'text/plain' }, body: 'no audio' },
    ],
    expectedOutbound: 2,
});
addScenario({
    name: 'voice.url.throws',
    body: { apiHost: MOCK, text: TEXT, voiceId: VOICE },
    urlSource: 'body',
    upstream: [
        miniMaxRule(JSON.stringify({ data: { url: `${CLOSED}/audio/broken.bin` }, base_resp: { status_code: 0 } })),
        { match: '/audio/broken.bin', throws: true },
    ],
    expectedOutbound: 2,
    // The pinned leg models a transport failure with the stub's throw; the Go leg dials a real
    // bound-then-closed port, so the failure is produced rather than simulated. The resulting body
    // interpolates the transport's message, so it is classified shape and records no value.
    peerForUrl: 'closed',
    unreachableOutbound: 1,
    shapeBody: true,
});
addScenario({
    name: 'voice.url.takesPrecedenceOverNothing',
    body: { apiHost: MOCK, text: TEXT, voiceId: VOICE },
    urlSource: 'body',
    upstream: [
        miniMaxRule(JSON.stringify({ data: { url: `${MOCK}/audio/second.bin` }, base_resp: { status_code: 0 } })),
        { match: '/audio/second.bin', status: 200, headers: { 'content-type': 'audio/mpeg' }, body: 'SECOND-PAYLOAD' },
        { match: '/audio/first.bin', status: 200, headers: { 'content-type': 'audio/mpeg' }, body: 'FIRST-PAYLOAD' },
    ],
    expectedOutbound: 2,
});
// audio AND url present: the hex branch wins and no second request is made.
successWith('voice.audioWinsOverUrl', {
    data: { audio: AUDIO_HEX, url: `${MOCK}/audio/ignored.bin` },
    base_resp: { status_code: 0 },
});

// ---- connection failure on the FIRST request --------------------------------------------------
// The stub cannot dial a closed port, so it throws the TypeError a refused connection produces;
// the route's outer catch is what makes the two indistinguishable, and the Go leg uses a REAL
// bound-then-closed port so the failure branch is produced rather than simulated.
addScenario({
    name: 'voice.closedPort',
    body: { apiHost: CLOSED, text: TEXT, voiceId: VOICE },
    urlSource: 'body',
    upstream: [{ match: '/v1/t2a_v2', throws: true }],
    expectedOutbound: 1,
    peerForUrl: 'closed',
    unreachableOutbound: 1,
});

function capture(result, isBinary, shapeBody) {
    const response = result.response;
    const headers = stableHeaders(response);
    if (shapeBody) {
        // The body interpolates the TRANSPORT ERROR's own message
        // (`Failed to fetch audio: ${urlError.message}`). On a real node-fetch that text is
        // `request to http://host:port/... failed, reason: connect ECONNREFUSED 127.0.0.1:PORT`,
        // i.e. it carries the ephemeral authority, and the controlled peer can only supply a
        // substitute. A value that is a property of the transport is recorded as null with its
        // reason, and its DERIVED fields (content-length measures it, the ETag hashes it) go with
        // it. The status and the outbound requests are still compared.
        delete headers['content-length'];
        delete headers.etag;
        return { status: response.status, headers, bodyText: null, bodySha256: null };
    }
    if (isBinary) {
        return {
            status: response.status,
            headers,
            sha256: createHash('sha256').update(result.bytes).digest('hex'),
            bytes: result.bytes.length,
        };
    }
    return {
        status: response.status,
        headers,
        bodyText: result.text,
        bodySha256: createHash('sha256').update(result.bytes).digest('hex'),
    };
}

function stubRule(item) {
    return {
        match: item.match,
        status: item.status,
        headers: item.headers ?? {},
        body: item.body,
        throws: item.throws === true,
    };
}

async function main() {
    const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-minimax-oracle-', mocks: [] });
    const observations = {};
    const inputs = {};
    try {
        for (const scenario of scenarios) {
            const secrets = scenario.secrets ?? SECRETS;
            server.writeSecrets(secretFile(secrets));
            server.setMocks((scenario.upstream ?? []).map(stubRule));
            const result = await server.post('/api/minimax/generate-voice', JSON.stringify(materialize(scenario.body ?? {})));
            const outbound = server.outbound();
            if (outbound.length !== scenario.expectedOutbound) {
                throw new Error(`${scenario.name}: the pinned route made ${outbound.length} outbound requests but this scenario declares ${scenario.expectedOutbound}. A request that escapes the stub is an ESCAPED request, not a missing one: recorded ${JSON.stringify(outbound.map(request => request.url))}`);
            }
            const isBinary = !(result.response.headers.get('content-type') ?? '').includes('json');
            const captured = capture(result, isBinary, scenario.shapeBody === true);
            if (!isBinary && !scenario.shapeBody && typeof captured.bodyText !== 'string') {
                throw new Error(`${scenario.name}: a JSON response must be recorded as text`);
            }
            const comparison = scenario.shapeBody === true
                ? {
                    compared: ['status', 'headers', 'outbound'],
                    shape: ['bodyText', 'bodySha256', 'headers.content-length', 'headers.etag'],
                    shapeReason: {
                        bodyText: 'the body interpolates the transport error message, which carries the request authority (node-fetch renders "request to <url> failed, reason: connect ECONNREFUSED <host>:<port>"), so it is a property of the transport rather than of the route; no value is recorded and the 500 status is compared instead',
                        bodySha256: 'it hashes the unrecorded body',
                        'headers.content-length': 'it measures the unrecorded body',
                        'headers.etag': 'it hashes the unrecorded body',
                    },
                }
                : {
                    compared: isBinary
                        ? ['status', 'headers', 'sha256', 'bytes', 'outbound']
                        : ['status', 'headers', 'bodyText', 'bodySha256', 'outbound'],
                    shape: [],
                    shapeReason: {},
                };
            observations[scenario.name] = {
                ...captured,
                outbound: outbound.map(request => ({
                    url: normalize(request.url),
                    method: request.method,
                    explicitHeaders: explicitHeaders(request.headers),
                    body: normalize(request.body ?? ''),
                })),
                comparison,
            };
            inputs[scenario.name] = {
                route: '/api/minimax/generate-voice',
                body: scenario.body ?? {},
                bodyText: JSON.stringify(scenario.body ?? {}),
                urlSource: scenario.urlSource,
                overrides: scenario.overrides ?? null,
                peerForUrl: scenario.peerForUrl ?? 'mock',
                expectedOutbound: scenario.expectedOutbound,
                // How many of the recorded outbound requests CANNOT land on a live peer (a relative
                // URL the transport rejects, or the <closed> port). The Go replay asserts that its
                // live peer received exactly expectedOutbound - unreachableOutbound requests.
                unreachableOutbound: scenario.unreachableOutbound ?? 0,
                shapeBody: scenario.shapeBody === true,
                secrets,
                upstream: scenario.upstream ?? [],
            };
        }

        writeFixture(repositoryRoot, 'sillytavern-1.19.0-minimax.json', {
            schemaVersion: 1,
            baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
            probe: 'pinned /api/minimax/generate-voice route',
            oracle: { file: 'src/endpoints/minimax.js', mountedAt: '/api/minimax (src/server-startup.js:184)' },
            mechanism: 'the upstream host is a destructuring default (`apiHost = \'https://api.minimax.io\'`), so the pinned process runs with node-fetch replaced by a controlled peer (tools/lib/pinned-outbound.mjs); both the outbound request and the peer response are captured, and nothing is inferred',
            methods: {
                'URL construction': '`${apiHost}/v1/t2a_v2` is plain concatenation: no trailing-slash normalisation, no encoding',
                'default semantics': 'the eight defaults are destructuring initializers, so they fire on undefined only; null and "" are used verbatim',
                'error taxonomy': 'non-ok upstream answers JSON-parse the body first and fall back to text; base_resp.status_code is compared strictly against the number 0; base_resp.status_msg is interpolated, so an absent one renders the literal "undefined"',
                'audio hex': 'the payload is hex-decoded after stripping a leading "0x" and every whitespace character; an odd length is LEFT-padded with a zero',
            },
            conventions: {
                mock: 'peer origins are recorded as the <mock> marker; the Go replay substitutes its own listener',
                closed: 'a transport failure is recorded as the <closed> marker; the Go replay binds and closes a real local port, so the failure is produced rather than simulated',
            },
            nodeFetchWireDefaults: {
                headers: [['accept', '*/*'], ['accept-encoding', 'gzip, deflate, br'], ['user-agent', 'node-fetch']],
                verifiedBy: 'tests/oracle/sillytavern-1.19.0-sd-routes.json records the same defaults on the pinned wire against a real local peer',
            },
            fixtureFields: {
                compared: ['observations.*.status', 'observations.*.headers', 'observations.*.bodyText', 'observations.*.bodySha256', 'observations.*.sha256', 'observations.*.bytes', 'observations.*.outbound[] (url, method, explicitHeaders, body)'],
                shape: ['observations.voice.url.throws.bodyText/.bodySha256/headers.content-length/headers.etag'],
                shapeReason: {
                    'voice.url.throws body': 'that branch interpolates the transport error message, which carries the request authority (node-fetch renders "request to <url> failed, reason: ECONNREFUSED <host>:<port>"); the value is a property of the transport, so no value is recorded and the 500 status plus the two outbound requests are compared instead',
                },
                notRecorded: ['the ephemeral peer authority', 'the pinned server listen port', 'startup log', 'Date/Connection/Keep-Alive/Transfer-Encoding (transport framing)'],
            },
            inputs: {
                cookieSecret: COOKIE_SECRET,
                account: { handle: 'default-user', name: 'MiniMax Probe', admin: true, password: '' },
                apiKey: API_KEY,
                audioHex: AUDIO_HEX,
                audioSha256: createHash('sha256').update(AUDIO).digest('hex'),
                seamDefaults: SEAM_DEFAULTS,
                scenarios: inputs,
            },
            observations,
            knownDifferences: [],
        });
        console.log(`Wrote tests/oracle/sillytavern-1.19.0-minimax.json from pinned generate-voice behaviour (${scenarios.length} scenarios)`);
    } finally {
        await server.stop();
    }
}

await main();
