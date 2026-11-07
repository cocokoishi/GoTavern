package e2e

// NICHE FILESYSTEM / PATH EXTREMES (alpha.17; domain IDs FS-001..FS-009).
//
// Every case below drives the REAL binary over its own HTTP routes and then looks at the bytes on disk,
// because the two halves are separate contract surfaces: the route can answer 200 while writing nothing,
// and a file can exist while the route cannot read it back. The expectations are either (a) source-derived
// from pinned's own code, quoted beside the assertion, or (b) the product's CURRENT behaviour pinned by a
// test with the residual named, which is only used where no oracle capture exists. Where (b) is used the
// comment says so.
//
// The comparators are shared with niche_teeth_test.go: each positive assertion here can be planted with a
// wrong value there and must go red with the same named prefix.

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// FS-001: CJK, emoji and a zero-width character in the CHAT FILE NAME survive save -> disk -> read back.
// Pinned derives the chat path from `sanitize-filename(String(file_name)+'.jsonl')` (chats.js save), which
// keeps non-ASCII and removes only the reserved characters; the same sanitiser runs on the read route, so
// a name that survives one direction must survive the other.
func TestNicheFSCJKEmojiAndZeroWidthChatNamesRoundTrip(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	avatar := "角色🚀.png"
	names := []string{"对话记录", "chat🚀😀", "zero\u200Bwidth"}
	for index, name := range names {
		marker := "NICHE-FS-001-" + string(rune('A'+index))
		if status, body := nicheSaveChat(t, booted.client, avatar, name, []map[string]any{{"name": "User", "is_user": true, "mes": marker}}); status != 200 {
			t.Fatalf("save chat named %q = %d: %s", name, status, truncateForLog(body, 240))
		}
	}
	chatDirectory := tree.chatDir(avatar)
	for index, name := range names {
		marker := "NICHE-FS-001-" + string(rune('A'+index))
		status, body := nicheGetChat(t, booted.client, avatar, name)
		if err := nicheCheckStatus("chats/get "+name, status, 200); err != nil {
			t.Fatalf("%v: %s", err, truncateForLog(body, 240))
		}
		if err := nicheCheckContains("chats/get "+name, body, marker); err != nil {
			t.Fatalf("%v (body %s)", err, truncateForLog(body, 240))
		}
		// The read-back body must be EXACTLY the file the product wrote, so a route that invents or
		// re-orders members is caught.
		path := filepath.Join(chatDirectory, startup.SanitizeUserFilename(name+".jsonl"))
		want := nicheExpectedChatBody(nicheChatLines(t, path))
		if err := nicheCheckBody("chats/get "+name, body, want); err != nil {
			t.Fatalf("%v", err)
		}
	}
	entries, err := os.ReadDir(chatDirectory)
	if err != nil {
		t.Fatalf("read the chat directory: %v", err)
	}
	if len(entries) != len(names) {
		t.Fatalf("the chat directory holds %d entries, want %d: one CJK/emoji/zero-width name was not a distinct file", len(entries), len(names))
	}
	nicheRequireNoPanic(t, "FS-001", booted.server)
}

