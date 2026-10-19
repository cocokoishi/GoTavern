# AGENTS.md

GoTavern is a clean-room Go reimplementation of the **SillyTavern backend/server**, not a new frontend and not a partial clone.

Read `ARCHITECTURE.md` before changing code.

## Non-negotiable rules

1. **Compatibility baseline:** SillyTavern `1.19.0`, commit `06bde939fb1e9c4c8d8641d810f0a916b5bce127` until an explicit baseline-bump PR changes it.
2. **Upstream is the oracle:** read the pinned SillyTavern source before implementing behavior. Do not invent routes, fields, defaults, errors or status codes from memory.
3. **Do not rewrite the frontend.** `upstream/public/**` must remain byte-identical to the pinned SillyTavern `public/**`. Generated frontend artifacts may only be produced by the pinned upstream build process.
4. **HTTP compatibility is exact:** method, path, query/body parsing, auth, CSRF, response status/body/header shape, redirects, uploads and streaming must match upstream behavior.
5. **Disk compatibility is exact:** use SillyTavern's `config.yaml` and data-root layout directly. Do not introduce a private database/schema for canonical user data.
6. **Preserve unknown fields.** Do not round-trip JSON/cards through narrow Go structs if that would discard data.
7. **All sensitive writes are locked + atomic.** Temp file in the same directory, flush as appropriate, atomic replace/rename, stable keyed locking.
8. **No fake compatibility.** A missing feature is `partial`/`unsupported`/`not implemented`; never return a fabricated success or silently substitute an approximate implementation.
9. **Frontend extensions are first-class.** Tavern Helper / JS-Slash-Runner and LittleWhiteBox are mandatory E2E compatibility probes. Do not special-case them in production code.
10. **Node server plugins are the sole explicit ecosystem non-goal.** Do not attempt to emulate them.
11. **Production must not require Node.js.** Node/npm may be used in CI/build tooling to reproduce pinned upstream-generated frontend artifacts and to run the reference server.
12. **Keep `main` buildable and runnable.** Make small commits by module/contract.

## Required workflow for every endpoint/module

1. Locate the upstream mount point in `src/server-main.js` / `src/server-startup.js`.
2. Read the full handler under `src/endpoints/**` plus every helper/middleware that changes observable behavior.
3. Add/update `docs/api-inventory.md`.
4. Add a Node-vs-Go differential contract test.
5. Implement the Go behavior.
6. Compare response **and filesystem side effects**.
7. Add Node->Go and Go->Node round-trip tests for persistent data.
8. Update `docs/compat-matrix.md`.
9. Run formatting, tests and build before committing.

If behavior is uncertain, write a probe against the pinned Node server. Do not guess.

## Phase order

Do not skip Phase 0.

- **Phase 0:** API/config/data inventory, pinned upstream frontend sync/hash guard, Node reference fixture, differential harness.
- **Phase 1:** startup, embedded upstream frontend, config, Basic Auth, user accounts/sessions, CSRF, login, settings needed for UI boot.
- **Phase 2:** characters/cards, chats/groups, world info, presets/settings, avatars/backgrounds/themes/quick replies/assets/files.
- **Phase 3:** secrets, shared outbound proxy/SSRF transport, providers, streaming generation, tokenizers.
- **Phase 4:** extension install/update/delete/static loading; real Tavern Helper and LittleWhiteBox E2E.
- **Phase 5:** remaining built-ins until the API inventory has no unexplained gaps.

## Design preferences

- Prefer standard library and small dependencies.
- Prefer pure Go / `CGO_ENABLED=0` where parity allows.
- Keep endpoint packages visibly aligned with upstream modules; avoid premature generic frameworks.
- All outbound HTTP must use the shared transport layer so proxy, request overrides and SSRF controls cannot be bypassed.
- Stream large uploads/chats/provider responses; do not allocate based on SillyTavern's large maximum body limits.
- Never log API keys, cookies, passwords, `secrets.json` values or Authorization headers.

## Migration safety

Migration/copy tools must treat the SillyTavern source as **read-only**. Never rename, delete, chmod, clean, migrate, lock or rewrite source files. Copy the complete configured data root, not only visible user folders: account state under `_storage` and `cookie-secret.txt` are compatibility data too.

## Definition of success

The unmodified upstream browser frontend and supported frontend extensions must be unable to tell that the Node backend has been replaced, except for documented operational details and the explicit lack of Node server plugins.
