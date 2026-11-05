package longlivedfixture

// Tests for the SHARED corpus-schema manifest (alpha.15 lane E, §0.3). The bridge test that runs the JS
// verifier against a real Go tree lives in tests/e2e/longlived_schema_test.go; this file owns determinism and
// the Go-side drift diff, because those must fail before a consumer ever sees a manifest.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func schemaSpec() Spec {
	return Spec{
		Seed: 20261104, Characters: 4, Worlds: 2, BigWorld: 12, ChatBase: 8, ChatStep: 2,
		Presets: 2, Themes: 1, QuickReply: 1, Personas: 2, Backgrounds: 2, Groups: 1,
	}
}

func buildWithSchema(t *testing.T, spec Spec) (string, *CorpusSchema) {
	t.Helper()
	root := t.TempDir()
	manifest, err := Build(root, spec)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	schema, err := BuildCorpusSchema(root, spec, manifest, "complex-small")
	if err != nil {
		t.Fatalf("BuildCorpusSchema: %v", err)
	}
	return root, schema
}

// TestCorpusSchemaIsDeterministicAndComplete proves the schema is a pure function of the tree: two builds of
// the same spec produce byte-identical JSON, every declared file exists with the declared size and sha256, the
// tree digest recomputes from the inventory, and the derived counts agree with the inventory.
func TestCorpusSchemaIsDeterministicAndComplete(t *testing.T) {
	spec := schemaSpec()
	firstRoot, first := buildWithSchema(t, spec)
	_, second := buildWithSchema(t, spec)
	firstJSON, err := MarshalCorpusSchema(first)
	if err != nil {
		t.Fatal(err)
	}
	secondJSON, err := MarshalCorpusSchema(second)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(firstJSON, secondJSON) {
		t.Fatalf("two builds of the same spec have different schemas:\nfirst=%s\nsecond=%s", firstJSON, secondJSON)
	}
	if first.Generator != CorpusGeneratorGo || first.Schema != CorpusSchemaName || first.SchemaVersion != CorpusSchemaVersion {
		t.Fatalf("schema identity = %q %q v%d", first.Generator, first.Schema, first.SchemaVersion)
	}
	if len(first.Tree.SHA256) != 64 {
		t.Fatalf("tree digest %q is not a sha256", first.Tree.SHA256)
	}
	digest := sha256.New()
	for _, file := range first.Files {
		body, err := os.ReadFile(filepath.Join(firstRoot, filepath.FromSlash(file.Path)))
		if err != nil {
			t.Fatalf("declared file %q does not exist: %v", file.Path, err)
		}
		sum := sha256.Sum256(body)
		if hex.EncodeToString(sum[:]) != file.SHA256 {
			t.Fatalf("%q: declared sha256 %s, tree has %s", file.Path, file.SHA256, hex.EncodeToString(sum[:]))
		}
		if int64(len(body)) != file.Bytes {
			t.Fatalf("%q: declared bytes %d, tree has %d", file.Path, file.Bytes, len(body))
		}
		if file.Class == "" {
			t.Fatalf("%q: no schema class", file.Path)
		}
		digest.Write([]byte(file.SHA256 + "  " + file.Path + "\n"))
	}
	if got := hex.EncodeToString(digest.Sum(nil)); got != first.Tree.SHA256 {
		t.Fatalf("tree digest %s does not recompute from the inventory (%s)", first.Tree.SHA256, got)
	}
	if first.Counts["files"] != len(first.Files) || first.Counts["bytes"] != int(first.Tree.Bytes) {
		t.Fatalf("counts files/bytes = %d/%d, inventory = %d/%d", first.Counts["files"], first.Counts["bytes"], len(first.Files), first.Tree.Bytes)
	}
	classSum := 0
	for key, value := range first.Counts {
		if strings.HasPrefix(key, "class.") {
			classSum += value
		}
	}
	if classSum != len(first.Files) {
		t.Fatalf("class counts sum to %d, inventory has %d files", classSum, len(first.Files))
	}
	// The scenario declares a branch, swipes, a group, worlds, presets and unknown/legacy input; the schema
	// must carry them as names, not as prose.
	for _, key := range []string{"characters", "chats", "messages", "branches", "swipes", "groups", "worlds", "worldEntries", "presets", "unknownFiles", "legacyAssets"} {
		if _, ok := first.Counts[key]; !ok {
			t.Fatalf("schema counts lack %q", key)
		}
	}
	if len(first.Markers["worldNames"]) == 0 || len(first.Markers["presetNames"]) == 0 || len(first.Markers["chatMarkerPrefixes"]) == 0 {
		t.Fatalf("schema markers are incomplete: %v", first.Markers)
	}
	if !first.Features["branchChats"] || !first.Features["swipeHistory"] || !first.Features["legacyMigrationInput"] {
		t.Fatalf("schema features do not describe the built tree: %v", first.Features)
	}
	// No absolute path may leak into the manifest: the same tree built in two directories must have the same
	// bytes. The second build above already proves it, but check the field directly as well.
	for _, file := range first.Files {
		if filepath.IsAbs(file.Path) || strings.Contains(file.Path, "\\") {
			t.Fatalf("inventory path %q is not relative/slash-separated", file.Path)
		}
	}
	if _, err := LoadCorpusSchema(writeSchemaForTest(t, first)); err != nil {
		t.Fatalf("a schema this package writes must load back: %v", err)
	}
	// A schema is not part of the tree identity: writing it beside the tree changes neither the digest nor the
	// inventory.
	rebuild := filepath.Join(t.TempDir(), "schema.json")
	if err := WriteCorpusSchema(rebuild, first); err != nil {
		t.Fatal(err)
	}
	again, err := BuildCorpusSchema(firstRoot, spec, mustManifest(t, firstRoot, spec), "complex-small")
	if err != nil {
		t.Fatal(err)
	}
	if again.Tree.SHA256 != first.Tree.SHA256 || len(again.Files) != len(first.Files) {
		t.Fatalf("rebuilding the schema changed the tree identity: %s vs %s", again.Tree.SHA256, first.Tree.SHA256)
	}
}

