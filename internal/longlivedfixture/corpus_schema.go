package longlivedfixture

// THE SHARED CORPUS-SCHEMA MANIFEST (alpha.15 lane E, §0.3).
//
// TWO GENERATORS EXIST, AND THIS FILE IS THE COMMON LANGUAGE BETWEEN THEM:
//
//   - `internal/longlivedfixture` (this package) builds the COMPLEX synthetic instance consumed by the Go
//     qualification tests (`tests/e2e/longlived_complex*_test.go`) and by `cmd/build-longlived`;
//   - `tools/build-longlived-corpus.mjs` builds the long-lived corpus consumed by the browser driver
//     (`tests/browser/longlived-qualify.mjs`), the browser probe and the Go corpus gate
//     (`tests/e2e/longlived_corpus_test.go`).
//
// §0.3 asked whether ONE deterministic initial corpus can feed Go, Node, browser and provider-wire tests.
// The answer this file makes checkable is: ONE SCHEMA can describe either corpus, and any consumer can
// verify the tree it is about to drive against that schema byte-for-byte, but the two trees are NOT one
// corpus — they have different generators, different structures and different scenario coverage, and the
// measured comparison in `tools/longlived/compare-corpora.mjs` names every difference class instead of
// asserting equivalence. A schema is a description of a tree, not a claim that two trees are equal.
//
// THE SCHEMA (schema name `gotavern-corpus-schema`, version 1; the JS builder emits the SAME shape from
// `tools/longlived/corpus-schema.mjs`, and `tools/longlived/verify-corpus-schema.mjs` verifies any tree
// against it):
//
//   - `schema` / `schemaVersion`: the shared manifest contract; a consumer refuses an unknown schema.
//   - `generator` / `generatorVersion`: which builder produced the tree (`internal/longlivedfixture` or
//     `tools/build-longlived-corpus.mjs`). This is an identity field, not a claim of equality.
//   - `size` / `seed`: the generator's size label and seed, so a rebuild can be compared same-input.
//   - `counts`: derived counts (files, bytes and the scenario counts the generator declared); a consumer
//     verifies the DERIVED subset (files, bytes, per-class counts) against the tree and treats the rest as
//     the generator's declaration.
//   - `features`: named capabilities (branches, swipes, embedded character book, sprites, world regex keys,
//     legacy migration input, binary unknown files, unicode names, ...), each a BOOLEAN. The comparison
//     tool reports every feature that differs; that is how "the two corpora cover different scenarios" is
//     measured rather than asserted.
//   - `markers`: the text markers a probe may search for (unicode names, chat/world/card marker prefixes,
//     unknown settings/config keys, world and preset names), per name. Values are sorted arrays.
//   - `tree`: `sha256` over the sorted `<sha256>  <path>\n` lines of every file except the metadata
//     manifests themselves (`manifest.json`, `corpus-schema.json`), plus `files` and `bytes`.
//   - `files`: the inventory, sorted by forward-slash relative path: `{path, bytes, sha256, class}`.
//     `class` is from ONE classifier table shared with the JS module, so the same path classifies the same
//     way on both sides; the comparison flags any class disagreement.
//
// DETERMINISM. Nothing here reads a clock, an environment variable, a working directory or a random source:
// the manifest is a pure function of the tree bytes plus the values the generator declares. Two builds of
// the same spec must produce identical JSON, and `TestCorpusSchemaIsDeterministic` plus
// `TestCorpusSchemaRebuildDiffHasTeeth` enforce that. The tree digest uses the same line format as the JS
// builder's `treeDigest`, so a consumer can compare the identity line-for-line without re-deriving it.
//
// NO TIMESTAMPS, NO ABSOLUTE PATHS. The schema never records mtime, mode or the absolute root, so the same
// corpus built in different directories has the same schema bytes.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

const (
	// CorpusSchemaName is the shared manifest contract name; consumers refuse anything else.
	CorpusSchemaName = "gotavern-corpus-schema"
	// CorpusSchemaVersion is the shared manifest contract version.
	CorpusSchemaVersion = 1
	// CorpusGeneratorGo identifies the Go generator in `generator`.
	CorpusGeneratorGo = "internal/longlivedfixture"
	// CorpusGeneratorJS identifies the JavaScript corpus generator in `generator`. The scenario block's
	// replay command is checked against the generator identity it names, so both constants are shared.
	CorpusGeneratorJS = "tools/build-longlived-corpus.mjs"
	// CorpusGeneratorVersion is the Go generator's own version, bumped when its bytes change.
	CorpusGeneratorVersion = 1
)

