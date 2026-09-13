import {afterEach, beforeEach, describe, it} from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import {spawn} from "node:child_process";
import {pathToFileURL} from "node:url";
import {
    EXECUTABLE_MODE,
    extractBinary,
    extractFiles,
    waitForInstall
} from "../../server/util/providers/downloadHelper.js";

const TAR_BLOCK_SIZE = 512;
const TAR_END_BLOCKS = 2;
const TAR_CHECKSUM_OFFSET = 148;
const TAR_CHECKSUM_SIZE = 8;
const TAR_NAME_SIZE = 100;
const TAR_MODE_OFFSET = 100;
const TAR_SIZE_OFFSET = 124;
const TAR_MTIME_OFFSET = 136;
const TAR_TYPE_OFFSET = 156;
const TAR_LINK_OFFSET = 157;
const TAR_LINK_SIZE = 100;
const ZIP_VERSION = 20;
const ZIP_UTF8_FLAG = 0x800;
const ZIP_FILE_MODE = 0o100644;
const CHILD_ARCHIVE_TIMEOUT_MS = 2_000;
const CHILD_HEAP_MB = 64;

const octal = (value, width) => `${value.toString(8).padStart(width - 1, "0")}\0`;

const writeString = (buffer, offset, width, value) =>
    buffer.write(value, offset, Math.min(width, Buffer.byteLength(value)), "utf8");

const tar = (entries) => {
    const blocks = [];

    for (const {name, data = "", type = "file", linkname = "", mode = 0o644} of entries) {
        const contents = Buffer.from(data);
        const header = Buffer.alloc(TAR_BLOCK_SIZE);
        writeString(header, 0, TAR_NAME_SIZE, name);
        writeString(header, TAR_MODE_OFFSET, 8, octal(mode, 8));
        writeString(header, 108, 8, octal(0, 8));
        writeString(header, 116, 8, octal(0, 8));
        writeString(header, TAR_SIZE_OFFSET, 12, octal(type === "file" ? contents.length : 0, 12));
        writeString(header, TAR_MTIME_OFFSET, 12, octal(0, 12));
        header.fill(0x20, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_OFFSET + TAR_CHECKSUM_SIZE);
        header[TAR_TYPE_OFFSET] = ({file: 0x30, link: 0x31, symlink: 0x32, directory: 0x35})[type];
        writeString(header, TAR_LINK_OFFSET, TAR_LINK_SIZE, linkname);
        writeString(header, 257, 6, "ustar\0");
        writeString(header, 263, 2, "00");
        const checksum = header.reduce((sum, byte) => sum + byte, 0);
        writeString(header, TAR_CHECKSUM_OFFSET, TAR_CHECKSUM_SIZE, `${checksum.toString(8).padStart(6, "0")}\0 `);
        blocks.push(header);
        if (type === "file") {
            blocks.push(contents);
            const padding = (TAR_BLOCK_SIZE - (contents.length % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
            if (padding) blocks.push(Buffer.alloc(padding));
        }
    }

    blocks.push(Buffer.alloc(TAR_BLOCK_SIZE * TAR_END_BLOCKS));
    return zlib.gzipSync(Buffer.concat(blocks));
};

const CRC_TABLE = Array.from({length: 256}, (_, byte) => {
    let value = byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xEDB88320 : 0);
    return value >>> 0;
});

const crc32 = (buffer) => {
    let crc = 0xFFFFFFFF;
    for (const byte of buffer) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
};

const zip = (entries) => {
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const {name, data = "", mode = ZIP_FILE_MODE} of entries) {
        const nameBytes = Buffer.from(name);
        const contents = Buffer.from(data);
        const checksum = crc32(contents);
        const local = Buffer.alloc(30);
        local.writeUInt32LE(0x04034B50, 0);
        local.writeUInt16LE(ZIP_VERSION, 4);
        local.writeUInt16LE(ZIP_UTF8_FLAG, 6);
        local.writeUInt32LE(checksum, 14);
        local.writeUInt32LE(contents.length, 18);
        local.writeUInt32LE(contents.length, 22);
        local.writeUInt16LE(nameBytes.length, 26);
        localParts.push(local, nameBytes, contents);

        const central = Buffer.alloc(46);
        central.writeUInt32LE(0x02014B50, 0);
        central.writeUInt16LE((3 << 8) | ZIP_VERSION, 4);
        central.writeUInt16LE(ZIP_VERSION, 6);
        central.writeUInt16LE(ZIP_UTF8_FLAG, 8);
        central.writeUInt32LE(checksum, 16);
        central.writeUInt32LE(contents.length, 20);
        central.writeUInt32LE(contents.length, 24);
        central.writeUInt16LE(nameBytes.length, 28);
        central.writeUInt32LE((mode << 16) >>> 0, 38);
        central.writeUInt32LE(offset, 42);
        centralParts.push(central, nameBytes);
        offset += local.length + nameBytes.length + contents.length;
    }

    const centralDirectory = Buffer.concat(centralParts);
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054B50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDirectory.length, 12);
    end.writeUInt32LE(offset, 16);
    return Buffer.concat([...localParts, centralDirectory, end]);
};

