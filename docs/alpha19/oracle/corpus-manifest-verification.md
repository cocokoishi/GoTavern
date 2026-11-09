# Corpus manifest verification (smoke tier, Lead-independent)

**Input:** `C:\Users\koishi\Desktop\GoTavern\a19-oracle\manifests\smoke-manifest.json` (Subagent A's smoke-round
finalizer output; the smoke round is **not** the alpha.19 corpus and is labelled as such).

| field | value |
|---|---|
| schema | `a19-corpus-manifest-v1` |
| corpus.origin / tier | `ui` / `full` |
| files | 224 |
| bytes | 30,283,506 |
| treeSha256 (declared) | `64583edfe760cf6c3ae1c6b77c33728d179adfa5114f39b356f584c05a8ba11e` |
| inventory entries | 224 |
| absolute paths in inventory | 0 |

## What was checked, and how

1. **Tree digest recomputation.** SHA-256 over the UTF-8 bytes of the inventory lines `"<sha256>  <path>"`,
   sorted by path with **ordinal / UTF-16 code-unit order** (JavaScript's default `sort`), joined with `\n`,
   no trailing newline. Recomputed value equals the declared `treeSha256` (`MATCH`).
2. **Counts.** The inventory's `bytes` sum equals the declared `bytes` and the inventory length equals
   `files` (224 / 30,283,506), both exact.
3. **Content spot-check.** The first 30 inventory entries were re-hashed from the data root with
   `Get-FileHash -Algorithm SHA256`: 30/30 matched, 0 missing.
4. **Path hygiene.** Every inventory path is relative and POSIX-shaped; none is absolute or drive-qualified.

## Hazard recorded (this is why the verification method is written down)

Recomputing the digest in PowerShell with `Sort-Object path` produced a **false mismatch**
(`bccf31db…`), because `Sort-Object` is culture-aware while the manifest's sort is ordinal. A verifier that
recomputes with the wrong collation would report a corrupt corpus that is in fact correct. The algorithm
above is the contract; `a19-corpus-finalize.mjs` (producer) and `a19-live-oracle.mjs` (re-walker) both use
JavaScript's ordinal sort, and the final corpus verification will re-hash **every** inventory entry, not a
sample.

## Scope / what this does not prove

- It does not prove the smoke corpus is the alpha.19 Node-UI-Originated Corpus (it is one card, one lorebook,
  7 messages; the corpus counts are not the deliverable).
- It does not prove the counts are "created by the UI": the smoke manifest's `presets: 93` and `themes: 5`
  are mostly the pinned server's **seeded defaults** in a fresh data root. Subagent A has been asked to emit
  created-vs-seeded counts separately for the final corpus, and this file will be replaced by the full
  verification when that corpus lands.
- It does not prove the producer is correct for every tree shape; a full re-hash of the final corpus is the
  check that does.
