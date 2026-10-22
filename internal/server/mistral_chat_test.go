package server

// The MISTRAL properties the generic provider-wire replay cannot state, plus the two branches that
// harness CANNOT capture.
//
// The provider-wire probe requires every scenario to record at least one provider request, so a branch
// that answers BEFORE the fetch can never appear in it, and there is no closed-port mode, so a THROWN
// fetch cannot be produced there either. MISTRAL has two such branches and both are pinned behaviour:
//
//   - a missing key answers 400 {"error":true} at chat-completions.js:885-888, before the try;
//   - a thrown fetch answers **200** {"error":true} at :956-962, because that catch uses
//     `response.send` with NO status. This is the branch an implementer copying CLAUDE gets wrong
//     (CLAUDE answers 500 there), which is why it has its own test rather than only a comment.
//
// They are therefore LABELLED DERIVATIONS (AGENTS.md rule 4): the expected status and body come from
// the pinned lines above, and what is asserted beyond them is the observable half this project
// requires for a refusal -- that NO request reached the provider -- measured against a live recorder.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

type mistralWireFixture struct {
	Seams map[string]struct {
		PinnedLiteral string `json:"pinnedLiteral"`
	} `json:"seams"`
	Scenarios map[string]struct {
		TargetPath string `json:"targetPath"`
		Provider   struct {
			Requests []struct {
				Method    string `json:"method"`
				RawTarget string `json:"rawTarget"`
				BodyText  string `json:"bodyText"`
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
			} `json:"body"`
		} `json:"providerResponse"`
	} `json:"scenarios"`
}

func loadMistralWireFixture(t *testing.T) mistralWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture mistralWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the provider-wire fixture records no scenarios")
	}
	return fixture
}

// TestChatCompletionMistralCoversItsBranches refuses to run a suite that cannot discriminate.
func TestChatCompletionMistralCoversItsBranches(t *testing.T) {
	fixture := loadMistralWireFixture(t)
	required := []string{
		"mistral-nonstream",
		"mistral-seed-and-stop",
		"mistral-message-shaping",
		"mistral-tool-messages",
		"mistral-tools-raw",
		"mistral-json-schema",
		"mistral-json-schema-nonstrict",
		"mistral-stream",
		"mistral-stream-control-nonstream",
		"mistral-error-status",
		"mistral-error-status-nonjson",
		"mistral-reverse-proxy",
	}
	for _, name := range required {
		scenario, present := fixture.Scenarios[name]
		if !present {
			t.Fatalf("the fixture has no capture for %q, so that observable is unproven", name)
		}
		if len(scenario.Provider.Requests) == 0 {
			t.Fatalf("%s: the capture records no provider request", name)
		}
		if scenario.TargetPath != chatCompletionSourceMistral {
			t.Fatalf("%s: targetPath = %q, want %q", name, scenario.TargetPath, chatCompletionSourceMistral)
		}
	}
}

// TestChatCompletionMistralSeedAndStopDropRules makes the two coercions undeniable from the captures
// themselves: seed -1 and an empty stop array must be ABSENT from one body, and a supplied seed and
// stop must be PRESENT in the other. Without the control, an implementation that always dropped them
// would satisfy the first capture.
func TestChatCompletionMistralSeedAndStopDropRules(t *testing.T) {
	fixture := loadMistralWireFixture(t)
	dropped, present := fixture.Scenarios["mistral-nonstream"], fixture.Scenarios["mistral-seed-and-stop"]
	if len(dropped.Provider.Requests) == 0 || len(present.Provider.Requests) == 0 {
		t.Fatal("one of the seed/stop scenarios recorded no provider request")
	}
	droppedBody := dropped.Provider.Requests[0].BodyText
	presentBody := present.Provider.Requests[0].BodyText
	if strings.Contains(droppedBody, "random_seed") {
		t.Fatalf("the seed -1 capture contains random_seed: %s", droppedBody)
	}
	if strings.Contains(droppedBody, "\"stop\"") {
		t.Fatalf("the empty-stop capture contains a stop member: %s", droppedBody)
	}
	if !strings.Contains(presentBody, `"random_seed":42`) {
		t.Fatalf("the seed 42 capture does not carry random_seed 42: %s", presentBody)
	}
	if !strings.Contains(presentBody, `"stop":["PROBE_STOP","SECOND_STOP"]`) {
		t.Fatalf("the non-empty stop capture does not carry the stop array: %s", presentBody)
	}
	// safe_prompt is Mistral-only and has no generic equivalent; its absence would be silent.
	if !strings.Contains(droppedBody, `"safe_prompt":true`) {
		t.Fatalf("the default capture does not carry safe_prompt: %s", droppedBody)
	}
}

