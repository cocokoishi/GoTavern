package server

// What the POLLINATIONS recording cannot state by itself.
//
//  1. THREE literals, THREE seams. The generate base is chosen by the request body (gen vs text) and the status
//     arm uses a THIRD literal; each is asserted against the scenario that recorded it, and the mode -- not the
//     seam -- is what decides the host.
//  2. THE CREDENTIAL IS PER MODE. Authenticated reads api_key_pollinations; anonymous sends the LITERAL string
//     `anonymous` and never reads the secret. The fixture proves which one arrived through
//     expectedAuthorizationKey + authorizationKeyVerified (the branch's credential is redacted in the header,
//     so the header alone cannot distinguish them), and the plan is asserted to send the same thing.
//  3. THE SEED IS ALWAYS IN THE BODY. The harness normalises headers only, so a random seed cannot be marked
//     without a tooling change: every recorded scenario SUPPLIES a seed and the fixture is asserted to carry
//     exactly the supplied values. The random fallback is a LABELLED DERIVATION (range + supplied passthrough).
//  4. THE FOLD IS ASYMMETRIC -- reasoning_effort and json_schema are folded for authenticated and DROPPED for
//     anonymous, which the anonymous scenario shows by carrying those members in the request.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

type pollinationsWireFixture struct {
	Scenarios map[string]struct {
		TargetPath               string `json:"targetPath"`
		ExpectedAuthorizationKey string `json:"expectedAuthorizationKey"`
		AuthorizationKeyVerified bool   `json:"authorizationKeyVerified"`
		GoSeam                   struct {
			EnvironmentVariable string `json:"environmentVariable"`
			PinnedLiteral       string `json:"pinnedLiteral"`
		} `json:"goSeam"`
		Request struct {
			Body map[string]json.RawMessage `json:"body"`
		} `json:"request"`
		Provider struct {
			Requests []struct {
				Method   string `json:"method"`
				RawPath  string `json:"rawPath"`
				BodyText string `json:"bodyText"`
			} `json:"requests"`
		} `json:"provider"`
	} `json:"scenarios"`
}

func loadPollinationsWireFixture(t *testing.T) pollinationsWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture pollinationsWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"pollinations-nonstream", "pollinations-anonymous", "pollinations-reasoning-schema",
		"pollinations-stream", "pollinations-error-status", "pollinations-status",
	} {
		if _, exists := fixture.Scenarios[required]; !exists {
			t.Fatalf("the provider-wire fixture records no %q scenario", required)
		}
	}
	return fixture
}

// TestChatCompletionPollinationsSeamsAndModes asserts each of the three literals separately.
func TestChatCompletionPollinationsSeamsAndModes(t *testing.T) {
	fixture := loadPollinationsWireFixture(t)
	seen := map[string]string{}
	for name, scenario := range fixture.Scenarios {
		if !strings.HasPrefix(name, "pollinations-") {
			continue
		}
		if scenario.TargetPath != chatCompletionSourcePollinations {
			t.Fatalf("%s targetPath = %q", name, scenario.TargetPath)
		}
		seen[scenario.GoSeam.EnvironmentVariable] = scenario.GoSeam.PinnedLiteral
	}
	want := map[string]string{
		pinnedPollinationsSeamEnv:     pinnedPollinationsAPIURL,
		pinnedPollinationsAnonSeamEnv: pinnedPollinationsAnonAPIURL,
		pinnedPollinationsStatusEnv:   pinnedPollinationsStatusBase,
	}
	if len(seen) != len(want) {
		t.Fatalf("the fixture must exercise all three seams, saw %v", seen)
	}
	for seam, literal := range want {
		if seen[seam] != literal {
			t.Fatalf("%s: fixture literal %q vs Go literal %q", seam, seen[seam], literal)
		}
	}
	t.Setenv(pinnedPollinationsSeamEnv, "")
	t.Setenv(pinnedPollinationsAnonSeamEnv, "")
	t.Setenv(pinnedPollinationsStatusEnv, "")
	if got := pinnedPollinationsBaseURL(false); got != pinnedPollinationsAPIURL {
		t.Fatalf("authenticated base = %q", got)
	}
	if got := pinnedPollinationsBaseURL(true); got != pinnedPollinationsAnonAPIURL {
		t.Fatalf("anonymous base = %q", got)
	}
	if got := pinnedPollinationsStatusURL(); got != pinnedPollinationsStatusBase+"/models" {
		t.Fatalf("status URL = %q", got)
	}
}

