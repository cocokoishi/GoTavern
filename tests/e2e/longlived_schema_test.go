package e2e

// LANE E, §0.3: can ONE deterministic initial corpus feed Go, Node, browser and provider-wire tests?
//
// The answer is implemented, not asserted:
//
//   - `internal/longlivedfixture` emits the SHARED `gotavern-corpus-schema` v1 manifest for the Go complex
//     instance (`cmd/build-longlived --schema`), and `tools/build-longlived-corpus.mjs` emits the SAME shape
//     for the browser/Node corpus (`--schema-out`);
//   - `tools/longlived/verify-corpus-schema.mjs` verifies ANY tree against either manifest with per-file
//     sha256, size, class counts and the tree digest;
//   - `tools/longlived/compare-corpora.mjs` compares the two manifests and NAMES every difference class,
//     deciding `ONE_CORPUS_BYTE_IDENTICAL` only when every path exists on both sides with an equal sha256.
//
// This file is the executable bridge: it builds BOTH corpora with the shipped generators, verifies each tree
// against its own manifest with the JS verifier (so the browser/Node consumer path is exercised), compares
// them, and then mutates a real tree/manifest to show every named assertion has teeth.
//
// The measured result is TWO CORPORA WITH ONE SHARED SCHEMA: the trees are not byte-identical, neither is a
// superset of the other (each has scenario classes the other lacks), and the comparison report is the
// evidence for why separate corpora remain. Unifying the generators themselves is a product change, not a
// test-harness change, and is NOT claimed here.

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/longlivedfixture"
)

type schemaCheck struct {
	Name string `json:"name"`
	OK   bool   `json:"ok"`
}

type schemaVerification struct {
	OK     bool          `json:"ok"`
	Failed []string      `json:"failed"`
	Checks []schemaCheck `json:"checks"`
	Schema struct {
		Name     string `json:"name"`
		Version  int    `json:"version"`
		Scenario *struct {
			ScenarioVersion   int    `json:"scenarioVersion"`
			EnvironmentClass  string `json:"environmentClass"`
			Seed              string `json:"seed"`
			PrebootTreeSha256 string `json:"prebootTreeSha256"`
			ReplayCommand     string `json:"replayCommand"`
		} `json:"scenario"`
	} `json:"schema"`
	Error  string `json:"error"`
	Corpus struct {
		Files      int    `json:"files"`
		Bytes      int64  `json:"bytes"`
		TreeSha256 string `json:"treeSha256"`
	} `json:"corpus"`
}

type schemaComparison struct {
	OK                       bool   `json:"ok"`
	Decision                 string `json:"decision"`
	ByteIdentical            bool   `json:"byteIdentical"`
	SeparateCorporaJustified bool   `json:"separateCorporaJustified"`
	IdenticalPaths           int    `json:"identicalPaths"`
	SharedPaths              int    `json:"sharedPaths"`
	DifferenceClasses        []struct {
		Name string `json:"name"`
	} `json:"differenceClasses"`
	JustifyingClasses []string `json:"justifyingClasses"`
	OnlyLeft          []string `json:"onlyLeft"`
	OnlyRight         []string `json:"onlyRight"`
	Coverage          struct {
		FeaturesOnlyLeft  []string `json:"featuresOnlyLeft"`
		FeaturesOnlyRight []string `json:"featuresOnlyRight"`
		ClassesOnlyLeft   []string `json:"classesOnlyLeft"`
		ClassesOnlyRight  []string `json:"classesOnlyRight"`
	} `json:"coverage"`
	Left struct {
		Generator string `json:"generator"`
		Files     int    `json:"files"`
		Bytes     int64  `json:"bytes"`
	} `json:"left"`
	Right struct {
		Generator string `json:"generator"`
		Files     int    `json:"files"`
		Bytes     int64  `json:"bytes"`
	} `json:"right"`
}

func schemaBridgeSpec() longlivedfixture.Spec {
	return longlivedfixture.Spec{
		Seed: 20261104, Characters: 4, Worlds: 2, BigWorld: 12, ChatBase: 8, ChatStep: 2,
		Presets: 2, Themes: 1, QuickReply: 1, Personas: 2, Backgrounds: 2, Groups: 1,
	}
}

func buildGoCorpusWithSchema(t *testing.T) (string, string) {
	t.Helper()
	return buildGoCorpusSchema(t, true)
}

// buildGoCorpusSchema builds the Go complex-small instance and emits its shared schema, declaring the alpha.16
// M1 E02 scenario block when withScenario is true. The block-less path is the pre-M1 v1 shape and is exercised
// by the backward-compatibility test, not by the bridge.
func buildGoCorpusSchema(t *testing.T, withScenario bool) (string, string) {
	t.Helper()
	tree := filepath.Join(t.TempDir(), "go-complex-small")
	spec := schemaBridgeSpec()
	manifest, err := longlivedfixture.Build(tree, spec)
	if err != nil {
		t.Fatalf("building the Go complex corpus: %v", err)
	}
	var schema *longlivedfixture.CorpusSchema
	if withScenario {
		schema, err = longlivedfixture.BuildCorpusSchemaWithScenario(tree, spec, manifest, "complex-small", longlivedfixture.GoScenarioReplayCommand(spec, "complex-small"))
	} else {
		schema, err = longlivedfixture.BuildCorpusSchema(tree, spec, manifest, "complex-small")
	}
	if err != nil {
		t.Fatalf("building the Go corpus schema: %v", err)
	}
	schemaPath := filepath.Join(t.TempDir(), "go-corpus-schema.json")
	if err := longlivedfixture.WriteCorpusSchema(schemaPath, schema); err != nil {
		t.Fatalf("writing the Go corpus schema: %v", err)
	}
	return tree, schemaPath
}

