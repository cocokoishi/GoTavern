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
var pinnedUnportedChatCompletionSources = []string{"perplexity", "moonshot", "cometapi", "vertexai", "makersuite"}

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
