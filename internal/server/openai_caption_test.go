package server

// Replay of tests/oracle/sillytavern-1.19.0-openai-caption.json, recorded by tools/probe-openai-caption.mjs.
//
// TWO KINDS OF ASSERTION, and they are deliberately separate:
//
//   - the ORACLE half compares what the pinned peer recorded: status, body, the outbound method, target,
//     body and per-branch authorization, and the request COUNT (zero for a guard, one per branch);
//   - the SOURCE-DERIVED half (rule 4) asserts the Go dispatch table EQUALS the fixture's `branches` list,
//     plus distinctness. Two copies of a table that are merely both present can drift while both count
//     assertions pass, so the equality is what makes drift impossible rather than unlikely.
//
// The replay peer serves mocks the way the STUB does -- first rule whose match is CONTAINED in the URL,
// honouring `times` -- because a consumer that serves by request order hands a shape the wrong mock
// (rule 20's consumer clause).

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

type openAICaptionFixture struct {
	BranchCount int `json:"branchCount"`
	Branches    []struct {
		API    string `json:"api"`
		Secret string `json:"secret"`
		URL    string `json:"url"`
	} `json:"branches"`
	Inputs struct {
		BranchCount  int      `json:"branchCount"`
		BranchValues []string `json:"branchValues"`
	} `json:"inputs"`
	APITypes  []string                      `json:"apiTypes"`
	Scenarios map[string]transcribeScenario `json:"scenarios"`
}

func loadOpenAICaptionOracle(t *testing.T) openAICaptionFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-openai-caption.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture openAICaptionFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) < 20 {
		t.Fatalf("the caption oracle records only %d scenarios", len(fixture.Scenarios))
	}
	return fixture
}

// TestOpenAICaptionDispatchTableMatchesFixture is the SOURCE-DERIVED half: the Go table must equal the
// fixture's list, value for value, and both must be distinct. A table whose expectation is derived from the
// code under test cannot fail, which is why the fixture carries the list.
func TestOpenAICaptionDispatchTableMatchesFixture(t *testing.T) {
	fixture := loadOpenAICaptionOracle(t)
	if fixture.BranchCount != 19 {
		t.Fatalf("the fixture declares %d branches, expected 19", fixture.BranchCount)
	}
	if len(openAICaptionBranches) != fixture.BranchCount {
		t.Fatalf("the Go dispatch table carries %d branches, the fixture declares %d", len(openAICaptionBranches), fixture.BranchCount)
	}
	if len(fixture.Branches) != fixture.BranchCount {
		t.Fatalf("the fixture lists %d branches but declares %d", len(fixture.Branches), fixture.BranchCount)
	}
	seenAPI := map[string]bool{}
	seenSecret := map[string]bool{}
	for index, branch := range fixture.Branches {
		if branch.API != openAICaptionBranches[index].api {
			t.Fatalf("branch %d: the Go table has api %q, the fixture has %q", index, openAICaptionBranches[index].api, branch.API)
		}
		if branch.Secret != openAICaptionBranches[index].secretID {
			t.Fatalf("branch %d (%s): the Go table has secret %q, the fixture has %q", index, branch.API, openAICaptionBranches[index].secretID, branch.Secret)
		}
		goURL := openAICaptionBranches[index].url
		if strings.Contains(goURL, "{account}") {
			// A TEMPLATED row: the fixture records the concrete account segment this run used, so equality is
			// asserted on both sides of the placeholder.
			parts := strings.SplitN(goURL, "{account}", 2)
			if !strings.HasPrefix(branch.URL, parts[0]) || !strings.HasSuffix(branch.URL, parts[1]) {
				t.Fatalf("branch %d (%s): the fixture url %q does not match the Go template %q", index, branch.API, branch.URL, goURL)
			}
		} else if branch.URL != goURL {
			t.Fatalf("branch %d (%s): the Go table has url %q, the fixture has %q", index, branch.API, goURL, branch.URL)
		}
		if seenAPI[branch.API] {
			t.Fatalf("the api value %q appears twice, so two branches collapsed into one", branch.API)
		}
		if seenSecret[branch.Secret] {
			t.Fatalf("the secret %q is used by two branches, so one branch would authenticate as another", branch.Secret)
		}
		seenAPI[branch.API] = true
		seenSecret[branch.Secret] = true
	}
	if len(seenAPI) != 19 || len(seenSecret) != 19 {
		t.Fatalf("distinct apis %d and secrets %d, both must be 19", len(seenAPI), len(seenSecret))
	}
	if len(fixture.Inputs.BranchValues) != 19 {
		t.Fatalf("the fixture's branchValues carries %d entries, expected 19", len(fixture.Inputs.BranchValues))
	}
	// The `api_type` getter table: FOURTEEN keys, asserted as a count against the fixture's list so an omitted
	// type fails as a count rather than passing as an absence. `api_type` is a different body member from
	// `api`, and with it absent the pinned server adds no additional headers at all.
	if len(fixture.APITypes) != 14 {
		t.Fatalf("the fixture lists %d api_type values, expected 14", len(fixture.APITypes))
	}
	if len(openAICaptionAPITypes) != len(fixture.APITypes) {
		t.Fatalf("the Go api_type table carries %d keys, the fixture lists %d", len(openAICaptionAPITypes), len(fixture.APITypes))
	}
	for index, apiType := range fixture.APITypes {
		if openAICaptionAPITypes[index] != apiType {
			t.Fatalf("api_type %d: the Go table has %q, the fixture has %q", index, openAICaptionAPITypes[index], apiType)
		}
	}
}