func buildJSCorpusWithSchema(t *testing.T, seed string) (string, string) {
	t.Helper()
	node := longLivedCorpusNode(t)
	work := t.TempDir()
	tree := filepath.Join(work, "js-small")
	schemaPath := filepath.Join(work, "js-corpus-schema.json")
	command := exec.Command(node, filepath.Join(moduleRoot(t), "tools", "build-longlived-corpus.mjs"),
		"--size", "small", "--out", tree, "--seed", seed, "--force", "--schema-out", schemaPath, "--quiet")
	command.Dir = moduleRoot(t)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("building the JS corpus: %v\n%s", err, tailOf(string(output), 3000))
	}
	if _, err := os.Stat(schemaPath); err != nil {
		t.Fatalf("the JS builder did not write %s: %v\n%s", schemaPath, err, tailOf(string(output), 3000))
	}
	return tree, schemaPath
}

// runNodeTool runs a tool from tools/longlived and returns its stdout plus exit code. A tool that refuses a
// tree exits 1; that is a RESULT here, not a harness failure.
func runNodeTool(t *testing.T, script string, args ...string) (string, int) {
	t.Helper()
	node := longLivedCorpusNode(t)
	command := exec.Command(node, append([]string{filepath.Join(moduleRoot(t), "tools", "longlived", script)}, args...)...)
	command.Dir = moduleRoot(t)
	output, err := command.CombinedOutput()
	if err == nil {
		return string(output), 0
	}
	exitError, ok := err.(*exec.ExitError)
	if !ok {
		t.Fatalf("%s: %v\n%s", script, err, tailOf(string(output), 3000))
	}
	return string(output), exitError.ExitCode()
}

func verifyCorpusSchema(t *testing.T, tree, schemaPath string) (schemaVerification, int) {
	t.Helper()
	reportPath := filepath.Join(t.TempDir(), "verification.json")
	output, code := runNodeTool(t, "verify-corpus-schema.mjs", "--corpus", tree, "--schema", schemaPath, "--report", reportPath, "--quiet")
	body, err := os.ReadFile(reportPath)
	if err != nil {
		t.Fatalf("the verifier wrote no report (%v):\n%s", err, tailOf(output, 3000))
	}
	var report schemaVerification
	if err := json.Unmarshal(body, &report); err != nil {
		t.Fatalf("the verifier report does not decode: %v\n%s", err, tailOf(string(body), 3000))
	}
	return report, code
}

func compareCorporaSchemas(t *testing.T, left, right string) schemaComparison {
	t.Helper()
	reportPath := filepath.Join(t.TempDir(), "comparison.json")
	output, code := runNodeTool(t, "compare-corpora.mjs", "--left", left, "--right", right, "--out", reportPath, "--quiet")
	if code != 0 {
		t.Fatalf("compare-corpora exited %d:\n%s", code, tailOf(output, 4000))
	}
	body, err := os.ReadFile(reportPath)
	if err != nil {
		t.Fatalf("compare-corpora wrote no report: %v\n%s", err, tailOf(output, 3000))
	}
	var report schemaComparison
	if err := json.Unmarshal(body, &report); err != nil {
		t.Fatalf("the comparison report does not decode: %v", err)
	}
	return report
}

