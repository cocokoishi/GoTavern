package commandline

// privateAddressWhitelist.* at the configuration boundary.
//
// Every expectation is the pinned expression at src/server-main.js:337-348, repeated in the rows, plus
// the shape rule pinned's `filterValidIpPatterns` applies to `allowedRanges` (express-common.js:92-112:
// anything that is not an array yields NO entries) and the `getMatch(`${entry}`)` stringification of each
// entry (ip.js:45).

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPrivateAddressFilterSettingsFollowThePinnedReads(t *testing.T) {
	cases := []struct {
		name   string
		config map[string]any
		want   PrivateAddressFilterSettings
		why    string
	}{
		{
			name:   "absent keys use the pinned defaults",
			config: map[string]any{},
			want: PrivateAddressFilterSettings{
				Enabled: false, AllowedRanges: []string{"127.0.0.0/8", "::1/128"},
				LogBlocked: true, LogAllowed: false, AllowUnresolvedHosts: false,
			},
			why: "server-main.js:340-344 -- enabled false, the two loopback ranges, log blocked true, the rest false",
		},
		{
			name: "the shipped stock values",
			config: map[string]any{"privateAddressWhitelist": map[string]any{
				"enabled":              false,
				"allowUnresolvedHosts": false,
				"log":                  map[string]any{"blockedRequests": true, "allowedRequests": false},
				"allowedRanges":        []any{"127.0.0.0/8", "::1/128"},
			}},
			want: PrivateAddressFilterSettings{
				Enabled: false, AllowedRanges: []string{"127.0.0.0/8", "::1/128"},
				LogBlocked: true, LogAllowed: false, AllowUnresolvedHosts: false,
			},
			why: "upstream/default/config.yaml:157-172",
		},
		{
			name:   "enabled true",
			config: map[string]any{"privateAddressWhitelist": map[string]any{"enabled": true}},
			want: PrivateAddressFilterSettings{
				Enabled: true, AllowedRanges: []string{"127.0.0.0/8", "::1/128"},
				LogBlocked: true, LogAllowed: false, AllowUnresolvedHosts: false,
			},
			why: "the switch this task exists for",
		},
		{
			name:   "string true is true",
			config: map[string]any{"privateAddressWhitelist": map[string]any{"enabled": "true"}},
			want: PrivateAddressFilterSettings{
				Enabled: true, AllowedRanges: []string{"127.0.0.0/8", "::1/128"},
				LogBlocked: true, LogAllowed: false, AllowUnresolvedHosts: false,
			},
			why: "the 'boolean' converter is toBoolean, not a strict bool",
		},
		{
			name:   "string false is FALSE",
			config: map[string]any{"privateAddressWhitelist": map[string]any{"enabled": "false"}},
			want: PrivateAddressFilterSettings{
				Enabled: false, AllowedRanges: []string{"127.0.0.0/8", "::1/128"},
				LogBlocked: true, LogAllowed: false, AllowUnresolvedHosts: false,
			},
			why: "toBoolean('false') === false; a filter switched on by the string 'false' would be a security bug in the other direction",
		},
		{
			name: "explicit ranges replace the default",
			config: map[string]any{"privateAddressWhitelist": map[string]any{
				"allowedRanges": []any{"10.0.0.0/8", "192.168.*.*"},
			}},
			want: PrivateAddressFilterSettings{
				Enabled: false, AllowedRanges: []string{"10.0.0.0/8", "192.168.*.*"},
				LogBlocked: true, LogAllowed: false, AllowUnresolvedHosts: false,
			},
			why: "getConfigValue returns the configured array as-is",
		},
		{
			name: "an empty list is an empty list, not the default",
			config: map[string]any{"privateAddressWhitelist": map[string]any{
				"allowedRanges": []any{},
			}},
			want: PrivateAddressFilterSettings{
				Enabled: false, AllowedRanges: []string{},
				LogBlocked: true, LogAllowed: false, AllowUnresolvedHosts: false,
			},
			why: "an operator who empties the whitelist means it: nothing is allowed through",
		},
		{
			name: "a non-array allowedRanges yields NO entries",
			config: map[string]any{"privateAddressWhitelist": map[string]any{
				"allowedRanges": "10.0.0.0/8",
			}},
			want: PrivateAddressFilterSettings{
				Enabled: false, AllowedRanges: nil,
				LogBlocked: true, LogAllowed: false, AllowUnresolvedHosts: false,
			},
			why: "filterValidIpPatterns returns [] for anything that is not an array (express-common.js:95-97) -- the scalar is NOT whitelisted",
		},
		{
			name: "entries are stringified the way `${entry}` is",
			config: map[string]any{"privateAddressWhitelist": map[string]any{
				"allowedRanges": []any{"10.0.0.0/8", 42, true, nil, []any{"x"}},
			}},
			want: PrivateAddressFilterSettings{
				Enabled: false, AllowedRanges: []string{"10.0.0.0/8", "42", "true", "null", "x"},
				LogBlocked: true, LogAllowed: false, AllowUnresolvedHosts: false,
			},
			why: "getMatch(`${entry}`) stringifies: String(42)='42', String(true)='true', String(null)='null', String(['x'])='x' -- each is then dropped as an invalid pattern, with a warning naming it",
		},
		{
			name: "the two log switches and allowUnresolvedHosts",
			config: map[string]any{"privateAddressWhitelist": map[string]any{
				"enabled":              true,
				"log":                  map[string]any{"blockedRequests": false, "allowedRequests": true},
				"allowUnresolvedHosts": true,
			}},
			want: PrivateAddressFilterSettings{
				Enabled: true, AllowedRanges: []string{"127.0.0.0/8", "::1/128"},
				LogBlocked: false, LogAllowed: true, AllowUnresolvedHosts: true,
			},
			why: "server-main.js:342-344",
		},
		{
			name: "a null log mapping falls back to the defaults",
			config: map[string]any{"privateAddressWhitelist": map[string]any{
				"log": nil,
			}},
			want: PrivateAddressFilterSettings{
				Enabled: false, AllowedRanges: []string{"127.0.0.0/8", "::1/128"},
				LogBlocked: true, LogAllowed: false, AllowUnresolvedHosts: false,
			},
			why: "dottedValue cannot descend through null, so each leaf keeps its pinned default",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := privateAddressFilterSettings(testCase.config)
			if got.Enabled != testCase.want.Enabled {
				t.Errorf("Enabled = %t, want %t (%s)", got.Enabled, testCase.want.Enabled, testCase.why)
			}
			if got.LogBlocked != testCase.want.LogBlocked {
				t.Errorf("LogBlocked = %t, want %t (%s)", got.LogBlocked, testCase.want.LogBlocked, testCase.why)
			}
			if got.LogAllowed != testCase.want.LogAllowed {
				t.Errorf("LogAllowed = %t, want %t (%s)", got.LogAllowed, testCase.want.LogAllowed, testCase.why)
			}
			if got.AllowUnresolvedHosts != testCase.want.AllowUnresolvedHosts {
				t.Errorf("AllowUnresolvedHosts = %t, want %t (%s)", got.AllowUnresolvedHosts, testCase.want.AllowUnresolvedHosts, testCase.why)
			}
			if len(got.AllowedRanges) != len(testCase.want.AllowedRanges) {
				t.Fatalf("AllowedRanges = %#v, want %#v (%s)", got.AllowedRanges, testCase.want.AllowedRanges, testCase.why)
			}
			for index, want := range testCase.want.AllowedRanges {
				if got.AllowedRanges[index] != want {
					t.Fatalf("AllowedRanges[%d] = %q, want %q (%s)", index, got.AllowedRanges[index], want, testCase.why)
				}
			}
		})
	}
}

