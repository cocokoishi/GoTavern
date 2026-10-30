package adversarial

import (
	"fmt"
	"os"
	"sort"
	"strings"
	"testing"
	"time"
)

// verdict is the taxonomy from AGENTS.md, differential-testing doctrine 5, cut
// down to the three states an adversary can produce. A case that cannot
// discriminate on this host is notApplicable and must say why; it is never
// counted as a pass.
type verdict int

const (
	verdictHolds verdict = iota
	verdictViolated
	verdictNotApplicable
)

type caseResult struct {
	verdict verdict
	detail  string
}

func okResult(format string, args ...any) caseResult {
	return caseResult{verdict: verdictHolds, detail: fmt.Sprintf(format, args...)}
}

func violation(format string, args ...any) caseResult {
	return caseResult{verdict: verdictViolated, detail: fmt.Sprintf(format, args...)}
}

func notApplicable(format string, args ...any) caseResult {
	return caseResult{verdict: verdictNotApplicable, detail: fmt.Sprintf(format, args...)}
}

// caseSpec is one adversary. run must not call t.Fatal or t.FailNow: it is
// executed on its own goroutine so the runner can abandon a case that never
// returns, and testing.T forbids FailNow off the test goroutine.
type caseSpec struct {
	id        string
	checklist string
	invariant string
	bound     time.Duration
	run       func() caseResult
}

// defaultBound is generous for a temp tree (the startup cases copy the embedded
// default content) and short enough that a wedged case cannot consume a runner.
const defaultBound = 60 * time.Second

// checklistItems is the task's checklist. The coverage test requires every item
// to be exercised by at least one case and every case to name a listed item, so
// a checklist entry cannot be dropped silently in either direction.
var checklistItems = map[string]string{
	"bad.yaml":                 "bad YAML",
	"truncated.yaml":           "truncated YAML",
	"autoupdate.null":          "config with autoUpdate: null / unparseable",
	"autoupdate.inherited":     "stock config saying autoUpdate: true (ARCHITECTURE 34.3)",
	"legacy.only":              "legacy-only config",
	"config.readonly":          "config owned by another user / read-only directory; parseable config rewritten",
	"config.readonly.file":     "read-only config FILE (the shape Windows enforces), on any host",
	"data.malformed":           "malformed user data at boot (secrets.json, node-persist record) must be reported and left byte-identical",
	"install.readonly":         "read-only install root",
	"config.parent-missing":    "config whose parent directory does not exist",
	"data-root.parent-missing": "data root whose parent directory does not exist",
	"lock.stale":               "stale lock file",
	"boot.concurrent":          "two concurrent boots",
	"boot.data-lock-held":      "second boot while the first holds a data-startup lock",
	"boot.legacy-cost":         "legacy migration cost before the listener",
	"port.bound":               "port already bound",
	"public.missing":           "missing public/**",
	"tokenizers.missing":       "missing tokenizers/**",
	"cwd.foreign":              "foreign CWD (absolute and relative data root)",
	"home.missing":             "$HOME pointing at a directory that does not exist",
	"proxy.connect":            "proxy that rejects CONNECT",
	"tls.expired":              "TLS server with an expired certificate",
	"sse.midsclose":            "provider that closes mid-SSE",
	"html.200":                 "provider that returns 200 with an HTML body",
	"apikey.nonascii":          "API key with non-ASCII characters / CRLF",
	"transport.gzip":           "compressing provider (the advertised accept-encoding)",
	"transport.redirect":       "provider that redirects",
}

func allCases(t *testing.T) []caseSpec {
	t.Helper()
	cases := make([]caseSpec, 0, 36)
	cases = append(cases, configCases(t)...)
	cases = append(cases, startupCases(t)...)
	cases = append(cases, hardeningCases(t)...)
	cases = append(cases, transportCases(t)...)
	cases = append(cases, extensionsCases(t)...)
	return cases
}

