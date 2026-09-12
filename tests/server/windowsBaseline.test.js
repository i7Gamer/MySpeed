import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readSource } from "../helpers/source.js";

const WORKFLOWS = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", ".github", "workflows");

const read = (name) => fs.readFileSync(path.join(WORKFLOWS, name), "utf8");

const binaries = read("build-binaries.yml");
const msi = read("build-msi.yml");
const releaseManifest = readSource('scripts/release/qualification-manifest.mjs');

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
 * Bun 1.4 removed the Haswell-only x64 build. Both default and baseline target
 * names now select the Nehalem/SSE4.2 runtime, with newer AVX instructions
 * dispatched at runtime. Keep both names for existing download and MSI URLs.
 */
describe("the Windows binaries a release publishes", () => {
    it("retains the baseline compatibility name", () => {
        assert.match(windows, /artifact_name: *MySpeed-windows-x64-baseline\.exe\b/,
            "the Windows baseline compatibility asset disappeared");
    });

    it("uses the unified native compiler target for both compatibility names", () => {
        assert.deepEqual(matrixValues(windows, "target"), ['bun-windows-x64', 'bun-windows-x64']);
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
        for (const name of matrixValues(windows, "artifact_name"))
            assert.ok(releaseManifest.includes("['" + name + "', 'MySpeed.exe', '" + name + "']"),
                "the immutable manifest does not map this variant to its own release asset");
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
        const upload = windows.indexOf("Upload artifact for MSI");

        assert.notEqual(verify, -1, "the Windows binaries are uploaded without ever having been run");
        assert.notEqual(upload, -1, "the Windows job no longer uploads anything");
        assert.ok(verify < upload, "the binary is uploaded before it is verified, so the check gates nothing");
    });
});