describe("provider archive policy", () => {
    let directory;
    let output;
    let archiveNumber;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), "myspeed-archive-policy-"));
        output = path.join(directory, "bin");
        archiveNumber = 0;
    });

    afterEach(() => fs.rmSync(directory, {recursive: true, force: true}));

    const fixture = (contents, extension = ".tgz") => {
        const archive = path.join(directory, `archive-${archiveNumber++}${extension}`);
        fs.writeFileSync(archive, contents);
        return archive;
    };

    it("installs one nonempty nested tar.gz executable under its fixed name", async () => {
        const archive = fixture(tar([{name: "release/nested/tool", data: "binary"}]));
        await extractBinary(archive, output, /(^|\/)tool$/, "provider");
        assert.equal(fs.readFileSync(path.join(output, "provider"), "utf8"), "binary");
        if (process.platform !== "win32")
            assert.equal(fs.statSync(path.join(output, "provider")).mode & 0o777, EXECUTABLE_MODE);
    });

    it("validates and installs the complete Windows ZIP pair", async () => {
        const archive = fixture(zip([
            {name: "release/iperf3.exe", data: "exe"},
            {name: "release/cygwin1.dll", data: "dll"}
        ]), ".zip");
        await extractFiles(archive, output, /(^|\/)(iperf3\.exe|cygwin1\.dll)$/, undefined,
            {requiredFiles: ["iperf3.exe", "cygwin1.dll"]});
        assert.equal(fs.readFileSync(path.join(output, "iperf3.exe"), "utf8"), "exe");
        assert.equal(fs.readFileSync(path.join(output, "cygwin1.dll"), "utf8"), "dll");
    });

    for (const [name, bytes] of [
        ["unknown magic", Buffer.from("not an archive")],
        ["corrupt gzip", Buffer.from([0x1F, 0x8B, 0x08, 0, 1, 2, 3])]
    ]) {
        it(`refuses ${name} without publishing a file`, async () => {
            await assert.rejects(extractBinary(fixture(bytes), output, /tool$/, "provider"));
            assert.equal(fs.existsSync(path.join(output, "provider")), false);
        });
    }

    it("bounds corrupt archive decoding in a resource-limited child process", async () => {
        const archive = fixture(Buffer.from([0x1F, 0x8B, 0x08, 0, 1, 2, 3]));
        const helperUrl = pathToFileURL(path.resolve("server/util/providers/downloadHelper.js")).href;
        const script = `import {extractBinary} from ${JSON.stringify(helperUrl)};`
            + `try { await extractBinary(${JSON.stringify(archive)}, ${JSON.stringify(output)}, /tool$/, "provider");`
            + ` process.exitCode = 2; } catch { process.exitCode = 0; }`;
        const child = spawn(process.execPath, [`--max-old-space-size=${CHILD_HEAP_MB}`,
            "--input-type=module", "--eval", script], {stdio: "ignore"});
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill();
        }, CHILD_ARCHIVE_TIMEOUT_MS);
        const exitCode = await new Promise((resolve, reject) => {
            child.once("error", reject);
            child.once("exit", resolve);
        });
        clearTimeout(timer);
        assert.equal(timedOut, false, "corrupt archive decoding exceeded its child-process budget");
        assert.equal(exitCode, 0);
    });

    it("refuses no match and empty selected files before publication", async () => {
        await assert.rejects(extractBinary(fixture(tar([{name: "other", data: "x"}])),
            output, /tool$/, "provider"), /nothing matching/i);
        await assert.rejects(extractBinary(fixture(tar([{name: "tool", data: ""}])),
            output, /tool$/, "provider"), /empty/i);
        assert.equal(fs.existsSync(path.join(output, "provider")), false);
    });

    it("refuses a missing required DLL before publishing the executable", async () => {
        const archive = fixture(zip([{name: "iperf3.exe", data: "exe"}]), ".zip");
        await assert.rejects(extractFiles(archive, output, /iperf3\.exe|cygwin1\.dll/, undefined,
            {requiredFiles: ["iperf3.exe", "cygwin1.dll"]}), /cygwin1\.dll/i);
        assert.equal(fs.existsSync(path.join(output, "iperf3.exe")), false);
    });

    it("refuses an empty required DLL before publishing either member", async () => {
        const archive = fixture(zip([
            {name: "iperf3.exe", data: "exe"}, {name: "cygwin1.dll", data: ""}
        ]), ".zip");
        await assert.rejects(extractFiles(archive, output, /iperf3\.exe|cygwin1\.dll/, undefined,
            {requiredFiles: ["iperf3.exe", "cygwin1.dll"]}), /cygwin1\.dll.*empty|empty.*cygwin1\.dll/i);
        assert.equal(fs.existsSync(path.join(output, "iperf3.exe")), false);
        assert.equal(fs.existsSync(path.join(output, "cygwin1.dll")), false);
    });

    for (const unsafeOutputName of ["../provider", "C:provider", "provider:stream", "NUL"]) {
        it(`refuses unsafe fixed output name ${JSON.stringify(unsafeOutputName)}`, async () => {
            const archive = fixture(tar([{name: "tool", data: "binary"}]));
            await assert.rejects(extractBinary(archive, output, /tool$/, unsafeOutputName),
                /unsafe|path|basename|Windows/i);
            assert.deepEqual(fs.existsSync(output) ? fs.readdirSync(output) : [], []);
        });
    }

    for (const entry of [
        {name: "tool", type: "symlink", linkname: "../sentinel"},
        {name: "tool", type: "link", linkname: "sentinel"},
        {name: "tool", type: "directory"},
        {name: "tool", type: "symlink", linkname: "tool"}
    ]) {
        it(`refuses a matching ${entry.type} member`, async () => {
            await assert.rejects(extractBinary(fixture(tar([entry])), output, /tool$/, "provider"),
                /regular file/i);
            assert.equal(fs.existsSync(path.join(output, "provider")), false);
        });
    }

    it("refuses link chains, hardlink-to-symlink and link-then-file duplicates", async () => {
        const cases = [
            [{name: "a", type: "symlink", linkname: "b"}, {name: "tool", type: "symlink", linkname: "a"}],
            [{name: "a", type: "symlink", linkname: "outside"}, {name: "tool", type: "link", linkname: "a"}],
            [{name: "tool", type: "symlink", linkname: "a"}, {name: "tool", data: "binary"}]
        ];
        for (const entries of cases) {
            await assert.rejects(extractBinary(fixture(tar(entries)), output, /tool$/, "provider"));
            assert.equal(fs.existsSync(path.join(output, "provider")), false);
        }
    });

    it("refuses ambiguous duplicate output names including case collisions", async () => {
        await assert.rejects(extractBinary(fixture(tar([
            {name: "one/tool", data: "one"}, {name: "two/tool", data: "two"}
        ])), output, /tool$/, "provider"), /duplicate|ambiguous/i);
        await assert.rejects(extractFiles(fixture(zip([
            {name: "IPERF3.EXE", data: "one"}, {name: "iperf3.exe", data: "two"},
            {name: "cygwin1.dll", data: "dll"}
        ]), ".zip"), output, /iperf3\.exe|cygwin1\.dll/i, undefined,
        {requiredFiles: ["iperf3.exe", "cygwin1.dll"]}), /duplicate|ambiguous/i);
    });

    for (const unsafe of [
        "../tool", "/tool", "dir\\tool", "C:/tool", "//server/share/tool",
        "dir:stream/tool", "CON/tool"
    ]) {
        it(`refuses unsafe selected path ${JSON.stringify(unsafe)}`, async () => {
            await assert.rejects(extractBinary(fixture(tar([{name: unsafe, data: "binary"}])),
                output, /tool$/, "provider"), /unsafe|path|absolute|traversal/i);
            assert.equal(fs.existsSync(path.join(output, "provider")), false);
        });
    }

    it("refuses archive privilege mode bits and applies its own safe mode", async () => {
        await assert.rejects(extractBinary(fixture(tar([{name: "tool", data: "binary", mode: 0o4755}])),
            output, /tool$/, "provider"), /mode|privilege/i);
        assert.equal(fs.existsSync(path.join(output, "provider")), false);
    });

    it("refuses a pre-existing hardlinked destination without changing its sibling", async () => {
        fs.mkdirSync(output);
        const sentinel = path.join(directory, "sentinel");
        fs.writeFileSync(sentinel, "keep");
        fs.linkSync(sentinel, path.join(output, "provider"));
        await assert.rejects(extractBinary(fixture(tar([{name: "tool", data: "replace"}])),
            output, /tool$/, "provider"), /hardlink|link count/i);
        assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
    });

    it("refuses a pre-existing destination symlink without changing its target", async (context) => {
        fs.mkdirSync(output);
        const sentinel = path.join(directory, "sentinel");
        fs.writeFileSync(sentinel, "keep");
        try {
            fs.symlinkSync(sentinel, path.join(output, "provider"), "file");
        } catch (error) {
            if (error.code === "EPERM") return context.skip("file symlinks require host permission");
            throw error;
        }
        await assert.rejects(extractBinary(fixture(tar([{name: "tool", data: "replace"}])),
            output, /tool$/, "provider"), /symlink/i);
        assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
    });

    it("refuses an output-directory symlink without writing through it", async (context) => {
        const escaped = path.join(directory, "escaped");
        fs.mkdirSync(escaped);
        try {
            fs.symlinkSync(escaped, output, "junction");
        } catch (error) {
            if (error.code === "EPERM") return context.skip("directory links require host permission");
            throw error;
        }
        await assert.rejects(extractBinary(fixture(tar([{name: "tool", data: "replace"}])),
            output, /tool$/, "provider"), /output.directory|linked parent/i);
        assert.deepEqual(fs.readdirSync(escaped), []);
    });

    it("refuses a linked parent below the canonical temporary root", async () => {
        const linkedParent = path.join(directory, "linked-parent");
        fs.mkdirSync(linkedParent);
        const sentinel = path.join(directory, "sentinel");
        fs.writeFileSync(sentinel, "keep");
        const linkedOutput = path.join(linkedParent, "bin");
        await assert.rejects(extractBinary(fixture(tar([{name: "tool", data: "replace"}])),
            linkedOutput, /tool$/, "provider", {operations: {
                lstat: async (target) => path.basename(target) === path.basename(linkedParent)
                    ? {
                        isDirectory: () => true,
                        isFile: () => false,
                        isSymbolicLink: () => true,
                        nlink: 1,
                        size: 0,
                        mode: 0o755
                    }
                    : fs.promises.lstat(target)
            }}), /parent|symlink|linked|escape/i);
        assert.equal(fs.readFileSync(sentinel, "utf8"), "keep");
        assert.deepEqual(fs.readdirSync(linkedParent), []);
    });

    it("rolls a valid pair back when publishing the second member fails", async () => {
        fs.mkdirSync(output);
        fs.writeFileSync(path.join(output, "iperf3.exe"), "old exe");
        fs.writeFileSync(path.join(output, "cygwin1.dll"), "old dll");
        const archive = fixture(zip([
            {name: "iperf3.exe", data: "new exe"}, {name: "cygwin1.dll", data: "new dll"}
        ]), ".zip");
        const rename = async (from, to) => {
            if (path.basename(from) === "cygwin1.dll.new" && path.basename(to) === "cygwin1.dll") {
                const error = new Error("injected second publication failure");
                error.code = "EACCES";
                throw error;
            }
            return fs.promises.rename(from, to);
        };

        await assert.rejects(extractFiles(archive, output, /iperf3\.exe|cygwin1\.dll/, undefined,
            {requiredFiles: ["iperf3.exe", "cygwin1.dll"], operations: {rename}}), /injected/);
        assert.equal(fs.readFileSync(path.join(output, "iperf3.exe"), "utf8"), "old exe");
        assert.equal(fs.readFileSync(path.join(output, "cygwin1.dll"), "utf8"), "old dll");
    });

    it("leaves prior files untouched when staging the second member fails", async () => {
        fs.mkdirSync(output);
        fs.writeFileSync(path.join(output, "iperf3.exe"), "old exe");
        fs.writeFileSync(path.join(output, "cygwin1.dll"), "old dll");
        const archive = fixture(zip([
            {name: "iperf3.exe", data: "new exe"}, {name: "cygwin1.dll", data: "new dll"}
        ]), ".zip");
        let writes = 0;
        const writeFile = async (...arguments_) => {
            if (++writes === 2) throw new Error("injected staging write failure");
            return fs.promises.writeFile(...arguments_);
        };
        await assert.rejects(extractFiles(archive, output, /iperf3\.exe|cygwin1\.dll/, undefined,
            {requiredFiles: ["iperf3.exe", "cygwin1.dll"], operations: {writeFile}}), /injected/);
        assert.equal(fs.readFileSync(path.join(output, "iperf3.exe"), "utf8"), "old exe");
        assert.equal(fs.readFileSync(path.join(output, "cygwin1.dll"), "utf8"), "old dll");
        assert.deepEqual(fs.readdirSync(output).sort(), ["cygwin1.dll", "iperf3.exe"]);
    });

    it("reports rollback failure and retains the backup as recovery evidence", async () => {
        fs.mkdirSync(output);
        fs.writeFileSync(path.join(output, "iperf3.exe"), "old exe");
        fs.writeFileSync(path.join(output, "cygwin1.dll"), "old dll");
        const archive = fixture(zip([
            {name: "iperf3.exe", data: "new exe"}, {name: "cygwin1.dll", data: "new dll"}
        ]), ".zip");
        const rename = async (from, to) => {
            if (path.basename(from) === "cygwin1.dll.new")
                throw new Error("injected publication failure");
            if (path.basename(from) === "iperf3.exe.previous")
                throw new Error("injected rollback failure");
            return fs.promises.rename(from, to);
        };

        await assert.rejects(extractFiles(archive, output, /iperf3\.exe|cygwin1\.dll/, undefined,
            {requiredFiles: ["iperf3.exe", "cygwin1.dll"], operations: {rename}}), (error) => {
            assert.ok(error instanceof AggregateError);
            assert.match(error.message, /rollback also failed|evidence retained/i);
            assert.equal(error.errors.length, 2);
            return true;
        });
        const evidenceDirectory = fs.readdirSync(output)
            .find((name) => name.startsWith(".myspeed-install-"));
        assert.ok(evidenceDirectory, "rollback evidence was removed");
        assert.equal(fs.readFileSync(path.join(output, evidenceDirectory, "iperf3.exe.previous"), "utf8"),
            "old exe");
        assert.equal(fs.readFileSync(path.join(output, "cygwin1.dll"), "utf8"), "old dll");
    });

    it("serializes same-directory installs and keeps consumers behind the publication gate", async () => {
        const first = fixture(tar([{name: "tool", data: "first"}]));
        const second = fixture(tar([{name: "tool", data: "second"}]));
        let release;
        const paused = new Promise((resolve) => { release = resolve; });
        let reachedPublication;
        const reached = new Promise((resolve) => { reachedPublication = resolve; });
        const rename = async (from, to) => {
            reachedPublication();
            await paused;
            return fs.promises.rename(from, to);
        };
        const firstInstall = extractBinary(first, output, /tool$/, "provider", {operations: {rename}});
        await reached;
        const secondInstall = extractBinary(second, output, /tool$/, "provider");
        let consumerReleased = false;
        const consumer = waitForInstall(output).then(() => { consumerReleased = true; });
        await new Promise((resolve) => setImmediate(resolve));
        assert.equal(consumerReleased, false);
        release();
        await Promise.all([firstInstall, secondInstall, consumer]);
        assert.equal(fs.readFileSync(path.join(output, "provider"), "utf8"), "second");
    });

    it("keeps a waiter behind an install queued after the wait began", async () => {
        const first = fixture(tar([{name: "tool", data: "first"}]));
        const second = fixture(tar([{name: "tool", data: "second"}]));
        let releaseFirst;
        let releaseSecond;
        let reachedFirst;
        let reachedSecond;
        const firstPaused = new Promise((resolve) => { releaseFirst = resolve; });
        const secondPaused = new Promise((resolve) => { releaseSecond = resolve; });
        const firstReached = new Promise((resolve) => { reachedFirst = resolve; });
        const secondReached = new Promise((resolve) => { reachedSecond = resolve; });
        const firstInstall = extractBinary(first, output, /tool$/, "provider", {operations: {
            rename: async (from, to) => {
                reachedFirst();
                await firstPaused;
                return fs.promises.rename(from, to);
            }
        }});
        await firstReached;

        let consumerReleased = false;
        const consumer = waitForInstall(output).then(() => { consumerReleased = true; });
        const secondInstall = extractBinary(second, output, /tool$/, "provider", {operations: {
            rename: async (from, to) => {
                reachedSecond();
                await secondPaused;
                return fs.promises.rename(from, to);
            }
        }});
        releaseFirst();
        await secondReached;
        assert.equal(consumerReleased, false,
            "the waiter released while the later installation was still publishing");

        releaseSecond();
        await Promise.all([firstInstall, secondInstall, consumer]);
        assert.equal(fs.readFileSync(path.join(output, "provider"), "utf8"), "second");
    });
});
