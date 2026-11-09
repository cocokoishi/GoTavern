# Layer-B finding: conditional GET on `/api/extensions/discover`

Status: **FIXED for this route; the general gap stays `partial` and is recorded in `docs/compat-matrix.md`.**
Found by the alpha.19 live-UI-oracle pipeline (self-check run5, 2026-11-08), reproduced outside the pipeline.

## What a user sees

The frontend re-requests `/api/extensions/discover` while loading the page (it already holds the response and its
ETag). Pinned answers `304 Not Modified`: the browser keeps the cached list, no bytes travel. GoTavern answered
`200 OK` with the whole 523-byte body every time. The difference is invisible until it is measured, which is why
only a layer-B comparison over a real browser found it.

## Evidence (measured, not derived)

Pinned checkout `06bde939fb1e9c4c8d8641d810f0a916b5bce127`, same corpus copy on both subjects, 2026-11-08:

| request | pinned | GoTavern (before) |
|---|---|---|
| `GET /api/extensions/discover` | `200`, `Content-Type: application/json; charset=utf-8`, `Content-Length: 523`, `ETag: W/"20b-ZX5Nge4s+cqyRysIE8Nu06nh73A"` | same |
| `GET` + `If-None-Match: W/"20b-…"` | **`304`**, `Vary: Origin`, `ETag` preserved, **no Content-Type, no Content-Length** | **`200`**, 523 bytes |
| `GET` + `If-None-Match: "20b-…"` (strong form) | `304` | `200` |
| `GET` + `If-None-Match: "nope", W/"20b-…"` (list) | `304` | `200` |
| `GET` + `If-None-Match: *` | `304` | `200` |
| `GET` + `If-None-Match: "nope"` | `200` + body | `200` + body |
| `GET` + matching tag + `Cache-Control: no-cache` | `200` + body | `200` + body |
| `GET` + `If-Modified-Since: <future>` (route sends no Last-Modified) | `200` + body | `200` + body |
| `HEAD` + matching tag | `304` | `404` (HEAD fell through to static) |
| `HEAD` (no conditional) | `200` + representation headers | `404` |

The browser-level half was observed as a Playwright `response` event (`status: 304`, `fromServiceWorker: false`)
and as the live-oracle leg record (`status: 200, contentType: ""` on pinned — the 304 face — against GoTavern's
`status: 200, contentType: "application/json"`). The raw-socket half is the table above; ONLY a raw socket or a
browser reproduces it (a `curl -H If-None-Match` invocation on this host answered 200, and node-fetch answered 200
for the plain header but 304 with `Cache-Control: max-age=0` — client-side request shaping, not server behaviour;
the raw socket agrees with the browser).

## Root cause

Pinned's route is an Express `router.get('/discover', …)` whose last statement is `response.send(...)`
(`src/endpoints/extensions.js:479-…`). Express sets a weak ETag and then answers `304` when `req.fresh` (its
`fresh` package: conditional header present; request `Cache-Control` without `no-cache`; If-None-Match parsed as a
token list with weak/strong equivalence and `*` handling; If-Modified-Since only usable when the response has a
Last-Modified). Express's router also serves HEAD for a GET route, so HEAD revalidates the same way.

GoTavern's route reached `httpx.WriteJSONBytes(w, status, body)`, which set `Content-Type/Content-Length/ETag` and
wrote the body; it had no request argument and never checked `If-None-Match`, and there was no other conditional-GET
implementation anywhere (`grep -n 'If-None-Match' internal/**` was empty before this change). Static assets had
their own 304 path (`compression.go`), which is why the gap was invisible there.

## Fix

`internal/httpx/httpx.go` gained `IsFresh(r, etag) bool` (Express's `fresh` rules, each measured above) and
`WriteJSONBytesConditional(w, r, status, body)` (a fresh GET/HEAD gets `304` with the ETag and no representation
headers; everything else takes the unchanged `WriteJSONBytes` path). `internal/server/extensions.go` gained the
matching ordered-JSON wrapper and lets HEAD reach the discover handler; `internal/server/extensions_fs.go`
(`serveExtensionDiscover`) is the ONE call site that uses it. No other route was touched.

## RED → GREEN

- RED, before the fix: `go test ./tests/e2e -run TestA19ExtensionsDiscoverConditionalGetMatchesPinnedExpressFreshness -count=1`
  → `matching_weak_If-None-Match_is_304_with_no_representation: GET with If-None-Match: W/"20b-…" = 200 (523 bytes), want 304`;
  also `strong_form…`, `multi-value…`, `wildcard…`, `HEAD_has_the_same_304_face` and
  `HEAD_without_a_conditional_is_a_200_with_representation_headers` (`= 404, want 200/304`). Log:
  `a19-diff/a19-conditional-RED.log`.
- GREEN after: the same test passes all 9 subtests (`ok … 31.196s`). `internal/httpx` unit tests pin `IsFresh` (13
  cases, including `Pragma: no-cache` ignored and `POST` never fresh) and the 304 face.

## Why the general gap stays `partial`

Every Express JSON GET route gets conditional 304 for free; GoTavern's other JSON GET writers still do not. This
patch fixes the one route the live oracle's browser actually revalidated, and the compat row says so rather than
claiming the class. Routing the remaining writers through the helper is a separate change (touches many call
sites) and is sequenced against the other lanes.
