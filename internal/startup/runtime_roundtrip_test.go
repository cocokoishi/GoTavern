package startup

// Replay of tests/oracle/sillytavern-1.19.0-runtime-roundtrip.json (recorded by
// tools/probe-runtime-roundtrip.mjs).
//
// WHAT THIS FILE IS AND IS NOT, stated first because a reader must not mistake one half for the other
// (the same split the fixture records under `assertionSplit`):
//
//   - The CROSS-SUBJECT claims — pinned booting over a GoTavern tree preserves every user-data byte,
//     pinned's rewrites there equal its rewrites over an empty tree, nothing user-owned is deleted, and
//     a second boot of EITHER subject leaves its tree alone — are asserted by the PROBE at record time
//     and re-asserted by the CI oracle job, which re-records the fixture and requires zero diff. A Go
//     test cannot re-check them: it cannot boot pinned Node, and a Go test that claimed to would be
//     exactly the fake oracle this project has already shipped once.
//   - What this file DOES assert is (i) the fixture's own coherence, so a bad re-record fails here
//     instead of passing, (ii) the refusal rule the Lead asked for: a snapshot entry marked
//     `normalized` whose path is not declared in the fixture's `normalization` map fails the test, and
//     (iii) THE GOTAVERN HALF OF IDEMPOTENCE, which Go can actually execute: run this implementation's
//     data startup over a tree seeded with the exact user-data bytes the fixture recorded, and require
//     every one of those files to be byte-identical afterwards and none of them to disappear.

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/commandline"
)

type roundTripEntry struct {
	Path       string `json:"path"`
	Type       string `json:"type"`
	Bytes      int64  `json:"bytes"`
	SHA256     string `json:"sha256"`
	Normalized string `json:"normalized"`
}

type roundTripSnapshot struct {
	Config struct {
		Path    string `json:"path"`
		Present bool   `json:"present"`
		Bytes   int64  `json:"bytes"`
		SHA256  string `json:"sha256"`
	} `json:"config"`
	Entries []roundTripEntry `json:"entries"`
}

type roundTripUserData struct {
	Path       string `json:"path"`
	Bytes      int64  `json:"bytes"`
	SHA256     string `json:"sha256"`
	Normalized string `json:"normalized"`
	BodyBase64 string `json:"bodyBase64"`
	WrittenBy  string `json:"writtenBy"`
}

type roundTripFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Question         string                       `json:"question"`
	AssertionSplit   map[string]string            `json:"assertionSplit"`
	ComparisonExclus map[string]string            `json:"comparisonExclusions"`
	Normalization    map[string]string            `json:"normalization"`
	NotRecorded      []string                     `json:"notRecorded"`
	UserData         []roundTripUserData          `json:"userData"`
	Steps            []map[string]any             `json:"steps"`
	Snapshots        map[string]roundTripSnapshot `json:"snapshots"`
	Deltas           map[string]struct {
		Added   []string `json:"added"`
		Removed []string `json:"removed"`
		Changed []string `json:"changed"`
	} `json:"deltas"`
}

const roundTripFixturePath = "sillytavern-1.19.0-runtime-roundtrip.json"

// roundTripStepOrder is the recorded order. The replay refuses a fixture whose steps are not exactly
// these, because the order is the only thing that makes a dependent sequence interpretable: every step
// consumes a copy of its parent's runtime root, so a reordered or keyed list would silently compare the
// wrong pair of trees.
var roundTripStepOrder = []string{
	"freshPinned", "freshGotavern", "gotavernUserData", "pinnedOverGotavern", "gotavernAgain", "pinnedAgain",
}

func loadRoundTripFixture(t *testing.T) roundTripFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", roundTripFixturePath))
	if err != nil {
		t.Fatalf("the runtime round-trip fixture is missing; record it with %s "+
			"(GOTAVERN_BINARY=<a CI-built gotavern> node tools/probe-runtime-roundtrip.mjs <pinned> .): %v",
			roundTripFixturePath, err)
	}
	var fixture roundTripFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("runtime round-trip baseline = %+v", fixture.Baseline)
	}
	if len(fixture.ComparisonExclus) == 0 || len(fixture.Normalization) == 0 {
		t.Fatal("the fixture must declare its comparison exclusions and normalizations")
	}
	if len(fixture.AssertionSplit) == 0 || len(fixture.NotRecorded) == 0 {
		t.Fatal("the fixture must state which side asserts what, and what it does not record")
	}
	return fixture
}

