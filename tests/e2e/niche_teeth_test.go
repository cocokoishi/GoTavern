package e2e

// NEGATIVE CONTROLS FOR EVERY NEW COMPARATOR (alpha.17; differential doctrine rule 4).
//
// Every checker the niche positive tests use is exercised here TWICE: once with CORRECT data (it must stay
// silent) and once with a NAMED mutation (it must go red with that name). The mutations are data mutations of
// observations the live cases actually take -- a swapped message order, a dropped unknown field, a wrong
// status/header, a corrupted JSONL line, a truncated stream frame, a cancel that did not propagate, a wrong
// settings value, a wrong cache identity, a partial crash state, an unsafe derived filename -- so a surviving
// mutation is a HARNESS defect, never a claim about the product. This self-test does not depend on any product
// bug: it plants the defect in the OBSERVATION and asks the gate whether it sees it.
//
// The coupling is structural: the checks below are the same package-level functions the positive niche tests
// call. A second private comparator here would have proved nothing about those gates.

import (
	"strings"
	"testing"
)

type nicheTeethCase struct {
	name         string
	mutation     func() error
	wantContains string
}

func TestNicheTeeth(t *testing.T) {
	// ---------------------------------------------------------------- the gates are SILENT on correct data
	correctChat := []string{`{"mes":"m0"}`, `{"mes":"m1"}`, `{"mes":"m2"}`}
	correctJSONL := []byte(`{"mes":"m0"}` + "\n" + `{"mes":"m1"}` + "\n")
	correctSettings := `{"marker":"TEETH","n":1}`
	correctStream := "data: {\"a\":1}\n\ndata: [DONE]\n\n"
	oldDocument := []byte(`{"marker":"OLD"}`)
	newDocument := []byte(`{"marker":"NEW"}`)
	for name, err := range map[string]error{
		"status":        nicheCheckStatus("control", 200, 200),
		"header":        nicheCheckHeader("control", "Content-Type", "application/json", "application/json"),
		"header-absent": nicheCheckHeaderAbsent("control", "ETag", ""),
		"body":          nicheCheckBody("control", "abc", "abc"),
		"contains":      nicheCheckContains("control", "abc def", "def"),
		"not-contains":  nicheCheckNotContains("control", "abc", "zzz"),
		"ordered-chat":  nicheCheckOrderedChat("control", correctChat, correctChat),
		"member":        nicheCheckMember("control", correctSettings, "marker", `"TEETH"`),
		"jsonl":         nicheCheckJSONLLines("control", correctJSONL),
		"stream":        nicheCheckStreamBytes("control", correctStream, correctStream),
		"cancel":        nicheCheckCancelPropagation("control", []string{"disconnected"}, true),
		"settings":      nicheCheckSettingsValue("control", correctSettings, "marker", "TEETH"),
		"cache-stale":   nicheCheckCacheIdentity("control", true, true),
		"cache-fresh":   nicheCheckCacheIdentity("control", false, false),
		"crash-old":     nicheCheckCrashState("control", oldDocument, oldDocument, newDocument),
		"crash-new":     nicheCheckCrashState("control", newDocument, oldDocument, newDocument),
		"filename":      nicheCheckFilenameContained("control", "chat.jsonl", "/tmp/chats"),
		"goroutines":    nicheCheckGoroutines("control", 10, 10, 4),
		"file-presence": nicheCheckFilePresence("control", "/definitely/not/a/real/path", false),
	} {
		if err != nil {
			t.Fatalf("the gate is red on CORRECT data (%s): %v", name, err)
		}
	}

	// ---------------------------------------------------------------- planted defects must produce the NAME
	cases := []nicheTeethCase{
		{
			name:         "message-order-swapped",
			mutation:     func() error { return nicheCheckOrderedChat("planted", []string{correctChat[0], correctChat[2], correctChat[1]}, correctChat) },
			wantContains: "message-order-swapped:",
		},
		{
			name:         "message-dropped",
			mutation:     func() error { return nicheCheckOrderedChat("planted", []string{"m0", "m1"}, correctChat) },
			wantContains: "message-dropped:",
		},
		{
			name:         "message-extra",
			mutation:     func() error { return nicheCheckOrderedChat("planted", append(append([]string{}, correctChat...), "m3"), correctChat) },
			wantContains: "message-extra:",
		},
		{
			name:         "unknown-member-dropped",
			mutation:     func() error { return nicheCheckContains("planted", `{"marker":"TEETH"}`, `"n":1`) },
			wantContains: "content-missing:",
		},
		{
			name:         "wrong-status",
			mutation:     func() error { return nicheCheckStatus("planted", 200, 404) },
			wantContains: "status-mismatch:",
		},
		{
			name:         "wrong-header",
			mutation:     func() error { return nicheCheckHeader("planted", "Content-Type", "text/html", "application/json") },
			wantContains: "header-mismatch:",
		},
		{
			name:         "unexpected-header",
			mutation:     func() error { return nicheCheckHeaderAbsent("planted", "ETag", "W/\"present\"") },
			wantContains: "header-unexpected:",
		},
		{
			name:         "wrong-body",
			mutation:     func() error { return nicheCheckBody("planted", "{}", "[]") },
			wantContains: "body-mismatch:",
		},
		{
			name:         "corrupted-jsonl",
			mutation:     func() error { return nicheCheckJSONLLines("planted", []byte("{\"mes\":\"m0\"}\nnot json\n")) },
			wantContains: "jsonl-invalid:line-2",
		},
		{
			name:         "truncated-stream-frame",
			mutation:     func() error { return nicheCheckStreamBytes("planted", correctStream[:12], correctStream) },
			wantContains: "stream-truncated:",
		},
		{
			name:         "invented-stream-tail",
			mutation:     func() error { return nicheCheckStreamBytes("planted", correctStream+"data: [DONE]\n\n", correctStream) },
			wantContains: "stream-frame-mismatch:",
		},
		{
			name:         "cancel-not-propagated",
			mutation:     func() error { return nicheCheckCancelPropagation("planted", []string{"still-connected"}, true) },
			wantContains: "cancel-not-propagated:",
		},
		{
			name:         "wrong-settings-value",
			mutation:     func() error { return nicheCheckSettingsValue("planted", correctSettings, "marker", "WRONG") },
			wantContains: "settings-value-mismatch:",
		},
		{
			name:         "wrong-member-value",
			mutation:     func() error { return nicheCheckMember("planted", correctSettings, "n", "2") },
			wantContains: "member-mismatch:",
		},
		{
			name:         "cache-identity-stale-not-served",
			mutation:     func() error { return nicheCheckCacheIdentity("planted", false, true) },
			wantContains: "cache-identity-mismatch:",
		},
		{
			name:         "cache-identity-hidden-edit",
			mutation:     func() error { return nicheCheckCacheIdentity("planted", true, false) },
			wantContains: "cache-identity-mismatch:",
		},
		{
			name:         "partial-crash-state",
			mutation:     func() error { return nicheCheckCrashState("planted", []byte(`{"marker":"OL`), oldDocument, newDocument) },
			wantContains: "crash-state-partial:",
		},
		{
			name:         "unsafe-derived-filename",
			mutation:     func() error { return nicheCheckFilenameContained("planted", "..\\escape.jsonl", "/tmp/chats") },
			wantContains: "unsafe-filename:",
		},
		{
			name:         "goroutine-leak",
			mutation:     func() error { return nicheCheckGoroutines("planted", 10, 40, 4) },
			wantContains: "goroutine-leak:",
		},
		{
			name:         "missing-file",
			mutation:     func() error { return nicheCheckFilePresence("planted", "/definitely/not/a/real/path", true) },
			wantContains: "file-missing:",
		},
	}

	observed := make([]string, 0, len(cases))
	for _, control := range cases {
		err := control.mutation()
		if err == nil {
			t.Errorf("PLANTED DEFECT SURVIVED: %s produced no error, so the named assertion %q is decoration",
				control.name, control.wantContains)
			continue
		}
		if !strings.Contains(err.Error(), control.wantContains) {
			t.Errorf("PLANTED DEFECT NAMED WRONGLY: %s produced %q, expected the named assertion %q",
				control.name, err.Error(), control.wantContains)
			continue
		}
		observed = append(observed, control.name)
		t.Logf("[teeth] %-34s -> %s", control.name, err.Error())
	}
	if len(observed) != len(cases) {
		t.Fatalf("the gate caught %d of %d planted defects", len(observed), len(cases))
	}
	t.Logf("[teeth] %d/%d planted defects produced their NAMED red through the same comparators the live niche tests use",
		len(observed), len(cases))
}
