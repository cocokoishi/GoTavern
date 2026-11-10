package e2e

// THE CHAT-WRITE CRASH MATRIX (gap-sweep row `chats`, P1).
//
// For every chat write a user performs, the process is killed at named points and at seeded random points;
// after each death the disk must hold ONLY a complete old state or a complete new state, and the restart
// must serve exactly that state. The operations and their allowed states:
//
//	save-new-chat      file ABSENT, or the complete new chat
//	append-message     old bytes, or the complete new bytes
//	swipe              old bytes, or the complete new bytes
//	regenerate-write   old bytes, or the complete new bytes
//	branch             the source chat untouched and the branch file ABSENT, or both files complete
//	chat-metadata      old bytes, or the complete new bytes
//	rename-chat        the OLD name XOR the NEW name, complete (never both, never neither, never partial)
//	import             no imported chat, or ONE complete imported chat (never a partial line)
//	delete             the complete old file, or ABSENT
//	group-save         the complete old group chat, or the complete new group chat
//
// BACKUP is deliberately absent: the pinned /api/chats/save backup scheduler is a recorded unimplemented
// gap (internal/server/chats.go:16-22), so there is no product write to crash.
//
// The corpus: the BEFORE image is planted by the test; new bytes come from ONE real successful request per
// operation before any kill (the product's own encoder, not a re-derivation). The randomised point is
// chosen after the write becomes observable (a scratch temp file appears / the target's size changes /
// the renamed file appears), jittered 0..8 ms with the documented seed in chat_crash_harness_test.go.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// crashFillerBytes makes each message large enough that the write phase is measurable (a real long chat's
// final line is this size class). It is not what makes the assertion true: the assertion is old-or-new by
// exact bytes.
const crashFillerBytes = 512 * 1024

func crashText(marker string) string {
	return marker + ":" + strings.Repeat("x", crashFillerBytes)
}

func crashHeader() map[string]any {
	return map[string]any{"user_name": "User", "character_name": crashAvatar, "chat_metadata": map[string]any{}}
}

// saveCase is every operation shape that ends in one chat file written through /api/chats/save.
type saveCase struct {
	name        string
	fileName    string
	oldFileName string // "" when the old state has no chat file (save-new-chat)
	oldMessages []map[string]any
	newMessages []map[string]any
	iterations  int
	// force is sent as body.force. Pinned's trySaveChat refuses an overwrite whose
	// chat_metadata.integrity does not match the stored file unless force is truthy
	// (src/endpoints/chats.js:532-543, alpha.20 audit A20-D), so a scenario that
	// deliberately changes integrity must take the forced path pinned uses for it.
	force bool
}

