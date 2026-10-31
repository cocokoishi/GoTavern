package server

// CONCURRENT WRITERS TO ONE USER TREE MUST NOT CORRUPT IT, AND A CONCURRENT READER MUST NEVER
// OBSERVE A TORN FILE.
//
// The product's sensitive user-data writes are read-modify-write operations under a per-user
// content lock and are published with temp-file + fsync + rename (internal/startup). This file
// proves the PROPERTY rather than the implementation, at the routes a beta user exercises for
// months: chat save, settings save, world-info edit, preset save, and the image upload path.
//
// Every test here has the same shape:
//   - several writers hammer ONE target file with DIFFERENT complete payloads;
//   - a reader reads the target concurrently and requires every observation to be a COMPLETE
//     payload (a valid document carrying exactly one writer's marker), never a prefix;
//   - the final file must still be one writer's complete payload.
//
// The assertions are deliberately about the observable bytes, not about which lock was taken, so
// replacing the atomic replacement with a direct write (the mutation recorded beside the fix)
// makes them red instead of merely changing an implementation detail.

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

const dataSafetyCookieSecret = "data-safety-race-cookie-secret"

type dataSafetyHarness struct {
	t           *testing.T
	handler     http.Handler
	cookie      string
	csrf        string
	dataRoot    string
	installRoot string
	directories map[string]string
}

func newDataSafetyHarness(t *testing.T) *dataSafetyHarness {
	t.Helper()
	return newDataSafetyHarnessAt(t, t.TempDir())
}

// newDataSafetyHarnessAt builds the authenticated in-process handler against a caller-chosen data
// root, so a probe can place the tree under a root it also walks (path-traversal containment tests).
func newDataSafetyHarnessAt(t *testing.T, dataRoot string) *dataSafetyHarness {
	t.Helper()
	installRoot := t.TempDir()
	accountJSON, err := marshalNodeJSON(struct {
		Handle   string `json:"handle"`
		Name     string `json:"name"`
		Created  int64  `json:"created"`
		Password string `json:"password"`
		Admin    bool   `json:"admin"`
		Enabled  bool   `json:"enabled"`
		Salt     string `json:"salt"`
	}{"default-user", "Data Safety Writer", 1700000000000, "", true, true, ""})
	if err != nil {
		t.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+"default-user", accountJSON); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(dataSafetyCookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	retention := float64(2)
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: installRoot, DataRoot: dataRoot, CookieSecret: dataSafetyCookieSecret,
		AccountsEnabled: true, SettingsBackupRetention: &retention,
	})
	harness := &dataSafetyHarness{
		t: t, handler: handler, dataRoot: dataRoot, installRoot: installRoot, directories: directories,
	}
	csrfResponse := harness.serve(http.MethodGet, "/csrf-token", "", "", nil)
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
	login := harness.serve(http.MethodPost, "/api/users/login", csrfCookie, csrf.Token,
		[]byte(`{"handle":"default-user","password":""}`))
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	harness.cookie = cookieFrom(login.Header().Values("Set-Cookie"))
	harness.csrf = csrf.Token
	return harness
}

func (harness *dataSafetyHarness) serve(method, route, cookie, token string, body []byte) *httptest.ResponseRecorder {
	harness.t.Helper()
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
	harness.handler.ServeHTTP(response, request)
	return response
}

func (harness *dataSafetyHarness) post(route string, body []byte) *httptest.ResponseRecorder {
	harness.t.Helper()
	return harness.serve(http.MethodPost, route, harness.cookie, harness.csrf, body)
}

// dataSafetyObservation is one whole-file read by the concurrent reader.
type dataSafetyObservation struct {
	valid    bool
	problems []string
}

