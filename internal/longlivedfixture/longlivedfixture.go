// Package longlivedfixture builds the COMPLEX long-lived SillyTavern instance that the
// drop-in qualification harness drives (docs/longlived-complex-fixture.md).
//
// It is a generator, not a committed tree: every file is produced deterministically from one seed, so the
// fixture is pinned by the generator's own digest rather than by a megabyte of copy-pasted JSON. What it
// builds is deliberately much larger than tests/e2e/longlived_test.go's single-character tree: dozens of
// cards (v2 and v3 PNG metadata), year-spanning chats with swipes and branches, recursive world books,
// text-completion and chat-completion presets, group chats, themes, quick replies, personas, backgrounds,
// extension state, legacy public/characters data for migration, and files the product has no opinion
// about. None of it is real user data (AGENTS.md rule 56): every name, line and blob is synthetic.
package longlivedfixture

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash/crc32"
	"image"
	"image/color"
	"image/png"
	"math/rand"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Spec sizes the fixture. DefaultSpec is the "very complex" instance; smaller sizes exist so a quick
// local run and a CI smoke can use the same code path without minutes of disk churn.
type Spec struct {
	Seed        int64
	Characters  int
	Worlds      int
	BigWorld    int // entries in the largest world book
	ChatBase    int // messages in character 0's main chat; later characters scale up
	ChatStep    int
	Presets     int
	Themes      int
	QuickReply  int
	Personas    int
	Backgrounds int
	Groups      int
}

func DefaultSpec() Spec {
	return Spec{
		Seed: 20261104, Characters: 32, Worlds: 8, BigWorld: 400,
		ChatBase: 240, ChatStep: 60, Presets: 4, Themes: 3,
		QuickReply: 4, Personas: 4, Backgrounds: 5, Groups: 3,
	}
}

// Manifest records what Build planted, so the harness asserts against the BUILDER's declaration rather
// than re-reading the tree and accidentally agreeing with itself.
type Manifest struct {
	DataRoot     string            `json:"dataRoot"`
	Seed         int64             `json:"seed"`
	Characters   []Character       `json:"characters"`
	Chats        []Chat            `json:"chats"`
	Groups       []Group           `json:"groups"`
	Worlds       []World           `json:"worlds"`
	Presets      []string          `json:"presets"`
	TextPresets  []string          `json:"textPresets"`
	Themes       []string          `json:"themes"`
	QuickReplies []string          `json:"quickReplies"`
	Personas     []string          `json:"personas"`
	Backgrounds  []string          `json:"backgrounds"`
	UnknownFiles []string          `json:"unknownFiles"`
	LegacyAssets []string          `json:"legacyAssets"`
	Files        map[string]string `json:"files"` // tree-relative path -> sha256
}

type Character struct {
	Avatar     string `json:"avatar"`
	Name       string `json:"name"`
	Spec       string `json:"spec"` // chara_card_v2 / chara_card_v3
	AltGreets  int    `json:"alternateGreetings"`
	CardBook   int    `json:"embeddedBookEntries"`
	HasSprites bool   `json:"hasSprites"`
}

type Chat struct {
	Path      string `json:"path"` // tree-relative
	Character string `json:"character"`
	Messages  int    `json:"messages"`
	Swipes    int    `json:"swipes"`
	BranchOf  string `json:"branchOf,omitempty"`
}

type Group struct {
	Name    string   `json:"name"`
	Members []string `json:"members"`
	Chat    string   `json:"chat"`
}

type World struct {
	File    string `json:"file"`
	Entries int    `json:"entries"`
	Regex   int    `json:"regexKeys"`
}

