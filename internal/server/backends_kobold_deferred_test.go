package server

// Replay of the two deferred kobold routes, from src/endpoints/backends/kobold.js:
//
//	POST /api/backends/kobold/generate          (11)
//	POST /api/backends/kobold/transcribe-audio  (190)
//
// The oracle is tests/oracle/sillytavern-1.19.0-backends-deferred.json, recorded by
// `node tools/probe-backends.mjs <pinned> <repo> deferred`, and it is the SPECIFICATION: where this
// test and the capture disagree, the capture is right.
//
// WHAT IS COMPARED, and why it is not the concatenated text:
//
//   - the STATUS, and the FULL response header set. Every header the capture records must be
//     present with the recorded value, and the response must carry NO header the capture does not
//     record (so a stray `X-Powered-By`, which SillyTavern's helmet middleware hides, fails).
//     `Date` and `X-Response-Time` are the two wall-clock values the fixture does not record;
//     `Connection`/`Keep-Alive` are transport-owned and classified `shape` in the fixture, because
//     Node answers keep-alive and Go omits both for HTTP/1.1.
//   - the CHUNK FRAMING: the Transfer-Encoding, the Content-Length when there is one, the ordered
//     list of chunk payloads (compared as exact bytes, hex) and whether the terminal zero-length
//     chunk arrived. The response is read through a raw TCP socket, because net/http's client
//     decodes exactly the framing this comparison is about.
//   - the BODY BYTES by SHA-256, and the parsed SSE event list for a streamed reply.
//   - EVERY OUTBOUND REQUEST: method, escaped target, the header lines the peer received in wire
//     order (against the capture's explicit headers plus node-fetch's recorded defaults, Host and
//     the transport Connection), and the exact body.
//   - the UPLOAD STAGING TREE before and after every scenario (`<dataRoot>/_uploads`), which is how
//     the pinned multer staging and its cleanup -- including the two 400 paths that LEAK the staged
//     file -- become observable.
//
// THE STREAMING/NON-STREAMING CONTROL. A buffered capture and a finished stream are byte-identical,
// so this test refuses to run unless the fixture contains all three framing legs:
//
//	kobold.generate.nonStream           Content-Length, no frames      (the buffered control)
//	kobold.generate.streamCompletes     chunked, 1 frame, terminated   (a stream that finished)
//	kobold.generate.streamHoldOpenAbort chunked, 1 frame, NOT terminated (a stream still open)
//
// The held-open leg is the one that discriminates a pipe from a buffer: its upstream never ends,
// so the client only receives the frame at all if the route forwarded it while the response was
// open, and the socket close that ends the test is the pinned abort path (`POST
// {api_server}/extra/abort`, recorded with no headers and no body).
//
// NOT COMPARED, and said so rather than hidden: the rendered error page a multer
// LIMIT_UNEXPECTED_FILE produces is classified `shape` in the fixture (its body is a stack trace
// with absolute paths), so that scenario compares only the status it chose -- 500, not 400 -- and
// the assertion that it made NO outbound request. The page itself is not reproduced or faked.

import (
	"bufio"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type backendsDeferredFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Conventions           map[string]string `json:"conventions"`
	ExcludedHeaders       map[string]string `json:"excludedHeaders"`
	NodeFetchWireDefaults struct {
		Headers [][2]string `json:"headers"`
	} `json:"nodeFetchWireDefaults"`
	Inputs struct {
		CookieSecret string                 `json:"cookieSecret"`
		Account      sdFixtureAccount       `json:"account"`
		Secrets      map[string]string      `json:"secrets"`
		Scenarios    []backendsDeferredCase `json:"scenarios"`
	} `json:"inputs"`
	DerivedOnly []struct {
		Branch string `json:"branch"`
		Reason string `json:"reason"`
	} `json:"derivedOnly"`
	KnownDifferences []map[string]any `json:"knownDifferences"`
}

type backendsDeferredCase struct {
	Name                      string                  `json:"name"`
	Route                     string                  `json:"route"`
	RoutePath                 string                  `json:"routePath"`
	Upstream                  []backendsDeferredMock  `json:"upstream"`
	Replayed                  bool                    `json:"replayed"`
	Peer                      string                  `json:"peer"`
	StopAfterFirstFrame       bool                    `json:"stopAfterFirstFrame"`
	DisconnectAfterFirstFrame bool                    `json:"disconnectAfterFirstFrame"`
	ExpectedOutbound          int                     `json:"expectedOutbound"`
	Observation               backendsDeferredObserve `json:"observation"`
}

