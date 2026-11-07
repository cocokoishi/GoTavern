package e2e

// SHARED SUPPORT FOR THE ALPHA.17 NICHE SUITES (niche_fs/data/http/streaming/persistence/teeth).
//
// WHY THESE HELPERS EXIST. The existing harness (harness_test.go) gives a booted production binary, a
// browser-equivalent session and the recorded chat/settings write paths, and the A15 suites give the crash
// seams. What the niche suites additionally need is a BOOT THE CASE CAN SEED BEFORE STARTUP (a disk asset
// under installRoot/public, a settings.json planted before the boot) and a set of COMPARATORS THAT RETURN
// NAMED ERRORS instead of calling t.Fatalf, because every positive assertion must also be plantable as a
// NEGATIVE CONTROL in niche_teeth_test.go through the SAME function (differential doctrine rule 4:
// "every gate has teeth, and the teeth are demonstrated").
//
// The comparators never call t. The positive tests fail with t.Fatalf("%v", err); the teeth test calls the
// same function with a planted defect and asserts the returned error names the assertion. That structural
// coupling is the point: a second private comparator in the teeth file would prove nothing about the gate
// the live tests use.
//
// The NAMED prefixes are the assertion names quoted in docs/alpha17/new-test-evidence.md.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// ---------------------------------------------------------------------------------------------------
// TREE AND BOOT

// nicheTree is one release-shaped install root whose data root and user root are known to the test, so a
// case can seed bytes BEFORE the boot and inspect them after it. The plain harness deliberately hides the
// data root (the boot's resolution is a thing some tests assert); these suites need it named outright.
type nicheTree struct {
	installRoot string
	dataRoot    string
	userRoot    string
}

func newNicheTree(t *testing.T) *nicheTree {
	t.Helper()
	installRoot := t.TempDir()
	tree := &nicheTree{
		installRoot: installRoot,
		dataRoot:    filepath.Join(installRoot, "data"),
		userRoot:    filepath.Join(installRoot, "data", "default-user"),
	}
	if err := os.MkdirAll(tree.userRoot, 0o777); err != nil {
		t.Fatalf("create the default user root: %v", err)
	}
	return tree
}

// boot boots the REAL binary into the tree's install root and opens a session. extraEnvironment is passed
// to the child; nil is the normal production boot.
func (tree *nicheTree) boot(t *testing.T, extraEnvironment map[string]string) *nicheBoot {
	t.Helper()
	server := bootServerIn(t, tree.installRoot, tree.installRoot, tree.dataRoot, extraEnvironment)
	return &nicheBoot{tree: tree, server: server, client: openSession(t, server.origin)}
}

// restart stops nothing explicitly -- bootServerIn registers its own cleanup -- and boots a SECOND process
// on the same data root, which is the restart these cases assert against.
func (tree *nicheTree) restart(t *testing.T) *nicheBoot {
	t.Helper()
	return tree.boot(t, nil)
}

type nicheBoot struct {
	tree   *nicheTree
	server *serverProcess
	client *session
}

// chatDir is the per-card chat directory the product would create for avatarURL (sans .png).
func (tree *nicheTree) chatDir(avatar string) string {
	return filepath.Join(tree.dataRoot, "default-user", "chats", strings.TrimSuffix(avatar, ".png"))
}

func (tree *nicheTree) settingsPath() string {
	return filepath.Join(tree.dataRoot, "default-user", "settings.json")
}

// ---------------------------------------------------------------------------------------------------
// PRODUCT WRITES AND READS (all through the routes the frontend uses)

// nicheSaveChat submits a chat through POST /api/chats/save and returns the status and body.
func nicheSaveChat(t *testing.T, client *session, avatarURL, fileName string, messages []map[string]any) (int, string) {
	t.Helper()
	body, err := marshalJSON(map[string]any{
		"avatar_url": avatarURL,
		"file_name":  fileName,
		"chat":       messages,
	})
	if err != nil {
		t.Fatalf("encode the chat save body: %v", err)
	}
	status, _, response := client.postJSON(t, "/api/chats/save", body)
	return status, response
}

