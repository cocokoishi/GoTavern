package server

// alpha.20 reproducer for the socket-close watcher MECHANISM.
//
// The end-to-end RED (a20_sd_interrupt_test.go) proves the observable: a successful /api/sd/generate
// used to send POST /sdapi/v1/interrupt because net/http cancels the request context when ServeHTTP
// returns. This file pins the two properties that make the fix correct rather than accidental:
//
//  1. a callback armed on a still-running request fires when the client goes away; and
//  2. a callback armed on a response that has ALREADY ended never fires, even when the completion and
//     the cancellation land back to back so that both select cases are ready.
//
// Property 2 is the one that needs care: if the watcher goroutine has not been scheduled by the time
// end() and the context cancellation have both happened, a bare `select` picks a case at random. The
// test forces that state with GOMAXPROCS(1): the goroutine cannot run between the two calls, so both
// channels are closed before it starts. Without the completion flag the callback fires about half the
// time; over the iteration count below a missing flag is detected with probability 1-2^-iterations.

import (
	"context"
	"net/http/httptest"
	"runtime"
	"sync/atomic"
	"testing"
	"time"
)

func TestA20SocketCloseWatcherFiresOnlyWhileTheResponseIsOpen(t *testing.T) {
	t.Run("a client disconnect while the handler runs fires exactly once", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		request := httptest.NewRequest("POST", "/api/sd/generate", nil).WithContext(ctx)
		var calls atomic.Int32
		watcher := watchPinnedSocketClose(request, func() { calls.Add(1) })
		cancel()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) && calls.Load() == 0 {
			time.Sleep(2 * time.Millisecond)
		}
		if got := calls.Load(); got != 1 {
			t.Fatalf("callback calls = %d, want 1 for a disconnect with the response open", got)
		}
		// end() after the callback must neither panic nor fire again.
		watcher.end()
		cancel()
		time.Sleep(50 * time.Millisecond)
		if got := calls.Load(); got != 1 {
			t.Fatalf("callback calls = %d after end(), want 1", got)
		}
	})

	t.Run("a response that ended before the cancellation never fires", func(t *testing.T) {
		previous := runtime.GOMAXPROCS(1)
		defer runtime.GOMAXPROCS(previous)
		const iterations = 200
		var fired atomic.Int32
		for index := 0; index < iterations; index++ {
			ctx, cancel := context.WithCancel(context.Background())
			request := httptest.NewRequest("POST", "/api/sd/generate", nil).WithContext(ctx)
			watcher := watchPinnedSocketClose(request, func() { fired.Add(1) })
			// No yield between these two calls: with one P the watcher goroutine has not started yet, so
			// both select cases are ready when it finally runs -- the random-select state the completion
			// flag exists to make safe.
			watcher.end()
			cancel()
			runtime.Gosched()
		}
		// Let any runnable watcher goroutine finish before reading the counter.
		time.Sleep(100 * time.Millisecond)
		if got := fired.Load(); got != 0 {
			t.Fatalf("%d/%d watchers fired their cancel callback after the response had ended; pinned "+
				"guards the side effect with !response.writableEnded", got, iterations)
		}
	})

	t.Run("a nil Done channel arms nothing and end is safe", func(t *testing.T) {
		request := httptest.NewRequest("POST", "/api/sd/generate", nil) // context.Background(): Done() == nil
		watcher := watchPinnedSocketClose(request, func() {
			t.Fatalf("a watcher with a nil Done channel must never fire")
		})
		if watcher != nil {
			t.Fatalf("watchPinnedSocketClose returned a watcher for a context with a nil Done channel; a " +
				"receive on it would block forever (the alpha.19 goroutine-leak class)")
		}
		watcher.end() // must be a safe no-op
	})
}