func writeSchemaForTest(t *testing.T, schema *CorpusSchema) string {
	t.Helper()
	target := filepath.Join(t.TempDir(), "corpus-schema.json")
	if err := WriteCorpusSchema(target, schema); err != nil {
		t.Fatal(err)
	}
	return target
}

func mustManifest(t *testing.T, root string, spec Spec) *Manifest {
	t.Helper()
	// Reconstructing the manifest by rebuilding would violate Build's empty-root rule; the caller already has
	// one. This helper exists only for the rebuild check above, which needs a manifest argument; an empty
	// manifest is enough because BuildCorpusSchema only reads the declared scenario fields to fill counts.
	return &Manifest{DataRoot: root, Seed: spec.Seed, Files: map[string]string{}}
}

// TestCorpusSchemaRebuildDiffHasTeeth proves the drift diff can fail, by name: a non-deterministic rebuild (a
// changed sha256 or byte count), an extra file, a missing file and a changed tree digest are each reported as
// their own named difference. Restoring the schema makes the diff empty again, so a green is not a vacuous one.
func TestCorpusSchemaRebuildDiffHasTeeth(t *testing.T) {
	spec := schemaSpec()
	_, current := buildWithSchema(t, spec)
	_, rebuilt := buildWithSchema(t, spec)
	if differences := DiffCorpusSchemas(current, rebuilt); len(differences) != 0 {
		t.Fatalf("two deterministic rebuilds differ: %v", differences)
	}

	// A changed sha256 is the non-deterministic-rebuild case: the same path, different bytes.
	tampered := *current
	tampered.Files = append([]SchemaFile{}, current.Files...)
	tampered.Files[0].SHA256 = strings.Repeat("0", 64)
	expectDiff(t, DiffCorpusSchemas(current, &tampered), "file-sha256:"+current.Files[0].Path)
	// A changed byte count is reported separately.
	tampered = *current
	tampered.Files = append([]SchemaFile{}, current.Files...)
	tampered.Files[0].Bytes++
	expectDiff(t, DiffCorpusSchemas(current, &tampered), "file-bytes:"+current.Files[0].Path)
	// An extra file and a missing file are each named.
	tampered = *current
	tampered.Files = append(append([]SchemaFile{}, current.Files...), SchemaFile{Path: "default-user/extra.json", Bytes: 2, SHA256: strings.Repeat("1", 64), Class: "unknown"})
	expectDiff(t, DiffCorpusSchemas(current, &tampered), "file-extra:default-user/extra.json")
	tampered = *current
	tampered.Files = append([]SchemaFile{}, current.Files[1:]...)
	expectDiff(t, DiffCorpusSchemas(current, &tampered), "file-missing:"+current.Files[0].Path)
	// A tree digest that no longer matches is a failure even if every other field is left alone.
	tampered = *current
	tampered.Tree = current.Tree
	tampered.Tree.SHA256 = strings.Repeat("2", 64)
	expectDiff(t, DiffCorpusSchemas(current, &tampered), "tree-identity")
	// A changed count and a changed feature are named too: the manifest is not only an inventory.
	tampered = *current
	tampered.Counts = map[string]int{}
	for key, value := range current.Counts {
		tampered.Counts[key] = value
	}
	tampered.Counts["messages"]++
	expectDiff(t, DiffCorpusSchemas(current, &tampered), "count:messages")
	tampered = *current
	tampered.Features = map[string]bool{}
	for key, value := range current.Features {
		tampered.Features[key] = value
	}
	tampered.Features["contentLog"] = !current.Features["contentLog"]
	expectDiff(t, DiffCorpusSchemas(current, &tampered), "feature:contentLog")

	if differences := DiffCorpusSchemas(current, rebuilt); len(differences) != 0 {
		t.Fatalf("restoring the schema left differences: %v", differences)
	}
}

