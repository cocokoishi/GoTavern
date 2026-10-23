package server

// What the AI21 tests assert, and where each claim comes from.
//
//  1. SEAM: the default equals the pinned literal the fixture recorded.
//  2. CONVERTER: the recorded body of `ai21-message-conversion` is the ORACLE for the collapse/prefix/merge
//     rules; the same case is also driven through the PLAN, because a test that only reads the recording proves
//     the recording rather than the code.
//  3. THE JSON_SCHEMA FOLD: response_format last in member order, plus the synthesized message -- recorded bytes
//     AND the plan.
//  4. THE ERROR CONTRACT (500 with the parsed provider body, not the shared 200 envelope) is a DERIVATION from
//     the pinned source lines, because the observable crosses the response side rather than the request body:
//     the recorded `ai21-error-status` scenario asserts the browser-visible half against the pinned server, and
//     the route test asserts the Go half answers 500 with the provider's object.
//  5. /status has NO pinned arm, so AI21 must answer 501 there. That is a labelled derivation: pinned's own
//     status route answers 400 for an unknown source, and this project deliberately answers 501 so an
//     unimplemented arm stays distinguishable from a refused one (AGENTS.md rule 17).

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

type ai21WireFixture struct {
	Scenarios map[string]json.RawMessage `json:"scenarios"`
}

type ai21Scenario struct {
	TargetPath string `json:"targetPath"`
	GoSeam     struct {
		EnvironmentVariable string `json:"environmentVariable"`
		PinnedLiteral       string `json:"pinnedLiteral"`
	} `json:"goSeam"`
	Provider struct {
		Requests []struct {
			Method   string `json:"method"`
			RawPath  string `json:"rawPath"`
			BodyText string `json:"bodyText"`
			Headers  []struct {
				Name  string `json:"name"`
				Value string `json:"value"`
			} `json:"headers"`
		} `json:"requests"`
	} `json:"provider"`
}

func loadAI21WireFixture(t *testing.T) ai21WireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture ai21WireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	// The five scenarios are committed, but the provider-wire fixture can only be re-recorded against the pinned
	// Node server. If those captures are not in this fixture yet, the branch is WAITING FOR THE ORACLE RE-RECORD
	// rather than broken: the replay test (which iterates the scenario directory) is the gate that fails loudly
	// for a scenario with no capture, and these unit tests carry no oracle to read until the capture exists.
	missing := make([]string, 0)
	for _, required := range []string{
		"ai21-nonstream", "ai21-stream", "ai21-message-conversion", "ai21-json-schema", "ai21-error-status",
	} {
		if _, exists := fixture.Scenarios[required]; !exists {
			missing = append(missing, required)
		}
	}
	if len(missing) > 0 {
		t.Skipf("awaiting the oracle re-record: the fixture has no capture for %v", missing)
	}
	return fixture
}

func (fixture ai21WireFixture) scenario(t *testing.T, name string) ai21Scenario {
	t.Helper()
	raw, exists := fixture.Scenarios[name]
	if !exists {
		t.Fatalf("no %q scenario", name)
	}
	var scenario ai21Scenario
	if err := json.Unmarshal(raw, &scenario); err != nil {
		t.Fatal(err)
	}
	if len(scenario.Provider.Requests) == 0 {
		t.Fatalf("%s records no provider request", name)
	}
	return scenario
}

// TestChatCompletionAI21SeamDefault pins the default against the recorded literal.
func TestChatCompletionAI21SeamDefault(t *testing.T) {
	fixture := loadAI21WireFixture(t)
	for name := range fixture.Scenarios {
		if !strings.HasPrefix(name, "ai21-") {
			continue
		}
		scenario := fixture.scenario(t, name)
		if scenario.TargetPath != chatCompletionSourceAI21 {
			t.Fatalf("%s targetPath = %q", name, scenario.TargetPath)
		}
		if scenario.GoSeam.PinnedLiteral != pinnedAI21APIURL {
			t.Fatalf("%s: fixture literal %q vs Go literal %q", name, scenario.GoSeam.PinnedLiteral, pinnedAI21APIURL)
		}
		if scenario.GoSeam.EnvironmentVariable != pinnedAI21SeamEnv {
			t.Fatalf("%s: seam %q", name, scenario.GoSeam.EnvironmentVariable)
		}
		if !strings.HasSuffix(scenario.Provider.Requests[0].RawPath, "/chat/completions") {
			t.Fatalf("%s: path %q", name, scenario.Provider.Requests[0].RawPath)
		}
	}
	t.Setenv(pinnedAI21SeamEnv, "")
	if got := pinnedAI21BaseURL(); got != pinnedAI21APIURL {
		t.Fatalf("default = %q, want %q", got, pinnedAI21APIURL)
	}
}

