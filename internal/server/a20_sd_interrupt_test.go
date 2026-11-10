package server

// alpha.20 source-audit reproducer: the pinned stable-diffusion/text-completion routes register a
// socket-close handler and guard its side effect with `!response.writableEnded`
// (src/endpoints/stable-diffusion.js:316-321, :568-576, :682-690,
// src/endpoints/backends/text-completions.js:288-296). Go's request context is cancelled when
// ServeHTTP RETURNS, so a bare watcher on request.Context().Done() fires the interrupt/abort after a
// NORMAL completion, which pinned never does.
//
// These tests use a REAL httptest server rather than httptest.NewRecorder: only net/http cancels the
// request context on handler return, so a recorder-based test cannot see this defect (the existing
// TestSDA1111InterruptOnClientClose uses a recorder and a manually cancelled context, which is why the
// defect survived the suite).

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// a20SDRecorder records the provider requests a mock SD/textgen backend actually receives.
type a20SDRecorder struct {
	mu   sync.Mutex
	seen []string
}

func (recorder *a20SDRecorder) add(request *http.Request) {
	recorder.mu.Lock()
	recorder.seen = append(recorder.seen, request.Method+" "+request.URL.Path)
	recorder.mu.Unlock()
}

func (recorder *a20SDRecorder) snapshot() []string {
	recorder.mu.Lock()
	defer recorder.mu.Unlock()
	return append([]string(nil), recorder.seen...)
}

// waitForInterrupt returns the first interrupt/abort path the peer saw within the bound, or "".
func (recorder *a20SDRecorder) waitForInterrupt(t *testing.T, bound time.Duration) string {
	t.Helper()
	deadline := time.Now().Add(bound)
	for time.Now().Before(deadline) {
		for _, request := range recorder.snapshot() {
			if strings.HasSuffix(request, "/sdapi/v1/interrupt") ||
				strings.HasSuffix(request, "/interrupt") ||
				strings.HasSuffix(request, "/cancel/undefined") ||
				strings.HasSuffix(request, "/api/extra/abort") {
				return request
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	return ""
}

// newA20FrontServer builds the production handler behind a REAL server so net/http owns the request
// context (cancel-on-return is the behaviour under test).
func newA20FrontServer(t *testing.T) *httptest.Server {
	t.Helper()
	dataRoot := t.TempDir()
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
	front := httptest.NewServer(handler)
	t.Cleanup(front.Close)
	return front
}

func a20PostJSON(t *testing.T, ctx context.Context, front *httptest.Server, route, body string) (*http.Response, error) {
	t.Helper()
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, front.URL+route, strings.NewReader(body))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	return http.DefaultClient.Do(request)
}

// TestA20SuccessfulA1111GenerateSendsNoInterrupt is the primary reproducer: pinned's fixture records
// exactly two outbound requests (GET /sdapi/v1/options, POST /sdapi/v1/txt2img) for a SUCCESSFUL
// /api/sd/generate (tests/oracle/sillytavern-1.19.0-sd-generate.json, generateForgeKeepsModules), and
// `!response.writableEnded` is false by the time any socket could close. A third interrupt POST is
// therefore a provider-wire difference, and A1111's interrupt cancels whatever generation is running.
func TestA20SuccessfulA1111GenerateSendsNoInterrupt(t *testing.T) {
	recorder := &a20SDRecorder{}
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.add(request)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"images":[]}`))
	}))
	defer peer.Close()

	front := newA20FrontServer(t)
	response, err := a20PostJSON(t, context.Background(), front, "/api/sd/generate",
		fmt.Sprintf(`{"url":%q,"prompt":"a tree"}`, peer.URL))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.StatusCode)
	}
	if interrupt := recorder.waitForInterrupt(t, 1500*time.Millisecond); interrupt != "" {
		t.Fatalf("a SUCCESSFUL /api/sd/generate sent %q to the provider; pinned only interrupts when the "+
			"response did not end (stable-diffusion.js:316-321, `!response.writableEnded`) and its fixture "+
			"records two outbound requests; the peer saw %v", interrupt, recorder.snapshot())
	}
}

// TestA20FailedA1111GenerateSendsNoInterrupt covers the error path: pinned's catch calls
// response.sendStatus(500), so writableEnded is true and the close handler does NOT interrupt.
func TestA20FailedA1111GenerateSendsNoInterrupt(t *testing.T) {
	recorder := &a20SDRecorder{}
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.add(request)
		if request.URL.Path == "/sdapi/v1/txt2img" {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusInternalServerError)
			_, _ = w.Write([]byte(`{"error":"boom"}`))
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{}`))
	}))
	defer peer.Close()

	front := newA20FrontServer(t)
	response, err := a20PostJSON(t, context.Background(), front, "/api/sd/generate",
		fmt.Sprintf(`{"url":%q,"prompt":"a tree"}`, peer.URL))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", response.StatusCode)
	}
	if interrupt := recorder.waitForInterrupt(t, 1500*time.Millisecond); interrupt != "" {
		t.Fatalf("a FAILED /api/sd/generate sent %q; pinned's response.sendStatus(500) sets writableEnded "+
			"before any close handler can run, so the interrupt leg is skipped; the peer saw %v", interrupt, recorder.snapshot())
	}
}

