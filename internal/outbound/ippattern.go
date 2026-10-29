package outbound

// THE WHITELIST PATTERN GRAMMAR of privateAddressWhitelist.allowedRanges.
//
// pinned parses every entry with `ipMatch.getMatch(entry)` from the `ip-matching` package
// (src/private-request-filter.js:79) after `filterValidIpPatterns` has dropped the ones that throw
// (src/express-common.js:92-112). The grammar is therefore the PACKAGE's, not ours, and it is larger than
// "CIDR": the forms below were PROBED against the pinned checkout's own copy of the package rather than
// inferred from its source. The probe (run with cwd inside the pinned SillyTavern, which writes nothing):
//
//	node -e "const m=require('ip-matching'); for (const [p,ip] of [['10.0.0.0/8','10.1.2.3'],...])
//	          console.log(p, ip, m.getMatch(p).matches(ip))"
//
// and its measured answers, which the table test in ippattern_test.go reproduces row for row:
//
//	10.0.0.0/8        10.1.2.3              true        CIDR
//	10.0.0.0/8        11.0.0.1              false
//	192.168.*.*       192.168.1.5           true        wildcard octet
//	192.168.*.*       192.169.1.5           false
//	192.168.*.*       192.168.255.255       true
//	*.168.1.1         10.168.1.1            true        a leading wildcard is legal
//	10.*.0.1          10.9.0.1              true
//	*.*.*.*           8.8.8.8               true
//	::1/128           ::1                   true
//	::1/128           0:0:0:0:0:0:0:1       true
//	fc00::/7          fd12::1               true
//	fe80::/10         fe80::1               true
//	2001:db8::/32     2001:db8::1           true
//	2001:*:*:*:*:*:*:* 2001:db8::1          true        wildcard hextet
//	10.0.0.5          10.0.0.5              true        exact
//	10.0.0.5          10.0.0.6              false
//	10.0.0.1-10.0.0.9 10.0.0.5              true        numeric range
//	10.0.0.0/255.0.0.0 10.1.1.1             true        mask form
//	172.16.0.0/12     172.31.255.255        true
//	172.16.0.0/12     172.32.0.1            false
//	169.254.0.0/16    169.254.1.1           true
//	127.0.0.0/8       127.0.0.1             true
//
// ONE MEASURED PROPERTY OF THE PACKAGE IS NOT REPRODUCED, DELIBERATELY AND VISIBLY: `ip-matching` matches
// by FAMILY, so `10.0.0.0/8` does NOT match `::ffff:10.0.0.1` (measured: false; the package parses the
// mixed form as an IPv6 and refuses a cross-family match). Reproducing that would let a v4-mapped address
// walk past a v4 whitelist entry, which is the same hole as letting it walk past a v4 PRIVATE range. So
// this file keeps the family rule for patterns, and `privateAddressFilter.allows` additionally tests the
// canonical (unmapped) form, which is what makes `10.0.0.0/8` cover `::ffff:10.0.0.1`. See
// privatefilter.go, where that decision and its reason are recorded in one place.

import (
	"errors"
	"fmt"
	"net/netip"
	"strconv"
	"strings"
)

// ipPattern is one parsed allowedRanges entry.
type ipPattern interface {
	// matches reports whether the address is covered. The address is tested in the family the pattern
	// declares, so a v4 pattern never matches a native v6 address (pinned's own rule).
	matches(address netip.Addr) bool
	// String renders the pattern the way the pinned log line does: for a subnetwork, `maskedBase/bits`.
	String() string
}

// maskPattern covers every form that is expressible as "value under a bit mask": an exact address
// (mask all ones), a wildcard octet or hextet (that octet's mask is zero), a CIDR prefix (leading ones)
// and a mask entry `IP/maskIP` (the mask's own bits).
type maskPattern struct {
	ipv6  bool
	value [16]byte
	mask  [16]byte
	text  string
}

func (pattern maskPattern) matches(address netip.Addr) bool {
	raw, ok := patternBytes(address, pattern.ipv6)
	if !ok {
		return false
	}
	for index := range raw {
		if raw[index]&pattern.mask[index] != pattern.value[index] {
			return false
		}
	}
	return true
}

func (pattern maskPattern) String() string { return pattern.text }

// rangePattern is the `IP1-IP2` form, which is a numeric interval rather than a mask.
type rangePattern struct {
	ipv6 bool
	low  [16]byte
	high [16]byte
	text string
}

func (pattern rangePattern) matches(address netip.Addr) bool {
	raw, ok := patternBytes(address, pattern.ipv6)
	if !ok {
		return false
	}
	return bytesLessOrEqual(pattern.low[:], raw) && bytesLessOrEqual(raw, pattern.high[:])
}

