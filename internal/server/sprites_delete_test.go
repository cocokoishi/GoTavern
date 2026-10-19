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

	"github.com/cocokoishi/gotavern/internal/startup"
)

type spritesDeleteFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string                                `json:"cookieSecret"`
		Files        []spriteDeleteFileInput               `json:"files"`
		Requests     map[string]map[string]json.RawMessage `json:"requests"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		FileStates             map[string][]spriteDeleteFileState `json:"fileStates"`
		AccountRecordUnchanged bool                               `json:"accountRecordUnchanged"`
	} `json:"state"`
}

type spriteDeleteFileInput struct {
	Path string `json:"path"`
	Kind string `json:"kind"`
}

type spriteDeleteFileState struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	SHA256 string `json:"sha256,omitempty"`
}

func TestPinnedNodeExpressionsSpriteDeletion(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-sprites-delete.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture spritesDeleteFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("sprite-delete oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Files) == 0 || len(fixture.Inputs.Requests) == 0 {
		t.Fatal("sprite-delete oracle is missing required inputs")
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
	for _, file := range fixture.Inputs.Files {
		target := filepath.Join(charactersRoot, filepath.FromSlash(file.Path))
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		switch file.Kind {
		case "file":
			if err := os.WriteFile(target, []byte("sprite-delete-probe:"+file.Path), 0o600); err != nil {
				t.Fatal(err)
			}
		case "directory":
			if err := os.MkdirAll(target, 0o755); err != nil {
				t.Fatal(err)
			}
		default:
			t.Fatalf("unexpected sprite-delete fixture entry kind %q", file.Kind)
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

	responses := make(map[string]*httptest.ResponseRecorder)
	fileStates := make(map[string][]spriteDeleteFileState)
	fileStates["initial"] = snapshotSpriteDeleteTree(t, charactersRoot)
	actions := []struct {
		label       string
		requestName string
		cookie      string
	}{
		{label: "unauthorized", requestName: "deleteMulti", cookie: csrfCookie},
		{label: "deleteMulti", requestName: "deleteMulti"},
		{label: "deleteLabelFallback", requestName: "deleteLabelFallback"},
		{label: "deleteNested", requestName: "deleteNested"},
		{label: "deleteNoMatch", requestName: "deleteNoMatch"},
		{label: "missingDirectory", requestName: "missingDirectory"},
		{label: "invalidSubfolder", requestName: "invalidSubfolder"},
		{label: "missingFields", requestName: "missingFields"},
		{label: "emptyName", requestName: "emptyName"},
		{label: "nonStringSpriteName", requestName: "nonStringSpriteName"},
	}
	for _, action := range actions {
		body, exists := fixture.Inputs.Requests[action.requestName]
		if !exists {
			t.Fatalf("sprite-delete fixture has no request %q", action.requestName)
		}
		bodyBytes, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		cookie := action.cookie
		if cookie == "" {
			cookie = sessionCookie
		}
		responses[action.label] = serve(http.MethodPost, "/api/sprites/delete", cookie, csrf.Token, bodyBytes)
		fileStates[action.label] = snapshotSpriteDeleteTree(t, charactersRoot)
	}
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("sprite deletion changed the account storage record")
	}
	if !reflect.DeepEqual(fileStates, fixture.State.FileStates) {
		t.Fatalf("sprite file states differ from pinned Node:\n got=%+v\nwant=%+v", fileStates, fixture.State.FileStates)
	}
	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("sprite-delete fixture has no response %q", label)
		}
		assertAvatarResponse(t, "sprite-delete "+label, got, want)
	}
}

func snapshotSpriteDeleteTree(t *testing.T, root string) []spriteDeleteFileState {
	t.Helper()
	var files []spriteDeleteFileState
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
		state := spriteDeleteFileState{Path: filepath.ToSlash(relative), Kind: "other"}
		switch {
		case info.IsDir():
			state.Kind = "directory"
		case info.Mode().IsRegular():
			state.Kind = "file"
			body, err := os.ReadFile(target)
			if err != nil {
				return err
			}
			digest := sha256.Sum256(body)
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
