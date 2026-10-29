package server

// G-05: the pinned cache buster, observed as a response header.
//
// No capture exists for this: the pinned oracle probe boots a server whose session it would have to
// forge, and `cacheBuster.enabled` defaults to FALSE, so a recorded run of the stock server would
// contain no `Clear-Site-Data` at all. These tests are therefore a DERIVATION from the pinned source,
// labelled as such (AGENTS.md rule 4), and every expectation quotes the line it came from:
//
//	src/middleware/cacheBuster.js:28      enabled defaults to false
//	src/middleware/cacheBuster.js:29      userAgentPattern defaults to ''
//	src/middleware/cacheBuster.js:32      new RegExp(userAgentPattern, 'i')  — case-insensitive
//	src/middleware/cacheBuster.js:45-66   shouldBust: enabled, then the pattern
//	src/middleware/cacheBuster.js:61-63   no pattern => bust every agent
//	src/middleware/cacheBuster.js:72-85   the middleware: once per `${handle}-${sha256(userAgent)}`
//	src/middleware/cacheBuster.js:103     response.setHeader('Clear-Site-Data', '"cache"')
//	src/server-main.js:214                app.get('/', cacheBuster.middleware, handler)
//	src/endpoints/avatars.js:51-54        cacheBuster.bust on /api/avatars/upload with overwrite_name
//	src/endpoints/characters.js:1132      cacheBuster.bust on /api/characters/edit with a file
//	src/endpoints/characters.js:1173      cacheBuster.bust on /api/characters/edit-avatar
//
// The one thing a derivation must not do is derive its expectation from our own implementation, so the
// header VALUE is asserted as the literal `"cache"` (quotes included) in every row rather than through
// the constant the implementation uses.

import (
	"bytes"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/commandline"
	"github.com/cocokoishi/gotavern/internal/startup"
)

// pinnedClearSiteDataLiteral is the exact bytes of the header, written out independently of the
// implementation's constant so a change to that constant cannot silently redefine the expectation.
const pinnedClearSiteDataLiteral = `"cache"`

func cacheBusterTestHandler(t *testing.T, settings commandline.CacheBusterSettings) http.Handler {
	t.Helper()
	return NewHTTPHandlerWithOptions(HTTPHandlerOptions{CacheBuster: settings})
}

// TestPinnedCacheBusterOnTheIndexPage is the (enabled, pattern, user-agent) table. Each row gets a
// FRESH handler, because the middleware's key set is per-process state: reusing one handler would make
// the second row's "present" expectation unreachable.
func TestPinnedCacheBusterOnTheIndexPage(t *testing.T) {
	cases := []struct {
		name      string
		enabled   bool
		pattern   string
		userAgent string
		want      bool
		why       string
	}{
		{
			name: "disabled by config", enabled: false, pattern: "", userAgent: "Mozilla/5.0", want: false,
			why: "cacheBuster.js:28 default false, :47-49 returns false immediately",
		},
		{
			name: "disabled with a matching pattern", enabled: false, pattern: "firefox", userAgent: "Mozilla Firefox/120", want: false,
			why: "the enabled gate is checked before the pattern (:47-49)",
		},
		{
			name: "enabled with no pattern busts every agent", enabled: true, pattern: "", userAgent: "Mozilla/5.0", want: true,
			why: "cacheBuster.js:61-63 — no regex means bust",
		},
		{
			name: "enabled with no pattern busts a request with no user-agent", enabled: true, pattern: "", userAgent: "", want: true,
			why: "cacheBuster.js:58 — an absent header is the empty string, and the empty string still busts",
		},
		{
			name: "matching pattern", enabled: true, pattern: "firefox", userAgent: "Mozilla/5.0 Firefox/120", want: true,
			why: "cacheBuster.js:65 — RegExp.test is an unanchored search",
		},
		{
			name: "non-matching pattern", enabled: true, pattern: "firefox", userAgent: "Mozilla/5.0 Chrome/120", want: false,
			why: "cacheBuster.js:65",
		},
		{
			name: "pattern is case-insensitive", enabled: true, pattern: "FireFox", userAgent: "mozilla/5.0 firefox/120", want: true,
			why: "cacheBuster.js:32 — the 'i' flag",
		},
		{
			name: "alternation", enabled: true, pattern: "firefox|safari", userAgent: "Mozilla/5.0 Safari/605", want: true,
			why: "the shipped example in default/config.yaml:271",
		},
		{
			name: "unanchored match inside a longer user agent", enabled: true, pattern: "safari", userAgent: "Mozilla/5.0 (Macintosh) Safari/605", want: true,
			why: "cacheBuster.js:65 — no ^ or $ is added",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler := cacheBusterTestHandler(t, commandline.CacheBusterSettings{
				Enabled: testCase.enabled, UserAgentPattern: testCase.pattern,
			})
			request := httptest.NewRequest(http.MethodGet, "/", nil)
			if testCase.userAgent != "" {
				request.Header.Set("User-Agent", testCase.userAgent)
			}
			response := httptest.NewRecorder()
			handler.ServeHTTP(response, request)

			// The status is asserted FIRST so a refusal earlier in the chain cannot make an
			// "absent header" row pass for the wrong reason.
			if response.Code != http.StatusOK {
				t.Fatalf("GET / = %d, want 200 (body %q); the index route must be reached for this row to mean anything", response.Code, response.Body.String())
			}
			got := response.Header().Get("Clear-Site-Data")
			if testCase.want {
				if got != pinnedClearSiteDataLiteral {
					t.Errorf("Clear-Site-Data = %q, want %q (%s)", got, pinnedClearSiteDataLiteral, testCase.why)
				}
			} else if got != "" {
				t.Errorf("Clear-Site-Data = %q, want no header (%s)", got, testCase.why)
			}
		})
	}
}