type backendsDeferredMock struct {
	Match    string            `json:"match"`
	Path     string            `json:"path"`
	Status   int               `json:"status"`
	Headers  map[string]string `json:"headers"`
	Body     string            `json:"body"`
	Throws   bool              `json:"throws"`
	HoldOpen bool              `json:"holdOpen"`
}

type backendsDeferredPart struct {
	Name        string  `json:"name"`
	Filename    *string `json:"filename"`
	ContentType *string `json:"contentType"`
	Value       string  `json:"value"`
	Bytes       int     `json:"bytes"`
	SHA256      string  `json:"sha256"`
}

type backendsDeferredRequest struct {
	Kind     string                 `json:"kind"`
	Boundary string                 `json:"boundary"`
	BodyText *string                `json:"bodyText"`
	Parts    []backendsDeferredPart `json:"parts"`
}

type backendsDeferredFrame struct {
	Hex   string `json:"hex"`
	Text  string `json:"text"`
	Bytes int    `json:"bytes"`
}

type backendsDeferredFraming struct {
	TransferEncoding *string                 `json:"transferEncoding"`
	ContentLength    *string                 `json:"contentLength"`
	Frames           []backendsDeferredFrame `json:"frames"`
	Terminated       bool                    `json:"terminated"`
	ServerEnded      bool                    `json:"serverEnded"`
}

type backendsDeferredOutbound struct {
	Method          string      `json:"method"`
	URL             string      `json:"url"`
	ExplicitHeaders [][2]string `json:"explicitHeaders"`
	Body            *string     `json:"body"`
}

type backendsDeferredUpload struct {
	Name   string `json:"name"`
	Bytes  int    `json:"bytes"`
	SHA256 string `json:"sha256"`
}

type backendsDeferredObserve struct {
	Request       backendsDeferredRequest    `json:"request"`
	Status        int                        `json:"status"`
	Headers       [][2]string                `json:"headers"`
	Framing       *backendsDeferredFraming   `json:"framing"`
	BodyText      *string                    `json:"bodyText"`
	BodyBytes     *int                       `json:"bodyBytes"`
	BodySHA256    *string                    `json:"bodySha256"`
	Outbound      []backendsDeferredOutbound `json:"outbound"`
	UploadsBefore []backendsDeferredUpload   `json:"uploadsBefore"`
	UploadsAfter  []backendsDeferredUpload   `json:"uploadsAfter"`
	Comparison    struct {
		Compared    []string          `json:"compared"`
		Shape       []string          `json:"shape"`
		ShapeReason map[string]string `json:"shapeReason"`
	} `json:"comparison"`
}

func loadBackendsDeferredFixture(t *testing.T) backendsDeferredFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-backends-deferred.json"))
	if err != nil {
		t.Fatalf("read the deferred backends oracle: %v", err)
	}
	var fixture backendsDeferredFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode the deferred backends oracle: %v", err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("deferred backends oracle baseline = %+v", fixture.Baseline)
	}
	if len(fixture.Inputs.Scenarios) == 0 {
		t.Fatal("the deferred backends oracle records no scenario")
	}
	for _, scenario := range fixture.Inputs.Scenarios {
		if !scenario.Replayed {
			t.Fatalf("%s: scenario is not replayed; an unrecorded scenario must never look like a pass", scenario.Name)
		}
	}
	return fixture
}

