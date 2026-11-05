package e2e

// A15 LANE B: STARTUP-CREATED DATA-ROOT IDENTITY WITH AWKWARD PATHS.
//
// GOAL §14 item 5's twin question: the directory the boot CREATES must be the one every later write uses.
// The existing startup tests cover a foreign CWD, a relative config value and an absolute --dataRoot. This
// case covers the paths a real user actually names on Windows and Linux -- spaces, non-ASCII, emoji -- and
// proves identity by CONTENT: a product write lands under the named root, and the launch/install directory
// receives nothing but the fresh config.
//
// It also covers a SYMLINKED data root where the platform can create one (Linux CI; a Windows host without
// Developer Mode refuses os.Symlink, and that refusal is reported as a declared skip rather than passing
// silently).

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// windowedDirName is the directory a user might literally type: spaces, CJK and an emoji, all valid on
// NTFS and ext4.
const windowedDirName = "数据 root 🚀 subdir"

// TestDataRootWithSpacesUnicodeAndEmojiIsCreatedAndServed names the data root with characters outside
// ASCII and requires the boot to create it, serve it, and write through it.
func TestDataRootWithSpacesUnicodeAndEmojiIsCreatedAndServed(t *testing.T) {
	installRoot := t.TempDir()
	namedRoot := filepath.Join(t.TempDir(), windowedDirName)

	server := bootServerIn(t, installRoot, installRoot, namedRoot, nil)
	client := openSession(t, server.origin)

	// (1) THE NAMED ROOT EXISTS AND IS THE ONE THE SERVER USES.
	info, err := os.Stat(namedRoot)
	if err != nil || !info.IsDir() {
		t.Fatalf("the boot did not create the --dataRoot it was given (%q): %v\n%s", namedRoot, err, server.diagnostic())
	}
	if filepath.Clean(server.dataRoot) != filepath.Clean(namedRoot) {
		t.Fatalf("the harness recorded %q but the boot resolved %q", namedRoot, server.dataRoot)
	}

	// (2) A PRODUCT WRITE LANDS UNDER IT. settings/save is the frontend autosave path.
	settingsBody := `{"marker":"UNICODE-PATH-MARKER"}`
	if status, _, body := client.postJSON(t, "/api/settings/save", settingsBody); status != 200 {
		t.Fatalf("settings/save on the awkward data root = %d: %s", status, truncateForLog(body, 300))
	}
	settingsPath := filepath.Join(namedRoot, "default-user", "settings.json")
	onDisk, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatalf("the write did not land under the named data root (%q): %v", settingsPath, err)
	}
	if !strings.Contains(string(onDisk), "UNICODE-PATH-MARKER") {
		t.Fatalf("settings.json under the named root does not carry the marker: %s", truncateForLog(string(onDisk), 300))
	}

	// (3) THE LAUNCH/INSTALL DIRECTORY RECEIVES NOTHING BUT THE FRESH CONFIG. A second data tree created
	// where the user launched is the failure this identity check exists for.
	binaryName := "gotavern"
	if runtime.GOOS == "windows" {
		binaryName += ".exe"
	}
	for _, name := range sortedNames(treeDigests(t, installRoot)) {
		if name != "config.yaml" && name != binaryName {
			t.Fatalf("the boot left %q in the launch directory %s; only the shipped binary and the default config.yaml may appear there",
				name, installRoot)
		}
	}
}

// TestConfigPathWithSpacesUnicodeAndEmojiIsHonoured names the CONFIG file with the same awkward characters
// and requires the document named there -- not a default beside the binary -- to decide the data root.
func TestConfigPathWithSpacesUnicodeAndEmojiIsHonoured(t *testing.T) {
	installRoot := t.TempDir()
	foreignWork := t.TempDir()
	configPath := filepath.Join(foreignWork, "配置 file.yaml")
	document := "listen: false\nport: 8000\ndataRoot: \"./data-unicode\"\n"
	if err := os.WriteFile(configPath, []byte(document), 0o600); err != nil {
		t.Fatalf("plant the awkward config path: %v", err)
	}

	server := bootServerConfigIn(t, installRoot, foreignWork, configPath, nil)
	client := openSession(t, server.origin)

	// The relative dataRoot in that document resolves against the INSTALL root (the runtime base). The
	// harness does not predict this value for bootServerConfigIn (by design), so the identity is proven by
	// the FILES: the expected tree must exist and the product write must land in it.
	expectedRoot := filepath.Join(installRoot, "data-unicode")
	if info, err := os.Stat(expectedRoot); err != nil || !info.IsDir() {
		t.Fatalf("the config's relative dataRoot did not resolve to %q and exist: %v\n%s", expectedRoot, err, server.diagnostic())
	}
	status, _, body := client.postJSON(t, "/api/settings/save", `{"marker":"AWKWARD-CONFIG"}`)
	if status != 200 {
		t.Fatalf("settings/save with the awkward config path = %d: %s", status, truncateForLog(body, 300))
	}
	onDisk, err := os.ReadFile(filepath.Join(expectedRoot, "default-user", "settings.json"))
	if err != nil || !strings.Contains(string(onDisk), "AWKWARD-CONFIG") {
		t.Fatalf("the write did not land under the config's resolved data root (%q): %v (%s)",
			filepath.Join(expectedRoot, "default-user", "settings.json"), err, truncateForLog(string(onDisk), 200))
	}
}

// TestSymlinkedDataRootServesAndWritesThroughTheLink covers a symlinked data root. `os.Symlink` needs
// Developer Mode or elevation on Windows; the refusal is a DECLARED skip and the case runs on Linux CI.
func TestSymlinkedDataRootServesAndWritesThroughTheLink(t *testing.T) {
	installRoot := t.TempDir()
	realRoot := filepath.Join(t.TempDir(), "real-data")
	if err := os.MkdirAll(realRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	linkRoot := filepath.Join(t.TempDir(), "linked-data")
	if err := os.Symlink(realRoot, linkRoot); err != nil {
		t.Skipf("this host cannot create symlinks (%v on %s), so the symlinked-dataRoot case runs on Linux CI only; "+
			"it is a declared skip rather than a pass", err, runtime.GOOS)
	}

	server := bootServerIn(t, installRoot, installRoot, linkRoot, nil)
	client := openSession(t, server.origin)
	if status, _, body := client.postJSON(t, "/api/settings/save", `{"marker":"SYMLINK-ROOT"}`); status != 200 {
		t.Fatalf("settings/save through a symlinked data root = %d: %s", status, truncateForLog(body, 300))
	}
	// The write must be visible through BOTH the link and the real directory: they are one tree.
	throughLink, err := os.ReadFile(filepath.Join(linkRoot, "default-user", "settings.json"))
	if err != nil {
		t.Fatalf("read settings through the symlink: %v", err)
	}
	throughReal, err := os.ReadFile(filepath.Join(realRoot, "default-user", "settings.json"))
	if err != nil {
		t.Fatalf("read settings through the real directory: %v", err)
	}
	if string(throughLink) != string(throughReal) || !strings.Contains(string(throughReal), "SYMLINK-ROOT") {
		t.Fatalf("the symlinked data root is not one tree with its target: link=%q real=%q",
			truncateForLog(string(throughLink), 160), truncateForLog(string(throughReal), 160))
	}
}
