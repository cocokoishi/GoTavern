package migrate

// Contract tests for `gotavern migrate`. THERE IS NO PINNED ORACLE: pinned SillyTavern has no `migrate`
// subcommand, so none of this is parity and none of it is labelled as such. These are labelled
// SOURCE-DERIVED tests of the documented contract in docs/INSTALLATION.md section 6 -- each test names
// the section clause it checks, and the equivalence test compares GoTavern against GoTavern rather than
// against Node.
//
// The eight properties the lane was scoped with, and where each is asserted:
//   1. the source is READ-ONLY                       TestSourceIsNeverModified
//   2. a migrated install is EQUIVALENT to one
//      pointed at the source                         TestMigratedInstallIsEquivalentToPointingAtTheSource
//   3. --dry-run writes nothing                      TestDryRunWritesNothing
//   4. idempotence: refuses by name, or reproduces   TestSecondMigrationRefusesByName / ...ForceReproducesTheTree
//   5. plugins are REPORTED, never copied            TestPluginsAreReportedAndNeverCopied
//   6. unknown config keys survive byte for byte     TestConfigKeepsUnknownKeysAndChangesOnlyDataRoot
//   7. symlinks refused loudly, nothing written      TestSymlinksAreRefusedAndNothingIsWritten
//   8. every documented form, and named refusals     TestDocumentedForms / TestSourceRefusals

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/commandline"
	"github.com/cocokoishi/gotavern/internal/startup"
)

// ---- synthetic source trees ---------------------------------------------------------------

// treeEntry is the recorded shape of a tree: path, kind, size and hash. It is the same discipline the
// runtime round-trip fixture uses, so a reader can compare the two.
type treeEntry struct {
	Path   string
	Kind   string
	Bytes  int64
	SHA256 string
}

