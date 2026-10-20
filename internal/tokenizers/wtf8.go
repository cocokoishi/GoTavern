package tokenizers

import (
	"errors"
	"fmt"
	"strings"
	"unicode/utf16"
	"unicode/utf8"
)

// Unpaired surrogates are the one place where the pinned pipeline is not expressible with
// Go's encoding/json: JSON.parse keeps a lone \uD800 escape as a lone UTF-16 code unit,
// and each tokenizer backend then converts it differently. Go's decoder replaces it with
// U+FFFD before any tokenizer sees it, which loses the difference between a real U+FFFD
// (an ordinary character for these models) and an unpaired surrogate. The tokenizer routes
// therefore decode their text field with UnescapeJSONString, which preserves an unpaired
// surrogate as its WTF-8 bytes, and each engine applies its own pinned conversion.

// UnescapeJSONString decodes one JSON string literal, including its surrounding quotes,
// the way JSON.parse does, except that an unpaired surrogate escape is kept as the WTF-8
// bytes of that code unit rather than being replaced with U+FFFD.
func UnescapeJSONString(raw []byte) (string, error) {
	if len(raw) < 2 || raw[0] != '"' || raw[len(raw)-1] != '"' {
		return "", errors.New("tokenizers: value is not a JSON string literal")
	}
	var builder strings.Builder
	builder.Grow(len(raw))
	for index := 1; index < len(raw)-1; {
		character := raw[index]
		if character != '\\' {
			builder.WriteByte(character)
			index++
			continue
		}
		index++
		if index >= len(raw)-1 {
			return "", errors.New("tokenizers: truncated JSON escape")
		}
		switch raw[index] {
		case '"', '\\', '/':
			builder.WriteByte(raw[index])
			index++
		case 'b':
			builder.WriteByte('\b')
			index++
		case 'f':
			builder.WriteByte('\f')
			index++
		case 'n':
			builder.WriteByte('\n')
			index++
		case 'r':
			builder.WriteByte('\r')
			index++
		case 't':
			builder.WriteByte('\t')
			index++
		case 'u':
			unit, err := hex4(raw[index+1:])
			if err != nil {
				return "", err
			}
			index += 5
			// A high surrogate followed by a low surrogate escape is a valid pair, and
			// JSON.parse combines it into one code point.
			if utf16.IsSurrogate(rune(unit)) && unit >= 0xD800 && unit <= 0xDBFF && index+5 < len(raw) && raw[index] == '\\' && raw[index+1] == 'u' {
				low, err := hex4(raw[index+2:])
				if err != nil {
					return "", err
				}
				if combined := utf16.DecodeRune(rune(unit), rune(low)); combined != utf8.RuneError {
					builder.WriteRune(combined)
					index += 6
					continue
				}
			}
			if utf16.IsSurrogate(rune(unit)) {
				builder.Write(wtf8Encode(rune(unit)))
				continue
			}
			builder.WriteRune(rune(unit))
		default:
			return "", fmt.Errorf("tokenizers: unsupported JSON escape \\%c", raw[index])
		}
	}
	return builder.String(), nil
}

func hex4(raw []byte) (uint32, error) {
	if len(raw) < 4 {
		return 0, errors.New("tokenizers: truncated \\u escape")
	}
	value := uint32(0)
	for index := 0; index < 4; index++ {
		digit := raw[index]
		switch {
		case digit >= '0' && digit <= '9':
			value = value*16 + uint32(digit-'0')
		case digit >= 'a' && digit <= 'f':
			value = value*16 + uint32(digit-'a') + 10
		case digit >= 'A' && digit <= 'F':
			value = value*16 + uint32(digit-'A') + 10
		default:
			return 0, fmt.Errorf("tokenizers: invalid \\u digit %q", digit)
		}
	}
	return value, nil
}

// wtf8Encode writes a surrogate code unit as its three WTF-8 bytes.
func wtf8Encode(unit rune) []byte {
	return []byte{
		byte(0xE0 | (unit >> 12)),
		byte(0x80 | ((unit >> 6) & 0x3F)),
		byte(0x80 | (unit & 0x3F)),
	}
}

// wtf8SurrogateAt reports the surrogate code unit encoded at index, if any.
func wtf8SurrogateAt(text string, index int) (rune, int, bool) {
	if index+2 >= len(text) || text[index] != 0xED {
		return 0, 0, false
	}
	second, third := text[index+1], text[index+2]
	if second < 0xA0 || second > 0xBF || third < 0x80 || third > 0xBF {
		return 0, 0, false
	}
	unit := rune(0xD000) | rune(second&0x3F)<<6 | rune(third&0x3F)
	return unit, 3, true
}

// ConvertWTFSurrogatesForSentencePiece reproduces the pinned SentencePiece port's UTF-16
// to UTF-8 conversion. The port treats any surrogate code unit as the high half of a pair
// without validating the other half: it consumes the next code unit, whether or not that
// unit is a low surrogate, and combines them with the standard formula. A trailing
// surrogate is combined with zero. The port therefore turns a lone \uD800 followed by "b"
// into U+10062 and swallows the "b", which is visible in the pinned capture and must be
// reproduced rather than corrected.
func ConvertWTFSurrogatesForSentencePiece(text string) string {
	if !strings.Contains(text, "\xed") {
		return text
	}
	var builder strings.Builder
	builder.Grow(len(text))
	for index := 0; index < len(text); {
		unit, size, ok := wtf8SurrogateAt(text, index)
		if !ok {
			r, runeSize := utf8.DecodeRuneInString(text[index:])
			if r == utf8.RuneError && runeSize == 1 {
				builder.WriteByte(text[index])
				index++
				continue
			}
			builder.WriteString(text[index : index+runeSize])
			index += runeSize
			continue
		}
		index += size
		next := rune(0)
		if index < len(text) {
			if nextUnit, nextSize, isSurrogate := wtf8SurrogateAt(text, index); isSurrogate {
				next = nextUnit
				index += nextSize
			} else {
				r, runeSize := utf8.DecodeRuneInString(text[index:])
				if r == utf8.RuneError && runeSize == 1 {
					next = rune(text[index])
					index++
				} else {
					next = r
					index += runeSize
				}
			}
		}
		builder.WriteRune(0x10000 + ((unit & 0x3FF) << 10) + (next & 0x3FF))
	}
	return builder.String()
}

// ReplaceWTFSurrogatesForTiktoken reproduces what the pinned tiktoken WASM does with an
// unpaired surrogate: wasm-bindgen converts the JS string to UTF-8 with the replacement
// character, one U+FFFD per unpaired code unit.
func ReplaceWTFSurrogatesForTiktoken(text string) string {
	if !strings.Contains(text, "\xed") {
		return text
	}
	var builder strings.Builder
	builder.Grow(len(text))
	for index := 0; index < len(text); {
		if _, size, ok := wtf8SurrogateAt(text, index); ok {
			builder.WriteRune(utf8.RuneError)
			index += size
			continue
		}
		r, runeSize := utf8.DecodeRuneInString(text[index:])
		if r == utf8.RuneError && runeSize == 1 {
			builder.WriteByte(text[index])
			index++
			continue
		}
		builder.WriteString(text[index : index+runeSize])
		index += runeSize
	}
	return builder.String()
}
