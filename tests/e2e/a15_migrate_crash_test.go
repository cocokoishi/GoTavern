package e2e

// A15 LANE B: INTERRUPTED MIGRATION, AND THE --force BACKUP AS A BOOTABLE OLD RUNTIME.
//
// GOAL §14 items 4-5: rolling back to the pre-boot copy must work, and a killed process must leave the
// user's data recoverable. `gotavern migrate` is the one command that copies a whole runtime, so it gets
// the same treatment as the chat writes:
//
//	1. the SOURCE IS READ-ONLY: every source byte is hashed before and after a migration that is KILLED
//	   mid-copy, and none may change (migrate.go's headline invariant);
//	2. the interrupted destination is recoverable: re-running with --force completes, and the result boots
//	   and serves the source's settings;
//	3. the --force backup is a COMPLETE OLD RUNTIME: its settings.json bytes equal the pre-migration ones,
//	   and BOOTING THE BACKUP serves the old settings -- so "restore the backup" is a real recovery path,
//	   not an archive nobody has opened.
//
// The migration destination is known to be non-atomic (data-safety.md §9.4): this test does not pretend
// otherwise. What it pins is the recoverable half -- source intact, re-run completes, backup boots.

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// migrateRuntimeTree builds a minimal SillyTavern-shaped source: config.yaml plus a data root with a
// settings marker and (optionally) one large file to widen the copy window.
type migrateTree struct {
	root  string
	large []byte // nil for the small case
}

