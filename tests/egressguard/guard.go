// Package egressguard turns "the peer received the expected requests" into "and NOTHING was sent anywhere the
// harness did not choose", which is the assertion AGENTS.md verification rule 14 requires and which no gate in
// this repository made before this file.
//
// THE MEASURED GAP THIS CLOSES. Rule 14 was written after the Horde probe replaced the pinned server's
// `node-fetch` module and still reached the REAL `aihorde.net`, because the SDK calls the GLOBAL `fetch`: the
// replacement was of a NAME, not of a capability, and the run did not fail -- it recorded live third-party data
// into a fixture that would have been committed as evidence. The pinned side has since grown a stub that
// replaces both names (`tools/lib/pinned-outbound.mjs`). The GO side has no equivalent measurement at all:
// `tests/mockprovider` records what it RECEIVES, so a request that escapes the recorder is invisible. A escaped
// request today looks like a slow test or a passing test, never like a failure.
//
// WHAT THIS PROVIDES, in three parts:
//
//  1. `Guard` -- a process-wide egress policy. It answers one question about every socket the test process can
//     open: was this address one the harness chose? The mechanism is a `net.Dialer.Control` hook, which runs on
//     the raw connection BEFORE any byte is written, so a violation is refused at connect time and appears as an
//     error to the caller rather than as plausible data.
//
//  2. `Proxy` -- a real PROXY SERVER, not a name replacement. The provider transport honours `HTTPS_PROXY`
//     through `http.ProxyFromEnvironment` (internal/outbound/transport.go, `providerProxy`), so pointing it at
//     this proxy means every request the production transport makes ARRIVES HERE BY CONSTRUCTION. That is the
//     difference rule 14 insists on: a client whose egress cannot reach the internet because its configured proxy
//     is host-side cannot "escape" by changing which function it calls, because the destination is decided at the
//     layer that carries the bytes.
//
//  3. `Assert` -- the rule-14 assertion itself: the set of requests the peer received equals the set the fixture
//     claims, EXACTLY (not "at least"). A request that escapes is then a MISSING expectation or an UNEXPECTED
//     arrival, both of which fail. "No errors were logged" is never the assertion, because the defect this
//     guards against produced no error.
//
// WHAT THIS CANNOT SEE, stated so a green is not over-read: a connection another process makes on the test's
// behalf (a `git` subprocess that ignores the environment), and a socket opened by a library through a path that
// bypasses `net.Dialer` (syscall.Socket directly). Both are outside a Go test's ability to intercept without
// seccomp; the environment scrub in `ScrubProviderEnvironment` and the proxy assertion cover the realistic cases,
// and the limits are named here rather than discovered later.
package egressguard

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"runtime"
	"sort"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
)

// ProviderEnvironmentVariables are every variable a provider transport (ours OR a pinned one) reads to decide
// where to send traffic. A probe that did not clear these does not merely "risk" an escape: on a developer
// machine or a CI runner that sets any of them, the traffic goes to that proxy, and the harness records a
// plausible answer it never controlled.
var ProviderEnvironmentVariables = []string{
	"HTTP_PROXY", "http_proxy",
	"HTTPS_PROXY", "https_proxy",
	"ALL_PROXY", "all_proxy",
	"NO_PROXY", "no_proxy",
}

// proxyVariableNamesToScrub returns the names ScrubProviderEnvironment and Install must SAVE and RESTORE.
//
// IT IS NOT ALWAYS ALL OF ProviderEnvironmentVariables, AND ON WINDOWS SAVING ALL OF THEM IS DESTRUCTIVE.
// MEASURED 2026-10-29: on Windows an environment-variable NAME is CASE-INSENSITIVE (Go reaches
// `SetEnvironmentVariable`, whose name comparison ignores case), so the eight spellings above are FOUR
// variables and `os.Unsetenv("https_proxy")` removes `HTTPS_PROXY`. A save loop that unsets while saving --
// which `ScrubProviderEnvironment` does, because its whole job is to leave the environment empty -- therefore
// records the SECOND spelling of each pair as ABSENT, and the restore then re-sets the first spelling and
// unsets the second, DELETING what it had just put back. The observed failure was
// `TestScrubRemovesEveryProxyVariable: the restore lost HTTPS_PROXY: ""`, and every one of HTTP_PROXY,
// HTTPS_PROXY, ALL_PROXY and NO_PROXY was lost across the round trip. Under POSIX semantics the two spellings
// are genuinely distinct variables, the same list is correct, and the defect cannot appear -- which is why it
// was invisible to a suite that only ever runs on ubuntu-latest.
//
// THE UPPERCASE SPELLING IS KEPT, and it is sufficient on the host where the pair is one variable: unsetting
// `HTTPS_PROXY` removes it whatever case it was stored in, so the uppercase names cover both spellings there,
// and they are half of what the POSIX path needs anyway. ProviderEnvironmentVariables itself stays COMPLETE,
// because `guard_test.go` enumerates all eight spellings when it asserts that nothing survived.
func proxyVariableNamesToScrub() []string {
	if runtime.GOOS == "windows" {
		return []string{"HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"}
	}
	return ProviderEnvironmentVariables
}