// TestBackendsDeferredFixtureClassification refuses to let the replay pass vacuously: it asserts
// that the fixture is the fixture this test claims (ordered, classified, with all three framing
// legs), so a re-record that loses a leg fails here instead of quietly weakening the comparison.
func TestBackendsDeferredFixtureClassification(t *testing.T) {
	fixture := loadBackendsDeferredFixture(t)
	observableKeys := []string{"status", "headers", "framing", "body", "outbound", "uploads"}

	multipartScenarios := 0
	// The three framing legs are identified BY NAME, not by counting shapes: every non-chunked
	// response looks "buffered", so a count cannot tell the control from a JSON error answer.
	var control, streamed, heldOpen *backendsDeferredCase
	for index := range fixture.Inputs.Scenarios {
		scenario := &fixture.Inputs.Scenarios[index]
		classified := map[string]bool{}
		comparedAnywhere := map[string]bool{}
		for _, key := range scenario.Observation.Comparison.Compared {
			classified[key] = true
			comparedAnywhere[key] = true
		}
		for _, key := range scenario.Observation.Comparison.Shape {
			classified[key] = true
			if strings.TrimSpace(scenario.Observation.Comparison.ShapeReason[key]) == "" {
				t.Fatalf("%s: shape field %q carries no reason", scenario.Name, key)
			}
		}
		for _, key := range observableKeys {
			if !classified[key] {
				t.Fatalf("%s: observable %q is neither compared nor shape-classified", scenario.Name, key)
			}
		}
		if !classified["status"] || !classified["outbound"] {
			t.Fatalf("%s: status and outbound must always be compared", scenario.Name)
		}
		if scenario.Observation.Request.Kind == "multipart" {
			multipartScenarios++
			if len(scenario.Observation.Request.Parts) == 0 {
				t.Fatalf("%s: the multipart request records zero parts, which looks exactly like \"never sent\"", scenario.Name)
			}
			for _, part := range scenario.Observation.Request.Parts {
				if part.Bytes == 0 || part.SHA256 == "" || part.Value == "" {
					t.Fatalf("%s: part %q records no content, so the replay could not rebuild the upload", scenario.Name, part.Name)
				}
			}
		}
		framing := scenario.Observation.Framing
		if framing == nil {
			continue
		}
		switch scenario.Name {
		case "kobold.generate.nonStream":
			control = scenario
		case "kobold.generate.streamCompletes":
			streamed = scenario
		case "kobold.generate.streamHoldOpenAbort":
			heldOpen = scenario
		}
	}
	if multipartScenarios < 5 {
		t.Fatalf("only %d multipart scenario(s) record a parsed part list", multipartScenarios)
	}
	if control == nil || streamed == nil || heldOpen == nil {
		t.Fatalf("the fixture lost a framing leg: non-stream control %t, finished stream %t, held-open stream %t",
			control != nil, streamed != nil, heldOpen != nil)
	}
	controlFraming := control.Observation.Framing
	if controlFraming.TransferEncoding != nil || controlFraming.ContentLength == nil || len(controlFraming.Frames) != 0 {
		t.Fatalf("the non-stream control does not look buffered: %+v", *controlFraming)
	}
	streamedFraming := streamed.Observation.Framing
	if streamedFraming.TransferEncoding == nil || len(streamedFraming.Frames) == 0 || !streamedFraming.Terminated {
		t.Fatalf("the finished-stream leg does not look streamed and terminated: %+v", *streamedFraming)
	}
	heldOpenFraming := heldOpen.Observation.Framing
	if heldOpenFraming.TransferEncoding == nil || len(heldOpenFraming.Frames) == 0 || heldOpenFraming.Terminated {
		t.Fatalf("the held-open leg must be stream-framed and NOT terminated, or it proves nothing about forwarding: %+v",
			*heldOpenFraming)
	}
	if heldOpen.ExpectedOutbound < 2 {
		t.Fatalf("the held-open leg records %d outbound request(s); the abort request is the observable", heldOpen.ExpectedOutbound)
	}
	if len(fixture.DerivedOnly) == 0 {
		t.Fatal("the fixture records no derivedOnly branch, but two pinned branches are unreachable and must be labelled")
	}
	if len(fixture.Inputs.Secrets) == 0 {
		t.Fatal("the fixture records no secrets, so the api-type key branches could not be exercised")
	}
}

