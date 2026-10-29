# Frontend startup-call enumeration

GoTavern: `gotavern start --port 55927 --dataRoot <scratch>`
Requests observed during page load: 229. Page errors: 0.

> **THIS IS AN OBSERVATION, NOT AN INVENTORY, AND ITS NEGATIVE ROWS GO STALE SILENTLY.**
>
> It records one page load against one build, and it names no commit. Three of its rows were re-measured on
> 2026-10-29 with the tree at `292905f` and every one of them had moved — see the corrected rows below, each
> marked `RE-MEASURED`. Two consequences, both of which have already cost time:
>
> 1. **A route's absence here is NOT evidence of absence.** AGENTS.md rule 43 requires the route inventory to
>    be enumerated from the oracle's own lists (every `router.use(...)` mount, every `endpoints/*.js` router
>    mounted in `src/server-startup.js`, every URL a pinned frontend module builds), not accumulated from
>    whatever one page load happened to touch. Use `docs/api-inventory.md` and the rule-43 gate for the
>    question "is this route registered"; use this file only for "what did the page request, once".
> 2. **A `missing` classification is a snapshot, not a status.** `POST /api/horde/text-workers` was labelled
>    BLOCKING here and is now served and refusing (403, the pinned no-API-key answer). Re-generate this file
>    against a named build before quoting any row, and state the commit beside the numbers.

Classification: `missing` reached no registered route (work to do), `misbehaving` reached a
registered route and still errored (a bug in code we have), `cosmetic` is an image, stylesheet,
font or media request that cannot block a send, and `ok` is a 2xx.

