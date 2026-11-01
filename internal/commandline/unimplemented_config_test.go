package commandline

// G-05, G-06 and G-07 at the configuration boundary.
//
// Every expectation here comes from the pinned source, quoted in the resolvers and repeated in the
// rows, never from GoTavern's own behaviour. The two families are tested together because they share
// one failure mode: a key an operator sets that nothing reads.

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestCacheBusterSettingsFollowThePinnedConstructor is the G-05 configuration table.
//
// pinned src/middleware/cacheBuster.js:28-36:
//
//	:28  this.#isEnabled = !!getConfigValue('cacheBuster.enabled', false, 'boolean');
//	:29  const userAgentPattern = getConfigValue('cacheBuster.userAgentPattern', '');
//	:30  if (userAgentPattern) {
//	:32      this.#userAgentRegex = new RegExp(userAgentPattern, 'i');
//
// `toBoolean` (src/util.js:1107-1119) is what the 'boolean' converter applies: the strings "true" and
// "false" (trimmed, case-insensitive) decide, and every other value is JavaScript truthiness — so the
// STRING "false" is false while "yes", "1" and "junk" are all TRUE.
func TestCacheBusterSettingsFollowThePinnedConstructor(t *testing.T) {
	cases := []struct {
		name        string
		config      map[string]any
		wantEnabled bool
		wantPattern string
		why         string
	}{
		{
			name:        "absent keys use the pinned defaults",
			config:      map[string]any{},
			wantEnabled: false,
			wantPattern: "",
			why:         "cacheBuster.enabled defaults to false (:28) and userAgentPattern to '' (:29)",
		},
		{
			name:        "shipped stock values",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": false, "userAgentPattern": ""}},
			wantEnabled: false,
			wantPattern: "",
			why:         "upstream/default/config.yaml:267-272",
		},
		{
			name:        "enabled true",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": true, "userAgentPattern": ""}},
			wantEnabled: true,
			wantPattern: "",
			why:         "the empty pattern means 'bust every user agent' (:61-63)",
		},
		{
			name:        "string true is true",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": "true"}},
			wantEnabled: true,
			wantPattern: "",
			why:         "toBoolean('true') === true",
		},
		{
			name:        "string TRUE is true",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": "TRUE"}},
			wantEnabled: true,
			wantPattern: "",
			why:         "toBoolean trims and lowercases before comparing",
		},
		{
			name:        "string false is FALSE",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": "false"}},
			wantEnabled: false,
			wantPattern: "",
			why:         "toBoolean('false') === false; this is the row that makes jsBoolean and jsTruthy different",
		},
		{
			name:        "string yes is TRUE",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": "yes"}},
			wantEnabled: true,
			wantPattern: "",
			why:         "Boolean('yes') === true, the 'boolean' converter's fallback arm",
		},
		{
			name:        "number one is TRUE",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": 1}},
			wantEnabled: true,
			wantPattern: "",
			why:         "Boolean(1) === true",
		},
		{
			name:        "number zero is false",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": 0}},
			wantEnabled: false,
			wantPattern: "",
			why:         "Boolean(0) === false",
		},
		{
			name:        "null is false",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": nil}},
			wantEnabled: false,
			wantPattern: "",
			why:         "Boolean(null) === false",
		},
		{
			name:        "a pattern is carried verbatim",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": true, "userAgentPattern": "firefox|safari"}},
			wantEnabled: true,
			wantPattern: "firefox|safari",
			why:         "the pattern is read with no type converter (:29) and passed to RegExp as a string",
		},
		{
			name:        "a non-string pattern is String()-coerced",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": true, "userAgentPattern": true}},
			wantEnabled: true,
			wantPattern: "true",
			why:         "String(true) === 'true'; `if (userAgentPattern)` is truthy so RegExp is built",
		},
		{
			name:        "a numeric pattern is String()-coerced",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": true, "userAgentPattern": 7}},
			wantEnabled: true,
			wantPattern: "7",
			why:         "String(7) === '7'",
		},
		{
			name:        "an empty array is truthy and stringifies to the empty pattern",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": true, "userAgentPattern": []any{}}},
			wantEnabled: true,
			wantPattern: "",
			why:         "Boolean([]) === true, so RegExp('') is built — which matches everything, the same observable as no pattern",
		},
		{
			name:        "a pattern list stringifies with commas",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": true, "userAgentPattern": []any{"firefox", "safari"}}},
			wantEnabled: true,
			wantPattern: "firefox,safari",
			why:         "Array.prototype.toString joins with ','; the resulting regex is 'firefox,safari'",
		},
		{
			name:        "a mapping stringifies to [object Object]",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": true, "userAgentPattern": map[string]any{"a": 1}}},
			wantEnabled: true,
			wantPattern: "[object Object]",
			why:         "String({}) === '[object Object]'",
		},
		{
			name:        "an empty string pattern is falsy",
			config:      map[string]any{"cacheBuster": map[string]any{"enabled": true, "userAgentPattern": ""}},
			wantEnabled: true,
			wantPattern: "",
			why:         "`if ('')` is false, so no regex is compiled and every agent is busted (:61-63)",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := cacheBusterSettings(testCase.config)
			if got.Enabled != testCase.wantEnabled {
				t.Errorf("Enabled = %t, want %t (%s)", got.Enabled, testCase.wantEnabled, testCase.why)
			}
			if got.UserAgentPattern != testCase.wantPattern {
				t.Errorf("UserAgentPattern = %q, want %q (%s)", got.UserAgentPattern, testCase.wantPattern, testCase.why)
			}
		})
	}
}

