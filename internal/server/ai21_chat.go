package server

// AI21, chat_completion_source: 'ai21' (src/endpoints/backends/chat-completions.js:800-881).
//
// This is an OWN transform, not the shared openai-compatible path. Five differences, each of which would be a
// silent divergence if the shared code were reused:
//
//  1. THE CONVERTER. `convertAI21Messages` (src/prompt-converters.js) collapses the LEADING system messages into
//     one (joined with "\n\n", trimming the result), substitutes `PROMPT_PLACEHOLDER` when nothing is left,
//     strips `name` after prefixing it into the content, and then MERGES consecutive same-role messages by
//     joining their contents with "\n\n" -- because the AI21 messaging endpoint only supports alternating turns.
//  2. THE BODY ORDER is its own: messages, model, max_tokens, temperature, top_p, stop, stream, tools, and then
//     the json_schema fold LAST (spread from bodyParams).
//  3. THE HEADERS are its own set: accept: application/json, content-type: application/json, Authorization --
//     NOT the shared node-fetch default set.
//  4. A NON-2XX ANSWER IS 500 WITH THE PROVIDER'S PARSED BODY (`tryParse(errorText) ?? {error:true}`), not the
//     shared path's 200 {error:{message},quota_error} envelope.
//  5. THE CATCH answers 200 {error:true} (like MISTRAL and DEEPSEEK, unlike CLAUDE's 500).
//
// The json_schema fold is the SAME shape as SILICONFLOW's setJsonObjectFormat: `response_format:{type:'json_object'}`
// plus a synthesized user message carrying the schema at 4-space indent. It is the FIFTH distinct fold shape in
// this package, which is why it is implemented here rather than shared.
//
// `/status`: pinned has NO AI21 arm (CHAT_COMPLETION_SOURCES.AI21 appears exactly once, in the generate
// dispatch at :2261), so a /status request answers 501 here and no status scenario exists. That is rule 17's
// distinction: an unimplemented arm must be distinguishable from a refused one.

import (
	"errors"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	pinnedAI21APIURL         = "https://api.ai21.com/studio/v1"
	pinnedAI21SeamEnv        = "GOTAVERN_AI21_CHAT_URL"
	pinnedAI21SecretKey      = "api_key_ai21"
	chatCompletionSourceAI21 = "ai21"
	// PROMPT_PLACEHOLDER defaults to this; the config key `promptPlaceholder` can change it and is NOT read here.
	pinnedAI21PromptPlaceholder = "Let's get started."
)

// pinnedAI21Names is getPromptNames (src/prompt-converters.js:49).
type pinnedAI21Names struct {
	charName   string
	userName   string
	groupNames []string
}

func (names pinnedAI21Names) startsWithGroupName(message string) bool {
	for _, name := range names.groupNames {
		if strings.HasPrefix(message, name+": ") {
			return true
		}
	}
	return false
}

func pinnedAI21PromptNames(body orderedNodeJSON) pinnedAI21Names {
	names := pinnedAI21Names{}
	if node, exists := body.member("char_name"); exists {
		if text, err := pinnedJSStringValue(node); err == nil {
			names.charName = text
		}
	}
	if node, exists := body.member("user_name"); exists {
		if text, err := pinnedJSStringValue(node); err == nil {
			names.userName = text
		}
	}
	if node, exists := body.member("group_names"); exists && node.kind == 'a' {
		for _, entry := range node.array {
			if text, err := pinnedJSStringValue(entry); err == nil {
				names.groupNames = append(names.groupNames, text)
			}
		}
	}
	return names
}

// pinnedAI21BaseURL is the pinned literal, replaceable only by the test seam.
func pinnedAI21BaseURL() string {
	return sdSeamURL(pinnedAI21SeamEnv, pinnedAI21APIURL)
}

