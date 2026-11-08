package server

// Tests for the pinned chat auto-backup scheduler (chat_backup.go).
//
// The oracle for the filename KEY is not hand-derived. The rows below were produced
// by IMPORTING PINNED'S OWN EXPORT under node:
//
//	process.chdir(pinned); util.setConfigFilePath(pinned + '/default/config.yaml');
//	const { getBackupKey } = await import(pinned + '/src/endpoints/chats.js');
//
// with the pinned node_modules (sanitize-filename 1.6.3 + node:crypto) — the real
// function, not a transcription — over a name matrix: ASCII, spaces, '/' and '\\',
// Windows-reserved names, dots, trailing spaces, control characters, C1 controls,
// CJK, emoji, and the 255-byte truncation boundary. The generated rows were diffed
// byte-for-byte against the table below.
//
// The throttle tests use a fake clock, so the leading/trailing edges are exact and
// nothing sleeps a real interval. The HTTP-level tests drive the real
// /api/chats/save route through the real handler.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	chatBackupTestCookieSecret = "chat-backup-test-cookie-secret"
	chatBackupTestCard         = "Alice"
	chatBackupTestChatHeader   = `{"user_name":"User","character_name":"Alice","chat_metadata":{}}`
)

// chatBackupTestChatRequest is the JSON array the route receives; the product
// re-serializes each element and joins with '\n'.
func chatBackupTestChatRequest(mes string) string {
	return "[" + chatBackupTestChatHeader + `,{"name":"Alice","mes":"` + mes + `"}]`
}

// chatBackupTestChatBody is the exact jsonl the product writes for that request.
func chatBackupTestChatBody(mes string) string {
	return chatBackupTestChatHeader + "\n" + `{"name":"Alice","mes":"` + mes + `"}`
}

// ---------------------------------------------------------------------------
// Pinned oracle: getBackupKey
// ---------------------------------------------------------------------------

func TestChatBackupKeyMatchesPinnedOracle(t *testing.T) {
	// Every row was produced by the pinned function, not derived from it.
	cases := []struct{ name, want string }{
		{name: "Alice", want: "alice"},
		{name: "Alice Bob", want: "alice_bob"},
		{name: "a/b", want: "ab"},
		{name: "a\\b", want: "ab"},
		{name: "C:\\path\\to\\chat", want: "cpathtochat"},
		{name: "what?", want: "what"},
		{name: "<tag>|pipe\"quote*star:colon", want: "tagpipequotestarcolon"},
		{name: "  leading and trailing  ", want: "__leading_and_trailing"},
		{name: "trailing dots...", want: "trailing_dots"},
		{name: "trailing space ", want: "trailing_space"},
		{name: "...", want: ""},
		{name: "..", want: ""},
		{name: ".", want: ""},
		{name: "CON", want: ""},
		{name: "con.txt", want: ""},
		{name: "NUL", want: ""},
		{name: "COM1", want: ""},
		{name: "COM10", want: "com10"},
		{name: "COM9.backup", want: ""},
		{name: "LPT9", want: ""},
		{name: "chat.name.v2", want: "chat_name_v2"},
		{name: "UPPER lower 123", want: "upper_lower_123"},
		{name: "space  double", want: "space__double"},
		{name: "tab\there", want: "tabhere_5b876593"},
		{name: "newline\nhere", want: "newlinehere_693682f0"},
		{name: "control\x01\x02char", want: "controlchar_88b9fb05"},
		{name: "del\x7fchar", want: "del_char_b163086e"},
		{name: "\u00e9", want: "__4a99557e"},
		{name: "caf\u00e9", want: "caf__850f7dc4"},
		{name: "\u4f60\u597d", want: "___670d9743"},
		{name: "\u4f60\u597d world", want: "___world_6aad0e1d"},
		{name: "\u3053\u3093\u306b\u3061\u306f", want: "______125aeadf"},
		{name: "\U0001f600 emoji", want: "___emoji_c5db20e6"},
		{name: "\U0001f44d\U0001f3fb thumb", want: "_____thumb_8360cb5b"},
		{name: "\u00e9\u00e8\u00ea", want: "____33b8ed09"},
		{name: "\u4f60/aka/\U0001f600", want: "_aka___9b4554ff"},
		{name: "mixed \u4f60 name.with dots ", want: "mixed___name_with_dots_23a323c2"},
		{name: "", want: ""},
		{name: "a", want: "a"},
		{name: "Z", want: "z"},
		{name: "quote\u2019s", want: "quote_s_1585dd83"},
		{name: "fullwidth\uff0fslash", want: "fullwidth_slash_0ac4847d"},
		{name: "\u00a0nbsp", want: "_nbsp_65706092"},
		{name: "line\u2028separator", want: "line_separator_bb98a49c"},
		{name: "control\u0080\u009fchar", want: "controlchar_67731201"},
	}
	for _, testCase := range cases {
		if got := chatBackupKey(testCase.name); got != testCase.want {
			t.Errorf("chatBackupKey(%q) = %q; pinned Node getBackupKey = %q", testCase.name, got, testCase.want)
		}
	}
}

