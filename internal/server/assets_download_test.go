package server

// Replay of the pinned /api/assets/download route (src/endpoints/assets.js:190) against
// tests/oracle/sillytavern-1.19.0-assets-download.json, recorded by tools/probe-assets-download.mjs.
//
// The fixture's point is that the route has FOUR guards and that the outbound request happens after
// all of them. Every refusal step records ZERO outbound requests and every forwarding step records
// exactly one, and the replay asserts the count it observed at its own peer, so a handler that
// fetched before a guard fails here rather than looking correct.
//
// The filename guard's body is a MESSAGE (`res.status(400).send(message)`), so it is compared as
// text; the other refusals are `res.sendStatus`, whose body is the status phrase.

import (
	"encoding/json"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type assetsDownloadFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Inputs struct {
		CookieSecret           string   `json:"cookieSecret"`
		WhitelistImportDomains []string `json:"whitelistImportDomains"`
		Account                struct {
			Handle   string `json:"handle"`
			Name     string `json:"name"`
			Admin    bool   `json:"admin"`
			Password string `json:"password"`
		} `json:"account"`
		Steps []assetsDownloadInput `json:"steps"`
	} `json:"inputs"`
	State struct {
		Before []userDataEntry `json:"before"`
	} `json:"state"`
	Observations map[string]assetsDownloadObservation `json:"observations"`
}

type assetsDownloadInput struct {
	Name     string                   `json:"name"`
	BodyText string                   `json:"bodyText"`
	Upstream []assetsDownloadUpstream `json:"upstream"`
	Seed     map[string]string        `json:"seed"`
}

type assetsDownloadUpstream struct {
	Match   string            `json:"match"`
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
	Throws  bool              `json:"throws"`
}

type assetsDownloadObservation struct {
	Status        int                  `json:"status"`
	ContentType   *string              `json:"contentType"`
	ContentLength *string              `json:"contentLength"`
	Etag          *string              `json:"etag"`
	BodyText      string               `json:"bodyText"`
	BodyBase64    string               `json:"bodyBase64"`
	BodySha256    string               `json:"bodySha256"`
	BodyLength    int                  `json:"bodyLength"`
	Outbound      []assetsDownloadCall `json:"outbound"`
	Tree          []userDataEntry      `json:"tree"`
	Comparison    userDataComparison   `json:"comparison"`
}

type assetsDownloadCall struct {
	URL    string `json:"url"`
	Method string `json:"method"`
}

// assetsDownloadGuardSteps are the four guards the fixture must exercise, each with zero outbound.
var assetsDownloadGuardSteps = []string{
	"download.invalidUrl",
	"download.hostNotWhitelisted",
	"download.badCategory",
	"download.invalidFilename",
}

// assetsDownloadForwardSteps are the steps that must reach the peer exactly once.
var assetsDownloadForwardSteps = []string{
	"download.upstreamNotOk",
	"download.fetchRejected",
	"download.ok.bgm",
	"download.ok.characterPng",
	"download.ok.characterTxt",
	"download.tempReplaced",
}

