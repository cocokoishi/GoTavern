package server

// Source-derived route tests for the pinned Volcengine TTS route
// (src/endpoints/volcengine.js:9, mounted at src/server-startup.js:183).
// See tts_provider_test.go for what these tests do and do not prove.

import (
	"bytes"
	"encoding/base64"
	"net/http"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

const (
	volcengineAppID   = "volc-app-id"
	volcengineAccess  = "volc-access-key"
	volcengineResID   = "volc.service"
	volcengineSpeaker = "BV700_streaming"
)

// volcengineAdditionsLiteral is the pinned nested object (volcengine.js:50-60) written out
// independently of the implementation, and volcengineAdditionsEscaped is what JSON.stringify produces
// for it -- which is what the provider actually receives, because `additions` is a STRING member.
const (
	volcengineAdditionsLiteral = `{"mute_cut_threshold":"400","mute_cut_remain_ms":"1",` +
		`"explicit_language":"crosslingual","enable_language_detector":true,` +
		`"disable_markdown_filter":true,"cache_config":{"use_cache":true,"text_type":1}}`
	volcengineAdditionsEscaped = `{\"mute_cut_threshold\":\"400\",\"mute_cut_remain_ms\":\"1\",` +
		`\"explicit_language\":\"crosslingual\",\"enable_language_detector\":true,` +
		`\"disable_markdown_filter\":true,\"cache_config\":{\"use_cache\":true,\"text_type\":1}}`
)

// volcengineExpectedBody is the exact pinned request body for one `speech_rate` rendering.
func volcengineExpectedBody(text, speaker, rate string) string {
	return `{"req_params":{"text":` + text + `,"speaker":` + speaker +
		`,"audio_params":{"format":"mp3","speech_rate":` + rate +
		`},"additions":"` + volcengineAdditionsEscaped + `"}}`
}

// volcengineStream builds a newline-delimited stream body from its lines. The last line carries no
// trailing newline, which is the pinned "final buffer" case.
func volcengineStream(lines ...string) string {
	return strings.Join(lines, "\n")
}

// volcengineOKLine is one successful stream line carrying base64 audio.
func volcengineOKLine(code int, audio []byte) string {
	return `{"code":` + strconvItoa(code) + `,"data":"` + base64.StdEncoding.EncodeToString(audio) + `"}`
}

// TestVolcenginePinnedDeclarations re-reads the pinned source when the checkout is beside this tree.
func TestVolcenginePinnedDeclarations(t *testing.T) {
	endpoint, ok := readPinnedTTSFile(t, filepath.Join("src", "endpoints", "volcengine.js"))
	if !ok {
		t.Log("pinned checkout not present; the declarations below could NOT be re-read (this is the CI case)")
	} else {
		for _, want := range []string{
			"router.post('/generate-voice'",
			"https://openspeech.bytedance.com/api/v3/tts/unidirectional",
			"'X-Api-App-Id': appId || ''",
			"'X-Api-Access-Key': accessKey || ''",
			"'X-Api-Resource-Id': resourceId || ''",
			"'Content-Type': 'application/json'",
			"'req_params'",
			"Number.parseInt(req.body.speed || '0')",
			"code !== 0 && code !== 20000000",
			"res.set('Content-Type', 'audio/mpeg')",
		} {
			if !strings.Contains(endpoint, want) {
				t.Errorf("the pinned volcengine.js no longer contains %q; this route's wire format is stale", want)
			}
		}
	}

	startup, startupOK := readPinnedTTSFile(t, filepath.Join("src", "server-startup.js"))
	if !startupOK {
		t.Log("pinned server-startup.js not present; the mount could NOT be re-read")
	} else if !strings.Contains(startup, "app.use('/api/volcengine', volcengineRouter)") {
		t.Error("the pinned server-startup.js no longer mounts /api/volcengine")
	}

	secrets, secretsOK := readPinnedTTSFile(t, filepath.Join("src", "endpoints", "secrets.js"))
	if !secretsOK {
		t.Log("pinned secrets.js not present; the credential keys could NOT be re-read")
	} else {
		for _, want := range []string{"VOLCENGINE_APP_ID: 'volcengine_app_id'", "VOLCENGINE_ACCESS_KEY: 'volcengine_access_key'"} {
			if !strings.Contains(secrets, want) {
				t.Errorf("the pinned secrets.js no longer declares %q", want)
			}
		}
	}

	for _, check := range []struct{ name, got, want string }{
		{"volcengineDefaultEndpoint", volcengineDefaultEndpoint, "https://openspeech.bytedance.com/api/v3/tts/unidirectional"},
		{"volcengineAppIDSecretKey", volcengineAppIDSecretKey, "volcengine_app_id"},
		{"volcengineAccessKeySecretKey", volcengineAccessKeySecretKey, "volcengine_access_key"},
		{"volcengineAdditions", volcengineAdditions, volcengineAdditionsLiteral},
	} {
		if check.got != check.want {
			t.Errorf("%s = %q, the pinned literal is %q", check.name, check.got, check.want)
		}
	}
}

// TestVolcengineSeamDefault pins the seam's default to the pinned endpoint literal.
func TestVolcengineSeamDefault(t *testing.T) {
	t.Setenv(volcengineEndpointEnv, "")
	if got := volcengineEndpoint(); got != volcengineDefaultEndpoint {
		t.Errorf("volcengineEndpoint() = %q, the pinned literal is %q", got, volcengineDefaultEndpoint)
	}
}

// TestVolcengineGenerateVoiceRequestAndResponse asserts the whole observable of a successful
// synthesis: the exact body (member order, `additions` as an escaped STRING), the ordered header
// lines, and the concatenated base64 audio answered as audio/mpeg.
func TestVolcengineGenerateVoiceRequestAndResponse(t *testing.T) {
	handler, cookie, token, dataRoot := newTTSRouteHandler(t)
	writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, map[string]string{
		volcengineAppIDSecretKey:     volcengineAppID,
		volcengineAccessKeySecretKey: volcengineAccess,
	})
	peer, peerOrigin, authority := startTTSPeer(t)

	first := []byte{0x4f, 0x67, 0x67, 0x53}
	second := []byte{0x00, 0xff, 0x10}
	third := []byte("END")
	// The stream deliberately carries a whitespace-only line and an unparseable line mid-stream:
	// the pinned loop skips both (the parse failure is logged, not rejected), so the audio still
	// comes out. The final line has no trailing newline, which is the pinned `buffer` case.
	peer.Reset(map[string][]mockprovider.Response{
		"POST /": {{
			Status: 200,
			Body: volcengineStream(
				volcengineOKLine(0, first),
				"   ",
				"not json at all",
				volcengineOKLine(20000000, second),
				volcengineOKLine(0, third),
			),
		}},
	})

	recorder := ttsPost(t, handler, cookie, token, "/api/volcengine/generate-voice",
		`{"provider_endpoint":"`+peerOrigin+`","resource_id":"`+volcengineResID+`","text":"hello","voice_speaker":"`+volcengineSpeaker+`","speed":"1"}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, pinned 200 (body %q)", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); got != "audio/mpeg" {
		t.Errorf("Content-Type = %q, pinned res.set('Content-Type','audio/mpeg') writes %q", got, "audio/mpeg")
	}
	wantAudio := append(append(append([]byte{}, first...), second...), third...)
	if !bytes.Equal(recorder.Body.Bytes(), wantAudio) {
		t.Errorf("body = %v, the concatenated stream audio is %v", recorder.Body.Bytes(), wantAudio)
	}
	if got, want := recorder.Header().Get("Content-Length"), strconvItoa(len(wantAudio)); got != want {
		t.Errorf("Content-Length = %q, the audio length %q", got, want)
	}

	requests := peer.Recording().Requests
	if len(requests) != 1 {
		t.Fatalf("the peer received %d requests, pinned makes exactly 1", len(requests))
	}
	if requests[0].Method != http.MethodPost {
		t.Errorf("outbound method = %s, pinned POST", requests[0].Method)
	}
	if requests[0].RawTarget != "/" {
		t.Errorf("outbound target = %q, pinned posts to the caller's endpoint %q", requests[0].RawTarget, "/")
	}
	expectedBody := volcengineExpectedBody(`"hello"`, `"`+volcengineSpeaker+`"`, "1")
	ttsAssertHeaderLines(t, requests[0].Headers, []ttsHeaderLine{
		{"accept", "*/*"},
		{"accept-encoding", "gzip, deflate, br"},
		{"content-length", strconvItoa(len(expectedBody))},
		{"content-type", "application/json"},
		{"user-agent", "node-fetch"},
		{"x-api-access-key", volcengineAccess},
		{"x-api-app-id", volcengineAppID},
		{"x-api-resource-id", volcengineResID},
		{"Host", authority},
		{"Connection", "close"},
	})
	if requests[0].BodyText == nil {
		t.Fatal("the peer recorded no body text for the synthesis request")
	}
	if got := *requests[0].BodyText; got != expectedBody {
		t.Errorf("outbound body = %q, pinned builds %q", got, expectedBody)
	}
}

// TestVolcengineEndpointSelection covers both directions of the endpoint choice: a falsy
// `provider_endpoint` uses the pinned default (through the seam), and a present one wins over the
// seam. The second case points the SEAM at a closed port, so a mutation that ignored the body would
// answer 500 and the peer would receive nothing.
func TestVolcengineEndpointSelection(t *testing.T) {
	cases := []struct {
		name    string
		member  string
		seam    string
		body    string
		success bool
	}{
		{name: "absentUsesDefault", seam: "peer", body: ``},
		{name: "emptyUsesDefault", seam: "peer", body: `"provider_endpoint":"",`},
		{name: "nullUsesDefault", seam: "peer", body: `"provider_endpoint":null,`},
		{name: "bodyWinsOverClosedSeam", seam: "closed", body: `"provider_endpoint":"<peer>",`, success: true},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, cookie, token, dataRoot := newTTSRouteHandler(t)
			writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, map[string]string{
				volcengineAppIDSecretKey:     volcengineAppID,
				volcengineAccessKeySecretKey: volcengineAccess,
			})
			peer, peerOrigin, _ := startTTSPeer(t)
			closed := closedLoopbackOrigin(t)
			switch testCase.seam {
			case "peer":
				t.Setenv(volcengineEndpointEnv, peerOrigin)
			case "closed":
				t.Setenv(volcengineEndpointEnv, closed)
			}
			peer.Reset(map[string][]mockprovider.Response{
				"POST /": {{Status: 200, Body: volcengineOKLine(0, []byte("AUDIO"))}},
			})
			body := `{` + strings.ReplaceAll(testCase.body, "<peer>", peerOrigin) +
				`"resource_id":"` + volcengineResID + `","text":"hi","voice_speaker":"` + volcengineSpeaker + `"}`

			recorder := ttsPost(t, handler, cookie, token, "/api/volcengine/generate-voice", body)

			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, the default endpoint resolves to the seam's peer (body %q)", recorder.Code, recorder.Body.String())
			}
			if count := len(peer.Recording().Requests); count != 1 {
				t.Fatalf("the peer received %d requests, the endpoint the route selected must be the peer", count)
			}
			if got := recorder.Body.String(); got != "AUDIO" {
				t.Errorf("body = %q, the stream audio is %q", got, "AUDIO")
			}
		})
	}
}

// TestVolcengineSpeechRate asserts `Number.parseInt(req.body.speed || '0')` and its rendering through
// JSON.stringify: an unparseable speed is `null`, `0x10` is 16, and a falsy speed falls back to the
// string '0'. Each expectation is the exact provider body.
func TestVolcengineSpeechRate(t *testing.T) {
	cases := []struct {
		name string
		body string
		rate string
	}{
		{name: "absent", body: ``, rate: "0"},
		{name: "empty", body: `"speed":"",`, rate: "0"},
		{name: "zero", body: `"speed":0,`, rate: "0"},
		{name: "null", body: `"speed":null,`, rate: "0"},
		{name: "false", body: `"speed":false,`, rate: "0"},
		{name: "integer", body: `"speed":2,`, rate: "2"},
		{name: "fraction", body: `"speed":2.9,`, rate: "2"},
		{name: "numericString", body: `"speed":"3",`, rate: "3"},
		{name: "padded", body: `"speed":" 7 ",`, rate: "7"},
		{name: "signed", body: `"speed":"-4",`, rate: "-4"},
		{name: "trailingGarbage", body: `"speed":"5abc",`, rate: "5"},
		{name: "hexPrefix", body: `"speed":"0x10",`, rate: "16"},
		{name: "exponentIsNotParsed", body: `"speed":"1e2",`, rate: "1"},
		{name: "unparseableIsNull", body: `"speed":"abc",`, rate: "null"},
		{name: "booleanIsNull", body: `"speed":true,`, rate: "null"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, cookie, token, dataRoot := newTTSRouteHandler(t)
			writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, map[string]string{
				volcengineAppIDSecretKey:     volcengineAppID,
				volcengineAccessKeySecretKey: volcengineAccess,
			})
			peer, peerOrigin, _ := startTTSPeer(t)
			peer.Reset(map[string][]mockprovider.Response{
				"POST /": {{Status: 200, Body: volcengineOKLine(0, []byte("A"))}},
			})
			body := `{"provider_endpoint":"` + peerOrigin + `",` + testCase.body +
				`"resource_id":"` + volcengineResID + `","text":"hi","voice_speaker":"` + volcengineSpeaker + `"}`

			recorder := ttsPost(t, handler, cookie, token, "/api/volcengine/generate-voice", body)
			if recorder.Code != http.StatusOK {
				t.Fatalf("status = %d, pinned 200 (body %q)", recorder.Code, recorder.Body.String())
			}
			requests := peer.Recording().Requests
			if len(requests) != 1 || requests[0].BodyText == nil {
				t.Fatalf("the peer recorded %d requests with body text %v", len(requests), requests[0].BodyText)
			}
			want := volcengineExpectedBody(`"hi"`, `"`+volcengineSpeaker+`"`, testCase.rate)
			if got := *requests[0].BodyText; got != want {
				t.Errorf("outbound body = %q, pinned builds %q", got, want)
			}
		})
	}
}

// TestVolcengineRefusals asserts both guards: the status, the pinned body, and ZERO outbound
// requests (AGENTS.md rule 17).
func TestVolcengineRefusals(t *testing.T) {
	cases := []struct {
		name     string
		secrets  map[string]string
		body     string
		status   int
		response string
	}{
		{"noAppID", map[string]string{volcengineAccessKeySecretKey: volcengineAccess}, `{"resource_id":"a","text":"b","voice_speaker":"c"}`, http.StatusForbidden, "Forbidden"},
		{"noAccessKey", map[string]string{volcengineAppIDSecretKey: volcengineAppID}, `{"resource_id":"a","text":"b","voice_speaker":"c"}`, http.StatusForbidden, "Forbidden"},
		{"noCredentials", nil, `{"resource_id":"a","text":"b","voice_speaker":"c"}`, http.StatusForbidden, "Forbidden"},
		{"noResourceID", map[string]string{volcengineAppIDSecretKey: volcengineAppID, volcengineAccessKeySecretKey: volcengineAccess}, `{"text":"b","voice_speaker":"c"}`, http.StatusBadRequest, "Bad Request"},
		{"noText", map[string]string{volcengineAppIDSecretKey: volcengineAppID, volcengineAccessKeySecretKey: volcengineAccess}, `{"resource_id":"a","voice_speaker":"c"}`, http.StatusBadRequest, "Bad Request"},
		{"noSpeaker", map[string]string{volcengineAppIDSecretKey: volcengineAppID, volcengineAccessKeySecretKey: volcengineAccess}, `{"resource_id":"a","text":"b"}`, http.StatusBadRequest, "Bad Request"},
		{"emptyText", map[string]string{volcengineAppIDSecretKey: volcengineAppID, volcengineAccessKeySecretKey: volcengineAccess}, `{"resource_id":"a","text":"","voice_speaker":"c"}`, http.StatusBadRequest, "Bad Request"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, cookie, token, dataRoot := newTTSRouteHandler(t)
			writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, testCase.secrets)
			peer, peerOrigin, _ := startTTSPeer(t)
			t.Setenv(volcengineEndpointEnv, peerOrigin)

			recorder := ttsPost(t, handler, cookie, token, "/api/volcengine/generate-voice", testCase.body)

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

// TestVolcengineUpstreamNonOK asserts the pinned non-ok branch: 500, the upstream's status phrase in
// the body, and the upstream's `X-Tt-Logid` copied onto the response (empty when it sent none).
func TestVolcengineUpstreamNonOK(t *testing.T) {
	cases := []struct {
		name    string
		headers []mockprovider.Header
		logID   string
	}{
		{name: "withLogID", headers: []mockprovider.Header{{Name: "X-Tt-Logid", Value: "log-123"}}, logID: "log-123"},
		{name: "withoutLogID", headers: nil, logID: ""},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, cookie, token, dataRoot := newTTSRouteHandler(t)
			writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, map[string]string{
				volcengineAppIDSecretKey:     volcengineAppID,
				volcengineAccessKeySecretKey: volcengineAccess,
			})
			peer, peerOrigin, _ := startTTSPeer(t)
			peer.Reset(map[string][]mockprovider.Response{
				"POST /": {{Status: 400, Headers: testCase.headers, Body: "upstream refused"}},
			})

			recorder := ttsPost(t, handler, cookie, token, "/api/volcengine/generate-voice",
				`{"provider_endpoint":"`+peerOrigin+`","resource_id":"`+volcengineResID+`","text":"hi","voice_speaker":"`+volcengineSpeaker+`"}`)

			if recorder.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, pinned 500 (body %q)", recorder.Code, recorder.Body.String())
			}
			want := "TTS Generation Failed: Bad Request"
			if got := recorder.Body.String(); got != want {
				t.Errorf("body = %q, pinned interpolates the status phrase and gives %q", got, want)
			}
			if got := recorder.Header().Get("X-Tt-Logid"); got != testCase.logID {
				t.Errorf("X-Tt-Logid = %q, pinned copies the upstream value %q", got, testCase.logID)
			}
			if _, present := recorder.Header()["X-Tt-Logid"]; !present {
				t.Error("the response carries no X-Tt-Logid header at all; pinned res.header(name, '') writes the header even when the upstream sent none")
			}
			if count := len(peer.Recording().Requests); count != 1 {
				t.Fatalf("the peer received %d requests, pinned makes exactly 1 before failing", count)
			}
		})
	}
}

// TestVolcengineStreamFailures asserts the pinned rejection paths: a stream line whose code is
// neither 0 nor 20000000, a line with no code at all, and a final line that is not JSON.
func TestVolcengineStreamFailures(t *testing.T) {
	cases := []struct {
		name     string
		stream   string
		wantBody string
		prefix   bool
	}{
		{
			name:     "codeRejected",
			stream:   volcengineStream(`{"code":50000000,"message":"upstream refused","data":"QUJD"}`),
			wantBody: "TTS Generation Failed: Volcengine TTS stream line code 50000000, upstream refused",
		},
		{
			name:     "missingCode",
			stream:   volcengineStream(`{"data":"QUJD"}`),
			wantBody: "TTS Generation Failed: Volcengine TTS stream line code undefined, undefined",
		},
		{
			name:     "stringCodeIsNotANumber",
			stream:   volcengineStream(`{"code":"0","data":"QUJD"}`),
			wantBody: `TTS Generation Failed: Volcengine TTS stream line code 0, undefined`,
		},
		{
			name:     "rejectedAfterAGoodLine",
			stream:   volcengineStream(volcengineOKLine(0, []byte("A")), `{"code":1,"message":"late"}`),
			wantBody: "TTS Generation Failed: Volcengine TTS stream line code 1, late",
		},
		{
			name:     "finalLineNotJSON",
			stream:   volcengineStream(volcengineOKLine(0, []byte("A")), "}{"),
			wantBody: "TTS Generation Failed: Error parsing final Volcengine TTS stream line: ",
			prefix:   true,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			handler, cookie, token, dataRoot := newTTSRouteHandler(t)
			writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, map[string]string{
				volcengineAppIDSecretKey:     volcengineAppID,
				volcengineAccessKeySecretKey: volcengineAccess,
			})
			peer, peerOrigin, _ := startTTSPeer(t)
			peer.Reset(map[string][]mockprovider.Response{
				"POST /": {{Status: 200, Body: testCase.stream}},
			})

			recorder := ttsPost(t, handler, cookie, token, "/api/volcengine/generate-voice",
				`{"provider_endpoint":"`+peerOrigin+`","resource_id":"`+volcengineResID+`","text":"hi","voice_speaker":"`+volcengineSpeaker+`"}`)

			if recorder.Code != http.StatusInternalServerError {
				t.Fatalf("status = %d, pinned 500 (body %q)", recorder.Code, recorder.Body.String())
			}
			got := recorder.Body.String()
			if testCase.prefix {
				if !strings.HasPrefix(got, testCase.wantBody) {
					t.Errorf("body = %q, pinned prefixes it with %q", got, testCase.wantBody)
				}
				if got == testCase.wantBody {
					t.Errorf("body = %q; the interpolated runtime error detail is missing, so the prefix assertion is not discriminating", got)
				}
			} else if got != testCase.wantBody {
				t.Errorf("body = %q, pinned writes %q", got, testCase.wantBody)
			}
		})
	}
}

// TestVolcengineEmptyStreamIsAnEmptyAnswer asserts the pinned `Buffer.concat([])` case: a stream with
// no data lines answers 200 audio/mpeg with a zero-length body.
func TestVolcengineEmptyStreamIsAnEmptyAnswer(t *testing.T) {
	handler, cookie, token, dataRoot := newTTSRouteHandler(t)
	writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, map[string]string{
		volcengineAppIDSecretKey:     volcengineAppID,
		volcengineAccessKeySecretKey: volcengineAccess,
	})
	peer, peerOrigin, _ := startTTSPeer(t)
	peer.Reset(map[string][]mockprovider.Response{
		"POST /": {{Status: 200, Body: ""}},
	})

	recorder := ttsPost(t, handler, cookie, token, "/api/volcengine/generate-voice",
		`{"provider_endpoint":"`+peerOrigin+`","resource_id":"`+volcengineResID+`","text":"hi","voice_speaker":"`+volcengineSpeaker+`"}`)

	if recorder.Code != http.StatusOK {
		t.Fatalf("status = %d, pinned 200 (body %q)", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Header().Get("Content-Type"); got != "audio/mpeg" {
		t.Errorf("Content-Type = %q, pinned writes %q", got, "audio/mpeg")
	}
	if recorder.Body.Len() != 0 {
		t.Errorf("body = %q, an empty stream concatenates to zero bytes", recorder.Body.String())
	}
}

// TestVolcengineUnusableEndpoint asserts that an endpoint the transport refuses is the pinned 500
// with ZERO requests reaching any peer. The interpolated detail is the runtime's own error text and
// is therefore classified `shape`: only the status and the pinned prefix are asserted.
func TestVolcengineUnusableEndpoint(t *testing.T) {
	handler, cookie, token, dataRoot := newTTSRouteHandler(t)
	writeSDSecrets(t, dataRoot, ttsTestAccount().Handle, map[string]string{
		volcengineAppIDSecretKey:     volcengineAppID,
		volcengineAccessKeySecretKey: volcengineAccess,
	})
	peer, _, _ := startTTSPeer(t)

	recorder := ttsPost(t, handler, cookie, token, "/api/volcengine/generate-voice",
		`{"provider_endpoint":"not-a-url","resource_id":"`+volcengineResID+`","text":"hi","voice_speaker":"`+volcengineSpeaker+`"}`)

	if recorder.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d, pinned 500 (body %q)", recorder.Code, recorder.Body.String())
	}
	if got := recorder.Body.String(); !strings.HasPrefix(got, "TTS Generation Failed: ") {
		t.Errorf("body = %q, the pinned catch writes `TTS Generation Failed: <error>`", got)
	}
	if count := len(peer.Recording().Requests); count != 0 {
		t.Fatalf("the peer received %d requests; a relative endpoint must not reach any provider", count)
	}
}

// TestVolcengineRoutePresenceAndMethodGuard asserts the route is registered under the pinned path and
// that a non-POST method falls through to the pinned 404.
func TestVolcengineRoutePresenceAndMethodGuard(t *testing.T) {
	handler, cookie, _, _ := newTTSRouteHandler(t)
	recorder := ttsGet(t, handler, cookie, "/api/volcengine/generate-voice")
	if recorder.Code != http.StatusNotFound {
		t.Fatalf("GET /api/volcengine/generate-voice = %d, the pinned router declares POST only", recorder.Code)
	}
}
