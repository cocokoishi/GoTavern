package e2e

// A15 LANE B: TWO PROCESSES ON ONE DATA ROOT (GOAL §14.5: "a concurrent writer leaves the user's data
// parseable and recoverable, with the bounded-lock and atomic-write invariants of rules 12 and 24 intact").
//
// The harness boots TWO REAL BINARIES against the SAME data root. Every request below goes through the
// product's own write path (settings/save and chats/save), from both processes at once, and the assertions
// are on the BYTES on disk:
//
//	1. every request completes inside the per-lock bound (no unbounded wait, AGENTS 24);
//	2. the final file is EXACTLY one of the submitted bodies -- never an interleaving, never a prefix;
//	3. the file parses (JSON for settings.json, one JSON object per line for a chat .jsonl);
//	4. the product reads the same bytes back, so the write is visible to the other process too.
//
// PINNED SEMANTICS: pinned Node has no cross-process data lock, so two servers on one tree is last-writer-
// wins per file (each write is write-file-atomic). GoTavern must preserve that observable -- a torn or
// interleaved file is not "safer", it is a different product -- while still bounding lock waits.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// sharedRootTree is a data root two independently installed binaries serve.
type sharedRootTree struct {
	dataRoot string
}

func newSharedRootTree(t *testing.T) *sharedRootTree {
	t.Helper()
	tree := &sharedRootTree{dataRoot: t.TempDir()}
	return tree
}

// twoClients boots two servers against the shared data root, each with its own install root (its own
// config.yaml and binary, which is what a machine running two installs looks like).
func (tree *sharedRootTree) twoClients(t *testing.T) (*crashClient, *crashClient) {
	t.Helper()
	installA := t.TempDir()
	installB := t.TempDir()
	serverA := bootServerIn(t, installA, installA, tree.dataRoot, nil)
	serverB := bootServerIn(t, installB, installB, tree.dataRoot, nil)
	return &crashClient{server: serverA, sess: openSession(t, serverA.origin)},
		&crashClient{server: serverB, sess: openSession(t, serverB.origin)}
}

// settingsBody builds one whole settings document of a fixed large size so a non-atomic write has a visible
// window. Its marker identifies which writer produced it.
func settingsBody(marker string, size int) []byte {
	pad := strings.Repeat("p", size)
	document := map[string]any{"marker": marker, "oai_settings": map[string]any{"pad": pad}}
	encoded, err := json.Marshal(document)
	if err != nil {
		panic(err)
	}
	return encoded
}

// TestTwoProcessesOneDataRootSettingsWritesStayWhole drives concurrent settings/save from two processes.
func TestTwoProcessesOneDataRootSettingsWritesStayWhole(t *testing.T) {
	tree := newSharedRootTree(t)
	clientA, clientB := tree.twoClients(t)
	defer clientA.server.stop()
	defer clientB.server.stop()

	settingsPath := filepath.Join(tree.dataRoot, "default-user", "settings.json")
	candidates := make([][]byte, 0, 16)
	type result struct {
		label  string
		status int
		body   string
		error  error
		took   time.Duration
	}
	// The expected bytes are what the route ITSELF stores for a body (startup.FormatSettingsJSON; the
	// handler validates and normalises with it before saving), so the assertion is about which writer's
	// complete document is on disk, not about a second serializer written here.
	for round := 0; round < 8; round++ {
		bodyA := settingsBody("A-"+strconv.Itoa(round), 48<<10)
		bodyB := settingsBody("B-"+strconv.Itoa(round), 48<<10)
		expectedA, err := startup.FormatSettingsJSON(bodyA)
		if err != nil {
			t.Fatalf("normalise body A: %v", err)
		}
		expectedB, err := startup.FormatSettingsJSON(bodyB)
		if err != nil {
			t.Fatalf("normalise body B: %v", err)
		}
		if bytes.Equal(expectedA, expectedB) {
			t.Fatalf("round %d: the two documents normalise to the same bytes, so the assertion cannot tell the writers apart", round)
		}
		candidates = append(candidates, expectedA, expectedB)
		results := make([]result, 2)
		var wait sync.WaitGroup
		wait.Add(2)
		go func() {
			defer wait.Done()
			started := time.Now()
			status, _, body, err := clientA.postTolerant("/api/settings/save", string(bodyA))
			results[0] = result{label: "A", status: status, body: body, error: err, took: time.Since(started)}
		}()
		go func() {
			defer wait.Done()
			started := time.Now()
			status, _, body, err := clientB.postTolerant("/api/settings/save", string(bodyB))
			results[1] = result{label: "B", status: status, body: body, error: err, took: time.Since(started)}
		}()
		wait.Wait()
		for _, entry := range results {
			if entry.error != nil || entry.status != http.StatusOK {
				t.Fatalf("concurrent settings/save from %s = %d (%v): %s", entry.label, entry.status, entry.error, truncateForLog(entry.body, 300))
			}
			if entry.took > 12*time.Second {
				t.Fatalf("settings/save from %s took %s; the per-lock bound is 10s (AGENTS 24)", entry.label, entry.took)
			}
		}

		// THE BYTES ON DISK must be one of the two complete documents of THIS round. A lock that is not
		// cross-process, or a write that is not atomic, shows up here as a mixed or truncated body.
		final, err := os.ReadFile(settingsPath)
		if err != nil {
			t.Fatalf("round %d: read settings.json: %v", round, err)
		}
		if !bytes.Equal(final, expectedA) && !bytes.Equal(final, expectedB) {
			t.Fatalf("round %d: settings.json is not either writer's complete document (%d bytes).\n  A: %s\n  B: %s\n  file: %s",
				round, len(final), truncateForLog(string(expectedA), 120), truncateForLog(string(expectedB), 120), truncateForLog(string(final), 300))
		}
		var parsed map[string]any
		if err := json.Unmarshal(final, &parsed); err != nil {
			t.Fatalf("round %d: settings.json is not parseable JSON after concurrent writes: %v (%s)", round, err, truncateForLog(string(final), 200))
		}
	}

	// BOTH PROCESSES READ THE FINAL BYTES BACK, so the last writer's document is what the product serves,
	// not merely what happens to be on disk.
	final, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, client := range []*crashClient{clientA, clientB} {
		status, _, body, err := client.postTolerant("/api/settings/get", "{}")
		if err != nil || status != http.StatusOK {
			t.Fatalf("settings/get after concurrent writes = %d (%v): %s", status, err, truncateForLog(body, 300))
		}
		var envelope struct {
			Settings json.RawMessage `json:"settings"`
		}
		if err := json.Unmarshal([]byte(body), &envelope); err != nil {
			t.Fatalf("settings/get body is not JSON: %v", err)
		}
		var served string
		if err := json.Unmarshal(envelope.Settings, &served); err != nil {
			t.Fatalf("settings/get `settings` member is not a string: %v", err)
		}
		if served != string(final) {
			t.Fatalf("a process serves settings that are not the final file bytes.\n  served: %s\n  disk:   %s",
				truncateForLog(served, 200), truncateForLog(string(final), 200))
		}
	}
}

