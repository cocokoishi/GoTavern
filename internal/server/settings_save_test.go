package server

import (
	"bytes"
	"encoding/json"
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

type settingsSaveFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret      string `json:"cookieSecret"`
		FirstRequestBody  string `json:"firstRequestBody"`
		SecondRequestBody string `json:"secondRequestBody"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		SettingsAfterFirst  string                   `json:"settingsAfterFirst"`
		BackupsAfterFirst   []settingsSaveBackupFile `json:"backupsAfterFirst"`
		SettingsAfterSecond string                   `json:"settingsAfterSecond"`
		BackupsAfterSecond  []settingsSaveBackupFile `json:"backupsAfterSecond"`
		AccountUnchanged    bool                     `json:"accountRecordUnchanged"`
		RoundTrip           struct {
			Verified bool   `json:"verified"`
			Settings string `json:"settings"`
		} `json:"roundTrip"`
	} `json:"state"`
}

type settingsSaveBackupFile struct {
	Name    string `json:"name"`
	Content string `json:"bytes"`
}

func TestPinnedNodeSettingsSave(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-settings-save.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture settingsSaveFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("settings-save oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || fixture.Inputs.FirstRequestBody == "" || fixture.Inputs.SecondRequestBody == "" {
		t.Fatal("settings-save oracle is missing required inputs")
	}
	if !fixture.State.RoundTrip.Verified {
		t.Fatal("settings-save oracle Node→Go→Node round trip did not verify")
	}

	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	accountJSON, err := marshalNodeJSON(struct {
		Handle   string         `json:"handle"`
		Name     string         `json:"name"`
		Created  int64          `json:"created"`
		Password string         `json:"password"`
		Admin    bool           `json:"admin"`
		Enabled  bool           `json:"enabled"`
		Salt     string         `json:"salt"`
		Unknown  map[string]any `json:"probeUnknownField"`
	}{"default-user", "Settings Writer", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
	if err != nil {
		t.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		t.Fatal(err)
	}
	accountRecordPath := filepath.Join(dataRoot, userStorageFolder, nodeStoreFilename(userStoragePrefix+"default-user"))
	accountRecordBefore, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	settingsPath := filepath.Join(directories["root"], "settings.json")
	if err := os.WriteFile(settingsPath, []byte(`{"seed":"before settings/save"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(directories["backups"]); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(directories["backups"], 0o755); err != nil {
		t.Fatal(err)
	}
	retention := float64(2)
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret,
		AccountsEnabled: true, SettingsBackupRetention: &retention,
	})
	serve := func(method, route, cookie, token string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
		request := httptest.NewRequest(method, route, bytes.NewReader(body))
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
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", nil)
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d, body %q", csrfResponse.Code, csrfResponse.Body.String())
	}
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrf); err != nil {
		t.Fatal(err)
	}
	cookieFrom := func(cookies []string) string {
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfCookie := cookieFrom(csrfResponse.Header().Values("Set-Cookie"))
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, []byte(`{"handle":"default-user","password":""}`))
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookieFrom(login.Header().Values("Set-Cookie"))
	post := func(body string, cookie string) *httptest.ResponseRecorder {
		return serve(http.MethodPost, "/api/settings/save", cookie, csrf.Token, []byte(body))
	}
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized": post(`{"denied":true}`, csrfCookie),
		"first":        post(fixture.Inputs.FirstRequestBody, sessionCookie),
	}
	settingsAfterFirstBytes, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	backupsAfterFirst := settingsSaveBackups(t, directories["backups"])
	responses["second"] = post(fixture.Inputs.SecondRequestBody, sessionCookie)
	settingsAfterSecondBytes, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	backupsAfterSecond := settingsSaveBackups(t, directories["backups"])
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountUnchanged {
		t.Fatal("settings/save changed the account storage record")
	}
	if got, want := string(settingsAfterFirstBytes), fixture.State.SettingsAfterFirst; got != want {
		t.Fatalf("settings after first save = %q; pinned Node has %q", got, want)
	}
	if !reflect.DeepEqual(backupsAfterFirst, fixture.State.BackupsAfterFirst) {
		t.Fatalf("snapshots after first save = %+v; pinned Node has %+v", backupsAfterFirst, fixture.State.BackupsAfterFirst)
	}
	if got, want := string(settingsAfterSecondBytes), fixture.State.SettingsAfterSecond; got != want {
		t.Fatalf("settings after second save = %q; pinned Node has %q", got, want)
	}
	if !reflect.DeepEqual(backupsAfterSecond, fixture.State.BackupsAfterSecond) {
		t.Fatalf("snapshots after second save = %+v; pinned Node has %+v", backupsAfterSecond, fixture.State.BackupsAfterSecond)
	}

	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("settings-save fixture has no response %q", label)
		}
		assertSettingsSaveResponse(t, label, got, want)
	}
}

