//go:build linux

package e2e

// A15 LANE B: A REAL KERNEL WRITE FAILURE (EFBIG), THE UNPRIVILEGED STAND-IN FOR DISK-FULL (ENOSPC).
//
// The directive forbids elevation, so a tiny tmpfs cannot be mounted and ENOSPC itself is not reproducible
// here. RLIMIT_FSIZE is a limit an unprivileged process may set on itself, and crossing it fails the write
// syscall with EFBIG -- the SAME kernel failure path a full disk takes: bytes already written by the
// partial write are the bytes the product published. No product code is mocked or modified; the subject is
// the SHIPPED binary started under `efbig-launcher` (tests/e2e/testdata/efbig-launcher), which sets the
// limit, IGNORES SIGXFSZ so the process gets an EFBIG return instead of dying, and execs the binary.
//
// Assertions, the same invariants as the killed-write gate:
//  1. a save BELOW the limit succeeds (the limit is the only variable);
//  2. a save ABOVE the limit answers non-200 and leaves settings.json EXACTLY the previous complete
//     document -- no partial, no truncation, no rewritten file;
//  3. no non-dot scratch file is left in the user directory;
//  4. the process is still alive (the write failed; the server did not die), and a restart serves the
//     surviving bytes unchanged.
//
// The launcher's own stderr line names the applied limit, so the test proves the limit reached the subject
// rather than assuming it did.

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// efbigLimitFor derives the limit instead of hard-coding it. The first version used a 1 MiB constant with a
// comment claiming it was "above every startup write"; the first Linux CI run measured that the commit's own
// seeded background is 2 322 272 bytes, so the server died while SEEDING and the test never reached the save it
// exists to provoke. A constant that the default content can outgrow is the wrong shape for this gate, so the
// largest seeded file is measured and the limit is placed above it, with the margin reported.
func efbigLimitFor(t *testing.T) (limit, largestSeeded uint64) {
	t.Helper()
	contentRoot := filepath.Join(moduleRoot(t), "upstream", "default", "content")
	walkErr := filepath.WalkDir(contentRoot, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if size := uint64(info.Size()); size > largestSeeded {
			largestSeeded = size
		}
		return nil
	})
	if walkErr != nil {
		t.Fatalf("measure the seeded default content under %s: %v", contentRoot, walkErr)
	}
	if largestSeeded == 0 {
		t.Fatalf("no default content under %s, so the EFBIG limit cannot be derived from what the boot writes", contentRoot)
	}
	// One MiB of headroom: the seeded writes pass, and any save larger than the limit fails with EFBIG.
	return largestSeeded + (1 << 20), largestSeeded
}

// buildEFBIGLauncher compiles the testdata launcher with the SAME toolchain; testdata is invisible to
// `go build ./...` and `go vet ./...`, so nothing else in the repository is affected.
func buildEFBIGLauncher(t *testing.T) string {
	t.Helper()
	launcher := filepath.Join(t.TempDir(), "efbig-launcher")
	build := exec.Command("go", "build", "-o", launcher, "./tests/e2e/testdata/efbig-launcher")
	build.Dir = moduleRoot(t)
	build.Env = append(os.Environ(), "CGO_ENABLED=0")
	output, err := build.CombinedOutput()
	if err != nil {
		t.Fatalf("build the EFBIG launcher: %v\n%s", err, output)
	}
	info, err := os.Stat(launcher)
	if err != nil || info.Size() == 0 {
		t.Fatalf("the EFBIG launcher was not produced at %s: %v", launcher, err)
	}
	return launcher
}