// FS-002: NFC and NFD spellings of the SAME user-visible name are DISTINCT files, as the OS reports them.
// This is deliberately not a claim that the product normalises: sanitize-filename preserves UTF-8 bytes,
// and both CI Linux and this NTFS host store the two encodings separately. A product that normalised would
// collapse two chats into one, which is user-visible data loss.
func TestNicheFSNFCAndNFDNamesAreDistinct(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	avatar := "NormalCard.png"
	nfc := "caf\u00e9"
	nfd := "cafe\u0301"
	if nfc == nfd {
		t.Fatal("the two spellings are identical in Go, so this case could not discriminate")
	}
	if status, body := nicheSaveChat(t, booted.client, avatar, nfc, []map[string]any{{"mes": "NICHE-FS-002-NFC"}}); status != 200 {
		t.Fatalf("save the NFC chat = %d: %s", status, truncateForLog(body, 200))
	}
	if status, body := nicheSaveChat(t, booted.client, avatar, nfd, []map[string]any{{"mes": "NICHE-FS-002-NFD"}}); status != 200 {
		t.Fatalf("save the NFD chat = %d: %s", status, truncateForLog(body, 200))
	}
	directory := tree.chatDir(avatar)
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read the chat directory: %v", err)
	}
	if len(entries) != 2 {
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		t.Fatalf("NFC and NFD were collapsed into %d chat file(s) %v; the two encodings must be two chats", len(entries), names)
	}
	for _, spelling := range []string{nfc, nfd} {
		wantMarker := "NICHE-FS-002-NFC"
		if spelling == nfd {
			wantMarker = "NICHE-FS-002-NFD"
		}
		status, body := nicheGetChat(t, booted.client, avatar, spelling)
		if err := nicheCheckStatus("chats/get "+spelling, status, 200); err != nil {
			t.Fatalf("%v", err)
		}
		if err := nicheCheckContains("chats/get "+spelling, body, wantMarker); err != nil {
			t.Fatalf("%v", err)
		}
	}
}

// FS-003: a 300-byte name, the Windows reserved name CON, and traversal-looking names are all CONTAINED.
// sanitize-filename truncates to 255 BYTES and strips / \ ? < > : * | " plus Windows reserved basenames;
// because the sanitiser runs on `name + ".jsonl"`, a too-long name is truncated to 255 bytes and the
// extension can be lost -- that is the product's current (pinned-library) behaviour and the test pins it.
// CON becomes the empty string and the write is refused (500) rather than writing to a directory path.
func TestNicheFSLongReservedAndTraversalNamesStayContained(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	avatar := "ContainCard.png"
	if status, body := nicheSaveChat(t, booted.client, avatar, strings.Repeat("L", 300), []map[string]any{{"mes": "NICHE-FS-003-LONG"}}); status != 200 {
		t.Fatalf("save the 300-byte name = %d: %s", status, truncateForLog(body, 200))
	}
	directory := tree.chatDir(avatar)
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read the chat directory: %v", err)
	}
	if len(entries) != 1 {
		t.Fatalf("the long-name save produced %d files, want 1", len(entries))
	}
	longName := entries[0].Name()
	if err := nicheCheckFilenameContained("long chat name", longName, directory); err != nil {
		t.Fatalf("%v", err)
	}
	if len(longName) > 255 {
		t.Fatalf("the stored component is %d bytes; a single path component must stay within 255", len(longName))
	}
	if _, getBody := nicheGetChat(t, booted.client, avatar, strings.Repeat("L", 300)); !strings.Contains(getBody, "NICHE-FS-003-LONG") {
		t.Fatalf("the truncated chat name does not read back: %s", truncateForLog(getBody, 200))
	}

	// CON is a Windows reserved basename; sanitize-filename maps it to "" even on Linux, so the pinned
	// observable is a REFUSED write on every host (the target becomes the card directory, not a file).
	if status, _ := nicheSaveChat(t, booted.client, avatar, "CON", []map[string]any{{"mes": "NICHE-FS-003-CON"}}); status == 200 {
		t.Fatalf("save with the reserved name CON answered 200; sanitize-filename must refuse it")
	}
	afterReserved, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read the chat directory after the reserved-name save: %v", err)
	}
	if len(afterReserved) != len(entries) {
		t.Fatalf("the reserved-name save added a file: %d entries before, %d after", len(entries), len(afterReserved))
	}

	// A traversal-looking file name cannot escape: the separator is stripped and the file stays under the
	// card directory.
	if status, body := nicheSaveChat(t, booted.client, avatar, "../escape", []map[string]any{{"mes": "NICHE-FS-003-ESCAPE"}}); status != 200 {
		t.Fatalf("save with the traversal-looking name = %d: %s", status, truncateForLog(body, 200))
	}
	finalEntries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read the chat directory after the traversal-looking save: %v", err)
	}
	escaped := 0
	for _, entry := range finalEntries {
		if err := nicheCheckFilenameContained("traversal-derived name", entry.Name(), directory); err != nil {
			t.Fatalf("%v", err)
		}
		if strings.Contains(entry.Name(), "escape") {
			escaped++
		}
	}
	if escaped != 1 {
		t.Fatalf("the traversal-looking name produced %d entries under the card directory, want exactly 1", escaped)
	}
	// And nothing appeared beside the card directory.
	if err := nicheCheckFilePresence("the traversal-looking save escaped the card directory",
		filepath.Join(tree.dataRoot, "default-user", "chats", "escape.jsonl"), false); err != nil {
		t.Fatalf("%v", err)
	}
}

