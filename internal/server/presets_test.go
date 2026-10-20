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

	"github.com/cocokoishi/gotavern/internal/startup"
)

type presetFileState struct {
	Name    string `json:"name"`
	Content string `json:"content"`
}

type presetErrorPageFixture struct {
	Status int `json:"status"`
}

type presetsFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Normalizations []string `json:"normalizations"`
	Inputs         struct {
		CookieSecret      string            `json:"cookieSecret"`
		PresetDirectories []string          `json:"presetDirectories"`
		Bodies            map[string]string `json:"bodies"`
	} `json:"inputs"`
	Responses  map[string]accountMutationResponseFixture `json:"responses"`
	ErrorPages map[string]presetErrorPageFixture         `json:"errorPages"`
	State      struct {
		StateAfterSaves        map[string][]presetFileState `json:"stateAfterSaves"`
		StateAfterDeletes      map[string][]presetFileState `json:"stateAfterDeletes"`
		AccountRecordUnchanged bool                         `json:"accountRecordUnchanged"`
	} `json:"state"`
	RoundTrip struct {
		Verified bool `json:"verified"`
	} `json:"roundTrip"`
}

func snapshotPresetDirectories(t *testing.T, userRoot string, directories []string) map[string][]presetFileState {
	t.Helper()
	state := make(map[string][]presetFileState, len(directories))
	for _, directory := range directories {
		absolute := filepath.Join(userRoot, directory)
		names, err := os.ReadDir(absolute)
		if err != nil {
			state[directory] = nil
			continue
		}
		sorted := make([]string, 0, len(names))
		for _, entry := range names {
			sorted = append(sorted, entry.Name())
		}
		sort.Strings(sorted)
		files := make([]presetFileState, 0, len(sorted))
		for _, name := range sorted {
			body, err := os.ReadFile(filepath.Join(absolute, name))
			if err != nil {
				t.Fatal(err)
			}
			files = append(files, presetFileState{Name: name, Content: string(body)})
		}
		state[directory] = files
	}
	return state
}

