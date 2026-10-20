package server

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
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

type settingsSnapshotsFixture struct {
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
		InitialSettings struct {
			SHA256 string `json:"sha256"`
			Bytes  int64  `json:"bytes"`
		} `json:"initialSettings"`
		SeededBackups                 []settingsSnapshotDigest  `json:"seededBackups"`
		AfterRestoreOlder             settingsSnapshotFileState `json:"afterRestoreOlder"`
		BackupsAfterRestore           []settingsSnapshotDigest  `json:"backupsAfterRestore"`
		BackupsAfterMake              []settingsSnapshotDigest  `json:"backupsAfterMake"`
		AfterRestoreNew               settingsSnapshotFileState `json:"afterRestoreNew"`
		BackupsAfterMissingSourceMake struct {
			Before []settingsSnapshotDigest `json:"before"`
			After  []settingsSnapshotDigest `json:"after"`
		} `json:"backupsAfterMissingSourceMake"`
		AccountRecordUnchanged bool `json:"accountRecordUnchanged"`
	} `json:"filesystem"`
}

type settingsSnapshotFileState struct {
	SHA256  string `json:"sha256"`
	Bytes   int64  `json:"bytes"`
	Content string `json:"content"`
}

type settingsSnapshotDigest struct {
	Name   string `json:"name"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type settingsSnapshotResponse struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    any               `json:"body"`
}

func TestPinnedNodeSettingsSnapshotRoutes(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-settings-snapshots.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture settingsSnapshotsFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("settings-snapshot oracle baseline = %+v", fixture.Baseline)
	}

	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	passwordHash, err := upstreamPasswordHash(fixture.Inputs.Password, fixture.Inputs.Salt)
	if err != nil {
		t.Fatal(err)
	}
	accountJSON, err := marshalNodeJSON(struct {
		Handle            string `json:"handle"`
		Name              string `json:"name"`
		Created           int64  `json:"created"`
		Password          string `json:"password"`
		Admin             bool   `json:"admin"`
		Enabled           bool   `json:"enabled"`
		Salt              string `json:"salt"`
		ProbeUnknownField struct {
			Preserve bool `json:"preserve"`
		} `json:"probeUnknownField"`
	}{"default-user", "Protected User", 1700000000000, passwordHash, true, true, fixture.Inputs.Salt, struct {
		Preserve bool `json:"preserve"`
	}{true}})
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
	userRoot := filepath.Join(dataRoot, "default-user")
	backupsRoot := filepath.Join(userRoot, "backups")
	settingsPath := filepath.Join(userRoot, "settings.json")
	seeds := []struct {
		name     string
		contents string
		mtime    int64
	}{
		{"settings_default-user_older.json", `{"snapshot":"older"}`, 1704067200000},
		{"settings_default-user_newer.json", `{"snapshot":"newer"}`, 1704153600000},
		{"settings_another-user_private.json", `{"snapshot":"other user"}`, 1704240000000},
	}
	for _, seed := range seeds {
		file := filepath.Join(backupsRoot, seed.name)
		if err := os.WriteFile(file, []byte(seed.contents), 0o644); err != nil {
			t.Fatal(err)
		}
		when := time.UnixMilli(seed.mtime)
		if err := os.Chtimes(file, when, when); err != nil {
			t.Fatal(err)
		}
	}
	initialSettings := []byte(`{"settings":"before snapshots"}`)
	if err := os.WriteFile(settingsPath, initialSettings, 0o644); err != nil {
		t.Fatal(err)
	}
	if got := summarizeSettingsSnapshotFile(t, initialSettings); got.SHA256 != fixture.Filesystem.InitialSettings.SHA256 || got.Bytes != fixture.Filesystem.InitialSettings.Bytes {
		t.Fatalf("initial settings bytes differ from pinned Node: %+v", got)
	}
	if got := snapshotSettingsBackups(t, backupsRoot); !reflect.DeepEqual(got, fixture.Filesystem.SeededBackups) {
		t.Fatalf("seeded snapshots differ from pinned Node: got=%+v want=%+v", got, fixture.Filesystem.SeededBackups)
	}

	retention := float64(2)
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret,
		AccountsEnabled: true, SettingsBackupRetention: &retention,
	})
	serve := func(route, cookie, token string, body any) *httptest.ResponseRecorder {
		t.Helper()
		var requestBody bytes.Buffer
		if body != nil {
			if err := json.NewEncoder(&requestBody).Encode(body); err != nil {
				t.Fatal(err)
			}
		}
		request := httptest.NewRequest(http.MethodPost, route, &requestBody)
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
	cookieFrom := func(cookies []string) string {
		t.Helper()
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfCookie := cookieFrom(csrfResponse.Header().Values("Set-Cookie"))
	login := serve("/api/users/login", csrfCookie, csrfBody.Token, map[string]string{"handle": "default-user", "password": fixture.Inputs.Password})
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	adminCookie := cookieFrom(login.Header().Values("Set-Cookie"))
	post := func(route, cookie string, body any) *httptest.ResponseRecorder {
		return serve("/api/settings/"+route, cookie, csrfBody.Token, body)
	}

	responses := make(map[string]settingsSnapshotResponse)
	responses["unauthorizedList"] = captureSettingsSnapshotResponse(post("get-snapshots", csrfCookie, map[string]any{}), false)
	responses["listInitial"] = captureSettingsSnapshotResponse(post("get-snapshots", adminCookie, map[string]any{}), true)
	responses["loadOlder"] = captureSettingsSnapshotResponse(post("load-snapshot", adminCookie, map[string]string{"name": seeds[0].name}), false)
	responses["loadForeign"] = captureSettingsSnapshotResponse(post("load-snapshot", adminCookie, map[string]string{"name": seeds[2].name}), false)
	responses["loadMissing"] = captureSettingsSnapshotResponse(post("load-snapshot", adminCookie, map[string]string{"name": "settings_default-user_missing.json"}), false)
	responses["loadSlash"] = captureSettingsSnapshotResponse(post("load-snapshot", adminCookie, map[string]string{"name": "settings_default-user/older.json"}), false)
	responses["loadNoName"] = captureSettingsSnapshotResponse(post("load-snapshot", adminCookie, map[string]any{}), false)
	responses["restoreOlder"] = captureSettingsSnapshotResponse(post("restore-snapshot", adminCookie, map[string]string{"name": seeds[0].name}), false)
	if got := summarizeSettingsSnapshotFile(t, mustReadSettingsSnapshot(t, settingsPath)); got != fixture.Filesystem.AfterRestoreOlder {
		t.Fatalf("restore older settings snapshot = %+v; pinned Node has %+v", got, fixture.Filesystem.AfterRestoreOlder)
	}
	if got := snapshotSettingsBackups(t, backupsRoot); !reflect.DeepEqual(got, fixture.Filesystem.BackupsAfterRestore) {
		t.Fatalf("restore changed snapshots: got=%+v want=%+v", got, fixture.Filesystem.BackupsAfterRestore)
	}

	if err := os.WriteFile(settingsPath, []byte(`{"settings":"saved after restore"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	responses["makeSnapshot"] = captureSettingsSnapshotResponse(post("make-snapshot", adminCookie, nil), false)
	if got := snapshotSettingsBackups(t, backupsRoot); !reflect.DeepEqual(got, fixture.Filesystem.BackupsAfterMake) {
		t.Fatalf("make settings snapshot tree differs from pinned Node: got=%+v want=%+v", got, fixture.Filesystem.BackupsAfterMake)
	}
	listAfterMake := post("get-snapshots", adminCookie, map[string]any{})
	responses["listAfterMake"] = captureSettingsSnapshotResponse(listAfterMake, true)
	var listed []startup.SettingsSnapshot
	if err := json.Unmarshal(listAfterMake.Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	newSnapshotName := ""
	for _, snapshot := range listed {
		if snapshot.Name != seeds[0].name && snapshot.Name != seeds[1].name {
			newSnapshotName = snapshot.Name
			break
		}
	}
	if newSnapshotName == "" {
		t.Fatalf("new snapshot not listed: %+v", listed)
	}
	responses["loadNew"] = captureSettingsSnapshotResponse(post("load-snapshot", adminCookie, map[string]string{"name": newSnapshotName}), false)
	responses["restoreNew"] = captureSettingsSnapshotResponse(post("restore-snapshot", adminCookie, map[string]string{"name": newSnapshotName}), false)
	if got := summarizeSettingsSnapshotFile(t, mustReadSettingsSnapshot(t, settingsPath)); got != fixture.Filesystem.AfterRestoreNew {
		t.Fatalf("restore new settings snapshot = %+v; pinned Node has %+v", got, fixture.Filesystem.AfterRestoreNew)
	}
	responses["restoreMissing"] = captureSettingsSnapshotResponse(post("restore-snapshot", adminCookie, map[string]string{"name": "settings_default-user_missing.json"}), false)
	responses["restoreSlash"] = captureSettingsSnapshotResponse(post("restore-snapshot", adminCookie, map[string]string{"name": "settings_default-user/older.json"}), false)
	responses["restoreNoName"] = captureSettingsSnapshotResponse(post("restore-snapshot", adminCookie, map[string]any{}), false)

	if err := os.Remove(settingsPath); err != nil {
		t.Fatal(err)
	}
	beforeMissingSource := snapshotSettingsBackups(t, backupsRoot)
	responses["makeSnapshotMissingSettings"] = captureSettingsSnapshotResponse(post("make-snapshot", adminCookie, nil), false)
	afterMissingSource := snapshotSettingsBackups(t, backupsRoot)
	if !reflect.DeepEqual(beforeMissingSource, afterMissingSource) || !reflect.DeepEqual(afterMissingSource, fixture.Filesystem.BackupsAfterMissingSourceMake.After) || !reflect.DeepEqual(beforeMissingSource, fixture.Filesystem.BackupsAfterMissingSourceMake.Before) {
		t.Fatalf("missing-settings manual backup changed snapshots: before=%+v after=%+v pinned=%+v", beforeMissingSource, afterMissingSource, fixture.Filesystem.BackupsAfterMissingSourceMake)
	}
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.Filesystem.AccountRecordUnchanged {
		t.Fatal("settings snapshot routes changed the account storage record")
	}

	if len(responses) != len(fixture.Responses) {
		t.Fatalf("settings snapshot response count = %d; pinned Node has %d", len(responses), len(fixture.Responses))
	}
	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("settings-snapshot fixture has no response %q", label)
		}
		assertSettingsSnapshotResponse(t, label, got, want)
	}
}

