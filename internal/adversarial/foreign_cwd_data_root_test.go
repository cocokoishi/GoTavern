package adversarial

// REGRESSION TESTS FOR GOTAVERN LANE CI RUN 42162940621 (commit a964c31).
//
// That run failed on a DOCS-ONLY commit (a964c31) with:
//
//	NEW VIOLATION boot.foreign-cwd-relative-data-root: the failure does not name
//	the data root: Error: Startup aborted because IPv4 is the only enabled
//	protocol and its listen port is already in use
//
// The same tree passed Lane CI one commit later (42163485576 at 5f37a8d), so the
// cause was a race, not the product. support_test.go's freePort used to reserve
// an ephemeral port at suite start and close it; `go test ./...` runs package
// test binaries in parallel, so another package could take the port before this
// case's boot bound it. The case's failure branch then classified a LISTENER
// PRECONDITION as a product violation -- a driver that never reached the subject
// blaming the subject (AGENTS verification rule 10), and the "same code passed
// one commit later" evidence that made it a flake rather than a finding.
//
// The fix has two halves, and each has a test here:
//  1. the port is now requested from the kernel at BIND time (port 0), so there
//     is no reservation window to lose (support_test.go freePort);
//  2. if a listener precondition still fails for any host reason, the case
//     judges the created/used data-root split it can STILL observe on disk
//     (data startup runs before the listeners), and only then refuses to turn
//     the harness's port into a product verdict
//     (startup_cases_test.go judgeRelativeDataRootFailure).
//
// Neither half may weaken the ratchet: a genuine data-root split, or a failure
// that does not name the data root, must still be a NEW VIOLATION.

import (
	"errors"
	"net"
	"strings"
	"testing"
)

// caseByID finds a registered case, and fails rather than making the regression
// test vacuous when the id disappears.
func caseByID(t *testing.T, specs []caseSpec, id string) caseSpec {
	t.Helper()
	for _, spec := range specs {
		if spec.id == id {
			return spec
		}
	}
	t.Fatalf("case %q is not registered: this regression test would prove nothing", id)
	return caseSpec{}
}

// heldLoopbackPort binds a real loopback socket and returns its port. The
// listener stays open until the test ends, so the port really is unavailable to
// anything that tries to bind it -- the precondition is established, not assumed.
func heldLoopbackPort(t *testing.T) int {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("hold a loopback port: %v", err)
	}
	t.Cleanup(func() { _ = listener.Close() })
	return listener.Addr().(*net.TCPAddr).Port
}

// TestForeignCWDRelativeDataRootListenerCollisionIsHarnessNotProduct is the
// deterministic reproduction: a real held socket, the case's own boot path, and
// the old classification would report a product VIOLATION (verified red before
// the fix). After the fix the case must answer notApplicable and say why.
func TestForeignCWDRelativeDataRootListenerCollisionIsHarnessNotProduct(t *testing.T) {
	heldPort := heldLoopbackPort(t)
	previous := freePort
	freePort = func(t *testing.T) int {
		t.Helper()
		return heldPort
	}
	t.Cleanup(func() { freePort = previous })

	spec := caseByID(t, startupCases(t), "boot.foreign-cwd-relative-data-root")
	result := runBounded(spec)
	t.Logf("forced listener collision: verdict=%d detail=%s", result.verdict, result.detail)

	if result.verdict == verdictViolated {
		t.Fatalf("a held port was reported as a product violation (AGENTS rule 10: the driver never reached the subject): %s", result.detail)
	}
	if result.verdict != verdictNotApplicable {
		t.Fatalf("a forced listener collision produced verdict %d (%s); want notApplicable with the precondition named", result.verdict, result.detail)
	}
	lower := strings.ToLower(result.detail)
	if !strings.Contains(lower, "port") && !strings.Contains(lower, "listen") {
		t.Fatalf("the notApplicable detail does not name the listener precondition: %s", result.detail)
	}
	if !strings.Contains(lower, "split") {
		t.Fatalf("the notApplicable detail does not say the data-root split was still judged: %s", result.detail)
	}
}

