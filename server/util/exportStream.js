import { CSV_HEADER, csvLines } from './csv.js';

/**
 * Writes a history export page by page, so the largest thing this server ever
 * produces - the backup of an instance that has simply been running - never
 * exists in memory as one document.
 *
 * Both writers are byte-for-byte the one-string answers they replaced:
 * JSON.stringify(rows, null, 4) and toCsv(rows). A backup format is a contract
 * with every file already downloaded, so the streaming is allowed to change
 * when the bytes leave, and nothing about what they are.
 */
const JSON_INDENT_SPACES = 4;

const ROW_INDENT = " ".repeat(JSON_INDENT_SPACES);

// One row as stringify-with-indent renders it as an array element: rendered
// alone, then shifted right one level. The separators between rows and the
// brackets around them are the callers' - they are what the page boundaries
// must not show through.
const jsonRow = (row) =>
    JSON.stringify(row, null, JSON_INDENT_SPACES).split("\n").map((line) => ROW_INDENT + line).join("\n");

/**
 * One chunk, honouring backpressure without hanging on a caller that left.
 *
 * 'drain' never fires on a destroyed response, so the wait listens for 'close'
 * beside it. Answers whether writing can continue, which is also the callers'
 * signal to stop pulling pages - the pages are database reads, and a client
 * that is gone must stop the walk, not merely the writing.
 */
const flush = async (res, chunk) => {
    if (res.destroyed) return false;
    if (res.write(chunk)) return true;

    await new Promise((resolve) => {
        const settled = () => {
            res.off("drain", settled);
            res.off("close", settled);
            resolve();
        };
        res.once("drain", settled);
        res.once("close", settled);
    });

    return !res.destroyed;
};

export const streamJsonArray = async (res, pages) => {
    let opened = false;

    for await (const rows of pages) {
        const lead = opened ? ",\n" : "[\n";
        opened = true;
        if (!await flush(res, lead + rows.map(jsonRow).join(",\n"))) return;
    }

    if (!await flush(res, opened ? "\n]" : "[]")) return;
    res.end();
};

export const streamCsv = async (res, pages) => {
    if (!await flush(res, CSV_HEADER)) return;

    let opened = false;

    for await (const rows of pages) {
        const lead = opened ? "\n" : "";
        opened = true;
        if (!await flush(res, lead + csvLines(rows).join("\n"))) return;
    }

    res.end();
};
