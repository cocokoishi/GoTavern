package server

// D-H1 regression (docs/alpha16/source-audit.md:183). The chat-completion providers used to resolve
// provider-visible config keys by DERIVING config.yaml from startup.UserDirectories: "root" is
// `<dataRoot>/<handle>`, so the readers tried `<parent(dataRoot)>/config.yaml` and `<dataRoot>/config.yaml`.
// A run whose config file is elsewhere -- `--configPath`, or a `--dataRoot` that is not adjacent to the
// config file -- therefore silently took every default. The provider-wire harness cannot see it because it
// builds exactly `root/data` + `root/config.yaml`.
//
// These tests build the same inputs a real start builds: an HTTPHandlerOptions whose ConfigPath is the
// resolved config.yaml (set by internal/app/server.go from parsed.Paths.ConfigFile, the absolute path
// configinit has already parsed) and a data root B that is NOT adjacent to the install root A. They then
// drive pinnedChatCompletionResolve -- the function the generate route calls, with the handler's
// ConfigPath forwarded -- for the three config-reading sources.
//
// THE DECOY IS THE NEGATIVE CONTROL. A second config.yaml sits at the first location the OLD derivation
// looks (`<parent(dataRoot)>/config.yaml`) and carries opposite values. If a reader consults it, the
// assertions below report the decoy's value, which is exactly the D-H1 behaviour: the operator's
// `--configPath` file would be silently ignored in favour of a guessed path.

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// The resolved file: every value below differs from both the shipped default and the decoy.
const pinnedChatStartupConfig = `promptPlaceholder: "[verified placeholder]"
claude:
  enableAdaptiveThinking: true
  enableSystemPromptCache: true
  extendedTTL: true
gemini:
  apiVersion: v1
  thoughtSignatures: false
mistral:
  enablePrefix: true
openai:
  randomizeUserId: true
`

// The decoy: the shipped/dir-derived values, so a reader that consults it looks exactly like a reader that
// took the defaults -- and both are red against the resolved file.
const pinnedChatStartupDecoyConfig = `promptPlaceholder: "[decoy placeholder]"
claude:
  enableAdaptiveThinking: false
  enableSystemPromptCache: false
  extendedTTL: false
gemini:
  apiVersion: v1beta
  thoughtSignatures: true
mistral:
  enablePrefix: false
openai:
  randomizeUserId: false
`

func writePinnedChatStartupFile(t *testing.T, path, body string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		t.Fatalf("write %s: %v", path, err)
	}
}

// pinnedChatStartupConfigFixture builds install root A (holding the resolved config), data root B (NOT
// adjacent to A), the three provider credentials, and the handler options a real start builds.
func pinnedChatStartupConfigFixture(t *testing.T) (HTTPHandlerOptions, startup.UserDirectories) {
	t.Helper()
	installRoot := t.TempDir()
	dataRoot := t.TempDir()
	if filepath.Dir(dataRoot) == installRoot {
		t.Fatalf("fixture defect: data root %q is adjacent to install root %q; the test would not exercise a "+
			"non-adjacent --dataRoot", dataRoot, installRoot)
	}
	configPath := filepath.Join(installRoot, "config.yaml")
	writePinnedChatStartupFile(t, configPath, pinnedChatStartupConfig)
	// The DECOY, at the first candidate the old directory-derived reader consults.
	writePinnedChatStartupFile(t, filepath.Join(filepath.Dir(dataRoot), "config.yaml"), pinnedChatStartupDecoyConfig)

	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatalf("ensure user directories: %v", err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatalf("resolve user directories: %v", err)
	}
	secrets := `{"api_key_claude":[{"id":"probe","value":"synthetic-claude-key","label":"api_key_claude","active":true}],` +
		`"api_key_makersuite":[{"id":"probe","value":"synthetic-makersuite-key","label":"api_key_makersuite","active":true}],` +
		`"api_key_openrouter":[{"id":"probe","value":"synthetic-openrouter-key","label":"api_key_openrouter","active":true}],` +
		`"api_key_mistralai":[{"id":"probe","value":"synthetic-mistral-key","label":"api_key_mistralai","active":true}],` +
		`"api_key_openai":[{"id":"probe","value":"synthetic-openai-key","label":"api_key_openai","active":true}]}`
	writePinnedChatStartupFile(t, filepath.Join(directories["root"], "secrets.json"), secrets)

	options := HTTPHandlerOptions{InstallRoot: installRoot, DataRoot: dataRoot, ConfigPath: configPath}
	return options, directories
}

func pinnedChatStartupBody(t *testing.T, raw string) orderedNodeJSON {
	t.Helper()
	body, err := decodeOrderedNodeJSON([]byte(raw))
	if err != nil {
		t.Fatalf("decode body: %v", err)
	}
	return body
}

