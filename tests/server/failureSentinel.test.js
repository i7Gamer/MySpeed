import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FAILED_TEST } from "../../server/util/testOutcome.js";

/**
 * The placeholder a failed test writes into every numeric column, spelled once.
 *
 * testOutcome.js was written to own the question "did this test fail" and
 * exports the sentinel that answer is built on - and no module imported it.
 * Two others declared their own `const FAILED = -1` instead: the writer, which
 * decides what a failure stores, and the alert gate, whose whole job is to tell
 * a placeholder apart from a measurement. Those two agreeing is a correctness
 * requirement and nothing linked them, so changing the sentinel in one place
 * would leave the gate treating -1 as "not a reading" while accepting the new
 * value as a real one - and an integration configured with only a latency alert
 * would start firing on every failed run.
 */
const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

const READERS = [
    "server/tasks/speedtest.js",
    "server/util/alertThreshold.js"
];

describe("the failed-test placeholder", () => {
    it("is what it has always been", () => {
        assert.equal(FAILED_TEST, -1);
    });

    for (const file of READERS) {
        it(`${path.basename(file)} takes it from the one place`, () => {
            const source = read(file);

            assert.match(source, /FAILED_TEST/,
                `${file} does not import the shared sentinel`);
            assert.doesNotMatch(source, /const\s+FAILED\s*=\s*-1/,
                `${file} declares its own copy of the placeholder again`);
        });
    }

    // The predicate's own module, which is where both of them read it from.
    it("is exported by the module that owns the judgement", () => {
        assert.match(read("server/util/testOutcome.js"), /export const FAILED_TEST/);
    });
});