func TestPinnedNodeAssetsDownload(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-assets-download.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture assetsDownloadFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("baseline = %+v", fixture.Baseline)
	}
	verifyAssetsDownloadFixture(t, fixture)
	if len(fixture.Inputs.WhitelistImportDomains) == 0 {
		t.Fatal("fixture records no whitelistImportDomains")
	}

	dataRoot := t.TempDir()
	account := sdFixtureAccount{
		Handle: fixture.Inputs.Account.Handle, Name: fixture.Inputs.Account.Name,
		Password: fixture.Inputs.Account.Password, Admin: fixture.Inputs.Account.Admin,
	}
	handler, sessionCookie, token := contentRouteHandler(t, dataRoot, fixture.Inputs.CookieSecret, account, fixture.Inputs.WhitelistImportDomains)
	userRoot := userRootPath(dataRoot)

	peer := newAssetsDownloadPeer(t)
	t.Cleanup(peer.close)
	// A genuinely closed port, for the fetch-failure assertion below.
	closed := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	closedAuthority := strings.TrimPrefix(closed.URL, "http://")
	closed.Close()

	if got := assetsDownloadComparableTree(snapshotUserDataTree(t, userRoot, "assets")["assets"]); len(got) != len(fixture.State.Before) {
		t.Fatalf("initial assets tree has %d entries, pinned Node had %d", len(got), len(fixture.State.Before))
	}

	for _, step := range fixture.Inputs.Steps {
		expected, exists := fixture.Observations[step.Name]
		if !exists {
			t.Fatalf("fixture has no observation for step %q", step.Name)
		}
		for relative, content := range step.Seed {
			seedUserDataFile(t, dataRoot, relative, content)
		}
		peer.setRule(step.Upstream)
		// The fixture stores only the PORT as <mock>, so a scenario may use a different host that
		// still reaches this peer (download.hostNotWhitelisted uses localhost, which resolves here).
		body := strings.ReplaceAll(step.BodyText, "<mock>", peer.port())
		request := httptest.NewRequest(http.MethodPost, "/api/assets/download", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		if recorder.Code != expected.Status {
			t.Fatalf("%s: status = %d, pinned Node has %d (body %q)", step.Name, recorder.Code, expected.Status, recorder.Body.String())
		}
		compareOptionalHeader(t, step.Name, "content-type", expected.ContentType, recorder.Header().Get("Content-Type"))
		compareOptionalHeader(t, step.Name, "content-length", expected.ContentLength, recorder.Header().Get("Content-Length"))
		compareOptionalHeader(t, step.Name, "etag", expected.Etag, recorder.Header().Get("ETag"))
		if recorder.Body.String() != expected.BodyText {
			t.Fatalf("%s: body = %q, pinned Node has %q", step.Name, recorder.Body.String(), expected.BodyText)
		}
		if got := userDataSHA256(recorder.Body.Bytes()); got != expected.BodySha256 {
			t.Fatalf("%s: body SHA-256 = %s, pinned Node has %s", step.Name, got, expected.BodySha256)
		}
		if recorder.Body.Len() != expected.BodyLength {
			t.Fatalf("%s: body length = %d, pinned Node has %d", step.Name, recorder.Body.Len(), expected.BodyLength)
		}

		// The outbound count is the assertion that the guards run BEFORE the fetch.
		observed := peer.takeCalls()
		if len(observed) != len(expected.Outbound) {
			t.Fatalf("%s: %d outbound request(s) %v, pinned Node made %d %v", step.Name, len(observed), observed, len(expected.Outbound), expected.Outbound)
		}
		for index, call := range expected.Outbound {
			if observed[index].Method != call.Method || observed[index].URL != call.URL {
				t.Fatalf("%s: outbound %d = %s %s, pinned Node made %s %s", step.Name, index, observed[index].Method, observed[index].URL, call.Method, call.URL)
			}
		}

		got := assetsDownloadComparableTree(snapshotUserDataTree(t, userRoot, "assets")["assets"])
		compareUserDataTree(t, step.Name+"/assets", expected.Tree, got)
	}

	// A CLOSED PORT is the failure a real deployment hits; the fixture's rejected fetch models it at
	// the peer, and this drives the same branch against a socket that is not listening.
	peer.setRule([]assetsDownloadUpstream{{Match: "/closed.mp3", Throws: true}})
	closedBody := `{"url":"http://` + closedAuthority + `/closed.mp3","category":"bgm","filename":"closed.mp3"}`
	closedRequest := httptest.NewRequest(http.MethodPost, "/api/assets/download", strings.NewReader(closedBody))
	closedRequest.Header.Set("Content-Type", "application/json")
	closedRequest.Header.Set("Cookie", sessionCookie)
	closedRequest.Header.Set("X-CSRF-Token", token)
	closedRecorder := httptest.NewRecorder()
	handler.ServeHTTP(closedRecorder, closedRequest)
	if closedRecorder.Code != http.StatusInternalServerError {
		t.Fatalf("closed port: status = %d, want 500 (body %q)", closedRecorder.Code, closedRecorder.Body.String())
	}
	if _, err := os.Stat(filepath.Join(userRoot, "assets", "bgm", "closed.mp3")); err == nil {
		t.Fatal("closed port: the route wrote an asset file for a download that never happened")
	}
}

