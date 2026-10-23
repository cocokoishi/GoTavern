package server

// Replay of the pinned /api/backends routes implemented this round. The oracle is
// tests/oracle/sillytavern-1.19.0-backends.json, recorded by tools/probe-backends.mjs from the
// pinned server with node-fetch replaced by a controlled peer. Each scenario is replayed against a
// local keyed recording peer and compared on the HTTP response (including the Ooba
// x-supports-tokenization header) plus every outbound request (method, raw target, full wire header
// list, body).
//
// A scenario the pinned stub records but the Go side cannot reach through the recorder (a rejected
// fetch) carries `peer: "closed"`: it is replayed through the convention's closed port, its response
// is compared, and the mock is asserted to have received nothing.
//
// The one `shape` classification is the transport Connection header, which is only asserted for
// presence; routes that set Connection themselves would carry it in the explicit header list.

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type backendsFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	NodeFetchWireDefaults struct {
		Headers [][2]string `json:"headers"`
	} `json:"nodeFetchWireDefaults"`
	Inputs struct {
		CookieSecret string                      `json:"cookieSecret"`
		Account      sdFixtureAccount            `json:"account"`
		SeamDefaults map[string]string           `json:"seamDefaults"`
		Scenarios    map[string]backendsScenario `json:"scenarios"`
	} `json:"inputs"`
	Observations     map[string]backendsObservation `json:"observations"`
	KnownDifferences []map[string]any               `json:"knownDifferences"`
}

type backendsScenario struct {
	Route    string             `json:"route"`
	Query    string             `json:"query"`
	BodyText string             `json:"bodyText"`
	Seam     *string            `json:"seam"`
	Secrets  map[string]string  `json:"secrets"`
	Upstream []backendsUpstream `json:"upstream"`
	Replayed bool               `json:"replayed"`
	Peer     string             `json:"peer"`
}

