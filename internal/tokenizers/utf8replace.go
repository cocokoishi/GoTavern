package tokenizers

import (
	"strings"
	"unicode/utf8"
)

// ReplaceInvalidUTF8 decodes b as UTF-8 using the replacement behaviour of the
// TextDecoder the pinned routes use: each maximal subpart of an ill-formed sequence
// becomes exactly one U+FFFD. Go's strings.ToValidUTF8 is not equivalent, because it
// collapses a whole run of invalid bytes into a single replacement, and the pinned chunk
// lists depend on the difference.
func ReplaceInvalidUTF8(b []byte) string {
	// Fast path: valid input is returned unchanged.
	if utf8.Valid(b) {
		return string(b)
	}
	var builder strings.Builder
	builder.Grow(len(b) + 3)
	for index := 0; index < len(b); {
		leading := b[index]
		switch {
		case leading < 0x80:
			builder.WriteByte(leading)
			index++
		case leading >= 0xC2 && leading <= 0xDF:
			if index+1 < len(b) && isContinuation(b[index+1]) {
				builder.Write(b[index : index+2])
				index += 2
				continue
			}
			builder.WriteRune(utf8.RuneError)
			index++
		case leading >= 0xE0 && leading <= 0xEF:
			low, high := byte(0x80), byte(0xBF)
			switch leading {
			case 0xE0:
				low = 0xA0
			case 0xED:
				high = 0x9F
			}
			if index+1 < len(b) && b[index+1] >= low && b[index+1] <= high {
				if index+2 < len(b) && isContinuation(b[index+2]) {
					builder.Write(b[index : index+3])
					index += 3
					continue
				}
				builder.WriteRune(utf8.RuneError)
				index += 2
				continue
			}
			builder.WriteRune(utf8.RuneError)
			index++
		case leading >= 0xF0 && leading <= 0xF4:
			low, high := byte(0x80), byte(0xBF)
			switch leading {
			case 0xF0:
				low = 0x90
			case 0xF4:
				high = 0x8F
			}
			if index+1 < len(b) && b[index+1] >= low && b[index+1] <= high {
				if index+2 < len(b) && isContinuation(b[index+2]) {
					if index+3 < len(b) && isContinuation(b[index+3]) {
						builder.Write(b[index : index+4])
						index += 4
						continue
					}
					builder.WriteRune(utf8.RuneError)
					index += 3
					continue
				}
				builder.WriteRune(utf8.RuneError)
				index += 2
				continue
			}
			builder.WriteRune(utf8.RuneError)
			index++
		default:
			// 0x80..0xC1 and 0xF5..0xFF can never start a sequence.
			builder.WriteRune(utf8.RuneError)
			index++
		}
	}
	return builder.String()
}

func isContinuation(b byte) bool {
	return b >= 0x80 && b <= 0xBF
}
