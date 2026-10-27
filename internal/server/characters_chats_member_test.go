package server

// THE `chats` MEMBER: WHAT PINTED PRODUCES, RESOLVED FROM THE SOURCE.
//
// WHY THE CONTRADICTION HAD TO BE SETTLED FIRST. `GoTavern Lane CI` 40444357552 measured
// `/api/characters/all` answering `chats=<nil>` for a character that HAS a chat on disk, and the obvious reading --
// "pinned sets `chats: true` and we omit it" -- does not survive the source: `src/endpoints/characters.js`
// @06bde939 NEVER assigns `chats`. It is not in `processCharacter` (:406-441), not in `readFromV2` (:504-557, which
// assigns `chat`, not `chats`), not in `toShallow` (:586-607). A member pinned never writes is a member this port
// must not write either, and "populate it from chat_size > 0" would have been a NEW divergence introduced to
// satisfy a measurement that nobody had read down to its cause.
//
// WHAT PINTED ACTUALLY PRODUCES, branch by branch (all cited lines are src/endpoints/characters.js @06bde939):
//
//   :1466-1472  router.post('/all'): the roster is `files.filter(f => f.endsWith('.png'))`
//               then `.map(file => processCharacter(file, …))` then `.filter(c => c.name)`.
//               NO empty roster is ever sent from this route: there is no `if (!pngFiles.length)`.
//
//   :406-425    processCharacter, happy path: getCharaCardV2 -> `jsonObject.avatar = item` -> `character.json_data`
//               -> date_added / create_date -> `calculateChatSize(path.join(directories.chats, item.replace('.png','')))`
//               -> `character.chat_size`, `character.date_last_chat` -> `calculateDataSize(jsonObject?.data)`
//               -> `return shallow ? toShallow(character) : character`.
//               Every member the card document carried is still there -- the function RETURNS the processed
//               document, it does not build a projection -- and `chat`/`chats` are left exactly as the card had
//               them, except that readFromV2 guarantees `chat` (:554).
//
//   :426-440    processCharacter, catch: `{ date_added: 0, date_last_chat: 0, chat_size: 0 }`. NO name, so :1471
//               drops the row. THIS DOES NOT DEPEND ON THE CATCH. `chat_size` is assigned unconditionally at :422,
//               so by the time ANY later statement can throw `chat_size` already exists: the catch's own
//               `chat_size: 0` then writes `undefined`, and the THREE-VALUED property list below is the result.
//               (This is the resolution of the contradiction: pinned does not omit `chats`; it emits three
//               different shapes depending on where in :406-425 processing stopped.)
//
//   :1473-1477  catch of the whole /all handler: `isRangeError = err instanceof RangeError` is the ONLY way
//               `overflow: true` is produced, so `{overflow:false,error:true}` is a shape pinned cannot emit.
//
// AND `chats` ITSELF IS FRONTEND-DERIVED (public/script.js:567-574, setCharacterId -> getCharacters):
//       character.chats = character.chat_size > 0 || Array.isArray(character.chats) && character.chats.length > 0;
// so the member exists on the client for every row with a non-empty chats directory, whatever the card said, and
// the resume branch (`if (character.chats)`, :614+) is a truth test that cannot distinguish an absent member from
// a false one. The defect in 40444357552 is therefore NOT user-visible on the resume path: the frontend computes
// `chats` from `chat_size` on every load. What it IS is evidence of the `chat_size: undefined` branch below.
//
// THE THREE-VALUED PROPERTY LIST (JSON.stringify drops `undefined` members and `undefined` array items become
// `null`) is what these rows assert, because it is exactly what a browser receives.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// rawRosterOrBody asks /api/characters/all and returns the parsed body, whatever its shape, so a shape that is not
// an array can be REPORTED rather than misread as an empty roster.
func rawRosterOrBody(t *testing.T, env *charactersOracleEnv) orderedNodeJSON {
	t.Helper()
	response := env.serve(t, http.MethodPost, "/api/characters/all", "application/json", "{}")
	if response.Code != http.StatusOK {
		t.Fatalf("/api/characters/all = %d: %s", response.Code, response.Body.String())
	}
	parsed, err := decodeOrderedNodeJSON(response.Body.Bytes())
	if err != nil {
		t.Fatalf("/api/characters/all did not answer JSON: %s", response.Body.String())
	}
	return parsed
}

