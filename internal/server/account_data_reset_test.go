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
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type accountDataResetResponseFixture struct {
	Status             int               `json:"status"`
	Headers            map[string]string `json:"headers"`
	Body               any               `json:"body"`
	RetryAfterPositive bool              `json:"retryAfterPositive"`
}

type accountDataResetFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string  `json:"cookieSecret"`
		Password     string  `json:"password"`
		Salt         string  `json:"salt"`
		ResetPoints  float64 `json:"resetPoints"`
	} `json:"inputs"`
	Responses  map[string]accountDataResetResponseFixture `json:"responses"`
	Filesystem struct {
		BeforeProtectedReset     accountCreateFilesystem `json:"beforeProtectedReset"`
		BeforeGuestReset         accountCreateFilesystem `json:"beforeGuestReset"`
		AfterProtectedFailures   accountCreateFilesystem `json:"afterProtectedFailures"`
		AfterProtectedReset      accountCreateFilesystem `json:"afterProtectedReset"`
		AfterProtectedReplay     accountCreateFilesystem `json:"afterProtectedReplay"`
		GuestAfterProtectedReset accountCreateFilesystem `json:"guestAfterProtectedReset"`
		AfterGuestReset          accountCreateFilesystem `json:"afterGuestReset"`
		AfterGuestFailures       accountCreateFilesystem `json:"afterGuestFailures"`
		AfterSkipContentReset    accountCreateFilesystem `json:"afterSkipContentReset"`
		GlobalContent            struct {
			ContentLog  *accountCreateFileDigest `json:"contentLog"`
			Errors      accountCreateFilesystem  `json:"errors"`
			Stylesheets accountCreateFilesystem  `json:"stylesheets"`
		} `json:"globalContent"`
		AccountRecordsUnchanged struct {
			ProtectedUser    bool `json:"protectedUser"`
			PasswordlessUser bool `json:"passwordlessUser"`
		} `json:"accountRecordsUnchanged"`
		ResetCodeDigits         int `json:"resetCodeDigits"`
		RateLimitedAttemptCount int `json:"rateLimitedAttemptCount"`
	} `json:"filesystem"`
}

