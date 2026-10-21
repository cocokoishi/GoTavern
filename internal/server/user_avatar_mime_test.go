package server

import (
	"bytes"
	"encoding/base64"
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

// Pinned persona-avatar data URL oracle comparison.
//
// The four cases the table choice actually distinguishes are asserted
// individually as well as by comparison, because a fix that used either pinned
// table would satisfy a comparison that only checked "a data URL came back".
// Each of .avif and .heic resolves only through mime-types, .json pins the
// absence of a charset, and an unknown extension pins the template literal's
// interpolation of mime.lookup's false.

type userAvatarFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Normalizations []string `json:"normalizations"`
	Gaps           []string `json:"gaps"`
	Inputs         struct {
		CookieSecret string            `json:"cookieSecret"`
		SeededUsers  []map[string]any  `json:"seededUsers"`
		AvatarFiles  map[string]string `json:"avatarFiles"`
	} `json:"inputs"`
	Responses map[string]struct {
		Status int `json:"status"`
		Avatar any `json:"avatar"`
	} `json:"responses"`
}

// userAvatarPersonaFor maps a fixture label back to the persona filename the
// probe used, so the test drives the same settings values.
var userAvatarPersonaFor = map[string]string{
	"probe_avif":   "probe.avif",
	"probe_heic":   "probe.heic",
	"probe_json":   "probe.json",
	"probe_png":    "probe.png",
	"probe_zzz":    "probe.zzz",
	"missing_file": "probe-missing.avif",
}

func TestPinnedNodeUserAvatarDataURL(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-user-avatar-data-url.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture userAvatarFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("user-avatar oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Responses) == 0 || len(fixture.Normalizations) == 0 || len(fixture.Inputs.AvatarFiles) == 0 {
		t.Fatal("user-avatar oracle is missing observations, normalizations or inputs")
	}
	// The fixture must actually discriminate the two pinned tables, or this test
	// would pass against either of them.
	for _, label := range []string{"probe_avif", "probe_heic", "probe_json", "probe_zzz"} {
		if _, exists := fixture.Responses[label]; !exists {
			t.Fatalf("user-avatar oracle is missing the discriminating case %q", label)
		}
	}
	if len(userAvatarPersonaFor) != len(fixture.Responses)-1 {
		t.Fatalf("the test drives %d personas but the oracle has %d non-fallback responses", len(userAvatarPersonaFor), len(fixture.Responses)-1)
	}

	dataRoot := t.TempDir()
	installRoot := t.TempDir()
	if err := os.MkdirAll(filepath.Join(dataRoot, "_storage"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(fixture.Inputs.CookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	for _, user := range fixture.Inputs.SeededUsers {
		handle, _ := user["handle"].(string)
		encoded, err := marshalNodeJSON(user)
		if err != nil {
			t.Fatal(err)
		}
		if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+handle, encoded); err != nil {
			t.Fatal(err)
		}
	}
	handles := make([]string, 0, len(fixture.Inputs.SeededUsers))
	for _, user := range fixture.Inputs.SeededUsers {
		handle, _ := user["handle"].(string)
		handles = append(handles, handle)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, handles); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	avatarsRoot := directories["avatars"]
	if err := os.MkdirAll(avatarsRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	for name, encoded := range fixture.Inputs.AvatarFiles {
		content, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(avatarsRoot, name), content, 0o600); err != nil {
			t.Fatal(err)
		}
	}
	settingsPath := filepath.Join(directories["root"], "settings.json")

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
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
	cookieFrom := func(cookies []string) string {
		parts := make([]string, 0, len(cookies))
		for _, cookie := range cookies {
			parts = append(parts, strings.SplitN(cookie, ";", 2)[0])
		}
		return strings.Join(parts, "; ")
	}
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", nil)
	var csrf struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrfResponse.Body.Bytes(), &csrf); err != nil {
		t.Fatal(err)
	}
	csrfCookie := cookieFrom(csrfResponse.Header().Values("Set-Cookie"))
	loginBody, _ := json.Marshal(map[string]string{"handle": "default-user", "password": ""})
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, loginBody)
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	session := cookieFrom(login.Header().Values("Set-Cookie"))

	avatarFrom := func(t *testing.T) any {
		t.Helper()
		response := serve(http.MethodGet, "/api/users/me", session, "", nil)
		if response.Code != http.StatusOK {
			t.Fatalf("GET /api/users/me = %d, body %q", response.Code, response.Body.String())
		}
		var view struct {
			Avatar any `json:"avatar"`
		}
		if err := json.Unmarshal(response.Body.Bytes(), &view); err != nil {
			t.Fatal(err)
		}
		return view.Avatar
	}

	for _, label := range sortedUserAvatarLabels(fixture.Responses) {
		want := fixture.Responses[label]
		persona, driven := userAvatarPersonaFor[label]
		if !driven {
			continue
		}
		settings, err := json.Marshal(map[string]any{
			"power_user":  map[string]any{"default_persona": persona},
			"user_avatar": persona,
		})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(settingsPath, settings, 0o600); err != nil {
			t.Fatal(err)
		}
		got := avatarFrom(t)
		if !reflect.DeepEqual(got, want.Avatar) {
			t.Errorf("%s avatar = %s; pinned Node has %s", label, formatAny(got), formatAny(want.Avatar))
		}
	}

	// No usable persona at all.
	if err := os.WriteFile(settingsPath, []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, want := avatarFrom(t), fixture.Responses["no_persona"].Avatar; !reflect.DeepEqual(got, want) {
		t.Errorf("no_persona avatar = %s; pinned Node has %s", formatAny(got), formatAny(want))
	}

	// The discriminating expectations, asserted on their own so a fix that chose
	// either pinned table cannot satisfy them by accident.
	if err := os.WriteFile(settingsPath, []byte(`{"power_user":{"default_persona":"probe.avif"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := avatarFrom(t).(string); !strings.HasPrefix(got, "data:image/avif;base64,") {
		t.Errorf(".avif avatar = %q; the pinned path resolves it through mime-types", got)
	}
	if err := os.WriteFile(settingsPath, []byte(`{"power_user":{"default_persona":"probe.zzz"}}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if got, _ := avatarFrom(t).(string); !strings.HasPrefix(got, "data:false;base64,") {
		t.Errorf("unknown-extension avatar = %q; the pinned template literal interpolates mime.lookup's false", got)
	}
}

func sortedUserAvatarLabels(responses map[string]struct {
	Status int `json:"status"`
	Avatar any `json:"avatar"`
}) []string {
	labels := make([]string, 0, len(responses))
	for label := range responses {
		labels = append(labels, label)
	}
	sort.Strings(labels)
	return labels
}
