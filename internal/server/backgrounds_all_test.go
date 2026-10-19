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
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type backgroundsAllFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret        string            `json:"cookieSecret"`
		Files               map[string]string `json:"files"`
		FixedMtime          float64           `json:"fixedMtime"`
		IndexTemplate       string            `json:"indexTemplate"`
		ThumbnailDimensions map[string]any    `json:"thumbnailDimensions"`
		RoundTripFilename   string            `json:"roundTripFilename"`
		RoundTripContent    string            `json:"roundTripContent"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		IndexAfterMain         any  `json:"indexAfterMain"`
		IndexUnchangedOnRepeat bool `json:"indexUnchangedOnRepeat"`
		GoRoundTrip            struct {
			GoResponse   accountMutationResponseFixture `json:"goResponse"`
			NodeReadback accountMutationResponseFixture `json:"nodeReadback"`
			IndexAfter   any                            `json:"indexAfter"`
		} `json:"goRoundTrip"`
		AccountRecordUnchanged bool `json:"accountRecordUnchanged"`
	} `json:"state"`
}

func TestPinnedNodeBackgroundsAll(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-backgrounds-all.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture backgroundsAllFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("backgrounds/all oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Files) == 0 || fixture.Inputs.IndexTemplate == "" || fixture.Inputs.RoundTripContent == "" {
		t.Fatal("backgrounds/all oracle is missing required inputs")
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
	}{"default-user", "Background Listing Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	backgroundsRoot := directories["backgrounds"]
	fixedTime := time.UnixMilli(int64(fixture.Inputs.FixedMtime))
	for filename, encoded := range fixture.Inputs.Files {
		content, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatalf("decode background fixture %q: %v", filename, err)
		}
		if err := os.WriteFile(filepath.Join(backgroundsRoot, filename), content, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(filepath.Join(backgroundsRoot, filename), fixedTime, fixedTime); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.Mkdir(filepath.Join(backgroundsRoot, "folder.png"), 0o755); err != nil {
		t.Fatal(err)
	}
	cachedInfo, err := os.Stat(filepath.Join(backgroundsRoot, "cached.png"))
	if err != nil {
		t.Fatal(err)
	}
	cachedMtime := nodeStatMtimeMilliseconds(cachedInfo.ModTime())
	indexText := strings.ReplaceAll(fixture.Inputs.IndexTemplate, `"__CACHED_MTIME__"`, strconv.FormatFloat(cachedMtime, 'f', -1, 64))
	indexText = strings.ReplaceAll(indexText, `"__STALE_MTIME__"`, strconv.FormatFloat(cachedMtime-1000, 'f', -1, 64))
	indexPath := filepath.Join(directories["root"], imageMetadataIndexFilename)
	if err := os.WriteFile(indexPath, []byte(indexText), 0o600); err != nil {
		t.Fatal(err)
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret,
		AccountsEnabled: true, ImageMetadataThumbnailDimensions: fixture.Inputs.ThumbnailDimensions,
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
	route := "/api/backgrounds/all"
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":       serve(http.MethodPost, route, csrfCookie, csrf.Token, []byte(`{}`)),
		"invalidCSRF":        serve(http.MethodPost, route, sessionCookie, "", []byte(`{}`)),
		"wrongMethod":        serve(http.MethodGet, route, sessionCookie, "", nil),
		"wrongMethodHead":    serve(http.MethodHead, route, sessionCookie, "", nil),
		"wrongMethodOptions": serve(http.MethodOptions, route, sessionCookie, "", nil),
		"main":               serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{}`)),
	}
	indexAfterMain, err := readNormalizedBackgroundIndex(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	indexInfoBeforeRepeat, err := os.Stat(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	responses["repeat"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{}`))
	indexInfoAfterRepeat, err := os.Stat(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	indexUnchangedOnRepeat := indexInfoBeforeRepeat.ModTime().Equal(indexInfoAfterRepeat.ModTime())
	if indexUnchangedOnRepeat != fixture.State.IndexUnchangedOnRepeat {
		t.Fatalf("background metadata index mtime unchanged on repeat = %t; pinned Node has %t", indexUnchangedOnRepeat, fixture.State.IndexUnchangedOnRepeat)
	}
	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("backgrounds/all fixture has no %q response", label)
		}
		assertAccountMutationResponse(t, label, got, want)
	}
	if !reflect.DeepEqual(indexAfterMain, fixture.State.IndexAfterMain) {
		t.Fatalf("background metadata index after main listing = %#v; pinned Node has %#v", indexAfterMain, fixture.State.IndexAfterMain)
	}

	roundTripBytes, err := base64.StdEncoding.DecodeString(fixture.Inputs.RoundTripContent)
	if err != nil {
		t.Fatal(err)
	}
	roundTripPath := filepath.Join(backgroundsRoot, fixture.Inputs.RoundTripFilename)
	roundTripTime := fixedTime.Add(5 * time.Minute)
	if err := os.WriteFile(roundTripPath, roundTripBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(roundTripPath, roundTripTime, roundTripTime); err != nil {
		t.Fatal(err)
	}
	index, err := decodeOrderedNodeJSON(mustReadFile(t, indexPath))
	if err != nil {
		t.Fatal(err)
	}
	images, exists := index.member("images")
	if !exists || images.kind != 'o' {
		t.Fatal("background metadata index has no images object")
	}
	images.setMember(filepath.ToSlash(filepath.Join("backgrounds", fixture.Inputs.RoundTripFilename)), orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
		{key: "mtime", value: orderedNodeJSON{kind: 'v', scalar: float64(-1)}},
		{key: "folderIds", value: orderedNodeJSON{kind: 'a', array: []orderedNodeJSON{{kind: 's', scalar: "keep-roundtrip"}}}},
		{key: "unknownCacheField", value: orderedNodeJSON{kind: 's', scalar: "replaced by Go generation"}},
	}})
	index.setMember("images", images)
	indexBytes, err := marshalPrettyOrderedNodeJSON(index, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, indexBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	goResponse := serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{}`))
	assertAccountMutationResponse(t, "Go round-trip backgrounds/all", goResponse, fixture.State.GoRoundTrip.GoResponse)
	nodeReadback := serve(http.MethodPost, "/api/image-metadata", sessionCookie, csrf.Token, []byte(`{"paths":["backgrounds/roundtrip.png"],"type":"bg"}`))
	assertBackgroundMetadataReadback(t, nodeReadback, fixture.State.GoRoundTrip.NodeReadback)
	indexAfterRoundTrip, err := readNormalizedBackgroundIndex(indexPath)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(indexAfterRoundTrip, fixture.State.GoRoundTrip.IndexAfter) {
		t.Fatalf("background metadata index after Go write/Node readback = %#v; pinned Node has %#v", indexAfterRoundTrip, fixture.State.GoRoundTrip.IndexAfter)
	}
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("background listing changed the account storage record")
	}
}

