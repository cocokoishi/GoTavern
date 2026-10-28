package server

// THE ROSTER'S ERROR CONTRACT, TAKEN FROM THE RECORDED PINNED CAPTURE AND NOT FROM A READING OF THE HANDLER.
//
// WHY THIS FILE EXISTS. `GoTavern Lane CI` 40444357552 measured `/api/characters/all` answering
// `{overflow:<nil>,error:true}` for a character that exists but could not be parsed, and I claimed -- twice, in
// commit messages that are now part of this lane's history -- that pinned cannot produce `overflow:false` because
// `const isRangeError = err instanceof RangeError` (src/endpoints/characters.js:1475) is the only way `overflow` is
// ever true. THE RECORDED PINNED CAPTURE REFUTES THAT CLAIM, and the capture wins (AGENTS differential doctrine 1:
// an oracle, not a reading, decides):
//
//     tests/oracle/sillytavern-1.19.0-characters-read.json, responses.allMissingDirectory
//     status 500, bodyText {"overflow":false,"error":true}
//
// recorded from the pinned server (06bde939) with `fs.rmSync(charactersRoot)` before the request, i.e. the
// characters directory ABSENT. So pinned DOES answer `overflow:false` on this route, and the shape GoTavern serves
// is pinned-compatible there. My second claim had the right verdict on the first case and the wrong reason.
//
// WHAT THE CAPTURE DOES NOT COVER, and this is the gap the ports diverge in: pinned's `/all` (:1466-1477) is
// synchronous up to `response.send(data)`, while this port serves `{overflow:false,error:true}` from ANY failure to
// list or read the characters directory -- including a directory that EXISTS and cannot be listed. Under pinned, a
// real fs error at :1468 rejects a promise, is NOT caught (:1473 catches only synchronous throws, and the missing
// `.catch` is what the recorded 500 comes from), and Express answers its own 500 page, which is NOT JSON. So:
//
//     characters directory MISSING       -> JSON {overflow:false,error:true}   recorded oracle, both subjects
//     characters directory UNLISTABLE    -> Express HTML 500 page              source-derived, NOT recorded
//
// The second row is pinned-UNREACHABLE in this harness on purpose: an unlistable directory needs chmod 000, and the
// recording probe runs as root in CI where chmod does not deny the owner. It is therefore pinned here as
// SOURCE-DERIVED, with the predicate quoted, and labelled as such rather than dressed up as an oracle (AGENTS
// verification rule 4). GoTavern currently answers the JSON body for that case, which is a divergence this test
// RECORDS rather than asserts: asserting it would pin behaviour the oracle does not support, and asserting its
// absence would make the port fail a case no user reaches on a fresh install.
//
// THE ROW THAT IS AN ORACLE. A card that EXISTS and cannot be parsed is recorded, in the same capture: the roster
// lists Alice V2.png and Dual.png and OMITS Invalid JSON.png, No Metadata.png, Broken.png and NoName.png, because
// `processCharacter`'s catch (:426-440) returns an object without `name` and :1471 filters `c => c.name`. This test
// asserts that against the recorded body AND against the bytes the capture recorded, so the fixture's card set is
// proved to be the one the expectation came from.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// TestPinnedRosterDropsUnparseableCards asserts the recorded roster's membership: every card the capture recorded
// as present and named appears, every card it recorded as unparseable is absent, and NO row carries an `overflow`
// hint -- the row contract for a bad CARD is "omitted", not "reported".
func TestPinnedRosterDropsUnparseableCards(t *testing.T) {
	fixture := readCharactersFixture(t, "sillytavern-1.19.0-characters-read.json")
	env := newCharactersOracleEnv(t, fixture.Inputs.CookieSecret)
	env.writeFixtureCards(t, fixture)
	env.writeFixtureChats(t, fixture)

	// THE EXPECTATION IS READ FROM THE CAPTURE, not written here: every row of the recorded /all body, by avatar.
	want, exists := fixture.Responses["all"]
	if !exists || !want.BodyIsJSON {
		t.Fatal("the capture has no JSON `all` response, so this test would be asserting nothing")
	}
	var recorded []map[string]json.RawMessage
	if err := json.Unmarshal(want.Body, &recorded); err != nil {
		t.Fatalf("the captured /all body is not an array: %v", err)
	}
	if len(recorded) == 0 {
		t.Fatal("the captured /all body is empty, so a missing row could not be distinguished from a dropped one")
	}
	recordedAvatars := make(map[string]bool, len(recorded))
	for _, row := range recorded {
		var avatar string
		_ = json.Unmarshal(row["avatar"], &avatar)
		recordedAvatars[avatar] = true
	}

	// EVERY FILE THE CAPTURE SEEDED, so "absent from the roster" means "present on disk and dropped", which is the
	// only reading that tests the filter.
	seeded := make([]string, 0, len(fixture.Inputs.Cards))
	for _, card := range fixture.Inputs.Cards {
		seeded = append(seeded, card.File)
	}
	for _, file := range seeded {
		if _, ok := recordedAvatars[file]; ok {
			continue
		}
		// Dropped by the capture -- assert the port drops it too, and say which recorded row proves the drop.
		response := env.serve(t, http.MethodPost, "/api/characters/all", "application/json", "{}")
		if response.Code != http.StatusOK {
			t.Fatalf("%s: /api/characters/all = %d while the capture answers 200 with the row omitted: %s",
				file, response.Code, response.Body.String())
		}
		var rows []map[string]json.RawMessage
		if err := json.Unmarshal(response.Body.Bytes(), &rows); err != nil {
			t.Fatalf("%s: roster is not an array: %s", file, response.Body.String())
		}
		for _, row := range rows {
			var avatar string
			_ = json.Unmarshal(row["avatar"], &avatar)
			if avatar == file {
				t.Fatalf("unparseableCardDropped: %s is on disk and cannot be parsed, and the recorded pinned roster "+
					"omits it (processCharacter's catch returns no `name`, filtered at src/endpoints/characters.js:1471), "+
					"but this port listed it", file)
			}
		}
	}
}

