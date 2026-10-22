package server

// Pinned CLAUDE chat-completion source, from src/endpoints/backends/chat-completions.js:230
// (sendClaudeRequest), dispatched at :2260 (`case CHAT_COMPLETION_SOURCES.CLAUDE`).
//
// WHY THIS IS ITS OWN FILE AND NOT A BODY HELPER. sendClaudeRequest is not on the generic plan path:
// it builds its own request body in a FIXED member order (:269-279 plus the appended tool/output/
// thinking members), its own URL (:231 + :410), its own header set (x-api-key, NOT Bearer, plus a
// composed anthropic-beta list), its own THREE error observables, and its own response mapping
// (:432-439). Folding it into the openai/openrouter body builder would have to reproduce every one of
// those exceptions inside the shared code, so the plan switch delegates here and the response side
// branches on the source.
//
// THE THREE ERROR OBSERVABLES THE GENERIC PATH DOES NOT SHARE:
//   - :235-238 a missing key answers 400 {"error":true} BEFORE the try, so no fetch is attempted.
//     Note the key is `reverse_proxy ? proxy_password : secret`, so a request that names a
//     reverse_proxy but no password ALSO answers 400 here -- unlike the openai source, which reaches
//     the provider with "Bearer undefined".
//   - :426-430 a non-2xx answer on a NON-streaming request is drained and answered 500 {"error":true};
//     the provider's text is never forwarded.
//   - :441-446 a thrown fetch (or a JSON parse failure, which throws inside the same try) answers
//     500 {"error":true} while the headers have not been sent.
//
// NOT COVERED, stated rather than silently different: the config-gated caching helpers
// (claude.enableSystemPromptCache, claude.cachingAtDepth, claude.extendedTTL -- :106-112, :281-283,
// :297-299, :330-337) are OFF by DEFAULT, are never reached by a default request, and the claude
// config keys are not projected into HTTPHandlerOptions, so their two extra beta values and their
// cache_control members cannot be pinned here. `promptPlaceholder` is the same shape of gap: the
// pinned value comes from config.yaml and this route uses the pinned default.

import (
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/cocokoishi/gotavern/internal/outbound"
	"github.com/cocokoishi/gotavern/internal/startup"
)

const (
	pinnedClaudeAPIURL         = "https://api.anthropic.com/v1"
	pinnedClaudeSeamEnv        = "GOTAVERN_CLAUDE_CHAT_URL"
	pinnedClaudeSecretKey      = "api_key_claude"
	pinnedClaudeAPIVersion     = "2023-06-01"
	chatCompletionSourceClaude = "claude"
	// PROMPT_PLACEHOLDER's pinned default (src/prompt-converters.js:4).
	pinnedClaudePromptPlaceholder = "Let's get started."
)

// pinnedClaudeBaseURL is the pinned literal `API_CLAUDE` (chat-completions.js:74), replaceable only by
// the test seam. The pinned code runs `new URL(reverse_proxy || API_CLAUDE).toString()`, so the value
// a caller supplies is NORMALIZED before '/messages' is appended -- which is why a reverse_proxy of
// "http://host" produces a doubled slash and the fixture records it.
func pinnedClaudeBaseURL() string { return sdSeamURL(pinnedClaudeSeamEnv, pinnedClaudeAPIURL) }

// The model-string predicates of chat-completions.js:252-261. Each is a JS RegExp test against
// `String(request.body.model)`, so an absent model is the string "undefined" and matches nothing.
var (
	pinnedClaudeFablePattern           = regexp.MustCompile(`claude-fable`)
	pinnedClaudeFable51Pattern         = regexp.MustCompile(`claude-fable-5-1`)
	pinnedClaudeFivePattern            = regexp.MustCompile(`claude-(opus-5|sonnet-5)`)
	pinnedClaudeThinkingPattern        = regexp.MustCompile(`^claude-(3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)`)
	pinnedClaudeWebSearchPattern       = regexp.MustCompile(`^claude-(3-5|3-7|opus-4|sonnet-4|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6|opus-4-7)`)
	pinnedClaudeLimitedSamplingPattern = regexp.MustCompile(`^claude-(opus-4-1|sonnet-4-5|haiku-4-5|opus-4-5|opus-4-6|sonnet-4-6)`)
	pinnedClaudeVerbosityPattern       = regexp.MustCompile(`^claude-(opus-4-5|opus-4-6|sonnet-4-6|opus-4-7|opus-4-8)`)
	pinnedClaudeNoPrefillPattern       = regexp.MustCompile(`^claude-(opus-4-6|sonnet-4-6|opus-4-7|opus-4-8)`)
	pinnedClaudeAdaptivePattern        = regexp.MustCompile(`^claude-(opus-4-7|opus-4-8)`)
	pinnedClaudeAdaptive46Pattern      = regexp.MustCompile(`^claude-(opus-4-6|sonnet-4-6)`)
	pinnedClaudeNoSamplingPattern      = regexp.MustCompile(`^claude-(opus-4-7|opus-4-8)`)
)