// bootServerUnderEFBIGLimit mirrors bootServerCommand's fixed recipe and readiness loop, but starts the
// binary through the launcher. (The harness boot helpers do not take a wrapper, and this lane may not edit
// harness_test.go; duplicating the recipe keeps the wrapper scoped to this gate.)
func bootServerUnderEFBIGLimit(t *testing.T, installRoot, workingDirectory, dataRoot, launcher string, limit uint64) *serverProcess {
	t.Helper()
	binary := resolveBinary(t, installRoot)
	port := freePort(t)
	arguments := []string{"start", "--dataRoot", dataRoot,
		"--listenAddressIPv4", "127.0.0.1",
		"--enableIPv4", "true",
		"--enableIPv6", "false",
		"--listen", "false",
		"--port", strconv.Itoa(port),
		"--browserLaunchEnabled", "false",
		"--heartbeatInterval", "0",
	}
	// launcher LIMIT BINARY ARGS... -- the launcher execs the binary with the remaining arguments.
	commandArguments := append([]string{strconv.FormatUint(limit, 10), binary}, arguments...)
	command := exec.Command(launcher, commandArguments...)
	command.Dir = workingDirectory
	command.Env = childEnvironment(nil)
	server := &serverProcess{
		origin:   "http://127.0.0.1:" + strconv.Itoa(port),
		install:  installRoot,
		dataRoot: dataRoot,
		stdout:   &capturedOutput{},
		stderr:   &capturedOutput{},
		command:  command,
		exitCh:   make(chan struct{}),
	}
	command.Stdout = server.stdout
	command.Stderr = server.stderr
	if err := command.Start(); err != nil {
		t.Fatalf("start the binary under the EFBIG launcher: %v", err)
	}
	go func() {
		err := command.Wait()
		server.stateMu.Lock()
		server.exitErr = err
		server.exited = true
		server.stateMu.Unlock()
		close(server.exitCh)
	}()
	t.Cleanup(server.stop)

	// Proxy nil for the same reason the harness's readiness client has it: a CI proxy variable must not
	// divert the loopback probe.
	readinessClient := &http.Client{Transport: &http.Transport{Proxy: nil}, Timeout: 10 * time.Second}
	deadline := time.Now().Add(bootDeadline)
	for {
		if err, exited := server.exitState(); exited {
			t.Fatalf("the server exited before it answered GET %s (%v)\n%s", readinessPath, err, server.diagnostic())
		}
		response, err := readinessClient.Get(server.origin + readinessPath)
		if err == nil {
			payload, readErr := io.ReadAll(response.Body)
			_ = response.Body.Close()
			if readErr == nil && response.StatusCode == http.StatusOK && len(payload) > 0 {
				t.Logf("server ready under the EFBIG launcher at %s after GET %s answered 200", server.origin, readinessPath)
				return server
			}
		}
		if time.Now().After(deadline) {
			t.Fatalf("the server did not answer GET %s within %s under the EFBIG launcher\n%s", readinessPath, bootDeadline, server.diagnostic())
		}
		time.Sleep(bootPollInterval)
	}
}

