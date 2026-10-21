package server

// chat-completions backend routes: /bias and /process, from
// src/endpoints/backends/chat-completions.js:2158 and :2979.
//
// /bias maps request-body token strings (or explicit token-id arrays) through the same tokenizer
// family dispatch the tokenizer domain already implements, and answers an object keyed by token id
// (integer-like keys serialized in ascending numeric order by JSON.stringify).
//
// /process is prompt-converters.js postProcessPrompt: merge consecutive same-role messages, apply
// example/name prefixes, optionally keep tool messages, or collapse everything into one user
// message, with the strict-mode system-message rewrite and placeholder insertion.
//
// The placeholder is the effective pinned default "[Start a new chat]" (default/config.yaml:324,
// merged into the runtime config at startup). A user-configured promptPlaceholder is not projected
// into HTTPHandlerOptions; that is a documented gap.

import (
	"crypto/rand"
	"encoding/base64"
	"net/http"

	"github.com/cocokoishi/gotavern/internal/tokenizers"
)

// backendsPromptNames mirrors getPromptNames (prompt-converters.js:49).
type backendsPromptNames struct {
	charName   string
	userName   string
	groupNames []string
}

func backendsPromptNamesFor(body orderedNodeJSON) backendsPromptNames {
	names := backendsPromptNames{}
	if value := sdBodyMember(body, "char_name"); pinnedJSTruthy(value) {
		names.charName = backendsStringMember(value)
	}
	if value := sdBodyMember(body, "user_name"); pinnedJSTruthy(value) {
		names.userName = backendsStringMember(value)
	}
	if groups := sdBodyMember(body, "group_names"); groups.kind == 'a' {
		for _, group := range groups.array {
			names.groupNames = append(names.groupNames, backendsStringMember(group))
		}
	}
	return names
}

func (names backendsPromptNames) startsWithGroupName(content string) bool {
	for _, group := range names.groupNames {
		if len(content) >= len(group)+2 && content[:len(group)] == group && content[len(group):len(group)+2] == ": " {
			return true
		}
	}
	return false
}

// backendsMergeOptions is the options object of mergeMessages.
type backendsMergeOptions struct {
	strict       bool
	placeholders bool
	single       bool
	tools        bool
}

// backendsPostProcessPrompt mirrors postProcessPrompt (prompt-converters.js:85).
func backendsPostProcessPrompt(messages orderedNodeJSON, processingType string, names backendsPromptNames) (orderedNodeJSON, error) {
	switch processingType {
	case "merge", "claude":
		return backendsMergeMessages(messages, names, backendsMergeOptions{})
	case "merge_tools":
		return backendsMergeMessages(messages, names, backendsMergeOptions{tools: true})
	case "semi":
		return backendsMergeMessages(messages, names, backendsMergeOptions{strict: true})
	case "semi_tools":
		return backendsMergeMessages(messages, names, backendsMergeOptions{strict: true, tools: true})
	case "strict":
		return backendsMergeMessages(messages, names, backendsMergeOptions{strict: true, placeholders: true})
	case "strict_tools":
		return backendsMergeMessages(messages, names, backendsMergeOptions{strict: true, placeholders: true, tools: true})
	case "single":
		return backendsMergeMessages(messages, names, backendsMergeOptions{strict: true, single: true})
	default:
		return messages, nil
	}
}

// backendsRandomToken is crypto.randomBytes(32).toString('base64').
func backendsRandomToken() (string, error) {
	buffer := make([]byte, 32)
	if _, err := rand.Read(buffer); err != nil {
		return "", err
	}
	return base64.StdEncoding.EncodeToString(buffer), nil
}

// backendsContentString is the JS string value used by startsWith/prefix checks: a non-string
// content member throws in pinned code, so it reports false.
func backendsContentString(message orderedNodeJSON) (string, bool) {
	content, exists := sdMemberOf(message, "content")
	if !exists {
		return "", false
	}
	return content.stringValue()
}

// backendsMessageMember returns message.<key> for an object message. Non-object messages throw on
// property access in strict-mode JS; the caller reports an error.
func backendsMessageMember(message orderedNodeJSON, key string) (orderedNodeJSON, bool) {
	if message.kind != 'o' {
		return orderedNodeJSON{}, false
	}
	value, exists := message.member(key)
	if !exists {
		return nodeUndefined(), true
	}
	return value, true
}