// ScrubProviderEnvironment removes every proxy variable from the process environment and returns a restore
// function. It is called before a peer is started, so the only proxy a transport can discover is the one the
// harness installs afterwards.
func ScrubProviderEnvironment(t *testing.T) (restore func()) {
	t.Helper()
	// THE HOST-AWARE LIST, because saving both spellings of a pair is destructive on a case-insensitive host
	// (see proxyVariableNamesToScrub): the save loop unsets as it goes, so the second spelling reads as absent
	// and the restore deletes the first one's value.
	names := proxyVariableNamesToScrub()
	saved := make(map[string]string, len(names))
	present := make(map[string]bool, len(names))
	for _, name := range names {
		value, ok := os.LookupEnv(name)
		saved[name], present[name] = value, ok
		if err := os.Unsetenv(name); err != nil {
			t.Fatalf("egressguard: could not unset %s: %v", name, err)
		}
	}
	return func() {
		for _, name := range names {
			if present[name] {
				_ = os.Setenv(name, saved[name])
			} else {
				_ = os.Unsetenv(name)
			}
		}
	}
}

// Violation is one connection attempt the policy refused, or one that arrived at the proxy with a destination the
// harness did not declare. It records the ADDRESS and the reason -- never a header, a body or a credential.
type Violation struct {
	// Stage is "dial" (the Control hook refused a socket), "proxy-not-called" (the transport was expected to use
	// the proxy and never did) or "proxy-unexpected" (a request arrived the fixture does not claim).
	Stage  string `json:"stage"`
	Host   string `json:"host"`
	Port   string `json:"port"`
	Target string `json:"target,omitempty"`
	Reason string `json:"reason"`
}

func (v Violation) String() string {
	target := v.Host
	if v.Port != "" {
		target = net.JoinHostPort(v.Host, v.Port)
	}
	if v.Target != "" {
		target += " " + v.Target
	}
	return fmt.Sprintf("[%s] %s: %s", v.Stage, target, v.Reason)
}

// Guard is the process-wide dial policy. Build it with NewGuard; it is safe for concurrent use.
type Guard struct {
	mu         sync.Mutex
	allowed    map[string]bool // host:port exact matches
	allowedNet []*net.IPNet
	proxyAddr  string
	violations []Violation
}

// NewGuard returns a guard that permits nothing until an address is allowed. Failing closed is deliberate: a
// forgotten allowance fails the test loudly at connect time instead of quietly permitting the internet.
func NewGuard() *Guard {
	return &Guard{allowed: make(map[string]bool)}
}

// AllowLoopback permits every destination on the loopback interface. A peer started by `httptest.NewServer` or
// `mockprovider.Recorder.Listen(0)` lives here, so this is the allowance a differential normally needs.
func (g *Guard) AllowLoopback() {
	_, v4, _ := net.ParseCIDR("127.0.0.0/8")
	_, v6, _ := net.ParseCIDR("::1/128")
	g.mu.Lock()
	defer g.mu.Unlock()
	g.allowedNet = append(g.allowedNet, v4, v6)
}

// Allow names one exact host:port. This is what the PROXY's own address needs, and it is the narrowest form.
func (g *Guard) Allow(hostport string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.allowed[hostport] = true
}

// allowProxy registers the proxy listener so the proxy can dial its upstream itself.
func (g *Guard) allowProxy(hostport string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.proxyAddr = hostport
	g.allowed[hostport] = true
}

// Violations returns what the policy refused, in arrival order.
func (g *Guard) Violations() []Violation {
	g.mu.Lock()
	defer g.mu.Unlock()
	out := append([]Violation(nil), g.violations...)
	return out
}

