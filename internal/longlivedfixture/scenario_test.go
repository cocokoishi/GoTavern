package longlivedfixture

// Tests for the OPTIONAL scenario/interaction block (alpha.16 M1). The bridge test that drives the JS side —
// the verifier's tree-vs-block checks, the drift mutations and the Go/JS field-inventory agreement — lives in
// tests/e2e/longlived_schema_test.go. This file owns the Go half: determinism of the descriptor, the
// backward-compatible read path (a v1 manifest with NO block still loads), the builder's round-trip, and one
// failing case per named refusal, because a name a test never produces is a name a gate cannot assert.

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func buildWithScenario(t *testing.T, spec Spec) (string, *CorpusSchema) {
	t.Helper()
	root := t.TempDir()
	manifest, err := Build(root, spec)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	schema, err := BuildCorpusSchemaWithScenario(root, spec, manifest, "complex-small", GoScenarioReplayCommand(spec, "complex-small"))
	if err != nil {
		t.Fatalf("BuildCorpusSchemaWithScenario: %v", err)
	}
	return root, schema
}

func loadSchemaFromDisk(t *testing.T, schema *CorpusSchema) (*CorpusSchema, error) {
	t.Helper()
	target := filepath.Join(t.TempDir(), "corpus-schema.json")
	if err := WriteCorpusSchema(target, schema); err != nil {
		t.Fatalf("WriteCorpusSchema: %v", err)
	}
	return LoadCorpusSchema(target)
}

// TestE02ScenarioDescriptorIsDeterministic is the M1 determinism claim, measured rather than promised: two
// builds of the same (seed, parameters) produce byte-identical scenario blocks, the same preboot tree digest
// and the same replay command. The tree digest is compared directly as well because the block's central claim
// is "this digest is the tree those parameters produced".
func TestE02ScenarioDescriptorIsDeterministic(t *testing.T) {
	spec := schemaSpec()
	_, first := buildWithScenario(t, spec)
	_, second := buildWithScenario(t, spec)
	if first.Scenario == nil || second.Scenario == nil {
		t.Fatalf("the scenario block was not declared: %+v / %+v", first.Scenario, second.Scenario)
	}
	firstJSON, err := marshalScenario(first.Scenario)
	if err != nil {
		t.Fatal(err)
	}
	secondJSON, err := marshalScenario(second.Scenario)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(firstJSON, secondJSON) {
		t.Fatalf("two builds of the same scenario have different blocks:\nfirst=%s\nsecond=%s", firstJSON, secondJSON)
	}
	if first.Tree.SHA256 != second.Tree.SHA256 {
		t.Fatalf("the two builds produced different trees: %s vs %s", first.Tree.SHA256, second.Tree.SHA256)
	}
	if first.Scenario.PrebootTreeSHA256 != first.Tree.SHA256 {
		t.Fatalf("prebootTreeSha256 %s != tree.sha256 %s", first.Scenario.PrebootTreeSHA256, first.Tree.SHA256)
	}
	if first.Scenario.EnvironmentClass != "E02" {
		t.Fatalf("environmentClass = %q, want E02", first.Scenario.EnvironmentClass)
	}
	if first.Scenario.Seed != "20261104" {
		t.Fatalf("scenario seed = %q, want the spec seed", first.Scenario.Seed)
	}
	// The descriptor must be a function of the tree, not a typed-in list: the resume/swipe actions target the
	// message-heaviest chat this spec plants, and the census is the inventory that was walked.
	chats := manifestChatsForTest(t, spec)
	longest := chats[0]
	for _, chat := range chats[1:] {
		if chat.Messages > longest.Messages || (chat.Messages == longest.Messages && chat.Path < longest.Path) {
			longest = chat
		}
	}
	var resumed *ScenarioAction
	for index := range first.Scenario.ActionLog {
		if first.Scenario.ActionLog[index].ID == "resume-longest-chat" {
			resumed = &first.Scenario.ActionLog[index]
		}
	}
	if resumed == nil {
		t.Fatalf("the action log lacks resume-longest-chat: %+v", first.Scenario.ActionLog)
	}
	if resumed.Target != longest.Path {
		t.Fatalf("resume-longest-chat targets %q, longest chat is %q", resumed.Target, longest.Path)
	}
	if first.Scenario.ByteCensus.Files != len(first.Files) || first.Scenario.ByteCensus.Bytes != first.Tree.Bytes {
		t.Fatalf("byte census %d/%d does not match the inventory %d/%d",
			first.Scenario.ByteCensus.Files, first.Scenario.ByteCensus.Bytes, len(first.Files), first.Tree.Bytes)
	}
	// The bytes on disk are the identity too: a reload must yield the same scenario block.
	loaded, err := loadSchemaFromDisk(t, first)
	if err != nil {
		t.Fatalf("a schema this package writes must load back: %v", err)
	}
	loadedJSON, err := marshalScenario(loaded.Scenario)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(firstJSON, loadedJSON) {
		t.Fatalf("the scenario block changed across a write/load round trip")
	}
}

