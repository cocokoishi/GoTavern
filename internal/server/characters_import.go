package server

// Pinned POST /api/characters/import.
//
// The pinned route dispatches on request.body.file_type. YAML, JSON and PNG
// cards are reproduced here. CharX (ZIP) and BYAF archives are not implemented
// yet and fall through to the pinned `{ error: true }` failure response, which
// is recorded as a known gap in docs/compat-matrix.md.

import (
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/cocokoishi/gotavern/internal/startup"
	"gopkg.in/yaml.v3"
)

func (runtime *accountRuntime) serveCharactersImport(w http.ResponseWriter, request *http.Request) {
	account, ok := runtime.settingsRequestAccount(w, request)
	if !ok {
		return
	}
	parsed, err := runtime.readCharactersRequest(request)
	if err != nil {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if parsed.stagedPath == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	defer removeStagedCharacterUpload(parsed.stagedPath)
	directories, ok := runtime.charactersDirectories(account)
	if !ok {
		serveStatusText(w, http.StatusInternalServerError)
		return
	}
	body := parsed.body
	format, _ := nodeGet(body, "file_type").stringValue()
	preservedFileName := ""
	if preserved, isString := nodeGet(body, "preserved_name").stringValue(); isString && preserved != "" {
		preservedFileName = strings.TrimSuffix(filepath.Base(preserved), nodePathExt(filepath.Base(preserved)))
	}

	fileName := ""
	importFailed := false
	switch format {
	case "yaml", "yml":
		fileName, importFailed = runtime.importFromYaml(parsed.stagedPath, preservedFileName, directories, account)
	case "json":
		fileName, importFailed = runtime.importFromJson(parsed.stagedPath, preservedFileName, directories, account)
	case "png":
		fileName, importFailed = runtime.importFromPng(parsed.stagedPath, preservedFileName, directories, account)
	default:
		// Unsupported or unimplemented formats take the pinned catch branch.
		importFailed = true
	}
	if importFailed {
		respondCharacterJSON(w, http.StatusOK, errorTrueObject())
		return
	}
	if fileName == "" {
		serveStatusText(w, http.StatusBadRequest)
		return
	}
	if preservedFileName != "" {
		invalidateCharacterThumbnail(directories, preservedFileName+".png")
	}
	response := nodeObject()
	response.setMember("file_name", nodeString(fileName))
	respondCharacterJSON(w, http.StatusOK, response)
}

// invalidateCharacterThumbnail mirrors pinned invalidateThumbnail for the
// 'avatar' type.
func invalidateCharacterThumbnail(directories map[string]string, file string) {
	thumbnail := filepath.Join(directories["thumbnailsAvatar"], startup.SanitizeUserFilename(file))
	if _, err := os.Stat(thumbnail); err == nil {
		_ = os.Remove(thumbnail)
	}
}

func (runtime *accountRuntime) importFromYaml(uploadPath, preservedFileName string, directories map[string]string, account *storedAccount) (string, bool) {
	fileText, err := os.ReadFile(uploadPath)
	if err != nil {
		return "", true
	}
	removeStagedCharacterUpload(uploadPath)
	document, err := parseYamlDocument(string(fileText))
	if err != nil || document.kind != 'o' {
		return "", true
	}
	nameValue := nodeGet(document, "name")
	name, err := sanitizeCharacterName(nameValue)
	if err != nil {
		return "", true
	}
	nodeSet(&document, []string{"name"}, nodeString(name))
	fileName := preservedFileName
	if fileName == "" {
		fileName, err = getPngName(nodeString(name), directories)
		if err != nil {
			return "", true
		}
	}
	source := nodeObject()
	source.setMember("name", nodeString(name))
	source.setMember("description", nodeNullish(nodeGet(document, "context"), nodeString("")))
	source.setMember("first_mes", nodeNullish(nodeGet(document, "greeting"), nodeString("")))
	source.setMember("create_date", nodeString(time.Now().UTC().Format("2006-01-02T15:04:05.000Z")))
	source.setMember("chat", nodeString(name+" - "+humanizedDateTime(time.Now())))
	source.setMember("personality", nodeString(""))
	source.setMember("creatorcomment", nodeString(""))
	source.setMember("avatar", nodeString("none"))
	source.setMember("mes_example", nodeString(""))
	source.setMember("scenario", nodeString(""))
	source.setMember("talkativeness", nodeNumber(0.5))
	source.setMember("creator", nodeString(""))
	source.setMember("tags", nodeString(""))

	char := convertToV2(source, directories)
	encoded, err := marshalCharacterJSON(char)
	if err != nil {
		return "", true
	}
	if err := writeCharacterCard(runtime.options.DataRoot, account.string("handle"), fileName, defaultAvatarBytes(), string(encoded)); err != nil {
		return "", true
	}
	return fileName, false
}

func (runtime *accountRuntime) importFromJson(uploadPath, preservedFileName string, directories map[string]string, account *storedAccount) (string, bool) {
	fileText, err := os.ReadFile(uploadPath)
	if err != nil {
		return "", true
	}
	removeStagedCharacterUpload(uploadPath)
	jsonData, err := decodeOrderedNodeJSON(fileText)
	if err != nil {
		return "", true
	}
	if jsonData.kind != 'o' {
		return "", true
	}

	if _, exists := jsonData.member("spec"); exists {
		unsetPrivateFields(&jsonData)
		if nameValue, hasName := jsonData.member("data"); hasName {
			if cardName, ok := nameValue.member("name"); ok {
				if text, isString := cardName.stringValue(); isString {
					nodeSet(&jsonData, []string{"data", "name"}, nodeString(startup.SanitizeUserFilename(text)))
				}
			}
		}
		dataName := nodeGet(jsonData, "data", "name")
		fallback := nodeGet(jsonData, "name")
		target := dataName
		if !jsTruthy(target) {
			target = fallback
		}
		name, err := sanitizeCharacterName(target)
		if err != nil {
			return "", true
		}
		nodeSet(&jsonData, []string{"name"}, nodeString(name))
		jsonData = readFromV2(jsonData)
		nodeSet(&jsonData, []string{"create_date"}, nodeString(time.Now().UTC().Format("2006-01-02T15:04:05.000Z")))
		fileName := preservedFileName
		if fileName == "" {
			fileName, err = getPngName(nodeString(name), directories)
			if err != nil {
				return "", true
			}
		}
		encoded, err := marshalCharacterJSON(jsonData)
		if err != nil {
			return "", true
		}
		if err := writeCharacterCard(runtime.options.DataRoot, account.string("handle"), fileName, defaultAvatarBytes(), string(encoded)); err != nil {
			return "", true
		}
		return fileName, false
	}

	if nameValue, exists := jsonData.member("name"); exists {
		name, err := sanitizeCharacterName(nameValue)
		if err != nil {
			return "", true
		}
		nodeSet(&jsonData, []string{"name"}, nodeString(name))
		if creatorNotes, isString := nodeGet(jsonData, "creator_notes").stringValue(); isString {
			nodeSet(&jsonData, []string{"creator_notes"}, nodeString(strings.Replace(creatorNotes, "Creator's notes go here.", "", 1)))
		}
		fileName := preservedFileName
		if fileName == "" {
			fileName, err = getPngName(nodeString(name), directories)
			if err != nil {
				return "", true
			}
		}
		source := nodeObject()
		source.setMember("name", nodeString(name))
		source.setMember("description", nodeNullish(nodeGet(jsonData, "description"), nodeString("")))
		creatorComment := nodeGet(jsonData, "creatorcomment")
		if creatorComment.isUndefined() || creatorComment.kind == 'n' {
			creatorComment = nodeNullish(nodeGet(jsonData, "creator_notes"), nodeString(""))
		}
		source.setMember("creatorcomment", creatorComment)
		source.setMember("personality", nodeNullish(nodeGet(jsonData, "personality"), nodeString("")))
		source.setMember("first_mes", nodeNullish(nodeGet(jsonData, "first_mes"), nodeString("")))
		source.setMember("avatar", nodeString("none"))
		source.setMember("chat", nodeString(name+" - "+humanizedDateTime(time.Now())))
		source.setMember("mes_example", nodeNullish(nodeGet(jsonData, "mes_example"), nodeString("")))
		source.setMember("scenario", nodeNullish(nodeGet(jsonData, "scenario"), nodeString("")))
		source.setMember("create_date", nodeString(time.Now().UTC().Format("2006-01-02T15:04:05.000Z")))
		talkativeness := nodeGet(jsonData, "talkativeness")
		if talkativeness.isUndefined() || talkativeness.kind == 'n' {
			talkativeness = nodeNumber(0.5)
		}
		source.setMember("talkativeness", talkativeness)
		source.setMember("creator", nodeNullish(nodeGet(jsonData, "creator"), nodeString("")))
		source.setMember("tags", nodeNullish(nodeGet(jsonData, "tags"), nodeString("")))
		char := convertToV2(source, directories)
		encoded, err := marshalCharacterJSON(char)
		if err != nil {
			return "", true
		}
		if err := writeCharacterCard(runtime.options.DataRoot, account.string("handle"), fileName, defaultAvatarBytes(), string(encoded)); err != nil {
			return "", true
		}
		return fileName, false
	}

	if nameValue, exists := jsonData.member("char_name"); exists {
		name, err := sanitizeCharacterName(nameValue)
		if err != nil {
			return "", true
		}
		nodeSet(&jsonData, []string{"char_name"}, nodeString(name))
		if creatorNotes, isString := nodeGet(jsonData, "creator_notes").stringValue(); isString {
			nodeSet(&jsonData, []string{"creator_notes"}, nodeString(strings.Replace(creatorNotes, "Creator's notes go here.", "", 1)))
		}
		fileName := preservedFileName
		if fileName == "" {
			fileName, err = getPngName(nodeString(name), directories)
			if err != nil {
				return "", true
			}
		}
		source := nodeObject()
		source.setMember("name", nodeString(name))
		source.setMember("description", nodeNullish(nodeGet(jsonData, "char_persona"), nodeString("")))
		creatorComment := nodeGet(jsonData, "creatorcomment")
		if creatorComment.isUndefined() || creatorComment.kind == 'n' {
			creatorComment = nodeNullish(nodeGet(jsonData, "creator_notes"), nodeString(""))
		}
		source.setMember("creatorcomment", creatorComment)
		source.setMember("personality", nodeString(""))
		source.setMember("first_mes", nodeNullish(nodeGet(jsonData, "char_greeting"), nodeString("")))
		source.setMember("avatar", nodeString("none"))
		source.setMember("chat", nodeString(jsTemplateString(nodeGet(jsonData, "name"))+" - "+humanizedDateTime(time.Now())))
		source.setMember("mes_example", nodeNullish(nodeGet(jsonData, "example_dialogue"), nodeString("")))
		source.setMember("scenario", nodeNullish(nodeGet(jsonData, "world_scenario"), nodeString("")))
		source.setMember("create_date", nodeString(time.Now().UTC().Format("2006-01-02T15:04:05.000Z")))
		talkativeness := nodeGet(jsonData, "talkativeness")
		if talkativeness.isUndefined() || talkativeness.kind == 'n' {
			talkativeness = nodeNumber(0.5)
		}
		source.setMember("talkativeness", talkativeness)
		source.setMember("creator", nodeNullish(nodeGet(jsonData, "creator"), nodeString("")))
		source.setMember("tags", nodeNullish(nodeGet(jsonData, "tags"), nodeString("")))
		char := convertToV2(source, directories)
		encoded, err := marshalCharacterJSON(char)
		if err != nil {
			return "", true
		}
		if err := writeCharacterCard(runtime.options.DataRoot, account.string("handle"), fileName, defaultAvatarBytes(), string(encoded)); err != nil {
			return "", true
		}
		return fileName, false
	}

	return "", false
}

func (runtime *accountRuntime) importFromPng(uploadPath, preservedFileName string, directories map[string]string, account *storedAccount) (string, bool) {
	imgData, ok := readCharacterData(uploadPath)
	if !ok {
		return "", true
	}
	jsonData, err := decodeOrderedNodeJSON([]byte(imgData))
	if err != nil || jsonData.kind != 'o' {
		return "", true
	}
	if data, exists := jsonData.member("data"); exists && data.kind == 'o' {
		if cardName, ok := data.member("name"); ok {
			if text, isString := cardName.stringValue(); isString {
				nodeSet(&jsonData, []string{"data", "name"}, nodeString(startup.SanitizeUserFilename(text)))
			}
		}
	}
	dataName := nodeGet(jsonData, "data", "name")
	target := dataName
	if !jsTruthy(target) {
		target = nodeGet(jsonData, "name")
	}
	name, err := sanitizeCharacterName(target)
	if err != nil {
		return "", true
	}
	nodeSet(&jsonData, []string{"name"}, nodeString(name))
	fileName := preservedFileName
	if fileName == "" {
		fileName, err = getPngName(nodeString(name), directories)
		if err != nil {
			return "", true
		}
	}

	if _, exists := jsonData.member("spec"); exists {
		unsetPrivateFields(&jsonData)
		jsonData = readFromV2(jsonData)
		nodeSet(&jsonData, []string{"create_date"}, nodeString(time.Now().UTC().Format("2006-01-02T15:04:05.000Z")))
		encoded, err := marshalCharacterJSON(jsonData)
		if err != nil {
			return "", true
		}
		if err := writeCharacterCard(runtime.options.DataRoot, account.string("handle"), fileName, cardImageBytes(uploadPath, nil), string(encoded)); err != nil {
			return "", true
		}
		removeStagedCharacterUpload(uploadPath)
		return fileName, false
	}

	if _, exists := jsonData.member("name"); exists {
		if creatorNotes, isString := nodeGet(jsonData, "creator_notes").stringValue(); isString {
			nodeSet(&jsonData, []string{"creator_notes"}, nodeString(strings.Replace(creatorNotes, "Creator's notes go here.", "", 1)))
		}
		source := nodeObject()
		source.setMember("name", nodeString(name))
		source.setMember("description", nodeNullish(nodeGet(jsonData, "description"), nodeString("")))
		creatorComment := nodeGet(jsonData, "creatorcomment")
		if creatorComment.isUndefined() || creatorComment.kind == 'n' {
			creatorComment = nodeNullish(nodeGet(jsonData, "creator_notes"), nodeString(""))
		}
		source.setMember("creatorcomment", creatorComment)
		source.setMember("personality", nodeNullish(nodeGet(jsonData, "personality"), nodeString("")))
		source.setMember("first_mes", nodeNullish(nodeGet(jsonData, "first_mes"), nodeString("")))
		source.setMember("avatar", nodeString("none"))
		source.setMember("chat", nodeString(name+" - "+humanizedDateTime(time.Now())))
		source.setMember("mes_example", nodeNullish(nodeGet(jsonData, "mes_example"), nodeString("")))
		source.setMember("scenario", nodeNullish(nodeGet(jsonData, "scenario"), nodeString("")))
		source.setMember("create_date", nodeString(time.Now().UTC().Format("2006-01-02T15:04:05.000Z")))
		talkativeness := nodeGet(jsonData, "talkativeness")
		if talkativeness.isUndefined() || talkativeness.kind == 'n' {
			talkativeness = nodeNumber(0.5)
		}
		source.setMember("talkativeness", talkativeness)
		source.setMember("creator", nodeNullish(nodeGet(jsonData, "creator"), nodeString("")))
		source.setMember("tags", nodeNullish(nodeGet(jsonData, "tags"), nodeString("")))
		char := convertToV2(source, directories)
		encoded, err := marshalCharacterJSON(char)
		if err != nil {
			return "", true
		}
		if err := writeCharacterCard(runtime.options.DataRoot, account.string("handle"), fileName, cardImageBytes(uploadPath, nil), string(encoded)); err != nil {
			return "", true
		}
		removeStagedCharacterUpload(uploadPath)
		return fileName, false
	}

	return "", false
}

// parseYamlDocument converts a YAML document into the ordered JSON value model.
func parseYamlDocument(text string) (orderedNodeJSON, error) {
	var root yaml.Node
	if err := yaml.Unmarshal([]byte(text), &root); err != nil {
		return orderedNodeJSON{}, err
	}
	return yamlNodeToOrderedJSON(&root)
}

func yamlNodeToOrderedJSON(node *yaml.Node) (orderedNodeJSON, error) {
	switch node.Kind {
	case yaml.DocumentNode:
		if len(node.Content) == 0 {
			return orderedNodeJSON{kind: 'n'}, nil
		}
		return yamlNodeToOrderedJSON(node.Content[0])
	case yaml.MappingNode:
		result := nodeObject()
		for index := 0; index+1 < len(node.Content); index += 2 {
			key := node.Content[index].Value
			value, err := yamlNodeToOrderedJSON(node.Content[index+1])
			if err != nil {
				return orderedNodeJSON{}, err
			}
			result.setMember(key, value)
		}
		return result, nil
	case yaml.SequenceNode:
		items := make([]orderedNodeJSON, 0, len(node.Content))
		for _, child := range node.Content {
			value, err := yamlNodeToOrderedJSON(child)
			if err != nil {
				return orderedNodeJSON{}, err
			}
			items = append(items, value)
		}
		return nodeArray(items...), nil
	case yaml.AliasNode:
		return yamlNodeToOrderedJSON(node.Alias)
	case yaml.ScalarNode:
		switch node.Tag {
		case "!!null":
			return orderedNodeJSON{kind: 'n'}, nil
		case "!!bool":
			return nodeBool(strings.EqualFold(node.Value, "true") || node.Value == "yes" || node.Value == "on"), nil
		case "!!int", "!!float":
			number, ok := jsNumber(nodeString(node.Value))
			if !ok {
				return nodeString(node.Value), nil
			}
			return nodeNumber(number), nil
		default:
			return nodeString(node.Value), nil
		}
	default:
		return orderedNodeJSON{kind: 'n'}, nil
	}
}

var _ = strconv.Itoa
