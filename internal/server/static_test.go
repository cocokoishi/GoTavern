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

// Pinned frontend static middleware oracle comparison. No compared value needs
// normalization: every compared body is file bytes, a redirect document or a
// plain-text status, and every compared header is path-free. The two responses
// that Express finalhandler renders are compared as status and content type only.

type frontendStaticResponse struct {
	Status     int               `json:"status"`
	Headers    map[string]string `json:"headers"`
	BodyBase64 string            `json:"bodyBase64"`
	BodyText   *string           `json:"bodyText"`
}

type frontendStaticErrorPage struct {
	Status      int    `json:"status"`
	ContentType string `json:"contentType"`
}

type frontendStaticFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Normalizations []string `json:"normalizations"`
	Gaps           []string `json:"gaps"`
	Inputs         struct {
		CookieSecret      string            `json:"cookieSecret"`
		SeededUsers       []map[string]any  `json:"seededUsers"`
		FixedMtimeSeconds int64             `json:"fixedMtimeSeconds"`
		SeedDirectory     string            `json:"seedDirectory"`
		PublicFiles       map[string]string `json:"publicFiles"`
		OutsidePublicFile struct {
			Relative string `json:"relative"`
			Base64   string `json:"base64"`
		} `json:"outsidePublicFile"`
	} `json:"inputs"`
	Responses  map[string]frontendStaticResponse  `json:"responses"`
	ErrorPages map[string]frontendStaticErrorPage `json:"errorPages"`
	Anonymous  map[string]frontendStaticResponse  `json:"anonymous"`
}

// frontendStaticKnownDivergences names the observations GoTavern cannot
// reproduce, with the reason. It is currently empty.
//
// The four unauthenticated 200 cases it used to hold were a real defect: the
// account gate treated a path as public only when it existed in the embedded
// vendored tree, so a file that existed only under <InstallRoot>/public was
// answered 403 where pinned answers 200 with its bytes. The gate now asks the
// static middleware's own resolution, so those cases are compared like any
// other.
//
// The mechanism is kept because a named list that FAILS when a listed case
// leaves the oracle cannot rot into a silent skip: adding a name here requires
// the oracle to record that label, and fixing a divergence means deleting the
// name rather than leaving a quietly passing assertion behind.
var frontendStaticKnownDivergences = map[string]string{}