// TestRuntimeRoundTripFixtureCoherence refuses a fixture that could pass vacuously: wrong step order,
// a normalized entry with no declared reason, user data that disagrees between the steps, or a fresh
// tree that disagrees with fresh-start.
func TestRuntimeRoundTripFixtureCoherence(t *testing.T) {
	fixture := loadRoundTripFixture(t)

	if len(fixture.Steps) != len(roundTripStepOrder) {
		t.Fatalf("fixture records %d steps, the replay knows %d", len(fixture.Steps), len(roundTripStepOrder))
	}
	for index, step := range fixture.Steps {
		name, _ := step["name"].(string)
		if name != roundTripStepOrder[index] {
			t.Fatalf("step %d is %q, the recorded order requires %q (ordered array, never a keyed map)", index, name, roundTripStepOrder[index])
		}
	}
	for _, name := range roundTripStepOrder {
		if _, present := fixture.Snapshots[name]; !present {
			t.Fatalf("step %q has no snapshot", name)
		}
	}

	// THE REFUSAL: every normalized entry must key into the declared normalization map.
	normalizedPaths := 0
	for _, name := range roundTripStepOrder {
		for _, entry := range fixture.Snapshots[name].Entries {
			if entry.Normalized == "" {
				continue
			}
			normalizedPaths++
			if !roundTripDeclaresNormalization(fixture.Normalization, entry.Path) {
				t.Fatalf("%s: %s is normalized (%q) but no entry in `normalization` declares it; "+
					"an undeclared exclusion is how a host-derived value becomes a passing fixture",
					name, entry.Path, entry.Normalized)
			}
			if entry.SHA256 != "" && !strings.Contains(entry.Path, "<timestamp>") {
				// A normalized value must not also carry a hash, or the fixture records the value it
				// claims to exclude. The one exception is the timestamped backup name, whose PATH is
				// normalized while its content hash is deliberately retained.
				t.Fatalf("%s: %s is normalized but also records sha256 %q", name, entry.Path, entry.SHA256)
			}
		}
	}
	if normalizedPaths == 0 {
		t.Fatal("no normalized path was recorded, so the refusal above could not fail")
	}
	if len(fixture.Normalization) <= 0 {
		t.Fatal("the normalization map is empty")
	}

	// User data must be present in both the tree GoTavern wrote and the tree pinned left behind,
	// byte for byte. This is the fixture-level half of the claim.
	if len(fixture.UserData) == 0 {
		t.Fatal("no user data was recorded, so the round trip proves nothing")
	}
	gotavernWritten := 0
	for _, entry := range fixture.UserData {
		if entry.WrittenBy == "gotavern" {
			gotavernWritten++
		}
		if entry.Normalized != "" {
			// The one normalized user-data file is the stored character card, whose bytes carry the
			// import route's generated `chat` name and `create_date`. The fixture records its SIZE (both
			// formats are fixed width) and what the card says is recorded by `readBack`; a body of that
			// length is materialised by the idempotence test below, which is the honest maximum.
			if entry.Bytes <= 0 || entry.SHA256 != "" || entry.BodyBase64 != "" {
				t.Fatalf("%s: a normalized user-data entry records its size only, got sha256 %q and a body of %d base64 chars",
					entry.Path, entry.SHA256, len(entry.BodyBase64))
			}
			if !roundTripDeclaresNormalization(fixture.Normalization, entry.Path) {
				t.Fatalf("%s: normalized user data with no declared reason", entry.Path)
			}
			for _, step := range []string{"gotavernUserData", "pinnedOverGotavern"} {
				recorded, present := roundTripFindEntry(fixture.Snapshots[step], entry.Path)
				if !present || recorded.Bytes != entry.Bytes {
					t.Fatalf("%s: %s does not record the same size for the user data", step, entry.Path)
				}
			}
			continue
		}
		if entry.BodyBase64 == "" || entry.SHA256 == "" {
			t.Fatalf("%s: user data must record its bytes and hash", entry.Path)
		}
		decoded, err := base64.StdEncoding.DecodeString(entry.BodyBase64)
		if err != nil {
			t.Fatalf("%s: recorded body is not base64: %v", entry.Path, err)
		}
		digest := sha256.Sum256(decoded)
		if hex.EncodeToString(digest[:]) != entry.SHA256 {
			t.Fatalf("%s: recorded sha256 does not describe the recorded bytes", entry.Path)
		}
		if int64(len(decoded)) != entry.Bytes {
			t.Fatalf("%s: recorded byte count %d does not match %d recorded bytes", entry.Path, entry.Bytes, len(decoded))
		}
		for _, step := range []string{"gotavernUserData", "pinnedOverGotavern"} {
			recorded, present := roundTripFindEntry(fixture.Snapshots[step], entry.Path)
			if !present {
				t.Fatalf("%s: %s does not contain the user data", step, entry.Path)
			}
			if recorded.SHA256 != entry.SHA256 {
				t.Fatalf("%s: %s records a different hash than the user data", step, entry.Path)
			}
		}
	}
	if gotavernWritten < 4 {
		t.Fatalf("only %d GoTavern-written user-data files were recorded; the four routes should each leave one", gotavernWritten)
	}
	probeWritten := 0
	for _, entry := range fixture.UserData {
		if entry.WrittenBy == "probe" {
			probeWritten++
		}
	}
	if probeWritten == 0 {
		t.Fatal("the fixture must record at least the probe-written extension directory, labelled `writtenBy: probe`")
	}

	// The fresh pinned tree must agree with fresh-start, which is the staleness detector: two fixtures
	// recorded independently. Paths only, because fresh-start's normalization reasons are stamped by a
	// different recorder and comparing prose would fail for a reason that is not a defect.
	freshStartBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-fresh-start.json"))
	if err != nil {
		t.Fatal(err)
	}
	var freshStart freshStartInventoryFixture
	if err := json.Unmarshal(freshStartBytes, &freshStart); err != nil {
		t.Fatal(err)
	}
	freshStartPaths := map[string]bool{}
	for _, entry := range freshStart.Filesystem.DataRoot {
		freshStartPaths[entry.Path] = true
	}
	for _, entry := range fixture.Snapshots["freshPinned"].Entries {
		if strings.HasPrefix(entry.Path, "_webpack") {
			continue
		}
		if !freshStartPaths[entry.Path] {
			t.Fatalf("the round-trip fixture records fresh path %q that fresh-start does not: one of the two is stale", entry.Path)
		}
	}

	// The deltas the probe asserted must be the deltas the snapshots actually describe, so a fixture
	// whose prose and data disagree cannot pass.
	for step, delta := range fixture.Deltas {
		if len(delta.Removed) != 0 {
			t.Fatalf("%s: the probe recorded removals %v; this leg must show that a boot never deletes user state", step, delta.Removed)
		}
	}
	if len(fixture.Deltas["userDataWritten"].Added)+len(fixture.Deltas["userDataWritten"].Changed) == 0 {
		t.Fatal("the user-data step recorded no tree change")
	}

	// And the SECOND-BOOT deltas must be empty for both subjects, which is the L4 property that makes
	// "an update must not disturb an existing tree" checkable at all.
	for _, step := range []string{"gotavernSecondBoot", "pinnedSecondBoot"} {
		delta, present := fixture.Deltas[step]
		if !present {
			t.Fatalf("the fixture does not record the %s delta", step)
		}
		if len(delta.Added)+len(delta.Removed)+len(delta.Changed) != 0 {
			t.Fatalf("%s is not empty: %v", step, delta)
		}
	}
}

