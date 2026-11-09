# alpha.19 real-UI oracle evidence contract

This is the contract the new CI gate and the local differential must satisfy. It exists so that a green
artifact cannot be a name without content, and so that a later reader can tell **what was compared** from
the artifact alone.

## 1. Artifact

- Fixed name: `a19-real-ui-oracle-evidence` (JSON, uploaded by the new workflow).
- The artifact must belong to the cited run/attempt (freshness), and its bytes must have an Actions
  `sha256:<64hex>` digest recorded by the verifier.
- The artifact is produced only by the real journey, never hand-written.

## 2. Required members

```jsonc
{
  "schema": "a19-real-ui-oracle-v1",
  "kind": "real-ui-oracle",
  "headSha": "<40-hex candidate SHA>",
  "pinnedCommit": "06bde939fb1e9c4c8d8641d810f0a916b5bce127",
  "selection": { "mode": "all", "corpusTier": "...", "dispatch": "workflow_dispatch" },
  "corpus": { "manifestSha256": "<64-hex>", "files": 0, "bytes": 0, "origin": "ui" },
  "layers": {
    "browser":     { "verdict": "match|mismatch|not-observed|pinned-unreachable|harness-error|candidate-error|nondeterministic-oracle", "guards": [] },
    "http":        { "verdict": "...", "guards": [] },
    "providerWire":{ "verdict": "...", "guards": [], "requests": 0 },
    "persistence": { "verdict": "...", "guards": [] },
    "lifecycle":   { "verdict": "...", "guards": [] }
  },
  "normalisations": [],
  "notCompared": [],
  "startedAt": "<ISO-8601>",
  "finishedAt": "<ISO-8601>"
}
```

- `headSha` must equal the candidate the release tag points at.
- `pinnedCommit` must equal the baseline above; a different pin is a different oracle and must be refused.
- `corpus.origin` must be `ui`; a corpus built by a generator must be refused by the gate.
- Every verdict is the taxonomy in `AGENTS.md` differential doctrine 5. `not-observed` and
  `pinned-unreachable` are **not** passes; they must appear in `notCompared` with a reason.
- `normalisations` must be empty unless each entry names its reason, pinned evidence, field path, test and
  negative case (user prompt §3.3).
- `guards` are named assertions; the artifact is invalid if a required guard is missing, and the comparator
  must have a self-test that proves a mutated input turns a named guard red.

## 3. Gate behaviour

- The verifier (`scripts/verify-release-gates.mjs`) is extended for this gate with `requiredEvent:
  workflow_dispatch`, `requiredJobs: [real-ui-oracle]`, `requiredSelection.titleIncludes: ["mode=all"]`,
  `requiredArtifact`, and `requiredEvidence` naming the members above (including `headSha` and
  `pinnedCommit`).
- A narrowed dispatch (small corpus, one layer, one leg) is refused by the title rail and by the artifact's
  `selection` member.
- A skipped required job is refused even when the workflow run reports success.
- The gate cannot be satisfied by a push run.

## 4. What the gate does NOT prove

- It does not prove a real human's private long-lived directory (that is `GOAL.md` §14(1)'s stronger form).
  The corpus is built by the agent through the unmodified UI; its origin (`ui`) is recorded, not hidden.
- It does not prove every provider, every extension or every platform; those stay in the compatibility
  matrix with their own evidence and exclusions.
- It does not prove performance. A separate performance gate owns that.
