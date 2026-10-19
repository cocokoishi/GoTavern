package server

import (
	"bytes"
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

	"github.com/cocokoishi/gotavern/internal/startup"
)

type accountResetSettingsFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string `json:"cookieSecret"`
		Password     string `json:"password"`
		Salt         string `json:"salt"`
	} `json:"inputs"`
	Responses  map[string]accountMutationResponseFixture `json:"responses"`
	Filesystem struct {
		CustomSettingsSHA256 string `json:"customSettingsSHA256"`
		CustomSettingsBytes  int    `json:"customSettingsBytes"`
		AfterFailedAttempts  struct {
			ProtectedSettings      accountCreateFileDigest `json:"protectedSettings"`
			PasswordlessSettings   accountCreateFileDigest `json:"passwordlessSettings"`
			GlobalContentLogExists bool                    `json:"globalContentLogExists"`
		} `json:"afterFailedAttempts"`
		AfterProtectedReset               accountCreateFilesystem `json:"afterProtectedReset"`
		AfterProtectedResetAgain          accountCreateFilesystem `json:"afterProtectedResetAgain"`
		AfterPasswordlessReset            accountCreateFilesystem `json:"afterPasswordlessReset"`
		AfterPasswordlessResetMissingFile accountCreateFilesystem `json:"afterPasswordlessResetMissingFile"`
		GlobalContent                     struct {
			ContentLog  *accountCreateFileDigest `json:"contentLog"`
			Errors      accountCreateFilesystem  `json:"errors"`
			Stylesheets accountCreateFilesystem  `json:"stylesheets"`
		} `json:"globalContent"`
		AccountRecordsUnchanged struct {
			ProtectedUser    bool `json:"protectedUser"`
			PasswordlessUser bool `json:"passwordlessUser"`
		} `json:"accountRecordsUnchanged"`
	} `json:"filesystem"`
}

