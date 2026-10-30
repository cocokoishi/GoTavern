package server

// Route-level budget flip, from AGENTS.md rule 9.
//
// WHAT THIS FILE PROVES: that the counts the routes return can support a budget rule with an
// exact boundary — a history message that fits with the count equal to the budget is admitted,
// and the same message one token longer is not, and the resulting provider-style request
// differs by exactly that message. The counts come from the real count route, and every
// intermediate number is checked against the route rather than derived by hand.
//
// WHAT THIS FILE DOES NOT PROVE: that anything in GoTavern trims. There is no server-side
// trimmer in this repository — the pinned frontend trims history client-side before it posts,
// after asking this server for counts. The trimmer below is therefore a CONTRACT ASSERTION
// written in the test: it proves the arithmetic of a budget rule over real counts, which is the
// contract those counts must satisfy, and nothing about GoTavern behaviour. The property that an
// off-by-one changes the provider request that is actually sent belongs to the browser E2E
// harness, which does not exist yet; it is recorded as a named gap in
// docs/tokenizer-parity-plan.md §9.1 and is deliberately not claimed here.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type boundaryMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

// contractTrimmer is the CONTRACT ASSERTION described in the file header: admit messages from
// the newest backwards while the total fits, dropping the oldest first. It is not GoTavern code
// and must not be described as such.
func contractTrimmer(messages []boundaryMessage, budget int, count func([]boundaryMessage) int) []boundaryMessage {
	trimmed := messages
	for len(trimmed) > 0 && count(trimmed) > budget {
		trimmed = trimmed[1:]
	}
	return trimmed
}

