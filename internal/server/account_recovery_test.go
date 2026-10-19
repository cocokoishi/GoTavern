package server

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

type accountRecoveryResponseFixture struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    any               `json:"body"`
}

type accountRecoveryFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret                    string  `json:"cookieSecret"`
		RecoveryPoints                  float64 `json:"recoveryPoints"`
		NewPassword                     string  `json:"newPassword"`
		UnrelatedMalformedRecordPresent bool    `json:"unrelatedMalformedRecordPresent"`
	} `json:"inputs"`
	MissingStep1    accountRecoveryResponseFixture `json:"missingStep1"`
	UnknownStep1    accountRecoveryResponseFixture `json:"unknownStep1"`
	DisabledStep1   accountRecoveryResponseFixture `json:"disabledStep1"`
	StartedRecovery struct {
		accountRecoveryResponseFixture
		RecoveryCodeDigits int `json:"recoveryCodeDigits"`
	} `json:"startedRecovery"`
	StartedClearRecovery struct {
		accountRecoveryResponseFixture
		RecoveryCodeDigits int `json:"recoveryCodeDigits"`
	} `json:"startedClearRecovery"`
	MissingStep2       accountRecoveryResponseFixture `json:"missingStep2"`
	UnknownStep2       accountRecoveryResponseFixture `json:"unknownStep2"`
	DisabledStep2      accountRecoveryResponseFixture `json:"disabledStep2"`
	WrongCode          accountRecoveryResponseFixture `json:"wrongCode"`
	SuccessfulRecovery struct {
		Status                             int               `json:"status"`
		Headers                            map[string]string `json:"headers"`
		SetCookie                          []string          `json:"setCookie"`
		SetCookieCount                     int               `json:"setCookieCount"`
		SessionHandle                      string            `json:"sessionHandle"`
		SessionVersionMatchesStoredAccount bool              `json:"sessionVersionMatchesStoredAccount"`
		SessionCSRFTokenBytes              int               `json:"sessionCSRFTokenBytes"`
	} `json:"successfulRecovery"`
	WrongPasswordLogin      accountRecoveryResponseFixture `json:"wrongPasswordLogin"`
	PasswordLogin           accountRecoveryResponseFixture `json:"passwordLogin"`
	ClearedPasswordRecovery accountRecoveryResponseFixture `json:"clearedPasswordRecovery"`
	ClearUserLogin          accountRecoveryResponseFixture `json:"clearUserLogin"`
	RecoveryReplay          accountRecoveryResponseFixture `json:"recoveryReplay"`
	RateLimitedAttempts     []int                          `json:"rateLimitedAttempts"`
	RateLimited             accountRecoveryResponseFixture `json:"rateLimited"`
	PersistedUser           struct {
		Keys              []string `json:"keys"`
		Handle            string   `json:"handle"`
		Name              string   `json:"name"`
		Created           int64    `json:"created"`
		Enabled           bool     `json:"enabled"`
		Admin             bool     `json:"admin"`
		PasswordVerifies  bool     `json:"passwordVerifies"`
		PasswordHashBytes int      `json:"passwordHashBytes"`
		SaltBytes         int      `json:"saltBytes"`
		UnknownField      struct {
			Keep []any `json:"keep"`
		} `json:"unknownField"`
		NodePersistKeys []string `json:"nodePersistKeys"`
		TTLPresent      bool     `json:"ttlPresent"`
	} `json:"persistedUser"`
	PersistedClearedUser struct {
		Handle          string `json:"handle"`
		PasswordCleared bool   `json:"passwordCleared"`
		UnknownField    struct {
			Keep []any `json:"keep"`
		} `json:"unknownField"`
		NodePersistKeys []string `json:"nodePersistKeys"`
		TTLPresent      bool     `json:"ttlPresent"`
	} `json:"persistedClearedUser"`
	Log struct {
		RecoveryCodePrinted  bool `json:"recoveryCodePrinted"`
		RecoveryCodesPrinted int  `json:"recoveryCodesPrinted"`
		RecoveryCodeDigits   int  `json:"recoveryCodeDigits"`
	} `json:"log"`
}

func readAccountRecoveryFixture(t *testing.T) accountRecoveryFixture {
	t.Helper()
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-account-recovery.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture accountRecoveryFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("account recovery oracle baseline = %+v", fixture.Baseline)
	}
	return fixture
}

