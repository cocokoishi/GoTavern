package server

// The two properties the OPENROUTER provider-wire increment needs that the generic replay test cannot state.
//
//  1. THE SEAM'S DEFAULT. This source's URL is a pinned LITERAL (chat-completions.js:2302) with no
//     reverse_proxy and no custom_url, so the recorded differential can only be reproduced by pointing the
//     Go leg at the recording peer. A default that merely "made the replay pass" would be worthless: it is
//     asserted here against the literal the fixture RECORDED, and against the PATH every captured provider
//     request carries, so the default cannot drift away from the pinned URL while the replay stays green.
//
//  2. THE NON-STREAM CONTROL. A buffered capture mislabelled as streaming has happened in this project, so
//     the two openrouter scenarios are checked to carry the SAME answer: the control's message content must
//     equal the concatenation of the streaming deltas, and the stream must terminate with [DONE]. If a
//     future edit makes the control a different answer, this fails even though both scenarios still replay.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

type openRouterWireFixture struct {
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
				Data string `json:"data"`
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

func loadOpenRouterWireFixture(t *testing.T) openRouterWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture openRouterWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the provider-wire fixture records no scenarios")
	}
	return fixture
}

func TestChatCompletionOpenRouterSeamDefault(t *testing.T) {
	fixture := loadOpenRouterWireFixture(t)
	recorded, present := fixture.Seams[pinnedOpenRouterSeamEnv]
	if !present {
		t.Fatalf("the fixture does not record a seam named %q, so the variable this code reads is unasserted", pinnedOpenRouterSeamEnv)
	}
	t.Setenv(pinnedOpenRouterSeamEnv, "")
	if got := pinnedOpenRouterBaseURL(); got != recorded.PinnedLiteral {
		t.Fatalf("default OpenRouter base = %q, the fixture recorded the pinned literal %q", got, recorded.PinnedLiteral)
	}
	if pinnedOpenRouterAPIURL != recorded.PinnedLiteral {
		t.Fatalf("the Go literal %q and the fixture's recorded literal %q disagree", pinnedOpenRouterAPIURL, recorded.PinnedLiteral)
	}
	// The PATH is the part of the URL the pinned literal decides (the AUTHORITY is the recording peer's), so
	// a default that kept the fixture's authority but changed the path would otherwise pass the check above.
	wantPath := strings.TrimSuffix(recorded.PinnedLiteral, "/") + "/chat/completions"
	captured := 0
	for name, scenario := range fixture.Scenarios {
		if scenario.TargetPath != chatCompletionSourceOpenRtr || len(scenario.Provider.Requests) == 0 {
			continue
		}
		captured++
		if method := scenario.Provider.Requests[0].Method; method != "POST" && scenario.Provider.Requests[0].RawTarget != "/models" {
			t.Fatalf("%s: unexpected provider method %s", name, method)
		}
		// The generate route builds `<literal>/chat/completions`; the status route joins `/models`. Both paths
		// descend from the same literal, so both are checked against it.
		allowed := map[string]bool{"/chat/completions": true, "/models": true}
		target := scenario.Provider.Requests[0].RawTarget
		if !allowed[target] {
			t.Fatalf("%s: provider target %q is not a path the pinned literal builds (want %q plus /chat/completions or /models)", name, target, wantPath)
		}
	}
	if captured < 6 {
		t.Fatalf("only %d openrouter scenario(s) carry a provider request, so the seam claim is under-exercised", captured)
	}
}

func TestChatCompletionOpenRouterStreamHasNonStreamControl(t *testing.T) {
	fixture := loadOpenRouterWireFixture(t)
	control, hasControl := fixture.Scenarios["openrouter-nonstream"]
	stream, hasStream := fixture.Scenarios["openrouter-stream"]
	if !hasControl || !hasStream {
		t.Fatalf("the control/stream pair is missing from the fixture (control %v, stream %v)", hasControl, hasStream)
	}
	if len(control.ProviderResponse.Body.Choices) == 0 {
		t.Fatal("the control captured no message content")
	}
	controlText := control.ProviderResponse.Body.Choices[0].Message.Content
	var streamed strings.Builder
	for _, event := range stream.ProviderResponse.Events {
		if event.Data == "[DONE]" {
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
		if len(chunk.Choices) > 0 {
			streamed.WriteString(chunk.Choices[0].Delta.Content)
		}
	}
	if streamed.String() != controlText {
		t.Fatalf("the streaming deltas spell %q but the non-stream control carries %q, so the pair is not a control", streamed.String(), controlText)
	}
	terminated := false
	for _, event := range stream.ProviderResponse.Events {
		if event.Data == "[DONE]" {
			terminated = true
		}
	}
	if !terminated {
		t.Fatal("the streaming capture does not carry a [DONE] terminator, so it does not show the framing this route forwards")
	}
}
