// Package app composes command-line parsing, pinned data startup, middleware,
// protocol selection, and listener lifecycle for the GoTavern server.
package app

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/commandline"
	"github.com/cocokoishi/gotavern/internal/lockacquire"
	"github.com/cocokoishi/gotavern/internal/server"
	"github.com/cocokoishi/gotavern/internal/startup"
)

// StartOptions supplies process inputs while keeping startup and listener
// behavior testable against the pinned oracle.
type StartOptions struct {
	Args                     []string
	WorkingDirectory         string
	InstallRoot              string
	ForceGlobalMode          *bool
	GlobalDataDirectory      string
	Now                      time.Time
	WaitBeforeLegacyDataMove func(time.Duration)
	InterfaceAddresses       []net.Addr
	// StartupTrace receives the named startup stages (see startup_trace.go). Nil means os.Stderr, which is what
	// the shipped binary uses; tests substitute a buffer so they can assert what a user would actually see.
	StartupTrace io.Writer
}

// ListenerFailure records a selected address family whose listener failed
// while another selected family may still be serving requests.
type ListenerFailure struct {
	IPv6 bool
	Err  error
}

// StartupError carries a pinned exit status and, for the remote-listening
// security gate, the events that SillyTavern prints before exiting.
type StartupError struct {
	Code           int
	Message        string
	Cause          error
	SecurityEvents []startup.SecuritySettingsEvent
}

func (err *StartupError) Error() string {
	if err.Cause != nil && err.Message != "" && err.Message != err.Cause.Error() {
		return err.Message + ": " + err.Cause.Error()
	}
	if err.Message == "" && err.Cause != nil {
		return err.Cause.Error()
	}
	return err.Message
}

func (err *StartupError) Unwrap() error { return err.Cause }

// ExitCode returns the pinned fatal startup status for the command-line
// process.
func (err *StartupError) ExitCode() int { return err.Code }

// RunningServer owns the HTTP servers and sockets started by Start.
type RunningServer struct {
	CommandLine      commandline.CommandLineResult
	DataStartup      startup.DataStartupResult
	Protocols        server.ProtocolSelection
	StartedIPv4      bool
	StartedIPv6      bool
	ListenerFailures []ListenerFailure

	httpServers []*http.Server
	listeners   []net.Listener
	serveErrors chan error
	heartbeat   *heartbeatWriter
}