func captureSettingsSnapshotResponse(response *httptest.ResponseRecorder, normalizeList bool) settingsSnapshotResponse {
	body := any(nil)
	if response.Body.Len() > 0 {
		encoded := response.Body.Bytes()
		if json.Unmarshal(encoded, &body) != nil {
			body = response.Body.String()
		}
	}
	headers := stableAccountBackupHeaders(response.Header())
	if normalizeList {
		if entries, ok := body.([]any); ok {
			// Pinned src/endpoints/settings.js:300 lists snapshots with
			// fs.readdirSync() and no sort, so the array order is the host
			// filesystem's directory order (NTFS returns name-sorted entries,
			// ext4/overlayfs do not). The Go handler reproduces that unsorted
			// readdir order, so both sides are canonicalised by sorting on the
			// raw snapshot name (UTF-8 byte order) and the response is compared
			// as an unordered multiset; names, dates and sizes are still
			// compared exactly.
			sort.SliceStable(entries, func(left, right int) bool {
				return settingsSnapshotEntryName(entries[left]) < settingsSnapshotEntryName(entries[right])
			})
			for _, entry := range entries {
				item, ok := entry.(map[string]any)
				if !ok {
					continue
				}
				item["date"] = "<ctime>"
				if name, ok := item["name"].(string); ok {
					item["name"] = settingsSnapshotTimestampPattern.ReplaceAllString(name, "<timestamp>")
				}
			}
		}
		headers["content-length"] = "<dynamic>"
		headers["etag"] = "<dynamic>"
	}
	return settingsSnapshotResponse{Status: response.Code, Headers: headers, Body: body}
}

