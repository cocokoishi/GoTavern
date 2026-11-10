// Package userdata owns the naming policy GoTavern applies to user-controlled filenames and handles.
//
// MOVED, NOT REWRITTEN (GOAL.md §15.4). SanitizeFilename was extracted from
// internal/server/characters_import_formats.go without a behaviour change; the pinned semantics it
// reproduces are the sanitize-filename package's, which is what the pinned server uses for BYAF names
// with `sanitizeSafeCharacterReplacements` (src/util.js returns "_"). The package REMOVES characters by
// default; with a replacement each illegal one is replaced instead, so this is not interchangeable with
// the server's older removing helper.
//
// ALPHA.20 SOURCE AUDIT (A20-B): the one-pass version of this function that shipped through alpha.19 was
// NOT the pinned algorithm. sanitize-filename applies five regular-expression replacements in a fixed
// order and then, when a replacement is given, runs the WHOLE sanitize again with an empty replacement:
//
//	sanitize(input, replacement) =
//	    truncate(input.replace(illegalRe, replacement)
//	                   .replace(controlRe, replacement)
//	                   .replace(reservedRe, replacement)        // /^\.+$/       whole match
//	                   .replace(windowsReservedRe, replacement) // ^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$i  whole match
//	                   .replace(windowsTrailingRe, replacement), // /[\. ]+$/     whole trailing run
//	             255)
//
// Measured against the pinned node_modules/sanitize-filename under Node 24.19.0 (the pinned dependency,
// so this IS the oracle for this contract), the one-pass port differed on every reserved name and every
// trailing run when a replacement was supplied ("CON" -> pinned "_", port ""; "a. " -> pinned "a_",
// port "a"; "NUL.tar.gz" -> pinned "_", port "") and on the reserved DEVICE NUMBER 0 ("com0" and "lpt0"
// are windowsReservedRe matches for com[0-9]/lpt[0-9], but the port required 1-9, so it returned
// "com0.txt" where the pinned package returns ""). Those names reach a real user path: the BYAF card
// import builds the stored PNG name, the imported chat name and the alt-image folder from
// sanitize(name, {replacement: () => '_'}) at internal/server/characters_import_formats.go:1231, :1306,
// :1338, so a card named "Aria " or "CON" was stored under a different filename than pinned stores.
//
// The tests in a20_sanitize_filename_test.go are the measured oracle rows, not derivations.
package userdata

import "strings"

// SanitizeFilename reproduces the pinned `sanitize-filename` package's exported function:
//
//	module.exports = function (input, options) {
//	    var replacement = (options && options.replacement) || '';
//	    var output = sanitize(input, replacement);
//	    if (replacement === '') { return output; }
//	    return sanitize(output, '');
//	};
//
// The second pass is part of the contract: it removes a replacement that is itself illegal or that
// turns the result into a reserved name, and it is why a reserved name becomes a single replacement
// character rather than an empty string.
func SanitizeFilename(input, replacement string) string {
	output := sanitizeFilenamePass(input, replacement)
	if replacement == "" {
		return output
	}
	return sanitizeFilenamePass(output, "")
}

// sanitizeFilenamePass is the package's internal `sanitize(input, replacement)`: the five ordered
// replacements followed by a 255-byte UTF-8 truncation.
func sanitizeFilenamePass(input, replacement string) string {
	var cleaned strings.Builder
	cleaned.Grow(len(input) + len(replacement))
	for _, character := range input {
		if filenameCharacterIsIllegal(character) || character <= 0x1f || (character >= 0x80 && character <= 0x9f) {
			cleaned.WriteString(replacement)
			continue
		}
		cleaned.WriteRune(character)
	}
	filename := cleaned.String()
	// reservedRe = /^\.+$/ : a name that is ONLY dots becomes one replacement (empty string when the
	// replacement is empty). An empty name does not match and must stay empty.
	if filename != "" && strings.Trim(filename, ".") == "" {
		filename = replacement
	}
	// windowsReservedRe = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i : the WHOLE match is
	// replaced, extension included, which is why "nul.tar.gz" becomes one replacement character.
	if filenameIsReserved(filename) {
		filename = replacement
	}
	// windowsTrailingRe = /[\. ]+$/ : the whole trailing run becomes ONE replacement, not one per
	// character.
	if trimmed := strings.TrimRight(filename, ". "); trimmed != filename {
		filename = trimmed + replacement
	}
	return truncateUTF8Bytes(filename, 255)
}

func filenameCharacterIsIllegal(character rune) bool {
	switch character {
	case '/', '?', '<', '>', '\\', ':', '*', '|', '"', 0:
		return true
	default:
		return false
	}
}

// filenameIsReserved is windowsReservedRe, case-insensitively: CON, PRN, AUX, NUL, COM0-COM9 and
// LPT0-LPT9, optionally followed by a dot and anything.
func filenameIsReserved(filename string) bool {
	base := filename
	if index := strings.IndexByte(base, '.'); index >= 0 {
		base = base[:index]
	}
	base = strings.ToLower(base)
	switch base {
	case "con", "prn", "aux", "nul":
		return true
	}
	if len(base) == 4 && (strings.HasPrefix(base, "com") || strings.HasPrefix(base, "lpt")) && base[3] >= '0' && base[3] <= '9' {
		return true
	}
	return false
}

// truncateUTF8Bytes is the pinned `truncate-utf8-bytes` dependency: cut to at most maxBytes without
// splitting a code point. It is applied per pass, because the package truncates inside sanitize().
func truncateUTF8Bytes(input string, maxBytes int) string {
	if len(input) <= maxBytes {
		return input
	}
	cut := maxBytes
	for cut > 0 && input[cut]&0xC0 == 0x80 {
		cut--
	}
	return input[:cut]
}
