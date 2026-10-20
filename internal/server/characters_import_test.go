package server

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// charactersImportScenarioFixture is one recorded pinned import/edit-avatar
// scenario, including the exact multipart parts so the Go request is identical.
type charactersImportScenarioFixture struct {
	Route  string      `json:"route"`
	Fields [][2]string `json:"fields"`
	File   *struct {
		Field    string `json:"field"`
		Filename string `json:"filename"`
		BytesHex string `json:"bytesHex"`
	} `json:"file"`
	JSON                *string                  `json:"json"`
	NormalizeCreateDate bool                     `json:"normalizeCreateDate"`
	Response            characterResponseFixture `json:"response"`
	Characters          []characterTreeEntry     `json:"characters"`
}

type charactersImportFixture struct {
	charactersFixture
	Inputs struct {
		CookieSecret  string                 `json:"cookieSecret"`
		FixedMtimeMS  float64                `json:"fixedMtimeMs"`
		ExistingCards []characterCardFixture `json:"existingCards"`
	} `json:"inputs"`
	ScenarioOrder []string                                   `json:"scenarioOrder"`
	Scenarios     map[string]charactersImportScenarioFixture `json:"scenarios"`
}

// TestPinnedNodeCharactersImport compares /api/characters/import and
// /api/characters/edit-avatar against the recorded pinned oracle.
func TestPinnedNodeCharactersImport(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-characters-import.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture charactersImportFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("characters/import oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.ExistingCards) == 0 {
		t.Fatal("characters/import oracle is missing inputs")
	}

	env := newCharactersOracleEnv(t, fixture.Inputs.CookieSecret)
	if err := os.MkdirAll(env.Directories["characters"], 0o777); err != nil {
		t.Fatal(err)
	}
	fixed := time.UnixMilli(int64(fixture.Inputs.FixedMtimeMS))
	for _, card := range fixture.Inputs.ExistingCards {
		body, err := hex.DecodeString(card.BytesHex)
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(env.Directories["characters"], card.File)
		if err := os.WriteFile(target, body, 0o600); err != nil {
			t.Fatal(err)
		}
		if err := os.Chtimes(target, fixed, fixed); err != nil {
			t.Fatal(err)
		}
	}

	for _, name := range fixture.ScenarioOrder {
		scenario, exists := fixture.Scenarios[name]
		if !exists {
			t.Fatalf("characters/import oracle has no %q scenario", name)
		}
		t.Run(name, func(t *testing.T) {
			var response *httptest.ResponseRecorder
			if scenario.JSON != nil {
				response = env.serve(t, http.MethodPost, scenario.Route, "application/json", *scenario.JSON)
			} else {
				body, contentType := buildCharactersMultipart(t, scenario)
				request := httptest.NewRequest(http.MethodPost, scenario.Route, bytes.NewReader(body))
				request.Header.Set("Content-Type", contentType)
				request.Header.Set("Cookie", env.Cookie)
				request.Header.Set("X-CSRF-Token", env.Token)
				response = httptest.NewRecorder()
				env.Handler.ServeHTTP(response, request)
			}
			assertCharacterResponse(t, name, response, scenario.Response)
			assertImportCharactersTree(t, name, env.Directories["characters"], scenario.NormalizeCreateDate, scenario.Characters)
		})
	}
}

func buildCharactersMultipart(t *testing.T, scenario charactersImportScenarioFixture) ([]byte, string) {
	t.Helper()
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	for _, field := range scenario.Fields {
		if err := writer.WriteField(field[0], field[1]); err != nil {
			t.Fatal(err)
		}
	}
	if scenario.File != nil {
		body, err := hex.DecodeString(scenario.File.BytesHex)
		if err != nil {
			t.Fatal(err)
		}
		part, err := writer.CreateFormFile(scenario.File.Field, scenario.File.Filename)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := part.Write(body); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return buffer.Bytes(), writer.FormDataContentType()
}

func assertImportCharactersTree(t *testing.T, label, root string, normalizeCreateDate bool, want []characterTreeEntry) {
	t.Helper()
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatalf("%s could not read the characters directory: %v", label, err)
	}
	got := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		got = append(got, entry.Name())
	}
	names := make([]string, 0, len(want))
	for _, character := range want {
		names = append(names, character.Name)
	}
	if len(got) != len(names) {
		t.Fatalf("%s character files = %v; pinned Node has %v", label, got, names)
	}
	for index, character := range want {
		if got[index] != character.Name {
			t.Fatalf("%s character files = %v; pinned Node has %v", label, got, names)
		}
		body, err := os.ReadFile(filepath.Join(root, character.Name))
		if err != nil {
			t.Fatalf("%s could not read %s: %v", label, character.Name, err)
		}
		charaText := ""
		if text, err := readPngCardText(body); err == nil {
			charaText = normalizeWrittenCardText(text, normalizeCreateDate)
		}
		if character.CharaJSON == nil {
			if charaText != "" {
				t.Fatalf("%s %s card = %s; pinned Node has no readable card", label, character.Name, charaText)
			}
		} else if charaText != *character.CharaJSON {
			t.Fatalf("%s %s card = %s; pinned Node has %s", label, character.Name, charaText, *character.CharaJSON)
		}
		width, height, digest := pngPixels(t, body)
		if !matchesNullableInt(character.Width, width) || !matchesNullableInt(character.Height, height) {
			t.Fatalf("%s %s image = %vx%v; pinned Node has %vx%v", label, character.Name, width, height, character.Width, character.Height)
		}
		if !matchesNullableString(character.Digest, digest) {
			t.Fatalf("%s %s pixel digest = %s; pinned Node has %v", label, character.Name, digest, character.Digest)
		}
	}
}