// nicheGetChat submits POST /api/chats/get and returns the status and body.
func nicheGetChat(t *testing.T, client *session, avatarURL, fileName string) (int, string) {
	t.Helper()
	body, err := marshalJSON(map[string]any{"avatar_url": avatarURL, "file_name": fileName})
	if err != nil {
		t.Fatalf("encode the chat get body: %v", err)
	}
	status, _, response := client.postJSON(t, "/api/chats/get", body)
	return status, response
}

// nicheSaveSettings submits a raw document through POST /api/settings/save.
func nicheSaveSettings(t *testing.T, client *session, document string) (int, string) {
	t.Helper()
	status, _, body := client.postJSON(t, "/api/settings/save", document)
	return status, body
}

// nicheSettingsDocument reads the on-disk settings.json, which is the product's own normalisation of the
// last save (every save goes through atomicReplace, so this is exactly what a later boot reads).
func nicheSettingsDocument(t *testing.T, tree *nicheTree) string {
	t.Helper()
	body, err := os.ReadFile(tree.settingsPath())
	if err != nil {
		t.Fatalf("read settings.json: %v", err)
	}
	return string(body)
}

// nicheSettingsServed asks /api/settings/get and returns the `settings` string member. The route wraps the
// raw file text in a JSON envelope, so decoding is the only way to compare the document the product serves.
func nicheSettingsServed(t *testing.T, client *session) string {
	t.Helper()
	status, _, body := client.postJSON(t, "/api/settings/get", "{}")
	if err := nicheCheckStatus("settings/get", status, 200); err != nil {
		t.Fatalf("%v: %s", err, truncateForLog(body, 300))
	}
	served, err := decodeSettingsEnvelope(body)
	if err != nil {
		t.Fatalf("settings/get body is not the pinned envelope: %v (%s)", err, truncateForLog(body, 300))
	}
	return served
}

