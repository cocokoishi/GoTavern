// a15-fixturegen: deterministic, generated data roots for the A15 performance ladder.
//
// WHY THIS EXISTS. The process-level measurement (scripts/a15-bench-suite.mjs) needs trees of a KNOWN scale:
// 100/1,000/10,000 character cards, a >=2,000-message JSONL chat, many world books, a settings tree with 1,100
// preset/theme/QR documents, and a complex-preset tree. Nothing in the repository could produce those as a
// standalone data root (the scale generators live inside internal/server/bench_test.go and only exist while a
// benchmark runs), and hand-writing a "big tree" is how a measurement ends up measuring a fixture's omissions.
//
// The shapes below deliberately MIRROR internal/server/bench_test.go's generators so an in-process benchmark
// result and a process-level result describe the same tree: a real decodable PNG card with a `chara` tEXt
// document and a same-size ancillary `prVt` payload (the reader copies chunk bytes, never decodes them), JSON
// documents padded to a target size, chats with LF and CRLF line endings, and one very long line. Every body is
// generated from xorshift64* noise / repeated prose, never from math/rand, so the same bytes appear on every
// host and run.
//
// USAGE
//
//	a15-fixturegen --out <dir> --scale mixed-large
//	a15-fixturegen --out <dir> --scale cards --cards 10000 --image-bytes 4096 --card-bytes 4096
//	a15-fixturegen --out <dir> --scale chats --chats 100 --chat-bytes 262144
//	a15-fixturegen --out <dir> --scale cold
//
// The program prints one JSON line: scale, data root, file count, byte count per area. It refuses an `--out`
// that already contains a `data/` tree (a stale tree would splice two scales into one measurement).
package main

import (
	"bytes"
	"compress/zlib"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"hash/crc32"
	"os"
	"path/filepath"
	"strings"
)

const defaultHandle = "default-user"

func main() {
	out := flag.String("out", "", "data root to create (required)")
	scale := flag.String("scale", "base", "cold|base|cards|cards-heavy|chats|chats-large|settings|worlds|mixed-large|complex-preset")
	cards := flag.Int("cards", 100, "number of character cards")
	imageBytes := flag.Int("image-bytes", 4096, "per-card ancillary image payload bytes")
	cardBytes := flag.Int("card-bytes", 4096, "per-card JSON document bytes")
	chats := flag.Int("chats", 10, "number of JSONL chats")
	chatBytes := flag.Int("chat-bytes", 262144, "approximate bytes per chat")
	chatMessages := flag.Int("chat-messages", 2000, "minimum messages in each chat (overrides chat-bytes)")
	worlds := flag.Int("worlds", 50, "number of world books")
	worldBytes := flag.Int("world-bytes", 32768, "approximate bytes per world book")
	filesPerDir := flag.Int("files-per-dir", 100, "settings documents per preset/theme/QR directory")
	fileBytes := flag.Int("file-bytes", 4096, "approximate bytes per settings document")
	flag.Parse()

	if *out == "" {
		fmt.Fprintln(os.Stderr, "usage: a15-fixturegen --out <dir> --scale <name>")
		os.Exit(2)
	}
	dataRoot := filepath.Join(*out, "data")
	if _, err := os.Stat(dataRoot); err == nil {
		fmt.Fprintf(os.Stderr, "refusing %s: it already has a data/ tree (remove it first; a stale tree would splice scales)\n", *out)
		os.Exit(2)
	}

	generator := &fixtureGenerator{dataRoot: dataRoot, byArea: map[string]int{}}
	var err error
	switch *scale {
	case "cold":
		err = generator.plantCold()
	case "base":
		// The smallest tree every ROUTE accepts: the settings aggregation directories plus settings.json and a
		// base world book (plantBenchSettingsBase(0,0) in bench_test.go). A page-load replay over a truly empty
		// user directory answers 500 from /api/settings/get for a tree-shape reason, not a product cost, so the
		// page-load and startup measurements use this scale.
		err = generator.plantSettingsBase(0, 0)
	case "cards":
		err = generator.plantCards(*cards, *imageBytes, *cardBytes)
	case "cards-heavy":
		err = generator.plantCards(*cards, *imageBytes, *cardBytes)
	case "chats":
		err = generator.plantChats(*chats, *chatBytes)
	case "chats-large":
		err = generator.plantChatsWithMessages(*chats, *chatMessages, *chatBytes)
	case "settings":
		err = generator.plantSettings(*filesPerDir, *fileBytes)
	case "worlds":
		err = generator.plantWorlds(*worlds, *worldBytes)
	case "complex-preset":
		err = generator.plantComplexPreset()
	case "mixed-large":
		err = generator.plantMixed()
	default:
		err = fmt.Errorf("unknown scale %q", *scale)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "a15-fixturegen: %v\n", err)
		os.Exit(1)
	}
	if err := generator.writeConfig(); err != nil {
		fmt.Fprintf(os.Stderr, "a15-fixturegen: %v\n", err)
		os.Exit(1)
	}
	summary := generator.summary(*scale)
	encoded, _ := json.Marshal(summary)
	fmt.Println(string(encoded))
}

