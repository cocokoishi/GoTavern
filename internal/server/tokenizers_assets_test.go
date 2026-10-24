package server

// WHERE THE TOKENIZER TREE IS LOOKED FOR, AND WHY THE PINNED LOCATION IS ONE OF THE ANSWERS.
//
// Upstream reads these files SERVER-SIDE by a path relative to its own working directory --
// `new SentencePieceTokenizer('src/tokenizers/llama.model')` at src/endpoints/tokenizers.js:251-254 -- so a real
// SillyTavern tree keeps them at <root>/src/tokenizers/. GoTavern's own release puts the same files at
// <root>/tokenizers/. Both layouts have to resolve, because a MIGRATED installation (a SillyTavern directory
// GoTavern is pointed at) has only the first.
//
// THE FAILURE THIS PREVENTS IS SILENT. When no tree resolved, the routes did not error: they took the pinned
// Guesstimate fallback and kept answering with token counts that were simply wrong. A test that only checked "the
// candidate list contains src/tokenizers" would not prove the tree is reachable, so the second test below puts a
// REAL tokenizer file in that location and requires the loader to read it back.

import (
	"os"
	"path/filepath"
	"testing"
)

func TestTokenizerAssetCandidatesPreferTheReleaseTreeOverAMigratedOne(t *testing.T) {
	root := t.TempDir()
	release := filepath.Join(root, "tokenizers")
	migrated := filepath.Join(root, "src", "tokenizers")
	development := filepath.Join(root, "upstream", "tokenizers")
	for _, directory := range []string{release, migrated, development} {
		if err := os.MkdirAll(directory, 0o755); err != nil {
			t.Fatal(err)
		}
	}

	assets, ok := tokenizerAssets(HTTPHandlerOptions{InstallRoot: root})
	if !ok {
		t.Fatal("no tokenizer tree resolved even though all three layouts exist")
	}
	// The release tree wins so that upgrading an installation in place cannot be dragged backwards by leftover
	// files from the tree it replaced.
	if assets != release {
		t.Fatalf("resolved %q, want the release tree %q to take precedence", assets, release)
	}

	// Remove the release tree: the migrated layout must be next, not the development one.
	if err := os.RemoveAll(release); err != nil {
		t.Fatal(err)
	}
	assets, ok = tokenizerAssets(HTTPHandlerOptions{InstallRoot: root})
	if !ok || assets != migrated {
		t.Fatalf("with the release tree gone, resolved %q (ok=%t), want the pinned layout %q", assets, ok, migrated)
	}
}

func TestTokenizerAssetsFindsAMigratedSillyTavernTree(t *testing.T) {
	root := t.TempDir()
	migrated := filepath.Join(root, "src", "tokenizers")
	if err := os.MkdirAll(migrated, 0o755); err != nil {
		t.Fatal(err)
	}
	// A REAL file, copied from the vendored tree, so the loader below reads it through the resolved path rather
	// than the test merely observing that a directory was listed.
	source, err := os.ReadFile(filepath.Join("..", "..", "upstream", "tokenizers", "llama3.json"))
	if err != nil {
		t.Fatalf("read the vendored llama3.json: %v", err)
	}
	if err := os.WriteFile(filepath.Join(migrated, "llama3.json"), source, 0o644); err != nil {
		t.Fatal(err)
	}

	set, ok := openTokenizerSet(HTTPHandlerOptions{InstallRoot: root, DataRoot: t.TempDir()})
	if !ok {
		t.Fatal("a migrated SillyTavern layout (src/tokenizers only) did not resolve; this is the case where a " +
			"real installation would silently fall back to estimated token counts")
	}
	raw, err := set.webBytes("llama3")
	if err != nil {
		t.Fatalf("the loader could not read llama3.json from the migrated layout: %v", err)
	}
	if len(raw) != len(source) {
		t.Fatalf("read %d bytes from the migrated layout, want the %d bytes that were written", len(raw), len(source))
	}
}

func TestTokenizerAssetsReportsAnAbsentTreeRatherThanPretending(t *testing.T) {
	root := t.TempDir()
	if _, ok := tokenizerAssets(HTTPHandlerOptions{InstallRoot: root}); ok {
		t.Fatal("an empty install root resolved a tokenizer tree; the routes would then claim exact tokenization")
	}
	if _, ok := tokenizerAssets(HTTPHandlerOptions{InstallRoot: ""}); ok {
		t.Fatal("an unset install root resolved a tokenizer tree")
	}
}
