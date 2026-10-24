package server

import (
	"sort"
	"strconv"
	"strings"
	"testing"
)

// TestRegistrySourceNamesAreUnique is the same control applied to the declarative table that replaced the
// chains. A registry is better than a chain -- a duplicate is visible in one screenful -- but a slice of
// rows still allows the same name twice, and the map built from it would silently keep the LAST row. This
// is the assertion that would have caught AI21/COHERE/CHUTES/AIMLAPI landing twice had the table existed.
func TestRegistrySourceNamesAreUnique(t *testing.T) {
	if len(pinnedChatCompletionSourceRegistry) == 0 {
		t.Fatal("the source registry is empty; this control would pass over nothing")
	}
	counts := map[string]int{}
	for _, row := range pinnedChatCompletionSourceRegistry {
		if strings.TrimSpace(row.name) == "" {
			t.Fatalf("a registry row has an empty name: %+v", row)
		}
		counts[row.name]++
	}
	duplicates := make([]string, 0)
	for name, count := range counts {
		if count > 1 {
			duplicates = append(duplicates, strconv.Quote(name)+" appears "+strconv.Itoa(count)+" times")
		}
	}
	if len(duplicates) > 0 {
		sort.Strings(duplicates)
		t.Fatalf("the source registry names a source more than once, and the lookup map silently keeps "+
			"only the last row: %s", strings.Join(duplicates, ", "))
	}
}

// TestEveryRegistryRowIsAPinnedSource catches a row for a name the pinned matrix does not know: such a row
// is unreachable (the lookup runs only for names the matrix knows), so it is a claim that can never be
// exercised, and it would also break the 501-vs-400 distinction the route depends on.
func TestEveryRegistryRowIsAPinnedSource(t *testing.T) {
	for _, row := range pinnedChatCompletionSourceRegistry {
		if !pinnedChatCompletionSources[row.name] {
			t.Fatalf("%q has a registry row but is not in pinnedChatCompletionSources, so no request can "+
				"ever reach that row and the name is not one the pinned backend routes", row.name)
		}
	}
}

// TestEveryClaimedSourceHasARegistryRow closes the other direction: a source this package CLAIMS to
// implement must be reachable through the table, not through a leftover if-arm somewhere. The claimed list
// is the drift-prone artefact (see chat_completion_control_test.go), so the table is asserted against it
// rather than against a second hardcoded list.
func TestEveryClaimedSourceHasARegistryRow(t *testing.T) {
	byName := map[string]chatCompletionSource{}
	for _, row := range pinnedChatCompletionSourceRegistry {
		byName[row.name] = row
	}
	routeLevel := map[string]bool{}
	for _, source := range pinnedRouteLevelChatCompletionSources {
		routeLevel[source] = true
	}
	missing := make([]string, 0)
	for _, source := range pinnedClaimedChatCompletionSources {
		if _, exists := byName[source]; !exists {
			missing = append(missing, source)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		t.Fatalf("these sources are claimed as implemented but have no registry row, so a request for one "+
			"of them cannot be dispatched: %s", strings.Join(missing, ", "))
	}
	// A route-level source is dispatched BEFORE the table, so a row for one would be dead code and would
	// also contradict TestEveryRouteLevelSourceIsDispatched, which requires the plan path to answer 501.
	for source := range routeLevel {
		if _, exists := byName[source]; exists {
			t.Fatalf("%q is dispatched at route level and must NOT have a registry row: the plan path has "+
				"to keep answering 501 for it so the route-level ordering stays observable", source)
		}
	}
	// Every row is a claimed source or a route-level one; nothing else can be reached.
	for _, row := range pinnedChatCompletionSourceRegistry {
		if routeLevel[row.name] {
			continue
		}
		claimed := false
		for _, source := range pinnedClaimedChatCompletionSources {
			if source == row.name {
				claimed = true
				break
			}
		}
		if !claimed {
			t.Fatalf("%q has a registry row but is not in pinnedClaimedChatCompletionSources: move it into "+
				"that list (the invariant there then holds for it) or delete the row", row.name)
		}
	}
}

// TestEveryRoutedSourceIsVisibleToTheScan proves the scan sees the REAL routing rather than a stale or
// mis-targeted subset: every source this package implements must be reachable either through a source arm
// the scan finds or through a registry row, and the scan itself must find at least one of the two forms.
// This is what stops a rename of the discriminant from quietly narrowing the control above.
func TestEveryRoutedSourceIsVisibleToTheScan(t *testing.T) {
	arms := collectDispatchArms(t)
	routed := map[string][]string{}
	for _, arm := range arms {
		routed[arm.value] = append(routed[arm.value], arm.file+":"+strconv.Itoa(arm.line))
	}
	fromRegistry := 0
	for _, row := range pinnedChatCompletionSourceRegistry {
		if len(routed[row.name]) == 0 {
			fromRegistry++
		}
		routed[row.name] = append(routed[row.name], "registry")
	}
	for _, source := range append(append([]string{}, pinnedClaimedChatCompletionSources...), pinnedRouteLevelChatCompletionSources...) {
		if len(routed[source]) == 0 {
			t.Fatalf("%q is implemented but neither has a source arm the scan can see nor a registry row, so "+
				"the duplicate control above is blind to it; name its routing in the shape the scan recognises "+
				"(a discriminant mentioning `source` compared against a pinned source name)", source)
		}
	}
	if len(arms) == 0 && fromRegistry == 0 {
		t.Fatal("no routing was visible in either form; the scan and the registry cannot both be empty")
	}
	if len(arms) == 0 {
		t.Logf("every routed source is now a registry row (%d), which is the intended end state", fromRegistry)
	}
}
