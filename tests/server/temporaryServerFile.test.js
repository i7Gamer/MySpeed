import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { removeTemporaryServer } from "../../server/util/speedtest.js";
import { readSource, bodyOf } from "../helpers/source.js";

/**
 * The file a librespeed run against a custom backend leaves behind.
 *
 * That run writes the backend's address into data/servers/libre_custom.json for
 * the CLI to read, and nothing ever removed it. A URL is allowed userinfo, so
 * the address can carry a credential - the same one the config export strips out
 * of libreUrl and GET /api/config withholds from a reader who is not the
 * operator - and it sat in the data volume outliving the run by however long the
 * instance lived. That volume is what people snapshot, mount into a backup
 * container, and attach to bug reports.
 */
const temporaryFile = () => {
    const file = path.join(os.tmpdir(), `myspeed-libre-${randomBytes(8).toString("hex")}.json`);
    fs.writeFileSync(file, JSON.stringify([{id: 1, server: "http://admin:hunter2@speed.lan"}]));

    return file;
};

describe("removeTemporaryServer", () => {
    it("takes the file back off disk", () => {
        const file = temporaryFile();

        removeTemporaryServer(file);

        assert.equal(fs.existsSync(file), false, "the custom server file outlives the run that wrote it");
    });

    /**
     * A run that measured the line must not be reported as failed because a
     * temporary file could not be deleted. The file has done its job by then.
     */
    it("says nothing about a file that is already gone", () => {
        const file = temporaryFile();
        fs.unlinkSync(file);

        removeTemporaryServer(file);
    });

    it("says nothing about a path that never existed", () => {
        removeTemporaryServer(path.join(os.tmpdir(), "myspeed-no-such-directory", "nothing.json"));
    });

    // Most runs write no such file at all - every ookla and cloudflare run, and
    // every librespeed run against a listed server.
    it("does nothing when the run wrote no file", () => {
        removeTemporaryServer(null);
        removeTemporaryServer(undefined);
    });
});

/**
 * And the run removes it however it ended. Both the failure and the success path
 * go through the same handler, which is the reason that handler exists.
 */
describe("a run that wrote one", () => {
    const run = bodyOf(readSource("server/util/speedtest.js"), "export default async (mode");

    it("removes it when the run ends", () => {
        assert.match(run, /removeTemporaryServer\(/,
            "the custom server file is written and never taken away");
    });

    it("removes it on the path where the CLI could not start, too", () => {
        const finish = run.slice(run.indexOf("const finish"), run.indexOf("await new Promise"));

        assert.match(finish, /removeTemporaryServer\(/,
            "only one of the two ways a run ends cleans up after it");
        assert.equal((run.match(/finish\(\);/g) ?? []).length, 2,
            "the two handlers no longer share the one thing that ends a run");
    });

    it("writes it under the name it later removes", () => {
        assert.match(run, /temporaryServer = path\.join/, "the file is written under some other name");
        assert.match(run, /removeTemporaryServer\(temporaryServer\)/,
            "the file removed is not the file written");
    });
});