// backendsMergeMessages mirrors mergeMessages (prompt-converters.js:827).
func backendsMergeMessages(messages orderedNodeJSON, names backendsPromptNames, options backendsMergeOptions) (orderedNodeJSON, error) {
	if messages.kind != 'a' {
		return orderedNodeJSON{}, errBackendsNotArray
	}
	contentTokens := map[string]orderedNodeJSON{}
	for index := range messages.array {
		message := &messages.array[index]
		if message.kind != 'o' {
			// Assigning to a primitive message's content throws in strict mode.
			return orderedNodeJSON{}, errBackendsBadMessage
		}
		content, exists := message.member("content")
		if !exists || !pinnedJSTruthy(content) {
			message.setMember("content", nodeString(""))
			content = nodeString("")
		}
		if content.kind == 'a' {
			parts := make([]string, 0, len(content.array))
			for _, part := range content.array {
				if part.kind != 'o' {
					return orderedNodeJSON{}, errBackendsBadMessage
				}
				partType, _ := backendsMessageMember(part, "type")
				typeText, _ := partType.stringValue()
				switch typeText {
				case "text":
					text, _ := backendsMessageMember(part, "text")
					parts = append(parts, backendsJSJoinString(text))
				case "image_url", "video_url", "audio_url":
					token, err := backendsRandomToken()
					if err != nil {
						return orderedNodeJSON{}, err
					}
					contentTokens[token] = part
					parts = append(parts, token)
				default:
					parts = append(parts, "")
				}
			}
			message.setMember("content", nodeString(joinBackendsParts(parts)))
			content = mustBackendsMember(*message, "content")
		}
		role, _ := backendsMessageMember(*message, "role")
		roleText, _ := role.stringValue()
		name, _ := backendsMessageMember(*message, "name")
		nameText, nameIsString := name.stringValue()
		if roleText == "system" && nameText == "example_assistant" {
			contentText, ok := backendsContentString(*message)
			if !ok {
				return orderedNodeJSON{}, errBackendsBadMessage
			}
			if names.charName != "" && !hasPrefix(contentText, names.charName+": ") && !names.startsWithGroupName(contentText) {
				message.setMember("content", nodeString(names.charName+": "+contentText))
			}
		}
		if roleText == "system" && nameText == "example_user" {
			contentText, ok := backendsContentString(*message)
			if !ok {
				return orderedNodeJSON{}, errBackendsBadMessage
			}
			if names.userName != "" && !hasPrefix(contentText, names.userName+": ") {
				message.setMember("content", nodeString(names.userName+": "+contentText))
			}
		}
		if nameIsString && nameText != "" && roleText != "system" {
			contentText, ok := backendsContentString(*message)
			if !ok {
				return orderedNodeJSON{}, errBackendsBadMessage
			}
			if !hasPrefix(contentText, nameText+": ") {
				message.setMember("content", nodeString(nameText+": "+contentText))
			}
		}
		if roleText == "tool" && !options.tools {
			message.setMember("role", nodeString("user"))
			roleText = "user"
		}
		if options.single {
			contentText, ok := backendsContentString(*message)
			if !ok {
				return orderedNodeJSON{}, errBackendsBadMessage
			}
			if roleText == "assistant" {
				if names.charName != "" && !hasPrefix(contentText, names.charName+": ") && !names.startsWithGroupName(contentText) {
					contentText = names.charName + ": " + contentText
					message.setMember("content", nodeString(contentText))
				}
			}
			if roleText == "user" {
				if names.userName != "" && !hasPrefix(contentText, names.userName+": ") {
					contentText = names.userName + ": " + contentText
					message.setMember("content", nodeString(contentText))
				}
			}
			message.setMember("role", nodeString("user"))
		}
		message.deleteMember("name")
		if !options.tools {
			message.deleteMember("tool_calls")
			message.deleteMember("tool_call_id")
		}
	}

	merged := nodeArray()
	for _, message := range messages.array {
		role, _ := backendsMessageMember(message, "role")
		roleText, _ := role.stringValue()
		content := mustBackendsMember(message, "content")
		if len(merged.array) > 0 {
			last := &merged.array[len(merged.array)-1]
			lastRole, _ := backendsMessageMember(*last, "role")
			lastRoleText, _ := lastRole.stringValue()
			if lastRoleText == roleText && pinnedJSTruthy(content) && roleText != "tool" {
				lastContent := mustBackendsMember(*last, "content")
				left, leftErr := pinnedJSStringValue(lastContent)
				right, rightErr := pinnedJSStringValue(content)
				if leftErr != nil || rightErr != nil {
					return orderedNodeJSON{}, errBackendsBadMessage
				}
				last.setMember("content", nodeString(left+"\n\n"+right))
				continue
			}
		}
		merged.array = append(merged.array, message)
	}
	if len(merged.array) == 0 {
		placeholder := nodeObject()
		placeholder.setMember("role", nodeString("user"))
		placeholder.setMember("content", nodeString(backendsPromptPlaceholder))
		merged.array = append(merged.array, placeholder)
	}

	if len(contentTokens) > 0 {
		for index := range merged.array {
			message := &merged.array[index]
			content := mustBackendsMember(*message, "content")
			contentText, isString := content.stringValue()
			if !isString {
				continue
			}
			contains := false
			for token := range contentTokens {
				if containsSubstring(contentText, token) {
					contains = true
					break
				}
			}
			if !contains {
				continue
			}
			split := splitOnDoubleNewline(contentText)
			mergedContent := nodeArray()
			for _, part := range split {
				if token, exists := contentTokens[part]; exists {
					mergedContent.array = append(mergedContent.array, token)
					continue
				}
				if len(mergedContent.array) > 0 {
					last := &mergedContent.array[len(mergedContent.array)-1]
					lastType, _ := backendsMessageMember(*last, "type")
					typeText, _ := lastType.stringValue()
					if typeText == "text" {
						lastText := mustBackendsMember(*last, "text")
						text, _ := pinnedJSStringValue(lastText)
						last.setMember("text", nodeString(text+"\n\n"+part))
						continue
					}
				}
				textPart := nodeObject()
				textPart.setMember("type", nodeString("text"))
				textPart.setMember("text", nodeString(part))
				mergedContent.array = append(mergedContent.array, textPart)
			}
			message.setMember("content", mergedContent)
		}
	}

	if options.strict {
		for index := range merged.array {
			if index > 0 {
				role, _ := backendsMessageMember(merged.array[index], "role")
				roleText, _ := role.stringValue()
				if roleText == "system" {
					merged.array[index].setMember("role", nodeString("user"))
				}
			}
		}
		if len(merged.array) > 0 && options.placeholders {
			firstRole, _ := backendsMessageMember(merged.array[0], "role")
			firstRoleText, _ := firstRole.stringValue()
			if firstRoleText == "system" && (len(merged.array) == 1 || backendsRoleIsNot(merged.array[1], "user")) {
				placeholder := nodeObject()
				placeholder.setMember("role", nodeString("user"))
				placeholder.setMember("content", nodeString(backendsPromptPlaceholder))
				merged.array = append(merged.array[:1], append([]orderedNodeJSON{placeholder}, merged.array[1:]...)...)
			} else if firstRoleText != "system" && firstRoleText != "user" {
				placeholder := nodeObject()
				placeholder.setMember("role", nodeString("user"))
				placeholder.setMember("content", nodeString(backendsPromptPlaceholder))
				merged.array = append([]orderedNodeJSON{placeholder}, merged.array...)
			}
		}
		return backendsMergeMessages(merged, names, backendsMergeOptions{
			placeholders: options.placeholders, tools: options.tools,
		})
	}
	return merged, nil
}

