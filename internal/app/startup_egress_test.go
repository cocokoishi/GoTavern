package app

// ZERO NON-ESSENTIAL EGRESS AT STARTUP -- THE GATE AGENTS.md RULES 24/25 AND docs/network-egress.md §3.4 ASK FOR.
//
// THE CLAIM THIS FILE MAKES MEASURABLE. "Boot is local" was, until this file, a prose claim with one
// documented exception (the docker-hostname resolution) and no observation of either half: nothing ran a real
// boot under a resolver that would report a lookup, so a future startup that added `http.Get(...)` or a
// telemetry ping would be found by a user, a firewall log or nothing at all. docs/network-egress.md §2 says so
// itself -- the transport contract measures what the provider client can do, and no gate measured what STARTUP
// does.
//
// THE SEAM, AND WHY IT IS A REAL ONE. `tests/egressguard`'s ResolverPeer is a DNS SERVER on loopback, and
// `net.DefaultResolver` is pointed at it for the duration of a case. That is the RESOLVER, not a replaced
// function name: `net.LookupIP`, `net.LookupHost`, `net.Dialer.DialContext` on a hostname and every `net/http`
// request addressed to a name must send a QUERY to be answered, so the observation does not depend on the
// startup code calling a particular symbol (AGENTS.md verification rule 14: replacing a name is not replacing a
// capability). The allow-list is explicit and DENY-BY-DEFAULT: an unlisted lookup is answered NXDOMAIN and
// recorded as a Violation naming the host, so an escape fails the run with a host name rather than passing.
//
// THE ALLOWED CASE IS ASSERTED, NOT ASSUMED. AGENTS.md rule 7: "an observed zero" and "nothing ran" must be
// distinguishable. `AssertContactedOnly` reports a MISSING LOOKUP when an allow-listed name was never resolved,
// so the docker branch cannot stop running without this file going red. And the allowed branch is driven on a
// host that is NOT a container, through the `runningInDocker` seam in server.go, because a gate whose allowed
// case can only be reached inside Docker is a gate that never runs where it is judged.
//
// WHAT THIS CANNOT SEE, stated rather than discovered later:
//   - a dial to an IP LITERAL, which sends no query. `startup_egress_source_test.go` is the declaration-level
//     second opinion for that shape, and it is labelled as a second opinion (AGENTS.md rule 54).
//   - a connection another PROCESS makes on the boot's behalf (a `git` subprocess). The boot runs no
//     subprocess today and the same source test covers the call sites.
//   - a resolver constructed by hand with its own server address (outside `net.DefaultResolver`).
//   - a TLS handshake to a literal address opened by a future startup stage: no name, no query.

import (
	"context"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/cocokoishi/gotavern/tests/egressguard"
)

// dockerHostnamesUnderTest mirrors the product's list so a change to one without the other is visible. It is
// NOT read from the product: if server.go's list grew a third name, the gate's allow-list would no longer
// match and the extra lookup would be reported as FORBIDDEN EGRESS, which is the point.
var dockerHostnamesUnderTest = []string{"host.docker.internal", "gateway.docker.internal"}

// boundedLookupCeiling is the most a boot may spend on two silenced lookups. The product's own bound is
// dockerHostLookupTimeout (2s) per name (server.go), so a compliant boot spends about 4s; the ceiling is
// generous for a slow runner and far below what an UNBOUNDED resolver does against a silent peer (measured:
// the system resolver retries at 5s per attempt per configured server, i.e. tens of seconds).
const boundedLookupCeiling = 15 * time.Second

// forceDockerBranch drives the container gate in server.go for one case. The seam exists so this is possible on
// a host that is not a container; see its comment.
func forceDockerBranch(t *testing.T, inDocker bool) {
	t.Helper()
	previous := runningInDocker
	runningInDocker = func() bool { return inDocker }
	t.Cleanup(func() { runningInDocker = previous })
}

// egressBootOptions is the documented invocation plus whatever the case needs, with the port free and the
// legacy wait made deterministic (the same shape startup_p0b_test.go uses).
func egressBootOptions(t *testing.T, root string, extra ...string) StartOptions {
	t.Helper()
	options := scenarioOptions(t, root, root)
	options.Args = append(options.Args, extra...)
	return options
}

