package e2e

// A15 LANE B: CORRUPT EXISTING USER DATA MUST NOT STOP THE BOOT AND MUST NOT BE SILENTLY REWRITTEN.
//
// GOAL §14 item 5 requires the failure path to leave a user's data parseable and recoverable. The rows
// below plant the corruption shapes a real crash or editor produces -- truncated JSON/JSONL, a BOM, CRLF,
// NUL bytes, invalid UTF-8, a huge line -- in a tree a real user owns, boot the SHIPPED BINARY over it, and
// assert three things that "the function returned an error" does not:
//
//	1. the boot serves (the harness's GET /version readiness check), so corruption does not brick startup;
//	2. EVERY planted file is byte-identical afterwards, so no startup "repair" rewrites it;
//	3. the routes still answer in the product's pinned shape, so "preserved" does not mean "unreadable".
//
// THE ONE PINNED EXCEPTION is asserted rather than hidden: pinned's group-metadata migration rewrites a
// legacy group chat whose lines cannot be parsed into a header-only file (src/endpoints/groups.js:78-86:
// `tryParse` per line, `filter(Boolean)`, then `writeFileAtomic`), and it copies the original to
// backups/_group_metadata_update FIRST (groups.js:83). GoTavern reproduces that (internal/startup/
// group_metadata.go:111-140), so the assertion is: the corrupt bytes are recoverable from the backup, and
// the rewritten file is parseable. It is recorded in the ledger as inherited-pinned-behaviour, not as a
// GoTavern defect, because changing it would change pinned's upgrade recovery behaviour.

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// corruptTree is one release-shaped tree with a default user whose files are planted by the case.
type corruptTree struct {
	installRoot string
	dataRoot    string
	userRoot    string
}

func newCorruptTree(t *testing.T) *corruptTree {
	t.Helper()
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatalf("resolve the default user's directories: %v", err)
	}
	for _, directory := range []string{directories["chats"], directories["worlds"], directories["groups"], directories["groupChats"], directories["backups"]} {
		if err := os.MkdirAll(directory, 0o777); err != nil {
			t.Fatalf("create %s: %v", directory, err)
		}
	}
	return &corruptTree{installRoot: installRoot, dataRoot: dataRoot, userRoot: filepath.Join(dataRoot, "default-user")}
}

// plant writes one file relative to the data root and records its digest for the byte-identity assertion.
func (tree *corruptTree) plant(t *testing.T, relative string, body []byte) string {
	t.Helper()
	target := filepath.Join(tree.dataRoot, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		t.Fatalf("create %s: %v", filepath.Dir(target), err)
	}
	if err := os.WriteFile(target, body, 0o600); err != nil {
		t.Fatalf("plant %s: %v", relative, err)
	}
	return target
}

// assertUnchanged fails, naming the file, when any planted file is absent or changed.
func (tree *corruptTree) assertUnchanged(t *testing.T, planted map[string][]byte) {
	t.Helper()
	for relative, want := range planted {
		target := filepath.Join(tree.dataRoot, filepath.FromSlash(relative))
		got, err := os.ReadFile(target)
		if err != nil {
			t.Errorf("%s was DELETED by the boot, so the user's corrupt data is not recoverable (GOAL §14.5): %v",
				relative, err)
			continue
		}
		if !bytes.Equal(got, want) {
			t.Errorf("%s was REWRITTEN by the boot (%d bytes now, planted %d). A startup repair of unparseable\n"+
				"user data is data loss unless it is a recorded pinned migration with a backup (AGENTS 28).\n"+
				"  now:  %q\n  want: %q", relative, len(got), len(want), truncateForLog(string(got), 200), truncateForLog(string(want), 200))
		}
	}
}

type corruptChatVariant struct {
	name string
	body []byte
}

