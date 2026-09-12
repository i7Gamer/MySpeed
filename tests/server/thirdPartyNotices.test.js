import {describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {
    parseBunLock,
    formatThirdPartyNotices,
    generateThirdPartyNotices,
} from "../../scripts/generate-third-party-notices.mjs";

const VERSION = "0.10.0";
const PACKAGE_LICENSE = "HarfBuzz package license text";
const APACHE_LICENSE = "Apache License Version 2.0 text";
const EXTRACTOR_LICENSE = "Copyright (c) Kevin Mårtensson extractor license text";
const SCOPED_PACKAGES = {
    "@xhmikosr/decompress": "11.1.4",
    "@xhmikosr/decompress-targz": "9.0.1",
    "@xhmikosr/decompress-unzip": "8.2.1",
    "@xhmikosr/decompress-tar": "9.0.2",
    "@xhmikosr/decompress-tarbz2": "9.0.2",
};
const PROJECT_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CURRENT_PACKAGE = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8"));
const CURRENT_LOCK = fs.readFileSync(path.join(PROJECT_ROOT, "bun.lock"), "utf8");
const LOCK_METADATA_INDEX = 2;
const UPSTREAM_LICENSES = [
    ["text-codec-0.2.2.txt", "@borewit/text-codec", "LICENSE.txt"],
    ["readable-stream-0.4.1.txt", "@sec-ant/readable-stream", "LICENSE"],
    ["tokenizer-inflate-0.4.1.txt", "@tokenizer/inflate", "LICENSE"],
    ["decompress-11.1.4.txt", "@xhmikosr/decompress", "license"],
    ["decompress-tar-9.0.2.txt", "@xhmikosr/decompress-tar", "license"],
    ["decompress-tarbz2-9.0.2.txt", "@xhmikosr/decompress-tarbz2", "license"],
    ["decompress-targz-9.0.1.txt", "@xhmikosr/decompress-targz", "license"],
    ["decompress-unzip-8.2.1.txt", "@xhmikosr/decompress-unzip", "license"],
    ["Apache-2.0.txt", "b4a", "LICENSE"],
    ["Apache-2.0.txt", "bare-events", "LICENSE"],
    ["buffer-5.7.1.txt", "buffer", "LICENSE"],
    ["base64-js-1.5.1.txt", "base64-js", "LICENSE.MIT"],
    ["commander-6.2.1.txt", "commander", "LICENSE"],
    ["debug-4.4.3.txt", "debug", "LICENSE"],
    ["Apache-2.0.txt", "events-universal", "LICENSE"],
    ["fast-fifo-1.3.2.txt", "fast-fifo", "LICENSE"],
    ["file-type-21.3.4.txt", "file-type", "license"],
    ["get-stream-9.0.1.txt", "get-stream", "license"],
    ["graceful-fs-4.2.11.txt", "graceful-fs", "LICENSE"],
    ["ieee754-1.2.1.txt", "ieee754", "LICENSE"],
    ["inspect-with-kind-1.0.5.txt", "inspect-with-kind", "LICENSE"],
    ["is-plain-obj-1.1.0.txt", "is-plain-obj", "license"],
    ["is-stream-4.0.1.txt", "is-stream", "license"],
    ["kind-of-6.0.3.txt", "kind-of", "LICENSE"],
    ["ms-2.1.3.txt", "ms", "license.md"],
    ["pend-1.2.0.txt", "pend", "LICENSE"],
    ["seek-bzip-2.0.0.txt", "seek-bzip", "LICENSE"],
    ["streamx-2.28.1.txt", "streamx", "LICENSE"],
    ["strip-dirs-3.0.0.txt", "strip-dirs", "LICENSE"],
    ["strtok3-10.3.5.txt", "strtok3", "LICENSE.txt"],
    ["tar-stream-3.1.7.txt", "tar-stream", "LICENSE"],
    ["Apache-2.0.txt", "text-decoder", "LICENSE"],
    ["through-2.3.8-MIT.txt", "through", "LICENSE.MIT"],
    ["through-2.3.8-Apache-2.0.txt", "through", "LICENSE.APACHE2"],
    ["token-types-6.1.2.txt", "token-types", "LICENSE.txt"],
    ["uint8array-extras-1.5.0.txt", "uint8array-extras", "license"],
    ["unbzip2-stream-1.4.3.txt", "unbzip2-stream", "LICENSE"],
    ["yauzl-3.4.0.txt", "yauzl", "LICENSE"],
];
const normalizedText = (value) => value.replaceAll("\r\n", "\n").trim();

const writeNoticeFixture = (root, overrides = {}) => {
    const dependencies = {
        ...CURRENT_PACKAGE.dependencies,
        ...overrides.dependencies,
    };
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({dependencies}));

    let lockfile = CURRENT_LOCK;
    for (const [name, version] of Object.entries(overrides.packages ?? {})) {
        const current = SCOPED_PACKAGES[name];
        lockfile = lockfile.replace(`"${name}@${current}"`, `"${name}@${version}"`);
    }
    fs.writeFileSync(path.join(root, "bun.lock"), lockfile);

    const licenseDirectory = path.join(root, "scripts", "licenses");
    fs.cpSync(path.join(PROJECT_ROOT, "scripts", "licenses"), licenseDirectory, {recursive: true});
    fs.writeFileSync(path.join(licenseDirectory, `harfbuzzjs-${VERSION}.txt`), PACKAGE_LICENSE);
    fs.writeFileSync(path.join(licenseDirectory, "Apache-2.0.txt"), APACHE_LICENSE);
    for (const [name, version] of Object.entries(SCOPED_PACKAGES)) {
        const basename = name.slice(name.indexOf("/") + 1);
        fs.writeFileSync(path.join(licenseDirectory, `${basename}-${version}.txt`), EXTRACTOR_LICENSE);
    }
};

