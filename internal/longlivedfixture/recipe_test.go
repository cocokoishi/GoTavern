package longlivedfixture

// THE SEEDED RECIPE'S OWN GATE (alpha.16 M1). Three claims, each measured rather than asserted:
//
//  1. DETERMINISM: the same seed marshals to the same bytes and the same canonical preboot tree hash; a
//     different seed changes the hash. `TestSeededRecipeIsDeterministic` and
//     `TestSeededRecipeDiffHasTeeth` are the two halves (the second proves the diff can name a difference).
//  2. THE DIGEST DESCRIBES THE GENERATED TREE: the in-memory canonical digest a recipe records is compared
//     with the digest `BuildCorpusSchema` computes by WALKING the tree the generator actually wrote. A recipe
//     whose preboot digest did not match the tree would be a hand-typed expectation.
//  3. BACKWARD-COMPATIBLE READ: a version-1 document (no `tier`, no `extensionPoints`) still reads, and a
//     document carrying an unknown member or an invalid tier is refused by NAME.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func mustRecipe(t *testing.T, seed int64) *SeededRecipe {
	t.Helper()
	recipe, err := BuildSeededRecipe(seed)
	if err != nil {
		t.Fatalf("build the recipe for seed %d: %v", seed, err)
	}
	return recipe
}

func TestSeededRecipeIsDeterministic(t *testing.T) {
	first := mustRecipe(t, 1601)
	second := mustRecipe(t, 1601)
	firstBytes, err := MarshalSeededRecipe(first)
	if err != nil {
		t.Fatal(err)
	}
	secondBytes, err := MarshalSeededRecipe(second)
	if err != nil {
		t.Fatal(err)
	}
	if string(firstBytes) != string(secondBytes) {
		t.Fatalf("two builds of seed 1601 marshalled differently, so the recipe is not a pure function of the seed")
	}
	if differences := DiffSeededRecipes(first, second); len(differences) != 0 {
		t.Fatalf("two builds of the same seed reported differences: %v", differences)
	}
	if len(first.Preboot.TreeSHA256) != 64 {
		t.Fatalf("preboot tree sha256 = %q, want 64 hex characters", first.Preboot.TreeSHA256)
	}
	if first.Preboot.Files == 0 || first.Preboot.Bytes == 0 {
		t.Fatalf("preboot census = %d files / %d bytes", first.Preboot.Files, first.Preboot.Bytes)
	}
	if len(first.Recipe.Actions) != len(StateMachineOperations) {
		t.Fatalf("recipe declares %d operations, the lane's plan is %d", len(first.Recipe.Actions), len(StateMachineOperations))
	}
	if first.Recipe.Users != StateMachineUserCount {
		t.Fatalf("recipe declares %d users, the E06 floor is %d", first.Recipe.Users, StateMachineUserCount)
	}
	// A version-2 document must round-trip through the reader the lane uses.
	body, err := MarshalSeededRecipe(first)
	if err != nil {
		t.Fatal(err)
	}
	read, err := ReadSeededRecipe(body)
	if err != nil {
		t.Fatalf("the builder emitted a recipe its own reader refuses: %v", err)
	}
	if read.Tier != first.Tier || read.Seed != first.Seed {
		t.Fatalf("round trip changed the recipe: tier %q seed %q", read.Tier, read.Seed)
	}
}

func TestSeededRecipeDiffHasTeeth(t *testing.T) {
	first := mustRecipe(t, 1601)
	other := mustRecipe(t, 1602)
	differences := DiffSeededRecipes(first, other)
	names := make([]string, 0, len(differences))
	for _, difference := range differences {
		names = append(names, difference.Name)
	}
	if first.Preboot.TreeSHA256 == other.Preboot.TreeSHA256 {
		t.Fatalf("seed 1601 and seed 1602 produced the same preboot tree hash %s, so the tree is not seeded",
			first.Preboot.TreeSHA256)
	}
	if !containsValue(names, "recipe-preboot-tree") {
		t.Fatalf("the diff of two different seeds did not name recipe-preboot-tree: %v", names)
	}
	if !containsValue(names, "recipe-seed") {
		t.Fatalf("the diff of two different seeds did not name recipe-seed: %v", names)
	}
	if !containsValue(names, "recipe-preboot-artifact:chat") {
		t.Fatalf("the diff of two different seeds did not name the chat artifact: %v", names)
	}
}

