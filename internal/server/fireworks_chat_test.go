package server

// What the FIREWORKS recording can and cannot state.
//
//  1. THE AFFINITY HEADER IS ABSENT WHEN ASKED FOR NOTHING. The capture with no chat_id is the control: an
//     implementation that always computes the HMAC header fails it.
//  2. THE AFFINITY HEADER'S PRESENCE AND SHAPE ARE ASSERTED ON THE PLAN, never its value in the fixture. Its key
//     is `getAffinityKey()` (chat-completions.js:119), the install's COOKIE SECRET, so recording the digest would
//     commit a derived secret into a compared header -- the rule-18 class. The plan test computes the expected
//     digest from the harness's own fixed cookie secret, checks 16 lowercase hex, and checks that two chat ids
//     produce two different values. A sweep proves no `x-session-affinity` value reached the fixture.
//  3. THE FOLD IS THE FULL ENVELOPE: {name, description, schema, strict ?? true}, not the bare or nested shapes
//     other sources use -- asserted on the recorded bytes AND on the plan.
//  4. THE STATUS LITERAL IS OUTSIDE THE API BASE and has its own seam; the projection filters and duplicates.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

// pinnedWireCookieSecret is the cookie secret the provider-wire harness writes into BOTH legs' data roots
// (tools/probe-provider-wire.mjs:213 prepareRuntime), which is what makes the affinity digest computable here.
const pinnedWireCookieSecret = "gotavern-pinned-provider-wire-cookie-secret"

type fireworksScenario struct {
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

type fireworksWireFixture struct {
	Scenarios map[string]json.RawMessage `json:"scenarios"`
}

func loadFireworksWireFixture(t *testing.T) fireworksWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture fireworksWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{
		"fireworks-nonstream", "fireworks-reasoning-schema", "fireworks-stream",
		"fireworks-error-status", "fireworks-status",
	} {
		if _, exists := fixture.Scenarios[required]; !exists {
			t.Fatalf("the provider-wire fixture records no %q scenario", required)
		}
	}
	return fixture
}

// scenario decodes one recorded scenario. The map is typed as RawMessage because a nested struct tag is easy to
// get wrong and the wrong tag silently yields empty arrays -- which is how a "the provider saw nothing"
// assertion can pass for a reason that has nothing to do with the product.
func (fixture fireworksWireFixture) scenario(t *testing.T, name string) fireworksScenario {
	t.Helper()
	raw, exists := fixture.Scenarios[name]
	if !exists {
		t.Fatalf("no %q scenario", name)
	}
	var scenario fireworksScenario
	if err := json.Unmarshal(raw, &scenario); err != nil {
		t.Fatal(err)
	}
	if len(scenario.Provider.Requests) == 0 {
		t.Fatalf("%s records no provider request", name)
	}
	return scenario
}

// TestChatCompletionFireworksAffinityIsAbsentWithoutChatID is the control for the header.
func TestChatCompletionFireworksAffinityIsAbsentWithoutChatID(t *testing.T) {
	fixture := loadFireworksWireFixture(t)
	for name := range fixture.Scenarios {
		if !strings.HasPrefix(name, "fireworks-") || name == "fireworks-status" {
			continue
		}
		scenario := fixture.scenario(t, name)
		for _, request := range scenario.Provider.Requests {
			for _, header := range request.Headers {
				if strings.EqualFold(header.Name, "x-session-affinity") {
					t.Fatalf("%s: a request with no chat_id sent x-session-affinity", name)
				}
			}
		}
	}
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	// The sweep is for a header ENTRY, not for the string: the scenarios'' own prose names the header when it
	// describes the control, and a substring search would match that instead of a recorded value.
	var recorded struct {
		Scenarios map[string]struct {
			Provider struct {
				Requests []struct {
					Headers []struct {
						Name string `json:"name"`
					} `json:"headers"`
				} `json:"requests"`
			} `json:"provider"`
		} `json:"scenarios"`
	}
	if err := json.Unmarshal(raw, &recorded); err != nil {
		t.Fatal(err)
	}
	for name, scenario := range recorded.Scenarios {
		for _, request := range scenario.Provider.Requests {
			for _, header := range request.Headers {
				if strings.EqualFold(header.Name, "x-session-affinity") {
					t.Fatalf("%s records an x-session-affinity header; its value is a digest of the install cookie secret", name)
				}
			}
		}
	}
}

