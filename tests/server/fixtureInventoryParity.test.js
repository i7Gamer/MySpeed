import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {FIXTURE_MARKER, PROVIDER_BINARIES, PROVIDER_CATALOGUES} from
    "../../scripts/qualification/fixture.mjs";
import {WINDOWS_BASELINE_GUEST_FIXTURE_BUNDLE_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-fixture-bundle.mjs";
import {WINDOWS_BASELINE_GUEST_MATERIALIZER_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-materializer.mjs";
import {POST_RELEASE_BASELINE_INPUT_CONSTANTS} from
    "../../scripts/release/post-release-msi-baseline-input-preparation.mjs";

/*
 * Three consumers hard-code the Windows form of the fixture inventory: the guest bundle builder,
 * the guest materializer, and the MSI baseline input preparation. Nothing held them to what the
 * producer actually emits, so when ost-cli shipped with the OpenSpeedTest provider all three went
 * stale and stayed stale for a year - invisible because the only caller ran an older producer, so
 * the two halves never came from the same commit.
 *
 * Deriving the expectation from the producer's own exported sets is what makes the next addition
 * fail here, in a unit test, rather than inside a virtual machine forty minutes into a run.
 */
const EXPECTED = Object.freeze([
    ...PROVIDER_BINARIES.map(name => `bin/${name}.exe`),
    ...PROVIDER_CATALOGUES.map(name => `data/servers/${name}`)
].sort());
const UNSUFFIXED = Object.freeze([
    ...PROVIDER_BINARIES.map(name => `bin/${name}`),
    ...PROVIDER_CATALOGUES.map(name => `data/servers/${name}`)
].sort());
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.join(HERE, "..", "..");
const PRODUCER = path.join(REPOSITORY, "scripts", "qualification", "fixture.mjs");
const WORKFLOW = path.join(REPOSITORY, ".github", "workflows", "windows-cpu-floor-branch.yml");
const NONCE = "0123456789abcdef0123456789abcdef";

const relativeFiles = root => fs.readdirSync(root, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath ?? entry.path, entry.name))
        .split(path.sep).join("/"))
    .sort();

describe("fixture inventory parity", () => {
    it("every consumer expects exactly what the producer emits", () => {
        for (const [label, actual] of [
            ["guest fixture bundle", WINDOWS_BASELINE_GUEST_FIXTURE_BUNDLE_CONSTANTS.COMMON_FILES],
            /* The materializer exposes the common set as its reset inventory. */
            ["guest materializer", WINDOWS_BASELINE_GUEST_MATERIALIZER_CONSTANTS.RESET_FILES],
            ["MSI baseline inputs", POST_RELEASE_BASELINE_INPUT_CONSTANTS.FIXTURE_COMMON]
        ]) {
            assert.deepEqual([...actual].sort(), EXPECTED, label);
        }
    });

    /*
     * The inventory above is derived from the producer's constants, so it would stay true of a
     * producer that had stopped honouring --platform. This runs the real producer, the way the
     * handoff runs it - as a subprocess, through its CLI - and reads what actually landed on disk.
     *
     * Both platforms are exercised deliberately. Asking for win32 alone proves nothing on a Windows
     * host, because process.platform would produce the same names by accident. Asking for linux on
     * the same host and getting unsuffixed names is what shows the argument, not the host, decides -
     * which is the whole point: the branch workflow seeds this fixture on a Linux runner for a
     * Windows guest.
     */
    it("produces exactly the guest inventory when a foreign host is told to name Windows files", () => {
        for (const [platform, expected] of [["win32", EXPECTED], ["linux", UNSUFFIXED]]) {
            const work = fs.mkdtempSync(path.join(os.tmpdir(), `myspeed-fixture-${platform}-`));
            try {
                /* "static" ignores --repo, but the shared argument parser insists on it. */
                const produced = execFileSync(process.execPath, [PRODUCER, "static",
                    "--repo", REPOSITORY, "--work", work, "--nonce", NONCE, "--platform", platform],
                {encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});
                assert.equal(JSON.parse(produced).nonce, NONCE);
                assert.deepEqual(relativeFiles(work).filter(name => name !== FIXTURE_MARKER),
                    expected, platform);
            } finally {
                fs.rmSync(work, {recursive: true, force: true});
            }
        }
    });

    /*
     * The producer only sees a platform because the handoff hands it one, twice: to the seed
     * subprocess for the populated root and to the in-process call for the reset root. Dropping
     * either would leave a guest inventory half in Windows names and half in Linux ones, and the
     * test above cannot see it - it calls the producer directly. A full handoff needs a seeded
     * database and a repository whose HEAD matches, which is a virtual machine's worth of work for
     * one argument, so this holds the two call sites instead.
     */
    it("hands the platform to both halves of the handoff, and the workflow asks for Windows", () => {
        const source = fs.readFileSync(PRODUCER, "utf8");
        assert.match(source, /fixtureScript, "seed",[^)]*"--platform", platform/su);
        assert.match(source, /prepareStaticFixtures\(\{work: resetRoot, nonce: resetNonce, platform\}\)/u);
        assert.match(fs.readFileSync(WORKFLOW, "utf8"),
            /fixture\.mjs handoff [^\n]*--platform win32/u);
    });
});