func saveCases() []saveCase {
	oldChat := []map[string]any{
		crashHeader(),
		{"name": "User", "is_user": true, "mes": crashText("old-user")},
		{"name": crashAvatar, "is_user": false, "mes": crashText("old-reply")},
	}
	return []saveCase{
		{
			name:     "save-new-chat",
			fileName: "new-chat",
			newMessages: []map[string]any{
				crashHeader(),
				{"name": "User", "is_user": true, "mes": crashText("first")},
				{"name": crashAvatar, "is_user": false, "mes": crashText("reply")},
			},
			iterations: 10,
		},
		{
			name:        "append-message",
			fileName:    "chat",
			oldFileName: "chat",
			oldMessages: oldChat,
			newMessages: []map[string]any{
				crashHeader(),
				{"name": "User", "is_user": true, "mes": crashText("old-user")},
				{"name": crashAvatar, "is_user": false, "mes": crashText("old-reply")},
				{"name": "User", "is_user": true, "mes": crashText("appended")},
			},
			iterations: 20,
		},
		{
			name:        "swipe",
			fileName:    "chat",
			oldFileName: "chat",
			oldMessages: []map[string]any{
				crashHeader(),
				{"name": crashAvatar, "is_user": false, "mes": crashText("swipe-one"), "swipes": []string{crashText("swipe-one"), crashText("swipe-two")}, "swipe_id": 0},
			},
			newMessages: []map[string]any{
				crashHeader(),
				{"name": crashAvatar, "is_user": false, "mes": crashText("swipe-two"), "swipes": []string{crashText("swipe-one"), crashText("swipe-two")}, "swipe_id": 1},
			},
			iterations: 10,
		},
		{
			name:        "regenerate-write",
			fileName:    "chat",
			oldFileName: "chat",
			oldMessages: []map[string]any{
				crashHeader(),
				{"name": "User", "is_user": true, "mes": crashText("prompt")},
				{"name": crashAvatar, "is_user": false, "mes": crashText("first-generation")},
			},
			newMessages: []map[string]any{
				crashHeader(),
				{"name": "User", "is_user": true, "mes": crashText("prompt")},
				{"name": crashAvatar, "is_user": false, "mes": crashText("regenerated")},
			},
			iterations: 10,
		},
		{
			name:        "branch",
			fileName:    "chat-branch",
			oldFileName: "chat",
			oldMessages: []map[string]any{
				crashHeader(),
				{"name": "User", "is_user": true, "mes": crashText("source")},
			},
			newMessages: []map[string]any{
				crashHeader(),
				{"name": "User", "is_user": true, "mes": crashText("source")},
				{"name": "User", "is_user": true, "mes": crashText("branch-from-here")},
			},
			iterations: 10,
		},
		{
			name:        "chat-metadata-mutation",
			fileName:    "chat",
			oldFileName: "chat",
			oldMessages: []map[string]any{
				{"user_name": "User", "character_name": crashAvatar, "chat_metadata": map[string]any{"integrity": "old"}},
				{"name": crashAvatar, "is_user": false, "mes": crashText("body")},
			},
			newMessages: []map[string]any{
				{"user_name": "User", "character_name": crashAvatar, "chat_metadata": map[string]any{"integrity": "new", "note": crashText("metadata")}},
				{"name": crashAvatar, "is_user": false, "mes": crashText("body")},
			},
			iterations: 10,
			// The scenario deliberately replaces chat_metadata.integrity, so it takes
			// the FORCED overwrite path: pinned answers 400 {"error":"integrity"} without
			// force (src/endpoints/chats.js:535-540). The crash-atomicity question is
			// unchanged; this keeps the case testing the product's pinned path.
			force: true,
		},
	}
}

func (scenario saveCase) oldState(t *testing.T) state {
	t.Helper()
	if scenario.oldMessages == nil {
		return state{}
	}
	return state{scenario.oldFileName + ".jsonl": chatPayload(t, scenario.oldMessages)}
}

