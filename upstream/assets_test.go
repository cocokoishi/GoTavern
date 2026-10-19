package upstream

import (
	"testing"

	"github.com/cocokoishi/gotavern/internal/assetmanifest"
)

func TestPinnedAssetManifests(t *testing.T) {
	tests := []struct {
		name     string
		root     string
		manifest string
	}{
		{name: "frontend source", root: "public", manifest: "manifests/public.sha256"},
		{name: "fresh install defaults", root: "default", manifest: "manifests/default.sha256"},
		{name: "generated frontend", root: "generated", manifest: "manifests/generated.sha256"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := assetmanifest.Verify(Assets, test.root, test.manifest); err != nil {
				t.Fatal(err)
			}
		})
	}
}
