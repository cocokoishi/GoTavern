package e2e

// THE DEEPSEEK END-TO-END TEST: the route the user's traffic actually takes.
//
// P0-A ("cannot reach the DeepSeek server") was fixed by giving provider traffic a production
// transport, and every gate that exists for it is a UNIT gate: internal/outbound's matrix drives
// `Send`/`SendStreaming` directly, and the provider-wire replay pins the wire-exact client inside
// internal/server's test binary. Neither can say "a browser-shaped request to
// POST /api/backends/chat-completions/generate, in the shipped binary, with the key the frontend
// stored, reaches a provider over the production transport and its answer comes back intact". That is
// the sentence this file asserts.
//
// WHAT IS REAL HERE, and what is not:
//
//	real  the binary (cmd/gotavern, built from this tree), the HTTP listener, the route and its
//	      dispatch, the secrets store written through POST /api/secrets/write, the DEEPSEEK plan and
//	      response mapping, the PRODUCTION transport and its socket to the peer;
//	stub  the provider itself (tests/mockprovider), reached by pointing the DEEPSEEK base URL at it.
//	      The seam used is GOTAVERN_DEEPSEEK_CHAT_URL -- the same one the provider-wire fixture
//	      declares for this source (scenario.goSeam) and the same value the fixture pins as the
//	      production literal, because `API_DEEPSEEK` is a hardcoded constant in the pinned route.
//	      It changes the HOST ONLY: scheme, path, method, headers, body and the client that carries
//	      them are the production ones, and the transport is proven below rather than assumed.
//	      HTTPS is deliberately NOT required for what is asserted: the claim is about the route, the
//	      client and the request/response mapping. The TLS handshake, the proxy CONNECT and the
//	      redirect/timeout bounds live one layer down and are measured by
//	      internal/outbound/transport_matrix_test.go against a TLS server; a peer that terminated TLS
//	      would add a certificate to this harness without adding a single new observable to the claim.
//
// THE EXPECTATIONS COME FROM THE CAPTURE, NOT FROM THIS FILE (differential doctrine 1 and 4): the
// driver bodies are the recorded browser-equivalent requests, the expected provider body digest is the
// recorded one, the expected completion text is the recorded provider reply, the stream frames are the
// recorded ones, and the provider-error status is the recorded answer. The one thing this file supplies
// is the synthetic API key, which is what a user would type, and it is asserted to arrive at the peer
// as `Authorization: Bearer <that key>` -- a key that never arrives is the P0-A symptom itself.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

const (
	// generateRoute is the route the unmodified frontend posts a chat completion to.
	generateRoute = "/api/backends/chat-completions/generate"

	// deepSeekSecretKey is the key `pinnedReadSecret` looks for (internal/server/deepseek_chat.go:51);
	// it is written below the way the frontend writes it.
	deepSeekSecretKey = "api_key_deepseek"

	// syntheticDeepSeekKey is what this test "types into" the settings panel. It is not a credential:
	// the peer never verifies it, and its only job is to prove the stored key reaches the wire.
	syntheticDeepSeekKey = "gotavern-e2e-synthetic-deepseek-key"
)

// providerWireScenario is the part of tests/oracle/sillytavern-1.19.0-provider-wire.json this file
// reads. RawMessage is used for the bodies so the capture's own bytes are forwarded, and so a body this
// file did not expect shows up as a decode failure naming the scenario instead of as a zero value.
type providerWireScenario struct {
	HTTP struct {
		Requests []struct {
			Method     string          `json:"method"`
			Path       string          `json:"path"`
			Body       json.RawMessage `json:"body"`
			BodySHA256 string          `json:"bodySha256"`
		} `json:"requests"`
	} `json:"http"`
	Provider struct {
		Requests []struct {
			Method     string `json:"method"`
			RawTarget  string `json:"rawTarget"`
			BodyText   string `json:"bodyText"`
			BodyLength int    `json:"bodyLength"`
			BodySHA256 string `json:"bodySha256"`
		} `json:"requests"`
	} `json:"provider"`
	ProviderResponse struct {
		Status int `json:"status"`
		Events []struct {
			Data string `json:"data"`
		} `json:"events"`
		Body json.RawMessage `json:"body"`
	} `json:"providerResponse"`
	GoSeam *struct {
		EnvironmentVariable string `json:"environmentVariable"`
		PinnedLiteral       string `json:"pinnedLiteral"`
	} `json:"goSeam"`
}

