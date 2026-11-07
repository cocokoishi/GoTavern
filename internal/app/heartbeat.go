package app

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

const maxNodeTimerDurationMilliseconds = 1<<31 - 1

// ErrHeartbeatStopTimeout is the named failure returned when the heartbeat goroutine has not joined
// within the caller's shutdown deadline. It is a sentinel so a caller can distinguish "the writer could
// not stop" from any other shutdown error, and its message names what the operator is left with.
var ErrHeartbeatStopTimeout = errors.New("heartbeat writer did not stop within the shutdown deadline; a heartbeat write may still be running")

type heartbeatWriter struct {
	path       string
	stopSignal chan struct{}
	done       chan struct{}
	mu         sync.Mutex
	// stopped is published BEFORE stopSignal is closed, without the IO mutex, so stop never waits behind
	// a write that is inside fsync. write() re-checks it under the IO mutex: a write that passed the
	// unsynchronised check cannot then start after stop has published the flag.
	stopped  atomic.Bool
	stopOnce sync.Once
	// writeFile is the heartbeat write, injectable so a test can hold the write inside its fsync and prove
	// the shutdown wait is bounded. It is set by startHeartbeat in production and only a test changes it
	// (the same seam pattern as `runningInDocker` in internal/app/server.go:409-418).
	writeFile func(string, []byte) error
}

func parsedHeartbeatInterval(value any) time.Duration {
	seconds, ok := heartbeatSeconds(value)
	if !ok || !(seconds > 0) {
		return 0
	}
	milliseconds := seconds * 1000
	if math.IsInf(milliseconds, 0) || milliseconds < 1 || milliseconds > maxNodeTimerDurationMilliseconds {
		return time.Millisecond
	}
	return time.Duration(math.Trunc(milliseconds)) * time.Millisecond
}

func startHeartbeat(dataRoot string, interval time.Duration) *heartbeatWriter {
	writer := &heartbeatWriter{
		path:       filepath.Join(dataRoot, "heartbeat.json"),
		stopSignal: make(chan struct{}),
		done:       make(chan struct{}),
		writeFile:  atomicWriteHeartbeat,
	}
	writer.write()
	go writer.run(interval)
	return writer
}

func (writer *heartbeatWriter) run(interval time.Duration) {
	defer close(writer.done)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		// Prioritise the stop signal so a closed stopSignal cannot be starved by a ticker whose channel is
		// also ready: at most one no-op write attempt follows stopped being published.
		select {
		case <-writer.stopSignal:
			return
		default:
		}
		select {
		case <-ticker.C:
			writer.write()
		case <-writer.stopSignal:
			return
		}
	}
}

func (writer *heartbeatWriter) write() {
	// No write may START once stop has published `stopped`; the check is repeated under the IO mutex so a
	// writer that passed the first check cannot slip past a concurrent stop.
	if writer.stopped.Load() {
		return
	}
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if writer.stopped.Load() {
		return
	}
	body := []byte(`{"timestamp":` + strconv.FormatInt(time.Now().UnixMilli(), 10) + `}`)
	writeFile := writer.writeFile
	if writeFile == nil {
		writeFile = atomicWriteHeartbeat
	}
	if err := writeFile(writer.path, body); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write heartbeat file at %s: %s\n", writer.path, err)
	}
}

// stop signals the heartbeat writer and joins its goroutine under the caller's bounded context.
//
// It NEVER takes the IO mutex, so a write stuck inside fsync cannot block the caller behind an fsync:
// previously stop waited for that mutex and then for <-done with no bound, so a stalled filesystem hung
// Ctrl+C forever (AGENTS rule 24/33). The guarantee stop returns with is: no heartbeat write starts after
// it reports success. A write that was already inside writeFile when stop was called may finish after
// stop's deadline (documented, not hidden) -- stop reports ErrHeartbeatStopTimeout in that case and the
// caller decides how to end the process.
//
// Double-stop is safe: the first call publishes stopped and closes stopSignal exactly once; every call
// only waits for done, so a second call on a stopped writer returns immediately.
func (writer *heartbeatWriter) stop(ctx context.Context) error {
	writer.stopOnce.Do(func() {
		writer.stopped.Store(true)
		close(writer.stopSignal)
	})
	select {
	case <-writer.done:
		return nil
	case <-ctx.Done():
		return fmt.Errorf("%w: %v", ErrHeartbeatStopTimeout, ctx.Err())
	}
}

func atomicWriteHeartbeat(target string, body []byte) error {
	directory := filepath.Dir(target)
	mode := fs.FileMode(0o666)
	if info, err := os.Stat(target); err == nil {
		mode = info.Mode().Perm()
	} else if !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	var temporary *os.File
	for attempt := 0; attempt < 8; attempt++ {
		token := make([]byte, 16)
		if _, err := rand.Read(token); err != nil {
			return err
		}
		name := ".gotavern-heartbeat-" + hex.EncodeToString(token) + ".tmp"
		file, err := os.OpenFile(filepath.Join(directory, name), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o666)
		if errors.Is(err, fs.ErrExist) {
			continue
		}
		if err != nil {
			return err
		}
		temporary = file
		break
	}
	if temporary == nil {
		return errors.New("could not allocate a unique heartbeat temporary file")
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if mode != 0o666 {
		if err := temporary.Chmod(mode); err != nil {
			_ = temporary.Close()
			return err
		}
	}
	if _, err := temporary.Write(body); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		_ = temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, target); err != nil {
		return err
	}
	if directoryFile, err := os.Open(directory); err == nil {
		_ = directoryFile.Sync()
		_ = directoryFile.Close()
	}
	return nil
}

func heartbeatSeconds(value any) (float64, bool) {
	switch typed := value.(type) {
	case float64:
		return typed, true
	case int:
		return float64(typed), true
	case int64:
		return float64(typed), true
	default:
		return 0, false
	}
}
