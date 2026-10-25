# What the gates could not see

Written 2026-10-25, at `main` `37daf72`, after a second round of real use reported that the product is
still unusable: the page opens, the images are missing, 酒馆助手 does not work, and nothing proves a real
preset changes the model context the way pinned does.

This is not a coverage complaint. Coverage was high, the fixtures were real, and several differentials were
byte-exact. The gates failed in five specific, *structural* ways, and each one is visible in a committed
artifact. The point of this document is that a defect can be present in the evidence and still be reported as
a pass — so each class below is paired with the rule that now forbids it and the gate that now fails on it.

The goal those rules serve is `GOAL.md`; the contract is `AGENTS.md` rules 42-53; the design consequences are
`ARCHITECTURE.md` §35.

## 1. A known-difference allowlist turned a user-visible failure into a documented pass

`tests/browser/extension-tavern-helper-comparison.json` drives the pinned frontend with JS-Slash-Runner
installed against both servers. It records:

```json
"pathDifferences": [
  {
    "path": "/thumbnail",
    "gotavern": [404],
    "pinned": [200],
    "knownReason": "the documented Jimp codec boundary (AGENTS.md architecture boundary 3): GoTavern
                   answers 404 where pinned re-encodes the image with Jimp; recorded, not asserted"
  }
],
"differenceCount": 0,
"consoleErrors": {
  "gotavern": ["Failed to load resource: the server responded with a status of 404 (Not Found)",
               "Failed to load resource: the server responded with a status of 404 (Not Found)"],
  "pinned": []
}
```

`/thumbnail` is how the pinned frontend renders **every avatar in the character list**, every chat avatar,
every group avatar, every persona image and every background thumbnail — `getThumbnailUrl` in
`public/script.js`, with no `onerror` fallback. The harness saw the 404s, saw GoTavern's console errors where
pinned had none, and reported `differenceCount: 0` because a `knownReason` existed.

The `knownReason` was not a lie. It quoted a real architecture boundary. What it did not carry was the
*consequence*: nobody wrote down "therefore every avatar on the page is a broken image", so the boundary read
as "thumbnails: understood, deliberately deferred" instead of "P0".

**Now:** `AGENTS.md` rule 45 — a boundary may not justify an absence a user can see, and the same change that
records a boundary must record what the user sees because of it. Rule 46 — core-asset absence is `FAIL`, never
`PARTIAL`. A `knownReason` that names a road, not a user outcome, is rejected in review.

## 2. Absence is invisible to a comparison that only compares what happened

The same artifact's row list is the complete set of requests either leg made. `/characters/<file>.png`,
`/User%20Avatars/<file>`, `/assets/**` and `/thumbnail` do not appear as *failures* because a request that
the frontend never issues, or issues and gets a 404 the comparator allows, contributes nothing to a row set.

Three of the seven user-data mounts pinned declares (`src/users.js:1213-1219`) were missing from GoTavern
entirely. The differential could never have said so: it compares rows, and a missing route produces no row.

**Now:** `AGENTS.md` rule 43 — every `router.use` mount, every `endpoints/*.js` router mounted in
`src/server-startup.js`, and every URL a pinned frontend module builds is a row in an inventory, and a test
diffs the inventory against the registrations. The gate is
`TestPinnedUserDataMountsAreAllServed` in `internal/server`. Rule 42 states the obligation positively: the
contract is the routes the pinned frontend *builds*, not the routes a fixture happened to exercise.

## 3. "Equal shape" is not "equal meaning"

`rowsNote` in the same artifact states the comparison contract:

> API and extension-asset calls are compared by method+path membership and status; JSON bodies are asserted on
> a bounded SHAPE skeleton, and a body with no skeleton is recorded but not asserted because each leg is a
> single run.

`/api/settings/get` — the call the frontend uses to decide which extensions are enabled, which preset is in
use, which persona is selected and what the helper's settings are — is classified `equal-shape`. A skeleton
that records `{key: type}` cannot see that a *value* changed, that a list was reordered, or that a field the
skeleton does not name went missing. For the preset question this is the whole game: the frontend compiles the
provider request from exactly these payloads (`ARCHITECTURE.md` §35.3).

