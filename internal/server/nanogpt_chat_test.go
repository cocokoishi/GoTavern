package server

// What the NANOGPT recording cannot state by itself.
//
//  1. THE SEAM DEFAULT -- the replay always points the Go leg through GOTAVERN_NANOGPT_CHAT_URL, so the
//     default is asserted against the literal the fixture recorded.
//  2. THE `:online` RULE IS CONDITIONAL. The positive capture (web search on, unsuffixed model) is satisfied
//     by an implementation that appends unconditionally; the already-suffixed capture is what fails it. Both
//     the recorded bodies and the predicate itself are checked, and the recorded body is counted for
//     occurrences so a DOUBLE suffix cannot hide behind a substring match.
//  3. THE OPTION FOLDINGS ARE ABSENT WHEN NOT ASKED FOR. A header list that always sends X-Provider and
//     X-Billing-Mode would pass the option capture alone, so the plain capture is asserted to carry neither.
//  4. THE STATUS QUERY is `detailed=true`, which only a URL-level assertion can see.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type nanoGPTWireFixture struct {
	Scenarios map[string]struct {
		TargetPath string `json:"targetPath"`
		GoSeam     struct {
			EnvironmentVariable string `json:"pinnedLiteral"` // unused sentinel to keep the struct honest
		} `json:"-"`
		Seam struct {
			EnvironmentVariable string `json:"environmentVariable"`
			PinnedLiteral       string `json:"pinnedLiteral"`
		} `json:"goSeam"`
		Provider struct {
			Requests []struct {
				Method   string `json:"method"`
				RawQuery string `json:"rawQuery"`
				BodyText string `json:"bodyText"`
				Headers  []struct {
					Name  string `json:"name"`
					Value string `json:"value"`
				} `json:"headers"`
			} `json:"requests"`
		} `json:"provider"`
	} `json:"scenarios"`
}

func loadNanoGPTWireFixture(t *testing.T) nanoGPTWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture nanoGPTWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"nanogpt-nonstream", "nanogpt-online-already-suffixed", "nanogpt-web-search-appends",
		"nanogpt-provider-payg-reasoning", "nanogpt-stream", "nanogpt-error-status", "nanogpt-status",
	} {
		if _, exists := fixture.Scenarios[required]; !exists {
			t.Fatalf("the provider-wire fixture records no %q scenario", required)
		}
	}
	return fixture
}

func nanoGPTBody(t *testing.T, fixture nanoGPTWireFixture, name string) string {
	t.Helper()
	scenario := fixture.Scenarios[name]
	if len(scenario.Provider.Requests) != 1 {
		t.Fatalf("%s records %d provider requests, want 1", name, len(scenario.Provider.Requests))
	}
	return scenario.Provider.Requests[0].BodyText
}

// TestChatCompletionNanoGPTSeamDefault pins the default against the recorded literal.
func TestChatCompletionNanoGPTSeamDefault(t *testing.T) {
	fixture := loadNanoGPTWireFixture(t)
	for name, scenario := range fixture.Scenarios {
		if !strings.HasPrefix(name, "nanogpt-") {
			continue
		}
		if scenario.TargetPath != chatCompletionSourceNG {
			t.Fatalf("%s targetPath = %q", name, scenario.TargetPath)
		}
		if scenario.Seam.PinnedLiteral != pinnedNanoGPTAPIURL {
			t.Fatalf("%s: fixture literal %q vs Go literal %q", name, scenario.Seam.PinnedLiteral, pinnedNanoGPTAPIURL)
		}
		if scenario.Seam.EnvironmentVariable != pinnedNanoGPTSeamEnv {
			t.Fatalf("%s: fixture seam %q vs code seam %q", name, scenario.Seam.EnvironmentVariable, pinnedNanoGPTSeamEnv)
		}
	}
	t.Setenv(pinnedNanoGPTSeamEnv, "")
	if got := pinnedNanoGPTBaseURL(); got != pinnedNanoGPTAPIURL {
		t.Fatalf("default = %q, want %q", got, pinnedNanoGPTAPIURL)
	}
}