// Build writes the whole instance under root (root is the install root: config.yaml + default-user live
// there). It refuses a non-empty root so a mistake cannot overwrite something.
func Build(root string, spec Spec) (*Manifest, error) {
	if spec.Characters < 2 || spec.Worlds < 1 {
		return nil, fmt.Errorf("spec too small: %+v", spec)
	}
	if entries, err := os.ReadDir(root); err == nil && len(entries) > 0 {
		return nil, fmt.Errorf("refusing to build into a non-empty root %q", root)
	}
	g := &generator{spec: spec, treeRoot: root, rand: rand.New(rand.NewSource(spec.Seed)), manifest: &Manifest{
		DataRoot: root, Seed: spec.Seed, Files: map[string]string{},
	}}
	user := filepath.Join(root, "default-user")
	g.userRoot = user
	for _, name := range []string{
		"characters", "chats", "groups", "worlds", "backgrounds", "User Avatars", "assets",
		"OpenAI Settings", "TextGen Settings", "QuickReplies", "themes", "movingUI", "extensions",
		"user/files", "user/images", "backups", "thumbnails/avatar", "thumbnails/persona", "thumbnails/bg",
		"stats", "vectors", "regex", "instruct",
	} {
		if err := os.MkdirAll(filepath.Join(user, filepath.FromSlash(name)), 0o777); err != nil {
			return nil, err
		}
	}
	if err := g.buildCharacters(user); err != nil {
		return nil, err
	}
	if err := g.buildWorlds(user); err != nil {
		return nil, err
	}
	if err := g.buildPresets(user); err != nil {
		return nil, err
	}
	if err := g.buildChats(user); err != nil {
		return nil, err
	}
	if err := g.buildGroups(user); err != nil {
		return nil, err
	}
	if err := g.buildAssets(user); err != nil {
		return nil, err
	}
	if err := g.buildSettings(user); err != nil {
		return nil, err
	}
	if err := g.buildUnknownAndLegacyData(root, user); err != nil {
		return nil, err
	}
	if err := g.writeConfig(root); err != nil {
		return nil, err
	}
	return g.manifest, nil
}

type generator struct {
	spec     Spec
	treeRoot string
	userRoot string
	rand     *rand.Rand
	manifest *Manifest
}

var nameFragments = []string{
	"Seraphina", "Kael", "Nyx", "Aurelius", "Mirelle", "Tobias", "Isolde", "Corvus",
	"Elowen", "Drossel", "月影", "Liora", "Vesper", "Anouk", "Caspian", "Rin",
	"Zephyrine", "Oriel", "Halcyon", "Sable", "Aster", "Bramble", "Quill", "Wren",
}

var avatarSuffixes = []string{"", " v2", " (old)", " 🌙", " 改", " [backup]", "•alt"}

func (g *generator) write(root, rel string, body []byte) error {
	target := filepath.Join(root, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(target), 0o777); err != nil {
		return err
	}
	if err := os.WriteFile(target, body, 0o600); err != nil {
		return err
	}
	g.manifest.Files[rel] = digest(body)
	return nil
}

func (g *generator) writeJSON(root, rel string, value any, indent bool) error {
	var body []byte
	var err error
	if indent {
		body, err = json.MarshalIndent(value, "", "  ")
	} else {
		body, err = json.Marshal(value)
	}
	if err != nil {
		return err
	}
	body = append(body, '\n')
	return g.write(root, rel, body)
}

// writeUser writes INSIDE default-user and records the path tree-relative ("default-user/..."), so a
// manifest path resolves against the install root for the harness, the SFW scan and a human reader.
func (g *generator) writeUser(rel string, body []byte) error {
	return g.write(g.treeRoot, "default-user/"+rel, body)
}

func (g *generator) writeUserJSON(rel string, value any, indent bool) error {
	return g.writeJSON(g.treeRoot, "default-user/"+rel, value, indent)
}

