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
	"sort"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// Pinned extension static-serving oracle comparison. No value here needs
// normalization: every compared body is file bytes or a plain-text status, and
// every compared header is path-free. The Express finalhandler pages, which do
// embed host-absolute paths, are compared as status, content type and (for 416)
// Content-Range only.

type extensionsStaticResponse struct {
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	BodyBase64 string            `json:"bodyBase64"`
	BodyText   *string           `json:"bodyText"`
}

type extensionsStaticErrorPage struct {
	Status       int    `json:"status"`
	ContentType  string `json:"contentType"`
	ContentRange string `json:"contentRange"`
}

type extensionsStaticFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Normalizations []string `json:"normalizations"`
	Gaps           []string `json:"gaps"`
	Inputs         struct {
		CookieSecret          string            `json:"cookieSecret"`
		SeededUsers           []map[string]any  `json:"seededUsers"`
		FixedMtimeSeconds     int64             `json:"fixedMtimeSeconds"`
		GlobalRootPlaceholder string            `json:"globalRootPlaceholder"`
		LocalFiles            map[string]string `json:"localFiles"`
		OutsideFiles          map[string]string `json:"outsideFiles"`
	} `json:"inputs"`
	Responses       map[string]extensionsStaticResponse  `json:"responses"`
	ErrorPages      map[string]extensionsStaticErrorPage `json:"errorPages"`
	Unauthenticated map[string]extensionsStaticResponse  `json:"unauthenticated"`
	Disabled        map[string]extensionsStaticResponse  `json:"disabled"`
}