func manifestChatsForTest(t *testing.T, spec Spec) []Chat {
	t.Helper()
	root := t.TempDir()
	manifest, err := Build(root, spec)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return manifest.Chats
}

// TestScenarioBlockIsOptionalAndBackwardCompatible proves the v1 read path the plan requires: a manifest that
// OMITS the block still parses, still verifies structurally, and is byte-for-byte the pre-M1 shape (no
// `scenario` key), while the same tree with the block declared has the same identity. The block is additive;
// it is not allowed to change the tree or the manifest contract version.
func TestScenarioBlockIsOptionalAndBackwardCompatible(t *testing.T) {
	spec := schemaSpec()
	root := t.TempDir()
	manifest, err := Build(root, spec)
	if err != nil {
		t.Fatal(err)
	}
	plain, err := BuildCorpusSchema(root, spec, manifest, "complex-small")
	if err != nil {
		t.Fatal(err)
	}
	if plain.Scenario != nil {
		t.Fatalf("BuildCorpusSchema must not declare a scenario: %+v", plain.Scenario)
	}
	plainBytes, err := MarshalCorpusSchema(plain)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(plainBytes, []byte(`"scenario"`)) {
		t.Fatalf("a schema without a scenario block must not carry the key:\n%s", plainBytes)
	}
	plainLoaded, err := loadSchemaFromDisk(t, plain)
	if err != nil {
		t.Fatalf("a v1 manifest that omits the scenario block must still load: %v", err)
	}
	if plainLoaded.Scenario != nil {
		t.Fatalf("loading a block-less manifest invented a scenario: %+v", plainLoaded.Scenario)
	}
	scenarioSchema, err := BuildCorpusSchemaWithScenario(root, spec, manifest, "complex-small", GoScenarioReplayCommand(spec, "complex-small"))
	if err != nil {
		t.Fatal(err)
	}
	if scenarioSchema.SchemaVersion != CorpusSchemaVersion {
		t.Fatalf("declaring a scenario changed schemaVersion to %d; the block is additive", scenarioSchema.SchemaVersion)
	}
	if scenarioSchema.Tree.SHA256 != plain.Tree.SHA256 {
		t.Fatalf("declaring a scenario changed the tree identity: %s vs %s", scenarioSchema.Tree.SHA256, plain.Tree.SHA256)
	}
	if _, err := loadSchemaFromDisk(t, scenarioSchema); err != nil {
		t.Fatalf("a schema with a scenario block must load back: %v", err)
	}
}

