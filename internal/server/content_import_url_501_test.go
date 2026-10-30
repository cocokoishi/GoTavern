package server

// THE PER-ROUTE 501 TABLE, ASSERTED INSTEAD OF READ.
//
// `docs/compatibility-matrix.md` recorded a boundary awaiting its gate: the five content-import provider
// branches answer 501 because they are NOT implemented, and 404 is reserved for the operator's whitelist
// saying no (AGENTS.md rule 17 -- an unimplemented branch must stay distinguishable from a refused one). That
// claim lived in prose and in a source comment; nothing failed if a future change made those branches answer
// 404, or fetched something before refusing.
//
// THIS TEST PINS BOTH HALVES OF EVERY BRANCH: the STATUS and the ZERO OUTBOUND REQUESTS. A 501 that had
// already contacted the provider would be a worse defect than a 404, because the user's URL would have been
// sent to a third party before the refusal.
//
// It also pins the INHERITED classifier weakness rather than tidying it (AGENTS.md architecture boundary 5):
// pinned classifies content hosts with `host.includes('chub.ai')`, so `chub.ai.attacker.example` is treated
// as chub. A drop-in replacement must reproduce that, and reproducing it silently is worse than reproducing it
// visibly -- which is why the look-alike is a row here with the reason written next to it.

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/tests/mockprovider"
)

func TestContentImportURLProviderBranchesAnswer501WithNoOutbound(t *testing.T) {
	fixtureBytes, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-content.json"))
	if err != nil {
		t.Fatalf("read the content oracle: %v", err)
	}
	var fixture contentFixture
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatalf("decode the content oracle: %v", err)
	}

	dataRoot := t.TempDir()
	handler, sessionCookie, token := contentRouteHandler(t, dataRoot, fixture.Inputs.CookieSecret, fixture.Inputs.Account, fixture.Inputs.WhitelistImportDomains)
	seedContentTree(t, dataRoot)

	// A recording peer behind every seam: if any branch fetches before refusing, the request lands HERE and the
	// assertion below sees it. Without the peer a fetch would leave for the real internet, which is exactly the
	// defect rule 14 was written for.
	peer := mockprovider.NewKeyed(nil)
	address, err := peer.Listen(0)
	if err != nil {
		t.Fatalf("start the recording peer: %v", err)
	}
	defer peer.Close()
	t.Setenv("GOTAVERN_CONTENT_AICC_URL", "http://"+address.String())

	cases := []struct {
		name       string
		target     string
		wantStatus int
		why        string
	}{
		{name: "chub", target: "https://chub.ai/characters/someone/a-character", wantStatus: http.StatusNotImplemented,
			why: "isChub -> the chub branch is not implemented, so pinned's host is refused with 501 rather than a 404 whitelist refusal"},
		{name: "characterhub", target: "https://characterhub.org/characters/someone/a-character", wantStatus: http.StatusNotImplemented,
			why: "characterhub.org is the second spelling of the chub branch"},
		{name: "janitorai", target: "https://janitorai.com/characters/00000000-0000-0000-0000-000000000000_character-name", wantStatus: http.StatusNotImplemented,
			why: "isJanny -> 501"},
		{name: "pygmalion", target: "https://pygmalion.chat/character/abc123", wantStatus: http.StatusNotImplemented,
			why: "isPygmalion -> 501"},
		{name: "risu", target: "https://realm.risuai.net/character/abc123", wantStatus: http.StatusNotImplemented,
			why: "isRisu -> 501"},
		{name: "perchance", target: "https://perchance.org/some-generator", wantStatus: http.StatusNotImplemented,
			why: "isPerchance -> 501"},
		{name: "chub-lookalike", target: "https://chub.ai.attacker.example/characters/someone/a-character", wantStatus: http.StatusNotImplemented,
			why: "INHERITED WEAKNESS, reproduced on purpose (AGENTS.md boundary 5): pinned uses host.includes('chub.ai'), so a look-alike domain is classified as chub. Answering 404 here would mean we had silently hardened a classifier and changed the compatibility claim; answering anything OTHER than 501 would mean the substring match stopped matching"},
		{name: "generic-unlisted", target: "https://not-whitelisted.example/character/1", wantStatus: http.StatusNotFound,
			why: "CONTROL: a host that matches no provider and is not in whitelistImportDomains is a POLICY refusal, and it must stay 404 so the 501 rows above keep meaning 'not written yet' (rule 17)"},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			body, err := marshalNodeJSON(map[string]any{"url": testCase.target})
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodPost, "/api/content/importURL", strings.NewReader(string(body)))
			request.Header.Set("Content-Type", "application/json")
			request.Header.Set("Cookie", sessionCookie)
			request.Header.Set("X-CSRF-Token", token)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			if recorder.Code != testCase.wantStatus {
				t.Fatalf("POST /api/content/importURL %s = %d, want %d -- %s\nbody: %s",
					testCase.target, recorder.Code, testCase.wantStatus, testCase.why, recorder.Body.String())
			}
			if requests := peer.Recording().Requests; len(requests) != 0 {
				for _, recorded := range requests {
					t.Logf("unexpected outbound: %s %s", recorded.Method, recorded.RawTarget)
				}
				t.Fatalf("%s: the refusal issued %d outbound request(s), want 0 -- a branch that fetches before refusing has already sent the user's URL to a third party",
					testCase.target, len(requests))
			}
			peer.Reset(nil)
		})
	}
}
