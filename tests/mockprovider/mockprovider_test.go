package mockprovider

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"strings"
	"testing"
	"time"
)

func startRecorder(t *testing.T, responses ...Response) *Recorder {
	t.Helper()
	recorder := New(responses)
	address, err := recorder.Listen(0)
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	t.Cleanup(func() { _ = recorder.Close() })
	t.Setenv("MOCK_PROVIDER_ADDRESS", address.String())
	return recorder
}

func dialRecorder(t *testing.T, recorder *Recorder) net.Conn {
	t.Helper()
	address := recorderAddress(t, recorder)
	connection, err := net.Dial("tcp", address)
	if err != nil {
		t.Fatalf("dial mock provider: %v", err)
	}
	t.Cleanup(func() { _ = connection.Close() })
	return connection
}

func recorderAddress(t *testing.T, recorder *Recorder) string {
	t.Helper()
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	if recorder.listener == nil {
		t.Fatal("recorder is not listening")
	}
	return recorder.listener.Addr().String()
}

// TestRecorderIsTransparentForRawBytes is the guard the design requires: a
// client sends known bytes and the recording must equal them exactly. A
// recording proxy that altered the request would silently invalidate every
// capture, so this is asserted rather than assumed.
func TestRecorderIsTransparentForRawBytes(t *testing.T) {
	recorder := startRecorder(t, Response{Status: 200, Body: `{"ok":true}`})
	connection := dialRecorder(t, recorder)

	body := `{"model":"probe-model","messages":[{"role":"user","content":"hello"}]}`
	request := "POST /v1/chat/completions?stream=false&x=1 HTTP/1.1\r\n" +
		"Host: " + recorderAddress(t, recorder) + "\r\n" +
		"x-probe-Lower: MiXeD\r\n" +
		"Content-Type: application/json\r\n" +
		"Authorization: Bearer synthetic-key\r\n" +
		fmt.Sprintf("Content-Length: %d\r\n", len(body)) +
		"Connection: close\r\n\r\n" + body
	if _, err := io.WriteString(connection, request); err != nil {
		t.Fatalf("write request: %v", err)
	}
	if _, err := io.ReadAll(connection); err != nil {
		t.Fatalf("read response: %v", err)
	}

	recording := recorder.Recording()
	if len(recording.Requests) != 1 {
		t.Fatalf("recorded %d requests, want 1", len(recording.Requests))
	}
	recorded := recording.Requests[0]

	if err := VerifyTransparency("POST", "/v1/chat/completions?stream=false&x=1", []Header{
		{Name: "x-probe-Lower", Value: "MiXeD"},
		{Name: "Content-Type", Value: "application/json"},
		{Name: "Authorization", Value: "Bearer synthetic-key"},
	}, []byte(body), recorded); err != nil {
		t.Fatalf("recorder altered the request: %v", err)
	}
	if recorded.RawPath != "/v1/chat/completions" {
		t.Errorf("raw path = %q", recorded.RawPath)
	}
	if recorded.RawQuery != "stream=false&x=1" {
		t.Errorf("raw query = %q", recorded.RawQuery)
	}
	if recorded.BodySHA256 == "" || recorded.BodyLength != len(body) {
		t.Errorf("body digest/length not recorded: %+v", recorded)
	}
}

// TestRecorderPreservesHeaderCaseAndOrder pins the reason this package parses
// the connection itself: net/http would canonicalise names and lose order.
func TestRecorderPreservesHeaderCaseAndOrder(t *testing.T) {
	recorder := startRecorder(t, Response{Status: 200, Body: "ok"})
	connection := dialRecorder(t, recorder)

	request := "GET /probe HTTP/1.1\r\n" +
		"host: " + recorderAddress(t, recorder) + "\r\n" +
		"X-UPPER-CASE: one\r\n" +
		"x-lower-case: two\r\n" +
		"X-MiXeD-CaSe: three\r\n" +
		"Connection: close\r\n\r\n"
	if _, err := io.WriteString(connection, request); err != nil {
		t.Fatalf("write request: %v", err)
	}
	_, _ = io.ReadAll(connection)

	recorded := recorder.Recording().Requests[0]
	var names []string
	for _, header := range recorded.Headers {
		names = append(names, header.Name)
	}
	want := []string{"host", "X-UPPER-CASE", "x-lower-case", "X-MiXeD-CaSe", "Connection"}
	if strings.Join(names, ",") != strings.Join(want, ",") {
		t.Fatalf("header names = %v, want %v (case and order must be preserved)", names, want)
	}
}