// FS-004: an EXTERNAL atomic replace (temp file + rename) of settings.json and of a chat file is observed
// on the next read. This is the user editing/restoring a file while the server runs. The settings route is
// memoised by path+mtime+size, so the replacement's NEW mtime is what makes it visible; the chat read has
// no cache at all.
func TestNicheFSExternalAtomicReplaceIsObservedOnNextRead(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)

	documentA := `{"marker":"NICHE-FS-004-A","pad":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}`
	documentB := `{"marker":"NICHE-FS-004-B","pad":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}`
	if status, body := nicheSaveSettings(t, booted.client, documentA); status != 200 {
		t.Fatalf("settings/save A = %d: %s", status, truncateForLog(body, 200))
	}
	if served := nicheSettingsServed(t, booted.client); !strings.Contains(served, "NICHE-FS-004-A") {
		t.Fatalf("the warmed settings do not carry the saved marker: %s", truncateForLog(served, 200))
	}
	// EXTERNAL REPLACE: write a sibling temp file and rename it over the target, which is what an editor or
	// a backup restore does. The target's identity (mtime, size) changes.
	tempPath := filepath.Join(filepath.Dir(tree.settingsPath()), ".niche-external-settings.tmp")
	nicheWriteFile(t, tempPath, []byte(documentB))
	if err := os.Rename(tempPath, tree.settingsPath()); err != nil {
		t.Fatalf("externally replace settings.json: %v", err)
	}
	served := nicheSettingsServed(t, booted.client)
	if err := nicheCheckContains("settings/get after external replace", served, "NICHE-FS-004-B"); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckNotContains("settings/get after external replace", served, "NICHE-FS-004-A"); err != nil {
		t.Fatalf("%v", err)
	}

	// The same for a chat file: the route reads the file on every call.
	avatar := "ExternalCard.png"
	if status, body := nicheSaveChat(t, booted.client, avatar, "external", []map[string]any{{"mes": "NICHE-FS-004-CHAT-A"}}); status != 200 {
		t.Fatalf("chat save = %d: %s", status, truncateForLog(body, 200))
	}
	chatPath := filepath.Join(tree.chatDir(avatar), "external.jsonl")
	replacement := []byte(`{"mes":"NICHE-FS-004-CHAT-B","extra":true}` + "\n")
	chatTemp := filepath.Join(tree.chatDir(avatar), ".niche-external-chat.tmp")
	nicheWriteFile(t, chatTemp, replacement)
	if err := os.Rename(chatTemp, chatPath); err != nil {
		t.Fatalf("externally replace the chat file: %v", err)
	}
	status, body := nicheGetChat(t, booted.client, avatar, "external")
	if err := nicheCheckStatus("chats/get after external replace", status, 200); err != nil {
		t.Fatalf("%v", err)
	}
	expectedChatBody := "[" + strings.TrimSuffix(string(replacement), "\n") + "]"
	if err := nicheCheckBody("chats/get after external replace", body, expectedChatBody); err != nil {
		t.Fatalf("%v", err)
	}
}