func (g *generator) buildCharacters(user string) error {
	for index := 0; index < g.spec.Characters; index++ {
		name := nameFragments[index%len(nameFragments)]
		if index >= len(nameFragments) {
			name = fmt.Sprintf("%s %c", name, 'A'+rune(index/len(nameFragments)))
		}
		avatar := name + avatarSuffixes[index%len(avatarSuffixes)] + ".png"
		if index%7 == 3 {
			avatar = fmt.Sprintf("%s_%02d.png", name, index)
		}
		specVersion, chunkKey := "chara_card_v2", "chara"
		if index%3 == 0 {
			specVersion, chunkKey = "chara_card_v3", "ccv3"
		}
		alternates := index % 4
		greetings := make([]any, 0, alternates)
		for alternate := 0; alternate < alternates; alternate++ {
			greetings = append(greetings, fmt.Sprintf("ALT_GREET_%d_%d: A different opening for %s.", index, alternate, name))
		}
		cardBook := map[string]any{}
		bookEntries := 0
		if index%4 == 0 {
			bookEntries = 6
			entries := map[string]any{}
			for number := 0; number < bookEntries; number++ {
				entries[fmt.Sprintf("%d", number)] = map[string]any{
					"id": number, "keys": []any{fmt.Sprintf("CARD_BOOK_KEY_%d", number)},
					"secondary_keys": []any{}, "comment": "embedded entry", "content": fmt.Sprintf("CARD_BOOK_CONTENT_%d", number),
					"constant": false, "selective": true, "insertion_order": 100, "enabled": true,
					"position": "before_char", "case_sensitive": false, "name": name,
				}
			}
			cardBook = map[string]any{"name": "Embedded book " + name, "entries": entries, "extensions": map[string]any{}}
		}
		card := map[string]any{
			"name": name, "description": fmt.Sprintf("Synthetic long-lived description for %s. %s", name, sentence(g.rand, 40)),
			"personality": sentence(g.rand, 12), "scenario": sentence(g.rand, 20),
			"first_mes": fmt.Sprintf("FIRST_MES_%d %s", index, sentence(g.rand, 18)), "mes_example": "<START>\n{{user}}: hi\n{{char}}: hello",
			"creatorcomment": "synthetic", "avatar": "none", "talkativeness": 0.5, "fav": index%5 == 0,
			"tags": []any{"synthetic", fmt.Sprintf("tag_%d", index%4)},
			"spec": specVersion, "spec_version": "3.0",
			"data": map[string]any{
				"name": name, "description": sentence(g.rand, 60), "personality": sentence(g.rand, 10),
				"scenario": sentence(g.rand, 18), "first_mes": fmt.Sprintf("FIRST_MES_%d", index),
				"mes_example": "<START>", "creator_notes": "synthetic", "system_prompt": "SYSTEM_PROMPT_" + name,
				"post_history_instructions": "POST_HISTORY_" + name, "alternate_greetings": greetings,
				"character_book": cardBook, "tags": []any{"synthetic"}, "creator": "longlivedfixture",
				"character_version": "1.0", "extensions": map[string]any{
					"world":         fmt.Sprintf("World_%02d", index%g.spec.Worlds),
					"depth_prompt":  map[string]any{"prompt": "DEPTH_PROMPT_" + name, "depth": 4, "role": "system"},
					"talkativeness": "0.5", "fav": index%5 == 0,
				},
			},
		}
		body, err := cardPNG(card, chunkKey, index)
		if err != nil {
			return err
		}
		if err := g.writeUser("characters/"+avatar, body); err != nil {
			return err
		}
		g.manifest.Characters = append(g.manifest.Characters, Character{
			Avatar: avatar, Name: name, Spec: specVersion, AltGreets: alternates,
			CardBook: bookEntries, HasSprites: index%6 == 0,
		})
		if index%6 == 0 {
			// A sprite folder beside the avatar, shaped like the pinned sprites extension expects.
			for _, emotion := range []string{"joy", "sadness"} {
				sprite, err := cardPNG(map[string]any{"name": name + "-" + emotion}, "", index)
				if err != nil {
					return err
				}
				if err := g.writeUser(fmt.Sprintf("characters/%s/%s.png", strings.TrimSuffix(avatar, ".png"), emotion), sprite); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func (g *generator) buildWorlds(user string) error {
	for index := 0; index < g.spec.Worlds; index++ {
		count := 20 + index*10
		if index == 0 {
			count = g.spec.BigWorld
		}
		entries := map[string]any{}
		regexKeys := 0
		for number := 0; number < count; number++ {
			keys := []any{fmt.Sprintf("WI_KEY_%d_%d", index, number)}
			if number%9 == 0 {
				keys = append(keys, fmt.Sprintf("wi_alias_%d", number))
			}
			if number%13 == 0 {
				keys = append(keys, fmt.Sprintf("/wi_regex_%d/i", number))
				regexKeys++
			}
			entries[fmt.Sprintf("%d", number)] = map[string]any{
				"uid": number, "key": keys, "keysecondary": []any{fmt.Sprintf("WI_SECONDARY_%d", number%5)},
				"comment":  fmt.Sprintf("entry %d of world %d", number, index),
				"content":  fmt.Sprintf("WI_CONTENT_%d_%d %s", index, number, sentence(g.rand, 24)),
				"constant": number%11 == 0, "vectorized": number%17 == 0, "selective": number%2 == 0,
				"selectiveLogic": number % 4, "addMemo": true, "order": 100 + number%50,
				"position": number % 5, "disable": number%19 == 0, "excludeRecursion": number%7 == 0,
				"preventRecursion": number%23 == 0, "delayUntilRecursion": number % 3,
				"probability": 100, "useProbability": true, "depth": number % 8,
				"group": fmt.Sprintf("group_%d", number%6), "groupOverride": false, "groupWeight": 100,
				"scanDepth": number % 4, "caseSensitive": number%3 == 0, "matchWholeWords": number%5 == 0,
				"useGroupScoring": false, "automationId": "", "role": number % 3,
				"sticky": number % 4, "cooldown": number % 6, "delay": number % 5, "displayIndex": number,
				"fixtureUnknownField": map[string]any{"keep": true, "nested": []any{1, 2}},
			}
		}
		name := fmt.Sprintf("World_%02d", index)
		if err := g.writeUserJSON("worlds/"+name+".json", map[string]any{"entries": entries}, false); err != nil {
			return err
		}
		g.manifest.Worlds = append(g.manifest.Worlds, World{File: "worlds/" + name + ".json", Entries: count, Regex: regexKeys})
	}
	return nil
}

func (g *generator) buildPresets(user string) error {
	roles := []string{"system", "user", "assistant"}
	for index := 0; index < g.spec.Presets; index++ {
		promptCount := 40
		if index == 0 {
			promptCount = 120
		}
		prompts := make([]any, 0, promptCount)
		order := make([]any, 0, promptCount)
		for number := 0; number < promptCount; number++ {
			identifier := fmt.Sprintf("PRESET_%d_%d", index, number)
			prompts = append(prompts, map[string]any{
				"identifier": identifier, "name": "entry " + identifier, "role": roles[number%3],
				"content":       fmt.Sprintf("PRESET_BODY_%d_%d %s", index, number, sentence(g.rand, 10)),
				"system_prompt": number%3 == 0, "marker": number%10 == 0,
				"injection_position": number % 2, "injection_depth": number % 8, "injection_order": 100 + number,
				"forbid_overrides": false,
			})
			order = append(order, map[string]any{"identifier": identifier, "enabled": number%7 != 0})
		}
		name := fmt.Sprintf("Chat Preset %d", index)
		preset := map[string]any{
			"temperature": 1.0 + float64(index)*0.05, "frequency_penalty": 0, "presence_penalty": 0.1,
			"top_p": 0.95, "top_k": 40, "openai_max_context": 32000, "openai_max_tokens": 1200,
			"stream_openai": true, "names_behavior": 0, "squash_system_messages": true,
			"wrap_in_quotes": false, "continue_prefill": true, "function_calling": false,
			"reasoning_effort": "medium", "custom_url": "", "custom_model": "synthetic-model",
			"prompts":      prompts,
			"prompt_order": []any{map[string]any{"character_id": 100001, "order": order}},
			"extensions": map[string]any{
				"tavern_helper": map[string]any{
					"scripts": []any{}, "variables": map[string]any{"synthetic_var": index},
				},
			},
		}
		if err := g.writeUserJSON("OpenAI Settings/"+name+".json", preset, true); err != nil {
			return err
		}
		g.manifest.Presets = append(g.manifest.Presets, name)
		textName := fmt.Sprintf("Text Preset %d", index)
		textPreset := map[string]any{
			"temp": 0.9, "top_p": 0.9, "top_k": 40, "rep_pen": 1.05, "max_tokens": 400,
			"instruct": map[string]any{
				"enabled": true, "input_sequence": "### Instruction:", "output_sequence": "### Response:",
				"system_prompt": "TEXT_SYSTEM_" + fmt.Sprint(index), "wrap": true,
				"names_behavior": 0, "activation_regex": "", "bind_to_context": false,
				"last_system_sequence": "", "stop_sequence": "",
			},
			"context":      map[string]any{"story_string": "CONTEXT_STORY_" + fmt.Sprint(index), "example_separator": "***"},
			"preset_names": []any{},
		}
		if err := g.writeUserJSON("TextGen Settings/"+textName+".json", textPreset, true); err != nil {
			return err
		}
		g.manifest.TextPresets = append(g.manifest.TextPresets, textName)
	}
	return nil
}

func (g *generator) buildChats(user string) error {
	for index, character := range g.manifest.Characters {
		folder := strings.TrimSuffix(character.Avatar, ".png")
		messages := g.spec.ChatBase + index*g.spec.ChatStep
		path := fmt.Sprintf("chats/%s/%s - 2023-01-0%d.jsonl", folder, folder, index%9+1)
		body, swipes := g.chatJSONL(character.Name, messages, index)
		if err := g.writeUser(path, body); err != nil {
			return err
		}
		manifestPath := "default-user/" + path
		g.manifest.Chats = append(g.manifest.Chats, Chat{Path: manifestPath, Character: character.Name, Messages: messages, Swipes: swipes})
		// A branch of the main chat, named the way the pinned frontend names one.
		if index%5 == 0 {
			branchPath := fmt.Sprintf("chats/%s/%s - 2024-02-1%d - branch.jsonl", folder, folder, index%9)
			branchBody, branchSwipes := g.chatJSONL(character.Name, 40, index+1000)
			if err := g.writeUser(branchPath, branchBody); err != nil {
				return err
			}
			g.manifest.Chats = append(g.manifest.Chats, Chat{Path: "default-user/" + branchPath, Character: character.Name, Messages: 40, Swipes: branchSwipes, BranchOf: path})
		}
		// Backups of the same chat, as a long history leaves behind.
		backup := fmt.Sprintf("backups/chat_%s_%03d.jsonl", folder, index)
		if err := g.writeUser(backup, body); err != nil {
			return err
		}
	}
	return nil
}

// chatJSONL writes the pinned chat shape: the FIRST line is the metadata record, then one JSON object per
// message. Assistant messages carry swipes and a swipe_id, some messages are system messages, and the
// timestamps span years so "a chat from 2023" is actually 2023.
func (g *generator) chatJSONL(characterName string, messages, salt int) ([]byte, int) {
	var builder bytes.Buffer
	meta := map[string]any{
		"user_name": "synthetic-user", "character_name": characterName,
		"create_date": fmt.Sprintf("2023-01-%02dT10:00:00.000Z", salt%9+1),
		"chat_metadata": map[string]any{
			"integrity":     "",
			"world_info":    fmt.Sprintf("World_%02d", salt%g.spec.Worlds),
			"note_prompt":   "SYNTHETIC_NOTE " + fmt.Sprint(salt),
			"note_interval": 3, "note_position": 1, "note_role": 0,
			"variables": map[string]any{"mood": "curious", "turn": salt},
			"taint":     false, "timedWorldInfo": map[string]any{},
		},
	}
	metaBody, _ := json.Marshal(meta)
	builder.Write(metaBody)
	builder.WriteString("\n")
	swipes := 0
	for number := 0; number < messages; number++ {
		isUser := number%2 == 1
		record := map[string]any{
			"name": characterName, "is_user": isUser, "is_system": number%97 == 96,
			"send_date": fmt.Sprintf("2023-%02d-%02dT%02d:%02d:00.000Z",
				1+number/28%12, 1+number%28, number%24, number%60),
			"mes": fmt.Sprintf("CHAT_%d_%d %s", salt, number, sentence(g.rand, 12)),
			"extra": map[string]any{
				"api": "custom", "model": "synthetic-model", "reasoning": "",
				"reasoning_duration": nil, "reasoning_signature": nil,
				"gen_started": "2023-01-01T10:00:00.000Z", "gen_finished": "2023-01-01T10:00:01.000Z",
			},
		}
		if !isUser && number%10 == 0 {
			alternates := make([]any, 3)
			for alternate := range alternates {
				alternates[alternate] = fmt.Sprintf("SWIPE_%d_%d_%d", salt, number, alternate)
			}
			record["swipe_id"] = number % 3
			record["swipes"] = alternates
			record["mes"] = alternates[number%3]
			swipes++
		}
		body, _ := json.Marshal(record)
		builder.Write(body)
		builder.WriteString("\n")
	}
	return builder.Bytes(), swipes
}

func (g *generator) buildGroups(user string) error {
	groups := make([]any, 0, g.spec.Groups)
	for index := 0; index < g.spec.Groups; index++ {
		members := make([]any, 0, 4)
		for member := 0; member < 4; member++ {
			members = append(members, g.manifest.Characters[(index*4+member)%len(g.manifest.Characters)].Avatar)
		}
		name := fmt.Sprintf("Synthetic Group %d", index)
		chatID := fmt.Sprintf("group-chat-%d", index)
		groups = append(groups, map[string]any{
			"id": fmt.Sprintf("group-%d", index), "name": name, "members": members,
			"disabled_members": []any{}, "chat_id": chatID, "chats": []any{chatID},
			"activation_strategy": index % 3, "generation_mode": index % 2,
			"favorited": index == 0, "auto_mode_delay": 0,
		})
		// Pinned stores group transcripts in <handle>/group chats/<chat_id>.jsonl
		// (src/endpoints/groups.js:68-74), NOT under chats/<id>/. A fixture that put them in chats/
		// would look right to a directory walk and wrong to the product, so the corpus uses the pinned
		// location and the manifest records that exact path.
		body, _ := g.chatJSONL(name, 30, 5000+index)
		groupChat := "group chats/" + chatID + ".jsonl"
		if err := g.writeUser(groupChat, body); err != nil {
			return err
		}
		g.manifest.Groups = append(g.manifest.Groups, Group{Name: name, Members: members2Strings(members), Chat: "default-user/" + groupChat})
	}
	return g.writeUserJSON("groups/groups.json", map[string]any{"groups": groups}, true)
}

func members2Strings(values []any) []string {
	out := make([]string, 0, len(values))
	for _, value := range values {
		if text, ok := value.(string); ok {
			out = append(out, text)
		}
	}
	return out
}

func (g *generator) buildAssets(user string) error {
	for index := 0; index < g.spec.Backgrounds; index++ {
		name := fmt.Sprintf("Background_%02d.png", index)
		body, err := cardPNG(map[string]any{"name": name}, "", 9000+index)
		if err != nil {
			return err
		}
		if err := g.writeUser("backgrounds/"+name, body); err != nil {
			return err
		}
		g.manifest.Backgrounds = append(g.manifest.Backgrounds, name)
	}
	metadata := map[string]any{}
	for _, name := range g.manifest.Backgrounds {
		metadata[name] = map[string]any{"extra": []any{}, "shown": true, "title": name}
	}
	if err := g.writeUserJSON("backgrounds/backgrounds.json", metadata, true); err != nil {
		return err
	}
	for index := 0; index < g.spec.Personas; index++ {
		name := fmt.Sprintf("Persona_%d", index)
		body, err := cardPNG(map[string]any{"name": name}, "", 7000+index)
		if err != nil {
			return err
		}
		if err := g.writeUser("User Avatars/"+name+".png", body); err != nil {
			return err
		}
		g.manifest.Personas = append(g.manifest.Personas, name)
	}
	for index := 0; index < g.spec.Themes; index++ {
		name := fmt.Sprintf("Theme_%d", index)
		theme := map[string]any{
			"name": name, "blur_strength": index * 2, "main_text_color": "#ffffff",
			"italics_text_color": "#cccccc", "underline_text_color": "#dddddd",
			"quote_text_color": "#bbbbbb", "blur_tint_color": "#000000", "chat_tint_color": "#101010",
			"user_mes_blur_tint_color": "#111111", "bot_mes_blur_tint_color": "#121212",
			"shadow_color": "#000000", "shadow_width": 1, "border_color": "#333333",
			"font_scale": 1.0, "fast_ui_mode": false, "avatar_style": 0, "custom_css": "/* synthetic */",
		}
		if err := g.writeUserJSON("themes/"+name+".json", theme, true); err != nil {
			return err
		}
		g.manifest.Themes = append(g.manifest.Themes, name)
	}
	for index := 0; index < g.spec.QuickReply; index++ {
		name := fmt.Sprintf("QuickReplies_%d", index)
		list := []any{}
		for item := 0; item < 5; item++ {
			list = append(list, map[string]any{
				"id": fmt.Sprintf("qr-%d-%d", index, item), "label": fmt.Sprintf("QR %d %d", index, item),
				"message": fmt.Sprintf("/echo QR_%d_%d", index, item), "showLabel": true,
				"automationId": "", "preventAutoExecute": false, "isHidden": false,
				"executeOnStartup": item == 0, "executeOnUser": false,
			})
		}
		if err := g.writeUserJSON("QuickReplies/"+name+".json", map[string]any{"qrList": list}, true); err != nil {
			return err
		}
		g.manifest.QuickReplies = append(g.manifest.QuickReplies, name)
	}
	// movingUI layout, an extension's own state file, an asset and a random user file.
	movingUI := map[string]any{}
	for _, id := range []string{"leftNavPanel", "rightNavPanel", "characterPanel"} {
		movingUI[id] = map[string]any{"x": 10, "y": 10, "width": 100, "height": 100, "visible": true}
	}
	if err := g.writeUserJSON("movingUI/movingui.json", movingUI, true); err != nil {
		return err
	}
	if err := g.writeUserJSON("extensions/synthetic-extension/settings.json", map[string]any{
		"enabled": true, "depth": 3, "list": []any{"alpha", "beta"}, "nested": map[string]any{"x": 1},
	}, true); err != nil {
		return err
	}
	if err := g.writeUser("user/files/synthetic-note.txt", []byte("a user file the product has no opinion about\n")); err != nil {
		return err
	}
	if err := g.writeUser("user/images/synthetic-image.png", []byte("not really a png, just bytes the product must not rewrite")); err != nil {
		return err
	}
	if err := g.writeUser("assets/synthetic-asset.json", []byte(`{"synthetic":true}`)); err != nil {
		return err
	}
	return nil
}

func (g *generator) buildSettings(user string) error {
	personas := map[string]any{}
	personaDescriptions := map[string]any{}
	for index, name := range g.manifest.Personas {
		personas[name] = "Persona_" + fmt.Sprint(index) + ".png"
		personaDescriptions[fmt.Sprintf("Persona_%d.png", index)] = map[string]any{
			"description": fmt.Sprintf("SYNTHETIC_PERSONA_DESCRIPTION_%d", index),
			"position":    index % 3, "depth": index % 5, "role": index % 3,
			"lorebook": "", "connections": []any{}, "title": "Persona " + fmt.Sprint(index),
		}
	}
	currentPreset := ""
	if len(g.manifest.Presets) > 0 {
		currentPreset = g.manifest.Presets[0]
	}
	settings := map[string]any{
		"power_user": map[string]any{
			"active_character": g.manifest.Characters[0].Avatar,
			"active_group":     "", "active_persona": "Persona_0",
			"personas": personas, "persona_descriptions": personaDescriptions,
			"tags": []any{"synthetic", "tag_0", "tag_1"}, "tag_map": map[string]any{"synthetic": map[string]any{"color": "#ff0000"}},
			"default_avatar": "User Avatars/Persona_0.png", "avatar_style": 0,
			"context_size": 4096, "max_context_unlocked": true, "instruct_mode": 0,
			"sysprompt": map[string]any{"enabled": false}, "world_info": map[string]any{
				"globalSelect": []any{}, "charLore": []any{}, "depth": 4, "budget": 25, "recursive": true, "recursive_depth": 2,
			},
			"extension_settings": map[string]any{
				"synthetic-extension": map[string]any{"enabled": true, "depth": 3, "nested": map[string]any{"x": 1}},
				"another-extension":   map[string]any{"mode": "auto", "values": []any{1, 2, 3}},
			},
			"quick_replies": g.manifest.QuickReplies, "theme": g.manifest.Themes[0],
			"current_preset": currentPreset, "preset_settings_openai": currentPreset,
			"auto_connect": false, "streaming": true, "smooth_streaming": true,
			"image_inlining": false, "suggestions": true,
		},
		"character_aliases":       map[string]any{g.manifest.Characters[0].Name: "Alias One"},
		"longlived_unknown_state": map[string]any{"keep": true, "why": "a key this project has never parsed"},
		"character_avatars":       map[string]any{},
	}
	if err := g.writeUserJSON("settings.json", settings, true); err != nil {
		return err
	}
	if err := g.writeUserJSON("secrets.json", map[string]any{
		"api_key_synthetic": "synthetic-secret-value-not-real",
	}, true); err != nil {
		return err
	}
	for _, name := range []string{"synthetic-tag-1", "synthetic-tag-2"} {
		if err := g.writeUserJSON("regex/"+name+".json", map[string]any{
			"id": name, "scriptName": name, "findRegex": fmt.Sprintf("/SYNTHETIC_%s/gi", name),
			"replaceString": "REPLACED", "trimStrings": []any{}, "placement": []any{1, 2},
			"disabled": false, "markdownOnly": false, "promptOnly": false, "runOnEdit": true,
			"substituteRegex": 0, "minDepth": nil, "maxDepth": nil,
		}, true); err != nil {
			return err
		}
	}
	return g.writeUserJSON("stats/stats.json", map[string]any{
		"total_messages": 12345, "synthetic": true,
	}, true)
}

func (g *generator) buildUnknownAndLegacyData(root, user string) error {
	// Files a real long-lived tree accumulates that the product must leave alone.
	unknown := map[string][]byte{
		"unknown_extension_state.json": []byte(`{"unknown":true,"nested":{"keep":"me"}}`),
		"data.bak":                     []byte("BACKUP BYTES THAT MUST NOT BE REWRITTEN"),
		"Thumbs.db":                    {0x30, 0x00, 0x00, 0x00, 0xff, 0xfe},
		"user/files/large-unknown.bin": bytes.Repeat([]byte{0xAB}, 4096),
	}
	for rel, body := range unknown {
		if err := g.writeUser(rel, body); err != nil {
			return err
		}
		g.manifest.UnknownFiles = append(g.manifest.UnknownFiles, "default-user/"+rel)
	}
	// Legacy layout the migration path must read: characters under public/characters.
	legacy := map[string]any{
		"name": "Legacy Card", "description": "LEGACY_DESCRIPTION", "personality": "legacy",
		"first_mes": "LEGACY_FIRST_MES", "scenario": "legacy scenario",
	}
	body, err := cardPNG(legacy, "chara", 4242)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Join(root, "public", "characters"), 0o777); err != nil {
		return err
	}
	legacyPath := "public/characters/Legacy_Card.png"
	if err := os.WriteFile(filepath.Join(root, "public", "characters", "Legacy_Card.png"), body, 0o600); err != nil {
		return err
	}
	g.manifest.LegacyAssets = append(g.manifest.LegacyAssets, legacyPath)
	g.manifest.Files[legacyPath] = digest(body)
	if err := os.WriteFile(filepath.Join(root, "public", "characters", "Legacy_Card.json"), []byte(`{"name":"Legacy Card","legacy":true}`), 0o600); err != nil {
		return err
	}
	g.manifest.Files["public/characters/Legacy_Card.json"] = digest([]byte(`{"name":"Legacy Card","legacy":true}`))
	return nil
}

func (g *generator) writeConfig(root string) error {
	config := strings.Join([]string{
		"# a long-lived config: only the settings a real operator changes",
		"port: 8000",
		"listen: false",
		"enableIPv4: true",
		"browserLaunchEnabled: false",
		"whitelistMode: false",
		"longlived_legacy: keep-me",
		"", "",
	}, "\n")
	return g.write(root, "config.yaml", []byte(config))
}

// cardPNG writes a deterministic PNG and embeds the card JSON in a tEXt chunk (`chara` for v2, `ccv3`
// for v3). The pixels are a gradient keyed by the seed, so every card is a different valid image and the
// thumbnail codec has real work to do.
func cardPNG(card map[string]any, chunkKey string, seed int) ([]byte, error) {
	width, height := 96, 144
	picture := image.NewRGBA(image.Rect(0, 0, width, height))
	for y := 0; y < height; y++ {
		for x := 0; x < width; x++ {
			picture.Set(x, y, color.RGBA{R: uint8(x + seed), G: uint8(y), B: uint8(seed * 7), A: 255})
		}
	}
	var encoded bytes.Buffer
	if err := png.Encode(&encoded, picture); err != nil {
		return nil, err
	}
	raw := encoded.Bytes()
	if chunkKey == "" {
		return raw, nil
	}
	payload, err := json.Marshal(card)
	if err != nil {
		return nil, err
	}
	text := []byte(chunkKey + "\x00" + base64.StdEncoding.EncodeToString(payload))
	chunk := make([]byte, 0, len(text)+12)
	length := []byte{byte(len(text) >> 24), byte(len(text) >> 16), byte(len(text) >> 8), byte(len(text))}
	chunk = append(chunk, length...)
	chunk = append(chunk, []byte("tEXt")...)
	chunk = append(chunk, text...)
	crc := crc32.ChecksumIEEE(chunk[4:])
	chunk = append(chunk, byte(crc>>24), byte(crc>>16), byte(crc>>8), byte(crc))
	iend := bytes.LastIndex(raw, []byte("IEND"))
	if iend < 4 {
		return nil, fmt.Errorf("encoded PNG has no IEND")
	}
	out := make([]byte, 0, len(raw)+len(chunk))
	out = append(out, raw[:iend-4]...)
	out = append(out, chunk...)
	out = append(out, raw[iend-4:]...)
	return out, nil
}

func sentence(random *rand.Rand, words int) string {
	vocabulary := []string{
		"lantern", "harbor", "quiet", "copper", "meadow", "signal", "winter", "glass",
		"archive", "ember", "tide", "orbit", "shadow", "candle", "synthetic", "story",
	}
	parts := make([]string, 0, words)
	for index := 0; index < words; index++ {
		parts = append(parts, vocabulary[random.Intn(len(vocabulary))])
	}
	return strings.Join(parts, " ")
}

func digest(body []byte) string {
	sum := sha256.Sum256(body)
	return hex.EncodeToString(sum[:])
}

// sortedKeys exists for deterministic error messages and future manifest diffs.
func sortedKeys(values map[string]string) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
