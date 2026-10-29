package server

// Source-derived route tests for the pinned Azure TTS routes (src/endpoints/azure.js, mounted at
// src/server-startup.js:182). See tts_provider_test.go for what these tests do and do not prove.

import (
	"bytes"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

const azureTTSKeyFixture = "azure-secret-key"

// TestAzureTTSPinnedDeclarations re-reads the pinned source when the checkout is beside this tree and
// asserts every literal this implementation depends on is still there, so a baseline bump that moved
// one of them cannot leave the Go route silently describing an older wire format.
func TestAzureTTSPinnedDeclarations(t *testing.T) {
	endpoint, ok := readPinnedTTSFile(t, filepath.Join("src", "endpoints", "azure.js"))
	if !ok {
		t.Log("pinned checkout not present; the declarations below could NOT be re-read (this is the CI case)")
	} else {
		for _, want := range []string{
			"router.post('/list'",
			"router.post('/generate'",
			"tts.speech.microsoft.com/cognitiveservices/voices/list",
			"tts.speech.microsoft.com/cognitiveservices/v1",
			"'application/ssml+xml'",
			"'webm-24khz-16bit-mono-opus'",
			"'audio/ogg'",
			"'Ocp-Apim-Subscription-Key': key",
		} {
			if !strings.Contains(endpoint, want) {
				t.Errorf("the pinned azure.js no longer contains %q; this route's wire format is stale", want)
			}
		}
	}

	startup, startupOK := readPinnedTTSFile(t, filepath.Join("src", "server-startup.js"))
	if !startupOK {
		t.Log("pinned server-startup.js not present; the mount could NOT be re-read")
	} else if !strings.Contains(startup, "app.use('/api/azure', azureRouter)") {
		t.Error("the pinned server-startup.js no longer mounts /api/azure, so this route has no pinned mount to match")
	}

	secrets, secretsOK := readPinnedTTSFile(t, filepath.Join("src", "endpoints", "secrets.js"))
	if !secretsOK {
		t.Log("pinned secrets.js not present; the secret key could NOT be re-read")
	} else if !strings.Contains(secrets, "AZURE_TTS: 'api_key_azure_tts'") {
		t.Error("the pinned secrets.js no longer declares AZURE_TTS as api_key_azure_tts")
	}

	// The Go literals, asserted independently of the source scan above so a scan that found nothing
	// still cannot pass (rule 19).
	for _, check := range []struct{ name, got, want string }{
		{"azureTTSSecretKey", azureTTSSecretKey, "api_key_azure_tts"},
		{"azureTTSDefaultBaseTemplate", azureTTSDefaultBaseTemplate, "https://%s.tts.speech.microsoft.com"},
		{"azureTTSVoicesPath", azureTTSVoicesPath, "/cognitiveservices/voices/list"},
		{"azureTTSGeneratePath", azureTTSGeneratePath, "/cognitiveservices/v1"},
		{"azureTTSOutputFormat", azureTTSOutputFormat, "webm-24khz-16bit-mono-opus"},
	} {
		if check.got != check.want {
			t.Errorf("%s = %q, the pinned literal is %q", check.name, check.got, check.want)
		}
	}
}

// TestAzureTTSSeamDefault pins the seam's DEFAULT to the pinned URL template: a seam whose default
// drifted would change production while every peer test kept passing.
func TestAzureTTSSeamDefault(t *testing.T) {
	t.Setenv(azureTTSBaseTemplateEnv, "")
	for region, want := range map[string]string{
		"westus":  "https://westus.tts.speech.microsoft.com",
		"eastus2": "https://eastus2.tts.speech.microsoft.com",
	} {
		if got := azureTTSBase(region); got != want {
			t.Errorf("azureTTSBase(%q) = %q, the pinned literal is %q", region, got, want)
		}
	}
}

// TestAzureTTSListRequestAndResponse asserts the whole observable of a successful /api/azure/list:
// the exact outbound request (method, raw target with the region the BODY carried, ordered header
// lines, empty body) and the exact response (status, content type, length, ETag, bytes).
func TestAzureTTSListRequestAndResponse(t *testing.T) {
	handler, cookie, token, dataRoot := newTTSRouteHandler(t)
	writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, map[string]string{azureTTSSecretKey: azureTTSKeyFixture})
	peer, peerOrigin, authority := startTTSPeer(t)
	t.Setenv(azureTTSBaseTemplateEnv, peerOrigin+"/%s")

	// Member order and HTML characters are deliberate: a re-marshalling implementation (sorted keys,
	// `\u003c` escaping) would answer different bytes for this body.
	upstream := `{"zeta":"a<b>&c","alpha":[1,2]}`
	peer.Reset(map[string][]mockprovider.Response{
		"GET /westus/cognitiveservices/voices/list": {{
			Status:  200,
			Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}},
			Body:    upstream,
		}},
	})

	recorder := ttsPost(t, handler, cookie, token, "/api/azure/list", `{"region":"westus"}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, pinned 200 (body %q)", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Errorf("Content-Type = %q, Express res.json writes %q", got, "application/json; charset=utf-8")
	}
	if got := recorder.Body.String(); got != upstream {
		t.Errorf("body = %q, the pinned res.json passthrough writes %q", got, upstream)
	}
	if got, want := recorder.Header().Get("Content-Length"), strconvItoa(recorder.Body.Len()); got != want {
		t.Errorf("Content-Length = %q, body length %q", got, want)
	}
	if got, want := recorder.Header().Get("ETag"), expressWeakETag(recorder.Body.Bytes()); got != want {
		t.Errorf("ETag = %q, Express weak ETag of the body %q", got, want)
	}

	requests := peer.Recording().Requests
	if len(requests) != 1 {
		t.Fatalf("the peer received %d requests, pinned makes exactly 1", len(requests))
	}
	if requests[0].Method != http.MethodGet {
		t.Errorf("outbound method = %s, pinned GET", requests[0].Method)
	}
	if requests[0].RawTarget != "/westus/cognitiveservices/voices/list" {
		t.Errorf("outbound target = %q, pinned %q", requests[0].RawTarget, "/westus/cognitiveservices/voices/list")
	}
	ttsAssertHeaderLines(t, requests[0].Headers, []ttsHeaderLine{
		{"accept", "*/*"},
		{"accept-encoding", "gzip, deflate, br"},
		{"ocp-apim-subscription-key", azureTTSKeyFixture},
		{"user-agent", "node-fetch"},
		{"Host", authority},
		{"Connection", "close"},
	})
	if requests[0].BodyLength != 0 {
		t.Errorf("outbound body length = %d, a GET carries none", requests[0].BodyLength)
	}
}

// TestAzureTTSListRefusals asserts each refusal branch: the status, the pinned body, and that the
// peer received ZERO requests. The count is the assertion that makes the refusal meaningful: a 403
// that still dialled the provider would satisfy a status-only check.
func TestAzureTTSListRefusals(t *testing.T) {
	cases := []struct {
		name     string
		secrets  map[string]string
		body     string
		status   int
		response string
	}{
		{"noKey", nil, `{"region":"westus"}`, http.StatusForbidden, "Forbidden"},
		{"noRegion", map[string]string{azureTTSSecretKey: azureTTSKeyFixture}, `{}`, http.StatusBadRequest, "Bad Request"},
		{"emptyRegion", map[string]string{azureTTSSecretKey: azureTTSKeyFixture}, `{"region":""}`, http.StatusBadRequest, "Bad Request"},
		{"nullRegion", map[string]string{azureTTSSecretKey: azureTTSKeyFixture}, `{"region":null}`, http.StatusBadRequest, "Bad Request"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, cookie, token, dataRoot := newTTSRouteHandler(t)
			writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, testCase.secrets)
			peer, peerOrigin, _ := startTTSPeer(t)
			t.Setenv(azureTTSBaseTemplateEnv, peerOrigin+"/%s")

			recorder := ttsPost(t, handler, cookie, token, "/api/azure/list", testCase.body)

			if recorder.Code != testCase.status {
				t.Fatalf("status = %d, pinned %d (body %q)", recorder.Code, testCase.status, recorder.Body.String())
			}
			if got := recorder.Body.String(); got != testCase.response {
				t.Errorf("body = %q, pinned res.sendStatus writes %q", got, testCase.response)
			}
			if got := recorder.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
				t.Errorf("Content-Type = %q, Express sendStatus writes %q", got, "text/plain; charset=utf-8")
			}
			if count := len(peer.Recording().Requests); count != 0 {
				t.Fatalf("the peer received %d requests; a refused request makes ZERO outbound requests (AGENTS.md rule 17)", count)
			}
		})
	}
}

// TestAzureTTSListUpstreamFailures asserts the two 500 branches: a non-ok upstream answer, and an
// upstream answer whose body is not JSON (the pinned `await response.json()` throws).
func TestAzureTTSListUpstreamFailures(t *testing.T) {
	cases := []struct {
		name     string
		response mockprovider.Response
	}{
		{"upstreamNotOK", mockprovider.Response{Status: 503, Body: `{"error":"nope"}`}},
		{"upstreamNotJSON", mockprovider.Response{Status: 200, Body: "<html>not json</html>"}},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, cookie, token, dataRoot := newTTSRouteHandler(t)
			writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, map[string]string{azureTTSSecretKey: azureTTSKeyFixture})
			peer, peerOrigin, _ := startTTSPeer(t)
			t.Setenv(azureTTSBaseTemplateEnv, peerOrigin+"/%s")
			peer.Reset(map[string][]mockprovider.Response{
				"GET /westus/cognitiveservices/voices/list": {testCase.response},
			})

			recorder := ttsPost(t, handler, cookie, token, "/api/azure/list", `{"region":"westus"}`)

			if recorder.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, pinned 500 (body %q)", recorder.Code, recorder.Body.String())
			}
			if got := recorder.Body.String(); got != "Internal Server Error" {
				t.Errorf("body = %q, pinned res.sendStatus(500) writes %q", got, "Internal Server Error")
			}
			if count := len(peer.Recording().Requests); count != 1 {
				t.Fatalf("the peer received %d requests, pinned makes exactly 1 before failing", count)
			}
		})
	}
}

// azureGenerateSSML is the pinned SSML for the scenario below, written out literally so the
// expectation is not produced by the function it guards.
const azureGenerateSSML = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'>" +
	"<voice xml:lang='en-US' name='en-US-JennyNeural'>Hello &amp; &lt;world&gt;</voice></speak>"

// TestAzureTTSGenerateRequestAndResponse asserts the whole observable of a successful
// /api/azure/generate: the exact SSML body bytes (escaping order, `lang` derived from the voice, the
// RAW voice interpolated into `name`), the ordered header lines, and the fixed `audio/ogg` answer.
func TestAzureTTSGenerateRequestAndResponse(t *testing.T) {
	handler, cookie, token, dataRoot := newTTSRouteHandler(t)
	writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, map[string]string{azureTTSSecretKey: azureTTSKeyFixture})
	peer, peerOrigin, authority := startTTSPeer(t)
	t.Setenv(azureTTSBaseTemplateEnv, peerOrigin+"/%s")

	// Non-UTF-8 bytes, so a handler that re-encoded the audio would change the digest.
	audio := []byte{0x4f, 0x67, 0x67, 0x53, 0x00, 0xff, 0x10}
	peer.Reset(map[string][]mockprovider.Response{
		"POST /westus/cognitiveservices/v1": {{
			Status:  200,
			Headers: []mockprovider.Header{{Name: "Content-Type", Value: "audio/webm"}},
			Body:    string(audio),
		}},
	})

	recorder := ttsPost(t, handler, cookie, token, "/api/azure/generate",
		`{"text":"Hello & <world>","voice":"en-US-JennyNeural","region":"westus"}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, pinned 200 (body %q)", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); got != "audio/ogg" {
		t.Errorf("Content-Type = %q, pinned res.set('Content-Type','audio/ogg') writes %q", got, "audio/ogg")
	}
	if !bytes.Equal(recorder.Body.Bytes(), audio) {
		t.Errorf("body = %v, the upstream audio bytes are %v", recorder.Body.Bytes(), audio)
	}
	if got, want := recorder.Header().Get("Content-Length"), strconvItoa(len(audio)); got != want {
		t.Errorf("Content-Length = %q, the audio length %q", got, want)
	}
	if got, want := recorder.Header().Get("ETag"), expressWeakETag(audio); got != want {
		t.Errorf("ETag = %q, Express weak ETag of the audio %q", got, want)
	}

	requests := peer.Recording().Requests
	if len(requests) != 1 {
		t.Fatalf("the peer received %d requests, pinned makes exactly 1", len(requests))
	}
	if requests[0].Method != http.MethodPost {
		t.Errorf("outbound method = %s, pinned POST", requests[0].Method)
	}
	if requests[0].RawTarget != "/westus/cognitiveservices/v1" {
		t.Errorf("outbound target = %q, pinned %q", requests[0].RawTarget, "/westus/cognitiveservices/v1")
	}
	ttsAssertHeaderLines(t, requests[0].Headers, []ttsHeaderLine{
		{"accept", "*/*"},
		{"accept-encoding", "gzip, deflate, br"},
		{"content-length", strconvItoa(len(azureGenerateSSML))},
		{"content-type", "application/ssml+xml"},
		{"ocp-apim-subscription-key", azureTTSKeyFixture},
		{"user-agent", "node-fetch"},
		{"x-microsoft-outputformat", "webm-24khz-16bit-mono-opus"},
		{"Host", authority},
		{"Connection", "close"},
	})
	if requests[0].BodyText == nil {
		t.Fatal("the peer recorded no body text for the SSML request")
	}
	if got := *requests[0].BodyText; got != azureGenerateSSML {
		t.Errorf("outbound SSML body = %q, pinned builds %q", got, azureGenerateSSML)
	}
}

