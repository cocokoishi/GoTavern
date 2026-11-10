package e2e

// Harness for the chat-write crash-atomicity tests (see chat_crash_test.go for the matrix and the
// assertions, and internal/faultinject for the deterministic crash seam).
//
// Two fault models are used together:
//   - DETERMINISTIC: a binary built with `-tags gotavern_faults` exits at a NAMED write point, armed only
//     after the server is ready (so boot-time atomic writes cannot trigger it);
//   - RANDOMISED: a normal hard kill at a seeded point after write progress is observable.
//
// Every case runs against its own release-shaped tree: installRoot holds the binary and config, dataRoot
// is the default user's data. The ONLY pre-state this harness writes is the test's BEFORE image of a chat
// file; everything after that is the product's own write.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math/rand"
	"mime/multipart"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	crashAvatar          = "CrashCard"
	crashSeed      int64 = 20261031
	faultAtEnv           = "GOTAVERN_FAULT_AT"
	faultArmEnv          = "GOTAVERN_FAULT_ARM"
	faultsBuildTag       = "gotavern_faults"
)

// faultBinary is built once per test run; the normal build never contains the crash hook. It lives in a
// process-lifetime directory rather than a t.TempDir(): the path is exported through GOTAVERN_BINARY, and
// a per-test directory would be removed while a LATER test still names it (measured: "GOTAVERN_BINARY
// points at ... which does not exist" in the next test).
var faultBinary string

func buildFaultBinary(t *testing.T) string {
	t.Helper()
	if faultBinary != "" {
		if _, err := os.Stat(faultBinary); err == nil {
			return faultBinary
		}
	}
	directory, err := os.MkdirTemp("", "gotavern-e2e-faults-")
	if err != nil {
		t.Fatalf("create the fault-binary directory: %v", err)
	}
	target := filepath.Join(directory, "gotavern-faults")
	if runtime.GOOS == "windows" {
		target += ".exe"
	}
	command := exec.Command("go", "build", "-trimpath", "-tags", faultsBuildTag, "-o", target, "./cmd/gotavern")
	command.Dir = moduleRoot(t)
	if output, buildErr := command.CombinedOutput(); buildErr != nil {
		t.Fatalf("build the %s binary: %v\n%s", faultsBuildTag, buildErr, output)
	}
	faultBinary = target
	return target
}

// crashTree is one isolated release-shaped tree for a crash case.
type crashTree struct {
	installRoot string
	dataRoot    string
	chatDir     string
	armPath     string
}

func newCrashTree(t *testing.T) *crashTree {
	t.Helper()
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatalf("resolve the default user's directories: %v", err)
	}
	chatDir := filepath.Join(directories["chats"], crashAvatar)
	if err := os.MkdirAll(chatDir, 0o777); err != nil {
		t.Fatalf("create the character chat directory: %v", err)
	}
	return &crashTree{
		installRoot: installRoot,
		dataRoot:    dataRoot,
		chatDir:     chatDir,
		armPath:     filepath.Join(installRoot, "fault-arm"),
	}
}

// crashClient is one booted server plus its browser-equivalent session.
type crashClient struct {
	server *serverProcess
	sess   *session
}

// boot boots the fault binary into the tree's install root. The arm file is always removed first: an
// armed hook would crash a startup atomic write, which is not the thing under test.
//
// The binary is selected through the PARENT environment (GOTAVERN_BINARY): bootServerIn's resolveBinary
// reads that variable in THIS process and copies the binary it names, so it must be set here rather than
// only in the child's environment. Measured: passing it as a child variable made every boot compile the
// production binary from this tree, and no injected label could ever fire.
func (tree *crashTree) boot(t *testing.T, faultLabel string, withFault bool) *crashClient {
	t.Helper()
	_ = os.Remove(tree.armPath)
	t.Setenv("GOTAVERN_BINARY", buildFaultBinary(t))
	environment := map[string]string{}
	if withFault {
		environment[faultAtEnv] = faultLabel
		environment[faultArmEnv] = tree.armPath
	}
	server := bootServerIn(t, tree.installRoot, tree.installRoot, tree.dataRoot, environment)
	return &crashClient{server: server, sess: openSession(t, server.origin)}
}