type fixtureGenerator struct {
	dataRoot string
	files    int
	bytes    int64
	byArea   map[string]int
}

type fixtureSummary struct {
	Generator string         `json:"generator"`
	Scale     string         `json:"scale"`
	DataRoot  string         `json:"dataRoot"`
	Files     int            `json:"files"`
	Bytes     int64          `json:"bytes"`
	ByArea    map[string]int `json:"byArea"`
}

func (generator *fixtureGenerator) summary(scale string) fixtureSummary {
	if generator.byArea == nil {
		generator.byArea = map[string]int{}
	}
	return fixtureSummary{Generator: "tests/perf/fixturegen", Scale: scale, DataRoot: generator.dataRoot, Files: generator.files, Bytes: generator.bytes, ByArea: generator.byArea}
}

func (generator *fixtureGenerator) write(relative string, body []byte) error {
	target := filepath.Join(generator.dataRoot, filepath.FromSlash(relative))
	if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", relative, err)
	}
	if err := os.WriteFile(target, body, 0o644); err != nil {
		return fmt.Errorf("write %s: %w", relative, err)
	}
	generator.files++
	generator.bytes += int64(len(body))
	return nil
}

func (generator *fixtureGenerator) writeConfig() error {
	config := []byte("# generated by tests/perf/fixturegen\nlisten: false\nskipContentCheck: true\nautoConnect: false\nextensions:\n  enabled: false\n  autoUpdate: false\nbrowserLaunch:\n  enabled: false\nbackups:\n  chat:\n    enabled: false\n")
	target := filepath.Join(filepath.Dir(generator.dataRoot), "config.yaml")
	return os.WriteFile(target, config, 0o644)
}

// plantCold creates the smallest tree a boot accepts: the user directory exists, no data documents.
func (generator *fixtureGenerator) plantCold() error {
	return os.MkdirAll(filepath.Join(generator.dataRoot, defaultHandle), 0o755)
}

// plantCards writes `count` real PNG cards whose image payload and JSON document have the requested sizes.
// /api/characters/all reads every card on each request, so the card count is the scale lever.
func (generator *fixtureGenerator) plantCards(count, imageBytes, cardBytes int) error {
	if err := generator.plantSettingsBase(0, 0); err != nil {
		return err
	}
	card := cardPNG(imageBytes, cardBytes)
	for index := 0; index < count; index++ {
		relative := fmt.Sprintf("%s/characters/A15 Card %05d.png", defaultHandle, index)
		if err := generator.write(relative, card); err != nil {
			return err
		}
		generator.byArea["characters"]++
	}
	return nil
}