// Start follows the pre-listener data startup before constructing the HTTP
// handler and binding IPv6 then IPv4 listeners, in the pinned order.
func Start(options StartOptions) (*RunningServer, error) {
	// ONE budget for the whole boot, because the boot-path locks NEST (config -> storage -> content). Four
	// per-lock bounds are not a boot bound: two 10s waits inside a 20s budget still blow the budget.
	endBoot := lockacquire.BeginBoot(lockacquire.DefaultBootBudget)
	defer endBoot()
	if options.InstallRoot == "" {
		return nil, errors.New("server startup requires an install root")
	}
	if options.WorkingDirectory == "" {
		workingDirectory, err := os.Getwd()
		if err != nil {
			return nil, fmt.Errorf("get working directory: %w", err)
		}
		options.WorkingDirectory = workingDirectory
	}
	if options.Now.IsZero() {
		options.Now = time.Now()
	}
	if options.WaitBeforeLegacyDataMove == nil {
		options.WaitBeforeLegacyDataMove = time.Sleep
	}
	// PINNED CHDIRS TO THE SERVER DIRECTORY, SO ITS WORKING DIRECTORY IS NEVER THE CALLER'S.
	//
	// server.js:11 is `process.chdir(serverDirectory)`, and every relative path pinned resolves afterwards --
	// `./config.yaml`, `data/`, the tokenizer tree -- is therefore relative to the INSTALL ROOT, wherever the user
	// launched it from. GoTavern accepts being started from anywhere, and it used to forward the caller's CWD to the
	// path resolver, which produced a user-visible divergence measured on Linux and Windows: starting the binary
	// from the wrong folder left a fresh `config.yaml` AND a `data/` directory in that folder, while the server
	// served the install tree's data. Pinned cannot do that, because by the time it resolves anything the CWD *is*
	// the install tree.
	//
	// So the app boundary reproduces the chdir, in the only way that does not mutate process-global state: when the
	// caller passed no explicit path option, everything resolves as if the working directory were the install root.
	// An explicit `--configPath` or `--dataRoot` still wins, because a user who names a path means it.
	if options.InstallRoot != "" && !hasExplicitPathOption(options.Args) {
		options.WorkingDirectory = options.InstallRoot
	}
	// THE TRACE IS SET UP BEFORE ANY STAGE CAN BE SLOW, and the legacy wait is wrapped so its duration is
	// announced BEFORE it is spent: the pinned legacy path sits in a silent ten-second warning, and printing the
	// intention first is what turns "hung" into "waiting" for a user staring at a terminal.
	traceWriter := options.StartupTrace
	if traceWriter == nil {
		traceWriter = os.Stderr
	}
	trace := newStartupTracer(traceWriter)
	announceWait := options.WaitBeforeLegacyDataMove
	options.WaitBeforeLegacyDataMove = func(duration time.Duration) {
		trace.waitBeforeLegacyDataMove(duration)
		announceWait(duration)
	}

	trace.begin("command-line")
	parsed, err := commandline.ResolveCommandLine(commandline.ResolveOptions{
		Args:                options.Args,
		WorkingDirectory:    options.WorkingDirectory,
		ServerDirectory:     options.InstallRoot,
		ForceGlobalMode:     options.ForceGlobalMode,
		GlobalDataDirectory: options.GlobalDataDirectory,
	})
	trace.end()
	if err != nil {
		return nil, fmt.Errorf("resolve pinned command-line configuration: %w", err)
	}
	// THE TREE THE RUNTIME USES MUST EXIST, AND IT IS NOT ALWAYS THE ONE THE PARSER CREATED.
	//
	// pinned resolves every relative path after its own process.chdir(serverDirectory) (server.js:11), so for
	// pinned the directory it CREATES the data root in and the one it USES are the same. GoTavern accepts being
	// started from anywhere, and then the parser's creation path (rendered against the caller's working
	// directory, as the pinned probe recorded) and the runtime path (rendered against the install root) are two
	// different directories. The consequence was measured: on a fresh tree booted from a foreign CWD the
	// cookie-secret writer was the first thing to touch a directory nobody had made, and boot died with
	// "open <installRoot>/data/...tmp: no such file or directory" -- a boot that fails with no lock involved at
	// all (internal/adversarial violation boot.foreign-cwd-relative-data-root).
	//
	// Creating it HERE rather than inside the parser keeps every pinned-derived path expectation exact: the
	// parser's own fields, including its warnings, stay byte-identical. The error is causal and names both
	// directories, because "cannot create the data directory" without them is the message a user cannot act on.
	if runtimeRoot := parsed.Paths.RuntimeDataRoot; runtimeRoot != "" {
		if _, statErr := os.Stat(runtimeRoot); errors.Is(statErr, fs.ErrNotExist) {
			if mkdirErr := os.MkdirAll(runtimeRoot, 0o777); mkdirErr != nil {
				return nil, fmt.Errorf(
					"create the data directory the server will use (%s, resolved from dataRoot %q against the install root %s): %w",
					runtimeRoot, parsed.Paths.DataRoot, options.InstallRoot, mkdirErr)
			}
		} else if statErr != nil {
			return nil, fmt.Errorf("inspect the data directory the server will use (%s): %w", runtimeRoot, statErr)
		}
	}
	// THE PRIVATE ADDRESS FILTER IS INSTALLED FIRST, then the request proxy: that is pinned's order
	// (src/server-main.js:348 then :351) and it is observable, because with the filter enabled the
	// transport validates the address it is about to dial -- which, behind a proxy, is the PROXY's.
	// Neither call can fail the boot: pinned drops an invalid whitelist entry with a warning rather than
	// refusing to start, and a boot that failed here would turn a typo into an unreachable server.
	if filterErr := configurePrivateAddressFilter(parsed); filterErr != nil {
		return nil, filterErr
	}
	// APPLY THE USER'S CONFIGURED PROXY BEFORE ANY PROVIDER CAN BE CALLED.
	//
	// pinned parses requestProxy.enabled/url/bypass into its command-line options
	// (internal/commandline/options.go:231-233); until this call existed, nothing in GoTavern read them, so a
	// user whose only route to their provider is a proxy was unreachable no matter what their config said --
	// measured as transport.proxy-connect-ignored in internal/adversarial/violations.golden. A misconfigured
	// proxy fails the boot here, with a message naming the setting, rather than degrading later into
	// "cannot connect to server".
	if proxyErr := configureProviderProxy(parsed.Options); proxyErr != nil {
		return nil, proxyErr
	}
	// THE TWO OPTIONS THAT SHAPE THE TRANSPORT ITSELF, applied before any provider can be called:
	// `enableKeepAlive` (src/server-main.js:100-101, installed at module load in pinned) and
	// `dnsPreferIPv6` (src/server-main.js:481, `.then(setDnsResolutionOrder)` in the startup chain).
	// Neither can fail the boot: pinned's DNS call is wrapped in its own try/catch that only warns
	// (:475-476), and an unparseable keep-alive value resolves to false, which is the shipped default.
	configureProductionTransport(parsed)

	whitelistPage, _ := os.ReadFile(filepath.Join(parsed.Paths.RuntimeDataRoot, "_errors", "forbidden-by-whitelist.html"))

	trace.begin("data-startup")
	dataStartup, err := startup.InitializeDataStartupFromCommandLine(
		options.InstallRoot,
		parsed,
		options.Now,
		options.WaitBeforeLegacyDataMove,
	)
	if err != nil {
		var securityError startup.SecurityGateError
		if errors.As(err, &securityError) {
			return nil, &StartupError{
				Code:           securityError.ExitCode,
				Message:        "server startup stopped by the pinned security check",
				Cause:          err,
				SecurityEvents: dataStartup.Security.Events,
			}
		}
		return nil, fmt.Errorf("initialize pinned server data: %w", err)
	}
	trace.end()
	addresses := options.InterfaceAddresses
	if addresses == nil {
		addresses = systemInterfaceAddresses()
	}
	trace.begin("listeners")
	protocols, err := server.ResolveProtocolSelection(parsed.Options, addresses)
	if err != nil {
		return nil, &StartupError{Code: 1, Message: err.Error(), Cause: err}
	}

	var tlsConfig *tls.Config
	if optionEnabled(parsed.Options.SSL) {
		tlsConfig, err = loadTLSConfig(parsed.Options, options.InstallRoot)
		if err != nil {
			return nil, &StartupError{Code: 1, Message: err.Error(), Cause: err}
		}
	}

	trace.end()
	trace.begin("routes")
	handlerOptions := server.HTTPHandlerOptionsFromCommandLine(parsed)
	handlerOptions.InstallRoot = options.InstallRoot
	handlerOptions.Whitelist = loadWhitelistPatterns(handlerOptions.Whitelist, options.InstallRoot)
	handlerOptions.ForbiddenPage = whitelistPage
	handlerOptions.PreserveForbiddenPage = true
	if optionEnabled(parsed.StartupSettings.WhitelistDockerHosts) && runningInDocker() {
		handlerOptions.Whitelist = append(handlerOptions.Whitelist, dockerHostWhitelistEntries()...)
	}
	handler := server.NewHTTPHandlerWithOptions(handlerOptions)
	trace.end()
	running := &RunningServer{
		CommandLine: parsed,
		DataStartup: dataStartup,
		Protocols:   protocols,
		serveErrors: make(chan error, 2),
	}

	if protocols.UseIPv6 {
		if err := running.startFamily(parsed.Options, true, handler, tlsConfig); err != nil {
			running.ListenerFailures = append(running.ListenerFailures, ListenerFailure{IPv6: true, Err: err})
		} else {
			running.StartedIPv6 = true
		}
	}
	if protocols.UseIPv4 {
		if err := running.startFamily(parsed.Options, false, handler, tlsConfig); err != nil {
			running.ListenerFailures = append(running.ListenerFailures, ListenerFailure{IPv6: false, Err: err})
		} else {
			running.StartedIPv4 = true
		}
	}

	if len(running.listeners) == 0 {
		// Closed here so a failed listen is reported as the LAST STAGE THAT RAN rather than as a boot that
		// silently stopped: a failure path is exactly where a user needs to know how far it got.
		trace.end()
		return nil, running.listenerStartupError(protocols)
	}
	trace.begin("ready")
	trace.end()
	if interval := parsedHeartbeatInterval(parsed.Options.HeartbeatInterval); interval > 0 {
		running.heartbeat = startHeartbeat(parsed.Paths.RuntimeDataRoot, interval)
	}
	return running, nil
}