// runBounded executes one case and converts a non-returning case into a
// violation, which is what rule 24 means by "every wait has a named error and a
// bound": a wait with no bound is a defect even when it would eventually finish.
func runBounded(spec caseSpec) caseResult {
	bound := spec.bound
	if bound <= 0 {
		bound = defaultBound
	}
	results := make(chan caseResult, 1)
	go func() {
		defer func() {
			if recovered := recover(); recovered != nil {
				results <- violation("the case panicked: %v", recovered)
			}
		}()
		results <- spec.run()
	}()
	select {
	case result := <-results:
		return result
	case <-time.After(bound):
		return violation("no result after %s: the invariant's wait has no bound (rule 24)", bound)
	}
}

func readGolden(t *testing.T) map[string]bool {
	t.Helper()
	raw, err := os.ReadFile("violations.golden")
	if err != nil {
		t.Fatalf("read violations.golden: %v (the ratchet needs the recorded violation list)", err)
	}
	golden := map[string]bool{}
	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		golden[line] = true
	}
	return golden
}

// compareGolden is the ratchet itself. It is pure so its teeth can be
// demonstrated without touching the product (see TestRatchetComparatorHasTeeth).
func compareGolden(golden map[string]bool, observed map[string]string, known map[string]bool) []string {
	var problems []string
	ids := make([]string, 0, len(observed)+len(golden))
	seen := map[string]bool{}
	for id := range observed {
		ids = append(ids, id)
		seen[id] = true
	}
	for id := range golden {
		if !seen[id] {
			ids = append(ids, id)
		}
	}
	sort.Strings(ids)
	for _, id := range ids {
		detail, isViolated := observed[id]
		switch {
		case isViolated && !golden[id]:
			problems = append(problems, fmt.Sprintf("NEW VIOLATION %s: %s", id, detail))
		case !isViolated && golden[id]:
			if !known[id] {
				problems = append(problems, fmt.Sprintf("UNKNOWN ID %s is in violations.golden but no case produces it", id))
				continue
			}
			problems = append(problems, fmt.Sprintf("STALE GOLDEN ENTRY %s: the invariant now holds; delete the line so the fix is recorded", id))
		}
	}
	return problems
}

// TestAdversarialInvariants runs every adversary and ratchets the verdicts
// against violations.golden. A violation that matches the golden file is
// printed with its reproducer and keeps the run green; anything else is red.
func TestAdversarialInvariants(t *testing.T) {
	specs := allCases(t)
	if len(specs) == 0 {
		t.Fatal("no adversarial cases were registered; this test cannot fail, so it proves nothing")
	}
	known := make(map[string]bool, len(specs))
	observed := map[string]string{}
	notApplicableCount := 0
	// ONLY the verdicts that need a human are logged, and each on one line: the
	// lane workflow prints `head -20` of the assertion lines, so a per-case
	// "holds" line for every case pushed the ratchet message out of view and a
	// red run could not name its cause. Run with GOTAVERN_ADVERSARIAL_VERBOSE=1
	// to see every verdict.
	verbose := os.Getenv("GOTAVERN_ADVERSARIAL_VERBOSE") != ""
	for _, spec := range specs {
		known[spec.id] = true
		result := runBounded(spec)
		switch result.verdict {
		case verdictHolds:
			if verbose {
				t.Logf("holds     %-42s %s", spec.id, firstLine(result.detail))
			}
		case verdictViolated:
			observed[spec.id] = result.detail
			t.Logf("VIOLATED  %-42s invariant: %s; observed: %s", spec.id, spec.invariant, firstLine(result.detail))
		case verdictNotApplicable:
			notApplicableCount++
			t.Logf("n/a        %-42s %s", spec.id, result.detail)
		}
	}
	golden := readGolden(t)
	problems := compareGolden(golden, observed, known)
	t.Logf("ratchet: %d cases, %d held, %d violated, %d not applicable, %d golden entries",
		len(specs), len(specs)-len(observed)-notApplicableCount, len(observed), notApplicableCount, len(golden))
	if len(problems) > 0 {
		// ONE line, so a bounded head cannot swallow the cause.
		t.Fatalf("%s", strings.Join(problems, " | "))
	}
}

