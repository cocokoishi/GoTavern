package server

// What the WORKERS_AI recording cannot state by itself, plus the one behaviour that CANNOT be recorded.
//
//  1. THE SEAM IS THE PREFIX. The base is `${prefix}/${encodeURIComponent(accountId)}/ai/v1`, so the account id
//     is caller data inside the URL. The prefix is asserted against the fixture's recorded literal and the id
//     as a path SEGMENT; a combined literal would pin caller data as if it were a constant.
//  2. THE ENCODING. `encodeURIComponent`'s unescaped set differs from Go's url.PathEscape, so an account id
//     with reserved characters is the input that makes the assertion able to fail. Both the recorded path and
//     the Go encoder are checked.
//  3. THE json_schema FOLD is `{type:'json_schema', json_schema:<value>}` -- no name/strict envelope -- and is
//     asserted on the PLAN as well as on the recorded bytes.
//  4. THE PRE-FETCH REFUSAL is a LABELLED DERIVATION (AGENTS.md rule 4): a missing account id answers 400
//     before any request, so there is no provider traffic to record. The plan is asserted to return 400 and to
//     build NO request, which is the zero-outbound half of the claim.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

type workersAIWireFixture struct {
	Scenarios map[string]struct {
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
		HTTP struct {
			Response struct {
				Body string `json:"body"` // JSON-encoded provider reply is compared under providerResponse
			} `json:"response"`
			Body json.RawMessage `json:"body"`
		} `json:"http"`
		ProviderResponse struct {
			Status int `json:"status"`
			Raw    json.RawMessage
		} `json:"-"`
	} `json:"scenarios"`
}

func loadWorkersAIWireFixture(t *testing.T) workersAIWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture workersAIWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"workers-ai-nonstream", "workers-ai-account-escaping", "workers-ai-json-schema",
		"workers-ai-stream", "workers-ai-error-status", "workers-ai-status",
	} {
		if _, exists := fixture.Scenarios[required]; !exists {
			t.Fatalf("the provider-wire fixture records no %q scenario", required)
		}
	}
	return fixture
}

// TestChatCompletionWorkersAISeamIsTheAccountsPrefix asserts the prefix and the segment separately.
func TestChatCompletionWorkersAISeamIsTheAccountsPrefix(t *testing.T) {
	fixture := loadWorkersAIWireFixture(t)
	for name, scenario := range fixture.Scenarios {
		if !strings.HasPrefix(name, "workers-ai-") {
			continue
		}
		if scenario.TargetPath != chatCompletionSourceWAI {
			t.Fatalf("%s targetPath = %q", name, scenario.TargetPath)
		}
		if scenario.GoSeam.PinnedLiteral != pinnedWorkersAIPrefix {
			t.Fatalf("%s: fixture prefix %q vs Go prefix %q", name, scenario.GoSeam.PinnedLiteral, pinnedWorkersAIPrefix)
		}
		if scenario.GoSeam.EnvironmentVariable != pinnedWorkersAISeamEnv {
			t.Fatalf("%s: seam %q", name, scenario.GoSeam.EnvironmentVariable)
		}
		if len(scenario.Provider.Requests) != 1 {
			t.Fatalf("%s records %d provider requests", name, len(scenario.Provider.Requests))
		}
		request := scenario.Provider.Requests[0]
		wantSegment := "/probe-account/ai/"
		if name == "workers-ai-account-escaping" {
			// The escaping scenario deliberately sends a different id; its segment is asserted by
			// TestChatCompletionWorkersAIAccountIDEscaping.
			wantSegment = "/acc%2Fone%3Fx%3D1/ai/"
		}
		if !strings.Contains(request.RawPath, wantSegment) {
			t.Fatalf("%s: the account id is not a path segment of %q (want %q)", name, request.RawPath, wantSegment)
		}
		if !strings.HasSuffix(request.RawPath, "/ai/v1/chat/completions") && !strings.Contains(request.RawPath, "/ai/") {
			t.Fatalf("%s: path %q does not carry the pinned /ai/ tail", name, request.RawPath)
		}
	}
	t.Setenv(pinnedWorkersAISeamEnv, "")
	want := pinnedWorkersAIPrefix + "/probe-account/ai/v1"
	if got := pinnedWorkersAIBaseURL("probe-account"); got != want {
		t.Fatalf("base URL = %q, want %q", got, want)
	}
}