// FS-005: the DOCUMENTED RESIDUAL of the settings-aggregation cache. Identity is path+mtime+size
// (settings_cache.go:61-66); a same-size external rewrite that RESTORES the previous mtime is
// indistinguishable from no change and the cached body is served. The second half proves the residual is
// bounded: moving mtime makes the next read see the new bytes. Asserting the stale half is what stops a
// later change from claiming perfect freshness without content hashing.
func TestNicheFSSettingsCacheSameSizeSameMtimeResidualIsPinned(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	documentA := `{"marker":"NICHE-FS-005-A","pad":"1111111111111111111111111111111111111111"}`
	if status, body := nicheSaveSettings(t, booted.client, documentA); status != 200 {
		t.Fatalf("settings/save A = %d: %s", status, truncateForLog(body, 200))
	}
	expectedA := nicheSettingsDocument(t, tree)
	if served := nicheSettingsServed(t, booted.client); served != expectedA {
		t.Fatalf("the warmed settings are not the on-disk document:\n  served %s\n  disk   %s",
			truncateForLog(served, 160), truncateForLog(expectedA, 160))
	}
	info, err := os.Stat(tree.settingsPath())
	if err != nil {
		t.Fatalf("stat settings.json: %v", err)
	}

	documentB := `{"marker":"NICHE-FS-005-B","pad":"2222222222222222222222222222222222222222"}`
	replacement := []byte(documentB)
	if len(replacement) != len(expectedA) {
		// The cache key hashes SIZE and MTIME, so this case is only meaningful when the size is identical;
		// pad with trailing JSON whitespace, which leaves the parsed document identical but the byte count equal.
		if len(replacement) > len(expectedA) {
			t.Fatalf("the replacement document (%d bytes) is longer than the on-disk one (%d bytes); the fixture cannot keep the size equal", len(replacement), len(expectedA))
		}
		replacement = append(replacement, bytes.Repeat([]byte(" "), len(expectedA)-len(replacement))...)
	}
	nicheWriteFile(t, tree.settingsPath(), replacement)
	if err := os.Chtimes(tree.settingsPath(), info.ModTime(), info.ModTime()); err != nil {
		t.Fatalf("restore the settings mtime: %v", err)
	}
	staleServed := nicheSettingsServed(t, booted.client)
	if err := nicheCheckCacheIdentity("same-size same-mtime external rewrite", staleServed == expectedA, true); err != nil {
		t.Fatalf("%v (served %s)", err, truncateForLog(staleServed, 160))
	}
	if err := nicheCheckNotContains("same-size same-mtime external rewrite", staleServed, "NICHE-FS-005-B"); err != nil {
		t.Fatalf("%v", err)
	}

	// BOUNDED: moving mtime by a whole second (coarse filesystems) breaks the identity and the new bytes
	// are served. If this half fails, the cache is stuck rather than merely conservative.
	moved := info.ModTime().Add(2 * time.Second)
	if err := os.Chtimes(tree.settingsPath(), moved, moved); err != nil {
		t.Fatalf("move the settings mtime: %v", err)
	}
	freshServed := nicheSettingsServed(t, booted.client)
	if err := nicheCheckCacheIdentity("mtime moved after the residual", freshServed == expectedA, false); err != nil {
		t.Fatalf("%v (served %s)", err, truncateForLog(freshServed, 160))
	}
	if err := nicheCheckContains("mtime moved after the residual", freshServed, "NICHE-FS-005-B"); err != nil {
		t.Fatalf("%v", err)
	}
}