// TestTwoProcessesOneDataRootChatWritesStayWhole drives concurrent /api/chats/save from two processes and
// requires the final chat file to be one complete payload.
func TestTwoProcessesOneDataRootChatWritesStayWhole(t *testing.T) {
	tree := newSharedRootTree(t)
	clientA, clientB := tree.twoClients(t)
	defer clientA.server.stop()
	defer clientB.server.stop()

	directories, err := startup.DirectoriesForUser(tree.dataRoot, "default-user")
	if err != nil {
		t.Fatalf("resolve user directories: %v", err)
	}
	chatDir := filepath.Join(directories["chats"], "SharedCard")
	if err := os.MkdirAll(chatDir, 0o777); err != nil {
		t.Fatal(err)
	}
	avatar := "SharedCard.png"

	saveBodyA := `{"avatar_url":"` + avatar + `","file_name":"shared","chat":[` +
		`{"user_name":"A","character_name":"Shared","chat_metadata":{"writer":"A"}},` +
		`{"name":"A","is_user":true,"mes":"A's complete message ` + strings.Repeat("a", 256<<10) + `"}]}`
	saveBodyB := `{"avatar_url":"` + avatar + `","file_name":"shared","chat":[` +
		`{"user_name":"B","character_name":"Shared","chat_metadata":{"writer":"B"}},` +
		`{"name":"B","is_user":true,"mes":"B's complete message ` + strings.Repeat("b", 256<<10) + `"}]}`

	chatPath := filepath.Join(chatDir, "shared.jsonl")

	// CONTROL SAVES capture the product's own JSONL encoding; the assertion is against those exact bytes,
	// so a serializer difference between this test and the product cannot look like a torn write.
	if status, body, err := clientA.post("/api/chats/save", saveBodyA); err != nil || status != http.StatusOK {
		t.Fatalf("control chat save A = %d (%v): %s", status, err, truncateForLog(body, 300))
	}
	expectedA, err := os.ReadFile(chatPath)
	if err != nil {
		t.Fatalf("read the chat after control A: %v", err)
	}
	if status, body, err := clientB.post("/api/chats/save", saveBodyB); err != nil || status != http.StatusOK {
		t.Fatalf("control chat save B = %d (%v): %s", status, err, truncateForLog(body, 300))
	}
	expectedB, err := os.ReadFile(chatPath)
	if err != nil {
		t.Fatalf("read the chat after control B: %v", err)
	}
	if bytes.Equal(expectedA, expectedB) {
		t.Fatal("the two control chat payloads encode to the same bytes, so the assertion cannot tell the writers apart")
	}

	for round := 0; round < 6; round++ {
		var wait sync.WaitGroup
		wait.Add(2)
		statuses := make([]int, 2)
		errors := make([]error, 2)
		go func() {
			defer wait.Done()
			statuses[0], _, errors[0] = clientA.post("/api/chats/save", saveBodyA)
		}()
		go func() {
			defer wait.Done()
			statuses[1], _, errors[1] = clientB.post("/api/chats/save", saveBodyB)
		}()
		wait.Wait()
		for index := range statuses {
			if errors[index] != nil || statuses[index] != http.StatusOK {
				t.Fatalf("round %d: concurrent chats/save writer %d = %d (%v)", round, index, statuses[index], errors[index])
			}
		}

		final, err := os.ReadFile(chatPath)
		if err != nil {
			t.Fatalf("round %d: read the shared chat: %v", round, err)
		}
		if !bytes.Equal(final, expectedA) && !bytes.Equal(final, expectedB) {
			t.Fatalf("round %d: the shared chat is not either writer's exact bytes (%d bytes); it is a torn/interleaved write",
				round, len(final))
		}
		for index, line := range strings.Split(string(final), "\n") {
			if strings.TrimSpace(line) == "" {
				continue
			}
			if !json.Valid([]byte(line)) {
				t.Fatalf("round %d: chat line %d is not valid JSON after concurrent writes: %q", round, index, truncateForLog(line, 160))
			}
		}
	}
}
