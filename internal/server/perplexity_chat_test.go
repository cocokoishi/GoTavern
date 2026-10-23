package server

// Plan-level assertions for PERPLEXITY, one per folded member.
//
// LABELLED PER AGENTS.md RULE 4: these are DERIVATIONS from the pinned lines named in
// perplexity_chat.go (chat-completions.js:78, :2422-2437, :2615, :2652-2689). No provider-wire capture for
// this source exists yet -- the scenario inputs are committed for the Linux oracle job to record -- so
// nothing here is a replay and nothing here claims to be.
//
// Each test exists because the member it pins can be wrong in a way that still produces a body that
// parses and a request that succeeds:
//
//  1. the base URL        -- the literal is the only thing standing between this source and a 404, and the
//                            seam is what lets the differential aim it;
//  2. the secret          -- the key name is `api_key_perplexity`; a typo would silently send no key and
//                            the shared guard would answer 400 for a correctly configured install;
//  3. reasoning_effort    -- copied when present, OMITTED when absent (JSON.stringify drops undefined), and
//                            `null` copied rather than dropped, which is what presence-not-truthiness means;
//  4. the json_schema fold -- `{type, json_schema:{schema}}` with NO name and NO strict, unlike the shared
//                            shape, and the shared block must not overwrite it;
//  5. the message type    -- STRICT, not SEMI: the two differ only by the placeholder, so the test uses an
//                            input where the placeholder appears;
//  6. the missing key     -- :2615's guard, reached because :2424 reads the secret unconditionally: the
//                            empty key is RETURNED rather than turned into a failure, so the shared guard
//                            answers 400 instead of this source inventing a 502 or 501.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// TestChatCompletionPerplexityBaseURL pins the literal and the seam.
func TestChatCompletionPerplexityBaseURL(t *testing.T) {
	t.Setenv(pinnedPerplexitySeamEnv, "")
	if got := pinnedPerplexityBaseURL(); got != "https://api.perplexity.ai" {
		t.Fatalf("base URL = %q, want the pinned literal", got)
	}
	t.Setenv(pinnedPerplexitySeamEnv, "http://127.0.0.1:7777/")
	if got := pinnedPerplexityBaseURL(); got != "http://127.0.0.1:7777" {
		t.Fatalf("seamed base URL = %q, want the override with its trailing slash trimmed", got)
	}
	if !strings.HasPrefix(pinnedPerplexityAPIURL, "https://") {
		t.Fatal("the pinned literal is expected to be https")
	}
}

