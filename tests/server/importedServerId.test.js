import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { bodyOf, readSource } from "../helpers/source.js";

/**
 * serverId is a numeric column, and the import checked every numeric column but
 * it.
 *
 * NUMERIC_COLUMNS names the ten the validation walks; serverId is the eleventh,
 * and the omission was invisible because nothing downstream did arithmetic on
 * it - until the Prometheus exporter began setting a gauge from it. sqlite
 * stores whatever it is handed, so `{"serverId": "auto"}` survived the write
 * and then threw out of every scrape.
 *
 * Read as source rather than run: the write path needs a database, and what is
 * asserted is which columns the validation covers.
 */
const source = readSource("server/controller/speedtests.js");

describe("the columns an import validates", () => {
    const columns = () => {
        const literal = source.match(/const NUMERIC_COLUMNS = \[([\s\S]*?)\]/)?.[1];
        assert.ok(literal, "the numeric column list is gone");

        return [...literal.matchAll(/"(\w+)"/g)].map((match) => match[1]);
    };

    it("covers serverId, which the exporter reads as a number", () => {
        assert.ok(columns().includes("serverId"),
            "an imported row can put text in serverId, and the metrics gauge throws on it");
    });

    it("still covers every measurement it always did", () => {
        for (const column of ["ping", "download", "upload", "time", "jitter", "packetLoss",
            "downloadLatency", "uploadLatency", "bytesDownloaded", "bytesUploaded"])
            assert.ok(columns().includes(column), `${column} is no longer validated`);
    });
});

/**
 * And a refused payload answers in the shape the route destructures.
 *
 * routes/storage.js reads `{ok, imported, skipped}` off the return, so a bare
 * `false` gave all three as undefined: the counters the route deliberately
 * sends - "the counts travel with the message" - vanished from the body, and a
 * caller parsing them read a restore that refused everything as one that said
 * nothing.
 */
describe("an import handed something that is not a list", () => {
    it("answers the same shape as one that ran", async () => {
        const body = bodyOf(source, "export const importTests");
        const refusal = body.slice(0, body.indexOf("\n\n"));

        assert.doesNotMatch(refusal, /return false/,
            "the refusal answers a bare boolean the route cannot destructure");
        assert.match(refusal, /\{ok: false, imported: 0, skipped: 0\}/);
    });
});
