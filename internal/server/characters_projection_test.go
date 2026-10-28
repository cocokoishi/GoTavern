package server

// WHICH NAME DOES THE ROSTER ANSWER, AND WHICH FIELD DID IT COME FROM?
//
// WHY THIS FILE EXISTS. `Browser differential` 40438262854 and 40444636900 (both mode preset) failed the Q21
// precondition identically, on main@a5660b61 and on a fresh branch with no product change:
//
//     characterStaged: wanting "MARK_000466测测测测测测测测"; roster ["MARK_002794测测测测测测测测","Seraphina"]
//
// Both runs fail at `characterStaged`, the probe's FIRST check after staging and BEFORE a browser exists, so no
// chat has been created at that point: the roster string is a NAME-PROJECTION fact and has nothing to do with
// chat identity. Six commits (48dadff, 6208083, 176c787, b501279, 3499f03, 12c78b7, a5660b6) changed the DRIVER
// against the assumption b501279 stated -- "the server shows the card's own data.name" -- and the projection
// itself was never read.
//
// THE PROJECTION, QUOTED FROM PINNED (this is the whole decision; src/endpoints/characters.js at 06bde939):
//
//   500-506  function readFromV2(char) { if (_.isUndefined(char.data)) { … return char; }
//   513-523  const fieldMappings = { name: 'name', description: 'description', … }
//   525-551  _.forEach(fieldMappings, (v2Path, charField) => { const v2Value = _.get(char.data, v2Path);
//              if (_.isUndefined(v2Value)) { … return; }   //  <- a MISSING data.name LEAVES char.name alone
//              char[charField] = v2Value; })                //  <- a PRESENT data.name OVERWRITES char.name
//
// So the roster's `name` is `data.name` when that string exists, and the document's own root `name` when it does
// not. It is NEVER a third value. That single sentence decides the marker question, and it makes the gate below
// cheap: read the STAGED BYTES of the committed derivation, and require the roster's answer to be one of the two
// names those bytes carry -- naming the field when it is not.
//
// WHICH CHUNK IS READ IS ALSO PINNED (src/character-card-parser.js:54-78): `ccv3` takes precedence over `chara`,
// and each chunk is its own complete document. If the two chunks carry DIFFERENT names, the roster can answer a
// name that exists in the file but not in the document the probe read -- and then the FIXTURE is internally
// inconsistent (tools/build-real-fixtures.mjs derives each chunk independently) rather than the product being
// wrong. This gate therefore prints all four names (two per chunk) and reports which case it is.
//
// NO BROWSER, NO GENERATOR: it reads the committed byte file the probe stages, so it runs in `go test` on every
// push and cannot drift the way a probe-side reading can.

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

// committedCardPath is the derivation the Q21 probe stages (AGENTS 56: the originals never enter this repository).
const committedCardPath = "../../tests/browser/fixtures/real/card-a.png"

type chunkNames struct {
	keyword string
	data    string // data.name
	root    string // the document's own V1 root name
}

// readCardChunkNames decodes every chara/ccv3 chunk of a PNG and returns both name fields of each, IN FILE ORDER,
// using the test's own PNG walk and its own JSON decode so a defect in the production reader cannot make this
// pass.
func readCardChunkNames(t *testing.T, image []byte) []chunkNames {
	t.Helper()
	found := make([]chunkNames, 0, 2)
	offset := 8
	for offset+8 <= len(image) {
		length := int(readUint32BE(image[offset:]))
		kind := string(image[offset+4 : offset+8])
		if kind == "IEND" {
			break
		}
		if offset+8+length > len(image) {
			t.Fatalf("chunk %q at %d claims %d bytes but the file ends at %d", kind, offset, length, len(image))
		}
		if kind == "tEXt" {
			payload := image[offset+8 : offset+8+length]
			for index, code := range payload {
				if code != 0 {
					continue
				}
				keyword := string(payload[:index])
				if keyword != "chara" && keyword != "ccv3" {
					break
				}
				decoded, err := base64.StdEncoding.DecodeString(string(payload[index+1:]))
				if err != nil {
					t.Fatalf("the %s chunk is not base64: %v", keyword, err)
				}
				var document struct {
					Name string `json:"name"`
					Data struct {
						Name string `json:"name"`
					} `json:"data"`
				}
				if err := json.Unmarshal(decoded, &document); err != nil {
					t.Fatalf("the %s chunk is not JSON: %v", keyword, err)
				}
				found = append(found, chunkNames{keyword: keyword, data: document.Data.Name, root: document.Name})
				break
			}
		}
		offset += 12 + length
	}
	return found
}

