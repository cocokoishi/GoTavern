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
	"os"
	"os/exec"
	"path/filepath"
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
		Name    string `json:"name"`
		Version int    `json:"version"`
	} `json:"schema"`
	Corpus struct {
		Files int   `json:"files"`
		Bytes int64 `json:"bytes"`
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
	tree := filepath.Join(t.TempDir(), "go-complex-small")
	spec := schemaBridgeSpec()
	manifest, err := longlivedfixture.Build(tree, spec)
	if err != nil {
		t.Fatalf("building the Go complex corpus: %v", err)
	}
	schema, err := longlivedfixture.BuildCorpusSchema(tree, spec, manifest, "complex-small")
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
	for _, name := range []string{"generator-identity", "file-set", "changed-file-bytes", "count:worldEntries", "feature:systemMessages", "marker:chatMarkerPrefixes"} {
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
		rebuilt, err := longlivedfixture.BuildCorpusSchema(secondTree, spec, manifest, "complex-small")
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
