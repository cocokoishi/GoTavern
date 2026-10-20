package server

import (
	"encoding/json"
	"net/http"
	"os"
	"testing"
)

// TestPinnedNodeCharactersRead compares /api/characters/all, /get and /chats
// against the recorded pinned Node oracle, including PNG `chara`/`ccv3` chunk
// precedence, the Spec V1 -> V2 conversion, the shallow projection and the
// error responses.
func TestPinnedNodeCharactersRead(t *testing.T) {
	fixture := readCharactersFixture(t, "sillytavern-1.19.0-characters-read.json")
	env := newCharactersOracleEnv(t, fixture.Inputs.CookieSecret)
	env.writeFixtureCards(t, fixture)
	env.writeFixtureChats(t, fixture)

	const jsonContent = "application/json"
	jsonBody := func(value any) string {
		t.Helper()
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		return string(encoded)
	}
	assert := func(label, route, method, contentType, body string) {
		t.Helper()
		want, exists := fixture.Responses[label]
		if !exists {
			t.Fatalf("read fixture has no %q response", label)
		}
		got := env.serve(t, method, route, contentType, body)
		assertCharacterResponse(t, label, got, want)
	}

	assert("all", "/api/characters/all", http.MethodPost, jsonContent, "{}")
	for _, entry := range []struct{ label, avatar string }{
		{"getExisting", "Alice V2.png"},
		{"getV1", "Bob V1.png"},
		{"getV3", "Carol V3.png"},
		{"getDual", "Dual.png"},
		{"getBackfill", "Backfill V2.png"},
		{"getNoName", "NoName.png"},
		{"getInvalidJSON", "Invalid JSON.png"},
		{"getNoMetadata", "No Metadata.png"},
		{"getBroken", "Broken.png"},
		{"getMissing", "Missing.png"},
		{"getForbiddenPath", "../escape.png"},
	} {
		assert(entry.label, "/api/characters/get", http.MethodPost, jsonContent, jsonBody(map[string]any{"avatar_url": entry.avatar}))
	}
	assert("getNullAvatar", "/api/characters/get", http.MethodPost, jsonContent, jsonBody(map[string]any{"avatar_url": nil}))
	assert("getNumericAvatar", "/api/characters/get", http.MethodPost, jsonContent, jsonBody(map[string]any{"avatar_url": 7}))
	assert("getObjectAvatar", "/api/characters/get", http.MethodPost, jsonContent, jsonBody(map[string]any{"avatar_url": map[string]any{"toString": "x"}}))
	assert("getEmptyBody", "/api/characters/get", http.MethodPost, jsonContent, "")
	assert("getWrongMethod", "/api/characters/get", http.MethodGet, "", "")

	assert("chatsDefault", "/api/characters/chats", http.MethodPost, jsonContent, jsonBody(map[string]any{"avatar_url": "Alice V2.png"}))
	assert("chatsSimple", "/api/characters/chats", http.MethodPost, jsonContent, jsonBody(map[string]any{"avatar_url": "Alice V2.png", "simple": true}))
	assert("chatsMetadata", "/api/characters/chats", http.MethodPost, jsonContent, jsonBody(map[string]any{"avatar_url": "Alice V2.png", "metadata": true}))
	assert("chatsEmptyDirectory", "/api/characters/chats", http.MethodPost, jsonContent, jsonBody(map[string]any{"avatar_url": "Backfill V2.png"}))
	assert("chatsMissingDirectory", "/api/characters/chats", http.MethodPost, jsonContent, jsonBody(map[string]any{"avatar_url": "Missing.png"}))
	assert("chatsForbiddenPath", "/api/characters/chats", http.MethodPost, jsonContent, jsonBody(map[string]any{"avatar_url": "../x.png"}))

	// A leftover chats directory whose character card no longer exists still
	// answers, and its subdirectory and non-.jsonl file are skipped.
	orphanAvatar := fixture.Inputs.OrphanChats.Character + ".png"
	assert("chatsOrphanDirectory", "/api/characters/chats", http.MethodPost, jsonContent, jsonBody(map[string]any{"avatar_url": orphanAvatar}))
	assert("chatsOrphanSimple", "/api/characters/chats", http.MethodPost, jsonContent, jsonBody(map[string]any{"avatar_url": orphanAvatar, "simple": true}))

	assertCharacterChatStatistics(t, env, fixture)

	// The shallow projection runs with performance.lazyLoadCharacters enabled.
	shallowEnv := newCharactersOracleEnvWithConfig(t, fixture.Inputs.CookieSecret, "performance:\n  lazyLoadCharacters: true\n")
	shallowEnv.writeFixtureCards(t, fixture)
	shallowEnv.writeFixtureChats(t, fixture)
	shallowWant := fixture.Responses["allShallow"]
	assertCharacterResponse(t, "allShallow", shallowEnv.serve(t, http.MethodPost, "/api/characters/all", jsonContent, "{}"), shallowWant)

	// A missing characters directory is the non-overflow /all failure branch.
	if err := os.RemoveAll(shallowEnv.Directories["characters"]); err != nil {
		t.Fatal(err)
	}
	missingWant := fixture.Responses["allMissingDirectory"]
	assertCharacterResponse(t, "allMissingDirectory", shallowEnv.serve(t, http.MethodPost, "/api/characters/all", jsonContent, "{}"), missingWant)
}

// assertCharacterChatStatistics states the pinned chat_size/date_last_chat
// semantics directly instead of only comparing the recorded bytes.
//
// Pinned calculateChatSize sums the stat size of every entry in the character's
// chats directory and takes the newest entry mtime. Alice's chats directory
// holds files only, so both values are host-independent here. A directory's
// stat size is not (Linux ext4 reports 4096, Windows reports 0), which is why
// no chats directory that participates in a chat_size contains a
// subdirectory; see the fixture's normalization notes.
func assertCharacterChatStatistics(t *testing.T, env *charactersOracleEnv, fixture charactersFixture) {
	t.Helper()
	expectedChatSize := 0
	for _, body := range fixture.Inputs.ChatFiles {
		expectedChatSize += len(body)
	}
	response := env.serve(t, http.MethodPost, "/api/characters/all", "application/json", "{}")
	parsed, err := decodeOrderedNodeJSON(response.Body.Bytes())
	if err != nil || parsed.kind != 'a' {
		t.Fatalf("GET /all did not return an array: %s", response.Body.String())
	}
	var character orderedNodeJSON
	found := false
	for _, item := range parsed.array {
		if name, ok := nodeGet(item, "avatar").stringValue(); ok && name == fixture.Inputs.ChatCharacter+".png" {
			character = item
			found = true
			break
		}
	}
	if !found {
		t.Fatalf("/all did not list %s.png", fixture.Inputs.ChatCharacter)
	}
	if size, ok := jsNumber(nodeGet(character, "chat_size")); !ok || int(size) != expectedChatSize {
		t.Fatalf("%s chat_size = %v; the pinned value sums every entry of its chats directory (%d bytes of files)",
			fixture.Inputs.ChatCharacter, size, expectedChatSize)
	}
	if last, ok := jsNumber(nodeGet(character, "date_last_chat")); !ok || last != fixture.Inputs.FixedMtimeMS {
		t.Fatalf("%s date_last_chat = %v; the pinned value is the newest entry mtime (%v)",
			fixture.Inputs.ChatCharacter, last, fixture.Inputs.FixedMtimeMS)
	}
}