// plantChats writes `count` JSONL chats of approximately chatBytes each. Half use LF and half CRLF; the first
// message of the first chat is a single very long line (the chat-summary reader's long-line case).
func (generator *fixtureGenerator) plantChats(count, chatBytes int) error {
	if err := generator.plantSettingsBase(0, 0); err != nil {
		return err
	}
	if err := generator.write(defaultHandle+"/characters/A15 Character.png", cardPNG(1024, 1024)); err != nil {
		return err
	}
	for index := 0; index < count; index++ {
		ending := "\n"
		if index%2 == 1 {
			ending = "\r\n"
		}
		var body strings.Builder
		body.WriteString(`{"user_name":"bench","character_name":"A15 Character","chat_metadata":{"world_info":"A15 Lore"}}` + ending)
		messageIndex := 0
		for body.Len() < chatBytes-1024 {
			payload := strings.Repeat("m", 250)
			if index == 0 && messageIndex == 0 {
				payload = strings.Repeat("L", max(chatBytes/2, 4096))
			}
			line := fmt.Sprintf(`{"name":"A15 Character","is_user":%t,"mes":"%s","send_date":"2026-01-01T00:00:00.000Z"}`, imageIndexEven(messageIndex), payload)
			if body.Len()+len(line)+len(ending) > chatBytes {
				break
			}
			body.WriteString(line + ending)
			messageIndex++
		}
		relative := fmt.Sprintf("%s/chats/A15 Character/A15 Chat %04d.jsonl", defaultHandle, index)
		if err := generator.write(relative, []byte(body.String())); err != nil {
			return err
		}
		generator.byArea["chats"]++
	}
	return nil
}

// plantChatsWithMessages writes `count` chats each with at least `messages` messages, including a swiped/edited
// message and one very long single line, so the process-level tree exercises the same shapes the chat-summary
// benchmarks do.
func (generator *fixtureGenerator) plantChatsWithMessages(count, messages, chatBytes int) error {
	if err := generator.plantSettingsBase(0, 0); err != nil {
		return err
	}
	if err := generator.write(defaultHandle+"/characters/A15 Character.png", cardPNG(1024, 1024)); err != nil {
		return err
	}
	for index := 0; index < count; index++ {
		ending := "\n"
		if index%2 == 1 {
			ending = "\r\n"
		}
		var body strings.Builder
		body.WriteString(`{"user_name":"bench","character_name":"A15 Character","chat_metadata":{"world_info":"A15 Lore","variables":{"a15":"1"}}}` + ending)
		for messageIndex := 0; messageIndex < messages; messageIndex++ {
			payload := strings.Repeat("m", 250)
			if messageIndex == 7 {
				payload = strings.Repeat("L", max(chatBytes/2, 65536))
			}
			if messageIndex == 11 {
				// A message with swipes and a selected later alternative: `mes` is not `swipes[0]`.
				swipes, err := json.Marshal([]string{"first branch", "second branch", "third branch"})
				if err != nil {
					return err
				}
				line := fmt.Sprintf(`{"name":"A15 Character","is_user":false,"mes":"third branch","swipes":%s,"swipe_id":2,"send_date":"2026-01-01T00:00:11.000Z"}`, swipes)
				body.WriteString(line + ending)
				continue
			}
			line := fmt.Sprintf(`{"name":"A15 Character","is_user":%t,"mes":"%s","send_date":"2026-01-01T00:00:00.000Z"}`, imageIndexEven(messageIndex), payload)
			body.WriteString(line + ending)
		}
		relative := fmt.Sprintf("%s/chats/A15 Character/A15 Chat %04d.jsonl", defaultHandle, index)
		if err := generator.write(relative, []byte(body.String())); err != nil {
			return err
		}
		generator.byArea["chats"]++
	}
	return nil
}

// plantSettings writes the directory family /api/settings/get aggregates: preset directories, themes, movingUI,
// Quick Replies, instruct/context/sysprompt/reasoning, each with filesPerDir documents.
func (generator *fixtureGenerator) plantSettings(filesPerDir, fileBytes int) error {
	if err := generator.plantSettingsBase(filesPerDir, fileBytes); err != nil {
		return err
	}
	return nil
}