func TestRecorderReplaysScriptedResponsesInOrder(t *testing.T) {
	recorder := startRecorder(t,
		Response{Status: 200, Headers: []Header{{Name: "Content-Type", Value: "application/json"}}, Body: `{"first":true}`},
		Response{Status: 429, Body: `{"error":"rate limited"}`},
	)
	for index, want := range []string{`{"first":true}`, `{"error":"rate limited"}`} {
		connection := dialRecorder(t, recorder)
		fmt.Fprintf(connection, "POST /v1/chat/completions HTTP/1.1\r\nHost: %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", recorderAddress(t, recorder))
		response, _ := io.ReadAll(connection)
		if !bytes.Contains(response, []byte(want)) {
			t.Fatalf("response %d = %q, want it to contain %q", index, response, want)
		}
	}
	// A request beyond the script must fail loudly rather than reuse a reply.
	connection := dialRecorder(t, recorder)
	fmt.Fprintf(connection, "POST /v1/chat/completions HTTP/1.1\r\nHost: %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", recorderAddress(t, recorder))
	response, _ := io.ReadAll(connection)
	if !bytes.Contains(response, []byte("500")) {
		t.Fatalf("unscripted request response = %q, want a 500", response)
	}
	if len(recorder.Recording().Requests) != 3 {
		t.Fatalf("recorded %d requests, want 3", len(recorder.Recording().Requests))
	}
}

func TestRecorderDecodesChunkedBodies(t *testing.T) {
	recorder := startRecorder(t, Response{Status: 200, Body: "ok"})
	connection := dialRecorder(t, recorder)

	body := `{"chunked":true}`
	request := "POST /v1/chat/completions HTTP/1.1\r\n" +
		"Host: " + recorderAddress(t, recorder) + "\r\n" +
		"Transfer-Encoding: chunked\r\n" +
		"Connection: close\r\n\r\n" +
		fmt.Sprintf("%x\r\n%s\r\n", len(body), body) +
		"0\r\n\r\n"
	if _, err := io.WriteString(connection, request); err != nil {
		t.Fatalf("write request: %v", err)
	}
	_, _ = io.ReadAll(connection)

	recorded := recorder.Recording().Requests[0]
	if !recorded.Chunked {
		t.Error("chunked framing was not recorded")
	}
	if recorded.BodyText == nil || *recorded.BodyText != body {
		t.Fatalf("decoded body = %v, want %q", recorded.BodyText, body)
	}
}

func TestStreamFramesArriveInOrder(t *testing.T) {
	frames := []string{
		"data: {\"delta\":\"one\"}\n\n",
		"data: {\"delta\":\"two\"}\n\n",
		"data: [DONE]\n\n",
	}
	recorder := startRecorder(t, Response{Status: 200, Headers: []Header{{Name: "Content-Type", Value: "text/event-stream"}}, Stream: frames})
	connection := dialRecorder(t, recorder)
	fmt.Fprintf(connection, "POST /v1/chat/completions HTTP/1.1\r\nHost: %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", recorderAddress(t, recorder))
	raw, _ := io.ReadAll(connection)
	decoded := decodeChunked(t, string(raw))
	for _, frame := range frames {
		if !strings.Contains(decoded, frame) {
			t.Fatalf("streamed body %q is missing frame %q", decoded, frame)
		}
	}
	if strings.Index(decoded, frames[0]) > strings.Index(decoded, frames[1]) {
		t.Fatal("stream frames arrived out of order")
	}
}