// TestChatCompletionProviderConfigFollowsTheStartupResolvedConfigPath is the D-H1 gate: the non-default
// values in the resolved config file must reach the outbound plan for claude, google and openrouter.
func TestChatCompletionProviderConfigFollowsTheStartupResolvedConfigPath(t *testing.T) {
	for _, environment := range []string{
		"SILLYTAVERN_PROMPTPLACEHOLDER",
		"SILLYTAVERN_CLAUDE_ENABLEADAPTIVETHINKING",
		"SILLYTAVERN_CLAUDE_ENABLESYSTEMPROMPTCACHE",
		"SILLYTAVERN_CLAUDE_EXTENDEDTTL",
		"SILLYTAVERN_CLAUDE_CACHINGATDEPTH",
		"SILLYTAVERN_GEMINI_APIVERSION",
		"SILLYTAVERN_GEMINI_THOUGHTSIGNATURES",
		"SILLYTAVERN_MISTRAL_ENABLEPREFIX",
		"SILLYTAVERN_OPENAI_RANDOMIZEUSERID",
	} {
		// A PRESENT variable -- even empty -- is an override in pinned's getConfigValue, so the host must not
		// have one for the file assertions below to mean anything.
		unsetEnvForTest(t, environment)
	}
	options, directories := pinnedChatStartupConfigFixture(t)

	t.Run("claude promptPlaceholder", func(t *testing.T) {
		body := pinnedChatStartupBody(t, `{"chat_completion_source":"claude","model":"claude-sonnet-4-5-20250929",`+
			`"messages":[{"role":"system","content":"probe system"}],"max_tokens":64,"use_sysprompt":true,"stream":false}`)
		plan, failure := pinnedChatCompletionPlan(body, directories, "", options.ConfigPath)
		if failure != nil {
			t.Fatalf("claude plan failed: %+v", failure)
		}
		payload := string(plan.Body)
		if !strings.Contains(payload, `"text":"[verified placeholder]"`) {
			t.Fatalf("claude provider body does not carry the resolved config.yaml promptPlaceholder %q "+
				"(it carried neither that nor the shipped default as the resolved key):\n%s", "[verified placeholder]", payload)
		}
	})

	t.Run("claude enableAdaptiveThinking", func(t *testing.T) {
		body := pinnedChatStartupBody(t, `{"chat_completion_source":"claude","model":"claude-opus-4-6",`+
			`"messages":[{"role":"user","content":"probe"}],"max_tokens":4096,"reasoning_effort":"medium","stream":false}`)
		plan, failure := pinnedChatCompletionPlan(body, directories, "", options.ConfigPath)
		if failure != nil {
			t.Fatalf("claude plan failed: %+v", failure)
		}
		payload := string(plan.Body)
		if !strings.Contains(payload, `"thinking":{"type":"adaptive"}`) {
			t.Fatalf("claude provider body does not carry the adaptive thinking shape although the resolved "+
				"config.yaml sets claude.enableAdaptiveThinking true (a directory-derived reader would take the "+
				"decoy/default false and send budget_tokens):\n%s", payload)
		}
	})

	t.Run("google gemini.apiVersion", func(t *testing.T) {
		body := pinnedChatStartupBody(t, `{"chat_completion_source":"makersuite","model":"gemini-2.5-pro",`+
			`"messages":[{"role":"user","content":"probe"}],"stream":false}`)
		plan, failure := pinnedChatCompletionPlan(body, directories, "", options.ConfigPath)
		if failure != nil {
			t.Fatalf("makersuite plan failed: %+v", failure)
		}
		if !strings.Contains(plan.URL, "/v1/models/gemini-2.5-pro:generateContent") {
			t.Fatalf("makersuite target %q does not use the resolved config.yaml gemini.apiVersion v1 "+
				"(a directory-derived reader would take the decoy/default v1beta)", plan.URL)
		}
	})

	t.Run("openrouter gemini.thoughtSignatures", func(t *testing.T) {
		body := pinnedChatStartupBody(t, `{"chat_completion_source":"openrouter","model":"google/gemini-2.5-pro",`+
			`"messages":[{"role":"user","content":"probe user"},`+
			`{"role":"assistant","content":"probe assistant","signature":"probe-thought-signature"}],"stream":false}`)
		plan, failure := pinnedChatCompletionPlan(body, directories, "", options.ConfigPath)
		if failure != nil {
			t.Fatalf("openrouter plan failed: %+v", failure)
		}
		payload := string(plan.Body)
		if strings.Contains(payload, `"reasoning_details"`) {
			t.Fatalf("openrouter provider body carries reasoning_details although the resolved config.yaml sets "+
				"gemini.thoughtSignatures false (a directory-derived reader would take the decoy/default true):\n%s", payload)
		}
		if strings.Contains(payload, `"signature"`) {
			t.Fatalf("openrouter provider body still carries a source `signature` member, which the transform "+
				"always deletes:\n%s", payload)
		}
	})

	t.Run("claude caching knobs", func(t *testing.T) {
		body := pinnedChatStartupBody(t, `{"chat_completion_source":"claude","model":"claude-sonnet-4-5-20250929",`+
			`"messages":[{"role":"system","content":"probe system"}],"max_tokens":64,"use_sysprompt":true,"stream":false}`)
		plan, failure := pinnedChatCompletionPlan(body, directories, "", options.ConfigPath)
		if failure != nil {
			t.Fatalf("claude plan failed: %+v", failure)
		}
		payload := string(plan.Body)
		if !strings.Contains(payload, `"cache_control":{"type":"ephemeral","ttl":"1h"}`) {
			t.Fatalf("claude provider body does not carry the resolved config.yaml cache_control "+
				"(enableSystemPromptCache true + extendedTTL true -> ttl 1h) on the system block; a "+
				"directory-derived reader would take the decoy/default false and add nothing:\n%s", payload)
		}
	})

	t.Run("mistral enablePrefix", func(t *testing.T) {
		body := pinnedChatStartupBody(t, `{"chat_completion_source":"mistralai","model":"mistral-large-latest",`+
			`"messages":[{"role":"user","content":"probe user"},{"role":"assistant","content":"probe assistant"}],`+
			`"stream":false}`)
		plan, failure := pinnedChatCompletionPlan(body, directories, "", options.ConfigPath)
		if failure != nil {
			t.Fatalf("mistral plan failed: %+v", failure)
		}
		payload := string(plan.Body)
		if !strings.Contains(payload, `"prefix":true`) {
			t.Fatalf("mistral provider body does not mark the trailing assistant turn with prefix:true although "+
				"the resolved config.yaml sets mistral.enablePrefix true (a directory-derived reader would take "+
				"the decoy/default false):\n%s", payload)
		}
	})

	t.Run("openai randomizeUserId", func(t *testing.T) {
		body := pinnedChatStartupBody(t, `{"chat_completion_source":"openai","model":"gpt-4o",`+
			`"messages":[{"role":"user","content":"probe"}],"stream":false}`)
		plan, failure := pinnedChatCompletionPlan(body, directories, "", options.ConfigPath)
		if failure != nil {
			t.Fatalf("openai plan failed: %+v", failure)
		}
		payload := string(plan.Body)
		if !pinnedChatStartupUserUUID.MatchString(payload) {
			t.Fatalf("openai provider body carries no uuid-shaped `user` member although the resolved "+
				"config.yaml sets openai.randomizeUserId true (a directory-derived reader would take the "+
				"decoy/default false and add nothing):\n%s", payload)
		}
	})
}

