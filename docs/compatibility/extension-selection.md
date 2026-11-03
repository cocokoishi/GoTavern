# Third-party extension corpus and selection methodology (alpha.13)

This document and `tests/browser/third-party-extensions.lock.json` are the reproducible, pinned corpus of 20 real,
public, safe, non-NSFW SillyTavern **client-side** third-party extensions for alpha.13, together with the
101-repository candidate pool they were selected from. Every number here is from one GitHub API snapshot;
nothing is estimated and no repository is fabricated.

> This is not an official Top 20; it is the top 20 eligible extensions by the documented popularity snapshot/ranking methodology.

## 1. Snapshot

- Snapshot timestamp (all rows): `2026-11-03T01:35:43Z` (UTC).
- Source: authenticated GitHub REST API (`gh api`), account `cocokoishi`.
- Pinned stock SillyTavern baseline used to judge what a client extension is: SillyTavern 1.19.0 @ `06bde939fb1e9c4c8d8641d810f0a916b5bce127`.
- Candidate pool: **101 distinct repositories**; eligible after filters and testability: **61**; selected: **20**.
- Every selected extension's default-branch HEAD commit was resolved at the snapshot and verified to be a 40-hex commit that the API returns (`repos/OWNER/REPO/commits?per_page=1` then `repos/OWNER/REPO/commits/<sha>`); each was then checked out with `git fetch --depth 1 origin <sha>` and re-hashed locally.

## 2. Methodology

