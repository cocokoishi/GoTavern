package longlivedfixture

// THE OPTIONAL SCENARIO / INTERACTION BLOCK (alpha.16 M1, plan §3 and §9.B).
//
// M1 asks the scenario factory for "seeded deterministic manifests, canonical SHA-256 of its preboot tree,
// action log, byte census and a replay command", declared in a way that extends the EXISTING shared
// `gotavern-corpus-schema` without breaking a v1 consumer. This file is the Go half of that contract:
//
//   - WHAT THE BLOCK IS. An OPTIONAL `scenario` object appended after `files`. Its absence is a valid v1
//     manifest (the pre-M1 shape, byte-for-byte), so every existing consumer — a browser leg, a Node probe,
//     `tools/longlived/verify-corpus-schema.mjs`, a Go boot — keeps working on a manifest that omits it. Its
//     PRESENCE is validated, and a malformed block is refused with a NAMED error (`scenario-version:2`,
//     `scenario-unknown-field:foo`, `scenario-byte-census-bytes:1`, …) rather than a prose failure.
//   - WHAT THE RECIPE IS. `scenario.recipe` is DATA-LIGHT: counts, names and pinned commits, never the
//     megabytes of generated content. The tree is rebuilt from (seed, parameters) by the replay command; the
//     recipe records the parameters, the preboot tree digest records what those parameters produced, and the
//     byte census records the shape of that result. That is the plan's "store the recipe and manifest, not
//     megabytes of duplicated generated data".
//   - THE PROTOTYPE. `BuildE02Scenario` declares ONE scenario today: environment class E02 (long-lived
//     normal), because BOTH existing generators (this package for the Go complex instance,
//     `tools/build-longlived-corpus.mjs` for the browser/Node corpus) already build that environment from a
//     seed. E01/E03-E09 are declared in the environment-class enum and are NOT claimed as built.
//
// GO/JS AGREEMENT. The field inventory functions below are compared, sorted, with the JS inventories in
// `tools/longlived/corpus-schema.mjs` by `tests/e2e/longlived_schema_test.go`
// (`TestCorpusSchemaGoAndJSFieldInventoriesAgree`). A field added on one side and not the other fails that
// test by name, and each loader also refuses an unknown field inside the block, so the drift is visible to a
// consumer rather than only to a unit test.
//
// DETERMINISM. Nothing here reads a clock, a random source, the environment or the target directory: the
// block is a pure function of (spec, builder manifest, schema inventory, replay command), so two builds of
// the same input marshal byte-identically. `TestE02ScenarioDescriptorIsDeterministic` measures that.

import (
	"encoding/json"
	"fmt"
	"reflect"
	"regexp"
	"sort"
	"strings"
)

const (
	// CorpusScenarioVersion is the version of the OPTIONAL scenario block. The shared schema's own
	// `schemaVersion` stays 1: the block is additive and independently versioned, and a v1 manifest that
	// omits it must keep parsing and verifying.
	CorpusScenarioVersion = 1
)

// ScenarioEnvironmentClasses are the plan's environment matrix ids, in order. The block records exactly one.
var ScenarioEnvironmentClasses = []string{
	"E01", "E02", "E03", "E04", "E05", "E06", "E07", "E08", "E09",
}

// The E02 prototype's canonical observables. Sorted, so the block is byte-stable without a post-sort pass.
var scenarioE02Observables = []string{"browser-state", "disk-bytes", "provider-wire"}

