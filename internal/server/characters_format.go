package server

// Spec V1/V2/V3 character transformations from src/endpoints/characters.js.

import (
	"errors"
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
)

// jsTruthy mirrors JavaScript truthiness for JSON-decoded values.
func jsTruthy(value orderedNodeJSON) bool {
	switch value.kind {
	case nodeUndefinedKind, 'n':
		return false
	case 'b':
		result, _ := value.scalar.(bool)
		return result
	case 's':
		text, _ := value.scalar.(string)
		return text != ""
	case 'v':
		number, _ := value.scalar.(float64)
		return number != 0 && !math.IsNaN(number)
	case 'h':
		return true
	default:
		return true
	}
}

// jsNumber mirrors JavaScript's Number(value); the boolean result reports
// whether the conversion produced a number (false means NaN).
func jsNumber(value orderedNodeJSON) (float64, bool) {
	switch value.kind {
	case nodeUndefinedKind:
		return math.NaN(), false
	case 'n':
		return 0, true
	case 'b':
		if result, _ := value.scalar.(bool); result {
			return 1, true
		}
		return 0, true
	case 'v':
		number, _ := value.scalar.(float64)
		return number, !math.IsNaN(number)
	case 's':
		text, _ := value.scalar.(string)
		trimmed := strings.TrimSpace(text)
		if trimmed == "" {
			return 0, true
		}
		number, err := strconv.ParseFloat(trimmed, 64)
		if err != nil {
			return math.NaN(), false
		}
		return number, true
	case 'a':
		if len(value.array) == 0 {
			return 0, true
		}
		if len(value.array) == 1 {
			return jsNumber(value.array[0])
		}
		return math.NaN(), false
	default:
		return math.NaN(), false
	}
}

// jsLooseEqualsTrueString mirrors `value == 'true'`.
func jsLooseEqualsTrueString(value orderedNodeJSON) bool {
	text, ok := value.stringValue()
	return ok && text == "true"
}

func jsOrString(value orderedNodeJSON, fallback string) orderedNodeJSON {
	if jsTruthy(value) {
		return value
	}
	return nodeString(fallback)
}

// nodeNullish returns the fallback only when the value is undefined or null,
// mirroring JavaScript's `??`.
func nodeNullish(value, fallback orderedNodeJSON) orderedNodeJSON {
	if value.kind == nodeUndefinedKind || value.kind == 'n' {
		return fallback
	}
	return value
}

// getCharaCardV2 mirrors pinned getCharaCardV2.
func getCharaCardV2(jsonObject orderedNodeJSON, directories map[string]string, hoistDate bool) orderedNodeJSON {
	if _, exists := jsonObject.member("spec"); !exists {
		jsonObject = convertToV2(jsonObject, directories)
		if hoistDate && !jsTruthy(nodeGet(jsonObject, "create_date")) {
			nodeSet(&jsonObject, []string{"create_date"}, nodeString(time.Now().UTC().Format("2006-01-02T15:04:05.000Z")))
		}
		return jsonObject
	}
	return readFromV2(jsonObject)
}

// readFromV2 mirrors pinned readFromV2, including the upstream bug where a
// missing Spec V2 extension value is first defaulted and then overwritten with
// undefined, which removes the member from JSON.stringify output.
func readFromV2(char orderedNodeJSON) orderedNodeJSON {
	if _, exists := char.member("data"); !exists {
		return char
	}
	nodeUnset(&char, "json_data")

	fieldMappings := []struct {
		charField string
		v2Path    []string
	}{
		{"name", []string{"name"}},
		{"description", []string{"description"}},
		{"personality", []string{"personality"}},
		{"scenario", []string{"scenario"}},
		{"first_mes", []string{"first_mes"}},
		{"mes_example", []string{"mes_example"}},
		{"talkativeness", []string{"extensions", "talkativeness"}},
		{"fav", []string{"extensions", "fav"}},
		{"tags", []string{"tags"}},
	}
	for _, mapping := range fieldMappings {
		v2Value := nodeGet(nodeGet(char, "data"), mapping.v2Path...)
		if v2Value.isUndefined() {
			switch {
			case len(mapping.v2Path) == 2 && mapping.v2Path[0] == "extensions" && mapping.v2Path[1] == "talkativeness":
				nodeSet(&char, []string{mapping.charField}, nodeNumber(0.5))
			case len(mapping.v2Path) == 2 && mapping.v2Path[0] == "extensions" && mapping.v2Path[1] == "fav":
				nodeSet(&char, []string{mapping.charField}, nodeBool(false))
			default:
				continue
			}
		}
		nodeSet(&char, []string{mapping.charField}, v2Value)
	}

	if chat, exists := char.member("chat"); !exists || chat.kind == 'n' || chat.kind == nodeUndefinedKind {
		nodeSet(&char, []string{"chat"}, nodeString(characterDefaultChat(nodeGet(char, "name"))+" - "+humanizedDateTime(time.Now())))
	}
	return char
}

