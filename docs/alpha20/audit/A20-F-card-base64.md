# A20-F — the card base64 decoder rejected payloads pinned reads

| Field | Value |
|---|---|
| **ID** | A20-F (renumbered from my earlier A20-D label; the Lead lane owns A20-D/A20-E) |
| **Severity** | Medium |
| **Status** | FIXED on `a20/audit` (commit with this file) |
| **Source** | `internal/server/characters_card.go:193-202` (`decodeBase64UTF8`), called by `readPngCardText` for every `chara`/`ccv3` chunk |
| **Lane** | A (production source audit) |

## Summary

Pinned reads a card's JSON with

```js
// src/character-card-parser.js:80-100
const textChunks = chunks.filter((chunk) => chunk.name === 'tEXt').map((chunk) => PNGtext.decode(chunk.data));
...
return Buffer.from(textChunks[ccv3Index].text, 'base64').toString('utf8');
```

`Buffer.from(text, 'base64')` is **lenient**; Go's `encoding/base64` is strict. Measured against the
pinned Node 24.19.0 runtime (`Buffer.from(v,'base64').toString('utf8')`), Node:

- skips EVERY character outside the base64 alphabet — interior spaces, `#`, `!`, tabs, NUL-free junk —
  where Go ignores only `\r`/`\n`;
- accepts the **URL-safe** `-` and `_` as values 62/63 (a payload produced by Python's
  `base64.urlsafe_b64encode`, for example);
- stops at the first `=` and ignores everything after it;
- drops a lone leftover character (`length % 4 == 1`) instead of reporting a length error;
- converts invalid UTF-8 to U+FFFD (Node strings are UTF-16 text), where Go returned raw bytes.

Go's `decodeBase64UTF8` tried `StdEncoding` and then `RawStdEncoding` after trimming surrounding
whitespace and trailing `=`, so every case above except CR/LF failed with
`illegal base64 data at input byte N`. `readPngCardText` turns that into an error, and the card is
unreadable: `/api/characters/all` reports the error object for it, `/api/characters/get` and the edit path
answer 500.

## Reproducer

`internal/server/a20_card_base64_test.go`:

- `TestA20CardBase64DecodeMatchesNodeBufferFrom` — the measured Node rows (13 cases).
- `TestA20URLSafeBase64CardIsReadable` — end-to-end: builds a card PNG whose `chara` tEXt payload is
  URL-safe base64 (fixture text chosen so the standard encoding really contains a `+`), then calls
  `readCharacterDataStrict`.

RED (before the fix):

```
    a20_card_base64_test.go:50: decodeBase64UTF8("eyJh IjoxfQ==") error: illegal base64 data at input byte 4
    a20_card_base64_test.go:50: decodeBase64UTF8("Pz8-") error: illegal base64 data at input byte 3
    a20_card_base64_test.go:50: decodeBase64UTF8("eyJhIjoxfQ==junk") error: illegal base64 data at input byte 10
    a20_card_base64_test.go:50: decodeBase64UTF8("=eyJhIjoxfQ==") error: illegal base64 data at input byte 0
    a20_card_base64_test.go:50: decodeBase64UTF8("abcde") error: illegal base64 data at input byte 4
    (8 rows total)
--- FAIL: TestA20CardBase64DecodeMatchesNodeBufferFrom
    a20_card_base64_test.go:82: a card with a URL-safe base64 payload is unreadable: illegal base64 data at
      input byte 55
--- FAIL: TestA20URLSafeBase64CardIsReadable
```

GREEN after: both PASS; the character/card test families
(`go test ./internal/server -run '^(TestCharacter|TestPinnedNodeCharacters|TestCard|TestChara)' -count=1`)
→ `ok 37.300s`.

## Node oracle

Unit rows measured with Node 24.19.0 (the pinned runtime). End-to-end: a PNG of the same shape (real
1×1 image, `chara` tEXt = URL-safe base64 of the card JSON) was written by a scratch generator and read by
the **pinned** `src/character-card-parser.js`:

```
PINNED READ OK: {"name":"Wrapped Card","description":"abc~","data":{"name":"Wrapped Card"}}
```

A line-wrapped (CR/LF) payload, by contrast, already worked in Go — Go's decoder ignores `\r`/`\n`, which
is why the first reproducer attempt (newline-wrapped base64) was a GREEN row, not a defect. That is
recorded in the test's `why` text so a later reader does not mistake it for a fix.

## User impact

A character card PNG written by a tool that URL-safe-encodes its base64 (Python's
`base64.urlsafe_b64encode` is a common choice when a payload is also used in URLs), or whose payload
contains an interior space / trailing junk, is **unreadable** by GoTavern while pinned SillyTavern reads it
and displays the card. The character list entry becomes the pinned error object (empty name/avatar), and
opening/editing/exporting the card fails. No file is damaged — this is a read-compatibility defect.

## Fix

`decodeBase64UTF8` now reproduces Node's decoder: it maps the standard and URL-safe alphabets onto one,
skips every other byte, stops at the first `=`, drops a lone leftover character, pads, decodes with
`StdEncoding`, and applies `strings.ToValidUTF8(..., "\uFFFD")` for the JS-string conversion. Valid
standard-base64 input produces byte-identical output to the old implementation, so only formerly-rejected
input changes.

## Mutation evidence

`internal/server/characters_card.go`, URL-safe mapping removed
(`case character == '+' || character == '-'`/`'/' || '_'` → accepting only `+`/`/`), `-count=1`:

```
--- FAIL: TestA20CardBase64DecodeMatchesNodeBufferFrom
    decodeBase64UTF8("Pz8-") = "??", want "??>" (URL-safe '-' is value 62)
    decodeBase64UTF8("Pz8_") = "??", want "???" (URL-safe '_' is value 63)
--- FAIL: TestA20URLSafeBase64CardIsReadable
```

Restored by file copy; sha256 back to `4EB403FB…`.

## Regression guard

`internal/server/a20_card_base64_test.go`: the Node-measured decoder rows plus the end-to-end URL-safe card
(the fixture refuses to run if its input has no `+`/`/`, so it cannot become a vacuous test).
