package server

// SOURCE-DERIVED tests for the two OPENROUTER message transforms (AGENTS.md rule 4): the recorded
// differential is the oracle for the bytes, and these pin the decisions that a recording cannot separate --
// which seam a mode reads, which id rule each signature source uses, and the config gate's resolution. The
// fixture-driven half lives in chat_completions_oracle_test.go, which replays the recorded scenarios.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/startup"
)

func openRouterTestDirectories(t *testing.T) startup.UserDirectories {
	t.Helper()
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	if _, err := startup.EnsureDirectories(installRoot, dataRoot, []string{"default-user"}); err != nil {
		t.Fatal(err)
	}
	directories, err := startup.DirectoriesForUser(dataRoot, "default-user")
	if err != nil {
		t.Fatal(err)
	}
	secrets := []byte(`{"api_key_openrouter":[{"id":"probe-id","value":"synthetic-openrouter-key","label":"api_key_openrouter","active":true}]}`)
	if err := os.WriteFile(filepath.Join(directories["root"], "secrets.json"), secrets, 0o600); err != nil {
		t.Fatal(err)
	}
	return directories
}

func writeOpenRouterTestConfig(t *testing.T, directories startup.UserDirectories, body string) {
	t.Helper()
	// The probe writes the scenario's backendConfig to `<runtimeRoot>/config.yaml` and points --dataRoot at
	// `<runtimeRoot>/data`, so the config is the data root's PARENT. Reproduced exactly, because the lookup
	// derives the path from the per-user directories rather than from an options struct.
	configPath := filepath.Join(filepath.Dir(filepath.Dir(directories["root"])), "config.yaml")
	if err := os.WriteFile(configPath, []byte(body), 0o600); err != nil {
		t.Fatal(err)
	}
}

// TestPinnedThoughtSignaturesResolution pins all three arms of `getConfigValue('gemini.thoughtSignatures',
// true, 'boolean')` (prompt-converters.js:34): the environment override wins, the file is read when the
// environment says nothing, and the pinned default is TRUE when neither does.
func TestPinnedThoughtSignaturesResolution(t *testing.T) {
	directories := openRouterTestDirectories(t)
	writeOpenRouterTestConfig(t, directories, "enableUserAccounts: true\nskipContentCheck: true\ngemini:\n  thoughtSignatures: false\n")

	t.Setenv("SILLYTAVERN_GEMINI_THOUGHTSIGNATURES", "")
	if pinnedThoughtSignatures(directories) {
		t.Fatalf("gemini.thoughtSignatures: false in the config file was read as true")
	}

	t.Setenv("SILLYTAVERN_GEMINI_THOUGHTSIGNATURES", "true")
	if !pinnedThoughtSignatures(directories) {
		t.Fatalf("the environment override must win over the file")
	}

	t.Setenv("SILLYTAVERN_GEMINI_THOUGHTSIGNATURES", "")
	writeOpenRouterTestConfig(t, directories, "enableUserAccounts: true\n")
	if !pinnedThoughtSignatures(directories) {
		t.Fatalf("an absent gemini section must take the pinned default, true (default/config.yaml:382)")
	}
}

