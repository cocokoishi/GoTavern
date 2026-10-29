package outbound

import (
	"net/netip"
	"testing"
)

// THE PATTERN GRAMMAR, ROW BY ROW, AGAINST THE PINNED PACKAGE'S OWN ANSWERS.
//
// These expectations are not derived from our parser. Every `want` below is the answer the pinned
// checkout's `ip-matching` package gave when it was PROBED directly:
//
//	cd <pinned SillyTavern>   # read-only; this command writes nothing
//	node -e "const m=require('ip-matching');
//	         for (const [p,ip] of [['10.0.0.0/8','10.1.2.3'],['192.168.*.*','192.168.1.5'], ...])
//	           console.log(p, ip, String(m.getMatch(p).matches(ip)))"
//
// The rows whose expected answer is `false` are as load-bearing as the `true` ones: a parser that
// accepted everything would satisfy every `true` row and filter nothing.
func TestPrivateAddressWhitelistPatternsMatchThePinnedPackage(t *testing.T) {
	cases := []struct {
		pattern string
		address string
		want    bool
		why     string
	}{
		// CIDR, IPv4 (pinned: IPSubnetwork).
		{pattern: "10.0.0.0/8", address: "10.1.2.3", want: true, why: "the base range"},
		{pattern: "10.0.0.0/8", address: "11.0.0.1", want: false, why: "one octet out"},
		{pattern: "172.16.0.0/12", address: "172.31.255.255", want: true, why: "the top of a /12"},
		{pattern: "172.16.0.0/12", address: "172.32.0.1", want: false, why: "just past the /12"},
		{pattern: "169.254.0.0/16", address: "169.254.1.1", want: true, why: "link-local"},
		{pattern: "127.0.0.0/8", address: "127.0.0.1", want: true, why: "loopback"},
		{pattern: "10.1.2.3/8", address: "10.9.9.9", want: true, why: "a /8 masks its own base: ip.js:633-644"},
		// Wildcard octets (pinned: IPv4 with `*` parts).
		{pattern: "192.168.*.*", address: "192.168.1.5", want: true, why: "the example in the task"},
		{pattern: "192.168.*.*", address: "192.169.1.5", want: false, why: "a wildcard is per-octet, not a suffix"},
		{pattern: "192.168.*.*", address: "192.168.255.255", want: true, why: "the last address of the wildcard"},
		{pattern: "*.168.1.1", address: "10.168.1.1", want: true, why: "a leading wildcard is legal (IP4_REGEX)"},
		{pattern: "10.*.0.1", address: "10.9.0.1", want: true, why: "a middle wildcard"},
		{pattern: "*.*.*.*", address: "8.8.8.8", want: true, why: "everything"},
		// Exact addresses (pinned: IPv4/IPv6, no wildcards).
		{pattern: "10.0.0.5", address: "10.0.0.5", want: true, why: "exact"},
		{pattern: "10.0.0.5", address: "10.0.0.6", want: false, why: "not exact"},
		{pattern: "010.0.0.1", address: "10.0.0.1", want: true, why: "parseInt(part, 10) accepts a leading zero; netip.ParseAddr does not"},
		// IPv6 CIDR.
		{pattern: "::1/128", address: "::1", want: true, why: "IPv6 loopback"},
		{pattern: "::1/128", address: "0:0:0:0:0:0:0:1", want: true, why: "the long spelling is the same address"},
		{pattern: "fc00::/7", address: "fd12::1", want: true, why: "unique-local"},
		{pattern: "fc00::/7", address: "fe80::1", want: false, why: "link-local is not inside fc00::/7"},
		{pattern: "fe80::/10", address: "fe80::1", want: true, why: "IPv6 link-local"},
		{pattern: "2001:db8::/32", address: "2001:db8::1", want: true, why: "documentation range"},
		{pattern: "2001:db8::/32", address: "2001:db9::1", want: false, why: "one hextet out"},
		// IPv6 wildcard hextets.
		{pattern: "2001:*:*:*:*:*:*:*", address: "2001:db8::1", want: true, why: "a wildcard hextet"},
		{pattern: "2001:*:*:*:*:*:*:*", address: "2002:db8::1", want: false, why: "the first hextet is fixed"},
		// The mixed spelling: pinned parses `::ffff:1.2.3.4` as an IPv6 (ip.js:285-294), and this parser
		// agrees, so a v6 pattern matches the mapped address.
		{pattern: "::ffff:10.0.0.0/104", address: "::ffff:10.0.0.1", want: true, why: "a v6 pattern over the mapped form"},
		// Range form.
		{pattern: "10.0.0.1-10.0.0.9", address: "10.0.0.5", want: true, why: "inside the interval"},
		{pattern: "10.0.0.1-10.0.0.9", address: "10.0.0.10", want: false, why: "one past the interval"},
		// Mask form.
		{pattern: "10.0.0.0/255.0.0.0", address: "10.1.1.1", want: true, why: "an explicit mask IP"},
		{pattern: "10.0.0.0/255.0.0.0", address: "11.1.1.1", want: false, why: "outside the masked bits"},
		// FAMILY: pinned matches by family, so a v4 pattern never matches a native v6 address. This is the
		// property privatefilter.go deliberately supplements for the v4-MAPPED case (see the next test).
		{pattern: "10.0.0.0/8", address: "::ffff:10.0.0.1", want: false, why: "MEASURED against ip-matching: false (cross-family)"},
		{pattern: "::1/128", address: "127.0.0.1", want: false, why: "a v6 pattern never matches a v4 address"},
	}

	for _, testCase := range cases {
		t.Run(testCase.pattern+"_"+testCase.address, func(t *testing.T) {
			pattern, err := parseIPPattern(testCase.pattern)
			if err != nil {
				t.Fatalf("parseIPPattern(%q) = %v, want a parsed pattern (%s)", testCase.pattern, err, testCase.why)
			}
			address, err := netip.ParseAddr(testCase.address)
			if err != nil {
				t.Fatalf("netip.ParseAddr(%q) = %v", testCase.address, err)
			}
			if got := pattern.matches(address); got != testCase.want {
				t.Fatalf("pattern %q matches %q = %t, want %t (%s)", testCase.pattern, testCase.address, got, testCase.want, testCase.why)
			}
		})
	}
}