describe("standalone third-party notices", () => {
    it("keeps every maintained extractor license identical to the installed upstream file", () => {
        for (const [asset, packageName, upstreamFile] of UPSTREAM_LICENSES) {
            const maintained = fs.readFileSync(path.join(PROJECT_ROOT, "scripts", "licenses", asset), "utf8");
            const upstream = fs.readFileSync(path.join(PROJECT_ROOT, "node_modules", packageName, upstreamFile), "utf8");
            assert.equal(normalizedText(maintained), normalizedText(upstream), `${asset} drifted from ${packageName}`);
        }

        const tokenizerReadme = fs.readFileSync(
            path.join(PROJECT_ROOT, "node_modules", "@tokenizer", "token", "README.md"), "utf8");
        const tokenizerLicense = tokenizerReadme.slice(tokenizerReadme.indexOf("(The MIT License)"));
        const maintainedTokenizerLicense = fs.readFileSync(
            path.join(PROJECT_ROOT, "scripts", "licenses", "tokenizer-token-0.3.0.txt"), "utf8");
        assert.equal(normalizedText(maintainedTokenizerLicense), normalizedText(tokenizerLicense));

        const manifest = JSON.parse(fs.readFileSync(
            path.join(PROJECT_ROOT, "scripts", "licenses", "extractor-closure.json"), "utf8"));
        const maintainedAssets = [...new Set(Object.values(manifest.packages)
            .flatMap(({licenseFiles}) => licenseFiles))].sort();
        const verifiedAssets = [...new Set([
            ...UPSTREAM_LICENSES.map(([asset]) => asset), "tokenizer-token-0.3.0.txt"
        ])].sort();
        assert.deepEqual(maintainedAssets, verifiedAssets,
            "every maintained extractor license asset must be checked against its installed source");

        const packageNameForKey = (key) => key.startsWith("@") ? key : key.split("/").at(-1);
        const reviewedPackages = Object.keys(manifest.packages).map(packageNameForKey).sort();
        const verifiedPackages = [...new Set([
            ...UPSTREAM_LICENSES.map(([, packageName]) => packageName), "@tokenizer/token"
        ])].sort();
        assert.deepEqual(reviewedPackages, verifiedPackages,
            "every package in the reviewed closure must have an upstream license check");
    });

    it("records the embedded HarfBuzz source, version and both applicable licenses", () => {
        const notice = formatThirdPartyNotices({
            version: VERSION,
            packageLicense: PACKAGE_LICENSE,
            apacheLicense: APACHE_LICENSE,
        });

        assert.match(notice, /harfbuzzjs 0\.10\.0/);
        assert.match(notice, /https:\/\/github\.com\/harfbuzz\/harfbuzzjs/);
        assert.match(notice, /MIT and Apache-2\.0 components/);
        assert.match(notice, new RegExp(PACKAGE_LICENSE));
        assert.match(notice, new RegExp(APACHE_LICENSE));
    });

    it("generates the public asset from dependency metadata and maintained license sources", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-notices-"));
        const output = path.join(root, "client", "public", "third-party-notices.txt");

        try {
            writeNoticeFixture(root);

            generateThirdPartyNotices({root, output});

            const notice = fs.readFileSync(output, "utf8");
            assert.match(notice, /harfbuzzjs 0\.10\.0/);
            assert.match(notice, new RegExp(PACKAGE_LICENSE));
            assert.match(notice, new RegExp(APACHE_LICENSE));
            for (const [name, version] of Object.entries(SCOPED_PACKAGES))
                assert.match(notice, new RegExp(`${name} ${version.replaceAll(".", "\\.")}`));
            assert.ok(notice.includes(EXTRACTOR_LICENSE));
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    it("fails closed when dependency metadata and maintained notices diverge", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-notices-version-"));
        try {
            writeNoticeFixture(root, {dependencies: {harfbuzzjs: "0.10.1"}});
            assert.throws(() => generateThirdPartyNotices({root}), /No maintained HarfBuzz notices/);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    it("fails closed when an extractor lock resolution has no maintained notice", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-notices-lock-version-"));
        try {
            writeNoticeFixture(root, {packages: {"@xhmikosr/decompress-tar": "9.0.3"}});
            assert.throws(() => generateThirdPartyNotices({root}), /decompress-tar.*9\.0\.3/);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    it("fails closed when a direct extractor declaration diverges", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-notices-direct-version-"));
        try {
            writeNoticeFixture(root, {dependencies: {"@xhmikosr/decompress": "11.1.5"}});
            assert.throws(() => generateThirdPartyNotices({root}), /direct dependency.*decompress.*11\.1\.5/);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    it("fails closed when an expected extractor has no top-level lock entry", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-notices-lock-missing-"));
        try {
            writeNoticeFixture(root);
            const lockPath = path.join(root, "bun.lock");
            const lockfile = fs.readFileSync(lockPath, "utf8")
                .split("\n")
                .filter((line) => !line.startsWith('    "@xhmikosr/decompress-tar":'))
                .join("\n");
            fs.writeFileSync(lockPath, lockfile);
            assert.throws(() => generateThirdPartyNotices({root}), /missing lock package.*decompress-tar/i);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    it("fails closed when the lock adds an unreviewed extractor dependency", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-notices-closure-drift-"));
        try {
            writeNoticeFixture(root);
            const lockPath = path.join(root, "bun.lock");
            const lock = parseBunLock(fs.readFileSync(lockPath, "utf8"));
            lock.packages["@xhmikosr/decompress"][LOCK_METADATA_INDEX]
                .dependencies["new-runtime-package"] = "1.0.0";
            lock.packages["new-runtime-package"] = ["new-runtime-package@1.0.0", "", {}];
            fs.writeFileSync(lockPath, JSON.stringify(lock));

            assert.throws(() => generateThirdPartyNotices({root}),
                /closure differs.*new-runtime-package/i);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    it("fails closed when a reviewed package leaves the extractor closure", () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-notices-closure-missing-"));
        try {
            writeNoticeFixture(root);
            const lockPath = path.join(root, "bun.lock");
            const lock = parseBunLock(fs.readFileSync(lockPath, "utf8"));
            delete lock.packages["@xhmikosr/decompress"][LOCK_METADATA_INDEX].dependencies["graceful-fs"];
            fs.writeFileSync(lockPath, JSON.stringify(lock));

            assert.throws(() => generateThirdPartyNotices({root}),
                /closure differs.*missing: graceful-fs/i);
        } finally {
            fs.rmSync(root, {recursive: true, force: true});
        }
    });

    it("generates the current dependency's complete notice from maintained sources", () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-notices-current-"));
        const output = path.join(directory, "third-party-notices.txt");
        try {
            generateThirdPartyNotices({root: PROJECT_ROOT, output});
            const notice = fs.readFileSync(output, "utf8");
            assert.match(notice, /Copyright \(c\) 2019 Ebrahim Byagowi/);
            assert.match(notice, /TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION/);
            assert.match(notice, /@xhmikosr\/decompress 11\.1\.4/);
            assert.match(notice, /@xhmikosr\/decompress-tar 9\.0\.2/);
            assert.match(notice, /@xhmikosr\/decompress-tarbz2 9\.0\.2/);
            assert.match(notice, /Copyright \(c\) Kevin Mårtensson/);
            assert.match(notice, /graceful-fs 4\.2\.11/);
            assert.match(notice, /Isaac Z\. Schlueter, Ben Noordhuis/);
            assert.match(notice, /strip-dirs 3\.0\.0/);
            assert.match(notice, /Shinnosuke Watanabe/);
            assert.match(notice, /file-type 21\.3\.4/);
            assert.match(notice, /Sindre Sorhus/);
            assert.match(notice, /yauzl 3\.4\.0/);
            assert.match(notice, /Josh Wolfe/);
            assert.match(notice, /tar-stream 3\.1\.7/);
            assert.match(notice, /Mathias Buus/);
            assert.match(notice, /base64-js 1\.5\.1/,
                "the nested buffer/base64-js lock resolution was omitted from the closure");
        } finally {
            fs.rmSync(directory, {recursive: true, force: true});
        }
    });
});