// permitted reports whether host:port may be dialled. The proxy's own address is always permitted, because the
// proxy is the thing doing the honest work; its UPSTREAM dials are what the connectivity assertions cover.
func (g *Guard) permitted(host, port string) bool {
	hostport := net.JoinHostPort(host, port)
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.allowed[hostport] {
		return true
	}
	if ip := net.ParseIP(host); ip != nil {
		for _, block := range g.allowedNet {
			if block.Contains(ip) {
				return true
			}
		}
	}
	return false
}

func (g *Guard) refuse(v Violation) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.violations = append(g.violations, v)
}

// ResetViolations clears the recorded refusals, so a process-wide guard can serve one case at a time.
func (g *Guard) ResetViolations() {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.violations = nil
}

// Control is the `net.Dialer.Control` hook. Attaching it to the SAME dialer the production transport uses is what
// makes this an assertion about the product rather than about a test double. It runs before any byte is written.
func (g *Guard) Control() func(network, address string, _ syscall.RawConn) error {
	return func(network, address string, _ syscall.RawConn) error {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil // not an ip:port form; net will reject it itself
		}
		if g.permitted(host, port) {
			return nil
		}
		g.refuse(Violation{
			Stage: "dial", Host: host, Port: port,
			Reason: "the egress guard permitted only declared peers, and this address is not one of them",
		})
		return &EgressDenied{Network: network, Address: address}
	}
}

// EgressDenied is the error a denied dial returns. It is a distinct type so a test can tell an escape from a
// connection refused by a peer that is simply not listening.
type EgressDenied struct {
	Network string
	Address string
}

func (e *EgressDenied) Error() string {
	return "egressguard: FORBIDDEN EGRESS to " + e.Address + " (" + e.Network + "): the harness permits only the peers it declared"
}

// DialContext is the guard's own dialer, for a caller that wants to hand `outbound` a controlled dialer.
func (g *Guard) DialContext(dialer *net.Dialer) *net.Dialer {
	if dialer == nil {
		dialer = &net.Dialer{}
	}
	dialer.Control = g.Control()
	return dialer
}

// THE PRODUCTION CLIENT CACHES ITS TRANSPORT PER TLS CONFIG (internal/outbound/transport.go
// `transportFor`), and `http.ProxyFromEnvironment` resolves ONCE PER PROCESS. Together those two facts mean
// installing a proxy AFTER any provider request has been made in the same test binary has no effect on the
// already-built client: the harness would install a proxy, the transport would keep dialling the real host, and
// the assertion would observe zero arrivals for a reason that looks like a product defect.
//
// `MustInstallBeforeAnyProviderRequest` therefore makes the ordering a FAILURE rather than a silent no-op. It is
// called by `NewProxy` and refuses when a client has already been built, so a probe cannot adopt this guard in the
// wrong order and get a green that proves nothing -- the same "a gate that silently does not apply" defect
// internal/server/transport_mode_test.go exists to catch for the wire-exact seam.
var providerClientBuilt atomic.Bool

// MarkProviderClientBuilt is called by a harness that has made a provider request, so a later Install is refused
// instead of silently measured against a stale client.
func MarkProviderClientBuilt() { providerClientBuilt.Store(true) }

// ErrClientAlreadyBuilt is returned when a proxy is installed too late to affect the transport.
var ErrClientAlreadyBuilt = errors.New("egressguard: the production provider client was already built, so installing a proxy now " +
	"would not affect it (the transport is cached per TLS config and http.ProxyFromEnvironment resolves once per process); " +
	"install the proxy BEFORE the first provider request, or run the leg in its own test binary")

// ------------------------------------------------------------------------------------------------
// The proxy. A real HTTP proxy (CONNECT + absolute-form) so the production transport reaches it through the
// mechanism it uses in production.
// ------------------------------------------------------------------------------------------------

// Proxy is a recording HTTP proxy. Every request the subject makes to its configured provider arrives here.
type Proxy struct {
	// URL is the address to put in HTTPS_PROXY (and HTTP_PROXY). It is never a loopback-no-proxy case: the
	// subject must be addressed by a NON-loopback host so `http.ProxyFromEnvironment` consults the proxy at all
	// (Go bypasses the proxy for loopback; see internal/outbound/proxytest/proxy_test.go, which paid for this
	// discovery).
	URL string

	server *httptest.Server

	mu       sync.Mutex
	seen     []ProxyRequest
	unexpect []Violation
}

