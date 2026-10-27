package configinit

// A HALF-MIGRATED OR UNPARSEABLE CONFIG MUST FAIL BY NAME, WRITE NOTHING, AND BE IDEMPOTENT.
//
// Item 4 of the startup long tail. The neighbouring invariant -- "a config that already carries every pinned
// default is not rewritten" -- is `config_idempotence_test.go`, written by another lane; this file does NOT
// repeat it. What is here is the set of states a real tree reaches when something goes wrong in the middle of
// a migration, which that test cannot cover because none of them is a complete, valid config.
//
// WHAT IS PINNED (SillyTavern 1.19.0 = 06bde939, read 2026-10-27):
//
//	src/config-init.js:164-243   the whole of addMissingConfigValues is wrapped in ONE try/catch whose catch
//	                             is `console.warn('Could not add missing config values to config.yaml', err)`.
//	                             So pinned NEVER aborts a boot on a bad config: it warns and continues with
//	                             whatever the file held, which for an unparseable file means `config` is
//	                             undefined and every later getConfigValue falls back to its own default.
//	src/config-init.js:239       the write is `fs.writeFileSync(configPath, yaml.stringify(config))` -- a
//	                             single, non-atomic, in-place truncate-and-write.
//
//	=> The pinned observable for an unparseable config is "warn, continue, TOUCH NOTHING", and the pinned
//	   observable for a mid-write crash is "whatever bytes fs.writeFileSync had flushed". That second one is a
//	   DEFECT in the upstream (a crash during migration can leave a truncated config), and this product does
//	   not reproduce it: `atomicWrite` (config.go:168) writes a temporary file, fsyncs, and renames, so an
//	   interrupted migration leaves either the whole old file or the whole new one. THAT IS A RECORDED
//	   PRODUCT DECISION, not a parity claim -- the consequence a user sees is "my config is never a truncated
//	   stub", and there is no pinned behaviour to match because pinned's behaviour here is data loss.
//
// WHAT THIS FILE ASSERTS:
//  1. an unparseable config returns a NAMED error (path + the parse cause), leaves the bytes BYTE-IDENTICAL,
//     and does not create a temporary file beside it;
//  2. a HALF-migrated config (a legacy key migrated, its replacement also present and different; plus a
//     migrated key whose value is the legacy SHAPE) migrates to a stable answer and then STOPS: the second
//     Initialize is a no-op by bytes, which is idempotence proven by running it, not by reading the first
//     result;
//  3. a migration INTERRUPTED before the rename leaves the ORIGINAL file intact -- proven by making the
//     temporary-file allocation fail, which is the fault the real crash produces, and which must not be
//     simulated with a sleep or a killed process;
//  4. no partial write survives any of the above: the config is never observed as a truncated stub.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeConfigFile plants a config and returns its path and exact bytes.
func writeConfigFile(t *testing.T, body string) (string, []byte) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "config.yaml")
	bytes := []byte(body)
	if err := os.WriteFile(path, bytes, 0o644); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
	return path, bytes
}

// assertExactlyTheseBytes requires the file's content to equal want, reporting the delta when it does not.
func assertExactlyTheseBytes(t *testing.T, path string, want []byte, why string) {
	t.Helper()
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("%s: read %s afterwards: %v", why, path, err)
	}
	if string(got) != string(want) {
		t.Fatalf("%s: the config changed.\n  want (%d bytes): %q\n  got  (%d bytes): %q",
			why, len(want), want, len(got), got)
	}
}

// assertNoTemporaryFiles refuses a leftover atomicWrite scratch file. This is what a partial write WOULD
// leave behind, so its absence is the "no partial write" half of the invariant -- and its presence would be
// a leak the next boot sees as an ordinary stray file.
func assertNoTemporaryFiles(t *testing.T, directory string) {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("list %s: %v", directory, err)
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".gotavern-config-") {
			t.Fatalf("a partial write was left behind: %s", filepath.Join(directory, entry.Name()))
		}
	}
}