// TestScenarioValidationNamesEachDefect is the named-refusal inventory: every semantic rule this package
// implements is exercised by one mutated copy and asserted by NAME, so a rule that silently stopped firing
// would leave its name unproduced and this table red. Structural rules (missing/unknown members, a non-object
// block, a JSON type mismatch) are asserted through LoadCorpusSchema because they need raw bytes.
func TestScenarioValidationNamesEachDefect(t *testing.T) {
	spec := schemaSpec()
	_, good := buildWithScenario(t, spec)
	if good.Scenario == nil {
		t.Fatal("no scenario block")
	}
	if issues := ValidateCorpusScenario(good); len(issues) != 0 {
		t.Fatalf("the builder's own scenario is invalid: %v", issues)
	}
	clone := func(t *testing.T) *CorpusSchema {
		t.Helper()
		body, err := MarshalCorpusSchema(good)
		if err != nil {
			t.Fatal(err)
		}
		var copy CorpusSchema
		if err := json.Unmarshal(body, &copy); err != nil {
			t.Fatal(err)
		}
		return &copy
	}
	cases := []struct {
		name   string
		mutate func(*CorpusSchema)
		want   string
	}{
		{"version", func(s *CorpusSchema) { s.Scenario.ScenarioVersion = 2 }, "scenario-version:2"},
		{"environment", func(s *CorpusSchema) { s.Scenario.EnvironmentClass = "E99" }, "scenario-environment-class:E99"},
		{"seed", func(s *CorpusSchema) { s.Scenario.Seed = "" }, "scenario-seed-empty"},
		{"users", func(s *CorpusSchema) { s.Scenario.Recipe.Users = 0 }, "scenario-recipe-users:0"},
		{"cards", func(s *CorpusSchema) { s.Scenario.Recipe.Cards = 0 }, "scenario-recipe-cards:0"},
		{"chats", func(s *CorpusSchema) { s.Scenario.Recipe.Chats = 0 }, "scenario-recipe-chats:0"},
		{"prompts", func(s *CorpusSchema) { s.Scenario.Recipe.Prompts = -1 }, "scenario-recipe-prompts:-1"},
		{"books", func(s *CorpusSchema) { s.Scenario.Recipe.Books = -1 }, "scenario-recipe-books:-1"},
		{"extension-name", func(s *CorpusSchema) {
			s.Scenario.Recipe.Extensions = []ScenarioExtension{{Name: "", Commit: strings.Repeat("a", 40)}}
		}, "scenario-recipe-extension-0-name-empty"},
		{"extension-commit", func(s *CorpusSchema) {
			s.Scenario.Recipe.Extensions = []ScenarioExtension{{Name: "ext", Commit: "not-a-commit"}}
		}, "scenario-recipe-extension-0-commit:not-a-commit"},
		{"actions-empty", func(s *CorpusSchema) { s.Scenario.Recipe.Actions = nil }, "scenario-recipe-actions-empty"},
		{"actions-item", func(s *CorpusSchema) {
			s.Scenario.Recipe.Actions = append([]string{}, s.Scenario.Recipe.Actions...)
			s.Scenario.Recipe.Actions[0] = " "
		}, "scenario-recipe-actions-item-0"},
		{"faults-item", func(s *CorpusSchema) { s.Scenario.Recipe.Faults = []string{""} }, "scenario-recipe-faults-item-0"},
		{"observables-empty", func(s *CorpusSchema) { s.Scenario.Recipe.Observables = nil }, "scenario-recipe-observables-empty"},
		{"observables-order", func(s *CorpusSchema) {
			s.Scenario.Recipe.Observables = []string{"provider-wire", "browser-state"}
		}, "scenario-recipe-observables-order"},
		{"bounds-maxfiles-zero", func(s *CorpusSchema) { s.Scenario.Recipe.ResourceBounds.MaxFiles = 0 }, "scenario-recipe-resource-bounds-maxFiles:0"},
		{"bounds-maxbytes-zero", func(s *CorpusSchema) { s.Scenario.Recipe.ResourceBounds.MaxBytes = 0 }, "scenario-recipe-resource-bounds-maxBytes:0"},
		{"bounds-provider-url", func(s *CorpusSchema) { s.Scenario.Recipe.ResourceBounds.MaxProviderRequests = -1 }, "scenario-recipe-resource-bounds-maxProviderRequests:-1"},
		{"bounds-wallclock", func(s *CorpusSchema) { s.Scenario.Recipe.ResourceBounds.MaxWallClockMs = 0 }, "scenario-recipe-resource-bounds-maxWallClockMs:0"},
		{"preboot-shape", func(s *CorpusSchema) { s.Scenario.PrebootTreeSHA256 = "short" }, "scenario-preboot-tree-sha256-shape"},
		{"preboot-mismatch", func(s *CorpusSchema) { s.Scenario.PrebootTreeSHA256 = strings.Repeat("0", 64) }, "scenario-preboot-tree-mismatch"},
		{"action-log-empty", func(s *CorpusSchema) { s.Scenario.ActionLog = nil }, "scenario-action-log-empty"},
		{"action-index", func(s *CorpusSchema) { s.Scenario.ActionLog[1].Index = 0 }, "scenario-action-1-index:0"},
		{"action-id", func(s *CorpusSchema) { s.Scenario.ActionLog[0].ID = "" }, "scenario-action-0-id-empty"},
		{"action-kind", func(s *CorpusSchema) { s.Scenario.ActionLog[0].Kind = "" }, "scenario-action-0-kind-empty"},
		{"action-source", func(s *CorpusSchema) { s.Scenario.ActionLog[0].Source = "" }, "scenario-action-0-source-empty"},
		{"action-observable", func(s *CorpusSchema) { s.Scenario.ActionLog[0].Observable = "" }, "scenario-action-0-observable-empty"},
		{"action-target", func(s *CorpusSchema) { s.Scenario.ActionLog[0].Target = "" }, "scenario-action-0-target-empty"},
		{"action-duplicate", func(s *CorpusSchema) { s.Scenario.ActionLog[1].ID = s.Scenario.ActionLog[0].ID }, "scenario-action-duplicate-id:" + good.Scenario.ActionLog[0].ID},
		{"actions-match-log", func(s *CorpusSchema) { s.Scenario.Recipe.Actions = []string{"only-one"} }, "scenario-actions-match-log"},
		{"census-files", func(s *CorpusSchema) { s.Scenario.ByteCensus.Files++ }, "scenario-byte-census-files:" + itoa(good.Scenario.ByteCensus.Files+1)},
		{"census-bytes", func(s *CorpusSchema) { s.Scenario.ByteCensus.Bytes++ }, "scenario-byte-census-bytes:" + itoa64(good.Scenario.ByteCensus.Bytes+1)},
		{"census-class", func(s *CorpusSchema) { s.Scenario.ByteCensus.Classes["characters"]++ }, "scenario-byte-census-class:characters"},
		{"bounds-files", func(s *CorpusSchema) { s.Scenario.Recipe.ResourceBounds.MaxFiles = 1 }, "scenario-resource-bounds-files"},
		{"bounds-bytes", func(s *CorpusSchema) { s.Scenario.Recipe.ResourceBounds.MaxBytes = 1 }, "scenario-resource-bounds-bytes"},
		{"replay-shape", func(s *CorpusSchema) { s.Scenario.ReplayCommand += "\nrm -rf /" }, "scenario-replay-command-shape"},
		{"replay-placeholders", func(s *CorpusSchema) {
			s.Scenario.ReplayCommand = "go run ./cmd/build-longlived out -seed " + s.Scenario.Seed
		}, "scenario-replay-command-placeholders"},
		{"replay-seed", func(s *CorpusSchema) {
			s.Scenario.ReplayCommand = "go run ./cmd/build-longlived <out> -seed 1 -schema <schema>"
		}, "scenario-replay-command-seed"},
		{"replay-tool", func(s *CorpusSchema) {
			s.Scenario.ReplayCommand = "node tools/build-longlived-corpus.mjs --out <out> --schema-out <schema> --seed " + s.Scenario.Seed
		}, "scenario-replay-command-tool:" + CorpusGeneratorGo},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			mutated := clone(t)
			testCase.mutate(mutated)
			issues := ValidateCorpusScenario(mutated)
			if !hasIssue(issues, testCase.want) {
				t.Fatalf("mutation %q did not produce %q; issues = %v", testCase.name, testCase.want, issues)
			}
			// The builder's round-trip is the other half of the teeth: a schema whose block is malformed must
			// be refused by the READ path by name, not accepted because Build produced it.
			target := filepath.Join(t.TempDir(), "mutated-schema.json")
			body, err := MarshalCorpusSchema(mutated)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(target, body, 0o600); err != nil {
				t.Fatal(err)
			}
			_, loadErr := LoadCorpusSchema(target)
			var validation *ScenarioValidationError
			if !errors.As(loadErr, &validation) {
				t.Fatalf("LoadCorpusSchema accepted a schema with mutation %q (err = %v)", testCase.name, loadErr)
			}
			if !hasName(validation.Names(), testCase.want) {
				t.Fatalf("LoadCorpusSchema refused mutation %q without naming %q; names = %v", testCase.name, testCase.want, validation.Names())
			}
		})
	}
}

