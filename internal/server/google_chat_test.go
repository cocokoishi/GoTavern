package server

// The GEMINI TRANSPORT's own assertions: the request shapes and the response observables that the provider-wire
// scenarios cannot pin yet (their captures are recorded by the Linux oracle), plus the two failure shapes that
// differ between the sources and are the easiest thing to get wrong.
//
// These are PLAN-LEVEL and RESPONSE-LEVEL, not derivations of a recording: every expectation below is read from
// a pinned line named in the case, and the file states which line. Where the provider-wire capture later
// disagrees, the capture wins.

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

// googleTestDirectories writes a user tree holding the MAKERSUITE key, so the makersuite plan exercises the
// transform instead of the credential guard.
func googleTestDirectories(t *testing.T) startup.UserDirectories {
	t.Helper()
	root := t.TempDir()
	userDirectory := filepath.Join(root, "probe")
	if err := os.MkdirAll(userDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	writeSDSecrets(t, root, "probe", map[string]string{
		"api_key_makersuite": "synthetic-makersuite-key",
	})
	return startup.UserDirectories{"root": userDirectory}
}

func googlePlanFor(t *testing.T, directories startup.UserDirectories, raw string, useVertexAI bool) (*outbound.Request, *pinnedChatCompletionFailure) {
	t.Helper()
	body := googleTestBody(t, raw)
	return pinnedGooglePlan(body, directories, useVertexAI)
}

func googleHeader(request *outbound.Request, name string) string {
	for _, header := range request.Headers {
		if strings.EqualFold(header.Name, name) {
			return header.Value
		}
	}
	return ""
}

// TestGoogleTransportMakerSuiteAuthenticatesByQueryParameter pins :730 and :484-485 together: the key is a QUERY
// parameter, `authHeader` is assigned and never attached, and the header set is Content-Type plus node-fetch's
// own defaults. The stream marker is `&alt=sse`, appended AFTER the key (:730).
func TestGoogleTransportMakerSuiteAuthenticatesByQueryParameter(t *testing.T) {
	directories := googleTestDirectories(t)
	request, failure := googlePlanFor(t, directories, `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"probe"}],"stream":false}`, false)
	if failure != nil {
		t.Fatalf("the plan refused a legal request (status %d)", failure.status)
	}
	if !strings.Contains(request.URL, "/v1beta/models/gemini-2.5-pro:generateContent?key=synthetic-makersuite-key") {
		t.Fatalf("url = %q, want the v1beta models path with ?key=", request.URL)
	}
	if authorization := googleHeader(request, "authorization"); authorization != "" {
		t.Fatalf("makersuite must send NO Authorization header (the pinned authHeader is assigned and never used), got %q", authorization)
	}
	if contentType := googleHeader(request, "content-type"); contentType != "application/json" {
		t.Fatalf("content-type = %q", contentType)
	}
	if accept := googleHeader(request, "accept"); accept != "*/*" {
		t.Fatalf("accept = %q, want node-fetch's default", accept)
	}

	streamRequest, failure := googlePlanFor(t, directories, `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"probe"}],"stream":true}`, false)
	if failure != nil {
		t.Fatalf("the streaming plan refused a legal request (status %d)", failure.status)
	}
	if !strings.Contains(streamRequest.URL, ":streamGenerateContent?key=synthetic-makersuite-key&alt=sse") {
		t.Fatalf("streaming url = %q, want &alt=sse AFTER the key", streamRequest.URL)
	}
}

// TestGoogleTransportMakerSuiteMissingKeyIsABareFlag pins :479-482: `400 {"error":true}` with NO message. Vertex's
// equivalent carries a message (:471-474), and the pair is the reason this file tests both.
func TestGoogleTransportMakerSuiteMissingKeyIsABareFlag(t *testing.T) {
	request, failure := googlePlanFor(t, startup.UserDirectories{}, `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"probe"}]}`, false)
	if request != nil {
		t.Fatal("a request was built although the key check must refuse before the fetch")
	}
	if failure == nil || failure.status != http.StatusBadRequest {
		t.Fatalf("failure = %+v, want the pinned 400", failure)
	}
	if failure.payload == nil {
		t.Fatal("the makersuite failure must carry a body")
	}
	encoded, err := marshalOrderedNodeJSON(*failure.payload)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"error":true}` {
		t.Fatalf("body = %s, want the bare flag (no message member)", encoded)
	}
}

// TestGoogleTransportVertexAuthFailureCarriesAMessage pins :471-474: the vertex credential failure is
// `400 {"error":true,"message":<pinned sentence>}`, which is a different observable from makersuite's bare flag.
func TestGoogleTransportVertexAuthFailureCarriesAMessage(t *testing.T) {
	request, failure := googlePlanFor(t, startup.UserDirectories{}, `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"probe"}],"vertexai_auth_mode":"express"}`, true)
	if request != nil {
		t.Fatal("a request was built although the vertex credential is missing")
	}
	if failure == nil || failure.status != http.StatusBadRequest || failure.payload == nil {
		t.Fatalf("failure = %+v, want the pinned 400 with a body", failure)
	}
	encoded, err := marshalOrderedNodeJSON(*failure.payload)
	if err != nil {
		t.Fatal(err)
	}
	var decoded map[string]any
	if err := json.Unmarshal(encoded, &decoded); err != nil {
		t.Fatal(err)
	}
	if decoded["error"] != true {
		t.Fatalf("the body lost its error flag: %s", encoded)
	}
	message, isString := decoded["message"].(string)
	if !isString || message == "" {
		t.Fatalf("the vertex failure must carry a non-empty message, got %s", encoded)
	}
}

// TestGoogleTransportVertexModesAimTheCredentialDifferently pins :690-728: express keeps the key in the QUERY and
// sends no Authorization header, proxy sends the credential in the HEADER and no key, and a project id in express
// mode selects the project path on the GLOBAL host.
func TestGoogleTransportVertexModesAimTheCredentialDifferently(t *testing.T) {
	vertexRoot := t.TempDir()
	vertexUser := filepath.Join(vertexRoot, "probe")
	if err := os.MkdirAll(vertexUser, 0o755); err != nil {
		t.Fatal(err)
	}
	writeSDSecrets(t, vertexRoot, "probe", map[string]string{"api_key_vertexai": "synthetic-vertex-key"})
	directories := startup.UserDirectories{"root": vertexUser}

	express, failure := googlePlanFor(t, directories, `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"probe"}],"vertexai_auth_mode":"express","vertexai_region":"europe-west1"}`, true)
	if failure != nil {
		t.Fatalf("express plan refused: %d", failure.status)
	}
	if !strings.Contains(express.URL, "https://europe-west1-aiplatform.googleapis.com/v1/publishers/google/models/gemini-2.5-pro:generateContent?key=synthetic-vertex-key") {
		t.Fatalf("express url = %q, want the regional host with ?key=", express.URL)
	}
	if authorization := googleHeader(express, "authorization"); authorization != "" {
		t.Fatalf("express mode must NOT send Authorization (the key is in the query), got %q", authorization)
	}

	withProject, failure := googlePlanFor(t, directories, `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"probe"}],"vertexai_auth_mode":"express","vertexai_region":"europe-west1","vertexai_express_project_id":"probe-project"}`, true)
	if failure != nil {
		t.Fatalf("express-with-project plan refused: %d", failure.status)
	}
	if !strings.Contains(withProject.URL, "https://aiplatform.googleapis.com/v1/projects/probe-project/locations/europe-west1/publishers/google/models/") {
		t.Fatalf("express-with-project url = %q, want the project path on the GLOBAL host even for a regional location", withProject.URL)
	}

	proxy, failure := googlePlanFor(t, directories, `{"model":"gemini-2.5-pro","messages":[{"role":"user","content":"probe"}],"reverse_proxy":"https://probe.example","proxy_password":"synthetic-proxy-password"}`, true)
	if failure != nil {
		t.Fatalf("proxy plan refused: %d", failure.status)
	}
	if !strings.HasSuffix(proxy.URL, "/v1/publishers/google/models/gemini-2.5-pro:generateContent") {
		t.Fatalf("proxy url = %q, want the reverse-proxy base with no query", proxy.URL)
	}
	if strings.Contains(proxy.URL, "key=") {
		t.Fatalf("proxy mode must not put a key in the query: %q", proxy.URL)
	}
	if authorization := googleHeader(proxy, "authorization"); authorization != "Bearer synthetic-proxy-password" {
		t.Fatalf("proxy authorization = %q", authorization)
	}
}

// TestGoogleTransportResponseShapes pins the four 2xx observables at :762-786: the rewrap drops `thought` parts and
// joins with a blank line, and the two failure paths answer 200 with `{error:{message}}` naming the source.
func TestGoogleTransportResponseShapes(t *testing.T) {
	providerBody := `{"candidates":[{"content":{"parts":[{"text":"first"},{"text":"hidden","thought":true},{"text":"second"}],"role":"model"}}]}`
	response := &outbound.Response{Status: 200, Stream: io.NopCloser(strings.NewReader(providerBody))}
	recorder := httptest.NewRecorder()
	serveGoogleChatCompletionResponse(recorder, httptest.NewRequest(http.MethodPost, "/api/backends/chat-completions/generate", nil), response, googleTestBody(t, `{"stream":false}`), false)
	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d", recorder.Code)
	}
	reply := recorder.Body.String()
	if !strings.Contains(reply, `"content":"first\n\nsecond"`) {
		t.Fatalf("reply = %s, want the non-thought parts joined with a blank line", reply)
	}
	if !strings.Contains(reply, `"responseContent":{"parts":[`) {
		t.Fatalf("reply = %s, want the candidate's own content as responseContent", reply)
	}

	noCandidate := &outbound.Response{Status: 200, Stream: io.NopCloser(strings.NewReader(`{"promptFeedback":{"blockReason":"SAFETY"}}`))}
	recorder = httptest.NewRecorder()
	serveGoogleChatCompletionResponse(recorder, httptest.NewRequest(http.MethodPost, "/x", nil), noCandidate, googleTestBody(t, `{"stream":false}`), false)
	if recorder.Code != http.StatusOK {
		t.Fatalf("no-candidate status = %d, want the pinned 200", recorder.Code)
	}
	body := recorder.Body.String()
	if !strings.Contains(body, `Google AI Studio API returned no candidate`) || !strings.Contains(body, `Prompt was blocked due to : SAFETY`) {
		t.Fatalf("no-candidate body = %s, want the source name and the block reason", body)
	}

	emptyText := &outbound.Response{Status: 200, Stream: io.NopCloser(strings.NewReader(`{"candidates":[{"content":{"parts":[{"text":"hidden","thought":true}]}}]}`))}
	recorder = httptest.NewRecorder()
	serveGoogleChatCompletionResponse(recorder, httptest.NewRequest(http.MethodPost, "/x", nil), emptyText, googleTestBody(t, `{"stream":false}`), true)
	body = recorder.Body.String()
	if !strings.Contains(body, `Google Vertex AI Candidate text empty`) {
		t.Fatalf("empty-text body = %s, want the VERTEX name (the message names the source that was called)", body)
	}

	providerError := &outbound.Response{Status: 429, Stream: io.NopCloser(strings.NewReader(`{"error":{"code":429}}`))}
	recorder = httptest.NewRecorder()
	serveGoogleChatCompletionResponse(recorder, httptest.NewRequest(http.MethodPost, "/x", nil), providerError, googleTestBody(t, `{"stream":false}`), false)
	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("non-2xx status = %d, want 500", recorder.Code)
	}
	if !strings.Contains(recorder.Body.String(), `{"error":{"code":429}}`) {
		t.Fatalf("non-2xx body = %s, want the PARSED provider body", recorder.Body.String())
	}
}
