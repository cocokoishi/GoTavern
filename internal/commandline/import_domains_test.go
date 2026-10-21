package commandline

// The whitelistImportDomains plumbing exists because /api/content import has to distinguish
// "refused by policy" from "a generic download would run", and it must do that from the operator's
// actual config. It is deliberately NOT part of the serialized startup settings map: Node's map does
// not contain the key, and adding it there made the command-line differential disagree with Node in
// four scenarios. These tests pin the values the route will compare against.

import (
	"reflect"
	"testing"
)

func TestImportDomainsWhitelistDefaultsToThePinnedFourHosts(t *testing.T) {
	// The default lives in the pinned content-manager.js, not in Go, so it is asserted here rather
	// than derived: an empty config must produce exactly these four domains.
	want := []string{"localhost", "cdn.discordapp.com", "files.catbox.moe", "raw.githubusercontent.com"}
	got := importDomainsWhitelist(map[string]any{})
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("importDomainsWhitelist(empty) = %#v, want %#v", got, want)
	}
}

func TestImportDomainsWhitelistHonoursAnOperatorOverride(t *testing.T) {
	// An operator-configured list must be used verbatim, including an EMPTY list: removing every
	// domain is a legitimate configuration that refuses all generic imports, and substituting the
	// defaults for it would silently re-enable downloads the operator disabled.
	override := []any{"example.test", "other.test"}
	if got, want := importDomainsWhitelist(map[string]any{"whitelistImportDomains": override}), []string{"example.test", "other.test"}; !reflect.DeepEqual(got, want) {
		t.Fatalf("override = %#v, want %#v", got, want)
	}
	empty := []any{}
	if got := importDomainsWhitelist(map[string]any{"whitelistImportDomains": empty}); len(got) != 0 {
		t.Fatalf("empty override = %#v, want an empty list rather than the defaults", got)
	}
}

func TestImportDomainsWhitelistIgnoresNonStringMembers(t *testing.T) {
	// A YAML list can hold scalars of other types; only strings can be hostnames, and a non-string
	// must not become an empty-string domain that would match everything.
	got := importDomainsWhitelist(map[string]any{"whitelistImportDomains": []any{"ok.test", 42, nil, true, "also.test"}})
	want := []string{"ok.test", "also.test"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("mixed list = %#v, want %#v", got, want)
	}
}
