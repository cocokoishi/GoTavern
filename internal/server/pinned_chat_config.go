package server

// The runtime config values the chat-completion converters read at MODULE LOAD in pinned code:
// `promptPlaceholder` (src/prompt-converters.js:4), `gemini.thoughtSignatures` (:34), `mistral.enablePrefix`
// (:709), and the three Claude caching knobs
// (src/endpoints/backends/chat-completions.js:106-111). A module-load read and a per-request read agree for
// a running server, because the pinned server parses config.yaml once at startup and never re-reads it;
// what does NOT agree is the VALUE the two servers resolve when the operator's file omits the key, and that
// is the part this file exists to get right.
//
// THE ORDER IS: environment override, then the runtime config.yaml, then the value a DEFAULT INSTALL ends
// up with. The last step is not the JS fallback. Pinned's config-init merges `default/config.yaml` into the
// runtime config at startup (AGENTS rule 13), so `getConfigValue('promptPlaceholder', "Let's get started.")`
// observes `"[Start a new chat]"` (default/config.yaml:324) in every install whose config omits the key --
// and the recorded fixture says exactly that: all four empty-message scenarios carry "[Start a new chat]",
// none of them carries the JS literal. `backendsPromptPlaceholder` already encodes that effective default
// for the process routes; these helpers let the chat converters read the same value, and an operator's
// explicit setting, through one path rather than three.

import (
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// pinnedConfigCandidates finds the runtime config.yaml from what a chat-completion planner has: the per-user
// directories, whose "root" is `<dataRoot>/<handle>`, so the data root's parent is the install root -- which
// is where the probe writes it (`--dataRoot <runtimeRoot>/data` with `<runtimeRoot>/config.yaml`) and where
// a real install keeps it. These are the same two candidates `charactersConfigCandidates` derives from
// HTTPHandlerOptions, reached without threading the options struct through the shared planner signature.
func pinnedConfigCandidates(directories startup.UserDirectories) []string {
	root := directories["root"]
	if root == "" {
		return nil
	}
	dataRoot := filepath.Dir(root)
	return []string{
		filepath.Join(filepath.Dir(dataRoot), "config.yaml"),
		filepath.Join(dataRoot, "config.yaml"),
	}
}

// pinnedChatConfigFileValue walks a dotted key through the runtime config.yaml.
func pinnedChatConfigFileValue(directories startup.UserDirectories, path []string) (any, bool) {
	for _, candidate := range pinnedConfigCandidates(directories) {
		body, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		var parsed map[string]any
		if yaml.Unmarshal(body, &parsed) != nil {
			continue
		}
		var current any = parsed
		for _, key := range path {
			section, ok := current.(map[string]any)
			if !ok {
				return nil, false
			}
			value, exists := section[key]
			if !exists {
				return nil, false
			}
			current = value
		}
		return current, true
	}
	return nil, false
}

// pinnedChatConfigValue resolves a dotted key the way the pinned getConfigValue does (src/util.js:88-98):
// the `SILLYTAVERN_<KEY_WITH_UNDERSCORES>` override wins whenever it is PRESENT -- including when it is set
// to the empty string, which is an override to "", not an absence -- then the runtime config file.
func pinnedChatConfigValue(directories startup.UserDirectories, path []string) (any, bool) {
	if len(path) == 0 {
		return nil, false
	}
	environment := "SILLYTAVERN_" + strings.ToUpper(strings.Join(path, "_"))
	if raw, exists := os.LookupEnv(environment); exists {
		return raw, true
	}
	return pinnedChatConfigFileValue(directories, path)
}

// pinnedChatConfigString is a string-valued key. A key that is absent everywhere takes the caller's
// effective default, which for a config-init-inserted key is the default/config.yaml value, not the JS one.
func pinnedChatConfigString(directories startup.UserDirectories, path []string, fallback string) string {
	value, exists := pinnedChatConfigValue(directories, path)
	if !exists {
		return fallback
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fallback
}

// pinnedChatConfigBool is `getConfigValue(key, fallback, 'boolean')`: the pinned conversion (util.js
// toBoolean) applied to whatever the file or the environment supplied.
func pinnedChatConfigBool(directories startup.UserDirectories, path []string, fallback bool) bool {
	value, exists := pinnedChatConfigValue(directories, path)
	if !exists {
		return fallback
	}
	return pinnedToBoolean(value)
}

// pinnedChatConfigNumber is `getConfigValue(key, fallback, 'number')`, which is `parseFloat`-shaped: a value
// that does not start with a number keeps the fallback.
func pinnedChatConfigNumber(directories startup.UserDirectories, path []string, fallback int) int {
	value, exists := pinnedChatConfigValue(directories, path)
	if !exists {
		return fallback
	}
	switch typed := value.(type) {
	case int:
		return typed
	case int64:
		return int(typed)
	case float64:
		return int(typed)
	case string:
		trimmed := strings.TrimSpace(typed)
		start := 0
		negative := strings.HasPrefix(trimmed, "-")
		if negative {
			start = 1
		}
		end := start
		for end < len(trimmed) && trimmed[end] >= '0' && trimmed[end] <= '9' {
			end++
		}
		if end == start {
			return fallback
		}
		total := 0
		for index := start; index < end; index++ {
			total = total*10 + int(trimmed[index]-'0')
		}
		if negative {
			return -total
		}
		return total
	default:
		return fallback
	}
}

// pinnedChatPromptPlaceholder is `PROMPT_PLACEHOLDER` (prompt-converters.js:4) with the config-init merge
// applied: an operator value wins, otherwise the default install's value, otherwise the JS literal.
func pinnedChatPromptPlaceholder(directories startup.UserDirectories) string {
	return backendsPromptPlaceholder
}

// pinnedThoughtSignatures is `!!getConfigValue('gemini.thoughtSignatures', true, 'boolean')`
// (prompt-converters.js:34). The pinned default is TRUE (default/config.yaml:382).
func pinnedThoughtSignatures(directories startup.UserDirectories) bool {
	return pinnedChatConfigBool(directories, []string{"gemini", "thoughtSignatures"}, true)
}