// TestAssetsDownloadTreatsANullBodyStatusAsAFailure is a LABELLED DERIVATION (AGENTS.md rule 4), not
// an oracle. node-fetch gives `res.body === null` for 101/204/205/304, and the pinned route turns
// that into a thrown error (assets.js:229), so a 204 from the asset host answers 500 rather than
// writing an empty asset. The shared peer stub always attaches a readable body to its response
// object, so it cannot express a null body and NO fixture can record this branch; the decision is
// asserted here instead, and the fixture's knownDifferences records that limitation.
func TestAssetsDownloadTreatsANullBodyStatusAsAFailure(t *testing.T) {
	dataRoot := t.TempDir()
	account := sdFixtureAccount{Handle: "default-user", Name: "Assets Download Probe", Admin: true}
	handler, sessionCookie, token := contentRouteHandler(t, dataRoot, "gotavern-assets-download-nullbody-secret", account, []string{"127.0.0.1"})
	peer := newAssetsDownloadPeer(t)
	t.Cleanup(peer.close)

	for _, status := range []int{http.StatusNoContent, http.StatusResetContent} {
		peer.setRule([]assetsDownloadUpstream{{Match: "/nobody.mp3", Status: status}})
		body := `{"url":"http://` + peer.authority() + `/nobody.mp3","category":"bgm","filename":"nobody.mp3"}`
		request := httptest.NewRequest(http.MethodPost, "/api/assets/download", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)

		if recorder.Code != http.StatusInternalServerError {
			t.Fatalf("upstream %d: status = %d, want 500 (body %q)", status, recorder.Code, recorder.Body.String())
		}
		if calls := peer.takeCalls(); len(calls) != 1 {
			t.Fatalf("upstream %d: %d outbound request(s), want 1", status, len(calls))
		}
		if _, err := os.Stat(filepath.Join(userRootPath(dataRoot), "assets", "bgm", "nobody.mp3")); err == nil {
			t.Fatalf("upstream %d: the route wrote an asset file for a null-body response", status)
		}
	}
}

// assetsDownloadComparableTree drops the entries under assets/temp, which the fixture classifies
// `shape`: pinned unlinks the temp file after the response is sent, and on Windows that unlink races
// the write stream's handle close, so the file survives in some runs and not others (the committed
// fixture once recorded temp/note.txt; four consecutive re-records of the same input recorded none).
// The temp DIRECTORY is kept, because ensureFoldersExist creates it deterministically. GoTavern's own
// temp removal is deterministic and is asserted by TestAssetsDownloadRemovesTheTempPath.
func assetsDownloadComparableTree(entries []userDataEntry) []userDataEntry {
	filtered := make([]userDataEntry, 0, len(entries))
	for _, entry := range entries {
		if strings.HasPrefix(entry.Path, "temp/") {
			continue
		}
		filtered = append(filtered, entry)
	}
	return filtered
}

