# Tokenizer parity plan (task-9)

Status: research complete, decisions recorded, implementation not started. This document is the
durable record of the tokenizer domain analysis and the approved approach. §7 records the accepted
decisions and §8 the licence review; §5 is the probe plan that AGENTS.md rule 9 requires.

No repository file was modified while producing the analysis. Scratch probe scripts and their outputs
live in `%TEMP%` (`tokprobe.cjs`, `structprobe.cjs`, `probe3.cjs`, `probe4.cjs`, `probe5.cjs`,
`regotest\main.go`, plus `*.out.txt`).

## 0. Pinned inputs read (versions and hashes)

Oracle checkout: `C:\Users\koishi\Desktop\GoTavern\SillyTavern` @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.
Everything below was read from that tree or probed against its installed `node_modules`.

Runtime packages actually resolved by the pinned server (from `package-lock.json`, verified in `node_modules`):

| package | version | licence | role |
|---|---|---|---|
| `tiktoken` | 1.0.22 | MIT (dqbd/tiktoken); rank data from OpenAI `tiktoken` (MIT) | BPE for gpt2 + `openai/*` |
| `@agnai/web-tokenizers` | 0.1.3 | Apache-2.0 (mlc-ai/tokenizers-cpp; HF `tokenizers` is Apache-2.0) | HF `tokenizer.json` BPE |
| `@agnai/sentencepiece-js` | 1.1.1 | Apache-2.0 (google/sentencepiece is Apache-2.0) | SentencePiece `.model` |

Data files in the pinned upstream repo (`src/tokenizers/`, redistributed by SillyTavern under its AGPL-3.0 repo):

| file | bytes | SHA-256 |
|---|---|---|
| claude.json | 1,774,213 | C241737DF24B4E7F7C9AF4FDCEE29A0CA903DCB288A8B753BC346A3092911767 |
| llama3.json | 6,082,250 | 7A413FB6F10A3E285A400D7CC9B8959C32116CAF81BA8A60A4EC26B9ACA2BD25 |
| gemma.model | 4,241,003 | 61A7B147390C64585D6C3543DD6FC636906C9AF3865A5548F27F31AEE1D4C8E2 |
| jamba.model | 1,124,714 | 8B0DF4FB43262C452EF37061951A06DF4C63CA191D02A60EA08F14428AF24376 |
| llama.model | 499,723 | 9E556AFD44213B6BD1BE2B850EBBBD98F5481437A8021AFAF58EE7FB1818D347 |
| mistral.model | 493,443 | DADFD56D766715C61D2EF780A525AB43B8E6DA4DE6865BDA3D95FDEF5E134055 |
| nerdstash.model | 1,033,724 | 578FA0ED4D6DBEE435F21D7F7A741506D09CDD93CCE241008ABF725407CBDB41 |
| nerdstash_v2.model | 1,033,744 | 005AD680B10F1ABD406BDB0CA9C6A5D83FC1F6E0A855BDD1942C1CEAB1FB47AB |
| yi.model | 1,033,105 | 386C49CF943D71AA110361135338C50E38BEEFF0A66593480421F37B319E1A39 |
| **total** | **17,315,919 (16.51 MiB)** | |

Data files bundled inside `tiktoken@1.0.22` (`node_modules/tiktoken/encoders/`), the canonical
`<base64> <rank>` rank tables the WASM was built from:

| file | bytes | SHA-256 |
|---|---|---|
| gpt2.json | 545,308 | 199CF7EE5013D4CD95015D672FDC9D9D8EBF942F69FC5ED424148ADD1F533493 |
| r50k_base.json | 545,308 | identical bytes to gpt2.json |
| p50k_base.json | 545,805 | F1F1F3A216C670D53B56CD3077E16E2E60644482584521881E95996D9310034E |
| p50k_edit.json | 545,849 | 82D4585313A5846F40C1718B7C11D837E8526267582810312720C8489D5485F1 |
| cl100k_base.json | 1,090,747 | 49A4E05DEA02C8FAFBD50CC4725C4AAB8F39386C0AFEDEF118E0DFEBC2FE523A |
| o200k_base.json | 2,325,457 | DF53E1A5F146E33A1B144D12AD9D685EE1B54DBC8B0950791ED45C933B119DC1 |
| model_to_encoding.json | 4,186 | 87A2D4E048ED2EBDA0FEE92A841B3527849574791BFF16083C342A8B8F60688A |
| registry.json (patterns/specials) | 2,697 | 14F210869183775A5DE95F11C790DCFAC07FCD5ED18ECA37AC09A4B581EE379C |

Distinct encoding payload = 5,053,166 B (4.82 MiB); `gpt2` and `r50k_base` are byte-identical.

The five downloaded tokenizers are fetched at runtime from
`https://github.com/SillyTavern/SillyTavern-Tokenizers/raw/main/<name>.json.gz` — **a mutable branch,
not a pinned ref** (`src/endpoints/tokenizers.js:260-264`). Bytes observed on `main` today
(repo licence MIT; last push 2025-10-19):

| file | `.gz` bytes | uncompressed bytes |
|---|---|---|
| command-r.json | 3,688,933 | 8,960,966 |
| command-a.json | 3,689,028 | 8,961,533 |
| qwen2.json | 1,817,745 | 4,754,645 |
| nemo.json | 2,345,925 | 6,262,925 |
| deepseek.json | 1,759,988 | 4,299,301 |
| **total** | **13,301,619 (12.69 MiB)** | **33,239,370 (31.70 MiB)** |