type backendsUpstream struct {
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type backendsObservation struct {
	Status        int              `json:"status"`
	ContentType   *string          `json:"contentType"`
	ContentLength *string          `json:"contentLength"`
	Etag          *string          `json:"etag"`
	SpecialHeader *string          `json:"specialHeader"`
	Body          string           `json:"body"`
	Outbound      []searchOutbound `json:"outbound"`
	Comparison    searchComparison `json:"comparison"`
}

var backendsObservableKeys = []string{"status", "contentType", "contentLength", "etag", "specialHeader", "body", "outbound"}

func TestBackendsSeamDefaults(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-backends.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture backendsFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	accessors := map[string]func() string{
		"GOTAVERN_BACKENDS_POLLINATIONS_URL": backendsPollinationsURL,
		"GOTAVERN_BACKENDS_AIMLAPI_URL":      backendsAimlapiURL,
		"GOTAVERN_BACKENDS_NANOGPT_URL":      backendsNanoGPTURL,
		"GOTAVERN_BACKENDS_ELECTRONHUB_URL":  backendsElectronHubURL,
		"GOTAVERN_BACKENDS_CHUTES_URL":       backendsChutesURL,
		"GOTAVERN_BACKENDS_MISTRAL_URL":      backendsMistralURL,
		"GOTAVERN_BACKENDS_XAI_URL":          backendsXaiURL,
		"GOTAVERN_BACKENDS_MOONSHOT_URL":     backendsMoonshotURL,
		"GOTAVERN_BACKENDS_WORKERSAI_URL":    backendsWorkersAIURL,
		// The MISTRALAI status route builds its URL from the CHAT literal, not from a backends one.
		"GOTAVERN_MISTRAL_CHAT_URL": pinnedMistralBaseURL,
		// OPENAI is the same case: `new URL(reverse_proxy || API_OPENAI)` in the status arm and in
		// the generate plan, so its seam is the chat one and its default is the pinned literal.
		"GOTAVERN_OPENAI_CHAT_URL": pinnedOpenAIBaseURL,
		// MINIMAX's generate branch has TWO hardcoded hosts chosen by the request body
		// (`minimax_endpoint === 'cn'`), so it needs one seam per literal.
		"GOTAVERN_MINIMAX_CHAT_URL":    minimaxChatGlobalBaseURL,
		"GOTAVERN_MINIMAX_CHAT_CN_URL": minimaxChatCNBaseURL,
		// DEEPSEEK shares the seam: its status route strips /beta from the same chat literal.
		"GOTAVERN_DEEPSEEK_CHAT_URL": pinnedDeepSeekBaseURL,
		// ELECTRONHUB uses one literal for both routes, so one seam serves the generate and status arms.
		"GOTAVERN_ELECTRONHUB_CHAT_URL": pinnedElectronHubBaseURL,
	}
	if len(fixture.Inputs.SeamDefaults) != len(accessors) {
		t.Fatalf("fixture records %d seam defaults, implementation has %d", len(fixture.Inputs.SeamDefaults), len(accessors))
	}
	for environmentName, defaultValue := range fixture.Inputs.SeamDefaults {
		accessor, exists := accessors[environmentName]
		if !exists {
			t.Fatalf("fixture records unknown seam %q", environmentName)
		}
		t.Setenv(environmentName, "")
		if got := accessor(); got != defaultValue {
			t.Fatalf("%s default = %q, pinned literal %q", environmentName, got, defaultValue)
		}
	}
}

func TestPinnedNodeBackendsRoutes(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-backends.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture backendsFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("backends oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Inputs.Scenarios) == 0 || len(fixture.Inputs.Scenarios) != len(fixture.Observations) {
		t.Fatalf("backends oracle has %d scenarios but %d observations", len(fixture.Inputs.Scenarios), len(fixture.Observations))
	}
	verifyBackendsClassification(t, fixture)
	if len(fixture.KnownDifferences) == 0 {
		t.Fatal("the backends oracle must record its deferred routes and the kobold status crash")
	}

	dataRoot := t.TempDir()
	handler, sessionCookie, token := backendsRouteHandler(t, dataRoot, fixture.Inputs.CookieSecret, fixture.Inputs.Account)

	peer := mockprovider.NewKeyed(nil)
	address, err := peer.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	mockOrigin := "http://" + address.String()
	mockAuthority := address.String()
	closedOrigin := closedLoopbackOrigin(t)

	for environmentName := range fixture.Inputs.SeamDefaults {
		t.Setenv(environmentName, "")
	}

	for _, name := range sortedKeys(fixture.Inputs.Scenarios) {
		scenario := fixture.Inputs.Scenarios[name]
		observation, exists := fixture.Observations[name]
		if !exists {
			t.Fatalf("%s: no recorded observation", name)
		}
		for environmentName := range fixture.Inputs.SeamDefaults {
			t.Setenv(environmentName, "")
		}
		peer.Reset(backendsPeerScript(t, name, scenario, observation, mockOrigin))
		targetOrigin := mockOrigin
		if scenario.Peer == "closed" {
			targetOrigin = closedOrigin
		}
		if scenario.Seam != nil {
			if _, known := fixture.Inputs.SeamDefaults[*scenario.Seam]; !known {
				t.Fatalf("%s: unknown seam %q", name, *scenario.Seam)
			}
			t.Setenv(*scenario.Seam, targetOrigin+backendsSeamBasePath(t, fixture.Inputs.SeamDefaults[*scenario.Seam]))
		}
		writeSDSecrets(t, dataRoot, fixture.Inputs.Account.Handle, scenario.Secrets)
		bodyOrigin := mockOrigin
		if scenario.Peer == "closed" {
			// A body-provided upstream URL (custom_url) must point at the closed port for a
			// rejected-fetch scenario; seam-driven routes use the seam override instead.
			bodyOrigin = closedOrigin
		}
		body := backendsRequestBody(scenario.BodyText, bodyOrigin, mockAuthority)
		request := httptest.NewRequest(http.MethodPost, "/api/backends/"+scenario.Route+scenario.Query, strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		compareBackendsResponse(t, name, observation, recorder, mockOrigin)
		recorded := peer.Recording().Requests
		if scenario.Peer == "closed" {
			if len(recorded) != 0 {
				t.Fatalf("%s: closed-peer scenario reached the recording peer %d time(s)", name, len(recorded))
			}
			continue
		}
		compareBackendsOutbound(t, name, fixture, scenario, observation, recorded, mockOrigin, mockAuthority)
		if unused := peer.Unused(); len(unused) > 0 {
			t.Fatalf("%s: the peer script was not fully consumed; unused %v", name, unused)
		}
	}
}

// backendsRouteHandler seeds an account like newSDRouteHandler, but points the handler's
// InstallRoot at the repository root so the tokenizer assets used by /bias are found through the
// documented development candidate (<InstallRoot>/upstream/tokenizers). The pinned /bias probe
// runs against the pinned checkout, so the replay needs the same assets.
func backendsRouteHandler(t *testing.T, dataRoot, cookieSecret string, account sdFixtureAccount) (http.Handler, string, string) {
	t.Helper()
	repositoryRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
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
		InstallRoot: repositoryRoot, DataRoot: dataRoot, CookieSecret: cookieSecret, AccountsEnabled: true,
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
	csrfCookie := joinCookies(csrf.Header().Values("Set-Cookie"))
	loginBody, err := marshalNodeJSON(map[string]string{"handle": account.Handle, "password": account.Password})
	if err != nil {
		t.Fatal(err)
	}
	login := httptest.NewRecorder()
	loginRequest := httptest.NewRequest(http.MethodPost, "/api/users/login", bytes.NewReader(loginBody))
	loginRequest.Header.Set("Content-Type", "application/json")
	loginRequest.Header.Set("Cookie", csrfCookie)
	loginRequest.Header.Set("X-CSRF-Token", payload.Token)
	handler.ServeHTTP(login, loginRequest)
	if login.Code != http.StatusOK {
		t.Fatalf("POST /api/users/login = %d, body %q", login.Code, login.Body.String())
	}
	return handler, joinCookies(login.Header().Values("Set-Cookie")), payload.Token
}

func verifyBackendsClassification(t *testing.T, fixture backendsFixture) {
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
				t.Fatalf("%s: shape field %q has no reason", name, key)
			}
		}
		for _, key := range backendsObservableKeys {
			if !classified[key] {
				t.Fatalf("%s: observable %q is neither compared nor shape-classified", name, key)
			}
		}
		if !classified["status"] || !classified["body"] {
			t.Fatalf("%s: status and body must be compared", name)
		}
	}
	for _, key := range []string{"contentType", "contentLength", "etag", "specialHeader", "outbound"} {
		if !comparedAnywhere[key] {
			t.Fatalf("observable %q is never compared, so the suite cannot prove it", key)
		}
	}
}