func TestPinnedNodeExtensionStaticServing(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-extensions-static.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture extensionsStaticFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("extension-static oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Responses) == 0 || len(fixture.ErrorPages) == 0 || len(fixture.Normalizations) == 0 || len(fixture.Gaps) == 0 {
		t.Fatal("extension-static oracle is missing observations, normalizations or gaps")
	}
	if fixture.Inputs.GlobalRootPlaceholder == "" || len(fixture.Inputs.LocalFiles) == 0 {
		t.Fatal("extension-static oracle is missing inputs")
	}

	// The pinned global root and the per-user root both live under a temporary
	// tree here, exactly as they do in the probe's own temporary data root.
	runtimeRoot := t.TempDir()
	dataRoot := filepath.Join(runtimeRoot, "data")
	installRoot := filepath.Join(runtimeRoot, "install")
	if err := os.MkdirAll(filepath.Join(dataRoot, "_storage"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, user := range fixture.Inputs.SeededUsers {
		handle, _ := user["handle"].(string)
		encoded, err := marshalNodeJSON(user)
		if err != nil {
			t.Fatal(err)
		}
		if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+handle, encoded); err != nil {
			t.Fatal(err)
		}
	}
	handles := make([]string, 0, len(fixture.Inputs.SeededUsers))
	for _, user := range fixture.Inputs.SeededUsers {
		handle, _ := user["handle"].(string)
		handles = append(handles, handle)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, handles); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	localRoot := directories["extensions"]
	if err := os.RemoveAll(localRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(localRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	when := time.Unix(fixture.Inputs.FixedMtimeSeconds, 0)
	for relative, encoded := range fixture.Inputs.LocalFiles {
		content, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(localRoot, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, content, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(target, when, when); err != nil {
			t.Fatal(err)
		}
	}
	for relative, encoded := range fixture.Inputs.OutsideFiles {
		content, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(directories["root"], filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, content, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(target, when, when); err != nil {
			t.Fatal(err)
		}
	}
	// The pinned checkout tracks this placeholder inside the global root; the
	// handler's global branch is reached through it.
	globalRoot := pinnedGlobalExtensionsDirectory(HTTPHandlerOptions{InstallRoot: installRoot})
	if err := os.MkdirAll(globalRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(globalRoot, fixture.Inputs.GlobalRootPlaceholder), nil, 0o600); err != nil {
		t.Fatal(err)
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
	})
	serve := func(method, route, cookie, token, contentType string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, route, bytes.NewReader(body))
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
	cookieFrom := func(cookies []string) string {
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", "", nil)
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d", csrfResponse.Code)
	}
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrf); err != nil {
		t.Fatal(err)
	}
	csrfCookie := cookieFrom(csrfResponse.Header().Values("Set-Cookie"))
	loginBody, _ := json.Marshal(map[string]string{"handle": "default-user", "password": ""})
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, "application/json", loginBody)
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	session := cookieFrom(login.Header().Values("Set-Cookie"))

	// Unlike the other extension fixtures, Last-Modified is recorded here: every
	// seeded file carries the fixture's fixed whole-second mtime, so it is a
	// property of the fixture rather than of the recording host.
	skipHeaders := map[string]bool{
		"connection": true, "date": true, "keep-alive": true,
		"set-cookie": true, "x-response-time": true,
	}
	capture := func(recorder *httptest.ResponseRecorder) extensionsStaticResponse {
		t.Helper()
		body := recorder.Body.Bytes()
		headers := make(map[string]string)
		for name, values := range recorder.Result().Header {
			lower := strings.ToLower(name)
			if skipHeaders[lower] {
				continue
			}
			headers[lower] = strings.Join(values, ", ")
		}
		var bodyText *string
		if utf8.Valid(body) {
			text := string(body)
			bodyText = &text
		}
		return extensionsStaticResponse{
			Status:     recorder.Code,
			Headers:    headers,
			BodyBase64: base64.StdEncoding.EncodeToString(body),
			BodyText:   bodyText,
		}
	}

	base := "/scripts/extensions/third-party/"
	const firefoxUserAgent = "Mozilla/5.0 (X11; Linux x86_64; rv:119.0) Gecko/20100101 Firefox/119.0"
	const chromeUserAgent = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36"
	get := func(relative string, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, base+relative, nil)
		request.Header.Set("Cookie", session)
		for name, value := range headers {
			request.Header.Set(name, value)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	responses := map[string]extensionsStaticResponse{}
	errorPages := map[string]extensionsStaticErrorPage{}
	record := func(label string, recorder *httptest.ResponseRecorder) {
		t.Helper()
		responses[label] = capture(recorder)
	}
	recordErrorPage := func(label string, recorder *httptest.ResponseRecorder) {
		t.Helper()
		errorPages[label] = extensionsStaticErrorPage{
			Status:       recorder.Code,
			ContentType:  recorder.Result().Header.Get("Content-Type"),
			ContentRange: recorder.Result().Header.Get("Content-Range"),
		}
	}

	// ---- local files, one per MIME class ---------------------------------
	record("localJs", get("static-probe/script.js", nil))
	record("localMjs", get("static-probe/module.mjs", nil))
	record("localCss", get("static-probe/style.css", nil))
	record("localJson", get("static-probe/manifest.json", nil))
	record("localHtml", get("static-probe/page.html", nil))
	record("localPng", get("static-probe/pixel.png", nil))
	record("localBinary", get("static-probe/all-bytes.bin", nil))
	record("localNoExtension", get("static-probe/no-extension", nil))
	record("localUnknownExtension", get("static-probe/unknown.zzz", nil))
	record("localMarkdown", get("static-probe/notes.md", nil))
	record("localSourceMap", get("static-probe/source.map", nil))
	record("localEmptyFile", get("static-probe/empty.txt", nil))
	record("localNested", get("static-probe/sub/nested.txt", nil))
	record("localEncodedSpace", get("static-probe/with%20space.js", nil))
	record("localMissing", get("static-probe/does-not-exist.js", nil))

	// ---- the handler's global branch --------------------------------------
	recordErrorPage("globalBranchPlaceholder", get(fixture.Inputs.GlobalRootPlaceholder, nil))
	record("globalBranchPlaceholderMissing", get("static-probe-missing/"+fixture.Inputs.GlobalRootPlaceholder, nil))

	// ---- directories ------------------------------------------------------
	record("directoryWithoutSlash", get("static-probe/sub", nil))
	record("directoryWithIndex", get("static-probe/sub/", nil))
	recordErrorPage("directoryWithoutIndex", get("static-probe/no-index/", nil))
	record("directoryNoIndexNoSlash", get("static-probe/no-index", nil))

	// ---- dotfiles ---------------------------------------------------------
	recordErrorPage("dotfileLastPart", get("static-probe/.hidden", nil))
	record("dotfileMiddlePart", get("static-probe/.git/config", nil))

	// ---- traversal --------------------------------------------------------
	record("encodedTraversal", get("%2e%2e%2fsecret.txt", nil))
	record("encodedTraversalDeep", get("%2e%2e%2f%2e%2e%2fdefault-user%2fsecret.txt", nil))
	record("encodedTraversalStaysInside", get("static-probe/%2e%2e%2fsecret.txt", nil))
	record("absolutePathSegment", get("%2fetc%2fpasswd", nil))
	record("traversalTwoLevelsInsideRoot", get("traversal-probe/%2e%2e%2f%2e%2e%2ftraversal-probe/inside.txt", nil))

	// ---- the mount's empty wildcard --------------------------------------
	record("emptyWildcard", get("", nil))

	// ---- methods ----------------------------------------------------------
	postRequest := httptest.NewRequest(http.MethodPost, base+"static-probe/script.js", bytes.NewReader(nil))
	postRequest.Header.Set("Cookie", session)
	postRequest.Header.Set("X-CSRF-Token", csrf.Token)
	postRecorder := httptest.NewRecorder()
	handler.ServeHTTP(postRecorder, postRequest)
	record("postServesFile", postRecorder)
	headRequest := httptest.NewRequest(http.MethodHead, base+"static-probe/script.js", nil)
	headRequest.Header.Set("Cookie", session)
	headRecorder := httptest.NewRecorder()
	handler.ServeHTTP(headRecorder, headRequest)
	record("headServesHeaders", headRecorder)

	// ---- conditional requests --------------------------------------------
	etag := responses["localJs"].Headers["etag"]
	lastModified := responses["localJs"].Headers["last-modified"]
	if etag == "" || lastModified == "" {
		t.Fatalf("the Go response for a local file has no etag/last-modified: %+v", responses["localJs"].Headers)
	}
	record("conditionalIfNoneMatch", get("static-probe/script.js", map[string]string{"If-None-Match": etag}))
	record("conditionalIfNoneMatchStale", get("static-probe/script.js", map[string]string{"If-None-Match": `W/"1-1"`}))
	record("conditionalIfNoneMatchStar", get("static-probe/script.js", map[string]string{"If-None-Match": "*"}))
	record("conditionalIfModifiedSince", get("static-probe/script.js", map[string]string{"If-Modified-Since": lastModified}))
	staleSince := time.Unix(fixture.Inputs.FixedMtimeSeconds-60, 0).UTC().Format(http.TimeFormat)
	record("conditionalIfModifiedSinceStale", get("static-probe/script.js", map[string]string{"If-Modified-Since": staleSince}))
	recordErrorPage("conditionalIfMatchStale", get("static-probe/script.js", map[string]string{"If-Match": `W/"1-1"`}))
	recordErrorPage("conditionalIfUnmodifiedSinceStale", get("static-probe/script.js", map[string]string{"If-Unmodified-Since": staleSince}))
	record("conditionalNoCacheRequest", get("static-probe/script.js", map[string]string{"If-None-Match": etag, "Cache-Control": "no-cache"}))

	// ---- ranges -----------------------------------------------------------
	record("rangeFirstBytes", get("static-probe/all-bytes.bin", map[string]string{"Range": "bytes=0-9"}))
	record("rangeSuffix", get("static-probe/all-bytes.bin", map[string]string{"Range": "bytes=-10"}))
	record("rangeOpenEnded", get("static-probe/all-bytes.bin", map[string]string{"Range": "bytes=250-"}))
	recordErrorPage("rangeUnsatisfiable", get("static-probe/all-bytes.bin", map[string]string{"Range": "bytes=9999-10000"}))
	recordErrorPage("rangeMalformed", get("static-probe/all-bytes.bin", map[string]string{"Range": "bytes=abc"}))
	record("rangeMultiple", get("static-probe/all-bytes.bin", map[string]string{"Range": "bytes=0-1,4-5"}))

	// ---- user agent -------------------------------------------------------
	record("firefoxImage", get("static-probe/pixel.png", map[string]string{"User-Agent": firefoxUserAgent}))
	record("firefoxNonImage", get("static-probe/script.js", map[string]string{"User-Agent": firefoxUserAgent}))
	record("firefoxUnknownType", get("static-probe/unknown.zzz", map[string]string{"User-Agent": firefoxUserAgent}))
	record("chromeImage", get("static-probe/pixel.png", map[string]string{"User-Agent": chromeUserAgent}))
	record("firefoxImageRange", get("static-probe/pixel.png", map[string]string{"User-Agent": firefoxUserAgent, "Range": "bytes=0-3"}))

	// ---- unauthenticated --------------------------------------------------
	unauthenticated := map[string]extensionsStaticResponse{}
	anonymous := func(relative string) extensionsStaticResponse {
		t.Helper()
		return capture(serve(http.MethodGet, base+relative, "", "", "", nil))
	}
	unauthenticated["localFile"] = anonymous("static-probe/script.js")
	unauthenticated["missing"] = anonymous("static-probe/nope.js")
	unauthenticated["globalPlaceholder"] = anonymous(fixture.Inputs.GlobalRootPlaceholder)

	// ---- extensions.enabled = false --------------------------------------
	disabledHandler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret,
		AccountsEnabled: true, ExtensionsEnabled: boolPointer(false),
	})
	serveDisabled := func(method, route, cookie, token, contentType string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, route, bytes.NewReader(body))
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
		disabledHandler.ServeHTTP(response, request)
		return response
	}
	disabledCSRF := serveDisabled(http.MethodGet, "/csrf-token", "", "", "", nil)
	var disabledToken struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(disabledCSRF.Body.Bytes(), &disabledToken); err != nil {
		t.Fatal(err)
	}
	disabledLogin := serveDisabled(http.MethodPost, "/api/users/login", cookieFrom(disabledCSRF.Header().Values("Set-Cookie")), disabledToken.Token, "application/json", loginBody)
	if disabledLogin.Code != http.StatusOK {
		t.Fatalf("disabled-handler login = %d, body %q", disabledLogin.Code, disabledLogin.Body.String())
	}
	disabledSession := cookieFrom(disabledLogin.Header().Values("Set-Cookie"))
	disabledGet := func(relative string, withSession bool) extensionsStaticResponse {
		t.Helper()
		cookie := ""
		if withSession {
			cookie = disabledSession
		}
		return capture(serveDisabled(http.MethodGet, base+relative, cookie, "", "", nil))
	}
	disabled := map[string]extensionsStaticResponse{}
	disabled["localFile"] = disabledGet("static-probe/script.js", true)
	disabled["globalPlaceholder"] = disabledGet(fixture.Inputs.GlobalRootPlaceholder, true)
	disabled["traversal"] = disabledGet("static-probe/%2e%2e%2fsecret.txt", true)
	disabled["emptyWildcard"] = disabledGet("", true)
	disabled["unauthenticated"] = disabledGet("static-probe/script.js", false)

	// ---- comparisons ------------------------------------------------------
	if len(responses) != len(fixture.Responses) {
		t.Errorf("the test recorded %d responses but the oracle has %d", len(responses), len(fixture.Responses))
	}
	for _, label := range sortedExtensionsStaticLabels(fixture.Responses) {
		want, exists := fixture.Responses[label]
		if !exists {
			continue
		}
		got, recorded := responses[label]
		if !recorded {
			t.Errorf("the test did not record %q", label)
			continue
		}
		if got.Status != want.Status {
			t.Errorf("%s status = %d; pinned Node has %d", label, got.Status, want.Status)
		}
		if !reflect.DeepEqual(got.Headers, want.Headers) {
			t.Errorf("%s headers = %s; pinned Node has %s", label, formatAny(got.Headers), formatAny(want.Headers))
		}
		if got.BodyBase64 != want.BodyBase64 {
			t.Errorf("%s body bytes differ: got %d bytes, pinned Node has %d bytes", label, len(got.BodyBase64), len(want.BodyBase64))
		}
		if !reflect.DeepEqual(got.BodyText, want.BodyText) {
			t.Errorf("%s bodyText = %s; pinned Node has %s", label, formatAny(got.BodyText), formatAny(want.BodyText))
		}
	}
	for _, label := range sortedExtensionsStaticErrorLabels(fixture.ErrorPages) {
		want, exists := fixture.ErrorPages[label]
		if !exists {
			continue
		}
		got, recorded := errorPages[label]
		if !recorded {
			t.Errorf("the test did not record error page %q", label)
			continue
		}
		if got.Status != want.Status {
			t.Errorf("error page %s status = %d; pinned Node has %d", label, got.Status, want.Status)
		}
		if got.ContentType != want.ContentType {
			t.Errorf("error page %s content type = %q; pinned Node has %q", label, got.ContentType, want.ContentType)
		}
		if got.ContentRange != want.ContentRange {
			t.Errorf("error page %s content range = %q; pinned Node has %q", label, got.ContentRange, want.ContentRange)
		}
	}
	for _, label := range sortedExtensionsStaticLabels(fixture.Unauthenticated) {
		want := fixture.Unauthenticated[label]
		got, recorded := unauthenticated[label]
		if !recorded {
			t.Errorf("the test did not record unauthenticated %q", label)
			continue
		}
		if got.Status != want.Status || !reflect.DeepEqual(got.Headers, want.Headers) || got.BodyBase64 != want.BodyBase64 {
			t.Errorf("unauthenticated %s = %d %s; pinned Node has %d %s", label, got.Status, formatAny(got.Headers), want.Status, formatAny(want.Headers))
		}
	}
	for _, label := range sortedExtensionsStaticLabels(fixture.Disabled) {
		want := fixture.Disabled[label]
		got, recorded := disabled[label]
		if !recorded {
			t.Errorf("the test did not record disabled %q", label)
			continue
		}
		if got.Status != want.Status || !reflect.DeepEqual(got.Headers, want.Headers) || got.BodyBase64 != want.BodyBase64 {
			t.Errorf("disabled %s = %d %s; pinned Node has %d %s", label, got.Status, formatAny(got.Headers), want.Status, formatAny(want.Headers))
		}
	}
}

func sortedExtensionsStaticLabels(responses map[string]extensionsStaticResponse) []string {
	labels := make([]string, 0, len(responses))
	for label := range responses {
		labels = append(labels, label)
	}
	sort.Strings(labels)
	return labels
}

func sortedExtensionsStaticErrorLabels(pages map[string]extensionsStaticErrorPage) []string {
	labels := make([]string, 0, len(pages))
	for label := range pages {
		labels = append(labels, label)
	}
	sort.Strings(labels)
	return labels
}