func (pattern rangePattern) String() string { return pattern.text }

// patternBytes returns the address in the family the pattern declares, or false when the families differ.
// It does NOT unmap a v4-mapped address: that is the caller's decision, and privatefilter.go makes it
// explicit rather than hiding it here.
func patternBytes(address netip.Addr, ipv6 bool) ([]byte, bool) {
	if !address.IsValid() {
		return nil, false
	}
	if address.Is4() {
		if ipv6 {
			return nil, false
		}
		bytes := address.As4()
		return bytes[:], true
	}
	if !ipv6 {
		return nil, false
	}
	bytes := address.As16()
	return bytes[:], true
}

func bytesLessOrEqual(left, right []byte) bool {
	for index := range left {
		if left[index] != right[index] {
			return left[index] < right[index]
		}
	}
	return true
}

// parseIPPattern parses one allowedRanges entry, or reports why it is not a pattern the pinned package
// would accept. The caller warns and DROPS an invalid entry, which is what pinned's
// `filterValidIpPatterns` does -- an invalid whitelist entry must never fail the boot, because pinned
// does not fail it either.
func parseIPPattern(entry string) (ipPattern, error) {
	text := strings.TrimSpace(entry)
	if text == "" {
		return nil, errors.New("empty IP pattern")
	}
	if left, right, found := strings.Cut(text, "-"); found {
		return parseRangePattern(left, right)
	}
	if base, suffix, found := strings.Cut(text, "/"); found {
		return parseMaskedPattern(base, suffix)
	}
	return parseAddressPattern(text)
}

func parseRangePattern(left, right string) (ipPattern, error) {
	low, lowV6, err := parseExactAddress(left)
	if err != nil {
		return nil, fmt.Errorf("left side of the IP range is not an exact address: %w", err)
	}
	high, highV6, err := parseExactAddress(right)
	if err != nil {
		return nil, fmt.Errorf("right side of the IP range is not an exact address: %w", err)
	}
	if lowV6 != highV6 {
		return nil, errors.New("both sides of an IP range must be the same family")
	}
	if !bytesLessOrEqual(low[:], high[:]) {
		return nil, errors.New("the left side of an IP range must not be above the right side")
	}
	return rangePattern{ipv6: lowV6, low: low, high: high, text: renderAddress(low, lowV6) + "-" + renderAddress(high, highV6)}, nil
}

// parseMaskedPattern handles `IP/bits` (CIDR) and `IP/maskIP` (a bit mask). pinned decides between them by
// `Number.isInteger(Number(suffix))` (ip.js:70-76); a suffix that is neither an integer nor an address is
// invalid, and so is a CIDR whose base carries a wildcard (ip.js:68 `!ip.exact()` throws).
func parseMaskedPattern(base, suffix string) (ipPattern, error) {
	baseValue, baseV6, wildcard, err := parseAddressOrWildcard(base)
	if err != nil {
		return nil, fmt.Errorf("the base of a subnetwork must be an exact address: %w", err)
	}
	if wildcard {
		return nil, errors.New("the base of a subnetwork must be an exact address, not a wildcard pattern")
	}
	bits, bitsErr := strconv.Atoi(strings.TrimSpace(suffix))
	if bitsErr == nil {
		width := 32
		if baseV6 {
			width = 128
		}
		if bits < 0 || bits > width {
			return nil, fmt.Errorf("a subnetwork's bits must be in the range 0-%d, got %d", width, bits)
		}
		mask := prefixMask(baseV6, bits)
		value := andBytes(baseValue[:], mask[:])
		return maskPattern{ipv6: baseV6, value: value, mask: mask, text: renderAddress(value, baseV6) + "/" + strconv.Itoa(bits)}, nil
	}
	maskValue, maskV6, maskWildcard, err := parseAddressOrWildcard(suffix)
	if err != nil || maskWildcard {
		return nil, fmt.Errorf("a subnetwork or mask looks like 'IP/bits' or 'IP/maskIP', got %q", base+"/"+suffix)
	}
	if maskV6 != baseV6 {
		return nil, errors.New("the base IP and the mask IP must be the same family")
	}
	value := andBytes(baseValue[:], maskValue[:])
	return maskPattern{ipv6: baseV6, value: value, mask: maskValue, text: renderAddress(value, baseV6) + "/" + renderAddress(maskValue, maskV6)}, nil
}