func TestChatBackupKeyTruncatesAtThePinnedByteBoundary(t *testing.T) {
	// Oracle rows for the two length edges. 300 ASCII bytes truncate to 255; 120 CJK
	// code points (360 bytes) truncate to 85 code points (255 bytes, the pinned
	// truncate-utf8-bytes equality case).
	ascii := chatBackupKey(strings.Repeat("x", 300))
	if ascii != strings.Repeat("x", 255) {
		t.Fatalf("300 ASCII bytes -> key length %d; pinned Node truncates to 255", len(ascii))
	}
	cjk := chatBackupKey(strings.Repeat("\u4f60", 120))
	const want = "______________________________________________________________________________________a895aa8d"
	if cjk != want {
		t.Fatalf("120 CJK code points -> %q; pinned Node = %q", cjk, want)
	}
	if len(strings.TrimSuffix(cjk, "_a895aa8d")) != 85 {
		t.Fatalf("CJK key body = %d code points; pinned truncate-utf8-bytes keeps 85 (255 bytes)", len(strings.TrimSuffix(cjk, "_a895aa8d")))
	}
}

// ---------------------------------------------------------------------------
// Fake clock and manager-level throttle tests
// ---------------------------------------------------------------------------

type chatBackupTestClock struct {
	mu     sync.Mutex
	now    time.Time
	timers []*chatBackupTestTimer
}

type chatBackupTestTimer struct {
	clock    *chatBackupTestClock
	at       time.Time
	callback func()
	stopped  bool
	fired    bool
}

func newChatBackupTestClock() *chatBackupTestClock {
	return &chatBackupTestClock{now: time.Date(2026, 1, 2, 3, 4, 5, 0, time.Local)}
}

func (clock *chatBackupTestClock) Now() time.Time {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	return clock.now
}

func (clock *chatBackupTestClock) AfterFunc(duration time.Duration, callback func()) chatBackupTimer {
	clock.mu.Lock()
	defer clock.mu.Unlock()
	timer := &chatBackupTestTimer{clock: clock, at: clock.now.Add(duration), callback: callback}
	clock.timers = append(clock.timers, timer)
	return timer
}

func (timer *chatBackupTestTimer) Stop() bool {
	clock := timer.clock
	clock.mu.Lock()
	defer clock.mu.Unlock()
	if timer.stopped || timer.fired {
		return false
	}
	timer.stopped = true
	return true
}

// Advance moves the fake clock and fires every timer that becomes due, in due order,
// OUTSIDE the clock lock because a callback re-enters the manager (and the manager's
// callback reads the clock).
func (clock *chatBackupTestClock) Advance(duration time.Duration) {
	clock.mu.Lock()
	clock.now = clock.now.Add(duration)
	due := make([]*chatBackupTestTimer, 0, 2)
	for {
		var next *chatBackupTestTimer
		for _, timer := range clock.timers {
			if timer.stopped || timer.fired || timer.at.After(clock.now) {
				continue
			}
			if next == nil || timer.at.Before(next.at) {
				next = timer
			}
		}
		if next == nil {
			break
		}
		next.fired = true
		due = append(due, next)
	}
	clock.mu.Unlock()
	for _, timer := range due {
		timer.callback()
	}
}

func newChatBackupTestManager(t *testing.T, settings chatBackupSettings) (*chatBackupManager, *chatBackupTestClock, string) {
	t.Helper()
	manager := newChatBackupManager(settings)
	clock := newChatBackupTestClock()
	manager.clock = clock
	directory := t.TempDir()
	t.Cleanup(FlushChatBackups)
	return manager, clock, directory
}

func defaultChatBackupTestSettings() chatBackupSettings {
	return chatBackupSettings{
		enabled:          true,
		maxTotalBackups:  -1,
		throttleInterval: 10 * time.Second,
		numberOfBackups:  50,
	}
}

func chatBackupTestFiles(t *testing.T, directory string) []string {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read backups directory %s: %v", directory, err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	return names
}

func TestChatBackupThrottleLeadingTrailingAndLatestData(t *testing.T) {
	manager, clock, directory := newChatBackupTestManager(t, defaultChatBackupTestSettings())

	manager.record("default-user", "Alice", directory, "data-1")
	files := chatBackupTestFiles(t, directory)
	if len(files) != 1 {
		t.Fatalf("first save wrote %d backups (%v); pinned's leading edge writes exactly 1", len(files), files)
	}
	if body, err := os.ReadFile(filepath.Join(directory, files[0])); err != nil || string(body) != "data-1" {
		t.Fatalf("leading backup body = %q (%v); want the bytes of the first save", body, err)
	}

	// Two more saves inside the window collapse into one pending trailing edge.
	clock.Advance(2 * time.Second)
	manager.record("default-user", "Alice", directory, "data-2")
	clock.Advance(2 * time.Second)
	manager.record("default-user", "Alice", directory, "data-3")
	if files := chatBackupTestFiles(t, directory); len(files) != 1 {
		t.Fatalf("saves inside the throttle window wrote %d backups (%v); pinned collapses them", len(files), files)
	}

	// The window opened by the leading edge closes 10s after it, carrying data-3.
	clock.Advance(6 * time.Second)
	files = chatBackupTestFiles(t, directory)
	if len(files) != 2 {
		t.Fatalf("after the window closed there are %d backups (%v); pinned writes ONE trailing backup", len(files), files)
	}
	latest, err := os.ReadFile(filepath.Join(directory, files[len(files)-1]))
	if err != nil {
		t.Fatal(err)
	}
	if string(latest) != "data-3" {
		t.Fatalf("trailing backup body = %q; pinned's throttle invokes with the LATEST arguments (data-3)", latest)
	}

	// A save at/after the window's close opens a NEW leading edge: the trailing
	// invocation at t0+10 is the last actual invocation, so t0+20 is outside it.
	clock.Advance(10 * time.Second)
	manager.record("default-user", "Alice", directory, "data-4")
	if files := chatBackupTestFiles(t, directory); len(files) != 3 {
		t.Fatalf("a save after the window wrote %d backups (%v); pinned's leading edge writes immediately", len(files), files)
	}
}

