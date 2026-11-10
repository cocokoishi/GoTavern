package server

// alpha.20 M1: the pinned chat_metadata.integrity check and the group-save backup.
//
// The pinned behaviour these tests judge was read from src/endpoints/chats.js
// (trySaveChat 532-543, checkChatIntegrity 332-369, /save 545-570, /group/save
// 922-947) and src/util.js (readFirstLine 1560-1578, tryParse 571-578). The rows
// below are behavioural: each drives the real route through the real handler and
// reads the files it left on disk.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const a20IntegrityChatFile = "alpha20"

// a20IntegrityHeader is a pinned-like first chat line. integrity is raw JSON so a
// row can pass a string, a number, a boolean, an object or null.
func a20IntegrityHeader(integrity string) string {
	return `{"user_name":"User","character_name":"Alice","chat_metadata":{"integrity":` + integrity + `}}`
}

func a20IntegrityChatRequest(integrity, message string) string {
	return `[` + a20IntegrityHeader(integrity) + `,{"name":"Alice","mes":"` + message + `"}]`
}

func a20IntegrityChatBody(integrity, message string) string {
	return a20IntegrityHeader(integrity) + "\n" + `{"name":"Alice","mes":"` + message + `"}`
}

func a20StoreChatFile(t *testing.T, harness *chatBackupTestHarness, handle, cardName, fileName, body string) string {
	t.Helper()
	path := harness.chatFilePath(handle, cardName, fileName)
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o666); err != nil {
		t.Fatal(err)
	}
	return path
}

func a20ReadFile(t *testing.T, path string) string {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return string(body)
}

func a20AssertErrorBody(t *testing.T, response *httptest.ResponseRecorder, status int, wantError string) {
	t.Helper()
	if response.Code != status {
		t.Fatalf("status = %d, want %d (body %q)", response.Code, status, response.Body.String())
	}
	var decoded map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &decoded); err != nil {
		t.Fatalf("response body %q is not JSON: %v", response.Body.String(), err)
	}
	got, _ := decoded["error"].(string)
	if got != wantError {
		t.Fatalf("error = %q, want %q (body %q)", got, wantError, response.Body.String())
	}
}

func TestA20ChatIntegrityRejectsAStaleOverwriteBeforeWriting(t *testing.T) {
	harness := newChatBackupTestHarness(t, "", "", "default-user")
	original := a20IntegrityChatBody(`"stored"`, "original")
	path := a20StoreChatFile(t, harness, "default-user", chatBackupTestCard, a20IntegrityChatFile, original)

	response := harness.save("default-user", chatBackupTestCard, a20IntegrityChatFile,
		a20IntegrityChatRequest(`"different"`, "overwrite"))
	a20AssertErrorBody(t, response, http.StatusBadRequest, "integrity")

	if got := a20ReadFile(t, path); got != original {
		t.Fatalf("a refused overwrite changed the chat file: got %q, want the original bytes %q", got, original)
	}
	if backups := harness.backupFiles("default-user"); len(backups) != 0 {
		t.Fatalf("a refused save scheduled %d backup file(s); pinned schedules a backup only after a successful write", len(backups))
	}
}

func TestA20ChatIntegrityAcceptsMatchingAndLegacyFiles(t *testing.T) {
	rows := []struct {
		name      string
		stored    string
		integrity string
	}{
		{"matching string", a20IntegrityChatBody(`"same"`, "old"), `"same"`},
		{"legacy file without integrity", `{"user_name":"User","character_name":"Alice","chat_metadata":{}}` + "\n" + `{"name":"Alice","mes":"old"}`, `"new"`},
		{"empty file", "", `"new"`},
		{"bom on the first line", "\ufeff" + a20IntegrityChatBody(`"same"`, "old"), `"same"`},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			harness := newChatBackupTestHarness(t, "", "", "default-user")
			path := a20StoreChatFile(t, harness, "default-user", chatBackupTestCard, a20IntegrityChatFile, row.stored)
			response := harness.save("default-user", chatBackupTestCard, a20IntegrityChatFile,
				a20IntegrityChatRequest(row.integrity, "new message"))
			if response.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %q)", response.Code, response.Body.String())
			}
			want := a20IntegrityChatBody(row.integrity, "new message")
			if got := a20ReadFile(t, path); got != want {
				t.Fatalf("chat file = %q, want %q", got, want)
			}
		})
	}
}

