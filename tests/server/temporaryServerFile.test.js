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

    /**
     * However the test ended, which is now more ways than it used to be: a
     * test can be several invocations of the CLI - iperf3 measures one
     * direction per invocation - so the file has to outlive each of them and
     * be taken away once, after the last.
     *
     * A `finally` around the whole test rather than the per-invocation
     * handler, which is where this lived while there was only ever one
     * invocation. It covers strictly more: both ways a single run ends, and
     * also a throw between two of them, which the handler could not see.
     */
    it("removes it however the test ended, including between runs", () => {
        const cleanup = run.slice(run.indexOf("} finally {"));

        assert.match(cleanup, /removeTemporaryServer\(temporaryServer\)/,
            "a run that threw leaves a file naming a backend, credentials included");
        assert.equal((run.match(/removeTemporaryServer\(/g) ?? []).length, 1,
            "the file is taken away in more than one place, so one of them will drift");
    });

    // The per-invocation handler is still shared by the two ways one
    // invocation can end - a spawn that failed and a CLI that closed - which
    // is what stops the tracker entry and the timers leaking on either path.
    it("ends each invocation through the one handler", () => {
        assert.equal((run.match(/finish\(\);/g) ?? []).length, 2,
            "the two handlers no longer share the one thing that ends a run");
    });

    it("writes it under the name it later removes", () => {
        // The name is chosen in the registry's buildArgs and handed over as
        // {path, content}; the run writes and later removes that same path.
        assert.match(run, /temporaryServer = built\.temporaryServer\.path/,
            "the file is written under some other name");
        assert.match(run, /removeTemporaryServer\(temporaryServer\)/,
            "the file removed is not the file written");
        assert.match(readSource("server/util/providers/registry.js"), /libre_custom\.json/,
            "the registry no longer names the custom-server file");
    });
});