func TestPinnedNodeFrontendStaticMiddleware(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-frontend-static.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture frontendStaticFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("frontend-static oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Responses) == 0 || len(fixture.Anonymous) == 0 || len(fixture.Normalizations) == 0 || len(fixture.Gaps) == 0 {
		t.Fatal("frontend-static oracle is missing observations, normalizations or gaps")
	}
	// The divergence list must describe the fixture, not a stale memory of it.
	for label := range frontendStaticKnownDivergences {
		name := strings.TrimPrefix(label, "anonymous.")
		_, inResponses := fixture.Responses[label]
		_, inAnonymous := fixture.Anonymous[name]
		if !inResponses && !inAnonymous {
			t.Fatalf("frontendStaticKnownDivergences names %q, which the oracle does not record", label)
		}
	}

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
	// The pinned middleware reads <serverDirectory>/public from disk, so the test
	// seeds <InstallRoot>/public with the fixture's files and the fixture's fixed
	// whole-second mtimes. That is what lets the pinned ETag, Last-Modified and
	// therefore the 304 and 412 answers be compared at all.
	when := time.Unix(fixture.Inputs.FixedMtimeSeconds, 0)
	for relative, encoded := range fixture.Inputs.PublicFiles {
		content, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(installRoot, "public", filepath.FromSlash(relative))
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

	// The pinned checkout has a real file one level above the served root, and the
	// fixture records it so the traversal assertion can discriminate: a missing
	// rejection would serve it rather than answer the application's 404.
	outsidePublic, err := base64.StdEncoding.DecodeString(fixture.Inputs.OutsidePublicFile.Base64)
	if err != nil {
		t.Fatal(err)
	}
	outsideTarget := filepath.Join(installRoot, filepath.FromSlash(fixture.Inputs.OutsidePublicFile.Relative))
	if err := os.MkdirAll(filepath.Dir(outsideTarget), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(outsideTarget, outsidePublic, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(outsideTarget, when, when); err != nil {
		t.Fatal(err)
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
	})
	serve := func(method, route, cookie, token string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, route, bytes.NewReader(nil))
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		if token != "" {
			request.Header.Set("X-CSRF-Token", token)
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
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "")
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrf); err != nil {
		t.Fatal(err)
	}
	csrfCookie := cookieFrom(csrfResponse.Header().Values("Set-Cookie"))
	loginBody, _ := json.Marshal(map[string]string{"handle": "default-user", "password": ""})
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/users/login", bytes.NewReader(loginBody))
	loginRequest.Header.Set("Cookie", csrfCookie)
	loginRequest.Header.Set("X-CSRF-Token", csrf.Token)
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRecorder := httptest.NewRecorder()
	handler.ServeHTTP(loginRecorder, loginRequest)
	if loginRecorder.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", loginRecorder.Code, loginRecorder.Body.String())
	}
	session := cookieFrom(loginRecorder.Header().Values("Set-Cookie"))

	skipHeaders := map[string]bool{
		"connection": true, "date": true, "keep-alive": true,
		"set-cookie": true, "x-response-time": true,
	}
	capture := func(recorder *httptest.ResponseRecorder) frontendStaticResponse {
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
		return frontendStaticResponse{
			Status:     recorder.Code,
			Headers:    headers,
			BodyBase64: base64.StdEncoding.EncodeToString(body),
			BodyText:   bodyText,
		}
	}
	get := func(route string, headers map[string]string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, route, bytes.NewReader(nil))
		request.Header.Set("Cookie", session)
		for name, value := range headers {
			request.Header.Set(name, value)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	base := "/" + fixture.Inputs.SeedDirectory + "/"
	globalExtensionPath := "/scripts/extensions/third-party/" + frontendStaticGlobalDirectory(fixture) + "/script.js"

	responses := map[string]frontendStaticResponse{}
	errorPages := map[string]frontendStaticErrorPage{}
	record := func(label string, recorder *httptest.ResponseRecorder) {
		t.Helper()
		responses[label] = capture(recorder)
	}
	recordErrorPage := func(label string, recorder *httptest.ResponseRecorder) {
		t.Helper()
		errorPages[label] = frontendStaticErrorPage{
			Status:      recorder.Code,
			ContentType: recorder.Result().Header.Get("Content-Type"),
		}
	}

	record("localJs", get(base+"script.js", nil))
	record("localMjs", get(base+"module.mjs", nil))
	record("localCss", get(base+"style.css", nil))
	record("localJson", get(base+"data.json", nil))
	record("localHtml", get(base+"page.html", nil))
	record("localPng", get(base+"pixel.png", nil))
	record("localBinary", get(base+"all-bytes.bin", nil))
	record("localNoExtension", get(base+"no-extension", nil))
	record("localUnknownExtension", get(base+"unknown.zzz", nil))
	record("localMarkdown", get(base+"notes.md", nil))
	record("localSourceMap", get(base+"source.map", nil))
	record("localEmptyFile", get(base+"empty.txt", nil))
	record("localNested", get(base+"sub/nested.txt", nil))
	record("globalExtensionFile", get(globalExtensionPath, nil))
	record("authenticatedMissing", get(base+"missing.js", nil))
	record("authenticatedDotfile", get(base+".hidden", nil))
	record("authenticatedPost", serve(http.MethodPost, base+"script.js", session, csrf.Token))
	record("directoryWithIndex", get(base+"with-index/", nil))
	record("directoryWithoutSlash", get(base+"with-index", nil))
	record("directoryWithoutIndex", get(base+"without-index/", nil))
	record("directoryWithoutIndexNoSlash", get(base+"without-index", nil))
	record("dotfileMiddlePart", get(base+".git/config", nil))
	record("authenticatedTraversal", get("/%2e%2e%2f"+fixture.Inputs.OutsidePublicFile.Relative, nil))

	etag := responses["localJs"].Headers["etag"]
	lastModified := responses["localJs"].Headers["last-modified"]
	if etag == "" || lastModified == "" {
		t.Fatalf("the Go response for a seeded file has no etag/last-modified: %+v", responses["localJs"].Headers)
	}
	record("conditionalIfNoneMatch", get(base+"script.js", map[string]string{"If-None-Match": etag}))
	record("conditionalIfNoneMatchStale", get(base+"script.js", map[string]string{"If-None-Match": `W/"1-1"`}))
	record("conditionalIfModifiedSince", get(base+"script.js", map[string]string{"If-Modified-Since": lastModified}))
	record("conditionalIfModifiedSinceStale", get(base+"script.js", map[string]string{"If-Modified-Since": time.Unix(fixture.Inputs.FixedMtimeSeconds-60, 0).UTC().Format(http.TimeFormat)}))
	recordErrorPage("conditionalIfMatchStale", get(base+"script.js", map[string]string{"If-Match": `W/"1-1"`}))
	record("conditionalNoCacheRequest", get(base+"script.js", map[string]string{"If-None-Match": etag, "Cache-Control": "no-cache"}))

	record("rangeFirstBytes", get(base+"all-bytes.bin", map[string]string{"Range": "bytes=0-9"}))
	record("rangeSuffix", get(base+"all-bytes.bin", map[string]string{"Range": "bytes=-10"}))
	recordErrorPage("rangeUnsatisfiable", get(base+"all-bytes.bin", map[string]string{"Range": "bytes=9999-10000"}))
	record("rangeMultiple", get(base+"all-bytes.bin", map[string]string{"Range": "bytes=0-1,4-5"}))

	headRequest := httptest.NewRequest(http.MethodHead, base+"script.js", bytes.NewReader(nil))
	headRequest.Header.Set("Cookie", session)
	headRecorder := httptest.NewRecorder()
	handler.ServeHTTP(headRecorder, headRequest)
	record("headServesHeaders", headRecorder)

	anonymous := map[string]frontendStaticResponse{}
	anonymous["scriptJs"] = capture(serve(http.MethodGet, base+"script.js", "", ""))
	anonymous["pageHtml"] = capture(serve(http.MethodGet, base+"page.html", "", ""))
	anonymous["pixelPng"] = capture(serve(http.MethodGet, base+"pixel.png", "", ""))
	anonymous["globalExtension"] = capture(serve(http.MethodGet, globalExtensionPath, "", ""))
	anonymous["missing"] = capture(serve(http.MethodGet, base+"missing.js", "", ""))
	anonymous["dotfile"] = capture(serve(http.MethodGet, base+".hidden", "", ""))
	anonymous["post"] = capture(serve(http.MethodPost, base+"script.js", "", ""))

	// ---- comparisons ------------------------------------------------------
	if len(responses) != len(fixture.Responses) {
		t.Errorf("the test recorded %d responses but the oracle has %d", len(responses), len(fixture.Responses))
	}
	for _, label := range sortedFrontendStaticLabels(fixture.Responses) {
		want := fixture.Responses[label]
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
	for _, label := range sortedFrontendStaticErrorLabels(fixture.ErrorPages) {
		want := fixture.ErrorPages[label]
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
	}
	for _, label := range sortedFrontendStaticLabels(fixture.Anonymous) {
		if reason, divergent := frontendStaticKnownDivergences["anonymous."+label]; divergent {
			t.Logf("anonymous %s is a named divergence: %s", label, reason)
			continue
		}
		want := fixture.Anonymous[label]
		got, recorded := anonymous[label]
		if !recorded {
			t.Errorf("the test did not record anonymous %q", label)
			continue
		}
		if got.Status != want.Status || !reflect.DeepEqual(got.Headers, want.Headers) || got.BodyBase64 != want.BodyBase64 {
			t.Errorf("anonymous %s = %d %s; pinned Node has %d %s", label, got.Status, formatAny(got.Headers), want.Status, formatAny(want.Headers))
		}
	}
	// The divergent observations must at least be recorded, so the divergence is
	// visible rather than absent.
	for label := range frontendStaticKnownDivergences {
		name := strings.TrimPrefix(label, "anonymous.")
		if _, recorded := anonymous[name]; !recorded {
			t.Errorf("the test did not record the divergent observation %q", label)
		}
	}
}

// frontendStaticGlobalDirectory reads the seeded global extension directory name
// out of the fixture's file list rather than hard-coding it.
func frontendStaticGlobalDirectory(fixture frontendStaticFixture) string {
	const prefix = "scripts/extensions/third-party/"
	for relative := range fixture.Inputs.PublicFiles {
		if strings.HasPrefix(relative, prefix) {
			remainder := strings.TrimPrefix(relative, prefix)
			if index := strings.IndexByte(remainder, '/'); index > 0 {
				return remainder[:index]
			}
		}
	}
	return ""
}

func sortedFrontendStaticLabels(responses map[string]frontendStaticResponse) []string {
	labels := make([]string, 0, len(responses))
	for label := range responses {
		labels = append(labels, label)
	}
	sort.Strings(labels)
	return labels
}

func sortedFrontendStaticErrorLabels(pages map[string]frontendStaticErrorPage) []string {
	labels := make([]string, 0, len(pages))
	for label := range pages {
		labels = append(labels, label)
	}
	sort.Strings(labels)
	return labels
}