func TestChatBackupThrottleIsPerHandleAndCard(t *testing.T) {
	manager, _, directoryA := newChatBackupTestManager(t, defaultChatBackupTestSettings())
	directoryB := t.TempDir()

	// Each user's backups directory is a different directory in production, so the
	// same chat NAME may produce the same filename for both users; what must differ
	// is the throttle state.
	manager.record("user-a", "Alice", directoryA, "a-alice")
	manager.record("user-b", "Alice", directoryB, "b-alice")
	manager.record("user-a", "Bob", directoryA, "a-bob")

	if files := chatBackupTestFiles(t, directoryA); len(files) != 2 {
		t.Fatalf("user-a has %d backups (%v); its two chats are independent keys", len(files), files)
	}
	if files := chatBackupTestFiles(t, directoryB); len(files) != 1 {
		t.Fatalf("user-b has %d backups (%v); the same chat name for another handle is an independent key", len(files), files)
	}
	// A second save for one key must not be swallowed by, or swallow, another key's
	// window.
	manager.record("user-a", "Alice", directoryA, "a-alice-2")
	if files := chatBackupTestFiles(t, directoryA); len(files) != 2 {
		t.Fatalf("a rapid save on one key wrote a backup (%v); the key's own window is still open", files)
	}
	if files := chatBackupTestFiles(t, directoryB); len(files) != 1 {
		t.Fatalf("user-b's independent window changed (%v)", files)
	}
}

func TestChatBackupFlushWritesThePendingTrailingEdgeOnce(t *testing.T) {
	manager, clock, directory := newChatBackupTestManager(t, defaultChatBackupTestSettings())
	manager.record("default-user", "Alice", directory, "one")
	clock.Advance(1 * time.Second)
	manager.record("default-user", "Alice", directory, "two")

	manager.flush()
	files := chatBackupTestFiles(t, directory)
	if len(files) != 2 {
		t.Fatalf("flush wrote %v; want the leading backup plus one trailing backup at the flush instant", files)
	}
	youngest := filepath.Join(directory, files[len(files)-1])
	body, err := os.ReadFile(youngest)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "two" {
		t.Fatalf("flushed trailing backup = %q; want the latest args (two)", body)
	}
	info, err := os.Stat(youngest)
	if err != nil {
		t.Fatal(err)
	}

	// A second flush (a second Close, or the process exit flush after a drain) must
	// not write again: there is no pending edge left.
	clock.Advance(1 * time.Second)
	manager.flush()
	if files := chatBackupTestFiles(t, directory); len(files) != 2 {
		t.Fatalf("a second flush wrote %v; pinned's flush is idempotent (lastArgs were cleared)", files)
	}
	again, err := os.Stat(youngest)
	if err != nil {
		t.Fatal(err)
	}
	if !again.ModTime().Equal(info.ModTime()) {
		t.Fatalf("a second flush rewrote the trailing backup (mtime %v -> %v)", info.ModTime(), again.ModTime())
	}
	manager.mu.Lock()
	pending := 0
	for _, entry := range manager.entries {
		if entry.pending != nil {
			pending++
		}
	}
	manager.mu.Unlock()
	if pending != 0 {
		t.Fatalf("%d throttle entries still hold pending data after flush", pending)
	}
}

func TestChatBackupThrottleZeroIntervalInvokesEverySave(t *testing.T) {
	settings := defaultChatBackupTestSettings()
	settings.throttleInterval = 0
	manager, _, directory := newChatBackupTestManager(t, settings)

	manager.record("default-user", "Alice", directory, "one")
	manager.record("default-user", "Alice", directory, "two")
	if files := chatBackupTestFiles(t, directory); len(files) != 1 {
		// Same wall second and same key: pinned's second invocation OVERWRITES the
		// same timestamped file. What matters is that a second invocation happened,
		// which the overwritten body proves.
		t.Fatalf("interval 0 wrote %d backups (%v)", len(files), files)
	}
	body, err := os.ReadFile(filepath.Join(directory, chatBackupTestFiles(t, directory)[0]))
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "two" {
		t.Fatalf("interval 0 backup body = %q; every save must invoke in the same second and the later body wins", body)
	}
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

func writeChatBackupTestFile(t *testing.T, path, body string, modTime time.Time) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("plant %s: %v", path, err)
	}
	if err := os.Chtimes(path, modTime, modTime); err != nil {
		t.Fatalf("set mtime on %s: %v", path, err)
	}
}