// dataSafetyReader loops over path until the writers are done. It first checks the file's SIZE
// with a stat, which is cheap enough to sample the whole write: every payload a test writes has
// the same size, so a size that is not that value is the truncation window itself (0 bytes for a
// direct truncate-and-write, or a partial prefix). Only a correctly-sized file is read and handed
// to observe, which checks it is one writer's COMPLETE document rather than a mix.
func dataSafetyReader(t *testing.T, path string, expectedSize int, done <-chan struct{}, observe func(body []byte) dataSafetyObservation) {
	t.Helper()
	for {
		select {
		case <-done:
			return
		default:
		}
		info, err := os.Stat(path)
		if err != nil {
			// The target may not exist yet, and a Windows rename can briefly fail an open; neither
			// is a torn file. A wrong SIZE is different: it is the hazard itself.
			continue
		}
		if size := int(info.Size()); size != expectedSize {
			t.Errorf("a concurrent reader observed a file of %d bytes; every writer's complete payload is %d bytes. "+
				"A size in between is the truncation window a direct write exposes.", size, expectedSize)
			return
		}
		body, err := os.ReadFile(path)
		if err != nil || len(body) != expectedSize {
			continue
		}
		observation := observe(body)
		if !observation.valid {
			t.Errorf("a concurrent reader observed a file that is not any writer's complete payload: %s",
				strings.Join(observation.problems, "; "))
			return
		}
	}
}

// jsonLinesMarker decodes every non-empty line of a JSONL file and requires all of them to carry
// the same marker. A truncated or interleaved write fails here (invalid JSON, wrong line count or
// mixed markers), which is exactly the corruption this test exists to observe.
func jsonLinesMarker(body []byte) dataSafetyObservation {
	lines := strings.Split(string(body), "\n")
	if len(lines) == 0 {
		return dataSafetyObservation{problems: []string{"file is empty"}}
	}
	marker := ""
	for index, line := range lines {
		if !json.Valid([]byte(line)) {
			return dataSafetyObservation{problems: []string{fmt.Sprintf("line %d is not valid JSON (%d bytes)", index, len(line))}}
		}
		var message struct {
			Extra struct {
				Marker string `json:"marker"`
			} `json:"extra"`
		}
		if err := json.Unmarshal([]byte(line), &message); err != nil {
			return dataSafetyObservation{problems: []string{fmt.Sprintf("line %d: %v", index, err)}}
		}
		if message.Extra.Marker == "" {
			return dataSafetyObservation{problems: []string{fmt.Sprintf("line %d has no marker", index)}}
		}
		if marker == "" {
			marker = message.Extra.Marker
			continue
		}
		if marker != message.Extra.Marker {
			return dataSafetyObservation{problems: []string{fmt.Sprintf("line %d marker %q differs from %q", index, message.Extra.Marker, marker)}}
		}
	}
	return dataSafetyObservation{valid: true}
}

func jsonDocumentMarker(body []byte, markerPath []string) dataSafetyObservation {
	if !json.Valid(body) {
		return dataSafetyObservation{problems: []string{fmt.Sprintf("document is not valid JSON (%d bytes)", len(body))}}
	}
	var document any
	if err := json.Unmarshal(body, &document); err != nil {
		return dataSafetyObservation{problems: []string{err.Error()}}
	}
	current := document
	for _, key := range markerPath {
		object, ok := current.(map[string]any)
		if !ok {
			return dataSafetyObservation{problems: []string{fmt.Sprintf("%s is not an object", key)}}
		}
		current = object[key]
	}
	marker, ok := current.(string)
	if !ok || marker == "" {
		return dataSafetyObservation{problems: []string{"marker is not a non-empty string"}}
	}
	return dataSafetyObservation{valid: true}
}

func dataSafetyBigMarker(letter string) string {
	return letter + strings.Repeat("m", 1<<20)
}