// TestLongLivedCorpusSchemaBridge is the §0.3 answer: both shipped generators emit the same schema, both trees
// verify against it through the JS consumer, and the comparison proves — with named, measured classes — that
// they are two corpora with different coverage rather than one corpus twice.
func TestLongLivedCorpusSchemaBridge(t *testing.T) {
	if testing.Short() {
		t.Skip("builds two corpora and runs Node twice")
	}
	goTree, goSchema := buildGoCorpusWithSchema(t)
	jsTree, jsSchema := buildJSCorpusWithSchema(t, "lane-e-bridge")
	// The JS schema must be a pure function of (seed, size) too: a second build of the same corpus has to
	// produce byte-identical schema JSON, or the manifest is not an identity a consumer can trust.
	_, secondJSSchema := buildJSCorpusWithSchema(t, "lane-e-bridge")
	firstSchemaBytes, err := os.ReadFile(jsSchema)
	if err != nil {
		t.Fatal(err)
	}
	secondSchemaBytes, err := os.ReadFile(secondJSSchema)
	if err != nil {
		t.Fatal(err)
	}
	if string(firstSchemaBytes) != string(secondSchemaBytes) {
		t.Fatalf("two builds of the same JS corpus have different schemas (non-deterministic manifest)")
	}

	goReport, code := verifyCorpusSchema(t, goTree, goSchema)
	if code != 0 || !goReport.OK {
		t.Fatalf("the Go tree failed its own shared-schema verification (exit %d): %v", code, goReport.Failed)
	}
	if goReport.Schema.Name != longlivedfixture.CorpusSchemaName || goReport.Schema.Version != 1 {
		t.Fatalf("the Go schema is %q v%d", goReport.Schema.Name, goReport.Schema.Version)
	}
	if len(goReport.Checks) < 8 {
		t.Fatalf("the verifier ran only %d named checks; the bridge needs an inventory/digest/class gate", len(goReport.Checks))
	}
	jsReport, code := verifyCorpusSchema(t, jsTree, jsSchema)
	if code != 0 || !jsReport.OK {
		t.Fatalf("the JS tree failed its own shared-schema verification (exit %d): %v", code, jsReport.Failed)
	}
	t.Logf("shared schema verified: Go tree %d files, JS tree %d files", goReport.Corpus.Files, jsReport.Corpus.Files)

	// alpha.16 M1: BOTH generators declare the OPTIONAL E02 scenario block, and the JS verifier checked it
	// against the walked tree. A block that merely parses would not be evidence; the checks below are the
	// verifier's own named results (`scenario-block`, `scenario-preboot-tree-matches-tree`, …), and each block's
	// replay command must name the seed, the placeholders and the tool that rebuilds the tree.
	for _, subject := range []struct {
		name   string
		seed   string
		report schemaVerification
	}{{"go", "20261104", goReport}, {"js", "lane-e-bridge", jsReport}} {
		scenario := subject.report.Schema.Scenario
		if scenario == nil {
			t.Fatalf("%s: the shared schema declares no scenario block", subject.name)
		}
		if scenario.ScenarioVersion != 1 || scenario.EnvironmentClass != "E02" {
			t.Fatalf("%s: scenario = v%d/%s, want v1/E02", subject.name, scenario.ScenarioVersion, scenario.EnvironmentClass)
		}
		if scenario.Seed != subject.seed {
			t.Fatalf("%s: scenario seed = %q, want %q", subject.name, scenario.Seed, subject.seed)
		}
		if scenario.PrebootTreeSha256 != subject.report.Corpus.TreeSha256 || len(scenario.PrebootTreeSha256) != 64 {
			t.Fatalf("%s: prebootTreeSha256 %q != verified tree %q", subject.name, scenario.PrebootTreeSha256, subject.report.Corpus.TreeSha256)
		}
		for _, fragment := range []string{"<out>", "<schema>", subject.seed} {
			if !strings.Contains(scenario.ReplayCommand, fragment) {
				t.Fatalf("%s: replay command %q does not name %q", subject.name, scenario.ReplayCommand, fragment)
			}
		}
		for _, check := range []string{"scenario-block", "scenario-preboot-tree-matches-tree", "scenario-tree-byte-census-files", "scenario-tree-byte-census-bytes", "scenario-tree-byte-census-classes"} {
			found := false
			for _, result := range subject.report.Checks {
				if result.Name == check && result.OK {
					found = true
				}
			}
			if !found {
				t.Fatalf("%s: the verifier did not report the passing scenario check %q: %+v", subject.name, check, subject.report.Checks)
			}
		}
	}

	report := compareCorporaSchemas(t, goSchema, jsSchema)
	if !report.OK || report.Decision != "TWO_CORPORA_SHARED_SCHEMA" {
		t.Fatalf("comparison decision = %q (ok=%v), want TWO_CORPORA_SHARED_SCHEMA", report.Decision, report.OK)
	}
	if report.ByteIdentical {
		t.Fatalf("the comparison claimed byte identity; it must only do that when every file's sha256 matches")
	}
	if report.Left.Generator != "internal/longlivedfixture" || report.Right.Generator != "tools/build-longlived-corpus.mjs" {
		t.Fatalf("comparison generators = %q / %q", report.Left.Generator, report.Right.Generator)
	}
	if report.Left.Files == 0 || report.Right.Files == 0 || report.Left.Files == report.Right.Files {
		t.Fatalf("the two trees should differ in size, got %d and %d files", report.Left.Files, report.Right.Files)
	}
	if !report.SeparateCorporaJustified {
		t.Fatalf("separate corpora are not justified by the measured report: %+v", report.Coverage)
	}
	if len(report.OnlyLeft) == 0 || len(report.OnlyRight) == 0 {
		t.Fatalf("neither corpus should be a subset of the other; onlyLeft=%d onlyRight=%d", len(report.OnlyLeft), len(report.OnlyRight))
	}
	// The differences must be SPECIFIC surfaces, not just "different bytes": the Go instance owns the legacy
	// migration input, sprites, extension state and moving UI; the JS corpus owns content.log, deleted turns and
	// balanced branch pairs. Those are the reasons a single tree cannot replace both without shrinking coverage.
	wantOnlyLeftFeatures := []string{"legacyMigrationInput", "characterSprites", "movingUI", "extensionState"}
	for _, feature := range wantOnlyLeftFeatures {
		if !containsString(report.Coverage.FeaturesOnlyLeft, feature) && !containsString(report.Coverage.ClassesOnlyLeft, feature) {
			t.Fatalf("the comparison does not report %q as Go-only coverage: %v / %v", feature, report.Coverage.FeaturesOnlyLeft, report.Coverage.ClassesOnlyLeft)
		}
	}
	if !containsString(report.Coverage.FeaturesOnlyRight, "contentLog") && !containsString(report.Coverage.ClassesOnlyRight, "contentLog") {
		t.Fatalf("the comparison does not report content.log as JS-only coverage: %v / %v", report.Coverage.FeaturesOnlyRight, report.Coverage.ClassesOnlyRight)
	}
	seen := map[string]bool{}
	for _, entry := range report.DifferenceClasses {
		seen[entry.Name] = true
	}
	for _, name := range []string{"generator-identity", "file-set", "changed-file-bytes", "count:worldEntries", "feature:systemMessages", "marker:chatMarkerPrefixes", "scenario:seed", "scenario:prebootTreeSha256"} {
		if !seen[name] {
			t.Fatalf("the comparison report lacks the measured difference class %q", name)
		}
	}
	if len(report.DifferenceClasses) < 10 {
		t.Fatalf("the comparison named only %d difference classes; that is not a justification", len(report.DifferenceClasses))
	}
	t.Logf("measured separation: %d difference classes, %d Go-only and %d JS-only files, %d Go-only features (%v), %d JS-only features (%v)",
		len(report.DifferenceClasses), len(report.OnlyLeft), len(report.OnlyRight), len(report.Coverage.FeaturesOnlyLeft), report.Coverage.FeaturesOnlyLeft, len(report.Coverage.FeaturesOnlyRight), report.Coverage.FeaturesOnlyRight)
}

