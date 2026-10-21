package server

// Replay of tests/oracle/sillytavern-1.19.0-google-voices.json, recorded by tools/probe-google-voices.mjs
// against the real pinned listener.
//
// `list-voices` performs no outbound request, so the whole comparison is the response: status, every
// header and the exact body BYTES. The body is the entire 251-entry table, which pins its ORDER and the
// resolution of the duplicated `auto` key in the pinned package (last value, first position) rather than
// trusting either.
//
// `googleGetCode` is a DERIVATION from the pinned package, labelled as such: no oracle can exist for a
// route that is not implemented, so it is tested against the pinned predicates rather than recorded.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"testing"
)

type googleVoicesFixture struct {
	Inputs struct {
		TableLength int    `json:"tableLength"`
		FirstCode   string `json:"firstCode"`
		AutoValue   string `json:"autoValue"`
		TableSHA256 string `json:"tableSha256"`
		NativeCount int    `json:"nativeVoicesLength"`
		NativeFirst string `json:"nativeVoicesFirst"`
		Package     string `json:"packageVersion"`
	} `json:"inputs"`
	ImplementedRoutes []string `json:"implementedRoutes"`
	NotImplemented    []string `json:"notImplementedRoutes"`
	Scenarios         map[string]struct {
		Route       string `json:"route"`
		RequestBody string `json:"requestBody"`
		Response    struct {
			Status   int               `json:"status"`
			Headers  map[string]string `json:"headers"`
			Body     json.RawMessage   `json:"body"`
			BodyText string            `json:"bodyText"`
		} `json:"response"`
		Outbound []json.RawMessage `json:"outbound"`
	} `json:"scenarios"`
}

func loadGoogleVoicesOracle(t *testing.T) googleVoicesFixture {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "oracle", "sillytavern-1.19.0-google-voices.json"))
	if err != nil {
		t.Fatal(err)
	}
	var fixture googleVoicesFixture
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	if len(fixture.Scenarios) == 0 {
		t.Fatal("the google-voices oracle records no scenarios")
	}
	return fixture
}

// TestGoogleVoicesTableMatchesPinnedPackage pins the hand-written table to the recorded route response.
// It also asserts the two properties of the pinned source that a copy is most likely to get wrong: the
// table is ORDERED, and `auto` is declared twice in the package so the JS object keeps the LAST value at
// the FIRST position.
func TestGoogleVoicesTableMatchesPinnedPackage(t *testing.T) {
	fixture := loadGoogleVoicesOracle(t)
	if len(googleLanguages) != fixture.Inputs.TableLength {
		t.Fatalf("table carries %d entries, pinned %d", len(googleLanguages), fixture.Inputs.TableLength)
	}
	autoCount := 0
	for index, entry := range googleLanguages {
		if entry.code == "auto" {
			autoCount++
			if index != 0 {
				t.Fatalf("`auto` sits at index %d, pinned index 0", index)
			}
			if entry.name != fixture.Inputs.AutoValue {
				t.Fatalf("`auto` = %q, pinned %q (the LAST duplicate value wins)", entry.name, fixture.Inputs.AutoValue)
			}
		}
	}
	if autoCount != 1 {
		t.Fatalf("`auto` appears %d times; a JS object key can only survive once", autoCount)
	}
	if googleLanguages[0].code != fixture.Inputs.FirstCode {
		t.Fatalf("first code = %q, pinned %q", googleLanguages[0].code, fixture.Inputs.FirstCode)
	}
}

