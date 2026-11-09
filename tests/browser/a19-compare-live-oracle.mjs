// a19-compare-live-oracle.mjs -- the alpha.19 LIVE ORACLE comparator: five observable layers, a taxonomy
// verdict per layer, and NO unexplained difference.
//
// WHAT IT READS. One leg report per leg (schema `a19-live-oracle-leg-v1`, written by the journey probe and
// enriched by a19-live-oracle.mjs with the provider-wire layer and the corpus persistence diff), plus the
// hand-back reports. It never reads the corpus or the product: every expectation comes from the PINNED
// leg at the same phase (AGENTS differential doctrine 1/3) or from the immutable corpus census.
//
// VERDICT TAXONOMY (doctrine 5), never a boolean:
//   match                  every required guard for the layer held
//   mismatch               a guard failed on a compared observation
//   not-observed           the layer's data was not produced (e.g. --skip-pinned); NOT a pass
//   pinned-unreachable     the pinned leg could not be booted; NOT a pass
//   harness-error          a leg report/field is missing or malformed; NOT a pass
//   candidate-error        the GoTavern leg failed to boot or drive while pinned drove
//   nondeterministic-oracle a value that differs because the harness has a race, not the product
//
// NORMALISATION REGISTRY. Normalisations are NOT inferred at run time and are never "ignore the field".
// Each entry below is a NAMED decision with the five members the charter requires (reason, pinned
// evidence, field, test, negative case), and each is APPLIED only to the field it names. The list starts
// from the recorded decisions in docs/longlived-corpus.md §"Normalisation" (already pinned-evidenced) and
// is kept minimal: every entry is a place two subjects legitimately differ. A guard that is disabled by
// an entry is still reported in `normalisations`.
//
// AGENTS rule 18 (fixture shape/instability) is enforced in TWO places: the probe strips the subject's own
// random port from recorded strings (so an unstable value never survives into a compared field), and this
// comparator REFUSES a compared field that still carries a per-leg host/port.
//
// USAGE:
//   node tests/browser/a19-compare-live-oracle.mjs --legs-dir <dir> --corpus-tree-sha256 <hex> \
//     [--corpus-origin ui|synthetic-stand-in] --out <comparison.json>
// Exit 0 only when every layer is `match`.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const argv = process.argv.slice(2);
const argument = (name, fallback = null) => {
    const index = argv.indexOf(name);
    if (index < 0) return fallback;
    const value = argv[index + 1];
    return value === undefined ? fallback : value;
};

const legsDir = path.resolve(argument('--legs-dir', ''));
const corpusTreeSha256 = argument('--corpus-tree-sha256', null);
const corpusOrigin = argument('--corpus-origin', 'synthetic-stand-in');
const outPath = path.resolve(argument('--out', path.join(legsDir, '..', 'a19-live-oracle-comparison.json')));

const sha256 = value => createHash('sha256').update(value).digest('hex');
const readReport = file => {
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
        return null;
    }
};

const legFile = name => path.join(legsDir, `a19-${name}.json`);
const legs = {
    driveGotavern: readReport(legFile('drive-gotavern')),
    drivePinned: readReport(legFile('drive-pinned')),
    restartGotavern: readReport(legFile('restart-gotavern')),
    restartPinned: readReport(legFile('restart-pinned')),
    handbackGotavern: readReport(legFile('handback-gotavern')),
    handbackPinned: readReport(legFile('handback-pinned')),
};