Popularity snapshot captured with the authenticated GitHub REST API at 2026-11-03T01:35:43Z using the following searches (search/repositories, sort=stars, order=desc, per_page=100): "topic:sillytavern-extension"; "topic:sillytavern-extensions"; "topic:sillytavern"; "sillytavern extension in:name,description"; "sillytavern-extensions in:name,description"; "sillytavern extension in:description"; "sillytavern extension in:name"; plus "org:SillyTavern", "topic:sillytavern-plugin", "topic:tavern-helper", and the author listings users/LenAnderson/repos, users/bmen25124/repos, users/Lodactio/repos. Additional exclusion-evidence searches were "JS-Slash-Runner" and '"Tavern Helper" in:name,description'. Duplicates are removed by repository full_name case-insensitively, keeping the most-starred row, and forks/mirrors are not counted separately when a canonical or more-starred copy is present. Candidate inclusion: a repository that those queries surfaced as a SillyTavern extension candidate with at least 30 stars at the snapshot, every SillyTavern-org downloadable client extension, every Tavern Helper family repository surfaced by the dedicated searches, and the non-client/other-category repositories those same queries return near the top. Ranking for eligible candidates is stars PRIMARY descending, forks SECONDARY descending, pushedAt TIE BREAKER descending, then official/community-listing membership as the final tie breaker (the official listing is https://docs.sillytavern.app/extensions/ and the SillyTavern org extension repositories; the community listing is the topic/author search surface above). The 20 selected are the top 20 eligible repositories after those filters; testability exclusions are recorded with the failing reason in the candidate table. This is not an official Top 20; it is the top 20 eligible extensions by the documented popularity snapshot/ranking methodology.

### 2.1 Exact query invocations

```text
gh api -X GET search/repositories -f q='topic:sillytavern-extension'            -f sort=stars -f order=desc -f per_page=100
gh api -X GET search/repositories -f q='topic:sillytavern-extensions'           -f sort=stars -f order=desc -f per_page=100
gh api -X GET search/repositories -f q='topic:sillytavern'                      -f sort=stars -f order=desc -f per_page=100
gh api -X GET search/repositories -f q='sillytavern extension in:name,description'      -f sort=stars -f order=desc -f per_page=100
gh api -X GET search/repositories -f q='sillytavern-extensions in:name,description'     -f sort=stars -f order=desc -f per_page=100
gh api -X GET search/repositories -f q='sillytavern extension in:description'           -f sort=stars -f order=desc -f per_page=100
gh api -X GET search/repositories -f q='sillytavern extension in:name'                  -f sort=stars -f order=desc -f per_page=100
gh api -X GET search/repositories -f q='org:SillyTavern'                        -f sort=stars -f order=desc -f per_page=100
gh api -X GET search/repositories -f q='topic:sillytavern-plugin'               -f sort=stars -f order=desc -f per_page=100
gh api -X GET search/repositories -f q='topic:tavern-helper'                    -f sort=stars -f order=desc -f per_page=100
gh api -X GET search/repositories -f q='JS-Slash-Runner'                        -f sort=stars -f order=desc -f per_page=100
gh api -X GET search/repositories -f q='"Tavern Helper" in:name,description'    -f sort=stars -f order=desc -f per_page=100
gh api 'users/LenAnderson/repos?per_page=100&sort=updated'
gh api 'users/bmen25124/repos?per_page=100&sort=updated'
gh api 'users/Lodactio/repos?per_page=100&sort=updated'
```

### 2.2 Deduplication and ranking

- Deduplicate by repository `full_name` case-insensitively; keep the most-starred row when a query returns a repository more than once.
- Fork/mirror policy: when a fork/mirror/rename is a duplicate of a canonical project, the canonical (or the most-starred public copy) represents the family once; no family is counted twice. No repository in the pool is an exact duplicate.
- Eligible ranking keys, applied in order: **stars descending**, **forks descending**, **`pushedAt` descending**, then **official/community listing membership** as the final tie breaker (official listing = <https://docs.sillytavern.app/extensions/> plus the SillyTavern org extension repositories; community listing = the topic/author search surface above). The tie breakers were not needed at the top-20 cut.
- The 20 selected are the **top 20 eligible** repositories under that ordering; the cut is rank 20 at **61 stars**, with the next eligible repository at **58 stars**. No filter was relaxed to reach 20.

### 2.3 Filters and testability (applied to every candidate)

1. **Client extension only.** The repository must be a SillyTavern client-side extension installed into `extensions/third-party/`, i.e. a `manifest.json` at the repository root whose `js` entry is loaded by the pinned frontend. Server plugins (installed under `plugins/`, `enableServerPlugins`), launchers, documentation, content/preset/theme/card repositories, templates, standalone apps and non-SillyTavern tools are excluded with a recorded reason.
2. **Tavern Helper exclusion (non-negotiable).** `N0VI028/JS-Slash-Runner` (Tavern Helper / 酒馆助手 / JS-Slash-Runner), and every fork, mirror, rename, alias, documentation repository or companion template that names or derives from it, are excluded in every form. The candidate table records the canonical repository and the two companion repositories the dedicated searches returned.
3. **NSFW exclusion.** Judged from README/description/topics/assets/metadata, not from the name alone: pornography, explicit sexual content, hentai, explicit sexual image generation, fetish-specific content and adult-only assets are excluded with the specific README evidence in `exclusionReason`.
4. **Security exclusion.** Credential harvesters, token stealers, arbitrary remote loaders, suspicious minified binary blobs, unexplained executable payloads, malicious postinstall scripts, crypto miners, obfuscated downloaders and arbitrary-code-execution extensions are excluded. The 20 selected were checked out at the pinned commit and their runtime JavaScript was scanned for `package.json` install hooks, `eval(atob(`, remote script injection, `child_process`, oversized base64 blobs and unexpected external origins; the findings are summarised per extension in `safetyReview`.
5. **Testability.** `manifest.json` must exist at the **repository root** (the harness installs the checkout as `<extensions>/<name>` and the pinned frontend fetches `/scripts/extensions/third-party/<name>/manifest.json`); a manifest that only exists in `dist/` or a subdirectory is excluded with that reason. The extension must load without mandatory credentials and without a mandatory external server; a candidate whose core function needs a provider key, a companion server plugin or a self-hosted service just to initialise was skipped in favour of the next eligible candidate and the reason is recorded.
6. **Network/credentials fields.** `networkRequired` and `credentialsRequired` describe what a normal load/activation needs, not optional features. All 20 selected load from the pinned frontend with no extension-specific credential and no mandatory external service; extensions that use the user's already-configured ST provider route through ST, and optional external endpoints are off by default.

## 3. Candidate pool (101 repositories)

| repository | stars | forks | license | status | reason (when excluded) |
| --- | --- | --- | --- | --- | --- |
| [N0VI028/JS-Slash-Runner](https://github.com/N0VI028/JS-Slash-Runner) | 1396 | 116 | NOASSERTION | excluded | Tavern Helper / 酒馆助手 / JS-Slash-Runner: excluded by policy in every form (canonical repository). |
| [SillyTavern/SillyTavern-Extras](https://github.com/SillyTavern/SillyTavern-Extras) | 706 | 148 | AGPL-3.0 | excluded | Non-client: server-side Extensions API (obsolete); not a client extension. |
| [SillyTavern/SillyTavern-Launcher](https://github.com/SillyTavern/SillyTavern-Launcher) | 596 | 128 | MIT | excluded | Non-extension: installer/launcher scripts, not a SillyTavern extension. |
| [SpicyMarinara/rpg-companion-sillytavern](https://github.com/SpicyMarinara/rpg-companion-sillytavern) | 329 | 71 | NOASSERTION | eligible, rank 1 |  |
| [ZerxZ/SillyTavern-Extension-ZerxzLib](https://github.com/ZerxZ/SillyTavern-Extension-ZerxzLib) | 284 | 21 | AGPL-3.0 | excluded | Testability/credentials: archived extension whose only function is rotating multiple Gemini API keys, so it requires provider credentials entered in the extension before doing anything (credential-free activation preference). |
| [SenriYuki/SillyTavern-Horae](https://github.com/SenriYuki/SillyTavern-Horae) | 206 | 27 | NOASSERTION | eligible, rank 2 |  |
| [bmen25124/SillyTavern-Character-Creator](https://github.com/bmen25124/SillyTavern-Character-Creator) | 185 | 25 | MIT | eligible, rank 3 |  |
| [StageDog/tavern_helper_template](https://github.com/StageDog/tavern_helper_template) | 182 | 147 | NOASSERTION | excluded | Tavern Helper companion template; the policy excludes Tavern Helper in every form, including templates and derivatives. |
| [Lodactio/Extension-Summaryception](https://github.com/Lodactio/Extension-Summaryception) | 182 | 38 | AGPL-3.0 | eligible, rank 4 |  |
| [SillyTavern/SillyTavern-Docs](https://github.com/SillyTavern/SillyTavern-Docs) | 181 | 395 | AGPL-3.0 | excluded | Non-extension: documentation website. |
| [cierru/st-stepped-thinking](https://github.com/cierru/st-stepped-thinking) | 173 | 19 | MIT | eligible, rank 5 |  |
| [Sillyanonymous/SillyTavern-CharacterLibrary](https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary) | 159 | 33 | AGPL-3.0 | excluded | NSFW: README documents an NSFW content toggle and CharacterTavern NSFW access for browsing adult character cards. |
| [bmen25124/SillyTavern-WorldInfo-Recommender](https://github.com/bmen25124/SillyTavern-WorldInfo-Recommender) | 135 | 18 | MIT | eligible, rank 6 |  |
| [SillyTavern/SillyTavern-Timelines](https://github.com/SillyTavern/SillyTavern-Timelines) | 127 | 16 | MIT | eligible, rank 7 |  |
| [mattjaybe/SillyTavern-Pathweaver](https://github.com/mattjaybe/SillyTavern-Pathweaver) | 123 | 7 | MIT | excluded | NSFW: advertises an optional "Explicit" NSFW spicy-suggestion mode with adult content. |
| [mattjaybe/SillyTavern-EchoChamber](https://github.com/mattjaybe/SillyTavern-EchoChamber) | 105 | 12 | MIT | excluded | NSFW: ships dedicated NSFW/Erotic chat styles documented as explicit sexual content. |
| [bmen25124/SillyTavern-MCP-Client](https://github.com/bmen25124/SillyTavern-MCP-Client) | 98 | 8 | MIT | excluded | Testability: requires the companion SillyTavern MCP server plugin (a server-side component) before it can initialise. |
| [SillyTavern/Extension-TopInfoBar](https://github.com/SillyTavern/Extension-TopInfoBar) | 97 | 17 | AGPL-3.0 | eligible, rank 8 |  |
| [NemoVonNirgend/NemoPresetExt](https://github.com/NemoVonNirgend/NemoPresetExt) | 95 | 12 | NOASSERTION | eligible, rank 9 |  |
| [pixelnull/sillytavern-DeepLore](https://github.com/pixelnull/sillytavern-DeepLore) | 91 | 15 | MIT | excluded | Testability: its manifest display name is "DeepLore (Obsidian required)"; the core function requires a running Obsidian vault with the Local REST API service. |
| [SillyTavern/Extension-Live2d](https://github.com/SillyTavern/Extension-Live2d) | 88 | 21 | GPL-3.0 | eligible, rank 10 |  |
| [bmen25124/SillyTavern-Roadway](https://github.com/bmen25124/SillyTavern-Roadway) | 83 | 13 | MIT | eligible, rank 11 |  |
| [Supker/ST-Copilot](https://github.com/Supker/ST-Copilot) | 80 | 12 | MIT | eligible, rank 12 |  |
| [bal-spec/sillytavern-character-memory](https://github.com/bal-spec/sillytavern-character-memory) | 78 | 6 | NOASSERTION | eligible, rank 13 |  |
| [SillyTavern/Extension-QuickPersona](https://github.com/SillyTavern/Extension-QuickPersona) | 76 | 14 | AGPL-3.0 | eligible, rank 14 |  |
| [Bronya-Rand/Guinevere-UI-Extension](https://github.com/Bronya-Rand/Guinevere-UI-Extension) | 72 | 9 | AGPL-3.0 | eligible, rank 15 |  |
| [senjinthedragon/Smart-Memory](https://github.com/senjinthedragon/Smart-Memory) | 71 | 10 | AGPL-3.0 | excluded | Testability: core memory extraction/retrieval requires an embedding server (Ollama or an OpenAI-compatible /v1/embeddings endpoint) configured. |
| [ackness/covel](https://github.com/ackness/covel) | 66 | 20 | MIT | excluded | Non-client: standalone agentic RPG application/framework; not a SillyTavern extension. |
| [closuretxt/recast-post-processing](https://github.com/closuretxt/recast-post-processing) | 66 | 7 | AGPL-3.0 | eligible, rank 16 |  |
| [SillyTavern/Extension-VRM](https://github.com/SillyTavern/Extension-VRM) | 65 | 16 | GPL-3.0 | eligible, rank 17 |  |
| [Bronya-Rand/Prome-VN-Extension](https://github.com/Bronya-Rand/Prome-VN-Extension) | 65 | 9 | AGPL-3.0 | eligible, rank 18 |  |
| [SillyTavern/SillyTavern-WebSearch-Selenium](https://github.com/SillyTavern/SillyTavern-WebSearch-Selenium) | 65 | 8 | AGPL-3.0 | excluded | Non-client: server plugin installed under plugins/, not a client extension. |
| [prolix-oc/SillyTavern-SimTracker](https://github.com/prolix-oc/SillyTavern-SimTracker) | 64 | 7 | NOASSERTION | eligible, rank 19 |  |
| [InspectorCaracal/SillyTavern-ReMemory](https://github.com/InspectorCaracal/SillyTavern-ReMemory) | 61 | 7 | AGPL-3.0 | eligible, rank 20 |  |
| [laboratoiresonore/spellcaster](https://github.com/laboratoiresonore/spellcaster) | 61 | 3 | NOASSERTION | excluded | Non-client: desktop AI image-editing toolchain (GIMP/DaVinci Resolve); not a SillyTavern extension. |
| [Min3Mast3r4653/SillyTavern-Extensions-and-Themes](https://github.com/Min3Mast3r4653/SillyTavern-Extensions-and-Themes) | 60 | 6 | NOASSERTION | excluded | Non-extension: link-list repository of extensions/themes. |
| [SillyTavern/Extension-WebSearch](https://github.com/SillyTavern/Extension-WebSearch) | 59 | 23 | AGPL-3.0 | excluded | Testability: core function requires an external search provider (SearXNG instance, SerpApi/Tavily/Serper key, Extras API, or a Selenium server plugin). |
| [Kristyku/InlineSummary](https://github.com/Kristyku/InlineSummary) | 58 | 11 | NOASSERTION | eligible, rank 21 |  |
| [DangerDaza/Dooms-Enhancement-Suite](https://github.com/DangerDaza/Dooms-Enhancement-Suite) | 57 | 9 | NOASSERTION | eligible, rank 22 |  |
| [SillyTavern/Extension-PromptInspector](https://github.com/SillyTavern/Extension-PromptInspector) | 55 | 10 | AGPL-3.0 | eligible, rank 23 |  |
| [SillyTavern/SillyTavern-Content](https://github.com/SillyTavern/SillyTavern-Content) | 53 | 49 | MIT | excluded | Non-extension: official content/asset repository. |
| [bmen25124/SillyTavern-WeatherPack](https://github.com/bmen25124/SillyTavern-WeatherPack) | 53 | 3 | MIT | eligible, rank 24 |  |
| [bmen25124/SillyTavern-MCP-Server](https://github.com/bmen25124/SillyTavern-MCP-Server) | 51 | 6 | MIT | excluded | Non-client: server plugin companion, not a client extension. |
| [mattjaybe/SillyTavern-EchoText](https://github.com/mattjaybe/SillyTavern-EchoText) | 49 | 7 | MIT | excluded | NSFW: documents explicit/erotic mood dimensions and NSFW chat styles. |
| [AyeeMinerva/SillyTavern-Extension-ChatBridge](https://github.com/AyeeMinerva/SillyTavern-Extension-ChatBridge) | 49 | 4 | AGPL-3.0 | excluded | Testability: a WebSocket bridge whose function requires an external client application/endpoint; it does nothing standalone. |
| [Lol1p0p/narrative-agent](https://github.com/Lol1p0p/narrative-agent) | 48 | 2 | MIT | eligible, rank 25 |  |
| [SillyTavern/SillyTavern-Fandom-Scraper](https://github.com/SillyTavern/SillyTavern-Fandom-Scraper) | 47 | 11 | AGPL-3.0 | excluded | Non-client: server plugin, not a client extension. |
| [SillyTavern/Extension-TypingIndicator](https://github.com/SillyTavern/Extension-TypingIndicator) | 46 | 10 | AGPL-3.0 | eligible, rank 26 |  |
| [bmen25124/SillyTavern-WTracker](https://github.com/bmen25124/SillyTavern-WTracker) | 44 | 11 | MIT | eligible, rank 27 |  |
| [bmen25124/SillyTavern-Custom-Scenario](https://github.com/bmen25124/SillyTavern-Custom-Scenario) | 42 | 4 | MIT | eligible, rank 28 |  |
| [platberlitz/sillytavern-image-gen](https://github.com/platberlitz/sillytavern-image-gen) | 41 | 6 | MIT | excluded | Testability: core function requires a configured image-generation provider/backend and its credentials. |
| [Enclave0775/Intiface_Central-Sillytavern-plugin](https://github.com/Enclave0775/Intiface_Central-Sillytavern-plugin) | 41 | 3 | GPL-3.0 | excluded | NSFW/fetish: integrates adult haptic devices (Buttplug/Intiface) into roleplay; fetish-specific adult device integration. |
| [SillyTavern/Extension-Objective](https://github.com/SillyTavern/Extension-Objective) | 40 | 18 | AGPL-3.0 | eligible, rank 29 |  |
| [ghostd93/BetterSimTracker](https://github.com/ghostd93/BetterSimTracker) | 40 | 4 | MIT | eligible, rank 30 |  |
| [Rurijian/KimiThinkingPrefill](https://github.com/Rurijian/KimiThinkingPrefill) | 39 | 4 | NOASSERTION | eligible, rank 31 |  |
| [SillyTavern/Extension-MessageLimit](https://github.com/SillyTavern/Extension-MessageLimit) | 38 | 11 | AGPL-3.0 | eligible, rank 32 |  |
| [ForgottenGlory/ST-SuperObjective](https://github.com/ForgottenGlory/ST-SuperObjective) | 38 | 8 | AGPL-3.0 | eligible, rank 33 |  |
| [SillyTavern/SillyTavern-EmulatorJS](https://github.com/SillyTavern/SillyTavern-EmulatorJS) | 37 | 9 | GPL-3.0 | eligible, rank 34 |  |
| [gamer-mitsuha/sillytavern-auto-illustrator](https://github.com/gamer-mitsuha/sillytavern-auto-illustrator) | 37 | 8 | AGPL-3.0 | excluded | Testability: core function requires a configured image-generation backend. |
| [bincooo/SillyTavernExtension-JsRunner](https://github.com/bincooo/SillyTavernExtension-JsRunner) | 37 | 5 | NOASSERTION | excluded | Security: its documented purpose is executing arbitrary JavaScript in the page context; an arbitrary-code-execution surface is excluded from the safety corpus. |
| [SillyTavern/Extension-Idle](https://github.com/SillyTavern/Extension-Idle) | 36 | 12 | AGPL-3.0 | eligible, rank 35 |  |
| [bmen25124/SillyTavern-Magic-Translation](https://github.com/bmen25124/SillyTavern-Magic-Translation) | 36 | 9 | MIT | eligible, rank 36 |  |
| [SillyTavern/Extension-Silence](https://github.com/SillyTavern/Extension-Silence) | 36 | 8 | AGPL-3.0 | eligible, rank 37 |  |
| [Spadic21/ComfyInject](https://github.com/Spadic21/ComfyInject) | 35 | 11 | AGPL-3.0 | excluded | NSFW: its prompt template includes an explicit "erotic" image-prompt branch (it also requires a local ComfyUI server). |
| [SillyTavern/Extension-Notebook](https://github.com/SillyTavern/Extension-Notebook) | 35 | 9 | AGPL-3.0 | eligible, rank 38 |  |
| [mossyfield/ST-jeved](https://github.com/mossyfield/ST-jeved) | 35 | 6 | MIT | excluded | Testability/credentials: requires a dedicated external host API key (OpenRouter/NanoGPT/TypeSafe or a custom endpoint) before any rule can run. |
| [SillyTavern/Extension-Dice](https://github.com/SillyTavern/Extension-Dice) | 34 | 12 | AGPL-3.0 | eligible, rank 39 |  |
| [SillyTavern/Extension-Mermaid](https://github.com/SillyTavern/Extension-Mermaid) | 34 | 7 | AGPL-3.0 | eligible, rank 40 |  |
| [lannashelton/ST-Outfits](https://github.com/lannashelton/ST-Outfits) | 33 | 6 | CC0-1.0 | eligible, rank 41 |  |
| [SillyTavern/SillyTavern-EdgeTTS-Plugin](https://github.com/SillyTavern/SillyTavern-EdgeTTS-Plugin) | 31 | 7 | AGPL-3.0 | excluded | Non-client: server plugin, not a client extension. |
| [SillyTavern/Extension-WebLLM](https://github.com/SillyTavern/Extension-WebLLM) | 25 | 13 | AGPL-3.0 | excluded | Testability: first use downloads model weights from a CDN/HuggingFace; network is mandatory for its core function. |
| [SillyTavern/Extension-Audio](https://github.com/SillyTavern/Extension-Audio) | 22 | 16 | AGPL-3.0 | eligible, rank 42 |  |
| [SillyTavern/Extension-EmojiPicker](https://github.com/SillyTavern/Extension-EmojiPicker) | 19 | 7 | AGPL-3.0 | eligible, rank 43 |  |
| [SillyTavern/Extension-ReactTemplate](https://github.com/SillyTavern/Extension-ReactTemplate) | 17 | 9 | AGPL-3.0 | excluded | Non-extension: template repository; a scaffold, not a user-facing extension. |
| [SillyTavern/Extension-LaTeX](https://github.com/SillyTavern/Extension-LaTeX) | 16 | 8 | AGPL-3.0 | eligible, rank 44 |  |
| [SillyTavern/Extension-CodeRunner](https://github.com/SillyTavern/Extension-CodeRunner) | 15 | 10 | AGPL-3.0 | excluded | Security: executes JavaScript/STscript from chat code blocks in page context; an arbitrary-code-execution surface is excluded from the safety corpus. |
| [SillyTavern/Extension-CodeMirror](https://github.com/SillyTavern/Extension-CodeMirror) | 15 | 7 | AGPL-3.0 | eligible, rank 45 |  |
| [SillyTavern/Extension-Blip](https://github.com/SillyTavern/Extension-Blip) | 13 | 9 | AGPL-3.0 | eligible, rank 46 |  |
| [SillyTavern/Extension-GroupGreetings](https://github.com/SillyTavern/Extension-GroupGreetings) | 13 | 5 | AGPL-3.0 | eligible, rank 47 |  |
| [SillyTavern/Extension-DupeFinder](https://github.com/SillyTavern/Extension-DupeFinder) | 13 | 5 | AGPL-3.0 | eligible, rank 48 |  |
| [SillyTavern/Extension-RVC](https://github.com/SillyTavern/Extension-RVC) | 13 | 5 | AGPL-3.0 | excluded | Testability: requires the Extras API rvc module. |
| [SillyTavern/Extension-Speech-Recognition](https://github.com/SillyTavern/Extension-Speech-Recognition) | 12 | 29 | GPL-3.0 | eligible, rank 49 |  |
| [SillyTavern/Extension-ScreenShare](https://github.com/SillyTavern/Extension-ScreenShare) | 12 | 7 | AGPL-3.0 | eligible, rank 50 |  |
| [SillyTavern/Extension-Spotify](https://github.com/SillyTavern/Extension-Spotify) | 12 | 2 | AGPL-3.0 | excluded | Testability/credentials: requires a Spotify developer application plus OAuth client ID/authentication. |
| [SillyTavern/Extension-QuickContextSize](https://github.com/SillyTavern/Extension-QuickContextSize) | 9 | 4 | AGPL-3.0 | eligible, rank 51 |  |
| [SillyTavern/Extension-ScriptEvents](https://github.com/SillyTavern/Extension-ScriptEvents) | 8 | 3 | AGPL-3.0 | eligible, rank 52 |  |
| [SillyTavern/Extension-ChromaDB](https://github.com/SillyTavern/Extension-ChromaDB) | 7 | 5 | AGPL-3.0 | excluded | Testability: requires the Extras API chromadb module (repository also archived). |
| [SillyTavern/Extension-Randomizer](https://github.com/SillyTavern/Extension-Randomizer) | 7 | 5 | AGPL-3.0 | eligible, rank 53 |  |
| [SillyTavern/Extension-RSS](https://github.com/SillyTavern/Extension-RSS) | 7 | 4 | AGPL-3.0 | excluded | Testability: core function fetches live RSS feeds from external sites; network is mandatory. |
| [SillyTavern/Extension-Enforce-Content](https://github.com/SillyTavern/Extension-Enforce-Content) | 7 | 4 | GPL-3.0 | eligible, rank 54 |  |
| [SillyTavern/Extension-InjectManager](https://github.com/SillyTavern/Extension-InjectManager) | 7 | 3 | AGPL-3.0 | eligible, rank 55 |  |
| [SillyTavern/Extension-CustomSliders](https://github.com/SillyTavern/Extension-CustomSliders) | 6 | 6 | AGPL-3.0 | eligible, rank 56 |  |
| [SillyTavern/Extension-VideoBackgroundLoader](https://github.com/SillyTavern/Extension-VideoBackgroundLoader) | 6 | 2 | AGPL-3.0 | eligible, rank 57 |  |
| [SillyTavern/Extension-HypeBot](https://github.com/SillyTavern/Extension-HypeBot) | 5 | 6 | AGPL-3.0 | excluded | Testability/credentials: requires a NovelAI API key. |
| [SillyTavern/Extension-ImageMetadataViewer](https://github.com/SillyTavern/Extension-ImageMetadataViewer) | 5 | 5 | AGPL-3.0 | eligible, rank 58 |  |
| [SillyTavern/Extension-Weather](https://github.com/SillyTavern/Extension-Weather) | 5 | 4 | AGPL-3.0 | excluded | Testability/credentials: requires a weather API key. |
| [SillyTavern/Extension-Variables](https://github.com/SillyTavern/Extension-Variables) | 4 | 4 | AGPL-3.0 | eligible, rank 59 |  |
| [SillyTavern/Extension-LoremIpsum](https://github.com/SillyTavern/Extension-LoremIpsum) | 4 | 3 | AGPL-3.0 | eligible, rank 60 |  |
| [SillyTavern/Extension-SamplerCommands](https://github.com/SillyTavern/Extension-SamplerCommands) | 3 | 4 | AGPL-3.0 | eligible, rank 61 |  |
| [SillyTavern/Extension-WebpackTemplate](https://github.com/SillyTavern/Extension-WebpackTemplate) | 2 | 2 | AGPL-3.0 | excluded | Non-extension: template repository; a scaffold, not a user-facing extension. |
| [N0VI028/JS-Slash-Runner-Doc](https://github.com/N0VI028/JS-Slash-Runner-Doc) | 1 | 1 | NOASSERTION | excluded | Tavern Helper documentation repository; Tavern Helper family exclusion. |

## 4. Selected corpus (20 pinned client extensions)

| install name | repository | pinned commit | stars | license | capabilities |
| --- | --- | --- | --- | --- | --- |
| `rpg-companion-sillytavern` | [SpicyMarinara/rpg-companion-sillytavern](https://github.com/SpicyMarinara/rpg-companion-sillytavern) | `9c4800957e694e4f3b81dd3427f97ff1a3b75934` | 329 | NOASSERTION | DOM, chat-events, generation, prompt-injection, world-info, character, group-chat, quick-replies, macros, files, fetch, settings, slash-command, prompt-format, message-render, markdown, image, remote-network |
| `SillyTavern-Horae` | [SenriYuki/SillyTavern-Horae](https://github.com/SenriYuki/SillyTavern-Horae) | `7a8859897bbfc6f0781ac5eb2451bc607e2bab95` | 206 | NOASSERTION | DOM, chat-events, generation, character, files, fetch, settings, slash-command, prompt-format, message-render, image |
| `SillyTavern-Character-Creator` | [bmen25124/SillyTavern-Character-Creator](https://github.com/bmen25124/SillyTavern-Character-Creator) | `8ddf5ba08188fa8044469518d540c7dded4db701` | 185 | MIT | DOM, chat-events, generation, world-info, character, group-chat, macros, files, fetch, settings, slash-command, prompt-format, markdown |
| `Extension-Summaryception` | [Lodactio/Extension-Summaryception](https://github.com/Lodactio/Extension-Summaryception) | `6a0afdc84fbd8f410db53738fa0f91d6a009eeb6` | 182 | AGPL-3.0 | DOM, chat-events, generation, prompt-injection, fetch, settings, slash-command, prompt-format, remote-network |
| `st-stepped-thinking` | [cierru/st-stepped-thinking](https://github.com/cierru/st-stepped-thinking) | `9b58956c8e5fe95598e5ad771bcb5c0f9de4fa09` | 173 | MIT | DOM, chat-events, generation, prompt-injection, character, macros, tokenizer, settings, slash-command, prompt-format, message-render |
| `SillyTavern-WorldInfo-Recommender` | [bmen25124/SillyTavern-WorldInfo-Recommender](https://github.com/bmen25124/SillyTavern-WorldInfo-Recommender) | `357e80f1dbd8b694f09910f01c5469b0899f2d02` | 135 | MIT | DOM, chat-events, generation, world-info, character, group-chat, macros, settings, slash-command, prompt-format, markdown |
| `SillyTavern-Timelines` | [SillyTavern/SillyTavern-Timelines](https://github.com/SillyTavern/SillyTavern-Timelines) | `03f74342c86d2edaa5a1751b34f0c7113813db7d` | 127 | MIT | DOM, chat-events, character, group-chat, files, fetch, tokenizer, settings, slash-command, message-render |
| `Extension-TopInfoBar` | [SillyTavern/Extension-TopInfoBar](https://github.com/SillyTavern/Extension-TopInfoBar) | `930be54913d90abd90ebd698ddd81affa924e2e1` | 97 | AGPL-3.0 | DOM, chat-events, character, group-chat, files, fetch, slash-command |
| `NemoPresetExt` | [NemoVonNirgend/NemoPresetExt](https://github.com/NemoVonNirgend/NemoPresetExt) | `55c29c484035e5e2a6707831831d88f696d4972b` | 95 | NOASSERTION | DOM, chat-events, world-info, character, macros, files, fetch, tokenizer, settings, prompt-format, message-render, markdown |
| `Extension-Live2d` | [SillyTavern/Extension-Live2d](https://github.com/SillyTavern/Extension-Live2d) | `d1801d36a32ace9451cf6377c005a7a64292fc39` | 88 | GPL-3.0 | DOM, chat-events, character, files, fetch, settings, slash-command, message-render, audio, image |
| `SillyTavern-Roadway` | [bmen25124/SillyTavern-Roadway](https://github.com/bmen25124/SillyTavern-Roadway) | `8bd72bdbfecf707ebf2d15f0dd11d9fd886644ed` | 83 | MIT | DOM, chat-events, generation, world-info, character, group-chat, macros, settings, slash-command, prompt-format, message-render |
| `ST-Copilot` | [Supker/ST-Copilot](https://github.com/Supker/ST-Copilot) | `14809604817b632810903afcf44d0db07608fb12` | 80 | MIT | DOM, chat-events, generation, world-info, character, group-chat, macros, files, fetch, tokenizer, settings, prompt-format, markdown, audio, image |
| `sillytavern-character-memory` | [bal-spec/sillytavern-character-memory](https://github.com/bal-spec/sillytavern-character-memory) | `35fcf22bf0a5b4273fd19e06a2ff82d0ed520ab3` | 78 | NOASSERTION | DOM, chat-events, generation, world-info, character, files, fetch, tokenizer, settings, slash-command, prompt-format, markdown, image, remote-network |
| `Extension-QuickPersona` | [SillyTavern/Extension-QuickPersona](https://github.com/SillyTavern/Extension-QuickPersona) | `5509fb6bee903c833683cb860fbf437d4479b1cb` | 76 | AGPL-3.0 | DOM, chat-events |
| `Guinevere-UI-Extension` | [Bronya-Rand/Guinevere-UI-Extension](https://github.com/Bronya-Rand/Guinevere-UI-Extension) | `d93c056ccdd7720253b167fe1a29ad0cbbe66f9d` | 72 | AGPL-3.0 | DOM, chat-events, settings, fetch |
| `recast-post-processing` | [closuretxt/recast-post-processing](https://github.com/closuretxt/recast-post-processing) | `a7ac25a2478798a404a8a8dacbe2ae8ed6eba781` | 66 | AGPL-3.0 | DOM, chat-events, generation, world-info, character, macros, settings, slash-command, message-render |
| `Extension-VRM` | [SillyTavern/Extension-VRM](https://github.com/SillyTavern/Extension-VRM) | `2b4c4d015a40d255a064e83ed70c408046d58049` | 65 | GPL-3.0 | DOM, chat-events, character, files, fetch, settings, message-render, audio, image |
| `Prome-VN-Extension` | [Bronya-Rand/Prome-VN-Extension](https://github.com/Bronya-Rand/Prome-VN-Extension) | `9cf09fb307e859f21bf507d781e5327b7acd89fa` | 65 | AGPL-3.0 | DOM, chat-events, character, group-chat, files, fetch, settings, slash-command, message-render, image |
| `SillyTavern-SimTracker` | [prolix-oc/SillyTavern-SimTracker](https://github.com/prolix-oc/SillyTavern-SimTracker) | `2ab0c814c8202eefa19d28889b30aebc48654589` | 64 | NOASSERTION | DOM, chat-events, generation, character, files, fetch, settings, slash-command, prompt-format, message-render, markdown |
| `SillyTavern-ReMemory` | [InspectorCaracal/SillyTavern-ReMemory](https://github.com/InspectorCaracal/SillyTavern-ReMemory) | `2c366257f8dcaa2ffc4e949bab73893ef553f1b2` | 61 | AGPL-3.0 | DOM, chat-events, generation, world-info, character, fetch, tokenizer, settings, slash-command, prompt-format, message-render |

### 4.1 Per-extension safety review

- **`rpg-companion-sillytavern`** (`SpicyMarinara/rpg-companion-sillytavern` @ `9c4800957e694e4f3b81dd3427f97ff1a3b75934`): Cloned 9c48009 and read index.js, src/systems/**, manifest.json. No package.json install hooks, no eval(atob(, no remote script loader and no external fetch during load; fetch targets are ST's own /api routes (sprites, classify) plus an optional OpenAI-compatible API whose baseUrl defaults to an empty string. The single new Function is a JSON-repair fallback applied to the model's own tracker output, not to remote code.
- **`SillyTavern-Horae`** (`SenriYuki/SillyTavern-Horae` @ `7a8859897bbfc6f0781ac5eb2451bc607e2bab95`): Cloned 7a88598 and read index.js, core/**, manifest.json. No install hooks, eval/atob or dynamically loaded remote scripts; fetch calls target the extension's own locale/prompt JSON and ST API routes, with optional OpenAI-compatible auxiliary/embedding endpoints only when the user configures them. It imports ST modules rather than injecting remote code.
- **`SillyTavern-Character-Creator`** (`bmen25124/SillyTavern-Character-Creator` @ `8ddf5ba08188fa8044469518d540c7dded4db701`): Cloned 8ddf5ba and read dist/index.js plus src/*.ts. No postinstall hook; the atob/createElement('script') occurrences are inside bundled React/zod libraries. The extension fetches only ST's /api/characters/import and /api/characters/merge-attributes with ST request headers; LLM calls go through ST's ConnectionManagerRequestService, not a hardcoded external host.
- **`Extension-Summaryception`** (`Lodactio/Extension-Summaryception` @ `6a0afdc84fbd8f410db53738fa0f91d6a009eeb6`): Cloned 6a0afdc and read all seven runtime files. No install hooks, eval/atob or remote script loading; fetch targets are ST's /api/connection-manager/profiles and, only when selected, an OpenAI-compatible or Ollama endpoint the user enters. The default path uses ST's active connection.
- **`st-stepped-thinking`** (`cierru/st-stepped-thinking` @ `9b58956c8e5fe95598e5ad771bcb5c0f9de4fa09`): Cloned 9b58956 and read index.js, thinking/*, settings/*. No install hooks, eval/atob or external fetches; the extension uses ST's Generate/setExtensionPrompt APIs and stores settings in extension_settings. All 13 runtime files were inspected for loaders and credential access; none were found.
- **`SillyTavern-WorldInfo-Recommender`** (`bmen25124/SillyTavern-WorldInfo-Recommender` @ `357e80f1dbd8b694f09910f01c5469b0899f2d02`): Cloned 357e80f; the runtime is dist/index.js built from src/**. No postinstall scripts; atob/script-injection hits are bundled React/zod internals; there is no external fetch target and LLM calls use ST's ConnectionManagerRequestService. World-info writes go through ST's own API helpers.
- **`SillyTavern-Timelines`** (`SillyTavern/SillyTavern-Timelines` @ `03f74342c86d2edaa5a1751b34f0c7113813db7d`): Cloned 03f7434 and read index.js and tl_*.js. The only dynamic script/style helper is fed a local file path inside the extension folder; cytoscape/dagre are vendored upstream libraries with their licenses retained. No install hooks, eval(atob(, external fetch or credential reads; all data comes from ST's chat APIs.
- **`Extension-TopInfoBar`** (`SillyTavern/Extension-TopInfoBar` @ `930be54913d90abd90ebd698ddd81affa924e2e1`): Cloned 930be549 and read all eight runtime files. No install hooks, eval, external fetch or credential access; the only fetch is ST's /api/characters/chats with ST request headers, and the UI is built with DOM/jQuery over ST's existing elements.
- **`NemoPresetExt`** (`NemoVonNirgend/NemoPresetExt` @ `55c29c484035e5e2a6707831831d88f696d4972b`): Cloned 55c29c4 and reviewed content.js plus src/*. No postinstall hooks; new Function and child_process occurrences are confined to dev scripts and tests outside the runtime entry. Runtime fetch calls are ST's /api/presets/save endpoints; the 75 MB of assets are NemoEngine preset-data JSON parts, not executables or opaque binaries.
- **`Extension-Live2d`** (`SillyTavern/Extension-Live2d` @ `d1801d36a32ace9451cf6377c005a7a64292fc39`): Cloned d1801d3 and reviewed index.js plus the runtime libs. The bundled pixi.min.js/live2dcubismcore.min.js are the upstream libraries with versions and licenses retained; their atob/new Function use is library internals. The extension fetches only ST asset/classify APIs, and Live2D model files are user-supplied from the ST assets directory.
- **`SillyTavern-Roadway`** (`bmen25124/SillyTavern-Roadway` @ `8bd72bdbfecf707ebf2d15f0dd11d9fd886644ed`): Cloned 8bd72bd and read dist/index.js plus src/index.ts. No install hooks, eval/atob, remote loaders or external fetch; LLM requests go through ST's ConnectionManagerRequestService and settings live in extension_settings.
- **`ST-Copilot`** (`Supker/ST-Copilot` @ `14809604817b632810903afcf44d0db07608fb12`): Cloned 1480960 and read index.js plus src/*. No install hooks or remote script loading; fetch targets are ST's own /api routes (files, worldinfo, characters, caption, backgrounds, tokencount) and LLM calls use the ST connection manager or a user-configured endpoint. atob is used only to decode local session payload strings.
- **`sillytavern-character-memory`** (`bal-spec/sillytavern-character-memory` @ `35fcf22bf0a5b4273fd19e06a2ff82d0ed520ab3`): Cloned 35fcf22 and reviewed index.js and its supporting modules. No install hooks or remote script loaders; at load only ST APIs are touched. Optional direct-provider endpoints and keys are user-entered settings; default routing goes through ST. The large fixture in the repo is a sample chat JSONL, not an executable.
- **`Extension-QuickPersona`** (`SillyTavern/Extension-QuickPersona` @ `5509fb6bee903c833683cb860fbf437d4479b1cb`): Cloned 5509fb6; five small runtime files. No fetch, no eval/atob, no credential access; it reads ST's personas from the page context, renders a dropdown and writes the selection back through ST settings.
- **`Guinevere-UI-Extension`** (`Bronya-Rand/Guinevere-UI-Extension` @ `d93c056ccdd7720253b167fe1a29ad0cbbe66f9d`): Cloned d93c056 and read index.js plus the theme-pack loader. No install hooks or remote loading; fetch is limited to reading a local theme-pack manifest inside the extension folder. Theme packs shipped in the repo can contain CSS/HTML/JS by design, and the review confirmed the shipped packs neither contact a network nor read credentials.
- **`recast-post-processing`** (`closuretxt/recast-post-processing` @ `a7ac25a2478798a404a8a8dacbe2ae8ed6eba781`): Cloned a7ac25a and read all runtime files. No install hooks, eval/atob or external fetch; passes run through ST's chat-completion APIs and world-info helpers, with prompts assembled locally and settings stored in extension_settings.
- **`Extension-VRM`** (`SillyTavern/Extension-VRM` @ `2b4c4d015a40d255a064e83ed70c408046d58049`): Cloned 2b4c4d0 and reviewed index.js and the bundled three.js/jsm libraries (ammo, draco, basis, rhino3dm; licenses retained). No install hooks or remote script loading; fetch calls target ST asset/classify APIs. Model files are user-supplied from ST assets and the wasm/JS libraries are standard upstream builds.
- **`Prome-VN-Extension`** (`Bronya-Rand/Prome-VN-Extension` @ `9cf09fb307e859f21bf507d781e5327b7acd89fa`): Cloned 9cf09fb and read index.js plus the runtime modules. No install hooks, eval/atob or external fetch; the only fetch is ST's /api/sprites/get; settings live in extension_settings and sprites come from the user's ST assets.
- **`SillyTavern-SimTracker`** (`prolix-oc/SillyTavern-SimTracker` @ `2ab0c814c8202eefa19d28889b30aebc48654589`): Cloned 2ab0c81 and read index.js, renderer.js and the tracker modules. No install hooks or remote loaders; fetch is limited to ST's /api/secrets/find. renderer.js evaluates user-authored template logic with new Function, a documented local feature; the repository is archived/sunset upstream.
- **`SillyTavern-ReMemory`** (`InspectorCaracal/SillyTavern-ReMemory` @ `2c366257f8dcaa2ffc4e949bab73893ef553f1b2`): Cloned 2c36625; twelve small runtime files. No install hooks, eval/atob, external fetch or credential access; it calls ST's generateRaw and world-info APIs and keeps memories in world-info books through ST helpers.

### 4.2 Per-extension selection reason

- **`rpg-companion-sillytavern`**: Eligible rank 1/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 329 stars, 71 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`SillyTavern-Horae`**: Eligible rank 2/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 206 stars, 27 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`SillyTavern-Character-Creator`**: Eligible rank 3/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 185 stars, 25 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`Extension-Summaryception`**: Eligible rank 4/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 182 stars, 38 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`st-stepped-thinking`**: Eligible rank 5/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 173 stars, 19 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`SillyTavern-WorldInfo-Recommender`**: Eligible rank 6/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 135 stars, 18 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`SillyTavern-Timelines`**: Eligible rank 7/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 127 stars, 16 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it. Official SillyTavern downloadable extension (official-listing tie-break applies only on a full tie).
- **`Extension-TopInfoBar`**: Eligible rank 8/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 97 stars, 17 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it. Official SillyTavern downloadable extension (official-listing tie-break applies only on a full tie).
- **`NemoPresetExt`**: Eligible rank 9/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 95 stars, 12 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`Extension-Live2d`**: Eligible rank 10/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 88 stars, 21 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it. Official SillyTavern downloadable extension (official-listing tie-break applies only on a full tie).
- **`SillyTavern-Roadway`**: Eligible rank 11/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 83 stars, 13 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`ST-Copilot`**: Eligible rank 12/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 80 stars, 12 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`sillytavern-character-memory`**: Eligible rank 13/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 78 stars, 6 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`Extension-QuickPersona`**: Eligible rank 14/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 76 stars, 14 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it. Official SillyTavern downloadable extension (official-listing tie-break applies only on a full tie).
- **`Guinevere-UI-Extension`**: Eligible rank 15/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 72 stars, 9 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`recast-post-processing`**: Eligible rank 16/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 66 stars, 7 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`Extension-VRM`**: Eligible rank 17/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 65 stars, 16 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it. Official SillyTavern downloadable extension (official-listing tie-break applies only on a full tie).
- **`Prome-VN-Extension`**: Eligible rank 18/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 65 stars, 9 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`SillyTavern-SimTracker`**: Eligible rank 19/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 64 stars, 7 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.
- **`SillyTavern-ReMemory`**: Eligible rank 20/61 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 61 stars, 7 forks. The top-20 cut is rank 20 at 61 stars (next eligible is 58); this repository is inside it.

## 5. Tavern Helper exclusion statement

Tavern Helper (酒馆助手, the `N0VI028/JS-Slash-Runner` project) is excluded from this corpus **in every form**: the
canonical repository, any fork, mirror, rename, alias, translated copy, documentation repository, or companion
template. The dedicated `JS-Slash-Runner` and `"Tavern Helper" in:name,description` searches returned the family; the
canonical repository (1396 stars at the snapshot) and the two companion repositories in the candidate pool are marked
`excluded` with the Tavern Helper reason. No repository in the selected 20 names or derives from Tavern Helper.

## 6. NSFW and security exclusion statement

NSFW content was excluded by reading each candidate's README/description/topics/metadata, not by name: six
repositories in the pool are excluded for explicit sexual content, NSFW browsing/access, adult haptic-device
integration or explicit "erotic" image-prompt features, with the specific README evidence recorded in
`exclusionReason`. Security: no selected extension has an install hook, a remote script loader, an obfuscated
downloader, a credential harvester or a crypto miner; arbitrary-code-execution extensions were excluded, and the two
selected extensions that use `new Function` (JSON repair and user-authored tracker-template logic) apply it to local
data only, as recorded in their `safetyReview`.

## 7. Reproducing and consuming the corpus

The machine-readable file is `tests/browser/third-party-extensions.lock.json` (schemaVersion 1). Its SHA256 is:

```text
a8a1d70f34902007358981b74ffef3023fe3a09acf808d86811a50f621d62ff3  tests/browser/third-party-extensions.lock.json
```

Install name, per the lock's `installMethod`: check out each `selected[].commit` into
`<dataRoot>/<handle>/extensions/<selected[].name>`; the pinned frontend then loads
`/scripts/extensions/third-party/<name>/manifest.json`. No branch name is ever checked out.

To re-derive the snapshot: run the queries in section 2.1 through `gh api` at a new timestamp, deduplicate and rank
as in section 2.2, apply the filters in section 2.3, then re-resolve each selected commit with
`gh api repos/OWNER/REPO/commits?per_page=1`. Record one new `snapshotAt` for all rows; never mix snapshot times.
