package e2e

// THE COMPLEX INSTANCE'S WRITE, MIGRATION AND FAILURE SCENARIOS.
//
// The boot/route test (longlived_complex_test.go) proves the complex instance is READ correctly and is not
// damaged by a boot. This file adds the three remaining data-safety obligations from the goal:
//
//   1. MIGRATION: a legacy-shaped copy of the instance (config.yaml with a relative dataRoot, data/ and a
//      public/ overlay) migrates into a running install, the SOURCE is never modified (AGENTS rule 14),
//      the destination carries every planted byte, and the migrated install boots and serves the cards,
//      chats and world book.
//   2. UNKNOWN-FIELD PRESERVATION ON WRITE (rule 11): editing one world entry through the pinned route
//      keeps the field this project has never parsed on EVERY entry, and leaves unrelated worlds
//      byte-identical.
//   3. FAILURE PATH: a corrupt world file does not stop the boot, does not get rewritten, and does not
//      take the other routes down with it.
//
// All three run on the same synthetic, strictly SFW fixture (internal/longlivedfixture).

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/longlivedfixture"
)

// complexWriteSpec is deliberately smaller than the default: these scenarios assert write/migration
// semantics, and a 29 MB tree would only make the copies slower without changing an assertion.
func complexWriteSpec() longlivedfixture.Spec {
	spec := longlivedfixture.DefaultSpec()
	spec.Characters = 6
	spec.Worlds = 2
	spec.BigWorld = 12
	spec.ChatBase = 8
	spec.ChatStep = 2
	return spec
}

func complexTreeDigests(t *testing.T, root string) map[string]string {
	t.Helper()
	digests := map[string]string{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if info.IsDir() {
			return nil
		}
		relative, relErr := filepath.Rel(root, path)
		if relErr != nil {
			return relErr
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		digests[filepath.ToSlash(relative)] = sha256Hex(string(body))
		return nil
	})
	if err != nil {
		t.Fatalf("digest %s: %v", root, err)
	}
	return digests
}

func runGotavern(t *testing.T, binary string, arguments ...string) (string, int) {
	t.Helper()
	command := exec.Command(binary, arguments...)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	err := command.Run()
	code := 0
	if err != nil {
		if exit, ok := err.(*exec.ExitError); ok {
			code = exit.ExitCode()
		} else {
			t.Fatalf("run %s %v: %v", binary, arguments, err)
		}
	}
	return stdout.String() + stderr.String(), code
}