// TestChatWriteCrashAtomicityRandomised drives each save-shaped operation through hard kills at a seeded
// random point inside the write and checks every crash state and every restart.
func TestChatWriteCrashAtomicityRandomised(t *testing.T) {
	buildFaultBinary(t)
	for _, scenario := range saveCases() {
		scenario := scenario
		t.Run(scenario.name, func(t *testing.T) {
			tree := newCrashTree(t)
			oldState := scenario.oldState(t)
			tree.resetTo(t, oldState)

			// Control: one real success on this tree captures the product's own NEW bytes.
			client := tree.boot(t, "", false)
			status, response, err := client.post("/api/chats/save", saveBody(t, scenario.fileName, scenario.newMessages, scenario.force))
			if err != nil || status != http.StatusOK {
				t.Fatalf("control save = %d (%v), want 200: %s", status, err, response)
			}
			newState := tree.chatFiles(t)
			if len(newState) == 0 {
				t.Fatalf("the control save produced no chat file; the case cannot assert a new state")
			}
			lastState := newState
			completed, midWrite := 0, 0
			for iteration := 0; iteration < scenario.iterations; iteration++ {
				if iteration > 0 {
					client.server.stop()
					client = tree.boot(t, "", false)
					if after := tree.chatFiles(t); !equalStates(after, lastState) {
						t.Fatalf("iteration %d: the restart after a crash changed the state.\n  crashed: %s\n  after:   %s",
							iteration, describeState(lastState), describeState(after))
					}
				}
				tree.resetTo(t, oldState)
				existing := ""
				oldSize := 0
				if body, present := oldState[scenario.fileName+".jsonl"]; present {
					existing = scenario.fileName + ".jsonl"
					oldSize = len(body)
				}
				crashed := tree.killDuringSave(t, client, iteration, scenario.fileName, scenario.newMessages, existing, oldSize, scenario.force)
				if crashed {
					midWrite++
				} else {
					completed++
				}
				crashState := requireOneOf(t, tree, oldState, newState)
				lastState = crashState
			}
			t.Logf("%s: %d randomised kills (%d landed inside the write, %d completed before the kill), seed %d",
				scenario.name, scenario.iterations, midWrite, completed, crashSeed)
			client.server.stop()
			tree.restartAndCheck(t, lastState, scenario.fileName)
		})
	}
}

// killDuringSave sends one save, waits until the write is observable, jitters, and hard-kills. It reports
// whether the kill happened (false: the request completed first and the caller asserts the complete new
// state).
func (tree *crashTree) killDuringSave(t *testing.T, client *crashClient, iteration int, fileName string, messages []map[string]any, existingFile string, existingSize int, force bool) bool {
	t.Helper()
	body := saveBody(t, fileName, messages)
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _, _ = client.post("/api/chats/save", body)
	}()
	return tree.killWhenProgress(t, client, iteration, done, func() bool {
		if tree.writeInFlight(t, existingFile, existingSize) {
			return true
		}
		if existingFile == "" {
			if _, present := tree.chatEntries(t)[fileName+".jsonl"]; present {
				return true
			}
		}
		return false
	})
}

// killWhenProgress waits for the operation to become observable, jitters with the documented seed, and
// kills unless the request already finished.
func (tree *crashTree) killWhenProgress(t *testing.T, client *crashClient, iteration int, done <-chan struct{}, progress func() bool) bool {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		select {
		case <-done:
			return false
		default:
		}
		if progress() {
			break
		}
		time.Sleep(200 * time.Microsecond)
	}
	time.Sleep(time.Duration(crashRand(iteration).Intn(8)) * time.Millisecond)
	select {
	case <-done:
		return false
	default:
	}
	hardKill(t, client.server)
	select {
	case <-done:
	case <-time.After(30 * time.Second):
		t.Fatalf("iteration %d: the request did not return after the hard kill", iteration)
	}
	return true
}

// TestChatRenameCrashAtomicity covers /api/chats/rename, whose crash window is the one this lane found:
// the pinned handler (and the GoTavern port before this change) copies the file and then unlinks the
// original, so a kill between the two steps leaves BOTH names. A single rename leaves exactly one.
func TestChatRenameDeterministicCrashPoints(t *testing.T) {
	buildFaultBinary(t)
	oldBody := chatPayload(t, []map[string]any{
		crashHeader(),
		{"name": crashAvatar, "is_user": false, "mes": crashText("rename-body")},
	})
	oldName, newName := "chat.jsonl", "chat-renamed.jsonl"
	renameBody := `{"avatar_url":"` + crashAvatar + `.png","original_file":"` + oldName + `","renamed_file":"` + newName + `"}`
	oldState := state{oldName: oldBody}
	newState := state{newName: oldBody}

	for _, point := range []struct {
		label string
		want  state
	}{
		{label: "chats.rename.before-rename", want: oldState},
		{label: "chats.rename.after-rename", want: newState},
	} {
		point := point
		t.Run("deterministic-"+point.label, func(t *testing.T) {
			tree := newCrashTree(t)
			tree.resetTo(t, oldState)
			client := tree.boot(t, point.label, true)
			tree.arm(t)
			go func() { _, _, _ = client.post("/api/chats/rename", renameBody) }()
			waitForFaultExit(t, client, point.label)
			crashState := requireOneOf(t, tree, oldState, newState)
			requireExactState(t, crashState, point.want, point.label)
			tree.restartAndCheck(t, crashState, "")
		})
	}

}

