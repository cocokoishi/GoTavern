package server

// Replay of the pinned /api/content/importURL branches implemented this round against
// tests/oracle/sillytavern-1.19.0-content.json (recorded by tools/probe-content.mjs).
//
// The fixture's steps are an ORDERED ARRAY; this replay iterates it in recorded order. Each step
// rebuilds the caller URL from its template (<mock> = the replay peer's port), sends the exact body,
// compares every response field (including Content-Disposition, which uses encodeURI rather than
// encodeURIComponent) and the characters tree, and compares the outbound request (method, target,
// wire headers, body). Refusal steps must produce zero outbound requests.

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

	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type contentFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	NodeFetchWireDefaults struct {
		Headers [][2]string `json:"headers"`
	} `json:"nodeFetchWireDefaults"`
	Inputs struct {
		CookieSecret           string           `json:"cookieSecret"`
		Account                sdFixtureAccount `json:"account"`
		WhitelistImportDomains []string         `json:"whitelistImportDomains"`
		Steps                  []contentStep    `json:"steps"`
	} `json:"inputs"`
	Observations     map[string]contentObservation `json:"observations"`
	KnownDifferences []map[string]any              `json:"knownDifferences"`
}

type contentStep struct {
	Name        string             `json:"name"`
	URLTemplate string             `json:"urlTemplate"`
	BodyText    string             `json:"bodyText"`
	Seam        *string            `json:"seam"`
	Peer        string             `json:"peer"`
	Upstream    []backendsUpstream `json:"upstream"`
}

type contentObservation struct {
	Status             int              `json:"status"`
	ContentType        *string          `json:"contentType"`
	ContentLength      *string          `json:"contentLength"`
	Etag               *string          `json:"etag"`
	ContentDisposition *string          `json:"contentDisposition"`
	CustomContentType  *string          `json:"customContentType"`
	BodyBase64         string           `json:"bodyBase64"`
	BodySha256         string           `json:"bodySha256"`
	BodyLength         int              `json:"bodyLength"`
	Outbound           []searchOutbound `json:"outbound"`
	Tree               []userDataEntry  `json:"tree"`
	Comparison         searchComparison `json:"comparison"`
}

func TestContentSeamDefaults(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-content.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture contentFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	t.Setenv("GOTAVERN_CONTENT_AICC_URL", "")
	if got := contentAICCURL(); got != "https://aicharactercards.com" {
		t.Fatalf("GOTAVERN_CONTENT_AICC_URL default = %q", got)
	}
	if len(fixture.Inputs.WhitelistImportDomains) == 0 {
		t.Fatal("fixture records no whitelistImportDomains")
	}
}

func TestPinnedNodeContentImportURL(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-content.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture contentFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("content oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Inputs.Steps) == 0 || len(fixture.Inputs.Steps) != len(fixture.Observations) {
		t.Fatalf("content oracle has %d steps and %d observations", len(fixture.Inputs.Steps), len(fixture.Observations))
	}
	verifyContentClassification(t, fixture)

	dataRoot := t.TempDir()
	handler, sessionCookie, token := contentRouteHandler(t, dataRoot, fixture.Inputs.CookieSecret, fixture.Inputs.Account, fixture.Inputs.WhitelistImportDomains)
	seedContentTree(t, dataRoot)

	peer := mockprovider.NewKeyed(nil)
	address, err := peer.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	mockOrigin := "http://" + address.String()
	mockAuthority := address.String()

	closedOrigin := closedLoopbackOrigin(t)
	t.Setenv("GOTAVERN_CONTENT_AICC_URL", "")

	for _, step := range fixture.Inputs.Steps {
		observation, exists := fixture.Observations[step.Name]
		if !exists {
			t.Fatalf("%s: no recorded observation", step.Name)
		}
		if len(step.Upstream) != len(observation.Outbound) && step.Peer != "closed" {
			t.Fatalf("%s: %d upstream answers but %d outbound requests", step.Name, len(step.Upstream), len(observation.Outbound))
		}
		peer.Reset(contentPeerScript(t, step, observation, mockOrigin))
		if step.Seam != nil {
			t.Setenv(*step.Seam, mockOrigin)
		} else {
			t.Setenv("GOTAVERN_CONTENT_AICC_URL", "")
		}
		// The request URL host stays localhost (the whitelist entry the fixture recorded); only the
		// port swaps to the replay peer, or to the closed port for the rejected-fetch step. The
		// body carries the SAME url, so both derivations use one port value.
		urlAuthority := mockAuthority
		if step.Peer == "closed" {
			urlAuthority = strings.TrimPrefix(closedOrigin, "http://")
		}
		port := contentPortFromAuthority(urlAuthority)
		requestURL := strings.ReplaceAll(step.URLTemplate, "<mock>", port)
		requestBody := strings.ReplaceAll(step.BodyText, "<mock>", port)
		request := httptest.NewRequest(http.MethodPost, "/api/content/importURL", strings.NewReader(requestBody))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		compareContentResponse(t, step.Name, observation, recorder)
		recorded := peer.Recording().Requests
		if step.Peer == "closed" {
			if len(recorded) != 0 {
				t.Fatalf("%s: closed-peer step reached the peer %d time(s)", step.Name, len(recorded))
			}
			continue
		}
		if len(observation.Outbound) == 0 {
			if len(recorded) != 0 {
				t.Fatalf("%s: refusal/absent step issued %d outbound requests", step.Name, len(recorded))
			}
		} else {
			compareContentOutbound(t, step, fixture, observation, recorded, requestURL, mockAuthority)
		}
		if unused := peer.Unused(); len(unused) > 0 {
			t.Fatalf("%s: peer script not fully consumed; unused %v", step.Name, unused)
		}
		snapshot := make([]userDataEntry, 0)
		walkUserDataTree(t, filepath.Join(dataRoot, "default-user", "characters"), "", &snapshot)
		sort.Slice(snapshot, func(left, right int) bool { return snapshot[left].Path < snapshot[right].Path })
		compareUserDataTree(t, step.Name+"/tree", observation.Tree, snapshot)
	}
}