// FS-006: an UNKNOWN file and UNKNOWN fields survive a product save, a reload and a restart. "Preserve
// unknown fields" (AGENTS hard rule 11) is asserted on three carriers: a file the product never parsed, a
// settings member it does not know, and a chat message member it does not know.
func TestNicheFSUnknownFileAndFieldsSurviveSaveReloadRestart(t *testing.T) {
	tree := newNicheTree(t)
	unknownPath := filepath.Join(tree.userRoot, "files", "NICHE-KEEP.bin")
	unknownBytes := []byte{0x00, 0x01, 0xFE, 'k', 'e', 'e', 'p', 0xFF}
	nicheWriteFile(t, unknownPath, unknownBytes)

	settingsDocument := `{"username":"default-user","niche_unknown":{"nested":[1,{"deep":"KEEP-ME"}]}}`
	chatMessage := map[string]any{
		"name":        "User",
		"is_user":     true,
		"mes":         "NICHE-FS-006-CHAT",
		"niche_extra": map[string]any{"keep": true},
	}
	booted := tree.boot(t, nil)
	if status, body := nicheSaveSettings(t, booted.client, settingsDocument); status != 200 {
		t.Fatalf("settings/save with unknown members = %d: %s", status, truncateForLog(body, 200))
	}
	if status, body := nicheSaveChat(t, booted.client, "UnknownCard.png", "unknown", []map[string]any{chatMessage}); status != 200 {
		t.Fatalf("chat save with an unknown message member = %d: %s", status, truncateForLog(body, 200))
	}
	expectedChatBody := nicheExpectedChatBody(nicheChatLines(t, filepath.Join(tree.chatDir("UnknownCard.png"), "unknown.jsonl")))

	restarted := tree.restart(t)
	onDiskUnknown, err := os.ReadFile(unknownPath)
	if err != nil || !bytes.Equal(onDiskUnknown, unknownBytes) {
		t.Fatalf("the unknown file was changed or removed across save+restart: %v (%d bytes)", err, len(onDiskUnknown))
	}
	served := nicheSettingsServed(t, restarted.client)
	if err := nicheCheckContains("settings after restart", served, "KEEP-ME"); err != nil {
		t.Fatalf("%v", err)
	}
	status, body := nicheGetChat(t, restarted.client, "UnknownCard.png", "unknown")
	if err := nicheCheckStatus("chats/get after restart", status, 200); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckBody("chats/get after restart", body, expectedChatBody); err != nil {
		t.Fatalf("%v: the unknown chat member did not survive the restart", err)
	}
	if err := nicheCheckJSONLLines("chat file after restart", mustReadNicheFile(t, filepath.Join(tree.chatDir("UnknownCard.png"), "unknown.jsonl"))); err != nil {
		t.Fatalf("%v", err)
	}
}

func mustReadNicheFile(t *testing.T, path string) []byte {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read %s: %v", path, err)
	}
	return body
}

// FS-007: EIGHT concurrent sessions create eight distinct chat files with no loss and no interleaving.
// Pinned's chat write is a whole-file atomic replace; the contract is that concurrent surviving sessions
// each get their own file and every file reads back exactly. A lost update would disappear from the
// directory, not from a response.
func TestNicheFSEightSessionsCreateChatsWithoutLoss(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	const sessions = 8
	avatar := "EightCard.png"
	clients := make([]*session, sessions)
	for index := range clients {
		clients[index] = openSession(t, booted.server.origin)
	}
	type result struct {
		index  int
		status int
		body   string
	}
	results := make(chan result, sessions)
	var wait sync.WaitGroup
	for index := range clients {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			status, body := nicheSaveChat(t, clients[index], avatar, "session-"+string(rune('A'+index)),
				[]map[string]any{{"name": "User", "is_user": true, "mes": "NICHE-FS-007-" + string(rune('A'+index))}})
			results <- result{index: index, status: status, body: body}
		}(index)
	}
	wait.Wait()
	close(results)
	for outcome := range results {
		if outcome.status != 200 {
			t.Fatalf("concurrent chat save %d = %d: %s", outcome.index, outcome.status, truncateForLog(outcome.body, 200))
		}
	}
	directory := tree.chatDir(avatar)
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read the chat directory: %v", err)
	}
	if len(entries) != sessions {
		t.Fatalf("eight concurrent sessions produced %d chat files, want %d: a creation was lost", len(entries), sessions)
	}
	for index := 0; index < sessions; index++ {
		name := "session-" + string(rune('A'+index))
		marker := "NICHE-FS-007-" + string(rune('A'+index))
		path := filepath.Join(directory, name+".jsonl")
		if err := nicheCheckFilePresence(name, path, true); err != nil {
			t.Fatalf("%v", err)
		}
		expected := nicheExpectedChatBody(nicheChatLines(t, path))
		status, body := nicheGetChat(t, booted.client, avatar, name)
		if err := nicheCheckStatus("concurrent read "+name, status, 200); err != nil {
			t.Fatalf("%v", err)
		}
		if err := nicheCheckBody("concurrent read "+name, body, expected); err != nil {
			t.Fatalf("%v", err)
		}
		if err := nicheCheckContains("concurrent read "+name, body, marker); err != nil {
			t.Fatalf("%v", err)
		}
	}
}