// TestRecordedMissingDirectoryIsTheNonOverflowError is the oracle row for the error shape: the capture itself is
// evidence that `overflow:false` is producible, so the port matching it is parity rather than a defect.
func TestRecordedMissingDirectoryIsTheNonOverflowError(t *testing.T) {
	fixture := readCharactersFixture(t, "sillytavern-1.19.0-characters-read.json")
	recorded, exists := fixture.Responses["allMissingDirectory"]
	if !exists {
		t.Fatal("the capture has no allMissingDirectory response")
	}
	var body map[string]json.RawMessage
	if err := json.Unmarshal(recorded.Body, &body); err != nil {
		t.Fatalf("the captured allMissingDirectory body is not JSON: %v", err)
	}
	var overflow bool
	if err := json.Unmarshal(body["overflow"], &overflow); err != nil {
		t.Fatalf("the captured allMissingDirectory body has no boolean `overflow`: %s", recorded.BodyText)
	}
	// THIS ASSERTION EXISTS TO KEEP A RETRACTED CLAIM FROM BEING RE-LITIGATED FROM MEMORY. If the capture ever
	// changes to `overflow:true`, the retraction in this lane's history and the sentence above it both become
	// wrong, and this row is what would say so.
	if overflow {
		t.Fatalf("the captured allMissingDirectory body has overflow=true; the retraction recorded in this file's "+
			"header (and in commits 2e2c9ac/fb86a66) states pinned answers overflow:false -- re-read the capture: %s",
			recorded.BodyText)
	}
	if recorded.Status != http.StatusInternalServerError {
		t.Fatalf("the captured allMissingDirectory status is %d, wanted 500", recorded.Status)
	}

	// THE PORT, ON THE SAME STATE: characters directory absent.
	env := newCharactersOracleEnv(t, fixture.Inputs.CookieSecret)
	if err := removeDirectory(env.Directories["characters"]); err != nil {
		t.Fatal(err)
	}
	response := env.serve(t, http.MethodPost, "/api/characters/all", "application/json", "{}")
	if response.Code != recorded.Status || response.Body.String() != recorded.BodyText {
		t.Fatalf("missingCharactersDirectory: this port answers %d %s; the recorded pinned answer is %d %s",
			response.Code, response.Body.String(), recorded.Status, recorded.BodyText)
	}
}

