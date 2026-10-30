package app

// THE DECLARATION-LEVEL SECOND OPINION FOR THE STARTUP EGRESS GATE.
//
// WHY THIS EXISTS AT ALL, given that `startup_egress_test.go` already runs the real boot under a recording
// resolver. The runtime observation has three documented blind spots (they are listed in that file's header
// and in tests/egressguard/resolver.go):
//
//   - a dial to an IP LITERAL sends no DNS query, so the resolver peer never sees it;
//   - a SUBPROCESS resolves and connects in its own process, so nothing in this one can observe it;
//   - a resolver constructed by hand with its own server address bypasses `net.DefaultResolver`.
//
// This test covers the first two by scanning the SOURCE of the boot path for the primitives that can start
// them, and it is deliberately named a second opinion rather than a gate of its own: AGENTS.md rule 54 says a
// gate that compares declarations cannot see the failure that happens when one is executed, and the
// measurement behind that rule was an inventory gate that stayed green while `mux.HandleFunc` panicked on a
// pattern it had compared as equal strings. The runtime gate is the primary evidence here; this file exists
// because the runtime gate provably cannot see a literal dial, and "provably cannot see" is a reason to state
// a compensating check, not a reason to leave the surface unmeasured.
//
// WHAT IT CAN AND CANNOT SEE, stated so a green is not over-read:
//   - it sees package-qualified calls (`net.Dial`, `http.Get`, `exec.Command`) and the composite literals that
//     make a client or a dialer;
//   - it does NOT see a method call on a value obtained some other way (`someClient.Do(req)` where
//     `someClient` came from a dependency, or a package-level exported client), and it does not type-check.
//     That gap is why the runtime observation remains the primary gate.
//
// THE ALLOW-LIST IS ONE ENTRY and it names the only allowed outbound call in the boot path: the bounded
// docker-hostname lookup (docs/network-egress.md §3.4, AGENTS.md rule 25). A second call of any kind fails
// this test with its file and line, so adding startup egress is a visible, reviewed decision rather than a
// diff nobody looked at.