func mustReadFile(t *testing.T, path string) []byte {
	t.Helper()
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return content
}

func readNormalizedBackgroundIndex(path string) (any, error) {
	content, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var value any
	if err := json.Unmarshal(content, &value); err != nil {
		return nil, err
	}
	normalizeBackgroundMetadataTimestamps(&value)
	return value, nil
}

func normalizeBackgroundMetadataTimestamps(value *any) {
	switch current := (*value).(type) {
	case map[string]any:
		for key, item := range current {
			if key == "addedTimestamp" || key == "mtime" {
				if _, numeric := item.(float64); numeric {
					current[key] = "__" + strings.ToUpper(key) + "__"
					continue
				}
			}
			normalizeBackgroundMetadataTimestamps(&item)
			current[key] = item
		}
		*value = current
	case []any:
		for index := range current {
			item := current[index]
			normalizeBackgroundMetadataTimestamps(&item)
			current[index] = item
		}
		*value = current
	}
}

func assertBackgroundMetadataReadback(t *testing.T, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
	t.Helper()
	var body any
	if got.Body.Len() > 0 {
		if err := json.Unmarshal(got.Body.Bytes(), &body); err != nil {
			body = got.Body.String()
		}
	}
	normalizeBackgroundMetadataTimestamps(&body)
	headers := stableAccountBackupHeaders(got.Header())
	if want.Headers["etag"] == "__METADATA_ETAG__" {
		headers["etag"] = "__METADATA_ETAG__"
	}
	if got.Code != want.Status || !reflect.DeepEqual(headers, want.Headers) || !reflect.DeepEqual(body, want.Body) {
		t.Fatalf("Go image-metadata readback differs from pinned Node:\n status=%d want=%d\n headers=%#v want=%#v\n body=%#v want=%#v", got.Code, want.Status, headers, want.Headers, body, want.Body)
	}
}
