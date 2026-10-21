package server

// Replay of the pinned sprite upload routes against tests/oracle/sillytavern-1.19.0-sprites.json
// (recorded by tools/probe-sprites.mjs).
//
// Every request is rebuilt from the fixture's recorded PARTS (order, name, filename, content type,
// bytes), so multipart ordering and per-part headers are part of the test rather than incidental.
// Each step compares the response fields and the whole characters tree (path/kind/size/SHA-256), so
// a replacement is only proven when the old file is absent AND the new bytes are present.

import (
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"
)

type spritesFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret string           `json:"cookieSecret"`
		Account      sdFixtureAccount `json:"account"`
		Steps        []spritesInput   `json:"steps"`
	} `json:"inputs"`
	Observations map[string]spritesObservation `json:"observations"`
}

type spritesInput struct {
	Name     string        `json:"name"`
	Route    string        `json:"route"`
	Boundary string        `json:"boundary"`
	Parts    []spritesPart `json:"parts"`
}

type spritesPart struct {
	Name        string  `json:"name"`
	Filename    *string `json:"filename"`
	ContentType *string `json:"contentType"`
	BytesBase64 string  `json:"bytesBase64"`
}

type spritesObservation struct {
	Status        int              `json:"status"`
	ContentType   *string          `json:"contentType"`
	ContentLength *string          `json:"contentLength"`
	Etag          *string          `json:"etag"`
	BodyBase64    string           `json:"bodyBase64"`
	BodySha256    string           `json:"bodySha256"`
	BodyLength    int              `json:"bodyLength"`
	Comparison    searchComparison `json:"comparison"`
	Tree          struct {
		Characters []userDataEntry `json:"characters"`
	} `json:"tree"`
}

func TestPinnedNodeSpritesUpload(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-sprites.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture spritesFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("sprites oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Inputs.Steps) != len(fixture.Observations) || len(fixture.Inputs.Steps) == 0 {
		t.Fatalf("sprites oracle has %d steps and %d observations", len(fixture.Inputs.Steps), len(fixture.Observations))
	}
	verifySpritesClassification(t, fixture)
	verifySpritesDiscriminating(t, fixture)

	dataRoot := t.TempDir()
	handler, sessionCookie, token := newSDRouteHandler(t, dataRoot, t.TempDir(), fixture.Inputs.CookieSecret, fixture.Inputs.Account)
	userRoot := userRootPath(dataRoot)
	seedSpritesTree(t, userRoot)

	for _, step := range fixture.Inputs.Steps {
		name := step.Name
		observation, exists := fixture.Observations[name]
		if !exists {
			t.Fatalf("%s: no recorded observation", name)
		}
		body := buildSpritesMultipart(step)
		request := httptest.NewRequest(http.MethodPost, "/api/sprites/"+step.Route, strings.NewReader(string(body)))
		request.Header.Set("Content-Type", "multipart/form-data; boundary="+step.Boundary)
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		compareSpritesResponse(t, name, observation, recorder)
		snapshot := make([]userDataEntry, 0)
		walkUserDataTree(t, filepath.Join(userRoot, "characters"), "", &snapshot)
		sort.Slice(snapshot, func(left, right int) bool { return snapshot[left].Path < snapshot[right].Path })
		compareUserDataTree(t, name, observation.Tree.Characters, snapshot)
	}
}

func seedSpritesTree(t *testing.T, userRoot string) {
	t.Helper()
	for relative, content := range map[string]string{
		"characters/SpriteChar/joy.png":     "OLD-JOY-PNG",
		"characters/SpriteChar/joy.webp":    "OLD-JOY-WEBP",
		"characters/SpriteChar/custom.webp": "OLD-CUSTOM",
		"characters/SpriteChar/keep.png":    "KEEP",
	} {
		target := filepath.Join(userRoot, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, []byte(content), 0o666); err != nil {
			t.Fatal(err)
		}
		fixed := time.Unix(1700000000, 0)
		if err := os.Chtimes(target, fixed, fixed); err != nil {
			t.Fatal(err)
		}
	}
}