// FS-008: a settings.json SYMLINK whose target is OUTSIDE the user tree is FOLLOWED for reads but
// REFUSED for writes. Pinned's write-file-atomic resolves the link and writes THROUGH it, modifying a file
// outside the user's directory; GoTavern's SaveSettings resolves the destination and refuses when it
// escapes the resolved user root (ensureResolvedContained, internal/startup/settings_backup.go), answering
// 500 and leaving the link and its target byte-identical. This is a DELIBERATE safer-than-pinned
// containment divergence recorded in docs/SEMANTIC-COMPATIBILITY.md section 18. The read half is pinned
// parity (os.ReadFile follows the link as pinned's fs.readFile does) and is asserted too, so the refusal
// cannot be implemented by refusing to read the file.
func TestNicheFSSymlinkedSettingsFileOutsideTheUserRootIsRefused(t *testing.T) {
	tree := newNicheTree(t)
	targetRoot := t.TempDir()
	target := filepath.Join(targetRoot, "outside-settings.json")
	original := []byte(`{"marker":"NICHE-FS-008-LINK-TARGET"}`)
	nicheWriteFile(t, target, original)
	if err := os.Symlink(target, tree.settingsPath()); err != nil {
		t.Skipf("this host cannot create symlinks (%v); FS-008's POSIX link semantics run on Linux CI. DECLARED SKIP.", err)
	}
	booted := tree.boot(t, nil)
	if served := nicheSettingsServed(t, booted.client); !strings.Contains(served, "NICHE-FS-008-LINK-TARGET") {
		t.Fatalf("the boot did not follow the symlinked settings.json for READS; served: %s", truncateForLog(served, 200))
	}
	if status, body := nicheSaveSettings(t, booted.client, `{"marker":"NICHE-FS-008-NEW-FILE"}`); status != 500 {
		t.Fatalf("settings/save over a settings.json symlink whose target ESCAPES the user root = %d: %s; the containment guard must refuse this write (deliberate safer-than-pinned divergence, SEMANTIC-COMPATIBILITY.md section 18)", status, truncateForLog(body, 200))
	}
	after, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(after, original) {
		t.Fatalf("the refused save modified the link TARGET outside the user tree (target now %q): %v", truncateForLog(string(after), 160), err)
	}
	linkInfo, err := os.Lstat(tree.settingsPath())
	if err != nil {
		t.Fatalf("lstat settings.json after the refused save: %v", err)
	}
	if linkInfo.Mode()&os.ModeSymlink == 0 {
		t.Fatalf("the refused save replaced the symlink entry; a refusal must leave the user's tree unchanged")
	}
	if served := nicheSettingsServed(t, booted.client); !strings.Contains(served, "NICHE-FS-008-LINK-TARGET") {
		t.Fatalf("the settings served after the refused save are not the original link target: %s", truncateForLog(served, 200))
	}
}

