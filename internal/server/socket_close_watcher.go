package server

// PINNED SOCKET-CLOSE INTERRUPT WATCHER.
//
// The pinned stable-diffusion and text-completion routes register a handler on
// `request.socket.on('close')` and guard every side effect with
// `!response.writableEnded`:
//
//	src/endpoints/stable-diffusion.js:316-321  /api/sd/generate         (A1111 interrupt)
//	src/endpoints/stable-diffusion.js:568-576  /api/sd/comfy/generate   (comfy interrupt, !item)
//	src/endpoints/stable-diffusion.js:682-690  /api/sd/comfy/runpod/generate (cancel, !item)
//	src/endpoints/backends/text-completions.js:288-296 (/api/backends/text-completions/generate, koboldcpp abort)
//
// WHY A WATCHER TYPE EXISTS AT ALL. Node's socket 'close' event fires when the CONNECTION closes.
// Go's `request.Context()` is cancelled in that case too, but net/http ALSO cancels it when ServeHTTP
// returns, so a bare `go func(){ <-ctx.Done(); sendCancel() }()` fires its side effect after EVERY
// normal completion. Measured on the alpha.20 audit: a successful POST /api/sd/generate against a real
// (not httptest.NewRecorder) server sent GET /sdapi/v1/options, POST /sdapi/v1/txt2img AND an extra
// POST /sdapi/v1/interrupt that has no counterpart in the pinned fixture
// (tests/oracle/sillytavern-1.19.0-sd-generate.json records exactly two outbound requests for every
// success scenario). The pinned `!response.writableEnded` guard is what suppresses that case.
//
// The Go equivalent of "the response has not ended yet" is an explicit completion flag published BEFORE
// ServeHTTP returns: net/http cancels the request context only after the handler returns, so a flag set
// by a deferred end() is always visible to the watcher when the cancellation was caused by completion.
// A cancellation caused by a real client disconnect arrives while the handler is still running, so the
// flag is still false and the pinned side effect runs.
//
// This is deliberately NOT a goroutine per request left to the scheduler: end() closes the finished
// channel so the watcher exits even when the context is never cancelled (a request served from a
// context.Background or a test recorder), and a cancelled-then-ended watcher still exits exactly once.

import (
	"context"
	"errors"
	"net/http"
	"sync"
	"sync/atomic"
)

// pinnedSocketCloseWatcher is one armed socket-close handler.
type pinnedSocketCloseWatcher struct {
	finished chan struct{}
	ended    atomic.Bool
	once     sync.Once
	ctx      context.Context
	onClose  func()
	fireOnce sync.Once
}

// watchPinnedSocketClose arms onClose for the moment the request's context is cancelled while the
// handler is still running. It returns nil when there is nothing to watch (no request, or a context
// whose Done channel is nil, where a receive would block forever -- the alpha.19 goroutine-leak class).
//
// The caller MUST call end() on every return path (a `defer watcher.end()` next to the arming call).
func watchPinnedSocketClose(request *http.Request, onClose func()) *pinnedSocketCloseWatcher {
	if request == nil || onClose == nil {
		return nil
	}
	ctx := request.Context()
	if ctx == nil || ctx.Done() == nil {
		return nil
	}
	if ctx.Err() != nil {
		// The close event happened BEFORE the pinned route could register its listener, and Node does
		// not replay an event to a listener added afterwards: there is nothing left to wait for.
		return nil
	}
	watcher := &pinnedSocketCloseWatcher{finished: make(chan struct{}), ctx: ctx, onClose: onClose}
	go func() {
		select {
		case <-ctx.Done():
			// The completion flag is published before ServeHTTP returns and net/http cancels the
			// context only after that, so a cancellation observed with `ended` set cannot be a
			// client disconnect: it is the end of a response that was sent.
			if !watcher.ended.Load() {
				watcher.fire()
			}
		case <-watcher.finished:
		}
	}()
	return watcher
}

// fire invokes the pinned side effect exactly once. It is the only path to onClose, so the watcher
// goroutine and end() can race without sending the interrupt twice.
func (watcher *pinnedSocketCloseWatcher) fire() {
	if watcher == nil || watcher.onClose == nil {
		return
	}
	watcher.fireOnce.Do(watcher.onClose)
}

// end publishes "the response has ended" and releases the watcher goroutine. Safe to call on a nil
// watcher and safe to call more than once (only the first call has an effect).
//
// A CLIENT DISCONNECT CAN OUTRUN THE WATCHER GOROUTINE. Cancelling the request context also unblocks
// the handler's outbound request, so the handler can return and call end() before the goroutine is
// scheduled to observe Done. When the context is already cancelled at completion time, that completion
// IS the disconnect, and the pinned side effect must run here instead of depending on scheduling (this
// is the flake measured in CI: "an in-flight caller disconnect did not produce POST .../interrupt").
// A response that was actually sent cannot take this branch: net/http cancels the request context only
// AFTER ServeHTTP returns, so at a normal end() the context is still live.
func (watcher *pinnedSocketCloseWatcher) end() {
	if watcher == nil || watcher.finished == nil {
		return
	}
	if !watcher.ended.CompareAndSwap(false, true) {
		return
	}
	if watcher.ctx != nil && errors.Is(watcher.ctx.Err(), context.Canceled) {
		watcher.fire()
	}
	watcher.once.Do(func() { close(watcher.finished) })
}

// pinnedResponseEnded reports "the response has ended" as pinned's `response.writableEnded`. It is the
// state a handler publishes through the watcher; exposed as a method so the callback can also double
// check it without touching the atomic directly.
func (watcher *pinnedSocketCloseWatcher) pinnedResponseEnded() bool {
	return watcher == nil || watcher.ended.Load()
}