The repo also contains `command-a-vision.json(.gz)` and `glm-4.6.json(.gz)`, which the pinned 1.19.0
source does **not** reference — direct evidence that `main` moves independently of the pinned commit.

Existing embedded assets for size context: `upstream/public` 25,855,563 B, `upstream/default`
16,170,776 B, `upstream/generated` 1,950,844 B (41.94 MiB total).

## 1. Route inventory (35 routes — matches `docs/api-inventory.md`, re-derived from pinned source)

Mount: `app.use('/api/tokenizers', tokenizersRouter)` at `src/server-startup.js:152`, inside
`setupPrivateEndpoints` (called at `src/server-main.js:278`). So every route is behind
`bodyParser.json({limit:'500mb'})` (:110), CSRF (:167-202) and `requireLoginMiddleware` (:248).
`src/endpoints/tokenizers.js` is 1137 lines; router registrations at :739-768 and :770-1135.

| # | route | backend family | handler |
|---|---|---|---|
| 1 | POST `/api/tokenizers/llama/encode` | sentencepiece `llama.model` | :739 |
| 2 | POST `/api/tokenizers/nerdstash/encode` | sentencepiece `nerdstash.model` | :740 |
| 3 | POST `/api/tokenizers/nerdstash_v2/encode` | sentencepiece `nerdstash_v2.model` | :741 |
| 4 | POST `/api/tokenizers/mistral/encode` | sentencepiece `mistral.model` | :742 |
| 5 | POST `/api/tokenizers/yi/encode` | sentencepiece `yi.model` | :743 |
| 6 | POST `/api/tokenizers/gemma/encode` | sentencepiece `gemma.model` | :744 |
| 7 | POST `/api/tokenizers/jamba/encode` | sentencepiece `jamba.model` | :745 |
| 8 | POST `/api/tokenizers/gpt2/encode` | tiktoken `gpt2` | :746 |
| 9 | POST `/api/tokenizers/claude/encode` | HF `claude.json` | :747 |
| 10 | POST `/api/tokenizers/llama3/encode` | HF `llama3.json` | :748 |
| 11 | POST `/api/tokenizers/qwen2/encode` | HF downloaded `qwen2` | :749 |
| 12 | POST `/api/tokenizers/command-r/encode` | HF downloaded `command-r` | :750 |
| 13 | POST `/api/tokenizers/command-a/encode` | HF downloaded `command-a` | :751 |
| 14 | POST `/api/tokenizers/nemo/encode` | HF downloaded `nemo` | :752 |
| 15 | POST `/api/tokenizers/deepseek/encode` | HF downloaded `deepseek` | :753 |
| 16 | POST `/api/tokenizers/llama/decode` | sentencepiece | :754 |
| 17 | POST `/api/tokenizers/nerdstash/decode` | sentencepiece | :755 |
| 18 | POST `/api/tokenizers/nerdstash_v2/decode` | sentencepiece | :756 |
| 19 | POST `/api/tokenizers/mistral/decode` | sentencepiece | :757 |
| 20 | POST `/api/tokenizers/yi/decode` | sentencepiece | :758 |
| 21 | POST `/api/tokenizers/gemma/decode` | sentencepiece | :759 |
| 22 | POST `/api/tokenizers/jamba/decode` | sentencepiece | :760 |
| 23 | POST `/api/tokenizers/gpt2/decode` | tiktoken | :761 |
| 24 | POST `/api/tokenizers/claude/decode` | HF | :762 |
| 25 | POST `/api/tokenizers/llama3/decode` | HF | :763 |
| 26 | POST `/api/tokenizers/qwen2/decode` | HF downloaded | :764 |
| 27 | POST `/api/tokenizers/command-r/decode` | HF downloaded | :765 |
| 28 | POST `/api/tokenizers/command-a/decode` | HF downloaded | :766 |
| 29 | POST `/api/tokenizers/nemo/decode` | HF downloaded | :767 |
| 30 | POST `/api/tokenizers/deepseek/decode` | HF downloaded | :768 |
| 31 | POST `/api/tokenizers/openai/encode` | dispatch on `?model=` (all four families) | :770 |
| 32 | POST `/api/tokenizers/openai/decode` | dispatch on `?model=` | :843 |
| 33 | POST `/api/tokenizers/openai/count` | dispatch on `?model=` + OpenAI chat arithmetic | :916 |
| 34 | POST `/api/tokenizers/remote/kobold/count` | outbound HTTP passthrough | :1037 |
| 35 | POST `/api/tokenizers/remote/textgenerationwebui/encode` | outbound HTTP passthrough | :1072 |

Consumers beyond the routes (both matter for rule 9/15):
- browser `public/scripts/tokenizers.js` maps every family to these routes and calls
  `/api/tokenizers/openai/count?model=${getTokenizerModel()}` for message counting (`:797`, `:847`);
  the browser does its own context trimming with those numbers, so a wrong count changes the
  provider request. `getTokenizerModel()` (`:569-790`) can return an arbitrary user model string
  (`openai_model`, `azure_openai_model`, `custom_model`).
- `src/endpoints/backends/chat-completions.js:61-67,2164-2208` (`POST /api/backends/chat-completions/bias`)
  reuses the same tokenizer objects.

## 2. Per-backend parity analysis

### 2.1 tiktoken family (routes 8, 23, 31, 32, 33; six encodings)

Verified live against the pinned packages (`%TEMP%\tokprobe.out.txt`, `probe5.out.txt`):