// TestChatCompletionNanoGPTOnlineSuffixIsConditional is the negative test the positive capture cannot give.
func TestChatCompletionNanoGPTOnlineSuffixIsConditional(t *testing.T) {
	fixture := loadNanoGPTWireFixture(t)
	appended := nanoGPTBody(t, fixture, "nanogpt-web-search-appends")
	if !strings.Contains(appended, `"model":"probe-model:online"`) {
		t.Fatalf("web-search body does not carry the appended suffix: %s", appended)
	}
	already := nanoGPTBody(t, fixture, "nanogpt-online-already-suffixed")
	if got := strings.Count(already, ":online"); got != 1 {
		t.Fatalf("an already-suffixed model carries %d occurrences of :online, want exactly 1: %s", got, already)
	}
	if strings.Contains(already, ":online:online") {
		t.Fatalf("the suffix was appended twice: %s", already)
	}
	plain := nanoGPTBody(t, fixture, "nanogpt-nonstream")
	if strings.Contains(plain, ":online") {
		t.Fatalf("a request without enable_web_search gained the suffix: %s", plain)
	}

	cases := []struct {
		body    string
		want    string
		changed bool
	}{
		{`{"model":"probe-model","enable_web_search":true}`, "probe-model:online", true},
		{`{"model":"probe-model:online","enable_web_search":true}`, "probe-model:online", false},
		{`{"model":"probe-model","enable_web_search":false}`, "probe-model", false},
		{`{"model":"probe-model"}`, "probe-model", false},
		{`{"model":"probe-model","enable_web_search":"yes"}`, "probe-model:online", true},
	}
	for _, testCase := range cases {
		body, err := decodeOrderedNodeJSON([]byte(testCase.body))
		if err != nil {
			t.Fatal(err)
		}
		got, changed := pinnedNanoGPTModel(body)
		if got != testCase.want || changed != testCase.changed {
			t.Fatalf("%s -> (%q,%v), want (%q,%v)", testCase.body, got, changed, testCase.want, testCase.changed)
		}
	}
}

// TestChatCompletionNanoGPTOptionFoldingsAndTheirAbsence pairs the option capture with the plain one.
func TestChatCompletionNanoGPTOptionFoldingsAndTheirAbsence(t *testing.T) {
	fixture := loadNanoGPTWireFixture(t)
	options := nanoGPTBody(t, fixture, "nanogpt-provider-payg-reasoning")
	for _, want := range []string{
		`"billing_mode":"paygo"`,
		`"reasoning":{"effort":"low"}`,
		`"min_p":0.25`,
		`"top_a":0.5`,
		`"repetition_penalty":1.1`,
	} {
		if !strings.Contains(options, want) {
			t.Fatalf("the option body does not carry %s: %s", want, options)
		}
	}
	headerNames := make(map[string]string, 4)
	for _, header := range fixture.Scenarios["nanogpt-provider-payg-reasoning"].Provider.Requests[0].Headers {
		headerNames[strings.ToLower(header.Name)] = header.Value
	}
	if got := headerNames["x-provider"]; got != "probe-provider" {
		t.Fatalf("X-Provider = %q, want probe-provider", got)
	}
	if got := headerNames["x-billing-mode"]; got != "paygo" {
		t.Fatalf("X-Billing-Mode = %q, want paygo", got)
	}

	plain := nanoGPTBody(t, fixture, "nanogpt-nonstream")
	for _, unwanted := range []string{"billing_mode", "reasoning", "min_p", "top_a", "repetition_penalty"} {
		if strings.Contains(plain, unwanted) {
			t.Fatalf("the plain capture carries %s, so the folding is unconditional: %s", unwanted, plain)
		}
	}
	plainHeaders := make(map[string]bool, 8)
	for _, header := range fixture.Scenarios["nanogpt-nonstream"].Provider.Requests[0].Headers {
		plainHeaders[strings.ToLower(header.Name)] = true
	}
	if plainHeaders["x-provider"] || plainHeaders["x-billing-mode"] {
		t.Fatalf("the plain capture sends a NanoGPT header: %v", plainHeaders)
	}
}