// TestKernelFileSizeLimitRefusesTheSaveAndKeepsTheOldDocument is the EFBIG gate (Linux CI). The Windows
// build declares the same name skipped with the reason, in a15_efbig_windows_test.go.
func TestKernelFileSizeLimitRefusesTheSaveAndKeepsTheOldDocument(t *testing.T) {
	launcher := buildEFBIGLauncher(t)
	limit, largestSeeded := efbigLimitFor(t)
	if largestSeeded >= limit {
		t.Fatalf("the derived EFBIG limit %d is not above the largest seeded write %d, so boot would fail before the save", limit, largestSeeded)
	}
	t.Logf("EFBIG limit=%d bytes (largest seeded default-content write=%d bytes, margin=%d)", limit, largestSeeded, limit-largestSeeded)
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(userRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(userRoot, "settings.json")
	planted := []byte(`{"marker":"EFBIG-OLD","pad":"` + strings.Repeat("o", 256) + `"}`)
	if err := os.WriteFile(settingsPath, planted, 0o600); err != nil {
		t.Fatal(err)
	}

	server := bootServerUnderEFBIGLimit(t, installRoot, installRoot, dataRoot, launcher, limit)
	// PROOF THE LAUNCHER REACHED THE SUBJECT: its stderr names the applied limit.
	if !strings.Contains(server.stderr.String(), "efbig-launcher: RLIMIT_FSIZE=") {
		t.Fatalf("the EFBIG launcher did not report an applied RLIMIT_FSIZE, so the kernel limit never reached "+
			"the subject and this case would prove nothing:\n%s", server.diagnostic())
	}
	client := openSession(t, server.origin)

	// (1) A SAVE BELOW THE LIMIT SUCCEEDS: the limit is the only difference from the refusal below.
	control := `{"marker":"EFBIG-CONTROL","pad":"` + strings.Repeat("c", 16<<10) + `"}`
	if status, _, body := client.postJSON(t, "/api/settings/save", control); status != 200 {
		t.Fatalf("settings/save BELOW the %d-byte RLIMIT_FSIZE = %d, so the control never exercised the save "+
			"path: %s", limit, status, truncateForLog(body, 300))
	}
	controlBytes, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	controlFormat, err := startup.FormatSettingsJSON([]byte(control))
	if err != nil {
		t.Fatalf("normalise the control: %v", err)
	}
	if !bytes.Equal(controlBytes, controlFormat) {
		t.Fatalf("the control save on disk is not the product's own normalisation of the request")
	}

	// (2) A SAVE ABOVE THE LIMIT FAILS WITH A KERNEL WRITE ERROR, and the previous complete document stays.
	// The pad IS the limit, so the JSON body is necessarily larger than the limit and the write must be refused.
	oversized := []byte(`{"marker":"EFBIG-OVERSIZED","pad":"` + strings.Repeat("x", int(limit)) + `"}`)
	status, _, _ := client.postJSON(t, "/api/settings/save", string(oversized))
	if status == 200 {
		t.Fatalf("settings/save REPORTED SUCCESS while the kernel refused writes past RLIMIT_FSIZE=%d; success "+
			"for a save that cannot have landed is the data-loss lie this gate exists for", limit)
	}
	afterRefusal, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("read settings after the EFBIG write: %v", err)
	}
	if !bytes.Equal(afterRefusal, controlBytes) {
		t.Fatalf("the REFUSED write changed settings.json (%d bytes now, %d before): a partial publish survived "+
			"a kernel write failure.\n  now: %s", len(afterRefusal), len(controlBytes), truncateForLog(string(afterRefusal), 300))
	}
	if !json.Valid(afterRefusal) {
		t.Fatalf("settings.json is not parseable after the EFBIG write: %q", truncateForLog(string(afterRefusal), 300))
	}
	for _, entry := range mustReadDirEntries(t, userRoot) {
		if !entry.IsDir() && strings.HasSuffix(entry.Name(), ".tmp") && !strings.HasPrefix(entry.Name(), ".gotavern-content-log-") {
			t.Fatalf("the EFBIG write left a NON-dot scratch file %q in the user directory", entry.Name())
		}
	}
	// (3) THE SERVER SURVIVED: a write failure must not take the process down.
	if err, exited := server.exitState(); exited {
		t.Fatalf("the server EXITED after a kernel write failure (%v): a refused write must be surfaced, not fatal\n%s",
			err, server.diagnostic())
	}

	// (4) A RESTART SERVES THE SURVIVING BYTES, unchanged.
	server.stop()
	restarted := bootServerIn(t, installRoot, installRoot, dataRoot, nil)
	restartedClient := openSession(t, restarted.origin)
	status, _, servedBody := restartedClient.postJSON(t, "/api/settings/get", "{}")
	if status != 200 {
		t.Fatalf("the restarted server answered settings/get = %d after the EFBIG refusal: %s", status, truncateForLog(servedBody, 300))
	}
	var envelope struct {
		Settings json.RawMessage `json:"settings"`
	}
	if err := json.Unmarshal([]byte(servedBody), &envelope); err != nil {
		t.Fatalf("settings/get body is not JSON: %v", err)
	}
	var served string
	if err := json.Unmarshal(envelope.Settings, &served); err != nil {
		t.Fatalf("settings/get `settings` member is not a string: %v", err)
	}
	if served != string(afterRefusal) {
		t.Fatalf("the restart does not serve the surviving settings bytes.\n  disk:   %s\n  served: %s",
			truncateForLog(string(afterRefusal), 200), truncateForLog(served, 200))
	}
}
