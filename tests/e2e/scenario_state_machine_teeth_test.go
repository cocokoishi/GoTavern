package e2e

// NEGATIVE CONTROLS FOR THE SEEDED STATE-MACHINE GATE (alpha.16 M3; differential doctrine rule 4).
//
// Every checker the LIVE driver uses is exercised here twice: once with CORRECT data (it must stay silent) and
// once with a NAMED mutation (it must go red with that name). The mutations are data mutations of observations the
// driver actually takes -- swapped message order, a dropped persisted message, a wrongly-rooted restart, a
// restart that reused the old instance, a cross-account read that leaked, a mutated unknown file, an invalid
// JSONL line -- so a surviving mutation is a harness defect, never a claim about the product. This self-test does
// not depend on any product bug: it plants the defect in the OBSERVATION and asks the gate whether it sees it.
//
// The coupling is structural: the checks below are the same package-level functions `runSeedSequence` and
// `smCheckRestartResume` call. A second private comparator would have proved nothing about the gate.

import (
	"strings"
	"testing"

	"github.com/cocokoishi/gotavern/internal/longlivedfixture"
)

// smTeethCase is one planted defect and the named assertion it must produce.
type smTeethCase struct {
	name         string // the mutation's name, for the report
	mutation     func() error
	wantContains string // the named assertion that must go red
}

// smTeethPassed records one observed red so the report and the test's own count use the same rows.
type smTeethPassed struct{ name, assertion string }