// pinnedAI21Messages is convertAI21Messages. Each step is in the pinned order, because the order decides the
// resulting array (the placeholder is inserted BEFORE the system message is unshifted, so the system message
// ends up first).
func pinnedAI21Messages(body orderedNodeJSON) orderedNodeJSON {
	converted := nodeArray()
	messagesNode, exists := body.member("messages")
	if !exists || messagesNode.kind != 'a' {
		return converted
	}
	names := pinnedAI21PromptNames(body)

	// 1. Collapse the LEADING system messages, stopping at the first non-system message.
	systemPrompt := ""
	index := 0
	for index < len(messagesNode.array) {
		message := messagesNode.array[index]
		if role, err := pinnedJSStringValue(mustMember(message, "role")); err != nil || role != "system" {
			break
		}
		content, contentErr := pinnedJSStringValue(mustMember(message, "content"))
		if contentErr != nil {
			content = ""
		}
		if name, hasName := message.member("name"); hasName {
			if text, err := pinnedJSStringValue(name); err == nil {
				if names.userName != "" && text == "example_user" && !strings.HasPrefix(content, names.userName+": ") {
					content = names.userName + ": " + content
				}
				if names.charName != "" && text == "example_assistant" && !strings.HasPrefix(content, names.charName+": ") && !names.startsWithGroupName(content) {
					content = names.charName + ": " + content
				}
			}
		}
		systemPrompt += content + "\n\n"
		index++
	}
	messages := make([]orderedNodeJSON, 0, len(messagesNode.array))
	for _, message := range messagesNode.array[index:] {
		messages = append(messages, message)
	}

	// 2. An empty array gets the placeholder user turn.
	if len(messages) == 0 {
		placeholder := nodeObject()
		placeholder.setMember("role", nodeString("user"))
		placeholder.setMember("content", nodeString(pinnedAI21PromptPlaceholder))
		messages = append(messages, placeholder)
	}

	// 3. The collapsed system prompt goes FIRST.
	if systemPrompt != "" {
		system := nodeObject()
		system.setMember("role", nodeString("system"))
		system.setMember("content", nodeString(trimJSWhitespace(systemPrompt)))
		messages = append([]orderedNodeJSON{system}, messages...)
	}

	// 4. Strip `name`, prefixing it into the content of every non-system message.
	for i, message := range messages {
		name, hasName := message.member("name")
		if !hasName {
			continue
		}
		text, err := pinnedJSStringValue(name)
		if err == nil {
			role, _ := pinnedJSStringValue(mustMember(message, "role"))
			content, _ := pinnedJSStringValue(mustMember(message, "content"))
			if role != "system" && !strings.HasPrefix(content, text+": ") {
				message.setMember("content", nodeString(text+": "+content))
			}
		}
		message.deleteMember("name")
		messages[i] = message
	}

	// 5. Merge consecutive same-role turns.
	merged := make([]orderedNodeJSON, 0, len(messages))
	for _, message := range messages {
		if len(merged) > 0 {
			previousRole, _ := pinnedJSStringValue(mustMember(merged[len(merged)-1], "role"))
			role, _ := pinnedJSStringValue(mustMember(message, "role"))
			if previousRole == role {
				previousContent, _ := pinnedJSStringValue(mustMember(merged[len(merged)-1], "content"))
				content, _ := pinnedJSStringValue(mustMember(message, "content"))
				merged[len(merged)-1].setMember("content", nodeString(previousContent+"\n\n"+content))
				continue
			}
		}
		merged = append(merged, message)
	}

	for _, message := range merged {
		converted.array = append(converted.array, message)
	}
	return converted
}

func mustMember(node orderedNodeJSON, key string) orderedNodeJSON {
	value, _ := node.member(key)
	return value
}

// pinnedSetAI21JsonObjectFormat is the json_schema hack at :818-827: response_format {type:'json_object'} plus a
// synthesized user message. Identical in shape to SILICONFLOW's setJsonObjectFormat and implemented separately
// because the two branches are separate pinned code with their own message arrays.
func pinnedSetAI21JsonObjectFormat(bodyParams *orderedNodeJSON, messages *[]orderedNodeJSON, jsonSchema orderedNodeJSON) error {
	format := nodeObject()
	format.setMember("type", nodeString("json_object"))
	bodyParams.setMember("response_format", format)

	pretty := "undefined"
	if value, exists := jsonSchema.member("value"); exists {
		encoded, err := marshalPrettyOrderedNodeJSON(value, 0)
		if err != nil {
			return err
		}
		pretty = string(encoded)
	}
	message := nodeObject()
	message.setMember("role", nodeString("user"))
	message.setMember("content", nodeString("JSON schema for the response:\n"+pretty))
	*messages = append(*messages, message)
	return nil
}