/** Both compatibility names use Bun 1.4.2's already-installed native runtime. */
describe("compiling the Windows binaries", () => {
    const stepNamed = (name) => {
        const start = windows.indexOf(`- name: ${name}`);
        assert.notEqual(start, -1, `the Windows job no longer has a "${name}" step`);

        const next = windows.indexOf("\n      - name: ", start + 1);
        return next === -1 ? windows.slice(start) : windows.slice(start, next);
    };

    // Looked up inside each test rather than once above them: resolved here,
    // a missing step fails the whole block with one message and the assertions
    // below never report at all.
    const compileStep = () => stepNamed("Compile binary");

    it("still compiles the leg's own target", () => {
        assert.match(compileStep(), /--target=\$\{\{ matrix\.target \}\}/,
            "the compile no longer targets the matrix leg, so both legs build the same binary");
    });

    /**
     * The exe's version resource is what Windows Installer compares an upgrade
     * against, and Bun stamps its own version there unless told otherwise:
     * v1.5.2 shipped as 1.4.0.0 and v1.5.3 as 1.3.14.0, so the upgrade kept
     * the "newer" file on disk, the major upgrade then removed it with the old
     * product, and the service was started into a missing MySpeed.exe. Four
     * parts, the run number last, so a rebuild of one version is newer too -
     * an equal version is refused the same way a higher one is.
     */
    it("stamps the exe with the frozen MySpeed qualification version", () => {
        assert.match(compileStep(), /--windows-version="\$env:WINDOWS_STAMP"/,
            "the exe carries Bun's version resource, which an upgrade compares against and may find newer");
        assert.match(compileStep(), /WINDOWS_STAMP: \$\{\{ inputs\.windows_stamp \}\}/,
            "the stamp is not the exact four-part qualification input");
    });

    it("does not download a redundant per-target runtime", () => {
        assert.doesNotMatch(windows, /Fetch a Bun matching the target|target-bun\.zip|TARGET_BUN/);
    });

    it("compiles using the already pinned native Bun", () => {
        assert.match(compileStep(), /^\s*bun (?:build|scripts\/build-binary\.mjs)/m);
    });

    it("propagates the compiler's failure", () => {
        assert.match(compileStep(), /\$LASTEXITCODE -ne 0/);
        assert.match(compileStep(), /throw/);
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
        assert.match(installer, /name: release-msi-\$\{\{ matrix\.asset_name \}\}/,
            "the installers are uploaded under a fixed name rather than their leg's");
        for (const name of names)
            assert.ok(releaseManifest.includes("'release-msi-" + name + "', 'MySpeed-installer.msi', '" + name + "'"));
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
     * WiX otherwise schedules RemoveExistingProducts before InstallInitialize.
     * A later failure then leaves neither product installed because removal sat
     * outside the transaction Windows Installer can roll back.
     */
    it("removes the predecessor inside the upgrade transaction", () => {
        assert.match(installer, /<MajorUpgrade[^>]*Schedule="afterInstallInitialize"/,
            "a failed major upgrade cannot roll the predecessor back");
        assert.match(installer, /<ServiceControl[^>]*Start="install"[^>]*Stop="both"[^>]*Remove="uninstall"/,
            "transactional removal no longer stops and restores the managed service");
        assert.match(installer, /<Custom Action="MigrateLegacyData" Before="StartServices">NOT Installed<\/Custom>/,
            "legacy data migration no longer completes before the replacement service starts");
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

        // Read through the environment rather than spliced from `${{ matrix
        // .product_name }}`: no workflow expression reaches a script body
        // anywhere in the release chain now, which binaryVerification.test.js
        // holds the whole chain to. What it names is unchanged.
        assert.match(installer, /Name="\$\(\$env:PRODUCT_NAME\)"/,
            "both installers register under one name, so nothing tells the two apart once installed");
        assert.equal(new Set(names).size, 2, "the two installers no longer carry distinct product names");
    });
});

/** Bun 1.4.2 is the verified unified-baseline runtime for release artifacts. */
describe("the unified x64 runtime contract", () => {
    const BUN_RUNTIME_VERSION = "1.4.2";

    it("compiles with a pinned Bun rather than whatever is latest", () => {
        assert.doesNotMatch(binaries, /bun-version:\s*latest/,
            "the release inherits whatever Bun ships that day");
        assert.match(binaries, new RegExp(`bun-version:\\s*"?${BUN_RUNTIME_VERSION.replaceAll(".", "\\.")}"?`),
            "the release does not use the verified unified-baseline Bun");
    });

    it("allows only the exact same-platform compatibility digest pairs", () => {
        const aliases = /const ALLOWED_DUPLICATES = \[([\s\S]*?)\n];/.exec(releaseManifest)?.[1];
        assert.ok(aliases, "the manifest no longer declares its narrow alias policy");
        const pairs = [...aliases.matchAll(/new Set\(\[([^\]]+)\]\)/g)]
            .map(([, names]) => [...names.matchAll(/'([^']+)'/g)].map(([, name]) => name));
        assert.deepEqual(pairs, [
            ["MySpeed-linux-x64", "MySpeed-linux-x64-baseline"],
            ["MySpeed-windows-x64.exe", "MySpeed-windows-x64-baseline.exe"]
        ]);
    });

    it("executes both Linux x64 artifacts with a Nehalem CPU before upload", () => {
        const linux = job(binaries, "build-linux");
        const verify = linux.indexOf("qemu-x86_64 -cpu Nehalem");
        const upload = linux.indexOf("Upload verified build");

        assert.notEqual(verify, -1, "the unified x64 runtime is never executed without AVX or AVX2");
        assert.ok(verify < upload, "the Nehalem execution check runs after the artifact is uploaded");
        assert.match(linux, /startsWith\(matrix\.target, 'bun-linux-x64'\)/,
            "the Nehalem check does not cover both x64 compatibility names");
        assert.match(linux, /unshare --net/,
            "the CPU probe can contact production services while loading the candidate");
        assert.match(linux, /mktemp -d/, "the CPU probe reuses persistent application data");
        for (const provider of ["ookla", "librespeed"])
            assert.match(linux, new RegExp(`data/servers/${provider}\\.json`),
                `${provider} discovery is not disabled before the network-isolated probe`);
        assert.match(linux, /--reset-password/,
            "the CPU probe starts the supervisor and opens a listener instead of taking the bounded command path");
        assert.match(linux, /RESET_NOTHING_TO_DO_EXIT:\s*113/,
            "the CPU probe does not assert that the application reached its expected exit path");
    });
});

/** The image and compiled artifacts must ship the same verified Bun runtime. */
describe("the container runs on the pinned Bun", () => {
    const dockerfile = readSource("Dockerfile");
    const pinned = binaries.match(/bun-version:\s*"?(\d+\.\d+\.\d+)"?/)?.[1];
    const stages = [...dockerfile.matchAll(/^FROM oven\/bun:(\S+)/gm)].map((match) => match[1]);

    // The client build, the server install and the runtime - three stages that
    // run Bun, so an image tag that drifts in one of them is still caught.
    const BUN_STAGES = 3;

    it("has a pin to follow", () => {
        assert.notEqual(pinned, undefined, "the binaries no longer pin a Bun version to hold the image to");
    });

    it("names the Bun image in every stage that runs it", () => {
        assert.equal(stages.length, BUN_STAGES, "a stage stopped using the Bun image, or one was added");
    });

    it("pins every stage to the binaries' Bun", () => {
        for (const tag of stages)
            assert.equal(tag, `${pinned}-alpine`,
                `oven/bun:${tag} does not match the binaries' Bun ${pinned}`);
    });
});