// TestUnparseableConfigFailsByNameAndIsNotTouched is the "my config is broken" case.
func TestUnparseableConfigFailsByNameAndIsNotTouched(t *testing.T) {
	for _, scenario := range []struct {
		name string
		body string
	}{
		// A truncated document: the shape a crash or a full disk produces mid-edit. This is the one that
		// matters, because it is what a user is left with after the failure this test is about.
		{name: "truncated mid-sequence", body: "port: 8000\nwhitelist: [\"127.0.0.1\"\n"},
		// A tab-indented block, which YAML forbids and which an editor that mixes tabs and spaces produces.
		{name: "tab indentation", body: "ssl:\n\tenabled: true\n"},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			path, planted := writeConfigFile(t, scenario.body)

			_, err := Initialize(path)
			if err == nil {
				t.Fatalf("Initialize accepted an unparseable config. Pinned warns and continues "+
					"(config-init.js:240-242), but this product's resolver must return the cause so the boot "+
					"can report it: continuing with `config` undefined is how every setting silently becomes a "+
					"default. Body was:\n%s", scenario.body)
			}
			message := err.Error()
			// (1) NAMED: the path, so a user with several deployments knows which one.
			if !strings.Contains(message, path) {
				t.Fatalf("the error does not name the config path, so a user cannot tell which file to fix "+
					"(AGENTS 35): %v", err)
			}
			// (2) CAUSAL: the parse reason, not a bare "invalid config".
			if !strings.Contains(message, "parse config") {
				t.Fatalf("the error does not say the file failed to PARSE, so it is indistinguishable from a "+
					"lock, a permission or a disk problem: %v", err)
			}
			// (3) NOTHING WRITTEN.
			assertExactlyTheseBytes(t, path, planted, "an unparseable config was modified by a failed parse")
			assertNoTemporaryFiles(t, filepath.Dir(path))
		})
	}
}

// TestDuplicateKeyIsAcceptedWherePinnedRejectsIt RECORDS A DIVERGENCE, and is written so that closing it
// turns this test red rather than silent.
//
// MEASURED on run 40465430026 (GoTavern Lane CI, 1e08a51): `port: 8000\nport: 9000\n` is ACCEPTED by
// `Initialize`. That was first asserted the other way round, on my assumption that yaml.v3 rejects duplicate
// keys; it does not, because `parseMapping` (config.go:220-233) unmarshals into a `yaml.Node`, and the
// uniqueness check lives in the decoder's mapping path rather than in node building.
//
// WHAT PINNED DOES (SillyTavern 1.19.0 = 06bde939): `src/config-init.js:174` calls `yaml.parse(...)` from
// the `yaml` package at `^2.8.3`, whose Document defaults are `strict: true` and `uniqueKeys: true`
// (node_modules/yaml/.../doc/Document.js:37-39). A duplicate key is therefore an ERROR for pinned, so this
// is a real divergence on a STARTUP path: a user whose config has the same key twice gets a warning from
// pinned and a silently-last-wins value here.
//
// WHY IT IS NOT FIXED IN THIS COMMIT. Rejecting duplicates would change what a boot accepts, and AGENTS 13
// makes startup behaviour compatibility behaviour -- the fix is a deliberate change with its own probe, not a
// side effect of a test-writing lane. Meanwhile the test pins the CURRENT behaviour exactly and names the
// pinned behaviour beside it, so the divergence cannot be discovered twice and cannot be forgotten:
// when the product starts rejecting, this test fails and whoever fixes it removes the assertion with the
// reason recorded here.
func TestDuplicateKeyIsAcceptedWherePinnedRejectsIt(t *testing.T) {
	path, _ := writeConfigFile(t, "port: 8000\nport: 9000\n")

	result, err := Initialize(path)
	if err != nil {
		t.Fatalf("Initialize now REJECTS a duplicate key: %v\n\n"+
			"If this is the intended fix, delete this test and record the change as closing the divergence "+
			"from pinned's uniqueKeys default (yaml 2.x Document.js:37-39) -- do not keep both the assertion "+
			"and the new behaviour.", err)
	}
	// The current behaviour, stated as a fact rather than left implicit: the file is treated as valid.
	if !result.Created && !result.Updated {
		after, readErr := os.ReadFile(path)
		if readErr != nil {
			t.Fatalf("read %s: %v", path, readErr)
		}
		// A duplicate-key file also lacks every other pinned default, so defaults get merged and the file is
		// rewritten; if that ever stops being true the assertion below would silently stop meaning anything.
		if !strings.Contains(string(after), "port:") {
			t.Fatalf("the config lost its port key entirely:\n%s", after)
		}
	}
	t.Logf("DIVERGENCE RECORDED (not fixed): a duplicate key is accepted here and is an error for pinned "+
		"(yaml uniqueKeys:true). Initialize returned %+v on %q", result, "port: 8000 / port: 9000")
}

