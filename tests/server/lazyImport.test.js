import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { lazyImport } from "../../server/util/lazyImport.js";
import { readSource, withoutJsComments } from "../helpers/source.js";

describe("lazyImport", () => {
    it("does not load anything until it is first asked", () => {
        let calls = 0;
        lazyImport(async () => { calls++; return {}; });

        assert.equal(calls, 0);
    });

    it("loads once and hands every later caller the same module", async () => {
        let calls = 0;
        const module = {name: "loaded"};
        const load = lazyImport(async () => { calls++; return module; });

        assert.equal(await load(), module);
        assert.equal(await load(), module);
        assert.equal(calls, 1);
    });

    it("shares one load between callers that arrive while it is running", async () => {
        let calls = 0;
        let release;
        const gate = new Promise((resolve) => { release = resolve; });
        const load = lazyImport(async () => { calls++; await gate; return {}; });

        const first = load();
        const second = load();
        release();

        assert.equal(await first, await second);
        assert.equal(calls, 1);
    });

    it("passes a failed load on and tries again on the next call", async () => {
        const failure = new Error("binding missing");
        const module = {};
        let calls = 0;
        const load = lazyImport(async () => {
            calls++;
            if (calls === 1) throw failure;
            return module;
        });

        await assert.rejects(load(), (error) => error === failure);
        assert.equal(await load(), module);
        assert.equal(calls, 2);
    });

    it("turns a loader that throws synchronously into a rejection", async () => {
        const failure = new Error("sync");
        const load = lazyImport(() => { throw failure; });

        await assert.rejects(load(), (error) => error === failure);
    });
});

/**
 * Libraries most instances never use, kept out of the startup footprint.
 *
 * Measured in the published 1.7.3 image: satori alone adds ~42 MiB RSS and
 * nodemailer ~19 MiB, and both were imported while the route table and the
 * integration registry were built - on every instance, including the many that
 * never render a share image or send an email. A 100 MB container limit then
 * left the server stalling under memory pressure (issue #135).
 *
 * Asserted against the source, as opengraphBoot.test.js does for resvg: what
 * matters is the shape of the import.
 */
describe("heavy libraries load on first use, not at startup", () => {
    const cases = [
        {file: "server/controller/opengraph.js", module: "satori"},
        {file: "server/controller/opengraph.js", module: "@resvg/resvg-js"},
        {file: "server/integrations/email.js", module: "nodemailer"}
    ];

    for (const {file, module} of cases) {
        const source = withoutJsComments(readSource(file));
        const escaped = module.replace(/[/.@-]/g, (c) => `\\${c}`);

        it(`${file} does not import ${module} at the top`, () => {
            assert.doesNotMatch(source, new RegExp(`^\\s*import\\s[^\\n]*['"]${escaped}['"]`, "m"));
        });

        it(`${file} loads ${module} when it is needed`, () => {
            assert.match(source, new RegExp(`import\\(\\s*['"]${escaped}['"]\\s*\\)`));
        });
    }
});
