# Cross-platform execution: the archives are executed, not just inspected

`release.yml` builds six archives. Before this gate, the release matrix said only linux/amd64 and windows/amd64 were
executed; linux/arm64, darwin/amd64, darwin/arm64 and windows/arm64 were **BUILT + ARCHIVE-INSPECTED only**. That was
accurate — the repository had no runner of those shapes — but "cross-compiled" is not "runtime-qualified", and a
release that ships an archive nobody has ever run cannot claim it works.

This gate runs the archives **the release build itself produced** on each reachable platform:

| target | how it executes | where |
|---|---|---|
| linux/arm64 | the archive is extracted, `gotavern version` runs, the server boots and its `/version` is polled **inside an arm64 container under QEMU** | `execute-linux-arm64` (ubuntu-24.04, `docker/setup-qemu-action`) |
| darwin/amd64 | the archive is extracted, `gotavern version` runs, the server boots and its `/version` is polled | `execute-darwin-amd64` (macos-15-intel) |
| darwin/arm64 | same, on native arm64 | `execute-darwin-arm64` (macos-14) |
| windows/arm64 | **NOT EXECUTED** — no windows/arm64 hosted runner exists | `windows-arm64-boundary` asserts the boundary text stays "NOT EXECUTED" with its reason, and fails if the matrix ever claims execution without a gate |

The jobs download the build artifact by archive name, so the executed bytes are the ones the build job inspected and
the publish job would upload. `publish` **needs** all of `execute-linux-arm64`, `execute-darwin-amd64`,
`execute-darwin-arm64` and `windows-arm64-boundary`: a release whose non-x64/x64 archives were never executed cannot
publish.

## What is asserted

For every executed target:
1. the archive extracts and contains an executable `gotavern` (mode bits asserted for tar archives);
2. `gotavern version` runs on the target and identifies GoTavern;
3. the server **boots from a clean tree** and answers `GET /version` within a bounded poll;
4. the answer reports the pinned SillyTavern version (`pkgVersion: 1.19.0`);
5. for linux/arm64 the emulation itself is proven first: the container reports `uname -m` = `aarch64`, and the
   readiness poll runs in the same network namespace as the server (a container-local 127.0.0.1 listener is NOT
   reachable through a published port — measured, and the reason the first version failed while the server log said
   `listening on IPv4: 127.0.0.1:8831`).

## Evidence

`GoTavern Release` workflow-dispatch dry run **41381018237** (success, head `cef6113`) is the first run where all five
jobs pass:

- `execute-linux-arm64`: `emulated container uname -m: aarch64`, `ok: linux/arm64 archive executed under QEMU and
  answered /version with the pinned version`;
- `execute-darwin-amd64`: `ok: darwin/amd64 archive executed on x86_64 and answered /version`;
- `execute-darwin-arm64`: `ok: darwin/arm64 archive executed on arm64 and answered /version`;
- `windows-arm64-boundary`: `ok: windows/arm64 is still BUILT + ARCHIVE-INSPECTED only, with the reason recorded`.

The release matrix's `execution:` strings were updated to those tiers **after** this run, and the release workflow's
publish job now depends on these jobs, so the tier and the evidence travel with the release. The earlier dry runs
that produced the fixes are named in the commits: `41380145859` (no binfmt registered), `41380360154` (case-sensitive
`gotavern` grep), `41380701749` (host curl against container-local loopback).

## Boundary, stated rather than implied

windows/arm64 remains **built + archive-inspected only**. No GitHub-hosted windows/arm64 runner exists; emulating a
Windows ARM64 Go binary under QEMU on Linux would be a different execution environment and is not claimed. The
`windows-arm64-boundary` job turns that sentence into a gate: it reads the matrix row and fails unless the string still
says `NOT EXECUTED` and still names the missing runner.
