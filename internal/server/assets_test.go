package server

// Replay of the pinned assets and chat-backup routes implemented this round. The oracles are
// tests/oracle/sillytavern-1.19.0-assets.json and tests/oracle/sillytavern-1.19.0-backups.json,
// recorded by tools/probe-assets.mjs.
//
// The fixtures classify readdir ordering, path separators and the raw-byte ETag as `shape`; both
// sides are normalised to '/' and to sorted collections before comparison, and the ETag is asserted
// for presence only. Every step also compares the whole user tree (relative path, kind, size,
// SHA-256), which is how deletions are observed: a file that the fixture says is gone must be
// absent from the next snapshot.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

type userDataFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Steps            []userDataStep                        `json:"steps"`
	State            map[string]map[string][]userDataEntry `json:"state"`
	KnownDifferences []map[string]any                      `json:"knownDifferences"`
}

type userDataStep struct {
	Name     string           `json:"name"`
	Route    string           `json:"route"`
	Body     json.RawMessage  `json:"body"`
	Query    string           `json:"query"`
	Response userDataResponse `json:"response"`
}

type userDataResponse struct {
	Status             int              `json:"status"`
	ContentType        *string          `json:"contentType"`
	ContentLength      *string          `json:"contentLength"`
	Etag               *string          `json:"etag"`
	ContentDisposition *string          `json:"contentDisposition"`
	Body               json.RawMessage  `json:"body"`
	BodyText           *string          `json:"bodyText"`
	BodySha256         string           `json:"bodySha256"`
	Comparison         searchComparison `json:"comparison"`
}

type userDataEntry struct {
	Path   string  `json:"path"`
	Kind   string  `json:"kind"`
	Size   int64   `json:"size"`
	Sha256 *string `json:"sha256"`
}

func TestPinnedNodeAssetsRoutes(t *testing.T) {
	runUserDataFixture(t, "sillytavern-1.19.0-assets.json", "assets", seedPinnedAssetsTree)
}

func TestPinnedNodeBackupsRoutes(t *testing.T) {
	runUserDataFixture(t, "sillytavern-1.19.0-backups.json", "backups", seedPinnedBackupsTree)
}

func runUserDataFixture(t *testing.T, fixtureName, mode string, seed func(*testing.T, string)) {
	t.Helper()
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", fixtureName))
	if err != nil {
		t.Fatal(err)
	}
	var fixture userDataFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("%s: baseline = %+v", fixtureName, fixture.Baseline)
	}
	if len(fixture.Steps) == 0 || len(fixture.State) != len(fixture.Steps) {
		t.Fatalf("%s: %d steps but %d snapshots", fixtureName, len(fixture.Steps), len(fixture.State))
	}
	verifyUserDataClassification(t, fixtureName, fixture)
	verifyUserDataDeletionsObservable(t, fixtureName, fixture, mode)

	dataRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, t.TempDir(), "gotavern-pinned-assets-cookie-secret",
		sdFixtureAccount{Handle: "default-user", Name: "Assets Writer", Password: "", Admin: true})
	seed(t, dataRoot)

	for _, step := range fixture.Steps {
		body := "{}"
		if len(step.Body) > 0 {
			body = string(step.Body)
		}
		target := "/api/assets/" + step.Route + step.Query
		if mode == "backups" {
			target = "/api/backups/chat/" + step.Route
		}
		request := httptest.NewRequest(http.MethodPost, target, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		compareUserDataResponse(t, step, recorder)
		snapshot := snapshotUserDataTree(t, userRootPath(dataRoot), mode)
		expected := fixture.State[step.Name]
		if mode == "assets" {
			compareUserDataTree(t, step.Name+"/assets", expected["assets"], snapshot["assets"])
			compareUserDataTree(t, step.Name+"/characters", expected["characters"], snapshot["characters"])
		} else {
			compareUserDataTree(t, step.Name+"/backups", expected["backups"], snapshot["backups"])
		}
	}
}

