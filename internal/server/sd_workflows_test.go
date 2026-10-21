package server

// Replay of the pinned comfy workflow CRUD filesystem semantics. The oracle is
// tests/oracle/sillytavern-1.19.0-sd-workflows.json, recorded by
// `tools/probe-sd-routes.mjs ... workflows` from the pinned SillyTavern server.
//
// Every step compares the HTTP response AND a full snapshot of user/workflows (name, kind, bytes),
// so the test proves the filesystem side effects and not only the responses: sanitization, the
// hidden/non-json filtering, the collation order, empty files for a null/absent workflow, the
// directory rename, and the 400/404/409/204 branches.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type sdWorkflowsFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret      string           `json:"cookieSecret"`
		Account           sdFixtureAccount `json:"account"`
		CollatorLocale    string           `json:"collatorLocale"`
		StartingDirectory map[string]any   `json:"startingDirectory"`
	} `json:"inputs"`
	Steps []struct {
		Name     string                     `json:"name"`
		Route    string                     `json:"route"`
		Body     map[string]json.RawMessage `json:"body"`
		Response struct {
			Status        int     `json:"status"`
			ContentType   *string `json:"contentType"`
			ContentLength *string `json:"contentLength"`
			Etag          *string `json:"etag"`
			Body          string  `json:"body"`
		} `json:"response"`
	} `json:"steps"`
	State map[string][]sdWorkflowEntry `json:"state"`
}

type sdWorkflowEntry struct {
	Name    string  `json:"name"`
	Kind    string  `json:"kind"`
	Content *string `json:"content"`
}

func TestPinnedNodeSDComfyWorkflows(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-sd-workflows.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture sdWorkflowsFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("SD workflows oracle baseline = %+v", fixture.Baseline)
	}
	if !strings.HasPrefix(strings.ToLower(fixture.Inputs.CollatorLocale), "en") {
		t.Fatalf("SD workflows oracle was recorded under %q; the recorded collation order is only valid for an English default locale", fixture.Inputs.CollatorLocale)
	}
	if len(fixture.Steps) == 0 || len(fixture.State) != len(fixture.Steps) {
		t.Fatalf("SD workflows oracle has %d steps and %d state snapshots", len(fixture.Steps), len(fixture.State))
	}

	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, installRoot, fixture.Inputs.CookieSecret, fixture.Inputs.Account)
	directories, err := startup.DirectoriesForUser(dataRoot, fixture.Inputs.Account.Handle)
	if err != nil {
		t.Fatal(err)
	}
	workflowsRoot := directories["comfyWorkflows"]
	// The probe starts from a deliberately empty workflows directory containing one directory
	// named dir.json; the pinned config sets skipContentCheck, so nothing was seeded.
	if err := os.RemoveAll(workflowsRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(workflowsRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(workflowsRoot, "dir.json"), 0o777); err != nil {
		t.Fatal(err)
	}

	for _, step := range fixture.Steps {
		body := make(map[string]json.RawMessage, len(step.Body))
		for key, value := range step.Body {
			body[key] = value
		}
		encoded, marshalErr := marshalNodeJSON(body)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/sd/"+step.Route, bytes.NewReader(encoded))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		if recorder.Code != step.Response.Status {
			t.Fatalf("%s: status = %d, pinned Node has %d (body %q)", step.Name, recorder.Code, step.Response.Status, recorder.Body.String())
		}
		compareOptionalHeader(t, step.Name, "content-type", step.Response.ContentType, recorder.Header().Get("Content-Type"))
		compareOptionalHeader(t, step.Name, "content-length", step.Response.ContentLength, recorder.Header().Get("Content-Length"))
		compareOptionalHeader(t, step.Name, "etag", step.Response.Etag, recorder.Header().Get("ETag"))
		if recorder.Body.String() != step.Response.Body {
			t.Fatalf("%s: body = %q, pinned Node has %q", step.Name, recorder.Body.String(), step.Response.Body)
		}

		wantState, exists := fixture.State[step.Name]
		if !exists {
			t.Fatalf("%s: no recorded filesystem state", step.Name)
		}
		gotState := snapshotSDWorkflows(t, workflowsRoot)
		if len(gotState) != len(wantState) {
			t.Fatalf("%s: user/workflows has %d entries, pinned Node had %d: got %+v want %+v",
				step.Name, len(gotState), len(wantState), gotState, wantState)
		}
		for index := range wantState {
			if !equalSDWorkflowEntry(gotState[index], wantState[index]) {
				t.Fatalf("%s: entry %d = %+v, pinned Node had %+v", step.Name, index, gotState[index], wantState[index])
			}
		}
	}
}

// equalSDWorkflowEntry compares dereferenced contents: the fixture's content is a pointer so that
// "no content" (a directory) and "empty content" (a file) stay distinct.
func equalSDWorkflowEntry(got, want sdWorkflowEntry) bool {
	if got.Name != want.Name || got.Kind != want.Kind {
		return false
	}
	if (got.Content == nil) != (want.Content == nil) {
		return false
	}
	if got.Content != nil && *got.Content != *want.Content {
		return false
	}
	return true
}

func snapshotSDWorkflows(t *testing.T, directory string) []sdWorkflowEntry {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	// Node's readdirSync(...).sort() is a UTF-16 code-unit sort; for the recorded names this is
	// the same order as a byte sort, which is what sort.Strings performs.
	sort.Strings(names)
	snapshot := make([]sdWorkflowEntry, 0, len(names))
	for _, name := range names {
		info, err := os.Stat(filepath.Join(directory, name))
		if err != nil {
			t.Fatal(err)
		}
		entry := sdWorkflowEntry{Name: name, Kind: "file"}
		if info.IsDir() {
			entry.Kind = "directory"
		} else {
			content, readErr := os.ReadFile(filepath.Join(directory, name))
			if readErr != nil {
				t.Fatal(readErr)
			}
			text := string(content)
			entry.Content = &text
		}
		snapshot = append(snapshot, entry)
	}
	return snapshot
}