type providerWireFixture struct {
	Baseline struct {
		Version string `json:"version"`
		Commit  string `json:"commit"`
	} `json:"baseline"`
	Scenarios map[string]providerWireScenario `json:"scenarios"`
}

func loadProviderWireFixture(t *testing.T) providerWireFixture {
	t.Helper()
	path := filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json")
	payload, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("the provider-wire capture is missing (%s); without it this test has no oracle and "+
			"must not substitute one of its own: %v", path, err)
	}
	var fixture providerWireFixture
	if err := json.Unmarshal(payload, &fixture); err != nil {
		t.Fatalf("decode %s: %v", path, err)
	}
	if fixture.Baseline.Version != "1.19.0" || fixture.Baseline.Commit != "06bde939fb1e9c4c8d8641d810f0a916b5bce127" {
		t.Fatalf("provider-wire baseline = %+v, want SillyTavern 1.19.0 / 06bde939", fixture.Baseline)
	}
	return fixture
}

// scenario refuses a capture that cannot support the assertions below: no driver request, no provider
// request, no digests. A re-record that dropped any of them must fail here rather than pass vacuous.
func (fixture providerWireFixture) scenario(t *testing.T, name string) providerWireScenario {
	t.Helper()
	scenario, present := fixture.Scenarios[name]
	if !present {
		t.Fatalf("the capture has no %q scenario, so that observable is unproven", name)
	}
	if len(scenario.HTTP.Requests) != 1 {
		t.Fatalf("%s: the capture records %d driver requests, this test drives exactly one",
			name, len(scenario.HTTP.Requests))
	}
	if len(scenario.HTTP.Requests[0].Body) == 0 || scenario.HTTP.Requests[0].BodySHA256 == "" {
		t.Fatalf("%s: the capture records no driver body or no digest for it", name)
	}
	if len(scenario.Provider.Requests) != 1 {
		t.Fatalf("%s: the capture records %d provider requests, this test asserts exactly one",
			name, len(scenario.Provider.Requests))
	}
	if scenario.Provider.Requests[0].BodySHA256 == "" || scenario.Provider.Requests[0].BodyLength == 0 {
		t.Fatalf("%s: the capture records no provider body digest", name)
	}
	return scenario
}

// driverBody is the exact body the probe sent to the route, re-compacted, with its digest checked
// against the capture. The check is the point: it proves this test is driving the recorded request and
// not one it made up, so a mismatch between what the peer receives and what the capture recorded is
// about the product and not about the driver.
func (scenario providerWireScenario) driverBody(t *testing.T, name string) string {
	t.Helper()
	var compact bytes.Buffer
	if err := json.Compact(&compact, scenario.HTTP.Requests[0].Body); err != nil {
		t.Fatalf("%s: the recorded driver body is not valid JSON: %v", name, err)
	}
	body := compact.String()
	if digest := sha256Hex(body); digest != scenario.HTTP.Requests[0].BodySHA256 {
		t.Fatalf("%s: the driver body this test would send hashes to %s, but the capture recorded %s "+
			"for %d bytes. The capture's body and its digest disagree, so neither is usable as an "+
			"oracle.", name, digest, scenario.HTTP.Requests[0].BodySHA256, len(body))
	}
	return body
}

// expectedContent is the assistant text the capture recorded in the route's answer. Reading it out of
// the capture keeps the expectation on the oracle side of the boundary.
func (scenario providerWireScenario) expectedContent(t *testing.T, name string) string {
	t.Helper()
	content := completionContent(t, name, string(scenario.ProviderResponse.Body))
	if content == "" {
		t.Fatalf("%s: the capture records no assistant content, so the completion assertion would be vacuous", name)
	}
	return content
}

