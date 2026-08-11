import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CSV_COLUMNS, CSV_HEADER, toCsv } from "../../server/util/csv.js";

const row = (overrides = {}) => ({
    id: 1, ping: 10, jitter: 2.5, download: 100, upload: 50,
    time: 30, type: "auto", created: "2026-08-07T10:00:00.000Z", provider: "ookla",
    serverId: 49631, serverName: "Arcade Solutions AG", serverHost: "speedtest.arcade.ch",
    packetLoss: 0, downloadLatency: 12.5, uploadLatency: 44.75,
    isp: "Salt Mobile", externalIp: "2a04:ee41::1",
    bytesDownloaded: 1135809960, bytesUploaded: 917831105,
    resultId: "abc123", error: null, ...overrides
});

const FIELDS_PER_ROW = CSV_COLUMNS.length;

// Located by name: a fixed index silently starts asserting about the wrong
// column the moment one is inserted rather than appended.
const field = (line, column) => line.split('","')[CSV_COLUMNS.indexOf(column)].replaceAll('"', "");

const lines = (entries) => toCsv(entries).split("\n");

describe("toCsv", () => {
    it("returns just the header for an empty export", () => {
        assert.equal(toCsv([]), CSV_HEADER);
    });

    it("starts with the header row", () => {
        assert.equal(lines([row()])[0],
            "id,ping,jitter,download,upload,time,type,created,provider,serverId,serverName,serverHost," +
            "packetLoss,downloadLatency,uploadLatency,isp,externalIp,bytesDownloaded,bytesUploaded,resultId,error");
    });

    // Free text last, so a reader scanning the numeric columns never steps over
    // it, and the escaping assertions below can anchor on the end of the line.
    it("keeps the one free-text column last", () => {
        assert.equal(CSV_COLUMNS.at(-1), "error");
    });

    it("emits one line per entry", () => {
        assert.equal(lines([row(), row({id: 2})]).length, 3);
    });

    it("quotes every field", () => {
        assert.equal(lines([row()])[1],
            '"1","10","2.5","100","50","30","auto","2026-08-07T10:00:00.000Z","ookla","49631",' +
            '"Arcade Solutions AG","speedtest.arcade.ch","0","12.5","44.75","Salt Mobile","2a04:ee41::1",' +
            '"1135809960","917831105","abc123",""');
    });

    // The figures are only worth recording if they leave again, and a zero must
    // survive as a zero rather than being emptied out as falsy.
    it("exports the quality figures, including a packet loss of zero", () => {
        const line = lines([row()])[1];

        assert.equal(field(line, "packetLoss"), "0");
        assert.equal(field(line, "downloadLatency"), "12.5");
        assert.equal(field(line, "uploadLatency"), "44.75");
    });

    // Regression: serverId was left out of the export, so restoring a backup
    // reset every row to the column's 0 default.
    it("exports the id of the server that was measured", () => {
        assert.equal(field(lines([row()])[1], "serverId"), "49631");
    });

    it("exports the server that was measured", () => {
        const line = lines([row()])[1];

        assert.equal(field(line, "serverName"), "Arcade Solutions AG");
        assert.equal(field(line, "serverHost"), "speedtest.arcade.ch");
    });

    it("empties a quality figure the provider never measured", () => {
        const line = lines([row({packetLoss: null, downloadLatency: null, uploadLatency: null})])[1];

        for (const column of ["packetLoss", "downloadLatency", "uploadLatency"])
            assert.equal(field(line, column), "");
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