func containsString(values []string, wanted string) bool {
	for _, value := range values {
		if value == wanted {
			return true
		}
	}
	return false
}

// TestLongLivedCorpusSchemaBridgeTeeth mutates a REAL tree and a REAL manifest and shows each guard fails by
// name, then restores and shows green. Without this, the bridge would be a manifest nobody can falsify.
func TestLongLivedCorpusSchemaBridgeTeeth(t *testing.T) {
	tree, schemaPath := buildGoCorpusWithSchema(t)
	baseline, code := verifyCorpusSchema(t, tree, schemaPath)
	if code != 0 || !baseline.OK {
		t.Fatalf("baseline verification is not green: exit %d %v", code, baseline.Failed)
	}

	settingsPath := filepath.Join(tree, "default-user", "settings.json")
	settingsBytes, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("reading settings.json: %v", err)
	}

	t.Run("one_byte_mutation", func(t *testing.T) {
		mutated := append([]byte{}, settingsBytes...)
		mutated[0] ^= 0x01
		if err := os.WriteFile(settingsPath, mutated, 0o600); err != nil {
			t.Fatal(err)
		}
		assertVerifierRed(t, tree, schemaPath, "file-sha256")
		if err := os.WriteFile(settingsPath, settingsBytes, 0o600); err != nil {
			t.Fatal(err)
		}
		assertVerifierGreen(t, tree, schemaPath)
	})

	t.Run("extra_file", func(t *testing.T) {
		extra := filepath.Join(tree, "default-user", "planted-drift.json")
		if err := os.WriteFile(extra, []byte(`{"unexpected":true}`), 0o600); err != nil {
			t.Fatal(err)
		}
		assertVerifierRed(t, tree, schemaPath, "inventory-no-extra-files")
		if err := os.Remove(extra); err != nil {
			t.Fatal(err)
		}
		assertVerifierGreen(t, tree, schemaPath)
	})

	t.Run("renamed_file", func(t *testing.T) {
		renamed := filepath.Join(tree, "default-user", "settings-renamed.json")
		if err := os.Rename(settingsPath, renamed); err != nil {
			t.Fatal(err)
		}
		report := assertVerifierRed(t, tree, schemaPath, "inventory-no-missing-files")
		if !containsString(report.Failed, "inventory-no-extra-files") {
			t.Fatalf("a rename must also report the extra path; failed = %v", report.Failed)
		}
		if err := os.Rename(renamed, settingsPath); err != nil {
			t.Fatal(err)
		}
		assertVerifierGreen(t, tree, schemaPath)
	})

	t.Run("changed_sha256", func(t *testing.T) {
		schema, err := longlivedfixture.LoadCorpusSchema(schemaPath)
		if err != nil {
			t.Fatal(err)
		}
		schema.Files[0].SHA256 = strings.Repeat("0", 64)
		tamperedPath := filepath.Join(t.TempDir(), "tampered-schema.json")
		if err := longlivedfixture.WriteCorpusSchema(tamperedPath, schema); err != nil {
			t.Fatal(err)
		}
		assertVerifierRed(t, tree, tamperedPath, "file-sha256")
		assertVerifierGreen(t, tree, schemaPath)
	})

	t.Run("non_deterministic_rebuild", func(t *testing.T) {
		// Two independent builds of the same spec must have byte-identical schemas; a mutated rebuild must be
		// caught by the Go drift diff with a named assertion, because a consumer that only verified a tree
		// against its own manifest would never notice a generator that stopped being deterministic.
		spec := schemaBridgeSpec()
		secondTree := filepath.Join(t.TempDir(), "go-complex-small-rebuild")
		manifest, err := longlivedfixture.Build(secondTree, spec)
		if err != nil {
			t.Fatal(err)
		}
		rebuilt, err := longlivedfixture.BuildCorpusSchemaWithScenario(secondTree, spec, manifest, "complex-small", longlivedfixture.GoScenarioReplayCommand(spec, "complex-small"))
		if err != nil {
			t.Fatal(err)
		}
		first, err := longlivedfixture.LoadCorpusSchema(schemaPath)
		if err != nil {
			t.Fatal(err)
		}
		firstJSON, _ := longlivedfixture.MarshalCorpusSchema(first)
		rebuiltJSON, _ := longlivedfixture.MarshalCorpusSchema(rebuilt)
		if string(firstJSON) != string(rebuiltJSON) {
			t.Fatalf("the same spec produced different schemas (non-deterministic generator)")
		}
		rebuilt.Files[0].SHA256 = strings.Repeat("f", 64)
		drift := longlivedfixture.DiffCorpusSchemas(first, rebuilt)
		found := false
		for _, difference := range drift {
			if difference.Name == "file-sha256:"+first.Files[0].Path {
				found = true
			}
		}
		if !found {
			t.Fatalf("the drift diff did not name file-sha256:%s; got %v", first.Files[0].Path, drift)
		}
	})
}