func (tree *crashTree) arm(t *testing.T) {
	t.Helper()
	if err := os.WriteFile(tree.armPath, []byte("armed"), 0o600); err != nil {
		t.Fatalf("arm the fault hook: %v", err)
	}
}

func (client *crashClient) post(route, body string) (int, string, error) {
	request, err := http.NewRequest(http.MethodPost, client.sess.origin+route, strings.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cookie", client.sess.cookie)
	request.Header.Set("X-CSRF-Token", client.sess.token)
	response, err := client.sess.client.Do(request)
	if err != nil {
		return 0, "", err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	return response.StatusCode, string(payload), err
}

func (client *crashClient) postMultipart(route, contentType, body string) (int, string, error) {
	request, err := http.NewRequest(http.MethodPost, client.sess.origin+route, strings.NewReader(body))
	if err != nil {
		return 0, "", err
	}
	request.Header.Set("Content-Type", contentType)
	request.Header.Set("Cookie", client.sess.cookie)
	request.Header.Set("X-CSRF-Token", client.sess.token)
	response, err := client.sess.client.Do(request)
	if err != nil {
		return 0, "", err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	return response.StatusCode, string(payload), err
}

// sendFunc fires the operation under test.
type sendFunc func(client *crashClient) (status int, response string, err error)

func jsonSender(route, body string) sendFunc {
	return func(client *crashClient) (int, string, error) { return client.post(route, body) }
}

func multipartSender(route, contentType, body string) sendFunc {
	return func(client *crashClient) (int, string, error) { return client.postMultipart(route, contentType, body) }
}

func hardKill(t *testing.T, server *serverProcess) {
	t.Helper()
	_ = server.command.Process.Kill()
	select {
	case <-server.exitCh:
	case <-time.After(30 * time.Second):
		t.Fatalf("the killed server did not exit within 30s\n%s", server.diagnostic())
	}
}

func waitForFaultExit(t *testing.T, client *crashClient, label string) {
	t.Helper()
	select {
	case <-client.server.exitCh:
	case <-time.After(30 * time.Second):
		t.Fatalf("the fault label %q never crashed the process, so the case would assert a state it never "+
			"reached; the label is not on the request's write path\n%s", label, client.server.diagnostic())
	}
}

// seed plants the test's BEFORE image: body nil removes the file (a chat that does not exist yet).
func (tree *crashTree) seed(t *testing.T, fileName string, body []byte) {
	t.Helper()
	target := filepath.Join(tree.chatDir, fileName)
	if body == nil {
		if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
			t.Fatalf("remove the seed %s: %v", target, err)
		}
		return
	}
	if err := os.WriteFile(target, body, 0o600); err != nil {
		t.Fatalf("seed %s: %v", target, err)
	}
}

// chatFiles reads the NON-DOT .jsonl files: scratch (`.gotavern-content-log-*.tmp`) is not a chat. Every
// chat file found must be non-empty and every line must parse; a zero-length or truncated file fails HERE,
// by name, rather than through a downstream comparison.
func (tree *crashTree) chatFiles(t *testing.T) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	entries, err := os.ReadDir(tree.chatDir)
	if os.IsNotExist(err) {
		return files
	}
	if err != nil {
		t.Fatalf("read the chat directory: %v", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(tree.chatDir, name))
		if err != nil {
			t.Fatalf("read chat file %s: %v", name, err)
		}
		if len(body) == 0 {
			t.Fatalf("chat file %s is ZERO BYTES after the crash: a reader would show an empty chat", name)
		}
		for index, line := range strings.Split(string(body), "\n") {
			if !json.Valid([]byte(line)) {
				t.Fatalf("chat file %s line %d is not valid JSON after the crash (%d bytes total): %q",
					name, index, len(body), truncateForCrash(line))
			}
		}
		files[name] = body
	}
	return files
}

// chatEntries is the PROGRESS poll: names and sizes only, no file contents. A poll runs while the server is
// still writing, and reading the contents of a file being renamed/deleted is a legitimate transient Windows
// sharing/not-found race in the TEST process (measured: "read chat file chat.jsonl: ... cannot find the file
// specified" / "Access is denied" while a rename or delete was in flight). Assertions about bytes are made
// only after the process is dead.
func (tree *crashTree) chatEntries(t *testing.T) map[string]int64 {
	t.Helper()
	entriesByName := map[string]int64{}
	entries, err := os.ReadDir(tree.chatDir)
	if err != nil {
		return entriesByName
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		if info, infoErr := entry.Info(); infoErr == nil {
			entriesByName[name] = info.Size()
		}
	}
	return entriesByName
}
func truncateForCrash(value string) string {
	if len(value) <= 160 {
		return value
	}
	return value[:160] + "..."
}

// state is one complete allowed filesystem state: file name -> exact bytes.
type state map[string][]byte

func requireOneOf(t *testing.T, tree *crashTree, allowed ...state) state {
	t.Helper()
	got := tree.chatFiles(t)
	for _, candidate := range allowed {
		if equalStates(got, candidate) {
			return got
		}
	}
	t.Fatalf("crash state is not one of the complete old/new states.\n  got:            %s\n  allowed:        %s",
		describeState(got), describeStates(allowed))
	return nil
}

func equalStates(left, right state) bool {
	if len(left) != len(right) {
		return false
	}
	for name, body := range left {
		other, ok := right[name]
		if !ok || !bytes.Equal(body, other) {
			return false
		}
	}
	return true
}

func describeState(value state) string {
	names := make([]string, 0, len(value))
	for name := range value {
		names = append(names, name)
	}
	sort.Strings(names)
	parts := make([]string, 0, len(names))
	for _, name := range names {
		parts = append(parts, fmt.Sprintf("%s(%d bytes)", name, len(value[name])))
	}
	if len(parts) == 0 {
		return "<no chat files>"
	}
	return strings.Join(parts, ", ")
}

func describeStates(states []state) string {
	parts := make([]string, 0, len(states))
	for _, candidate := range states {
		parts = append(parts, "{"+describeState(candidate)+"}")
	}
	return strings.Join(parts, " or ")
}

// restartAndCheck boots a NORMAL server on the crashed tree: the startup must not change the crashed chat
// state, must not panic, and GET /api/chats/get must answer a parseable array for the file (when named).
func (tree *crashTree) restartAndCheck(t *testing.T, expected state, getFileName string) {
	t.Helper()
	client := tree.boot(t, "", false)
	stderr := client.server.stderr.String()
	if strings.Contains(stderr, "panic") {
		t.Fatalf("the restarted server panicked after the crash:\n%s", client.server.diagnostic())
	}
	after := tree.chatFiles(t)
	if !equalStates(after, expected) {
		t.Fatalf("the restart CHANGED the crashed chat state.\n  before boot: %s\n  after boot:  %s",
			describeState(expected), describeState(after))
	}
	if getFileName == "" {
		return
	}
	body, err := json.Marshal(map[string]any{"avatar_url": crashAvatar + ".png", "file_name": getFileName})
	if err != nil {
		t.Fatal(err)
	}
	status, _, response, err := client.postTolerant("/api/chats/get", string(body))
	if err != nil || status != http.StatusOK {
		t.Fatalf("GET /api/chats/get after the restart = %d (%v), want 200: %s", status, err, response)
	}
	var decoded []json.RawMessage
	if err := json.Unmarshal([]byte(response), &decoded); err != nil {
		t.Fatalf("GET /api/chats/get after the restart is not a JSON chat array: %q", truncateForCrash(response))
	}
}

func (client *crashClient) postTolerant(route, body string) (int, string, string, error) {
	request, err := http.NewRequest(http.MethodPost, client.sess.origin+route, strings.NewReader(body))
	if err != nil {
		return 0, "", "", err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Cookie", client.sess.cookie)
	request.Header.Set("X-CSRF-Token", client.sess.token)
	response, err := client.sess.client.Do(request)
	if err != nil {
		return 0, "", "", err
	}
	defer response.Body.Close()
	payload, err := io.ReadAll(response.Body)
	return response.StatusCode, string(payload), string(payload), err
}

// crashRand is the documented seeded generator for the randomised kills.
func crashRand(iteration int) *rand.Rand {
	return rand.New(rand.NewSource(crashSeed + int64(iteration)))
}

// writeInFlight reports whether a write is visibly in flight: an atomic scratch file exists, or the
// named chat file's size changed (the cases that replace an existing file).
func (tree *crashTree) writeInFlight(t *testing.T, existingFile string, existingSize int) bool {
	t.Helper()
	entries, err := os.ReadDir(tree.chatDir)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".gotavern-content-log-") {
			return true
		}
		if existingFile != "" && name == existingFile {
			if info, statErr := entry.Info(); statErr == nil && int(info.Size()) != existingSize {
				return true
			}
		}
	}
	return false
}

