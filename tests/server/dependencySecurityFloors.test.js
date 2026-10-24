import {describe, it} from "node:test";
import assert from "node:assert/strict";
import {readSource} from "../helpers/source.js";

/**
 * Transitive packages with a published advisory, forced past it. Every copy in
 * the lockfile counts, nested ones included: a second resolution under some
 * parent is exactly how an old copy survives a bump.
 *
 * `override: false` marks a fix that was an in-range lockfile update, because an
 * override would also drag an unaffected older major onto an API it was not
 * written for. `affectedFrom` is where the advisory's range starts; a copy below
 * it is outside the advisory.
 */
const FLOORS = {
    "package.json": {
        // GHSA-27r3-jxmh-p828: trailing bytes after a compressed body hang the
        // parser, and express.json() runs before any password check.
        "body-parser": {floor: "2.4.0"},
        // GHSA-4p3w-j4w9-5jqw: path traversal via a crafted locale name (sequelize).
        "moment": {floor: "2.31.0"},
        // GHSA-mrhx-c7xc-m3w5: memory exhaustion on oversized collections (eslint plugin).
        "zod": {floor: "4.6.6"},
        // GHSA-qhr7-859c-m2p7, GHSA-6j4f-fj2g-mc7p, GHSA-q2hr-2g5m-vwhr: brace DoS.
        "brace-expansion": {floor: "5.0.11"},
        // GHSA-68fv-2mgg-jv7q: event-loop DoS via indexed source-map sections.
        "source-map-js": {floor: "1.2.2"}
    },
    "client/package.json": {
        // GHSA-hrr3-gc8f-f4qj and four siblings: host and scheme confusion.
        "fast-uri": {floor: "3.1.8"},
        // filelist's minimatch 5 still needs the 2.x API, which is not affected.
        "brace-expansion": {floor: "5.0.11", affectedFrom: "4.0.0", override: false},
        "source-map-js": {floor: "1.2.2"},
        // GHSA-m5mm-p8h7-m29v: unescaped </script in a serialized function (terser).
        "serialize-javascript": {floor: "7.1.3", override: false}
    }
};

const parseVersion = (version) => version.split(".").map(Number);

const atLeast = (version, floor) => {
    for (let index = 0; index < floor.length; index++)
        if (version[index] !== floor[index]) return version[index] > floor[index];
    return true;
};

const lockedVersions = (lockfile, name) =>
    [...lockfile.matchAll(new RegExp(`\\["${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@(\\d+\\.\\d+\\.\\d+)"`, "g"))]
        .map(match => match[1]);

describe("dependency security floors", () => {
    for (const [manifestPath, floors] of Object.entries(FLOORS)) {
        const manifest = JSON.parse(readSource(manifestPath));
        const lockfile = readSource(manifestPath.replace("package.json", "bun.lock"));

        for (const [name, {floor, affectedFrom, override = true}] of Object.entries(floors)) {
            it(`${manifestPath} forces ${name} to ${floor} or later`, () => {
                if (override) assert.equal(manifest.overrides?.[name], `^${floor}`);
                else assert.equal(manifest.overrides?.[name], undefined, `${name} must not be overridden`);

                const versions = lockedVersions(lockfile, name);
                assert.ok(versions.length > 0, `${name} is missing from the lockfile`);
                const affected = versions.filter(version =>
                    !affectedFrom || atLeast(parseVersion(version), parseVersion(affectedFrom)));
                assert.ok(affected.length > 0, `no copy of ${name} is in the advisory's line any more`);
                for (const version of affected)
                    assert.ok(atLeast(parseVersion(version), parseVersion(floor)), `the lockfile resolves ${name} ${version}`);
            });
        }
    }

    it("finds every copy of a package, nested resolutions included", () => {
        const lockfile = `"a": ["pkg@1.0.0", ""],\n"b/pkg": ["pkg@2.0.0", ""],\n"other": ["pkg-two@9.0.0", ""]`;
        assert.deepEqual(lockedVersions(lockfile, "pkg"), ["1.0.0", "2.0.0"]);
    });

    it("compares versions numerically, not as text", () => {
        assert.equal(atLeast([5, 0, 11], [5, 0, 9]), true);
        assert.equal(atLeast([5, 0, 9], [5, 0, 11]), false);
        assert.equal(atLeast([2, 4, 0], [2, 4, 0]), true);
        assert.equal(atLeast([3, 0, 0], [2, 9, 9]), true);
    });
});
