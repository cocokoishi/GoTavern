package server

import (
	"bytes"
	"encoding/json"
	"mime/multipart"
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

type worldInfoWorldState struct {
	Name    string  `json:"name"`
	Kind    string  `json:"kind"`
	Content *string `json:"content"`
}

type worldInfoErrorPageFixture struct {
	Status int `json:"status"`
}

type worldInfoImportCaseFixture struct {
	Fields [][]string `json:"fields"`
	File   *struct {
		Filename string `json:"filename"`
		Content  string `json:"content"`
	} `json:"file"`
	Body *string `json:"body"`
}

type worldInfoFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Normalizations []string `json:"normalizations"`
	Inputs         struct {
		CookieSecret    string                                `json:"cookieSecret"`
		SeededWorlds    map[string]string                     `json:"seededWorlds"`
		SeededDirectory string                                `json:"seededDirectory"`
		EditCreated     string                                `json:"editCreated"`
		EditNumericKeys string                                `json:"editNumericKeys"`
		EditOverwrite   string                                `json:"editOverwrite"`
		ImportedWorld   string                                `json:"importedWorld"`
		ImportCases     map[string]worldInfoImportCaseFixture `json:"importCases"`
	} `json:"inputs"`
	Responses  map[string]accountMutationResponseFixture `json:"responses"`
	ErrorPages map[string]worldInfoErrorPageFixture      `json:"errorPages"`
	State      struct {
		WorldsAfterEdits       []worldInfoWorldState `json:"worldsAfterEdits"`
		WorldsAfterImports     []worldInfoWorldState `json:"worldsAfterImports"`
		WorldsAfterDeletes     []worldInfoWorldState `json:"worldsAfterDeletes"`
		UploadsAfterImport     map[string]*int       `json:"uploadsAfterImport"`
		AccountRecordUnchanged bool                  `json:"accountRecordUnchanged"`
	} `json:"state"`
	RoundTrip struct {
		Verified bool `json:"verified"`
	} `json:"roundTrip"`
}

// snapshotWorldInfoWorlds mirrors the probe's worlds snapshot: names sorted,
// kind and exact bytes recorded, never sizes or mtimes.
func snapshotWorldInfoWorlds(t *testing.T, root string) []worldInfoWorldState {
	t.Helper()
	names, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	sorted := make([]string, 0, len(names))
	for _, entry := range names {
		sorted = append(sorted, entry.Name())
	}
	sort.Strings(sorted)
	states := make([]worldInfoWorldState, 0, len(sorted))
	for _, name := range sorted {
		info, err := os.Stat(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		state := worldInfoWorldState{Name: name, Kind: "other"}
		switch {
		case info.Mode().IsRegular():
			state.Kind = "file"
			body, err := os.ReadFile(filepath.Join(root, name))
			if err != nil {
				t.Fatal(err)
			}
			content := string(body)
			state.Content = &content
		case info.IsDir():
			state.Kind = "directory"
		}
		states = append(states, state)
	}
	return states
}

func countWorldInfoUploads(t *testing.T, root string) *int {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil
	}
	count := len(entries)
	return &count
}