// ---------------------------------------------------------------------------------------------------------
// THE NORMALISATION / EXCLUSION REGISTRY (each entry: the five required members).
// ---------------------------------------------------------------------------------------------------------
const NORMALISATIONS = [
    {
        id: 'per-subject-reply-discriminator',
        reason: 'rule 50 requires the two subjects be FED different bytes, so one reply per subject is stamped with a per-subject prefix; the prefix is stripped with "<REPLY_PREFIX>" wherever a persisted/visible text is compared, and it MUST be absent from every compared provider request',
        pinnedEvidence: 'docs/longlived-corpus.md §"Normalisation, with field paths and reasons" (the same discriminator and the same strip, measured in the long-lived qualification); AGENTS differential doctrine 4 / rule 50',
        field: 'layers.browser.finalChat.lastText, layers.persistence.chatMessages[].mes',
        test: 'guard browser-final-chat-equal and persistence-chat-semantics-equal apply stripDiscriminator; guard discriminator-absent-from-compared-wire fails if a prefix reaches a request',
        negativeCase: 'a19-oracle-teeth.mjs mutates a leg replyPrefix to the OTHER subject\'s value and requires discriminator-absent-from-compared-wire OR final-chat equality to go red by name',
    },
    {
        id: 'wall-clock-send-date',
        reason: 'each subject stamps its own wall clock into a persisted chat message; the value is a timestamp, not a subject behaviour',
        pinnedEvidence: 'docs/longlived-corpus.md §"Normalisation" row `disk.chatsAfter[].messages[].send_date`: "recorded nowhere: each server stamps its own wall clock. Omitted, not compared."',
        field: 'layers.persistence.chatMessages[].sendDate',
        test: 'persistence-chat-semantics-equal omits sendDate from the compared tuple',
        negativeCase: 'a19-oracle-teeth.mjs changes a compared chat message TEXT (not the date) and requires persistence-chat-semantics-equal red',
    },
    {
        id: 'harness-random-port-in-recorded-strings',
        reason: 'each leg boots on its own controlled-range random port (port-lease.mjs) and the probe records URLs; a compared string that still carries the subject port would make two identical behaviours differ. The probe substitutes the port with <BASE> AT RECORD TIME, so the unstable value never survives (AGENTS rule 18)',
        pinnedEvidence: 'tests/browser/port-lease.mjs (controlled-range lease; the alpha.12 wrong-peer defect) and run-against-pinned.mjs printing a per-run port; two legs cannot share a port',
        field: 'layers.browser.consoleErrors[], layers.browser.pageErrors[], layers.browser.finalChat.lastText',
        test: 'a19-journey-selfcheck.mjs stripOwnOrigin() at record time; this comparator REFUSES a compared string containing "127.0.0.1:<port>"',
        negativeCase: 'a19-oracle-teeth.mjs injects a subject port into a console error and requires harness-random-port-in-compared-field red',
    },
    {
        id: 'pinned-build-and-cache-artefacts',
        reason: 'pinned compiles its frontend into <dataRoot>/_webpack and writes a character cache under <dataRoot>/_cache; GoTavern serves the pinned public/** bytes and writes neither. These are build/cache artefacts of the pinned server, not user data and not a browser-observable difference',
        pinnedEvidence: 'docs/longlived-corpus.md §"Normalisation" row `disk.added[] (excluding _webpack/**, _cache/**, default-user/backups/**)` ("pinned compiles its frontend into <dataRoot>/_webpack and writes its character cache under _cache (build/cache artefacts)")',
        field: 'layers.persistence.tree paths under _webpack/**, _cache/**',
        test: 'persistCreatedSetEqual/persistModifiedSetEqual/persistDeletedSetEqual exclude those prefixes and count them in a decided-exclusion row',
        negativeCase: 'a19-oracle-teeth.mjs adds a _webpack file to ONE leg and requires the exclusion row count to move (not the equality guard) — proving the exclusion is counted, not silent',
    },
    {
        id: 'random-secret-and-backup-filenames',
        reason: '<dataRoot>/cookie-secret.txt is a random secret each server generates, and pinned writes wall-clock-named settings backups; neither is a user-data surface this gate compares',
        pinnedEvidence: 'docs/longlived-corpus.md §"Normalisation" row `disk.added[] (settings_default-user_<timestamp>.json, cookie-secret.txt, _storage/<id>, thumbnails/**)` ("wall-clock names, random secrets and image-codec output are compared by normalised PATH/PRESENCE, not bytes")',
        field: 'layers.persistence.tree paths cookie-secret.txt, default-user/backups/**, _storage/**, thumbnails/**',
        test: 'persistence guards exclude those prefixes and count them in a decided-exclusion row',
        negativeCase: 'a19-oracle-teeth.mjs injects a product chat path into the excluded set and requires persistence-created-set-equal red (the exclusion is a prefix list, not a broad ignore)',
    },
    {
        id: 'image-codec-output',
        reason: 'thumbnail/avatar re-encoding is a recorded codec decision: the pinned contract is a TRANSFORMATION (status, MIME, decodability, dimensions), never byte equality with Jimp',
        pinnedEvidence: 'ARCHITECTURE.md §35.2 and AGENTS "Architecture boundaries" 3 (/thumbnail and /api/avatars/upload decided 2026-10-29: observable, not byte equality); docs/longlived-corpus.md §"Normalisation" row `assets[] thumbnail entries`',
        field: 'layers.browser.images[].pixelDigest, layers.persistence thumbnail paths',
        test: 'browser-images-decoded compares decodability/dimensions and records pixelDigest; it never compares pixelDigest',
        negativeCase: 'a19-oracle-teeth.mjs flips one image decoded=false on one leg and requires browser-images-decoded red',
    },
    {
        id: 'wall-clock-json-members',
        reason: 'a save payload or a chat-get response embeds each server-stamped send_date/create_date; two subjects cannot have the same clock and the user prompt permits an explicitly variable timestamp only when it is named. The members are OMITTED from the projected body, not the whole body from the comparison',
        pinnedEvidence: 'docs/longlived-corpus.md §"Normalisation" row `disk.chatsAfter[].messages[].send_date` ("each server stamps its own wall clock. Omitted, not compared."); the same member appears in the chat JSONL and in the HTTP bodies that carry it',
        field: 'layers.http.requests[].requestBodyText / responseBodyText, JSON members send_date and create_date (recursively)',
        test: 'guard http-bodies-equal compares projectBodyForComparison(...) and adds this entry only when a member was actually omitted',
        negativeCase: 'a19-oracle-teeth.mjs changes a compared chat message TEXT in the persistence layer and requires persistence-chat-semantics-equal red; the body projection is unchanged by construction because it strips only the two named keys',
    },
    {
        id: 'independent-session-cookie',
        reason: 'each leg is a separate server process and browser context, so the CSRF/session cookie values are independent session identifiers, which the user prompt names as an allowed non-semantic difference. The cookies are excluded from the header comparison; the REQUEST SEQUENCE and every other comparable header are still compared',
        pinnedEvidence: 'src/middleware/csrf.js and src/users.js issue a per-session token (a different value in each isolated environment); tests/browser/seed-leg-config.mjs gives each leg its OWN config copy precisely because session state is per process',
        field: 'HTTP request header `cookie` and response header `set-cookie`',
        test: 'comparableHeaders() in this file excludes them; the same function compares every other header',
        negativeCase: 'a19-oracle-teeth.mjs changes a compared request header (content-type) and requires http-bodies-equal red, so the exclusion is not "headers are not compared"',
    },
    {
        id: 'http-transport-headers',
        reason: 'date, age, content-length and framing headers are transport metadata: the date moves with the clock, content-length is a function of a body that IS compared after the named projection, and framing is chosen by the connection. CACHING semantics are NOT excluded: etag, expires, last-modified (on API routes) and vary stay compared, because a different validator changes real browser conditional-request behaviour',
        pinnedEvidence: 'Node\'s http and Go\'s net/http both emit Date; content-length is derived from the encoded body. Validators are NOT transport: docs/compat-matrix.md\'s API rows compare Express weak ETag values byte-for-byte (e.g. "ETag/304/HEAD/Range semantics", account routes)',
        field: 'HTTP response headers date, age, content-length, connection, keep-alive, transfer-encoding only; etag/expires/vary/last-modified are compared',
        test: 'comparableHeaders() excludes exactly this list and compares the rest; a difference in the rest is a red (teeth: changing the response etag reds)',
        negativeCase: 'a19-oracle-teeth.mjs changes the response ETag on one leg and requires http-bodies-equal red, so a different validator cannot hide behind this entry',
    },
    {
        id: 'provider-wire-host-peer-port',
        reason: 'each leg records through its OWN controlled-range recording peer, so the provider request\'s Host header carries that peer\'s random port. Only the loopback port is normalised to <PEER>; the host address and every other header value are compared',
        pinnedEvidence: 'tests/browser/port-lease.mjs (controlled-range lease; the alpha.12 wrong-peer defect) and run-against-pinned.mjs printing a per-run port; two legs cannot share a port (measured 41001 vs 41002 in the synthetic fixture, and a fresh pair on every self-check leg)',
        field: 'provider request header Host — the port component only',
        test: 'semanticProviderHeaders() replaces only ^127.0.0.1:<port>$ with 127.0.0.1:<PEER> and records this entry',
        negativeCase: 'a19-oracle-teeth.mjs changes the Host to a NON-loopback address on one leg and requires wire-headers-equal red (only the port is normalised); changing only the port must survive',
    },
    {
        id: 'provider-wire-header-name-case-and-order',
        reason: 'the production transport is net/http, which canonicalises header NAME casing and writes its own ORDER; pinned provider traffic is node-fetch, which writes lowercase names in its own order. HTTP names are case-insensitive and order-insensitive, so the comparison case-folds and sorts the NAME SET and compares every VALUE',
        pinnedEvidence: 'internal/outbound/transport.go:16-27 ("Header casing and order, because net/http canonicalises them") and AGENTS rule 30 (byte-exact recorder and production transport are different roles); docs/network-egress.md records the same split',
        field: 'layers.providerWire.requests[].rawHeaders — names case-folded and sorted, order not compared',
        test: 'guard wire-headers-equal uses semanticProviderHeaders(); a name set difference or any non-normalised value difference is reported',
        negativeCase: 'a19-oracle-teeth.mjs mutates the AUTHORIZATION header VALUE on one leg and requires wire-headers-equal red; removing a header from one leg also reds',
    },
    {
        id: 'provider-wire-accept-encoding',
        reason: 'Go advertises only the encodings it can decode: it has no brotli decoder in the pure-Go dependency set, so net/http sends `gzip` where node-fetch sent `gzip, deflate, br`. An encoding nobody asked for becomes a causal error instead of bytes that fail to parse',
        pinnedEvidence: 'internal/outbound/transport.go:21-27 ("Accept-Encoding: gzip instead of gzip, deflate, br. We have no brotli decoder...") and docs/network-egress.md:169-170; docs/compat-matrix.md records the same brotli limitation for response compression',
        field: 'provider request header accept-encoding VALUE only (presence and name still required)',
        test: 'semanticProviderHeaders() normalises this one value and records this entry; any other header value remains compared',
        negativeCase: 'a19-oracle-teeth.mjs changes the accept-encoding value on one leg and requires it to SURVIVE (the normalisation is narrow); changing any other value requires a red',
    },
    {
        id: 'provider-wire-connection',
        reason: 'the captured `connection: close` is node-fetch\'s agent; the production client\'s reuse follows the shipped enableKeepAlive config (default false) and net/http manages the header, so the VALUE is transport, not product. Presence is still required',
        pinnedEvidence: 'internal/outbound/transport.go:16-21 ("Connection: keep-alive where the captures record close ... enableKeepAlive (src/command-line.js:323, default false at :80) decides it")',
        field: 'provider request header connection VALUE only',
        test: 'semanticProviderHeaders() normalises this one value and records this entry',
        negativeCase: 'a19-oracle-teeth.mjs changes the connection value on one leg and requires it to SURVIVE; a header NAME SET change still reds',
    },
    {
        id: 'http-get-multiplicity',
        reason: 'idempotent GET multiplicity differs because of browser-side scheduling, not the subject: the frontend token-count cache is populated after its async completes, so the slower leg issues duplicate count requests, and duplicate asset GETs are retries. Non-GET multiplicity IS compared exactly',
        pinnedEvidence: 'measured in the self-check run 2026-11-08: identical tokenizer-count request bodies occur once on GoTavern and twice on pinned; `POST /api/worldinfo/get` 2 vs 3; `GET .../NotoSans-ExtraBold.woff2` 1 vs 2, while every POST count was equal. The frontend cache/async mechanism is `public/scripts/tokenizers.js` countAsync',
        field: 'layers.http.requests[] GET multiplicity only',
        test: 'guard http-request-set-equal compares GET as a SET and non-GET as an exact multiset; totals are recorded as diagnostics',
        negativeCase: 'a19-oracle-teeth.mjs adds a UNIQUE GET key to one leg and requires http-request-set-equal red; adding a POST on one leg also reds',
    },
    {
        id: 'http-request-order',
        reason: 'the ORDER of independent page requests is browser scheduling; two subjects given the same input do not have to fetch independent resources in the same sequence. Each request is still compared by method/path/query/count/body',
        pinnedEvidence: 'measured in the self-check run 2026-11-08: the same 21 tokenizer-count bodies arrived in different orders on the two legs; no body or count changed',
        field: 'layers.http.requests[] ordering',
        test: 'guard http-request-set-equal compares multisets, never sequences; the entry is recorded only when the sequences differ',
        negativeCase: 'a19-oracle-teeth.mjs changes a request BODY and requires http-bodies-equal red; a missing/extra key reds the set guard',
    },
    {
        id: 'per-leg-peer-endpoint',
        reason: 'each leg configures the page to ITS OWN recording peer on a controlled-range random port, and the peer URL is echoed into settings and page state. Only the loopback port is normalised to <PEER>; the rest of the URL is compared',
        pinnedEvidence: 'tests/browser/port-lease.mjs (controlled-range lease) and the self-check measurement: `oai_settings.custom_url` was http://127.0.0.1:61849/v1 vs :61279/v1, i.e. the two legs\' own peers',
        field: 'JSON string values of the form http://127.0.0.1:<port>(/v1) in compared bodies and product JSON documents; provider Host header port',
        test: 'projectJsonForComparison() and semanticProviderHeaders() replace only the loopback port and record this entry',
        negativeCase: 'a19-oracle-teeth.mjs changes a compared settings member outside the peer URL and requires persistence-changed-content-equal red',
    },
    {
        id: 'chat-integrity-random-id',
        reason: 'chat_metadata.integrity is a fresh random identifier the frontend writes per saved chat; it is an independent run identifier, which the user prompt names as an allowed non-semantic difference',
        pinnedEvidence: 'public/script.js chat save path writes `chat_metadata.integrity`; measured in the self-check run 2026-11-08 as two different UUIDs in the two legs\' chat-save bodies while every message was equal',
        field: 'JSON member chat_metadata.integrity in compared bodies and chat JSONL',
        test: 'projectJsonForComparison() omits the member and records this entry',
        negativeCase: 'a19-oracle-teeth.mjs changes a compared message TEXT in a chat body and requires http-bodies-equal red',
    },
    {
        id: 'generation-timing-members',
        reason: 'gen_started, gen_finished and extra.time_to_first_token are wall-clock/duration measurements of the generation, not content; two isolated runs cannot have the same values',
        pinnedEvidence: 'public/script.js records these members on the saved message; measured in the self-check run 2026-11-08 (ttft 160 vs 147 ms, different generation timestamps) while the message text was equal after the shared-marker fix',
        field: 'JSON members gen_started, gen_finished, time_to_first_token (recursively)',
        test: 'projectJsonForComparison() omits them and records this entry',
        negativeCase: 'a19-oracle-teeth.mjs changes a compared message TEXT in a chat body and requires http-bodies-equal red',
    },
    {
        id: 'static-frontend-validator-headers',
        reason: 'a release install serves `public/**` from the EMBEDDED tree (the archive ships no physical public/ directory), so a static response has no modification time: it carries no ETag/Last-Modified, cannot answer 304/412, and the browser revalidates by re-fetching where pinned gets a conditional 304. The 200-body surface, media type and the resolved status are still compared',
        pinnedEvidence: 'docs/compat-matrix.md "Frontend static middleware" row: "GoTavern reads <InstallRoot>/public first and falls back to the embedded vendored tree, so a release must ship public/** on disk to keep validator parity; for a file served from the embedded copy there is no modification time, so it carries no ETag or Last-Modified and answers 200 where pinned answers 304 and can never answer 412 -- the divergence ARCHITECTURE.md:458 permits by allowing a runtime with no physical public/ tree"',
        field: 'static (non-/api, non-third-party-extension) response headers etag, last-modified, vary, content-encoding, accept-ranges; static request headers if-none-match, if-modified-since, if-match, if-range; and a 200-vs-304 status pair for the same static path',
        test: 'http-bodies-equal treats a static 200/304 pair as "the stored resource resolved", skips the validator/conditional headers for static paths only, and records this entry; a 200/404 or a different body still reds',
        negativeCase: 'a19-oracle-teeth.mjs changes a compared static response BODY on one leg and requires http-bodies-equal red; static-asset status pairs are the only status difference normalised',
    },
    {
        id: 'x-response-time-value',
        reason: 'the response-time middleware emits an elapsed-milliseconds header; its VALUE is a duration of that request, not content. Its PRESENCE and name remain compared',
        pinnedEvidence: 'src/server-main.js responseTime middleware; measured in the self-check run 2026-11-08 as x-response-time 0.000ms vs 1.006ms on the same static path',
        field: 'HTTP response header x-response-time VALUE only',
        test: 'comparableHeaders() excludes this one value and records this entry; presence is recorded in detail',
        negativeCase: 'a19-oracle-teeth.mjs mutates a compared response header (content-type) and requires http-bodies-equal red',
    },
    {
        id: 'response-content-encoding',
        reason: 'pinned prefers brotli when the browser offers br; GoTavern has no brotli encoder in the standard library, so it answers gzip. This is the recorded response-compression deviation; the DECODED body is what the comparison asserts',
        pinnedEvidence: 'docs/compatibility-matrix.md: "ONE RECORDED DEVIATION: pinned prefers br when the client offers it (Node 24 has brotli) while GoTavern answers gzip, and a br-only client receives identity"; docs/audit-v0.1.0-alpha.15.md C-13',
        field: 'HTTP response header content-encoding VALUE for compressible bodies',
        test: 'comparableHeaders() records this entry and excludes only this header; status/content-type/decoded body remain compared',
        negativeCase: 'a19-oracle-teeth.mjs changes a compared response header (content-type) and requires http-bodies-equal red',
    },
    {
        id: 'http-readonly-multiplicity',
        reason: 'a READ-ONLY route may be called a different number of times between two isolated runs because of frontend caching/async scheduling; the route list is explicit (worldinfo/get, tokenizers count, settings/get, chats/get, chats/recent, characters/all) and a write route on it is not covered',
        pinnedEvidence: 'measured in the self-check run 2026-11-08: POST /api/worldinfo/get 2 vs 3 and tokenizer counts 29 vs 33 with identical request bodies, while every write-route count except the debounced settings save was equal',
        field: 'layers.http.requests[] multiplicity for the named read-only routes only',
        test: 'http-request-set-equal and http-bodies-equal consult READ_MULTIPLICITY_ROUTES and record this entry; other routes keep exact multiplicity',
        negativeCase: 'a19-oracle-teeth.mjs duplicates a POST /api/chats/save and requires http-request-set-equal red',
    },
    {
        id: 'image-metadata-added-timestamp',
        reason: 'image-metadata.json records when each image was first observed; the value is the wall clock of the run and a second isolated run cannot reproduce it. The POINTER (which image, in which folder) is still compared, and any change to a non-timestamp member reds',
        pinnedEvidence: 'PINNED RUNS TWICE (the Lead\'s negative-case requirement): the same pinned subject over two copies of the same corpus produced addedTimestamp 1794192098312 (self-check run 1) and 1794193041570 (run 2) for backgrounds/__transparent.png -- the field is nondeterministic WITHIN pinned itself',
        field: 'JSON member addedTimestamp inside default-user/image-metadata.json (recursively)',
        test: 'projectJsonForComparison() omits the member and records this entry; persistence-changed-content-equal compares the projected digest of image-metadata.json',
        negativeCase: 'a19-oracle-teeth.mjs ADDS AN IMAGE ENTRY to image-metadata.json on one leg and requires persistence-changed-content-equal red',
    },
    {
        id: 'http-autosave-multiplicity',
        reason: 'the frontend saves settings on a debounce; how many saves a leg issues before the final state is reached is scheduling, not content. The FINAL persisted settings are compared byte-oriented after their named projections',
        pinnedEvidence: 'measured in the self-check run 2026-11-08: POST /api/settings/save fired 4 times on one leg and 6 on the other, with both subject trees ending identical (persona depth 2, main_api openai)',
        field: 'layers.http.requests[] multiplicity for POST /api/settings/save only',
        test: 'the named route list normalises this multiplicity; persistence-changed-content-equal asserts the final settings content',
        negativeCase: 'a19-oracle-teeth.mjs changes a final settings member (depth 4 -> 5) and requires persistence-changed-content-equal red',
    },
    {
        id: 'settings-auto-update-default',
        reason: 'THE PRODUCT DECISION: auto-update defaults to OFF and every ambiguous input resolves to OFF, overriding pinned\'s own default. /api/settings/get therefore reports enable_extensions_auto_update=false where pinned reports true, for the SAME seeded config. This is a recorded divergence, not a defect',
        pinnedEvidence: 'AGENTS.md product rule 26 ("Auto-update defaults to OFF ... This overrides pinned\'s own default (upstream/default/config.yaml:301, :396); diverging from upstream here is the product decision, and it is recorded as such")',
        field: 'HTTP JSON response member enable_extensions_auto_update in /api/settings/get (recursively projected)',
        test: 'projectJsonForComparison() omits this member and records this entry; every other settings member is still compared',
        negativeCase: 'a19-oracle-teeth.mjs changes a DIFFERENT settings/get member on one leg and requires http-bodies-equal red; changing this member alone must survive',
    },
    {
        id: 'live-egress-body',
        reason: 'a route that PASSES THROUGH a live third-party service returns data owned by that service, not by the subject; comparing bodies would compare two live responses. Its STATUS is still compared, so a broken passthrough is visible',
        pinnedEvidence: 'AGENTS rule 14 ("A probe must not be able to reach the live network ... live third-party data") and the extension-corpus probe\'s liveEgress flag for /api/horde/; measured in self-check run5: /api/horde/text-models bodies differed between legs while status and content-type agreed',
        field: 'HTTP response BODY of /api/horde/* only',
        test: 'http-bodies-equal skips the response body for /api/horde/* and records this entry; status/content-type/headers are still compared',
        negativeCase: 'a19-oracle-teeth.mjs changes a NON-horde response body and requires http-bodies-equal red',
    },
    {
        id: 'etag-derived-from-projected-body',
        reason: 'the weak ETag is a digest of the response BYTES. When a named projection made two bodies differ by design (auto-update decision, wall-clock members, per-leg peer URL) the byte-derived ETag MUST differ; comparing it would re-import the difference the named decision removed. When the raw bodies ARE byte-equal the ETag is still compared',
        pinnedEvidence: 'internal/httpx/httpx.go:23-30 (WeakETag = sha1 over the exact bytes) and Express default weak etags; measured in self-check run5: settings/get body differed only by enable_extensions_auto_update, and its ETag differed accordingly',
        field: 'HTTP response header etag, ONLY when the raw response body digests differ',
        test: 'http-bodies-equal deletes etag from the compared set only when rawBodiesEqual is false, and records this entry',
        negativeCase: 'a19-oracle-teeth.mjs changes the ETag on a pair whose raw bodies are EQUAL and requires http-bodies-equal red',
    },
    {
        id: 'run-created-chat-name',
        reason: 'the frontend names a chat the run itself creates "<character> - YYYY-MM-DD@HHhMMmSSsNNNms"; the name encodes the leg own wall clock, so two isolated runs minutes apart cannot agree on it. Everything else about the chat (messages, per-tree file identity, final chat surface) is compared',
        pinnedEvidence: 'PINNED RUN TWICE over two copies of the same corpus (Lead negative-case rule): the active chat name was "Legacy Card (v2) - 2026-11-08@19h37m31s553ms" in run5 and "Legacy Card (v2) - 2026-11-08@20h09m29s437ms" in run6 for the same journey',
        field: 'JSON member chat in character/group list responses, ONLY when its value matches the pinned run-created chat-name shape',
        test: 'projectJsonForComparison() maps such a value to <RUN-CHAT> and records this entry; every other chat-named member is compared',
        negativeCase: 'a19-oracle-teeth.mjs changes a NON-chat field in the same list response and requires http-bodies-equal red',
    },
    {
        id: 'sub-millisecond-mtime-timestamps',
        reason: 'date_added/date_last_chat are milliseconds derived from file mtimes. Both subjects read the same file, but converting the nanosecond mtime to a float and formatting it differs in the sub-millisecond digits between Go and JavaScript (measured 1794190102415.045 vs 1794190102415.0444 for one file). The value is compared at whole-millisecond precision, which is the precision the observable (a sort key) uses',
        pinnedEvidence: 'measured 2026-11-08 self-check run6: same corpus, same preserved file mtime, pinned 1794190102415.0444 / GoTavern 1794190102415.045; the whole-millisecond part is identical',
        field: 'JSON members date_added and date_last_chat in list responses, floored to whole milliseconds',
        test: 'projectJsonForComparison() floors those numeric members and records this entry; a one-millisecond change still reds',
        negativeCase: 'a19-oracle-teeth.mjs adds 1000 ms to date_added on one leg and requires http-bodies-equal red; changing only the sub-millisecond fraction must survive',
    },
    {
        id: 'tokenizer-endpoint-load-race',
        reason: 'while settings are still loading the frontend picks its token-count endpoint from the settings it has so far; one run counted one character name through /api/tokenizers/llama/encode instead of /api/tokenizers/openai/count. The token COUNT VALUES for the shared texts are still compared; the endpoint CHOICE during load is scheduling, not a product claim',
        pinnedEvidence: 'measured 2026-11-08 across four self-check runs of the same corpus/journey: 1 llama/encode request in 67 tokenizer requests, only on one leg of one run; the other 66 used openai/count and every shared count value was identical',
        field: 'the request MULTISET entry POST /api/tokenizers/llama/encode only',
        test: 'http-request-set-equal and http-bodies-equal skip that exact route and record this entry; /api/tokenizers/openai/count bodies are compared, and its VALUE mutation reds',
        negativeCase: 'a19-oracle-teeth.mjs changes an /api/tokenizers/openai/count response body and requires http-bodies-equal red',
    },
    {
        id: 'autosave-request-bodies',
        reason: 'the settings autosave is debounced and carries the frontend INTERMEDIATE state: asynchronous startup passes (the persona-initialisation pass) interleave differently between two legs, so a save issued while one leg is still initialising carries fields the other has already normalised. The FINAL persisted settings are compared byte-oriented (persistence-changed-content-equal), which is the user-visible state',
        pinnedEvidence: 'measured 2026-11-08 self-check run6: /api/settings/save request bodies differed in power_user.persona_descriptions (depth 4/CORPUS_PERSONA on one leg, depth 2/empty on the other) while BOTH final settings.json trees were identical after projection and persistence-changed-content-equal was green',
        field: 'the POST /api/settings/save REQUEST body only (the response and every final file are compared)',
        test: 'http-bodies-equal skips the autosave request body and records this entry; the persistence layer compares the final settings documents',
        negativeCase: 'a19-oracle-teeth.mjs changes the FINAL persisted settings (persona depth) and requires persistence-changed-content-equal red',
    },
    {
        id: 'run-last-chat-timestamp',
        reason: 'date_last_chat is the LAST-INTERACTION clock of the run, written while each leg drives its own copy of the journey; two legs minutes apart cannot agree on it. It is projected as run-state; the rest of the card/group list (identities, order, every other field) is compared',
        pinnedEvidence: 'measured 2026-11-08 self-check run7: the same corpus, the same journey, date_last_chat 1794198448579 on GoTavern vs 1794198697183 on pinned (4 min apart, the legs run sequentially)',
        field: 'JSON member date_last_chat in list responses',
        test: 'projectJsonForComparison() maps it to <RUN-STATE> and records this entry; date_added keeps the whole-millisecond comparison',
        negativeCase: 'a19-oracle-teeth.mjs changes a WHOLE millisecond of date_added and requires http-bodies-equal red (survivor: a date_last_chat change alone survives, proving the projection is scoped to that member)',
    },
    {
        id: 'route-scoped-run-clock-members',
        reason: 'a member whose NAME is generic but whose VALUE is the run clock on one route only: chats/recent.last_mes is the ISO time of the last message and stats.timestamp is the run start. Projecting them by name GLOBALLY would hide real differences on other routes, so the decision is scoped to the exact request keys where the clock was measured',
        pinnedEvidence: 'measured 2026-11-08 self-check run7, two isolated legs: /api/chats/recent last_mes "2026-11-09T04:27:11.882Z" vs "2026-11-09T04:31:36.351Z"; /api/stats/get timestamp 1794198418985 vs 1794198694841',
        field: 'JSON members last_mes (POST /api/chats/recent) and timestamp (POST /api/stats/get and /api/stats/update) only',
        test: 'ROUTE_SCOPED_RUN_CLOCK maps the request key to the member set; projectBodyForComparison() receives the key and records this entry',
        negativeCase: 'a19-oracle-teeth.mjs changes a NON-clock member of the same response and requires http-bodies-equal red',
    },
    {
        id: 'tokenizer-exactness-headers',
        reason: 'exactly TWO GoTavern-only response headers are a RECORDED, accepted delta: X-GoTavern-Tokenizer-Exact and X-GoTavern-Tokenizer-Layout say the tokenizer is exact and which layout served it. Pinned carries NEITHER. The decision removes ONLY these two names and ONLY when pinned does not carry them; any OTHER GoTavern-only response header, and either of these appearing on the PINNED side, still reds',
        pinnedEvidence: 'docs/gap-sweep.md:185 ("pinned carries no exactness header, GoTavern is exact on every response") and internal/server/tokenizers_exactness_test.go; measured self-check run7: pinned responses carried neither header',
        field: 'HTTP response headers x-gotavern-tokenizer-exact and x-gotavern-tokenizer-layout, only when absent on the pinned side',
        test: 'http-bodies-equal removes exactly those two names from the GoTavern header set when pinned lacks them and records this entry; a pinned-side appearance is a problem',
        negativeCase: 'a19-oracle-teeth.mjs adds a DIFFERENT GoTavern-only response header and requires http-bodies-equal red; adding either exactness header to the PINNED leg also reds',
    },
    {
        id: 'tokenizer-count-multiplicity',
        reason: 'the frontend asks for the same token count more or fewer times depending on which load/debounce path it takes; measured run9/run10: the same 20 unique tokenizer request bodies arrived 21 vs 32 times, in a different order. Identity pairing pairs identical requests and the COUNT VALUES of every identity are still compared; only the repeated occurrence count is scheduling',
        pinnedEvidence: 'measured 2026-11-08 self-check runs 9 and 10: 21 vs 32 tokenizer-count occurrences over the SAME unique request-body set; every identity-paired response was identical (run9: 21/21 pairs, 0 response differences)',
        field: 'layers.http.requests[] multiplicity for /api/tokenizers/* only',
        test: 'http-bodies-equal records this entry when identical requests occur a different number of times; the request-set guard has its own named read-only multiplicity decision',
        negativeCase: 'a19-oracle-teeth.mjs mutates a tokenizer count RESPONSE body and requires http-bodies-equal red (values stay compared); duplicating a non-tokenizer POST still reds via http-request-set-equal',
    },
    {
        id: 'tokenizer-count-scheduling',
        reason: 'the frontend counts tokens for whatever messages it holds when a counter pass runs; two isolated legs run those passes at different load moments and therefore counted different SUBSETS (GoTavern counted the greeting pair with an empty speaker name at load; pinned counted 29 product-save-path messages later). Every SHARED identitys token COUNT is still compared',
        pinnedEvidence: 'corpus-v2 drive 2026-11-08: 169/169 shared tokenizer request identities answered identical token_counts; the differing SET rows are explained by the recorded pre-send chat state (both legs: length 6, names ["A19R1 Glass Garden 2","Probe User",...], name1/name2 set) and by WHEN the passes ran; the single recorded null was a transient body-read and a direct probe of the same body on GoTavern and pinned answers {"token_count":23} on both',
        field: 'HTTP request-set membership of /api/tokenizers/* only (identity present on one side); every shared identity is still paired and its count body compared',
        test: 'http-bodies-equal records this entry for an unmatched /api/tokenizers/* identity; the paired comparison still mutates-red on a changed count body',
        negativeCase: 'a19-oracle-teeth.mjs mutates a tokenizer count response body and requires http-bodies-equal red; dropping an unmatched tokenizer request must survive',
    },
    {
        id: 'derived-chat-file-size',
        reason: 'characters/all chat_size and chats/recent file_size are the byte size of the saved chat JSONL, which embeds the runs own wall-clock send_date values and generation-timing numbers whose DIGIT COUNTS vary between legs; the message content, role, author name and stripped-text digest are compared by persistence-chat-semantics-equal, so a different message still reds',
        pinnedEvidence: 'corpus-v2 drive 2026-11-08: the same chat JSONL was 4438 vs 4440 bytes and the first differing bytes were send_date "2026-11-09T06:41:53.793Z" vs "06:44:53.971Z"; persistence-chat-semantics-equal was green (roles/names/text lengths/stripped digests equal)',
        field: 'JSON members chat_size (POST /api/characters/all) and file_size (POST /api/chats/recent) only',
        test: 'ROUTE_SCOPED_RUN_CLOCK projects those two members and records this entry; the chat semantics tuple and every other field are still compared',
        negativeCase: 'a19-oracle-teeth.mjs changes a chat MESSAGE TEXT and requires persistence-chat-semantics-equal red; changing only chat_size must survive',
    },
];

