package e2e

// THE LONG-LIVED CORPUS, AS A GO GATE (Beta 1: qualify long-lived session data, not only a fresh journey).
//
// WHAT THIS FILE ADDS TO tests/e2e/longlived_test.go. That file builds ONE tree by hand in Go and proves the
// first slice (boot does not damage it; its card, image, chat, world book and settings are reachable).
// This file consumes the DETERMINISTIC SYNTHETIC CORPUS (`tools/build-longlived-corpus.mjs`): three sizes,
// fixed seed, byte-identical rebuild, manifest, multiple characters/chats/groups/worlds/presets and the
// repository's committed complex-preset DERIVATION. It proves, from the generated tree:
//
//   1. the generator is DETERMINISTIC -- two builds with the same seed have the same tree digest, asserted by
//      the generator's own `--verify-deterministic` and re-asserted here against the manifest;
//   2. the LOADER has teeth -- a tree that drifted by one byte is refused by `tools/longlived/verify.mjs`
//      with NAMED failing checks, so the verifier is not a document that reads as evidence;
//   3. the shipped binary BOOTS over the corpus and serves what a long-lived user had: every character
//      (including unicode/unusual filenames), the long chat history bound to its card, swipes, world books,
//      presets, groups, backgrounds/avatars/assets/thumbnails, Quick Replies and themes -- and the boot does
//      not rewrite or delete a single planted byte (AGENTS 27/28).
//
// WHAT IT DOES NOT PROVE, stated so a green cannot be over-read: browser-visible state, provider-wire bytes
// and the restart/resume journey are the browser qualifier's job (`tests/browser/longlived-*.mjs`); a real
// provider is out of scope on every gate (AGENTS 22). This file is the fast, hermetic half of the pair.
//
// WHERE IT RUNS. The `verify` job of ci.yml runs `go test ./...`, so this test runs there whenever `node` is
// available on PATH (it is on the GitHub runner). A machine without Node SKIPS with a named reason rather
// than passing vacuously; the longlived workflow additionally exports GOTAVERN_LONGLIVED_CORPUS so the tree
// is generated once and reused across sizes.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const corpusEnv = "GOTAVERN_LONGLIVED_CORPUS" // optional prebuilt corpus root (manifest.json inside)

type corpusManifest struct {
	Schema        string         `json:"schema"`
	SchemaVersion int            `json:"schemaVersion"`
	Seed          string         `json:"seed"`
	Size          string         `json:"size"`
	Tree          corpusTree     `json:"tree"`
	Counts        map[string]any `json:"counts"`
	Surfaces      struct {
		Settings   string   `json:"settings"`
		WorldNames []string `json:"world_names"`
		Characters []struct {
			Name    string `json:"name"`
			Avatar  string `json:"avatar"`
			Unicode bool   `json:"unicode"`
		} `json:"characters"`
		Chats []struct {
			File         string `json:"file"`
			Character    string `json:"character"`
			Messages     int    `json:"messages"`
			Long         bool   `json:"long"`
			SharedPrefix int    `json:"sharedPrefix"`
			DeletedTurns int    `json:"deletedTurns"`
		} `json:"chats"`
		Groups []struct {
			ID       string `json:"id"`
			File     string `json:"file"`
			Chat     string `json:"chat"`
			Messages int    `json:"messages"`
		} `json:"groups"`
		Worlds []struct {
			Name    string `json:"name"`
			File    string `json:"file"`
			Entries int    `json:"entries"`
			Legacy  bool   `json:"legacy"`
		} `json:"worlds"`
		Presets []struct {
			Name                string `json:"name"`
			File                string `json:"file"`
			Prompts             int    `json:"prompts"`
			StructurePreserving bool   `json:"structurePreserving"`
		} `json:"presets"`
		Themes []struct {
			Name string `json:"name"`
			File string `json:"file"`
		} `json:"themes"`
		Backgrounds []struct {
			Name string `json:"name"`
			File string `json:"file"`
		} `json:"backgrounds"`
		Avatars []struct {
			Name string `json:"name"`
			File string `json:"file"`
		} `json:"avatars"`
		Assets []struct {
			Name string `json:"name"`
			File string `json:"file"`
		} `json:"assets"`
		Quickreplies []struct {
			Name string `json:"name"`
			File string `json:"file"`
		} `json:"quickreplies"`
	} `json:"surfaces"`
}

