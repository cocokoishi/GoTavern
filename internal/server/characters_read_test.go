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
	env := newCharactersOracleEnv(t, fixture)
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

	// The shallow projection runs with performance.lazyLoadCharacters enabled.
	shallowEnv := newCharactersOracleEnvWithConfig(t, fixture, "performance:\n  lazyLoadCharacters: true\n")
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
