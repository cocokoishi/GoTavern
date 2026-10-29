package server

// A UUID v4, for `openai.randomizeUserId`.
//
// THE PINNED SOURCE: src/endpoints/backends/chat-completions.js:2296-2298 sets
// `bodyParams['user'] = uuidv4()` with `uuidv4` imported from the `uuid` package (chat-completions.js:16,
// `import { v4 as uuidv4 } from 'uuid';`). A v4 UUID from that package is the RFC 4122 layout with 122 random
// bits and the version/variant nibbles forced:
//
//	xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx      (lowercase hex; y is 8, 9, a or b)
//
// It is not derived from a seed, a counter or the request, so the only things a caller can observe -- and the
// only things worth asserting -- are the shape and the fact that two requests do not share a value. This file
// therefore builds the shape itself from crypto/rand rather than taking on a module dependency for twelve
// bytes of formatting (AGENTS distribution rule: no new dependency without a stated need).

import (
	"crypto/rand"
	"encoding/hex"
)

// pinnedRandomUUIDv4 returns a fresh lowercase v4 UUID. It falls back to a time-free zero mapping only if the
// platform's cryptographic source fails, which cannot happen on any supported target; returning an error
// instead would turn a provider request into a failure over a value the provider ignores.
func pinnedRandomUUIDv4() string {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "00000000-0000-4000-8000-000000000000"
	}
	// RFC 4122 4.4: version 4 in the high nibble of byte 6, variant 10xx in the high bits of byte 8.
	raw[6] = raw[6]&0x0f | 0x40
	raw[8] = raw[8]&0x3f | 0x80

	encoded := make([]byte, 36)
	hex.Encode(encoded[0:8], raw[0:4])
	encoded[8] = '-'
	hex.Encode(encoded[9:13], raw[4:6])
	encoded[13] = '-'
	hex.Encode(encoded[14:18], raw[6:8])
	encoded[18] = '-'
	hex.Encode(encoded[19:23], raw[8:10])
	encoded[23] = '-'
	hex.Encode(encoded[24:36], raw[10:16])
	return string(encoded)
}