func TestPinnedNodeBackendsDeferredKoboldRoutes(t *testing.T) {
	fixture := loadBackendsDeferredFixture(t)

	dataRoot := t.TempDir()
	// A real install creates <dataRoot>/_uploads at startup (startup's data-startup step); the
	// pinned multer middleware and this route both require it, so the replay creates it too.
	if err := os.MkdirAll(filepath.Join(dataRoot, "_uploads"), 0o777); err != nil {
		t.Fatal(err)
	}
	handler, sessionCookie, csrfToken := backendsRouteHandler(t, dataRoot, fixture.Inputs.CookieSecret, fixture.Inputs.Account)
	server := httptest.NewServer(handler)
	defer server.Close()

	peer := mockprovider.NewKeyed(nil)
	address, err := peer.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	defer peer.Close()
	mockOrigin := "http://" + address.String()
	mockAuthority := address.String()
	closedOrigin := closedLoopbackOrigin(t)

	for _, scenario := range fixture.Inputs.Scenarios {
		t.Run(scenario.Name, func(t *testing.T) {
			// Scenarios share ONE data root and are iterated in recorded order: the transcribe 400
			// paths leave a staged upload behind, so step N observes what step N-1 left.
			writeSDSecrets(t, dataRoot, fixture.Inputs.Account.Handle, fixture.Inputs.Secrets)
			peer.Reset(deferredPeerScript(t, scenario, mockOrigin))

			requestBody, contentType, origin := deferredRequest(t, scenario, mockOrigin, closedOrigin)
			uploadsBefore := deferredUploads(t, dataRoot)
			if got, want := deferredUploadNames(uploadsBefore), deferredUploadNames(scenario.Observation.UploadsBefore); got != want {
				t.Fatalf("staging tree before the request = %s, the capture has %s", got, want)
			}

			headerLines := [][2]string{
				{"Cookie", sessionCookie},
				{"X-CSRF-Token", csrfToken},
				{"Content-Type", contentType},
			}
			response, connection := deferredExchange(t, server.URL, scenario.RoutePath, headerLines, requestBody,
				scenario.StopAfterFirstFrame, scenario.Observation.Framing == nil)

			deferredCompareStatus(t, scenario, response)
			deferredCompareHeaders(t, scenario, response)
			deferredCompareFraming(t, scenario, response)
			deferredCompareBody(t, scenario, response)

			// The pinned route answers a socket close from its close handler, and for the held-open
			// scenarios that close IS the observable: it is what sends the abort request. The abort
			// is asynchronous, so the drain waits for the request the capture REQUIRES; a scenario
			// that expects none is measured with the same window the positive one calibrates, and
			// the count comparison fails loudly either way.
			_ = connection.Close()
			// A closed-peer scenario dials the convention's closed port, so the recording peer must
			// receive NOTHING and there is nothing to wait for.
			expectedOutbound := scenario.ExpectedOutbound
			if scenario.Peer == "closed" {
				expectedOutbound = 0
			}
			outbound := waitForDeferredOutbound(peer, expectedOutbound)
			deferredCompareOutbound(t, fixture, scenario, outbound, mockOrigin, mockAuthority, origin)

			uploadsAfter := deferredUploads(t, dataRoot)
			if got, want := deferredUploadNames(uploadsAfter), deferredUploadNames(scenario.Observation.UploadsAfter); got != want {
				t.Fatalf("staging tree after the request = %s, the capture has %s (the pinned route unlinks its staged file on the paths that reach the fetch, and leaves it on the two 400 paths)",
					got, want)
			}
			if scenario.Peer != "closed" && len(scenario.Upstream) == scenario.ExpectedOutbound {
				if unused := peer.Unused(); len(unused) > 0 {
					t.Fatalf("the peer script was not fully consumed; unused %v", unused)
				}
			}
		})
	}
}

// deferredPeerScript pairs each recorded upstream answer with the method of the recorded outbound
// request that reached it. The pinned stub matches on a URL substring, so the scenario's answers
// are keyed by path; the method comes from the capture, which is the authoritative record of what
// the route sent.
func deferredPeerScript(t *testing.T, scenario backendsDeferredCase, mockOrigin string) map[string][]mockprovider.Response {
	t.Helper()
	script := map[string][]mockprovider.Response{}
	for _, upstream := range scenario.Upstream {
		path := upstream.Path
		if path == "" {
			path = upstream.Match
		}
		method := http.MethodPost
		for _, outbound := range scenario.Observation.Outbound {
			target, err := url.Parse(strings.ReplaceAll(outbound.URL, "<mock>", mockOrigin))
			if err == nil && target.EscapedPath() == path {
				method = outbound.Method
				break
			}
		}
		names := make([]string, 0, len(upstream.Headers))
		for name := range upstream.Headers {
			names = append(names, name)
		}
		sort.Strings(names)
		headers := make([]mockprovider.Header, 0, len(names))
		for _, name := range names {
			headers = append(headers, mockprovider.Header{Name: name, Value: upstream.Headers[name]})
		}
		key := method + " " + path
		script[key] = append(script[key], mockprovider.Response{
			Status:    upstream.Status,
			Headers:   headers,
			Body:      strings.ReplaceAll(upstream.Body, "<mock>", mockOrigin),
			NeverEnds: upstream.HoldOpen,
		})
	}
	return script
}

