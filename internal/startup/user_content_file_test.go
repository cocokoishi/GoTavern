package startup

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestUpdateUserContentFileIfChangedPreservesTargetWhenCallbackDeclines(t *testing.T) {
	dataRoot := t.TempDir()
	userRoot := filepath.Join(dataRoot, "default-user")
	if err := os.MkdirAll(userRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(userRoot, "image-metadata.json")
	const original = "{\"images\":{}}"
	if err := os.WriteFile(target, []byte(original), 0o600); err != nil {
		t.Fatal(err)
	}
	fixedTime := time.Date(2020, time.February, 3, 4, 5, 6, 0, time.UTC)
	if err := os.Chtimes(target, fixedTime, fixedTime); err != nil {
		t.Fatal(err)
	}
	before, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	if err := UpdateUserContentFileIfChanged(dataRoot, "default-user", "image-metadata.json", func(current []byte) ([]byte, bool, error) {
		if string(current) != original {
			t.Fatalf("conditional update input = %q; want %q", current, original)
		}
		return []byte("replacement"), false, nil
	}); err != nil {
		t.Fatal(err)
	}
	after, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	content, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(content) != original || !before.ModTime().Equal(after.ModTime()) {
		t.Fatalf("declined conditional update changed the target: content=%q before=%s after=%s", content, before.ModTime(), after.ModTime())
	}
}

func TestUpdateUserContentFileIfChangedCanLeaveMissingTargetAbsent(t *testing.T) {
	dataRoot := t.TempDir()
	if err := UpdateUserContentFileIfChanged(dataRoot, "default-user", "image-metadata.json", func(current []byte) ([]byte, bool, error) {
		if current != nil {
			t.Fatalf("missing file callback input = %q; want nil", current)
		}
		return []byte("unused"), false, nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "default-user", "image-metadata.json")); !os.IsNotExist(err) {
		t.Fatalf("declined update target stat error = %v; want not-exist", err)
	}
}
