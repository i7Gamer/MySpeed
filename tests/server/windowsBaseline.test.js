import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKFLOWS = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", ".github", "workflows");

const read = (name) => fs.readFileSync(path.join(WORKFLOWS, name), "utf8");

const binaries = read("build-binaries.yml");
const msi = read("build-msi.yml");

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
const installer = job(msi, "build-msi");

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

/**
 * Windows has no install script picking the right binary the way scripts/
 * install.sh does on Linux, so a user on this hardware who wants the service
 * has to be given a second installer to download. The two are one product
 * carrying a different payload, which is what the identity assertions are
 * about - a second product would be a different bug.
 */
describe("the MSI a release publishes", () => {
    it("builds an installer around each Windows variant", () => {
        const consumed = matrixValues(installer, "artifact");
        const published = matrixValues(windows, "artifact_name");

        assert.equal(consumed.length, 2, "the MSI job no longer has one leg per Windows binary");
        assert.deepEqual([...consumed].sort(), [...published].sort(),
            "the MSI job does not build one installer per Windows binary");
    });

    /**
     * The contract between the two workflows, and the reason it is worth
     * asserting: build-msi names the artifact it downloads as a literal, so
     * renaming a binary in build-binaries breaks a job in a different file, at
     * release time, after every binary has already been uploaded.
     */
    it("downloads artifacts that build-binaries actually publishes", () => {
        assert.match(installer, /name: \$\{\{ matrix\.artifact \}\}/,
            "the MSI job downloads a hardcoded artifact rather than its leg's");

        const published = new Set(matrixValues(windows, "artifact_name"));
        for (const artifact of matrixValues(installer, "artifact"))
            assert.ok(published.has(artifact), `build-binaries never uploads an artifact named ${artifact}`);
    });

    it("gives each installer its own name", () => {
        const names = matrixValues(installer, "asset_name");

        assert.equal(names.length, 2, "the MSI job no longer builds exactly two installers");
        assert.equal(new Set(names).size, names.length,
            "both installers upload under one asset name, so the second upload fails mid-release");
        assert.match(installer, /ASSET_NAME: \$\{\{ matrix\.asset_name \}\}/,
            "the installers are uploaded under a fixed name rather than their leg's");
    });

    /**
     * The two installers deliberately share an UpgradeCode: they are one
     * product, and a distinct code would let both install at once, each
     * registering a service named MySpeed against one ProgramData directory.
     *
     * Sharing it is only half the answer. At the same version WiX's default
     * refuses to treat the other variant as an upgrade, so the user whose
     * service never started downloads the baseline, installs it on top, and
     * ends up with two entries in Add/Remove Programs instead of a working
     * service - which is the exact person this whole change is for.
     */
    it("lets a user swap to the other variant of the same version", () => {
        assert.match(installer, /<MajorUpgrade[^>]*AllowSameVersionUpgrades="yes"/,
            "installing the other variant of the same version leaves both registered");
        assert.equal(installer.match(/UpgradeCode="[^"]+"/g).length, 1,
            "the two installers no longer share one UpgradeCode");
    });

    /**
     * The WiX document is prose-heavy and lives inside a PowerShell here-string
     * inside YAML, where nothing parses it as XML until candle does - at release
     * time, after every binary is uploaded. `--` is the trap that catches: it is
     * illegal inside an XML comment and natural to type in one.
     */
    it("writes XML comments candle can parse", () => {
        for (const [, comment] of installer.matchAll(/<!--([\s\S]*?)-->/g))
            assert.doesNotMatch(comment, /--/,
                `an XML comment contains "--", which candle refuses: ${comment.trim().slice(0, 60)}`);
    });

    /**
     * The MSI is the variant whose failure is silent - it installs cleanly and
     * leaves a service that never starts - so which one is installed has to be
     * answerable without rerunning the installer. Add/Remove Programs shows
     * Product/@Name, and that is the only place it shows.
     */
    it("says which variant is installed", () => {
        const names = matrixValues(installer, "product_name");

        assert.match(installer, /Name="\$\{\{ matrix\.product_name \}\}"/,
            "both installers register under one name, so nothing tells the two apart once installed");
        assert.equal(new Set(names).size, 2, "the two installers no longer carry distinct product names");
    });
});
