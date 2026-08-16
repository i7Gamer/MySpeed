import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", ".github", "workflows");

const read = (name) => fs.readFileSync(path.join(WORKFLOWS, name), "utf8");

const binaries = read("build-binaries.yml");

// A job's own lines, so an assertion about the Windows job cannot be satisfied
// by something the Linux job happens to say. Jobs sit at two spaces; the next
// line at that indent starts the next one.
const job = (workflow, name) => {
    const lines = workflow.split("\n");
    const start = lines.findIndex((line) => line === `  ${name}:`);
    assert.notEqual(start, -1, `${name} is no longer a job in this workflow`);

    const length = lines.slice(start + 1).findIndex((line) => /^ {2}\S/.test(line));
    return (length === -1 ? lines.slice(start) : lines.slice(start, start + 1 + length)).join("\n");
};

// The values a matrix leg is built from, read out of the include list rather
// than restated here - the point of every assertion below is that the workflow
// still says what another file already assumes it says.
const matrixValues = (block, key) => [...block.matchAll(new RegExp(`^\\s*-? *${key}: *(.+)$`, "gm"))]
    .map((found) => found[1].trim());

const windows = job(binaries, "build-windows");

/**
 * Bun's default x64 target compiles in AVX2. On a pre-Haswell / Atom-class CPU
 * the binary dies at startup with `Illegal instruction`, which is why #13 added
 * a baseline Linux build. `bun-windows-x64` carries the same assumption, so the
 * same-era Windows machines crash the same way - and under the MSI, which
 * registers this binary as a service, the crash surfaces as a service that
 * never starts rather than as an error anyone can read.
 */
describe("the Windows binaries a release publishes", () => {
    it("builds a baseline variant for CPUs without AVX2", () => {
        assert.match(windows, /target: *bun-windows-x64-baseline\b/,
            "nothing in the Windows job compiles the non-AVX2 target");
    });

    /**
     * Both legs compile to the same local `MySpeed.exe` - build-msi's WiX
     * source resolves against that name - so the matrix value is the only thing
     * keeping the two apart. Left as a literal, the second leg would overwrite
     * the first one's upload instead of adding to it.
     */
    it("gives each variant its own name", () => {
        const names = matrixValues(windows, "artifact_name");

        assert.deepEqual([...names].sort(), ["MySpeed-windows-x64-baseline.exe", "MySpeed-windows-x64.exe"],
            "the Windows matrix no longer builds exactly the default and baseline variants");
        assert.equal(new Set(names).size, names.length, "two Windows variants share an asset name");
    });

    it("uploads each variant under the name its own leg carries", () => {
        assert.match(windows, /ASSET_NAME: \$\{\{ matrix\.artifact_name \}\}/,
            "the release asset name is not the matrix's, so both legs publish the same one");
        assert.match(windows, /name: \$\{\{ matrix\.artifact_name \}\}/,
            "the build artifact name is not the matrix's, so the two legs collide");
    });

    /**
     * A green compile says nothing about whether the binary runs - #13's bar was
     * boot-and-serve proof rather than a successful build, and the crash this
     * whole matrix exists for happens at startup, long after the compiler is
     * happy. The gate only gates while it sits in front of the upload: run
     * afterwards, it reports a broken binary that is already a release asset.
     */
    it("proves the binary boots before attaching it to the release", () => {
        const verify = windows.indexOf("verify-binary.ps1");
        const upload = windows.indexOf("Upload to Release");

        assert.notEqual(verify, -1, "the Windows binaries are uploaded without ever having been run");
        assert.notEqual(upload, -1, "the Windows job no longer uploads anything");
        assert.ok(verify < upload, "the binary is uploaded before it is verified, so the check gates nothing");
    });
});
