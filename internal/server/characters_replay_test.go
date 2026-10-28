package server

// A CARD THE PRODUCT REWRITES MUST STILL BE THE CARD IT WAS.
//
// WHY THIS TEST EXISTS. `Browser differential` run 40438262854, step "Hand GoTavern's own tree back to pinned
// Node (Q21)", measured the same bytes twice in ONE run: the probe staged tests/browser/fixtures/real/card-a.png
// (sha256 9f4f0834…106, and the report's writtenTree lists default-user/characters/Q21 Handback Card.png at that
// digest), the probe's own reading of that file's `data.name` was `MARK_000466测测测测测测测测`, and
// /api/characters/all listed `MARK_002794测测测测测测测测`. Six commits (48dadff, 6208083, 176c787, b501279,
// 3499f03, 12c78b7, a5660b6) changed the DRIVER to make those two agree. They cannot agree from the driver's
// side: the bytes the product reads back are not the bytes it staged.
//
// THE CAUSE is a pinned quirk this repository reproduces: pinned `character-card-parser.read` gives `ccv3`
// PRECEDENCE over `chara`, and pinned `write` re-writes `chara` with the card JSON it was given AND derives
// `ccv3` by re-parsing that JSON onto a V3 skeleton. A V2 card therefore round-trips as two chunks that are
// deliberately not the same document, and every read after a write answers the V3 shape.
// `writeFixtureCards` in characters_oracle_test.go writes pinned PNGs straight to disk and never executes a
// write path, so the live browser leg was the only place this round trip ran -- and it produced a roster nobody
// could explain.
//
// WHAT THIS GATE PINS, each row able to fail on its own:
//   written        the write path produced both chunks
//   v3Shape        `ccv3` carries spec=chara_card_v3 and `chara` still carries the document it was given
//   dataNameStored the card's own `data.name` survives in both chunks and in the STORED bytes
//   rosterName     /api/characters/all answers a name the stored bytes actually carry -- not a different one
//
// THE LAST ROW IS THE ONE THAT WAS RED. The names are deliberately DIFFERENT in the two subtrees (a real card is
// generated that way: the fixture generator replaces `data.name` and `_root.name` with its own markers), so an
// assertion that the roster holds `data.name` alone would be a derivation. The honest, falsifiable claim is that
// the roster's name is one the file carries -- and the first version of this card, with no V1 root, showed the
// roster answering "" for a port whose pinned oracle answers the V3 name.

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The PNG encoder is written out here rather than shared with the production one: a gate whose input is produced
// by the implementation under test proves the two agree, never that either is right. Only the chunk layout is
// duplicated, which is the part the test has to control.
func replayPNGChunk(scratch *[4]byte, name string, data []byte) []byte {
	binary.BigEndian.PutUint32(scratch[:], uint32(len(data)))
	var out bytes.Buffer
	out.Write(scratch[:])
	out.WriteString(name)
	out.Write(data)
	binary.BigEndian.PutUint32(scratch[:], crc32.Update(crc32.ChecksumIEEE([]byte(name)), crc32.IEEETable, data))
	out.Write(scratch[:])
	return out.Bytes()
}

func replayPNGText(keyword, document string) []byte {
	payload := append([]byte(keyword), 0)
	return append(payload, base64.StdEncoding.EncodeToString([]byte(document))...)
}

