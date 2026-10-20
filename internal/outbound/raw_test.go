package outbound

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

// providerWireFixture is the captured contract. The test below reads it rather
// than transcribing it, so that a fixture change either keeps the test passing
// because the client still matches, or fails it because it does not. A
// hardcoded copy would keep passing after the evidence changed, which would make
// this test read as evidence without being any.
type providerWireFixture struct {
	Scenarios map[string]struct {
		Provider struct {
			Requests []struct {
				Method    string `json:"method"`
				RawTarget string `json:"rawTarget"`
				Headers   []struct {
					Name  string `json:"name"`
					Value string `json:"value"`
				} `json:"headers"`
				BodyText   *string `json:"bodyText"`
				BodyLength int     `json:"bodyLength"`
				BodySHA256 string  `json:"bodySha256"`
			} `json:"requests"`
		} `json:"provider"`
	} `json:"scenarios"`
}

func loadProviderWireScenario(t *testing.T, name string) providerWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatalf("read provider-wire oracle: %v", err)
	}
	var fixture providerWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode provider-wire oracle: %v", err)
	}
	scenario, exists := fixture.Scenarios[name]
	if !exists || len(scenario.Provider.Requests) == 0 {
		// Fail loudly rather than silently asserting nothing: an absent capture
		// must never look like a pass.
		t.Fatalf("provider-wire oracle has no captured request for scenario %q", name)
	}
	return fixture
}

// TestSendReproducesTheCapturedWireForm is the guard that matters for this
// package: given the wire form the capture records, the bytes that actually
// arrive must equal the bytes the capture records. Every value comes from the
// committed oracle, with only the two declared tier-2 normalizations reversed:
// the mock authority is the ephemeral port this test just chose, and the
// Authorization value is the scenario's synthetic key.
//
// What this binds, precisely: transmission fidelity. A client-side regression
// that canonicalised header names, reordered them, or altered the body fails
// here, which was verified by mutating the writer to canonicalise names. It
// deliberately cannot catch a change to the recorded wire form itself, because
// the same fixture supplies both the request and the expectation; that binding
// is the harness comparison, where the request comes from a scenario and the
// expectation comes from the oracle.
func TestSendReproducesTheCapturedWireForm(t *testing.T) {
	fixture := loadProviderWireScenario(t, "openai-reverse-proxy-nonstream")
	captured := fixture.Scenarios["openai-reverse-proxy-nonstream"].Provider.Requests[0]
	if captured.BodyText == nil {
		t.Fatal("captured request has no body text; the oracle records the exact bytes and this test needs them")
	}
	body := []byte(*captured.BodyText)

	recorder := mockprovider.New([]mockprovider.Response{{
		Status:  200,
		Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}},
		Body:    `{"id":"mock"}`,
	}})
	address, err := recorder.Listen(0)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = recorder.Close() })

	// Reverse the declared normalizations so the request can actually be sent.
	headers := make([]Header, 0, len(captured.Headers))
	for _, header := range captured.Headers {
		value := header.Value
		switch {
		case header.Name == "Host" && value == "<mock-authority>":
			value = address.String()
		case header.Name == "authorization" && value == "Bearer <redacted>":
			value = "Bearer synthetic-proxy-key"
		}
		headers = append(headers, Header{Name: header.Name, Value: value})
	}

	response, err := Send(context.Background(), Request{
		URL:     "http://" + address.String() + captured.RawTarget,
		Method:  captured.Method,
		Headers: headers,
		Body:    body,
	}, 10*time.Second)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	if response.Status != 200 {
		t.Fatalf("status = %d, want 200", response.Status)
	}
	if !strings.Contains(string(response.Body), `"id":"mock"`) {
		t.Fatalf("body = %q", response.Body)
	}

	recording := recorder.Recording()
	if len(recording.Requests) != 1 {
		t.Fatalf("recorded %d requests, want 1", len(recording.Requests))
	}
	recorded := recording.Requests[0]
	if recorded.RawTarget != captured.RawTarget {
		t.Errorf("target = %q, captured oracle has %q", recorded.RawTarget, captured.RawTarget)
	}
	if recorded.BodyText == nil || *recorded.BodyText != *captured.BodyText {
		t.Errorf("body bytes differ from the oracle:\n got %v\nwant %s", recorded.BodyText, *captured.BodyText)
	}
	if recorded.BodyLength != captured.BodyLength || recorded.BodySHA256 != captured.BodySHA256 {
		t.Errorf("body digest differs from the oracle: got length %d sha %s, oracle has length %d sha %s",
			recorded.BodyLength, recorded.BodySHA256, captured.BodyLength, captured.BodySHA256)
	}
	// Header names, casing and order must match the oracle exactly, with only the
	// authority substituted.
	var got []string
	for _, header := range recorded.Headers {
		got = append(got, header.Name+": "+header.Value)
	}
	var want []string
	for _, header := range headers {
		want = append(want, header.Name+": "+header.Value)
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("headers differ from the oracle:\n got %v\nwant %v", got, want)
	}
}