// getThrough starts one request against a booted server and returns the status code.
func getThrough(t *testing.T, running *RunningServer, path string) int {
	t.Helper()
	listeners := running.Listeners()
	if len(listeners) == 0 {
		t.Fatal("the boot returned no listener, so no request can be made against it")
	}
	client := &http.Client{Timeout: 10 * time.Second}
	response, err := client.Get("http://" + listeners[0].Addr().String() + path)
	if err != nil {
		t.Fatalf("GET %s failed: %v", path, err)
	}
	defer func() {
		_, _ = io.Copy(io.Discard, response.Body)
		_ = response.Body.Close()
	}()
	return response.StatusCode
}

// THE ZERO-EGRESS CLAIM ITSELF: a fresh boot resolves NOTHING. The allow-list is empty, so any query at all is
// a FORBIDDEN EGRESS finding naming the host; and the resolver peer logs how many queries it saw, so a green
// proves the observation path was installed rather than that the assertion was never reached.
func TestStartupMakesNoEgressOnAFreshBoot(t *testing.T) {
	peer := egressguard.StartResolverPeer(t)
	peer.MustInstall(t)
	// The container branch is OFF, which is the state of every host that is not a container. It is forced
	// rather than probed so this case means the same thing on a CI runner and in a container.
	forceDockerBranch(t, false)

	root := t.TempDir()
	if _, err := startBounded(t, "fresh boot egress", root, egressBootOptions(t, root)); err != nil {
		t.Fatalf("a fresh boot failed while the recording resolver was installed: %v", err)
	}
	// The gate's assertion runs FIRST so an escape is reported as the named finding it is
	// (FORBIDDEN EGRESS + the host + the rule), and the explicit count below repeats it as a summary a
	// bounded CI log tail cannot swallow.
	peer.AssertContactedOnly(t) // empty allow-list: zero lookups, and zero refused
	if queries := peer.Queries(); len(queries) != 0 {
		t.Fatalf("a fresh boot resolved %d hostname(s): %v; boot is local and no lookup is allowed here "+
			"(AGENTS.md rule 25)", len(queries), queries)
	}
}

// THE ALLOWED CASE, ASSERTED RATHER THAN ASSUMED: with the docker branch active, the boot resolves EXACTLY the
// two documented hostnames and nothing else. Both halves matter -- an extra name is an escape, and a missing one
// means the allow-listed work stopped happening while the gate kept reading as green (rule 7).
func TestStartupDockerBranchResolvesExactlyTheAllowedHostnames(t *testing.T) {
	peer := egressguard.StartResolverPeer(t)
	for _, hostname := range dockerHostnamesUnderTest {
		peer.Allow(hostname)
	}
	peer.MustInstall(t)
	forceDockerBranch(t, true)

	// FIDELITY PRECONDITION, so a host whose hosts file answers these names cannot turn this into a false red:
	// Go's resolver consults the hosts file BEFORE DNS, so on such a host the product would resolve correctly
	// and this peer would see nothing. Probe once, and refuse to run rather than pass vacuously.
	probeContext, cancelProbe := context.WithTimeout(context.Background(), 5*time.Second)
	_, probeErr := net.DefaultResolver.LookupIPAddr(probeContext, dockerHostnamesUnderTest[0])
	cancelProbe()
	if probeErr != nil {
		t.Fatalf("the recording resolver could not answer an allow-listed name, so nothing below is measured: %v", probeErr)
	}
	if len(peer.Queries()) == 0 {
		t.Skipf("this host answers %q from a hosts file before DNS, so a lookup cannot be observed here; "+
			"the gate refuses to run rather than report a MISSING LOOKUP that is not the product's (rule 10)",
			dockerHostnamesUnderTest[0])
	}
	peer.Reset()

	root := t.TempDir()
	if _, err := startBounded(t, "docker branch egress", root, egressBootOptions(t, root)); err != nil {
		t.Fatalf("a boot with the docker branch active failed: %v", err)
	}
	peer.AssertContactedOnly(t, dockerHostnamesUnderTest...)
	// The assertion above is a set comparison; this one makes "they were looked up" visible in the log, so a
	// reader of a green run can see the allowed work happened.
	t.Logf("allowed lookups observed: %v", peer.ContactedNames())
	if len(peer.Violations()) != 0 {
		t.Fatalf("the allowed branch produced %d refusal(s): %v", len(peer.Violations()), peer.Violations())
	}
}

