package server

// THE RESTORE HALF OF THE BACKUP STORY, DRIVEN THE WAY THE PINNED UI DRIVES IT.
//
// The matrix recorded "restore is not proven: a backup is read, but no test restores one into a tree and
// compares the tree", and that is the half a user actually needs at the worst moment. `src/endpoints/
// backups.js` has NO restore route, so the pinned frontend implements it in two client-side steps
// (`public/scripts/chat-backups.js:73-118`): download the backup with `POST /api/backups/chat/download`, then
// import the returned bytes as a chat with the same multipart the chat importer takes. This test performs
// exactly those two steps against the same tree the backup came from, and asserts the messages come back.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/commandline"
)

func TestChatBackupRestoreRoundTripPreservesTheChat(t *testing.T) {
	harness := newCacheBusterRouteHarness(t, commandline.CacheBusterSettings{})
	chatsDirectory := harness.directories["chats"]
	backupsDirectory := harness.directories["backups"]
	if chatsDirectory == "" || backupsDirectory == "" {
		t.Fatalf("the harness did not resolve the chats/backups directories (%q, %q)", chatsDirectory, backupsDirectory)
	}

	const chatName = "Seraphina - 2025-01-01"
	const backupName = "chat_" + chatName + ".jsonl"
	// A pinned character-chat .jsonl: a metadata line, then messages with name/is_user/mes.
	original := strings.Join([]string{
		`{"user_name":"User","character_name":"Seraphina","create_date":"2025-01-01 @00h 00m 00s"}`,
		`{"name":"Seraphina","is_user":false,"mes":"Hello there."}`,
		`{"name":"User","is_user":true,"mes":"Hi Seraphina."}`,
		"",
	}, "\n")
	// Pinned stores character chats under `chats/<character name>/`, which is the directory the import
	// writes into as well (the route builds it from `avatar_url`).
	characterChats := filepath.Join(chatsDirectory, "Seraphina")
	if err := os.MkdirAll(characterChats, 0o755); err != nil {
		t.Fatalf("prepare the character chat directory: %v", err)
	}
	if err := os.WriteFile(filepath.Join(characterChats, chatName+".jsonl"), []byte(original), 0o600); err != nil {
		t.Fatalf("write the chat: %v", err)
	}
	// The backup pinned's throttled subsystem would have left behind (`backups.chat.*` is a recorded
	// decision in docs/config-inventory.md, so this test SEEDS the file rather than pretending GoTavern
	// produces it: what is under test is the restore half).
	if err := os.WriteFile(filepath.Join(backupsDirectory, backupName), []byte(original), 0o600); err != nil {
		t.Fatalf("write the backup: %v", err)
	}

	// THE USER LOSES THE CHAT. This is the state a restore exists for.
	if err := os.Remove(filepath.Join(characterChats, chatName+".jsonl")); err != nil {
		t.Fatalf("remove the chat: %v", err)
	}

	// ---- step 1 of the pinned frontend: download the backup ------------------------------------
	encodedName, marshalErr := json.Marshal(backupName)
	if marshalErr != nil {
		t.Fatalf("encode the backup name: %v", marshalErr)
	}
	downloadBody := strings.NewReader(`{"name":` + string(encodedName) + `}`)
	download := httptest.NewRequest(http.MethodPost, "/api/backups/chat/download", downloadBody)
	download.Header.Set("Content-Type", "application/json")
	download.Header.Set("Cookie", harness.sessionCookie)
	download.Header.Set("X-CSRF-Token", harness.csrfToken)
	downloadResponse := httptest.NewRecorder()
	harness.handler.ServeHTTP(downloadResponse, download)
	if downloadResponse.Code != http.StatusOK {
		t.Fatalf("POST /api/backups/chat/download = %d, want 200: %s", downloadResponse.Code, downloadResponse.Body.String())
	}
	downloaded, err := io.ReadAll(downloadResponse.Body)
	if err != nil {
		t.Fatalf("read the download: %v", err)
	}
	if string(downloaded) != original {
		t.Fatalf("the downloaded backup is not byte-identical to the planted one\n  want %q\n  got  %q", original, string(downloaded))
	}
	if disposition := downloadResponse.Header().Get("Content-Disposition"); !strings.Contains(disposition, backupName) {
		t.Fatalf("Content-Disposition = %q, want it to name %q so the browser saves the right file", disposition, backupName)
	}

	// ---- step 2 of the pinned frontend: import those bytes as a chat --------------------------
	// The field names are the pinned client's own (`chat-backups.js:100-110`), including `avatar` as the
	// FILE part -- the same globally-mounted multer field every upload uses.
	importResponse := harness.postMultipart(t, "/api/chats/import", backupName, downloaded, map[string]string{
		"file_type":      "jsonl",
		"avatar_url":     "Seraphina.png",
		"user_name":      "User",
		"character_name": "Seraphina",
	})
	if importResponse.Code != http.StatusOK {
		t.Fatalf("POST /api/chats/import = %d, want 200: %s", importResponse.Code, importResponse.Body.String())
	}
	// The pinned response is `{ res: true, fileNames: [...] }` (chats.js importCharacterChat), not a bare array.
	var imported struct {
		Res       bool     `json:"res"`
		FileNames []string `json:"fileNames"`
	}
	if err := json.Unmarshal(importResponse.Body.Bytes(), &imported); err != nil {
		t.Fatalf("the import response is not the pinned {res, fileNames} body (%q): %v", importResponse.Body.String(), err)
	}
	if !imported.Res || len(imported.FileNames) == 0 {
		t.Fatalf("the import did not report a restored chat: %s", importResponse.Body.String())
	}

	// ---- the tree now holds a chat whose messages come back ------------------------------------
	// The restored file's NAME is generated by pinned's `humanizedDateTime()` template, so it is found by
	// reading the directory rather than by predicting the string -- and the assertion is on the MESSAGES.
	var restoredPath string
	for _, name := range imported.FileNames {
		candidate := filepath.Join(characterChats, name)
		if _, statErr := os.Stat(candidate); statErr == nil {
			restoredPath = candidate
			break
		}
	}
	if restoredPath == "" {
		entries, _ := os.ReadDir(chatsDirectory)
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("the import reported %v but no such file exists under %s (directory holds %v)", imported.FileNames, characterChats, names)
	}
	restoredBytes, err := os.ReadFile(restoredPath)
	if err != nil {
		t.Fatalf("read the restored chat: %v", err)
	}
	if want, got := chatMessageTexts(t, original), chatMessageTexts(t, string(restoredBytes)); !equalStrings(want, got) {
		t.Fatalf("the restored chat's messages differ from the backup's\n  backup:   %q\n  restored: %q", want, got)
	}
}

// chatMessageTexts returns the `mes` values in order, which is what a user recognises as "my chat came back".
// Import legitimately rewrites metadata (pinned stamps `new Date().toISOString()` on imported messages), so
// this compares the MESSAGE SEQUENCE rather than whole-file bytes; the byte-level promise was already
// asserted on the download, where it is the contract.
func chatMessageTexts(t *testing.T, jsonl string) []string {
	t.Helper()
	texts := make([]string, 0, 4)
	for _, line := range strings.Split(jsonl, "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		var record map[string]any
		if err := json.Unmarshal([]byte(line), &record); err != nil {
			t.Fatalf("unparseable chat line %q: %v", line, err)
		}
		if message, exists := record["mes"]; exists {
			if text, isString := message.(string); isString {
				texts = append(texts, text)
			}
		}
	}
	return texts
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for index := range a {
		if a[index] != b[index] {
			return false
		}
	}
	return true
}
