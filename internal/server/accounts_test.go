package server

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/commandline"
)

type accountSessionFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret       string `json:"cookieSecret"`
		EnableUserAccounts bool   `json:"enableUserAccounts"`
	} `json:"inputs"`
	PasswordHashVector struct {
		Password string `json:"password"`
		Salt     string `json:"salt"`
		Hash     string `json:"hash"`
	} `json:"passwordHashVector"`
	AnonymousRoot struct {
		Status      int    `json:"status"`
		Location    string `json:"location"`
		ContentType string `json:"contentType"`
		Body        string `json:"body"`
	} `json:"anonymousRoot"`
	AutoLogin struct {
		Status         int            `json:"status"`
		Location       string         `json:"location"`
		SetCookie      []string       `json:"setCookie"`
		SetCookieCount int            `json:"setCookieCount"`
		SessionPayload map[string]any `json:"sessionPayload"`
	} `json:"autoLogin"`
	InvalidatedSession struct {
		Status         int      `json:"status"`
		ContentType    string   `json:"contentType"`
		Body           string   `json:"body"`
		SetCookie      []string `json:"setCookie"`
		SetCookieCount int      `json:"setCookieCount"`
	} `json:"invalidatedSession"`
	LoginPage struct {
		Status      int               `json:"status"`
		ContentType string            `json:"contentType"`
		Headers     map[string]string `json:"headers"`
		Bytes       int               `json:"bytes"`
		SHA256      string            `json:"sha256"`
	} `json:"loginPage"`
	UnauthenticatedVersion struct {
		Status      int    `json:"status"`
		ContentType string `json:"contentType"`
		Bytes       int    `json:"bytes"`
		Body        string `json:"body"`
	} `json:"unauthenticatedVersion"`
	CSRF struct {
		Status         int               `json:"status"`
		Headers        map[string]string `json:"headers"`
		SetCookie      []string          `json:"setCookie"`
		SetCookieCount int               `json:"setCookieCount"`
		TokenBytes     int               `json:"tokenBytes"`
	} `json:"csrf"`
	UserList struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Body    []map[string]any  `json:"body"`
		Bytes   int               `json:"bytes"`
	} `json:"userList"`
	MissingLogin struct {
		Status         int               `json:"status"`
		Headers        map[string]string `json:"headers"`
		Body           map[string]string `json:"body"`
		SetCookieCount int               `json:"setCookieCount"`
	} `json:"missingLogin"`
	UnknownLogin struct {
		Status         int               `json:"status"`
		Headers        map[string]string `json:"headers"`
		Body           map[string]string `json:"body"`
		SetCookieCount int               `json:"setCookieCount"`
	} `json:"unknownLogin"`
	SuccessfulLogin struct {
		Status         int               `json:"status"`
		Headers        map[string]string `json:"headers"`
		Body           map[string]string `json:"body"`
		SetCookie      []string          `json:"setCookie"`
		SetCookieCount int               `json:"setCookieCount"`
		SessionPayload map[string]any    `json:"sessionPayload"`
	} `json:"successfulLogin"`
	AuthenticatedVersion struct {
		Status      int            `json:"status"`
		ContentType string         `json:"contentType"`
		Body        map[string]any `json:"body"`
	} `json:"authenticatedVersion"`
	AuthenticatedPing struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Bytes   int               `json:"bytes"`
	} `json:"authenticatedPing"`
}

func readAccountSessionFixture(t *testing.T) accountSessionFixture {
	t.Helper()
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-account-session.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture accountSessionFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("account session oracle baseline = %+v", fixture.Baseline)
	}
	return fixture
}

