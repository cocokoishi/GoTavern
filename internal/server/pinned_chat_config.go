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
//
// THE FILE IS THE STARTUP-RESOLVED ONE, NOT A GUESS (D-H1). The pinned server reads `CONFIG_PATH` once at
// startup (src/util.js:44-79) and getConfigValue then consults that parsed object. GoTavern resolves the
// same path in internal/commandline (Paths.ConfigFile, absolute, after configinit has run on it) and now
// threads it through HTTPHandlerOptions -> chatCompletionRequest -> the planners that read a config key.
// An explicit --configPath, or a --dataRoot that is not adjacent to the config file, therefore reaches the
// provider request instead of silently defaulting every key. The old candidate derivation below survives
// ONLY for direct planner tests, which build startup.UserDirectories without an HTTP handler; it is never a
// second source in production and it must not be consulted when a resolved file exists, because a decoy
// config.yaml at the guessed location would otherwise override the operator's real file.

import (
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// pinnedChatConfigSource is everything a chat-path reader may consult for a provider-visible key: the
// runtime config.yaml the startup chain resolved, and the per-user directories a direct planner test has.
type pinnedChatConfigSource struct {
	file        string
	directories startup.UserDirectories
}

// pinnedChatConfigFromDirectories is the legacy view for the converters whose planners have not been
// threaded with the resolved path (claude caching, mistral, openai, requestOverrides): it derives the file
// from the data root exactly as before. It is NOT used by the four provider-visible helpers below.
func pinnedChatConfigFromDirectories(directories startup.UserDirectories) pinnedChatConfigSource {
	return pinnedChatConfigSource{directories: directories}
}

// pinnedConfigCandidates lists the config file(s) a reader will try, in order. An explicit resolved path is
// THE file and is returned alone: the reader then reads that file or nothing. It is deliberately not
// filtered on readability, because an unreadable resolved file must fall through to the caller's effective
// default, NOT to a guessed location -- a resolved path that is present but cannot be read is still not
// permission to read somebody else's config.yaml.
//
// Without a resolved path the historical derivation is the fallback: the per-user directories' "root" is
// `<dataRoot>/<handle>`, so the data root's parent is the install root -- where the probe writes the file
// (`--dataRoot <runtimeRoot>/data` with `<runtimeRoot>/config.yaml`) and where a real install keeps it.
// These are the two candidates `charactersConfigCandidates` derives from HTTPHandlerOptions; they are
// reached here without threading options through the shared planner signature.
func pinnedConfigCandidates(configFile string, directories startup.UserDirectories) []string {
	if configFile != "" {
		return []string{configFile}
	}
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

// fileValue walks a dotted key through the runtime config.yaml, without the environment override.
func (source pinnedChatConfigSource) fileValue(path []string) (any, bool) {
	for _, candidate := range pinnedConfigCandidates(source.file, source.directories) {
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

// value resolves a dotted key the way the pinned getConfigValue does (src/util.js:88-98): the
// `SILLYTAVERN_<KEY_WITH_UNDERSCORES>` override wins whenever it is PRESENT -- including when it is set to
// the empty string, which is an override to "", not an absence -- then the runtime config file.
func (source pinnedChatConfigSource) value(path []string) (any, bool) {
	if len(path) == 0 {
		return nil, false
	}
	environment := "SILLYTAVERN_" + strings.ToUpper(strings.Join(path, "_"))
	if raw, exists := os.LookupEnv(environment); exists {
		return raw, true
	}
	return source.fileValue(path)
}

// stringValue is a string-valued key. A key that is absent everywhere takes the caller's effective
// default, which for a config-init-inserted key is the default/config.yaml value, not the JS one.
func (source pinnedChatConfigSource) stringValue(path []string, fallback string) string {
	value, exists := source.value(path)
	if !exists {
		return fallback
	}
	if text, ok := value.(string); ok {
		return text
	}
	return fallback
}

// boolValue is `getConfigValue(key, fallback, 'boolean')`: the pinned conversion (util.js toBoolean)
// applied to whatever the file or the environment supplied.
func (source pinnedChatConfigSource) boolValue(path []string, fallback bool) bool {
	value, exists := source.value(path)
	if !exists {
		return fallback
	}
	return pinnedToBoolean(value)
}

// numberValue is `getConfigValue(key, fallback, 'number')`, which is `parseFloat`-shaped: a value that does
// not start with a number keeps the fallback.
func (source pinnedChatConfigSource) numberValue(path []string, fallback int) int {
	value, exists := source.value(path)
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

// pinnedChatConfigValue is the directory-only view still used by requestOverrides.go, which belongs to the
// text-completion backends rather than to this route. It is intentionally NOT given the resolved path: the
// chat-completion route's readers all take a pinnedChatConfigSource now (claude, google, openrouter, mistral
// and the OpenAI randomizeUserId arm), and requestOverrides is the residual named in the fix's commit.
func pinnedChatConfigValue(directories startup.UserDirectories, path []string) (any, bool) {
	return pinnedChatConfigFromDirectories(directories).value(path)
}

// pinnedChatPromptPlaceholder is `PROMPT_PLACEHOLDER` (prompt-converters.js:4) with the config-init merge
// applied: an operator value wins, otherwise the default install's value, otherwise the JS literal.
func pinnedChatPromptPlaceholder(config pinnedChatConfigSource) string {
	return config.stringValue([]string{"promptPlaceholder"}, backendsPromptPlaceholder)
}

// pinnedThoughtSignatures is `!!getConfigValue('gemini.thoughtSignatures', true, 'boolean')`
// (prompt-converters.js:34). The pinned default is TRUE (default/config.yaml:382).
func pinnedThoughtSignatures(config pinnedChatConfigSource) bool {
	return config.boolValue([]string{"gemini", "thoughtSignatures"}, true)
}