func loadWhitelistPatterns(configured []string, installRoot string) []string {
	path := filepath.Join(installRoot, "whitelist.txt")
	if _, err := os.Stat(path); err != nil {
		return append([]string(nil), configured...)
	}
	contents, err := os.ReadFile(path)
	if err != nil {
		return append([]string(nil), configured...)
	}
	lines := strings.Split(string(contents), "\n")
	patterns := make([]string, 0, len(lines))
	for _, line := range lines {
		if line != "" {
			patterns = append(patterns, strings.TrimSpace(line))
		}
	}
	return patterns
}

// dockerHostnames are the two names pinned resolves when whitelistDockerHosts is on and the process is in a
// container: src/middleware/whitelist.js:40 `const whitelistHosts = ['host.docker.internal',
// 'gateway.docker.internal']`, walked in that order at :42-50.
var dockerHostnames = []string{"host.docker.internal", "gateway.docker.internal"}

// dockerHostLookupTimeout bounds ONE of those resolutions.
//
// THE BOUND IS NOT PINNED'S, AND IT IS DELIBERATE. Pinned awaits `dns.promises.lookup` with no timeout of its
// own (:44), so a container whose DNS server accepts the question and never answers holds its startup for as
// long as the system resolver retries. AGENTS.md rule 24 forbids exactly that ("no unbounded resolver call"),
// docs/network-egress.md §3.4 states the requirement ("the only allowed startup network call ... must be
// bounded"), and docs/startup-state-machine.md §2 records the site as W10 with "no bound". Rule 24 outranks
// parity here, so each lookup gets this bound and a failure is non-fatal, which is pinned's own catch at
// :47-49 (`console.warn` and continue). The worst case added to a boot is therefore 2 x this value.
const dockerHostLookupTimeout = 2 * time.Second

