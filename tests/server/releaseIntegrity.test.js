import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * What stands between a release and the machine that installs it.
 *
 * The project pins the SHA-256 of every provider CLI it downloads and refuses
 * one that does not match, and says in binaries.js why. Its own artifacts had
 * nothing: install.sh fetched a binary over TLS, checked that the file was not
 * empty, made it executable and handed it to a unit with Restart=always, and a
 * person downloading the same file by hand had nothing to compare it against.
 *
 * Read as text rather than run. These are release-time steps on runners this
 * suite has no access to - a Windows host with chocolatey, an uploader holding
 * a release id - and the alternative to reading them is not testing them.
 */
const root = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

const read = (file) => fs.readFileSync(path.join(root, file), "utf8");

// Comments describe the intent; they are not the thing being asserted, and a
// requirement satisfied only by a comment that mentions it is not satisfied.
const withoutComments = (source) => source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");

/**
 * Where `anchor` is, and a failure naming it when it is nowhere.
 *
 * Every section in this file used to be cut with a bare
 * `slice(indexOf(anchor))`, and the floors under those - written
 * as `assert.notEqual(section, "")` - could not fire: `indexOf` answers -1 for
 * an anchor that is gone, and `slice(-1)` is the last character of the file
 * rather than the empty string. So a deleted job or a renamed step failed on
 * whichever `assert.match` came next, with a message about the wrong thing, or
 * passed outright where the comparison was between two indexes.
 */
const at = (source, anchor) => {
    const found = source.indexOf(anchor);

    assert.notEqual(found, -1, `${anchor.trim()} is not in this file any more`);
    return found;
};

/**
 * One job of a workflow, from its name to the next name at that indent.
 *
 * `from()` alone runs to the end of the file, and the job after this one
 * prints the same recovery command - so an assertion that the *cancelled*
 * report names it was satisfied by the *partial* report two jobs down, and
 * deleting the line it exists to protect left the suite green.
 */
const jobIn = (workflow, name) => {
    const block = workflow.slice(at(workflow, `\n  ${name}:`) + 1);
    const next = block.search(/\n {2}[\w-]+:/);

    return next === -1 ? block : block.slice(0, next);
};

/**
 * One step of a job, from its name to the next step at that indent.
 *
 * `from()` for the same reason `jobIn` exists: a step's script is a handful of
 * lines in a file of eighty, and an anchor that runs to the end of the file is
 * satisfied by whatever a later step happens to say.
 */
const stepIn = (workflow, name) => {
    const block = workflow.slice(at(workflow, `      - name: ${name}`));
    const next = block.slice(1).search(/\n {6}- name:/);

    return next === -1 ? block : block.slice(0, next + 1);
};

/** The same file from `anchor` onwards, or a failure that says it is gone. */
const from = (source, anchor) => source.slice(at(source, anchor));

describe("the release publishes what a download can be checked against", () => {
    const workflow = read(".github/workflows/build-binaries.yml");

    it("hashes the assets after every job that uploads one", () => {
        const checksums = from(workflow, "\n  checksums:");

        assert.match(checksums, /needs: \[build-windows, build-linux, build-macos, build-zip\]/,
            "SHA256SUMS can be written before an asset it is supposed to cover exists");
        assert.match(checksums, /listReleaseAssets/,
            "the sums are taken from something other than the published assets");
        assert.match(checksums, /createHash\('sha256'\)/);
        assert.match(checksums, /name: 'SHA256SUMS'/);
    });

    // The documented install command fetches these from the release, so the
    // release has to carry them.
    it("uploads the install scripts it tells people to run", () => {
        const checksums = from(workflow, "\n  checksums:");

        for (const script of ["install.sh", "docker-install.sh", "chooser.sh"])
            assert.ok(checksums.includes(`'${script}'`), `${script} is not published with the release`);
    });

    /**
     * The archive is advertised as "requires Bun runtime", and `bun install`
     * without a lockfile re-resolves every range: two people unpacking one
     * release get different builds of express and sequelize, neither of them
     * the pair that was tested. The repository already argues this for itself
     * in .dockerignore.
     */
    it("ships the source archive with the lockfile it was built against", () => {
        assert.match(workflow, /zip -r MySpeed\.zip[^\n]*\bbun\.lock\b/,
            "the ZIP release asset leaves its dependencies to be re-resolved");
    });
});

