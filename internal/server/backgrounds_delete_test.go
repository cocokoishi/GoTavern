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

type backgroundsDeleteFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret        string            `json:"cookieSecret"`
		Files               map[string]string `json:"files"`
		MainIndex           string            `json:"mainIndex"`
		MalformedIndexBytes string            `json:"malformedIndexBytes"`
		ThumbfailIndex      map[string]any    `json:"thumbfailIndex"`
		GoRoundTripIndex    string            `json:"goRoundTripIndex"`
	} `json:"inputs"`
	Responses map[string]accountMutationResponseFixture `json:"responses"`
	State     struct {
		AfterDelete struct {
			BackgroundExists bool `json:"backgroundExists"`
			ThumbnailExists  bool `json:"thumbnailExists"`
			Index            any  `json:"index"`
		} `json:"afterDelete"`
		MalformedIndexAfter      string `json:"malformedIndexAfter"`
		MalformedFileExistsAfter bool   `json:"malformedFileExistsAfter"`
		AfterThumbnailFailure    struct {
			BackgroundExists     bool `json:"backgroundExists"`
			ThumbnailIsDirectory bool `json:"thumbnailIsDirectory"`
			Index                any  `json:"index"`
		} `json:"afterThumbnailFailure"`
		GoRoundTrip struct {
			GoResponse       accountMutationResponseFixture `json:"goResponse"`
			NodeReadback     accountMutationResponseFixture `json:"nodeReadback"`
			BackgroundExists bool                           `json:"backgroundExists"`
			ThumbnailExists  bool                           `json:"thumbnailExists"`
		} `json:"goRoundTrip"`
		AccountRecordUnchanged bool `json:"accountRecordUnchanged"`
	} `json:"state"`
}

