package server

// PART A OF THE FRONTEND ASSET CONTRACT (AGENTS.md rule 54, and rule 43's inventory).
//
// WHY THIS TEST EXISTS, IN THE WORDS OF ITS OWN INCIDENT. An inventory test that compared the pinned
// mount DECLARATIONS with the mount REGISTRATIONS was green on a commit whose server could not start:
// the registration carried `/User Avatars/{rest...}`, net/http reads a space in a pattern as a method
// separator, and mux.HandleFunc panicked -- while the string comparison saw two equal-looking strings.
// A gate that compares declarations cannot see the failure that happens when one is EXECUTED.
//
// So this test executes. It builds the REAL handler through newFrontendAssetHarness, plants a file whose
// body carries a UNIQUE marker in each per-user directory, and requires the response body to be exactly
// that marker. The marker is the teeth: the data-root fallback (`_errors/url-not-found.html`) answers 200
// with the application page, so a mount that is missing or mis-registered fails on the BODY, not on a
// status value that a catch-all can also produce (rule 15).
//
// WHAT THIS TEST DOES NOT COVER, stated so a reader does not think the two gates duplicate each other:
//   - TestPinnedUserDataMountsAreAllServed (frontend_assets_mounts_test.go) diffs the pinned SET against
//     the registered SET. It catches a mount that exists in the table but not in the mux, and adding a
//     mount without an inventory row. It cannot catch a pattern the mux rejects, because it never builds
//     the mux. THIS test is the one that fails in that case.
//   - `/thumbnail` joins this table in the commit that implements it (this commit is the mount fix,
//     which is already on main); ITS assertion is the decoded observable, not a marker.
//
// PROVENANCE (rule 4): the seven pinned mounts are ORACLE-DERIVED (src/users.js:1213-1219, read in the
// checkout); the per-user relative directories are a DERIVATION and are checked against
// startup.DirectoriesForUser by the sibling inventory test.

import (
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type mountServesBytesCase struct {
	label        string // for the failure message
	pinnedLine   string // where the mount is declared
	userRelative string // per-user directory, relative to <dataRoot>/<handle>
	requestPath  string // the URL the pinned frontend requests
}

var mountServesBytesCases = []mountServesBytesCase{
	{"backgrounds", "users.js:1213", "backgrounds", "/backgrounds/marker.png"},
	{"characters", "users.js:1214", "characters", "/characters/marker.png"},
	// The frontend requests the PERCENT-ENCODED spelling; net/http decodes the target before matching,
	// so the registered pattern is the escaped literal and the request carries /User%20Avatars/.
	{"user avatars", "users.js:1215", "User Avatars", "/User%20Avatars/marker.png"},
	{"assets", "users.js:1216", "assets", "/assets/marker.png"},
	{"user images", "users.js:1217", filepath.Join("user", "images"), "/user/images/marker.png"},
	{"user files", "users.js:1218", filepath.Join("user", "files"), "/user/files/marker.png"},
}

// TestPinnedFrontendAssetContractMountsServeMarkedBytes is part A: every pinned user-data mount must
// return the planted file's own bytes through the real handler.
func TestPinnedFrontendAssetContractMountsServeMarkedBytes(t *testing.T) {
	harness := newFrontendAssetHarness(t)
	if len(mountServesBytesCases) == 0 {
		t.Fatal("no mount cases: this test would pass vacuously")
	}

	for _, testCase := range mountServesBytesCases {
		t.Run(testCase.label, func(t *testing.T) {
			// A marker unique per mount, so a response cannot accidentally match: if the mux falls
			// through to the data-root 404 page the body is the application page, not this string.
			marker := []byte("GOTAVERN-MOUNT-MARKER-" + strings.ToUpper(strings.ReplaceAll(testCase.label, " ", "-")))
			directory := filepath.Join(harness.dataRoot, "default-user", testCase.userRelative)
			if err := os.MkdirAll(directory, 0o700); err != nil {
				t.Fatalf("%s mounts %q but the per-user directory %s cannot be created: %v",
					testCase.pinnedLine, testCase.requestPath, directory, err)
			}
			if err := os.WriteFile(filepath.Join(directory, "marker.png"), marker, 0o600); err != nil {
				t.Fatal(err)
			}

			response := harness.get(t, testCase.requestPath, true)
			if response.Code != http.StatusOK {
				t.Fatalf(
					"%s mounts %q and this server answered %d, so every image the stock frontend builds from that mount is a broken image (body: %.120q)",
					testCase.pinnedLine, testCase.requestPath, response.Code, response.Body.String(),
				)
			}
			if response.Body.String() != string(marker) {
				t.Fatalf(
					"GET %s answered 200 but NOT the planted bytes (rule 15: a status a catch-all can also produce is not evidence).\ngot:  %.160q\nwant: %q",
					testCase.requestPath, response.Body.String(), marker,
				)
			}
		})
	}
}
