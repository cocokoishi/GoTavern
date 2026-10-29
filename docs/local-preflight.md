# Local preflight: the cheapest checks, assembled

**Purpose: catch locally what CI would otherwise catch remotely.** Every command here is
seconds-scale, runs on this host, and starts no pinned Node, no oracle, no browser, and no
remote workflow. This is **not** a new CI — it is a documented composition of checks that
already existed, so a dispatch is spent only on what is genuinely remote-only (`go test`,
`go build`, the oracle, browser evidence).

Measured on the round this file was added: three dispatches went to a single defect whose two
causes -- a missing allowlist entry and a missing leading tab -- would both have been caught by
items 3 and 4 below, in under a second each.

## The order

| # | Command | Catches | Time |
|---|---|---|---|
| 1 | `node tools/generate-doc-facts.mjs --check` | a generated block that is stale after an edit | <1 s |
| 2 | `node tools/compat-matrix/check.mjs` | a matrix citation that no longer resolves; a row/claim mismatch | <1 s |
| 3 | `node tools/check-fixture-watermarks.mjs` | a committed fixture carrying a URL, handle, or unmarked long string | ~1 s |
| 4 | **exact read-back of the edited region** (see below) | a semantically valid edit whose BYTES are wrong | <1 s |
| 5 | `git diff --check` | trailing whitespace, conflict markers, CRLF damage | <1 s |
| 6 | `git diff --cached --stat` | a file staged that was not intended | <1 s |
| 7 | targeted `go test -run` **in CI only** | Go behaviour | remote |

Items 1-6 run here. Item 7 is the only genuinely remote step, and it is one dispatch.

## Item 4 — the read-back, with the command

**This is the item that would have saved the most this round.** Two authors, one allowlist, two
defects: an entry whose reason was correct but whose line had lost its **leading tab** (so
`gofmt` refused it), and an insertion that **glued a comment onto the previous entry's line**.
Both produced a file that parses. Both failed a formatter. **A parser accepting a file is not
evidence that its bytes are right.**

Read the modified region back and assert its first bytes explicitly:

```powershell
# After editing a Go file, assert every entry line inside a literal is tab-indented (0x09).
# Adjust the line range to the region you actually touched -- do not scan the whole file and
# call it a check.
$f = "internal/fixtures/documents_test.go"; $lines = [System.IO.File]::ReadAllLines($f)
419..421 | ForEach-Object {
    $l = $lines[$_ - 1]
    if ($l.Length -gt 0 -and [int]$l[0] -ne 9) { throw "L$($_): first byte $( [int]$l[0] ), expected 9 (tab)" }
}
"read-back ok: lines 419-421 all start with 0x09"
```

```bash
# The same check in POSIX shell, for a lane that runs there.
awk 'NR>=419 && NR<=421 && length($0)>0 && substr($0,1,1)!="\t" { print "L" NR ": not tab-indented"; bad=1 } END { exit bad }' \
  internal/fixtures/documents_test.go && echo "read-back ok"
```

**What to assert, specific to the file type:**

- **Go map literal / struct literal entry** -- first byte `0x09` (tab), matching its neighbours.
- **JSON or JSONL** -- the line re-parses, **and** its delimiter and trailing-comma are exactly
  what the neighbours have; re-read the raw bytes rather than trusting `ConvertTo-Json`.
- **Generated markdown block** -- the `<!-- BEGIN GENERATED -->` / `<!-- END GENERATED -->` pair
  is intact and on its own lines.
- **Any file** -- no BOM unless intended (`0xEF 0xBB 0xBF`), trailing newline matches the file.

## The rule this encodes

> **Any positional or programmatic edit to a structured or semi-structured file MUST be followed
> by an exact local read-back of the modified region before commit -- first byte, indentation,
> delimiter, trailing character -- and semantic parser success is not sufficient.**

`tools/generate-doc-facts.mjs`'s `writeFileStrict` now enforces this for everything it writes:
it reads the file back, decodes it strictly, and throws on a byte mismatch, a BOM, or a lost
trailing newline. That is the generator's own protection; **a hand edit bypasses it entirely**,
which is why item 4 is a command a person runs and not only a function a script calls.

## What this preflight does NOT do

- No `go build`, `go test` or `gofmt` -- forbidden on this host.
- No pinned Node, no oracle, no browser harness, no workflow dispatch.
- It cannot prove Go compiles or a test passes. That stays remote, and it is the only thing
  that should ever be remote.
## Host caveat: `compat-matrix/check.mjs` fails on a CRLF working tree

**Measured on this host, `origin/main` at `a2aede7`:** `node tools/compat-matrix/check.mjs` exits
`1` with

```
docs/compatibility-matrix.md: differs from the generator output at line 1:
committed "# Compatibility matrix (generated)\r" vs generated "# Compatibility matrix (generated)"
```

**This is a host artefact, not a repository defect**, and it was verified as one rather than assumed:

- the **committed blob is CR-free** -- `git cat-file blob origin/main:docs/compatibility-matrix.md`
  has **0** lines ending in `\r`;
- the **worktree copy has 573 `\r` bytes**, so `core.autocrlf` expanded it on checkout;
- the check **fails identically on a pristine `origin/main` worktree**, so no change in this round
  caused it.

**What to do:** on a host where this fires, treat item 2 as `INCONCLUSIVE-HOST` rather than red, and
quote the CR-separated `\r` in the message as the reason. Do not "fix" it by re-recording the matrix
-- the committed bytes are already correct, and re-rendering on this host would *introduce* the CRLF
that the check is complaining about.

**The check is still worth running:** it is the only local detector of a stale or unresolved matrix
citation, and it passes on the CI host where the tree is LF.