func TestChatBackupRetentionPerChatKeepsNewestAndLeavesOtherFiles(t *testing.T) {
	directory := t.TempDir()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.Local)
	writeChatBackupTestFile(t, filepath.Join(directory, "chat_alice_20260101-000001.jsonl"), "old-1", base.Add(1*time.Minute))
	writeChatBackupTestFile(t, filepath.Join(directory, "chat_alice_20260101-000002.jsonl"), "old-2", base.Add(2*time.Minute))
	writeChatBackupTestFile(t, filepath.Join(directory, "chat_alice_20260101-000003.jsonl"), "old-3", base.Add(3*time.Minute))
	writeChatBackupTestFile(t, filepath.Join(directory, "chat_bob_20260101-000001.jsonl"), "bob", base.Add(1*time.Minute))
	writeChatBackupTestFile(t, filepath.Join(directory, "settings_default-user_20260101-000001.json"), "{}", base.Add(1*time.Minute))
	writeChatBackupTestFile(t, filepath.Join(directory, "user-notes.txt"), "mine", base.Add(1*time.Minute))

	settings := defaultChatBackupTestSettings()
	settings.numberOfBackups = 2
	now := base.Add(1 * time.Hour)
	if err := writeChatBackup(directory, "Alice", "new", settings, now); err != nil {
		t.Fatalf("writeChatBackup: %v", err)
	}

	alice := make([]string, 0, 4)
	for _, name := range chatBackupTestFiles(t, directory) {
		if strings.HasPrefix(name, "chat_alice_") {
			alice = append(alice, name)
		}
	}
	if len(alice) != 2 {
		t.Fatalf("per-chat retention kept %d alice backups (%v); numberOfBackups=2 must keep 2", len(alice), alice)
	}
	for _, deleted := range []string{"chat_alice_20260101-000001.jsonl", "chat_alice_20260101-000002.jsonl"} {
		if _, err := os.Stat(filepath.Join(directory, deleted)); !os.IsNotExist(err) {
			t.Fatalf("per-chat retention kept the oldest file %s; pinned sorts by mtime ascending and deletes the oldest", deleted)
		}
	}
	if _, err := os.Stat(filepath.Join(directory, "chat_alice_20260101-000003.jsonl")); err != nil {
		t.Fatalf("per-chat retention deleted the newest pre-existing file: %v", err)
	}
	for _, name := range []string{"chat_bob_20260101-000001.jsonl", "settings_default-user_20260101-000001.json", "user-notes.txt"} {
		if _, err := os.Stat(filepath.Join(directory, name)); err != nil {
			t.Fatalf("retention deleted %s: files outside the per-chat prefix must never be touched", name)
		}
	}
}

func TestChatBackupRetentionFractionalLimitMatchesPinnedComparison(t *testing.T) {
	directory := t.TempDir()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.Local)
	for index := 1; index <= 3; index++ {
		writeChatBackupTestFile(t, filepath.Join(directory, fmt.Sprintf("chat_alice_20260101-00000%d.jsonl", index)),
			fmt.Sprintf("old-%d", index), base.Add(time.Duration(index)*time.Minute))
	}
	settings := defaultChatBackupTestSettings()
	settings.numberOfBackups = 2.5
	if err := writeChatBackup(directory, "Alice", "new", settings, base.Add(1*time.Hour)); err != nil {
		t.Fatalf("writeChatBackup: %v", err)
	}
	files := chatBackupTestFiles(t, directory)
	// 4 files, limit 2.5: `while (files.length > 2.5)` deletes until 2 remain.
	if len(files) != 2 {
		t.Fatalf("fractional limit 2.5 kept %d files (%v); pinned keeps 2", len(files), files)
	}
}

func TestChatBackupRetentionGlobalLimitOnlyWhenNonNegative(t *testing.T) {
	directory := t.TempDir()
	base := time.Date(2026, 1, 1, 0, 0, 0, 0, time.Local)
	writeChatBackupTestFile(t, filepath.Join(directory, "chat_alice_20260101-000001.jsonl"), "a1", base.Add(1*time.Minute))
	writeChatBackupTestFile(t, filepath.Join(directory, "chat_bob_20260101-000001.jsonl"), "b1", base.Add(2*time.Minute))
	writeChatBackupTestFile(t, filepath.Join(directory, "chat_carol_20260101-000001.jsonl"), "c1", base.Add(3*time.Minute))
	writeChatBackupTestFile(t, filepath.Join(directory, "settings_default-user_20260101-000001.json"), "{}", base.Add(1*time.Minute))

	settings := defaultChatBackupTestSettings()
	settings.maxTotalBackups = -1
	if err := writeChatBackup(directory, "Alice", "keep-all", settings, base.Add(1*time.Hour)); err != nil {
		t.Fatalf("writeChatBackup (maxTotalBackups=-1): %v", err)
	}
	if files := chatBackupTestFiles(t, directory); len(files) != 5 {
		t.Fatalf("maxTotalBackups=-1 pruned: %d files (%v); pinned disables the global prune", len(files), files)
	}

	settings.maxTotalBackups = 3
	if err := writeChatBackup(directory, "Alice", "global-limit", settings, base.Add(2*time.Hour)); err != nil {
		t.Fatalf("writeChatBackup (maxTotalBackups=3): %v", err)
	}
	chatPrefix := make([]string, 0, 5)
	for _, name := range chatBackupTestFiles(t, directory) {
		if strings.HasPrefix(name, "chat_") {
			chatPrefix = append(chatPrefix, name)
		}
	}
	if len(chatPrefix) != 3 {
		t.Fatalf("maxTotalBackups=3 kept %d `chat_` files (%v); pinned keeps 3", len(chatPrefix), chatPrefix)
	}
	if _, err := os.Stat(filepath.Join(directory, "settings_default-user_20260101-000001.json")); err != nil {
		t.Fatalf("global prune deleted a file outside the `chat_` prefix: %v", err)
	}
}

