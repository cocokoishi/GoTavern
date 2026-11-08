# alpha.18 decision log

Every entry names the decision, the evidence that forced it, the alternatives rejected and the consequence a
reader can check. Code decisions are in the commits; this is the reasoning record.

## AL18-D001 — the 10,000-card fix removes work instead of caching around it

**Decision.** `/api/characters/all` takes the cache identity from the `os.ReadDir` entry, reads ctime from the
handle a miss already opens (symlinks keep the stat path), encodes JSON strings with a direct escaper
differentially pinned against the previous encoder, counts UTF-16 length without materialising arrays, and
startup uses listing metadata in `DiskCache.verify` and one chats-root listing in statistics.

**Evidence.** alpha.17 profiles (route CPU/alloc in `docs/alpha18/perf/profiles/`), controlled 10,000-card boot
experiments in `docs/alpha18/perf/README.md` §3, and the paired in-process ABBA (10,000-card p50 −60.0%, B/op
−40.3%, allocs −59.0%; 1,000/100 cards −33.7%/−26.0%).

**Rejected.** (a) A second cache of projected character JSON: the default `chat` member is time-dependent, so
it needs per-request patching of shared values — a new staleness surface for a smaller win. (b) A negative
cache of missing per-character chats directories keyed by the chats-root identity: removes a ReadDir per card
but adds an invalidation contract on directory mtime granularity, and the measured hot arm is already far past
the gate. (c) Skipping `DiskCache.verify` when disabled: it is pinned startup behaviour and the visible cost
was the per-card access, not the pass.

**Consequence.** Response bytes unchanged by construction; the cache contract comment records the one wider
residual window (attribute-only change does not refresh `date_added`).

## AL18-D002 — the CORS proxy is implemented, with a named SSRF policy

