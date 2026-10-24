// PER-SOURCE CHECKS THAT THE GENERIC INVARIANTS CANNOT EXPRESS.
//
// The catalogue names these (`hooks: ['ai21-request-framing']`) and the verifier runs exactly the ones
// a source declares. The bar for adding one: the check must depend on that source's WIRE SHAPE in a way
// no generic rule can reach. Everything else belongs in invariants.mjs, enforced once for every source --
// the old verifier was 1200 lines because each source had its own copy of the same five assertions.
//
// Hooks receive (ctx, artifact, source) where ctx is the verifier's finding collector:
//   ctx.fail(message)     a finding; the run exits 1
//   ctx.observe(message)  a fact the run prints, so a reader can tell a passing check from an unopened file

/** AI21's request FRAMING: header names, computed content-length, and no credential in the artefact. */
const ai21RequestFraming = (ctx, artifact) => {
    const framing = artifact.requestFraming ?? {};
    for (const leg of ['gotavern', 'pinned']) {
        const entry = framing[leg];
        if (!entry || !Array.isArray(entry.headerNames) || entry.headerNames.length === 0) {
            ctx.fail(`requestFraming.${leg} is missing or names no header, so the request FRAMING was not recorded`);
            continue;
        }
        if (entry.authorizationPresent !== true) {
            ctx.fail(`requestFraming.${leg} does not record that authorization reached the peer, but ai21 sends its key as a bearer header`);
        }
        if (entry.contentLengthMatchesBody !== true) {
            ctx.fail(`requestFraming.${leg} records content-length ${JSON.stringify(entry.receivedContentLength)} for a ${JSON.stringify(entry.bodyLength)}-byte body, so node-fetch's computed framing is not what arrived`);
        }
        // node-fetch adds these; a leg missing one is a framing difference a body-only diff cannot see.
        for (const expected of ['accept', 'content-type', 'authorization', 'accept-encoding', 'user-agent', 'content-length']) {
            if (!entry.headerNames.includes(expected)) {
                ctx.fail(`requestFraming.${leg} does not carry ${JSON.stringify(expected)}; the pinned framing is the three headers ai21 names plus node-fetch's defaults plus a computed content-length`);
            }
        }
    }
    const left = framing.gotavern;
    const right = framing.pinned;
    if (left && right) {
        // RECOMPUTED, not trusted: the recorded flag next to a changed header list is exactly the
        // failure this hook exists to catch, so the flag must agree with the data it summarises.
        const recomputed = JSON.stringify(left.headerNames) === JSON.stringify(right.headerNames)
            && String(left.receivedContentLength) === String(right.receivedContentLength);
        if (artifact.requestFramingEqual !== recomputed) {
            ctx.fail(`requestFramingEqual is ${JSON.stringify(artifact.requestFramingEqual)} but the two legs recompute to ${JSON.stringify(recomputed)} -- the recorded flag disagrees with the recorded framing`);
        }
        if (!recomputed) {
            ctx.fail(`the two legs were framed differently: ${JSON.stringify(left.headerNames)} / cl ${JSON.stringify(left.receivedContentLength)} against ${JSON.stringify(right.headerNames)} / cl ${JSON.stringify(right.receivedContentLength)}`);
        }
        ctx.observe(`framing equal over ${left.headerNames.length} header names, content-length ${left.receivedContentLength} matching the body on both legs`);
    }
    if (typeof artifact.framingNote !== 'string' || !artifact.framingNote.includes('content-length')) {
        ctx.fail('framingNote is missing or does not name the computed content-length, so a reader cannot tell what the framing comparison covered');
    }
    // THE CREDENTIAL MUST NOT BE IN THE ARTEFACT. A recorded Authorization value would be a leaked key in
    // a committed file, so the hook refuses one rather than trusting the recorder not to write it.
    if (/Bearer\s/i.test(JSON.stringify(artifact))) {
        ctx.fail('records an Authorization VALUE (Bearer ...); the framing records header NAMES and a boolean, never a credential');
    }
};

export const SOURCE_HOOKS = {
    'ai21-request-framing': ai21RequestFraming,
};
