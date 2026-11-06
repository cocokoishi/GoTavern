# M3b — ENOSPC vs EFBIG: the persistence path does not conflate them

**Status: evidence recorded, local validation only (the release rehearsal is running at
`main@a54db37`; this lane ran no dispatch and no CI job).** Read at
`HEAD a` on `lane/alpha16-program`. No product change: the
work is two new test files plus this document. The temporary mutations in §4 were restored
byte-identically (SHA-256 and `git diff --exit-code` recorded there).

Requirement this closes: `docs/alpha16-agent-execution-plan.md:99` — *"Include kill-before/after
rename, external writer, cross-process lock, exhausted file size via EFBIG, streaming cutoff, slow
reads/writes and cancellation. **ENOSPC remains UNPROVEN if the environment forbids a disposable
mounted filesystem; do not label EFBIG as ENOSPC.**"* The supporting contract rows are `GOAL.md:445`
("the failure path is safe: … a full disk … leave the user's data parseable and recoverable"),
`AGENTS.md:18` (rule 12, sensitive writes locked and atomic) and `AGENTS.md:525` (rule 24, bounded
waits — a permanent failure must not be retried into a stall).

---

## 1. Finding first: there is no ENOSPC/EFBIG classifier

The persistence path has **no errno classification at all**. A repository-wide search of production
Go (`internal/`, `cmd/`) for `ENOSPC`/`EFBIG`/`syscall.Errno` returns **no production reference to
either errno**; the only hits are test comments (`internal/startup/data_safety_atomic_test.go:35`)
and the e2e EFBIG gate (§5). The one predicate that exists, `fsretry.isTransient`, retries exactly
one class — a Windows sharing/lock violation (`internal/fsretry/fsretry_windows.go:17-41`); off
Windows it is documented always-false (`internal/fsretry/fsretry_other.go:4-6`).

So "are ENOSPC and EFBIG distinguished?" has a precise answer:

- **In behaviour: no branch distinguishes them — and that is safe.** Both are permanent write
  failures; neither is retried, neither is remapped, neither has a fallback. Conflation would require
  a branch/fallback that maps one onto the other, a retry that masks one as the other, or an error
  rewrite that collapses their identity. None exists (evidence in §2).
- **In error identity: yes, they remain distinguishable** through the whole atomic-write core and the
  storage wrappers (`%w`/`*os.PathError` chains), so a caller that ever needs to distinguish them can
  (`errors.Is`). The HTTP response layer deliberately flattens both to the same generic 500, which is
  the pinned shape (§2.3).

This is the honest classification of the M3 item: **not-conflated is proven; a dedicated classifier
is absent by design; a real kernel ENOSPC is still unproven by policy and is NOT relabelled as
EFBIG.** The tests below pin the properties that would have to break for conflation to appear.

---

## 2. Code-path evidence (file:line)

### 2.1 Where each errno is seen

Both arrive as the return of the same write syscall, so the product sees them at the same place:

| Step | Code | ENOSPC | EFBIG |
|---|---|---|---|
| write the temp file (the kernel write that fills the disk / crosses the file-size limit) | `internal/startup/content.go:333-336` (`atomicTempWrite` seam) called at `:374`; the error is returned unchanged at `:375-377` | `write(2)` → ENOSPC → `*os.PathError{Err: syscall.Errno(28)}` on POSIX, returned unchanged | `write(2)` → EFBIG → `*os.PathError{Err: syscall.Errno(27)}` on POSIX, returned unchanged |
| fsync the temp file | `content.go:379-382` | an ENOSPC at fsync is returned unchanged by the same `return err` | same (EFBIG cannot normally arise here, but the path is identical) |
| publish by rename | `content.go:387` → `renameIntoPlace` (`content.go:327-329`) → `os.Rename` inside `fsretry.Do` | the error reaches `fsretry.isTransient`; POSIX predicate false → returned after one attempt; Windows predicate matches only 5/32/33 → ENOSPC/Win32 112 not retried | same; one attempt |
| retry predicate | `internal/fsretry/fsretry.go:34-40` (loop), `:27` (`attempts = 20`), `:28` (`delay = 10ms`); platform predicates `fsretry_windows.go:17-41`, `fsretry_other.go:4-6` | tried once, error returned | tried once, error returned |
| read-modify-write wrapper | `internal/startup/user_content_file.go:51-68` — reads the current document, calls `atomicReplace` at `:68` and returns its error unchanged | identity intact | identity intact |
| settings wrapper | `internal/startup/settings_backup.go:92-94` — `fmt.Errorf("write settings file for %s: %w", handle, err)` | `%w` keeps `errors.Is(err, syscall.ENOSPC)` true | `%w` keeps `errors.Is(err, syscall.EFBIG)` true |

