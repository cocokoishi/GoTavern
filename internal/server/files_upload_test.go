package server

import (
	"bytes"
	"encoding/base64"
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

type filesUploadFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret    string `json:"cookieSecret"`
		ReplaceOriginal string `json:"replaceOriginal"`
		Go              struct {
			Name string `json:"name"`
			Data string `json:"data"`
		} `json:"go"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		AfterNodeWrites struct {
			Files map[string]string `json:"files"`
		} `json:"afterNodeWrites"`
		GoRoundTrip struct {
			Input struct {
				Name string `json:"name"`
				Data string `json:"data"`
			} `json:"input"`
			NodeResponse accountMutationResponseFixture `json:"nodeResponse"`
			GoResponse   accountMutationResponseFixture `json:"goResponse"`
			NodeReadback accountMutationResponseFixture `json:"nodeReadback"`
			Content      string                         `json:"content"`
		} `json:"goRoundTrip"`
		AccountRecordUnchanged bool `json:"accountRecordUnchanged"`
	} `json:"state"`
}

func TestPinnedNodeFilesUpload(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-files-upload.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture filesUploadFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("files/upload oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || fixture.Inputs.ReplaceOriginal == "" || fixture.Inputs.Go.Name == "" || fixture.Inputs.Go.Data == "" {
		t.Fatal("files/upload oracle is missing required inputs")
	}
	if !reflect.DeepEqual(fixture.State.GoRoundTrip.NodeResponse, fixture.State.GoRoundTrip.GoResponse) {
		t.Fatal("Go upload response captured by the oracle differs from pinned Node")
	}
	if fixture.State.GoRoundTrip.NodeReadback.Status != http.StatusOK {
		t.Fatalf("pinned Node file readback returned %d", fixture.State.GoRoundTrip.NodeReadback.Status)
	}
	readbackBody, ok := fixture.State.GoRoundTrip.NodeReadback.Body.(map[string]any)
	if !ok || readbackBody["user/files/"+fixture.State.GoRoundTrip.Input.Name] != true {
		t.Fatalf("pinned Node did not observe the Go-written file: %#v", fixture.State.GoRoundTrip.NodeReadback.Body)
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
	}{"default-user", "Files Upload Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	replaceOriginal, err := base64.StdEncoding.DecodeString(fixture.Inputs.ReplaceOriginal)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(filesRoot, "replace.png"), replaceOriginal, 0o600); err != nil {
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
	route := "/api/files/upload"
	post := func(cookie, token string, name, data any) *httptest.ResponseRecorder {
		t.Helper()
		body, err := json.Marshal(map[string]any{"name": name, "data": data})
		if err != nil {
			t.Fatal(err)
		}
		return serve(http.MethodPost, route, cookie, token, string(body))
	}
	urlEncodedRequest := httptest.NewRequest(http.MethodPost, route, strings.NewReader("name=form.bin&data=AQIDBA%3D%3D"))
	urlEncodedRequest.Header.Set("Cookie", sessionCookie)
	urlEncodedRequest.Header.Set("X-CSRF-Token", csrf.Token)
	urlEncodedRequest.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	urlEncodedResponse := httptest.NewRecorder()
	handler.ServeHTTP(urlEncodedResponse, urlEncodedRequest)
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":       post(csrfCookie, csrf.Token, "auth.png", "AQIDBA=="),
		"invalidCSRF":        post(sessionCookie, "", "csrf.png", "AQIDBA=="),
		"wrongMethod":        serve(http.MethodGet, route, sessionCookie, "", ""),
		"wrongMethodHead":    serve(http.MethodHead, route, sessionCookie, "", ""),
		"wrongMethodOptions": serve(http.MethodOptions, route, sessionCookie, "", ""),
		"missingName":        serve(http.MethodPost, route, sessionCookie, csrf.Token, `{"data":"AQIDBA=="}`),
		"missingData":        post(sessionCookie, csrf.Token, "missing-data.bin", ""),
		"illegalName":        post(sessionCookie, csrf.Token, "bad name.bin", "AQIDBA=="),
		"forbiddenExtension": post(sessionCookie, csrf.Token, "blocked.EXE", "AQIDBA=="),
		"dotName":            post(sessionCookie, csrf.Token, ".hidden.png", "AQIDBA=="),
		"longName":           post(sessionCookie, csrf.Token, strings.Repeat("a", 256)+".bin", "AQIDBA=="),
		"nonStringName":      post(sessionCookie, csrf.Token, 42, "AQIDBA=="),
		"nonStringData":      post(sessionCookie, csrf.Token, "nonstring.bin", 42),
		"written":            post(sessionCookie, csrf.Token, "asset.png", "AQIDBA=="),
		"overwritten":        post(sessionCookie, csrf.Token, "replace.png", "BQYHCA=="),
		"looseBase64":        post(sessionCookie, csrf.Token, "loose.bin", "AQID!junk==??"),
		"urlSafeBase64":      post(sessionCookie, csrf.Token, "url-safe.bin", "-_8="),
		"emptyDecodedBase64": post(sessionCookie, csrf.Token, "empty.bin", "!"),
		"urlEncoded":         urlEncodedResponse,
	}
	for label, response := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("files/upload fixture has no %q response", label)
		}
		assertAccountMutationResponse(t, label, response, want)
	}
	for filename, expected := range fixture.State.AfterNodeWrites.Files {
		contents, err := os.ReadFile(filepath.Join(filesRoot, filename))
		if err != nil {
			t.Fatal(err)
		}
		if got := base64.StdEncoding.EncodeToString(contents); got != expected {
			t.Errorf("uploaded file %q bytes = %q; pinned Node has %q", filename, got, expected)
		}
	}

	goInput := fixture.State.GoRoundTrip.Input
	goResponse := post(sessionCookie, csrf.Token, goInput.Name, goInput.Data)
	assertAccountMutationResponse(t, "Go file upload response", goResponse, fixture.State.GoRoundTrip.NodeResponse)
	goFileBytes, err := os.ReadFile(filepath.Join(filesRoot, goInput.Name))
	if err != nil {
		t.Fatal(err)
	}
	if got := base64.StdEncoding.EncodeToString(goFileBytes); got != fixture.State.GoRoundTrip.Content {
		t.Fatalf("Go file upload bytes = %q; pinned Node has %q", got, fixture.State.GoRoundTrip.Content)
	}

	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("file upload changed the account storage record")
	}
}