// completionContent extracts choices[0].message.content from a completion body.
func completionContent(t *testing.T, label, body string) string {
	t.Helper()
	var decoded struct {
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		t.Fatalf("%s: the body is not a completion: %v (body: %s)", label, err, compactForLog(body))
	}
	if len(decoded.Choices) == 0 {
		return ""
	}
	return decoded.Choices[0].Message.Content
}

// streamFrames rebuilds the wire frames the capture recorded. The capture stores the SSE `data`
// payloads, and the recording peer wrote each one as `data: <payload>\n\n`
// (scripts/generate-deepseek-scenarios.mjs:204-208), so the reconstruction is the recorded exchange
// rather than an invention. The last frame must be the provider's own sentinel: DeepSeek terminates
// with `[DONE]`, the route pipes frames verbatim, and a stream that stops without it is the
// half-closed stream the frontend waits on forever.
func (scenario providerWireScenario) streamFrames(t *testing.T, name string) ([]string, string) {
	t.Helper()
	if len(scenario.ProviderResponse.Events) == 0 {
		t.Fatalf("%s: the capture records no stream frames", name)
	}
	frames := make([]string, 0, len(scenario.ProviderResponse.Events))
	for index, event := range scenario.ProviderResponse.Events {
		if event.Data == "" {
			t.Fatalf("%s: captured frame %d carries no data", name, index)
		}
		frames = append(frames, "data: "+event.Data+"\n\n")
	}
	last := scenario.ProviderResponse.Events[len(scenario.ProviderResponse.Events)-1].Data
	if last != "[DONE]" {
		t.Fatalf("%s: the capture's last frame is %q, not [DONE], so it does not record a cleanly "+
			"terminated stream and this leg cannot assert one", name, last)
	}
	return frames, strings.Join(frames, "")
}

// TestDeepSeekEndToEndRefusesTheWireExactSeam is the guard on the guard. The whole point of this
// package is that the request under test is carried by the PRODUCTION transport; if that seam is in the
// environment, every assertion in the sibling test would be about the measuring instrument instead, and
// it would still be green. Refusing is the only outcome that is not a false green.
func TestDeepSeekEndToEndRefusesTheWireExactSeam(t *testing.T) {
	requireProductionTransport(t)
}

