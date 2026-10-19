package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"
	"unicode/utf16"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type avatarsGetFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string            `json:"cookieSecret"`
		Files        []avatarFileState `json:"files"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		FileState              []avatarFileState `json:"fileState"`
		AccountRecordUnchanged bool              `json:"accountRecordUnchanged"`
	} `json:"state"`
}

type avatarFileState struct {
	Name string `json:"name"`
	Kind string `json:"kind"`
}

func TestPinnedNodeUserAvatarListing(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-avatars-get.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture avatarsGetFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("user-avatar oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Files) == 0 {
		t.Fatal("user-avatar oracle is missing required inputs")
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
	}{"default-user", "Avatar Reader", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	for _, file := range fixture.Inputs.Files {
		target := filepath.Join(directories["avatars"], file.Name)
		switch file.Kind {
		case "file":
			if err := os.WriteFile(target, []byte("fixture"), 0o600); err != nil {
				t.Fatal(err)
			}
		case "directory":
			if err := os.Mkdir(target, 0o755); err != nil {
				t.Fatal(err)
			}
		default:
			t.Fatalf("unexpected fixture avatar entry kind %q", file.Kind)
		}
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret,
		AccountsEnabled: true,
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
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorizedGet": serve(http.MethodPost, "/api/avatars/get", csrfCookie, csrf.Token, nil),
		"legacyRedirect":  serve(http.MethodPost, "/getuseravatars", sessionCookie, csrf.Token, nil),
		"get":             serve(http.MethodPost, "/api/avatars/get", sessionCookie, csrf.Token, nil),
	}
	fileState := snapshotAvatarFiles(t, directories["avatars"])
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("avatar listing changed the account storage record")
	}
	if !reflect.DeepEqual(fileState, fixture.State.FileState) {
		t.Fatalf("avatar directory state = %+v; pinned Node has %+v", fileState, fixture.State.FileState)
	}
	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("avatar fixture has no response %q", label)
		}
		assertAvatarResponse(t, label, got, want)
	}
}

func snapshotAvatarFiles(t *testing.T, directory string) []avatarFileState {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	files := make([]avatarFileState, 0, len(entries))
	for _, entry := range entries {
		kind := "other"
		switch {
		case entry.Type().IsRegular():
			kind = "file"
		case entry.IsDir():
			kind = "directory"
		}
		files = append(files, avatarFileState{Name: entry.Name(), Kind: kind})
	}
	sort.Slice(files, func(i, j int) bool { return lessJavaScriptUTF16(files[i].Name, files[j].Name) })
	return files
}

func lessJavaScriptUTF16(left, right string) bool {
	leftUnits := utf16.Encode([]rune(left))
	rightUnits := utf16.Encode([]rune(right))
	for index := 0; index < len(leftUnits) && index < len(rightUnits); index++ {
		if leftUnits[index] != rightUnits[index] {
			return leftUnits[index] < rightUnits[index]
		}
	}
	return len(leftUnits) < len(rightUnits)
}

func assertAvatarResponse(t *testing.T, label string, got *httptest.ResponseRecorder, want accountMutationResponseFixture) {
	t.Helper()
	gotBody := any(nil)
	if got.Body.Len() > 0 {
		if json.Unmarshal(got.Body.Bytes(), &gotBody) != nil {
			gotBody = got.Body.String()
		}
	}
	gotHeaders := stableAccountBackupHeaders(got.Header())
	if got.Code != want.Status || !reflect.DeepEqual(gotHeaders, want.Headers) || !reflect.DeepEqual(gotBody, want.Body) {
		t.Fatalf("avatar response %s differs from pinned Node:\n status=%d want=%d\n headers=%#v want=%#v\n body=%#v want=%#v", label, got.Code, want.Status, gotHeaders, want.Headers, gotBody, want.Body)
	}
}