// TestPinnedCacheBusterBustsOncePerUserAgent pins the once-per-key rule of the middleware
// (cacheBuster.js:72-85): the header appears on the FIRST response for a given user agent and never
// again, while a DIFFERENT user agent gets its own first response.
func TestPinnedCacheBusterBustsOncePerUserAgent(t *testing.T) {
	handler := cacheBusterTestHandler(t, commandline.CacheBusterSettings{Enabled: true})
	index := func(userAgent string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(http.MethodGet, "/", nil)
		request.Header.Set("User-Agent", userAgent)
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	first := index("agent-a")
	if first.Code != http.StatusOK {
		t.Fatalf("first GET / = %d, want 200", first.Code)
	}
	if got := first.Header().Get("Clear-Site-Data"); got != pinnedClearSiteDataLiteral {
		t.Fatalf("first response for agent-a: Clear-Site-Data = %q, want %q", got, pinnedClearSiteDataLiteral)
	}
	for attempt := 2; attempt <= 3; attempt++ {
		repeat := index("agent-a")
		if repeat.Code != http.StatusOK {
			t.Fatalf("GET / #%d = %d, want 200", attempt, repeat.Code)
		}
		if got := repeat.Header().Get("Clear-Site-Data"); got != "" {
			t.Fatalf("response #%d for the SAME user agent carried Clear-Site-Data = %q; the middleware must bust once per (handle, user-agent) pair", attempt, got)
		}
	}
	// A different user agent has a different sha256, so it is a different key.
	other := index("agent-b")
	if got := other.Header().Get("Clear-Site-Data"); got != pinnedClearSiteDataLiteral {
		t.Fatalf("first response for agent-b: Clear-Site-Data = %q, want %q (the key is `${handle}-${sha256(userAgent)}`)", got, pinnedClearSiteDataLiteral)
	}
}

// TestPinnedCacheBusterKeyIsHandlePlusUserAgentHash covers the OTHER half of the key: the same user
// agent from a different handle is a different key (cacheBuster.js:73-76). The index route cannot
// exercise this without two authenticated accounts, so the middleware itself is driven directly — the
// unit is the key derivation, and the derivation is what the row is about.
func TestPinnedCacheBusterKeyIsHandlePlusUserAgentHash(t *testing.T) {
	buster := newCacheBuster(commandline.CacheBusterSettings{Enabled: true})
	request := httptest.NewRequest(http.MethodGet, "/", nil)
	request.Header.Set("User-Agent", "shared-agent")

	first := httptest.NewRecorder()
	buster.handleIndex(first, request, "alice")
	if got := first.Header().Get("Clear-Site-Data"); got != pinnedClearSiteDataLiteral {
		t.Fatalf("alice's first request: Clear-Site-Data = %q, want %q", got, pinnedClearSiteDataLiteral)
	}

	repeat := httptest.NewRecorder()
	buster.handleIndex(repeat, request, "alice")
	if got := repeat.Header().Get("Clear-Site-Data"); got != "" {
		t.Fatalf("alice's second request carried Clear-Site-Data = %q; the key must be consumed once", got)
	}

	// Same user agent, different handle: a new key.
	otherHandle := httptest.NewRecorder()
	buster.handleIndex(otherHandle, request, "bob")
	if got := otherHandle.Header().Get("Clear-Site-Data"); got != pinnedClearSiteDataLiteral {
		t.Fatalf("bob's first request: Clear-Site-Data = %q, want %q; the handle is part of the key (cacheBuster.js:73-76)", got, pinnedClearSiteDataLiteral)
	}

	// An absent handle falls back to DEFAULT_USER.handle (constants.js:55), which is a REAL key and not
	// a missing one: two anonymous requests share it.
	anonymous := newCacheBuster(commandline.CacheBusterSettings{Enabled: true})
	for attempt, want := range []string{pinnedClearSiteDataLiteral, ""} {
		recorder := httptest.NewRecorder()
		anonymous.handleIndex(recorder, request, "")
		if got := recorder.Header().Get("Clear-Site-Data"); got != want {
			t.Fatalf("anonymous request #%d: Clear-Site-Data = %q, want %q; the fallback handle is 'default-user'", attempt+1, got, want)
		}
	}
}

// TestPinnedCacheBusterIsMountedOnTheIndexRouteOnly pins WHERE the middleware sits: pinned mounts it on
// `app.get('/')` (src/server-main.js:214) and NOT app-wide, so no other path carries the header even on
// its first request. Express also answers HEAD from a GET route
// (express/lib/router/route.js:68,83-85), so HEAD / goes through it.
func TestPinnedCacheBusterIsMountedOnTheIndexRouteOnly(t *testing.T) {
	handler := cacheBusterTestHandler(t, commandline.CacheBusterSettings{Enabled: true})
	serve := func(method, path string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, path, nil)
		request.Header.Set("User-Agent", "agent-a")
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}

	// None of these consume the index key, because none of them is the `/` route.
	for _, path := range []string{"/index.html", "/version", "/csrf-token", "/does-not-exist"} {
		response := serve(http.MethodGet, path)
		if got := response.Header().Get("Clear-Site-Data"); got != "" {
			t.Errorf("GET %s carried Clear-Site-Data = %q; the buster is mounted on the `/` route only (src/server-main.js:214)", path, got)
		}
	}

	// HEAD / is Express's automatic HEAD handler for the same route.
	head := serve(http.MethodHead, "/")
	if got := head.Header().Get("Clear-Site-Data"); got != pinnedClearSiteDataLiteral {
		t.Errorf("HEAD / carried Clear-Site-Data = %q, want %q; Express falls a HEAD request back to the GET route", got, pinnedClearSiteDataLiteral)
	}
	// And the index key is now consumed by that HEAD request.
	get := serve(http.MethodGet, "/")
	if got := get.Header().Get("Clear-Site-Data"); got != "" {
		t.Errorf("GET / after HEAD / carried Clear-Site-Data = %q; both are the same route and therefore the same key", got)
	}
}

