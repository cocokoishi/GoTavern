package app

// AN OCCUPIED PORT MUST BE A NAMED, IMMEDIATE FAILURE -- item 2 of the startup long tail, in the package that
// owns the listener decision.
//
// WHAT IS PINNED (SillyTavern 1.19.0 = 06bde939, read 2026-10-27):
//
//	src/server-startup.js:335-349   IPv6 listen failure -> `console.error('Warning: failed to start server on
//	                                IPv6')`, then, for EADDRINUSE only, `#getAddressInUseMessage(url, 6)`
//	src/server-startup.js:351-...   IPv4 the same way
//	then the startup sums the failures and aborts when no protocol came up
//
//	=> Pinned's observable is: a bind failure is REPORTED, and when the cause is EADDRINUSE the report is the
//	   address-in-use message rather than a bare exception. It never retries and never waits.
//
// WHAT GoTavern ADDS (declared, not parity): internal/app/server.go:376-389 classifies the failure and names
// the PROTOCOL in the message while keeping the syscall error as the cause. That classification is what a user
// acts on, so this test asserts the classification AND that the underlying cause still carries the address --
// a message that says "port in use" without the port is the "cannot connect to server" shape AGENTS 35 forbids.
//
// WHY THE ASSERTION IS ABOUT `Start`, NOT THE CLI: the CLI adds a `gotavern:` prefix and an exit code, and a
// test of that would be a test of main(). `Start` is where the decision is made, and the caller contract is
// "returns an error whose text lets a user find the port".

import (
	"fmt"
	"net"
	"strconv"
	"strings"
	"testing"
)

// withPort replaces the value of an existing `--port` pair (or appends one when absent), so a case can choose
// the port without depending on how the parser resolves duplicates.
func withPort(args []string, port int) []string {
	value := strconv.Itoa(port)
	replaced := make([]string, 0, len(args)+2)
	for index := 0; index < len(args); index++ {
		if args[index] == "--port" && index+1 < len(args) {
			replaced = append(replaced, "--port", value)
			index++
			continue
		}
		replaced = append(replaced, args[index])
	}
	for index := 0; index < len(replaced); index++ {
		if replaced[index] == "--port" {
			return replaced
		}
	}
	return append(replaced, "--port", value)
}

// TestOccupiedPortNamesThePortAndReturnsImmediately is the user's real situation: their `node server.js` is
// still running on 8000 and they start GoTavern over the same tree.
func TestOccupiedPortNamesThePortAndReturnsImmediately(t *testing.T) {
	// OCCUPY a port the way another process would: bind and LISTEN, and keep it bound for the whole test.
	// A listener that is closed before the boot would test nothing -- the port would be free again.
	occupied, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("occupy a loopback port: %v", err)
	}
	t.Cleanup(func() { _ = occupied.Close() })
	address, ok := occupied.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatalf("the occupying listener address is %T, want *net.TCPAddr", occupied.Addr())
	}
	port := address.Port

	root := t.TempDir()
	// THE PORT IS SET ONCE, IN PLACE. scenarioOptions already passes a --port (baseScenarioArgs), and appending
	// a second one would make this case depend on the parser's last-wins rule: the map in
	// internal/commandline/options.go:322-323 would take the later value, so it would pass -- but the case
	// would then be measuring two things. Replacing the existing pair keeps the subject the LISTENER.
	options := scenarioOptions(t, root, root)
	options.Args = withPort(options.Args, port)

	running, startErr := startBounded(t, "occupied port", root, options)
	if startErr == nil {
		if running != nil {
			t.Fatalf("Start SUCCEEDED with port %d already bound by another listener. Either the product "+
				"bound a different port than it was told to, or it reported success without a listener.",
				port)
		}
		t.Fatalf("Start reported neither a server nor an error with port %d already bound", port)
	}

	// (1) IT RETURNED. startBounded above fails with goroutine stacks if it did not, so reaching here is the
	// no-hang half. Restated as a property because "immediately" is the user-visible behaviour: a boot that
	// waited for a busy port would look like the P0-B hang.
	message := startErr.Error()
	if !strings.Contains(message, "already in use") {
		t.Fatalf("the error does not say the port is in use, so a user cannot tell an occupied port from a "+
			"permissions or config problem: %v", startErr)
	}
	// (2) IT NAMES THE PROTOCOL, which is the classification this product adds over pinned's bare report.
	if !strings.Contains(message, "IPv4") {
		t.Fatalf("the error does not name the protocol whose listener failed: %v", startErr)
	}
	// (3) THE PORT ITSELF REACHES THE USER. The classified message names the protocol; the port lives in the
	// cause (the syscall error from net.Listen). Both halves are required: the classification says WHICH
	// listener, the cause says WHICH port, and a user needs both to find the process holding it.
	wantPort := fmt.Sprintf("%d", port)
	if !strings.Contains(message, wantPort) {
		// Look one level down explicitly, so a failure says whether the information is absent or merely in a
		// place the message format dropped.
		startupErr, isStartupError := startErr.(*StartupError)
		causeText := ""
		if isStartupError && startupErr.Cause != nil {
			causeText = startupErr.Cause.Error()
		}
		t.Fatalf("the error message does not name port %d (AGENTS 35: an error a user cannot act on is the\n"+
			"failure mode this project forbids).\n  message: %s\n  cause:   %s\n  StartupError: %t",
			port, message, causeText, isStartupError)
	}
}