// TestChatCompletionMistralSeamDefault pins the seam's default to the recorded literal and the path the
// literal builds.
func TestChatCompletionMistralSeamDefault(t *testing.T) {
	fixture := loadMistralWireFixture(t)
	recorded, present := fixture.Seams[pinnedMistralSeamEnv]
	if !present {
		t.Fatalf("the fixture does not record a seam named %q", pinnedMistralSeamEnv)
	}
	t.Setenv(pinnedMistralSeamEnv, "")
	if got := pinnedMistralBaseURL(); got != recorded.PinnedLiteral {
		t.Fatalf("default Mistral base = %q, the fixture recorded the pinned literal %q", got, recorded.PinnedLiteral)
	}
	if pinnedMistralAPIURL != recorded.PinnedLiteral {
		t.Fatalf("the Go literal %q and the fixture's recorded literal %q disagree", pinnedMistralAPIURL, recorded.PinnedLiteral)
	}
	targets := 0
	for name, scenario := range fixture.Scenarios {
		if scenario.TargetPath != chatCompletionSourceMistral {
			continue
		}
		targets++
		switch target := scenario.Provider.Requests[0].RawTarget; target {
		case "/chat/completions", "//chat/completions":
		default:
			t.Fatalf("%s: provider target %q is not a path the pinned literal builds (want /chat/completions, or //chat/completions for a reverse_proxy that normalized to a trailing slash)", name, target)
		}
	}
	if targets < 10 {
		t.Fatalf("only %d mistral scenario(s) carry a provider request, so the seam claim is under-exercised", targets)
	}
}

// TestChatCompletionMistralStreamHasNonStreamControl proves the pair is the same answer and that the
// terminator is Mistral's own [DONE], forwarded verbatim by forwardFetchResponse.
func TestChatCompletionMistralStreamHasNonStreamControl(t *testing.T) {
	fixture := loadMistralWireFixture(t)
	control, hasControl := fixture.Scenarios["mistral-stream-control-nonstream"]
	stream, hasStream := fixture.Scenarios["mistral-stream"]
	if !hasControl || !hasStream {
		t.Fatalf("the control/stream pair is missing (control %v, stream %v)", hasControl, hasStream)
	}
	if len(control.ProviderResponse.Body.Choices) == 0 {
		t.Fatal("the control captured no message content")
	}
	controlText := control.ProviderResponse.Body.Choices[0].Message.Content
	if controlText == "" {
		t.Fatal("the control's message content is empty")
	}
	streamed := strings.Builder{}
	terminated := false
	for _, event := range stream.ProviderResponse.Events {
		if event.Data == "[DONE]" {
			terminated = true
			continue
		}
		var chunk struct {
			Choices []struct {
				Delta struct {
					Content string `json:"content"`
				} `json:"delta"`
			} `json:"choices"`
		}
		if err := json.Unmarshal([]byte(event.Data), &chunk); err != nil {
			t.Fatalf("a streamed event is not JSON (%q): %v", event.Data, err)
		}
		for _, choice := range chunk.Choices {
			streamed.WriteString(choice.Delta.Content)
		}
	}
	if !terminated {
		t.Fatal("the streaming capture does not carry the provider's [DONE] terminator")
	}
	if streamed.String() != controlText {
		t.Fatalf("the streaming deltas spell %q but the non-stream control carries %q", streamed.String(), controlText)
	}
}

// TestChatCompletionMistralMissingKeyIsRefusedBeforeTheFetch is a LABELLED DERIVATION (see the header).
func TestChatCompletionMistralMissingKeyIsRefusedBeforeTheFetch(t *testing.T) {
	recorder := mockprovider.New([]mockprovider.Response{{
		Status:  200,
		Headers: []mockprovider.Header{{Name: "Content-Type", Value: "application/json"}},
		Body:    `{"choices":[]}`,
	}})
	address, err := recorder.Listen(0)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = recorder.Close() })
	t.Setenv(pinnedMistralSeamEnv, "http://"+address.String())

	scenario := chatCompletionTestScenario()
	origin, cookie, token := startChatCompletionTestServer(t, scenario)
	body := `{"chat_completion_source":"mistralai","model":"open-mistral-nemo","messages":[{"role":"user","content":"probe"}],"max_tokens":64,"stream":false}`
	status, header, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, body)
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want the pinned 400 (body %q)", status, text)
	}
	if text != `{"error":true}` {
		t.Fatalf("body = %q, want {error:true}", text)
	}
	if contentType := header.Get("Content-Type"); contentType != "application/json; charset=utf-8" {
		t.Fatalf("content type = %q", contentType)
	}
	if recorded := recorder.Recording(); len(recorded.Requests) != 0 {
		t.Fatalf("the provider received %d request(s) although the key check rejects the call before the fetch", len(recorded.Requests))
	}
}

// TestChatCompletionMistralTransportFailureAnswers200 is a LABELLED DERIVATION (see the header) and it
// exists to pin the ONE place MISTRAL differs from CLAUDE in a way a copy would get wrong: the catch
// answers 200 {"error":true}, not 500.
func TestChatCompletionMistralTransportFailureAnswers200(t *testing.T) {
	t.Setenv(pinnedMistralSeamEnv, closedLoopbackOrigin(t))
	scenario := chatCompletionTestScenario()
	scenario.Secrets = map[string]any{
		"api_key_mistralai": []any{map[string]any{"id": "probe", "value": "synthetic-mistral-key", "label": "probe", "active": true}},
	}
	origin, cookie, token := startChatCompletionTestServer(t, scenario)
	body := `{"chat_completion_source":"mistralai","model":"open-mistral-nemo","messages":[{"role":"user","content":"probe"}],"max_tokens":64,"stream":false}`
	status, _, text, _, _ := driveChatCompletionScenario(t, scenario, origin, cookie, token, body)
	if status != http.StatusOK {
		t.Fatalf("status = %d, want the pinned 200 (body %q); the CLAUDE branch's 500 is the wrong contract here", status, text)
	}
	if text != `{"error":true}` {
		t.Fatalf("body = %q, want {error:true}", text)
	}
}