// TestChatCompletionPollinationsCredentialPerMode is the assertion the redacted header cannot make.
func TestChatCompletionPollinationsCredentialPerMode(t *testing.T) {
	fixture := loadPollinationsWireFixture(t)
	// expectedAuthorizationKey is an INPUT (it lives in the scenario file); authorizationKeyVerified is the
	// OBSERVATION the probe records. Read each from where it lives rather than from the other.
	if got := scenarioExpectedKey(t, "pollinations-anonymous"); got != pinnedPollinationsAnonymousKey {
		t.Fatalf("the anonymous scenario declares %q, want the literal %q", got, pinnedPollinationsAnonymousKey)
	}
	if !fixture.Scenarios["pollinations-anonymous"].AuthorizationKeyVerified {
		t.Fatal("the anonymous scenario does not record that the literal key arrived at the provider")
	}
	for _, name := range []string{"pollinations-nonstream", "pollinations-reasoning-schema", "pollinations-status"} {
		if got := scenarioExpectedKey(t, name); got == pinnedPollinationsAnonymousKey {
			t.Fatalf("%s declares the anonymous literal; the authenticated mode must send the secret", name)
		}
		if !fixture.Scenarios[name].AuthorizationKeyVerified {
			t.Fatalf("%s does not record that the planted secret arrived", name)
		}
	}

	// The same distinction on the PLAN, which is what the route actually builds.
	anonymousRequest := pollinationsPlanForTest(t, `{"chat_completion_source":"pollinations","pollinations_endpoint":"anonymous","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false,"seed":12345}`)
	if got := pollinationsHeaderValue(anonymousRequest.Headers, "authorization"); got != "Bearer anonymous" {
		t.Fatalf("anonymous plan authorization = %q, want Bearer anonymous", got)
	}
	authRequest := pollinationsPlanForTest(t, `{"chat_completion_source":"pollinations","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false,"seed":12345}`)
	if got := pollinationsHeaderValue(authRequest.Headers, "authorization"); got != "Bearer synthetic-pollinations-key" {
		t.Fatalf("authenticated plan authorization = %q, want the planted secret", got)
	}
}