**Now:** the shape comparison remains legitimate for genuinely nondeterministic bodies, and each such row must
carry its reason (`AGENTS.md` differential doctrine 2). For anything a preset or helper decision depends on,
the obligation is the provider request at the simulated backend, not the API body: `AGENTS.md` rule 48 — a
preset is compatible only if the final context is equal.

## 4. The strong differential was strong about a synthetic input

`tests/browser/preset-complex-comparison.json` is the best gate in this repository: `verdict: "match"`,
`providerRequestEqual: true`, byte-identical request bodies from both servers, a token boundary measured *by
the pinned leg itself* (`maxContext: 4260` retains one more turn than `4259`), keep/drop variants, and a guard
that the two variants really used different contexts (`variantsUsedDifferentContexts: true`). That is the
right shape.

What it proves is that the frontend, driven by a **kit-generated** preset (`preset-kit.mjs`), produces the
same request on both servers. It cannot prove anything about the shapes that only a real preset has — and the
user's real presets have 105 and 119 prompts, two `prompt_order` groups, `extensions.regex_scripts`, and (in
one case) six 酒馆助手 scripts plus a variables object inside a 1.11 MB `extensions.tavern_helper` subtree.

Two further gaps in the same artifact: `tokenizerCountsAgree: false` sits inside a `match` verdict without
failing it, and the "variants" differ in *context budget*, not in *which preset is loaded*, so the
"changing the preset must change the context" property was never exercised.

**Now:** `AGENTS.md` rule 51 — real artifacts are read-only inputs, and a desensitised fixture must preserve
structure and complexity. Rule 48 — `Node(X) == Go(X)` **and** `X != Y` within one implementation, for presets
A/B/C. Rule 50 — a harness whose captures do not differ when its inputs differ fails itself. A verdict that
contains a `false` in its guards is not a `match`.

## 5. Loading is not running

The extension leg installs the pinned JS-Slash-Runner (`837a6288…`, manifest 4.11.3), reaches the user state,
counts 32 extension containers, and compares the requests the page makes. Everything it asserts is true and
none of it is the product: the extension's whole architecture is user code in a sandboxed iframe driving
generation, presets, variables, world info and streaming through the host page. A leg that never opens the
helper's panel, never executes a script, never calls `generate`/`generateRaw` and never compares the resulting
provider request proves that the **files** are compatible.

**Now:** `AGENTS.md` rule 47 — a helper test must drive a real browser and assert on the provider request and
the persisted state the helper produced. `ARCHITECTURE.md` §35.4 — the iframe path is the probe.

## 6. A user-facing complaint has no gate because nothing looked at a picture

The five classes above all share one root: every measurement in this repository was a **server-side** or
**request-side** observation. Nothing loaded the page and asked whether an `<img>` decoded. `naturalWidth`,
`complete`, the CSS `background-image` and "how many console 404s does a normal page produce" were never
asserted, so a page whose images are all broken passed every gate in the repository at once.

**Now:** `AGENTS.md` rule 52 — a report that the product looks broken is answered by naming the measurement
that could have expressed it, and building that measurement is part of the fix. The browser asset differential
(required by `GOAL.md` §8.4) is that measurement: same frontend, same fixture, both servers, comparing status,
MIME, digest, `complete`, `naturalWidth`/`naturalHeight`, the computed CSS background, console errors and a
screenshot.

## The mapping

| What the user said | Which gate could have said it | Why it did not |
|---|---|---|
| "avatars do not display" | the extension browser leg | it recorded the `/thumbnail` 404 as a `knownReason` and reported `differenceCount: 0` |
| "the cards and their images are missing" | any browser leg | it compares rows, and a missing mount produces no row |
| "backgrounds are broken" | the background routes | `/backgrounds/*` is served, so the API and the file both pass; only the *thumbnail* URL is broken, and that URL was in the allowlist |
| "酒馆助手 does not work" | the extension leg | it proves the files load, not that a script runs |
| "a real preset changes nothing" | the preset leg | it is strong, but about a kit-generated preset and a synthetic character |
| "the page is obviously broken" | none | nothing ever loaded a page and looked at it |
