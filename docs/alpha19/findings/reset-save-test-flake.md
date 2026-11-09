# `TestAccountResetInterleavedWithSavesDoesNotCorruptOrCrossUserData`: flake classification

Status: **test-harness bound, not a product defect. Fixed in `internal/server/account_reset_save_race_test.go`
(retry bound 3 → 10, linear 1 ms backoff). No corruption assertion was weakened.**

## The failure

After a co-tenant CPU-heavy suite run, one subtest failed with:

```
POST /api/users/reset-step2 never completed after 3 attempts (statuses [500 500 500])
```

and (from the same storm) the recorded shape "2 save(s) answered 500 during the reset window". The 500s are not
data corruption: every data-safety assertion (final-tree JSON validity, cross-user markers, sentinels, account-store
digest, torn-file reader) still ran and passed for the seeds whose reset completed.

## Classification: a 500 during the reset window is legitimate on BOTH subjects

- Pinned `src/endpoints/users-private.js:261-305`: `router.post('/reset-step2', async …)` wraps the entire body in
  `try/catch`; the reset is `await fsPromises.rm(request.user.directories.root, {recursive: true, force: true})` and
  then `ensurePublicDirectoriesExist()` / `checkForNewContent()`. **Any throw — including a transiently locked or
  still-open path on Windows — reaches the catch and answers `response.sendStatus(500)`.** The same route's
  `reset-step1` does the same.
- GoTavern's `serveUserResetStep2` reproduces the route contract, so a 500 while writers hold the tree is the same
  observable on both sides. The test itself already expects "every save answers 200 or 500"; the reset route's 500
  is the same class.
- Therefore the test expectation was NOT wrong about the status distribution. What was too tight was the PROBE's
  bounded retry: the test's own comment says a failed removal retry is a recorded host-tolerance mechanism, but
  three 1 ms attempts can be exhausted under a loaded machine, and the probe then never exercises the reset at all.

## The fix

`probeResetAttempts` is now **10** with a linear 1 ms · attempt backoff, and the comment cites pinned
`users-private.js:261-305` as the reason a 500 is an acceptable reset status. The final attempt must still be `204`
or the test Fatals — the probe cannot pass without reaching and validating the reset — and every data-safety
assertion is unchanged.

## RED → GREEN evidence

- RED shape (Lead's run on this host, 1 fail / 3 under co-tenant CPU): statuses `[500 500 500]`, i.e. the third
  attempt exhausted the bound.
- Local GREEN run (`go test ./internal/server -run
  TestAccountResetInterleavedWithSavesDoesNotCorruptOrCrossUserData -count=1`, 36.17 s) shows the bound is actually
  exercised: `seed 2: reset A completed on attempt 2 (statuses [500 204])`, `seed 3: reset A completed on attempt 3
  (statuses [500 500 204])` — exactly the failing shape, now completing inside the bound. Log:
  `a19-diff/reset-race-test.log`.

## Why this is not "weakened to green"

The corruption checks are unchanged and still run against the completed reset; the retry is bounded and recorded,
and exhausting it is still a Fatal that names the statuses. The alternative considered and rejected: expecting the
reset never to answer 500 — that would contradict pinned's own catch-all and would turn a host-scheduling effect
into a false product requirement.
