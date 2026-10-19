package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type spritesGetFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret          string            `json:"cookieSecret"`
		ModifiedAtUnixSeconds int64             `json:"modifiedAtUnixSeconds"`
		Files                 []spriteFileInput `json:"files"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		FileState              []spriteFileState `json:"fileState"`
		FilesUnchanged         bool              `json:"filesUnchanged"`
		AccountRecordUnchanged bool              `json:"accountRecordUnchanged"`
	} `json:"state"`
}

type spriteFileInput struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type spriteFileState struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	MTime  string `json:"mtime"`
	SHA256 string `json:"sha256,omitempty"`
}

func TestPinnedNodeExpressionsSpriteListing(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-sprites-get.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture spritesGetFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("sprite-list oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || fixture.Inputs.ModifiedAtUnixSeconds == 0 || len(fixture.Inputs.Files) == 0 {
		t.Fatal("sprite-list oracle is missing required inputs")
	}

	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	accountJSON, err := marshalNodeJSON(struct {
		Handle   string         `json:"handle"`
		Name     string         `json:"name"`
		Created  int64          `json:"created"`
		Password string         `json:"password"`
		Admin    bool           `json:"admin"`
		Enabled  bool           `json:"enabled"`
		Salt     string         `json:"salt"`
		Unknown  map[string]any `json:"probeUnknownField"`
	}{"default-user", "Sprite Reader", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
	if err != nil {
		t.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		t.Fatal(err)
	}
	accountRecordPath := filepath.Join(dataRoot, userStorageFolder, nodeStoreFilename(userStoragePrefix+"default-user"))
	accountRecordBefore, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	charactersRoot := directories["characters"]
	fixedTime := time.Unix(fixture.Inputs.ModifiedAtUnixSeconds, 0)
	for _, file := range fixture.Inputs.Files {
		target := filepath.Join(charactersRoot, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		switch file.Kind {
		case "file":
			if err := os.WriteFile(target, []byte("sprite-probe:"+file.Path), 0o600); err != nil {
				t.Fatal(err)
			}
		case "directory":
			if err := os.MkdirAll(target, 0o755); err != nil {
				t.Fatal(err)
			}
		default:
			t.Fatalf("unexpected sprite fixture entry kind %q", file.Kind)
		}
		if err := os.Chtimes(target, fixedTime, fixedTime); err != nil {
			t.Fatal(err)
		}
	}
	for _, directory := range []string{filepath.Join(charactersRoot, "Alice"), filepath.Join(charactersRoot, "Alice", "Expressions")} {
		if err := os.Chtimes(directory, fixedTime, fixedTime); err != nil {
			t.Fatal(err)
		}
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret,
		AccountsEnabled: true,
	})
	serve := func(method, route, cookie, token string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, route, bytes.NewReader(body))
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		if token != "" {
			request.Header.Set("X-CSRF-Token", token)
		}
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", nil)
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d, body %q", csrfResponse.Code, csrfResponse.Body.String())
	}
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrf); err != nil {
		t.Fatal(err)
	}
	cookieFrom := func(cookies []string) string {
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfCookie := cookieFrom(csrfResponse.Header().Values("Set-Cookie"))
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, []byte("{\"handle\":\"default-user\",\"password\":\"\"}"))
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookieFrom(login.Header().Values("Set-Cookie"))
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":          serve(http.MethodGet, "/api/sprites/get?name=Alice", csrfCookie, "", nil),
		"base":                  serve(http.MethodGet, "/api/sprites/get?name=Alice", sessionCookie, "", nil),
		"nested":                serve(http.MethodGet, "/api/sprites/get?name=Alice%2FExpressions", sessionCookie, "", nil),
		"extraSubfolderSegment": serve(http.MethodGet, "/api/sprites/get?name=Alice%2FExpressions%2Fignored", sessionCookie, "", nil),
		"invalidSubfolder":      serve(http.MethodGet, "/api/sprites/get?name=Alice%2F..", sessionCookie, "", nil),
		"missing":               serve(http.MethodGet, "/api/sprites/get?name=Missing", sessionCookie, "", nil),
		"absentName":            serve(http.MethodGet, "/api/sprites/get", sessionCookie, "", nil),
	}
	fileState := snapshotSpriteTree(t, charactersRoot)
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("sprite listing changed the account storage record")
	}
	if !fixture.State.FilesUnchanged {
		t.Fatal("pinned sprite listing changed the character tree")
	}
	if !reflect.DeepEqual(fileState, fixture.State.FileState) {
		t.Fatalf("character tree state = %+v; pinned Node has %+v", fileState, fixture.State.FileState)
	}
	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("sprite fixture has no response %q", label)
		}
		assertAvatarResponse(t, "sprite "+label, got, want)
	}
}

func snapshotSpriteTree(t *testing.T, root string) []spriteFileState {
	t.Helper()
	var files []spriteFileState
	err := filepath.WalkDir(root, func(target string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if target == root {
			return nil
		}
		info, err := os.Stat(target)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(root, target)
		if err != nil {
			return err
		}
		state := spriteFileState{
			Path:  filepath.ToSlash(relative),
			Kind:  "other",
			MTime: info.ModTime().UTC().Format("2006-01-02T15:04:05.000Z"),
		}
		switch {
		case info.IsDir():
			state.Kind = "directory"
		case info.Mode().IsRegular():
			state.Kind = "file"
			digest := sha256.Sum256(mustReadSpriteFile(t, target))
			state.SHA256 = hex.EncodeToString(digest[:])
		}
		files = append(files, state)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Path < files[j].Path })
	return files
}

func mustReadSpriteFile(t *testing.T, name string) []byte {
	t.Helper()
	body, err := os.ReadFile(name)
	if err != nil {
		t.Fatal(err)
	}
	return body
}