// characterDefaultChat mirrors the `${char.name} - ${humanizedDateTime()}`
// template, where a missing name interpolates as "undefined".
func characterDefaultChat(name orderedNodeJSON) string {
	text, err := characterString(name)
	if err != nil {
		return "undefined"
	}
	return text
}

// convertToV2 mirrors pinned convertToV2.
func convertToV2(char orderedNodeJSON, directories map[string]string) orderedNodeJSON {
	encoded, err := marshalCharacterJSON(char)
	if err != nil {
		encoded = []byte("{}")
	}
	data := nodeObject()
	data.setMember("json_data", nodeString(string(encoded)))
	data.setMember("ch_name", nodeGet(char, "name"))
	data.setMember("description", nodeGet(char, "description"))
	data.setMember("personality", nodeGet(char, "personality"))
	data.setMember("scenario", nodeGet(char, "scenario"))
	data.setMember("first_mes", nodeGet(char, "first_mes"))
	data.setMember("mes_example", nodeGet(char, "mes_example"))
	data.setMember("creator_notes", nodeGet(char, "creatorcomment"))
	data.setMember("talkativeness", nodeGet(char, "talkativeness"))
	data.setMember("fav", nodeGet(char, "fav"))
	data.setMember("creator", nodeGet(char, "creator"))
	data.setMember("tags", nodeGet(char, "tags"))
	data.setMember("depth_prompt_prompt", nodeGet(char, "depth_prompt_prompt"))
	data.setMember("depth_prompt_depth", nodeGet(char, "depth_prompt_depth"))
	data.setMember("depth_prompt_role", nodeGet(char, "depth_prompt_role"))

	result := charaFormatData(data, directories)
	if chat, exists := char.member("chat"); !exists || chat.kind == 'n' || chat.kind == nodeUndefinedKind {
		nodeSet(&result, []string{"chat"}, nodeString(characterDefaultChat(nodeGet(char, "name"))+" - "+humanizedDateTime(time.Now())))
	} else {
		nodeSet(&result, []string{"chat"}, chat)
	}
	nodeSet(&result, []string{"create_date"}, nodeGet(char, "create_date"))
	return result
}