func backendsRequestBody(bodyText, mockOrigin, mockAuthority string) string {
	port := ""
	if parsed, err := url.Parse(mockOrigin); err == nil {
		port = parsed.Port()
	}
	body := strings.ReplaceAll(bodyText, "<mock>", mockOrigin)
	body = strings.ReplaceAll(body, "<port>", port)
	return body
}

// backendsPeerScript pairs each recorded upstream answer with the method of the corresponding
// recorded outbound request. The stub matches URLs only, so the probe's upstream entries carry no
// method; the observation's outbound sequence is the authoritative method order (1:1 with the
// scripted answers for every replayed scenario).
func backendsPeerScript(t *testing.T, name string, scenario backendsScenario, observation backendsObservation, mockOrigin string) map[string][]mockprovider.Response {
	t.Helper()
	if len(scenario.Upstream) == 0 {
		// The stub answered these requests itself (no scripted answer); the replay peer does the
		// same, so an unscripted request is answered 500 by both sides.
		return map[string][]mockprovider.Response{}
	}
	if len(scenario.Upstream) != len(observation.Outbound) {
		t.Fatalf("%s: fixture has %d upstream answers but %d recorded outbound requests", name, len(scenario.Upstream), len(observation.Outbound))
	}
	script := map[string][]mockprovider.Response{}
	for index, item := range scenario.Upstream {
		method := observation.Outbound[index].Method
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
		script[key] = append(script[key], mockprovider.Response{
			Status: item.Status, Headers: headers, Body: strings.ReplaceAll(item.Body, "<mock>", mockOrigin),
		})
	}
	return script
}

func compareBackendsResponse(t *testing.T, name string, observation backendsObservation, recorder *httptest.ResponseRecorder, mockOrigin string) {
	t.Helper()
	compared := map[string]bool{}
	for _, key := range observation.Comparison.Compared {
		compared[key] = true
	}
	if compared["status"] && recorder.Code != observation.Status {
		t.Fatalf("%s: status = %d, pinned Node has %d (body %q)", name, recorder.Code, observation.Status, recorder.Body.String())
	}
	if compared["contentType"] {
		compareOptionalHeader(t, name, "content-type", observation.ContentType, recorder.Header().Get("Content-Type"))
	}
	if compared["contentLength"] {
		compareOptionalHeader(t, name, "content-length", observation.ContentLength, recorder.Header().Get("Content-Length"))
	}
	if compared["etag"] {
		compareOptionalHeader(t, name, "etag", observation.Etag, recorder.Header().Get("ETag"))
	}
	if compared["specialHeader"] {
		compareOptionalHeader(t, name, "x-supports-tokenization", observation.SpecialHeader, recorder.Header().Get("X-Supports-Tokenization"))
	}
	if compared["body"] {
		got := strings.ReplaceAll(recorder.Body.String(), mockOrigin, "<mock>")
		if got != observation.Body {
			t.Fatalf("%s: body = %q, pinned Node has %q", name, got, observation.Body)
		}
	}
}