// TestHalfMigratedConfigReachesAStableAnswerAndStops is the state a tree is in when a migration was written
// by an older release in one place and a newer one in another. The assertions are: the migration converges
// (the legacy key is gone, the replacement holds the migrated value), and a SECOND Initialize changes
// nothing -- idempotence by RUNNING it.
func TestHalfMigratedConfigReachesAStableAnswerAndStops(t *testing.T) {
	// `disableChatBackup: true` (legacy, inverted) AND the replacement already present as `false`: a file
	// where one tool migrated the key and another wrote the new key directly. The migration is unconditional
	// (config.go:319-344), so the legacy value wins and the result must be deterministic.
	body := "listen: false\n" +
		"disableChatBackup: true\n" +
		"backups:\n" +
		"  chat:\n" +
		"    enabled: false\n" +
		"myOwnSection:\n" +
		"  keptValue: 41\n"
	path, planted := writeConfigFile(t, body)

	first, err := Initialize(path)
	if err != nil {
		t.Fatalf("Initialize on a half-migrated config failed: %v", err)
	}
	if !first.Updated {
		t.Fatalf("Initialize reported no update for a config that still carries a legacy key, so the "+
			"migration did not run: %+v", first)
	}
	afterFirst, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after the first Initialize: %v", err)
	}
	if string(afterFirst) == string(planted) {
		t.Fatal("Initialize reported Updated but the bytes did not move, which is the contradictory state " +
			"the Result struct must never report")
	}
	// The migration converged: the legacy key is gone and the replacement is present.
	if strings.Contains(string(afterFirst), "disableChatBackup") {
		t.Fatalf("the legacy key survived the migration:\n%s", afterFirst)
	}
	if !strings.Contains(string(afterFirst), "enabled: true") {
		t.Fatalf("`disableChatBackup: true` should migrate to `backups.chat.enabled: true` (the migration "+
			"inverts the boolean, config.go:330-331); the file has:\n%s", afterFirst)
	}
	// The user's own unknown section survives a WHOLE-DOCUMENT re-serialisation, which is the one place a
	// rewrite is allowed to reformat but not to lose data (AGENTS 28).
	if !strings.Contains(string(afterFirst), "myOwnSection") || !strings.Contains(string(afterFirst), "keptValue") {
		t.Fatalf("the migration lost the user's own unknown section:\n%s", afterFirst)
	}

	// IDEMPOTENT: a second run must be a no-op, BY BYTES.
	second, err := Initialize(path)
	if err != nil {
		t.Fatalf("the second Initialize failed: %v", err)
	}
	if second.Created || second.Updated {
		t.Fatalf("the second Initialize on an already-migrated config reported %+v: a migration that keeps "+
			"moving is a rewrite on every boot (AGENTS 27)", second)
	}
	assertExactlyTheseBytes(t, path, afterFirst, "the second Initialize rewrote a migrated config")
	assertNoTemporaryFiles(t, filepath.Dir(path))
}

// TestInterruptedMigrationLeavesTheOriginalIntact is the crash case, and it is the reason atomicWrite exists.
//
// THE FAULT IS THE REAL ONE, NOT A SIMULATION: a migration can only lose data between the moment the new
// bytes exist and the moment the rename publishes them, so the test removes the ability to CREATE the
// temporary file and checks that the user's original is untouched. A sleep or a killed process would test
// the scheduler instead.
func TestInterruptedMigrationLeavesTheOriginalIntact(t *testing.T) {
	path, planted := writeConfigFile(t, "listen: false\ndisableChatBackup: true\n")

	// Occupy the temporary-file name space the same way a full disk or a read-only directory would: make the
	// DIRECTORY refuse new files by filling it with a name atomicWrite must skip. atomicWrite retries eight
	// random names (config.go:171-186), so a single file is not enough -- instead the directory is chmodded
	// where the host supports it, and the case SKIPS where it does not (Windows lets the owner write a 0555
	// directory, so this measurement belongs to the Linux gate).
	directory := filepath.Dir(path)
	if err := os.Chmod(directory, 0o555); err != nil {
		t.Fatalf("chmod %s: %v", directory, err)
	}
	t.Cleanup(func() { _ = os.Chmod(directory, 0o755) })
	if probeErr := os.WriteFile(filepath.Join(directory, ".probe"), []byte("x"), 0o644); probeErr == nil {
		_ = os.Remove(filepath.Join(directory, ".probe"))
		t.Skip("a 0555 directory is still writable for this process (the Windows behaviour), so the " +
			"interrupted-write path cannot be measured on this host; the Linux gate runs it")
	}

	result, err := Initialize(path)
	if err == nil {
		t.Fatalf("Initialize reported success (%+v) while the directory could not accept the temporary file "+
			"its atomic write needs: the migration claims to have happened", result)
	}
	if !strings.Contains(err.Error(), "update config") && !strings.Contains(err.Error(), "create config") {
		t.Fatalf("the write failure does not say it failed to WRITE the config, so a user cannot tell a "+
			"permission problem from a parse problem (AGENTS 35): %v", err)
	}

	// THE ORIGINAL IS INTACT, byte for byte -- the whole point of write-temp-then-rename.
	_ = os.Chmod(directory, 0o755)
	assertExactlyTheseBytes(t, path, planted, "an interrupted migration damaged the user's config")
	assertNoTemporaryFiles(t, directory)
}
