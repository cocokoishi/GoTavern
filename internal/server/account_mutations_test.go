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

type accountMutationResponseFixture struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    any               `json:"body"`
}

type accountMutationCookieFixture struct {
	accountMutationResponseFixture
	SetCookie                       []string `json:"setCookie"`
	SetCookieCount                  int      `json:"setCookieCount"`
	SessionHandle                   string   `json:"sessionHandle"`
	SessionVersionMatchesStoredUser bool     `json:"sessionVersionMatchesStoredAccount"`
	SessionCSRFTokenBytes           int      `json:"sessionCSRFTokenBytes"`
}

type accountMutationFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string `json:"cookieSecret"`
		OldPassword  string `json:"oldPassword"`
		NewPassword  string `json:"newPassword"`
		Avatar       string `json:"avatar"`
		SaltBytes    int    `json:"saltBytes"`
	} `json:"inputs"`
	MissingName           accountMutationResponseFixture `json:"missingName"`
	UnauthorizedName      accountMutationResponseFixture `json:"unauthorizedName"`
	UnknownName           accountMutationResponseFixture `json:"unknownName"`
	ChangeName            accountMutationResponseFixture `json:"changeName"`
	MissingAvatar         accountMutationResponseFixture `json:"missingAvatar"`
	UnauthorizedAvatar    accountMutationResponseFixture `json:"unauthorizedAvatar"`
	InvalidAvatar         accountMutationResponseFixture `json:"invalidAvatar"`
	UnknownAvatar         accountMutationResponseFixture `json:"unknownAvatar"`
	ChangeAvatar          accountMutationResponseFixture `json:"changeAvatar"`
	MissingPassword       accountMutationResponseFixture `json:"missingPassword"`
	UnauthorizedPassword  accountMutationResponseFixture `json:"unauthorizedPassword"`
	UnknownPassword       accountMutationResponseFixture `json:"unknownPassword"`
	DisabledPassword      accountMutationResponseFixture `json:"disabledPassword"`
	IncorrectOldPassword  accountMutationResponseFixture `json:"incorrectOldPassword"`
	ChangePassword        accountMutationCookieFixture   `json:"changePassword"`
	ProfileAfterMutations accountMutationResponseFixture `json:"profileAfterMutations"`
	StaleSessionProfile   struct {
		accountMutationResponseFixture
		SetCookie      []string `json:"setCookie"`
		SetCookieCount int      `json:"setCookieCount"`
	} `json:"staleSessionProfile"`
	NewPasswordLogin accountMutationResponseFixture `json:"newPasswordLogin"`
	Persisted        struct {
		UserKeys          []string `json:"userKeys"`
		Name              string   `json:"name"`
		Avatar            string   `json:"avatar"`
		PasswordVerifies  bool     `json:"passwordVerifies"`
		PasswordHashBytes int      `json:"passwordHashBytes"`
		SaltBytes         int      `json:"saltBytes"`
		UnknownField      struct {
			Keep []any `json:"keep"`
		} `json:"unknownField"`
		UserRecordKeys    []string `json:"userRecordKeys"`
		AvatarRecordKeys  []string `json:"avatarRecordKeys"`
		AvatarRecordValue string   `json:"avatarRecordValue"`
		TTLPresent        bool     `json:"ttlPresent"`
	} `json:"persisted"`
}