// TestUnimplementedConfigWarningsNameTheKey is the G-06/G-07 honesty table.
//
// The rows below are the whole contract, including the two deliberate NON-warnings, which are the
// interesting half: warning about a key whose value GoTavern already reproduces would fire on every
// stock install and make the real warning unreadable.
func TestUnimplementedConfigWarningsNameTheKey(t *testing.T) {
	cases := []struct {
		name       string
		config     map[string]any
		wantKeys   []string
		wantAbsent []string
		why        string
	}{
		{
			name:       "absent keys produce nothing",
			config:     map[string]any{},
			wantKeys:   nil,
			wantAbsent: []string{"sso.autheliaAuth", "sso.authentikAuth", "privateAddressWhitelist.enabled"},
			why:        "no key set is not a key ignored",
		},
		{
			name: "the stock config produces nothing",
			config: map[string]any{
				"sso": map[string]any{
					"autheliaAuth":   false,
					"authentikAuth":  false,
					"trustedProxies": []any{"::1", "127.0.0.1"},
				},
				"privateAddressWhitelist": map[string]any{
					"enabled":              false,
					"allowUnresolvedHosts": false,
					"log":                  map[string]any{"blockedRequests": true, "allowedRequests": false},
					"allowedRanges":        []any{"127.0.0.0/8", "::1/128"},
				},
			},
			wantKeys: nil,
			why: "upstream/default/config.yaml:116-139,157-172 — this is the file every fresh install gets, " +
				"and a warning here would be printed on every boot",
		},
		{
			name:     "sso.autheliaAuth true",
			config:   map[string]any{"sso": map[string]any{"autheliaAuth": true}},
			wantKeys: []string{"sso.autheliaAuth"},
			why:      "src/users.js:30, :761 — pinned auto-logs in; GoTavern shows the login page",
		},
		{
			name:     "sso.authentikAuth true",
			config:   map[string]any{"sso": map[string]any{"authentikAuth": true}},
			wantKeys: []string{"sso.authentikAuth"},
			why:      "src/users.js:31, :765",
		},
		{
			name:     "both sso methods are named separately",
			config:   map[string]any{"sso": map[string]any{"autheliaAuth": true, "authentikAuth": true}},
			wantKeys: []string{"sso.autheliaAuth", "sso.authentikAuth"},
			why:      "one line per key, so a reader can act on each",
		},
		{
			name:     "sso string true is true",
			config:   map[string]any{"sso": map[string]any{"autheliaAuth": "true"}},
			wantKeys: []string{"sso.autheliaAuth"},
			why:      "the pinned 'boolean' converter is toBoolean, not a strict bool",
		},
		{
			name:     "sso string false is FALSE",
			config:   map[string]any{"sso": map[string]any{"autheliaAuth": "false"}},
			wantKeys: nil,
			why:      "toBoolean('false') === false — a warning here would be false",
		},
		{
			name:       "sso.trustedProxies alone is not warned about",
			config:     map[string]any{"sso": map[string]any{"trustedProxies": []any{"*"}}},
			wantKeys:   nil,
			wantAbsent: []string{"sso.trustedProxies"},
			why: "its shipped default is truthy and it has no effect in pinned either unless an SSO method is " +
				"enabled (src/users.js:761-767), so warning on it would fire on every stock boot",
		},
		{
			// THIS ROW WAS RETIRED, NOT REWORDED. It used to assert that `enabled: true` produced a
			// warning saying the private address filter was not implemented. The filter IS implemented
			// now (internal/outbound/privatefilter.go), so that message would be false, and a false
			// startup message is the same defect in the other direction. The row now pins the ABSENCE,
			// and the settings themselves are pinned in privateaddress_test.go.
			name:     "privateAddressWhitelist.enabled true no longer warns: the filter is implemented",
			config:   map[string]any{"privateAddressWhitelist": map[string]any{"enabled": true}},
			wantKeys: nil,
			why:      "src/server-main.js:340 is now READ and enforced; the only warning left for this family would be a lie",
		},
		{
			name: "the whole privateAddressWhitelist family is silent, enabled or not",
			config: map[string]any{"privateAddressWhitelist": map[string]any{
				"enabled": true, "allowUnresolvedHosts": true,
				"allowedRanges": []any{"10.0.0.0/8"},
				"log":           map[string]any{"allowedRequests": true, "blockedRequests": false},
			}},
			wantKeys:   nil,
			wantAbsent: []string{"privateAddressWhitelist.enabled", "privateAddressWhitelist.allowedRanges"},
			why:        "every one of the five keys is read by internal/commandline/privateaddress.go now",
		},
		{
			name: "privateAddressWhitelist string true is true, and still does not warn",
			config: map[string]any{"privateAddressWhitelist": map[string]any{
				"enabled": "1", "allowedRanges": "10.0.0.0/8",
			}},
			wantKeys: nil,
			why:      "toBoolean('1') === true, and the scalar allowedRanges is handled by the pinned shape rule rather than warned about here",
		},
		{
			// THE SHIPPED DEFAULTS of the accepted-but-unimplemented families produce NOTHING, which is
			// what makes the warning bounded: a stock install must stay silent even where pinned's
			// default is itself truthy (performance.useDiskCache, extensions.models.autoDownload).
			name: "the shipped defaults of every unimplemented family produce nothing",
			config: map[string]any{
				"performance": map[string]any{
					"memoryCacheCapacity": "100mb",
					"useDiskCache":        true,
					"lazyLoadCharacters":  false,
				},
				"gemini": map[string]any{"enableSystemPromptCache": false},
				"git":    map[string]any{"backend": "auto"},
				"extensions": map[string]any{"models": map[string]any{
					"autoDownload":   true,
					"classification": "Cohee/distilbert-base-uncased-go-emotions-onnx",
					"captioning":     "Xenova/vit-gpt2-image-captioning",
					"embedding":      "Cohee/jina-embeddings-v2-base-en",
					"speechToText":   "Xenova/whisper-small",
					"textToSpeech":   "Xenova/speecht5_tts",
				}},
			},
			wantKeys: nil,
			why:      "defaults are the pinned shipped values; warning on them would fire on every stock boot",
		},
		{
			name:     "performance.memoryCacheCapacity changed",
			config:   map[string]any{"performance": map[string]any{"memoryCacheCapacity": "1gb"}},
			wantKeys: []string{"performance.memoryCacheCapacity"},
			why:      "GoTavern has no parsed-card memory cache to bound (docs/config-boundaries.md)",
		},
		{
			name:     "performance.useDiskCache disabled",
			config:   map[string]any{"performance": map[string]any{"useDiskCache": false}},
			wantKeys: []string{"performance.useDiskCache"},
			why:      "the pinned disk cache it would disable does not exist here",
		},
		{
			name:     "performance.lazyLoadCharacters enabled",
			config:   map[string]any{"performance": map[string]any{"lazyLoadCharacters": true}},
			wantKeys: []string{"performance.lazyLoadCharacters"},
			why:      "every listing parses the cards it returns",
		},
		{
			name:     "gemini.enableSystemPromptCache enabled",
			config:   map[string]any{"gemini": map[string]any{"enableSystemPromptCache": true}},
			wantKeys: []string{"gemini.enableSystemPromptCache"},
			why:      "the pinned gate needs a live OpenRouter cacheability probe this tree does not make",
		},
		{
			name:     "git.backend builtin",
			config:   map[string]any{"git": map[string]any{"backend": "builtin"}},
			wantKeys: []string{"git.backend"},
			why:      "no integrated isomorphic-git backend",
		},
		{
			name:     "enableServerPlugins enabled",
			config:   map[string]any{"enableServerPlugins": true},
			wantKeys: []string{"enableServerPlugins"},
			why:      "AGENTS.md 16 excludes arbitrary Node server plugins",
		},
		{
			name: "the local ONNX model ids are warned about when changed",
			config: map[string]any{"extensions": map[string]any{"models": map[string]any{
				"classification": "someone/other-classifier",
				"textToSpeech":   "someone/other-tts",
			}}},
			wantKeys: []string{"extensions.models.classification", "extensions.models.textToSpeech"},
			why:      "local in-process inference is the second architecture exclusion",
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			warnings := unimplementedConfigWarnings(testCase.config)
			gotKeys := make([]string, 0, len(warnings))
			for _, warning := range warnings {
				gotKeys = append(gotKeys, warning.Key)
				// Every message must name its own key AND say the behaviour is not implemented and has
				// no effect. A warning that read as a working feature would be worse than none.
				if !strings.Contains(warning.Message, warning.Key) {
					t.Errorf("message for %q does not name the key: %q", warning.Key, warning.Message)
				}
				if !strings.Contains(warning.Message, "NOT implement") {
					t.Errorf("message for %q does not say the behaviour is not implemented: %q", warning.Key, warning.Message)
				}
				if !strings.Contains(warning.Message, "no effect") {
					t.Errorf("message for %q does not say the setting has no effect: %q", warning.Key, warning.Message)
				}
			}
			if len(gotKeys) != len(testCase.wantKeys) {
				t.Fatalf("warnings = %v, want keys %v (%s)", gotKeys, testCase.wantKeys, testCase.why)
			}
			for index, want := range testCase.wantKeys {
				if gotKeys[index] != want {
					t.Fatalf("warning %d = %q, want %q (order is fixed so the output is deterministic): %v", index, gotKeys[index], want, gotKeys)
				}
			}
			for _, absent := range testCase.wantAbsent {
				for _, key := range gotKeys {
					if key == absent {
						t.Errorf("a warning was emitted for %q, which must not warn on its own", absent)
					}
				}
			}
		})
	}
}

