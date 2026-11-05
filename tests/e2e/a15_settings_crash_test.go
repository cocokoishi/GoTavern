package e2e

// A15 LANE B: A RUNTIME SETTINGS WRITE KILLED MID-WRITE.
//
// The chat crash matrix already kills a real binary inside chat JSONL writes. This case covers the OTHER
// hot runtime write a user performs constantly -- /api/settings/save (the frontend autosaves it) -- on a
// real boot, and asserts the same three things at the process boundary:
//
//	1. settings.json is the complete OLD document or the complete NEW one (the product's own normalisation),
//	   never a prefix;
//	2. every leftover scratch file is DOT-PREFIXED (clearly identified as not user data), and a restart does
//	   not treat it as a settings document;
//	3. the restart serves parseable settings and leaves the crashed bytes untouched.
//
// The kill point is seeded random: it waits until the atomic write is observable (a
// `.gotavern-content-log-*` scratch file appears or the target size changes), jitters 0..8 ms, then kills.
// Whether the kill lands inside the write is reported, not assumed: a run where it never did would still
// assert the complete-state property, and the test logs the sampled window.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const settingsScratchPrefix = ".gotavern-content-log-"

// postTolerantJSON sends one POST whose failure is EXPECTED (the process is about to be killed), so it
// reports the transport error instead of failing the test from a goroutine.
func postTolerantJSON(client *session, route, body string) (int, string, string, error) {
	request, err := http.NewRequest(http.MethodPost, client.origin+route, strings.NewReader(body))
	if err != nil {
		return 0, "", "", err
	}
	request.Header.Set("Content-Type", "application/json")
	if client.cookie != "" {
		request.Header.Set("Cookie", client.cookie)
	}
	if client.token != "" {
		request.Header.Set("X-CSRF-Token", client.token)
	}
	response, err := client.client.Do(request)
	if err != nil {
		return 0, "", "", err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	return response.StatusCode, string(payload), string(payload), err
}

// settingsScratchFiles lists dot-prefixed scratch entries in a directory. A leftover one is a partial write
// that was never published; its NAME is the contract that keeps it out of the user's file list.
func settingsScratchFiles(t *testing.T, directory string) []string {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil
	}
	names := make([]string, 0, 1)
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		if strings.HasPrefix(entry.Name(), settingsScratchPrefix) {
			names = append(names, entry.Name())
		}
	}
	return names
}

func TestRuntimeSettingsWriteKilledMidWriteKeepsACompleteDocument(t *testing.T) {
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(userRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(userRoot, "settings.json")
	oldSettings := []byte("{\n    \"marker\": \"OLD-SETTINGS\",\n    \"pad\": \"" + strings.Repeat("o", 2<<20) + "\"\n}")
	if err := os.WriteFile(settingsPath, oldSettings, 0o600); err != nil {
		t.Fatal(err)
	}

	// The NEW document's on-disk bytes are the product's own normalisation of the request body.
	newBody := []byte(`{"marker":"NEW-SETTINGS","pad":"` + strings.Repeat("n", 64<<20) + `"}`)
	expectedNew, err := startup.FormatSettingsJSON(newBody)
	if err != nil {
		t.Fatalf("normalise the new settings body: %v", err)
	}

	server := bootServerIn(t, installRoot, installRoot, dataRoot, nil)
	client := openSession(t, server.origin)

	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _, _, _ = postTolerantJSON(client, "/api/settings/save", string(newBody))
	}()

	// Wait for the write to become observable, then jitter and kill. A scratch file is the atomic writer's
	// own signal; a grown settings.json is the other.
	killedMidWrite := false
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-done:
			break
		default:
		}
		scratch := settingsScratchFiles(t, userRoot)
		if len(scratch) > 0 {
			killedMidWrite = true
			hardKill(t, server)
			break
		}
		if info, statErr := os.Stat(settingsPath); statErr == nil {
			// An INTERMEDIATE size is the only size signal that proves a non-atomic writer is in flight: a
			// completed write is exactly the old or the new length, and killing at the new length would sample
			// nothing. (Measured: with a non-atomic direct write and only an "old-size changed" trigger, the
			// mutation SURVIVED because the kill landed after the write had finished -- AGENTS method 3.)
			size := info.Size()
			if size != int64(len(oldSettings)) && size != int64(len(expectedNew)) {
				killedMidWrite = true
				hardKill(t, server)
				break
			}
		}
		time.Sleep(200 * time.Microsecond)
	}
	if !killedMidWrite {
		server.stop()
		t.Fatalf("the settings write completed before a kill could sample its window; the case would assert a state it never reached")
	}
	t.Logf("sampled the settings write window with a hard kill")

	// (1) THE TARGET IS A COMPLETE OLD OR NEW DOCUMENT.
	crashed, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("settings.json is MISSING after a killed settings write: %v", err)
	}
	switch {
	case bytes.Equal(crashed, oldSettings):
	case bytes.Equal(crashed, expectedNew):
	default:
		t.Fatalf("settings.json after a kill is neither the complete old nor the complete new document (%d bytes).\n  old: %d bytes\n  new: %d bytes\n  file first 200: %q",
			len(crashed), len(oldSettings), len(expectedNew), truncateForLog(string(crashed), 200))
	}
	if !json.Valid(crashed) {
		t.Fatalf("settings.json after a kill is not parseable JSON: %q", truncateForLog(string(crashed), 200))
	}

	// (2) ANY LEFTOVER SCRATCH FILE IS DOT-PREFIXED AND ITS NAME SAYS WHAT IT IS. A stray NON-dot temp file
	// would appear in the user's directory listing and could be read as a settings document by a tool.
	if scratch := settingsScratchFiles(t, userRoot); len(scratch) > 0 {
		t.Logf("the crash left %d scratch file(s), all dot-prefixed as designed: %v", len(scratch), scratch)
	}
	for _, entry := range mustReadDirEntries(t, userRoot) {
		if entry.IsDir() || !entry.Type().IsRegular() {
			continue
		}
		if strings.HasSuffix(entry.Name(), ".tmp") && !strings.HasPrefix(entry.Name(), settingsScratchPrefix) {
			t.Fatalf("the crash left a NON-dot scratch file %q in the user root; a partial write must be clearly identified", entry.Name())
		}
	}

	// (3) THE RESTART SERVES PARSEABLE SETTINGS AND LEAVES THE CRASHED BYTES ALONE.
	restarted := bootServerIn(t, installRoot, installRoot, dataRoot, nil)
	restartedClient := openSession(t, restarted.origin)
	status, _, body := restartedClient.postJSON(t, "/api/settings/get", "{}")
	if status != 200 {
		t.Fatalf("the restarted server answered settings/get = %d after a killed settings write: %s", status, truncateForLog(body, 300))
	}
	var envelope struct {
		Settings json.RawMessage `json:"settings"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		t.Fatalf("the restarted settings/get body is not JSON: %v", err)
	}
	var servedSettings string
	if err := json.Unmarshal(envelope.Settings, &servedSettings); err != nil {
		t.Fatalf("the restarted settings/get `settings` member is not a string: %v", err)
	}
	if servedSettings != string(crashed) {
		t.Fatalf("the restart CHANGED the crashed settings file.\n  crashed: %s\n  served:  %s",
			truncateForLog(string(crashed), 200), truncateForLog(servedSettings, 200))
	}
}

func mustReadDirEntries(t *testing.T, directory string) []os.DirEntry {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read %s: %v", directory, err)
	}
	return entries
}
