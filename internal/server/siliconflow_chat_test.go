package server

// What the SILICONFLOW recording cannot state by itself.
//
//  1. TWO literals, TWO seams. The endpoint is chosen by the request BODY field `siliconflow_endpoint`, so
//     the replay exercises whichever seam the scenario sets and NEVER the default. Each literal is asserted
//     against the literal its own scenario recorded, and the body-driven choice is exercised directly, so an
//     implementation that ignored the field (or folded both regions into one seam) fails here.
//  2. THE STATUS QUERY. The arm appends `?type=text&sub_type=chat`, which is invisible to a seam assertion and
//     easy to drop; the recorded target is the oracle and the query order is part of it.
//  3. THE json_object FOLD. setJsonObjectFormat appends a message rather than shaping response_format alone, so
//     the fold is compared against the message the pinned server actually sent.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"encoding/json"

	"github.com/cocokoishi/gotavern/internal/startup"
)

type siliconFlowWireFixture struct {
	Scenarios map[string]struct {
		TargetPath string `json:"targetPath"`
		GoSeam     struct {
			EnvironmentVariable string `json:"environmentVariable"`
			PinnedLiteral       string `json:"pinnedLiteral"`
		} `json:"goSeam"`
		Provider struct {
			Requests []struct {
				Method    string `json:"method"`
				RawTarget string `json:"rawTarget"`
				RawPath   string `json:"rawPath"`
				RawQuery  string `json:"rawQuery"`
				BodyText  string `json:"bodyText"`
			} `json:"requests"`
		} `json:"provider"`
		HeaderCoverage struct {
			ComparedExactly []string `json:"comparedExactly"`
		} `json:"headerCoverage"`
		AuthorizationKeyVerified bool `json:"authorizationKeyVerified"`
	} `json:"scenarios"`
}

func loadSiliconFlowWireFixture(t *testing.T) siliconFlowWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture siliconFlowWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"siliconflow-nonstream", "siliconflow-cn-endpoint", "siliconflow-json-object",
		"siliconflow-stream", "siliconflow-error-status", "siliconflow-status",
	} {
		if _, exists := fixture.Scenarios[required]; !exists {
			t.Fatalf("the provider-wire fixture records no %q scenario", required)
		}
	}
	return fixture
}

