package server

import (
	"encoding/json"
	"math"
	"regexp"
	"strconv"
	"strings"
)

// lodash 4's pinned deburrLetter table from SillyTavern 1.19.0, keyed by the
// lowercase characters produced before _.deburr() is called.
var pinnedDeburrLetters = map[rune]string{
	'\u00e0': "a", '\u00e1': "a", '\u00e2': "a", '\u00e3': "a", '\u00e4': "a", '\u00e5': "a",
	'\u00e6': "ae", '\u00e7': "c", '\u00e8': "e", '\u00e9': "e", '\u00ea': "e", '\u00eb': "e",
	'\u00ec': "i", '\u00ed': "i", '\u00ee': "i", '\u00ef': "i", '\u00f0': "d", '\u00f1': "n",
	'\u00f2': "o", '\u00f3': "o", '\u00f4': "o", '\u00f5': "o", '\u00f6': "o", '\u00f8': "o",
	'\u00f9': "u", '\u00fa': "u", '\u00fb': "u", '\u00fc': "u", '\u00fd': "y", '\u00fe': "th",
	'\u00df': "ss", '\u00ff': "y", '\u0101': "a", '\u0103': "a", '\u0105': "a", '\u0107': "c",
	'\u0109': "c", '\u010b': "c", '\u010d': "c", '\u010f': "d", '\u0111': "d", '\u0113': "e",
	'\u0115': "e", '\u0117': "e", '\u0119': "e", '\u011b': "e", '\u011d': "g", '\u011f': "g",
	'\u0121': "g", '\u0123': "g", '\u0125': "h", '\u0127': "h", '\u0129': "i", '\u012b': "i",
	'\u012d': "i", '\u012f': "i", '\u0131': "i", '\u0133': "ij", '\u0135': "j", '\u0137': "k",
	'\u0138': "k", '\u013a': "l", '\u013c': "l", '\u013e': "l", '\u0140': "l", '\u0142': "l",
	'\u0144': "n", '\u0146': "n", '\u0148': "n", '\u0149': "'n", '\u014b': "n", '\u014d': "o",
	'\u014f': "o", '\u0151': "o", '\u0153': "oe", '\u0155': "r", '\u0157': "r", '\u0159': "r",
	'\u015b': "s", '\u015d': "s", '\u015f': "s", '\u0161': "s", '\u0163': "t", '\u0165': "t",
	'\u0167': "t", '\u0169': "u", '\u016b': "u", '\u016d': "u", '\u016f': "u", '\u0171': "u",
	'\u0173': "u", '\u0175': "w", '\u0177': "y", '\u017a': "z", '\u017c': "z", '\u017e': "z",
	'\u017f': "s",
}

var slugInvalidCharacters = regexp.MustCompile(`[^a-z0-9]+`)

func pinnedSlugify(value string) string {
	var deburred strings.Builder
	for _, character := range strings.ToLower(value) {
		if replacement, ok := pinnedDeburrLetters[character]; ok {
			deburred.WriteString(replacement)
			continue
		}
		if isPinnedCombiningMark(character) {
			continue
		}
		deburred.WriteRune(character)
	}
	slug := slugInvalidCharacters.ReplaceAllString(deburred.String(), "-")
	return strings.Trim(slug, "-")
}

func isPinnedCombiningMark(character rune) bool {
	return character >= 0x0300 && character <= 0x036f ||
		character >= 0xfe20 && character <= 0xfe2f ||
		character >= 0x20d0 && character <= 0x20ff
}

func nodeStringForSlug(raw json.RawMessage) string {
	if len(raw) == 0 || string(raw) == "null" {
		return ""
	}
	var value any
	if err := json.Unmarshal(raw, &value); err != nil {
		return ""
	}
	return nodeStringValueForSlug(value)
}

func nodeStringValueForSlug(value any) string {
	switch typed := value.(type) {
	case nil:
		return ""
	case string:
		return typed
	case bool:
		return strconv.FormatBool(typed)
	case float64:
		return javascriptNumberString(typed)
	case []any:
		parts := make([]string, len(typed))
		for index, item := range typed {
			parts[index] = nodeStringValueForSlug(item)
		}
		return strings.Join(parts, ",")
	default:
		return "[object Object]"
	}
}

func javascriptNumberString(value float64) string {
	if value == 0 {
		return "0"
	}
	absolute := math.Abs(value)
	if absolute >= 1e-6 && absolute < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64)
	}
	exponential := strconv.FormatFloat(value, 'e', -1, 64)
	parts := strings.SplitN(exponential, "e", 2)
	if len(parts) != 2 {
		return exponential
	}
	exponent, err := strconv.Atoi(parts[1])
	if err != nil {
		return exponential
	}
	sign := "+"
	if exponent < 0 {
		sign = ""
	}
	return parts[0] + "e" + sign + strconv.Itoa(exponent)
}