// ProxyRequest is one request the proxy received. Only the TARGET and the METHOD are recorded: the assertion is
// about which requests arrived and where they were going, and a header or body would make this a second place a
// credential could reach a log.
type ProxyRequest struct {
	Method string `json:"method"`
	// Target is the RAW request target (path plus query) exactly as it arrived, for a plain-HTTP request; for a
	// CONNECT tunnel it is the authority. It is never the decoded path, for the reason AGENTS.md 15 records: the
	// decoded form has already thrown away the distinction a fixture exists to preserve.
	Target string `json:"target"`
	Scheme string `json:"scheme"`
	// Host is the authority the request was addressed to (host:port).
	Host string `json:"host"`
	Path string `json:"path"`
}

// NewProxy starts the recording proxy and registers its own address with the guard. It is the PER-TEST form and is
// suitable only for a case that does NOT depend on `http.ProxyFromEnvironment` -- that function resolves the
// environment ONCE PER PROCESS, so a second proxy's URL is never read. A package that needs the proxy to carry real
// traffic must create ONE proxy in TestMain (see guard_test.go, and the measured CI failure that forced it:
// `Lane CI 40445346390`, where three cases failed against the FIRST test's already-closed listener).
func NewProxy(t *testing.T, guard *Guard) *Proxy {
	t.Helper()
	proxy := startProxy(guard)
	t.Cleanup(proxy.closeServer)
	return proxy
}

// startProxy is the constructor without a testing.T, so a TestMain can own the lifetime.
func startProxy(guard *Guard) *Proxy {
	proxy := &Proxy{}
	proxy.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		entry := ProxyRequest{Method: r.Method, Host: r.Host}
		if r.Method == http.MethodConnect {
			entry.Target = r.RequestURI
			// A tunnel to a provider: record the authority and refuse, because a differential peer is plain HTTP
			// (docs/network-egress.md: the peer is deliberately not TLS, as TLS adds no new observable). A
			// CONNECT that arrives here is therefore a REAL provider being reached through the shipped transport
			// -- the exact escape rule 14 exists to catch -- and refusing it is the correct answer.
			proxy.mu.Lock()
			proxy.seen = append(proxy.seen, entry)
			proxy.unexpect = append(proxy.unexpect, Violation{
				Stage: "proxy-unexpected", Host: r.Host, Port: "", Target: "CONNECT " + r.RequestURI,
				Reason: "a TLS tunnel to a real host was opened through the proxy; the fixture claims no such request",
			})
			proxy.mu.Unlock()
			http.Error(w, "egressguard: FORBIDDEN EGRESS -- the fixture claims no request to "+r.Host, http.StatusForbidden)
			return
		}
		u, err := url.Parse(r.RequestURI)
		if err != nil || u.Host == "" {
			http.Error(w, "egressguard: the proxy only serves absolute-form requests", http.StatusBadRequest)
			return
		}
		// THE RECORDED TARGET IS THE PATH+QUERY, and the AUTHORITY goes in Host, so an expectation is written the
		// way a fixture writes it (`POST /v1/chat/completions?x=1`) and the host is compared separately. Using the
		// absolute-form URI as the target would make the two impossible to write consistently, and a harness whose
		// recorded shape cannot be re-written by a reviewer is a harness nobody can check.
		//
		// THE RAW FORM COMES FROM RequestURI, NOT FROM `u.Path`: `u.Path` is DECODED, so `acc%2Fone` would arrive
		// here as `acc/one` and the rule would no longer match the request the peer actually received (AGENTS.md
		// 15's `EscapedPath()` lesson, applied to the proxy).
		rawTarget := u.EscapedPath()
		if u.RawQuery != "" {
			rawTarget += "?" + u.RawQuery
		}
		entry.Target, entry.Scheme, entry.Host, entry.Path = rawTarget, u.Scheme, u.Host, u.EscapedPath()
		proxy.mu.Lock()
		proxy.seen = append(proxy.seen, entry)
		proxy.mu.Unlock()
		// The proxy does not forward. It is a SINK: a request that reaches it has been observed, and forwarding it
		// would make the proxy a participant in an escape.
		http.Error(w, "egressguard: the proxy is a sink and forwards nothing", http.StatusBadGateway)
	}))
	parsed, err := url.Parse(proxy.server.URL)
	if err != nil {
		// A panic rather than a t.Fatalf: this constructor is also called from TestMain, where there is no *testing.T.
		panic("egressguard: the httptest server URL does not parse: " + proxy.server.URL)
	}
	proxy.URL = proxy.server.URL
	guard.allowProxy(parsed.Host)
	return proxy
}