func TestPinnedNodeAccountProfileMutationsContract(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-account-mutations.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture accountMutationFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("account-mutation oracle baseline = %+v", fixture.Baseline)
	}

	dataRoot := t.TempDir()
	storagePath := filepath.Join(dataRoot, userStorageFolder)
	if err := os.MkdirAll(storagePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	salt := base64.StdEncoding.EncodeToString([]byte("0123456789abcdef"))
	oldHash, err := upstreamPasswordHash(fixture.Inputs.OldPassword, salt)
	if err != nil {
		t.Fatal(err)
	}
	type preservedFields struct {
		Keep []any `json:"keep"`
	}
	type seededAccountRecord struct {
		Handle       string           `json:"handle"`
		Name         string           `json:"name"`
		Created      int64            `json:"created"`
		Password     string           `json:"password"`
		Admin        bool             `json:"admin"`
		Enabled      bool             `json:"enabled"`
		Salt         string           `json:"salt"`
		UnknownField *preservedFields `json:"unknownField,omitempty"`
	}
	writeUser := func(handle, name string, created int64, password, userSalt string, admin, enabled bool, keep []any) {
		t.Helper()
		user := seededAccountRecord{Handle: handle, Name: name, Created: created, Password: password, Admin: admin, Enabled: enabled, Salt: userSalt}
		if keep != nil {
			user.UnknownField = &preservedFields{Keep: keep}
		}
		body, err := json.Marshal(struct {
			Key   string              `json:"key"`
			Value seededAccountRecord `json:"value"`
		}{Key: userStoragePrefix + handle, Value: user})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(storagePath, nodeStoreFilename(userStoragePrefix+handle)), body, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	writeUser("default-user", "Mutation Admin", 1700000000000, oldHash, salt, true, true, []any{"mutation", float64(29), true})
	writeUser("regular-user", "Regular User", 1700000000001, oldHash, salt, false, true, []any{"regular", float64(31), false})
	writeUser("disabled-user", "Disabled User", 1700000000002, "", "", false, false, nil)

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{DataRoot: dataRoot, AccountsEnabled: true})
	serve := func(method, route, cookie, token string, body any) *httptest.ResponseRecorder {
		t.Helper()
		var requestBody strings.Reader
		if body != nil {
			encoded, err := json.Marshal(body)
			if err != nil {
				t.Fatal(err)
			}
			requestBody = *strings.NewReader(string(encoded))
		}
		request := httptest.NewRequest(method, route, &requestBody)
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
	csrf := serve(http.MethodGet, "/csrf-token", "", "", nil)
	if csrf.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d, body %q", csrf.Code, csrf.Body.String())
	}
	var csrfBody struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrf.Body.Bytes(), &csrfBody); err != nil {
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
	csrfCookie := cookieFrom(csrf.Header().Values("Set-Cookie"))
	post := func(route, cookie string, body any) *httptest.ResponseRecorder {
		t.Helper()
		return serve(http.MethodPost, "/api/users/"+route, cookie, csrfBody.Token, body)
	}
	login := func(handle, password string) string {
		t.Helper()
		response := post("login", csrfCookie, map[string]any{"handle": handle, "password": password})
		if response.Code != http.StatusOK {
			t.Fatalf("POST /api/users/login for %q = %d, body %q", handle, response.Code, response.Body.String())
		}
		return cookieFrom(response.Header().Values("Set-Cookie"))
	}
	adminCookie := login("default-user", fixture.Inputs.OldPassword)
	regularCookie := login("regular-user", fixture.Inputs.OldPassword)

	responses := []struct {
		label string
		got   *httptest.ResponseRecorder
		want  accountMutationResponseFixture
	}{
		{"missing name", post("change-name", adminCookie, map[string]any{}), fixture.MissingName},
		{"unauthorized name", post("change-name", regularCookie, map[string]any{"handle": "default-user", "name": "Hijacked"}), fixture.UnauthorizedName},
		{"unknown name", post("change-name", adminCookie, map[string]any{"handle": "missing-user", "name": "No User"}), fixture.UnknownName},
		{"changed name", post("change-name", adminCookie, map[string]any{"handle": "default-user", "name": "Renamed Mutation Admin"}), fixture.ChangeName},
		{"missing avatar handle", post("change-avatar", adminCookie, map[string]any{"avatar": fixture.Inputs.Avatar}), fixture.MissingAvatar},
		{"unauthorized avatar", post("change-avatar", regularCookie, map[string]any{"handle": "default-user", "avatar": fixture.Inputs.Avatar}), fixture.UnauthorizedAvatar},
		{"invalid avatar", post("change-avatar", adminCookie, map[string]any{"handle": "default-user", "avatar": "https://example.test/avatar.png"}), fixture.InvalidAvatar},
		{"unknown avatar user", post("change-avatar", adminCookie, map[string]any{"handle": "missing-user", "avatar": fixture.Inputs.Avatar}), fixture.UnknownAvatar},
		{"changed avatar", post("change-avatar", adminCookie, map[string]any{"handle": "default-user", "avatar": fixture.Inputs.Avatar}), fixture.ChangeAvatar},
		{"missing password handle", post("change-password", adminCookie, map[string]any{}), fixture.MissingPassword},
		{"unauthorized password", post("change-password", regularCookie, map[string]any{"handle": "default-user", "newPassword": "hijacked"}), fixture.UnauthorizedPassword},
		{"unknown password user", post("change-password", adminCookie, map[string]any{"handle": "missing-user", "newPassword": "ignored"}), fixture.UnknownPassword},
		{"disabled password user", post("change-password", adminCookie, map[string]any{"handle": "disabled-user", "newPassword": "ignored"}), fixture.DisabledPassword},
		{"incorrect old password", post("change-password", regularCookie, map[string]any{"handle": "regular-user", "oldPassword": "incorrect-password", "newPassword": "ignored"}), fixture.IncorrectOldPassword},
	}
	for _, response := range responses {
		assertAccountMutationResponse(t, response.label, response.got, response.want)
	}

	changePassword := post("change-password", adminCookie, map[string]any{"handle": "default-user", "newPassword": fixture.Inputs.NewPassword})
	if changePassword.Code != fixture.ChangePassword.Status {
		t.Fatalf("POST /api/users/change-password = %d; pinned Node has %d, body %q", changePassword.Code, fixture.ChangePassword.Status, changePassword.Body.String())
	}
	assertPinnedHeadersExcluding(t, changePassword.Header(), fixture.ChangePassword.Headers, "Set-Cookie")
	passwordCookies := changePassword.Header().Values("Set-Cookie")
	if got := normalizeAccountCookies(t, passwordCookies, name); !reflect.DeepEqual(got, fixture.ChangePassword.SetCookie) {
		t.Fatalf("password update cookies = %#v; pinned Node has %#v", got, fixture.ChangePassword.SetCookie)
	}
	if len(passwordCookies) != fixture.ChangePassword.SetCookieCount {
		t.Fatalf("password update set %d cookies; pinned Node sets %d", len(passwordCookies), fixture.ChangePassword.SetCookieCount)
	}
	var session map[string]any
	sessionBytes, err := base64.StdEncoding.DecodeString(cookieValue(t, passwordCookies, name))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(sessionBytes, &session); err != nil {
		t.Fatal(err)
	}
	csrfToken, _ := session["csrfToken"].(string)
	if session["handle"] != fixture.ChangePassword.SessionHandle || len(csrfToken) != fixture.ChangePassword.SessionCSRFTokenBytes {
		t.Fatalf("password update session = %#v; pinned Node has handle %q and %d-byte CSRF token", session, fixture.ChangePassword.SessionHandle, fixture.ChangePassword.SessionCSRFTokenBytes)
	}
	updatedCookie := cookieFrom(passwordCookies)

	profile := serve(http.MethodGet, "/api/users/me", updatedCookie, "", nil)
	assertAccountMutationResponse(t, "profile after mutations", profile, fixture.ProfileAfterMutations)
	staleProfile := serve(http.MethodGet, "/api/users/me", adminCookie, "", nil)
	if staleProfile.Code != fixture.StaleSessionProfile.Status {
		t.Fatalf("stale GET /api/users/me = %d; pinned Node has %d", staleProfile.Code, fixture.StaleSessionProfile.Status)
	}
	assertPinnedHeadersExcluding(t, staleProfile.Header(), fixture.StaleSessionProfile.Headers, "Set-Cookie")
	assertMutationCookieSet(t, staleProfile.Header().Values("Set-Cookie"), name, fixture.StaleSessionProfile.SetCookieCount, fixture.StaleSessionProfile.SetCookie)
	if got := staleProfile.Body.String(); got != fixture.StaleSessionProfile.Body {
		t.Fatalf("stale profile body = %q; pinned Node has %#v", got, fixture.StaleSessionProfile.Body)
	}

	newPasswordLogin := post("login", csrfCookie, map[string]any{"handle": "default-user", "password": fixture.Inputs.NewPassword})
	assertAccountMutationResponseExcluding(t, "login with changed password", newPasswordLogin, fixture.NewPasswordLogin, "Set-Cookie")

	userBytes, err := os.ReadFile(filepath.Join(storagePath, nodeStoreFilename(userStoragePrefix+"default-user")))
	if err != nil {
		t.Fatal(err)
	}
	var userRecord struct {
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
		TTL   json.RawMessage `json:"ttl"`
	}
	if err := json.Unmarshal(userBytes, &userRecord); err != nil {
		t.Fatal(err)
	}
	var userFields map[string]json.RawMessage
	if err := json.Unmarshal(userRecord.Value, &userFields); err != nil {
		t.Fatal(err)
	}
	var storedName, storedPassword, storedSalt string
	_ = json.Unmarshal(userFields["name"], &storedName)
	_ = json.Unmarshal(userFields["password"], &storedPassword)
	_ = json.Unmarshal(userFields["salt"], &storedSalt)
	storedHash, err := upstreamPasswordHash(fixture.Inputs.NewPassword, storedSalt)
	if err != nil {
		t.Fatal(err)
	}
	var unknownField struct {
		Keep []any `json:"keep"`
	}
	if err := json.Unmarshal(userFields["unknownField"], &unknownField); err != nil {
		t.Fatal(err)
	}
	userKeys := orderedJSONObjectKeys(userRecord.Value)
	userRecordKeys := orderedJSONObjectKeys(userBytes)
	ttlPresent := len(userRecord.TTL) > 0 && string(userRecord.TTL) != "null"
	if userRecord.Key != userStoragePrefix+"default-user" || ttlPresent != fixture.Persisted.TTLPresent || storedName != fixture.Persisted.Name || storedPassword != storedHash || !reflect.DeepEqual(unknownField.Keep, fixture.Persisted.UnknownField.Keep) || !reflect.DeepEqual(userKeys, fixture.Persisted.UserKeys) || !reflect.DeepEqual(userRecordKeys, fixture.Persisted.UserRecordKeys) {
		t.Fatalf("persisted account = key %q name %q passwordMatches %v unknown %#v user keys %v envelope keys %v TTL %s; pinned Node has %+v", userRecord.Key, storedName, storedPassword == storedHash, unknownField, userKeys, userRecordKeys, userRecord.TTL, fixture.Persisted)
	}
	if !fixture.ChangePassword.SessionVersionMatchesStoredUser || len(storedSalt) == 0 {
		t.Fatalf("pinned mutation fixture lacks a valid session update or salt: %+v", fixture.ChangePassword)
	}
	passwordBytes, err := base64.StdEncoding.DecodeString(storedPassword)
	if err != nil {
		t.Fatal(err)
	}
	saltBytes, err := base64.StdEncoding.DecodeString(storedSalt)
	if err != nil {
		t.Fatal(err)
	}
	if !fixture.Persisted.PasswordVerifies || len(passwordBytes) != fixture.Persisted.PasswordHashBytes || len(saltBytes) != fixture.Persisted.SaltBytes || len(saltBytes) != fixture.Inputs.SaltBytes {
		t.Fatalf("password hash/salt size = %d/%d; pinned Node has %d/%d", len(passwordBytes), len(saltBytes), fixture.Persisted.PasswordHashBytes, fixture.Persisted.SaltBytes)
	}
	avatarBytes, err := os.ReadFile(filepath.Join(storagePath, nodeStoreFilename(avatarStoragePrefix+"default-user")))
	if err != nil {
		t.Fatal(err)
	}
	var avatarRecord struct {
		Key   string          `json:"key"`
		Value json.RawMessage `json:"value"`
	}
	if err := json.Unmarshal(avatarBytes, &avatarRecord); err != nil {
		t.Fatal(err)
	}
	var storedAvatar string
	_ = json.Unmarshal(avatarRecord.Value, &storedAvatar)
	if got := orderedJSONObjectKeys(avatarBytes); !reflect.DeepEqual(got, fixture.Persisted.AvatarRecordKeys) || avatarRecord.Key != avatarStoragePrefix+"default-user" || storedAvatar != fixture.Persisted.AvatarRecordValue || storedAvatar != fixture.Persisted.Avatar {
		t.Fatalf("persisted avatar record = key %q value %q keys %v; pinned Node has %+v", avatarRecord.Key, storedAvatar, orderedJSONObjectKeys(avatarBytes), fixture.Persisted)
	}
}

func assertAccountMutationResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
	t.Helper()
	assertAccountMutationResponseExcluding(t, label, got, want)
}

func assertAccountMutationResponseExcluding(t *testing.T, label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture, excluded ...string) {
	t.Helper()
	if got.Code != want.Status {
		t.Fatalf("%s status = %d; pinned Node has %d", label, got.Code, want.Status)
	}
	assertPinnedHeadersExcluding(t, got.Header(), want.Headers, excluded...)
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

func assertMutationCookieSet(t *testing.T, cookies []string, sessionName string, wantCount int, want []string) {
	t.Helper()
	if len(cookies) != wantCount {
		t.Fatalf("session mutation set %d cookies; pinned Node sets %d", len(cookies), wantCount)
	}
	if got := normalizeAccountCookies(t, cookies, sessionName); !reflect.DeepEqual(got, want) {
		t.Fatalf("session mutation cookies = %#v; pinned Node has %#v", got, want)
	}
}

func orderedJSONObjectKeys(body []byte) []string {
	decoder := json.NewDecoder(strings.NewReader(string(body)))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil
	}
	keys := make([]string, 0, 3)
	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil
		}
		key, ok := token.(string)
		if !ok {
			return nil
		}
		keys = append(keys, key)
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil
		}
	}
	return keys
}