// TestAzureTTSGenerateLanguageAndEscaping covers the two derived strings separately from the
// transport: the `lang` split and the `&`/`<`/`>` replacement order.
func TestAzureTTSGenerateLanguageAndEscaping(t *testing.T) {
	for _, testCase := range []struct{ voice, lang string }{
		{"en-US-JennyNeural", "en-US"},
		{"en-US", "en-US"},
		{"JennyNeural", "JennyNeural"},
		{"a-b-c-d", "a-b"},
	} {
		if got := azureTTSLanguage(testCase.voice); got != testCase.lang {
			t.Errorf("azureTTSLanguage(%q) = %q, pinned String(voice).split('-').slice(0,2).join('-') gives %q",
				testCase.voice, got, testCase.lang)
		}
	}
	// `&` first, or the `&` of `&lt;` would itself be escaped.
	if got, want := azureTTSEscape("a&b<c>d"), "a&amp;b&lt;c&gt;d"; got != want {
		t.Errorf("azureTTSEscape = %q, pinned chain gives %q", got, want)
	}
	if got, want := azureTTSEscape("&lt;"), "&amp;lt;"; got != want {
		t.Errorf("azureTTSEscape(&lt;) = %q, the pinned chain escapes the ampersand first and gives %q", got, want)
	}
}

