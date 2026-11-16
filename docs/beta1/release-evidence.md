# v0.1.0-beta.1 — published-release evidence

All statements below were measured against the **published** release, not a local build. Every run is cited as
workflow name + run id + conclusion, because a bare run id can belong to a different workflow that judged
something else.

## 1. Release identity (GitHub API)

| field | value |
|---|---|
| tag | `v0.1.0-beta.1` |
| title | `GoTavern v0.1.0-beta.1` |
| URL | https://github.com/cocokoishi/GoTavern/releases/tag/v0.1.0-beta.1 |
| `isPrerelease` | **true** (the channel the classifier requires for a beta-series tag) |
| `isDraft` | false |
| `targetCommitish` | `main` |
| tag target commit | `d97c4d3` |
| tag object | annotated `3fefdf3`, tagger `cocokoishi`, peeled to the candidate |
| published at | 2026-11-16T10:21:45Z |
| assets | 7: `checksums.txt` + the six canonical archives |
| body | curated `docs/release-notes-v0.1.0-beta.1.md` (7,833 bytes) **plus** the generated
  `## Qualification evidence (same-SHA required gates)` table appended by the publish step |

Publishing run: **`GoTavern Release`** [43847782239](https://github.com/cocokoishi/GoTavern/actions/runs/43847782239),
`push` at the tag, conclusion **success**, with every job success:
`build` (6/6 matrix rows), `execute-linux-arm64`, `execute-darwin-amd64`, `darwin-arm64-recorded-downgrade`,
`windows-arm64-boundary`, `prepublish-qualification`, `publish`, `post-release-facts`.

The publish job re-ran `scripts/verify-release-gates.mjs` at the tag target immediately before
`gh release create`; the body's evidence table cites the same fourteen run ids that
[`same-sha-evidence.md`](same-sha-evidence.md) records.

## 2. Channel direction

The beta is a **prerelease**, and both directions were asserted against the live service:

| assertion | evidence |
|---|---|
| `releases/latest` still serves the stable `v0.1.0-alpha.20` | `gh api repos/cocokoishi/GoTavern/releases/latest` → `tag_name=v0.1.0-alpha.20`, `prerelease=false` |
| the beta is NOT what `releases/latest` serves | `GoTavern published-release install smoke` [43848356990](https://github.com/cocokoishi/GoTavern/actions/runs/43848356990) success: `ok: the prerelease is NOT what releases/latest serves`; `ok: latest serves a DIFFERENT release than the prerelease v0.1.0-beta.1` |
| a BARE installer installs the stable release, not the beta | same run, job `smoke-published-linux-amd64`: `ok: bare install.sh resolved releases/latest to the STABLE v0.1.0-alpha.20 while the smoke target was v0.1.0-beta.1` |
| the version-pinned installer installs the beta over real TLS | same run, job `smoke-published-windows-amd64`: `ok: install.ps1 installed v0.1.0-beta.1 from the published release in 3.2 s` |
| Docker `:latest` did not move, the beta's own image tag did | `GoTavern Docker image` [43847782336](https://github.com/cocokoishi/GoTavern/actions/runs/43847782336) `push` success; package versions show a new entry `tags=[v0.1.0-beta.1]` with **no** `latest`, and the pre-existing entry `tags=[v0.1.0-alpha.20, latest]` (`created_at 2026-11-10T09:13:44Z`) unchanged |

## 3. Published bytes

Downloaded from the release, in a clean scratch directory, and checked against `checksums.txt`:

- `gotavern-windows-amd64.zip` — sha256 recomputed and equal to the published entry
  (`85c3d34085e9c1eef0766a7164caa471cd2fa909531cf595a2c29026f4d190c3`); the other five archives' digests were
  recomputed by the smoke run in CI (`ok: <archive> <digest>` for all six).
- unpacked `gotavern.exe version`:
  `GoTavern v0.1.0-beta.1` / `SillyTavern baseline 1.19.0 (06bde939fb1e9c4c8d8641d810f0a916b5bce127)`.
- unpacked `gotavern.exe assets verify`: exit 0, `verified upstream/public`, `verified upstream/default`,
  `verified upstream/generated`, `verified installed tokenizers (<unpacked>\src\tokenizers)`.
- `BUILD-INFO.txt` first line: `GoTavern release v0.1.0-beta.1`.
- the smoke run additionally asserted the archive contract inside every published archive
  (`ok: <archive> listing carries both launcher/binary payloads, the notices and src/tokenizers/`), that
  `src/tokenizers` in both the linux and windows archives is byte-identical to `upstream/tokenizers` at the tag,
  and that the installed tokenizer routes load **real** models rather than the guesstimate fallback
  (`ok: three models across two engines returned real ids from the installed src/tokenizers tree`).

## 4. Post-release state

- `post-release-facts` (inside the publishing run, success) regenerated the generated facts on `main` and pushed
  commit **`53c7a6e`** (`chore(docs): regenerate the generated facts for the published v0.1.0-beta.1 tag`), then
  dispatched the full-sweep CI run **`GoTavern CI` 43848184614** (`probes=full`) at that commit.
- Historical tags were not moved: `v0.1.0-alpha.20` still peels to `260b790`,
  `v0.1.0-alpha.19` still peels to `bbc5615`. No force push was used.
- The required same-SHA sweep at the candidate was not re-run after the tag; the evidence for the published
  commit is the wave recorded in [`same-sha-evidence.md`](same-sha-evidence.md), and the tag target is that
  exact commit.

## 5. What this release does NOT prove

- **`GOAL.md` §14 remains NOT MET** and the private-channel disposition is `PRIVATE_NOT_RUN`. The release is
  qualified on synthetic/agent-generated corpora only.
- **darwin/arm64 is NOT runtime-qualified** (built and archive-inspected only; the arm64 macOS runner
  configuration is a recorded platform limitation), and **windows/arm64 is build-only**.
- The install verification in [`install-verification.md`](install-verification.md) is **Layer A local evidence**
  from a Windows/arm64 host; the Linux/macOS drop-in recipe was not executed there. The packaged-install claims
  above come from the CI gates, not from that host.
- A Beta closes no `PARTIAL` capability row; the disclosed differences inherited from alpha.20 (no Brotli
  decoder, no `_cache/characters` read/write cache, `dominantColor` ±1 on 7 of 24 JPEGs, the missing
  `console.error` backup diagnostic) are unchanged.
- The unified release-evidence document generated by the publish job (machine JSON + Markdown, uploaded as the
  `release-evidence-contract` artifact of run `43847782239`) is not committed here; this page records the facts
  it carries, and `docs/release-manifest.json` plus `scripts/verify-release-gates.mjs` are the policy and the
  program that produced them.