// TestPinnedCacheBusterBustIsNotOncePerKey covers the three routes that call `bust` DIRECTLY. They do
// not go through the middleware, so they are not rate-limited by the key set: pinned calls
// `cacheBuster.bust(request, response)` on every successful image replacement
// (src/endpoints/avatars.js:53, src/endpoints/characters.js:1132, :1173).
func TestPinnedCacheBusterBustIsNotOncePerKey(t *testing.T) {
	buster := newCacheBuster(commandline.CacheBusterSettings{Enabled: true, UserAgentPattern: "firefox"})
	matching := httptest.NewRequest(http.MethodPost, "/api/avatars/upload", nil)
	matching.Header.Set("User-Agent", "Mozilla Firefox/120")
	nonMatching := httptest.NewRequest(http.MethodPost, "/api/avatars/upload", nil)
	nonMatching.Header.Set("User-Agent", "Mozilla Chrome/120")

	for attempt := 1; attempt <= 2; attempt++ {
		recorder := httptest.NewRecorder()
		buster.bust(recorder, matching)
		if got := recorder.Header().Get("Clear-Site-Data"); got != pinnedClearSiteDataLiteral {
			t.Fatalf("bust #%d with a matching user agent: Clear-Site-Data = %q, want %q; bust is not once-per-key", attempt, got, pinnedClearSiteDataLiteral)
		}
	}
	skipped := httptest.NewRecorder()
	buster.bust(skipped, nonMatching)
	if got := skipped.Header().Get("Clear-Site-Data"); got != "" {
		t.Fatalf("bust with a non-matching user agent: Clear-Site-Data = %q, want none (cacheBuster.js:65)", got)
	}

	// The shipped default: disabled, so the header is absent however the pattern is written.
	disabled := newCacheBuster(commandline.CacheBusterSettings{Enabled: false})
	recorder := httptest.NewRecorder()
	disabled.bust(recorder, matching)
	if got := recorder.Header().Get("Clear-Site-Data"); got != "" {
		t.Fatalf("disabled buster emitted Clear-Site-Data = %q; the pinned default is false (cacheBuster.js:28)", got)
	}
}