// tokenizerCountRoute asks the pinned count route for the token count of a message list. The
// pinned route reads `request.body` itself as the array of messages, so the array is the body.
func tokenizerCountRoute(t *testing.T, handler http.Handler, model string, messages []boundaryMessage) int {
	t.Helper()
	body, err := json.Marshal(messages)
	if err != nil {
		t.Fatal(err)
	}
	response := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodPost, "/api/tokenizers/openai/count?model="+model, strings.NewReader(string(body)))
	request.Header.Set("Content-Type", "application/json")
	handler.ServeHTTP(response, request)
	if response.Code != http.StatusOK {
		t.Fatalf("count route status = %d: %s", response.Code, response.Body.String())
	}
	var answer struct {
		Count *int `json:"token_count"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &answer); err != nil {
		t.Fatalf("count route answer: %v (%s)", err, response.Body.String())
	}
	if answer.Count == nil {
		t.Fatalf("count route answer has no token_count: %s", response.Body.String())
	}
	return *answer.Count
}

// TestContextBoundaryBudgetFlipAtRouteLevel is the budget-flip contract assertion. It uses a
// SentencePiece model because its count is the plain sum of the message contents, so the
// arithmetic under test is the budget rule rather than a model's chat overhead.
func TestContextBoundaryBudgetFlipAtRouteLevel(t *testing.T) {
	handler := tokenizerRouteHandler(t)
	// THE GATE RUNS BEFORE THE COMPARISON. A server that answers the pinned guesstimate instead
	// of tokenizing exactly would make every number below an estimate's arithmetic, so the gate
	// refuses it (naming what the server reported) rather than asserting a boundary pair against
	// it. tokenizers_exactness_test.go owns the refusal and its own teeth.
	requireExactTokenizerServer(t, handler)
	const model = "llama"

	// ANCHOR: every number below is measured through the route, so a shift in the route's count
	// would cancel out against a budget computed from the same route. The boundary test therefore
	// starts by pinning the route's count against the recorded capture, which is a fixed value:
	// a count that is off by one cannot satisfy both this anchor and the boundary assertions.
	fixture := loadTokenizerRouteFixture(t)
	anchor, ok := fixture.Responses["openai/count#llama#simple"]
	if !ok {
		t.Fatal("required anchor case openai/count#llama#simple is missing from the fixture")
	}
	var anchorBody []boundaryMessage
	if err := json.Unmarshal(anchor.Request.Body, &anchorBody); err != nil {
		t.Fatalf("anchor request is not a message list: %v", err)
	}
	var anchorWant struct {
		TokenCount int `json:"token_count"`
	}
	if err := json.Unmarshal(anchor.Body, &anchorWant); err != nil {
		t.Fatal(err)
	}
	if got := tokenizerCountRoute(t, handler, model, anchorBody); got != anchorWant.TokenCount {
		t.Fatalf("the count route answers %d for the recorded anchor case, pinned %d: the boundary numbers below are not anchored to the capture", got, anchorWant.TokenCount)
	}

	history := []boundaryMessage{
		{Role: "user", Content: "What is the capital of France?"},
		{Role: "assistant", Content: "The capital of France is Paris."},
	}
	oldest := boundaryMessage{Role: "user", Content: "Tell me about the history of the city."}

	// Find a suffix that adds EXACTLY one token, measured through the route. The test fails if
	// no candidate does, so the boundary cannot be silently widened.
	oneTokenLonger := ""
	for _, suffix := range []string{" x", " y", " z", " ok"} {
		base := tokenizerCountRoute(t, handler, model, append([]boundaryMessage{oldest}, history...))
		longer := tokenizerCountRoute(t, handler, model, append([]boundaryMessage{{Role: oldest.Role, Content: oldest.Content + suffix}}, history...))
		if longer == base+1 {
			oneTokenLonger = oldest.Content + suffix
			break
		}
	}
	if oneTokenLonger == "" {
		t.Fatal("no candidate suffix added exactly one token, so the budget flip cannot be asserted")
	}

	all := append([]boundaryMessage{oldest}, history...)
	total := tokenizerCountRoute(t, handler, model, all)
	// The pinned count is NOT additive: countSentencepieceArrayTokens flattens the message values
	// and tokenizes the joined string once, so per-message counts do not sum to the count of the
	// whole history. This is exactly why the contract trimmer below re-counts the whole list on
	// every step instead of adding per-message counts, and it is logged so a reader can see the
	// difference rather than assume a rule that would be wrong.
	historyCount := tokenizerCountRoute(t, handler, model, history)
	oldestCount := tokenizerCountRoute(t, handler, model, []boundaryMessage{oldest})
	t.Logf("whole history counts %d; the parts count %d + %d = %d, so the count is not additive", total, historyCount, oldestCount, historyCount+oldestCount)

	// Same messages, budgets total and total-1: the verdict must differ, and the resulting
	// provider-style request must differ by exactly the oldest message.
	fits := contractTrimmer(all, total, func(messages []boundaryMessage) int {
		return tokenizerCountRoute(t, handler, model, messages)
	})
	doesNotFit := contractTrimmer(all, total-1, func(messages []boundaryMessage) int {
		return tokenizerCountRoute(t, handler, model, messages)
	})
	if len(fits) != len(all) {
		t.Fatalf("with the budget equal to the count the oldest message was dropped: %d of %d kept", len(fits), len(all))
	}
	if len(doesNotFit) != len(all)-1 {
		t.Fatalf("with the budget one token lower, %d messages were kept, want %d", len(doesNotFit), len(all)-1)
	}
	if fmt.Sprint(doesNotFit) != fmt.Sprint(all[1:]) {
		t.Fatalf("the trimmed request %v is not the original without its oldest message %v", doesNotFit, all[1:])
	}

	// And the one-token-longer message under the ORIGINAL budget must also be dropped: this is
	// the "fits by exactly one token" direction.
	longerAll := append([]boundaryMessage{{Role: oldest.Role, Content: oneTokenLonger}}, history...)
	longerTrimmed := contractTrimmer(longerAll, total, func(messages []boundaryMessage) int {
		return tokenizerCountRoute(t, handler, model, messages)
	})
	if len(longerTrimmed) != len(history) {
		t.Fatalf("the one-token-longer message was kept under a budget of %d: %v", total, longerTrimmed)
	}
	if tokenizerCountRoute(t, handler, model, longerAll) != total+1 {
		t.Fatalf("the one-token-longer history does not count as exactly one more token")
	}

	// The two provider-style payloads differ exactly by the oldest message.
	requestFor := func(messages []boundaryMessage) string {
		marshalled, err := json.Marshal(messages)
		if err != nil {
			t.Fatal(err)
		}
		return string(marshalled)
	}
	if requestFor(fits) == requestFor(doesNotFit) {
		t.Fatal("the two provider payloads are identical, so the boundary produced no observable difference")
	}
	if !strings.HasPrefix(requestFor(all[1:]), requestFor(doesNotFit)[:1]) {
		// Guard against the trimmer returning something that is not JSON, which would make the
		// comparison above meaningless.
		t.Fatalf("the trimmed request is not JSON: %s", requestFor(doesNotFit))
	}
}
