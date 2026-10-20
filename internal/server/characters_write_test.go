package server

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"image"
	"image/draw"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"testing"
	"time"
)

// characterTreeEntry is one file in a recorded characters-directory snapshot.
type characterTreeEntry struct {
	Name      string  `json:"name"`
	CharaJSON *string `json:"charaJSON"`
	Width     *int    `json:"width"`
	Height    *int    `json:"height"`
	Digest    *string `json:"digest"`
}

// charactersWriteScenarioFixture is one recorded pinned write-route scenario.
type charactersWriteScenarioFixture struct {
	Route               string                   `json:"route"`
	Request             string                   `json:"request"`
	Binary              bool                     `json:"binary"`
	NormalizeCreateDate bool                     `json:"normalizeCreateDate"`
	Response            characterResponseFixture `json:"response"`
	ResponseSHA256      *string                  `json:"responseSha256"`
	ResponseCharaJSON   *string                  `json:"responseCharaJSON"`
	Characters          []characterTreeEntry     `json:"characters"`
	Chats               []struct {
		Path   string  `json:"path"`
		Kind   string  `json:"kind"`
		SHA256 *string `json:"sha256"`
	} `json:"chats"`
}

type charactersWriteFixture struct {
	charactersFixture
	ScenarioOrder []string                                  `json:"scenarioOrder"`
	Scenarios     map[string]charactersWriteScenarioFixture `json:"scenarios"`
}

var (
	humanizedDateTimePattern = regexp.MustCompile(`\d{4}-\d{2}-\d{2}@\d{2}h\d{2}m\d{2}s\d{3}ms`)
	createDatePattern        = regexp.MustCompile(`"create_date":"[^"]*"`)
)

func normalizeWrittenCardText(text string, normalizeCreateDate bool) string {
	normalized := humanizedDateTimePattern.ReplaceAllString(text, "<humanizedDateTime>")
	if normalizeCreateDate {
		normalized = createDatePattern.ReplaceAllString(normalized, `"create_date":"<isoDate>"`)
	}
	return normalized
}

// TestPinnedNodeCharactersWrite compares every pinned character mutation route
// against the recorded oracle, including the resulting characters and chats
// trees.
func TestPinnedNodeCharactersWrite(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-characters-write.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture charactersWriteFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("characters/write oracle baseline = %+v", fixture.Baseline)
	}
	if fixture.Inputs.CookieSecret == "" || len(fixture.Inputs.Cards) == 0 {
		t.Fatal("characters/write oracle is missing inputs")
	}

	env := newCharactersOracleEnv(t, fixture.Inputs.CookieSecret)
	env.writeFixtureCards(t, fixture.charactersFixture)
	if err := os.MkdirAll(env.Directories["worlds"], 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(env.Directories["worlds"], "AliceWorld.json"), fixture.Inputs.WorldInfo, 0o600); err != nil {
		t.Fatal(err)
	}
	fixed := time.UnixMilli(int64(fixture.Inputs.FixedMtimeMS))
	for _, character := range fixture.Inputs.ChatCharacters {
		directory := filepath.Join(env.Directories["chats"], character)
		if err := os.MkdirAll(directory, 0o777); err != nil {
			t.Fatal(err)
		}
		for name, body := range fixture.Inputs.ChatFiles {
			target := filepath.Join(directory, name)
			if err := os.WriteFile(target, []byte(body), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.Chtimes(target, fixed, fixed); err != nil {
				t.Fatal(err)
			}
		}
	}

	for _, name := range fixture.ScenarioOrder {
		scenario, exists := fixture.Scenarios[name]
		if !exists {
			t.Fatalf("characters/write oracle has no %q scenario", name)
		}
		t.Run(name, func(t *testing.T) {
			response := env.serve(t, http.MethodPost, scenario.Route, "application/json", scenario.Request)
			if scenario.Binary {
				// Binary bodies are compared by digest below; the raw response
				// text is not a stable comparison for invalid UTF-8.
				assertCharacterHeaders(t, name, response, scenario.Response)
			} else {
				assertCharacterResponse(t, name, response, scenario.Response)
			}

			if scenario.ResponseSHA256 != nil {
				digest := sha256.Sum256(response.Body.Bytes())
				if got := hex.EncodeToString(digest[:]); got != *scenario.ResponseSHA256 {
					t.Fatalf("%s response PNG sha256 = %s; pinned Node has %s", name, got, *scenario.ResponseSHA256)
				}
				if scenario.ResponseCharaJSON != nil {
					text, err := readPngCardText(response.Body.Bytes())
					if err != nil {
						t.Fatalf("%s response is not a readable card: %v", name, err)
					}
					if got := normalizeWrittenCardText(text, scenario.NormalizeCreateDate); got != *scenario.ResponseCharaJSON {
						t.Fatalf("%s response card = %s; pinned Node has %s", name, got, *scenario.ResponseCharaJSON)
					}
				}
			}

			assertCharactersTree(t, name, env.Directories["characters"], scenario)
			assertChatsTree(t, name, env.Directories["chats"], scenario)
		})
	}
}