func TestPinnedNodePresetRoutes(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-presets-routes.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture presetsFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("presets oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.PresetDirectories) == 0 {
		t.Fatal("presets oracle is missing inputs")
	}
	if !fixture.RoundTrip.Verified {
		t.Fatal("presets oracle did not verify the Node/Go round trip")
	}
	if len(fixture.ErrorPages) == 0 || len(fixture.Normalizations) == 0 {
		t.Fatal("presets oracle does not document its error-page normalization")
	}

	// The request bodies are pinned here independently of the fixture, and then
	// checked against the bodies the probe recorded. A body that silently changed
	// on one side only would otherwise make the recorded response the only
	// evidence for a request the test no longer sends.
	bodies := map[string]string{
		"saveMain":               `{"apiId":"openai","name":"MyPreset","preset":{"chat_completion_source":"openai","temperature":0.75,"prompts":[{"identifier":"main","content":"preset marker"}]}}`,
		"saveOverwrite":          `{"apiId":"openai","name":"MyPreset","preset":{"marker":"overwritten","unknown":{"keep":[1,2]}}}`,
		"saveKobold":             `{"apiId":"kobold","name":"KoboldPreset","preset":{"marker":"kobold"}}`,
		"saveKoboldHorde":        `{"apiId":"koboldhorde","name":"HordePreset","preset":{"marker":"horde"}}`,
		"saveNovel":              `{"apiId":"novel","name":"NovelPreset","preset":{"marker":"novel"}}`,
		"saveTextGen":            `{"apiId":"textgenerationwebui","name":"TextGenPreset","preset":{"marker":"textgen"}}`,
		"saveInstruct":           `{"apiId":"instruct","name":"MyInstruct","preset":{"marker":"instruct"}}`,
		"saveContext":            `{"apiId":"context","name":"MyContext","preset":{"marker":"context"}}`,
		"saveSysprompt":          `{"apiId":"sysprompt","name":"MySysprompt","preset":{"marker":"sysprompt"}}`,
		"saveReasoning":          `{"apiId":"reasoning","name":"MyReasoning","preset":{"marker":"reasoning"}}`,
		"saveUnknownAPI":         `{"apiId":"nope","name":"Unknown","preset":{"marker":"unknown"}}`,
		"saveMissingPreset":      `{"apiId":"openai","name":"NoPreset"}`,
		"saveFalsyPreset":        `{"apiId":"openai","name":"FalsyPreset","preset":0}`,
		"saveEmptyName":          `{"apiId":"openai","name":"","preset":{"marker":"empty"}}`,
		"saveMissingName":        `{"apiId":"openai","preset":{"marker":"missing"}}`,
		"saveNumericName":        `{"apiId":"openai","name":5,"preset":{"marker":"numeric"}}`,
		"saveArrayName":          `{"apiId":"openai","name":["a"],"preset":{"marker":"array"}}`,
		"saveNullName":           `{"apiId":"openai","name":null,"preset":{"marker":"null"}}`,
		"saveNumericAPI":         `{"apiId":5,"name":"NumericAPI","preset":{"marker":"numericapi"}}`,
		"saveReservedName":       `{"apiId":"openai","name":"con","preset":{"marker":"reserved"}}`,
		"saveSanitizedName":      `{"apiId":"openai","name":"a/b","preset":{"marker":"sanitized"}}`,
		"saveTrailingSpace":      `{"apiId":"openai","name":"Trail  ","preset":{"marker":"trailing"}}`,
		"saveNumberPreset":       `{"apiId":"openai","name":"NumberPreset","preset":5}`,
		"saveStringPreset":       `{"apiId":"openai","name":"StringPreset","preset":"text"}`,
		"saveTruePreset":         `{"apiId":"openai","name":"TruePreset","preset":true}`,
		"saveArrayPreset":        `{"apiId":"openai","name":"ArrayPreset","preset":[1,2]}`,
		"saveJsNumbers":          `{"apiId":"openai","name":"Numbers","preset":{"big":1e21,"exp":1e20,"negZero":-0,"small":1e-7,"unsafe":9007199254740993,"float":0.1}}`,
		"deleteMissingName":      `{"apiId":"openai"}`,
		"deleteEmptyName":        `{"apiId":"openai","name":""}`,
		"deleteUnknownAPI":       `{"apiId":"nope","name":"Unknown"}`,
		"deleteExisting":         `{"apiId":"openai","name":"MyPreset"}`,
		"deleteAgain":            `{"apiId":"openai","name":"MyPreset"}`,
		"deleteSanitizedName":    `{"apiId":"openai","name":"a/b"}`,
		"deleteReservedName":     `{"apiId":"openai","name":"con"}`,
		"deleteInstruct":         `{"apiId":"instruct","name":"MyInstruct"}`,
		"restoreOpenAIDefault":   `{"apiId":"openai","name":"Default"}`,
		"restoreInstructAlpaca":  `{"apiId":"instruct","name":"Alpaca"}`,
		"restoreInstructDefault": `{"apiId":"instruct","name":"Default"}`,
		"restoreWrongFolder":     `{"apiId":"openai","name":"Alpaca"}`,
		"restoreUnknownAPI":      `{"apiId":"nope","name":"Default"}`,
		"restoreSyspromptBlank":  `{"apiId":"sysprompt","name":"Blank"}`,
		"restoreReasoningBlank":  `{"apiId":"reasoning","name":"Blank"}`,
		"restoreCaseSensitive":   `{"apiId":"openai","name":"default"}`,
		"restoreMissingName":     `{"apiId":"openai"}`,
		"restoreNumericName":     `{"apiId":"openai","name":5}`,
		"restoreReservedName":    `{"apiId":"openai","name":"con"}`,
		"restoreMalformedBody":   `{`,
	}
	for label, body := range fixture.Inputs.Bodies {
		pinned, exists := bodies[label]
		if !exists {
			t.Fatalf("presets fixture records body %q that the test does not send", label)
		}
		if pinned != body {
			t.Fatalf("presets body %q = %q; the probe recorded %q", label, pinned, body)
		}
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
	}{"default-user", "Presets Probe", 1700000000000, "", true, true, "", map[string]any{"preserve": true}})
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
	userRoot := directories["root"]
	for _, directory := range fixture.Inputs.PresetDirectories {
		absolute := filepath.Join(userRoot, directory)
		if err := os.RemoveAll(absolute); err != nil {
			t.Fatal(err)
		}
		if err := os.MkdirAll(absolute, 0o777); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(userRoot, "settings.json"), []byte("{}"), 0o600); err != nil {
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
	post := func(route, body string) *httptest.ResponseRecorder {
		t.Helper()
		return serve(http.MethodPost, "/api/presets/"+route, sessionCookie, csrf.Token, body)
	}

	responses := map[string]*httptest.ResponseRecorder{}
	errorPages := map[string]*httptest.ResponseRecorder{}

	for _, label := range []string{
		"saveMain", "saveOverwrite", "saveKobold", "saveKoboldHorde", "saveNovel", "saveTextGen",
		"saveInstruct", "saveContext", "saveSysprompt", "saveReasoning", "saveUnknownAPI",
		"saveMissingPreset", "saveFalsyPreset", "saveEmptyName", "saveNumericAPI", "saveReservedName",
		"saveSanitizedName", "saveTrailingSpace", "saveNumberPreset", "saveStringPreset", "saveTruePreset",
		"saveArrayPreset", "saveJsNumbers",
	} {
		responses[label] = post("save", bodies[label])
	}
	for _, label := range []string{"saveMissingName", "saveNumericName", "saveArrayName", "saveNullName"} {
		errorPages[label] = post("save", bodies[label])
	}
	stateAfterSaves := snapshotPresetDirectories(t, userRoot, fixture.Inputs.PresetDirectories)

	for _, label := range []string{
		"deleteEmptyName", "deleteUnknownAPI", "deleteExisting", "deleteAgain",
		"deleteSanitizedName", "deleteReservedName", "deleteInstruct",
	} {
		responses[label] = post("delete", bodies[label])
	}
	// sanitize-filename throws for the absent name before the route's own name
	// check, so the pinned server answers its error page rather than a 404.
	errorPages["deleteMissingName"] = post("delete", bodies["deleteMissingName"])
	responses["deleteWrongMethod"] = serve(http.MethodGet, "/api/presets/delete", sessionCookie, "", "")
	stateAfterDeletes := snapshotPresetDirectories(t, userRoot, fixture.Inputs.PresetDirectories)

	for _, label := range []string{
		"restoreOpenAIDefault", "restoreInstructAlpaca", "restoreInstructDefault", "restoreWrongFolder",
		"restoreUnknownAPI", "restoreSyspromptBlank", "restoreReasoningBlank", "restoreCaseSensitive",
		"restoreReservedName", "restoreMissingName", "restoreNumericName",
	} {
		responses[label] = post("restore", bodies[label])
	}
	responses["restoreUnknownMethod"] = serve(http.MethodGet, "/api/presets/restore", sessionCookie, "", "")
	// The JSON body parser rejects a malformed body with its own 400 error page.
	errorPages["restoreMalformedBody"] = post("restore", bodies["restoreMalformedBody"])

	for label, response := range responses {
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("presets fixture has no %q response", label)
		}
		assertAccountMutationResponse(t, label, response, want)
	}
	for label, response := range errorPages {
		want, exists := fixture.ErrorPages[label]
		if !exists {
			t.Fatalf("presets fixture has no %q error page", label)
		}
		if response.Code != want.Status {
			t.Fatalf("%s status = %d; pinned Node has %d", label, response.Code, want.Status)
		}
	}
	if len(fixture.Responses) != len(responses) || len(fixture.ErrorPages) != len(errorPages) {
		t.Fatalf("presets fixture records %d responses and %d error pages; the test sent %d and %d",
			len(fixture.Responses), len(fixture.ErrorPages), len(responses), len(errorPages))
	}
	for _, compare := range []struct {
		label string
		got   map[string][]presetFileState
		want  map[string][]presetFileState
	}{
		{"stateAfterSaves", stateAfterSaves, fixture.State.StateAfterSaves},
		{"stateAfterDeletes", stateAfterDeletes, fixture.State.StateAfterDeletes},
	} {
		if !reflect.DeepEqual(compare.got, compare.want) {
			t.Fatalf("presets state %s = %+v; pinned Node has %+v", compare.label, compare.got, compare.want)
		}
	}

	accountRecordAfter, err := os.ReadFile(accountRecordPath)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(accountRecordBefore, accountRecordAfter) || !fixture.State.AccountRecordUnchanged {
		t.Fatal("preset mutations changed the account storage record")
	}
}