// FS-009: a Windows JUNCTION (reparse point) placed where the product will write a chat file is FOLLOWED,
// exactly as pinned Node's fs.writeFile/rename follow it: a junction is a filesystem-level redirection the
// user created inside their own tree, not a server-side path escape, and "safer but different" would break
// parity. The assertion is that the write LANDS IN THE JUNCTION TARGET and the product reads it back, so a
// future change that started refusing reparse points must update this case and record the decision.
// Windows-only semantics: Linux has no junction, so the guard is a DECLARED skip there.
func TestNicheFSJunctionOutsideTheUserRootIsFollowed(t *testing.T) {
	if !nicheHostIsWindows() {
		t.Skip("junctions are a Windows reparse-point concept; this case runs on the Windows host only. DECLARED SKIP.")
	}
	tree := newNicheTree(t)
	outside := t.TempDir()
	avatar := "JunctionCard.png"
	junction := tree.chatDir(avatar)
	if err := os.MkdirAll(filepath.Dir(junction), 0o777); err != nil {
		t.Fatalf("create the chats root: %v", err)
	}
	command := exec.Command("cmd", "/c", "mklink", "/J", junction, outside)
	if output, err := command.CombinedOutput(); err != nil {
		t.Skipf("this host cannot create a junction (%v: %s); the case is a DECLARED SKIP rather than a silent pass", err, strings.TrimSpace(string(output)))
	}
	booted := tree.boot(t, nil)
	status, body := nicheSaveChat(t, booted.client, avatar, "junction", []map[string]any{{"mes": "NICHE-FS-009"}})
	if err := nicheCheckStatus("chat save through a junction", status, 200); err != nil {
		t.Fatalf("%v: pinned's fs layer follows a junction, so refusing one is a behaviour change that must be recorded: %s", err, truncateForLog(body, 200))
	}
	landed := filepath.Join(outside, "junction.jsonl")
	if err := nicheCheckFilePresence("junction target", landed, true); err != nil {
		t.Fatalf("%v: the write did not land in the junction target", err)
	}
	if err := nicheCheckJSONLLines("junction chat", mustReadNicheFile(t, landed)); err != nil {
		t.Fatalf("%v", err)
	}
	readStatus, readBody := nicheGetChat(t, booted.client, avatar, "junction")
	if err := nicheCheckStatus("chat read through a junction", readStatus, 200); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckContains("chat read through a junction", readBody, "NICHE-FS-009"); err != nil {
		t.Fatalf("%v", err)
	}
}

// FS-010: unknown fields are preserved in a settings document saved through the product, byte-for-byte
// against the product's own normalisation (the expectation is the on-disk document, not a hand-written
// one), and JSON key ORDER is preserved by the ordered-JSON writer.
func TestNicheFSSettingsUnknownMembersAndOrderArePreserved(t *testing.T) {
	tree := newNicheTree(t)
	booted := tree.boot(t, nil)
	document := `{"zzz_first":1,"username":"default-user","aaa_last":{"nested":{"b":2,"a":1}}}`
	if status, body := nicheSaveSettings(t, booted.client, document); status != 200 {
		t.Fatalf("settings/save = %d: %s", status, truncateForLog(body, 200))
	}
	onDisk := nicheSettingsDocument(t, tree)
	first := strings.Index(onDisk, `"zzz_first"`)
	last := strings.Index(onDisk, `"aaa_last"`)
	if first < 0 || last < 0 {
		t.Fatalf("an unknown settings member is missing from the saved document: %s", truncateForLog(onDisk, 240))
	}
	if first > last {
		t.Fatalf("the ordered-JSON writer REORDERED the saved members: %s", truncateForLog(onDisk, 240))
	}
	restarted := tree.restart(t)
	served := nicheSettingsServed(t, restarted.client)
	if err := nicheCheckBody("settings/get after restart", served, onDisk); err != nil {
		t.Fatalf("%v", err)
	}
	var decoded map[string]json.RawMessage
	if err := json.Unmarshal([]byte(served), &decoded); err != nil || len(decoded) != 3 {
		t.Fatalf("the restart lost an unknown settings member: %v (%d members)", err, len(decoded))
	}
}
