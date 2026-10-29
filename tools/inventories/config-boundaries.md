## Recorded boundaries

These keys are ACCEPTED (parsed, preserved, and reported through the migration/default-insertion paths) and are NOT
implemented. Each entry says what is missing, where the pinned behaviour lives, why a pure-Go port is out of scope
or too large for this change, and what a user sees because of it. This section exists because a parser touch that is
never read is the failure AGENTS.md rule 18 forbids, and the honest alternative is a named gap with a reason.

### `performance.memoryCacheCapacity` (and its legacy spelling `cardsCacheCapacity`)

- **Missing:** the bounded in-memory cache of PARSED CHARACTER CARD JSON. Pinned reads the key once at module load
  (`src/endpoints/characters.js:30-31`: `const memoryCacheCapacity = getConfigValue('performance.memoryCacheCapacity',
  '100mb'); const memoryCache = new MemoryLimitedMap(memoryCacheCapacity);`) and `MemoryLimitedMap`
  (`src/util.js:1144-1323`) evicts least-recently-inserted entries whenever `currentMemory + newValueSize` would
  exceed `bytes.parse(capacity)`; `estimateStringSize` is `str.length * 2`; a value whose own size exceeds the
  capacity is refused outright; and `maxMemory <= 0` disables the cache entirely. A legacy `cardsCacheCapacity: N`
  is migrated to `N` + `mb` (`src/config-init.js:91-94`, mirrored by `internal/configinit/config.go:63`).
- **Why no port:** GoTavern does not keep a character-card memory cache at all. Cards are read and parsed per
  request (`internal/server/characters_read.go` -> `processCharacter`), so there is no cache for a capacity to
  bound, and implementing one would be adding a new performance subsystem rather than porting a config key. That
  is a real product decision with a real cost (a large card library re-parses a card on every listing) and it does
  not belong in a parity-key change. **`performance.useDiskCache` is in the same position** and is the other half
  of the same pinned feature: `useDiskCache` writes the parsed JSON to a disk cache, `memoryCacheCapacity` bounds
  the in-memory copy, and neither exists here.
- **What a user sees:** the setting is accepted, preserved in `config.yaml`, and has NO effect. Nothing breaks and
  no response differs - unlike the other boundaries this one has no observable HTTP difference, only a memory and
  latency one (a large library costs more CPU per `/api/characters/all`, and the process's memory use does not
  follow the configured figure). A `0` that pinned treats as "no cache" therefore also changes nothing, which
  means an operator cannot use a divergence here to detect the gap.

### `gemini.enableSystemPromptCache`

- **Missing:** the OpenRouter `cache_control` stamp on the system prompt for a cacheable Gemini model. Pinned reads
  the flag per request (`src/endpoints/backends/chat-completions.js:2370`) and applies it at `:2386-2388`, but only
  inside `if (isCacheableGemini && enableGeminiSystemPromptCache)` where
  `isCacheableGemini = isGemini && await isOpenRouterModelCacheable(request.body.model)` (`:2369`). The transform is
  `cachingSystemPromptForOpenRouter` (`src/prompt-converters.js:1072-1113`): find the FIRST `system` message, do
  nothing if it already carries `cache_control` at message or part level, otherwise stamp the LAST `text` part with
  `{type:'ephemeral'}` - no `ttl`, unlike Claude's `cacheTTL` - and replace a string `content` with a one-element
  block array carrying it.
- **Why no port in this change:** the flag CANNOT be applied without the `isOpenRouterModelCacheable` probe, and
  that probe is itself a recorded gap: it is `await fetch('https://openrouter.ai/api/v1/models')` with a
  5-second abort (`:138-175`), matched against `pricing.input_cache_write != null`, with positive results cached in
  a module-level array. Three consequences, each of which makes "apply the flag only" WRONG rather than partial:
  the probe adds an outbound request to every Gemini-through-OpenRouter call (so a body comparison that ignored the
  request count would pass while the request sequence differed); the probe is a live network capability lookup that
  GoTavern does not currently make anywhere; and without it the only defensible assumption is "cacheable", which
  would emit `cache_control` for models pinned would NOT cache - a different provider body, not a subset. The
  /models probe is deliberately absent from `internal/server/openrouter_chat.go` (see its
  `pinnedOpenRouterGeminiModel` branch, which sends `safety_settings` but makes one fewer request than pinned).
- **What a user sees:** with the flag on and a Gemini model routed through OpenRouter, GoTavern's request carries no
  `cache_control`, so the provider offers no prompt-cache write discount; token accounting and billing differ, while
  the completion itself does not. **The same flag name under `claude` IS implemented** (`claude.enableSystemPromptCache`,
  `internal/server/claude_cache.go`), so a reader must not generalise from that one to Gemini's.
  **Remaining work, in two pieces:** (1) the `isOpenRouterModelCacheable` probe with a seam for the recorded
  differential and a positive-only cache; (2) `cachingSystemPromptForOpenRouter` applied to `request.body.messages`
  before assembly, gated on the probe result AND the flag. Piece 2 without piece 1 must never be shipped.

