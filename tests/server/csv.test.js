import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CSV_HEADER, toCsv } from "../../server/util/csv.js";

const row = (overrides = {}) => ({
    id: 1, ping: 10, jitter: 2.5, download: 100, upload: 50,
    time: 30, type: "auto", created: "2026-08-07T10:00:00.000Z", error: null, ...overrides
});

const lines = (entries) => toCsv(entries).split("\n");

describe("toCsv", () => {
    it("returns just the header for an empty export", () => {
        assert.equal(toCsv([]), CSV_HEADER);
    });

    it("starts with the header row", () => {
        assert.equal(lines([row()])[0], "id,ping,jitter,download,upload,time,type,created,error");
    });

    it("emits one line per entry", () => {
        assert.equal(lines([row(), row({id: 2})]).length, 3);
    });

    it("quotes every field", () => {
        assert.equal(lines([row()])[1], '"1","10","2.5","100","50","30","auto","2026-08-07T10:00:00.000Z",""');
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
            assert.equal(line.split('","').length, 9);
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
