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
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/cocokoishi/gotavern/internal/commandline"
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
}

// Start follows the pre-listener data startup before constructing the HTTP
// handler and binding IPv6 then IPv4 listeners, in the pinned order.
func Start(options StartOptions) (*RunningServer, error) {
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

	parsed, err := commandline.ResolveCommandLine(commandline.ResolveOptions{
		Args:                options.Args,
		WorkingDirectory:    options.WorkingDirectory,
		ServerDirectory:     options.InstallRoot,
		ForceGlobalMode:     options.ForceGlobalMode,
		GlobalDataDirectory: options.GlobalDataDirectory,
	})
	if err != nil {
		return nil, fmt.Errorf("resolve pinned command-line configuration: %w", err)
	}
	whitelistPage, _ := os.ReadFile(filepath.Join(parsed.Paths.RuntimeDataRoot, "_errors", "forbidden-by-whitelist.html"))

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
	if optionEnabled(parsed.StartupSettings.HostWhitelistEnabled) {
		return nil, &StartupError{Code: 1, Message: "hostWhitelist.enabled is configured, but the pinned host-validation middleware is not implemented"}
	}
	if optionEnabled(parsed.Options.Listen) && optionEnabled(parsed.Options.BasicAuthMode) && optionEnabled(parsed.StartupSettings.PerUserBasicAuth) && optionEnabled(parsed.StartupSettings.EnableUserAccounts) {
		return nil, &StartupError{Code: 1, Message: "perUserBasicAuth is enabled with accounts, but the pinned Basic Auth user-store middleware is not implemented"}
	}

	addresses := options.InterfaceAddresses
	if addresses == nil {
		addresses = systemInterfaceAddresses()
	}
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

	handlerOptions := server.HTTPHandlerOptionsFromCommandLine(parsed)
	handlerOptions.Whitelist = loadWhitelistPatterns(handlerOptions.Whitelist, options.InstallRoot)
	handlerOptions.ForbiddenPage = whitelistPage
	handlerOptions.PreserveForbiddenPage = true
	if optionEnabled(parsed.StartupSettings.WhitelistDockerHosts) && runningInDocker() {
		for _, hostname := range []string{"host.docker.internal", "gateway.docker.internal"} {
			if addresses, err := net.LookupIP(hostname); err == nil && len(addresses) > 0 {
				handlerOptions.Whitelist = append(handlerOptions.Whitelist, addresses[0].String())
			}
		}
	}
	handler := server.NewHTTPHandlerWithOptions(handlerOptions)
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
		return nil, running.listenerStartupError(protocols)
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

func runningInDocker() bool {
	if _, err := os.Stat("/.dockerenv"); err == nil {
		return true
	}
	contents, err := os.ReadFile("/proc/self/cgroup")
	return err == nil && strings.Contains(string(contents), "docker")
}

// ServeErrors receives an unexpected error after a listener has started.
func (running *RunningServer) ServeErrors() <-chan error { return running.serveErrors }

// Listeners returns the successfully bound sockets in IPv6-then-IPv4 startup
// order.
func (running *RunningServer) Listeners() []net.Listener {
	return append([]net.Listener(nil), running.listeners...)
}

// Close gracefully stops all listeners. It may be called more than once.
func (running *RunningServer) Close(ctx context.Context) error {
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

func isAddressInUse(err error) bool {
	return errors.Is(err, syscall.EADDRINUSE)
}

func defaultPort(scheme string) string {
	if scheme == "https" {
		return strconv.Itoa(443)
	}
	return strconv.Itoa(80)
}