// TestDeepSeekGenerateEndToEndThroughTheProductionTransport drives the shipped binary the way the
// frontend does and asserts, at the peer, what left the process.
func TestDeepSeekGenerateEndToEndThroughTheProductionTransport(t *testing.T) {
	requireProductionTransport(t)
	fixture := loadProviderWireFixture(t)
	nonStream := fixture.scenario(t, "deepseek-nonstream")
	stream := fixture.scenario(t, "deepseek-stream")
	providerError := fixture.scenario(t, "deepseek-error-status")
	seam := deepSeekSeam(t, nonStream)
	frames, streamBody := stream.streamFrames(t, "deepseek-stream")

	// THE PEER. Its script is positional -- request N is answered by response N -- so the legs below
	// MUST run in this order, and each leg asserts the request count it expects so a reordering fails
	// loudly instead of silently comparing the wrong pair (the ordered-steps rule).
	//
	// Every scripted reply declares `Connection: close`. The production client keeps connections
	// alive, and closing a listener does NOT close the connections it already accepted, so without
	// this the last leg would find a pooled socket and be answered by a peer that is supposed to be
	// gone -- the leg would prove nothing about a failed dial.
	connectionClose := mockprovider.Header{Name: "Connection", Value: "close"}
	recorder := mockprovider.New([]mockprovider.Response{
		{
			Status:  http.StatusOK,
			Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json; charset=utf-8"}, connectionClose},
			Body:    string(nonStream.ProviderResponse.Body),
		},
		{
			Status:  http.StatusOK,
			Headers: []mockprovider.Header{{Name: "Content-Type", Value: "text/event-stream"}, connectionClose},
			Stream:  frames,
		},
		{
			// The capture records the ROUTE's answer for a non-2xx provider reply, which for DEEPSEEK
			// is the parsed provider body (chat-completions.js:1160-1166). Sending that body back as
			// the provider's own error is therefore exact for this source, and the deepseek-error-
			// status-nonjson capture is the control showing the two are not always the same shape.
			Status:  http.StatusTooManyRequests,
			Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}, connectionClose},
			Body:    string(providerError.ProviderResponse.Body),
		},
	})
	peer, err := recorder.Listen(0)
	if err != nil {
		t.Fatalf("start the recording peer: %v", err)
	}
	t.Cleanup(func() { _ = recorder.Close() })

	server := bootServer(t, map[string]string{seam: "http://" + peer.String()})
	client := openSession(t, server.origin)
	writeSecret(t, client, deepSeekSecretKey, syntheticDeepSeekKey)

	// ------------------------------------------------------------------ leg 1: non-stream
	t.Run("a non-stream completion returns the recorded provider content", func(t *testing.T) {
		status, _, body := client.postJSON(t, generateRoute, nonStream.driverBody(t, "deepseek-nonstream"))
		if status != http.StatusOK {
			t.Fatalf("POST %s = %d, want 200: %s\n%s", generateRoute, status, compactForLog(body), server.diagnostic())
		}
		want := nonStream.expectedContent(t, "deepseek-nonstream")
		if got := completionContent(t, "the route's answer", body); got != want {
			t.Fatalf("the route returned content %q, the capture recorded %q", got, want)
		}
		requests := recorder.Recording().Requests
		if len(requests) != 1 {
			t.Fatalf("the peer received %d requests, want exactly 1: the route did not make one provider "+
				"call per completion", len(requests))
		}
		assertProviderRequest(t, requests[0], nonStream, "deepseek-nonstream")
	})

	// ------------------------------------------------------------------ leg 2: stream
	t.Run("a stream forwards the recorded frames and ends in the provider's own [DONE]", func(t *testing.T) {
		status, _, body := client.postJSON(t, generateRoute, stream.driverBody(t, "deepseek-stream"))
		if status != http.StatusOK {
			t.Fatalf("POST %s = %d, want 200: %s\n%s", generateRoute, status, compactForLog(body), server.diagnostic())
		}
		// Named first, so a failure says which property broke.
		if !strings.HasSuffix(body, "data: [DONE]\n\n") {
			t.Fatalf("the streamed answer does not end in a clean `data: [DONE]`; its last 160 bytes "+
				"are %q", tail(body, 160))
		}
		if body != streamBody {
			t.Fatalf("the streamed answer is not the recorded exchange:\n  want %q\n  got  %q", streamBody, body)
		}
		requests := recorder.Recording().Requests
		if len(requests) != 2 {
			t.Fatalf("the peer received %d requests, want 2 (one per leg so far)", len(requests))
		}
		assertProviderRequest(t, requests[1], stream, "deepseek-stream")
	})

	// ------------------------------------------------------------------ leg 3: provider error
	t.Run("a provider error is surfaced as a provider error", func(t *testing.T) {
		status, _, body := client.postJSON(t, generateRoute, providerError.driverBody(t, "deepseek-error-status"))
		if want := providerError.ProviderResponse.Status; status != want {
			t.Fatalf("POST %s = %d, want %d (the capture's answer for a non-2xx provider reply): %s",
				generateRoute, status, want, compactForLog(body))
		}
		if isErrorFlag(t, body) {
			t.Fatalf("the route answered the bare {\"error\":true} flag, which is DEEPSEEK's TRANSPORT-failure " +
				"shape, for a provider that ANSWERED with an error. The provider's own message is lost and " +
				"the two failures are indistinguishable.")
		}
		message := providerErrorMessage(t, string(providerError.ProviderResponse.Body))
		if message == "" {
			t.Fatal("the capture records no provider error message, so this assertion would be vacuous")
		}
		if !strings.Contains(body, message) {
			t.Fatalf("the route's answer does not carry the provider's own message %q: %s", message, compactForLog(body))
		}
		requests := recorder.Recording().Requests
		if len(requests) != 3 {
			t.Fatalf("the peer received %d requests, want 3", len(requests))
		}
		assertProviderRequest(t, requests[2], providerError, "deepseek-error-status")
	})

	// ------------------------------------------------------------------ leg 4: transport failure
	t.Run("an unreachable provider is a transport failure, not a provider error", func(t *testing.T) {
		// The peer goes away. The plan still resolves (the key is stored), so the route reaches the
		// transport, and the transport fails to connect.
		if err := recorder.Close(); err != nil {
			t.Fatalf("close the peer: %v", err)
		}
		status, _, body := client.postJSON(t, generateRoute, nonStream.driverBody(t, "deepseek-nonstream"))
		if status != http.StatusOK {
			// 400 here would mean the plan refused (a missing key), not that the transport failed;
			// that distinction is what makes this leg about the transport at all.
			t.Fatalf("POST %s = %d, want 200 {\"error\":true} (DEEPSEEK's own catch for a fetch that "+
				"threw, chat-completions.js:1168-1174): %s\n%s",
				generateRoute, status, compactForLog(body), server.diagnostic())
		}
		if !isErrorFlag(t, body) {
			t.Fatalf("a provider that cannot be reached answered %s, want {\"error\":true}. A body that "+
				"is not the flag would mean this leg was answered by something other than the "+
				"transport failure it is testing.", compactForLog(body))
		}
		// THE CAUSE MUST BE THERE (product decision 2026-10-25, AGENTS rule 35). Pinned sends only
		// {"error":true}, so the user learns nothing about DNS, TLS, proxy or a timeout -- which is the
		// symptom P0-A was reported as. GoTavern keeps the pinned flag and ADDS a `message` naming the
		// stage: the frontend reads the flag and is unaffected, while a human (and the canary) can tell the
		// failures apart. The added member is a DECLARED divergence, so it is asserted rather than tolerated.
		cause := errorFlagCause(t, body)
		if cause == "" {
			t.Fatalf("the transport failure carries no cause, so the user cannot tell DNS from TLS from a "+
				"timeout (rule 35): %s", compactForLog(body))
		}
		if !namesATransportStage(cause) {
			t.Fatalf("the cause %q names no transport stage (dns, connect, tls, proxy, timeout, cancelled, "+
				"closed, refused, status): a message a user cannot act on is the pinned behaviour this "+
				"project deliberately does not reproduce", cause)
		}
		if recorded := recorder.Recording().Requests; len(recorded) != 3 {
			t.Fatalf("the closed peer recorded %d requests, want 3: a pooled keep-alive connection "+
				"survived the close, so this leg did not fail to connect at all", len(recorded))
		}
	})

	// WHAT USED TO BE A RECORDED GAP IS NOW A CLOSED ONE. Pinned's catch discards the transport error
	// (`response.send({ error: true })`, no status, no message), so this route could not tell the user whether
	// the failure was DNS, connect, TLS, proxy or a timeout -- AGENTS.md rule 35 was unmet on this source and
	// this comment said so. The product decision of 2026-10-25 keeps pinned's `error` flag byte-identically and
	// ADDS a `message` naming the stage, so the flag stays compatible and the cause becomes actionable; the leg
	// above asserts both halves, and the addition is a declared divergence rather than a quiet edit.
}

