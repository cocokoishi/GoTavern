package e2e

// NICHE PERSISTENCE FAULT INJECTION (alpha.17; domain IDs PE-001..PE-003).
//
// The production write path is killed at each AVAILABLE seam and the case asserts the crash-atomicity
// contract at the filesystem boundary:
//
//  1. the target file is EXACTLY the complete old document or EXACTLY the complete new one -- never a prefix;
//  2. any leftover scratch file is DOT-PREFIXED (clearly not user data) and the restart does not treat it as
//     a document;
//  3. the restart still loads and serves parseable data, unchanged from the crashed bytes;
//  4. no cross-user tree was touched.
//
// The seams are the ones the production code actually has (grep of faultinject.Hit):
//
//	atomicReplace.after-temp-write   settings save AND chat save (startup/atomicReplace)
//	atomicReplace.after-temp-sync    settings save AND chat save
//	atomicReplace.after-rename       settings save AND chat save
//	chats.save.before-write          chat save
//	chats.save.after-write           chat save
//	chats.import.after-write         chat import
//
// STAGES WITH NO SEAM, recorded rather than faked: there is no seam between the settings-save body read and
// its validation, none inside the settings BACKUP snapshot that a settings save schedules on a timer, and
// none for the group-chat JSONL append path from this route family. Those are listed as UNEXECUTED in
// docs/alpha17/new-test-evidence.md; inventing a seam would mean shipping a test hook the product does not
// have.
//
// The fault binary is built with `-tags gotavern_faults` once per process and the arm file is created only
// AFTER readiness, exactly as chat_crash_harness_test.go does, so boot-time writes cannot be the thing that
// crashes.

import (
	"bytes"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// nicheCrashTree is one release-shaped tree whose before-image the case plants.
type nicheCrashTree struct {
	installRoot string
	dataRoot    string
	userRoot    string
	armPath     string
}

func newNicheCrashTree(t *testing.T) *nicheCrashTree {
	t.Helper()
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(userRoot, 0o777); err != nil {
		t.Fatalf("create the default user root: %v", err)
	}
	return &nicheCrashTree{
		installRoot: installRoot,
		dataRoot:    dataRoot,
		userRoot:    userRoot,
		armPath:     filepath.Join(installRoot, "fault-arm"),
	}
}

// boot boots the fault-tagged binary with the named label armed ON `arm()`, or with no fault when label is
// empty. GOTAVERN_BINARY must be set in THIS process (resolveBinary reads it here and copies the binary), which
// is why the tree sets it rather than only passing it to the child.
func (tree *nicheCrashTree) boot(t *testing.T, label string) (*serverProcess, *session) {
	t.Helper()
	_ = os.Remove(tree.armPath)
	t.Setenv("GOTAVERN_BINARY", buildFaultBinary(t))
	environment := map[string]string{}
	if label != "" {
		environment[faultAtEnv] = label
		environment[faultArmEnv] = tree.armPath
	}
	server := bootServerIn(t, tree.installRoot, tree.installRoot, tree.dataRoot, environment)
	return server, openSession(t, server.origin)
}

// arm creates the arm file AFTER readiness so only the request under test can trigger the crash.
func (tree *nicheCrashTree) arm(t *testing.T) {
	t.Helper()
	if err := os.WriteFile(tree.armPath, []byte("armed"), 0o600); err != nil {
		t.Fatalf("arm the fault hook: %v", err)
	}
}

// waitForFaultExit requires the process to die from the injected label. A label that never fires leaves the
// case asserting a state it never reached, so it is a FATAL result, not a skip.
func nicheWaitForFaultExit(t *testing.T, server *serverProcess, label string) {
	t.Helper()
	select {
	case <-server.exitCh:
	case <-time.After(30 * time.Second):
		t.Fatalf("the fault label %q never crashed the process, so the %s stage is not on this request's write path\n%s",
			label, label, server.diagnostic())
	}
}

// nicheNonDotScratch fails when a scratch file that is NOT dot-prefixed is left in the directory: such a file
// would appear in the user's file listing and could be read as a document.
func nicheNonDotScratch(t *testing.T, directory string) error {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil
	}
	for _, entry := range entries {
		if entry.IsDir() || !entry.Type().IsRegular() {
			continue
		}
		name := entry.Name()
		if strings.HasSuffix(name, ".tmp") && !strings.HasPrefix(name, settingsScratchPrefix) {
			return os.ErrInvalid
		}
		if strings.Contains(name, ".gotavern-") && !strings.HasPrefix(name, settingsScratchPrefix) {
			return os.ErrInvalid
		}
	}
	return nil
}

