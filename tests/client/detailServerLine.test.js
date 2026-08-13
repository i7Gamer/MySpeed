import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CLIENT_SRC = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "client", "src");

const pane = fs.readFileSync(
    path.join(CLIENT_SRC, "common", "components", "TestDetails", "TestDetails.jsx"), "utf8");

/**
 * The server's secondary line, lifted out of the component and run.
 *
 * The line is plain JavaScript - the JSX around it is what node cannot parse,
 * not the expression itself - and what is wrong with it is what it prints for a
 * given row, which asserting on the shape of its source cannot see: every
 * spelling of "the location leads" contains the same words. Follows
 * overviewRow.test.js, which lifts the row's key handler out for the same
 * reason.
 *
 * The whole region is taken rather than the one statement, because the line has
 * to know what the main line above it is already showing.
 */
const secondaryLine = (test) => {
    const from = pane.indexOf("const server");
    assert.notEqual(from, -1, "the pane no longer builds a server line");

    const joined = pane.indexOf(".join(", from);
    assert.notEqual(joined, -1, "the secondary line is no longer joined from parts");

    const source = pane.slice(from, pane.indexOf(";", joined) + 1);

    return new Function("test", `${source}\nreturn serverDetail;`)(test);
};

const SERVER = {
    serverName: "Init7",
    serverLocation: "Zurich",
    serverHost: "speedtest.init7.net:8080",
    serverId: 1234
};

/**
 * The two lines of the server fact used to be able to say the same word twice
 * and leave out the one thing they exist to add.
 *
 * The main line is the name, falling back to the city and then to the address.
 * The secondary line led with the city unconditionally and showed the address
 * only when there was a name - so a row whose provider reported no name printed
 * the city on both lines and its host, which is the half that says which of a
 * provider's dozen identically named servers answered, on neither.
 *
 * Reachable from an imported row, whose columns are barely validated, and from
 * any provider that reports a location and no sponsor.
 */
describe("the server's two lines", () => {
    it("names the server, then where it is, then what answered", () => {
        assert.match(pane, /test\.serverName \|\| test\.serverLocation \|\| test\.serverHost/,
            "the main line no longer falls back from the name to the location to the host");
    });

    it("puts the city, the address and the number beside a named server", () => {
        assert.equal(secondaryLine(SERVER), "Zurich · speedtest.init7.net:8080 · #1234");
    });

    // The city is the main line here, so repeating it says nothing and costs the
    // address its place.
    for (const nameless of ["", null, undefined])
        it(`carries the address rather than the city again for a serverName of ${JSON.stringify(nameless)}`, () => {
            const line = secondaryLine({...SERVER, serverName: nameless});

            assert.doesNotMatch(line, /Zurich/, "the city is printed on both lines");
            assert.equal(line, "speedtest.init7.net:8080 · #1234");
        });

    // The same one line down: with neither a name nor a city the address is the
    // main line, and only the number is left to add.
    it("leaves the number alone when the address is the main line", () => {
        assert.equal(secondaryLine({serverHost: "speedtest.init7.net:8080", serverId: 1234}), "#1234");
    });

    it("has nothing to add to a row that carries only a name", () => {
        assert.equal(secondaryLine({serverName: "Init7"}), "");
    });

    it("is empty for a provider that reports no server at all", () => {
        assert.equal(secondaryLine({}), "");
    });

    // Zero is the column's default, i.e. a provider that numbers no servers,
    // rather than a server numbered zero.
    it("does not number a server the provider left unnumbered", () => {
        assert.equal(secondaryLine({...SERVER, serverId: 0}), "Zurich · speedtest.init7.net:8080");
    });
});
