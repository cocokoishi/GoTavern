# alpha.19 finding — the text-generation streaming stall and the cancel-watcher goroutine leak

**Status: both defects reproduced, root-caused and fixed with observed RED→GREEN; one fix is a test-peer framing
fix, one is a product goroutine leak.** Found by the alpha.19 performance lane while trying to obtain a green
`go test ./internal/server -count=1`; recorded here because a 39-minute suite hang is a product-stability finding,
not noise. Layers: LOCAL Windows/arm64 (Layer A), reproduced on a clean worktree of the baseline commit.

## 0. Summary

| # | defect | classification | fix | evidence |
|---|---|---|---|---|
| 1 | `sendWireExactStreaming` leaked one goroutine per streaming send when the context has no `Done()` (e.g. `context.Background`): `go func(){ <-ctx.Done(); connection.Close() }()` blocks on a nil channel forever | **PRODUCT** (goroutine leak; dozens of leaked goroutines in the package-timeout dump) | `context.AfterFunc` + release the watcher on body EOF/close (`internal/outbound/raw.go`) | [`artifacts/a19-textgen-stall-goroutine-dump-52883e8.txt`](artifacts/a19-textgen-stall-goroutine-dump-52883e8.txt); RED 50 leaked / GREEN 0 |
| 2 | The suite hang itself: the httptest provider in `TestBackendsTextgenGenerateStreamsWithoutBuffering` never read the request body, so net/http could close the provider connection with an **RST**; unread response bytes were discarded and the GoTavern reader correctly saw `wsarecv: An existing connection was forcibly closed by the remote host` → `Truncated=true` → the route held the stream open (pinned parity) → the test read to EOF with no bound → 39 m 18 s hang | **TEST PEER** framing defect (the product's classification and pinned-parity stall are correct) | the peer drains `r.Body` before answering (`internal/server/backends_textgen_generate_test.go`); the client read is bounded with a named failure and a disconnect | branch captured as `chunk-size-line:err` + WSAECONNRESET in [`artifacts/a19-textgen-stall-truncation-branch-capture.txt`](artifacts/a19-textgen-stall-truncation-branch-capture.txt) |

## 1. How the hang was found and bounded

A full `go test ./internal/server -count=1` (after the C1 JSON-ordering change) hit the 2400 s package bound while
`TestBackendsTextgenGenerateStreamsWithoutBuffering` had been running 39 m 18 s; the same test passed isolated in
0.02 s. The goroutine dump showed the client test goroutine blocked reading the response body, the server handler
blocked at `internal/server/backends_textgen_generate.go:255` (`<-request.Context().Done()`, reached only when
`response.Truncated` is true), and dozens of `sendWireExactStreaming.func1 [chan receive (nil chan)]` goroutines.

**Pre-existing, not caused by C1/C4.** Clean worktree of the baseline commit `52883e8` (verified HEAD, no edits):
`go test ./internal/server -run '^TestBackendsTextgenGenerateStreamsWithoutBuffering$' -count=20 -timeout=60s`
hung **6/6 bounded attempts** while the host was loaded (two such batches running concurrently); the current tree
(C1+C4) hung 3/6 under the same conditions. Raw classification files:
[`artifacts/a19-textgen-stall-classification-52883e8.txt`](artifacts/a19-textgen-stall-classification-52883e8.txt),
[`artifacts/a19-textgen-stall-classification-current.txt`](artifacts/a19-textgen-stall-classification-current.txt).
A single solo run passes, which is why the package suite only failed intermittently: the window needs co-tenant CPU
pressure (this 2-logical-core host runs two other alpha.19 lanes).

## 2. Defect 1 — the cancel-watcher goroutine leak (product)

`internal/outbound/raw.go` started the watcher as a bare goroutine. `context.Background().Done()` is nil, so the
receive blocks forever; every streaming send with such a context leaked one goroutine. The product's streaming
routes use background contexts, so this is not a test artefact.

**RED (before):** a new bounded test, `TestStreamingSendWithBackgroundContextDoesNotLeakWatchdog` in
`internal/outbound/raw_test.go`, performs 50 streaming sends with `context.Background()`, fully reads and closes
each body, then waits (bounded, 5 s) for the goroutine count to return:

```
baseline 3, still 53 after 5 s (leak 50)
```

**GREEN (after):** PASS in 0.17 s; the whole `./internal/outbound` package green (1.37 s).

**Fix:** `context.AfterFunc(ctx, func(){ connection.Close() })` instead of the goroutine. `AfterFunc` starts no
goroutine for a nil-`Done` context and returns a stop function; the `bodyReader` carries it and calls it once from
`markDone()` (all 11 end-of-body transitions) or `Close()`. **WHEN** the connection is closed on cancellation is
unchanged: a context cancelled while the stream is live still closes the connection. What changed is that after the
stream there is no watcher left to leak.

## 3. Defect 2 — the spurious truncation (test peer) and the bounded client contract

The `Truncated` flag is a real product contract (a provider dying mid-stream is distinguishable from a finished
reply; pinned's route then holds the response open until the client disconnects — reproduced deliberately, not
changed). The alpha.19 question was **which framing check fired**. Each truncation branch now records a stable
`Response.TruncatedBy` reason (`content-length:short`, `connection-close:err`, `chunk-size-line:EOF|err|malformed`,
`chunk-data:short`, `chunk-terminal-crlf:EOF|err`), pinned by `internal/outbound/raw_test.go`; the reason is
diagnostic only and is never emitted on the wire. An opt-in trace (`GOTAVERN_TRUNCATION_TRACE=1`) records the
reason and the underlying error to stderr during a reproducer run.

Captured during the load-sensitive stall:

```
gotavern: response truncated by chunk-size-line:err
  (err=read tcp 127.0.0.1:58041->127.0.0.1:58038: wsarecv: An existing connection was forcibly closed by the remote host.)
```

`WSAECONNRESET` while reading the next chunk-size line — the provider connection was reset. The provider in the
test answers without ever reading the POST body; a net/http server that closes a connection with unread request
bytes can send an RST instead of a FIN, and an RST discards response bytes the client has not read yet. Under CPU
load the client reads later, the window widens, and the reset lands mid-frame. **The product's classification was
correct; the test peer's framing was not.** Every other peer in that file already drains the body; this one now
does too.

The client contract was also unbounded: the test read to EOF with no timeout, so a *correct* pinned-parity stall
became a multi-minute suite hang. It now reads with a 10 s bound, fails with a named message that names the parity
rule, the `TruncatedBy`/trace diagnostics and the fact that the client was disconnected to release the handler.
No assertion was deleted.

**GREEN (after both):** the exact command that hung before —
`go test ./internal/server -run '^TestBackendsTextgenGenerateStreamsWithoutBuffering$' -count=20 -timeout=120s` —
run four times back to back (80 bounded iterations) under the same co-tenant load: **4/4 batches pass, 0 stalls,
0 truncation traces**, where before the fix 3/6 batches failed/hung.

## 4. What is NOT claimed

- The full `go test ./internal/server -count=1` suite is **not yet re-run to green** after these fixes; it is the
  next gate and the result will be recorded here when it runs.
- The goroutine-count assertion is about a bounded return to baseline (≤ baseline+2), not about zero goroutines in
  the process: `httptest`, the runtime and the mock provider legitimately keep goroutines around.
- The RST mechanism is inferred from the captured `WSAECONNRESET` plus the net/http close-with-unread-body
  behaviour; the direct proof is the fix removing the symptom under the same load (80/80 bounded iterations).
- The pinned-parity stall semantics are **unchanged**: a genuinely truncated provider stream still leaves the
  response open until the client disconnects (that is what pinned does). Only the diagnostics, the peer framing and
  the test's bound changed.