func TestOpenAICaptionMatchesPinnedOracle(t *testing.T) {
	fixture := loadOpenAICaptionOracle(t)
	names := make([]string, 0, len(fixture.Scenarios))
	for name := range fixture.Scenarios {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		scenario := fixture.Scenarios[name]
		t.Run(name, func(t *testing.T) {
			peer := newOpenAIVideoPeer(t, scenario.Mocks)
			// The seam keeps each branch's PATH and replaces its host, so a rule recorded against the host can
			// no longer match. Where a scenario has exactly one rule and one request, the rule is re-anchored on
			// the recorded path, which is the part the dispatch decides.
			if len(peer.rules) == 1 && len(scenario.Outbound) == 1 {
				parsed, err := http.NewRequest(http.MethodPost, scenario.Outbound[0].URL, nil)
				if err != nil {
					t.Fatal(err)
				}
				// EscapedPath, NOT Path: Path is DECODED, so an account id containing %2F would become a slash
				// and the rule would no longer match the request the peer receives (rule 15, in the harness).
				peer.rules[0].Match = parsed.URL.EscapedPath()
			}
			// The branch URLs are literals, so the replay points their scheme and host at the peer and keeps
			// each branch's PATH -- which is the part the dispatch decides.
			t.Setenv("GOTAVERN_OPENAI_CAPTION_BASE_URL", peer.server.URL)
			dataRoot := t.TempDir()
			handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
			writeGoogleTTSSecrets(t, dataRoot, scenario.Secrets)
			recorder := httptest.NewRecorder()
			request := httptest.NewRequest(http.MethodPost, scenario.Route, strings.NewReader(scenario.RequestBody))
			request.Header.Set("Content-Type", "application/json")
			handler.ServeHTTP(recorder, request)

			if recorder.Code != scenario.Response.Status {
				for debugIndex, debugRequest := range peer.seen {
					t.Logf("DEBUG request %d: %s %s body=%q", debugIndex, debugRequest.Method, debugRequest.URL, debugRequest.Body)
				}
				t.Fatalf("status = %d, pinned %d (body %q)", recorder.Code, scenario.Response.Status, recorder.Body.String())
			}
			if recorder.Body.String() != scenario.Response.BodyText {
				t.Fatalf("body = %q, pinned %q", recorder.Body.String(), scenario.Response.BodyText)
			}
			if len(peer.seen) != len(scenario.Outbound) {
				t.Fatalf("outbound requests = %d, pinned %d (a guard must make ZERO, a branch exactly one)", len(peer.seen), len(scenario.Outbound))
			}
			for index, recorded := range scenario.Outbound {
				actual := peer.seen[index]
				if actual.Method != recorded.Method {
					t.Fatalf("request %d method = %s, pinned %s", index, actual.Method, recorded.Method)
				}
				if actual.URL != recordedURLPath(t, recorded.URL) {
					t.Fatalf("request %d target = %q, pinned %q", index, actual.URL, recordedURLPath(t, recorded.URL))
				}
				if normalizeGoogleSeed(actual.Body) != normalizeGoogleSeed(recorded.Body) {
					t.Fatalf("request %d body = %q, pinned %q", index, actual.Body, recorded.Body)
				}
				if got, want := actual.Headers["authorization"], recorded.Headers["authorization"]; got != want {
					t.Fatalf("request %d authorization = %q, pinned %q (a branch must use ITS OWN secret)", index, got, want)
				}
			}
		})
	}
}
