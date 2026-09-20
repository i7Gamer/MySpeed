import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {describe, it} from "node:test";
import {fileURLToPath} from "node:url";

import {createHandoffFixture} from "../../scripts/qualification/fixture.mjs";
import {buildWindowsBaselineGuestFixtureBundle, WINDOWS_BASELINE_GUEST_FIXTURE_BUNDLE_CONSTANTS} from
    "../../scripts/qualification/windows-baseline-guest-fixture-bundle.mjs";

/*
 * The one test that runs the real producer and the real consumer against each other.
 *
 * Everything else at this boundary builds one side by hand: the bundle builder's own suite writes
 * its trees from a literal inventory, and the parity suite derives its expectation from the
 * producer's exported constants. Both stay green if each half agrees with the test and disagrees
 * with the other, which is how the ost-cli drift survived a year - the only caller that ran both
 * halves ran them from different commits.
 *
 * So this composes them for real: seed a populated and a reset tree from this checkout, then hand
 * the producer's own manifest and roots to the consumer untouched. The consumer validates the
 * inventory, the tree shape and every hash itself, so reaching a bundle at all is most of the
 * proof; the assertions below pin the parts a caller would notice.
 *
 * One thing it cannot prove, and does not claim: that the producer honoured the platform argument
 * rather than reading the host's. On a Windows host those agree, so dropping --platform from the
 * seed subprocess leaves this suite green - verified by mutation. fixtureInventoryParity.test.js
 * runs the producer for win32 and linux precisely to tell those two apart; this one proves the
 * composition, that one proves the argument.
 *
 * It stops at the bundle rather than going on to the guest materializer. That needs a full guest
 * request and execution with candidate bytes and a database observer, none of which the producer
 * supplies - building them here would put a hand-made side back into the test and duplicate
 * windowsBaselineGuestFixtureBundle.test.js, which already covers that half properly.
 *
 * It is deliberately not in the branch workflow's seal battery. Seeding imports the server's
 * database config, which needs the generated migration and integration registries, and the seal job
 * installs with --ignore-scripts and never generates them. The bundle job does generate them, and
 * performs this same handoff for real.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY = path.resolve(HERE, "..", "..");
const GUEST_PLATFORM = "win32";
const EXPECTED_BINARIES = 5;
const {BUNDLE_KIND, MARKER_NAME} = WINDOWS_BASELINE_GUEST_FIXTURE_BUNDLE_CONSTANTS;
const TRANSIENT_SHARED_MEMORY = "data/storage.db-shm";

const headCommit = () => execFileSync("git", ["rev-parse", "HEAD"],
    {cwd: REPOSITORY, encoding: "utf8"}).trim();

const relativeFiles = root => fs.readdirSync(root, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath ?? entry.path, entry.name))
        .split(path.sep).join("/"))
    .filter(name => name !== MARKER_NAME)
    .sort();

describe("fixture handoff to guest bundle", () => {
    it("seeds trees the guest fixture bundle accepts unchanged", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-handoff-"));
        try {
            const work = path.join(root, "populated");
            const resetWork = path.join(root, "reset");
            const manifest = path.join(root, "transport.json");
            const sourceSha = headCommit();
            /* The producer requires both work directories to exist and be empty, as the bundle job does. */
            for (const directory of [work, resetWork]) fs.mkdirSync(directory);

            const handoff = await createHandoffFixture({repo: REPOSITORY, work, resetWork, manifest,
                sourceSha, platform: GUEST_PLATFORM});
            assert.equal(handoff.source.commit, sourceSha);

            /*
             * The producer names the guest's files, so a Linux runner has to emit .exe. Reading the
             * produced tree rather than a list the test wrote is the whole point of this suite.
             */
            const binaries = fs.readdirSync(path.join(work, "bin"));
            assert.equal(binaries.length, EXPECTED_BINARIES);
            for (const name of binaries) assert.match(name, /\.exe$/u, name);

            /*
             * The consumer takes the manifest as a measured identity, not a path, so the caller has
             * to hash what the producer wrote - the same step the hosted inputs perform. The roots
             * and the manifest contents themselves are passed through untouched.
             */
            const manifestBytes = fs.readFileSync(manifest);
            const bundle = JSON.parse(Buffer.from(buildWindowsBaselineGuestFixtureBundle({
                manifest: {path: manifest, bytes: String(manifestBytes.length),
                    sha256: crypto.createHash("sha256").update(manifestBytes).digest("hex")},
                populatedRoot: work, resetRoot: resetWork, sourceSha})).toString("utf8"));
            assert.equal(bundle.kind, BUNDLE_KIND);
            assert.equal(bundle.sourceSha, sourceSha);

            /*
             * What the guest unpacks has to be what the producer wrote, less the two files that
             * deliberately do not travel: the ownership marker, which the guest mints for itself,
             * and SQLite shared memory, which is meaningless outside the process that mapped it.
             */
            for (const [half, directory] of [["populated", work], ["reset", resetWork]]) {
                assert.deepEqual(bundle[half].files.map(entry => entry.path),
                    relativeFiles(directory).filter(name => name !== TRANSIENT_SHARED_MEMORY), half);
            }
            const populated = bundle.populated.files.map(entry => entry.path);
            assert.ok(populated.includes("data/storage.db"), "the guest needs the seeded database");
            assert.ok(!bundle.reset.files.some(entry => entry.path === "data/storage.db"),
                "the reset half must carry no database");
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });
});