type corpusTree struct {
	Sha256 string `json:"sha256"`
	Files  int    `json:"files"`
	Bytes  int64  `json:"bytes"`
}

// longLivedCorpusNode refuses to skip silently in a test whose whole subject is the corpus: a missing Node is
// an explicit SKIP naming the reason, because a green here without the corpus would prove nothing.
func longLivedCorpusNode(t *testing.T) string {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skipf("node is not on PATH, so the long-lived corpus cannot be generated in this job; the "+
			"longlived workflow (.github/workflows/longlived.yml) is the gate that always provides it: %v", err)
	}
	return node
}

// buildLongLivedCorpus invokes the generator and returns the tree's root plus its manifest. The
// `--verify-deterministic` flag makes the generator rebuild the same (size, seed) into scratch and compare
// digests, so the determinism claim is a MEASUREMENT from this run rather than a comment.
func buildLongLivedCorpus(t *testing.T, size string) (string, corpusManifest) {
	t.Helper()
	if provided := strings.TrimSpace(os.Getenv(corpusEnv)); provided != "" {
		root, err := filepath.Abs(provided)
		if err != nil {
			t.Fatalf("%s=%q is not a usable path: %v", corpusEnv, provided, err)
		}
		manifest := readCorpusManifest(t, root)
		if manifest.Size != size {
			t.Fatalf("%s points at a %q corpus but this test needs %q", corpusEnv, manifest.Size, size)
		}
		t.Logf("%s: using the prebuilt %s corpus at %s (tree %s)", corpusEnv, size, root, manifest.Tree.Sha256)
		return root, manifest
	}
	node := longLivedCorpusNode(t)
	root := filepath.Join(t.TempDir(), "corpus")
	generator := filepath.Join(moduleRoot(t), "tools", "build-longlived-corpus.mjs")
	command := exec.Command(node, generator, "--size", size, "--out", root, "--seed", "corpus-go-gate", "--force", "--verify-deterministic", "--quiet")
	command.Dir = moduleRoot(t)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("building the %s long-lived corpus failed: %v\n%s", size, err, tailOf(string(output), 4000))
	}
	summaryLine := lastJSONLine(string(output))
	if summaryLine == "" {
		t.Fatalf("the corpus generator printed no JSON summary, so this test cannot name what it consumed:\n%s", tailOf(string(output), 4000))
	}
	var summary struct {
		TreeSha256  string `json:"treeSha256"`
		Determinism *struct {
			Identical      bool   `json:"identical"`
			OriginalSha256 string `json:"originalSha256"`
			RebuiltSha256  string `json:"rebuiltSha256"`
		} `json:"determinism"`
	}
	if err := json.Unmarshal([]byte(summaryLine), &summary); err != nil {
		t.Fatalf("the corpus generator's JSON summary is not decodable: %v\n%s", err, summaryLine)
	}
	if summary.Determinism == nil || !summary.Determinism.Identical {
		t.Fatalf("THE CORPUS IS NOT DETERMINISTIC: rebuild reported %+v, so two runs do not produce the same "+
			"bytes and every qualification built on it would compare different inputs", summary.Determinism)
	}
	manifest := readCorpusManifest(t, root)
	if manifest.Tree.Sha256 != summary.TreeSha256 {
		t.Fatalf("the manifest digest %s does not match the generator's own summary %s", manifest.Tree.Sha256, summary.TreeSha256)
	}
	t.Logf("generated the %s long-lived corpus: %d files, %d bytes, tree %s, deterministic rebuild %s",
		size, manifest.Tree.Files, manifest.Tree.Bytes, manifest.Tree.Sha256, summary.Determinism.RebuiltSha256)
	return root, manifest
}

