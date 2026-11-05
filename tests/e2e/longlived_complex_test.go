package e2e

// THE COMPLEX LONG-LIVED QUALIFICATION (the new long-term goal).
//
// tests/e2e/longlived_test.go proves a hand-built single-character tree boots and serves its assets. This
// file drives the far larger, deterministic instance from internal/longlivedfixture: 32 PNG cards (v2 and
// v3 metadata, non-ASCII/emoji filenames), 39 year-spanning chats with branches/swipes, 8 world books
// (the largest 400 entries), 8 presets, 3 group chats, themes, quick replies, personas, backgrounds,
// extension state, legacy migration input and files the product must not touch.
//
// The contract is the same one the user cares about: after GoTavern boots against this tree,
//   (1) EVERY byte the builder planted is still there and unchanged (AGENTS.md 27/28), and
//   (2) the frontend's own routes return the cards, chats, worlds, presets, groups and assets that were
//       planted -- preserving files on disk while serving nothing is the failure this asserts against.
//
// A full run uses the default (very complex) spec; `-short` uses the small variant through the same code
// path. The fixture is synthetic and strictly SFW by construction (internal/longlivedfixture/sfw.go).

import (
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/longlivedfixture"
)

func complexSpec(t *testing.T) longlivedfixture.Spec {
	t.Helper()
	if testing.Short() {
		spec := longlivedfixture.DefaultSpec()
		spec.Characters = 4
		spec.Worlds = 2
		spec.BigWorld = 12
		spec.ChatBase = 8
		spec.ChatStep = 2
		return spec
	}
	return longlivedfixture.DefaultSpec()
}