// pinnedClaudeModelFlags is the resolved set of pinned predicates for one model string. isAdaptiveModel
// folds the CONFIG default `claude.enableAdaptiveThinking` (true) into the 4-6 generation, which is why
// it is computed here rather than being a plain pattern.
type pinnedClaudeModelFlags struct {
	fable           bool
	fable51         bool
	claude5         bool
	thinking        bool
	webSearch       bool
	limitedSampling bool
	verbosity       bool
	noPrefill       bool
	adaptive        bool
	noSampling      bool
}

// pinnedClaudeJSString is JavaScript `String(value)` for a decoded member.
func pinnedClaudeJSString(value orderedNodeJSON) string {
	text, err := characterString(value)
	if err != nil {
		return "[object Object]"
	}
	return text
}

func pinnedClaudeModelFlagsFor(body orderedNodeJSON) pinnedClaudeModelFlags {
	model := pinnedClaudeJSString(sdBodyMember(body, "model"))
	flags := pinnedClaudeModelFlags{
		fable:           pinnedClaudeFablePattern.MatchString(model),
		fable51:         pinnedClaudeFable51Pattern.MatchString(model),
		claude5:         pinnedClaudeFivePattern.MatchString(model),
		thinking:        pinnedClaudeThinkingPattern.MatchString(model),
		limitedSampling: pinnedClaudeLimitedSamplingPattern.MatchString(model),
		verbosity:       pinnedClaudeVerbosityPattern.MatchString(model),
		noPrefill:       pinnedClaudeNoPrefillPattern.MatchString(model),
		noSampling:      pinnedClaudeNoSamplingPattern.MatchString(model),
	}
	flags.thinking = flags.thinking || flags.fable || flags.claude5
	// :256 -- the web-search-capable pattern is WIDER than the thinking one (it includes claude-3-5),
	// and it only matters when the caller asks for web search.
	flags.webSearch = (pinnedClaudeWebSearchPattern.MatchString(model) || flags.fable || flags.claude5) &&
		pinnedJSTruthy(sdBodyMember(body, "enable_web_search"))
	flags.verbosity = flags.verbosity || flags.fable || flags.claude5
	flags.noPrefill = flags.noPrefill || flags.fable || flags.claude5
	// :260 -- `enableAdaptiveThinking` defaults to TRUE in the pinned config.
	flags.adaptive = pinnedClaudeAdaptivePattern.MatchString(model) || flags.fable || flags.claude5 ||
		pinnedClaudeAdaptive46Pattern.MatchString(model)
	flags.noSampling = pinnedClaudeNoSamplingPattern.MatchString(model) || flags.fable || flags.claude5
	return flags
}

// pinnedClaudeBudget is the union calculateClaudeBudgetTokens returns: a NUMBER for traditional
// thinking, an EFFORT STRING for adaptive models, or null. `kind` is 'v', 's' or 'n'.
type pinnedClaudeBudget struct {
	kind   byte
	number float64
	text   string
}

// pinnedClaudeBudgetTokens ports calculateClaudeBudgetTokens (prompt-converters.js:1124).
//
// THE ABSENT-EFFORT CASE IS THE ONE A TIDY REWRITE GETS WRONG: the switch has no `default`, so an
// absent (or unrecognised) reasoning_effort leaves budgetTokens at 0, the two clamps lift it to 1024,
// and a thinking-capable model therefore receives `thinking:{type:'enabled',budget_tokens:1024}` even
// though the caller never asked for thinking. Only the literal 'auto' returns null in this arm.
func pinnedClaudeBudgetTokens(maxTokens float64, effort string, stream, adaptive bool) pinnedClaudeBudget {
	if adaptive {
		switch effort {
		case "auto":
			return pinnedClaudeBudget{kind: 'n'}
		case "min", "low":
			return pinnedClaudeBudget{kind: 's', text: "low"}
		case "medium":
			return pinnedClaudeBudget{kind: 's', text: "medium"}
		case "high":
			return pinnedClaudeBudget{kind: 's', text: "high"}
		case "max":
			return pinnedClaudeBudget{kind: 's', text: "max"}
		}
		return pinnedClaudeBudget{kind: 'n'}
	}
	budget := 0.0
	switch effort {
	case "auto":
		return pinnedClaudeBudget{kind: 'n'}
	case "min":
		budget = 1024
	case "low":
		budget = math.Floor(maxTokens * 0.1)
	case "medium":
		budget = math.Floor(maxTokens * 0.25)
	case "high":
		budget = math.Floor(maxTokens * 0.5)
	case "max":
		budget = math.Floor(maxTokens * 0.95)
	}
	budget = math.Max(budget, 1024)
	if !stream {
		budget = math.Min(budget, 21333)
	}
	return pinnedClaudeBudget{kind: 'v', number: budget}
}

