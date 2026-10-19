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

	"github.com/cocokoishi/gotavern/internal/commandline"
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
	isolateSillyTavernEnvironment(t)
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
	parsed, err := commandline.ResolveCommandLine(commandline.ResolveOptions{
		Args:             []string{"--dataRoot", dataRoot, "--listen=false", "--enableIPv4", "true", "--enableIPv6", "false"},
		WorkingDirectory: installRoot,
		ServerDirectory:  installRoot,
	})
	if err != nil {
		t.Fatal(err)
	}
	if parsed.StartupSettings.UseDiskCache != true || parsed.StartupSettings.SettingsBackupRetention != float64(50) {
		t.Fatalf("fresh config startup settings = %+v", parsed.StartupSettings)
	}
	result, err := InitializeDataStartupFromCommandLine(installRoot, parsed, time.UnixMilli(1735689600000), func(time.Duration) {})
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

func isolateSillyTavernEnvironment(t *testing.T) {
	t.Helper()
	for _, entry := range os.Environ() {
		key, value, found := strings.Cut(entry, "=")
		if !found || !strings.HasPrefix(strings.ToUpper(key), "SILLYTAVERN_") {
			continue
		}
		if err := os.Unsetenv(key); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = os.Setenv(key, value) })
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

func TestInitializeDataStartupReadsSecurityUsersFromPinnedNodePersistRecords(t *testing.T) {
	var fixture struct {
		Scenarios map[string]struct {
			Inputs struct {
				Config struct {
					EnableUserAccounts any `json:"enableUserAccounts"`
					SecurityOverride   any `json:"securityOverride"`
					PerUserBasicAuth   any `json:"perUserBasicAuth"`
					BasicAuthUser      struct {
						Username any `json:"username"`
						Password any `json:"password"`
					} `json:"basicAuthUser"`
				} `json:"config"`
				Args struct {
					Listen        bool `json:"listen"`
					BasicAuthMode bool `json:"basicAuthMode"`
					WhitelistMode bool `json:"whitelistMode"`
				} `json:"args"`
			} `json:"inputs"`
			ExitCode       *int                    `json:"exitCode"`
			Events         []SecuritySettingsEvent `json:"events"`
			StorageRecords []struct {
				Filename string `json:"filename"`
				Body     string `json:"body"`
			} `json:"storageRecords"`
		} `json:"scenarios"`
	}
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-security-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	scenario := fixture.Scenarios["unprotectedAdminExits"]
	installRoot := filepath.Join(t.TempDir(), "install")
	dataRoot := filepath.Join(t.TempDir(), "data")
	storageDirectory := filepath.Join(dataRoot, storageFolder)
	if err := os.MkdirAll(storageDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	for _, record := range scenario.StorageRecords {
		if err := os.WriteFile(filepath.Join(storageDirectory, record.Filename), []byte(record.Body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	result, err := InitializeDataStartup(DataStartupOptions{
		InstallRoot: installRoot,
		DataRoot:    dataRoot,
		Security: SecuritySettingsInput{
			Listen:             scenario.Inputs.Args.Listen,
			BasicAuthMode:      scenario.Inputs.Args.BasicAuthMode,
			WhitelistMode:      scenario.Inputs.Args.WhitelistMode,
			EnableUserAccounts: scenario.Inputs.Config.EnableUserAccounts,
			SecurityOverride:   scenario.Inputs.Config.SecurityOverride,
			PerUserBasicAuth:   scenario.Inputs.Config.PerUserBasicAuth,
			BasicAuthUsername:  scenario.Inputs.Config.BasicAuthUser.Username,
			BasicAuthPassword:  scenario.Inputs.Config.BasicAuthUser.Password,
		},
		WaitBeforeLegacyDataMove: func(time.Duration) {},
	})
	var gate SecurityGateError
	if !errors.As(err, &gate) || result.Security.ExitCode == nil || *result.Security.ExitCode != *scenario.ExitCode {
		t.Fatalf("startup security gate error/result = %v / %+v, Node exit status = %v", err, result.Security, scenario.ExitCode)
	}
	if !reflect.DeepEqual(result.Security.Events, scenario.Events) {
		t.Fatalf("startup security events = %+v, Node has %+v", result.Security.Events, scenario.Events)
	}
}

func TestInitializeDataStartupFromCommandLineAppliesResolvedStartupSettings(t *testing.T) {
	isolateSillyTavernEnvironment(t)
	t.Setenv("SILLYTAVERN_COOKIESECRET", "environment-cookie-secret")
	installRoot := filepath.Join(t.TempDir(), "install")
	dataRoot := filepath.Join(t.TempDir(), "data")
	if err := os.MkdirAll(installRoot, 0o755); err != nil {
		t.Fatal(err)
	}
	config := "enableUserAccounts: false\nsecurityOverride: true\nwhitelistMode: false\nskipContentCheck: true\nperformance:\n  useDiskCache: false\nbackups:\n  common:\n    numberOfBackups: 2.5\n"
	if err := os.WriteFile(filepath.Join(installRoot, "config.yaml"), []byte(config), 0o644); err != nil {
		t.Fatal(err)
	}
	parsed, err := commandline.ResolveCommandLine(commandline.ResolveOptions{
		Args:             []string{"--dataRoot", dataRoot, "--listen"},
		WorkingDirectory: installRoot,
		ServerDirectory:  installRoot,
	})
	if err != nil {
		t.Fatal(err)
	}
	result, err := InitializeDataStartupFromCommandLine(installRoot, parsed, time.UnixMilli(1735689600000), func(time.Duration) {})
	if err != nil {
		t.Fatal(err)
	}
	if result.CookieSecret != "environment-cookie-secret" || !result.CookieSecretSource.Migrated {
		t.Fatalf("configured cookie secret migration = %+v, value %q", result.CookieSecretSource, result.CookieSecret)
	}
	if result.Security.ExitCode != nil || len(result.Security.Events) < 2 {
		t.Fatalf("configured security override did not continue startup: %+v", result.Security)
	}
	if result.Seed.AnyContentAdded {
		t.Fatal("skipContentCheck=true config unexpectedly seeded default content")
	}
	for _, path := range []string{
		filepath.Join(dataRoot, "content.log"),
		filepath.Join(dataRoot, "default-user", "content.log"),
		filepath.Join(dataRoot, "_cache", "characters"),
	} {
		if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("startup setting should leave %s absent, stat error = %v", path, err)
		}
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
