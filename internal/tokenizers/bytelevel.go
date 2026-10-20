package tokenizers

import (
	"strings"
	"unicode/utf8"
)

// The pinned HuggingFace tokenizers library maps every byte to a printable unicode character
// before byte-pair encoding (the GPT-2 "bytes to unicode" table). Both directions are needed:
// encoding maps bytes to characters, and decoding maps them back before the lossy UTF-8
// conversion.

var byteLevelAlphabet = buildByteLevelAlphabet()
var byteLevelReverse = buildByteLevelReverse()

func buildByteLevelAlphabet() map[byte]rune {
	direct := []int{}
	for value := int('!'); value <= int('~'); value++ {
		direct = append(direct, value)
	}
	for value := 0xA1; value <= 0xAC; value++ {
		direct = append(direct, value)
	}
	for value := 0xAE; value <= 0xFF; value++ {
		direct = append(direct, value)
	}
	seen := map[int]bool{}
	for _, value := range direct {
		seen[value] = true
	}
	bytes := append([]int{}, direct...)
	runes := append([]int{}, direct...)
	next := 0
	for value := 0; value < 256; value++ {
		if seen[value] {
			continue
		}
		bytes = append(bytes, value)
		runes = append(runes, 256+next)
		next++
	}
	alphabet := make(map[byte]rune, len(bytes))
	for index, value := range bytes {
		alphabet[byte(value)] = rune(runes[index])
	}
	return alphabet
}

func buildByteLevelReverse() map[rune]byte {
	reverse := make(map[rune]byte, len(byteLevelAlphabet))
	for value, character := range byteLevelAlphabet {
		reverse[character] = value
	}
	return reverse
}

// encodeByteLevel maps every byte of text through the byte-to-unicode alphabet. Runes in the
// private-use range reserved by escapeSurrogateBytes stand for a WTF-8 surrogate sequence and
// are expanded back to their three bytes.
func encodeByteLevel(text string) string {
	var builder strings.Builder
	builder.Grow(len(text))
	for _, character := range text {
		if character >= surrogateEscapeBase && character < surrogateEscapeBase+0x400 {
			for _, value := range wtf8Encode(0xD800 + (character - surrogateEscapeBase)) {
				builder.WriteRune(byteLevelAlphabet[value])
			}
			continue
		}
		for _, value := range []byte(string(character)) {
			builder.WriteRune(byteLevelAlphabet[value])
		}
	}
	return builder.String()
}

// surrogateEscapeBase is the first private-use rune escapeSurrogateBytes uses for a WTF-8
// surrogate sequence. A real input character in this range would be confused with an escaped
// surrogate; the pinned corpus contains none, and the case is recorded as unverified in
// docs/tokenizer-parity-plan.md §9.1.
const surrogateEscapeBase = 0xE000

// escapeSurrogateBytes replaces each WTF-8 surrogate sequence with one private-use rune so the
// rune-based pre-tokenizer patterns cannot mangle it.
func escapeSurrogateBytes(text string) string {
	if !strings.Contains(text, "\xed") {
		return text
	}
	var builder strings.Builder
	builder.Grow(len(text))
	for index := 0; index < len(text); {
		if unit, size, ok := wtf8SurrogateAt(text, index); ok {
			builder.WriteRune(surrogateEscapeBase + (unit - 0xD800))
			index += size
			continue
		}
		character, size := utf8.DecodeRuneInString(text[index:])
		if character == utf8.RuneError && size == 1 {
			builder.WriteByte(text[index])
			index++
			continue
		}
		builder.WriteString(text[index : index+size])
		index += size
	}
	return builder.String()
}
