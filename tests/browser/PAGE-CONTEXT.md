# Running code inside the page: what a probe may read, and where its code executes

Three defects in one lane (`q21-data-handback.mjs`) came from the same blind spot: code that looked like it was
observing the page was not, or was running somewhere else. Each cost a full CI round and each failed with a message
that pointed at the probe rather than the product.

## 1. A `page.evaluate` body runs in the BROWSER

The body is serialised and executed in the page. It has `window`, `document` and the page's global scope. It does NOT
have `process`, `fs`, `path`, `__dirname` or any Node module.

Measured (`Browser differential` 40420195059): both legs died with

    page.evaluate: ReferenceError: process is not defined

because a timeout bound was read from `process.env` INSIDE the evaluated function. Compute anything host-side first and
pass it as an ARGUMENT -- `page.evaluate(async limitMs => { ... }, limitMs)` -- and remember that arguments must be
serialisable.

## 2. `import('./script.js')` inside an evaluate is NOT the page's module

The frontend is an ES-module graph that the page itself loaded. A dynamic `import()` from an evaluate creates its OWN
instance: the code runs, but state it exposes is a fresh copy, not the page's. Measured (`Browser differential`
40415343371 and 40417587738): `characters` read through such an import was `[]` with `rosterCount: 0` while the page's
own character list rendered normally, so a name lookup failed identically on both subjects and looked like a driver
mismatch.

Use it to CALL a function the page also has (`script.changeMainAPI('openai')`), and treat anything it RETURNS about
state as suspect unless the same value is cross-checked against the DOM.

## 3. Read state from what the user sees: the DOM

`#rm_print_characters_block .character_select` (script.js:945) is the card a fresh install renders; its `data-chid` is
the character's identity. Wait for the ELEMENT, click it, and wait on the product's own state (`script.chat.length > 0`)
-- the shape `q20-persistence-probe.mjs:440-472` uses, which is proven rather than assumed.

## 4. Wait on the quantity the assertion reads, not on a signal that precedes it

Five separate failures in this repository's history share the shape: wait for `preloader` to vanish, then read the
character roster; wait for `settingsReady`, then read a settings value; wait for a listener to install, then read the
event count. The signal and the quantity are different things. Wait on the quantity, bounded, and RECORD it in the
artefact so a later failure is a field (`rosterCount: 0`) rather than an investigation.

## 5. A guard must not pass because nothing happened

`noDataLossOnHandBack` was green in run 40412270626 while pinned had opened no chat at all: "no file changed" is
trivially true for a session that never started. Any guard whose subject is an ABSENCE needs a positive precondition
first, and that precondition must appear in the same verdict line.