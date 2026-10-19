package server

import (
	"bytes"
	"fmt"
	"html"
	"net"
	"net/http"
	"net/netip"
	"strconv"
	"strings"
)

type ipMatcher struct {
	family  int
	value   [16]byte
	mask    [16]byte
	lower   [16]byte
	upper   [16]byte
	rangeIP bool
}

func requestPassesWhitelist(request *http.Request, options HTTPHandlerOptions) (bool, string) {
	clientIP := requestClientIP(request)
	forwardedIP := ""
	if options.ForwardedWhitelist {
		forwardedIP = realOrForwardedIP(request, options)
	}
	details := clientIP
	if forwardedIP != "" {
		details += " (forwarded from " + forwardedIP + ")"
	}
	if !matchesAnyIP(options.Whitelist, clientIP) {
		return false, details
	}
	if forwardedIP != "" && !matchesAnyIP(options.Whitelist, forwardedIP) {
		return false, details
	}
	return true, ""
}

func requestClientIP(request *http.Request) string {
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		host = request.RemoteAddr
	}
	address, err := netip.ParseAddr(strings.Trim(host, "[]"))
	if err != nil {
		return "unknown"
	}
	address = address.WithZone("")
	if address.Is4In6() {
		address = address.Unmap()
	}
	return address.String()
}

func realOrForwardedIP(request *http.Request, options HTTPHandlerOptions) string {
	if enabledOption(options.ForwardedXRealIP, true) {
		if value := strings.Join(request.Header.Values("X-Real-IP"), ", "); value != "" {
			return value
		}
	}
	if enabledOption(options.ForwardedCFConnectingIP, false) {
		if value := strings.Join(request.Header.Values("CF-Connecting-IP"), ", "); value != "" {
			return value
		}
	}
	if enabledOption(options.ForwardedXForwardedFor, true) {
		if value := strings.Join(request.Header.Values("X-Forwarded-For"), ", "); value != "" {
			first, _, _ := strings.Cut(value, ",")
			return strings.TrimSpace(first)
		}
	}
	return ""
}

func enabledOption(value *bool, fallback bool) bool {
	if value == nil {
		return fallback
	}
	return *value
}

func matchesAnyIP(patterns []string, rawIP string) bool {
	address, err := parseAddress(rawIP)
	if err != nil {
		return false
	}
	for _, pattern := range patterns {
		matcher, ok := parseIPMatcher(pattern)
		if ok && matcher.matches(address) {
			return true
		}
	}
	return false
}

func parseIPMatcher(input string) (ipMatcher, bool) {
	input = strings.TrimSpace(input)
	if input == "" {
		return ipMatcher{}, false
	}

	if strings.Contains(input, "-") {
		parts := strings.Split(input, "-")
		if len(parts) != 2 {
			return ipMatcher{}, false
		}
		lower, err := parseAddress(parts[0])
		if err != nil {
			return ipMatcher{}, false
		}
		upper, err := parseAddress(parts[1])
		if err != nil || addressFamily(lower) != addressFamily(upper) {
			return ipMatcher{}, false
		}
		lowerBytes, family := addressBytes(lower)
		upperBytes, _ := addressBytes(upper)
		if bytes.Compare(lowerBytes[:family], upperBytes[:family]) > 0 {
			return ipMatcher{}, false
		}
		return ipMatcher{family: family, lower: lowerBytes, upper: upperBytes, rangeIP: true}, true
	}

	if strings.Contains(input, "/") {
		parts := strings.Split(input, "/")
		if len(parts) != 2 {
			return ipMatcher{}, false
		}
		address, err := parseAddress(parts[0])
		if err != nil {
			return ipMatcher{}, false
		}
		base, family := addressBytes(address)
		mask := [16]byte{}
		if prefixBits, ok := parsePrefixBits(parts[1]); ok {
			if prefixBits < 0 || prefixBits > family*8 {
				return ipMatcher{}, false
			}
			for index := 0; index < prefixBits/8; index++ {
				mask[index] = 0xff
			}
			if remainder := prefixBits % 8; remainder != 0 {
				mask[prefixBits/8] = byte(0xff << (8 - remainder))
			}
		} else {
			maskAddress, err := parseAddress(parts[1])
			if err != nil || addressFamily(maskAddress) != family {
				return ipMatcher{}, false
			}
			mask, _ = addressBytes(maskAddress)
		}
		for index := 0; index < family; index++ {
			base[index] &= mask[index]
		}
		return ipMatcher{family: family, value: base, mask: mask}, true
	}

	if strings.Contains(input, "*") {
		if !strings.Contains(input, ":") {
			parts := strings.Split(input, ".")
			if len(parts) != 4 {
				return ipMatcher{}, false
			}
			matcher := ipMatcher{family: 4}
			for index, part := range parts {
				if part == "*" {
					continue
				}
				value, ok := parseUnsignedDecimal(part, 255)
				if !ok {
					return ipMatcher{}, false
				}
				matcher.value[index] = byte(value)
				matcher.mask[index] = 0xff
			}
			return matcher, true
		}
		matcher, ok := parseIPv6Wildcard(input)
		return matcher, ok
	}

	address, err := parseAddress(input)
	if err != nil {
		return ipMatcher{}, false
	}
	value, family := addressBytes(address)
	mask := [16]byte{}
	for index := 0; index < family; index++ {
		mask[index] = 0xff
	}
	return ipMatcher{family: family, value: value, mask: mask}, true
}

