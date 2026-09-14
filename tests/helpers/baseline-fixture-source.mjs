import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {POST_RELEASE_BASELINE_INPUT_CONSTANTS} from
    "../../scripts/release/post-release-msi-baseline-input-preparation.mjs";

const sha256 = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const write = (root, name, bytes) => { const target = path.join(root, ...name.split("/"));
    fs.mkdirSync(path.dirname(target), {recursive: true}); fs.writeFileSync(target, bytes, {flag: "wx"}); };
const inventory = root => Object.fromEntries(fs.readdirSync(root, {recursive: true, withFileTypes: true})
    .filter(entry => entry.isFile()).map(entry => { const target = path.join(entry.parentPath, entry.name);
        return [path.relative(root, target).replaceAll(path.sep, "/"), sha256(fs.readFileSync(target))]; }));

export function createCandidateBaselineFixtureSource(root, includeWal = true) {
    const populatedRoot = path.join(root, "populated"); const resetRoot = path.join(root, "reset");
    fs.mkdirSync(populatedRoot, {recursive: true}); fs.mkdirSync(resetRoot, {recursive: true});
    for (const name of POST_RELEASE_BASELINE_INPUT_CONSTANTS.FIXTURE_COMMON) {
        write(populatedRoot, name, Buffer.from(`populated:${name}`));
        write(resetRoot, name, Buffer.from(`reset:${name}`));
    }
    write(populatedRoot, "data/storage.db", Buffer.from("sqlite"));
    if (includeWal) write(populatedRoot, POST_RELEASE_BASELINE_INPUT_CONSTANTS.OPTIONAL_WAL, Buffer.alloc(0));
    write(populatedRoot, ".myspeed-qualification.json", Buffer.from("populated-marker"));
    write(resetRoot, ".myspeed-qualification.json", Buffer.from("reset-marker"));
    const populated = inventory(populatedRoot); const reset = inventory(resetRoot);
    const manifest = {schemaVersion: 1, source: {commit: POST_RELEASE_BASELINE_INPUT_CONSTANTS.CANDIDATE_SOURCE_SHA,
        bunLockSha256: "1".repeat(64), packageSha256: "2".repeat(64)},
    populated: {root: "C:\\candidate\\populated", nonce: "3".repeat(48),
        markerSha256: populated[".myspeed-qualification.json"], databaseSha256: populated["data/storage.db"],
        filesSha256: populated}, reset: {root: "C:\\candidate\\reset", nonce: "4".repeat(48),
        markerSha256: reset[".myspeed-qualification.json"], filesSha256: reset},
    expected: {ping: "123.456", resultId: "qualification-seed-row", passwordValueSha256: "5".repeat(64)}};
    const bytes = Buffer.from(`${JSON.stringify(manifest)}\n`); const manifestPath = path.join(root, "transport.json");
    fs.writeFileSync(manifestPath, bytes, {flag: "wx"});
    return {manifest: {path: manifestPath, bytes: String(bytes.length), sha256: sha256(bytes)},
        populatedRoot, resetRoot};
}
