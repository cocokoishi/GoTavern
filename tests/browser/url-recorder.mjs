// Record what the browser asked for and what came back, for gates that must judge URLs rather than
// page text.
//
// WHY THIS IS A MODULE. Two surfaces need the same instrument now: the asset gate asks whether every
// avatar/background/thumbnail request answered with bytes, and the 酒馆助手 gate asks whether every URL
// the helper's iframe and the helper's rendered message put into the DOM answered with bytes. Two
// copies of "record status, content type, length and digest" would drift, and the half that drifted
// would be the one nobody re-read.
//
// WHAT IT RECORDS, per request: method, path+query (never the absolute URL, which carries the ephemeral
// port and would make two legs of one comparison differ), the resource type, whether the request came
// from a frame other than the main one, the status, the content type, and — for every response below
// 400 — the byte length and sha256 of the body. The body is read inside the handler because a response
// object is not guaranteed to keep it after the page settles, and a length is what separates "200 with
// an error page" from "200 with a picture".

import { createHash } from 'node:crypto';

const TEXTUAL = /^(text\/|application\/(json|javascript|x-javascript|xml))/i;

function relativeUrl(raw) {
    try {
        const url = new URL(raw);
        return { origin: url.origin, pathAndQuery: `${url.pathname}${url.search}` };
    } catch {
        return { origin: '', pathAndQuery: String(raw) };
    }
}

export function attachUrlRecorder(page, { mainFrame = null } = {}) {
    const requests = [];
    const pending = [];
    let mainFrameRef = mainFrame;

    page.on('request', request => {
        const url = relativeUrl(request.url());
        const frame = request.frame();
        const isMainFrame = mainFrameRef === null ? frame === page.mainFrame() : frame === mainFrameRef;
        const entry = {
            method: request.method(),
            pathAndQuery: url.pathAndQuery,
            resourceType: request.resourceType(),
            mainFrame: isMainFrame,
            status: null,
            contentType: null,
            byteLength: null,
            sha256: null,
            bodyError: null,
        };
        requests.push(entry);
        request.__probeEntry = entry;
    });

    page.on('response', response => {
        const entry = response.request().__probeEntry;
        if (!entry) return;
        entry.status = response.status();
        entry.contentType = response.headers()['content-type'] ?? null;
        if (response.status() < 400) {
            const body = response.body().then(
                bytes => {
                    entry.byteLength = bytes.length;
                    entry.sha256 = createHash('sha256').update(bytes).digest('hex');
                    if (TEXTUAL.test(entry.contentType ?? '') && bytes.length <= 4000) {
                        entry.text = bytes.toString('utf8').slice(0, 4000);
                    }
                },
                error => {
                    entry.bodyError = String(error?.message ?? error).slice(0, 160);
                },
            );
            pending.push(body);
        }
    });

    return {
        requests,
        // Every response body that was requested, so a caller can await them before judging lengths.
        async settled() {
            await Promise.allSettled(pending);
            return requests;
        },
        urlOf(predicate) {
            return requests.filter(predicate);
        },
    };
}

// The DOM's own verdict on an image: `complete` alone is not enough (a 404 is complete), and a
// naturalWidth of 0 with a 200 is the case this project has already shipped once.
export async function imageOutcome(page, selector) {
    return page.evaluate(target => {
        const image = document.querySelector(target);
        if (!image) return null;
        return {
            selector: target,
            tagName: image.tagName.toLowerCase(),
            src: image.getAttribute('src'),
            resolvedSrc: image.currentSrc || image.src,
            complete: image.complete,
            naturalWidth: image.naturalWidth,
            naturalHeight: image.naturalHeight,
        };
    }, selector);
}

export function digestBytes(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}
