#!/usr/bin/env node
// @gotavern-oracle: fixture=sillytavern-1.19.0-sd-comfy-generate.json label="sd comfy generate"
// Probe the two pinned ComfyUI generation routes:
//
//   POST /api/sd/comfy/generate        src/endpoints/stable-diffusion.js:562
//   POST /api/sd/comfyrunpod/generate  src/endpoints/stable-diffusion.js:668
//
// CORRECTED HANDOVER CLAIM. The lane brief said this route "reads a workflow JSON from the user's
// comfyWorkflows directory ... substitutes the request's prompt/seed/etc into the workflow graph".
// It does NOT, and the difference is the whole shape of the route. Read line by line:
//
//   - the `/generate` handler never touches the filesystem. `getComfyWorkflows` (:22) and the
//     workflow GET/POST routes (:485-560) are a SEPARATE concern; nothing in :562-633 reads a file.
//   - `request.body.prompt` is POSTed to `{url}/prompt` VERBATIM (:577-580). No substitution.
//   - the `"%prompt%"`/`"%seed%"` replacement lives in the BROWSER: public/scripts/extensions/
//     stable-diffusion/index.js:4216-4300 (`generateComfyImageCommon`) loads the workflow through
//     `/api/sd/comfy/workflow`, substitutes the placeholders client-side, and sends as the JSON
//     string member `prompt` a document shaped `{ "prompt": <graph> }`.
//
// The workflows directory is deliberately NOT seeded. That is evidence rather than a shortcut: a
// handler that read it would answer 500 on the missing directory, and every scenario here answers
// from the controlled peer instead.
//
// Other pinned details this probe pins, each of which a careful implementation would get wrong:
//   - NO fetch in either handler is signal-bound (the `AbortController` is a no-op). `auth` is used
//     only by the socket-close handler, which POSTs `{url}/interrupt` (local) or
//     `{url}/cancel/<jobId>` (runpod) when the caller goes away. So the three comfy requests and the
//     two runpod requests carry NO Authorization header -- not even when the client sends `auth`.
//   - The local poll is `while (true) { fetch(/history/<id>); if (item) break; await delay(100) }`:
//     the delay comes AFTER the check, so N empty answers mean N+1 history requests and N delays.
//     The runpod poll waits 500ms. Poll COUNTS are fixture data via `times` rules.
//   - The `/view` URL is built by assigning `url.search` a TEMPLATE STRING, so the WHATWG
//     special-query encode set applies to the interpolated values (space, `"`, `#`, `<`, `>`, `'`
//     and non-ASCII are escaped) while `&`, `=`, `/` and `%` are NOT: a filename containing `&`
//     injects a query member. `comfyFilenameReserved` is the scenario that makes that visible
//     (AGENTS rule 15: an encoding assertion with ASCII-only input cannot fail).
//   - Output extraction is `outputs.map(it => it.images).filter(Array.isArray).flat()[0] ??
//     outputs.map(it => it.gifs)...`, so an EMPTY `images` array falls through to `gifs` while a
//     present image beats a present gif: `comfyGifFallback` and `comfyImagesBeforeGifs` are the pair
//     that discriminate both directions of that expression.
//   - `catch` answers `res.status(500).send(error.message)`, i.e. the message TEXT at 500, not
//     `sendStatus`. Two of those messages are V8 engine text and are recorded as `shape` with a
//     reason instead of as constants (AGENTS rule 18).
//
// Every outbound request is recorded with its method, ESCAPED target, every header the pinned
// handler DECLARED, and its exact body. The peer is the module-level `node-fetch` replacement plus
// the global `fetch` replacement in tools/lib/pinned-outbound.mjs, so no request can leave this
// process (AGENTS rule 14), and each scenario asserts the outbound COUNT it declares.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';

import { PINNED_COMMIT, PINNED_VERSION, captureHttp, startPinnedProviderServer, writeFixture } from './lib/pinned-outbound.mjs';

const sourceRoot = path.resolve(process.argv[2] ?? '');
const repositoryRoot = path.resolve(process.argv[3] ?? '');
if (!process.argv[2] || !process.argv[3]) {
    console.error('usage: node tools/probe-sd-comfy-generate.mjs <pinned-source-clone> <gotavern-root>');
    process.exit(2);
}
if (execFileSync('git', ['rev-parse', 'HEAD'], { cwd: sourceRoot, encoding: 'utf8' }).trim() !== PINNED_COMMIT) {
    throw new Error(`upstream checkout is not pinned at ${PINNED_COMMIT}`);
}

const COMFY_ROUTE = '/api/sd/comfy/generate';
const RUNPOD_ROUTE = '/api/sd/comfyrunpod/generate';

const PROMPT_ID = 'gotavern-comfy-prompt-1';
const RUNPOD_JOB_ID = 'gotavern-job-1';
const RUNPOD_KEY = 'synthetic-comfy-runpod-key';

// Synthetic bytes only: the peer answers these, so nothing here is live provider content.
const PNG_BYTES = Buffer.from('89504e470d0a1a0a-gotavern-synthetic-png', 'utf8');
const GIF_BYTES = Buffer.from('47494638-gotavern-synthetic-gif', 'utf8');
const WEBP_BYTES = Buffer.from('52494646-gotavern-synthetic-webp', 'utf8');
const BASE64_IMAGE = 'QUJD';

// A non-ASCII input is what exercises the UTF-8 pass-through of `request.body.prompt`, but the LITERAL
// is built at runtime rather than typed into this file: AGENTS rule 9 records a probe whose
// non-ASCII literal was corrupted by a file write with the wrong encoding, and a String.fromCharCode
// step cannot be corrupted by an editor or a shell.
const UMLAUT = String.fromCharCode(0xc4);

const WORKFLOW = '{"3":{"class_type":"KSampler","inputs":{"seed":42,"steps":20,"cfg":7,"sampler_name":"euler","positive":["6",0]}},"6":{"class_type":"CLIPTextEncode","inputs":{"text":"a tree"}}}';