func TestPinnedNodeAccountRecoveryContract(t *testing.T) {
	fixture := readAccountRecoveryFixture(t)
	dataRoot := t.TempDir()
	storagePath := filepath.Join(dataRoot, userStorageFolder)
	if err := os.MkdirAll(storagePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	writeUser := func(handle, name string, created int64, password string, enabled bool, salt, unknown string) {
		t.Helper()
		type unknownValue struct {
			Keep []any `json:"keep"`
		}
		type userValue struct {
			Handle       string        `json:"handle"`
			Name         string        `json:"name"`
			Created      int64         `json:"created"`
			Password     string        `json:"password"`
			Admin        bool          `json:"admin"`
			Enabled      bool          `json:"enabled"`
			Salt         string        `json:"salt"`
			UnknownField *unknownValue `json:"unknownField,omitempty"`
		}
		value := userValue{
			Handle: handle, Name: name, Created: created, Password: password, Admin: handle == "default-user", Enabled: enabled, Salt: salt,
		}
		if unknown != "" {
			kept := []any{"recovery", float64(17), true}
			if handle == "clear-user" {
				kept = []any{"clear", float64(19), true}
			}
			value.UnknownField = &unknownValue{Keep: kept}
		}
		body, err := json.Marshal(map[string]any{"key": userStoragePrefix + handle, "value": value})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(storagePath, nodeStoreFilename(userStoragePrefix+handle)), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeUser("default-user", "Recovery User", 1700000000000, "", true, "", "preserve")
	writeUser("disabled-user", "Disabled User", 1700000000001, "", false, "", "")
	writeUser("clear-user", "Clear Password User", 1700000000002, "old-test-hash", true, "old-test-salt", "preserve")

	code := "246810"
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		DataRoot:                dataRoot,
		AccountsEnabled:         true,
		RecoveryRateLimitPoints: &fixture.Inputs.RecoveryPoints,
		recoveryCodeGenerator:   func() (string, error) { return code, nil },
	})

	csrfRequest := httptest.NewRequest(http.MethodGet, "/csrf-token", nil)
	csrfResponse := httptest.NewRecorder()
	handler.ServeHTTP(csrfResponse, csrfRequest)
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d, body %q", csrfResponse.Code, csrfResponse.Body.String())
	}
	var csrfBody struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrfBody); err != nil {
		t.Fatal(err)
	}
	if csrfBody.Token == "" {
		t.Fatal("GET /csrf-token returned an empty token")
	}
	sessionCookieName := pinnedSessionCookieName(t)
	cookieFrom := func(cookies []string) string {
		t.Helper()
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	requestFor := func(route string, body any, cookie string) *http.Request {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/users/"+route, strings.NewReader(string(encoded)))
		request.Header.Set("Cookie", cookie)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-CSRF-Token", csrfBody.Token)
		return request
	}
	post := func(route string, body any, cookie string) *httptest.ResponseRecorder {
		t.Helper()
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, requestFor(route, body, cookie))
		return response
	}

	csrfCookie := cookieFrom(csrfResponse.Header().Values("Set-Cookie"))
	loginResponse := post("login", map[string]any{"handle": "default-user"}, csrfCookie)
	if loginResponse.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", loginResponse.Code, loginResponse.Body.String())
	}
	activeCookie := cookieFrom(loginResponse.Header().Values("Set-Cookie"))
	if !fixture.Inputs.UnrelatedMalformedRecordPresent {
		t.Fatal("account recovery probe did not include an unrelated malformed node-persist record")
	}
	if err := os.WriteFile(filepath.Join(storagePath, "unrelated-malformed-record"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}

	responses := make(map[string]*httptest.ResponseRecorder)
	responses["missing step 1"] = post("recover-step1", map[string]any{}, activeCookie)
	responses["unknown step 1"] = post("recover-step1", map[string]any{"handle": "missing-user"}, activeCookie)
	responses["disabled step 1"] = post("recover-step1", map[string]any{"handle": "disabled-user"}, activeCookie)
	responses["start recovery"] = post("recover-step1", map[string]any{"handle": "default-user"}, activeCookie)
	responses["missing step 2"] = post("recover-step2", map[string]any{"handle": "default-user"}, activeCookie)
	responses["unknown step 2"] = post("recover-step2", map[string]any{"handle": "missing-user", "code": code}, activeCookie)
	responses["disabled step 2"] = post("recover-step2", map[string]any{"handle": "disabled-user", "code": code}, activeCookie)
	responses["wrong code"] = post("recover-step2", map[string]any{"handle": "default-user", "code": "000000"}, activeCookie)
	for label, pair := range map[string]struct {
		got  *httptest.ResponseRecorder
		want accountRecoveryResponseFixture
	}{
		"missing step 1":  {responses["missing step 1"], fixture.MissingStep1},
		"unknown step 1":  {responses["unknown step 1"], fixture.UnknownStep1},
		"disabled step 1": {responses["disabled step 1"], fixture.DisabledStep1},
		"missing step 2":  {responses["missing step 2"], fixture.MissingStep2},
		"unknown step 2":  {responses["unknown step 2"], fixture.UnknownStep2},
		"disabled step 2": {responses["disabled step 2"], fixture.DisabledStep2},
		"wrong code":      {responses["wrong code"], fixture.WrongCode},
	} {
		assertAccountRecoveryResponse(t, label, pair.got, pair.want)
	}
	if responses["start recovery"].Code != fixture.StartedRecovery.Status {
		t.Fatalf("start recovery status = %d; pinned Node has %d", responses["start recovery"].Code, fixture.StartedRecovery.Status)
	}
	assertPinnedHeaders(t, responses["start recovery"].Header(), fixture.StartedRecovery.Headers)
	if fixture.StartedRecovery.RecoveryCodeDigits != 6 || len(code) != fixture.StartedRecovery.RecoveryCodeDigits {
		t.Fatalf("recovery code digits = %d, expected pinned %d", len(code), fixture.StartedRecovery.RecoveryCodeDigits)
	}

	recoveryResponse := post("recover-step2", map[string]any{
		"handle": "default-user", "code": code, "newPassword": fixture.Inputs.NewPassword,
	}, activeCookie)
	if recoveryResponse.Code != fixture.SuccessfulRecovery.Status {
		t.Fatalf("successful recovery status = %d; pinned Node has %d, body %q", recoveryResponse.Code, fixture.SuccessfulRecovery.Status, recoveryResponse.Body.String())
	}
	assertPinnedHeadersExcluding(t, recoveryResponse.Header(), fixture.SuccessfulRecovery.Headers, "Set-Cookie")
	recoveryCookies := recoveryResponse.Header().Values("Set-Cookie")
	if len(recoveryCookies) != fixture.SuccessfulRecovery.SetCookieCount {
		t.Fatalf("recovery set %d cookies; pinned Node sets %d", len(recoveryCookies), fixture.SuccessfulRecovery.SetCookieCount)
	}
	if got := normalizeAccountCookies(t, recoveryCookies, sessionCookieName); !reflect.DeepEqual(got, fixture.SuccessfulRecovery.SetCookie) {
		t.Fatalf("recovery cookies = %#v; pinned Node has %#v", got, fixture.SuccessfulRecovery.SetCookie)
	}
	var sessionPayload map[string]any
	sessionBytes, err := base64.StdEncoding.DecodeString(cookieValue(t, recoveryCookies, sessionCookieName))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(sessionBytes, &sessionPayload); err != nil {
		t.Fatal(err)
	}
	csrfSessionToken, _ := sessionPayload["csrfToken"].(string)
	if sessionPayload["handle"] != fixture.SuccessfulRecovery.SessionHandle || len(csrfSessionToken) != fixture.SuccessfulRecovery.SessionCSRFTokenBytes {
		t.Fatalf("recovery session payload = %#v; pinned Node has handle %q and %d-byte CSRF token", sessionPayload, fixture.SuccessfulRecovery.SessionHandle, fixture.SuccessfulRecovery.SessionCSRFTokenBytes)
	}

	wrongPasswordLogin := post("login", map[string]any{"handle": "default-user", "password": "incorrect-password"}, cookieFrom(recoveryCookies))
	assertAccountRecoveryResponse(t, "wrong-password login", wrongPasswordLogin, fixture.WrongPasswordLogin)
	passwordLogin := post("login", map[string]any{"handle": "default-user", "password": fixture.Inputs.NewPassword}, cookieFrom(recoveryCookies))
	assertAccountRecoveryResponse(t, "password login", passwordLogin, fixture.PasswordLogin)
	clearStart := post("recover-step1", map[string]any{"handle": "clear-user"}, cookieFrom(recoveryCookies))
	assertAccountRecoveryResponse(t, "start clear-password recovery", clearStart, fixture.StartedClearRecovery.accountRecoveryResponseFixture)
	if len(code) != fixture.StartedClearRecovery.RecoveryCodeDigits {
		t.Fatalf("clear-password recovery code digits = %d, expected pinned %d", len(code), fixture.StartedClearRecovery.RecoveryCodeDigits)
	}
	clearRecovery := post("recover-step2", map[string]any{"handle": "clear-user", "code": code}, cookieFrom(recoveryCookies))
	assertAccountRecoveryResponse(t, "cleared-password recovery", clearRecovery, fixture.ClearedPasswordRecovery)
	clearLogin := post("login", map[string]any{"handle": "clear-user"}, cookieFrom(recoveryCookies))
	assertAccountRecoveryResponse(t, "passwordless login after recovery", clearLogin, fixture.ClearUserLogin)
	if fixture.Log.RecoveryCodeDigits != len(code) || fixture.Log.RecoveryCodesPrinted != 2 || !fixture.Log.RecoveryCodePrinted {
		t.Fatalf("recovery log observation = %+v", fixture.Log)
	}

	replay := post("recover-step2", map[string]any{"handle": "default-user", "code": code}, cookieFrom(recoveryCookies))
	assertAccountRecoveryResponse(t, "recovery replay", replay, fixture.RecoveryReplay)
	statuses := []int{replay.Code}
	var lastRateLimit *httptest.ResponseRecorder
	for index := 1; index < len(fixture.RateLimitedAttempts); index++ {
		lastRateLimit = post("recover-step2", map[string]any{"handle": "default-user", "code": "000000"}, cookieFrom(recoveryCookies))
		statuses = append(statuses, lastRateLimit.Code)
	}
	if !reflect.DeepEqual(statuses, fixture.RateLimitedAttempts) {
		t.Fatalf("recovery attempt statuses = %v; pinned Node has %v", statuses, fixture.RateLimitedAttempts)
	}
	if lastRateLimit == nil {
		t.Fatal("recovery rate-limit fixture has no attempts")
	}
	assertAccountRecoveryResponse(t, "rate-limited recovery", lastRateLimit, fixture.RateLimited)
	if retryAfter := lastRateLimit.Header().Get("Retry-After"); retryAfter == "" || retryAfter == "0" {
		t.Fatalf("rate-limited recovery Retry-After = %q", retryAfter)
	}

	storageBytes, err := os.ReadFile(filepath.Join(storagePath, nodeStoreFilename(userStoragePrefix+"default-user")))
	if err != nil {
		t.Fatal(err)
	}
	var record struct {
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
		TTL   json.RawMessage `json:"ttl"`
	}
	if err := json.Unmarshal(storageBytes, &record); err != nil {
		t.Fatal(err)
	}
	var user map[string]json.RawMessage
	if err := json.Unmarshal(record.Value, &user); err != nil {
		t.Fatal(err)
	}
	var handle, name, passwordHash, salt string
	_ = json.Unmarshal(user["handle"], &handle)
	_ = json.Unmarshal(user["name"], &name)
	_ = json.Unmarshal(user["password"], &passwordHash)
	_ = json.Unmarshal(user["salt"], &salt)
	expectedHash, err := upstreamPasswordHash(fixture.Inputs.NewPassword, salt)
	if err != nil {
		t.Fatal(err)
	}
	var unknownField struct {
		Keep []any `json:"keep"`
	}
	if err := json.Unmarshal(user["unknownField"], &unknownField); err != nil {
		t.Fatal(err)
	}
	persisted := fixture.PersistedUser
	ttlPresent := len(record.TTL) != 0 && string(record.TTL) != "null"
	if record.Key != userStoragePrefix+"default-user" || ttlPresent != persisted.TTLPresent {
		t.Fatalf("recovery changed node-persist record identity or TTL: key=%q ttl=%s", record.Key, record.TTL)
	}
	if handle != persisted.Handle || name != persisted.Name || passwordHash != expectedHash || !reflect.DeepEqual(unknownField.Keep, persisted.UnknownField.Keep) {
		t.Fatalf("recovered account record = handle %q name %q passwordMatches %v unknown %#v; pinned Node has %+v", handle, name, passwordHash == expectedHash, unknownField, persisted)
	}
	if got := keysInNodePersistValue(record.Value); !reflect.DeepEqual(got, persisted.Keys) {
		t.Fatalf("recovered user fields = %v; pinned Node has %v", got, persisted.Keys)
	}
	if got := keysInJSONObject(storageBytes); !reflect.DeepEqual(got, persisted.NodePersistKeys) {
		t.Fatalf("recovered node-persist keys = %v; pinned Node has %v", got, persisted.NodePersistKeys)
	}
	userVersion := (storedAccount{fields: user}).version()
	if !fixture.SuccessfulRecovery.SessionVersionMatchesStoredAccount || sessionPayload["version"] != userVersion {
		t.Fatalf("recovery session version = %#v, user version = %s; pinned Node reports current account version %v", sessionPayload["version"], userVersion, fixture.SuccessfulRecovery.SessionVersionMatchesStoredAccount)
	}
	passwordBytes, err := base64.StdEncoding.DecodeString(passwordHash)
	if err != nil {
		t.Fatal(err)
	}
	saltBytes, err := base64.StdEncoding.DecodeString(salt)
	if err != nil {
		t.Fatal(err)
	}
	if !persisted.PasswordVerifies || len(passwordBytes) != persisted.PasswordHashBytes || len(saltBytes) != persisted.SaltBytes {
		t.Fatalf("recovered password record differs from pinned storage observation: hash bytes=%d salt bytes=%d ttl=%s", len(passwordBytes), len(saltBytes), record.TTL)
	}
	clearedBytes, err := os.ReadFile(filepath.Join(storagePath, nodeStoreFilename(userStoragePrefix+"clear-user")))
	if err != nil {
		t.Fatal(err)
	}
	var clearedRecord struct {
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
		TTL   json.RawMessage `json:"ttl"`
	}
	if err := json.Unmarshal(clearedBytes, &clearedRecord); err != nil {
		t.Fatal(err)
	}
	var clearedUser map[string]json.RawMessage
	if err := json.Unmarshal(clearedRecord.Value, &clearedUser); err != nil {
		t.Fatal(err)
	}
	var clearedHandle, clearedPassword, clearedSalt string
	_ = json.Unmarshal(clearedUser["handle"], &clearedHandle)
	_ = json.Unmarshal(clearedUser["password"], &clearedPassword)
	_ = json.Unmarshal(clearedUser["salt"], &clearedSalt)
	var clearedUnknown struct {
		Keep []any `json:"keep"`
	}
	if err := json.Unmarshal(clearedUser["unknownField"], &clearedUnknown); err != nil {
		t.Fatal(err)
	}
	clearedExpected := fixture.PersistedClearedUser
	clearedTTLPresent := len(clearedRecord.TTL) != 0 && string(clearedRecord.TTL) != "null"
	if clearedRecord.Key != userStoragePrefix+"clear-user" || clearedHandle != clearedExpected.Handle || clearedPassword != "" || clearedSalt != "" || clearedTTLPresent != clearedExpected.TTLPresent || !reflect.DeepEqual(clearedUnknown.Keep, clearedExpected.UnknownField.Keep) {
		t.Fatalf("cleared account record = key %q handle %q password %q salt %q unknown %#v ttl %s; pinned Node has %+v", clearedRecord.Key, clearedHandle, clearedPassword, clearedSalt, clearedUnknown, clearedRecord.TTL, clearedExpected)
	}
	if !clearedExpected.PasswordCleared || !reflect.DeepEqual(keysInJSONObject(clearedBytes), clearedExpected.NodePersistKeys) {
		t.Fatalf("cleared node-persist keys = %v; pinned Node has %v", keysInJSONObject(clearedBytes), clearedExpected.NodePersistKeys)
	}
}

func assertAccountRecoveryResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want accountRecoveryResponseFixture) {
	t.Helper()
	if got.Code != want.Status {
		t.Fatalf("%s status = %d, pinned Node has %d (body %q)", label, got.Code, want.Status, got.Body.String())
	}
	headers := stableAccountRecoveryHeaders(got.Header())
	if retryAfter := headers["retry-after"]; retryAfter != "" {
		headers["retry-after"] = "<positive-seconds>"
	}
	if !reflect.DeepEqual(headers, want.Headers) {
		t.Fatalf("%s headers = %#v; pinned Node has %#v", label, headers, want.Headers)
	}
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

func stableAccountRecoveryHeaders(headers http.Header) map[string]string {
	stable := make(map[string]string)
	for name, values := range headers {
		lower := strings.ToLower(name)
		switch lower {
		case "connection", "date", "keep-alive", "last-modified", "set-cookie", "x-response-time":
			continue
		}
		if len(values) > 0 {
			stable[lower] = strings.Join(values, ", ")
		}
	}
	return stable
}

func keysInNodePersistValue(value []byte) []string {
	return keysInJSONObject(value)
}

func keysInJSONObject(value []byte) []string {
	var fields map[string]json.RawMessage
	if json.Unmarshal(value, &fields) != nil {
		return nil
	}
	keys := make([]string, 0, len(fields))
	// The original Node-persist object order is significant for the user
	// fixture. Decode it token-by-token instead of sorting map keys.
	decoder := json.NewDecoder(strings.NewReader(string(value)))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil
	}
	for decoder.More() {
		key, err := decoder.Token()
		if err != nil {
			return nil
		}
		name, ok := key.(string)
		if !ok {
			return nil
		}
		keys = append(keys, name)
		var discard json.RawMessage
		if err := decoder.Decode(&discard); err != nil {
			return nil
		}
	}
	return keys
}
