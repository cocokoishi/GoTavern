# alpha.20 installer, CLI and release-UX verification (M8)

Status: **LOCAL EVIDENCE ONLY (Windows arm64 development host).** This is Layer A: it exercises the shipped
release mechanics as a user would, on the one platform this host can execute. Linux, macOS and Docker are
**UNEXECUTED-LOCAL** and remain CI gates; the exact gate names are in §4. The target release tested here is the
published **`v0.1.0-alpha.19`** archive (alpha.20 has no published archive yet — verifying the alpha.20 archive is
the post-publication step, M12, and is not claimed here).

Raw artifacts: [`raw/release-ux/`](raw/release-ux/) (`installer-verification.json`, `cli-verification.json`, the
installer/CLI logs and the installed-binary boot artifact). Subject: the windows/arm64 archive installed by
`install.ps1` (installed `gotavern.exe` sha256 `C23BB54CAE586BD612C6BDC0257DE7F675AB5620261C4EFBD2FFEAF0D4FD7FE0`).

## 1. Installer / update / rollback (13/13 checks PASS)

The harness downloads the published windows/arm64 archives for alpha.19 and alpha.18, serves them from a
**loopback mirror** in the documented layout (`<root>/<tag>/` and `<root>/latest/download/`), and runs the
repository's `install.ps1` (not a copy).

| id | check | result |
|---|---|---|
| V1 | fresh install, **specific version**, checksum verified, `src/tokenizers` + `BUILD-INFO.txt` + `Start.cmd` present, installed binary reports `GoTavern v0.1.0-alpha.19` | PASS |
| V2 | **re-install** over a directory holding a user `config.yaml`, `data/default-user/settings.json` and a chat `.jsonl`: all three SHA-256 identical afterwards; the installer prints which runtime state it preserved | PASS |
| V3 | **tampered archive** (one byte flipped in the mirror copy): installer exits non-zero with `SHA-256 verification failed`, installs nothing, no `gotavern.exe` appears | PASS |
| V4 | **unpinned / latest-stable** install through `latest/download` resolves and installs alpha.19 | PASS |
| V5 | **manual unpack** + `checksums.txt` verification of the published archive; binary reports alpha.19 | PASS |
| V6 | **upgrade** alpha.18 → alpha.19 (version moved, user `config.yaml` byte-identical) then **rollback** alpha.19 → alpha.18 (version moved back, config still byte-identical) | PASS |
| V7 | the **installed binary really boots**: `tools/perf/a19-boot.mjs` boots it against a generated 100-card tree, first `/version` answers 200 | PASS |
| V8 | the launcher is a passthrough (`gotavern.exe %*`), not a bundler | PASS |
| V9 | platform-limits marker (see §4) | INFO |

**Existing SillyTavern / user data is never overwritten:** V2 proves the three runtime-state carriers
(`config.yaml`, a user settings document, a chat) are byte-identical after a re-install; V6 proves the same
config survives an upgrade and a rollback. The installer only replaces the binary, `src/tokenizers` (staged and
swapped), `Start.cmd`, `LICENSE`, `THIRD_PARTY_NOTICES.txt` and `BUILD-INFO.txt`, which is what the script's
`stat`/copy sequence shows and what the hashes confirm.

**A measured harness trap, not a product finding:** the first attempt at this harness downloaded 0.6 MB in
over 12 minutes. That is Windows PowerShell 5.1's progress-bar pathology, which `install.ps1:22-30` documents
and mitigates with `$ProgressPreference='SilentlyContinue'`; the *harness* did not set it. With the preference
set, the same 60.6 MB download took **2.2 s**. This independently reproduces the installer's recorded reason for
that one-line preference, and the harness now sets it too.

## 2. CLI and first-run behaviour (10 PASS, 3 UNEXECUTED-LOCAL)