describe("install.sh verifies what it downloaded", () => {
    const source = withoutComments(read("scripts/install.sh"));

    it("asks the release for its checksum list", () => {
        assert.match(source, /release_asset_url "SHA256SUMS"/);
    });

    it("hashes the file it is about to install", () => {
        assert.match(source, /sha256sum|shasum -a 256|openssl dgst -sha256/,
            "nothing computes a digest, so nothing can compare one");
        assert.match(source, /sha256_of "\$DOWNLOAD_TMP"/);
    });

    /**
     * The download is removed and the script stops. Leaving it in place and
     * carrying on is the failure this whole path exists to prevent: the binary
     * is about to be chmod 755'd, moved over the installed one and started as
     * root under Restart=always.
     */
    it("refuses a binary that does not match, and leaves the install alone", () => {
        const mismatch = from(source, '"$EXPECTED" != "$ACTUAL"');

        assert.match(mismatch.slice(0, 400), /rm -f "\$DOWNLOAD_TMP"/,
            "the unverified download is left on disk");
        assert.match(mismatch.slice(0, 400), /exit 1/,
            "a mismatched binary carries on to the service and the success banner");
    });

    // A release cut before SHA256SUMS existed carries none, and refusing to
    // install a version that was published without one helps nobody. It has to
    // say so rather than pass silently.
    it("says so when the release publishes no checksums", () => {
        const absent = from(source, 'if [ -z "$CHECKSUM_URL" ]');

        assert.match(absent.slice(0, 300), /Warning/,
            "an unverifiable download is accepted with nothing said");
    });

    // Verified before it is stated executable and moved into place, not after.
    // Anchored on the call, not the name: the first "sha256_of" in the file is
    // the function's own definition, which sits above the install by
    // construction, so the block that verifies could move below the move and
    // this still held.
    it("checks before it installs", () => {
        assert.ok(at(source, 'ACTUAL=$(sha256_of "$DOWNLOAD_TMP")') < at(source, 'mv -f "$DOWNLOAD_TMP" myspeed'),
            "the binary is installed and then checked");
    });
});

/**
 * chooser.sh fetches an installer from the latest release and runs it. Piped
 * straight into bash from a curl with no --fail, an HTTP error body - a
 * release with no such asset, GitHub answering 5xx - was handed to bash as a
 * program, as root, and reported as a page of syntax errors rather than as
 * the download it was.
 */
