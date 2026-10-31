package egressguard

// A RECORDING RESOLVER PEER: the DNS half of rule 14, for a process that must make no "allowable"
// network call except one.
//
// WHY A DNS SERVER AND NOT A REPLACED LOOKUP FUNCTION. The gate this file exists for
// (`internal/app/startup_egress_test.go`) has to answer one question about a REAL boot: did anything
// during startup resolve a hostname it was not allowed to resolve? Replacing a lookup function with a
// counter answers that only for the call sites that use the function, which is the "replaced a NAME, not a
// capability" defect AGENTS.md verification rule 14 records for the Horde probe. `net.DefaultResolver` is
// the RESOLVER, not a name: `net.LookupIP`, `net.LookupHost`, `net.LookupIPAddr`, `net.Dialer.DialContext`
// on a hostname, and therefore every `net/http` client request to a name all arrive here BY CONSTRUCTION,
// because the query has to leave the process to be answered.
//
// WHAT IT RECORDS, and what it deliberately does not. Every query's NAME and TYPE, and nothing else: no
// address, no port, no credential, no payload. A query for a name the harness did not allow is recorded as
// a Violation NAMING that name and answered NXDOMAIN, so a startup that depends on it fails loudly instead
// of resolving to something plausible.
//
// WHAT THIS CANNOT SEE, stated so a green is not over-read (the same paragraph guard.go carries):
//   - a dial to an IP LITERAL, which involves no name and therefore no query. `TestStartupSourcesAddNoEgressPath`
//     is the declaration-level second opinion for that shape, and it is labelled as one.
//   - a connection another PROCESS makes on the subject's behalf (a `git` subprocess honours its own
//     resolver). The boot path runs no subprocess, which that source-level test also covers.
//   - a query that bypasses `net.DefaultResolver` by constructing its own `net.Resolver`: that resolver
//     still needs a DNS SERVER address, which on every host this runs on comes from the system config and
//     is honoured by the process-wide default it replaced only if it is the default. A resolver built by
//     hand with an explicit server address is outside this observation.
//
// THE DEFAULT IS DENY. `StartResolverPeer` allows nothing; `Allow` names what may be asked. That is the
// correct default for this gate because the allow-list is a PRODUCT DECISION (the docker-hostname lookup
// documented in docs/network-egress.md §3.4 and AGENTS.md rule 25), and a forgotten allowance must fail
// the run at the lookup, not quietly permit the internet.

import (
	"context"
	"encoding/binary"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"sort"
	"strings"
	"sync"
	"testing"
)

// DNS record types this peer understands. Anything else is recorded by number and answered NODATA, so an
// unknown type is visible in the log rather than dropped.
const (
	dnsTypeA     uint16 = 1
	dnsTypeAAAA  uint16 = 28
	dnsClassINET uint16 = 1

	dnsRcodeSuccess  uint16 = 0
	dnsRcodeNXDomain uint16 = 3
)

// defaultResolverAnswer is what an allowed name resolves to unless `Allow` names other addresses. Loopback
// is deliberate: it is the only answer a test may hand back without any possibility of the subject reaching
// a real host through it.
var defaultResolverAnswer = []netip.Addr{netip.MustParseAddr("127.0.0.1")}

// ResolverQuery is one DNS question the subject asked. Name is lower-cased and has no trailing dot, so two
// spellings of one name compare equal; Type is "A", "AAAA" or "TYPE<n>".
type ResolverQuery struct {
	Name string
	Type string
}

func (q ResolverQuery) String() string { return q.Name + "/" + q.Type }

// ResolverMismatch is one difference between the startup allow-list and what the subject asked for. It is a
// separate type from Mismatch because the wording is the thing that makes the failure diagnosable: "a
// hostname lookup" is not "a request the peer received", and a reader must be able to tell which half of the
// egress surface spoke.
type ResolverMismatch struct {
	// Kind is "unexpected" (a lookup the allow-list does not name: the escape shape) or "missing" (the
	// allow-list names a lookup the subject never made: the allowed case must be ASSERTED, never assumed).
	Kind string
	Name string
}

