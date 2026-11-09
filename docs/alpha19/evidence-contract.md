# alpha.19 real-UI oracle evidence contract

This is the contract the new CI gate and the local differential must satisfy. It exists so that a green
artifact cannot be a name without content, and so that a later reader can tell **what was compared** from
the artifact alone.

## 1. Artifact

- Fixed name: `a19-real-ui-oracle-evidence` (JSON, uploaded by the new workflow).
- The artifact MUST carry the canonical release-evidence member at its root: `release-evidence.json`
  (`scripts/release-governance/artifact-evidence.mjs`'s `EVIDENCE_MEMBER`). The release verifier looks for
  exactly that member, so a differently named document inside the archive is a refusal, not a pass.
- The artifact must belong to the cited run/attempt (freshness), and its bytes must have an Actions
  `sha256:<64hex>` digest recorded by the verifier.
- The artifact is produced only by the real journey, never hand-written.
- Leg-level artifacts (browser traces, per-layer JSON, wire captures) may sit beside it inside the same
  archive; only `release-evidence.json` is parsed by the release rail, and the deeper contract is enforced by
  `scripts/verify-a19-evidence.mjs`.

## 2. Required members

```jsonc
{
  "schemaVersion": 1,
  "kind": "a19-real-ui-oracle-v1",
  "headSha": "<40-hex candidate SHA>",
  "pinnedCommit": "06bde939fb1e9c4c8d8641d810f0a916b5bce127",
  "ok": true,
  "selection": { "mode": "all", "dispatch": "workflow_dispatch", "corpusTier": "full" },
  "corpus": { "origin": "ui", "manifestSha256": "<64-hex>", "files": 0, "bytes": 0 },
  "layers": {
    "browser":      { "ok": true, "verdict": "match", "guards": [] },
    "http":         { "ok": true, "verdict": "match", "guards": [] },
    "providerWire": { "ok": true, "verdict": "match", "guards": [], "requests": 0 },
    "persistence":  { "ok": true, "verdict": "match", "guards": [] },
    "lifecycle":    { "ok": true, "verdict": "match", "guards": [] }
  },
  "normalisations": [],
  "notCompared": [],
  "startedAt": "<ISO-8601>",
  "finishedAt": "<ISO-8601>"
}
```

- `schemaVersion` is the release-evidence schema version (`scripts/release-governance/artifact-evidence.mjs`
  requires exactly `1`), and `kind` is this gate's document type.
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
- The exact manifest entry this round will apply (a policy change, committed separately with its reason):

```jsonc
{
  "workflow": "GoTavern real-UI oracle differential",
  "why": "a corpus produced by real headless-browser user actions against the unmodified pinned UI is replayed on both subjects and compared on five observable layers; the full selection is the only one that may satisfy a release gate",
  "requiredEvent": "workflow_dispatch",
  "requiredJobs": ["real-ui-oracle"],
  "requiredSelection": {
    "titleIncludes": ["mode=all"],
    "evidence": [
      { "path": "selection.mode", "equals": "all" },
      { "path": "corpus.origin", "equals": "ui" }
    ]
  },
  "requiredArtifact": "a19-real-ui-oracle-evidence",
  "requireArtifactDigest": true,
  "requiredArtifactFresh": true,
  "requiredEvidence": {
    "kind": "a19-real-ui-oracle-v1",
    "pinnedShaField": "pinnedCommit",
    "requireFields": ["corpus.manifestSha256", "selection.corpusTier", "startedAt", "finishedAt"],
    "requireTruthy": ["ok", "layers.browser.ok", "layers.http.ok", "layers.providerWire.ok", "layers.persistence.ok", "layers.lifecycle.ok"],
    "requireSha256": ["corpus.manifestSha256"]
  },
  "requiredPinnedSha": "06bde939fb1e9c4c8d8641d810f0a916b5bce127"
}
```

- A narrowed dispatch (small corpus, one layer, one leg) is refused by the title rail, by
  `selection.mode` in the artifact, and by `corpus.origin` (a generator corpus cannot satisfy it).
- A skipped required job is refused even when the workflow run reports success.
- The gate cannot be satisfied by a push run.
- Deeper contract checks that the generic release rail cannot express are executed by
  `scripts/verify-a19-evidence.mjs` (five named layers all `match`, `ok === true`, normalisations carry all
  five required members, `notCompared` rows name surface and reason, selection is `all` +
  `workflow_dispatch`). Its own teeth are `node scripts/verify-a19-evidence.mjs --self-test`: one valid
  baseline plus 13 mutations, each of which must produce its named problem.

## 4. What the gate does NOT prove

- It does not prove a real human's private long-lived directory (that is `GOAL.md` §14(1)'s stronger form).
  The corpus is built by the agent through the unmodified UI; its origin (`ui`) is recorded, not hidden.
- It does not prove every provider, every extension or every platform; those stay in the compatibility
  matrix with their own evidence and exclusions.
- It does not prove performance. A separate performance gate owns that.