// TestChatSaveNeverPublishesATornJSONL races four writers with distinct chats at one chat file
// and requires every reader observation to be one writer's complete JSONL document.
func TestChatSaveNeverPublishesATornJSONL(t *testing.T) {
	harness := newDataSafetyHarness(t)
	chatDirectory := filepath.Join(harness.directories["chats"], "Race Card")
	if err := os.MkdirAll(chatDirectory, 0o777); err != nil {
		t.Fatal(err)
	}
	chatPath := filepath.Join(chatDirectory, "race.jsonl")

	letters := []string{"A", "B", "C", "D"}
	payloads := make(map[string][]byte, len(letters))
	for _, letter := range letters {
		marker := dataSafetyBigMarker(letter)
		messages := make([]map[string]any, 0, 3)
		for index := 0; index < 3; index++ {
			messages = append(messages, map[string]any{
				"name": "user", "is_user": true, "mes": marker,
				"extra": map[string]any{"marker": letter},
			})
		}
		body, err := json.Marshal(map[string]any{
			"avatar_url": "Race Card.png", "file_name": "race", "chat": messages,
		})
		if err != nil {
			t.Fatal(err)
		}
		payloads[letter] = body
	}

	// One complete write first, so the reader knows the exact size every writer's payload has.
	if response := harness.post("/api/chats/save", payloads["A"]); response.Code != http.StatusOK {
		t.Fatalf("seed POST /api/chats/save = %d, body %q", response.Code, response.Body.String())
	}
	seeded, err := os.ReadFile(chatPath)
	if err != nil {
		t.Fatal(err)
	}
	expectedSize := len(seeded)

	done := make(chan struct{})
	var reader sync.WaitGroup
	reader.Add(1)
	go func() {
		defer reader.Done()
		dataSafetyReader(t, chatPath, expectedSize, done, jsonLinesMarker)
	}()

	var writers sync.WaitGroup
	for _, letter := range letters {
		body := payloads[letter]
		writers.Add(1)
		go func() {
			defer writers.Done()
			for index := 0; index < 6; index++ {
				response := harness.post("/api/chats/save", body)
				if response.Code != http.StatusOK {
					t.Errorf("POST /api/chats/save = %d, body %q", response.Code, response.Body.String())
					return
				}
			}
		}()
	}
	writers.Wait()
	close(done)
	reader.Wait()

	body, err := os.ReadFile(chatPath)
	if err != nil {
		t.Fatal(err)
	}
	if observation := jsonLinesMarker(body); !observation.valid {
		t.Fatalf("the final chat file is not a complete payload: %s", strings.Join(observation.problems, "; "))
	}
}

// TestSettingsSaveNeverPublishesATornJSON races writers at one settings.json. A torn write is a
// document that does not parse, or one whose marker is not a writer's.
func TestSettingsSaveNeverPublishesATornJSON(t *testing.T) {
	harness := newDataSafetyHarness(t)
	settingsPath := filepath.Join(harness.directories["root"], "settings.json")

	letters := []string{"A", "B", "C", "D"}
	payloads := make(map[string][]byte, len(letters))
	for _, letter := range letters {
		body, err := json.Marshal(map[string]any{
			"marker": letter, "big": dataSafetyBigMarker(letter),
		})
		if err != nil {
			t.Fatal(err)
		}
		payloads[letter] = body
	}

	if response := harness.post("/api/settings/save", payloads["A"]); response.Code != http.StatusOK {
		t.Fatalf("seed POST /api/settings/save = %d, body %q", response.Code, response.Body.String())
	}
	seeded, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	expectedSize := len(seeded)

	done := make(chan struct{})
	var reader sync.WaitGroup
	reader.Add(1)
	go func() {
		defer reader.Done()
		dataSafetyReader(t, settingsPath, expectedSize, done, func(body []byte) dataSafetyObservation {
			return jsonDocumentMarker(body, []string{"marker"})
		})
	}()

	var writers sync.WaitGroup
	for _, letter := range letters {
		body := payloads[letter]
		writers.Add(1)
		go func() {
			defer writers.Done()
			for index := 0; index < 4; index++ {
				response := harness.post("/api/settings/save", body)
				if response.Code != http.StatusOK {
					t.Errorf("POST /api/settings/save = %d, body %q", response.Code, response.Body.String())
					return
				}
			}
		}()
	}
	writers.Wait()
	close(done)
	reader.Wait()

	body, err := os.ReadFile(settingsPath)
	if err != nil {
		t.Fatal(err)
	}
	if observation := jsonDocumentMarker(body, []string{"marker"}); !observation.valid {
		t.Fatalf("the final settings.json is not a complete payload: %s", strings.Join(observation.problems, "; "))
	}
}

