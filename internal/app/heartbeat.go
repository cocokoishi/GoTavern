package app

import (
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
	"time"
)

const maxNodeTimerDurationMilliseconds = 1<<31 - 1

type heartbeatWriter struct {
	path       string
	stopSignal chan struct{}
	done       chan struct{}
	mu         sync.Mutex
	stopped    bool
	once       sync.Once
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
		select {
		case <-ticker.C:
			writer.write()
		case <-writer.stopSignal:
			return
		}
	}
}

func (writer *heartbeatWriter) write() {
	writer.mu.Lock()
	defer writer.mu.Unlock()
	if writer.stopped {
		return
	}
	body := []byte(`{"timestamp":` + strconv.FormatInt(time.Now().UnixMilli(), 10) + `}`)
	if err := atomicWriteHeartbeat(writer.path, body); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write heartbeat file at %s: %s\n", writer.path, err)
	}
}

func (writer *heartbeatWriter) stop() {
	writer.once.Do(func() {
		writer.mu.Lock()
		writer.stopped = true
		close(writer.stopSignal)
		writer.mu.Unlock()
	})
	<-writer.done
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