// deepSeekSeam returns the environment variable the capture declares for this source's hardcoded
// provider literal, and refuses a capture that declares none -- the peer would otherwise have to be
// reached by a mechanism nobody recorded.
func deepSeekSeam(t *testing.T, scenario providerWireScenario) string {
	t.Helper()
	if scenario.GoSeam == nil || scenario.GoSeam.EnvironmentVariable == "" {
		t.Fatal("the capture declares no goSeam for deepseek-nonstream, so there is no recorded way to " +
			"point this route at a controlled peer")
	}
	if want := "https://api.deepseek.com/beta"; scenario.GoSeam.PinnedLiteral != want {
		t.Fatalf("the capture pins the deepseek literal as %q, want %q: the seam stands in for that ONE "+
			"host, and a different literal would make this test drive a different provider",
			scenario.GoSeam.PinnedLiteral, want)
	}
	if scenario.HTTP.Requests[0].Path != generateRoute {
		t.Fatalf("the capture drives %q, this harness drives %q", scenario.HTTP.Requests[0].Path, generateRoute)
	}
	return scenario.GoSeam.EnvironmentVariable
}

// assertProviderRequest compares the request the PEER RECEIVED with the capture, then checks the
// production transport's fingerprint. Both halves matter: the first says the route still builds pinned's
// bytes, the second says the client that carried them is the one user traffic uses.
func assertProviderRequest(t *testing.T, recorded mockprovider.Request, scenario providerWireScenario, name string) {
	t.Helper()
	captured := scenario.Provider.Requests[0]
	if recorded.Method != captured.Method {
		t.Fatalf("%s: the peer received %s, the capture recorded %s", name, recorded.Method, captured.Method)
	}
	if recorded.RawPath != captured.RawTarget {
		t.Fatalf("%s: the peer received target %q, the capture recorded %q", name, recorded.RawPath, captured.RawTarget)
	}
	if recorded.BodySHA256 != captured.BodySHA256 {
		t.Fatalf("%s: the peer received %d bytes hashing to %s, the capture recorded %d bytes hashing "+
			"to %s. The route's provider body no longer matches the capture.\n  received: %s",
			name, recorded.BodyLength, recorded.BodySHA256, captured.BodyLength, captured.BodySHA256,
			compactForLog(recordedBodyText(recorded)))
	}
	authorization, present := headerValue(recorded, "authorization")
	if !present {
		t.Fatalf("%s: the peer received no authorization header; the key written through "+
			"/api/secrets/write did not reach the wire", name)
	}
	if want := "Bearer " + syntheticDeepSeekKey; authorization != want {
		t.Fatalf("%s: the peer received authorization %q, want %q: the secret the frontend stored is "+
			"not the value the plan read", name, authorization, want)
	}
	assertProductionTransportFingerprint(t, recorded, name)
}

