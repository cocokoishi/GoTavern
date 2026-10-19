# Real Extension Compatibility Coverage

This file tracks backend/browser contracts observed from real SillyTavern frontend extensions. It is both a static research record and a target for dynamic Playwright capture.

It is **not** permission to special-case these extensions in GoTavern. Every discovered dependency should be satisfied by general SillyTavern compatibility.

## Probe revisions

Reproducible release gates initially pin:

```text
N0VI028/JS-Slash-Runner@837a6288135cde61522a9279173b98020f08807e
RT15548/LittleWhiteBox@9e71caef9ba7b3ca324ce9f1cb06a69ff54d734b
```

A non-gating current-head smoke run should supplement these pinned revisions at release time.

Statuses used below:

- `static`: found in extension source;
- `dynamic`: observed in a real browser run;
- `covered`: has a Node-vs-Go differential/E2E case;
- `plugin-excluded`: depends on arbitrary Node server-plugin functionality outside GoTavern scope.

This initial document is based on static inspection. Dynamic capture must expand it rather than treating the list as exhaustive.

---

## Tavern Helper / JS-Slash-Runner

Tavern Helper is a deep compatibility probe because it imports SillyTavern frontend internals and also calls backend APIs directly.

### Direct backend calls statically observed

| Route | Method | Observed use | Initial status |
|---|---|---|---|
| `/api/backends/chat-completions/status` | POST | custom endpoint/model enumeration | static |
| `/api/backends/chat-completions/generate` | POST | helper/raw generation, including streaming | static |
| `/api/characters/import` | POST multipart | raw PNG/card import | static |
| `/api/characters/create` | POST multipart | character creation | static |
| `/api/characters/edit` | POST multipart/form | character and lorebook-linked mutations | static |
| `/api/avatars/upload` | POST multipart | persona/avatar write | static |
| `/api/avatars/delete` | POST | persona/avatar delete | static |
| `/api/settings/get` | POST | refresh aggregated SillyTavern settings/world state | static |
| `/api/extensions/version` | POST | installed extension repo metadata | static |
| `/api/extensions/install` | POST | extension installation | static |
| `/api/extensions/update` | POST | extension update | static |
| `/api/extensions/delete` | POST | extension removal/reinstall | static |

Do not assume this table is complete. Tavern Helper also calls functions imported from SillyTavern modules; those functions may invoke additional backend routes indirectly.

### Frontend/internal-module ABI statically observed

Tavern Helper imports or consumes upstream frontend facilities including, among others:

```text
@sillytavern/script
@sillytavern/scripts/openai
@sillytavern/scripts/reasoning
@sillytavern/scripts/sse-stream
@sillytavern/scripts/power-user
@sillytavern/scripts/utils
@sillytavern/scripts/world-info
@sillytavern/scripts/extensions
@sillytavern/scripts/user
```

Therefore extension compatibility depends on more than endpoint paths. Release E2E must detect:

- failed dynamic/static module imports;
- incorrect MIME types;
- unexpected CSP restrictions;
- missing frontend exports caused by a mismatched frontend baseline;
- event ordering/payload differences caused by backend state;
- same-origin resource URL differences.

### Generation semantics observed

Current Tavern Helper generation code:

- obtains model lists through `/api/backends/chat-completions/status`;
- creates generation parameters using SillyTavern frontend state;
- can override custom provider URL/key/model and generation parameters;
- handles YAML custom request headers/body include/exclude data;
- can request tools, `tool_choice` and JSON schema;
- forces reasoning capture in relevant helper generation paths;
- emits/observes SillyTavern generation events;
- POSTs final generation data to `/api/backends/chat-completions/generate`;
- consumes the response through SillyTavern's SSE parser;
- handles `[DONE]`, reasoning and tool-call accumulation;
- supports abort through `AbortController` and emits generation-stopped state.

Consequently, Tavern Helper acceptance requires provider-wire and browser-event comparison, not only an HTTP success response.

### Mandatory dynamic scenarios

Dynamic Playwright coverage must eventually mark the following `covered`:

1. install from Git URL;
2. reload and module/static discovery;
3. extension version/update path;
4. character create/edit/import;
5. persona/avatar path;
6. lorebook/world-info-related workflow;
7. local/global/chat variable workflow;
8. STscript/Quick Reply interaction;
9. rendered UI/card behavior followed by reload;
10. custom API model status;
11. non-streaming helper generation;
12. streaming text generation;
13. reasoning stream;
14. tool calling + JSON schema;
15. cancellation;
16. extension remove/reinstall.

For generation scenarios record both the request Tavern Helper sends to GoTavern and the final request GoTavern sends to the recording provider.

---

## LittleWhiteBox

LittleWhiteBox is useful in two distinct ways: as a frontend extension using standard SillyTavern APIs, and as a repository that also contains its own optional/feature-specific Node server plugin.

### Standard SillyTavern backend calls statically observed

| Route | Method | Observed use | Initial status |
|---|---|---|---|
| `/api/files/upload` | POST | extension storage/vector/story/assistant files | static |
| `/api/worldinfo/get` | POST | worldbook/material/planner access | static |
| `/api/groups/all` | POST | group/chat related migration/state | static |
| `/api/sd/ping` | POST | SD WebUI/provider connectivity path | static |
| `/api/characters/create` | POST multipart | browser/provider acceptance fixture paths | static |

Additional standard routes are expected as dynamic coverage expands.

All standard SillyTavern API dependencies are in scope and must work without modifying LittleWhiteBox frontend source.

### Explicit Node server-plugin boundary

The inspected repository contains:

```text
server-plugin/littlewhitebox-server/
```

Its documented mount is:

```text
/api/plugins/littlewhitebox-server/
```

The plugin provides functionality such as background image/draw jobs and Exa web proxying, with in-process task state and Node-side provider/runtime code.

Arbitrary Node SillyTavern server plugins are an explicit GoTavern non-goal. Therefore routes/features whose implementation truly comes from this plugin are classified `plugin-excluded`, not silently emulated.

Examples include the plugin's own `/status`, `/v1/jobs...`, `/v1/draw-runs...`, `/v1/web/exa/...` families described by the plugin itself.

This does **not** excuse failures in LittleWhiteBox features that use normal built-in SillyTavern frontend/backend APIs.

### Mandatory dynamic scenarios

1. frontend extension installation/load/reload;
2. normal file-backed extension storage through `/api/files/...`;
3. worldbook access through built-in world-info APIs;
4. representative group-related built-in API use;
5. representative built-in image proxy connectivity path when configured;
6. browser console/network error audit;
7. clear detection/report of server-plugin-dependent features rather than fake success.

---

## Expressions extension

The pinned Expressions extension calls GET /api/sprites/get?name=... to list sprite files for a character. GoTavern's Node differential fixture covers this route's authentication, MIME filtering, labels, modification-time paths, and character subfolders. Browser rendering and retrieval of the returned asset paths remain untested.

---

## Dynamic capture procedure

Playwright should instrument `fetch`/XHR/network observation externally from the test harness without modifying shipped `public/**` or extension source.

For each real extension run record:

- method/path;
- request content type/body shape summary;
- response status/content type;
- whether request was direct extension code or indirectly triggered through an imported SillyTavern helper where traceable;
- browser console/page errors;
- extension revision;
- test scenario ID.

A CI helper should compare newly observed `/api/**`, user-resource and `/scripts/**` paths against this document/inventory and fail or open a clearly visible diff when a new dependency appears.

The objective is that extension ecosystem drift becomes an explicit compatibility task instead of an unexplained user report.
