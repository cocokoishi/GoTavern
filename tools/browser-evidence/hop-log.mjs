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
        armed: hop.cutArmedResponses ?? null,
        whole: hop.relayedWholeResponses ?? null,
        gzip: hop.gzipFramedResponses ?? null,
        releasedBytes: hop.releasedBytes ?? null,
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