// pinnedClaudeNames is getPromptNames (prompt-converters.js:49).
type pinnedClaudeNames struct {
	charName   string
	userName   string
	groupNames []string
}

func pinnedClaudeNamesFor(body orderedNodeJSON) pinnedClaudeNames {
	names := pinnedClaudeNames{
		charName: pinnedClaudeJSString(sdBodyMember(body, "char_name")),
		userName: pinnedClaudeJSString(sdBodyMember(body, "user_name")),
	}
	if groupNames := sdBodyMember(body, "group_names"); groupNames.kind == 'a' {
		for _, entry := range groupNames.array {
			names.groupNames = append(names.groupNames, pinnedClaudeJSString(entry))
		}
	}
	return names
}

// startsWithGroupName is the pinned closure of the same name.
func (names pinnedClaudeNames) startsWithGroupName(message string) bool {
	for _, groupName := range names.groupNames {
		if strings.HasPrefix(message, groupName+": ") {
			return true
		}
	}
	return false
}

// pinnedClaudeTextBlock is `{ type: 'text', text }`.
func pinnedClaudeTextBlock(text string) orderedNodeJSON {
	block := nodeObject()
	block.setMember("type", nodeString("text"))
	block.setMember("text", nodeString(text))
	return block
}

// pinnedClaudeMemberString is the JS `message.role` read for a message object; an absent role is
// undefined, which never equals 'system', 'user' or 'assistant'.
func pinnedClaudeMemberString(message orderedNodeJSON, key string) (string, bool) {
	member, exists := message.member(key)
	if !exists {
		return "", false
	}
	text, isString := member.stringValue()
	if !isString {
		return pinnedClaudeJSString(member), true
	}
	return text, true
}

// pinnedClaudePrefixExampleName applies the four `example_user`/`example_assistant` name-prefixing
// rules of :206-216 (:254-262 for a system message that survives the extraction).
func pinnedClaudePrefixExampleName(message orderedNodeJSON, names pinnedClaudeNames) {
	name, _ := pinnedClaudeMemberString(message, "name")
	content, hasContent := pinnedClaudeMemberString(message, "content")
	if !hasContent {
		return
	}
	if names.userName != "" && name == "example_user" {
		if !strings.HasPrefix(content, names.userName+": ") {
			message.setMember("content", nodeString(names.userName+": "+content))
		}
	}
	if names.charName != "" && name == "example_assistant" {
		if !strings.HasPrefix(content, names.charName+": ") && !names.startsWithGroupName(content) {
			message.setMember("content", nodeString(names.charName+": "+content))
		}
	}
}

// pinnedClaudeContentBlocks converts one message's `content` into the array-of-blocks form
// (:270-307). A string becomes one text block (prefixed with the name when there is one); an array is
// mapped element by element, and an ELEMENT IS MUTATED IN PLACE when it is a text block, which is why
// a name prefix lands on the element's own text.
func pinnedClaudeContentBlocks(message orderedNodeJSON) (orderedNodeJSON, error) {
	content, exists := message.member("content")
	if !exists || content.kind == nodeUndefinedKind {
		content = nodeUndefined()
	}
	name, hasName := pinnedClaudeMemberString(message, "name")
	if content.kind == 's' {
		text, _ := content.stringValue()
		if hasName && name != "" {
			text = name + ": " + text
		}
		blocks := nodeArray()
		blocks.array = append(blocks.array, pinnedClaudeTextBlock(text))
		return blocks, nil
	}
	if content.kind != 'a' {
		// A non-string, non-array content (an object, a number, absent) is left as-is by the pinned
		// code: only the two cases above are rewritten.
		return content, nil
	}
	blocks := nodeArray()
	for _, entry := range content.array {
		if entry.kind != 'o' {
			blocks.array = append(blocks.array, entry)
			continue
		}
		switch typeName, _ := pinnedClaudeMemberString(entry, "type"); typeName {
		case "image_url":
			imageEntry, _ := entry.member("image_url")
			imageData := sdBodyMember(imageEntry, "url")
			imageText, _ := imageData.stringValue()
			mimeType := ""
			base64Data := ""
			if parts := strings.SplitN(imageText, ";", 2); len(parts) > 0 {
				if colon := strings.SplitN(parts[0], ":", 2); len(colon) == 2 {
					mimeType = colon[1]
				}
			}
			if parts := strings.SplitN(imageText, ",", 2); len(parts) == 2 {
				base64Data = parts[1]
			}
			block := nodeObject()
			block.setMember("type", nodeString("image"))
			source := nodeObject()
			source.setMember("type", nodeString("base64"))
			source.setMember("media_type", nodeString(mimeType))
			source.setMember("data", nodeString(base64Data))
			block.setMember("source", source)
			blocks.array = append(blocks.array, block)
		case "text":
			text, _ := pinnedClaudeMemberString(entry, "text")
			if hasName && name != "" {
				entry.setMember("text", nodeString(name+": "+text))
			}
			if text, _ := pinnedClaudeMemberString(entry, "text"); text == "" {
				// An empty text block becomes a zero-width space so the provider does not reject it.
				entry.setMember("text", nodeString("\u200b"))
			}
			blocks.array = append(blocks.array, entry)
		default:
			blocks.array = append(blocks.array, entry)
		}
	}
	return blocks, nil
}