// TestScenarioStructuralRefusalsUseTheReadPath asserts the structural refusals that need RAW bytes: a missing
// member, an unknown member at each level, a non-object block, a JSON type mismatch, and a null block (which
// is the same thing as absent, because that is what an optional member can be).
func TestScenarioStructuralRefusalsUseTheReadPath(t *testing.T) {
	spec := schemaSpec()
	_, good := buildWithScenario(t, spec)
	// mutateRaw decodes the emitted manifest, applies mutate to the scenario object's RAW members and
	// re-encodes it, so a test can add/remove members and change a value's JSON type without the typed struct
	// normalising the defect away.
	mutateRaw := func(t *testing.T, mutate func(scenario map[string]json.RawMessage)) map[string]json.RawMessage {
		t.Helper()
		body, err := MarshalCorpusSchema(good)
		if err != nil {
			t.Fatal(err)
		}
		var top map[string]json.RawMessage
		if err := json.Unmarshal(body, &top); err != nil {
			t.Fatal(err)
		}
		var scenario map[string]json.RawMessage
		if err := json.Unmarshal(top["scenario"], &scenario); err != nil {
			t.Fatal(err)
		}
		mutate(scenario)
		encoded, err := json.Marshal(scenario)
		if err != nil {
			t.Fatal(err)
		}
		top["scenario"] = encoded
		return top
	}
	writeAndLoad := func(t *testing.T, top map[string]json.RawMessage) (*ScenarioValidationError, error) {
		t.Helper()
		body, err := json.Marshal(top)
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(t.TempDir(), "schema.json")
		if err := os.WriteFile(target, body, 0o600); err != nil {
			t.Fatal(err)
		}
		_, loadErr := LoadCorpusSchema(target)
		var validation *ScenarioValidationError
		if errors.As(loadErr, &validation) {
			return validation, nil
		}
		return nil, loadErr
	}
	expect := func(t *testing.T, wanted string, mutate func(scenario map[string]json.RawMessage)) {
		t.Helper()
		validation, err := writeAndLoad(t, mutateRaw(t, mutate))
		if err != nil {
			t.Fatalf("expected the named refusal %q, got error %v", wanted, err)
		}
		if !hasName(validation.Names(), wanted) {
			t.Fatalf("refusal did not name %q; names = %v", wanted, validation.Names())
		}
	}
	t.Run("missing_recipe", func(t *testing.T) {
		expect(t, "scenario-field-missing:recipe", func(scenario map[string]json.RawMessage) {
			delete(scenario, "recipe")
		})
	})
	t.Run("unknown_scenario_member", func(t *testing.T) {
		expect(t, "scenario-unknown-field:bogus", func(scenario map[string]json.RawMessage) {
			scenario["bogus"] = json.RawMessage("1")
		})
	})
	t.Run("recipe_unknown_member", func(t *testing.T) {
		expect(t, "scenario-recipe-unknown-field:bogus", func(scenario map[string]json.RawMessage) {
			var recipe map[string]json.RawMessage
			if err := json.Unmarshal(scenario["recipe"], &recipe); err != nil {
				t.Fatal(err)
			}
			recipe["bogus"] = json.RawMessage("1")
			encoded, _ := json.Marshal(recipe)
			scenario["recipe"] = encoded
		})
	})
	t.Run("action_unknown_member", func(t *testing.T) {
		expect(t, "scenario-action-0-unknown-field:bogus", func(scenario map[string]json.RawMessage) {
			var actions []map[string]json.RawMessage
			if err := json.Unmarshal(scenario["actionLog"], &actions); err != nil {
				t.Fatal(err)
			}
			actions[0]["bogus"] = json.RawMessage("1")
			encoded, _ := json.Marshal(actions)
			scenario["actionLog"] = encoded
		})
	})
	t.Run("action_missing_member", func(t *testing.T) {
		expect(t, "scenario-action-0-field-missing:target", func(scenario map[string]json.RawMessage) {
			var actions []map[string]json.RawMessage
			if err := json.Unmarshal(scenario["actionLog"], &actions); err != nil {
				t.Fatal(err)
			}
			delete(actions[0], "target")
			encoded, _ := json.Marshal(actions)
			scenario["actionLog"] = encoded
		})
	})
	t.Run("census_unknown_member", func(t *testing.T) {
		expect(t, "scenario-byte-census-unknown-field:bogus", func(scenario map[string]json.RawMessage) {
			var census map[string]json.RawMessage
			if err := json.Unmarshal(scenario["byteCensus"], &census); err != nil {
				t.Fatal(err)
			}
			census["bogus"] = json.RawMessage("1")
			encoded, _ := json.Marshal(census)
			scenario["byteCensus"] = encoded
		})
	})
	t.Run("non_object_block", func(t *testing.T) {
		body, err := MarshalCorpusSchema(good)
		if err != nil {
			t.Fatal(err)
		}
		var top map[string]json.RawMessage
		if err := json.Unmarshal(body, &top); err != nil {
			t.Fatal(err)
		}
		top["scenario"] = json.RawMessage("[]")
		validation, err := writeAndLoad(t, top)
		if err != nil {
			t.Fatalf("expected the named refusal scenario-not-an-object, got error %v", err)
		}
		if !hasName(validation.Names(), "scenario-not-an-object") {
			t.Fatalf("refusal did not name scenario-not-an-object; names = %v", validation.Names())
		}
	})
	t.Run("type_mismatch", func(t *testing.T) {
		expect(t, "scenario-malformed", func(scenario map[string]json.RawMessage) {
			scenario["scenarioVersion"] = json.RawMessage(`"one"`)
		})
	})
	t.Run("null_block_is_absent", func(t *testing.T) {
		body, err := MarshalCorpusSchema(good)
		if err != nil {
			t.Fatal(err)
		}
		var top map[string]json.RawMessage
		if err := json.Unmarshal(body, &top); err != nil {
			t.Fatal(err)
		}
		top["scenario"] = json.RawMessage("null")
		encoded, _ := json.Marshal(top)
		target := filepath.Join(t.TempDir(), "schema.json")
		if err := os.WriteFile(target, encoded, 0o600); err != nil {
			t.Fatal(err)
		}
		loaded, err := LoadCorpusSchema(target)
		if err != nil {
			t.Fatalf("a null scenario block must read as absent, not be refused: %v", err)
		}
		if loaded.Scenario != nil {
			t.Fatalf("a null scenario block became %+v", loaded.Scenario)
		}
	})
}