// dockerHostWhitelistEntries resolves the two Docker hostnames and returns the addresses to whitelist.
//
// ONE ADDRESS PER NAME, exactly as pinned does: `dns.promises.lookup(entry)` without `all: true` returns a
// single address, and :46 pushes `result.address`. A name that fails to resolve, times out or answers with no
// address contributes nothing -- the same observable as pinned's catch block, minus the console line.
//
// WHY NO CONSOLE LINE IS ADDED HERE, stated instead of pointed at: pinned prints an info line on success
// (:45) and a warning on failure (:48), and neither is reproduced, because the boot's console output is
// compared against pinned-derived fixtures elsewhere and adding a line here would move bytes those fixtures
// own. The consequence is stated plainly: a lookup that times out is SILENT to a user. The startup trace is
// where such a warning belongs if it is ever wanted, and that is a parity change in its own right.
func dockerHostWhitelistEntries() []string {
	entries := make([]string, 0, len(dockerHostnames))
	for _, hostname := range dockerHostnames {
		ctx, cancel := context.WithTimeout(context.Background(), dockerHostLookupTimeout)
		addresses, err := net.DefaultResolver.LookupIPAddr(ctx, hostname)
		cancel()
		if err != nil || len(addresses) == 0 {
			continue
		}
		entries = append(entries, addresses[0].IP.String())
	}
	return entries
}

// runningInDocker reports whether this process is in a container, which is pinned's `isDocker()` gate on the
// docker-hostname resolution.
func runningInDockerProbe() bool {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	contents, err := os.ReadFile("/proc/self/cgroup")
	return err == nil && strings.Contains(string(contents), "docker")
}

