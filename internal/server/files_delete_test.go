package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func TestPinnedNodeFilesDelete(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-files-delete.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Baseline struct {
			Version string `json:"version"`
			Commit  string `json:"commit"`
		} `json:"baseline"`
		Inputs struct {
			CookieSecret string `json:"cookieSecret"`
			Paths        struct {
				Existing      string `json:"existing"`
				Missing       string `json:"missing"`
				Directory     string `json:"directory"`
				PrefixSibling string `json:"prefixSibling"`
				URLEncoded    string `json:"urlEncoded"`
				OutsideFiles  string `json:"outsideFiles"`
			} `json:"paths"`
		} `json:"inputs"`
		Responses map[string]accountMutationResponseFixture `json:"responses"`
		State     struct {
			Files struct {
				Existing      bool `json:"existing"`
				Missing       bool `json:"missing"`
				Directory     bool `json:"directory"`
				PrefixSibling bool `json:"prefixSibling"`
				URLEncoded    bool `json:"urlEncoded"`
				OutsideFiles  bool `json:"outsideFiles"`
			} `json:"files"`
			AccountRecordUnchanged bool `json:"accountRecordUnchanged"`
		} `json:"state"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("files/delete oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || fixture.Inputs.Paths.Existing == "" {
		t.Fatal("files/delete oracle is missing inputs")
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
	}{"default-user", "Files Delete Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	filesRoot := directories["files"]
	prefixSibling := filepath.Join(directories["user"], "files2")
	otherRoot := filepath.Join(directories["user"], "other")
	if err := os.MkdirAll(prefixSibling, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(otherRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(filesRoot, "directory"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filesRoot, "existing.txt"), []byte("existing file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filesRoot, "urlencoded.txt"), []byte("urlencoded file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(prefixSibling, "prefix.txt"), []byte("prefix sibling"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(otherRoot, "keep.txt"), []byte("outside files directory"), 0o600); err != nil {
		t.Fatal(err)
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
	})
	serve := func(method, route, cookie, token, contentType, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, route, strings.NewReader(body))
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		if token != "" {
			request.Header.Set("X-CSRF-Token", token)
		}
		if contentType != "" {
			request.Header.Set("Content-Type", contentType)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", "", "")
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
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, "application/json", `{"handle":"default-user","password":""}`)
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookieFrom(login.Header().Values("Set-Cookie"))

	route := "/api/files/delete"
	jsonContent := "application/json"
	urlencodedContent := "application/x-www-form-urlencoded"
	jsonBody := func(value any) string {
		t.Helper()
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	unauthorizedBody, _ := json.Marshal(map[string]any{"path": fixture.Inputs.Paths.Existing})
	unauthorized := httptest.NewRequest(http.MethodPost, route, bytes.NewReader(unauthorizedBody))
	unauthorized.Header.Set("Cookie", csrfCookie)
	unauthorized.Header.Set("X-CSRF-Token", csrf.Token)
	unauthorized.Header.Set("Content-Type", jsonContent)
	unauthorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedResponse, unauthorized)

	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":       unauthorizedResponse,
		"invalidCSRF":        serve(http.MethodPost, route, sessionCookie, "", jsonContent, jsonBody(map[string]any{"path": fixture.Inputs.Paths.Existing})),
		"wrongMethod":        serve(http.MethodGet, route, sessionCookie, "", "", ""),
		"wrongMethodHead":    serve(http.MethodHead, route, sessionCookie, "", "", ""),
		"wrongMethodOptions": serve(http.MethodOptions, route, sessionCookie, "", "", ""),
		"missingPath":        serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonContent, `{}`),
		"emptyPath":          serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonContent, jsonBody(map[string]any{"path": ""})),
		"nullPath":           serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonContent, jsonBody(map[string]any{"path": nil})),
		"outsideFiles":       serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonContent, jsonBody(map[string]any{"path": fixture.Inputs.Paths.OutsideFiles})),
		"missingFile":        serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonContent, jsonBody(map[string]any{"path": fixture.Inputs.Paths.Missing})),
		"directory":          serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonContent, jsonBody(map[string]any{"path": fixture.Inputs.Paths.Directory})),
		"deleteExisting":     serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonContent, jsonBody(map[string]any{"path": fixture.Inputs.Paths.Existing})),
		"deletePrefixSibling": serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonContent,
			jsonBody(map[string]any{"path": fixture.Inputs.Paths.PrefixSibling})),
		"urlEncodedDelete": serve(http.MethodPost, route, sessionCookie, csrf.Token, urlencodedContent,
			url.Values{"path": {fixture.Inputs.Paths.URLEncoded}}.Encode()),
		"nonStringPath": serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonContent, `{"path":7}`),
		"malformedJSON": serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonContent, `{`),
	}
	for label, response := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("files/delete fixture has no %q response", label)
		}
		if label == "malformedJSON" {
			if response.Code != want.Status {
				t.Errorf("%s status = %d; pinned Node has %d", label, response.Code, want.Status)
			}
			continue
		}
		assertAccountMutationResponse(t, label, response, want)
	}

	state := fixture.State
	checkExists := func(label, path string, want bool) {
		t.Helper()
		_, err := os.Stat(path)
		if got := err == nil; got != want {
			t.Errorf("%s exists = %v; pinned Node state has %v", label, got, want)
		}
	}
	checkExists("existing", filepath.Join(filesRoot, "existing.txt"), state.Files.Existing)
	checkExists("missing", filepath.Join(filesRoot, "missing.txt"), state.Files.Missing)
	checkExists("directory", filepath.Join(filesRoot, "directory"), state.Files.Directory)
	checkExists("prefixSibling", filepath.Join(prefixSibling, "prefix.txt"), state.Files.PrefixSibling)
	checkExists("urlEncoded", filepath.Join(filesRoot, "urlencoded.txt"), state.Files.URLEncoded)
	checkExists("outsideFiles", filepath.Join(otherRoot, "keep.txt"), state.Files.OutsideFiles)

	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !state.AccountRecordUnchanged {
		t.Fatal("file deletion changed the account storage record")
	}
}
