# Verification methods: a probe must not reimplement the subject

This rule is `AGENTS.md` 58. It is here in full, with the measurement that created it, because a one-line rule is
easy to obey in the letter and break in the spirit.

## The failure

Run `40349251805` was supposed to answer "who throws inside `Generate`". The probe had wrapped the frontend's event
bus to record which listener threw:

```js
const originalEmit = events.eventSource.emit.bind(events.eventSource);
events.eventSource.emit = async function (event, ...rest) {
    const listeners = this.events?.[event];
    ...
};
```

The wrapper's `this` is not always the emitter (`script.js:8111` calls `emit` through a path where it is not), so
`this.events` was `undefined` and the wrapper threw on **every settings save**. The artefact recorded it:

```
[error] Error saving settings: TypeError: Cannot read properties of undefined (reading 'push')
    at events.eventSource.emit (eval at evaluate (:290:30), <anonymous>:2   @script.js:8111
```

Two consequences, and the second is the expensive one:

1. the question was not answered — `emitDiagnostics` was empty;
2. **the harness changed the subject.** A probe that reimplements a core method of the product is not measuring the
   product, it is measuring `product-with-my-patch`. Every leg after that point describes a page that no user runs.

## The rule

A probe may **observe** the subject. It may not **reimplement** it. Concretely, in a browser leg:

- **Allowed**: reading state the frontend already exposes (`window.SillyTavern.getContext()`, module exports,
  `element.value`, the DOM, the product's own event names), listening on a bus with the product's own subscription
  API, recording HTTP via the browser's request/response events, wrapping a function **only to call through and
  return its exact result**, with the wrapper's own behaviour proven inert first.
- **Forbidden**: replacing a module's exported function, reassigning a method on a shared object, reimplementing a
  bus's dispatch, patching `fetch`/`XMLHttpRequest` semantics, or shadowing a global the page uses. Each of these
  changes what is being measured, and the change is invisible in the verdict line.

## The gate that must come with the next wrapper

If a probe must wrap something (occasionally it must, to attribute a throw), the wrapper carries an **inertness
assertion that runs before any drive**:

1. on a blank page of the product — before any chat is opened, any message sent — assert that
   `consoleDiagnostics` contains **zero** `error`/`trace` entries that name the wrapped symbol;
2. exercise the wrapper's own path once (call the wrapped entry with a harmless argument) and assert the call
   returns the same value the unwrapped call would have;
3. only then start driving, and if step 1 or 2 fails, **the leg fails as a harness error** rather than continuing to
   record evidence about a patched page.

That is rule 7 applied to the harness itself: prove the instrument reaches the behaviour it was built for, and prove
it does so without altering it, before building anything on the result.

## What replaced the wrapper

`consoleDiagnostics` — collecting `error`, `warning` **and `trace`** in full, with `url:line` and a timestamp — needed
no patching at all, and it carried the pinned emitter's own `console.error(err)` and
`console.trace('Error in event listener')` (`public/lib/eventemitter.js:145-151`). The earlier instrument dropped
`trace` entirely (its type is `trace`, not `error`) and cut the text to 300 characters in a 12-entry ring, which is
why four runs of the same defect produced no attributable line.