func TestPinnedNodeAccountsEnabledLoginAndSessionContract(t *testing.T) {
	fixture := readAccountSessionFixture(t)
	dataRoot := t.TempDir()
	storagePath := filepath.Join(dataRoot, userStorageFolder)
	if err := os.MkdirAll(storagePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	userRecord := []byte(`{"key":"user:default-user","value":{"handle":"default-user","name":"User","created":1700000000000,"password":"","admin":true,"enabled":true,"salt":""}}`)
	if err := os.WriteFile(filepath.Join(storagePath, nodeStoreFilename("user:default-user")), userRecord, 0o600); err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{DataRoot: dataRoot, AccountsEnabled: fixture.Inputs.EnableUserAccounts})

	rootRequest := httptest.NewRequest(http.MethodGet, "/", nil)
	rootResponse := httptest.NewRecorder()
	handler.ServeHTTP(rootResponse, rootRequest)
	if rootResponse.Code != fixture.AnonymousRoot.Status || rootResponse.Header().Get("Location") != fixture.AnonymousRoot.Location || rootResponse.Header().Get("Content-Type") != fixture.AnonymousRoot.ContentType || rootResponse.Body.String() != fixture.AnonymousRoot.Body {
		t.Fatalf("anonymous GET / = %d %q %q %q; pinned Node has %d %q %q %q", rootResponse.Code, rootResponse.Header().Get("Location"), rootResponse.Header().Get("Content-Type"), rootResponse.Body.String(), fixture.AnonymousRoot.Status, fixture.AnonymousRoot.Location, fixture.AnonymousRoot.ContentType, fixture.AnonymousRoot.Body)
	}

	autoLoginStarted := time.Now()
	autoLoginRequest := httptest.NewRequest(http.MethodGet, "/login", nil)
	autoLoginResponse := httptest.NewRecorder()
	handler.ServeHTTP(autoLoginResponse, autoLoginRequest)
	if autoLoginResponse.Code != fixture.AutoLogin.Status || autoLoginResponse.Header().Get("Location") != fixture.AutoLogin.Location {
		t.Fatalf("GET / auto-login = %d %q; pinned Node has %d %q", autoLoginResponse.Code, autoLoginResponse.Header().Get("Location"), fixture.AutoLogin.Status, fixture.AutoLogin.Location)
	}
	autoLoginCookies := autoLoginResponse.Header().Values("Set-Cookie")
	if len(autoLoginCookies) != fixture.AutoLogin.SetCookieCount {
		t.Fatalf("auto-login set %d cookies; pinned Node sets %d", len(autoLoginCookies), fixture.AutoLogin.SetCookieCount)
	}
	autoLoginCookieName := pinnedSessionCookieName(t)
	checkPinnedSessionCookieAttributes(t, autoLoginCookies, autoLoginCookieName, autoLoginStarted)
	autoLoginValue, err := base64.StdEncoding.DecodeString(cookieValue(t, autoLoginCookies, autoLoginCookieName))
	if err != nil {
		t.Fatal(err)
	}
	var autoLoginPayload map[string]any
	if err := json.Unmarshal(autoLoginValue, &autoLoginPayload); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(autoLoginPayload, fixture.AutoLogin.SessionPayload) {
		t.Fatalf("auto-login session = %#v; pinned Node has %#v", autoLoginPayload, fixture.AutoLogin.SessionPayload)
	}
	if got := normalizeAccountCookies(t, autoLoginCookies, autoLoginCookieName); !reflect.DeepEqual(got, fixture.AutoLogin.SetCookie) {
		t.Fatalf("auto-login cookies = %#v; pinned Node has %#v", got, fixture.AutoLogin.SetCookie)
	}

	loginPageRequest := httptest.NewRequest(http.MethodGet, "/login?noauto=1", nil)
	loginPageResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginPageResponse, loginPageRequest)
	if loginPageResponse.Code != fixture.LoginPage.Status || loginPageResponse.Header().Get("Content-Type") != fixture.LoginPage.ContentType || loginPageResponse.Body.Len() != fixture.LoginPage.Bytes {
		t.Fatalf("GET /login?noauto=1 = %d %q (%d bytes); pinned Node has %d %q (%d bytes)", loginPageResponse.Code, loginPageResponse.Header().Get("Content-Type"), loginPageResponse.Body.Len(), fixture.LoginPage.Status, fixture.LoginPage.ContentType, fixture.LoginPage.Bytes)
	}
	if digest := sha256.Sum256(loginPageResponse.Body.Bytes()); fmt.Sprintf("%x", digest) != fixture.LoginPage.SHA256 {
		t.Fatalf("login page SHA-256 = %x; pinned Node has %s", digest, fixture.LoginPage.SHA256)
	}
	for name, want := range fixture.LoginPage.Headers {
		if got := loginPageResponse.Header().Get(http.CanonicalHeaderKey(name)); got != want {
			t.Errorf("login page %s = %q; pinned Node has %q", name, got, want)
		}
	}

	versionRequest := httptest.NewRequest(http.MethodGet, "/version", nil)
	versionResponse := httptest.NewRecorder()
	handler.ServeHTTP(versionResponse, versionRequest)
	if versionResponse.Code != fixture.UnauthenticatedVersion.Status || versionResponse.Header().Get("Content-Type") != fixture.UnauthenticatedVersion.ContentType || versionResponse.Body.Len() != fixture.UnauthenticatedVersion.Bytes || versionResponse.Body.String() != fixture.UnauthenticatedVersion.Body {
		t.Fatalf("anonymous GET /version = %d %q %q; pinned Node has %d %q %q", versionResponse.Code, versionResponse.Header().Get("Content-Type"), versionResponse.Body.String(), fixture.UnauthenticatedVersion.Status, fixture.UnauthenticatedVersion.ContentType, fixture.UnauthenticatedVersion.Body)
	}

	csrfStarted := time.Now()
	csrfRequest := httptest.NewRequest(http.MethodGet, "/csrf-token", nil)
	csrfResponse := httptest.NewRecorder()
	handler.ServeHTTP(csrfResponse, csrfRequest)
	if csrfResponse.Code != fixture.CSRF.Status {
		t.Fatalf("account-enabled GET /csrf-token = %d; pinned Node has %d", csrfResponse.Code, fixture.CSRF.Status)
	}
	csrfCookies := csrfResponse.Header().Values("Set-Cookie")
	if len(csrfCookies) != fixture.CSRF.SetCookieCount {
		t.Fatalf("account-enabled GET /csrf-token set %d cookies; pinned Node sets %d", len(csrfCookies), fixture.CSRF.SetCookieCount)
	}
	assertPinnedHeadersExcluding(t, csrfResponse.Header(), withoutHeader(fixture.CSRF.Headers, "etag"), "Set-Cookie", "ETag")
	var csrfBody struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrfBody); err != nil {
		t.Fatal(err)
	}
	if len(csrfBody.Token) != fixture.CSRF.TokenBytes {
		t.Fatalf("account-enabled CSRF token length = %d; pinned Node has %d", len(csrfBody.Token), fixture.CSRF.TokenBytes)
	}
	name := pinnedSessionCookieName(t)
	checkPinnedSessionCookieAttributes(t, csrfCookies, name, csrfStarted)
	cookieHeader := name + "=" + cookieValue(t, csrfCookies, name) + "; " + name + ".sig=" + cookieValue(t, csrfCookies, name+".sig")
	requestHeaders := func(body string) http.Header {
		headers := make(http.Header)
		headers.Set("Cookie", cookieHeader)
		headers.Set("Content-Type", "application/json")
		headers.Set("X-CSRF-Token", csrfBody.Token)
		return headers
	}

	listRequest := httptest.NewRequest(http.MethodPost, "/api/users/list", strings.NewReader("{}"))
	listRequest.Header = requestHeaders("{}")
	listResponse := httptest.NewRecorder()
	handler.ServeHTTP(listResponse, listRequest)
	if listResponse.Code != fixture.UserList.Status || listResponse.Body.Len() != fixture.UserList.Bytes {
		t.Fatalf("POST /api/users/list = %d with %d bytes; pinned Node has %d with %d bytes", listResponse.Code, listResponse.Body.Len(), fixture.UserList.Status, fixture.UserList.Bytes)
	}
	assertPinnedHeadersExcluding(t, listResponse.Header(), withoutHeader(fixture.UserList.Headers, "etag"), "ETag")
	if got := listResponse.Header().Get("ETag"); got != expressWeakETag(listResponse.Body.Bytes()) {
		t.Fatalf("user list ETag = %q; Express format gives %q", got, expressWeakETag(listResponse.Body.Bytes()))
	}
	var listedUsers []map[string]any
	if err := json.Unmarshal(listResponse.Body.Bytes(), &listedUsers); err != nil {
		t.Fatal(err)
	}
	if len(listedUsers) != 1 || listedUsers[0]["handle"] != "default-user" || listedUsers[0]["name"] != "User" || listedUsers[0]["avatar"] != publicUserAvatar || listedUsers[0]["password"] != false {
		t.Fatalf("POST /api/users/list body = %#v; pinned Node has %#v", listedUsers, fixture.UserList.Body)
	}
	if _, ok := listedUsers[0]["created"].(float64); !ok {
		t.Fatalf("user list created field = %#v; expected a stored numeric timestamp", listedUsers[0]["created"])
	}

	loginRequest := func(body string) *http.Request {
		request := httptest.NewRequest(http.MethodPost, "/api/users/login", strings.NewReader(body))
		request.Header = requestHeaders(body)
		return request
	}
	missingLoginResponse := httptest.NewRecorder()
	handler.ServeHTTP(missingLoginResponse, loginRequest("{}"))
	if missingLoginResponse.Code != fixture.MissingLogin.Status || len(missingLoginResponse.Header().Values("Set-Cookie")) != fixture.MissingLogin.SetCookieCount {
		t.Fatalf("missing login = %d with %d cookies; pinned Node has %d with %d cookies", missingLoginResponse.Code, len(missingLoginResponse.Header().Values("Set-Cookie")), fixture.MissingLogin.Status, fixture.MissingLogin.SetCookieCount)
	}
	assertPinnedHeaders(t, missingLoginResponse.Header(), fixture.MissingLogin.Headers)
	var missingBody map[string]string
	if err := json.Unmarshal(missingLoginResponse.Body.Bytes(), &missingBody); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(missingBody, fixture.MissingLogin.Body) {
		t.Fatalf("missing-login body = %#v; pinned Node has %#v", missingBody, fixture.MissingLogin.Body)
	}

	unknownLoginResponse := httptest.NewRecorder()
	handler.ServeHTTP(unknownLoginResponse, loginRequest(`{"handle":"missing-user"}`))
	if unknownLoginResponse.Code != fixture.UnknownLogin.Status || len(unknownLoginResponse.Header().Values("Set-Cookie")) != fixture.UnknownLogin.SetCookieCount {
		t.Fatalf("unknown login = %d with %d cookies; pinned Node has %d with %d cookies", unknownLoginResponse.Code, len(unknownLoginResponse.Header().Values("Set-Cookie")), fixture.UnknownLogin.Status, fixture.UnknownLogin.SetCookieCount)
	}
	assertPinnedHeaders(t, unknownLoginResponse.Header(), fixture.UnknownLogin.Headers)
	var unknownBody map[string]string
	if err := json.Unmarshal(unknownLoginResponse.Body.Bytes(), &unknownBody); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(unknownBody, fixture.UnknownLogin.Body) {
		t.Fatalf("unknown-login body = %#v; pinned Node has %#v", unknownBody, fixture.UnknownLogin.Body)
	}

	loginResponse := httptest.NewRecorder()
	handler.ServeHTTP(loginResponse, loginRequest(`{"handle":"default-user"}`))
	if loginResponse.Code != fixture.SuccessfulLogin.Status {
		t.Fatalf("successful login status = %d; pinned Node has %d", loginResponse.Code, fixture.SuccessfulLogin.Status)
	}
	assertPinnedHeadersExcluding(t, loginResponse.Header(), fixture.SuccessfulLogin.Headers, "Set-Cookie")
	var loginBody map[string]string
	if err := json.Unmarshal(loginResponse.Body.Bytes(), &loginBody); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(loginBody, fixture.SuccessfulLogin.Body) {
		t.Fatalf("successful-login body = %#v; pinned Node has %#v", loginBody, fixture.SuccessfulLogin.Body)
	}
	loginCookies := loginResponse.Header().Values("Set-Cookie")
	if len(loginCookies) != fixture.SuccessfulLogin.SetCookieCount {
		t.Fatalf("successful login set %d cookies; pinned Node sets %d", len(loginCookies), fixture.SuccessfulLogin.SetCookieCount)
	}
	loginValue := cookieValue(t, loginCookies, name)
	if got, want := cookieValue(t, loginCookies, name+".sig"), keygripSign(fixture.Inputs.CookieSecret, name+"="+loginValue); got != want {
		t.Fatalf("authenticated session signature = %q; expected %q", got, want)
	}
	decoded, err := base64.StdEncoding.DecodeString(loginValue)
	if err != nil {
		t.Fatal(err)
	}
	var sessionPayload map[string]any
	if err := json.Unmarshal(decoded, &sessionPayload); err != nil {
		t.Fatal(err)
	}
	for key, expected := range fixture.SuccessfulLogin.SessionPayload {
		if got := sessionPayload[key]; got != expected {
			if key == "csrfToken" {
				if token, ok := got.(string); ok && len(token) == 64 && strings.ToLower(token) == token {
					if _, err := hex.DecodeString(token); err == nil {
						continue
					}
				}
			}
			t.Fatalf("authenticated session %q = %#v; pinned Node has %#v", key, got, expected)
		}
	}

	authenticatedCookie := name + "=" + loginValue + "; " + name + ".sig=" + cookieValue(t, loginCookies, name+".sig")
	authenticatedVersionRequest := httptest.NewRequest(http.MethodGet, "/version", nil)
	authenticatedVersionRequest.Header.Set("Cookie", authenticatedCookie)
	authenticatedVersionResponse := httptest.NewRecorder()
	handler.ServeHTTP(authenticatedVersionResponse, authenticatedVersionRequest)
	if authenticatedVersionResponse.Code != fixture.AuthenticatedVersion.Status || authenticatedVersionResponse.Header().Get("Content-Type") != fixture.AuthenticatedVersion.ContentType {
		t.Fatalf("authenticated GET /version = %d %q; pinned Node has %d %q", authenticatedVersionResponse.Code, authenticatedVersionResponse.Header().Get("Content-Type"), fixture.AuthenticatedVersion.Status, fixture.AuthenticatedVersion.ContentType)
	}
	var gotVersion map[string]any
	if err := json.Unmarshal(authenticatedVersionResponse.Body.Bytes(), &gotVersion); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(gotVersion, fixture.AuthenticatedVersion.Body) {
		t.Fatalf("authenticated /version body = %#v; pinned Node has %#v", gotVersion, fixture.AuthenticatedVersion.Body)
	}

	pingRequest := httptest.NewRequest(http.MethodPost, "/api/ping", nil)
	pingRequest.Header.Set("Cookie", authenticatedCookie)
	pingRequest.Header.Set("X-CSRF-Token", csrfBody.Token)
	pingResponse := httptest.NewRecorder()
	handler.ServeHTTP(pingResponse, pingRequest)
	if pingResponse.Code != fixture.AuthenticatedPing.Status || pingResponse.Body.Len() != fixture.AuthenticatedPing.Bytes {
		t.Fatalf("authenticated POST /api/ping = %d with %d bytes; pinned Node has %d with %d bytes", pingResponse.Code, pingResponse.Body.Len(), fixture.AuthenticatedPing.Status, fixture.AuthenticatedPing.Bytes)
	}
	assertPinnedHeaders(t, pingResponse.Header(), fixture.AuthenticatedPing.Headers)

	changedUserRecord := strings.Replace(string(userRecord), `"password":""`, `"password":"changed-password-hash"`, 1)
	changedUserRecord = strings.Replace(changedUserRecord, `"salt":""`, `"salt":"changed-salt"`, 1)
	if err := os.WriteFile(filepath.Join(storagePath, nodeStoreFilename("user:default-user")), []byte(changedUserRecord), 0o600); err != nil {
		t.Fatal(err)
	}
	invalidatedRequest := httptest.NewRequest(http.MethodGet, "/version", nil)
	invalidatedRequest.Header.Set("Cookie", authenticatedCookie)
	invalidatedResponse := httptest.NewRecorder()
	handler.ServeHTTP(invalidatedResponse, invalidatedRequest)
	if invalidatedResponse.Code != fixture.InvalidatedSession.Status || invalidatedResponse.Header().Get("Content-Type") != fixture.InvalidatedSession.ContentType || invalidatedResponse.Body.String() != fixture.InvalidatedSession.Body {
		t.Fatalf("stale GET /version = %d %q %q; pinned Node has %d %q %q", invalidatedResponse.Code, invalidatedResponse.Header().Get("Content-Type"), invalidatedResponse.Body.String(), fixture.InvalidatedSession.Status, fixture.InvalidatedSession.ContentType, fixture.InvalidatedSession.Body)
	}
	invalidatedCookies := invalidatedResponse.Header().Values("Set-Cookie")
	if len(invalidatedCookies) != fixture.InvalidatedSession.SetCookieCount {
		t.Fatalf("stale session cleared %d cookies; pinned Node clears %d", len(invalidatedCookies), fixture.InvalidatedSession.SetCookieCount)
	}
	if got := normalizeAccountCookies(t, invalidatedCookies, name); !reflect.DeepEqual(got, fixture.InvalidatedSession.SetCookie) {
		t.Fatalf("stale-session clearing cookies = %#v; pinned Node has %#v", got, fixture.InvalidatedSession.SetCookie)
	}
	if cookieValue(t, invalidatedCookies, name) != "" || cookieValue(t, invalidatedCookies, name+".sig") != keygripSign(fixture.Inputs.CookieSecret, name+"=") {
		t.Fatalf("stale-session cookies do not clear and resign the session: %#v", invalidatedCookies)
	}

	if got, err := upstreamPasswordHash(fixture.PasswordHashVector.Password, fixture.PasswordHashVector.Salt); err != nil || got != fixture.PasswordHashVector.Hash {
		t.Fatalf("pinned password hash vector = %q, %v; Node has %q", got, err, fixture.PasswordHashVector.Hash)
	}
}