func TestPinnedNodeAccountDataResetContract(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-account-data-reset.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture accountDataResetFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("account-data-reset oracle baseline = %+v", fixture.Baseline)
	}

	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	salt := fixture.Inputs.Salt
	passwordHash, err := upstreamPasswordHash(fixture.Inputs.Password, salt)
	if err != nil {
		t.Fatal(err)
	}
	accounts := []struct {
		handle   string
		name     string
		created  int64
		password string
		admin    bool
		salt     string
	}{
		{handle: "default-user", name: "Protected User", created: 1700000000000, password: passwordHash, admin: true, salt: salt},
		{handle: "guest-user", name: "Passwordless User", created: 1700000000001},
	}
	handles := make([]string, 0, len(accounts))
	accountRecordBytes := make(map[string][]byte, len(accounts))
	for _, account := range accounts {
		handles = append(handles, account.handle)
		value := struct {
			Handle   string `json:"handle"`
			Name     string `json:"name"`
			Created  int64  `json:"created"`
			Password string `json:"password"`
			Admin    bool   `json:"admin"`
			Enabled  bool   `json:"enabled"`
			Salt     string `json:"salt"`
		}{account.handle, account.name, account.created, account.password, account.admin, true, account.salt}
		encoded, err := marshalNodeJSON(value)
		if err != nil {
			t.Fatal(err)
		}
		if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+account.handle, encoded); err != nil {
			t.Fatal(err)
		}
		accountRecordBytes[account.handle], err = os.ReadFile(filepath.Join(dataRoot, userStorageFolder, nodeStoreFilename(userStoragePrefix+account.handle)))
		if err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.EnsureDirectories(installRoot, dataRoot, handles)
	if err != nil {
		t.Fatal(err)
	}
	if migrationErrors, err := startup.MigrateSystemPrompts(dataRoot, directories); err != nil || len(migrationErrors) != 0 {
		t.Fatalf("initialize pinned system-prompt migration state: errors=%v, fatal=%v", migrationErrors, err)
	}
	if _, err := startup.SeedDefaultContent(dataRoot, directories, startup.SeedOptions{}); err != nil {
		t.Fatal(err)
	}
	if errors := startup.BackupSettings(directories, 50); len(errors) != 0 {
		t.Fatalf("create pinned settings startup backups: %v", errors)
	}
	for _, handle := range handles {
		backupRoot := filepath.Join(dataRoot, handle, "backups")
		entries, err := os.ReadDir(backupRoot)
		if err != nil {
			t.Fatal(err)
		}
		for _, entry := range entries {
			name := entry.Name()
			if strings.HasPrefix(name, "settings_"+handle+"_") && strings.HasSuffix(name, ".json") {
				if err := os.Rename(filepath.Join(backupRoot, name), filepath.Join(backupRoot, "settings_"+handle+"_20250101-000000.json")); err != nil {
					t.Fatal(err)
				}
			}
		}
	}
	if statistics := startup.InitializeStatistics(directories, time.UnixMilli(1735689600000)); len(statistics.Errors) != 0 {
		t.Fatalf("initialize pinned statistics state: %v", statistics.Errors)
	}
	for _, handle := range handles {
		if err := os.WriteFile(filepath.Join(dataRoot, handle, "stats.json"), []byte(`{"timestamp":1735689600000}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dataRoot, handle, "reset-data-probe.sentinel"), []byte("remove:"+handle), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(filepath.Join(dataRoot, handle, "chats", "reset-probe"), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dataRoot, handle, "chats", "reset-probe", "nested.json"), []byte(`{"remove":true}`), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dataRoot, handle, "settings.json"), []byte(`{"customBeforeReset":"`+handle+`"}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	beforeProtectedReset := accountCreateSnapshot(t, filepath.Join(dataRoot, "default-user"))
	beforeGuestReset := accountCreateSnapshot(t, filepath.Join(dataRoot, "guest-user"))

	codes := []string{"246810", "135790", "112233", "445566"}
	codeIndex := 0
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret,
		AccountsEnabled: true, ResetRateLimitPoints: &fixture.Inputs.ResetPoints,
		resetCodeGenerator: func() (string, error) {
			if codeIndex >= len(codes) {
				return "", nil
			}
			code := codes[codeIndex]
			codeIndex++
			return code, nil
		},
	})
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
	cookieFrom := func(cookies []string) string {
		t.Helper()
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfCookie := cookieFrom(csrf.Header().Values("Set-Cookie"))
	login := func(handle, password string) string {
		t.Helper()
		response := serve(http.MethodPost, "/api/users/login", csrfCookie, csrfBody.Token, map[string]string{"handle": handle, "password": password})
		if response.Code != http.StatusOK {
			t.Fatalf("POST /api/users/login for %q = %d, body %q", handle, response.Code, response.Body.String())
		}
		return cookieFrom(response.Header().Values("Set-Cookie"))
	}
	adminCookie := login("default-user", fixture.Inputs.Password)
	guestCookie := login("guest-user", "")
	postStep1 := func(cookie string) *httptest.ResponseRecorder {
		t.Helper()
		return serve(http.MethodPost, "/api/users/reset-step1", cookie, csrfBody.Token, nil)
	}
	postStep2 := func(cookie string, body map[string]any) *httptest.ResponseRecorder {
		t.Helper()
		return serve(http.MethodPost, "/api/users/reset-step2", cookie, csrfBody.Token, body)
	}
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorizedStep1": postStep1(csrfCookie),
		"unauthorizedStep2": postStep2(csrfCookie, map[string]any{"code": codes[0], "password": fixture.Inputs.Password}),
	}
	responses["adminStep1"] = postStep1(adminCookie)
	responses["missingCode"] = postStep2(adminCookie, map[string]any{"password": fixture.Inputs.Password})
	responses["missingPassword"] = postStep2(adminCookie, map[string]any{"code": codes[0]})
	responses["wrongPassword"] = postStep2(adminCookie, map[string]any{"code": codes[0], "password": "incorrect"})
	responses["wrongCode"] = postStep2(adminCookie, map[string]any{"code": "not-a-six-digit-code", "password": fixture.Inputs.Password})
	responses["adminStep1Replacement"] = postStep1(adminCookie)
	responses["oldCode"] = postStep2(adminCookie, map[string]any{"code": codes[0], "password": fixture.Inputs.Password})
	afterProtectedFailures := accountCreateSnapshot(t, filepath.Join(dataRoot, "default-user"))
	responses["adminSuccess"] = postStep2(adminCookie, map[string]any{"code": codes[1], "password": fixture.Inputs.Password})
	afterProtectedReset := accountCreateSnapshot(t, filepath.Join(dataRoot, "default-user"))
	responses["adminReplay"] = postStep2(adminCookie, map[string]any{"code": codes[1], "password": fixture.Inputs.Password})
	afterProtectedReplay := accountCreateSnapshot(t, filepath.Join(dataRoot, "default-user"))
	guestAfterProtectedReset := accountCreateSnapshot(t, filepath.Join(dataRoot, "guest-user"))
	responses["guestStep1"] = postStep1(guestCookie)
	responses["guestSuccess"] = postStep2(guestCookie, map[string]any{"code": codes[2], "password": "ignored for passwordless account"})
	afterGuestReset := accountCreateSnapshot(t, filepath.Join(dataRoot, "guest-user"))
	responses["guestLimitedStep1"] = postStep1(guestCookie)
	responses["guestWrongCode1"] = postStep2(guestCookie, map[string]any{"code": "not-a-six-digit-code", "password": ""})
	responses["guestWrongCode2"] = postStep2(guestCookie, map[string]any{"code": "not-a-six-digit-code", "password": ""})
	responses["guestRateLimited"] = postStep2(guestCookie, map[string]any{"code": "not-a-six-digit-code", "password": ""})
	responses["guestStep1RateLimited"] = postStep1(guestCookie)
	afterGuestFailures := accountCreateSnapshot(t, filepath.Join(dataRoot, "guest-user"))

	handler = NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret,
		AccountsEnabled: true, SkipContentCheck: true, ResetRateLimitPoints: &fixture.Inputs.ResetPoints,
		resetCodeGenerator: func() (string, error) { return "556677", nil },
	})
	skipCSRF := serve(http.MethodGet, "/csrf-token", "", "", nil)
	if skipCSRF.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token with skipContentCheck = %d, body %q", skipCSRF.Code, skipCSRF.Body.String())
	}
	if err := json.Unmarshal(skipCSRF.Body.Bytes(), &csrfBody); err != nil {
		t.Fatal(err)
	}
	csrfCookie = cookieFrom(skipCSRF.Header().Values("Set-Cookie"))
	skipGuestCookie := login("guest-user", "")
	responses["skipContentStep1"] = postStep1(skipGuestCookie)
	responses["skipContentSuccess"] = postStep2(skipGuestCookie, map[string]any{"code": "556677", "password": ""})
	afterSkipContentReset := accountCreateSnapshot(t, filepath.Join(dataRoot, "guest-user"))

	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("pinned account-data-reset fixture has no response %q", label)
		}
		assertAccountDataResetResponse(t, label, got, want)
	}
	for label := range fixture.Responses {
		if _, exists := responses[label]; !exists {
			t.Fatalf("Go account-data-reset flow did not capture pinned response %q", label)
		}
	}
	if fixture.Filesystem.ResetCodeDigits != 6 || fixture.Filesystem.RateLimitedAttemptCount != int(fixture.Inputs.ResetPoints)+1 {
		t.Fatalf("pinned reset code/rate-limit contract = digits %d, attempts %d for %v points", fixture.Filesystem.ResetCodeDigits, fixture.Filesystem.RateLimitedAttemptCount, fixture.Inputs.ResetPoints)
	}
	if !reflect.DeepEqual(beforeProtectedReset, fixture.Filesystem.BeforeProtectedReset) ||
		!reflect.DeepEqual(beforeGuestReset, fixture.Filesystem.BeforeGuestReset) ||
		!reflect.DeepEqual(afterProtectedFailures, fixture.Filesystem.AfterProtectedFailures) ||
		!reflect.DeepEqual(afterProtectedReset, fixture.Filesystem.AfterProtectedReset) ||
		!reflect.DeepEqual(afterProtectedReplay, fixture.Filesystem.AfterProtectedReplay) ||
		!reflect.DeepEqual(guestAfterProtectedReset, fixture.Filesystem.GuestAfterProtectedReset) ||
		!reflect.DeepEqual(afterGuestReset, fixture.Filesystem.AfterGuestReset) ||
		!reflect.DeepEqual(afterGuestFailures, fixture.Filesystem.AfterGuestFailures) ||
		!reflect.DeepEqual(afterSkipContentReset, fixture.Filesystem.AfterSkipContentReset) {
		t.Fatalf("account-data-reset user filesystem differs from pinned Node: beforeProtected=%v beforeGuest=%v protectedFailures=%v protectedReset=%v replay=%v otherUser=%v guestReset=%v guestFailures=%v skippedSeed=%v",
			accountResetFilesystemDiff(beforeProtectedReset, fixture.Filesystem.BeforeProtectedReset),
			accountResetFilesystemDiff(beforeGuestReset, fixture.Filesystem.BeforeGuestReset),
			accountResetFilesystemDiff(afterProtectedFailures, fixture.Filesystem.AfterProtectedFailures),
			accountResetFilesystemDiff(afterProtectedReset, fixture.Filesystem.AfterProtectedReset),
			accountResetFilesystemDiff(afterProtectedReplay, fixture.Filesystem.AfterProtectedReplay),
			accountResetFilesystemDiff(guestAfterProtectedReset, fixture.Filesystem.GuestAfterProtectedReset),
			accountResetFilesystemDiff(afterGuestReset, fixture.Filesystem.AfterGuestReset),
			accountResetFilesystemDiff(afterGuestFailures, fixture.Filesystem.AfterGuestFailures),
			accountResetFilesystemDiff(afterSkipContentReset, fixture.Filesystem.AfterSkipContentReset))
	}
	if !reflect.DeepEqual(accountCreateFileSummary(t, filepath.Join(dataRoot, "content.log")), fixture.Filesystem.GlobalContent.ContentLog) ||
		!reflect.DeepEqual(accountCreateSnapshot(t, filepath.Join(dataRoot, "_errors")), fixture.Filesystem.GlobalContent.Errors) ||
		!reflect.DeepEqual(accountCreateSnapshot(t, filepath.Join(dataRoot, "_css")), fixture.Filesystem.GlobalContent.Stylesheets) {
		t.Fatal("account-data-reset global content differs from pinned Node")
	}
	for _, account := range accounts {
		current, err := os.ReadFile(filepath.Join(dataRoot, userStorageFolder, nodeStoreFilename(userStoragePrefix+account.handle)))
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(current, accountRecordBytes[account.handle]) {
			t.Fatalf("account-data-reset changed persisted account %q", account.handle)
		}
	}
	if !fixture.Filesystem.AccountRecordsUnchanged.ProtectedUser || !fixture.Filesystem.AccountRecordsUnchanged.PasswordlessUser {
		t.Fatal("pinned account-data-reset route changed a persisted account record")
	}
}

func assertAccountDataResetResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want accountDataResetResponseFixture) {
	t.Helper()
	if got.Code != want.Status {
		t.Fatalf("POST /api/users/reset-%s status = %d; pinned Node has %d", label, got.Code, want.Status)
	}
	assertPinnedHeadersExcluding(t, got.Header(), want.Headers, "retry-after")
	var body any
	if got.Body.Len() > 0 {
		if err := json.Unmarshal(got.Body.Bytes(), &body); err != nil {
			body = got.Body.String()
		}
	}
	if !reflect.DeepEqual(body, want.Body) {
		t.Fatalf("POST /api/users reset %s body = %#v; pinned Node has %#v", label, body, want.Body)
	}
	retryAfter := got.Header().Get("Retry-After")
	gotRetryAfterPositive := retryAfter != "" && retryAfter != "0"
	if gotRetryAfterPositive != want.RetryAfterPositive {
		t.Fatalf("POST /api/users reset %s Retry-After-positive = %v; pinned Node has %v (header %q)", label, gotRetryAfterPositive, want.RetryAfterPositive, retryAfter)
	}
}
