package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type accountPrivateResponseFixture struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    any               `json:"body"`
}

type accountPrivateCookieResponseFixture struct {
	Status         int               `json:"status"`
	Headers        map[string]string `json:"headers"`
	SetCookie      []string          `json:"setCookie"`
	SetCookieCount int               `json:"setCookieCount"`
	Body           any               `json:"body"`
}

type accountPrivateFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string `json:"cookieSecret"`
		Avatar       string `json:"avatar"`
	} `json:"inputs"`
	AnonymousMe             accountPrivateResponseFixture       `json:"anonymousMe"`
	AnonymousLogout         accountPrivateResponseFixture       `json:"anonymousLogout"`
	AuthenticatedMe         accountPrivateResponseFixture       `json:"authenticatedMe"`
	Logout                  accountPrivateCookieResponseFixture `json:"logout"`
	LoggedOutMe             accountPrivateResponseFixture       `json:"loggedOutMe"`
	DisabledMe              accountPrivateResponseFixture       `json:"disabledMe"`
	DisabledCreatedIsNumber bool                                `json:"disabledCreatedIsNumber"`
	DisabledLogout          accountPrivateCookieResponseFixture `json:"disabledLogout"`
}

func TestPinnedNodePrivateAccountProfileAndLogoutContract(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-account-private.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture accountPrivateFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("account-private oracle baseline = %+v", fixture.Baseline)
	}

	dataRoot := t.TempDir()
	storagePath := filepath.Join(dataRoot, userStorageFolder)
	if err := os.MkdirAll(storagePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	user := map[string]any{
		"handle": "default-user", "name": "Profile User", "created": int64(1700000000000),
		"password": "", "admin": true, "enabled": true, "salt": "",
	}
	writeNodeRecord := func(key string, value any) {
		t.Helper()
		body, err := json.Marshal(map[string]any{"key": key, "value": value})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(storagePath, nodeStoreFilename(key)), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeNodeRecord(userStoragePrefix+"default-user", user)
	writeNodeRecord(avatarStoragePrefix+"default-user", fixture.Inputs.Avatar)

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{DataRoot: dataRoot, AccountsEnabled: true})
	do := func(handler http.Handler, method, route, cookie, token, body string) *httptest.ResponseRecorder {
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
	csrfResponse := do(handler, http.MethodGet, "/csrf-token", "", "", "")
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d, body %q", csrfResponse.Code, csrfResponse.Body.String())
	}
	var csrfBody struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrfBody); err != nil {
		t.Fatal(err)
	}
	name := pinnedSessionCookieName(t)
	cookieFrom := func(cookies []string) string {
		t.Helper()
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfCookie := cookieFrom(csrfResponse.Header().Values("Set-Cookie"))

	anonymousMe := do(handler, http.MethodGet, "/api/users/me", csrfCookie, "", "")
	assertAccountPrivateResponse(t, "anonymous GET /api/users/me", anonymousMe, fixture.AnonymousMe)
	if got := do(handler, http.MethodPost, "/api/users/logout", csrfCookie, csrfBody.Token, "{}"); got.Code != fixture.AnonymousLogout.Status {
		t.Fatalf("anonymous POST /api/users/logout = %d; pinned Node has %d", got.Code, fixture.AnonymousLogout.Status)
	} else {
		assertAccountPrivateResponse(t, "anonymous POST /api/users/logout", got, fixture.AnonymousLogout)
	}

	login := do(handler, http.MethodPost, "/api/users/login", csrfCookie, csrfBody.Token, `{"handle":"default-user"}`)
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	loginCookies := login.Header().Values("Set-Cookie")
	if len(loginCookies) != 2 {
		t.Fatalf("login set %d cookies; expected session and signature", len(loginCookies))
	}
	loginValue := cookieValue(t, loginCookies, name)
	if got, want := cookieValue(t, loginCookies, name+".sig"), keygripSign(fixture.Inputs.CookieSecret, name+"="+loginValue); got != want {
		t.Fatalf("authenticated session signature = %q; expected %q", got, want)
	}
	activeCookie := cookieFrom(loginCookies)
	authenticatedMe := do(handler, http.MethodGet, "/api/users/me", activeCookie, "", "")
	assertAccountPrivateResponse(t, "authenticated GET /api/users/me", authenticatedMe, fixture.AuthenticatedMe)

	logout := do(handler, http.MethodPost, "/api/users/logout", activeCookie, csrfBody.Token, "{}")
	if logout.Code != fixture.Logout.Status {
		t.Fatalf("authenticated POST /api/users/logout = %d; pinned Node has %d", logout.Code, fixture.Logout.Status)
	}
	assertPinnedHeadersExcluding(t, logout.Header(), fixture.Logout.Headers, "Set-Cookie")
	assertClearedAccountCookies(t, logout.Header().Values("Set-Cookie"), name, fixture.Logout.SetCookieCount, fixture.Logout.SetCookie)
	if logout.Body.Len() != 0 || fixture.Logout.Body != nil {
		t.Fatalf("logout body = %q; pinned Node returns no content", logout.Body.String())
	}
	loggedOutMe := do(handler, http.MethodGet, "/api/users/me", "", "", "")
	assertAccountPrivateResponse(t, "logged-out GET /api/users/me", loggedOutMe, fixture.LoggedOutMe)

	disabledHandler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{DataRoot: dataRoot})
	disabledDo := func(method, route, cookie, token string) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, route, nil)
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		if token != "" {
			request.Header.Set("X-CSRF-Token", token)
		}
		response := httptest.NewRecorder()
		disabledHandler.ServeHTTP(response, request)
		return response
	}
	disabledMe := disabledDo(http.MethodGet, "/api/users/me", "", "")
	if disabledMe.Code != fixture.DisabledMe.Status {
		t.Fatalf("accounts-disabled GET /api/users/me = %d; pinned Node has %d", disabledMe.Code, fixture.DisabledMe.Status)
	}
	assertPinnedHeadersExcluding(t, disabledMe.Header(), withoutHeader(fixture.DisabledMe.Headers, "etag"), "ETag")
	var disabledBody map[string]any
	if err := json.Unmarshal(disabledMe.Body.Bytes(), &disabledBody); err != nil {
		t.Fatal(err)
	}
	created, ok := disabledBody["created"].(float64)
	if !ok || !fixture.DisabledCreatedIsNumber {
		t.Fatalf("accounts-disabled profile created = %#v; pinned Node creates a numeric timestamp", disabledBody["created"])
	}
	disabledBody["created"] = "<timestamp>"
	disabledETag := expressWeakETag(disabledMe.Body.Bytes())
	if got := disabledMe.Header().Get("ETag"); got != disabledETag || disabledETag == "" || created <= 0 {
		t.Fatalf("accounts-disabled profile ETag/timestamp = %q / %v", disabledMe.Header().Get("ETag"), created)
	}
	if !reflect.DeepEqual(disabledBody, fixture.DisabledMe.Body) {
		t.Fatalf("accounts-disabled profile body = %#v; pinned Node has %#v", disabledBody, fixture.DisabledMe.Body)
	}

	disabledCSRF := disabledDo(http.MethodGet, "/csrf-token", "", "")
	if disabledCSRF.Code != http.StatusOK {
		t.Fatalf("accounts-disabled GET /csrf-token = %d, body %q", disabledCSRF.Code, disabledCSRF.Body.String())
	}
	var disabledToken struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(disabledCSRF.Body.Bytes(), &disabledToken); err != nil {
		t.Fatal(err)
	}
	disabledLogout := disabledDo(http.MethodPost, "/api/users/logout", cookieFrom(disabledCSRF.Header().Values("Set-Cookie")), disabledToken.Token)
	if disabledLogout.Code != fixture.DisabledLogout.Status {
		t.Fatalf("accounts-disabled POST /api/users/logout = %d; pinned Node has %d", disabledLogout.Code, fixture.DisabledLogout.Status)
	}
	assertPinnedHeadersExcluding(t, disabledLogout.Header(), fixture.DisabledLogout.Headers, "Set-Cookie")
	assertClearedAccountCookies(t, disabledLogout.Header().Values("Set-Cookie"), name, fixture.DisabledLogout.SetCookieCount, fixture.DisabledLogout.SetCookie)
}

func assertAccountPrivateResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want accountPrivateResponseFixture) {
	t.Helper()
	if got.Code != want.Status {
		t.Fatalf("%s status = %d; pinned Node has %d", label, got.Code, want.Status)
	}
	assertPinnedHeaders(t, got.Header(), want.Headers)
	var body any
	if got.Body.Len() > 0 {
		if err := json.Unmarshal(got.Body.Bytes(), &body); err != nil {
			body = got.Body.String()
		}
	}
	if !reflect.DeepEqual(body, want.Body) {
		t.Fatalf("%s body = %#v; pinned Node has %#v", label, body, want.Body)
	}
}

func assertClearedAccountCookies(t *testing.T, got []string, sessionName string, wantCount int, want []string) {
	t.Helper()
	if len(got) != wantCount {
		t.Fatalf("logout set %d cookies; pinned Node sets %d: %#v", len(got), wantCount, got)
	}
	normalized := make([]string, 0, len(got))
	for _, raw := range got {
		parts := strings.Split(raw, "; ")
		name, value, found := strings.Cut(parts[0], "=")
		if !found {
			t.Fatalf("malformed logout cookie %q", raw)
		}
		switch name {
		case sessionName:
			if value != "" {
				t.Fatalf("logout session cookie is not empty: %q", raw)
			}
			name = "session-<host-hash>"
			value = "<empty>"
		case sessionName + ".sig":
			name = "session-<host-hash>.sig"
			value = "<signature>"
		default:
			t.Fatalf("unexpected logout cookie %q", raw)
		}
		parts[0] = name + "=" + value
		for index := 1; index < len(parts); index++ {
			if strings.HasPrefix(strings.ToLower(parts[index]), "expires=") {
				parts[index] = "expires=<timestamp>"
			}
		}
		normalized = append(normalized, strings.Join(parts, "; "))
	}
	if !reflect.DeepEqual(normalized, want) {
		t.Fatalf("logout cookies = %#v; pinned Node has %#v", normalized, want)
	}
}