// replayCardPNG builds a 2x2 RGB PNG whose `data.name` is dataName and whose V1 root `name` is rootName -- the
// shape every real card has, and the field pinned's V3 projection can prefer. `chara` is written BEFORE `ccv3`,
// which is the order the committed card carries rather than a convenient one.
func replayCardPNG(t *testing.T, dataName, rootName string) []byte {
	t.Helper()
	stringMember := func(key, value string) orderedNodeJSONEntry {
		return orderedNodeJSONEntry{key: key, value: nodeString(value)}
	}
	card := orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
		stringMember("spec", "chara_card_v2"),
		stringMember("spec_version", "2.0"),
		stringMember("name", rootName),
		stringMember("description", "replay card"),
		stringMember("personality", "replay"),
		stringMember("scenario", "replay"),
		stringMember("first_mes", "hello from the replay card"),
		stringMember("mes_example", ""),
		stringMember("create_date", "2024-01-01T00:00:00.000Z"),
		{key: "data", value: orderedNodeJSON{kind: 'o', object: []orderedNodeJSONEntry{
			stringMember("name", dataName),
			stringMember("description", "replay card"),
			stringMember("personality", "replay"),
			stringMember("scenario", "replay"),
			stringMember("first_mes", "hello from the replay card"),
			stringMember("mes_example", ""),
			stringMember("creator_notes", ""),
			stringMember("system_prompt", ""),
			stringMember("post_history_instructions", ""),
			{key: "alternate_greetings", value: nodeArray()},
			{key: "tags", value: nodeArray()},
			stringMember("creator", "replay"),
			stringMember("character_version", "1"),
			{key: "extensions", value: nodeObject()},
		}}},
	}}
	document, err := marshalCharacterJSON(card)
	if err != nil {
		t.Fatalf("encode the replay card: %v", err)
	}

	var scratch [4]byte
	var image bytes.Buffer
	image.Write([]byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A})
	ihdr := make([]byte, 13)
	binary.BigEndian.PutUint32(ihdr[0:], 2)
	binary.BigEndian.PutUint32(ihdr[4:], 2)
	ihdr[8] = 8 // bit depth
	ihdr[9] = 2 // colour type: truecolour
	image.Write(replayPNGChunk(&scratch, "IHDR", ihdr))
	// 2 rows of (filter byte + 2 pixels * 3 channels), all zero, in a stored zlib stream.
	var idat bytes.Buffer
	idat.Write([]byte{0x78, 0x01, 0x01, 0x0E, 0x00, 0xF1, 0xFF})
	idat.Write(make([]byte, 14))
	idat.Write([]byte{0x00, 0x00, 0x00, 0x00, 0x00})
	image.Write(replayPNGChunk(&scratch, "IDAT", idat.Bytes()))
	image.Write(replayPNGChunk(&scratch, "tEXt", replayPNGText("chara", string(document))))
	image.Write(replayPNGChunk(&scratch, "tEXt", replayPNGText("ccv3", string(document))))
	image.Write(replayPNGChunk(&scratch, "IEND", nil))
	return image.Bytes()
}

// replayCardField returns a dotted field of one chunk's JSON document, "" when it is absent. The PNG walk is the
// test's own, so a defect in the production reader cannot make a precondition pass.
func replayCardField(t *testing.T, image []byte, keyword, field string) string {
	t.Helper()
	offset := 8
	for offset+8 <= len(image) {
		length := int(binary.BigEndian.Uint32(image[offset:]))
		kind := string(image[offset+4 : offset+8])
		dataStart := offset + 8
		if dataStart+length > len(image) {
			break
		}
		if kind == "tEXt" {
			chunk := image[dataStart : dataStart+length]
			if zero := bytes.IndexByte(chunk, 0); zero > 0 && string(chunk[:zero]) == keyword {
				raw, err := base64.StdEncoding.DecodeString(string(chunk[zero+1:]))
				if err != nil {
					t.Fatalf("the %s chunk is not base64: %v", keyword, err)
				}
				var document map[string]any
				if err := json.Unmarshal(raw, &document); err != nil {
					t.Fatalf("the %s chunk is not JSON: %v", keyword, err)
				}
				current := any(document)
				for _, part := range strings.Split(field, ".") {
					object, isObject := current.(map[string]any)
					if !isObject {
						return ""
					}
					current = object[part]
				}
				text, _ := current.(string)
				return text
			}
		}
		if kind == "IEND" {
			break
		}
		offset = dataStart + length + 4
	}
	return ""
}