// TestChatCompletionSiliconFlowSeamDefaults asserts each literal against the scenario that recorded it.
func TestChatCompletionSiliconFlowSeamDefaults(t *testing.T) {
	fixture := loadSiliconFlowWireFixture(t)
	seen := map[string]string{}
	for name, scenario := range fixture.Scenarios {
		if !strings.HasPrefix(name, "siliconflow-") {
			continue
		}
		if scenario.TargetPath != chatCompletionSourceSiliconF {
			t.Fatalf("%s targetPath = %q", name, scenario.TargetPath)
		}
		recorded := scenario.GoSeam.PinnedLiteral
		switch scenario.GoSeam.EnvironmentVariable {
		case pinnedSiliconFlowSeamEnv:
			if recorded != pinnedSiliconFlowAPIURL {
				t.Fatalf("%s: fixture literal %q vs Go literal %q", name, recorded, pinnedSiliconFlowAPIURL)
			}
		case pinnedSiliconFlowCNSeamEnv:
			if recorded != pinnedSiliconFlowCNAPIURL {
				t.Fatalf("%s: fixture literal %q vs Go CN literal %q", name, recorded, pinnedSiliconFlowCNAPIURL)
			}
		default:
			t.Fatalf("%s: unexpected seam %q", name, scenario.GoSeam.EnvironmentVariable)
		}
		seen[scenario.GoSeam.EnvironmentVariable] = recorded
	}
	if len(seen) != 2 {
		t.Fatalf("the fixture must exercise BOTH literals, saw %v", seen)
	}

	// The choice comes from the BODY, not from the environment: with neither seam set, the body decides.
	t.Setenv(pinnedSiliconFlowSeamEnv, "")
	t.Setenv(pinnedSiliconFlowCNSeamEnv, "")
	global, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"siliconflow"}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := pinnedSiliconFlowBaseURL(global); got != pinnedSiliconFlowAPIURL {
		t.Fatalf("no endpoint field must reach the global literal, got %q", got)
	}
	cn, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"siliconflow","siliconflow_endpoint":"cn"}`))
	if err != nil {
		t.Fatal(err)
	}
	if got := pinnedSiliconFlowBaseURL(cn); got != pinnedSiliconFlowCNAPIURL {
		t.Fatalf("siliconflow_endpoint=cn must reach the CN literal, got %q", got)
	}
	t.Setenv(pinnedSiliconFlowCNSeamEnv, "http://127.0.0.1:1")
	if got := pinnedSiliconFlowBaseURL(cn); got != "http://127.0.0.1:1" {
		t.Fatalf("the CN seam is not honoured: %q", got)
	}
}

// TestChatCompletionSiliconFlowStatusCarriesTheQuery pins the query the arm appends, in order.
func TestChatCompletionSiliconFlowStatusCarriesTheQuery(t *testing.T) {
	fixture := loadSiliconFlowWireFixture(t)
	scenario := fixture.Scenarios["siliconflow-status"]
	if len(scenario.Provider.Requests) != 1 {
		t.Fatalf("siliconflow-status records %d provider requests, want 1", len(scenario.Provider.Requests))
	}
	request := scenario.Provider.Requests[0]
	if request.Method != "GET" {
		t.Fatalf("status method = %q, want GET", request.Method)
	}
	if request.RawQuery != "type=text&sub_type=chat" {
		t.Fatalf("status query = %q, want the pinned type=text&sub_type=chat in that order", request.RawQuery)
	}
	if !strings.HasSuffix(request.RawPath, "/models") {
		t.Fatalf("status path = %q, want a /models suffix", request.RawPath)
	}
	compared := make(map[string]bool, len(scenario.HeaderCoverage.ComparedExactly))
	for _, header := range scenario.HeaderCoverage.ComparedExactly {
		compared[strings.ToLower(header)] = true
	}
	if !compared["authorization"] {
		t.Fatal("the status scenario does not compare authorization")
	}
	if !scenario.AuthorizationKeyVerified {
		t.Fatal("the status scenario does not record that the planted key arrived")
	}
}

// TestChatCompletionSiliconFlowStatusURLCarriesTheQuery tests the URL the arm BUILDS, not only the one the
// fixture recorded. This test exists because the recorded-side assertion alone let a mutation that dropped
// the query survive: the fixture still carried it while the implementation had stopped appending it.
func TestChatCompletionSiliconFlowStatusURLCarriesTheQuery(t *testing.T) {
	t.Setenv(pinnedSiliconFlowSeamEnv, "")
	t.Setenv(pinnedSiliconFlowCNSeamEnv, "")
	global, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"siliconflow"}`))
	if err != nil {
		t.Fatal(err)
	}
	wantGlobal := pinnedSiliconFlowAPIURL + "/models?type=text&sub_type=chat"
	if got := pinnedSiliconFlowStatusURL(global); got != wantGlobal {
		t.Fatalf("global status URL = %q, want %q", got, wantGlobal)
	}
	cn, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"siliconflow","siliconflow_endpoint":"cn"}`))
	if err != nil {
		t.Fatal(err)
	}
	wantCN := pinnedSiliconFlowCNAPIURL + "/models?type=text&sub_type=chat"
	if got := pinnedSiliconFlowStatusURL(cn); got != wantCN {
		t.Fatalf("CN status URL = %q, want %q", got, wantCN)
	}
}

// TestChatCompletionSiliconFlowJsonObjectFoldMatchesTheRecordedBody compares the fold, message included, to
// the bytes pinned sent.
func TestChatCompletionSiliconFlowJsonObjectFoldMatchesTheRecordedBody(t *testing.T) {
	fixture := loadSiliconFlowWireFixture(t)
	scenario := fixture.Scenarios["siliconflow-json-object"]
	if len(scenario.Provider.Requests) != 1 {
		t.Fatalf("siliconflow-json-object records %d provider requests", len(scenario.Provider.Requests))
	}
	body := scenario.Provider.Requests[0].BodyText
	if !strings.Contains(body, `"response_format":{"type":"json_object"}`) {
		t.Fatalf("the recorded body does not carry the json_object response_format: %s", body)
	}
	if !strings.Contains(body, `JSON schema for the response:\n`) {
		t.Fatalf("the recorded body does not carry the synthesized schema message: %s", body)
	}

	decoded, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"siliconflow","model":"probe-model","messages":[{"role":"system","content":"probe system marker"},{"role":"user","content":"probe user marker"}],"max_tokens":64,"temperature":0.5,"stream":false,"json_schema":{"name":"probe_schema","value":{"type":"object","properties":{"answer":{"type":"string"}}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	schema, _ := decoded.member("json_schema")
	bodyParams := nodeObject()
	if foldErr := pinnedSetJsonObjectFormat(&bodyParams, &decoded, schema); foldErr != nil {
		t.Fatal(foldErr)
	}
	messages, _ := decoded.member("messages")
	if len(messages.array) != 3 {
		t.Fatalf("the fold appended %d messages, want exactly one (3 total)", len(messages.array)-2)
	}
	appended := messages.array[2]
	role, _ := appended.member("role")
	content, _ := appended.member("content")
	if got, _ := role.scalar.(string); got != "user" {
		t.Fatalf("appended message role = %q, want user", got)
	}
	text, _ := content.scalar.(string)
	if !strings.HasPrefix(text, "JSON schema for the response:\n{\n    \"type\": \"object\"") {
		t.Fatalf("appended message content does not start with the pinned prefix and 4-space JSON: %q", text)
	}
	format, _ := bodyParams.member("response_format")
	encodedFormat, marshalErr := marshalOrderedNodeJSON(format)
	if marshalErr != nil {
		t.Fatal(marshalErr)
	}
	if string(encodedFormat) != `{"type":"json_object"}` {
		t.Fatalf("response_format = %s, want {\"type\":\"json_object\"}", encodedFormat)
	}
}

// TestChatCompletionSiliconFlowIsNotTheDefaultRefusal proves the source reaches a served branch.
func TestChatCompletionSiliconFlowIsNotTheDefaultRefusal(t *testing.T) {
	directories := startup.UserDirectories{}
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"siliconflow","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := pinnedChatCompletionPlan(body, directories, ""); failure != nil && failure.status == 501 {
		t.Fatal("siliconflow is answered by the default 501 branch; its plan case is missing")
	}
	unimplemented, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"ai21","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := pinnedChatCompletionPlan(unimplemented, directories, ""); failure == nil || failure.status != 501 {
		t.Fatalf("a source this lane does not implement must answer 501, got %+v", failure)
	}
}
