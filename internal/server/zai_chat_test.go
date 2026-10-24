package server

// What the ZAI pinning says, asserted where a recording cannot reach.
//
// LABELLED PER AGENTS.md RULE 4: the tests here that do not read the fixture are SOURCE-DERIVED
// derivations from the pinned lines named beside them, not replays. Four ZAI scenarios
// (zai-nonstream, zai-stream, zai-error-status, zai-json-schema) ARE recorded in
// tests/oracle/sillytavern-1.19.0-provider-wire.json and replayed by
// TestChatCompletionGenerateMatchesProviderWireCapture, and zai-coding-endpoint is the recorded
// discriminator for the endpoint switch -- it names a seam that only the coding literal reads, so a
// build that ignored `zai_endpoint` reaches no peer instead of passing. The derivations remain for what
// a recording cannot reach: the per-mode literals and seam defaults, the JS truthiness cases, and the
// branch decisions whose two answers are byte-identical on the wire.
//
// What the derivations cover, and why each needs to exist rather than being left to the recording:
//
//  1. THE TWO ENDPOINT MODES. Both literals are api.z.ai and differ only in PATH, and a seam replaces
//     the whole base, so a single-seam recording passes for either mode. Each literal is asserted
//     directly here, and each seam is asserted to move only its own mode.
//  2. THE THINKING MEMBER. It is always present and only its type varies; a branch that dropped it would
//     produce a body that still parses. Both values are asserted, with the JS truthiness cases (0, '',
//     false) that a Go zero-value test would not exercise.
//  3. THE reverse_proxy CREDENTIAL. Pinned reads `reverse_proxy ? proxy_password : readSecret(...)`, so a
//     proxied request with no password sends NO credential rather than falling back to the secret. That
//     fallback is the tempting implementation and it is wrong.
//  4. THE STATUS ARM. Pinned has no ZAI arm and its chain answers 400 { error: true } WITHOUT calling the
//     provider; the package default would answer 501, which claims something different. The zero-outbound
//     half is measured against a live test server rather than asserted in a comment.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const zaiTestCookieSecret = "zai-test-cookie-secret"

// TestChatCompletionZaiEndpointLiteralPerMode asserts each literal on its own (rule 4: derived table,
// from chat-completions.js:94-95 and the :2552 ternary).
func TestChatCompletionZaiEndpointLiteralPerMode(t *testing.T) {
	t.Setenv(pinnedZAISeamEnv, "")
	cases := []struct {
		name string
		body string
		want string
	}{
		{"absent", `{"chat_completion_source":"zai"}`, pinnedZAICommonAPIURL},
		{"common", `{"chat_completion_source":"zai","zai_endpoint":"common"}`, pinnedZAICommonAPIURL},
		{"coding", `{"chat_completion_source":"zai","zai_endpoint":"coding"}`, pinnedZAICodingAPIURL},
		// The pinned ternary is an equality test against ZAI_ENDPOINT.CODING, so any other value -- a
		// future endpoint name, an empty string, a number -- takes the COMMON literal rather than an
		// error path. Asserted so a stricter implementation cannot pass this file.
		{"unknown", `{"chat_completion_source":"zai","zai_endpoint":"some-future-mode"}`, pinnedZAICommonAPIURL},
		{"empty", `{"chat_completion_source":"zai","zai_endpoint":""}`, pinnedZAICommonAPIURL},
		{"nonstring", `{"chat_completion_source":"zai","zai_endpoint":7}`, pinnedZAICommonAPIURL},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			body, err := decodeOrderedNodeJSON([]byte(testCase.body))
			if err != nil {
				t.Fatal(err)
			}
			if got := pinnedZAILiteralBaseURL(body); got != testCase.want {
				t.Fatalf("literal = %q, want %q", got, testCase.want)
			}
		})
	}
	// The two literals differ only in PATH, which is the reason this source needs ONE seam and the
	// reason a seam-only assertion could never distinguish the modes.
	if strings.TrimPrefix(pinnedZAICodingAPIURL, "https://api.z.ai") == strings.TrimPrefix(pinnedZAICommonAPIURL, "https://api.z.ai") {
		t.Fatal("the two literals are expected to differ in path; this test's premise is wrong")
	}
	if !strings.HasPrefix(pinnedZAICodingAPIURL, "https://api.z.ai/") || !strings.HasPrefix(pinnedZAICommonAPIURL, "https://api.z.ai/") {
		t.Fatal("both literals are expected on the shared api.z.ai authority")
	}
}