func corruptChatVariants() []corruptChatVariant {
	return []corruptChatVariant{
		{name: "truncated-mid-line", body: []byte(`{"name":"User","is_user":true,"mes":"the sentence stops mid-wo`)},
		{name: "truncated-mid-array", body: []byte(`[{"name":"User","is_user":true,"mes":"x"},{"name":"Char","mes":"y"`)},
		{name: "utf8-bom", body: append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"name":"User","is_user":true,"mes":"bom line"}`+"\n")...)},
		{name: "crlf-lines", body: []byte(`{"name":"User","is_user":true,"mes":"crlf one"}` + "\r\n" + `{"name":"Char","is_user":false,"mes":"crlf two"}` + "\r\n")},
		{name: "nul-bytes", body: []byte(`{"name":"User","is_user":true,"mes":"before` + "\x00" + `after"}`)},
		{name: "invalid-utf8", body: []byte(`{"name":"User","is_user":true,"mes":"bad ` + "\xff\xfe" + ` bytes"}`)},
		{name: "huge-single-line", body: []byte(`{"name":"User","is_user":true,"mes":"` + strings.Repeat("h", 2<<20) + `"}`)},
	}
}

// TestBootDoesNotRewriteCorruptUserData is the corruption matrix: boot must serve, preserve every byte,
// and still answer the routes in the product's shape.
func TestBootDoesNotRewriteCorruptUserData(t *testing.T) {
	tree := newCorruptTree(t)
	planted := map[string][]byte{}

	// (1) CORRUPT CHAT SHAPES, each in its own file, in a directory a real card owns.
	for _, variant := range corruptChatVariants() {
		relative := "default-user/chats/CorruptCard/" + variant.name + ".jsonl"
		tree.plant(t, relative, variant.body)
		planted[relative] = variant.body
	}
	// A VALID chat beside them is the negative control: if IT were not read back, the corrupt rows would
	// "pass" because the route never looked at the directory at all.
	validChat := []byte(`{"name":"User","is_user":true,"mes":"VALID_CHAT_MARKER"}` + "\n")
	tree.plant(t, "default-user/chats/CorruptCard/valid.jsonl", validChat)
	planted["default-user/chats/CorruptCard/valid.jsonl"] = validChat

	// (2) CORRUPT WORLD DOCUMENTS (truncated JSON and a BOM-prefixed one).
	truncatedWorld := []byte(`{"entries":{"0":{"uid":0,"key":["KEEP"],"content":"the content sto`)
	tree.plant(t, "default-user/worlds/Truncated.json", truncatedWorld)
	planted["default-user/worlds/Truncated.json"] = truncatedWorld
	bomWorld := append([]byte{0xEF, 0xBB, 0xBF}, []byte(`{"entries":{}}`)...)
	tree.plant(t, "default-user/worlds/Bom.json", bomWorld)
	planted["default-user/worlds/Bom.json"] = bomWorld

	// (3) CORRUPT settings.json, the whole-document file the frontend loads on page load.
	corruptSettings := []byte(`{"username":"default-user","oai_settings":{`)
	tree.plant(t, "default-user/settings.json", corruptSettings)
	planted["default-user/settings.json"] = corruptSettings

	server := bootServerAt(t, tree.installRoot, tree.dataRoot, nil)
	client := openSession(t, server.origin)
	tree.assertUnchanged(t, planted)
	if strings.Contains(server.stderr.String(), "panic") {
		t.Fatalf("the boot panicked on corrupt user data:\n%s", server.diagnostic())
	}

	// The routes answer: corrupt chats are skipped (pinned's reader filters unparseable lines), the valid
	// control is read, the corrupt worlds still list by file name, and settings/get returns the raw text in
	// the pinned `settings` member (settings.json is a whole-document replacement, §5 of data-safety.md).
	status, _, body := client.postJSON(t, "/api/chats/get", `{"avatar_url":"CorruptCard.png","file_name":"valid"}`)
	if status != 200 {
		t.Fatalf("POST /api/chats/get for the VALID control chat = %d: %s", status, truncateForLog(body, 400))
	}
	var validMessages []json.RawMessage
	if err := json.Unmarshal([]byte(body), &validMessages); err != nil {
		t.Fatalf("the valid control chat did not read back as a JSON array: %v (%s)", err, truncateForLog(body, 400))
	}
	if !strings.Contains(body, "VALID_CHAT_MARKER") {
		t.Fatalf("the valid control chat is listed but its content is missing, so the reader is not looking at it: %s", body)
	}

	status, _, body = client.postJSON(t, "/api/worldinfo/list", `{}`)
	if status != 200 {
		t.Fatalf("POST /api/worldinfo/list with corrupt worlds = %d: %s", status, truncateForLog(body, 400))
	}
	for _, name := range []string{"Truncated", "Bom"} {
		if !strings.Contains(body, `"`+name+`"`) {
			t.Errorf("worldinfo/list does not list the corrupt world %q by name; listing must not drop files: %s", name, body)
		}
	}

	status, _, body = client.postJSON(t, "/api/settings/get", `{}`)
	if status != 200 {
		t.Fatalf("POST /api/settings/get with a corrupt settings.json = %d: %s", status, truncateForLog(body, 400))
	}
	var envelope struct {
		Settings json.RawMessage `json:"settings"`
	}
	if err := json.Unmarshal([]byte(body), &envelope); err != nil {
		t.Fatalf("settings/get body is not JSON: %v (%s)", err, truncateForLog(body, 400))
	}
	var settingsText string
	if err := json.Unmarshal(envelope.Settings, &settingsText); err == nil && settingsText != string(corruptSettings) {
		t.Errorf("settings/get did not return the RAW corrupt settings text (pinned passes the file text through): %q",
			truncateForLog(settingsText, 160))
	}
}

// TestLegacyGroupMetadataMigrationBacksUpCorruptChatBeforeRewriting covers the ONE pinned migration that
// rewrites unparseable data. The assertion is what makes that acceptable: the original corrupt bytes are
// in the backup, and the rewritten file is parseable. A migration that rewrote without the backup (or left
// a half-written file) must fail this test by name.
func TestLegacyGroupMetadataMigrationBacksUpCorruptChatBeforeRewriting(t *testing.T) {
	tree := newCorruptTree(t)
	corruptChat := []byte(`{"name":"Char","is_user":false,"mes":"the line that cannot `)
	tree.plant(t, "default-user/group chats/legacy-chat.jsonl", corruptChat)
	groupJSON := []byte(`{"id":"legacy-group","name":"Legacy","chat_id":"legacy-chat",` +
		`"chats":["legacy-chat"],"members":[],"chat_metadata":{"deprecated":true}}`)
	tree.plant(t, "default-user/groups/legacy-group.json", groupJSON)

	server := bootServerAt(t, tree.installRoot, tree.dataRoot, nil)
	if strings.Contains(server.stderr.String(), "panic") {
		t.Fatalf("the boot panicked on a legacy group with a corrupt chat:\n%s", server.diagnostic())
	}

	// (1) THE REWRITE IS BACKED UP FIRST, byte for byte.
	backup := filepath.Join(tree.dataRoot, "default-user", "backups", "_group_metadata_update", "legacy-chat.jsonl")
	backupBody, err := os.ReadFile(backup)
	if err != nil {
		t.Fatalf("the migrated group chat was rewritten WITHOUT a recoverable backup at %s: %v", backup, err)
	}
	if !bytes.Equal(backupBody, corruptChat) {
		t.Fatalf("the backup does not hold the original corrupt bytes.\n  backup: %q\n  original: %q",
			backupBody, corruptChat)
	}

	// (2) THE REWRITTEN CHAT IS PARSEABLE, which is pinned's recovery contract (the content is in the backup).
	rewritten, err := os.ReadFile(filepath.Join(tree.dataRoot, "default-user", "group chats", "legacy-chat.jsonl"))
	if err != nil {
		t.Fatalf("read the rewritten group chat: %v", err)
	}
	lines := strings.Split(string(rewritten), "\n")
	if len(lines) == 0 || strings.TrimSpace(lines[0]) == "" {
		t.Fatalf("the rewritten group chat is empty: %q", rewritten)
	}
	var header map[string]json.RawMessage
	if err := json.Unmarshal([]byte(lines[0]), &header); err != nil {
		t.Fatalf("the rewritten group chat header is not JSON: %v (%q)", err, lines[0])
	}
	if _, present := header["chat_metadata"]; !present {
		t.Fatalf("the rewritten group chat header has no chat_metadata: %q", lines[0])
	}
	for index, line := range lines {
		if strings.TrimSpace(line) == "" {
			continue
		}
		if !json.Valid([]byte(line)) {
			t.Fatalf("rewritten group chat line %d is not valid JSON: %q", index, truncateForLog(line, 160))
		}
	}

	// (3) THE GROUP DOCUMENT'S DEPRECATED KEYS ARE GONE (pinned deletes them), and the user's other members
	// survive.
	groupAfter, err := os.ReadFile(filepath.Join(tree.dataRoot, "default-user", "groups", "legacy-group.json"))
	if err != nil {
		t.Fatalf("read the group document after migration: %v", err)
	}
	if strings.Contains(string(groupAfter), "chat_metadata") {
		t.Errorf("the group document still carries the deprecated chat_metadata key: %s", truncateForLog(string(groupAfter), 300))
	}
	var group map[string]any
	if err := json.Unmarshal(groupAfter, &group); err != nil {
		t.Fatalf("the migrated group document is not parseable JSON: %v (%s)", err, truncateForLog(string(groupAfter), 300))
	}
	if group["name"] != "Legacy" {
		t.Errorf("the migrated group document lost the user's group name: %v", group["name"])
	}
	chats, ok := group["chats"].([]any)
	if !ok || len(chats) != 1 || chats[0] != "legacy-chat" {
		t.Errorf("the migrated group document lost its chats array: %v", group["chats"])
	}
}
