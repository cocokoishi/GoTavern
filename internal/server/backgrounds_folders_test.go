package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type backgroundsFoldersFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string                     `json:"cookieSecret"`
		Indexes      map[string]json.RawMessage `json:"indexes"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		IndexUnchanged         map[string]bool `json:"indexUnchanged"`
		AccountRecordUnchanged bool            `json:"accountRecordUnchanged"`
	} `json:"state"`
}

func TestPinnedNodeBackgroundFoldersListing(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-backgrounds-folders.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture backgroundsFoldersFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("background-folders oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Indexes) == 0 || len(fixture.Responses) == 0 {
		t.Fatal("background-folders oracle is missing required inputs")
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
	}{"default-user", "Background Folder Reader", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	indexPath := filepath.Join(directories["root"], backgroundImageMetadataFile)

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
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, []byte(`{"handle":"default-user","password":""}`))
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookieFrom(login.Header().Values("Set-Cookie"))
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":    serve(http.MethodPost, "/api/backgrounds/folders", csrfCookie, csrf.Token, []byte(`{}`)),
		"invalidCSRF":     serve(http.MethodPost, "/api/backgrounds/folders", sessionCookie, "", []byte(`{}`)),
		"wrongMethod":     serve(http.MethodGet, "/api/backgrounds/folders", sessionCookie, "", nil),
		"wrongMethodHead": serve(http.MethodHead, "/api/backgrounds/folders", sessionCookie, "", nil),
	}
	indexUnchanged := make(map[string]bool, len(fixture.Inputs.Indexes))
	for label, rawContent := range fixture.Inputs.Indexes {
		if bytes.Equal(bytes.TrimSpace(rawContent), []byte("null")) {
			if err := os.Remove(indexPath); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
		} else {
			var content string
			if err := json.Unmarshal(rawContent, &content); err != nil {
				t.Fatalf("decode %s metadata index fixture: %v", label, err)
			}
			if err := os.WriteFile(indexPath, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		before, beforeErr := os.ReadFile(indexPath)
		if os.IsNotExist(beforeErr) {
			before = nil
		} else if beforeErr != nil {
			t.Fatal(beforeErr)
		}
		responses[label] = serve(http.MethodPost, "/api/backgrounds/folders", sessionCookie, csrf.Token, []byte(`{}`))
		after, afterErr := os.ReadFile(indexPath)
		if os.IsNotExist(afterErr) {
			after = nil
		} else if afterErr != nil {
			t.Fatal(afterErr)
		}
		indexUnchanged[label] = (before == nil && after == nil) || (before != nil && after != nil && bytes.Equal(before, after))
		if want, exists := fixture.State.IndexUnchanged[label]; !exists || !want || !indexUnchanged[label] {
			t.Fatalf("metadata index %q changed during read: got unchanged=%v, pinned=%v", label, indexUnchanged[label], want)
		}
	}
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("background-folder listing changed the account storage record")
	}
	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("background-folders fixture has no response %q", label)
		}
		assertAvatarResponse(t, "background folders "+label, got, want)
	}
	if !reflect.DeepEqual(indexUnchanged, fixture.State.IndexUnchanged) {
		t.Fatalf("index state = %#v; pinned Node has %#v", indexUnchanged, fixture.State.IndexUnchanged)
	}
}
