package outbound

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

// TestSendReproducesTheCapturedWireForm is the guard that matters: the client
// must be able to emit exactly the bytes the pinned backend emits, because the
// provider observes them. The expected values are the captured contract in
// tests/oracle/sillytavern-1.19.0-provider-wire.json, not a reading of the
// pinned source.
func TestSendReproducesTheCapturedWireForm(t *testing.T) {
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

	body := []byte(`{"messages":[{"role":"system","content":"probe system marker"},{"role":"user","content":"probe user marker"}],"model":"probe-model","temperature":0.5,"max_tokens":64,"stream":false}`)
	// The exact header order and casing the capture records for the native
	// reverse_proxy path, including the double slash in the request target.
	headers := []Header{
		{Name: "accept", Value: "*/*"},
		{Name: "accept-encoding", Value: "gzip, deflate, br"},
		{Name: "authorization", Value: "Bearer synthetic-proxy-key"},
		{Name: "content-length", Value: "181"},
		{Name: "content-type", Value: "application/json"},
		{Name: "user-agent", Value: "node-fetch"},
		{Name: "Host", Value: address.String()},
		{Name: "Connection", Value: "close"},
	}

	response, err := Send(context.Background(), Request{
		URL:     "http://" + address.String() + "//chat/completions",
		Method:  "POST",
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
	if recorded.RawTarget != "//chat/completions" {
		t.Errorf("target = %q, want the doubled slash preserved", recorded.RawTarget)
	}
	if recorded.BodyText == nil || *recorded.BodyText != string(body) {
		t.Errorf("body bytes differ:\n got %v\nwant %s", recorded.BodyText, body)
	}
	// Header names, casing and order must match exactly.
	var got []string
	for _, header := range recorded.Headers {
		got = append(got, header.Name+": "+header.Value)
	}
	var want []string
	for _, header := range headers {
		want = append(want, header.Name+": "+header.Value)
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("headers differ:\n got %v\nwant %v", got, want)
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