// plantWorlds writes world books; /api/worldinfo/list reads every one on each request.
func (generator *fixtureGenerator) plantWorlds(count, worldBytes int) error {
	if err := generator.plantSettingsBase(0, 0); err != nil {
		return err
	}
	for index := 0; index < count; index++ {
		relative := fmt.Sprintf("%s/worlds/A15 World %05d.json", defaultHandle, index)
		if err := generator.write(relative, worldJSON(index, worldBytes)); err != nil {
			return err
		}
		generator.byArea["worlds"]++
	}
	return nil
}

// plantComplexPreset writes a realistic heavy configuration: a 40-prompt preset selected in settings, the preset
// document itself, a world book, personas, regex scripts, an author's note and a large chat. It is the tree the
// "complex preset assembly" and "characters + chat load" startup cases boot over.
func (generator *fixtureGenerator) plantComplexPreset() error {
	if err := generator.plantSettingsBase(10, 4096); err != nil {
		return err
	}
	if err := generator.write(defaultHandle+"/worlds/A15 Lore.json", worldJSON(0, 32768)); err != nil {
		return err
	}
	if err := generator.write(defaultHandle+"/characters/A15 Character.png", cardPNG(128*1024, 32*1024)); err != nil {
		return err
	}
	if err := generator.plantChatsWithMessages(1, 2000, 2*1024*1024); err != nil {
		return err
	}
	prompts := make([]map[string]any, 0, 40)
	order := make([]map[string]any, 0, 40)
	for index := 0; index < 40; index++ {
		identifier := fmt.Sprintf("A15_PROMPT_%02d", index)
		prompts = append(prompts, map[string]any{
			"identifier": identifier, "name": fmt.Sprintf("a15 prompt %d", index),
			"system_prompt": index%5 == 0, "role": []string{"system", "user", "assistant"}[index%3],
			"content": strings.Repeat("context ", 40), "injection_position": index % 6,
			"injection_depth": 4, "injection_order": 100 + index, "marker": false,
		})
		order = append(order, map[string]any{"identifier": identifier, "enabled": index%7 != 0})
	}
	preset := map[string]any{
		"temperature": 0.63, "frequency_penalty": 0.2, "presence_penalty": 0.31, "top_p": 0.92, "top_k": 40,
		"openai_max_context": 32000, "openai_max_tokens": 1024, "stream_openai": true,
		"prompts": prompts, "prompt_order": []any{map[string]any{"character_id": 100001, "order": order}},
		"extensions": map[string]any{"regex_scripts": []any{map[string]any{"id": "a15", "scriptName": "A15", "disabled": false, "findRegex": "/A15/g", "replaceString": "A15"}}},
	}
	presetBytes, err := json.MarshalIndent(preset, "", "    ")
	if err != nil {
		return err
	}
	if err := generator.write(defaultHandle+"/OpenAI Settings/A15 Complex.json", presetBytes); err != nil {
		return err
	}
	settings := map[string]any{
		"firstRun": false, "username": "A15 User", "main_api": "openai",
		"preset_settings": "A15 Complex", "amount_gen": 512, "max_context": 16384, "swipes": true,
		"world_info_settings": map[string]any{"world_info": map[string]any{"globalSelect": []string{"A15 Lore"}}, "world_info_depth": 4},
		"power_user": map[string]any{
			"personas": map[string]string{"A15 Persona.png": "A15"}, "default_persona": "A15 Persona.png",
			"theme": "A15 Theme", "custom_stopping_strings": "A15_STOP_ONE\nA15_STOP_TWO",
			"instruct":  map[string]any{"enabled": true, "preset": "ChatML", "input_sequence": "<|im_start|>user\n", "output_sequence": "<|im_start|>assistant\n", "stop_sequence": "<|im_end|>"},
			"sysprompt": map[string]any{"enabled": true, "name": "A15 Sysprompt", "content": strings.Repeat("system ", 100)},
			"context":   map[string]any{"preset": "A15 Context", "story_string": strings.Repeat("story ", 100)},
		},
		"oai_settings": map[string]any{
			"preset_settings_openai": "A15 Complex", "temp_openai": 0.63, "top_p_openai": 0.92,
			"openai_max_context": 32000, "openai_max_tokens": 1024, "stream_openai": true,
			"prompts": prompts, "prompt_order": []any{map[string]any{"character_id": 100001, "order": order}},
			"chat_completion_source": "custom", "custom_url": "http://127.0.0.1:9/v1", "custom_model": "a15-loopback-model",
			"assistant_prefill": "A15_PREFILL", "use_sysprompt": true,
		},
		"extension_settings": map[string]any{
			"regex":               []any{map[string]any{"id": "a15-global", "scriptName": "A15_GLOBAL", "disabled": false, "findRegex": "/A15/g", "replaceString": "A15"}},
			"variables":           map[string]any{"global": map[string]string{"a15": "1"}},
			"a15_extension_state": map[string]any{"enabled": true, "state": map[string]any{"runs": 4}},
		},
		"background": map[string]any{"name": "__transparent.png", "url": "backgrounds/__transparent.png", "fitting": "classic"},
	}
	settingsBytes, err := json.MarshalIndent(settings, "", "    ")
	if err != nil {
		return err
	}
	if err := generator.write(defaultHandle+"/settings.json", settingsBytes); err != nil {
		return err
	}
	generator.byArea["complex-config"]++
	return nil
}

