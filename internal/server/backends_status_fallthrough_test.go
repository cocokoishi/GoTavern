package server

// THE STATUS-CHAIN FALL-THROUGH CONTROL.
//
// chat-completions.js:1787-2065 is ONE `if / else if` chain that ends in a closing `else` answering
// 400 {"error":true} and RETURNING (:2062-2065). A source with no arm in that chain is therefore REFUSED
// by the pinned backend, and refused BEFORE the :2067 key guard is reachable -- so the answer depends on
// neither a secret existing nor `reverse_proxy` being set.
//
// This route used to answer 501 for exactly those sources. 501 is this package's "not written yet" marker,
// so AI21, VERTEXAI and PERPLEXITY were reported as an unimplemented feature when the pinned product had a
// defined, recorded refusal. That is the defect this file holds shut, and
// pinnedChatCompletionStatusNoArmSources is the single place the decision lives.
//
// WHY IT TAKES TWO ASSERTIONS, not one. The partition test below is a LABELLED DERIVATION (AGENTS.md rule
// 4): "which sources the pinned chain has an arm for" is a property of source code, not of an observation,
// and a name added to the claimed list with no arm anywhere would otherwise silently join the 501 default.
// The OBSERVABLE -- 400, {"error":true}, zero outbound -- is recorded from the pinned server in
// tests/oracle/sillytavern-1.19.0-backends.json as status.{ai21,vertexai,perplexity}.{noBranch,reverseProxy},
// with status.claude.* as the pre-existing precedent that the closing else is what fires.
//
// pinnedStatusChainArmSources is the derivation: every `chat_completion_source === ...` arm in
// ../SillyTavern/src/endpoints/backends/chat-completions.js:1787-2065, in source order. A name NOT in this
// list is a source the pinned server answers from its closing else.

import (
	"net/http"
	"os"
	"strings"
	"testing"
)

var pinnedStatusChainArmSources = []string{
	"openai", "openrouter", "mistralai", "custom", "cohere", "chutes", "electronhub",
	"nanogpt", "deepseek", "xai", "aimlapi", "pollinations", "groq", "cometapi",
	"moonshot", "fireworks", "makersuite", "azure_openai", "siliconflow", "workers_ai",
}

// TestStatusFallThroughSourcesAnswerThePinnedRefusal is the product fix, asserted at the route a browser
// reaches: 400 with the pinned JSON body, not the 501 this route answered before.
func TestStatusFallThroughSourcesAnswerThePinnedRefusal(t *testing.T) {
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: t.TempDir(), DataRoot: t.TempDir(), DisableCSRF: true})
	for _, source := range []string{
		chatCompletionSourceAI21,
		chatCompletionSourceVertexAI,
		chatCompletionSourcePerplexity,
	} {
		if !pinnedChatCompletionStatusNoArmSources[source] {
			t.Fatalf("%s is asserted to fall through but is not in pinnedChatCompletionStatusNoArmSources, so this "+
				"test and the table have drifted apart", source)
		}
		response := postSecretsRoute(t, handler, "/api/backends/chat-completions/status",
			`{"chat_completion_source":"`+source+`"}`)
		if response.Code != http.StatusBadRequest {
			t.Errorf("%s: status = %d, want 400. The pinned chain has no arm for it, so its closing else answers "+
				"400 {error:true} (:2062-2065) and returns before the key guard. 501 would report a GAP where the "+
				"pinned backend REFUSES (AGENTS.md rule 17).", source, response.Code)
			continue
		}
		if body := response.Body.String(); body != `{"error":true}` {
			t.Errorf("%s: body = %q, want exactly {\"error\":true}: the pinned closing else sends a JSON body, not "+
				"Express's plain-text status message", source, body)
		}
	}
}

// TestEveryClaimedSourceHasAStatusArmOrIsInTheNoArmTable is the control the slice exists for: no source this
// package claims can reach the 501 default by accident. Every claimed source must either have its own arm in
// the status chain or be named in the no-arm table, and the two must not overlap -- an overlap would mean one
// of them is a lie about the other.
func TestEveryClaimedSourceHasAStatusArmOrIsInTheNoArmTable(t *testing.T) {
	arms := collectDispatchArms(t)
	armed := map[string]bool{}
	for _, arm := range arms {
		if arm.function == "serveBackendsChatCompletionStatus" {
			armed[arm.value] = true
		}
	}
	// A scan that matched nothing would pass every source below, so require the chain to still be visible.
	if len(armed) < 10 {
		t.Fatalf("only %d status-chain arms were found; the scan has stopped matching rather than the chain "+
			"having shrunk to that, and this control would otherwise pass vacuously", len(armed))
	}

	// CUSTOM is reached by the chain's INVERTED guard -- `if source != "custom" { <501 / unknown-name> }`
	// wraps the block, and everything below it is the custom branch -- which is not an equality arm, so the
	// scanner cannot see it. The exemption is granted only while that exact comparison is still in the file,
	// so a rename or a restructure forces a human to re-decide instead of leaving an exemption alive.
	sourceText, readErr := os.ReadFile("backends_status.go")
	if readErr != nil {
		t.Fatalf("read backends_status.go: %v", readErr)
	}
	if count := strings.Count(string(sourceText), `source != "custom"`); count != 1 {
		t.Fatalf("the custom exemption rests on exactly one `source != \"custom\"` comparison in "+
			"backends_status.go and found %d; the exemption is stale, so re-derive how custom is reached", count)
	}
	armed[chatCompletionSourceCustom] = true

	considered := make([]string, 0, len(pinnedClaimedChatCompletionSources)+len(pinnedRouteLevelChatCompletionSources))
	considered = append(considered, pinnedClaimedChatCompletionSources...)
	considered = append(considered, pinnedRouteLevelChatCompletionSources...)
	for _, source := range considered {
		hasArm := armed[source]
		inTable := pinnedChatCompletionStatusNoArmSources[source]
		switch {
		case hasArm && inTable:
			t.Errorf("%s has its own status arm AND is named in pinnedChatCompletionStatusNoArmSources; one of "+
				"the two is wrong and a reader cannot tell which", source)
		case !hasArm && !inTable:
			t.Errorf("%s is implemented but has NO status arm and is NOT in pinnedChatCompletionStatusNoArmSources, "+
				"so a status request for it answers 501 -- this route's \"not written yet\" marker -- where the "+
				"pinned chain either has an arm to port or answers its closing else's 400. Give it an arm, or name "+
				"it in the table with the pinned line that justifies it.", source)
		}
	}

	if len(pinnedChatCompletionStatusNoArmSources) == 0 {
		t.Fatal("pinnedChatCompletionStatusNoArmSources is empty; this control would report nothing")
	}
	// The derivation table has to be well-formed itself, or the cross-check below proves nothing.
	derived := map[string]bool{}
	for _, name := range pinnedStatusChainArmSources {
		if derived[name] {
			t.Errorf("pinnedStatusChainArmSources lists %q twice", name)
		}
		derived[name] = true
		if !pinnedChatCompletionSources[name] {
			t.Errorf("pinnedStatusChainArmSources lists %q, which is not a name in the pinned chat-completion "+
				"matrix; the derivation table has a typo the cross-check below would silently accept", name)
		}
	}
	for source := range pinnedChatCompletionStatusNoArmSources {
		if !pinnedChatCompletionSources[source] {
			t.Errorf("%s is in the no-arm table but is not a pinned chat-completion source at all", source)
		}
		if derived[source] {
			t.Errorf("%s is in the no-arm table but the pinned chain HAS an arm for it, so the table refuses a "+
				"source the pinned server actually fetches models for", source)
		}
	}
}