// ------------------------------------------------------------------ the three routes that call bust

// cacheBusterRouteHarness boots a real handler with accounts enabled and a logged-in default user, so
// the two image-replacement routes can be driven end to end. It exists to prove the WIRING: the unit
// tests above would stay green if no route ever called `bust`.
type cacheBusterRouteHarness struct {
	handler       http.Handler
	sessionCookie string
	csrfToken     string
	directories   map[string]string
}

func newCacheBusterRouteHarness(t *testing.T, settings commandline.CacheBusterSettings) *cacheBusterRouteHarness {
	t.Helper()
	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	const cookieSecret = "cache-buster-probe-secret"
	accountJSON, err := marshalNodeJSON(struct {
		Handle   string `json:"handle"`
		Name     string `json:"name"`
		Created  int64  `json:"created"`
		Password string `json:"password"`
		Admin    bool   `json:"admin"`
		Enabled  bool   `json:"enabled"`
		Salt     string `json:"salt"`
	}{"default-user", "Cache Buster Probe", 1700000000000, "", true, true, ""})
	if err != nil {
		t.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(cookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	// Pinned startup creates multer's staging directory; this harness does not run the full startup.
	if err := os.MkdirAll(filepath.Join(dataRoot, "_uploads"), 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: cookieSecret,
		AccountsEnabled: true, CacheBuster: settings,
	})
	harness := &cacheBusterRouteHarness{handler: handler, directories: directories}

	csrf := httptest.NewRequest(http.MethodGet, "/csrf-token", nil)
	csrfResponse := httptest.NewRecorder()
	handler.ServeHTTP(csrfResponse, csrf)
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d", csrfResponse.Code)
	}
	var token struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &token); err != nil {
		t.Fatal(err)
	}
	harness.csrfToken = token.Token
	cookieFrom := func(response *httptest.ResponseRecorder) string {
		parts := make([]string, 0, 2)
		for _, cookie := range response.Header().Values("Set-Cookie") {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfCookie := cookieFrom(csrfResponse)

	loginBody := strings.NewReader(`{"handle":"default-user","password":""}`)
	login := httptest.NewRequest(http.MethodPost, "/api/users/login", loginBody)
	login.Header.Set("Cookie", csrfCookie)
	login.Header.Set("X-CSRF-Token", token.Token)
	login.Header.Set("Content-Type", "application/json")
	loginResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginResponse, login)
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", loginResponse.Code, loginResponse.Body.String())
	}
	harness.sessionCookie = cookieFrom(loginResponse)
	return harness
}