// TestCommittedCardProjectionNamesTheFieldTheRosterAnswers is the gate for the two Q21 precondition runs.
func TestCommittedCardProjectionNamesTheFieldTheRosterAnswers(t *testing.T) {
	image, err := os.ReadFile(filepath.Clean(committedCardPath))
	if err != nil {
		t.Fatalf("the committed derivation is not readable at %s: %v -- a gate that cannot read its input must refuse, "+
			"not pass", committedCardPath, err)
	}
	chunks := readCardChunkNames(t, image)
	if len(chunks) == 0 {
		t.Fatalf("%s carries no chara/ccv3 chunk, so there is nothing to project", committedCardPath)
	}
	// EVERY NAME THE FILE HOLDS, PRINTED, IN FILE ORDER. A row that does not print both fields for both chunks
	// cannot tell chunk-precedence apart from the V1-root fallback, and that distinction is the finding.
	for _, chunk := range chunks {
		t.Logf("%s: data.name=%q root.name=%q", chunk.keyword, chunk.data, chunk.root)
	}

	// THE READER'S CHOICE, i.e. what processCharacter parses: ccv3 first, then chara.
	selected, ok := selectChunkByPinnedPrecedence(chunks)
	if !ok {
		t.Fatalf("%s carries no chunk the pinned reader would select", committedCardPath)
	}
	// THE PREDICTION, derived from readFromV2 (src/endpoints/characters.js:525-551): data.name when present,
	// otherwise the document's own root name. Stated as the two candidates so a failure names the field.
	predicted, field := selected.data, "data.name"
	if selected.data == "" {
		predicted, field = selected.root, "root.name"
	}

	env := newCharactersOracleEnv(t, "committed-card-cookie-secret")
	staged := filepath.Join(env.Directories["characters"], "Committed Card.png")
	writeFixtureFile(t, staged, image, 1700000000000)
	row := characterRow(t, env, "Committed Card.png")
	answered, _ := row["name"].(string)

	if answered != predicted {
		// THE FAILURE NAMES THE FIELD, WHICH IS THE POINT. Two cases are possible and this message distinguishes
		// them from the file's own contents rather than from an opinion about them.
		same := len(chunks) == 2 && chunks[0].data == chunks[1].data && chunks[0].root == chunks[1].root
		detail := "the two chunks are IDENTICAL documents"
		if !same {
			detail = fmt.Sprintf("the two chunks are DIFFERENT documents (chara: data.name=%q root.name=%q; ccv3: data.name=%q root.name=%q)",
				chunks[0].data, chunks[0].root, chunks[len(chunks)-1].data, chunks[len(chunks)-1].root)
		}
		t.Fatalf("roster answers %q, but pinned readFromV2 predicts %q (%s) from the %s chunk the reader selects; %s",
			answered, predicted, field, selected.keyword, detail)
	}
	t.Logf("OBSERVED: the roster answers %q, which is the %s of the %s chunk", answered, field, selected.keyword)

	// THE DISCRIMINATING CASE, built rather than assumed: a card with ONLY data.name. Measured green on Lane CI
	// 40443253803, and it is what proves the projection PREFERS data.name rather than merely tolerating it -- which
	// in turn means the committed card's answer can differ from its ccv3 data.name only through a document that
	// also carries a root name.
	const onlyData = "MARK_910001_data_only_marker"
	env2 := newCharactersOracleEnv(t, "committed-card-cookie-secret-2")
	writeFixtureFile(t, filepath.Join(env2.Directories["characters"], "Data Only.png"), replayCardPNG(t, onlyData, ""), 1700000000000)
	if got, _ := characterRow(t, env2, "Data Only.png")["name"].(string); got != onlyData {
		t.Fatalf("projectionPrefersDataName: a card whose ONLY name is data.name=%q was listed as %q; the pinned "+
			"readFromV2 assignment (src/endpoints/characters.js:551) must carry data.name through unchanged", onlyData, got)
	}
}

// selectChunkByPinnedPrecedence mirrors character-card-parser.read: the FIRST ccv3 chunk, else the FIRST chara.
func selectChunkByPinnedPrecedence(chunks []chunkNames) (chunkNames, bool) {
	for _, chunk := range chunks {
		if chunk.keyword == "ccv3" {
			return chunk, true
		}
	}
	for _, chunk := range chunks {
		if chunk.keyword == "chara" {
			return chunk, true
		}
	}
	return chunkNames{}, false
}
