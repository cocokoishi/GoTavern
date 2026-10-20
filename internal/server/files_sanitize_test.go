package server

import (
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

func TestPinnedNodeFileSanitizeFilename(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-files-sanitize-filename.json"))
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
		t.Fatalf("files/sanitize-filename oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" {
		t.Fatal("files/sanitize-filename oracle is missing its cookie secret")
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
	}{"default-user", "File Sanitize Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	route := "/api/files/sanitize-filename"
	jsonType := "application/json"
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":       serve(http.MethodPost, route, csrfCookie, csrf.Token, jsonType, `{"fileName":"avatar?.png"}`),
		"invalidCSRF":        serve(http.MethodPost, route, sessionCookie, "", jsonType, `{"fileName":"avatar?.png"}`),
		"wrongMethod":        serve(http.MethodGet, route, sessionCookie, "", "", ""),
		"wrongMethodHead":    serve(http.MethodHead, route, sessionCookie, "", "", ""),
		"wrongMethodOptions": serve(http.MethodOptions, route, sessionCookie, "", "", ""),
		"sanitized":          serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonType, `{"fileName":"../avatar?name<>.png"}`),
		"unicode":            serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonType, `{"fileName":"森の背景.png"}`),
		"missingField":       serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonType, `{}`),
		"emptyValue":         serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonType, `{"fileName":""}`),
		"nullValue":          serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonType, `{"fileName":null}`),
		"booleanValue":       serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonType, `{"fileName":false}`),
		"numberValue":        serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonType, `{"fileName":42}`),
		"arrayValue":         serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonType, `{"fileName":["a","b",null]}`),
		"objectValue":        serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonType, `{"fileName":{"nested":true}}`),
		"coercionError":      serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonType, `{"fileName":{"toString":1}}`),
		"urlEncoded":         serve(http.MethodPost, route, sessionCookie, csrf.Token, "application/x-www-form-urlencoded", "fileName=avatar%2Ffile%3F.png"),
		"repeatedUrlEncoded": serve(http.MethodPost, route, sessionCookie, csrf.Token, "application/x-www-form-urlencoded", "fileName=first.png&fileName=second.png"),
		"emptyJSON":          serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonType, ""),
		"noBody":             serve(http.MethodPost, route, sessionCookie, csrf.Token, "", ""),
		"malformedJSON":      serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonType, "{"),
		"primitiveJSON":      serve(http.MethodPost, route, sessionCookie, csrf.Token, jsonType, `"value"`),
	}
	for label, response := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("files/sanitize-filename fixture has no %q response", label)
		}
		if label == "malformedJSON" || label == "primitiveJSON" {
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
	if !reflect.DeepEqual(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("file name sanitization changed the account storage record")
	}
}
