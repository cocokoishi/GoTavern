package server

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"
	"time"
)

type csrfSessionFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret   string  `json:"cookieSecret"`
		SessionTimeout float64 `json:"sessionTimeout"`
	} `json:"inputs"`
	Keygrip struct {
		Input     string `json:"input"`
		Signature string `json:"signature"`
	} `json:"keygrip"`
	CSRFToken struct {
		Status         int               `json:"status"`
		ContentType    string            `json:"contentType"`
		Headers        map[string]string `json:"headers"`
		TokenBytes     int               `json:"tokenBytes"`
		SetCookie      []string          `json:"setCookie"`
		SetCookieCount int               `json:"setCookieCount"`
	} `json:"csrfToken"`
	RepeatedToken struct {
		Status         int    `json:"status"`
		ContentType    string `json:"contentType"`
		TokenMatches   bool   `json:"tokenMatchesFirst"`
		SetCookieCount int    `json:"setCookieCount"`
	} `json:"repeatedToken"`
	ValidPing struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Bytes   int               `json:"bytes"`
	} `json:"validPing"`
	InvalidPing struct {
		Status      int               `json:"status"`
		ContentType string            `json:"contentType"`
		Headers     map[string]string `json:"headers"`
		Bytes       int               `json:"bytes"`
		Body        string            `json:"body"`
	} `json:"invalidPing"`
	ExtendedPing struct {
		Status         int               `json:"status"`
		Headers        map[string]string `json:"headers"`
		SetCookieCount int               `json:"setCookieCount"`
		SessionPayload map[string]any    `json:"sessionPayload"`
	} `json:"extendedPing"`
	EmptyStringToken struct {
		CSRFTokenStatus         int               `json:"csrfTokenStatus"`
		CSRFTokenBody           map[string]string `json:"csrfTokenBody"`
		CSRFTokenSetCookieCount int               `json:"csrfTokenSetCookieCount"`
		PingStatus              int               `json:"pingStatus"`
		PingBytes               int               `json:"pingBytes"`
	} `json:"emptyStringToken"`
}

type disabledCSRFSessionFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	CSRFToken struct {
		Status         int               `json:"status"`
		ContentType    string            `json:"contentType"`
		Headers        map[string]string `json:"headers"`
		Body           map[string]string `json:"body"`
		SetCookieCount int               `json:"setCookieCount"`
	} `json:"csrfToken"`
	PingWithoutToken struct {
		Status  int               `json:"status"`
		Headers map[string]string `json:"headers"`
		Bytes   int               `json:"bytes"`
	} `json:"pingWithoutToken"`
}

func readCSRFSessionsFixture(t *testing.T) csrfSessionFixture {
	t.Helper()
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-csrf-session.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture csrfSessionFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("CSRF session oracle baseline = %+v", fixture.Baseline)
	}
	return fixture
}