// TestChatCompletionPerplexityReadsItsOwnSecret asserts the key name against the file the way a configured
// install presents it, and asserts that ANOTHER source's key is not accepted in its place.
func TestChatCompletionPerplexityReadsItsOwnSecret(t *testing.T) {
	directories := perplexityTestDirectories(t, `{"api_key_perplexity":[{"id":"probe-id","value":"synthetic-perplexity-key","label":"api_key_perplexity","active":true}],"api_key_groq":[{"id":"probe-id","value":"synthetic-groq-key","label":"api_key_groq","active":true}]}`)
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"perplexity","model":"sonar","messages":[{"role":"user","content":"probe"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	bodyParams := nodeObject()
	_, apiKey, failure := pinnedPerplexitySourceConfig(&body, &bodyParams, directories, perplexityTestCookieSecret)
	if failure != nil {
		t.Fatalf("plan contribution failed: %+v", failure)
	}
	encoded, err := marshalOrderedNodeJSON(apiKey)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `"synthetic-perplexity-key"` {
		t.Fatalf("apiKey = %s, want the api_key_perplexity secret (not another source's)", encoded)
	}
}

// TestChatCompletionPerplexityReasoningEffortPresence is the member that JSON.stringify makes subtle.
func TestChatCompletionPerplexityReasoningEffortPresence(t *testing.T) {
	directories := perplexityTestDirectories(t, `{"api_key_perplexity":[{"id":"probe-id","value":"synthetic-perplexity-key","label":"api_key_perplexity","active":true}]}`)
	cases := []struct {
		name string
		body string
		want string
	}{
		// `null` is PRESENT: JSON.stringify keeps a null value, and drops only an undefined one, so the
		// member must survive here where an absent member must not (asserted separately below).
		{"null", `{"chat_completion_source":"perplexity","reasoning_effort":null}`, `null`},
		{"value", `{"chat_completion_source":"perplexity","reasoning_effort":"high"}`, `"high"`},
		{"empty-string", `{"chat_completion_source":"perplexity","reasoning_effort":""}`, `""`},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			body, err := decodeOrderedNodeJSON([]byte(testCase.body))
			if err != nil {
				t.Fatal(err)
			}
			bodyParams := nodeObject()
			if _, _, failure := pinnedPerplexitySourceConfig(&body, &bodyParams, directories, perplexityTestCookieSecret); failure != nil {
				t.Fatalf("plan contribution failed: %+v", failure)
			}
			encoded, err := marshalOrderedNodeJSON(bodyParams)
			if err != nil {
				t.Fatal(err)
			}
			text := string(encoded)
			if _, present := bodyParams.member("reasoning_effort"); !present {
				t.Fatalf("bodyParams = %s: reasoning_effort is missing, want it copied when the request carries it", text)
			}
			if !strings.Contains(text, `"reasoning_effort":`+testCase.want) {
				t.Fatalf("bodyParams = %s, want reasoning_effort %s", text, testCase.want)
			}
		})
	}

	// The absent case on its own: no member in the request must mean no member in the params.
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"perplexity","model":"sonar"}`))
	if err != nil {
		t.Fatal(err)
	}
	bodyParams := nodeObject()
	if _, _, failure := pinnedPerplexitySourceConfig(&body, &bodyParams, directories, perplexityTestCookieSecret); failure != nil {
		t.Fatalf("plan contribution failed: %+v", failure)
	}
	if _, present := bodyParams.member("reasoning_effort"); present {
		encoded, _ := marshalOrderedNodeJSON(bodyParams)
		t.Fatalf("bodyParams = %s: reasoning_effort must be omitted when the request omits it", encoded)
	}
}

// TestChatCompletionPerplexityJSONSchemaShape pins the fold, including the two members the SHARED shape
// sends and this one must not.
func TestChatCompletionPerplexityJSONSchemaShape(t *testing.T) {
	directories := perplexityTestDirectories(t, `{"api_key_perplexity":[{"id":"probe-id","value":"synthetic-perplexity-key","label":"api_key_perplexity","active":true}]}`)
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"perplexity","model":"sonar","messages":[{"role":"user","content":"probe"}],"json_schema":{"name":"probe_schema","strict":false,"value":{"type":"object","properties":{"answer":{"type":"string"}}}}}`))
	if err != nil {
		t.Fatal(err)
	}
	bodyParams := nodeObject()
	if _, _, failure := pinnedPerplexitySourceConfig(&body, &bodyParams, directories, perplexityTestCookieSecret); failure != nil {
		t.Fatalf("plan contribution failed: %+v", failure)
	}
	format, present := bodyParams.member("response_format")
	if !present {
		t.Fatal("response_format is missing; json_schema must fold into it")
	}
	encoded, err := marshalOrderedNodeJSON(format)
	if err != nil {
		t.Fatal(err)
	}
	text := string(encoded)
	if !strings.Contains(text, `"type":"json_schema"`) {
		t.Fatalf("response_format = %s, want type json_schema", text)
	}
	if !strings.Contains(text, `"json_schema":{"schema":{`) {
		t.Fatalf("response_format = %s, want json_schema.schema carrying the VALUE", text)
	}
	// The two members the shared shape would add and this branch does not (:2430-2437 vs :2641-2650).
	if strings.Contains(text, `"name"`) {
		t.Fatalf("response_format = %s: this source's shape carries NO name member", text)
	}
	if strings.Contains(text, `"strict"`) {
		t.Fatalf("response_format = %s: this source's shape carries NO strict member", text)
	}
	if strings.Contains(text, `"probe_schema"`) {
		t.Fatalf("response_format = %s: the request's json_schema.name must not leak into the body", text)
	}
}

