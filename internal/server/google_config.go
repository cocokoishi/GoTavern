package server

import (
	"os"
	"strings"

	"gopkg.in/yaml.v3"
)

// googleConfigValue resolves a dotted `getConfigValue` key the way the pinned server does: the
// `SILLYTAVERN_<KEY_WITH_UNDERSCORES>` environment override first, then the runtime config file, then the
// pinned default. It reuses `charactersConfigCandidates`, which is the same resolution
// `charactersLazyLoadEnabled` already performs, rather than inventing a second path so that the two
// settings cannot read different files.
func googleConfigValue(options HTTPHandlerOptions, path []string, fallback string) string {
	if len(path) == 0 {
		return fallback
	}
	environment := "SILLYTAVERN_" + strings.ToUpper(strings.Join(path, "_"))
	if raw, exists := os.LookupEnv(environment); exists {
		return raw
	}
	for _, candidate := range charactersConfigCandidates(options) {
		body, err := os.ReadFile(candidate)
		if err != nil {
			continue
		}
		var parsed map[string]any
		if yaml.Unmarshal(body, &parsed) != nil {
			continue
		}
		var current any = parsed
		found := true
		for _, key := range path {
			section, ok := current.(map[string]any)
			if !ok {
				found = false
				break
			}
			value, exists := section[key]
			if !exists {
				found = false
				break
			}
			current = value
		}
		if !found {
			return fallback
		}
		if text, ok := current.(string); ok {
			return text
		}
		return fallback
	}
	return fallback
}

// googleAPIVersion is the pinned `getConfigValue('gemini.apiVersion', 'v1beta')`.
func googleAPIVersion(options HTTPHandlerOptions) string {
	return googleConfigValue(options, []string{"gemini", "apiVersion"}, "v1beta")
}
