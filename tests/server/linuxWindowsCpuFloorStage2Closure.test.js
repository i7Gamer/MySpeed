import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";

import {stage2ClosureFromStage3Closure, STAGE3_LAUNCHER_CONSTANTS} from
    "../../scripts/qualification/linux-windows-cpu-floor-stage3-launcher.mjs";

const makeSource = root => {
    for (const name of STAGE3_LAUNCHER_CONSTANTS.STAGE2_CLOSURE_NAMES) {
        const target = path.join(root, name);
        fs.mkdirSync(path.dirname(target), {recursive: true});
        fs.writeFileSync(target, `export const member = ${JSON.stringify(name)};\n`);
    }
};

describe("Stage 2 closure derivation", () => {
    it("creates the exact closure once with exclusive files and a matching manifest", t => {
        const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "stage2-derived-")));
        t.after(() => fs.rmSync(parent, {recursive: true, force: true}));
        const source = path.join(parent, "source"); const target = path.join(parent, "derived");
        fs.mkdirSync(source); makeSource(source);
        const result = stage2ClosureFromStage3Closure(source, target);
        assert.equal(result.root, target);
        assert.deepEqual(result.files.map(file => file.name), STAGE3_LAUNCHER_CONSTANTS.STAGE2_CLOSURE_NAMES);
        const manifest = JSON.parse(fs.readFileSync(path.join(target, "stage2-closure.json"), "utf8"));
        assert.deepEqual(manifest, {schemaVersion: 1, files: result.files});
        assert.deepEqual(fs.readdirSync(target).sort(), ["scripts", "stage2-closure.json"]);
    });

    it("refuses an existing destination without modifying it", t => {
        const parent = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), "stage2-collision-")));
        t.after(() => fs.rmSync(parent, {recursive: true, force: true}));
        const source = path.join(parent, "source"); const target = path.join(parent, "derived");
        fs.mkdirSync(source); makeSource(source); fs.mkdirSync(target);
        const sentinel = path.join(target, "sentinel"); fs.writeFileSync(sentinel, "owned");
        assert.throws(() => stage2ClosureFromStage3Closure(source, target), /not fresh/u);
        assert.equal(fs.readFileSync(sentinel, "utf8"), "owned");
    });

    it("rejects relative roots before filesystem mutation", () => {
        assert.throws(() => stage2ClosureFromStage3Closure("relative-source", "relative-target"), /absolute/u);
    });
});