// TestChatCompletionFireworksAffinityShapeOnThePlan asserts presence, shape and keying without recording it.
func TestChatCompletionFireworksAffinityShapeOnThePlan(t *testing.T) {
	secrets, err := fireworksTestDirectories(t)
	if err != nil {
		t.Fatal(err)
	}
	first := fireworksPlanForTest(t, secrets, `{"chat_completion_source":"fireworks","model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false,"chat_id":"probe-chat-one"}`)
	second := fireworksPlanForTest(t, secrets, `{"chat_completion_source":"fireworks","model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false,"chat_id":"probe-chat-two"}`)
	one := fireworksHeaderValue(first.Headers, "x-session-affinity")
	two := fireworksHeaderValue(second.Headers, "x-session-affinity")
	if one == "" || two == "" {
		t.Fatalf("the plan did not send x-session-affinity (one=%q two=%q)", one, two)
	}
	if one == two {
		t.Fatal("two different chat ids produced the same affinity value")
	}
	if !regexp.MustCompile(`^[0-9a-f]{16}$`).MatchString(one) {
		t.Fatalf("affinity value %q is not 16 lowercase hex characters", one)
	}
	want := pinnedFireworksAffinity(pinnedWireCookieSecret, "probe-chat-one")
	if one != want {
		t.Fatalf("affinity = %q, want HMAC-SHA256(cookie secret, chat_id)[:16] = %q", one, want)
	}
	// And the same plan with NO chat_id must not carry the header at all.
	none := fireworksPlanForTest(t, secrets, `{"chat_completion_source":"fireworks","model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`)
	if got := fireworksHeaderValue(none.Headers, "x-session-affinity"); got != "" {
		t.Fatalf("a request with no chat_id carries the header: %q", got)
	}
}

// TestChatCompletionFireworksFoldMatchesTheRecordingAndThePlan pins the full envelope from both sides.
func TestChatCompletionFireworksFoldMatchesTheRecordingAndThePlan(t *testing.T) {
	fixture := loadFireworksWireFixture(t)
	recorded := fixture.scenario(t, "fireworks-reasoning-schema").Provider.Requests[0].BodyText
	if !strings.Contains(recorded, `"reasoning_effort":"high"`) {
		t.Fatalf("the capture does not carry reasoning_effort: %s", recorded)
	}
	if !strings.Contains(recorded, `"response_format":{"type":"json_schema","json_schema":{"name":"probe_schema","description":"probe description","schema":`) {
		t.Fatalf("the capture does not carry the full envelope: %s", recorded)
	}
	if !strings.Contains(recorded, `"strict":true`) {
		t.Fatalf("the capture does not carry the defaulted strict member: %s", recorded)
	}
	secrets, err := fireworksTestDirectories(t)
	if err != nil {
		t.Fatal(err)
	}
	plan := fireworksPlanForTest(t, secrets, `{"chat_completion_source":"fireworks","model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false,"reasoning_effort":"high","json_schema":{"name":"probe_schema","description":"probe description","value":{"type":"object","properties":{"answer":{"type":"string"}}},"strict":false}}`)
	planBody := string(plan.Body)
	if !strings.Contains(planBody, `"reasoning_effort":"high"`) {
		t.Fatalf("the plan body does not carry reasoning_effort: %s", planBody)
	}
	if !strings.Contains(planBody, `"response_format":{"type":"json_schema","json_schema":{"name":"probe_schema","description":"probe description","schema":`) {
		t.Fatalf("the plan body does not carry the full envelope: %s", planBody)
	}
	if !strings.Contains(planBody, `"strict":false`) {
		t.Fatalf("an explicit strict:false must survive the nullish default: %s", planBody)
	}
}