func TestA20ChatIntegrityRequiresConfirmationForACorruptFirstLine(t *testing.T) {
	harness := newChatBackupTestHarness(t, "", "", "default-user")
	corrupt := "this is not a chat header\n{\"name\":\"Alice\"}"
	path := a20StoreChatFile(t, harness, "default-user", chatBackupTestCard, a20IntegrityChatFile, corrupt)
	response := harness.save("default-user", chatBackupTestCard, a20IntegrityChatFile,
		a20IntegrityChatRequest(`"new"`, "overwrite"))
	a20AssertErrorBody(t, response, http.StatusBadRequest, "integrity")
	if got := a20ReadFile(t, path); got != corrupt {
		t.Fatalf("a refused overwrite changed the corrupt file: got %q", got)
	}
}

func TestA20ChatIntegrityForceUsesJavaScriptTruthiness(t *testing.T) {
	rows := []struct {
		name      string
		forceJSON string
		wantOK    bool
	}{
		{"true bypasses", `true`, true},
		{"the string false is truthy in JavaScript", `"false"`, true},
		{"one bypasses", `1`, true},
		{"an empty array is truthy", `[]`, true},
		{"false does not bypass", `false`, false},
		{"zero does not bypass", `0`, false},
		{"the empty string does not bypass", `""`, false},
		{"null does not bypass", `null`, false},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			harness := newChatBackupTestHarness(t, "", "", "default-user")
			original := a20IntegrityChatBody(`"stored"`, "original")
			path := a20StoreChatFile(t, harness, "default-user", chatBackupTestCard, a20IntegrityChatFile, original)
			body := `{"avatar_url":"` + chatBackupTestCard + `.png","file_name":"` + a20IntegrityChatFile +
				`","force":` + row.forceJSON + `,"chat":` + a20IntegrityChatRequest(`"other"`, "forced") + `}`
			response := harness.serve(http.MethodPost, "/api/chats/save", harness.cookies["default-user"],
				harness.tokens["default-user"], []byte(body))
			if row.wantOK {
				if response.Code != http.StatusOK {
					t.Fatalf("status = %d, want 200 (body %q)", response.Code, response.Body.String())
				}
			} else {
				a20AssertErrorBody(t, response, http.StatusBadRequest, "integrity")
				if got := a20ReadFile(t, path); got != original {
					t.Fatalf("a refused force=false overwrite changed the file: %q", got)
				}
			}
		})
	}
}

func TestA20ChatIntegrityConfigCanDisableTheCheck(t *testing.T) {
	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	config := "backups:\n  chat:\n    checkIntegrity: false\n"
	if err := os.WriteFile(filepath.Join(installRoot, "config.yaml"), []byte(config), 0o666); err != nil {
		t.Fatal(err)
	}
	harness := newChatBackupTestHarness(t, dataRoot, installRoot, "default-user")
	original := a20IntegrityChatBody(`"stored"`, "original")
	a20StoreChatFile(t, harness, "default-user", chatBackupTestCard, a20IntegrityChatFile, original)
	response := harness.save("default-user", chatBackupTestCard, a20IntegrityChatFile,
		a20IntegrityChatRequest(`"other"`, "overwrite"))
	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 with backups.chat.checkIntegrity=false (body %q)", response.Code, response.Body.String())
	}
}

