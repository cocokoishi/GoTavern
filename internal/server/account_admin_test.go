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

type accountAdminFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string `json:"cookieSecret"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	Persisted struct {
		RemainingHandles      []string `json:"remainingHandles"`
		DisabledUserEnabled   bool     `json:"disabledUserEnabled"`
		RegularUserEnabled    bool     `json:"regularUserEnabled"`
		PromotedAdmin         bool     `json:"promotedAdmin"`
		DemotedAdmin          bool     `json:"demotedAdmin"`
		UnknownFieldPreserved bool     `json:"unknownFieldPreserved"`
		RetainRecordExists    bool     `json:"retainRecordExists"`
		PurgeRecordExists     bool     `json:"purgeRecordExists"`
		RetainDirectoryExists bool     `json:"retainDirectoryExists"`
		PurgeDirectoryExists  bool     `json:"purgeDirectoryExists"`
	} `json:"persisted"`
}

func TestPinnedNodeAccountAdminManagementContract(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-account-admin.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture accountAdminFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("account-admin oracle baseline = %+v", fixture.Baseline)
	}

	dataRoot := t.TempDir()
	storagePath := filepath.Join(dataRoot, userStorageFolder)
	if err := os.MkdirAll(storagePath, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	type futureField struct {
		Keep bool `json:"keep"`
	}
	type user struct {
		Handle      string       `json:"handle"`
		Name        string       `json:"name"`
		Created     int64        `json:"created"`
		Password    string       `json:"password"`
		Admin       bool         `json:"admin"`
		Enabled     bool         `json:"enabled"`
		Salt        string       `json:"salt"`
		FutureField *futureField `json:"futureField,omitempty"`
	}
	handles := []string{"default-user", "second-admin", "regular-user", "disabled-user", "promote-user", "demote-user", "retain-user", "purge-user"}
	admins := map[string]bool{"default-user": true, "second-admin": true, "demote-user": true}
	enabled := map[string]bool{"default-user": true, "second-admin": true, "regular-user": true, "disabled-user": false, "promote-user": true, "demote-user": true, "retain-user": true, "purge-user": true}
	created := map[string]int64{}
	for index, handle := range handles {
		created[handle] = int64(1700000000000 + index)
		account := user{
			Handle: handle, Name: map[string]string{
				"default-user": "Admin", "second-admin": "Second Admin", "regular-user": "Regular User",
				"disabled-user": "Disabled User", "promote-user": "Promote User", "demote-user": "Demote User",
				"retain-user": "Retain Directory User", "purge-user": "Purge Directory User",
			}[handle],
			Created: created[handle], Password: "", Admin: admins[handle], Enabled: enabled[handle], Salt: "",
		}
		if handle == "default-user" {
			account.FutureField = &futureField{Keep: true}
		}
		body, err := json.Marshal(struct {
			Key   string `json:"key"`
			Value user   `json:"value"`
		}{Key: userStoragePrefix + handle, Value: account})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(storagePath, nodeStoreFilename(userStoragePrefix+handle)), body, 0o600); err != nil {
			t.Fatal(err)
		}
		userRoot := filepath.Join(dataRoot, handle)
		if err := os.MkdirAll(userRoot, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(userRoot, "admin-probe-sentinel.txt"), []byte(handle), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	avatarBytes, err := json.Marshal(struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}{Key: avatarStoragePrefix + "regular-user", Value: "data:image/png;base64,AQ=="})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(storagePath, nodeStoreFilename(avatarStoragePrefix+"regular-user")), avatarBytes, 0o600); err != nil {
		t.Fatal(err)
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{DataRoot: dataRoot, AccountsEnabled: true})
	serve := func(method, route, cookie, token, body string) *httptest.ResponseRecorder {
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
	csrf := serve(http.MethodGet, "/csrf-token", "", "", "")
	if csrf.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d, body %q", csrf.Code, csrf.Body.String())
	}
	var csrfBody struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrf.Body.Bytes(), &csrfBody); err != nil {
		t.Fatal(err)
	}
	cookieFrom := func(cookies []string) string {
		t.Helper()
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfCookie := cookieFrom(csrf.Header().Values("Set-Cookie"))
	post := func(route, cookie, body string) *httptest.ResponseRecorder {
		t.Helper()
		return serve(http.MethodPost, "/api/users/"+route, cookie, csrfBody.Token, body)
	}
	login := func(handle string) string {
		t.Helper()
		response := post("login", csrfCookie, `{"handle":"`+handle+`"}`)
		if response.Code != http.StatusOK {
			t.Fatalf("POST /api/users/login for %q = %d, body %q", handle, response.Code, response.Body.String())
		}
		return cookieFrom(response.Header().Values("Set-Cookie"))
	}
	adminCookie := login("default-user")
	regularCookie := login("regular-user")
	secondAdminCookie := login("second-admin")
	response := func(route, cookie string, body any) *httptest.ResponseRecorder {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return post(route, cookie, string(encoded))
	}

	gotResponses := make(map[string]*httptest.ResponseRecorder, len(fixture.Responses))
	for _, item := range []struct {
		name   string
		route  string
		cookie string
		body   any
	}{
		{"usersBefore", "get", adminCookie, map[string]any{}},
		{"nonAdminGet", "get", regularCookie, map[string]any{}},
		{"missingDisable", "disable", adminCookie, map[string]any{}},
		{"selfDisable", "disable", adminCookie, map[string]any{"handle": "default-user"}},
		{"unknownDisable", "disable", adminCookie, map[string]any{"handle": "missing-user"}},
		{"disable", "disable", adminCookie, map[string]any{"handle": "regular-user"}},
		{"loginDisabled", "login", csrfCookie, map[string]any{"handle": "regular-user"}},
		{"missingEnable", "enable", adminCookie, map[string]any{}},
		{"unknownEnable", "enable", adminCookie, map[string]any{"handle": "missing-user"}},
		{"enable", "enable", adminCookie, map[string]any{"handle": "regular-user"}},
		{"missingPromote", "promote", adminCookie, map[string]any{}},
		{"unknownPromote", "promote", adminCookie, map[string]any{"handle": "missing-user"}},
		{"promote", "promote", adminCookie, map[string]any{"handle": "promote-user"}},
		{"missingDemote", "demote", adminCookie, map[string]any{}},
		{"selfDemote", "demote", secondAdminCookie, map[string]any{"handle": "second-admin"}},
		{"unknownDemote", "demote", adminCookie, map[string]any{"handle": "missing-user"}},
		{"demote", "demote", adminCookie, map[string]any{"handle": "demote-user"}},
		{"usersAfterRoleChanges", "get", adminCookie, map[string]any{}},
		{"missingDelete", "delete", adminCookie, map[string]any{}},
		{"selfDelete", "delete", secondAdminCookie, map[string]any{"handle": "second-admin"}},
		{"defaultDelete", "delete", secondAdminCookie, map[string]any{"handle": "default-user"}},
		{"unknownDelete", "delete", adminCookie, map[string]any{"handle": "missing-user"}},
		{"deleteRetain", "delete", adminCookie, map[string]any{"handle": "retain-user"}},
		{"deletePurge", "delete", adminCookie, map[string]any{"handle": "purge-user", "purge": true}},
		{"usersAfterDeletes", "get", adminCookie, map[string]any{}},
	} {
		gotResponses[item.name] = response(item.route, item.cookie, item.body)
	}
	for label, got := range gotResponses {
		if label == "usersBefore" || label == "usersAfterRoleChanges" || label == "usersAfterDeletes" {
			want := fixture.Responses[label]
			want.Headers = withoutHeader(withoutHeader(withoutHeader(want.Headers, "content-length"), "content-encoding"), "transfer-encoding")
			assertAccountMutationResponseExcluding(t, label, got, want, "Content-Length", "Content-Encoding", "Transfer-Encoding")
		} else {
			assertAccountMutationResponse(t, label, got, fixture.Responses[label])
		}
	}

	for _, handle := range []string{"disabled-user", "regular-user", "promote-user", "demote-user", "default-user"} {
		account, found, err := loadStoredAccount(dataRoot, handle)
		if err != nil || !found {
			t.Fatalf("load persisted admin-mutated user %q = found %v, error %v", handle, found, err)
		}
		wantEnabled := fixture.Persisted.RegularUserEnabled
		if handle == "disabled-user" {
			wantEnabled = fixture.Persisted.DisabledUserEnabled
		}
		if handle == "default-user" && !nodeTruthyJSON(account.raw("futureField")) {
			t.Fatal("admin account mutation removed an unknown user field")
		}
		if handle == "regular-user" || handle == "disabled-user" {
			if nodeTruthyJSON(account.raw("enabled")) != wantEnabled {
				t.Fatalf("persisted enabled flag for %q = %s, expected %v", handle, account.raw("enabled"), wantEnabled)
			}
		}
		if handle == "promote-user" && nodeTruthyJSON(account.raw("admin")) != fixture.Persisted.PromotedAdmin {
			t.Fatalf("persisted promoted admin flag = %s; pinned Node has %v", account.raw("admin"), fixture.Persisted.PromotedAdmin)
		}
		if handle == "demote-user" && nodeTruthyJSON(account.raw("admin")) != fixture.Persisted.DemotedAdmin {
			t.Fatalf("persisted demoted admin flag = %s; pinned Node has %v", account.raw("admin"), fixture.Persisted.DemotedAdmin)
		}
	}
	if _, found, err := loadStoredAccount(dataRoot, "retain-user"); err != nil || found != fixture.Persisted.RetainRecordExists {
		t.Fatalf("retained user's account record found=%v error=%v, pinned Node has %v", found, err, fixture.Persisted.RetainRecordExists)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "retain-user", "admin-probe-sentinel.txt")); (err == nil) != fixture.Persisted.RetainDirectoryExists {
		t.Fatalf("retained directory existence error = %v, pinned Node has %v", err, fixture.Persisted.RetainDirectoryExists)
	}
	if _, found, err := loadStoredAccount(dataRoot, "purge-user"); err != nil || found != fixture.Persisted.PurgeRecordExists {
		t.Fatalf("purged user's account record found=%v error=%v, pinned Node has %v", found, err, fixture.Persisted.PurgeRecordExists)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "purge-user")); (err == nil) != fixture.Persisted.PurgeDirectoryExists {
		t.Fatalf("purged directory existence error = %v, pinned Node has %v", err, fixture.Persisted.PurgeDirectoryExists)
	}
	if !fixture.Persisted.UnknownFieldPreserved {
		t.Fatal("pinned account-admin probe did not confirm unknown field retention")
	}
	if !reflect.DeepEqual(fixture.Persisted.RemainingHandles, []string{"default-user", "second-admin", "regular-user", "disabled-user", "promote-user", "demote-user"}) {
		t.Fatalf("pinned remaining handles = %v", fixture.Persisted.RemainingHandles)
	}
}