// charaFormatData mirrors pinned charaFormatData.
func charaFormatData(data orderedNodeJSON, directories map[string]string) orderedNodeJSON {
	char := nodeObject()
	if raw, ok := nodeGet(data, "json_data").stringValue(); ok {
		if parsed, err := decodeOrderedNodeJSON([]byte(raw)); err == nil && parsed.kind == 'o' {
			char = parsed
		}
	}
	nodeUnset(&char, "json_data")

	alternateGreetings := nodeArray()
	switch greetings := nodeGet(data, "alternate_greetings"); {
	case greetings.kind == 'a':
		alternateGreetings = greetings
	case greetings.kind == 's':
		alternateGreetings = nodeArray(greetings)
	}

	tags := nodeArray()
	if rawTags := nodeGet(data, "tags"); rawTags.kind == 's' {
		text, _ := rawTags.stringValue()
		items := make([]orderedNodeJSON, 0, 4)
		for _, part := range strings.Split(text, ",") {
			trimmed := strings.TrimSpace(part)
			if trimmed == "" {
				continue
			}
			items = append(items, nodeString(trimmed))
		}
		tags = nodeArray(items...)
	} else if jsTruthy(rawTags) {
		tags = rawTags
	}

	talkativeness := nodeGet(data, "talkativeness")
	if !jsTruthy(talkativeness) {
		talkativeness = nodeNumber(0.5)
	}

	nodeSet(&char, []string{"name"}, nodeGet(data, "ch_name"))
	nodeSet(&char, []string{"description"}, jsOrString(nodeGet(data, "description"), ""))
	nodeSet(&char, []string{"personality"}, jsOrString(nodeGet(data, "personality"), ""))
	nodeSet(&char, []string{"scenario"}, jsOrString(nodeGet(data, "scenario"), ""))
	nodeSet(&char, []string{"first_mes"}, jsOrString(nodeGet(data, "first_mes"), ""))
	nodeSet(&char, []string{"mes_example"}, jsOrString(nodeGet(data, "mes_example"), ""))
	nodeSet(&char, []string{"creatorcomment"}, jsOrString(nodeGet(data, "creator_notes"), ""))
	nodeSet(&char, []string{"avatar"}, nodeString("none"))
	chatName, err := characterString(nodeGet(data, "ch_name"))
	if err != nil {
		chatName = "undefined"
	}
	nodeSet(&char, []string{"chat"}, nodeString(chatName+" - "+humanizedDateTime(time.Now())))
	nodeSet(&char, []string{"talkativeness"}, talkativeness)
	nodeSet(&char, []string{"fav"}, nodeBool(jsLooseEqualsTrueString(nodeGet(data, "fav"))))
	nodeSet(&char, []string{"tags"}, tags)

	nodeSet(&char, []string{"spec"}, nodeString("chara_card_v2"))
	nodeSet(&char, []string{"spec_version"}, nodeString("2.0"))
	nodeSet(&char, []string{"data", "name"}, nodeGet(data, "ch_name"))
	nodeSet(&char, []string{"data", "description"}, jsOrString(nodeGet(data, "description"), ""))
	nodeSet(&char, []string{"data", "personality"}, jsOrString(nodeGet(data, "personality"), ""))
	nodeSet(&char, []string{"data", "scenario"}, jsOrString(nodeGet(data, "scenario"), ""))
	nodeSet(&char, []string{"data", "first_mes"}, jsOrString(nodeGet(data, "first_mes"), ""))
	nodeSet(&char, []string{"data", "mes_example"}, jsOrString(nodeGet(data, "mes_example"), ""))
	nodeSet(&char, []string{"data", "creator_notes"}, jsOrString(nodeGet(data, "creator_notes"), ""))
	nodeSet(&char, []string{"data", "system_prompt"}, jsOrString(nodeGet(data, "system_prompt"), ""))
	nodeSet(&char, []string{"data", "post_history_instructions"}, jsOrString(nodeGet(data, "post_history_instructions"), ""))
	nodeSet(&char, []string{"data", "tags"}, tags)
	nodeSet(&char, []string{"data", "creator"}, jsOrString(nodeGet(data, "creator"), ""))
	nodeSet(&char, []string{"data", "character_version"}, jsOrString(nodeGet(data, "character_version"), ""))
	nodeSet(&char, []string{"data", "alternate_greetings"}, alternateGreetings)

	nodeSet(&char, []string{"data", "extensions", "talkativeness"}, talkativeness)
	nodeSet(&char, []string{"data", "extensions", "fav"}, nodeBool(jsLooseEqualsTrueString(nodeGet(data, "fav"))))
	nodeSet(&char, []string{"data", "extensions", "world"}, jsOrString(nodeGet(data, "world"), ""))

	depthValue := nodeNumber(4)
	if number, ok := jsNumber(nodeGet(data, "depth_prompt_depth")); ok {
		depthValue = nodeNumber(number)
	}
	nodeSet(&char, []string{"data", "extensions", "depth_prompt", "prompt"}, nodeNullish(nodeGet(data, "depth_prompt_prompt"), nodeString("")))
	nodeSet(&char, []string{"data", "extensions", "depth_prompt", "depth"}, depthValue)
	nodeSet(&char, []string{"data", "extensions", "depth_prompt", "role"}, nodeNullish(nodeGet(data, "depth_prompt_role"), nodeString("system")))

	if world, ok := nodeGet(data, "world").stringValue(); ok && jsTruthy(nodeGet(data, "world")) {
		if file, err := readWorldInfoFile(directories, world); err == nil && file != nil {
			if originalData, exists := file.member("originalData"); exists && jsTruthy(originalData) {
				nodeSet(&char, []string{"data", "character_book"}, originalData)
			}
			if entries, exists := file.member("entries"); exists && jsTruthy(entries) {
				nodeSet(&char, []string{"data", "character_book"}, convertWorldInfoToCharacterBook(world, entries))
			}
		}
	}

	if extensions, ok := nodeGet(data, "extensions").stringValue(); ok {
		if parsed, err := decodeOrderedNodeJSON([]byte(extensions)); err == nil {
			merged := deepMerge(nodeGet(char, "data", "extensions"), parsed)
			nodeSet(&char, []string{"data", "extensions"}, merged)
		}
	}

	return char
}