func TestSettingsSaveTrailingSnapshotUsesLatestSettings(t *testing.T) {
	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	retention := float64(5)
	runtime := newAccountRuntime(HTTPHandlerOptions{DataRoot: dataRoot, SettingsBackupRetention: &retention})
	runtime.settingsSaveWait = time.Hour
	first := []byte("{\n    \"version\": 1\n}")
	second := []byte("{\n    \"version\": 2\n}")
	if err := runtime.saveSettings("default-user", first); err != nil {
		t.Fatal(err)
	}
	if err := runtime.saveSettings("default-user", second); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	backups := settingsSaveBackups(t, directories["backups"])
	if len(backups) != 1 || backups[0].Content != string(first) {
		t.Fatalf("throttled snapshot before trailing edge = %+v; want only first settings body", backups)
	}
	state := runtime.settingsSaves["default-user"]
	if state == nil || !state.pending {
		t.Fatalf("trailing snapshot was not queued: %+v", state)
	}
	state.timer.Stop()
	runtime.flushSettingsSave("default-user", state, retention)
	backups = settingsSaveBackups(t, directories["backups"])
	hasFirst, hasSecond := false, false
	for _, backup := range backups {
		hasFirst = hasFirst || backup.Content == string(first)
		hasSecond = hasSecond || backup.Content == string(second)
	}
	validSnapshotCount := len(backups) == 1 && hasSecond || len(backups) == 2 && hasFirst && hasSecond
	if !validSnapshotCount {
		t.Fatalf("trailing snapshot = %+v; want latest settings body", backups)
	}
}

func settingsSaveBackups(t *testing.T, directory string) []settingsSaveBackupFile {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	backups := make([]settingsSaveBackupFile, 0)
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "settings_default-user_") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		name := settingsSaveTimestampPattern.ReplaceAllString(entry.Name(), "<timestamp>")
		backups = append(backups, settingsSaveBackupFile{Name: name, Content: string(body)})
	}
	sort.Slice(backups, func(left, right int) bool { return backups[left].Name < backups[right].Name })
	return backups
}

func assertSettingsSaveResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
	t.Helper()
	gotBody := any(nil)
	if got.Body.Len() > 0 {
		if json.Unmarshal(got.Body.Bytes(), &gotBody) != nil {
			gotBody = got.Body.String()
		}
	}
	gotHeaders := stableAccountBackupHeaders(got.Header())
	wantHeaders := cloneStringMap(want.Headers)
	if got.Code != want.Status || !reflect.DeepEqual(gotHeaders, wantHeaders) || !reflect.DeepEqual(gotBody, want.Body) {
		t.Fatalf("settings/save response %s differs from pinned Node:\n status=%d want=%d\n headers=%#v want=%#v\n body=%#v want=%#v", label, got.Code, want.Status, gotHeaders, wantHeaders, gotBody, want.Body)
	}
}

var settingsSaveTimestampPattern = regexp.MustCompile(`\d{8}-\d{6}`)