- `encoding_for_model` resolves every model `getTokenizerModel()` can return (gpt2, r50k_base,
  p50k_base, p50k_edit, cl100k_base, o200k_base) — checked for all 23 reachable model names.
- `encode(text)` with the route's default arguments **throws** on a disallowed special token:
  `The text contains a special token that is not allowed: <|endoftext|>`. Which tokens are special
  depends on the encoding (`o200k_base` has only `<|endoftext|>`/`<|endofprompt|>`, so
  `<|fim_prefix|>` is ordinary text there but throws under cl100k). The routes catch this:
  encode → `{ids:[],count:0,chunks:[]}`; `openai/count` → the outer catch → `guesstimate(JSON.stringify(body))`.
- `decode()` with an out-of-range/negative id **throws** (`unreachable`, a trapped Rust panic) →
  the decode route answers `{text:''}`.
- `chunks` is `decode` of each id **separately** through a non-fatal `TextDecoder`, so a token that is
  a partial UTF-8 sequence becomes U+FFFD: `'😀'` under o200k → ids `[84083,50378,244]`,
  chunks `["😀","\uFFFD","\uFFFD"]`. Go must reproduce the replacement, not the raw bytes.
- `openai/count` arithmetic (verified values, `probe5.out.txt`): `tokensPerMessage` 3 (4 for
  `gpt-3.5-turbo-0301`), `tokensPerName` +1 (−1 for 0301), padding 3, +9 for 0301; per message it adds
  `tokensPerMessage` first and then counts **every own enumerable value** in order. A value that makes
  `encode` throw aborts only the rest of that message, keeping what was already added
  (`[{role:'user',content:42}]` → 7, not 3 and not 6). A message containing `<|endoftext|>` is
  therefore silently undercounted (`[{role:'user',content:'a<|endoftext|>b'}]` → 7 instead of ~11).
- `guesstimate` = `ceil(Buffer.byteLength(str,'utf8') / 3.35)`; used by `openai/count`'s catch with
  `JSON.stringify(body)` (so JavaScript stringify semantics — key order and number formatting — are
  part of the oracle).

Pure-Go feasibility: **high**. Rank data is the pinned `encoders/*.json` (5.05 MiB, MIT). The blocker
is the split pattern: all three OpenAI patterns contain `\s+(?!\S)`, and I verified with Go 1.27.0 that
`regexp.Compile` rejects them (`invalid or unsupported Perl syntax: (?!`) for gpt2/r50k/p50k, cl100k and
o200k. `pkoukk/tiktoken-go` v0.1.8 (MIT) solves this by using `github.com/dlclark/regexp2` v1.12.0
(pure Go, .NET-style backtracking engine, MIT). So a pure-Go path exists, but it depends on regexp2's
backtracking semantics matching Rust `fancy-regex` on these patterns — that is a testable hypothesis,
not a fact. Fallback if it fails: hand-write the six splitters (each is an ordered alternation with one
lookahead whose only effect is "a whitespace run that reaches end of input").

### 2.2 SentencePiece family (routes 1-7, 16-22, plus `openai/*` dispatch)

I parsed the seven `.model` protobufs (`structprobe.out.txt`) and probed `@agnai/sentencepiece-js`
(`tokprobe.out.txt`, `probe4.out.txt`):

- **all seven are `model_type = BPE`** with `byte_fallback = 1`; vocab sizes 32000 (llama, mistral),
  64000 (yi), 65535 (nerdstash, nerdstash_v2), 65536 (jamba), 256000 (gemma).
- `normalizer_spec`: name `identity` (8 bytes), **`precompiled_charsmap` is empty (0 bytes)**,
  `add_dummy_prefix` = 1 for llama/mistral and 0 for the rest, `remove_extra_whitespaces` = 0,
  `escape_whitespaces` absent (default true). There is **no Darts charsmap to port** — this removes
  the single largest SentencePiece portability risk.
- No unigram model is needed, so a focused BPE+byte-fallback engine covers the whole family.
- Behavioural quirks that must be reproduced: byte-fallback pieces render as `<0xF0>`-style pieces in
  `encodePieces` but decode back to raw bytes; the **decode route joins per-id decodes**
  (`ids.map(id => instance.decodeIds([id]))`), which drops the `▁` prefix
  (`'Hello, world!'` → `"Hello,world!"`); out-of-range/negative ids decode to `""` (no throw);
  ids `[0,1]` decode to `" ‡ "` for llama but `""` for gemma/jamba; when the model fails to load the
  encode route returns `{ids:[], count: guesstimate(text)}` **with `chunks` absent** (undefined is
  dropped by JSON.stringify) and `openai/count` returns the guesstimate of the flatMapped join.

Pure-Go feasibility: **high**, but no drop-in library. `github.com/eliben/go-sentencepiece` v0.7.0
(Apache-2.0, pure Go) is BPE-only and explicitly Gemma-targeted and validated against the *Python*
bindings; our oracle is the JS port, so it is useful as a reference implementation, not as a trusted
dependency. Recommend a focused in-house engine (normalization is identity + dummy prefix + whitespace
escaping; then SentencePiece BPE with byte fallback).

### 2.3 HF `tokenizer.json` family (routes 9, 10, 24, 25 + 11-15, 26-30)

Structures read from the two local files (`structprobe.out.txt`):

- `claude.json`: BPE, vocab 65000, merges 64739, `unk_token` null, `fuse_unk` false, `dropout` null,
  5 added tokens (`<EOT>`,`<META>`,`<META_START>`,`<META_END>`,`<SOS>`, ids 0-4), normalizer `NFKC`,
  pre-tokenizer `ByteLevel(add_prefix_space=false, trim_offsets=true)`, decoder
  `ByteLevel(add_prefix_space=true)`, no post-processor, no truncation/padding.
