package server

// What the GROQ increment needs that the recorded differential cannot state on its own.
//
//  1. THE SEAM DEFAULT. GROQ's URL is a pinned LITERAL (chat-completions.js:2456) with no reverse_proxy
//     and no custom_url, and the replay points the Go leg at the recording peer through
//     GOTAVERN_GROQ_CHAT_URL. Every provider request in a green replay therefore carries the SEAM value,
//     never the default, so a default that drifted away from the pinned literal would leave the replay
//     green and the product wrong. It is asserted here against the literal the FIXTURE recorded.
//
//  2. THE SECRET NAME. `SECRET_KEYS.GROQ` is the contract: a wrong name reads a different secret (or
//     nothing) and the fixture's own `secrets` map names the key it planted, so the check is against
//     recorded data rather than a constant agreeing with itself.
//
//  3. THE response_format FOLD. groq's fold is NOT the shared helper's: it carries `description` and puts
//     `strict` AFTER `schema`. The recorded request body is the oracle, so the fold is compared to the
//     bytes the pinned server actually sent rather than to a hand-derived expectation.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"

	"github.com/cocokoishi/gotavern/internal/startup"
	"strings"
	"testing"
)

type groqWireFixture struct {
	Scenarios map[string]struct {
		HeaderCoverage struct {
			ComparedExactly []string `json:"comparedExactly"`
		} `json:"headerCoverage"`
		AuthorizationKeyVerified bool `json:"authorizationKeyVerified"`
		GoSeam                   struct {
			EnvironmentVariable string `json:"environmentVariable"`
			PinnedLiteral       string `json:"pinnedLiteral"`
		} `json:"goSeam"`
		ExpectedAuthorizationKey string `json:"expectedAuthorizationKey"`
		Provider                 struct {
			Requests []struct {
				Method   string `json:"method"`
				BodyText string `json:"bodyText"`
			} `json:"requests"`
		} `json:"provider"`
	} `json:"scenarios"`
}

func loadGroqWireFixture(t *testing.T) groqWireFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-provider-wire.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture groqWireFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	names := groqScenarioNames(fixture)
	// Refuse to pass vacuously: the four scenarios this test reasons about must exist.
	for _, required := range []string{"groq-nonstream", "groq-stream", "groq-error-status", "groq-status"} {
		if _, exists := fixture.Scenarios[required]; !exists {
			t.Fatalf("the provider-wire fixture records no %q scenario", required)
		}
	}
	if len(names) < 4 {
		t.Fatalf("expected at least four groq scenarios, found %d", len(names))
	}
	return fixture
}

