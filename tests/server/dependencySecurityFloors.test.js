import {it} from "node:test";
import assert from "node:assert/strict";
import {readSource} from "../helpers/source.js";

const manifest = JSON.parse(readSource("package.json"));
const lockfile = readSource("bun.lock");

// GHSA-27r3-jxmh-p828: trailing bytes after a compressed body hang the parser,
// and express.json() runs before any password check.
const BODY_PARSER_FLOOR = [2, 4, 0];

const lockedVersion = (name) => lockfile.match(new RegExp(`"${name}": \\["${name}@(\\d+)\\.(\\d+)\\.(\\d+)"`))?.slice(1).map(Number);

const atLeast = (version, floor) => {
    for (let index = 0; index < floor.length; index++)
        if (version[index] !== floor[index]) return version[index] > floor[index];
    return true;
};

it("forces body-parser past the compressed-body denial of service", () => {
    assert.equal(manifest.overrides["body-parser"], `^${BODY_PARSER_FLOOR.join(".")}`);

    const version = lockedVersion("body-parser");
    assert.ok(version, "body-parser is missing from bun.lock");
    assert.ok(atLeast(version, BODY_PARSER_FLOOR), `bun.lock resolves body-parser ${version.join(".")}`);
});