- `llama3.json`: BPE, vocab 128000, merges 280147, `unk_token` null, `byte_fallback` false,
  256 added tokens (ids 128000-128255), **no normalizer**, pre-tokenizer
  `Sequence[Split(pattern Regex cl100k-with-lookahead, behavior Isolated), ByteLevel(use_regex=false)]`,
  decoder `ByteLevel(use_regex=true)`, post-processor `ByteLevel`.
- Probed semantics: added tokens are recognised on encode (`'x<|begin_of_text|>y'` → `[87,128000,88]`)
  while `<|endoftext|>` is ordinary text for claude; `decode` does **not** skip special tokens
  (`decode([128000])` → `"<|begin_of_text|>"`); unknown/out-of-range ids decode to `""` without
  throwing; the chunk algorithm skips a chunk exactly when it decodes to a lone `"\uFFFD"`.
- The 5 downloaded files have **not** been structurally inspected yet (network fetch). Their
  pre-tokenizer/normalizer/added-token shapes must be enumerated before any claim about them.

Pure-Go feasibility: **high but with real work**. `sugarme/tokenizer` v0.3.0 (Apache-2.0, pure Go)
implements BPE but its `Split` pre-tokenizer compiles the pattern with Go `regexp`, which cannot
compile llama3's `\s+(?!\S)`; it would need the same regexp2/hand-scanner treatment. Recommend a
focused engine covering exactly: ByteLevel byte↔unicode alphabet, BPE with `fuse_unk=false`, optional
`NFKC` normalizer, `Sequence[Split(regex), ByteLevel]`, added-token matching, ByteLevel decode, and
the observed "unknown id → empty string" behaviour.

### 2.4 Remote passthrough family (routes 34, 35)

No local tokenizer. Exactness here is *transport* exactness: URL construction
(`trimV1(baseUrl)` + per-`api_type` suffix, trailing-slash strip for kobold), headers via
`setAdditionalHeaders(request, args, baseUrl)`, request bodies per `TEXTGEN_TYPES`, response
projection (`data?.length ?? data?.count ?? data?.value ?? data?.tokens?.length`,
`data?.tokens ?? data?.ids ?? []`), and the `{error:true}` shape on any failure. These two routes are
in scope for this domain (they are tokenizer routes) but must be implemented on the shared outbound
client rather than a second transport; the shapes above are what the shared client has to carry.

## 3. Recommended approach and operational cost

**Recommendation (as approved by the Lead): in-process, pure-Go engines reading tokenizer data from
release assets on disk, verified against a hash manifest. No CGO, no native library, no external
service, no Node/Python at runtime, and no tokenizer data inside the binary.** Concretely:

1. New package `internal/tokenizers` with three engines (`tiktoken`, `sentencepiece`, `hftokenizer`)
   plus the route-level semantics layer (dispatch order, error paths, `chunks`, guesstimate, the
   `openai/count` arithmetic) written from the pinned source, not from library defaults. Library
   defaults differ in exactly the places that matter: tiktoken-go silently skips unknown decode ids
   where pinned JS throws, and it does not enforce the disallowed-special-token error.
2. Ship the pinned rank/piece data as release assets under `upstream/tokenizers/**`, verified against
   `upstream/manifests/tokenizers.sha256` through the existing `internal/assetmanifest` mechanism, with
   lazy per-encoding loading plus a process-lifetime cache mirroring `tokenizersCache`. A data update
   then does not require a rebuild, and the binary keeps only the hash manifest. One mechanism and one
   manifest cover all tokenizer data, including the five external files.
3. tiktoken engine: adopt `tiktoken-go` v0.1.8 + `dlclark/regexp2` v1.12.0 (both MIT, pure Go) **only
   behind a differential corpus gate**; supply our own `BpeLoader` over the pinned
   `encoders/*.json` assets so the data vintage is ours, not `tiktoken-go-loader@v0.0.2` (2024). If the
   regexp2 splitter fails any corpus case, replace the splitter with a hand-written scanner. If the
   dependencies disagree with pinned on any input, that is a finding to report, not to work around.
4. SentencePiece engine: in-house BPE + byte fallback (no charsmap needed). Keep
   `eliben/go-sentencepiece` as a reference only.
5. HF engine: in-house, scoped to the feature set actually present in the pinned files.
6. Downloads: pin the five `.json.gz` blobs to a specific `SillyTavern-Tokenizers` commit, record
   their SHA-256, and serve them from the vendored copy — do **not** depend on `main` at runtime.
   The probe records the resolved commit and each file's hash, and the compatibility matrix must state
   plainly that upstream fetches these from a mutable branch while GoTavern pins a snapshot; a pinned
   snapshot must never be presented as "pinned upstream behaviour".

Operational cost, stated plainly:

- **Release-asset size (not binary size).** +22.4 MB raw minimum on disk (ST files 17.3 MB + tiktoken
  5.05 MB), plus +12.7 MB for the five `.gz` blobs. Because the data is a release asset rather than an
  embedded tree, the binary keeps only the hash manifest; the embedded `public/**`/`default/**`/
  `generated/**` payload and the tokenizer payload are now separate stories. Archive growth is still
  real and must be reported in release notes and measured against the §29 targets.
- **Runtime memory.** Lazy loading keeps RSS proportional to the encodings actually used (o200k ranks
  are 2.3 MB of text; a Go map plus merge structures will be several times that; gemma is 256k pieces).
  No tokenizer data should be loaded at startup.
