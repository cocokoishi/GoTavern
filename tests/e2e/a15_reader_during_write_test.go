package e2e

// A15 LANE B: READERS DURING A SAVE MUST SEE A COMPLETE DOCUMENT (old XOR new), NEVER A PARTIAL ONE.
//
// The atomic-write contract is about the TARGET file, so a crash test proves half of it. The other half is
// what a concurrent reader observes: any process that opens settings.json while a save is in flight must
// see the complete old document or the complete new one, and a read that transiently fails may be recorded
// but may NOT be a partial document.
//
// The PLATFORM DIFFERENCE is the finding, not an assumption: on POSIX the rename publishes the new file
// while the reader's descriptor keeps the old inode, so saves and reads coexist; on Windows the rewrite is a
// rename over a path another process has open, which can fail with a sharing violation. This case therefore
// RECORDS what happens per host -- save failures are counted and their exact status/log text is printed, not
// retried away -- while asserting the invariant that must hold on every host: a non-empty read is always
// exactly old or exactly new. A save that fails under a concurrent reader is reported as a Windows finding
// (reproducer: this test name) rather than worked around.
//
// TEETH: a publish that writes the target directly (non-atomic) makes the reader observe an intermediate
// byte sequence, which turns this test red on the first such sample. If a host cannot produce that
// observation, the report says so instead of claiming it.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// readerObservation accumulates what the reader goroutine saw; counters are guarded because the writer and
// the reader run concurrently.
type readerObservation struct {
	mu             sync.Mutex
	reads          int
	oldReads       int
	newReads       int
	readErrors     []string
	partialSamples [][]byte
}

func (observation *readerObservation) record(body []byte, err error, oldBytes []byte, expected [][]byte) {
	observation.mu.Lock()
	defer observation.mu.Unlock()
	observation.reads++
	if err != nil {
		if len(observation.readErrors) < 3 {
			observation.readErrors = append(observation.readErrors, err.Error())
		}
		return
	}
	if bytes.Equal(body, oldBytes) {
		observation.oldReads++
		return
	}
	for _, document := range expected {
		if bytes.Equal(body, document) {
			observation.newReads++
			return
		}
	}
	// A read that is neither the complete old nor a complete new document is the violation. An EMPTY read
	// counts too: the reader opened the path while the file was held/truncated, and "empty" is a partial
	// observation of the document, not a document.
	if len(observation.partialSamples) < 3 {
		sample := append([]byte(nil), body...)
		observation.partialSamples = append(observation.partialSamples, sample)
	}
}