func TestScenarioStateMachineTeeth(t *testing.T) {
	correctMessages := []string{"m0", "m1", "m2", "m3", "m4"}
	correctJSONL := []byte("{\"mes\":\"m0\"}\n{\"mes\":\"m1\"}\n")
	correctSettings := `{"e_series_marker":"SM_SETTINGS_1601"}`
	correctWitness := smRestartWitness{
		Instance:    1,
		DataRoot:    "/tmp/data-root",
		UserMarkers: map[string]string{"default-user": "SM_SETTINGS_1601"},
		PrebootSeed: 1601,
		PrebootChat: []string{"PREBOOT_1601_0", "PREBOOT_1601_1", "PREBOOT_1601_2"},
		UnknownFiles: map[string]string{
			"default-user/user/files/E_1601.bin": "abc",
		},
	}
	correctObservation := smRestartObservation{
		Instance:     2,
		DataRoot:     "/tmp/data-root",
		UserSettings: map[string]string{"default-user": correctSettings},
		PrebootChat:  `[{"mes":"PREBOOT_1601_0"},{"mes":"PREBOOT_1601_1"},{"mes":"PREBOOT_1601_2"}]`,
		UnknownFiles: map[string]string{
			"default-user/user/files/E_1601.bin": "abc",
		},
	}

	// The correct data must pass EVERY checker; a gate that is red on correct data is not a gate. The
	// action-plan checker needs a real recipe and is proved separately below.
	for name, err := range map[string]error{
		"ordered-messages": smCheckOrderedMessages(correctMessages, correctMessages),
		"jsonl":            smCheckJSONL(correctJSONL),
		"settings-marker":  smCheckSettingsMarker(correctSettings, "SM_SETTINGS_1601", true),
		"cross-user":       smCheckCrossUserRead(`{}`, "SM_SETTINGS_1601"),
		"unknown-file":     smCheckUnknownFileDigest("unknown-file", "abc", "abc"),
		"restart-resume":   smCheckRestartResume(correctWitness, correctObservation),
		"reproducible": smCheckReproducible(1601,
			[]smActionEntry{{Seed: 1601, Step: 0, Op: "settings-save", Status: 200}},
			[]smActionEntry{{Seed: 1601, Step: 0, Op: "settings-save", Status: 200}}),
	} {
		if err != nil {
			t.Fatalf("the gate is red on CORRECT data (%s): %v", name, err)
		}
	}

	// The action-plan checker needs a real recipe; build one and prove it accepts the declared plan.
	recipe, err := longlivedfixture.SeededRecipeForSeed(1601)
	if err != nil {
		t.Fatalf("build a recipe for the action-plan control: %v", err)
	}
	planEntries := make([]smActionEntry, 0, len(recipe.Recipe.Actions))
	for index, action := range recipe.Recipe.Actions {
		planEntries = append(planEntries, smActionEntry{Seed: 1601, Step: index, Op: action, Status: 200})
	}
	if err := smCheckActionPlan(recipe, planEntries); err != nil {
		t.Fatalf("the action-plan checker is red on the declared plan: %v", err)
	}

	cases := []smTeethCase{
		{
			name: "swap-message-order",
			mutation: func() error {
				swapped := []string{"m0", "m2", "m1", "m3", "m4"}
				return smCheckOrderedMessages(correctMessages, swapped)
			},
			wantContains: "message-order-swapped:",
		},
		{
			name: "drop-persisted-message",
			mutation: func() error {
				dropped := []string{"m0", "m1", "m2", "m3"}
				return smCheckOrderedMessages(correctMessages, dropped)
			},
			wantContains: "message-dropped:",
		},
		{
			name: "extra-persisted-message",
			mutation: func() error {
				extra := append(append([]string{}, correctMessages...), "m5")
				return smCheckOrderedMessages(correctMessages, extra)
			},
			wantContains: "message-extra:",
		},
		{
			name: "wrong-restart-data-root",
			mutation: func() error {
				wrong := correctObservation
				wrong.DataRoot = "/tmp/another-data-root"
				return smCheckRestartResume(correctWitness, wrong)
			},
			wantContains: "restart-data-root-mismatch:",
		},
		{
			name: "wrong-restart-pid",
			mutation: func() error {
				stale := correctObservation
				stale.Instance = correctWitness.Instance
				return smCheckRestartResume(correctWitness, stale)
			},
			wantContains: "restart-instance-unchanged:",
		},
		{
			name: "cross-user-read",
			mutation: func() error {
				return smCheckCrossUserRead(`[{"mes":"SEEDMSG_1601_0"}]`, "SEEDMSG_1601_")
			},
			wantContains: "cross-user-read-leaked:",
		},
		{
			name: "cross-user-settings-read",
			mutation: func() error {
				return smCheckSettingsMarker(`{"e_series_marker":"SM_SETTINGS_1601"}`, "SM_SETTINGS_1601", false)
			},
			wantContains: "settings-marker-leaked:",
		},
		{
			name: "unknown-file-mutated",
			mutation: func() error {
				return smCheckUnknownFileDigest("unknown-file", "abc", "def")
			},
			wantContains: "unknown-file-mutated:",
		},
		{
			name: "jsonl-corrupt-line",
			mutation: func() error {
				return smCheckJSONL([]byte("{\"mes\":\"m0\"}\nnot json\n"))
			},
			wantContains: "jsonl-invalid:line-2",
		},
		{
			name: "restart-lost-settings-marker",
			mutation: func() error {
				missing := correctObservation
				missing.UserSettings = map[string]string{"default-user": `{"username":"default-user"}`}
				return smCheckRestartResume(correctWitness, missing)
			},
			wantContains: "restart-settings-marker-missing:",
		},
		{
			name: "restart-preboot-chat-dropped",
			mutation: func() error {
				missing := correctObservation
				missing.PrebootChat = `{}`
				return smCheckRestartResume(correctWitness, missing)
			},
			wantContains: "restart-preboot-chat-missing:",
		},
		{
			name: "restart-preboot-chat-reordered",
			mutation: func() error {
				reordered := correctObservation
				reordered.PrebootChat = `[{"mes":"PREBOOT_1601_1"},{"mes":"PREBOOT_1601_0"},{"mes":"PREBOOT_1601_2"}]`
				return smCheckRestartResume(correctWitness, reordered)
			},
			wantContains: "restart-preboot-chat-order:",
		},
		{
			name: "operation-sequence-not-reproducible",
			mutation: func() error {
				first := []smActionEntry{{Seed: 1601, Step: 0, Op: "settings-save", Status: 200, AfterDigest: "a"}}
				second := []smActionEntry{{Seed: 1601, Step: 0, Op: "settings-save", Status: 200, AfterDigest: "b"}}
				return smCheckReproducible(1601, first, second)
			},
			wantContains: "operation-sequence-not-reproducible:",
		},
		{
			name: "action-plan-operation-replaced",
			mutation: func() error {
				mutated := append([]smActionEntry{}, planEntries...)
				mutated[3].Op = "chat-save"
				return smCheckActionPlan(recipe, mutated)
			},
			wantContains: "operation-plan-mismatch:",
		},
	}

	observed := make([]smTeethPassed, 0, len(cases))
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
		observed = append(observed, smTeethPassed{name: control.name, assertion: err.Error()})
		t.Logf("[teeth] %-34s -> %s", control.name, err.Error())
	}
	if len(observed) != len(cases) {
		t.Fatalf("the gate caught %d of %d planted defects", len(observed), len(cases))
	}
	t.Logf("[teeth] %d/%d planted defects produced their NAMED red through the same comparators the live driver uses",
		len(observed), len(cases))
}