func TestPinnedNodeBackgroundDelete(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-backgrounds-delete.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture backgroundsDeleteFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("backgrounds/delete oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Files) == 0 || fixture.Inputs.MainIndex == "" || fixture.Inputs.GoRoundTripIndex == "" {
		t.Fatal("backgrounds/delete oracle is missing required inputs")
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
	}{"default-user", "Background Delete Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
		if filename == "go-delete.png" {
			continue
		}
		writeBackgroundFixture(t, backgroundsRoot, filename, encoded)
	}
	if err := os.Mkdir(filepath.Join(backgroundsRoot, "folder.png"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(thumbnailRoot, "delete-me.png"), []byte("thumbnail"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directories["root"], imageMetadataIndexFilename), []byte(fixture.Inputs.MainIndex), 0o600); err != nil {
		t.Fatal(err)
	}
	outsidePath := filepath.Join(directories["root"], "outside.png")
	if err := os.WriteFile(outsidePath, []byte("must remain"), 0o600); err != nil {
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
	route := "/api/backgrounds/delete"
	responses := map[string]*httptest.ResponseRecorder{
		"unauthorized":       serve(http.MethodPost, route, csrfCookie, csrf.Token, []byte(`{"bg":"delete-me.png"}`)),
		"invalidCSRF":        serve(http.MethodPost, route, sessionCookie, "", []byte(`{"bg":"delete-me.png"}`)),
		"wrongMethod":        serve(http.MethodGet, route, sessionCookie, "", nil),
		"wrongMethodHead":    serve(http.MethodHead, route, sessionCookie, "", nil),
		"wrongMethodOptions": serve(http.MethodOptions, route, sessionCookie, "", nil),
		"deleted":            serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"bg":"delete-me.png"}`)),
	}
	afterDelete := struct {
		BackgroundExists bool `json:"backgroundExists"`
		ThumbnailExists  bool `json:"thumbnailExists"`
		Index            any  `json:"index"`
	}{
		BackgroundExists: backgroundDeleteFileExists(filepath.Join(backgroundsRoot, "delete-me.png")),
		ThumbnailExists:  backgroundDeleteFileExists(filepath.Join(thumbnailRoot, "delete-me.png")),
	}
	afterDelete.Index, err = readNormalizedBackgroundIndex(filepath.Join(directories["root"], imageMetadataIndexFilename))
	if err != nil {
		t.Fatal(err)
	}
	responses["missingFile"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"bg":"delete-me.png"}`))
	responses["sanitizedName"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"bg":"bad?name.png"}`))
	responses["pathSeparator"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"bg":"../outside.png"}`))
	responses["missingField"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{}`))
	responses["noBody"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, nil)
	responses["directoryTarget"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"bg":"folder.png"}`))
	if !backgroundDeleteFileExists(outsidePath) {
		t.Fatal("path-separator validation deleted a file outside the backgrounds directory")
	}

	writeBackgroundFixture(t, backgroundsRoot, "malformed.png", fixture.Inputs.Files["malformed.png"])
	indexPath := filepath.Join(directories["root"], imageMetadataIndexFilename)
	if err := os.WriteFile(indexPath, []byte(fixture.Inputs.MalformedIndexBytes), 0o600); err != nil {
		t.Fatal(err)
	}
	responses["malformedIndexDelete"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"bg":"malformed.png"}`))
	malformedIndexAfter := string(mustReadFile(t, indexPath))
	malformedFileExistsAfter := backgroundDeleteFileExists(filepath.Join(backgroundsRoot, "malformed.png"))

	writeBackgroundFixture(t, backgroundsRoot, "thumbfail.png", fixture.Inputs.Files["thumbfail.png"])
	if err := os.Mkdir(filepath.Join(thumbnailRoot, "thumbfail.png"), 0o755); err != nil {
		t.Fatal(err)
	}
	thumbfailIndexBytes, err := marshalNodeJSON(fixture.Inputs.ThumbfailIndex)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, thumbfailIndexBytes, 0o600); err != nil {
		t.Fatal(err)
	}
	responses["thumbnailFailure"] = serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"bg":"thumbfail.png"}`))
	afterThumbnailFailure := struct {
		BackgroundExists     bool `json:"backgroundExists"`
		ThumbnailIsDirectory bool `json:"thumbnailIsDirectory"`
		Index                any  `json:"index"`
	}{
		BackgroundExists:     backgroundDeleteFileExists(filepath.Join(backgroundsRoot, "thumbfail.png")),
		ThumbnailIsDirectory: backgroundDeleteDirectoryExists(filepath.Join(thumbnailRoot, "thumbfail.png")),
	}
	afterThumbnailFailure.Index, err = readNormalizedBackgroundIndex(indexPath)
	if err != nil {
		t.Fatal(err)
	}

	writeBackgroundFixture(t, backgroundsRoot, "go-delete.png", fixture.Inputs.Files["go-delete.png"])
	if err := os.WriteFile(filepath.Join(thumbnailRoot, "go-delete.png"), []byte("go thumbnail"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(indexPath, []byte(fixture.Inputs.GoRoundTripIndex), 0o600); err != nil {
		t.Fatal(err)
	}
	goResponse := serve(http.MethodPost, route, sessionCookie, csrf.Token, []byte(`{"bg":"go-delete.png"}`))
	goReadback := serve(http.MethodPost, "/api/image-metadata/all", sessionCookie, csrf.Token, []byte(`{"prefix":"backgrounds/"}`))
	goRoundTrip := struct {
		GoResponse       *httptest.ResponseRecorder
		NodeReadback     *httptest.ResponseRecorder
		BackgroundExists bool
		ThumbnailExists  bool
	}{
		GoResponse:       goResponse,
		NodeReadback:     goReadback,
		BackgroundExists: backgroundDeleteFileExists(filepath.Join(backgroundsRoot, "go-delete.png")),
		ThumbnailExists:  backgroundDeleteFileExists(filepath.Join(thumbnailRoot, "go-delete.png")),
	}

	for label, got := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("backgrounds/delete fixture has no %q response", label)
		}
		assertAccountMutationResponse(t, label, got, want)
	}
	if !reflect.DeepEqual(afterDelete, fixture.State.AfterDelete) {
		t.Fatalf("background deletion state = %#v; pinned Node has %#v", afterDelete, fixture.State.AfterDelete)
	}
	if malformedIndexAfter != fixture.State.MalformedIndexAfter || malformedFileExistsAfter != fixture.State.MalformedFileExistsAfter {
		t.Fatalf("malformed-index delete state = index %q / fileExists %t; pinned Node has %q / %t", malformedIndexAfter, malformedFileExistsAfter, fixture.State.MalformedIndexAfter, fixture.State.MalformedFileExistsAfter)
	}
	if !reflect.DeepEqual(afterThumbnailFailure, fixture.State.AfterThumbnailFailure) {
		t.Fatalf("thumbnail failure state = %#v; pinned Node has %#v", afterThumbnailFailure, fixture.State.AfterThumbnailFailure)
	}
	assertAccountMutationResponse(t, "Go deletion round-trip response", goRoundTrip.GoResponse, fixture.State.GoRoundTrip.GoResponse)
	assertAccountMutationResponse(t, "Node metadata readback after Go deletion", goRoundTrip.NodeReadback, fixture.State.GoRoundTrip.NodeReadback)
	if goRoundTrip.BackgroundExists != fixture.State.GoRoundTrip.BackgroundExists || goRoundTrip.ThumbnailExists != fixture.State.GoRoundTrip.ThumbnailExists {
		t.Fatalf("Go deletion round-trip file state = background %t / thumbnail %t; pinned Node has %t / %t", goRoundTrip.BackgroundExists, goRoundTrip.ThumbnailExists, fixture.State.GoRoundTrip.BackgroundExists, fixture.State.GoRoundTrip.ThumbnailExists)
	}
	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("background deletion changed the account storage record")
	}
}

func writeBackgroundFixture(t *testing.T, directory, filename, encoded string) {
	t.Helper()
	content, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil {
		t.Fatalf("decode background fixture %q: %v", filename, err)
	}
	if err := os.WriteFile(filepath.Join(directory, filename), content, 0o600); err != nil {
		t.Fatal(err)
	}
}

func backgroundDeleteFileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func backgroundDeleteDirectoryExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}