// TestSendStreamsChunkedResponses covers the framing a streamed provider reply
// uses, including the terminal zero-length chunk.
func TestSendStreamsChunkedResponses(t *testing.T) {
	frames := []string{"data: {\"delta\":\"one\"}\n\n", "data: [DONE]\n\n"}
	recorder := mockprovider.New([]mockprovider.Response{{
		Status:  200,
		Headers: []mockprovider.Header{{Name: "Content-Type", Value: "text/event-stream"}},
		Stream:  frames,
	}})
	address, err := recorder.Listen(0)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = recorder.Close() })

	response, err := SendStreaming(context.Background(), Request{
		URL:    "http://" + address.String() + "/v1/chat/completions",
		Method: "POST",
		Headers: []Header{
			{Name: "content-length", Value: "2"},
			{Name: "content-type", Value: "application/json"},
			{Name: "Host", Value: address.String()},
			{Name: "Connection", Value: "close"},
		},
		Body: []byte("{}"),
	}, 10*time.Second)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	defer response.Stream.Close()
	buffer := make([]byte, 0, 256)
	chunk := make([]byte, 64)
	for {
		count, err := response.Stream.Read(chunk)
		buffer = append(buffer, chunk[:count]...)
		if err != nil {
			break
		}
	}
	for _, frame := range frames {
		if !strings.Contains(string(buffer), frame) {
			t.Fatalf("streamed body %q is missing frame %q", buffer, frame)
		}
	}
}

// TestSendReportsTruncatedStreams pins that a provider dying mid-stream is
// visible to the caller rather than silently looking like a clean end.
func TestSendReportsTruncatedStreams(t *testing.T) {
	recorder := mockprovider.New([]mockprovider.Response{{
		Status:              200,
		Headers:             []mockprovider.Header{{Name: "Content-Type", Value: "text/event-stream"}},
		Stream:              []string{"data: {\"delta\":\"partial\"}\n\n"},
		TruncateAfterFrames: true,
	}})
	address, err := recorder.Listen(0)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = recorder.Close() })

	response, err := SendStreaming(context.Background(), Request{
		URL:     "http://" + address.String() + "/v1/chat/completions",
		Method:  "POST",
		Headers: []Header{{Name: "content-length", Value: "2"}, {Name: "Connection", Value: "close"}},
		Body:    []byte("{}"),
	}, 10*time.Second)
	if err != nil {
		t.Fatalf("send: %v", err)
	}
	defer response.Stream.Close()
	buffer := make([]byte, 0, 128)
	chunk := make([]byte, 32)
	var readErr error
	for {
		count, err := response.Stream.Read(chunk)
		buffer = append(buffer, chunk[:count]...)
		if err != nil {
			readErr = err
			break
		}
	}
	if !strings.Contains(string(buffer), "partial") {
		t.Fatalf("truncated stream lost its frames: %q", buffer)
	}
	if readErr == nil {
		t.Fatal("a truncated stream must surface as an error, not a clean end")
	}
}