const appliedNormalisations = new Set();

// ---------------------------------------------------------------------------------------------------------
// HELPERS.
// ---------------------------------------------------------------------------------------------------------
const problemsFor = (leg, label) => {
    if (!leg) return [`${label} report is missing or unreadable`];
    if (leg.failure) return [`${label} leg failed: ${leg.failure}`];
    const failed = (leg.steps ?? []).filter(step => step.ok !== true).map(step => step.name);
    if (failed.length > 0) return [`${label} leg steps failed: ${failed.join(', ')}`];
    return [];
};

const discriminatorPattern = new RegExp(`A19(?:HB)?[GP]_`, 'g');
const stripDiscriminator = text => {
    const value = String(text ?? '');
    if (discriminatorPattern.test(value)) appliedNormalisations.add('per-subject-reply-discriminator');
    discriminatorPattern.lastIndex = 0;
    return value.replace(discriminatorPattern, '<REPLY_PREFIX>');
};

const PORT_IN_STRING = /127\.0\.0\.1:\d{2,5}/;
const assertNoUnstableField = (value, where, problems) => {
    if (typeof value !== 'string') return;
    if (PORT_IN_STRING.test(value)) {
        appliedNormalisations.add('harness-random-port-in-recorded-strings');
        problems.push(`${where} still carries a host:port (${PORT_IN_STRING.exec(value)?.[0]}), so an unstable harness value survived into a compared field (AGENTS rule 18)`);
    }
};

