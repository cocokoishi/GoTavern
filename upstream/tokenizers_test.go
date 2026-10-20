package upstream

import (
	"io/fs"
	"os"
	"testing"

	"github.com/cocokoishi/gotavern/internal/assetmanifest"
)

// TestPinnedTokenizerAssets verifies the on-disk tokenizer release assets against
// their manifest. The tree is deliberately not embedded, so this reads it from the
// package directory instead of Assets.
func TestPinnedTokenizerAssets(t *testing.T) {
	if err := assetmanifest.Verify(os.DirFS("."), "tokenizers", "manifests/tokenizers.sha256"); err != nil {
		t.Fatal(err)
	}
}

// TestTokenizerAssetsAreNotEmbedded guards the distribution decision: tokenizer data
// ships as release assets on disk, so the binary must not carry it.
func TestTokenizerAssetsAreNotEmbedded(t *testing.T) {
	// The embed FS is functional (it carries the manifest), so the absence check below
	// is meaningful rather than vacuous.
	if _, err := fs.Stat(Assets, "manifests/tokenizers.sha256"); err != nil {
		t.Fatalf("embed FS does not expose the tokenizer manifest: %v", err)
	}
	if _, err := fs.Stat(Assets, "tokenizers"); err == nil {
		t.Fatal("tokenizer data must not be embedded in the binary; ship it as a release asset")
	}
}
