package longlivedfixture

// SFW ENFORCEMENT (hard requirement, not a style note).
//
// Everything this generator writes, every fixture the harness uploads, and every artifact the project
// publishes must be strictly SFW. This file is the enforcement: the builder's prose comes from one fixed
// SFW vocabulary (longlivedfixture.go `sentence`), and CheckSFW scans every generated text file for
// adult/explicit/hate/gore markers and for external references (URLs, handles, e-mail addresses) that
// could smuggle real people or real content into a committed fixture.
//
// The denylist is intentionally a SAFETY list, never content: it exists so a future edit to the generator
// cannot quietly introduce adult material, and the test in longlivedfixture_test.go proves the check can
// fail (the teeth), so a green scan is not vacuous.

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

// sfwDenylist holds unambiguous adult / hate / graphic-violence markers. Matching is case-insensitive on
// word boundaries; a match refuses the build.
var sfwDenylist = []string{
	"nsfw", "nsfl", "porn", "pornographic", "xxx", "smut", "lewd", "hentai", "erotic",
	"explicit", "fetish", "incest", "pedo", "pedophile", "underage", "bestiality",
	"gore", "torture", "swastika", "nazi", "slur",
}

var sfwDenyPattern = regexp.MustCompile(`(?i)\b(` + strings.Join(sfwDenylist, `|`) + `)\b`)

// sfwExternalReference refuses anything that looks like a real external party: a URL, a @handle or an
// e-mail address. A synthetic fixture has no reason to name one.
var sfwExternalReference = regexp.MustCompile(`(?i)(https?://|www\.|mailto:|\b[\w.+-]+@[\w-]+\.[\w.]+\b)`)

func isTextFile(name string) bool {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".json", ".jsonl", ".yaml", ".yml", ".txt", ".log", ".md", ".css", ".js", ".ts":
		return true
	default:
		return false
	}
}

// CheckSFW scans every text file the manifest says was written and returns an error naming the first
// offending file and category. PNG/binary payloads are out of scope here and are covered by the builder
// itself: they are generated from the fixed vocabulary and a synthetic gradient, never from a file.
func CheckSFW(root string, manifest *Manifest) error {
	for _, relative := range sortedKeys(manifest.Files) {
		if !isTextFile(relative) {
			continue
		}
		body, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			return fmt.Errorf("sfw scan: read %s: %w", relative, err)
		}
		text := string(body)
		if match := sfwDenyPattern.FindString(text); match != "" {
			return fmt.Errorf("sfw scan: %s contains the disallowed marker %q", relative, match)
		}
		if match := sfwExternalReference.FindString(text); match != "" {
			return fmt.Errorf("sfw scan: %s contains an external reference %q (a synthetic fixture must name no real party)", relative, match)
		}
	}
	return nil
}