// TestScenarioFieldInventoriesAreStable pins the Go half of the cross-language inventory the bridge test
// compares with tools/longlived/schema-fields.mjs. These are the DECLARED members; changing one here without
// the JS mirror is exactly the drift the bridge test fails on, and the values below are the ones the M1
// contract adds (a subset, sorted).
func TestScenarioFieldInventoriesAreStable(t *testing.T) {
	wantScenario := []string{"actionLog", "byteCensus", "environmentClass", "prebootTreeSha256", "recipe", "replayCommand", "scenarioVersion", "seed"}
	if got := CorpusScenarioFieldNames(); strings.Join(got, ",") != strings.Join(wantScenario, ",") {
		t.Fatalf("scenario field inventory = %v, want %v", got, wantScenario)
	}
	wantRecipe := []string{"actions", "books", "cards", "chats", "extensions", "faults", "observables", "prompts", "resourceBounds", "users"}
	if got := CorpusScenarioRecipeFieldNames(); strings.Join(got, ",") != strings.Join(wantRecipe, ",") {
		t.Fatalf("recipe field inventory = %v, want %v", got, wantRecipe)
	}
	wantAction := []string{"id", "index", "kind", "observable", "source", "target"}
	if got := CorpusScenarioActionFieldNames(); strings.Join(got, ",") != strings.Join(wantAction, ",") {
		t.Fatalf("action field inventory = %v, want %v", got, wantAction)
	}
	// The top-level inventory must include the optional block exactly once.
	top := CorpusSchemaFieldNames()
	count := 0
	for _, name := range top {
		if name == "scenario" {
			count++
		}
	}
	if count != 1 {
		t.Fatalf("top-level inventory has %d `scenario` members: %v", count, top)
	}
	// The issue-name inventory is the other half of the shared vocabulary; an empty or unsorted list would make
	// the bridge comparison vacuous.
	if len(ScenarioIssueNamesSorted()) < 30 {
		t.Fatalf("the shared issue-name inventory is too small to be a contract: %v", ScenarioIssueNamesSorted())
	}
	if !sortIsStable(ScenarioIssueNamesSorted()) {
		t.Fatal("the issue-name inventory is not sorted")
	}
}

func hasIssue(issues []ScenarioIssue, wanted string) bool {
	for _, issue := range issues {
		if issue.Name == wanted {
			return true
		}
	}
	return false
}

func hasName(names []string, wanted string) bool {
	for _, name := range names {
		if name == wanted {
			return true
		}
	}
	return false
}

func sortIsStable(values []string) bool {
	for index := 1; index < len(values); index++ {
		if values[index-1] > values[index] {
			return false
		}
	}
	return true
}

func itoa(value int) string {
	return strconv.Itoa(value)
}

func itoa64(value int64) string {
	return strconv.FormatInt(value, 10)
}
