import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {rawSourceReads} from "../helpers/rawSourceReads.js";
import {walkSources} from "../helpers/source.js";

describe("normalized client-source reader guard", () => {
    for (const read of [
        'import fs from "node:fs"; fs.readFileSync("client/src/App.jsx", "utf8");',
        'import * as disk from "fs"; disk["readFileSync"]("client/src/App.jsx").toString();',
        'import {readFileSync as load} from "node:fs"; load(join(root, "client", "src", "App.jsx"), "utf-8");',
        'import fs from "node:fs"; const load = fs.readFileSync; const file = "client/src/App.jsx"; load(file, {encoding: "utf8"});',
        'import fs from "node:fs"; const read = file => fs.readFileSync(file, "utf8"); read(join(CLIENT_SRC, "App.jsx"));'
    ]) it(`detects ${read}`, () => assert.equal(rawSourceReads(read).length, 1));
    for (const read of [
        'import fs from "node:fs"; JSON.parse(fs.readFileSync(join(LOCALES, code), "utf8"));',
        'import {readFileSync as load} from "node:fs"; const fixtures = join(root, "fixtures"); const file = join(fixtures, "source.jsx"); load(file, "utf8");',
        'import fs from "node:fs"; fs.readFileSync("image.png");',
        'import fs from "node:fs"; fs.readFileSync(join(root, "package.json"), "utf8");',
        'const source = readSource(join(CLIENT_SRC, "App.jsx"));',
        'const unrelated = {}; unrelated.readFileSync("value", "utf8");'
    ]) it(`permits ${read}`, () => assert.deepEqual(rawSourceReads(read), []));
    it("all client source scans use the normalized reader", () => {
        const offenders = walkSources("tests/client").flatMap(({path, source}) =>
            rawSourceReads(source).map(line => `${path}:${line}`));
        assert.deepEqual(offenders, [], "use readSource for text anchors; keep JSON, explicit fixtures and binary I/O raw");
    });
});