func settingsSnapshotEntryName(entry any) string {
	item, ok := entry.(map[string]any)
	if !ok {
		return ""
	}
	value, _ := item["name"].(string)
	return value
}

func assertSettingsSnapshotResponse(t *testing.T, label string, got settingsSnapshotResponse, want accountMutationResponseFixture) {
	t.Helper()
	if got.Status != want.Status || !reflect.DeepEqual(got.Headers, want.Headers) || !reflect.DeepEqual(got.Body, want.Body) {
		t.Fatalf("settings snapshot response %s differs from pinned Node:\n got: %+v\nwant: %+v", label, got, want)
	}
}

func snapshotSettingsBackups(t *testing.T, directory string) []settingsSnapshotDigest {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	files := make([]settingsSnapshotDigest, 0, len(entries))
	for _, entry := range entries {
		if !entry.Type().IsRegular() {
			continue
		}
		body, err := os.ReadFile(filepath.Join(directory, entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, settingsSnapshotDigest{
			Name:   settingsSnapshotTimestampPattern.ReplaceAllString(entry.Name(), "<timestamp>"),
			SHA256: hex.EncodeToString(sha256Bytes(body)),
			Bytes:  int64(len(body)),
		})
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name < files[j].Name })
	return files
}

func summarizeSettingsSnapshotFile(t *testing.T, body []byte) settingsSnapshotFileState {
	t.Helper()
	digest := sha256.Sum256(body)
	return settingsSnapshotFileState{SHA256: hex.EncodeToString(digest[:]), Bytes: int64(len(body)), Content: string(body)}
}

func mustReadSettingsSnapshot(t *testing.T, path string) []byte {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return body
}

var settingsSnapshotTimestampPattern = regexp.MustCompile(`\d{8}-\d{6}`)