- **Build.** Vendoring and manifest generation reuse the existing `tools/assetmanifest` +
  `internal/assetmanifest` mechanism; no new codegen pipeline is introduced, and CI must verify the
  manifest with `-check`.
- **Dependencies.** Three pure-Go modules at most (tiktoken-go, regexp2, optionally sugarme), all
  MIT/Apache-2.0. `CGO_ENABLED=0` and all six release architectures are preserved.
- **Licence.** tiktoken/OpenAI data MIT; agnai wrappers Apache-2.0; upstream `src/tokenizers` under the
  AGPL-3.0 baseline repo; `SillyTavern-Tokenizers` MIT. The `.model`/`.json` vocabularies are derived
  from third-party model releases (Meta, Mistral, Google Gemma, 01.AI, AI21, NovelAI, Anthropic,
  Cohere, Qwen, DeepSeek) whose own terms are not restated by either repo. The recorded review is in
  §8: development and CI are unblocked, shipping in a release artifact is blocked until that record is
  signed off.

Alternative considered and rejected as the default: reproduce upstream's live download from
`main`. It is the most "literal" reading of upstream, but it makes counts depend on a branch that
already moved independently of the pin (it contains `glm-4.6.json` and `command-a-vision.json` that
1.19.0 never references), it requires network on first use, and it makes the oracle non-reproducible.
If the Lead prefers literal network behaviour, the honest classification is `partial` for those five
families plus a documented "counts follow whatever `main` served at install time".

## 4. What cannot be made exact

1. **The five downloaded tokenizers are not determined by the pinned commit.** The pinned source names
   a mutable branch. Exactness is only achievable against a *chosen pinned byte set*; that pin must be
   recorded in build metadata and in the compatibility matrix wording.
2. **The download's network surface.** If we serve vendored bytes, no HTTP request is made where
   pinned Node would make one. Only the resulting `_cache` bytes and token counts can match. Must be
   reported as a deliberate, narrow deviation (or reproduced literally at the cost of first-use
   network).
3. **`enableDownloadableTokenizers: false` with a cold cache.** Pinned Node then falls back to
   `llama3.json` for all five families. Reproducible exactly — but only if the Go implementation does
   **not** silently prefer vendored bytes in that configuration. This is a correctness trap.
4. **Version drift of the tokenizer data itself.** A different `tiktoken`/agnai version, or a
   different host's npm cache, yields different counts. The probe must assert the recorded file
   hashes and refuse to record otherwise.
5. **Upstream's own approximations.** MiniMax → `gpt-3.5-turbo`, unknown OpenRouter tokenizers →
   `gpt-3.5-turbo`, `nerdstash` unreachable through `openai/*` (falls through to cl100k) while
   `/nerdstash/encode` exists. Parity means copying the approximation, not improving it.
6. **Exotic JSON value handling.** Non-string message values abort the rest of the message; an empty
   array contributes 0 without aborting; a non-empty array throws. These are wasm-glue artefacts
   (verified). If any remaining input class cannot be reproduced, mark that class `partial` rather
   than claiming exactness.
7. **`guesstimate` fallbacks** depend on JavaScript `JSON.stringify` (key order, number formatting) —
   already a known cross-cutting concern in this repo, but it is a dependency of route 33's catch path.

## 5. Context-boundary probe plan (rule 9)

The verification rules this plan depends on are in §9; read them before running a mutation or
recording a fixture.

Two tiers, because the tokenizer route is not the only place a boundary is enforced: the browser
trims context using `/api/tokenizers/openai/count`, so the *end-to-end* boundary is at the provider
request.

**T1 — route oracle (all 35 routes).** `tools/probe-tokenizers.mjs` in the existing probe style:
fresh fixture data root, real pinned server, authenticated + CSRF requests, response bodies recorded
byte-exact into `tests/oracle/sillytavern-1.19.0-tokenizers.json`; Go test replays them. The fixture
must record: the pinned package versions, the SHA-256 of every data file it used, and the resolved
bytes/commit for the five downloaded files. Counts/ids/chunks are deterministic; the only
normalizations allowed are the recorded `_cache` state and an explicit marker where the probe
intentionally seeded or emptied it.

**T2 — boundary corpus per backend.** Inputs *at and around* a token boundary:
- construct text by decoding an exact id sequence, then append/prepend the text of one more token, so
  the expected count is k and k±1 by construction (per encoding, k swept over a range);
- whitespace-run cases that exercise `\s+(?!\S)` (trailing run, middle run, run before a newline,
  all-whitespace input, `\r\n` runs);
- CJK, emoji (including ZWJ/skin-tone), combining marks, RTL, control characters, NUL, lone-surrogate
  JSON escapes, invalid UTF-8 arriving as raw bytes;
- per-backend special strings: `<|endoftext|>`, `<|endofprompt|>`, `<|fim_prefix|>`,
  `<|begin_of_text|>`, claude's `<EOT>`/`<SOS>`, SentencePiece `<0x..>` byte-fallback pieces;
- empty string, single character, 100 KB prompt;
- decode routes: valid ids, out-of-range ids, negative ids, ids whose bytes are partial UTF-8, and
  empty id lists;
- the guesstimate path: run once with `enableDownloadableTokenizers: false` and an empty `_cache` and
  once with the cache seeded, so the fallback and the cache-hit paths are both pinned.

