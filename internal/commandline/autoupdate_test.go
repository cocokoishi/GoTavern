package commandline

import "testing"

// THE CONTRACT, ROW BY ROW (ARCHITECTURE.md 34.3, AGENTS.md rule 26).
//
// Each row states the raw value an operator could put in config.yaml and the decision it must produce.
// The `jsBooleanToday` column records what the coercion this resolver REPLACES would have returned, so the
// divergence is evidence in the file rather than a claim in a report.
func TestResolveAutoUpdateIsStrictAndDefaultsOff(t *testing.T) {
	cases := []struct {
		name           string
		raw            any
		present        bool
		want           bool
		jsBooleanToday bool
		why            string
	}{
		{"absent", nil, false, false, false, "no key: off, whatever the pinned default says"},
		{"null", nil, true, false, false, "an explicit null is not a value"},
		{"true", true, true, true, true, "the only bool that enables it"},
		{"false", false, true, false, false, "explicit off"},
		{"string true", "true", true, true, true, "parseable, trimmed, case-insensitive"},
		{"string TRUE", "TRUE", true, true, true, "case-insensitive"},
		{"string padded", " true ", true, true, true, "trimmed"},
		{"string false", "false", true, false, false, "explicit off as a string"},
		{"empty string", "", true, false, false, "jsBoolean: typed != \"\" is false; agreement by luck"},
		{"yes", "yes", true, false, true, "jsBoolean says TRUE; rule 26 says off"},
		{"on", "on", true, false, true, "jsBoolean says TRUE; rule 26 says off"},
		{"one", "1", true, false, true, "jsBoolean says TRUE; rule 26 says off"},
		{"zero string", "0", true, false, true, "jsBoolean says TRUE for the STRING \"0\"; the number 0 is false"},
		{"junk", "yes please", true, false, true, "jsBoolean says TRUE for any non-empty junk"},
		{"number one", 1, true, false, true, "a number is not a boolean"},
		{"number zero", 0, true, false, false, "neither is zero"},
		{"sequence", []any{"true"}, true, false, true, "jsBoolean's default arm says TRUE for an unexpected type"},
		{"mapping", map[string]any{"enabled": true}, true, false, true, "same: malformed value must not enable"},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := ResolveAutoUpdate(testCase.raw, testCase.present)
			if got != testCase.want {
				t.Fatalf("%s: ResolveAutoUpdate(%#v, present=%t) = %t, want %t (%s)", testCase.name, testCase.raw, testCase.present, got, testCase.want, testCase.why)
			}
			// The row also records what the replaced coercion does, so a future "consistency" edit back to
			// jsBoolean fails here and is named as the re-opening of P0-C.
			if today := jsBoolean(testCase.raw); testCase.present && today != testCase.jsBooleanToday {
				t.Fatalf("%s: jsBoolean(%#v) = %t, expected the recorded %t; if jsBoolean changed, re-read this table before changing the resolver", testCase.name, testCase.raw, today, testCase.jsBooleanToday)
			}
		})
	}
}

// THE USER'S ACTUAL SITUATION: a stock config that literally contains `autoUpdate: true` -- what
// upstream/default/config.yaml and GoTavern's generated fresh config both carry -- must still yield OFF,
// because that key is no longer an input.
func TestStockConfigSayingAutoUpdateTrueResolvesOff(t *testing.T) {
	stock := map[string]any{
		"extensions": map[string]any{
			"enabled":    true,
			"autoUpdate": true,
		},
		"enableServerPluginsAutoUpdate": true,
	}
	if resolveAutoUpdateOption(stock) {
		t.Fatal("a stock config with extensions.autoUpdate: true enabled automatic updating; the inherited keys must be reporting-only (ARCHITECTURE.md 34.3)")
	}
	// And the GoTavern key is the only way in.
	stock["gotavern"] = map[string]any{"autoUpdateExtensions": true}
	if !resolveAutoUpdateOption(stock) {
		t.Fatal("gotavern.autoUpdateExtensions: true did not enable updating")
	}
}