// nicheSaveChatTolerant submits a chat save whose transport failure is EXPECTED (the process is about to be
// killed), so the crash case reports the error instead of failing the test from the helper.
func nicheSaveChatTolerant(t *testing.T, client *session, avatarURL, fileName string, messages []map[string]any) error {
	t.Helper()
	body, err := marshalJSON(map[string]any{"avatar_url": avatarURL, "file_name": fileName, "chat": messages})
	if err != nil {
		t.Fatalf("encode the chat save body: %v", err)
	}
	request, err := http.NewRequest(http.MethodPost, client.origin+"/api/chats/save", strings.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	if client.cookie != "" {
		request.Header.Set("Cookie", client.cookie)
	}
	if client.token != "" {
		request.Header.Set("X-CSRF-Token", client.token)
	}
	response, err := client.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	_, _ = bytes.NewBuffer(nil).ReadFrom(response.Body)
	return nil
}

// PE-001: settings save killed at each atomicReplace stage. after-temp-write and after-temp-sync leave the
// OLD document published (the temp file was never renamed); after-rename leaves the NEW document. Each case
// also restarts and proves the crashed bytes are what the product serves and that a subsequent save works.
func TestNichePersistenceSettingsSaveCrashStages(t *testing.T) {
	cases := []struct {
		label        string
		wantNew      bool
		wantScratch  bool
		stageComment string
	}{
		{"atomicReplace.after-temp-write", false, true, "the temp file exists but has not been renamed; the published document is the OLD one"},
		{"atomicReplace.after-temp-sync", false, true, "the temp file is durable but unrenamed; the published document is still the OLD one"},
		{"atomicReplace.after-rename", true, false, "the rename published the NEW document before the crash"},
	}
	for _, scenario := range cases {
		scenario := scenario
		t.Run(scenario.label, func(t *testing.T) {
			tree := newNicheCrashTree(t)
			oldDocument := []byte(`{"marker":"PE-001-OLD","pad":"` + strings.Repeat("o", 32<<10) + `"}`)
			if err := os.WriteFile(filepath.Join(tree.userRoot, "settings.json"), oldDocument, 0o600); err != nil {
				t.Fatalf("plant the old settings: %v", err)
			}
			// A second user tree: the crash and the restart must not touch it.
			otherUser := filepath.Join(tree.dataRoot, "second-user", "settings.json")
			otherBytes := []byte(`{"marker":"PE-001-OTHER-USER"}`)
			nicheWriteFile(t, otherUser, otherBytes)

			newBody := []byte(`{"marker":"PE-001-NEW","pad":"` + strings.Repeat("n", 32<<10) + `"}`)
			expectedNew, err := startup.FormatSettingsJSON(newBody)
			if err != nil {
				t.Fatalf("normalise the new settings: %v", err)
			}
			server, client := tree.boot(t, scenario.label)
			tree.arm(t)
			if _, _, _, _ = postTolerantJSON(client, "/api/settings/save", string(newBody)); true {
				// The request either completes just before the crash or loses the connection; the crash seam is
				// what decides, so the result is not asserted here.
			}
			nicheWaitForFaultExit(t, server, scenario.label)
			if strings.Contains(server.stderr.String(), "panic") {
				t.Fatalf("the child panicked instead of exiting at %s:\n%s", scenario.label, server.diagnostic())
			}

			crashed, err := os.ReadFile(filepath.Join(tree.userRoot, "settings.json"))
			if err != nil {
				t.Fatalf("%s: settings.json is MISSING after the killed save: %v", scenario.label, err)
			}
			if scenario.wantNew {
				if err := nicheCheckBody(scenario.label, string(crashed), string(expectedNew)); err != nil {
					t.Fatalf("%v (%s)", err, scenario.stageComment)
				}
			} else {
				if err := nicheCheckBody(scenario.label, string(crashed), string(oldDocument)); err != nil {
					t.Fatalf("%v (%s)", err, scenario.stageComment)
				}
			}
			if err := nicheCheckCrashState(scenario.label, crashed, oldDocument, expectedNew); err != nil {
				t.Fatalf("%v", err)
			}
			if scenario.wantScratch {
				if scratch := nicheScratchFiles(t, tree.userRoot); len(scratch) == 0 {
					t.Fatalf("%s: no dot-prefixed scratch file survived, so the case did not sample the stage the label names",
						scenario.label)
				}
			}
			if err := nicheNonDotScratch(t, tree.userRoot); err != nil {
				t.Fatalf("%s: a non-dot scratch file was left in the user root; a partial write must be clearly identified", scenario.label)
			}
			if other, readErr := os.ReadFile(otherUser); readErr != nil || !bytes.Equal(other, otherBytes) {
				t.Fatalf("%s: the crash or restart touched another user's tree: %v (%q)", scenario.label, readErr, truncateForLog(string(other), 120))
			}

			// RESTART: the crashed bytes are served unchanged and a subsequent save still works.
			restarted, restartedClient := tree.boot(t, "")
			if strings.Contains(restarted.stderr.String(), "panic") {
				t.Fatalf("%s: the restarted server panicked:\n%s", scenario.label, restarted.diagnostic())
			}
			served := nicheSettingsServed(t, restartedClient)
			if served != string(crashed) {
				t.Fatalf("%s: the restart CHANGED the crashed settings.\n  crashed: %s\n  served:  %s",
					scenario.label, truncateForLog(string(crashed), 160), truncateForLog(served, 160))
			}
			if status, body := nicheSaveSettings(t, restartedClient, `{"marker":"PE-001-AFTER-RESTART"}`); status != 200 {
				t.Fatalf("%s: the first save after the restart = %d: %s", scenario.label, status, truncateForLog(body, 200))
			}
			servedAfter := nicheSettingsServed(t, restartedClient)
			if err := nicheCheckContains("save after restart", servedAfter, "PE-001-AFTER-RESTART"); err != nil {
				t.Fatalf("%s: %v", scenario.label, err)
			}
		})
	}
}

// PE-002: chat save killed before the write and after the write. The before-image is a chat file the test
// plants; the new bytes are derived from a CONTROL save of the same messages (the product's own JSONL
// encoding), so no second serialiser is involved. Both cases restart and read the chat through the route.
func TestNichePersistenceChatSaveCrashStages(t *testing.T) {
	messages := []map[string]any{
		{"name": "User", "is_user": true, "mes": "PE-002-NEW-1"},
		{"name": "Char", "is_user": false, "mes": "PE-002-NEW-2"},
	}
	cases := []struct {
		label   string
		wantNew bool
	}{
		{"chats.save.before-write", false},
		{"chats.save.after-write", true},
	}
	for _, scenario := range cases {
		scenario := scenario
		t.Run(scenario.label, func(t *testing.T) {
			tree := newNicheCrashTree(t)
			chatDirectory := filepath.Join(tree.userRoot, "chats", "FaultCard")
			if err := os.MkdirAll(chatDirectory, 0o777); err != nil {
				t.Fatalf("create the chat directory: %v", err)
			}
			target := filepath.Join(chatDirectory, "fault.jsonl")
			oldChat := []byte(`{"name":"User","is_user":true,"mes":"PE-002-OLD"}` + "\n")
			if err := os.WriteFile(target, oldChat, 0o600); err != nil {
				t.Fatalf("plant the old chat: %v", err)
			}

			server, client := tree.boot(t, scenario.label)
			// CONTROL SAVE of the same messages to a different file: expectedNew is the product's own encoding.
			controlStatus, controlBody := nicheSaveChat(t, client, "FaultCard.png", "control", messages)
			if controlStatus != 200 {
				t.Fatalf("the control chat save = %d: %s", controlStatus, truncateForLog(controlBody, 200))
			}
			expectedNew := mustReadNicheFile(t, filepath.Join(chatDirectory, "control.jsonl"))
			// The control file is not the crash target; remove it so the crash state check is unambiguous.
			if err := os.Remove(filepath.Join(chatDirectory, "control.jsonl")); err != nil {
				t.Fatalf("remove the control chat: %v", err)
			}

			tree.arm(t)
			if saveErr := nicheSaveChatTolerant(t, client, "FaultCard.png", "fault", messages); saveErr != nil {
				t.Logf("the crash save lost its connection, which is expected when the process exits at %s: %v", scenario.label, saveErr)
			}
			nicheWaitForFaultExit(t, server, scenario.label)
			crashed := mustReadNicheFile(t, target)
			if scenario.wantNew {
				if err := nicheCheckBody(scenario.label, string(crashed), string(expectedNew)); err != nil {
					t.Fatalf("%v: the after-write stage must leave the complete NEW chat", err)
				}
			} else {
				if err := nicheCheckBody(scenario.label, string(crashed), string(oldChat)); err != nil {
					t.Fatalf("%v: the before-write stage must leave the complete OLD chat", err)
				}
			}
			if err := nicheCheckJSONLLines(scenario.label, crashed); err != nil {
				t.Fatalf("%v", err)
			}
			if err := nicheNonDotScratch(t, chatDirectory); err != nil {
				t.Fatalf("%s: a non-dot scratch file was left in the chat directory", scenario.label)
			}

			restarted, restartedClient := tree.boot(t, "")
			if strings.Contains(restarted.stderr.String(), "panic") {
				t.Fatalf("%s: the restart panicked:\n%s", scenario.label, restarted.diagnostic())
			}
			if after := mustReadNicheFile(t, target); !bytes.Equal(after, crashed) {
				t.Fatalf("%s: the restart CHANGED the crashed chat (%d bytes -> %d bytes)", scenario.label, len(crashed), len(after))
			}
			status, body := nicheGetChat(t, restartedClient, "FaultCard.png", "fault")
			if err := nicheCheckStatus("chats/get after restart", status, 200); err != nil {
				t.Fatalf("%s: %v (%s)", scenario.label, err, truncateForLog(body, 200))
			}
			wantMarker := "PE-002-OLD"
			if scenario.wantNew {
				wantMarker = "PE-002-NEW-1"
			}
			if err := nicheCheckContains("chats/get after restart", body, wantMarker); err != nil {
				t.Fatalf("%s: %v", scenario.label, err)
			}
		})
	}
}

// PE-003: chat IMPORT killed after its write. /api/chats/import writes the imported JSONL and then reports the
// after-write seam, so the crash leaves a complete imported chat (or, if the write had not happened, the OLD
// file the test planted). This is the append-shaped path available on this route family; the group-chat JSONL
// append path has its own seam and is listed as UNEXECUTED in the evidence document.
func TestNichePersistenceChatImportCrashStage(t *testing.T) {
	tree := newNicheCrashTree(t)
	importedRoot := filepath.Join(tree.userRoot, "chats", crashAvatar)
	if err := os.MkdirAll(importedRoot, 0o777); err != nil {
		t.Fatalf("create the import chat directory: %v", err)
	}
	importedPayload := []byte(`{"name":"User","is_user":true,"mes":"PE-003-IMPORTED"}` + "\n")
	multipartBody, contentType := importBody(t, importedPayload)
	server, client := tree.boot(t, "chats.import.after-write")

	// CONTROL: prove this request reaches the import writer on THIS tree before arming the fault. The route
	// names the file itself (`<character> - <humanized date> imported.jsonl`), so the test cannot predict the
	// name; it finds it and uses the product's own file as the next attempt's starting point.
	controlStatus, controlBody, controlErr := crashMultiPartPOST(client, "/api/chats/import", contentType, multipartBody)
	if controlErr != nil || controlStatus != 200 {
		t.Fatalf("the control import = %d (%v): %s; the crash request would never reach the chats.import.after-write seam",
			controlStatus, controlErr, truncateForLog(controlBody, 240))
	}
	imported := nicheImportedChatNames(t, filepath.Join(tree.userRoot, "chats"))
	if len(imported) != 1 {
		t.Fatalf("the control import produced %d imported chat file(s), want 1 (files: %v)", len(imported), imported)
	}
	controlPath := nicheFindFile(t, filepath.Join(tree.userRoot, "chats"), imported[0])
	controlBytes := mustReadNicheFile(t, controlPath)
	if !strings.Contains(string(controlBytes), "PE-003-IMPORTED") {
		t.Fatalf("the control import file does not carry the imported message: %s", truncateForLog(string(controlBytes), 200))
	}
	if err := os.Remove(controlPath); err != nil {
		t.Fatalf("remove the control import file: %v", err)
	}

	tree.arm(t)
	if status, response, sendErr := crashMultiPartPOST(client, "/api/chats/import", contentType, multipartBody); sendErr != nil {
		t.Logf("the crash import lost its connection, which is expected when the process exits at the seam: %v (status=%d %s)",
			sendErr, status, truncateForLog(response, 160))
	}
	nicheWaitForFaultExit(t, server, "chats.import.after-write")
	afterCrash := nicheImportedChatNames(t, filepath.Join(tree.userRoot, "chats"))
	if len(afterCrash) != 1 {
		t.Fatalf("the crashed import left %d imported chat file(s), want exactly 1: the after-write seam means the file was already published", len(afterCrash))
	}
	crashedPath := nicheFindFile(t, filepath.Join(tree.userRoot, "chats"), afterCrash[0])
	crashed := mustReadNicheFile(t, crashedPath)
	if err := nicheCheckJSONLLines("imported chat", crashed); err != nil {
		t.Fatalf("%v", err)
	}
	if err := nicheCheckContains("imported chat", string(crashed), "PE-003-IMPORTED"); err != nil {
		t.Fatalf("%v: the crash left an incomplete imported chat", err)
	}
	if err := nicheNonDotScratch(t, filepath.Dir(crashedPath)); err != nil {
		t.Fatalf("chat import left a non-dot scratch file: %v", err)
	}
	restarted, restartedClient := tree.boot(t, "")
	if strings.Contains(restarted.stderr.String(), "panic") {
		t.Fatalf("the restart panicked after the import crash:\n%s", restarted.diagnostic())
	}
	if after := mustReadNicheFile(t, crashedPath); !bytes.Equal(after, crashed) {
		t.Fatalf("the restart CHANGED the crashed imported chat")
	}
	fileName := strings.TrimSuffix(afterCrash[0], ".jsonl")
	status, body := nicheGetChat(t, restartedClient, crashAvatar+".png", fileName)
	if err := nicheCheckStatus("chats/get after import crash", status, 200); err != nil {
		t.Fatalf("%v (%s)", err, truncateForLog(body, 200))
	}
	if err := nicheCheckContains("chats/get after import crash", body, "PE-003-IMPORTED"); err != nil {
		t.Fatalf("%v", err)
	}
}

// nicheFindFile resolves a generated file NAME (the import route chooses it) under root.
func nicheFindFile(t *testing.T, root, name string) string {
	t.Helper()
	found := ""
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if entry.Name() == name {
			found = path
		}
		return nil
	}); err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	if found == "" {
		t.Fatalf("the generated file %q was not found under %s", name, root)
	}
	return found
}

