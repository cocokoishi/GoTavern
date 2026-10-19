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
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type backgroundsRenameFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret     string            `json:"cookieSecret"`
		Files            map[string]string `json:"files"`
		MainIndex        string            `json:"mainIndex"`
		SanitizeIndex    string            `json:"sanitizeIndex"`
		MalformedIndex   string            `json:"malformedIndexBytes"`
		ThumbfailIndex   string            `json:"thumbfailIndex"`
		GoRoundTripIndex string            `json:"goRoundTripIndex"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		AfterRename struct {
			OldExists          bool   `json:"oldExists"`
			NewContent         string `json:"newContent"`
			OldThumbnailExists bool   `json:"oldThumbnailExists"`
			NewThumbnailExists bool   `json:"newThumbnailExists"`
			Index              any    `json:"index"`
		} `json:"afterRename"`
		AfterSanitizedRename struct {
			OldExists          bool   `json:"oldExists"`
			NewContent         string `json:"newContent"`
			OldThumbnailExists bool   `json:"oldThumbnailExists"`
			NewThumbnailExists bool   `json:"newThumbnailExists"`
			Index              any    `json:"index"`
		} `json:"afterSanitizedRename"`
		AfterMalformedRename struct {
			OldExists bool   `json:"oldExists"`
			NewExists bool   `json:"newExists"`
			Index     string `json:"index"`
		} `json:"afterMalformedRename"`
		AfterThumbnailFailure struct {
			OldExists            bool `json:"oldExists"`
			NewExists            bool `json:"newExists"`
			ThumbnailIsDirectory bool `json:"thumbnailIsDirectory"`
			Index                any  `json:"index"`
		} `json:"afterThumbnailFailure"`
		GoRoundTrip struct {
			GoResponse         accountMutationResponseFixture `json:"goResponse"`
			NodeReadback       accountMutationResponseFixture `json:"nodeReadback"`
			OldExists          bool                           `json:"oldExists"`
			NewContent         string                         `json:"newContent"`
			OldThumbnailExists bool                           `json:"oldThumbnailExists"`
		} `json:"goRoundTrip"`
		AccountRecordUnchanged bool `json:"accountRecordUnchanged"`
	} `json:"state"`
}

func TestPinnedNodeBackgroundRename(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-backgrounds-rename.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture backgroundsRenameFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("backgrounds/rename oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Files) == 0 || fixture.Inputs.MainIndex == "" || fixture.Inputs.GoRoundTripIndex == "" {
		t.Fatal("backgrounds/rename oracle is missing required inputs")
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
	}{"default-user", "Background Rename Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	backgroundsRoot := directories["backgrounds"]
	thumbnailRoot := directories["thumbnailsBg"]
	for filename, encoded := range fixture.Inputs.Files {
		if filename == "go-old.png" {
			continue
		}
		writeRenameBackgroundFixture(t, backgroundsRoot, filename, encoded)
	}
	if err := os.Mkdir(filepath.Join(backgroundsRoot, "folder.png"), 0o755); err != nil {
		t.Fatal(err)
	}
	for _, filename := range []string{"old.png", "sanitizesource.png"} {
		if err := os.WriteFile(filepath.Join(thumbnailRoot, filename), []byte("cached thumbnail"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	indexPath := filepath.Join(directories["root"], imageMetadataIndexFilename)
	if err := os.WriteFile(indexPath, []byte(fixture.Inputs.MainIndex), 0o600); err != nil {
		t.Fatal(err)
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
	route := "/api/backgrounds/rename"
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":       serve(http.MethodPost, route, csrfCookie, csrf.Token, []byte(`{"old_bg":"old.png","new_bg":"new.png"}`)),
		"invalidCSRF":        serve(http.MethodPost, route, sessionCookie, "", []byte(`{"old_bg":"old.png","new_bg":"new.png"}`)),
		"wrongMethod":        serve(http.MethodGet, route, sessionCookie, "", nil),
		"wrongMethodHead":    serve(http.MethodHead, route, sessionCookie, "", nil),
		"wrongMethodOptions": serve(http.MethodOptions, route, sessionCookie, "", nil),
		"renamed":            serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"old_bg":"old.png","new_bg":"new.png"}`)),
	}
	afterRename, err := readBackgroundRenameState(t, backgroundsRoot, thumbnailRoot, indexPath, "old.png", "new.png", "old.png")
	if err != nil {
		t.Fatal(err)
	}
	responses["missingSource"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"old_bg":"missing.png","new_bg":"fresh.png"}`))
	responses["destinationExists"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"old_bg":"conflict-source.png","new_bg":"exists.png"}`))

	if err := os.WriteFile(indexPath, []byte(fixture.Inputs.SanitizeIndex), 0o600); err != nil {
		t.Fatal(err)
	}
	responses["sanitizedNames"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"old_bg":"sanitize?source.png","new_bg":"new?name.png"}`))
	afterSanitizedRename, err := readBackgroundRenameState(t, backgroundsRoot, thumbnailRoot, indexPath, "sanitizesource.png", "newname.png", "sanitizesource.png")
	if err != nil {
		t.Fatal(err)
	}
	responses["missingField"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{}`))
	responses["noBody"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, nil)
	responses["directorySource"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"old_bg":"folder.png","new_bg":"folder-copy.png"}`))

	malformedIndexBytes := fixture.Inputs.MalformedIndex
	writeRenameBackgroundFixture(t, backgroundsRoot, "malformed.png", fixture.Inputs.Files["malformed.png"])
	if err := os.WriteFile(indexPath, []byte(malformedIndexBytes), 0o600); err != nil {
		t.Fatal(err)
	}
	responses["malformedMetadata"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"old_bg":"malformed.png","new_bg":"malformed-new.png"}`))
	afterMalformedRename := struct {
		OldExists bool   `json:"oldExists"`
		NewExists bool   `json:"newExists"`
		Index     string `json:"index"`
	}{
		OldExists: backgroundRenameFileExists(filepath.Join(backgroundsRoot, "malformed.png")),
		NewExists: backgroundRenameFileExists(filepath.Join(backgroundsRoot, "malformed-new.png")),
		Index:     string(mustReadFile(t, indexPath)),
	}

	writeRenameBackgroundFixture(t, backgroundsRoot, "thumbfail.png", fixture.Inputs.Files["thumbfail.png"])
	if err := os.Mkdir(filepath.Join(thumbnailRoot, "thumbfail.png"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, []byte(fixture.Inputs.ThumbfailIndex), 0o600); err != nil {
		t.Fatal(err)
	}
	responses["thumbnailFailure"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"old_bg":"thumbfail.png","new_bg":"thumbfail-new.png"}`))
	afterThumbnailFailure := struct {
		OldExists            bool `json:"oldExists"`
		NewExists            bool `json:"newExists"`
		ThumbnailIsDirectory bool `json:"thumbnailIsDirectory"`
		Index                any  `json:"index"`
	}{
		OldExists:            backgroundRenameFileExists(filepath.Join(backgroundsRoot, "thumbfail.png")),
		NewExists:            backgroundRenameFileExists(filepath.Join(backgroundsRoot, "thumbfail-new.png")),
		ThumbnailIsDirectory: backgroundRenameDirectoryExists(filepath.Join(thumbnailRoot, "thumbfail.png")),
	}
	afterThumbnailFailure.Index, err = readNormalizedBackgroundIndex(indexPath)
	if err != nil {
		t.Fatal(err)
	}

	writeRenameBackgroundFixture(t, backgroundsRoot, "go-old.png", fixture.Inputs.Files["go-old.png"])
	if err := os.WriteFile(filepath.Join(thumbnailRoot, "go-old.png"), []byte("go thumbnail"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, []byte(fixture.Inputs.GoRoundTripIndex), 0o600); err != nil {
		t.Fatal(err)
	}
	goResponse := serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"old_bg":"go-old.png","new_bg":"go-new.png"}`))
	goReadback := serve(http.MethodPost, "/api/image-metadata/all", sessionCookie, csrf.Token, []byte(`{"prefix":"backgrounds/"}`))
	goRoundTrip := struct {
		GoResponse         *httptest.ResponseRecorder
		NodeReadback       *httptest.ResponseRecorder
		OldExists          bool
		NewContent         string
		OldThumbnailExists bool
	}{
		GoResponse:         goResponse,
		NodeReadback:       goReadback,
		OldExists:          backgroundRenameFileExists(filepath.Join(backgroundsRoot, "go-old.png")),
		NewContent:         string(mustReadFile(t, filepath.Join(backgroundsRoot, "go-new.png"))),
		OldThumbnailExists: backgroundRenameFileExists(filepath.Join(thumbnailRoot, "go-old.png")),
	}

	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("backgrounds/rename fixture has no %q response", label)
		}
		assertAccountMutationResponse(t, label, got, want)
	}
	if !reflect.DeepEqual(afterRename, fixture.State.AfterRename) {
		t.Fatalf("background rename state = %#v; pinned Node has %#v", afterRename, fixture.State.AfterRename)
	}
	if !reflect.DeepEqual(afterSanitizedRename, fixture.State.AfterSanitizedRename) {
		t.Fatalf("sanitized background rename state = %#v; pinned Node has %#v", afterSanitizedRename, fixture.State.AfterSanitizedRename)
	}
	if !reflect.DeepEqual(afterMalformedRename, fixture.State.AfterMalformedRename) {
		t.Fatalf("malformed-index rename state = %#v; pinned Node has %#v", afterMalformedRename, fixture.State.AfterMalformedRename)
	}
	if !reflect.DeepEqual(afterThumbnailFailure, fixture.State.AfterThumbnailFailure) {
		t.Fatalf("thumbnail failure rename state = %#v; pinned Node has %#v", afterThumbnailFailure, fixture.State.AfterThumbnailFailure)
	}
	assertAccountMutationResponse(t, "Go rename round-trip response", goRoundTrip.GoResponse, fixture.State.GoRoundTrip.GoResponse)
	assertAccountMutationResponse(t, "Node metadata readback after Go rename", goRoundTrip.NodeReadback, fixture.State.GoRoundTrip.NodeReadback)
	if goRoundTrip.OldExists != fixture.State.GoRoundTrip.OldExists || goRoundTrip.NewContent != fixture.State.GoRoundTrip.NewContent || goRoundTrip.OldThumbnailExists != fixture.State.GoRoundTrip.OldThumbnailExists {
		t.Fatalf("Go rename round-trip file state = %#v; pinned Node has %#v", goRoundTrip, fixture.State.GoRoundTrip)
	}
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("background rename changed the account storage record")
	}
}

