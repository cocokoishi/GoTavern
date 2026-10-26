// THE HOP'S OWN BEHAVIOUR, CHECKED IN SECONDS INSTEAD OF TWENTY MINUTES.
//
// WHY THIS EXISTS. A head-of-body cut is supposed to leave the page with a RESPONSE and no body. Runs of the
// browser differential reported a cut that had happened (`cutsPerformed: 1`) while 21 or 169 bytes had still
// reached the page, and each was diagnosed from a leg file after an eighteen-minute dispatch. The cause was
// not the cut: `releasedBytes` is a hop-WIDE cumulative count, and the reachability check's small JSON body
// -- relayed WHOLE before the completion, as designed -- was read as "the body had started". This test drives
// the REAL hop against a REAL SSE peer and asserts the number the abort surface is actually about:
// `releasedAtCut`, this RESPONSE's body.
//
// It also asserts the two things that make a head cut meaningful: the completion got a 200 with ZERO body
// bytes, and the reachability check was relayed whole. A hop that cut EVERYTHING would pass the first and
// fail the second, which is the guard an earlier run was missing.
//
// Run: node tests/browser/streaming-framing-hop-selftest.mjs
import http from 'node:http';
import process from 'node:process';
import { HOP_MODES, startStreamingHop } from './streaming-framing.mjs';

const frame = text => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`;

const run = async (mode) => {
    const peer = http.createServer((request, response) => {
        if (request.url.includes('/models')) {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ data: [{ id: 'm' }] }));
            return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        let index = 0;
        const timer = setInterval(() => {
            if (index >= 14) {
                clearInterval(timer);
                response.write('data: [DONE]\n\n');
                response.end();
                return;
            }
            response.write(frame(`word${index}`));
            index += 1;
        }, 15);
        response.on('close', () => clearInterval(timer));
    });
    await new Promise(resolve => peer.listen(0, '127.0.0.1', resolve));
    const hop = await startStreamingHop({
        upstream: { host: '127.0.0.1', port: peer.address().port },
        mode,
        cutAfterBytes: 444,
        cutArmOnPath: '/chat/completions',
    });
    const call = (method, path) => new Promise(resolve => {
        const request = http.request({
            host: '127.0.0.1', port: hop.port, path, method,
            headers: method === 'POST' ? { 'content-type': 'application/json', 'content-length': '2' } : {},
        }, response => {
            let bytes = 0;
            response.on('data', chunk => { bytes += chunk.length; });
            response.on('close', () => resolve({ status: response.statusCode, bytes }));
            response.on('error', () => resolve({ status: response.statusCode, bytes }));
        });
        request.on('error', () => resolve({ error: true }));
        request.end(method === 'POST' ? '{}' : undefined);
    });
    const reach = await call('GET', '/models');
    const completion = await call('POST', '/chat/completions');
    await hop.close();
    await new Promise(resolve => peer.close(resolve));
    return { reach, completion, state: hop.state };
};

const cases = [];
const addCase = (description, check) => cases.push({ description, check });

addCase('a head cut gives the page a 200 and ZERO body bytes', async () => {
    const { completion, state } = await run(HOP_MODES.CUT_AT_HEAD);
    if (completion.status !== 200) throw new Error(`status ${completion.status}; a head cut must still deliver the status line`);
    if (completion.bytes !== 0) throw new Error(`${completion.bytes} body byte(s) reached the page; a head cut relays none`);
    if (state.releasedAtCut !== 0) throw new Error(`releasedAtCut is ${state.releasedAtCut}; this response's body was not empty`);
    if (state.anyCut !== 'cut-at-head' || state.cutsPerformed !== 1) throw new Error(`cut record is ${JSON.stringify({ anyCut: state.anyCut, cutsPerformed: state.cutsPerformed })}`);
});

// THE HONEST LIMIT OF THIS CASE, measured by mutating headOnlyCut to drop its pathMatches term: the
// drive then HANGS (the subject retries its reachability check against a hop that kills every response)
// rather than failing fast, so the assertion below is reached only through the FIXTURE case further down --
// the one that reads state.relayedWholeResponses and state.cutArmedResponses from a real pair of calls.
addCase('a head cut relays the reachability check WHOLE (a hop that cut everything would fail this)', async () => {
    const { reach, state } = await run(HOP_MODES.CUT_AT_HEAD);
    if (reach.status !== 200) throw new Error(`the reachability check answered ${reach.status}; the subject could never connect`);
    if (reach.bytes <= 0) throw new Error('the reachability check body was empty, so it was not relayed whole');
    if ((state.relayedWholeResponses ?? 0) < 1) throw new Error('the hop did not record a whole-response relay');
    if ((state.cutArmedResponses ?? 0) !== 1) throw new Error(`cutArmedResponses is ${state.cutArmedResponses}; exactly the completion must be armed`);
});

addCase('the released counter is PER RESPONSE, not a hop-wide total (the defect that cost three runs)', async () => {
    const { state } = await run(HOP_MODES.CUT_AT_HEAD);
    // The reachability body is relayed whole, so the hop-wide total is NON-ZERO while this response released
    // nothing. A guard reading the total would call this "the body had started".
    if (!(state.releasedBytes > 0)) throw new Error('the hop-wide total is 0, so this test cannot distinguish the two counters');
    if (state.releasedAtCut !== 0) throw new Error(`releasedAtCut is ${state.releasedAtCut}; the two counters were not separated`);
});

addCase('pass-through relays every frame and records no cut', async () => {
    const { completion, state } = await run(HOP_MODES.PASS_THROUGH);
    if (completion.status !== 200) throw new Error(`status ${completion.status}`);
    if (!(completion.bytes > 0)) throw new Error('pass-through delivered no body');
    if (state.anyCut !== null || state.cutsPerformed !== 0) throw new Error(`pass-through recorded a cut: ${JSON.stringify({ anyCut: state.anyCut, cutsPerformed: state.cutsPerformed })}`);
});

let failures = 0;
for (const testCase of cases) {
    try {
        await testCase.check();
        console.log(`ok    ${testCase.description}`);
    } catch (error) {
        failures += 1;
        console.error(`FAIL  ${testCase.description}: ${String(error.message ?? error)}`);
    }
}
if (failures > 0) {
    console.error(`${failures} of ${cases.length} hop checks are wrong`);
    process.exit(1);
}
console.log(`${cases.length} checks: the head cut delivers a status line and no body, the reachability check stays whole, and the two released counters are separate`);