func TestChatBackupCreatesMissingBackupsDirectory(t *testing.T) {
	// pinned tryWriteFileSync (src/util.js:1514-1521) creates the parent directory
	// recursively before the atomic replace, so a user whose backups directory is
	// missing still gets a backup. Startup normally creates it; this is the write-time
	// side effect pinned also has.
	root := t.TempDir()
	directory := filepath.Join(root, "user", "backups")
	if err := writeChatBackup(directory, "Alice", "bytes", defaultChatBackupTestSettings(),
		time.Date(2026, 1, 2, 3, 4, 5, 0, time.Local)); err != nil {
		t.Fatalf("writeChatBackup into a missing directory: %v", err)
	}
	files := chatBackupTestFiles(t, directory)
	if len(files) != 1 || files[0] != "chat_alice_20260102-030405.jsonl" {
		t.Fatalf("backups in the created directory = %v; want the one pinned-format file", files)
	}
}

// ---------------------------------------------------------------------------
// Failure: a backup failure must be invisible to the save and leave no partial file
// ---------------------------------------------------------------------------

func TestChatBackupWriteFailureLeavesNoPartialFile(t *testing.T) {
	directory := t.TempDir()
	settings := defaultChatBackupTestSettings()
	now := time.Date(2026, 1, 2, 3, 4, 5, 0, time.Local)
	target := filepath.Join(directory, "chat_alice_20260102-030405.jsonl")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	err := writeChatBackup(directory, "Alice", "data", settings, now)
	if err == nil {
		t.Fatal("writeChatBackup over a directory target returned nil; the rename must fail")
	}
	entries, readErr := os.ReadDir(directory)
	if readErr != nil {
		t.Fatal(readErr)
	}
	if len(entries) != 1 || entries[0].Name() != filepath.Base(target) || !entries[0].IsDir() {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("failed backup left files behind: %v; the atomic writer must remove its temporary file", names)
	}
}

func TestChatBackupSaveSurvivesBackupFailure(t *testing.T) {
	harness := newChatBackupTestHarness(t, "", "")
	backupsDirectory := harness.directories["default-user"]["backups"]
	if err := os.RemoveAll(backupsDirectory); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backupsDirectory, []byte("obstacle"), 0o600); err != nil {
		t.Fatal(err)
	}

	rawChat := chatBackupTestChatRequest("survives")
	response := harness.save("default-user", chatBackupTestCard, "chat", rawChat)
	if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), `"ok":true`) {
		t.Fatalf("save with a failing backup = %d %q; the backup must never change the response", response.Code, response.Body.String())
	}
	chatPath := harness.chatFilePath("default-user", chatBackupTestCard, "chat")
	body, err := os.ReadFile(chatPath)
	if err != nil {
		t.Fatalf("chat file missing after a failed backup: %v", err)
	}
	want := chatBackupTestChatBody("survives")
	if string(body) != want {
		t.Fatalf("chat file = %q; want the saved bytes %q even though the backup failed", body, want)
	}
	obstacle, err := os.ReadFile(backupsDirectory)
	if err != nil || string(obstacle) != "obstacle" {
		t.Fatalf("backup failure mutated the backups path: %q (%v)", obstacle, err)
	}
}

// ---------------------------------------------------------------------------
// HTTP integration: filename, exact bytes, throttle collapse, disabled mode
// ---------------------------------------------------------------------------

func TestChatBackupSaveWritesPinnedFilenameAndExactBytes(t *testing.T) {
	harness := newChatBackupTestHarness(t, "", "")
	rawChat := chatBackupTestChatRequest("exact bytes")
	response := harness.save("default-user", chatBackupTestCard, "chat", rawChat)
	if response.Code != http.StatusOK {
		t.Fatalf("POST /api/chats/save = %d, body %q", response.Code, response.Body.String())
	}

	files := harness.backupFiles("default-user")
	if len(files) != 1 {
		t.Fatalf("a single save wrote %d backups (%v); pinned's leading edge writes exactly 1", len(files), files)
	}
	if matched, _ := regexp.MatchString(`^chat_alice_[0-9]{8}-[0-9]{6}\.jsonl$`, files[0]); !matched {
		t.Fatalf("backup filename %q; pinned names it chat_<getBackupKey>_<YYYYMMDD-HHmmss>.jsonl", files[0])
	}
	backup, err := os.ReadFile(filepath.Join(harness.directories["default-user"]["backups"], files[0]))
	if err != nil {
		t.Fatal(err)
	}
	chat, err := os.ReadFile(harness.chatFilePath("default-user", chatBackupTestCard, "chat"))
	if err != nil {
		t.Fatal(err)
	}
	if string(backup) != string(chat) {
		t.Fatalf("backup bytes = %q; chat file bytes = %q; pinned backs up the exact bytes written", backup, chat)
	}
	if strings.HasSuffix(string(backup), "\n") {
		t.Fatalf("backup has a trailing newline; pinned backs up jsonlData.join('\\n') with no trailing newline")
	}
}