// TestPrivateAddressFilterReachesTheResolvedCommandLine proves the settings are WIRED into
// ResolveCommandLine from a real config.yaml. The table above is a pure function; without this row a
// correct resolver could still be unreachable.
func TestPrivateAddressFilterReachesTheResolvedCommandLine(t *testing.T) {
	installRoot := t.TempDir()
	configPath := filepath.Join(installRoot, "config.yaml")
	config := strings.Join([]string{
		"privateAddressWhitelist:",
		"  enabled: true",
		"  allowUnresolvedHosts: true",
		"  log:",
		"    blockedRequests: false",
		"    allowedRequests: true",
		"  allowedRanges:",
		"    - 10.0.0.0/8",
		"    - 192.168.*.*",
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
	settings := result.PrivateAddressFilter
	if !settings.Enabled {
		t.Error("PrivateAddressFilter.Enabled = false, want true from privateAddressWhitelist.enabled: true")
	}
	if !settings.AllowUnresolvedHosts {
		t.Error("PrivateAddressFilter.AllowUnresolvedHosts = false, want true")
	}
	if settings.LogBlocked || !settings.LogAllowed {
		t.Errorf("log switches = (blocked %t, allowed %t), want (false, true)", settings.LogBlocked, settings.LogAllowed)
	}
	if len(settings.AllowedRanges) != 2 || settings.AllowedRanges[0] != "10.0.0.0/8" || settings.AllowedRanges[1] != "192.168.*.*" {
		t.Errorf("AllowedRanges = %#v, want the two configured entries in order", settings.AllowedRanges)
	}
}

// TestTheStockConfigLeavesTheFilterOff is the negative control at the file level: the config a fresh
// install is given must leave the filter DISABLED, or an upgrade would silently start blocking a user's
// local provider on the strength of a default they never chose.
func TestTheStockConfigLeavesTheFilterOff(t *testing.T) {
	stock := filepath.Join("..", "..", "upstream", "default", "config.yaml")
	body, err := os.ReadFile(stock)
	if err != nil {
		t.Skipf("the pinned default config is not present in this checkout: %v", err)
	}
	installRoot := t.TempDir()
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
	settings := result.PrivateAddressFilter
	if settings.Enabled {
		t.Fatal("the stock pinned config enabled the private address filter; the pinned default is false and a fresh install must not start filtering")
	}
	if len(settings.AllowedRanges) != 2 || settings.AllowedRanges[0] != "127.0.0.0/8" || settings.AllowedRanges[1] != "::1/128" {
		t.Fatalf("AllowedRanges = %#v, want the pinned default loopback pair", settings.AllowedRanges)
	}
	if !settings.LogBlocked || settings.LogAllowed || settings.AllowUnresolvedHosts {
		t.Fatalf("stock switches = (blocked %t, allowed %t, unresolved %t), want (true, false, false)",
			settings.LogBlocked, settings.LogAllowed, settings.AllowUnresolvedHosts)
	}
}