// TestChatRenameRandomisedKills drives /api/chats/rename through hard kills at seeded points after the
// destination becomes visible, and requires the old name XOR the new name after every one.
func TestChatRenameRandomisedKills(t *testing.T) {
	buildFaultBinary(t)
	oldBody := chatPayload(t, []map[string]any{
		crashHeader(),
		{"name": crashAvatar, "is_user": false, "mes": crashText("rename-body")},
	})
	oldName, newName := "chat.jsonl", "chat-renamed.jsonl"
	renameBody := `{"avatar_url":"` + crashAvatar + `.png","original_file":"` + oldName + `","renamed_file":"` + newName + `"}`
	oldState := state{oldName: oldBody}
	newState := state{newName: oldBody}

	tree := newCrashTree(t)
	tree.resetTo(t, oldState)
	client := tree.boot(t, "", false)
	status, response, err := client.post("/api/chats/rename", renameBody)
	if err != nil || status != http.StatusOK {
		t.Fatalf("control rename = %d (%v), want 200: %s", status, err, response)
	}
	if after := tree.chatFiles(t); !equalStates(after, newState) {
		t.Fatalf("the control rename produced %s, want exactly %s", describeState(after), describeState(newState))
	}
	lastState := newState
	completed, midWrite := 0, 0
	for iteration := 0; iteration < 15; iteration++ {
		if iteration > 0 {
			client.server.stop()
			client = tree.boot(t, "", false)
			if after := tree.chatFiles(t); !equalStates(after, lastState) {
				t.Fatalf("iteration %d: the restart after a rename crash changed the state.\n  crashed: %s\n  after:   %s",
					iteration, describeState(lastState), describeState(after))
			}
		}
		tree.resetTo(t, oldState)
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _, _ = client.post("/api/chats/rename", renameBody)
		}()
		crashed := tree.killWhenProgress(t, client, iteration, done, func() bool {
			_, present := tree.chatEntries(t)[newName]
			return present
		})
		<-done
		if crashed {
			midWrite++
		} else {
			completed++
		}
		lastState = requireOneOf(t, tree, oldState, newState)
	}
	t.Logf("rename: 15 randomised kills (%d sampled the in-flight window, %d completed before the kill), seed %d",
		midWrite, completed, crashSeed)
	client.server.stop()
	tree.restartAndCheck(t, lastState, "")
}

// TestChatDeleteCrashAtomicity: a kill during /api/chats/delete leaves the complete old file or no file.
func TestChatDeleteDeterministicCrashPoint(t *testing.T) {
	buildFaultBinary(t)
	oldBody := chatPayload(t, []map[string]any{
		crashHeader(),
		{"name": crashAvatar, "is_user": false, "mes": crashText("delete-body")},
	})
	fileName := "chat.jsonl"
	oldState := state{fileName: oldBody}
	empty := state{}
	deleteBody := `{"avatar_url":"` + crashAvatar + `.png","chatfile":"` + fileName + `"}`

	t.Run("deterministic-after-remove", func(t *testing.T) {
		tree := newCrashTree(t)
		tree.resetTo(t, oldState)
		client := tree.boot(t, "chats.delete.after-remove", true)
		tree.arm(t)
		go func() { _, _, _ = client.post("/api/chats/delete", deleteBody) }()
		waitForFaultExit(t, client, "chats.delete.after-remove")
		crashState := requireOneOf(t, tree, oldState, empty)
		requireExactState(t, crashState, empty, "chats.delete.after-remove")
		tree.restartAndCheck(t, crashState, "")
	})

}