func TestPinnedNodeCSRFCookieSessionContract(t *testing.T) {
	fixture := readCSRFSessionsFixture(t)
	dataRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{DataRoot: dataRoot})

	started := time.Now()
	request := httptest.NewRequest(http.MethodGet, "/csrf-token", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	if response.Code != fixture.CSRFToken.Status {
		t.Fatalf("GET /csrf-token status = %d; pinned Node has %d", response.Code, fixture.CSRFToken.Status)
	}
	if contentType := response.Header().Get("Content-Type"); contentType != fixture.CSRFToken.ContentType {
		t.Fatalf("GET /csrf-token Content-Type = %q; pinned Node has %q", contentType, fixture.CSRFToken.ContentType)
	}
	assertPinnedHeadersExcluding(t, response.Header(), withoutHeader(fixture.CSRFToken.Headers, "etag"), "Set-Cookie", "ETag")
	var body struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(body.Token) || len(body.Token) != fixture.CSRFToken.TokenBytes {
		t.Fatalf("CSRF token = %q; pinned Node generates %d lowercase hex characters", body.Token, fixture.CSRFToken.TokenBytes)
	}
	if got := response.Header().Get("Content-Length"); got != fmt.Sprint(len(response.Body.Bytes())) {
		t.Fatalf("GET /csrf-token Content-Length = %q; body has %d bytes", got, response.Body.Len())
	}
	if got, want := response.Header().Get("ETag"), expressWeakETag(response.Body.Bytes()); got != want {
		t.Fatalf("GET /csrf-token ETag = %q; Express format gives %q", got, want)
	}
	cookies := response.Header().Values("Set-Cookie")
	if len(cookies) != fixture.CSRFToken.SetCookieCount || len(cookies) != 2 {
		t.Fatalf("GET /csrf-token Set-Cookie count = %d; pinned Node has %d", len(cookies), fixture.CSRFToken.SetCookieCount)
	}
	name := pinnedSessionCookieName(t)
	sessionValue := cookieValue(t, cookies, name)
	signature := cookieValue(t, cookies, name+".sig")
	if got, want := signature, keygripSign(fixture.Inputs.CookieSecret, name+"="+sessionValue); got != want {
		t.Fatalf("session signature = %q; Keygrip requires %q", got, want)
	}
	var session map[string]any
	decoded, err := base64.StdEncoding.DecodeString(sessionValue)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(decoded, &session); err != nil {
		t.Fatal(err)
	}
	if got := session["csrfToken"]; got != body.Token {
		t.Fatalf("session csrfToken = %#v; response token is %q", got, body.Token)
	}
	checkPinnedSessionCookieAttributes(t, cookies, name, started)
	if got := keygripSign(fixture.Inputs.CookieSecret, fixture.Keygrip.Input); got != fixture.Keygrip.Signature {
		t.Fatalf("Keygrip test vector = %q; pinned Node has %q", got, fixture.Keygrip.Signature)
	}

	cookieHeader := name + "=" + sessionValue + "; " + name + ".sig=" + signature
	repeatedRequest := httptest.NewRequest(http.MethodGet, "/csrf-token", nil)
	repeatedRequest.Header.Set("Cookie", cookieHeader)
	repeatedResponse := httptest.NewRecorder()
	handler.ServeHTTP(repeatedResponse, repeatedRequest)
	if repeatedResponse.Code != fixture.RepeatedToken.Status || repeatedResponse.Header().Get("Content-Type") != fixture.RepeatedToken.ContentType {
		t.Fatalf("repeated GET /csrf-token = %d %q; pinned Node has %d %q", repeatedResponse.Code, repeatedResponse.Header().Get("Content-Type"), fixture.RepeatedToken.Status, fixture.RepeatedToken.ContentType)
	}
	var repeatedBody struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(repeatedResponse.Body.Bytes(), &repeatedBody); err != nil {
		t.Fatal(err)
	}
	if repeatedBody.Token != body.Token || len(repeatedResponse.Header().Values("Set-Cookie")) != fixture.RepeatedToken.SetCookieCount {
		t.Fatalf("repeated token = %q with %d cookies; pinned Node reuses token %q with %d cookies", repeatedBody.Token, len(repeatedResponse.Header().Values("Set-Cookie")), body.Token, fixture.RepeatedToken.SetCookieCount)
	}

	validRequest := httptest.NewRequest(http.MethodPost, "/api/ping", nil)
	validRequest.Header.Set("Cookie", cookieHeader)
	validRequest.Header.Set("X-CSRF-Token", body.Token)
	validResponse := httptest.NewRecorder()
	handler.ServeHTTP(validResponse, validRequest)
	if validResponse.Code != fixture.ValidPing.Status || validResponse.Body.Len() != fixture.ValidPing.Bytes {
		t.Fatalf("valid POST /api/ping = %d with %d bytes; pinned Node has %d with %d bytes", validResponse.Code, validResponse.Body.Len(), fixture.ValidPing.Status, fixture.ValidPing.Bytes)
	}
	assertPinnedHeaders(t, validResponse.Header(), fixture.ValidPing.Headers)

	invalidRequest := httptest.NewRequest(http.MethodPost, "/api/ping", nil)
	invalidRequest.Header.Set("Cookie", cookieHeader)
	invalidRequest.Header.Set("X-CSRF-Token", "invalid-token")
	invalidResponse := httptest.NewRecorder()
	handler.ServeHTTP(invalidResponse, invalidRequest)
	if invalidResponse.Code != fixture.InvalidPing.Status || invalidResponse.Header().Get("Content-Type") != fixture.InvalidPing.ContentType {
		t.Fatalf("invalid POST /api/ping = %d %q; pinned Node has %d %q", invalidResponse.Code, invalidResponse.Header().Get("Content-Type"), fixture.InvalidPing.Status, fixture.InvalidPing.ContentType)
	}
	assertPinnedHeaders(t, invalidResponse.Header(), fixture.InvalidPing.Headers)
	if len(invalidResponse.Body.Bytes()) != fixture.InvalidPing.Bytes || invalidResponse.Body.String() != fixture.InvalidPing.Body {
		t.Fatalf("invalid CSRF body = %q; pinned Node has %q", invalidResponse.Body.String(), fixture.InvalidPing.Body)
	}

	unknownSessionJSON := []byte(`{"futureField":{"enabled":true,"values":[1,"two"]},"csrfToken":"preserved-token"}`)
	unknownSessionValue := base64.StdEncoding.EncodeToString(unknownSessionJSON)
	unknownSessionSignature := keygripSign(fixture.Inputs.CookieSecret, name+"="+unknownSessionValue)
	extendedStarted := time.Now()
	extendedRequest := httptest.NewRequest(http.MethodPost, "/api/ping?extend=1", nil)
	extendedRequest.Header.Set("Cookie", name+"="+unknownSessionValue+"; "+name+".sig="+unknownSessionSignature)
	extendedRequest.Header.Set("X-CSRF-Token", "preserved-token")
	extendedResponse := httptest.NewRecorder()
	handler.ServeHTTP(extendedResponse, extendedRequest)
	if extendedResponse.Code != fixture.ExtendedPing.Status {
		t.Fatalf("extended POST /api/ping = %d; pinned Node has %d", extendedResponse.Code, fixture.ExtendedPing.Status)
	}
	assertPinnedHeadersExcluding(t, extendedResponse.Header(), fixture.ExtendedPing.Headers, "Set-Cookie")
	extendedCookies := extendedResponse.Header().Values("Set-Cookie")
	if len(extendedCookies) != fixture.ExtendedPing.SetCookieCount || len(extendedCookies) != 2 {
		t.Fatalf("extended POST /api/ping set %d cookies; pinned Node sets %d", len(extendedCookies), fixture.ExtendedPing.SetCookieCount)
	}
	extendedValue := cookieValue(t, extendedCookies, name)
	if got, want := cookieValue(t, extendedCookies, name+".sig"), keygripSign(fixture.Inputs.CookieSecret, name+"="+extendedValue); got != want {
		t.Fatalf("extended session signature = %q; expected %q", got, want)
	}
	extendedJSON, err := base64.StdEncoding.DecodeString(extendedValue)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.HasPrefix(string(extendedJSON), `{"futureField":{"enabled":true,"values":[1,"two"]},"csrfToken":"preserved-token","touch":`) || !strings.HasSuffix(string(extendedJSON), "}") {
		t.Fatalf("extended session JSON did not preserve unknown fields and property order: %s", extendedJSON)
	}
	var extendedPayload map[string]any
	if err := json.Unmarshal(extendedJSON, &extendedPayload); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(extendedPayload["futureField"], fixture.ExtendedPing.SessionPayload["futureField"]) || extendedPayload["csrfToken"] != "preserved-token" {
		t.Fatalf("extended session payload = %#v; pinned Node preserves %#v", extendedPayload, fixture.ExtendedPing.SessionPayload)
	}
	touch, ok := extendedPayload["touch"].(float64)
	touchAt := time.UnixMilli(int64(touch))
	if !ok || touchAt.Before(extendedStarted.Add(-time.Second)) || touchAt.After(time.Now().Add(time.Second)) {
		t.Fatalf("extended session touch = %s; request started %s and test time is %s", touchAt, extendedStarted, time.Now())
	}

	emptySessionJSON := []byte(`{"csrfToken":""}`)
	emptySessionValue := base64.StdEncoding.EncodeToString(emptySessionJSON)
	emptySessionSignature := keygripSign(fixture.Inputs.CookieSecret, name+"="+emptySessionValue)
	emptyCookie := name + "=" + emptySessionValue + "; " + name + ".sig=" + emptySessionSignature
	emptyTokenRequest := httptest.NewRequest(http.MethodGet, "/csrf-token", nil)
	emptyTokenRequest.Header.Set("Cookie", emptyCookie)
	emptyTokenResponse := httptest.NewRecorder()
	handler.ServeHTTP(emptyTokenResponse, emptyTokenRequest)
	var emptyTokenBody map[string]string
	if err := json.Unmarshal(emptyTokenResponse.Body.Bytes(), &emptyTokenBody); err != nil {
		t.Fatal(err)
	}
	if emptyTokenResponse.Code != fixture.EmptyStringToken.CSRFTokenStatus || !reflect.DeepEqual(emptyTokenBody, fixture.EmptyStringToken.CSRFTokenBody) || len(emptyTokenResponse.Header().Values("Set-Cookie")) != fixture.EmptyStringToken.CSRFTokenSetCookieCount {
		t.Fatalf("empty stored CSRF token response = %d %#v with %d cookies; pinned Node has %d %#v with %d cookies", emptyTokenResponse.Code, emptyTokenBody, len(emptyTokenResponse.Header().Values("Set-Cookie")), fixture.EmptyStringToken.CSRFTokenStatus, fixture.EmptyStringToken.CSRFTokenBody, fixture.EmptyStringToken.CSRFTokenSetCookieCount)
	}
	emptyPingRequest := httptest.NewRequest(http.MethodPost, "/api/ping", nil)
	emptyPingRequest.Header.Set("Cookie", emptyCookie)
	emptyPingRequest.Header.Set("X-CSRF-Token", "")
	emptyPingResponse := httptest.NewRecorder()
	handler.ServeHTTP(emptyPingResponse, emptyPingRequest)
	if emptyPingResponse.Code != fixture.EmptyStringToken.PingStatus || emptyPingResponse.Body.Len() != fixture.EmptyStringToken.PingBytes {
		t.Fatalf("empty CSRF token ping = %d with %d bytes; pinned Node has %d with %d bytes", emptyPingResponse.Code, emptyPingResponse.Body.Len(), fixture.EmptyStringToken.PingStatus, fixture.EmptyStringToken.PingBytes)
	}
}