func lastJSONLine(output string) string {
	lines := strings.Split(strings.TrimSpace(output), "\n")
	for index := len(lines) - 1; index >= 0; index-- {
		line := strings.TrimSpace(lines[index])
		if strings.HasPrefix(line, "{") && strings.HasSuffix(line, "}") {
			return line
		}
	}
	return ""
}

func tailOf(text string, limit int) string {
	if len(text) <= limit {
		return text
	}
	return "…" + text[len(text)-limit:]
}

func readCorpusManifest(t *testing.T, root string) corpusManifest {
	t.Helper()
	body, err := os.ReadFile(filepath.Join(root, "manifest.json"))
	if err != nil {
		t.Fatalf("the corpus at %s has no readable manifest.json: %v", root, err)
	}
	var manifest corpusManifest
	if err := json.Unmarshal(body, &manifest); err != nil {
		t.Fatalf("the corpus manifest at %s does not decode: %v", root, err)
	}
	if manifest.Schema != "gotavern-longlived-corpus" || manifest.SchemaVersion != 1 {
		t.Fatalf("the corpus at %s is schema %q v%d, not the long-lived corpus this gate consumes", root, manifest.Schema, manifest.SchemaVersion)
	}
	return manifest
}

// copyCorpus copies the generated tree into an install root the shipped binary can be booted beside: the
// binary is copied there by resolveBinary, and `config.yaml` + `default-user/` are already the layout the
// product looks for. The source corpus is NEVER booted in place (AGENTS 14/51: qualification inputs are
// read-only; the leg works on a copy).
func copyCorpus(t *testing.T, source, target string) {
	t.Helper()
	err := filepath.WalkDir(source, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, current)
		if err != nil {
			return err
		}
		destination := filepath.Join(target, relative)
		if entry.IsDir() {
			return os.MkdirAll(destination, 0o777)
		}
		body, err := os.ReadFile(current)
		if err != nil {
			return err
		}
		return os.WriteFile(destination, body, 0o600)
	})
	if err != nil {
		t.Fatalf("copy the corpus %s to %s: %v", source, target, err)
	}
}

// digestTree is the BEFORE/AFTER identity map used to prove the boot did not rewrite a user's bytes.
func digestTree(t *testing.T, root string) map[string]string {
	t.Helper()
	digests := map[string]string{}
	err := filepath.WalkDir(root, func(current string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		body, err := os.ReadFile(current)
		if err != nil {
			return err
		}
		digests[filepath.ToSlash(relative)] = contentDigest(body)
		return nil
	})
	if err != nil {
		t.Fatalf("digest the tree at %s: %v", root, err)
	}
	return digests
}

