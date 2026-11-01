# Remote embedding production: a declared exclusion (alpha.11 decision)

**Decision (option B): GoTavern does not perform REMOTE embedding calls in this release.** The vector
storage feature, its seven routes, its persisted vectra `LocalIndex` format and the two sources whose
vectors arrive precomputed in the request body (`webllm`, `koboldcpp`) stay implemented and
differential-tested. Every provider-backed source answers an **explicit HTTP 501 with a JSON reason**
instead of the generic 500 it answered before. The exclusion is recorded here, in `GOAL.md` §13, in the
`embeddings-vector` compatibility row and in `docs/gap-sweep.md`; it is **reversible** by a user
requirement, with the scoped plan in §5 below.

Status at decision time: alpha.11 branch `alpha11/provider`, base `0162d4d`, pinned oracle
`06bde939fb1e9c4c8d8641d810f0a916b5bce127` (read-only). The measurement of what the pinned domain
actually does is §1, the cost of implementing it is §2, and the product reasoning is §3.

## 1. What the pinned oracle supports (measured from the pinned source, not from memory)

`src/endpoints/vectors.js:22` declares **20 sources**:

```text
transformers, mistral, openai, extras, palm, togetherai, nomicai, cohere, ollama, llamacpp, vllm,
webllm, koboldcpp, vertexai, electronhub, openrouter, chutes, nanogpt, siliconflow, workers_ai
```

Two of them do not call a provider at all: `webllm` and `koboldcpp` read
`sourceSettings.embeddings[text]`, i.e. vectors the BROWSER computed and sent in the request body
(`vectors.js:82-85`, `:153-157`). The other **18** go through `getVector` / `getBatchVector`
(`vectors.js:54-96`, `:108-172`), which dispatch to **nine adapter modules** under `src/vectors/`:

| adapter | pinned lines | request family | credential(s) |
| --- | ---: | --- | --- |
| `openai-vectors.js` | 156 | OpenAI-compatible `POST /embeddings`, 9 distinct base URLs (togetherai, mistral, openai, electronhub, openrouter, chutes, nanogpt, siliconflow, workers_ai) with a per-source URL override for workers_ai | 9 secret keys (`SECRET_KEYS.CHUTES/ELECTRONHUB/MISTRALAI/NANOGPT/OPENAI/OPENROUTER/SILICONFLOW/TOGETHERAI/WORKERS_AI`) |
| `nomicai-vectors.js` | 74 | Nomic AI `POST /v1/embedding/text` | `SECRET_KEYS.NOMICAI` |
| `cohere-vectors.js` | 63 | Cohere `POST /v1/embed` (query vs document `input_type`) | `SECRET_KEYS.COHERE` |
| `google-vectors.js` | 101 | TWO protocols: MakerSuite `:embedContent` and Vertex AI `:predict` with the caller-supplied `request` object (service-account auth) | request-carried auth |
| `llamacpp-vectors.js` | 58 | llama.cpp `POST /embedding` | URL-configured local server |
| `vllm-vectors.js` | 60 | vLLM `POST /v1/embeddings` | URL-configured |
| `ollama-vectors.js` | 62 | Ollama `POST /api/embed` | URL-configured |
| `extras-vectors.js` | 73 | EXTRAS server `POST /api/embeddings` | extras URL + key |
| `embedding.js` | 27 | in-process ONNX (`getPipeline`) | none — AGENTS.md boundary 2 |

Total pinned adapter code: **674 lines across 9 modules**, and `getSourceSettings`
(`vectors.js:181-298`) adds per-source model defaults and request shaping. Each adapter also has to
respect the user's proxy (`requestProxy`), cancellation, timeouts and secret handling, and each has a
different response shape (`embedding`, `embeddings[].embedding`, `data[].embedding`,
`predictions[].embeddings.values`, …). A correct implementation therefore needs nine request/response
shapers plus the proxy/cancel/key plumbing, not one.

## 2. What implementing it would cost (option A)

- **Nine adapters**, each with: secret resolution through `internal/server` secrets, request shaping
  matching the pinned adapter byte-for-byte where observable, response projection, error-status
  mapping, timeout/proxy/cancellation through `internal/outbound`.
- **Nine differential fixtures.** The project's rule is that a provider branch is proven against a
  pinned recording (rule 4/22), so each adapter needs a `tools/probe-*` recording of the PINNED server
  with its fetch replaced by a controlled peer, a committed oracle fixture, and a Go replay test —
  plus a "knob that changes the request must differ" discriminator, because a family that ignores the
  model or the URL override would pass a weak comparator.
- **Real-provider verification for a feature nobody asked for.** Every fixture above is still a
  recording peer; rule 22 makes that unverified for production. A real differential needs credentials
  for up to nine providers (or a documented proxy to them), the same credential gap this lane's
  provider canary exists to expose. Shipping adapters whose only evidence is our own peer would repeat
  P0-A for a secondary feature.
- **Cost estimate from comparable work:** the chat-completion provider registry reached 15 sources
  over a whole phase, with a per-source scenario corpus, before the credential-gated canary existed.
  Nine embedding families with a smaller user base is not a one-lane change.

## 3. Why option B is the right call for this release

1. **User impact is secondary and opt-in.** Vector storage requires the user to enable it in the UI and
   choose a source. The default chat journey never touches it. A user who selects a remote source gets
   a clear unsupported answer and can switch to `webllm`/`koboldcpp` (or to pinned Node) — no chat,
   card, world-book or settings data is touched by this path.
2. **The alternative to a decision is the thing the project forbids.** At HEAD every remote source
   answered the same bare 500 a failed provider call produces: "not implemented" and "the provider
   failed" were indistinguishable (AGENTS.md 17), and the matrix carried an "unlikely to be fixed"
   gap. Option A without credentials would replace that with adapters whose evidence is a mock — the
   exact shape rule 22 calls unverified. Option B makes the boundary explicit and testable.