func TestSeededRecipePrebootDigestMatchesTheGeneratedTree(t *testing.T) {
	for _, seed := range []int64{1601, 1602, 1643} {
		recipe := mustRecipe(t, seed)
		root := t.TempDir()
		environment, err := BuildSeededEnvironment(root, []int64{seed}, StateMachineUserCount)
		if err != nil {
			t.Fatalf("seed %d: build the environment: %v", seed, err)
		}
		if environment.Schema.Tree.SHA256 != recipe.Preboot.TreeSHA256 {
			t.Fatalf("seed %d: the walked tree digest %s does not match the recipe's preboot digest %s "+
				"(the recipe would describe a tree it does not generate)",
				seed, environment.Schema.Tree.SHA256, recipe.Preboot.TreeSHA256)
		}
		if environment.Schema.Tree.Files != recipe.Preboot.Files || environment.Schema.Tree.Bytes != recipe.Preboot.Bytes {
			t.Fatalf("seed %d: walked census %d/%d != recipe census %d/%d",
				seed, environment.Schema.Tree.Files, environment.Schema.Tree.Bytes, recipe.Preboot.Files, recipe.Preboot.Bytes)
		}
		paths := SeededSeedArtifactPaths(seed)
		if len(paths) != len(recipe.Preboot.Artifacts) {
			t.Fatalf("seed %d: %d artifact paths vs %d declared artifact digests", seed, len(paths), len(recipe.Preboot.Artifacts))
		}
		for role, relative := range paths {
			body, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
			if err != nil {
				t.Fatalf("seed %d: read %s artifact at %s: %v", seed, role, relative, err)
			}
			if got := digest(body); got != recipe.Preboot.Artifacts[role] {
				t.Fatalf("seed %d: %s artifact digest %s != declared %s", seed, role, got, recipe.Preboot.Artifacts[role])
			}
		}
	}
}

func TestSeededRecipeBackwardCompatibleRead(t *testing.T) {
	recipe := mustRecipe(t, 1601)
	body, err := MarshalSeededRecipe(recipe)
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]json.RawMessage
	if err := json.Unmarshal(body, &document); err != nil {
		t.Fatal(err)
	}

	// A version-1 document is the pre-tier shape: no `tier`, no `extensionPoints`. It must still read, with the
	// documented defaults, or the extension is not backward compatible.
	legacy := cloneRecipeMembers(t, document)
	legacy["schemaVersion"] = json.RawMessage("1")
	delete(legacy, "tier")
	delete(legacy, "extensionPoints")
	legacyBytes, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	read, err := ReadSeededRecipe(legacyBytes)
	if err != nil {
		t.Fatalf("a version-1 recipe without tier/extensionPoints was refused: %v", err)
	}
	if read.Tier != "" {
		t.Fatalf("the legacy read invented a tier: %q", read.Tier)
	}
	if read.ExtensionPoints != nil {
		t.Fatalf("the legacy read invented extension points: %+v", read.ExtensionPoints)
	}

	// A version-2 document missing `tier` is refused by name.
	missingTier := cloneRecipeMembers(t, document)
	delete(missingTier, "tier")
	missingTierBytes, err := json.Marshal(missingTier)
	if err != nil {
		t.Fatal(err)
	}
	refusal := readRecipeRefusal(t, missingTierBytes)
	if !hasRecipeIssue(refusal, "recipe-tier-required") {
		t.Fatalf("a v2 recipe without tier was not refused for recipe-tier-required: %v", refusal)
	}

	// An unknown member is refused by name (a typed decode would silently ignore it).
	unknown := cloneRecipeMembers(t, document)
	unknown["tierBypass"] = json.RawMessage(`"stress"`)
	unknownBytes, err := json.Marshal(unknown)
	if err != nil {
		t.Fatal(err)
	}
	refusal = readRecipeRefusal(t, unknownBytes)
	if !hasRecipeIssue(refusal, "recipe-unknown-field:tierBypass") {
		t.Fatalf("an unknown recipe member was not refused by name: %v", refusal)
	}

	// An invalid tier is refused by name.
	badTier := cloneRecipeMembers(t, document)
	badTier["tier"] = json.RawMessage(`"enormous"`)
	badTierBytes, err := json.Marshal(badTier)
	if err != nil {
		t.Fatal(err)
	}
	refusal = readRecipeRefusal(t, badTierBytes)
	if !hasRecipeIssue(refusal, "recipe-tier:enormous") {
		t.Fatalf("an unknown tier was not refused by name: %v", refusal)
	}

	// A declared preboot digest that does not match the tree shape is refused by name.
	badDigest := cloneRecipeMembers(t, document)
	var preboot map[string]json.RawMessage
	if err := json.Unmarshal(badDigest["preboot"], &preboot); err != nil {
		t.Fatal(err)
	}
	preboot["treeSha256"] = json.RawMessage(`"not-a-digest"`)
	encodedPreboot, err := json.Marshal(preboot)
	if err != nil {
		t.Fatal(err)
	}
	badDigest["preboot"] = encodedPreboot
	badDigestBytes, err := json.Marshal(badDigest)
	if err != nil {
		t.Fatal(err)
	}
	refusal = readRecipeRefusal(t, badDigestBytes)
	if !hasRecipeIssue(refusal, "recipe-preboot-tree-sha256") {
		t.Fatalf("a malformed preboot digest was not refused by name: %v", refusal)
	}
}