// runningInDocker is a VARIABLE so the startup-egress gate can drive BOTH sides of the branch on a host that
// is not in a container: `internal/app/startup_egress_test.go` runs the allowed case (the two names resolved,
// recorded by name) and the zero-egress case (neither resolved) against the REAL Start. Without the seam the
// allowed case could only be asserted where a container exists, i.e. never on the CI runner that judges it,
// and a gate that cannot reach its own allowed branch is decoration (AGENTS.md rule 7).
//
// THE PRECEDENT IS THE PROJECT'S OWN: internal/outbound/dnsorder.go:40-46 makes its resolver a variable for
// the same reason, and its comment says "It is never assigned outside a test". The only writer is a test;
// production code reads it.
var runningInDocker = runningInDockerProbe

// ServeErrors receives an unexpected error after a listener has started.
func (running *RunningServer) ServeErrors() <-chan error { return running.serveErrors }

// Listeners returns the successfully bound sockets in IPv6-then-IPv4 startup
// order.
func (running *RunningServer) Listeners() []net.Listener {
	return append([]net.Listener(nil), running.listeners...)
}

// Close gracefully stops all listeners. It may be called more than once.
func (running *RunningServer) Close(ctx context.Context) error {
	if running.heartbeat != nil {
		running.heartbeat.stop()
	}
	var errs []error
	for index := len(running.httpServers) - 1; index >= 0; index-- {
		if err := running.httpServers[index].Shutdown(ctx); err != nil {
			errs = append(errs, err)
		}
	}
	for _, listener := range running.listeners {
		if err := listener.Close(); err != nil && !errors.Is(err, net.ErrClosed) {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

func (running *RunningServer) startFamily(options commandline.ServerOptions, ipv6 bool, handler http.Handler, tlsConfig *tls.Config) error {
	listenURL, err := familyListenURL(options, ipv6)
	if err != nil {
		return err
	}
	listener, err := listenFamily(listenURL, ipv6)
	if err != nil {
		return err
	}
	serveListener := listener
	if tlsConfig != nil {
		serveListener = tls.NewListener(listener, tlsConfig)
	}
	httpServer := &http.Server{Handler: handler}
	running.listeners = append(running.listeners, listener)
	running.httpServers = append(running.httpServers, httpServer)
	go func() {
		if err := httpServer.Serve(serveListener); err != nil && !errors.Is(err, http.ErrServerClosed) {
			running.serveErrors <- err
		}
	}()
	return nil
}

func (running *RunningServer) listenerStartupError(protocols server.ProtocolSelection) error {
	failedIPv6, failedIPv4 := false, false
	var ipv6Err, ipv4Err error
	for _, failure := range running.ListenerFailures {
		if failure.IPv6 {
			failedIPv6, ipv6Err = true, failure.Err
		} else {
			failedIPv4, ipv4Err = true, failure.Err
		}
	}
	switch {
	case failedIPv6 && !protocols.UseIPv4 && isAddressInUse(ipv6Err):
		return &StartupError{Code: 1, Message: "Error: Startup aborted because IPv6 is the only enabled protocol and its listen port is already in use.", Cause: ipv6Err}
	case failedIPv6 && !protocols.UseIPv4:
		return &StartupError{Code: 1, Message: "Error: Failed to start server on IPv6 and IPv4 disabled", Cause: ipv6Err}
	case failedIPv4 && !protocols.UseIPv6 && isAddressInUse(ipv4Err):
		return &StartupError{Code: 1, Message: "Error: Startup aborted because IPv4 is the only enabled protocol and its listen port is already in use.", Cause: ipv4Err}
	case failedIPv4 && !protocols.UseIPv6:
		return &StartupError{Code: 1, Message: "Error: Failed to start server on IPv4 and IPv6 disabled", Cause: ipv4Err}
	case failedIPv6 && failedIPv4 && isAddressInUse(ipv6Err) && isAddressInUse(ipv4Err):
		return &StartupError{Code: 1, Message: "Error: Failed to start server because the configured IPv6 and IPv4 listen ports are already in use.", Cause: errors.Join(ipv6Err, ipv4Err)}
	default:
		return &StartupError{Code: 1, Message: "Error: Failed to start server on both IPv6 and IPv4", Cause: errors.Join(ipv6Err, ipv4Err)}
	}
}

func systemInterfaceAddresses() []net.Addr {
	interfaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	var addresses []net.Addr
	for _, networkInterface := range interfaces {
		interfaceAddresses, err := networkInterface.Addrs()
		if err != nil {
			continue
		}
		addresses = append(addresses, interfaceAddresses...)
	}
	return addresses
}

func familyListenURL(options commandline.ServerOptions, ipv6 bool) (string, error) {
	if ipv6 {
		return options.IPv6ListenURL()
	}
	return options.IPv4ListenURL()
}

func listenFamily(rawURL string, ipv6 bool) (net.Listener, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" || parsed.Hostname() == "" {
		return nil, fmt.Errorf("invalid listener URL %q", rawURL)
	}
	port := parsed.Port()
	if port == "" {
		port = defaultPort(parsed.Scheme)
	}
	address := net.JoinHostPort(parsed.Hostname(), port)
	network := "tcp4"
	if ipv6 {
		network = "tcp6"
	}
	config := net.ListenConfig{}
	if ipv6 {
		config.Control = setIPv6Only
	}
	return config.Listen(context.Background(), network, address)
}

func loadTLSConfig(options commandline.ServerOptions, installRoot string) (*tls.Config, error) {
	certPath := optionString(options.CertPath)
	if certPath == "" {
		return nil, errors.New("Error: SSL certificate path is required when using HTTPS. Check your config")
	}
	keyPath := optionString(options.KeyPath)
	if keyPath == "" {
		return nil, errors.New("Error: SSL key path is required when using HTTPS. Check your config")
	}
	if !filepath.IsAbs(certPath) {
		certPath = filepath.Join(installRoot, certPath)
	}
	if !filepath.IsAbs(keyPath) {
		keyPath = filepath.Join(installRoot, keyPath)
	}
	if _, err := os.Stat(certPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("Error: SSL certificate path does not exist")
		}
		return nil, fmt.Errorf("inspect SSL certificate: %w", err)
	}
	if _, err := os.Stat(keyPath); err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, errors.New("Error: SSL key path does not exist")
		}
		return nil, fmt.Errorf("inspect SSL key: %w", err)
	}
	certificateBytes, err := os.ReadFile(certPath)
	if err != nil {
		return nil, fmt.Errorf("read SSL certificate: %w", err)
	}
	keyBytes, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("read SSL key: %w", err)
	}
	passphrase := optionString(options.KeyPassphrase)
	if passphrase != "" {
		keyBytes, err = decryptLegacyPEMKey(keyBytes, passphrase)
		if err != nil {
			return nil, fmt.Errorf("decrypt SSL private key: %w", err)
		}
	}
	certificate, err := tls.X509KeyPair(certificateBytes, keyBytes)
	if err != nil {
		return nil, fmt.Errorf("load SSL certificate and key: %w", err)
	}
	return &tls.Config{Certificates: []tls.Certificate{certificate}, MinVersion: tls.VersionTLS12}, nil
}