describe("chooser.sh checks the download before it runs it", () => {
    const chooser = withoutComments(read("scripts/chooser.sh"));

    it("does not pipe an unchecked response into bash", () => {
        assert.doesNotMatch(chooser, /bash <\(curl/, "an HTTP error body is executed as a script");
    });

    it("refuses an HTTP error and says so", () => {
        assert.match(chooser, /curl -fsSL|curl -sSfL|curl --fail/, "curl does not fail on an HTTP error");
        assert.match(chooser, /could not download|download failed/i, "a failed download is not reported");
    });
});

/**
 * The baseline build the README tells pre-AVX2 users to run writes
 * MySpeed-linux-x64-baseline beside MySpeed, and only the latter was ignored:
 * a hundred megabytes offered to `git add .`.
 */
describe("the build outputs are ignored", () => {
    const ignored = read(".gitignore").split(/\r?\n/);

    it("covers every binary the matrix can produce", () => {
        assert.ok(ignored.includes("/MySpeed-*"), "the baseline binary and the source zip are not ignored");
    });
});

describe("install.sh reports a service that did not come up", () => {
    const source = withoutComments(read("scripts/install.sh"));

    /**
     * `systemctl restart` returns when systemd has taken the job, not when the
     * service is running - so a unit that fails to start reached the completion
     * banner and exited 0, which a pipeline reads as a successful upgrade.
     */
    it("asks whether the service is actually running", () => {
        const afterRestart = from(source, "systemctl restart myspeed");

        assert.match(afterRestart, /systemctl is-active/,
            "the one step in this script whose failure is never checked");
        assert.match(afterRestart.slice(0, 900), /journalctl -u myspeed/,
            "the operator is told it failed but not where to look");
    });

    // The hint used to be gated on a directory that always exists by then, so
    // it was printed on the non-systemd host that had just been told to start
    // MySpeed by hand.
    it("offers the restart command only where there is a service to restart", () => {
        assert.match(source, /if command -v systemctl[^\n]*\n\s*echo[^\n]*systemctl restart myspeed/,
            "the systemd hint is printed on hosts that have no systemd");
    });
});

describe("docker-install.sh can be run twice", () => {
    const source = withoutComments(read("scripts/docker-install.sh"));

    /**
     * The compose file was truncated on every run, so the documented way to
     * upgrade threw away whatever the operator had added to it - including the
     * `network_mode: host` the README tells Linux users to add to measure their
     * real line speed.
     */
    it("keeps an existing compose file rather than writing over it", () => {
        assert.match(source, /if \[ -f "\$INSTALLATION_PATH\/docker-compose\.yml" \]/,
            "a re-run silently discards the operator's own compose edits");
    });

    /**
     * `up -d` fetches an image only when there is none locally and the
     * reference carries no tag, so on a host that had run MySpeed before this
     * upgraded nothing while printing that the container had started.
     */
    it("pulls before it starts", () => {
        const pull = at(source, "docker compose pull");
        const up = at(source, "docker compose up -d");

        assert.ok(pull < up, "the image is pulled after the container is started");
    });
});

describe("uninstall.sh says what it could not remove", () => {
    const source = withoutComments(read("scripts/uninstall.sh"));

    /**
     * The volume name is the one docker-install.sh's compose file produces.
     * Every other install shape names its volume something else, so the removal
     * failed and its status was discarded - and the operator reached "MySpeed
     * has been uninstalled" with the database, the password hash and every
     * integration secret still on the host.
     */
    it("checks whether the data volume was really removed", () => {
        assert.match(source, /(if ! docker volume rm|docker volume rm[^\n]*\|\|)/,
            "a volume that could not be removed is reported as removed");

        const removal = from(source, "docker volume rm");

        assert.match(removal.slice(0, 600), /docker volume ls/,
            "nothing tells the operator how to find what was left behind");
    });
});

describe("the MSI is built from things that are pinned", () => {
    const workflow = read(".github/workflows/build-msi.yml");

    /**
     * WinSW is installed as a LocalSystem service by every Windows install, and
     * it is fetched from a URL in a run block - which dependabot cannot see, so
     * nothing but this would notice the file at that address changing.
     */
    it("verifies the service wrapper against a digest", () => {
        assert.match(workflow, /WINSW_SHA256: "[0-9a-f]{64}"/,
            "the service wrapper is installed unverified");
        assert.match(workflow, /Get-FileHash[^\n]*SHA256/);
        assert.match(workflow, /-ne \$env:WINSW_SHA256[\s\S]{0,200}exit 1/,
            "the digest is computed and then not acted on");
    });

    /**
     * The package used to be whatever the feed served and the path was asserted
     * to be v3.11. The same package ships 3.14, which installs beside a
     * differently named directory: candle would not be on PATH, build-msi would
     * fail, and the release would stop with the tag cut and the version bumped.
     */
    it("pins the toolset and finds its bin directory rather than assuming one", () => {
        assert.match(workflow, /choco install wixtoolset -y --version=\d+\.\d+/,
            "the WiX version is whatever the feed serves that day");
        assert.doesNotMatch(workflow, /echo "C:\\Program Files \(x86\)\\WiX Toolset v3\.11\\bin"/,
            "the bin directory is asserted rather than discovered");
        assert.match(workflow, /Get-ChildItem "C:\\Program Files \(x86\)\\WiX Toolset v\*/);
    });

    /**
     * And the pin cannot be the thing that fails the step. The runner image
     * ships 3.14 now, so asking for 3.11.2 is a downgrade and chocolatey
     * refuses one: it exits 1 saying a newer version is already installed,
     * while the toolset sits exactly where the discovery below finds it. 1.5.2
     * stopped there with the tag cut, the version bumped, no MSI and no Docker
     * tag published - on a step that had already printed the path it wanted.
     *
     * The discovery is the gate, and it exits 1 itself when no bin directory
     * exists. What chocolatey did with a request the image had already
     * satisfied is not the step's verdict.
     */
    it("survives a chocolatey that will not install over what the image ships", () => {
        const step = stepIn(workflow, "Install WiX Toolset");

        assert.match(step, /\$LASTEXITCODE -ne 0/,
            "chocolatey's exit code is the step's, so a refused downgrade stops the release");
        assert.match(step, /LASTEXITCODE = 0/,
            "the refusal is reported and then still handed back as the step's status");
        assert.match(step, /-not \$bin[\s\S]{0,200}exit 1/,
            "nothing fails the step when the toolset really is missing");
    });
});

describe("two releases cannot run over each other", () => {
    const release = read(".github/workflows/create_release.yml");
    const deploy = read(".github/workflows/deploy_docker_dev.yml");

    /**
     * Both workflows move :latest, and the release also bumps package.json and
     * pushes to the default branch - so two runs side by side decide the tag by
     * whichever finishes last, and the second push can be rejected after its own
     * tag guard has already passed.
     */
    it("holds the release and the manual deploy in one group", () => {
        for (const [name, source] of [["create_release", release], ["deploy_docker_dev", deploy]]) {
            assert.match(source, /^concurrency:\n {2}group: release-and-registry\n {2}cancel-in-progress: false$/m,
                `${name} can run beside the other one`);
        }
    });

    /**
     * cleanup-on-failure and report-partial-release both key on failure(),
     * which a cancellation does not satisfy - so a run stopped after the tag was
     * cut left a tag, a draft and a version bump with nothing said, and the next
     * dispatch of that version was refused with no explanation.
     */
    it("says what a cancelled run left behind", () => {
        const job = jobIn(release, "report-cancelled-release");

        assert.match(job, /if: cancelled\(\) && needs\.create-release\.result == 'success'/);
        assert.match(job, /gh release delete v\$VERSION --cleanup-tag/,
            "the recovery command the other report prints is missing from this one");
    });
});
