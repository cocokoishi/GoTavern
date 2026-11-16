# Beta 1 install verification (Layer A, local)

**Subject:** the `v0.1.0-beta.1` candidate tree — the commit that introduced this document. Build command is
exactly the release workflow's, from the repository root:

```powershell
$env:CGO_ENABLED = '0'
go build -trimpath -ldflags="-s -w -X main.version=v0.1.0-beta.1" -o <scratch>\bin\gotavern.exe ./cmd/gotavern
```

A `windows/amd64` binary was built the same way (`$env:GOOS='windows'; $env:GOARCH='amd64'`) and executed under
this host's x64 emulation; the host itself is Windows/arm64. **Label: Layer A.** The CI verdict for packaged
installation is carried by `GoTavern release qualification`, `GoTavern drop-in qualification` and the release
workflow's `prepublish-qualification` job, all in the same-SHA wave; nothing here replaces them.

Performed on 2026-11-15 in a scratch directory (`%TEMP%\gt-beta1-install-verify`), with the repository and the
pinned `../SillyTavern` checkout never written. No network was used beyond loopback.

## 1. What was executed

| arm | subject tree | result |
|---|---|---|
| A. binary-only drop-in | copy of pinned SillyTavern `1.19.0` (excluding `.git`, `node_modules`, `tests`, `backups`), binary copied in | **FAILS the tokenizer contract** — see §2. Everything else passed |
| B. drop-in, proven recipe | same tree, binary **and** the archive's `src/tokenizers/` contents copied in | **PASS** — all assertions below |
| C. used tree | tree with a planted 18.5 MB card, a pinned-shape chat and a third-party extension under `public/scripts/extensions/third-party/` | **PASS** — served before and after restart |
| D. fresh archive layout | empty directory with `gotavern.exe`, `start.sh`, `LICENSE`, `THIRD_PARTY_NOTICES.txt`, `BUILD-INFO.txt` and the 23-file `src/tokenizers/` | **PASS** |
| E. Linux/macOS | — | **NOT EXECUTED on this host** (Windows/arm64; no Linux runner without network). The archive members are layout-verified by the release workflow's inspector, which asserts the tar/zip set, `src/tokenizers/` non-empty and `gotavern`/`start.sh` executable bits |

## 2. The finding that changed the README

A stock SillyTavern `1.19.0` tree carries **9** files in `src/tokenizers/`; the release archive carries **23**.
With only the binary copied in:

- `gotavern assets verify` prints `gotavern: manifests/tokenizers.sha256: manifest has 23 entries but . has 9
  files` and exits **2**;
- `POST /api/tokenizers/gpt2/encode {"text":"Hello world"}` answers `200 {"ids":[],"count":0,"chunks":[]}`
  where a complete tree answers `{"ids":[15496,995],"count":2,...}` — a silent empty result, not an error;
- sentence-piece models that are among the 9 (llama) still work, so the degradation is partial and quiet.

Consequence: the README's original draft claim ("takes tokenizer data from the `src/tokenizers/` your
SillyTavern install already has") was **false** and was removed. The documented recipe now copies the
archive's `src/tokenizers/` contents and tells the user to run `assets verify`, which is the check that can
fail. A second draft command was also false: `Expand-Archive gotavern-windows-amd64.zip -DestinationPath .`
run inside an existing SillyTavern folder fails in Windows PowerShell 5.1 with
`Failed to create file '...\src\tokenizers\claude.json' ... already exists. Use the -Force parameter`, and
with `-Force` it overwrites the user's `LICENSE`. The documented recipe extracts to a temporary directory and
copies the two pieces instead.

## 3. Assertions observed on the proven recipe (arm B)

| observation | value |
|---|---|
| readiness | HTTP 200 on `GET /version`; warm restarts 0.64–0.69 s |
| `GET /version` body | `{"agent":"SillyTavern:1.19.0:Cohee#1207","pkgVersion":"1.19.0","gitRevision":"06bde939f",...}` — the pinned compatibility record |
| `GET /` | 200, 734,837 B, sha256 `647c22a47feff92148c07a0f821bbd84feea7400e543085841a95a418679419f`, byte-identical to the pinned frontend's `public/index.html` |
| existing `config.yaml` | sha256 unchanged across boot and restart; not rewritten |
| pre-existing files | 0 modified, 0 deleted, on first boot and on restart |
| `data/` first boot | +203 added files (pinned fresh-install scaffold: instruct/context/characters presets, NovelAI/TextGen/Kobold settings, backgrounds, themes, reasoning, user profiles, seed content, `cookie-secret.txt`, `settings.json`, `stats.json`, `content.log`) |
| restart | +0 added, +0 modified, +0 deleted |
| write path | `POST /api/characters/create` → `201`; new card served at `GET /characters/<name>.png` (200, `image/png`, 55,441 B) and `GET /thumbnail?type=avatar&file=<name>.png` (200, `image/png`, 3,798 B); `POST /api/chats/save` → `{"ok":true}`, then `POST /api/chats/get` returned both messages |
| persistence | abrupt process kill + restart: created character, chat and avatar all present |
| tokenizers after the two-piece copy | 23 files; `assets verify` exit 0 and prints `verified installed tokenizers (<root>\src\tokenizers)`; `gpt2/encode` ids `[15496,995]` |
| process tree | `gotavern.exe` + its `conhost` child only; no `node`/`npm` spawned or invoked |
| binary | `CGO_ENABLED=0` (confirmed via `go version -m`); `gotavern version` prints `GoTavern v0.1.0-beta.1` and `SillyTavern baseline 1.19.0 (06bde939fb1e9c4c8d8641d810f0a916b5bce127)` |
| port already in use | fails fast with `...listen port is already in use.: listen tcp4 127.0.0.1:8000: bind: ...` plus a hint to stop the other server or pass `--port <n>` |

## 4. Assertions observed on the fresh archive layout (arm D)

- `assets verify` **before** boot: exit 0, `verified upstream/public`, `verified upstream/default`,
  `verified upstream/generated`, `verified installed tokenizers (<scratch>\fresh\src\tokenizers)`.
- Boot readiness 1.65 s (arm64 native) / 1.68 s (amd64 under emulation). `Start.cmd` (the real Windows
  launcher, not `start.sh`) starts the same build in 0.64 s.
- The first start creates a `config.yaml` byte-identical to the pinned tree's generated config (3,310 B,
  sha256 `D0E9063A…C461`) and scaffolds `data/`; `GET /`, `GET /version`, `/api/settings/get`,
  `/api/characters/all` and `gpt2/encode` all answer as in arm B.

## 5. What this record does NOT prove

- Linux/macOS drop-in execution (not executed here; layout and launcher are CI-gate inspected only).
- The published archives' bytes: this record used locally built binaries. The published-bytes install is
  asserted after publication by `GoTavern published-release install smoke` and by the release workflow's
  `prepublish-qualification`, which installs the candidate's own six archives through the installers.
- Windows-only installer behaviour not relevant to the drop-in (replacing a running executable, shortcuts).
- Any provider/network path: no network was used.
