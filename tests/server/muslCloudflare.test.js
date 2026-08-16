import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isMuslLinux } from "../../server/util/providers/libc.js";
import { selectBinary } from "../../server/util/providers/loadCloudflare.js";
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
