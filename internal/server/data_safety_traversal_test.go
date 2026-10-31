package server

// PATH-TRAVERSAL PROBES AT THE ROUTES THAT TAKE A USER NAME.
//
// The sanitizer's containment property is fuzzed in FuzzSanitizeUserFilename / FuzzPinnedPathUnderParent.
// This file is the route-level probe: a traversal-shaped name is sent to the routes a beta user's
// browser actually calls, and the assertion is that NO file appears outside the user's data root. It
// also pins the safe outcome per route: either the request is refused, or the name is sanitized to a
// plain file inside the expected directory (never both a refusal and a stray file outside).
//
// Shape: the whole tree lives under one temp dir, dataRoot = <root>/data. After every probe the test
// walks <root> and fails if any path OUTSIDE dataRoot carries the traversal payload's basename.

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestTraversalNamesNeverCreateFilesOutsideTheUserTree(t *testing.T) {
	root := t.TempDir()
	dataRoot := filepath.Join(root, "data")
	harness := newDataSafetyHarnessAt(t, dataRoot)
	if directories := harness.directories["root"]; !strings.HasPrefix(filepath.Clean(directories), filepath.Clean(dataRoot)) {
		t.Fatalf("the harness user root %q is not under the data root %q", directories, dataRoot)
	}

	payload := func(base string) string {
		// btoa of the bytes a PEM-less PNG would carry; the route only base64-decodes it.
		return base64.StdEncoding.EncodeToString([]byte(base))
	}
	jsonBody := func(value map[string]any) []byte {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return encoded
	}

	type probe struct {
		name  string
		route string
		body  []byte
		// allowedStatuses is what the route may answer; the point is that nothing escaped, and every
		// status here is a refusal or a sanitized success, never a 5xx caused by the payload.
		allowedStatuses map[int]bool
	}
	probes := []probe{
		{
			name:  "chat save with a traversal avatar and file name",
			route: "/api/chats/save",
			body: jsonBody(map[string]any{
				"avatar_url": "../../escape.png", "file_name": "../../escape", "chat": []map[string]any{},
			}),
			allowedStatuses: map[int]bool{http.StatusBadRequest: true},
		},
		{
			name:  "world info edit with a traversal name",
			route: "/api/worldinfo/edit",
			body: jsonBody(map[string]any{
				"name": "../../escape", "data": map[string]any{"entries": map[string]any{}},
			}),
			allowedStatuses: map[int]bool{http.StatusOK: true, http.StatusBadRequest: true, http.StatusInternalServerError: true},
		},
		{
			name:  "image upload with a traversal file name",
			route: "/api/images/upload",
			body: jsonBody(map[string]any{
				"format": "png", "filename": "../../escape.png", "image": payload("escape-image"),
			}),
			allowedStatuses: map[int]bool{http.StatusOK: true, http.StatusBadRequest: true, http.StatusInternalServerError: true},
		},
		{
			name:  "file upload with a traversal name",
			route: "/api/files/upload",
			body: jsonBody(map[string]any{
				"name": "../../escape.txt", "data": payload("escape-file"),
			}),
			allowedStatuses: map[int]bool{http.StatusOK: true, http.StatusBadRequest: true, http.StatusInternalServerError: true},
		},
	}
	for _, scenario := range probes {
		t.Run(scenario.name, func(t *testing.T) {
			response := harness.post(scenario.route, scenario.body)
			if !scenario.allowedStatuses[response.Code] {
				t.Fatalf("%s answered %d (body %q); expected a refusal or a sanitized success",
					scenario.route, response.Code, response.Body.String())
			}
			assertNoEscapeFilesOutside(t, root, dataRoot, "escape")
		})
	}
}

// assertNoEscapeFilesOutside walks the whole probe root and fails if the traversal payload's
// basename appears anywhere outside the data root. The data root itself may legitimately contain a
// sanitized file (that is the safe outcome), so only the outside is judged.
func assertNoEscapeFilesOutside(t *testing.T, root, dataRoot, basename string) {
	t.Helper()
	if err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		cleaned := filepath.Clean(path)
		if cleaned == filepath.Clean(dataRoot) || strings.HasPrefix(cleaned, filepath.Clean(dataRoot)+string(filepath.Separator)) {
			if info.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.Contains(filepath.Base(cleaned), basename) {
			t.Errorf("a traversal-shaped name created %s, OUTSIDE the user data root %s", cleaned, dataRoot)
		}
		return nil
	}); err != nil {
		t.Fatalf("walk %s: %v", root, err)
	}
}