func writeRenameBackgroundFixture(t *testing.T, directory, filename, encoded string) {
	t.Helper()
	content, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("decode background fixture %q: %v", filename, err)
	}
	if err := os.WriteFile(filepath.Join(directory, filename), content, 0o600); err != nil {
		t.Fatal(err)
	}
}

func readBackgroundRenameState(t *testing.T, backgroundsRoot, thumbnailRoot, indexPath, oldFilename, newFilename, thumbnailFilename string) (struct {
	OldExists          bool   `json:"oldExists"`
	NewContent         string `json:"newContent"`
	OldThumbnailExists bool   `json:"oldThumbnailExists"`
	NewThumbnailExists bool   `json:"newThumbnailExists"`
	Index              any    `json:"index"`
}, error) {
	t.Helper()
	state := struct {
		OldExists          bool   `json:"oldExists"`
		NewContent         string `json:"newContent"`
		OldThumbnailExists bool   `json:"oldThumbnailExists"`
		NewThumbnailExists bool   `json:"newThumbnailExists"`
		Index              any    `json:"index"`
	}{
		OldExists:          backgroundRenameFileExists(filepath.Join(backgroundsRoot, oldFilename)),
		OldThumbnailExists: backgroundRenameFileExists(filepath.Join(thumbnailRoot, thumbnailFilename)),
		NewThumbnailExists: backgroundRenameFileExists(filepath.Join(thumbnailRoot, newFilename)),
	}
	content, err := os.ReadFile(filepath.Join(backgroundsRoot, newFilename))
	if err != nil {
		return state, err
	}
	state.NewContent = string(content)
	state.Index, err = readNormalizedBackgroundIndex(indexPath)
	return state, err
}

func backgroundRenameFileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func backgroundRenameDirectoryExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