func assertVerifierRed(t *testing.T, tree, schemaPath, wanted string) schemaVerification {
	t.Helper()
	report, code := verifyCorpusSchema(t, tree, schemaPath)
	if code == 0 || report.OK {
		t.Fatalf("the verifier accepted a drifted tree/manifest; wanted a red %q", wanted)
	}
	if !containsString(report.Failed, wanted) {
		t.Fatalf("the verifier failed without naming %q; failed = %v", wanted, report.Failed)
	}
	t.Logf("red assertion observed: %s", wanted)
	return report
}

func assertVerifierGreen(t *testing.T, tree, schemaPath string) {
	t.Helper()
	report, code := verifyCorpusSchema(t, tree, schemaPath)
	if code != 0 || !report.OK {
		t.Fatalf("restoring the tree/manifest did not go green: exit %d failed=%v", code, report.Failed)
	}
}

// ---------------------------------------------------------------------------------------------------------------
// alpha.16 M1: the OPTIONAL scenario/interaction block.
//
// These tests drive the JS consumer, not the Go model: a block that merely round-trips through Go would prove
// nothing about the tool a browser/Node probe actually runs. Each planted defect is answered by a NAMED
// assertion, and every case restores the input and re-verifies green, so a red is attributable and a green is not
// the residue of a mutation.
// ---------------------------------------------------------------------------------------------------------------

func readSchemaMap(t *testing.T, schemaPath string) map[string]json.RawMessage {
	t.Helper()
	body, err := os.ReadFile(schemaPath)
	if err != nil {
		t.Fatalf("reading %s: %v", schemaPath, err)
	}
	var top map[string]json.RawMessage
	if err := json.Unmarshal(body, &top); err != nil {
		t.Fatalf("%s is not a JSON object: %v", schemaPath, err)
	}
	return top
}

// writeSchemaMap writes a mutated manifest to a NEW path so the baseline file stays intact for the restore/green
// half of a teeth case. The bytes are written directly; the loader, not this helper, is the judge.
func writeSchemaMap(t *testing.T, top map[string]json.RawMessage) string {
	t.Helper()
	body, err := json.Marshal(top)
	if err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(t.TempDir(), "mutated-corpus-schema.json")
	if err := os.WriteFile(target, body, 0o600); err != nil {
		t.Fatal(err)
	}
	return target
}

func mutateScenarioMap(t *testing.T, top map[string]json.RawMessage, mutate func(scenario map[string]json.RawMessage)) map[string]json.RawMessage {
	t.Helper()
	var scenario map[string]json.RawMessage
	if err := json.Unmarshal(top["scenario"], &scenario); err != nil {
		t.Fatalf("the schema carries no scenario block: %v", err)
	}
	mutate(scenario)
	encoded, err := json.Marshal(scenario)
	if err != nil {
		t.Fatal(err)
	}
	top["scenario"] = encoded
	return top
}

// goScenarioRefusal loads a schema with the Go reader and returns the named scenario assertions it refused on.
func goScenarioRefusal(t *testing.T, schemaPath string) ([]string, error) {
	t.Helper()
	_, err := longlivedfixture.LoadCorpusSchema(schemaPath)
	var validation *longlivedfixture.ScenarioValidationError
	if errors.As(err, &validation) {
		return validation.Names(), nil
	}
	return nil, err
}