func normalizeAccountCookies(t *testing.T, cookies []string, sessionName string) []string {
	t.Helper()
	normalized := make([]string, 0, len(cookies))
	for _, raw := range cookies {
		parts := strings.Split(raw, "; ")
		name, _, found := strings.Cut(parts[0], "=")
		if !found {
			t.Fatalf("malformed session cookie %q", raw)
		}
		value := "<base64-session-json>"
		if name == sessionName+".sig" {
			value = "<signature>"
		}
		name = strings.Replace(name, sessionName, "session-<host-hash>", 1)
		parts[0] = name + "=" + value
		for index := 1; index < len(parts); index++ {
			if strings.HasPrefix(parts[index], "expires=") {
				parts[index] = "expires=<timestamp>"
			}
		}
		normalized = append(normalized, strings.Join(parts, "; "))
	}
	return normalized
}

func TestHTTPHandlerOptionsFromCommandLineCarriesAccountConfiguration(t *testing.T) {
	attempts := 3.5
	recoveryAttempts := 2.5
	resetAttempts := 4.5
	allowFullDataBackup := false
	settingsBackupRetention := 2.5
	requestCompressionTimeout := 1234.5
	timeout := float64(900)
	parsed := commandline.CommandLineResult{
		Paths: commandline.ResolvedPaths{RuntimeDataRoot: filepath.Join(t.TempDir(), "data")},
		Options: commandline.ServerOptions{
			DisableCsrf:     true,
			EnableCorsProxy: true,
		},
		StartupSettings: commandline.StartupSettings{
			EnableUserAccounts:         true,
			EnableDiscreetLogin:        true,
			PreferRealIPHeader:         true,
			AccountsLoginMaxAttempts:   attempts,
			AccountsRecoverMaxAttempts: recoveryAttempts,
			AccountsResetMaxAttempts:   resetAttempts,
			SkipContentCheck:           true,
			AllowFullDataBackup:        allowFullDataBackup,
			AllowKeysExposure:          true,
			SettingsBackupRetention:    settingsBackupRetention,
			ExtensionsEnabled:          false,
			ExtensionsAutoUpdate:       false,
			RequestCompressionEnabled:  true,
			RequestCompressionMin:      "1.5kb",
			RequestCompressionMax:      "3.5mb",
			RequestCompressionTimeout:  requestCompressionTimeout,
			SessionTimeout:             timeout,
			ForwardedXRealIP:           false,
			ForwardedCFConnectingIP:    true,
			ForwardedXForwardedFor:     false,
		},
	}
	options := HTTPHandlerOptionsFromCommandLine(parsed)
	if options.DataRoot != parsed.Paths.RuntimeDataRoot || !options.DisableCSRF || !options.EnableCorsProxy || !options.AccountsEnabled || !options.DiscreetLogin || !options.PreferRealIPHeader {
		t.Fatalf("handler options did not carry parsed config: %+v", options)
	}
	if options.LoginRateLimitPoints == nil || *options.LoginRateLimitPoints != attempts || options.RecoveryRateLimitPoints == nil || *options.RecoveryRateLimitPoints != recoveryAttempts || options.ResetRateLimitPoints == nil || *options.ResetRateLimitPoints != resetAttempts || !options.SkipContentCheck || options.SessionTimeoutSeconds == nil || *options.SessionTimeoutSeconds != timeout {
		t.Fatalf("handler numeric options = %+v", options)
	}
	if options.AllowFullDataBackup == nil || *options.AllowFullDataBackup || !options.AllowKeysExposure {
		t.Fatalf("handler backup options = %+v", options)
	}
	if options.SettingsBackupRetention == nil || *options.SettingsBackupRetention != settingsBackupRetention {
		t.Fatalf("handler settings-backup retention = %+v", options.SettingsBackupRetention)
	}
	if options.ExtensionsEnabled == nil || *options.ExtensionsEnabled || options.ExtensionsAutoUpdate == nil || *options.ExtensionsAutoUpdate ||
		options.RequestCompressionEnabled == nil || !*options.RequestCompressionEnabled || options.RequestCompressionMin != "1.5kb" ||
		options.RequestCompressionMax != "3.5mb" || options.RequestCompressionTimeout != requestCompressionTimeout {
		t.Fatalf("handler settings-view options = %+v", options)
	}
	if options.ForwardedXRealIP == nil || *options.ForwardedXRealIP || options.ForwardedCFConnectingIP == nil || !*options.ForwardedCFConnectingIP || options.ForwardedXForwardedFor == nil || *options.ForwardedXForwardedFor {
		t.Fatalf("handler forwarded-header options = %+v", options)
	}
}
