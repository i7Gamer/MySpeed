import {describe, it} from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {createHash} from "node:crypto";
import {parse} from "yaml";
import {readSource} from "../helpers/source.js";

const workflow = parse(readSource(".github/workflows/build-binaries.yml"));
const checksumStep = workflow.jobs.checksums.steps.find((step) => step.name === "Publish SHA256SUMS");
const releaseWorkflow = parse(readSource(".github/workflows/create_release.yml"));
const finalChecksumJob = releaseWorkflow.jobs["checksums-msi"];
const finalChecksumStep = finalChecksumJob.steps.find((step) => step.name === "Add any unhashed asset to SHA256SUMS");

assert.ok(checksumStep?.with?.script, "the checksum publication script is missing");
assert.ok(finalChecksumStep?.with?.script, "the final checksum publication script is missing");

const RELEASE_ID = 123;
const DEFAULT_ASSETS = [
    "MySpeed-windows-x64.exe",
    "MySpeed-windows-x64-baseline.exe",
    "MySpeed-linux-x64",
    "MySpeed-linux-x64-baseline",
    "MySpeed-linux-arm64",
    "MySpeed-macos-x64",
    "MySpeed-macos-arm64",
    "MySpeed.zip",
    "install.sh",
    "docker-install.sh",
    "chooser.sh"
];

const execute = async (matching = []) => {
    const sharedBodies = new Map(matching.map((names, index) =>
        [names, Buffer.from(`shared-${index}`)]));
    const assets = DEFAULT_ASSETS.map((name, index) => ({
        id: index + 1,
        name,
        data: [...sharedBodies].find(([names]) => names.includes(name))?.[1] ?? Buffer.from(`unique-${name}`)
    }));
    const outputs = new Map();
    const events = [];
    const sandbox = {
        Buffer,
        require: (name) => {
            assert.equal(name, "crypto");
            return {createHash};
        },
        process: {env: {RELEASE_ID: String(RELEASE_ID)}},
        context: {repo: {owner: "test", repo: "myspeed"}},
        github: {
            paginate: async () => assets,
            rest: {repos: {
                listReleaseAssets: async () => ({data: assets}),
                getReleaseAsset: async ({asset_id}) => ({data: assets.find(({id}) => id === asset_id).data}),
                uploadReleaseAsset: async (asset) => {
                    events.push(["upload", asset]);
                }
            }}
        },
        core: {
            info: () => {},
            warning: (message) => events.push(["warning", message]),
            setOutput: (name, value) => {
                events.push(["output", name, value]);
                outputs.set(name, value);
            }
        }
    };

    await vm.runInNewContext("(async () => {" + checksumStep.with.script + "})()", sandbox);
    return {events, outputs};
};

const digest = (data) => createHash("sha256").update(data).digest("hex");

const executeFinal = async (previous, added) => {
    const checksumData = Buffer.from(previous.map(({name, data}) => `${digest(data)}  ${name}`).join("\n") + "\n");
    const assets = [
        {id: 1, name: "SHA256SUMS", data: checksumData},
        ...added.map((asset, index) => ({id: index + 2, ...asset}))
    ];
    const outputs = new Map();
    const events = [];
    const sandbox = {
        Buffer,
        require: (name) => {
            assert.equal(name, "crypto");
            return {createHash};
        },
        process: {env: {RELEASE_ID: String(RELEASE_ID)}},
        context: {repo: {owner: "test", repo: "myspeed"}},
        github: {
            paginate: async () => assets,
            rest: {repos: {
                listReleaseAssets: async () => ({data: assets}),
                getReleaseAsset: async ({asset_id}) => ({data: assets.find(({id}) => id === asset_id).data}),
                deleteReleaseAsset: async (asset) => events.push(["delete", asset]),
                uploadReleaseAsset: async (asset) => events.push(["upload", asset])
            }}
        },
        core: {
            info: () => {},
            warning: (message) => events.push(["warning", message]),
            setOutput: (name, value) => {
                events.push(["output", name, value]);
                outputs.set(name, value);
            }
        }
    };

    await vm.runInNewContext("(async () => {" + finalChecksumStep.with.script + "})()", sandbox);
    return {events, outputs};
};