func (m ResolverMismatch) String() string {
	if m.Kind == "unexpected" {
		return fmt.Sprintf("FORBIDDEN EGRESS: the startup path resolved the hostname %q, which the startup "+
			"allow-list does not name (AGENTS.md rule 25: boot is local; the only allowed lookup is the "+
			"documented docker-hostname resolution)", m.Name)
	}
	return fmt.Sprintf("MISSING LOOKUP: the startup allow-list names %q and the boot never resolved it, so the "+
		"allowed case is being asserted by SILENCE rather than by an observation (AGENTS.md rule 7: an "+
		"observed zero must be distinguishable from nothing having run)", m.Name)
}

// CompareResolverContact is the pure comparison, so its teeth can be demonstrated without a live subject:
// the set of names the subject asked for must equal the allow-list, in both directions.
//
// ONE LOOKUP IS NOT ONE QUERY, AND THE DIFFERENCE IS THE HOST'S, NOT THE SUBJECT'S. Measured 2026-10-30 on a
// GitHub Actions ubuntu runner (run 41043713313): a single `LookupIPAddr(ctx, "telemetry.example")` arrived at
// this peer as TWO questions -- `telemetry.example` and `telemetry.example.<random>.bx.internal.cloudapp.net`.
// That second name is the host's `/etc/resolv.conf` search list plus its `ndots` setting, applied INSIDE
// net.Resolver; the subject never named it and cannot name it. The first version of the caller asserted
// "exactly one unexpected finding" and went red on that runner while the gate was working correctly.
//
// So the comparison collapses SEARCH EXPANSIONS back onto the name that was asked: a name N is an expansion of
// B when N is B plus one or more dotted labels (`B + "." + …`). The rules, chosen so the collapse can only
// ever REDUCE noise and never hide an escape the subject asked for:
//   - an observed name is PERMITTED when it equals an allow-listed name or is a search expansion of one, because
//     a suffix the host appended is not a lookup the subject chose;
//   - an escape is reported once per BASE name, and the base is the SHORTEST recorded name it is an expansion of
//     -- so one subject lookup is one finding even when the host asked twice, while two unrelated escapes stay
//     two findings;
//   - an allow-listed name counts as OBSERVED when it, or an expansion of it, was asked, so the allowed case
//     cannot be satisfied by silence.
func CompareResolverContact(allowed []string, observed []string) []ResolverMismatch {
	permitted := make([]string, 0, len(allowed))
	for _, name := range allowed {
		permitted = append(permitted, normalizeQueryName(name))
	}
	asked := distinctSorted(observed)
	bases := CollapseSearchExpansions(asked)

	var mismatches []ResolverMismatch
	for _, base := range bases {
		if !isPermittedName(base, permitted) {
			mismatches = append(mismatches, ResolverMismatch{Kind: "unexpected", Name: base})
		}
	}
	var missing []ResolverMismatch
	for _, allow := range permitted {
		observedAllow := false
		for _, name := range asked {
			if name == allow || isSearchExpansionOf(name, allow) {
				observedAllow = true
				break
			}
		}
		if !observedAllow {
			missing = append(missing, ResolverMismatch{Kind: "missing", Name: allow})
		}
	}
	sort.Slice(mismatches, func(left, right int) bool { return mismatches[left].Name < mismatches[right].Name })
	sort.Slice(missing, func(left, right int) bool { return missing[left].Name < missing[right].Name })
	return append(mismatches, missing...)
}

// CollapseSearchExpansions maps recorded query names onto the name each was derived from, so one subject lookup
// that the host resolved with its search list is ONE name. The base is the shortest recorded name that the
// argument extends at a label boundary; a name that extends nothing is its own base.
func CollapseSearchExpansions(names []string) []string {
	asked := distinctSorted(names)
	bases := make([]string, 0, len(asked))
	seen := make(map[string]bool, len(asked))
	for _, name := range asked {
		base := name
		for _, candidate := range asked {
			if candidate == name {
				continue
			}
			if isSearchExpansionOf(name, candidate) && len(candidate) < len(base) {
				base = candidate
			}
		}
		if !seen[base] {
			seen[base] = true
			bases = append(bases, base)
		}
	}
	sort.Strings(bases)
	return bases
}

// isSearchExpansionOf reports whether `name` is `base` plus at least one dotted label. The LABEL BOUNDARY is
// what makes this safe: "telemetry.example.evil" extends "telemetry.example", but "telemetry.exampletwo" does
// not extend "telemetry.example" even though it shares the prefix.
func isSearchExpansionOf(name, base string) bool {
	return base != "" && len(name) > len(base)+1 && strings.HasPrefix(name, base+".")
}