func userRootPath(dataRoot string) string {
	return filepath.Join(dataRoot, "default-user")
}

func seedPinnedAssetsTree(t *testing.T, dataRoot string) {
	t.Helper()
	seedUserDataFile(t, dataRoot, "assets/bgm/one.mp3", "BGM-ONE")
	seedUserDataFile(t, dataRoot, "assets/bgm/two.mp3", "BGM-TWO")
	seedUserDataFile(t, dataRoot, "assets/ambient/wind.ogg", "AMBIENT")
	seedUserDataFile(t, dataRoot, "assets/blip/.placeholder", "")
	seedUserDataFile(t, dataRoot, "assets/live2d/modelA/model3.json", `{"model":"a"}`)
	seedUserDataFile(t, dataRoot, "assets/live2d/modelA/texture.png", "PNG")
	seedUserDataFile(t, dataRoot, "assets/vrm/model/avatar.vrm", "VRM")
	seedUserDataFile(t, dataRoot, "assets/vrm/model/skip.placeholder", "")
	seedUserDataFile(t, dataRoot, "assets/vrm/animation/idle.anim", "ANIM")
	seedUserDataFile(t, dataRoot, "assets/character/char.png", "CHAR")
	seedUserDataFile(t, dataRoot, "assets/temp/ignored.png", "TEMP")
	seedUserDataFile(t, dataRoot, "characters/Seraphina/ambient/a.mp3", "A")
	seedUserDataFile(t, dataRoot, "characters/Seraphina/ambient/b.mp3", "B")
	seedUserDataFile(t, dataRoot, "characters/Seraphina/bgm/x.mp3", "X")
	seedUserDataFile(t, dataRoot, "characters/Seraphina/live2d/modelA/model.json", `{"model":"char"}`)
	seedUserDataFile(t, dataRoot, "characters/Seraphina/live2d/modelA/extra.json", `{}`)
	seedUserDataFile(t, dataRoot, "characters/Seraphina/live2d/modelA/tex.png", "TEX")
}

func seedPinnedBackupsTree(t *testing.T, dataRoot string) {
	t.Helper()
	// Pinned startup leaves a backups/_sysprompt directory; it is baseline state, not a route
	// effect, so the replay seeds it to mirror the recorded preconditions.
	if err := os.MkdirAll(filepath.Join(userRootPath(dataRoot), "backups", "_sysprompt"), 0o777); err != nil {
		t.Fatal(err)
	}
	seedUserDataFile(t, dataRoot, "backups/chat_2024-01-01T00-00-00.jsonl", "{\"user_name\":\"u\"}\n{\"mes\":\"hi\"}\n")
	seedUserDataFile(t, dataRoot, "backups/chat_alpha.jsonl", "{\"user_name\":\"u\"}\n{\"mes\":\"a\"}\n{\"mes\":\"b\"}\n")
	seedUserDataFile(t, dataRoot, "backups/chat_empty.jsonl", "")
	seedUserDataFile(t, dataRoot, "backups/other.jsonl", "{}\n")
	seedUserDataFile(t, dataRoot, "backups/note.txt", "note")
}

func seedUserDataFile(t *testing.T, dataRoot, relative, content string) {
	t.Helper()
	target := filepath.Join(userRootPath(dataRoot), filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte(content), 0o666); err != nil {
		t.Fatal(err)
	}
	fixed := time.Unix(1700000000, 0)
	if err := os.Chtimes(target, fixed, fixed); err != nil {
		t.Fatal(err)
	}
}

