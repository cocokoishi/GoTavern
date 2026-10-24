package server

// OPENROUTER's two message transforms, reproduced from the pinned source rather than from the recorded
// scenario text: `embedOpenRouterMedia` (src/prompt-converters.js:1336-1370) and `addOpenRouterSignatures`
// (src/prompt-converters.js:1397-1451), both called from the OPENROUTER arm at
// src/endpoints/backends/chat-completions.js:2372-2374 inside `Array.isArray(request.body.messages)`.
//
// THE SEMANTICS THAT ARE EASY TO GET WRONG, each because "tidier" code changes the bytes:
//
//   - THE MEDIA TRANSFORM IS AN AUDIO TRANSFORM. It has no `image_url` branch at all (:1336-1370), so an
//     image part is passed through whatever its scheme, and the audio branch tests `startsWith('data:')`
//     rather than the part type, so a REMOTE audio url keeps its `audio_url` member. A rewrite that
//     converted every audio part, or that handled images, would diverge on both counts.
//   - THE MIME MAP HAS TWO ENTRIES AND A FALLBACK (:1352-1363): audio/mpeg -> mp3, audio/wav -> wav, and
//     EVERY other type (including a header with no ';') falls back to mp3. The data payload is the text
//     after the first comma verbatim.
//   - THE `video_url` BRANCH IS A NO-OP (:1347-1349): it assigns the type the part already has. It is
//     reproduced rather than dropped so a reader can see it was considered, and so a future change to it
//     is visible here.
//   - THE ORDER OF MEMBERS AFTER THE REWRITE (:1351-1367): `type` is REPLACED in place, `input_audio` is
//     APPENDED, and `audio_url` is DELETED -- leaving {type, input_audio}. Appending `input_audio` before
//     rewriting `type` would produce a different member order, which is a different body on the wire.
//   - THE TWO SIGNATURE SOURCES HAVE DIFFERENT ID RULES (:1420-1446): a message-level signature gets a
//     generated id `signature-<n>` (n = the number of details collected so far), while a tool-call
//     signature gets the TOOL CALL's own id. `index` is the collected count in both cases, so suppressing
//     the message-level entry renumbers the tool-call entry.
//   - ONLY THE MESSAGE-LEVEL HALF IS CONFIG-GATED (:1433-1438): a tool-call signature is always
//     converted. Both source members are deleted either way.
//   - THE FORMAT COMES FROM THE MODEL STRING (:1398-1412), with UNANCHORED regexes, so `foo/google/gemini-x`
//     matches google-gemini-v1 exactly as `google/gemini-x` does; anything else is the literal 'unknown'.

import (
	"strconv"
	"strings"
)

// pinnedChatCompletionOpenRouterMessageTransforms reproduces chat-completions.js:2372-2374. It runs BEFORE
// the assembly, because the assembly copies `body.member("messages")` into the outbound body
// (chat_completions.go:682): a mutation after that point would be invisible. The pointer to `body` is what
// lets a rewrite survive this frame -- the same reason the moonshot arm takes one.
func pinnedChatCompletionOpenRouterMessageTransforms(body *orderedNodeJSON, thoughtSignatures bool) {
	messages, exists := body.member("messages")
	if !exists || messages.kind != 'a' {
		return
	}
	// The caller passes {audio: true, video: true} (:2373), so both branches are live for this source.
	pinnedOpenRouterEmbedMedia(&messages, true, true)
	pinnedOpenRouterSignatures(&messages, pinnedOpenRouterModel(*body), thoughtSignatures)
	body.setMember("messages", messages)
}

// pinnedOpenRouterModel is the `model` member the signature format table keys on. An absent member is the
// empty string, which matches no table prefix and therefore takes the 'unknown' arm, as `undefined` does
// in the pinned regex tests.
func pinnedOpenRouterModel(body orderedNodeJSON) string {
	if model, exists := body.member("model"); exists {
		if text, ok := model.stringValue(); ok {
			return text
		}
	}
	return ""
}