// hasNamePrefix matches a named refusal whose suffix carries the offending value ("scenario-version:2"): the
// stable assertion is the prefix, and a gate should not have to know a count to assert that a count was refused.
func hasNamePrefix(names []string, wanted string) bool {
	for _, name := range names {
		if name == wanted || strings.HasPrefix(name, wanted+":") {
			return true
		}
	}
	return false
}

// TestLongLivedCorpusSchemaScenarioBlock is the M1 block's own gate: the declared descriptor verifies against its
// tree, a manifest that OMITS the block is still a valid v1 manifest, and a one-byte tree drift is answered by
// the scenario's named preboot-tree assertion (not merely by the generic digest check).
func TestLongLivedCorpusSchemaScenarioBlock(t *testing.T) {
	if testing.Short() {
		t.Skip("builds a corpus and runs Node")
	}
	tree, schemaPath := buildGoCorpusWithSchema(t)
	baseline, code := verifyCorpusSchema(t, tree, schemaPath)
	if code != 0 || !baseline.OK {
		t.Fatalf("baseline verification is not green: exit %d %v", code, baseline.Failed)
	}
	if baseline.Schema.Scenario == nil || baseline.Schema.Scenario.EnvironmentClass != "E02" {
		t.Fatalf("the baseline schema does not declare the E02 scenario: %+v", baseline.Schema.Scenario)
	}

	t.Run("absent_block_is_a_valid_v1_manifest", func(t *testing.T) {
		plainTree, plainSchema := buildGoCorpusSchema(t, false)
		report, code := verifyCorpusSchema(t, plainTree, plainSchema)
		if code != 0 || !report.OK {
			t.Fatalf("a v1 manifest without a scenario block must verify: exit %d failed=%v", code, report.Failed)
		}
		if report.Schema.Scenario != nil {
			t.Fatalf("the verifier invented a scenario for a block-less manifest: %+v", report.Schema.Scenario)
		}
		absent := false
		for _, check := range report.Checks {
			if check.Name == "scenario-block" && check.OK {
				absent = true
			}
		}
		if !absent {
			t.Fatalf("the verifier did not record the absent scenario path: %+v", report.Checks)
		}
		loaded, err := longlivedfixture.LoadCorpusSchema(plainSchema)
		if err != nil {
			t.Fatalf("the Go reader refused a block-less v1 manifest: %v", err)
		}
		if loaded.Scenario != nil {
			t.Fatalf("the Go reader invented a scenario: %+v", loaded.Scenario)
		}
	})

	t.Run("tree_drift_names_the_scenario_assertion", func(t *testing.T) {
		settingsPath := filepath.Join(tree, "default-user", "settings.json")
		original, err := os.ReadFile(settingsPath)
		if err != nil {
			t.Fatal(err)
		}
		mutated := append([]byte{}, original...)
		mutated[0] ^= 0x01
		if err := os.WriteFile(settingsPath, mutated, 0o600); err != nil {
			t.Fatal(err)
		}
		report := assertVerifierRed(t, tree, schemaPath, "scenario-preboot-tree-matches-tree")
		if !containsString(report.Failed, "file-sha256") {
			t.Fatalf("the drift should also fail the per-file digest; failed = %v", report.Failed)
		}
		if err := os.WriteFile(settingsPath, original, 0o600); err != nil {
			t.Fatal(err)
		}
		assertVerifierGreen(t, tree, schemaPath)
	})

	// Each schema-side defect must be refused by BOTH readers with a NAME. The JS verifier reports it under
	// `schema-valid` (the load error carries the names); the Go reader returns a *ScenarioValidationError.
	schemaCases := []struct {
		name   string
		mutate func(scenario map[string]json.RawMessage)
		want   string
	}{
		{"byte_census_tamper", func(scenario map[string]json.RawMessage) {
			var census map[string]json.RawMessage
			if err := json.Unmarshal(scenario["byteCensus"], &census); err != nil {
				panic(err)
			}
			census["bytes"] = json.RawMessage("1")
			encoded, _ := json.Marshal(census)
			scenario["byteCensus"] = encoded
		}, "scenario-byte-census-bytes"},
		{"unknown_member", func(scenario map[string]json.RawMessage) {
			scenario["bogus"] = json.RawMessage("1")
		}, "scenario-unknown-field:bogus"},
		{"missing_recipe", func(scenario map[string]json.RawMessage) {
			delete(scenario, "recipe")
		}, "scenario-field-missing:recipe"},
		{"bad_environment_class", func(scenario map[string]json.RawMessage) {
			scenario["environmentClass"] = json.RawMessage(`"E99"`)
		}, "scenario-environment-class:E99"},
		{"action_log_drift", func(scenario map[string]json.RawMessage) {
			var actions []map[string]json.RawMessage
			if err := json.Unmarshal(scenario["actionLog"], &actions); err != nil {
				panic(err)
			}
			actions[1]["id"] = json.RawMessage(`"renamed-action"`)
			encoded, _ := json.Marshal(actions)
			scenario["actionLog"] = encoded
		}, "scenario-actions-match-log"},
		{"unsupported_version", func(scenario map[string]json.RawMessage) {
			scenario["scenarioVersion"] = json.RawMessage("2")
		}, "scenario-version:2"},
	}
	for _, testCase := range schemaCases {
		t.Run(testCase.name, func(t *testing.T) {
			mutated := writeSchemaMap(t, mutateScenarioMap(t, readSchemaMap(t, schemaPath), testCase.mutate))
			report, code := verifyCorpusSchema(t, tree, mutated)
			if code == 0 || report.OK {
				t.Fatalf("the verifier accepted a malformed scenario block (%s)", testCase.name)
			}
			if !containsString(report.Failed, "schema-valid") {
				t.Fatalf("the refusal was not reported as schema-valid: failed = %v", report.Failed)
			}
			if !strings.Contains(report.Error, testCase.want) {
				t.Fatalf("the verifier refused without naming %q; error = %q", testCase.want, report.Error)
			}
			names, err := goScenarioRefusal(t, mutated)
			if err != nil {
				t.Fatalf("the Go reader did not refuse with a named scenario error: %v", err)
			}
			if !hasNamePrefix(names, testCase.want) {
				t.Fatalf("the Go reader refused without naming %q; names = %v", testCase.want, names)
			}
			// The baseline manifest is untouched: the same tree still verifies green against it.
			assertVerifierGreen(t, tree, schemaPath)
		})
	}

	// A drift between two BUILDS is what the Go-side drift diff owns (the descriptor is a pure function of the
	// input). A changed block must be a named difference, not a silently accepted rebuild.
	t.Run("rebuilt_block_drift_has_a_name", func(t *testing.T) {
		first, err := longlivedfixture.LoadCorpusSchema(schemaPath)
		if err != nil {
			t.Fatal(err)
		}
		spec := schemaBridgeSpec()
		secondTree := filepath.Join(t.TempDir(), "go-complex-small-rebuild")
		manifest, err := longlivedfixture.Build(secondTree, spec)
		if err != nil {
			t.Fatal(err)
		}
		rebuilt, err := longlivedfixture.BuildCorpusSchemaWithScenario(secondTree, spec, manifest, "complex-small", longlivedfixture.GoScenarioReplayCommand(spec, "complex-small"))
		if err != nil {
			t.Fatal(err)
		}
		firstJSON, _ := longlivedfixture.MarshalCorpusSchema(first)
		rebuiltJSON, _ := longlivedfixture.MarshalCorpusSchema(rebuilt)
		if string(firstJSON) != string(rebuiltJSON) {
			t.Fatalf("the same scenario produced different schema bytes (non-deterministic descriptor)")
		}
		rebuilt.Scenario.ActionLog[0].Target = "default-user/chats/planted.jsonl"
		drift := longlivedfixture.DiffCorpusSchemas(first, rebuilt)
		found := false
		for _, difference := range drift {
			if difference.Name == "scenario-block" {
				found = true
			}
		}
		if !found {
			t.Fatalf("the drift diff did not name the changed scenario block; got %v", drift)
		}
		rebuilt.Scenario = nil
		drift = longlivedfixture.DiffCorpusSchemas(first, rebuilt)
		found = false
		for _, difference := range drift {
			if difference.Name == "scenario-presence" {
				found = true
			}
		}
		if !found {
			t.Fatalf("the drift diff did not name a dropped scenario block; got %v", drift)
		}
	})
}