func contentPortFromAuthority(authority string) string {
	if index := strings.LastIndexByte(authority, ':'); index >= 0 {
		return authority[index+1:]
	}
	return ""
}

func contentRouteHandler(t *testing.T, dataRoot, cookieSecret string, account sdFixtureAccount, whitelist []string) (http.Handler, string, string) {
	t.Helper()
	accountJSON, err := marshalNodeJSON(map[string]any{
		"handle": account.Handle, "name": account.Name, "created": 1700000000000,
		"password": account.Password, "admin": account.Admin, "enabled": true, "salt": "",
	})
	if err != nil {
		t.Fatal(err)
	}
	if err := startup.SetNodePersistRecord(dataRoot, userStoragePrefix+account.Handle, accountJSON); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(cookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(t.TempDir(), dataRoot, []string{account.Handle}); err != nil {
		t.Fatal(err)
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{
		InstallRoot: t.TempDir(), DataRoot: dataRoot, CookieSecret: cookieSecret, AccountsEnabled: true,
		WhitelistImportDomains: whitelist,
	})
	csrf := httptest.NewRecorder()
	handler.ServeHTTP(csrf, httptest.NewRequest(http.MethodGet, "/csrf-token", nil))
	if csrf.Code != http.StatusOK {
		t.Fatalf("GET /csrf-token = %d", csrf.Code)
	}
	var payload struct {
		Token string `json:"token"`
	}
	if err := json.Unmarshal(csrf.Body.Bytes(), &payload); err != nil {
		t.Fatal(err)
	}
	loginBody, err := marshalNodeJSON(map[string]string{"handle": account.Handle, "password": account.Password})
	if err != nil {
		t.Fatal(err)
	}
	login := httptest.NewRecorder()
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/users/login", strings.NewReader(string(loginBody)))
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("Cookie", joinCookies(csrf.Header().Values("Set-Cookie")))
	loginRequest.Header.Set("X-CSRF-Token", payload.Token)
	handler.ServeHTTP(login, loginRequest)
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	return handler, joinCookies(login.Header().Values("Set-Cookie")), payload.Token
}

func seedContentTree(t *testing.T, dataRoot string) {
	t.Helper()
	target := filepath.Join(dataRoot, "default-user", "characters", "seed.txt")
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, []byte("SEED"), 0o666); err != nil {
		t.Fatal(err)
	}
}

