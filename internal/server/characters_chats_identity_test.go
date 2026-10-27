package server

/*
WHERE DOES A CHARACTER'S CHAT LIVE, AND UNDER WHICH NAME?

WHY THIS FILE EXISTS. `Browser differential` run 40438262854 (mode preset, step "Hand GoTavern's own tree back
to pinned Node (Q21)") asked the product to list its characters and got back a roster naming a card differently
from the bytes the probe had just staged. Six commits -- 48dadff, 6208083, 176c787, b501279, 3499f03, 12c78b7,
a5660b6 -- changed THE DRIVER to reconcile the two. The premise b501279 introduced ("the server shows the card's
own `data.name`") is what those rewrites were built on, and ONE reading of the projection refutes it: pinned's V3
path prefers `data.name` and FALLS BACK to the V1 root `name`, and the committed fixture generator writes those two
fields from DIFFERENT marker tiers, so on card-a.png they are different strings by construction.

The tests here are the consequence chain that premise hid. They are written against the PRODUCT's observable
behaviour, and every comment names the pinned line being reproduced so a reader can check the claim where it is
decided.

TestPinnedCharacterChatsAreKeyedByTheCardName

	chunkOrder       `chara` precedes `ccv3`, which is what makes the precedence rule observable at all
	savedUnderPinned the product's own /api/chats/save files a chat under `chats/<avatar_url minus .png>/`, so the
	                 location asserted next is the product's, not one this test invented
	chatIdentity     the published `chat` is the file that exists, and `file_id` is that file's stem
	                 (pinned getChatInfo: `path.basename(filePath, path.extname(filePath))`)

THE FILE NAME AND THE CARD NAME ARE DELIBERATELY DIFFERENT -- a card staged as "Q21 Handback Card.png" whose
`data.name` is "Replay Card Name" is exactly the shape of the reported run, and is why the two names must not be
assumed equal anywhere a chat identity is derived.
*/

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

// TestPinnedCharacterChatsAreKeyedByTheCardName is the consequence gate for the chat-identity question.
//
// RETRACTION, KEPT VERBATIM BECAUSE A WITHDRAWN CLAIM IS EVIDENCE: this test was written to prove that "the
// character's chat identity is derived from the FILE name while pinned derives it from the CARD's name"
// (`characters_card.go:307`). That premise was WRONG. Pinned keys the chats directory by the FILE name in both places
// that matter -- `src/endpoints/characters.js:419`:
//
//	const chatsDirectory = path.join(directories.chats, item.replace(".png", ""))   // `item` is a readdir entry
//
// and `:1503-1504` for `/chats`, which strips `.png` from the request avatar exactly the same way.
// what this port does, so the KEY is correct, and the original failure message ("pinned getChats lists
// chats/<characters[avatar].name>") described a line that does not exist at 06bde939. The red it produced (Lane CI
// 40444357552 and 40448026086) was a red for a claim this lane no longer holds.
//
// THE OBSERVATION IS KEPT, because it is still true and still worth a gate: the roster row carries NO `chats` member,
// and that is CORRECT -- pinned never assigns `chats` either (no assignment in src/endpoints/characters.js; the
// frontend derives it from `chat_size` at public/script.js:567-574, so a character with chats resumes normally under
// either server). Asserting the member's ABSENCE on both subjects is what keeps a future "helpful" addition from
// silently diverging, which is why the observation stays and only the premise changes.
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
	if chara, ccv3 := chunkOffset(t, staged, "chara"), chunkOffset(t, staged, "ccv3"); chara < 0 || ccv3 < 0 ||
		chara > ccv3 {
		t.Fatalf("chunkOrder: chara@%d ccv3@%d; the precedence rule this gate relies on needs chara FIRST", chara, ccv3)
	}

	env := newCharactersOracleEnv(t, "chat-identity-cookie-secret")
	cardPath := filepath.Join(env.Directories["characters"], fileName+".png")
	writeFixtureFile(t, cardPath, staged, 1700000000000)

	// THE ROW CONTRACT, BEFORE ANY CHAT EXISTS, TAKEN FROM PINNED: `chat` is the readFromV2 default string
	// (:554), `chat_size` a number (:422), and `chats` appears in NO row because pinned never assigns it.
	empty := characterRow(t, env, fileName+".png")
	if _, kind := typedMemberKind(t, empty, "chats"); kind != "absent" {
		t.Fatalf("staged/noChats: the roster row carries `chats` (%s); pinned assigns `chats` nowhere in "+
			"src/endpoints/characters.js and the frontend derives it from chat_size (public/script.js:567-574)", kind)
	}
	if _, kind := typedMemberKind(t, empty, "chat_size"); kind != "number" {
		t.Fatalf("staged/noChats: chat_size is %s, wanted a number (assigned unconditionally at :422)", kind)
	}
	if text, kind := typedMemberKind(t, empty, "chat"); kind != "string" || text == "" {
		t.Fatalf("staged/noChats: chat is %s, wanted the readFromV2 default string", kind)
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

	// THE ROSTER, AFTER THE CHAT EXISTS. The member set is the SAME as before, which is the point: pinned's row does
	// not gain a `chats` flag when a chat appears -- the frontend recomputes it from `chat_size`
	// (public/script.js:567-574), so a browser with chats resumes under either server. The `chats` assertion below is
	// deliberately an ABSENCE assertion; its failure message states the retraction it belongs to.
	roster := characterRow(t, env, fileName+".png")
	if got, _ := roster["name"].(string); got != cardName {
		t.Fatalf("the roster's name for %s.png = %q, wanted the card's own name %q -- the premise the six driver "+
			"commits assumed; if this row moves, the projection and not the chat identity is what changed",
			fileName, got, cardName)
	}
	if _, kind := typedMemberKind(t, roster, "chats"); kind != "absent" {
		t.Fatalf("roster/chats: the row carries `chats`=%s after a chat exists. RETRACTION ON RECORD: this test used to "+
			"fail here demanding chats=true on the theory that pinned keys chats by the CARD's name; pinned keys them by "+
			"the FILE name (:419, :1503-1504) and never assigns `chats` at all, so the correct contract is that the "+
			"member is ABSENT on both subjects and the frontend derives it from chat_size (public/script.js:567-574). "+
			"An emitted `chats` is now the divergence.", kind)
	}
	if _, kind := typedMemberKind(t, roster, "chat_size"); kind != "number" {
		t.Fatalf("roster/chat_size: %s, wanted a number (calculateChatSize, :342-358)", kind)
	}

	// THE IDENTITY. `chat` names the file a client appends to, and it must be the file the save route wrote. The
	// roster does not carry a per-character `file_id` (`file_id` is a /api/characters/chats item field,
	// characters_read.go:213); the file's stem is therefore asserted where pinned defines it, in that route.
	published, _ := roster["chat"].(string)
	if want := chatStem + ".jsonl"; published != want {
		t.Fatalf("chatIdentity: /api/characters/all published chat=%q, wanted %q (the file the save route wrote)",
			published, want)
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

// typedMemberKind applies memberKind to a decoded row. `characterRow` decodes into map[string]any (so a caller can
// read `name` without a cast) while `memberKind` works on the RAW JSON members a browser receives -- the two shapes
// are both needed, and this adapter is the single place they meet once rather than at five call sites.
func typedMemberKind(t *testing.T, row map[string]any, name string) (string, string) {
	t.Helper()
	raw := make(map[string]json.RawMessage, len(row))
	for key, value := range row {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatalf("encode roster member %q: %v", key, err)
		}
		raw[key] = encoded
	}
	return memberKind(raw, name)
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
