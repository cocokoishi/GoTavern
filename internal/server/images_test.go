package server

// Route-level replay of tests/oracle/sillytavern-1.19.0-images.json, recorded by
// tools/probe-images.mjs against the real pinned listener.
//
// Each scenario starts from the SAME seeded `user/images` tree the probe used (the fixture records the
// exact bytes and mtimes), sends one request, and compares three things:
//
//	1. the status and every response header;
//	2. the response BYTES, not a parsed value (the error bodies are plain strings for /delete and JSON
//	   for the rest, and that difference is contract);
//	3. the resulting tree: every relative path, size and digest, so a write, a rename or a delete that
//	   the pinned operation would not perform is visible.
//
// An upload with no filename is named `${Date.now()}.${format}`, so both the response and the tree are
// normalized with a timestamp marker, and the ETag of that one response is recorded as `<unstable-body>`
// because it hashes the raw body. Nothing else is normalized.

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"testing"
	"time"
)

type imagesSeed struct {
	SHA256  string `json:"sha256"`
	Bytes   int    `json:"bytes"`
	MTimeMS int64  `json:"mtimeMs"`
	Base64  string `json:"base64"`
}

type imagesTreeEntry struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type imagesScenario struct {
	Route       string `json:"route"`
	RequestBody string `json:"requestBody"`
	Response    struct {
		Status   int               `json:"status"`
		Headers  map[string]string `json:"headers"`
		Body     json.RawMessage   `json:"body"`
		BodyText string            `json:"bodyText"`
	} `json:"response"`
	TreeAfter []imagesTreeEntry `json:"treeAfter"`
}

type imagesFixture struct {
	Seeds struct {
		Files map[string]imagesSeed `json:"files"`
	} `json:"seeds"`
	Scenarios map[string]imagesScenario `json:"scenarios"`
}

func loadImagesOracle(t *testing.T) imagesFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-images.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture imagesFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 || len(fixture.Seeds.Files) == 0 {
		t.Fatal("the images oracle records no scenarios or no seed tree")
	}
	return fixture
}

var imagesTimestampPattern = regexp.MustCompile(`\b1\d{12}\b`)

const imagesUnstableETag = "<unstable-body>"

// imagesTreeState mirrors the probe's tree recording: sorted relative paths, sizes and digests only.
func imagesTreeState(t *testing.T, imagesRoot string) []imagesTreeEntry {
	t.Helper()
	state := make([]imagesTreeEntry, 0)
	var walk func(relative string)
	walk = func(relative string) {
		directory := filepath.Join(imagesRoot, filepath.FromSlash(relative))
		entries, err := os.ReadDir(directory)
		if err != nil {
			return
		}
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		sort.Strings(names)
		for _, name := range names {
			childRelative := name
			if relative != "" {
				childRelative = relative + "/" + name
			}
			absolute := filepath.Join(imagesRoot, filepath.FromSlash(childRelative))
			info, err := os.Stat(absolute)
			if err != nil {
				t.Fatalf("stat %s: %v", absolute, err)
			}
			if info.IsDir() {
				state = append(state, imagesTreeEntry{Path: childRelative + "/", Kind: "directory"})
				walk(childRelative)
				continue
			}
			content, err := os.ReadFile(absolute)
			if err != nil {
				t.Fatalf("read %s: %v", absolute, err)
			}
			state = append(state, imagesTreeEntry{
				Path:   imagesTimestampPattern.ReplaceAllString(childRelative, "<timestamp>"),
				Kind:   "file",
				Bytes:  len(content),
				SHA256: fmt.Sprintf("%x", sha256.Sum256(content)),
			})
		}
	}
	walk("")
	return state
}

func seedImagesTree(t *testing.T, imagesRoot string, files map[string]imagesSeed) {
	t.Helper()
	for relative, seed := range files {
		absolute := filepath.Join(imagesRoot, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(absolute), 0o755); err != nil {
			t.Fatal(err)
		}
		content, err := base64.StdEncoding.DecodeString(seed.Base64)
		if err != nil {
			t.Fatal(err)
		}
		if len(content) != seed.Bytes || fmt.Sprintf("%x", sha256.Sum256(content)) != seed.SHA256 {
			t.Fatalf("seed %s does not match its recorded digest", relative)
		}
		if err := os.WriteFile(absolute, content, 0o644); err != nil {
			t.Fatal(err)
		}
		stamp := time.Unix(seed.MTimeMS/1000, 0)
		if err := os.Chtimes(absolute, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
}

func TestImagesRoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadImagesOracle(t)
	if len(fixture.Scenarios) < 30 {
		t.Fatalf("the fixture records only %d scenarios; the domain pinning is incomplete", len(fixture.Scenarios))
	}
	uploadScenarios, deleteScenarios, listScenarios, folderScenarios := 0, 0, 0, 0
	statuses := map[int]int{}
	unstableETags := 0
	for label, scenario := range fixture.Scenarios {
		label, scenario := label, scenario
		t.Run(label, func(t *testing.T) {
			dataRoot := t.TempDir()
			userRoot := filepath.Join(dataRoot, "default-user")
			imagesRoot := filepath.Join(userRoot, "user", "images")
			if err := os.MkdirAll(imagesRoot, 0o755); err != nil {
				t.Fatal(err)
			}
			seedImagesTree(t, imagesRoot, fixture.Seeds.Files)
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			response := postSecretsRoute(t, handler, scenario.Route, scenario.RequestBody)
			if response.Code != scenario.Response.Status {
				t.Fatalf("%s: status = %d, want %d (body %q)", label, response.Code, scenario.Response.Status, response.Body.String())
			}
			headers := response.Header().Clone()
			expected := make(map[string]string, len(scenario.Response.Headers))
			for name, value := range scenario.Response.Headers {
				expected[name] = value
			}
			if expected["etag"] == imagesUnstableETag {
				delete(expected, "etag")
				headers.Del("ETag")
				unstableETags++
			}
			assertPinnedHeaders(t, headers, expected)
			bodyText := imagesTimestampPattern.ReplaceAllString(response.Body.String(), "<timestamp>")
			if bodyText != scenario.Response.BodyText {
				t.Fatalf("%s: body = %q, pinned %q", label, bodyText, scenario.Response.BodyText)
			}
			gotTree := imagesTreeState(t, imagesRoot)
			if len(gotTree) != len(scenario.TreeAfter) {
				t.Fatalf("%s: tree has %d entries, pinned %d: %+v", label, len(gotTree), len(scenario.TreeAfter), gotTree)
			}
			for index, want := range scenario.TreeAfter {
				if gotTree[index] != want {
					t.Fatalf("%s: tree entry %d = %+v, pinned %+v", label, index, gotTree[index], want)
				}
			}
			statuses[response.Code]++
			switch scenario.Route {
			case "/api/images/upload":
				uploadScenarios++
			case "/api/images/delete":
				deleteScenarios++
			case "/api/images/folders":
				folderScenarios++
			default:
				listScenarios++
			}
		})
	}
	if uploadScenarios == 0 || deleteScenarios == 0 || listScenarios == 0 || folderScenarios == 0 {
		t.Fatalf("coverage is incomplete: upload=%d delete=%d list=%d folders=%d", uploadScenarios, deleteScenarios, listScenarios, folderScenarios)
	}
	if statuses[200] == 0 || statuses[400] == 0 || statuses[404] == 0 {
		t.Fatalf("the fixture does not cover the 200/400/404 branches: %+v", statuses)
	}
	if unstableETags == 0 {
		t.Fatal("no scenario records a Date.now() name, so the timestamp normalization is unproven")
	}
}