// ---------------------------------------------------------------------------------------------------------
// LAYER-B BODY / HEADER COMPARISON, WITH ITS NAMED NORMALISATIONS APPLIED (never a global ignore).
// ---------------------------------------------------------------------------------------------------------

// THE NAMED JSON MEMBERS THAT ARE NOT SUBJECT BEHAVIOUR. Each maps to the normalisation id that owns it, so a
// projection can never drop a member without the corresponding decision being recorded. Applied to SUBJECT HTTP
// bodies and the product-surface JSON documents only; the provider wire is byte-oriented and is never parsed.
const PROJECTED_JSON_KEYS = new Map([
    ['send_date', 'wall-clock-json-members'],
    ['create_date', 'wall-clock-json-members'],
    ['gen_started', 'generation-timing-members'],
    ['gen_finished', 'generation-timing-members'],
    ['time_to_first_token', 'generation-timing-members'],
    ['integrity', 'chat-integrity-random-id'],
    ['addedTimestamp', 'image-metadata-added-timestamp'],
    // THE RECORDED PRODUCT DECISION (AGENTS rule 26): auto-update defaults OFF, overriding pinned's own default.
    ['enable_extensions_auto_update', 'settings-auto-update-default'],
]);
const PEER_URL_PATTERN = /http:\/\/127\.0\.0\.1:\d+(?:\/v1)?/g;
// A CHAT NAME the RUN ITSELF created: the frontend names a new chat "<character> - YYYY-MM-DD@HHhMMmSSsNNNms", so
// the name embeds the leg's own wall clock. Two isolated runs minutes apart cannot agree on it, and everything else
// about the chat (its messages, its file's identity inside each tree) is compared by the persistence layer.
const RUN_CREATED_CHAT_NAME = /\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d+ms/;
// MILLISECOND TIMESTAMPS DERIVED FROM FILE MTIMES. Both subjects read the SAME file mtime, but Go formats the
// nanosecond-to-float conversion differently in the last sub-millisecond digits (measured: pinned 1794190102415.0444
// vs GoTavern 1794190102415.045 for one file). The value is compared at whole-millisecond precision, which is the
// observable (a sort key) actually uses; a change of one millisecond still reds.
// date_last_chat is NOT in this set: it is the RUN's last-interaction clock and differs between legs by minutes
// (measured run7: 1794198448579 vs 1794198697183), so it is projected as run-state by RUN_STATE_JSON_KEYS.
const SUB_MILLISECOND_TIMESTAMP_KEYS = new Set(['date_added']);
const RUN_STATE_JSON_KEYS = new Set(['date_last_chat']);
// ROUTE-SCOPED wall-clock members: a field name that is meaningful on one route and stable on another must be
// projected only where it is measured to be the run's own clock.
const ROUTE_SCOPED_RUN_CLOCK = new Map([
    ['POST /api/chats/recent', new Set(['last_mes'])],
    ['POST /api/stats/get', new Set(['timestamp'])],
    ['POST /api/stats/update', new Set(['timestamp'])],
    // A GROUP's date_added is the moment THIS run created the group (measured run9: 1794200820667.4832 vs
    // 1794200821259.2122, 591 ms apart), unlike a character's mtime-derived date_added, which stays compared.
    ['POST /api/groups/all', new Set(['date_added'])],
    // A character the journey EDITS has its file rewritten during each leg, so its mtime-derived date_added is that
    // leg's clock; the rest of the corpus cards keep stable mtimes (their sub-millisecond part is handled by the
    // mtime decision). Measured release run 2026-11-08: edited card date_added 1794204775623.7305 vs
    // 1794205015221.9177 (239 s apart = the leg clocks).
    ['POST /api/characters/all', new Set(['date_added', 'chat_size'])],
    ['POST /api/chats/recent', new Set(['last_mes', 'file_size'])],
    // The connection configuration writes an api_key_custom secret through the frontend in each leg: the id is
    // generated fresh and the label is the leg's own clock. Measured: labels "11/08/2026 10:12 PM" vs "10:16 PM".
    ['POST /api/secrets/read', new Set(['id', 'label'])],
    ['POST /api/secrets/write', new Set(['id', 'label'])],
    // The persisted secrets file carries the same run-created entries (see the file route key used by the
    // persistence guard).
    ['file:default-user/secrets.json', new Set(['id', 'label'])],
]);
const projectJsonForComparison = (value, routeRunClock = null) => {
    if (Array.isArray(value)) return value.map(item => projectJsonForComparison(item, routeRunClock));
    if (value && typeof value === 'object') {
        const projected = {};
        for (const key of Object.keys(value).sort()) {
            const normalisation = PROJECTED_JSON_KEYS.get(key);
            if (normalisation !== undefined) { appliedNormalisations.add(normalisation); continue; }
            if (key === 'chat' && typeof value[key] === 'string' && RUN_CREATED_CHAT_NAME.test(value[key])) {
                appliedNormalisations.add('run-created-chat-name');
                projected[key] = '<RUN-CHAT>';
                continue;
            }
            if (RUN_STATE_JSON_KEYS.has(key) && typeof value[key] === 'number') {
                appliedNormalisations.add('run-last-chat-timestamp');
                projected[key] = '<RUN-STATE>';
                continue;
            }
            if (routeRunClock !== null && routeRunClock.has(key)) {
                appliedNormalisations.add('route-scoped-run-clock-members');
                projected[key] = '<RUN-CLOCK>';
                continue;
            }
            if (SUB_MILLISECOND_TIMESTAMP_KEYS.has(key) && typeof value[key] === 'number') {
                appliedNormalisations.add('sub-millisecond-mtime-timestamps');
                projected[key] = Math.floor(value[key]);
                continue;
            }
            projected[key] = projectJsonForComparison(value[key], routeRunClock);
        }
        return projected;
    }
    if (typeof value === 'string') {
        if (PEER_URL_PATTERN.test(value)) { appliedNormalisations.add('per-leg-peer-endpoint'); PEER_URL_PATTERN.lastIndex = 0; }
        PEER_URL_PATTERN.lastIndex = 0;
        return stripDiscriminator(value).replace(PEER_URL_PATTERN, '<PEER>');
    }
    return value;
};
// A ZERO-LENGTH BODY AND AN ABSENT BODY ARE THE SAME WIRE (0 bytes): Playwright reports the first as "" and the
// second as null, and the recorder cannot tell them apart. Only when BOTH sides are empty is that a named decision;
// one side empty vs a present body, and two empty bodies whose recorded digests differ, are real differences.
const compareHTTPBody = (label, leftText, leftSha, rightText, rightSha, options) => {
    const leftEmpty = leftText === null || leftText === undefined || leftText === '';
    const rightEmpty = rightText === null || rightText === undefined || rightText === '';
    if (leftEmpty && rightEmpty) {
        // The recorder writes the digest of the empty body in some paths and no digest in others; both mean 0
        // bytes. An ABSENT digest is therefore the empty-body digest, and any other digest is still a difference.
        const emptyDigest = sha256(Buffer.from('', 'utf8'));
        if ((leftSha ?? emptyDigest) !== (rightSha ?? emptyDigest)) return `${label}: both bodies are absent/empty but the recorded digests differ (${leftSha?.slice(0, 12)} vs ${rightSha?.slice(0, 12)})`;
        appliedNormalisations.add('empty-response-body-recording');
        return null;
    }
    if (leftEmpty !== rightEmpty) {
        return `${label}: one body is absent/empty (${leftEmpty ? leftSha?.slice(0, 12) : rightSha?.slice(0, 12)}) and the other is not`;
    }
    const left = projectBodyForComparison(leftText, options);
    const right = projectBodyForComparison(rightText, options);
    if (left === right) return null;
    return `${label}: body differs after named normalisation (raw ${leftSha?.slice(0, 12)} vs ${rightSha?.slice(0, 12)})`;
};
const projectBodyForComparison = (text, { routeKey = null } = {}) => {
    try { return sha256(Buffer.from(JSON.stringify(projectJsonForComparison(JSON.parse(text), ROUTE_SCOPED_RUN_CLOCK.get(routeKey) ?? null)), 'utf8')); } catch {
        appliedNormalisations.add('per-leg-peer-endpoint');
        return sha256(Buffer.from(stripDiscriminator(text).replace(PEER_URL_PATTERN, '<PEER>'), 'utf8'));
    }
};