// CorpusSchemaMetadataNames are the governance manifests that describe a tree but are not part of its
// identity. They are excluded from `files` and from the tree digest on BOTH sides, which is what lets a Go
// tree (no `manifest.json`) and a JS tree (which has one) be compared on the same terms.
var CorpusSchemaMetadataNames = map[string]bool{
	"manifest.json":      true,
	"corpus-schema.json": true,
}

// SchemaFile is one inventory row. Path is relative, forward-slash, sorted.
type SchemaFile struct {
	Path   string `json:"path"`
	Bytes  int64  `json:"bytes"`
	SHA256 string `json:"sha256"`
	Class  string `json:"class"`
}

// SchemaTree is the tree identity computed over the inventory. Its digest format matches the JS builder's
// `treeDigest` exactly: sha256 of concatenated `"<sha256>  <path>\n"` lines sorted by path.
type SchemaTree struct {
	SHA256 string `json:"sha256"`
	Files  int    `json:"files"`
	Bytes  int64  `json:"bytes"`
}

// CorpusSchema is the shared manifest. Field order is fixed by this struct and maps marshal in sorted key
// order, so the JSON is byte-stable for the same tree. `Scenario` is the alpha.16 M1 extension: an OPTIONAL,
// independently versioned scenario/interaction block appended after `files`. A manifest that omits it is the
// pre-M1 v1 shape and marshals byte-identically, which is what makes the extension backward-compatible.
type CorpusSchema struct {
	Schema           string              `json:"schema"`
	SchemaVersion    int                 `json:"schemaVersion"`
	Generator        string              `json:"generator"`
	GeneratorVersion int                 `json:"generatorVersion"`
	Size             string              `json:"size"`
	Seed             string              `json:"seed"`
	Counts           map[string]int      `json:"counts"`
	Features         map[string]bool     `json:"features"`
	Markers          map[string][]string `json:"markers"`
	Tree             SchemaTree          `json:"tree"`
	Files            []SchemaFile        `json:"files"`
	Scenario         *CorpusScenario     `json:"scenario,omitempty"`
}

// SchemaDifference is one named, measured drift between two schemas (or a schema and a tree). The name is
// the assertion a gate reports, e.g. "file-sha256:default-user/settings.json".
type SchemaDifference struct {
	Name  string
	Left  string
	Right string
}

