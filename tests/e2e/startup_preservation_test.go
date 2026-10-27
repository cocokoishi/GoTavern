package e2e

// EXISTING USER DATA WINS: every byte a user already had must be the same byte after a boot (AGENTS 28).
//
// Item 3 of the startup long tail, and the data-preservation half of the claim item 1 made about the data
// ROOT. Item 1 proved the boot serves the directory it creates; this proves it does not rewrite what is in
// it. AGENTS 28 is absolute about the cases below, so the assertion is BYTE IDENTITY of every planted file,
// not "contains" or "still parses" -- a `contains` check passes for a file that was reformatted, reordered, or
// had its comments and quoting rewritten, and every one of those is a user-visible change to their own file.
//
// WHAT IS PINNED, from SillyTavern 1.19.0 = 06bde939 (read 2026-10-27):
//
//	src/config-init.js:215-239   `const originalKeys = getAllKeys(config)`, then `_.defaultsDeep(config,
//	                             defaultConfig)`, then `addedKeys = difference(updated, original)`; if
//	                             nothing was added and nothing migrated, `return` WITHOUT writing. Otherwise
//	                             `fs.writeFileSync(configPath, yaml.stringify(config))` -- a WHOLE-DOCUMENT
//	                             re-serialisation through the yaml library.
//	src/config-init.js:191-211   Â§34.4's control happened first: `addMissingConfigValues` REMOVES the legacy
//	                             control keys (autoUpdate / enableServerPluginsAutoUpdate) and appends their
//	                             GoTavern replacements, which means `addedKeys` is never empty for a stock
//	                             config, so a stock config IS rewritten once.
//	src/config-init.js:176-190   `migratedKeys` is never computed for the file text; nothing normalises the
//	                             user's comments, quoting or key order, because the pinned writer REPLACES
//	                             them wholesale with yaml.stringify.
//
//	=> Two pinned facts drive the assertions below, and they pull in opposite directions:
//	   (1) A config that needs nothing is not written at all -- byte identity is the pinned observable.
//	   (2) A config that needs a key IS re-serialised wholesale, and the user's comments/quoting/order are
//	       NOT preserved by pinned. That is the "config edited by a tool" behaviour, and this product
//	       reproduces it (Â§34.4). So byte identity is asserted where the file is untouched, and the SAME
//	       unknown KEY must survive where it is rewritten -- two different claims, and conflating them is how
//	       a comment-destroying rewrite gets called a data-loss bug.
//
// The data files (chat stores, avatars, unknown top-level files, settings.json, worlds) are NOT in that
// conditional path at all: pinned never rewrites them at startup, so for those the assertion is unconditional
// byte identity, and any change is a defect with no reading in which it is acceptable.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// plantedTree records every file this test wrote, with the digest it was written with, so a later comparison
// names the file that changed instead of reporting "the tree moved".
type plantedTree struct {
	root  string
	files map[string]string // slash path -> sha256
	order []string          // sorted, for stable failure output
}

// plantFile writes one file under root and records its digest, refusing a path that escapes root.
func (tree *plantedTree) plantFile(t *testing.T, relative string, body []byte) {
	t.Helper()
	target := filepath.Join(tree.root, filepath.FromSlash(relative))
	cleanRoot, err := filepath.Abs(tree.root)
	if err != nil {
		t.Fatalf("resolve %s: %v", tree.root, err)
	}
	cleanTarget, err := filepath.Abs(target)
	if err != nil {
		t.Fatalf("resolve %s: %v", target, err)
	}
	if rel, relErr := filepath.Rel(cleanRoot, cleanTarget); relErr != nil || rel == ".." ||
		len(rel) > 2 && rel[:3] == ".."+string(filepath.Separator) {
		t.Fatalf("refusing to plant %s outside %s", target, tree.root)
	}
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		t.Fatalf("create %s: %v", filepath.Dir(target), err)
	}
	if err := os.WriteFile(target, body, 0o600); err != nil {
		t.Fatalf("write %s: %v", target, err)
	}
	key := filepath.ToSlash(relative)
	if _, exists := tree.files[key]; !exists {
		tree.order = append(tree.order, key)
		sort.Strings(tree.order)
	}
	tree.files[key] = sha256Hex(string(body))
}