// pinnedAI21Plan builds the AI21 request: its own converter, its own member order, its own headers.
func pinnedAI21Plan(body orderedNodeJSON, directories startup.UserDirectories) (*outbound.Request, *pinnedChatCompletionFailure) {
	if !pinnedJSTruthy(body) {
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}
	secret, err := pinnedReadSecret(directories, pinnedAI21SecretKey, pinnedSecretID(body))
	if err != nil {
		return nil, pinnedChatCompletionTransportFailure(err)
	}
	key, keyErr := pinnedJSStringValue(secret)
	if keyErr != nil {
		key = ""
	}
	if key == "" {
		// :803-806, BEFORE the try: 400 {error:true}.
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}

	// ORDER MATTERS: the pinned branch pushes the synthesized schema message into request.body.messages BEFORE
	// convertAI21Messages runs, so the converter's same-role merge folds it into the previous user turn with a
	// blank line. Appending it after the conversion leaves two user turns and a body the capture does not have.
	rawMessages, _ := body.member("messages")
	list := make([]orderedNodeJSON, 0)
	if rawMessages.kind == 'a' {
		list = append(list, rawMessages.array...)
	}
	bodyParams := nodeObject()
	if schema, exists := body.member("json_schema"); exists && pinnedJSTruthy(schema) {
		if foldErr := pinnedSetAI21JsonObjectFormat(&bodyParams, &list, schema); foldErr != nil {
			return nil, pinnedChatCompletionTransportFailure(foldErr)
		}
	}

	rebuilt := nodeObject()
	for _, entry := range body.object {
		rebuilt.setMember(entry.key, entry.value)
	}
	pushed := nodeArray()
	for _, message := range list {
		pushed.array = append(pushed.array, message)
	}
	rebuilt.setMember("messages", pushed)
	messages := pinnedAI21Messages(rebuilt).array

	requestBody := nodeObject()
	converted := nodeArray()
	for _, message := range messages {
		converted.array = append(converted.array, message)
	}
	requestBody.setMember("messages", converted)
	for _, member := range []string{"model", "max_tokens", "temperature", "top_p", "stop", "stream", "tools"} {
		if value, exists := body.member(member); exists && !value.isUndefined() {
			requestBody.setMember(member, value)
		}
	}
	for _, entry := range bodyParams.object {
		requestBody.setMember(entry.key, entry.value)
	}

	encoded, marshalErr := marshalOrderedNodeJSON(requestBody)
	if marshalErr != nil {
		return nil, pinnedChatCompletionTransportFailure(marshalErr)
	}
	// The pinned `fetch` sends this branch's three headers PLUS everything node-fetch adds on its own:
	// accept-encoding, user-agent and a computed Content-Length, and Go's client then adds Host and Connection.
	// Omitting that framing is what made the route send a bodyless request: the capture records
	// content-length 193 and Host, and every other source's capture carries them too.
	endpointURL := pinnedAI21BaseURL() + "/chat/completions"
	parsedEndpoint, parseErr := url.Parse(endpointURL)
	if parseErr != nil || parsedEndpoint.Host == "" {
		return nil, pinnedChatCompletionTransportFailure(errors.New("Only absolute URLs are supported"))
	}
	headerValues := map[string]string{
		"accept":          "application/json",
		"content-type":    "application/json",
		"authorization":   "Bearer " + key,
		"accept-encoding": "gzip, deflate, br",
		"user-agent":      "node-fetch",
		"content-length":  strconv.Itoa(len(encoded)),
	}
	requestHeaders := pinnedChatCompletionRequestFraming(headerValues, parsedEndpoint)

	return &outbound.Request{
		URL:     endpointURL,
		Method:  http.MethodPost,
		Headers: requestHeaders,
		Body:    encoded,
	}, nil
}