// TestChatCompletionZaiSeamsArePerMode is the derivation behind the two-seam decision, and it is the
// half a recording cannot state: each seam must move its OWN mode and leave the other mode on its
// pinned literal. With one seam both assertions below would be the same assertion, which is why the
// recorded scenario could not have caught a build that ignored `zai_endpoint`.
func TestChatCompletionZaiSeamsArePerMode(t *testing.T) {
	commonBody, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"zai"}`))
	if err != nil {
		t.Fatal(err)
	}
	codingBody, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"zai","zai_endpoint":"coding"}`))
	if err != nil {
		t.Fatal(err)
	}

	t.Setenv(pinnedZAISeamEnv, "")
	t.Setenv(pinnedZAICodingSeamEnv, "")
	if got := pinnedZAIBaseURL(commonBody); got != pinnedZAICommonAPIURL {
		t.Fatalf("unseamed common base = %q, want %q", got, pinnedZAICommonAPIURL)
	}
	if got := pinnedZAIBaseURL(codingBody); got != pinnedZAICodingAPIURL {
		t.Fatalf("unseamed coding base = %q, want %q", got, pinnedZAICodingAPIURL)
	}

	// The coding seam must NOT reach the common mode, or the recorded coding scenario would be the only
	// thing standing between a wrong literal and a green differential.
	t.Setenv(pinnedZAICodingSeamEnv, "http://127.0.0.1:9999")
	if got := pinnedZAIBaseURL(codingBody); got != "http://127.0.0.1:9999" {
		t.Fatalf("coding base with the coding seam set = %q, want the override", got)
	}
	if got := pinnedZAIBaseURL(commonBody); got != pinnedZAICommonAPIURL {
		t.Fatalf("common base = %q when only the CODING seam is set; the coding seam must not move the common mode", got)
	}

	t.Setenv(pinnedZAICodingSeamEnv, "")
	t.Setenv(pinnedZAISeamEnv, "http://127.0.0.1:9998")
	if got := pinnedZAIBaseURL(commonBody); got != "http://127.0.0.1:9998" {
		t.Fatalf("common base with the common seam set = %q, want the override", got)
	}
	if got := pinnedZAIBaseURL(codingBody); got != pinnedZAICodingAPIURL {
		t.Fatalf("coding base = %q when only the COMMON seam is set; the common seam must not move the coding mode", got)
	}
}

// TestChatCompletionZaiSeamDefaultsMatchTheFixture pins each seam's default to the literal the fixture
// recorded for THAT variable, the way claude/mistral/openrouter/deepseek/electronhub do. The fixture
// entry comes from tests/provider-wire/scenarios/zai-coding-endpoint.json (the coding seam) and the
// zai-* scenarios (the common one); a seam that reverts to a single variable loses its key here.
func TestChatCompletionZaiSeamDefaultsMatchTheFixture(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatalf("read provider-wire fixture: %v", err)
	}
	var fixture struct {
		Seams map[string]struct {
			PinnedLiteral string `json:"pinnedLiteral"`
		} `json:"seams"`
	}
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatalf("decode provider-wire fixture: %v", err)
	}
	for _, testCase := range []struct {
		env     string
		literal string
	}{
		{pinnedZAISeamEnv, pinnedZAICommonAPIURL},
		{pinnedZAICodingSeamEnv, pinnedZAICodingAPIURL},
	} {
		recorded, present := fixture.Seams[testCase.env]
		if !present {
			t.Fatalf("the fixture records no seam %q, so the variable this code reads is unasserted; it is recorded by tests/provider-wire/scenarios/zai-coding-endpoint.json", testCase.env)
		}
		if recorded.PinnedLiteral != testCase.literal {
			t.Fatalf("seam %q recorded the pinned literal %q, the Go constant is %q", testCase.env, recorded.PinnedLiteral, testCase.literal)
		}
	}
}

// TestChatCompletionZaiThinkingMemberBothWays covers both values and the JS truthiness cases.
func TestChatCompletionZaiThinkingMemberBothWays(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"absent", `{"chat_completion_source":"zai"}`, "disabled"},
		{"false", `{"chat_completion_source":"zai","include_reasoning":false}`, "disabled"},
		{"zero", `{"chat_completion_source":"zai","include_reasoning":0}`, "disabled"},
		{"empty-string", `{"chat_completion_source":"zai","include_reasoning":""}`, "disabled"},
		{"null", `{"chat_completion_source":"zai","include_reasoning":null}`, "disabled"},
		{"true", `{"chat_completion_source":"zai","include_reasoning":true}`, "enabled"},
		{"one", `{"chat_completion_source":"zai","include_reasoning":1}`, "enabled"},
		{"string", `{"chat_completion_source":"zai","include_reasoning":"yes"}`, "enabled"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			body, err := decodeOrderedNodeJSON([]byte(testCase.body))
			if err != nil {
				t.Fatal(err)
			}
			thinking := pinnedZAIThinking(body)
			encoded, encodeErr := marshalOrderedNodeJSON(thinking)
			if encodeErr != nil {
				t.Fatal(encodeErr)
			}
			want := `{"type":"` + testCase.want + `"}`
			if string(encoded) != want {
				t.Fatalf("thinking = %s, want %s", encoded, want)
			}
		})
	}
}

