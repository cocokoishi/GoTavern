package app

import (
	"fmt"
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
	body := []byte(`{"timestamp":` + strconv.FormatInt(time.Now().UnixMilli(), 10) + `}`)
	if err := os.WriteFile(writer.path, body, 0o666); err != nil {
		fmt.Fprintf(os.Stderr, "Failed to write heartbeat file at %s: %s\n", writer.path, err)
	}
}

func (writer *heartbeatWriter) stop() {
	writer.once.Do(func() { close(writer.stopSignal) })
	<-writer.done
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