// CorpusScenario is the optional scenario/interaction block. It is a DESCRIPTION of a deterministic recipe;
// it is not the generated content and not a claim that the scenario has been executed.
type CorpusScenario struct {
	// ScenarioVersion is the block's own version; a reader refuses anything but CorpusScenarioVersion.
	ScenarioVersion int `json:"scenarioVersion"`
	// EnvironmentClass is one of ScenarioEnvironmentClasses.
	EnvironmentClass string `json:"environmentClass"`
	// Seed is the seed the recipe is a pure function of. It is a string because the two generators seed
	// differently (the Go generator with an int64, the JS corpus with a text seed).
	Seed string `json:"seed"`
	// Recipe is the data-light declaration of what the environment contains and what it will drive.
	Recipe ScenarioRecipe `json:"recipe"`
	// PrebootTreeSHA256 is the canonical digest of the generated tree BEFORE any server boots on it. It must
	// equal `tree.sha256`; a consumer that boots a tree whose digest differs from this is not driving the
	// scenario the manifest describes.
	PrebootTreeSHA256 string `json:"prebootTreeSha256"`
	// ActionLog is the ordered, seeded action sequence the scenario declares. It is a plan, not an execution
	// record: M2/M3 turn it into an evidence artifact with per-action results.
	ActionLog []ScenarioAction `json:"actionLog"`
	// ByteCensus is the shape of the preboot tree, derived from the inventory (files, bytes, per-class).
	ByteCensus ScenarioByteCensus `json:"byteCensus"`
	// ReplayCommand is the exact command that rebuilds the same tree from the same seed and parameters. It
	// must contain the `<out>` and `<schema>` placeholders and the scenario seed, and its tool must match
	// `schema.generator`; a command that cannot reproduce the tree would make the scenario an assertion.
	ReplayCommand string `json:"replayCommand"`
}

// ScenarioRecipe is the plan's scenario declaration, minus the content: users, cards, chats, prompt-bearing
// documents, books, pinned extensions, actions, faults, target observables and resource bounds.
type ScenarioRecipe struct {
	Users          int                    `json:"users"`
	Cards          int                    `json:"cards"`
	Chats          int                    `json:"chats"`
	Prompts        int                    `json:"prompts"`
	Books          int                    `json:"books"`
	Extensions     []ScenarioExtension    `json:"extensions"`
	Actions        []string               `json:"actions"`
	Faults         []string               `json:"faults"`
	Observables    []string               `json:"observables"`
	ResourceBounds ScenarioResourceBounds `json:"resourceBounds"`
}

// ScenarioExtension is one pinned client extension: the name and the frozen commit it is installed at.
type ScenarioExtension struct {
	Name   string `json:"name"`
	Commit string `json:"commit"`
}

// ScenarioAction is one ordered action in the declared log. `Target` is derived from the tree (the longest
// chat's path, the selected preset's name, …), which is what makes the descriptor a function of the tree
// rather than a hand-typed list.
type ScenarioAction struct {
	Index      int    `json:"index"`
	ID         string `json:"id"`
	Kind       string `json:"kind"`
	Source     string `json:"source"`
	Observable string `json:"observable"`
	Target     string `json:"target"`
}

// ScenarioByteCensus is the preboot tree's census. Files and Bytes must equal the schema's derived counts;
// Classes must equal the schema's `class.*` counts. A consumer can additionally compare it to a walked tree.
type ScenarioByteCensus struct {
	Files   int            `json:"files"`
	Bytes   int64          `json:"bytes"`
	Classes map[string]int `json:"classes"`
}

// ScenarioResourceBounds are the run-time bounds a qualification job must stay within. They are declarations
// (a gate checks them against the observed run in M2/M3); the schema itself only checks they are sane and not
// below the preboot census.
type ScenarioResourceBounds struct {
	MaxFiles            int   `json:"maxFiles"`
	MaxBytes            int64 `json:"maxBytes"`
	MaxProviderRequests int   `json:"maxProviderRequests"`
	MaxWallClockMs      int   `json:"maxWallClockMs"`
}

// ScenarioIssue is one named refusal of a scenario block. Name is the stable assertion a gate reports; it is
// what a test asserts on, never a prose message.
type ScenarioIssue struct {
	Name   string
	Detail string
}

func (issue ScenarioIssue) String() string {
	if issue.Detail == "" {
		return issue.Name
	}
	return issue.Name + ": " + issue.Detail
}

// ScenarioValidationError is returned when a scenario block is present but malformed. It carries every named
// issue (sorted, so the message is deterministic) so a caller can assert on any one of them.
type ScenarioValidationError struct {
	Source string
	Issues []ScenarioIssue
}

func (e *ScenarioValidationError) Error() string {
	names := make([]string, 0, len(e.Issues))
	for _, issue := range e.Issues {
		names = append(names, issue.String())
	}
	return fmt.Sprintf("corpus schema %s refused the scenario block: %s", e.Source, strings.Join(names, ", "))
}