// ---------------------------------------------------------------------------------------------------------------
// The Go/JS field-inventory agreement (plan §9.B's "keep the two schema definitions in agreement").
// ---------------------------------------------------------------------------------------------------------------

type schemaFieldPayload struct {
	Fields     map[string][]string `json:"fields"`
	IssueNames []string            `json:"issueNames"`
	TreeChecks []string            `json:"treeChecks"`
}

// diffFieldInventories names every field present on one side and not the other. It is a pure function so the
// gate's own teeth can be shown with synthetic maps instead of by mutating real source files.
func diffFieldInventories(goFields, jsFields map[string][]string) []string {
	differences := make([]string, 0)
	groups := map[string]bool{}
	for group := range goFields {
		groups[group] = true
	}
	for group := range jsFields {
		groups[group] = true
	}
	names := make([]string, 0, len(groups))
	for group := range groups {
		names = append(names, group)
	}
	sort.Strings(names)
	for _, group := range names {
		goSet := map[string]bool{}
		for _, field := range goFields[group] {
			goSet[field] = true
		}
		jsSet := map[string]bool{}
		for _, field := range jsFields[group] {
			jsSet[field] = true
		}
		goOnly := make([]string, 0)
		for field := range goSet {
			if !jsSet[field] {
				goOnly = append(goOnly, field)
			}
		}
		jsOnly := make([]string, 0)
		for field := range jsSet {
			if !goSet[field] {
				jsOnly = append(jsOnly, field)
			}
		}
		sort.Strings(goOnly)
		sort.Strings(jsOnly)
		for _, field := range goOnly {
			differences = append(differences, "go-field-not-in-js:"+group+"."+field)
		}
		for _, field := range jsOnly {
			differences = append(differences, "js-field-not-in-go:"+group+"."+field)
		}
	}
	return differences
}