// TestGoogleVoiceRoutesMatchPinnedOracle replays every recorded scenario. Both recorded routes perform
// no request, so the comparison is status, every header and the exact body bytes, and the fixture's
// outbound list must be EMPTY: an empty recording is the observation that nothing was sent.
func TestGoogleVoiceRoutesMatchPinnedOracle(t *testing.T) {
	fixture := loadGoogleVoicesOracle(t)
	names := make([]string, 0, len(fixture.Scenarios))
	for name := range fixture.Scenarios {
		names = append(names, name)
	}
	sort.Strings(names)
	if len(names) < 2 {
		t.Fatalf("the fixture records %d scenarios; both list routes must be replayed", len(names))
	}
	dataRoot := t.TempDir()
	handler := NewHTTPHandlerWithOptions(HTTPHandlerOptions{InstallRoot: dataRoot, DataRoot: dataRoot, DisableCSRF: true})
	for _, name := range names {
		scenario := fixture.Scenarios[name]
		t.Run(name, func(t *testing.T) {
			if len(scenario.Outbound) != 0 {
				t.Fatalf("the pinned route emitted %d requests; it is supposed to emit none", len(scenario.Outbound))
			}
			if len(scenario.Response.BodyText) < 200 {
				t.Fatalf("the recorded body is only %d bytes; it cannot be a whole table", len(scenario.Response.BodyText))
			}
			response := postSecretsRoute(t, handler, scenario.Route, scenario.RequestBody)
			if response.Code != scenario.Response.Status {
				t.Fatalf("status = %d, want %d (body %q)", response.Code, scenario.Response.Status, response.Body.String())
			}
			assertPinnedHeaders(t, response.Header(), scenario.Response.Headers)
			got := response.Body.String()
			wanted := scenario.Response.BodyText
			if got == wanted {
				return
			}
			if len(got) != len(wanted) {
				t.Fatalf("body length = %d, pinned %d", len(got), len(wanted))
			}
			for index := 0; index < len(got); index++ {
				if got[index] != wanted[index] {
					t.Fatalf("body differs at byte %d:\n got %q\nwant %q",
						index,
						got[maxInt(0, index-40):minInt(len(got), index+40)],
						wanted[maxInt(0, index-40):minInt(len(wanted), index+40)])
				}
			}
			t.Fatal("bodies differ without a differing byte")
		})
	}
}

// TestGoogleNativeVoicesTableMatchesPinnedSource pins the generated native-voice table to the recorded
// route: length, first entry, the id-mirrors-name property and the single pinned language.
func TestGoogleNativeVoicesTableMatchesPinnedSource(t *testing.T) {
	fixture := loadGoogleVoicesOracle(t)
	if fixture.Inputs.NativeCount == 0 {
		t.Fatal("the fixture records no native voice count")
	}
	if len(googleNativeVoices) != fixture.Inputs.NativeCount {
		t.Fatalf("native table carries %d voices, pinned %d", len(googleNativeVoices), fixture.Inputs.NativeCount)
	}
	if googleNativeVoices[0].name != fixture.Inputs.NativeFirst {
		t.Fatalf("first native voice = %q, pinned %q", googleNativeVoices[0].name, fixture.Inputs.NativeFirst)
	}
	for index, entry := range googleNativeVoices {
		if entry.name != entry.voiceID {
			t.Fatalf("voice %d has name %q and voice_id %q; the pinned table mirrors them", index, entry.name, entry.voiceID)
		}
		if entry.lang != "en-US" {
			t.Fatalf("voice %d carries lang %q; every pinned native voice is en-US", index, entry.lang)
		}
	}
}
func maxInt(left, right int) int {
	if left > right {
		return left
	}
	return right
}

func minInt(left, right int) int {
	if left < right {
		return left
	}
	return right
}

// TestGoogleGetCodeIsADerivedTable pins the package's `getCode` predicates. Labelled a derivation: no
// oracle can exist for `generate-voice` because that route is deliberately not implemented.
func TestGoogleGetCodeIsADerivedTable(t *testing.T) {
	cases := []struct {
		input  any
		wanted string
		found  bool
		reason string
	}{
		{"en", "en", true, "an exact code wins"},
		{"English", "en", true, "a name matches case-insensitively"},
		{"english", "en", true, "the name comparison lowercases both sides"},
		{"EN", "", false, "a CODE is never matched case-insensitively"},
		{"klingon", "", false, "unknown input returns null"},
		{"constructor", "constructor", true, "an inherited Object.prototype property resolves through the prototype chain"},
		{42, "", false, "a non-string returns null"},
		{nil, "", false, "null returns null"},
	}
	for _, testCase := range cases {
		got, found := googleGetCode(testCase.input)
		if found != testCase.found || got != testCase.wanted {
			t.Fatalf("getCode(%#v) = (%q,%v), want (%q,%v): %s", testCase.input, got, found, testCase.wanted, testCase.found, testCase.reason)
		}
	}
}