// TestChatCompletionZaiPlanEndpointHeaderAndKey is the whole request for the default mode: the literal,
// the Accept-Language header the branch owns, and the key from api_key_zai.
func TestChatCompletionZaiPlanEndpointHeaderAndKey(t *testing.T) {
	t.Setenv(pinnedZAISeamEnv, "")
	directories := zaiTestDirectories(t)
	request := zaiPlanForTest(t, directories, `{"chat_completion_source":"zai","model":"glm-4.6","messages":[{"role":"user","content":"probe"}]}`)

	if !strings.HasPrefix(request.URL, pinnedZAICommonAPIURL) {
		t.Fatalf("URL = %q, want it to start with the common literal %q", request.URL, pinnedZAICommonAPIURL)
	}
	if !strings.HasSuffix(request.URL, "/chat/completions") {
		t.Fatalf("URL = %q, want the shared completion suffix", request.URL)
	}
	if got := zaiHeaderValue(request.Headers, "Accept-Language"); got != pinnedZAIHeaderLanguage {
		t.Fatalf("Accept-Language = %q, want %q", got, pinnedZAIHeaderLanguage)
	}
	if got := zaiAuthorization(request.Headers); got != "Bearer synthetic-zai-key" {
		t.Fatalf("authorization = %q, want the api_key_zai secret", got)
	}
	if !strings.Contains(string(request.Body), `"thinking":{"type":"disabled"}`) {
		t.Fatalf("body = %s, want the thinking member present", request.Body)
	}
}

// TestChatCompletionZaiCodingModeChangesThePathOnly is the discriminating half of the endpoint switch: the
// same request with zai_endpoint coding must change the PATH and nothing else that this file can see.
func TestChatCompletionZaiCodingModeChangesThePathOnly(t *testing.T) {
	t.Setenv(pinnedZAISeamEnv, "")
	directories := zaiTestDirectories(t)
	common := zaiPlanForTest(t, directories, `{"chat_completion_source":"zai","model":"glm-4.6","messages":[{"role":"user","content":"probe"}]}`)
	coding := zaiPlanForTest(t, directories, `{"chat_completion_source":"zai","zai_endpoint":"coding","model":"glm-4.6","messages":[{"role":"user","content":"probe"}]}`)

	if !strings.HasPrefix(coding.URL, pinnedZAICodingAPIURL) {
		t.Fatalf("coding URL = %q, want it to start with %q", coding.URL, pinnedZAICodingAPIURL)
	}
	wantCommon := strings.Replace(common.URL, pinnedZAICommonAPIURL, pinnedZAICodingAPIURL, 1)
	if coding.URL != wantCommon {
		t.Fatalf("coding URL = %q, want exactly the common URL with the path replaced (%q)", coding.URL, wantCommon)
	}
	if string(coding.Body) != string(common.Body) {
		t.Fatalf("the endpoint mode changed the BODY:\ncommon: %s\ncoding: %s", common.Body, coding.Body)
	}
}

// TestChatCompletionZaiReverseProxyCredential covers the rule that is tempting to get wrong: with a
// reverse proxy set the credential is proxy_password and NEVER the secret, so its absence sends nothing.
func TestChatCompletionZaiReverseProxyCredential(t *testing.T) {
	t.Setenv(pinnedZAISeamEnv, "")
	directories := zaiTestDirectories(t)

	withPassword := zaiPlanForTest(t, directories, `{"chat_completion_source":"zai","reverse_proxy":"http://127.0.0.1:8111","proxy_password":"probe-proxy-password","model":"glm-4.6","messages":[{"role":"user","content":"probe"}]}`)
	if !strings.HasPrefix(withPassword.URL, "http://127.0.0.1:8111") {
		t.Fatalf("URL = %q, want the reverse proxy to replace the literal", withPassword.URL)
	}
	if got := zaiAuthorization(withPassword.Headers); got != "Bearer probe-proxy-password" {
		t.Fatalf("authorization = %q, want the proxy_password, not the secret", got)
	}

	withoutPassword := zaiPlanForTest(t, directories, `{"chat_completion_source":"zai","reverse_proxy":"http://127.0.0.1:8111","model":"glm-4.6","messages":[{"role":"user","content":"probe"}]}`)
	if got := zaiAuthorization(withoutPassword.Headers); strings.Contains(got, "synthetic-zai-key") {
		t.Fatalf("authorization = %q: a proxied request with no password must NOT fall back to the secret", got)
	}
}

