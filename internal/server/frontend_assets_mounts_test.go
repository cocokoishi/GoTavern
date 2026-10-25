package server

// THE INVENTORY GATE FOR THE USER-DATA STATIC MOUNTS (AGENTS.md 42/43).
//
// Why this test exists: `internal/server/frontend_assets.go` served THREE of the SEVEN user-data trees
// pinned mounts at src/users.js:1213-1219, and nothing failed for a year. The URLs that were missing
// are the ones the stock frontend uses for a character's full-size avatar, its sprites and its live2d
// (`/characters/<file>.png`), for User Avatars and for the assets tree -- so a real user saw broken
// images while every fixture was green. Fixtures can only cover the URLs their scenarios request; the
// obligation is to serve the URLs the pinned frontend BUILDS, which means the inventory has to come
// from the oracle and be diffed against the Go registrations. This file is that diff.
//
// PROVENANCE (AGENTS.md 4): the seven rows below are ORACLE-DERIVED -- transcribed from the pinned
// `router.use(...)` declarations, and re-read from the checkout whenever it is present. The MAPPING of
// each row onto a GoTavern registration (a `userDataMounts` directory key, or the frontend static
// path for the extension tree) is a DERIVATION, and it is the part a human has to keep honest.
//
// It REFUSES rather than passing vacuously: an empty inventory, a row with no registration, or a row
// whose registered pattern is not the decoded form of the pinned mount is a failure with the row named.

import (
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type pinnedUserDataMount struct {
	// pinnedMount is the literal first argument of the pinned router.use, including the trailing /*.
	pinnedMount string
	// pinnedLine is where it appears in pinned src/users.js at 06bde93.
	pinnedLine string
	// directoryKey is the GoTavern user-directory key that satisfies it, or "" when another part of
	// this server serves it (recorded in servedBy).
	directoryKey string
	// servedBy names the mechanism for a row that is not a userDataMounts entry.
	servedBy string
}

var pinnedUserDataMounts = []pinnedUserDataMount{
	{pinnedMount: "/backgrounds/*", pinnedLine: "users.js:1213", directoryKey: "backgrounds"},
	{pinnedMount: "/characters/*", pinnedLine: "users.js:1214", directoryKey: "characters"},
	{pinnedMount: "/User%20Avatars/*", pinnedLine: "users.js:1215", directoryKey: "avatars"},
	{pinnedMount: "/assets/*", pinnedLine: "users.js:1216", directoryKey: "assets"},
	{pinnedMount: "/user/images/*", pinnedLine: "users.js:1217", directoryKey: "userImages"},
	{pinnedMount: "/user/files/*", pinnedLine: "users.js:1218", directoryKey: "files"},
	{
		pinnedMount: "/scripts/extensions/third-party/*",
		pinnedLine:  "users.js:1219",
		servedBy:    "servePinnedExtensionRoot (frontend static path, behind the pinned extensions-enabled guard)",
	},
}

// decodedPattern converts a pinned mount (`/User%20Avatars/*`) into the pattern this mux registers
// (`/User Avatars/{rest...}`). net/http decodes the request target before matching, so the literal in
// the pattern is the DECODED path segment and the wildcard is the Go 1.22 spelling.
func decodedPattern(pinnedMount string) (string, error) {
	prefix, ok := strings.CutSuffix(pinnedMount, "*")
	if !ok {
		return "", errNotAWildcardMount(pinnedMount)
	}
	decoded, err := url.PathUnescape(prefix)
	if err != nil {
		return "", err
	}
	return decoded + "{rest...}", nil
}

type errNotAWildcardMount string

func (e errNotAWildcardMount) Error() string {
	return "pinned mount does not end in /*: " + string(e)
}

// TestPinnedUserDataMountsAreAllServed is the gate AGENTS.md 43 asks for: every pinned user-data mount
// must have an equivalent registration here, and the inventory must be derived from the oracle rather
// than accumulated from whichever E2E happened to run.
func TestPinnedUserDataMountsAreAllServed(t *testing.T) {
	if len(pinnedUserDataMounts) == 0 {
		t.Fatal("the pinned mount inventory is EMPTY: this test would pass vacuously, which is the defect it exists to prevent")
	}
	if len(pinnedUserDataMounts) != 7 {
		t.Fatalf("the pinned inventory has %d rows; src/users.js:1213-1219 declares 7 -- update the inventory deliberately, do not let it drift", len(pinnedUserDataMounts))
	}

	// ORACLE CROSS-CHECK: when the pinned checkout is beside this tree, re-read the declarations so the
	// committed copy cannot silently rot. Its absence is logged, not passed over in silence.
	if declared, path, ok := readPinnedUserDataMounts(); ok {
		t.Logf("oracle-derived: re-read %d mounted paths from %s", len(declared), path)
		for _, row := range pinnedUserDataMounts {
			if !declared[row.pinnedMount] {
				t.Errorf("inventory row %q (%s) is NOT in the pinned checkout's declarations any more -- the inventory is stale", row.pinnedMount, row.pinnedLine)
			}
		}
		for mount := range declared {
			found := false
			for _, row := range pinnedUserDataMounts {
				if row.pinnedMount == mount {
					found = true
					break
				}
			}
			if !found {
				t.Errorf("the pinned checkout declares %q and the inventory does not have it: add the row and serve it", mount)
			}
		}
	} else {
		t.Log("oracle checkout not present; the committed inventory was used and could NOT be re-read (this is the CI case)")
	}

	registered := map[string]string{}
	for _, mount := range userDataMounts {
		registered[mount.pattern] = mount.directoryKey
	}

	for _, row := range pinnedUserDataMounts {
		if row.directoryKey == "" {
			if row.servedBy == "" {
				t.Errorf("%s declares %q and nothing in this server claims to serve it", row.pinnedLine, row.pinnedMount)
			}
			continue
		}
		pattern, err := decodedPattern(row.pinnedMount)
		if err != nil {
			t.Fatalf("%s: %v", row.pinnedLine, err)
		}
		key, ok := registered[pattern]
		if !ok {
			t.Errorf(
				"%s mounts %q -> directories.%s, and this server registers no %q route, so every image the stock frontend builds from it is a broken image",
				row.pinnedLine, row.pinnedMount, row.directoryKey, pattern,
			)
			continue
		}
		if key != row.directoryKey {
			t.Errorf("%s mounts %q from directories.%s, but the Go route %q serves directory key %q", row.pinnedLine, row.pinnedMount, row.directoryKey, pattern, key)
		}
	}
}

// readPinnedUserDataMounts re-reads the declarations from the pinned checkout when it is reachable.
// Two candidate locations: the release layout (beside the repository) and a lane worktree, whose
// parent holds the main checkout and therefore the oracle.
func readPinnedUserDataMounts() (map[string]bool, string, bool) {
	for _, candidate := range []string{
		filepath.Join("..", "..", "..", "SillyTavern", "src", "users.js"),
		filepath.Join("..", "..", "SillyTavern", "src", "users.js"),
	} {
		body, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		absolute, absErr := filepath.Abs(candidate)
		if absErr != nil {
			absolute = candidate
		}
		declared := map[string]bool{}
		for _, line := range strings.Split(string(body), "\n") {
			trimmed := strings.TrimSpace(line)
			const marker = "router.use('"
			if !strings.HasPrefix(trimmed, marker) {
				continue
			}
			rest := strings.TrimPrefix(trimmed, marker)
			end := strings.Index(rest, "'")
			if end < 0 {
				continue
			}
			declared[rest[:end]] = true
		}
		if len(declared) == 0 {
			continue
		}
		return declared, absolute, true
	}
	return nil, "", false
}