import (
	"go/ast"
	"go/parser"
	"go/printer"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

// bootPathSourceRoots are the files that constitute the boot path and are scanned. `internal/app` is the
// `Start` sequence; `internal/startup` is the data/config work it calls. A future startup dependency added
// elsewhere is NOT covered by this scan, which is the other reason the runtime gate stays primary.
var bootPathSourceRoots = []string{".", filepath.Join("..", "startup")}

// egressSourceAllowList is the complete set of outbound calls the boot path may contain, by file and rendered
// call. Keyed on the CALL rather than the line so an unrelated edit above it does not fail the test, and
// counted so a second occurrence in the same file is a finding.
var egressSourceAllowList = []egressSourceFinding{
	{File: "internal/app/server.go", Call: "net.DefaultResolver.LookupIPAddr"},
}

// egressSourceFinding is one outbound primitive found in the source, rendered so a reader can search for it.
type egressSourceFinding struct {
	File string
	Call string
	Line int
}

func (f egressSourceFinding) String() string {
	return f.File + ":" + itoa(f.Line) + ": " + f.Call
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	var digits []byte
	for value > 0 {
		digits = append([]byte{byte('0' + value%10)}, digits...)
		value /= 10
	}
	return string(digits)
}

// scanBootPathSources is the scanner as a pure function over named sources, so its teeth can be demonstrated
// on synthetic input without planting a file in the repository (AGENTS.md verification rule 2: a mutation that
// is reverted by a no-op leaves the tree poisoned; a scanner tested through a pure function cannot).
func scanBootPathSources(sources map[string][]byte) ([]egressSourceFinding, error) {
	fileSet := token.NewFileSet()
	var findings []egressSourceFinding
	names := make([]string, 0, len(sources))
	for name := range sources {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		parsed, err := parser.ParseFile(fileSet, name, sources[name], parser.SkipObjectResolution)
		if err != nil {
			return nil, err
		}
		render := func(node ast.Node) string {
			var builder strings.Builder
			if printErr := printer.Fprint(&builder, fileSet, node); printErr != nil {
				return ""
			}
			return builder.String()
		}
		ast.Inspect(parsed, func(node ast.Node) bool {
			switch typed := node.(type) {
			case *ast.CallExpr:
				selector, ok := typed.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				receiver := render(selector.X)
				if isEgressSourceCall(receiver, selector.Sel.Name) {
					findings = append(findings, egressSourceFinding{
						File: name,
						Line: fileSet.Position(typed.Pos()).Line,
						Call: receiver + "." + selector.Sel.Name,
					})
				}
			case *ast.CompositeLit:
				literal := render(typed.Type)
				if isEgressSourceLiteral(literal) {
					findings = append(findings, egressSourceFinding{
						File: name,
						Line: fileSet.Position(typed.Pos()).Line,
						Call: "&" + strings.TrimPrefix(literal, "&") + "{} literal",
					})
				}
			}
			return true
		})
	}
	return findings, nil
}

// egressSourceCallNames are the CALLS that can start egress. The unambiguous ones are matched on any receiver,
// because a hand-rolled dialer is exactly the shape this check exists to catch; the ambiguous ones (`Get`,
// `Post`, `Head`) are matched only on the `http` package, because `map.Get` and `session.Get` are not egress.
var egressSourceCallNames = map[string]bool{
	"Dial": true, "DialContext": true, "DialTimeout": true, "DialTCP": true, "DialUDP": true, "DialIP": true,
	"LookupIP": true, "LookupIPAddr": true, "LookupHost": true, "LookupAddr": true, "LookupCNAME": true,
	"LookupNetIP": true, "LookupMX": true, "LookupTXT": true, "LookupSRV": true,
	"ResolveIPAddr": true, "ResolveTCPAddr": true, "ResolveUDPAddr": true,
	"Command": true, "CommandContext": true,
	"Get": true, "Post": true, "PostForm": true, "Head": true,
}

// egressSourceReceiverScoped are the names that must be scoped to a package, because other packages use the
// same verb for something that does not touch the network.
var egressSourceReceiverScoped = map[string]string{
	"Get": "http", "Post": "http", "PostForm": "http", "Head": "http",
}

func isEgressSourceCall(receiver, name string) bool {
	if !egressSourceCallNames[name] {
		return false
	}
	scope, scoped := egressSourceReceiverScoped[name]
	if !scoped {
		return true
	}
	return receiver == scope
}

// isEgressSourceLiteral reports the composite literals that are a network client or a dialer. A `net.Dialer` is
// included even though constructing one dials nothing: it exists only to dial, so its presence in the boot path
// is the precondition of an egress the runtime observation may not see.
func isEgressSourceLiteral(literal string) bool {
	switch strings.TrimPrefix(literal, "&") {
	case "http.Client", "http.Transport", "net.Dialer", "net.Resolver":
		return true
	default:
		return false
	}
}

// bootPathSources reads every non-test Go file under the boot-path roots.
func bootPathSources(t *testing.T) map[string][]byte {
	t.Helper()
	sources := map[string][]byte{}
	for _, root := range bootPathSourceRoots {
		entries, err := os.ReadDir(root)
		if err != nil {
			t.Fatalf("read %s: %v", root, err)
		}
		for _, entry := range entries {
			name := entry.Name()
			if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
				continue
			}
			body, readErr := os.ReadFile(filepath.Join(root, name))
			if readErr != nil {
				t.Fatalf("read %s: %v", name, readErr)
			}
			// The FILE key is rendered repository-relative so the allow-list and the failure message are the
			// same string a reviewer can search for.
			key := "internal/app/" + name
			if root != "." {
				key = "internal/startup/" + name
			}
			sources[key] = body
		}
	}
	if len(sources) == 0 {
		t.Fatal("no boot-path sources were read, so this scan would pass vacuously")
	}
	return sources
}