func TestComplexInstanceMigratesAndBoots(t *testing.T) {
	spec := complexWriteSpec()
	installRoot := t.TempDir()
	binary := resolveBinary(t, installRoot)

	payload := t.TempDir()
	manifest, err := longlivedfixture.Build(payload, spec)
	if err != nil {
		t.Fatalf("build fixture: %v", err)
	}

	// Assemble a LEGACY-SHAPED source: config.yaml naming a relative dataRoot, the data tree under
	// data/, and the public/ overlay at the install root (the pinned migration's source shape).
	source := t.TempDir()
	if err := os.MkdirAll(filepath.Join(source, "data"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(payload, "default-user"), filepath.Join(source, "data", "default-user")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(payload, "public"), filepath.Join(source, "public")); err != nil {
		t.Fatal(err)
	}
	legacyConfig := "# a long-lived config the user wrote\n" +
		"dataRoot: \"./data\"\nport: 8000\nlisten: false\nuserUnknownSetting: keep-me-please\n" +
		"customProviderOptions:\n  nestedKey: [1, 2, 3]\n"
	if err := os.WriteFile(filepath.Join(source, "config.yaml"), []byte(legacyConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	// The payload's config.yaml and its own public/ moved; only the data tree's digests are compared.
	sourceBefore := complexTreeDigests(t, source)

	dest := filepath.Join(t.TempDir(), "gotavern-install")
	dryRunOutput, dryRunCode := runGotavern(t, binary, "migrate", "--from", source, "--dest", dest, "--dry-run")
	if dryRunCode != 0 {
		t.Fatalf("migrate --dry-run exited %d: %.400q", dryRunCode, dryRunOutput)
	}
	if entries, readErr := os.ReadDir(dest); readErr == nil && len(entries) > 0 {
		t.Fatalf("a dry-run migration wrote into the destination: %v", entries)
	}
	if after := complexTreeDigests(t, source); !sameDigests(sourceBefore, after) {
		t.Fatalf("the dry-run modified the source installation (AGENTS rule 14)")
	}

	migrateOutput, migrateCode := runGotavern(t, binary, "migrate", "--from", source, "--dest", dest)
	if migrateCode != 0 {
		t.Fatalf("migrate exited %d: %.400q", migrateCode, migrateOutput)
	}
	if after := complexTreeDigests(t, source); !sameDigests(sourceBefore, after) {
		t.Fatalf("the real migration modified the source installation (AGENTS rule 14)")
	}

	// Every planted data byte arrived, and the config's dataRoot now names the migrated data root.
	planted := 0
	for relative, digest := range manifest.Files {
		if !strings.HasPrefix(relative, "default-user/") {
			continue
		}
		body, readErr := os.ReadFile(filepath.Join(dest, "data", filepath.FromSlash(relative)))
		if readErr != nil {
			t.Errorf("the migrated install is missing %s: %v", relative, readErr)
			continue
		}
		if sha256Hex(string(body)) != digest {
			t.Errorf("the migrated %s does not match its planted bytes", relative)
		}
		planted++
	}
	if planted < 20 {
		t.Fatalf("only %d planted files were compared; the fixture did not migrate", planted)
	}
	migratedConfig, err := os.ReadFile(filepath.Join(dest, "config.yaml"))
	if err != nil {
		t.Fatalf("the migrated install has no config.yaml: %v", err)
	}
	if !bytes.Contains(migratedConfig, []byte("dataRoot:")) {
		t.Fatalf("the migrated config.yaml does not name a dataRoot: %.300q", migratedConfig)
	}
	if !bytes.Contains(migratedConfig, []byte("userUnknownSetting")) {
		t.Errorf("the migration dropped the unknown config key (AGENTS rule 11)")
	}

	// The migrated install boots and serves what was migrated: the cards, a chat, and the world book.
	server := bootServerIn(t, dest, dest, filepath.Join(dest, "data"), nil)
	client := openSession(t, server.origin)
	status, _, body := client.postJSON(t, "/api/characters/all", "{}")
	if status != http.StatusOK {
		t.Fatalf("POST /api/characters/all on the migrated install = %d: %.200q", status, body)
	}
	for _, character := range manifest.Characters {
		if !strings.Contains(body, character.Avatar) {
			t.Errorf("the migrated install does not list %s", character.Avatar)
		}
	}
	worldRequest, err := marshalJSON(map[string]any{"name": "World_00"})
	if err != nil {
		t.Fatal(err)
	}
	status, _, body = client.postJSON(t, "/api/worldinfo/get", worldRequest)
	if status != http.StatusOK || !strings.Contains(body, "WI_CONTENT_0_") {
		t.Errorf("the migrated install cannot read its world book (status %d)", status)
	}
}

func TestComplexWorldEditPreservesUnknownFields(t *testing.T) {
	spec := complexWriteSpec()
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	if err := os.MkdirAll(dataRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	manifest, err := longlivedfixture.Build(dataRoot, spec)
	if err != nil {
		t.Fatalf("build fixture: %v", err)
	}
	server := bootServerAt(t, installRoot, dataRoot, nil)
	client := openSession(t, server.origin)

	worldFile := filepath.Join(dataRoot, "default-user", "worlds", "World_00.json")
	otherWorldFile := filepath.Join(dataRoot, "default-user", "worlds", "World_01.json")
	otherBefore, err := os.ReadFile(otherWorldFile)
	if err != nil {
		t.Fatal(err)
	}

	status, _, body := client.postJSON(t, "/api/worldinfo/get", mustJSON(t, map[string]any{"name": "World_00"}))
	if status != http.StatusOK {
		t.Fatalf("POST /api/worldinfo/get = %d: %.200q", status, body)
	}
	var document map[string]any
	if err := json.Unmarshal([]byte(body), &document); err != nil {
		t.Fatalf("the world response is not JSON: %v: %.200q", err, body)
	}
	entries, ok := document["entries"].(map[string]any)
	if !ok || len(entries) == 0 {
		t.Fatalf("the world response carries no entries map: %.200q", body)
	}
	first, ok := entries["0"].(map[string]any)
	if !ok {
		t.Fatalf("the world response carries no entry 0")
	}
	first["content"] = "EDITED_BY_THE_COMPLEX_WRITE_TEST"
	// The edit route writes `data` with JSON.stringify(data, null, 4), so the document is posted back as-is.
	status, _, body = client.postJSON(t, "/api/worldinfo/edit", mustJSON(t, map[string]any{"name": "World_00", "data": document}))
	if status != http.StatusOK {
		t.Fatalf("POST /api/worldinfo/edit = %d: %.200q", status, body)
	}

	written, err := os.ReadFile(worldFile)
	if err != nil {
		t.Fatalf("read the written world: %v", err)
	}
	var writtenDocument map[string]any
	if err := json.Unmarshal(written, &writtenDocument); err != nil {
		t.Fatalf("the written world is not JSON: %v", err)
	}
	writtenEntries, ok := writtenDocument["entries"].(map[string]any)
	if !ok || len(writtenEntries) != len(entries) {
		t.Fatalf("the written world lost entries: %d became %d", len(entries), len(writtenEntries))
	}
	if writtenFirst, ok := writtenEntries["0"].(map[string]any); !ok || writtenFirst["content"] != "EDITED_BY_THE_COMPLEX_WRITE_TEST" {
		t.Errorf("the edited entry did not persist")
	}
	kept := 0
	for uid, raw := range writtenEntries {
		entry, ok := raw.(map[string]any)
		if !ok {
			t.Errorf("entry %s became %T", uid, raw)
			continue
		}
		unknown, ok := entry["fixtureUnknownField"].(map[string]any)
		if !ok || unknown["keep"] != true {
			t.Errorf("entry %s lost the field this project has never parsed (AGENTS rule 11): %v", uid, entry["fixtureUnknownField"])
			continue
		}
		kept++
	}
	if kept != len(writtenEntries) {
		t.Errorf("only %d of %d entries kept the unknown field", kept, len(writtenEntries))
	}
	// The other world book was not part of the request and must be byte-identical.
	otherAfter, err := os.ReadFile(otherWorldFile)
	if err != nil {
		t.Fatal(err)
	}
	if sha256Hex(string(otherAfter)) != sha256Hex(string(otherBefore)) {
		t.Errorf("editing World_00 rewrote World_01")
	}
	// And the route reads the edit back.
	status, _, body = client.postJSON(t, "/api/worldinfo/get", mustJSON(t, map[string]any{"name": "World_00"}))
	if status != http.StatusOK || !strings.Contains(body, "EDITED_BY_THE_COMPLEX_WRITE_TEST") {
		t.Errorf("the edited world does not read back (status %d)", status)
	}
	_ = manifest
}

func TestComplexCorruptWorldDoesNotStopTheBootOrGetRewritten(t *testing.T) {
	spec := complexWriteSpec()
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	if err := os.MkdirAll(dataRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	manifest, err := longlivedfixture.Build(dataRoot, spec)
	if err != nil {
		t.Fatalf("build fixture: %v", err)
	}
	corruptFile := filepath.Join(dataRoot, "default-user", "worlds", "World_01.json")
	if err := os.WriteFile(corruptFile, []byte("{this is not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	corruptBytes, err := os.ReadFile(corruptFile)
	if err != nil {
		t.Fatal(err)
	}

	server := bootServerAt(t, installRoot, dataRoot, nil)
	client := openSession(t, server.origin)

	// The boot survived and the healthy parts of the tree still work.
	status, _, body := client.postJSON(t, "/api/characters/all", "{}")
	if status != http.StatusOK || !strings.Contains(body, manifest.Characters[0].Avatar) {
		t.Fatalf("a corrupt world file took the roster down: status %d", status)
	}
	status, _, body = client.postJSON(t, "/api/worldinfo/get", mustJSON(t, map[string]any{"name": "World_00"}))
	if status != http.StatusOK || !strings.Contains(body, "WI_CONTENT_0_") {
		t.Errorf("a corrupt neighbouring world took the healthy world down: status %d", status)
	}
	// The corrupt file is refused, not repaired or truncated, and it is still byte-identical.
	status, _, body = client.postJSON(t, "/api/worldinfo/get", mustJSON(t, map[string]any{"name": "World_01"}))
	if status == http.StatusOK {
		t.Errorf("a corrupt world answered 200: %.200q", body)
	}
	after, err := os.ReadFile(corruptFile)
	if err != nil {
		t.Fatalf("the corrupt world disappeared: %v", err)
	}
	if sha256Hex(string(after)) != sha256Hex(string(corruptBytes)) {
		t.Errorf("the corrupt world was rewritten instead of refused")
	}
}

func mustJSON(t *testing.T, value any) string {
	t.Helper()
	body, err := marshalJSON(value)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	return body
}

func sameDigests(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	keys := make([]string, 0, len(left))
	for key := range left {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	for _, key := range keys {
		if right[key] != left[key] {
			return false
		}
	}
	return true
}

// ---- FAILURE PATHS WHOSE TRIGGER IS THE FILESYSTEM, NOT THE REQUEST.

// TestComplexWorldWriteFailureIsRefusedAndLeavesTheTreeIntact makes the destination path unwritable in a
// way every supported host understands: the world file is replaced by a DIRECTORY. Opening it for write
// fails on Windows and Linux alike, so the scenario is not skipped anywhere. The obligations asserted are
// the product ones: the route reports a failure instead of a false success (hard rule 18), nothing is
// half-written, neighbours are untouched, and the server is still usable afterwards.
func TestComplexWorldWriteFailureIsRefusedAndLeavesTheTreeIntact(t *testing.T) {
	spec := complexWriteSpec()
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	if err := os.MkdirAll(dataRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	manifest, err := longlivedfixture.Build(dataRoot, spec)
	if err != nil {
		t.Fatalf("build fixture: %v", err)
	}
	server := bootServerAt(t, installRoot, dataRoot, nil)
	client := openSession(t, server.origin)

	worldsDir := filepath.Join(dataRoot, "default-user", "worlds")
	unwritable := filepath.Join(worldsDir, "World_01.json")
	if err := os.Remove(unwritable); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(unwritable, 0o777); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(unwritable, "keep.txt")
	if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := complexTreeDigests(t, dataRoot)
	settingsPath := filepath.Join(dataRoot, "default-user", "settings.json")
	settingsBefore, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}

	status, _, body := client.postJSON(t, "/api/worldinfo/edit", mustJSON(t, map[string]any{
		"name": "World_01",
		"data": map[string]any{"entries": map[string]any{"0": map[string]any{"content": "SHOULD_NOT_LAND"}}},
	}))
	if status == http.StatusOK {
		t.Fatalf("a write into a path that cannot be written answered 200: %.300q", body)
	}
	if strings.TrimSpace(body) == "" {
		t.Errorf("the refused write produced no text at all (hard rule 35 asks for a causal error)")
	}
	info, statErr := os.Stat(unwritable)
	if statErr != nil || !info.IsDir() {
		t.Fatalf("the unwritable destination changed shape instead of being left alone: %v", statErr)
	}
	if kept, err := os.ReadFile(marker); err != nil || string(kept) != "keep" {
		t.Errorf("the marker inside the unwritable destination changed: %q %v", kept, err)
	}
	after := complexTreeDigests(t, dataRoot)
	if !sameDigests(before, after) {
		t.Errorf("a refused write changed the tree; first differences: %v", digestDifference(before, after))
	}
	if settingsNow, err := os.ReadFile(settingsPath); err != nil || sha256Hex(string(settingsNow)) != sha256Hex(string(settingsBefore)) {
		t.Errorf("a refused world write changed settings.json")
	}
	// The server did not wedge: the healthy routes still answer.
	status, _, body = client.postJSON(t, "/api/characters/all", "{}")
	if status != http.StatusOK || !strings.Contains(body, manifest.Characters[0].Avatar) {
		t.Errorf("the roster stopped working after a refused write: %d", status)
	}
}

// TestComplexReadOnlyDataRootRefusesWritesWithoutDamage makes the data root read-only the way an operator
// on a Unix host would (chmod a+rx, no write bit). The write must be refused, the tree must keep every
// byte, and restoring the permission must make the same write succeed - which proves the refusal was the
// permission and not a wedged server.
func TestComplexReadOnlyDataRootRefusesWritesWithoutDamage(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("a directory's read-only bit does not deny writes on Windows; the Linux CI job is the binding " +
			"gate for this scenario (AGENTS working mode), and skipping is declared here rather than passed silently")
	}
	spec := complexWriteSpec()
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	if err := os.MkdirAll(dataRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := longlivedfixture.Build(dataRoot, spec); err != nil {
		t.Fatalf("build fixture: %v", err)
	}
	server := bootServerAt(t, installRoot, dataRoot, nil)
	client := openSession(t, server.origin)

	worldsDir := filepath.Join(dataRoot, "default-user", "worlds")
	before := complexTreeDigests(t, worldsDir)
	if err := os.Chmod(worldsDir, 0o555); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chmod(worldsDir, 0o755) })

	status, _, body := client.postJSON(t, "/api/worldinfo/edit", mustJSON(t, map[string]any{
		"name": "World_00",
		"data": map[string]any{"entries": map[string]any{"0": map[string]any{"content": "READ_ONLY_ATTEMPT"}}},
	}))
	if status == http.StatusOK {
		t.Fatalf("a write into a read-only data root answered 200: %.300q", body)
	}
	after := complexTreeDigests(t, worldsDir)
	if !sameDigests(before, after) {
		t.Errorf("a refused write into a read-only data root changed the tree; first differences: %v", digestDifference(before, after))
	}
	if err := os.Chmod(worldsDir, 0o755); err != nil {
		t.Fatal(err)
	}
	status, _, body = client.postJSON(t, "/api/worldinfo/edit", mustJSON(t, map[string]any{
		"name": "World_00",
		"data": map[string]any{"entries": map[string]any{"0": map[string]any{"content": "WRITABLE_AGAIN"}}},
	}))
	if status != http.StatusOK {
		t.Fatalf("after the data root was writable again the same write still failed: %d %.300q", status, body)
	}
	written, err := os.ReadFile(filepath.Join(worldsDir, "World_00.json"))
	if err != nil || !strings.Contains(string(written), "WRITABLE_AGAIN") {
		t.Errorf("the write after restoring permissions did not land")
	}
}

// TestComplexForcedMigrationKeepsARecoverableBackup proves the rollback half of "a failure must be
// recoverable": `migrate --force` moves the destination's previous state to `.migrate-backup/` rather
// than deleting it, the backup carries those bytes EXACTLY, and the backup can itself be booted - so the
// operator's previous installation is a working install, not just a directory of leftovers.
func TestComplexForcedMigrationKeepsARecoverableBackup(t *testing.T) {
	spec := complexWriteSpec()
	installRoot := t.TempDir()
	binary := resolveBinary(t, installRoot)
	source := assembleLegacySource(t, spec)

	dest := filepath.Join(t.TempDir(), "gotavern-install")
	if err := os.MkdirAll(filepath.Join(dest, "data", "default-user"), 0o777); err != nil {
		t.Fatal(err)
	}
	oldConfig := []byte("# the previous destination's own config\nport: 8555\nuserUnknownSetting: old-dest-keep\n")
	oldSettings := []byte("{\"marker\":\"OLD-DEST-STATE\",\"nested\":{\"keep\":true}}\n")
	if err := os.WriteFile(filepath.Join(dest, "config.yaml"), oldConfig, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dest, "data", "default-user", "settings.json"), oldSettings, 0o600); err != nil {
		t.Fatal(err)
	}

	output, code := runGotavern(t, binary, "migrate", "--from", source, "--dest", dest, "--force")
	if code != 0 {
		t.Fatalf("migrate --force exited %d: %.400q", code, output)
	}
	backup := filepath.Join(dest, ".migrate-backup")
	backupConfig, err := os.ReadFile(filepath.Join(backup, "config.yaml"))
	if err != nil || sha256Hex(string(backupConfig)) != sha256Hex(string(oldConfig)) {
		t.Fatalf("the backup does not carry the previous config.yaml byte-identically: %v", err)
	}
	backupSettings, err := os.ReadFile(filepath.Join(backup, "data", "default-user", "settings.json"))
	if err != nil || sha256Hex(string(backupSettings)) != sha256Hex(string(oldSettings)) {
		t.Fatalf("the backup does not carry the previous settings byte-identically: %v", err)
	}

	// The backup is a USABLE installation: boot it from a clean root and ask for the settings the
	// previous destination carried. A backup nobody can start is not a rollback.
	restored := filepath.Join(t.TempDir(), "restored")
	if err := os.CopyFS(restored, os.DirFS(backup)); err != nil {
		t.Fatalf("restore the backup: %v", err)
	}
	server := bootServerIn(t, restored, restored, filepath.Join(restored, "data"), nil)
	client := openSession(t, server.origin)
	status, _, body := client.postJSON(t, "/api/settings/get", "{}")
	if status != http.StatusOK || !strings.Contains(body, "OLD-DEST-STATE") {
		t.Fatalf("the restored installation does not serve the previous destination's settings: %d %.300q", status, body)
	}
}

// assembleLegacySource builds the legacy-shaped migration source used by the complex instance tests.
func assembleLegacySource(t *testing.T, spec longlivedfixture.Spec) string {
	t.Helper()
	payload := t.TempDir()
	if _, err := longlivedfixture.Build(payload, spec); err != nil {
		t.Fatalf("build fixture: %v", err)
	}
	source := t.TempDir()
	if err := os.MkdirAll(filepath.Join(source, "data"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(payload, "default-user"), filepath.Join(source, "data", "default-user")); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(payload, "public"), filepath.Join(source, "public")); err != nil {
		t.Fatal(err)
	}
	legacyConfig := "# a long-lived config the user wrote\ndataRoot: \"./data\"\nport: 8000\nlisten: false\n" +
		"userUnknownSetting: keep-me-please\ncustomProviderOptions:\n  nestedKey: [1, 2, 3]\n"
	if err := os.WriteFile(filepath.Join(source, "config.yaml"), []byte(legacyConfig), 0o600); err != nil {
		t.Fatal(err)
	}
	return source
}

// digestDifference names the first few paths that differ, so a failing tree assertion can be read.
func digestDifference(before, after map[string]string) []string {
	differences := []string{}
	for path, digest := range before {
		if after[path] != digest {
			differences = append(differences, path)
		}
	}
	for path := range after {
		if _, ok := before[path]; !ok {
			differences = append(differences, "+"+path)
		}
	}
	sort.Strings(differences)
	if len(differences) > 5 {
		differences = differences[:5]
	}
	return differences
}