// TestWorldInfoEditNeverPublishesATornJSON races writers at one world-info file. The marker lives
// at entries.0.content, which is where a torn pretty-printed document stops being parseable.
func TestWorldInfoEditNeverPublishesATornJSON(t *testing.T) {
	harness := newDataSafetyHarness(t)
	worldPath := filepath.Join(harness.directories["worlds"], "RaceWorld.json")

	letters := []string{"A", "B", "C"}
	payloads := make(map[string][]byte, len(letters))
	for _, letter := range letters {
		body, err := json.Marshal(map[string]any{
			"name": "RaceWorld",
			"data": map[string]any{
				"entries": map[string]any{
					"0": map[string]any{"uid": 0, "key": []string{"race"}, "content": dataSafetyBigMarker(letter)},
				},
			},
		})
		if err != nil {
			t.Fatal(err)
		}
		payloads[letter] = body
	}

	if response := harness.post("/api/worldinfo/edit", payloads["A"]); response.Code != http.StatusOK {
		t.Fatalf("seed POST /api/worldinfo/edit = %d, body %q", response.Code, response.Body.String())
	}
	seeded, err := os.ReadFile(worldPath)
	if err != nil {
		t.Fatal(err)
	}
	expectedSize := len(seeded)

	done := make(chan struct{})
	var reader sync.WaitGroup
	reader.Add(1)
	go func() {
		defer reader.Done()
		dataSafetyReader(t, worldPath, expectedSize, done, func(body []byte) dataSafetyObservation {
			if !json.Valid(body) {
				return dataSafetyObservation{problems: []string{fmt.Sprintf("world-info file is not valid JSON (%d bytes)", len(body))}}
			}
			var document struct {
				Entries map[string]struct {
					Content string `json:"content"`
				} `json:"entries"`
			}
			if err := json.Unmarshal(body, &document); err != nil {
				return dataSafetyObservation{problems: []string{err.Error()}}
			}
			if document.Entries["0"].Content == "" {
				return dataSafetyObservation{problems: []string{"entries.0.content is empty"}}
			}
			return dataSafetyObservation{valid: true}
		})
	}()

	var writers sync.WaitGroup
	for _, letter := range letters {
		body := payloads[letter]
		writers.Add(1)
		go func() {
			defer writers.Done()
			for index := 0; index < 5; index++ {
				response := harness.post("/api/worldinfo/edit", body)
				if response.Code != http.StatusOK {
					t.Errorf("POST /api/worldinfo/edit = %d, body %q", response.Code, response.Body.String())
					return
				}
			}
		}()
	}
	writers.Wait()
	close(done)
	reader.Wait()

	body, err := os.ReadFile(worldPath)
	if err != nil {
		t.Fatal(err)
	}
	if !json.Valid(body) {
		t.Fatalf("the final world-info file is not valid JSON (%d bytes)", len(body))
	}
}

