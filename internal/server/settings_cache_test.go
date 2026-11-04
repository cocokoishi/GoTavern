package server

// M5b CACHE CONTRACT TESTS: own-write freshness, external-modification freshness, the documented residual
// window, the bound, and the clone. The two freshness tests are the failure mode the cache must not
// introduce (a save through the product route followed immediately by a cached read); the residual test
// pins the one window that is documented rather than fixed.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type metadataCacheTestServer struct {
	handler     http.Handler
	cookie      string
	token       string
	dataRoot    string
	installRoot string
	directories startup.UserDirectories
}

func newMetadataCacheTestServer(t *testing.T) *metadataCacheTestServer {
	t.Helper()
	resetUserMetadataCache()
	t.Cleanup(resetUserMetadataCache)

	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	accountJSON, err := marshalNodeJSON(struct {
		Handle   string `json:"handle"`
		Name     string `json:"name"`
		Created  int64  `json:"created"`
		Password string `json:"password"`
		Admin    bool   `json:"admin"`
		Enabled  bool   `json:"enabled"`
		Salt     string `json:"salt"`
	}{"default-user", "Cache Reader", 1700000000000, "", true, true, ""})
	if err != nil {
		t.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		t.Fatal(err)
	}
	const cookieSecret = "metadata-cache-test-secret-0123456789"
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(cookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: cookieSecret, AccountsEnabled: true,
	})

	server := &metadataCacheTestServer{handler: handler, dataRoot: dataRoot, installRoot: installRoot, directories: directories}
	do := func(method, route, cookie, token string, body []byte) *httptest.ResponseRecorder {
		var reader *bytes.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		} else {
			reader = bytes.NewReader(nil)
		}
		request := httptest.NewRequest(method, route, reader)
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		if token != "" {
			request.Header.Set("X-CSRF-Token", token)
		}
		if body != nil {
			request.Header.Set("Content-Type", "application/json")
		}
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder
	}
	cookieFrom := func(cookies []string) string {
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfResponse := do(http.MethodGet, "/csrf-token", "", "", nil)
	if csrfResponse.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d", csrfResponse.Code)
	}
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrf); err != nil {
		t.Fatal(err)
	}
	csrfCookie := cookieFrom(csrfResponse.Header().Values("Set-Cookie"))
	login := do(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, []byte(`{"handle":"default-user","password":""}`))
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	server.cookie = cookieFrom(login.Header().Values("Set-Cookie"))
	server.token = csrf.Token
	if err := os.WriteFile(filepath.Join(directories["root"], "settings.json"), []byte(`{"settings":"initial-settings-marker"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	return server
}

// request drives one authenticated request with the product's CSRF header and session cookie.
func (server *metadataCacheTestServer) request(t *testing.T, method, route string, body any) *httptest.ResponseRecorder {
	t.Helper()
	var encoded []byte
	if body != nil {
		var err error
		encoded, err = json.Marshal(body)
		if err != nil {
			t.Fatal(err)
		}
	}
	request := httptest.NewRequest(method, route, bytes.NewReader(encoded))
	request.Header.Set("Cookie", server.cookie)
	request.Header.Set("X-CSRF-Token", server.token)
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response := httptest.NewRecorder()
	server.handler.ServeHTTP(response, request)
	return response
}

func (server *metadataCacheTestServer) writeUserFile(t *testing.T, directoryKey, name, contents string) string {
	t.Helper()
	path := filepath.Join(server.directories[directoryKey], name)
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func (server *metadataCacheTestServer) settingsGet(t *testing.T) string {
	t.Helper()
	response := server.request(t, http.MethodPost, "/api/settings/get", map[string]any{})
	if response.Code != http.StatusOK {
		t.Fatalf("POST /api/settings/get = %d, body %q", response.Code, response.Body.String())
	}
	return response.Body.String()
}

func (server *metadataCacheTestServer) worldInfoList(t *testing.T) string {
	t.Helper()
	response := server.request(t, http.MethodPost, "/api/worldinfo/list", map[string]any{})
	if response.Code != http.StatusOK {
		t.Fatalf("POST /api/worldinfo/list = %d, body %q", response.Code, response.Body.String())
	}
	return response.Body.String()
}

// TestSettingsAggregationCacheInvalidatesOnProductWrites is the failure mode the cache must not introduce:
// a preset and settings.json are saved through the PRODUCT routes (the locked atomic write helpers), and the
// very next cached read must see the new values.
func TestSettingsAggregationCacheInvalidatesOnProductWrites(t *testing.T) {
	server := newMetadataCacheTestServer(t)
	server.writeUserFile(t, "openAI_Settings", "probe.json", `{"marker":"preset-before-marker"}`)

	warm := server.settingsGet(t)
	if !strings.Contains(warm, "preset-before-marker") || !strings.Contains(warm, "initial-settings-marker") {
		t.Fatalf("warm settings/get does not contain the planted values: %s", warm)
	}

	savePreset := server.request(t, http.MethodPost, "/api/presets/save", map[string]any{
		"name":   "probe",
		"apiId":  "openai",
		"preset": map[string]any{"marker": "preset-after-marker"},
	})
	if savePreset.Code != http.StatusOK {
		t.Fatalf("POST /api/presets/save = %d, body %q", savePreset.Code, savePreset.Body.String())
	}
	afterPreset := server.settingsGet(t)
	if !strings.Contains(afterPreset, "preset-after-marker") {
		t.Fatalf("a preset saved through the product route is not visible in the next cached settings/get: %s", afterPreset)
	}
	if strings.Contains(afterPreset, "preset-before-marker") {
		t.Fatalf("the replaced preset's old content is still served: %s", afterPreset)
	}

	saveSettings := server.request(t, http.MethodPost, "/api/settings/save", map[string]any{"settings": "saved-settings-marker"})
	if saveSettings.Code != http.StatusOK {
		t.Fatalf("POST /api/settings/save = %d, body %q", saveSettings.Code, saveSettings.Body.String())
	}
	afterSettings := server.settingsGet(t)
	if !strings.Contains(afterSettings, "saved-settings-marker") {
		t.Fatalf("settings.json saved through the product route is not visible in the next cached settings/get: %s", afterSettings)
	}
}

// TestWorldInfoListCacheInvalidatesOnProductWrite is the same contract for the world-info listing: the edit
// route writes the world file under the user-content lock, and the next listing must show the new name.
func TestWorldInfoListCacheInvalidatesOnProductWrite(t *testing.T) {
	server := newMetadataCacheTestServer(t)
	server.writeUserFile(t, "worlds", "Probe World.json", `{"entries":{},"name":"Old World Name","extensions":{"marker":"old"}}`)

	warm := server.worldInfoList(t)
	if !strings.Contains(warm, "Old World Name") {
		t.Fatalf("warm worldinfo/list does not contain the planted name: %s", warm)
	}

	edit := server.request(t, http.MethodPost, "/api/worldinfo/edit", map[string]any{
		"name": "Probe World",
		"data": map[string]any{"entries": map[string]any{}, "name": "New World Name", "extensions": map[string]any{"marker": "new"}},
	})
	if edit.Code != http.StatusOK {
		t.Fatalf("POST /api/worldinfo/edit = %d, body %q", edit.Code, edit.Body.String())
	}
	after := server.worldInfoList(t)
	if !strings.Contains(after, "New World Name") {
		t.Fatalf("a world file saved through the product route is not visible in the next cached listing: %s", after)
	}
	if strings.Contains(after, "Old World Name") {
		t.Fatalf("the replaced world's old name is still served: %s", after)
	}
}

// TestSettingsAggregationCacheSeesExternalModification covers a writer that is not this server (pinned Node
// over the same tree, or a user editing a preset): a new mtime/size must invalidate the entry.
func TestSettingsAggregationCacheSeesExternalModification(t *testing.T) {
	server := newMetadataCacheTestServer(t)
	server.writeUserFile(t, "openAI_Settings", "external.json", `{"marker":"external-before"}`)
	if warm := server.settingsGet(t); !strings.Contains(warm, "external-before") {
		t.Fatalf("warm settings/get does not contain the planted value: %s", warm)
	}
	server.writeUserFile(t, "openAI_Settings", "external.json", `{"marker":"external-after-with-a-different-size"}`)
	if after := server.settingsGet(t); !strings.Contains(after, "external-after-with-a-different-size") {
		t.Fatalf("external modification behind the server was not seen: %s", after)
	}
}

func TestWorldInfoListCacheSeesExternalModification(t *testing.T) {
	server := newMetadataCacheTestServer(t)
	server.writeUserFile(t, "worlds", "External World.json", `{"entries":{},"name":"External Before"}`)
	if warm := server.worldInfoList(t); !strings.Contains(warm, "External Before") {
		t.Fatalf("warm worldinfo/list does not contain the planted name: %s", warm)
	}
	server.writeUserFile(t, "worlds", "External World.json", `{"entries":{},"name":"External After With A Longer Name"}`)
	if after := server.worldInfoList(t); !strings.Contains(after, "External After With A Longer Name") {
		t.Fatalf("external world modification behind the server was not seen: %s", after)
	}
}

// TestMetadataCacheSameIdentityWindowIsTheDocumentedResidual pins the ONE staleness window this design
// documents: an external in-place rewrite that keeps the byte size and backdates mtime is indistinguishable
// from no change. The test skips when the host filesystem cannot round-trip the mtime exactly, because then
// the window cannot be constructed (and the product is fresh, not stale).
func TestMetadataCacheSameIdentityWindowIsTheDocumentedResidual(t *testing.T) {
	server := newMetadataCacheTestServer(t)
	path := server.writeUserFile(t, "openAI_Settings", "residual.json", `{"marker":"BBBBB"}`)
	if warm := server.settingsGet(t); !strings.Contains(warm, "BBBBB") {
		t.Fatalf("warm settings/get does not contain the planted value: %s", warm)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	// Same length, different bytes: the size cannot distinguish these two files.
	if err := os.WriteFile(path, []byte(`{"marker":"AAAAA"}`), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Chtimes(path, info.ModTime(), info.ModTime()); err != nil {
		t.Skipf("this filesystem cannot restore mtime (%v), so the documented window cannot be constructed", err)
	}
	restored, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	identityBefore := digestSettingsAggregation(server.directories)
	if !restored.ModTime().Equal(info.ModTime()) || identityBefore != digestSettingsAggregation(server.directories) {
		t.Skip("this filesystem did not preserve the mtime identity exactly; the window cannot be constructed here")
	}
	stale := server.settingsGet(t)
	if strings.Contains(stale, "AAAAA") {
		t.Fatalf("the same-size same-mtime replacement was detected; this test exists to pin the documented residual window, so its premise is gone: %s", stale)
	}
	// And a normal external write (new mtime) DOES recover on the next read, which is why the residual is
	// narrow rather than a design defect: the window requires size AND mtime preservation.
	server.writeUserFile(t, "openAI_Settings", "residual.json", `{"marker":"CCCCC"}`)
	if recovered := server.settingsGet(t); !strings.Contains(recovered, "CCCCC") {
		t.Fatalf("a normal external write after the residual window was not seen: %s", recovered)
	}
}

// TestMetadataCacheBoundCloneAndOversizeBody exercises the three §15.3 mechanics that are not observable
// through a route: eviction of the whole map at the entry bound, a body larger than the byte budget never
// being cached, and load returning a copy a caller cannot use to mutate cached state.
func TestMetadataCacheBoundCloneAndOversizeBody(t *testing.T) {
	resetUserMetadataCache()
	entryLimitBefore, byteLimitBefore := userMetadataCacheEntryLimit, userMetadataCacheBytesLimit
	t.Cleanup(func() {
		userMetadataCacheEntryLimit, userMetadataCacheBytesLimit = entryLimitBefore, byteLimitBefore
		resetUserMetadataCache()
	})
	userMetadataCacheEntryLimit = 2
	userMetadataCacheBytesLimit = 1 << 20

	var first [32]byte
	first[0] = 1
	storeUserMetadataCache("bounded-a", first, []byte("alpha"))
	storeUserMetadataCache("bounded-b", first, []byte("beta"))
	entries, bodyBytes := metadataCacheMemoryCost()
	if entries != 2 || bodyBytes != len("alpha")+len("beta") {
		t.Fatalf("cache accounting after two stores = %d entries / %d bytes", entries, bodyBytes)
	}
	storeUserMetadataCache("bounded-c", first, []byte("gamma"))
	entries, bodyBytes = metadataCacheMemoryCost()
	if entries != 1 || bodyBytes != len("gamma") {
		t.Fatalf("entry-bound eviction did not drop the whole map: %d entries / %d bytes", entries, bodyBytes)
	}
	if _, hit := loadUserMetadataCache("bounded-a", first); hit {
		t.Fatal("an evicted entry was still served")
	}

	storeUserMetadataCache("clone-key", first, []byte("cached-body"))
	loaded, hit := loadUserMetadataCache("clone-key", first)
	if !hit || string(loaded) != "cached-body" {
		t.Fatalf("clone preconditions: hit=%t body=%q", hit, loaded)
	}
	loaded[0] = 'X'
	again, hit := loadUserMetadataCache("clone-key", first)
	if !hit || string(again) != "cached-body" {
		t.Fatalf("mutating a loaded body reached cached state: %q", again)
	}

	userMetadataCacheBytesLimit = 8
	storeUserMetadataCache("oversize", first, []byte("0123456789"))
	if entries, _ := metadataCacheMemoryCost(); entries != 2 {
		t.Fatalf("an oversize body was cached despite exceeding the byte budget: %d entries", entries)
	}
	if _, hit := loadUserMetadataCache("oversize", first); hit {
		t.Fatal("an oversize body was served from the cache")
	}
}

// TestMetadataCacheHitIsByteIdentical pins the byte-equality claim the oracle fixtures rely on: two calls
// with the same inputs return the same body (and headers), the second from the cache.
func TestMetadataCacheHitIsByteIdentical(t *testing.T) {
	server := newMetadataCacheTestServer(t)
	server.writeUserFile(t, "themes", "theme.json", `{"name":"cache-theme"}`)
	first := server.request(t, http.MethodPost, "/api/settings/get", map[string]any{})
	second := server.request(t, http.MethodPost, "/api/settings/get", map[string]any{})
	if first.Code != http.StatusOK || second.Code != http.StatusOK {
		t.Fatalf("settings/get statuses = %d, %d", first.Code, second.Code)
	}
	if !bytes.Equal(first.Body.Bytes(), second.Body.Bytes()) {
		t.Fatal("a cached settings/get body differs from the uncached body")
	}
	if first.Header().Get("ETag") != second.Header().Get("ETag") || first.Header().Get("ETag") == "" {
		t.Fatalf("ETag differs or is absent: %q vs %q", first.Header().Get("ETag"), second.Header().Get("ETag"))
	}
	entries, bodyBytes := metadataCacheMemoryCost()
	t.Logf("cache after one warm settings/get: %d entry(ies), %d retained body bytes; response body %d bytes", entries, bodyBytes, first.Body.Len())
	if entries != 1 || bodyBytes != first.Body.Len() {
		t.Fatalf("cache accounting = %d entries / %d bytes, want 1 / %d", entries, bodyBytes, first.Body.Len())
	}
}
