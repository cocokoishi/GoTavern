package main

// The recorder's CONTROL surface. It is deliberately on its own listener and its own paths so that
// control traffic can never be mistaken for provider traffic (the recorder itself already excludes
// `/__mock/` from its recording for the same reason).
//
// The corpus driver uses these to (a) read how many provider requests have arrived before/after an
// action, so the action log can name the exact request ordinals it caused, and (b) write the full
// raw recording to disk at the end of a round without killing the provider.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"sync"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type control struct {
	recorder *mockprovider.KeyedRecorder
	out      string
	mu       sync.Mutex
}

func newControl(recorder *mockprovider.KeyedRecorder, out string) *control {
	return &control{recorder: recorder, out: out}
}

func (c *control) ServeHTTP(writer http.ResponseWriter, request *http.Request) {
	switch request.URL.Path {
	case "/__mock/health":
		writeJSON(writer, 200, map[string]any{"ok": true})
	case "/__mock/stats":
		recording := c.recorder.Recording()
		writeJSON(writer, 200, map[string]any{
			"requests":  len(recording.Requests),
			"nextIndex": nextIndex(recording),
		})
	case "/__mock/unused":
		writeJSON(writer, 200, map[string]any{"unused": c.recorder.Unused()})
	case "/__mock/recording":
		writeJSON(writer, 200, c.recorder.Recording())
	case "/__mock/dump":
		if err := c.dump(); err != nil {
			writeJSON(writer, 500, map[string]any{"error": err.Error()})
			return
		}
		writeJSON(writer, 200, map[string]any{"written": c.out})
	default:
		writeJSON(writer, 404, map[string]any{"error": "unknown control endpoint"})
	}
}

// dump writes the raw recording as one JSON document. A temp file + rename keeps a crashed dump from
// leaving a truncated capture in place of an earlier good one.
func (c *control) dump() error {
	c.mu.Lock()
	defer c.mu.Unlock()
	recording := c.recorder.Recording()
	encoded, err := json.MarshalIndent(recording, "", "  ")
	if err != nil {
		return fmt.Errorf("encode recording: %w", err)
	}
	temp := c.out + ".tmp"
	if err := os.WriteFile(temp, append(encoded, '\n'), 0o600); err != nil {
		return fmt.Errorf("write recording: %w", err)
	}
	if err := os.Rename(temp, c.out); err != nil {
		return fmt.Errorf("rename recording: %w", err)
	}
	return nil
}

func nextIndex(recording mockprovider.Recording) int {
	if len(recording.Requests) == 0 {
		return 0
	}
	return recording.Requests[len(recording.Requests)-1].Index + 1
}

func writeJSON(writer http.ResponseWriter, status int, value any) {
	writer.Header().Set("Content-Type", "application/json")
	writer.WriteHeader(status)
	_ = json.NewEncoder(writer).Encode(value)
}
