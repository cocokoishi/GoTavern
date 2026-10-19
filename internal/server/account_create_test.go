package server

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type accountCreateFilesystem struct {
	Directories []string                  `json:"directories"`
	Files       []accountCreateFileDigest `json:"files"`
}

type accountCreateFileDigest struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
}

type accountCreateFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string `json:"cookieSecret"`
		Password     string `json:"password"`
	} `json:"inputs"`
	Slugify   map[string]accountMutationResponseFixture `json:"slugify"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	Persisted struct {
		CreatedHandles []string `json:"createdHandles"`
		AllHandles     []string `json:"allHandles"`
		PasswordAdmin  struct {
			Name          string   `json:"name"`
			Admin         bool     `json:"admin"`
			Enabled       bool     `json:"enabled"`
			Password      bool     `json:"passwordPresent"`
			SaltBytes     int      `json:"saltBytes"`
			PasswordValid bool     `json:"passwordValid"`
			Keys          []string `json:"keys"`
		} `json:"passwordAdmin"`
		NoPassword struct {
			Name      string   `json:"name"`
			Admin     bool     `json:"admin"`
			Enabled   bool     `json:"enabled"`
			Password  string   `json:"password"`
			SaltBytes int      `json:"saltBytes"`
			Keys      []string `json:"keys"`
		} `json:"noPassword"`
		StorageRecords map[string]struct {
			Keys       []string `json:"keys"`
			Key        string   `json:"key"`
			TTLPresent bool     `json:"ttlPresent"`
		} `json:"storageRecords"`
		UserDirectories map[string]accountCreateFilesystem `json:"userDirectories"`
		GlobalContent   struct {
			ContentLog  *accountCreateFileDigest `json:"contentLog"`
			Errors      accountCreateFilesystem  `json:"errors"`
			Stylesheets accountCreateFilesystem  `json:"stylesheets"`
		} `json:"globalContent"`
	} `json:"persisted"`
}

func TestPinnedNodeAccountCreationAndSlugifyContract(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-account-create.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture accountCreateFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("account-create oracle baseline = %+v", fixture.Baseline)
	}
	if !reflect.DeepEqual(fixture.Persisted.AllHandles, []string{"creme-brulee", "default-user", "elodie-rowan", "guest-one"}) {
		t.Fatalf("pinned created account handles = %v", fixture.Persisted.AllHandles)
	}
	if !reflect.DeepEqual(fixture.Persisted.CreatedHandles, []string{"elodie-rowan", "guest-one"}) {
		t.Fatalf("pinned successful account handles = %v", fixture.Persisted.CreatedHandles)
	}

	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	for index, user := range []struct {
		handle string
		name   string
		admin  bool
	}{{"default-user", "Admin", true}, {"creme-brulee", "Existing", false}} {
		account := struct {
			Handle   string `json:"handle"`
			Name     string `json:"name"`
			Created  int64  `json:"created"`
			Password string `json:"password"`
			Admin    bool   `json:"admin"`
			Enabled  bool   `json:"enabled"`
			Salt     string `json:"salt"`
		}{user.handle, user.name, int64(1700000000000 + index), "", user.admin, true, ""}
		encoded, err := json.Marshal(account)
		if err != nil {
			t.Fatal(err)
		}
		if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+user.handle, encoded); err != nil {
			t.Fatal(err)
		}
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
	})
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
	post := func(route, cookie string, body any) *httptest.ResponseRecorder {
		t.Helper()
		encoded, err := json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
		return serve(http.MethodPost, "/api/users/"+route, cookie, csrfBody.Token, string(encoded))
	}
	adminLogin := post("login", csrfCookie, map[string]any{"handle": "default-user"})
	if adminLogin.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", adminLogin.Code, adminLogin.Body.String())
	}
	adminCookie := cookieFrom(adminLogin.Header().Values("Set-Cookie"))
	assertResponse := func(label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
		t.Helper()
		assertAccountMutationResponse(t, label, got, want)
	}
	for name, value := range map[string]any{
		"latin":            "  Crème brûlée / São Paulo  ",
		"ligatures":        "Æther & Œuvre — Straße",
		"latinExtended":    "Łódź Ĳsselmeer ſoft",
		"combining":        "Cafe\u0301 & I\u0307stanbul",
		"nonLatin":         "東京",
		"number":           42,
		"numberScientific": 1e21,
		"numberSmall":      1e-7,
		"numberBoundary":   1e-6,
		"array":            []any{"Foo", "Bar"},
		"nestedArray":      []any{1, nil, []any{}, map[string]any{}},
		"object":           map[string]any{},
		"missing":          nil,
		"latinSweep":       accountCreateLatinSweepInput(),
		"combiningSweep":   accountCreateCombiningSweepInput(),
	} {
		assertResponse("POST /api/users/slugify "+name, post("slugify", adminCookie, map[string]any{"text": value}), fixture.Slugify[name])
	}

	gotResponses := map[string]*httptest.ResponseRecorder{
		"nonAdminSlugify":           post("slugify", csrfCookie, map[string]any{"text": "hello"}),
		"missingCreate":             post("create", adminCookie, map[string]any{}),
		"missingName":               post("create", adminCookie, map[string]any{"handle": "new-user"}),
		"missingHandle":             post("create", adminCookie, map[string]any{"name": "New User"}),
		"invalidHandle":             post("create", adminCookie, map[string]any{"handle": "東京", "name": "Tokyo"}),
		"duplicateNormalizedHandle": post("create", adminCookie, map[string]any{"handle": "  Crème brûlée  ", "name": "Duplicate"}),
		"createPasswordAdmin": post("create", adminCookie, map[string]any{
			"handle": "  Élodie / Rowan ", "name": "Élodie & Rowan", "password": fixture.Inputs.Password, "admin": "yes",
		}),
		"createNoPassword": post("create", adminCookie, map[string]any{"handle": []string{"Guest", "One"}, "name": "Guest One"}),
	}
	for label, got := range gotResponses {
		assertResponse("POST /api/users/"+label, got, fixture.Responses[label])
	}

	admin, found, err := loadStoredAccount(dataRoot, "elodie-rowan")
	if err != nil || !found {
		t.Fatalf("load created password account: found=%v error=%v", found, err)
	}
	guest, found, err := loadStoredAccount(dataRoot, "guest-one")
	if err != nil || !found {
		t.Fatalf("load created passwordless account: found=%v error=%v", found, err)
	}
	var adminName string
	_ = json.Unmarshal(admin.raw("name"), &adminName)
	var guestName string
	_ = json.Unmarshal(guest.raw("name"), &guestName)
	adminSalt := admin.string("salt")
	adminSaltBytes, err := base64.StdEncoding.DecodeString(adminSalt)
	if err != nil {
		t.Fatal(err)
	}
	guestSaltBytes, err := base64.StdEncoding.DecodeString(guest.string("salt"))
	if err != nil {
		t.Fatal(err)
	}
	passwordHash, err := upstreamPasswordHash(fixture.Inputs.Password, adminSalt)
	if err != nil {
		t.Fatal(err)
	}
	if adminName != fixture.Persisted.PasswordAdmin.Name || nodeTruthyJSON(admin.raw("admin")) != fixture.Persisted.PasswordAdmin.Admin ||
		nodeTruthyJSON(admin.raw("enabled")) != fixture.Persisted.PasswordAdmin.Enabled ||
		nodeTruthyJSON(admin.raw("password")) != fixture.Persisted.PasswordAdmin.Password || len(adminSaltBytes) != fixture.Persisted.PasswordAdmin.SaltBytes ||
		passwordHash != admin.string("password") || !fixture.Persisted.PasswordAdmin.PasswordValid {
		t.Fatalf("created password account differs from pinned Node: %+v", admin.fields)
	}
	if guestName != fixture.Persisted.NoPassword.Name || nodeTruthyJSON(guest.raw("admin")) != fixture.Persisted.NoPassword.Admin ||
		nodeTruthyJSON(guest.raw("enabled")) != fixture.Persisted.NoPassword.Enabled || guest.string("password") != fixture.Persisted.NoPassword.Password ||
		len(guestSaltBytes) != fixture.Persisted.NoPassword.SaltBytes {
		t.Fatalf("created passwordless account differs from pinned Node: %+v", guest.fields)
	}
	createdTimestamp, err := strconv.ParseInt(string(admin.raw("created")), 10, 64)
	if err != nil || createdTimestamp <= 0 {
		t.Fatalf("created timestamp = %s, error %v", admin.raw("created"), err)
	}
	accounts, err := loadStoredAccounts(dataRoot)
	if err != nil {
		t.Fatal(err)
	}
	actualHandles := make([]string, 0, len(accounts))
	for handle := range accounts {
		actualHandles = append(actualHandles, handle)
	}
	sort.Strings(actualHandles)
	if !reflect.DeepEqual(actualHandles, fixture.Persisted.AllHandles) {
		t.Fatalf("Go-created account handles = %v; pinned Node has %v", actualHandles, fixture.Persisted.AllHandles)
	}
	existing, found, err := loadStoredAccount(dataRoot, "creme-brulee")
	if err != nil || !found || existing.string("name") != "Existing" {
		t.Fatalf("normalized duplicate changed existing account: found=%v name=%q error=%v", found, existing.string("name"), err)
	}
	if _, err := os.Stat(filepath.Join(dataRoot, "tokyo")); !os.IsNotExist(err) {
		t.Fatalf("invalid slug unexpectedly created a user directory: %v", err)
	}
	for handle, account := range map[string]storedAccount{"elodie-rowan": admin, "guest-one": guest} {
		file := filepath.Join(dataRoot, userStorageFolder, nodeStoreFilename(userStoragePrefix+handle))
		body, err := os.ReadFile(file)
		if err != nil {
			t.Fatal(err)
		}
		var record map[string]json.RawMessage
		if err := json.Unmarshal(body, &record); err != nil {
			t.Fatal(err)
		}
		var key string
		_ = json.Unmarshal(record["key"], &key)
		var value map[string]json.RawMessage
		_ = json.Unmarshal(record["value"], &value)
		wantRecord := fixture.Persisted.StorageRecords[handle]
		if key != wantRecord.Key || !reflect.DeepEqual(orderedJSONObjectKeys(body), wantRecord.Keys) ||
			!reflect.DeepEqual(orderedJSONObjectKeys(record["value"]), accountCreateAccountKeys(fixture.Persisted.PasswordAdmin.Keys, fixture.Persisted.NoPassword.Keys, handle)) ||
			!reflect.DeepEqual(value, account.fields) || (record["ttl"] != nil) != wantRecord.TTLPresent {
			t.Fatalf("node-persist account record for %q differs from pinned Node: %s", handle, body)
		}
	}
	for handle, want := range fixture.Persisted.UserDirectories {
		got := accountCreateSnapshot(t, filepath.Join(dataRoot, handle))
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("created user directory state for %q differs from pinned Node (directories %d/%d, files %d/%d)", handle, len(got.Directories), len(want.Directories), len(got.Files), len(want.Files))
		}
	}
	if got := accountCreateFileSummary(t, filepath.Join(dataRoot, "content.log")); !reflect.DeepEqual(got, fixture.Persisted.GlobalContent.ContentLog) {
		t.Fatalf("global content log = %+v; pinned Node has %+v", got, fixture.Persisted.GlobalContent.ContentLog)
	}
	for _, item := range []struct {
		name string
		path string
		want accountCreateFilesystem
	}{{"global error pages", "_errors", fixture.Persisted.GlobalContent.Errors}, {"global stylesheets", "_css", fixture.Persisted.GlobalContent.Stylesheets}} {
		if got := accountCreateSnapshot(t, filepath.Join(dataRoot, item.path)); !reflect.DeepEqual(got, item.want) {
			t.Fatalf("%s filesystem state = %+v; pinned Node has %+v", item.name, got, item.want)
		}
	}
}

func accountCreateLatinSweepInput() string {
	var result strings.Builder
	first := true
	for codePoint := rune(0x00c0); codePoint <= 0x017f; codePoint++ {
		if !(codePoint >= 0x00c0 && codePoint <= 0x00d6 || codePoint >= 0x00d8 && codePoint <= 0x00f6 ||
			codePoint >= 0x00f8 && codePoint <= 0x00ff || codePoint >= 0x0100 && codePoint <= 0x017f) {
			continue
		}
		if !first {
			result.WriteString(" | ")
		}
		first = false
		result.WriteRune('A')
		result.WriteRune(codePoint)
		result.WriteRune('B')
	}
	return result.String()
}

func accountCreateCombiningSweepInput() string {
	var result strings.Builder
	first := true
	appendSweep := func(start, end rune) {
		for codePoint := start; codePoint <= end; codePoint++ {
			if !first {
				result.WriteString(" | ")
			}
			first = false
			result.WriteRune('A')
			result.WriteRune(codePoint)
			result.WriteRune('B')
		}
	}
	appendSweep(0x0300, 0x036f)
	appendSweep(0xfe20, 0xfe2f)
	appendSweep(0x20d0, 0x20ff)
	return result.String()
}

func accountCreateAccountKeys(passwordAdmin, passwordless []string, handle string) []string {
	if handle == "elodie-rowan" {
		return passwordAdmin
	}
	return passwordless
}

func accountCreateSnapshot(t *testing.T, root string) accountCreateFilesystem {
	t.Helper()
	result := accountCreateFilesystem{Directories: []string{}, Files: []accountCreateFileDigest{}}
	err := filepath.WalkDir(root, func(current string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if current == root {
			return nil
		}
		relative, err := filepath.Rel(root, current)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if entry.IsDir() {
			result.Directories = append(result.Directories, relative)
			return nil
		}
		if !entry.Type().IsRegular() {
			return nil
		}
		body, err := os.ReadFile(current)
		if err != nil {
			return err
		}
		digest := sha256.Sum256(body)
		result.Files = append(result.Files, accountCreateFileDigest{Path: relative, SHA256: hex.EncodeToString(digest[:]), Bytes: int64(len(body))})
		return nil
	})
	if err != nil {
		t.Fatalf("snapshot account content under %s: %v", root, err)
	}
	sort.Strings(result.Directories)
	sort.Slice(result.Files, func(i, j int) bool { return result.Files[i].Path < result.Files[j].Path })
	return result
}

func accountCreateFileSummary(t *testing.T, file string) *accountCreateFileDigest {
	t.Helper()
	body, err := os.ReadFile(file)
	if err != nil {
		t.Fatalf("read account create content file %s: %v", file, err)
	}
	digest := sha256.Sum256(body)
	return &accountCreateFileDigest{SHA256: hex.EncodeToString(digest[:]), Bytes: int64(len(body))}
}