// readWorldInfoFile mirrors pinned readWorldInfoFile with allowDummy=false.
func readWorldInfoFile(directories map[string]string, worldInfoName string) (*orderedNodeJSON, error) {
	if worldInfoName == "" {
		return nil, nil
	}
	filename := startup.SanitizeUserFilename(worldInfoName + ".json")
	pathToWorldInfo := filepath.Join(directories["worlds"], filename)
	contents, err := os.ReadFile(pathToWorldInfo)
	if err != nil {
		return nil, err
	}
	parsed, err := decodeOrderedNodeJSON(contents)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

// convertWorldInfoToCharacterBook mirrors pinned convertWorldInfoToCharacterBook.
func convertWorldInfoToCharacterBook(name string, entries orderedNodeJSON) orderedNodeJSON {
	result := nodeObject()
	result.setMember("entries", nodeArray())
	result.setMember("name", nodeString(name))
	converted := make([]orderedNodeJSON, 0)
	if entries.kind == 'o' {
		ordered, _ := entries.entries()
		for _, item := range ordered {
			converted = append(converted, characterBookEntry(item.value))
		}
	}
	nodeSet(&result, []string{"entries"}, nodeArray(converted...))
	return result
}

func characterBookEntry(entry orderedNodeJSON) orderedNodeJSON {
	original := nodeObject()
	original.setMember("id", nodeGet(entry, "uid"))
	original.setMember("keys", nodeGet(entry, "key"))
	original.setMember("secondary_keys", nodeGet(entry, "keysecondary"))
	original.setMember("comment", nodeGet(entry, "comment"))
	original.setMember("content", nodeGet(entry, "content"))
	original.setMember("constant", nodeGet(entry, "constant"))
	original.setMember("selective", nodeGet(entry, "selective"))
	original.setMember("insertion_order", nodeGet(entry, "order"))
	original.setMember("enabled", nodeNot(jsTruthy(nodeGet(entry, "disable"))))
	position := nodeGet(entry, "position")
	beforeCharacter := false
	if position.kind != 'n' && position.kind != nodeUndefinedKind {
		if number, ok := jsNumber(position); ok && number == 0 {
			beforeCharacter = true
		}
	}
	if beforeCharacter {
		original.setMember("position", nodeString("before_char"))
	} else {
		original.setMember("position", nodeString("after_char"))
	}
	original.setMember("use_regex", nodeBool(true))

	extensions := nodeObject()
	if source := nodeGet(entry, "extensions"); source.kind == 'o' {
		extensions = nodeCloneDeep(source)
	}
	extensions.setMember("position", nodeGet(entry, "position"))
	extensions.setMember("exclude_recursion", nodeGet(entry, "excludeRecursion"))
	extensions.setMember("display_index", nodeGet(entry, "displayIndex"))
	extensions.setMember("probability", nodeCoalesce(nodeGet(entry, "probability"), orderedNodeJSON{kind: 'n'}))
	extensions.setMember("useProbability", nodeCoalesce(nodeGet(entry, "useProbability"), nodeBool(false)))
	extensions.setMember("depth", nodeCoalesce(nodeGet(entry, "depth"), nodeNumber(4)))
	extensions.setMember("selectiveLogic", nodeCoalesce(nodeGet(entry, "selectiveLogic"), nodeNumber(0)))
	extensions.setMember("outlet_name", nodeCoalesce(nodeGet(entry, "outletName"), nodeString("")))
	extensions.setMember("group", nodeCoalesce(nodeGet(entry, "group"), nodeString("")))
	extensions.setMember("group_override", nodeCoalesce(nodeGet(entry, "groupOverride"), nodeBool(false)))
	extensions.setMember("group_weight", nodeCoalesce(nodeGet(entry, "groupWeight"), orderedNodeJSON{kind: 'n'}))
	extensions.setMember("prevent_recursion", nodeCoalesce(nodeGet(entry, "preventRecursion"), nodeBool(false)))
	extensions.setMember("delay_until_recursion", nodeCoalesce(nodeGet(entry, "delayUntilRecursion"), nodeBool(false)))
	extensions.setMember("scan_depth", nodeCoalesce(nodeGet(entry, "scanDepth"), orderedNodeJSON{kind: 'n'}))
	extensions.setMember("match_whole_words", nodeCoalesce(nodeGet(entry, "matchWholeWords"), orderedNodeJSON{kind: 'n'}))
	extensions.setMember("use_group_scoring", nodeCoalesce(nodeGet(entry, "useGroupScoring"), nodeBool(false)))
	extensions.setMember("case_sensitive", nodeCoalesce(nodeGet(entry, "caseSensitive"), orderedNodeJSON{kind: 'n'}))
	extensions.setMember("automation_id", nodeCoalesce(nodeGet(entry, "automationId"), nodeString("")))
	extensions.setMember("role", nodeCoalesce(nodeGet(entry, "role"), nodeNumber(0)))
	extensions.setMember("vectorized", nodeCoalesce(nodeGet(entry, "vectorized"), nodeBool(false)))
	extensions.setMember("sticky", nodeCoalesce(nodeGet(entry, "sticky"), orderedNodeJSON{kind: 'n'}))
	extensions.setMember("cooldown", nodeCoalesce(nodeGet(entry, "cooldown"), orderedNodeJSON{kind: 'n'}))
	extensions.setMember("delay", nodeCoalesce(nodeGet(entry, "delay"), orderedNodeJSON{kind: 'n'}))
	extensions.setMember("match_persona_description", nodeCoalesce(nodeGet(entry, "matchPersonaDescription"), nodeBool(false)))
	extensions.setMember("match_character_description", nodeCoalesce(nodeGet(entry, "matchCharacterDescription"), nodeBool(false)))
	extensions.setMember("match_character_personality", nodeCoalesce(nodeGet(entry, "matchCharacterPersonality"), nodeBool(false)))
	extensions.setMember("match_character_depth_prompt", nodeCoalesce(nodeGet(entry, "matchCharacterDepthPrompt"), nodeBool(false)))
	extensions.setMember("match_scenario", nodeCoalesce(nodeGet(entry, "matchScenario"), nodeBool(false)))
	extensions.setMember("match_creator_notes", nodeCoalesce(nodeGet(entry, "matchCreatorNotes"), nodeBool(false)))
	extensions.setMember("triggers", nodeCoalesce(nodeGet(entry, "triggers"), nodeArray()))
	extensions.setMember("ignore_budget", nodeCoalesce(nodeGet(entry, "ignoreBudget"), nodeBool(false)))
	original.setMember("extensions", extensions)
	return original
}

func nodeNot(value bool) orderedNodeJSON { return nodeBool(!value) }

// nodeCoalesce mirrors JavaScript's `??`.
func nodeCoalesce(value, fallback orderedNodeJSON) orderedNodeJSON {
	return nodeNullish(value, fallback)
}

// getPngName mirrors pinned getPngName, including sanitize-filename's
// TypeError for non-string input and the 10000-try unique-name search.
func getPngName(file orderedNodeJSON, directories map[string]string) (string, error) {
	name, ok := file.stringValue()
	if !ok {
		// sanitize-filename throws `new Error('Input must be string')`.
		return "", errors.New("Input must be string")
	}
	base := startup.SanitizeUserFilename(name)
	for index := 0; index < 10000; index++ {
		candidate := base
		if index > 0 {
			candidate = base + strconv.Itoa(index)
		}
		if _, err := os.Stat(filepath.Join(directories["characters"], candidate+".png")); err != nil {
			return candidate, nil
		}
	}
	return base, nil
}