// TestLongLivedCorpus is Beta 1's hermetic long-lived gate: the generated corpus is deterministic, the loader
// rejects a drifted tree by name, and the shipped binary boots over a corpus COPY and serves/preserves every
// long-lived surface the browser qualifier will then drive.
func TestLongLivedCorpus(t *testing.T) {
	requireProductionTransport(t)
	corpusRoot, manifest := buildLongLivedCorpus(t, "small")

	// The manifest must describe a LONG-LIVED tree, not a freshly seeded one. These are absolute assertions,
	// not comparisons: a comparison between two subjects cannot see a journey that was short on BOTH sides.
	if got := len(manifest.Surfaces.Characters); got < 4 {
		t.Fatalf("the corpus has %d characters; a long-lived tree has several, and every later assertion "+
			"about multiple chats/presets would be about one subject", got)
	}
	if got := len(manifest.Surfaces.Chats); got < 4*len(manifest.Surfaces.Characters) {
		t.Fatalf("the corpus has %d chats for %d characters; a long-lived tree holds several per character",
			got, len(manifest.Surfaces.Characters))
	}
	if got := len(manifest.Surfaces.Worlds); got < 2 {
		t.Fatalf("the corpus has %d world books, want at least 2", got)
	}
	if got := len(manifest.Surfaces.Presets); got < 3 {
		t.Fatalf("the corpus has %d presets, want at least 3 (the committed complex derivation included)", got)
	}
	complexPresets := 0
	for _, preset := range manifest.Surfaces.Presets {
		if preset.StructurePreserving {
			complexPresets++
		}
	}
	if complexPresets == 0 {
		t.Fatal("the corpus has no structure-preserving preset, so it does not carry the committed complex derivation")
	}
	unicodeCharacters := 0
	for _, character := range manifest.Surfaces.Characters {
		if character.Unicode {
			unicodeCharacters++
		}
	}
	if unicodeCharacters == 0 {
		t.Fatal("the corpus has no unicode character, so it cannot see a path/JSON encoding defect")
	}
	longChats := 0
	for _, chat := range manifest.Surfaces.Chats {
		if chat.Long && chat.Messages >= 100 {
			longChats++
		}
	}
	if longChats == 0 {
		t.Fatal("the corpus has no long chat (>=100 messages), so 'long-lived' is a label rather than a measurement")
	}

	// (2) THE LOADER HAS TEETH, exercised on a copy: one appended byte must be refused by NAME.
	t.Run("loader-rejects-a-drifted-tree", func(t *testing.T) {
		driftedRoot := filepath.Join(t.TempDir(), "drifted")
		copyCorpus(t, corpusRoot, driftedRoot)
		longChat := ""
		for _, chat := range manifest.Surfaces.Chats {
			if chat.Long {
				longChat = chat.File
				break
			}
		}
		if longChat == "" {
			t.Fatal("the manifest names no long chat, so there is nothing to drift")
		}
		target := filepath.Join(driftedRoot, filepath.FromSlash(longChat))
		body, err := os.ReadFile(target)
		if err != nil {
			t.Fatalf("read %s: %v", target, err)
		}
		if err := os.WriteFile(target, append(body, []byte("\n")...), 0o600); err != nil {
			t.Fatalf("drift %s: %v", target, err)
		}
		verdict := runCorpusVerifier(t, driftedRoot)
		if verdict.OK {
			t.Fatalf("the corpus verifier passed a tree whose %s gained one byte, so its digest/loader checks "+
				"cannot fail and prove nothing", longChat)
		}
		named := map[string]bool{}
		for _, entry := range verdict.Checks {
			if !entry.OK {
				named[entry.Name] = true
			}
		}
		for _, required := range []string{"tree-digest-equals-manifest", "inventory-no-changed-files"} {
			if !named[required] {
				t.Fatalf("the drifted tree failed without the named check %q; it failed with %v", required, named)
			}
		}
	})

	// (3) BOOT over a corpus COPY. Every planted surface must be reachable and every planted byte unchanged.
	t.Run("boot-serves-and-preserves", func(t *testing.T) {
		installRoot := t.TempDir()
		copyCorpus(t, corpusRoot, installRoot)
		before := digestTree(t, installRoot)

		server := bootServerAt(t, installRoot, installRoot, nil)
		client := openSession(t, server.origin)

		// (3a) THE CARD LIST, including unicode names and the card's own chat binding.
		status, _, body := client.postJSON(t, "/api/characters/all", "{}")
		if status != http.StatusOK {
			t.Fatalf("POST /api/characters/all = %d, so the user's cards are invisible: %.300q", status, body)
		}
		var characters []map[string]any
		if err := json.Unmarshal([]byte(body), &characters); err != nil {
			t.Fatalf("POST /api/characters/all did not answer a character array: %v (%.300q)", err, body)
		}
		if len(characters) != len(manifest.Surfaces.Characters)+1 { // + the legacy v2 card
			t.Errorf("POST /api/characters/all listed %d characters, the corpus planted %d (+1 legacy card)",
				len(characters), len(manifest.Surfaces.Characters))
		}
		listedByAvatar := map[string]map[string]any{}
		for _, character := range characters {
			listedByAvatar[fmt.Sprint(character["avatar"])] = character
		}
		for _, planted := range manifest.Surfaces.Characters {
			name := filepath.Base(planted.Avatar)
			entry, present := listedByAvatar[name]
			if !present {
				t.Errorf("the corpus card %q is not listed, so a user's character is missing", name)
				continue
			}
			if fmt.Sprint(entry["name"]) != planted.Name {
				t.Errorf("card %q is listed as %q, not %q (unicode/name round trip)", name, entry["name"], planted.Name)
			}
			// The card's `chat` binding is how pinned reopens the right history on click.
			longChatForCard := ""
			for _, chat := range manifest.Surfaces.Chats {
				if chat.Long && chat.Character == planted.Name {
					longChatForCard = filepath.Base(chat.File)
					break
				}
			}
			if longChatForCard != "" && fmt.Sprint(entry["chat"]) != strings.TrimSuffix(longChatForCard, ".jsonl") {
				t.Errorf("card %q binds chat %q, the corpus planted %q", name, entry["chat"], strings.TrimSuffix(longChatForCard, ".jsonl"))
			}
		}

		// (3b) THE LONG-LIVED CHAT OPENS through the route the frontend uses, with its swipes intact.
		longChat := manifest.Surfaces.Chats[0]
		for _, chat := range manifest.Surfaces.Chats {
			if chat.Long {
				longChat = chat
				break
			}
		}
		avatar := ""
		for _, character := range manifest.Surfaces.Characters {
			if character.Name == longChat.Character {
				avatar = filepath.Base(character.Avatar)
			}
		}
		if avatar == "" {
			t.Fatalf("the long chat %q names a character that is not in the manifest", longChat.File)
		}
		chatRequest, err := marshalJSON(map[string]any{
			"avatar_url": avatar,
			"file_name":  strings.TrimSuffix(filepath.Base(longChat.File), ".jsonl"),
		})
		if err != nil {
			t.Fatalf("encode the chats/get body: %v", err)
		}
		status, _, body = client.postJSON(t, "/api/chats/get", chatRequest)
		if status != http.StatusOK {
			t.Fatalf("POST /api/chats/get = %d, so the user's long history does not open: %.300q", status, body)
		}
		// Pinned's /api/chats/get answers the FILE's records as an ARRAY: the first element is the chat header
		// (`chat_metadata`/`user_name`) and every later element is a message. Reading it as `{chat: [...]}` is
		// the shape of a different route, and assuming it would have made the count below vacuous.
		var chatRecords []map[string]any
		if err := json.Unmarshal([]byte(body), &chatRecords); err != nil {
			t.Fatalf("POST /api/chats/get did not answer a chat record array: %v (%.300q)", err, body)
		}
		isHeader := func(record map[string]any) bool {
			_, hasMetadata := record["chat_metadata"]
			_, hasUserName := record["user_name"]
			return hasMetadata || hasUserName
		}
		messages := make([]map[string]any, 0, len(chatRecords))
		for _, record := range chatRecords {
			if !isHeader(record) {
				messages = append(messages, record)
			}
		}
		if len(messages) < longChat.Messages {
			t.Errorf("POST /api/chats/get returned %d of the %d planted messages, so the user's history is truncated",
				len(messages), longChat.Messages)
		}
		swiped := 0
		for _, message := range messages {
			if swipes, ok := message["swipes"].([]any); ok && len(swipes) >= 2 {
				swiped++
			}
		}
		if swiped == 0 {
			t.Error("no served message carries a swipes[] array, so the swipe/edit history a user had is not served")
		}

		// (3c) WORLD BOOKS: entries are served by name and the unknown/legacy carrier survives.
		world := manifest.Surfaces.Worlds[0]
		worldRequest, err := marshalJSON(map[string]any{"name": world.Name})
		if err != nil {
			t.Fatalf("encode the worldinfo/get body: %v", err)
		}
		status, _, body = client.postJSON(t, "/api/worldinfo/get", worldRequest)
		if status != http.StatusOK {
			t.Fatalf("POST /api/worldinfo/get = %d: %.300q", status, body)
		}
		var worldResponse struct {
			Entries map[string]map[string]any `json:"entries"`
		}
		if err := json.Unmarshal([]byte(body), &worldResponse); err != nil {
			t.Fatalf("POST /api/worldinfo/get did not answer an entries map: %v (%.300q)", err, body)
		}
		if len(worldResponse.Entries) != world.Entries {
			t.Errorf("POST /api/worldinfo/get returned %d of the %d planted entries", len(worldResponse.Entries), world.Entries)
		}

		// (3d) SETTINGS: the active preset, the world list, themes/Quick Replies and the UNKNOWN keys a
		// long-lived install carries. Dropping an unknown key is AGENTS rule 11's defect; this is where a
		// fresh-install-only suite cannot look.
		status, _, body = client.postJSON(t, "/api/settings/get", "{}")
		if status != http.StatusOK {
			t.Fatalf("POST /api/settings/get = %d: %.300q", status, body)
		}
		// Pinned answers `settings` as the RAW FILE TEXT (src/endpoints/settings.js:219-297), not as a parsed
		// object: the frontend parses it. Assuming an object here would read a member that does not exist and
		// report a dropped key that was never in the response shape.
		var settingsResponse struct {
			Settings   string `json:"settings"`
			WorldNames []any  `json:"world_names"`
		}
		if err := json.Unmarshal([]byte(body), &settingsResponse); err != nil {
			t.Fatalf("POST /api/settings/get did not answer the pinned shape: %v (%.300q)", err, body)
		}
		var settings map[string]any
		if err := json.Unmarshal([]byte(settingsResponse.Settings), &settings); err != nil {
			t.Fatalf("the settings text answered by /api/settings/get is not JSON: %v", err)
		}
		if _, present := settings["longlived_legacy_state"]; !present {
			t.Error("the settings TEXT answered by /api/settings/get dropped the unknown key longlived_legacy_state (AGENTS 11)")
		}
		for _, preset := range manifest.Surfaces.Presets {
			if !strings.Contains(body, preset.Name) {
				t.Errorf("POST /api/settings/get does not carry the preset %q, so the user cannot select it", preset.Name)
			}
		}
		for _, plantedWorld := range manifest.Surfaces.Worlds {
			found := false
			for _, listed := range settingsResponse.WorldNames {
				if fmt.Sprint(listed) == plantedWorld.Name {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("POST /api/settings/get does not list the world %q", plantedWorld.Name)
			}
		}
		if !strings.Contains(body, "longlived_legacy_extension") {
			t.Error("POST /api/settings/get dropped the unknown extension_settings carrier longlived_legacy_extension")
		}

		// (3e) GROUPS: a group definition with its transcript is listed.
		status, _, body = client.postJSON(t, "/api/groups/all", "{}")
		if status != http.StatusOK {
			t.Fatalf("POST /api/groups/all = %d: %.300q", status, body)
		}
		for _, group := range manifest.Surfaces.Groups {
			if !strings.Contains(body, group.ID) {
				t.Errorf("POST /api/groups/all does not list %q, so a user's group chat is invisible", group.ID)
			}
		}

		// (3f) THE VISUAL/ASSET SURFACES the pinned frontend builds, on names with spaces/#/%/unicode, so URL
		// escaping and the static mounts are exercised by the corpus rather than by ASCII-only fixtures.
		first := manifest.Surfaces.Characters[0]
		avatarName := filepath.Base(first.Avatar)
		for _, probe := range []struct {
			name string
			path string
		}{
			{"character-image", "/characters/" + url.PathEscape(avatarName)},
			{"character-thumbnail", "/thumbnail?type=avatar&file=" + url.QueryEscape(avatarName)},
			{"persona-avatar", "/User%20Avatars/user-default.png"},
			{"background", "/backgrounds/" + url.PathEscape(manifest.Surfaces.Backgrounds[0].Name)},
			{"asset", "/assets/" + url.PathEscape(manifest.Surfaces.Assets[0].Name)},
		} {
			status, header, payload := client.get(t, probe.path)
			if status != http.StatusOK {
				t.Errorf("GET %s (%s) = %d, so a user-visible surface is missing: %.200q", probe.path, probe.name, status, payload)
				continue
			}
			if !strings.HasPrefix(header.Get("Content-Type"), "image/") {
				t.Errorf("GET %s (%s) answered Content-Type %q, not an image", probe.path, probe.name, header.Get("Content-Type"))
			}
		}
		status, _, body = client.postJSON(t, "/api/avatars/get", "{}")
		if status != http.StatusOK || !strings.Contains(body, "user-default.png") {
			t.Errorf("POST /api/avatars/get = %d and %s the planted persona: %.200q", status, map[bool]string{true: "listed", false: "did not list"}[strings.Contains(body, "user-default.png")], body)
		}
		status, _, body = client.postJSON(t, "/api/backgrounds/all", "{}")
		if status != http.StatusOK || !strings.Contains(body, manifest.Surfaces.Backgrounds[0].Name) {
			t.Errorf("POST /api/backgrounds/all = %d and did not list the planted background: %.200q", status, body)
		}

		// (4) NOTHING THE USER HAD WAS REWRITTEN OR DELETED. This runs LAST, after every route above, so a
		// "read" that migrated a file on the way out is caught too.
		after := digestTree(t, installRoot)
		plantedPaths := make([]string, 0, len(before))
		for relative := range before {
			plantedPaths = append(plantedPaths, relative)
		}
		sort.Strings(plantedPaths)
		for _, relative := range plantedPaths {
			digest, present := after[relative]
			if !present {
				t.Errorf("the boot deleted %s, which the user's tree contained before it started (AGENTS 28)", relative)
				continue
			}
			if digest != before[relative] {
				t.Errorf("the boot rewrote %s (%s -> %s), which is AGENTS 27's forbidden startup side effect", relative, before[relative][:12], digest[:12])
			}
		}
	})

	// (5) THE MANIFEST'S COUNTS ARE MEASUREMENTS. A manifest that counted lazily would let every assertion
	// above be satisfied by a smaller tree than the one the qualification claims.
	t.Run("manifest-counts-match-the-tree", func(t *testing.T) {
		if manifest.Tree.Files <= 0 || manifest.Tree.Bytes <= 0 {
			t.Fatalf("the manifest records %d files / %d bytes", manifest.Tree.Files, manifest.Tree.Bytes)
		}
		var counted int
		err := filepath.WalkDir(corpusRoot, func(current string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if !entry.IsDir() && entry.Name() != "manifest.json" {
				counted++
			}
			return nil
		})
		if err != nil {
			t.Fatalf("count the corpus tree: %v", err)
		}
		if counted != manifest.Tree.Files {
			t.Fatalf("the corpus holds %d files; the manifest claims %d", counted, manifest.Tree.Files)
		}
	})
}

// corpusVerdict is the JSON `tools/longlived/verify.mjs` prints: the loader's own named checks.
type corpusVerdict struct {
	OK     bool `json:"ok"`
	Checks []struct {
		Name   string `json:"name"`
		OK     bool   `json:"ok"`
		Detail any    `json:"detail"`
	} `json:"checks"`
}

func runCorpusVerifier(t *testing.T, root string) corpusVerdict {
	t.Helper()
	node := longLivedCorpusNode(t)
	verifier := filepath.Join(moduleRoot(t), "tools", "longlived", "verify.mjs")
	command := exec.Command(node, verifier, "--corpus", root)
	command.Dir = moduleRoot(t)
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	runErr := command.Run()
	line := lastJSONLine(stdout.String())
	if line == "" {
		t.Fatalf("the corpus verifier printed no JSON verdict (err=%v): %s", runErr, tailOf(stderr.String(), 2000))
	}
	var verdict corpusVerdict
	if err := json.Unmarshal([]byte(line), &verdict); err != nil {
		t.Fatalf("the corpus verifier's verdict does not decode: %v\n%s", err, line)
	}
	if runErr != nil && verdict.OK {
		t.Fatalf("the corpus verifier exited non-zero but its verdict says ok, so the exit status and the verdict disagree")
	}
	if runErr == nil && !verdict.OK {
		t.Fatalf("the corpus verifier exited zero but its verdict says not-ok, so the status and the verdict disagree")
	}
	return verdict
}