// HEADER SEMANTICS FOR THE PRODUCTION TRANSPORT (AGENTS rule 30; internal/outbound/transport.go:16-27):
// header NAME casing and ORDER are net/http's, not node-fetch's, so they are compared case-insensitively and
// order-insensitively; header VALUES stay compared, except the two value deltas that are themselves recorded
// decisions (accept-encoding, connection). `host` is the per-leg peer itself, so only its port is normalised.
const PRODUCTION_TRANSPORT_VALUE_NORMALISATIONS = new Map([
    ['accept-encoding', 'provider-wire-accept-encoding'],
    ['connection', 'provider-wire-connection'],
]);
const semanticProviderHeaders = rawHeaders => {
    const names = [];
    const byName = {};
    for (const header of rawHeaders ?? []) {
        const lower = String(header.name).toLowerCase();
        names.push(lower);
        if (PRODUCTION_TRANSPORT_VALUE_NORMALISATIONS.has(lower)) {
            appliedNormalisations.add('provider-wire-header-name-case-and-order');
            appliedNormalisations.add(PRODUCTION_TRANSPORT_VALUE_NORMALISATIONS.get(lower));
            byName[lower] = '<normalised>';
            continue;
        }
        if (lower === 'host') {
            appliedNormalisations.add('per-leg-peer-endpoint');
            byName.host = String(header.value).replace(/^127\.0\.0\.1:\d+$/, '127.0.0.1:<PEER>');
            continue;
        }
        byName[lower] = header.value;
    }
    if (names.length > 0) appliedNormalisations.add('provider-wire-header-name-case-and-order');
    // SORTED ENTRIES, not an object: an object's key order is insertion order, so JSON.stringify would make two
    // identical header SETS differ on order alone -- which is the exact thing this normalisation removes.
    return { names: [...names].sort(), byName: Object.keys(byName).sort().map(name => [name, byName[name]]) };
};
// READ-ONLY / AUTOSAVE ROUTES whose request MULTIPLICITY may differ between two isolated runs. This is a NAMED
// route list, not a method rule: a write route that is not on it keeps exact multiplicity.
const READ_MULTIPLICITY_ROUTES = [
    { match: path => path === '/api/worldinfo/get', normalisation: 'http-readonly-multiplicity' },
    { match: path => path.startsWith('/api/tokenizers/'), normalisation: 'http-readonly-multiplicity' },
    { match: path => path === '/api/settings/get', normalisation: 'http-readonly-multiplicity' },
    { match: path => path === '/api/chats/get' || path === '/api/chats/recent', normalisation: 'http-readonly-multiplicity' },
    { match: path => path === '/api/characters/all', normalisation: 'http-readonly-multiplicity' },
    // The frontend's debounced settings save: how MANY saves a leg issues is autosave timing. The CONTENT of the
    // final persisted settings is compared by persistence-changed-content-equal, which has a teeth case.
    { match: path => path === '/api/settings/save', normalisation: 'http-autosave-multiplicity' },
];
const multiplicityNormalisation = (request, key) => {
    if (request.method === 'GET' || key.startsWith('GET ')) return 'http-get-multiplicity';
    for (const route of READ_MULTIPLICITY_ROUTES) {
        if (route.match(request.path)) return route.normalisation;
    }
    return null;
};

// STATIC-FRONTEND RESPONSE HEADERS: a release install serves `public/**` from the EMBEDDED tree (the archive keeps
// no physical public/ directory), so it has no modification time and carries no ETag/Last-Modified and cannot
// answer 304/412 -- a divergence ARCHITECTURE.md 458 permits and compat-matrix.md's "Frontend static middleware"
// row records in full. The 200-body surface is still compared. API routes are NOT exempted: their ETag semantics
// are part of the route contracts.
const STATIC_VALIDATOR_HEADERS = new Set(['etag', 'last-modified', 'vary', 'content-encoding', 'accept-ranges']);
const isStaticAssetRequest = request => typeof request.path === 'string' && request.path.startsWith('/') && !request.path.startsWith('/api/') && !request.path.startsWith('/scripts/extensions/third-party/');
const STATIC_CONDITIONAL_REQUEST_HEADERS = new Set(['if-none-match', 'if-modified-since', 'if-match', 'if-range']);
const SESSION_HEADERS = new Set(['cookie', 'set-cookie', 'x-csrf-token']);
const LOOPBACK_ORIGIN = /http:\/\/127\.0\.0\.1:\d+/g;
const normaliseHeaderValue = key => value => {
    if (SESSION_HEADERS.has(key)) { appliedNormalisations.add('independent-session-cookie'); return '<SESSION>'; }
    if (key === 'content-encoding') { appliedNormalisations.add('response-content-encoding'); return '<ENCODING>'; }
    if (typeof value === 'string' && /127\.0\.0\.1:\d+/.test(value)) {
        appliedNormalisations.add('harness-random-port-in-recorded-strings');
        return value.replace(LOOPBACK_ORIGIN, '<BASE>');
    }
    return value;
};
const comparableHeaders = (headers, { staticAsset = false } = {}) => {
    const out = {};
    for (const key of Object.keys(headers ?? {}).sort()) {
        if (['host', 'date', 'age', 'content-length', 'connection', 'keep-alive', 'transfer-encoding', 'x-response-time'].includes(key)) continue;
        if (staticAsset && (STATIC_VALIDATOR_HEADERS.has(key) || STATIC_CONDITIONAL_REQUEST_HEADERS.has(key))) {
            appliedNormalisations.add('static-frontend-validator-headers');
            continue;
        }
        out[key] = normaliseHeaderValue(key)(headers[key]);
    }
    if (headers && Object.prototype.hasOwnProperty.call(headers, 'x-response-time')) appliedNormalisations.add('x-response-time-value');
    if (headers && Object.prototype.hasOwnProperty.call(headers, 'content-encoding')) appliedNormalisations.add('response-content-encoding');
    return out;
};

const EXCLUDED_PATH_PREFIXES = ['_webpack/', '_cache/', 'cookie-secret.txt', 'default-user/backups/', '_storage/', 'thumbnails/', 'default-user/stats.json', 'config.yaml'];
const isExcludedPath = filePath => EXCLUDED_PATH_PREFIXES.some(prefix => filePath === prefix || filePath.startsWith(prefix));
const PRODUCT_SURFACE_PREFIXES = ['default-user/chats/', 'default-user/characters/', 'default-user/worlds/', 'default-user/OpenAI Settings/', 'default-user/QuickReplies/', 'default-user/themes/', 'default-user/backgrounds/', 'default-user/User Avatars/', 'default-user/assets/', 'default-user/settings.json', 'default-user/secrets.json', 'default-user/image-metadata.json'];
const isProductSurface = filePath => PRODUCT_SURFACE_PREFIXES.some(prefix => filePath === prefix || filePath.startsWith(prefix));

/**
 * A chat's COMPARED semantics: the ordered message sequence with the discriminator normalised and the
 * wall-clock send_date omitted. This is a MEASUREMENT of persisted state, not a provider request, so the
 * byte-oriented rule does not forbid parsing here (the JSONL is the product's own format and the compared
 * tuple is named).
 */
const chatSemantics = chat => (chat?.messages ?? []).map(message => ({
    isUser: message.isUser === true,
    name: message.name ?? null,
    mes: stripDiscriminator(normaliseText(message.mesSha256 === null ? '' : '')),
    mesSha256: message.mesSha256,
    mesLength: message.mesLength,
}));

// The chat report carries sha256 of the raw text, which still differs by discriminator; the comparator
// therefore compares (isUser, name, mesLength after stripping discriminator, sha256 after stripping) and
// recomputes the stripped digest instead of trusting the raw one.
const messageTuple = message => {
    const text = stripDiscriminator(message.mesText ?? '');
    return `${message.isUser === true ? 'assistant' : 'user'}|${message.name ?? ''}|${text.length}|${sha256(Buffer.from(text, 'utf8'))}`;
};

const normaliseText = value => String(value ?? '');

const sortedUnique = list => [...new Set(list)].sort();

const censusMaps = leg => {
    const tree = leg?.layers?.persistence?.tree;
    return {
        tree,
        files: new Map((tree?.files ?? []).map(file => [file.path, file])),
        diff: leg?.persistenceDiff ?? { created: [], modified: [], deleted: [] },
    };
};

const cs = entry => (entry ? { path: entry.path, sha256: entry.sha256, bytes: entry.bytes } : null);

// ---------------------------------------------------------------------------------------------------------
// THE GUARD TABLE.
// ---------------------------------------------------------------------------------------------------------
const guards = [];
const details = {};
const guard = (name, layer, run) => {
    let problems = [];
    let detail = null;
    try {
        const result = run();
        if (Array.isArray(result)) problems = result;
        else if (result && typeof result === 'object') { problems = result.problems ?? []; detail = result.detail ?? null; }
    } catch (error) {
        problems = [`guard threw: ${String(error?.message ?? error)}`];
    }
    guards.push({ name, layer, ok: problems.length === 0, problems, detail });
};

// --- LEG PRESENCE / DRIVE ------------------------------------------------------------------------------
const requiredLegNames = ['driveGotavern', 'drivePinned', 'restartGotavern', 'restartPinned'];
guard('legs-present', 'browser', () => requiredLegNames.flatMap(name => (legs[name] ? [] : [`${name} leg report is missing`])));
guard('legs-drove', 'browser', () => requiredLegNames.flatMap(name => problemsFor(legs[name], name)));
guard('corpus-identical', 'persistence', () => {
    const problems = [];
    // ONLY THE IMMUTABLE-INPUT LEGS. A hand-back leg runs over a COPY OF THE OTHER SUBJECT'S WRITTEN TREE, so its
    // census is expected to differ from the corpus identity by exactly what that subject persisted; asserting the
    // corpus digest there would fail a correct hand-back.
    for (const name of requiredLegNames) {
        const leg = legs[name];
        if (!leg || leg.skipped) continue;
        if (corpusTreeSha256 && leg.corpusTreeSha256 !== corpusTreeSha256) problems.push(`${name} drove a corpus with tree ${leg.corpusTreeSha256}, not ${corpusTreeSha256}`);
    }
    return problems;
});