// assertProductionTransportFingerprint is the assertion that this request was NOT carried by the
// wire-exact client. See the harness comment for why accept-encoding and the canonicalised Content-Type
// are the discriminators.
func assertProductionTransportFingerprint(t *testing.T, recorded mockprovider.Request, name string) {
	t.Helper()

	encoding, present := headerValue(recorded, "accept-encoding")
	if !present {
		t.Fatalf("%s: the peer received no accept-encoding header. The production client lets net/http "+
			"advertise what it can decode (gzip) and drops the planner's value; nothing at all means the "+
			"request came from neither client this project ships.", name)
	}
	if encoding != "gzip" {
		t.Fatalf("%s: the peer received accept-encoding %q, want exactly \"gzip\". The production "+
			"transport DROPS the planner's `gzip, deflate, br` (net/http only decodes what it chose); "+
			"seeing the planner's value means the WIRE-EXACT client carried this request, so this leg "+
			"proved nothing about user traffic.", name, encoding)
	}

	// THE CONNECTION HEADER NOW FOLLOWS `enableKeepAlive`, AND ITS DEFAULT IS OFF. This assertion used
	// to require its ABSENCE, because the production client always kept the connection alive; it now
	// requires `close`, because the production client honours the pinned command-line default
	// (`src/command-line.js:323`, default false at `:80`), and Go's transport signals a non-reused
	// connection with `Connection: close`.
	//
	// MEASURED 2026-10-29: the previous form failed all three legs of
	// TestDeepSeekGenerateEndToEndThroughTheProductionTransport ("the peer received `Connection: close`")
	// as soon as that default was honoured. The change is product-correct and this header is NOT the
	// production-vs-wire-exact discriminator any more -- node-fetch also writes `close`, so both clients
	// agree here. The two discriminators that remain are asserted above (accept-encoding exactly `gzip`)
	// and below (canonicalised `Content-Type`), and the keep-alive behaviour itself is asserted with a
	// connection count in TestProductionTransportKeepAliveFollowsTheConfigKey.
	if connection, present := headerValue(recorded, "connection"); !present || !strings.EqualFold(connection, "close") {
		t.Fatalf("%s: the peer received Connection: %q (present=%v), want exactly \"close\". The shipped "+
			"default is `enableKeepAlive: false` (pinned src/command-line.js:323, default :80), so the "+
			"production client must not reuse the connection for this request.", name, connection, present)
	}

	canonical := false
	for _, header := range recorded.Headers {
		if header.Name == "Content-Type" {
			canonical = true
		}
	}
	if !canonical {
		t.Fatalf("%s: no `Content-Type` header arrived (the peer saw %v). net/http canonicalises header "+
			"names, so the production client sends `Content-Type`; the wire-exact client writes the "+
			"planner's lowercase `content-type`.", name, headerNames(recorded))
	}
}

