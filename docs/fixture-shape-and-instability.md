# Host-derived and nondeterministic values in a fixture

Extracted from `AGENTS.md` verification rule 18, which had grown into a narrative. The RULE keeps its
number and its invariant in `AGENTS.md`; the stories below are what it learned from, kept here so the rule
does not have to be re-lengthened the next time one of them recurs.

## The invariant

A fixture is compared by BYTES. Anything whose value depends on the host, on timing, or on a race must be
excluded by CLASSIFYING THE SCENARIO from a host-independent property — never by comparing two values that
happened to differ on one machine. And a value excluded from one field must be excluded from every other
field that carries it, including derived ones.

## Case 1 — a `shape` field that still recorded its body

Measured on the `sd-routes` probe. A finalhandler development error page was classified `shape` for the
right reason and its body was STILL recorded, which no Windows-side check could see: recomputing all 83
observations' content-length and ETag from their own bodies gave zero mismatches locally, and only the
oracle gate found it.

Three consequences became the rule:

- classify from a property of the SCENARIO ("this body is a rendered error page"), not from a comparison
  of observations;
- record `null` for a shape field and keep the reason beside it;
- null the DERIVED fields too — content-length measures those bytes and the ETag hashes them.

`status` is never classifiable as shape: every scenario must compare its status, so a shape status would
make the comparison unfalsifiable.

## Case 2 — a race, not a host

`upscalers.notArray` and `vaes.autoFirst` each start TWO outbound requests to different endpoints before
awaiting either, so the peer records ARRIVAL order, and the probe reads the outbound log immediately after
the response. When the route answers as soon as the first request settles, the losing request has not
landed yet, and the recorded COUNT is 1 or 2 depending on timing. Measured: deterministic 5/5 on the
Windows host and non-deterministic on Linux, which is why only the CI double-run could see it.

Therefore, when a pinned route starts more than one outbound request before awaiting them: record a sorted
SET or NOTHING AT ALL — never an arrival-ordered array and never an observed count — name the race in the
shape reason, and put the assertion in a labelled source-derived test (`AGENTS.md` verification rule 4).

**Do not widen the drain window** to catch the loser. That makes the count stable by luck rather than by
contract, and the same race reappears under different timing.

## Case 3 — the unstable value also lives inside a compared field

The caption-image probe classified the pollinations `seed` as shape with a null value and was still
unstable, because the seed also appears inside the recorded REQUEST BODY: the run was green and
`stable=False` at the same time. The body now carries a `<seed>` marker, the same treatment the SD and
video seeds receive, and the normalisation is recorded.

So: after classifying an unstable value shape, SEARCH THE FIXTURE FOR THE VALUE ITSELF. If it also sits
inside a compared body, header or target, the marker must be applied there too, and the double-run check
is what catches the omission.

One argued exception: a value that is CLIENT-derived and byte-stable (`requestHeaders.connection`, for
example) stays recorded with its reason. Nulling it would discard information with no host-dependence
justification to justify it.

## Case 4 — the sweep, and the phantom it produces

After any such change, sweep every fixture for host-specific strings: `C:\`, `AppData`, `/home/`, `/tmp/`,
`/root/`, `/Users/`. The sweep is cheap, it is the only check that finds this class, and it found exactly
one location across 100 fixtures.

**Run the sweep CASE-SENSITIVELY.** A case-insensitive `/Users/` matches the legitimate
`GET /api/users/me` path and reports a host path that is not there — which is how a sweep turns into a
phantom defect and someone sets out to fix a fixture that is already correct.