// assertCharactersTree compares the characters directory against the pinned
// snapshot: file set, decoded card JSON, image dimensions and pixel digest.
func assertCharactersTree(t *testing.T, label, root string, scenario charactersWriteScenarioFixture) {
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
	want := make([]string, 0, len(scenario.Characters))
	for _, character := range scenario.Characters {
		want = append(want, character.Name)
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("%s character files = %v; pinned Node has %v", label, got, want)
	}
	for _, character := range scenario.Characters {
		filePath := filepath.Join(root, character.Name)
		body, err := os.ReadFile(filePath)
		if err != nil {
			t.Fatalf("%s could not read %s: %v", label, character.Name, err)
		}
		var charaText string
		if text, err := readPngCardText(body); err == nil {
			charaText = normalizeWrittenCardText(text, scenario.NormalizeCreateDate)
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

func assertChatsTree(t *testing.T, label, root string, scenario charactersWriteScenarioFixture) {
	t.Helper()
	entries := make([]string, 0)
	var visit func(string, string)
	visit = func(directory, prefix string) {
		names, err := os.ReadDir(directory)
		if err != nil {
			return
		}
		sorted := make([]string, 0, len(names))
		for _, entry := range names {
			sorted = append(sorted, entry.Name())
		}
		sort.Strings(sorted)
		for _, name := range sorted {
			filePath := filepath.Join(directory, name)
			relative := name
			if prefix != "" {
				relative = prefix + "/" + name
			}
			info, err := os.Stat(filePath)
			if err != nil {
				continue
			}
			if info.IsDir() {
				entries = append(entries, relative+"/|directory|")
				visit(filePath, relative)
				continue
			}
			body, err := os.ReadFile(filePath)
			if err != nil {
				continue
			}
			digest := sha256.Sum256(body)
			entries = append(entries, relative+"|file|"+hex.EncodeToString(digest[:]))
		}
	}
	visit(root, "")
	want := make([]string, 0, len(scenario.Chats))
	for _, entry := range scenario.Chats {
		digest := ""
		if entry.SHA256 != nil {
			digest = *entry.SHA256
		}
		want = append(want, entry.Path+"|"+entry.Kind+"|"+digest)
	}
	if strings.Join(entries, "\n") != strings.Join(want, "\n") {
		t.Fatalf("%s chats tree differs from the pinned oracle:\n got: %v\nwant: %v", label, entries, want)
	}
}

func pngPixels(t *testing.T, body []byte) (int, int, string) {
	t.Helper()
	decoded, err := png.Decode(strings.NewReader(string(body)))
	if err != nil {
		return 0, 0, ""
	}
	bounds := decoded.Bounds()
	target := image.NewNRGBA(image.Rect(0, 0, bounds.Dx(), bounds.Dy()))
	draw.Draw(target, target.Bounds(), decoded, bounds.Min, draw.Src)
	digest := sha256.Sum256(target.Pix)
	return bounds.Dx(), bounds.Dy(), hex.EncodeToString(digest[:])
}

func matchesNullableInt(want *int, got int) bool {
	if want == nil {
		return got == 0
	}
	return *want == got
}

func matchesNullableString(want *string, got string) bool {
	if want == nil {
		return got == ""
	}
	return *want == got
}