func roundTripFindEntry(snapshot roundTripSnapshot, wanted string) (roundTripEntry, bool) {
	for _, entry := range snapshot.Entries {
		if entry.Path == wanted {
			return entry, true
		}
	}
	return roundTripEntry{}, false
}

// roundTripDeclaresNormalization matches a recorded path against the declared patterns, which are
// written with a `<handle>` and/or `**` placeholder rather than as literal paths.
func roundTripDeclaresNormalization(declared map[string]string, entryPath string) bool {
	for pattern := range declared {
		candidate := strings.TrimPrefix(pattern, "data/")
		if candidate == entryPath {
			return true
		}
		if strings.HasSuffix(candidate, "/**") {
			prefix := strings.TrimSuffix(candidate, "/**")
			// `<handle>` stands for the user directory; any single segment is accepted there.
			if strings.HasPrefix(prefix, "<handle>") {
				segments := strings.Split(entryPath, "/")
				if len(segments) >= 2 && strings.HasPrefix(strings.Join(segments[1:], "/"), strings.TrimPrefix(prefix, "<handle>")) {
					return true
				}
				continue
			}
			if strings.HasPrefix(entryPath, prefix+"/") {
				return true
			}
		}
		if strings.Contains(candidate, "<handle>") || strings.Contains(candidate, "<timestamp>") {
			if roundTripMatchesPlaceholder(candidate, entryPath) {
				return true
			}
		}
	}
	return false
}