// deferredRequest rebuilds the request the probe sent. The body is the recorded request text (or
// the recorded parsed part list, rebuilt with the SAME fixed boundary) with the peer origin
// substituted, so member order and escaping are exactly the recorded ones.
func deferredRequest(t *testing.T, scenario backendsDeferredCase, mockOrigin, closedOrigin string) ([]byte, string, string) {
	t.Helper()
	origin := mockOrigin
	if scenario.Peer == "closed" {
		origin = closedOrigin
	}
	port := ""
	if parsed, err := url.Parse(mockOrigin); err == nil {
		port = parsed.Port()
	}
	substitute := func(value string) string {
		return strings.ReplaceAll(strings.ReplaceAll(value, "<mock>", origin), "<port>", port)
	}
	if scenario.Observation.Request.Kind == "multipart" {
		parts := scenario.Observation.Request.Parts
		if len(parts) == 0 {
			t.Fatalf("%s: the multipart request records zero parts", scenario.Name)
		}
		boundary := scenario.Observation.Request.Boundary
		var body bytes.Buffer
		for _, part := range parts {
			body.WriteString("--" + boundary + "\r\n")
			body.WriteString(`Content-Disposition: form-data; name="` + part.Name + `"`)
			if part.Filename != nil {
				body.WriteString(`; filename="` + *part.Filename + `"`)
			}
			body.WriteString("\r\n")
			if part.ContentType != nil {
				body.WriteString("Content-Type: " + *part.ContentType + "\r\n")
			}
			body.WriteString("\r\n")
			body.WriteString(substitute(part.Value))
			body.WriteString("\r\n")
		}
		body.WriteString("--" + boundary + "--\r\n")
		return body.Bytes(), "multipart/form-data; boundary=" + boundary, origin
	}
	if scenario.Observation.Request.BodyText == nil {
		t.Fatalf("%s: the recorded request carries no body text", scenario.Name)
	}
	return []byte(substitute(*scenario.Observation.Request.BodyText)), "application/json", origin
}

type backendsDeferredRawFrame struct {
	hex   string
	bytes int
}

type backendsDeferredRawResponse struct {
	status           int
	headers          [][2]string
	transferEncoding string
	contentLength    string
	frames           []backendsDeferredRawFrame
	terminated       bool
	body             []byte
}

// deferredExchange performs the request over a raw socket and parses the response framing itself.
// `headOnly` stops after the header block, for the one scenario whose body is a rendered error page
// the fixture does not record; `stopAfterFirstFrame` returns while a held-open response is still
// open, which is the whole point of that scenario.
func deferredExchange(t *testing.T, origin, routePath string, headerLines [][2]string, body []byte, stopAfterFirstFrame, headOnly bool) (backendsDeferredRawResponse, net.Conn) {
	t.Helper()
	parsed, err := url.Parse(origin)
	if err != nil {
		t.Fatalf("parse the test server origin: %v", err)
	}
	connection, err := net.DialTimeout("tcp", parsed.Host, 10*time.Second)
	if err != nil {
		t.Fatalf("dial the test server: %v", err)
	}
	if err := connection.SetDeadline(time.Now().Add(30 * time.Second)); err != nil {
		t.Fatalf("set the exchange deadline: %v", err)
	}
	var head bytes.Buffer
	head.WriteString("POST " + routePath + " HTTP/1.1\r\n")
	head.WriteString("Host: " + parsed.Host + "\r\n")
	for _, header := range headerLines {
		head.WriteString(header[0] + ": " + header[1] + "\r\n")
	}
	head.WriteString("Content-Length: " + strconv.Itoa(len(body)) + "\r\n\r\n")
	if _, err := connection.Write(head.Bytes()); err != nil {
		t.Fatalf("write the request head: %v", err)
	}
	if len(body) > 0 {
		if _, err := connection.Write(body); err != nil {
			t.Fatalf("write the request body: %v", err)
		}
	}

	reader := bufio.NewReader(connection)
	statusLine, err := reader.ReadString('\n')
	if err != nil {
		t.Fatalf("read the status line (the route may have closed the connection without answering): %v", err)
	}
	fields := strings.SplitN(strings.TrimRight(statusLine, "\r\n"), " ", 3)
	if len(fields) < 2 {
		t.Fatalf("malformed status line %q", statusLine)
	}
	status, convErr := strconv.Atoi(fields[1])
	if convErr != nil {
		t.Fatalf("malformed status %q", fields[1])
	}
	response := backendsDeferredRawResponse{status: status}
	for {
		line, readErr := reader.ReadString('\n')
		if readErr != nil {
			t.Fatalf("read the response headers: %v", readErr)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			break
		}
		name, value, found := strings.Cut(line, ":")
		if !found {
			t.Fatalf("malformed header line %q", line)
		}
		response.headers = append(response.headers, [2]string{strings.ToLower(name), strings.TrimLeft(value, " \t")})
	}
	response.transferEncoding = deferredHeader(response.headers, "transfer-encoding")
	response.contentLength = deferredHeader(response.headers, "content-length")
	if headOnly {
		return response, connection
	}
	if strings.Contains(strings.ToLower(response.transferEncoding), "chunked") {
		collected := make([]byte, 0, 256)
		for {
			sizeLine, readErr := reader.ReadString('\n')
			if readErr != nil {
				t.Fatalf("read a chunk size (frames so far %d): %v", len(response.frames), readErr)
			}
			size, convErr := strconv.ParseInt(strings.TrimSpace(strings.SplitN(sizeLine, ";", 2)[0]), 16, 64)
			if convErr != nil {
				t.Fatalf("malformed chunk size %q", sizeLine)
			}
			if size == 0 {
				// Consume the trailing CRLF that terminates the chunked body.
				if _, readErr := reader.ReadString('\n'); readErr != nil && readErr != io.EOF {
					t.Fatalf("read the chunked terminator: %v", readErr)
				}
				response.terminated = true
				break
			}
			payload := make([]byte, size)
			if _, readErr := io.ReadFull(reader, payload); readErr != nil {
				t.Fatalf("read a chunk payload: %v", readErr)
			}
			if _, readErr := reader.Discard(2); readErr != nil {
				t.Fatalf("discard the chunk framing: %v", readErr)
			}
			response.frames = append(response.frames, backendsDeferredRawFrame{hex: hex.EncodeToString(payload), bytes: len(payload)})
			collected = append(collected, payload...)
			if stopAfterFirstFrame {
				response.body = collected
				return response, connection
			}
		}
		response.body = collected
		return response, connection
	}
	if response.contentLength != "" {
		length, convErr := strconv.Atoi(response.contentLength)
		if convErr != nil {
			t.Fatalf("malformed content-length %q", response.contentLength)
		}
		payload := make([]byte, length)
		if _, readErr := io.ReadFull(reader, payload); readErr != nil {
			t.Fatalf("read the declared body: %v", readErr)
		}
		response.body = payload
		return response, connection
	}
	payload, _ := io.ReadAll(reader)
	response.body = payload
	return response, connection
}