func TestPinnedNodeDisabledCSRFContract(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-csrf-disabled.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture disabledCSRFSessionFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("disabled CSRF oracle baseline = %+v", fixture.Baseline)
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{DisableCSRF: true})

	tokenRequest := httptest.NewRequest(http.MethodGet, "/csrf-token", nil)
	tokenResponse := httptest.NewRecorder()
	handler.ServeHTTP(tokenResponse, tokenRequest)
	if tokenResponse.Code != fixture.CSRFToken.Status || tokenResponse.Header().Get("Content-Type") != fixture.CSRFToken.ContentType {
		t.Fatalf("disabled GET /csrf-token = %d %q; pinned Node has %d %q", tokenResponse.Code, tokenResponse.Header().Get("Content-Type"), fixture.CSRFToken.Status, fixture.CSRFToken.ContentType)
	}
	assertPinnedHeaders(t, tokenResponse.Header(), fixture.CSRFToken.Headers)
	if len(tokenResponse.Header().Values("Set-Cookie")) != fixture.CSRFToken.SetCookieCount {
		t.Fatalf("disabled GET /csrf-token set %d cookies; pinned Node sets %d", len(tokenResponse.Header().Values("Set-Cookie")), fixture.CSRFToken.SetCookieCount)
	}
	var tokenBody map[string]string
	if err := json.Unmarshal(tokenResponse.Body.Bytes(), &tokenBody); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(tokenBody, fixture.CSRFToken.Body) {
		t.Fatalf("disabled GET /csrf-token body = %#v; pinned Node has %#v", tokenBody, fixture.CSRFToken.Body)
	}

	pingRequest := httptest.NewRequest(http.MethodPost, "/api/ping", nil)
	pingResponse := httptest.NewRecorder()
	handler.ServeHTTP(pingResponse, pingRequest)
	if pingResponse.Code != fixture.PingWithoutToken.Status || pingResponse.Body.Len() != fixture.PingWithoutToken.Bytes {
		t.Fatalf("disabled POST /api/ping = %d with %d bytes; pinned Node has %d with %d bytes", pingResponse.Code, pingResponse.Body.Len(), fixture.PingWithoutToken.Status, fixture.PingWithoutToken.Bytes)
	}
	assertPinnedHeaders(t, pingResponse.Header(), fixture.PingWithoutToken.Headers)
}