// TestAssetsDownloadRemovesTheTempPath is a LABELLED DERIVATION (AGENTS.md rule 4), not an oracle: no
// fixture can record the pinned temp-file end state, because the pinned unlink races the write
// stream's handle close on Windows (measured: one leaked entry in the committed fixture, none in
// four re-records of the same input). The pinned SOURCE unlinks in both branches (assets.js:246 and
// :253), so the deterministic Go behaviour asserted here is the intent of the pinned code, and the
// fixture records the limitation instead of a value.
func TestAssetsDownloadRemovesTheTempPath(t *testing.T) {
	dataRoot := t.TempDir()
	account := sdFixtureAccount{Handle: "default-user", Name: "Assets Download Probe", Admin: true}
	handler, sessionCookie, token := contentRouteHandler(t, dataRoot, "gotavern-assets-download-temp-secret", account, []string{"127.0.0.1"})
	peer := newAssetsDownloadPeer(t)
	t.Cleanup(peer.close)
	userRoot := userRootPath(dataRoot)

	post := func(name, body string) *httptest.ResponseRecorder {
		request := httptest.NewRequest(http.MethodPost, "/api/assets/download", strings.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("Cookie", sessionCookie)
		request.Header.Set("X-CSRF-Token", token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200 (body %q)", name, recorder.Code, recorder.Body.String())
		}
		return recorder
	}

	// A stale temp file must not survive the request, and it must not block the write either.
	seedUserDataFile(t, dataRoot, "assets/temp/one.mp3", "STALE-TEMP")
	peer.setRule([]assetsDownloadUpstream{{Match: "/audio/one.mp3", Status: 200, Headers: map[string]string{"content-type": "audio/mpeg"}, Body: "FRESH"}})
	post("stale temp", `{"url":"http://`+peer.authority()+`/audio/one.mp3","category":"bgm","filename":"one.mp3"}`)
	if _, err := os.Stat(filepath.Join(userRoot, "assets", "temp", "one.mp3")); err == nil {
		t.Fatal("the temp path survived a successful download")
	}
	written, err := os.ReadFile(filepath.Join(userRoot, "assets", "bgm", "one.mp3"))
	if err != nil || string(written) != "FRESH" {
		t.Fatalf("asset file = %q (err %v), want the downloaded bytes", written, err)
	}

	// The character branch answers the bytes and must leave no temp file behind either.
	peer.setRule([]assetsDownloadUpstream{{Match: "/img/hero.png", Status: 200, Headers: map[string]string{"content-type": "image/png"}, Body: "PNG-DL"}})
	recorder := post("character", `{"url":"http://`+peer.authority()+`/img/hero.png","category":"character","filename":"hero.png"}`)
	if recorder.Body.String() != "PNG-DL" {
		t.Fatalf("character body = %q, want the downloaded bytes", recorder.Body.String())
	}
	if _, err := os.Stat(filepath.Join(userRoot, "assets", "temp", "hero.png")); err == nil {
		t.Fatal("the character branch left a temp file behind")
	}
	if _, err := os.Stat(filepath.Join(userRoot, "assets", "character", "hero.png")); err == nil {
		t.Fatal("the character branch wrote the asset into the category directory")
	}
}

// verifyAssetsDownloadFixture fails closed when the fixture stops covering what it claims: the four
// guards, the forwarding steps, and a status that is actually compared for every step.
func verifyAssetsDownloadFixture(t *testing.T, fixture assetsDownloadFixture) {
	t.Helper()
	byName := map[string]assetsDownloadInput{}
	for _, step := range fixture.Inputs.Steps {
		byName[step.Name] = step
	}
	for _, name := range assetsDownloadGuardSteps {
		step, exists := byName[name]
		if !exists {
			t.Fatalf("fixture no longer records the %q guard", name)
		}
		observation, exists := fixture.Observations[name]
		if !exists {
			t.Fatalf("fixture has no observation for %q", name)
		}
		if len(observation.Outbound) != 0 {
			t.Fatalf("%q is a refusal but the fixture records %d outbound request(s); the guard order is unproven", name, len(observation.Outbound))
		}
		if step.BodyText == "" {
			t.Fatalf("%q records no request body", name)
		}
	}
	for _, name := range assetsDownloadForwardSteps {
		observation, exists := fixture.Observations[name]
		if !exists {
			t.Fatalf("fixture no longer records the %q forwarding step", name)
		}
		if len(observation.Outbound) != 1 {
			t.Fatalf("%q must record exactly one outbound request, found %d", name, len(observation.Outbound))
		}
	}
	// The filename guard is the branch whose body is a message rather than a status phrase; the
	// fixture must keep it, and its content type must not be text/plain.
	filenameGuard := fixture.Observations["download.invalidFilename"]
	if filenameGuard.ContentType == nil || !strings.HasPrefix(*filenameGuard.ContentType, "text/html") {
		t.Fatalf("download.invalidFilename content type = %v, expected the pinned message body", filenameGuard.ContentType)
	}
	if filenameGuard.BodyText == "" || strings.EqualFold(filenameGuard.BodyText, "Bad Request") {
		t.Fatalf("download.invalidFilename body = %q, expected the validator's message", filenameGuard.BodyText)
	}
	for name, observation := range fixture.Observations {
		compared := map[string]bool{}
		for _, key := range observation.Comparison.Compared {
			compared[key] = true
		}
		for _, key := range []string{"status", "contentType", "contentLength", "etag", "bodyText", "bodySha256", "outbound", "tree"} {
			if !compared[key] {
				t.Fatalf("%s: %q is neither compared nor shape-classified", name, key)
			}
		}
		// The fixture's only shape field is the temp-file end state. It must be declared WITH a reason,
		// and no recorded tree may carry an entry under assets/temp: a shape field must not record a
		// value, and a re-record that puts the racy file back must fail here rather than pass.
		for _, key := range observation.Comparison.Shape {
			if strings.TrimSpace(observation.Comparison.ShapeReason[key]) == "" {
				t.Fatalf("%s: shape field %q has no reason", name, key)
			}
		}
		for _, entry := range observation.Tree {
			if strings.HasPrefix(entry.Path, "temp/") {
				t.Fatalf("%s: the recorded tree carries the racy temp entry %q; the temp end state is shape and must record no value", name, entry.Path)
			}
		}
	}
}

// assetsDownloadPeer is the controlled peer for the Go side: it records every request, answers the
// step's rule, and can drop the connection instead of answering.
type assetsDownloadPeer struct {
	server   *httptest.Server
	mu       sync.Mutex
	rule     *assetsDownloadUpstream
	requests []assetsDownloadCall
}

func newAssetsDownloadPeer(t *testing.T) *assetsDownloadPeer {
	t.Helper()
	peer := &assetsDownloadPeer{}
	peer.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer.mu.Lock()
		rule := peer.rule
		peer.requests = append(peer.requests, assetsDownloadCall{URL: "http://" + r.Host + r.URL.RequestURI(), Method: r.Method})
		peer.mu.Unlock()
		if rule == nil || rule.Throws {
			// Drop the connection without a response, which is how the client sees a peer that
			// accepted the request and then died.
			hijacker, ok := w.(http.Hijacker)
			if !ok {
				w.WriteHeader(http.StatusInternalServerError)
				return
			}
			connection, _, err := hijacker.Hijack()
			if err != nil {
				return
			}
			_ = connection.Close()
			return
		}
		for name, value := range rule.Headers {
			w.Header().Set(name, value)
		}
		status := rule.Status
		if status == 0 {
			status = http.StatusOK
		}
		w.WriteHeader(status)
		_, _ = w.Write([]byte(rule.Body))
	}))
	return peer
}