// --- LAYER C: PROVIDER WIRE (byte-oriented) ------------------------------------------------------------
guard('wire-mode-equal', 'providerWire', () => {
    const a = legs.driveGotavern?.layers?.providerWire;
    const b = legs.drivePinned?.layers?.providerWire;
    const problems = [];
    if (!a || !b) return ['drive legs carry no provider-wire layer'];
    if (a.wireMode !== b.wireMode) problems.push(`wireMode differs: ${a.wireMode} vs ${b.wireMode}`);
    return problems;
});
guard('wire-served-the-requested-wire', 'providerWire', () => {
    const problems = [];
    for (const [name, leg] of Object.entries(legs)) {
        const wire = leg?.layers?.providerWire;
        if (!wire) continue;
        for (const request of wire.requests) {
            if (request.requestedStream === true && request.served?.wire !== 'sse') problems.push(`${name}: request #${request.index} asked for streaming but the peer served ${JSON.stringify(request.served?.wire)}; the page would store an empty reply`);
            if (request.requestedStream === true && request.served?.terminal !== true) problems.push(`${name}: request #${request.index} SSE did not terminate`);
        }
    }
    return problems;
});
guard('wire-request-set-equal', 'providerWire', () => {
    const a = legs.driveGotavern?.layers?.providerWire?.requests ?? null;
    const b = legs.drivePinned?.layers?.providerWire?.requests ?? null;
    if (!a || !b) return ['drive legs carry no provider-wire requests'];
    if (a.length !== b.length) return [`completion request count differs: gotavern ${a.length} vs pinned ${b.length}`];
    const problems = [];
    for (let index = 0; index < a.length; index += 1) {
        const left = a[index];
        const right = b[index];
        if (left.method !== right.method) problems.push(`request #${index}: method ${left.method} vs ${right.method}`);
        if (left.rawTarget !== right.rawTarget) problems.push(`request #${index}: raw target ${left.rawTarget} vs ${right.rawTarget}`);
        if (left.bodySha256 !== right.bodySha256) problems.push(`request #${index}: body sha256 ${left.bodySha256.slice(0, 12)} (${left.bodyLength} B) vs ${right.bodySha256.slice(0, 12)} (${right.bodyLength} B)`);
        if (left.bodyLength !== right.bodyLength) problems.push(`request #${index}: body length ${left.bodyLength} vs ${right.bodyLength}`);
    }
    return problems;
});
guard('wire-headers-equal', 'providerWire', () => {
    const a = legs.driveGotavern?.layers?.providerWire?.requests ?? null;
    const b = legs.drivePinned?.layers?.providerWire?.requests ?? null;
    if (!a || !b) return ['drive legs carry no provider-wire requests'];
    if (a.length !== b.length) return ['request counts differ, so headers cannot be paired'];
    const problems = [];
    for (let index = 0; index < a.length; index += 1) {
        const left = semanticProviderHeaders(a[index].rawHeaders);
        const right = semanticProviderHeaders(b[index].rawHeaders);
        // The NAME SET is compared (a missing/extra header is a difference), case-folded and order-free; every
        // VALUE is compared except the two recorded transport deltas inside semanticProviderHeaders.
        if (JSON.stringify(left.names) !== JSON.stringify(right.names)) problems.push(`request #${index}: header name sets differ: ${JSON.stringify(left.names)} vs ${JSON.stringify(right.names)}`);
        if (JSON.stringify(left.byName) !== JSON.stringify(right.byName)) problems.push(`request #${index}: header values differ (outside the named transport deltas): ${JSON.stringify(left.byName)} vs ${JSON.stringify(right.byName)}`);
    }
    return problems;
});
guard('wire-context-shape-equal', 'providerWire', () => {
    // A MEASUREMENT only (equality is decided by bodySha256 above): it says WHERE a byte difference is.
    const a = legs.driveGotavern?.layers?.providerWire?.requests ?? null;
    const b = legs.drivePinned?.layers?.providerWire?.requests ?? null;
    if (!a || !b) return ['drive legs carry no provider-wire requests'];
    const problems = [];
    if (a.length === b.length) {
        for (let index = 0; index < a.length; index += 1) {
            const left = a[index].contextShape;
            const right = b[index].contextShape;
            if (JSON.stringify(left) !== JSON.stringify(right)) problems.push(`request #${index}: context shape differs (${JSON.stringify(left)} vs ${JSON.stringify(right)})`);
        }
    }
    return problems;
});
guard('discriminator-absent-from-compared-wire', 'providerWire', () => {
    const problems = [];
    for (const [name, leg] of Object.entries(legs)) {
        const wire = leg?.layers?.providerWire;
        if (!wire) continue;
        for (const request of wire.requests) {
            if (request.bodyText?.includes('A19G_') || request.bodyText?.includes('A19P_') || request.bodyText?.includes('A19HB_')) {
                problems.push(`${name}: request #${request.index} carries a per-subject discriminator, so the compared wire would differ for a HARNESS reason (rule 50)`);
            }
        }
    }
    return problems;
});

