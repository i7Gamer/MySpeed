import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CSV_HEADER, toCsv } from "../../server/util/csv.js";

const row = (overrides = {}) => ({
    id: 1, ping: 10, jitter: 2.5, download: 100, upload: 50,
    time: 30, type: "auto", created: "2026-08-07T10:00:00.000Z",
    packetLoss: 0, downloadLatency: 12.5, uploadLatency: 44.75, error: null, ...overrides
});

const FIELDS_PER_ROW = 12;

const lines = (entries) => toCsv(entries).split("\n");

describe("toCsv", () => {
    it("returns just the header for an empty export", () => {
        assert.equal(toCsv([]), CSV_HEADER);
    });

    it("starts with the header row", () => {
        assert.equal(lines([row()])[0],
            "id,ping,jitter,download,upload,time,type,created,packetLoss,downloadLatency,uploadLatency,error");
    });

    it("emits one line per entry", () => {
        assert.equal(lines([row(), row({id: 2})]).length, 3);
    });

    it("quotes every field", () => {
        assert.equal(lines([row()])[1],
            '"1","10","2.5","100","50","30","auto","2026-08-07T10:00:00.000Z","0","12.5","44.75",""');
    });

    // The figures are only worth recording if they leave again, and a zero must
    // survive as a zero rather than being emptied out as falsy.
    it("exports the quality figures, including a packet loss of zero", () => {
        const fields = lines([row()])[1].split('","');

        assert.equal(fields[8], "0");
        assert.equal(fields[9], "12.5");
        assert.equal(fields[10], "44.75");
    });

    it("empties a quality figure the provider never measured", () => {
        const fields = lines([row({packetLoss: null, downloadLatency: null, uploadLatency: null})])[1].split('","');

        for (const index of [8, 9, 10]) assert.equal(fields[index], "");
    });

    it("renders null as an empty quoted field", () => {
        assert.match(lines([row({jitter: null})])[1], /^"1","10","",/);
    });

    describe("escaping", () => {
        // Regression: the previous implementation only swapped commas for
        // semicolons in `error`, so quotes and newlines broke the row layout and
        // shifted every following column.
        it("keeps a comma inside a single field", () => {
            const line = lines([row({error: "connection lost, retrying"})])[1];
            assert.ok(line.endsWith('"connection lost, retrying"'));
            assert.equal(line.split('","').length, FIELDS_PER_ROW);
        });

        it("doubles an embedded quote", () => {
            assert.ok(lines([row({error: 'said "no"'})])[1].endsWith('"said ""no"""'));
        });

        it("keeps an embedded newline inside the quoted field", () => {
            // A quoted newline is legal RFC 4180 and stays part of the same
            // record, so this is asserted against the raw text rather than
            // against newline-split lines.
            assert.ok(toCsv([row({error: "line one\nline two"})]).includes('"line one\nline two"'));
        });

        it("does not let a crafted error forge extra columns", () => {
            const csv = toCsv([row({error: '","injected","x'})]);
            // Header plus exactly one data row, despite the embedded separators.
            assert.equal(csv.split("\n").length - 1, 1);
        });
    });
});