// pinnedChatStartupUserUUID is the SHAPE `bodyParams.user = uuidv4()` produces (chat-completions.js:2296-2298).
var pinnedChatStartupUserUUID = regexp.MustCompile(`"user":"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}"`)

// TestChatCompletionProviderConfigIgnoresADecoyAtTheDerivedLocation is the explicit negative control: with
// `--configPath` naming the install root's file, a config.yaml sitting where the OLD derivation guesses must
// never be read. Its promptPlaceholder is unique, so a body carrying it proves the decoy was consulted.
func TestChatCompletionProviderConfigIgnoresADecoyAtTheDerivedLocation(t *testing.T) {
	unsetEnvForTest(t, "SILLYTAVERN_PROMPTPLACEHOLDER")
	options, directories := pinnedChatStartupConfigFixture(t)

	body := pinnedChatStartupBody(t, `{"chat_completion_source":"claude","model":"claude-sonnet-4-5-20250929",`+
		`"messages":[{"role":"system","content":"probe system"}],"max_tokens":64,"use_sysprompt":true,"stream":false}`)
	plan, failure := pinnedChatCompletionPlan(body, directories, "", options.ConfigPath)
	if failure != nil {
		t.Fatalf("claude plan failed: %+v", failure)
	}
	payload := string(plan.Body)
	if strings.Contains(payload, "[decoy placeholder]") {
		t.Fatalf("the provider body carries the DECOY config.yaml promptPlaceholder, so a guessed path was read "+
			"instead of the resolved config file %q:\n%s", options.ConfigPath, payload)
	}
	if !strings.Contains(payload, "[verified placeholder]") {
		t.Fatalf("the provider body does not carry the resolved config.yaml promptPlaceholder %q:\n%s",
			"[verified placeholder]", payload)
	}
}