// TestPresetSaveNeverPublishesATornJSON races writers at one preset file. Presets are what a
// user's model output depends on, so a truncated preset is a silent behaviour change, not a
// cosmetic problem.
func TestPresetSaveNeverPublishesATornJSON(t *testing.T) {
	harness := newDataSafetyHarness(t)
	presetPath := filepath.Join(harness.directories["openAI_Settings"], "RacePreset.json")

	letters := []string{"A", "B", "C"}
	payloads := make(map[string][]byte, len(letters))
	for _, letter := range letters {
		body, err := json.Marshal(map[string]any{
			"name": "RacePreset", "apiId": "openai",
			"preset": map[string]any{"temperature": 0.5, "marker": dataSafetyBigMarker(letter)},
		})
		if err != nil {
			t.Fatal(err)
		}
		payloads[letter] = body
	}

	if response := harness.post("/api/presets/save", payloads["A"]); response.Code != http.StatusOK {
		t.Fatalf("seed POST /api/presets/save = %d, body %q", response.Code, response.Body.String())
	}
	seeded, err := os.ReadFile(presetPath)
	if err != nil {
		t.Fatal(err)
	}
	expectedSize := len(seeded)

	done := make(chan struct{})
	var reader sync.WaitGroup
	reader.Add(1)
	go func() {
		defer reader.Done()
		dataSafetyReader(t, presetPath, expectedSize, done, func(body []byte) dataSafetyObservation {
			return jsonDocumentMarker(body, []string{"marker"})
		})
	}()

	var writers sync.WaitGroup
	for _, letter := range letters {
		body := payloads[letter]
		writers.Add(1)
		go func() {
			defer writers.Done()
			for index := 0; index < 5; index++ {
				response := harness.post("/api/presets/save", body)
				if response.Code != http.StatusOK {
					t.Errorf("POST /api/presets/save = %d, body %q", response.Code, response.Body.String())
					return
				}
			}
		}()
	}
	writers.Wait()
	close(done)
	reader.Wait()

	body, err := os.ReadFile(presetPath)
	if err != nil {
		t.Fatal(err)
	}
	if observation := jsonDocumentMarker(body, []string{"marker"}); !observation.valid {
		t.Fatalf("the final preset file is not a complete payload: %s", strings.Join(observation.problems, "; "))
	}
}

// TestImageUploadOverwriteIsNeverObservedTorn races the image write helper against a reader.
// The upload route overwrites a user's existing image by name; the reader must only ever see a
// COMPLETE image, never the truncation window a direct write exposes.
func TestImageUploadOverwriteIsNeverObservedTorn(t *testing.T) {
	directory := t.TempDir()
	target := filepath.Join(directory, "overwrite.bin")
	payloads := [][]byte{
		bytes.Repeat([]byte("A"), 2<<20),
		bytes.Repeat([]byte("B"), 2<<20),
		bytes.Repeat([]byte("C"), 2<<20),
	}
	if err := writeUserImageFile(target, payloads[0]); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	var reader sync.WaitGroup
	reader.Add(1)
	go func() {
		defer reader.Done()
		for {
			select {
			case <-done:
				return
			default:
			}
			info, err := os.Stat(target)
			if err != nil {
				// A real reader does not hold the file open in a tight loop. Go's reader opens
				// without FILE_SHARE_DELETE on Windows, so an unthrottled loop can outlast the
				// bounded rename retry (internal/fsretry) and starve the WRITER. That is a
				// property of the test's reader, not of the write path; pause like a reader.
				time.Sleep(200 * time.Microsecond)
				continue
			}
			if int(info.Size()) != len(payloads[0]) {
				t.Errorf("a concurrent reader observed an image of %d bytes; every complete payload is %d bytes",
					info.Size(), len(payloads[0]))
				return
			}
			body, err := os.ReadFile(target)
			if err != nil {
				time.Sleep(200 * time.Microsecond)
				continue
			}
			complete := false
			for _, payload := range payloads {
				if bytes.Equal(body, payload) {
					complete = true
					break
				}
			}
			if !complete {
				t.Errorf("a concurrent reader observed a torn image: %d bytes, none of the writers' payloads", len(body))
				return
			}
			time.Sleep(200 * time.Microsecond)
		}
	}()
	for index := 0; index < 30; index++ {
		if err := writeUserImageFile(target, payloads[index%len(payloads)]); err != nil {
			t.Fatalf("writeUserImageFile: %v", err)
		}
	}
	close(done)
	reader.Wait()
}