**T3 — truncation boundary through the browser.** Chat fixtures tuned so the last history message fits
by exactly one token, and by exactly one token too many, at a fixed context/response budget; run the
pinned frontend once against Node and once against Go with a recording provider, and compare
Observer A (the `/openai/count` requests/responses) and Observer B (the final provider request:
message list, roles, token limits). Also cover the World-Info budget path if it consumes counts.
This is the case that turns "off by one" into a visible semantic difference.

**T4 — discriminating mutations.** At least twelve mutations against the Go implementation, each of
which must fail the comparison: off-by-one count; one model mapped to the wrong encoding; missing
disallowed-special-token error; raw bytes instead of U+FFFD in `chunks`; `chunks` present where pinned
omits it on load failure; wrong fallback model; wrong padding/`tokensPerMessage`/`tokensPerName`;
missing `+9` for 0301; wrong guesstimate divisor; wrong dispatch precedence (`llama3` before `llama`);
sentencepiece decode joining pieces instead of per-id decodes; tiktoken decode returning text instead
of `{text:''}` for an invalid id. A test that cannot be made to fail is not evidence.

**T5 — host-independence guards.** The probe refuses to record if any data file hash differs from the
manifest, if `encoding_for_model` disagrees with the recorded map, or if the recorded values change
between two runs on a clean fixture.

**T6 — CI wiring.** The oracle test must be part of the same job as the other oracles, and the Go test
must fail when a required case is absent from the fixture (so a probe that silently never ran cannot
be cited as evidence — the failure mode this repository already suffered).

## 6. Sequencing and write scopes (approved)

| phase | deliverable | write scope |
|---|---|---|
| P1 | vendored pinned data + hash manifest + CI verification | `upstream/tokenizers/**`, `upstream/manifests/tokenizers.sha256`, `.gitattributes`, `upstream/tokenizers_test.go` |
| P2 | `tools/probe-tokenizers.mjs` + oracle fixture + Go replay test | `tools/probe-tokenizers.mjs`, `tests/oracle/sillytavern-1.19.0-tokenizers.json`, `internal/server/tokenizers_oracle_test.go` |
| P3 | three engines + route semantics (disjoint files) | `internal/tokenizers/{tiktoken,sentencepiece,hftokenizer}.go` |
| P4 | route registration + middleware wiring | `internal/server/tokenizers.go`, `internal/server/routes_registry.go` |
| P5 | context-boundary E2E + provider-wire fixtures | `tests/e2e/**`, `tests/provider-wire/**` |

### 6.1 P4 requirement: decode the text field through `UnescapeJSONString`

Every tokenizer route must extract its `text` field with
`tokenizers.UnescapeJSONString` rather than with `encoding/json`.

The reason is not stylistic. Go's JSON decoder replaces an unpaired surrogate escape with
U+FFFD before any tokenizer sees it, while the pinned server keeps the lone UTF-16 code unit and
each backend then converts it differently: the SentencePiece port treats it as the high half of a
pair and swallows the following code unit (`'a\ud800b'` becomes U+10062), and the tiktoken WASM
replaces it with U+FFFD. `UnescapeJSONString` preserves an unpaired surrogate as its WTF-8 bytes,
and each engine applies its own conversion.

If P4 decodes the body with `encoding/json`, this input class silently becomes inexact and **no
test in this domain will catch it**, because the engine tests decode the fixture's `text` field
through the helper while the routes would not. The engine tests must keep using the helper, and
the route tests must send a body that contains an unpaired surrogate escape so the two paths are
compared on the same input.

P3's three engines are independent files and can be parallelised across owners; P1 and P2 gate any
claim, and P4 must not land before P2's oracle exists. P1 reuses `tools/assetmanifest` /
`internal/assetmanifest` unchanged, so no new codegen pipeline is introduced.

## 7. Decisions (accepted by the Lead)

1. **Assets, not embedding.** Tokenizer data ships as release assets on disk under
   `upstream/tokenizers/**` with one hash manifest (`upstream/manifests/tokenizers.sha256`) produced and
   verified by the existing `internal/assetmanifest` mechanism. The binary does not embed the data, and
   a data update does not require a rebuild.
2. **Dependencies accepted.** `tiktoken-go` v0.1.8 + `dlclark/regexp2` v1.12.0 (MIT, pure Go,
   `CGO_ENABLED=0`-compatible). A disagreement with pinned on any input is a finding to report, not to
   work around.
3. **Pin the five.** Pin `SillyTavern-Tokenizers` to a specific commit; the probe records the resolved
   commit and each file's SHA-256. The compatibility matrix must state plainly that upstream fetches
   them from a mutable branch, that GoTavern pins a snapshot, and what that means for the claim.
4. **Licence review recorded** in §8. Development and CI are unblocked; shipping the
   model-vocabulary-derived files in a distributable artifact is blocked until §8 is signed off.
5. **`/api/tokenizers/remote/*` is in scope** for this domain, built on the shared outbound client, with
   coordination to the provider workstream if the shapes differ.

## 8. Licence review record (required before any of this data ships)

Reviewer: tokenizers workstream. Date: 2026-10-20. Scope: every data file listed in §0.

Evidence gathered:

- GoTavern `LICENSE` = GNU AGPL-3.0. Pinned SillyTavern `LICENSE` = GNU AGPL-3.0.
- `SillyTavern-Tokenizers` `LICENSE` = MIT, "Copyright (c) 2024 SillyTavern" (repo licence as reported
  by the GitHub API, `spdx_id: MIT`).
