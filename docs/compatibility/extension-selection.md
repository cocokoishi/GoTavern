# Third-party extension corpus and selection methodology (alpha.13)

This document and `tests/browser/third-party-extensions.lock.json` are the reproducible, pinned corpus of 20 real,
public, safe, non-NSFW SillyTavern **client-side** third-party extensions for alpha.13, together with the
101-repository candidate pool they were selected from. Every number here is from one GitHub API snapshot;
nothing is estimated and no repository is fabricated.

> This is not an official Top 20; it is the top 20 eligible extensions by the documented popularity snapshot/ranking methodology.

## 1. Snapshot

- Snapshot timestamp (all rows): `2026-11-03T01:35:43Z` (UTC).
- Source: authenticated GitHub REST API (`gh api`), account `cocokoishi`.
- Pinned stock SillyTavern baseline used to judge what a client extension is: SillyTavern 1.19.0 at the commit named by the repository pin file `upstream/SILLYTAVERN_COMMIT`.
- Candidate pool: **101 distinct repositories**; eligible after filters and testability: **25**; selected: **20**.
- Every selected extension's default-branch HEAD commit was resolved at the snapshot and verified to be a 40-hex commit that the API returns (`repos/OWNER/REPO/commits?per_page=1` then `repos/OWNER/REPO/commits/<sha>`); each was then checked out with `git fetch --depth 1 origin <sha>` and re-hashed locally.

## 2. Methodology