| id | check | result |
|---|---|---|
| cli-help | `--help` exits 0 and names GoTavern + `version` | PASS |
| cli-version | `version` prints `GoTavern v0.1.0-alpha.19` **and** the pinned baseline `SillyTavern 1.19.0 (06bde939…)` | PASS |
| cli-version-flag | `--version` in the flag position works | PASS |
| cli-ready-line | boot prints a truthful Ready line with the real URL (`Ready: GoTavern is serving at http://127.0.0.1:18790/`) and `GET /version` answers **200** at that URL; the body is the pinned compatibility `/version` record (`agent`, `pkgVersion` 1.19.0, pinned `gitRevision`), not a GoTavern build identity (AGENTS hard rule 17) | PASS |
| cli-boot-identity-paths | first-run output names GoTavern + version + baseline, and the real install root, config file and data root | PASS |
| cli-quiet-default | no internal stage-timing lines on the default surface | PASS |
| cli-no-ansi-when-redirected | redirected (non-TTY) output contains no ANSI escapes | PASS |
| cli-port-conflict | port already held: bounded exit with a causal error naming the port (`listen tcp4 127.0.0.1:18791: bind: … in use`) and the "startup aborted" condition | PASS |
| cli-invalid-config | malformed `config.yaml`: non-zero exit, names `YAMLParseError`/`config.yaml` and the syntax position | PASS |
| cli-launcher-passthrough | `Start.cmd version` from the installed archive reports alpha.19 | PASS |
| cli-tty-colour | interactive TTY colour path | UNEXECUTED-LOCAL (no interactive console in this harness; the non-TTY branch passed; CI covers console fixtures) |
| cli-reverse-proxy | proxy/forwarded-header behaviour | UNEXECUTED-LOCAL (needs an external reverse proxy; CI: `dropin-qualification.yml`) |
| installer-linux-macos-docker | Unix installers, macOS, Docker | UNEXECUTED-LOCAL (§4) |

Honest limits: the exit **code** of the conflict/invalid-config runs is not readable through the harness's
`Start-Process` redirection (it reports empty); the rows rest on process termination plus the named, causal
error text, which is what a user sees. The TTY colour branch is not claimed.

## 3. Six-platform matrix claims, re-checked against the tree

`docs/INSTALLATION.md` §2 and `.github/workflows/` state which archives are executed. Re-read, not quoted from
memory:

| platform | release claim | evidence in the tree | this host |
|---|---|---|---|
| linux/amd64 | executed in CI | `release-qualification.yml` `qualify-linux-amd64` (build, assets verify, fresh boot, idempotence, update, rollback); `release-install-smoke.yml` installs and boots the published archive | UNEXECUTED-LOCAL |
| linux/arm64 | executed under QEMU in CI | `release-qualification.yml` job set (QEMU); `release-install-smoke.yml` opens the archive | UNEXECUTED-LOCAL |
| darwin/amd64 | executed on a native macOS runner in CI | `release-qualification.yml`; `release-install-smoke.yml` records darwin as opened, not run (per its header comment) | UNEXECUTED-LOCAL |
| darwin/arm64 | build + archive inspection only | same; the README limit says the arm64 macOS runner was unavailable | UNEXECUTED-LOCAL |
| windows/amd64 | executed in CI (installer over a running exe, separators, registry, `cmd.exe`) | `release-qualification.yml` `qualify-windows-amd64` + `scripts/qualify-install-windows.ps1`; `release-install-smoke.yml` windows job over real TLS under Windows PowerShell 5.1 | UNEXECUTED-LOCAL |
| windows/arm64 | **BUILD-ONLY in CI** (no hosted arm64 Windows runner) | `release.yml` builds the archive; no workflow boots it | **EXECUTED HERE**: install (specific + latest), re-install, tamper refusal, manual unpack, upgrade, rollback, installed-binary boot, launcher, first-run, port conflict, invalid config — the archive runs on this arm64 host (Layer A, not a CI row) |
| Docker | publish path executed and pull-back verified in CI, no multi-arch index | `docker.yml` + recorded dispatch run (see `docs/INSTALLATION.md` §1/§11) | UNEXECUTED-LOCAL (no docker) |

Consequence for wording: "windows/arm64 BUILD-ONLY" is accurate **for CI**; this verification is the first
local evidence that the published arm64 archive installs and boots, and it is labelled Layer A so it cannot be
mistaken for a workflow result.

## 4. What remains unexecuted, and the gate that covers each

| surface | why unexecuted here | CI gate |
|---|---|---|
| `install.sh` (Linux/macOS), Unix launcher `start.sh` | no `sh`, no WSL, no macOS on this host | `release-install-smoke.yml` (real TLS), `release-qualification.yml` (`qualify-linux-amd64`, cross-baseline), `scripts/test-install-sh.sh` |
| macOS amd64/arm64 runtime | no macOS runner reachable locally | `release-qualification.yml` darwin steps; arm64 stays UNVERIFIED as the README limits table states |
| Docker image build/pull/publish | no Docker daemon | `docker.yml` (build, in-image `assets verify`, pull-back after push) |
| linux/arm64 runtime | no QEMU/arm64 Linux here | `release-qualification.yml` QEMU job |
| reverse proxy, interactive TTY colour | needs an external proxy / a real console | `dropin-qualification.yml`, console fixtures |
| the **alpha.20** archive itself | unpublishable at verification time (no tag) | M12 post-publication verification (the Lead's release step) |

No item above is presented as covered by the local run.