// plantMixed is the large combined tree used for peak-RSS and concurrency measurements: cards, chats (incl. a
// 2,000-message one), worlds, the settings family and a complex preset, all generated and counted.
func (generator *fixtureGenerator) plantMixed() error {
	if err := generator.plantCards(1000, 4096, 4096); err != nil {
		return err
	}
	if err := generator.plantChats(100, 256*1024); err != nil {
		return err
	}
	if err := generator.plantChatsWithMessages(1, 2000, 2*1024*1024); err != nil {
		return err
	}
	if err := generator.plantWorlds(200, 32*1024); err != nil {
		return err
	}
	if err := generator.plantSettingsBase(100, 4096); err != nil {
		return err
	}
	if err := generator.plantComplexPreset(); err != nil {
		return err
	}
	return nil
}

// plantSettingsBase creates every directory /api/settings/get reads; that route answers 500 when one is absent,
// so the base tree is part of every scale.
func (generator *fixtureGenerator) plantSettingsBase(filesPerDir, fileBytes int) error {
	if err := generator.write(defaultHandle+"/settings.json", []byte(`{"username":"a15","active_character":null}`)); err != nil {
		return err
	}
	if err := generator.write(defaultHandle+"/worlds/A15 Base World.json", worldJSON(0, 512)); err != nil {
		return err
	}
	for _, directory := range []string{
		"NovelAI Settings", "KoboldAI Settings", "OpenAI Settings", "TextGen Settings",
		"themes", "movingUI", "QuickReplies", "instruct", "context", "sysprompt", "reasoning",
	} {
		if filesPerDir == 0 {
			if err := os.MkdirAll(filepath.Join(generator.dataRoot, defaultHandle, directory), 0o755); err != nil {
				return err
			}
			continue
		}
		for index := 0; index < filesPerDir; index++ {
			relative := fmt.Sprintf("%s/%s/a15-%03d.json", defaultHandle, directory, index)
			if err := generator.write(relative, settingsDocument(directory, index, fileBytes)); err != nil {
				return err
			}
			generator.byArea["settings"]++
		}
	}
	return nil
}

