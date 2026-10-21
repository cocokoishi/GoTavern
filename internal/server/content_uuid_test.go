package server

// Replay of the pinned /api/content/importUUID AICC branch plus the source-derived UUID classifier
// and the 501 dispatch for every unimplemented provider.
//
// Oracle: tests/oracle/sillytavern-1.19.0-content-uuid.json recorded by tools/probe-content-uuid.mjs.
// The fixture's steps are an ORDERED ARRAY. The classifier rules are asserted against the pinned
// predicates in content-manager.js:1080-1112; a pinned probe cannot cover them because those shapes
// would fetch on the pinned server, so a recorded 501 would be a fake oracle (rule 17 explains the
// 501/404 split instead).

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type contentUUIDFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	NodeFetchWireDefaults struct {
		Headers [][2]string `json:"headers"`
	} `json:"nodeFetchWireDefaults"`
	Inputs struct {
		CookieSecret string            `json:"cookieSecret"`
		Account      sdFixtureAccount  `json:"account"`
		Steps        []contentUUIDStep `json:"steps"`
	} `json:"inputs"`
	Observations     map[string]contentObservation `json:"observations"`
	KnownDifferences []map[string]any              `json:"knownDifferences"`
}

type contentUUIDStep struct {
	Name     string             `json:"name"`
	Body     json.RawMessage    `json:"body"`
	Upstream []backendsUpstream `json:"upstream"`
	Seam     *string            `json:"seam"`
}

