// Package userdata owns the naming policy GoTavern applies to user-controlled filenames and handles.
//
// MOVED, NOT REWRITTEN (GOAL.md §15.4). SanitizeFilename and its three helpers were extracted from
// internal/server/characters_import_formats.go without a behaviour change; the pinned semantics they
// reproduce are the sanitize-filename package's, which is what the pinned server uses for BYAF names
// with `sanitizeSafeCharacterReplacements` (src/util.js returns "_"). The package REMOVES characters by
// default; with a replacement each illegal one is replaced instead, so this is not interchangeable with
// the server's older removing helper.
package userdata

import "strings"

// SanitizeFilename reproduces `sanitize(name, { replacement })` from the sanitize-filename package:
// every illegal character (and every C0/C1 control character) is replaced, a name that is only dots is
// empty, a Windows-reserved device name is empty, trailing dots and spaces are trimmed, and a result
// longer than 255 bytes is truncated on a UTF-8 rune boundary of its own output.
func SanitizeFilename(input, replacement string) string {
	var cleaned strings.Builder
	cleaned.Grow(len(input))
	for _, character := range input {
		if filenameCharacterIsIllegal(character) || character <= 0x1f || (character >= 0x80 && character <= 0x9f) {
			cleaned.WriteString(replacement)
			continue
		}
		cleaned.WriteRune(character)
	}
	filename := cleaned.String()
	if strings.Trim(filename, ".") == "" {
		filename = ""
	}
	if filenameIsReserved(filename) {
		filename = ""
	}
	filename = strings.TrimRight(filename, ". ")
	if len(filename) > 255 {
		// sanitize-filename truncates on the byte boundary of its own UTF-8 output.
		cut := 255
		for cut > 0 && !utf8RuneStart(filename[cut]) {
			cut--
		}
		filename = filename[:cut]
	}
	return filename
}

func filenameCharacterIsIllegal(character rune) bool {
	switch character {
	case '/', '?', '<', '>', '\\', ':', '*', '|', '"', 0:
		return true
	default:
		return false
	}
}

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
	if len(base) == 4 && (strings.HasPrefix(base, "com") || strings.HasPrefix(base, "lpt")) && base[3] >= '1' && base[3] <= '9' {
		return true
	}
	return false
}

func utf8RuneStart(character byte) bool {
	return character&0xC0 != 0x80
}