func TestChatBackupRapidSavesCollapseToLatest(t *testing.T) {
	harness := newChatBackupTestHarness(t, "", "")

	first := chatBackupTestChatRequest("first")
	second := chatBackupTestChatRequest("second")
	third := chatBackupTestChatRequest("third")
	firstBody := chatBackupTestChatBody("first")
	secondBody := chatBackupTestChatBody("second")
	thirdBody := chatBackupTestChatBody("third")
	for _, payload := range []string{first, second, third} {
		if response := harness.save("default-user", chatBackupTestCard, "chat", payload); response.Code != http.StatusOK {
			t.Fatalf("POST /api/chats/save = %d, body %q", response.Code, response.Body.String())
		}
	}
	if files := harness.backupFiles("default-user"); len(files) != 1 {
		t.Fatalf("rapid saves inside the window wrote %d backups (%v); only the leading edge may have run", len(files), files)
	}
	leading, err := os.ReadFile(filepath.Join(harness.directories["default-user"]["backups"], harness.backupFiles("default-user")[0]))
	if err != nil {
		t.Fatal(err)
	}
	if string(leading) != firstBody {
		t.Fatalf("the leading backup carries %q; the first save in the window is %q", leading, firstBody)
	}

	// The pending trailing edge is what pinned writes from its process 'exit' flush.
	FlushChatBackups()
	files := harness.backupFiles("default-user")
	if len(files) < 1 || len(files) > 2 {
		t.Fatalf("leading + trailing wrote %d backups (%v); pinned writes at most one of each per window", len(files), files)
	}
	sawThird := false
	for _, name := range files {
		body, err := os.ReadFile(filepath.Join(harness.directories["default-user"]["backups"], name))
		if err != nil {
			t.Fatal(err)
		}
		if string(body) == thirdBody {
			sawThird = true
		}
		if string(body) == secondBody {
			t.Fatalf("a backup carries the middle save %q; pinned's trailing edge carries the LATEST args", secondBody)
		}
	}
	if !sawThird {
		t.Fatalf("no backup carries the latest bytes %q; files %v", thirdBody, files)
	}
}

