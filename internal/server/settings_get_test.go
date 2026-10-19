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

type settingsGetFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string `json:"cookieSecret"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		FilesystemUnchanged    bool `json:"filesystemUnchanged"`
		AccountRecordUnchanged bool `json:"accountRecordUnchanged"`
	} `json:"state"`
}

func TestPinnedNodeSettingsGetAggregation(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-settings-get.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture settingsGetFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("settings-get oracle baseline = %+v", fixture.Baseline)
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
	}{"default-user", "Settings Reader", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	settingsContent := []byte("{\"settings\":\"exact raw settings\",\"unknown\":{\"keep\":true}}\n")
	if err := os.WriteFile(filepath.Join(directories["root"], "settings.json"), settingsContent, 0o644); err != nil {
		t.Fatal(err)
	}
	write := func(directory, name, contents string) {
		t.Helper()
		if err := os.WriteFile(filepath.Join(directories[directory], name), []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("openAI_Settings", "alpha.json", "{\n  \"marker\": \"openai alpha\",\n  \"nested\": { \"value\": 1 }\n}\n")
	write("openAI_Settings", "beta.json", `{"marker":"openai beta"}`)
	write("openAI_Settings", "invalid.json", "{not valid json")
	write("openAI_Settings", "ignored.JSON", `{"marker":"uppercase extension"}`)
	write("novelAI_Settings", "novel.json", `{"marker":"novel preset"}`)
	write("koboldAI_Settings", "kobold.json", `{"marker":"kobold preset"}`)
	write("textGen_Settings", "textgen.json", `{"marker":"textgen preset"}`)
	write("worlds", "alpha.json", "not parsed by settings/get")
	write("worlds", "beta.JSON", "also not parsed")
	write("worlds", "ignored.txt", "ignored")
	write("themes", "dark.json", `{ "name": "dark", "colors": ["black", "white"] }`)
	write("themes", "invalid.json", "{bad")
	write("themes", "ignored.JSON", `{"name":"ignored"}`)
	write("movingUI", "layout.json", `{"layout":"compact"}`)
	write("quickreplies", "quick.json", `[{"label":"hello"}]`)
	write("instruct", "template.json", `{ "name": "chat", "input": "{{prompt}}" }`)
	write("context", "context.json", `{"name":"default context"}`)
	write("sysprompt", "system.json", `{"name":"system"}`)
	write("reasoning", "reasoning.json", `{"name":"reasoning"}`)

	enabled := true
	extensionsEnabled := false
	extensionsAutoUpdate := false
	compressionMin := "1.5kb"
	compressionMax := "3.5mb"
	compressionTimeout := 1234.5
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret,
		AccountsEnabled:   true,
		ExtensionsEnabled: &extensionsEnabled, ExtensionsAutoUpdate: &extensionsAutoUpdate,
		RequestCompressionEnabled: &enabled, RequestCompressionMin: compressionMin,
		RequestCompressionMax: compressionMax, RequestCompressionTimeout: compressionTimeout,
	})
	serve := func(method, route, cookie, token string, body any) *httptest.ResponseRecorder {
		t.Helper()
		var requestBody strings.Reader
		if body != nil {
			encoded, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			requestBody = *strings.NewReader(string(encoded))
		}
		request := httptest.NewRequest(method, route, &requestBody)
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
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, map[string]string{"handle": "default-user", "password": ""})
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookieFrom(login.Header().Values("Set-Cookie"))
	userTreeBefore := accountCreateSnapshot(t, directories["root"])
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized": serve(http.MethodPost, "/api/settings/get", csrfCookie, csrf.Token, map[string]any{}),
		"settings":     serve(http.MethodPost, "/api/settings/get", sessionCookie, csrf.Token, map[string]any{}),
	}
	userTreeAfter := accountCreateSnapshot(t, directories["root"])
	filesystemUnchanged := reflect.DeepEqual(userTreeBefore, userTreeAfter)
	if err := os.Remove(filepath.Join(directories["root"], "settings.json")); err != nil {
		t.Fatal(err)
	}
	responses["missingSettings"] = serve(http.MethodPost, "/api/settings/get", sessionCookie, csrf.Token, map[string]any{})
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	accountRecordUnchanged := bytes.Equal(accountRecordBefore, accountRecordAfter)
	if !filesystemUnchanged || !accountRecordUnchanged || !fixture.State.FilesystemUnchanged || !fixture.State.AccountRecordUnchanged {
		t.Fatalf("settings/get changed persistent data: tree=%t record=%t pinned tree=%t record=%t", filesystemUnchanged, accountRecordUnchanged, fixture.State.FilesystemUnchanged, fixture.State.AccountRecordUnchanged)
	}

	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("settings-get fixture has no response %q", label)
		}
		assertSettingsGetResponse(t, label, got, want)
	}
}

func assertSettingsGetResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
	t.Helper()
	gotBody := any(nil)
	if got.Body.Len() > 0 {
		if json.Unmarshal(got.Body.Bytes(), &gotBody) != nil {
			gotBody = got.Body.String()
		}
	}
	gotHeaders := stableAccountBackupHeaders(got.Header())
	wantHeaders := cloneStringMap(want.Headers)
	if label == "settings" {
		// The pinned server compresses this JSON response. Go response
		// compression remains a separately inventoried middleware gap.
		delete(gotHeaders, "content-length")
		delete(wantHeaders, "content-length")
		delete(wantHeaders, "content-encoding")
		delete(wantHeaders, "transfer-encoding")
	}
	if got.Code != want.Status || !reflect.DeepEqual(gotHeaders, wantHeaders) || !reflect.DeepEqual(gotBody, want.Body) {
		t.Fatalf("settings/get response %s differs from pinned Node:\n status=%d want=%d\n headers=%#v want=%#v\n body=%#v want=%#v", label, got.Code, want.Status, gotHeaders, wantHeaders, gotBody, want.Body)
	}
}