func snapshotTree(t *testing.T, root string) []treeEntry {
	t.Helper()
	entries := make([]treeEntry, 0)
	err := filepath.WalkDir(root, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		info, err := os.Lstat(current)
		if err != nil {
			return err
		}
		recorded := treeEntry{Path: filepath.ToSlash(relative)}
		switch {
		case info.Mode()&os.ModeSymlink != 0:
			target, err := os.Readlink(current)
			if err != nil {
				return err
			}
			recorded.Kind = "symlink:" + filepath.ToSlash(target)
		case info.IsDir():
			recorded.Kind = "directory"
		default:
			recorded.Kind = "file"
			recorded.Bytes = info.Size()
			body, err := os.ReadFile(current)
			if err != nil {
				return err
			}
			digest := sha256.Sum256(body)
			recorded.SHA256 = hex.EncodeToString(digest[:])
		}
		entries = append(entries, recorded)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Slice(entries, func(left, right int) bool { return entries[left].Path < entries[right].Path })
	return entries
}

func writeFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

// sourceConfig is a SillyTavern-shaped config: a relative data root, legacy keys the modern schema
// migrated away from, keys GoTavern has never heard of (which must survive), and a comment.
const sourceConfig = `# SillyTavern configuration, as the user wrote it
dataRoot: "./data"
port: 8000
listen: false
disableThumbnails: false
enableExtensions: true
userUnknownSetting: keep-me-please
customProviderOptions:
  someNestedKey: [1, 2, 3]
`

// buildSource creates a source installation with users, cards, chats, worlds, presets, settings,
// secrets, media, a global extension overlay, certs, plugins and a nested unknown config key.
func buildSource(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	writeFile(t, filepath.Join(root, "config.yaml"), sourceConfig)
	data := filepath.Join(root, "data")
	writeFile(t, filepath.Join(data, "cookie-secret.txt"), "a-generated-cookie-secret\n")
	writeFile(t, filepath.Join(data, "_storage", "3a5bb37ab86ac047d8ef481ee2e7bd3683d694ff8502a7cfe6951af849015dcc"),
		`{"key":"user:default-user","value":{"handle":"default-user","name":"User","created":1700000000000,"admin":true,"enabled":true}}`)
	writeFile(t, filepath.Join(data, "default-user", "characters", "Seraphina.png"), "card-bytes")
	writeFile(t, filepath.Join(data, "default-user", "chats", "Seraphina", "chat.jsonl"), "{\"mes\":\"hello\"}\n")
	writeFile(t, filepath.Join(data, "default-user", "worlds", "world.json"), "{\"entries\":{}}")
	writeFile(t, filepath.Join(data, "default-user", "OpenAI Settings", "preset.json"), "{\"temperature\":0.5}")
	writeFile(t, filepath.Join(data, "default-user", "settings.json"), "{\"customKey\":true}")
	writeFile(t, filepath.Join(data, "default-user", "secrets.json"), "{\"api_key_openai\":[]}")
	writeFile(t, filepath.Join(data, "default-user", "user", "images", "pic.png"), "image-bytes")
	writeFile(t, filepath.Join(data, "default-user", "backups", "settings_default-user_20250101-000000.json"), "{}")
	writeFile(t, filepath.Join(root, "public", "scripts", "extensions", "third-party", "probe-ext", "manifest.json"), `{"display_name":"Probe"}`)
	writeFile(t, filepath.Join(root, "certs", "cert.pem"), "cert-bytes")
	writeFile(t, filepath.Join(root, "certs", "privkey.pem"), "key-bytes")
	writeFile(t, filepath.Join(root, "plugins", "example-plugin", "index.js"), "module.exports = {};")
	writeFile(t, filepath.Join(root, "plugins", "other-plugin", "index.js"), "module.exports = {};")
	writeFile(t, filepath.Join(root, "node_modules", "left-pad", "index.js"), "not copied")
	return root
}

func runMigrate(t *testing.T, args ...string) string {
	t.Helper()
	options, err := ParseOptions(args)
	if err != nil {
		t.Fatalf("ParseOptions(%v): %v", args, err)
	}
	var stdout bytes.Buffer
	if err := Run(options, &stdout); err != nil {
		t.Fatalf("Run(%v): %v", args, err)
	}
	return stdout.String()
}

func migrateErr(t *testing.T, args ...string) error {
	t.Helper()
	options, err := ParseOptions(args)
	if err != nil {
		return err
	}
	return Run(options, io.Discard)
}

// ---- 1. the source is READ-ONLY -----------------------------------------------------------

// TestSourceIsNeverModified is section 6, "Source is strictly read-only during copy migration", and
// hard rule 14. The snapshot is taken before the migration and compared after, including the plugins
// directory that is reported but never copied and node_modules that is never touched.
func TestSourceIsNeverModified(t *testing.T) {
	source := buildSource(t)
	before := snapshotTree(t, source)

	dest := filepath.Join(t.TempDir(), "gotavern")
	runMigrate(t, "--from", source, "--dest", dest)

	after := snapshotTree(t, source)
	if !equalTrees(before, after) {
		t.Fatalf("the source changed during migration:\n%s", describeTreeDifference(before, after))
	}
	if treeEmpty(t, dest) {
		t.Fatal("the destination is empty after a real migration")
	}

	// And again for the forced path, which is the one that moves destination state around.
	if err := migrateErr(t, "--from", source, "--dest", dest, "--force"); err != nil {
		t.Fatalf("forced second migration: %v", err)
	}
	if afterForced := snapshotTree(t, source); !equalTrees(before, afterForced) {
		t.Fatalf("the source changed during a forced migration:\n%s", describeTreeDifference(before, afterForced))
	}
}

// ---- 2. a migrated install is EQUIVALENT to one pointed at the source ----------------------

// TestMigratedInstallIsEquivalentToPointingAtTheSource is section 6's purpose: after migration the
// runtime behaves like one pointed at the source. Two GOTAVERN boots are compared, never Node:
//
//	reference arm: a PRISTINE COPY of the whole source root (config + data together), booted in place;
//	migrated arm:  the destination this command wrote, booted in place.
//
// The reference arm uses a copy, not the source, because booting GoTavern over the source would write
// into it -- the property TestSourceIsNeverModified exists for. Exclusions are recorded below and each
// one has a reason; nothing is excluded silently.
func TestMigratedInstallIsEquivalentToPointingAtTheSource(t *testing.T) {
	source := buildSource(t)
	sourceBefore := snapshotTree(t, source)

	dest := filepath.Join(t.TempDir(), "gotavern")
	runMigrate(t, "--from", source, "--dest", dest)

	reference := filepath.Join(t.TempDir(), "reference")
	copyWholeTree(t, source, reference)

	startupAt(t, reference)
	startupAt(t, dest)

	referenceTree := snapshotTree(t, filepath.Join(reference, "data"))
	migratedTree := snapshotTree(t, filepath.Join(dest, "data"))

	// RECORDED EXCLUSIONS, each with its reason. They are the same classes the runtime round-trip
	// fixture declares: a generated secret, an account-store timestamp, boot statistics, the Node
	// webpack cache (absent from both GoTavern arms, so it never appears), and the timestamped backup
	// name. Nothing else is filtered.
	excluded := func(entry treeEntry) (string, bool) {
		switch {
		case entry.Path == "cookie-secret.txt":
			return "the cookie secret is generated per install", true
		case strings.HasPrefix(entry.Path, "_storage/"):
			return "the account store records a generated creation timestamp", true
		case entry.Path == "default-user/stats.json":
			return "startup statistics are time-dependent", true
		case strings.HasPrefix(entry.Path, "_webpack"):
			return "the Node webpack cache is per-process", true
		case strings.HasPrefix(entry.Path, "default-user/backups/") && strings.Contains(entry.Path, "settings_"):
			return "the settings backup filename contains a local timestamp", true
		}
		return "", false
	}
	if difference := describeFilteredDifference(referenceTree, migratedTree, excluded); difference != "" {
		t.Fatalf("a migrated install does not behave like one pointed at the source:\n%s", difference)
	}

	// The user content itself -- the part a user would notice -- must be present and identical in the
	// destination regardless of any exclusion.
	for _, required := range []string{
		"default-user/characters/Seraphina.png",
		"default-user/chats/Seraphina/chat.jsonl",
		"default-user/worlds/world.json",
		"default-user/OpenAI Settings/preset.json",
		"default-user/settings.json",
		"default-user/user/images/pic.png",
	} {
		entry, found := findEntry(migratedTree, required)
		if !found || entry.Kind != "file" || entry.Bytes == 0 {
			t.Fatalf("the migrated data root is missing user content: %s", required)
		}
	}
	if sourceAfter := snapshotTree(t, source); !equalTrees(sourceBefore, sourceAfter) {
		t.Fatal("the source changed while the two arms were booted")
	}
}

func startupAt(t *testing.T, root string) {
	t.Helper()
	installRoot := root
	parsed, err := commandline.ResolveCommandLine(commandline.ResolveOptions{
		Args:             []string{"--listen=false", "--enableIPv4", "true", "--enableIPv6", "false"},
		WorkingDirectory: installRoot,
		ServerDirectory:  installRoot,
	})
	if err != nil {
		t.Fatalf("resolve the command line in %s: %v", root, err)
	}
	if _, err := startup.InitializeDataStartupFromCommandLine(installRoot, parsed, time.UnixMilli(1735689600000), func(time.Duration) {}); err != nil {
		t.Fatalf("start the data chain in %s: %v", root, err)
	}
}

// ---- 3. --dry-run writes nothing ----------------------------------------------------------

// TestDryRunWritesNothing is section 6's `--dry-run` form plus the lane's property 3: nothing is written
// to EITHER side, and the plan printed is the plan a real run would execute.
func TestDryRunWritesNothing(t *testing.T) {
	source := buildSource(t)
	sourceBefore := snapshotTree(t, source)
	dest := filepath.Join(t.TempDir(), "gotavern")

	dryOutput := runMigrate(t, "--from", source, "--dest", dest, "--dry-run")
	if _, err := os.Stat(dest); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("--dry-run created the destination directory")
	}
	if after := snapshotTree(t, source); !equalTrees(sourceBefore, after) {
		t.Fatal("--dry-run modified the source")
	}
	for _, wanted := range []string{"source data:", "data:", "server plugins (NOT migrated, unsupported): example-plugin, other-plugin", "mode:", "dry run"} {
		if !strings.Contains(dryOutput, wanted) {
			t.Fatalf("the dry-run report does not contain %q:\n%s", wanted, dryOutput)
		}
	}

	realOutput := runMigrate(t, "--from", source, "--dest", dest)
	// The plan lines must match; only the mode footer and the trailing progress lines differ.
	dryPlan := planLines(dryOutput)
	realPlan := planLines(realOutput)
	if len(dryPlan) != len(realPlan) {
		t.Fatalf("dry-run plan has %d lines, the real run %d:\n--- dry ---\n%s\n--- real ---\n%s", len(dryPlan), len(realPlan), dryOutput, realOutput)
	}
	for index := range dryPlan {
		if dryPlan[index] != realPlan[index] {
			t.Fatalf("dry-run plan line %d differs from the real run: %q vs %q", index, dryPlan[index], realPlan[index])
		}
	}
}