func TestChatBackupTrailingEdgeFiresOnItsTimer(t *testing.T) {
	// A real (small) interval, so this also proves the timer path and not only the
	// explicit flush. Bounded at 2s, well under the 1s-per-save guidance because it
	// polls rather than sleeping the interval.
	t.Setenv("SILLYTAVERN_BACKUPS_CHAT_THROTTLEINTERVAL", "40")
	harness := newChatBackupTestHarness(t, "", "")

	first := chatBackupTestChatRequest("timer-first")
	second := chatBackupTestChatRequest("timer-second")
	secondBody := chatBackupTestChatBody("timer-second")
	if response := harness.save("default-user", chatBackupTestCard, "chat", first); response.Code != http.StatusOK {
		t.Fatalf("POST /api/chats/save = %d", response.Code)
	}
	if response := harness.save("default-user", chatBackupTestCard, "chat", second); response.Code != http.StatusOK {
		t.Fatalf("POST /api/chats/save = %d", response.Code)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		files := harness.backupFiles("default-user")
		hasSecond := false
		for _, name := range files {
			body, err := os.ReadFile(filepath.Join(harness.directories["default-user"]["backups"], name))
			if err != nil {
				continue
			}
			if string(body) == secondBody {
				hasSecond = true
			}
		}
		if hasSecond && len(files) >= 1 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the throttled trailing edge did not write the latest data within 2s: files %v", files)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func TestChatBackupDisabledWritesNoFiles(t *testing.T) {
	t.Setenv("SILLYTAVERN_BACKUPS_CHAT_ENABLED", "false")
	harness := newChatBackupTestHarness(t, "", "")

	rawChat := chatBackupTestChatRequest("disabled")
	for index := 0; index < 3; index++ {
		if response := harness.save("default-user", chatBackupTestCard, "chat", rawChat); response.Code != http.StatusOK {
			t.Fatalf("POST /api/chats/save = %d, body %q", response.Code, response.Body.String())
		}
	}
	FlushChatBackups()
	if files := harness.backupFiles("default-user"); len(files) != 0 {
		t.Fatalf("backups.chat.enabled=false wrote %v; pinned writes no files at all", files)
	}
	if _, err := os.Stat(harness.chatFilePath("default-user", chatBackupTestCard, "chat")); err != nil {
		t.Fatalf("the chat itself was not written while backups were disabled: %v", err)
	}
}

func TestChatBackupConfigIsReadAtBootNotPerRequest(t *testing.T) {
	// Construct with the enabled default, then change the environment. Pinned reads
	// backups.chat.* at module load, so the change must NOT affect this handler.
	harness := newChatBackupTestHarness(t, "", "")
	t.Setenv("SILLYTAVERN_BACKUPS_CHAT_ENABLED", "false")

	rawChat := chatBackupTestChatRequest("boot-time")
	if response := harness.save("default-user", chatBackupTestCard, "chat", rawChat); response.Code != http.StatusOK {
		t.Fatalf("POST /api/chats/save = %d", response.Code)
	}
	if files := harness.backupFiles("default-user"); len(files) != 1 {
		t.Fatalf("a post-boot env change disabled backups (%v); pinned reads the config once at boot", files)
	}
}

// ---------------------------------------------------------------------------
// Multi-user isolation and restart
// ---------------------------------------------------------------------------

func TestChatBackupMultiUserIsolation(t *testing.T) {
	harness := newChatBackupTestHarness(t, "", "", "alpha-user", "beta-user")
	alphaChat := chatBackupTestChatRequest("alpha")
	betaChat := chatBackupTestChatRequest("beta")
	alphaBody := chatBackupTestChatBody("alpha")
	betaBody := chatBackupTestChatBody("beta")
	if response := harness.save("alpha-user", chatBackupTestCard, "chat", alphaChat); response.Code != http.StatusOK {
		t.Fatalf("alpha save = %d", response.Code)
	}
	if response := harness.save("beta-user", chatBackupTestCard, "chat", betaChat); response.Code != http.StatusOK {
		t.Fatalf("beta save = %d", response.Code)
	}
	for _, handle := range []string{"alpha-user", "beta-user"} {
		files := harness.backupFiles(handle)
		if len(files) != 1 {
			t.Fatalf("%s has %d backups (%v); the same chat name for two accounts is two independent keys", handle, len(files), files)
		}
		body, err := os.ReadFile(filepath.Join(harness.directories[handle]["backups"], files[0]))
		if err != nil {
			t.Fatal(err)
		}
		want := alphaBody
		if handle == "beta-user" {
			want = betaBody
		}
		if string(body) != want {
			t.Fatalf("%s backup = %q; want its own chat bytes %q", handle, body, want)
		}
	}
	alphaDir := harness.directories["alpha-user"]["backups"]
	betaDir := harness.directories["beta-user"]["backups"]
	if alphaDir == betaDir {
		t.Fatalf("both accounts resolved the same backups directory %q", alphaDir)
	}
}

func TestChatBackupRestartRetentionCountsPreexistingFiles(t *testing.T) {
	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	first := newChatBackupTestHarness(t, dataRoot, installRoot)
	if response := first.save("default-user", chatBackupTestCard, "chat", chatBackupTestChatRequest("v1")); response.Code != http.StatusOK {
		t.Fatalf("first save = %d", response.Code)
	}
	FlushChatBackups()

	backupsDirectory := first.directories["default-user"]["backups"]
	if len(first.backupFiles("default-user")) != 1 {
		t.Fatalf("first runtime wrote %v; expected one leading backup", first.backupFiles("default-user"))
	}
	base := time.Date(2020, 1, 1, 0, 0, 0, 0, time.Local)
	writeChatBackupTestFile(t, filepath.Join(backupsDirectory, "chat_alice_20200101-000000.jsonl"), "planted-oldest", base)
	writeChatBackupTestFile(t, filepath.Join(backupsDirectory, "chat_alice_20200101-000001.jsonl"), "planted-second", base.Add(time.Minute))

	// A NEW runtime over the same data root: no in-memory throttle state, but the
	// retention pass must count the pre-existing files.
	t.Setenv("SILLYTAVERN_BACKUPS_COMMON_NUMBEROFBACKUPS", "2")
	second := newChatBackupTestHarness(t, dataRoot, installRoot)
	v2 := chatBackupTestChatRequest("v2")
	v2Body := chatBackupTestChatBody("v2")
	if response := second.save("default-user", chatBackupTestCard, "chat", v2); response.Code != http.StatusOK {
		t.Fatalf("second save = %d", response.Code)
	}
	files := second.backupFiles("default-user")
	if len(files) != 2 {
		t.Fatalf("after restart with numberOfBackups=2 the directory holds %v; pinned prunes to 2 and counts pre-existing files", files)
	}
	if _, err := os.Stat(filepath.Join(backupsDirectory, "chat_alice_20200101-000000.jsonl")); !os.IsNotExist(err) {
		t.Fatalf("the oldest pre-existing backup survived: %v; retention must count and prune pre-existing files", files)
	}
	sawV2 := false
	for _, name := range files {
		body, err := os.ReadFile(filepath.Join(backupsDirectory, name))
		if err != nil {
			t.Fatal(err)
		}
		if string(body) == v2Body {
			sawV2 = true
		}
	}
	if !sawV2 {
		t.Fatalf("no backup carries the post-restart bytes %q: %v", v2Body, files)
	}
}

// ---------------------------------------------------------------------------
// Concurrency
// ---------------------------------------------------------------------------

func TestChatBackupConcurrentSavesStayCompleteAndBounded(t *testing.T) {
	harness := newChatBackupTestHarness(t, "", "")
	const writers = 8
	payloads := make([]string, writers)
	bodies := make([]string, writers)
	for index := 0; index < writers; index++ {
		marker := fmt.Sprintf("concurrent-%d", index)
		payloads[index] = chatBackupTestChatRequest(marker)
		bodies[index] = chatBackupTestChatBody(marker)
	}
	var wait sync.WaitGroup
	start := make(chan struct{})
	failures := make(chan string, writers)
	for index := 0; index < writers; index++ {
		wait.Add(1)
		go func(payload string) {
			defer wait.Done()
			<-start
			response := harness.save("default-user", chatBackupTestCard, "chat", payload)
			if response.Code != http.StatusOK {
				failures <- fmt.Sprintf("status %d body %q", response.Code, response.Body.String())
			}
		}(payloads[index])
	}
	close(start)
	wait.Wait()
	close(failures)
	for failure := range failures {
		t.Fatalf("concurrent save failed: %s", failure)
	}

	FlushChatBackups()
	files := harness.backupFiles("default-user")
	if len(files) == 0 || len(files) > 2 {
		t.Fatalf("N concurrent saves produced %d backups (%v); pinned's throttle allows one leading + one trailing per window", len(files), files)
	}
	known := make(map[string]bool, writers)
	for _, body := range bodies {
		known[body] = true
	}
	for _, name := range files {
		body, err := os.ReadFile(filepath.Join(harness.directories["default-user"]["backups"], name))
		if err != nil {
			t.Fatal(err)
		}
		if !known[string(body)] {
			t.Fatalf("backup %s carries bytes that are not one complete save: %q", name, body)
		}
		lines := strings.Split(string(body), "\n")
		for lineIndex, line := range lines {
			var decoded map[string]any
			if err := json.Unmarshal([]byte(line), &decoded); err != nil {
				t.Fatalf("backup %s line %d is not valid JSONL: %v (%q)", name, lineIndex, err, line)
			}
		}
	}
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type chatBackupTestHarness struct {
	t           *testing.T
	handler     http.Handler
	dataRoot    string
	installRoot string
	cookies     map[string]string
	tokens      map[string]string
	directories map[string]map[string]string
}

func newChatBackupTestHarness(t *testing.T, dataRoot, installRoot string, handles ...string) *chatBackupTestHarness {
	t.Helper()
	if dataRoot == "" {
		dataRoot = t.TempDir()
	}
	if installRoot == "" {
		installRoot = t.TempDir()
	}
	if len(handles) == 0 {
		handles = []string{"default-user"}
	}
	resolved := make([]string, 0, len(handles))
	for _, handle := range handles {
		encoded, err := marshalNodeJSON(struct {
			Handle   string `json:"handle"`
			Name     string `json:"name"`
			Created  int64  `json:"created"`
			Password string `json:"password"`
			Admin    bool   `json:"admin"`
			Enabled  bool   `json:"enabled"`
			Salt     string `json:"salt"`
		}{handle, "Chat Backup " + handle, 1700000000000, "", true, true, ""})
		if err != nil {
			t.Fatal(err)
		}
		if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+handle, encoded); err != nil {
			t.Fatal(err)
		}
		resolved = append(resolved, handle)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(chatBackupTestCookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, resolved); err != nil {
		t.Fatal(err)
	}
	harness := &chatBackupTestHarness{
		t: t, dataRoot: dataRoot, installRoot: installRoot,
		cookies: map[string]string{}, tokens: map[string]string{},
		directories: map[string]map[string]string{},
	}
	harness.handler = NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: chatBackupTestCookieSecret,
		AccountsEnabled: true,
	})
	for _, handle := range resolved {
		directories, err := startup.DirectoriesForUser(dataRoot, handle)
		if err != nil {
			t.Fatal(err)
		}
		harness.directories[handle] = directories
		harness.login(handle)
	}
	t.Cleanup(FlushChatBackups)
	return harness
}

