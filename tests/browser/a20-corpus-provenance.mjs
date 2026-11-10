// Computes the alpha.20 medium corpus MESSAGE PROVENANCE from the persisted JSONL itself.
//
// The corpus report must NOT merge the provenance layers. This script derives each layer from the
// bytes on disk (never from a builder log) and writes the numbers the report consumes:
//
//   productSavePath     messages written by the product's own saveChatConditional with the disclosed
//                       A20_PRODUCT_SAVE_PATH marker
//   uiTurnMessages      messages written by a real send: the user message carries an A20 FILL UI TURN
//                       marker and the assistant message that directly follows it is the recording peer's
//                       reply (2 per successful turn)
//   productNativeChat   the remaining assistant messages: the character's greeting(s) written by the
//                       product when the New Chat function created the chat (not a send, not a save-path
//                       fill). They are counted, not merged.
//
// Usage: node <this> --data-root <corpus data> --out <provenance.json> [--report <copy of the output>]

import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const argument = (name, fallback) => {
    const index = argv.indexOf(name);
    return index === -1 ? fallback : argv[index + 1] ?? fallback;
};
const dataRoot = path.resolve(argument('--data-root', ''));
const outPath = path.resolve(argument('--out', ''));
if (!dataRoot || !outPath) { console.error('usage: node a20-corpus-provenance.mjs --data-root <corpus data> --out <provenance.json>'); process.exit(2); }

const root = path.join(dataRoot, 'default-user');
const dirs = [path.join(root, 'chats'), path.join(root, 'group chats')];
const files = [];
for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    const walk = directory => {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const full = path.join(directory, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.name.endsWith('.jsonl')) files.push(full);
        }
    };
    walk(dir);
}
const counts = {
    chats: files.length,
    messages: 0,
    productSavePathMessages: 0,
    uiTurnMessages: 0,
    uiTurnPairs: 0,
    productNativeChatMessages: 0,
    headers: 0,
    unparseableLines: 0,
};
let previousWasUiUser = false;
for (const file of files) {
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(line => line.trim().length > 0); } catch { continue; }
    if (lines.length > 0) counts.headers += 1;
    for (const [index, line] of lines.entries()) {
        if (index === 0) { previousWasUiUser = false; continue; } // header record
        let message = null;
        try { message = JSON.parse(line); } catch { counts.unparseableLines += 1; continue; }
        counts.messages += 1;
        const text = String(message.mes ?? '');
        if (text.includes('A20_PRODUCT_SAVE_PATH')) { counts.productSavePathMessages += 1; previousWasUiUser = false; continue; }
        if (!message.is_user && text.includes('A20 FILL UI TURN') === false && previousWasUiUser) {
            counts.uiTurnMessages += 1;
            previousWasUiUser = false;
            continue;
        }
        if (message.is_user && text.includes('A20 FILL UI TURN')) { counts.uiTurnMessages += 1; counts.uiTurnPairs += 1; previousWasUiUser = true; continue; }
        counts.productNativeChatMessages += 1;
        previousWasUiUser = false;
    }
}
const document = {
    schema: 'a20-corpus-message-provenance-v1',
    dataRoot: path.basename(dataRoot),
    method: 'derived from the persisted JSONL bytes: product-save-path marker, UI-turn marker (user + the assistant reply directly following it), and the remaining assistant messages the product writes when its New Chat function creates a chat with the character greeting.',
    counts,
    disclosed: {
        uiTurnMessages: `${counts.uiTurnPairs} real sends through #send_textarea/#send_but (the bounded sample); each successful turn persists 2 messages`,
        productSavePathMessages: 'appended to the page chat model and persisted by the product own saveChatConditional; NOT UI turns',
        productNativeChatMessages: 'the character greeting(s) written by the product when a chat is created; NOT a send and NOT a save-path fill',
    },
};
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ counts, out: outPath }));