func TestSeededEnvironmentBatchCarriesEverySeedsDeclaredArtifacts(t *testing.T) {
	seeds := []int64{1601, 1602, 1603, 1604}
	root := t.TempDir()
	environment, err := BuildSeededEnvironment(root, seeds, StateMachineUserCount)
	if err != nil {
		t.Fatalf("build the seeded batch environment: %v", err)
	}
	if environment.Schema.Tree.Files == 0 || environment.Schema.Tree.SHA256 == "" {
		t.Fatalf("the batch environment has no schema identity: %+v", environment.Schema.Tree)
	}
	for _, seed := range seeds {
		recipe := mustRecipe(t, seed)
		for role, relative := range SeededSeedArtifactPaths(seed) {
			body, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
			if err != nil {
				t.Fatalf("seed %d: the batch tree is missing its %s at %s: %v", seed, role, relative, err)
			}
			if got := digest(body); got != recipe.Preboot.Artifacts[role] {
				t.Fatalf("seed %d: batch %s digest %s != the recipe's declared %s", seed, role, got, recipe.Preboot.Artifacts[role])
			}
		}
	}
	// The batch must also carry every user's node-persist record, or a boot sees fewer accounts than the
	// recipe declares, and the multi-user leg would be vacuous.
	for _, handle := range StateMachineUserHandles() {
		recordPath := filepath.Join(root, "_storage", seededStorageFilename("user:"+handle))
		if _, err := os.Stat(recordPath); err != nil {
			t.Fatalf("the batch tree is missing the node-persist record for %s: %v", handle, err)
		}
	}
}

func TestSeededRecipeHandlesAreDistinctAndOrdered(t *testing.T) {
	handles := StateMachineUserHandles()
	if len(handles) != StateMachineUserCount {
		t.Fatalf("%d handles, want %d", len(handles), StateMachineUserCount)
	}
	if handles[0] != "default-user" {
		t.Fatalf("first handle = %q, want the pinned default account", handles[0])
	}
	seen := map[string]bool{}
	for _, handle := range handles {
		if seen[handle] {
			t.Fatalf("duplicate handle %q", handle)
		}
		seen[handle] = true
		if strings.ContainsAny(handle, "/\\") {
			t.Fatalf("handle %q is not path-safe", handle)
		}
	}
	// Seed -> user mapping is deterministic and covers all eight accounts.
	users := map[string]bool{}
	for seed := int64(1601); seed < 1601+int64(StateMachineUserCount); seed++ {
		users[SeededSeedUser(seed)] = true
	}
	if len(users) != StateMachineUserCount {
		t.Fatalf("%d consecutive seeds covered %d of %d accounts: %v", StateMachineUserCount, len(users), StateMachineUserCount, users)
	}
}

// cloneRecipeMembers returns a deep-enough copy of the top-level members so a mutation case cannot leak into the
// next one.
func cloneRecipeMembers(t *testing.T, document map[string]json.RawMessage) map[string]json.RawMessage {
	t.Helper()
	clone := make(map[string]json.RawMessage, len(document))
	for name, value := range document {
		clone[name] = append(json.RawMessage(nil), value...)
	}
	return clone
}

func readRecipeRefusal(t *testing.T, body []byte) []string {
	t.Helper()
	_, err := ReadSeededRecipe(body)
	if err == nil {
		t.Fatalf("the reader accepted a recipe it should have refused")
	}
	var validation *RecipeValidationError
	if !asRecipeValidationError(err, &validation) {
		t.Fatalf("the refusal was not a named RecipeValidationError: %v", err)
	}
	return validation.Names()
}

// asRecipeValidationError unwraps without importing errors at every call site.
func asRecipeValidationError(err error, target **RecipeValidationError) bool {
	for err != nil {
		if validation, ok := err.(*RecipeValidationError); ok {
			*target = validation
			return true
		}
		unwrapper, ok := err.(interface{ Unwrap() error })
		if !ok {
			return false
		}
		err = unwrapper.Unwrap()
	}
	return false
}

func hasRecipeIssue(names []string, wanted string) bool {
	for _, name := range names {
		if name == wanted {
			return true
		}
	}
	return false
}