func verifyUserDataClassification(t *testing.T, fixtureName string, fixture userDataFixture) {
	t.Helper()
	comparedAnywhere := map[string]bool{}
	sawShapeReason := map[string]bool{}
	for _, step := range fixture.Steps {
		classified := map[string]bool{}
		for _, key := range step.Response.Comparison.Compared {
			classified[key] = true
			comparedAnywhere[key] = true
		}
		for _, key := range step.Response.Comparison.Shape {
			classified[key] = true
			reason := strings.TrimSpace(step.Response.Comparison.ShapeReason[key])
			if reason == "" {
				t.Fatalf("%s %s: shape %q has no reason", fixtureName, step.Name, key)
			}
			sawShapeReason[key] = true
		}
		for _, key := range []string{"status", "contentType", "contentLength", "contentDisposition", "bodySha256"} {
			if !classified[key] {
				t.Fatalf("%s %s: %q is neither compared nor shape-classified", fixtureName, step.Name, key)
			}
		}
		if (step.Response.Body == nil || string(step.Response.Body) == "null") && step.Response.BodyText == nil {
			t.Fatalf("%s %s: response has neither a JSON body nor a text body", fixtureName, step.Name)
		}
	}
	for _, key := range []string{"status", "contentType", "contentLength", "contentDisposition", "bodySha256"} {
		if !comparedAnywhere[key] {
			t.Fatalf("%s: %q is never compared", fixtureName, key)
		}
	}
	for _, key := range []string{"etag", "body order", "path separators"} {
		if !sawShapeReason[key] {
			t.Fatalf("%s: shape classification %q missing", fixtureName, key)
		}
	}
}

func verifyUserDataDeletionsObservable(t *testing.T, fixtureName string, fixture userDataFixture, mode string) {
	t.Helper()
	key := mode
	previous := map[string]bool{}
	deletions := 0
	for _, step := range fixture.Steps {
		current := map[string]bool{}
		for _, entry := range fixture.State[step.Name][key] {
			current[entry.Path] = true
		}
		if previous != nil {
			for pathValue := range previous {
				if !current[pathValue] {
					deletions++
				}
			}
		}
		previous = current
	}
	if deletions == 0 {
		t.Fatalf("%s: the fixture never records a deletion, so its delete assertions cannot fail", fixtureName)
	}
}

func compareUserDataResponse(t *testing.T, step userDataStep, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if recorder.Code != step.Response.Status {
		t.Fatalf("%s: status = %d, pinned Node has %d (body %q)", step.Name, recorder.Code, step.Response.Status, recorder.Body.String())
	}
	compareOptionalHeader(t, step.Name, "content-type", step.Response.ContentType, recorder.Header().Get("Content-Type"))
	compareOptionalHeader(t, step.Name, "content-length", step.Response.ContentLength, recorder.Header().Get("Content-Length"))
	compareOptionalHeader(t, step.Name, "content-disposition", step.Response.ContentDisposition, recorder.Header().Get("Content-Disposition"))
	if step.Response.Etag != nil && *step.Response.Etag != "" && recorder.Header().Get("ETag") == "" {
		t.Fatalf("%s: the replay sent no ETag although pinned Node did", step.Name)
	}
	if step.Response.BodyText != nil {
		if recorder.Body.String() != *step.Response.BodyText {
			t.Fatalf("%s: body = %q, pinned Node has %q", step.Name, recorder.Body.String(), *step.Response.BodyText)
		}
		if userDataSHA256(recorder.Body.Bytes()) != step.Response.BodySha256 {
			t.Fatalf("%s: text body SHA-256 differs from pinned Node", step.Name)
		}
		return
	}
	var gotValue any
	if err := json.Unmarshal(recorder.Body.Bytes(), &gotValue); err != nil {
		t.Fatalf("%s: response is not JSON: %v (body %q)", step.Name, err, recorder.Body.String())
	}
	gotNormalized := normalizeUserDataValue(gotValue)
	var wantValue any
	if err := json.Unmarshal(step.Response.Body, &wantValue); err != nil {
		t.Fatalf("%s: fixture body is not JSON: %v", step.Name, err)
	}
	wantNormalized := normalizeUserDataValue(wantValue)
	gotJSON, _ := json.Marshal(gotNormalized)
	wantJSON, _ := json.Marshal(wantNormalized)
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("%s: body = %s, pinned Node has %s", step.Name, gotJSON, wantJSON)
	}
	if userDataSHA256(gotJSON) != step.Response.BodySha256 {
		t.Fatalf("%s: normalised body SHA-256 differs from pinned Node", step.Name)
	}
}