// BuildCorpusSchema walks the built tree at root and returns its shared-schema manifest. sizeLabel is the
// generator's own size name (the package has none: the Go command passes `complex-default`/`complex-small`).
func BuildCorpusSchema(root string, spec Spec, manifest *Manifest, sizeLabel string) (*CorpusSchema, error) {
	if manifest == nil {
		return nil, fmt.Errorf("BuildCorpusSchema needs the builder's manifest")
	}
	if sizeLabel == "" {
		sizeLabel = "complex-default"
	}
	files, err := walkCorpusFiles(root)
	if err != nil {
		return nil, err
	}
	schema := &CorpusSchema{
		Schema:           CorpusSchemaName,
		SchemaVersion:    CorpusSchemaVersion,
		Generator:        CorpusGeneratorGo,
		GeneratorVersion: CorpusGeneratorVersion,
		Size:             sizeLabel,
		Seed:             fmt.Sprintf("%d", spec.Seed),
		Counts:           map[string]int{},
		Features:         map[string]bool{},
		Markers:          map[string][]string{},
		Files:            files,
	}
	classCounts := map[string]int{}
	totalBytes := int64(0)
	for _, file := range files {
		classCounts[file.Class]++
		totalBytes += file.Bytes
	}
	schema.Counts["files"] = len(files)
	schema.Counts["bytes"] = int(totalBytes)
	for class, count := range classCounts {
		schema.Counts["class."+class] = count
	}
	// The scenario counts are the BUILDER's declaration; the verifier derives files/bytes/classes from the
	// tree and compares those. A declaration that disagrees with the manifest's own file map is caught by
	// TestBuildDeclaresWhatItPlanted, which already owns that honesty check.
	schema.Counts["characters"] = len(manifest.Characters)
	schema.Counts["chats"] = len(manifest.Chats)
	schema.Counts["messages"] = sumChatMessages(manifest.Chats)
	schema.Counts["branches"] = countBranches(manifest.Chats)
	schema.Counts["swipes"] = sumChatSwipes(manifest.Chats)
	schema.Counts["groups"] = len(manifest.Groups)
	schema.Counts["worlds"] = len(manifest.Worlds)
	schema.Counts["worldEntries"] = sumWorldEntries(manifest.Worlds)
	schema.Counts["worldRegexKeys"] = sumWorldRegexKeys(manifest.Worlds)
	schema.Counts["groupMessages"] = sumGroupMessages(manifest.Groups)
	schema.Counts["presets"] = len(manifest.Presets)
	schema.Counts["textPresets"] = len(manifest.TextPresets)
	schema.Counts["themes"] = len(manifest.Themes)
	schema.Counts["quickReplies"] = len(manifest.QuickReplies)
	schema.Counts["personas"] = len(manifest.Personas)
	schema.Counts["backgrounds"] = len(manifest.Backgrounds)
	// Inventory-backed counts are DERIVED from the classification, not copied from the builder's list, so
	// the comparison tool can compare them with a JS schema that derives the same keys the same way.
	schema.Counts["unknownFiles"] = classCounts["unknown"] + classCounts["binary"]
	schema.Counts["legacyAssets"] = classCounts["legacy"]
	schema.Counts["backups"] = classCounts["chatBackups"]
	schema.Counts["binaryFiles"] = classCounts["binary"]
	schema.Counts["contentLog"] = classCounts["contentLog"]
	schema.Counts["deletedTurns"] = 0 // the Go generator writes deleted turns as ABSENT, not as a counter.

	schema.Features["branchChats"] = schema.Counts["branches"] > 0
	schema.Features["swipeHistory"] = schema.Counts["swipes"] > 0
	schema.Features["systemMessages"] = true // chatJSONL writes is_system every 97th message.
	schema.Features["embeddedCharacterBook"] = sumEmbeddedBook(manifest.Characters) > 0
	schema.Features["characterSprites"] = anyCharacterSprites(manifest.Characters)
	schema.Features["worldRegexKeys"] = schema.Counts["worldRegexKeys"] > 0
	schema.Features["worldRecursion"] = true // buildWorlds writes recursion flags on every entry.
	schema.Features["groups"] = schema.Counts["groups"] > 0
	schema.Features["complexPreset"] = schema.Counts["presets"] > 0
	schema.Features["textPresets"] = schema.Counts["textPresets"] > 0
	schema.Features["themes"] = schema.Counts["themes"] > 0
	schema.Features["quickReplies"] = schema.Counts["quickReplies"] > 0
	schema.Features["personas"] = schema.Counts["personas"] > 0
	schema.Features["backgrounds"] = schema.Counts["backgrounds"] > 0
	schema.Features["unknownJsonFiles"] = hasUnknownJSON(files)
	schema.Features["binaryUnknownFiles"] = classCounts["binary"] > 0
	schema.Features["unicodeNames"] = hasUnicodeText(manifest)
	schema.Features["legacyMigrationInput"] = schema.Counts["legacyAssets"] > 0
	schema.Features["extensionState"] = classCounts["extensionState"] > 0
	schema.Features["backups"] = schema.Counts["backups"] > 0
	schema.Features["movingUI"] = classCounts["movingUI"] > 0
	schema.Features["contentLog"] = classCounts["contentLog"] > 0
	schema.Features["secrets"] = classCounts["secrets"] > 0

	schema.Markers["unicodeNames"] = unicodeCharacterNames(manifest)
	schema.Markers["worldNames"] = worldNames(manifest)
	schema.Markers["presetNames"] = append([]string{}, manifest.Presets...)
	schema.Markers["chatMarkerPrefixes"] = []string{"CHAT_", "SWIPE_", "SYNTHETIC_NOTE"}
	schema.Markers["cardMarkerKeys"] = []string{"chara", "ccv3"}
	schema.Markers["settingsUnknownKeys"] = []string{"longlived_unknown_state"}
	schema.Markers["configUnknownKeys"] = []string{"longlived_legacy"}
	for _, values := range schema.Markers {
		sort.Strings(values)
	}

	digest := sha256.New()
	for _, file := range files {
		fmt.Fprintf(digest, "%s  %s\n", file.SHA256, file.Path)
	}
	schema.Tree = SchemaTree{SHA256: hex.EncodeToString(digest.Sum(nil)), Files: len(files), Bytes: totalBytes}
	return schema, nil
}