func deferredHeader(headers [][2]string, name string) string {
	for _, header := range headers {
		if header[0] == name {
			return header[1]
		}
	}
	return ""
}

func deferredCompareStatus(t *testing.T, scenario backendsDeferredCase, response backendsDeferredRawResponse) {
	t.Helper()
	if response.status != scenario.Observation.Status {
		t.Fatalf("status = %d, pinned Node has %d (body %q)",
			response.status, scenario.Observation.Status, string(response.body))
	}
}

// deferredCompareHeaders compares the header SET in both directions: every recorded header must be
// present with the recorded value, and no extra header may be invented. The two wall-clock headers
// the fixture does not record are skipped; the two transport headers it classifies `shape` are
// skipped with their reason recorded in the fixture.
func deferredCompareHeaders(t *testing.T, scenario backendsDeferredCase, response backendsDeferredRawResponse) {
	t.Helper()
	observation := scenario.Observation
	if observation.Headers == nil {
		// Classified shape: a rendered error page's header set belongs to the error renderer.
		return
	}
	shape := map[string]bool{}
	for _, key := range observation.Comparison.Shape {
		shape[strings.TrimPrefix(key, "headers.")] = true
	}
	recorded := map[string]string{}
	var order []string
	for _, header := range observation.Headers {
		recorded[header[0]] = header[1]
		order = append(order, header[0])
	}
	observed := map[string]string{}
	for _, header := range response.headers {
		if header[0] == "date" || header[0] == "x-response-time" {
			continue
		}
		observed[header[0]] = header[1]
	}
	for _, name := range order {
		if shape[name] {
			continue
		}
		value, exists := observed[name]
		if !exists {
			t.Fatalf("response header %q is missing; pinned Node sends %q", name, recorded[name])
		}
		if value != recorded[name] {
			t.Fatalf("response header %q = %q, pinned Node sends %q", name, value, recorded[name])
		}
	}
	for name, value := range observed {
		if shape[name] {
			continue
		}
		if _, exists := recorded[name]; !exists {
			t.Fatalf("response carries header %q = %q, which pinned Node does not send", name, value)
		}
	}
}