func compareBackendsOutbound(t *testing.T, name string, fixture backendsFixture, scenario backendsScenario, observation backendsObservation, recorded []mockprovider.Request, mockOrigin, mockAuthority string) {
	t.Helper()
	if len(recorded) != len(observation.Outbound) {
		t.Fatalf("%s: peer received %d requests, pinned Node made %d", name, len(recorded), len(observation.Outbound))
	}
	for index, expected := range observation.Outbound {
		actual := recorded[index]
		if actual.Method != expected.Method {
			t.Fatalf("%s: request %d method = %s, pinned Node sent %s", name, index, actual.Method, expected.Method)
		}
		wantTarget := searchExpectedTarget(t, expected.URL)
		if actual.RawTarget != wantTarget {
			t.Fatalf("%s: request %d target = %q, pinned Node sent %q", name, index, actual.RawTarget, wantTarget)
		}
		actualBody := ""
		if actual.BodyText != nil {
			actualBody = *actual.BodyText
		}
		wantBody := strings.ReplaceAll(expected.Body, "<mock>", mockOrigin)
		if scenario.Seam == nil {
			// Body-URL routes: the fixture's target host is the host the pinned route actually
			// dialled (the localhost rewrite is observable here). Seam routes deliberately point
			// at the replay mock instead, so their host is asserted by the Host header above.
			expectedHost := ""
			if strings.HasPrefix(expected.URL, "<mock>") {
				expectedHost = mockAuthority
			} else if parsed, err := url.Parse(expected.URL); err == nil {
				expectedHost = parsed.Host
			}
			actualHost := ""
			for _, header := range actual.Headers {
				if strings.EqualFold(header.Name, "host") {
					actualHost = header.Value
				}
			}
			if backendsHostname(t, expectedHost) != backendsHostname(t, actualHost) {
				t.Fatalf("%s: request %d dialled host %q, pinned Node dialled %q", name, index, actualHost, expectedHost)
			}
		}
		wantHeaders := backendsExpectedWireHeaders(fixture, expected, wantBody, mockAuthority)
		compareBackendsHeaderLines(t, name, index, wantHeaders, actual.Headers, backendsExplicitConnection(expected))
		if actualBody != wantBody {
			t.Fatalf("%s: request %d body = %q, pinned Node sent %q", name, index, actualBody, wantBody)
		}
	}
}

// backendsSeamBasePath is a seam default's path component without a trailing slash, so a seam whose
// literal is ".../v1" keeps its prefix when the replay points it at a local origin. Replacing the
// whole literal with a bare origin dropped that prefix and made the Go leg request /models where the
// pinned leg requested /v1/models: a harness defect that reports itself as a route divergence.
func backendsSeamBasePath(t *testing.T, literal string) string {
	t.Helper()
	parsed, err := url.Parse(literal)
	if err != nil {
		t.Fatalf("seam literal %q: %v", literal, err)
	}
	return strings.TrimSuffix(parsed.Path, "/")
}
func backendsHostname(t *testing.T, hostport string) string {
	t.Helper()
	if hostport == "" {
		return ""
	}
	if parsed, err := url.Parse("http://" + hostport); err == nil {
		return parsed.Hostname()
	}
	t.Fatalf("cannot parse host %q", hostport)
	return ""
}

func backendsExplicitConnection(expected searchOutbound) bool {
	for _, header := range expected.Headers {
		if strings.EqualFold(header[0], "connection") {
			return true
		}
	}
	return false
}

func backendsExpectedWireHeaders(fixture backendsFixture, expected searchOutbound, materializedBody, mockAuthority string) [][2]string {
	values := map[string]string{}
	for _, header := range fixture.NodeFetchWireDefaults.Headers {
		values[header[0]] = header[1]
	}
	if materializedBody != "" {
		values["content-length"] = strconv.Itoa(len(materializedBody))
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
	lines = append(lines, [2]string{"Host", mockAuthority})
	return lines
}

func compareBackendsHeaderLines(t *testing.T, name string, index int, want [][2]string, got []mockprovider.Header, explicitConnection bool) {
	t.Helper()
	if explicitConnection {
		count := 0
		for _, header := range got {
			if strings.EqualFold(header.Name, "connection") {
				count++
			}
		}
		if count != 1 {
			t.Fatalf("%s: request %d sent %d connection header lines, want exactly the route-set one", name, index, count)
		}
	} else {
		filtered := make([]mockprovider.Header, 0, len(got))
		found := false
		for _, header := range got {
			if strings.EqualFold(header.Name, "connection") {
				if found {
					t.Fatalf("%s: request %d sent more than one transport connection header", name, index)
				}
				found = true
				continue
			}
			filtered = append(filtered, header)
		}
		if !found {
			t.Fatalf("%s: request %d sent no connection header", name, index)
		}
		got = filtered
	}
	if len(got) != len(want) {
		t.Fatalf("%s: request %d sent %d header lines, pinned Node sent %d: got %v want %v", name, index, len(got), len(want), got, want)
	}
	for position := range want {
		if got[position].Name != want[position][0] || got[position].Value != want[position][1] {
			t.Fatalf("%s: request %d header %d = %q: %q, pinned Node sent %q: %q",
				name, index, position, got[position].Name, got[position].Value, want[position][0], want[position][1])
		}
	}
}