// --- LAYER A: BROWSER -----------------------------------------------------------------------------------
const compareBrowser = (selector, normalise = value => value) => () => {
    const problems = [];
    for (const phase of ['drive', 'restart']) {
        const a = legFor(phase, 'gotavern');
        const b = legFor(phase, 'pinned');
        if (!a || !b) continue;
        const left = normalise(a.layers?.browser?.[selector], 'gotavern');
        const right = normalise(b.layers?.browser?.[selector], 'pinned');
        if (JSON.stringify(left) !== JSON.stringify(right)) problems.push(`${phase}: ${selector} differs: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    }
    return problems;
};
const legFor = (phase, subject) => (phase === 'drive' ? legs.driveGotavern : legs.restartGotavern) && (phase === 'drive' ? legs[`drive${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`] : legs[`restart${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`]);

guard('browser-readiness-equal', 'browser', compareBrowser('readiness', readiness => ({
    settingsReady: readiness?.settingsReady === true,
    appReady: readiness?.appReady === true,
})));
guard('browser-roster-equal', 'browser', compareBrowser('roster', roster => roster?.names ?? []));
guard('browser-images-decoded', 'browser', () => {
    const problems = [];
    for (const phase of ['drive', 'restart']) {
        for (const subject of ['gotavern', 'pinned']) {
            const leg = legFor(phase, subject);
            const images = leg?.layers?.browser?.images ?? null;
            if (!images) { problems.push(`${phase}/${subject}: no image set was recorded`); continue; }
            // AN EMPTY-SRC <img> IS A TEMPLATE, NOT A BROKEN PICTURE. The page carries placeholder images
            // (`zoomed_avatar_img`, message `img_N`, `expression-image`, ...) whose src is empty until a user
            // uses the feature; measured 19 of them on the synthetic corpus, identical on both subjects. The
            // claim is "every image THAT HAS A SOURCE decoded", so only sourced images are required to decode.
            const sourced = images.filter(image => typeof image.src === 'string' && image.src !== '');
            const undecoded = sourced.filter(image => image.decoded !== true);
            if (sourced.length === 0) problems.push(`${phase}/${subject}: no image with a src was recorded, so the decode claim would be vacuous`);
            if (undecoded.length > 0) problems.push(`${phase}/${subject}: ${undecoded.length} SOURCED image(s) did not decode: ${JSON.stringify(undecoded.slice(0, 3).map(image => image.src))}`);
        }
        // Compare the DECODED SURFACE of sourced images by (src, naturalWidth, naturalHeight); pixelDigest is
        // recorded only (codec decision, ARCHITECTURE §35.2).
        const surface = subject => (legFor(phase, subject)?.layers?.browser?.images ?? [])
            .filter(image => typeof image.src === 'string' && image.src !== '')
            .map(image => `${image.src}|${image.naturalWidth}x${image.naturalHeight}`);
        const left = surface('gotavern');
        const right = surface('pinned');
        if (JSON.stringify(left) !== JSON.stringify(right)) problems.push(`${phase}: decoded image surface differs: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    }
    return problems;
});
guard('browser-selected-state-equal', 'browser', compareBrowser('selected', selected => ({
    characterName: selected?.characterName ?? null,
    chatId: selected?.chatId ?? null,
    presetName: selected?.presetName ?? null,
    worldName: selected?.worldName ?? null,
})));
guard('browser-console-errors-equal', 'browser', () => {
    const problems = [];
    for (const phase of ['drive', 'restart']) {
        const left = legFor(phase, 'gotavern')?.layers?.browser?.consoleErrors ?? [];
        const right = legFor(phase, 'pinned')?.layers?.browser?.consoleErrors ?? [];
        left.concat(right).forEach((text, index) => assertNoUnstableField(text, `${phase} console error #${index}`, problems));
        if (JSON.stringify(left) !== JSON.stringify(right)) problems.push(`${phase}: console error sets differ: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    }
    return problems;
});
guard('browser-page-errors-equal', 'browser', () => {
    const problems = [];
    for (const phase of ['drive', 'restart']) {
        const left = legFor(phase, 'gotavern')?.layers?.browser?.pageErrors ?? [];
        const right = legFor(phase, 'pinned')?.layers?.browser?.pageErrors ?? [];
        if (JSON.stringify(left) !== JSON.stringify(right)) problems.push(`${phase}: page error sets differ: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    }
    return problems;
});
/**
 * LAYER-A EVENT ORDER, AS A CLAIM THAT CAN HOLD ON TWO ASYNCHRONOUS RUNS.
 *
 * The raw emitted-event STREAM is not a product observation: two isolated runs interleave independent async
 * handlers differently (measured: extension/settings load events move earlier or later, debounced saves emit a
 * different NUMBER of duplicates, and the same lifecycle event can be re-emitted). What IS a product observation
 * is (a) the CORE events the drive must emit on both subjects, and (b) the causally REQUIRED ordering inside one
 * generation lifecycle. Those are asserted per leg and then compared across subjects; the full streams are
 * recorded as diagnostics and the raw-stream comparison is listed in notCompared.
 */
const CORE_DRIVE_EVENTS = ['main_api_changed', 'chatcompletion_source_changed', 'chat_id_changed', 'message_sent', 'user_message_rendered', 'generation_started', 'GENERATION_AFTER_COMMANDS', 'chat_completion_prompt_ready', 'stream_token_received', 'generation_ended', 'message_received', 'character_message_rendered'];
const REQUIRED_ORDER = [
    // Pinned emits GENERATION_STARTED inside Generate() and MESSAGE_SENT when the user turn is committed, so the
    // generation starts BEFORE the message event (measured on both subjects in self-check run5).
    ['generation_started', 'GENERATION_AFTER_COMMANDS'],
    ['GENERATION_AFTER_COMMANDS', 'message_sent'],
    ['message_sent', 'user_message_rendered'],
    // chat_completion_prompt_ready is emitted during PROMPT ASSEMBLY, which the pinned frontend starts before the
    // user message is rendered (measured corpus-v2 drive: prompt_ready #13 before user_message_rendered #43 on
    // GoTavern and #40 vs #56 on pinned) -- the earlier edge here had the two swapped and was my bug.
    ['chat_completion_prompt_ready', 'stream_token_received'],
    ['message_sent', 'stream_token_received'],
    ['user_message_rendered', 'stream_token_received'],
    ['stream_token_received', 'generation_ended'],
    ['generation_ended', 'message_received'],
    ['message_received', 'character_message_rendered'],
];
const firstIndex = (order, name) => order.indexOf(name);
guard('browser-event-order-equal', 'browser', () => {
    const problems = [];
    const cases = [];
    for (const phase of ['drive', 'restart']) {
        for (const subject of ['gotavern', 'pinned']) {
            const order = legFor(phase, subject)?.layers?.browser?.eventOrder ?? null;
            if (!Array.isArray(order)) { problems.push(`${phase}/${subject}: no event order recorded`); continue; }
            if (phase === 'drive') {
                for (const name of CORE_DRIVE_EVENTS) {
                    if (!order.includes(name)) problems.push(`${phase}/${subject}: core drive event ${JSON.stringify(name)} was never emitted (recorded ${order.length} events)`);
                }
                for (const [before, after] of REQUIRED_ORDER) {
                    const a = firstIndex(order, before);
                    const b = firstIndex(order, after);
                    if (a < 0 || b < 0) continue; // already reported as a missing core event where required
                    if (!(a < b)) problems.push(`${phase}/${subject}: causal order violated: ${before} (#${a}) must precede ${after} (#${b})`);
                }
            }
            cases.push({ phase, subject, events: order.length, distinct: new Set(order).size });
        }
    }
    details.eventOrder = cases;
    return problems;
});
guard('browser-iframe-equal', 'browser', compareBrowser('iframes', iframes => (iframes ?? []).map(frame => frame.src)));
guard('browser-final-chat-equal', 'browser', () => {
    const problems = [];
    for (const phase of ['drive', 'restart']) {
        const shape = subject => {
            const chat = legFor(phase, subject)?.layers?.browser?.finalChat;
            if (!chat) return null;
            return {
                chatIdPresent: (chat.chatId ?? null) !== null,
                length: chat.length ?? null,
                lastIsUser: chat.lastIsUser === true,
                lastText: stripDiscriminator(chat.lastText ?? ''),
            };
        };
        const left = shape('gotavern');
        const right = shape('pinned');
        if (left === null || right === null) { problems.push(`${phase}: a final-chat state is missing`); continue; }
        if (JSON.stringify(left) !== JSON.stringify(right)) problems.push(`${phase}: final chat differs: ${JSON.stringify(left)} vs ${JSON.stringify(right)}`);
    }
    return problems;
});

// --- LAYER B: HTTP --------------------------------------------------------------------------------------
guard('http-request-set-equal', 'http', () => {
    const problems = [];
    const entries = leg => (leg?.layers?.http?.requests ?? []).filter(request => request.origin === 'subject');
    const left = entries(legs.driveGotavern);
    const right = entries(legs.drivePinned);
    if (left.length === 0 || right.length === 0) return ['a drive leg recorded no same-origin HTTP request'];
    const keyOf = request => `${request.method} ${request.path}${request.query ?? ''}`;
    const multiset = list => { const counts = new Map(); for (const request of list) counts.set(keyOf(request), (counts.get(keyOf(request)) ?? 0) + 1); return counts; };
    const goCounts = multiset(left);
    const pinnedCounts = multiset(right);
    const totals = { gotavern: left.length, pinned: right.length };
    const allKeys = new Set([...goCounts.keys(), ...pinnedCounts.keys()]);
    for (const key of allKeys) {
        // THE FRONTEND'S TOKENIZER CHOICE DURING LOAD IS A RACE, NOT A SUBJECT SURFACE: with settings still loading,
        // one leg's character-list token count went through /api/tokenizers/llama/encode once while every other run
        // (and the other leg) used /api/tokenizers/openai/count; the token COUNT VALUES for the shared texts are
        // compared (http-bodies-equal). Measured: 1 llama/encode request in 4 runs of the same corpus/journey.
        if (key === 'POST /api/tokenizers/llama/encode') { appliedNormalisations.add('tokenizer-endpoint-load-race'); continue; }
        const go = goCounts.get(key) ?? 0;
        const pinned = pinnedCounts.get(key) ?? 0;
        if (go === 0) { problems.push(`request only on pinned: ${key}`); continue; }
        if (pinned === 0) { problems.push(`request only on gotavern: ${key}`); continue; }
        if (go === pinned) continue;
        // MULTIPLICITY IS NORMALISED ONLY WHERE A NAMED DECISION COVERS IT (GET scheduling, read-only routes,
        // debounced autosave). Any other route's multiplicity is a product-visible request difference and fails.
        const normalisation = multiplicityNormalisation({ method: key.split(' ')[0], path: key.split(' ')[1] ?? '' }, key);
        if (normalisation !== null) { appliedNormalisations.add(normalisation); continue; }
        problems.push(`request multiplicity differs for ${key}: gotavern ${go} vs pinned ${pinned}`);
    }
    // COUNT ORDER is not compared either (independent fetches are scheduled by the browser); record it as a
    // diagnostic and mark the decision ONLY when the sequences actually differ.
    const goSequence = left.map(keyOf);
    const pinnedSequence = right.map(keyOf);
    if (JSON.stringify(goSequence) !== JSON.stringify(pinnedSequence)) appliedNormalisations.add('http-request-order');
    return problems;
});
guard('http-bodies-equal', 'http', () => {
    const problems = [];
    for (const phase of ['drive', 'restart']) {
        const left = (legFor(phase, 'gotavern')?.layers?.http?.requests ?? []).filter(request => request.origin === 'subject');
        const right = (legFor(phase, 'pinned')?.layers?.http?.requests ?? []).filter(request => request.origin === 'subject');
        const keyOf = request => `${request.method} ${request.path}${request.query ?? ''}`;
        // PAIRING IS BY REQUEST IDENTITY (method + path + query + request-body digest), NOT ARRIVAL ORDER AND NOT
        // key+index: two isolated runs issue the same requests in different interleavings and, for load/debounce
        // driven routes, a different NUMBER of times. Measured run9/run10: the SAME 20 unique tokenizer request
        // bodies arrived in a different order and with 21 vs 32 occurrences; index pairing compared different texts
        // and reported phantom diffs. Identity maps pair identical requests; multiplicity differences are named ONLY
        // for the routes where scheduling was measured (see the decision below), so a genuine request-content
        // difference still surfaces as a problem.
        // The autosave's REQUEST BODY is not compared (named decision), so it cannot be part of its identity.
        // The identity uses the PROJECTED request-body digest: a body member that a NAMED decision normalises (the
        // per-subject reply prefix, the per-leg peer URL, run clocks) must not turn the same logical request into two
        // different identities. The raw digest is still compared per pair by compareHTTPBody, so a real difference
        // on the same identity reds.
        const identityOf = request => {
            const bodyDigest = request.path === '/api/settings/save'
                ? ''
                : (request.requestBodyText === null || request.requestBodyText === undefined
                    ? (request.requestBodySha256 ?? '')
                    : projectBodyForComparison(request.requestBodyText));
            return `${request.method} ${request.path}${request.query ?? ''}|${bodyDigest ?? ''}`;
        };
        const group = list => { const map = new Map(); for (const request of list) { const identity = identityOf(request); const key = keyOf(request); if (!map.has(key)) map.set(key, new Map()); const byIdentity = map.get(key); if (!byIdentity.has(identity)) byIdentity.set(identity, []); byIdentity.get(identity).push(request); } return map; };
        const goGroups = group(left);
        const pinnedGroups = group(right);
        let duplicatesAllowed = 0;
        for (const [key, identities] of goGroups) {
            if (key === 'POST /api/tokenizers/llama/encode') { appliedNormalisations.add('tokenizer-endpoint-load-race'); continue; }
            const otherIdentities = pinnedGroups.get(key) ?? null;
            if (otherIdentities === null) continue; // reported by http-request-set-equal
            const allIdentities = new Set([...identities.keys(), ...otherIdentities.keys()]);
            for (const identity of allIdentities) {
                const leftEntries = identities.get(identity) ?? [];
                const rightEntries = otherIdentities.get(identity) ?? [];
                // THE FRONTEND'S TOKEN-COUNT SCHEDULING IS LOAD-TIMING, NOT CONTENT: it counts the messages it has
                // at the moment a counter pass runs, so two isolated legs counted different SUBSETS (measured: GoTavern
                // counted the greeting pair with an empty speaker name at load; pinned counted 29 product-save-path
                // messages later). Every SHARED identity's token COUNT is still compared (169/169 identical in the
                // corpus-v2 drive; the one recorded null was a transient body-read, and a direct probe of GoTavern vs
                // pinned for the same body answers {"token_count":23} on BOTH). Any other route's unmatched request reds.
                if (leftEntries.length === 0 || rightEntries.length === 0) {
                    if (key.includes('/api/tokenizers/')) { appliedNormalisations.add('tokenizer-count-scheduling'); continue; }
                    const onlyOn = leftEntries.length === 0 ? 'pinned' : 'gotavern';
                    problems.push(`${phase} ${key}: a request present only on ${onlyOn}: ${identity.split('|').slice(1).join('|').slice(0, 16)}`);
                    continue;
                }
                if (leftEntries.length !== rightEntries.length) {
                    // The named multiplicity decisions apply first (GET scheduling, read-only routes, debounced
                    // autosave); tokenizer counts additionally allow repeat-count scheduling (measured run9/run10).
                    // Any OTHER route's multiplicity is a product-visible request difference and fails.
                    const named = key.includes('/api/tokenizers/')
                        ? 'tokenizer-count-multiplicity'
                        : multiplicityNormalisation(leftEntries[0], key);
                    if (named !== null && named !== undefined) appliedNormalisations.add(named);
                    else problems.push(`${phase} ${key}: request multiplicity differs for identical requests: ${leftEntries.length} vs ${rightEntries.length}`);
                }
                const pairCount = Math.min(leftEntries.length, rightEntries.length);
                for (let index = 0; index < pairCount; index += 1) {
                const entry = leftEntries[index];
                const other = rightEntries[index];
                const staticAsset = isStaticAssetRequest(entry);
                // THE RECORDED STATIC-ASSET DIVERGENCE: the release install has no physical public/ tree, so it
                // carries no ETag/Last-Modified and answers 200 where pinned answers a conditional 304. Both mean
                // "the stored resource resolved"; the 200-body surface is what is compared.
                const statusPairIsStaticRevalidation = staticAsset && entry.status !== other.status && [200, 304].includes(entry.status) && [200, 304].includes(other.status);
                if (statusPairIsStaticRevalidation) appliedNormalisations.add('static-frontend-validator-headers');
                else if (entry.status !== other.status) problems.push(`${phase} ${key}: status ${entry.status} vs ${other.status}`);
                if (!statusPairIsStaticRevalidation && (entry.contentType ?? '') !== (other.contentType ?? '')) problems.push(`${phase} ${key}: content-type ${JSON.stringify(entry.contentType)} vs ${JSON.stringify(other.contentType)}`);
                // A LIVE THIRD-PARTY PASSTHROUGH is not a subject observation: the body comes from the live service
                // (AGENTS rule 14: live egress is recorded with its status, and its body is never asserted). The
                // recorded decision covers /api/horde/* only; every other route's body is compared.
                const liveEgress = typeof entry.path === 'string' && entry.path.startsWith('/api/horde/');
                if (liveEgress) appliedNormalisations.add('live-egress-body');
                const autosaveRequest = key === 'POST /api/settings/save';
                if (autosaveRequest) appliedNormalisations.add('autosave-request-bodies');
                if (!autosaveRequest) {
                    const requestProblem = compareHTTPBody(`${phase} ${key}: request`, entry.requestBodyText, entry.requestBodySha256, other.requestBodyText, other.requestBodySha256, { routeKey: key });
                    if (requestProblem !== null) problems.push(requestProblem);
                }
                if (!statusPairIsStaticRevalidation && !liveEgress) {
                    // ONE UNREADABLE TOKEN-COUNT BODY IS A RECORDING FACT, NOT A COUNT DIFFERENCE: the recorder catches
                    // a body read that races a navigation and records null while status/content-type stay set. Measured
                    // corpus-v2 run 2: 2/152 GoTavern and 3/121 pinned tokenizer responses were unread like this, all
                    // status 200; every READABLE shared identity's count is still compared (169/169 identical), and a
                    // direct probe of the same body on both subjects answered {"token_count":23}.
                    const tokenizerBodyGap = key.includes('/api/tokenizers/')
                        && ((entry.responseBodyText === null || entry.responseBodyText === undefined || entry.responseBodyText === '')
                            !== (other.responseBodyText === null || other.responseBodyText === undefined || other.responseBodyText === ''));
                    if (tokenizerBodyGap) {
                        // A BODY THE RECORDER COULD NOT READ IS A HARNESS ERROR: it must never flow into a comparison as
                        // 'undefined' and must never be normalised away. Measured cause: responses still in flight when the
                        // page navigated; the probe now settles HTTP before the reload, so this branch should be
                        // unreachable -- if it fires, the run is red and NAMES itself.
                        problems.push(phase + ' ' + key + ': harness-error: the recorder could not read the response body on one side (statuses ' + entry.status + '/' + other.status + '); a body must be captured while the response is live');
                    } else {
                        const responseProblem = compareHTTPBody(`${phase} ${key}: response`, entry.responseBodyText, entry.responseBodySha256, other.responseBodyText, other.responseBodySha256, { routeKey: key });
                        if (responseProblem !== null) problems.push(responseProblem);
                    }
                }
                if (JSON.stringify(entry.sseFrameBytes ?? null) !== JSON.stringify(other.sseFrameBytes ?? null)) problems.push(`${phase} ${key}: SSE frame byte boundaries differ: ${JSON.stringify(entry.sseFrameBytes)} vs ${JSON.stringify(other.sseFrameBytes)}`);
                const leftHeaders = comparableHeaders(entry.requestHeaders, { staticAsset });
                const rightHeaders = comparableHeaders(other.requestHeaders, { staticAsset });
                if (JSON.stringify(leftHeaders) !== JSON.stringify(rightHeaders)) problems.push(`${phase} ${key}: request headers differ: ${JSON.stringify(leftHeaders)} vs ${JSON.stringify(rightHeaders)}`);
                // ETag IS A FUNCTION OF THE RESPONSE BYTES. When the raw bodies are byte-equal the validators must be
                // equal too; when a NAMED projection made the bodies differ by design (auto-update decision, wall
                // clock members, per-leg peer URL), the byte-derived ETag necessarily differs and is compared by
                // consequence only. The decision names that dependency and has a negative case.
                const rawBodiesEqual = entry.responseBodySha256 === other.responseBodySha256;
                const leftResponseHeaders = comparableHeaders(entry.responseHeaders, { staticAsset });
                const rightResponseHeaders = comparableHeaders(other.responseHeaders, { staticAsset });
                // EXACTLY TWO RECORDED GoTavern-only response headers (see the registry entry). A pinned-side
                // appearance is a product difference and reds; any other GoTavern-only header still reds below.
                for (const name of ['x-gotavern-tokenizer-exact', 'x-gotavern-tokenizer-layout']) {
                    if (Object.prototype.hasOwnProperty.call(rightResponseHeaders, name)) {
                        problems.push(`${phase} ${key}: pinned carries the GoTavern-only header ${name}=${JSON.stringify(rightResponseHeaders[name])}; the recorded delta says pinned never does`);
                        continue;
                    }
                    if (Object.prototype.hasOwnProperty.call(leftResponseHeaders, name)) {
                        appliedNormalisations.add('tokenizer-exactness-headers');
                        delete leftResponseHeaders[name];
                    }
                }
                if (!rawBodiesEqual && (Object.prototype.hasOwnProperty.call(leftResponseHeaders, 'etag') || Object.prototype.hasOwnProperty.call(rightResponseHeaders, 'etag'))) {
                    appliedNormalisations.add('etag-derived-from-projected-body');
                    delete leftResponseHeaders.etag;
                    delete rightResponseHeaders.etag;
                }
                if (JSON.stringify(leftResponseHeaders) !== JSON.stringify(rightResponseHeaders)) problems.push(`${phase} ${key}: response headers differ: ${JSON.stringify(leftResponseHeaders)} vs ${JSON.stringify(rightResponseHeaders)}`);
                }
            }
        }
        if (duplicatesAllowed > 0) details[`${phase}GetDuplicates`] = duplicatesAllowed;
    }
    return problems;
});

// --- LAYER D: PERSISTENCE -------------------------------------------------------------------------------
const persistenceSets = leg => {
    const diff = leg?.persistenceDiff;
    if (!diff) return null;
    const keep = entries => entries.filter(entry => !isExcludedPath(entry.path)).map(entry => entry.path).sort();
    return { created: keep(diff.created), modified: keep(diff.modified), deleted: keep(diff.deleted), excluded: entries => entries.filter(entry => isExcludedPath(entry.path)) };
};
guard('persistence-created-set-equal', 'persistence', () => {
    const a = persistenceSets(legs.driveGotavern);
    const b = persistenceSets(legs.drivePinned);
    if (!a || !b) return ['a drive leg has no persistence diff'];
    const problems = [];
    if (JSON.stringify(a.created) !== JSON.stringify(b.created)) problems.push(`created file sets differ: gotavern ${JSON.stringify(a.created)} vs pinned ${JSON.stringify(b.created)}`);
    if (JSON.stringify(a.deleted) !== JSON.stringify(b.deleted)) problems.push(`deleted file sets differ: gotavern ${JSON.stringify(a.deleted)} vs pinned ${JSON.stringify(b.deleted)}`);
    return problems;
});
guard('persistence-changed-content-equal', 'persistence', () => {
    // CONTENT OF THE PRODUCT-SURFACE FILES THAT BOTH SUBJECTS WROTE. Raw bytes are compared unless the file is a
    // JSON document with a recorded projection: `settings.json` and `image-metadata.json` legitimately embed the
    // per-leg peer URL, random ids and generation timings, so their PROJECTED digest is compared and the named
    // normalisations are recorded. A change outside those members still changes the projected digest and reds.
    const problems = [];
    const jsonText = (leg, filePath) => (leg?.layers?.persistence?.jsonFiles ?? []).find(file => file.path === filePath)?.text ?? null;
    const changed = leg => (leg?.persistenceDiff ? [...leg.persistenceDiff.created, ...leg.persistenceDiff.modified] : []).filter(entry => !isExcludedPath(entry.path));
    const rightChanged = new Map(changed(legs.drivePinned).map(entry => [entry.path, entry.sha256]));
    for (const entry of changed(legs.driveGotavern)) {
        if (entry.path.endsWith('.jsonl')) continue;
        if (!isProductSurface(entry.path)) continue;
        const otherSha = rightChanged.get(entry.path);
        if (otherSha === undefined) continue;
        const leftText = jsonText(legs.driveGotavern, entry.path);
        const rightText = jsonText(legs.drivePinned, entry.path);
        if (leftText !== null && rightText !== null) {
            const fileKey = 'file:' + entry.path;
            const leftProjected = projectBodyForComparison(leftText, { routeKey: fileKey });
            const rightProjected = projectBodyForComparison(rightText, { routeKey: fileKey });
            if (leftProjected !== rightProjected) problems.push(`${entry.path}: content differs after named projection (raw ${entry.sha256.slice(0, 12)} vs ${otherSha.slice(0, 12)})`);
            continue;
        }
        if (entry.sha256 !== otherSha) problems.push(`${entry.path}: written bytes differ (${entry.sha256.slice(0, 12)} vs ${otherSha.slice(0, 12)})`);
    }
    return problems;
});
guard('persistence-chat-semantics-equal', 'persistence', () => {
    const problems = [];
    const chatsOf = leg => new Map((leg?.layers?.persistence?.chatMessages ?? []).map(chat => [chat.file, chat.messages ?? []]));
    const left = chatsOf(legs.driveGotavern);
    const right = chatsOf(legs.drivePinned);
    for (const [file, messages] of left) {
        const other = right.get(file);
        if (!other) { problems.push(`chat ${file} exists only on the gotavern leg`); continue; }
        // The compared tuple is role, author name, text length and the DISCRIMINATOR-STRIPPED text digest.
        // The raw digest still differs by the per-subject prefix; the length does not, because both prefixes
        // are the same length, so a length difference is a real difference.
        const normalised = list => list.map(message => `${message.isUser === true ? 'assistant' : 'user'}|${message.name ?? ''}|${message.mesLength}|${message.mesSha256Stripped ?? message.mesSha256}`).join('\n');
        if (normalised(messages) !== normalised(other)) {
            problems.push(`chat ${file}: message sequence differs (gotavern ${messages.length}, pinned ${other.length}); compared tuple is role|name|length|stripped-text-sha256`);
        }
    }
    return problems;
});
guard('persistence-parseable', 'persistence', () => {
    const problems = [];
    for (const name of ['driveGotavern', 'drivePinned', 'restartGotavern', 'restartPinned']) {
        for (const chat of legs[name]?.layers?.persistence?.chatMessages ?? []) {
            if ((chat.messages ?? []).length === 0) problems.push(`${name}: chat ${chat.file} has no parsable message records`);
        }
    }
    return problems;
});
guard('persistence-restart-readback', 'persistence', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const drive = legs[`drive${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`];
        const restart = legs[`restart${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`];
        const resumed = restart?.layers?.lifecycle?.restart?.resumed ?? null;
        const driveLength = drive?.layers?.browser?.finalChat?.length ?? null;
        const restartLength = restart?.layers?.browser?.finalChat?.length ?? null;
        if (resumed !== true) problems.push(`${subject}: the restart leg did not resume the chat (resumed=${JSON.stringify(resumed)})`);
        if (typeof driveLength === 'number' && typeof restartLength === 'number' && restartLength < driveLength) problems.push(`${subject}: restart read ${restartLength} messages, the drive wrote ${driveLength}`);
    }
    return problems;
});

// --- LAYER E: LIFECYCLE / COMBINATION -------------------------------------------------------------------
guard('lifecycle-restart-is-a-new-process', 'lifecycle', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const drive = legs[`drive${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`];
        const restart = legs[`restart${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`];
        const drivePid = drive?.serverPid ?? drive?.layers?.lifecycle?.serverPid ?? null;
        const restartPid = restart?.serverPid ?? restart?.layers?.lifecycle?.serverPid ?? null;
        if (drivePid === null || restartPid === null) problems.push(`${subject}: a server pid was not recorded on both phases, so "a new process read this tree" is unproven`);
        else if (drivePid === restartPid) problems.push(`${subject}: the restart leg ran in the SAME process (pid ${drivePid})`);
    }
    return problems;
});
guard('lifecycle-handback-both-directions', 'lifecycle', () => {
    const problems = [];
    for (const name of ['handbackGotavern', 'handbackPinned']) {
        const leg = legs[name];
        if (!leg) { problems.push(`${name} report is missing`); continue; }
        if (leg.failure) problems.push(`${name} failed: ${leg.failure}`);
        const resumed = leg.layers?.lifecycle?.restart?.resumed ?? null;
        if (resumed !== true) problems.push(`${name}: the other backend did not resume the chat it was handed (resumed=${JSON.stringify(resumed)})`);
    }
    return problems;
});
guard('lifecycle-reload-preserves-chat', 'lifecycle', () => {
    const problems = [];
    for (const subject of ['gotavern', 'pinned']) {
        const reload = legs[`drive${subject === 'gotavern' ? 'Gotavern' : 'Pinned'}`]?.layers?.lifecycle?.reload ?? null;
        if (!reload) { problems.push(`${subject}: the drive leg recorded no reload fact`); continue; }
        if (reload.sameChatId !== true) problems.push(`${subject}: the reloaded page opened a different chat`);
        if (reload.lengthPreserved !== true) problems.push(`${subject}: the reloaded page lost messages`);
    }
    return problems;
});