// pinnedOpenRouterEmbedMedia is embedOpenRouterMedia (prompt-converters.js:1336-1370).
func pinnedOpenRouterEmbedMedia(messages *orderedNodeJSON, audio, video bool) {
	if messages.kind != 'a' {
		return
	}
	for index := range messages.array {
		message := &messages.array[index]
		if message.kind != 'o' {
			continue
		}
		content, exists := message.member("content")
		if !exists || content.kind != 'a' {
			continue
		}
		for partIndex := range content.array {
			part := &content.array[partIndex]
			if part.kind != 'o' {
				continue
			}
			kind := ""
			if value, exists := part.member("type"); exists {
				kind, _ = value.stringValue()
			}
			if video && kind == "video_url" {
				if url, ok := pinnedOpenRouterNestedURL(part, "video_url"); ok && strings.HasPrefix(url, "data:") {
					// The pinned statement, kept with its no-op effect and its position.
					part.setMember("type", nodeString("video_url"))
				}
			}
			if !audio || kind != "audio_url" {
				continue
			}
			url, ok := pinnedOpenRouterNestedURL(part, "audio_url")
			if !ok || !strings.HasPrefix(url, "data:") {
				continue
			}
			header, data, hasData := strings.Cut(url, ",")
			format := "mp3"
			if pinnedOpenRouterDataMime(header) == "audio/wav" {
				format = "wav"
			}
			part.setMember("type", nodeString("input_audio"))
			inputAudio := nodeObject()
			inputAudio.setMember("format", nodeString(format))
			if hasData {
				// `const [header, base64Data] = url.split(',')` leaves base64Data undefined for a data URL
				// with no comma, and JSON.stringify drops an undefined member, so `data` is then ABSENT.
				inputAudio.setMember("data", nodeString(data))
			}
			part.setMember("input_audio", inputAudio)
			part.deleteMember("audio_url")
		}
	}
}

// pinnedOpenRouterNestedURL reads `<holder>.url` as a string: the shape every media part uses.
func pinnedOpenRouterNestedURL(part *orderedNodeJSON, holder string) (string, bool) {
	object, exists := part.member(holder)
	if !exists || object.kind != 'o' {
		return "", false
	}
	url, exists := object.member("url")
	if !exists || url.kind != 's' {
		return "", false
	}
	text, ok := url.stringValue()
	return text, ok
}

// pinnedOpenRouterDataMime is `header.match(/data:([^;]+)/)?.[1] || 'audio/mpeg'` (:1357-1358). The
// capture needs at least one non-';' character, so `data:;base64` falls back just as an absent marker
// does, while `data:audio/wav` with no parameters returns the type itself.
func pinnedOpenRouterDataMime(header string) string {
	const marker = "data:"
	start := strings.Index(header, marker)
	if start < 0 {
		return "audio/mpeg"
	}
	rest := header[start+len(marker):]
	if end := strings.IndexByte(rest, ';'); end >= 0 {
		rest = rest[:end]
	}
	if rest == "" {
		return "audio/mpeg"
	}
	return rest
}

// pinnedOpenRouterSignatures is addOpenRouterSignatures (prompt-converters.js:1397-1451).
func pinnedOpenRouterSignatures(messages *orderedNodeJSON, model string, thoughtSignatures bool) {
	if messages.kind != 'a' {
		return
	}
	format := pinnedOpenRouterSignatureFormat(model)
	for index := range messages.array {
		message := &messages.array[index]
		if message.kind != 'o' {
			continue
		}
		details := nodeArray()
		addDetail := func(data, id string) {
			// `typeof data !== 'string' || data.length === 0` skips an empty signature (:1421-1423).
			if data == "" {
				return
			}
			position := len(details.array)
			detail := nodeObject()
			detail.setMember("index", nodeNumber(float64(position)))
			if id == "" {
				id = "signature-" + strconv.Itoa(position)
			}
			detail.setMember("id", nodeString(id))
			detail.setMember("type", nodeString("reasoning.encrypted"))
			detail.setMember("data", nodeString(data))
			detail.setMember("format", nodeString(format))
			details.array = append(details.array, detail)
		}
		if signature, exists := message.member("signature"); exists && signature.kind == 's' {
			text, _ := signature.stringValue()
			if thoughtSignatures {
				addDetail(text, "")
			}
			message.deleteMember("signature")
		}
		if toolCalls, exists := message.member("tool_calls"); exists && toolCalls.kind == 'a' {
			for toolIndex := range toolCalls.array {
				toolCall := &toolCalls.array[toolIndex]
				if toolCall.kind != 'o' {
					continue
				}
				signature, exists := toolCall.member("signature")
				if !exists || signature.kind != 's' {
					continue
				}
				text, _ := signature.stringValue()
				id := ""
				if value, exists := toolCall.member("id"); exists {
					id, _ = value.stringValue()
				}
				// NOT gated: a tool-call signature is always converted (:1439-1446).
				addDetail(text, id)
				toolCall.deleteMember("signature")
			}
		}
		if len(details.array) > 0 {
			message.setMember("reasoning_details", details)
		}
	}
}

// pinnedOpenRouterSignatureFormat is the model-prefix table at prompt-converters.js:1398-1412. The pinned
// tests are UNANCHORED regexes, so a substring test is the faithful equivalent.
func pinnedOpenRouterSignatureFormat(model string) string {
	switch {
	case strings.Contains(model, "google/gemini"):
		return "google-gemini-v1"
	case strings.Contains(model, "anthropic/claude"):
		return "anthropic-claude-v1"
	case strings.Contains(model, "openai/gpt"):
		return "openai-responses-v1"
	case strings.Contains(model, "x-ai/grok"):
		return "xai-responses-v1"
	default:
		return "unknown"
	}
}