// Names returns the refused assertion names, deduplicated and sorted.
func (e *ScenarioValidationError) Names() []string {
	seen := map[string]bool{}
	names := make([]string, 0, len(e.Issues))
	for _, issue := range e.Issues {
		if seen[issue.Name] {
			continue
		}
		seen[issue.Name] = true
		names = append(names, issue.Name)
	}
	sort.Strings(names)
	return names
}

// ---- field inventories (the Go half of the cross-language drift gate) ------------------------------------

// jsonFieldNames returns the JSON member names of a struct (or pointer to struct), sorted. It is the
// DECLARED field inventory: the cross-language test compares it with the JS inventories, and LoadCorpusSchema
// refuses an unknown member inside the block, so a field that exists on one side only is caught twice.
func jsonFieldNames(value any) []string {
	typ := reflect.TypeOf(value)
	if typ == nil {
		return nil
	}
	if typ.Kind() == reflect.Ptr {
		typ = typ.Elem()
	}
	names := make([]string, 0, typ.NumField())
	for index := 0; index < typ.NumField(); index++ {
		tag := typ.Field(index).Tag.Get("json")
		name := strings.Split(tag, ",")[0]
		if name == "" || name == "-" {
			continue
		}
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// CorpusSchemaFieldNames is the top-level shared-schema inventory (including the optional `scenario`).
func CorpusSchemaFieldNames() []string { return jsonFieldNames(CorpusSchema{}) }

// CorpusScenarioFieldNames is the inventory of the optional block.
func CorpusScenarioFieldNames() []string { return jsonFieldNames(CorpusScenario{}) }

// CorpusScenarioRecipeFieldNames is the recipe inventory.
func CorpusScenarioRecipeFieldNames() []string { return jsonFieldNames(ScenarioRecipe{}) }

// CorpusScenarioExtensionFieldNames, CorpusScenarioActionFieldNames, CorpusScenarioByteCensusFieldNames and
// CorpusScenarioResourceBoundsFieldNames are the nested inventories.
func CorpusScenarioExtensionFieldNames() []string  { return jsonFieldNames(ScenarioExtension{}) }
func CorpusScenarioActionFieldNames() []string     { return jsonFieldNames(ScenarioAction{}) }
func CorpusScenarioByteCensusFieldNames() []string { return jsonFieldNames(ScenarioByteCensus{}) }
func CorpusScenarioResourceBoundsFieldNames() []string {
	return jsonFieldNames(ScenarioResourceBounds{})
}

// ScenarioIssueNames is the static prefix inventory of the named scenario refusals, shared with
// `SCENARIO_ISSUE_NAMES` in tools/longlived/corpus-schema.mjs. Dynamic names append a suffix
// (`scenario-version:2`, `scenario-unknown-field:foo`), so the comparison is by prefix.
var ScenarioIssueNames = []string{
	"scenario-malformed",
	"scenario-not-an-object",
	"scenario-unknown-field",
	"scenario-field-missing",
	"scenario-version",
	"scenario-environment-class",
	"scenario-seed-empty",
	"scenario-recipe-unknown-field",
	"scenario-recipe-field-missing",
	"scenario-recipe-users",
	"scenario-recipe-cards",
	"scenario-recipe-chats",
	"scenario-recipe-prompts",
	"scenario-recipe-books",
	"scenario-recipe-extensions",
	"scenario-recipe-extension",
	"scenario-recipe-actions",
	"scenario-recipe-faults",
	"scenario-recipe-observables",
	"scenario-recipe-resource-bounds",
	"scenario-preboot-tree-sha256-shape",
	"scenario-preboot-tree-mismatch",
	"scenario-action-log-empty",
	"scenario-action",
	"scenario-action-duplicate-id",
	"scenario-actions-match-log",
	"scenario-byte-census-unknown-field",
	"scenario-byte-census-field-missing",
	"scenario-byte-census-files",
	"scenario-byte-census-bytes",
	"scenario-byte-census-class",
	"scenario-resource-bounds-files",
	"scenario-resource-bounds-bytes",
	"scenario-replay-command-shape",
	"scenario-replay-command-placeholders",
	"scenario-replay-command-seed",
	"scenario-replay-command-tool",
}

// ScenarioIssueNamesSorted returns the shared issue-name inventory, sorted.
func ScenarioIssueNamesSorted() []string {
	names := append([]string{}, ScenarioIssueNames...)
	sort.Strings(names)
	return names
}

var (
	scenarioSHA256Shape = regexp.MustCompile(`^[0-9a-f]{64}$`)
	scenarioCommitShape = regexp.MustCompile(`^[0-9a-f]{40}$`)
)

// ValidateCorpusScenario checks the SEMANTIC rules of a present scenario block against its own schema. It
// returns nil for an absent block (the backward-compatible v1 read path). Presence, unknown-member and JSON
// type checks happen while reading raw bytes in `parseCorpusSchema`, because a typed struct cannot distinguish
// "missing" from "zero" and Go's decoder reports a type mismatch without a stable name.
//
// The internal-consistency rules live HERE (census vs counts, preboot vs `tree.sha256`, actions vs log, bounds
// vs census) so that a manifest is coherent before a verifier compares it to a walked tree. The
// TREE-vs-block checks are the JS verifier's named checks (`scenario-preboot-tree-matches-tree`,
// `scenario-byte-census-*`) and are reachable exactly when a tree drifts away from an otherwise valid schema.
func ValidateCorpusScenario(schema *CorpusSchema) []ScenarioIssue {
	if schema == nil || schema.Scenario == nil {
		return nil
	}
	scenario := schema.Scenario
	issues := make([]ScenarioIssue, 0)

	addf := func(name string, args ...any) {
		issues = append(issues, ScenarioIssue{Name: fmt.Sprintf(name, args...)})
	}

	if scenario.ScenarioVersion != CorpusScenarioVersion {
		addf("scenario-version:%d", scenario.ScenarioVersion)
	}
	if !containsValue(ScenarioEnvironmentClasses, scenario.EnvironmentClass) {
		addf("scenario-environment-class:%s", scenario.EnvironmentClass)
	}
	if strings.TrimSpace(scenario.Seed) == "" {
		addf("scenario-seed-empty")
	}
	issues = append(issues, validateScenarioRecipe(scenario.Recipe)...)

	if !scenarioSHA256Shape.MatchString(scenario.PrebootTreeSHA256) {
		addf("scenario-preboot-tree-sha256-shape")
	} else if scenario.PrebootTreeSHA256 != schema.Tree.SHA256 {
		addf("scenario-preboot-tree-mismatch")
	}

	issues = append(issues, validateScenarioActionLog(scenario)...)
	issues = append(issues, validateScenarioByteCensus(schema, scenario)...)
	issues = append(issues, validateScenarioReplayCommand(schema, scenario)...)

	if scenario.Recipe.ResourceBounds.MaxFiles > 0 && scenario.Recipe.ResourceBounds.MaxFiles < scenario.ByteCensus.Files {
		addf("scenario-resource-bounds-files")
	}
	if scenario.Recipe.ResourceBounds.MaxBytes > 0 && scenario.Recipe.ResourceBounds.MaxBytes < scenario.ByteCensus.Bytes {
		addf("scenario-resource-bounds-bytes")
	}
	return issues
}

func validateScenarioRecipe(recipe ScenarioRecipe) []ScenarioIssue {
	issues := make([]ScenarioIssue, 0)
	addf := func(name string, args ...any) {
		issues = append(issues, ScenarioIssue{Name: fmt.Sprintf(name, args...)})
	}
	if recipe.Users < 1 {
		addf("scenario-recipe-users:%d", recipe.Users)
	}
	if recipe.Cards < 1 {
		addf("scenario-recipe-cards:%d", recipe.Cards)
	}
	if recipe.Chats < 1 {
		addf("scenario-recipe-chats:%d", recipe.Chats)
	}
	if recipe.Prompts < 0 {
		addf("scenario-recipe-prompts:%d", recipe.Prompts)
	}
	if recipe.Books < 0 {
		addf("scenario-recipe-books:%d", recipe.Books)
	}
	for index, extension := range recipe.Extensions {
		if strings.TrimSpace(extension.Name) == "" {
			addf("scenario-recipe-extension-%d-name-empty", index)
		}
		if !scenarioCommitShape.MatchString(extension.Commit) {
			addf("scenario-recipe-extension-%d-commit:%s", index, extension.Commit)
		}
	}
	if len(recipe.Actions) == 0 {
		addf("scenario-recipe-actions-empty")
	}
	for index, action := range recipe.Actions {
		if strings.TrimSpace(action) == "" {
			addf("scenario-recipe-actions-item-%d", index)
		}
	}
	for index, fault := range recipe.Faults {
		if strings.TrimSpace(fault) == "" {
			addf("scenario-recipe-faults-item-%d", index)
		}
	}
	if len(recipe.Observables) == 0 {
		addf("scenario-recipe-observables-empty")
	}
	for index, observable := range recipe.Observables {
		if strings.TrimSpace(observable) == "" {
			addf("scenario-recipe-observables-item-%d", index)
		}
	}
	sorted := append([]string{}, recipe.Observables...)
	sort.Strings(sorted)
	if strings.Join(sorted, "\x00") != strings.Join(recipe.Observables, "\x00") {
		addf("scenario-recipe-observables-order")
	}
	if recipe.ResourceBounds.MaxFiles < 1 {
		addf("scenario-recipe-resource-bounds-maxFiles:%d", recipe.ResourceBounds.MaxFiles)
	}
	if recipe.ResourceBounds.MaxBytes < 1 {
		addf("scenario-recipe-resource-bounds-maxBytes:%d", recipe.ResourceBounds.MaxBytes)
	}
	if recipe.ResourceBounds.MaxProviderRequests < 0 {
		addf("scenario-recipe-resource-bounds-maxProviderRequests:%d", recipe.ResourceBounds.MaxProviderRequests)
	}
	if recipe.ResourceBounds.MaxWallClockMs < 1 {
		addf("scenario-recipe-resource-bounds-maxWallClockMs:%d", recipe.ResourceBounds.MaxWallClockMs)
	}
	return issues
}

func validateScenarioActionLog(scenario *CorpusScenario) []ScenarioIssue {
	issues := make([]ScenarioIssue, 0)
	addf := func(name string, args ...any) {
		issues = append(issues, ScenarioIssue{Name: fmt.Sprintf(name, args...)})
	}
	if len(scenario.ActionLog) == 0 {
		addf("scenario-action-log-empty")
	}
	seen := map[string]bool{}
	ids := make([]string, 0, len(scenario.ActionLog))
	for index, action := range scenario.ActionLog {
		if action.Index != index {
			addf("scenario-action-%d-index:%d", index, action.Index)
		}
		if strings.TrimSpace(action.ID) == "" {
			addf("scenario-action-%d-id-empty", index)
		}
		if strings.TrimSpace(action.Kind) == "" {
			addf("scenario-action-%d-kind-empty", index)
		}
		if strings.TrimSpace(action.Source) == "" {
			addf("scenario-action-%d-source-empty", index)
		}
		if strings.TrimSpace(action.Observable) == "" {
			addf("scenario-action-%d-observable-empty", index)
		}
		if strings.TrimSpace(action.Target) == "" {
			addf("scenario-action-%d-target-empty", index)
		}
		if seen[action.ID] {
			addf("scenario-action-duplicate-id:%s", action.ID)
		}
		seen[action.ID] = true
		ids = append(ids, action.ID)
	}
	if strings.Join(ids, "\x00") != strings.Join(scenario.Recipe.Actions, "\x00") {
		addf("scenario-actions-match-log")
	}
	return issues
}

func validateScenarioByteCensus(schema *CorpusSchema, scenario *CorpusScenario) []ScenarioIssue {
	issues := make([]ScenarioIssue, 0)
	addf := func(name string, args ...any) {
		issues = append(issues, ScenarioIssue{Name: fmt.Sprintf(name, args...)})
	}
	census := scenario.ByteCensus
	if census.Files != schema.Counts["files"] || census.Files != len(schema.Files) {
		addf("scenario-byte-census-files:%d", census.Files)
	}
	if census.Bytes != int64(schema.Counts["bytes"]) || census.Bytes != schema.Tree.Bytes {
		addf("scenario-byte-census-bytes:%d", census.Bytes)
	}
	// Compare the per-class census with the schema's derived class counts, both directions.
	expected := map[string]int{}
	for name, count := range schema.Counts {
		if strings.HasPrefix(name, "class.") {
			expected[strings.TrimPrefix(name, "class.")] = count
		}
	}
	for name, count := range census.Classes {
		if expected[name] != count {
			addf("scenario-byte-census-class:%s", name)
		}
	}
	for name := range expected {
		if _, ok := census.Classes[name]; !ok {
			addf("scenario-byte-census-class:%s", name)
		}
	}
	return issues
}

func validateScenarioReplayCommand(schema *CorpusSchema, scenario *CorpusScenario) []ScenarioIssue {
	issues := make([]ScenarioIssue, 0)
	addf := func(name string, args ...any) {
		issues = append(issues, ScenarioIssue{Name: fmt.Sprintf(name, args...)})
	}
	command := scenario.ReplayCommand
	if command == "" || strings.TrimSpace(command) != command {
		addf("scenario-replay-command-shape")
		return issues
	}
	for _, character := range command {
		if character < 0x20 || character == 0x7f {
			addf("scenario-replay-command-shape")
			break
		}
	}
	if !strings.Contains(command, "<out>") || !strings.Contains(command, "<schema>") {
		addf("scenario-replay-command-placeholders")
	}
	if scenario.Seed != "" && !strings.Contains(command, scenario.Seed) {
		addf("scenario-replay-command-seed")
	}
	if want, known := replayCommandToolForGenerator(schema.Generator); !known {
		addf("scenario-replay-command-tool:%s", schema.Generator)
	} else if !strings.HasPrefix(command, want) {
		addf("scenario-replay-command-tool:%s", schema.Generator)
	}
	return issues
}

// replayCommandToolForGenerator maps the schema's generator identity to the command prefix that replays it.
func replayCommandToolForGenerator(generator string) (string, bool) {
	switch generator {
	case CorpusGeneratorGo:
		return "go run ./cmd/build-longlived ", true
	case CorpusGeneratorJS:
		return "node tools/build-longlived-corpus.mjs ", true
	default:
		return "", false
	}
}

// ---- E02 prototype descriptor ----------------------------------------------------------------------------

// GoScenarioReplayCommand is the command that rebuilds a Go complex instance from the same seed and size. It
// is a pure function of (spec, sizeLabel) and is recorded in the scenario block; `<out>` and `<schema>` are
// placeholders for the caller (the tree and the governance manifest are written outside the tree). Flags come
// BEFORE the positional target because Go's flag package stops parsing at the first non-flag argument.
func GoScenarioReplayCommand(spec Spec, sizeLabel string) string {
	flags := fmt.Sprintf("-seed %d", spec.Seed)
	if strings.HasSuffix(sizeLabel, "-small") {
		flags += " -small"
	}
	return fmt.Sprintf("go run ./cmd/build-longlived %s -schema <schema> <out>", flags)
}

// BuildE02Scenario derives the E02 prototype descriptor from what the builder actually planted. Every value
// is derived: counts come from the builder's manifest, the byte census from the schema inventory, and the
// action targets from the tree (the longest chat, a seed-selected preset and world). That is what makes the
// descriptor a function of (seed, parameters) rather than a hand-typed scenario.
func BuildE02Scenario(spec Spec, manifest *Manifest, schema *CorpusSchema, replayCommand string) (*CorpusScenario, error) {
	if manifest == nil {
		return nil, fmt.Errorf("BuildE02Scenario needs the builder's manifest")
	}
	if schema == nil || len(schema.Files) == 0 {
		return nil, fmt.Errorf("BuildE02Scenario needs the built tree's schema")
	}
	if len(manifest.Characters) == 0 || len(manifest.Chats) == 0 || len(manifest.Presets) == 0 {
		return nil, fmt.Errorf("the built tree does not carry an E02 environment (cards=%d chats=%d presets=%d)",
			len(manifest.Characters), len(manifest.Chats), len(manifest.Presets))
	}
	longest := longestChat(manifest.Chats)
	preset := manifest.Presets[seedIndex(spec.Seed, len(manifest.Presets))]
	world := ""
	if len(manifest.Worlds) > 0 {
		world = "default-user/" + manifest.Worlds[seedIndex(spec.Seed, len(manifest.Worlds))].File
	}
	actions := []ScenarioAction{
		{Index: 0, ID: "resume-longest-chat", Kind: "resume", Source: "browser:character-list", Observable: "chat-identity", Target: longest.Path},
		{Index: 1, ID: "swipe-last-reply", Kind: "swipe", Source: "browser:chat", Observable: "provider-wire", Target: longest.Path},
		{Index: 2, ID: "switch-preset", Kind: "preset-switch", Source: "browser:settings", Observable: "settings-persist", Target: preset},
		{Index: 3, ID: "switch-world", Kind: "world-switch", Source: "browser:world-info", Observable: "settings-persist", Target: world},
		{Index: 4, ID: "reload-page", Kind: "reload", Source: "browser:page", Observable: "browser-state", Target: longest.Path},
		{Index: 5, ID: "restart-process", Kind: "restart", Source: "process:restart", Observable: "persisted-bytes", Target: longest.Path},
	}
	actionIDs := make([]string, 0, len(actions))
	providerRequestBound := 0
	for _, action := range actions {
		actionIDs = append(actionIDs, action.ID)
		if action.Observable == "provider-wire" {
			providerRequestBound++
		}
	}
	classes := map[string]int{}
	var totalBytes int64
	for _, file := range schema.Files {
		classes[file.Class]++
		totalBytes += file.Bytes
	}
	census := ScenarioByteCensus{Files: len(schema.Files), Bytes: totalBytes, Classes: classes}
	recipe := ScenarioRecipe{
		Users: 1, // both generators stage exactly one synthetic user tree (`default-user/`)
		Cards: len(manifest.Characters),
		// `prompts` counts prompt-bearing documents (chat- and text-completion presets), not blocks: a
		// 120-block stress profile belongs to the E03 recipe, which this prototype does not claim.
		Prompts:     len(manifest.Presets) + len(manifest.TextPresets),
		Chats:       len(manifest.Chats),
		Books:       len(manifest.Worlds),
		Extensions:  []ScenarioExtension{},
		Actions:     actionIDs,
		Faults:      []string{},
		Observables: append([]string{}, scenarioE02Observables...),
		ResourceBounds: ScenarioResourceBounds{
			MaxFiles:            maxInt(2*len(schema.Files), len(schema.Files)),
			MaxBytes:            maxInt64(4*totalBytes, totalBytes),
			MaxProviderRequests: providerRequestBound,
			MaxWallClockMs:      600000,
		},
	}
	return &CorpusScenario{
		ScenarioVersion:   CorpusScenarioVersion,
		EnvironmentClass:  "E02",
		Seed:              fmt.Sprintf("%d", spec.Seed),
		Recipe:            recipe,
		PrebootTreeSHA256: schema.Tree.SHA256,
		ActionLog:         actions,
		ByteCensus:        census,
		ReplayCommand:     replayCommand,
	}, nil
}

// longestChat picks the message-heaviest chat; ties break lexicographically on the path so the result is a
// pure function of the manifest rather than of slice order.
func longestChat(chats []Chat) Chat {
	best := chats[0]
	for _, chat := range chats[1:] {
		if chat.Messages > best.Messages || (chat.Messages == best.Messages && chat.Path < best.Path) {
			best = chat
		}
	}
	return best
}

// seedIndex maps a seed to an index in [0, size) without reading anything but the seed.
func seedIndex(seed int64, size int) int {
	if size <= 0 {
		return 0
	}
	index := seed % int64(size)
	if index < 0 {
		index += int64(size)
	}
	return int(index)
}

func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func maxInt64(left, right int64) int64 {
	if left > right {
		return left
	}
	return right
}

// marshalScenario renders a scenario block the way it appears inside the manifest; the determinism
// test compares these bytes so a change in field order or map iteration is visible.
func marshalScenario(scenario *CorpusScenario) ([]byte, error) {
	if scenario == nil {
		return nil, fmt.Errorf("nil scenario")
	}
	return json.MarshalIndent(scenario, "", "  ")
}

// ---- raw-member checks (what a typed decode cannot see) --------------------------------------------------

// rawScenarioIssues checks the member NAMES of a scenario block and its nested objects: unknown members and
// missing members. A typed struct cannot distinguish "missing" from "zero", and ignoring an unknown member is
// exactly how the two schema definitions would drift silently, so the read path checks both by name.
func rawScenarioIssues(raw json.RawMessage) []ScenarioIssue {
	issues := make([]ScenarioIssue, 0)
	var top map[string]json.RawMessage
	if err := json.Unmarshal(raw, &top); err != nil {
		return []ScenarioIssue{{Name: "scenario-not-an-object", Detail: err.Error()}}
	}
	issues = append(issues, objectMemberIssues(top, CorpusScenarioFieldNames(), "scenario-unknown-field", "scenario-field-missing")...)
	if recipeRaw, ok := top["recipe"]; ok {
		var recipe map[string]json.RawMessage
		if err := json.Unmarshal(recipeRaw, &recipe); err == nil {
			issues = append(issues, objectMemberIssues(recipe, CorpusScenarioRecipeFieldNames(),
				"scenario-recipe-unknown-field", "scenario-recipe-field-missing")...)
			if extensionsRaw, ok := recipe["extensions"]; ok {
				var extensions []map[string]json.RawMessage
				if err := json.Unmarshal(extensionsRaw, &extensions); err == nil {
					for index, extension := range extensions {
						issues = append(issues, objectMemberIssues(extension, CorpusScenarioExtensionFieldNames(),
							fmt.Sprintf("scenario-recipe-extension-%d-unknown-field", index),
							fmt.Sprintf("scenario-recipe-extension-%d-field-missing", index))...)
					}
				}
			}
			if boundsRaw, ok := recipe["resourceBounds"]; ok {
				var bounds map[string]json.RawMessage
				if err := json.Unmarshal(boundsRaw, &bounds); err == nil {
					issues = append(issues, objectMemberIssues(bounds, CorpusScenarioResourceBoundsFieldNames(),
						"scenario-recipe-resource-bounds-unknown-field", "scenario-recipe-resource-bounds-field-missing")...)
				}
			}
		}
	}
	if logRaw, ok := top["actionLog"]; ok {
		var actions []map[string]json.RawMessage
		if err := json.Unmarshal(logRaw, &actions); err == nil {
			for index, action := range actions {
				issues = append(issues, objectMemberIssues(action, CorpusScenarioActionFieldNames(),
					fmt.Sprintf("scenario-action-%d-unknown-field", index),
					fmt.Sprintf("scenario-action-%d-field-missing", index))...)
			}
		}
	}
	if censusRaw, ok := top["byteCensus"]; ok {
		var census map[string]json.RawMessage
		if err := json.Unmarshal(censusRaw, &census); err == nil {
			issues = append(issues, objectMemberIssues(census, CorpusScenarioByteCensusFieldNames(),
				"scenario-byte-census-unknown-field", "scenario-byte-census-field-missing")...)
		}
	}
	return issues
}

// objectMemberIssues names every unknown member and every missing required member of one JSON object. Names
// are sorted so the refusal message is deterministic.
func objectMemberIssues(object map[string]json.RawMessage, fields []string, unknownName, missingName string) []ScenarioIssue {
	issues := make([]ScenarioIssue, 0)
	allowed := make(map[string]bool, len(fields))
	for _, field := range fields {
		allowed[field] = true
	}
	unknown := make([]string, 0, len(object))
	for name := range object {
		if !allowed[name] {
			unknown = append(unknown, name)
		}
	}
	sort.Strings(unknown)
	for _, name := range unknown {
		issues = append(issues, ScenarioIssue{Name: unknownName + ":" + name})
	}
	for _, name := range fields {
		if _, ok := object[name]; !ok {
			issues = append(issues, ScenarioIssue{Name: missingName + ":" + name})
		}
	}
	return issues
}

func containsValue(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}