// TestAzureTTSGenerateRefusals asserts each /api/azure/generate refusal: status, body, and ZERO
// outbound requests.
func TestAzureTTSGenerateRefusals(t *testing.T) {
	cases := []struct {
		name     string
		secrets  map[string]string
		body     string
		status   int
		response string
	}{
		{"noKey", nil, `{"text":"hi","voice":"en-US-A","region":"westus"}`, http.StatusForbidden, "Forbidden"},
		{"noText", map[string]string{azureTTSSecretKey: azureTTSKeyFixture}, `{"voice":"en-US-A","region":"westus"}`, http.StatusBadRequest, "Bad Request"},
		{"noVoice", map[string]string{azureTTSSecretKey: azureTTSKeyFixture}, `{"text":"hi","region":"westus"}`, http.StatusBadRequest, "Bad Request"},
		{"noRegion", map[string]string{azureTTSSecretKey: azureTTSKeyFixture}, `{"text":"hi","voice":"en-US-A"}`, http.StatusBadRequest, "Bad Request"},
		{"emptyText", map[string]string{azureTTSSecretKey: azureTTSKeyFixture}, `{"text":"","voice":"en-US-A","region":"westus"}`, http.StatusBadRequest, "Bad Request"},
		{"zeroText", map[string]string{azureTTSSecretKey: azureTTSKeyFixture}, `{"text":0,"voice":"en-US-A","region":"westus"}`, http.StatusBadRequest, "Bad Request"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, cookie, token, dataRoot := newTTSRouteHandler(t)
			writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, testCase.secrets)
			peer, peerOrigin, _ := startTTSPeer(t)
			t.Setenv(azureTTSBaseTemplateEnv, peerOrigin+"/%s")

			recorder := ttsPost(t, handler, cookie, token, "/api/azure/generate", testCase.body)

			if recorder.Code != testCase.status {
				t.Fatalf("status = %d, pinned %d (body %q)", recorder.Code, testCase.status, recorder.Body.String())
			}
			if got := recorder.Body.String(); got != testCase.response {
				t.Errorf("body = %q, pinned res.sendStatus writes %q", got, testCase.response)
			}
			if count := len(peer.Recording().Requests); count != 0 {
				t.Fatalf("the peer received %d requests; a refused request makes ZERO outbound requests (AGENTS.md rule 17)", count)
			}
		})
	}
}