func backendsRoleIsNot(message orderedNodeJSON, role string) bool {
	value, _ := backendsMessageMember(message, "role")
	text, _ := value.stringValue()
	return text != role
}

func mustBackendsMember(message orderedNodeJSON, key string) orderedNodeJSON {
	value, _ := backendsMessageMember(message, key)
	return value
}

// backendsJSJoinString is Array.prototype.join's element coercion for a flattened content part:
// undefined and null become the empty string, everything else is String(value).
func backendsJSJoinString(value orderedNodeJSON) string {
	if value.isUndefined() || value.kind == 'n' {
		return ""
	}
	text, err := pinnedJSStringValue(value)
	if err != nil {
		return ""
	}
	return text
}

func joinBackendsParts(parts []string) string {
	result := ""
	for index, part := range parts {
		if index > 0 {
			result += "\n\n"
		}
		result += part
	}
	return result
}

func hasPrefix(content, prefix string) bool {
	return len(content) >= len(prefix) && content[:len(prefix)] == prefix
}

func containsSubstring(content, needle string) bool {
	for index := 0; index+len(needle) <= len(content); index++ {
		if content[index:index+len(needle)] == needle {
			return true
		}
	}
	return false
}

// splitOnDoubleNewline is String.prototype.split('\n\n').
func splitOnDoubleNewline(content string) []string {
	parts := make([]string, 0)
	start := 0
	for index := 0; index+2 <= len(content); index++ {
		if content[index] == '\n' && content[index+1] == '\n' {
			parts = append(parts, content[start:index])
			start = index + 2
			index++
		}
	}
	return append(parts, content[start:])
}

