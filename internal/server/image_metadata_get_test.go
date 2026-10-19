package server

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"math"
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
	Index          string          `json:"index"`
	Body           json.RawMessage `json:"body"`
	GeneratedPaths []string        `json:"generatedPaths"`
	GoUnsupported  bool            `json:"goUnsupported"`
}

type imageMetadataGetFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret   string                          `json:"cookieSecret"`
		Indexes        map[string]json.RawMessage      `json:"indexes"`
		Cases          map[string]imageMetadataGetCase `json:"cases"`
		GeneratedFiles map[string]string               `json:"generatedFiles"`
		CachedMtime    float64                         `json:"cachedMtime"`
		UncachedMtime  float64                         `json:"uncachedMtime"`
		GoRoundTrip    struct {
			Index          string          `json:"index"`
			Body           json.RawMessage `json:"body"`
			GeneratedPaths []string        `json:"generatedPaths"`
		} `json:"goRoundTrip"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		FileContentsAfter      map[string]*string `json:"fileContentsAfter"`
		MtimeUnchanged         map[string]bool    `json:"mtimeUnchanged"`
		AccountRecordUnchanged bool               `json:"accountRecordUnchanged"`
		GoRoundTrip            struct {
			GoResponse   accountMutationResponseFixture `json:"goResponse"`
			NodeReadback accountMutationResponseFixture `json:"nodeReadback"`
			FileContent  string                         `json:"fileContent"`
		} `json:"goRoundTrip"`
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
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Indexes) == 0 || len(fixture.Inputs.Cases) == 0 || len(fixture.Inputs.GeneratedFiles) == 0 {
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
	for relativePath, base64Content := range fixture.Inputs.GeneratedFiles {
		contents, err := base64.StdEncoding.DecodeString(base64Content)
		if err != nil {
			t.Fatalf("decode generated image fixture %q: %v", relativePath, err)
		}
		fullPath := filepath.Join(userRoot, filepath.FromSlash(relativePath))
		if err := os.MkdirAll(filepath.Dir(fullPath), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(fullPath, contents, 0o600); err != nil {
			t.Fatal(err)
		}
		fixedTime := nodeTimeFromMilliseconds(fixture.Inputs.CachedMtime)
		if err := os.Chtimes(fullPath, fixedTime, fixedTime); err != nil {
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
		if len(probeCase.GeneratedPaths) > 0 && !probeCase.GoUnsupported {
			assertImageMetadataGetAddedTimestamps(t, userRoot, got, probeCase.GeneratedPaths)
		}
		afterMtime, err := os.Stat(indexPath)
		if err != nil {
			t.Fatal(err)
		}
		unchanged := beforeMtime.ModTime().Equal(afterMtime.ModTime())
		if probeCase.GoUnsupported {
			if !unchanged {
				t.Fatalf("unsupported-format metadata request %s unexpectedly wrote the index", label)
			}
		} else if unchanged != fixture.State.MtimeUnchanged[label] {
			t.Fatalf("metadata-get mtime state for %s disagrees with pinned Node", label)
		}
		gotContent := normalizedImageMetadataIndexFile(t, indexPath)
		if len(probeCase.GeneratedPaths) > 0 {
			gotContent = normalizedImageMetadataGetIndexFile(t, indexPath, probeCase.GeneratedPaths)
		}
		wantContent, hasWant := fixture.State.FileContentsAfter[label]
		if probeCase.GoUnsupported {
			wantContent = &content
			hasWant = true
		}
		if !hasWant || !reflect.DeepEqual(gotContent, wantContent) {
			t.Fatalf("metadata-get index after %s = %q; pinned Node has %q", label, imageMetadataContent(gotContent), imageMetadataContent(wantContent))
		}
		if !probeCase.GoUnsupported {
			assertImageMetadataGetResponse(t, label, got, fixture.Responses[label])
		}
	}
	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("metadata-get fixture has no response %q", label)
		}
		switch label {
		case "wrongMethodOptions":
			assertImageMetadataGetOptionsGap(t, got, want)
		case "singleUnsupportedBmp":
			assertImageMetadataUnsupportedFormatGap(t, label, got, want)
		default:
			assertImageMetadataGetResponse(t, label, got, want)
		}
	}
	if fixture.Inputs.GoRoundTrip.Index == "" || len(fixture.Inputs.GoRoundTrip.Body) == 0 || len(fixture.Inputs.GoRoundTrip.GeneratedPaths) == 0 {
		t.Fatal("image-metadata get oracle has no Go-to-Node round-trip input")
	}
	if err := os.WriteFile(indexPath, []byte(fixture.Inputs.GoRoundTrip.Index), 0o600); err != nil {
		t.Fatal(err)
	}
	goGenerated := serve(http.MethodPost, route, sessionCookie, csrf.Token, fixture.Inputs.GoRoundTrip.Body)
	assertImageMetadataGetAddedTimestamps(t, userRoot, goGenerated, fixture.Inputs.GoRoundTrip.GeneratedPaths)
	assertImageMetadataGetResponse(t, "Go metadata generation round trip", goGenerated, fixture.State.GoRoundTrip.GoResponse)
	nodeReadback := serve(http.MethodPost, route, sessionCookie, csrf.Token, fixture.Inputs.GoRoundTrip.Body)
	assertImageMetadataGetResponse(t, "Node metadata generation readback", nodeReadback, fixture.State.GoRoundTrip.NodeReadback)
	goRoundTripFile := normalizedImageMetadataGetIndexFile(t, indexPath, fixture.Inputs.GoRoundTrip.GeneratedPaths)
	if goRoundTripFile == nil || *goRoundTripFile != fixture.State.GoRoundTrip.FileContent {
		t.Fatalf("Go-generated image metadata index = %q; pinned Node readback has %q", imageMetadataContent(goRoundTripFile), fixture.State.GoRoundTrip.FileContent)
	}
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("image-metadata get changed the account record")
	}
}

func nodeTimeFromMilliseconds(value float64) time.Time {
	seconds := int64(math.Floor(value / 1e3))
	nanoseconds := int64(math.Round((value - float64(seconds)*1e3) * 1e6))
	return time.Unix(seconds, nanoseconds)
}

func imageMetadataContent(value *string) string {
	if value == nil {
		return "<missing>"
	}
	return *value
}

func normalizedImageMetadataGetIndexFile(t *testing.T, path string, generatedPaths []string) *string {
	t.Helper()
	body, err := os.ReadFile(path)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		t.Fatal(err)
	}
	index, err := decodeOrderedNodeJSON(body)
	if err != nil {
		t.Fatal(err)
	}
	images, exists := index.member("images")
	if !exists {
		t.Fatalf("generated image metadata index has no images member")
	}
	for _, generatedPath := range generatedPaths {
		metadata, exists := images.member(generatedPath)
		if !exists {
			continue
		}
		metadata.setMember("addedTimestamp", orderedNodeJSON{kind: 's', scalar: "__ADDED_TIMESTAMP__"})
		images.setMember(generatedPath, metadata)
	}
	index.setMember("images", images)
	normalized, err := marshalPrettyOrderedNodeJSON(index, 0)
	if err != nil {
		t.Fatal(err)
	}
	value := string(normalized)
	return &value
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
	if want.Headers["etag"] == "__ADDED_TIMESTAMP_ETAG__" {
		gotHeaders["etag"] = "__ADDED_TIMESTAMP_ETAG__"
	}
	normalizeGeneratedImageMetadataTimestamps(&gotBody, want.Body)
	if got.Code != want.Status || !reflect.DeepEqual(gotHeaders, want.Headers) || !reflect.DeepEqual(gotBody, want.Body) {
		t.Fatalf("image-metadata get response %s differs from pinned Node:\n status=%d want=%d\n headers=%#v want=%#v\n body=%#v want=%#v", label, got.Code, want.Status, gotHeaders, want.Headers, gotBody, want.Body)
	}
}

func normalizeGeneratedImageMetadataTimestamps(actual *any, expected any) {
	actualMap, actualIsMap := (*actual).(map[string]any)
	expectedMap, expectedIsMap := expected.(map[string]any)
	if actualIsMap && expectedIsMap {
		for key, expectedValue := range expectedMap {
			if key == "addedTimestamp" && expectedValue == "__ADDED_TIMESTAMP__" {
				actualMap[key] = expectedValue
				continue
			}
			if actualValue, exists := actualMap[key]; exists {
				normalizeGeneratedImageMetadataTimestamps(&actualValue, expectedValue)
				actualMap[key] = actualValue
			}
		}
		*actual = actualMap
		return
	}
	actualArray, actualIsArray := (*actual).([]any)
	expectedArray, expectedIsArray := expected.([]any)
	if actualIsArray && expectedIsArray {
		for index := range expectedArray {
			if index >= len(actualArray) {
				break
			}
			value := actualArray[index]
			normalizeGeneratedImageMetadataTimestamps(&value, expectedArray[index])
			actualArray[index] = value
		}
		*actual = actualArray
	}
}

func assertImageMetadataGetAddedTimestamps(t *testing.T, userRoot string, response *httptest.ResponseRecorder, generatedPaths []string) {
	t.Helper()
	var body any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	bodyMap, isMap := body.(map[string]any)
	if !isMap {
		t.Fatalf("generated metadata response is not an object: %#v", body)
	}
	for _, relativePath := range generatedPaths {
		_, isSingle := bodyMap["hash"]
		var metadata map[string]any
		if isSingle {
			metadata = bodyMap
		} else {
			value, exists := bodyMap[relativePath]
			if !exists {
				t.Fatalf("generated metadata response has no path %q: %#v", relativePath, bodyMap)
			}
			metadata, _ = value.(map[string]any)
		}
		if metadata == nil {
			t.Fatalf("generated metadata for %q is not an object", relativePath)
		}
		actualTimestamp, ok := metadata["addedTimestamp"].(float64)
		if !ok {
			t.Fatalf("generated metadata for %q has no numeric addedTimestamp", relativePath)
		}
		fullPath := filepath.Join(userRoot, filepath.FromSlash(relativePath))
		fileStat, err := os.Stat(fullPath)
		if err != nil {
			t.Fatal(err)
		}
		expectedTimestamp := math.Floor(nodeStatMtimeMilliseconds(fileStat.ModTime()))
		if birthtime := nodeFileBirthtimeMilliseconds(fullPath, fileStat); birthtime != 0 {
			expectedTimestamp = math.Floor(birthtime)
		}
		if actualTimestamp != expectedTimestamp {
			t.Fatalf("generated metadata addedTimestamp for %q = %.0f; expected pinned birthtime/mtime rule %.0f", relativePath, actualTimestamp, expectedTimestamp)
		}
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

func assertImageMetadataUnsupportedFormatGap(t *testing.T, label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
	t.Helper()
	if want.Status != http.StatusOK {
		t.Fatalf("pinned supported-format metadata response %s changed: status=%d body=%#v", label, want.Status, want.Body)
	}
	if got.Code != http.StatusNotImplemented || !strings.Contains(got.Body.String(), imageMetadataGenerationUnsupportedMessage) {
		t.Fatalf("Go unsupported-format response %s = %d %q", label, got.Code, got.Body.String())
	}
}