func newMigrateTree(t *testing.T, settingsMarker string, largeFileBytes int) *migrateTree {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "config.yaml"), []byte("listen: false\nport: 8000\ndataRoot: ./data\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	dataRoot := filepath.Join(root, "data")
	if err := os.MkdirAll(filepath.Join(dataRoot, "default-user"), 0o777); err != nil {
		t.Fatal(err)
	}
	settings := []byte(`{"username":"default-user","gotavernCaseMarker":"` + settingsMarker + `"}`)
	if err := os.WriteFile(filepath.Join(dataRoot, "default-user", "settings.json"), settings, 0o600); err != nil {
		t.Fatal(err)
	}
	tree := &migrateTree{root: root}
	if largeFileBytes > 0 {
		tree.large = bytes.Repeat([]byte("L"), largeFileBytes)
		if err := os.MkdirAll(filepath.Join(dataRoot, "big"), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dataRoot, "big", "payload.bin"), tree.large, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return tree
}

// digestTree hashes every regular file under root as a slash path -> byte digest (the same census the
// startup tests use for their ownership claims).
func a15DigestTree(t *testing.T, root string) map[string]string {
	t.Helper()
	digests := map[string]string{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil {
			if os.IsNotExist(walkErr) {
				return nil
			}
			return walkErr
		}
		if info.IsDir() || !info.Mode().IsRegular() {
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
		t.Fatalf("walk %s: %v", root, err)
	}
	return digests
}

func a15AssertTreeUnchanged(t *testing.T, before, after map[string]string, label string) {
	t.Helper()
	for relative, digest := range before {
		got, present := after[relative]
		if !present {
			t.Errorf("%s: the migration DELETED %s from the source, which must be read-only", label, relative)
			continue
		}
		if got != digest {
			t.Errorf("%s: the migration MODIFIED source file %s (sha256 %s -> %s)", label, relative, digest, got)
		}
	}
	for relative := range after {
		if _, present := before[relative]; !present {
			t.Errorf("%s: the migration CREATED %s inside the source", label, relative)
		}
	}
}

// runMigrate starts `gotavern migrate` and returns the command plus a function that waits for it.
func runMigrate(t *testing.T, binaryDir, source, destination string, force bool) (*exec.Cmd, *bytes.Buffer, *bytes.Buffer) {
	t.Helper()
	binary := resolveBinary(t, binaryDir)
	arguments := []string{"migrate", "--from", source, "--dest", destination}
	if force {
		arguments = append(arguments, "--force")
	}
	command := exec.Command(binary, arguments...)
	command.Dir = binaryDir
	command.Env = childEnvironment(nil)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err := command.Start(); err != nil {
		t.Fatalf("start migrate: %v", err)
	}
	return command, &stdout, &stderr
}

// TestInterruptedMigrationKeepsTheSourceUnmodifiedAndReruns kills a real migration mid-copy and requires
// the source census to be identical afterwards, then completes the migration with --force and boots it.
func TestInterruptedMigrationKeepsTheSourceUnmodifiedAndReruns(t *testing.T) {
	source := newMigrateTree(t, "migrated-settings", 64<<20)
	destination := filepath.Join(t.TempDir(), "dest")
	binaryDir := t.TempDir()

	before := a15DigestTree(t, source.root)
	command, _, stderr := runMigrate(t, binaryDir, source.root, destination, false)
	// Wait until the destination's data copy is visibly in progress, then kill the process. The copy
	// reads a whole 64 MiB file before writing it, so this window is wide relative to the poll interval.
	deadline := time.Now().Add(60 * time.Second)
	interrupted := false
	for time.Now().Before(deadline) {
		if info, err := os.Stat(filepath.Join(destination, "data", "big", "payload.bin")); err == nil && info.Size() > 0 && info.Size() < int64(len(source.large)) {
			interrupted = true
			break
		}
		if info, err := os.Stat(filepath.Join(destination, "data")); err == nil && info.IsDir() {
			// The data directory exists: give the copy a moment to start, then kill even if the big file
			// has not appeared yet (the assertion is about the SOURCE, which the copy cannot have touched).
			time.Sleep(15 * time.Millisecond)
			interrupted = true
			break
		}
		select {
		case <-time.After(2 * time.Millisecond):
		}
	}
	if !interrupted {
		_ = command.Process.Kill()
		_ = command.Wait()
		t.Fatalf("the migration never created its destination data tree within 60s; stderr:\n%s", stderr.String())
	}
	_ = command.Process.Kill()
	_ = command.Wait()

	after := a15DigestTree(t, source.root)
	a15AssertTreeUnchanged(t, before, after, "after an interrupted migration")

	// RECOVERY: the interrupted destination may hold conflicts, so --force moves them aside and recopies.
	// The assertion is that the command COMPLETES and the copied tree boots and serves the source settings.
	recovery, recoveryStdout, recoveryStderr := runMigrate(t, binaryDir, source.root, destination, true)
	if err := recovery.Wait(); err != nil {
		t.Fatalf("re-running the interrupted migration with --force failed: %v\nstdout:\n%s\nstderr:\n%s",
			err, recoveryStdout.String(), recoveryStderr.String())
	}
	// THE RECOVERY RUN MUST NOT TOUCH THE SOURCE EITHER. The first census can run before the copy reaches a
	// large file (the kill lands early), so a migration that MUTATES the source during copying would survive
	// the interrupted-run assertion and be caught only here -- measured: a move-instead-of-copy mutation
	// survived the early census and this second census is what turns it red.
	a15AssertTreeUnchanged(t, before, a15DigestTree(t, source.root), "after the recovery migration")
	server := bootServerIn(t, recoveryBinaryInstallRoot(t, destination, binaryDir), destination, filepath.Join(destination, "data"), nil)
	client := openSession(t, server.origin)
	status, _, body := client.postJSON(t, "/api/settings/get", "{}")
	if status != 200 {
		t.Fatalf("the recovered migration booted but settings/get = %d: %s", status, truncateForLog(body, 300))
	}
	if !strings.Contains(body, "migrated-settings") {
		t.Fatalf("the recovered migration does not serve the source settings marker:\n%s", truncateForLog(body, 500))
	}
}

// recoveryBinaryInstallRoot returns an install root that holds a copy of the binary and ALSO the
// destination's own config.yaml, which is the layout a migrated install has. bootServerIn passes an
// explicit --dataRoot, so the destination's config is present but its dataRoot value is not what the boot
// uses; that is the documented migrate contract ("start GoTavern with its own config").
func recoveryBinaryInstallRoot(t *testing.T, destination, binaryDir string) string {
	t.Helper()
	binary := resolveBinary(t, binaryDir)
	if err := copyExecutable(binary, filepath.Join(destination, filepath.Base(binary))); err != nil {
		t.Fatalf("copy the binary into the migrated destination: %v", err)
	}
	return destination
}

// TestForceMigrationBackupIsABootableOldRuntime covers the rollback half: after --force, the previous
// destination tree is moved under .migrate-backup and must still boot and serve its old settings bytes.
func TestForceMigrationBackupIsABootableOldRuntime(t *testing.T) {
	binaryDir := t.TempDir()

	oldSettings := []byte(`{"username":"default-user","gotavernCaseMarker":"OLD-DEST-SETTINGS"}`)
	destination := filepath.Join(t.TempDir(), "dest")
	if err := os.MkdirAll(filepath.Join(destination, "data", "default-user"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(destination, "config.yaml"), []byte("listen: false\nport: 8000\ndataRoot: ./data\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(destination, "data", "default-user", "settings.json"), oldSettings, 0o600); err != nil {
		t.Fatal(err)
	}

	source := newMigrateTree(t, "SOURCE-SETTINGS", 0)
	command, stdout, stderr := runMigrate(t, binaryDir, source.root, destination, true)
	if err := command.Wait(); err != nil {
		t.Fatalf("migrate --force failed: %v\nstdout:\n%s\nstderr:\n%s", err, stdout.String(), stderr.String())
	}
	// THE BACKUP HOLDS THE OLD RUNTIME BYTE FOR BYTE.
	backup := filepath.Join(destination, ".migrate-backup")
	backedUpSettings, err := os.ReadFile(filepath.Join(backup, "data", "default-user", "settings.json"))
	if err != nil {
		t.Fatalf("migrate --force did not move the old runtime into %s: %v", backup, err)
	}
	if !bytes.Equal(backedUpSettings, oldSettings) {
		t.Fatalf("the backup's settings.json is not the pre-migration bytes.\n  backup:   %q\n  original: %q", backedUpSettings, oldSettings)
	}
	if _, err := os.Stat(filepath.Join(backup, "config.yaml")); err != nil {
		t.Fatalf("the backup has no config.yaml, so the old runtime cannot boot as an install: %v", err)
	}

	// AND IT BOOTS. The binary is copied beside the backup's config so the backup is a release-shaped tree.
	binary := resolveBinary(t, binaryDir)
	if err := copyExecutable(binary, filepath.Join(backup, filepath.Base(binary))); err != nil {
		t.Fatalf("copy the binary into the backup tree: %v", err)
	}
	backupServer := bootServerIn(t, backup, backup, filepath.Join(backup, "data"), nil)
	backupClient := openSession(t, backupServer.origin)
	status, _, body := backupClient.postJSON(t, "/api/settings/get", "{}")
	if status != 200 {
		t.Fatalf("booting the migration backup answered settings/get = %d: %s", status, truncateForLog(body, 300))
	}
	if !strings.Contains(body, "OLD-DEST-SETTINGS") {
		t.Fatalf("the booted backup does NOT serve the old settings marker, so it is not a usable rollback target:\n%s",
			truncateForLog(body, 500))
	}

	// AND THE MIGRATED DESTINATION ITSELF SERVES THE SOURCE SETTINGS.
	migratedServer := bootServerIn(t, destination, destination, filepath.Join(destination, "data"), nil)
	migratedClient := openSession(t, migratedServer.origin)
	status, _, body = migratedClient.postJSON(t, "/api/settings/get", "{}")
	if status != 200 || !strings.Contains(body, "SOURCE-SETTINGS") {
		t.Fatalf("the migrated destination does not serve the source settings (status %d):\n%s", status, truncateForLog(body, 500))
	}
}