func chatBackupTestCookieHeader(cookies []string) string {
	parts := make([]string, 0, len(cookies))
	for _, cookie := range cookies {
		parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
	}
	return strings.Join(parts, "; ")
}

func (harness *chatBackupTestHarness) serve(method, route, cookie, token string, body []byte) *httptest.ResponseRecorder {
	harness.t.Helper()
	request := httptest.NewRequest(method, route, strings.NewReader(string(body)))
	if cookie != "" {
		request.Header.Set("Cookie", cookie)
	}
	if token != "" {
		request.Header.Set("X-CSRF-Token", token)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	harness.handler.ServeHTTP(response, request)
	return response
}

func (harness *chatBackupTestHarness) login(handle string) {
	harness.t.Helper()
	csrfResponse := harness.serve(http.MethodGet, "/csrf-token", "", "", nil)
	if csrfResponse.Code != http.StatusOK {
		harness.t.Fatalf("GET /csrf-token = %d, body %q", csrfResponse.Code, csrfResponse.Body.String())
	}
	var token struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &token); err != nil {
		harness.t.Fatal(err)
	}
	csrfCookie := chatBackupTestCookieHeader(csrfResponse.Header().Values("Set-Cookie"))
	login := harness.serve(http.MethodPost, "/api/users/login", csrfCookie, token.Token,
		[]byte(`{"handle":"`+handle+`","password":""}`))
	if login.Code != http.StatusOK {
		harness.t.Fatalf("POST /api/users/login for %q = %d, body %q", handle, login.Code, login.Body.String())
	}
	harness.cookies[handle] = chatBackupTestCookieHeader(login.Header().Values("Set-Cookie"))
	harness.tokens[handle] = token.Token
}

func (harness *chatBackupTestHarness) save(handle, cardName, fileName, rawChat string) *httptest.ResponseRecorder {
	harness.t.Helper()
	body := `{"avatar_url":"` + cardName + `.png","file_name":"` + fileName + `","chat":` + rawChat + `}`
	return harness.serve(http.MethodPost, "/api/chats/save", harness.cookies[handle], harness.tokens[handle], []byte(body))
}

func (harness *chatBackupTestHarness) chatFilePath(handle, cardName, fileName string) string {
	return filepath.Join(harness.directories[handle]["chats"], cardName, fileName+".jsonl")
}

func (harness *chatBackupTestHarness) backupFiles(handle string) []string {
	harness.t.Helper()
	entries, err := os.ReadDir(harness.directories[handle]["backups"])
	if err != nil {
		harness.t.Fatalf("read backups directory for %s: %v", handle, err)
	}
	files := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasPrefix(entry.Name(), backupsChatPrefix) {
			continue
		}
		files = append(files, entry.Name())
	}
	sort.Strings(files)
	return files
}
