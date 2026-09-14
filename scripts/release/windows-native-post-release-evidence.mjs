import {createHash} from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {pathToFileURL} from "node:url";

import {assertWindowsNativeStandaloneProofRequest} from
    "../qualification/windows-native-standalone-proof.mjs";

const MAXIMUM_PROOF_REQUEST_BYTES = 2_097_152;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OUTPUT_NAMES = Object.freeze([
    Object.freeze({name: "ready.json", allowEmpty: false}),
    Object.freeze({name: "result.json", allowEmpty: false}),
    Object.freeze({name: "stdout.log", allowEmpty: true}),
    Object.freeze({name: "stderr.log", allowEmpty: true})
]);

const readBoundedStableFile = sourcePath => {
    const beforePath = fs.lstatSync(sourcePath, {bigint: true});
    if (!beforePath.isFile() || beforePath.isSymbolicLink() || beforePath.nlink !== 1n
        || beforePath.size <= 0n || beforePath.size > BigInt(MAXIMUM_PROOF_REQUEST_BYTES))
        throw new Error("Standalone proof request file differs");
    const handle = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
        const before = fs.fstatSync(handle, {bigint: true});
        if (!before.isFile() || before.dev !== beforePath.dev || before.ino !== beforePath.ino
            || before.size !== beforePath.size || before.nlink !== 1n)
            throw new Error("Standalone proof request identity differs");
        const bytes = Buffer.alloc(Number(before.size));
        let offset = 0;
        while (offset < bytes.length) {
            const count = fs.readSync(handle, bytes, offset, bytes.length - offset, offset);
            if (count <= 0) throw new Error("Standalone proof request read was incomplete");
            offset += count;
        }
        const after = fs.fstatSync(handle, {bigint: true});
        if (after.dev !== before.dev || after.ino !== before.ino || after.size !== before.size
            || after.mtimeNs !== before.mtimeNs || after.nlink !== 1n)
            throw new Error("Standalone proof request changed during read");
        return bytes;
    } finally {
        fs.closeSync(handle);
    }
};

export const buildWindowsNativePostReleaseEvidenceInventory = input => {
    const proof = assertWindowsNativeStandaloneProofRequest(input);
    const records = [{name: "proof.result.json", path: proof.resultPath, allowEmpty: false}];
    for (const candidate of proof.candidates) {
        for (const controllerRequest of candidate.controllerRequests) {
            for (const output of OUTPUT_NAMES) records.push({
                name: `scenarios/${candidate.alias}/${controllerRequest.scenario}/${output.name}`,
                path: `${controllerRequest.taskRoot}\\${output.name}`,
                allowEmpty: output.allowEmpty
            });
        }
    }
    return records;
};

export const runWindowsNativePostReleaseEvidenceCli = args => {
    if (!Array.isArray(args) || args.length !== 3 || args[0] !== "--inventory"
        || !path.isAbsolute(args[1]) || !SHA256_PATTERN.test(args[2]))
        throw new Error("Usage: windows-native-post-release-evidence.mjs --inventory <proof-request> <sha256>");
    const bytes = readBoundedStableFile(args[1]);
    if (createHash("sha256").update(bytes).digest("hex") !== args[2])
        throw new Error("Standalone proof request SHA differs");
    let value;
    try { value = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Standalone proof request JSON differs"); }
    return buildWindowsNativePostReleaseEvidenceInventory(value);
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
    try { process.stdout.write(`${JSON.stringify(runWindowsNativePostReleaseEvidenceCli(process.argv.slice(2)))}\n`); }
    catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
