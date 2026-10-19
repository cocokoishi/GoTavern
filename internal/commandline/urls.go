package commandline

import (
	"math"
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

var (
	ipv4ListenAddressPattern = regexp.MustCompile(`^(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]\d|\d)){3}$`)
	ipv6ZonePattern          = regexp.MustCompile(`^[0-9a-zA-Z]+$`)
)

// InvalidURL is the Go error corresponding to Node's TypeError("Invalid URL")
// for the URLs constructed by CommandLineParser.
type InvalidURL struct{}

func (InvalidURL) Error() string { return "Invalid URL" }

// IPv4ListenURL returns the URL constructed by the pinned parser for its
// IPv4 listener. The URL's host is a bind address when listen mode is enabled
// and loopback otherwise.
func (options ServerOptions) IPv4ListenURL() (string, error) {
	host := "127.0.0.1"
	if jsBoolean(options.Listen) {
		host = "0.0.0.0"
		address := jsString(options.ListenAddressIPv4)
		if ipv4ListenAddressPattern.MatchString(address) {
			host = address
		}
	}
	return parseConstructedURL(options, host)
}

// IPv6ListenURL returns the URL constructed by the pinned parser for its
// IPv6 listener. Its IPv6 validation follows ip-regex@5's exact address
// contract; Node then parses the concatenated address as a WHATWG URL.
func (options ServerOptions) IPv6ListenURL() (string, error) {
	host := "[::1]"
	if jsBoolean(options.Listen) {
		host = "[::]"
		address := jsString(options.ListenAddressIPv6)
		if validIPv6ListenAddress(address) {
			host = address
		}
	}
	return parseConstructedURL(options, host)
}

// BrowserLaunchHostname implements the pinned auto-hostname selection after
// listener startup has determined which protocols are available.
func (options ServerOptions) ResolveBrowserLaunchHostname(useIPv6, useIPv4 bool) any {
	hostname, isAuto := options.BrowserLaunchHostname.(string)
	if !isAuto || hostname != "auto" {
		return options.BrowserLaunchHostname
	}
	if useIPv6 && useIPv4 {
		if jsBoolean(options.BrowserLaunchAvoidLocalhost) {
			return "[::1]"
		}
		return "localhost"
	}
	if useIPv6 {
		return "[::1]"
	}
	if useIPv4 {
		return "127.0.0.1"
	}
	return options.BrowserLaunchHostname
}

// BrowserLaunchURL returns the pinned URL for the supplied launch hostname.
func (options ServerOptions) BrowserLaunchURL(hostname any) (string, error) {
	port := options.Port
	if jsNumber(options.BrowserLaunchPort) >= 0 {
		port = options.BrowserLaunchPort
	}
	return parseConstructedURLWithPort(options, jsString(hostname), port)
}

func parseConstructedURL(options ServerOptions, host string) (string, error) {
	return parseConstructedURLWithPort(options, host, options.Port)
}

func parseConstructedURLWithPort(options ServerOptions, host string, portValue any) (string, error) {
	scheme := "http"
	if jsBoolean(options.SSL) {
		scheme = "https"
	}
	raw := scheme + "://" + host + ":" + jsString(portValue)
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.Opaque != "" {
		return "", InvalidURL{}
	}
	if parsed.Hostname() == "" || (strings.Contains(parsed.Hostname(), ":") && !strings.HasPrefix(parsed.Host, "[")) {
		return "", InvalidURL{}
	}
	port := parsed.Port()
	if port != "" {
		number, err := strconv.ParseUint(port, 10, 16)
		if err != nil {
			return "", InvalidURL{}
		}
		port = strconv.FormatUint(number, 10)
		if (scheme == "http" && port == "80") || (scheme == "https" && port == "443") {
			port = ""
		}
	}
	hostname := strings.ToLower(parsed.Hostname())
	if strings.Contains(hostname, ":") {
		hostname = "[" + hostname + "]"
	}
	if port != "" {
		hostname += ":" + port
	}
	parsed.Host = hostname
	if parsed.Path == "" {
		parsed.Path = "/"
	}
	return parsed.String(), nil
}

func validIPv6ListenAddress(address string) bool {
	ipAddress := address
	if strings.Contains(address, "%") {
		var zone string
		var found bool
		ipAddress, zone, found = strings.Cut(address, "%")
		if !found || !ipv6ZonePattern.MatchString(zone) || strings.Contains(zone, "%") {
			return false
		}
	}
	parsed := net.ParseIP(ipAddress)
	return parsed != nil && strings.Contains(ipAddress, ":")
}

func jsNumber(value any) float64 {
	switch typed := value.(type) {
	case nil:
		return 0
	case bool:
		if typed {
			return 1
		}
		return 0
	case int:
		return float64(typed)
	case int64:
		return float64(typed)
	case uint64:
		return float64(typed)
	case float64:
		return typed
	case string:
		return jsStringNumber(typed)
	case []any:
		return jsStringNumber(jsString(typed))
	default:
		return math.NaN()
	}
}

func jsStringNumber(value string) float64 {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	number, err := strconv.ParseFloat(value, 64)
	if err == nil {
		return number
	}
	return math.NaN()
}