// postMultipart sends one multipart request whose file part is named `avatar` — the pinned global multer
// field (src/server-main.js:269) — plus the given text fields.
func (harness *cacheBusterRouteHarness) postMultipart(t *testing.T, route, fileName string, fileBytes []byte, fields map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	part, err := writer.CreateFormFile("avatar", fileName)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := part.Write(fileBytes); err != nil {
		t.Fatal(err)
	}
	for name, value := range fields {
		if err := writer.WriteField(name, value); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	request := httptest.NewRequest(http.MethodPost, route, bytes.NewReader(body.Bytes()))
	request.Header.Set("Cookie", harness.sessionCookie)
	request.Header.Set("X-CSRF-Token", harness.csrfToken)
	request.Header.Set("Content-Type", writer.FormDataContentType())
	response := httptest.NewRecorder()
	harness.handler.ServeHTTP(response, request)
	return response
}

func cacheBusterProbePNG(t *testing.T) []byte {
	t.Helper()
	canvas := image.NewRGBA(image.Rect(0, 0, 4, 4))
	for y := 0; y < 4; y++ {
		for x := 0; x < 4; x++ {
			canvas.Set(x, y, color.RGBA{R: uint8(x * 16), G: uint8(y * 16), B: 120, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, canvas); err != nil {
		t.Fatal(err)
	}
	return encoded.Bytes()
}

// TestPinnedCacheBusterBustReachesTheImageRoutes is the end-to-end half: a real request through a real
// route, with the header either present (enabled) or absent (the shipped default).
//
// The `avatar_url` card for edit-avatar is written with the package's own card writer, because the
// pinned handler reads the card's JSON before it writes the new image.
func TestPinnedCacheBusterBustReachesTheImageRoutes(t *testing.T) {
	const cardJSON = `{"name":"Cache Buster Probe","description":"probe","first_mes":"hi"}`

	for _, enabled := range []bool{true, false} {
		name := "disabled"
		want := ""
		if enabled {
			name = "enabled"
			want = pinnedClearSiteDataLiteral
		}
		t.Run(name, func(t *testing.T) {
			harness := newCacheBusterRouteHarness(t, commandline.CacheBusterSettings{Enabled: enabled})

			// POST /api/avatars/upload with `overwrite_name` — pinned's conditional bust
			// (src/endpoints/avatars.js:51-54).
			upload := harness.postMultipart(t, "/api/avatars/upload", "source.png", cacheBusterProbePNG(t),
				map[string]string{"overwrite_name": "persona-probe.png"})
			if upload.Code != http.StatusOK {
				t.Fatalf("POST /api/avatars/upload = %d, body %q", upload.Code, upload.Body.String())
			}
			if got := upload.Header().Get("Clear-Site-Data"); got != want {
				t.Errorf("POST /api/avatars/upload (overwrite_name set): Clear-Site-Data = %q, want %q (src/endpoints/avatars.js:53)", got, want)
			}

			// The card /api/characters/edit-avatar reads before replacing the image.
			card, err := writePngCard(cacheBusterProbePNG(t), cardJSON)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(harness.directories["characters"], "probe.png"), card, 0o600); err != nil {
				t.Fatal(err)
			}
			editAvatar := harness.postMultipart(t, "/api/characters/edit-avatar", "new.png", cacheBusterProbePNG(t),
				map[string]string{"avatar_url": "probe.png"})
			if editAvatar.Code != http.StatusOK {
				t.Fatalf("POST /api/characters/edit-avatar = %d, body %q", editAvatar.Code, editAvatar.Body.String())
			}
			if got := editAvatar.Header().Get("Clear-Site-Data"); got != want {
				t.Errorf("POST /api/characters/edit-avatar: Clear-Site-Data = %q, want %q (src/endpoints/characters.js:1173)", got, want)
			}

			// POST /api/characters/edit with a file — pinned busts in that branch only
			// (src/endpoints/characters.js:1124-1133). The name field is `ch_name`, and pinned refuses
			// an empty one with the literal 'Error: invalid name.' (characters.js:1108-1112).
			edit := harness.postMultipart(t, "/api/characters/edit", "new.png", cacheBusterProbePNG(t),
				map[string]string{"avatar_url": "probe.png", "ch_name": "Cache Buster Probe", "chat": "probe"})
			if edit.Code != http.StatusOK {
				t.Fatalf("POST /api/characters/edit = %d, body %q", edit.Code, edit.Body.String())
			}
			if got := edit.Header().Get("Clear-Site-Data"); got != want {
				t.Errorf("POST /api/characters/edit (file uploaded): Clear-Site-Data = %q, want %q (src/endpoints/characters.js:1132)", got, want)
			}
		})
	}
}

// TestPinnedCacheBusterEditWithoutAFileDoesNotBust is the negative half of the /api/characters/edit
// wiring: pinned calls `cacheBuster.bust` ONLY inside the `request.file` branch
// (src/endpoints/characters.js:1121-1133), so an edit that keeps the existing avatar must not carry the
// header even with the buster enabled. Without this row the wiring could bust unconditionally and stay
// green.
func TestPinnedCacheBusterEditWithoutAFileDoesNotBust(t *testing.T) {
	harness := newCacheBusterRouteHarness(t, commandline.CacheBusterSettings{Enabled: true})
	card, err := writePngCard(cacheBusterProbePNG(t), `{"name":"Cache Buster Probe","description":"probe"}`)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(harness.directories["characters"], "probe.png"), card, 0o600); err != nil {
		t.Fatal(err)
	}
	body := `{"avatar_url":"probe.png","ch_name":"Cache Buster Probe","chat":"probe"}`
	request := httptest.NewRequest(http.MethodPost, "/api/characters/edit", strings.NewReader(body))
	request.Header.Set("Cookie", harness.sessionCookie)
	request.Header.Set("X-CSRF-Token", harness.csrfToken)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	harness.handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("POST /api/characters/edit without a file = %d, body %q", response.Code, response.Body.String())
	}
	if got := response.Header().Get("Clear-Site-Data"); got != "" {
		t.Fatalf("POST /api/characters/edit without a file carried Clear-Site-Data = %q; pinned busts only in the request.file branch", got)
	}
}