// TestInvalidWhitelistPatternsAreRejected names the forms pinned's `getMatch` throws on, so a dropped
// entry is dropped for the same reason and the operator's warning can name it.
func TestInvalidWhitelistPatternsAreRejected(t *testing.T) {
	cases := []struct {
		pattern string
		why     string
	}{
		{pattern: "", why: "empty"},
		{pattern: "not-an-ip", why: "MEASURED: getMatch('not-an-ip') throws \"A range looks like 'IP-IP'\""},
		{pattern: "10.0.0.256", why: "an octet above 255 (ip.js:11-16 throws)"},
		{pattern: "10.0.0", why: "three octets"},
		{pattern: "10.0.0.1.2", why: "five octets"},
		{pattern: "10.0.0.0/33", why: "an IPv4 prefix above 32 (ip.js:630-632)"},
		{pattern: "::1/129", why: "an IPv6 prefix above 128"},
		{pattern: "10.*.0.0/8", why: "a wildcard base is refused (ip.js:68 requires exact)"},
		{pattern: "10.0.0.9-10.0.0.1", why: "a reversed range (ip.js:508-509)"},
		{pattern: "10.0.0.1-::1", why: "a range across families (ip.js:506-507)"},
		{pattern: "2001:db8:::1", why: "a malformed :: (ip.js:299-300)"},
		{pattern: "::ffff:10.0.*.1", why: "a wildcard in the IPv4 part of a mixed address (ip.js:287-288)"},
		{pattern: "1:2:3:4:5:6:7:8:9", why: "nine hextets"},
	}
	for _, testCase := range cases {
		t.Run(testCase.pattern, func(t *testing.T) {
			if _, err := parseIPPattern(testCase.pattern); err == nil {
				t.Fatalf("parseIPPattern(%q) accepted an entry pinned refuses (%s); a whitelist wider than the operator wrote is the wrong direction to be wrong in", testCase.pattern, testCase.why)
			}
		})
	}
}

// TestPatternStringMatchesThePinnedLogRendering pins the `Allowed private addresses:` line's content for
// the forms whose rendering pinned normalises (ip-matching's toString).
func TestPatternStringMatchesThePinnedLogRendering(t *testing.T) {
	cases := []struct {
		pattern string
		want    string
		why     string
	}{
		{pattern: "10.1.2.3/8", want: "10.0.0.0/8", why: "IPSubnetwork masks its base (ip.js:633-644)"},
		{pattern: "127.0.0.0/8", want: "127.0.0.0/8", why: "already masked"},
		{pattern: "192.168.*.*", want: "192.168.*.*", why: "IPv4 toString prints '*' for a wildcard (ip.js:176-178)"},
		{pattern: "010.0.0.1", want: "10.0.0.1", why: "the parsed number is printed, not the text"},
		{pattern: "10.0.0.0/255.0.0.0", want: "10.0.0.0/255.0.0.0", why: "IPMask.toString keeps both parts"},
		{pattern: "10.0.0.1-10.0.0.9", want: "10.0.0.1-10.0.0.9", why: "IPRange.toString joins the bounds"},
	}
	for _, testCase := range cases {
		t.Run(testCase.pattern, func(t *testing.T) {
			pattern, err := parseIPPattern(testCase.pattern)
			if err != nil {
				t.Fatalf("parseIPPattern(%q) = %v", testCase.pattern, err)
			}
			if got := pattern.String(); got != testCase.want {
				t.Fatalf("String() = %q, want %q (%s)", got, testCase.want, testCase.why)
			}
		})
	}
}
