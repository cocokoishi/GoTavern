# A20-F003: the socket-close interrupt fired after every completed SD/text-completion request

- **Severity:** High (a completed request could abort a running generation in the same or another tab).
- **State:** FIXED (`188b34d`, authored by the source-audit lane and reviewed/integrated by the Lead).
- **Source:** pinned `src/endpoints/stable-diffusion.js:316-321`, `:568-576`, `:682-690` and
  `src/endpoints/backends/text-completions.js:288-296` register `request.socket.on('close')` and guard the
  side effect with `!response.writableEnded`.
- **Root cause:** Go cancels `request.Context()` when `ServeHTTP` returns, so a bare
  `go func(){ <-ctx.Done(); interrupt() }()` fires the interrupt after every NORMAL completion. The pinned
  guard is "the response has not ended yet", which Go does not express by itself.
- **Reproducer (RED):** a REAL httptest server (a recorder cannot observe cancel-on-return) drove
  `POST /api/sd/generate` against a peer that answered `options` + `txt2img`; the peer also saw an extra
  `POST /sdapi/v1/interrupt`. Pinned's fixture records exactly two outbound requests for every success
  scenario (`tests/oracle/sillytavern-1.19.0-sd-generate.json`). A1111's interrupt cancels the running
  generation, so a finished request in one tab can abort another tab's/user's generation.
- **Fix:** `internal/server/socket_close_watcher.go` publishes "response ended" via a deferred `end()` BEFORE
  `ServeHTTP` returns; a cancellation observed with the flag set is a completion, not a disconnect. It refuses
  to arm on an already-cancelled context (Node does not replay a close event) and arms nothing when
  `ctx.Done()` is nil (the alpha.19 leak class). All four call sites use it.
- **RED/GREEN + mutation:** `TestA20SuccessfulA1111GenerateSendsNoInterrupt` failed on the stray request
  before the fix and passes after; the control `TestA20InterruptIsStillSentWhenTheClientDisconnects` proves a
  genuine in-flight disconnect still interrupts; the watcher unit test reports `94/200 watchers fired` when
  the ended check is mutated to `if true`, green after restore. Full statement in the `188b34d` message.
- **Existing test change (reported, not silent):** `TestSDA1111InterruptOnClientClose` used to pre-cancel the
  request context before the handler ran — not the pinned trigger and scheduler-dependent — and now drives a
  real in-flight disconnect. All assertions are strictly stronger.
- **Regression guards:** `TestA20SuccessfulA1111GenerateSendsNoInterrupt`,
  `TestA20FailedA1111GenerateSendsNoInterrupt`, `TestA20ComfyPromptFailureSendsNoInterrupt`,
  `TestA20InterruptIsStillSentWhenTheClientDisconnects`, `TestA20SocketCloseWatcherFiresOnlyWhileTheResponseIsOpen`.