// TestA20ComfyPromptFailureSendsNoInterrupt covers the comfy branch: `!response.writableEnded && !item`
// is false once the handler has answered 500, and the fixture's comfyPromptFailed scenario records
// exactly ONE outbound request (comfyPromptFailed: outbound=1).
func TestA20ComfyPromptFailureSendsNoInterrupt(t *testing.T) {
	recorder := &a20SDRecorder{}
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.add(request)
		w.WriteHeader(http.StatusInternalServerError)
		_, _ = w.Write([]byte(`{"error":"prompt refused"}`))
	}))
	defer peer.Close()

	front := newA20FrontServer(t)
	response, err := a20PostJSON(t, context.Background(), front, "/api/sd/comfy/generate",
		fmt.Sprintf(`{"url":%q,"prompt":%q}`, peer.URL, `{"prompt":{"1":{"class_type":"x"}}}`))
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	_, _ = io.Copy(io.Discard, response.Body)
	_ = response.Body.Close()
	if response.StatusCode != http.StatusInternalServerError {
		t.Fatalf("status = %d, want 500", response.StatusCode)
	}
	if interrupt := recorder.waitForInterrupt(t, 1500*time.Millisecond); interrupt != "" {
		t.Fatalf("a FAILED /api/sd/comfy/generate sent %q; pinned's !response.writableEnded is false after "+
			"sendStatus(500), and the comfyPromptFailed fixture records one outbound request; the peer saw %v",
			interrupt, recorder.snapshot())
	}
}

// TestA20InterruptIsStillSentWhenTheClientDisconnects is the control: the pinned side effect must keep
// firing for its REAL trigger -- a client that goes away while the provider call is still in flight.
// Without this, "no interrupt" could be achieved by deleting the feature.
func TestA20InterruptIsStillSentWhenTheClientDisconnects(t *testing.T) {
	recorder := &a20SDRecorder{}
	sawTxt2Img := make(chan struct{})
	var once sync.Once
	peer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		recorder.add(request)
		_, _ = io.Copy(io.Discard, request.Body)
		if request.URL.Path == "/sdapi/v1/txt2img" {
			once.Do(func() { close(sawTxt2Img) })
			// Stay in flight briefly so the client cancels inside the provider call.
			time.Sleep(300 * time.Millisecond)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"images":[]}`))
	}))
	defer peer.Close()

	front := newA20FrontServer(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	requestBody := fmt.Sprintf(`{"url":%q,"prompt":"a tree"}`, peer.URL)
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, front.URL+"/api/sd/generate", strings.NewReader(requestBody))
	if err != nil {
		t.Fatalf("build request: %v", err)
	}
	request.Header.Set("Content-Type", "application/json")
	go func() {
		response, doErr := http.DefaultClient.Do(request)
		if doErr == nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
	}()

	select {
	case <-sawTxt2Img:
	case <-time.After(5 * time.Second):
		t.Fatalf("the provider never received txt2img; the peer saw %v", recorder.snapshot())
	}
	cancel()
	if interrupt := recorder.waitForInterrupt(t, 5*time.Second); interrupt == "" {
		t.Fatalf("a client disconnect during the provider call did NOT produce the interrupt; pinned's "+
			"close handler still runs when the response has not ended; the peer saw %v", recorder.snapshot())
	}
}