// parseAddressPattern handles the exact and wildcard forms: `10.0.0.5`, `192.168.*.*`, `::1`,
// `2001:*:*:*:*:*:*:*` and the mixed `::ffff:10.0.0.1`.
func parseAddressPattern(text string) (ipPattern, error) {
	value, ipv6, _, err := parseAddressOrWildcard(text)
	if err != nil {
		return nil, err
	}
	// The mask comes from the TEXT, not from the parsed value: a wildcard's value is zero, which is
	// indistinguishable from a literal `0` octet, and deriving the mask from the value would silently
	// turn `10.0.0.0` into `10.0.0.*`.
	mask := wildcardMask(text, ipv6)
	return maskPattern{ipv6: ipv6, value: andBytes(value[:], mask[:]), mask: mask, text: renderAddressPattern(text, ipv6)}, nil
}

// parseAddressOrWildcard parses an exact or wildcard address into 4 or 16 bytes, reporting whether any
// part was a wildcard.
func parseAddressOrWildcard(text string) (address [16]byte, ipv6 bool, wildcard bool, err error) {
	if strings.Contains(text, ":") {
		return parseIPv6OrWildcard(text)
	}
	return parseIPv4OrWildcard(text)
}

// parseExactAddress parses an address with no wildcards, for the range and CIDR-base forms.
func parseExactAddress(text string) ([16]byte, bool, error) {
	value, ipv6, wildcard, err := parseAddressOrWildcard(text)
	if err != nil {
		return [16]byte{}, false, err
	}
	if wildcard {
		return [16]byte{}, false, errors.New("expected an exact address, got a wildcard pattern")
	}
	return value, ipv6, nil
}

func parseIPv4OrWildcard(text string) ([16]byte, bool, bool, error) {
	parts := strings.Split(text, ".")
	if len(parts) != 4 {
		return [16]byte{}, false, false, fmt.Errorf("an IPv4 pattern has four dot-separated parts, got %d in %q", len(parts), text)
	}
	var address [16]byte
	wildcard := false
	for index, part := range parts {
		if part == "*" {
			wildcard = true
			continue
		}
		// strconv.Atoi is base 10 and accepts a leading zero exactly as `parseInt(part, 10)` does, so
		// `010.0.0.1` is the address 10.0.0.1 in both implementations (netip.ParseAddr rejects it).
		octet, err := strconv.Atoi(strings.TrimSpace(part))
		if err != nil {
			return [16]byte{}, false, false, fmt.Errorf("%q is not an octet or a wildcard", part)
		}
		if octet < 0 || octet > 255 {
			return [16]byte{}, false, false, fmt.Errorf("an octet must be in the range 0-255, got %d", octet)
		}
		address[index] = byte(octet)
	}
	return address, false, wildcard, nil
}

// parseIPv6OrWildcard parses the IPv6 forms, including the mixed `::ffff:10.0.0.1` spelling, which pinned
// folds into the last two hextets (ip.js:285-294). A wildcard in the IPv4 part of a mixed address is
// refused, as pinned refuses it (ip.js:287-288).
func parseIPv6OrWildcard(text string) ([16]byte, bool, bool, error) {
	head := text
	tail := [2]int{}
	hasTail := false
	if index := strings.LastIndex(text, ":"); index >= 0 && strings.Contains(text[index+1:], ".") {
		parsed, _, tailWildcard, err := parseIPv4OrWildcard(text[index+1:])
		if err != nil {
			return [16]byte{}, false, false, err
		}
		if tailWildcard {
			return [16]byte{}, false, false, errors.New("a mixed IPv6 address cannot contain wildcards in its IPv4 part")
		}
		tail = [2]int{int(parsed[0])<<8 | int(parsed[1]), int(parsed[2])<<8 | int(parsed[3])}
		hasTail = true
		head = text[:index] + ":0:0"
	}
	hextets, wildcard, err := parseIPv6Hextets(head)
	if err != nil {
		return [16]byte{}, false, false, err
	}
	parts := hextets
	if hasTail {
		parts = append(append([]int{}, hextets[:6]...), tail[0], tail[1])
	}
	var address [16]byte
	for index, part := range parts {
		if part < 0 {
			wildcard = true
			continue
		}
		address[index*2] = byte(part >> 8)
		address[index*2+1] = byte(part)
	}
	return address, true, wildcard, nil
}