// TestPinnedCardRoundTripKeepsTheNameTheCardCarries is the gate for run 40438262854.
//
// THE CARD HAS NO V1 ROOT NAME, and that is the point rather than a simplification: `data.name` is then the ONLY
// name the file carries, so "the roster answers a name the file holds" becomes a single-answer question instead
// of a choice between two subtrees. Lane CI 40443253803 ran the two-name form and logged what it measured
// (roster "" for a card whose stored data.name was the marker); the shape that reproduces the reported run is
// this one, and it is the shape that stays.
func TestPinnedCardRoundTripKeepsTheNameTheCardCarries(t *testing.T) {
	const dataMarker = "MARK_900001_data_name_marker"
	staged := replayCardPNG(t, dataMarker, "")

	// THE PRECONDITION: the probe's own reading of the card it staged, and the chunk order the real card has.
	if own := replayCardField(t, staged, "ccv3", "data.name"); own != dataMarker {
		t.Fatalf("staged: the synthetic card's own data.name = %q, wanted %q", own, dataMarker)
	}
	if root := replayCardField(t, staged, "ccv3", "name"); root != "" {
		t.Fatalf("staged: the synthetic card carries a V1 root name %q; this gate needs data.name to be the only name in the file", root)
	}
	if chara, ccv3 := bytes.Index(staged, []byte("chara")), bytes.Index(staged, []byte("ccv3")); chara < 0 || ccv3 < 0 || chara > ccv3 {
		t.Fatalf("staged: chunk order chara@%d ccv3@%d, wanted chara before ccv3 as the committed card has it", chara, ccv3)
	}

	// THE WRITE PATH, executed the way a user reaches it: the product parses the card, writes it back, and the
	// roster is asked about THE STORED BYTES. Nothing downstream re-derives the document.
	parsed, err := readCharacterDataStrict(writeReplayFile(t, "staged.png", staged))
	if err != nil {
		t.Fatalf("the product could not read the card it will be asked to write: %v", err)
	}
	written, err := writePngCard(staged, parsed)
	if err != nil {
		t.Fatalf("the write path refused the card: %v", err)
	}

	if replayCardField(t, written, "chara", "spec") == "" {
		t.Fatal("written: the write path left no chara chunk")
	}
	ccv3Spec := replayCardField(t, written, "ccv3", "spec")
	charaSpec := replayCardField(t, written, "chara", "spec")
	if ccv3Spec != "chara_card_v3" || charaSpec == "chara_card_v3" {
		t.Fatalf("v3Shape: chara spec=%q ccv3 spec=%q; pinned write keeps chara as the document it was given and derives ccv3",
			charaSpec, ccv3Spec)
	}

	if got := replayCardField(t, written, "ccv3", "data.name"); got != dataMarker {
		t.Fatalf("dataNameStored/ccv3: data.name = %q, wanted %q -- the stored card must carry the name it was written with", got, dataMarker)
	}
	if got := replayCardField(t, written, "chara", "data.name"); got != dataMarker {
		t.Fatalf("dataNameStored/chara: data.name = %q, wanted %q", got, dataMarker)
	}
	// v1RootPreserved: the V1 root `name` is a FIELD, not a derived value, and a write must not invent or drop one.
	// It is the field pinned's V3 projection falls back to, so a write that loses it loses the only name a card
	// without `data.name` has -- and a write that INVENTS it would change which name a card is listed under. The
	// expected value is read off the STAGED bytes rather than assumed, so this row cannot be satisfied by a card
	// that never had one.
	if had, got := replayCardField(t, staged, "ccv3", "name"), replayCardField(t, written, "ccv3", "name"); had != got {
		t.Fatalf("v1RootPreserved: the staged card's V1 root name was %q and the written card's is %q; characters_card.go:234-249 "+
			"re-serialises without it, which is how a written card can be listed under a name its file no longer carries", had, got)
	}

	// THE ROSTER, over the route the browser calls, on the bytes the write path produced.
	env := newCharactersOracleEnv(t, "replay-card-cookie-secret")
	cardPath := filepath.Join(env.Directories["characters"], "Replay Card.png")
	writeFixtureFile(t, cardPath, written, 1700000000000)
	response := env.serve(t, http.MethodPost, "/api/characters/all", "application/json", "{}")
	if response.Code != http.StatusOK {
		t.Fatalf("/api/characters/all = %d: %s", response.Code, response.Body.String())
	}
	var rows []map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &rows); err != nil {
		t.Fatalf("/api/characters/all did not answer an array: %s", response.Body.String())
	}
	listed := make([]string, 0, len(rows))
	rowName := ""
	found := false
	for _, row := range rows {
		listed = append(listed, fmt.Sprintf("%v", row["name"]))
		if row["avatar"] == "Replay Card.png" {
			rowName, _ = row["name"].(string)
			found = true
		}
	}
	if !found {
		t.Fatalf("rosterName: /api/characters/all did not list Replay Card.png, whose stored data.name is %q; roster %v "+
			"(a row is dropped when the projected name is falsy, characters_read.go:76)", dataMarker, listed)
	}
	if rowName != dataMarker {
		t.Fatalf("rosterName: /api/characters/all answered %q for a card whose stored bytes carry data.name=%q and no V1 root name (roster %v); "+
			"this is the shape of run 40438262854, where the roster named a marker the file did not carry", rowName, dataMarker, listed)
	}
	t.Logf("OBSERVED: roster name %q; stored data.name %q, stored V1 root name %q", rowName, dataMarker, replayCardField(t, written, "ccv3", "name"))
}

func writeReplayFile(t *testing.T, name string, body []byte) string {
	t.Helper()
	target := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(target, body, 0o600); err != nil {
		t.Fatalf("write %s: %v", name, err)
	}
	return target
}