// chatsMemberPresence is the gate for the `chats` contradiction: it asserts PROPERTY PRESENCE of the three
// members that a browser receives, on the same card in two states.
func TestPinnedRosterEmitsTheMembersItsCardDocumentCarries(t *testing.T) {
	const cardName = "Member Shape Card"
	env := newCharactersOracleEnv(t, "chats-member-cookie-secret")
	writeFixtureFile(t, filepath.Join(env.Directories["characters"], "Member Shape Card.png"),
		replayCardPNG(t, cardName, ""), 1700000000000)

	without := rawRoster(t, env)
	if len(without) != 1 {
		t.Fatalf("rosterWithNoChats: /api/characters/all answered %d rows, wanted 1", len(without))
	}
	row := without[0]
	if got, kind := memberKind(row, "chat_size"); kind != "number" {
		t.Fatalf("rosterWithNoChats: chat_size is %s, wanted a number -- pinned assigns it unconditionally at "+
			"src/endpoints/characters.js:422, so a row that reached :422 always carries it", got)
	}
	if got, kind := memberKind(row, "chat"); kind != "string" || got == "" {
		t.Fatalf("rosterWithNoChats: chat is %s, wanted the default string from readFromV2:554 (`${char.name} - "+
			"${humanizedDateTime()}`)", kind)
	}
	// `chats` IS NOT PINNED'S TO EMIT (no assignment anywhere in the endpoint source; the frontend derives it from
	// chat_size at public/script.js:567-574). Asserting its absence keeps a future "helpful" addition visible.
	if kind := memberKind(row, "chats"); kind != "absent" {
		t.Fatalf("rosterWithNoChats: chats is %s; pinned never assigns `chats` in src/endpoints/characters.js, and the "+
			"frontend computes it from chat_size (public/script.js:567-574) -- emitting it here is a divergence, not a fix", kind)
	}

	// THE SAME CARD, NOW WITH A CHAT, written by the product's own save route (so the location is the product's).
	if err := os.MkdirAll(filepath.Join(env.Directories["chats"], "Member Shape Card"), 0o777); err != nil {
		t.Fatal(err)
	}
	writeFixtureFile(t, filepath.Join(env.Directories["chats"], "Member Shape Card", "existing.jsonl"),
		[]byte(`{"user_name":"User","character_name":"`+cardName+`"}`+"\n"+`{"name":"Unnamed","is_user":true,"mes":"hi"}`+"\n"),
		1700000000000)
	with := rawRoster(t, env)
	if len(with) != 1 {
		t.Fatalf("rosterWithChats: /api/characters/all answered %d rows, wanted 1", len(with))
	}
	if size, kind := memberKind(with[0], "chat_size"); kind != "number" || size == "0" {
		t.Fatalf("rosterWithChats: chat_size is %s (%s), wanted the summed size of the chats directory "+
			"(calculateChatSize, :342-358)", size, kind)
	}
	if kind := memberKind(with[0], "chats"); kind != "absent" {
		t.Fatalf("rosterWithChats: chats is %s; see above -- the member is the frontend's, derived from chat_size", kind)
	}
}

// The empty-directory and missing-directory cases are the same code path (`calculateChatSize` :346-355 returns
// 0/0 without reading fs when the directory is absent), and a PINNED roster for an empty characters directory is
// a 200 with `[]` -- never `{overflow,error}` (there is no empty check at :1466-1472). Both are pinned shapes this
// port must match, and the second one is the branch that makes `overflow:false` unproducible.
func TestPinnedRosterForAnEmptyCharacterList(t *testing.T) {
	env := newCharactersOracleEnv(t, "chats-empty-cookie-secret")
	raw := rawRosterOrBody(t, env)
	if raw.kind != 'a' {
		t.Fatalf("emptyCharacters: /api/characters/all answered %s, wanted an empty array -- pinned's /all has no "+
			"empty-directory branch (src/endpoints/characters.js:1466-1472), and `{overflow:false,error:true}` is a shape "+
			"`err instanceof RangeError` (:1475) cannot produce", raw.describe())
	}
	if len(raw.array) != 0 {
		t.Fatalf("emptyCharacters: roster has %d rows, wanted 0", len(raw.array))
	}
}

// helpers ---------------------------------------------------------------------------------------------

func memberKind(row map[string]json.RawMessage, name string) (string, string) {
	value, exists := row[name]
	if !exists {
		return "", "absent"
	}
	var text string
	if err := json.Unmarshal(value, &text); err == nil {
		return text, "string"
	}
	var number float64
	if err := json.Unmarshal(value, &number); err == nil {
		return fmt.Sprintf("%v", number), "number"
	}
	var flag bool
	if err := json.Unmarshal(value, &flag); err == nil {
		return fmt.Sprintf("%v", flag), "boolean"
	}
	return string(value), "other"
}

func rawRoster(t *testing.T, env *charactersOracleEnv) []map[string]json.RawMessage {
	t.Helper()
	parsed := rawRosterOrBody(t, env)
	if parsed.kind != 'a' {
		t.Fatalf("/api/characters/all answered %s, wanted an array", parsed.describe())
	}
	rows := make([]map[string]json.RawMessage, 0, len(parsed.array))
	for _, item := range parsed.array {
		encoded, err := marshalCharacterJSON(item)
		if err != nil {
			t.Fatal(err)
		}
		var row map[string]json.RawMessage
		if err := json.Unmarshal(encoded, &row); err != nil {
			t.Fatalf("a roster row is not an object: %s", encoded)
		}
		rows = append(rows, row)
	}
	return rows
}

func (value orderedNodeJSON) describe() string {
	switch value.kind {
	case 'a':
		return fmt.Sprintf("an array of %d", len(value.array))
	case 'o':
		keys := make([]string, 0, len(value.object))
		for _, entry := range value.object {
			keys = append(keys, entry.key)
		}
		return fmt.Sprintf("an object with members %v", keys)
	default:
		return fmt.Sprintf("kind %q", string(value.kind))
	}
}
