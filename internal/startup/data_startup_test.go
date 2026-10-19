package startup

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"
)

type freshStartInventoryFixture struct {
	Filesystem struct {
		DataRoot []startupInventoryEntry `json:"dataRoot"`
	} `json:"filesystem"`
}

type startupInventoryEntry struct {
	Path       string `json:"path"`
	Type       string `json:"type"`
	Bytes      int64  `json:"bytes,omitempty"`
	SHA256     string `json:"sha256,omitempty"`
	Normalized string `json:"normalized,omitempty"`
}

func TestInitializeDataStartupMatchesPinnedNodeFreshStartInventory(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-fresh-start.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture freshStartInventoryFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}

	installRoot := filepath.Join(t.TempDir(), "install")
	dataRoot := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(installRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dataRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	result, err := InitializeDataStartup(DataStartupOptions{
		InstallRoot:             installRoot,
		DataRoot:                dataRoot,
		CharacterDiskCache:      true,
		SettingsBackupRetention: 50,
		Now:                     time.UnixMilli(1735689600000),
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.CookieSecretSource.Generated || len(result.CookieSecret) != 88 {
		t.Fatalf("fresh startup cookie secret = source %+v, length %d; want generated 88-byte base64", result.CookieSecretSource, len(result.CookieSecret))
	}
	if len(result.Handles) != 1 || result.Handles[0] != defaultHandle {
		t.Fatalf("fresh startup handles = %v, want [%s]", result.Handles, defaultHandle)
	}
	if len(result.Diagnostics) != 0 {
		t.Fatalf("fresh startup reported caught errors: %+v", result.Diagnostics)
	}

	want := make([]startupInventoryEntry, 0, len(fixture.Filesystem.DataRoot))
	for _, entry := range fixture.Filesystem.DataRoot {
		// Webpack's disk cache is produced by the Node middleware compiler,
		// which is outside this data-startup chain.
		if entry.Path == "_webpack" || strings.HasPrefix(entry.Path, "_webpack/") {
			continue
		}
		want = append(want, entry)
	}
	sortStartupInventory(want)
	got, err := snapshotStartupDataRoot(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	sortStartupInventory(got)
	if !reflect.DeepEqual(got, want) {
		for index := 0; index < min(len(got), len(want)); index++ {
			if !reflect.DeepEqual(got[index], want[index]) {
				t.Fatalf("startup inventory entry %d differs:\n got: %+v\nwant: %+v", index, got[index], want[index])
			}
		}
		t.Fatalf("startup inventory has %d entries; pinned Node has %d", len(got), len(want))
	}
}

func sortStartupInventory(entries []startupInventoryEntry) {
	sort.Slice(entries, func(left, right int) bool {
		leftPath := strings.ToLower(entries[left].Path)
		rightPath := strings.ToLower(entries[right].Path)
		if leftPath == rightPath {
			return entries[left].Path < entries[right].Path
		}
		return leftPath < rightPath
	})
}

func TestInitializeDataStartupStopsAtPinnedSecurityGate(t *testing.T) {
	installRoot := filepath.Join(t.TempDir(), "install")
	dataRoot := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(installRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(dataRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	result, err := InitializeDataStartup(DataStartupOptions{
		InstallRoot: installRoot,
		DataRoot:    dataRoot,
		Security: SecuritySettingsInput{
			Listen:             true,
			EnableUserAccounts: false,
		},
	})
	var gate SecurityGateError
	if !errors.As(err, &gate) || gate.ExitCode != 1 {
		t.Fatalf("startup error = %v, want security exit status 1", err)
	}
	if len(result.Directories) != 1 || len(result.Security.Events) == 0 {
		t.Fatalf("startup did not complete pre-security work before stopping: %+v", result)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "default-user", "stats.json")); !errors.Is(err, fs.ErrNotExist) {
		t.Fatalf("startup continued past the security gate and initialized stats: %v", err)
	}
}

func snapshotStartupDataRoot(root string) ([]startupInventoryEntry, error) {
	entries := make([]startupInventoryEntry, 0)
	err := filepath.WalkDir(root, func(current string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		if relative == "." {
			return nil
		}
		name := filepath.ToSlash(relative)
		info, err := entry.Info()
		if err != nil {
			return err
		}
		item := startupInventoryEntry{Path: name}
		if info.IsDir() {
			item.Type = "directory"
			entries = append(entries, item)
			return nil
		}
		if !info.Mode().IsRegular() {
			return fmt.Errorf("unsupported startup data entry %s: %s", name, info.Mode().Type())
		}
		body, err := os.ReadFile(current)
		if err != nil {
			return err
		}
		item.Type = "file"
		item.Bytes = int64(len(body))
		digest := sha256.Sum256(body)
		item.SHA256 = hex.EncodeToString(digest[:])
		switch name {
		case "cookie-secret.txt":
			item.Normalized = "generated secret value omitted"
			item.SHA256 = ""
		case "_storage/3a5bb37ab86ac047d8ef481ee2e7bd3683d694ff8502a7cfe6951af849015dcc":
			item.Normalized = "account-store bytes can contain generated timestamps"
			item.SHA256 = ""
		case "default-user/stats.json":
			item.Normalized = "startup statistics are time-dependent"
			item.SHA256 = ""
		default:
			if strings.HasPrefix(name, "default-user/backups/settings_default-user_") && strings.HasSuffix(name, ".json") {
				item.Path = "default-user/backups/settings_default-user_<timestamp>.json"
			}
		}
		entries = append(entries, item)
		return nil
	})
	if err != nil {
		return nil, err
	}
	return entries, nil
}