// serveBackendsProcess is chat-completions.js:2979.
func (runtime *accountRuntime) serveBackendsProcess(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	messages := sdBodyMember(body, "messages")
	if messages.kind != 'a' {
		backendsErrorJSON(w, http.StatusBadRequest, "Invalid messages format")
		return
	}
	typeNode := sdBodyMember(body, "type")
	typeText, isString := typeNode.stringValue()
	known := false
	if isString {
		for _, candidate := range backendsProcessTypes {
			if candidate == typeText {
				known = true
				break
			}
		}
	}
	if !known {
		backendsErrorJSON(w, http.StatusBadRequest, "Unknown processing type")
		return
	}
	result, err := backendsPostProcessPrompt(messages, typeText, backendsPromptNamesFor(body))
	if err != nil {
		backendsStatus(w, http.StatusInternalServerError)
		return
	}
	backendsJSON(w, nodeObjectWith("messages", result))
}

// backendsErrorJSON is `response.status(status).send({ error: message })`.
func backendsErrorJSON(w http.ResponseWriter, status int, message string) {
	payload := nodeObject()
	payload.setMember("error", nodeString(message))
	backendsJSONStatus(w, status, payload)
}

// serveBackendsBias is chat-completions.js:2158.
func (runtime *accountRuntime) serveBackendsBias(w http.ResponseWriter, request *http.Request) {
	if _, _, ok := runtime.sdUser(w, request); !ok {
		return
	}
	body, ok := runtime.sdRequestBody(w, request)
	if !ok {
		return
	}
	if body.kind != 'a' {
		backendsStatus(w, http.StatusBadRequest)
		return
	}
	queryModel := request.URL.Query().Get("model")
	tokenizerModel := backendsTokenizerModelName(queryModel)
	if tokenizerModel == tokenizers.FamilyClaude {
		backendsJSON(w, nodeObject())
		return
	}
	encode, encodeOK := runtime.backendsBiasEncoder(tokenizerModel)
	if !encodeOK {
		backendsJSON(w, nodeObject())
		return
	}
	values := map[uint32]orderedNodeJSON{}
	for _, entry := range body.array {
		text, isString := sdMemberOf(entry, "text")
		if !isString || !pinnedJSTruthy(text) || text.kind != 's' {
			continue
		}
		textValue := text.scalar.(string)
		var tokens []uint32
		trimmed := sdTrimJavaScriptSpace(textValue)
		if len(trimmed) > 0 && trimmed[0] == '[' && trimmed[len(trimmed)-1] == ']' {
			if parsed, err := decodeOrderedNodeJSON([]byte(textValue)); err == nil && parsed.kind == 'a' {
				allNumbers := true
				for _, item := range parsed.array {
					if item.kind != 'v' {
						allNumbers = false
						break
					}
				}
				if allNumbers {
					tokens = backendsToUint32List(parsed)
				}
			}
		}
		if tokens == nil {
			encoded, err := encode(textValue)
			if err != nil {
				continue
			}
			tokens = encoded
		}
		value, _ := sdMemberOf(entry, "value")
		for _, token := range tokens {
			values[token] = value
		}
	}
	backendsJSON(w, backendsNumberedObject(values))
}

// backendsBiasEncoder selects the pinned tokenizer family for the bias route.
func (runtime *accountRuntime) backendsBiasEncoder(tokenizerModel string) (func(string) ([]uint32, error), bool) {
	set, present := openTokenizerSet(runtime.options)
	if !present {
		return nil, false
	}
	if family, ok := sentencePieceFamilyModel(tokenizerModel); ok {
		processor, err := set.sentencePiece(family)
		if err != nil {
			return nil, false
		}
		return func(text string) ([]uint32, error) {
			ids, _ := processor.Encode(text)
			return backendsIntsToUint32(ids), nil
		}, true
	}
	if isWebTokenizerModel(tokenizerModel) {
		processor, err := set.web(tokenizerModel)
		if err != nil {
			return nil, false
		}
		return func(text string) ([]uint32, error) {
			ids, err := processor.Encode(text)
			if err != nil {
				return nil, err
			}
			return backendsIntsToUint32(ids), nil
		}, true
	}
	loaded, err := set.tiktoken()
	if err != nil {
		return nil, false
	}
	encoding, err := loaded.ForModel(tokenizerModel)
	if err != nil {
		return nil, false
	}
	return func(text string) ([]uint32, error) {
		ids, err := encoding.Encode(text)
		if err != nil {
			return nil, err
		}
		return backendsIntsToUint32(ids), nil
	}, true
}

func backendsIntsToUint32(ids []int) []uint32 {
	result := make([]uint32, len(ids))
	for index, id := range ids {
		result[index] = uint32(id)
	}
	return result
}
