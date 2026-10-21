package server

// Replay of the pinned /api/vector routes. The oracle is
// tests/oracle/sillytavern-1.19.0-vector.json, recorded by tools/probe-vector.mjs. Each of the 33
// steps compares the HTTP response (status, content type, content length, ETag, Location, body)
// AND a full recursive snapshot of the user's `vectors` directory after the step, with item UUIDs
// normalised. That makes the on-disk vectra LocalIndex format part of the assertion, not just the
// route responses.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type vectorFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string           `json:"cookieSecret"`
		Account      sdFixtureAccount `json:"account"`
		Sources      []string         `json:"sources"`
	} `json:"inputs"`
	Steps []struct {
		Name       string                     `json:"name"`
		Route      string                     `json:"route"`
		Query      string                     `json:"query"`
		Body       map[string]json.RawMessage `json:"body"`
		BeforeFile *struct {
			Path    string `json:"path"`
			Content string `json:"content"`
		} `json:"beforeFile"`
		Response struct {
			Status        int     `json:"status"`
			ContentType   *string `json:"contentType"`
			ContentLength *string `json:"contentLength"`
			Etag          *string `json:"etag"`
			Location      *string `json:"location"`
			Body          string  `json:"body"`
		} `json:"response"`
	} `json:"steps"`
	State            map[string][]vectorSnapshotEntry `json:"state"`
	KnownDifferences []map[string]any                 `json:"knownDifferences"`
}

type vectorSnapshotEntry struct {
	Path    string  `json:"path"`
	Kind    string  `json:"kind"`
	Content *string `json:"content"`
}

var vectorUUIDPattern = regexp.MustCompile(`[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`)

func TestPinnedNodeVectorRoutes(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-vector.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture vectorFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("vector oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Steps) == 0 || len(fixture.State) != len(fixture.Steps) {
		t.Fatalf("vector oracle has %d steps and %d state snapshots", len(fixture.Steps), len(fixture.State))
	}
	if len(fixture.KnownDifferences) == 0 {
		t.Fatal("the vector oracle must record the provider-source gap")
	}
	// The pinned SOURCES ordering is contract for purge/purge-all; the fixture records it and this
	// test fails if the implementation's list drifts.
	if len(fixture.Inputs.Sources) != len(vectorSources) {
		t.Fatalf("fixture records %d vector sources, implementation has %d", len(fixture.Inputs.Sources), len(vectorSources))
	}
	for index, source := range fixture.Inputs.Sources {
		if vectorSources[index] != source {
			t.Fatalf("vector source %d = %q, pinned SOURCES has %q", index, vectorSources[index], source)
		}
	}

	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, installRoot, fixture.Inputs.CookieSecret, fixture.Inputs.Account)
	directories, err := startup.DirectoriesForUser(dataRoot, fixture.Inputs.Account.Handle)
	if err != nil {
		t.Fatal(err)
	}
	vectorsRoot := directories["vectors"]
	if err := os.MkdirAll(vectorsRoot, 0o777); err != nil {
		t.Fatal(err)
	}

	for _, step := range fixture.Steps {
		if step.BeforeFile != nil {
			target := filepath.Join(vectorsRoot, filepath.FromSlash(step.BeforeFile.Path))
			if err := os.WriteFile(target, []byte(step.BeforeFile.Content), 0o666); err != nil {
				t.Fatal(err)
			}
		}
		body := make(map[string]json.RawMessage, len(step.Body))
		for key, value := range step.Body {
			body[key] = value
		}
		encoded, marshalErr := marshalNodeJSON(body)
		if marshalErr != nil {
			t.Fatal(marshalErr)
		}
		target := "/api/vector/" + step.Route + step.Query
		request := httptest.NewRequest(http.MethodPost, target, strings.NewReader(string(encoded)))
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
		compareOptionalHeader(t, step.Name, "location", step.Response.Location, recorder.Header().Get("Location"))
		if recorder.Body.String() != step.Response.Body {
			t.Fatalf("%s: body = %q, pinned Node has %q", step.Name, recorder.Body.String(), step.Response.Body)
		}

		want, exists := fixture.State[step.Name]
		if !exists {
			t.Fatalf("%s: no recorded filesystem state", step.Name)
		}
		got := snapshotVectorDirectory(t, vectorsRoot)
		if len(got) != len(want) {
			t.Fatalf("%s: vectors tree has %d entries, pinned Node had %d: got %+v want %+v", step.Name, len(got), len(want), got, want)
		}
		for index := range want {
			if !equalVectorSnapshotEntry(got[index], want[index]) {
				gotContent, wantContent := "", ""
				if got[index].Content != nil {
					gotContent = *got[index].Content
				}
				if want[index].Content != nil {
					wantContent = *want[index].Content
				}
				t.Fatalf("%s: entry %d path=%q kind=%q\n got: %s\nwant: %s", step.Name, index, got[index].Path, got[index].Kind, gotContent, wantContent)
			}
		}
	}
}

func equalVectorSnapshotEntry(got, want vectorSnapshotEntry) bool {
	if got.Path != want.Path || got.Kind != want.Kind {
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

// snapshotVectorDirectory mirrors the probe's walk: entries in name order, each directory followed
// immediately by its contents, file contents read as UTF-8 with UUIDs normalised.
func snapshotVectorDirectory(t *testing.T, root string) []vectorSnapshotEntry {
	t.Helper()
	entries := make([]vectorSnapshotEntry, 0)
	var walk func(absolute, relative string)
	walk = func(absolute, relative string) {
		children, err := os.ReadDir(absolute)
		if err != nil {
			t.Fatal(err)
		}
		names := make([]string, 0, len(children))
		for _, child := range children {
			names = append(names, child.Name())
		}
		sort.Strings(names)
		for _, name := range names {
			childAbsolute := filepath.Join(absolute, name)
			childRelative := name
			if relative != "" {
				childRelative = relative + "/" + name
			}
			info, err := os.Stat(childAbsolute)
			if err != nil {
				t.Fatal(err)
			}
			if info.IsDir() {
				entries = append(entries, vectorSnapshotEntry{Path: childRelative, Kind: "directory"})
				walk(childAbsolute, childRelative)
				continue
			}
			content, readErr := os.ReadFile(childAbsolute)
			if readErr != nil {
				t.Fatal(readErr)
			}
			normalised := vectorUUIDPattern.ReplaceAllString(string(content), "<uuid>")
			entries = append(entries, vectorSnapshotEntry{Path: childRelative, Kind: "file", Content: &normalised})
		}
	}
	walk(root, "")
	return entries
}