// TestChatCompletionZaiJsonSchemaFold pins the fold: response_format json_object plus an APPENDED user
// message, which no response_format-only assertion would notice.
func TestChatCompletionZaiJsonSchemaFold(t *testing.T) {
	t.Setenv(pinnedZAISeamEnv, "")
	directories := zaiTestDirectories(t)
	request := zaiPlanForTest(t, directories, `{"chat_completion_source":"zai","model":"glm-4.6","messages":[{"role":"user","content":"probe"}],"json_schema":{"value":{"name":"probe_schema","schema":{"type":"object"}}}}`)

	if !strings.Contains(string(request.Body), `"response_format":{"type":"json_object"}`) {
		t.Fatalf("body = %s, want response_format json_object", request.Body)
	}
	if !strings.Contains(string(request.Body), "JSON schema for the response:") {
		t.Fatalf("body = %s, want the appended schema message", request.Body)
	}
	if strings.Count(string(request.Body), `"role":"user"`) != 2 {
		t.Fatalf("body = %s, want the original user message plus the appended schema message", request.Body)
	}
}

// TestChatCompletionZaiStatusRefusesWith400AndNoOutbound measures the status arm: the pinned chain's
// closing else answers 400 { error: true } and never calls the provider. The zero is MEASURED against a
// live server pointed at by the seam, so an implementation that started fetching would fail here even
// though the status and body would still look right.
func TestChatCompletionZaiStatusRefusesWith400AndNoOutbound(t *testing.T) {
	var hits int64
	provider := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		atomic.AddInt64(&hits, 1)
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"data":[]}`))
	}))
	defer provider.Close()
	t.Setenv(pinnedZAISeamEnv, provider.URL)
	directories := zaiTestDirectories(t)
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"zai"}`))
	if err != nil {
		t.Fatal(err)
	}

	runtime := &accountRuntime{}
	recorder := httptest.NewRecorder()
	runtime.serveZaiChatCompletionStatus(recorder, httptest.NewRequest(http.MethodPost, "/api/backends/chat-completions/status", nil), body, directories)

	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 (pinned's unsupported-source fallback, not this package's 501)", recorder.Code)
	}
	var payload map[string]any
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("body = %q, want JSON: %v", recorder.Body.String(), err)
	}
	if value, exists := payload["error"]; !exists || value != true {
		t.Fatalf("body = %q, want {\"error\":true}", recorder.Body.String())
	}
	if got := atomic.LoadInt64(&hits); got != 0 {
		t.Fatalf("the status arm reached the provider %d time(s); pinned's fallback makes no request", got)
	}
}

// ---- helpers -----------------------------------------------------------------------------------

func zaiTestDirectories(t *testing.T) startup.UserDirectories {
	t.Helper()
	installRoot := t.TempDir()
	dataRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(zaiTestCookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	secrets := []byte(`{"api_key_zai":[{"id":"probe-id","value":"synthetic-zai-key","label":"api_key_zai","active":true}]}`)
	if err := os.WriteFile(filepath.Join(directories["root"], "secrets.json"), secrets, 0o600); err != nil {
		t.Fatal(err)
	}
	return directories
}

func zaiPlanForTest(t *testing.T, directories startup.UserDirectories, rawBody string) *outbound.Request {
	t.Helper()
	body, err := decodeOrderedNodeJSON([]byte(rawBody))
	if err != nil {
		t.Fatal(err)
	}
	request, failure := pinnedChatCompletionPlan(body, directories, zaiTestCookieSecret)
	if failure != nil {
		t.Fatalf("plan failed: %+v", failure)
	}
	return request
}

func zaiHeaderValue(headers []outbound.Header, name string) string {
	for _, header := range headers {
		if strings.EqualFold(header.Name, name) {
			return header.Value
		}
	}
	return ""
}

func zaiAuthorization(headers []outbound.Header) string {
	return zaiHeaderValue(headers, "authorization")
}