// walkCorpusFiles reads every regular file under root, excluding the governance manifests at the root, and
// returns the sorted inventory. Paths are slash-separated and root-relative.
func walkCorpusFiles(root string) ([]SchemaFile, error) {
	files := make([]SchemaFile, 0, 256)
	err := filepath.WalkDir(root, func(target string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, target)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if relative == "." {
			return nil
		}
		if !strings.Contains(relative, "/") && CorpusSchemaMetadataNames[relative] {
			return nil
		}
		body, err := os.ReadFile(target)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(body)
		files = append(files, SchemaFile{
			Path:   relative,
			Bytes:  int64(len(body)),
			SHA256: hex.EncodeToString(sum[:]),
			Class:  classifyCorpusPath(relative, body),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	sort.Slice(files, func(left, right int) bool { return files[left].Path < files[right].Path })
	return files, nil
}

// Scheme class names are shared with tools/longlived/corpus-schema.mjs. Changing one side without the other
// is a class disagreement the comparison tool reports, not a silent reinterpretation.
const (
	classConfig           = "config"
	classContentLog       = "contentLog"
	classSettings         = "settings"
	classSecrets          = "secrets"
	classStats            = "stats"
	classCharacters       = "characters"
	classCharacterSprites = "characterSprites"
	classChats            = "chats"
	classChatBackups      = "chatBackups"
	classGroupChats       = "groupChats"
	classGroups           = "groups"
	classWorlds           = "worlds"
	classPresets          = "presets"
	classTextPresets      = "textPresets"
	classThemes           = "themes"
	classQuickReplies     = "quickReplies"
	classMovingUI         = "movingUI"
	classBackgrounds      = "backgrounds"
	classAvatars          = "avatars"
	classAssets           = "assets"
	classUserFiles        = "userFiles"
	classUserImages       = "userImages"
	classExtensionState   = "extensionState"
	classRegex            = "regex"
	classThumbnails       = "thumbnails"
	classLegacy           = "legacy"
	classSystem           = "system"
	classUnknown          = "unknown"
	classBinary           = "binary"
)

// classifyCorpusPath is the ONE classification table, mirrored in tools/longlived/corpus-schema.mjs. It is
// path-shaped first (a card PNG is a character card, not "binary"), then extension-agnostic; only a file the
// table has no opinion about becomes `unknown`, and then `binary` if its bytes are not valid UTF-8 or carry a
// NUL. The comparison tool checks that both sides agree per path.
func classifyCorpusPath(relative string, body []byte) string {
	if relative == "config.yaml" {
		return classConfig
	}
	if relative == "manifest.json" || relative == "corpus-schema.json" {
		return classSystem
	}
	if relative == "content.log" {
		return classContentLog
	}
	if strings.HasPrefix(relative, "public/characters/") {
		return classLegacy
	}
	userPrefix := "default-user/"
	if !strings.HasPrefix(relative, userPrefix) {
		return unknownOrBinary(relative, body, classUnknown)
	}
	rest := strings.TrimPrefix(relative, userPrefix)
	switch {
	case rest == "settings.json":
		return classSettings
	case rest == "secrets.json":
		return classSecrets
	case rest == "content.log":
		return classContentLog
	case strings.HasPrefix(rest, "stats/"):
		return classStats
	case strings.HasPrefix(rest, "characters/"):
		if strings.Count(rest, "/") >= 2 {
			return classCharacterSprites
		}
		return classCharacters
	case strings.HasPrefix(rest, "chats/"):
		return classChats
	case strings.HasPrefix(rest, "group chats/"):
		return classGroupChats
	case strings.HasPrefix(rest, "groups/"):
		return classGroups
	case strings.HasPrefix(rest, "worlds/"):
		return classWorlds
	case strings.HasPrefix(rest, "OpenAI Settings/"):
		return classPresets
	case strings.HasPrefix(rest, "TextGen Settings/"):
		return classTextPresets
	case strings.HasPrefix(rest, "themes/"):
		return classThemes
	case strings.HasPrefix(rest, "QuickReplies/"):
		return classQuickReplies
	case strings.HasPrefix(rest, "movingUI/"):
		return classMovingUI
	case strings.HasPrefix(rest, "backgrounds/"):
		return classBackgrounds
	case strings.HasPrefix(rest, "User Avatars/"):
		return classAvatars
	case strings.HasPrefix(rest, "assets/"):
		return classAssets
	case strings.HasPrefix(rest, "user/files/"):
		return classUserFiles
	case strings.HasPrefix(rest, "user/images/"):
		return classUserImages
	case strings.HasPrefix(rest, "extensions/"):
		return classExtensionState
	case strings.HasPrefix(rest, "regex/"):
		return classRegex
	case strings.HasPrefix(rest, "thumbnails/"):
		return classThumbnails
	case strings.HasPrefix(rest, "backups/chat_"):
		return classChatBackups
	case strings.HasPrefix(rest, "backups/"):
		return classSystem
	default:
		return unknownOrBinary(rest, body, classUnknown)
	}
}

func unknownOrBinary(relative string, body []byte, fallback string) string {
	if !utf8.Valid(body) || bytes.IndexByte(body, 0) >= 0 {
		return classBinary
	}
	if path.Ext(relative) == ".bin" {
		return classBinary
	}
	return fallback
}

// ---- declared-count helpers -------------------------------------------------------------------------

func sumChatMessages(chats []Chat) int {
	total := 0
	for _, chat := range chats {
		total += chat.Messages
	}
	return total
}

func countBranches(chats []Chat) int {
	total := 0
	for _, chat := range chats {
		if chat.BranchOf != "" {
			total++
		}
	}
	return total
}

func sumChatSwipes(chats []Chat) int {
	total := 0
	for _, chat := range chats {
		total += chat.Swipes
	}
	return total
}

func sumGroupMessages(groups []Group) int {
	total := 0
	for _, group := range groups {
		total += group.Messages
	}
	return total
}

func sumWorldEntries(worlds []World) int {
	total := 0
	for _, world := range worlds {
		total += world.Entries
	}
	return total
}

func sumWorldRegexKeys(worlds []World) int {
	total := 0
	for _, world := range worlds {
		total += world.Regex
	}
	return total
}

func sumEmbeddedBook(characters []Character) int {
	total := 0
	for _, character := range characters {
		total += character.CardBook
	}
	return total
}

func anyCharacterSprites(characters []Character) bool {
	for _, character := range characters {
		if character.HasSprites {
			return true
		}
	}
	return false
}

func hasUnknownJSON(files []SchemaFile) bool {
	for _, file := range files {
		if file.Class == classUnknown && strings.HasSuffix(file.Path, ".json") {
			return true
		}
	}
	return false
}

func unicodeCharacterNames(manifest *Manifest) []string {
	names := make([]string, 0, len(manifest.Characters))
	for _, character := range manifest.Characters {
		if !isASCII(character.Name) {
			names = append(names, character.Name)
		}
	}
	sort.Strings(names)
	return names
}

func hasUnicodeText(manifest *Manifest) bool {
	return len(unicodeCharacterNames(manifest)) > 0
}

func isASCII(text string) bool {
	for _, code := range text {
		if code > 0x7f {
			return false
		}
	}
	return true
}

func worldNames(manifest *Manifest) []string {
	names := make([]string, 0, len(manifest.Worlds))
	for _, world := range manifest.Worlds {
		names = append(names, path.Base(world.File))
	}
	sort.Strings(names)
	return names
}

// MarshalCorpusSchema returns the deterministic JSON bytes of a schema, indented, with one trailing newline.
func MarshalCorpusSchema(schema *CorpusSchema) ([]byte, error) {
	if schema == nil {
		return nil, fmt.Errorf("nil corpus schema")
	}
	body, err := json.MarshalIndent(schema, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(body, '\n'), nil
}

// WriteCorpusSchema writes the schema to target (0600). Target is intentionally NOT inside the tree by
// default in the tests: the schema describes a tree, it is not part of it. A caller that puts it inside the
// tree is still safe, because the governance names are excluded from the inventory and digest.
func WriteCorpusSchema(target string, schema *CorpusSchema) error {
	body, err := MarshalCorpusSchema(schema)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		return err
	}
	return os.WriteFile(target, body, 0o600)
}

// LoadCorpusSchema reads and shape-checks a schema file. It refuses an unknown schema name or version: a
// consumer that silently accepted a different manifest would be verifying nothing.
//
// The OPTIONAL scenario block (alpha.16 M1) is handled here: a manifest that omits it is the pre-M1 v1 shape and
// loads exactly as before, while a PRESENT block is parsed and validated and a malformed one is refused with a
// *ScenarioValidationError whose Names() are the stable assertions (`scenario-version:2`, …). The raw JSON is
// read twice on purpose: the typed decode cannot distinguish a missing member from a zero value, and a
// scenario member the shared schema does not declare is exactly the drift this contract must not ignore.
func LoadCorpusSchema(target string) (*CorpusSchema, error) {
	body, err := os.ReadFile(target)
	if err != nil {
		return nil, err
	}
	return parseCorpusSchema(body, target)
}

// parseCorpusSchema decodes and validates schema bytes. It is shared by LoadCorpusSchema and by the builder,
// so `BuildCorpusSchemaWithScenario` can require that the bytes it emits load back through the read path.
func parseCorpusSchema(body []byte, source string) (*CorpusSchema, error) {
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		return nil, fmt.Errorf("corpus schema %s is not a JSON object: %w", source, err)
	}
	scenarioRaw, hasScenario := top["scenario"]
	delete(top, "scenario")
	stripped, err := json.Marshal(top)
	if err != nil {
		return nil, err
	}
	var schema CorpusSchema
	if err := json.Unmarshal(stripped, &schema); err != nil {
		return nil, fmt.Errorf("corpus schema %s does not decode: %w", source, err)
	}
	if schema.Schema != CorpusSchemaName || schema.SchemaVersion != CorpusSchemaVersion {
		return nil, fmt.Errorf("unexpected corpus schema %q v%d (want %q v%d)", schema.Schema, schema.SchemaVersion, CorpusSchemaName, CorpusSchemaVersion)
	}
	if hasScenario {
		trimmed := bytes.TrimSpace(scenarioRaw)
		if len(trimmed) > 0 && !bytes.Equal(trimmed, []byte("null")) {
			if trimmed[0] != '{' {
				return nil, &ScenarioValidationError{Source: source, Issues: []ScenarioIssue{{Name: "scenario-not-an-object"}}}
			}
			var scenario CorpusScenario
			if err := json.Unmarshal(scenarioRaw, &scenario); err != nil {
				return nil, &ScenarioValidationError{Source: source, Issues: []ScenarioIssue{{Name: "scenario-malformed", Detail: err.Error()}}}
			}
			schema.Scenario = &scenario
			issues := rawScenarioIssues(scenarioRaw)
			issues = append(issues, ValidateCorpusScenario(&schema)...)
			if len(issues) > 0 {
				return nil, &ScenarioValidationError{Source: source, Issues: issues}
			}
		}
	}
	if len(schema.Files) == 0 {
		return nil, fmt.Errorf("corpus schema %s carries no files", source)
	}
	for index, file := range schema.Files {
		if file.Path == "" || path.IsAbs(file.Path) || strings.Contains(file.Path, "\\") || strings.HasPrefix(file.Path, "../") {
			return nil, fmt.Errorf("corpus schema %s row %d has an unsafe path %q", source, index, file.Path)
		}
		if index > 0 && schema.Files[index-1].Path >= file.Path {
			return nil, fmt.Errorf("corpus schema %s is not sorted at %q", source, file.Path)
		}
	}
	return &schema, nil
}

// BuildCorpusSchemaWithScenario builds the shared schema for a tree and declares the alpha.16 M1 E02 prototype
// scenario descriptor. The emitted bytes are round-tripped back through the READ path before they are returned,
// so the builder cannot mint a manifest its own consumers refuse — a green build is not allowed to be a manifest
// a verifier would reject.
func BuildCorpusSchemaWithScenario(root string, spec Spec, manifest *Manifest, sizeLabel, replayCommand string) (*CorpusSchema, error) {
	schema, err := BuildCorpusSchema(root, spec, manifest, sizeLabel)
	if err != nil {
		return nil, err
	}
	scenario, err := BuildE02Scenario(spec, manifest, schema, replayCommand)
	if err != nil {
		return nil, err
	}
	schema.Scenario = scenario
	body, err := MarshalCorpusSchema(schema)
	if err != nil {
		return nil, err
	}
	parsed, err := parseCorpusSchema(body, "<generated by "+CorpusGeneratorGo+">")
	if err != nil {
		return nil, fmt.Errorf("the builder emitted a corpus schema its own reader refuses: %w", err)
	}
	return parsed, nil
}

// DiffCorpusSchemas returns the named differences between two schemas. It is the Go side of the drift gate
// (`TestCorpusSchemaRebuildDiffHasTeeth`): a non-deterministic rebuild, a mutated schema or a changed count
// must produce at least one difference whose Name is the failed assertion.
func DiffCorpusSchemas(previous, next *CorpusSchema) []SchemaDifference {
	differences := make([]SchemaDifference, 0)
	if previous == nil || next == nil {
		return []SchemaDifference{{Name: "schema-missing"}}
	}
	if previous.Schema != next.Schema || previous.SchemaVersion != next.SchemaVersion {
		differences = append(differences, SchemaDifference{Name: "schema-identity", Left: previous.Schema, Right: next.Schema})
	}
	if previous.Generator != next.Generator || previous.GeneratorVersion != next.GeneratorVersion {
		differences = append(differences, SchemaDifference{Name: "generator-identity", Left: previous.Generator, Right: next.Generator})
	}
	if previous.Size != next.Size || previous.Seed != next.Seed {
		differences = append(differences, SchemaDifference{Name: "size-or-seed", Left: previous.Size + "/" + previous.Seed, Right: next.Size + "/" + next.Seed})
	}
	leftFiles := make(map[string]SchemaFile, len(previous.Files))
	for _, file := range previous.Files {
		leftFiles[file.Path] = file
	}
	for _, file := range next.Files {
		existing, ok := leftFiles[file.Path]
		if !ok {
			differences = append(differences, SchemaDifference{Name: "file-extra:" + file.Path})
			continue
		}
		delete(leftFiles, file.Path)
		if existing.SHA256 != file.SHA256 {
			differences = append(differences, SchemaDifference{Name: "file-sha256:" + file.Path, Left: existing.SHA256, Right: file.SHA256})
		}
		if existing.Bytes != file.Bytes {
			differences = append(differences, SchemaDifference{Name: "file-bytes:" + file.Path})
		}
		if existing.Class != file.Class {
			differences = append(differences, SchemaDifference{Name: "file-class:" + file.Path, Left: existing.Class, Right: file.Class})
		}
	}
	for missing := range leftFiles {
		differences = append(differences, SchemaDifference{Name: "file-missing:" + missing})
	}
	if previous.Tree != next.Tree {
		differences = append(differences, SchemaDifference{Name: "tree-identity", Left: previous.Tree.SHA256, Right: next.Tree.SHA256})
	}
	// The optional scenario block is part of the manifest's identity when present. Its absence is a VALID v1
	// shape, so the diff names presence separately from a changed block: a consumer that dropped the block has
	// lost the scenario description, and a consumer whose block changed has a non-deterministic descriptor.
	if (previous.Scenario == nil) != (next.Scenario == nil) {
		differences = append(differences, SchemaDifference{Name: "scenario-presence", Left: fmt.Sprint(previous.Scenario != nil), Right: fmt.Sprint(next.Scenario != nil)})
	} else if previous.Scenario != nil {
		leftBytes, leftErr := marshalScenario(previous.Scenario)
		rightBytes, rightErr := marshalScenario(next.Scenario)
		if leftErr != nil || rightErr != nil || !bytes.Equal(leftBytes, rightBytes) {
			differences = append(differences, SchemaDifference{Name: "scenario-block", Left: digest(leftBytes), Right: digest(rightBytes)})
		}
	}
	for key, leftValue := range previous.Counts {
		if rightValue, exists := next.Counts[key]; !exists || rightValue != leftValue {
			differences = append(differences, SchemaDifference{Name: "count:" + key, Left: fmt.Sprint(leftValue), Right: fmt.Sprint(rightValue)})
		}
	}
	for key, rightValue := range next.Counts {
		if _, exists := previous.Counts[key]; !exists {
			differences = append(differences, SchemaDifference{Name: "count-extra:" + key, Right: fmt.Sprint(rightValue)})
		}
	}
	for key, leftValue := range previous.Features {
		if rightValue, exists := next.Features[key]; !exists || rightValue != leftValue {
			differences = append(differences, SchemaDifference{Name: "feature:" + key, Left: fmt.Sprint(leftValue), Right: fmt.Sprint(rightValue)})
		}
	}
	sort.Slice(differences, func(left, right int) bool { return differences[left].Name < differences[right].Name })
	return differences
}