// TestAzureTTSGenerateUpstreamFailure asserts that a non-ok synthesis answer is the pinned 500 with
// no audio and no `audio/ogg` type.
func TestAzureTTSGenerateUpstreamFailure(t *testing.T) {
	handler, cookie, token, dataRoot := newTTSRouteHandler(t)
	writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, map[string]string{azureTTSSecretKey: azureTTSKeyFixture})
	peer, peerOrigin, _ := startTTSPeer(t)
	t.Setenv(azureTTSBaseTemplateEnv, peerOrigin+"/%s")
	peer.Reset(map[string][]mockprovider.Response{
		"POST /westus/cognitiveservices/v1": {{Status: 401, Body: "denied"}},
	})

	recorder := ttsPost(t, handler, cookie, token, "/api/azure/generate",
		`{"text":"hi","voice":"en-US-A","region":"westus"}`)

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, pinned 500 (body %q)", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); got != "text/plain; charset=utf-8" {
		t.Errorf("Content-Type = %q, the pinned branch answers sendStatus(500) as %q", got, "text/plain; charset=utf-8")
	}
	if got := recorder.Body.String(); got != "Internal Server Error" {
		t.Errorf("body = %q, pinned res.sendStatus(500) writes %q", got, "Internal Server Error")
	}
	if count := len(peer.Recording().Requests); count != 1 {
		t.Fatalf("the peer received %d requests, pinned makes exactly 1 before failing", count)
	}
}

// TestAzureTTSRoutePresenceAndMethodGuard asserts the route is registered under the pinned path and
// that a non-POST method falls through to the pinned 404 rather than reaching the handler.
func TestAzureTTSRoutePresenceAndMethodGuard(t *testing.T) {
	handler, cookie, _, _ := newTTSRouteHandler(t)
	recorder := ttsGet(t, handler, cookie, "/api/azure/list")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("GET /api/azure/list = %d, the pinned router declares POST only, so an authenticated GET falls through to the 404 page", recorder.Code)
	}
}