func isPermittedName(name string, permitted []string) bool {
	for _, allow := range permitted {
		if name == allow || isSearchExpansionOf(name, allow) {
			return true
		}
	}
	return false
}

func distinctSorted(names []string) []string {
	seen := make(map[string]bool, len(names))
	out := make([]string, 0, len(names))
	for _, name := range names {
		key := normalizeQueryName(name)
		if seen[key] {
			continue
		}
		seen[key] = true
		out = append(out, key)
	}
	sort.Strings(out)
	return out
}

func normalizeQueryName(name string) string {
	return strings.ToLower(strings.TrimSuffix(strings.TrimSpace(name), "."))
}

// ResolverPeer is a real DNS server on loopback that records every question it is asked.
type ResolverPeer struct {
	conn net.PacketConn
	addr string

	mu         sync.Mutex
	allowed    map[string][]netip.Addr
	queries    []ResolverQuery
	violations []Violation
	silent     bool
	closed     bool
}

// StartResolverPeer starts the peer and stops it when the test ends.
func StartResolverPeer(t *testing.T) *ResolverPeer {
	t.Helper()
	peer := startResolverPeer()
	t.Cleanup(peer.Close)
	return peer
}

func startResolverPeer() *ResolverPeer {
	conn, err := net.ListenPacket("udp", "127.0.0.1:0")
	if err != nil {
		panic("egressguard: a loopback UDP listener is required for the resolver peer: " + err.Error())
	}
	peer := &ResolverPeer{conn: conn, addr: conn.LocalAddr().String(), allowed: map[string][]netip.Addr{}}
	go peer.serve()
	return peer
}

// Close stops the listener. It is safe to call more than once.
func (p *ResolverPeer) Close() {
	p.mu.Lock()
	if p.closed {
		p.mu.Unlock()
		return
	}
	p.closed = true
	p.mu.Unlock()
	_ = p.conn.Close()
}

// Addr is the peer's host:port, exposed so a test can assert the resolver was pointed at it.
func (p *ResolverPeer) Addr() string { return p.addr }

// Allow names a hostname the subject may resolve and, optionally, the addresses it answers with. Calling it
// twice for one name replaces the answer list.
func (p *ResolverPeer) Allow(name string, answers ...netip.Addr) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if len(answers) == 0 {
		answers = defaultResolverAnswer
	}
	p.allowed[normalizeQueryName(name)] = answers
}

// Silence stops answering while continuing to RECORD every query. It is the input the bounded-lookup case
// needs: a machine whose DNS server accepts the question and never replies, which is the hang AGENTS.md rule
// 24 forbids in the boot path.
func (p *ResolverPeer) Silence() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.silent = true
}

// Install points the process-wide default resolver at this peer and returns the restore function.
//
// THE RESTORE IS NOT OPTIONAL and it is not a convenience: `net.DefaultResolver` is process-global, and a
// test that left it installed would make every later test in the binary resolve through a peer that is
// closed, which is the "a harness that silently does not apply" defect in reverse.
func (p *ResolverPeer) Install() (restore func(), err error) {
	if p == nil || p.addr == "" {
		return nil, errors.New("egressguard: the resolver peer has no listener")
	}
	peerAddr := p.addr
	previous := net.DefaultResolver
	net.DefaultResolver = &net.Resolver{
		// PreferGo is REQUIRED: without it a cgo-enabled build may use the system resolver, which ignores
		// `Dial` and would be outside this observation while the gate reported a green.
		PreferGo: true,
		Dial: func(ctx context.Context, network, _ string) (net.Conn, error) {
			dialer := &net.Dialer{}
			if strings.HasPrefix(network, "tcp") {
				// The peer answers over UDP only, and it never sets the truncated bit, so a TCP retry would
				// only happen for a query this harness cannot answer. Failing causally keeps that visible.
				return nil, fmt.Errorf("egressguard: the resolver peer serves UDP only, refusing %q", network)
			}
			return dialer.DialContext(ctx, network, peerAddr)
		},
	}
	return func() { net.DefaultResolver = previous }, nil
}

// MustInstall is Install for a test that treats a failure to install as fatal.
func (p *ResolverPeer) MustInstall(t *testing.T) (restore func()) {
	t.Helper()
	restore, err := p.Install()
	if err != nil {
		t.Fatalf("egressguard: install the recording resolver: %v", err)
	}
	t.Cleanup(restore)
	return restore
}

