# Surface contract: backgrounds (P4)

**This surface is `PROVEN` on the observable, with a DECLARED byte difference, and one recorded
boundary for the browser layer.** The three layers are separated below because a server-asset
comparison and a rendering comparison are different experiments — conflating them is how a
boundary becomes a false parity claim.

Baseline: SillyTavern `1.19.0` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.

## The three layers, separated

**Layer 1 — server data/asset surface. This is what GoTavern promises, and what is claimed here.**

```
/api/backgrounds/all        GET     listing
/api/backgrounds/delete     POST    delete
/api/backgrounds/rename     POST    rename
/api/backgrounds/upload     POST    upload
/api/backgrounds/folders    POST    folder mutation
/backgrounds/{rest...}      GET     static asset mount (frontend_assets.go:84)
/thumbnail?type=bg&file=...  GET    server-rendered thumbnail
```

**Layer 2 — frontend rendering. CONTEXT, not a claim.** `public/scripts/backgrounds.js` uses
**two** paths, and both are real:

- `getThumbnailUrl('bg', file)` at `:860` and `:1434` — the **server** route, taken for every
  non-animated background and for animated ones when `background_settings.animation` is on.
- `getThumbnailFromStorage(file, false)` at `:858` and `:1431` — for an **animated** background with
  animation **off**: it fetches `getBackgroundPath(bg)` (the plain static asset, not `/thumbnail`),
  runs `createThumbnail` in the browser at `:452`, and caches the result in IndexedDB at `:454`.

Layer 2 is recorded because it explains why the Layer 1 route matters — the frontend calls it for
most backgrounds, and `ARCHITECTURE.md:1391-1394` records the consequence: an unimplemented
`/thumbnail` *"is not 'thumbnails missing' — it is 'all of those images are broken'"*. **This is not
a frontend parity claim.**

**Layer 3 — browser/Canvas/WebGL. A RECORDED BOUNDARY, not a Go requirement.** The client-side path
above decodes to base64, draws through a canvas-backed `createThumbnail`, and stores a blob. Nothing
in it is server-observable: the only server interaction is the static asset fetch, which Layer 1
already owns. **GoTavern does not reproduce browser painting, and the user's instruction is explicit
that browser pixel equality is not a Go backend parity requirement.** Where an animated background
with animation off is displayed, the pixels are the browser's, not the server's — and no server
behaviour differs because of it.

## `/thumbnail` — PROVEN on the observable, with the byte divergence DECLARED

**`bytes differ (Jimp vs pure-Go codec), observable equal`.** This is the pinned wording and it is
not softened here: **a reader must not come away thinking the bytes match.** Pinned renders
thumbnails through Jimp; GoTavern renders them through a pure-Go codec. The bytes differ by
construction. What is claimed is the observable.

`ARCHITECTURE.md:1395-1403` records the decision, and it **reverses** the earlier architecture
boundary that treated `/thumbnail` as blocked on a Jimp-compatible codec: *"Go cannot reproduce
Jimp's bytes, but a thumbnail is not judged by its bytes."*

**The observables asserted, each named so it can be checked** (a gate that only says "it returns an
image" asserts nothing):

| Property | Assertion |
|---|---|
| status | `200` for a generated thumbnail; `404` when the original is absent, so the frontend's placeholder path is exercised |
| MIME | taken from `thumbnails.format`, not guessed from the extension |
| decodes | the response body parses as a real image |
| dimensions | equal the configured thumbnail dimensions for `bg`, not the original's |
| cache hit | a second request does **not** re-encode — the cached file is served unchanged |
| invalidation | deleting or changing the original invalidates the cached thumbnail |
| located | cache file lives under `<user>/thumbnails/bg/...`, the same on-disk location pinned uses |

**The request predicates are reproduced with pinned's reasons, not hardened.** `serveThumbnail`
(`thumbnails.go:146`) answers `400` for a repeated or absent `file`/`type` (`:152-157`), `400` for an
unknown type (`:159-164`), and `403` when `SanitizeUserFilename(file) != file` (`:166-175`) — and
that last one carries the warning *"Do not harden this into a different predicate; a stricter check
would answer 403 where pinned serves the file"*. The animated-webp/APNG check at `:273-278` is a
**200-byte marker scan**, reproduced as a scan rather than a decode, because that is what pinned does
(`image-metadata.js:65-77`).

## The state each leg starts from — P2's carry-over

For backgrounds the asymmetry to look for is **which layer is being compared**, not which chat a leg
holds. A comparison of server responses and a comparison of rendered pixels answer different
questions, and only the first is a Go backend parity claim. **A test that compared screenshots would
be measuring Layer 3 and could not support a Layer 1 claim.**

## What this surface does NOT claim

- **Browser/Canvas/WebGL pixel equality.** Layer 3 is the browser's; it is a recorded boundary.
- **Byte equality of a thumbnail.** Declared as differing, by construction.
- **Jimp's exact resize or quality algorithm.** The observable is dimensions, MIME and decodability,
  not a byte match.
- **`/api/avatars/upload`'s pixel path** — `ARCHITECTURE.md:1404` keeps the original boundary there
  *"until a user requirement reaches it"*. Not claimed here.
- **That every Layer 1 route has a gate.** The route list is enumerated; gating each one is the next
  increment's work, and this contract should be read with that stated.

## Pre-stated expectation, recorded before the run

**P4 produces `PROVEN` on the observable for `/thumbnail`, a DECLARED DIFFERENCE for its bytes, and
an EXCLUSION for the browser layer** — converting this surface from unknown into the three statuses
the round's objective names. **It does not produce a `PROVEN` for the whole backgrounds surface**:
the six data routes are enumerated but not each gated, and saying otherwise would repeat the
substitution this project's rules forbid.