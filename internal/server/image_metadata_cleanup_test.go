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

type imageMetadataCleanupFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string                     `json:"cookieSecret"`
		Indexes      map[string]json.RawMessage `json:"indexes"`
		Cases        map[string]string          `json:"cases"`
		GoRoundTrip  struct {
			Index string `json:"index"`
		} `json:"goRoundTripInput"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		FileContentsAfter        map[string]*string `json:"fileContentsAfter"`
		FileExistsBeforeAndAfter map[string]struct {
			Before bool `json:"before"`
			After  bool `json:"after"`
		} `json:"fileExistsBeforeAndAfter"`
		MtimeUnchanged         map[string]bool `json:"mtimeUnchanged"`
		AccountRecordUnchanged bool            `json:"accountRecordUnchanged"`
		GoRoundTrip            struct {
			GoResponse        accountMutationResponseFixture `json:"goResponse"`
			NodeIndexReadback accountMutationResponseFixture `json:"nodeIndexReadback"`
			FileContent       string                         `json:"fileContent"`
		} `json:"goRoundTrip"`
	} `json:"state"`
}

func TestPinnedNodeImageMetadataCleanup(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-image-metadata-cleanup.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture imageMetadataCleanupFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("image-metadata cleanup oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Indexes) == 0 || len(fixture.Inputs.Cases) == 0 {
		t.Fatal("image-metadata cleanup oracle is missing required inputs")
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
	}{"default-user", "Image Metadata Cleanup Admin", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	indexPath := filepath.Join(userRoot, imageMetadataIndexFilename)
	backgroundsRoot := filepath.Join(userRoot, "backgrounds")
	if err := os.MkdirAll(filepath.Join(backgroundsRoot, "nested"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, item := range []struct{ path, content string }{
		{filepath.Join(backgroundsRoot, "forest.webp"), "keep"},
		{filepath.Join(backgroundsRoot, "nested", "keep.webp"), "keep"},
		{filepath.Join(dataRoot, "escape.webp"), "outside user root"},
	} {
		if err := os.WriteFile(item.path, []byte(item.content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
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
	const route = "/api/image-metadata/cleanup"
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":       serve(http.MethodPost, route, csrfCookie, csrf.Token, []byte(`{}`)),
		"invalidCSRF":        serve(http.MethodPost, route, sessionCookie, "", []byte(`{}`)),
		"wrongMethod":        serve(http.MethodGet, route, sessionCookie, "", nil),
		"wrongMethodHead":    serve(http.MethodHead, route, sessionCookie, "", nil),
		"wrongMethodOptions": serve(http.MethodOptions, route, sessionCookie, "", nil),
	}
	fixedTime := time.Date(2001, time.February, 3, 4, 5, 6, 0, time.UTC)
	for label, indexName := range fixture.Inputs.Cases {
		rawIndex, exists := fixture.Inputs.Indexes[indexName]
		if !exists {
			t.Fatalf("cleanup case %q references missing index fixture %q", label, indexName)
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
			if err := os.Chtimes(indexPath, fixedTime, fixedTime); err != nil {
				t.Fatal(err)
			}
		}
		existsBefore := fileExists(indexPath)
		var mtimeBefore time.Time
		if existsBefore {
			info, err := os.Stat(indexPath)
			if err != nil {
				t.Fatal(err)
			}
			mtimeBefore = info.ModTime()
		}
		responses[label] = serve(http.MethodPost, route, sessionCookie, csrf.Token, nil)
		existsAfter := fileExists(indexPath)
		mtimeSame := existsBefore == existsAfter
		if existsBefore && existsAfter {
			info, err := os.Stat(indexPath)
			if err != nil {
				t.Fatal(err)
			}
			mtimeSame = mtimeSame && mtimeBefore.Equal(info.ModTime())
		}
		if existsBefore != fixture.State.FileExistsBeforeAndAfter[label].Before || existsAfter != fixture.State.FileExistsBeforeAndAfter[label].After {
			t.Fatalf("cleanup file existence for %s = (%v,%v); pinned Node has (%v,%v)", label, existsBefore, existsAfter, fixture.State.FileExistsBeforeAndAfter[label].Before, fixture.State.FileExistsBeforeAndAfter[label].After)
		}
		if mtimeSame != fixture.State.MtimeUnchanged[label] {
			t.Fatalf("cleanup mtime unchanged for %s = %v; pinned Node has %v", label, mtimeSame, fixture.State.MtimeUnchanged[label])
		}
		gotContent := normalizedImageMetadataIndexFile(t, indexPath)
		wantContent, hasWant := fixture.State.FileContentsAfter[label]
		if !hasWant || !reflect.DeepEqual(gotContent, wantContent) {
			t.Fatalf("cleanup index after %s = %#v; pinned Node has %#v", label, gotContent, wantContent)
		}
		assertImageMetadataCleanupResponse(t, label, responses[label], fixture.Responses[label])
	}
	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("cleanup fixture has no response %q", label)
		}
		assertImageMetadataCleanupResponse(t, label, got, want)
	}

	if err := os.WriteFile(indexPath, []byte(fixture.Inputs.GoRoundTrip.Index), 0o600); err != nil {
		t.Fatal(err)
	}
	goCleanup := serve(http.MethodPost, route, sessionCookie, csrf.Token, nil)
	assertImageMetadataCleanupResponse(t, "Go round trip response", goCleanup, fixture.State.GoRoundTrip.GoResponse)
	nodeReadback := serve(http.MethodPost, "/api/image-metadata/all", sessionCookie, csrf.Token, []byte(`{}`))
	assertImageMetadataCleanupResponse(t, "Node index readback", nodeReadback, fixture.State.GoRoundTrip.NodeIndexReadback)
	gotRoundTripFile := normalizedImageMetadataIndexFile(t, indexPath)
	if gotRoundTripFile == nil || *gotRoundTripFile != fixture.State.GoRoundTrip.FileContent {
		t.Fatalf("Go cleanup metadata index = %#v; pinned Node has %q", gotRoundTripFile, fixture.State.GoRoundTrip.FileContent)
	}
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("image-metadata cleanup changed the account record")
	}
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func assertImageMetadataCleanupResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
	t.Helper()
	var gotBody any
	if got.Body.Len() > 0 {
		if err := json.Unmarshal(got.Body.Bytes(), &gotBody); err != nil {
			gotBody = got.Body.String()
		}
	}
	gotHeaders := stableAccountBackupHeaders(got.Header())
	if got.Code != want.Status || !reflect.DeepEqual(gotHeaders, want.Headers) || !reflect.DeepEqual(gotBody, want.Body) {
		t.Fatalf("image-metadata cleanup response %s differs from pinned Node:\n status=%d want=%d\n headers=%#v want=%#v\n body=%#v want=%#v", label, got.Code, want.Status, gotHeaders, want.Headers, gotBody, want.Body)
	}
}
