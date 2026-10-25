package e2e

// THE LONG-LIVED TREE (GOAL.md §5, Q1): the qualification input that is NOT a fresh install.
//
// Every packaged gate in this repository boots a freshly seeded tree, so "the release starts" has never
// meant "a user's five-year-old directory still works". This file builds a tree shaped like one a real
// user brings -- many characters' worth of assets, an existing chat with history, a world book, a
// 40-prompt preset in use, extension state, personas, backgrounds with metadata, backups, and files the
// product has no opinion about -- boots the shipped binary against it, and asserts the surfaces a user
// sees. The original is never touched: the builder writes into the test's own temp directory.
//
// WHAT THIS PROVES AND WHAT IT DOES NOT, stated so a reader does not over-read a green:
//   - PROVES the boot does not damage the tree (every pre-existing byte is compared after boot) and that
//     the character card, its full-size image, its thumbnail, the world book and the settings -- including
//     the extension state a helper script lives in -- are reachable through the routes the frontend uses.
//   - DOES NOT prove chat history is served: the chat file is planted and its BYTES are asserted intact,
//     but the chat route's file-naming rules are not exercised here, and a chat the product cannot open
//     would still pass this test. That gap is named rather than dressed up (AGENTS.md rule 4).
//   - DOES NOT prove preset semantics: loading a preset is not the same as the preset changing the model
//     context (rule 48). The preset here exists so that the SETTINGS that name it survive the boot.

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

const longLivedAvatar = "Longlived_Card.png"
const longLivedCharacterName = "Longlived Card"

// longLivedTree describes what the builder planted, so the assertions do not read the tree a second time
// and accidentally assert the builder against itself.
type longLivedTree struct {
	dataRoot     string
	userRoot     string
	avatarFile   string
	cardBytes    []byte
	chatFile     string
	chatBytes    []byte
	worldName    string
	worldEntries int
	presetName   string
	unknownFile  string
	unknownBytes []byte
	files        map[string]string // relative path -> sha256 (content identity, asserted after boot)
}