func firstLine(text string) string {
	if index := strings.IndexByte(text, '\n'); index >= 0 {
		return text[:index] + " ..."
	}
	return text
}

// TestCaseRegistryCoversEveryChecklistItem is the coverage guard: every checklist
// entry has at least one adversary, every adversary names a checklist entry, and
// the ids are unique. Without this, deleting a case would silently shrink the
// checklist instead of failing.
func TestCaseRegistryCoversEveryChecklistItem(t *testing.T) {
	specs := allCases(t)
	ids := map[string]bool{}
	covered := map[string]int{}
	for _, spec := range specs {
		if spec.id == "" || spec.invariant == "" {
			t.Fatalf("a case has no id or no invariant: %+v", spec)
		}
		if ids[spec.id] {
			t.Fatalf("duplicate case id %q; the ratchet keys on the id, so two cases would hide each other", spec.id)
		}
		ids[spec.id] = true
		if _, listed := checklistItems[spec.checklist]; !listed {
			t.Fatalf("case %q names checklist item %q, which is not in checklistItems", spec.id, spec.checklist)
		}
		covered[spec.checklist]++
	}
	for key := range checklistItems {
		if covered[key] == 0 {
			t.Fatalf("checklist item %q (%s) has no adversarial case", key, checklistItems[key])
		}
	}
	t.Logf("%d cases cover all %d checklist items", len(specs), len(checklistItems))
}

// TestRatchetComparatorHasTeeth proves the ratchet can go red in both
// directions, so a green run of TestAdversarialInvariants is evidence and not
// decoration (rule 7 / rule 19: a check that cannot fail is worse than none).
func TestRatchetComparatorHasTeeth(t *testing.T) {
	known := map[string]bool{"a": true, "b": true}
	// A new violation must be reported.
	if problems := compareGolden(map[string]bool{}, map[string]string{"a": "detail"}, known); len(problems) != 1 ||
		!strings.Contains(problems[0], "NEW VIOLATION a") {
		t.Fatalf("the comparator did not report a new violation: %v", problems)
	}
	// A fixed invariant must be reported as a stale golden entry.
	if problems := compareGolden(map[string]bool{"b": true}, map[string]string{}, known); len(problems) != 1 ||
		!strings.Contains(problems[0], "STALE GOLDEN ENTRY b") {
		t.Fatalf("the comparator did not report a stale golden entry: %v", problems)
	}
	// An exact match must be silent.
	if problems := compareGolden(map[string]bool{"a": true}, map[string]string{"a": "detail"}, known); len(problems) != 0 {
		t.Fatalf("the comparator reported a problem for a matching set: %v", problems)
	}
	// An id in the golden file that no case produces must be reported, not ignored.
	if problems := compareGolden(map[string]bool{"ghost": true}, map[string]string{}, known); len(problems) != 1 ||
		!strings.Contains(problems[0], "UNKNOWN ID ghost") {
		t.Fatalf("the comparator did not report an unknown golden id: %v", problems)
	}
}

// TestBoundedRunnerReportsAWedge proves the runner itself turns a non-returning
// case into a violation, using a case that deliberately never returns within its
// bound and then finishes (so the leak is bounded).
func TestBoundedRunnerReportsAWedge(t *testing.T) {
	release := make(chan struct{})
	spec := caseSpec{
		id:        "self.wedge",
		checklist: "lock.stale",
		invariant: "a case that never returns must be reported as an unbounded wait",
		bound:     100 * time.Millisecond,
		run: func() caseResult {
			<-release
			return okResult("returned after the bound")
		},
	}
	result := runBounded(spec)
	close(release)
	if result.verdict != verdictViolated || !strings.Contains(result.detail, "no result after") {
		t.Fatalf("the runner did not report the wedged case: %+v", result)
	}
}