- `tiktoken@1.0.22` `package.json` = MIT; the BPE rank tables originate from OpenAI's `tiktoken`
  repository (MIT). The `@agnai/*` wrappers are Apache-2.0, but no wrapper code is redistributed by
  GoTavern — only data produced by them is read.
- The pinned `src/tokenizers/` directory contains **no** licence file, README or provenance notice; its
  nine files are redistributed as part of the AGPL-3.0 SillyTavern repository.

Findings:

1. **No blocking issue found for** the tiktoken rank tables (`encoders/*.json`,
   `model_to_encoding.json`, `registry.json`): MIT-derived, permissively redistributable, and the
   provenance chain to OpenAI's MIT `tiktoken` is direct.
2. **No blocking issue found for** the five `SillyTavern-Tokenizers` `.json.gz` files as repository
   content: MIT with a copyright notice we can carry verbatim in a third-party notices file.
3. **Residual open item — model-vocabulary-derived files.** `claude.json` (Anthropic's tokenizer),
   `gemma.model` (Google Gemma), and the five downloaded vocabularies (Cohere Command, Qwen, Mistral
   Nemo, DeepSeek, plus Claude) are vocabularies of third-party models. Neither upstream repository
   restates those models' terms next to the files, and no separate grant specific to these files was
   found in the pinned tree. Two files deserve explicit sign-off before release:
   `gemma.model` (Gemma Terms of Use impose pass-through use restrictions and notice obligations) and
   `claude.json` (no explicit grant located).
4. **Required before a release artifact contains this data:** a `THIRD-PARTY-NOTICES` file listing each
   data file, its source repository, ref and SHA-256, the MIT/AGPL-3.0 licence text it is carried
   under, and an explicit statement for the model-vocabulary-derived files that they are redistributed
   as pinned upstream compatibility assets. Release embedding remains **blocked** until that file
   exists and item 3 is signed off.

This record is deliberately conservative: it documents what was read and what could not be
established, and it does not assert a legal conclusion beyond the licences actually found.

## 9. Verification methods (rules for this domain)

These were learned the hard way during the tiktoken increment (P3a) and are **not**
tokenizer-specific. Each one describes a step that appears to have happened and did not, which is the
failure shape this repository has already been bitten by more than once. The Lead is considering
promoting them to `AGENTS.md`.

1. **Every mutation run uses `go test -count=1`.** Go's test cache answered `ok ... (cached)` for
   three mutations that had genuinely changed the engine, so the modified code never executed. Without
   `-count=1` a mutation can appear to be caught — or worse, appear to pass — without running. A
   mutation result that does not come from a fresh test binary is not evidence.

2. **An untracked file is reverted by a file copy, never by git.** `git checkout -- <path>` on a path
   git does not track exits successfully and changes nothing. During P3a that silently left a mutated
   constant in the working tree; because the backup was taken afterwards, the poisoned copy was
   restored over and over, and an entire mutation run reported every mutation as failing for the same
   wrong reason. The procedure is: take the backup *before* mutating, restore by copying files, and
   confirm the restore by hash before trusting the results.

3. **A surviving mutation means the oracle and the engine are both suspects.** Do not start by
   assuming the engine is wrong. Three survivors in P3a were each an oracle gap: the
   abort-the-rest-of-the-message semantics were unobservable because every fixture message had the
   unencodable value as its last property (where abort and continue are identical), and the
   guesstimate divisor could not cross an integer boundary with the message bodies that existed. Fix
   the oracle when the behaviour is genuinely unobservable, then re-run the mutation; do not "fix"
   correct code to satisfy a weak test.

4. **Take expectations from an oracle, not from a derivation.** The `TextDecoder` replacement rules
   were pinned by running Node over the byte vectors, which showed that `0xF0 0x9F 0x41` decodes to
   ONE replacement followed by `A`. The hand-derived expectation was wrong and would have made correct
   code look broken.

5. **Verify committed bytes, not working-tree bytes.** `git archive HEAD` against the committed
   manifest (P1) and `git cat-file blob HEAD:<path>` digest comparisons are what prove the verified
   fixture is the recorded one. A clean `git diff` does not mean the bytes are the recorded ones.

6. **Check for unpushed commits before reporting.** `git log origin/main..HEAD` must be empty. An
   unpushed commit is not durable and CI has never seen it, so any result resting on it is unverified
   from the project's point of view.

### 9.1 Known oracle gaps (recorded so they are not mistaken for verified behaviour)

- **The BPE score tie-break direction is not discriminated, and a targeted search could not close it.**
  SentencePiece merges the highest-scoring adjacent pair, so a tie must be broken by position. The engine
  takes the leftmost pair, which is what the reference implementation does, but flipping the comparison to
  `>=` leaves every replayed case green, so the rule is currently correct by reference and by every recorded
  case, not by a discriminating test.

  Two construction families were searched over all seven pinned vocabularies, and neither produced a text
  whose tokenization depends on the rule:
  1. three-symbol texts where `piece(a+b)` and `piece(b+c)` exist with exactly equal float32 scores, neither
     is a user-defined piece, the text splits into exactly three symbols, and `piece(a+b+c)` is absent —
     which is the condition that makes the two rules diverge;
  2. four-symbol texts where a shared two-rune piece `bc` has equal-score three-rune extensions `a+bc` and
     `bc+d`, checked by running both rules and comparing the final symbol lists.

  Both returned zero for every model searched. The near-misses are instructive: the obvious candidates are
  blocked because **`▁▁` is a USER_DEFINED piece in nerdstash and nerdstash_v2**, so the splitter consumes
  it before BPE runs and no tie can arise at all. That behaviour is itself covered — the probe now records
  `tie_break_quote` and `tie_break_t` inputs, which exercise the user-defined prefix path and whitespace
  runs, but they are **not** tie-break coverage and must not be described as such.

  The rule is now pinned directly by `TestSentencePieceMergeTieBreak`, which hands the merge step a
  controlled vocabulary in which two adjacent candidates have identical scores and asserts that the
  leftmost wins, plus the complementary cases (a strictly higher score wins regardless of position; a
  three-way tie; an unmergeable pair). This is **weaker evidence than an oracle case and is labelled as
  such**: it proves the rule as written, not that the pinned data ever exercises it. It is what makes the
  `merge_rightmost_tie` mutation fail — the corpus replay alone still cannot, and the two construction
  families above still return nothing.
- **A single-token warm-up cost**: the engine merges by rescanning the symbol list, which is O(n²) in the
  number of symbols for one call. Correctness is unaffected and the recorded corpus runs in milliseconds,
  but a very long prompt has not been benchmarked against the pinned port.

## 10. HF tokenizer structures (enumerated from the vendored bytes)

Enumerated 2026-10-20 by decompressing the vendored files themselves — `upstream/tokenizers/external/*.json.gz`
for the five externally fetched tokenizers and `upstream/tokenizers/{claude,llama3}.json` for the two the
pinned repository ships — rather than by reading route responses. The five come from
`SillyTavern-Tokenizers` at the pinned commit `798bcd823dfd04227a79b487e1cf29e6de9aaece`, whose bytes and
hashes are recorded in `upstream/manifests/tokenizers.sha256`, `upstream/tokenizers/PROVENANCE.md` and the
fixture's `inputs.externalTokenizers`; see §4 and §7 for why that pin is a GoTavern choice rather than an
upstream one.

| file | vocab | merges | normalizer | pre-tokenizer | post-processor | decoder | added tokens |
|---|---|---|---|---|---|---|---|
| `claude.json` | 65,000 | 64,739 | `NFKC` | `ByteLevel(add_prefix_space=false, trim_offsets=true)` | none | `ByteLevel(add_prefix_space=true)` | 5, all special |
| `llama3.json` | 128,000 | 280,147 | none | `Split(cl100k regex)` + `ByteLevel(use_regex=false)` | `ByteLevel` | `ByteLevel` | 256, all special |
| `command-r` | 255,000 | 253,333 | `NFC` | `Digits(individual_digits=true)` + `ByteLevel(use_regex=true)` | `TemplateProcessing` (BOS) | `ByteLevel` | 37, all special |
| `command-a` | 255,000 | 253,333 | `NFC` | same as `command-r` | `TemplateProcessing` (BOS) | `ByteLevel` | 41, all special |
| `qwen2` | 151,643 | 151,387 | `NFC` | `Split(regex)` + `ByteLevel(use_regex=false)` | `ByteLevel` | `ByteLevel` | 3, all special |
| `nemo` | 131,072 | 269,443 | none | `Split(o200k-style regex)` + `ByteLevel(use_regex=false)` | `TemplateProcessing` (BOS) | `ByteLevel` | 1,000, all special |
| `deepseek` | 128,000 | 127,741 | `Sequence([])` (no-op) | `Split(\p{N}{1,3})` + `Split(CJK range)` + `Split(punct regex)` + `ByteLevel(use_regex=false)` | `ByteLevel` | `ByteLevel` | 818 (804 special) |

All seven are `model.type = BPE` with `unk_token = null`, `fuse_unk = false` and no byte fallback.

Facts the fixture settles, which the engine must follow rather than infer from the file:

- **Post-processors do not insert tokens.** `command-r`, `command-a` and `nemo` carry a
  `TemplateProcessing` post-processor that would prepend a BOS, and the pinned capture shows it is not
  applied: `command-r/encode#ascii` is `[28339, 19, 3845, 8]` with chunks `["Hello", ",", " world", "!"]`,
  not `[5, ...]`. The engine therefore ignores post-processors for these routes.
- **Decode is per id**, as on the other backends, so every chunk is one id's ByteLevel decode and the join
  is the response's `text`.

Version-sensitivity, stated rather than assumed:

- **The five external files are not pinned upstream.** Any structure above can change when the branch moves,
  so the engine must *read* the normalizer, pre-tokenizer, decoder and added-token list from the file and
  refuse an unrecognized shape instead of approximating it. The manifest hash changing is the trigger to
  re-run this enumeration.
- **The two 255k-vocabulary files are not the same file.** `command-r` and `command-a` share vocab size,
  merge count, normalizer and pre-tokenizer, and differ only in their added-token lists (37 vs 41), which is
  exactly the kind of difference a "same shape" assumption would hide.
- **`deepseek` is the outlier**: three chained `Split` pre-tokenizers including a literal CJK range, a
  `Sequence([])` normalizer that is a no-op rather than absent, and 818 added tokens of which only 804 are
  special. A "no normalizer means null" reading would be wrong for it.
- **The Split patterns are data, not code.** They carry `\s+(?!\S)` lookaheads, so the engine must compile
  them with a backtracking engine (`dlclark/regexp2`, already a dependency) and must not hardcode any pattern.
- **The feature set the engine must cover** is the union above: `ByteLevel`, `Digits(individual_digits)`,
  `Split(pattern, Isolated, invert=false)`, normalizers `null` / `NFC` / `NFKC` / `Sequence([])`, added-token
  matching, and ByteLevel decode. Anything outside that union must fail loudly at load time.
