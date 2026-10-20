# Provider-wire differential harness

Captures the effective request that pinned SillyTavern and GoTavern each send to
a model provider, and compares them. It is the foundation for the Phase 3
provider work: the capture side lives here, the comparison side is
`tools/compare-observations.mjs`.

## Stage 1 boundary

Stage 1 drives each backend with the **browser-equivalent HTTP request** and
records what reaches the provider. It validates the **backend to provider**
transformation only.

It does **not** validate browser-side prompt assembly. In SillyTavern the prompt
is assembled by the frontend before the request ever reaches
`/api/backends/chat-completions/generate`, so a green provider-wire capture is
**not** evidence of preset-level equivalence. That belongs to a later stage with
a real browser, and the capture format is deliberately driver-agnostic so the
driver can be swapped without changing the fixture shape.

## Observer boundary

The mock provider records the request **as received**, never a reconstruction:

- method, raw undecoded target (path and query exactly as sent);
- header names with their original casing and arrival order;
- body as exact bytes, with length and sha256, plus a text projection.

It parses the connection itself rather than going through `net/http`, because
`net/http` canonicalises header names and loses header order. That is not
theoretical: pinned SillyTavern sends header names in **lowercase** (node-fetch)
while `Host` and `Connection` arrive canonicalised from Node's http agent, and
`net/http` would have erased the difference.

### Comparison rule: raw bytes, never the text projection

`bodyText` exists for readability only. The comparison must assert on
`bodySha256` and `bodyLength`, which cover the exact bytes. Comparing the text
projection would let a byte-level encoding difference round-trip away, which is
precisely the class of defect this harness exists to catch. Any comparator
change that starts comparing `bodyText` is a regression.

## Normalization tiers

1. **Exact** — everything observed is compared exactly by default.
2. **Tier 2, normalized** — each entry names the path, the rule, the reason, and
   a source. Only provably environment-dependent values belong here.
3. **Tier 3, excluded** — each entry names the path, the rule, the reason and a
   source. Exclusion is reserved for what a backend genuinely cannot control,
   and must say why matching is impossible. Prefer matching over excluding:
   transport headers that GoTavern can simply send the same way are matched, not
   excluded.

Every tier-2 and tier-3 entry carries a `source`, either `pinnedSource` (a pinned
upstream file and line) or `harnessSource` (the harness's own behaviour, such as
the mock listening on an ephemeral port). An entry with neither is rejected.

The probe asserts the three sets partition what was observed: it publishes a
`headerCoverage` block listing the headers compared exactly, normalized and
excluded, and fails if the union does not equal the observed set, if a rule
names a header that was never observed (a stale rule), or if a header appears in
both tier 2 and tier 3.

## Determinism

No wall clock and no randomness in the mock: responses are selected by arrival
order, and the only clock-dependent value (the response-time header) is a named
tier-3 exclusion. The scenario file is the single source of truth for both
backends, so the oracle harness's existing double-run byte-stability check
applies unchanged.

The mock is built once and spawned as a **binary**. Do not use
`go run ./tools/mock-provider`: `go run` leaves a compiled grandchild that
outlives its parent, holds the probe's event loop open, and stalls the oracle
job for its full timeout on every run.

## Testing the harness itself

Two lessons worth keeping, both learned the hard way.

A request body sent **without** `content-length` leaves the mock with unread
bytes in its receive buffer, and closing the connection then sends an RST that
discards a response the client had not read yet. The symptom looks like a client
bug and is correct HTTP behaviour. Declare a length when sending a body.

A test that both supplies the input and holds the expectation cannot fail when
the evidence changes. `internal/outbound`'s wire-form test therefore states
exactly what it binds (transmission fidelity) and the oracle-bound comparison
belongs to the harness, where the request comes from a scenario and the
expectation comes from the captured oracle.

## Layout```text
tests/mockprovider/                     recording provider library (Go, test-only)
tools/mock-provider/                    entry point for the recording provider
tests/provider-wire/scenarios/*.json    declarative scenarios, shared by both backends
tools/probe-provider-wire.mjs           drives the pinned backend, writes the capture
tests/oracle/sillytavern-1.19.0-provider-wire.json
```

Nothing under `internal/` or `cmd/` may import the mock provider, and it must
never reach a release binary.