func parseIPv6Wildcard(input string) (ipMatcher, bool) {
	if strings.Contains(input, ".") {
		return ipMatcher{}, false
	}
	sides := strings.Split(input, "::")
	if len(sides) > 2 {
		return ipMatcher{}, false
	}
	var groups []string
	if len(sides) == 1 {
		groups = strings.Split(sides[0], ":")
		if len(groups) != 8 {
			return ipMatcher{}, false
		}
	} else {
		var left, right []string
		if sides[0] != "" {
			left = strings.Split(sides[0], ":")
		}
		if sides[1] != "" {
			right = strings.Split(sides[1], ":")
		}
		zeroGroups := 8 - len(left) - len(right)
		if zeroGroups < 1 {
			return ipMatcher{}, false
		}
		groups = append(groups, left...)
		for index := 0; index < zeroGroups; index++ {
			groups = append(groups, "0")
		}
		groups = append(groups, right...)
	}
	if len(groups) != 8 {
		return ipMatcher{}, false
	}
	matcher := ipMatcher{family: 16}
	for index, group := range groups {
		if group == "*" {
			continue
		}
		value, ok := parseUnsignedHex(group, 0xffff)
		if !ok {
			return ipMatcher{}, false
		}
		matcher.value[index*2] = byte(value >> 8)
		matcher.value[index*2+1] = byte(value)
		matcher.mask[index*2] = 0xff
		matcher.mask[index*2+1] = 0xff
	}
	return matcher, true
}

func parseAddress(value string) (netip.Addr, error) {
	value = strings.TrimSpace(value)
	if strings.Contains(value, ".") && !strings.Contains(value, ":") {
		parts := strings.Split(value, ".")
		if len(parts) == 4 {
			var bytes [4]byte
			for index, part := range parts {
				number, ok := parseUnsignedDecimal(part, 255)
				if !ok {
					return netip.Addr{}, fmt.Errorf("invalid IPv4 address %q", value)
				}
				bytes[index] = byte(number)
			}
			return netip.AddrFrom4(bytes), nil
		}
	}
	if strings.Contains(value, ":") && strings.Contains(value, ".") {
		lastColon := strings.LastIndex(value, ":")
		tail := value[lastColon+1:]
		ip, err := parseAddress(tail)
		if err == nil && ip.Is4() {
			value = value[:lastColon+1] + ip.String()
		} else {
			return netip.Addr{}, fmt.Errorf("invalid mixed IPv6 address %q", value)
		}
	}
	address, err := netip.ParseAddr(value)
	if err == nil && address.Zone() != "" {
		return netip.Addr{}, fmt.Errorf("IPv6 zones are not accepted in whitelist IPs")
	}
	return address, err
}

func parsePrefixBits(value string) (int, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0, true
	}
	if number, err := strconv.Atoi(value); err == nil {
		return number, true
	}
	if strings.HasPrefix(value, "0x") || strings.HasPrefix(value, "0X") {
		number, err := strconv.ParseUint(value[2:], 16, 31)
		return int(number), err == nil
	}
	return 0, false
}

func parseUnsignedDecimal(value string, maximum int) (int, bool) {
	if value == "" {
		return 0, false
	}
	for _, character := range value {
		if character < '0' || character > '9' {
			return 0, false
		}
	}
	number, err := strconv.Atoi(value)
	return number, err == nil && number <= maximum
}

func parseUnsignedHex(value string, maximum uint64) (uint64, bool) {
	if value == "" {
		return 0, false
	}
	for _, character := range value {
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')) {
			return 0, false
		}
	}
	number, err := strconv.ParseUint(value, 16, 16)
	return number, err == nil && number <= maximum
}

func addressFamily(address netip.Addr) int {
	if address.Is4() {
		return 4
	}
	return 16
}

func addressBytes(address netip.Addr) ([16]byte, int) {
	var result [16]byte
	if address.Is4() {
		bytes := address.As4()
		copy(result[:4], bytes[:])
		return result, 4
	}
	bytes := address.As16()
	copy(result[:], bytes[:])
	return result, 16
}

func (matcher ipMatcher) matches(address netip.Addr) bool {
	value, family := addressBytes(address)
	if matcher.family != family {
		return false
	}
	if matcher.rangeIP {
		return bytes.Compare(value[:family], matcher.lower[:family]) >= 0 && bytes.Compare(value[:family], matcher.upper[:family]) <= 0
	}
	for index := 0; index < family; index++ {
		if value[index]&matcher.mask[index] != matcher.value[index] {
			return false
		}
	}
	return true
}

func serveWhitelistForbidden(writer http.ResponseWriter, request *http.Request, page []byte, ipDetails string) {
	body := bytes.ReplaceAll(page, []byte("{{ipDetails}}"), []byte(escapeHandlebars(ipDetails)))
	writer.Header().Set("Content-Type", "text/html; charset=utf-8")
	writer.Header().Set("Content-Length", strconv.Itoa(len(body)))
	writer.Header().Set("ETag", expressWeakETag(body))
	writer.WriteHeader(http.StatusForbidden)
	if request.Method != http.MethodHead {
		_, _ = writer.Write(body)
	}
}

func escapeHandlebars(value string) string {
	escaped := html.EscapeString(value)
	return strings.ReplaceAll(escaped, "&#39;", "&#x27;")
}
