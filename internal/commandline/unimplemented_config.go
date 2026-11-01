package commandline

// UNIMPLEMENTED CONFIG KEYS — the honesty channel (G-06, G-07).
//
// AGENTS.md rule 18: "No fake compatibility. Missing/different behavior is `partial`, `unsupported` or
// `not implemented`; never fabricate success." A config key that GoTavern parses and then ignores
// violates that rule in the worst direction, because the operator believes a control is ON.
//
// This file turns that silent acceptance into a named startup warning. It is explicitly NOT an
// implementation of either feature, and the messages say so: each one names the key, states that the
// behaviour is NOT implemented and that the setting has no effect.
//
// WHY ONLY THESE KEYS, AND WHY NOT EVERY KEY IN THE TWO FAMILIES
//
// The condition is "pinned would behave differently from GoTavern, and the operator asked for the
// pinned behaviour". A warning on a key whose value GoTavern already reproduces would be noise, and
// noise is how a real warning gets ignored:
//
//   - `sso.trustedProxies` alone is NOT warned about. Its shipped default is `['::1', '127.0.0.1']`
//     (default/config.yaml:137-139), so "present and truthy" is true on every stock install, and the
//     list has no effect in pinned either unless an SSO method is enabled (src/users.js:761-767).
//     It is named inside the two switch warnings instead.
//
// `privateAddressWhitelist.*` USED TO WARN HERE and no longer does. The warning said "GoTavern does NOT
// implement the private address filter", which was true when it was written and is not true now: the
// filter is implemented in internal/outbound (see outbound/privatefilter.go and
// commandline/privateaddress.go). Keeping it would be the same defect in the other direction -- a startup
// message that contradicts the product -- so the row was RETIRED rather than reworded. The four
// subordinate keys never warned, for the reason above: they are read only inside the enabled branch, so
// with `enabled: false` pinned ignores them too and GoTavern matches pinned exactly.
//
// The switches that DO warn are the ones where pinned and GoTavern still diverge:
// `sso.autheliaAuth`/`sso.authentikAuth` (src/users.js:30-31, :761-767).

// UnimplementedConfigWarning is one config key the operator set that GoTavern accepts and does not act
// on. Key is carried separately from Message so a caller (and a test) can key on the setting rather
// than on prose.
type UnimplementedConfigWarning struct {
	Key     string
	Message string
}

// The pinned reads behind each warning, quoted so the condition can be re-checked without the pinned
// checkout:
//
//	sso.autheliaAuth     getConfigValue('sso.autheliaAuth', false, 'boolean')      src/users.js:30
//	sso.authentikAuth    getConfigValue('sso.authentikAuth', false, 'boolean')     src/users.js:31
//	                     if (AUTHELIA_AUTH && await autheliaUserLogin(request))     src/users.js:761-767
//	performance.*        getConfigValue('performance.memoryCacheCapacity', '100mb') src/endpoints/characters.js:30
//	                     getConfigValue('performance.useDiskCache', true)             src/endpoints/characters.js:36
//	                     getConfigValue('performance.lazyLoadCharacters', false)      src/endpoints/characters.js:35
//	gemini.enableSystemPromptCache  getConfigValue(..., false)                       src/endpoints/backends/chat-completions.js:2370
//	git.backend          getConfigValue('git.backend', 'auto')                       src/endpoints/extensions.js:12
//	enableServerPlugins  getConfigValue('enableServerPlugins', false)                 src/server-startup.js plugin gate
//	extensions.models.*  the local ONNX model ids                                     src/transformers.js
const (
	ssoAutheliaKey  = "sso.autheliaAuth"
	ssoAuthentikKey = "sso.authentikAuth"

	performanceMemoryCacheKey = "performance.memoryCacheCapacity"
	performanceDiskCacheKey   = "performance.useDiskCache"
	performanceLazyLoadKey    = "performance.lazyLoadCharacters"
	geminiSystemPromptKey     = "gemini.enableSystemPromptCache"
	gitBackendKey             = "git.backend"
	serverPluginsKey          = "enableServerPlugins"

	modelsAutoDownloadKey   = "extensions.models.autoDownload"
	modelsClassificationKey = "extensions.models.classification"
	modelsCaptioningKey     = "extensions.models.captioning"
	modelsEmbeddingKey      = "extensions.models.embedding"
	modelsSpeechToTextKey   = "extensions.models.speechToText"
	modelsTextToSpeechKey   = "extensions.models.textToSpeech"
)