// THE MECHANISM DISCRIMINATOR. This graph carries the browser's substitution placeholders as LITERAL
// string values. A handler that (re)introduced the substitution the lane brief described would rewrite
// them; the pinned handler forwards the document untouched, and `comfyLiteralPlaceholders` asserts the
// exact bytes the peer received. Keep this scenario: it is the case that distinguishes the two
// mechanisms rather than merely describing them.
const PLACEHOLDER_WORKFLOW = '{"6":{"class_type":"CLIPTextEncode","inputs":{"text":"%prompt%"}},"3":{"class_type":"KSampler","inputs":{"seed":"%seed%","denoise":"%denoise%","model":"%model%"}}}';

// The BROWSER's request shape, reproduced exactly (index.js:4280-4290): the prompt member is a JSON
// document with leading indentation, and those whitespace bytes are forwarded verbatim.
function comfyPrompt(workflow) {
    return '{\n                "prompt": ' + workflow + '\n            }';
}

const IMAGE_PNG = { filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' };

const DEFAULT_ITEM = {
    prompt: [0, PROMPT_ID, {}, {}, []],
    outputs: { 9: { images: [{ filename: 'ComfyUI_00001_.png', subfolder: '', type: 'output' }] } },
    status: { status_str: 'success', completed: true, messages: [['execution_start', { prompt_id: PROMPT_ID }]] },
};

function secretEntry(key, value) {
    return { [key]: [{ id: `sid-${key}`, value, label: key, active: true }] };
}

// A scenario's `shape` marks response fields whose VALUE cannot be a constant: the pinned handler
// answers `error.message`, and for these two branches that message is V8 text (a property-read error
// or a JSON.parse SyntaxError), which is engine-version specific. AGENTS rule 18: record null, keep
// the reason, null the DERIVED fields (content-length measures those bytes, the ETag hashes them),
// and never classify `status` as shape.
function shapeFields(reason) {
    return {
        fields: ['response.body', 'response.bodyText', 'response.headers.content-length', 'response.headers.etag'],
        reason,
    };
}

const SHAPE_ITEM_WITHOUT_STATUS =
    'the pinned handler reads `item.status.status_str` and throws a V8 TypeError ("Cannot read properties of '
    + 'undefined (reading \'status_str\')") whose text is engine-version specific; GoTavern cannot reproduce V8 '
    + 'error text, so only the 500 status and the outbound count are compared and the body bytes stay null';
const SHAPE_PROMPT_NOT_JSON =
    'the pinned handler runs `JSON.parse(request.body.prompt)` and answers that SyntaxError message, whose text '
    + 'is V8 engine-version specific; only the 500 status and the zero outbound count are compared';

const SCENARIOS = [
    // ── /api/sd/comfy/generate: the happy path and the poll count ───────────────────────────────
    { label: 'comfyFirstPoll', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 3,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID, number: 1, node_errors: {} } },
          { match: '/history/', payload: { [PROMPT_ID]: DEFAULT_ITEM } },
          { match: '/view?', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES },
      ] },
    // TWO empty history answers and then a present one: the `times` bound is what makes the poll
    // count data rather than luck. Three history requests (two empty, one answering) plus the prompt
    // POST plus the view fetch is exactly five, which is the count this scenario declares.
    { label: 'comfyThirdPoll', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 5,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', payload: {}, times: 2 },
          { match: '/history/', payload: { [PROMPT_ID]: DEFAULT_ITEM } },
          { match: '/view?', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES },
      ] },
    // `auth` exists in the request body but is used ONLY by the socket-close interrupt, so an
    // implementation that authenticates the main path shows up here as an extra header.
    { label: 'comfyAuthSentIgnored', route: COMFY_ROUTE, request: { url: '<mock>', auth: 'user:pass', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 3,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', payload: { [PROMPT_ID]: DEFAULT_ITEM } },
          { match: '/view?', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES },
      ] },
    // THE MECHANISM DISCRIMINATOR: the graph carries the browser's substitution placeholders as
    // literal strings, and the pinned handler forwards them untouched. A handler that implemented the
    // substitution the brief described would rewrite this body and fail the assertion below.
    { label: 'comfyLiteralPlaceholders', route: COMFY_ROUTE,
      request: { url: '<mock>', prompt: comfyPrompt(PLACEHOLDER_WORKFLOW) },
      outboundCount: 3,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', payload: { [PROMPT_ID]: DEFAULT_ITEM } },
          { match: '/view?', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES },
      ] },
    // An absent `prompt` member makes the pinned POST carry NO body at all (node-fetch treats an
    // undefined body as no body and adds no content type).
    { label: 'comfyNoPrompt', route: COMFY_ROUTE, request: { url: '<mock>' },
      outboundCount: 3,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', payload: { [PROMPT_ID]: DEFAULT_ITEM } },
          { match: '/view?', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES },
      ] },
    // The id is interpolated RAW and re-parsed as a URL: a space becomes %20 and `?y=1` becomes a
    // QUERY STRING on the history request.
    { label: 'comfyPromptIdReserved', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 3,
      mocks: [
          { match: '/prompt', payload: { prompt_id: 'p 1/x?y=1' } },
          { match: '/history/', payload: { 'p 1/x?y=1': DEFAULT_ITEM } },
          { match: '/view?', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES },
      ] },
    // `data.prompt_id` absent: the id is the literal string "undefined" in the history path.
    { label: 'comfyMissingPromptId', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 3,
      mocks: [
          { match: '/prompt', payload: {} },
          { match: '/history/', payload: { undefined: DEFAULT_ITEM } },
          { match: '/view?', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES },
      ] },
    // Non-ASCII in the forwarded body, and an extension that is lowercased for `format`.
    { label: 'comfyUnicodePrompt', route: COMFY_ROUTE,
      request: { url: '<mock>', prompt: comfyPrompt('{"6":{"class_type":"CLIPTextEncode","inputs":{"text":"ein Baum ' + UMLAUT + '"}}}') },
      outboundCount: 3,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', payload: { [PROMPT_ID]: { outputs: { 9: { images: [{ filename: 'render.WEBP', subfolder: '', type: 'output' }] } }, status: { status_str: 'success' } } } },
          { match: '/view?', headers: { 'content-type': 'image/webp' }, binary: WEBP_BYTES },
      ] },

    // ── output extraction ──────────────────────────────────────────────────────────────────────
    // An EMPTY images array IS an array (so it survives the filter), flat()[0] is undefined, and the
    // `??` fallback reaches gifs. The gif has no extension, so `format` falls back to 'png'.
    { label: 'comfyGifFallback', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 3,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', payload: { [PROMPT_ID]: { outputs: { 1: { images: [] }, 9: { gifs: [{ filename: 'anim', subfolder: 'sub dir', type: 'output' }] } }, status: { status_str: 'success' } } } },
          { match: '/view?', headers: { 'content-type': 'image/gif' }, binary: GIF_BYTES },
      ] },
    // A PRESENT image beats a present gif: the other direction of the same expression.
    { label: 'comfyImagesBeforeGifs', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 3,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', payload: { [PROMPT_ID]: { outputs: { 1: { images: [IMAGE_PNG] }, 2: { gifs: [{ filename: 'anim.gif', subfolder: '', type: 'output' }] } }, status: { status_str: 'success' } } } },
          { match: '/view?', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES },
      ] },
    // The view query is built by assigning `.search` a template string, so the interpolated values get
    // the WHATWG special-query encode set while `&` and `=` stay literal.
    { label: 'comfyFilenameReserved', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 3,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', payload: { [PROMPT_ID]: { outputs: { 9: { images: [{ filename: "img one'#&x=y.PNG", subfolder: 'a b', type: 'temp' }] } }, status: { status_str: 'success' } } } },
          { match: '/view?', headers: { 'content-type': 'image/png' }, binary: PNG_BYTES },
      ] },

    // ── error branches, one per distinct message ──────────────────────────────────────────────
    { label: 'comfyPromptFailed', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 1,
      mocks: [{ match: '/prompt', status: 500, statusText: 'Internal Server Error', text: '{"error":"machine is on fire"}' }] },
    { label: 'comfyHistoryFailed', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 2,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', status: 500, statusText: 'Internal Server Error', text: 'nope' },
      ] },
    { label: 'comfyViewFailed', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 3,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', payload: { [PROMPT_ID]: DEFAULT_ITEM } },
          { match: '/view?', status: 404, statusText: 'Not Found', text: 'gone' },
      ] },
    { label: 'comfyPromptThrows', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 1,
      mocks: [{ match: '/prompt', throws: true }] },
    // The traceback join: one message survives the `execution_error` filter, a non-error entry is
    // dropped, and a message with absent members interpolates the string "undefined" three times.
    { label: 'comfyErrorStatus', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 2,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', payload: { [PROMPT_ID]: { outputs: {}, status: {
              status_str: 'error',
              messages: [
                  ['execution_start', { prompt_id: PROMPT_ID }],
                  ['execution_error', { node_type: 'KSampler', node_id: 3, exception_type: 'RuntimeError', exception_message: 'CUDA out of memory' }],
                  ['execution_error', { node_type: 'VAEDecode' }],
              ],
          } } } },
      ] },
    // `|| ''` and `.trim()`: no messages at all leaves the bare first sentence, with no newlines.
    { label: 'comfyErrorWithoutMessages', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 2,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', payload: { [PROMPT_ID]: { outputs: {}, status: { status_str: 'error' } } } },
      ] },
    { label: 'comfyNoOutputs', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 2,
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', payload: { [PROMPT_ID]: { outputs: {}, status: { status_str: 'success' } } } },
      ] },
    // ── the two refusals that happen BEFORE any outbound request ──────────────────────────────
    { label: 'comfyNoUrl', route: COMFY_ROUTE, request: { prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 0, mocks: [] },
    { label: 'comfyInvalidUrl', route: COMFY_ROUTE, request: { url: 'not a url', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 0, mocks: [] },
    // A history entry with no `status`: the property read throws, and that message is V8 text.
    { label: 'comfyHistoryItemWithoutStatus', route: COMFY_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      outboundCount: 2,
      shape: shapeFields(SHAPE_ITEM_WITHOUT_STATUS),
      mocks: [
          { match: '/prompt', payload: { prompt_id: PROMPT_ID } },
          { match: '/history/', payload: { [PROMPT_ID]: { outputs: { 9: { images: [IMAGE_PNG] } } } } },
      ] },

    // ── /api/sd/comfyrunpod/generate ─────────────────────────────────────────────────────────
    { label: 'runpodNoKey', route: RUNPOD_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      secrets: {}, outboundCount: 0, mocks: [] },
    { label: 'runpodFirstPoll', route: RUNPOD_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      secrets: secretEntry('api_key_comfy_runpod', RUNPOD_KEY), outboundCount: 2,
      mocks: [
          { match: '/run', payload: { id: RUNPOD_JOB_ID, status: 'IN_QUEUE' } },
          { match: '/status/', payload: { id: RUNPOD_JOB_ID, status: 'COMPLETED', output: { images: [{ filename: 'preview.png', data: BASE64_IMAGE, type: 'base64' }] } } },
      ] },
    { label: 'runpodSecondPoll', route: RUNPOD_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      secrets: secretEntry('api_key_comfy_runpod', RUNPOD_KEY), outboundCount: 3,
      mocks: [
          { match: '/run', payload: { id: RUNPOD_JOB_ID, status: 'IN_QUEUE' } },
          { match: '/status/', payload: { id: RUNPOD_JOB_ID, status: 'IN_PROGRESS' }, times: 1 },
          { match: '/status/', payload: { id: RUNPOD_JOB_ID, status: 'COMPLETED', output: { images: [{ filename: 'preview.png', data: BASE64_IMAGE }] } } },
      ] },
    // A workflow that ALREADY carries `input.workflow` is sent as-is; anything else is wrapped.
    { label: 'runpodWorkflowPassthrough', route: RUNPOD_ROUTE,
      request: { url: '<mock>', prompt: comfyPrompt('{"input":{"workflow":{"3":{"class_type":"KSampler"}}},"extra":"kept"}') },
      secrets: secretEntry('api_key_comfy_runpod', RUNPOD_KEY), outboundCount: 2,
      mocks: [
          { match: '/run', payload: { id: RUNPOD_JOB_ID } },
          { match: '/status/', payload: { output: { images: [{ filename: 'preview.png', data: BASE64_IMAGE }] } } },
      ] },
    { label: 'runpodWorkflowWrapped', route: RUNPOD_ROUTE,
      request: { url: '<mock>', prompt: comfyPrompt('{"3": {"class_type": "KSampler"}}') },
      secrets: secretEntry('api_key_comfy_runpod', RUNPOD_KEY), outboundCount: 2,
      mocks: [
          { match: '/run', payload: { id: RUNPOD_JOB_ID } },
          { match: '/status/', payload: { output: { images: [{ filename: 'preview.png', data: BASE64_IMAGE }] } } },
      ] },
    // `JSON.stringify({input:{workflow: undefined}})` DROPS the member: the wrapped body is
    // {"input":{}} and the peer receives exactly that.
    { label: 'runpodEmptyPromptObject', route: RUNPOD_ROUTE, request: { url: '<mock>', prompt: '{}' },
      secrets: secretEntry('api_key_comfy_runpod', RUNPOD_KEY), outboundCount: 2,
      mocks: [
          { match: '/run', payload: { id: RUNPOD_JOB_ID } },
          { match: '/status/', payload: { output: { images: [{ filename: 'preview.png', data: BASE64_IMAGE }] } } },
      ] },
    { label: 'runpodFilenameNoExtension', route: RUNPOD_ROUTE, request: { url: '<mock>', prompt: '{}' },
      secrets: secretEntry('api_key_comfy_runpod', RUNPOD_KEY), outboundCount: 2,
      mocks: [
          { match: '/run', payload: { id: RUNPOD_JOB_ID } },
          { match: '/status/', payload: { output: { images: [{ filename: 'preview', data: BASE64_IMAGE }] } } },
      ] },
    // `data: item.data` with `item.data` undefined is OMITTED from the JSON answer entirely.
    { label: 'runpodDataMissing', route: RUNPOD_ROUTE, request: { url: '<mock>', prompt: '{}' },
      secrets: secretEntry('api_key_comfy_runpod', RUNPOD_KEY), outboundCount: 2,
      mocks: [
          { match: '/run', payload: { id: RUNPOD_JOB_ID } },
          { match: '/status/', payload: { output: { images: [{ filename: 'shot.jpg' }] } } },
      ] },
    { label: 'runpodPromptFailed', route: RUNPOD_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      secrets: secretEntry('api_key_comfy_runpod', RUNPOD_KEY), outboundCount: 1,
      mocks: [{ match: '/run', status: 500, statusText: 'Internal Server Error', text: '{"error":"queue dead"}' }] },
    { label: 'runpodStatusFailed', route: RUNPOD_ROUTE, request: { url: '<mock>', prompt: comfyPrompt(WORKFLOW) },
      secrets: secretEntry('api_key_comfy_runpod', RUNPOD_KEY), outboundCount: 2,
      mocks: [
          { match: '/run', payload: { id: RUNPOD_JOB_ID } },
          { match: '/status/', status: 500, statusText: 'Internal Server Error', text: 'nope' },
      ] },
    { label: 'runpodNoUrl', route: RUNPOD_ROUTE, request: { prompt: '{}' },
      secrets: secretEntry('api_key_comfy_runpod', RUNPOD_KEY), outboundCount: 0, mocks: [] },
    { label: 'runpodPromptNotJSON', route: RUNPOD_ROUTE, request: { url: '<mock>', prompt: 'not a workflow' },
      secrets: secretEntry('api_key_comfy_runpod', RUNPOD_KEY), outboundCount: 0,
      shape: shapeFields(SHAPE_PROMPT_NOT_JSON), mocks: [] },
];

const server = await startPinnedProviderServer({ sourceRoot, prefix: 'gotavern-sd-comfy-generate-oracle-', mocks: [] });
const scenarios = {};
let bootOutbound = [];
try {
    bootOutbound = server.bootOutbound;
    for (const scenario of SCENARIOS) {
        const rules = (scenario.mocks ?? []).map(rule => ({
            run: scenario.label,
            match: rule.match,
            status: rule.status ?? 200,
            statusText: rule.statusText ?? 'OK',
            headers: rule.headers ?? { 'content-type': 'application/json' },
            body: rule.binary !== undefined ? rule.binary.toString('base64') : rule.text !== undefined ? rule.text : JSON.stringify(rule.payload ?? {}),
            binaryBody: rule.binary !== undefined,
            ...(rule.times === undefined ? {} : { times: rule.times }),
            // A `throws` rule is a REJECTED fetch, which is what an aborted or refused connection
            // produces. Omitting this passthrough once made `comfyPromptThrows` record a 200 rule
            // answering `{}` instead, and the scenario measured the wrong branch.
            ...(rule.throws === true ? { throws: true } : {}),
        }));
        server.writeSecrets(scenario.secrets ?? {});
        server.setMocks(rules);
        // The URL comes from the request body, so it is recorded as `<mock>` and the pinned peer's
        // origin is used only for this run: the fixture can hold no host or port (rule 18).
        const requestBody = JSON.stringify(scenario.request).split('<mock>').join(server.origin);
        const result = await server.post(scenario.route, requestBody);
        const requests = server.outbound();
        const captured = captureHttp(result);
        let response = captured;
        if (scenario.shape) {
            const headers = { ...captured.headers };
            delete headers['content-length'];
            delete headers.etag;
            response = { status: captured.status, headers, body: null, bodyText: null };
            if (captured.status >= 200 && captured.status <= 299) {
                throw new Error(`${scenario.label}: a shape-classified response answered ${captured.status}; shape is only for a branch whose body cannot be a constant`);
            }
            if (typeof captured.bodyText !== 'string' || captured.bodyText === '') {
                throw new Error(`${scenario.label}: the shape-classified branch answered an EMPTY body, so it cannot be attested as the pinned message branch`);
            }
        }
        scenarios[scenario.label] = {
            // The ROUTE is recorded with the scenario: a replay that has to infer which route a
            // scenario drives (from its secrets, say) is guessing at the one field it must not guess.
            route: scenario.route,
            request: scenario.request,
            requestBody: JSON.stringify(scenario.request),
            mocks: rules,
            secrets: server.readSecrets(),
            response,
            ...(scenario.shape === undefined ? {} : { responseShape: scenario.shape }),
            outbound: requests.map(request => ({
                url: request.url.split(server.origin).join('<mock>'),
                method: request.method,
                headers: request.headers,
                body: request.body === undefined ? null : request.body,
            })),
        };
        if (requests.length !== scenario.outboundCount) {
            throw new Error(`${scenario.label}: the controlled peer received ${requests.length} request(s), the scenario declares ${scenario.outboundCount}`
                + ` | saw ${JSON.stringify(requests.map(request => request.method + ' ' + request.url))}`);
        }
    }
} catch (error) {
    console.error('PROBE FAILED; pinned server log tail:');
    console.error(server.logs.join('').slice(-8000));
    throw error;
} finally {
    await server.stop();
}

const sha256 = value => createHash('sha256').update(value).digest('hex');

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

// An assertion that dereferences `outbound[0]` turns a fixture difference into a stack trace, and it
// would be a SILENT PASS had the expected value also been undefined. Every dereference goes through
// requireOutbound, which refuses with the evidence needed to tell a probe defect from a product
// difference (AGENTS rule 20).
function requireOutbound(label, index = 0) {
    const scenario = scenarios[label];
    if (!scenario) {
        refuseProbe(`scenario ${label} is missing from the recording`);
    }
    if (scenario.outbound.length <= index) {
        const response = scenario.response ?? {};
        refuseProbe(`scenario ${label} recorded ${scenario.outbound.length} outbound request(s), so request ${index} cannot be compared`
            + ` | recorded status ${response.status}`
            + ` | recorded body ${String(response.bodyText ?? '').slice(0, 500)}`
            + ` | scenario request body ${String(scenario.requestBody).slice(0, 300)}`);
    }
    return scenario.outbound[index];
}

const bodyJSON = label => JSON.parse(scenarios[label].response.bodyText);

// ── /api/sd/comfy/generate ─────────────────────────────────────────────────────────────────────
assert.equal(scenarios.comfyFirstPoll.response.status, 200, 'the happy path answers 200');
assert.equal(scenarios.comfyFirstPoll.response.bodyText, JSON.stringify({ format: 'png', data: PNG_BYTES.toString('base64') }),
    'the answer projects {format, data} with the provider bytes re-encoded as base64, in that member order');
assert.equal(scenarios.comfyFirstPoll.response.headers['content-type'], 'application/json; charset=utf-8', 'res.send(object) is JSON');
assert.equal(requireOutbound('comfyFirstPoll', 0).url, '<mock>/prompt', 'the prompt POST target is urlJoin(url, "/prompt")');
assert.equal(requireOutbound('comfyFirstPoll', 0).method, 'POST', 'the prompt request is a POST');
assert.deepEqual(requireOutbound('comfyFirstPoll', 0).headers, {},
    'the prompt POST DECLARES no headers: no content-type and, crucially, no authorization');
assert.equal(requireOutbound('comfyFirstPoll', 0).body, comfyPrompt(WORKFLOW),
    'request.body.prompt is forwarded VERBATIM, whitespace included: the route performs no substitution');
assert.equal(requireOutbound('comfyFirstPoll', 1).url, `<mock>/history/${PROMPT_ID}`, 'prompt_id is interpolated into the history path');
assert.equal(requireOutbound('comfyFirstPoll', 1).method, 'GET', 'the history poll is a GET');
assert.deepEqual(requireOutbound('comfyFirstPoll', 1).headers, {}, 'the history poll declares no headers either');
assert.equal(requireOutbound('comfyFirstPoll', 2).url, '<mock>/view?filename=ComfyUI_00001_.png&subfolder=&type=output',
    'the view query is the raw template interpolation, with the empty subfolder kept');
assert.equal(requireOutbound('comfyFirstPoll', 2).method, 'GET', 'the view fetch is a GET');

assert.equal(scenarios.comfyThirdPoll.outbound.length, 5, 'two empty answers, one answering poll, the prompt POST and the view fetch');
assert.equal(requireOutbound('comfyThirdPoll', 1).url, `<mock>/history/${PROMPT_ID}`, 'first poll');
assert.equal(requireOutbound('comfyThirdPoll', 2).url, requireOutbound('comfyThirdPoll', 1).url, 'the second poll repeats the same URL');
assert.equal(requireOutbound('comfyThirdPoll', 3).url, requireOutbound('comfyThirdPoll', 1).url, 'and so does the third');
assert.equal(requireOutbound('comfyThirdPoll', 4).url, '<mock>/view?filename=ComfyUI_00001_.png&subfolder=&type=output', 'and then the view fetch');

for (const index of [0, 1, 2]) {
    assert.equal('authorization' in requireOutbound('comfyAuthSentIgnored', index).headers, false,
        `request ${index} must not carry an Authorization header even though the body has auth: getBasicAuthHeader is used only by the socket-close interrupt`);
}
assert.equal(scenarios.comfyAuthSentIgnored.response.status, 200, 'an ignored auth member does not change the answer');

// THE MECHANISM DISCRIMINATOR. The brief said the route substitutes prompt/seed into a workflow it
// reads from disk. The peer received the placeholders as literal strings, unchanged: that is what the
// pinned handler does, and an implementation that "fixed" this back into a substitution fails here.
assert.equal(requireOutbound('comfyLiteralPlaceholders', 0).body, comfyPrompt(PLACEHOLDER_WORKFLOW),
    'a prompt carrying %prompt%/%seed% literals is forwarded byte for byte, with no substitution and no file read');
assert.equal(requireOutbound('comfyLiteralPlaceholders', 0).body.includes('"%prompt%"'), true,
    'the literal placeholder survives the request');
assert.equal(requireOutbound('comfyLiteralPlaceholders', 0).body.includes('"%seed%"'), true,
    'and so does the seed placeholder');
assert.equal(scenarios.comfyLiteralPlaceholders.response.status, 200, 'and the generation completes normally');

assert.equal(requireOutbound('comfyNoPrompt', 0).body, null, 'an absent prompt sends NO body at all');
assert.equal(scenarios.comfyNoPrompt.response.status, 200, 'and the route still completes');

assert.equal(requireOutbound('comfyPromptIdReserved', 1).url, '<mock>/history/p%201/x?y=1',
    'a reserved prompt_id is interpolated RAW and re-parsed: the space is percent-encoded and ?y=1 becomes a query');
assert.equal(requireOutbound('comfyMissingPromptId', 1).url, '<mock>/history/undefined',
    'an absent prompt_id becomes the literal string "undefined" in the path');
assert.equal(scenarios.comfyMissingPromptId.response.status, 200, 'a history member keyed "undefined" completes the poll');

assert.equal(requireOutbound('comfyUnicodePrompt', 0).body.includes('ein Baum ' + UMLAUT), true,
    'a non-ASCII character in the workflow is forwarded byte for byte');
assert.equal(requireOutbound('comfyUnicodePrompt', 2).url, '<mock>/view?filename=render.WEBP&subfolder=&type=output',
    'the view filename is interpolated as given, NOT lowercased');
assert.equal(bodyJSON('comfyUnicodePrompt').format, 'webp', 'the FORMAT is path.extname(filename).slice(1).toLowerCase()');

assert.equal(requireOutbound('comfyGifFallback', 2).url, '<mock>/view?filename=anim&subfolder=sub%20dir&type=output',
    'an empty images array falls through to gifs, and the subfolder space is percent-encoded');
assert.equal(bodyJSON('comfyGifFallback').format, 'png', 'an extensionless filename falls back to the png format');
assert.equal(requireOutbound('comfyImagesBeforeGifs', 2).url, '<mock>/view?filename=ComfyUI_00001_.png&subfolder=&type=output',
    'a present image wins over a present gif');

assert.equal(requireOutbound('comfyFilenameReserved', 2).url, '<mock>/view?filename=img%20one%27%23&x=y.PNG&subfolder=a%20b&type=temp',
    'the whatwg special-query set escapes the space, apostrophe and hash but leaves & and = literal (rule 15)');
assert.equal(bodyJSON('comfyFilenameReserved').format, 'png', 'a .PNG extension is lowercased');

assert.equal(scenarios.comfyPromptFailed.response.status, 500, 'a non-ok prompt answer is a 500');
assert.equal(scenarios.comfyPromptFailed.response.bodyText, 'ComfyUI returned an error.',
    'res.status(500).send(error.message): the parsed cause is only logged, never sent');
assert.equal(scenarios.comfyPromptFailed.response.headers['content-type'], 'text/html; charset=utf-8',
    'res.send(string) is html-typed');
assert.equal(scenarios.comfyPromptFailed.outbound.length, 1, 'a failed prompt stops after one request');
assert.equal(scenarios.comfyHistoryFailed.response.bodyText, 'ComfyUI returned an error.', 'a non-ok history answer is the same message');
assert.equal(scenarios.comfyHistoryFailed.outbound.length, 2, 'and the poll count is what tells this apart from a failed view');
assert.equal(scenarios.comfyViewFailed.response.bodyText, 'ComfyUI returned an error.', 'a non-ok view answer is the same message');
assert.equal(scenarios.comfyViewFailed.outbound.length, 3, 'three requests is what tells this apart from the other two');
assert.equal(scenarios.comfyPromptThrows.response.status, 500, 'a rejected fetch is a 500');
assert.equal(scenarios.comfyPromptThrows.response.bodyText, 'fetch failed', 'node-fetch rejects with TypeError("fetch failed") and the catch sends its message');

assert.equal(scenarios.comfyErrorStatus.response.status, 500, 'a status_str of error is a 500');
assert.equal(scenarios.comfyErrorStatus.response.bodyText,
    'ComfyUI generation did not succeed.\n\nKSampler [3] RuntimeError: CUDA out of memory\nVAEDecode [undefined] undefined: undefined',
    'the execution_error traceback join, with absent members interpolated as "undefined"');
assert.equal(scenarios.comfyErrorWithoutMessages.response.bodyText, 'ComfyUI generation did not succeed.',
    '`|| ""` then `.trim()` leaves the bare sentence');
assert.equal(scenarios.comfyNoOutputs.response.status, 500, 'a successful status with no outputs is a 500');
assert.equal(scenarios.comfyNoOutputs.response.bodyText, 'ComfyUI did not return any recognizable outputs.', 'the no-outputs message');

assert.equal(scenarios.comfyNoUrl.response.status, 500, 'a missing url is a 500');
assert.equal(scenarios.comfyNoUrl.response.bodyText, 'Url must be a string. Received undefined',
    'urlJoin throws its own TypeError, and the catch sends ITS message');
assert.equal(scenarios.comfyNoUrl.outbound.length, 0, 'a missing url sends nothing');
assert.equal(scenarios.comfyInvalidUrl.response.status, 500, 'an unparseable url is a 500');
assert.equal(scenarios.comfyInvalidUrl.response.bodyText, 'Invalid URL', 'new URL throws "Invalid URL"');
assert.equal(scenarios.comfyInvalidUrl.outbound.length, 0, 'an unparseable url sends nothing');

assert.equal(scenarios.comfyHistoryItemWithoutStatus.response.status, 500, 'a history item with no status is a 500');
assert.equal(scenarios.comfyHistoryItemWithoutStatus.response.bodyText, null, 'its body is V8 text and is recorded as shape');
assert.equal(scenarios.comfyHistoryItemWithoutStatus.outbound.length, 2, 'the failure happens after the poll');

// ── /api/sd/comfyrunpod/generate ──────────────────────────────────────────────────────────────
assert.equal(scenarios.runpodNoKey.response.status, 400, 'a missing runpod key is a 400 refusal');
assert.equal(scenarios.runpodNoKey.response.bodyText, 'Bad Request', 'sendStatus(400)');
assert.equal(scenarios.runpodNoKey.outbound.length, 0, 'the key refusal sends nothing');

assert.equal(scenarios.runpodFirstPoll.response.status, 200, 'the runpod happy path answers 200');
assert.equal(scenarios.runpodFirstPoll.response.bodyText, JSON.stringify({ format: 'png', data: BASE64_IMAGE }),
    'the runpod answer is {format, data} with the provider data passed THROUGH, never re-encoded');
assert.equal(requireOutbound('runpodFirstPoll', 0).url, '<mock>/run', 'the runpod create target');
assert.equal(requireOutbound('runpodFirstPoll', 0).method, 'POST', 'the runpod create is a POST');
assert.equal(requireOutbound('runpodFirstPoll', 0).headers.authorization, `Bearer ${RUNPOD_KEY}`, 'the runpod create carries the secret as a bearer token');
assert.equal(requireOutbound('runpodFirstPoll', 0).body, '{"input":{"workflow":' + WORKFLOW + '}}', 'a bare workflow graph is WRAPPED in {input:{workflow}}');
assert.equal(requireOutbound('runpodFirstPoll', 1).url, `<mock>/status/${RUNPOD_JOB_ID}`, 'the job id is interpolated into the status path');
assert.equal(requireOutbound('runpodFirstPoll', 1).method, 'GET', 'the status poll is a GET');
assert.equal(requireOutbound('runpodFirstPoll', 1).headers.authorization, `Bearer ${RUNPOD_KEY}`, 'the status poll carries the bearer token as well');

assert.equal(scenarios.runpodSecondPoll.outbound.length, 3, 'one create plus TWO polls');
assert.equal(requireOutbound('runpodSecondPoll', 1).url, `<mock>/status/${RUNPOD_JOB_ID}`, 'the first poll');
assert.equal(requireOutbound('runpodSecondPoll', 2).url, requireOutbound('runpodSecondPoll', 1).url, 'the second poll repeats the URL');

assert.equal(requireOutbound('runpodWorkflowPassthrough', 0).body, '{"input":{"workflow":{"3":{"class_type":"KSampler"}}},"extra":"kept"}',
    'a workflow that already has input.workflow is sent as-is, re-serialized compactly with its member order');
assert.equal(requireOutbound('runpodWorkflowWrapped', 0).body, '{"input":{"workflow":{"3":{"class_type":"KSampler"}}}}',
    'a bare graph is wrapped, and JSON.stringify removes the source whitespace');
assert.equal(requireOutbound('runpodEmptyPromptObject', 0).body, '{"input":{}}',
    'JSON.stringify DROPS an undefined workflow member: {input:{workflow:undefined}} is {"input":{}}');

assert.equal(bodyJSON('runpodFilenameNoExtension').format, 'png', 'an extensionless runpod filename falls back to png');
assert.equal(bodyJSON('runpodFilenameNoExtension').data, BASE64_IMAGE, 'the data member passes through unchanged');
assert.equal(scenarios.runpodDataMissing.response.bodyText, '{"format":"jpg"}',
    'a missing data member is OMITTED from the JSON answer, not sent as null');

assert.equal(scenarios.runpodPromptFailed.response.status, 500, 'a failed runpod create is a 500');
assert.equal(scenarios.runpodPromptFailed.response.bodyText, 'ComfyUI returned an error.', 'with the shared provider message');
assert.equal(scenarios.runpodPromptFailed.outbound.length, 1, 'and it stops after the create');
assert.equal(scenarios.runpodStatusFailed.response.bodyText, 'ComfyUI returned an error.', 'a failed status poll is the same 500 message');
assert.equal(scenarios.runpodStatusFailed.outbound.length, 2, 'two requests tell this apart from a failed create');

assert.equal(scenarios.runpodNoUrl.response.status, 500, 'a missing runpod url is a 500');
assert.equal(scenarios.runpodNoUrl.response.bodyText, 'Url must be a string. Received undefined', 'urlJoin message under the runpod route too');
assert.equal(scenarios.runpodNoUrl.outbound.length, 0, 'and it sends nothing');
assert.equal(scenarios.runpodPromptNotJSON.response.status, 500, 'a prompt that is not JSON is a 500');
assert.equal(scenarios.runpodPromptNotJSON.response.bodyText, null, 'its body is a V8 SyntaxError message and is shape');
assert.equal(scenarios.runpodPromptNotJSON.outbound.length, 0, 'JSON.parse runs before any request');

assert.equal(bootOutbound.length, 0, 'the pinned boot itself made no outbound request, so every recording belongs to a route');

const fixture = {
    schemaVersion: 1,
    baseline: { version: PINNED_VERSION, commit: PINNED_COMMIT },
    probe: 'tools/probe-sd-comfy-generate.mjs',
    implementedRoutes: [COMFY_ROUTE, RUNPOD_ROUTE],
    notImplementedRoutes: [],
    // A STALE CLAIM IS WORSE THAN A MISSING ONE: the handover described a route that reads a workflow
    // file and substitutes prompt/seed into it. That behaviour exists, but in the BROWSER. The
    // correction is recorded here so the next reader does not re-derive it from the same bad note.
    correctedHandover: {
        claim: '/api/sd/comfy/generate reads a workflow JSON from the user\'s comfyWorkflows directory and substitutes the request\'s prompt/seed/etc into the workflow graph, then walks outputs',
        correction: 'The route reads NO file and substitutes NOTHING: it POSTs request.body.prompt verbatim to {url}/prompt. The "%prompt%"/"%seed%" replacement is client-side (public/scripts/extensions/stable-diffusion/index.js:4216-4300, generateComfyImageCommon), which is why the workflows directory is not seeded for these scenarios and why every recorded prompt body is byte-identical to the request member.',
        stillTrue: 'the POST /prompt -> poll /history/<id> -> walk outputs -> GET /view -> base64 answer sequence, the four distinct error branches, the 100ms local poll interval and the 500ms runpod interval all match the pinned source',
    },
    pinnedSource: {
        'src/endpoints/stable-diffusion.js:562': 'comfy POST /generate: new URL(urlJoin(body.url, "/prompt")); the body.prompt string is POSTed verbatim; no fetch is signal-bound (the AbortController is a no-op); the socket-close handler POSTs {url}/interrupt with getBasicAuthHeader(body.auth)',
        'src/endpoints/stable-diffusion.js:589': 'historyUrl = urlJoin(body.url, `/history/${data.prompt_id}`); while(true) polls it, breaking when history[id] is truthy, awaiting delay(100) between attempts',
        'src/endpoints/stable-diffusion.js:603': 'item.status.status_str === "error" => "ComfyUI generation did not succeed.\\n\\n" + the execution_error traceback lines, trimmed',
        'src/endpoints/stable-diffusion.js:612': 'outputs = Object.keys(item.outputs).map(...); images of every array output flattened, else gifs; nothing => "ComfyUI did not return any recognizable outputs."',
        'src/endpoints/stable-diffusion.js:619': 'imgUrl = new URL(urlJoin(body.url, "/view")); imgUrl.search = `?filename=${filename}&subfolder=${subfolder}&type=${type}` (template interpolation, WHATWG special-query encoding)',
        'src/endpoints/stable-diffusion.js:625': 'format = path.extname(imgInfo.filename).slice(1).toLowerCase() || "png"; data = Buffer.from(arrayBuffer).toString("base64")',
        'src/endpoints/stable-diffusion.js:628': 'catch: console.error then res.status(500).send(error.message) -- the message TEXT, not sendStatus',
        'src/endpoints/stable-diffusion.js:668': 'comfyrunpod POST /generate: key from SECRET_KEYS.COMFY_RUNPOD (400 when absent); JSON.parse(body.prompt).prompt; `workflow?.input?.workflow ? workflow : {input:{workflow}}`; POST {url}/run with the bearer token',
        'src/endpoints/stable-diffusion.js:709': 'statusUrl = urlJoin(body.url, `/status/${data.id}`); polls with the bearer token, breaking when status.output.images[0] is truthy, awaiting delay(500)',
        'src/endpoints/stable-diffusion.js:728': 'format from item.filename; data is item.data passed THROUGH (undefined is omitted by JSON.stringify)',
        'src/node_modules/node-fetch/src/body.js:310': 'a string body with no declared content-type is sent as text/plain;charset=UTF-8 (source-derived; the peer records only declared headers)',
    },
    mechanism: 'The upstream base URL comes from `request.body.url`, so no provider seam exists or is needed: the probe points it at `<mock>`, boots the pinned server unmodified, replaces its `node-fetch` module and the global `fetch` with a controlled peer, and records every outbound request the pinned handler would have sent. The Go replay turns `<mock>` into its own httptest listener and applies the same substring+times rule selection the stub uses (AGENTS rule 20).',
    fields: [
        { path: 'scenarios.*.response.status', comparison: 'compared', reason: 'the pinned handler chooses 200/400/500 itself for every branch' },
        { path: 'scenarios.*.response.headers', comparison: 'compared', reason: 'res.send(object) is JSON while res.send(string) is html; content-length and ETag are recomputed from the recorded body on both sides' },
        { path: 'scenarios.*.response.body/bodyText', comparison: 'compared', reason: 'the {format,data} projection with member order, and every fixed error message' },
        { path: 'scenarios.*.response.* (two scenarios)', comparison: 'shape', reason: 'the body is a V8 engine message (a property-read TypeError and a JSON.parse SyntaxError); nulled with its derived content-length/ETag, and the status plus the outbound count stay compared' },
        { path: 'scenarios.*.outbound[].url', comparison: 'compared', reason: 'the escaped target is endpoint behaviour: the raw id interpolation into /history/<id> and the /view special-query encoding' },
        { path: 'scenarios.*.outbound[].method', comparison: 'compared', reason: 'POST /prompt and POST /run versus three GETs' },
        { path: 'scenarios.*.outbound[].headers', comparison: 'compared', reason: 'the DECLARED header set: empty for all three comfy requests, exactly the bearer token for the runpod pair. Asserted in both directions by the test so an added Authorization fails' },
        { path: 'scenarios.*.outbound[].body', comparison: 'compared', reason: 'the verbatim prompt forward, the no-body case, and the runpod wrap/no-wrap/wrapped-undefined forms' },
        { path: 'scenarios.*.outbound.length', comparison: 'compared', reason: 'THE POLL COUNT is the only thing that discriminates a cache-like shortcut from the real loop' },
        { path: 'image bytes', comparison: 'compared', reason: 'synthetic peer answers with known digests; live provider content would be shape only' },
    ],
    normalizations: [
        'The upstream origin is recorded as `<mock>`: the fixture holds no host and no port.',
        'The prompt id and the runpod job id are synthetic constants chosen by the peer, not host-derived values.',
        'Synthetic credentials and synthetic image bytes only.',
    ],
    notRecorded: [
        'the CANCEL leg: the pinned socket-close handler POSTs /interrupt (comfy) or /cancel/<jobId> (runpod) when the caller goes away. The probe peer answers every rule immediately, so there is never an in-flight generation whose caller can disappear; the Go behaviour is covered by a LABELLED implementation test with pinned parity UNOBSERVED (the A1111 precedent).',
        'a url of `null` (urlJoin reads `.length` on it, a V8 message), a url that is an OBJECT or an ARRAY (urlJoin treats an array as a parts list), and a non-string prompt (node-fetch rejects a non-BodyInit) are NOT probed; GoTavern answers the urlJoin type message with the JavaScript String() form of the value, which is a recorded known difference for `null`.',
        'the infinite branches are NOT probed: a history payload that never contains the id, a history entry that is falsy, and a runpod `output.images` that is empty all keep polling forever, exactly as pinned does. GoTavern keeps that inherited property (see the fixture note in the compat row) rather than adding a timeout the product does not have.',
        'a url whose scheme is not http/https: `new URL` accepts it and node-fetch then refuses with "Only HTTP(S) protocols are supported", but the probe peer would answer it instead, so it is source-derived only. GoTavern answers "Invalid URL" there, which is a recorded known difference.',
        'a /prompt JSON body that is not an object (`null`) and an `outputs` member that is missing both throw V8 messages; not probed.',
        'timing is not recorded: the poll interval is a source-derived constant asserted by a labelled Go test, because a 100ms/500ms bucket cannot be discriminated from a fast host.',
    ],
    inputs: {
        promptId: PROMPT_ID,
        runpodJobId: RUNPOD_JOB_ID,
        runpodKey: RUNPOD_KEY,
        pngSha256: sha256(PNG_BYTES),
        gifSha256: sha256(GIF_BYTES),
        webpSha256: sha256(WEBP_BYTES),
        base64Image: BASE64_IMAGE,
        workflow: WORKFLOW,
        placeholderWorkflow: PLACEHOLDER_WORKFLOW,
        umlautCodePoint: 0xc4,
    },
    bootOutbound,
    scenarios,
};

const outputFile = writeFixture(repositoryRoot, 'sillytavern-1.19.0-sd-comfy-generate.json', fixture);
console.log(`scenarios: ${Object.keys(scenarios).length}, boot outbound: ${bootOutbound.length}`);
console.log(`fixture written to ${outputFile}`);
