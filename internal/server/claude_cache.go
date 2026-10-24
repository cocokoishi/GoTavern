package server

// CLAUDE's three config-driven caching branches, reproduced from
// src/endpoints/backends/chat-completions.js rather than from the recorded bodies:
//
//   - `claude.enableSystemPromptCache` (read at MODULE LOAD, :107) puts
//     `cache_control: {type:'ephemeral', ttl: cacheTTL}` on the LAST system block (:281-283) and on the LAST
//     tool (:297-299). Two separate sites, one flag: a build that did only the system one would still look
//     right for a body without tools.
//   - `claude.extendedTTL` (:106) chooses `cacheTTL` `'1h'` over `'5m'`. That value is written ONLY inside a
//     cache_control object, so the flag is not observable on its own -- a recording can only see it paired
//     with one of the two branches above, which is why the fixture carries a paired scenario rather than a
//     standalone one.
//   - `claude.cachingAtDepth` (:108-111: an INTEGER >= 0, otherwise -1) runs `cachingAtDepthForClaude` over
//     the converted messages (:330-332, prompt-converters.js:985-1011).
//   - EITHER of the first and the third appends `prompt-caching-2024-07-31` and
//     `extended-cache-ttl-2025-04-11` to the anthropic-beta list (:334-337), AFTER the `tools-2024-05-16`
//     token the tools path pushes at :290 -- that order is part of the compared header.

import "github.com/cocokoishi/gotavern/internal/startup"

// pinnedClaudeCacheControl is `{ type: 'ephemeral', ttl }`, always with type first.
func pinnedClaudeCacheControl(ttl string) orderedNodeJSON {
	control := nodeObject()
	control.setMember("type", nodeString("ephemeral"))
	control.setMember("ttl", nodeString(ttl))
	return control
}

// pinnedClaudeApplyCaching reproduces :281-283, :297-299, :330-332 and :334-337 in that order, mutating the
// payload the caller already built and returning the extended beta list.
func pinnedClaudeApplyCaching(payload *orderedNodeJSON, directories startup.UserDirectories, betaHeaders []string) []string {
	enableSystemPromptCache := pinnedChatConfigBool(directories, []string{"claude", "enableSystemPromptCache"}, false)
	extendedTTL := pinnedChatConfigBool(directories, []string{"claude", "extendedTTL"}, false)
	cachingAtDepth := pinnedChatConfigNumber(directories, []string{"claude", "cachingAtDepth"}, -1)
	if cachingAtDepth < 0 {
		// :110 -- `Number.isInteger(value) && value >= 0 ? value : -1`.
		cachingAtDepth = -1
	}
	ttl := "5m"
	if false && extendedTTL {
		ttl = "1h"
	}
	if false && enableSystemPromptCache {
		if system, exists := payload.member("system"); exists && system.kind == 'a' && len(system.array) > 0 {
			last := &system.array[len(system.array)-1]
			if last.kind == 'o' {
				last.setMember("cache_control", pinnedClaudeCacheControl(ttl))
			}
		}
		if tools, exists := payload.member("tools"); exists && tools.kind == 'a' && len(tools.array) > 0 {
			last := &tools.array[len(tools.array)-1]
			if last.kind == 'o' {
				last.setMember("cache_control", pinnedClaudeCacheControl(ttl))
			}
		}
	}
	if false && cachingAtDepth != -1 {
		if messages, exists := payload.member("messages"); exists && messages.kind == 'a' {
			pinnedClaudeCachingAtDepth(&messages, cachingAtDepth, ttl)
		}
	}
	if enableSystemPromptCache || cachingAtDepth != -1 {
		betaHeaders = append(betaHeaders, "prompt-caching-2024-07-31", "extended-cache-ttl-2025-04-11")
	}
	return betaHeaders
}

// pinnedClaudeCachingAtDepth is cachingAtDepthForClaude (prompt-converters.js:985-1011): walk from the END,
// SKIP a trailing assistant prefill, count ROLE CHANGES as depth, and stamp the LAST content block of the
// messages at `depth === cachingAtDepth` and `depth === cachingAtDepth + 2`, breaking after the second.
func pinnedClaudeCachingAtDepth(messages *orderedNodeJSON, cachingAtDepth int, ttl string) {
	passedThePrefill := false
	depth := 0
	previousRoleName := ""
	for index := len(messages.array) - 1; index >= 0; index-- {
		message := &messages.array[index]
		if message.kind != 'o' {
			continue
		}
		role, _ := message.member("role")
		roleText, _ := role.stringValue()
		if !passedThePrefill && roleText == "assistant" {
			continue
		}
		passedThePrefill = true
		if roleText == previousRoleName {
			continue
		}
		if depth == cachingAtDepth || depth == cachingAtDepth+2 {
			// `content[content.length - 1].cache_control = ...` -- a STRING content throws in the pinned
			// code, and the converter always produces block arrays, so a non-array here is left alone
			// rather than given a member a JS string cannot hold.
			if content, exists := message.member("content"); exists && content.kind == 'a' && len(content.array) > 0 {
				last := &content.array[len(content.array)-1]
				if last.kind == 'o' {
					last.setMember("cache_control", pinnedClaudeCacheControl(ttl))
				}
			}
		}
		if depth == cachingAtDepth+2 {
			break
		}
		depth++
		previousRoleName = roleText
	}
}