// TestChatCompletionFireworksStatusUsesItsOwnLiteral pins the out-of-base status literal.
func TestChatCompletionFireworksStatusUsesItsOwnLiteral(t *testing.T) {
	fixture := loadFireworksWireFixture(t)
	scenario := fixture.scenario(t, "fireworks-status")
	if scenario.GoSeam.EnvironmentVariable != pinnedFireworksStatusEnv {
		t.Fatalf("the status scenario uses seam %q, want its own", scenario.GoSeam.EnvironmentVariable)
	}
	if scenario.GoSeam.PinnedLiteral == pinnedFireworksAPIURL {
		t.Fatal("the status literal must not be the API base")
	}
	if !strings.Contains(scenario.GoSeam.PinnedLiteral, "pageSize=200") || !strings.Contains(scenario.GoSeam.PinnedLiteral, "supports_serverless%3Dtrue") {
		t.Fatalf("the status literal lost its query: %q", scenario.GoSeam.PinnedLiteral)
	}
	t.Setenv(pinnedFireworksStatusEnv, "")
	if got := pinnedFireworksStatusURL(); got != pinnedFireworksStatusBase {
		t.Fatalf("status URL = %q", got)
	}
	if !strings.Contains(pinnedFireworksStatusBase, "/accounts/fireworks/models") {
		t.Fatalf("the status base is outside the expected accounts path: %q", pinnedFireworksStatusBase)
	}
}

// TestChatCompletionFireworksIsNotTheDefaultRefusal proves the source reaches a served branch.
func TestChatCompletionFireworksIsNotTheDefaultRefusal(t *testing.T) {
	directories, err := fireworksTestDirectories(t)
	if err != nil {
		t.Fatal(err)
	}
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"fireworks","model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := pinnedChatCompletionPlan(body, directories, pinnedWireCookieSecret); failure != nil && failure.status == 501 {
		t.Fatal("fireworks is answered by the default 501 branch; its plan case is missing")
	}
	unimplemented, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"ai21","model":"m","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if err != nil {
		t.Fatal(err)
	}
	if _, failure := pinnedChatCompletionPlan(unimplemented, directories, pinnedWireCookieSecret); failure == nil || failure.status != 501 {
		t.Fatalf("a source this lane does not implement must answer 501, got %+v", failure)
	}
}

func fireworksPlanForTest(t *testing.T, directories startup.UserDirectories, rawBody string) *outbound.Request {
	t.Helper()
	body, err := decodeOrderedNodeJSON([]byte(rawBody))
	if err != nil {
		t.Fatal(err)
	}
	request, failure := pinnedChatCompletionPlan(body, directories, pinnedWireCookieSecret)
	if failure != nil {
		t.Fatalf("plan failed: %+v", failure)
	}
	return request
}

func fireworksTestDirectories(t *testing.T) (startup.UserDirectories, error) {
	t.Helper()
	installRoot := t.TempDir()
	dataRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(pinnedWireCookieSecret), 0o600); err != nil {
		return nil, err
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		return nil, err
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		return nil, err
	}
	secrets := []byte(`{"api_key_fireworks":[{"id":"probe-id","value":"synthetic-fireworks-key","label":"api_key_fireworks","active":true}]}`)
	if err := os.WriteFile(filepath.Join(directories["root"], "secrets.json"), secrets, 0o600); err != nil {
		return nil, err
	}
	return directories, nil
}

func fireworksHeaderValue(headers []outbound.Header, name string) string {
	for _, header := range headers {
		if strings.EqualFold(header.Name, name) {
			return header.Value
		}
	}
	return ""
}