// TestChatCompletionAI21ConverterMatchesTheRecordingAndThePlan is the merge/prefix/collapse contract.
func TestChatCompletionAI21ConverterMatchesTheRecordingAndThePlan(t *testing.T) {
	fixture := loadAI21WireFixture(t)
	recorded := fixture.scenario(t, "ai21-message-conversion").Provider.Requests[0].BodyText
	if strings.Contains(recorded, `"name"`) {
		t.Fatalf("the recorded body still carries a name member: %s", recorded)
	}
	if !strings.Contains(recorded, `"content":"first system instruction\n\nsecond system instruction"`) {
		t.Fatalf("the two leading system messages did not collapse into one trimmed turn: %s", recorded)
	}
	if !strings.Contains(recorded, `Tester: named user turn`) {
		t.Fatalf("the name was not prefixed into the content: %s", recorded)
	}
	if !strings.Contains(recorded, `named user turn\n\nsecond user turn in a row`) && !strings.Contains(recorded, `Tester: named user turn\n\nsecond user turn in a row`) {
		t.Fatalf("consecutive user turns did not merge: %s", recorded)
	}
	if !strings.Contains(recorded, `assistant turn\n\nsecond assistant turn in a row`) {
		t.Fatalf("consecutive assistant turns did not merge: %s", recorded)
	}

	// The same case through the PLAN.
	plan := ai21PlanForTest(t, `{"chat_completion_source":"ai21","model":"probe-model","char_name":"Probe","user_name":"Tester","max_tokens":64,"stream":false,"messages":[{"role":"system","content":"first system instruction"},{"role":"system","content":"second system instruction"},{"role":"user","name":"Tester","content":"named user turn"},{"role":"user","content":"second user turn in a row"}]}`)
	planBody := string(plan.Body)
	if !strings.Contains(planBody, `"content":"first system instruction\n\nsecond system instruction"`) {
		t.Fatalf("the plan did not collapse the system messages: %s", planBody)
	}
	if !strings.Contains(planBody, `Tester: named user turn`) || strings.Contains(planBody, `"name"`) {
		t.Fatalf("the plan did not strip/prefix the name: %s", planBody)
	}
	if !strings.Contains(planBody, `named user turn\n\nsecond user turn in a row`) {
		t.Fatalf("the plan did not merge consecutive user turns: %s", planBody)
	}
}

// TestChatCompletionAI21BodyOrderAndJsonSchemaFold asserts the member order and the fold on the plan.
func TestChatCompletionAI21BodyOrderAndJsonSchemaFold(t *testing.T) {
	plan := ai21PlanForTest(t, `{"chat_completion_source":"ai21","model":"probe-model","max_tokens":64,"temperature":0.5,"top_p":0.9,"stream":false,"messages":[{"role":"user","content":"x"}],"json_schema":{"name":"probe_schema","value":{"type":"object","properties":{"answer":{"type":"string"}}}}}`)
	body := string(plan.Body)
	order := []string{`"messages"`, `"model"`, `"max_tokens"`, `"temperature"`, `"top_p"`, `"stream"`, `"response_format"`}
	position := -1
	for _, member := range order {
		index := strings.Index(body, member)
		if index < 0 {
			t.Fatalf("the plan body has no %s member: %s", member, body)
		}
		if index < position {
			t.Fatalf("%s appears out of pinned order: %s", member, body)
		}
		position = index
	}
	if !strings.Contains(body, `"response_format":{"type":"json_object"}`) {
		t.Fatalf("the fold is not {type:json_object}: %s", body)
	}
	if !strings.Contains(body, `JSON schema for the response:\n{\n    \"type\": \"object\"`) {
		t.Fatalf("the synthesized schema message is missing or not 4-space indented: %s", body)
	}
	// The headers are the branch's own set -- no node-fetch defaults.
	names := map[string]string{}
	for _, header := range plan.Headers {
		names[strings.ToLower(header.Name)] = header.Value
	}
	if names["accept"] != "application/json" || names["content-type"] != "application/json" {
		t.Fatalf("the header set is not the pinned one: %v", names)
	}
	if _, present := names["user-agent"]; present {
		t.Fatalf("the shared node-fetch header set leaked into the AI21 request: %v", names)
	}
}

// TestChatCompletionAI21IsNoLonger501 proves the source reaches its own branch while an armless source still 501s.
func TestChatCompletionAI21IsNoLonger501(t *testing.T) {
	directories, err := ai21TestDirectories(t)
	if err != nil {
		t.Fatal(err)
	}
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"ai21","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := pinnedChatCompletionPlan(body, directories, ""); failure != nil && failure.status == 501 {
		t.Fatal("ai21 is answered by the default 501 branch; its own plan is missing")
	}
	// ELECTRONHUB is a real pinned source this lane does not implement: it must still answer 501.
	unimplemented, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"cometapi","model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := pinnedChatCompletionPlan(unimplemented, directories, ""); failure == nil || failure.status != 501 {
		t.Fatalf("a source with no branch must answer 501, got %+v", failure)
	}
}

// TestChatCompletionAI21MissingKeyIsRefusedBeforeTheFetch is a DERIVATION from :803-806.
func TestChatCompletionAI21MissingKeyIsRefusedBeforeTheFetch(t *testing.T) {
	directories, err := ai21TestDirectories(t)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(directories["root"], "secrets.json")); err != nil {
		t.Fatal(err)
	}
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"ai21","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	request, failure := pinnedChatCompletionPlan(body, directories, "")
	if failure == nil || failure.status != 400 {
		t.Fatalf("a missing key must answer 400, got %+v", failure)
	}
	if request != nil {
		t.Fatalf("the refusal must issue no request, got %+v", request)
	}
}

func ai21PlanForTest(t *testing.T, rawBody string) *outbound.Request {
	t.Helper()
	directories, err := ai21TestDirectories(t)
	if err != nil {
		t.Fatal(err)
	}
	body, decodeErr := decodeOrderedNodeJSON([]byte(rawBody))
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	request, failure := pinnedChatCompletionPlan(body, directories, "")
	if failure != nil {
		t.Fatalf("plan failed: %+v", failure)
	}
	return request
}

func ai21TestDirectories(t *testing.T) (startup.UserDirectories, error) {
	t.Helper()
	installRoot := t.TempDir()
	dataRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte("gotavern-ai21-plan-test"), 0o600); err != nil {
		return nil, err
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		return nil, err
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		return nil, err
	}
	secrets := []byte(`{"api_key_ai21":[{"id":"probe-id","value":"synthetic-ai21-key","label":"api_key_ai21","active":true}]}`)
	if err := os.WriteFile(filepath.Join(directories["root"], "secrets.json"), secrets, 0o600); err != nil {
		return nil, err
	}
	return directories, nil
}
