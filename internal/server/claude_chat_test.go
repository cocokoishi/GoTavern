package server

// The CLAUDE properties the generic provider-wire replay cannot state, plus the two branches that
// harness CANNOT capture.
//
// The provider-wire probe requires every scenario to record at least one provider request ("capture
// for %q records no provider request at all" is a hard failure), so a branch that answers BEFORE the
// fetch can never appear in it. The CLAUDE source has two such branches, and both are pinned
// behaviour rather than a gap:
//
//   - a missing key answers 400 {"error":true} at chat-completions.js:235-238, before the try;
//   - a THROWN fetch answers 500 {"error":true} at :441-446. The probe has no closed-port mode: every
//     scenario is served by a live recorder, and a recorder that answers IS a response, so this branch
//     cannot be produced by the differential either.
//
// They are therefore LABELLED DERIVATIONS (AGENTS.md rule 4): the expected status and body come from
// the pinned lines above, and what is asserted beyond them is the OBSERVABLE half this project insists
// on for a refusal -- that NO request reached the provider (rule 17), measured with a live recorder
// rather than assumed.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type claudeWireFixture struct {
	Seams map[string]struct {
		PinnedLiteral string `json:"pinnedLiteral"`
	} `json:"seams"`
	Scenarios map[string]struct {
		TargetPath string `json:"targetPath"`
		Provider   struct {
			Requests []struct {
				Method    string `json:"method"`
				RawTarget string `json:"rawTarget"`
			} `json:"requests"`
		} `json:"provider"`
		ProviderResponse struct {
			Status int `json:"status"`
			Events []struct {
				Event *string `json:"event"`
				Data  string  `json:"data"`
			} `json:"events"`
			Body struct {
				Choices []struct {
					Message struct {
						Content string `json:"content"`
					} `json:"message"`
				} `json:"choices"`
				Content json.RawMessage `json:"content"`
			} `json:"body"`
		} `json:"providerResponse"`
	} `json:"scenarios"`
}

func loadClaudeWireFixture(t *testing.T) claudeWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture claudeWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the provider-wire fixture records no scenarios")
	}
	return fixture
}

// TestChatCompletionClaudeCoversItsBranches refuses to run a suite that cannot discriminate: each named
// observable of the CLAUDE transform must be present in the recorded set, because a scenario list that
// silently lost one would still replay green.
func TestChatCompletionClaudeCoversItsBranches(t *testing.T) {
	fixture := loadClaudeWireFixture(t)
	required := []string{
		"claude-nonstream",                // the default request
		"claude-nonthinking-model",        // sampling members survive, no thinking
		"claude-system-multiple",          // system extraction + example names
		"claude-no-sysprompt",             // the system member is deleted
		"claude-merge-roles",              // consecutive-role merging
		"claude-prefill",                  // assistant_prefill, non-thinking model
		"claude-limited-sampling",         // temperature deleted, top_p kept
		"claude-thinking",                 // thinking + max_tokens raise + sampling deleted
		"claude-tools",                    // tools/tool_choice + the tools beta
		"claude-stream",                   // Anthropic framing
		"claude-stream-control-nonstream", // the control for the stream
		"claude-error-status",             // non-2xx -> 500 {"error":true}
		"claude-reverse-proxy",            // URL from the body + proxy_password key
	}
	for _, name := range required {
		scenario, present := fixture.Scenarios[name]
		if !present {
			t.Fatalf("the fixture has no capture for %q, so that observable is unproven", name)
		}
		if len(scenario.Provider.Requests) == 0 {
			t.Fatalf("%s: the capture records no provider request", name)
		}
		if scenario.TargetPath != chatCompletionSourceClaude {
			t.Fatalf("%s: targetPath = %q, want %q", name, scenario.TargetPath, chatCompletionSourceClaude)
		}
	}
}

// TestChatCompletionClaudeSeamDefault pins the seam's default to the literal the fixture recorded, and
// pins the PATH that literal builds, so a default that kept a plausible authority but changed the path
// cannot pass the first check alone.
func TestChatCompletionClaudeSeamDefault(t *testing.T) {
	fixture := loadClaudeWireFixture(t)
	recorded, present := fixture.Seams[pinnedClaudeSeamEnv]
	if !present {
		t.Fatalf("the fixture does not record a seam named %q, so the variable this code reads is unasserted", pinnedClaudeSeamEnv)
	}
	t.Setenv(pinnedClaudeSeamEnv, "")
	if got := pinnedClaudeBaseURL(); got != recorded.PinnedLiteral {
		t.Fatalf("default Claude base = %q, the fixture recorded the pinned literal %q", got, recorded.PinnedLiteral)
	}
	if pinnedClaudeAPIURL != recorded.PinnedLiteral {
		t.Fatalf("the Go literal %q and the fixture's recorded literal %q disagree", pinnedClaudeAPIURL, recorded.PinnedLiteral)
	}
	// The pinned code appends '/messages' to `new URL(reverse_proxy || API_CLAUDE).toString()`. A bare
	// origin gains a trailing slash from toString(), which is why the reverse-proxy capture carries the
	// doubled slash: both forms are recorded and both are checked here.
	targets := 0
	for name, scenario := range fixture.Scenarios {
		if scenario.TargetPath != chatCompletionSourceClaude {
			continue
		}
		target := scenario.Provider.Requests[0].RawTarget
		targets++
		switch target {
		case "/messages", "//messages":
		default:
			t.Fatalf("%s: provider target %q is not a path the pinned literal builds (want /messages, or //messages for a reverse_proxy that normalized to a trailing slash)", name, target)
		}
	}
	if targets < 10 {
		t.Fatalf("only %d claude scenario(s) carry a provider request, so the seam claim is under-exercised", targets)
	}
}