func withoutHeader(headers map[string]string, name string) map[string]string {
	copy := make(map[string]string, len(headers)-1)
	for key, value := range headers {
		if key != name {
			copy[key] = value
		}
	}
	return copy
}

func assertPinnedHeadersExcluding(t *testing.T, got http.Header, want map[string]string, excluded ...string) {
	t.Helper()
	copy := got.Clone()
	for _, name := range excluded {
		copy.Del(name)
	}
	assertPinnedHeaders(t, copy, want)
}

func pinnedSessionCookieName(t *testing.T) string {
	t.Helper()
	hostname, err := os.Hostname()
	if err != nil || hostname == "" {
		hostname = "localhost"
	}
	digest := sha256.Sum256([]byte(hostname))
	return fmt.Sprintf("session-%x", digest[:4])
}

func cookieValue(t *testing.T, cookies []string, name string) string {
	t.Helper()
	for _, raw := range cookies {
		pair := strings.SplitN(raw, ";", 2)[0]
		key, value, found := strings.Cut(pair, "=")
		if found && key == name {
			return value
		}
	}
	t.Fatalf("cookie %q not found in %#v", name, cookies)
	return ""
}

func checkPinnedSessionCookieAttributes(t *testing.T, cookies []string, name string, started time.Time) {
	t.Helper()
	wantNames := []string{name, name + ".sig"}
	for index, raw := range cookies {
		parts := strings.Split(raw, "; ")
		if len(parts) != 5 || !strings.HasPrefix(parts[0], wantNames[index]+"=") {
			t.Fatalf("Set-Cookie[%d] = %q; pinned Node uses name, path, expires, samesite, httponly", index, raw)
		}
		if parts[1] != "path=/" || parts[3] != "samesite=lax" || parts[4] != "httponly" {
			t.Fatalf("Set-Cookie[%d] attributes = %#v; pinned Node has path=/; samesite=lax; httponly", index, parts)
		}
		expires, err := time.Parse(time.RFC1123, strings.TrimPrefix(parts[2], "expires="))
		if err != nil {
			t.Fatalf("Set-Cookie[%d] expiry %q: %v", index, parts[2], err)
		}
		wantExpiry := started.Add(400 * 24 * time.Hour)
		if delta := expires.Sub(wantExpiry); delta < -2*time.Second || delta > 2*time.Second {
			t.Fatalf("Set-Cookie[%d] expiry = %s; pinned 400-day expiry should be near %s", index, expires, wantExpiry)
		}
	}
}