// TestReadersDuringASaveSeeOnlyCompleteDocuments drives a real save loop against a real reader loop.
func TestReadersDuringASaveSeeOnlyCompleteDocuments(t *testing.T) {
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(userRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(userRoot, "settings.json")
	oldBytes := []byte(`{"marker":"READER-OLD","pad":"` + strings.Repeat("o", 2<<10) + `"}`)
	if err := os.WriteFile(settingsPath, oldBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	bodyA := []byte(`{"marker":"READER-A","pad":"` + strings.Repeat("a", 256<<10) + `"}`)
	bodyB := []byte(`{"marker":"READER-B","pad":"` + strings.Repeat("b", 256<<10) + `"}`)
	expectedA, err := startup.FormatSettingsJSON(bodyA)
	if err != nil {
		t.Fatalf("normalise body A: %v", err)
	}
	expectedB, err := startup.FormatSettingsJSON(bodyB)
	if err != nil {
		t.Fatalf("normalise body B: %v", err)
	}
	expected := [][]byte{expectedA, expectedB}

	server := bootServerAt(t, installRoot, dataRoot, nil)
	client := openSession(t, server.origin)
	if booted, err := os.ReadFile(settingsPath); err != nil || !bytes.Equal(booted, oldBytes) {
		t.Fatalf("the boot changed the planted settings before the case began: %v", err)
	}

	observation := &readerObservation{}
	stopReader := make(chan struct{})
	readerDone := make(chan struct{})
	go func() {
		defer close(readerDone)
		for {
			select {
			case <-stopReader:
				return
			default:
			}
			body, readErr := os.ReadFile(settingsPath)
			observation.record(body, readErr, oldBytes, expected)
			time.Sleep(200 * time.Microsecond)
		}
	}()

	// SAVE LOOP: alternating complete documents, so a reader that only sees the first save cannot pass by
	// noticing one value. Twelve iterations give the reader a real window without a long run.
	saveStatuses := make([]int, 0, 12)
	saveErrors := make([]string, 0, 3)
	for round := 0; round < 12; round++ {
		body := bodyA
		if round%2 == 1 {
			body = bodyB
		}
		status, _, response := client.postJSON(t, "/api/settings/save", string(body))
		saveStatuses = append(saveStatuses, status)
		if status != 200 && len(saveErrors) < 3 {
			saveErrors = append(saveErrors, "status "+itoaForTest(status)+": "+truncateForLog(response, 120))
		}
	}
	close(stopReader)
	<-readerDone

	observation.mu.Lock()
	reads, oldReads, newReads := observation.reads, observation.oldReads, observation.newReads
	readErrors := append([]string(nil), observation.readErrors...)
	partialSamples := append([][]byte(nil), observation.partialSamples...)
	observation.mu.Unlock()

	// THE PLATFORM RECORD, always printed: this is the finding the case contributes on Windows.
	failures := 0
	for _, status := range saveStatuses {
		if status != 200 {
			failures++
		}
	}
	t.Logf("platform=%s saves=%d saveFailures=%d reads=%d oldReads=%d newReads=%d readErrors=%d partialSamples=%d",
		runtime.GOOS, len(saveStatuses), failures, reads, oldReads, newReads, len(readErrors), len(partialSamples))
	if failures > 0 {
		t.Logf("READER/SAVE INTERACTION FINDING on %s: %d/%d saves failed while a reader held the path open; first errors: %s\n%s",
			runtime.GOOS, failures, len(saveStatuses), strings.Join(saveErrors, " | "), tailOf(server.diagnostic(), 1200))
	}
	if len(readErrors) > 0 {
		t.Logf("the reader saw %d transient open/read errors (recorded, not treated as partial documents): %s",
			len(readErrors), strings.Join(readErrors, " | "))
	}

	// (1) THE INVARIANT FIRST: every non-empty observation is a complete old or new document. This is the
	// assertion a non-atomic publish must break; checking the vacuity guard first would let a prefix-publishing
	// mutation fail with the weaker "no saved document observed" message and hide which invariant broke.
	if len(partialSamples) > 0 {
		t.Fatalf("a reader observed a PARTIAL settings document during a save (%d sample(s)). A save must publish "+
			"old XOR new; the first sample is %d bytes, starts %q",
			len(partialSamples), len(partialSamples[0]), truncateForLog(string(partialSamples[0]), 160))
	}
	// (2) THE READER RAN AND SAW A PUBLISHED DOCUMENT: without this, "no partial sample" could just mean the
	// reader never overlapped a save (a vacuous green).
	if reads == 0 || newReads == 0 {
		t.Fatalf("the reader never observed a saved document (reads=%d oldReads=%d newReads=%d); the case never "+
			"overlapped a write and would pass vacuously", reads, oldReads, newReads)
	}
	// (3) POSIX SAVES MUST ALL SUCCEED: a failure there is a product defect, not a platform interaction.
	if runtime.GOOS != "windows" && failures != 0 {
		t.Fatalf("%d/%d settings saves failed under a concurrent POSIX reader, where rename-over-open must "+
			"succeed: %s", failures, len(saveStatuses), strings.Join(saveErrors, " | "))
	}

	// (4) AFTER THE LOOP THE FILE AND THE PRODUCT AGREE, and the document is complete and parseable.
	final, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(final, expectedA) && !bytes.Equal(final, expectedB) {
		t.Fatalf("after the save loop settings.json is not a complete expected document (%d bytes)", len(final))
	}
	if !json.Valid(final) {
		t.Fatalf("after the save loop settings.json is not parseable JSON")
	}
	status, _, body := client.postJSON(t, "/api/settings/get", "{}")
	if status != 200 {
		t.Fatalf("settings/get after the save loop = %d", status)
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
		t.Fatalf("the product serves settings that are not the final file bytes (served %d bytes, disk %d)",
			len(served), len(final))
	}
}

// itoaForTest avoids importing strconv into a test that already has enough imports.
func itoaForTest(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}