The same shapes exist for every writer that goes through the core: `atomicReplace` is the single
file-replace primitive (`internal/startup/content.go:338-396`) used by `UpdateUserContentFile`
(chat/worldinfo/preset/settings/etc.), and `WriteFileAtomic` is its exported alias
(`internal/startup/secrets_state.go:736-740`).

### 2.2 What the user sees: runtime vs boot

| Surface | Code | ENOSPC | EFBIG | Distinguishable by the user? |
|---|---|---|---|---|
| chat save 500 | `internal/server/chats.go:228-241`: the write error is mapped to a fixed JSON body `"An error has occurred, see the console logs for more information."` | same body | same body | **No** — both are the same generic 500. Pinned does the same, but logs the cause (`../SillyTavern/src/endpoints/chats.js:561-567`: `console.error(error)` then the generic 500), while `chats.go` has no log call on this path and no 5xx-logging middleware was found by grep (`consoleErrorf` call sites are access-log only). Operator-side diagnosis is therefore weaker than pinned — recorded as a residual in §6, not fixed here. |
| settings save 500 | `internal/server/settings_save.go:44` (status only) | same | same | No |
| boot failure | startup writers wrap with `%w` (e.g. `settings_backup.go:92-94`, `content.go:200-216`) and `cmd/gotavern/main.go:52` prints `gotavern: <err>`; `syscall.Errno.Error()` renders the OS text ("no space left on device" / "file too large") | OS text differs | OS text differs | **Yes**, at boot |

**No path anywhere contains an "EFBIG → ENOSPC" or "ENOSPC → EFBIG" fallback.** The product cannot
silently turn one class into the other because it never inspects either errno.

---

## 3. Named tests (test-only, no product change)

Both tests live beside the code they judge, run with `-count=1`, and are named so the M3 item is
greppable (`ENOSPC`/`EFBIG` appear in the names).

### 3.1 `TestENOSPCAndEFBIGAreNotConflatedInTheRetryPredicate`

File: `internal/fsretry/fsretry_errno_test.go`. Command:
`go test ./internal/fsretry -count=1 -run '^TestENOSPCAndEFBIGAreNotConflatedInTheRetryPredicate$' -v`
→ **PASS** (0.20 s local Windows/arm64).

Subtests and what each pins:

