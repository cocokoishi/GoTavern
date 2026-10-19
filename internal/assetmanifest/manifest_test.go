package assetmanifest

import (
	"strings"
	"testing"
	"testing/fstest"
)

func TestGenerateVerifyAndRejectDrift(t *testing.T) {
	filesystem := fstest.MapFS{
		"public/app.js": {Data: []byte("pinned")},
	}
	manifest, err := Generate(filesystem, "public")
	if err != nil {
		t.Fatal(err)
	}
	filesystem["manifests/public.sha256"] = &fstest.MapFile{Data: manifest}

	if err := Verify(filesystem, "public", "manifests/public.sha256"); err != nil {
		t.Fatalf("valid manifest was rejected: %v", err)
	}
	filesystem["manifests/public.sha256"].Data = []byte(strings.ReplaceAll(string(manifest), "\n", "\r\n"))
	if err := Verify(filesystem, "public", "manifests/public.sha256"); err != nil {
		t.Fatalf("CRLF manifest was rejected: %v", err)
	}
	filesystem["manifests/public.sha256"].Data = manifest

	filesystem["public/app.js"].Data = []byte("changed")
	if err := Verify(filesystem, "public", "manifests/public.sha256"); err == nil {
		t.Fatal("changed asset passed manifest verification")
	}

	filesystem["public/app.js"].Data = []byte("pinned")
	filesystem["public/extra.js"] = &fstest.MapFile{Data: []byte("unlisted")}
	if err := Verify(filesystem, "public", "manifests/public.sha256"); err == nil {
		t.Fatal("unlisted asset passed manifest verification")
	}
}

func TestGenerateRejectsEmptyTree(t *testing.T) {
	if _, err := Generate(fstest.MapFS{}, "."); err == nil {
		t.Fatal("empty tree unexpectedly produced a manifest")
	}
}
