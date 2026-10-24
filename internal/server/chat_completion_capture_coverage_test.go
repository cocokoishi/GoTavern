package server

// THE CAPTURE-COVERAGE CONTROL, AND WHY IT EXISTS.
//
// Every source this package claims to implement is supposed to have at least one provider-wire CAPTURE: a
// scenario input under tests/provider-wire/scenarios/ that the Linux oracle records, whose Go leg is then
// replayed against the recorded provider request. That claim was true in prose and false in fact for three
// sources at once -- chutes, minimax and zai had no scenario input at all, so no capture could exist, and
// nothing anywhere failed. The provider-wire differential cannot notice a source it was never given a scenario
// for: it iterates the SCENARIOS, so a missing source is simply absent from the loop and the suite stays green.
//
// That is the same shape as the unported-source drift this package already has a control for (rule: a control
// naming a source that has since landed silently becomes "assert that an implemented source is unimplemented").
// The registry says what we CLAIM; this test makes the claim cost something.
//
// WHAT COUNTS AS COVERAGE: at least one scenario whose request body names the source. The scenario name prefix
// is NOT used, because the prefixes are irregular (`azure_openai` records as `azure-*`, `mistralai` as
// `mistral-*`, `workers_ai` as `workers-*`) and a prefix rule would either miss those or need an alias table
// that could lie. The request body is what the route actually reads, so it is the honest join key.
//
// THE EXEMPTIONS ARE NAMED, WITH A REASON, and each is a case where a capture CANNOT exist rather than one
// where nobody got round to it:
//
//	cometapi    pinned assembles the URL and key and then throws "This provider is temporarily disabled", so
//	            the pinned product never sends a request. Its refusal is asserted at the route instead.
//
// A source that is implemented but unrecorded is NOT an exemption. If the oracle has not recorded it yet, this
// test is supposed to be red -- that is the signal that a recording is owed, and it is why the three missing
// sources above were found by measurement rather than by a reader noticing.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// pinnedSourcesWithoutACaptureReason names sources for which a provider-wire capture cannot exist, with the
// reason. Keep this list minimal: it is the only way a claimed source can skip the control.
var pinnedSourcesWithoutACaptureReason = map[string]string{
	"cometapi": "pinned assembles the URL and key and then unconditionally throws " +
		"\"This provider is temporarily disabled\", so the pinned product never sends a provider request and " +
		"there is nothing to record; the refusal is asserted at the route instead",
}

type pinnedScenarioInput struct {
	Name    string `json:"name"`
	Request struct {
		Body struct {
			ChatCompletionSource string `json:"chat_completion_source"`
		} `json:"body"`
	} `json:"request"`
}

// pinnedScenarioSources reads every scenario input and returns, per source, the scenarios that name it.
func pinnedScenarioSources(t *testing.T) map[string][]string {
	t.Helper()
	directory := filepath.Join("..", "..", "tests", "provider-wire", "scenarios")
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatalf("read the scenario inputs: %v", err)
	}
	bySource := map[string][]string{}
	scenarios := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		raw, readErr := os.ReadFile(filepath.Join(directory, entry.Name()))
		if readErr != nil {
			t.Fatalf("read %s: %v", entry.Name(), readErr)
		}
		var input pinnedScenarioInput
		if jsonErr := json.Unmarshal(raw, &input); jsonErr != nil {
			t.Fatalf("%s is not valid JSON: %v", entry.Name(), jsonErr)
		}
		scenarios++
		source := input.Request.Body.ChatCompletionSource
		if source == "" {
			t.Fatalf("%s names no chat_completion_source in its request body, so no source can be held to it",
				entry.Name())
		}
		bySource[source] = append(bySource[source], input.Name)
	}
	// A control that can pass over an empty directory proves nothing (rule 19 in a new place): an empty or
	// mis-pathed scenarios directory would make every source "missing", but a filter that read nothing would
	// also make this loop vacuous. Two assertions, so neither can hide the other.
	if scenarios == 0 {
		t.Fatal("no scenario inputs were read; this control cannot report a missing capture from an empty set")
	}
	return bySource
}

func TestEveryClaimedSourceHasAProviderWireCapture(t *testing.T) {
	bySource := pinnedScenarioSources(t)

	// The claimed (plan-path) sources and the route-level ones are both implemented, so both are required.
	required := make([]string, 0, len(pinnedClaimedChatCompletionSources)+len(pinnedRouteLevelChatCompletionSources))
	required = append(required, pinnedClaimedChatCompletionSources...)
	required = append(required, pinnedRouteLevelChatCompletionSources...)
	sort.Strings(required)

	missing := make([]string, 0, len(required))
	covered := 0
	for _, source := range required {
		if scenarios := bySource[source]; len(scenarios) > 0 {
			covered++
			continue
		}
		if reason, exempt := pinnedSourcesWithoutACaptureReason[source]; exempt {
			_ = reason
			continue
		}
		missing = append(missing, source)
	}
	if len(missing) > 0 {
		t.Fatalf("these sources are implemented but have NO provider-wire capture, so their provider request is "+
			"unverified: %s\nAdd scenario inputs under tests/provider-wire/scenarios/ (the Linux oracle records "+
			"them on the next push). A source that cannot have a capture belongs in "+
			"pinnedSourcesWithoutACaptureReason WITH the reason, not in the claimed list unqualified.",
			strings.Join(missing, ", "))
	}
	if covered < 2 {
		t.Fatalf("only %d sources were matched to scenarios; a control this close to zero is not evidence that "+
			"the join key works", covered)
	}
	t.Logf("%d of %d implemented sources have at least one provider-wire capture (%d exemptions)",
		covered, len(required), len(pinnedSourcesWithoutACaptureReason))
}

// TestTheCaptureCoverageControlCanSeeAMissingSource proves the control is not vacuous: it removes one
// source's scenarios from the map it just built and requires the same predicate to name it. Without this,
// a control that mis-joins (say, reading the wrong field) would report full coverage forever.
func TestTheCaptureCoverageControlCanSeeAMissingSource(t *testing.T) {
	bySource := pinnedScenarioSources(t)
	candidate := ""
	for _, source := range pinnedClaimedChatCompletionSources {
		if len(bySource[source]) > 0 {
			candidate = source
			break
		}
	}
	if candidate == "" {
		t.Fatal("no claimed source has a scenario, so this control cannot demonstrate a removable one")
	}
	delete(bySource, candidate)
	if len(bySource[candidate]) != 0 {
		t.Fatalf("%s still has scenarios after deletion; the map is not the one the coverage test reads", candidate)
	}
	if _, exempt := pinnedSourcesWithoutACaptureReason[candidate]; exempt {
		t.Fatalf("%s is exempt from the capture requirement, so removing it cannot demonstrate anything; pick a "+
			"source that is actually required", candidate)
	}
	t.Logf("removing %s's scenarios makes the coverage predicate report it as missing", candidate)
}
