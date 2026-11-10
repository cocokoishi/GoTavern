# Probe (c): Accept-Encoding / Brotli negotiation, pinned vs GoTavern

**Status: CONFIRMED for pinned; DIFFERENT for GoTavern, with the difference measured rather than described.**
Evidence: [`encoding-negotiation/evidence.json`](encoding-negotiation/evidence.json) (7 resources × 7
Accept-Encoding cells + HEAD + conditional GET, on both subjects). Commands:

```
cd C:\Users\koishi\Desktop\GoTavern\a20-B
node tests/browser/a20-probe-encoding.mjs
```

The probe boots the READ-ONLY pinned server (1.19.0 @ `06bde939…`) and the current worktree's GoTavern
binary over two copies of the same pinned fresh-install data root, and requests each resource with a raw
`node:http` request for every Accept-Encoding value. **`fetch()` is deliberately not used**: Node's undici
decompresses gzip/br and hides both the selected `Content-Encoding` and the bytes on the wire, so a
fetch-based probe cannot answer this question. The probe decompresses the captured bytes itself with
`node:zlib` and compares the DECODED representation digests.

## Measured (browser-like `Accept-Encoding: gzip, deflate, br, zstd`)

| resource | pinned | GoTavern | decoded identity | bytes Go sends beyond pinned |
|---|---|---|---|---:|
| `/script.js` (497,669 B) | `br` 118,271 | `gzip` 124,918 | same sha256 | **+6,647 (5.62%)** |
| `/scripts/bulk-edit.js` (4,660 B) | `br` 1,435 | `gzip` 1,449 | same | +14 |
| `/css/animations.css` (2,195 B) | `br` 602 | `gzip` 621 | same | +19 |
| `/scripts/templates/secretKeyManager.html` (1,023 B) | identity 1,023 | identity 1,023 | same | 0 (below the 1,024 B threshold on BOTH) |
| `/scripts/templates/userReset.html` (1,029 B) | `br` 388 | `gzip` 433 | same | +45 |
| `/img/apple-icon-57x57.png` (2,873 B) | identity | identity | same | 0 (non-compressible type) |
| `/version` (168 B) | identity | identity | same | 0 (below threshold) |

All seven representations are byte-identical after decoding (`representationIdentityMatch:true`), so the
difference is a CODEC choice, not a different asset. HEAD requests and a conditional GET (304 with
`If-None-Match`) were captured in the evidence too.

## The pinned behaviour, from the run

- `src/server-main.js:14,107`: `app.use(compression())` (npm `compression`, default threshold 1024 B,
  `br` preferred when offered). Node 24 has brotli, so `br` wins over gzip on compressible bodies.
- `br`-only, `gzip`, `gzip, deflate`, `identity`, absent and `*` all produce the row above in the evidence;
  the 1,023 vs 1,029-byte pair brackets the 1,024-byte threshold.
- A `br`-only client gets 118,271 B for `/script.js` from pinned; GoTavern answers identity 497,669 B there
  (it must not advertise an encoding it cannot decode).

## GoTavern, from the same run

- GoTavern serves `gzip` (or identity where pinned does) via the standard library only; it never produces
  `br` — `internal/server/compression.go` states the reason (no standard-library brotli encoder/decoder).
- For a br-capable client the user-visible cost is the bytes in the table: **6.6 KB per large script load**
  (5.6%), decreasing to single-digit bytes on small assets.

## Cost / benefit of implementing Brotli in Go (recorded as a decision input, not implemented here)

| factor | measurement / constraint |
|---|---|
| benefit | the browser-like path saves 6,647 B on `/script.js` (5.62% of pinned's br response); on the measured small assets 14–45 B each. Only clients that can decode br benefit, which all current browsers can. |
| cost | a pure-Go brotli ENCODER is a new module dependency (the standard library has none). The project rule is no new CI dependency without approval. |
| second half | the outbound provider transport and the CORS proxy would also need a brotli DECODER before they may advertise `br` upstream; today they advertise only what they can decode, and `cors_proxy.go` has a named refusal + retry path for an upstream that sends br anyway. |
| risk | encoder behaviour (level/quality) differs from pinned's zlib brotli parameters, so byte equality is not claimed; the observable to gate would be decoded equality + a bandwidth bound, exactly as this probe measures. |
| decision | keep the EXACT disclosed difference (gzip instead of br for br-capable clients) unless the Lead approves the dependency. The difference is now measured, not hand-waved. |

## What this probe does NOT claim

- No CPU/throughput measurement: representation size and negotiation were measured; compression cost is the
  perf lane's question.
- One host, one run per cell: `wireBytes` is deterministic for a fixed asset and codec; `elapsedMs` is
  recorded but is not evidence of performance.
- It does not claim every MIME type or path: seven representative resources cover large/medium/small
  compressible files, the threshold boundary, an image and a JSON route.