func TestTruncatedStreamHasNoTerminalSentinel(t *testing.T) {
	recorder := startRecorder(t, Response{
		Status:              200,
		Headers:             []Header{{Name: "Content-Type", Value: "text/event-stream"}},
		Stream:              []string{"data: {\"delta\":\"partial\"}\n\n"},
		TruncateAfterFrames: true,
	})
	connection := dialRecorder(t, recorder)
	fmt.Fprintf(connection, "POST /v1/chat/completions HTTP/1.1\r\nHost: %s\r\nContent-Length: 0\r\nConnection: close\r\n\r\n", recorderAddress(t, recorder))
	raw, err := io.ReadAll(connection)
	if err != nil {
		t.Fatalf("read truncated stream: %v", err)
	}
	if !strings.Contains(string(raw), "partial") {
		t.Fatalf("truncated stream lost its frames: %q", raw)
	}
	if strings.Contains(string(raw), "0\r\n\r\n") {
		t.Fatal("truncated stream must not carry a terminating chunk")
	}
}

func TestNeverEndsRecordsClientDisconnect(t *testing.T) {
	recorder := startRecorder(t, Response{Status: 200, NeverEnds: true})
	connection := dialRecorder(t, recorder)
	fmt.Fprintf(connection, "POST /v1/chat/completions HTTP/1.1\r\nHost: %s\r\nContent-Length: 0\r\n\r\n", recorderAddress(t, recorder))

	reader := bufio.NewReader(connection)
	if _, err := reader.ReadString('\n'); err != nil {
		t.Fatalf("read status line: %v", err)
	}
	_ = connection.Close()

	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		requests := recorder.Recording().Requests
		if len(requests) == 1 && requests[0].ClientDisconnected {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("client disconnect was not recorded: %+v", recorder.Recording().Requests)
}

func TestControlEndpointsAreNotRecorded(t *testing.T) {
	recorder := startRecorder(t, Response{Status: 200, Body: "ok"})
	connection := dialRecorder(t, recorder)
	fmt.Fprintf(connection, "GET %srecording HTTP/1.1\r\nHost: %s\r\nConnection: close\r\n\r\n", controlPrefix, recorderAddress(t, recorder))
	raw, _ := io.ReadAll(connection)
	if !strings.Contains(string(raw), "200") {
		t.Fatalf("control endpoint did not answer: %q", raw)
	}
	var payload Recording
	bodyStart := strings.Index(string(raw), "\r\n\r\n")
	if err := json.Unmarshal([]byte(string(raw)[bodyStart+4:]), &payload); err != nil {
		t.Fatalf("control endpoint did not return a recording: %v", err)
	}
	if len(payload.Requests) != 0 {
		t.Fatalf("control traffic was recorded as provider traffic: %+v", payload.Requests)
	}
	if len(recorder.Recording().Requests) != 0 {
		t.Fatal("control traffic reached the provider recording")
	}
}

// decodeChunked strips chunked framing so a test can assert on the streamed
// payload itself.
func decodeChunked(t *testing.T, raw string) string {
	t.Helper()
	bodyStart := strings.Index(raw, "\r\n\r\n")
	if bodyStart < 0 {
		t.Fatalf("response has no body: %q", raw)
	}
	reader := bufio.NewReader(strings.NewReader(raw[bodyStart+4:]))
	var decoded strings.Builder
	for {
		sizeLine, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read chunk size: %v", err)
		}
		sizeLine = strings.TrimSpace(sizeLine)
		var size int
		if _, err := fmt.Sscanf(sizeLine, "%x", &size); err != nil {
			t.Fatalf("parse chunk size %q: %v", sizeLine, err)
		}
		if size == 0 {
			break
		}
		chunk := make([]byte, size)
		if _, err := io.ReadFull(reader, chunk); err != nil {
			t.Fatalf("read chunk: %v", err)
		}
		decoded.Write(chunk)
		if _, err := reader.ReadString('\n'); err != nil {
			t.Fatalf("read chunk terminator: %v", err)
		}
	}
	return decoded.String()
}