// TestChatCompletionWorkersAIAccountIDEscaping pins encodeURIComponent against a value that needs it.
func TestChatCompletionWorkersAIAccountIDEscaping(t *testing.T) {
	fixture := loadWorkersAIWireFixture(t)
	path := fixture.Scenarios["workers-ai-account-escaping"].Provider.Requests[0].RawPath
	if !strings.Contains(path, "acc%2Fone%3Fx%3D1") {
		t.Fatalf("the recorded path does not carry the encoded account id: %q", path)
	}
	if got := encodeURIComponentJS("acc/one?x=1"); got != "acc%2Fone%3Fx%3D1" {
		t.Fatalf("encodeURIComponentJS = %q, want acc%%2Fone%%3Fx%%3D1", got)
	}
	t.Setenv(pinnedWorkersAISeamEnv, "")
	base := pinnedWorkersAIBaseURL("acc/one?x=1")
	if !strings.Contains(base, "/acc%2Fone%3Fx%3D1/ai/v1") {
		t.Fatalf("the plan base does not encode the segment: %q", base)
	}
}

// TestChatCompletionWorkersAIJsonSchemaFoldIsNotTheEnvelope checks the recorded bytes AND the plan.
func TestChatCompletionWorkersAIJsonSchemaFoldIsNotTheEnvelope(t *testing.T) {
	fixture := loadWorkersAIWireFixture(t)
	recorded := fixture.Scenarios["workers-ai-json-schema"].Provider.Requests[0].BodyText
	if !strings.Contains(recorded, `"response_format":{"type":"json_schema","json_schema":{"type":"object"`) {
		t.Fatalf("the recorded body does not carry the bare json_schema fold: %s", recorded)
	}
	if strings.Contains(recorded, `"strict"`) || strings.Contains(recorded, `"name":"probe_schema"`) {
		t.Fatalf("the recorded body carries the name/strict envelope this branch does not use: %s", recorded)
	}
	if !strings.Contains(recorded, `"repetition_penalty":1.1`) {
		t.Fatalf("the recorded body does not carry repetition_penalty: %s", recorded)
	}

	request, failure := workersAIPlanForTest(t, `{"chat_completion_source":"workers_ai","workers_ai_account_id":"probe-account","model":"@cf/probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false,"repetition_penalty":1.1,"json_schema":{"name":"probe_schema","value":{"type":"object","properties":{"answer":{"type":"string"}}}}}`)
	if failure != nil {
		t.Fatalf("plan failed: %+v", failure)
	}
	planBody := string(request.Body)
	if !strings.Contains(planBody, `"response_format":{"type":"json_schema","json_schema":{"type":"object"`) {
		t.Fatalf("the plan body does not carry the bare json_schema fold: %s", planBody)
	}
	if !strings.Contains(planBody, `"repetition_penalty":1.1`) {
		t.Fatalf("the plan body does not carry repetition_penalty: %s", planBody)
	}
}

