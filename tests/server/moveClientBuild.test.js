import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { moveClientBuild } from "../../scripts/move-client-build.js";

/**
 * scripts/move-client-build.js replaces the rm/mv pair that build:binary,
 * build:binary:baseline, and every packaging CI job used to duplicate. It takes
 * a root directory argument specifically so this can exercise it against a
 * scratch tree instead of the real repository.
 */
describe("moveClientBuild", () => {
    let root;

    beforeEach(() => {
        root = fs.mkdtempSync(path.join(os.tmpdir(), "move-client-build-"));
    });

    afterEach(() => {
        fs.rmSync(root, {recursive: true, force: true});
    });

    const writeFile = (...segments) => {
        const file = path.join(root, ...segments);
        fs.mkdirSync(path.dirname(file), {recursive: true});
        fs.writeFileSync(file, segments.at(-1));
    };

    it("moves client/build to build when nothing is at build yet", () => {
        writeFile("client", "build", "index.html");
        writeFile("client", "build", "assets", "app.js");

        const result = moveClientBuild(root);

        assert.equal(result, path.join(root, "build"));
        assert.equal(fs.existsSync(path.join(root, "client", "build")), false);
        assert.equal(fs.readFileSync(path.join(root, "build", "index.html"), "utf8"), "index.html");
        assert.equal(fs.readFileSync(path.join(root, "build", "assets", "app.js"), "utf8"), "app.js");
    });

    it("replaces an existing root build with the fresh client build", () => {
        writeFile("build", "stale.html");
        writeFile("client", "build", "index.html");

        moveClientBuild(root);

        assert.equal(fs.existsSync(path.join(root, "build", "stale.html")), false);
        assert.equal(fs.readFileSync(path.join(root, "build", "index.html"), "utf8"), "index.html");
    });

    it("errors with a clear message when client/build is missing", () => {
        assert.throws(
            () => moveClientBuild(root),
            (err) => {
                assert.match(err.message, /client.build/);
                assert.match(err.message, /does not exist/);
                return true;
            }
        );
    });
});