// THE EXECUTED CONSEQUENCE OF THE ALLOWED LOOKUP: the address it resolved must reach the whitelist the server
// enforces. This is the half a recorded-name assertion cannot show -- a boot that resolved the names and then
// threw the answers away would pass the egress case and be wrong here.
//
// The pair is discriminating by construction: the SAME tree refuses a loopback request when the branch is off
// (the whitelist carries only 10.9.9.9) and allows it when the branch is on (127.0.0.1 was appended). If the
// seam did not reach the boot, both legs would answer the same thing and the case fails.
func TestStartupDockerBranchWhitelistsTheAddressItResolved(t *testing.T) {
	peer := egressguard.StartResolverPeer(t)
	for _, hostname := range dockerHostnamesUnderTest {
		peer.Allow(hostname) // resolves to 127.0.0.1: the client address of every request below
	}
	peer.MustInstall(t)

	root := t.TempDir()
	// A whitelist that does NOT match loopback, and whitelist mode on, so a request from 127.0.0.1 is refused
	// unless the boot appended the address it resolved.
	if err := os.WriteFile(filepath.Join(root, "whitelist.txt"), []byte("10.9.9.9\n"), 0o644); err != nil {
		t.Fatalf("write whitelist.txt: %v", err)
	}
	baseArgs := []string{"--whitelist", "true"}

	forceDockerBranch(t, false)
	withoutBranch, err := startBounded(t, "whitelist without docker branch", root, egressBootOptions(t, root, baseArgs...))
	if err != nil {
		t.Fatalf("the boot without the docker branch failed: %v", err)
	}
	if status := getThrough(t, withoutBranch, "/version"); status != http.StatusForbidden {
		t.Fatalf("with the docker branch OFF a loopback request answered %d, want 403: the whitelist must be "+
			"live, or this case cannot discriminate", status)
	}
	closeBounded(t, withoutBranch)
	// The first boot legitimately resolved nothing (branch off); clear the recording before the second.
	peer.Reset()

	forceDockerBranch(t, true)
	withBranch, err := startBounded(t, "whitelist with docker branch", root, egressBootOptions(t, root, baseArgs...))
	if err != nil {
		t.Fatalf("the boot with the docker branch failed: %v", err)
	}
	if status := getThrough(t, withBranch, "/version"); status != http.StatusOK {
		t.Fatalf("with the docker branch ON and %q resolving to 127.0.0.1, a loopback request answered %d, "+
			"want 200: the resolved address did not reach the whitelist the server enforces (requested names: %v)",
			dockerHostnamesUnderTest[0], status, peer.ContactedNames())
	}
	peer.AssertContactedOnly(t, dockerHostnamesUnderTest...)
}

// NO HANG: a machine whose DNS server accepts the question and never answers must not hold the boot. The
// product's bound is dockerHostLookupTimeout per name; without it the system resolver retries for tens of
// seconds at this exact site (docs/startup-state-machine.md §2 W10 records it as unbounded, and
// docs/network-egress.md §3.4 requires it bounded).
func TestStartupDockerHostnameLookupIsBounded(t *testing.T) {
	peer := egressguard.StartResolverPeer(t)
	for _, hostname := range dockerHostnamesUnderTest {
		peer.Allow(hostname)
	}
	peer.Silence() // a real hanging resolver: the query arrives and is never answered
	peer.MustInstall(t)
	forceDockerBranch(t, true)

	root := t.TempDir()
	started := time.Now()
	// NOT startBounded: its 30s scenario bound would accept a hang this case exists to refuse, so the
	// measurement is the elapsed time against the product's own bound.
	server, startErr := Start(egressBootOptions(t, root))
	elapsed := time.Since(started)
	if startErr != nil {
		t.Fatalf("a failed docker-hostname lookup must NOT fail the boot (pinned's own catch warns and "+
			"continues, src/middleware/whitelist.js:47-49): %v", startErr)
	}
	defer closeBounded(t, server)
	if elapsed > boundedLookupCeiling {
		t.Fatalf("the boot spent %s on two unanswered hostname lookups (ceiling %s): the resolver call is "+
			"UNBOUNDED, which AGENTS.md rule 24 forbids and docs/network-egress.md §3.4 requires bounded",
			elapsed.Round(time.Millisecond), boundedLookupCeiling)
	}
	if len(peer.Queries()) == 0 {
		t.Fatal("the silenced resolver received no query, so the hang this case presents never happened and " +
			"the bound was not exercised (rule 19: a filter that matches nothing reports ok)")
	}
	t.Logf("two unanswered lookups cost the boot %s (bound %s per name); queries observed: %v",
		elapsed.Round(time.Millisecond), dockerHostLookupTimeout, peer.ContactedNames())
}

// closeBounded shuts a boot down with its own bound, so a shutdown that wedges fails this test instead of the
// suite.
func closeBounded(t *testing.T, running *RunningServer) {
	t.Helper()
	if running == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := running.Close(ctx); err != nil {
		t.Fatalf("closing the booted server failed: %v", err)
	}
}