// worldInfoMultipartBody builds the multer-shaped multipart request the pinned
// frontend sends: text fields first, then the single `avatar` file part.
func worldInfoMultipartBody(t *testing.T, fields [][]string, filename, content string) (string, []byte) {
	t.Helper()
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	for _, field := range fields {
		if err := writer.WriteField(field[0], field[1]); err != nil {
			t.Fatal(err)
		}
	}
	if filename != "" {
		part, err := writer.CreateFormFile("avatar", filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return writer.FormDataContentType(), body.Bytes()
}

func TestPinnedNodeWorldInfoRoutes(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-worldinfo-routes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture worldInfoFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("world-info oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.SeededWorlds) == 0 || fixture.Inputs.ImportedWorld == "" {
		t.Fatal("world-info oracle is missing inputs")
	}
	if !fixture.RoundTrip.Verified {
		t.Fatal("world-info oracle did not verify the Node/Go round trip")
	}
	// The oracle only records a status for a thrown-error response, because the
	// Express error page embeds a V8 stack with host-absolute paths. Assert that
	// the fixture says so instead of silently carrying an empty observation.
	if len(fixture.ErrorPages) == 0 || len(fixture.Normalizations) == 0 {
		t.Fatal("world-info oracle does not document its error-page normalization")
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
	}{"default-user", "World Info Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	// The pinned server creates DATA_ROOT/_uploads when it constructs its multer
	// instance; startup.InitializeDataStartup does the same for GoTavern. This
	// test drives the HTTP handler directly, so it seeds that precondition the
	// way the other upload tests do.
	if err := os.MkdirAll(filepath.Join(dataRoot, "_uploads"), 0o777); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	worldsRoot := directories["worlds"]
	if err := os.RemoveAll(worldsRoot); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(worldsRoot, 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(worldsRoot, fixture.Inputs.SeededDirectory), 0o777); err != nil {
		t.Fatal(err)
	}
	for name, content := range fixture.Inputs.SeededWorlds {
		if err := os.WriteFile(filepath.Join(worldsRoot, name), []byte(content), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(directories["root"], "settings.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}

	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: fixture.Inputs.CookieSecret, AccountsEnabled: true,
	})
	serve := func(method, route, cookie, token, contentType string, body []byte) *httptest.ResponseRecorder {
		t.Helper()
		var reader *bytes.Reader
		if body == nil {
			reader = bytes.NewReader(nil)
		} else {
			reader = bytes.NewReader(body)
		}
		request := httptest.NewRequest(method, route, reader)
		if cookie != "" {
			request.Header.Set("Cookie", cookie)
		}
		if token != "" {
			request.Header.Set("X-CSRF-Token", token)
		}
		if contentType != "" {
			request.Header.Set("Content-Type", contentType)
		}
		response := httptest.NewRecorder()
		handler.ServeHTTP(response, request)
		return response
	}
	csrfResponse := serve(http.MethodGet, "/csrf-token", "", "", "", nil)
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
	login := serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token, "application/json", []byte(`{"handle":"default-user","password":""}`))
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	sessionCookie := cookieFrom(login.Header().Values("Set-Cookie"))

	post := func(route, body string) *httptest.ResponseRecorder {
		t.Helper()
		return serve(http.MethodPost, "/api/worldinfo/"+route, sessionCookie, csrf.Token, "application/json", []byte(body))
	}
	jsonBody := func(value any) string {
		t.Helper()
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}

	responses := map[string]*httptest.ResponseRecorder{}
	errorPages := map[string]*httptest.ResponseRecorder{}
	record := func(label string, response *httptest.ResponseRecorder) {
		t.Helper()
		responses[label] = response
	}
	recordErrorPage := func(label string, response *httptest.ResponseRecorder) {
		t.Helper()
		errorPages[label] = response
	}

	// ---- /list -------------------------------------------------------------
	record("listMain", post("list", jsonBody(map[string]any{})))
	record("listWrongMethod", serve(http.MethodGet, "/api/worldinfo/list", sessionCookie, "", "", nil))
	record("listWrongMethodHead", serve(http.MethodHead, "/api/worldinfo/list", sessionCookie, "", "", nil))

	// ---- /get --------------------------------------------------------------
	record("getAlpha", post("get", `{"name":"alpha"}`))
	record("getMissingFile", post("get", `{"name":"missing"}`))
	record("getEmptyName", post("get", `{"name":""}`))
	record("getAbsentName", post("get", `{}`))
	record("getNameNumber", post("get", `{"name":123}`))
	record("getNameArray", post("get", `{"name":["a","b"]}`))
	record("getNameObject", post("get", `{"name":{"a":1}}`))
	record("getNameWithSlash", post("get", `{"name":"a/b"}`))
	record("getNameWithExtension", post("get", `{"name":"alpha.json"}`))
	record("getTextual", post("get", `{"name":"textual"}`))
	record("getNull", post("get", `{"name":"nothing"}`))
	record("getBoolean", post("get", `{"name":"boolean"}`))
	record("getNumericStatus", post("get", `{"name":"numeric"}`))
	recordErrorPage("getInvalidJson", post("get", `{"name":"delta"}`))
	recordErrorPage("getSanitizedToEmpty", post("get", `{"name":"con"}`))
	recordErrorPage("getInvalidNumber", post("get", `{"name":"invalid-number"}`))
	recordErrorPage("getMalformedBody", post("get", `{`))
	recordErrorPage("getNonObjectBody", post("get", `5`))
	record("getNonJsonContentType", serve(http.MethodPost, "/api/worldinfo/get", sessionCookie, csrf.Token, "text/plain", []byte(`{"name":"alpha"}`)))
	record("getPlusJSONContentType", serve(http.MethodPost, "/api/worldinfo/get", sessionCookie, csrf.Token, "application/vnd.api+json", []byte(`{"name":"alpha"}`)))
	record("getNoBody", serve(http.MethodPost, "/api/worldinfo/get", sessionCookie, csrf.Token, "application/json", nil))
	record("getWrongMethod", serve(http.MethodGet, "/api/worldinfo/get", sessionCookie, "", "", nil))

	// ---- /edit -------------------------------------------------------------
	record("editCreate", post("edit", fixture.Inputs.EditCreated))
	record("editNumericKeys", post("edit", fixture.Inputs.EditNumericKeys))
	record("editOverwrite", post("edit", fixture.Inputs.EditOverwrite))
	record("editAbsentName", post("edit", `{"data":{"entries":{}}}`))
	record("editEmptyName", post("edit", `{"name":"","data":{"entries":{}}}`))
	record("editMissingData", post("edit", `{"name":"x"}`))
	record("editNullData", post("edit", `{"name":"x","data":null}`))
	record("editArrayData", post("edit", `{"name":"x","data":[]}`))
	record("editStringData", post("edit", `{"name":"x","data":"str"}`))
	record("editMissingEntries", post("edit", `{"name":"x","data":{"notEntries":true}}`))
	record("editSanitizedName", post("edit", `{"name":"a/b","data":{"entries":{}}}`))
	record("editNameNumber", post("edit", `{"name":123,"data":{"entries":{}}}`))
	recordErrorPage("editMalformedBody", post("edit", `not json`))
	record("editWrongMethod", serve(http.MethodGet, "/api/worldinfo/edit", sessionCookie, "", "", nil))

	worldsAfterEdits := snapshotWorldInfoWorlds(t, worldsRoot)

	// ---- /import -----------------------------------------------------------
	importCases := []struct {
		label    string
		fields   [][]string
		filename string
		content  string
		jsonBody string
	}{
		{label: "importNoFile", jsonBody: `{}`},
		{label: "importValid", filename: "imported.json", content: fixture.Inputs.ImportedWorld},
		{label: "importDottedName", filename: "my.world.json", content: `{"entries":{}}`},
		{label: "importSlashName", filename: "a/b.json", content: `{"entries":{}}`},
		{label: "importEmptySanitizedName", filename: "con.json", content: `{"entries":{}}`},
		{label: "importTextExtension", filename: "notes.txt", content: `{"entries":{"0":{"uid":0}}}`},
		{label: "importMissingEntries", filename: "noentries.json", content: `{"foo":1}`},
		{label: "importArrayContent", filename: "arraycontent.json", content: `[1,2]`},
		{label: "importInvalidJson", filename: "broken.json", content: `not json`},
		{label: "importConvertedData", fields: [][]string{{"convertedData", `{"entries":{"0":{"uid":0,"content":"converted"}}}`}}, filename: "converted.json", content: `{"entries":{}}`},
		{label: "importConvertedDataInvalid", fields: [][]string{{"convertedData", `not json`}}, filename: "converted-bad.json", content: `{"entries":{}}`},
		{label: "importEmptyConvertedData", fields: [][]string{{"convertedData", ``}}, filename: "converted-empty.json", content: `{"entries":{"0":{"uid":0}}}`},
	}
	uploadsAfterImport := map[string]*int{}
	for _, importCase := range importCases {
		var response *httptest.ResponseRecorder
		if importCase.jsonBody != "" {
			response = post("import", importCase.jsonBody)
		} else {
			contentType, body := worldInfoMultipartBody(t, importCase.fields, importCase.filename, importCase.content)
			response = serve(http.MethodPost, "/api/worldinfo/import", sessionCookie, csrf.Token, contentType, body)
		}
		responses[importCase.label] = response
		uploadsAfterImport[importCase.label] = countWorldInfoUploads(t, filepath.Join(dataRoot, "_uploads"))
	}

	worldsAfterImports := snapshotWorldInfoWorlds(t, worldsRoot)

	// ---- /delete -----------------------------------------------------------
	record("deleteAbsentName", post("delete", `{}`))
	record("deleteSanitizedName", post("delete", `{"name":"al/pha"}`))
	recordErrorPage("deleteAlphaGone", post("delete", `{"name":"alpha"}`))
	record("deleteCharlie", post("delete", `{"name":"charlie"}`))
	recordErrorPage("deleteMissingFile", post("delete", `{"name":"missing"}`))
	record("deleteWrongMethod", serve(http.MethodGet, "/api/worldinfo/delete", sessionCookie, "", "", nil))

	// The deprecated aliases answer a method-preserving 308 without reaching the
	// destination route.
	record("legacyGetRedirect", serve(http.MethodPost, "/getworldinfo", sessionCookie, csrf.Token, "application/json", []byte(`{"name":"alpha"}`)))
	record("legacyEditRedirect", serve(http.MethodPost, "/editworldinfo", sessionCookie, csrf.Token, "application/json", []byte(`{"name":"legacy","data":{"entries":{}}}`)))
	record("legacyDeleteRedirect", serve(http.MethodPost, "/deleteworldinfo", sessionCookie, csrf.Token, "application/json", []byte(`{"name":"legacy"}`)))
	record("legacyImportRedirect", serve(http.MethodPost, "/importworldinfo", sessionCookie, csrf.Token, "application/json", []byte(`{}`)))

	worldsAfterDeletes := snapshotWorldInfoWorlds(t, worldsRoot)

	for label, response := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("world-info fixture has no %q response", label)
		}
		assertAccountMutationResponse(t, label, response, want)
	}
	for label, response := range errorPages {
		want, exists := fixture.ErrorPages[label]
		if !exists {
			t.Fatalf("world-info fixture has no %q error page", label)
		}
		if response.Code != want.Status {
			t.Fatalf("%s status = %d; pinned Node has %d", label, response.Code, want.Status)
		}
	}
	for _, compare := range []struct {
		label string
		got   []worldInfoWorldState
		want  []worldInfoWorldState
	}{
		{"worldsAfterEdits", worldsAfterEdits, fixture.State.WorldsAfterEdits},
		{"worldsAfterImports", worldsAfterImports, fixture.State.WorldsAfterImports},
		{"worldsAfterDeletes", worldsAfterDeletes, fixture.State.WorldsAfterDeletes},
	} {
		if !reflect.DeepEqual(compare.got, compare.want) {
			t.Fatalf("world-info state %s = %+v; pinned Node has %+v", compare.label, compare.got, compare.want)
		}
	}
	if len(fixture.State.UploadsAfterImport) != len(uploadsAfterImport) {
		t.Fatalf("world-info upload counts cover %d cases; pinned Node has %d", len(uploadsAfterImport), len(fixture.State.UploadsAfterImport))
	}
	for label, got := range uploadsAfterImport {
		want, exists := fixture.State.UploadsAfterImport[label]
		if !exists {
			t.Fatalf("world-info fixture has no %q upload count", label)
		}
		if (got == nil) != (want == nil) || (got != nil && *got != *want) {
			t.Fatalf("%s staged uploads = %v; pinned Node has %v", label, got, want)
		}
	}

	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("world-info mutations changed the account storage record")
	}
}
