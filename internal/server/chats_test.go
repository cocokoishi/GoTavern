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
	"sort"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type chatsTreeEntry struct {
	Path   string `json:"path"`
	Kind   string `json:"kind"`
	SHA256 string `json:"sha256"`
	Bytes  int    `json:"bytes"`
}

// snapshotChatsTree mirrors the probe's directory walk: names sorted, files
// recorded by content hash and size.
func snapshotChatsTree(t *testing.T, root string) []chatsTreeEntry {
	t.Helper()
	entries := make([]chatsTreeEntry, 0, 8)
	var walk func(current, prefix string)
	walk = func(current, prefix string) {
		names, err := os.ReadDir(current)
		if err != nil {
			t.Fatal(err)
		}
		sort.Slice(names, func(left, right int) bool { return names[left].Name() < names[right].Name() })
		for _, name := range names {
			target := filepath.Join(current, name.Name())
			relative := name.Name()
			if prefix != "" {
				relative = prefix + "/" + name.Name()
			}
			info, err := os.Stat(target)
			if err != nil {
				t.Fatal(err)
			}
			if info.IsDir() {
				entries = append(entries, chatsTreeEntry{Path: relative, Kind: "directory"})
				walk(target, relative)
				continue
			}
			body, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			digest := sha256.Sum256(body)
			entries = append(entries, chatsTreeEntry{
				Path: relative, Kind: "file", SHA256: hex.EncodeToString(digest[:]), Bytes: len(body),
			})
		}
	}
	if _, err := os.Stat(root); err == nil {
		walk(root, "")
	}
	return entries
}