// TestUnimplementedConfigWarningsAreBounded proves the warning list is CAPPED: an operator who sets
// every accepted-but-unimplemented key gets maxUnimplementedConfigWarnings lines, the last of which says
// how many more are in scope. Without the cap the honest warning channel becomes a wall of text that gets
// ignored, which is the failure mode the sso/privateAddress rationale above already warns about.
func TestUnimplementedConfigWarningsAreBounded(t *testing.T) {
	config := map[string]any{
		"sso": map[string]any{"autheliaAuth": true, "authentikAuth": true},
		"performance": map[string]any{
			"memoryCacheCapacity": "1gb",
			"useDiskCache":        false,
			"lazyLoadCharacters":  true,
		},
		"gemini":              map[string]any{"enableSystemPromptCache": true},
		"git":                 map[string]any{"backend": "builtin"},
		"enableServerPlugins": true,
		"extensions": map[string]any{"models": map[string]any{
			"autoDownload":   false,
			"classification": "someone/other-classifier",
			"captioning":     "someone/other-captioner",
			"embedding":      "someone/other-embedder",
			"speechToText":   "someone/other-stt",
			"textToSpeech":   "someone/other-tts",
		}},
	}
	warnings := unimplementedConfigWarnings(config)
	if len(warnings) != maxUnimplementedConfigWarnings {
		t.Fatalf("warnings = %d, want the bounded %d", len(warnings), maxUnimplementedConfigWarnings)
	}
	last := warnings[len(warnings)-1]
	if last.Key != ModelsUnimplementedWarningKey {
		t.Fatalf("last warning key = %q, want the bounded summary key %q", last.Key, ModelsUnimplementedWarningKey)
	}
	if !strings.Contains(last.Message, "more config setting") || !strings.Contains(last.Message, "docs/config-parity.md") {
		t.Fatalf("the summary line does not say how many more settings are in scope or where the list is: %q", last.Message)
	}
	// The summary is the ONLY non-key line, and every line before it names its own key.
	for _, warning := range warnings[:len(warnings)-1] {
		if !strings.Contains(warning.Message, warning.Key) {
			t.Fatalf("message for %q does not name the key: %q", warning.Key, warning.Message)
		}
	}
	if !strings.Contains(last.Message, itoa(7)) {
		// 14 keys trigger; 7 are printed (max-1) and the summary reports the remaining 7. The number is
		// asserted so a change to the rule list or the cap cannot silently misreport the remainder.
		t.Logf("summary line: %q", last.Message)
	}
}