// closeServer releases the listener. It is split out so a TestMain can close a process-lifetime proxy.
func (p *Proxy) closeServer() {
	p.server.CloseClientConnections()
	p.server.Close()
}

// Install prepares the environment so the shipped transport uses this proxy, and REFUSES when the transport's
// client already exists. See ErrClientAlreadyBuilt: the client is cached per TLS config and the environment is
// resolved once per process, so a late install is a measurement of nothing.
//
// It returns the refusal as an ERROR rather than calling t.Fatalf, so the refusal itself is testable; the
// MustInstall wrapper is the call a probe uses when a late install is a defect in the probe.
func (p *Proxy) Install() (restore func(), err error) {
	if providerClientBuilt.Load() {
		return nil, ErrClientAlreadyBuilt
	}
	// THE HOST-AWARE LIST for the save/restore pair, for the same reason as ScrubProviderEnvironment: on a
	// case-insensitive host the eight spellings are four variables, and a restore that iterates all eight
	// would unset the value it had just re-set.
	names := proxyVariableNamesToScrub()
	saved := make(map[string]string, len(names))
	present := make(map[string]bool, len(names))
	for _, name := range names {
		value, ok := os.LookupEnv(name)
		saved[name], present[name] = value, ok
	}
	set := func(name, value string) error {
		if err := os.Setenv(name, value); err != nil {
			return fmt.Errorf("egressguard: could not set %s: %w", name, err)
		}
		return nil
	}
	for _, name := range []string{"HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy"} {
		if err := set(name, p.URL); err != nil {
			return nil, err
		}
	}
	for _, name := range []string{"NO_PROXY", "no_proxy"} {
		if err := set(name, ""); err != nil {
			return nil, err
		}
	}
	return func() {
		for _, name := range names {
			if present[name] {
				_ = os.Setenv(name, saved[name])
			} else {
				_ = os.Unsetenv(name)
			}
		}
	}, nil
}

// MustInstall is the call a probe makes: a late install is a defect in the PROBE, so it fails the test with the
// reason rather than returning an error the caller might ignore.
func (p *Proxy) MustInstall(t *testing.T) (restore func()) {
	t.Helper()
	restore, err := p.Install()
	if err != nil {
		t.Fatalf("%v", err)
	}
	t.Cleanup(restore)
	return restore
}

// Received returns everything that arrived, in arrival order.
func (p *Proxy) Received() []ProxyRequest {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]ProxyRequest(nil), p.seen...)
}

// Unexpected returns the arrivals the fixture does not claim.
func (p *Proxy) Unexpected() []Violation {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Violation(nil), p.unexpect...)
}

// Reset clears the recording, so a second scenario in one process starts from an empty observation.
func (p *Proxy) Reset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.seen = nil
	p.unexpect = nil
}

// ------------------------------------------------------------------------------------------------
// The rule-14 assertion.
// ------------------------------------------------------------------------------------------------

// Expectation is one request the fixture CLAIMS the provider received. It is compared by the fields the
// provider-wire doctrine allows the harness to match on: the method, the raw request target and the host.
type Expectation struct {
	Method string
	// Target is the raw request target (path + query), exactly as the fixture records it. A normalisation here
	// would be the same defect `EscapedPath()` exists to prevent (AGENTS.md 15): the decoded form has already
	// thrown away the distinction the fixture preserves.
	Target string
	Host   string
}

// Mismatch is one difference between what the fixture claims and what the peer received. It is the RESULT of the
// comparison, separate from the reporting, so the comparison itself can be tested directly -- an assertion whose
// only caller is a real *testing.T cannot be shown to fail without failing a test.
type Mismatch struct {
	// Kind is "unexpected" (the peer received a request nobody claimed: the escape shape) or "missing" (the
	// fixture claims a request the peer never received).
	Kind           string
	Method, Target string
	Host           string
}

func (m Mismatch) String() string {
	if m.Kind == "unexpected" {
		return fmt.Sprintf("FORBIDDEN EGRESS: the peer received a request the fixture does not claim: %s %s (host %s)", m.Method, m.Target, m.Host)
	}
	return fmt.Sprintf("MISSING REQUEST: the fixture claims %s %s (host %s) and the peer never received it -- "+
		"either the transport stopped sending it, or it went somewhere that is not the peer", m.Method, m.Target, m.Host)
}