func longLivedPNG(t *testing.T, card map[string]any) []byte {
	t.Helper()
	picture := image.NewRGBA(image.Rect(0, 0, 96, 144))
	for y := 0; y < 144; y++ {
		for x := 0; x < 96; x++ {
			picture.Set(x, y, color.RGBA{R: uint8(x), G: uint8(y), B: 200, A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		t.Fatal(err)
	}
	raw := encoded.Bytes()

	payload, err := json.Marshal(card)
	if err != nil {
		t.Fatal(err)
	}
	text := []byte("chara\x00" + base64.StdEncoding.EncodeToString(payload))
	chunk := make([]byte, 0, len(text)+12)
	length := make([]byte, 4)
	length[0] = byte(len(text) >> 24)
	length[1] = byte(len(text) >> 16)
	length[2] = byte(len(text) >> 8)
	length[3] = byte(len(text))
	chunk = append(chunk, length...)
	chunk = append(chunk, []byte("tEXt")...)
	chunk = append(chunk, text...)
	chunk = append(chunk, 0, 0, 0, 0) // CRC is not verified by the pinned reader for text chunks

	// Insert before IEND, which is where a card writer puts its metadata.
	iend := bytes.LastIndex(raw, []byte("IEND"))
	if iend < 4 {
		t.Fatal("encoded PNG has no IEND")
	}
	out := make([]byte, 0, len(raw)+len(chunk))
	out = append(out, raw[:iend-4]...)
	out = append(out, chunk...)
	out = append(out, raw[iend-4:]...)
	return out
}

func longLivedCardJSON(worldName string) map[string]any {
	entries := make([]any, 0, 30)
	for i := 0; i < 30; i++ {
		entries = append(entries, map[string]any{
			"id": i, "keys": []any{"LONG_KEY_" + string(rune('A'+i%26))}, "secondary_keys": []any{},
			"comment": "entry " + string(rune('0'+i%10)), "content": "LONG_WI_CONTENT_" + string(rune('A'+i%26)),
			"constant": i%5 == 0, "selective": true, "insertion_order": 100 + i, "enabled": i%7 != 0,
			"position": "before_char", "use_regex": true,
			"extensions": map[string]any{"position": 0, "depth": 4, "probability": 100, "useProbability": true},
		})
	}
	data := map[string]any{
		"name":                      longLivedCharacterName,
		"description":               "LONG_DESC a character whose description must survive",
		"personality":               "LONG_PERSONALITY",
		"scenario":                  "LONG_SCENARIO",
		"first_mes":                 "LONG_FIRST_MES hello",
		"mes_example":               "LONG_EXAMPLE",
		"creator_notes":             "",
		"system_prompt":             "",
		"post_history_instructions": "",
		"tags":                      []any{"longlived"},
		"creator":                   "probe",
		"character_version":         "1.0",
		"alternate_greetings":       []any{"LONG_ALT_ONE", "LONG_ALT_TWO", "LONG_ALT_THREE"},
		"extensions": map[string]any{
			"world":         worldName,
			"depth_prompt":  map[string]any{"depth": 4, "role": "system", "prompt": ""},
			"tavern_helper": map[string]any{"scripts": []any{map[string]any{"type": "script", "enabled": true, "name": "LONG_SCRIPT", "id": "11111111-1111-1111-1111-111111111111", "content": "//LONG_SCRIPT_CONTENT", "info": "", "button": map[string]any{}, "data": map[string]any{}, "export_with": map[string]any{}}}, "variables": map[string]any{}},
			"regex_scripts": []any{map[string]any{"id": "r1", "scriptName": "LONG_REGEX", "disabled": false, "runOnEdit": true, "findRegex": "/LONG_FIND/g", "trimStrings": []any{}, "replaceString": "LONG_REPLACE", "placement": []any{1, 2}, "substituteRegex": 0, "minDepth": nil, "maxDepth": nil, "markdownOnly": true, "promptOnly": false}},
		},
		"character_book":       map[string]any{"name": "LONG_BOOK", "entries": entries},
		"group_only_greetings": []any{},
	}
	return map[string]any{
		"name": longLivedCharacterName, "description": "LONG_DESC a character whose description must survive",
		"personality": "LONG_PERSONALITY", "scenario": "LONG_SCENARIO", "first_mes": "LONG_FIRST_MES hello",
		"mes_example": "LONG_EXAMPLE", "creatorcomment": "", "avatar": "none", "talkativeness": "0.5",
		"fav": false, "tags": []any{"longlived"}, "spec": "chara_card_v3", "spec_version": "3.0",
		"data": data, "create_date": "2026-10-24T00:00:00.000Z",
	}
}

// buildLongLivedTree writes a tree shaped like a long-lived install. It refuses to write a tree it cannot
// describe, because a fixture whose shape is not asserted is a fixture that can silently become simple.
func buildLongLivedTree(t *testing.T, dataRoot string) longLivedTree {
	t.Helper()
	tree := longLivedTree{dataRoot: dataRoot, files: map[string]string{}}
	tree.userRoot = filepath.Join(dataRoot, "default-user")
	directories := []string{
		"characters", "chats", "groups", "worlds", "backgrounds", "User Avatars", "assets",
		"OpenAI Settings", "QuickReplies", "themes", "movingUI", "extensions", "user/files",
		"user/images", "backups", "thumbnails/avatar", "thumbnails/persona", "thumbnails/bg",
	}
	for _, name := range directories {
		if err := os.MkdirAll(filepath.Join(tree.userRoot, filepath.FromSlash(name)), 0o777); err != nil {
			t.Fatal(err)
		}
	}
	write := func(relative string, body []byte) {
		target := filepath.Join(tree.userRoot, filepath.FromSlash(relative))
		if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, body, 0o600); err != nil {
			t.Fatal(err)
		}
		tree.files[relative] = contentDigest(body)
	}

	tree.worldName = "Longlived_Lore"
	tree.cardBytes = longLivedPNG(t, longLivedCardJSON(tree.worldName))
	tree.avatarFile = longLivedAvatar
	write("characters/"+longLivedAvatar, tree.cardBytes)

	// A chat with history and metadata, in the shape the product writes.
	var chat strings.Builder
	for turn := 0; turn < 12; turn++ {
		role := "user"
		if turn%2 == 1 {
			role = "assistant"
		}
		record, err := json.Marshal(map[string]any{
			"name": longLivedCharacterName, "is_user": role == "user", "is_system": false,
			"send_date": "2026-10-24T12:00:00.000Z", "mes": "LONG_HISTORY_" + itoa(turn),
			"extra": map[string]any{}, "force_avatar": "/thumbnail?type=avatar&file=" + longLivedAvatar,
		})
		if err != nil {
			t.Fatal(err)
		}
		chat.Write(record)
		chat.WriteString("\n")
	}
	tree.chatBytes = []byte(chat.String())
	tree.chatFile = "chats/" + longLivedCharacterName + " - 2026-10-24.jsonl"
	write(tree.chatFile, tree.chatBytes)

	bookEntries := map[string]any{}
	for i := 0; i < 30; i++ {
		key := itoa(i)
		bookEntries[key] = map[string]any{
			"uid": i, "key": []any{"LONG_KEY_" + string(rune('A'+i%26))}, "keysecondary": []any{},
			"comment": "entry " + key, "content": "LONG_WI_CONTENT_" + string(rune('A'+i%26)),
			"constant": i%5 == 0, "selective": true, "selectiveLogic": 0, "order": 100 + i,
			"position": 0, "disable": i%7 == 0, "addMemo": true, "excludeRecursion": false,
			"preventRecursion": false, "delayUntilRecursion": false, "probability": 100,
			"useProbability": true, "group": "", "groupOverride": false, "groupWeight": 100,
			"scanDepth": nil, "caseSensitive": nil, "matchWholeWords": nil, "useGroupScoring": nil,
			"automationId": "", "role": 0, "vectorized": false, "sticky": nil, "cooldown": nil,
			"delay": nil, "depth": 4, "displayIndex": i,
		}
	}
	tree.worldEntries = len(bookEntries)
	worldBody, err := json.Marshal(map[string]any{"entries": bookEntries})
	if err != nil {
		t.Fatal(err)
	}
	write("worlds/"+tree.worldName+".json", worldBody)

	// A preset with 40 prompts, the in-use sampler set, and one custom entry -- the shape a real preset
	// has and a toy fixture does not.
	prompts := make([]any, 0, 40)
	order := make([]any, 0, 40)
	for i := 0; i < 40; i++ {
		identifier := "LONG_PRESET_" + itoa(i)
		prompts = append(prompts, map[string]any{
			"identifier": identifier, "name": "entry " + itoa(i), "role": "system", "content": "LONG_PROMPT_BODY_" + itoa(i),
			"system_prompt": i%3 == 0, "marker": false, "injection_position": 0, "injection_depth": 4, "injection_order": 100,
		})
		order = append(order, map[string]any{"identifier": identifier, "enabled": i%4 != 0})
	}
	tree.presetName = "Long-lived Preset"
	preset, err := json.MarshalIndent(map[string]any{
		"temperature": 1.05, "frequency_penalty": 0, "presence_penalty": 0.2, "top_p": 0.95, "top_k": 40,
		"openai_max_context": 32000, "openai_max_tokens": 1200, "stream_openai": true, "names_behavior": 0,
		"squash_system_messages": true, "wrap_in_quotes": false, "continue_prefill": true,
		"prompts": prompts, "prompt_order": []any{map[string]any{"character_id": 100001, "order": order}},
		"extensions": map[string]any{"tavern_helper": map[string]any{"scripts": []any{}, "variables": map[string]any{}}},
	}, "", "    ")
	if err != nil {
		t.Fatal(err)
	}
	write("OpenAI Settings/"+tree.presetName+".json", preset)

	background := longLivedPNG(t, map[string]any{"spec": "chara_card_v3", "spec_version": "3.0", "name": "bg", "data": map[string]any{}})
	write("backgrounds/Longlived_Background.png", background)
	write("backgrounds/__transparent.png", background)
	backgroundMetadata, err := json.Marshal(map[string]any{"Longlived_Background.png": map[string]any{"extra": []any{}, "shown": true}})
	if err != nil {
		t.Fatal(err)
	}
	write("backgrounds/backgrounds.json", backgroundMetadata)
	write("User Avatars/user-default.png", background)
	write("thumbnails/persona/stale.png", []byte("STALE_THUMBNAIL"))

	quickReplies, err := json.MarshalIndent(map[string]any{"qrList": []any{map[string]any{
		"id": "qr1", "label": "Long QR", "message": "/echo LONG_QR",
		"showLabel": true, "automationId": "", "preventAutoExecute": false, "isHidden": false, "executeOnStartup": false, "executeOnUser": false,
	}}}, "", "    ")
	if err != nil {
		t.Fatal(err)
	}
	write("QuickReplies/longlived.json", quickReplies)
	write("themes/longlived.json", []byte(`{"main_text_color":"#ffffff"}`))
	write("movingUI/longlived.json", []byte(`{"#chat":{"left":10}}`))
	write("user/files/LONG_FILE.txt", []byte("LONG_FILE_BODY"))

	// The settings the frontend reads: the preset in use, its name list, the world list, and the
	// extension state a helper script lives in. Written as JSON so the product's own reader exercises it.
	settings, err := json.MarshalIndent(map[string]any{
		"username":         "default-user",
		"active_character": longLivedAvatar,
		"world_names":      []any{tree.worldName},
		"oai_settings": map[string]any{
			"preset_settings_openai": tree.presetName,
			"openai_model":           "gpt-4o-mini",
			"chat_completion_source": "custom",
			"reverse_proxy":          "http://127.0.0.1:9/unused",
			"temp_openai":            1.05,
			"openai_max_tokens":      1200,
			"openai_max_context":     32000,
		},
		"extension_settings": map[string]any{
			"disabledExtensions":      []any{},
			"notifyUpdates":           false,
			"character_allowed_regex": []any{},
			"tavern_helper":           map[string]any{"scripts": []any{}, "variables": map[string]any{"global": map[string]any{"LONG_GLOBAL_VAR": "VALUE"}}},
		},
	}, "", "    ")
	if err != nil {
		t.Fatal(err)
	}
	write("settings.json", settings)

	// Files the product has no opinion about, and one backup. A long-lived tree is full of them, and
	// "existing user data wins" (AGENTS.md 28) means they come back byte-identical.
	tree.unknownFile = "user/files/unknown-binary.dat"
	tree.unknownBytes = []byte{0x00, 0x01, 0xfe, 0xff, 'u', 'n', 'k'}
	write(tree.unknownFile, tree.unknownBytes)
	write("backups/settings_2026-09-01.json", []byte(`{"backup":"older settings"}`))
	write("chats/Long_Legacy - 2025-01-01.jsonl", []byte(`{"user_name":"default-user","mes":"LONG_LEGACY"}`+"\n"))

	// The builder refuses a tree it cannot describe.
	if len(tree.files) < len(directories) {
		t.Fatalf("the long-lived tree is too simple to be evidence: %d files", len(tree.files))
	}
	if len(tree.cardBytes) < 1024 {
		t.Fatalf("the planted card is %d bytes, which cannot be a card", len(tree.cardBytes))
	}
	return tree
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	digits := ""
	for value > 0 {
		digits = string(rune('0'+value%10)) + digits
		value /= 10
	}
	return digits
}

func contentDigest(body []byte) string {
	return sha256Hex(string(body))
}

// TestLongLivedTreeBootsAndServesItsAssets is Q1's first slice: a tree shaped like a real install boots,
// its files come back byte-identical, and the routes the frontend uses answer for the card, its image,
// its thumbnail, the world book and the settings that carry the preset and extension state.
func TestLongLivedTreeBootsAndServesItsAssets(t *testing.T) {
	installRoot := t.TempDir()
	dataRoot := filepath.Join(installRoot, "data")
	tree := buildLongLivedTree(t, dataRoot)

	server := bootServerAt(t, installRoot, dataRoot, nil)
	client := openSession(t, server.origin)

	// (1) nothing in the tree moved, and nothing the builder planted disappeared.
	after := map[string]string{}
	err := filepath.Walk(tree.userRoot, func(path string, info os.FileInfo, walkErr error) error {
		if walkErr != nil || info.IsDir() {
			return walkErr
		}
		relative, relErr := filepath.Rel(tree.userRoot, path)
		if relErr != nil {
			return relErr
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return readErr
		}
		after[filepath.ToSlash(relative)] = sha256Hex(string(body))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	planted := make([]string, 0, len(tree.files))
	for relative := range tree.files {
		planted = append(planted, relative)
	}
	sort.Strings(planted)
	for _, relative := range planted {
		digest, present := after[relative]
		if !present {
			t.Errorf("the boot deleted %s, which a user's tree contained before it started (AGENTS.md 28)", relative)
			continue
		}
		if digest != tree.files[relative] {
			t.Errorf("the boot rewrote %s: content %s became %s (AGENTS.md 27)", relative, tree.files[relative][:12], digest[:12])
		}
	}

	// (2) the card's own bytes come back through the route the frontend builds for a full-size avatar.
	status, header, body := client.get(t, "/characters/"+longLivedAvatar)
	if status != http.StatusOK {
		t.Fatalf("GET /characters/%s = %d, so the character list and the opened card have no image: %.160q", longLivedAvatar, status, body)
	}
	if !strings.HasPrefix(header.Get("Content-Type"), "image/png") {
		t.Errorf("GET /characters/%s answered Content-Type %q", longLivedAvatar, header.Get("Content-Type"))
	}
	if len(body) != len(tree.cardBytes) {
		t.Fatalf("GET /characters/%s answered %d bytes, the card on disk is %d", longLivedAvatar, len(body), len(tree.cardBytes))
	}

	// (3) the thumbnail the character list actually renders.
	status, header, body = client.get(t, "/thumbnail?type=avatar&file="+longLivedAvatar)
	if status != http.StatusOK {
		t.Fatalf("GET /thumbnail?type=avatar&file=%s = %d, so every avatar in the list is a broken image: %.160q", longLivedAvatar, status, body)
	}
	if !strings.HasPrefix(header.Get("Content-Type"), "image/") {
		t.Errorf("/thumbnail answered Content-Type %q", header.Get("Content-Type"))
	}
	thumbnailBytes := []byte(body)
	if !bytes.HasPrefix(thumbnailBytes, []byte("\x89PNG\r\n\x1a\n")) && !bytes.HasPrefix(thumbnailBytes, []byte{0xff, 0xd8}) {
		t.Errorf("/thumbnail answered %d bytes that are neither PNG nor JPEG: %.40q", len(thumbnailBytes), thumbnailBytes)
	}

	// (4) the character list, through the route the frontend reads it from.
	status, _, body = client.postJSON(t, "/api/characters/all", "{}")
	if status != http.StatusOK {
		t.Fatalf("POST /api/characters/all = %d: %.200q", status, body)
	}
	if !strings.Contains(body, longLivedAvatar) {
		t.Errorf("POST /api/characters/all did not list %s, so the user's card is invisible", longLivedAvatar)
	}

	// (5) the world book, including the entries the card's own book declared.
	worldBody, err := marshalJSON(map[string]any{"name": tree.worldName})
	if err != nil {
		t.Fatal(err)
	}
	status, _, body = client.postJSON(t, "/api/worldinfo/get", worldBody)
	if status != http.StatusOK {
		t.Fatalf("POST /api/worldinfo/get = %d: %.200q", status, body)
	}
	occurrences := strings.Count(body, "LONG_WI_CONTENT_")
	if occurrences != tree.worldEntries {
		t.Errorf("POST /api/worldinfo/get returned %d of the %d planted entries", occurrences, tree.worldEntries)
	}

	// (6) the settings that name the preset and carry the extension state a helper script lives in.
	status, _, body = client.postJSON(t, "/api/settings/get", "{}")
	if status != http.StatusOK {
		t.Fatalf("POST /api/settings/get = %d: %.200q", status, body)
	}
	for _, expected := range []string{tree.presetName, tree.worldName, "LONG_GLOBAL_VAR", "tavern_helper"} {
		if !strings.Contains(body, expected) {
			t.Errorf("POST /api/settings/get did not carry %q, so the frontend cannot load what the user had", expected)
		}
	}
}