// nicheImportedChatNames lists the chat files the import route generated under a chats directory.
func nicheImportedChatNames(t *testing.T, root string) []string {
	t.Helper()
	names := []string{}
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil
		}
		if strings.HasSuffix(entry.Name(), " imported.jsonl") {
			names = append(names, entry.Name())
		}
		return nil
	}); err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
	return names
}

// crashMultiPartPOST sends a multipart body through a browser-equivalent session. It duplicates the post
// helper shape of chat_crash_harness_test.go because that file's helper is bound to crashClient, which this
// tree does not use for its settings cases.
func crashMultiPartPOST(client *session, route, contentType, body string) (int, string, error) {
	request, err := http.NewRequest(http.MethodPost, client.origin+route, bytes.NewReader([]byte(body)))
	if err != nil {
		return 0, "", err
	}
	request.Header.Set("Content-Type", contentType)
	if client.cookie != "" {
		request.Header.Set("Cookie", client.cookie)
	}
	if client.token != "" {
		request.Header.Set("X-CSRF-Token", client.token)
	}
	response, err := client.client.Do(request)
	if err != nil {
		return 0, "", err
	}
	defer response.Body.Close()
	payload := make([]byte, 0, 256)
	buffer := make([]byte, 256)
	for {
		count, readErr := response.Body.Read(buffer)
		payload = append(payload, buffer[:count]...)
		if readErr != nil {
			break
		}
	}
	return response.StatusCode, string(payload), nil
}

// PE-004 (recorded, not executed here): a settings save's BACKUP SNAPSHOT write is scheduled on a timer and
// the backup file has no per-stage seam before it is written; the group-chat append path has its own seam
// (chats.group.save.after-write) but no case here drives it. Both are listed as UNEXECUTED in the evidence
// document rather than being approximated with a seam the product does not have.
