package longlivedfixture

import (
	"os"
	"path/filepath"
	"testing"
)

func buildInto(t *testing.T, spec Spec) (string, *Manifest) {
	t.Helper()
	root := t.TempDir()
	manifest, err := Build(root, spec)
	if err != nil {
		t.Fatalf("Build: %v", err)
	}
	return root, manifest
}

func TestBuildIsDeterministicForOneSeed(t *testing.T) {
	spec := DefaultSpec()
	spec.Characters = 4
	spec.Worlds = 2
	spec.BigWorld = 12
	spec.ChatBase = 8
	spec.ChatStep = 2
	firstRoot, first := buildInto(t, spec)
	secondRoot, second := buildInto(t, spec)
	if len(first.Files) != len(second.Files) {
		t.Fatalf("file counts differ: %d vs %d", len(first.Files), len(second.Files))
	}
	for relative, digest := range first.Files {
		if second.Files[relative] != digest {
			t.Fatalf("%s: digest %s != %s (the generator is not deterministic)", relative, digest, second.Files[relative])
		}
		firstBytes, err := os.ReadFile(filepath.Join(firstRoot, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		secondBytes, err := os.ReadFile(filepath.Join(secondRoot, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		if string(firstBytes) != string(secondBytes) {
			t.Fatalf("%s: bytes differ between two builds of the same seed", relative)
		}
	}
}

// TestBuildDeclaresWhatItPlanted keeps the manifest honest: the harness asserts against these counts, so a
// builder that silently stops writing chats or worlds must fail here first.
func TestBuildDeclaresWhatItPlanted(t *testing.T) {
	spec := DefaultSpec()
	spec.Characters = 6
	spec.Worlds = 3
	spec.BigWorld = 10
	spec.ChatBase = 6
	spec.ChatStep = 1
	root, manifest := buildInto(t, spec)

	if len(manifest.Characters) != spec.Characters {
		t.Fatalf("characters = %d, want %d", len(manifest.Characters), spec.Characters)
	}
	if len(manifest.Worlds) != spec.Worlds {
		t.Fatalf("worlds = %d, want %d", len(manifest.Worlds), spec.Worlds)
	}
	if manifest.Worlds[0].Entries != spec.BigWorld {
		t.Fatalf("biggest world has %d entries, want %d", manifest.Worlds[0].Entries, spec.BigWorld)
	}
	if len(manifest.Presets) != spec.Presets || len(manifest.TextPresets) != spec.Presets {
		t.Fatalf("presets = %d/%d, want %d each", len(manifest.Presets), len(manifest.TextPresets), spec.Presets)
	}
	if len(manifest.Chats) == 0 || len(manifest.Groups) != spec.Groups {
		t.Fatalf("chats=%d groups=%d, want chats>0 and %d groups", len(manifest.Chats), len(manifest.Groups), spec.Groups)
	}
	longest := 0
	for _, chat := range manifest.Chats {
		if chat.Messages > longest {
			longest = chat.Messages
		}
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(chat.Path))); err != nil {
			t.Fatalf("declared chat %s does not exist: %v", chat.Path, err)
		}
	}
	if longest < spec.ChatBase+spec.ChatStep*(spec.Characters-1) {
		t.Fatalf("longest chat has %d messages, want at least %d", longest, spec.ChatBase+spec.ChatStep*(spec.Characters-1))
	}
	if len(manifest.UnknownFiles) == 0 || len(manifest.LegacyAssets) == 0 {
		t.Fatalf("the fixture must carry unknown files and legacy migration assets")
	}
	for _, relative := range append(append([]string{}, manifest.UnknownFiles...), manifest.LegacyAssets...) {
		if _, err := os.Stat(filepath.Join(root, filepath.FromSlash(relative))); err != nil {
			t.Fatalf("declared file %s does not exist: %v", relative, err)
		}
	}
}

// TestEveryGeneratedTextFileIsSFW is the hard requirement: the default (very complex) instance is scanned
// file by file for adult/hate/gore markers and for URLs/handles, because the fixture is committed
// evidence and is uploaded as a CI artifact.
func TestEveryGeneratedTextFileIsSFW(t *testing.T) {
	spec := DefaultSpec()
	spec.Characters = 5
	spec.Worlds = 2
	spec.BigWorld = 8
	spec.ChatBase = 6
	spec.ChatStep = 1
	root, manifest := buildInto(t, spec)
	if err := CheckSFW(root, manifest); err != nil {
		t.Fatalf("the generated fixture is not SFW: %v", err)
	}
}

// TestSFWCheckHasTeeth proves the scan can fail: a file planted into a built tree with an adult marker and
// a file with an external URL both have to be reported. Without this, a green scan would only mean the
// regex never matched anything.
func TestSFWCheckHasTeeth(t *testing.T) {
	spec := DefaultSpec()
	spec.Characters = 2
	spec.Worlds = 1
	spec.BigWorld = 4
	spec.ChatBase = 4
	spec.ChatStep = 1
	root, manifest := buildInto(t, spec)

	markerPath := filepath.Join(root, "default-user", "planted-marker.json")
	if err := os.WriteFile(markerPath, []byte(`{"text":"NSFW material would be refused"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest.Files["default-user/planted-marker.json"] = "teeth"
	if err := CheckSFW(root, manifest); err == nil {
		t.Fatalf("CheckSFW accepted an adult marker")
	}
	delete(manifest.Files, "default-user/planted-marker.json")

	urlPath := filepath.Join(root, "default-user", "planted-url.json")
	if err := os.WriteFile(urlPath, []byte(`{"text":"see https://example.invalid/real-party"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	manifest.Files["default-user/planted-url.json"] = "teeth"
	if err := CheckSFW(root, manifest); err == nil {
		t.Fatalf("CheckSFW accepted an external URL")
	}
}