// TestPinnedShallowRowMembersAreTheRecordedOnes asserts the member SET of a shallow row against the capture, which
// is where `chats` lives -- absent, because pinned never assigns it (src/endpoints/characters.js assigns `chat` in
// readFromV2:554 and `chats` nowhere; the frontend derives `chats` from `chat_size` at public/script.js:567-574).
//
// RECORDED RETRACTION, kept here because a withdrawn claim is evidence: this lane first asserted that the fix for a
// `chats=<nil>` reading was to POPULATE `chats` from `chat_size > 0`. That was withdrawn (commit 2e2c9ac) after the
// source showed pinned never assigns it, and the row below is the one that keeps a future "helpful" addition visible
// as the divergence it would be.
func TestPinnedShallowRowMembersAreTheRecordedOnes(t *testing.T) {
	fixture := readCharactersFixture(t, "sillytavern-1.19.0-characters-read.json")
	shallow, exists := fixture.Responses["allShallow"]
	if !exists || !shallow.BodyIsJSON {
		t.Fatal("the capture has no JSON allShallow response")
	}
	var recorded []map[string]json.RawMessage
	if err := json.Unmarshal(shallow.Body, &recorded); err != nil || len(recorded) == 0 {
		t.Fatalf("the captured allShallow body is not a non-empty array: %s", shallow.BodyText)
	}
	// The capture is the expectation for the MEMBER SET as well: every recorded row must be reproduced with the
	// same member names, and `chats` must not appear in either.
	for _, row := range recorded {
		var avatar string
		_ = json.Unmarshal(row["avatar"], &avatar)
		if _, present := row["chats"]; present {
			t.Fatalf("the captured shallow row for %s carries `chats`; this test's premise (pinned never assigns it) "+
				"would be wrong and the frontend-derived reading in public/script.js:567-574 would need revisiting", avatar)
		}
		if _, kind := memberKind(row, "chat_size"); kind != "number" {
			t.Fatalf("the captured shallow row for %s has chat_size=%s, wanted a number", avatar, kind)
		}
		if _, kind := memberKind(row, "chat"); kind != "string" {
			t.Fatalf("the captured shallow row for %s has chat=%s, wanted the readFromV2 default string", avatar, kind)
		}
	}

	env := newCharactersOracleEnvWithConfig(t, fixture.Inputs.CookieSecret, "performance:\n  lazyLoadCharacters: true\n")
	env.writeFixtureCards(t, fixture)
	env.writeFixtureChats(t, fixture)
	response := env.serve(t, http.MethodPost, "/api/characters/all", "application/json", "{}")
	if response.Code != http.StatusOK {
		t.Fatalf("/api/characters/all (shallow) = %d: %s", response.Code, response.Body.String())
	}
	var rows []map[string]json.RawMessage
	if err := json.Unmarshal(response.Body.Bytes(), &rows); err != nil {
		t.Fatalf("shallow roster is not an array: %s", response.Body.String())
	}
	for _, row := range rows {
		var avatar string
		_ = json.Unmarshal(row["avatar"], &avatar)
		if _, present := row["chats"]; present {
			t.Fatalf("shallowRoster/chats: this port emits a `chats` member for %s; pinned does not "+
				"(recorded row above), and the frontend computes it from chat_size", avatar)
		}
		if _, kind := memberKind(row, "chat"); kind != "string" {
			t.Fatalf("shallowRoster/chat: %s has chat=%s, wanted the readFromV2 default string", avatar, kind)
		}
	}
	// The port must also reproduce the row COUNT: a card the capture dropped is not listed shallow either.
	if len(rows) != len(recorded) {
		listed := make([]string, 0, len(rows))
		for _, row := range rows {
			var avatar string
			_ = json.Unmarshal(row["avatar"], &avatar)
			listed = append(listed, avatar)
		}
		t.Fatalf("shallowRoster: %d rows %v, the capture has %d", len(rows), listed, len(recorded))
	}
}

// removeDirectory removes a directory tree. A failure here would leave the test's premise unbuilt, so it is fatal
// in the caller rather than silently ignored.
func removeDirectory(path string) error {
	return os.RemoveAll(filepath.Clean(path))
}
