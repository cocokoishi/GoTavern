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
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type imageMetadataGetCase struct {
	Index string          `json:"index"`
	Body  json.RawMessage `json:"body"`
}

type imageMetadataGetFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret  string                          `json:"cookieSecret"`
		Indexes       map[string]json.RawMessage      `json:"indexes"`
		Cases         map[string]imageMetadataGetCase `json:"cases"`
		CachedMtime   float64                         `json:"cachedMtime"`
		UncachedMtime float64                         `json:"uncachedMtime"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		FileContentsAfter      map[string]*string `json:"fileContentsAfter"`
		MtimeUnchanged         map[string]bool    `json:"mtimeUnchanged"`
		AccountRecordUnchanged bool               `json:"accountRecordUnchanged"`
	} `json:"state"`
}

func TestPinnedNodeImageMetadataGetCache(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-image-metadata-get.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture imageMetadataGetFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("image-metadata get oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Indexes) == 0 || len(fixture.Inputs.Cases) == 0 {
		t.Fatal("image-metadata get oracle is missing required inputs")
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
	}{"default-user", "Image Metadata Cache Admin", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	userRoot := directories["root"]
	backgroundsRoot := filepath.Join(userRoot, "backgrounds")
	if err := os.MkdirAll(backgroundsRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	files := []struct {
		name  string
		body  string
		mtime float64
	}{
		{"cached.png", "cached bytes", fixture.Inputs.CachedMtime},
		{"uncached.png", "not an image", fixture.Inputs.UncachedMtime},
	}
	for _, item := range files {
		path := filepath.Join(backgroundsRoot, item.name)
		if err := os.WriteFile(path, []byte(item.body), 0o600); err != nil {
			t.Fatal(err)
		}
		fixedTime := time.Unix(0, int64(item.mtime*1e6))
		if err := os.Chtimes(path, fixedTime, fixedTime); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "escape.png"), []byte("outside user root"), 0o600); err != nil {
		t.Fatal(err)
	}
	indexPath := filepath.Join(userRoot, imageMetadataIndexFilename)
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
	const route = "/api/image-metadata"
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":       serve(http.MethodPost, route, csrfCookie, csrf.Token, []byte(`{}`)),
		"invalidCSRF":        serve(http.MethodPost, route, sessionCookie, "", []byte(`{}`)),
		"wrongMethod":        serve(http.MethodGet, route, sessionCookie, "", nil),
		"wrongMethodHead":    serve(http.MethodHead, route, sessionCookie, "", nil),
		"wrongMethodOptions": serve(http.MethodOptions, route, sessionCookie, "", nil),
	}
	fixedIndexTime := time.Date(2001, time.February, 3, 4, 5, 6, 0, time.UTC)
	for label, probeCase := range fixture.Inputs.Cases {
		rawIndex, exists := fixture.Inputs.Indexes[probeCase.Index]
		if !exists {
			t.Fatalf("metadata-get case %q references missing index fixture %q", label, probeCase.Index)
		}
		var content string
		if err := json.Unmarshal(rawIndex, &content); err != nil {
			t.Fatalf("decode %s index input: %v", label, err)
		}
		if err := os.WriteFile(indexPath, []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(indexPath, fixedIndexTime, fixedIndexTime); err != nil {
			t.Fatal(err)
		}
		beforeMtime, err := os.Stat(indexPath)
		if err != nil {
			t.Fatal(err)
		}
		got := serve(http.MethodPost, route, sessionCookie, csrf.Token, probeCase.Body)
		responses[label] = got
		afterMtime, err := os.Stat(indexPath)
		if err != nil {
			t.Fatal(err)
		}
		if beforeMtime.ModTime().Equal(afterMtime.ModTime()) != fixture.State.MtimeUnchanged[label] {
			t.Fatalf("metadata-get mtime state for %s disagrees with pinned Node", label)
		}
		gotContent := normalizedImageMetadataIndexFile(t, indexPath)
		wantContent, hasWant := fixture.State.FileContentsAfter[label]
		if !hasWant || !reflect.DeepEqual(gotContent, wantContent) {
			t.Fatalf("metadata-get index after %s = %#v; pinned Node has %#v", label, gotContent, wantContent)
		}
		if label != "singleUncachedInvalid" && label != "batchUncachedInvalid" {
			assertImageMetadataGetResponse(t, label, got, fixture.Responses[label])
		}
	}
	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("metadata-get fixture has no response %q", label)
		}
		switch label {
		case "singleUncachedInvalid":
			assertImageMetadataGenerationUnsupportedGap(t, label, got, want, http.StatusNotImplemented)
		case "batchUncachedInvalid":
			assertImageMetadataGenerationUnsupportedGap(t, label, got, want, http.StatusOK)
		case "wrongMethodOptions":
			assertImageMetadataGetOptionsGap(t, got, want)
		default:
			assertImageMetadataGetResponse(t, label, got, want)
		}
	}
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("image-metadata get changed the account record")
	}
}

func assertImageMetadataGetResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
	t.Helper()
	var gotBody any
	if got.Body.Len() > 0 {
		if err := json.Unmarshal(got.Body.Bytes(), &gotBody); err != nil {
			gotBody = got.Body.String()
		}
	}
	gotHeaders := stableAccountBackupHeaders(got.Header())
	if got.Code != want.Status || !reflect.DeepEqual(gotHeaders, want.Headers) || !reflect.DeepEqual(gotBody, want.Body) {
		t.Fatalf("image-metadata get response %s differs from pinned Node:\n status=%d want=%d\n headers=%#v want=%#v\n body=%#v want=%#v", label, got.Code, want.Status, gotHeaders, want.Headers, gotBody, want.Body)
	}
}

func assertImageMetadataGenerationUnsupportedGap(t *testing.T, label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture, goStatus int) {
	t.Helper()
	if label == "singleUncachedInvalid" {
		if want.Status != http.StatusNotFound {
			t.Fatalf("pinned uncached single metadata response changed: status=%d body=%#v", want.Status, want.Body)
		}
	} else if want.Status != http.StatusOK {
		t.Fatalf("pinned uncached batch metadata response changed: status=%d body=%#v", want.Status, want.Body)
	}
	if got.Code != goStatus {
		t.Fatalf("Go uncached metadata response %s = %d; documented unsupported-generation status is %d", label, got.Code, goStatus)
	}
	var body any
	if got.Body.Len() > 0 {
		if err := json.Unmarshal(got.Body.Bytes(), &body); err != nil {
			body = got.Body.String()
		}
	}
	if !strings.Contains(got.Body.String(), imageMetadataGenerationUnsupportedMessage) {
		t.Fatalf("Go uncached metadata response %s does not identify unsupported generation: %#v", label, body)
	}
}

func assertImageMetadataGetOptionsGap(t *testing.T, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
	t.Helper()
	if want.Status != http.StatusNoContent || want.Headers["access-control-allow-methods"] != "OPTIONS" {
		t.Fatalf("pinned metadata-get OPTIONS response changed: status=%d headers=%#v", want.Status, want.Headers)
	}
	if got.Code != http.StatusNotFound {
		t.Fatalf("Go metadata-get OPTIONS status = %d; documented current CORS gap expects 404", got.Code)
	}
}
