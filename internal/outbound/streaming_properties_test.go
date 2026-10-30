package outbound

// TWO STREAMING PROPERTIES THAT WERE NAMED AS GAPS AND ARE ASSERTED HERE.
//
// The compatibility matrix's `streaming-and-cancel` row carried two open items:
//
//  1. "a mid-stream TLS close is unobserved: the fault is a socket close on plain HTTP". That claim was STALE
//     (TestProductionTransportSurfacesAMidStreamCloseCausally already starts a TLS server and hijacks the
//     connection), but the other half of the sentence was true and is now covered: an ABRUPT close and a
//     GRACEFUL TLS shutdown (close_notify) are different faults at the TLS layer, and only the abrupt one was
//     exercised. A clean shutdown mid-frame must still be reported as a TRUNCATED reply, because the terminal
//     chunk never arrived -- otherwise a provider that closes politely after half an answer is
//     indistinguishable from one that finished.
//  2. "no gate asserts the ordering property itself". Every artifact recorded the partial text at the moment
//     of an abort, which is a per-run observation. The ordering property is not per-run: frames must arrive in
//     exactly the order the provider wrote them, each exactly once, with no byte lost or duplicated. That is
//     asserted here against a provider that writes 200 distinguishable frames, so a reordering, a drop or a
//     duplication is visible as a mismatch rather than as "the text looked right".

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// TestProductionTransportTreatsAGracefulTLSShutdownMidStreamAsTruncation is the case the abrupt-close test
// cannot cover: the provider ends the TLS session PROPERLY (close_notify) halfway through a stream.
//
// The distinction matters to a user: an abrupt RST looks like a network fault, while a close_notify is a
// peer that decided to stop talking. Both leave the model's answer half-finished, so both have to reach the
// caller as an ERROR -- a silent success would show a truncated reply as a complete one.
func TestProductionTransportTreatsAGracefulTLSShutdownMidStreamAsTruncation(t *testing.T) {
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("data: {\"partial\":\"first half\"}\n\n"))
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		// A PROPER TLS shutdown, not a reset: the hijacked connection is a *tls.Conn, and Close sends
		// close_notify before closing the socket. No terminal chunk follows, so the HTTP framing is
		// incomplete and the client must not report success.
		hijacker, ok := w.(http.Hijacker)
		if !ok {
			t.Errorf("the test server cannot hijack its connection, so this case cannot be built")
			return
		}
		connection, _, err := hijacker.Hijack()
		if err != nil {
			t.Errorf("hijack: %v", err)
			return
		}
		if tlsConnection, isTLS := connection.(*tls.Conn); isTLS {
			_ = tlsConnection.Close() // sends close_notify
			return
		}
		_ = connection.Close()
	}))
	server.StartTLS()
	t.Cleanup(server.Close)
	clientTLS := &tls.Config{RootCAs: trustedPoolFor(server.Certificate())}

	response, err := SendStreaming(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 10*time.Second)
	var partial []byte
	readErr := error(nil)
	if err == nil {
		partial, readErr = io.ReadAll(response.Stream)
		_ = response.Stream.Close()
	}
	if err != nil {
		t.Fatalf("the request failed before the stream was read (%v), so the truncation case was not reached", err)
	}
	if readErr == nil {
		t.Fatalf("a provider that shut the TLS session down mid-frame produced NO error; the caller would treat a truncated answer as complete. bytes read: %q", string(partial))
	}
	// The bytes that DID arrive must reach the caller: a truncation is reported, not hidden by discarding the
	// partial answer, and the frame that completed before the close is intact.
	if !strings.Contains(string(partial), "first half") {
		t.Fatalf("the partial frame was not delivered (%q); a truncation must report the error without swallowing what arrived", string(partial))
	}
	message := strings.ToLower(readErr.Error())
	if !strings.Contains(message, "unexpected eof") && !strings.Contains(message, "truncat") && !strings.Contains(message, "closed") && !strings.Contains(message, "reset") {
		t.Fatalf("error = %v, want a truncation/EOF/close failure a user can classify", readErr)
	}
	if strings.Contains(readErr.Error(), internetShapeSecret) {
		t.Fatalf("the truncation error leaked the bearer token: %q", readErr.Error())
	}
}

