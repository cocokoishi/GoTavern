package server

// WHERE DOES A CHARACTER'S CHAT LIVE, AND UNDER WHICH NAME?
//
// WHY THIS FILE EXISTS. `Browser differential` run 40438262854 (mode preset, step "Hand GoTavern's own tree back
// to pinned Node (Q21)") asked the product to list its characters and got back a roster naming a card differently
// from the bytes the probe had just staged. Six commits -- 48dadff, 6208083, 176c787, b501279, 3499f03, 12c78b7,
// a5660b6 -- changed THE DRIVER to reconcile the two. The premise b501279 introduced ("the server shows the
// card's own `data.name`") is what those rewrites were built on, and ONE reading of the projection refutes it:
// pinned's V3 path prefers `data.name` and FALLS BACK to the V1 root `name`, and the committed fixture generator
// writes those two fields from DIFFERENT marker tiers, so on card-a.png they are different strings by
// construction.
//
// The tests here are the consequence chain that premise hid. They are written against the PRODUCT's observable
// behaviour, and every comment names the pinned line being reproduced so a reader can check the claim where it is
// decided.
//
// TestPinnedCharacterChatsAreKeyedByTheCardName
//   chunkOrder        `chara` precedes `ccv3`, which is what makes the precedence rule observable at all
//   savedUnderPinned  the product's own /api/chats/save files a chat under `chats/<avatar_url minus .png>/`, so the
//                     location asserted next is the product's, not one this test invented
//   chatsFollowName   /api/characters/all says the character HAS a chat, i.e. it read `chats/<CARD NAME>/` and not
//                     `chats/<FILE NAME>/` (pinned getChats: `const characterName = characters[avatar].name`)
//   chatIdentity      the published `chat` is the file that exists, and `file_id` is that file's stem
//                     (pinned getChatInfo: `path.basename(filePath, path.extname(filePath))`)
//
// THE FILE NAME AND THE CARD NAME ARE DELIBERATELY DIFFERENT -- a card staged as "Q21 Handback Card.png" whose
// `data.name` is "Replay Card Name" is exactly the shape of the reported run, and is why the two names must not
// be assumed equal anywhere a chat identity is derived.

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// TestPinnedCharacterChatsAreKeyedByTheCardName is the consequence gate for the chat-identity defect.
func TestPinnedCharacterChatsAreKeyedByTheCardName(t *testing.T) {
	const (
		fileName   = "Q21 Handback Card"
		cardName   = "Replay Card Name"
		chatStem   = "Q21-chat-2026-10-27"
		chatMarker = "Q21_CHAT_IDENTITY_MARKER"
	)
	staged := replayCardPNG(t, cardName, "")
	if own := replayCardField(t, staged, "ccv3", "data.name"); own != cardName {
		t.Fatalf("staged: the card's own data.name = %q, wanted %q", own, cardName)
	}
	if chara, ccv3 := chunkOffset(t, staged, "chara"), chunkOffset(t, staged, "ccv3"); chara < 0 || ccv3 < 0 || chara > ccv3 {
		t.Fatalf("chunkOrder: chara@%d ccv3@%d; the precedence rule this gate relies on needs chara FIRST", chara, ccv3)
	}

	env := newCharactersOracleEnv(t, "chat-identity-cookie-secret")
	cardPath := filepath.Join(env.Directories["characters"], fileName+".png")
	writeFixtureFile(t, cardPath, staged, 1700000000000)

	// NO ROSTER ROW YET: nothing has written a chat. This is the `chats: false` half of the pinned contract, and
	// asserting it first means a `chats: true` later cannot be a leftover.
	empty := characterRow(t, env, fileName+".png")
	if chats, _ := empty["chats"].(bool); chats {
		t.Fatalf("staged: /api/characters/all already reports chats=%v with no chat written", chats)
	}

	// THE CHAT IS WRITTEN BY THE PRODUCT, through the route a client uses, and under the name a client uses for a
	// character's chat. Its LOCATION is whatever the save route makes it (chats.go:192 joins the parent directory
	// with `avatar_url` minus `.png`), so the next assertion is about the product's own tree rather than a tree
	// this test arranged to be convenient.
	saveBody := `{"avatar_url":"` + fileName + `.png","file_name":"` + chatStem + `","chat":[` +
		`{"user_name":"User","character_name":"` + cardName + `","create_date":"2026-10-27@00h00m00s000ms"},` +
		`{"name":"Unnamed","is_user":true,"mes":"` + chatMarker + `","send_date":"2026-10-27@00h00m01s000ms"}]}`
	write := env.serve(t, http.MethodPost, "/api/chats/save", "application/json", saveBody)
	if write.Code != http.StatusOK {
		t.Fatalf("save: POST /api/chats/save = %d: %s", write.Code, write.Body.String())
	}
	onDisk := filepath.Join(env.Directories["chats"], fileName, chatStem+".jsonl")
	if _, err := os.Stat(onDisk); err != nil {
		t.Fatalf("savedUnderPinned: the save route did not write chats/%s/%s.jsonl (%v); the location it chose is what "+
			"the roster must agree with", fileName, chatStem, err)
	}

	// THE ROSTER. `chats` is the flag the pinned frontend branches on (public/script.js openCharacter), so a false
	// here means the conversation the user just saved is invisible to the client that saved it.
	roster := characterRow(t, env, fileName+".png")
	if got, _ := roster["name"].(string); got != cardName {
		t.Fatalf("the roster's name for %s.png = %q, wanted the card's own name %q -- the premise the six driver "+
			"commits assumed; if this row moves, the projection and not the chat identity is what changed",
			fileName, got, cardName)
	}
	if chats, isBool := roster["chats"].(bool); !isBool || !chats {
		t.Fatalf("chatsFollowName: /api/characters/all answered chats=%v for a character whose chat this product saved "+
			"at chats/%s/%s.jsonl; pinned getChats lists chats/<characters[avatar].name>, i.e. the CARD's name %q, so a "+
			"chat keyed by the FILE name %q is invisible and the frontend never resumes the conversation",
			roster["chats"], fileName, chatStem, cardName, fileName)
	}

	// THE IDENTITY. `chat` names the file a client appends to, and it must be the file the save route wrote. The
	// roster does not carry a per-character `file_id` (`file_id` is a /api/characters/chats item field,
	// characters_read.go:213); the file's stem is therefore asserted where pinned defines it, in that route.
	published, _ := roster["chat"].(string)
	if want := chatStem + ".jsonl"; published != want {
		t.Fatalf("chatIdentity: /api/characters/all published chat=%q, wanted %q (the file the save route wrote)", published, want)
	}
	listing := env.serve(t, http.MethodPost, "/api/characters/chats", "application/json",
		`{"avatar_url":"`+fileName+`.png","simple":true}`)
	if listing.Code != http.StatusOK {
		t.Fatalf("/api/characters/chats = %d: %s", listing.Code, listing.Body.String())
	}
	var items []map[string]any
	if err := json.Unmarshal(listing.Body.Bytes(), &items); err != nil {
		t.Fatalf("/api/characters/chats did not answer an array: %s", listing.Body.String())
	}
	foundIdentity := false
	for _, item := range items {
		if item["file_name"] == chatStem+".jsonl" && item["file_id"] == chatStem {
			foundIdentity = true
		}
	}
	if !foundIdentity {
		t.Fatalf("chatIdentity: /api/characters/chats answered %v for %s.png; wanted an item {file_name:%q, file_id:%q} "+
			"(pinned getChatInfo: file_id is the chat FILE's stem)",
			items, fileName, chatStem+".jsonl", chatStem)
	}
}