func buildSpritesMultipart(step spritesInput) []byte {
	var builder strings.Builder
	for _, part := range step.Parts {
		builder.WriteString("--" + step.Boundary + "\r\n")
		disposition := "Content-Disposition: form-data; name=\"" + part.Name + "\""
		if part.Filename != nil {
			disposition += "; filename=\"" + *part.Filename + "\""
		}
		builder.WriteString(disposition + "\r\n")
		if part.ContentType != nil {
			builder.WriteString("Content-Type: " + *part.ContentType + "\r\n")
		}
		builder.WriteString("\r\n")
		content, _ := base64.StdEncoding.DecodeString(part.BytesBase64)
		builder.Write(content)
		builder.WriteString("\r\n")
	}
	builder.WriteString("--" + step.Boundary + "--\r\n")
	return []byte(builder.String())
}

func verifySpritesClassification(t *testing.T, fixture spritesFixture) {
	t.Helper()
	for name, observation := range fixture.Observations {
		classified := map[string]bool{}
		for _, key := range observation.Comparison.Compared {
			classified[key] = true
		}
		for _, key := range observation.Comparison.Shape {
			classified[key] = true
			if strings.TrimSpace(observation.Comparison.ShapeReason[key]) == "" {
				t.Fatalf("%s: shape field %q has no reason", name, key)
			}
		}
		for _, key := range []string{"status", "contentType", "contentLength", "etag", "bodyBase64", "bodySha256", "bodyLength", "tree"} {
			if !classified[key] {
				t.Fatalf("%s: observable %q is neither compared nor shape-classified", name, key)
			}
		}
	}
}

// verifySpritesDiscriminating refuses to run unless the fixture can fail: it must contain a real
// deletion, a real creation, a 400, a 500 and a zip count response.
func verifySpritesDiscriminating(t *testing.T, fixture spritesFixture) {
	t.Helper()
	previous := map[string]bool{}
	deletions := 0
	creations := 0
	sawBadRequest := false
	sawServerError := false
	sawCount := false
	for _, name := range sortedKeys(fixture.Observations) {
		observation := fixture.Observations[name]
		current := map[string]bool{}
		for _, entry := range observation.Tree.Characters {
			if entry.Kind != "file" {
				continue
			}
			current[entry.Path] = true
			if !previous[entry.Path] {
				creations++
			}
		}
		for existing := range previous {
			if !current[existing] {
				deletions++
			}
		}
		previous = current
		if observation.Status == 400 {
			sawBadRequest = true
		}
		if observation.Status == 500 {
			sawServerError = true
		}
		if strings.Contains(string(observation.BodyBase64), "Y291bnQ") || strings.Contains(decodeForCheck(observation.BodyBase64), "\"count\"") {
			sawCount = true
		}
	}
	if deletions == 0 || creations == 0 || !sawBadRequest || !sawServerError || !sawCount {
		t.Fatalf("sprites fixture is not discriminating: deletions=%d creations=%d 400=%v 500=%v count=%v",
			deletions, creations, sawBadRequest, sawServerError, sawCount)
	}
}

func decodeForCheck(value string) string {
	decoded, _ := base64.StdEncoding.DecodeString(value)
	return string(decoded)
}

func compareSpritesResponse(t *testing.T, name string, observation spritesObservation, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if recorder.Code != observation.Status {
		t.Fatalf("%s: status = %d, pinned Node has %d (body %q)", name, recorder.Code, observation.Status, recorder.Body.String())
	}
	compareOptionalHeader(t, name, "content-type", observation.ContentType, recorder.Header().Get("Content-Type"))
	compareOptionalHeader(t, name, "content-length", observation.ContentLength, recorder.Header().Get("Content-Length"))
	compareOptionalHeader(t, name, "etag", observation.Etag, recorder.Header().Get("ETag"))
	body := recorder.Body.Bytes()
	if len(body) != observation.BodyLength {
		t.Fatalf("%s: body length = %d, pinned Node has %d", name, len(body), observation.BodyLength)
	}
	if encodeBase64ForTest(body) != observation.BodyBase64 {
		t.Fatalf("%s: body base64 differs from pinned Node", name)
	}
	if sha256ForTest(body) != observation.BodySha256 {
		t.Fatalf("%s: body SHA-256 differs from pinned Node", name)
	}
}