// normalizeUserDataValue sorts arrays and object keys and maps path separators to '/', matching the
// probe's recording transform. The path separator is a shape field, not a compared one.
func normalizeUserDataValue(value any) any {
	switch typed := value.(type) {
	case string:
		return strings.ReplaceAll(typed, "\\", "/")
	case []any:
		items := make([]any, 0, len(typed))
		for _, item := range typed {
			items = append(items, normalizeUserDataValue(item))
		}
		sort.Slice(items, func(left, right int) bool {
			leftJSON, _ := json.Marshal(items[left])
			rightJSON, _ := json.Marshal(items[right])
			return string(leftJSON) < string(rightJSON)
		})
		return items
	case map[string]any:
		normalized := make(map[string]any, len(typed))
		for key, item := range typed {
			normalized[key] = normalizeUserDataValue(item)
		}
		return normalized
	default:
		return value
	}
}

func snapshotUserDataTree(t *testing.T, userRoot, mode string) map[string][]userDataEntry {
	t.Helper()
	result := map[string][]userDataEntry{}
	roots := map[string]string{"assets": filepath.Join(userRoot, "assets"), "characters": filepath.Join(userRoot, "characters")}
	if mode == "backups" {
		roots = map[string]string{"backups": filepath.Join(userRoot, "backups")}
	}
	for key, root := range roots {
		entries := make([]userDataEntry, 0)
		walkUserDataTree(t, root, "", &entries)
		sort.Slice(entries, func(left, right int) bool { return entries[left].Path < entries[right].Path })
		result[key] = entries
	}
	return result
}

func walkUserDataTree(t *testing.T, absolute, relative string, entries *[]userDataEntry) {
	t.Helper()
	directoryEntries, err := os.ReadDir(absolute)
	if err != nil {
		return
	}
	for _, entry := range directoryEntries {
		childRelative := entry.Name()
		if relative != "" {
			childRelative = relative + "/" + entry.Name()
		}
		if entry.IsDir() {
			*entries = append(*entries, userDataEntry{Path: childRelative, Kind: "directory", Size: 0})
			walkUserDataTree(t, filepath.Join(absolute, entry.Name()), childRelative, entries)
			continue
		}
		content, err := os.ReadFile(filepath.Join(absolute, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		digest := userDataSHA256(content)
		*entries = append(*entries, userDataEntry{Path: childRelative, Kind: "file", Size: int64(len(content)), Sha256: &digest})
	}
}

func compareUserDataTree(t *testing.T, label string, expected, got []userDataEntry) {
	t.Helper()
	if len(expected) != len(got) {
		t.Fatalf("%s: tree has %d entries, pinned Node left %d (got %v)", label, len(got), len(expected), got)
	}
	for index := range expected {
		if expected[index].Path != got[index].Path || expected[index].Kind != got[index].Kind || expected[index].Size != got[index].Size {
			t.Fatalf("%s: entry %d = %+v, pinned Node left %+v", label, index, got[index], expected[index])
		}
		expectedHash := ""
		if expected[index].Sha256 != nil {
			expectedHash = *expected[index].Sha256
		}
		gotHash := ""
		if got[index].Sha256 != nil {
			gotHash = *got[index].Sha256
		}
		if expectedHash != gotHash {
			t.Fatalf("%s: entry %q SHA-256 differs", label, expected[index].Path)
		}
	}
}

func userDataSHA256(value []byte) string {
	sum := sha256.Sum256(value)
	return hex.EncodeToString(sum[:])
}