Popularity snapshot captured with the authenticated GitHub REST API at 2026-11-03T01:35:43Z using the following searches (search/repositories, sort=stars, order=desc, per_page=100): "topic:sillytavern-extension"; "topic:sillytavern-extensions"; "topic:sillytavern"; "sillytavern extension in:name,description"; "sillytavern-extensions in:name,description"; "sillytavern extension in:description"; "sillytavern extension in:name"; plus "org:SillyTavern", "topic:sillytavern-plugin", "topic:tavern-helper", and the author listings users/LenAnderson/repos, users/bmen25124/repos, users/Lodactio/repos. Additional exclusion-evidence searches were "JS-Slash-Runner" and '"Tavern Helper" in:name,description'. Duplicates are removed by repository full_name case-insensitively, keeping the most-starred row, and forks/mirrors are not counted separately when a canonical or more-starred copy is present. Candidate inclusion: a repository that those queries surfaced as a SillyTavern extension candidate with at least 30 stars at the snapshot, every SillyTavern-org downloadable client extension (kept in the table as a first-party candidate but never eligible for selection), every Tavern Helper family repository surfaced by the dedicated searches, and the non-client/other-category repositories those same queries return near the top. Ranking for eligible candidates is stars PRIMARY descending, forks SECONDARY descending, pushedAt TIE BREAKER descending, then official/community-listing membership as the final tie breaker (the official listing is https://docs.sillytavern.app/extensions/ and the SillyTavern org extension repositories; the community listing is the topic/author search surface above). First-party exclusion (strict third-party corpus): any repository owned by the SillyTavern organisation is an official/first-party extension, not third-party, so it is ineligible for selection and is kept in the candidate table with the first-party exclusion reason. The 20 selected are the top 20 eligible repositories after those filters; testability and safety exclusions are recorded with the failing reason in the candidate table. This is not an official Top 20; it is the top 20 eligible extensions by the documented popularity snapshot/ranking methodology.

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
- The 20 selected are the **top 20 eligible** repositories under that ordering; the cut is rank 20 at **42 stars**, with the next eligible repository at **40 stars**. No filter was relaxed to reach 20.

### 2.3 Filters and testability (applied to every candidate)

1. **Third-party only (first-party exclusion).** Any repository owned by the SillyTavern organisation is an official extension, not third-party. It is kept in the candidate pool for transparency but is never eligible for selection and carries the reason "first-party SillyTavern organisation extension, not third-party".
2. **Client extension only.** The repository must be a SillyTavern client-side extension installed into `extensions/third-party/`, i.e. a `manifest.json` at the repository root whose `js` entry is loaded by the pinned frontend. Server plugins (installed under `plugins/`, `enableServerPlugins`), launchers, documentation, content/preset/theme/card repositories, templates, standalone apps and non-SillyTavern tools are excluded with a recorded reason.
3. **Tavern Helper exclusion (non-negotiable).** `N0VI028/JS-Slash-Runner` (Tavern Helper / 酒馆助手 / JS-Slash-Runner), and every fork, mirror, rename, alias, documentation repository or companion template that names or derives from it, are excluded in every form. The candidate table records the canonical repository and the two companion repositories the dedicated searches returned.
4. **NSFW exclusion.** Judged from README/description/topics/assets/metadata, not from the name alone: pornography, explicit sexual content, hentai, explicit sexual image generation, fetish-specific content and adult-only assets are excluded with the specific README evidence in `exclusionReason`.
5. **Security exclusion.** Credential harvesters, token stealers, arbitrary remote loaders, suspicious minified binary blobs, unexplained executable payloads, malicious postinstall scripts, crypto miners, obfuscated downloaders and arbitrary-code-execution extensions are excluded. The 20 selected were checked out at the pinned commit and their runtime JavaScript was scanned for `package.json` install hooks, `eval(atob(`, remote script injection, `child_process`, oversized base64 blobs and unexpected external origins; the findings are summarised per extension in `safetyReview`.
6. **Testability.** `manifest.json` must exist at the **repository root** (the harness installs the checkout as `<extensions>/<name>` and the pinned frontend fetches `/scripts/extensions/third-party/<name>/manifest.json`); a manifest that only exists in `dist/` or a subdirectory is excluded with that reason. The extension must load without mandatory credentials and without a mandatory external server; a candidate whose core function needs a provider key, a companion server plugin or a self-hosted service just to initialise was skipped in favour of the next eligible candidate and the reason is recorded.
7. **Network/credentials fields.** `networkRequired` and `credentialsRequired` describe what a normal load/activation needs, not optional features. All 20 selected load from the pinned frontend with no extension-specific credential and no mandatory external service; extensions that use the user's already-configured ST provider route through ST, and optional external endpoints are off by default.

## 3. Candidate pool (101 repositories)

| repository | stars | forks | license | status | reason (when excluded) |
| --- | --- | --- | --- | --- | --- |
| [N0VI028/JS-Slash-Runner](https://github.com/N0VI028/JS-Slash-Runner) | 1396 | 116 | NOASSERTION | excluded | Tavern Helper / 酒馆助手 / JS-Slash-Runner: excluded by policy in every form (canonical repository). |
| [SillyTavern/SillyTavern-Extras](https://github.com/SillyTavern/SillyTavern-Extras) | 706 | 148 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/SillyTavern-Launcher](https://github.com/SillyTavern/SillyTavern-Launcher) | 596 | 128 | MIT | excluded | first-party SillyTavern organisation extension, not third-party |
| [SpicyMarinara/rpg-companion-sillytavern](https://github.com/SpicyMarinara/rpg-companion-sillytavern) | 329 | 71 | NOASSERTION | eligible, rank 1 |  |
| [ZerxZ/SillyTavern-Extension-ZerxzLib](https://github.com/ZerxZ/SillyTavern-Extension-ZerxzLib) | 284 | 21 | AGPL-3.0 | excluded | Testability/credentials: archived extension whose only function is rotating multiple Gemini API keys, so it requires provider credentials entered in the extension before doing anything (credential-free activation preference). |
| [SenriYuki/SillyTavern-Horae](https://github.com/SenriYuki/SillyTavern-Horae) | 206 | 27 | NOASSERTION | eligible, rank 2 |  |
| [bmen25124/SillyTavern-Character-Creator](https://github.com/bmen25124/SillyTavern-Character-Creator) | 185 | 25 | MIT | eligible, rank 3 |  |
| [StageDog/tavern_helper_template](https://github.com/StageDog/tavern_helper_template) | 182 | 147 | NOASSERTION | excluded | Tavern Helper companion template; the policy excludes Tavern Helper in every form, including templates and derivatives. |
| [Lodactio/Extension-Summaryception](https://github.com/Lodactio/Extension-Summaryception) | 182 | 38 | AGPL-3.0 | eligible, rank 4 |  |
| [SillyTavern/SillyTavern-Docs](https://github.com/SillyTavern/SillyTavern-Docs) | 181 | 395 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [cierru/st-stepped-thinking](https://github.com/cierru/st-stepped-thinking) | 173 | 19 | MIT | eligible, rank 5 |  |
| [Sillyanonymous/SillyTavern-CharacterLibrary](https://github.com/Sillyanonymous/SillyTavern-CharacterLibrary) | 159 | 33 | AGPL-3.0 | excluded | NSFW: README documents an NSFW content toggle and CharacterTavern NSFW access for browsing adult character cards. |
| [bmen25124/SillyTavern-WorldInfo-Recommender](https://github.com/bmen25124/SillyTavern-WorldInfo-Recommender) | 135 | 18 | MIT | eligible, rank 6 |  |
| [SillyTavern/SillyTavern-Timelines](https://github.com/SillyTavern/SillyTavern-Timelines) | 127 | 16 | MIT | excluded | first-party SillyTavern organisation extension, not third-party |
| [mattjaybe/SillyTavern-Pathweaver](https://github.com/mattjaybe/SillyTavern-Pathweaver) | 123 | 7 | MIT | excluded | NSFW: advertises an optional "Explicit" NSFW spicy-suggestion mode with adult content. |
| [mattjaybe/SillyTavern-EchoChamber](https://github.com/mattjaybe/SillyTavern-EchoChamber) | 105 | 12 | MIT | excluded | NSFW: ships dedicated NSFW/Erotic chat styles documented as explicit sexual content. |
| [bmen25124/SillyTavern-MCP-Client](https://github.com/bmen25124/SillyTavern-MCP-Client) | 98 | 8 | MIT | excluded | Testability: requires the companion SillyTavern MCP server plugin (a server-side component) before it can initialise. |
| [SillyTavern/Extension-TopInfoBar](https://github.com/SillyTavern/Extension-TopInfoBar) | 97 | 17 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [NemoVonNirgend/NemoPresetExt](https://github.com/NemoVonNirgend/NemoPresetExt) | 95 | 12 | NOASSERTION | eligible, rank 7 |  |
| [pixelnull/sillytavern-DeepLore](https://github.com/pixelnull/sillytavern-DeepLore) | 91 | 15 | MIT | excluded | Testability: its manifest display name is "DeepLore (Obsidian required)"; the core function requires a running Obsidian vault with the Local REST API service. |
| [SillyTavern/Extension-Live2d](https://github.com/SillyTavern/Extension-Live2d) | 88 | 21 | GPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [bmen25124/SillyTavern-Roadway](https://github.com/bmen25124/SillyTavern-Roadway) | 83 | 13 | MIT | eligible, rank 8 |  |
| [Supker/ST-Copilot](https://github.com/Supker/ST-Copilot) | 80 | 12 | MIT | eligible, rank 9 |  |
| [bal-spec/sillytavern-character-memory](https://github.com/bal-spec/sillytavern-character-memory) | 78 | 6 | NOASSERTION | eligible, rank 10 |  |
| [SillyTavern/Extension-QuickPersona](https://github.com/SillyTavern/Extension-QuickPersona) | 76 | 14 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [Bronya-Rand/Guinevere-UI-Extension](https://github.com/Bronya-Rand/Guinevere-UI-Extension) | 72 | 9 | AGPL-3.0 | eligible, rank 11 |  |
| [senjinthedragon/Smart-Memory](https://github.com/senjinthedragon/Smart-Memory) | 71 | 10 | AGPL-3.0 | excluded | Testability: core memory extraction/retrieval requires an embedding server (Ollama or an OpenAI-compatible /v1/embeddings endpoint) configured. |
| [ackness/covel](https://github.com/ackness/covel) | 66 | 20 | MIT | excluded | Non-client: standalone agentic RPG application/framework; not a SillyTavern extension. |
| [closuretxt/recast-post-processing](https://github.com/closuretxt/recast-post-processing) | 66 | 7 | AGPL-3.0 | eligible, rank 12 |  |
| [SillyTavern/Extension-VRM](https://github.com/SillyTavern/Extension-VRM) | 65 | 16 | GPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [Bronya-Rand/Prome-VN-Extension](https://github.com/Bronya-Rand/Prome-VN-Extension) | 65 | 9 | AGPL-3.0 | eligible, rank 13 |  |
| [SillyTavern/SillyTavern-WebSearch-Selenium](https://github.com/SillyTavern/SillyTavern-WebSearch-Selenium) | 65 | 8 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [prolix-oc/SillyTavern-SimTracker](https://github.com/prolix-oc/SillyTavern-SimTracker) | 64 | 7 | NOASSERTION | eligible, rank 14 |  |
| [InspectorCaracal/SillyTavern-ReMemory](https://github.com/InspectorCaracal/SillyTavern-ReMemory) | 61 | 7 | AGPL-3.0 | eligible, rank 15 |  |
| [laboratoiresonore/spellcaster](https://github.com/laboratoiresonore/spellcaster) | 61 | 3 | NOASSERTION | excluded | Non-client: desktop AI image-editing toolchain (GIMP/DaVinci Resolve); not a SillyTavern extension. |
| [Min3Mast3r4653/SillyTavern-Extensions-and-Themes](https://github.com/Min3Mast3r4653/SillyTavern-Extensions-and-Themes) | 60 | 6 | NOASSERTION | excluded | Non-extension: link-list repository of extensions/themes. |
| [SillyTavern/Extension-WebSearch](https://github.com/SillyTavern/Extension-WebSearch) | 59 | 23 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [Kristyku/InlineSummary](https://github.com/Kristyku/InlineSummary) | 58 | 11 | NOASSERTION | eligible, rank 16 |  |
| [DangerDaza/Dooms-Enhancement-Suite](https://github.com/DangerDaza/Dooms-Enhancement-Suite) | 57 | 9 | NOASSERTION | eligible, rank 17 |  |
| [SillyTavern/Extension-PromptInspector](https://github.com/SillyTavern/Extension-PromptInspector) | 55 | 10 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/SillyTavern-Content](https://github.com/SillyTavern/SillyTavern-Content) | 53 | 49 | MIT | excluded | first-party SillyTavern organisation extension, not third-party |
| [bmen25124/SillyTavern-WeatherPack](https://github.com/bmen25124/SillyTavern-WeatherPack) | 53 | 3 | MIT | excluded | Security: executes scripts extracted from sanitised chat-message HTML automatically during normal operation (chat content -> page script execution); an arbitrary-code-execution surface is excluded from the safety corpus. |
| [bmen25124/SillyTavern-MCP-Server](https://github.com/bmen25124/SillyTavern-MCP-Server) | 51 | 6 | MIT | excluded | Non-client: server plugin companion, not a client extension. |
| [mattjaybe/SillyTavern-EchoText](https://github.com/mattjaybe/SillyTavern-EchoText) | 49 | 7 | MIT | excluded | NSFW: documents explicit/erotic mood dimensions and NSFW chat styles. |
| [AyeeMinerva/SillyTavern-Extension-ChatBridge](https://github.com/AyeeMinerva/SillyTavern-Extension-ChatBridge) | 49 | 4 | AGPL-3.0 | excluded | Testability: a WebSocket bridge whose function requires an external client application/endpoint; it does nothing standalone. |
| [Lol1p0p/narrative-agent](https://github.com/Lol1p0p/narrative-agent) | 48 | 2 | MIT | eligible, rank 18 |  |
| [SillyTavern/SillyTavern-Fandom-Scraper](https://github.com/SillyTavern/SillyTavern-Fandom-Scraper) | 47 | 11 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-TypingIndicator](https://github.com/SillyTavern/Extension-TypingIndicator) | 46 | 10 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [bmen25124/SillyTavern-WTracker](https://github.com/bmen25124/SillyTavern-WTracker) | 44 | 11 | MIT | eligible, rank 19 |  |
| [bmen25124/SillyTavern-Custom-Scenario](https://github.com/bmen25124/SillyTavern-Custom-Scenario) | 42 | 4 | MIT | eligible, rank 20 |  |
| [platberlitz/sillytavern-image-gen](https://github.com/platberlitz/sillytavern-image-gen) | 41 | 6 | MIT | excluded | Testability: core function requires a configured image-generation provider/backend and its credentials. |
| [Enclave0775/Intiface_Central-Sillytavern-plugin](https://github.com/Enclave0775/Intiface_Central-Sillytavern-plugin) | 41 | 3 | GPL-3.0 | excluded | NSFW/fetish: integrates adult haptic devices (Buttplug/Intiface) into roleplay; fetish-specific adult device integration. |
| [SillyTavern/Extension-Objective](https://github.com/SillyTavern/Extension-Objective) | 40 | 18 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [ghostd93/BetterSimTracker](https://github.com/ghostd93/BetterSimTracker) | 40 | 4 | MIT | eligible, rank 21 |  |
| [Rurijian/KimiThinkingPrefill](https://github.com/Rurijian/KimiThinkingPrefill) | 39 | 4 | NOASSERTION | eligible, rank 22 |  |
| [SillyTavern/Extension-MessageLimit](https://github.com/SillyTavern/Extension-MessageLimit) | 38 | 11 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [ForgottenGlory/ST-SuperObjective](https://github.com/ForgottenGlory/ST-SuperObjective) | 38 | 8 | AGPL-3.0 | eligible, rank 23 |  |
| [SillyTavern/SillyTavern-EmulatorJS](https://github.com/SillyTavern/SillyTavern-EmulatorJS) | 37 | 9 | GPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [gamer-mitsuha/sillytavern-auto-illustrator](https://github.com/gamer-mitsuha/sillytavern-auto-illustrator) | 37 | 8 | AGPL-3.0 | excluded | Testability: core function requires a configured image-generation backend. |
| [bincooo/SillyTavernExtension-JsRunner](https://github.com/bincooo/SillyTavernExtension-JsRunner) | 37 | 5 | NOASSERTION | excluded | Security: its documented purpose is executing arbitrary JavaScript in the page context; an arbitrary-code-execution surface is excluded from the safety corpus. |
| [SillyTavern/Extension-Idle](https://github.com/SillyTavern/Extension-Idle) | 36 | 12 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [bmen25124/SillyTavern-Magic-Translation](https://github.com/bmen25124/SillyTavern-Magic-Translation) | 36 | 9 | MIT | eligible, rank 24 |  |
| [SillyTavern/Extension-Silence](https://github.com/SillyTavern/Extension-Silence) | 36 | 8 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [Spadic21/ComfyInject](https://github.com/Spadic21/ComfyInject) | 35 | 11 | AGPL-3.0 | excluded | NSFW: its prompt template includes an explicit "erotic" image-prompt branch (it also requires a local ComfyUI server). |
| [SillyTavern/Extension-Notebook](https://github.com/SillyTavern/Extension-Notebook) | 35 | 9 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [mossyfield/ST-jeved](https://github.com/mossyfield/ST-jeved) | 35 | 6 | MIT | excluded | Testability/credentials: requires a dedicated external host API key (OpenRouter/NanoGPT/TypeSafe or a custom endpoint) before any rule can run. |
| [SillyTavern/Extension-Dice](https://github.com/SillyTavern/Extension-Dice) | 34 | 12 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-Mermaid](https://github.com/SillyTavern/Extension-Mermaid) | 34 | 7 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [lannashelton/ST-Outfits](https://github.com/lannashelton/ST-Outfits) | 33 | 6 | CC0-1.0 | eligible, rank 25 |  |
| [SillyTavern/SillyTavern-EdgeTTS-Plugin](https://github.com/SillyTavern/SillyTavern-EdgeTTS-Plugin) | 31 | 7 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-WebLLM](https://github.com/SillyTavern/Extension-WebLLM) | 25 | 13 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-Audio](https://github.com/SillyTavern/Extension-Audio) | 22 | 16 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-EmojiPicker](https://github.com/SillyTavern/Extension-EmojiPicker) | 19 | 7 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-ReactTemplate](https://github.com/SillyTavern/Extension-ReactTemplate) | 17 | 9 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-LaTeX](https://github.com/SillyTavern/Extension-LaTeX) | 16 | 8 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-CodeRunner](https://github.com/SillyTavern/Extension-CodeRunner) | 15 | 10 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-CodeMirror](https://github.com/SillyTavern/Extension-CodeMirror) | 15 | 7 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-Blip](https://github.com/SillyTavern/Extension-Blip) | 13 | 9 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-GroupGreetings](https://github.com/SillyTavern/Extension-GroupGreetings) | 13 | 5 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-DupeFinder](https://github.com/SillyTavern/Extension-DupeFinder) | 13 | 5 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-RVC](https://github.com/SillyTavern/Extension-RVC) | 13 | 5 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-Speech-Recognition](https://github.com/SillyTavern/Extension-Speech-Recognition) | 12 | 29 | GPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-ScreenShare](https://github.com/SillyTavern/Extension-ScreenShare) | 12 | 7 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-Spotify](https://github.com/SillyTavern/Extension-Spotify) | 12 | 2 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-QuickContextSize](https://github.com/SillyTavern/Extension-QuickContextSize) | 9 | 4 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-ScriptEvents](https://github.com/SillyTavern/Extension-ScriptEvents) | 8 | 3 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-ChromaDB](https://github.com/SillyTavern/Extension-ChromaDB) | 7 | 5 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-Randomizer](https://github.com/SillyTavern/Extension-Randomizer) | 7 | 5 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-RSS](https://github.com/SillyTavern/Extension-RSS) | 7 | 4 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-Enforce-Content](https://github.com/SillyTavern/Extension-Enforce-Content) | 7 | 4 | GPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-InjectManager](https://github.com/SillyTavern/Extension-InjectManager) | 7 | 3 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-CustomSliders](https://github.com/SillyTavern/Extension-CustomSliders) | 6 | 6 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-VideoBackgroundLoader](https://github.com/SillyTavern/Extension-VideoBackgroundLoader) | 6 | 2 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-HypeBot](https://github.com/SillyTavern/Extension-HypeBot) | 5 | 6 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-ImageMetadataViewer](https://github.com/SillyTavern/Extension-ImageMetadataViewer) | 5 | 5 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-Weather](https://github.com/SillyTavern/Extension-Weather) | 5 | 4 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-Variables](https://github.com/SillyTavern/Extension-Variables) | 4 | 4 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-LoremIpsum](https://github.com/SillyTavern/Extension-LoremIpsum) | 4 | 3 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-SamplerCommands](https://github.com/SillyTavern/Extension-SamplerCommands) | 3 | 4 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [SillyTavern/Extension-WebpackTemplate](https://github.com/SillyTavern/Extension-WebpackTemplate) | 2 | 2 | AGPL-3.0 | excluded | first-party SillyTavern organisation extension, not third-party |
| [N0VI028/JS-Slash-Runner-Doc](https://github.com/N0VI028/JS-Slash-Runner-Doc) | 1 | 1 | NOASSERTION | excluded | Tavern Helper documentation repository; Tavern Helper family exclusion. |


> Pinned commits are recorded as 12-character prefixes for readability; the full 40-hex SHA of every selected extension is authoritative in [`tests/browser/third-party-extensions.lock.json`](../../tests/browser/third-party-extensions.lock.json), which the compatibility gate reads and hashes.

## 4. Selected corpus (20 pinned client extensions)

| install name | repository | pinned commit | stars | license | capabilities |
| --- | --- | --- | --- | --- | --- |
| `rpg-companion-sillytavern` | [SpicyMarinara/rpg-companion-sillytavern](https://github.com/SpicyMarinara/rpg-companion-sillytavern) | `9c4800957e69` | 329 | NOASSERTION | DOM, chat-events, generation, prompt-injection, world-info, character, group-chat, quick-replies, macros, files, fetch, settings, slash-command, prompt-format, message-render, markdown, image, remote-network |
| `SillyTavern-Horae` | [SenriYuki/SillyTavern-Horae](https://github.com/SenriYuki/SillyTavern-Horae) | `7a8859897bbf` | 206 | NOASSERTION | DOM, chat-events, generation, character, files, fetch, settings, slash-command, prompt-format, message-render, image |
| `SillyTavern-Character-Creator` | [bmen25124/SillyTavern-Character-Creator](https://github.com/bmen25124/SillyTavern-Character-Creator) | `8ddf5ba08188` | 185 | MIT | DOM, chat-events, generation, world-info, character, group-chat, macros, files, fetch, settings, slash-command, prompt-format, markdown |
| `Extension-Summaryception` | [Lodactio/Extension-Summaryception](https://github.com/Lodactio/Extension-Summaryception) | `6a0afdc84fbd` | 182 | AGPL-3.0 | DOM, chat-events, generation, prompt-injection, fetch, settings, slash-command, prompt-format, remote-network |
| `st-stepped-thinking` | [cierru/st-stepped-thinking](https://github.com/cierru/st-stepped-thinking) | `9b58956c8e5f` | 173 | MIT | DOM, chat-events, generation, prompt-injection, character, macros, tokenizer, settings, slash-command, prompt-format, message-render |
| `SillyTavern-WorldInfo-Recommender` | [bmen25124/SillyTavern-WorldInfo-Recommender](https://github.com/bmen25124/SillyTavern-WorldInfo-Recommender) | `357e80f1dbd8` | 135 | MIT | DOM, chat-events, generation, world-info, character, group-chat, macros, settings, slash-command, prompt-format, markdown |
| `NemoPresetExt` | [NemoVonNirgend/NemoPresetExt](https://github.com/NemoVonNirgend/NemoPresetExt) | `55c29c484035` | 95 | NOASSERTION | DOM, chat-events, world-info, character, macros, files, fetch, tokenizer, settings, prompt-format, message-render, markdown |
| `SillyTavern-Roadway` | [bmen25124/SillyTavern-Roadway](https://github.com/bmen25124/SillyTavern-Roadway) | `8bd72bdbfecf` | 83 | MIT | DOM, chat-events, generation, world-info, character, group-chat, macros, settings, slash-command, prompt-format, message-render |
| `ST-Copilot` | [Supker/ST-Copilot](https://github.com/Supker/ST-Copilot) | `14809604817b` | 80 | MIT | DOM, chat-events, generation, world-info, character, group-chat, macros, files, fetch, tokenizer, settings, prompt-format, markdown, audio, image |
| `sillytavern-character-memory` | [bal-spec/sillytavern-character-memory](https://github.com/bal-spec/sillytavern-character-memory) | `35fcf22bf0a5` | 78 | NOASSERTION | DOM, chat-events, generation, world-info, character, files, fetch, tokenizer, settings, slash-command, prompt-format, markdown, image, remote-network |
| `Guinevere-UI-Extension` | [Bronya-Rand/Guinevere-UI-Extension](https://github.com/Bronya-Rand/Guinevere-UI-Extension) | `d93c056ccdd7` | 72 | AGPL-3.0 | DOM, chat-events, settings, fetch |
| `recast-post-processing` | [closuretxt/recast-post-processing](https://github.com/closuretxt/recast-post-processing) | `a7ac25a24787` | 66 | AGPL-3.0 | DOM, chat-events, generation, world-info, character, macros, settings, slash-command, message-render |
| `Prome-VN-Extension` | [Bronya-Rand/Prome-VN-Extension](https://github.com/Bronya-Rand/Prome-VN-Extension) | `9cf09fb307e8` | 65 | AGPL-3.0 | DOM, chat-events, character, group-chat, files, fetch, settings, slash-command, message-render, image |
| `SillyTavern-SimTracker` | [prolix-oc/SillyTavern-SimTracker](https://github.com/prolix-oc/SillyTavern-SimTracker) | `2ab0c814c820` | 64 | NOASSERTION | DOM, chat-events, generation, character, files, fetch, settings, slash-command, prompt-format, message-render, markdown |
| `SillyTavern-ReMemory` | [InspectorCaracal/SillyTavern-ReMemory](https://github.com/InspectorCaracal/SillyTavern-ReMemory) | `2c366257f8dc` | 61 | AGPL-3.0 | DOM, chat-events, generation, world-info, character, fetch, tokenizer, settings, slash-command, prompt-format, message-render |
| `InlineSummary` | [Kristyku/InlineSummary](https://github.com/Kristyku/InlineSummary) | `d720005c5b6e` | 58 | NOASSERTION | DOM, chat-events, generation, character, tokenizer, settings, slash-command, message-render |
| `Dooms-Enhancement-Suite` | [DangerDaza/Dooms-Enhancement-Suite](https://github.com/DangerDaza/Dooms-Enhancement-Suite) | `893b1e17f00f` | 57 | NOASSERTION | DOM, chat-events, generation, prompt-injection, world-info, character, group-chat, macros, files, fetch, settings, slash-command, message-render, markdown, image, remote-network |
| `narrative-agent` | [Lol1p0p/narrative-agent](https://github.com/Lol1p0p/narrative-agent) | `29a86d7323eb` | 48 | MIT | DOM, chat-events, generation, world-info, macros, fetch, settings, message-render |
| `SillyTavern-WTracker` | [bmen25124/SillyTavern-WTracker](https://github.com/bmen25124/SillyTavern-WTracker) | `8a5e42e6cbea` | 44 | MIT | DOM, chat-events, generation, world-info, character, group-chat, macros, tokenizer, settings, slash-command, prompt-format, markdown |
| `SillyTavern-Custom-Scenario` | [bmen25124/SillyTavern-Custom-Scenario](https://github.com/bmen25124/SillyTavern-Custom-Scenario) | `bf207fa1723b` | 42 | MIT | DOM, world-info, files, fetch, slash-command |

### 4.1 Per-extension safety review

- **`rpg-companion-sillytavern`** (`SpicyMarinara/rpg-companion-sillytavern` @ `9c4800957e69`): Cloned 9c48009 and read index.js, src/systems/**, manifest.json. No package.json install hooks, no eval(atob(, no remote script loader and no external fetch during load; fetch targets are ST's own /api routes (sprites, classify) plus an optional OpenAI-compatible API whose baseUrl defaults to an empty string. The single new Function is a JSON-repair fallback applied to the model's own tracker output, not to remote code.
- **`SillyTavern-Horae`** (`SenriYuki/SillyTavern-Horae` @ `7a8859897bbf`): Cloned 7a88598 and read index.js, core/**, manifest.json. No install hooks, eval/atob or dynamically loaded remote scripts; fetch calls target the extension's own locale/prompt JSON and ST API routes, with optional OpenAI-compatible auxiliary/embedding endpoints only when the user configures them. It imports ST modules rather than injecting remote code.
- **`SillyTavern-Character-Creator`** (`bmen25124/SillyTavern-Character-Creator` @ `8ddf5ba08188`): Cloned 8ddf5ba and read dist/index.js plus src/*.ts. No postinstall hook; the atob/createElement('script') occurrences are inside bundled React/zod libraries. The extension fetches only ST's /api/characters/import and /api/characters/merge-attributes with ST request headers; LLM calls go through ST's ConnectionManagerRequestService, not a hardcoded external host.
- **`Extension-Summaryception`** (`Lodactio/Extension-Summaryception` @ `6a0afdc84fbd`): Cloned 6a0afdc and read all seven runtime files. No install hooks, eval/atob or remote script loading; fetch targets are ST's /api/connection-manager/profiles and, only when selected, an OpenAI-compatible or Ollama endpoint the user enters. The default path uses ST's active connection.
- **`st-stepped-thinking`** (`cierru/st-stepped-thinking` @ `9b58956c8e5f`): Cloned 9b58956 and read index.js, thinking/*, settings/*. No install hooks, eval/atob or external fetches; the extension uses ST's Generate/setExtensionPrompt APIs and stores settings in extension_settings. All 13 runtime files were inspected for loaders and credential access; none were found.
- **`SillyTavern-WorldInfo-Recommender`** (`bmen25124/SillyTavern-WorldInfo-Recommender` @ `357e80f1dbd8`): Cloned 357e80f; the runtime is dist/index.js built from src/**. No postinstall scripts; atob/script-injection hits are bundled React/zod internals; there is no external fetch target and LLM calls use ST's ConnectionManagerRequestService. World-info writes go through ST's own API helpers.
- **`NemoPresetExt`** (`NemoVonNirgend/NemoPresetExt` @ `55c29c484035`): Cloned 55c29c4 and reviewed content.js plus src/*. No postinstall hooks; new Function and child_process occurrences are confined to dev scripts and tests outside the runtime entry. Runtime fetch calls are ST's /api/presets/save endpoints; the 75 MB of assets are NemoEngine preset-data JSON parts, not executables or opaque binaries.
- **`SillyTavern-Roadway`** (`bmen25124/SillyTavern-Roadway` @ `8bd72bdbfecf`): Cloned 8bd72bd and read dist/index.js plus src/index.ts. No install hooks, eval/atob, remote loaders or external fetch; LLM requests go through ST's ConnectionManagerRequestService and settings live in extension_settings.
- **`ST-Copilot`** (`Supker/ST-Copilot` @ `14809604817b`): Cloned 1480960 and read index.js plus src/*. No install hooks or remote script loading; fetch targets are ST's own /api routes (files, worldinfo, characters, caption, backgrounds, tokencount) and LLM calls use the ST connection manager or a user-configured endpoint. atob is used only to decode local session payload strings.
- **`sillytavern-character-memory`** (`bal-spec/sillytavern-character-memory` @ `35fcf22bf0a5`): Cloned 35fcf22 and reviewed index.js and its supporting modules. No install hooks or remote script loaders; at load only ST APIs are touched. Optional direct-provider endpoints and keys are user-entered settings; default routing goes through ST. The large fixture in the repo is a sample chat JSONL, not an executable.
- **`Guinevere-UI-Extension`** (`Bronya-Rand/Guinevere-UI-Extension` @ `d93c056ccdd7`): Cloned d93c056 and read index.js plus the theme-pack loader. No install hooks or remote loading; fetch is limited to reading a local theme-pack manifest inside the extension folder. Theme packs shipped in the repo can contain CSS/HTML/JS by design, and the review confirmed the shipped packs neither contact a network nor read credentials.
- **`recast-post-processing`** (`closuretxt/recast-post-processing` @ `a7ac25a24787`): Cloned a7ac25a and read all runtime files. No install hooks, eval/atob or external fetch; passes run through ST's chat-completion APIs and world-info helpers, with prompts assembled locally and settings stored in extension_settings.
- **`Prome-VN-Extension`** (`Bronya-Rand/Prome-VN-Extension` @ `9cf09fb307e8`): Cloned 9cf09fb and read index.js plus the runtime modules. No install hooks, eval/atob or external fetch; the only fetch is ST's /api/sprites/get; settings live in extension_settings and sprites come from the user's ST assets.
- **`SillyTavern-SimTracker`** (`prolix-oc/SillyTavern-SimTracker` @ `2ab0c814c820`): Cloned 2ab0c81 and read index.js, renderer.js and the tracker modules. No install hooks or remote loaders; fetch is limited to ST's /api/secrets/find. renderer.js evaluates user-authored template logic with new Function, a documented local feature; the repository is archived/sunset upstream.
- **`SillyTavern-ReMemory`** (`InspectorCaracal/SillyTavern-ReMemory` @ `2c366257f8dc`): Cloned 2c36625; twelve small runtime files. No install hooks, eval/atob, external fetch or credential access; it calls ST's generateRaw and world-info APIs and keeps memories in world-info books through ST helpers.
- **`InlineSummary`** (`Kristyku/InlineSummary` @ `d720005c5b6e`): Cloned d720005 and read all four runtime files. No install hooks, eval/atob, remote script loading or fetch at all; generation goes through ST's generateRaw, settings through extension_settings, and the extension only renders avatars/messages from chat data already in the page.
- **`Dooms-Enhancement-Suite`** (`DangerDaza/Dooms-Enhancement-Suite` @ `893b1e17f00f`): Cloned 893b1e1 and read index.js plus src/**. child_process appears only in tools/ developer scripts outside the runtime entry; the single new Function is the JSON-repair fallback (opt-out flag) for the model's own tracker output. The only external fetches are a GitHub release/version check the user triggers and a Google Fonts stylesheet; no credential reads, no remote script loader, no obfuscated payloads.
- **`narrative-agent`** (`Lol1p0p/narrative-agent` @ `29a86d7323eb`): Cloned 29a86d7 and read index.js, orchestrator/llm/tools modules and the manifest. No install hooks, eval(atob( or remote script loaders; new Function is used to compile the user's own custom-tool code (documented extensibility surface, local input only). Generation goes through ST's generateRaw and there is no external fetch target.
- **`SillyTavern-WTracker`** (`bmen25124/SillyTavern-WTracker` @ `8a5e42e6cbea`): Cloned 8a5e42e and reviewed dist/index.js and its sources. No install hooks, eval/atob or external fetch; LLM calls use ST's ConnectionManagerRequestService with the user's configured profiles. The createElement('script') hits are bundled React internals, not extension code.
- **`SillyTavern-Custom-Scenario`** (`bmen25124/SillyTavern-Custom-Scenario` @ `bf207fa1723b`): Cloned bf207fa and reviewed dist/index.js and src/**. No install hooks, eval(atob(, remote script loader or credential access; new Function compiles scenario scripts the user authors inside the extension (documented scripting feature, local data only). The only fetch is ST's /api/characters/import; the repository ships UI screenshots only, no adult assets.

### 4.2 Per-extension selection reason

- **`rpg-companion-sillytavern`**: Eligible rank 1/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 329 stars, 71 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`SillyTavern-Horae`**: Eligible rank 2/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 206 stars, 27 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`SillyTavern-Character-Creator`**: Eligible rank 3/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 185 stars, 25 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`Extension-Summaryception`**: Eligible rank 4/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 182 stars, 38 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`st-stepped-thinking`**: Eligible rank 5/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 173 stars, 19 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`SillyTavern-WorldInfo-Recommender`**: Eligible rank 6/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 135 stars, 18 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`NemoPresetExt`**: Eligible rank 7/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 95 stars, 12 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`SillyTavern-Roadway`**: Eligible rank 8/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 83 stars, 13 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`ST-Copilot`**: Eligible rank 9/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 80 stars, 12 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`sillytavern-character-memory`**: Eligible rank 10/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 78 stars, 6 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`Guinevere-UI-Extension`**: Eligible rank 11/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 72 stars, 9 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`recast-post-processing`**: Eligible rank 12/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 66 stars, 7 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`Prome-VN-Extension`**: Eligible rank 13/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 65 stars, 9 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`SillyTavern-SimTracker`**: Eligible rank 14/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 64 stars, 7 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`SillyTavern-ReMemory`**: Eligible rank 15/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 61 stars, 7 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`InlineSummary`**: Eligible rank 16/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 58 stars, 11 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`Dooms-Enhancement-Suite`**: Eligible rank 17/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 57 stars, 9 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`narrative-agent`**: Eligible rank 18/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 48 stars, 2 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`SillyTavern-WTracker`**: Eligible rank 19/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 44 stars, 11 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.
- **`SillyTavern-Custom-Scenario`**: Eligible rank 20/25 by the documented ordering (stars desc, forks desc, pushedAt desc, official-listing tie-break): 42 stars, 4 forks. The top-20 cut is rank 20 at 42 stars (next eligible is 40); this repository is inside it.

## 5. Tavern Helper exclusion statement

Tavern Helper (酒馆助手, the `N0VI028/JS-Slash-Runner` project) is excluded from this corpus **in every form**: the
canonical repository, any fork, mirror, rename, alias, translated copy, documentation repository, or companion
template. The dedicated `JS-Slash-Runner` and `"Tavern Helper" in:name,description` searches returned the family; the
canonical repository (1396 stars at the snapshot) and the two companion repositories in the candidate pool are marked
`excluded` with the Tavern Helper reason. No repository in the selected 20 names or derives from Tavern Helper.

**First-party exclusion statement.** The corpus is a THIRD-PARTY corpus: every repository owned by the SillyTavern
organisation (the official `SillyTavern/*` extensions) is excluded from selection and kept in the candidate table with
the reason "first-party SillyTavern organisation extension, not third-party". No repository under `SillyTavern/*` is
selected. The five organisation-published extensions that the initial ranking placed in the top 20 were replaced by the
next five eligible community repositories under the same ranking.

## 6. NSFW and security exclusion statement

NSFW content was excluded by reading each candidate's README/description/topics/metadata, not by name: 6
repositories in the pool are excluded for explicit sexual content, NSFW browsing/access, adult haptic-device
integration or explicit "erotic" image-prompt features, with the specific README evidence recorded in
`exclusionReason`. Security: no selected extension has an install hook, a remote script loader, an obfuscated
downloader, a credential harvester or a crypto miner; 2 pool repositories are excluded as
arbitrary-code-execution surfaces (including one that automatically executes scripts from chat HTML), and the three
selected extensions that use `new Function` (JSON repair, user-authored tracker templates and user-authored custom tool
scripts) apply it to local data only, as recorded in their `safetyReview`. The first-party exclusion accounts for
53 pool repositories; there are 4 non-client/non-extension and 8
testability exclusions.

## 7. Reproducing and consuming the corpus

The machine-readable file is `tests/browser/third-party-extensions.lock.json` (schemaVersion 1). Its SHA256 is:

```text
2f2a5843993b004d1538d957c1fbf90c11d639551d85298931eb3ad7abb7f527  tests/browser/third-party-extensions.lock.json
```

Install name, per the lock's `installMethod`: check out each `selected[].commit` into
`<dataRoot>/<handle>/extensions/<selected[].name>`; the pinned frontend then loads
`/scripts/extensions/third-party/<name>/manifest.json`. No branch name is ever checked out.

To re-derive the snapshot: run the queries in section 2.1 through `gh api` at a new timestamp, deduplicate and rank
as in section 2.2, apply the filters in section 2.3, then re-resolve each selected commit with
`gh api repos/OWNER/REPO/commits?per_page=1`. Record one new `snapshotAt` for all rows; never mix snapshot times.