3. **A declared exclusion is not a silent gap.** The response names the source, the reason and this
   document; the matrix row, `GOAL.md` §13 and the gap sweep say the same; a test asserts the 501 for
   every pinned source and asserts the supported path still works.
4. **Reversibility is part of the decision.** The exclusion is a product decision for THIS release,
   not an architectural impossibility: the protocols are HTTP and observable (no private npm protocol
   like the Google `batchexecute` case in ARCHITECTURE boundary 4). A user requirement turns it into
   the scoped plan in §5.

## 4. What changes in the product, exactly

**API observable (declared divergence from pinned, asserted as such).** For every source in
`vectorExcludedEmbeddingReasons` (`internal/server/vector_embeddings_excluded.go`), `POST
/api/vector/insert` and `POST /api/vector/query` answer:

```http
HTTP/1.1 501 Not Implemented
Content-Type: application/json; charset=utf-8

{"error":true,"source":"openai","message":"vector embedding source openai is not supported by this
release: remote embedding production is a declared exclusion for this release
(docs/remote-embeddings-decision.md). No request was sent to any provider. Vector storage and the
body-supplied sources (webllm, koboldcpp) are implemented; see docs/remote-embeddings-decision.md.",
"decision":"docs/remote-embeddings-decision.md"}
```

- Pinned would call the provider and answer 500 only on failure, so this is a **declared divergence**:
  status 501 + JSON reason. It is recorded in the row, here, and in the differential corpus's
  `knownDifferences` annotation (updated in the same change, so the annotation and the code cannot
  disagree).
- An **unknown** source keeps pinned's 500 (`Unknown vector source …`); the 501 is only for the
  decided exclusions, so parity is preserved where no decision exists.
- `transformers` (in-process ONNX) is answered by the same 501 branch with its own reason: AGENTS.md
  boundary 2, not a missing adapter.
- **Nothing is sent to any provider.** The branch returns before any outbound request is constructed;
  there is no key read, no timeout and no socket. The route still opens the vectra index first, which
  is pinned's order and writes an empty `index.json` — no ITEM is ever persisted, and the test asserts
  that.
- The frontend shows its normal vector-error state; it does not receive fake vectors and no index is
  corrupted.

**Tests (`internal/server/vector_embeddings_excluded_test.go`).**
`TestExcludedEmbeddingSourcesAnswerAnExplicitUnsupportedResponse` walks the PINNED source list and
asserts 501 + JSON + `source` + `decision` + "No request was sent" + zero persisted items for every
excluded source; `TestBodySuppliedEmbeddingSourcesStillWork` asserts `webllm` still inserts 200;
`TestUnknownVectorSourceKeepsPinnedInternalServerError` asserts an unknown source keeps 500. Teeth:
changing 501 → 500 turns the first test red at `transformers/insert: status = 500, want 501` (observed
by run, file-copy restored).

**Documents updated in the same change:** `GOAL.md` §13 (compatibility promise / non-claims),
`docs/compatibility-matrix.json` `embeddings-vector` row (evidence + gap text + the explicit exclusion),
`docs/gap-sweep.md` rank 5 and the row disposition, `tools/probe-vector.mjs` +
`tests/oracle/sillytavern-1.19.0-vector.json` `knownDifferences` annotation (text only; no observation
changed and no fixture was re-recorded).

## 5. Reversal plan (if a user requirement appears)

Order by user value per unit of work, and do not start before the requirement is written down:

1. **OpenAI-compatible family first** (`openai-vectors.js`): 9 of the 18 remote sources share it, one
   request shape, one response shape, nine base URLs + per-source key. One pinned fixture with a
   controlled peer can cover the family; a second fixture covers the workers_ai URL override and the
   `chutes` templated host.
2. **Cohere and Nomic AI** (two small, distinct shapes, one key each).
3. **Ollama / llama.cpp / vLLM** (URL-configured, no secret; they are local servers, so a differential
   can use a controlled local peer and still be honest about the transport).
4. **EXTRAS** (URL + key; the extras server is a separate product).
5. **MakerSuite and Vertex AI last** — two Google protocols, one of which takes a caller-supplied
   request object with service-account auth; this is the largest per-source cost and the smallest user
   base.
6. **Never `transformers`**: AGENTS.md boundary 2 makes local ONNX a decided exclusion independent of
   this document.

Each step ships with: a pinned recording, a Go replay test, a discriminator that makes a changed
request differ, a credential-gated live probe (reusing the provider-canary pattern from
`scripts/live-provider-proxy-canary.mjs`), and a matrix row promotion only after the gate runs.

## 6. What this document does NOT claim

- It does not claim remote embeddings work, now or after the 501: they do not.
- It does not claim pinned's 500-on-failure is wrong; it claims our branch is distinguishable from it.
- It does not promise a date for the reversal.
- It does not cover `webllm`/`koboldcpp`, which are implemented and tested, or the index format and the
  seven routes, which are differential-tested against the pinned oracle.
- It is not a substitute for the release-notes sentence: the release lane owns
  `docs/releases/v0.1.0-alpha.11.md`, which does not exist at this commit. The exact text to carry is:

  > **Known limitation — remote embeddings are a declared exclusion.** Vector storage works, including
  > the browser-supplied sources (`webllm`, `koboldcpp`), but GoTavern does not call a provider to
  > produce embeddings in this release: every remote source answers an explicit `501` naming the source
  > and `docs/remote-embeddings-decision.md`. Pinned SillyTavern would call the provider. Users who
  > need remote embeddings should stay on pinned Node or use a body-supplied source.
