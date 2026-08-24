import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../helpers/source.js";

/**
 * A server that is not among the twenty on offer, which is upstream #1455 -
 * "I want to use nodes from China for testing, but currently it does not support
 * adding custom nodes."
 *
 * It does support them, and always did: the dialog has a free-text server id
 * beside the dropdown, and whatever is typed there is what the run is pinned to.
 * The trouble is where it was hidden. The input was rendered only when
 * `serverId !== "none"`, and "none" is what the dialog opens on - so reaching it
 * meant first selecting one of the listed servers and then overwriting it, which
 * nobody would guess at.
 *
 * And the list is short by design: util/loadServers.js fetches
 * `speedtest.net/api/js/servers?limit=20`, geolocated to the *instance's*
 * address. So the twenty on offer are the twenty nearest the server - which for
 * the person who filed this were twenty servers in the wrong country, with no
 * visible way to name a different one.
 */
const source = readSource("client/src/common/components/ProviderDialog/ProviderDialog.jsx");

/** The block that renders the free-text id, from its label back to its guard. */
const idBlock = () => {
    const at = source.indexOf("dialog.provider.server_id");
    assert.notEqual(at, -1, "the dialog no longer offers a server id at all");

    // Back to the conditional that decides whether any of it is drawn, and
    // forward to the end of the input itself. Not to the next `</div>`: that one
    // closes the label the heading sits in, which leaves the input - the whole
    // subject of this file - outside the window.
    const from = source.lastIndexOf("{provider", source.lastIndexOf("{", at));

    return source.slice(from, source.indexOf("/>", at) + "/>".length);
};

describe("the free-text server id", () => {
    it("does not wait for a server to be chosen from the list first", () => {
        assert.ok(!/serverId\s*!==\s*"none"/.test(idBlock()),
            "the input is still hidden until one of the listed servers is selected");
    });

    /**
     * The two conditions that remain are real. Cloudflare has one endpoint and
     * no server to name, and a custom LibreSpeed URL *is* the server - the
     * dialog already clears one when the other is set, so showing both would
     * offer two ways to say the same thing and let them disagree.
     */
    it("is still kept away from the cases that have no server id", () => {
        const block = idBlock();

        assert.match(block, /provider\s*!==\s*"cloudflare"/,
            "cloudflare has one endpoint and no id to name");
        assert.match(block, /!isUsingCustomUrl/,
            "a custom LibreSpeed URL and a server id are two answers to one question");
    });

    /**
     * An empty box needs to say what may go in it, now that it is the first
     * thing an operator sees rather than something they uncovered by accident.
     *
     * Read out of the block rather than through tagHolding: the select above
     * carries the same onChange handler, so any marker naming it finds that tag
     * first and the assertion passes or fails on the wrong element.
     */
    it("says what it takes when it is empty", () => {
        assert.match(idBlock(), /placeholder=\{t\("dialog\.provider\.server_id_placeholder"\)\}/,
            "the empty input names nothing, so it reads as a field that has lost its value");
    });
});

/**
 * The dropdown keeps its place. It is the useful thing for the common case, and
 * the point of this change is that it stops being the *only* thing.
 */
describe("the server list", () => {
    it("still offers the servers it fetched", () => {
        assert.match(source, /ooklaServers\)\.map/);
        assert.match(source, /choose_automatically/);
    });
});