describe("release digest aliases", () => {
    it("allows only the verified Linux and Windows x64 compatibility pairs", async () => {
        const {events, outputs} = await execute([
            ["MySpeed-linux-x64", "MySpeed-linux-x64-baseline"],
            ["MySpeed-windows-x64.exe", "MySpeed-windows-x64-baseline.exe"]
        ]);

        assert.equal(outputs.get("duplicate-digests"), "");
        const uploads = events.filter(([kind]) => kind === "upload");
        assert.equal(uploads.length, 1,
            "the allowed aliases suppress the checksum upload");
        const checksumList = uploads[0][1].data.toString();
        for (const name of DEFAULT_ASSETS)
            assert.match(checksumList, new RegExp(`  ${name.replaceAll(".", "\\.")}$`, "m"),
                `${name} lost its individual published checksum`);
        assert.ok(events.findIndex(([kind]) => kind === "upload")
            < events.findIndex(([kind]) => kind === "output"),
            "the alias decision moved ahead of checksum publication");
    });

    it("also allows the compatibility pairs to compile to distinct bytes", async () => {
        const {outputs} = await execute();

        assert.equal(outputs.get("duplicate-digests"), "");
    });

    it("reports a collision between unrelated platform assets without failing checksum publication", async () => {
        const {events, outputs} = await execute([
            ["MySpeed-linux-x64", "MySpeed-linux-arm64"]
        ]);

        const unexpected = outputs.get("duplicate-digests");
        assert.match(unexpected, /MySpeed-linux-x64/);
        assert.match(unexpected, /MySpeed-linux-arm64/);
        assert.equal(events.filter(([kind]) => kind === "upload").length, 1);
        assert.equal(events.filter(([kind]) => kind === "warning").length, 1);
    });

    it("reports a three-member collision containing an otherwise allowed pair", async () => {
        const {events, outputs} = await execute([
            ["MySpeed-linux-x64", "MySpeed-linux-x64-baseline", "MySpeed-linux-arm64"]
        ]);

        const unexpected = outputs.get("duplicate-digests");
        for (const name of ["MySpeed-linux-x64", "MySpeed-linux-x64-baseline", "MySpeed-linux-arm64"])
            assert.match(unexpected, new RegExp(name));
        assert.equal(events.filter(([kind]) => kind === "upload").length, 1,
            "classification failed the build-binaries job and lost its checksum evidence");
    });
});

describe("final release digest policy", () => {
    const LINUX_DEFAULT = "MySpeed-linux-x64";
    const LINUX_BASELINE = "MySpeed-linux-x64-baseline";
    const MSI_DEFAULT = "MySpeed-installer.msi";
    const MSI_BASELINE = "MySpeed-installer-baseline.msi";
    const aliasBody = Buffer.from("linux-alias");

    it("allows the binary alias pair after distinct MSI assets are appended", async () => {
        const {events, outputs} = await executeFinal([
            {name: LINUX_DEFAULT, data: aliasBody},
            {name: LINUX_BASELINE, data: aliasBody}
        ], [
            {name: MSI_DEFAULT, data: Buffer.from("default-msi")},
            {name: MSI_BASELINE, data: Buffer.from("baseline-msi")}
        ]);

        assert.equal(outputs.get("duplicate-digests"), "");
        const upload = events.findIndex(([kind]) => kind === "upload");
        const output = events.findIndex(([kind]) => kind === "output");
        assert.notEqual(upload, -1, "the combined SHA256SUMS file was not published");
        assert.ok(upload < output, "the final digest verdict is exposed before the checksum evidence is published");
    });

    it("reports an MSI digest collision after publishing the combined checksums", async () => {
        const sameMsi = Buffer.from("same-msi");
        const {events, outputs} = await executeFinal([], [
            {name: MSI_DEFAULT, data: sameMsi},
            {name: MSI_BASELINE, data: sameMsi}
        ]);

        const unexpected = outputs.get("duplicate-digests");
        assert.match(unexpected, new RegExp(MSI_DEFAULT.replaceAll(".", "\\.")));
        assert.match(unexpected, new RegExp(MSI_BASELINE.replaceAll(".", "\\.")));
        assert.notEqual(events.findIndex(([kind]) => kind === "upload"), -1,
            "classification failed checksums-msi instead of reporting to the refusal job");
    });

    it("reports a final three-member collision containing an allowed binary pair", async () => {
        const {events, outputs} = await executeFinal([
            {name: LINUX_DEFAULT, data: aliasBody},
            {name: LINUX_BASELINE, data: aliasBody}
        ], [
            {name: MSI_DEFAULT, data: aliasBody}
        ]);

        const unexpected = outputs.get("duplicate-digests");
        for (const name of [LINUX_DEFAULT, LINUX_BASELINE, MSI_DEFAULT])
            assert.match(unexpected, new RegExp(name.replaceAll(".", "\\.")));
        assert.notEqual(events.findIndex(([kind]) => kind === "upload"), -1,
            "the final checksum evidence was lost for the unexpected collision");
    });
});