func verifyContentClassification(t *testing.T, fixture contentFixture) {
	t.Helper()
	comparedAnywhere := map[string]bool{}
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
	}
	for _, key := range []string{"contentType", "contentLength", "etag", "contentDisposition", "customContentType", "bodyBase64", "bodySha256", "outbound", "tree"} {
		if !comparedAnywhere[key] {
			t.Fatalf("observable %q is never compared", key)
		}
	}
	// Refusal completeness: the fixture must contain at least one 404 with zero outbound requests
	// (the security-relevant refusal) and at least one 200 attachment.
	sawRefusal := false
	sawAttachment := false
	for _, observation := range fixture.Observations {
		if observation.Status == 404 && len(observation.Outbound) == 0 {
			sawRefusal = true
		}
		if observation.Status == 200 && observation.ContentDisposition != nil {
			sawAttachment = true
		}
	}
	if !sawRefusal || !sawAttachment {
		t.Fatalf("content fixture is not discriminating: refusal=%v attachment=%v", sawRefusal, sawAttachment)
	}
}

func contentPeerScript(t *testing.T, step contentStep, observation contentObservation, mockOrigin string) map[string][]mockprovider.Response {
	t.Helper()
	script := map[string][]mockprovider.Response{}
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
		key := method + " " + item.Path
		script[key] = append(script[key], mockprovider.Response{Status: item.Status, Headers: headers, Body: item.Body})
	}
	return script
}

func compareContentResponse(t *testing.T, name string, observation contentObservation, recorder *httptest.ResponseRecorder) {
	t.Helper()
	if recorder.Code != observation.Status {
		t.Fatalf("%s: status = %d, pinned Node has %d (body %q)", name, recorder.Code, observation.Status, recorder.Body.String())
	}
	compareOptionalHeader(t, name, "content-type", observation.ContentType, recorder.Header().Get("Content-Type"))
	compareOptionalHeader(t, name, "content-length", observation.ContentLength, recorder.Header().Get("Content-Length"))
	compareOptionalHeader(t, name, "etag", observation.Etag, recorder.Header().Get("ETag"))
	compareOptionalHeader(t, name, "content-disposition", observation.ContentDisposition, recorder.Header().Get("Content-Disposition"))
	compareOptionalHeader(t, name, "x-custom-content-type", observation.CustomContentType, recorder.Header().Get("X-Custom-Content-Type"))
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

func compareContentOutbound(t *testing.T, step contentStep, fixture contentFixture, observation contentObservation, recorded []mockprovider.Request, requestURL, mockAuthority string) {
	t.Helper()
	if len(recorded) != len(observation.Outbound) {
		t.Fatalf("%s: peer received %d requests, pinned Node made %d", step.Name, len(recorded), len(observation.Outbound))
	}
	for position, expected := range observation.Outbound {
		actual := recorded[position]
		if actual.Method != expected.Method {
			t.Fatalf("%s: request %d method = %s, pinned Node sent %s", step.Name, position, actual.Method, expected.Method)
		}
		materialized, err := url.Parse(strings.ReplaceAll(expected.URL, "<mock>", contentPortFromAuthority(mockAuthority)))
		if err != nil {
			t.Fatalf("%s: fixture URL %q: %v", step.Name, expected.URL, err)
		}
		if actual.RawTarget != materialized.RequestURI() {
			t.Fatalf("%s: request %d target = %q, pinned Node sent %q", step.Name, position, actual.RawTarget, materialized.RequestURI())
		}
		hostValue := mockAuthority
		if step.Seam == nil {
			if parsed, parseErr := url.Parse(requestURL); parseErr == nil {
				hostValue = parsed.Host
			}
		}
		wantHeaders := contentExpectedWireHeaders(fixture, expected, hostValue)
		compareBackendsHeaderLines(t, step.Name, position, wantHeaders, actual.Headers, backendsExplicitConnection(expected))
		if actual.BodyText != nil && *actual.BodyText != "" {
			t.Fatalf("%s: request %d carried a body the pinned route does not send", step.Name, position)
		}
	}
}

func contentExpectedWireHeaders(fixture contentFixture, expected searchOutbound, host string) [][2]string {
	values := map[string]string{}
	for _, header := range fixture.NodeFetchWireDefaults.Headers {
		values[header[0]] = header[1]
	}
	for _, header := range expected.Headers {
		values[strings.ToLower(header[0])] = header[1]
	}
	names := make([]string, 0, len(values))
	for name := range values {
		names = append(names, name)
	}
	sort.Strings(names)
	lines := make([][2]string, 0, len(names)+1)
	for _, name := range names {
		lines = append(lines, [2]string{name, values[name]})
	}
	lines = append(lines, [2]string{"Host", host})
	return lines
}