func TestComplexLongLivedInstanceQualifiesAsDropIn(t *testing.T) {
	spec := complexSpec(t)
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	if err := os.MkdirAll(dataRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	manifest, err := longlivedfixture.Build(dataRoot, spec)
	if err != nil {
		t.Fatalf("build the complex instance: %v", err)
	}
	t.Logf("fixture: %d files, %d characters, %d chats, %d worlds (largest %d entries)",
		len(manifest.Files), len(manifest.Characters), len(manifest.Chats), len(manifest.Worlds), manifest.Worlds[0].Entries)

	// (1) the builder's own declaration matches the tree it wrote; if not, the fixture is the suspect.
	declared := make([]string, 0, len(manifest.Files))
	for relative := range manifest.Files {
		declared = append(declared, relative)
	}
	sort.Strings(declared)
	for _, relative := range declared {
		body, readErr := os.ReadFile(filepath.Join(dataRoot, filepath.FromSlash(relative)))
		if readErr != nil {
			t.Fatalf("the manifest declares %s but the build did not write it: %v", relative, readErr)
		}
		if sha256Hex(string(body)) != manifest.Files[relative] {
			t.Fatalf("the manifest digest for %s does not match the bytes on disk", relative)
		}
	}

	server := bootServerAt(t, installRoot, dataRoot, nil)
	client := openSession(t, server.origin)

	// (2) DATA SAFETY: every planted file is byte-identical after the boot. A rewrite here is the defect
	// AGENTS.md 27 exists for, and a deletion is the one rule 28 forbids outright.
	for _, relative := range declared {
		body, readErr := os.ReadFile(filepath.Join(dataRoot, filepath.FromSlash(relative)))
		if readErr != nil {
			t.Errorf("the boot removed %s, which the user's tree contained before it started (AGENTS.md 28): %v", relative, readErr)
			continue
		}
		if digest := sha256Hex(string(body)); digest != manifest.Files[relative] {
			// ONE DECLARED MUTATION: pinned SillyTavern migrates a legacy flat secrets.json to the v2
			// shape at startup (`migrateSecrets` in src/endpoints/secrets.js). That rewrite is startup
			// behaviour the drop-in must reproduce, so it is allowed ONLY when the migrated document
			// still carries the planted value and records the migration; any other rewrite is a defect.
			if relative == "default-user/secrets.json" {
				if !strings.Contains(string(body), "synthetic-secret-value-not-real") || !strings.Contains(string(body), "_migrated") {
					t.Errorf("the boot rewrote secrets.json and the result no longer carries the planted value or _migrated: %.300q", body)
				} else {
					t.Logf("secrets.json migrated to the pinned v2 shape at startup (declared mutation, value preserved)")
				}
				continue
			}
			t.Errorf("the boot rewrote %s (AGENTS.md 27): %s became %s", relative, manifest.Files[relative][:12], digest[:12])
		}
	}

	// (3) the frontend's own routes serve what was planted. Every avatar in the list is an image the
	// character picker renders; a landing-page green with a missing card is the defect class of rules 42-46.
	status, _, body := client.postJSON(t, "/api/characters/all", "{}")
	if status != http.StatusOK {
		t.Fatalf("POST /api/characters/all = %d: %.200q", status, body)
	}
	for _, character := range manifest.Characters {
		if !strings.Contains(body, character.Avatar) {
			t.Errorf("POST /api/characters/all does not list %s, so a user's card is invisible", character.Avatar)
		}
	}
	first := manifest.Characters[0]
	status, header, body := client.get(t, "/characters/"+first.Avatar)
	if status != http.StatusOK {
		t.Fatalf("GET /characters/%s = %d: %.160q", first.Avatar, status, body)
	}
	if !strings.HasPrefix(header.Get("Content-Type"), "image/png") {
		t.Errorf("GET /characters/%s answered Content-Type %q", first.Avatar, header.Get("Content-Type"))
	}
	if digest := sha256Hex(body); digest != manifest.Files["default-user/characters/"+first.Avatar] {
		t.Errorf("GET /characters/%s served %s, the planted card is %s", first.Avatar, digest[:12], manifest.Files["default-user/characters/"+first.Avatar][:12])
	}
	status, header, body = client.get(t, "/thumbnail?type=avatar&file="+first.Avatar)
	if status != http.StatusOK {
		t.Fatalf("GET /thumbnail?type=avatar&file=%s = %d: every avatar in the list would be broken", first.Avatar, status)
	}
	if !strings.HasPrefix(header.Get("Content-Type"), "image/") {
		t.Errorf("/thumbnail answered Content-Type %q", header.Get("Content-Type"))
	}

	// (4) an existing chat opens, with its history. The path is the pinned one:
	// chats/<avatar without .png>/<file name>.jsonl.
	chat := manifest.Chats[0]
	parts := strings.Split(strings.TrimSuffix(chat.Path, "/"+filepath.Base(chat.Path)), "/")
	avatar := parts[len(parts)-1] + ".png"
	fileName := strings.TrimSuffix(filepath.Base(chat.Path), ".jsonl")
	chatRequest, err := marshalJSON(map[string]any{"avatar_url": avatar, "file_name": fileName})
	if err != nil {
		t.Fatal(err)
	}
	status, _, body = client.postJSON(t, "/api/chats/get", chatRequest)
	if status != http.StatusOK {
		t.Fatalf("POST /api/chats/get for %s = %d: %.200q", chat.Path, status, body)
	}
	// The builder writes message texts as CHAT_<salt>_<n>; the salt is the character index, so a served
	// history must carry the first and a late marker from the SAME chat.
	// The first message is an assistant message with swipes, so its text is the current swipe; the second
	// message is the user's line. Both have to be served for the history to be the history.
	if !strings.Contains(body, "SWIPE_0_0_0") {
		t.Errorf("POST /api/chats/get did not serve the first (swipe-bearing) message of %s", chat.Path)
	}
	if !strings.Contains(body, "CHAT_0_1 ") {
		t.Errorf("POST /api/chats/get did not serve the second message of %s, so the user's history does not open", chat.Path)
	}
	lateMarker := "CHAT_0_" + itoa(chat.Messages-1) + " "
	if !strings.Contains(body, lateMarker) {
		t.Errorf("POST /api/chats/get did not serve the LAST message (%s) of a %d-message chat", lateMarker, chat.Messages)
	}
	if manifest.Chats[0].Swipes == 0 {
		t.Errorf("the builder planted no swipes in %s, so the swipe assertion would be vacuous", chat.Path)
	}
	for _, swipeAlternate := range []string{"SWIPE_0_0_0", "SWIPE_0_0_2"} {
		if !strings.Contains(body, swipeAlternate) {
			t.Errorf("POST /api/chats/get did not carry the swipes (%s) the chat file declares", swipeAlternate)
		}
	}

	// (5) the largest world book comes back complete, including the entries with regex/secondary keys.
	worldRequest, err := marshalJSON(map[string]any{"name": "World_00"})
	if err != nil {
		t.Fatal(err)
	}
	status, _, body = client.postJSON(t, "/api/worldinfo/get", worldRequest)
	if status != http.StatusOK {
		t.Fatalf("POST /api/worldinfo/get = %d: %.200q", status, body)
	}
	occurrences := strings.Count(body, "WI_CONTENT_0_")
	if occurrences != manifest.Worlds[0].Entries {
		t.Errorf("POST /api/worldinfo/get returned %d of the %d planted entries of the largest world; body starts: %.400q", occurrences, manifest.Worlds[0].Entries, body)
	}
	status, _, body = client.postJSON(t, "/api/worldinfo/list", "{}")
	if status != http.StatusOK || !strings.Contains(body, "World_00") {
		t.Errorf("POST /api/worldinfo/list = %d and does not name World_00: the world list is empty", status)
	}

	// (6) settings carry the preset, theme, persona and extension state a long-lived tree has.
	status, _, body = client.postJSON(t, "/api/settings/get", "{}")
	if status != http.StatusOK {
		t.Fatalf("POST /api/settings/get = %d: %.200q", status, body)
	}
	for _, expected := range []string{manifest.Presets[0], manifest.Themes[0], manifest.Personas[0], "synthetic-extension", "another-extension"} {
		if !strings.Contains(body, expected) {
			t.Errorf("POST /api/settings/get did not carry %q, so the frontend cannot restore what the user had", expected)
		}
	}

	// (7) groups, quick replies, themes and backgrounds: the surfaces the frontend lists on load.
	status, _, body = client.postJSON(t, "/api/groups/all", "{}")
	if status != http.StatusOK || !strings.Contains(body, manifest.Groups[0].Name) {
		t.Errorf("POST /api/groups/all = %d and does not name %q", status, manifest.Groups[0].Name)
	}
	status, _, body = client.postJSON(t, "/api/backgrounds/all", "{}")
	if status != http.StatusOK {
		t.Fatalf("POST /api/backgrounds/all = %d", status)
	}
	for _, background := range manifest.Backgrounds {
		if !strings.Contains(body, background) {
			t.Errorf("POST /api/backgrounds/all does not list %s", background)
		}
	}
	status, header, body = client.get(t, "/backgrounds/"+manifest.Backgrounds[0])
	if status != http.StatusOK || !strings.HasPrefix(header.Get("Content-Type"), "image/") {
		t.Errorf("GET /backgrounds/%s = %d (%s): the user's background cannot be shown", manifest.Backgrounds[0], status, header.Get("Content-Type"))
	}

	// (8) the files the product has no opinion about are still exactly where they were, byte for byte.
	for _, relative := range manifest.UnknownFiles {
		body, readErr := os.ReadFile(filepath.Join(dataRoot, filepath.FromSlash(relative)))
		if readErr != nil {
			t.Errorf("the boot removed the unknown file %s: %v", relative, readErr)
			continue
		}
		if sha256Hex(string(body)) != manifest.Files[relative] {
			t.Errorf("the boot rewrote the unknown file %s", relative)
		}
	}
}
