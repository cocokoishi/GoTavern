package server

import (
	"net/http"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// THE UNPORTED-SOURCE CONTROL, AND THE INVARIANT THAT KEEPS IT HONEST.
//
// Several per-source tests assert that this route does not fabricate a transport for a source it has not
// implemented: the control answers 501 and issues no request. Those assertions named whichever source happened
// to be unimplemented when the test was written, and NINE sources landed at once, so several controls silently
// became "assert that an implemented source is unimplemented" -- a control that drifted rather than weakened.
//
// COMETAPI IS THE STABLE CONTROL. chat-completions.js assembles its URL and key and then unconditionally throws
// "This provider is temporarily disabled", so the pinned product never sends a request for it: it is refused
// UPSTREAM and can never be implemented here. Every control test now names it, and
// TestCometapiIsTheUnportedControl proves the control itself still holds, so a future landing cannot move it.
//
// THE INVARIANT: every source this package CLAIMS to support must plan a request or fail for a reason that is
// not 501. Adding a source without claiming it here fails that source's own "not 501" test; claiming it here
// without implementing it fails THIS test. The two lists can no longer swap silently.
var pinnedClaimedChatCompletionSources = []string{
	"openai", "custom", "openrouter", "claude", "mistralai", "deepseek",
	"groq", "siliconflow", "nanogpt", "workers_ai", "pollinations", "fireworks",
	"zai", "chutes", "ai21", "cohere", "electronhub", "aimlapi", "xai", "azure_openai",
	"perplexity", "moonshot",
}

// pinnedUnportedChatCompletionSources are the pinned sources with NO transport here. perplexity and moonshot
// are implemented on branches that have not landed yet; when they land, MOVE them out of this list and the
// invariant will hold for them too. cometapi is refused by pinned itself and stays.
// pinnedRouteLevelChatCompletionSources are sources dispatched at ROUTE level, before the shared plan, because
// their ordering matters: MINIMAX must be reached BEFORE pinnedChatCompletionPlan, which answers 501 for a source
// it does not plan -- dispatching it after the plan made its own lane report 501 for a source it had just
// implemented. They are deliberately NOT in pinnedClaimedChatCompletionSources, whose invariant is about the
// PLAN path; claiming them there would assert the opposite of the ordering they need.
//
// TO ADD THE NEXT ONE: append its source name here, add it to the route-level dispatch (which lives in
// serveChatCompletionGenerate), and assert its own pinned status in its source's test file.
var pinnedRouteLevelChatCompletionSources = []string{"minimax"}

// pinnedUnknownChatCompletionSource is a name the PINNED PRODUCT DOES NOT KNOW. It is the only control
// that cannot rot: every real source name in the pinned matrix is a name that will eventually be
// implemented, and a control naming one of those silently turns into "assert that an implemented
// source is unimplemented" on the day it lands. That happened to CLAUDE, to COHERE and to AI21 --
// each was this control in some file before it was ported. Both pinned chains answer an unknown name
// with 400 {"error":true} and no provider call -- generate at chat-completions.js:2594-2597 and
// status at :2062-2065 -- so 400 is the pinned behaviour, not a fallback.
const pinnedUnknownChatCompletionSource = "probe-unknown-source"

// PERPLEXITY and MOONSHOT were moved OUT of this list when they landed: they now plan a request, so the
// invariant above holds for them instead. What remains here is the Gemini pair (whose URL layer is in but
// whose body layer is not) and COMETAPI, which pinned refuses upstream.
var pinnedUnportedChatCompletionSources = []string{"cometapi", "vertexai", "makersuite"}

func startupUserDirectoriesEmpty() startup.UserDirectories { return startup.UserDirectories{} }

func TestEveryClaimedSourceIsImplemented(t *testing.T) {
	for _, source := range pinnedClaimedChatCompletionSources {
		body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"` + source + `","model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
		if err != nil {
			t.Fatalf("%s: %v", source, err)
		}
		_, failure := pinnedChatCompletionPlan(body, startupUserDirectoriesEmpty(), "")
		if failure != nil && failure.status == http.StatusNotImplemented {
			t.Fatalf("%s is CLAIMED as implemented but the plan answers 501; either implement it or move it out of pinnedClaimedChatCompletionSources", source)
		}
	}
}

func TestCometapiIsTheUnportedControl(t *testing.T) {
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"cometapi","model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	request, failure := pinnedChatCompletionPlan(body, startupUserDirectoriesEmpty(), "")
	if failure == nil || failure.status != http.StatusNotImplemented {
		t.Fatalf("the cometapi control must answer 501, got %+v", failure)
	}
	if request != nil {
		t.Fatalf("a 501 must build no request, got %+v", request)
	}
	for _, source := range pinnedUnportedChatCompletionSources {
		unported, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"` + source + `","model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
		if err != nil {
			t.Fatalf("%s: %v", source, err)
		}
		if _, unportedFailure := pinnedChatCompletionPlan(unported, startupUserDirectoriesEmpty(), ""); unportedFailure == nil || unportedFailure.status != http.StatusNotImplemented {
			t.Fatalf("%s is listed as unported but answers %+v; the list and the dispatch disagree", source, unportedFailure)
		}
	}
}

// TestEveryRouteLevelSourceIsDispatched keeps the two lists from silently swallowing each other: a route-level
// source must be routable (its own test asserts the status it answers) while the PLAN path stays untouched for
// it -- 501 there is the observable proof that nothing moved it behind the shared plan.
// TestUnportedSourcesAnswer501AtTheRoute is rule 17 at ROUTE level, driven by the registry instead of by a
// hardcoded name: every source listed as unported must answer 501 on the generate route. This is the durable
// home of the "not written yet" claim, because the list is the thing a landing lane edits -- the claim then
// follows the list instead of drifting away from it, which is what happened to CLAUDE, COHERE and AI21.
//
// THE DAY THE LIST IS EMPTY this test FAILS ON PURPOSE. Rule 17 exists so a refusal and a gap cannot look
// alike; when nothing is unimplemented there is no gap left to preserve, and a human has to decide whether the
// 501 arm stays (with the unknown-name control carrying the distinction on its own) or is deleted. A version of
// this test that passed on an empty list would record neither decision.
func TestUnportedSourcesAnswer501AtTheRoute(t *testing.T) {
	if len(pinnedUnportedChatCompletionSources) == 0 {
		t.Fatal("pinnedUnportedChatCompletionSources is empty: nothing is unimplemented any more, so decide what the 501 arm now means (see this test's comment) instead of letting the claim pass vacuously")
	}
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: t.TempDir(), DataRoot: t.TempDir(), DisableCSRF: true})
	for _, source := range pinnedUnportedChatCompletionSources {
		response := postSecretsRoute(t, handler, "/api/backends/chat-completions/generate",
			`{"chat_completion_source":"`+source+`","model":"m","messages":[{"role":"user","content":"probe"}]}`)
		if response.Code != http.StatusNotImplemented {
			t.Fatalf("%s is listed as unported but the route answered %d, want 501 so the gap stays visible", source, response.Code)
		}
	}
	// The unknown name is the other half of the same distinction, asserted against the SAME route, so a route
	// that answered one status to everything cannot satisfy both halves.
	unknown := postSecretsRoute(t, handler, "/api/backends/chat-completions/generate",
		`{"chat_completion_source":"`+pinnedUnknownChatCompletionSource+`","model":"m","messages":[{"role":"user","content":"probe"}]}`)
	if unknown.Code != http.StatusBadRequest {
		t.Fatalf("an unknown source name answered %d, want the pinned chain's 400 (:2594-2597); without that 501 cannot be told apart from a refusal", unknown.Code)
	}
}

func TestEveryRouteLevelSourceIsDispatched(t *testing.T) {
	for _, source := range pinnedRouteLevelChatCompletionSources {
		for _, claimed := range pinnedClaimedChatCompletionSources {
			if claimed == source {
				t.Fatalf("%s is claimed at PLAN level and also listed as route-level; pick one", source)
			}
		}
		body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"` + source + `","model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
		if err != nil {
			t.Fatalf("%s: %v", source, err)
		}
		request, failure := pinnedChatCompletionPlan(body, startupUserDirectoriesEmpty(), "")
		if failure == nil || failure.status != http.StatusNotImplemented || request != nil {
			t.Fatalf("%s must stay OUT of the plan path (501, no request) so its route-level dispatch keeps its ordering, got %+v / %+v", source, failure, request)
		}
	}
}