func TestPinnedNodeAccountResetSettingsContract(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-account-reset-settings.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture accountResetSettingsFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("account-reset-settings oracle baseline = %+v", fixture.Baseline)
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
	directories, err := startup.EnsureDirectories(installRoot, dataRoot, handles)
	if err != nil {
		t.Fatal(err)
	}
	if migrationErrors, err := startup.MigrateSystemPrompts(dataRoot, directories); err != nil || len(migrationErrors) != 0 {
		t.Fatalf("initialize pinned system-prompt migration state: errors=%v, fatal=%v", migrationErrors, err)
	}
	statistics := startup.InitializeStatistics(directories, time.UnixMilli(1735689600000))
	if len(statistics.Errors) != 0 {
		t.Fatalf("initialize pinned statistics state: %v", statistics.Errors)
	}
	for _, handle := range handles {
		if err := os.WriteFile(filepath.Join(dataRoot, handle, "settings.json"), accountResetCustomSettings(handle), 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dataRoot, handle, "reset-settings-probe.sentinel"), []byte("keep:"+handle), 0o600); err != nil {
			t.Fatal(err)
		}
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
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
	post := func(cookie string, body any) *httptest.ResponseRecorder {
		t.Helper()
		return serve(http.MethodPost, "/api/users/reset-settings", cookie, csrfBody.Token, body)
	}
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

	gotResponses := map[string]*httptest.ResponseRecorder{
		"unauthorized":      post(csrfCookie, map[string]any{}),
		"missingPassword":   post(adminCookie, map[string]any{}),
		"wrongPassword":     post(adminCookie, map[string]any{"password": "incorrect"}),
		"nonStringPassword": post(adminCookie, map[string]any{"password": 7}),
	}
	var failedSettings = struct {
		Protected    *accountCreateFileDigest
		Passwordless *accountCreateFileDigest
	}{
		Protected:    accountCreateFileSummary(t, filepath.Join(dataRoot, "default-user", "settings.json")),
		Passwordless: accountCreateFileSummary(t, filepath.Join(dataRoot, "guest-user", "settings.json")),
	}
	globalLogExists := false
	if _, err := os.Stat(filepath.Join(dataRoot, "content.log")); err == nil {
		globalLogExists = true
	} else if !os.IsNotExist(err) {
		t.Fatal(err)
	}
	gotResponses["protectedReset"] = post(adminCookie, map[string]any{"password": fixture.Inputs.Password})
	afterProtectedReset := accountCreateSnapshot(t, filepath.Join(dataRoot, "default-user"))
	if err := os.WriteFile(filepath.Join(dataRoot, "default-user", "settings.json"), accountResetCustomSettings("default-user"), 0o600); err != nil {
		t.Fatal(err)
	}
	gotResponses["protectedResetAgain"] = post(adminCookie, map[string]any{"password": fixture.Inputs.Password})
	afterProtectedResetAgain := accountCreateSnapshot(t, filepath.Join(dataRoot, "default-user"))
	if err := os.WriteFile(filepath.Join(dataRoot, "guest-user", "settings.json"), accountResetCustomSettings("guest-user"), 0o600); err != nil {
		t.Fatal(err)
	}
	gotResponses["passwordlessReset"] = post(guestCookie, map[string]any{"password": "ignored"})
	afterPasswordlessReset := accountCreateSnapshot(t, filepath.Join(dataRoot, "guest-user"))
	if err := os.Remove(filepath.Join(dataRoot, "guest-user", "settings.json")); err != nil {
		t.Fatal(err)
	}
	gotResponses["passwordlessResetMissingFile"] = post(guestCookie, map[string]any{})
	afterPasswordlessResetMissingFile := accountCreateSnapshot(t, filepath.Join(dataRoot, "guest-user"))

	for label, got := range gotResponses {
		assertAccountMutationResponse(t, "POST /api/users/reset-settings "+label, got, fixture.Responses[label])
	}
	if failedSettings.Protected.SHA256 != fixture.Filesystem.CustomSettingsSHA256 ||
		failedSettings.Protected.Bytes != int64(fixture.Filesystem.CustomSettingsBytes) ||
		failedSettings.Passwordless.SHA256 != hex.EncodeToString(sha256Bytes(accountResetCustomSettings("guest-user"))) ||
		globalLogExists != fixture.Filesystem.AfterFailedAttempts.GlobalContentLogExists {
		t.Fatalf("failed reset attempts changed filesystem state: protected=%+v passwordless=%+v globalLog=%v", failedSettings, failedSettings.Passwordless, globalLogExists)
	}
	if !reflect.DeepEqual(afterProtectedReset, fixture.Filesystem.AfterProtectedReset) ||
		!reflect.DeepEqual(afterProtectedResetAgain, fixture.Filesystem.AfterProtectedResetAgain) ||
		!reflect.DeepEqual(afterPasswordlessReset, fixture.Filesystem.AfterPasswordlessReset) ||
		!reflect.DeepEqual(afterPasswordlessResetMissingFile, fixture.Filesystem.AfterPasswordlessResetMissingFile) {
		t.Fatalf("reset-settings user filesystem states differ from pinned Node: protected=%v protectedAgain=%v passwordless=%v passwordlessMissing=%v",
			accountResetFilesystemDiff(afterProtectedReset, fixture.Filesystem.AfterProtectedReset),
			accountResetFilesystemDiff(afterProtectedResetAgain, fixture.Filesystem.AfterProtectedResetAgain),
			accountResetFilesystemDiff(afterPasswordlessReset, fixture.Filesystem.AfterPasswordlessReset),
			accountResetFilesystemDiff(afterPasswordlessResetMissingFile, fixture.Filesystem.AfterPasswordlessResetMissingFile))
	}
	if !reflect.DeepEqual(accountCreateFileSummary(t, filepath.Join(dataRoot, "content.log")), fixture.Filesystem.GlobalContent.ContentLog) {
		t.Fatalf("reset-settings global content log differs from pinned Node")
	}
	for _, item := range []struct {
		name string
		path string
		want accountCreateFilesystem
	}{{"global error pages", "_errors", fixture.Filesystem.GlobalContent.Errors}, {"global stylesheets", "_css", fixture.Filesystem.GlobalContent.Stylesheets}} {
		if got := accountCreateSnapshot(t, filepath.Join(dataRoot, item.path)); !reflect.DeepEqual(got, item.want) {
			t.Fatalf("reset-settings %s differ from pinned Node", item.name)
		}
	}
	for _, handle := range handles {
		got, err := os.ReadFile(filepath.Join(dataRoot, userStorageFolder, nodeStoreFilename(userStoragePrefix+handle)))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(got, accountRecordBytes[handle]) {
			t.Fatalf("reset-settings changed persisted account %q", handle)
		}
	}
	if !fixture.Filesystem.AccountRecordsUnchanged.ProtectedUser || !fixture.Filesystem.AccountRecordsUnchanged.PasswordlessUser {
		t.Fatal("pinned reset-settings route changed an account storage record")
	}
}

func accountResetCustomSettings(handle string) []byte {
	return []byte(`{"probe":"preserve until successful reset","handle":"` + handle + `","nested":[1,true]}`)
}

func accountResetFilesystemDiff(got, want accountCreateFilesystem) []string {
	differences := make([]string, 0)
	if !reflect.DeepEqual(got.Directories, want.Directories) {
		differences = append(differences, fmt.Sprintf("directories %d/%d", len(got.Directories), len(want.Directories)))
	}
	gotFiles := make(map[string]accountCreateFileDigest, len(got.Files))
	wantFiles := make(map[string]accountCreateFileDigest, len(want.Files))
	for _, file := range got.Files {
		gotFiles[file.Path] = file
	}
	for _, file := range want.Files {
		wantFiles[file.Path] = file
	}
	for name, gotFile := range gotFiles {
		wantFile, found := wantFiles[name]
		if !found || gotFile != wantFile {
			differences = append(differences, "file "+name)
		}
		if len(differences) >= 8 {
			return differences
		}
	}
	for name := range wantFiles {
		if _, found := gotFiles[name]; !found {
			differences = append(differences, "missing file "+name)
		}
		if len(differences) >= 8 {
			return differences
		}
	}
	if len(got.Files) != len(want.Files) {
		differences = append(differences, fmt.Sprintf("file count %d/%d", len(got.Files), len(want.Files)))
	}
	return differences
}