// The pinned SHIPPED defaults. A warning fires only when the effective value DIFFERS from these, so a
// stock install prints nothing; that is the "bounded" half of the requirement and the reason a default
// that is truthy in pinned (performance.useDiskCache, extensions.models.autoDownload) still does not warn.
const (
	pinnedMemoryCacheCapacity = "100mb"
	pinnedGitBackend          = "auto"
	pinnedModelAutoDownload   = "true"
	pinnedModelClassification = "Cohee/distilbert-base-uncased-go-emotions-onnx"
	pinnedModelCaptioning     = "Xenova/vit-gpt2-image-captioning"
	pinnedModelEmbedding      = "Cohee/jina-embeddings-v2-base-en"
	pinnedModelSpeechToText   = "Xenova/whisper-small"
	pinnedModelTextToSpeech   = "Xenova/speecht5_tts"
)

// maxUnimplementedConfigWarnings bounds the startup output. An operator who sets many of these gets at
// most this many lines; the last line says how many more are in scope and points at docs/config-parity.md,
// so the warning stays readable instead of becoming a wall of text that gets ignored.
const maxUnimplementedConfigWarnings = 8

// ModelsUnimplementedWarningKey is the Key of the bounded-overflow line. It is not a config key, so the
// doc generator treats it as the summary marker rather than as a row.
const ModelsUnimplementedWarningKey = "(bounded startup warnings)"

