package assetmanifest

// VerifyWithManifest exists because the shipped layout is not uniform: public, default and
// generated live in the embedded filesystem, while tokenizers is a DIRECTORY BESIDE THE BINARY and
// only its manifest is embedded. It also closes a real defect: with tokenizers absent the tokenizer
// routes take the pinned fallback path and silently return guesstimate counts, so a broken install
// looked healthy. These tests pin the two directions that matter -- a complete tree passes, and a
// missing or altered file fails.

import (
	"strings"
	"testing"
	"testing/fstest"
)

// manifestFor builds the manifest with the production generator rather than with hand-written
// digests: a wrong constant in a test fixture is exactly the class of defect this project keeps
// finding, and it also pins that Generate and VerifyWithManifest agree on the format.
func manifestFor(t *testing.T, tree fstest.MapFS) []byte {
	t.Helper()
	manifest, err := Generate(tree, "tokenizers")
	if err != nil {
		t.Fatalf("generate manifest: %v", err)
	}
	return manifest
}
func tokenizerTree() fstest.MapFS {
	return fstest.MapFS{
		"tokenizers/claude.json": &fstest.MapFile{Data: []byte("hello")},
		"tokenizers/llama.json":  &fstest.MapFile{Data: []byte("foo")},
	}
}

func TestVerifyWithManifestAcceptsACompleteTree(t *testing.T) {
	if err := VerifyWithManifest(tokenizerTree(), "tokenizers", "manifests/tokenizers.sha256", manifestFor(t, tokenizerTree())); err != nil {
		t.Fatalf("complete tree rejected: %v", err)
	}
}

func TestVerifyWithManifestRejectsAMissingTree(t *testing.T) {
	// The defect this guards: no tokenizers directory at all. It must be an error, not an empty
	// success, because the routes would otherwise fall back to guesstimates.
	err := VerifyWithManifest(fstest.MapFS{}, "tokenizers", "manifests/tokenizers.sha256", manifestFor(t, tokenizerTree()))
	if err == nil {
		t.Fatal("an absent tokenizers tree was accepted")
	}
	if !strings.Contains(err.Error(), "missing") && !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("error should say the tree is missing, got: %v", err)
	}
}

func TestVerifyWithManifestRejectsAnAlteredFile(t *testing.T) {
	tree := tokenizerTree()
	tree["tokenizers/claude.json"] = &fstest.MapFile{Data: []byte("HELLO")}
	err := VerifyWithManifest(tree, "tokenizers", "manifests/tokenizers.sha256", manifestFor(t, tokenizerTree()))
	if err == nil {
		t.Fatal("an altered tokenizer file was accepted")
	}
	if !strings.Contains(err.Error(), "SHA-256 mismatch") {
		t.Fatalf("error should be a digest mismatch, got: %v", err)
	}
}

func TestVerifyWithManifestRejectsAnUnlistedFile(t *testing.T) {
	tree := tokenizerTree()
	tree["tokenizers/extra.json"] = &fstest.MapFile{Data: []byte("extra")}
	if err := VerifyWithManifest(tree, "tokenizers", "manifests/tokenizers.sha256", manifestFor(t, tokenizerTree())); err == nil {
		t.Fatal("an unlisted file in the tree was accepted")
	}
}