// TestRelativeDataRootClassifierStillReportsGenuineViolations proves the
// downgrade cannot swallow the invariant: each row below is a verdict the case
// must still produce, with a listener-precondition error present where it must
// NOT excuse an observed split.
func TestRelativeDataRootClassifierStillReportsGenuineViolations(t *testing.T) {
	listenerErr := errors.New("Error: Startup aborted because IPv4 is the only enabled protocol and its listen port is already in use.")
	unnamedErr := errors.New("initialize user storage: unexpected end of JSON input")
	namedErr := errors.New("initialize pinned server data: create data directory: permission denied")

	cases := []struct {
		name           string
		created        bool
		used           bool
		markerSurvived bool
		startErr       error
		want           verdict
	}{
		{
			name:    "a split observed on disk is still a violation even when the port was taken",
			created: true, used: false, markerSurvived: true, startErr: listenerErr,
			want: verdictViolated,
		},
		{
			name:    "both renderings observed on disk are still a violation even when the port was taken",
			created: true, used: true, markerSurvived: true, startErr: listenerErr,
			want: verdictViolated,
		},
		{
			name:    "a failure that does not name the data root is still a violation",
			created: false, used: true, markerSurvived: true, startErr: unnamedErr,
			want: verdictViolated,
		},
		{
			name:    "a listener precondition with no rendering at all cannot excuse the unexercised input",
			created: false, used: false, markerSurvived: true, startErr: listenerErr,
			want: verdictViolated,
		},
		{
			name:    "a listener precondition with the planted config gone cannot excuse the input",
			created: false, used: true, markerSurvived: false, startErr: listenerErr,
			want: verdictViolated,
		},
		{
			name:    "a non-listener failure that names the data root keeps its original refusal verdict",
			created: false, used: true, markerSurvived: true, startErr: namedErr,
			want: verdictHolds,
		},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			result := judgeRelativeDataRootFailure(
				"/work/relative-marker-data",
				"/install/relative-marker-data",
				testCase.created, testCase.used, testCase.markerSurvived, testCase.startErr,
			)
			if result.verdict != testCase.want {
				t.Fatalf("judgeRelativeDataRootFailure(created=%t used=%t marker=%t err=%v) = verdict %d (%s), want %d",
					testCase.created, testCase.used, testCase.markerSurvived, testCase.startErr,
					result.verdict, result.detail, testCase.want)
			}
		})
	}
}

// TestRelativeDataRootListenerCollisionWithASplitIsStillRed drives the ratchet
// itself: a genuine split judged under the forced listener precondition must
// reach compareGolden as a NEW VIOLATION. This is the "do not weaken the
// ratchet" half of the fix, asserted through the same comparator the suite uses.
func TestRelativeDataRootListenerCollisionWithASplitIsStillRed(t *testing.T) {
	id := "boot.foreign-cwd-relative-data-root"
	listenerErr := errors.New("Error: Startup aborted because IPv4 is the only enabled protocol and its listen port is already in use.")
	result := judgeRelativeDataRootFailure(
		"/work/relative-marker-data",
		"/install/relative-marker-data",
		true, false, true, listenerErr,
	)
	if result.verdict != verdictViolated {
		t.Fatalf("a split under a listener precondition was not a violation: verdict %d (%s)", result.verdict, result.detail)
	}
	problems := compareGolden(
		map[string]bool{},
		map[string]string{id: result.detail},
		map[string]bool{id: true},
	)
	if len(problems) != 1 || !strings.Contains(problems[0], "NEW VIOLATION "+id) {
		t.Fatalf("the ratchet did not report the genuine split as a NEW VIOLATION: %v", problems)
	}
	// Printed so the evidence names the exact line the suite would fail with.
	t.Logf("ratchet verdict for a genuine split under a listener collision: %s", problems[0])
}

// TestRelativeDataRootCaseStillReachesItsAssertions is the counterpart the fix
// must not lose: with the normal (ephemeral, kernel-assigned) port the case
// still boots far enough to judge the data-root split, so the downgrade is not
// hiding a case that never runs.
func TestRelativeDataRootCaseStillReachesItsAssertions(t *testing.T) {
	spec := caseByID(t, startupCases(t), "boot.foreign-cwd-relative-data-root")
	result := runBounded(spec)
	t.Logf("normal run: verdict=%d detail=%s", result.verdict, result.detail)
	if result.verdict != verdictHolds {
		t.Fatalf("the relative-data-root case stopped judging its invariant on the normal path: verdict %d (%s)", result.verdict, result.detail)
	}
}

// TestCasePortsAreKernelAssigned pins the structural half: every case port is
// port 0, so no package can race this one for a reserved number. If this test
// fails, freePort has been changed back into a reservation and the Lane CI flake
// is possible again.
func TestCasePortsAreKernelAssigned(t *testing.T) {
	if port := freePort(t); port != 0 {
		t.Fatalf("freePort(t) = %d; want 0 so the kernel assigns the port at bind time (Lane CI 42162940621 was a reservation race)", port)
	}
}