// TestChatCompletionPerplexityProcessesMessagesWithStrict pins the processing TYPE by using an input where
// STRICT and SEMI differ: a lone leading system message gains the placeholder under STRICT only.
func TestChatCompletionPerplexityProcessesMessagesWithStrict(t *testing.T) {
	directories := perplexityTestDirectories(t, `{"api_key_perplexity":[{"id":"probe-id","value":"synthetic-perplexity-key","label":"api_key_perplexity","active":true}]}`)
	const raw = `{"chat_completion_source":"perplexity","model":"sonar","char_name":"Probe","user_name":"Probe User","messages":[{"role":"system","content":"probe system marker"}]}`

	body, err := decodeOrderedNodeJSON([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	bodyParams := nodeObject()
	if _, _, failure := pinnedPerplexitySourceConfig(&body, &bodyParams, directories, perplexityTestCookieSecret); failure != nil {
		t.Fatalf("plan contribution failed: %+v", failure)
	}
	processed, present := body.member("messages")
	if !present {
		t.Fatal("messages are missing after the contribution; the mutation must land on the body")
	}
	encoded, err := marshalOrderedNodeJSON(processed)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(encoded), `"role":"user"`) {
		t.Fatalf("messages = %s: STRICT inserts the user placeholder after a lone leading system message", encoded)
	}

	// And the same input under SEMI must NOT gain it, which is what makes the assertion discriminating
	// rather than a restatement of "the processor ran".
	semiInput, err := decodeOrderedNodeJSON([]byte(raw))
	if err != nil {
		t.Fatal(err)
	}
	original, present := semiInput.member("messages")
	if !present {
		t.Fatal("the fixture lost its messages")
	}
	semi, semiErr := backendsPostProcessPrompt(original, "semi", backendsPromptNamesFor(semiInput))
	if semiErr != nil {
		t.Fatal(semiErr)
	}
	semiEncoded, err := marshalOrderedNodeJSON(semi)
	if err != nil {
		t.Fatal(err)
	}
	if string(semiEncoded) == string(encoded) {
		t.Fatalf("STRICT and SEMI produced the same messages (%s); this test cannot distinguish the types", encoded)
	}
}

// TestChatCompletionPerplexityMissingKeyIsReturnedNotRefused is (b) from the brief, in the form the pinned
// source actually has it: the branch reads the secret unconditionally, and the SHARED guard at :2615 turns
// an empty key into 400 { error: true }. This file must therefore RETURN the empty key, not invent a
// failure of its own -- a 502 or 501 from here would mask the shared refusal.
func TestChatCompletionPerplexityMissingKeyIsReturnedNotRefused(t *testing.T) {
	directories := perplexityTestDirectories(t, `{}`)
	body, err := decodeOrderedNodeJSON([]byte(`{"chat_completion_source":"perplexity","model":"sonar","messages":[{"role":"user","content":"probe"}]}`))
	if err != nil {
		t.Fatal(err)
	}
	bodyParams := nodeObject()
	_, apiKey, failure := pinnedPerplexitySourceConfig(&body, &bodyParams, directories, perplexityTestCookieSecret)
	if failure != nil {
		t.Fatalf("a missing key must not fail here: the shared guard answers 400, this arm answered %+v", failure)
	}
	encoded, err := marshalOrderedNodeJSON(apiKey)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `""` {
		t.Fatalf("apiKey = %s, want the empty string so the shared missing-key guard fires", encoded)
	}
}

// ---- helpers -----------------------------------------------------------------------------------

const perplexityTestCookieSecret = "perplexity-test-cookie-secret"

func perplexityTestDirectories(t *testing.T, secretsJSON string) startup.UserDirectories {
	t.Helper()
	installRoot := t.TempDir()
	dataRoot := t.TempDir()
	if err := os.WriteFile(filepath.Join(dataRoot, "cookie-secret.txt"), []byte(perplexityTestCookieSecret), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directories["root"], "secrets.json"), []byte(secretsJSON), 0o600); err != nil {
		t.Fatal(err)
	}
	return directories
}