// ---------------------------------------------------------------------------------------------------------
// THE LAYER VERDICTS.
// ---------------------------------------------------------------------------------------------------------
const layerNames = ['browser', 'http', 'providerWire', 'persistence', 'lifecycle'];
const layers = {};
for (const layer of layerNames) {
    const own = guards.filter(entry => entry.layer === layer);
    const failed = own.filter(entry => entry.ok !== true);
    const missing = own.length === 0;
    let verdict;
    if (missing) verdict = 'not-observed';
    else if (failed.length > 0) verdict = 'mismatch';
    else verdict = 'match';
    if (!legs.drivePinned && failed.every(entry => entry.name === 'legs-present' || entry.name === 'legs-drove')) verdict = 'pinned-unreachable';
    layers[layer] = {
        ok: verdict === 'match',
        verdict,
        guards: own.map(entry => ({ name: entry.name, ok: entry.ok, problems: entry.problems })),
    };
}

const failedGuards = guards.filter(entry => entry.ok !== true).map(entry => entry.name);
const applied = NORMALISATIONS.filter(entry => appliedNormalisations.has(entry.id)).map(entry => ({
    reason: entry.reason,
    pinnedEvidence: entry.pinnedEvidence,
    field: entry.field,
    test: entry.test,
    negativeCase: entry.negativeCase,
}));

const comparison = {
    schema: 'a19-live-oracle-comparison-v1',
    details,
    corpusOrigin,
    corpusTreeSha256,
    guards,
    layers,
    failedGuards,
    normalisations: applied,
    notCompared: [
        { surface: 'third-party external egress (non-subject origins)', reason: 'page-originated requests to third-party hosts are not the subject backend; their timing is runner network weather (measured in the 2026-11-08 soak/published-smoke reds) and their bodies are not compared' },
        { surface: 'real provider completion', reason: 'the peer records and answers with deterministic markers (AGENTS 22); no real model completion is claimed' },
        { surface: 'image codec bytes (thumbnail/avatar re-encode)', reason: 'recorded codec decision: decodability/dimensions are compared, Jimp byte equality is not claimed (ARCHITECTURE §35.2)' },
        { surface: 'wall-clock timestamps inside compared files', reason: 'each subject stamps its own clock; the field is omitted from the compared tuple by the named normalisation, not ignored globally' },
        { surface: 'the raw emitted-event STREAM (order and multiplicity of every event)', reason: 'two isolated runs interleave independent async handlers differently; the layer-A claim is the CORE event set plus the causal orderings inside one generation lifecycle (browser-event-order-equal), with the full streams recorded as diagnostics' },
        { surface: 'static frontend assets (non-/api paths)', reason: 'the live oracle\'s HTTP layer records the /api surface only (both journey probes scope it that way); static assets are covered by the frontend-asset gates and carry the recorded embedded-public validator divergence (compat-matrix.md "Frontend static middleware"), so status/header equality there is not claimed by this gate' },
    ],
    verdict: layerNames.every(layer => layers[layer].verdict === 'match') ? 'match' : (failedGuards.length > 0 ? 'mismatch' : 'not-observed'),
};

const outDir = path.dirname(outPath);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(comparison, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ verdict: comparison.verdict, failedGuards, layers: Object.fromEntries(layerNames.map(layer => [layer, layers[layer].verdict])), normalisations: applied.length }));
if (comparison.verdict !== 'match') process.exitCode = 1;