// planLines drops the mode footer and keeps the plan body, so a dry run and a real run can be compared
// line for line.
func planLines(output string) []string {
	lines := make([]string, 0)
	for _, line := range strings.Split(output, "\n") {
		if strings.Contains(line, "mode:") || strings.Contains(line, "dry run:") {
			continue
		}
		if strings.HasPrefix(line, "copied ") || strings.HasPrefix(line, "verified ") || strings.HasPrefix(line, "migrated into") || strings.HasPrefix(line, "the source was not modified") || line == "" {
			continue
		}
		lines = append(lines, line)
	}
	return lines
}

// ---- 4. idempotence: refuse by name, or reproduce the tree --------------------------------

// TestSecondMigrationRefusesByName is the documented choice for property 4: a second migration into a
// destination that already holds a runtime REFUSES, naming what is in the way. It does not merge, and it
// does not silently overwrite.
func TestSecondMigrationRefusesByName(t *testing.T) {
	source := buildSource(t)
	dest := filepath.Join(t.TempDir(), "gotavern")
	runMigrate(t, "--from", source, "--dest", dest)

	err := migrateErr(t, "--from", source, "--dest", dest)
	if err == nil {
		t.Fatal("a second migration into the same destination succeeded")
	}
	if !IsRefusal(err) {
		t.Fatalf("the second migration failed with an I/O error rather than a refusal: %v", err)
	}
	for _, wanted := range []string{"config.yaml", "data", "--force"} {
		if !strings.Contains(err.Error(), wanted) {
			t.Fatalf("the refusal does not mention %q: %v", wanted, err)
		}
	}
}