// Queries returns every question asked, in arrival order.
func (p *ResolverPeer) Queries() []ResolverQuery {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]ResolverQuery(nil), p.queries...)
}

// ContactedNames returns the distinct names asked about, sorted, which is what the allow-list compares.
func (p *ResolverPeer) ContactedNames() []string {
	seen := map[string]bool{}
	for _, query := range p.Queries() {
		seen[query.Name] = true
	}
	names := make([]string, 0, len(seen))
	for name := range seen {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// BaseContactedNames returns the names the SUBJECT asked for, with the host's search-domain expansions collapsed
// onto them. This is the view a host-independent assertion uses: on a machine whose resolver appends a search
// suffix, one `LookupIPAddr` reaches the peer as two questions and the raw list would make any count assertion a
// property of that machine's `/etc/resolv.conf` (measured on a GitHub ubuntu runner, run 41043713313).
// The raw list stays available through ContactedNames, so nothing is hidden -- it is only summarised.
func (p *ResolverPeer) BaseContactedNames() []string {
	return CollapseSearchExpansions(p.ContactedNames())
}

// Violations returns the queries refused because the allow-list did not name them.
func (p *ResolverPeer) Violations() []Violation {
	p.mu.Lock()
	defer p.mu.Unlock()
	return append([]Violation(nil), p.violations...)
}

// Reset clears the recording, so one peer can serve several cases in one test.
func (p *ResolverPeer) Reset() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.queries = nil
	p.violations = nil
	p.silent = false
}

// AssertContactedOnly is the gate's assertion: the subject resolved EXACTLY the allow-listed names, and
// nothing was refused. An empty allow-list asserts that no hostname was resolved at all -- the
// zero-non-essential-egress claim itself.
func (p *ResolverPeer) AssertContactedOnly(t *testing.T, allowed ...string) {
	t.Helper()
	for _, mismatch := range CompareResolverContact(allowed, p.BaseContactedNames()) {
		t.Error(mismatch)
	}
	for _, violation := range p.Violations() {
		t.Errorf("FORBIDDEN EGRESS: %s", violation)
	}
	// A GREEN MUST SAY WHAT WAS OBSERVED (rule 7): "0 queries" and "the resolver was never consulted" are
	// different facts, and only the log line tells them apart. BOTH views are printed: the raw questions prove
	// the peer was really consulted (and expose a host's search-domain expansion), the base names are what the
	// allow-list was compared against.
	t.Logf("egressguard: resolver peer %s recorded %d quer(ies) over %d name(s) %v (base names %v); %d refused",
		p.addr, len(p.Queries()), len(p.ContactedNames()), p.ContactedNames(), p.BaseContactedNames(), len(p.Violations()))
}

// serve reads queries until the listener is closed and answers each one.
func (p *ResolverPeer) serve() {
	buffer := make([]byte, 1500)
	for {
		count, from, err := p.conn.ReadFrom(buffer)
		if err != nil {
			return
		}
		query, ok := parseDNSQuery(buffer[:count])
		if !ok {
			continue
		}
		name := normalizeQueryName(query.name)
		p.mu.Lock()
		p.queries = append(p.queries, ResolverQuery{Name: name, Type: dnsTypeName(query.qtype)})
		answers, allowed := p.allowed[name]
		if !allowed {
			// A SEARCH EXPANSION OF AN ALLOWED NAME IS STILL THE ALLOWED LOOKUP. The host appends its own
			// search domain to a short name (`/etc/resolv.conf` + ndots), so the subject asking for an
			// allow-listed name can arrive here as `<allowed>.<host search domain>`. Refusing that would make
			// the gate red on a legitimate boot and would teach its readers to ignore it, which is the failure
			// mode a gate must never have. The match is the same label-boundary rule the comparison uses, and
			// it is one-directional: an expansion of an ALLOWED name, never an expansion of an escape.
			for base, baseAnswers := range p.allowed {
				if isSearchExpansionOf(name, base) {
					answers, allowed = baseAnswers, true
					break
				}
			}
		}
		silent := p.silent
		if !allowed {
			p.violations = append(p.violations, Violation{
				Stage:  "resolver",
				Host:   name,
				Target: "DNS " + dnsTypeName(query.qtype),
				Reason: "the startup path resolved a hostname the startup allow-list does not name; boot is local and the only allowed lookup is the documented docker-hostname resolution (AGENTS.md rule 25, docs/network-egress.md §3.4)",
			})
		}
		p.mu.Unlock()
		if silent {
			// A REAL hanging DNS server: the question is accepted and never answered. No response is the
			// whole input of the bounded-lookup case.
			continue
		}
		if !allowed {
			_, _ = p.conn.WriteTo(buildDNSResponse(query, nil, dnsRcodeNXDomain), from)
			continue
		}
		_, _ = p.conn.WriteTo(buildDNSResponse(query, answersForType(answers, query.qtype), dnsRcodeSuccess), from)
	}
}

func answersForType(addresses []netip.Addr, qtype uint16) []netip.Addr {
	answers := make([]netip.Addr, 0, len(addresses))
	for _, address := range addresses {
		switch {
		case qtype == dnsTypeA && address.Unmap().Is4():
			answers = append(answers, address.Unmap())
		case qtype == dnsTypeAAAA && address.Is6() && !address.Is4In6():
			answers = append(answers, address)
		}
	}
	return answers
}

func dnsTypeName(qtype uint16) string {
	switch qtype {
	case dnsTypeA:
		return "A"
	case dnsTypeAAAA:
		return "AAAA"
	default:
		return fmt.Sprintf("TYPE%d", qtype)
	}
}

// dnsQuery is the part of a question this peer needs.
type dnsQuery struct {
	id           uint16
	question     []byte // the question section, verbatim, so the response can echo it
	name         string
	qtype        uint16
	questionBody int // offset just past the question section
}

// parseDNSQuery decodes the header and the FIRST question. A message with a question count other than one is
// refused: this peer answers what Go's resolver sends, and silently accepting a shape it does not understand
// would be the "tolerant reader hides the defect" failure instead of a visible one.
func parseDNSQuery(message []byte) (dnsQuery, bool) {
	if len(message) < 12 {
		return dnsQuery{}, false
	}
	query := dnsQuery{id: binary.BigEndian.Uint16(message[0:2])}
	if binary.BigEndian.Uint16(message[4:6]) != 1 {
		return dnsQuery{}, false
	}
	offset := 12
	var labels []string
	for {
		if offset >= len(message) {
			return dnsQuery{}, false
		}
		length := int(message[offset])
		offset++
		if length == 0 {
			break
		}
		if length > 63 || offset+length > len(message) {
			return dnsQuery{}, false
		}
		labels = append(labels, string(message[offset:offset+length]))
		offset += length
	}
	if offset+4 > len(message) {
		return dnsQuery{}, false
	}
	query.name = strings.Join(labels, ".")
	query.qtype = binary.BigEndian.Uint16(message[offset : offset+2])
	offset += 4 // qtype + qclass
	query.question = message[12:offset]
	query.questionBody = offset
	return query, true
}

// buildDNSResponse echoes the question and appends the answers. A nil answer list with rcode 0 is NODATA,
// which is what a name with no address of the requested family must answer: an NXDOMAIN there would tell the
// resolver the NAME does not exist, which is a different fact.
func buildDNSResponse(query dnsQuery, answers []netip.Addr, rcode uint16) []byte {
	response := make([]byte, 12, 12+len(query.question)+16*len(answers))
	binary.BigEndian.PutUint16(response[0:2], query.id)
	// QR=1, Opcode=0, AA=0, TC=0, RD=1 (echoed), RA=1, rcode.
	binary.BigEndian.PutUint16(response[2:4], 0x8180|(rcode&0x000f))
	binary.BigEndian.PutUint16(response[4:6], 1)                    // QDCOUNT
	binary.BigEndian.PutUint16(response[6:8], uint16(len(answers))) // ANCOUNT
	response = append(response, query.question...)
	for _, answer := range answers {
		response = append(response, 0xc0, 0x0c) // pointer to the name at offset 12
		address := answer.AsSlice()
		recordType := dnsTypeA
		if len(address) == net.IPv6len {
			recordType = dnsTypeAAAA
		}
		response = appendUint16(response, recordType)
		response = appendUint16(response, dnsClassINET)
		response = append(response, 0, 0, 0, 60) // TTL 60s; the resolver does not cache, but a real value is honest
		response = appendUint16(response, uint16(len(address)))
		response = append(response, address...)
	}
	return response
}

func appendUint16(buffer []byte, value uint16) []byte {
	return append(buffer, byte(value>>8), byte(value))
}