// TestProductionTransportPreservesProviderFrameOrder is the ordering property, asserted as a property rather
// than as a per-run observation: 200 distinguishable frames, written in order, must be received in that order
// with every byte present exactly once.
//
// A reordering would corrupt a model answer silently (the text still parses), which is why this is a gate and
// not a comparison of one recorded run's partial text.
func TestProductionTransportPreservesProviderFrameOrder(t *testing.T) {
	const frameCount = 200
	var builder strings.Builder
	for index := 0; index < frameCount; index++ {
		fmt.Fprintf(&builder, "data: {\"i\":%d}\n\n", index)
	}
	sent := builder.String()

	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		// ONE FRAME PER WRITE, with a flush after each, so the client receives them in separate reads rather
		// than as one coalesced blob: a reordering bug needs separate arrivals to be visible at all.
		for index := 0; index < frameCount; index++ {
			fmt.Fprintf(w, "data: {\"i\":%d}\n\n", index)
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	server.StartTLS()
	t.Cleanup(server.Close)
	clientTLS := &tls.Config{RootCAs: trustedPoolFor(server.Certificate())}

	response, err := SendStreaming(context.Background(), providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 30*time.Second)
	if err != nil {
		t.Fatalf("stream request: %v", err)
	}
	received, readErr := io.ReadAll(response.Stream)
	_ = response.Stream.Close()
	if readErr != nil {
		t.Fatalf("reading the stream: %v (after %d bytes)", readErr, len(received))
	}
	if string(received) != sent {
		// Report the FIRST difference rather than dumping 4 KiB, so a failure names the defect.
		limit := len(received)
		if len(sent) < limit {
			limit = len(sent)
		}
		firstDiff := -1
		for index := 0; index < limit; index++ {
			if received[index] != sent[index] {
				firstDiff = index
				break
			}
		}
		t.Fatalf("the streamed bytes differ from what the provider wrote (sent %d bytes, received %d, first difference at byte %d)\n  sent:     %q\n  received: %q",
			len(sent), len(received), firstDiff, clipAround(sent, firstDiff), clipAround(string(received), firstDiff))
	}
	// AND THE ORDER, independently of the byte compare: parse the frames back and require 0..199 in order.
	// A byte compare alone would pass a transport that duplicated and dropped symmetrically.
	order := make([]int, 0, frameCount)
	for _, line := range strings.Split(string(received), "\n") {
		if !strings.HasPrefix(line, "data: ") {
			continue
		}
		var index int
		if _, err := fmt.Sscanf(line, "data: {\"i\":%d}", &index); err != nil {
			t.Fatalf("unparseable frame %q: %v", line, err)
		}
		order = append(order, index)
	}
	if len(order) != frameCount {
		t.Fatalf("received %d frames, the provider wrote %d: frames were dropped or duplicated", len(order), frameCount)
	}
	for index, value := range order {
		if value != index {
			t.Fatalf("frame %d carries index %d: the stream was REORDERED (first divergence at frame %d)", index, value, index)
		}
	}
}

// trustedPoolFor returns a root pool containing exactly this certificate, so the transport verifies a real
// chain instead of skipping verification.
func trustedPoolFor(certificate *x509.Certificate) *x509.CertPool {
	pool := x509.NewCertPool()
	pool.AddCert(certificate)
	return pool
}

// clipAround returns a short window of text around a byte offset, for a failure message that names the defect
// without dumping the whole stream.
func clipAround(text string, offset int) string {
	if offset < 0 || offset >= len(text) {
		return text
	}
	start := offset - 20
	if start < 0 {
		start = 0
	}
	end := offset + 20
	if end > len(text) {
		end = len(text)
	}
	return text[start:end]
}

// TestProductionTransportDeliversACancelledStreamAsAnOrderedPrefix closes the cancellation half of the same
// property: the artefacts recorded "the partial text at the moment of abort", which is a per-run observation,
// while the property is that whatever arrived before the abort is a PREFIX of what the provider wrote, in
// order, with nothing invented or reordered. That is what makes a user's half-rendered answer trustworthy:
// it is the beginning of the real answer, not a reshuffled fragment of it.
func TestProductionTransportDeliversACancelledStreamAsAnOrderedPrefix(t *testing.T) {
	const frameCount = 200
	var builder strings.Builder
	for index := 0; index < frameCount; index++ {
		fmt.Fprintf(&builder, "data: {\"i\":%d}\n\n", index)
	}
	sent := builder.String()

	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for index := 0; index < frameCount; index++ {
			// A pause per frame, so the client cancels in the MIDDLE of the stream rather than after it.
			if !sleepUnlessCancelled(r, 3*time.Millisecond) {
				return
			}
			if _, err := fmt.Fprintf(w, "data: {\"i\":%d}\n\n", index); err != nil {
				return
			}
			if flusher != nil {
				flusher.Flush()
			}
		}
	}))
	server.StartTLS()
	t.Cleanup(server.Close)
	clientTLS := &tls.Config{RootCAs: trustedPoolFor(server.Certificate())}

	ctx, cancel := context.WithCancel(context.Background())
	response, err := SendStreaming(ctx, providerRequest(server.URL+"/v1/chat/completions", []byte("{}"), clientTLS), 30*time.Second)
	if err != nil {
		cancel()
		t.Fatalf("stream request: %v", err)
	}
	// Read a few frames, then cancel: the point of the test is what the caller HOLDS at that moment.
	head := make([]byte, 64)
	read := 0
	for read < 64 {
		count, readErr := response.Stream.Read(head[read:])
		read += count
		if readErr != nil {
			break
		}
	}
	cancel()
	_ = response.Stream.Close()

	if read == 0 {
		t.Fatal("no bytes arrived before the cancellation, so there is no prefix to assert")
	}
	received := string(head[:read])
	if !strings.HasPrefix(sent, received) {
		t.Fatalf("the bytes delivered before cancellation are NOT a prefix of the provider's stream, so the answer was reordered or corrupted\n  received: %q\n  provider: %q", received, sent[:len(received)])
	}
}

// sleepUnlessCancelled waits, and reports false when the request was cancelled first -- so a cancelled request
// stops the provider-side loop instead of writing into a dead connection.
func sleepUnlessCancelled(r *http.Request, duration time.Duration) bool {
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-r.Context().Done():
		return false
	case <-timer.C:
		return true
	}
}
