package server

import (
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const maximumScannedHosts = 1000

type hostWhitelistRuntime struct {
	options HTTPHandlerOptions
	mu      sync.Mutex
	known   map[string]struct{}
}

func newHostWhitelistRuntime(options HTTPHandlerOptions) *hostWhitelistRuntime {
	return &hostWhitelistRuntime{options: options, known: make(map[string]struct{})}
}

// allow mirrors the pinned hostWhitelist middleware. Scan warnings happen
// before enforcement and are emitted only once per raw Host value.
func (runtime *hostWhitelistRuntime) allow(writer http.ResponseWriter, request *http.Request) bool {
	host := request.Host
	allowed := host == "" || isPinnedHostAllowed(host, runtime.options.HostWhitelistHosts)
	if runtime.options.HostWhitelistScan && host != "" && !allowed {
		runtime.warnOnce(host)
	}
	if !runtime.options.HostWhitelistEnabled || allowed {
		return true
	}

	var body []byte
	if runtime.options.DataRoot != "" {
		body, _ = os.ReadFile(filepath.Join(runtime.options.DataRoot, "_errors", "host-not-allowed.html"))
	}
	writer.Header().Set("Content-Type", "text/html")
	writer.WriteHeader(http.StatusForbidden)
	_ = http.NewResponseController(writer).Flush()
	if request.Method != http.MethodHead {
		_, _ = writer.Write(body)
	}
	return false
}

func (runtime *hostWhitelistRuntime) warnOnce(host string) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if _, found := runtime.known[host]; found || len(runtime.known) >= maximumScannedHosts {
		return
	}
	firstWarning := len(runtime.known) == 0
	runtime.known[host] = struct{}{}

	writer := runtime.options.hostWhitelistWarningWriter
	if writer == nil {
		writer = os.Stderr
	}
	fmt.Fprintln(writer, "Request from untrusted host:", host)
	fmt.Fprintln(writer, "If you trust this host, you can add it to hostWhitelist.hosts in config.yaml")
	if !runtime.options.HostWhitelistEnabled && firstWarning {
		fmt.Fprintln(writer, "To protect against host spoofing, consider setting hostWhitelist.enabled to true")
	}
	if firstWarning {
		fmt.Fprintln(writer, "To disable this warning, set hostWhitelist.scan to false")
	}
}

func isPinnedHostAllowed(hostHeader string, allowedHosts []string) bool {
	// net/http uses an empty Request.Host for the Node undefined-header case.
	if hostHeader == "" {
		return true
	}
	if hasAllowedProtocolPrefix(hostHeader) {
		return true
	}

	trimmedHost := strings.TrimSpace(hostHeader)
	var hostname string
	if strings.HasPrefix(trimmedHost, "[") {
		endIPv6 := strings.IndexByte(trimmedHost, ']')
		if endIPv6 < 0 {
			return false
		}
		address := trimmedHost[1:endIPv6]
		parsed := net.ParseIP(address)
		if parsed == nil || !strings.Contains(address, ":") {
			return false
		}
		return true
	}

	colonPosition := strings.IndexByte(trimmedHost, ':')
	if colonPosition >= 0 {
		hostname = trimmedHost[:colonPosition]
	} else {
		hostname = trimmedHost
	}
	if address := net.ParseIP(hostname); address != nil && address.To4() != nil {
		return true
	}
	if hostname == "localhost" || strings.HasSuffix(hostname, ".localhost") {
		return true
	}
	for _, allowedHost := range allowedHosts {
		if allowedHost == hostname {
			return true
		}
		if strings.HasPrefix(allowedHost, ".") && (strings.TrimPrefix(allowedHost, ".") == hostname || strings.HasSuffix(hostname, allowedHost)) {
			return true
		}
	}
	return false
}

func hasAllowedProtocolPrefix(hostHeader string) bool {
	colonPosition := strings.IndexByte(hostHeader, ':')
	if colonPosition < 0 {
		return false
	}
	protocol := strings.ToLower(hostHeader[:colonPosition])
	return protocol == "file" || (len(protocol) > len("-extension") && strings.HasSuffix(protocol, "-extension"))
}