// TestChatCompletionNanoGPTPlanCarriesTheFoldedOptions drives the PLAN, not the fixture: the recorded body
// proves what pinned sent, and this proves the branch composes the same thing. Without it a mutation that
// made the effort map the identity (medium -> medium) survived, because every assertion was reading the
// recording rather than the code that has to reproduce it.
func TestChatCompletionNanoGPTPlanCarriesTheFoldedOptions(t *testing.T) {
	installRoot := t.TempDir()
	dataRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte("gotavern-nanogpt-plan-test"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, dirErr := startup.DirectoriesForUser(dataRoot, "default-user")
	if dirErr != nil {
		t.Fatal(dirErr)
	}
	secrets := []byte(`{"api_key_nanogpt":[{"id":"probe-id","value":"synthetic-nanogpt-key","label":"api_key_nanogpt","active":true}]}`)
	if err := os.WriteFile(filepath.Join(directories["root"], "secrets.json"), secrets, 0o600); err != nil {
		t.Fatal(err)
	}
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"nanogpt","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false,"nanogpt_provider":"probe-provider","nanogpt_payg_override":true,"min_p":0.25,"reasoning_effort":"medium","enable_web_search":true}`))
	if err != nil {
		t.Fatal(err)
	}
	request, failure := pinnedChatCompletionPlan(body, directories, "")
	if failure != nil {
		t.Fatalf("plan failed: %+v", failure)
	}
	encoded := string(request.Body)
	for _, want := range []string{`"reasoning":{"effort":"low"}`, `"billing_mode":"paygo"`, `"min_p":0.25`, `"model":"probe-model:online"`} {
		if !strings.Contains(encoded, want) {
			t.Fatalf("the plan body does not carry %s: %s", want, encoded)
		}
	}
	headers := make(map[string]string, len(request.Headers))
	for _, header := range request.Headers {
		headers[strings.ToLower(header.Name)] = header.Value
	}
	if headers["x-provider"] != "probe-provider" {
		t.Fatalf("plan X-Provider = %q", headers["x-provider"])
	}
	if headers["x-billing-mode"] != "paygo" {
		t.Fatalf("plan X-Billing-Mode = %q", headers["x-billing-mode"])
	}
}

// TestChatCompletionNanoGPTStatusURLCarriesDetailed pins the status query the arm builds.
func TestChatCompletionNanoGPTStatusURLCarriesDetailed(t *testing.T) {
	fixture := loadNanoGPTWireFixture(t)
	request := fixture.Scenarios["nanogpt-status"].Provider.Requests[0]
	if request.Method != "GET" {
		t.Fatalf("status method = %q", request.Method)
	}
	if request.RawQuery != "detailed=true" {
		t.Fatalf("recorded status query = %q, want detailed=true", request.RawQuery)
	}
	t.Setenv(pinnedNanoGPTSeamEnv, "")
	want := pinnedNanoGPTAPIURL + "/models?detailed=true"
	if got := pinnedNanoGPTStatusURL(); got != want {
		t.Fatalf("status URL = %q, want %q", got, want)
	}
}

// TestChatCompletionNanoGPTIsNotTheDefaultRefusal proves the source reaches a served branch.
func TestChatCompletionNanoGPTIsNotTheDefaultRefusal(t *testing.T) {
	directories := startup.UserDirectories{}
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"nanogpt","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := pinnedChatCompletionPlan(body, directories, ""); failure != nil && failure.status == 501 {
		t.Fatal("nanogpt is answered by the default 501 branch; its plan case is missing")
	}
	unimplemented, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"ai21","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := pinnedChatCompletionPlan(unimplemented, directories, ""); failure == nil || failure.status != 501 {
		t.Fatalf("a source this lane does not implement must answer 501, got %+v", failure)
	}
}