// parseIPv6Hextets expands the `::` shorthand into exactly eight hextets, using -1 for a wildcard.
func parseIPv6Hextets(text string) ([]int, bool, error) {
	if strings.Contains(text, ":::") {
		return nil, false, fmt.Errorf("%q is not a valid IPv6 pattern", text)
	}
	sides := strings.Split(text, "::")
	if len(sides) > 2 {
		return nil, false, errors.New("an IPv6 pattern can contain :: only once")
	}
	parse := func(part string) ([]int, bool, error) {
		if part == "" {
			return nil, false, nil
		}
		items := strings.Split(part, ":")
		result := make([]int, 0, len(items))
		wildcard := false
		for _, item := range items {
			if item == "*" {
				result = append(result, -1)
				wildcard = true
				continue
			}
			value, err := strconv.ParseUint(item, 16, 32)
			if err != nil || value > 0xFFFF {
				return nil, false, fmt.Errorf("%q is not a hextet or a wildcard", item)
			}
			result = append(result, int(value))
		}
		return result, wildcard, nil
	}
	left, leftWildcard, err := parse(sides[0])
	if err != nil {
		return nil, false, err
	}
	wildcard := leftWildcard
	if len(sides) == 1 {
		if len(left) != 8 {
			return nil, false, fmt.Errorf("an IPv6 pattern without :: has eight hextets, got %d", len(left))
		}
		return left, wildcard, nil
	}
	right, rightWildcard, err := parse(sides[1])
	if err != nil {
		return nil, false, err
	}
	wildcard = wildcard || rightWildcard
	fill := 8 - len(left) - len(right)
	if fill < 1 {
		return nil, false, errors.New("this IPv6 pattern does not need ::")
	}
	result := append([]int{}, left...)
	for index := 0; index < fill; index++ {
		result = append(result, 0)
	}
	return append(result, right...), wildcard, nil
}

// wildcardMask builds the bit mask of a wildcard pattern: every part that is `*` contributes zero bits,
// every other part all ones. It re-reads the text because a wildcard's VALUE is indistinguishable from a
// literal zero, and deriving the mask from the value would silently turn `0` into `*`.
func wildcardMask(text string, ipv6 bool) [16]byte {
	mask := [16]byte{}
	if !ipv6 {
		for index, part := range strings.Split(text, ".") {
			if part == "*" {
				continue
			}
			mask[index] = 0xFF
		}
		return mask
	}
	head := text
	if index := strings.LastIndex(text, ":"); index >= 0 && strings.Contains(text[index+1:], ".") {
		head = text[:index] + ":0:0"
	}
	hextets, _, err := parseIPv6Hextets(head)
	if err != nil {
		return mask
	}
	if strings.Contains(text, ".") {
		hextets = append(hextets[:6], 0, 0)
	}
	for index, part := range hextets {
		if part < 0 {
			continue
		}
		mask[index*2] = 0xFF
		mask[index*2+1] = 0xFF
	}
	return mask
}

func prefixMask(ipv6 bool, bits int) [16]byte {
	mask := [16]byte{}
	for index := 0; index < bits; index++ {
		mask[index/8] |= 1 << (7 - uint(index%8))
	}
	return mask
}

func andBytes(left, right []byte) [16]byte {
	result := [16]byte{}
	for index := 0; index < 16 && index < len(left); index++ {
		result[index] = left[index] & right[index]
	}
	return result
}

// renderAddress is ip-matching's toString for an exact address: dot-decimal for IPv4, RFC 5952 for IPv6.
func renderAddress(value [16]byte, ipv6 bool) string {
	address, ok := addressFromBytes(value, ipv6)
	if !ok {
		return ""
	}
	return address.String()
}

// renderAddressPattern is ip-matching's toString for a wildcard pattern, which prints `*` where the
// pattern had one (ip.js:176-178 for IPv4, :353-355 for IPv6).
func renderAddressPattern(text string, ipv6 bool) string {
	if !ipv6 {
		parts := strings.Split(text, ".")
		rendered := make([]string, 0, 4)
		for _, part := range parts {
			if part == "*" {
				rendered = append(rendered, "*")
				continue
			}
			octet, err := strconv.Atoi(strings.TrimSpace(part))
			if err != nil {
				return text
			}
			rendered = append(rendered, strconv.Itoa(octet))
		}
		return strings.Join(rendered, ".")
	}
	// The IPv6 wildcard rendering is the hextets joined with ':' after RFC 5952 shortening of the zeros,
	// which `ip-matching` does with its own `shortenIPv6`. Reproducing that shortening exactly is not worth
	// a second implementation for a log line, so the entry is echoed as the operator wrote it and the
	// deviation is stated here rather than hidden.
	return strings.TrimSpace(text)
}

func addressFromBytes(value [16]byte, ipv6 bool) (netip.Addr, bool) {
	if ipv6 {
		return netip.AddrFrom16(value), true
	}
	return netip.AddrFrom4([4]byte{value[0], value[1], value[2], value[3]}), true
}