// TestChatCompletionWorkersAIStatusProjection pins the query and the id-from-name projection.
func TestChatCompletionWorkersAIStatusProjection(t *testing.T) {
	fixture := loadWorkersAIWireFixture(t)
	scenario := fixture.Scenarios["workers-ai-status"]
	request := scenario.Provider.Requests[0]
	if request.Method != "GET" {
		t.Fatalf("status method = %q", request.Method)
	}
	if !strings.Contains(request.RawPath, "/ai/models/search") {
		t.Fatalf("status path = %q, want a models/search lookup", request.RawPath)
	}
	t.Setenv(pinnedWorkersAISeamEnv, "")
	if got := pinnedWorkersAIStatusURL("probe-account"); !strings.HasSuffix(got, "/ai/models/search?task=Text+Generation&per_page=1000") {
		t.Fatalf("status URL = %q", got)
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var generic struct {
		Scenarios map[string]struct {
			ProviderResponse struct {
				Body json.RawMessage `json:"body"`
			} `json:"providerResponse"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &generic); err != nil {
		t.Fatal(err)
	}
	var reply struct {
		Data []struct {
			ID   string `json:"id"`
			Name string `json:"name"`
		} `json:"data"`
	}
	if err := json.Unmarshal(generic.Scenarios["workers-ai-status"].ProviderResponse.Body, &reply); err != nil {
		t.Fatalf("the recorded status reply is not the projected object: %v", err)
	}
	if len(reply.Data) != 2 {
		t.Fatalf("the recorded status reply carries %d models, want 2", len(reply.Data))
	}
	for _, model := range reply.Data {
		if model.ID != model.Name || model.ID == "" {
			t.Fatalf("the projection did not copy name into id: %+v", model)
		}
	}
}

// TestChatCompletionWorkersAIMissingAccountIDIsRefusedBeforeTheFetch is a LABELLED DERIVATION: the pinned
// branch answers 400 {error:true} before it issues any request, so no provider traffic exists to record.
// The plan is asserted to return that refusal and to build NO request, which is the zero-outbound half.
func TestChatCompletionWorkersAIMissingAccountIDIsRefusedBeforeTheFetch(t *testing.T) {
	request, failure := workersAIPlanForTest(t, `{"chat_completion_source":"workers_ai","model":"@cf/probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`)
	if failure == nil || failure.status != 400 {
		t.Fatalf("a missing account id must answer 400, got %+v", failure)
	}
	if request != nil {
		t.Fatalf("a refused request must build no outbound request, got %+v", request)
	}
	blank, failure := workersAIPlanForTest(t, `{"chat_completion_source":"workers_ai","workers_ai_account_id":"   ","model":"@cf/probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`)
	if failure == nil || failure.status != 400 || blank != nil {
		t.Fatalf("a whitespace account id must answer 400 with no request, got %+v / %+v", failure, blank)
	}
}

// TestChatCompletionWorkersAIIsNotTheDefaultRefusal proves the source reaches a served branch.
func TestChatCompletionWorkersAIIsNotTheDefaultRefusal(t *testing.T) {
	directories, dataRootErr := workersAITestDirectories(t)
	if dataRootErr != nil {
		t.Fatal(dataRootErr)
	}
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"workers_ai","workers_ai_account_id":"probe-account","model":"@cf/probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := pinnedChatCompletionPlan(body, directories); failure != nil && failure.status == 501 {
		t.Fatal("workers_ai is answered by the default 501 branch; its plan case is missing")
	}
	unimplemented, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"ai21","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := pinnedChatCompletionPlan(unimplemented, directories); failure == nil || failure.status != 501 {
		t.Fatalf("a source this lane does not implement must answer 501, got %+v", failure)
	}
}

func workersAIPlanForTest(t *testing.T, rawBody string) (*outbound.Request, *pinnedChatCompletionFailure) {
	t.Helper()
	directories, err := workersAITestDirectories(t)
	if err != nil {
		t.Fatal(err)
	}
	body, decodeErr := decodeOrderedNodeJSON([]byte(rawBody))
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	return pinnedChatCompletionPlan(body, directories)
}

func workersAITestDirectories(t *testing.T) (startup.UserDirectories, error) {
	t.Helper()
	installRoot := t.TempDir()
	dataRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte("gotavern-workers-ai-plan-test"), 0o600); err != nil {
		return nil, err
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		return nil, err
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		return nil, err
	}
	secrets := []byte(`{"api_key_workers_ai":[{"id":"probe-id","value":"synthetic-workers-ai-key","label":"api_key_workers_ai","active":true}]}`)
	if err := os.WriteFile(filepath.Join(directories["root"], "secrets.json"), secrets, 0o600); err != nil {
		return nil, err
	}
	return directories, nil
}