### `git.backend: builtin` (integrated isomorphic-git backend)

- **Missing:** the integrated git backend. `default/config.yaml:312-317` documents `auto` (prefer system git, fall
  back to the integrated one), `system` and `builtin`; the value is read by `src/endpoints/extensions.js` through
  the git-backend selector, and `builtin` forces the in-process implementation rather than shelling out to `git`.
- **Why out of scope:** "builtin" is not a config switch on one code path, it is a whole git implementation. Pinned
  gets it from `isomorphic-git` (a JavaScript re-implementation of the git object model, the packfile protocol,
  refs, index formats and checkout), and reproducing its semantics faithfully enough that extension install/update
  results stay byte-identical to pinned is a project of its own. The alternative - treat `builtin` as `system` -
  would silently claim the wrong capability and would break on a machine with no `git`, which is exactly the case
  the setting exists for. GoTavern's git path therefore stays the system-git path, and `builtin` must stay a
  visible boundary. **A pure-Go git library would also be a new module dependency** (AGENTS distribution rules),
  which is not something a parity-key change may take on unilaterally.
- **What a user sees:** extension and server-plugin repository operations still work wherever the system `git` is
  on `PATH`. On a machine with no `git`, they fail with a causal error naming the missing executable rather than
  using the integrated backend, and setting `git.backend: builtin` (or `auto` on such a machine) does not change
  that. Selection is not silently ignored in the other direction: no code pretends `builtin` was used.

### `backups.chat.*` (per-chat backups)

- **Missing:** the per-chat chat-file backup subsystem. `default/config.yaml` carries `backups.chat.enabled`,
  `backups.chat.maxTotalBackups` and `backups.chat.throttleInterval` (migrated from `disableChatBackup`,
  `maxTotalChatBackups` and `chatBackupThrottleInterval` at `src/config-init.js`, mirrored by
  `internal/configinit/config.go:50-53`), and `src/endpoints/chats.js` consults them when it writes a chat: it
  decides whether a pre-write snapshot is taken, prunes the snapshot directory by total size, and throttles how
  often a snapshot is taken for the same chat.
- **Why out of scope:** this is a storage subsystem with its own retention/pruning rules, its own failure handling
  and its own on-disk layout under the user's data directory, not a switch on an existing writer. Porting it
  requires reproducing the exact naming, the exact prune order and the exact throttle bookkeeping before it can be
  claimed, and a partial port (write snapshots, no pruning) would fill a user's disk - worse than the gap. Only
  `backups.common.numberOfBackups` and `backups.allowFullDataBackup` participate in the implemented settings-backup
  path, and they are reported as such; the per-chat family is not.
- **What a user sees:** chat writes and chat persistence are unaffected, and nothing is ever pruned by a
  half-implemented backup path. What is absent is the safety net: after a bad edit or an accidental overwrite
  there is no per-chat snapshot to restore, and the chat-backup directory a pinned install would have populated
  stays absent. The settings UI still shows the toggles, because it is the pinned frontend.

### VertexAI service-account mode

- **Missing:** Vertex AI's service-account credential path (the JSON key file, its JWT-bearer OAuth flow, token
  caching and the project/region endpoint construction). Pinned's Google backend accepts either an API key or a
  service-account JSON and, in the latter case, obtains an OAuth access token before calling the regional
  `*-aiplatform.googleapis.com` endpoint.
- **Why out of scope:** it is an OAuth client-credentials implementation with its own token lifecycle and a
  different endpoint scheme, and it cannot be verified without either a real service account or a recorded
  credential exchange. Faking the exchange would produce a fixture for a behaviour that never ran. It is a
  self-contained feature request, not a config-key read.
- **What a user sees:** API-key use of the Google/Gemini sources works. A user who configures a Vertex AI
  service-account JSON is not silently routed: the request fails with an error naming the unsupported credential
  mode instead of sending a malformed provider request to a regional endpoint.

### Provider embedding sources

- **Missing:** the provider-hosted embedding sources inside `/api/vector/*` (OpenAI/Google/Cohere/Mistral etc.).
  Those routes call out to a provider's embeddings endpoint through the same additional-headers machinery the
  implemented chat paths use.
- **Why out of scope here:** the local in-process sources are already recorded as an architectural exclusion
  (AGENTS.md boundary list, local ML inference: `getPipeline()` in `src/transformers.js` runs an ONNX model inside
  the server, and serving that would mean adopting an ONNX runtime, which contradicts `CGO_ENABLED=0`). The
  provider-hosted sources are a separate and larger piece - each has its own request shape, batching, dimension
  handling and error mapping - and none of it is a config key; it is route work that must land with its own
  provider-wire evidence, not as a side effect of a config-parity change.
- **What a user sees:** vector storage/search that depends on a provider-hosted embedding is not available, and the
  routes report it as unimplemented rather than returning an empty embedding set, which would corrupt a user's
  vector index silently. This boundary is NOT claimed as covered by the local-inference exclusion; they are two
  different gaps that share a route prefix.