// TestForcedSecondMigrationReproducesTheTree is the other half: with --force the destination state is
// moved to .migrate-backup and the tree that results is the same tree the first migration produced,
// apart from that backup directory (recorded here, not filtered silently).
func TestForcedSecondMigrationReproducesTheTree(t *testing.T) {
	source := buildSource(t)
	dest := filepath.Join(t.TempDir(), "gotavern")
	runMigrate(t, "--from", source, "--dest", dest)
	first := snapshotTree(t, dest)

	if err := migrateErr(t, "--from", source, "--dest", dest, "--force"); err != nil {
		t.Fatalf("forced second migration: %v", err)
	}
	second := snapshotTree(t, dest)
	withoutBackup := func(entries []treeEntry) []treeEntry {
		kept := make([]treeEntry, 0, len(entries))
		for _, entry := range entries {
			if entry.Path == DestBackupName || strings.HasPrefix(entry.Path, DestBackupName+"/") {
				continue
			}
			kept = append(kept, entry)
		}
		return kept
	}
	if !equalTrees(first, withoutBackup(second)) {
		t.Fatalf("a forced re-migration did not reproduce the tree:\n%s", describeTreeDifference(first, withoutBackup(second)))
	}
	// The backup must exist and must hold what was there before, or --force silently destroyed state.
	if _, found := findEntry(second, DestBackupName+"/config.yaml"); !found {
		t.Fatal("--force did not preserve the previous destination config in the backup")
	}
	// A third forced run refuses: the backup already exists, so nothing is silently discarded.
	if err := migrateErr(t, "--from", source, "--dest", dest, "--force"); err == nil {
		t.Fatal("a second forced migration overwrote the existing backup")
	}
}

// ---- 5. plugins are REPORTED, never copied ------------------------------------------------

// TestPluginsAreReportedAndNeverCopied is section 6's "Node server plugins" clause and hard rule 16.
func TestPluginsAreReportedAndNeverCopied(t *testing.T) {
	source := buildSource(t)
	dest := filepath.Join(t.TempDir(), "gotavern")
	output := runMigrate(t, "--from", source, "--dest", dest)

	if !strings.Contains(output, "server plugins (NOT migrated, unsupported): example-plugin, other-plugin") {
		t.Fatalf("the report does not name the plugins:\n%s", output)
	}
	if _, err := os.Stat(filepath.Join(dest, "plugins")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the destination gained a plugins directory")
	}
	for _, entry := range snapshotTree(t, dest) {
		if strings.Contains(entry.Path, "/plugins/") || strings.Contains(entry.Path, "node_modules") {
			t.Fatalf("the destination contains %s, which migration must not copy", entry.Path)
		}
	}
}

// ---- 6. unknown config keys survive byte for byte -----------------------------------------