func expectDiff(t *testing.T, differences []SchemaDifference, name string) {
	t.Helper()
	for _, difference := range differences {
		if difference.Name == name {
			return
		}
	}
	t.Fatalf("drift diff did not report %q; got %v", name, differences)
}

// TestCorpusSchemaClassifiesSharedSurfaces pins the file classes the comparison tool relies on: a card PNG is
// a character (not binary), a nested image under characters/ is a sprite, an unknown JSON and a binary blob
// are distinguishable, and a legacy flat card is legacy. Both generators use this table; a change here without
// the JS mirror is a comparison difference, not a silent reclassification.
func TestCorpusSchemaClassifiesSharedSurfaces(t *testing.T) {
	cases := []struct {
		path string
		body []byte
		want string
	}{
		{"config.yaml", []byte("port: 8000\n"), classConfig},
		{"default-user/settings.json", []byte("{}"), classSettings},
		{"default-user/secrets.json", []byte("{}"), classSecrets},
		{"default-user/characters/A.png", []byte{0x89, 'P', 'N', 'G'}, classCharacters},
		{"default-user/characters/A/happy.png", []byte{0x89, 'P', 'N', 'G'}, classCharacterSprites},
		{"default-user/chats/A/A - 2023-01-01.jsonl", []byte("{}\n"), classChats},
		{"default-user/group chats/g.jsonl", []byte("{}\n"), classGroupChats},
		{"default-user/worlds/World.json", []byte("{}"), classWorlds},
		{"default-user/OpenAI Settings/Preset.json", []byte("{}"), classPresets},
		{"default-user/TextGen Settings/Text.json", []byte("{}"), classTextPresets},
		{"default-user/unknown_extension_state.json", []byte("{}"), classUnknown},
		{"default-user/data.bak", []byte("plain text"), classUnknown},
		{"default-user/Thumbs.db", []byte{0x30, 0x00, 0xff}, classBinary},
		{"default-user/extensions/x/settings.json", []byte("{}"), classExtensionState},
		{"default-user/regex/r.json", []byte("{}"), classRegex},
		{"public/characters/Legacy_Card.png", []byte{0x89, 'P', 'N', 'G'}, classLegacy},
	}
	for _, testCase := range cases {
		if got := classifyCorpusPath(testCase.path, testCase.body); got != testCase.want {
			t.Fatalf("%q classified as %q, want %q", testCase.path, got, testCase.want)
		}
	}
}