// TestChatDeleteRandomisedKills drives /api/chats/delete through hard kills and requires the complete old
// file or no file.
func TestChatDeleteRandomisedKills(t *testing.T) {
	buildFaultBinary(t)
	oldBody := chatPayload(t, []map[string]any{
		crashHeader(),
		{"name": crashAvatar, "is_user": false, "mes": crashText("delete-body")},
	})
	fileName := "chat.jsonl"
	oldState := state{fileName: oldBody}
	empty := state{}
	deleteBody := `{"avatar_url":"` + crashAvatar + `.png","chatfile":"` + fileName + `"}`

	tree := newCrashTree(t)
	tree.resetTo(t, oldState)
	client := tree.boot(t, "", false)
	if status, response, err := client.post("/api/chats/delete", deleteBody); err != nil || status != http.StatusOK {
		t.Fatalf("control delete = %d (%v), want 200: %s", status, err, response)
	}
	if after := tree.chatFiles(t); !equalStates(after, empty) {
		t.Fatalf("the control delete left %s, want no chat file", describeState(after))
	}
	lastState := empty
	for iteration := 0; iteration < 10; iteration++ {
		if iteration > 0 {
			client.server.stop()
			client = tree.boot(t, "", false)
			if after := tree.chatFiles(t); !equalStates(after, lastState) {
				t.Fatalf("iteration %d: the restart after a delete crash changed the state", iteration)
			}
		}
		tree.resetTo(t, oldState)
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _, _ = client.post("/api/chats/delete", deleteBody)
		}()
		_ = tree.killWhenProgress(t, client, iteration, done, func() bool {
			_, present := tree.chatEntries(t)[fileName]
			return !present
		})
		<-done
		lastState = requireOneOf(t, tree, oldState, empty)
	}
	t.Logf("delete: 10 randomised kills, seed %d", crashSeed)
	client.server.stop()
	tree.restartAndCheck(t, lastState, "")
}

// TestChatImportCrashAtomicity covers the multipart import, whose file NAME contains a timestamp, so the
// assertion is structural (no file, or ONE complete imported JSONL) rather than byte identity with a
// captured name.
func TestChatImportDeterministicCrashPoint(t *testing.T) {
	buildFaultBinary(t)
	imported := crashImportPayload()

	t.Run("deterministic-after-write", func(t *testing.T) {
		tree := newCrashTree(t)
		client := tree.boot(t, "chats.import.after-write", true)
		tree.arm(t)
		importedBody, contentType := importBody(t, imported)
		go func() { _, _, _ = client.postMultipart("/api/chats/import", contentType, importedBody) }()
		waitForFaultExit(t, client, "chats.import.after-write")
		crashState := verifyImportState(t, tree)
		if len(crashState) != 1 {
			t.Fatalf("the import wrote no file before its after-write point; the label is not where it claims")
		}
		tree.restartAndCheck(t, crashState, "")
	})
}

// TestChatImportRandomisedKills drives the multipart import through hard kills and requires no imported
// chat or ONE complete imported chat after each.
func TestChatImportRandomisedKills(t *testing.T) {
	buildFaultBinary(t)
	imported := crashImportPayload()
	tree := newCrashTree(t)
	client := tree.boot(t, "", false)
	lastState := state{}
	for iteration := 0; iteration < 10; iteration++ {
		if iteration > 0 {
			client.server.stop()
			client = tree.boot(t, "", false)
			if after := tree.chatFiles(t); !equalStates(after, lastState) {
				t.Fatalf("iteration %d: the restart after an import crash changed the state", iteration)
			}
		}
		tree.resetTo(t, state{})
		importedBody, contentType := importBody(t, imported)
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _, _ = client.postMultipart("/api/chats/import", contentType, importedBody)
		}()
		_ = tree.killWhenProgress(t, client, iteration, done, func() bool {
			return len(tree.chatEntries(t)) > 0 || progressIn(t, tree.chatDir)
		})
		<-done
		lastState = verifyImportState(t, tree)
	}
	t.Logf("import: 10 randomised kills, seed %d", crashSeed)
	client.server.stop()
	tree.restartAndCheck(t, lastState, "")
}