// TestChatCompletionPollinationsSeedIsAlwaysPresent pins the recorded seeds and the derivation for the rest.
func TestChatCompletionPollinationsSeedIsAlwaysPresent(t *testing.T) {
	fixture := loadPollinationsWireFixture(t)
	supplied := map[string]string{
		"pollinations-nonstream":        "12345",
		"pollinations-anonymous":        "12345",
		"pollinations-reasoning-schema": "777",
		"pollinations-stream":           "12345",
		"pollinations-error-status":     "12345",
	}
	for name, want := range supplied {
		body := fixture.Scenarios[name].Provider.Requests[0].BodyText
		if !strings.Contains(body, `"seed":`+want) {
			t.Fatalf("%s: the recorded body does not carry the supplied seed %s: %s", name, want, body)
		}
	}
	// No scenario may have been recorded with a generated seed: every recorded seed must be one of the values
	// this test knows about, which is what keeps a random number out of the fixture.
	for name, scenario := range fixture.Scenarios {
		if !strings.HasPrefix(name, "pollinations-") || name == "pollinations-status" {
			continue
		}
		body := scenario.Provider.Requests[0].BodyText
		index := strings.Index(body, `"seed":`)
		if index < 0 {
			t.Fatalf("%s: the body carries no seed member", name)
		}
		rest := body[index+len(`"seed":`):]
		end := strings.IndexAny(rest, ",}")
		if end < 0 {
			end = len(rest)
		}
		value := rest[:end]
		if value != "12345" && value != "777" {
			t.Fatalf("%s: the fixture carries a seed (%s) that no scenario supplied, so a random number was recorded", name, value)
		}
	}

	// LABELLED DERIVATION: the fallback is generated, in range, and a supplied seed passes through unchanged.
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"pollinations","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	generated, suppliedFlag := pinnedPollinationsSeed(body)
	if suppliedFlag {
		t.Fatal("a body with no seed must not report a supplied seed")
	}
	number, isNumber := generated.scalar.(float64)
	if !isNumber || number < 0 || number > 99999998 || number != float64(int(number)) {
		t.Fatalf("generated seed = %v, want an integer in [0, 99999998]", generated.scalar)
	}
	withSeed, err := decodeOrderedNodeJSON([]byte(`{"seed":42}`))
	if err != nil {
		t.Fatal(err)
	}
	kept, suppliedFlag := pinnedPollinationsSeed(withSeed)
	if !suppliedFlag {
		t.Fatal("a supplied seed must report as supplied")
	}
	if got, _ := kept.scalar.(float64); got != 42 {
		t.Fatalf("supplied seed became %v, want 42", kept.scalar)
	}
	if _, parseErr := strconv.Atoi("42"); parseErr != nil {
		t.Fatal(parseErr)
	}

	// PLAN-LEVEL, and the reason this test now exists: a mutation that stopped putting the seed in the body
	// when the request omits it survived every assertion above, because those read the predicate and the
	// recording. The route's own body is what the provider sees, so it is asserted directly.
	noSeed := pollinationsPlanForTest(t, `{"chat_completion_source":"pollinations","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`)
	if !strings.Contains(string(noSeed.Body), `"seed":`) {
		t.Fatalf("the plan body carries no seed for a request that omits one: %s", noSeed.Body)
	}
	withSeedPlan := pollinationsPlanForTest(t, `{"chat_completion_source":"pollinations","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false,"seed":42}`)
	if !strings.Contains(string(withSeedPlan.Body), `"seed":42`) {
		t.Fatalf("the plan body does not carry the supplied seed: %s", withSeedPlan.Body)
	}
}

// TestChatCompletionPollinationsFoldsAreAsymmetric checks the fold and its absence in the anonymous mode.
func TestChatCompletionPollinationsFoldsAreAsymmetric(t *testing.T) {
	fixture := loadPollinationsWireFixture(t)
	recorded := fixture.Scenarios["pollinations-reasoning-schema"].Provider.Requests[0].BodyText
	if !strings.Contains(recorded, `"reasoning_effort":"high"`) {
		t.Fatalf("the authenticated capture does not carry reasoning_effort: %s", recorded)
	}
	if !strings.Contains(recorded, `"response_format":{"type":"json_schema","json_schema":{"schema":`) {
		t.Fatalf("the authenticated capture does not carry the nested schema fold: %s", recorded)
	}
	anonymous := fixture.Scenarios["pollinations-anonymous"].Provider.Requests[0].BodyText
	if strings.Contains(anonymous, "reasoning_effort") || strings.Contains(anonymous, "response_format") {
		t.Fatalf("the anonymous capture folded members the pinned branch drops: %s", anonymous)
	}

	plan := pollinationsPlanForTest(t, `{"chat_completion_source":"pollinations","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false,"seed":777,"reasoning_effort":"high","json_schema":{"name":"probe_schema","value":{"type":"object","properties":{"answer":{"type":"string"}}}}}`)
	planBody := string(plan.Body)
	if !strings.Contains(planBody, `"reasoning_effort":"high"`) || !strings.Contains(planBody, `"response_format":{"type":"json_schema","json_schema":{"schema":`) {
		t.Fatalf("the plan body does not carry the authenticated folds: %s", planBody)
	}
	anonymousPlan := pollinationsPlanForTest(t, `{"chat_completion_source":"pollinations","pollinations_endpoint":"anonymous","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false,"seed":777,"reasoning_effort":"high","json_schema":{"name":"probe_schema","value":{"type":"object"}}}`)
	anonymousBody := string(anonymousPlan.Body)
	if strings.Contains(anonymousBody, "reasoning_effort") {
		t.Fatalf("the anonymous plan folded reasoning_effort, which the pinned branch drops: %s", anonymousBody)
	}
	// The anonymous mode skips its OWN fold, and then the SHARED tail folds json_schema into the standard
	// {name, strict, schema} envelope -- so the two modes produce DIFFERENT response_format shapes from the
	// same request member. That asymmetry is the pinned behaviour, not a defect.
	if !strings.Contains(anonymousBody, `"response_format":{"type":"json_schema","json_schema":{"name":"probe_schema","strict":true,"schema":`) {
		t.Fatalf("the anonymous plan does not carry the SHARED envelope: %s", anonymousBody)
	}
}