func decryptLegacyPEMKey(keyBytes []byte, passphrase string) ([]byte, error) {
	block, rest := pem.Decode(keyBytes)
	if block == nil {
		return nil, errors.New("private key is not a PEM block")
	}
	if x509.IsEncryptedPEMBlock(block) {
		decrypted, err := x509.DecryptPEMBlock(block, []byte(passphrase))
		if err != nil {
			return nil, err
		}
		block.Bytes = decrypted
		block.Headers = nil
		return append(pem.EncodeToMemory(block), rest...), nil
	}
	if block.Type == "ENCRYPTED PRIVATE KEY" {
		return nil, errors.New("encrypted PKCS#8 private keys are not supported yet")
	}
	return keyBytes, nil
}

func optionEnabled(value any) bool {
	switch typed := value.(type) {
	case nil:
		return false
	case bool:
		return typed
	case string:
		return typed != ""
	case float64:
		return typed != 0
	case int:
		return typed != 0
	default:
		return true
	}
}

func optionString(value any) string {
	if typed, ok := value.(string); ok {
		return typed
	}
	if value == nil {
		return ""
	}
	return strings.TrimSpace(fmt.Sprint(value))
}

func defaultPort(scheme string) string {
	if scheme == "https" {
		return strconv.Itoa(443)
	}
	return strconv.Itoa(80)
}
