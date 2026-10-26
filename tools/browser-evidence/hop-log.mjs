// THE HOP LOG: what a cut actually measured, on the job log, while it is failing.
//
// WHY THIS EXISTS. The uploaded artefact is not downloadable until a run ENDS, and on this lane the run takes
// about twenty minutes, so a reader deciding what a cut measured had to wait for a failing run to finish and
// then download a 40 MB bundle. Three of this lane's runs were diagnosed that way. This script reads the leg
// files the recording step already wrote and prints ONE line per leg with the numbers that decide the
// question: which mode ran, whether the cut happened, how many bytes it released, whether the hop armed the
// cut on the completion and relayed the reachability check whole, whether the SSE body was re-framed, how many
// content states the page reached, and whether the peer recorded a disconnect.
//
// It never fails the step it runs in: a diagnostic that can turn a red into a different red is worse than no
// diagnostic. A leg it cannot read is reported BY NAME.
//
// Usage: node tools/browser-evidence/hop-log.mjs <leg.json> [<leg.json> ...]
import { readFileSync } from 'node:fs';
import process from 'node:process';
import path from 'node:path';

const summarize = file => {
    const report = JSON.parse(readFileSync(file, 'utf8'));
    const hop = report.networkHop ?? {};
    return {
        leg: path.basename(file),
        mode: hop.mode ?? null,
        cut: hop.cut ?? null,
        anyCut: hop.anyCut ?? null,
        cutsPerformed: hop.cutsPerformed ?? 0,
        armed: hop.cutArmedResponses ?? null,
        whole: hop.relayedWholeResponses ?? null,
        gzip: hop.gzipFramedResponses ?? null,
        // WIRE BYTES, WHICH ARE NOT THE COUNT LIMIT'S UNIT when the SSE body is re-framed as gzip: the
        // limit is a PLAINTEXT offset, and compressed wire bytes include headers and per-frame overhead.
        // A record with `completed: true` and `cutsPerformed: 0` beside a large releasedBytes count is
        // therefore consistent -- and claiming a cut from those two numbers is exactly what cost this
        // therefore consistent, and claiming a cut from those two numbers is what cost this lane two
        // runs of chasing a fault that had not happened.
        releasedBytes: hop.releasedBytes ?? null,
        completed: hop.completed === true,
        plaintextOffsetAtCut: hop.cutAfterBytes ?? null,
        writes: hop.bodyWriteCount ?? null,
        contentStates: report.streamState?.contentStatesAtCut ?? null,
        textAfterCut: report.streamState?.textAfterCut ?? null,
        returnedToIdle: report.streamState?.returnedToIdle ?? null,
        peerDisconnected: (report.recording ?? []).map(request => request.clientDisconnected),
        framesWritten: (report.recording ?? []).map(request => request.framesWritten),
        failure: report.failure ?? null,
    };
};

let exitCode = 0;
for (const file of process.argv.slice(2)) {
    try {
        console.log(`HOP_LOG ${JSON.stringify(summarize(file))}`);
    } catch (error) {
        // Reported, not thrown: the caller is a CI step whose job is to record, and this line must not change
        // its verdict.
        exitCode = 0;
        console.log(`HOP_LOG unreadable ${JSON.stringify({ leg: path.basename(file), error: String(error?.message ?? error) })}`);
    }
}
process.exit(exitCode);
