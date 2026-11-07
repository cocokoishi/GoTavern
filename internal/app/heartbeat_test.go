package app

import (
	"context"
	"errors"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// TestHeartbeatStopIsBounded is the C-H6 red-first test. A heartbeat write stuck in its fsync must not
// make shutdown wait without a bound: Close receives a 100ms context, so it must report a NAMED failure
// within a small multiple of that bound instead of blocking on the writer mutex / <-writer.done.
//
// Pre-fix observation (recorded before the fix): "RunningServer.Close blocked for more than 2s on a
// heartbeat write stuck in fsync: the shutdown wait is unbounded".
func TestHeartbeatStopIsBounded(t *testing.T) {
	entered := make(chan struct{})
	release := make(chan struct{})
	var enteredOnce sync.Once
	writer := &heartbeatWriter{
		path:       filepath.Join(t.TempDir(), "heartbeat.json"),
		stopSignal: make(chan struct{}),
		done:       make(chan struct{}),
		writeFile: func(string, []byte) error {
			enteredOnce.Do(func() { close(entered) })
			<-release
			return nil
		},
	}
	go writer.run(time.Millisecond)
	defer close(release)
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("the fault-injected heartbeat write never started")
	}

	running := &RunningServer{heartbeat: writer}
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	type closeResult struct {
		err     error
		elapsed time.Duration
	}
	closed := make(chan closeResult, 1)
	started := time.Now()
	go func() { closed <- closeResult{err: running.Close(ctx), elapsed: time.Since(started)} }()
	select {
	case result := <-closed:
		if !errors.Is(result.err, ErrHeartbeatStopTimeout) {
			t.Fatalf("Close error = %v, want ErrHeartbeatStopTimeout (%v)", result.err, ErrHeartbeatStopTimeout)
		}
		if !strings.Contains(result.err.Error(), "heartbeat writer did not stop") {
			t.Errorf("Close error = %q, want the user-visible heartbeat message", result.err)
		}
		if result.elapsed > 2*time.Second {
			t.Errorf("Close took %v with a 100ms context, want a prompt bounded failure", result.elapsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("RunningServer.Close blocked for more than 2s on a heartbeat write stuck in fsync: the shutdown wait is unbounded (heartbeat.stop waits on the writer mutex and <-writer.done outside Close's context)")
	}
}

// TestHeartbeatStopIsPromptAndDoubleStopSafe pins the normal path: stop joins promptly, no heartbeat
// write survives it, a second stop is fast, and repeated start/stop cycles do not leak goroutines.
func TestHeartbeatStopIsPromptAndDoubleStopSafe(t *testing.T) {
	baseline := runtime.NumGoroutine()
	for cycle := 0; cycle < 20; cycle++ {
		writer := startHeartbeat(t.TempDir(), 10*time.Millisecond)
		time.Sleep(15 * time.Millisecond)

		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		started := time.Now()
		if err := writer.stop(ctx); err != nil {
			cancel()
			t.Fatalf("stop on the normal path = %v, want nil", err)
		}
		cancel()
		if elapsed := time.Since(started); elapsed > time.Second {
			t.Fatalf("stop took %v, want prompt", elapsed)
		}
		select {
		case <-writer.done:
			// The writer goroutine has exited: no heartbeat write can start after stop returned nil.
		default:
			t.Fatal("stop returned nil before the writer goroutine exited")
		}

		ctx2, cancel2 := context.WithTimeout(context.Background(), 2*time.Second)
		started = time.Now()
		if err := writer.stop(ctx2); err != nil {
			cancel2()
			t.Fatalf("second stop = %v, want nil", err)
		}
		cancel2()
		if elapsed := time.Since(started); elapsed > 100*time.Millisecond {
			t.Fatalf("second stop took %v, want fast", elapsed)
		}
	}
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if runtime.NumGoroutine() <= baseline+3 {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("goroutines after 20 start/stop cycles = %d, want at most %d (the heartbeat goroutine leaked or was not joined)", runtime.NumGoroutine(), baseline+3)
}

// TestHeartbeatStoppedWriterStartsNoFurtherWrites is the no-write-after-stop half of the contract. The
// write seam counts calls so a write that started after stop returned nil would be visible.
func TestHeartbeatStoppedWriterStartsNoFurtherWrites(t *testing.T) {
	var writes atomic.Int64
	writer := &heartbeatWriter{
		path:       filepath.Join(t.TempDir(), "heartbeat.json"),
		stopSignal: make(chan struct{}),
		done:       make(chan struct{}),
		writeFile: func(string, []byte) error {
			writes.Add(1)
			return nil
		},
	}
	go writer.run(time.Millisecond)
	deadline := time.Now().Add(2 * time.Second)
	for writes.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if writes.Load() == 0 {
		t.Fatal("the heartbeat writer never wrote; the fixture cannot observe post-stop writes")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := writer.stop(ctx); err != nil {
		t.Fatalf("stop = %v, want nil", err)
	}
	settled := writes.Load()
	time.Sleep(50 * time.Millisecond)
	if after := writes.Load(); after != settled {
		t.Fatalf("heartbeat writes went from %d to %d after stop returned nil, want no write to start after stop", settled, after)
	}
}