func deferredCompareFraming(t *testing.T, scenario backendsDeferredCase, response backendsDeferredRawResponse) {
	t.Helper()
	want := scenario.Observation.Framing
	if want == nil {
		return
	}
	wantTransferEncoding := ""
	if want.TransferEncoding != nil {
		wantTransferEncoding = *want.TransferEncoding
	}
	if response.transferEncoding != wantTransferEncoding {
		t.Fatalf("Transfer-Encoding = %q, pinned Node answers %q", response.transferEncoding, wantTransferEncoding)
	}
	wantContentLength := ""
	if want.ContentLength != nil {
		wantContentLength = *want.ContentLength
	}
	if response.contentLength != wantContentLength {
		t.Fatalf("Content-Length = %q, pinned Node answers %q", response.contentLength, wantContentLength)
	}
	if response.terminated != want.Terminated {
		t.Fatalf("chunked terminator = %t, pinned Node has %t (a response still open when the client leaves has no terminal chunk)",
			response.terminated, want.Terminated)
	}
	if len(response.frames) != len(want.Frames) {
		t.Fatalf("the response arrived in %d chunk frame(s), pinned Node in %d: %v vs %v",
			len(response.frames), len(want.Frames), deferredObservedFrameShapes(response.frames), deferredRecordedFrameShapes(want.Frames))
	}
	for index := range want.Frames {
		if response.frames[index].hex != want.Frames[index].Hex {
			t.Fatalf("chunk frame %d = %q, pinned Node sent %q", index, response.frames[index].hex, want.Frames[index].Hex)
		}
	}
}

func deferredObservedFrameShapes(frames []backendsDeferredRawFrame) []string {
	shapes := make([]string, 0, len(frames))
	for _, frame := range frames {
		payload, _ := hex.DecodeString(frame.hex)
		shapes = append(shapes, fmt.Sprintf("%dB:%s", frame.bytes, string(payload)))
	}
	return shapes
}

func deferredRecordedFrameShapes(frames []backendsDeferredFrame) []string {
	shapes := make([]string, 0, len(frames))
	for _, frame := range frames {
		shapes = append(shapes, fmt.Sprintf("%dB:%s", frame.Bytes, frame.Text))
	}
	return shapes
}

func deferredCompareBody(t *testing.T, scenario backendsDeferredCase, response backendsDeferredRawResponse) {
	t.Helper()
	observation := scenario.Observation
	if observation.BodySHA256 == nil {
		return
	}
	digest := sha256.Sum256(response.body)
	if hex.EncodeToString(digest[:]) != *observation.BodySHA256 {
		t.Fatalf("response body = %q (sha256 %s), pinned Node answered %q (sha256 %s)",
			string(response.body), hex.EncodeToString(digest[:]), *observation.BodyText, *observation.BodySHA256)
	}
}

// waitForDeferredOutbound polls until the peer has recorded the number of requests the capture
// expects. A scenario that expects ZERO is measured with the same window the positive scenarios
// calibrate, and the comparison below still fails when the count is wrong either way.
// deferredOutboundSettle is the window in which an EXTRA request is looked for after the expected
// count arrives. A request that must not arrive is only observed by waiting for it: without the
// settle window the abort negative could not fail, and a mutation that ignored `can_abort` survived
// CI until this was added (the abort is issued after the response the expected request produced).
const deferredOutboundSettle = 500 * time.Millisecond

func waitForDeferredOutbound(peer *mockprovider.KeyedRecorder, expected int) mockprovider.Recording {
	deadline := time.Now().Add(8 * time.Second)
	var settledAt time.Time
	for {
		recording := peer.Recording()
		if len(recording.Requests) >= expected {
			if settledAt.IsZero() {
				settledAt = time.Now().Add(deferredOutboundSettle)
			}
			if time.Now().After(settledAt) {
				return recording
			}
		} else if time.Now().After(deadline) {
			return recording
		}
		time.Sleep(25 * time.Millisecond)
	}
}