// cardPNG builds the real PNG card described in the header: signature, IHDR, a same-size ancillary payload
// (`prVt`), one-pixel IDAT, the `chara` tEXt card document and IEND.
func cardPNG(imageBytes, cardBytes int) []byte {
	var out bytes.Buffer
	out.Write([]byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A})
	out.Write(pngChunk("IHDR", []byte{0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0}))
	if imageBytes > 0 {
		out.Write(pngChunk("prVt", noise(uint64(imageBytes)+7, imageBytes)))
	}
	out.Write(pngChunk("IDAT", pixelIDAT()))
	out.Write(pngChunk("tEXt", []byte("chara\x00"+base64.StdEncoding.EncodeToString(cardJSON(cardBytes)))))
	out.Write(pngChunk("IEND", nil))
	return out.Bytes()
}

func pngChunk(name string, data []byte) []byte {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(data)))
	out := append([]byte{}, length[:]...)
	out = append(out, name...)
	out = append(out, data...)
	crc := crc32.NewIEEE()
	_, _ = crc.Write([]byte(name))
	_, _ = crc.Write(data)
	binary.BigEndian.PutUint32(length[:], crc.Sum32())
	return append(out, length[:]...)
}

func pixelIDAT() []byte {
	var compressed bytes.Buffer
	writer := zlib.NewWriter(&compressed)
	_, _ = writer.Write([]byte{0x00, 0x10, 0x20, 0x30})
	_ = writer.Close()
	return compressed.Bytes()
}

func cardJSON(target int) []byte {
	const document = `{"spec":"chara_card_v2","spec_version":"2.0","data":{"name":"A15 Card","description":"%s","personality":"%s","scenario":"%s","first_mes":"%s","mes_example":"%s","creator_notes":"%s","system_prompt":"","post_history_instructions":"","alternate_greetings":[],"tags":["a15"],"creator":"a15","character_version":"1.0","extensions":{"talkativeness":"0.5","fav":false,"world":""}}}`
	base := fmt.Sprintf(document, "", "", "", "", "", "")
	remaining := target - len(base)
	if remaining < 0 {
		remaining = 0
	}
	pad := func(size int) string {
		if size <= 0 {
			return ""
		}
		return strings.Repeat("A", size)
	}
	share := remaining / 6
	return []byte(fmt.Sprintf(document, pad(share), pad(share), pad(share), pad(share), pad(share), pad(remaining-share*5)))
}

func settingsDocument(directory string, index, target int) []byte {
	base := fmt.Sprintf(`{"name":"%s %03d","temperature":1,"payload":""}`, directory, index)
	remaining := target - len(base)
	if remaining < 0 {
		remaining = 0
	}
	return []byte(fmt.Sprintf(`{"name":"%s %03d","temperature":1,"payload":"%s"}`, directory, index, strings.Repeat("p", remaining)))
}

func worldJSON(index, target int) []byte {
	const document = `{"name":"A15 World %03d","entries":{"0":{"uid":0,"key":["trigger-%03d"],"keysecondary":[],"comment":"","content":"%s","constant":false,"selective":true,"selectiveLogic":0,"addMemo":true,"order":100,"position":0,"disable":false,"excludeRecursion":false,"preventRecursion":false,"delayUntilRecursion":false,"probability":100,"useProbability":true,"depth":4,"group":"","groupOverride":false,"groupWeight":100,"scanDepth":null,"caseSensitive":null,"matchWholeWords":null,"useGroupScoring":null,"automationId":"","role":0,"vectorized":false,"sticky":0,"cooldown":0,"delay":0,"extensions":{}}}}`
	base := fmt.Sprintf(document, index, index, "")
	remaining := target - len(base)
	if remaining < 0 {
		remaining = 0
	}
	return []byte(fmt.Sprintf(document, index, index, strings.Repeat("w", remaining)))
}

// noise returns n deterministic pseudo-random bytes from xorshift64*, so the stream cannot change with a
// stdlib version.
func noise(seed uint64, n int) []byte {
	out := make([]byte, n)
	state := seed
	for index := range out {
		state ^= state >> 12
		state ^= state << 25
		state ^= state >> 27
		out[index] = byte((state * 2685821657736338717) >> 33)
	}
	return out
}

func imageIndexEven(index int) bool { return index%2 == 0 }
