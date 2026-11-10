# alpha.20 oracle-lane decision records (B)

Decisions taken by the Lead during alpha.20 on the M1 disclosed gaps, with the measured evidence that
constrains them. A decision is reversible only through a new entry.

| id | date | decision | measured basis | status |
|---|---|---|---|---|
| B-D1 | 2026-11-09 | **Brotli: keep the exact disclosed difference.** GoTavern keeps serving gzip/deflate from the standard library and does not produce Brotli; no new pure-Go dependency is added in this round. Product code is not changed. | [`encoding-negotiation/evidence.json`](encoding-negotiation/evidence.json): a browser-like `Accept-Encoding` gets `br` from pinned and `gzip` from GoTavern; the decoded representations are byte-identical on all 7 probed resources, so the difference is codec-only. Cost for a br-capable client: **+6,647 B (+5.62%) on `/script.js`** (pinned br 118,271 B vs Go gzip 124,918 B); 14–45 B on the measured small assets. A br-only client receives identity 497,669 B from GoTavern because GoTavern must not advertise an encoding it cannot decode. The 1,024-byte threshold is bracketed by the 1,023 B (identity on both) and 1,029 B (compressed on both) pair. | decided |
| B-D1r | 2026-11-09 | **B-D1 rationale, in the Lead's words:** "cost (new dep + outbound decoder + binary size) outranks benefit for a codec-only difference whose decoded bytes are identical". | The dependency would also have to be carried by the outbound provider transport and the CORS proxy before either may advertise `br` upstream; today `internal/server/cors_proxy.go` has a named refusal + retry path for an upstream that sends br anyway, and the provider transport advertises only what it decodes. | decided |
| B-D2 | 2026-11-09 | **`_cache/characters`: keep verify-only parity; do NOT implement the read/write cache.** The startup verify pass (including the pinned misaddressed-key quirk) is reproduced; the node-persist record layer is not. | (i) it is a derived cache with no user bytes in it (every record's value is the card text the card file already contains — [`character-cache/evidence.json`](character-cache/evidence.json) C2 verifies `valueSha256 === response json_data sha256`); (ii) the measured cold-start cost is the verify pass itself — the Lead's C profile measured `VerifyCharacterDiskCache` at 31.4% of a cold 10k-card boot — not a card parse that a cache read would remove; (iii) a second persistent store is the "invented DB/format" the product contract forbids. | decided |
| B-D2r | 2026-11-09 | **No disagreement from the probe data.** The probe measured what the cache is and does, and nothing in it shows a user-visible behaviour that verify-only parity would miss: reads/writes are an optimisation (C13: a broken cache path cannot break a read), corrupt records are forgiven (C8/C9), and the only surprising behaviour is the startup verify quirk (C12) which Go already reproduces. | `character-cache/evidence.json` rows C1–C16. | accepted |

## What the decision records do NOT claim

- B-D1 does not claim GoTavern's gzip output equals pinned's gzip output byte-for-byte (it does not: pinned
  gzip 120,104 B vs Go gzip 124,918 B on `/script.js`); the claim is the decoded representation identity and
  the measured bandwidth delta, which is the observable a user can experience.
- B-D2 does not claim the cache layer is absent from the ROUTE surface: the directory is created, the verify
  pass runs, and a broken cache path cannot break reads. It claims the node-persist read/write record layer
  is not implemented, for the three reasons above.
- The 31.4% figure is the Lead's C profile measurement, quoted as such; this lane's own probe did not
  profile startup.