// pinnedClaudeToolUseBlock is one tool_calls entry rendered as an Anthropic tool_use block. The pinned
// code JSON.parses `function.arguments`, so malformed arguments throw and the route answers 500.
func pinnedClaudeToolUseBlock(toolCall orderedNodeJSON) (orderedNodeJSON, error) {
	function, _ := toolCall.member("function")
	arguments, _ := pinnedClaudeMemberString(function, "arguments")
	parsed, err := decodeOrderedNodeJSON([]byte(arguments))
	if err != nil {
		return orderedNodeJSON{}, err
	}
	block := nodeObject()
	block.setMember("type", nodeString("tool_use"))
	id, _ := pinnedClaudeMemberString(toolCall, "id")
	name, _ := pinnedClaudeMemberString(function, "name")
	block.setMember("id", nodeString(id))
	block.setMember("name", nodeString(name))
	block.setMember("input", parsed)
	return block, nil
}

// pinnedClaudeConvertMessages ports convertClaudeMessages (prompt-converters.js:197).
func pinnedClaudeConvertMessages(body orderedNodeJSON, useSystemPrompt, useTools bool) (orderedNodeJSON, orderedNodeJSON, error) {
	rawMessages := sdBodyMember(body, "messages")
	if rawMessages.kind != 'a' {
		// `messages.length` / `messages.forEach` throws for anything else, and the pinned catch
		// answers 500 {"error":true}.
		return orderedNodeJSON{}, orderedNodeJSON{}, errors.New("messages is not an array")
	}
	names := pinnedClaudeNamesFor(body)
	messages := pinnedStructuredClone(rawMessages)
	systemPrompt := nodeArray()

	if useSystemPrompt {
		index := 0
		for index < len(messages.array) {
			message := messages.array[index]
			if role, _ := pinnedClaudeMemberString(message, "role"); role != "system" {
				break
			}
			pinnedClaudePrefixExampleName(message, names)
			content, _ := pinnedClaudeMemberString(message, "content")
			systemPrompt.array = append(systemPrompt.array, pinnedClaudeTextBlock(content))
			index++
		}
		messages.array = messages.array[index:]
		if len(messages.array) == 0 {
			placeholder := nodeObject()
			placeholder.setMember("role", nodeString("user"))
			placeholder.setMember("content", nodeString(pinnedClaudePromptPlaceholder))
			messages.array = append([]orderedNodeJSON{placeholder}, messages.array...)
		}
	}

	for position, message := range messages.array {
		if message.kind != 'o' {
			continue
		}
		role, _ := pinnedClaudeMemberString(message, "role")
		if role == "assistant" {
			if toolCalls := sdBodyMember(message, "tool_calls"); toolCalls.kind == 'a' {
				blocks := nodeArray()
				for _, toolCall := range toolCalls.array {
					block, err := pinnedClaudeToolUseBlock(toolCall)
					if err != nil {
						return orderedNodeJSON{}, orderedNodeJSON{}, err
					}
					blocks.array = append(blocks.array, block)
				}
				message.setMember("content", blocks)
			}
		}
		if role == "tool" {
			message.setMember("role", nodeString("user"))
			content, _ := pinnedClaudeMemberString(message, "content")
			block := nodeObject()
			block.setMember("type", nodeString("tool_result"))
			toolCallID, _ := pinnedClaudeMemberString(message, "tool_call_id")
			block.setMember("tool_use_id", nodeString(toolCallID))
			block.setMember("content", nodeString(content))
			blocks := nodeArray()
			blocks.array = append(blocks.array, block)
			message.setMember("content", blocks)
		}
		if role == "system" {
			// A system message that survived the extraction: prefix example names, flip the role to
			// user and DROP the name so it is not prefixed again below.
			pinnedClaudePrefixExampleName(message, names)
			message.setMember("role", nodeString("user"))
			message.deleteMember("name")
		}
		blocks, err := pinnedClaudeContentBlocks(message)
		if err != nil {
			return orderedNodeJSON{}, orderedNodeJSON{}, err
		}
		message.setMember("content", blocks)
		message.deleteMember("name")
		message.deleteMember("tool_calls")
		message.deleteMember("tool_call_id")
		messages.array[position] = message
	}

	// Assistant-message images move to the next user message (:316-333).
	for position := 0; position < len(messages.array); position++ {
		message := messages.array[position]
		role, _ := pinnedClaudeMemberString(message, "role")
		content, _ := message.member("content")
		if role != "assistant" || content.kind != 'a' || !pinnedClaudeHasBlockType(content, "image") {
			continue
		}
		next := position + 1
		for next < len(messages.array) {
			if nextRole, _ := pinnedClaudeMemberString(messages.array[next], "role"); nextRole == "user" {
				break
			}
			next++
		}
		if next >= len(messages.array) {
			empty := nodeObject()
			empty.setMember("role", nodeString("user"))
			empty.setMember("content", nodeArray())
			messages.array = append(messages.array[:next], append([]orderedNodeJSON{empty}, messages.array[next:]...)...)
		}
		target := messages.array[next]
		targetContent, _ := target.member("content")
		targetBlocks := nodeArray()
		if targetContent.kind == 'a' {
			targetBlocks.array = append(targetBlocks.array, targetContent.array...)
		}
		kept := nodeArray()
		for _, entry := range content.array {
			if typeName, _ := pinnedClaudeMemberString(entry, "type"); typeName == "image" {
				targetBlocks.array = append(targetBlocks.array, entry)
				continue
			}
			kept.array = append(kept.array, entry)
		}
		target.setMember("content", targetBlocks)
		message.setMember("content", kept)
		messages.array[position] = message
		messages.array[next] = target
	}

	// Prefill: a trailing assistant turn whose text is `prefill.trimEnd()` (:336-342).
	if prefill := sdBodyMember(body, "assistant_prefill"); pinnedJSTruthy(prefill) {
		text, _ := prefill.stringValue()
		message := nodeObject()
		message.setMember("role", nodeString("assistant"))
		blocks := nodeArray()
		blocks.array = append(blocks.array, pinnedClaudeTextBlock(pinnedClaudeTrimEnd(text)))
		message.setMember("content", blocks)
		messages.array = append(messages.array, message)
	}

	// Merge consecutive same-role turns (:346-353).
	merged := nodeArray()
	for _, message := range messages.array {
		role, _ := pinnedClaudeMemberString(message, "role")
		if len(merged.array) > 0 {
			lastRole, _ := pinnedClaudeMemberString(merged.array[len(merged.array)-1], "role")
			if lastRole == role {
				last := merged.array[len(merged.array)-1]
				lastContent, _ := last.member("content")
				content, _ := message.member("content")
				combined := nodeArray()
				if lastContent.kind == 'a' {
					combined.array = append(combined.array, lastContent.array...)
				}
				if content.kind == 'a' {
					combined.array = append(combined.array, content.array...)
				}
				last.setMember("content", combined)
				merged.array[len(merged.array)-1] = last
				continue
			}
		}
		merged.array = append(merged.array, message)
	}

	if !useTools {
		// Without tools, tool blocks are flattened back to text (:355-373).
		for position, message := range merged.array {
			content, _ := message.member("content")
			if content.kind != 'a' {
				continue
			}
			for blockPosition, block := range content.array {
				if block.kind != 'o' {
					continue
				}
				switch typeName, _ := pinnedClaudeMemberString(block, "type"); typeName {
				case "tool_use":
					input, _ := block.member("input")
					encoded, err := marshalOrderedNodeJSON(input)
					if err != nil {
						return orderedNodeJSON{}, orderedNodeJSON{}, err
					}
					block.setMember("type", nodeString("text"))
					block.setMember("text", nodeString(string(encoded)))
					block.deleteMember("id")
					block.deleteMember("name")
					block.deleteMember("input")
				case "tool_result":
					content, _ := pinnedClaudeMemberString(block, "content")
					block.setMember("type", nodeString("text"))
					block.setMember("text", nodeString(content))
					block.deleteMember("tool_use_id")
					block.deleteMember("content")
				}
				content.array[blockPosition] = block
			}
			message.setMember("content", content)
			merged.array[position] = message
		}
	}
	return merged, systemPrompt, nil
}