// TestConfigKeepsUnknownKeysAndChangesOnlyDataRoot is hard rule 11 and section 6's "updates only the
// destination config copy". The comparison is BYTE-WISE against a documented expectation -- the source
// bytes with exactly one line replaced -- not "it parses".
func TestConfigKeepsUnknownKeysAndChangesOnlyDataRoot(t *testing.T) {
	source := buildSource(t)
	dest := filepath.Join(t.TempDir(), "gotavern")
	runMigrate(t, "--from", source, "--dest", dest)

	sourceConfigBytes, err := os.ReadFile(filepath.Join(source, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	written, err := os.ReadFile(filepath.Join(dest, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	// The source QUOTED its data root and the destination does not, which is the documented single
	// change: exactly that one scalar differs and every other byte survives. The source being quoted is
	// what makes a write-back to the source visible, which is how TestSourceIsNeverModified can see it.
	expectedQuoted := strings.Replace(string(sourceConfigBytes), "dataRoot: \"./data\"\n", "dataRoot: ./data\n", 1)
	if string(written) != expectedQuoted {
		t.Fatalf("the destination config is not the source config with one scalar changed:\n--- want ---\n%s\n--- got ---\n%s", expectedQuoted, string(written))
	}

	// Now an ABSOLUTE source data root: only the dataRoot line may change. This source writes the
	// scalar UNQUOTED, so the two cases stay distinguishable -- quoted relative in, unquoted relative
	// out above; unquoted absolute in, unquoted relative out here.
	absoluteSource := filepath.Join(t.TempDir(), "absolute-source")
	externalData := filepath.Join(t.TempDir(), "external-data")
	writeFile(t, filepath.Join(absoluteSource, "config.yaml"), strings.Replace(sourceConfig, "\"./data\"", externalData, 1))
	writeFile(t, filepath.Join(externalData, "default-user", "worlds", "world.json"), `{"entries":{}}`)
	absoluteDest := filepath.Join(t.TempDir(), "gotavern")
	runMigrate(t, "--from", absoluteSource, "--dest", absoluteDest)
	written, err = os.ReadFile(filepath.Join(absoluteDest, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	sourceBytes, err := os.ReadFile(filepath.Join(absoluteSource, "config.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	expectedBytes := strings.Replace(string(sourceBytes), "dataRoot: "+externalData, "dataRoot: ./data", 1)
	if string(written) != expectedBytes {
		t.Fatalf("the absolute-data-root destination config changed more than the dataRoot line:\n--- want ---\n%s\n--- got ---\n%s", expectedBytes, string(written))
	}
	if _, statErr := os.Stat(filepath.Join(absoluteDest, "data", "default-user", "worlds", "world.json")); statErr != nil {
		t.Fatalf("the out-of-tree data root was not copied into the destination: %v", statErr)
	}
	// The unknown nested key and the comment must have survived, which is the point of a textual edit.
	if !strings.Contains(string(written), "userUnknownSetting: keep-me-please") ||
		!strings.Contains(string(written), "someNestedKey: [1, 2, 3]") ||
		!strings.Contains(string(written), "# SillyTavern configuration, as the user wrote it") {
		t.Fatalf("the destination config lost source content:\n%s", string(written))
	}
}

// ---- 7. symlinks are refused loudly ------------------------------------------------------

// TestSymlinksAreRefusedAndNothingIsWritten is section 6's symlink clause: a copied installation must
// not silently retain links into the old source tree, so links are refused by name and nothing is
// written.
func TestSymlinksAreRefusedAndNothingIsWritten(t *testing.T) {
	source := buildSource(t)
	linkPath := filepath.Join(source, "data", "default-user", "characters", "linked")
	if err := os.Symlink("Seraphina.png", linkPath); err != nil {
		t.Skipf("this platform cannot create symlinks: %v", err)
	}
	sourceBefore := snapshotTree(t, source)
	dest := filepath.Join(t.TempDir(), "gotavern")

	err := migrateErr(t, "--from", source, "--dest", dest)
	if err == nil {
		t.Fatal("a source containing a symlink migrated successfully")
	}
	if !IsRefusal(err) || !strings.Contains(err.Error(), "symlinks") || !strings.Contains(err.Error(), "characters/linked") {
		t.Fatalf("the symlink refusal does not name the link: %v", err)
	}
	if _, statErr := os.Stat(dest); !errors.Is(statErr, os.ErrNotExist) {
		t.Fatal("a refused migration wrote the destination anyway")
	}
	if after := snapshotTree(t, source); !equalTrees(sourceBefore, after) {
		t.Fatal("a refused migration modified the source")
	}
}

// ---- 8. the documented forms, and named refusals -----------------------------------------

// TestDocumentedForms is section 6's "Migration forms that must be supported": all four forms parse and
// run, and each produces a destination with the data and config in place.
func TestDocumentedForms(t *testing.T) {
	source := buildSource(t)

	t.Run("fromDest", func(t *testing.T) {
		dest := filepath.Join(t.TempDir(), "gotavern")
		runMigrate(t, "--from", source, "--dest", dest)
		assertMigrated(t, source, dest)
	})
	t.Run("sourceConfigAndData", func(t *testing.T) {
		dest := filepath.Join(t.TempDir(), "gotavern")
		runMigrate(t, "--source-config", filepath.Join(source, "config.yaml"),
			"--source-data", filepath.Join(source, "data"), "--dest", dest)
		assertMigrated(t, source, dest)
	})
	t.Run("sourceGlobal", func(t *testing.T) {
		global := t.TempDir()
		writeFile(t, filepath.Join(global, "config.yaml"), sourceConfig)
		writeFile(t, filepath.Join(global, "data", "default-user", "worlds", "world.json"), `{"entries":{}}`)
		options, err := ParseOptions([]string{"--source-global", "--dest", filepath.Join(t.TempDir(), "gotavern")})
		if err != nil {
			t.Fatal(err)
		}
		options.GlobalDataDirectory = global
		var stdout bytes.Buffer
		if err := Run(options, &stdout); err != nil {
			t.Fatalf("--source-global: %v", err)
		}
		assertMigrated(t, global, options.Dest)
	})
	t.Run("fromDryRun", func(t *testing.T) {
		dest := filepath.Join(t.TempDir(), "gotavern")
		runMigrate(t, "--from", source, "--dest", dest, "--dry-run")
		if _, err := os.Stat(dest); !errors.Is(err, os.ErrNotExist) {
			t.Fatal("the --dry-run form wrote the destination")
		}
	})
}

// assertMigrated checks the destination in BOTH directions: what the source has must arrive, and what
// the source does not have must not appear. A one-directional check would pass for a migration that
// invented a certs/ directory or an empty overlay.
func assertMigrated(t *testing.T, source, dest string) {
	t.Helper()
	if _, err := os.Stat(filepath.Join(dest, "config.yaml")); err != nil {
		t.Fatalf("no config.yaml in %s", dest)
	}
	if _, err := os.Stat(filepath.Join(dest, "data")); err != nil {
		t.Fatalf("no data directory in %s", dest)
	}
	for _, tree := range []struct{ name, sourcePath, destPath string }{
		{"certs", filepath.Join(source, DestCertsName), filepath.Join(dest, DestCertsName)},
		{"global extension overlay", filepath.Join(source, filepath.FromSlash(DestOverlayPath)), filepath.Join(dest, filepath.FromSlash(DestOverlayPath))},
	} {
		_, sourceErr := os.Stat(tree.sourcePath)
		_, destErr := os.Stat(tree.destPath)
		if sourceErr == nil && destErr != nil {
			t.Fatalf("the source has %s but the destination does not", tree.name)
		}
		if sourceErr != nil && destErr == nil {
			t.Fatalf("the destination gained %s, which the source does not have", tree.name)
		}
	}
}

// TestSourceRefusals covers the named refusals: no source, two sources, half a source pair, no
// destination, an unknown flag, a missing root, a source inside the destination, and a destination
// inside the source. A guess here writes user data somewhere nobody named.
func TestSourceRefusals(t *testing.T) {
	source := buildSource(t)
	dest := filepath.Join(t.TempDir(), "gotavern")
	cases := []struct {
		name string
		args []string
		want string
	}{
		{"noSource", []string{"--dest", dest}, "no source given"},
		{"twoSources", []string{"--from", source, "--source-global", "--dest", dest}, "more than one source"},
		{"halfPair", []string{"--source-config", filepath.Join(source, "config.yaml"), "--dest", dest}, "must be given together"},
		{"noDest", []string{"--from", source}, "--dest is required"},
		{"unknownFlag", []string{"--from", source, "--dest", dest, "--nope"}, "unknown argument"},
		{"missingRoot", []string{"--from", filepath.Join(t.TempDir(), "nothing-here"), "--dest", dest}, "is not a directory"},
		{"destInsideSource", []string{"--from", source, "--dest", filepath.Join(source, "inside")}, "the destination is inside the source"},
		{"sourceInsideDest", []string{"--from", source, "--dest", filepath.Dir(source)}, "the source is inside the destination"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			err := migrateErr(t, testCase.args...)
			if err == nil {
				t.Fatalf("%v was accepted", testCase.args)
			}
			if !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("refusal for %v = %q, want it to mention %q", testCase.args, err.Error(), testCase.want)
			}
			if _, statErr := os.Stat(filepath.Join(source, "inside")); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatal("a refused migration wrote into the source")
			}
		})
	}
}

// TestCopyVerificationCatchesAShortFile exercises the post-copy verification with the input that would
// break it. "verified N files byte for byte" is a claim about bytes, so the test mutates one copied byte
// and one path's presence, and requires each to be named.
func TestCopyVerificationCatchesAShortFile(t *testing.T) {
	source := buildSource(t)
	destination := filepath.Join(t.TempDir(), "copy")
	copyWholeTree(t, source, destination)
	if _, err := verifyCopy(source, destination); err != nil {
		t.Fatalf("an untouched copy failed verification: %v", err)
	}

	shortPath := filepath.Join(destination, "data", "default-user", "worlds", "world.json")
	writeFile(t, shortPath, `{"entries":`)
	if _, err := verifyCopy(filepath.Join(source, "data"), filepath.Join(destination, "data")); err == nil {
		t.Fatal("verification accepted a file that differs from its source")
	} else if !strings.Contains(err.Error(), "worlds/world.json") {
		t.Fatalf("the verification failure does not name the file: %v", err)
	}

	// Restore, then prove a MISSING file is also caught rather than silently tolerated.
	copyWholeTree(t, filepath.Join(source, "data"), filepath.Join(t.TempDir(), "scratch"))
	if err := os.Remove(filepath.Join(destination, "data", "default-user", "worlds", "world.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyCopy(filepath.Join(source, "data"), filepath.Join(destination, "data")); err == nil {
		t.Fatal("verification accepted a copy that is missing a file")
	}
}

// ---- tree helpers -------------------------------------------------------------------------

func equalTrees(left, right []treeEntry) bool {
	return describeTreeDifference(left, right) == ""
}

func describeTreeDifference(left, right []treeEntry) string {
	if len(left) != len(right) {
		return "entry counts differ: " + strconv.Itoa(len(left)) + " vs " + strconv.Itoa(len(right))
	}
	for index := range left {
		if left[index] != right[index] {
			return "entry " + strconv.Itoa(index) + " differs: " + left[index].Path + " vs " + right[index].Path
		}
	}
	return ""
}

func describeFilteredDifference(reference, migrated []treeEntry, excluded func(treeEntry) (string, bool)) string {
	keep := func(entries []treeEntry) []treeEntry {
		kept := make([]treeEntry, 0, len(entries))
		for _, entry := range entries {
			if _, skip := excluded(entry); skip {
				continue
			}
			kept = append(kept, entry)
		}
		return kept
	}
	referenceKept := keep(reference)
	migratedKept := keep(migrated)
	if len(referenceKept) != len(migratedKept) {
		return "entry counts differ after exclusions: " + strconv.Itoa(len(referenceKept)) + " vs " + strconv.Itoa(len(migratedKept))
	}
	for index := range referenceKept {
		if referenceKept[index] != migratedKept[index] {
			return "entry differs: " + referenceKept[index].Path + " (" + referenceKept[index].Kind + " " + referenceKept[index].SHA256 + ") vs " + migratedKept[index].Path + " (" + migratedKept[index].Kind + " " + migratedKept[index].SHA256 + ")"
		}
	}
	return ""
}

func findEntry(entries []treeEntry, path string) (treeEntry, bool) {
	for _, entry := range entries {
		if entry.Path == path {
			return entry, true
		}
	}
	return treeEntry{}, false
}

func treeEmpty(t *testing.T, path string) bool {
	t.Helper()
	return len(snapshotTree(t, path)) == 0
}

func copyWholeTree(t *testing.T, source, destination string) {
	t.Helper()
	if _, _, err := copyTree(source, destination); err != nil {
		t.Fatalf("copy %s: %v", source, err)
	}
}