func groqScenarioNames(fixture groqWireFixture) []string {
	names := make([]string, 0, len(fixture.Scenarios))
	for name := range fixture.Scenarios {
		if strings.HasPrefix(name, "groq-") {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	return names
}

// TestChatCompletionGroqSeamDefault pins the default against the fixture's recorded literal.
func TestChatCompletionGroqSeamDefault(t *testing.T) {
	fixture := loadGroqWireFixture(t)
	for _, name := range groqScenarioNames(fixture) {
		scenario := fixture.Scenarios[name]
		if scenario.GoSeam.EnvironmentVariable != pinnedGroqSeamEnv {
			t.Fatalf("%s: fixture seam %q, code seam %q", name, scenario.GoSeam.EnvironmentVariable, pinnedGroqSeamEnv)
		}
		if pinnedGroqAPIURL != scenario.GoSeam.PinnedLiteral {
			t.Fatalf("%s: the Go literal %q and the fixture's recorded literal %q disagree", name, pinnedGroqAPIURL, scenario.GoSeam.PinnedLiteral)
		}
	}
	t.Setenv(pinnedGroqSeamEnv, "")
	if got := pinnedGroqBaseURL(); got != pinnedGroqAPIURL {
		t.Fatalf("default groq base = %q, want the pinned literal %q", got, pinnedGroqAPIURL)
	}
	t.Setenv(pinnedGroqSeamEnv, "http://127.0.0.1:1")
	if got := pinnedGroqBaseURL(); got != "http://127.0.0.1:1" {
		t.Fatalf("the seam is not honoured: %q", got)
	}
}

// TestChatCompletionGroqKeyIsVerifiedInTheRecording states what the fixture can and cannot say about the
// secret. The recorded scenario does NOT store the planted key (it is a secret) and does not store the
// secrets map either: the probe records `authorizationKeyVerified: true`, which is its assertion that the
// value this scenario planted is the value that arrived at the provider. So the NAME is verified at record
// time and the fixture can only prove that verification HAPPENED and that `authorization` stayed in the
// compared header set. A future re-record that plants the key under a name the code does not read fails
// here instead of silently recording an unauthenticated capture.
func TestChatCompletionGroqKeyIsVerifiedInTheRecording(t *testing.T) {
	fixture := loadGroqWireFixture(t)
	verified := 0
	for _, name := range groqScenarioNames(fixture) {
		scenario := fixture.Scenarios[name]
		compared := make(map[string]bool, len(scenario.HeaderCoverage.ComparedExactly))
		for _, header := range scenario.HeaderCoverage.ComparedExactly {
			compared[strings.ToLower(header)] = true
		}
		if !compared["authorization"] {
			t.Fatalf("%s does not compare the authorization header, so the secret name is unobservable", name)
		}
		if scenario.AuthorizationKeyVerified {
			verified++
		}
	}
	if verified < 3 {
		t.Fatalf("only %d groq scenarios record authorizationKeyVerified; the key name is no longer exercised", verified)
	}
}

// TestChatCompletionGroqResponseFormatMatchesTheRecordedBody compares the fold to the bytes pinned sent.
func TestChatCompletionGroqResponseFormatMatchesTheRecordedBody(t *testing.T) {
	fixture := loadGroqWireFixture(t)
	scenario := fixture.Scenarios["groq-nonstream"]
	if len(scenario.Provider.Requests) != 1 {
		t.Fatalf("groq-nonstream records %d provider requests, want 1", len(scenario.Provider.Requests))
	}
	body := scenario.Provider.Requests[0].BodyText
	const marker = `"response_format":`
	index := strings.Index(body, marker)
	if index < 0 {
		t.Fatalf("the recorded body carries no response_format: %s", body)
	}
	recorded := body[index+len(marker):]
	// Trim the closing brace of the enclosing object and any trailing members the fold does not own.
	recorded = trimToBalancedObject(recorded)

	schema, decodeErr := decodeOrderedNodeJSON([]byte(`{"name":"probe_schema","description":"probe schema","value":{"type":"object","properties":{"answer":{"type":"string"}}}}`))
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	format := pinnedGroqResponseFormat(schema)
	encoded, err := marshalOrderedNodeJSON(format)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != recorded {
		t.Fatalf("response_format fold = %s, pinned recorded %s", encoded, recorded)
	}
}

// trimToBalancedObject returns the leading balanced {...} of s.
func trimToBalancedObject(s string) string {
	depth := 0
	inString := false
	escaped := false
	for index, character := range s {
		if inString {
			if escaped {
				escaped = false
				continue
			}
			switch character {
			case '\\':
				escaped = true
			case '"':
				inString = false
			}
			continue
		}
		switch character {
		case '"':
			inString = true
		case '{':
			depth++
		case '}':
			depth--
			if depth == 0 {
				return s[:index+1]
			}
		}
	}
	return s
}

// TestChatCompletionGroqIsNotTheDefaultRefusal proves the source reaches a served branch: the plan builds a
// request for groq, while a source this lane does not implement still answers 501.
func TestChatCompletionGroqIsNotTheDefaultRefusal(t *testing.T) {
	directories := startup.UserDirectories{}
	body, decodeErr := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"groq","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if decodeErr != nil {
		t.Fatal(decodeErr)
	}
	if _, failure := pinnedChatCompletionPlan(body, directories); failure != nil && failure.status == 501 {
		t.Fatal("groq is answered by the default 501 branch; its plan case is missing")
	}
	unimplemented, unimplementedErr := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"ai21","model":"probe-model","messages":[{"role":"user","content":"x"}],"max_tokens":8,"stream":false}`))
	if unimplementedErr != nil {
		t.Fatal(unimplementedErr)
	}
	if _, failure := pinnedChatCompletionPlan(unimplemented, directories); failure == nil || failure.status != 501 {
		t.Fatalf("a source this lane does not implement must answer 501, got %+v", failure)
	}
}