func pinnedClaudeHasBlockType(content orderedNodeJSON, typeName string) bool {
	for _, entry := range content.array {
		if candidate, _ := pinnedClaudeMemberString(entry, "type"); candidate == typeName {
			return true
		}
	}
	return false
}

// pinnedClaudeTrimEnd is JavaScript `String.prototype.trimEnd` for a string.
func pinnedClaudeTrimEnd(value string) string {
	return strings.TrimRightFunc(value, func(character rune) bool { return pinnedClaudeIsJSSpace(character) })
}

// pinnedClaudeIsJSSpace matches the WhiteSpace + LineTerminator set trimEnd strips.
func pinnedClaudeIsJSSpace(character rune) bool {
	switch character {
	case '\t', '\n', '\v', '\f', '\r', ' ', '\u00a0', '\u1680', '\u2028', '\u2029', '\u202f', '\u205f', '\u3000', '\ufeff':
		return true
	}
	return character >= '\u2000' && character <= '\u200a'
}

// pinnedClaudePayload builds the pinned requestBody (:269-406) for the DEFAULT configuration and the
// anthropic-beta list that goes with it. Member order is the byte contract.
func pinnedClaudePayload(body orderedNodeJSON) (orderedNodeJSON, []string, *pinnedChatCompletionFailure) {
	flags := pinnedClaudeModelFlagsFor(body)
	useTools := false
	if tools := sdBodyMember(body, "tools"); tools.kind == 'a' && len(tools.array) > 0 {
		useTools = true
	}
	useSystemPrompt := pinnedJSTruthy(sdBodyMember(body, "use_sysprompt"))

	converted, systemPrompt, err := pinnedClaudeConvertMessages(body, useSystemPrompt, useTools)
	if err != nil {
		return orderedNodeJSON{}, nil, pinnedChatCompletionJSONFailure(http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
	}

	betaHeaders := []string{"output-128k-2025-02-19", "context-1m-2025-08-07"}

	stopSequences := nodeArray()
	if stop := sdBodyMember(body, "stop"); stop.kind == 'a' {
		stopSequences.array = append(stopSequences.array, stop.array...)
	}

	payload := nodeObject()
	payload.setMember("system", nodeArray())
	payload.setMember("messages", converted)
	for _, key := range []string{"model", "max_tokens"} {
		if value, exists := body.member(key); exists {
			payload.setMember(key, value)
		}
	}
	// `stop_sequences` is ALWAYS present, empty when the caller sent none.
	payload.setMember("stop_sequences", stopSequences)
	for _, key := range []string{"temperature", "top_p", "top_k", "stream"} {
		if value, exists := body.member(key); exists {
			payload.setMember(key, value)
		}
	}
	if useSystemPrompt {
		payload.setMember("system", systemPrompt)
	} else {
		payload.deleteMember("system")
	}
	if useTools {
		betaHeaders = append(betaHeaders, "tools-2024-05-16")
		toolChoice := nodeObject()
		if choice, exists := body.member("tool_choice"); exists {
			toolChoice.setMember("type", choice)
		} else {
			toolChoice.setMember("type", nodeUndefined())
		}
		payload.setMember("tool_choice", toolChoice)
		tools := nodeArray()
		if rawTools := sdBodyMember(body, "tools"); rawTools.kind == 'a' {
			for _, tool := range rawTools.array {
				if typeName, _ := pinnedClaudeMemberString(tool, "type"); typeName != "function" {
					continue
				}
				function, _ := tool.member("function")
				if function.kind != 'o' {
					return orderedNodeJSON{}, nil, pinnedChatCompletionJSONFailure(http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
				}
				convertedTool := nodeObject()
				if name, exists := function.member("name"); exists {
					convertedTool.setMember("name", name)
				}
				if description, exists := function.member("description"); exists {
					convertedTool.setMember("description", description)
				}
				if parameters, exists := function.member("parameters"); exists {
					convertedTool.setMember("input_schema", pinnedFlattenSchema(parameters))
				}
				tools.array = append(tools.array, convertedTool)
			}
		}
		payload.setMember("tools", tools)
	}

	if schema := sdBodyMember(body, "json_schema"); pinnedJSTruthy(schema) {
		if flags.fable51 {
			format := nodeObject()
			format.setMember("type", nodeString("json_schema"))
			if value, exists := schema.member("value"); exists {
				format.setMember("schema", value)
			}
			outputConfig := nodeObject()
			outputConfig.setMember("format", format)
			payload.setMember("output_config", outputConfig)
		} else {
			jsonTool := nodeObject()
			if name, exists := schema.member("name"); exists {
				jsonTool.setMember("name", name)
			}
			description := "Well-formed JSON object"
			if supplied, exists := schema.member("description"); exists && pinnedJSTruthy(supplied) {
				description, _ = supplied.stringValue()
			}
			jsonTool.setMember("description", nodeString(description))
			if value, exists := schema.member("value"); exists {
				jsonTool.setMember("input_schema", value)
			}
			// `[...(requestBody.tools || []), jsonTool]` -- the member KEEPS its existing position in
			// the object even though it is rebuilt, so setMember is the faithful operation here.
			existing := nodeArray()
			if current, exists := payload.member("tools"); exists && current.kind == 'a' {
				existing.array = append(existing.array, current.array...)
			}
			existing.array = append(existing.array, jsonTool)
			payload.setMember("tools", existing)
			toolChoice := nodeObject()
			toolChoice.setMember("type", nodeString("tool"))
			if name, exists := schema.member("name"); exists {
				toolChoice.setMember("name", name)
			}
			payload.setMember("tool_choice", toolChoice)
		}
	}

	if flags.webSearch {
		webSearchTool := nodeObject()
		webSearchTool.setMember("type", nodeString("web_search_20250305"))
		webSearchTool.setMember("name", nodeString("web_search"))
		tools := nodeArray()
		tools.array = append(tools.array, webSearchTool)
		if current, exists := payload.member("tools"); exists && current.kind == 'a' {
			tools.array = append(tools.array, current.array...)
		}
		payload.setMember("tools", tools)
	}

	if flags.limitedSampling {
		topP := sdBodyMember(payload, "top_p")
		if pinnedClaudeLessThanOne(topP) {
			payload.deleteMember("temperature")
		} else {
			payload.deleteMember("top_p")
		}
	}
	if flags.noSampling {
		payload.deleteMember("temperature")
		payload.deleteMember("top_p")
		payload.deleteMember("top_k")
	}

	maxTokens, _ := jsNumber(sdBodyMember(payload, "max_tokens"))
	stream := pinnedJSTruthy(sdBodyMember(body, "stream"))
	effort := ""
	if value, exists := body.member("reasoning_effort"); exists {
		if text, isString := value.stringValue(); isString {
			effort = text
		} else {
			effort = pinnedClaudeJSString(value)
		}
	}
	budget := pinnedClaudeBudgetTokens(maxTokens, effort, stream, flags.adaptive)
	includeReasoning := pinnedJSTruthy(sdBodyMember(body, "include_reasoning"))
	fixThinkingPrefill := false

	switch {
	case flags.thinking && budget.kind == 's':
		fixThinkingPrefill = true
		thinking := nodeObject()
		thinking.setMember("type", nodeString("adaptive"))
		if flags.noSampling && includeReasoning {
			thinking.setMember("display", nodeString("summarized"))
		}
		payload.setMember("thinking", thinking)
		outputConfig := nodeObject()
		if current, exists := payload.member("output_config"); exists && current.kind == 'o' {
			outputConfig = current
		}
		outputConfig.setMember("effort", nodeString(budget.text))
		payload.setMember("output_config", outputConfig)
		payload.deleteMember("top_k")
	case flags.thinking && (flags.fable || flags.claude5) && effort == "auto" && includeReasoning:
		fixThinkingPrefill = true
		thinking := nodeObject()
		thinking.setMember("type", nodeString("adaptive"))
		thinking.setMember("display", nodeString("summarized"))
		payload.setMember("thinking", thinking)
	case flags.thinking && budget.kind == 'v' && budget.number == math.Trunc(budget.number):
		fixThinkingPrefill = true
		const minThinkTokens = 1024
		if maxTokens <= minThinkTokens {
			payload.setMember("max_tokens", nodeNumber(maxTokens+minThinkTokens))
		}
		thinking := nodeObject()
		thinking.setMember("type", nodeString("enabled"))
		thinking.setMember("budget_tokens", nodeNumber(budget.number))
		payload.setMember("thinking", thinking)
		payload.deleteMember("temperature")
		payload.deleteMember("top_p")
		payload.deleteMember("top_k")
	}

	if (fixThinkingPrefill || flags.noPrefill) && converted.kind == 'a' && len(converted.array) > 0 {
		last := converted.array[len(converted.array)-1]
		if role, _ := pinnedClaudeMemberString(last, "role"); role == "assistant" {
			last.setMember("role", nodeString("user"))
			converted.array[len(converted.array)-1] = last
			payload.setMember("messages", converted)
		}
	}

	if flags.verbosity && pinnedJSTruthy(sdBodyMember(body, "verbosity")) {
		hasEffort := false
		if outputConfig, exists := payload.member("output_config"); exists && outputConfig.kind == 'o' {
			hasEffort = pinnedJSTruthy(sdBodyMember(outputConfig, "effort"))
		}
		if !hasEffort {
			betaHeaders = append(betaHeaders, "effort-2025-11-24")
			outputConfig := nodeObject()
			if current, exists := payload.member("output_config"); exists && current.kind == 'o' {
				outputConfig = current
			}
			outputConfig.setMember("effort", sdBodyMember(body, "verbosity"))
			payload.setMember("output_config", outputConfig)
		}
	}

	return payload, betaHeaders, nil
}

// pinnedClaudeLessThanOne is `requestBody.top_p < 1`, including JavaScript's coercion of a non-number
// (Number(null) is 0, Number('0.9') is 0.9, Number(undefined) is NaN which compares false).
func pinnedClaudeLessThanOne(value orderedNodeJSON) bool {
	number, ok := jsNumber(value)
	if !ok {
		return false
	}
	return number < 1
}

// pinnedClaudePlan is the plan for the CLAUDE source: its own URL, key, header set and body.
func pinnedClaudePlan(body orderedNodeJSON, directories startup.UserDirectories) (*outbound.Request, *pinnedChatCompletionFailure) {
	apiURL := pinnedClaudeBaseURL()
	apiKey := nodeUndefined()
	if reverseProxy, exists := body.member("reverse_proxy"); exists && pinnedJSTruthy(reverseProxy) {
		normalized, ok := pinnedJSURLString(reverseProxy)
		if !ok {
			// `new URL(value)` throws for a value that is not an absolute URL, and the pinned catch
			// answers 500 {"error":true} because the headers have not been sent.
			return nil, pinnedChatCompletionJSONFailure(http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
		}
		apiURL = normalized
		if password, exists := body.member("proxy_password"); exists {
			apiKey = password
		}
	} else {
		secret, err := pinnedReadSecret(directories, pinnedClaudeSecretKey, pinnedSecretID(body))
		if err != nil {
			return nil, pinnedChatCompletionJSONFailure(http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
		}
		apiKey = secret
	}
	if !pinnedJSTruthy(apiKey) {
		// :235-238, BEFORE any fetch: 400 {"error":true}.
		return nil, pinnedChatCompletionJSONFailure(http.StatusBadRequest, pinnedChatCompletionErrorFlag())
	}

	payload, betaHeaders, failure := pinnedClaudePayload(body)
	if failure != nil {
		return nil, failure
	}
	encoded, encodeErr := marshalOrderedNodeJSON(payload)
	if encodeErr != nil {
		return nil, pinnedChatCompletionJSONFailure(http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
	}

	keyText, keyErr := pinnedJSStringValue(apiKey)
	if keyErr != nil {
		keyText = pinnedClaudeJSString(apiKey)
	}
	// :414-419. `x-api-key`, NOT an Authorization header, plus anthropic-version, and the composed beta
	// list only when it is non-empty (it always is: the two primaries are unconditional).
	headers := map[string]string{
		"content-type":      "application/json",
		"anthropic-version": pinnedClaudeAPIVersion,
		"x-api-key":         keyText,
		"accept":            "*/*",
		"accept-encoding":   "gzip, deflate, br",
		"user-agent":        "node-fetch",
	}
	if len(betaHeaders) > 0 {
		headers["anthropic-beta"] = strings.Join(betaHeaders, ",")
	}
	headers["content-length"] = strconv.Itoa(len(encoded))

	endpointURL := apiURL + "/messages"
	parsedEndpoint, parseErr := url.Parse(endpointURL)
	if parseErr != nil || parsedEndpoint.Host == "" {
		return nil, pinnedChatCompletionJSONFailure(http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
	}

	names := make([]string, 0, len(headers)+2)
	for name := range headers {
		names = append(names, name)
	}
	sort.Strings(names)
	requestHeaders := make([]outbound.Header, 0, len(names)+2)
	for _, name := range names {
		requestHeaders = append(requestHeaders, outbound.Header{Name: name, Value: headers[name]})
	}
	requestHeaders = append(requestHeaders, outbound.Header{Name: "Host", Value: pinnedRequestHostHeader(parsedEndpoint)})
	requestHeaders = append(requestHeaders, outbound.Header{Name: "Connection", Value: "close"})

	return &outbound.Request{
		URL:     endpointURL,
		Method:  http.MethodPost,
		Headers: requestHeaders,
		Body:    encoded,
	}, nil
}

// serveClaudeChatCompletionResponse is the CLAUDE side of the response: the shared forwarder for a
// stream (:424), and the pinned rewrap for a buffered answer (:426-439).
func serveClaudeChatCompletionResponse(w http.ResponseWriter, request *http.Request, response *outbound.Response, body orderedNodeJSON) {
	if pinnedChatCompletionStreams(body) {
		// forwardFetchResponse forwards the provider's own event names and its terminator
		// (`message_stop` for Anthropic), so nothing is translated here.
		forwardPinnedChatCompletionStream(w, request, response)
		return
	}
	defer response.Stream.Close()
	providerBody, readErr := io.ReadAll(response.Stream)
	if readErr != nil && !errors.Is(readErr, io.EOF) {
		respondOrderedNodeJSON(w, http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
		return
	}
	if response.Status < 200 || response.Status > 299 {
		// The provider's text is drained and dropped; the caller only learns that it failed.
		respondOrderedNodeJSON(w, http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
		return
	}
	parsed, parseErr := decodeOrderedNodeJSON(providerBody)
	if parseErr != nil {
		// `await generateResponse.json()` throws inside the pinned try, so the catch answers 500.
		respondOrderedNodeJSON(w, http.StatusInternalServerError, pinnedChatCompletionErrorFlag())
		return
	}
	content := nodeGet(parsed, "content")
	text := ""
	// nodeGet cannot index an ARRAY (it requires an object at every step), so the pinned
	// `content?.[0]?.text` is resolved explicitly.
	if content.kind == 'a' && len(content.array) > 0 {
		if first := nodeGet(content.array[0], "text"); pinnedJSTruthy(first) {
			if value, isString := first.stringValue(); isString {
				text = value
			} else {
				text = pinnedClaudeJSString(first)
			}
		}
	}
	message := nodeObject()
	message.setMember("content", nodeString(text))
	choice := nodeObject()
	choice.setMember("message", message)
	choices := nodeArray()
	choices.array = append(choices.array, choice)
	reply := nodeObject()
	reply.setMember("choices", choices)
	if content.kind != nodeUndefinedKind {
		// `content: generateResponseJson.content` — an ABSENT provider member is dropped by
		// JSON.stringify, while an empty ARRAY is kept.
		reply.setMember("content", content)
	}
	respondOrderedNodeJSON(w, http.StatusOK, reply)
}