// unimplementedConfigWarnings reports the config keys an operator set that GoTavern does not implement.
// The order is fixed so the startup output is deterministic.
func unimplementedConfigWarnings(config map[string]any) []UnimplementedConfigWarning {
	warnings := make([]UnimplementedConfigWarning, 0, maxUnimplementedConfigWarnings)
	appendWarning := func(key, message string) {
		warnings = append(warnings, UnimplementedConfigWarning{Key: key, Message: message})
	}
	booleanRule := func(key string, pinnedDefault bool, when func(bool) bool, message string) {
		if when(jsBoolean(getConfigValue(config, key, pinnedDefault, cliBoolean))) {
			appendWarning(key, message)
		}
	}
	stringRule := func(key, pinnedDefault string, message string) {
		if jsString(getConfigValue(config, key, pinnedDefault, cliString)) != pinnedDefault {
			appendWarning(key, message)
		}
	}

	booleanRule(ssoAutheliaKey, false, func(value bool) bool { return value },
		"Warning: "+ssoAutheliaKey+" is true, but GoTavern does NOT implement SSO auto-login: "+
			"a request carrying the Authelia `Remote-User` header will not establish a session, and users must log in manually. "+
			"sso.trustedProxies is not consulted either. This setting has no effect.")
	booleanRule(ssoAuthentikKey, false, func(value bool) bool { return value },
		"Warning: "+ssoAuthentikKey+" is true, but GoTavern does NOT implement SSO auto-login: "+
			"a request carrying the Authentik `X-Authentik-Username` header will not establish a session, and users must log in manually. "+
			"sso.trustedProxies is not consulted either. This setting has no effect.")
	stringRule(performanceMemoryCacheKey, pinnedMemoryCacheCapacity,
		"Warning: "+performanceMemoryCacheKey+" is set, but GoTavern does NOT implement a character-card memory cache to bound: "+
			"cards are parsed per request, so the configured capacity changes memory use and listing latency rather than any response. "+
			"This setting has no effect.")
	booleanRule(performanceDiskCacheKey, true, func(value bool) bool { return !value },
		"Warning: "+performanceDiskCacheKey+" is false, but GoTavern does NOT implement the parsed-card disk cache either: "+
			"the pinned cache it would disable does not exist here. This setting has no effect.")
	booleanRule(performanceLazyLoadKey, false, func(value bool) bool { return value },
		"Warning: "+performanceLazyLoadKey+" is true, but GoTavern does NOT implement a lazy character-loading path: "+
			"every listing parses the cards it returns. This setting has no effect.")
	booleanRule(geminiSystemPromptKey, false, func(value bool) bool { return value },
		"Warning: "+geminiSystemPromptKey+" is true, but GoTavern does NOT implement the OpenRouter prompt cache on Gemini system prompts: "+
			"the pinned gate needs a live OpenRouter model-cacheability probe that this tree does not make, so no cache_control is sent. "+
			"This setting has no effect.")
	stringRule(gitBackendKey, pinnedGitBackend,
		"Warning: "+gitBackendKey+" is set to `builtin`, but GoTavern does NOT implement the integrated isomorphic-git backend: "+
			"extension installation uses the system git binary, and `builtin` cannot be selected. This setting has no effect.")
	booleanRule(serverPluginsKey, false, func(value bool) bool { return value },
		"Warning: "+serverPluginsKey+" is true, but GoTavern does NOT implement arbitrary Node server plugins, the project's sole explicit ecosystem exclusion (AGENTS.md 16): "+
			"plugin routes are not emulated. This setting has no effect.")
	stringRule(modelsClassificationKey, pinnedModelClassification,
		"Warning: "+modelsClassificationKey+" is set, but GoTavern does NOT implement local in-process ONNX inference (architecture exclusion): "+
			"no classification model is loaded. This setting has no effect.")
	stringRule(modelsCaptioningKey, pinnedModelCaptioning,
		"Warning: "+modelsCaptioningKey+" is set, but GoTavern does NOT implement local in-process ONNX inference (architecture exclusion): "+
			"no captioning model is loaded. This setting has no effect.")
	stringRule(modelsEmbeddingKey, pinnedModelEmbedding,
		"Warning: "+modelsEmbeddingKey+" is set, but GoTavern does NOT implement local in-process ONNX inference (architecture exclusion): "+
			"no local embedding model is loaded. This setting has no effect.")
	stringRule(modelsSpeechToTextKey, pinnedModelSpeechToText,
		"Warning: "+modelsSpeechToTextKey+" is set, but GoTavern does NOT implement local in-process ONNX inference (architecture exclusion): "+
			"no speech-to-text model is loaded. This setting has no effect.")
	stringRule(modelsTextToSpeechKey, pinnedModelTextToSpeech,
		"Warning: "+modelsTextToSpeechKey+" is set, but GoTavern does NOT implement local in-process ONNX inference (architecture exclusion): "+
			"no text-to-speech model is loaded. This setting has no effect.")
	booleanRule(modelsAutoDownloadKey, true, func(value bool) bool { return !value },
		"Warning: "+modelsAutoDownloadKey+" is false, but GoTavern does NOT implement a local ONNX model downloader to disable "+
			"(architecture exclusion). This setting has no effect.")

	if len(warnings) > maxUnimplementedConfigWarnings {
		overflow := len(warnings) - (maxUnimplementedConfigWarnings - 1)
		warnings = warnings[:maxUnimplementedConfigWarnings-1]
		warnings = append(warnings, UnimplementedConfigWarning{
			Key: ModelsUnimplementedWarningKey,
			Message: "Warning: " + itoa(overflow) + " more config setting(s) that GoTavern accepts and does NOT implement are in effect; " +
				"see docs/config-parity.md for the complete, classified list. No further lines are printed so this warning stays readable.",
		})
	}
	return warnings
}

// itoa avoids importing strconv in a file whose only numeric need is this bounded count.
func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := make([]byte, 0, 4)
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}