func loadContentUUIDFixture(t *testing.T) contentUUIDFixture {
	t.Helper()
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-content-uuid.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture contentUUIDFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestPinnedNodeContentImportUUID(t *testing.T) {
	fixture := loadContentUUIDFixture(t)
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("content-uuid oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Inputs.Steps) == 0 || len(fixture.Inputs.Steps) != len(fixture.Observations) {
		t.Fatalf("content-uuid oracle has %d steps and %d observations", len(fixture.Inputs.Steps), len(fixture.Observations))
	}
	verifyContentUUIDClassification(t, fixture)

	dataRoot := t.TempDir()
	handler, sessionCookie, token := contentRouteHandler(t, dataRoot, fixture.Inputs.CookieSecret, fixture.Inputs.Account, nil)
	seedContentTree(t, dataRoot)

	peer := mockprovider.NewKeyed(nil)
	address, err := peer.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	mockOrigin := "http://" + address.String()
	mockAuthority := address.String()
	t.Setenv("GOTAVERN_CONTENT_AICC_URL", mockOrigin)

	for _, step := range fixture.Inputs.Steps {
		observation, exists := fixture.Observations[step.Name]
		if !exists {
			t.Fatalf("%s: no observation", step.Name)
		}
		peer.Reset(contentUUIDPeerScript(step, observation))
		body := "{}"
		if len(step.Body) > 0 {
			body = string(step.Body)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/content/importUUID", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		compareContentResponse(t, step.Name, observation, recorder)
		recorded := peer.Recording().Requests
		if len(observation.Outbound) == 0 {
			if len(recorded) != 0 {
				t.Fatalf("%s: expected no outbound request, peer saw %d", step.Name, len(recorded))
			}
		} else {
			if len(recorded) != len(observation.Outbound) {
				t.Fatalf("%s: peer received %d requests, pinned Node made %d", step.Name, len(recorded), len(observation.Outbound))
			}
			expected := observation.Outbound[0]
			actual := recorded[0]
			if actual.Method != expected.Method {
				t.Fatalf("%s: method = %s, pinned sent %s", step.Name, actual.Method, expected.Method)
			}
			if actual.RawTarget != expectedTargetPath(t, expected.URL) {
				t.Fatalf("%s: target = %q, pinned sent %q", step.Name, actual.RawTarget, expectedTargetPath(t, expected.URL))
			}
			wantHeaders := contentExpectedWireHeaders(contentFixture{NodeFetchWireDefaults: fixture.NodeFetchWireDefaults}, expected, mockAuthority)
			compareBackendsHeaderLines(t, step.Name, 0, wantHeaders, actual.Headers, backendsExplicitConnection(expected))
		}
		if unused := peer.Unused(); len(unused) > 0 {
			t.Fatalf("%s: peer script unused %v", step.Name, unused)
		}
		snapshot := make([]userDataEntry, 0)
		walkUserDataTree(t, filepath.Join(dataRoot, "default-user", "characters"), "", &snapshot)
		sort.Slice(snapshot, func(left, right int) bool { return snapshot[left].Path < snapshot[right].Path })
		compareUserDataTree(t, step.Name+"/tree", observation.Tree, snapshot)
	}
}

func contentUUIDPeerScript(step contentUUIDStep, observation contentObservation) map[string][]mockprovider.Response {
	script := map[string][]mockprovider.Response{}
	if len(step.Upstream) == 0 {
		return script
	}
	for index, item := range step.Upstream {
		method := "GET"
		if index < len(observation.Outbound) {
			method = observation.Outbound[index].Method
		}
		names := make([]string, 0, len(item.Headers))
		for header := range item.Headers {
			names = append(names, header)
		}
		sort.Strings(names)
		headers := make([]mockprovider.Header, 0, len(names))
		for _, header := range names {
			headers = append(headers, mockprovider.Header{Name: header, Value: item.Headers[header]})
		}
		script[method+" "+item.Path] = append(script[method+" "+item.Path], mockprovider.Response{
			Status: item.Status, Headers: headers, Body: item.Body,
		})
	}
	return script
}

func expectedTargetPath(t *testing.T, rawURL string) string {
	t.Helper()
	parsed, err := url.Parse(rawURL)
	if err != nil {
		t.Fatalf("fixture URL %q: %v", rawURL, err)
	}
	return parsed.RequestURI()
}

func verifyContentUUIDClassification(t *testing.T, fixture contentUUIDFixture) {
	t.Helper()
	comparedAnywhere := map[string]bool{}
	sawAttachment := false
	sawBadRequest := false
	sawServerError := false
	sawOutbound := false
	for name, observation := range fixture.Observations {
		classified := map[string]bool{}
		for _, key := range observation.Comparison.Compared {
			classified[key] = true
			comparedAnywhere[key] = true
		}
		for _, key := range observation.Comparison.Shape {
			classified[key] = true
			if strings.TrimSpace(observation.Comparison.ShapeReason[key]) == "" {
				t.Fatalf("%s: shape %q has no reason", name, key)
			}
		}
		for _, key := range []string{"status", "contentType", "contentLength", "etag", "contentDisposition", "customContentType", "bodyBase64", "bodySha256", "bodyLength", "outbound", "tree"} {
			if !classified[key] {
				t.Fatalf("%s: observable %q is neither compared nor shape-classified", name, key)
			}
		}
		if observation.Status == 200 && observation.ContentDisposition != nil {
			sawAttachment = true
		}
		if observation.Status == 400 {
			sawBadRequest = true
		}
		if observation.Status == 500 {
			sawServerError = true
		}
		if len(observation.Outbound) > 0 {
			sawOutbound = true
		}
	}
	if !sawAttachment || !sawBadRequest || !sawServerError || !sawOutbound {
		t.Fatalf("content-uuid fixture is not discriminating: attachment=%v 400=%v 500=%v outbound=%v",
			sawAttachment, sawBadRequest, sawServerError, sawOutbound)
	}
	for _, key := range []string{"contentDisposition", "customContentType", "bodyBase64", "outbound"} {
		if !comparedAnywhere[key] {
			t.Fatalf("observable %q is never compared", key)
		}
	}
}

// TestContentImportUUIDClassifier pins the source-derived dispatch rules. A pinned probe cannot
// record them: every non-AICC shape fetches on the pinned server, so the classifier is asserted
// against the predicates in content-manager.js:1080-1112 instead.
func TestContentImportUUIDClassifier(t *testing.T) {
	cases := []struct {
		uuid string
		want contentImportUUIDKind
	}{
		{"12345678-1234-1234-1234-123456789012", contentUUIDKindPygmalion},
		{"12345678-1234-1234-1234-123456789012_character", contentUUIDKindJanny},
		{"Any_character", contentUUIDKindJanny},
		{"AICC/author/card", contentUUIDKindAICC},
		{"AICC/only", contentUUIDKindAICC},
		{"AICC/", contentUUIDKindAICC},
		{"Name~0123456789abcdef0123456789abcdef.gz", contentUUIDKindPerchance},
		{"Name~0123456789ABCDEF0123456789abcdef.gz", contentUUIDKindChubCharacter},
		{"creator/project", contentUUIDKindChubCharacter},
		{"creator/project/lorebook", contentUUIDKindChubLorebook},
		{"lorebook", contentUUIDKindChubLorebook},
	}
	for _, testCase := range cases {
		if got := contentClassifyImportUUID(testCase.uuid); got != testCase.want {
			t.Fatalf("classify(%q) = %q, want %q", testCase.uuid, got, testCase.want)
		}
	}
}

// TestContentImportUUIDUnimplementedBranches asserts the 501 marker AND that no request escapes, so
// a 501 is distinguishable from a policy refusal (rule 17) and cannot silently start fetching.
func TestContentImportUUIDUnimplementedBranches(t *testing.T) {
	fixture := loadContentUUIDFixture(t)
	dataRoot := t.TempDir()
	handler, sessionCookie, token := contentRouteHandler(t, dataRoot, fixture.Inputs.CookieSecret, fixture.Inputs.Account, nil)
	peer := mockprovider.NewKeyed(nil)
	address, err := peer.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	t.Setenv("GOTAVERN_CONTENT_AICC_URL", "http://"+address.String())

	unimplemented := []string{
		"12345678-1234-1234-1234-123456789012",
		"some_uuid_character",
		"Name~0123456789abcdef0123456789abcdef.gz",
		"creator/project",
		"creator/project/lorebook",
	}
	for _, uuid := range unimplemented {
		body, err := marshalNodeJSON(map[string]any{"url": uuid})
		if err != nil {
			t.Fatal(err)
		}
		request := httptest.NewRequest(http.MethodPost, "/api/content/importUUID", strings.NewReader(string(body)))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusNotImplemented {
			t.Fatalf("%s: status = %d, want 501", uuid, recorder.Code)
		}
		if len(peer.Recording().Requests) != 0 {
			t.Fatalf("%s: unimplemented branch issued %d outbound requests, want 0", uuid, len(peer.Recording().Requests))
		}
	}
}
