package server

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type accountBackupScenarioFixture struct {
	Responses               map[string]accountMutationResponseFixture `json:"responses"`
	Archives                map[string]accountCreateFilesystem        `json:"archives"`
	FilesystemUnchanged     bool                                      `json:"filesystemUnchanged"`
	AccountRecordsUnchanged bool                                      `json:"accountRecordsUnchanged"`
}

type accountBackupFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string `json:"cookieSecret"`
		Password     string `json:"password"`
		Salt         string `json:"salt"`
	} `json:"inputs"`
	Standard accountBackupScenarioFixture `json:"standard"`
	Exposed  accountBackupScenarioFixture `json:"exposed"`
	Disabled accountBackupScenarioFixture `json:"disabled"`
}

func TestPinnedNodeAccountBackupContract(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-account-backup.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture accountBackupFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("account-backup oracle baseline = %+v", fixture.Baseline)
	}

	standard := runAccountBackupScenario(t, fixture, true, false)
	assertAccountBackupScenario(t, "standard", standard, fixture.Standard)
	exposed := runAccountBackupScenario(t, fixture, true, true)
	assertAccountBackupScenario(t, "exposed", exposed, fixture.Exposed)
	disabled := runAccountBackupScenario(t, fixture, false, false)
	assertAccountBackupScenario(t, "disabled", disabled, fixture.Disabled)
}

func runAccountBackupScenario(t *testing.T, fixture accountBackupFixture, allowFullDataBackup, allowKeysExposure bool) accountBackupScenarioFixture {
	t.Helper()
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
		{handle: "default-user", name: "Protected Admin", created: 1700000000000, password: passwordHash, admin: true, salt: salt},
		{handle: "guest-user", name: "Passwordless Guest", created: 1700000000001},
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
		t.Fatalf("initialize backup migration state: errors=%v, fatal=%v", migrationErrors, err)
	}
	if statistics := startup.InitializeStatistics(directories, time.UnixMilli(1735689600000)); len(statistics.Errors) != 0 {
		t.Fatalf("initialize backup statistics: %v", statistics.Errors)
	}
	for _, handle := range handles {
		if err := os.WriteFile(filepath.Join(dataRoot, handle, "stats.json"), []byte(`{"timestamp":1735689600000}`), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	defaultRoot := filepath.Join(dataRoot, "default-user")
	guestRoot := filepath.Join(dataRoot, "guest-user")
	writeBackupFixtureFiles(t, defaultRoot, true)
	writeBackupFixtureFiles(t, guestRoot, false)

	allowed := allowFullDataBackup
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret,
		AccountsEnabled: true, AllowFullDataBackup: &allowed, AllowKeysExposure: allowKeysExposure,
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
	post := func(cookie string, body any) *httptest.ResponseRecorder {
		t.Helper()
		return serve(http.MethodPost, "/api/users/backup", cookie, csrfBody.Token, body)
	}
	beforeDefault := accountCreateSnapshot(t, defaultRoot)
	beforeGuest := accountCreateSnapshot(t, guestRoot)
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":      post(csrfCookie, map[string]string{"handle": "default-user"}),
		"missingHandle":     post(adminCookie, map[string]any{}),
		"nonAdminOtherUser": post(guestCookie, map[string]string{"handle": "default-user"}),
		"adminOwn":          post(adminCookie, map[string]string{"handle": "default-user"}),
		"adminOtherUser":    post(adminCookie, map[string]string{"handle": "guest-user"}),
		"guestOwn":          post(guestCookie, map[string]string{"handle": "guest-user"}),
	}
	afterDefault := accountCreateSnapshot(t, defaultRoot)
	afterGuest := accountCreateSnapshot(t, guestRoot)
	fixtureScenario := accountBackupScenarioFixture{
		Responses: make(map[string]accountMutationResponseFixture, len(responses)),
		Archives:  make(map[string]accountCreateFilesystem),
	}
	for label, response := range responses {
		observation := accountMutationResponseFixture{Status: response.Code, Headers: stableAccountBackupHeaders(response.Header())}
		if response.Body.Len() > 0 {
			if err := json.Unmarshal(response.Body.Bytes(), &observation.Body); err != nil {
				observation.Body = response.Body.String()
			}
		}
		fixtureScenario.Responses[label] = observation
		if response.Code == http.StatusOK {
			archive, err := readAccountBackupArchive(response.Body.Bytes())
			if err != nil {
				t.Fatalf("read %s ZIP archive: %v", label, err)
			}
			fixtureScenario.Archives[label] = archive
		}
	}
	fixtureScenario.FilesystemUnchanged = reflect.DeepEqual(beforeDefault, afterDefault) && reflect.DeepEqual(beforeGuest, afterGuest)
	for _, account := range accounts {
		current, err := os.ReadFile(filepath.Join(dataRoot, userStorageFolder, nodeStoreFilename(userStoragePrefix+account.handle)))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(current, accountRecordBytes[account.handle]) {
			fixtureScenario.AccountRecordsUnchanged = false
			break
		}
		fixtureScenario.AccountRecordsUnchanged = true
	}
	return fixtureScenario
}