func decodeSettingsEnvelope(body string) (string, error) {
	var envelope struct {
		Settings json.RawMessage `json:"settings"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		return "", err
	}
	var served string
	if err := json.Unmarshal(envelope.Settings, &served); err != nil {
		return "", err
	}
	return served, nil
}

// nicheChatLines reads a chat file's NON-EMPTY lines. The product's chat writer joins one JSON object per
// line with '\n', so these are the exact bytes a later /api/chats/get returns as array elements.
func nicheChatLines(t *testing.T, path string) []string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read the chat file %s: %v", path, err)
	}
	raw := strings.Split(string(body), "\n")
	lines := make([]string, 0, len(raw))
	for _, line := range raw {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

// nicheExpectedChatBody is the array body /api/chats/get answers for a chat file whose product-written
// lines are `lines`. Building the expectation from the FILE the product wrote -- rather than from a second
// JSON serializer in the test -- keeps a serialiser difference from being reported as a read-back defect.
func nicheExpectedChatBody(lines []string) string {
	return "[" + strings.Join(lines, ",") + "]"
}

// nicheRequireNoPanic fails when the child printed a panic. A panic on a probe route would otherwise look
// like an unrelated status mismatch.
func nicheRequireNoPanic(t *testing.T, where string, server *serverProcess) {
	t.Helper()
	if strings.Contains(server.stderr.String(), "panic") {
		t.Fatalf("%s: the child panicked:\n%s", where, server.diagnostic())
	}
}

// nicheWriteFile writes bytes to an absolute path, creating parents.
func nicheWriteFile(t *testing.T, path string, body []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		t.Fatalf("create %s: %v", filepath.Dir(path), err)
	}
	if err := os.WriteFile(path, body, 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// nicheWaitUntil polls a predicate to a hard deadline. Readiness and cancellation are polled, never slept
// on (rule 33); the predicate supplies the success condition and the failure names the condition, not a
// timeout.
func nicheWaitUntil(timeout time.Duration, predicate func() bool) bool {
	deadline := time.Now().Add(timeout)
	for {
		if predicate() {
			return true
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// ---------------------------------------------------------------------------------------------------
// NAMED COMPARATORS. Every function below is used by at least one positive niche test AND by a planted
// defect in niche_teeth_test.go. They return an error whose text starts with a stable assertion name.

// nicheCheckStatus is "status-mismatch:".
func nicheCheckStatus(label string, got, want int) error {
	if got != want {
		return fmt.Errorf("status-mismatch: %s: got %d, want %d", label, got, want)
	}
	return nil
}

// nicheCheckHeader is "header-mismatch:".
func nicheCheckHeader(label, name, got, want string) error {
	if got != want {
		return fmt.Errorf("header-mismatch: %s: %s = %q, want %q", label, name, got, want)
	}
	return nil
}

// nicheCheckHeaderAbsent is "header-unexpected:".
func nicheCheckHeaderAbsent(label, name, got string) error {
	if got != "" {
		return fmt.Errorf("header-unexpected: %s: %s = %q, want the header absent", label, name, got)
	}
	return nil
}

// nicheCheckBody is "body-mismatch:".
func nicheCheckBody(label, got, want string) error {
	if got != want {
		return fmt.Errorf("body-mismatch: %s: got %d bytes %q, want %d bytes %q",
			label, len(got), truncateForLog(got, 200), len(want), truncateForLog(want, 200))
	}
	return nil
}

// nicheCheckContains is "content-missing:".
func nicheCheckContains(label, got, want string) error {
	if !strings.Contains(got, want) {
		return fmt.Errorf("content-missing: %s: %q is not contained in %q", label, want, truncateForLog(got, 240))
	}
	return nil
}

// nicheCheckNotContains is "content-unexpected:".
func nicheCheckNotContains(label, got, unwanted string) error {
	if strings.Contains(got, unwanted) {
		return fmt.Errorf("content-unexpected: %s: %q is unexpectedly contained in %q", label, unwanted, truncateForLog(got, 240))
	}
	return nil
}

// nicheCheckOrderedChat is "message-order-swapped:" / "message-dropped:" / "message-extra:". It is the
// order-sensitive comparator the chat read-back uses: an array comparison built on sets would hide a
// reordered chat, which is the user-visible defect the maintenance ordering produces.
func nicheCheckOrderedChat(label string, got, want []string) error {
	for index := 0; index < len(got) && index < len(want); index++ {
		if got[index] != want[index] {
			if nicheContainsString(want, got[index]) {
				return fmt.Errorf("message-order-swapped: %s: position %d holds %q, want %q",
					label, index, scrubForLog(got[index]), scrubForLog(want[index]))
			}
			return fmt.Errorf("message-dropped: %s: position %d holds %q, want %q",
				label, index, scrubForLog(got[index]), scrubForLog(want[index]))
		}
	}
	if len(got) < len(want) {
		return fmt.Errorf("message-dropped: %s: got %d messages, want %d", label, len(got), len(want))
	}
	if len(got) > len(want) {
		return fmt.Errorf("message-extra: %s: got %d messages, want %d", label, len(got), len(want))
	}
	return nil
}

func nicheContainsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// nicheCheckMember is "member-mismatch:": one top-level member's raw JSON must equal wantJSON, both
// compacted. Used for settings round-trip members (null/false/0/""/[]).
func nicheCheckMember(label, document, member, wantJSON string) error {
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal([]byte(document), &decoded); err != nil {
		return fmt.Errorf("member-mismatch: %s: document is not JSON: %v", label, err)
	}
	raw, present := decoded[member]
	if !present {
		return fmt.Errorf("member-mismatch: %s: member %q is MISSING from the served document", label, member)
	}
	got, err := compactJSONString(string(raw))
	if err != nil {
		return fmt.Errorf("member-mismatch: %s: member %q is not JSON: %v", label, member, err)
	}
	want, err := compactJSONString(wantJSON)
	if err != nil {
		return fmt.Errorf("member-mismatch: %s: the expected value %q is not JSON: %v", label, wantJSON, err)
	}
	if got != want {
		return fmt.Errorf("member-mismatch: %s: member %q = %s, want %s", label, member, got, want)
	}
	return nil
}

func compactJSONString(text string) (string, error) {
	var buffer bytes.Buffer
	if err := json.Compact(&buffer, []byte(text)); err != nil {
		return "", err
	}
	return buffer.String(), nil
}

// nicheCheckJSONLLines is "jsonl-invalid:line-N": every non-empty line of a chat file must be a complete
// JSON value. A truncated final line is caught here by name instead of by a later array mismatch.
func nicheCheckJSONLLines(label string, body []byte) error {
	for index, line := range strings.Split(string(body), "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if !json.Valid([]byte(line)) {
			return fmt.Errorf("jsonl-invalid:line-%d: %s: %q", index+1, label, scrubForLog(line))
		}
	}
	return nil
}

// nicheCheckStreamBytes is "stream-truncated:" or "stream-frame-mismatch:". Upstream chunk boundaries must
// be transparent: the bytes the mock provider wrote are the bytes the route must deliver.
func nicheCheckStreamBytes(label, got, want string) error {
	switch {
	case got == want:
		return nil
	case strings.HasPrefix(want, got):
		return fmt.Errorf("stream-truncated: %s: the route delivered %d of %d bytes (tail %q)",
			label, len(got), len(want), truncateForLog(got, 120))
	case strings.HasPrefix(got, want):
		return fmt.Errorf("stream-frame-mismatch: %s: the route delivered %d bytes after the expected end of %d (tail %q)",
			label, len(want), len(got), truncateForLog(got[len(want):], 120))
	default:
		return fmt.Errorf("stream-frame-mismatch: %s: the delivered bytes diverge from the provider's bytes (got %q, want %q)",
			label, truncateForLog(got, 120), truncateForLog(want, 120))
	}
}

// nicheCheckCancelPropagation is "cancel-not-propagated:". pinned's contract is that a browser disconnect
// aborts the upstream request; the recording peer observes the abort as ClientDisconnected.
func nicheCheckCancelPropagation(label string, recorded []string, want bool) error {
	disconnected := false
	for _, flag := range recorded {
		if flag == "disconnected" {
			disconnected = true
		}
	}
	if disconnected != want {
		return fmt.Errorf("cancel-not-propagated: %s: the peer observed ClientDisconnected=%v, want %v (%d recorded request(s))",
			label, disconnected, want, len(recorded))
	}
	return nil
}

// nicheCheckSettingsValue is "settings-value-mismatch:": a marker in the served settings document.
func nicheCheckSettingsValue(label, document, member, want string) error {
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal([]byte(document), &decoded); err != nil {
		return fmt.Errorf("settings-value-mismatch: %s: served settings are not JSON: %v", label, err)
	}
	raw, present := decoded[member]
	if !present {
		return fmt.Errorf("settings-value-mismatch: %s: member %q is missing", label, member)
	}
	var got string
	if err := json.Unmarshal(raw, &got); err != nil {
		return fmt.Errorf("settings-value-mismatch: %s: member %q is not a string: %v", label, member, err)
	}
	if got != want {
		return fmt.Errorf("settings-value-mismatch: %s: member %q = %q, want %q", label, member, got, want)
	}
	return nil
}

// nicheCheckCacheIdentity is "cache-identity-mismatch:". The settings aggregation is memoised by
// path+mtime+size; this comparator states which side of the documented residual an observation is on.
func nicheCheckCacheIdentity(label string, staleServed, wantStale bool) error {
	if staleServed != wantStale {
		if wantStale {
			return fmt.Errorf("cache-identity-mismatch: %s: the cache did NOT serve the previous body for an unchanged path+mtime+size identity; the documented residual no longer holds", label)
		}
		return fmt.Errorf("cache-identity-mismatch: %s: the cache served a STALE body although the file's identity changed; an external edit was hidden", label)
	}
	return nil
}

// nicheCheckCrashState is "crash-state-partial:": after a killed write the file must be exactly the old
// document or exactly the new one, never a prefix or an interleaving.
func nicheCheckCrashState(label string, got, oldDocument, newDocument []byte) error {
	if bytes.Equal(got, oldDocument) {
		return nil
	}
	if bytes.Equal(got, newDocument) {
		return nil
	}
	return fmt.Errorf("crash-state-partial: %s: the file is neither the complete old (%d bytes) nor the complete new (%d bytes) document; it is %d bytes: %q",
		label, len(oldDocument), len(newDocument), len(got), truncateForLog(string(got), 200))
}

// nicheCheckFilenameContained is "unsafe-filename:": a name the product derived from user input must not
// carry a path separator, must not be a bare traversal component, and must fit one path component.
func nicheCheckFilenameContained(label, derived, root string) error {
	if derived == "" {
		return fmt.Errorf("unsafe-filename: %s: the derived name is empty", label)
	}
	if strings.ContainsAny(derived, `/\`) {
		return fmt.Errorf("unsafe-filename: %s: the derived name %q contains a path separator", label, derived)
	}
	if derived == "." || derived == ".." {
		return fmt.Errorf("unsafe-filename: %s: the derived name is the traversal component %q", label, derived)
	}
	if len(derived) > 255 {
		return fmt.Errorf("unsafe-filename: %s: the derived name is %d bytes, more than one path component (255)", label, len(derived))
	}
	full := filepath.Join(root, derived)
	within, err := filepath.Rel(root, full)
	if err != nil || within == ".." || strings.HasPrefix(within, ".."+string(filepath.Separator)) {
		return fmt.Errorf("unsafe-filename: %s: the derived path %q escapes %q", label, full, root)
	}
	return nil
}

// nicheCheckGoroutines is "goroutine-leak:". Scope note: the server is a SUBPROCESS, so this can only
// speak about the test process's own goroutines (the HTTP clients and transports the cases use). A server
// goroutine leak is covered separately by the liveness assertion after a cancel, and the scope is recorded
// in the evidence document rather than overstated here.
func nicheCheckGoroutines(label string, before, after, allowance int) error {
	if after > before+allowance {
		return fmt.Errorf("goroutine-leak: %s: %d goroutines before, %d after (allowance %d)", label, before, after, allowance)
	}
	return nil
}

// nicheCheckFilePresence is "file-missing:" / "file-unexpected:".
func nicheCheckFilePresence(label, path string, wantPresent bool) error {
	_, err := os.Stat(path)
	present := err == nil
	if present != wantPresent {
		if wantPresent {
			return fmt.Errorf("file-missing: %s: %s does not exist (%v)", label, path, err)
		}
		return fmt.Errorf("file-unexpected: %s: %s exists and should not", label, path)
	}
	return nil
}

// nicheScratchFiles lists dot-prefixed atomic-write scratch files in a directory. Their NAME is the
// contract that keeps a partial write out of the user's file list (a15_settings_crash_test.go).
func nicheScratchFiles(t *testing.T, directory string) []string {
	t.Helper()
	names := []string{}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return names
	}
	for _, entry := range entries {
		if !entry.IsDir() && strings.HasPrefix(entry.Name(), settingsScratchPrefix) {
			names = append(names, entry.Name())
		}
	}
	return names
}

// scrubForLog quotes a length of user-visible text without letting a control character break the log.
func scrubForLog(value string) string {
	return strings.ReplaceAll(strings.ReplaceAll(value, "\r", "\\r"), "\n", "\\n")
}

// nicheHostIsWindows is used by the tests whose semantics genuinely differ per host, so the skip is
// explicit in the evidence document instead of implied by an OS check buried in an assertion.
func nicheHostIsWindows() bool { return runtime.GOOS == "windows" }