| Subtest | Injection | Assertion |
|---|---|---|
| `raw-disk-full` | `syscall.ENOSPC` | exactly **1** attempt; `errors.Is(err, ENOSPC)`; not `EFBIG` |
| `raw-file-too-large` | `syscall.EFBIG` | exactly **1** attempt; `errors.Is(err, EFBIG)`; not `ENOSPC` |
| `wrapped-disk-full`, `wrapped-file-too-large` | `fmt.Errorf("…: %w", errno)` (the shape of `settings_backup.go:92-94`) | identity survives `%w`; 1 attempt; no cross-match |
| `path-error-disk-full`, `path-error-file-too-large` | `&os.PathError{Op:"write", Err: errno}` (the shape the kernel produces) | identity survives `*PathError`; 1 attempt; no cross-match |
| `non-errno-error` | `errors.New("injected ordinary write failure")` | 1 attempt; sentinel preserved; **not** mapped onto either errno |
| `transient-sharing-violation-control` | `syscall.Errno(32)` (ERROR_SHARING_VIOLATION) | **positive control**: on Windows it is attempted the full bounded `attempts` (20), proving the predicate is alive and the no-retry assertions above are a measurement, not dead code; off Windows the documented always-false predicate means 1 attempt (asserted, not skipped) |
| `windows-real-disk-full-errno-vocabulary` | `syscall.Errno(112)` (ERROR_DISK_FULL) | Windows-only (declared `t.Skip` elsewhere): a **real** Windows disk-full status compares unequal to `syscall.ENOSPC` (Go's `Errno.Is` maps only ErrPermission/ErrExist/ErrNotExist/ErrUnsupported — `GOROOT/src/syscall/syscall_windows.go:189-215`), is preserved as itself, and is not retried. This is the same platform seam the repository already records for `WSAEADDRINUSE`/`WSAECONNREFUSED` (`internal/app/address_in_use_windows.go:15-35`). |

### 3.2 `TestENOSPCAndEFBIGAreNotConflatedInTheAtomicWrite`

File: `internal/startup/atomic_errno_test.go`. Command:
`go test ./internal/startup -count=1 -run '^TestENOSPCAndEFBIGAreNotConflatedInTheAtomicWrite$' -v`
→ **PASS** (0.02 s).

It injects the errno at the exact step the kernel would fail (`atomicTempWrite`,
`internal/startup/content.go:333-336`, the same seam `TestAtomicReplacePreservesTheOriginalWhenTheDiskFillsMidWrite`
uses; installed per subtest and restored by `t.Cleanup`):

| Subtest | What it proves |
|---|---|
| `raw-disk-full` / `raw-file-too-large` | `atomicReplace` returns the error (never swallows it), `errors.Is` still identifies **which** errno, the other errno does **not** match, the target stays the byte-identical previous document, and no `.gotavern-content-log-*.tmp` scratch file survives |
| `partial-write-then-disk-full` / `partial-write-then-file-too-large` | the kernel writes what fits and then fails; the product publishes neither the partial bytes nor the new body |
| `wrapped-partial-write-disk-full` / `wrapped-partial-write-file-too-large` | the same, with the `%w` wrapping the storage layer applies |
| `non-errno-error` | an ordinary error is not upgraded/remapped onto either errno (the negative control for the two errno cases) |
| `recovers-after-the-injected-failure` | after an injected ENOSPC, the same target replaces normally — the failed attempt leaves no state that could make a later failure look like the other class |

Failure messages name the injected class, so a red names the errno rather than "an error".

---

## 4. Negative controls: the mutations that kill each test

Both mutations are **temporary**: the file was copied to `%TEMP%\m3-mutation-laneb`, edited in place,
the exact test name run with `-count=1`, then restored from the byte copy and verified with SHA-256
**and** `git diff --exit-code` (empty). No product change survives. (The task forbids `git`, so the
byte-copy restore of rule 2 is used instead of a worktree; the SHA-256 equality is the proof the
restore is byte-exact.)

### 4.1 Mutation A — make EFBIG take the retry path only a transient violation may take

Mutated `internal/fsretry/fsretry.go`: the loop condition
`err != nil && isTransient(err)` became
`err != nil && (isTransient(err) || errors.Is(err, syscall.EFBIG))` (plus `errors`/`syscall`
imports). This is the conflation the control exists to catch: one permanent class gains a path the
other does not have.

- SHA-256 before: `DBE70704A811DB975CD17DF83EDC54FCCBDF92AB657C2FAC0EF32A3FA7867007`
- SHA-256 mutant: `C9058F904F5D682CD5DD2EDE94D8DF84909FF37DD0AB87945A3EE4359A105C67`
- Command: `go test ./internal/fsretry -count=1 -run '^TestENOSPCAndEFBIGAreNotConflatedInTheRetryPredicate$'`
- Verdict: **FAIL by name**, with the three EFBIG subtests red and the ENOSPC subtests green:

```
--- FAIL: TestENOSPCAndEFBIGAreNotConflatedInTheRetryPredicate (0.80s)
    --- FAIL: .../raw-file-too-large (0.20s)
        fsretry_errno_test.go:74: file too large was attempted 20 times: disk-full and file-too-large are
        permanent failures and both must be reported after exactly ONE attempt (the only retryable class is a
        Windows sharing/lock violation)
    --- FAIL: .../wrapped-file-too-large (0.20s)
    --- FAIL: .../path-error-file-too-large (0.21s)
```

- Restored SHA-256 `DBE7070…` (equal to before), `git diff --exit-code -- internal/fsretry/fsretry.go`
  exit 0, re-run: **ok** (`0.437 s`).

### 4.2 Mutation B — drop the errno identity in the atomic-write layer

Mutated `internal/startup/content.go:374-377`: the temp-write failure returned
`errors.New("injected mutation: temp write failed")` instead of the kernel error. This is the
"flattening" defect that would make ENOSPC and EFBIG indistinguishable to any caller.

- SHA-256 before: `8CDEAA85688339115F7F22A471D5D12D4BD6D45E7FC029259CF65231CCB689A9`
- SHA-256 mutant: `96DB2704FF8D032242ABB6AFEB9DD6DA2D2FEC72678CECDA91C6F6EB256FD68F`
- Command: `go test ./internal/startup -count=1 -run '^TestENOSPCAndEFBIGAreNotConflatedInTheAtomicWrite$'`
- Verdict: **FAIL by name**, every errno subtest red with the identity assertion:

```
--- FAIL: TestENOSPCAndEFBIGAreNotConflatedInTheAtomicWrite (0.02s)
    --- FAIL: .../raw-disk-full
        atomic_errno_test.go:79: the layer returned injected mutation: temp write failed, which no longer
        carries no space left on device: a caller can no longer tell disk-full from file-too-large (the
        identity must survive atomicReplace unchanged)
    --- FAIL: .../raw-file-too-large
    ... (all six errno subtests, plus non-errno-error and recovers-after-the-injected-failure)
```

- Restored SHA-256 `8CDEAA8…` (equal to before), `git diff --exit-code -- internal/startup/content.go`
  exit 0, re-run: **ok** (`0.859 s`).

Both tests therefore have demonstrated teeth in both directions: retrying one class, or flattening
the identity of either, turns the named test red.

---

## 5. Coverage matrix — what is proven, where

| Claim | Evidence | State |
|---|---|---|
| Neither ENOSPC nor EFBIG is retried; both are reported after one attempt, with identity intact, through raw/`%w`/`*PathError` forms | `TestENOSPCAndEFBIGAreNotConflatedInTheRetryPredicate` (this doc §3.1), mutation A | **proven (unit)** |
| The atomic-write layer surfaces each errno unchanged and preserves the previous document for both | `TestENOSPCAndEFBIGAreNotConflatedInTheAtomicWrite` (§3.2), mutation B | **proven (unit)** |
| A REAL kernel write failure above a file-size limit refuses the save and keeps the old document | `tests/e2e/a15_efbig_linux_test.go` `TestKernelFileSizeLimitRefusesTheSaveAndKeepsTheOldDocument` (RLIMIT_FSIZE + SIGXFSZ-ignoring launcher; Linux CI only; `a15_efbig_windows_test.go` is a declared skip naming the reason) | **proven on Linux CI; declared skip elsewhere** |
| A REAL full-filesystem ENOSPC | none — needs a privileged small mount, forbidden by the round's rules; `docs/source-audit.md:235`, `docs/audit-v0.1.0-alpha.15.md:234` keep it `unproven` | **UNPROVEN by policy — must not be relabelled** |
| The HTTP error shape does not distinguish them (generic 500 for both) | source: `internal/server/chats.go:236-240`, `internal/server/settings_save.go:44`; pinned shape `../SillyTavern/src/endpoints/chats.js:561-567` | **intentional parity (source-derived)** |
| A Windows real disk-full is ERROR_DISK_FULL(112), which is not `errors.Is`-equal to `syscall.ENOSPC`; Windows has no EFBIG write failure | `windows-real-disk-full-errno-vocabulary` subtest + `GOROOT/src/syscall/syscall_windows.go:189-215` | **recorded seam; Windows-only subtest** |

---

## 6. Residual gaps (stated, not implied)

1. **Real kernel ENOSPC remains UNPROVEN.** Reproducing it needs a privileged small mount; the
   round's rules forbid elevation and the task forbids privileged mounts. The kernel-level half of
   "full disk is safe" is proven with **EFBIG** on Linux CI (`a15_efbig_linux_test.go`), and this
   document does **not** rename that evidence into an ENOSPC claim (`plan:99`).
2. **The injected errnos cover the temp-write step only.** `os.OpenFile` of the scratch file
   (`content.go:347-361`), `Sync` (`:379-382`) and the directory `Sync` (`:391-394`) have no injection
   seams, so an ENOSPC arriving there is source-derived (the code returns `err` unchanged) rather than
   named-assertion-proven. Adding hooks would be product-code change for a test-only need; recorded,
   not done.
3. **Rename-side disk-full is source-derived too.** `renameIntoPlace` (`content.go:327-329`) runs
   `os.Rename` through `fsretry.Do`; on POSIX a rename ENOSPC/EDQUOT is non-transient and returned,
   but there is no hook to inject it. The existing "rename cannot happen" test (`data_safety_atomic_test.go:79-98`)
   covers the rename-failure atomicity, not the errno identity.
4. **Runtime HTTP users cannot tell ENOSPC from EFBIG.** Both are the pinned generic 500; that is
   intentional parity. Two operator-side observations from this audit, recorded as hypotheses rather
   than fixed: (a) the chat-save handler does not log the underlying error where pinned does
   (`chats.go:228-241` vs `../SillyTavern/src/endpoints/chats.js:561-567`), so a real disk-full on
   that route is silent in the Go console; (b) a future classifier must use the Windows status codes
   (`windows.ERROR_DISK_FULL` / `ERROR_HANDLE_DISK_FULL`), not `syscall.ENOSPC`, or it will be wrong
   on Windows — the `windows-real-disk-full-errno-vocabulary` subtest exists to refuse that mistake.
5. **Windows EFBIG is impossible, not skipped-by-laziness.** RLIMIT_FSIZE/SIGXFSZ are POSIX; the
   Windows e2e file names that reason (`a15_efbig_windows_test.go:19-22`). The unit-level EFBIG
   identity test does run on Windows (it injects the errno value), which is the only way the identity
   property can be checked there.
6. **This is local Windows/arm64 validation.** Lane CI then `main` remain the gate; no workflow was
   dispatched, per the instruction that the release rehearsal is running (13 gates + dry run at
   `main@a54db37`) — this lane kept every validation local.

---

## 7. Reproduction

```
# named tests (exact names, -count=1)
go test ./internal/fsretry  -count=1 -run '^TestENOSPCAndEFBIGAreNotConflatedInTheRetryPredicate$' -v
go test ./internal/startup  -count=1 -run '^TestENOSPCAndEFBIGAreNotConflatedInTheAtomicWrite$' -v

# whole packages (no regression)
go test ./internal/fsretry ./internal/startup -count=1
```

Result on the recorded host: both named tests PASS (0.20 s / 0.02 s); both packages PASS
(`fsretry 0.52 s`, `startup 7.63 s`). Mutation evidence: §4. New files only:
`internal/fsretry/fsretry_errno_test.go`, `internal/startup/atomic_errno_test.go`, this document.
No production file differs from `HEAD` (`git status --porcelain` lists only the two new test files
and this document; the mutated files were restored byte-identically and verified by SHA-256 and
`git diff --exit-code`).