// characterRow returns the roster row for one avatar, failing with the whole roster when it is absent.
func characterRow(t *testing.T, env *charactersOracleEnv, avatar string) map[string]any {
	t.Helper()
	response := env.serve(t, http.MethodPost, "/api/characters/all", "application/json", "{}")
	if response.Code != http.StatusOK {
		t.Fatalf("/api/characters/all = %d: %s", response.Code, response.Body.String())
	}
	var rows []map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &rows); err != nil {
		t.Fatalf("/api/characters/all did not answer an array: %s", response.Body.String())
	}
	listed := make([]string, 0, len(rows))
	for _, row := range rows {
		name, _ := row["avatar"].(string)
		listed = append(listed, name)
		if name == avatar {
			return row
		}
	}
	t.Fatalf("/api/characters/all did not list %s; roster avatars %v", avatar, listed)
	return nil
}

// chunkOffset reports where a tEXt keyword's chunk starts, -1 when it is absent. The bytes are read the way a PNG
// reader reads them (length, type, data), so the order asserted is the order on disk.
func chunkOffset(t *testing.T, image []byte, keyword string) int {
	t.Helper()
	offset := 8
	for offset+8 <= len(image) {
		length := int(readUint32BE(image[offset:]))
		kind := string(image[offset+4 : offset+8])
		if kind == "tEXt" && offset+8+length <= len(image) {
			chunk := image[offset+8 : offset+8+length]
			for index, code := range chunk {
				if code != 0 {
					continue
				}
				if string(chunk[:index]) == keyword {
					return offset
				}
				break
			}
		}
		if kind == "IEND" {
			break
		}
		offset += 12 + length
	}
	return -1
}

func readUint32BE(data []byte) uint32 {
	return uint32(data[0])<<24 | uint32(data[1])<<16 | uint32(data[2])<<8 | uint32(data[3])
}