func writeBackupFixtureFiles(t *testing.T, root string, admin bool) {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(root, "backups"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "empty-folder"), 0o777); err != nil {
		t.Fatal(err)
	}
	if admin {
		if err := os.MkdirAll(filepath.Join(root, "characters", "nested"), 0o777); err != nil {
			t.Fatal(err)
		}
	}
	files := map[string]string{
		"settings.json": `{"owner":"default-user"}`,
		"secrets.json":  `{"private":"never expose by default"}`,
		"ordinary.txt":  "visible root data",
		".hidden-root":  "hidden data",
		"backups/secrets_migration_20250101.json": `{"private":"migration secret"}`,
		"backups/secrets_migration_notes.txt":     "not a secret JSON backup",
		"backups/ordinary.json":                   `{"backup":true}`,
		"characters/nested/character.json":        `{"name":"nested"}`,
	}
	if !admin {
		files = map[string]string{
			"guest.txt":    "guest data",
			"secrets.json": `{"private":"guest secret"}`,
		}
	}
	for relative, body := range files {
		file := filepath.Join(root, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(file), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(body), 0o600); err != nil {
			t.Fatal(err)
		}
	}
}

func assertAccountBackupScenario(t *testing.T, name string, got, want accountBackupScenarioFixture) {
	t.Helper()
	if got.FilesystemUnchanged != want.FilesystemUnchanged || got.AccountRecordsUnchanged != want.AccountRecordsUnchanged {
		t.Fatalf("%s backup mutation state = filesystem %t / records %t; Node has %t / %t", name, got.FilesystemUnchanged, got.AccountRecordsUnchanged, want.FilesystemUnchanged, want.AccountRecordsUnchanged)
	}
	if !got.FilesystemUnchanged || !got.AccountRecordsUnchanged {
		t.Fatalf("%s backup changed user files or account records", name)
	}
	for label, gotArchive := range got.Archives {
		wantArchive, exists := want.Archives[label]
		if !exists || !reflect.DeepEqual(gotArchive, wantArchive) {
			t.Fatalf("%s %s archive entries differ from pinned Node: %v; got directories=%v, Node directories=%v", name, label, accountResetFilesystemDiff(gotArchive, wantArchive), gotArchive.Directories, wantArchive.Directories)
		}
	}
	if len(got.Archives) != len(want.Archives) {
		t.Fatalf("%s archive count %d; pinned Node has %d", name, len(got.Archives), len(want.Archives))
	}
	if len(got.Responses) != len(want.Responses) {
		t.Fatalf("%s response count %d; pinned Node has %d", name, len(got.Responses), len(want.Responses))
	}
	for label, gotResponse := range got.Responses {
		wantResponse, exists := want.Responses[label]
		if !exists {
			t.Fatalf("pinned %s backup fixture has no response %q", name, label)
		}
		assertAccountBackupResponse(t, name+" "+label, gotResponse, wantResponse)
	}
}

func assertAccountBackupResponse(t *testing.T, label string, got, want accountMutationResponseFixture) {
	t.Helper()
	if got.Status != want.Status {
		t.Fatalf("%s status = %d; pinned Node has %d", label, got.Status, want.Status)
	}
	gotHeaders := got.Headers
	wantHeaders := want.Headers
	if got.Status == http.StatusOK {
		gotHeaders = cloneStringMap(got.Headers)
		gotHeaders["content-disposition"] = normalizeBackupContentDisposition(gotHeaders["content-disposition"])
		wantHeaders = cloneStringMap(want.Headers)
	}
	if !reflect.DeepEqual(gotHeaders, wantHeaders) {
		t.Fatalf("%s headers = %#v; pinned Node has %#v", label, gotHeaders, wantHeaders)
	}
	if got.Status != http.StatusOK && !reflect.DeepEqual(got.Body, want.Body) {
		t.Fatalf("%s body = %#v; pinned Node has %#v", label, got.Body, want.Body)
	}
}

func stableAccountBackupHeaders(headers http.Header) map[string]string {
	copy := headers.Clone()
	copy.Del("Date")
	copy.Del("Set-Cookie")
	copy.Del("Transfer-Encoding")
	copy.Del("Connection")
	values := make(map[string]string, len(copy))
	for name, entries := range copy {
		values[strings.ToLower(name)] = strings.Join(entries, ", ")
	}
	return values
}

func normalizeBackupContentDisposition(header string) string {
	return backupTimestampPattern.ReplaceAllString(header, "<timestamp>")
}

var backupTimestampPattern = regexp.MustCompile(`\d{8}-\d{6}`)

func cloneStringMap(values map[string]string) map[string]string {
	copy := make(map[string]string, len(values))
	for key, value := range values {
		copy[key] = value
	}
	return copy
}

func readAccountBackupArchive(body []byte) (accountCreateFilesystem, error) {
	result := accountCreateFilesystem{Directories: []string{}, Files: []accountCreateFileDigest{}}
	reader, err := zip.NewReader(bytes.NewReader(body), int64(len(body)))
	if err != nil {
		return result, err
	}
	for _, entry := range reader.File {
		name := filepath.ToSlash(entry.Name)
		if strings.HasSuffix(name, "/") {
			result.Directories = append(result.Directories, strings.TrimSuffix(name, "/"))
			continue
		}
		stream, err := entry.Open()
		if err != nil {
			return result, err
		}
		body, copyErr := io.ReadAll(stream)
		closeErr := stream.Close()
		if copyErr != nil {
			return result, copyErr
		}
		if closeErr != nil {
			return result, closeErr
		}
		digest := sha256.Sum256(body)
		result.Files = append(result.Files, accountCreateFileDigest{Path: name, SHA256: hex.EncodeToString(digest[:]), Bytes: int64(len(body))})
	}
	sort.Strings(result.Directories)
	sort.Slice(result.Files, func(i, j int) bool { return result.Files[i].Path < result.Files[j].Path })
	return result, nil
}