func (peer *assetsDownloadPeer) authority() string {
	return strings.TrimPrefix(peer.server.URL, "http://")
}

// port is the ephemeral port the fixture stores as <mock>. Only the port is substituted, so a
// scenario can name a different HOST (localhost) that still resolves to this peer.
func (peer *assetsDownloadPeer) port() string {
	_, port, err := net.SplitHostPort(peer.authority())
	if err != nil {
		return ""
	}
	return port
}

func (peer *assetsDownloadPeer) setRule(upstream []assetsDownloadUpstream) {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	peer.requests = nil
	if len(upstream) == 0 {
		peer.rule = nil
		return
	}
	rule := upstream[0]
	peer.rule = &rule
}

// takeCalls returns the requests since the previous call, with the peer authority normalised to
// <mock> so it can be compared with the fixture.
func (peer *assetsDownloadPeer) takeCalls() []assetsDownloadCall {
	peer.mu.Lock()
	defer peer.mu.Unlock()
	// Normalise the port (and only the port) to <mock>, so a call to localhost and a call to
	// 127.0.0.1 are each compared with the fixture's own host.
	port := peer.port()
	calls := make([]assetsDownloadCall, 0, len(peer.requests))
	for _, request := range peer.requests {
		normalized := request.URL
		if port != "" {
			normalized = strings.ReplaceAll(normalized, ":"+port, ":<mock>")
		}
		calls = append(calls, assetsDownloadCall{
			URL:    normalized,
			Method: request.Method,
		})
	}
	peer.requests = nil
	return calls
}

func (peer *assetsDownloadPeer) close() {
	if peer.server != nil {
		peer.server.Close()
	}
}
