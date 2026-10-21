package assetmanifest

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"path"
	"sort"
	"strings"
)

// Generate creates a deterministic SHA-256 manifest of every regular file below
// root. Paths in the result are relative to root and always use forward slashes.
func Generate(fsys fs.FS, root string) ([]byte, error) {
	entries := make(map[string]string)
	if err := fs.WalkDir(fsys, root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("%s: unsupported non-regular asset", name)
		}
		content, err := fs.ReadFile(fsys, name)
		if err != nil {
			return err
		}
		relative, err := relativePath(root, name)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(content)
		entries[relative] = hex.EncodeToString(digest[:])
		return nil
	}); err != nil {
		return nil, err
	}

	if len(entries) == 0 {
		return nil, fmt.Errorf("%s: no files found", root)
	}

	paths := make([]string, 0, len(entries))
	for name := range entries {
		paths = append(paths, name)
	}
	sort.Strings(paths)

	var output strings.Builder
	for _, name := range paths {
		fmt.Fprintf(&output, "%s  %s\n", entries[name], name)
	}
	return []byte(output.String()), nil
}

// Verify checks that manifest exactly describes all files below root, including
// file contents and the absence of unlisted files.
func Verify(fsys fs.FS, root, manifestName string) error {
	manifest, err := fs.ReadFile(fsys, manifestName)
	if err != nil {
		return err
	}
	return VerifyWithManifest(fsys, root, manifestName, manifest)
}

// VerifyWithManifest verifies a tree against a manifest BODY rather than against a file in the same
// filesystem. That split is needed because the shipped layout is not uniform: public, default and
// generated live in the embedded filesystem, while tokenizers is a DIRECTORY BESIDE THE BINARY
// (the tokenizer routes read it from <InstallRoot>/tokenizers), and only its manifest is embedded.
// Verification therefore has to hash the on-disk tree against the embedded manifest.
func VerifyWithManifest(fsys fs.FS, root, manifestName string, manifest []byte) error {
	expected := make(map[string]string)
	manifestText := strings.ReplaceAll(string(manifest), "\r\n", "\n")
	for lineNumber, line := range strings.Split(strings.TrimSuffix(manifestText, "\n"), "\n") {
		if line == "" {
			return fmt.Errorf("%s:%d: empty manifest line", manifestName, lineNumber+1)
		}
		fields := strings.SplitN(line, "  ", 2)
		if len(fields) != 2 || len(fields[0]) != sha256.Size*2 {
			return fmt.Errorf("%s:%d: expected SHA-256 and relative path", manifestName, lineNumber+1)
		}
		if _, err := hex.DecodeString(fields[0]); err != nil {
			return fmt.Errorf("%s:%d: invalid SHA-256: %w", manifestName, lineNumber+1, err)
		}
		name := path.Clean(fields[1])
		if name == "." || name == ".." || strings.HasPrefix(name, "../") || path.IsAbs(name) || name != fields[1] {
			return fmt.Errorf("%s:%d: invalid asset path %q", manifestName, lineNumber+1, fields[1])
		}
		if _, exists := expected[name]; exists {
			return fmt.Errorf("%s:%d: duplicate asset path %q", manifestName, lineNumber+1, name)
		}
		expected[name] = strings.ToLower(fields[0])
	}

	actual := make(map[string]string)
	if err := fs.WalkDir(fsys, root, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.IsDir() {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("%s: unsupported non-regular asset", name)
		}
		content, err := fs.ReadFile(fsys, name)
		if err != nil {
			return err
		}
		relative, err := relativePath(root, name)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(content)
		actual[relative] = hex.EncodeToString(digest[:])
		return nil
	}); err != nil {
		return err
	}

	if len(actual) != len(expected) {
		return fmt.Errorf("%s: manifest has %d entries but %s has %d files", manifestName, len(expected), root, len(actual))
	}
	for name, digest := range expected {
		actualDigest, exists := actual[name]
		if !exists {
			return fmt.Errorf("%s: listed file %q is missing from %s", manifestName, name, root)
		}
		if actualDigest != digest {
			return fmt.Errorf("%s: SHA-256 mismatch for %s/%s", manifestName, root, name)
		}
	}
	if len(expected) == 0 {
		return errors.New("manifest contains no files")
	}
	return nil
}

func relativePath(root, name string) (string, error) {
	cleanRoot := path.Clean(root)
	cleanName := path.Clean(name)
	if cleanRoot == "." {
		return strings.TrimPrefix(cleanName, "./"), nil
	}
	prefix := cleanRoot + "/"
	if !strings.HasPrefix(cleanName, prefix) {
		return "", fmt.Errorf("%q is outside manifest root %q", name, root)
	}
	return strings.TrimPrefix(cleanName, prefix), nil
}