// TestPinnedOpenRouterSignatureGateIsWiredThroughThePlan is the layer between the reader and the bytes: a
// prior assistant turn carrying a signature must produce NO reasoning_details entry when the config
// disables the gate, and exactly one when it does not. The tool-call signature is in the same body because
// it is NOT gated, so a plan that dropped both would fail the second half.
func TestPinnedOpenRouterSignatureGateIsWiredThroughThePlan(t *testing.T) {
	bodyJSON := `{"chat_completion_source":"openrouter","model":"anthropic/claude-3-7-sonnet","messages":[` +
		`{"role":"user","content":"probe user marker"},` +
		`{"role":"assistant","content":"probe assistant marker","signature":"probe-signature-message",` +
		`"tool_calls":[{"id":"call_probe_1","type":"function","function":{"name":"probe_tool","arguments":"{}"},"signature":"probe-signature-tool"}]}],` +
		`"tools":[{"type":"function","function":{"name":"probe_tool","parameters":{"type":"object","properties":{}}}}],"max_tokens":64}`

	for _, testCase := range []struct {
		name     string
		config   string
		env      string
		wantIDs  []string
		wantNoID string
	}{
		{"default-true", "enableUserAccounts: true\n", "", []string{`"id":"signature-0"`, `"id":"call_probe_1"`}, ""},
		{"flag-off", "enableUserAccounts: true\ngemini:\n  thoughtSignatures: false\n", "",
			[]string{`"id":"call_probe_1"`}, `"id":"signature-0"`},
		{"env-off", "enableUserAccounts: true\n", "false", []string{`"id":"call_probe_1"`}, `"id":"signature-0"`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			directories := openRouterTestDirectories(t)
			writeOpenRouterTestConfig(t, directories, testCase.config)
			t.Setenv("SILLYTAVERN_GEMINI_THOUGHTSIGNATURES", testCase.env)
			body, err := decodeOrderedNodeJSON([]byte(bodyJSON))
			if err != nil {
				t.Fatal(err)
			}
			plan, failure := pinnedOpenRouterChatPlan(chatCompletionRequest{body: body, directories: directories})
			if failure != nil {
				t.Fatalf("plan failed: %+v", failure)
			}
			payload := string(plan.Body)
			for _, want := range testCase.wantIDs {
				if !strings.Contains(payload, want) {
					t.Fatalf("body does not contain %s:\n%s", want, payload)
				}
			}
			if testCase.wantNoID != "" && strings.Contains(payload, testCase.wantNoID) {
				t.Fatalf("body contains %s, which the gate should have suppressed:\n%s", testCase.wantNoID, payload)
			}
			if strings.Contains(payload, `"signature":`) {
				t.Fatalf("a source `signature` member survived, and both sources delete theirs:\n%s", payload)
			}
		})
	}
}

// TestPinnedOpenRouterMediaTransform pins the media branches a body comparison cannot separate from a
// no-op: the two-entry mime map and the mp3 fallback, the remote-url passthrough, the absence of an image
// branch, and the video no-op.
func TestPinnedOpenRouterMediaTransform(t *testing.T) {
	for _, testCase := range []struct {
		name string
		part string
		want string
	}{
		{"mpeg-to-mp3", `{"type":"audio_url","audio_url":{"url":"data:audio/mpeg;base64,cHJvYmU="}}`,
			`{"type":"input_audio","input_audio":{"format":"mp3","data":"cHJvYmU="}}`},
		{"wav-to-wav", `{"type":"audio_url","audio_url":{"url":"data:audio/wav;base64,cHJvYmU="}}`,
			`{"type":"input_audio","input_audio":{"format":"wav","data":"cHJvYmU="}}`},
		{"unknown-mime-falls-back-to-mp3", `{"type":"audio_url","audio_url":{"url":"data:audio/ogg;base64,cHJvYmU="}}`,
			`{"type":"input_audio","input_audio":{"format":"mp3","data":"cHJvYmU="}}`},
		{"remote-audio-untouched", `{"type":"audio_url","audio_url":{"url":"https://media.example.test/probe.mp3"}}`,
			`{"type":"audio_url","audio_url":{"url":"https://media.example.test/probe.mp3"}}`},
		{"image-untouched", `{"type":"image_url","image_url":{"url":"data:image/png;base64,cHJvYmU="}}`,
			`{"type":"image_url","image_url":{"url":"data:image/png;base64,cHJvYmU="}}`},
		{"video-noop", `{"type":"video_url","video_url":{"url":"data:video/mp4;base64,cHJvYmU="}}`,
			`{"type":"video_url","video_url":{"url":"data:video/mp4;base64,cHJvYmU="}}`},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			messages, err := decodeOrderedNodeJSON([]byte(`[{"role":"user","content":[` + testCase.part + `]}]`))
			if err != nil {
				t.Fatal(err)
			}
			pinnedOpenRouterEmbedMedia(&messages, true, true)
			got := string(mustMarshalNodeJSON(t, messages))
			want := `[{"role":"user","content":[` + testCase.want + `]}]`
			if got != want {
				t.Fatalf("media transform produced\n  %s\nwant\n  %s", got, want)
			}
		})
	}
}