func TestPinnedNodeChatsSaveGet(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-chats-save-get.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Baseline struct {
			Version string `json:"version"`
			Commit  string `json:"commit"`
		} `json:"baseline"`
		Inputs struct {
			CookieSecret string `json:"cookieSecret"`
			// RawMessage preserves the recorded member order. JSON.stringify keeps
			// insertion order, so rebuilding this from a Go map would reorder the
			// keys and silently change the request under test.
			NormalChat       json.RawMessage `json:"normalChat"`
			ExistingChatFile string          `json:"existingChatFile"`
		} `json:"inputs"`
		Responses map[string]accountMutationResponseFixture `json:"responses"`
		State     struct {
			SavedNormalJsonl             *string          `json:"savedNormalJsonl"`
			SavedEmptyArrayJsonl         *string          `json:"savedEmptyArrayJsonl"`
			EscapedSave                  bool             `json:"escapedSave"`
			NewCharacterDirectoryCreated bool             `json:"newCharacterDirectoryCreated"`
			ChatsTree                    []chatsTreeEntry `json:"chatsTree"`
			AccountRecordUnchanged       bool             `json:"accountRecordUnchanged"`
		} `json:"state"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("chats save/get oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.NormalChat) == 0 {
		t.Fatal("chats save/get oracle is missing inputs")
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
	}{"default-user", "Chats Save Get Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	chatsRoot := directories["chats"]
	aliceDirectory := filepath.Join(chatsRoot, "Alice")
	if err := os.MkdirAll(aliceDirectory, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(aliceDirectory, "existing.jsonl"), []byte(fixture.Inputs.ExistingChatFile), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(aliceDirectory, "empty.jsonl"), nil, 0o600); err != nil {
		t.Fatal(err)
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
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", "")
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
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, `{"handle":"default-user","password":""}`)
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookieFrom(login.Header().Values("Set-Cookie"))

	jsonBody := func(value any) string {
		t.Helper()
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	saveRoute := "/api/chats/save"
	getRoute := "/api/chats/get"
	unauthorized := httptest.NewRequest(http.MethodPost, saveRoute,
		strings.NewReader(jsonBody(map[string]any{"avatar_url": "Alice.png", "file_name": "auth", "chat": []any{}})))
	unauthorized.Header.Set("Cookie", csrfCookie)
	unauthorized.Header.Set("X-CSRF-Token", csrf.Token)
	unauthorized.Header.Set("Content-Type", "application/json")
	unauthorizedResponse := httptest.NewRecorder()
	handler.ServeHTTP(unauthorizedResponse, unauthorized)

	responses := map[string]*httptest.ResponseRecorder{
		"saveUnauthorized": unauthorizedResponse,
		"saveInvalidCSRF": serve(http.MethodPost, saveRoute, sessionCookie, "",
			jsonBody(map[string]any{"avatar_url": "Alice.png", "file_name": "auth", "chat": []any{}})),
		"saveWrongMethod":        serve(http.MethodGet, saveRoute, sessionCookie, "", ""),
		"saveWrongMethodHead":    serve(http.MethodHead, saveRoute, sessionCookie, "", ""),
		"saveWrongMethodOptions": serve(http.MethodOptions, saveRoute, sessionCookie, "", ""),
		"saveMissingChat": serve(http.MethodPost, saveRoute, sessionCookie, csrf.Token,
			jsonBody(map[string]any{"avatar_url": "Alice.png", "file_name": "nochat"})),
		"saveNonArrayChat": serve(http.MethodPost, saveRoute, sessionCookie, csrf.Token,
			jsonBody(map[string]any{"avatar_url": "Alice.png", "file_name": "nochat", "chat": map[string]any{"a": 1}})),
		"saveEmptyArrayChat": serve(http.MethodPost, saveRoute, sessionCookie, csrf.Token,
			jsonBody(map[string]any{"avatar_url": "Alice.png", "file_name": "empty-array", "chat": []any{}})),
		"saveNormalChat": serve(http.MethodPost, saveRoute, sessionCookie, csrf.Token,
			`{"avatar_url":"Alice.png","file_name":"normal","chat":`+string(fixture.Inputs.NormalChat)+`}`),
		"saveAvatarUrlWithSlash": serve(http.MethodPost, saveRoute, sessionCookie, csrf.Token,
			jsonBody(map[string]any{"avatar_url": "../evil.png", "file_name": "evil", "chat": []any{}})),
		"saveAvatarUrlSubdirectory": serve(http.MethodPost, saveRoute, sessionCookie, csrf.Token,
			jsonBody(map[string]any{"avatar_url": "sub/Alice.png", "file_name": "subdir", "chat": []any{}})),
		"saveSanitizedFileName": serve(http.MethodPost, saveRoute, sessionCookie, csrf.Token,
			jsonBody(map[string]any{"avatar_url": "Alice.png", "file_name": "a/b", "chat": []any{map[string]any{"mes": "sanitized"}}})),
		"getUnauthorized": serve(http.MethodPost, getRoute, csrfCookie, csrf.Token,
			jsonBody(map[string]any{"avatar_url": "Alice.png", "file_name": "existing"})),
		"getWrongMethod":     serve(http.MethodGet, getRoute, sessionCookie, "", ""),
		"getWrongMethodHead": serve(http.MethodHead, getRoute, sessionCookie, "", ""),
		"getExistingChat": serve(http.MethodPost, getRoute, sessionCookie, csrf.Token,
			jsonBody(map[string]any{"avatar_url": "Alice.png", "file_name": "existing"})),
		"getEmptyChat": serve(http.MethodPost, getRoute, sessionCookie, csrf.Token,
			jsonBody(map[string]any{"avatar_url": "Alice.png", "file_name": "empty"})),
		"getMissingFile": serve(http.MethodPost, getRoute, sessionCookie, csrf.Token,
			jsonBody(map[string]any{"avatar_url": "Alice.png", "file_name": "does-not-exist"})),
		"getMissingFileName": serve(http.MethodPost, getRoute, sessionCookie, csrf.Token,
			jsonBody(map[string]any{"avatar_url": "Alice.png"})),
		"getMissingCharacterDirectory": serve(http.MethodPost, getRoute, sessionCookie, csrf.Token,
			jsonBody(map[string]any{"avatar_url": "BrandNew.png", "file_name": "anything"})),
	}
	for label, response := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("chats save/get fixture has no %q response", label)
		}
		assertAccountMutationResponse(t, label, response, want)
	}

	readFile := func(path string) *string {
		body, err := os.ReadFile(path)
		if err != nil {
			return nil
		}
		text := string(body)
		return &text
	}
	assertOptionalString := func(label string, got, want *string) {
		t.Helper()
		if got == nil || want == nil {
			if got != nil || want != nil {
				t.Fatalf("%s = %v; pinned Node has %v", label, got, want)
			}
			return
		}
		if *got != *want {
			t.Fatalf("%s = %q; pinned Node has %q", label, *got, *want)
		}
	}
	assertOptionalString("savedNormalJsonl", readFile(filepath.Join(aliceDirectory, "normal.jsonl")), fixture.State.SavedNormalJsonl)
	assertOptionalString("savedEmptyArrayJsonl", readFile(filepath.Join(aliceDirectory, "empty-array.jsonl")), fixture.State.SavedEmptyArrayJsonl)

	if _, err := os.Stat(filepath.Join(directories["root"], "evil.jsonl")); (err == nil) != fixture.State.EscapedSave {
		t.Fatalf("escaped save file exists = %v; pinned Node has %v", err == nil, fixture.State.EscapedSave)
	}
	if _, err := os.Stat(filepath.Join(chatsRoot, "BrandNew")); (err == nil) != fixture.State.NewCharacterDirectoryCreated {
		t.Fatalf("BrandNew directory exists = %v; pinned Node has %v", err == nil, fixture.State.NewCharacterDirectoryCreated)
	}
	if got := snapshotChatsTree(t, chatsRoot); !reflect.DeepEqual(got, fixture.State.ChatsTree) {
		t.Fatalf("chats tree = %+v; pinned Node has %+v", got, fixture.State.ChatsTree)
	}

	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("chat save/get changed the account storage record")
	}
}