// TestStartupSourcesAddNoEgressPath is the scan over the real boot path: the outbound calls present must be
// exactly the allow-listed ones, each exactly as many times as it is declared.
func TestStartupSourcesAddNoEgressPath(t *testing.T) {
	sources := bootPathSources(t)
	findings, err := scanBootPathSources(sources)
	if err != nil {
		t.Fatalf("the boot path does not parse, so this scan cannot run: %v", err)
	}
	allowed := map[string]int{}
	for _, entry := range egressSourceAllowList {
		allowed[entry.File+"\x00"+entry.Call]++
	}
	present := map[string]int{}
	for _, finding := range findings {
		present[finding.File+"\x00"+finding.Call]++
		if allowed[finding.File+"\x00"+finding.Call] == 0 {
			t.Errorf("%s is an outbound primitive in the boot path and the startup allow-list does not name "+
				"it: boot is local, and the only allowed egress is the bounded docker-hostname resolution "+
				"(AGENTS.md rule 25, docs/network-egress.md §3.4). If this is deliberate, add it to "+
				"egressSourceAllowList beside its reason", finding)
		}
	}
	for key, count := range allowed {
		file, call, _ := strings.Cut(key, "\x00")
		if present[key] < count {
			t.Errorf("the startup allow-list names %s in %s, and the source no longer contains it: an "+
				"allow-list entry that outlives its call hides the next one (AGENTS.md rule 7)", call, file)
		}
	}
	declaredCount := 0
	for _, count := range allowed {
		declaredCount += count
	}
	t.Logf("scanned %d boot-path sources; %d outbound primitive(s) found, %d allow-listed (a finding above "+
		"means the two numbers disagree)", len(sources), len(findings), declaredCount)
}

// TestEgressSourceScanHasTeeth proves the scanner can report each shape it claims to see, and does NOT report
// the permitted call. Without this the scan could be looking for a string that no longer exists and stay
// green over a real dial.
func TestEgressSourceScanHasTeeth(t *testing.T) {
	sources := map[string][]byte{
		"internal/app/synthetic.go": []byte(`package app

import (
	"net"
	"net/http"
	"os/exec"
)

func synthetic() {
	_, _ = net.Dial("tcp", "198.51.100.7:443")
	_, _ = net.LookupHost("telemetry.example")
	_, _ = net.DefaultResolver.LookupIPAddr(nil, "host.docker.internal")
	_, _ = http.Get("http://127.0.0.1/")
	_ = exec.Command("git", "pull")
	client := &http.Client{}
	_ = client
	dialer := net.Dialer{}
	_ = dialer
}
`),
	}
	findings, err := scanBootPathSources(sources)
	if err != nil {
		t.Fatalf("the synthetic source does not parse: %v", err)
	}
	want := map[string]bool{
		"net.Dial":                         true,
		"net.LookupHost":                   true,
		"net.DefaultResolver.LookupIPAddr": true,
		"http.Get":                         true,
		"exec.Command":                     true,
		"&http.Client{} literal":           true,
		"&net.Dialer{} literal":            true,
	}
	got := map[string]bool{}
	for _, finding := range findings {
		got[finding.Call] = true
	}
	for call := range want {
		if !got[call] {
			t.Errorf("the scanner did not report %q, so a real occurrence of it would be invisible", call)
		}
	}
	if len(findings) != len(want) {
		t.Errorf("the scanner reported %d finding(s) %v, want exactly the %d shapes it claims to see",
			len(findings), findings, len(want))
	}
	// AND A CLEAN SOURCE MUST BE CLEAN, or the check would fail every file for the wrong reason.
	clean, err := scanBootPathSources(map[string][]byte{"internal/app/clean.go": []byte("package app\n\nfunc clean() {}\n")})
	if err != nil {
		t.Fatalf("a trivial source does not parse: %v", err)
	}
	if len(clean) != 0 {
		t.Errorf("a source with no outbound primitive produced %v", clean)
	}
}
