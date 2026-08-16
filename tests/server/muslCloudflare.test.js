import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMuslLinux } from "../../server/util/providers/libc.js";
import { selectBinary } from "../../server/util/providers/loadCloudflare.js";
import { missingBinaryMessage } from "../../server/util/speedtest.js";
import { cloudflareVersion } from "../../server/config/binaries.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const existsIn = (...paths) => (candidate) => paths.includes(candidate);

/**
 * Alpine reports itself as linux/x64 like any other Linux, so the platform pair
 * the download list is keyed on cannot tell the two libcs apart. The loader
 * needs the distinction because every Cloudflare CLI release is glibc-linked.
 */
describe("recognising a musl system", () => {
    it("sees musl by its dynamic loader", () => {
        assert.equal(isMuslLinux("linux", existsIn("/lib/ld-musl-x86_64.so.1")), true);
        assert.equal(isMuslLinux("linux", existsIn("/lib/ld-musl-aarch64.so.1")), true);
    });

    it("does not mistake a glibc system for musl", () => {
        assert.equal(isMuslLinux("linux", existsIn("/lib64/ld-linux-x86-64.so.2")), false);
    });

    /**
     * Debian and Ubuntu package musl for cross-compiling, and its loader lands
     * at /usr/lib/ld-musl-x86_64.so.1 - which /lib/ld-musl-x86_64.so.1 resolves
     * to on every merged-/usr system. A glibc machine with that package
     * installed therefore looks exactly like Alpine to a bare presence check,
     * and the Cloudflare provider was refused on a host where the published
     * glibc build runs perfectly. The glibc loader sitting beside it is what
     * settles the question: Alpine has no such file.
     */
    it("does not call a glibc system musl just because musl is installed too", () => {
        assert.equal(isMuslLinux("linux", existsIn(
            "/lib/ld-musl-x86_64.so.1", "/lib64/ld-linux-x86-64.so.2")), false);
        assert.equal(isMuslLinux("linux", existsIn(
            "/lib/ld-musl-aarch64.so.1", "/lib/ld-linux-aarch64.so.1")), false);
    });

    it("is only a Linux question", () => {
        assert.equal(isMuslLinux("darwin", () => true), false);
        assert.equal(isMuslLinux("win32", () => true), false);
    });
});

/**
 * code-inflation/cfspeedtest publishes `x86_64-unknown-linux-gnu` and no musl
 * build. Downloading it onto Alpine produced a binary the kernel refuses to
 * exec - `ENOENT: posix_spawn './bin/cfspeedtest'`, which reads as a missing
 * file rather than a missing interpreter - and every scheduled test then
 * recorded a failure with nothing naming the cause. Saying so at selection time
 * is the difference between a diagnosable error and a silent loop of failures.
 */
describe("choosing the Cloudflare CLI to download", () => {
    it("refuses to fetch a glibc build for a musl system", () => {
        assert.throws(() => selectBinary({platform: "linux", arch: "x64", musl: true}), /musl/i);
        assert.throws(() => selectBinary({platform: "linux", arch: "x64", musl: true}), /glibc/i);
    });

    it("still serves glibc Linux the published build", () => {
        assert.equal(selectBinary({platform: "linux", arch: "x64", musl: false}).suffix,
            "cfspeedtest-x86_64-unknown-linux-gnu.tar.gz");
    });

    it("still serves glibc Linux on arm64, which the image also builds for", () => {
        assert.equal(selectBinary({platform: "linux", arch: "arm64", musl: false}).suffix,
            "cfspeedtest-aarch64-unknown-linux-gnu.tar.gz");
    });

    it("keeps falling back to the universal macOS archive", () => {
        assert.equal(selectBinary({platform: "darwin", arch: "x64", musl: false}).suffix,
            "cfspeedtest-x86_64-apple-darwin.tar.gz");
        assert.equal(selectBinary({platform: "darwin", arch: "ppc", musl: false}).suffix,
            "cfspeedtest-universal-apple-darwin.tar.gz");
    });

    it("names the platform it cannot serve", () => {
        assert.throws(() => selectBinary({platform: "freebsd", arch: "x64", musl: false}), /freebsd-x64/);
    });
});

/**
 * The image is Alpine-based, so the refusal above would leave the Cloudflare
 * provider permanently unusable in Docker - which is where most installs run.
 * Compiling the same crate version against musl during the build puts a working
 * binary where the loader looks, and `fileExists` then skips the download
 * entirely.
 */
describe("the image ships a musl Cloudflare CLI", () => {
    const dockerfile = fs.readFileSync(path.join(ROOT, "Dockerfile"), "utf8");

    it("builds the CLI from source rather than downloading a glibc one", () => {
        assert.match(dockerfile, /cargo install .*cfspeedtest/);
    });

    it("compiles the version the loader would otherwise fetch", () => {
        assert.match(dockerfile, new RegExp(`ARG CFSPEEDTEST_VERSION=${cloudflareVersion.replace(/\./g, "\\.")}\\b`));
        assert.match(dockerfile, /cargo install .*--version \$\{CFSPEEDTEST_VERSION\}/);
    });

    it("puts it where the loader looks for it", () => {
        assert.match(dockerfile, /COPY --from=cfspeedtest-build .*\/myspeed\/bin\/cfspeedtest/);
    });
});

/**
 * Saying it once at boot is not saying it. loadCli reports a provider it could
 * not prepare to the log and carries on - deliberately, so one unreachable
 * download cannot stop the server - and the run path then spawns
 * ./bin/cfspeedtest directly. Every scheduled test therefore went on recording
 * `ENOENT: posix_spawn './bin/cfspeedtest'`, which is the same opaque failure
 * the refusal above exists to replace, in the one place a user actually reads.
 */
describe("the failure a run records when the CLI is not there", () => {
    const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    it("explains a missing Cloudflare CLI on a musl system", () => {
        const message = missingBinaryMessage("cloudflare", "./bin/cfspeedtest", "ENOENT", true);

        assert.match(message, /musl/i);
        assert.match(message, /glibc/i);
        assert.match(message, /cfspeedtest/);
    });

    it("still names the binary when musl is not the reason", () => {
        for (const [mode, binary] of [["ookla", "./bin/speedtest"],
            ["libre", "./bin/librespeed-cli"], ["cloudflare", "./bin/cfspeedtest"]]) {

            const message = missingBinaryMessage(mode, binary, "ENOENT", false);

            assert.match(message, new RegExp(escape(binary)));
            assert.doesNotMatch(message, /musl/i, `${mode} blamed musl on a glibc system`);
        }
    });

    // A CLI that is present but unrunnable, or a spawn that failed for any other
    // reason, still has its own error - which says more than this could.
    it("leaves every other spawn failure alone", () => {
        assert.equal(missingBinaryMessage("cloudflare", "./bin/cfspeedtest", "EACCES", true), null);
        assert.equal(missingBinaryMessage("cloudflare", "./bin/cfspeedtest", undefined, true), null);
    });
});
