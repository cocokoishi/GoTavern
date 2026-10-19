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

type imageMetadataFolderDeleteRequest struct {
	Index string          `json:"index"`
	Body  json.RawMessage `json:"body"`
}

type imageMetadataFolderDeleteFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string                                      `json:"cookieSecret"`
		Indexes      map[string]json.RawMessage                  `json:"indexes"`
		Cases        map[string]imageMetadataFolderDeleteRequest `json:"cases"`
		GoRoundTrip  struct {
			Index string          `json:"index"`
			Body  json.RawMessage `json:"body"`
		} `json:"goRoundTripInput"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		FileContentsAfter      map[string]*string `json:"fileContentsAfter"`
		AccountRecordUnchanged bool               `json:"accountRecordUnchanged"`
		GoRoundTrip            struct {
			GoResponse          accountMutationResponseFixture `json:"goResponse"`
			NodeFoldersReadback accountMutationResponseFixture `json:"nodeFoldersReadback"`
			NodeIndexReadback   accountMutationResponseFixture `json:"nodeIndexReadback"`
			FileContent         string                         `json:"fileContent"`
		} `json:"goRoundTrip"`
	} `json:"state"`
}

func TestPinnedNodeImageMetadataFolderDelete(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-image-metadata-folder-delete.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture imageMetadataFolderDeleteFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("image-metadata folder-delete oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Indexes) == 0 || len(fixture.Inputs.Cases) == 0 {
		t.Fatal("image-metadata folder-delete oracle is missing required inputs")
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
	}{"default-user", "Image Metadata Folder Deleter", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	indexPath := filepath.Join(directories["root"], imageMetadataIndexFilename)
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true})
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
	const route = "/api/image-metadata/folders/delete"
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":       serve(http.MethodPost, route, csrfCookie, csrf.Token, []byte(`{"id":"alpha"}`)),
		"invalidCSRF":        serve(http.MethodPost, route, sessionCookie, "", []byte(`{"id":"alpha"}`)),
		"wrongMethod":        serve(http.MethodGet, route, sessionCookie, "", nil),
		"wrongMethodHead":    serve(http.MethodHead, route, sessionCookie, "", nil),
		"wrongMethodOptions": serve(http.MethodOptions, route, sessionCookie, "", nil),
	}
	for label, probeRequest := range fixture.Inputs.Cases {
		rawIndex, exists := fixture.Inputs.Indexes[probeRequest.Index]
		if !exists {
			t.Fatalf("folder-delete case %q references missing index fixture %q", label, probeRequest.Index)
		}
		if bytes.Equal(bytes.TrimSpace(rawIndex), []byte("null")) {
			if err := os.Remove(indexPath); err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
		} else {
			var content string
			if err := json.Unmarshal(rawIndex, &content); err != nil {
				t.Fatalf("decode %s index input: %v", label, err)
			}
			if err := os.WriteFile(indexPath, []byte(content), 0o600); err != nil {
				t.Fatal(err)
			}
		}
		responses[label] = serve(http.MethodPost, route, sessionCookie, csrf.Token, probeRequest.Body)
		assertImageMetadataFolderDeleteResponse(t, label, responses[label], fixture.Responses[label])
		gotContent := normalizedImageMetadataIndexFile(t, indexPath)
		wantContent, hasWant := fixture.State.FileContentsAfter[label]
		if !hasWant || !reflect.DeepEqual(gotContent, wantContent) {
			t.Fatalf("folder-delete index after %s = %#v; pinned Node has %#v", label, gotContent, wantContent)
		}
	}
	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("folder-delete fixture has no response %q", label)
		}
		assertImageMetadataFolderDeleteResponse(t, label, got, want)
	}

	if err := os.WriteFile(indexPath, []byte(fixture.Inputs.GoRoundTrip.Index), 0o600); err != nil {
		t.Fatal(err)
	}
	goDelete := serve(http.MethodPost, route, sessionCookie, csrf.Token, fixture.Inputs.GoRoundTrip.Body)
	assertImageMetadataFolderDeleteResponse(t, "Go round trip response", goDelete, fixture.State.GoRoundTrip.GoResponse)
	foldersReadback := serve(http.MethodPost, "/api/image-metadata/folders/get", sessionCookie, csrf.Token, []byte(`{}`))
	assertImageMetadataFolderDeleteResponse(t, "Go round trip folders readback", foldersReadback, fixture.State.GoRoundTrip.NodeFoldersReadback)
	indexReadback := serve(http.MethodPost, "/api/image-metadata/all", sessionCookie, csrf.Token, []byte(`{}`))
	assertImageMetadataFolderDeleteResponse(t, "Go round trip index readback", indexReadback, fixture.State.GoRoundTrip.NodeIndexReadback)
	gotRoundTripFile := normalizedImageMetadataIndexFile(t, indexPath)
	if gotRoundTripFile == nil || *gotRoundTripFile != fixture.State.GoRoundTrip.FileContent {
		t.Fatalf("Go round trip metadata index = %#v; pinned Node has %q", gotRoundTripFile, fixture.State.GoRoundTrip.FileContent)
	}
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("image-metadata folder delete changed the account record")
	}
}

func assertImageMetadataFolderDeleteResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
	t.Helper()
	var gotBody any
	if got.Body.Len() > 0 {
		if err := json.Unmarshal(got.Body.Bytes(), &gotBody); err != nil {
			gotBody = got.Body.String()
		}
	}
	gotHeaders := stableAccountBackupHeaders(got.Header())
	if got.Code != want.Status || !reflect.DeepEqual(gotHeaders, want.Headers) || !reflect.DeepEqual(gotBody, want.Body) {
		t.Fatalf("image-metadata folder-delete response %s differs from pinned Node:\n status=%d want=%d\n headers=%#v want=%#v\n body=%#v want=%#v", label, got.Code, want.Status, gotHeaders, want.Headers, gotBody, want.Body)
	}
}
