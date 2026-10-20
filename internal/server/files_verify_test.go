package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func TestPinnedNodeFilesVerify(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-files-verify.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Baseline struct {
			Version string `json:"version"`
			Commit  string `json:"commit"`
		} `json:"baseline"`
		Inputs struct {
			CookieSecret string   `json:"cookieSecret"`
			Paths        []string `json:"paths"`
		} `json:"inputs"`
		Responses map[string]accountMutationResponseFixture `json:"responses"`
		State     struct {
			AccountRecordUnchanged bool `json:"accountRecordUnchanged"`
		} `json:"state"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("files/verify oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Paths) == 0 {
		t.Fatal("files/verify oracle is missing inputs")
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
	}{"default-user", "Files Verify Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	if err := os.MkdirAll(filepath.Join(directories["user"], "files2"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(filesRoot, "directory"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filesRoot, "existing.bin"), []byte("existing file"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directories["user"], "files2", "prefix.txt"), []byte("prefix sibling"), 0o600); err != nil {
		t.Fatal(err)
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
	})
	serve := func(method, route, cookie, token, body string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, route, strings.NewReader(body))
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		if token != "" {
			request.Header.Set("X-CSRF-Token", token)
		}
		if body != "" {
			request.Header.Set("Content-Type", "application/json")
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", "")
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
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, `{"handle":"default-user","password":""}`)
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookieFrom(login.Header().Values("Set-Cookie"))
	route := "/api/files/verify"
	requestBody, err := json.Marshal(map[string]any{"urls": fixture.Inputs.Paths})
	if err != nil {
		t.Fatal(err)
	}
	unauthorizedBody, _ := json.Marshal(map[string]any{"urls": fixture.Inputs.Paths})
	unauthorized := httptest.NewRequest(http.MethodPost, route, bytes.NewReader(unauthorizedBody))
	unauthorized.Header.Set("Cookie", csrfCookie)
	unauthorized.Header.Set("X-CSRF-Token", csrf.Token)
	unauthorized.Header.Set("Content-Type", "application/json")
	unauthorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedResponse, unauthorized)
	invalidCSRF := serve(http.MethodPost, route, sessionCookie, "", string(requestBody))
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":       unauthorizedResponse,
		"invalidCSRF":        invalidCSRF,
		"wrongMethod":        serve(http.MethodGet, route, sessionCookie, "", ""),
		"wrongMethodHead":    serve(http.MethodHead, route, sessionCookie, "", ""),
		"wrongMethodOptions": serve(http.MethodOptions, route, sessionCookie, "", ""),
		"missingURLs":        serve(http.MethodPost, route, sessionCookie, csrf.Token, `{}`),
		"nonArrayURLs":       serve(http.MethodPost, route, sessionCookie, csrf.Token, `{"urls":"user/files/existing.bin"}`),
		"emptyURLs":          serve(http.MethodPost, route, sessionCookie, csrf.Token, `{"urls":[]}`),
		"mixedPaths":         serve(http.MethodPost, route, sessionCookie, csrf.Token, string(requestBody)),
		"nonStringURL":       serve(http.MethodPost, route, sessionCookie, csrf.Token, `{"urls":["user/files/existing.bin",7]}`),
		"malformedJSON":      serve(http.MethodPost, route, sessionCookie, csrf.Token, `{`),
	}
	for label, response := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("files/verify fixture has no %q response", label)
		}
		if label == "malformedJSON" || label == "nonStringURL" {
			if response.Code != want.Status {
				t.Errorf("%s status = %d; pinned Node has %d", label, response.Code, want.Status)
			}
			continue
		}
		assertAccountMutationResponse(t, label, response, want)
	}

	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("file verification changed the account storage record")
	}
}