func headerValue(recorded mockprovider.Request, name string) (string, bool) {
	for _, header := range recorded.Headers {
		if strings.EqualFold(header.Name, name) {
			return header.Value, true
		}
	}
	return "", false
}

func headerNames(recorded mockprovider.Request) []string {
	names := make([]string, 0, len(recorded.Headers))
	for _, header := range recorded.Headers {
		names = append(names, header.Name)
	}
	return names
}

func recordedBodyText(recorded mockprovider.Request) string {
	if recorded.BodyText == nil {
		return "(the recorded body is not valid UTF-8)"
	}
	return *recorded.BodyText
}

// isErrorFlag reports whether the route answered pinned's `{"error": true}` flag, with the ONE declared
// addition this project makes to it.
//
// The members are constrained by NAME, not by count-anything: `error` must be exactly boolean true (that is
// what the frontend reads), an optional `message` may carry the cause, and any OTHER member is a surprise that
// fails the leg. "At most one extra key" would let a future body grow a field nobody decided on.
func isErrorFlag(t *testing.T, body string) bool {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		return false
	}
	for member := range decoded {
		if member != "error" && member != "message" {
			return false
		}
	}
	value, present := decoded["error"]
	if !present {
		return false
	}
	flag, ok := value.(bool)
	return ok && flag
}

// errorFlagCause returns the causal `message` of a transport-failure body, or "" when it is absent or empty.
func errorFlagCause(t *testing.T, body string) string {
	t.Helper()
	var decoded map[string]any
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		return ""
	}
	message, ok := decoded["message"].(string)
	if !ok {
		return ""
	}
	return strings.TrimSpace(message)
}

// namesATransportStage reports whether a cause names a stage a user can act on. The vocabulary is the
// transport's own taxonomy (docs/network-egress.md 3); matching is case-insensitive because the message is
// composed from wrapped errors whose casing is not contract.
func namesATransportStage(cause string) bool {
	lowered := strings.ToLower(cause)
	for _, stage := range []string{
		"dns", "no such host", "connect", "dial", "tls", "certificate", "handshake",
		"proxy", "timeout", "deadline", "cancel", "closed", "refused", "reset", "eof",
		"status", "http ",
	} {
		if strings.Contains(lowered, stage) {
			return true
		}
	}
	return false
}

// providerErrorMessage reads error.message out of a recorded provider error body.
func providerErrorMessage(t *testing.T, body string) string {
	t.Helper()
	var decoded struct {
		Error struct {
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal([]byte(body), &decoded); err != nil {
		return ""
	}
	return decoded.Error.Message
}

func sha256Hex(text string) string {
	digest := sha256.Sum256([]byte(text))
	return hex.EncodeToString(digest[:])
}

// compactForLog keeps a failure readable when a body is long, without hiding the start of it.
func compactForLog(body string) string {
	const limit = 400
	trimmed := strings.TrimSpace(body)
	if len(trimmed) <= limit {
		return trimmed
	}
	return trimmed[:limit] + "..."
}

func tail(body string, length int) string {
	if len(body) <= length {
		return body
	}
	return body[len(body)-length:]
}