func diffStringSets(goValues, jsValues []string, goName, jsName string) []string {
	differences := make([]string, 0)
	goSet := map[string]bool{}
	for _, value := range goValues {
		goSet[value] = true
	}
	jsSet := map[string]bool{}
	for _, value := range jsValues {
		jsSet[value] = true
	}
	goOnly := make([]string, 0)
	for value := range goSet {
		if !jsSet[value] {
			goOnly = append(goOnly, value)
		}
	}
	jsOnly := make([]string, 0)
	for value := range jsSet {
		if !goSet[value] {
			jsOnly = append(jsOnly, value)
		}
	}
	sort.Strings(goOnly)
	sort.Strings(jsOnly)
	for _, value := range goOnly {
		differences = append(differences, goName+":"+value)
	}
	for _, value := range jsOnly {
		differences = append(differences, jsName+":"+value)
	}
	return differences
}

// TestCorpusSchemaGoAndJSFieldInventoriesAgree is the anti-drift gate: the JS inventories are emitted by
// tools/longlived/schema-fields.mjs from the SAME tables its validators walk, and the Go inventories come from
// reflection over the schema structs. If either side gains a field the other does not declare, this test fails
// naming that field — a manifest the two consumers would interpret differently cannot be committed silently.
func TestCorpusSchemaGoAndJSFieldInventoriesAgree(t *testing.T) {
	if testing.Short() {
		t.Skip("runs the Node field-inventory probe")
	}
	output, code := runNodeTool(t, "schema-fields.mjs")
	if code != 0 {
		t.Fatalf("schema-fields.mjs exited %d:\n%s", code, tailOf(output, 3000))
	}
	var payload schemaFieldPayload
	if err := json.Unmarshal([]byte(lastJSONLine(output)), &payload); err != nil {
		t.Fatalf("schema-fields.mjs printed no decodable inventory: %v\n%s", err, tailOf(output, 3000))
	}
	goFields := map[string][]string{
		"schema":         longlivedfixture.CorpusSchemaFieldNames(),
		"scenario":       longlivedfixture.CorpusScenarioFieldNames(),
		"recipe":         longlivedfixture.CorpusScenarioRecipeFieldNames(),
		"extension":      longlivedfixture.CorpusScenarioExtensionFieldNames(),
		"action":         longlivedfixture.CorpusScenarioActionFieldNames(),
		"byteCensus":     longlivedfixture.CorpusScenarioByteCensusFieldNames(),
		"resourceBounds": longlivedfixture.CorpusScenarioResourceBoundsFieldNames(),
	}
	if differences := diffFieldInventories(goFields, payload.Fields); len(differences) != 0 {
		t.Fatalf("the Go and JS schema field inventories disagree: %v", differences)
	}
	if differences := diffStringSets(longlivedfixture.ScenarioIssueNamesSorted(), payload.IssueNames, "go-issue-not-in-js", "js-issue-not-in-go"); len(differences) != 0 {
		t.Fatalf("the Go and JS named-refusal vocabularies disagree: %v", differences)
	}
	// The JS verifier's tree-vs-block checks are the assertions the bridge test relies on; pin the inventory so
	// renaming one on the JS side without updating the gate is a red, not a silent renaming.
	for _, check := range []string{"scenario-block", "scenario-preboot-tree-matches-tree", "scenario-tree-byte-census-files", "scenario-tree-byte-census-bytes", "scenario-tree-byte-census-classes"} {
		if !containsString(payload.TreeChecks, check) {
			t.Fatalf("the verifier check %q is absent from the JS inventory: %v", check, payload.TreeChecks)
		}
	}
	t.Logf("field inventories agree: schema=%d scenario=%d recipe=%d issues=%d verifierChecks=%d",
		len(goFields["schema"]), len(goFields["scenario"]), len(goFields["recipe"]), len(longlivedfixture.ScenarioIssueNamesSorted()), len(payload.TreeChecks))
}

// TestFieldInventoryDiffHasTeeth proves the cross-language comparison can fail, by name, before it is trusted as
// an agreement: a field on one side only is reported in both directions and equal inventories report nothing.
func TestFieldInventoryDiffHasTeeth(t *testing.T) {
	if differences := diffFieldInventories(
		map[string][]string{"scenario": {"actionLog", "seed"}},
		map[string][]string{"scenario": {"seed", "bogus"}},
	); !containsString(differences, "go-field-not-in-js:scenario.actionLog") || !containsString(differences, "js-field-not-in-go:scenario.bogus") {
		t.Fatalf("the field diff did not name both directions: %v", differences)
	}
	if differences := diffFieldInventories(
		map[string][]string{"scenario": {"seed"}},
		map[string][]string{"scenario": {"seed"}},
	); len(differences) != 0 {
		t.Fatalf("equal inventories reported differences: %v", differences)
	}
	if differences := diffStringSets([]string{"scenario-version"}, []string{"scenario-version", "scenario-new"}, "go-issue-not-in-js", "js-issue-not-in-go"); !containsString(differences, "js-issue-not-in-go:scenario-new") {
		t.Fatalf("the issue-name diff did not name the JS-only refusal: %v", differences)
	}
}