// chatPayload encodes the messages the way /api/chats/save does: one JSON.stringify per line, joined by
// '\n'. Encoding the expectation with the same rule the server uses is the only expectation a crash test
// can have without duplicating the serialiser.
func chatPayload(t *testing.T, messages []map[string]any) []byte {
	t.Helper()
	lines := make([]string, 0, len(messages))
	for _, message := range messages {
		encoded, err := json.Marshal(message)
		if err != nil {
			t.Fatalf("encode a chat message: %v", err)
		}
		lines = append(lines, string(encoded))
	}
	return []byte(strings.Join(lines, "\n"))
}

func saveBody(t *testing.T, fileName string, messages []map[string]any, force ...bool) string {
	t.Helper()
	payload := map[string]any{
		"avatar_url": crashAvatar + ".png",
		"file_name":  fileName,
		"chat":       messages,
	}
	// A scenario that deliberately replaces chat_metadata.integrity must take the
	// pinned FORCED overwrite path; without force pinned answers 400 {"error":"integrity"}
	// (src/endpoints/chats.js:532-543, alpha.20 audit A20-D).
	if len(force) > 0 && force[0] {
		payload["force"] = true
	}
	encoded, err := json.Marshal(payload)
	if err != nil {
		t.Fatalf("encode the save body: %v", err)
	}
	return string(encoded)
}