**Decision.** Implement the enabled `/proxy/:url(*)` branch for real (pinned header/body/response/redirect/
error semantics), keep the disabled branch byte-identical, allow loopback and RFC1918 (local model servers are
the feature's real use), always refuse the cloud metadata endpoints, apply the operator's
`privateAddressWhitelist.*`/`requestProxy.*` through new `outbound.UserURLDialContext`/`UserURLProxy`, and
close DNS rebinding by resolving once and dialling only a checked address.

**Evidence.** The pinned middleware itself was mounted under Node against a local upstream for the
observables; 35 local-upstream tests assert observed method/target/Host/headers/body bytes; the filter
integration has its own test (`TestCorsProxyHonoursTheConfiguredPrivateAddressFilterLikePinned`).

**Rejected.** (a) Keep a 501: user-visible placeholder, and AGENTS rule 17 already required unimplemented
branches to be distinguishable — it was true of alpha.17 and must stop being true once implemented. (b) Block
all private addresses: breaks proxying local model servers and is not pinned's default. (c) Reproduce pinned's
absence of timeouts: a wedged upstream parks a browser request forever.

**Consequence.** `docs/SEMANTIC-COMPATIBILITY.md` §18 records bounded timeouts, metadata refusal, the brotli
policy and the unported request-body parser variants; an operator who enables the route keeps the pinned
authenticated-SSRF surface and gains the two hardenings.

## AL18-D003 — brotli: retry safe methods, refuse mutating ones

**Decision.** Send pinned's exact `accept-encoding: gzip, deflate, br` on the first request; if the reply is
`br`, retry ONCE with `gzip, deflate` for GET/HEAD and serve the decodable reply; for POST/PUT/PATCH/DELETE
answer the pinned-shaped 500 and never re-send.

**Evidence/reason.** No brotli decoder exists in the standard library and the project may not add a dependency.
Refusing safe requests outright breaks the Cloudflare-fronted origins the proxy exists for; retrying a
mutating request could duplicate a server-side effect.

**Consequence.** One extra upstream request in the br case, recorded and tested
(`TestCorsProxyRetriesASafeRequestWithoutBrotliWhenTheUpstreamAnswersBr`,
`TestCorsProxyRefusesABrotliResponseItCannotDecodeForAMutatingMethod`).

## AL18-D004 — chat auto-backups per pinned; integrity check deferred with evidence

**Decision.** Implement the throttled backup schedule, retention, key format, atomic write and shutdown flush
exactly as pinned; do NOT implement `chat_metadata.integrity` verification this round; do NOT wire the
group-save backup schedule.

**Evidence/reason.** Backup is a data-safety feature a user can observe (a missing safety net), while the
integrity check CHANGES the save contract (400 instead of a write) and needs an e2e control update outside the
lane's scope; the group-save route is a separate handler. Both are recorded in §18 and named as the next
candidates rather than implied.

**Consequence.** Backup tests are 49 and include the pinned-Node `getBackupKey` oracle, retention, failure
injection, restart, multi-user and concurrency. `chats.go` and the compat rows state the two remaining gaps.

## AL18-D005 — streaming: evidence, and a refusal to change working code

**Decision.** Add real-socket streaming/cancellation tests; change NO production streaming code because no
defect was proven; fix two COVERAGE defects instead.

**Evidence.** 13 tests; three mutations (context dropped, per-chunk flush removed, truncation hold removed)
produced named RED assertions in the production transport; the wrong-package discovery (internal/server pins
the wire-exact client) is recorded in the test file's header.

**Consequence.** The suite asserts `TransportMode()=="production"` so a future re-pin fails loudly instead of
passing vacuously; the always-skipping gzip gate was moved to `internal/outbound` where it executes.

## AL18-D006 — release-evidence rails applied, title-based selection proof chosen

**Decision.** Apply `requiredJobs` and `requiredSelection` to all 13 gates, the pinned SHA, artifact digest
and freshness rails where real artifacts exist; prove `probes=full` / `mode=all` selection through the
workflow `run-name` because the Actions API exposes no dispatch inputs.

**Evidence.** Real Docker full-selection run accepted (verifier PASS 1/1); real narrowed long-lived dispatch
refused by skipped required job; alpha.17 wave re-judged 11/13 with the two pre-run-name titles refused; local
governance suite 87/87. The run-name lines are committed before the final wave so the titles can carry the
proof.

**Rejected.** Inferring selection from the job list (every Browser mode runs the same job, so a narrowed run
would look full) and from artifacts (mode is not recorded in them).

## AL18-D007 — the README's four-row Go-vs-Node table is not reseeded; alpha.18 evidence is separate

**Decision.** Keep the README table and figure pair on the recorded paired artifact `tests/perf/q22-baseline.json`
(run `42012475880` at `f1396ce`, an ancestor of the candidate) and record alpha.18's card-scale evidence in
`docs/alpha18/perf/`, labelled LOCAL.

**Reason.** Those four metrics (cold start, steady RSS, `/version`, `/`) are a Go-vs-Node comparison recorded
on one runner; alpha.18 did not reseed them, and splicing this round's card-scale numbers into them would be
the exact "older/other-host numbers in one claim" failure the project forbids. The same-SHA CI performance
gate is `GoTavern smoke metrics`; the local process-level ABBA is labelled as such.

**Consequence.** `docs/performance.md` states both identities (artifact ancestor + candidate gate) and the
checker was updated to the alpha.18 release token and perf-lane directory, with its 15 negative controls
green.

## AL18-D008 — the soak records what it cannot see

**Decision.** The 60-minute soak deliberately does not infer a leak from RSS: handles/FDs and live heap are
not observable on this host, graceful shutdown is not deliverable through a Windows console kill, and
provider streaming is not part of the storage soak.

**Consequence.** The artifact reports the request/error/latency/RSS-start-RSS-end/restart-integrity facts and
labels the leak verdict `UNPROVEN` (with the per-segment slope and its limits); provider streaming evidence
comes from the socket suite instead.