// TestChatCompletionPollinationsStatusUsesTheThirdLiteral pins the status path.
func TestChatCompletionPollinationsStatusUsesTheThirdLiteral(t *testing.T) {
	fixture := loadPollinationsWireFixture(t)
	request := fixture.Scenarios["pollinations-status"].Provider.Requests[0]
	if request.Method != "GET" {
		t.Fatalf("status method = %q", request.Method)
	}
	// The transport redirect replaces the WHOLE status literal, so the compared path is /models; what proves the
	// third literal is used is the seam literal below, not the path.
	if !strings.HasSuffix(request.RawPath, "/models") {
		t.Fatalf("status path = %q, want a /models suffix", request.RawPath)
	}
	if fixture.Scenarios["pollinations-status"].GoSeam.PinnedLiteral == pinnedPollinationsAPIURL {
		t.Fatal("the status scenario reuses the generate base; the pinned status arm uses a third literal")
	}
}

// TestChatCompletionPollinationsIsNotTheDefaultRefusal proves the source reaches a served branch.
func TestChatCompletionPollinationsIsNotTheDefaultRefusal(t *testing.T) {
	directories, err := pollinationsTestDirectories(t)
	if err != nil {
		t.Fatal(err)
	}
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"pollinations","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false,"seed":1}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := pinnedChatCompletionPlan(body, directories, ""); failure != nil && failure.status == 501 {
		t.Fatal("pollinations is answered by the default 501 branch; its plan case is missing")
	}
	unimplemented, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"ai21","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := pinnedChatCompletionPlan(unimplemented, directories, ""); failure == nil || failure.status != 501 {
		t.Fatalf("a source this lane does not implement must answer 501, got %+v", failure)
	}
}

// scenarioExpectedKey reads an INPUT field from the scenario file, which the fixture does not record.
func scenarioExpectedKey(t *testing.T, scenarioName string) string {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "provider-wire", "scenarios", scenarioName+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var scenario struct {
		ExpectedAuthorizationKey string `json:"expectedAuthorizationKey"`
	}
	if err := json.Unmarshal(raw, &scenario); err != nil {
		t.Fatal(err)
	}
	return scenario.ExpectedAuthorizationKey
}

func pollinationsPlanForTest(t *testing.T, rawBody string) *outbound.Request {
	t.Helper()
	directories, err := pollinationsTestDirectories(t)
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

func pollinationsTestDirectories(t *testing.T) (startup.UserDirectories, error) {
	t.Helper()
	installRoot := t.TempDir()
	dataRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte("gotavern-pollinations-plan-test"), 0o600); err != nil {
		return nil, err
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		return nil, err
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		return nil, err
	}
	secrets := []byte(`{"api_key_pollinations":[{"id":"probe-id","value":"synthetic-pollinations-key","label":"api_key_pollinations","active":true}]}`)
	if err := os.WriteFile(filepath.Join(directories["root"], "secrets.json"), secrets, 0o600); err != nil {
		return nil, err
	}
	return directories, nil
}

func pollinationsHeaderValue(headers []outbound.Header, name string) string {
	for _, header := range headers {
		if strings.EqualFold(header.Name, name) {
			return header.Value
		}
	}
	return ""
}