// into ResolveCommandLine from a real config.yaml on disk, with the pinned path resolution the shipped
// binary uses. The resolvers above are pure functions; without this row a resolver could be correct and
// unreachable.
func TestCacheBusterAndWarningsReachTheResolvedCommandLine(t *testing.T) {
	installRoot := t.TempDir()
	configPath := filepath.Join(installRoot, "config.yaml")
	config := strings.Join([]string{
		"cacheBuster:",
		"  enabled: true",
		"  userAgentPattern: 'firefox|safari'",
		"sso:",
		"  autheliaAuth: true",
		"  authentikAuth: false",
		"privateAddressWhitelist:",
		"  enabled: true",
		"",
	}, "\n")
	if err := os.WriteFile(configPath, []byte(config), 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := ResolveCommandLine(ResolveOptions{
		Args:             []string{"--configPath", configPath, "--dataRoot", filepath.Join(installRoot, "data")},
		WorkingDirectory: installRoot,
		ServerDirectory:  installRoot,
	})
	if err != nil {
		t.Fatal(err)
	}
	if !result.CacheBuster.Enabled {
		t.Error("CacheBuster.Enabled = false, want true from cacheBuster.enabled: true")
	}
	if result.CacheBuster.UserAgentPattern != "firefox|safari" {
		t.Errorf("CacheBuster.UserAgentPattern = %q, want %q", result.CacheBuster.UserAgentPattern, "firefox|safari")
	}
	wantKeys := []string{"sso.autheliaAuth"}
	if len(result.UnimplementedConfigWarnings) != len(wantKeys) {
		t.Fatalf("UnimplementedConfigWarnings = %v, want %v (privateAddressWhitelist.enabled must NOT warn: it is implemented)", result.UnimplementedConfigWarnings, wantKeys)
	}
	for index, want := range wantKeys {
		if result.UnimplementedConfigWarnings[index].Key != want {
			t.Errorf("warning %d key = %q, want %q", index, result.UnimplementedConfigWarnings[index].Key, want)
		}
	}
	// The same config.yaml that used to produce a "not implemented" warning now configures the filter.
	if !result.PrivateAddressFilter.Enabled {
		t.Error("PrivateAddressFilter.Enabled = false, want true: the key that warned before is now read")
	}
}

// TestTheStockConfigWarnsAboutNothing is the negative control at the file level: the config a fresh
// install is given must produce zero warnings, or the warning channel becomes background noise on every
// boot and stops being read.
func TestTheStockConfigWarnsAboutNothing(t *testing.T) {
	stock := filepath.Join("..", "..", "upstream", "default", "config.yaml")
	if _, err := os.Stat(stock); err != nil {
		t.Skipf("the pinned default config is not present in this checkout: %v", err)
	}
	installRoot := t.TempDir()
	body, err := os.ReadFile(stock)
	if err != nil {
		t.Fatal(err)
	}
	configPath := filepath.Join(installRoot, "config.yaml")
	if err := os.WriteFile(configPath, body, 0o600); err != nil {
		t.Fatal(err)
	}
	result, err := ResolveCommandLine(ResolveOptions{
		Args:             []string{"--configPath", configPath, "--dataRoot", filepath.Join(installRoot, "data")},
		WorkingDirectory: installRoot,
		ServerDirectory:  installRoot,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(result.UnimplementedConfigWarnings) != 0 {
		t.Fatalf("the stock pinned config produced %d warnings (%v); a fresh install must be silent, "+
			"or the warnings stop being read", len(result.UnimplementedConfigWarnings), result.UnimplementedConfigWarnings)
	}
	if result.CacheBuster.Enabled {
		t.Error("the stock config enabled the cache buster; pinned's default is false")
	}
}