// assertByteIdentical fails, naming each file, when any planted file is missing or its bytes changed.
func (tree *plantedTree) assertByteIdentical(t *testing.T, diagnostic func() string) {
	t.Helper()
	for _, relative := range tree.order {
		target := filepath.Join(tree.root, filepath.FromSlash(relative))
		body, err := os.ReadFile(target)
		if err != nil {
			t.Errorf("the boot DELETED %s, which the user's tree contained before it started (AGENTS 28): %v\n%s",
				relative, err, diagnostic())
			continue
		}
		if digest := sha256Hex(string(body)); digest != tree.files[relative] {
			t.Errorf("the boot REWROTE %s: %d bytes now hash to %s, planted %d bytes hashed %s. "+
				"AGENTS 28 is absolute that an existing file is not rewritten; a `contains` assertion would "+
				"have passed here.\n  now:  %q",
				relative, len(body), digest, len(tree.files[relative]), tree.files[relative], truncateForLog(string(body), 300))
		}
	}
}

func truncateForLog(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return text[:limit] + "..."
}

// TestBootPreservesEveryExistingUserFile is item 3. It plants the four shapes the brief names -- unknown
// top-level files, unknown keys in settings.json, a legacy config key, an empty chat -- plus the surrounding
// data a long-lived tree always has, boots the shipped binary over it, and requires every planted byte back.
func TestBootPreservesEveryExistingUserFile(t *testing.T) {
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	userRoot := filepath.Join(dataRoot, "default-user")
	planted := &plantedTree{root: dataRoot, files: map[string]string{}}

	// (1) UNKNOWN TOP-LEVEL FILES IN THE DATA ROOT. A long-lived tree accumulates them: editor backups,
	// exports, a README, a ops script. The product has no opinion about any of them.
	planted.plantFile(t, "README.txt", []byte("my tavern notes\nsecond line\n"))
	planted.plantFile(t, "editor-backup~", []byte("{\"stale\":true}\n"))
	planted.plantFile(t, "export-2025.jsonl", []byte("{\"a\":1}\n{\"b\":2}\n"))
	planted.plantFile(t, "unknown-binary.dat", []byte{0x00, 0x01, 0xFE, 0xFF, 0x80, 0x7F})

	// (2) THE USER'S SETTINGS, carrying unknown keys the product must not drop. `futureFeature` is a
	// provider the pinned frontend does not know yet; `oai_settings.unknown_tuning` is the shape a preset
	// writes; the nested unknown inside extension_settings is the shape an extension writes.
	settings := []byte("{\n" +
		"  \"username\": \"default-user\",\n" +
		"  \"active_character\": \"Longlived_Card.png\",\n" +
		"  \"futureFeature\": {\"enabled\": true, \"threshold\": 0.25},\n" +
		"  \"oai_settings\": {\"openai_model\": \"gpt-4o-mini\", \"unknown_tuning\": [1, 2, 3]},\n" +
		"  \"extension_settings\": {\"tavern_helper\": {\"variables\": {\"global\": {\"KEEP_ME\": \"yes\"}}}}\n" +
		"}\n")
	planted.plantFile(t, "default-user/settings.json", settings)

	// (3) AN EMPTY CHAT, at the path pinned reads (chats/<avatar without .png>/<file>.jsonl). Empty rather
	// than absent: this is the file a user has when they opened a new chat and sent nothing, and a boot that
	// SEEDS it or deletes it destroys a state the user can see in their chat list.
	planted.plantFile(t, "default-user/chats/Longlived_Card/empty.jsonl", []byte{})

	// A non-empty chat too, so the empty-file case cannot be satisfied by "chats are not touched at all".
	planted.plantFile(t, "default-user/chats/Longlived_Card/with-history.jsonl",
		[]byte("{\"name\":\"Longlived Card\",\"is_user\":false,\"mes\":\"KEEP\"}\n"))

	// (4) A WORLD BOOK WITH FIELD ORDER AND UNKNOWN MEMBERS the product has no opinion about.
	planted.plantFile(t, "default-user/worlds/Keep.json",
		[]byte("{\"entries\":{\"0\":{\"uid\":0,\"key\":[\"KEEP_KEY\"],\"content\":\"KEEP_CONTENT\",\"unknownMember\":{\"keep\":1}}}}"))

	// (5) The surrounding trees a real user has, so the boot takes its full path rather than an empty-data
	// special case.
	for _, directory := range []string{"characters", "groups", "backgrounds", "User Avatars", "QuickReplies", "themes"} {
		if err := os.MkdirAll(filepath.Join(userRoot, filepath.FromSlash(directory)), 0o777); err != nil {
			t.Fatalf("create %s: %v", directory, err)
		}
	}
	planted.plantFile(t, "default-user/themes/keep.json", []byte("{\"main_text_color\":\"#abcdef\"}"))

	// (6) A LEGACY CONFIG KEY. This one is DIFFERENT from the rest and the file says why: pinned migrates
	// legacy keys by REMOVING them and re-serialising the WHOLE document (config-init.js:191-211, 239), so
	// the legacy key itself is EXPECTED to be gone afterwards. What must survive is the user's own UNKNOWN key
	// in the same file -- and that is asserted against the file, not assumed.
	legacyConfig := []byte("# my tavern config -- keep my comment if you can\r\n" +
		"listen: false\r\n" +
		"port: 8000\r\n" +
		"disableChatBackup: true\r\n" +
		"myOwnSection:\r\n" +
		"  keptValue: 41\r\n")
	configPath := filepath.Join(installRoot, "config.yaml")
	if err := os.WriteFile(configPath, legacyConfig, 0o644); err != nil {
		t.Fatalf("write the config: %v", err)
	}

	server := bootServerAt(t, installRoot, dataRoot, nil)

	// THE ASSERTION: every planted byte of user data is unchanged.
	planted.assertByteIdentical(t, server.diagnostic)

	// The data-root files are the unconditional half; the CONFIG is the conditional one. Asserted separately
	// and with its own message, so a reader can tell which claim failed.
	after, err := os.ReadFile(configPath)
	if err != nil {
		t.Fatalf("the boot removed the config: %v", err)
	}
	if !strings.Contains(string(after), "myOwnSection") || !strings.Contains(string(after), "keptValue") {
		t.Fatalf("the boot lost the user's own UNKNOWN section from config.yaml. Pinned's whole-document\n"+
			"re-serialisation (config-init.js:239) is allowed to drop comments and reorder, but an unknown KEY\n"+
			"the user wrote must survive (AGENTS 28).\nAfter:\n%s", after)
	}
	// The legacy key's REMOVAL is pinned behaviour, asserted rather than allowed silently: if it were still
	// present, the migration did not run, and a later reader would think the file had been left alone.
	if strings.Contains(string(after), "disableChatBackup") {
		t.Fatalf("the legacy key `disableChatBackup` is still in config.yaml, so the pinned key migration "+
			"(config-init.js:191-211) did not run. The migration is a startup behaviour (hard rule 13), and "+
			"its absence is a parity defect rather than preservation.\nAfter:\n%s", after)
	}

	// And the product is actually serving: a tree that boots but answers nothing would satisfy every
	// filesystem assertion above while proving nothing about the user being able to work.
	client := openSession(t, server.origin)
	status, _, served := client.postJSON(t, "/api/settings/get", "{}")
	if status != 200 {
		t.Fatalf("POST /api/settings/get answered %d on a tree whose files were all preserved: %s", status, served)
	}
	// The unknown settings key is VISIBLE through the route too, which is the half that matters to the
	// frontend: preserved on disk but dropped while serving is not preservation.
	for _, unknown := range []string{"futureFeature", "KEEP_ME", "unknown_tuning"} {
		if !strings.Contains(served, unknown) {
			t.Fatalf("settings.json was preserved on disk but %q is GONE from what the server serves, so the "+
				"frontend cannot see it:\n%s", unknown, truncateForLog(served, 600))
		}
	}

	// `futureFeature` must be a JSON member of the served body, not merely a substring somewhere: a comment or
	// a nested key could satisfy the substring check while the top-level key was dropped.
	var raw map[string]json.RawMessage
	if err := json.Unmarshal([]byte(served), &raw); err != nil {
		t.Fatalf("the served settings are not JSON: %v", err)
	}
	if _, present := raw["futureFeature"]; !present {
		t.Fatalf("the served settings dropped the unknown TOP-LEVEL key `futureFeature`")
	}
}