func roundTripMatchesPlaceholder(pattern, entryPath string) bool {
	patternParts := strings.Split(pattern, "/")
	entryParts := strings.Split(entryPath, "/")
	if len(patternParts) != len(entryParts) {
		return false
	}
	for index := range patternParts {
		if patternParts[index] == entryParts[index] {
			continue
		}
		if strings.HasPrefix(patternParts[index], "<") || strings.Contains(patternParts[index], "<handle>") || strings.Contains(patternParts[index], "<timestamp>") {
			continue
		}
		// A `*` segment wildcard, as in `characters/*.png`.
		if strings.HasPrefix(patternParts[index], "*") && strings.HasSuffix(entryParts[index], strings.TrimPrefix(patternParts[index], "*")) {
			continue
		}
		return false
	}
	return true
}

// TestGotavernStartupLeavesExistingUserDataAlone is the GoTavern half of idempotence, and the only part
// of this leg a Go test can execute: seed a data root with the EXACT user-data bytes the fixture
// recorded from GoTavern's own routes, run this implementation's data startup, and require every one of
// those files to be byte-identical afterwards and none to be missing.
func TestGotavernStartupLeavesExistingUserDataAlone(t *testing.T) {
	fixture := loadRoundTripFixture(t)
	isolateSillyTavernEnvironment(t)

	installRoot := filepath.Join(t.TempDir(), "install")
	dataRoot := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(installRoot, 0o755); err != nil {
		t.Fatal(err)
	}

	// Seed the recorded user data first, so startup sees a tree that already holds a character card, a
	// chat, a world, a preset and an extension directory.
	seeded := map[string][]byte{}
	for _, entry := range fixture.UserData {
		var body []byte
		if entry.Normalized != "" {
			// The stored character card's bytes carry the import route's generated timestamps, so the
			// fixture records its SIZE only. A buffer of that length is what the claim needs: startup
			// must leave the file alone, and the property cannot depend on the timestamp's value.
			body = bytes.Repeat([]byte{0x5a}, int(entry.Bytes))
		} else {
			decoded, err := base64.StdEncoding.DecodeString(entry.BodyBase64)
			if err != nil {
				t.Fatal(err)
			}
			body = decoded
		}
		target := filepath.Join(dataRoot, filepath.FromSlash(entry.Path))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, body, 0o644); err != nil {
			t.Fatal(err)
		}
		seeded[entry.Path] = body
	}

	parsed, err := commandline.ResolveCommandLine(commandline.ResolveOptions{
		Args:             []string{"--dataRoot", dataRoot, "--listen=false", "--enableIPv4", "true", "--enableIPv6", "false"},
		WorkingDirectory: installRoot,
		ServerDirectory:  installRoot,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := InitializeDataStartupFromCommandLine(installRoot, parsed, time.UnixMilli(1735689600000), func(time.Duration) {})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.Diagnostics) != 0 {
		t.Fatalf("startup over an existing user tree reported caught errors: %+v", result.Diagnostics)
	}

	paths := make([]string, 0, len(seeded))
	for relative := range seeded {
		paths = append(paths, relative)
	}
	sort.Strings(paths)
	for _, relative := range paths {
		target := filepath.Join(dataRoot, filepath.FromSlash(relative))
		after, err := os.ReadFile(target)
		if err != nil {
			t.Fatalf("startup DELETED user data %s: %v", relative, err)
		}
		if !bytes.Equal(after, seeded[relative]) {
			t.Fatalf("startup REWROTE user data %s: %d bytes became %d (sha256 %s)",
				relative, len(seeded[relative]), len(after), sha256Hex(after))
		}
	}
	t.Logf("startup preserved %d user-data files byte for byte", len(paths))
}

func sha256Hex(body []byte) string {
	digest := sha256.Sum256(body)
	return hex.EncodeToString(digest[:])
}