| method | path | resource | status | classification |
| --- | --- | --- | --- | --- |
| POST | `/api/horde/text-workers` | fetch | 404 | missing — **RE-MEASURED 2026-10-29: 403 `text/html; charset=utf-8`, i.e. the route IS registered and is refusing for want of a Horde API key (`internal/server/horde.go`). Not missing.** |
| GET | `/backgrounds/__transparent.png` | image | 404 | cosmetic |
| GET | `/css/accounts.css` | stylesheet | 200 | cosmetic |
| GET | `/css/animations.css` | stylesheet | 200 | cosmetic |
| GET | `/css/backgrounds.css` | stylesheet | 200 | cosmetic |
| GET | `/css/brands.min.css` | stylesheet | 200 | cosmetic |
| GET | `/css/bright.min.css` | stylesheet | 200 | cosmetic |
| GET | `/css/character-group-overlay.css` | stylesheet | 200 | cosmetic |
| GET | `/css/chat-backups.css` | stylesheet | 200 | cosmetic |
| GET | `/css/cropper.min.css` | stylesheet | 200 | cosmetic |
| GET | `/css/data-maid.css` | stylesheet | 200 | cosmetic |
| GET | `/css/extensions-panel.css` | stylesheet | 200 | cosmetic |
| GET | `/css/file-form.css` | stylesheet | 200 | cosmetic |
| GET | `/css/fontawesome.min.css` | stylesheet | 200 | cosmetic |
| GET | `/css/group-avatars.css` | stylesheet | 200 | cosmetic |
| GET | `/css/jquery-ui.min.css` | stylesheet | 200 | cosmetic |
| GET | `/css/loader.css` | stylesheet | 200 | cosmetic |
| GET | `/css/logprobs.css` | stylesheet | 200 | cosmetic |
| GET | `/css/macros.css` | stylesheet | 200 | cosmetic |
| GET | `/css/mobile-styles.css` | stylesheet | 200 | cosmetic |
| GET | `/css/popup-safari-fix.css` | stylesheet | 200 | cosmetic |
| GET | `/css/popup.css` | stylesheet | 200 | cosmetic |
| GET | `/css/promptmanager.css` | stylesheet | 200 | cosmetic |
| GET | `/css/rm-groups.css` | stylesheet | 200 | cosmetic |
| GET | `/css/scrollable-button.css` | stylesheet | 200 | cosmetic |
| GET | `/css/secrets.css` | stylesheet | 200 | cosmetic |
| GET | `/css/select2-overrides.css` | stylesheet | 200 | cosmetic |
| GET | `/css/select2.min.css` | stylesheet | 200 | cosmetic |
| GET | `/css/solid.min.css` | stylesheet | 200 | cosmetic |
| GET | `/css/st-tailwind.css` | stylesheet | 200 | cosmetic |
| GET | `/css/streaming-display.css` | stylesheet | 200 | cosmetic |
| GET | `/css/tags.css` | stylesheet | 200 | cosmetic |
| GET | `/css/toastr.min.css` | stylesheet | 200 | cosmetic |
| GET | `/css/toggle-dependent.css` | stylesheet | 200 | cosmetic |
| GET | `/css/user.css` | stylesheet | no response | cosmetic — **RE-MEASURED 2026-10-29: 200 `text/css; charset=UTF-8`, 30 B.** |
| GET | `/css/welcome.css` | stylesheet | 200 | cosmetic |
| GET | `/css/world-info.css` | stylesheet | 200 | cosmetic |
| GET | `/img/ai4.png` | image | 200 | cosmetic |
| GET | `/img/down-arrow.svg` | image | 200 | cosmetic |
| GET | `/img/five.png` | image | 200 | cosmetic |
| GET | `/img/logo.png` | image | 200 | cosmetic |
| GET | `/lib/dialog-polyfill.css` | stylesheet | 200 | cosmetic |
| GET | `/sounds/message.mp3` | media | 206 | cosmetic |
| GET | `/style.css` | stylesheet | 200 | cosmetic |
| GET | `/thumbnail?type=persona&file=user-default.png` | image | 404 | cosmetic — **RE-MEASURED 2026-10-29: 200 `image/png`, 3184 B. `/thumbnail` is IMPLEMENTED; see AGENTS.md boundary 3, which this row's old value contradicted.** |
| GET | `/webfonts/fa-solid-900.woff2` | font | 200 | cosmetic |
| GET | `/webfonts/NotoSans/NotoSans-Bold.woff2` | font | 200 | cosmetic |
| GET | `/webfonts/NotoSans/NotoSans-Medium.woff2` | font | 200 | cosmetic |
| GET | `/webfonts/NotoSans/NotoSans-Regular.woff2` | font | 200 | cosmetic |
| GET | `/webfonts/NotoSans/stylesheet.css` | stylesheet | 200 | cosmetic |
| GET | `/webfonts/NotoSansMono/noto-sans-mono-v30-regular.woff2` | font | 200 | cosmetic |
| GET | `/webfonts/NotoSansMono/stylesheet.css` | stylesheet | 200 | cosmetic |
| GET | `/` | document | 200 | ok |
| GET | `/api/extensions/discover` | fetch | 200 | ok |
| POST | `/api/horde/status` | fetch | 200 | ok |
| POST | `/api/horde/text-models` | fetch | 200 | ok |
| POST | `/api/ping` | fetch | 204 | ok |
| POST | `/api/secrets/read` | fetch | 200 | ok |
| POST | `/api/settings/get` | fetch | 200 | ok |
| GET | `/csrf-token` | fetch | 200 | ok |
| GET | `/lib.js` | script | 200 | ok |
| GET | `/lib/cropper.min.js` | script | 200 | ok |
| GET | `/lib/dialog-polyfill.esm.js` | script | 200 | ok |
| GET | `/lib/eventemitter.js` | script | 200 | ok |
| GET | `/lib/jquery-3.5.1.min.js` | script | 200 | ok |
| GET | `/lib/jquery-cookie-1.4.1.min.js` | script | 200 | ok |
| GET | `/lib/jquery-cropper.min.js` | script | 200 | ok |
| GET | `/lib/jquery-ui.min.js` | script | 200 | ok |
| GET | `/lib/jquery.izoomify.js` | script | 200 | ok |
| GET | `/lib/jquery.transit.min.js` | script | 200 | ok |
| GET | `/lib/jquery.ui.touch-punch.min.js` | script | 200 | ok |
| GET | `/lib/pagination.js` | script | 200 | ok |
| GET | `/lib/polyfill.js` | script | 200 | ok |
| GET | `/lib/select2-search-placeholder.js` | script | 200 | ok |
| GET | `/lib/select2.min.js` | script | 200 | ok |
| GET | `/lib/structured-clone/deserialize.js` | script | 200 | ok |
| GET | `/lib/structured-clone/index.js` | script | 200 | ok |
| GET | `/lib/structured-clone/monkey-patch.js` | script | 200 | ok |
| GET | `/lib/structured-clone/serialize.js` | script | 200 | ok |
| GET | `/lib/structured-clone/types.js` | script | 200 | ok |
| GET | `/lib/swiped-events.js` | script | 200 | ok |
| GET | `/lib/toastr.min.js` | script | 200 | ok |
| GET | `/lib/toolcool-color-picker.js` | script | 200 | ok |
| GET | `/locales/lang.json` | fetch | 200 | ok |
| GET | `/script.js` | script | 200 | ok |
| GET | `/scripts/a11y.js` | script | 200 | ok |
| GET | `/scripts/action-loader-slashcommands.js` | script | 200 | ok |
| GET | `/scripts/action-loader.js` | script | 200 | ok |
| GET | `/scripts/audio-player.js` | script | 200 | ok |
| GET | `/scripts/authors-note.js` | script | 200 | ok |
| GET | `/scripts/autocomplete/AutoComplete.js` | script | 200 | ok |
| GET | `/scripts/autocomplete/AutoCompleteFuzzyScore.js` | script | 200 | ok |
| GET | `/scripts/autocomplete/AutoCompleteNameResult.js` | script | 200 | ok |
| GET | `/scripts/autocomplete/AutoCompleteNameResultBase.js` | script | 200 | ok |
| GET | `/scripts/autocomplete/AutoCompleteOption.js` | script | 200 | ok |
| GET | `/scripts/autocomplete/AutoCompleteSecondaryNameResult.js` | script | 200 | ok |
| GET | `/scripts/autocomplete/BlankAutoCompleteOption.js` | script | 200 | ok |
| GET | `/scripts/autocomplete/EnhancedMacroAutoCompleteOption.js` | script | 200 | ok |
| GET | `/scripts/autocomplete/MacroAutoComplete.js` | script | 200 | ok |
| GET | `/scripts/autocomplete/MacroAutoCompleteHelper.js` | script | 200 | ok |
| GET | `/scripts/backgrounds.js` | script | 200 | ok |
| GET | `/scripts/bookmarks.js` | script | 200 | ok |
| GET | `/scripts/browser-fixes.js` | script | 200 | ok |
| GET | `/scripts/bulk-edit.js` | script | 200 | ok |
| GET | `/scripts/BulkEditOverlay.js` | script | 200 | ok |
| GET | `/scripts/cfg-scale.js` | script | 200 | ok |
| GET | `/scripts/chat-backups.js` | script | 200 | ok |
| GET | `/scripts/chat-templates.js` | script | 200 | ok |
| GET | `/scripts/chats.js` | script | 200 | ok |
| GET | `/scripts/constants.js` | script | 200 | ok |
| GET | `/scripts/custom-request.js` | script | 200 | ok |
| GET | `/scripts/data-maid.js` | script | 200 | ok |
| GET | `/scripts/dom-handlers.js` | script | 200 | ok |
| GET | `/scripts/dragdrop.js` | script | 200 | ok |
| GET | `/scripts/dynamic-styles.js` | script | 200 | ok |
| GET | `/scripts/events.js` | script | 200 | ok |
| GET | `/scripts/extensions-slashcommands.js` | script | 200 | ok |
| GET | `/scripts/extensions.js` | script | 200 | ok |
| GET | `/scripts/extensions/regex/engine.js` | script | 200 | ok |
| GET | `/scripts/extensions/shared.js` | script | 200 | ok |
| GET | `/scripts/filters.js` | script | 200 | ok |
| GET | `/scripts/group-chats.js` | script | 200 | ok |
| GET | `/scripts/horde.js` | script | 200 | ok |
| GET | `/scripts/i18n.js` | script | 200 | ok |
| GET | `/scripts/input-md-formatting.js` | script | 200 | ok |
| GET | `/scripts/instruct-mode.js` | script | 200 | ok |
| GET | `/scripts/itemized-prompts.js` | script | 200 | ok |
| GET | `/scripts/kai-settings.js` | script | 200 | ok |
| GET | `/scripts/keyboard.js` | script | 200 | ok |
| GET | `/scripts/loader.js` | script | 200 | ok |
| GET | `/scripts/logit-bias.js` | script | 200 | ok |
| GET | `/scripts/logprobs.js` | script | 200 | ok |
| GET | `/scripts/macros.js` | script | 200 | ok |
| GET | `/scripts/macros/definitions/chat-macros.js` | script | 200 | ok |
| GET | `/scripts/macros/definitions/core-macros.js` | script | 200 | ok |
| GET | `/scripts/macros/definitions/env-macros.js` | script | 200 | ok |
| GET | `/scripts/macros/definitions/instruct-macros.js` | script | 200 | ok |
| GET | `/scripts/macros/definitions/state-macros.js` | script | 200 | ok |
| GET | `/scripts/macros/definitions/time-macros.js` | script | 200 | ok |
| GET | `/scripts/macros/definitions/variable-macros.js` | script | 200 | ok |
| GET | `/scripts/macros/engine/MacroBrowser.js` | script | 200 | ok |
| GET | `/scripts/macros/engine/MacroCstWalker.js` | script | 200 | ok |
| GET | `/scripts/macros/engine/MacroDiagnostics.js` | script | 200 | ok |
| GET | `/scripts/macros/engine/MacroEngine.js` | script | 200 | ok |
| GET | `/scripts/macros/engine/MacroEnvBuilder.js` | script | 200 | ok |
| GET | `/scripts/macros/engine/MacroFlags.js` | script | 200 | ok |
| GET | `/scripts/macros/engine/MacroLexer.js` | script | 200 | ok |
| GET | `/scripts/macros/engine/MacroParser.js` | script | 200 | ok |
| GET | `/scripts/macros/engine/MacroRegistry.js` | script | 200 | ok |
| GET | `/scripts/macros/macro-system.js` | script | 200 | ok |
| GET | `/scripts/message-formatter.js` | script | 200 | ok |
| GET | `/scripts/nai-settings.js` | script | 200 | ok |
| GET | `/scripts/openai.js` | script | 200 | ok |
| GET | `/scripts/personas.js` | script | 200 | ok |
| GET | `/scripts/popup.js` | script | 200 | ok |
| GET | `/scripts/power-user.js` | script | 200 | ok |
| GET | `/scripts/preset-manager.js` | script | 200 | ok |
| GET | `/scripts/PromptManager.js` | script | 200 | ok |
| GET | `/scripts/reasoning.js` | script | 200 | ok |
| GET | `/scripts/request-compression.js` | script | 200 | ok |
| GET | `/scripts/RossAscends-mods.js` | script | 200 | ok |
| GET | `/scripts/samplerSelect.js` | script | 200 | ok |
| GET | `/scripts/scrapers.js` | script | 200 | ok |
| GET | `/scripts/secrets.js` | script | 200 | ok |
| GET | `/scripts/server-history.js` | script | 200 | ok |
| GET | `/scripts/setting-search.js` | script | 200 | ok |
| GET | `/scripts/showdown-exclusion.js` | script | 200 | ok |
| GET | `/scripts/showdown-underscore.js` | script | 200 | ok |
| GET | `/scripts/slash-commands.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/AbstractEventTarget.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommand.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandAbortController.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandArgument.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandAutoCompleteNameResult.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandBreak.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandBreakController.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandBreakPoint.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandBrowser.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandClosure.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandClosureResult.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandCommandAutoCompleteOption.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandCommonEnumsProvider.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandDebugController.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandEnumAutoCompleteOption.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandEnumValue.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandExecutionError.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandExecutor.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandNamedArgumentAssignment.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandNamedArgumentAutoCompleteOption.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandParser.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandParserError.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandQuickReplyAutoCompleteOption.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandReturnHelper.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandScope.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandUnnamedArgumentAssignment.js` | script | 200 | ok |
| GET | `/scripts/slash-commands/SlashCommandVariableAutoCompleteOption.js` | script | 200 | ok |
| GET | `/scripts/sse-stream.js` | script | 200 | ok |
| GET | `/scripts/st-context.js` | script | 200 | ok |
| GET | `/scripts/stats.js` | script | 200 | ok |
| GET | `/scripts/swipe-picker.js` | script | 200 | ok |
| GET | `/scripts/sysprompt.js` | script | 200 | ok |
| GET | `/scripts/system-messages.js` | script | 200 | ok |
| GET | `/scripts/tags.js` | script | 200 | ok |
| GET | `/scripts/templates.js` | script | 200 | ok |
| GET | `/scripts/templates/assistantNote.html` | xhr | 200 | ok |
| GET | `/scripts/templates/formatting.html` | xhr | 200 | ok |
| GET | `/scripts/templates/help.html` | xhr | 200 | ok |
| GET | `/scripts/templates/hotkeys.html` | xhr | 200 | ok |
| GET | `/scripts/templates/wandButton.html` | xhr | 200 | ok |
| GET | `/scripts/templates/wandMenu.html` | xhr | 200 | ok |
| GET | `/scripts/templates/welcome.html` | xhr | 200 | ok |
| GET | `/scripts/templates/welcomePrompt.html` | xhr | 200 | ok |
| GET | `/scripts/textgen-models.js` | script | 200 | ok |
| GET | `/scripts/textgen-settings.js` | script | 200 | ok |
| GET | `/scripts/tokenizers.js` | script | 200 | ok |
| GET | `/scripts/tool-calling.js` | script | 200 | ok |
| GET | `/scripts/user.js` | script | 200 | ok |
| GET | `/scripts/util/AbortReason.js` | script | 200 | ok |
| GET | `/scripts/util/AccountStorage.js` | script | 200 | ok |
| GET | `/scripts/util/showdown-patch.js` | script | 200 | ok |
| GET | `/scripts/util/SimpleMutex.js` | script | 200 | ok |
| GET | `/scripts/util/stream-fadein.js` | script | 200 | ok |
| GET | `/scripts/util/StructuredCloneMap.js` | script | 200 | ok |
| GET | `/scripts/util/ThemeGenerator.js` | script | 200 | ok |
| GET | `/scripts/utils.js` | script | 200 | ok |
| GET | `/scripts/variables.js` | script | 200 | ok |
| GET | `/scripts/welcome-screen.js` | script | 200 | ok |
| GET | `/scripts/world-info.js` | script | 200 | ok |
| GET | `/version` | fetch | 200 | ok |

## Blocking candidates: 1 missing, 0 misbehaving

- POST `/api/horde/text-workers` (fetch)

**WITHDRAWN 2026-10-29.** Re-measured against `292905f`: the route answers **403 `text/html; charset=utf-8`**,
which is the pinned no-API-key refusal, so it is REGISTERED and no longer a blocking candidate. The list above
is kept as the observation it was; the count is not a current status. See the header note.

No registered route answered an error during load.