// crashImportPayload is the JSONL body /api/chats/import converts: a header line plus two messages.
func crashImportPayload() []byte {
	return []byte(`{"user_name":"User","character_name":"` + crashAvatar + `","chat_metadata":{}}` + "\n" +
		`{"name":"User","is_user":true,"mes":"imported line one"}` + "\n" +
		`{"name":"` + crashAvatar + `","is_user":false,"mes":"imported line two"}`)
}

// verifyImportState requires at most one imported file, with the imported name and its last line present.
func verifyImportState(t *testing.T, tree *crashTree) state {
	t.Helper()
	files := tree.chatFiles(t)
	if len(files) > 1 {
		t.Fatalf("an import crash left %d chat files, want at most one complete import: %s",
			len(files), describeState(files))
	}
	for name, fileBody := range files {
		if !strings.Contains(name, " imported.jsonl") {
			t.Fatalf("an import crash left a chat file that is not the imported name: %s", name)
		}
		if !strings.Contains(string(fileBody), "imported line two") {
			t.Fatalf("the imported chat is incomplete: it does not carry the last imported line (name %s)", name)
		}
	}
	return files
}

// TestChatSaveDeterministicPoints kills the save at each named point in the atomic replacement and requires
// the state the point implies: before the rename the OLD file, after it the NEW one.
func TestChatSaveDeterministicPoints(t *testing.T) {
	buildFaultBinary(t)
	oldMessages := []map[string]any{
		crashHeader(),
		{"name": crashAvatar, "is_user": false, "mes": crashText("deterministic-old")},
	}
	newMessages := []map[string]any{
		crashHeader(),
		{"name": crashAvatar, "is_user": false, "mes": crashText("deterministic-new")},
	}
	fileName := "chat.jsonl"
	oldState := state{fileName: chatPayload(t, oldMessages)}
	newState := state{fileName: chatPayload(t, newMessages)}

	for _, point := range []struct {
		label string
		want  state
	}{
		{label: "chats.save.before-write", want: oldState},
		{label: "atomicReplace.after-temp-write", want: oldState},
		{label: "atomicReplace.after-temp-sync", want: oldState},
		{label: "atomicReplace.after-rename", want: newState},
		{label: "chats.save.after-write", want: newState},
	} {
		point := point
		t.Run(point.label, func(t *testing.T) {
			tree := newCrashTree(t)
			tree.resetTo(t, oldState)
			client := tree.boot(t, point.label, true)
			tree.arm(t)
			go func() {
				_, _, _ = client.post("/api/chats/save", saveBody(t, "chat", newMessages))
			}()
			waitForFaultExit(t, client, point.label)
			crashState := requireOneOf(t, tree, oldState, newState)
			requireExactState(t, crashState, point.want, point.label)
			tree.restartAndCheck(t, crashState, "chat")
		})
	}
}