func deferredCompareOutbound(t *testing.T, fixture backendsDeferredFixture, scenario backendsDeferredCase, recording mockprovider.Recording, mockOrigin, mockAuthority, origin string) {
	t.Helper()
	expected := scenario.Observation.Outbound
	if scenario.Peer == "closed" {
		// The pinned stub recorded the attempt before the fetch threw; the Go side dials the
		// convention's closed port, so the recording peer must see nothing at all.
		if len(recording.Requests) != 0 {
			t.Fatalf("a closed-peer scenario reached the recording peer %d time(s)", len(recording.Requests))
		}
		return
	}
	if len(recording.Requests) != len(expected) {
		sent := make([]string, 0, len(recording.Requests))
		for _, request := range recording.Requests {
			sent = append(sent, request.Method+" "+request.RawTarget)
		}
		t.Fatalf("the peer received %d request(s) %v, pinned Node made %d", len(recording.Requests), sent, len(expected))
	}
	for index, want := range expected {
		actual := recording.Requests[index]
		if actual.Method != want.Method {
			t.Fatalf("request %d method = %s, pinned Node sent %s", index, actual.Method, want.Method)
		}
		wantTarget := searchExpectedTarget(t, strings.ReplaceAll(want.URL, "<port>", mockAuthorityPort(mockAuthority)))
		if actual.RawTarget != wantTarget {
			t.Fatalf("request %d target = %q, pinned Node sent %q", index, actual.RawTarget, wantTarget)
		}
		wantBody := ""
		if want.Body != nil {
			wantBody = strings.ReplaceAll(*want.Body, "<mock>", origin)
		}
		actualBody := ""
		if actual.BodyText != nil {
			actualBody = *actual.BodyText
		}
		if actualBody != wantBody {
			t.Fatalf("request %d body = %q, pinned Node sent %q", index, actualBody, wantBody)
		}
		// The dialled host is compared for every body-URL route, which is what makes the pinned
		// `localhost` -> `127.0.0.1` rewrite observable.
		wantHost := ""
		if strings.HasPrefix(want.URL, "<mock>") {
			wantHost = mockAuthority
		} else if parsed, err := url.Parse(strings.ReplaceAll(want.URL, "<port>", mockAuthorityPort(mockAuthority))); err == nil {
			wantHost = parsed.Host
		}
		actualHost := ""
		for _, header := range actual.Headers {
			if strings.EqualFold(header.Name, "host") {
				actualHost = header.Value
			}
		}
		if backendsHostname(t, wantHost) != backendsHostname(t, actualHost) {
			t.Fatalf("request %d dialled host %q, pinned Node dialled %q", index, actualHost, wantHost)
		}
		compareBackendsHeaderLines(t, scenario.Name, index, deferredExpectedWireHeaders(fixture, want, wantBody, mockAuthority), actual.Headers, deferredExplicitConnection(want))
	}
}

func mockAuthorityPort(authority string) string {
	if _, port, err := net.SplitHostPort(authority); err == nil {
		return port
	}
	return ""
}

func deferredExplicitConnection(expected backendsDeferredOutbound) bool {
	for _, header := range expected.ExplicitHeaders {
		if strings.EqualFold(header[0], "connection") {
			return true
		}
	}
	return false
}

// deferredExpectedWireHeaders is the wire header list node-fetch writes: the capture's recorded
// defaults, Content-Length for a body, the route's explicit headers (lowercased and sorted, which
// is node-fetch's own Header ordering), then Host, then the transport Connection.
func deferredExpectedWireHeaders(fixture backendsDeferredFixture, expected backendsDeferredOutbound, materializedBody, mockAuthority string) [][2]string {
	values := map[string]string{}
	for _, header := range fixture.NodeFetchWireDefaults.Headers {
		values[header[0]] = header[1]
	}
	if expected.Body != nil {
		values["content-length"] = strconv.Itoa(len(materializedBody))
	}
	for _, header := range expected.ExplicitHeaders {
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

// deferredUploads snapshots <dataRoot>/_uploads. multer's staging filename is random, so the
// snapshot is the multiset of (size, digest) the pinned fixture records, in sorted order.
func deferredUploads(t *testing.T, dataRoot string) []backendsDeferredUpload {
	t.Helper()
	directory := filepath.Join(dataRoot, "_uploads")
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read the upload staging directory: %v", err)
	}
	uploads := make([]backendsDeferredUpload, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		content, readErr := os.ReadFile(filepath.Join(directory, entry.Name()))
		if readErr != nil {
			t.Fatalf("read a staged upload: %v", readErr)
		}
		digest := sha256.Sum256(content)
		uploads = append(uploads, backendsDeferredUpload{Name: "<upload>", Bytes: len(content), SHA256: hex.EncodeToString(digest[:])})
	}
	sort.Slice(uploads, func(left, right int) bool { return uploads[left].SHA256 < uploads[right].SHA256 })
	return uploads
}

func deferredUploadNames(uploads []backendsDeferredUpload) string {
	parts := make([]string, 0, len(uploads))
	for _, upload := range uploads {
		parts = append(parts, fmt.Sprintf("%dB:%s", upload.Bytes, upload.SHA256[:12]))
	}
	return "[" + strings.Join(parts, " ") + "]"
}