// importBody builds the multipart /api/chats/import request.
func importBody(t *testing.T, jsonl []byte) (body string, contentType string) {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for _, field := range []struct{ name, value string }{
		{"avatar_url", crashAvatar + ".png"},
		{"character_name", crashAvatar},
		{"user_name", "User"},
		{"file_type", "jsonl"},
	} {
		if err := writer.WriteField(field.name, field.value); err != nil {
			t.Fatalf("write import field %s: %v", field.name, err)
		}
	}
	part, err := writer.CreateFormFile("avatar", "import.jsonl")
	if err != nil {
		t.Fatalf("create the import file part: %v", err)
	}
	if _, err := part.Write(jsonl); err != nil {
		t.Fatalf("write the import payload: %v", err)
	}
	if err := writer.Close(); err != nil {
		t.Fatalf("close the import multipart: %v", err)
	}
	return buffer.String(), writer.FormDataContentType()
}

// resetTo makes the chat directory exactly the given state: every non-dot .jsonl is removed and the state's
// files are written. This is the test's BEFORE image, so the crash cannot land in the seeding step.
func (tree *crashTree) resetTo(t *testing.T, target state) {
	t.Helper()
	entries, err := os.ReadDir(tree.chatDir)
	if err != nil && !os.IsNotExist(err) {
		t.Fatalf("read the chat directory for a reset: %v", err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		if err := os.Remove(filepath.Join(tree.chatDir, name)); err != nil {
			t.Fatalf("reset the chat directory: %v", err)
		}
	}
	for name, body := range target {
		if err := os.WriteFile(filepath.Join(tree.chatDir, name), body, 0o600); err != nil {
			t.Fatalf("write the pre-state %s: %v", name, err)
		}
	}
}