// TestChatGroupSaveCrashAtomicity covers the group-chat JSONL write through /api/chats/group/save.
func TestChatGroupSaveCrashAtomicity(t *testing.T) {
	buildFaultBinary(t)
	oldBody := chatPayload(t, []map[string]any{
		crashHeader(),
		{"name": "User", "is_user": true, "mes": crashText("group-old")},
	})
	newMessages := []map[string]any{
		crashHeader(),
		{"name": "User", "is_user": true, "mes": crashText("group-old")},
		{"name": "GroupMember", "is_user": false, "mes": crashText("group-new")},
	}
	groupID := "crash-group"
	saveBodyJSON, err := json.Marshal(map[string]any{"id": groupID, "chat": newMessages})
	if err != nil {
		t.Fatal(err)
	}

	tree := newCrashTree(t)
	groupChats, err := groupChatsDir(tree)
	if err != nil {
		t.Fatalf("resolve the group chats directory: %v", err)
	}
	if err := os.MkdirAll(groupChats, 0o777); err != nil {
		t.Fatal(err)
	}
	groupFile := filepath.Join(groupChats, groupID+".jsonl")
	if err := os.WriteFile(groupFile, oldBody, 0o600); err != nil {
		t.Fatal(err)
	}
	oldState := treeFilesIn(t, groupChats)
	client := tree.boot(t, "", false)
	status, response, callErr := client.post("/api/chats/group/save", string(saveBodyJSON))
	if callErr != nil || status != http.StatusOK {
		t.Fatalf("control group save = %d (%v), want 200: %s", status, callErr, response)
	}
	newState := treeFilesIn(t, groupChats)
	lastState := newState
	for iteration := 0; iteration < 10; iteration++ {
		if iteration > 0 {
			client.server.stop()
			client = tree.boot(t, "", false)
			if after := treeFilesIn(t, groupChats); !equalStates(after, lastState) {
				t.Fatalf("iteration %d: the restart after a group-save crash changed the state", iteration)
			}
		}
		if err := os.WriteFile(groupFile, oldBody, 0o600); err != nil {
			t.Fatal(err)
		}
		done := make(chan struct{})
		go func() {
			defer close(done)
			_, _, _ = client.post("/api/chats/group/save", string(saveBodyJSON))
		}()
		_ = tree.killWhenProgress(t, client, iteration, done, func() bool {
			return progressIn(t, groupChats)
		})
		<-done
		lastState = requireOneOfIn(t, groupChats, oldState, newState)
	}
	t.Logf("group save: 10 randomised kills, seed %d", crashSeed)
}

func groupChatsDir(tree *crashTree) (string, error) {
	directories, err := startup.DirectoriesForUser(tree.dataRoot, "default-user")
	if err != nil {
		return "", err
	}
	return directories["groupChats"], nil
}

// treeFilesIn is chatFiles for an arbitrary directory (group chats live outside the character folder).
func treeFilesIn(t *testing.T, directory string) state {
	t.Helper()
	files := state{}
	entries, err := os.ReadDir(directory)
	if os.IsNotExist(err) {
		return files
	}
	if err != nil {
		t.Fatalf("read %s: %v", directory, err)
	}
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || strings.HasPrefix(name, ".") || !strings.HasSuffix(name, ".jsonl") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(directory, name))
		if err != nil {
			t.Fatalf("read %s: %v", name, err)
		}
		if len(body) == 0 {
			t.Fatalf("%s is ZERO BYTES after the crash", name)
		}
		for index, line := range strings.Split(string(body), "\n") {
			if !json.Valid([]byte(line)) {
				t.Fatalf("%s line %d is not valid JSON after the crash", name, index)
			}
		}
		files[name] = body
	}
	return files
}

func requireOneOfIn(t *testing.T, directory string, allowed ...state) state {
	t.Helper()
	got := treeFilesIn(t, directory)
	for _, candidate := range allowed {
		if equalStates(got, candidate) {
			return got
		}
	}
	t.Fatalf("%s is not one of the complete states.\n  got:     %s\n  allowed: %s",
		directory, describeState(got), describeStates(allowed))
	return nil
}

func progressIn(t *testing.T, directory string) bool {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		return false
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".gotavern-content-log-") {
			return true
		}
	}
	return false
}

func requireExactState(t *testing.T, got, want state, label string) {
	t.Helper()
	if !equalStates(got, want) {
		t.Fatalf("at the injected point %q the state is %s, want exactly %s (before the rename the old file, "+
			"after it the new one)", label, describeState(got), describeState(want))
	}
}