// TestChatCompletionClaudeStreamUsesAnthropicFraming proves the stream and its control are the SAME
// answer, and that the framing is Anthropic's: the capture must terminate with `message_stop` and must
// NOT contain a [DONE] sentinel, because the CLAUDE route pipes forwardFetchResponse the provider's own
// bytes rather than translating them.
func TestChatCompletionClaudeStreamUsesAnthropicFraming(t *testing.T) {
	fixture := loadClaudeWireFixture(t)
	control, hasControl := fixture.Scenarios["claude-stream-control-nonstream"]
	stream, hasStream := fixture.Scenarios["claude-stream"]
	if !hasControl || !hasStream {
		t.Fatalf("the control/stream pair is missing from the fixture (control %v, stream %v)", hasControl, hasStream)
	}
	if len(control.ProviderResponse.Body.Choices) == 0 {
		t.Fatal("the control captured no message content")
	}
	controlText := control.ProviderResponse.Body.Choices[0].Message.Content
	if controlText == "" {
		t.Fatal("the control's message content is empty, so it cannot be a control")
	}
	// The rewrap also keeps the provider's whole content array, which is the half of :432-439 a
	// message-content-only check would miss.
	if len(control.ProviderResponse.Body.Content) == 0 {
		t.Fatal("the control's rewrapped body lost the provider `content` array")
	}
	streamed := strings.Builder{}
	sawMessageStop := false
	sawDone := false
	for _, event := range stream.ProviderResponse.Events {
		if event.Event != nil && *event.Event == "message_stop" {
			sawMessageStop = true
		}
		if event.Data == "[DONE]" {
			sawDone = true
		}
		var frame struct {
			Type  string `json:"type"`
			Delta struct {
				Text string `json:"text"`
			} `json:"delta"`
		}
		if err := json.Unmarshal([]byte(event.Data), &frame); err != nil {
			t.Fatalf("a streamed event is not JSON (%q): %v", event.Data, err)
		}
		if frame.Type == "content_block_delta" {
			streamed.WriteString(frame.Delta.Text)
		}
	}
	if !sawMessageStop {
		t.Fatal("the streaming capture does not terminate with message_stop, so it does not show Anthropic framing")
	}
	if sawDone {
		t.Fatal("the streaming capture contains a [DONE] sentinel, which the CLAUDE route never sends")
	}
	if streamed.String() != controlText {
		t.Fatalf("the streaming deltas spell %q but the non-stream control carries %q, so the pair is not a control", streamed.String(), controlText)
	}
}

// TestChatCompletionClaudeMissingKeyIsRefusedBeforeTheFetch is a LABELLED DERIVATION (see the file
// header): chat-completions.js:235-238 answers 400 {"error":true} before the try, so no request can
// reach the provider. The assertion that NO request arrived is the observable half, and it is measured
// against a live recorder.
func TestChatCompletionClaudeMissingKeyIsRefusedBeforeTheFetch(t *testing.T) {
	recorder := mockprovider.New([]mockprovider.Response{{
		Status:  200,
		Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}},
		Body:    `{"content":[{"type":"text","text":"must never be requested"}]}`,
	}})
	address, err := recorder.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recorder.Close() })
	t.Setenv(pinnedClaudeSeamEnv, "http://"+address.String())

	scenario := chatCompletionTestScenario()
	origin, cookie, token := startChatCompletionTestServer(t, scenario)
	body := `{"chat_completion_source":"claude","model":"claude-3-5-sonnet-20240620","messages":[{"role":"user","content":"probe"}],"max_tokens":64,"use_sysprompt":true,"stream":false}`
	status, header, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, body)
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want the pinned 400 (body %q)", status, text)
	}
	if text != `{"error":true}` {
		t.Fatalf("body = %q, want the pinned {error:true}", text)
	}
	if contentType := header.Get("Content-Type"); contentType != "application/json; charset=utf-8" {
		t.Fatalf("content type = %q", contentType)
	}
	if recorded := recorder.Recording(); len(recorded.Requests) != 0 {
		t.Fatalf("the provider received %d request(s) although the key check rejects the call before the fetch", len(recorded.Requests))
	}
}

// TestChatCompletionClaudeTransportFailureAnswers500 is a LABELLED DERIVATION (see the file header):
// :441-446 answers 500 {"error":true} when the fetch throws and the headers have not been sent. The
// failure is produced through a REAL closed port, and it is asserted to be the CLAUDE answer rather
// than the generic 502 {"error":{message}} envelope.
func TestChatCompletionClaudeTransportFailureAnswers500(t *testing.T) {
	t.Setenv(pinnedClaudeSeamEnv, closedLoopbackOrigin(t))
	scenario := chatCompletionTestScenario()
	scenario.Secrets = map[string]any{
		"api_key_claude": []any{map[string]any{"id": "probe", "value": "synthetic-claude-key", "label": "probe", "active": true}},
	}
	origin, cookie, token := startChatCompletionTestServer(t, scenario)
	body := `{"chat_completion_source":"claude","model":"claude-3-5-sonnet-20240620","messages":[{"role":"user","content":"probe"}],"max_tokens":64,"use_sysprompt":true,"stream":false}`
	status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, body)
	if status != http.StatusInternalServerError {
		t.Fatalf("status = %d, want the pinned 500 (body %q)", status, text)
	}
	if !isTransportFailureBody(text) {
		t.Fatalf("body = %q, want {error:true}; the generic path's {error:{message}} envelope is the wrong branch", text)
	}
}
