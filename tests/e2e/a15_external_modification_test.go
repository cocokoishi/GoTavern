package e2e

// A15 LANE B: EXTERNAL MODIFICATION BEHIND A RUNNING SERVER (GOAL §15.3's cache contract).
//
// A user edits a preset with an editor while the server is running, or restores a backup that rewrites
// the file. The settings/world aggregations memoise their response body, validated by the identity rule
// `path + mtime + size` (internal/server/settings_cache.go). This test proves BOTH halves of the documented
// contract on a real boot:
//
//  1. a same-size rewrite with a NEW mtime is detected: the next /api/settings/get serves the new bytes
//     (so the cache does not hide a normal external edit);
//  2. the DOCUMENTED RESIDUAL is real and bounded: a same-size rewrite that also RESTORES the previous
//     mtime is indistinguishable from no change and the cached body is served until mtime or size moves.
//     That half is asserted as the documented boundary (settings_cache.go's "RESIDUAL STALENESS WINDOW"),
//     not as a pass: a product that claimed perfect freshness would fail here.
//
// The negative control is inside the case: the cache is warmed first and the same marker is required in
// the warmed response, so a route that never cached (or never read the file) cannot pass by accident.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// settingsBodyContains reports whether the settings aggregation names marker anywhere in its response.
func settingsBodyContains(body, marker string) bool {
	return strings.Contains(body, marker)
}

func TestExternalPresetEditInvalidatesTheSettingsCacheUnlessIdentityIsRestored(t *testing.T) {
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatalf("resolve the default user directories: %v", err)
	}
	presetDir := directories["openAI_Settings"]
	if err := os.MkdirAll(presetDir, 0o777); err != nil {
		t.Fatal(err)
	}
	presetPath := filepath.Join(presetDir, "ExternalEdit.json")

	// Same-length markers: the identity rule can only change through mtime when size is constant, which is
	// exactly the window this test is about.
	presetA := []byte(`{"preset":"EXTERNAL_MARKER_A","note":"same-length body for identity"}`)
	presetB := []byte(`{"preset":"EXTERNAL_MARKER_B","note":"same-length body for identity"}`)
	presetC := []byte(`{"preset":"EXTERNAL_MARKER_C","note":"same-length body for identity"}`)
	if len(presetA) != len(presetB) || len(presetB) != len(presetC) {
		t.Fatalf("the three presets must be the same length for this case: %d/%d/%d", len(presetA), len(presetB), len(presetC))
	}
	if err := os.WriteFile(presetPath, presetA, 0o600); err != nil {
		t.Fatal(err)
	}

	server := bootServerAt(t, installRoot, dataRoot, nil)
	client := openSession(t, server.origin)

	// WARM THE CACHE. The marker must be in the body, or the rest of the case has nothing to invalidate.
	status, _, warmed := client.postJSON(t, "/api/settings/get", "{}")
	if status != 200 {
		t.Fatalf("settings/get = %d: %s", status, truncateForLog(warmed, 300))
	}
	if !settingsBodyContains(warmed, "EXTERNAL_MARKER_A") {
		t.Fatalf("the warmed settings aggregation does not carry the on-disk preset marker, so the cache is not "+
			"reading the file this case edits:\n%s", truncateForLog(warmed, 500))
	}

	// (1) SAME SIZE, NEW MTIME: an ordinary external edit must be visible on the next request.
	beforeInfo, err := os.Stat(presetPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(presetPath, presetB, 0o600); err != nil {
		t.Fatal(err)
	}
	// Make the mtime move by a whole second: NTFS and some CI filesystems have coarse timestamp resolution,
	// and a sub-resolution edit would test the filesystem's clock rather than the cache.
	changedMtime := beforeInfo.ModTime().Add(2 * time.Second)
	if err := os.Chtimes(presetPath, changedMtime, changedMtime); err != nil {
		t.Fatalf("set the edited preset's mtime: %v", err)
	}
	status, _, afterEdit := client.postJSON(t, "/api/settings/get", "{}")
	if status != 200 {
		t.Fatalf("settings/get after the external edit = %d: %s", status, truncateForLog(afterEdit, 300))
	}
	if !settingsBodyContains(afterEdit, "EXTERNAL_MARKER_B") {
		t.Fatalf("a same-size external edit with a NEW mtime was NOT visible through settings/get; the cache served "+
			"the old body (the identity rule is mtime+size, so a new mtime must miss):\n%s", truncateForLog(afterEdit, 500))
	}
	if settingsBodyContains(afterEdit, "EXTERNAL_MARKER_A") {
		t.Fatalf("settings/get after the edit still carries the OLD preset marker:\n%s", truncateForLog(afterEdit, 500))
	}

	// (2) THE DOCUMENTED RESIDUAL: same size AND the previous mtime restored. The identity is unchanged, so
	// the documented behaviour is to serve the cached body. Asserting this is what keeps the residual from
	// being silently mistaken for freshness; the test WOULD fail if a later change claimed perfect
	// invalidation without adding content hashing.
	if err := os.WriteFile(presetPath, presetC, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(presetPath, changedMtime, changedMtime); err != nil {
		t.Fatalf("restore the preset's previous mtime: %v", err)
	}
	status, _, afterBackdated := client.postJSON(t, "/api/settings/get", "{}")
	if status != 200 {
		t.Fatalf("settings/get after the backdated edit = %d: %s", status, truncateForLog(afterBackdated, 300))
	}
	if !settingsBodyContains(afterBackdated, "EXTERNAL_MARKER_B") {
		t.Fatalf("the documented residual changed: after a same-size edit with the SAME mtime the cache no longer "+
			"serves the previous body. Either the identity rule changed (update settings_cache.go's residual "+
			"section and this assertion together) or the cache is now hashing content:\n%s",
			truncateForLog(afterBackdated, 500))
	}
	if settingsBodyContains(afterBackdated, "EXTERNAL_MARKER_C") {
		t.Fatalf("the backdated edit WAS observed, contradicting the documented mtime+size residual")
	}

	// AND THE RESIDUAL IS BOUNDED: a later edit that moves mtime is seen, so staleness does not persist once
	// the file's identity changes again.
	if err := os.Chtimes(presetPath, changedMtime.Add(2*time.Second), changedMtime.Add(2*time.Second)); err != nil {
		t.Fatalf("move the preset mtime after the residual: %v", err)
	}
	status, _, afterMove := client.postJSON(t, "/api/settings/get", "{}")
	if status != 200 {
		t.Fatalf("settings/get after the mtime moved = %d: %s", status, truncateForLog(afterMove, 300))
	}
	if !settingsBodyContains(afterMove, "EXTERNAL_MARKER_C") {
		t.Fatalf("the residual did not clear after mtime moved again; the cache is stuck on the stale body:\n%s",
			truncateForLog(afterMove, 500))
	}
}