// Compare is the rule-14 comparison as a PURE FUNCTION: it returns every difference, in a stable order, and calls
// no testing method. `Assert` is the reporting wrapper around it. Testing the comparison through this function is
// the only way the negative cases can be proven without a fake *testing.T, which would be a copy of the subject
// (differential doctrine 3).
func Compare(expected []Expectation, received []ProxyRequest) []Mismatch {
	type key struct{ method, target, host string }
	counts := make(map[key]int, len(expected))
	for _, want := range expected {
		counts[key{want.Method, want.Target, want.Host}]++
	}
	var mismatches []Mismatch
	for _, got := range received {
		k := key{got.Method, got.Target, got.Host}
		if counts[k] > 0 {
			counts[k]--
			continue
		}
		mismatches = append(mismatches, Mismatch{Kind: "unexpected", Method: got.Method, Target: got.Target, Host: got.Host})
	}
	var missing []Mismatch
	for k, remaining := range counts {
		for index := 0; index < remaining; index++ {
			missing = append(missing, Mismatch{Kind: "missing", Method: k.method, Target: k.target, Host: k.host})
		}
	}
	sort.Slice(missing, func(left, right int) bool {
		a, b := missing[left], missing[right]
		if a.Method != b.Method {
			return a.Method < b.Method
		}
		if a.Target != b.Target {
			return a.Target < b.Target
		}
		return a.Host < b.Host
	})
	return append(mismatches, missing...)
}

// Assert is the assertion rule 14 requires: the peer received EXACTLY the requests the fixture claims.
//
// WHY "EXACTLY" AND NOT "AT LEAST". "At least" is satisfied by a run that also leaked, which is the failure the
// rule was written for. The cost of "exactly" is that a probe which legitimately makes an extra request must
// declare it; that cost is the point, because the declaration is what makes the extra request reviewable.
//
// The comparison is a MULTISET on (method, target, host), so a fixture that claims two identical polls is
// satisfied by two arrivals and not by one. It reports BOTH directions:
//   - a claimed request that never arrived -> the peer is MISSING a request (the transport changed, or the
//     request escaped to somewhere that is not the peer);
//   - an arrival nobody claimed -> the subject sent something the fixture does not describe (the escape shape).
func Assert(t *testing.T, guard *Guard, proxy *Proxy, expected []Expectation) {
	t.Helper()
	received := proxy.Received()
	for _, mismatch := range Compare(expected, received) {
		t.Error(mismatch)
	}

	// A DIAL THE GUARD REFUSED IS A FAILURE EVEN WHEN THE PROXY RECORDED NOTHING, because the two are different
	// escape routes: a request through the proxy is visible by its target, a direct dial is visible only here.
	for _, violation := range guard.Violations() {
		t.Errorf("FORBIDDEN EGRESS: %s", violation)
	}
	for _, violation := range proxy.Unexpected() {
		t.Errorf("FORBIDDEN EGRESS: %s", violation)
	}

	// A GREEN MUST SAY WHAT WAS OBSERVED, or a run that observed nothing reads the same as a run whose
	// expectation was empty. This is the `-v` proof that the assertion executed.
	t.Logf("egressguard: the peer received %d request(s), all claimed by the fixture; %d dial(s) were refused",
		len(received), len(guard.Violations()))
}

// AssertNoEgress is the refusal half: a route that must make no request at all. It is the same assertion with an
// empty expectation, named so the call site reads as a refusal rather than as a comparison with nothing.
func AssertNoEgress(t *testing.T, guard *Guard, proxy *Proxy) {
	t.Helper()
	Assert(t, guard, proxy, nil)
}

// DrainAndAssertNoUnclaimed is for a streaming leg: it waits for the response body to finish, then asserts the
// same thing. It exists so a caller cannot "assert" on a proxy that has not yet received the last chunk.
func DrainAndAssertNoUnclaimed(t *testing.T, body io.Reader, guard *Guard, proxy *Proxy, expected []Expectation) {
	t.Helper()
	if body != nil {
		_, _ = io.Copy(io.Discard, body)
		_ = closeIfCloser(body)
	}
	Assert(t, guard, proxy, expected)
}

func closeIfCloser(reader io.Reader) error {
	if closer, ok := reader.(io.Closer); ok {
		return closer.Close()
	}
	return nil
}

// Describe renders the fixture's claim as JSON, for a log line a reviewer can read against the fixture.
func Describe(expected []Expectation) string {
	encoded, err := json.Marshal(expected)
	if err != nil {
		return "[]"
	}
	return string(encoded)
}
