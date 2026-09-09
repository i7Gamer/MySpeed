import {it} from "node:test";
import assert from "node:assert/strict";
import {cloudflareVersion} from "../../server/config/binaries.js";
import {readSource} from "../helpers/source.js";

it("keeps the dated Cloudflare release review tied to the deployed pin", () => {
    const guide = readSource("CLI_MAINTENANCE.md");
    const row = /^\| cfspeedtest \| `([^`]+)` \| (\d{4}-\d{2}-\d{2}) \|/m.exec(guide);
    assert.ok(row, "record the current pin and release-check date");
    assert.equal(row[1], cloudflareVersion);
    assert.ok(Number.isFinite(Date.parse(row[2])));
});