func TestA20ChatIntegrityComparisonIsStrict(t *testing.T) {
	// Pinned compares with ===, so a number and a string with the same text differ,
	// while two numbers of equal value match (23 and 23.0 are one JSON number).
	rows := []struct {
		name     string
		stored   string
		incoming string
		wantOK   bool
	}{
		{"string vs number", `"23"`, `23`, false},
		{"number vs string", `23`, `"23"`, false},
		{"equal numbers", `23`, `23.0`, true},
		{"boolean mismatch", `true`, `"true"`, false},
		{"two objects are different references", `{"a":1}`, `{"a":1}`, false},
	}
	for _, row := range rows {
		t.Run(row.name, func(t *testing.T) {
			harness := newChatBackupTestHarness(t, "", "", "default-user")
			original := a20IntegrityChatBody(row.stored, "original")
			path := a20StoreChatFile(t, harness, "default-user", chatBackupTestCard, a20IntegrityChatFile, original)
			response := harness.save("default-user", chatBackupTestCard, a20IntegrityChatFile,
				a20IntegrityChatRequest(row.incoming, "overwrite"))
			if row.wantOK {
				if response.Code != http.StatusOK {
					t.Fatalf("status = %d, want 200 (body %q)", response.Code, response.Body.String())
				}
			} else {
				a20AssertErrorBody(t, response, http.StatusBadRequest, "integrity")
				if got := a20ReadFile(t, path); got != original {
					t.Fatalf("a refused overwrite changed the file: %q", got)
				}
			}
		})
	}
}

func a20GroupSave(harness *chatBackupTestHarness, id, chatJSON, forceJSON string) *httptest.ResponseRecorder {
	harness.t.Helper()
	body := `{"id":"` + id + `","chat":` + chatJSON
	if forceJSON != "" {
		body += `,"force":` + forceJSON
	}
	body += `}`
	return harness.serve(http.MethodPost, "/api/chats/group/save", harness.cookies["default-user"],
		harness.tokens["default-user"], []byte(body))
}

func TestA20GroupSaveChecksIntegrityAndSchedulesThePinnedBackup(t *testing.T) {
	harness := newChatBackupTestHarness(t, "", "", "default-user")
	directories := harness.directories["default-user"]
	groupPath := filepath.Join(directories["groupChats"], "alpha20group.jsonl")
	original := a20IntegrityChatBody(`"stored"`, "original")
	if err := os.WriteFile(groupPath, []byte(original), 0o666); err != nil {
		t.Fatal(err)
	}

	// A stale overwrite is refused and changes nothing.
	stale := a20GroupSave(harness, "alpha20group", a20IntegrityChatRequest(`"other"`, "stale"), "")
	if stale.Code != http.StatusBadRequest {
		t.Fatalf("group save mismatch status = %d, want 400 (body %q)", stale.Code, stale.Body.String())
	}
	if got := a20ReadFile(t, groupPath); got != original {
		t.Fatalf("a refused group save changed the file: %q", got)
	}

	// A matching save writes, then schedules the same throttled backup as a 1:1 save.
	matching := a20GroupSave(harness, "alpha20group", a20IntegrityChatRequest(`"stored"`, "updated"), "")
	if matching.Code != http.StatusOK {
		t.Fatalf("group save status = %d, want 200 (body %q)", matching.Code, matching.Body.String())
	}
	wantFile := a20IntegrityChatBody(`"stored"`, "updated")
	if got := a20ReadFile(t, groupPath); got != wantFile {
		t.Fatalf("group chat file = %q, want %q", got, wantFile)
	}
	backups := harness.backupFiles("default-user")
	if len(backups) != 1 {
		t.Fatalf("group save produced %d backup file(s), want exactly one: %v", len(backups), backups)
	}
	if !strings.HasPrefix(backups[0], "chat_alpha20group_") {
		t.Fatalf("group backup file = %q, want the pinned chat_<key>_<timestamp>.jsonl name for String(id)", backups[0])
	}
	if got := a20ReadFile(t, filepath.Join(directories["backups"], backups[0])); got != wantFile {
		t.Fatalf("group backup body = %q, want the exact jsonl that was written %q", got, wantFile)
	}

	// force still overrides the check, as trySaveChat's skipIntegrityCheck does.
	forced := a20GroupSave(harness, "alpha20group", a20IntegrityChatRequest(`"other"`, "forced"), "true")
	if forced.Code != http.StatusOK {
		t.Fatalf("forced group save status = %d, want 200 (body %q)", forced.Code, forced.Body.String())
	}
}
